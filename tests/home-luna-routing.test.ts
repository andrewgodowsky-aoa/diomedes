/**
 * The conversation default route, through the real app over HTTP: a provisioned
 * Home and a provisioned project conversation take the shared default, which is
 * the server-owned AWS Bedrock route on Luna. A route the person chose through
 * the thread update is marked `engineChoice: 'person'` and survives
 * provisioning and restart; a pin nobody chose is migrated once. An
 * unconfigured AWS refuses a send by name with nothing admitted, and a
 * configured fake AWS answers with no Claude adapter, no native sign-in and no
 * target project anywhere in the fixture. `close()` then `open()` over the same
 * data directory is a graceful restart.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { AWS_BEDROCK_ROUTE, AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { testOnlySecretBox } from '../server/connection-secrets';
import { identifier, now, type Store } from '../server/store';
import { CONVERSATION_DEFAULT_ROUTE, isConversationRoute } from '../shared/engines';
import type { AwsConnectionView } from '../shared/model-api';
import type { MessageResult } from '../shared/conversation';
import type { Conversation, Project } from '../shared/types';
import {
  shareHistory,
  stopSharingHistory,
  type HomeSharing,
  type HomeSharingChange,
} from '../client/console/home-history';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let adapterCalls: number;
let nativeCalls: number;
let loginCalls: number;

// --- the fake AWS Responses endpoint ------------------------------------------------

type Item = Record<string, unknown>;
let seen: { url: string; authorization: string | null; body: { input: Item[] } }[];

const envelope = (output: Item[]) => ({
  id: `resp_${seen.length}`,
  object: 'response',
  created_at: 1_790_000_000,
  status: 'completed',
  model: AWS_LUNA_MODEL,
  output: [
    { type: 'reasoning', id: `rs_${seen.length}`, summary: [], encrypted_content: `enc-${seen.length}` },
    ...output,
  ],
  usage: {
    input_tokens: 120,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 24,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 144,
  },
  incomplete_details: null,
  error: null,
});
const answer = (text: string): Item => ({
  type: 'message',
  id: `msg_${seen.length}`,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const userText = (body: { input: Item[] }) => {
  const user = body.input.find((item) => item.role === 'user');
  const content = user?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.map((part) => String((part as Item).text ?? '')).join('')
    : '';
};
const decisionBlock = (sourceMessageId: string, summary: string, projectId: string | null) =>
  '```diomedes-decision\n' +
  JSON.stringify({
    source_message_id: sourceMessageId,
    disposition: 'act',
    requested_project_id: projectId,
    operation_class: 'write_internal',
    source_refs: [],
    target_run_id: null,
    question: null,
    public_summary: summary,
  }) +
  '\n```';

/** Answers like the model would, from what the request actually carries. */
function respond(body: { input: Item[] }): Item[] {
  const text = userText(body);
  const message = text.split("The person's message:\n\n")[1] ?? '';
  const issued = /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]\s*$/.exec(message)?.[1];
  const said = message.split('\n\n[[diomedes')[0];
  const named = /^TARGET (\S+)/.exec(said)?.[1] ?? null;
  if ((said.startsWith('ACT') || named !== null) && issued)
    return [
      answer(`I can start that.\n\n${decisionBlock(issued, `Do this: ${said}`, named)}`),
    ];
  return [answer(`answer:${said}`)];
}

const aws = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headersIn = new Headers(init?.headers);
  const body = JSON.parse(String(init?.body)) as { input: Item[] };
  seen.push({ url: String(input), authorization: headersIn.get('authorization'), body });
  return sseResponse(responsesEvents(envelope(respond(body))), { 'x-amzn-requestid': `req-${seen.length}` });
}) as typeof globalThis.fetch;

// --- the app ------------------------------------------------------------------------

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
async function open() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), {
      // Nothing discovers, checks or signs in a native engine in this fixture.
      discover: async () => [],
      version: async () => {
        throw new Error('No engine is checked in this fixture');
      },
      adapter: () => {
        adapterCalls += 1;
        throw new Error('No native adapter exists in this fixture');
      },
    }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: aws,
    nativeGenerator: async () => {
      nativeCalls += 1;
      throw new Error('No native work runs in this fixture');
    },
    nativeLoginLaunch: () => {
      loginCalls += 1;
      throw new Error('No native sign-in window opens in this fixture');
    },
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
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
}
const store = () => app.locals.store as Store;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-home-luna-'));
  seen = [];
  adapterCalls = 0;
  nativeCalls = 0;
  loginCalls = 0;
  await open();
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

