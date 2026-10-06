/**
 * DIO-257: a team role on the local model is timed by its profile, not by a cloud role's fixed
 * minutes, and a child that is stopped (its wall time, or the person's Stop) has its call in flight
 * aborted at once, down to the local server's socket.
 *
 * The local server here is a real HTTP server on this computer: it answers the lead, holds a
 * child's call open after its first progress chunk, and notes when that call's socket closes. A
 * fixture host reports the profile running. Nothing here reaches a provider or a real local model,
 * and nothing here starts one.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { EngineService } from '../server/engines/service.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { Store } from '../server/store.js';
import type { HarnessRun } from '../shared/harness.js';
import { LOCAL_MODEL_ACCOUNT, parseLocalModelDescriptor, type LocalModelProfile } from '../shared/local-model.js';
import { TEAM_LIMITS, localRoleWallMs } from '../shared/team-delegation.js';
import type { Project, Session } from '../shared/types.js';
import { FixedLocalModel, fakeLocalHost, localAnswerStream, meadowDescriptor, MEADOW_FOLDER, MEADOW_MODEL } from './fixtures/local-model.js';

vi.setConfig({ testTimeout: 90_000 });

/** Meadow's Deep profile as the O2 run had it: medium answers in 8,192 tokens, xhigh in 12,288. */
const o2Deep = (): LocalModelProfile => {
  const raw = meadowDescriptor();
  return parseLocalModelDescriptor({ ...raw, profiles: { Deep: { ...raw.profiles.Deep, outputTokens: 12_288,
    effortBudgets: {
      medium: { thinking: true, reasoningTokens: 4_096, outputTokens: 8_192 },
      xhigh: { thinking: true, reasoningTokens: 8_192, outputTokens: 12_288 },
    } } } }, MEADOW_FOLDER).profiles[0];
};
const rated = (prefillTokensPerSecond: number, decodeTokensPerSecond: number): LocalModelProfile =>
  ({ ...o2Deep(), measuredRates: { occupiedContextTokens: 122_000, prefillTokensPerSecond, decodeTokensPerSecond } });

describe('a team role’s time on the local model (DIO-257)', () => {
  const [quick, deep] = parseLocalModelDescriptor(meadowDescriptor(), MEADOW_FOLDER).profiles;

  test('is its turns times the longest one local call may run, up to the team’s ceiling', () => {
    // Quick answers in 4,096 tokens: a call gets the two-minute floor, and three turns six minutes.
    expect(localRoleWallMs(quick, TEAM_LIMITS.advisor.turns)).toBe(3 * 120_000);
    // Deep answers in 32,768 tokens: fifteen minutes a call, so three turns stop at thirty minutes.
    expect(localRoleWallMs(deep, TEAM_LIMITS.advisor.turns)).toBe(TEAM_LIMITS.maxWallMs);
    // O2's Deep answers in up to 12,288 tokens: 5.625 minutes a call, at any effort while it has no rates.
    expect(localRoleWallMs(o2Deep(), 3)).toBe(3 * 337_500);
    expect(localRoleWallMs(o2Deep(), 3, 'xhigh')).toBe(3 * 337_500);
    // A cloud advisor keeps its fixed two minutes.
    expect(TEAM_LIMITS.advisor.wallMs).toBe(120_000);
  });

  test('follows measured rates at the role’s effort, over the call’s floor and under the team’s ceiling', () => {
    const slow = rated(1_000, 40);
    // At medium (a loop role's effort when none is pinned): 8,192 tokens after a prompt of up to 119,808.
    expect(localRoleWallMs(slow, 2)).toBe(2 * (Math.ceil(1_500 * (119_808 / 1_000 + 8_192 / 40)) + 30_000));
    // At xhigh: 12,288 tokens after a prompt of up to 115,712. A role pinned to no effort is sent at
    // the profile's default, here xhigh.
    const xhigh = 2 * (Math.ceil(1_500 * (115_712 / 1_000 + 12_288 / 40)) + 30_000);
    expect(localRoleWallMs(slow, 2, 'xhigh')).toBe(xhigh);
    expect(slow.defaultEffort).toBe('xhigh');
    expect(localRoleWallMs(slow, 2, null)).toBe(xhigh);
    // Rates faster than the floor keep the floor; rates this slow stop at the team's ceiling.
    expect(localRoleWallMs(rated(2_000, 60), 3)).toBe(3 * 337_500);
    expect(localRoleWallMs(rated(500, 20), 3)).toBe(TEAM_LIMITS.maxWallMs);
  });
});

