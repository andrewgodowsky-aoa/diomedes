/**
 * A conversation whose run file this build cannot read, because the file is damaged or a newer
 * build wrote it before a downgrade, keeps answering. A retired lineage that cannot be read no
 * longer blocks the thread; an open one retires and the next generation starts. Either way the
 * thread says once, plainly, that an earlier part could not be read and will not be remembered,
 * and the unreadable file is left exactly as it was. The real app over HTTP, with only the network
 * under the AI SDK replaced, so nothing reaches AWS.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
import type { MessageResult } from '../server/interaction-service';
import { MODES } from '../server/modes';
import type { Conversation, ConversationLineage, Project, Turn } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const UNREADABLE =
  "Nectovia couldn't read an earlier part of this conversation, so it won't remember that part. Your earlier messages are still here.";
const INSTRUCTIONS_CHANGED =
  "Nectovia started this conversation fresh because its instructions changed. Your earlier messages are still here, but it won't remember them.";

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;
let thread: Conversation;
let calls = 0;
const shipped = MODES.ask.instructions;

type Item = Record<string, unknown>;
const said = (body: { input: Item[] }) => {
  const content = body.input.find((item) => item.role === 'user')?.content;
  const whole = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((part) => String((part as Item).text ?? '')).join('') : '';
  return (whole.split("The person's message:\n\n")[1] ?? '').split('\n\n[[diomedes')[0];
};
const aws = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  calls += 1;
  const body = JSON.parse(String(init?.body)) as { input: Item[] };
  return sseResponse(
    responsesEvents({
      id: `resp_${calls}`,
      object: 'response',
      created_at: 1_790_000_000,
      status: 'completed',
      model: AWS_LUNA_MODEL,
      output: [
        { type: 'message', id: `msg_${calls}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `answer:${said(body)}`, annotations: [] }] },
      ],
      usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 940 },
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-${calls}` },
  );
}) as typeof globalThis.fetch;

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
    secretBox: testOnlySecretBox(),
    modelApiTransport: aws,
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
/** A restart over the same data: a downgrade, or the next launch after a file was damaged. */
async function restart() {
  await close();
  await open();
}
const store = () => app.locals.store as Store;
const current = () => store().state(project.id).conversations.find((item) => item.id === thread.id)!;
const lineages = (): ConversationLineage[] => current().lineages ?? [];
const notes = (): Turn[] => current().turns.filter((turn) => turn.role === 'diomedes');
const runFile = (runId: string) => path.join(root, 'data', 'projects', project.id, 'harness', 'runs', `${runId}.json`);
const send = (commandId: string, words: string) =>
  api<MessageResult>(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', {
    commandId,
    text: words,
    mode: 'ask',
    sources: [],
    consent: true,
  });
/** A damaged file: not JSON at all. */
const damage = async (runId: string) => {
  await fs.writeFile(runFile(runId), '{"v":1,"id":"half a rec');
};
/** A file a newer build wrote, with a contract version this build does not read. */
const fromNewerBuild = async (runId: string) => {
  const run = JSON.parse(await fs.readFile(runFile(runId), 'utf8')) as { v: number };
  run.v = 999;
  await fs.writeFile(runFile(runId), JSON.stringify(run));
};
/** One retired lineage and one open one: generation 1 retires when its instructions change. */
async function withRetiredLineage() {
  MODES.ask.instructions = `${shipped} An instruction no build ships.`;
  try {
    await send('m-first', 'Where is the linen order?');
  } finally {
    MODES.ask.instructions = shipped;
  }
  await restart();
  const second = await send('m-second', 'And the invoice?');
  expect(lineages()).toEqual([
    expect.objectContaining({ generation: 1, retired: 'scope-change' }),
    expect.objectContaining({ generation: 2, runId: second.runId }),
  ]);
  expect(notes().map((note) => note.text)).toEqual([INSTRUCTIONS_CHANGED]);
  return { retired: lineages()[0].runId, open: second.runId };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-unreadable-run-'));
  calls = 0;
  service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  await open();
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api<Conversation>(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['aws-bedrock'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  await api('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey: SECRET,
    expiresAt: null,
    consent: true,
  });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 5, consent: true });
});
afterEach(async () => {
  MODES.ask.instructions = shipped;
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('a conversation whose run this build cannot read', () => {
  for (const [label, spoil] of [
    ['damaged', damage],
    ['written by a newer build', fromNewerBuild],
  ] as const)
    test(`a retired lineage whose run is ${label} no longer blocks the thread, and the thread says so once`, async () => {
      const { retired, open: openRun } = await withRetiredLineage();
      await spoil(retired);
      const bytes = await fs.readFile(runFile(retired));
      await restart();

      const third = await send('m-third', 'Is the linen in?');
      expect(third.answerText).toBe('answer:Is the linen in?');
      // The open lineage continues; the retired one stays as it was.
      expect(third.runId).toBe(openRun);
      expect(lineages()).toEqual([
        expect.objectContaining({ generation: 1, runId: retired, retired: 'scope-change' }),
        expect.objectContaining({ generation: 2, runId: openRun }),
      ]);
      expect(lineages()[1].retired).toBeUndefined();
      expect(notes().map((note) => note.text)).toEqual([INSTRUCTIONS_CHANGED, UNREADABLE]);
      expect(notes()[1]).toMatchObject({ mode: 'ask', route: 'aws-bedrock', origin: { mode: 'application' } });

      // The next message writes no second note, and the same message again is read back.
      const fourth = await send('m-fourth', 'Thanks');
      expect(fourth.answerText).toBe('answer:Thanks');
      expect((await send('m-fourth', 'Thanks')).runId).toBe(openRun);
      expect(notes()).toHaveLength(2);
      expect(await fs.readFile(runFile(retired))).toEqual(bytes);
    });

  test('an open lineage whose run is damaged retires, the message is answered on a fresh one, and the thread says so once', async () => {
    const first = await send('m-first', 'Where is the linen order?');
    await damage(first.runId);
    const bytes = await fs.readFile(runFile(first.runId));
    await restart();

    const second = await send('m-second', 'And the invoice?');
    expect(second.answerText).toBe('answer:And the invoice?');
    expect(second.runId).not.toBe(first.runId);
    expect(lineages()).toEqual([
      expect.objectContaining({ generation: 1, runId: first.runId, retired: 'terminated' }),
      expect.objectContaining({ generation: 2, runId: second.runId }),
    ]);
    expect(lineages()[1].retired).toBeUndefined();
    expect(notes().map((note) => note.text)).toEqual([UNREADABLE]);
    // The note sits before the message that met the unreadable run.
    const turns = current().turns;
    expect(turns.findIndex((turn) => turn.role === 'diomedes')).toBe(turns.length - 3);

    const third = await send('m-third', 'Thanks');
    expect(third.runId).toBe(second.runId);
    expect(lineages()).toHaveLength(2);
    expect(notes()).toHaveLength(1);
    expect(await fs.readFile(runFile(first.runId))).toEqual(bytes);
  });
});
