/**
 * DIO-254: an Agent loop's call on the local model makes room only when it won't fit its window, in
 * the owner's order (2026-10-06). The reasoning of earlier assistant turns goes first, newest first;
 * then a read is folded into a stub that names the file and its size; a call that still won't fit is
 * refused with the same sentence as before. A call that fits is sent exactly as before, and the run's
 * model step records what each call left out.
 *
 * The local server is a scripted transport whose template joins every message and whose tokenizer
 * counts four characters a token. Nothing here reaches a provider or a real local model, and nothing
 * here starts one.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelMessage } from 'ai';
import { createApp } from '../server/app.js';
import { LocalModelRuntime } from '../server/bonsai/runtime.js';
import { localFoldedRead, respondLocal } from '../server/engines/bonsai.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { Store } from '../server/store.js';
import type { ModelRoom } from '../shared/harness.js';
import { localContextBudget, LOCAL_MODEL_ACCOUNT, parseLocalModelDescriptor } from '../shared/local-model.js';
import type { Project } from '../shared/types.js';
import { FixedLocalModel, fakeLocalHost, localAnswerStream, meadowDescriptor, MEADOW_FOLDER, MEADOW_MODEL } from './fixtures/local-model.js';

vi.setConfig({ testTimeout: 90_000 });

/** The Deep profile with the effort budgets the O2 run used: medium answers in 8,192 tokens. */
const descriptor = () => {
  const raw = meadowDescriptor();
  return { ...raw, profiles: { Deep: { ...raw.profiles.Deep, outputTokens: 12_288,
    effortBudgets: {
      medium: { thinking: true, reasoningTokens: 4_096, outputTokens: 8_192 },
      xhigh: { thinking: true, reasoningTokens: 8_192, outputTokens: 12_288 },
    } } } };
};
const DEEP = parseLocalModelDescriptor(descriptor(), MEADOW_FOLDER).profiles[0];
/** O2's input room: 131,072 less the 8,192 answer and the 3,072 reserves. */
const ROOM = localContextBudget(DEEP, { outputReserve: 8_192 }).inputRoom;
const LOCAL_BASE = 'http://127.0.0.1:18100/';

type Chat = { role: string; content: unknown; reasoning_content?: string; tool_calls?: unknown[]; tool_call_id?: string };
/** The scripted template: every message's role, text, reasoning and calls, joined. */
const render = (messages: Chat[]) => messages.map((message) => [message.role,
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
  message.reasoning_content ?? '', message.tool_calls ? JSON.stringify(message.tool_calls) : ''].join('\n')).join('\n');
const tokensOf = (prompt: string) => Math.ceil(prompt.length / 4);

interface Sent { url: string; raw: string; body: Record<string, unknown> }
/** A local server that answers every call with `answer`, and keeps each request as it was sent. */
function server(sent: Sent[], answer = 'Checked.') {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = String(init?.body ?? '');
    const body = JSON.parse(raw) as Record<string, unknown>;
    sent.push({ url, raw, body });
    if (url.endsWith('/apply-template')) return Response.json({ prompt: render(body.messages as Chat[]) });
    if (url.endsWith('/tokenize')) return Response.json({ tokens: Array(tokensOf(String(body.content))).fill(1) });
    return localAnswerStream({ id: `answer-${sent.length}`, model: MEADOW_MODEL,
      choices: [{ finish_reason: 'stop', message: { content: answer } }],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
  }) as typeof fetch;
}

const runtime = () => new LocalModelRuntime(new FixedLocalModel(descriptor(), MEADOW_FOLDER),
  fakeLocalHost({ state: 'ready', mode: 'Deep', model: MEADOW_MODEL, contextTokens: 131_072 }).host);
const respond = (messages: ModelMessage[], transport: typeof fetch, makeRoom?: boolean) =>
  respondLocal({ runtime: runtime(), model: 'local:deep', effort: 'medium', instructions: 'Check the ledger.',
    messages, tools: [], signal: new AbortController().signal, transport, ...(makeRoom === undefined ? {} : { makeRoom }) });

