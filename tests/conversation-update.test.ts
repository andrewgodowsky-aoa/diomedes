/**
 * "Update this conversation" on a model-API route (artifacts v2, frozen item 3). The real app over
 * HTTP, with only the network under the AI SDK replaced, as in lineage-continuity-aws.test.ts: a
 * conversation opened under main's 0.1.8 text is moved to this build's text by the person, with
 * one note, and its next message carries the recent messages only where history sharing is on.
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
import type { MessageResult } from '../server/interaction-service';
import type { ModelSessionRuns } from '../server/harness/model-session-run';
import { answerInstructions } from '../server/answer-format';
import { instructionDigest } from '../server/instruction-digests';
import type { ConversationUpdate, ConversationUpdatePreview } from '../shared/conversation';
import type { CloudSharingPolicy, Conversation, ConversationLineage, Project, Turn } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import fixture from './fixtures/instruction-texts.json';

// Revocation is a code change. This stands in for one: empty, as shipped, until a test adds to it.
const revoked = vi.hoisted(() => new Map<string, string>());
vi.mock('../server/instruction-digests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/instruction-digests')>()),
  REVOKED_INSTRUCTION_DIGESTS: revoked,
}));
// Main's composer. A mode set here is composed as 0.1.8 composed it; the rest are this build's.
const composedFor = vi.hoisted(() => new Map<string, string>());
vi.mock('../server/answer-format', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/answer-format')>();
  return {
    ...actual,
    answerInstructions: (mode: 'ask' | 'plan' | 'auto') => composedFor.get(mode) ?? actual.answerInstructions(mode),
  };
});

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const main = (mode: 'ask' | 'plan' | 'auto') =>
  (fixture.texts as { build: string; mode: string; text: string }[]).find(
    (row) => row.build === '0.1.8' && row.mode === mode,
  )!.text;
const CARRIED =
  'Nectovia started this conversation fresh because you updated it to the current instructions. Your earlier messages are still here, and it carried over the most recent ones.';
const NOT_CARRIED =
  "Nectovia started this conversation fresh because you updated it to the current instructions. Your earlier messages are still here, but it won't remember them.";

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;
let thread: Conversation;

type Item = Record<string, unknown>;
type Body = { input: Item[] };
let seen: Body[];
/** A message starting with HOLD is answered only once the test releases it. */
let gate: { reached: Promise<void>; arrive(): void; released: Promise<void>; release(): void };
const newGate = () => {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return { reached, arrive, released, release };
};

const userText = (body: Body) => {
  const content = body.input.find((item) => item.role === 'user')?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => String((part as Item).text ?? '')).join('') : '';
};
const instructionsSent = (body: Body) => String(body.input.find((item) => item.role === 'developer')?.content ?? '');
const said = (body: Body) => (userText(body).split("The person's message:\n\n")[1] ?? '').split('\n\n[[diomedes')[0];
const issued = (body: Body) => /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]$/.exec(userText(body))?.[1];
/** What a model proposing work writes after its answer, for the message it was given. */
const proposal = (sourceMessageId: string, words: string) =>
  '```diomedes-decision\n' +
  JSON.stringify({
    source_message_id: sourceMessageId,
    disposition: 'act',
    requested_project_id: null,
    operation_class: 'write_internal',
    source_refs: [],
    target_run_id: null,
    question: null,
    public_summary: `Do this: ${words}`,
  }) +
  '\n```';

