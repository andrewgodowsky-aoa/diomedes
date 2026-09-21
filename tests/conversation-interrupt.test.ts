/**
 * Message-scoped Stop, over HTTP through the real app: the path names the
 * command and nothing else, the durable turn record is the authority, and the
 * driver that owns the command's run is the only one asked to signal it. The
 * Claude fixture transport and the fake AWS Responses endpoint both hold a turn
 * until their signal fires, so `requested`, `settled`, `idle` and `superseded`
 * are observable facts, never forged state. A client that drops its connection
 * while a provider session is held open lets the admitted input's own signal
 * close the prepared session before anything is dispatched.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import { EngineError } from '../server/engines/process';
import type { PersistentTextAdapter, TextRequest } from '../server/engines/contract';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { routeContractFor } from '../server/harness/route-contract';
import { testOnlySecretBox } from '../server/connection-secrets';
import { hash } from '../server/store';
import type { AwsConnectionView } from '../shared/model-api';
import type { InterruptResponse, MessageResult } from '../shared/conversation';
import type { Conversation, Project } from '../shared/types';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const model = 'claude-fixture';
const accountRoute = 'claude-code:claude.ai';

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let project: Project;
let thread: Conversation;
let dispatches: TextRequest[];
let heldClaude: string[];
/** When set, the fake Claude session open parks on it: a held preparation. */
let heldOpen: Promise<void> | null;
let opens: number;
let closes: number;
/** Set when the server sees the response to a message POST close. */
let responseClosed: boolean;
/**
 * Every HTTP request the fixture has in flight. Each is observed the moment it
 * is created and removed when it settles, so a failed assertion can never leave
 * a held request to reject unobserved at teardown. The promise a caller holds
 * is the fetch's own; its rejection still belongs to that caller.
 */
const inflight = new Set<Promise<Response>>();

// --- the fake AWS Responses endpoint ------------------------------------------------

type Item = Record<string, unknown>;
let seen: { url: string; authorization: string | null; body: { input: Item[] } }[];
/** How many provider calls are parked waiting for their signal. */
let hangs: number;

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

/** 'SLOW...' parks until its signal fires; 'FAIL...' is a provider refusal; anything else answers. */
function respond(body: { input: Item[] }): Item[] | 'hang' | 'fail' {
  const text = userText(body);
  const message = text.split("The person's message:\n\n")[1] ?? '';
  const said = message.split('\n\n[[diomedes')[0];
  if (said.startsWith('SLOW')) return 'hang';
  if (said.startsWith('FAIL')) return 'fail';
  return [answer(`answer:${said}`)];
}

