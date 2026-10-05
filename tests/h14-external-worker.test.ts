/**
 * S2 of subscription-aware orchestration: an H14 worker on the person's own installed coding
 * tool (Claude Code, Codex or OpenCode) under a Diomedes lead.
 *
 * The adapter tests drive `externalWorkerAdapter` against a scripted engine port. The host tests
 * run the real app, Store, RunService, H14 team port and handoff ledger with a stub model-API
 * lead (`fixtures/team-loop-stub.ts`) and a scripted engine port standing in for the installed
 * program. Nothing here reaches a provider.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { LoopModelRoutes } from '../server/harness/capabilities/native-loop.js';
import { loopEgressAuthorizer } from '../server/harness/capabilities/native-loop.js';
import { EXTERNAL_WORKER_INSTRUCTIONS } from '../server/harness/capabilities/team-loop.js';
import {
  EXTERNAL_WORKER_ANSWER_CHARS,
  ExternalWorkerGate,
  externalWorkerAdapter,
  type ExternalWorkerPort,
  type ExternalWorkerReply,
  type ExternalWorkerTurn,
} from '../server/harness/external-worker.js';
import { fundingForRoute, workerRowPayerOf } from '../shared/funding-source.js';
import { TEAM_WORKER_CAPABILITY, usageOf, type TeamLeadView } from '../shared/team-delegation.js';
import type { HarnessRun, ModelRequest } from '../shared/harness.js';
import type { LoopOutcome, LoopView } from '../shared/native-loop.js';
import type { Session } from '../shared/types.js';
import type { ControlReceipt } from '../shared/work-control.js';
import { TEAM_STUB_ACCOUNT_ROUTE, TEAM_STUB_MODEL, teamRoutes, toolResults } from './fixtures/team-loop-stub.js';

const CLAUDE_ACCOUNT = 'claude-code:claude.ai';
const DELIVERY = 'Delivered 94 napkins and 40 tablecloths. Six napkins short.\n';
const ORDER = 'Order 1182: 100 napkins, 40 tablecloths.\n';

interface PortLog {
  admits: { route: string; model: string | null; accountRoute: string | null }[];
  sends: (ExternalWorkerTurn & { route: string })[];
}

function scriptedPort(
  reply: (turn: ExternalWorkerTurn) => Promise<ExternalWorkerReply> | ExternalWorkerReply = () => ({
    text: 'Six napkins are short.',
    model: 'claude-reported',
    version: '2.1.252',
  }),
  admit?: () => void,
) {
  const log: PortLog = { admits: [], sends: [] };
  const port: ExternalWorkerPort = {
    async admit(route, input) {
      log.admits.push({ route, model: input.model, accountRoute: input.accountRoute });
      admit?.();
      return { route, model: input.model ?? 'claude-test', accountRoute: input.accountRoute ?? CLAUDE_ACCOUNT, version: '2.1.252' };
    },
    async send(route, _admission, turn) {
      log.sends.push({ ...turn, route });
      return reply(turn);
    },
  };
  return { port, log };
}

const request = (text: string, tools: ModelRequest['tools'] = []): ModelRequest => ({
  runId: 'child-1',
  capabilityId: TEAM_WORKER_CAPABILITY,
  messages: [{ role: 'user', text }],
  tools,
  transcript: null,
});

describe('the external worker adapter', () => {
  const spec = (port: ExternalWorkerPort, extra: Partial<Parameters<typeof externalWorkerAdapter>[1]> = {}) =>
    externalWorkerAdapter(port, {
      route: 'claude-code',
      projectId: 'p1',
      runId: 'child-1',
      model: 'claude-test',
      accountRoute: CLAUDE_ACCOUNT,
      instructions: EXTERNAL_WORKER_INSTRUCTIONS,
      documents: async () => [{ path: 'delivery.md', text: DELIVERY }],
      stop: new AbortController().signal,
      gate: new ExternalWorkerGate(),
      ...extra,
    });

  test('one checked turn goes out with its files and comes back as the final answer with its reported model', async () => {
    const { port, log } = scriptedPort();
    const adapter = await spec(port);
    expect(adapter).toMatchObject({ id: 'claude-code', version: '2.1.252', destination: 'external' });
    expect(adapter.capabilities()).toMatchObject({ toolCalls: 'unsupported', filesystemWrites: 'unsupported' });
    const call = request('What is short in the delivery?');
    await adapter.validatePrepared!(call);
    const result = await adapter.complete(call, new AbortController().signal);
    expect(result.response).toEqual({ type: 'final', text: 'Six napkins are short.' });
    expect(result.transcript).toMatchObject({ providerId: 'claude-code', modelId: 'claude-reported', lineageId: 'child-1' });
    expect(result.usage).toBeNull();
    expect(log.sends).toHaveLength(1);
    expect(log.sends[0]).toMatchObject({
      route: 'claude-code',
      projectId: 'p1',
      threadId: 'team-worker-child-1',
      prompt: 'What is short in the delivery?',
      documents: [{ path: 'delivery.md', text: DELIVERY }],
      instructions: EXTERNAL_WORKER_INSTRUCTIONS,
    });
  });

  test('a refused admission fails the check before the step, and nothing is sent', async () => {
    const port: ExternalWorkerPort = {
      admit: async () => {
        throw new Error('Sign in to Claude Code with your Claude account first.');
      },
      send: vi.fn(),
    };
    const adapter = await spec(port);
    await expect(adapter.validatePrepared!(request('Anything'))).rejects.toThrow('Sign in to Claude Code with your Claude account first.');
    expect(port.send).not.toHaveBeenCalled();
  });

  test('a changed model or account refuses the worker', async () => {
    const { port, log } = scriptedPort();
    // The engine now reports the setup it has, whatever the child was admitted with.
    const current: ExternalWorkerPort = {
      ...port,
      admit: async (route) => ({ route, model: 'claude-test', accountRoute: CLAUDE_ACCOUNT, version: '2.1.252' }),
    };
    for (const changed of [{ model: 'a-different-model' }, { accountRoute: 'claude-code:another-account' }]) {
      const adapter = await spec(current, changed);
      await expect(adapter.validatePrepared!(request('Anything'))).rejects.toThrow(
        'Claude Code is set up differently from when this worker was admitted. Check it in AI setup, then retry.',
      );
    }
    expect(log.sends).toHaveLength(0);
  });

  test('another account signed in to the same engine refuses the worker before its turn goes out', async () => {
    const { port, log } = scriptedPort();
    let signedIn = 'openai:chatgpt:first';
    const codex: ExternalWorkerPort = {
      ...port,
      admit: async (route, input) => ({
        route,
        model: input.model ?? 'gpt-test',
        accountRoute: 'codex:chatgpt',
        version: '0.130.0',
        accountDigest: signedIn,
      }),
    };
    const pinned = { route: 'codex' as const, model: 'gpt-test', accountRoute: 'codex:chatgpt', accountDigest: 'openai:chatgpt:first' };
    const same = await spec(codex, pinned);
    await same.validatePrepared!(request('Anything'));
    await same.complete(request('Anything'), new AbortController().signal);
    expect(log.sends).toHaveLength(1);
    signedIn = 'openai:chatgpt:second';
    const switched = await spec(codex, pinned);
    await expect(switched.validatePrepared!(request('Anything'))).rejects.toThrow(
      "A different account is signed in to Codex than when this worker was admitted, so its turn wasn't sent. Retry to send it under the account signed in now.",
    );
    expect(log.sends).toHaveLength(1);
  });

  test('more than one turn can carry is refused before sending, not cut', async () => {
    const { port, log } = scriptedPort();
    const adapter = await spec(port, { documents: async () => [{ path: 'big.md', text: 'x'.repeat(170_000) }] });
    await expect(adapter.validatePrepared!(request('Summarise it'))).rejects.toThrow(/more than 160 KB/);
    expect(log.sends).toHaveLength(0);
  });

  test('a worker is never offered tools', async () => {
    const { port } = scriptedPort();
    const adapter = await spec(port);
    const tools = [{ name: 'read_project_file', description: 'Read', inputSchema: {} }] as unknown as ModelRequest['tools'];
    await expect(adapter.validatePrepared!(request('Read it', tools))).rejects.toThrow(/tools off/);
  });

  test('an unchecked turn is not sent', async () => {
    const { port, log } = scriptedPort();
    const adapter = await spec(port);
    await expect(adapter.complete(request('Never checked'), new AbortController().signal)).rejects.toThrow(/not checked/);
    expect(log.sends).toHaveLength(0);
  });

  test('an answer longer than a lead takes is kept and refused, not cut', async () => {
    const { port } = scriptedPort();
    const adapter = await spec(port);
    const inspection = await adapter.inspect!(request('Long'), 'x'.repeat(EXTERNAL_WORKER_ANSWER_CHARS + 1), new AbortController().signal);
    expect(inspection.action).toBe('refuse');
    expect(inspection.message).toMatch(/more than 48,000 characters/);
    expect((await adapter.inspect!(request('Short'), 'Fine.', new AbortController().signal)).action).toBe('verified');
  });

  test('admission is read again once it is older than the window around one step', async () => {
    const { port, log } = scriptedPort();
    let clock = 0;
    const adapter = await spec(port, { now: () => clock });
    expect(log.admits).toHaveLength(1);
    await adapter.validatePrepared!(request('First'));
    await adapter.validatePrepared!(request('First'));
    expect(log.admits).toHaveLength(1);
    clock = 31_000;
    await adapter.validatePrepared!(request('First'));
    expect(log.admits).toHaveLength(2);
  });
});

describe('one worker turn per engine account', () => {
  test('a second turn on the same account waits for the first; another account does not', async () => {
    const gate = new ExternalWorkerGate();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = gate.run('claude-code:a', new AbortController().signal, async () => {
      order.push('first start');
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push('first end');
    });
    const second = gate.run('claude-code:a', new AbortController().signal, async () => {
      order.push('second start');
    });
    const other = gate.run('claude-code:b', new AbortController().signal, async () => {
      order.push('other start');
    });
    await other;
    await vi.waitFor(() => expect(order).toContain('first start'));
    expect(order).not.toContain('second start');
    releaseFirst();
    await Promise.all([first, second]);
    expect(order.indexOf('second start')).toBeGreaterThan(order.indexOf('first end'));
    await vi.waitFor(() => expect(gate.busy('claude-code:a')).toBe(false));
  });

  test('a turn stopped while it waits leaves the queue, and the next still waits for the turn in flight', async () => {
    const gate = new ExternalWorkerGate();
    const order: string[] = [];
    let release!: () => void;
    const first = gate.run('codex:x', new AbortController().signal, async () => {
      order.push('first start');
      await new Promise<void>((resolve) => (release = resolve));
      order.push('first end');
    });
    const stop = new AbortController();
    const waiting = gate.run('codex:x', stop.signal, async () => {
      order.push('stopped start');
    });
    stop.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    const third = gate.run('codex:x', new AbortController().signal, async () => {
      order.push('third start');
      return 'third';
    });
    await vi.waitFor(() => expect(order).toContain('first start'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first start']);
    release();
    await first;
    await expect(third).resolves.toBe('third');
    expect(order).toEqual(['first start', 'first end', 'third start']);
  });
});

describe('funding labels and usage', () => {
  test('each route reads as its funding source and worker row label', () => {
    expect(fundingForRoute('claude-code', { business: false, accountRoute: CLAUDE_ACCOUNT })).toEqual({
      kind: 'person-subscription',
      engine: 'claude-code',
      accountRoute: CLAUDE_ACCOUNT,
    });
    expect(fundingForRoute('nectovia', { business: true })).toEqual({ kind: 'nectovia-credits' });
    expect(fundingForRoute('google-vertex', { business: false })).toEqual({ kind: 'person-key', route: 'google-vertex' });
    expect(fundingForRoute('google-vertex', { business: true })).toEqual({ kind: 'company-key', route: 'google-vertex' });
    expect(fundingForRoute('native-fixture', { business: false })).toEqual({ kind: 'local', route: 'native-fixture' });
    // The local model is a model-API route that runs on this computer: neither key pays for it.
    expect(fundingForRoute('bonsai', { business: true })).toEqual({ kind: 'local', route: 'bonsai' });
    expect(workerRowPayerOf('person-subscription')).toBe('your-subscription');
    expect(workerRowPayerOf('company-key')).toBe('your-key');
    expect(workerRowPayerOf('nectovia-credits')).toBe('nectovia-credits');
  });

  test('an engine that reports no tokens reads as unknown, never zero', () => {
    const steps = [{ intent: { kind: 'model' }, state: 'succeeded', output: { response: {}, usage: null } }] as unknown as HarnessRun['steps'];
    expect(usageOf({ steps }, 'claude-code')).toEqual({ tokens: null, confidence: 'unknown', source: 'not reported' });
    const reported = [{ intent: { kind: 'model' }, state: 'succeeded', output: { usage: { inputTokens: 900, outputTokens: 100 } } }] as unknown as HarnessRun['steps'];
    expect(usageOf({ steps: reported }, 'codex')).toEqual({ tokens: { total: 1000, input: 900, output: 100 }, confidence: 'reported', source: 'codex' });
  });
});

describe('egress for an external worker child', () => {
  const child = (route: string, accountRoute: string) =>
    ({ capabilityId: TEAM_WORKER_CAPABILITY, projectId: 'p1', input: { route, accountRoute } }) as unknown as HarnessRun;
  const send = { destination: 'external', kind: 'model' };

  test('Codex keeps no account route in Settings, so its ChatGPT default is the one checked', async () => {
    const authorize = loopEgressAuthorizer(() => ({ codex: true }));
    await expect(authorize(child('codex', 'codex:chatgpt'), send, 'dispatch')).resolves.toBeUndefined();
    await expect(authorize(child('codex', 'openai:api-key'), send, 'dispatch')).rejects.toThrow(/no longer selected/);
  });

  test('Claude Code must still be on and on the account the worker was admitted under', async () => {
    const authorize = loopEgressAuthorizer(() => ({ 'claude-code': true, 'claude-codeAccountRoute': CLAUDE_ACCOUNT }));
    await expect(authorize(child('claude-code', CLAUDE_ACCOUNT), send, 'dispatch')).resolves.toBeUndefined();
    const off = loopEgressAuthorizer(() => ({ 'claude-code': false, 'claude-codeAccountRoute': CLAUDE_ACCOUNT }));
    await expect(off(child('claude-code', CLAUDE_ACCOUNT), send, 'dispatch')).rejects.toThrow(/not switched on/);
  });
});

// --- through the real host ---------------------------------------------------------------------

let root: string, projectId: string, taskId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const store = (): Store => app.locals.store;
const host = (): HarnessHost => app.locals.harness;
const state = () => store().state(projectId);

async function open(routes: LoopModelRoutes, externalWorkers: ExternalWorkerPort | null) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
    loopModelRoutes: routes,
    externalWorkers,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  const closingApp = app,
    closingServer = server;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => closingServer.close((error) => (error ? reject(error) : resolve())));
  }
}
async function call<T>(route: string, method = 'GET', body?: unknown, base = `/api/projects/${projectId}`) {
  const response = await fetch(`${url}${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
async function connect(routes: string[] = ['google-vertex', 'claude-code']) {
  await store().saveSettings({
    ...store().settings,
    services: {
      ...(store().settings.services ?? {}),
      'google-vertex': true,
      'google-vertexModel': TEAM_STUB_MODEL,
      'google-vertexAccountRoute': TEAM_STUB_ACCOUNT_ROUTE,
      'claude-code': true,
      'claude-codeModel': 'claude-test',
      'claude-codeAccountRoute': CLAUDE_ACCOUNT,
    },
  });
  const shared = await call('/cloud-sharing', 'PUT', {
    expectedVersion: state().cloudSharing?.version ?? 0,
    routes,
    documents: ['order.md', 'delivery.md'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  expect(shared.status, JSON.stringify(shared.data)).toBe(200);
}
const startBody = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  commandId: `external-${Math.random().toString(36).slice(2)}`,
  taskId,
  goal: 'Find what is short in the linen delivery.',
  route: 'google-vertex',
  consent: true,
  sources: ['order.md', 'delivery.md'],
  team: { worker: { route: 'claude-code' } },
  ...overrides,
});
const loop = (runId: string) => call<{ view: LoopView; outcome: LoopOutcome; team: TeamLeadView | null }>(`/loop/runs/${runId}`);
async function untilRun(runId: string, expected: HarnessRun['state']) {
  await vi.waitFor(async () => expect((await host().get(projectId, runId)).state).toBe(expected), { timeout: 15_000 });
  await host().bridge.flush();
  return host().get(projectId, runId);
}
const ledgerLines = async () =>
  (await fs.readFile(path.join(root, 'data', 'projects', projectId, 'handoffs.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** A stub lead: plan, hand one task to the worker, then a final claim. */
