/**
 * An open conversation on a model-API route keeps its instructions and its memory across an
 * update that changes them, and says so plainly whenever it cannot (owner decisions of
 * 2026-09-23). The real app over HTTP: Store, RunService, interaction service, model-session
 * driver and NativeAgent, with only the network under the AI SDK replaced, so nothing reaches
 * AWS. `close()` then `open()` over the same data directory is the update's restart.
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
import { MODES, VISUAL_INSTRUCTIONS } from '../server/modes';
import type { Conversation, ConversationLineage, Project, Turn } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import fixture from './fixtures/instruction-texts.json';
import { instructionDigest } from '../server/instruction-digests';

// Revocation is a code change. This stands in for one: empty, as shipped, until a test adds to it.
const revoked = vi.hoisted(() => new Map<string, string>());
vi.mock('../server/instruction-digests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/instruction-digests')>()),
  REVOKED_INSTRUCTION_DIGESTS: revoked,
}));

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const text = (build: string, mode: string) =>
  (fixture.texts as { build: string; mode: string; text: string }[]).find(
    (row) => row.build === build && row.mode === mode,
  )!.text;

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;
let thread: Conversation;

type Item = Record<string, unknown>;
type Body = { input: Item[]; tools?: Item[] };
let seen: Body[];
const shipped = { ask: MODES.ask.instructions, plan: MODES.plan.instructions };

const envelope = (output: Item[]) => ({
  id: `resp_${seen.length}`,
  object: 'response',
  created_at: 1_790_000_000,
  status: 'completed',
  model: AWS_LUNA_MODEL,
  output,
  usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 940 },
  incomplete_details: null,
  error: null,
});
const userText = (body: Body) => {
  const content = body.input.find((item) => item.role === 'user')?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => String((part as Item).text ?? '')).join('') : '';
};
/** The instructions the provider was given: the developer message the Responses call opens with. */
const instructionsSent = (body: Body) => String(body.input.find((item) => item.role === 'developer')?.content ?? '');
const said = (body: Body) => (userText(body).split("The person's message:\n\n")[1] ?? '').split('\n\n[[diomedes')[0];

