/**
 * DIO-247.N4: a follow-up reuses the provider's prompt cache. The host reads every attached text
 * file before the person's message, in path order, so two messages that attach the same files send
 * the same request up to that message: on AWS, whose cache matches a prefix, and on the local
 * route, whose server keeps a checkpoint at the start of the last user message. Only the network is
 * replaced, so nothing here reaches a provider, spends money or starts a model.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { AWS_LUNA_MODEL, awsQualificationIdentity } from '../server/engines/aws-bedrock';
import { routeCapability } from '../server/engines/route-cache';
import { testOnlySecretBox } from '../server/connection-secrets';
import { baselineRedact } from '../server/secrets';
import { accountContext, withCacheSetting, type TurnCacheReport } from '../server/harness/context-assembly';
import { HOST_READ_OPENER, hostReadCount } from '../server/harness/native-agent';
import type { ModelSessionRuns } from '../server/harness/model-session-run';
import type { MessageResult } from '../server/interaction-service';
import type { Store } from '../server/store';
import type { PortableMessage } from '../shared/harness';
import { cacheAccount, withFilesMarked, type CacheMark } from '../shared/route-capabilities';
import type { Conversation, Project } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import { K3_CONNECTION, SCENARIO_NOW } from './fixtures/cache-body-scenarios.js';
import { BONSAI_MODEL, FixedLocalModel, fakeLocalHost, localAnswerStream } from './fixtures/local-model.js';

type Item = Record<string, unknown>;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVnQAAAAASUVORK5CYII=', 'base64');

/** A Markdown table of about `bytes` bytes, with the quotes, apostrophes and line breaks real records have. */
function records(name: string, bytes: number): string {
  let text = `# ${name}\n\n| Week | Item | Count | Note |\n| --- | --- | --- | --- |\n`;
  for (let week = 1; ; week++) {
    const row = `| ${week} | "${name}" linen | ${90 + (week % 10)} of 100 | the driver's note for week ${week} |\n`;
    if (Buffer.byteLength(text + row) > bytes) return text;
    text += row;
  }
}
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** One app over a fresh folder; `options` names the engines and the network it answers with. */
async function openApp(options: (root: string) => Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-prefix-cache-'));
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
    ...options(root),
  } as Parameters<typeof createApp>[0]);
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (route: string, method = 'GET', body?: unknown) =>
    fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const api = async <T>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(route, method, body);
    const text = await response.text();
    expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
    return JSON.parse(text) as T;
  };
  const project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const store = () => app.locals.store as Store;
  const folder = store().state(project.id).project.folder;
  const sources = (names: string[]) =>
    Promise.all(names.map(async (name) => ({
      path: name,
      sha: name.endsWith('.png') ? (await store().readModelImage(project.id, name)).sha : (await store().readDocument(project.id, name)).sha,
    })));
  const send = async (commandId: string, text: string, attached: string[] = [], mode = 'auto') =>
    api<MessageResult>(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', {
      commandId, text, mode, sources: await sources(attached), consent: true,
    });
  const assistantTurns = () =>
    store().state(project.id).conversations.find((item) => item.id === thread.id)!.turns.filter((turn) => turn.role === 'assistant');
  const turnRun = async (result: MessageResult, commandId: string) =>
    (await (app.locals.harness.modelSessions as ModelSessionRuns).turnRun(project.id, result.runId, commandId))!;
  const close = async () => {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await fs.rm(root, { recursive: true, force: true });
  };
  return { api, project, thread, folder, send, assistantTurns, turnRun, close };
}
type Opened = Awaited<ReturnType<typeof openApp>>;