const DRAFT = 'Draft: the ledger balances except for March, which is short by 40.';
const ADVICE = { advice: 'Check March against the bank statement before you answer.', outcome: 'advised' };
const readResult = (file: string, text: string) => ({ path: file, found: true, sha: `sha-${file}`, bytes: text.length, text, truncated: false });
/**
 * The O2 shape: the lead reads a long document, drafts with long reasoning while it asks its
 * advisor, and the advice comes back. `reasoning` is each assistant turn's reasoning, oldest first.
 */
function o2(reads: [string, string][], reasoning: [number, number]): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', content: 'Check the ledger and say what is short.' }];
  reads.forEach(([file, text], index) => {
    messages.push({ role: 'assistant', content: [
      ...(index === 0 && reasoning[0] ? [{ type: 'reasoning' as const, text: 'p'.repeat(reasoning[0]) }] : []),
      { type: 'tool-call', toolCallId: `read-${index}`, toolName: 'read_project_file', input: { path: file } }] });
    messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `read-${index}`, toolName: 'read_project_file',
      output: { type: 'json', value: readResult(file, text) } }] });
  });
  messages.push({ role: 'assistant', content: [
    ...(reasoning[1] ? [{ type: 'reasoning' as const, text: 'r'.repeat(reasoning[1]) }] : []),
    { type: 'text', text: DRAFT },
    { type: 'tool-call', toolCallId: 'advice-1', toolName: 'consult_advisor', input: { question: 'Is the draft right?' } }] });
  messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'advice-1', toolName: 'consult_advisor',
    output: { type: 'json', value: ADVICE } }] });
  return messages;
}
const calls = (sent: Sent[], suffix: string) => sent.filter((item) => item.url.endsWith(suffix));
const chatOf = (sent: Sent[]) => calls(sent, '/chat/completions').at(-1)!.body.messages as Chat[];

describe('a local loop call that fits (DIO-254)', () => {
  test('is sent byte for byte as it was, counted once, and records nothing', async () => {
    const messages = o2([['ledger.txt', 'a'.repeat(20_000)]], [2_000, 15_468]);
    const before: Sent[] = [], after: Sent[] = [];
    const plain = await respond(messages, server(before));
    const roomy = await respond(messages, server(after), true);
    expect(after.map((item) => [item.url, item.raw])).toEqual(before.map((item) => [item.url, item.raw]));
    expect(calls(after, '/tokenize')).toHaveLength(1);
    expect(plain).not.toHaveProperty('room');
    expect(roomy).not.toHaveProperty('room');
    // Every earlier turn keeps its reasoning when the call fits.
    expect(chatOf(after).filter((message) => message.reasoning_content).map((message) => message.reasoning_content!.length)).toEqual([2_000, 15_468]);
  });
});

