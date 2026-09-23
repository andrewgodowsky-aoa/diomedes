/**
 * A project thread whose tier puts it on a model-API route sends Ask and Plan through the
 * conversation, and Build and Fix through the direct request path (owner decisions 2026-09-23).
 *
 * The client half is the module the Console's thread sends through (`client/console/thread-send.ts`
 * over `client/conversation-send.ts`), driven against the real host over HTTP: the client's
 * `/api` requests are forwarded to a real server with the real Store, interaction service,
 * model-session driver, read tools, Native Work, Need and recorded writer. Only the network
 * under the AI SDK is replaced, with captured-shape Responses streams, so nothing reaches a
 * provider and nothing is spent. The browser's storage and Web Locks are in-process fakes.
 *
 * What this proves is the decision and the wire: the route is the host's, the right path is
 * taken, the turn lands in the thread's own history, Stop names the command, and a tier that
 * cannot run is refused by name before anything is sent. The streamed frames are folded here
 * with the same pure functions the thread's live view uses; the rendered view is not driven.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { testOnlySecretBox } from '../server/connection-secrets';
import type { Store } from '../server/store';
import { api as clientApi } from '../client/api';
import { pendingMessage, type DispatchIdentity } from '../client/conversation-send';
import {
  directAskBody,
  planThreadSend,
  readThreadRoute,
  sendThreadConversation,
  stopThreadMessage,
} from '../client/console/thread-send';
import { acceptPreview, type PreviewPosition } from '../client/console/engine-text-preview';
import { acceptActivity, activityTarget, toolSentence, type ActivityState } from '../client/console/engine-activity';
import type { AwsConnectionView } from '../shared/model-api';
import type { Conversation, Mode, Project, ProjectState } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import { ROUTES } from '../shared/engines';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const ORDER = { path: 'Linen order 1182.md', text: '# Order 1182\n\n100 napkins, delivery Friday.\n' };
const DELIVERY = {
  path: 'Friday delivery.md',
  text: '# Friday delivery\n\n94 napkins. The driver noted 6 napkins short.\n',
};

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let project: Project;
let thread: Conversation;
let folder: string;
const realFetch = globalThis.fetch;

// --- the fake AWS Responses endpoint ------------------------------------------------

type Item = Record<string, unknown>;
let seen: { body: { input: Item[]; tools?: Item[]; model?: string } }[];
let hang: { waiting: boolean };
let frames: (Record<string, unknown> & { channel: 'text' | 'activity' })[];
/** Every request the client made, by path, so a refusal can be shown to have sent nothing. */
let clientCalls: string[];

