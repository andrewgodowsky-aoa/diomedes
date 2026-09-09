/**
 * The one authority for harness runs: state, dispatch, approvals and durable
 * events. Every native model or tool invocation passes through `step`, which
 * applies the mandatory policy, then the optional hooks, then claims the step
 * under the run's lease fence, reserves budget, runs the handler, and commits
 * the observation together with its event in one durable write.
 *
 * What this is not: a document writer (that stays `Store.writeRecorded`), an
 * engine adapter, a scheduler, or a security sandbox. Handlers are trusted
 * host code. Fencing protects the run record; an external effect that already
 * happened needs sink-specific protection or reconciliation, never a guess.
 */
import { randomBytes } from 'node:crypto';
import type {
  CapabilityManifest,
  Destination,
  Effect,
  HarnessApproval,
  HarnessBudget,
  HarnessEvent,
  HarnessLabel,
  HarnessPrincipal,
  HarnessRun,
  Json,
  ProviderTranscriptRef,
  StepIntent,
  StepKind,
  StepRecord,
} from '../../shared/harness.js';
import { HARNESS_CONTRACT_VERSION } from '../../shared/harness.js';
import {
  authorize,
  canonical,
  copy,
  digest,
  HarnessError,
  units,
  validateLabel,
  validatePrincipal,
} from './policy.js';
import { validateRunId, type RunStore } from './run-store.js';

export class Suspended extends Error {
  constructor(
    readonly reason: 'approval' | 'event',
    message: string,
  ) {
    super(message);
    this.name = 'Suspended';
  }
}

export interface StepDefinition {
  id: string;
  version: string;
  kind?: StepKind;
  effect?: Effect;
  name?: string | null;
  input?: Json;
  cost?: number;
  maxAttempts?: number;
  permission?: string | null;
  approval?: boolean;
  destination?: Destination;
  trustedInputRequired?: boolean;
  label?: HarnessLabel | null;
}
export interface StepContext {
  input: Json;
  idempotencyKey: string;
  attempt: number;
  signal: AbortSignal;
}
export type StepHandler<T> = (context: StepContext) => Promise<T> | T;
export type HarnessHook = (context: {
  runId: string;
  step: StepIntent;
  principal: HarnessPrincipal;
}) => Promise<void> | void;

export interface StartInput {
  id?: string;
  tenantId: string;
  projectId: string;
  taskId?: string | null;
  sessionId?: string | null;
  capability: CapabilityManifest;
  principal: HarnessPrincipal;
  budget: HarnessBudget;
  /** When given, every tool the capability names must be registered. */
  tools?: { has(name: string): boolean };
}
export interface Decision {
  runId: string;
  stepId: string;
  decision: 'approved' | 'denied';
  decidedBy: string;
  ttlMs: number;
  /** Optional host deadline; IO/queue latency may shorten, never extend, this window. */
  expiresAt?: string;
}

const EFFECTS: Effect[] = ['pure', 'read', 'idempotent', 'non-idempotent'];
const KINDS: StepKind[] = ['model', 'tool', 'transform', 'approval', 'wait'];
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type StartOutcome =
  | { cached: Json | null }
  | { suspended: 'approval' }
  | { blocked: string }
  | { fence: number; attempt: number; key: string };

export class RunService {
  private hooks: HarnessHook[] = [];
  private queues = new Map<string, Promise<unknown>>();
  private controllers = new Map<string, AbortController>();
  private readonly clock: () => number;
  private readonly policyVersion: string;
  private readonly redact: (text: string) => string;

  constructor(
    private readonly store: RunStore,
    options: {
      clock?: () => number;
      policyVersion?: string;
      /** Applied to every error message before it is persisted. The host passes its secret scrubber. */
      redact?: (text: string) => string;
    } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.policyVersion = options.policyVersion ?? 'diomedes-policy-v1';
    this.redact = options.redact ?? ((text) => text);
  }