type Binding = { projectId: string; threadId: string };
const provisionHome = () => api<Binding>('/home/conversation', 'POST');
const provisionProject = (projectId: string) =>
  api<Binding>(`/projects/${projectId}/conversation`, 'POST');
const readHome = () => api<Binding | null>('/home/conversation');
const project = (name: string) => api<Project>('/projects', 'POST', { name });
const listed = async () => (await api<{ projects: Project[] }>('/projects')).projects;
const threadsOf = (projectId: string) => store().state(projectId).conversations;
const homeThread = (home: Binding) =>
  threadsOf(home.projectId).find((thread) => thread.id === home.threadId)!;
const byId = (projectId: string, threadId: string) =>
  threadsOf(projectId).find((thread) => thread.id === threadId)!;
const messages = (binding: Binding) =>
  `/projects/${binding.projectId}/threads/${binding.threadId}/messages`;
const send = (binding: Binding, commandId: string, text: string) =>
  api<MessageResult>(messages(binding), 'POST', {
    commandId,
    text,
    mode: 'auto',
    sources: [],
    consent: true,
  });
const sendRaw = (binding: Binding, commandId: string, text: string) =>
  request(messages(binding), 'POST', { commandId, text, mode: 'auto', sources: [], consent: true });
const connect = () =>
  api<AwsConnectionView>('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey: SECRET,
    expiresAt: null,
    consent: true,
  });
