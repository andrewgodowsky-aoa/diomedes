/**
 * H04 over real HTTP: /api/projects/:id/opencode-sessions through the engine
 * service, the shared native conversation driver and the real OpenCode adapter,
 * against the fixture `opencode serve` (tests/fixtures/opencode-session-server.mjs).
 * No OpenCode binary or account is reached.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import { OpenCodeAdapter, OPENCODE_ACCOUNT_ROUTE } from '../server/engines/opencode';
import type { Store } from '../server/store';
import type { Project, Conversation } from '../shared/types';
import type { ClaudeSessionTurnResult } from '../server/harness/claude-session-run';
import type { SessionControls } from '../shared/session-controls';
import type { SteeringAck } from '../shared/contract-revision';

const FIXTURE = fileURLToPath(new URL('./fixtures/opencode-session-server.mjs', import.meta.url));
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const model = 'opencode-go/go-model';
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let project: Project;
let thread: Conversation;
let fixtureMode: string;
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
  const closingApp = app, closingServer = server;
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
        id: 'opencode',
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
        installedVersion: TESTED_VERSIONS.opencode,
        location: process.execPath,
        disclosure: [],
      },
    ],
    version: async () => TESTED_VERSIONS.opencode,
    adapter: (_engine, _location, cwd) =>
      new OpenCodeAdapter('opencode', cwd, {
        spawn: (_command, args, options) =>
          spawn(process.execPath, [FIXTURE, args[args.indexOf('--port') + 1], fixtureMode], options) as ChildProcessWithoutNullStreams,
        startupTimeoutMs: 5_000,
        requestTimeoutMs: 5_000,
      }),
  });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h04-http-'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(os.tmpdir(), 'diomedes-no-opencode-cache'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'opencode-data'));
  fixtureMode = 'ok';
  await open(service());
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/opencode', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'opencode', model });
  project = await api<Project>('/projects', 'POST', { name: 'OpenCode session fixture' });
  // Default-deny cloud sharing: this synthetic project grants the opencode route with no
  // source documents, plus conversation history for follow-up turns on the same session.
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['opencode'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const store = app.locals.store as Store;
  const state = store.state(project.id);
  state.conversations.find((item) => item.id === thread.id)!.engine = 'opencode';
  await store.persist(state);
});
afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
const endpoint = () => `/projects/${project.id}/opencode-sessions`;
const command = (id: string, text = id) => ({
  commandId: id,
  threadId: thread.id,
  text,
  mode: 'ask',
  sources: [],
  consent: true,
});

test('a kept OpenCode session answers follow-ups on one session and projects each answer once, attributed to OpenCode', async () => {
  const first = await api<ClaudeSessionTurnResult>(endpoint(), 'POST', command('first'));
  const id = first.nativeSession!.opaqueRef;
  expect(first.response?.text).toBe(`answer:first (turn 1 of ${id})`);
  expect(await api<ClaudeSessionTurnResult>(endpoint(), 'POST', command('first'))).toEqual(first);
  const second = await api<ClaudeSessionTurnResult>(`${endpoint()}/${first.runId}/turn`, 'POST', command('second'));
  expect(second.response?.text).toBe(`answer:second (turn 2 of ${id})`);
  const recorded = (app.locals.store as Store)
    .state(project.id)
    .conversations.find((item) => item.id === thread.id)!;
  expect(recorded.turns.map((turn) => turn.text)).toEqual([
    'first',
    first.response!.text,
    'second',
    second.response!.text,
  ]);
  expect(recorded.turns[1]).toMatchObject({
    route: 'opencode',
    origin: {
      engine: { id: 'opencode', version: TESTED_VERSIONS.opencode },
      model: { requested: model, reported: model, source: 'runtime' },
      accountRoute: OPENCODE_ACCOUNT_ROUTE,
    },
  });
  const status = await api<{
    state: string;
    nativeSession: { opaqueRef: string; providerId: string };
    controls: SessionControls;
    steering: SteeringAck[];
  }>(`${endpoint()}/${first.runId}`);
  expect(status).toMatchObject({
    state: 'waiting',
    nativeSession: { providerId: 'opencode', opaqueRef: id },
    steering: [],
    // Offered because the route contract answers them, and no more: steering is a queue.
    controls: { routeId: 'opencode-session', followUp: true, steer: 'queued', stop: true, resume: true, fork: true },
  });
  // Nothing is running, so a steer is refused rather than held.
  expect(
    await api<SteeringAck>(`${endpoint()}/${first.runId}/steer`, 'POST', { commandId: 'steer-1', text: 'late' }),
  ).toMatchObject({ state: 'rejected' });
  // Claude's native session declares no steering, so it has no such route.
  expect((await request(`/projects/${project.id}/claude-sessions/${first.runId}/steer`, 'POST', { commandId: 's', text: 't' })).status).toBe(404);
  const foreign = await api<Project>('/projects', 'POST', { name: 'Other project' });
  expect((await request(`/projects/${foreign.id}/opencode-sessions/${first.runId}`)).status).toBe(404);
});

test('closed and restarted hosts resume the same OpenCode session only through explicit resume, and fork from it', async () => {
  const first = await api<ClaudeSessionTurnResult>(endpoint(), 'POST', command('start'));
  await api(`${endpoint()}/${first.runId}/close`, 'POST', { commandId: 'close-one' });
  expect((await request(`${endpoint()}/${first.runId}/turn`, 'POST', command('cannot-follow'))).status).toBe(409);
  await close();
  await open(service());
  const resumed = await api<ClaudeSessionTurnResult>(`${endpoint()}/${first.runId}/resume`, 'POST', command('resumed'));
  expect(resumed.nativeSession).toEqual(first.nativeSession);
  expect(resumed.response?.text).toBe(`answer:resumed (turn 2 of ${first.nativeSession!.opaqueRef})`);
  const fork = await api<ClaudeSessionTurnResult>(`${endpoint()}/${first.runId}/fork`, 'POST', command('forked'));
  expect(fork.runId).not.toBe(first.runId);
  expect(fork.nativeSession?.opaqueRef).not.toBe(first.nativeSession?.opaqueRef);
  expect(fork.nativeSession?.lineageId).toBe(first.nativeSession?.lineageId);
  expect(fork.response?.text).toBe(`answer:forked (turn 3 of ${fork.nativeSession!.opaqueRef})`);
});

test('a fork the OpenCode build cannot make is refused with its reason', async () => {
  const first = await api<ClaudeSessionTurnResult>(endpoint(), 'POST', command('start'));
  await api(`${endpoint()}/${first.runId}/close`, 'POST', { commandId: 'close-one' });
  fixtureMode = 'no-fork';
  const refused = await request(`${endpoint()}/${first.runId}/fork`, 'POST', command('forked'));
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    code: 'COMMAND_UNSUPPORTED',
    error: 'This OpenCode build did not accept a fork of that session, so no fork was started.',
  });
});

test('a thread on another engine cannot open an OpenCode session', async () => {
  const store = app.locals.store as Store;
  const state = store.state(project.id);
  state.conversations.find((item) => item.id === thread.id)!.engine = 'claude-code';
  await store.persist(state);
  const refused = await request(endpoint(), 'POST', command('first'));
  expect(refused.status).toBe(409);
});