describe('a local loop call that won’t fit (DIO-254)', () => {
  test('the O2 shape: the newest reasoning goes, the call fits, and the document prefix is unchanged', async () => {
    // O2: a 118,000-token read and a lead turn with 3,867 tokens of reasoning, then the advice.
    const messages = o2([['ledger.txt', 'a'.repeat(472_000)]], [2_000, 15_468]);
    const sent: Sent[] = [];
    const reply = await respond(messages, server(sent), true);
    const first = calls(sent, '/apply-template')[0].body.messages as Chat[];
    const counted = tokensOf(render(first));
    expect(counted).toBeGreaterThan(ROOM);
    const room = reply.room as ModelRoom;
    expect(room).toEqual({ counted, room: ROOM, sent: tokensOf(render(chatOf(sent))),
      reasoning: [{ message: 3, chars: 15_468 }], folded: [] });
    expect(room.sent).toBeLessThanOrEqual(ROOM);
    const chat = chatOf(sent);
    // The system prompt, the question, the read call and the read are byte for byte the first count's.
    expect(JSON.stringify(chat.slice(0, 4))).toBe(JSON.stringify(first.slice(0, 4)));
    expect(chat[2].reasoning_content).toHaveLength(2_000);
    // The draft keeps its text and its call; only its reasoning was left out. The advice is unchanged.
    expect(chat[4]).toEqual({ ...first[4], reasoning_content: undefined, content: DRAFT });
    expect(chat[4]).not.toHaveProperty('reasoning_content');
    expect(chat[5]).toEqual(first[5]);
    expect(JSON.parse(String(chat[5].content))).toEqual(ADVICE);
  });

  test('folding: with the reasoning gone and the call still too long, the newest read is folded and the draft and advice stay', async () => {
    const older = 'o'.repeat(240_000), newer = 'n'.repeat(240_000);
    const messages = o2([['march.txt', older], ['april.txt', newer]], [2_000, 15_468]);
    const sent: Sent[] = [];
    const reply = await respond(messages, server(sent), true);
    const first = calls(sent, '/apply-template')[0].body.messages as Chat[];
    expect(reply.room).toEqual({ counted: tokensOf(render(first)), room: ROOM, sent: tokensOf(render(chatOf(sent))),
      reasoning: [{ message: 5, chars: 15_468 }, { message: 1, chars: 2_000 }],
      folded: [{ message: 4, path: 'april.txt', chars: 240_000, bytes: 240_000 }] });
    const chat = chatOf(sent);
    // The newer read is a stub that names the file and its size; the older read is whole.
    expect(JSON.parse(String(chat[5].content))).toEqual({ path: 'april.txt', found: true, bytes: 240_000,
      note: localFoldedRead('april.txt', 240_000) });
    expect(localFoldedRead('april.txt', 240_000)).toBe(
      'The 240,000 characters read from april.txt were left out here to make room. Read it again with read_project_file if you need its exact lines.');
    expect(JSON.parse(String(chat[3].content)).text).toBe(older);
    expect(chat[6]).toMatchObject({ role: 'assistant', content: DRAFT });
    expect(JSON.parse(String(chat[7].content))).toEqual(ADVICE);
  });

  test('one that cannot fit is still refused with the same sentence, and nothing is sent', async () => {
    const sent: Sent[] = [];
    await expect(respond([{ role: 'user', content: 'x'.repeat(4 * ROOM + 400) }], server(sent), true))
      .rejects.toThrow('This message and its answer need more than 131,072 tokens. Start a new thread or reduce its sources.');
    expect(calls(sent, '/chat/completions')).toEqual([]);
  });

  test('without the loop’s ask, a call that won’t fit is refused as before', async () => {
    const sent: Sent[] = [];
    await expect(respond(o2([['ledger.txt', 'a'.repeat(472_000)]], [2_000, 15_468]), server(sent)))
      .rejects.toThrow('need more than 131,072 tokens');
    expect(sent.map((item) => item.url.replace(LOCAL_BASE, ''))).toEqual(['apply-template', 'tokenize']);
  });
});

// --- through a loop: the model step records what its call left out -----------------------------------