const approveSpend = (capUsd = 1) =>
  api<AwsConnectionView>('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd, consent: true });

test('the shared conversation default names the server-owned AWS Bedrock route', () => {
  expect(CONVERSATION_DEFAULT_ROUTE).toBe(AWS_BEDROCK_ROUTE);
  expect(AWS_BEDROCK_ROUTE).toBe('aws-bedrock');
});

test('the conversation route predicate admits Claude Code and model-API routes only', () => {
  expect(isConversationRoute('claude-code')).toBe(true);
  expect(isConversationRoute('aws-bedrock')).toBe(true);
  expect(isConversationRoute('sample')).toBe(false);
  expect(isConversationRoute('codex')).toBe(false);
  expect(isConversationRoute('opencode')).toBe(false);
  expect(isConversationRoute('not-a-route')).toBe(false);
  expect(isConversationRoute(undefined)).toBe(false);
});

test('a fresh home and a fresh project conversation are provisioned on the default route', async () => {
  const home = await provisionHome();
  expect(homeThread(home)).toMatchObject({
    engine: 'aws-bedrock',
    mode: 'auto',
    name: 'Diomedes',
  });
  // Nobody chose this: the marker that protects a person's own route is absent.
  expect(homeThread(home).engineChoice).toBeUndefined();

  const mine = await project('Linen service');
  const binding = await provisionProject(mine.id);
  expect(byId(mine.id, binding.threadId)).toMatchObject({ engine: 'aws-bedrock', mode: 'auto' });
  expect(byId(mine.id, binding.threadId).engineChoice).toBeUndefined();
  // The provisioned conversation route never touches the project's own Work route.
  expect(store().state(mine.id).project.ai?.engine ?? null).not.toBe('aws-bedrock');
});

test('unconfigured AWS is refused by name and nothing is admitted, sent or recorded', async () => {
  const home = await provisionHome();
  const file = store().statePath(home.projectId);
  const before = await fs.readFile(file);
  const sent = await sendRaw(home, 'm-early', 'Good morning');
  expect(sent.status).toBe(409);
  expect(await sent.text()).toContain('AWS Bedrock');
  // No provider call, no Claude adapter, no sign-in window, no native work.
  expect(seen).toHaveLength(0);
  expect(adapterCalls).toBe(0);
  expect(loginCalls).toBe(0);
  expect(nativeCalls).toBe(0);
  // Nothing was admitted for the refused message: no turn, no lineage, no write.
  const thread = homeThread(home);
  expect(thread.turns).toEqual([]);
  expect(thread.lineages ?? []).toEqual([]);
  expect((await fs.readFile(file)).equals(before)).toBe(true);
});

test('a bound home whose thread was never deliberately routed is re-pinned on the next provision', async () => {
  const home = await provisionHome();
  // A pin written before the choice marker existed: a route nobody picked.
  const state = store().state(home.projectId);
  const thread = state.conversations.find((item) => item.id === home.threadId)!;
  thread.engine = 'claude-code';
  delete thread.engineChoice;
  await store().persist(state);
  expect(homeThread(home).engine).toBe('claude-code');

  // The bound early return still migrates it, inside the same provision.
  expect(await provisionHome()).toEqual(home);
  expect(homeThread(home)).toMatchObject({ engine: 'aws-bedrock' });
  expect(homeThread(home).engineChoice).toBeUndefined();

  // The migration is once: a second provision finds the default and writes nothing.
  const persist = vi.spyOn(store(), 'persist');
  try {
    expect(await provisionHome()).toEqual(home);
    expect(persist).not.toHaveBeenCalled();
  } finally {
    persist.mockRestore();
  }
  // And the re-pin is durable, not a read-time view: a restart reads the same.
  await close();
  await open();
  expect(homeThread(home).engine).toBe('aws-bedrock');
});

test('an adopted pre-upgrade home thread is re-pinned to the default by the same provision', async () => {
  // A home as an older build left it on disk: the reserved project and its
  // designated thread routed to Claude, with no choice marker anywhere.
  const homeProject = await store().createProject('Diomedes', store().homeFolder());
  const stamped = now();
  const thread: Conversation = {
    id: identifier('C'),
    attachedTo: { kind: 'project', ref: homeProject.id },
    turns: [],
    name: 'Diomedes',
    createdAt: stamped,
    updatedAt: stamped,
    taskId: null,
    helper: null,
    permission: 'show-first',
    mode: 'auto',
    engine: 'claude-code',
  };
  const state = store().state(homeProject.id);
  state.conversations.push(thread);
  await store().persist(state);

  const home = await provisionHome();
  expect(home).toEqual({ projectId: homeProject.id, threadId: thread.id });
  expect(homeThread(home)).toMatchObject({
    engine: 'aws-bedrock',
    mode: 'auto',
    name: 'Diomedes',
  });
  expect(homeThread(home).engineChoice).toBeUndefined();
});

test('an adopted home thread the person already routed keeps that choice', async () => {
  // The same adoption state as above, except this thread was deliberately
  // routed: the binding is absent and the choice marker is present.
  const homeProject = await store().createProject('Diomedes', store().homeFolder());
  const stamped = now();
  const thread: Conversation = {
    id: identifier('C'),
    attachedTo: { kind: 'project', ref: homeProject.id },
    turns: [],
    name: 'Diomedes',
    createdAt: stamped,
    updatedAt: stamped,
    taskId: null,
    helper: null,
    permission: 'show-first',
    mode: 'auto',
    engine: 'claude-code',
    engineChoice: 'person',
  };
  const state = store().state(homeProject.id);
  state.conversations.push(thread);
  await store().persist(state);
  expect(store().settings.home).toBe(null);
  expect(store().homeBinding()).toBe(null);

  // Adoption binds the same thread and leaves the person's route untouched;
  // nothing in the project state changed, so it is not persisted again.
  const persist = vi.spyOn(store(), 'persist');
  try {
    const home = await provisionHome();
    expect(home).toEqual({ projectId: homeProject.id, threadId: thread.id });
    expect(persist).not.toHaveBeenCalled();
  } finally {
    persist.mockRestore();
  }
  expect(threadsOf(homeProject.id)).toHaveLength(1);
  expect(homeThread({ projectId: homeProject.id, threadId: thread.id })).toMatchObject({
    engine: 'claude-code',
    engineChoice: 'person',
  });
  // Settings still gains the binding: the home is adopted, not left unbound.
  expect(store().settings.home).toMatchObject({
    projectId: homeProject.id,
    threadId: thread.id,
  });
});

test('an adopted home thread already on the default is bound without a redundant write', async () => {
  // The same adoption state again, but the designated thread already carries
  // the default route: there is nothing to migrate.
  const homeProject = await store().createProject('Diomedes', store().homeFolder());
  const stamped = now();
  const thread: Conversation = {
    id: identifier('C'),
    attachedTo: { kind: 'project', ref: homeProject.id },
    turns: [],
    name: 'Diomedes',
    createdAt: stamped,
    updatedAt: stamped,
    taskId: null,
    helper: null,
    permission: 'show-first',
    mode: 'auto',
    engine: 'aws-bedrock',
  };
  const state = store().state(homeProject.id);
  state.conversations.push(thread);
  await store().persist(state);
  expect(store().settings.home).toBe(null);
  expect(store().homeBinding()).toBe(null);

  const persist = vi.spyOn(store(), 'persist');
  try {
    const home = await provisionHome();
    expect(home).toEqual({ projectId: homeProject.id, threadId: thread.id });
    // The binding is written to settings; the unchanged project state is not.
    expect(persist).not.toHaveBeenCalled();
  } finally {
    persist.mockRestore();
  }
  expect(threadsOf(homeProject.id)).toHaveLength(1);
  expect(homeThread({ projectId: homeProject.id, threadId: thread.id })).toMatchObject({
    engine: 'aws-bedrock',
  });
  expect(homeThread({ projectId: homeProject.id, threadId: thread.id }).engineChoice).toBeUndefined();
  expect(store().settings.home).toMatchObject({
    projectId: homeProject.id,
    threadId: thread.id,
  });
});

test('a route the person chose survives provisioning and restart, on home and on a project', async () => {
  const home = await provisionHome();
  const chosen = await api<Conversation>(
    `/projects/${home.projectId}/threads/${home.threadId}`,
    'PUT',
    { engine: 'claude-code' },
  );
  expect(chosen).toMatchObject({ engine: 'claude-code', engineChoice: 'person' });
  expect(await provisionHome()).toEqual(home);
  expect(homeThread(home)).toMatchObject({ engine: 'claude-code', engineChoice: 'person' });

  const mine = await project('Linen service');
  const binding = await provisionProject(mine.id);
  await api<Conversation>(`/projects/${mine.id}/threads/${binding.threadId}`, 'PUT', {
    engine: 'claude-code',
  });
  expect(await provisionProject(mine.id)).toEqual(binding);
  expect(byId(mine.id, binding.threadId)).toMatchObject({
    engine: 'claude-code',
    engineChoice: 'person',
  });

  await close();
  await open();
  expect(await provisionHome()).toEqual(home);
  expect(homeThread(home)).toMatchObject({ engine: 'claude-code', engineChoice: 'person' });
  expect(await provisionProject(mine.id)).toEqual(binding);
  expect(byId(mine.id, binding.threadId)).toMatchObject({
    engine: 'claude-code',
    engineChoice: 'person',
  });
});

test('reads provision and mutate nothing: the home read stays a read', async () => {
  expect(await readHome()).toBe(null);
  expect(store().settings.home).toBe(null);
  expect(await listed()).toEqual([]);

  const home = await provisionHome();
  const settingsFile = path.join(root, 'data', 'settings.json');
  const stateFile = store().statePath(home.projectId);
  const settingsBefore = await fs.readFile(settingsFile);
  const stateBefore = await fs.readFile(stateFile);
  expect(await readHome()).toEqual(home);
  expect(await readHome()).toEqual(home);
  expect(await listed()).toEqual([]);
  expect((await fs.readFile(settingsFile)).equals(settingsBefore)).toBe(true);
  expect((await fs.readFile(stateFile)).equals(stateBefore)).toBe(true);
});

test('a send on the provisioned default reaches the model driver with no Claude anywhere', async () => {
  await connect();
  await approveSpend();
  const home = await provisionHome();
  const sent = await send(home, 'm-hello', 'Good morning');
  expect(sent.answerText).toBe('answer:Good morning');
  expect(sent.outcome).toEqual({ status: 'answered' });
  // A model-API run answered it. No Claude adapter was constructed, no sign-in
  // window opened and no native worker ran.
  expect(sent.runId.startsWith('model-')).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0].authorization).toBe(`Bearer ${SECRET}`);
  expect(adapterCalls).toBe(0);
  expect(loginCalls).toBe(0);
  expect(nativeCalls).toBe(0);
  // The Diomedes conversation needs no target project and home is never one.
  expect(await listed()).toEqual([]);
  // The same command again replays its recorded outcome on the same run.
  expect(await send(home, 'm-hello', 'Good morning')).toEqual(sent);
  expect(seen).toHaveLength(1);
});