const aws = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headersIn = new Headers(init?.headers);
  const body = JSON.parse(String(init?.body)) as { input: Item[] };
  seen.push({ url: String(input), authorization: headersIn.get('authorization'), body });
  const output = respond(body);
  if (output === 'hang') {
    hangs += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
        once: true,
      });
    });
  }
  if (output === 'fail')
    return new Response(JSON.stringify({ error: { message: 'Fixture provider failure' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  return new Response(JSON.stringify(envelope(output)), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-amzn-requestid': `req-${seen.length}` },
  });
}) as typeof globalThis.fetch;

// --- the app ------------------------------------------------------------------------

function request(route: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const pending = fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  inflight.add(pending);
  void pending.then(
    () => inflight.delete(pending),
    () => inflight.delete(pending),
  );
  return pending;
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
    engineService: service,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: aws,
    nativeGenerator: async () => {
      throw new Error('No native work runs in this fixture');
    },
    nativeLoginLaunch: () => {
      throw new Error('No native sign-in window opens in this fixture');
    },
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  // Registered at request time, before the route's own close listener, so when
  // this flag is set the request-context signal has already been aborted.
  server.on('request', (req, res) => {
    if (req.method === 'POST' && req.url?.endsWith('/messages'))
      res.once('close', () => {
        responseClosed = true;
      });
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  // Held requests reject as their sockets are torn down; each was observed when
  // it was made, and the drain waits for every one before the data directory is
  // removed. A request's own rejection still belongs to whoever awaits it.
  await Promise.allSettled([...inflight]);
}
let service: EngineService;

/**
 * The fake Claude session. A turn whose text says HOLD parks until the merged
 * turn signal fires, then reports the way a provider that acknowledged the stop
 * reports: an idle checkpoint and a CANCELLED error, which the driver records
 * as an interrupted turn.
 */
function claudeAdapter(): PersistentTextAdapter<ClaudeSessionCheckpoint> {
  return {
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
    openSession: async (input, options) => {
      opens += 1;
      if (heldOpen) await heldOpen;
      let checkpoint: ClaudeSessionCheckpoint = options.restore
        ? structuredClone(options.restore)
        : {
            version: 1,
            nativeSessionId: randomUUID(),
            lineageId: randomUUID(),
            parentSessionId: null,
            projectId: input.projectId,
            threadId: input.threadId,
            cwd: root,
            cliVersion: TESTED_VERSIONS['claude-code'],
            accountDigest: hash('fixture-account')!,
            requestedModel: input.model,
            reportedModel: null,
            instructionDigest: hash(input.instructions)!,
            state: 'idle',
            requests: [],
            results: [],
          };
      const signal = new AbortController().signal;
      return {
        get checkpoint() {
          return structuredClone(checkpoint);
        },
        get nativeSession() {
          return checkpoint.nativeSessionId && checkpoint.reportedModel
            ? {
                providerId: 'claude-code',
                lineageId: checkpoint.lineageId,
                opaqueRef: checkpoint.nativeSessionId,
              }
            : null;
        },
        turn: async (turn) => {
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          dispatches.push(turn);
          if (turn.prompt.includes('HOLD')) {
            heldClaude.push(turn.requestId);
            await new Promise<void>((_resolve, reject) => {
              const stop = async () => {
                checkpoint = { ...checkpoint, state: 'idle' };
                await options.onCheckpoint(checkpoint, signal).catch(() => undefined);
                reject(
                  new EngineError('CANCELLED', 'The fixture acknowledged interruption.'),
                );
              };
              if (turn.signal?.aborted) void stop();
              else turn.signal?.addEventListener('abort', () => void stop(), { once: true });
            });
          }
          const text = `answer:${turn.prompt}`;
          turn.onDelta?.(text);
          checkpoint = {
            ...checkpoint,
            state: 'idle',
            reportedModel: model,
            results: [...checkpoint.results, { id: turn.requestId, digest: hash(text)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          return {
            text,
            model,
            version: TESTED_VERSIONS['claude-code'],
            projectId: turn.projectId,
            threadId: turn.threadId,
            requestId: turn.requestId,
          };
        },
        interrupt: async () => {
          throw new Error('The command-scoped Stop never calls interrupt()');
        },
        close: async () => {
          closes += 1;
        },
      };
    },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-interrupt-'));
  dispatches = [];
  heldClaude = [];
  heldOpen = null;
  opens = 0;
  closes = 0;
  responseClosed = false;
  seen = [];
  hangs = 0;
  const adapter = claudeAdapter();
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
  await open();
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/claude-code', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'claude-code', model });
  await api<AwsConnectionView>('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey: SECRET,
    expiresAt: null,
    consent: true,
  });
  await api<AwsConnectionView>('/ai/model-api/aws-bedrock/spend-limit', 'PUT', {
    capUsd: 1,
    consent: true,
  });
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

const messages = (threadId = thread.id) =>
  `/projects/${project.id}/threads/${threadId}/messages`;
const message = (commandId: string, text: string) => ({
  commandId,
  text,
  mode: 'auto',
  sources: [],
  consent: true,
});
const send = (commandId: string, text: string) => api<MessageResult>(messages(), 'POST', message(commandId, text));
const sendRaw = (commandId: string, text: string) => request(messages(), 'POST', message(commandId, text));
const interrupt = (commandId: string, threadId = thread.id) =>
  api<InterruptResponse>(`${messages(threadId)}/${commandId}/interrupt`, 'POST');
const interruptRaw = (commandId: string, threadId = thread.id, body?: unknown) =>
  request(`${messages(threadId)}/${commandId}/interrupt`, 'POST', body);
const routeTo = (engine: 'claude-code' | 'aws-bedrock') =>
  api<Conversation>(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine });

async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  what: string,
): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

test('the interrupt endpoint names the command in its path and takes nothing else', async () => {
  await routeTo('aws-bedrock');
  // A malformed command id is 400.
  expect((await interruptRaw('bad id')).status).toBe(400);
  expect((await interruptRaw('x'.repeat(200))).status).toBe(400);
  // Any object body at all is refused by the endpoint before the command is
  // ever looked up.
  for (const body of [{ note: 'x' }, { engine: 'claude-code' }, { runId: 'model-abc' }]) {
    const refused = await interruptRaw('m-never', thread.id, body);
    expect([body, refused.status]).toEqual([body, 400]);
    expect(await refused.text()).toContain('no body');
  }
  // A scalar JSON payload is refused earlier still: the app's strict JSON
  // parser rejects it before the endpoint is reached, with its own wording.
  const scalar = await interruptRaw('m-never', thread.id, 'halt');
  expect(scalar.status).toBe(400);
  expect(await scalar.json()).toEqual({ error: 'The request is not valid JSON or is too large.' });
  // A project that is not there is 404 before the endpoint is reached.
  expect(
    (await request(`/projects/nosuch/threads/${thread.id}/messages/m-x/interrupt`, 'POST')).status,
  ).toBe(404);
  // A well-formed command that never ran is 404, true at that instant and not a
  // promise it can never run: sending it now works, and stopping it then is settled.
  expect((await interruptRaw('m-never')).status).toBe(404);
  const sent = await send('m-never', 'Good morning');
  expect(sent.outcome).toEqual({ status: 'answered' });
  expect(await interrupt('m-never')).toEqual({
    commandId: 'm-never',
    runId: sent.runId,
    state: 'settled',
  });
  // A command that lives on another thread is not found on this one.
  const other = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  expect((await interruptRaw('m-never', other.id)).status).toBe(404);
});

test('an active turn is requested to stop, and its own recorded result is the authority', async () => {
  await routeTo('aws-bedrock');
  const pending = sendRaw('m-slow', 'SLOW think about the linen order');
  await until(() => hangs, (value) => value >= 1, 'the turn to reach the provider');
  const stop = await interrupt('m-slow');
  expect(stop.commandId).toBe('m-slow');
  expect(stop.state).toBe('requested');
  expect(stop.runId?.startsWith('model-')).toBe(true);

  const result = (await (await pending).json()) as MessageResult;
  expect(result.runId).toBe(stop.runId);
  expect(result.interrupted).toBe(true);
  expect(result.answerText).toBeNull();
  // The acknowledgement is not the durable fact; the recorded turn is. Both agree here.
  const outcome = await api<MessageResult>(`${messages()}/m-slow`);
  expect(outcome.interrupted).toBe(true);
  expect(outcome.outcome.status).toBe('unresolved');
  // A duplicate Stop is bound to the command's own record: settled, not re-signalled.
  expect(await interrupt('m-slow')).toEqual({
    commandId: 'm-slow',
    runId: stop.runId,
    state: 'settled',
  });
  expect(hangs).toBe(1);
});

test('an answered command is settled; a failed turn and a terminal run are idle', async () => {
  await routeTo('aws-bedrock');
  const done = await send('m-done', 'Good morning');
  expect(await interrupt('m-done')).toEqual({
    commandId: 'm-done',
    runId: done.runId,
    state: 'settled',
  });

  // A turn the provider refused left no recorded result: its Stop is idle, and
  // it stays idle once the run itself is terminal; settled is never fabricated.
  const failed = await sendRaw('m-fail', 'FAIL this one');
  expect(failed.ok).toBe(false);
  // The refusal was a real provider call: one answered turn plus one refused one.
  expect(seen).toHaveLength(2);
  expect(await interrupt('m-fail')).toEqual({
    commandId: 'm-fail',
    runId: done.runId,
    state: 'idle',
  });
  await api(`/projects/${project.id}/harness/runs/${done.runId}/cancel`, 'POST', {
    reason: 'test',
  });
  expect((await interrupt('m-fail')).state).toBe('idle');
  // The settled command reads its own result even on the terminal run.
  expect((await interrupt('m-done')).state).toBe('settled');
});

test('a Stop for an older command while a newer one is active is superseded and touches nothing', async () => {
  await routeTo('aws-bedrock');
  const failed = await sendRaw('m-old', 'FAIL first');
  expect(failed.ok).toBe(false);
  const pending = sendRaw('m-new', 'SLOW second');
  await until(() => hangs, (value) => value >= 1, 'the newer turn to reach the provider');

  // The Stop is scoped to the command it names: the active one is not signalled.
  expect((await interrupt('m-old')).state).toBe('superseded');
  expect(await interrupt('m-new')).toMatchObject({ state: 'requested' });
  const result = (await (await pending).json()) as MessageResult;
  expect(result.interrupted).toBe(true);
  // After it lands: the interrupted command is settled by its own record, the
  // failed one is idle, and the duplicate of either never reaches a new turn.
  expect((await interrupt('m-new')).state).toBe('settled');
  expect((await interrupt('m-old')).state).toBe('idle');
});

test('a Stop follows the command\'s own run across a route change, and replay keeps the original driver', async () => {
  await routeTo('claude-code');
  const pending = sendRaw('m-old', 'HOLD please');
  await until(() => heldClaude, (value) => value.includes('m-old'), 'the held native turn');
  const stop = await interrupt('m-old');
  expect(stop.state).toBe('requested');
  expect(stop.runId?.startsWith('claude-')).toBe(true);
  const result = (await (await pending).json()) as MessageResult;
  expect(result.interrupted).toBe(true);
  const claudeRun = result.runId;
  expect(claudeRun).toBe(stop.runId);
  const claudeCalls = dispatches.length;

  // Re-routing the thread starts a new model- lineage; the old run stays as
  // evidence under its own driver, and a Stop still finds the command there.
  await routeTo('aws-bedrock');
  const slow = sendRaw('m-new', 'SLOW newer');
  await until(() => hangs, (value) => value >= 1, 'the model turn to reach the provider');
  expect(await interrupt('m-old')).toEqual({
    commandId: 'm-old',
    runId: claudeRun,
    state: 'settled',
  });
  // The Stop for the old command never reached the live model turn.
  expect((await interrupt('m-new')).state).toBe('requested');
  expect(((await (await slow).json()) as MessageResult).interrupted).toBe(true);

  // Re-sending the interrupted command reads its recorded outcome back on the
  // run it actually took: no second dispatch, no provider call, on either driver.
  const replay = await send('m-old', 'HOLD please');
  expect(replay.runId).toBe(claudeRun);
  expect(replay.interrupted).toBe(true);
  expect(dispatches).toHaveLength(claudeCalls);
  expect(seen).toHaveLength(1);
});

test('a connection dropped while preparation is held aborts the admitted input and dispatches nothing', async () => {
  await routeTo('claude-code');
  // The controlled public boundary is the provider session open: the request is
  // admitted, the turn step is running, and the driver is preparing the native
  // session. Hold it there, drop the client, and let the server observe it.
  let release = () => {};
  heldOpen = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const client = new AbortController();
  const dropped = request(messages(), 'POST', message('m-prep', 'Good morning'), client.signal).then(
    () => 'answered',
    () => 'aborted',
  );
  await until(() => opens, (value) => value >= 1, 'the session open to reach the held boundary');
  client.abort();
  await until(
    () => responseClosed,
    (closed) => closed,
    'the server to observe the closed connection',
  );
  release();
  expect(await dropped).toBe('aborted');
  // The open returned normally; the only branch that closes a fresh session
  // without dispatching is the admitted input's own signal having fired.
  await until(() => closes, (value) => value >= 1, 'the driver to close the prepared session');
  expect(opens).toBe(1);
  expect(dispatches).toHaveLength(0);
  // The saved state is read as it is: the aborted turn failed, so the command is
  // unresolved and a Stop is idle. Nothing records an interruption here.
  const outcome = await api<MessageResult>(`${messages()}/m-prep`);
  expect(outcome.interrupted).toBe(false);
  expect(outcome.answerText).toBeNull();
  expect(outcome.outcome.status).toBe('unresolved');
  const stop = await until(
    () => interrupt('m-prep'),
    (answer) => answer.state === 'idle',
    'the abandoned turn to settle',
  );
  expect(stop).toEqual({ commandId: 'm-prep', runId: outcome.runId, state: 'idle' });
});
