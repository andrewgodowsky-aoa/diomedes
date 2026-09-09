/** Composition of the existing Runtime, Store and Trust for an explicit synthetic demo.
 * No connector transport, public webhook listener, credential vault or identity backend. */
import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { connectionIntentSchema, desktopConnectionsSchema, type ConnectionPlan, type DesktopConnectionsView } from '../../shared/connection-desktop.js';
import type { HarnessPrincipal, Json } from '../../shared/harness.js';
import { connectionSchema } from '../../shared/connections.js';
import type { Store } from '../store.js';
import type { HarnessHost } from '../harness/host.js';
import { digest, HarnessError } from '../harness/policy.js';
import { currentAuthority, enablePrototypeAuthority, isDenial, refOf, type PrincipalRef } from '../trust/index.js';
import { ConnectionsService } from './service.js';
import { fixtureCredentials } from './credentials.js';
import { toastConnector, fixtureStockEvent } from './fixture.js';
import { connectionFixtureModel } from './fixture-model.js';
import { TOAST_ITEMS, TOAST_RESOURCES, toastManifest } from './toast.js';
import { compiledConnectionDemoConnectors, listCompiledConnectionDemoCandidates,
  activateCompiledConnectionDemo, compiledConnectionDemoId, runCompiledConnectionDemoRoundTrip } from './compiler-demo.js';

const label = 'desktop-connections-fixture';
function fail(code: string, message: string): never { throw new HarnessError(code, message); }
const exact = z.strictObject({ id: z.string().min(1).max(100), digest: z.string().regex(/^[a-f0-9]{64}$/) });
function authorityShape(connection: z.infer<typeof connectionSchema>) {
  const { id, connectorId, version, manifestDigest, tenantId, projectId, resources, vendorScopes, operations, mode } = connection;
  return digest({ id, connectorId, version, manifestDigest, tenantId, projectId, resources, vendorScopes, operations, mode });
}