test('a consequential proposal from home still needs an explicit target, and home is never one', async () => {
  await connect();
  await approveSpend();
  const home = await provisionHome();
  const untargeted = await send(home, 'm-act', 'ACT order the usual');
  expect(untargeted.outcome).toMatchObject({ status: 'not-started', reason: 'needs-target' });
  const athome = await send(home, 'm-home', `TARGET ${home.projectId} order the usual`);
  expect(athome.outcome).toMatchObject({
    status: 'not-started',
    reason: 'home-is-not-a-target',
  });
  expect(store().state(home.projectId).tasks).toEqual([]);
});

test('a project conversation answers on the default independent of the project Work route', async () => {
  await connect();
  await approveSpend();
  const mine = await project('Linen service');
  await api(`/projects/${mine.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0, routes: ['aws-bedrock'], documents: [],
    shareConversationHistory: true, shareReviewPackets: false,
  });
  const state = store().state(mine.id);
  state.project.ai = { engine: 'sample', model: null };
  await store().persist(state);

  const binding = await provisionProject(mine.id);
  const sent = await send({ projectId: mine.id, threadId: binding.threadId }, 'm-p', 'Good morning');
  expect(sent.answerText).toBe('answer:Good morning');
  expect(sent.runId.startsWith('model-')).toBe(true);
  // The project's own route was never the conversation's to move.
  expect(store().state(mine.id).project.ai).toEqual({ engine: 'sample', model: null });
});

// Owner decision, 2026-09-23: Home is the person's own landing-page agent. Their typed message,
// with no document, goes to Home's route with no sharing grant. A document or the earlier
// conversation from Home still needs one.
test('a fresh Home sends typed messages with no grant, and no document or history without one', async () => {
  await connect();
  await approveSpend();
  const home = await provisionHome();
  expect((await api<{ version: number }>(`/projects/${home.projectId}/cloud-sharing`)).version).toBe(0);
  const first = await send(home, 'm-first', 'Good morning');
  expect(first.answerText).toBe('answer:Good morning');
  // The next message answers too, and carries no earlier turn: history is not shared.
  const second = await send(home, 'm-second', 'And tomorrow?');
  expect(second.answerText).toBe('answer:And tomorrow?');
  expect(seen).toHaveLength(2);
  expect(JSON.stringify(seen[1].body)).not.toContain('Good morning');

  // A document from Home is refused before it is read or anything is sent.
  await fs.writeFile(path.join(store().homeFolder(), 'menu.md'), 'Tomato soup and bread.\n');
  const document = await store().readDocument(home.projectId, 'menu.md');
  const withDocument = (commandId: string) => ({
    commandId,
    text: 'What is on the menu?',
    mode: 'auto',
    sources: [{ path: 'menu.md', sha: document.sha }],
    consent: true,
  });
  const refused = await request(messages(home), 'POST', withDocument('m-doc-refused'));
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { code?: string }).code).toBe('cloud_sharing_denied');
  expect(seen).toHaveLength(2);

  // Once Home's sharing names the document for this route, the same message goes with it.
  await api(`/projects/${home.projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0, routes: ['aws-bedrock'], documents: ['menu.md'],
    shareConversationHistory: false, shareReviewPackets: false,
  });
  await api<MessageResult>(messages(home), 'POST', withDocument('m-doc-granted'));
  expect(seen).toHaveLength(3);
  expect(JSON.stringify(seen[2].body)).toContain('menu.md');
});