const aws = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as Body;
  seen.push(body);
  const words = said(body);
  if (words.startsWith('HOLD')) {
    gate.arrive();
    await gate.released;
  }
  const id = issued(body);
  const answer = words.startsWith('ACT') && id ? `I can start that.\n\n${proposal(id, words)}` : `answer:${words}`;
  return sseResponse(
    responsesEvents({
      id: `resp_${seen.length}`,
      object: 'response',
      created_at: 1_790_000_000,
      status: 'completed',
      model: AWS_LUNA_MODEL,
      output: [
        { type: 'message', id: `msg_${seen.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] },
      ],
      usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 940 },
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-${seen.length}` },
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
const store = () => app.locals.store as Store;
const sessions = () => app.locals.harness.modelSessions as ModelSessionRuns;
const current = () => store().state(project.id).conversations.find((item) => item.id === thread.id)!;
const lineages = (): ConversationLineage[] => current().lineages ?? [];
const notes = (): Turn[] => current().turns.filter((turn) => turn.role === 'diomedes');
const send = (commandId: string, words: string, mode: 'ask' | 'plan' | 'auto') =>
  api<MessageResult>(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', {
    commandId,
    text: words,
    mode,
    sources: [],
    consent: true,
  });
/** Sends one message as main's build would have, so its lineage records main's 0.1.8 text. */
async function onMain(mode: 'ask' | 'plan' | 'auto', commandId: string, words = 'Where is the linen order?') {
  composedFor.set(mode, main(mode));
  try {
    return await send(commandId, words, mode);
  } finally {
    composedFor.delete(mode);
  }
}
const updateConversation = (commandId: unknown, extra: Record<string, unknown> = {}) =>
  request(`/projects/${project.id}/threads/${thread.id}/answer-format`, 'POST', { commandId, ...extra });
const updated = async (commandId: string) => {
  const response = await updateConversation(commandId);
  const reply = await response.text();
  expect(response.status, reply).toBe(200);
  return JSON.parse(reply) as ConversationUpdate;
};
/** The dry run the confirmation words itself from: what the update would do now. */
const preview = () => api<ConversationUpdatePreview>(`/projects/${project.id}/threads/${thread.id}/answer-format`);
async function share(history: boolean) {
  const policy = await api<CloudSharingPolicy>(`/projects/${project.id}/cloud-sharing`);
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: policy.version,
    routes: ['aws-bedrock'],
    documents: [],
    shareConversationHistory: history,
    shareReviewPackets: false,
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-conversation-update-'));
  seen = [];
  gate = newGate();
  service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  await open();
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api<Conversation>(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
  await share(true);
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
  gate.release();
  composedFor.clear();
  revoked.clear();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('"Update this conversation" with history sharing on', () => {
  test('retires the conversation opened under 0.1.8 with one note, and the next message carries the recent messages under today\'s text', async () => {
    const first = await onMain('ask', 'm-first');
    await send('m-second', 'And the invoice?', 'ask');
    expect(lineages()).toHaveLength(1);
    const sent = seen.length;

    // The confirmation is told what the update would do, and asking changes nothing.
    expect(await preview()).toEqual({ retiring: 1, carried: true, route: 'aws-bedrock' });
    expect(lineages()[0].retired).toBeUndefined();
    expect(notes()).toEqual([]);

    const update = await updated('u-1');
    expect(update).toEqual({ updated: true, noteId: expect.stringMatching(/^Nlineage-[0-9a-f]{32}$/) });
    // Updating sends nothing anywhere: it is a change to the record.
    expect(seen.length).toBe(sent);
    // The decision is stored with the lineage, so the next send carries only on the route it names.
    expect(lineages()).toEqual([
      expect.objectContaining({ generation: 1, runId: first.runId, retired: 'format-change', carry: { route: 'aws-bedrock' } }),
    ]);
    expect(notes()).toEqual([
      expect.objectContaining({
        id: update.noteId,
        text: CARRIED,
        mode: 'ask',
        route: 'aws-bedrock',
        origin: expect.objectContaining({ mode: 'application', engine: null }),
      }),
    ]);
    expect(current().turns.at(-1)!.id).toBe(update.noteId);

    const next = await send('m-third', 'Thanks', 'ask');
    expect(next.answerText).toBe('answer:Thanks');
    expect(lineages()).toEqual([
      expect.objectContaining({ generation: 1, runId: first.runId, retired: 'format-change' }),
      expect.objectContaining({ generation: 2, runId: next.runId, carriedFrom: first.runId }),
    ]);
    const call = seen.at(-1)!;
    expect(instructionsSent(call).startsWith(`${answerInstructions('ask')}\n\n`)).toBe(true);
    expect(userText(call)).toContain('Earlier in this conversation:');
    expect(userText(call)).toContain('Person: Where is the linen order?');
    expect(userText(call)).toContain('Diomedes: answer:Where is the linen order?');
    expect(userText(call)).toContain('Person: And the invoice?');
    // The note is the application's, not a message: it never reaches the model.
    expect(userText(call)).not.toContain('started this conversation fresh');
    expect(userText(call)).not.toContain(CARRIED);
    // The turn's own run records that its history came from the retired lineage, and how much.
    expect((await sessions().turnRun(project.id, next.runId, 'm-third'))!.input).toMatchObject({
      historyShared: true,
      carriedFrom: first.runId,
      carriedMessages: 2,
    });
    // The new lineage records today's text, so there is nothing more to update.
    expect(await preview()).toEqual({ retiring: 0, carried: false, route: 'aws-bedrock' });
    expect(await updated('u-2')).toEqual({ updated: false, noteId: null });
    expect(notes()).toHaveLength(1);
  });

  test('a turn records the carry only while the carried messages still reach it', async () => {
    const first = await onMain('ask', 'm-first');
    await updated('u-1');
    const carrying = await send('m-2', 'Q02 question', 'ask');
    expect((await sessions().turnRun(project.id, carrying.runId, 'm-2'))!.input).toMatchObject({
      carriedFrom: first.runId,
      carriedMessages: 1,
    });
    // Twelve messages of the new lineage's own push the carried one out of the bound.
    for (let n = 3; n <= 14; n++) await send(`m-${n}`, `Q${String(n).padStart(2, '0')} question`, 'ask');
    const call = userText(seen.at(-1)!);
    expect(call).toContain('Earlier in this conversation:');
    expect(call).not.toContain('linen order');
    const input = (await sessions().turnRun(project.id, carrying.runId, 'm-14'))!.input;
    expect(input).toMatchObject({ historyShared: true });
    expect(input).not.toHaveProperty('carriedFrom');
    expect(input).not.toHaveProperty('carriedMessages');
  });

  test('the carried history is bounded: the last 12 messages, which give way to the new lineage\'s own', async () => {
    composedFor.set('ask', main('ask'));
    for (let n = 1; n <= 14; n++) await send(`m-${n}`, `Q${String(n).padStart(2, '0')} question`, 'ask');
    composedFor.delete('ask');
    await updated('u-1');

    await send('m-15', 'Q15 question', 'ask');
    const carried = userText(seen.at(-1)!);
    expect(carried).not.toContain('Person: Q01 question');
    expect(carried).not.toContain('Person: Q02 question');
    for (let n = 3; n <= 14; n++) expect(carried).toContain(`Person: Q${String(n).padStart(2, '0')} question`);

    await send('m-16', 'Q16 question', 'ask');
    const next = userText(seen.at(-1)!);
    expect(next).not.toContain('Person: Q03 question');
    expect(next).toContain('Person: Q04 question');
    expect(next).toContain('Person: Q15 question');
  });

  test('a retry of the same command reads back what it did and writes no second note, even after the conversation moved on', async () => {
    await onMain('ask', 'm-first');
    const once = await updated('u-1');
    expect(await updated('u-1')).toEqual(once);
    expect(notes()).toHaveLength(1);
    await send('m-second', 'Thanks', 'ask');
    expect(await updated('u-1')).toEqual(once);
    expect(notes()).toHaveLength(1);
    expect(lineages()).toHaveLength(2);
  });

  test('a conversation already on this build\'s text has nothing to update: nothing retires and no note is written', async () => {
    expect(await updated('u-empty')).toEqual({ updated: false, noteId: null });
    const first = await send('m-first', 'Where is the linen order?', 'plan');
    expect(await updated('u-1')).toEqual({ updated: false, noteId: null });
    expect(lineages()).toEqual([expect.objectContaining({ runId: first.runId })]);
    expect(lineages()[0].retired).toBeUndefined();
    expect(notes()).toEqual([]);
  });
});

describe('"Update this conversation" with history sharing off', () => {
  test('carries nothing, says so, and leaves sharing off', async () => {
    await share(false);
    await onMain('ask', 'm-first');
    await send('m-second', 'And the invoice?', 'ask');
    const before = await api<CloudSharingPolicy>(`/projects/${project.id}/cloud-sharing`);

    expect(await preview()).toEqual({ retiring: 1, carried: false, route: 'aws-bedrock', reason: 'history-off' });
    await updated('u-1');
    expect(notes().map((note) => note.text)).toEqual([NOT_CARRIED]);
    expect(lineages()[0]).not.toHaveProperty('carry');
    expect(await api<CloudSharingPolicy>(`/projects/${project.id}/cloud-sharing`)).toEqual(before);

    const next = await send('m-third', 'Thanks', 'ask');
    // Nothing was promised, so nothing points back: the new lineage starts on its own.
    expect(lineages()[1]).toMatchObject({ runId: next.runId });
    expect(lineages()[1]).not.toHaveProperty('carriedFrom');
    const call = userText(seen.at(-1)!);
    expect(call).not.toContain('Earlier in this conversation:');
    expect(call).not.toContain('linen order');
    expect((await sessions().turnRun(project.id, next.runId, 'm-third'))!.input).toMatchObject({ historyShared: false });
    expect((await sessions().turnRun(project.id, next.runId, 'm-third'))!.input).not.toHaveProperty('carriedFrom');
  });

  test('a grant given after the update carries nothing: the update said it won\'t remember, and that stands', async () => {
    await share(false);
    await onMain('ask', 'm-first');
    await updated('u-1');
    expect(notes().map((note) => note.text)).toEqual([NOT_CARRIED]);
    // Later, for another reason, the owner shares history with this route.
    await share(true);
    const next = await send('m-second', 'Thanks', 'ask');
    expect(userText(seen.at(-1)!)).not.toContain('linen order');
    expect(lineages()[1]).toMatchObject({ runId: next.runId });
    expect(lineages()[1]).not.toHaveProperty('carriedFrom');
    // Its own messages are history as usual from here.
    await send('m-third', 'And the invoice?', 'ask');
    expect(userText(seen.at(-1)!)).toContain('Person: Thanks');
    expect(userText(seen.at(-1)!)).not.toContain('linen order');
  });

  test('carries nothing when sharing is turned off after the update: each send checks again', async () => {
    await onMain('ask', 'm-first');
    await updated('u-1');
    expect(notes().map((note) => note.text)).toEqual([CARRIED]);
    await share(false);
    await send('m-second', 'Thanks', 'ask');
    expect(userText(seen.at(-1)!)).not.toContain('Earlier in this conversation:');
  });
});

describe('"Update this conversation" is refused, with its reason, while', () => {
  test('a message is being answered, and goes ahead once it is answered', async () => {
    const first = await onMain('ask', 'm-first');
    const pending = send('m-hold', 'HOLD the order', 'ask');
    await gate.reached;

    const refused = await updateConversation('u-1');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'Nectovia is still working on a message in this conversation. Update it once that has finished.',
      code: 'conversation_busy',
    });
    expect(lineages()[0].retired).toBeUndefined();
    expect(notes()).toEqual([]);

    gate.release();
    expect((await pending).answerText).toBe('answer:HOLD the order');
    expect((await updated('u-1')).updated).toBe(true);
    expect(lineages()[0]).toMatchObject({ runId: first.runId, retired: 'format-change' });
  });

  test('an Automatic proposal waits for the person\'s choice, and goes ahead once another message follows it', async () => {
    const proposed = await onMain('auto', 'm-act', 'ACT order the usual');
    expect(proposed.outcome.status).toBe('proposed');

    const refused = await updateConversation('u-1');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'Nectovia is waiting for your choice on what it proposed. Start it, or send another message, before you update this conversation.',
      code: 'proposal_waiting',
    });
    expect(lineages()[0].retired).toBeUndefined();
    expect(notes()).toEqual([]);

    // Another message: the proposal is no longer the answer the conversation ends on.
    await send('m-next', 'Never mind', 'auto');
    expect((await updated('u-1')).updated).toBe(true);
    expect(lineages()[0]).toMatchObject({ mode: 'auto', retired: 'format-change' });
  });
});

describe('only a conversation on instructions this build knows is carried', () => {
  test('a text this build does not know is updated, and carries nothing', async () => {
    composedFor.set('ask', 'Instructions a later build wrote, which this build has never seen.');
    try {
      await send('m-first', 'Where is the linen order?', 'ask');
    } finally {
      composedFor.delete('ask');
    }
    expect(await preview()).toEqual({ retiring: 1, carried: false, route: 'aws-bedrock', reason: 'other' });
    await updated('u-1');
    expect(notes().map((note) => note.text)).toEqual([NOT_CARRIED]);
    expect(lineages()[0]).not.toHaveProperty('carry');
    await send('m-second', 'Thanks', 'ask');
    expect(userText(seen.at(-1)!)).not.toContain('linen order');
    expect(lineages()[1]).not.toHaveProperty('carriedFrom');
  });

  test('a revoked text is updated, and carries nothing', async () => {
    await onMain('ask', 'm-first');
    revoked.set(instructionDigest(main('ask')), 'test: withdrawn');
    expect(await preview()).toEqual({ retiring: 1, carried: false, route: 'aws-bedrock', reason: 'other' });
    await updated('u-1');
    expect(notes().map((note) => note.text)).toEqual([NOT_CARRIED]);
    await send('m-second', 'Thanks', 'ask');
    expect(userText(seen.at(-1)!)).not.toContain('linen order');
    expect(lineages()[1]).not.toHaveProperty('carriedFrom');
  });

  test('a text revoked after the update stops the carry at the next send', async () => {
    const first = await onMain('ask', 'm-first');
    await updated('u-1');
    expect(notes().map((note) => note.text)).toEqual([CARRIED]);
    const carrying = await send('m-second', 'Thanks', 'ask');
    expect(userText(seen.at(-1)!)).toContain('linen order');
    expect(lineages()[1]).toMatchObject({ carriedFrom: first.runId });

    revoked.set(instructionDigest(main('ask')), 'test: withdrawn after the update');
    await send('m-third', 'And the invoice?', 'ask');
    const call = userText(seen.at(-1)!);
    expect(call).toContain('Person: Thanks');
    expect(call).not.toContain('linen order');
    expect((await sessions().turnRun(project.id, carrying.runId, 'm-third'))!.input).not.toHaveProperty('carriedFrom');
  });
});

describe('the dry run', () => {
  test('names no route, and promises nothing, while the tier\'s route cannot answer; the update still goes ahead', async () => {
    await onMain('ask', 'm-first');
    // Focused runs on Google Vertex AI, which is not connected here, so the next message would be refused.
    await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { workStyle: 'focused' });
    expect(await preview()).toEqual({ retiring: 1, carried: false, route: null, reason: 'other' });
    expect((await updated('u-1')).updated).toBe(true);
    expect(notes().map((note) => note.text)).toEqual([NOT_CARRIED]);
    expect(lineages()[0]).not.toHaveProperty('carry');
  });
});

describe('the endpoint', () => {
  test('takes exactly one command, and names a thread that exists', async () => {
    expect((await request(`/projects/${project.id}/threads/${thread.id}/answer-format`, 'POST', {})).status).toBe(400);
    expect((await updateConversation('u-1', { mode: 'ask' })).status).toBe(400);
    expect((await updateConversation(42)).status).toBe(400);
    expect((await request(`/projects/${project.id}/threads/t-missing/answer-format`, 'POST', { commandId: 'u-1' })).status).toBe(404);
    expect((await request(`/projects/${project.id}/threads/t-missing/answer-format`)).status).toBe(404);
  });
});