const userText = (body: { input: Item[] }) => {
  const user = body.input.find((item) => item.role === 'user');
  const content = user?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => String((part as Item).text ?? '')).join('') : '';
};
const answer = (text: string): Item => ({
  type: 'message',
  id: `msg_${seen.length}`,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

function respond(body: { input: Item[]; tools?: Item[] }): Item[] | 'hang' {
  const text = userText(body);
  if (!body.tools?.length) {
    // A Work call: a strict JSON file proposal.
    return [
      answer(
        JSON.stringify({
          summary: 'Draft a linen checklist',
          changes: [{ path: 'Linen checklist.md', text: '# Linen checklist\n\n- [ ] Count napkins\n', summary: 'A new checklist.' }],
        }),
      ),
    ];
  }
  const message = text.split("The person's message:\n\n")[1] ?? '';
  const said = message.split('\n\n[[diomedes')[0];
  if (said.startsWith('SLOW')) return 'hang';
  if (said.includes('napkins')) {
    const result = body.input.find((item) => item.type === 'function_call_output');
    if (!result)
      return [
        {
          type: 'function_call',
          id: `fc_${seen.length}`,
          call_id: 'call_linen_1',
          // A host-run tool, the kind that narrates itself as tool activity. A model-API Ask
          // reads the documents chosen for it (security pass 2026-09-23), not the folder.
          name: 'read_source',
          arguments: JSON.stringify({ path: DELIVERY.path }),
          status: 'completed',
        },
      ];
    return [answer(String(result.output).includes('6 napkins short') ? 'Six napkins were short on Friday.' : 'Not found.')];
  }
  return [answer(`answer:${said}`)];
}

const aws = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as (typeof seen)[number]['body'];
  seen.push({ body });
  const output = respond(body);
  if (output === 'hang') {
    hang.waiting = true;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
  }
  return sseResponse(
    responsesEvents({
      id: `resp_${seen.length}`,
      object: 'response',
      created_at: 1_790_000_000,
      status: 'completed',
      model: AWS_LUNA_MODEL,
      output,
      usage: { input_tokens: 500, output_tokens: 60, total_tokens: 560 },
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-${seen.length}` },
  );
}) as typeof globalThis.fetch;

// --- a browser's storage and locks, in process --------------------------------------

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}
function makeLocks() {
  const tail = new Map<string, Promise<void>>();
  return {
    async request(name: string, _options: { signal?: AbortSignal }, callback: () => unknown) {
      const previous = tail.get(name) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      tail.set(name, previous.then(() => mine));
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    },
  };
}

// --- the app ------------------------------------------------------------------------

async function request(route: string, method = 'GET', body?: unknown) {
  return realFetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
const store = () => app.locals.store as Store;
const current = () => store().state(project.id).conversations.find((item) => item.id === thread.id)!;
const connectAws = async () => {
  await api<AwsConnectionView>('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey: SECRET,
    expiresAt: null,
    consent: true,
  });
  await api<AwsConnectionView>('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  // What the tier map needs to call AWS ready: turned on, with an account route saved.
  const settings = await api<{ services?: Record<string, unknown> }>('/settings');
  expect(settings.services?.['aws-bedrock']).toBe(true);
  expect(typeof settings.services?.['aws-bedrockAccountRoute']).toBe('string');
  // The tier decides the route, not a saved default.
  expect(settings.services?.defaultEngine).not.toBe('aws-bedrock');
};
const tier = (workStyle: 'efficient' | 'focused' | 'thorough') =>
  api<Conversation>(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { workStyle });
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Exactly what the thread's Send does before it sends: the host's route, then the plan. */
const plan = async (mode: Mode, skill?: string) =>
  planThreadSend(await readThreadRoute(project.id, thread.id), mode, skill);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-thread-conversation-'));
  seen = [];
  hang = { waiting: false };
  frames = [];
  clientCalls = [];
  vi.stubGlobal('sessionStorage', makeStorage());
  vi.stubGlobal('localStorage', makeStorage());
  vi.stubGlobal('navigator', { locks: makeLocks() });
  // The Console's `/api/...` requests reach the real host; nothing else is rerouted.
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/')) {
      clientCalls.push(url.split('?')[0]);
      return realFetch(`${base}${url}`, init);
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch);
  const engines = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: aws,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store().on('engine-text', (frame: Record<string, unknown>) => frames.push({ ...structuredClone(frame), channel: 'text' }));
  store().on('engine-activity', (frame: Record<string, unknown>) =>
    frames.push({ ...structuredClone(frame), channel: 'activity' }),
  );
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  folder = store().state(project.id).project.folder;
  for (const doc of [ORDER, DELIVERY]) await fs.writeFile(path.join(folder, doc.path), doc.text, 'utf8');
  // Default-deny cloud sharing: this synthetic project grants every cloud route its files
  // and history, so the behaviour under test is reached.
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ROUTES.filter((route) => route !== 'sample'),
    documents: [ORDER.path, DELIVERY.path],
    shareConversationHistory: true,
    shareReviewPackets: true,
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe('a project thread on AWS through its tier', () => {
  test('Ask goes through the conversation: streamed, one sentence per tool call, saved in the thread', async () => {
    await connectAws();
    await tier('efficient');
    // The recorded route is not AWS; the tier is what puts this thread there.
    expect(current().engine ?? null).not.toBe('aws-bedrock');
    const decided = await plan('ask');
    expect(decided).toEqual({ kind: 'conversation', route: 'aws-bedrock', mode: 'ask' });

    let issued: DispatchIdentity | null = null;
    const result = await sendThreadConversation({
      projectId: project.id,
      threadId: thread.id,
      text: 'How many napkins were short on Friday?',
      mode: 'ask',
      paths: [DELIVERY.path],
      onClaim: (identity) => (issued = identity),
    });
    expect(result.answerText).toBe('Six napkins were short on Friday.');
    expect(result.interrupted).toBe(false);
    expect(issued).toEqual({ projectId: project.id, threadId: thread.id, commandId: result.commandId });
    // Sent on the conversation path, never on the direct request path.
    expect(clientCalls.some((call) => call.endsWith(`/threads/${thread.id}/messages`))).toBe(true);
    expect(clientCalls.some((call) => call.endsWith('/ask'))).toBe(false);

    // The model got the read tools and exactly the source the person chose, by name only.
    expect(seen[0].body.tools?.length).toBeGreaterThan(0);
    expect(seen[0].body.model).toBe(AWS_LUNA_MODEL);
    expect(userText(seen[0].body)).toContain(DELIVERY.path);
    expect(userText(seen[0].body)).not.toContain(ORDER.path);

    // Streamed on this thread under this command, and folded as the thread's live view folds it.
    const text = frames.filter((frame) => frame.channel === 'text' && frame.threadId === thread.id);
    expect(text[0]).toMatchObject({ projectId: project.id, requestId: result.commandId, runId: result.runId, kind: 'started' });
    expect(text.at(-1)).toMatchObject({ requestId: result.commandId, kind: 'ended' });
    const ask = { requestId: result.commandId, runId: result.runId, threadId: thread.id };
    let activity: ActivityState | null = null;
    // What reached the events stream, without this test's own channel tag.
    const bare = ({ channel: _channel, ...frame }: (typeof frames)[number]) => frame;
    for (const frame of frames.filter((item) => item.channel === 'activity').map(bare)) {
      expect(activityTarget(frame, { projectId: project.id, ask })).toEqual({ kind: 'ask', requestId: result.commandId });
      activity = acceptActivity(activity, frame);
    }
    expect(activity?.lines).toHaveLength(1);
    expect(toolSentence(activity!.lines[0])).toMatch(/Friday delivery\.md/);
    // The answer's own step streams its text in order (the tool step before it has none).
    const answerDeltas = text
      .filter((frame) => frame.kind === 'delta' && String(frame.text ?? '').length > 0)
      .map(bare);
    const step = answerDeltas.at(-1)?.stepId;
    let position: PreviewPosition = null;
    let preview = '';
    for (const frame of answerDeltas.filter((item) => item.stepId === step)) {
      const accepted = acceptPreview(position, { ...frame, kind: 'text-delta' });
      if (accepted.kind === 'append') {
        position = accepted.cursor;
        preview += accepted.text;
      }
    }
    expect(answerDeltas.length).toBeGreaterThan(0);
    expect(preview).toBe('Six napkins were short on Friday.');

    // Saved in the thread's own history, once, attributed to the route that answered.
    const turns = current().turns;
    expect(turns.map((turn) => turn.role)).toEqual(['you', 'assistant']);
    expect(turns[0]).toMatchObject({ mode: 'ask', text: 'How many napkins were short on Friday?', route: 'aws-bedrock' });
    expect(turns[1]).toMatchObject({ mode: 'ask', text: 'Six napkins were short on Friday.', route: 'aws-bedrock', sources: [DELIVERY.path] });
    expect(turns[1].origin).toMatchObject({ engine: { id: 'aws-bedrock' }, model: { requested: AWS_LUNA_MODEL } });
    // Nothing is left pending in the browser.
    expect(pendingMessage(project.id, thread.id)).toBeNull();
  });

  test('Plan goes through the conversation and, as there, saves no Plan document', async () => {
    await connectAws();
    await tier('efficient');
    const before = (await fs.readdir(folder)).sort();
    const decided = await plan('plan');
    expect(decided).toEqual({ kind: 'conversation', route: 'aws-bedrock', mode: 'plan' });
    const result = await sendThreadConversation({
      projectId: project.id,
      threadId: thread.id,
      text: 'Plan the Friday linen count',
      mode: 'plan',
      paths: [],
    });
    expect(result.answerText).toBe('answer:Plan the Friday linen count');
    // Plan-only never proposes or starts anything from a thread.
    expect(result.outcome.status).not.toBe('proposed');
    expect(result.outcome.status).not.toBe('started');
    expect(current().turns.map((turn) => [turn.role, turn.mode, turn.route])).toEqual([
      ['you', 'plan', 'aws-bedrock'],
      ['assistant', 'plan', 'aws-bedrock'],
    ]);
    expect((await fs.readdir(folder)).sort()).toEqual(before);
    expect(store().state(project.id).sessions).toHaveLength(0);
  });

  test('Stop during a turn interrupts that command; the thread keeps going', async () => {
    await connectAws();
    await tier('efficient');
    let issued: DispatchIdentity | null = null;
    const pending = sendThreadConversation({
      projectId: project.id,
      threadId: thread.id,
      text: 'SLOW think about the invoices for a long time',
      mode: 'ask',
      paths: [],
      onClaim: (identity) => (issued = identity),
    });
    await until(() => hang.waiting, Boolean, 'the call to reach AWS');
    expect(issued).not.toBeNull();
    let abandoned = false;
    expect(await stopThreadMessage(issued, () => (abandoned = true))).toBe('interrupted');
    // The request was not abandoned: it returns the recorded, stopped turn and settles.
    expect(abandoned).toBe(false);
    const result = await pending;
    expect(result.interrupted).toBe(true);
    expect(result.answerText).toBeNull();
    expect(pendingMessage(project.id, thread.id)).toBeNull();

    // The next message on the same thread is not refused as an earlier unconfirmed one.
    const next = await sendThreadConversation({
      projectId: project.id,
      threadId: thread.id,
      text: 'Good morning',
      mode: 'ask',
      paths: [],
    });
    expect(next.answerText).toBe('answer:Good morning');
    expect(current().turns.filter((turn) => turn.role === 'assistant').at(-1)?.text).toBe('answer:Good morning');
  });

  test('Build still goes through the direct request path, on the route the host resolved', async () => {
    await connectAws();
    await tier('efficient');
    const decided = await plan('build');
    expect(decided).toEqual({ kind: 'direct', route: 'aws-bedrock' });
    if (decided.kind !== 'direct') throw new Error('expected the direct path');
    await clientApi(
      `/projects/${project.id}/ask`,
      'POST',
      directAskBody({ thread: current(), mode: 'build', text: 'Draft a linen checklist', route: decided.route, sources: [] }),
    );
    const state = await until(
      () => api<ProjectState>(`/projects/${project.id}/state`),
      (value) => value.needs.some((need) => need.state === 'open'),
      'an open Need',
    );
    expect(state.sessions.at(-1)?.route).toBe('aws-bedrock');
    // One Work call with no tools, and no conversation traffic at all.
    expect(seen.every((call) => !call.body.tools?.length)).toBe(true);
    expect(clientCalls.some((call) => call.includes('/messages'))).toBe(false);
    expect(current().lineages ?? []).toEqual([]);
    // Nothing is written before the exact approval.
    await expect(fs.stat(path.join(folder, 'Linen checklist.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a thread whose tier route is not connected is refused by name before anything is sent', async () => {
    await tier('efficient');
    const view = await readThreadRoute(project.id, thread.id);
    expect(view.route).toBe('aws-bedrock');
    expect(view.refusal).toMatch(/^Efficient runs on AWS Bedrock .*not connected and turned on/);
    for (const mode of ['ask', 'plan', 'build', 'fix'] as const)
      expect(planThreadSend(view, mode)).toEqual({ kind: 'refuse', reason: view.refusal });
    // Nothing was sent: the client only read the route.
    expect(clientCalls.every((call) => call.endsWith('/work-style'))).toBe(true);
    // The host refuses the same way if the conversation is reached anyway, and sends nothing.
    const refused = await request(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', {
      commandId: 'm-refused',
      text: 'How many napkins?',
      mode: 'ask',
      sources: [],
      consent: true,
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain(view.refusal!);
    expect(seen).toHaveLength(0);
    expect(current().turns).toEqual([]);

    // Focused maps to Google Vertex AI, which this build does not have yet: refused by that name.
    await tier('focused');
    const focused = await readThreadRoute(project.id, thread.id);
    expect(focused.refusal).toMatch(/^Focused runs on Google Vertex AI/);
    expect(planThreadSend(focused, 'ask')).toMatchObject({ kind: 'refuse' });
  });
});

describe('threads that are not on a model-API route keep their path', () => {
  test('a Claude Code thread with no tier sends every mode through the direct request path, as before', async () => {
    const chosen = await api<Conversation>(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'claude-code' });
    expect(chosen.engine).toBe('claude-code');
    const view = await readThreadRoute(project.id, thread.id);
    expect(view).toEqual({ route: 'claude-code', refusal: null });
    for (const mode of ['ask', 'plan', 'build', 'fix'] as const)
      expect(planThreadSend(view, mode)).toEqual({ kind: 'direct', route: 'claude-code' });
    // The body the thread posts is the one it always posted.
    expect(
      directAskBody({ thread: chosen, mode: 'ask', text: 'Summarise the order', route: 'claude-code', sources: [ORDER.path] }),
    ).toEqual({
      mode: 'ask',
      text: 'Summarise the order',
      route: 'claude-code',
      consent: true,
      threadId: thread.id,
      attachedTo: chosen.attachedTo,
      sources: [ORDER.path],
    });
    expect(clientCalls.some((call) => call.includes('/messages'))).toBe(false);
  });
});
