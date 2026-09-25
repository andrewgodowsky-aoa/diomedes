/**
 * H05 over real HTTP: /api/projects/:id/cursor-sessions through the engine
 * service, the shared native conversation driver and the real Cursor adapter,
 * against the fixture ACP agent process (tests/fixtures/acp-agent.mjs). A plan
 * the agent presents mid-turn becomes a Need in the project, is answered
 * through the ordinary Needs route, and the answer reaches the agent. No
 * Cursor binary or account is reached.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import { CursorAdapter } from '../server/engines/cursor';
import type { Store } from '../server/store';
import type { Conversation, Need, Project } from '../shared/types';
import type { ClaudeSessionTurnResult } from '../server/harness/claude-session-run';
import type { SessionControls } from '../shared/session-controls';

const FIXTURE = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const model = 'fixture-model';
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let project: Project;
let thread: Conversation;
async function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
async function open(service: EngineService) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
const service = () =>
  new EngineService(path.join(root, 'engines'), {
    discover: async () => [
      {
        id: 'cursor',
        name: 'Fixture',
        kind: 'online',
        found: true,
        available: false,
        enabled: false,
        status: 'Installed',
        detail: 'Fixture',
        capabilities: [],
        signIn: 'unknown',
        adapter: 'planned',
        installedVersion: TESTED_VERSIONS.cursor,
        location: process.execPath,
        disclosure: [],
      },
    ],
    version: async () => TESTED_VERSIONS.cursor,
    adapter: (_engine, _location, cwd) =>
      new CursorAdapter(path.join(root, 'agent'), cwd, {
        spawn: (_file, _args, options) =>
          spawn(process.execPath, [FIXTURE], options) as ChildProcessWithoutNullStreams,
        capture: (async (options: { args: string[] }) =>
          options.args.includes('--version')
            ? { code: 0, stdout: '2026.08.11-e8db854' }
            : {
                code: 0,
                stdout: JSON.stringify({ status: 'authenticated', isAuthenticated: true }),
              }) as never,
        startupTimeoutMs: 5_000,
        requestTimeoutMs: 10_000,
      }),
  });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h05-http-'));
  await open(service());
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/cursor', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'cursor', model });
  project = await api<Project>('/projects', 'POST', { name: 'Cursor session fixture' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['cursor'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const store = app.locals.store as Store;
  const state = store.state(project.id);
  state.conversations.find((item) => item.id === thread.id)!.engine = 'cursor';
  await store.persist(state);
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});
const endpoint = () => `/projects/${project.id}/cursor-sessions`;
const command = (id: string, text = id) => ({
  commandId: id,
  threadId: thread.id,
  text,
  mode: 'ask',
  sources: [],
  consent: true,
});
const openAsks = async () =>
  (await api<{ needs: Need[] }>(`/projects/${project.id}/needs`)).needs.filter(
    (need) => need.engineAsk && need.state === 'open',
  );

test('a kept Cursor conversation continues its ACP session and offers only the controls its contract answers', async () => {
  const first = await api<ClaudeSessionTurnResult>(endpoint(), 'POST', command('first'));
  expect(first.response?.text).toBe('answer after 0 earlier turns');
  const second = await api<ClaudeSessionTurnResult>(
    `${endpoint()}/${first.runId}/turn`,
    'POST',
    command('second'),
  );
  expect(second.response?.text).toBe('answer after 1 earlier turns');
  expect(second.nativeSession).toEqual(first.nativeSession);
  const recorded = (app.locals.store as Store)
    .state(project.id)
    .conversations.find((item) => item.id === thread.id)!;
  expect(recorded.turns[1]).toMatchObject({
    route: 'cursor',
    origin: {
      engine: { id: 'cursor', version: TESTED_VERSIONS.cursor },
      model: { requested: model, reported: model, source: 'runtime' },
    },
  });
  const status = await api<{ controls: SessionControls }>(`${endpoint()}/${first.runId}`);
  expect(status.controls).toEqual({
    routeId: 'cursor-session',
    engine: { id: 'cursor', version: TESTED_VERSIONS.cursor },
    followUp: true,
    steer: null,
    stop: true,
    resume: true,
    fork: false,
    close: true,
  });
  // No steer route, and a fork is refused by the contract before anything starts.
  expect(
    (await request(`${endpoint()}/${first.runId}/steer`, 'POST', { commandId: 's', text: 't' })).status,
  ).toBe(404);
  const fork = await request(`${endpoint()}/${first.runId}/fork`, 'POST', command('forked'));
  expect(fork.status).toBe(409);
});

test('a plan Cursor presents mid-turn is a Need; the answer given there reaches Cursor', async () => {
  const pending = api<ClaudeSessionTurnResult>(endpoint(), 'POST', command('first', 'make a plan'));
  let need: Need | undefined;
  await expect
    .poll(async () => {
      need = (await openAsks())[0];
      return need !== undefined;
    }, { timeout: 10_000 })
    .toBe(true);
  expect(need).toMatchObject({
    what: 'Cursor asks you to approve its plan: Outline the report in three sections',
    files: [],
    allowForTask: false,
    engineAsk: { engine: 'cursor', kind: 'plan', threadId: thread.id, requestId: 'first' },
  });
  // Answered once: a task-wide allowance is refused and leaves the question open.
  const wide = await request(`/projects/${project.id}/needs/${need!.id}/resolve`, 'POST', {
    resolution: 'go-ahead',
    allowForTask: true,
  });
  expect(wide.status).toBe(400);
  const decided = await api<Need>(`/projects/${project.id}/needs/${need!.id}/resolve`, 'POST', {
    resolution: 'go-ahead',
  });
  expect(decided).toMatchObject({ state: 'go-ahead', decidedFrom: 'desktop' });
  const answered = await pending;
  expect(answered.response?.text).toBe('plan accepted; outlined');
  // A decided question cannot be decided again.
  expect(
    (await request(`/projects/${project.id}/needs/${need!.id}/resolve`, 'POST', { resolution: 'declined' }))
      .status,
  ).toBe(409);
});

test('a declined plan tells Cursor no, and the same answer continues', async () => {
  const pending = api<ClaudeSessionTurnResult>(endpoint(), 'POST', command('first', 'make a plan'));
  await expect.poll(async () => (await openAsks()).length, { timeout: 10_000 }).toBe(1);
  const [need] = await openAsks();
  await api(`/projects/${project.id}/needs/${need.id}/resolve`, 'POST', { resolution: 'declined' });
  expect((await pending).response?.text).toBe('plan rejected');
});

test('a Stop while the question is open expires the Need; nothing can be sent for it afterwards', async () => {
  const pending = request(endpoint(), 'POST', command('first', 'make a plan'));
  await expect.poll(async () => (await openAsks()).length, { timeout: 10_000 }).toBe(1);
  const [need] = await openAsks();
  const runId = need.engineAsk!.runId;
  const stop = await request(`${endpoint()}/${runId}/interrupt`, 'POST', { commandId: 'stop-1' });
  expect(stop.ok).toBe(true);
  await pending;
  const after = (await api<{ needs: Need[] }>(`/projects/${project.id}/needs`)).needs.find(
    (item) => item.id === need.id,
  );
  expect(after?.state).toBe('expired');
  const late = await request(`/projects/${project.id}/needs/${need.id}/resolve`, 'POST', {
    resolution: 'go-ahead',
  });
  expect(late.status).toBe(409);
});