const leadOnce = () =>
  teamRoutes({
    loop: (request) => {
      if (!request.tools.length) return { response: { type: 'final', text: '1. Ask the worker.\n2. Report.' } };
      if (!toolResults(request).length)
        return {
          response: {
            type: 'tool',
            name: 'assign_workers',
            input: { tasks: [{ task: 'What is short in the delivery?', files: ['delivery.md'] }] },
          },
        };
      return { response: { type: 'final', text: 'The worker found six napkins short.' } };
    },
  });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h14-external-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

async function seed(port: ExternalWorkerPort | null, routes: LoopModelRoutes = leadOnce()) {
  await open(routes, port);
  const project = await store().locked(() => store().createProject('Linen orders'));
  projectId = project.id;
  await fs.writeFile(path.join(project.folder, 'order.md'), ORDER);
  await fs.writeFile(path.join(project.folder, 'delivery.md'), DELIVERY);
  taskId = await store().locked(async () => {
    const task = store().createTask(state(), { name: 'Check the linen delivery' });
    await store().persist(state());
    return task.id;
  });
}

describe('a lead with a worker on the person\'s own Claude Code', () => {
  test('the worker answers one turn with its tools off, funded by the person\'s subscription, and the lead uses the answer', async () => {
    const { port, log } = scriptedPort();
    await seed(port);
    await connect();
    const started = await call<{ runId: string; session: Session }>('/loop/start', 'POST', startBody());
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    await untilRun(started.data.runId, 'completed');
    const { data } = await loop(started.data.runId);
    const team = data.team!;
    expect(team.worker).toMatchObject({ route: 'claude-code', model: 'claude-test', accountRoute: CLAUDE_ACCOUNT, execution: 'external-proposal' });
    expect(team.worker.budget.turns).toBe(1);
    expect(team.limits.concurrentWorkers).toBe(1);
    expect(team.workers).toHaveLength(1);
    expect(team.workers[0]).toMatchObject({
      outcome: 'completed',
      text: 'Six napkins are short.',
      route: 'claude-code',
      execution: 'external-proposal',
      payer: 'person-subscription',
      usage: { tokens: null, confidence: 'unknown' },
    });
    expect(team.workers[0].models).toEqual([{ engine: 'claude-code', reported: 'claude-reported', calls: 1 }]);
    // One turn, with the files attached and the worker's own instructions; never the lead's tools.
    expect(log.sends).toHaveLength(1);
    expect(log.sends[0].prompt).toBe('What is short in the delivery?\n\nAttached files: delivery.md.');
    expect(log.sends[0].documents).toEqual([{ path: 'delivery.md', text: DELIVERY }]);
    expect(log.sends[0].instructions.startsWith(EXTERNAL_WORKER_INSTRUCTIONS)).toBe(true);
    // The lead saw the answer as its tool result.
    expect(JSON.stringify(data.view.turns.map((turn) => turn.observation))).toContain('Six napkins are short.');
    // The ledger records how the child worked and who funded it.
    const opened = (await ledgerLines()).find((event) => event.kind === 'opened')!;
    expect(opened).toMatchObject({ route: 'claude-code', execution: 'external-proposal', payer: 'person-subscription' });
    // The child run holds no tool at all.
    const child = await host().get(projectId, String(opened.childRunId));
    expect(child.capabilityTools).toEqual([]);
  });

  test('without the engines attached the worker is refused at start and nothing runs', async () => {
    await seed(null);
    await connect();
    const refused = await call<{ error: string; code: string }>('/loop/start', 'POST', startBody());
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe('external_worker_unavailable');
    expect(refused.data.error).toBe("Claude Code can't work for a team on this computer.");
    expect(await host().list(projectId)).toEqual([]);
  });

  test('an external engine can be a worker, never an advisor', async () => {
    const { port } = scriptedPort();
    await seed(port);
    await connect();
    const refused = await call<{ error: string; code: string }>(
      '/loop/start',
      'POST',
      startBody({ team: { worker: { route: 'claude-code' }, advisor: { route: 'claude-code' } } }),
    );
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe('team_route_unsupported');
    expect(refused.data.error).toBe('Claude Code can be a worker on a team, not an advisor.');
  });

  test('a saved profile on Claude Code can run a team\'s worker, never a delegate', async () => {
    const { port, log } = scriptedPort();
    await seed(port);
    await connect();
    const created = await call<{ profileId: string }>(
      '',
      'POST',
      { name: 'My Claude Code', engine: 'claude-code', model: 'claude-test', effort: null, agentId: 'auto', rules: [] },
      '/api/agent-profiles',
    );
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const profileId = created.data.profileId;

    const delegated = await call<{ error: string; code: string }>(
      '/loop/start',
      'POST',
      startBody({ team: undefined, delegate: { profileId } }),
    );
    expect(delegated.status).toBe(409);
    expect(delegated.data.code).toBe('team_role_refused');
    expect(delegated.data.error).toMatch(/keeps its own loop/);
    expect(log.admits).toHaveLength(0);

    const started = await call<{ runId: string }>('/loop/start', 'POST', startBody({ team: { worker: { profileId } } }));
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    await untilRun(started.data.runId, 'completed');
    const team = (await loop(started.data.runId)).data.team!;
    expect(team.worker).toMatchObject({ route: 'claude-code', model: 'claude-test', profile: { profileId, revision: 1 } });
    expect(team.workers[0]).toMatchObject({ outcome: 'completed', text: 'Six napkins are short.' });
  });

  test('a Nectovia lead still takes no team', async () => {
    const { port, log } = scriptedPort();
    await seed(port);
    await connect();
    const refused = await call<{ code: string }>('/loop/start', 'POST', startBody({ route: 'nectovia' }));
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe('loop_route_unsupported');
    expect(log.admits).toHaveLength(0);
  });

  test('files not shared with the worker\'s engine refuse the start', async () => {
    const { port, log } = scriptedPort();
    await seed(port);
    await connect(['google-vertex']);
    const refused = await call<{ code: string }>('/loop/start', 'POST', startBody());
    expect(refused.status).toBe(403);
    expect(refused.data.code).toBe('cloud_sharing_denied');
    expect(log.sends).toHaveLength(0);
  });

  /** Start the stub lead, wait for it to stop on its worker, restart the host, then retry the lead through H08. */
  async function failThenRetry(port: ExternalWorkerPort) {
    const first = await call<{ runId: string; session: Session }>('/loop/start', 'POST', startBody());
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    await untilRun(first.data.runId, 'cancelled');
    const before = (await loop(first.data.runId)).data.team!;
    // A restart: a new host over the same data folder reads the parked record back, cold.
    await close();
    await open(leadOnce(), port);
    const retried = await call<{ receipt: ControlReceipt }>('/controls', 'POST', {
      protocolVersion: 1,
      commandId: 'retry-external-lead',
      taskId,
      control: 'retry',
      sessionId: first.data.session.id,
    });
    expect(retried.status, JSON.stringify(retried.data)).toBe(200);
    expect(retried.data.receipt.outcome, JSON.stringify(retried.data.receipt)).toBe('applied');
    const nextSession = retried.data.receipt.result.sessionId!;
    const nextRun = (await host().list(projectId)).find((run) => run.sessionId === nextSession)!;
    await untilRun(nextRun.id, 'completed');
    return { before, after: (await loop(nextRun.id)).data.team! };
  }
  const NOT_AGAIN = "Its earlier turn on Claude Code may have run, so it wasn't sent again. Start a new task to ask again.";

  test('a turn that ended without an answer after it may have gone out is never sent again, even after a restart', async () => {
    const { port, log } = scriptedPort(() => {
      throw new Error('The Claude Code process ended mid-turn.');
    });
    await seed(port);
    await connect();
    const { before, after } = await failThenRetry(port);
    expect(before.workers.map((worker) => worker.outcome)).toEqual(['died']);
    expect(after.workers).toHaveLength(1);
    expect(after.workers[0]).toMatchObject({ outcome: 'refused', reason: NOT_AGAIN });
    // The person's quota was never spent a second time.
    expect(log.sends).toHaveLength(1);
  });

  test('an answer too long to take ran, so a retry does not send it again', async () => {
    const { port, log } = scriptedPort(() => ({ text: 'x'.repeat(EXTERNAL_WORKER_ANSWER_CHARS + 1), model: 'claude-reported', version: '2.1.252' }));
    await seed(port);
    await connect();
    const { before, after } = await failThenRetry(port);
    expect(before.workers[0]).toMatchObject({ outcome: 'failed' });
    expect(before.workers[0].reason).toMatch(/more than 48,000 characters/);
    expect(after.workers[0]).toMatchObject({ outcome: 'refused', reason: NOT_AGAIN });
    expect(log.sends).toHaveLength(1);
  });

  test('a worker stopped during its turn may have run, so a retry does not send it again', async () => {
    // The engine holds the turn until it is stopped, as a real one mid-answer would.
    const { port, log } = scriptedPort(
      (turn) =>
        new Promise<ExternalWorkerReply>((_resolve, reject) =>
          turn.signal.addEventListener('abort', () => reject(new Error('The Claude Code turn was stopped.')), { once: true }),
        ),
    );
    await seed(port);
    await connect();
    const first = await call<{ runId: string; session: Session }>('/loop/start', 'POST', startBody());
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    await vi.waitFor(() => expect(log.sends).toHaveLength(1), { timeout: 15_000 });
    const stopped = await call<Session>(`/work/${first.data.session.id}/stop`, 'POST', {});
    expect(stopped.status, JSON.stringify(stopped.data)).toBe(200);
    await untilRun(first.data.runId, 'cancelled');
    expect((await loop(first.data.runId)).data.team!.workers.map((worker) => worker.outcome)).toEqual(['stopped']);

    const retried = await call<{ receipt: ControlReceipt }>('/controls', 'POST', {
      protocolVersion: 1,
      commandId: 'retry-stopped-external-lead',
      taskId,
      control: 'retry',
      sessionId: first.data.session.id,
    });
    expect(retried.status, JSON.stringify(retried.data)).toBe(200);
    expect(retried.data.receipt.outcome, JSON.stringify(retried.data.receipt)).toBe('applied');
    const nextSession = retried.data.receipt.result.sessionId!;
    const nextRun = (await host().list(projectId)).find((run) => run.sessionId === nextSession)!;
    await untilRun(nextRun.id, 'completed');
    const after = (await loop(nextRun.id)).data.team!;
    expect(after.workers[0]).toMatchObject({ outcome: 'refused', reason: NOT_AGAIN });
    expect(log.sends).toHaveLength(1);
  });

  test('a worker refused before its turn sent nothing, so a retry runs it once the cause is fixed', async () => {
    const { port, log } = scriptedPort();
    await seed(port);
    await connect();
    const big = path.join(state().project.folder, 'delivery.md');
    await fs.writeFile(big, 'x'.repeat(170_000));
    const first = await call<{ runId: string; session: Session }>('/loop/start', 'POST', startBody());
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    await untilRun(first.data.runId, 'cancelled');
    const before = (await loop(first.data.runId)).data.team!;
    expect(before.workers[0]).toMatchObject({ outcome: 'failed' });
    expect(before.workers[0].reason).toMatch(/more than 160 KB/);
    expect(log.sends).toHaveLength(0);

    await fs.writeFile(big, DELIVERY);
    const retried = await call<{ receipt: ControlReceipt }>('/controls', 'POST', {
      protocolVersion: 1,
      commandId: 'retry-refused-external-lead',
      taskId,
      control: 'retry',
      sessionId: first.data.session.id,
    });
    expect(retried.status, JSON.stringify(retried.data)).toBe(200);
    expect(retried.data.receipt.outcome, JSON.stringify(retried.data.receipt)).toBe('applied');
    const nextSession = retried.data.receipt.result.sessionId!;
    const nextRun = (await host().list(projectId)).find((run) => run.sessionId === nextSession)!;
    await untilRun(nextRun.id, 'completed');
    const after = (await loop(nextRun.id)).data.team!;
    expect(after.workers[0]).toMatchObject({ outcome: 'completed', attempt: 2, text: 'Six napkins are short.' });
    expect(log.sends).toHaveLength(1);
  });
});