// --- a child stopped in flight ------------------------------------------------------------------------

interface Held { at: number; closedAt: number | null }
let held: Held[];
/** What the lead asks for once it is offered its team's tools. */
let leadCall: [string, Record<string, unknown>];
let local: Server | undefined;
let root: string | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let listener: Server | undefined;
let base: string;
const host = (): HarnessHost => app!.locals.harness;
const store = (): Store => app!.locals.store;

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}
const json = (res: ServerResponse, value: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const stream = async (res: ServerResponse, answer: Response) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(await answer.text());
};

/** The local server: the lead plans, asks its team once, then answers; a child's call is held open. */
function localServer(): Promise<string> {
  local = http.createServer((req, res) => {
    void (async () => {
      const body = await bodyOf(req);
      if (req.url === '/apply-template') return json(res, { prompt: 'Fixture template' });
      if (req.url === '/tokenize') return json(res, { tokens: [1, 2, 3] });
      if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
      const tools = ((body.tools as { function: { name: string } }[] | undefined) ?? []).map((tool) => tool.function.name);
      const usage = { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 };
      const id = `local-${Date.now()}`;
      if (tools.length && !tools.includes('assign_workers') && !tools.includes('consult_advisor')) {
        // A child's call: its read starts and never ends, until the call's socket closes.
        const call: Held = { at: Date.now(), closedAt: null };
        held.push(call);
        res.on('close', () => { call.closedAt = Date.now(); });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id, model: MEADOW_MODEL, prompt_progress: { total: 40_000, cache: 0, processed: 512, time_ms: 100 },
          choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] })}\n\n`);
        return;
      }
      const answered = (body.messages as { role: string }[]).some((message) => message.role === 'tool');
      if (!tools.length || answered)
        return stream(res, localAnswerStream({ id, model: MEADOW_MODEL, usage, choices: [{ finish_reason: 'stop',
          message: { content: answered ? 'Done with what my team said.' : '1. Ask my team.\n2. Answer.' } }] }));
      return stream(res, localAnswerStream({ id, model: MEADOW_MODEL, usage, choices: [{ finish_reason: 'tool_calls',
        message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: leadCall[0], arguments: JSON.stringify(leadCall[1]) } }] } }] }));
    })().catch(() => res.destroy());
  });
  return new Promise((resolve) => local!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(local!.address() as AddressInfo).port}`)));
}

afterEach(async () => {
  vi.restoreAllMocks();
  // A call still held open ends first, so a test that failed before its stop closes at once.
  local?.closeAllConnections();
  if (listener) {
    const closing = listener;
    listener = undefined;
    try {
      await app!.locals.close();
    } finally {
      closing.closeAllConnections();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  }
  if (local) {
    const closing = local;
    local = undefined;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  app = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = undefined;
});

async function call<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}

/** The app over the local server's Quick profile, a project with one shared order, and a loop with `team`. */
async function start(team: Record<string, unknown>) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dio257-child-stop-'));
  held = [];
  const server = await localServer();
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    localModel: { host: fakeLocalHost({ state: 'ready', mode: 'Quick', model: MEADOW_MODEL, contextTokens: 16_384 }).host,
      source: new FixedLocalModel(meadowDescriptor(server), MEADOW_FOLDER) },
    automationTickMs: null,
  });
  listener = await new Promise<Server>((resolve) => {
    const opened = app!.listen(0, '127.0.0.1', () => resolve(opened));
  });
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const projectId = (await call<Project>('/projects', 'POST', { name: 'Linen orders' })).id;
  await fs.writeFile(path.join(store().state(projectId).project.folder, 'order.md'), 'Order 1182: 100 napkins.\n');
  const policy = await call<{ version: number }>(`/projects/${projectId}/cloud-sharing`);
  await call(`/projects/${projectId}/cloud-sharing`, 'PUT', { expectedVersion: policy.version, routes: ['bonsai'],
    documents: ['order.md'], shareConversationHistory: false, shareReviewPackets: false });
  const taskId = (await call<{ id: string }>(`/projects/${projectId}/tasks`, 'POST', { name: 'Check the order' })).id;
  const started = await call<{ runId: string; session: Session }>(`/projects/${projectId}/loop/start`, 'POST', {
    protocolVersion: 1, commandId: `dio257-${Date.now()}`, taskId, goal: 'Check the order.',
    route: 'bonsai', model: 'local:quick', accountRoute: LOCAL_MODEL_ACCOUNT, consent: true, sources: ['order.md'], team,
  });
  return { projectId, ...started };
}

