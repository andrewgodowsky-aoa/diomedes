import { z } from 'zod';
import type { HarnessPrincipal, Json, ModelRequest } from '../../shared/harness.js';
import {
  connectorManifestSchema,
  connectionSchema,
  connectionsDataSchema,
  emptyConnections,
  rulesDataSchema,
  observationSchema,
  type ConnectorManifest,
  type ConnectionInstance,
  type ConnectionObservation,
  type InboxEvent,
} from '../../shared/connections.js';
import type { Rule, RuleScope } from '../../shared/connection-rules.js';
import type { Store } from '../store.js';
import type { HarnessHost } from '../harness/host.js';
import { copy, digest, HarnessError, validatePrincipal } from '../harness/policy.js';
import { evaluateRules, enforceRules, proposeRule, selectRules } from '../rules.js';
import type { ConnectionCredentials } from './credentials.js';
import { NativeAgent, type ModelAdapter } from '../harness/native-agent.js';
import { RuleModelAdapter } from '../rules.js';
import { isConnectionFixtureModel } from './fixture-model.js';

export interface FixtureOperation {
  id: string;
  input: z.ZodType<Json>;
  result: z.ZodType<Json>;
  resources(input: Json): string[];
  execute(input: Json, signal: AbortSignal, at: string): Promise<Json>;
  observations(result: Json): ConnectionObservation[];
}
export interface FixtureConnector {
  manifest: ConnectorManifest;
  operations: FixtureOperation[];
  parseEvent?: (
    raw: string,
    at: string,
  ) => { id: string; timestamp: string; type: string; observation: ConnectionObservation };
}
type DataState = ReturnType<Store['state']> & {
  connections: ReturnType<typeof connectionsDataSchema.parse>;
  rules: ReturnType<typeof rulesDataSchema.parse>;
};
const toolInput = z.strictObject({ runId: z.string(), connectionId: z.string(), input: z.json() });
function deny(code: string, message: string): never {
  throw new HarnessError(code, message);
}
const observationKey = (connectionId: string, observation: ConnectionObservation) =>
  digest([connectionId, observation.resourceId, observation.key]);
const timeOf = (observation: ConnectionObservation) =>
  Date.parse(observation.sourceAt ?? observation.receivedAt);