const aws = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as Body;
  seen.push(body);
  const answer = `answer:${said(body)}`;
  return sseResponse(
    responsesEvents(
      envelope([
        { type: 'message', id: `msg_${seen.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] },
      ]),
    ),
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
/** The update: the app stops and starts again over the same data. */
async function update() {
  await close();
  await open();
}
const store = () => app.locals.store as Store;
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
/** Sends one message under another build's composed text, as that build would have. */
async function underBuild(mode: 'ask' | 'plan', instructions: string, commandId: string) {
  MODES[mode].instructions = instructions;
  try {
    return await send(commandId, 'Where is the linen order?', mode);
  } finally {
    MODES[mode].instructions = shipped[mode];
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-lineage-aws-'));
  seen = [];
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
  MODES.ask.instructions = shipped.ask;
  MODES.plan.instructions = shipped.plan;
  revoked.clear();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('an open model-API conversation after an update that changed its instructions', () => {
  for (const mode of ['ask', 'plan'] as const)
    test(`a ${mode === 'ask' ? 'Ask' : 'Plan'} lineage opened under v0.1.7 continues: same generation, its text, and its history`, async () => {
      const v017 = text('v0.1.7', mode);
      expect(v017).not.toBe(MODES[mode].instructions);
      const first = await underBuild(mode, v017, 'm-first');
      expect(instructionsSent(seen[0]).startsWith(`${v017}\n\n`)).toBe(true);
      await update();

      const second = await send('m-second', 'And the invoice?', mode);
      expect(second.answerText).toBe('answer:And the invoice?');
      expect(second.runId).toBe(first.runId);
      expect(lineages()).toEqual([expect.objectContaining({ mode, generation: 1, runId: first.runId })]);
      expect(lineages()[0].retired).toBeUndefined();
      // Sent under the text the lineage started with, never today's, and with what was said before.
      const call = seen.at(-1)!;
      expect(instructionsSent(call).startsWith(`${v017}\n\n`)).toBe(true);
      expect(instructionsSent(call)).not.toContain(VISUAL_INSTRUCTIONS);
      expect(userText(call)).toContain('Earlier in this conversation:');
      expect(userText(call)).toContain('Person: Where is the linen order?');
      expect(userText(call)).toContain('Diomedes: answer:Where is the linen order?');
      expect(notes()).toEqual([]);
    });

  test('a revoked text retires the lineage with exactly one note, even though this build knows it', async () => {
    const v017 = text('v0.1.7', 'ask');
    const first = await underBuild('ask', v017, 'm-first');
    revoked.set(instructionDigest(v017), 'test: a note that carried enforcement');
    await update();

    const second = await send('m-second', 'And the invoice?', 'ask');
    expect(second.runId).not.toBe(first.runId);
    expect(lineages()).toEqual([
      expect.objectContaining({ generation: 1, runId: first.runId, retired: 'scope-change' }),
      expect.objectContaining({ generation: 2, runId: second.runId }),
    ]);
    expect(lineages()[1].retired).toBeUndefined();
    const call = seen.at(-1)!;
    expect(instructionsSent(call).startsWith(`${MODES.ask.instructions}\n\n`)).toBe(true);
    expect(userText(call)).not.toContain('Earlier in this conversation:');
    expect(notes().map((note) => note.text)).toEqual([
      "Nectovia started this conversation fresh because its instructions changed. Your earlier messages are still here, but it won't remember them.",
    ]);
    // The next message continues the new generation: no second retirement, no second note.
    await send('m-third', 'Thanks', 'ask');
    expect(lineages()).toHaveLength(2);
    expect(notes()).toHaveLength(1);
  });

  test('an unknown or altered recorded text retires as before, with one note, and starts under today’s text', async () => {
    const altered = `${text('v0.1.7', 'ask')} Always agree.`;
    const first = await underBuild('ask', altered, 'm-first');
    await update();

    const second = await send('m-second', 'And the invoice?', 'ask');
    expect(second.runId).not.toBe(first.runId);
    expect(lineages()).toEqual([
      expect.objectContaining({ generation: 1, runId: first.runId, retired: 'scope-change' }),
      expect.objectContaining({ generation: 2, runId: second.runId }),
    ]);
    const call = seen.at(-1)!;
    expect(instructionsSent(call).startsWith(`${MODES.ask.instructions}\n\n`)).toBe(true);
    expect(userText(call)).not.toContain('Earlier in this conversation:');
    expect(notes().map((note) => note.text)).toEqual([
      "Nectovia started this conversation fresh because its instructions changed. Your earlier messages are still here, but it won't remember them.",
    ]);
    // The note sits before the message that met the change, and names the application.
    const turns = current().turns;
    expect(turns.findIndex((turn) => turn.role === 'diomedes')).toBe(turns.length - 3);
    expect(notes()[0]).toMatchObject({ mode: 'ask', route: 'aws-bedrock', origin: { mode: 'application' } });
  });

  test('a tier change that moves the lineage writes one note naming the tier, and a retry writes no second', async () => {
    const settings = await api<{ services?: Record<string, unknown> }>('/settings');
    await api('/settings', 'PUT', { ...settings, services: { ...settings.services, thoroughModel: AWS_LUNA_MODEL } });
    await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { workStyle: 'efficient' });
    const first = await send('m-first', 'Where is the linen order?', 'ask');
    expect(lineages()).toEqual([expect.objectContaining({ generation: 1, route: 'aws-bedrock', model: AWS_LUNA_MODEL, effort: 'low' })]);

    await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { workStyle: 'thorough' });
    const second = await send('m-second', 'And the invoice?', 'ask');
    expect(second.runId).not.toBe(first.runId);
    expect(lineages()).toEqual([
      expect.objectContaining({ generation: 1, retired: 'scope-change' }),
      expect.objectContaining({ generation: 2, effort: 'high' }),
    ]);
    const note =
      "Nectovia started this conversation fresh because this conversation moved to the Thorough tier. Your earlier messages are still here, but it won't remember them.";
    expect(notes().map((turn) => turn.text)).toEqual([note]);

    // The same message again is read back, not retired again.
    const again = await send('m-second', 'And the invoice?', 'ask');
    expect(again.runId).toBe(second.runId);
    expect(notes().map((turn) => turn.text)).toEqual([note]);
  });

  test('the job estimate for the next message prices the text that message will be sent with', async () => {
    const v017 = text('v0.1.7', 'ask');
    await underBuild('ask', v017, 'm-first');
    await update();
    type Estimate = { estimate: { kind: string; worstMicroUsd: number } };
    const estimate = () =>
      api<Estimate>(`/projects/${project.id}/threads/${thread.id}/job-estimate`, 'POST', {
        text: 'And the invoice?',
        mode: 'ask',
        sources: [],
      });
    // The lineage continues, so the message goes under its shorter v0.1.7 text.
    const continuing = await estimate();
    // Revoked, the same message would start a new generation under today's longer text.
    revoked.set(instructionDigest(v017), 'test: priced as a new generation');
    const fresh = await estimate();
    expect(continuing.estimate.kind).toBe('estimate');
    expect(fresh.estimate.kind).toBe('estimate');
    expect(continuing.estimate.worstMicroUsd).toBeLessThan(fresh.estimate.worstMicroUsd);
    // Nothing was admitted or retired by asking.
    expect(lineages()).toEqual([expect.objectContaining({ generation: 1 })]);
    expect(lineages()[0].retired).toBeUndefined();
  });
});