let root: string | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let listener: Server | undefined;
afterEach(async () => {
  if (listener) {
    const closing = listener;
    listener = undefined;
    try {
      await app!.locals.close();
    } finally {
      closing.closeAllConnections();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  }
  app = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = undefined;
});

describe('a local loop’s model step (DIO-254)', () => {
  test('records the reasoning its call left out, and its other steps record nothing', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dio254-make-room-'));
    const ledger = 'l'.repeat(400_000);
    const sent: Sent[] = [];
    // The lead plans, reads the ledger with long reasoning, then answers.
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(LOCAL_BASE)) throw new Error(`This fixture never reaches ${url}.`);
      const raw = String(init?.body ?? '');
      const body = JSON.parse(raw) as Record<string, unknown>;
      sent.push({ url, raw, body });
      if (url.endsWith('/apply-template')) return Response.json({ prompt: render(body.messages as Chat[]) });
      if (url.endsWith('/tokenize')) return Response.json({ tokens: Array(tokensOf(String(body.content))).fill(1) });
      const tools = (body.tools as unknown[] | undefined) ?? [];
      const read = (body.messages as Chat[]).some((message) => message.role === 'tool');
      const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
      if (!tools.length || read)
        return localAnswerStream({ id: `answer-${sent.length}`, model: MEADOW_MODEL, usage,
          choices: [{ finish_reason: 'stop', message: { content: read ? 'March is short by 40.' : '1. Read the ledger.\n2. Answer.' } }] });
      return localAnswerStream({ id: `answer-${sent.length}`, model: MEADOW_MODEL, usage, choices: [{ finish_reason: 'tool_calls',
        message: { content: null, reasoning_content: 'r'.repeat(80_000),
          tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify({ path: 'ledger.txt' }) } }] } }] });
    }) as typeof fetch;
    app = await createApp({
      dataDir: path.join(root, 'data'),
      projectRoot: path.join(root, 'projects'),
      reviewerAdapter: null,
      modelApiTransport: transport,
      localModel: { host: fakeLocalHost({ state: 'ready', mode: 'Deep', model: MEADOW_MODEL, contextTokens: 131_072 }).host,
        source: new FixedLocalModel(descriptor(), MEADOW_FOLDER) },
      automationTickMs: null,
    });
    listener = await new Promise<Server>((resolve) => {
      const opened = app!.listen(0, '127.0.0.1', () => resolve(opened));
    });
    const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api`;
    const call = async <T = any>(route: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
      return (text ? JSON.parse(text) : null) as T;
    };
    const store = (): Store => app!.locals.store;
    const host = (): HarnessHost => app!.locals.harness;
    const projectId = (await call<Project>('/projects', 'POST', { name: 'Ledger' })).id;
    await fs.writeFile(path.join(store().state(projectId).project.folder, 'ledger.txt'), ledger);
    const policy = await call<{ version: number }>(`/projects/${projectId}/cloud-sharing`);
    await call(`/projects/${projectId}/cloud-sharing`, 'PUT', { expectedVersion: policy.version, routes: ['bonsai'],
      documents: ['ledger.txt'], shareConversationHistory: false, shareReviewPackets: false });
    const taskId = (await call<{ id: string }>(`/projects/${projectId}/tasks`, 'POST', { name: 'Check the ledger' })).id;
    const started = await call<{ runId: string }>(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1, commandId: 'dio254-room', taskId, goal: 'Check the ledger and say what is short.',
      route: 'bonsai', model: 'local:deep', accountRoute: LOCAL_MODEL_ACCOUNT, consent: true, sources: ['ledger.txt'], escalation: false,
    });
    const run = await vi.waitFor(async () => {
      const current = await host().get(projectId, started.runId);
      if (!['completed', 'failed', 'cancelled', 'reconcile_required'].includes(current.state)) throw new Error(`The run is still ${current.state}.`);
      return current;
    }, { timeout: 60_000, interval: 50 });
    const models = run.steps.filter((step) => step.intent.kind === 'model');
    expect(run.state, JSON.stringify({ failure: run.failure, steps: run.steps.map((step) => [step.intent.stepId, step.state, step.error]) }))
      .toBe('completed');
    const rooms = models.map((step) => [step.intent.stepId, (step.output as { room?: ModelRoom } | null)?.room ?? null]);
    expect(rooms.map(([id]) => id)).toEqual(['model:plan', 'model:0', 'model:1']);
    expect(rooms[0][1]).toBeNull();
    expect(rooms[1][1]).toBeNull();
    const room = rooms[2][1] as ModelRoom;
    expect(room.reasoning.map((turn) => turn.chars)).toEqual([80_000]);
    expect(room.folded).toEqual([]);
    expect(room.counted).toBeGreaterThan(ROOM);
    expect(room.sent).toBeLessThanOrEqual(ROOM);
    // What was sent for that call is what the record says: the read whole, the reasoning left out.
    const last = calls(sent, '/chat/completions').at(-1)!.body.messages as Chat[];
    expect(last.some((message) => message.reasoning_content)).toBe(false);
    expect(last.some((message) => message.role === 'tool' && String(message.content).includes(ledger))).toBe(true);
  });
});