/** Opt-in host composition. Only reviewed fixture functions are registered; no code is loaded. */
export class ConnectionsService {
  private readonly adapters = new Map<string, FixtureConnector>();
  private readonly owner = `connections-${crypto.randomUUID()}`;
  private draining = new Map<string, Promise<void>>();
  constructor(
    private readonly store: Store,
    private readonly host: HarnessHost,
    adapters: FixtureConnector[],
    private readonly credentials: ConnectionCredentials,
    private readonly currentPrincipal: (
      projectId: string,
    ) => Promise<HarnessPrincipal> = async () =>
      deny('no_authority', 'No current connection authority is available.'),
    private readonly clock: () => number = Date.now,
    private readonly timeoutMs = 5000,
  ) {
    for (const adapter of adapters) {
      const manifest = connectorManifestSchema.parse(adapter.manifest);
      credentials.assertSafe(manifest);
      if (
        manifest.provenance.review !== 'host-reviewed' ||
        manifest.allowedOrigins.length ||
        this.adapters.has(manifest.id)
      )
        deny(
          'unreviewed_connector',
          'Only unique reviewed local fixture connectors may be installed.',
        );
      if (
        manifest.operations.length !== adapter.operations.length ||
        new Set(manifest.operations.map((op) => op.id)).size !== manifest.operations.length
      )
        deny('invalid_connector', 'Operation definitions must be unique and complete.');
      for (const rule of manifest.rules) {
        if (
          !['standing', 'correction'].includes(rule.type) ||
          rule.scope.connectorId !== manifest.id ||
          rule.provenance.connectorVersion !== manifest.version ||
          rule.provenance.trust !== 'host-reviewed'
        )
          deny(
            'package_authority',
            'A connector pack may supply reviewed scoped knowledge, not workflow or policy authority.',
          );
      }
      this.adapters.set(manifest.id, {
        ...adapter,
        manifest: copy(manifest),
        operations: [...adapter.operations],
      });
      for (const operation of adapter.operations) {
        const declared = manifest.operations.find((op) => op.id === operation.id);
        if (
          !declared ||
          declared.effect !== 'read' ||
          declared.permission !== 'connections.read' ||
          digest(declared.inputSchema) !== digest(z.toJSONSchema(operation.input)) ||
          digest(declared.resultSchema) !== digest(z.toJSONSchema(operation.result))
        )
          deny(
            'invalid_connector',
            'Fixture read operations must agree with host-reviewed schemas and effects.',
          );
        this.host.tools.register({
          name: this.toolName(manifest.id, operation.id),
          version: manifest.version,
          description: declared.description,
          schema: z.strictObject({
            runId: z.string(),
            connectionId: z.string(),
            input: operation.input,
          }),
          effect: 'read',
          permission: 'connections.read',
          approval: false,
          destination: 'local',
          trustedInputRequired: false,
          cost: 1,
          execute: async (context) => {
            const args = context.input;
            const run = await this.host.runs.get(args.runId);
            const step = run.steps.find(
              (item) =>
                item.state === 'running' &&
                item.intent.name === this.toolName(manifest.id, operation.id) &&
                digest({
                  runId: run.id,
                  stepId: item.intent.stepId,
                  intentHash: item.intentHash,
                }) === context.idempotencyKey,
            );
            if (!step || digest(step.intent.input) !== digest(args))
              deny('unadmitted_call', 'This connector call is not an admitted Runtime step.');
            const bound = await this.bound(run.id, 'connections.read');
            if (args.connectionId !== bound.connection.id)
              deny('scope_denied', 'The connection differs from this run.');
            const input = this.parseInput(operation, args.input);
            this.checkOperation(
              bound.connection,
              operation.id,
              operation.resources(input),
              bound.binding,
            );
            context.signal.throwIfAborted();
            const signal = AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)]);
            const at = this.now();
            let output: Json;
            try {
              output = await this.bounded(operation.execute(input, signal, at), signal);
            } catch (error) {
              if (signal.aborted)
                throw new HarnessError(
                  'connector_interrupted',
                  'The connector was stopped or timed out.',
                );
              // Adapter exceptions are untrusted and can include tokens; never persist their text.
              await this.mutate(run.projectId, (state) => {
                this.find(state, args.connectionId).problem = 'source-unavailable';
              });
              throw new HarnessError(
                'connector_failed',
                'The source operation failed; no external write was attempted.',
              );
            }
            const result = operation.result.safeParse(output);
            if (!result.success)
              deny('malformed_result', 'The connector result failed its reviewed schema.');
            credentials.assertSafe(output);
            signal.throwIfAborted();
            await this.bound(run.id, 'connections.read');
            const observations = operation
              .observations(result.data)
              .map((item) => observationSchema.parse(item));
            if (observations.some((item) => !operation.resources(input).includes(item.resourceId)))
              deny('result_scope_denied', 'The connector returned an unrequested resource.');
            const rules = await this.mutate(run.projectId, async (state) => {
              const fresh = this.find(state, args.connectionId);
              const current = await this.authority(fresh, 'connections.read');
              if (
                fresh.generation !== bound.connection.generation ||
                current.id !== bound.principal.id ||
                current.identityGeneration !== bound.principal.identityGeneration
              )
                deny('connection_revoked', 'Connection authority changed during the read.');
              signal.throwIfAborted();
              const selected = observations
                .flatMap((item) =>
                  evaluateRules(
                    state.rules.active,
                    this.scope(fresh, {
                      resourceId: item.resourceId,
                      capabilityId: operation.id,
                      runId: run.id,
                      userId: current.id,
                      role: bound.binding.role,
                    }),
                    item.facts,
                  ),
                )
                .filter((rule) => rule.action === 'correct');
              let conflict = false;
              for (const observation of observations) {
                const key = observationKey(fresh.id, observation),
                  previous = state.connections.observations[key];
                if (!previous || timeOf(observation) > timeOf(previous))
                  state.connections.observations[key] = observation;
                else if (
                  timeOf(observation) === timeOf(previous) &&
                  digest(observation.facts) !== digest(previous.facts)
                )
                  conflict = true;
              }
              for (const resourceId of operation.resources(input))
                fresh.reconciledResources[resourceId] = at;
              const times = fresh.resources.map(
                (resource) => fresh.reconciledResources[resource.id],
              );
              fresh.lastReconciledAt = times.every(Boolean) ? times.sort()[0] : null;
              if (operation.resources(input).length === fresh.resources.length)
                fresh.problem = null;
              if (conflict) fresh.problem = 'reconciliation-required';
              return selected;
            });
            return {
              result: result.data,
              corrections: rules,
              connectorVersion: manifest.version,
              assurance: 'fixture-only',
            };
          },
        });
      }
    }
    // Uses the existing mandatory-policy-then-hook boundary; hooks only deny or observe.
    this.host.runs.use(async ({ runId, step }) => {
      const run = await this.host.runs.get(runId);
      if (!this.data(run.projectId).connections.bindings[runId]) return;
      const bound = await this.bound(runId, step.permission ?? 'connections.read');
      const write = !['pure', 'read'].includes(step.effect);
      const facts = {
        operation: step.name ?? step.kind,
        write,
        externalWrite: write && step.destination === 'external',
        destination: step.destination,
      };
      const state = this.data(run.projectId);
      for (const resourceId of bound.binding.resources) {
        const capabilityId = bound.binding.operations.find(
          (operation) => this.toolName(bound.connection.connectorId, operation) === step.name,
        );
        enforceRules(
          state.rules.active,
          this.scope(bound.connection, {
            runId,
            resourceId,
            role: bound.binding.role,
            capabilityId,
            userId: bound.principal.id,
          }),
          facts,
        );
      }
      if (step.destination !== 'local')
        deny('egress_denied', 'This fixture run has no outbound-data authority.');
      if (step.kind === 'tool') {
        const args = toolInput.safeParse(step.input);
        if (
          !args.success ||
          args.data.runId !== runId ||
          args.data.connectionId !== bound.connection.id
        )
          deny('scope_denied', 'The tool proposal is not scoped to this run.');
        const adapter = this.adapter(bound.connection);
        const op = adapter.operations.find(
          (operation) => this.toolName(adapter.manifest.id, operation.id) === step.name,
        );
        if (!op || step.effect !== 'read')
          deny('unsupported_operation', 'This run cannot perform that operation.');
        this.checkOperation(
          bound.connection,
          op.id,
          op.resources(this.parseInput(op, args.data.input)),
          bound.binding,
        );
      }
    });
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }
  private data(projectId: string): DataState {
    const state = structuredClone(this.store.state(projectId));
    return {
      ...state,
      connections: connectionsDataSchema.parse(state.connections ?? emptyConnections()),
      rules: rulesDataSchema.parse(
        state.rules ?? { version: 1, active: [], proposals: [], revisions: [] },
      ),
    };
  }
  private mutate<T>(projectId: string, action: (state: DataState) => T | Promise<T>): Promise<T> {
    return this.store.locked(async () => {
      const state = this.data(projectId),
        result = await action(state);
      connectionsDataSchema.parse(state.connections);
      rulesDataSchema.parse(state.rules);
      this.credentials.assertSafe(state.connections);
      this.credentials.assertSafe(state.rules);
      await this.store.persist(state);
      return result;
    });
  }
  private find(state: DataState, id: string) {
    return (
      state.connections.instances.find((connection) => connection.id === id) ??
      deny('unknown_connection', 'Connection not found in this project.')
    );
  }
  private adapter(connection: ConnectionInstance) {
    const adapter = this.adapters.get(connection.connectorId);
    if (
      !adapter ||
      adapter.manifest.version !== connection.version ||
      digest(adapter.manifest) !== connection.manifestDigest
    )
      deny('version_mismatch', 'The installed connector differs from the approved version.');
    return adapter;
  }
  private async authority(connection: ConnectionInstance, capability: string, active = true) {
    const principal = await this.currentPrincipal(connection.projectId);
    validatePrincipal(principal);
    if (
      principal.tenantId !== connection.tenantId ||
      principal.projectId !== connection.projectId ||
      !principal.capabilities.includes(capability)
    )
      deny(
        'authority_denied',
        'Current authority does not cover this tenant, project or capability.',
      );
    if (active && connection.status !== 'connected')
      deny('connection_revoked', 'This connection is not active.');
    this.adapter(connection);
    return principal;
  }
  private scope(connection: ConnectionInstance, more: RuleScope = {}): RuleScope {
    return {
      tenantId: connection.tenantId,
      projectId: connection.projectId,
      connectorId: connection.connectorId,
      connectionId: connection.id,
      ...more,
    };
  }
  private parseInput(operation: FixtureOperation, input: Json): Json {
    this.credentials.assertSafe(input);
    const parsed = operation.input.safeParse(input);
    return parsed.success
      ? parsed.data
      : deny('invalid_arguments', 'Arguments do not match this capability.');
  }
  private checkOperation(
    connection: ConnectionInstance,
    operation: string,
    resources: string[],
    binding?: { resources: string[]; operations: string[] },
  ) {
    const declared = this.adapter(connection).manifest.operations.find((op) => op.id === operation);
    if (
      !declared ||
      !connection.operations.includes(operation) ||
      (binding && !binding.operations.includes(operation))
    )
      deny('unsupported_operation', 'That operation is outside the approved capability.');
    if (
      declared.effect !== 'read' ||
      declared.vendorScopes.some((scope) => !connection.vendorScopes.includes(scope))
    )
      deny('read_only', 'This connection is read only and requires its approved vendor scopes.');
    if (
      !resources.length ||
      new Set(resources).size !== resources.length ||
      resources.some(
        (resource) =>
          !connection.resources.some((allowed) => allowed.id === resource) ||
          (binding && !binding.resources.includes(resource)),
      )
    )
      deny('resource_denied', 'A requested location is outside the approved scope.');
  }
  private async bound(runId: string, permission: string) {
    const run = await this.host.runs.get(runId),
      state = this.data(run.projectId);
    const binding = state.connections.bindings[runId];
    if (!binding) deny('unbound_run', 'No connection is bound to this run.');
    const connection = this.find(state, binding.connectionId),
      principal = await this.authority(connection, permission);
    if (
      connection.generation !== binding.generation ||
      principal.id !== binding.principalId ||
      principal.identityGeneration !== binding.identityGeneration
    )
      deny('connection_revoked', 'The run belongs to an older connection or identity generation.');
    if (
      run.tenantId !== connection.tenantId ||
      run.projectId !== connection.projectId ||
      run.capabilityId !== `connection-${connection.connectorId}` ||
      run.capabilityVersion !== connection.version ||
      run.principal.id !== binding.principalId ||
      run.principal.identityGeneration !== binding.identityGeneration ||
      digest(run.capabilityTools) !==
        digest(
          binding.operations.map((operation) => this.toolName(connection.connectorId, operation)),
        )
    )
      deny(
        'admission_conflict',
        'The Runtime admission differs from its saved connection binding.',
      );
    return { binding, connection, principal };
  }
  private async bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(
          new HarnessError('connector_interrupted', 'Connector deadline or cancellation reached.'),
        );
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([work, stopped]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  toolName(connectorId: string, operationId: string) {
    return `conn_${connectorId}_${operationId}`;
  }

  async install(projectId: string, input: unknown) {
    const connection = connectionSchema.parse(input);
    if (connection.projectId !== projectId)
      deny('scope_denied', 'The connection belongs to another project.');
    await this.authority(connection, 'connections.manage');
    for (const operation of connection.operations)
      this.checkOperation(
        connection,
        operation,
        connection.resources.map((resource) => resource.id),
      );
    return this.mutate(projectId, async (state) => {
      await this.authority(connection, 'connections.manage');
      if (state.connections.instances.some((item) => item.id === connection.id))
        deny('connection_exists', 'This connection already exists.');
      state.connections.instances.push(connection);
      for (const rule of this.adapter(connection).manifest.rules) {
        const existing = state.rules.active.find(
          (item) => item.id === rule.id && digest(item.scope) === digest(rule.scope),
        );
        if (!existing) {
          state.rules.active.push(rule);
          state.rules.revisions.push(rule);
        } else if (
          digest({ ...existing, enabled: rule.enabled, version: rule.version }) !== digest(rule)
        ) {
          deny(
            'rule_upgrade_review',
            'Changed connector guidance requires an explicit rule migration review.',
          );
        }
      }
      return copy(connection);
    });
  }
  async status(projectId: string, connectionId: string) {
    const connection = this.find(this.data(projectId), connectionId);
    await this.authority(connection, 'connections.read', false);
    const stale =
      !connection.lastReconciledAt ||
      this.clock() - Date.parse(connection.lastReconciledAt) > connection.staleAfterMs;
    return {
      connection,
      health:
        connection.status !== 'connected'
          ? connection.status
          : (connection.problem ?? (stale ? 'stale' : 'healthy')),
      freshness: 'Fixture observations; monitoring while this host is online',
      manifest: this.adapter(connection).manifest,
    };
  }
  async control(projectId: string, connectionId: string, status: ConnectionInstance['status']) {
    return this.mutate(projectId, async (state) => {
      const connection = this.find(state, connectionId);
      await this.authority(connection, 'connections.manage', false);
      connection.status = connectionSchema.shape.status.parse(status);
      connection.generation++;
      connection.lastReconciledAt = null;
      connection.reconciledResources = {};
      for (const event of state.connections.inbox)
        if (event.connectionId === connectionId && event.state === 'pending')
          event.state = 'ignored';
      return copy(connection);
    });
  }
  async admit(
    projectId: string,
    connectionId: string,
    resources: string[],
    operations: string[],
    id?: string,
  ) {
    const connection = this.find(this.data(projectId), connectionId),
      principal = await this.authority(connection, 'connections.read');
    if (!operations.length || new Set(operations).size !== operations.length)
      deny('unsupported_operation', 'Choose distinct capabilities.');
    for (const operation of operations) this.checkOperation(connection, operation, resources);
    const tools = operations.map((operation) => this.toolName(connection.connectorId, operation));
    const runId = id ?? `cn-${crypto.randomUUID()}`;
    if ((await this.host.list(projectId)).some((run) => run.id === runId))
      deny('run_exists', 'This run already exists.');
    // Persist the binding first. A crash before Runtime.start can retry the same
    // binding; a crash after start already has everything required for recovery.
    await this.mutate(projectId, async (state) => {
      const fresh = this.find(state, connectionId),
        current = await this.authority(fresh, 'connections.read');
      if (
        fresh.generation !== connection.generation ||
        current.id !== principal.id ||
        current.identityGeneration !== principal.identityGeneration
      )
        deny('connection_revoked', 'Authority changed during admission.');
      const binding = {
        connectionId,
        generation: fresh.generation,
        resources: [...resources],
        operations: [...operations],
        role: 'Stock investigator',
        principalId: current.id,
        identityGeneration: current.identityGeneration,
      };
      if (
        state.connections.bindings[runId] &&
        digest(state.connections.bindings[runId]) !== digest(binding)
      )
        deny(
          'admission_conflict',
          'The pending admission belongs to different scope or authority.',
        );
      state.connections.bindings[runId] = binding;
    });
    const run = await this.host.runs.start({
      id: runId,
      projectId,
      tenantId: connection.tenantId,
      principal,
      tools: this.host.tools,
      capability: {
        id: `connection-${connection.connectorId}`,
        version: connection.version,
        label: connection.name,
        description: 'Bounded read-only connection investigation',
        tools,
        requestedPermissions: ['connections.read'],
        approvalPolicy: 'show-first',
        maxTurns: 6,
        supportedPlatforms: ['win32', 'linux', 'darwin'],
      },
      budget: { units: 20, modelCalls: 6, toolCalls: 8, wallMs: this.timeoutMs },
    });
    await this.host.runs.claim(run.id, this.owner);
    return run.id;
  }
  async invoke(runId: string, operationId: string, input: Json, stepId = 'read') {
    const { connection, binding, principal } = await this.bound(runId, 'connections.read');
    const operation = this.adapter(connection).operations.find((op) => op.id === operationId);
    if (!operation) deny('unsupported_operation', 'That connector operation is unsupported.');
    this.checkOperation(
      connection,
      operationId,
      operation.resources(this.parseInput(operation, input)),
      binding,
    );
    const tool = this.host.tools.get(this.toolName(connection.connectorId, operationId));
    return this.host.runs.step(
      runId,
      this.owner,
      {
        id: stepId,
        version: tool.version,
        kind: 'tool',
        effect: tool.effect,
        name: tool.name,
        permission: tool.permission,
        destination: tool.destination,
        cost: 1,
        maxAttempts: 2,
        input: { runId, connectionId: connection.id, input },
      },
      (context) => tool.execute({ ...context, input: context.input }),
      principal,
    );
  }
  async accept(
    projectId: string,
    connectionId: string,
    raw: string,
    signature: string,
    restaurantHeader?: string,
  ) {
    if (Buffer.byteLength(raw, 'utf8') > 32768)
      deny('event_too_large', 'The event exceeds the receiver limit.');
    const connection = this.find(this.data(projectId), connectionId);
    await this.authority(connection, 'connections.read');
    const parse = this.adapter(connection).parseEvent;
    if (!parse) deny('unsupported_event', 'This connector has no event contract.');
    const event = parse(raw, this.now());
    if (!(await this.credentials.verify(connectionId, raw, event.timestamp, signature)))
      deny('invalid_signature', 'The event signature is invalid.');
    this.credentials.assertSafe(JSON.parse(raw));
    // This receiver's conservative window allows the documented 5 + 10 minute retry sequence.
    if (
      Date.parse(event.timestamp) > this.clock() + 300000 ||
      Date.parse(event.timestamp) < this.clock() - 1800000
    )
      deny(
        'event_time_window',
        'The event timestamp is outside this receiver window; reconcile source state.',
      );
    if (restaurantHeader !== undefined && restaurantHeader !== event.observation.resourceId)
      deny('event_scope_denied', 'The event header and signed restaurant disagree.');
    if (!connection.resources.some((resource) => resource.id === event.observation.resourceId))
      deny('resource_denied', 'The signed event is outside the approved locations.');
    return this.mutate(projectId, async (state) => {
      const fresh = this.find(state, connectionId);
      await this.authority(fresh, 'connections.read');
      if (fresh.generation !== connection.generation)
        deny('connection_revoked', 'Connection changed during event validation.');
      const prior = state.connections.inbox.find(
        (item) => item.id === event.id && item.connectionId === connectionId,
      );
      if (prior) {
        if (prior.digest !== digest(raw))
          deny('event_identity_conflict', 'The same event identity has different signed content.');
        return { accepted: true, duplicate: true, eventId: event.id };
      }
      if (state.connections.inbox.length >= 1000)
        deny('inbox_full', 'The durable inbox is full; it requires reviewed retention or export.');
      state.connections.inbox.push({
        id: event.id,
        connectionId,
        generation: fresh.generation,
        digest: digest(raw),
        observation: event.observation,
        state: 'pending',
        runId: `ce-${digest([connectionId, event.id]).slice(0, 32)}`,
        rules: [],
        issueId: null,
      });
      fresh.lastEventAt = event.observation.receivedAt;
      return { accepted: true, duplicate: false, eventId: event.id };
    });
  }

  /** Coalesces callers; processing and recovery still use the one RunService. */
  drain(projectId: string): Promise<void> {
    const active = this.draining.get(projectId);
    if (active) return active;
    const work = this.processPending(projectId);
    this.draining.set(projectId, work);
    void work.then(
      () => {
        this.draining.delete(projectId);
      },
      () => {
        this.draining.delete(projectId);
      },
    );
    return work;
  }
  private async processPending(projectId: string) {
    for (const event of this.data(projectId).connections.inbox) {
      const connection = this.find(this.data(projectId), event.connectionId);
      const known = (await this.host.list(projectId)).find((run) => run.id === event.runId);
      if (event.state === 'ignored' && !known) continue;
      if (known?.state === 'completed' || known?.state === 'cancelled') continue;
      if (connection.status !== 'connected' || connection.generation !== event.generation) continue;
      if (!known)
        await this.admit(
          projectId,
          connection.id,
          [event.observation.resourceId],
          connection.operations,
          event.runId,
        );
      else await this.host.runs.claim(event.runId, this.owner);
      const bound = await this.bound(event.runId, 'issues.create');
      await this.host.runs.step(
        event.runId,
        this.owner,
        {
          id: 'triage',
          version: '1',
          kind: 'transform',
          effect: 'idempotent',
          name: 'connection_event_triage',
          input: { eventId: event.id, digest: event.digest },
          permission: 'issues.create',
          maxAttempts: 3,
        },
        async ({ signal }) =>
          this.mutate(projectId, async (state) => {
            const receipt = state.connections.inbox.find(
              (item) => item.id === event.id && item.connectionId === event.connectionId,
            )!;
            if (receipt.state !== 'pending')
              return { issueId: receipt.issueId, rules: receipt.rules, state: receipt.state };
            const fresh = this.find(state, event.connectionId);
            const current = await this.authority(fresh, 'issues.create');
            if (
              fresh.generation !== receipt.generation ||
              bound.binding.generation !== fresh.generation ||
              current.id !== bound.binding.principalId ||
              current.identityGeneration !== bound.binding.identityGeneration
            )
              deny('connection_revoked', 'The queued event belongs to revoked authority.');
            signal.throwIfAborted();
            const observation = receipt.observation,
              key = observationKey(fresh.id, observation),
              previous = state.connections.observations[key];
            if (this.clock() - timeOf(observation) > fresh.staleAfterMs) {
              receipt.state = 'ignored';
              fresh.problem = 'reconciliation-required';
              return { issueId: null, rules: [], state: receipt.state };
            }
            const superseded = previous && timeOf(observation) <= timeOf(previous);
            if (superseded) {
              receipt.state = 'ignored';
              if (
                timeOf(observation) === timeOf(previous) &&
                digest(observation.facts) !== digest(previous.facts)
              )
                fresh.problem = 'reconciliation-required';
              return { issueId: null, rules: [], state: receipt.state };
            }
            state.connections.observations[key] = observation;
            receipt.rules = evaluateRules(
              state.rules.active,
              this.scope(fresh, {
                resourceId: observation.resourceId,
                workflowId: 'stock-triage',
                runId: event.runId,
                userId: current.id,
              }),
              observation.facts,
            );
            const matches = receipt.rules.filter((rule) => rule.action === 'create-issue');
            if (matches.length) {
              let issueId = state.connections.issues[key];
              const text =
                `Source: ${observation.source}\nLocation: ${fresh.resources.find((resource) => resource.id === observation.resourceId)!.name}\n` +
                `Source time: ${observation.sourceAt ?? 'not supplied'}\nReceived: ${observation.receivedAt}\n` +
                `Reported quantity: ${typeof observation.facts.quantity === 'number' ? observation.facts.quantity : 'not supplied'}\n` +
                `Availability: ${String(observation.facts.availability ?? 'unknown')}\n` +
                matches
                  .map(
                    (rule) =>
                      `Rule ${rule.id} v${rule.version}: ${rule.text}\nCondition: ${rule.predicate?.field} ${rule.predicate?.operator} ${rule.predicate?.value}\nReported input: ${JSON.stringify(rule.input)}\nRule source: ${rule.provenance.source}`,
                  )
                  .join('\n') +
                '\nRead only; no Toast changes.';
              if (!issueId) {
                const task = this.store.createTask(state, {
                  name: `Stock needs attention / ${fresh.resources.find((resource) => resource.id === observation.resourceId)!.name}`,
                  description: text,
                  owner: 'you',
                });
                task.createdBy = 'diomedes';
                issueId = task.id;
                state.connections.issues[key] = issueId;
              } else {
                const task = state.tasks.find((item) => item.id === issueId);
                if (task && !task.deletedAt) task.description = text;
              }
              receipt.issueId = issueId;
              this.store.addEntry(state, {
                kind: 'connection-rule-matched',
                actor: 'diomedes',
                taskId: issueId,
                sentence: `Manager issue ${issueId}: ${matches.map((rule) => `${rule.id} v${rule.version}`).join(', ')} matched source evidence.`,
                label: `connection-event:${event.id}`,
                sample: true,
              });
            }
            receipt.state = 'processed';
            return { issueId: receipt.issueId, rules: receipt.rules, state: receipt.state };
          }),
        bound.principal,
      );
      await this.host.runs.complete(event.runId, this.owner, { eventId: event.id });
    }
  }
  /** Call only on exclusive startup, after Store and HarnessHost recovery. */
  async recover(projectId: string) {
    const data = this.data(projectId),
      saved = await this.host.list(projectId);
    for (const event of data.connections.inbox) {
      const connection = this.find(data, event.connectionId);
      if (
        connection.status !== 'connected' ||
        connection.generation !== event.generation ||
        !saved.some(
          (run) => run.id === event.runId && !['completed', 'cancelled'].includes(run.state),
        )
      )
        continue;
      const bound = await this.bound(event.runId, 'connections.read');
      await this.host.runs.recover(event.runId, bound.principal);
    }
    await this.drain(projectId);
  }
  async propose(projectId: string, connectionId: string, text: string) {
    this.credentials.assertSafe(text);
    return this.mutate(projectId, async (state) => {
      const connection = this.find(state, connectionId);
      await this.authority(connection, 'connections.manage');
      const proposal = proposeRule(text, this.scope(connection));
      if (!state.rules.proposals.some((item) => item.id === proposal.id))
        state.rules.proposals.push(proposal);
      return { proposal, digest: digest(proposal) };
    });
  }
  async activate(
    projectId: string,
    connectionId: string,
    proposalId: string,
    expectedDigest: string,
  ) {
    return this.mutate(projectId, async (state) => {
      const connection = this.find(state, connectionId);
      await this.authority(connection, 'connections.manage');
      const proposal = state.rules.proposals.find((item) => item.id === proposalId);
      if (
        !proposal?.rule ||
        proposal.questions.length ||
        digest(proposal) !== expectedDigest ||
        proposal.rule.scope.connectionId !== connectionId
      )
        deny('proposal_conflict', 'Review an exact, complete rule proposal before activation.');
      const source = `user proposal:${proposal.id}`;
      const adopted = state.rules.revisions.find((rule) => rule.provenance.source === source);
      if (adopted) return copy(adopted); // Replaying approval never re-enables a disabled rule.
      const previous = state.rules.active.find(
        (rule) =>
          rule.id === proposal.rule!.id && digest(rule.scope) === digest(proposal.rule!.scope),
      );
      const rule: Rule = {
        ...proposal.rule,
        enabled: true,
        version: (previous?.version ?? 0) + 1,
        provenance: { ...proposal.rule.provenance, source, trust: 'host-reviewed' },
      };
      state.rules.active = state.rules.active.filter((item) => item !== previous);
      state.rules.active.push(rule);
      state.rules.revisions.push(rule);
      return rule;
    });
  }
  async disableRule(projectId: string, connectionId: string, id: string) {
    return this.mutate(projectId, async (state) => {
      const connection = this.find(state, connectionId);
      await this.authority(connection, 'connections.manage');
      const matching = selectRules(state.rules.active, this.scope(connection)).filter(
        (rule) =>
          rule.id === id &&
          rule.scope.connectionId === connectionId &&
          rule.scope.projectId === projectId &&
          rule.scope.tenantId === connection.tenantId,
      );
      if (matching.length !== 1)
        deny(
          'rule_scope_denied',
          'Connection controls can disable only a rule owned by this connection.',
        );
      matching[0].enabled = false;
      matching[0].version++;
      state.rules.revisions.push(copy(matching[0]));
    });
  }
  async modelContext(request: ModelRequest) {
    const { binding, connection } = await this.bound(request.runId, 'connections.read');
    const tools = binding.operations.map((operation) =>
      this.toolName(connection.connectorId, operation),
    );
    return this.mutate(connection.projectId, async (state) => {
      const fresh = this.find(state, connection.id),
        current = await this.authority(fresh, 'connections.read');
      if (
        fresh.generation !== binding.generation ||
        current.identityGeneration !== binding.identityGeneration ||
        current.id !== binding.principalId
      )
        deny('connection_revoked', 'Authority changed before context assembly.');
      const rules = binding.resources
        .flatMap((resourceId) =>
          binding.operations.flatMap((capabilityId) =>
            evaluateRules(
              state.rules.active,
              this.scope(connection, {
                resourceId,
                capabilityId,
                runId: request.runId,
                role: binding.role,
                userId: current.id,
              }),
              {},
            ),
          ),
        )
        .filter((rule) => rule.action === 'context');
      const unique = rules.filter(
        (rule, index) =>
          rules.findIndex(
            (other) =>
              other.id === rule.id &&
              other.version === rule.version &&
              digest(other.scope) === digest(rule.scope),
          ) === index,
      );
      const evidence = {
        runId: request.runId,
        role: binding.role,
        resources: binding.resources,
        tools,
        rules: unique,
      };
      if (!state.connections.contextEvidence.some((item) => digest(item) === digest(evidence)))
        state.connections.contextEvidence.push(evidence);
      const text =
        `Role: ${binding.role}.\nRun: ${request.runId}. Connection: ${connection.id}.\n` +
        `Approved locations: ${connection.resources
          .filter((resource) => binding.resources.includes(resource.id))
          .map((resource) => `${resource.name} (${resource.id})`)
          .join(', ')}.\n` +
        'Use only the supplied read capabilities. No external writes or model-provider egress are authorized.\n' +
        unique.map((rule) => `[${rule.id} v${rule.version}] ${rule.text}`).join('\n');
      this.credentials.assertSafe(text);
      return { text, tools };
    });
  }
  async runFixtureAgent(runId: string, adapter: ModelAdapter, prompt: string) {
    this.credentials.assertSafe(prompt); // Before NativeAgent persists its model-step input.
    if (!isConnectionFixtureModel(adapter))
      deny(
        'provider_unsupported',
        'Only the registered scripted fixture model is admitted by this proof.',
      );
    const { principal } = await this.bound(runId, 'connections.read');
    const scoped = new RuleModelAdapter(
      adapter,
      (request) => this.modelContext(request),
      (value) => {
        this.credentials.assertSafe(value);
        return value;
      },
    );
    return new NativeAgent(this.host.runs, scoped, this.host.tools).run(
      runId,
      this.owner,
      prompt,
      principal,
      { maxTurns: 6 },
    );
  }
  snapshot(projectId: string) {
    return this.data(projectId);
  }
}