describe('hostReadCount: where the host\'s reads end', () => {
  const opener: PortableMessage = { role: 'user', text: HOST_READ_OPENER };
  const call = (file: string): PortableMessage => ({ role: 'assistant', tool: 'read_source', input: { path: file } });
  const result = (text: string): PortableMessage => ({ role: 'tool', name: 'read_source', output: { found: true, text } });
  const said: PortableMessage = { role: 'user', text: 'Which deliveries came up short?' };

  test('counts the opener and each read before the person\'s message, and nothing after it', () => {
    expect(hostReadCount([opener, call('a.md'), result('A'), said])).toBe(3);
    expect(hostReadCount([opener, call('a.md'), result('A'), call('b.md'), result('B'), said])).toBe(5);
    // The model's own calls come after the message and keep their provider ids.
    expect(hostReadCount([opener, call('a.md'), result('A'), said, call('b.md'), result('B')])).toBe(3);
  });

  test('is zero unless the whole shape is there', () => {
    expect(hostReadCount([])).toBe(0);
    expect(hostReadCount([said])).toBe(0);
    // A message that says the opener's words is still the person's message.
    expect(hostReadCount([opener])).toBe(0);
    expect(hostReadCount([opener, said])).toBe(0);
    // Reads with no message after them, or a call left unanswered.
    expect(hostReadCount([opener, call('a.md'), result('A')])).toBe(0);
    expect(hostReadCount([opener, call('a.md'), result('A'), call('b.md'), said])).toBe(0);
    // Another opener, an opener that carries a tool, a result for another tool, an answer instead of a message.
    expect(hostReadCount([{ role: 'user', text: 'Read the files.' }, call('a.md'), result('A'), said])).toBe(0);
    expect(hostReadCount([{ ...opener, tool: 'read_source' }, call('a.md'), result('A'), said])).toBe(0);
    expect(hostReadCount([opener, call('a.md'), { role: 'tool', name: 'list_sources', output: [] }, said])).toBe(0);
    expect(hostReadCount([opener, call('a.md'), result('A'), { role: 'assistant', text: 'Done.' }])).toBe(0);
  });
});

