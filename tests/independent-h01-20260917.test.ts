/**
 * Independent H01 acceptance overlay. Only provider I/O and discovery are fixtures.
 * createApp, EngineService, real adapters, HarnessHost, RunService, Store and Trust
 * are not mocked. Copied from the finalized preparation overlay; final-review
 * harness adaptations are recorded outside the repository.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { ClaudeAdapter } from '../server/engines/claude.js';
import { OpenCodeAdapter, OPENCODE_ACCOUNT_ROUTE } from '../server/engines/opencode.js';
import { openProcess, type ProcessFactory } from '../server/engines/process.js';
import { FileRunStore } from '../server/harness/run-store.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { Store } from '../server/store.js';
import type { HarnessRun } from '../shared/harness.js';
import type { ExternalEngine, IntegrationStatus, ProjectState } from '../shared/types.js';
import type { TextRequest } from '../server/engines/contract.js';

const fixtures = fileURLToPath(new URL('./independent-h01-fixtures-20260917/', import.meta.url));
const answer = 'Synthetic cafe inventory: caf\u00e9 \ud83d\ude80';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
type Dispatch = { runs: HarnessRun[]; states: ProjectState[] };
type Frame = Record<string, unknown>;
const errorCode = (error: unknown) => error instanceof Error && 'code' in error ? String(error.code) : undefined;
async function lines<T>(file: string): Promise<T[]> {
  try { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
}
async function fixture(mode = 'ok', engine: ExternalEngine = 'claude-code') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-independent-h01-'));
  let app: Awaited<ReturnType<typeof createApp>>;
  let server: Server | undefined;
  let url: string;
  const frames: Frame[] = [];
  let account: Record<string, unknown> = { loggedIn: true, authMethod: 'claude.ai' };
  let beforeVersion: (() => Promise<void>) | undefined;
  const model = engine === 'opencode' ? 'opencode-go/fixture-model' : 'claude-test';
  const accountRoute = engine === 'opencode' ? OPENCODE_ACCOUNT_ROUTE : 'claude-code:claude.ai';
  const launch: ProcessFactory = options => openProcess({ ...options, file: process.execPath,
    args: [path.join(fixtures, 'claude-provider.cjs'), root, mode], timeoutMs: 5_000 });
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async (): Promise<IntegrationStatus[]> => [{
      id: engine, name: 'Local provider fixture', kind: 'online', found: true,
      available: false, enabled: false, status: 'Installed', detail: 'Synthetic discovery',
      capabilities: [], signIn: 'unknown', adapter: 'planned', installedVersion: TESTED_VERSIONS[engine],
      location: process.execPath, disclosure: [],
    }],
    version: async () => { await beforeVersion?.(); return TESTED_VERSIONS[engine]; },
    adapter: (_engine, _file, cwd) => engine === 'opencode'
      ? new OpenCodeAdapter('local-fixture', cwd, {
          spawn: (_command, args, options) => spawn(process.execPath,
            [path.join(fixtures, 'opencode-provider.cjs'), root, args[args.indexOf('--port') + 1]],
            options) as ChildProcessWithoutNullStreams,
          startupTimeoutMs: 5_000, requestTimeoutMs: 3_000,
        })
      : new ClaudeAdapter('local-fixture', cwd, { launch, account: async () => account }),
  });
  async function open() {
    app = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
      engineService: service, reviewerAdapter: null });
    (app.locals.store as Store).on('engine-text', (frame: Frame) => frames.push(structuredClone(frame)));
    server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  }
  async function close() {
    if (!server) return;
    await fs.writeFile(path.join(root, 'release-provider'), 'release');
    service.close();
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
  cleanups.push(async () => {
    await close();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('diomedes-independent-h01-'))
      throw new Error('Refusing cleanup outside owned fixture root');
    await fs.rm(root, { recursive: true, force: true });
  });
  async function api(endpoint: string, method = 'GET', body?: unknown) {
    const response = await fetch(url + endpoint, { method,
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    // API responses intentionally retain their runtime shape; tests assert fields below.
    return { status: response.status, data: await response.json() };
  }
  await open();
  expect((await api('/ai/discover', 'POST', { consent: true })).status).toBe(200);
  expect((await api(`/ai/check/${engine}`, 'POST', {})).status).toBe(200);
  expect((await api('/ai/select', 'POST', { engine, model })).status).toBe(200);
  const project = await api('/projects', 'POST', { name: 'Independent synthetic cafe' });
  expect(project.status).toBe(200);
  const projectId: string = project.data.id;
  // Default-deny cloud sharing: this synthetic project explicitly grants the
  // fixture engine route with no source documents and no prior history
  // (work/start and ask use sources [] throughout).
  expect((await api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: [engine],
    documents: [],
    shareConversationHistory: false,
    shareReviewPackets: false,
  })).status).toBe(200);
  const thread = await api(`/projects/${projectId}/threads`, 'POST', {});
  expect(thread.status).toBe(201);
  const threadId: string = thread.data.id;
  const request: TextRequest = { projectId, threadId, requestId: 'independent-command',
    model, accountRoute, prompt: 'Summarize the synthetic inventory.', instructions: '', documents: [] };
  const files = new FileRunStore(path.join(root, 'data', 'projects', projectId, 'harness', 'runs'));
  return { root, service, api, request, frames, projectId, threadId, files,
    host: () => app.locals.harness as HarnessHost, store: () => app.locals.store as Store,
    setAccount: (value: Record<string, unknown>) => { account = value; },
    setBeforeVersion: (callback: () => Promise<void>) => { beforeVersion = callback; },
    withdraw: () => fs.writeFile(path.join(root, 'withdraw-model'), 'withdraw'),
    dispatches: () => lines<Dispatch>(path.join(root, 'provider-dispatch.jsonl')),
    sseTrace: () => lines<{ event: string; status?: number; terminalSent?: boolean }>(path.join(root, 'sse-trace.jsonl')),
    runs: async () => Promise.all((await files.list()).map(async id => (await files.read(id))!)),
    ask: () => api(`/projects/${projectId}/ask`, 'POST', { text: request.prompt, mode: 'ask', route: engine, threadId, consent: true }),
    release: () => fs.writeFile(path.join(root, 'release-provider'), 'release'),
    reopen: async () => { await close(); await open(); },
  };
}
function durableIdentity(run: HarnessRun) {
  expect(run.owner, 'host owner persisted before provider dispatch').toEqual(expect.any(String));
  expect(run.fence).toBeGreaterThan(0);
  const steps = run.steps.filter(step => step.state === 'running' && step.intent.kind === 'model');
  expect(steps, 'exactly one active durable model step').toHaveLength(1);
  expect(steps[0].attempt).toBeGreaterThan(0);
  expect(steps[0].leaseFence).toBe(run.fence);
  expect(run.events.some(event => event.stepId === steps[0].intent.stepId && event.attempt === steps[0].attempt)).toBe(true);
}

describe('H01 real application and host acceptance', () => {
  it('persists an admitted command, host run, model step, attempt and fence before Work dispatch', async () => {
    const f = await fixture();
    const task = await f.api(`/projects/${f.projectId}/tasks`, 'POST', { name: 'Summarize inventory', owner: 'diomedes-with-ok' });
    const started = await f.api(`/projects/${f.projectId}/work/start`, 'POST', {
      protocolVersion: 1, commandId: 'independent-work-command', taskId: task.data.id,
      route: 'claude-code', sources: [], consent: true,
    });
    expect(started.status).toBe(200);
    await vi.waitFor(async () => expect(await f.dispatches()).toHaveLength(1), { timeout: 8_000 });
    const [dispatch] = await f.dispatches();
    const session = dispatch.states.flatMap(state => state.sessions).find(row => row.id === started.data.id);
    expect(session?.receipt?.commandId).toBe('independent-work-command');
    const runs = dispatch.runs.filter(run => (run.input as { requestId?: unknown } | null)?.requestId === started.data.id);
    console.log('H01_WORK_DISPATCH', JSON.stringify({ command: session?.receipt?.commandId, runs: runs.length }));
    expect(runs, 'admitted Work must reach the existing durable host before provider I/O').toHaveLength(1);
    durableIdentity(runs[0]);
  });
  it('persists a durable run before the application text support route sends a prompt', async () => {
    const f = await fixture();
    expect((await f.ask()).status).toBe(200);
    const [dispatch] = await f.dispatches();
    expect(dispatch).toBeDefined();
    console.log('H01_TEXT_DISPATCH', JSON.stringify({ runs: dispatch.runs.length, providerCalls: (await f.dispatches()).length }));
    expect(dispatch.runs, 'text support uses the same host run store').toHaveLength(1);
    durableIdentity(dispatch.runs[0]);
  });
  it('carries host run, step, attempt and lease fence through the actual app-facing preview event', async () => {
    const f = await fixture();
    expect((await f.ask()).status).toBe(200);
    const deltas = f.frames.filter(frame => frame.kind === 'delta');
    expect(deltas).toHaveLength(1);
    console.log('H01_APP_PREVIEW', JSON.stringify(deltas[0]));
    expect(deltas[0]).toMatchObject({ projectId: f.projectId, threadId: f.threadId, text: answer,
      runId: expect.any(String), stepId: expect.any(String), attempt: expect.any(Number), fence: expect.any(Number) });
    const run = await f.host().get(f.projectId, String(deltas[0].runId));
    expect(run.steps.some(step => step.intent.stepId === deltas[0].stepId && step.attempt === deltas[0].attempt && step.leaseFence === deltas[0].fence)).toBe(true);
  });
  it('commits one matching host terminal result for a completed app text operation', async () => {
    const f = await fixture();
    const response = await f.ask();
    expect(response.status).toBe(200);
    const runs = await f.runs();
    expect(runs, 'completed text operation has an authoritative durable run').toHaveLength(1);
    const run = await f.host().get(f.projectId, runs[0].id);
    expect(run.state).toBe('completed');
    expect(run.events.filter(event => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))).toHaveLength(1);
    expect(JSON.stringify(run.result)).toContain(answer);
    expect(response.data.turn.helper).toMatchObject({ engine: 'claude-code', model: 'claude-test' });
  });
  it('diagnostic only: returns the durable result when the same logical EngineService request is replayed', async () => {
    const f = await fixture();
    const first = await f.service.generate('claude-code', f.request);
    const second = await f.service.generate('claude-code', f.request);
    expect(first.text).toBe(answer);
    expect(second.text).toBe(answer);
    const calls = await f.dispatches();
    console.log('H01_LOGICAL_REPLAY', JSON.stringify({ providerCalls: calls.length }));
    expect(calls, 'replaying the same request must not send another provider prompt').toHaveLength(1);
  });
  it('replays the existing admitted Work command and its receipt without another provider call', async () => {
    const f = await fixture();
    const task = await f.api(`/projects/${f.projectId}/tasks`, 'POST', { name: 'Summarize inventory', owner: 'diomedes-with-ok' });
    const command = { protocolVersion: 1, commandId: 'replay-work-command', taskId: task.data.id,
      route: 'claude-code', sources: [], consent: true };
    const endpoint = `/projects/${f.projectId}/work/start`;
    const first = await f.api(endpoint, 'POST', command);
    expect(first.status).toBe(200);
    await vi.waitFor(async () => expect(await f.dispatches()).toHaveLength(1), { timeout: 8_000 });
    const second = await f.api(endpoint, 'POST', command);
    expect(second.status).toBe(200);
    expect(second.data.id).toBe(first.data.id);
    const receipt = await f.api(`/projects/${f.projectId}/work/commands/${command.commandId}`);
    expect(receipt.status).toBe(200);
    expect(receipt.data.id).toBe(first.data.id);
    expect(await f.dispatches()).toHaveLength(1);
  });
  it('reopens saved application text without another provider call or changed attribution', async () => {
    const f = await fixture();
    const response = await f.ask();
    expect(response.status).toBe(200);
    const turn = response.data.turn;
    await f.reopen();
    const state = f.store().state(f.projectId);
    expect(state.conversations.find(thread => thread.id === f.threadId)?.turns.find(row => row.id === turn.id)).toEqual(turn);
    expect(await f.dispatches()).toHaveLength(1);
  });
  it('rejects a second controller while a provider turn remains active', async () => {
    const f = await fixture('hold');
    const first = f.service.generate('claude-code', f.request);
    void first.catch(() => {});
    try {
      await vi.waitFor(async () => expect(await f.dispatches()).toHaveLength(1), { timeout: 8_000 });
      await expect(f.service.generate('claude-code', { ...f.request, requestId: 'other-controller' })).rejects.toMatchObject({ code: 'REQUEST_ACTIVE' });
      expect(await f.dispatches()).toHaveLength(1);
    } finally { await f.release(); await first; }
  });
  it('rejects a withdrawn model observed between listing and dispatch', async () => {
    const f = await fixture();
    await f.withdraw();
    await expect(f.service.generate('claude-code', f.request)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(await f.dispatches()).toHaveLength(0);
  });
  it('rejects sign-out between listing and dispatch', async () => {
    const f = await fixture();
    f.setAccount({ loggedIn: false });
    await expect(f.service.generate('claude-code', f.request)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await f.dispatches()).toHaveLength(0);
  });
  it('does not dispatch after cancellation during the final capability check', async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.setBeforeVersion(async () => { controller.abort(); });
    await expect(f.service.generate('claude-code', { ...f.request, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await f.dispatches()).toHaveLength(0);
  });
  it('rechecks current app enablement after observation and before provider dispatch', async () => {
    const f = await fixture();
    let changed = false;
    f.setBeforeVersion(async () => {
      if (changed) return;
      changed = true;
      expect((await f.api('/settings', 'PUT', { services: { 'claude-code': false } })).status).toBe(200);
    });
    const response = await f.ask();
    console.log('H01_ENABLEMENT_RACE', JSON.stringify({ responseStatus: response.status, providerCalls: (await f.dispatches()).length }));
    expect(await f.dispatches(), 'disabled route must not dispatch after the readiness await').toHaveLength(0);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
  it('rejects old-owner previews after lease expiry and host takeover', async () => {
    const f = await fixture('hold');
    const job = f.ask();
    void job.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.frames.some(frame => frame.kind === 'delta')).toBe(true), { timeout: 8_000 });
      const runs = await f.runs();
      expect(runs, 'takeover requires a real host-owned active text run').toHaveLength(1);
      const old = runs[0];
      expect(old.owner).not.toBeNull();
      await f.host().runs.claim(old.id, old.owner!, 1);
      const expiry = (await f.host().get(f.projectId, old.id)).leaseExpiresAt!;
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(expiry));
      await f.host().runs.claim(old.id, 'independent-new-owner');
      const recovered = await f.host().get(f.projectId, old.id);
      expect(recovered.fence).toBeGreaterThan(old.fence);
      const before = f.frames.filter(frame => frame.kind === 'delta').length;
      await f.release();
      await job;
      console.log('H01_STALE_OWNER_PREVIEW', JSON.stringify({ oldFence: old.fence, newFence: recovered.fence,
        frames: f.frames, afterState: (await f.host().get(f.projectId, old.id)).state }));
      expect(f.frames.filter(frame => frame.kind === 'delta')).toHaveLength(before);
      expect((await f.host().get(f.projectId, old.id)).state).not.toBe('completed');
    } finally { await f.release(); await job; }
  });
  it('refuses a current account-route selection change during admission before provider dispatch', async () => {
    const f = await fixture();
    let changed = false;
    f.setBeforeVersion(async () => {
      if (changed) return;
      changed = true;
      expect((await f.api('/settings', 'PUT', { services: { 'claude-codeAccountRoute': 'different-current-account' } })).status).toBe(200);
    });
    const response = await f.ask();
    console.log('H01_ACCOUNT_ROUTE_RACE', JSON.stringify({ status: response.status, calls: (await f.dispatches()).length }));
    expect(await f.dispatches()).toHaveLength(0);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
  it('parks an in-flight app result when route authority is withdrawn and never records an answer', async () => {
    const f = await fixture('hold');
    const job = f.ask();
    void job.catch(() => {});
    try {
      await vi.waitFor(async () => expect(await f.dispatches()).toHaveLength(1), { timeout: 8_000 });
      expect((await f.api('/settings', 'PUT', { services: { 'claude-code': false } })).status).toBe(200);
      await f.release();
      const response = await job;
      const [run] = await f.runs();
      console.log('H01_RESULT_AUTHORITY', JSON.stringify({ status: response.status, state: run.state, calls: (await f.dispatches()).length }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(run.state).toBe('reconcile_required');
      expect(run.result).toBeNull();
      expect(run.events.filter(event => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))).toHaveLength(0);
      expect(f.store().state(f.projectId).conversations.find(thread => thread.id === f.threadId)?.turns.filter(turn => turn.role !== 'you')).toHaveLength(0);
      expect(await f.dispatches()).toHaveLength(1);
    } finally { await f.release(); await job; }
  });
});

describe('H01 real provider transport regressions', () => {
  it.each(['unicode', 'stderr'])('Claude handles %s through its production process parser', async mode => {
    const f = await fixture(mode);
    const response = await f.ask();
    expect(response.status).toBe(200);
    expect(response.data.turn.text).toBe(answer);
    expect(await f.dispatches()).toHaveLength(1);
  });
  it.each(['no-terminal', 'truncated', 'oversized'])('Claude refuses %s without fabricated completion or retry', async mode => {
    const f = await fixture(mode);
    let failure: unknown;
    try { await f.service.generate('claude-code', f.request); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(errorCode(failure)).toBeDefined();
    expect(await f.dispatches()).toHaveLength(1);
  });
  it('OpenCode observes successful prompt acceptance and partial SSE before an actual socket drop', async () => {
    const f = await fixture('drop', 'opencode');
    const previews: string[] = [];
    let failure: unknown;
    try { await f.service.generate('opencode', { ...f.request, onPreview: frame => previews.push(frame.text) }); }
    catch (error) { failure = error; }
    const trace = await f.sseTrace();
    console.log('H01_SSE_DROP', JSON.stringify({ trace, error: errorCode(failure), previews }));
    expect(trace.filter(row => row.event === 'prompt-accepted')).toEqual([{ event: 'prompt-accepted', status: 204 }]);
    expect(trace).toContainEqual({ event: 'connection-drop', terminalSent: false });
    expect(previews).toEqual(['Partial fixture answer']);
    expect(failure).toMatchObject({ ambiguous: true });
    expect(errorCode(failure)).not.toBe('TIMEOUT');
  });
  it('parks a dropped-SSE app operation durably for reconciliation across restart', async () => {
    const f = await fixture('drop', 'opencode');
    const response = await f.ask();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await f.sseTrace()).filter(row => row.event === 'prompt-accepted')).toHaveLength(1);
    const runs = await f.runs();
    expect(runs, 'ambiguous accepted provider work remains in the host record').toHaveLength(1);
    expect(runs[0].state).toBe('reconcile_required');
    expect(runs[0].events.filter(event => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))).toHaveLength(0);
    await f.reopen();
    expect((await f.host().get(f.projectId, runs[0].id)).state).toBe('reconcile_required');
    expect((await f.sseTrace()).filter(row => row.event === 'prompt-accepted')).toHaveLength(1);
  });
});