/** The handoffs the lead opened, as its ledger recorded them. */
const opened = async (projectId: string) =>
  (await host().loop.ledger.read(projectId)).events.filter((event) => event.kind === 'opened') as unknown as
    { role: string; childRunId: string; budget: { wallMs: number | null } }[];

/** Waits until a run ends, and returns it. */
const ended = (projectId: string, runId: string): Promise<HarnessRun> => vi.waitFor(async () => {
  const run = await host().get(projectId, runId);
  if (!['completed', 'failed', 'cancelled', 'reconcile_required'].includes(run.state)) throw new Error(`The run is still ${run.state}.`);
  return run;
}, { timeout: 30_000, interval: 100 });

describe('a local child stopped in flight (DIO-257)', () => {
  test('at its wall time: its call’s socket closes then, even while its cancel waits to be written down', async () => {
    leadCall = ['assign_workers', { tasks: [{ task: 'Read order.md and count the napkins.', files: ['order.md'] }] }];
    const { projectId, runId } = await start({ worker: { budget: { wallMs: 2_000 } }, advisor: null });
    // Every cancel of a child waits eight seconds to be written down, as when its record is slow to save.
    const runs = host().runs;
    const original = runs.cancel.bind(runs);
    const queue = (runs as unknown as { serialize(id: string, action: () => Promise<unknown>): Promise<unknown> }).serialize.bind(runs);
    vi.spyOn(runs, 'cancel').mockImplementation((id, reason, principal) => {
      if (id !== runId) void queue(id, () => new Promise((resolve) => setTimeout(resolve, 8_000)));
      return original(id, reason, principal);
    });
    await vi.waitFor(() => expect(held[0]?.closedAt).toEqual(expect.any(Number)), { timeout: 20_000, interval: 50 });
    // The worker sent its call and was stopped within its two seconds; the call's socket closed with
    // it, not eight seconds later once the cancel was written down, as before DIO-257.
    expect(held[0].closedAt! - held[0].at).toBeLessThan(5_000);
    const [worker] = await opened(projectId);
    expect(worker).toMatchObject({ role: 'worker', budget: { wallMs: 2_000 } });
    const child = await ended(projectId, worker.childRunId);
    expect(child.state).toBe('cancelled');
    expect(child.cancelReason).toBe('budget reached (wall time 2 s)');
    expect((await ended(projectId, runId)).state).toBe('completed');
    expect(held).toHaveLength(1);
  });

  test('by the person’s Stop: the advisor’s call’s socket closes at once, and its time came from the profile', async () => {
    leadCall = ['consult_advisor', { question: 'Is the order complete?' }];
    const { projectId, runId, session } = await start({ worker: {}, advisor: {} });
    await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 20_000, interval: 50 });
    const [advisor] = await opened(projectId);
    // Quick's three advisor turns: six minutes, not a cloud advisor's two.
    expect(advisor).toMatchObject({ role: 'advisor', budget: { wallMs: 360_000 } });
    expect((await host().get(projectId, advisor.childRunId)).budget.wallMs).toBe(360_000);
    const stopped = Date.now();
    await call(`/projects/${projectId}/work/${session.id}/stop`, 'POST', {});
    await vi.waitFor(() => expect(held[0].closedAt).toEqual(expect.any(Number)), { timeout: 10_000, interval: 25 });
    expect(held[0].closedAt! - stopped).toBeLessThan(5_000);
    expect((await ended(projectId, advisor.childRunId)).state).toBe('cancelled');
    expect((await ended(projectId, runId)).state).toBe('cancelled');
  });
});