describe('a follow-up on AWS sends the same request up to the person\'s message', () => {
  const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
  const DOCS: Record<string, string> = {
    'Deliveries.md': records('Deliveries', 16_000),
    'Invoices.md': records('Invoices', 16_000),
    'Orders.md': records('Orders', 16_000),
  };
  const WEEKS = Array.from({ length: 8 }, (_, n) => `Week ${n + 1}.md`);
  for (const week of WEEKS) DOCS[week] = records(week.replace('.md', ''), 15_950);
  type Body = { input: Item[]; tools?: Item[] };
  let seen: { body: Body; bytes: number }[];
  let app: Opened;

  const textOf = (item: Item | undefined) => {
    const content = item?.content;
    if (typeof content === 'string') return content;
    return Array.isArray(content) ? content.map((part) => String((part as Item).text ?? '')).join('') : '';
  };
  /** The person's message: the last user item, after the host's reads. */
  const personText = (body: Body) => textOf([...body.input].reverse().find((item) => item.role === 'user'));
  /** Everything before the person's message: the system text, the opener and the reads. */
  const lead = (body: Body) => body.input.slice(0, body.input.map((item) => item.role).lastIndexOf('user'));
  const usage = { input_tokens: 1_400, input_tokens_details: { cached_tokens: 0 }, output_tokens: 220, output_tokens_details: { reasoning_tokens: 80 }, total_tokens: 1_620 };
  /** Answers from what the request carries. A message that says LIST-SOURCES makes seven calls of its own first. */
  const aws = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    seen.push({ body, bytes: Buffer.byteLength(String(init?.body)) });
    const results = body.input.filter((item) => item.type === 'function_call_output');
    const own = results.filter((item) => String(item.call_id).startsWith('call_list_')).length;
    const output: Item[] = personText(body).includes('LIST-SOURCES') && own < 7
      ? [{ type: 'function_call', id: `fc_${seen.length}`, call_id: `call_list_${own + 1}`, name: 'list_sources', arguments: '{}', status: 'completed' }]
      : [{ type: 'message', id: `msg_${seen.length}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: `Read ${results.length - own} attached files.`, annotations: [] }] }];
    return sseResponse(responsesEvents({
      id: `resp_${seen.length}`, object: 'response', created_at: 1_790_000_000, status: 'completed', model: AWS_LUNA_MODEL,
      output: [{ type: 'reasoning', id: `rs_${seen.length}`, summary: [], encrypted_content: `enc-${seen.length}` }, ...output],
      usage, incomplete_details: null, error: null,
    }), { 'x-amzn-requestid': `req-${seen.length}` });
  }) as typeof globalThis.fetch;

  beforeEach(async () => {
    seen = [];
    app = await openApp((root) => ({
      engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
      secretBox: testOnlySecretBox(),
      modelApiTransport: aws,
    }));
    for (const [name, text] of Object.entries(DOCS)) await fs.writeFile(path.join(app.folder, name), text, 'utf8');
    await app.api(`/projects/${app.project.id}/threads/${app.thread.id}`, 'PUT', { engine: 'aws-bedrock' });
    await app.api(`/projects/${app.project.id}/cloud-sharing`, 'PUT', {
      expectedVersion: 0, routes: ['aws-bedrock'], documents: Object.keys(DOCS), shareConversationHistory: true, shareReviewPackets: false,
    });
    await app.api('/ai/model-api/aws-bedrock', 'PUT', {
      accountId: '123456789012', region: 'us-east-1', model: AWS_LUNA_MODEL, apiKey: SECRET, expiresAt: null, consent: true,
    });
    await app.api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  });
  afterEach(async () => {
    await app.close();
  });

  test('two messages that attach the same files, in any order, share every byte before the person\'s message', async () => {
    const first = await app.send('m-1', 'Which deliveries came up short?', ['Orders.md', 'Deliveries.md', 'Invoices.md']);
    const second = await app.send('m-2', 'And did the invoices bill for them?', ['Invoices.md', 'Orders.md', 'Deliveries.md']);
    expect([first.outcome, second.outcome]).toEqual([{ status: 'answered' }, { status: 'answered' }]);
    expect(second.answerText).toBe('Read 3 attached files.');
    expect(seen).toHaveLength(2);
    const [one, two] = seen.map((call) => call.body);

    // The opener, then the host's three reads in path order under ids fixed by position.
    expect(lead(one)).toHaveLength(8);
    expect(textOf(one.input[1])).toBe(HOST_READ_OPENER);
    expect(one.input.filter((item) => item.type === 'function_call').map((item) => [item.call_id, JSON.parse(String(item.arguments)).path])).toEqual([
      ['host-read-1', 'Deliveries.md'],
      ['host-read-2', 'Invoices.md'],
      ['host-read-3', 'Orders.md'],
    ]);
    expect(JSON.stringify(lead(two))).toBe(JSON.stringify(lead(one)));
    expect(JSON.stringify(two.tools)).toBe(JSON.stringify(one.tools));

    // Only the person's message differs: it carries the history, the list of files and what was said.
    expect(two.input).toHaveLength(9);
    expect(personText(two)).toContain('Which deliveries came up short?');
    expect(personText(two)).toContain('Deliveries.md');
    expect(personText(two)).not.toContain('the driver\'s note for week 1 |');
    const shared = bytesOf(lead(two)) / bytesOf(two.input);
    console.log(`N4 observed: the follow-up shares ${(100 * shared).toFixed(2)}% of its input bytes`);
    expect(shared, `the follow-up shares ${(100 * shared).toFixed(1)}% of its input`).toBeGreaterThan(0.95);
  });

  test('the host\'s reads are recorded steps that leave the model its own tool calls, and count with the files', async () => {
    const attached = ['Orders.md', 'Deliveries.md', 'Invoices.md'];
    const results = [
      ['m-1', await app.send('m-1', 'Which deliveries came up short?', attached)],
      ['m-2', await app.send('m-2', 'And did the invoices bill for them?', attached)],
    ] as const;
    for (const [commandId, result] of results) {
      const child = await app.turnRun(result, commandId);
      expect(child.state).toBe('completed');
      expect(child.steps.map((step) => `${step.intent.stepId}:${step.intent.kind}:${step.intent.name}`)).toEqual([
        'host:0:tool:read_source',
        'host:1:tool:read_source',
        'host:2:tool:read_source',
        'context:0:transform:prepare_model_context',
        'model:0:model:aws-bedrock',
      ]);
      expect(child.budget.toolCalls).toBe(16 + 3);
      expect(child.used.toolCalls).toBe(3);
    }
    const context = app.assistantTurns()[1].context!;
    const files = context.sections.find((section) => section.id === 'project-files')!;
    expect(files.detail).toBe('3 attached, read before the message');
    expect(files.bytes).toBeGreaterThan(attached.reduce((sum, name) => sum + Buffer.byteLength(DOCS[name]), 0));
    expect(context.sections.find((section) => section.id === 'tool-results')).toMatchObject({ bytes: 0 });
  });

  test('every call of one message starts with the same reads, and the model still makes its own calls', async () => {
    const asked = await app.send('m-list', 'LIST-SOURCES, then say how many files were read.', ['Orders.md', 'Deliveries.md', 'Invoices.md']);
    expect(asked.outcome).toEqual({ status: 'answered' });
    expect(asked.answerText).toBe('Read 3 attached files.');
    // Seven calls of the model's own, then its answer: the turn's eight model calls.
    expect(seen).toHaveLength(8);
    for (const call of seen.slice(1)) expect(JSON.stringify(lead(call.body))).toBe(JSON.stringify(lead(seen[0].body)));
    const child = await app.turnRun(asked, 'm-list');
    expect(child.used).toMatchObject({ modelCalls: 8, toolCalls: 3 + 7 });
    expect(child.steps.filter((step) => step.intent.name === 'list_sources')).toHaveLength(7);
  });

  test('under the owner\'s explicit prefix the files are marked too, at the same place on every message', async () => {
    await app.api('/ai/model-api/aws-bedrock/cache-policy', 'PUT', { policy: 'explicit-prefix' });
    const attached = ['Orders.md', 'Deliveries.md', 'Invoices.md'];
    await app.send('m-1', 'Which deliveries came up short?', attached);
    await app.send('m-2', 'And did the invoices bill for them?', attached);
    expect(seen).toHaveLength(2);
    for (const { body } of seen) {
      // Two breakpoints: the stable start of the instructions, and the result of the last read.
      expect(JSON.stringify(body).split('"prompt_cache_breakpoint"')).toHaveLength(3);
      const outputs = body.input.filter((item) => item.type === 'function_call_output');
      expect(outputs.map((item) => [item.call_id, Array.isArray(item.output)])).toEqual([
        ['host-read-1', false],
        ['host-read-2', false],
        ['host-read-3', true],
      ]);
    }
    expect(JSON.stringify(lead(seen[1].body))).toBe(JSON.stringify(lead(seen[0].body)));
    const cache = app.assistantTurns()[1].context!.cache;
    expect(cache).toMatchObject({ policy: 'explicit-prefix', marked: 'stable-prefix-and-files' });
    expect(cache.note).toContain('the attached files read before the message are marked for caching for 30 minutes');
  });

  test('a message at the admission limits still goes: eight files, 128 KB of text and a full history', async () => {
    const long = 'The spring menu needs the linen order checked against every delivery slip. '.repeat(420).trim();
    expect(long.length).toBeLessThanOrEqual(32_000);
    // Ask on both messages, so the second continues the first's lineage and carries its history.
    await app.send('m-history', long, [], 'ask');
    expect(WEEKS.reduce((sum, name) => sum + Buffer.byteLength(DOCS[name]), 0)).toBeGreaterThan(127_000);
    expect(WEEKS.reduce((sum, name) => sum + Buffer.byteLength(DOCS[name]), 0)).toBeLessThanOrEqual(128_000);

    const asked = await app.send('m-limits', 'Which weeks came up short?', WEEKS, 'ask');
    expect(asked.outcome).toEqual({ status: 'answered' });
    expect(asked.answerText).toBe('Read 8 attached files.');
    const last = seen.at(-1)!;
    expect(last.body.input.filter((item) => item.type === 'function_call')).toHaveLength(8);
    expect(personText(last.body)).toContain('every delivery slip');
    console.log(`N4 observed: the request at the admission limits is ${last.bytes} bytes of 200,000`);
    expect(last.bytes, `the request is ${last.bytes} bytes`).toBeLessThanOrEqual(200_000);
  });
});

describe('a follow-up on the local route sends the same chat messages up to the person\'s message', () => {
  type ChatBody = { messages: { role: string; content: unknown; tool_call_id?: string }[]; tools: unknown[] };
  let calls: ChatBody[];
  let app: Opened;
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/apply-template')) return Response.json({ prompt: 'Fixture template' });
    if (String(url).endsWith('/tokenize')) return Response.json({ tokens: [1, 2, 3] });
    expect(String(url)).toBe('http://127.0.0.1:18082/v1/chat/completions');
    const sent = JSON.parse(String(init?.body)) as ChatBody & { model: string };
    calls.push(sent);
    return localAnswerStream({ id: `local-${calls.length}`, model: sent.model,
      choices: [{ finish_reason: 'stop', message: { content: 'The local model answered.' } }],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } });
  };
  const lead = (body: ChatBody) => body.messages.slice(0, body.messages.map((message) => message.role).lastIndexOf('user'));

  beforeEach(async () => {
    calls = [];
    const { host } = fakeLocalHost({ state: 'ready', mode: 'Full', model: BONSAI_MODEL, contextTokens: 131072, owned: true, detail: 'Ready.' });
    // The desktop's own redaction (app.ts redactFor), as the local route's integration test runs it.
    app = await openApp((root) => ({
      engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [], redactFor: () => baselineRedact }),
      modelApiTransport: transport,
      localModel: { host, source: new FixedLocalModel() },
      automationTickMs: null,
    }));
    await fs.writeFile(path.join(app.folder, 'Menu.md'), records('Menu', 4_000));
    await fs.writeFile(path.join(app.folder, 'Prices.md'), records('Prices', 4_000));
    await fs.writeFile(path.join(app.folder, 'picture.png'), png);
    await app.api(`/projects/${app.project.id}/cloud-sharing`, 'PUT', {
      expectedVersion: 0, routes: ['bonsai'], documents: ['Menu.md', 'Prices.md', 'picture.png'], shareConversationHistory: true, shareReviewPackets: false,
    });
    await app.api(`/projects/${app.project.id}/threads/${app.thread.id}`, 'PUT', {
      engine: 'bonsai', requested: { model: 'local:full', effort: 'xhigh', agent: 'auto' },
    });
  });
  afterEach(async () => {
    await app.close();
  });

  test('two messages on the same files share the system text, the opener and the reads, so the server restores its checkpoint', async () => {
    await app.send('l-1', 'What is on the menu?', ['Prices.md', 'Menu.md'], 'ask');
    await app.send('l-2', 'And what does it cost?', ['Menu.md', 'Prices.md'], 'ask');
    expect(calls).toHaveLength(2);
    expect(lead(calls[0]).map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(lead(calls[0])[1].content).toBe(HOST_READ_OPENER);
    expect(lead(calls[0]).filter((message) => message.role === 'tool').map((message) => message.tool_call_id)).toEqual(['host-read-1', 'host-read-2']);
    expect(JSON.stringify(lead(calls[1]))).toBe(JSON.stringify(lead(calls[0])));
    expect(JSON.stringify(calls[1].tools)).toBe(JSON.stringify(calls[0].tools));
    // The person's message is the last user message: the history and what was said follow the reads.
    expect(String(calls[1].messages.at(-1)!.content)).toContain('What is on the menu?');
  });

  test('an image goes on the person\'s message, after the reads', async () => {
    await app.send('l-image', 'Describe the picture against the menu.', ['picture.png', 'Menu.md'], 'ask');
    const sent = calls[0].messages;
    expect(sent.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(sent[1].content).toBe(HOST_READ_OPENER);
    expect((sent[4].content as { type: string }[]).map((part) => part.type)).toEqual(['text', 'image_url']);
    expect(JSON.stringify(sent.slice(0, 4))).not.toContain('image_url');
  });
});

describe('the record says the files were marked, and counts them toward the marked start', () => {
  const k3 = routeCapability({ identity: awsQualificationIdentity(K3_CONNECTION), endpoint: K3_CONNECTION.baseUrl, receipt: null, now: SCENARIO_NOW.getTime() });
  const prefix = 'p'.repeat(2_000);
  const instructions = `${prefix}\n\nThis message may read the delivery notes.`;
  const account = (reads?: { count: number; bytes: number }) =>
    accountContext({
      route: 'aws-bedrock',
      model: K3_CONNECTION.modelId,
      system: instructions,
      guidance: [],
      tools: [],
      parts: { history: '', files: reads ? '- Deliveries.md' : '', message: 'Which deliveries arrived short?' },
      separatorBytes: 0,
      documents: reads?.count ?? 0,
      ...(reads ? { reads } : {}),
      requestLimitBytes: 200_000,
      prefix: { sha: 'a'.repeat(64), bytes: prefix.length },
      previousPrefixSha: null,
      history: null,
      compaction: null,
    });
  const report = (marked: CacheMark): TurnCacheReport => ({ policy: 'explicit-prefix', record: k3, marked });

  test('each mark with the files has its own sentence', () => {
    expect(withFilesMarked('stable-prefix')).toBe('stable-prefix-and-files');
    expect(withFilesMarked('whole-instructions')).toBe('whole-instructions-and-files');
    expect(withFilesMarked(null)).toBeNull();
    expect(cacheAccount('explicit-prefix', null, 'stable-prefix-and-files').note).toBe(
      'The stable start of the instructions and the attached files read before the message are marked for caching for 30 minutes, under a key kept to this business and route.',
    );
    expect(cacheAccount('explicit-prefix', null, 'whole-instructions-and-files').note).toBe(
      'The whole instructions and the attached files read before the message are marked for caching for 30 minutes, so reuse holds only while the instructions stay the same.',
    );
  });

  test('the marked start runs to the end of the reads, so files long enough are not called too short', () => {
    // About 500 tokens of instructions alone: under the declared minimum of 1,024.
    expect(withCacheSetting(account(), report('stable-prefix'), { prefix, instructions }).cache.note).toContain('too short to be cached');
    // The same instructions and 8,000 bytes of files read before the message: about 2,500 tokens.
    const long = withCacheSetting(account({ count: 1, bytes: 8_000 }), report('stable-prefix-and-files'), { prefix, instructions }).cache;
    expect(long).toMatchObject({ policy: 'explicit-prefix', marked: 'stable-prefix-and-files' });
    expect(long.note).toBe(cacheAccount('explicit-prefix', k3, 'stable-prefix-and-files').note);
    // Files too small to reach the minimum still say so, counting them in.
    const short = withCacheSetting(account({ count: 1, bytes: 400 }), report('stable-prefix-and-files'), { prefix, instructions }).cache;
    expect(short.note).toContain('The marked start is about 604 tokens, under this model’s minimum of 1,024 tokens');
  });
});
