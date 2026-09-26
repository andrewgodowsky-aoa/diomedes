/**
 * "Update this conversation" where the route the next message takes is not the route the thread
 * records, or moves after the update (lane 2 review, P1). What the confirmation is told (the dry
 * run), what the note says, what the update stores and what the next send carries must agree in
 * every case. The real app over HTTP; only the network is replaced: AWS Bedrock and Google Vertex
 * AI answer from fakes, and nothing reaches either.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { VertexConnections } from '../server/engines/google-vertex';
import { FileModelTranscripts } from '../server/harness/model-transcripts';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { testOnlySecretBox } from '../server/connection-secrets';
import type { Store } from '../server/store';
import type { ConversationUpdate, ConversationUpdatePreview } from '../shared/conversation';
import type { CloudSharingPolicy, ConversationLineage } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import fixture from './fixtures/instruction-texts.json';

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
const GCP = 'nectovia-route-proof';
const main = (mode: 'ask' | 'plan' | 'auto') =>
  (fixture.texts as { build: string; mode: string; text: string }[]).find(
    (row) => row.build === '0.1.8' && row.mode === mode,
  )!.text;
const CARRIED =
  'Nectovia started this conversation fresh because you updated it to the current instructions. Your earlier messages are still here, and it carried over the most recent ones.';
const NOT_CARRIED =
  "Nectovia started this conversation fresh because you updated it to the current instructions. Your earlier messages are still here, but it won't remember them.";
const MOVED_TO_VERTEX =
  "Nectovia started this conversation fresh because this conversation moved to Google Vertex AI (Gemini 3.8 Flash). Your earlier messages are still here, but it won't remember them.";

type Call = { provider: 'aws' | 'vertex'; body: string };
let seen: Call[];
/** AWS answers with the Responses stream, Vertex with Gemini's SSE frames. Nothing leaves the process. */
const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = String(init?.body);
  if (String(input).startsWith('https://aiplatform.googleapis.com/')) {
    seen.push({ provider: 'vertex', body });
    const frames = [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'vertex ok' }] }, index: 0 }], modelVersion: 'gemini-3.8-flash-001', responseId: `vtx-${seen.length}` },
      { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 30, thoughtsTokenCount: 10, totalTokenCount: 640 }, modelVersion: 'gemini-3.8-flash-001', responseId: `vtx-${seen.length}` },
    ];
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-goog-request-id': `goog-${seen.length}` },
    });
  }
  seen.push({ provider: 'aws', body });
  return sseResponse(
    responsesEvents({
      id: `resp_${seen.length}`,
      object: 'response',
      created_at: 1_790_000_000,
      status: 'completed',
      model: AWS_LUNA_MODEL,
      output: [{ type: 'message', id: `msg_${seen.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'aws ok', annotations: [] }] }],
      usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 940 },
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-${seen.length}` },
  );
}) as typeof globalThis.fetch;

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const reply = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${reply}`).toBe(true);
  return JSON.parse(reply) as T;
}

interface Conversation {
  projectId: string;
  threadId: string;
}
const store = () => app.locals.store as Store;
const thread = (at: Conversation) => store().state(at.projectId).conversations.find((item) => item.id === at.threadId)!;
const lineages = (at: Conversation): ConversationLineage[] => thread(at).lineages ?? [];
const notes = (at: Conversation) => thread(at).turns.filter((turn) => turn.role === 'diomedes').map((turn) => turn.text);
async function share(projectId: string, routes: string[], history: boolean) {
  const policy = await api<CloudSharingPolicy>(`/projects/${projectId}/cloud-sharing`);
  await api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: policy.version,
    routes,
    documents: [],
    shareConversationHistory: history,
    shareReviewPackets: false,
  });
}
const send = (at: Conversation, commandId: string, text: string) =>
  api(`/projects/${at.projectId}/threads/${at.threadId}/messages`, 'POST', { commandId, text, mode: 'ask', sources: [], consent: true });
/** One message as main's build sent it, so the lineage records main's 0.1.8 text. */
async function onMain(at: Conversation, commandId: string) {
  composedFor.set('ask', main('ask'));
  try {
    return await send(at, commandId, 'Where is the linen order?');
  } finally {
    composedFor.delete('ask');
  }
}
const preview = (at: Conversation) => api<ConversationUpdatePreview>(`/projects/${at.projectId}/threads/${at.threadId}/answer-format`);
const update = (at: Conversation, commandId: string) =>
  api<ConversationUpdate>(`/projects/${at.projectId}/threads/${at.threadId}/answer-format`, 'POST', { commandId });
const moveTo = (at: Conversation, change: Record<string, unknown>) => api(`/projects/${at.projectId}/threads/${at.threadId}`, 'PUT', change);
/** Whether the last provider call carried the first message, which only history can bring. */
const carriedEarlier = () => seen.at(-1)!.body.includes('linen order');

async function inProject(name: string, routes: string[], history: boolean): Promise<Conversation> {
  const project = await api<{ id: string }>('/projects', 'POST', { name });
  const created = await api<{ id: string }>(`/projects/${project.id}/threads`, 'POST', {});
  await share(project.id, routes, history);
  return { projectId: project.id, threadId: created.id };
}
async function atHome(routes: string[], history: boolean): Promise<Conversation> {
  const binding = await api<Conversation>('/home/conversation', 'POST', {});
  await share(binding.projectId, routes, history);
  return binding;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-update-routes-'));
  seen = [];
  const dataDir = path.join(root, 'data');
  const adcFile = path.join(root, 'adc.json');
  await fs.writeFile(
    adcFile,
    JSON.stringify({ type: 'authorized_user', client_id: 'test-client', client_secret: 'cs-never-read', refresh_token: 'rt-never-read', quota_project_id: GCP }),
  );
  const service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  app = await createApp({
    dataDir,
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: network,
  });
  // Vertex's token mint, stubbed as tests/google-vertex-conversation.test.ts stubs it.
  service.modelApi!.vertex = {
    connections: new VertexConnections(dataDir),
    transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-google-vertex'), 'google-vertex'),
    env: { GOOGLE_APPLICATION_CREDENTIALS: adcFile },
    mint: async () => ({ token: 'ya29.test-only-vertex-token-never-real', expiresAt: null }),
    now: () => new Date('2026-09-23T12:00:00.000Z'),
  };
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey: 'test-only-bedrock-key-0123456789abcdef-never-real',
    expiresAt: null,
    consent: true,
  });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 5, consent: true });
  await api('/ai/model-api/google-vertex', 'PUT', { projectId: GCP, location: 'global', model: 'gemini-3.8-flash', consent: true });
  await api('/ai/model-api/google-vertex/spend-limit', 'PUT', { capUsd: 5, consent: true });
});
afterEach(async () => {
  composedFor.clear();
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe('the confirmation, the note, the record and the next send agree', () => {
  test('A: history shared with AWS only, a thread recorded on Claude Code whose tier sends to AWS: carried, and said so everywhere', async () => {
    const at = await inProject('Case A', ['aws-bedrock'], true);
    await moveTo(at, { engine: 'claude-code', workStyle: 'efficient' });
    await onMain(at, 'a-1');
    expect(seen.at(-1)!.provider).toBe('aws');
    const [opened] = lineages(at);
    expect(opened).toMatchObject({ route: 'aws-bedrock' });

    // The confirmation is told the server's decision: the client cannot know the tier's route.
    expect(await preview(at)).toEqual({ retiring: 1, carried: true, route: 'aws-bedrock' });
    await update(at, 'u-a');
    expect(notes(at)).toEqual([CARRIED]);
    expect(lineages(at)[0]).toMatchObject({ runId: opened.runId, retired: 'format-change', carry: { route: 'aws-bedrock' } });

    await send(at, 'a-2', 'And the invoice?');
    expect(seen.at(-1)!.provider).toBe('aws');
    expect(carriedEarlier()).toBe(true);
    expect(lineages(at)[1]).toMatchObject({ route: 'aws-bedrock', carriedFrom: opened.runId });
  });

  test('B: Home sharing history with Claude Code only, a thread recorded on Claude Code whose tier sends to AWS: nothing carried, and said so everywhere', async () => {
    const at = await atHome(['claude-code'], true);
    await moveTo(at, { engine: 'claude-code', workStyle: 'efficient' });
    await onMain(at, 'b-1');
    expect(seen.at(-1)!.provider).toBe('aws');

    expect(await preview(at)).toEqual({ retiring: 1, carried: false, route: 'aws-bedrock', reason: 'history-off' });
    await update(at, 'u-b');
    expect(notes(at)).toEqual([NOT_CARRIED]);
    expect(lineages(at)[0]).toMatchObject({ retired: 'format-change' });
    expect(lineages(at)[0]).not.toHaveProperty('carry');

    await send(at, 'b-2', 'And the invoice?');
    expect(seen.at(-1)!.provider).toBe('aws');
    expect(carriedEarlier()).toBe(false);
    expect(lineages(at)[1]).not.toHaveProperty('carriedFrom');
  });

  test('V1: after an update that carried, a move to another route starts fresh there and says so, once', async () => {
    const at = await inProject('Case V1', ['aws-bedrock', 'google-vertex'], true);
    await moveTo(at, { engine: 'aws-bedrock' });
    await onMain(at, 'v1-1');
    expect(seen.at(-1)!.provider).toBe('aws');
    expect(await preview(at)).toEqual({ retiring: 1, carried: true, route: 'aws-bedrock' });
    await update(at, 'u-v1');
    expect(notes(at)).toEqual([CARRIED]);

    // The person moves the conversation to Google Vertex AI before the next message. The carry
    // was promised for AWS, so Vertex gets none of it, and the thread says why.
    await moveTo(at, { engine: 'google-vertex' });
    await send(at, 'v1-2', 'Next question.');
    expect(seen.at(-1)!.provider).toBe('vertex');
    expect(carriedEarlier()).toBe(false);
    expect(notes(at)).toEqual([CARRIED, MOVED_TO_VERTEX]);
    expect(lineages(at)[1]).toMatchObject({ route: 'google-vertex' });
    expect(lineages(at)[1]).not.toHaveProperty('carriedFrom');

    // The same message again is read back: no second note.
    await send(at, 'v1-2', 'Next question.');
    expect(notes(at)).toEqual([CARRIED, MOVED_TO_VERTEX]);
  });

  test('V2: Home sharing history with Vertex only: the update says it won\'t remember, and a move to Vertex carries nothing', async () => {
    const at = await atHome(['google-vertex'], true);
    // Home now starts on Nectovia's managed route; this case is about the owner's routes, so the
    // person moves Home to AWS first.
    await moveTo(at, { engine: 'aws-bedrock' });
    // Home's typed messages need no grant, so the first goes to AWS, where history is not shared.
    await onMain(at, 'v2-1');
    expect(seen.at(-1)!.provider).toBe('aws');
    expect(await preview(at)).toEqual({ retiring: 1, carried: false, route: 'aws-bedrock', reason: 'history-off' });
    await update(at, 'u-v2');
    expect(notes(at)).toEqual([NOT_CARRIED]);

    await moveTo(at, { engine: 'google-vertex' });
    await send(at, 'v2-2', 'Next question.');
    expect(seen.at(-1)!.provider).toBe('vertex');
    expect(carriedEarlier()).toBe(false);
    // Nothing more was forgotten: the update's note already said so.
    expect(notes(at)).toEqual([NOT_CARRIED]);
    expect(lineages(at)[1]).not.toHaveProperty('carriedFrom');
  });

  test('a conversation moved to another route before the update is never carried across to it', async () => {
    const at = await inProject('Moved first', ['aws-bedrock', 'google-vertex'], true);
    await moveTo(at, { engine: 'aws-bedrock' });
    await onMain(at, 'm-1');
    await moveTo(at, { engine: 'google-vertex' });

    // History is shared with Vertex, but the messages were answered on AWS.
    expect(await preview(at)).toEqual({ retiring: 1, carried: false, route: 'google-vertex', reason: 'other-route' });
    await update(at, 'u-m');
    expect(notes(at)).toEqual([NOT_CARRIED]);
    await send(at, 'm-2', 'Next question.');
    expect(seen.at(-1)!.provider).toBe('vertex');
    expect(carriedEarlier()).toBe(false);
    expect(notes(at)).toEqual([NOT_CARRIED]);
    expect(lineages(at)[1]).not.toHaveProperty('carriedFrom');
  });
});