export class DesktopConnections {
  readonly service: ConnectionsService;
  private readonly refs = new Map<string, PrincipalRef>();
  private readonly signing = new Map<string, ReturnType<typeof fixtureCredentials>>();
  private readonly drains = new Set<Promise<void>>();
  private readonly errors = new Map<string, string>();
  private readonly adoptions = new Map<string, { digest: string; work: Promise<unknown> }>();
  private writeDispatches = 0;
  private closed = false;
  constructor(private readonly store: Store, private readonly host: HarnessHost) {
    const scan = fixtureCredentials('unused-scanner').credentials;
    this.service = new ConnectionsService(store, host, [toastConnector, ...compiledConnectionDemoConnectors], {
      verify: async (id, raw, timestamp, signature) =>
        await this.signing.get(id)?.credentials.verify(id, raw, timestamp, signature) ?? false,
      assertSafe: (value) => { scan.assertSafe(value); for (const item of this.signing.values()) item.credentials.assertSafe(value); },
    }, (projectId) => this.principal(projectId));
    if (process.env.DIOMEDES_TEST_MODE === '1') host.tools.register({
      name: 'fixture_write_probe', version: '1', description: 'Test-only denied write; no external transport.',
      effect: 'non-idempotent', permission: 'connections.write', approval: true,
      destination: 'local', trustedInputRequired: false, cost: 1, schema: z.strictObject({}),
      execute: async () => { this.writeDispatches++; return { unexpectedDispatch: true }; },
    });
  }
  private id(projectId: string) { return `toast-${digest(projectId).slice(0, 16)}`; }
  private tenant(projectId: string) { return `synthetic-${digest(projectId).slice(0, 16)}`; }
  private plans(projectId: string) {
    return desktopConnectionsSchema.parse(this.store.state(projectId).desktopConnections ?? { version: 1, plans: [] });
  }
  private async principal(projectId: string): Promise<HarnessPrincipal> {
    if (this.closed) fail('host_closed', 'The Connections host is stopping.');
    const ref = this.refs.get(projectId);
    if (!ref) fail('authorization_required', 'Review and enable this synthetic connection for the current app session.');
    const authority = await currentAuthority({ via: 'stored-reference', ref });
    if (isDenial(authority)) fail('authorization_required', authority.reason);
    if (!authority.synthetic || authority.assurance !== 'prototype') fail('fixture_only', 'This demonstration requires explicitly synthetic authority.');
    const capabilities: string[] = [];
    if (authority.capabilities.has('project.read')) capabilities.push('connections.read');
    if (authority.capabilities.has('approval.decide')) capabilities.push('connections.manage');
    if (authority.capabilities.has('work.submit')) capabilities.push('issues.create');
    return { id: authority.principal.id, projectId, tenantId: this.tenant(projectId), capabilities,
      identityGeneration: authority.generation.identity, };
  }
  private async arm(projectId: string) {
    let authority = await currentAuthority({ via: 'prototype-driver', label });
    if (isDenial(authority)) {
      // Another controlled driver owns the process. Never replace its authority.
      if (authority.reason !== 'The prototype authority driver is not armed in this build.' && authority.code !== 'expired')
        fail('authority_in_use', authority.reason);
      enablePrototypeAuthority({ label, capabilities: ['project.read', 'work.submit', 'approval.decide'],
        expiresAt: new Date(Date.now() + 8 * 3600000).toISOString() });
      authority = await currentAuthority({ via: 'prototype-driver', label });
    }
    if (isDenial(authority)) fail('authorization_required', authority.reason);
    this.refs.set(projectId, refOf(authority));
    const id = this.id(projectId);
    if (!this.signing.has(id)) this.signing.set(id, fixtureCredentials(id));
  }
  async propose(projectId: string, input: unknown) {
    const request = connectionIntentSchema.parse(input);
    const questions: string[] = [];
    if (!/toast/i.test(request.text)) questions.push('This reviewed demo supports Toast menu availability. Choose Toast or review a separate connector candidate.');
    if (!/raleigh|three|3/i.test(request.text)) questions.push('Confirm the synthetic Raleigh group with three approved restaurants.');
    if (request.threshold === undefined) questions.push('Choose the reported numeric quantity threshold for a manager issue.');
    if (!request.serviceWindow) questions.push('Choose service days, hours and time zone.');
    return this.store.locked(async () => {
      const state = structuredClone(this.store.state(projectId)), data = this.plans(projectId);
      const plan: ConnectionPlan = { id: randomUUID(), projectId, request, questions,
        connectionId: this.id(projectId), tenantId: this.tenant(projectId), resources: TOAST_RESOURCES,
        connectorDigest: digest(toastManifest), baseDigest: digest(state.connections?.instances ?? []),
        expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), adopted: false };
      data.plans.push(plan); desktopConnectionsSchema.parse(data); state.desktopConnections = data;
      await this.store.persist(state);
      return { plan, digest: digest(plan) };
    });
  }
  async adopt(projectId: string, input: unknown) {
    const approval = exact.parse(input);
    const active = this.adoptions.get(projectId);
    if (active) {
      if (active.digest !== digest(approval)) fail('proposal_busy', 'Another connection proposal is being applied.');
      return active.work;
    }
    const work = this.adoptExact(projectId, approval).finally(() => this.adoptions.delete(projectId));
    this.adoptions.set(projectId, { digest: digest(approval), work });
    return work;
  }
  private async adoptExact(projectId: string, approval: z.infer<typeof exact>) {
    const plan = this.plans(projectId).plans.find((item) => item.id === approval.id);
    if (!plan) fail('proposal_missing', 'Review a connection proposal first.');
    // Replay remains an acknowledgement only. It never resurrects authority or a revoked connection.
    if (plan.adopted && digest({ ...plan, adopted: false }) === approval.digest) return { connectionId: plan.connectionId, replay: true };
    const receipt = this.plans(projectId).admissions.find((item) => item.planId === plan.id);
    if (plan.questions.length || digest(plan) !== approval.digest || Date.now() >= Date.parse(plan.expiresAt) ||
      plan.connectorDigest !== digest(toastManifest) || (receipt ? receipt.digest !== approval.digest :
      plan.baseDigest !== digest(this.store.state(projectId).connections?.instances ?? [])))
      fail('proposal_conflict', 'Review the exact complete proposal again; it expired or its base changed.');
    await this.arm(projectId);
    await this.store.locked(async () => {
      const state = structuredClone(this.store.state(projectId)), data = this.plans(projectId);
      if (!data.admissions.some((item) => item.planId === plan.id)) {
        if (plan.baseDigest !== digest(state.connections?.instances ?? [])) fail('proposal_conflict', 'The connection base changed before admission.');
        data.admissions.push({ planId: plan.id, digest: approval.digest, state: 'pending' });
      }
      state.desktopConnections = data; await this.store.persist(state);
    });
    const expectedConnection = connectionSchema.parse({
        id: plan.connectionId, connectorId: 'toast', version: toastManifest.version,
        manifestDigest: plan.connectorDigest, tenantId: plan.tenantId, projectId,
        name: 'Raleigh restaurant group / synthetic', resources: plan.resources, vendorScopes: ['stock:read'],
        operations: ['get_item_availability'], mode: 'fixture', status: 'connected', generation: 1,
        staleAfterMs: 300000, lastEventAt: null, lastReconciledAt: null, problem: null,
      });
    const installed = this.service.snapshot(projectId).connections.instances.find((item) => item.id === plan.connectionId);
    if (installed && (installed.generation !== 1 || installed.status !== 'connected' ||
      authorityShape(installed) !== authorityShape(expectedConnection)))
      fail('proposal_conflict', 'Connection authority changed during the pending adoption. Review a new proposal.');
    if (!installed) await this.service.install(projectId, expectedConnection);
    const monitor = await this.service.proposeMonitor(projectId, plan.connectionId, plan.request.threshold!, plan.request.serviceWindow!);
    await this.service.activate(projectId, plan.connectionId, monitor.proposal.id, monitor.digest);
    const guidance = await this.service.proposeGuidance(projectId, plan.connectionId);
    await this.service.activate(projectId, plan.connectionId, guidance.proposal.id, guidance.digest);
    await this.store.locked(async () => {
      const state = structuredClone(this.store.state(projectId)), data = this.plans(projectId);
      data.plans.find((item) => item.id === plan.id)!.adopted = true; state.desktopConnections = data;
      data.admissions.find((item) => item.planId === plan.id)!.state = 'complete';
      await this.store.persist(state);
    });
    return { connectionId: plan.connectionId, replay: false };
  }
  async resume(projectId: string) {
    const connection = this.service.snapshot(projectId).connections.instances.find((item) => item.id === this.id(projectId));
    if (!connection) fail('unknown_connection', 'Approve a connection proposal first.');
    const previousRef = this.refs.get(projectId);
    await this.arm(projectId);
    if (connection.status !== 'connected') return this.service.control(projectId, connection.id, 'connected');
    if (previousRef && digest(previousRef) === digest(this.refs.get(projectId))) return connection;
    return this.service.resumeAuthorized(projectId, connection.id);
  }
  async snapshot(projectId: string): Promise<DesktopConnectionsView> {
    const plans = this.plans(projectId).plans.map((plan) => ({ plan, digest: digest(plan) }));
    const state = this.service.snapshot(projectId);
    if (!state.connections.instances.length) return { mode: 'fixture-only', plans, connections: [], authorized: false };
    try { await this.principal(projectId); }
    catch (error) {
      if (!(error instanceof HarnessError)) throw error;
      return { mode: 'fixture-only', plans, authorized: false,
        connections: state.connections.instances.map(({ id, name }) => ({ connection: { id, name }, health: 'authorization-required' })) };
    }
    return { mode: 'fixture-only', authorized: true, plans,
      connections: await Promise.all(state.connections.instances.map((item) => this.service.status(projectId, item.id))),
      observations: Object.values(state.connections.observations), inbox: state.connections.inbox,
      rules: state.rules, contextEvidence: state.connections.contextEvidence,
      tasks: state.tasks.filter((task) => Object.values(state.connections.issues).includes(task.id)),
      runs: (await this.host.list(projectId)).filter((run) => run.capabilityId.startsWith('connection-'))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      error: this.errors.get(projectId) ?? null };
  }
  async read(projectId: string, model: boolean) {
    await this.principal(projectId);
    const connectionId = this.id(projectId), input = { resources: TOAST_RESOURCES.map((item) => item.id), itemIds: TOAST_ITEMS };
    const runId = await this.service.admit(projectId, connectionId, input.resources, ['get_item_availability']);
    if (model) {
      await this.service.runFixtureAgent(runId, connectionFixtureModel(input, undefined, { connectionId, erroneous: true }),
        'Report the selected menu item availability across the approved three restaurants.');
    } else {
      const result = await this.service.invoke(runId, 'get_item_availability', input);
      await this.service.finishRead(runId, result);
    }
    return { runId, assurance: 'scripted-fixture-only' };
  }
  drain(projectId: string) {
    // Isolated package crash driver: prove durable HTTP acknowledgement before
    // any Runtime admission. This cannot be enabled outside explicit test mode.
    if (process.env.DIOMEDES_TEST_MODE === '1' && process.env.DIOMEDES_TEST_HOLD_TRIAGE === '1') return;
    const pending = this.service.drain(projectId).catch((error: unknown) => {
      this.errors.set(projectId, error instanceof Error ? error.message : 'Event processing failed.');
    }).finally(() => this.drains.delete(pending));
    this.drains.add(pending);
  }
  async event(projectId: string, input: unknown, loopbackPort?: number) {
    const event = z.strictObject({ id: z.uuid(), quantity: z.number().min(1).max(5),
      at: z.string().datetime().optional() }).parse(input);
    await this.principal(projectId);
    const at = event.at ?? new Date().toISOString(), id = this.id(projectId);
    const raw = fixtureStockEvent(at, event.quantity, event.id);
    const signer = this.signing.get(id) ?? fail('authorization_required', 'Enable the synthetic subscription in this app session.');
    if (loopbackPort !== undefined) {
      if (!Number.isInteger(loopbackPort) || loopbackPort < 1 || loopbackPort > 65535)
        fail('invalid_port', 'The local ingress port is unavailable.');
      // Explicit synthetic source driver sends through the actual raw-body HTTP
      // ingress. No client-provided URL, destination, key or subscription is used.
      const response = await fetch(`http://127.0.0.1:${loopbackPort}/vendor/connections/${encodeURIComponent(projectId)}/${id}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', 'Toast-Signature': signer.sign(raw, at),
          'Toast-Restaurant-External-ID': TOAST_RESOURCES[0].id }, body: raw,
      });
      const result: unknown = await response.json();
      if (response.status !== 202) fail('ingress_refused', 'The signed local ingress refused the synthetic event.');
      return z.json().parse(result);
    }
    const accepted = await this.service.accept(projectId, id, raw, signer.sign(raw, at), TOAST_RESOURCES[0].id);
    return accepted;
  }
  async writeProbe(projectId: string) {
    if (process.env.DIOMEDES_TEST_MODE !== '1') fail('test_only', 'The write probe is available only in an isolated test profile.');
    const principal = await this.principal(projectId), connectionId = this.id(projectId);
    const runId = await this.service.admit(projectId, connectionId, [TOAST_RESOURCES[0].id], ['get_item_availability']);
    const run = await this.host.runs.get(runId), tool = this.host.tools.get('fixture_write_probe');
    const before = this.writeDispatches;
    let denied: string | null = null;
    try {
      await this.host.runs.step(runId, run.owner!, { id: 'prohibited-write', version: tool.version,
        kind: 'tool', name: tool.name, effect: tool.effect, permission: tool.permission,
        destination: tool.destination, input: {}, cost: 1 }, (context) => tool.execute({ ...context, input: {} }), principal);
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error;
      denied = error.code;
    }
    const result = { registered: this.host.tools.has(tool.name), denied, dispatches: this.writeDispatches - before };
    if (!denied || result.dispatches !== 0) fail('write_probe_failed', 'A prohibited test write reached dispatch.');
    await this.service.finishRead(runId, result);
    return { ...result, runId };
  }
  async close() { this.closed = true; await Promise.all([...this.drains]); this.refs.clear(); this.signing.clear(); }
  mountRaw(app: Express) {
    app.post('/vendor/connections/:projectId/:connectionId', express.raw({ type: 'application/json', limit: '32kb' }),
      this.route(async (req, res) => {
        if (!Buffer.isBuffer(req.body)) fail('raw_body_required', 'A signed raw JSON body is required.');
        const projectId = String(req.params.projectId);
        const result = await this.service.accept(projectId, String(req.params.connectionId), req.body.toString('utf8'),
          String(req.headers['toast-signature'] ?? ''), String(req.headers['toast-restaurant-external-id'] ?? ''));
        res.status(202).json(result); this.drain(projectId);
      }));
  }
  private route(action: (req: Request, res: Response) => Promise<unknown>) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try { const result = await action(req, res); if (!res.headersSent) res.json(result); }
      catch (error) {
        if (error instanceof HarnessError) res.status(409).json({ error: error.message, code: error.code });
        else if (error instanceof z.ZodError) res.status(400).json({ error: 'The connection request does not match the reviewed schema.', issues: error.issues.map((item) => item.message) });
        else next(error);
      }
    };
  }
  mount(app: Express) {
    const base = '/api/projects/:id/connections', project = (req: Request) => String(req.params.id);
    app.get(base, this.route(async (req) => this.snapshot(project(req))));
    app.get(`${base}/compiler`, this.route(async (req) => listCompiledConnectionDemoCandidates().map((preview) => ({
      ...preview, previewDigest: digest(preview),
      installed: this.service.snapshot(project(req)).connections.instances.some((item) => item.connectorId === preview.name),
    }))));
    app.post(`${base}/compiler/activate`, this.route(async (req) => {
      const input = z.strictObject({ name: z.enum(['library', 'helpdesk']), previewDigest: z.string() }).parse(req.body);
      const preview = listCompiledConnectionDemoCandidates().find((item) => item.name === input.name)!;
      if (digest(preview) !== input.previewDigest) fail('candidate_changed', 'Review the exact candidate, source and fixture mapping again.');
      const projectId = project(req);
      const id = compiledConnectionDemoId(projectId, this.tenant(projectId), input.name);
      const installed = this.service.snapshot(projectId).connections.instances.find((item) => item.id === id);
      if (installed) {
        const connector = compiledConnectionDemoConnectors.find((item) => item.manifest.id === input.name)!;
        const expected = { ...installed, id, connectorId: input.name, version: connector.manifest.version,
          manifestDigest: digest(connector.manifest), tenantId: this.tenant(projectId), projectId,
          resources: preview.resources, vendorScopes: [], operations: connector.manifest.operations.map((item) => item.id),
          mode: 'fixture' as const };
        if (authorityShape(installed) !== authorityShape(expected)) fail('candidate_changed', 'The saved fixture scope differs from the approved candidate.');
        return { id, replay: true }; // Never reactivate a disconnected instance.
      }
      await this.arm(projectId);
      return activateCompiledConnectionDemo(this.service, { name: input.name, expectedCandidateDigest: preview.candidateDigest,
        projectId, tenantId: this.tenant(projectId) });
    }));
    app.post(`${base}/compiler/run`, this.route(async (req) => {
      const { name } = z.strictObject({ name: z.enum(['library', 'helpdesk']) }).parse(req.body);
      const projectId = project(req); await this.principal(projectId);
      return runCompiledConnectionDemoRoundTrip(this.service, { name, projectId,
        connectionId: compiledConnectionDemoId(projectId, this.tenant(projectId), name) });
    }));
    app.post(`${base}/propose`, this.route(async (req) => this.propose(project(req), req.body)));
    app.post(`${base}/adopt`, this.route(async (req) => this.adopt(project(req), req.body)));
    app.post(`${base}/resume`, this.route(async (req) => this.resume(project(req))));
    app.post(`${base}/read`, this.route(async (req) => { z.strictObject({}).parse(req.body); return this.read(project(req), false); }));
    app.post(`${base}/investigate`, this.route(async (req) => { z.strictObject({}).parse(req.body); return this.read(project(req), true); }));
    app.post(`${base}/control`, this.route(async (req) => {
      const { status } = z.strictObject({ status: z.enum(['paused', 'disconnected']) }).parse(req.body);
      return this.service.control(project(req), this.id(project(req)), status);
    }));
    app.post(`${base}/event`, this.route(async (req, res) => {
      const result = await this.event(project(req), req.body, req.socket.localPort); res.status(202).json(result);
    }));
    app.post(`${base}/rules/revise`, this.route(async (req) => {
      const input = z.strictObject({ rollbackVersion: z.number().int().positive().optional() }).parse(req.body);
      return this.service.proposeRevision(project(req), this.id(project(req)), input.rollbackVersion);
    }));
    app.post(`${base}/rules/adopt`, this.route(async (req) => {
      const input = exact.parse(req.body); return this.service.activate(project(req), this.id(project(req)), input.id, input.digest);
    }));
    app.post(`${base}/rules/disable`, this.route(async (req) => {
      const { id } = z.strictObject({ id: z.string().max(80) }).parse(req.body);
      await this.service.disableRule(project(req), this.id(project(req)), id); return { disabled: true };
    }));
    app.post(`${base}/proof/write-denial`, this.route(async (req) => this.writeProbe(project(req))));
  }
}
