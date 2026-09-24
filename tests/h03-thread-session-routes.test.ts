/**
 * H03 through the real app over HTTP: a Console thread on Claude Code, whose native session is
 * the real `ClaudeAdapter` transport over a scripted stream-json child (the same script shape as
 * h03-claude-live-controls.test.ts). What the Console reads (`/native-session`), what a queued
 * message does, what Stop answers, and what a restart leaves. Fixture proof, not live Claude Code.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import type { PersistentTextAdapter } from '../server/engines/contract';
import { ClaudeAdapter, CLAUDE_VERSION } from '../server/engines/claude';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session';
import { openProcess, type ProcessFactory } from '../server/engines/process';
import { routeContractFor } from '../server/harness/route-contract';
import type { Store } from '../server/store';
import type { MessageResult } from '../server/interaction-service';
import type { InterruptResponse } from '../shared/conversation';
import type { ThreadSessionView } from '../shared/session-controls';
import type { Conversation, Project } from '../shared/types';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const model = 'sonnet';
const accountRoute = 'claude-code:claude.ai';

const SCRIPT = `import readline from 'node:readline';
import fs from 'node:fs';
const [,, session, known, log, resumed] = process.argv;
const emit = (x) => console.log(JSON.stringify(x));
const sessions = fs.existsSync(known) ? fs.readFileSync(known, 'utf8').split('\\n') : [];
if (resumed === 'resume' && !sessions.includes(session)) { console.error('No conversation found'); process.exit(1); }
if (!sessions.includes(session)) fs.appendFileSync(known, session + '\\n');
let count = 0, open = null;
const result = (text) => emit({ type: 'result', uuid: session + '-' + process.pid + '-' + count, subtype: 'success', result: text, session_id: session, modelUsage: { 'claude-sonnet-4-6': {} } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    if (m.request.subtype === 'interrupt' && open === 'hang') { open = null; setTimeout(() => emit({ type: 'result', uuid: session + '-' + process.pid + '-stop-' + count, subtype: 'error_during_execution', is_error: true, session_id: session, errors: ['Request was aborted'] }), 20); }
    return;
  }
  if (m.type !== 'user') return;
  count++;
  const words = JSON.parse(m.message.content).request.split('\\n\\n[[diomedes')[0];
  fs.appendFileSync(log, JSON.stringify({ pid: process.pid, turn: words, resumed }) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-4-6', tools: [], mcp_servers: [] });
  if (words.includes('[hang]')) { open = 'hang'; return; }
  if (words.includes('[slow]')) return setTimeout(() => result('Answer to ' + words), 400);
  result('Answer to ' + words);
});`;

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;
let thread: Conversation;
let log: string;
let launches: string[][];

async function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const reply = await response.text();
  expect(response.ok, `${route}: ${response.status} ${reply}`).toBe(true);
  return JSON.parse(reply) as T;
}
async function open() {
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
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  server = undefined;
}
const store = () => app.locals.store as Store;
const messages = () => `/projects/${project.id}/threads/${thread.id}/messages`;
const message = (commandId: string, words: string, extra: Record<string, unknown> = {}) => ({
  commandId,
  text: words,
  mode: 'auto',
  sources: [],
  consent: true,
  ...extra,
});
const send = (commandId: string, words: string, extra: Record<string, unknown> = {}) =>
  api<MessageResult>(messages(), 'POST', message(commandId, words, extra));
const view = () => api<ThreadSessionView>(`/projects/${project.id}/threads/${thread.id}/native-session`);
const turns = async () =>
  (await fs.readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { pid: number; turn: string; resumed: string });
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('The condition was never met.');
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h03-routes-'));
  const script = path.join(root, 'claude.mjs');
  const known = path.join(root, 'known.txt');
  log = path.join(root, 'log.jsonl');
  launches = [];
  await fs.writeFile(script, SCRIPT);
  const launch: ProcessFactory = (options) => {
    launches.push(options.args);
    const resume = options.args.includes('--resume');
    const session = options.args[options.args.indexOf(resume ? '--resume' : '--session-id') + 1];
    return openProcess({
      ...options,
      file: process.execPath,
      args: [script, session, known, log, resume ? 'resume' : 'new'],
      timeoutMs: 10_000,
    });
  };
  const transport = new ClaudeAdapter('claude.exe', path.join(root, 'transport'), {
    launch,
    account: async () => ({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com' }),
  });
  await fs.mkdir(path.join(root, 'transport'), { recursive: true });
  const adapter: PersistentTextAdapter<ClaudeSessionCheckpoint> = {
    id: 'claude-code',
    contract: routeContractFor('claude-code'),
    sessionContract: routeContractFor('claude-code-session'),
    inspect: async () => ({
      authentication: 'signed-in',
      accountRoute,
      detail: 'Fixture only',
      models: [{ slug: model, name: model, description: '', efforts: [], defaultEffort: null }],
    }),
    generate: async () => {
      throw new Error('Conversation requests must use the native transport');
    },
    openSession: (input, options) => transport.openSession(input, options),
  };
  service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [
      {
        id: 'claude-code',
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
        installedVersion: TESTED_VERSIONS['claude-code'],
        location: process.execPath,
        disclosure: [],
      },
    ],
    version: async () => TESTED_VERSIONS['claude-code'],
    adapter: () => adapter,
  });
  expect(CLAUDE_VERSION).toBe(TESTED_VERSIONS['claude-code']);
  await open();
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/claude-code', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'claude-code', model });
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['claude-code'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const state = store().state(project.id);
  state.conversations.find((item) => item.id === thread.id)!.engine = 'claude-code';
  state.project.ai = { engine: 'sample', model: null };
  await store().persist(state);
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('H03: a Console thread on Claude Code', () => {
  test('offers no controls before its conversation exists, then the contract controls and the reported model', async () => {
    expect(await view()).toEqual({
      runId: null,
      controls: null,
      busy: false,
      continuity: null,
      requestedModel: null,
      reportedModel: null,
      queued: [],
    });
    const first = await send('m-one', 'Good morning');
    expect(first.answerText).toBe('Answer to Good morning');
    const read = await view();
    expect(read).toMatchObject({
      runId: first.runId,
      busy: false,
      continuity: { state: 'live' },
      requestedModel: 'sonnet',
      reportedModel: 'claude-sonnet-4-6',
      queued: [],
    });
    expect(read.controls).toMatchObject({
      routeId: 'claude-code-session',
      engine: { id: 'claude-code', version: TESTED_VERSIONS['claude-code'] },
      steer: 'queued',
      stop: true,
      resume: true,
    });
  });

  test('a message sent while an answer runs is queued, shown as queued, and answered next in the same process', async () => {
    await send('m-one', 'Good morning');
    const running = send('m-two', 'Plan the week [slow]');
    await until(async () => (await view()).busy);
    // Without the flag a second message is refused, as before.
    const refused = await request(messages(), 'POST', message('m-three', 'Not queued'));
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('SESSION_BUSY');
    const queued = send('m-four', 'Also check linen', { queued: true });
    await until(async () => (await view()).queued.length === 1);
    expect((await view()).queued).toEqual([
      expect.objectContaining({ commandId: 'm-four', state: 'pending' }),
    ]);
    expect((await running).answerText).toBe('Answer to Plan the week [slow]');
    const answered = await queued;
    expect(answered.answerText).toBe('Answer to Also check linen');
    expect((await view()).queued).toEqual([
      expect.objectContaining({ commandId: 'm-four', state: 'delivered' }),
    ]);
    const said = (await turns()).map((line) => line.turn);
    expect(said).toEqual(['Good morning', 'Plan the week [slow]', 'Also check linen']);
    expect(new Set((await turns()).map((line) => line.pid)).size).toBe(1);
    // Both answers are in the thread, in the order they were sent.
    const texts = store()
      .state(project.id)
      .conversations.find((item) => item.id === thread.id)!
      .turns.filter((turn) => turn.role === 'assistant')
      .map((turn) => turn.text);
    expect(texts).toEqual([
      'Answer to Good morning',
      'Answer to Plan the week [slow]',
      'Answer to Also check linen',
    ]);
  });

  test('Stop interrupts the running answer gracefully and says so; the session stays live', async () => {
    await send('m-one', 'Good morning');
    const running = send('m-two', 'Think hard [hang]');
    await until(async () => (await view()).busy);
    const ack = await api<InterruptResponse>(`${messages()}/m-two/interrupt`, 'POST', {});
    expect(ack).toMatchObject({ commandId: 'm-two', state: 'requested', stop: 'interrupted' });
    expect(await running).toMatchObject({ interrupted: true, answerText: null });
    expect((await view()).continuity?.state).toBe('live');
    expect((await send('m-three', 'Carry on')).answerText).toBe('Answer to Carry on');
    expect(launches).toHaveLength(1);
  });

  test('after a Diomedes restart the thread says it will resume, and the next message resumes by session id', async () => {
    await send('m-one', 'Good morning');
    await close();
    await open();
    const read = await view();
    expect(read.busy).toBe(false);
    expect(read.continuity).toMatchObject({ state: 'resumable' });
    expect((await send('m-two', 'Where were we?')).answerText).toBe('Answer to Where were we?');
    expect(launches.at(-1)).toContain('--resume');
    expect((await turns()).at(-1)).toMatchObject({ turn: 'Where were we?', resumed: 'resume' });
  });
});