  private describeError(error: unknown): { name: string; message: string } {
    return {
      name: error instanceof Error ? this.redact(error.name).slice(0, 128) : 'Error',
      message: this.redact(error instanceof Error ? error.message : String(error)).slice(0, 2000),
    };
  }

  /** Optional hooks run after policy, in order, on deep copies. They cannot allow what policy denied. */
  use(hook: HarnessHook) {
    if (typeof hook !== 'function')
      throw new HarnessError('invalid_hook', 'A hook must be a function.');
    this.hooks.push(hook);
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  /** One writer per run inside this process, the same queue idea as `Store.locked`. */
  private serialize<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const result = previous.then(action, action);
    this.queues.set(
      runId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private async load(runId: string): Promise<HarnessRun> {
    const run = await this.store.read(validateRunId(runId));
    if (!run) throw new HarnessError('unknown_run', `Unknown run: ${runId}.`);
    return run;
  }

  private note(
    run: HarnessRun,
    type: string,
    attributes: HarnessEvent['attributes'],
    stepId?: string,
    attempt?: number,
  ) {
    run.lastSeq += 1;
    run.events.push({
      v: HARNESS_CONTRACT_VERSION,
      seq: run.lastSeq,
      runId: run.id,
      at: this.now(),
      type,
      ...(stepId === undefined ? {} : { stepId }),
      ...(attempt === undefined ? {} : { attempt }),
      attributes,
    });
  }

  private async commit(run: HarnessRun) {
    run.updatedAt = this.now();
    await this.store.write(run);
  }

  private guard(run: HarnessRun, owner: string, fence?: number) {
    if (
      run.owner !== owner ||
      (run.leaseExpiresAt ?? 0) <= this.clock() ||
      (fence !== undefined && fence !== run.fence)
    )
      throw new HarnessError('stale_lease', 'stale lease');
  }

  private scope(run: HarnessRun, principal: HarnessPrincipal) {
    validatePrincipal(principal);
    if (run.tenantId !== principal.tenantId)
      throw new HarnessError('tenant_mismatch', 'tenant mismatch');
    if (run.projectId !== principal.projectId)
      throw new HarnessError('project_mismatch', 'project mismatch');
  }

  private controller(runId: string) {
    let controller = this.controllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(runId, controller);
    }
    return controller;
  }

  private intentOf(definition: StepDefinition): StepIntent {
    const d = {
      kind: 'tool' as StepKind,
      effect: 'pure' as Effect,
      cost: 0,
      maxAttempts: 3,
      approval: false,
      destination: 'local' as Destination,
      trustedInputRequired: false,
      ...definition,
    };
    if (typeof d.id !== 'string' || !STEP_ID.test(d.id) || typeof d.version !== 'string' || !d.version)
      throw new HarnessError('invalid_step', 'A stable step id and version are required.');
    if (!EFFECTS.includes(d.effect)) throw new HarnessError('invalid_step', 'Unknown effect.');
    if (!KINDS.includes(d.kind)) throw new HarnessError('invalid_step', 'Unknown step kind.');
    units(d.cost, 'Step cost');
    if (units(d.maxAttempts, 'Attempt limit') === 0)
      throw new HarnessError('invalid_step', 'A positive attempt limit is required.');
    if (d.label != null) validateLabel(d.label);
    const intent: StepIntent = {
      stepId: d.id,
      stepVersion: d.version,
      kind: d.kind,
      effect: d.effect,
      name: d.name ?? null,
      input: copy(d.input ?? null),
      cost: d.cost,
      maxAttempts: d.maxAttempts,
      permission: d.permission ?? null,
      approval: d.approval === true,
      destination: d.destination,
      trustedInputRequired: d.trustedInputRequired === true,
      label: d.label == null ? null : copy(d.label),
      policyVersion: this.policyVersion,
    };
    return copy(intent);
  }

  private ensure(run: HarnessRun, intent: StepIntent): StepRecord {
    const intentHash = digest(intent);
    const existing = run.steps.find((s) => s.intent.stepId === intent.stepId);
    if (existing) {
      if (existing.intentHash !== intentHash)
        throw new HarnessError('intent_mismatch', 'step intent mismatch; fork instead');
      return existing;
    }
    const record: StepRecord = {
      intent,
      intentHash,
      attempt: 0,
      state: 'pending',
      output: null,
      outputHash: null,
      leaseFence: 0,
      startedAt: null,
      endedAt: null,
      error: null,
    };
    run.steps.push(record);
    return record;
  }

  async start(input: StartInput): Promise<HarnessRun> {
    validatePrincipal(input.principal);
    const { capability, budget } = input;
    if (!capability || typeof capability.id !== 'string' || !capability.id || !capability.version)
      throw new HarnessError('invalid_capability', 'A capability id and version are required.');
    for (const key of ['units', 'modelCalls', 'toolCalls'] as const)
      units(budget?.[key], `Budget ${key}`);
    if (budget.wallMs !== null) units(budget.wallMs, 'Budget wallMs');
    if (units(capability.maxTurns, 'Capability maxTurns') === 0)
      throw new HarnessError('invalid_capability', 'A positive turn limit is required.');
    for (const key of ['tools', 'requestedPermissions'] as const) {
      const list = capability[key];
      if (!Array.isArray(list) || !list.every((item) => typeof item === 'string' && item))
        throw new HarnessError('invalid_capability', `Capability ${key} must be a list of names.`);
    }
    const missing = capability.requestedPermissions.filter(
      (p) => !input.principal.capabilities.includes(p),
    );
    if (missing.length)
      throw new HarnessError(
        'missing_capability',
        `The capability asks for a permission this principal does not hold: ${missing.join(', ')}.`,
      );
    if (input.tools)
      for (const name of capability.tools)
        if (!input.tools.has(name))
          throw new HarnessError('unknown_tool', `Unknown tool named by the capability: ${name}.`);
    if (input.tenantId !== input.principal.tenantId || input.projectId !== input.principal.projectId)
      throw new HarnessError('scope_mismatch', 'The principal does not belong to this tenant and project.');
    const id = input.id === undefined ? `R${randomBytes(6).toString('hex')}` : validateRunId(input.id);
    const at = this.now();
    const run: HarnessRun = {
      v: HARNESS_CONTRACT_VERSION,
      id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      capabilityTools: [...new Set(capability.tools)],
      policyVersion: this.policyVersion,
      principal: copy(input.principal),
      state: 'queued',
      budget: copy(budget),
      used: { units: 0, modelCalls: 0, toolCalls: 0 },
      owner: null,
      fence: 0,
      leaseExpiresAt: null,
      parentRunId: null,
      forkPoint: null,
      contextRevision: 1,
      transcripts: {},
      result: null,
      failure: null,
      cancelReason: null,
      createdAt: at,
      updatedAt: at,
      steps: [],
      approvals: [],
      events: [],
      lastSeq: 0,
    };
    this.note(run, 'run.created', {
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      taskId: run.taskId,
    });
    await this.store.create(run);
    return copy(run);
  }

  async get(runId: string): Promise<HarnessRun> {
    return this.load(runId);
  }

  async events(runId: string, afterSeq = 0): Promise<HarnessEvent[]> {
    units(afterSeq, 'The event cursor');
    return (await this.load(runId)).events.filter((e) => e.seq > afterSeq);
  }

  /**
   * Called only during exclusive host startup, after Store journal recovery and
   * before dispatch. Invalidate the dead process's lease without a timer. Safe
   * effects may retry through their sink's idempotency receipt; unknown effects
   * stay parked. This method is never exposed as an HTTP action.
   */
  async recover(runId: string, principal: HarnessPrincipal): Promise<void> {
    await this.serialize(runId, async () => {
      const run = await this.load(runId);
      this.scope(run, principal);
      if (!['running', 'queued', 'waiting'].includes(run.state)) return;
      run.owner = null;
      run.leaseExpiresAt = null;
      run.fence += 1;
      for (const step of run.steps) {
        if (step.state !== 'running') continue;
        step.state = step.intent.effect === 'non-idempotent' ? 'reconcile_required' : 'retry_wait';
        this.note(run, `step.${step.state}`, { why: 'exclusive host startup' }, step.intent.stepId, step.attempt);
      }
      run.state = run.steps.some((step) => step.state === 'reconcile_required') ? 'reconcile_required'
        : run.steps.some((step) => step.state === 'waiting_approval') ? 'waiting' : 'queued';
      this.note(run, 'run.recovered', { fence: run.fence });
      await this.commit(run);
    });
  }

  /** Take or renew the run's lease. A live lease held by someone else is refused. */
  async claim(runId: string, owner: string, ttlMs = 60_000): Promise<number> {
    if (!owner || typeof owner !== 'string' || units(ttlMs, 'Lease TTL') === 0)
      throw new HarnessError('invalid_lease', 'An owner and a positive TTL are required.');
    return this.serialize(runId, async () => {
      const run = await this.load(runId);
      const live = (run.leaseExpiresAt ?? 0) > this.clock();
      if (run.owner && run.owner !== owner && live)
        throw new HarnessError('lease_busy', 'lease busy');
      // A live owner renewing its own lease keeps the fence: the generation
      // changes only when ownership does, so an in-flight step can still commit.
      const renewal = run.owner === owner && live;
      if (!renewal) run.fence += 1;
      run.owner = owner;
      run.leaseExpiresAt = this.clock() + ttlMs;
      if (run.state === 'queued') run.state = 'running';
      this.note(run, renewal ? 'run.lease_renewed' : 'run.claimed', {
        owner,
        fence: run.fence,
        expiresAt: run.leaseExpiresAt,
      });
      await this.commit(run);
      return run.fence;
    });
  }

  /**
   * Execute one step. Completed steps return their persisted observation and
   * never invoke the handler again. A changed intent is refused. An unknown
   * non-idempotent outcome parks the run for reconciliation.
   */
  async step<T = Json>(
    runId: string,
    owner: string,
    definition: StepDefinition,
    handler: StepHandler<T>,
    principal: HarnessPrincipal,
  ): Promise<T> {
    this.scope(await this.load(runId), principal);
    const intent = this.intentOf(definition);
    authorize(intent, principal);
    for (const hook of this.hooks)
      await hook({ runId, step: copy(intent), principal: copy(principal) });

    const start: StartOutcome = await this.serialize(runId, async () => {
      const run = await this.load(runId);
      if (run.state === 'cancelled')
        throw new HarnessError('run_cancelled', `This run was cancelled: ${run.cancelReason ?? ''}`.trim());
      this.guard(run, owner);
      const before = run.steps.length;
      const s = this.ensure(run, intent);
      let changed = run.steps.length !== before;
      const finish = async (outcome: StartOutcome) => {
        // A replayed observation is a read; only a new record or a state change is written.
        if (changed) await this.commit(run);
        return outcome;
      };
      if (s.state === 'succeeded') return finish({ cached: s.output });
      if (s.state === 'cancelled')
        throw new HarnessError('step_cancelled', 'This step was cancelled.');
      if (s.state === 'reconcile_required') return finish({ blocked: 'reconciliation required' });
      if (s.state === 'running' && s.leaseFence === run.fence)
        return finish({ blocked: 'step already in flight' });
      changed = true;
      if (s.state === 'running' && intent.effect === 'non-idempotent') {
        s.state = 'reconcile_required';
        run.state = 'reconcile_required';
        this.note(run, 'step.reconcile_required', { why: 'ownership changed while running' }, s.intent.stepId, s.attempt);
        return finish({ blocked: 'reconciliation required' });
      }
      if (s.attempt >= intent.maxAttempts) {
        changed = false;
        return finish({ blocked: 'attempt limit reached' });
      }
      if (intent.approval) {
        const now = this.clock();
        const approval = run.approvals.find(
          (a) =>
            a.stepId === intent.stepId &&
            a.decision === 'approved' &&
            a.intentHash === s.intentHash &&
            a.identityGeneration === principal.identityGeneration &&
            Date.parse(a.expiresAt) > now,
        );
        if (!approval) {
          s.state = 'waiting_approval';
          run.state = 'waiting';
          this.note(run, 'step.waiting_approval', { intentHash: s.intentHash }, s.intent.stepId, s.attempt);
          return finish({ suspended: 'approval' });
        }
        approval.consumedAt ??= this.now();
      }
      const blockedBy =
        intent.cost > run.budget.units - run.used.units
          ? 'budget exceeded'
          : intent.kind === 'model' && run.used.modelCalls >= run.budget.modelCalls
            ? 'budget exceeded: model calls'
            : intent.kind === 'tool' && run.used.toolCalls >= run.budget.toolCalls
              ? 'budget exceeded: tool calls'
              : null;
      if (blockedBy) {
        changed = run.steps.length !== before;
        return finish({ blocked: blockedBy });
      }
      run.used.units += intent.cost;
      if (intent.kind === 'model') run.used.modelCalls += 1;
      if (intent.kind === 'tool') run.used.toolCalls += 1;
      s.state = 'running';
      s.attempt += 1;
      s.leaseFence = run.fence;
      s.startedAt = this.now();
      s.endedAt = null;
      s.error = null;
      run.state = 'running';
      this.note(
        run,
        'step.started',
        { fence: run.fence, reservedUnits: intent.cost, effect: intent.effect },
        s.intent.stepId,
        s.attempt,
      );
      return finish({
        fence: run.fence,
        attempt: s.attempt,
        key: digest({ runId, stepId: intent.stepId, intentHash: s.intentHash }),
      });
    });

    if ('cached' in start) return start.cached as T;
    if ('suspended' in start) throw new Suspended('approval', 'approval required');
    if ('blocked' in start) throw new HarnessError('blocked', start.blocked);

    const signal = this.controller(runId).signal;
    try {
      const output = await handler({
        input: copy(intent.input),
        idempotencyKey: start.key,
        attempt: start.attempt,
        signal,
      });
      const encoded = canonical(output);
      await this.serialize(runId, async () => {
        const run = await this.load(runId);
        this.guard(run, owner, start.fence);
        const s = run.steps.find((item) => item.intent.stepId === intent.stepId)!;
        if (s.state !== 'running' || s.attempt !== start.attempt)
          throw new HarnessError('stale_attempt', 'stale attempt');
        s.state = 'succeeded';
        s.output = JSON.parse(encoded) as Json;
        s.outputHash = digest(s.output);
        s.endedAt = this.now();
        this.note(run, 'step.succeeded', { outputHash: s.outputHash }, s.intent.stepId, s.attempt);
        await this.commit(run);
      });
      return JSON.parse(encoded) as T;
    } catch (error) {
      // A replaced owner cannot record a failure either: recovery sees the last
      // durable running record and reconciles any unknown irreversible effect.
      try {
        await this.serialize(runId, async () => {
          const run = await this.load(runId);
          this.guard(run, owner, start.fence);
          const s = run.steps.find((item) => item.intent.stepId === intent.stepId)!;
          if (s.state !== 'running' || s.attempt !== start.attempt) return;
          const state = intent.effect === 'non-idempotent' ? 'reconcile_required' : 'retry_wait';
          s.state = state;
          s.endedAt = this.now();
          s.error = this.describeError(error);
          if (state === 'reconcile_required') run.state = 'reconcile_required';
          this.note(run, `step.${state}`, { errorType: s.error.name }, s.intent.stepId, s.attempt);
          await this.commit(run);
        });
      } catch (fencing) {
        if (!(fencing instanceof HarnessError && fencing.code === 'stale_lease')) throw fencing;
      }
      throw error;
    }
  }

  /** Answer a step that is waiting for approval. Binds the decision to the exact intent, the current identity generation and an expiry. */
  async decide(decision: Decision, principal: HarnessPrincipal): Promise<HarnessApproval> {
    if (!decision.decidedBy || typeof decision.decidedBy !== 'string')
      throw new HarnessError('invalid_decision', 'Say who decided.');
    if (decision.decision !== 'approved' && decision.decision !== 'denied')
      throw new HarnessError('invalid_decision', 'A decision is approved or denied.');
    if (units(decision.ttlMs, 'Approval TTL') === 0)
      throw new HarnessError('invalid_decision', 'A positive approval TTL is required.');
    const deadline = Math.min(this.clock() + decision.ttlMs,
      decision.expiresAt === undefined ? Infinity : Date.parse(decision.expiresAt));
    if (!Number.isFinite(deadline))
      throw new HarnessError('invalid_decision', 'A valid approval deadline is required.');
    return this.serialize(decision.runId, async () => {
      const run = await this.load(decision.runId);
      this.scope(run, principal);
      const s = run.steps.find((item) => item.intent.stepId === decision.stepId);
      if (!s || s.state !== 'waiting_approval')
        throw new HarnessError('not_waiting', 'Step is not waiting for approval.');
      const now = this.clock();
      if (now >= deadline)
        throw new HarnessError('approval_expired', 'The approval window expired before its decision could be saved.');
      // The approval binds to the authority current at decision time: the
      // deciding principal's generation. A step consumes it only under that
      // same generation, so a rotation needs a fresh decision, and a fresh
      // decision after a rotation is consumable.
      const approval: HarnessApproval = {
        runId: run.id,
        stepId: s.intent.stepId,
        intentHash: s.intentHash,
        principalId: principal.id,
        identityGeneration: principal.identityGeneration,
        executionGeneration: run.fence,
        decision: decision.decision,
        decidedBy: decision.decidedBy,
        decidedAt: this.now(),
        expiresAt: new Date(deadline).toISOString(),
        consumedAt: null,
      };
      run.approvals = run.approvals.filter((a) => a.stepId !== s.intent.stepId);
      run.approvals.push(approval);
      this.note(
        run,
        'approval.decided',
        { decision: approval.decision, intentHash: approval.intentHash, expiresAt: approval.expiresAt, decidedBy: approval.decidedBy },
        s.intent.stepId,
        s.attempt,
      );
      if (decision.decision === 'approved') {
        s.state = 'pending';
      } else {
        s.state = 'cancelled';
        s.endedAt = this.now();
        run.state = 'cancelled';
        run.cancelReason = 'approval denied';
        this.note(run, 'run.cancelled', { reason: run.cancelReason });
        this.controllers.get(run.id)?.abort();
      }
      await this.commit(run);
      return copy(approval);
    });
  }

  /**
   * Stop a run. A step that is running with an effect on the world keeps an
   * unknown outcome: it is parked for reconciliation, never relabelled as
   * cancelled, and the presentation says so. The abort signal is advisory; a
   * handler that ignores it cannot commit afterwards because its step is no
   * longer `running`.
   */
  async cancel(runId: string, reason: string, principal?: HarnessPrincipal): Promise<void> {
    reason = this.redact(reason);
    await this.serialize(runId, async () => {
      const run = await this.load(runId);
      if (principal) this.scope(run, principal);
      if (run.state === 'completed' || run.state === 'cancelled') return;
      run.state = 'cancelled';
      run.cancelReason = reason;
      for (const s of run.steps) {
        if (s.state === 'running' && s.intent.effect === 'non-idempotent') {
          s.state = 'reconcile_required';
          s.endedAt = this.now();
          this.note(run, 'step.reconcile_required', { why: 'cancelled while running' }, s.intent.stepId, s.attempt);
        } else if (['running', 'pending', 'waiting_approval', 'waiting_event', 'retry_wait'].includes(s.state)) {
          s.state = 'cancelled';
          s.endedAt = this.now();
        }
      }
      this.note(run, 'run.cancelled', { reason });
      await this.commit(run);
    });
    this.controllers.get(runId)?.abort();
    this.controllers.delete(runId);
  }

  /** Record the run's result and its completion event in one write. Idempotent once completed. */
  async complete(runId: string, owner: string, result: Json): Promise<void> {
    await this.serialize(runId, async () => {
      const run = await this.load(runId);
      if (run.state === 'completed') return;
      if (run.state === 'cancelled')
        throw new HarnessError('run_cancelled', 'This run was cancelled and cannot complete.');
      if (run.state === 'reconcile_required' || run.steps.some((s) => s.state === 'reconcile_required'))
        throw new HarnessError(
          'reconcile_required',
          'A step needs reconciliation before this run can complete.',
        );
      this.guard(run, owner);
      if (run.steps.some((s) => s.state === 'running'))
        throw new HarnessError('step_running', 'A step is still running.');
      run.state = 'completed';
      run.result = copy(result);
      this.note(run, 'run.completed', { resultHash: digest(run.result) });
      await this.commit(run);
    });
    this.controllers.delete(runId);
  }

  /** Record a failure. A run parked for reconciliation keeps that state: the unknown outcome outranks the error. */
  async fail(runId: string, owner: string, error: unknown): Promise<void> {
    await this.serialize(runId, async () => {
      const run = await this.load(runId);
      if (['completed', 'cancelled', 'reconcile_required'].includes(run.state)) return;
      this.guard(run, owner);
      run.state = 'failed';
      run.failure = this.describeError(error);
      this.note(run, 'run.failed', { errorType: run.failure.name });
      await this.commit(run);
    });
    this.controllers.delete(runId);
  }

  /** Keep a provider's opaque transcript reference apart from the run's portable context. */
  async recordTranscript(
    runId: string,
    owner: string,
    providerId: string,
    transcript: ProviderTranscriptRef,
  ): Promise<void> {
    await this.serialize(runId, async () => {
      const run = await this.load(runId);
      this.guard(run, owner);
      run.transcripts[providerId] = copy(transcript);
      run.contextRevision += 1;
      this.note(run, 'transcript.recorded', { providerId, lineageId: transcript.lineageId, prefixHash: transcript.prefixHash });
      await this.commit(run);
    });
  }

  /**
   * A new run from a completed pure prefix of another. The child inherits the
   * observations before `beforeStepId` and nothing else: no lease, no approval,
   * no result. A prefix containing an effect on the world cannot be forked.
   */
  async fork(
    parentId: string,
    childId: string,
    beforeStepId: string,
    principal: HarnessPrincipal,
  ): Promise<HarnessRun> {
    const parent = await this.load(parentId);
    this.scope(parent, principal);
    validateRunId(childId);
    const index = parent.steps.findIndex((s) => s.intent.stepId === beforeStepId);
    if (index < 0) throw new HarnessError('unknown_fork_point', 'Unknown fork point.');
    const prefix = parent.steps.slice(0, index);
    if (prefix.some((s) => s.state !== 'succeeded' || s.intent.effect !== 'pure'))
      throw new HarnessError('impure_prefix', 'Forks require a completed pure prefix.');
    const at = this.now();
    const child: HarnessRun = {
      ...copy(parent),
      id: childId,
      state: 'queued',
      used: {
        units: prefix.reduce((sum, s) => sum + s.intent.cost, 0),
        modelCalls: prefix.filter((s) => s.intent.kind === 'model').length,
        toolCalls: prefix.filter((s) => s.intent.kind === 'tool').length,
      },
      owner: null,
      fence: 0,
      leaseExpiresAt: null,
      parentRunId: parent.id,
      forkPoint: beforeStepId,
      // A fork is its own lineage: no provider transcript, no context revision, carries over.
      contextRevision: 1,
      transcripts: {},
      result: null,
      failure: null,
      cancelReason: null,
      createdAt: at,
      updatedAt: at,
      steps: copy(prefix),
      approvals: [],
      events: [],
      lastSeq: 0,
    };
    this.note(child, 'run.forked', {
      parentRunId: parent.id,
      forkPoint: beforeStepId,
      inheritedObservations: prefix.map((s) => s.intent.stepId),
    });
    await this.store.create(child);
    return copy(child);
  }
}
