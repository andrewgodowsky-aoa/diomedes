/**
 * WorkStyle on the Diomedes conversation's default route, AWS Bedrock on Luna,
 * through the real app over HTTP with a fake AWS endpoint (the same harness as
 * home-luna-routing.test.ts). The route binds its reasoning level into a
 * lineage's saved context, so a style's level follows style and mode only, and
 * a style change that moves it starts the next lineage. A style that needs a
 * model the route does not offer is refused before anything is sent.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
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
import type { AwsConnectionView } from '../shared/model-api';
import type { MessageResult } from '../shared/conversation';
import type { Conversation } from '../shared/types';

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
  return new Response(JSON.stringify(envelope(respond(body))), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-amzn-requestid': `req-${seen.length}` },
  });
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
const threadsOf = (projectId: string) => store().state(projectId).conversations;
const homeThread = (home: Binding) =>
  threadsOf(home.projectId).find((thread) => thread.id === home.threadId)!;
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


const effortOf = (index: number) =>
  (JSON.stringify(seen[index].body).match(/"effort":"(\w+)"/) ?? [])[1] ?? null;
const style = (binding: Binding, workStyle: string | null) =>
  api<Conversation>(`/projects/${binding.projectId}/threads/${binding.threadId}`, 'PUT', { workStyle });

test('no style sends what it sent before; a style sends its level and opens its own lineage', async () => {
  await connect();
  await approveSpend();
  const home = await provisionHome();
  const first = await send(home, 'm-1', 'What is on today?');
  expect(effortOf(0)).toBe('low');
  expect(homeThread(home).lineages?.at(-1)?.effort).toBeUndefined();

  // Efficient on Luna: the model it already runs. The level is now the style's, so the
  // lineage opened without one is retired at this boundary and the next one records it.
  await style(home, 'efficient');
  const second = await send(home, 'm-2', 'And tomorrow?');
  expect(second.runId).not.toBe(first.runId);
  expect(effortOf(1)).toBe('low');
  const lineages = homeThread(home).lineages ?? [];
  expect(lineages.find((l) => l.runId === first.runId)?.retired).toBe('scope-change');
  expect(lineages.at(-1)).toMatchObject({ runId: second.runId, effort: 'low' });

  // The same style again continues the same lineage.
  const third = await send(home, 'm-3', 'Thanks for that list, what else?');
  expect(third.runId).toBe(second.runId);
  expect(seen).toHaveLength(3);
});

test('a style whose model the route lacks is refused by name and nothing is sent', async () => {
  await connect();
  await approveSpend();
  const home = await provisionHome();
  await style(home, 'focused');
  const refused = await sendRaw(home, 'm-focused', 'Review the plan for next week.');
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain('Sol');
  expect(seen).toHaveLength(0);
  // A greeting stays cheap in Thorough: Luna answers it rather than refusing.
  await style(home, 'thorough');
  const hello = await send(home, 'm-hi', 'hello');
  expect(hello.answerText).toBe('answer:hello');
  expect(seen).toHaveLength(1);
  expect((await sendRaw(home, 'm-audit', 'Audit the quarterly numbers.')).status).toBe(409);
  expect(seen).toHaveLength(1);
});

test('a style never changes the conversation Mode or its route', async () => {
  await connect();
  const home = await provisionHome();
  const before = homeThread(home);
  for (const workStyle of ['efficient', 'focused', 'thorough', null]) {
    const after = await style(home, workStyle);
    expect(after).toMatchObject({ mode: before.mode, engine: before.engine, permission: before.permission });
  }
});