// The 0.1.8 fix: the Nectovia page's own grant and revoke, sent exactly as the page sends them
// (client/console/home-history.ts), through the existing endpoint. History goes with a follow-up
// only while this route has the grant, and a grant for another route never brings it back.
test("Home's earlier messages go with a follow-up only while the page's grant covers this route", async () => {
  await connect();
  await approveSpend();
  const home = await provisionHome();
  const sharingPath = `/projects/${home.projectId}/cloud-sharing`;
  const read = () => api<HomeSharing>(sharingPath);
  const write = (change: HomeSharingChange) => api<HomeSharing>(sharingPath, 'PUT', change);
  const last = () => JSON.stringify(seen.at(-1)!.body);

  await send(home, 'm-1', 'Good morning');
  expect(last()).not.toContain('Earlier in this conversation');

  const granted = await write(shareHistory(await read(), 'aws-bedrock'));
  // The grant names the route and turns history on; it never touches documents or review packets.
  expect(granted).toEqual({
    version: 1,
    routes: ['aws-bedrock'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  await send(home, 'm-2', 'And tomorrow?');
  expect(last()).toContain('Earlier in this conversation');
  expect(last()).toContain('Good morning');

  const revoked = await write(stopSharingHistory(await read(), 'aws-bedrock'));
  expect(revoked).toEqual({
    version: 2,
    routes: [],
    documents: [],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  await send(home, 'm-3', 'And the day after?');
  expect(last()).not.toContain('Earlier in this conversation');
  expect(last()).not.toContain('Good morning');

  // Another route's grant turns the one switch back on, and this route stays alone.
  const elsewhere = await write(shareHistory(await read(), 'claude-code'));
  expect(elsewhere).toMatchObject({ routes: ['claude-code'], shareConversationHistory: true });
  await send(home, 'm-4', 'Still alone?');
  expect(last()).not.toContain('Earlier in this conversation');
  expect(last()).not.toContain('Good morning');
  expect(seen).toHaveLength(4);
});
