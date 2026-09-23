/**
 * The Google Vertex AI route below the harness: the real `ai`,
 * `@ai-sdk/google-vertex` and `@ai-sdk/google` packages build and parse every
 * request, and only the network is replaced by a captured transport. Nothing
 * here reaches Google, and no real credential exists.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { RawToolActivity } from '../shared/adapter-contract.js';
import type { ToolDescriptor } from '../shared/harness.js';
import { micro } from '../shared/managed-usage.js';
import { isModelApiRoute, MODEL_API_ROUTES } from '../shared/model-api.js';
import {
  GOOGLE_VERTEX_ROUTE,
  mintVertexToken,
  readAdcIdentity,
  respondVertex,
  VERTEX_GEMINI_MODEL,
  VERTEX_RATE_CARDS,
  vertexAccountRoute,
  vertexBaseUrl,
  vertexConnectionSchema,
  vertexRateCard,
  vertexUsage,
  type VertexConnection,
} from '../server/engines/google-vertex.js';
import { CONVERSATION_LIMITS, ModelApiError } from '../server/engines/model-api-core.js';
import { exposureAttempt } from '../server/engines/aws-bedrock.js';
import { SpendExposure, usageCost } from '../server/spend-exposure.js';

const TOKEN = 'ya29.test-only-access-token-0123456789';
const PROJECT = 'nectovia-founder-proof';
const NOW = new Date('2026-09-23T12:00:00.000Z');
const CONNECTION: VertexConnection = {
  v: 1,
  id: 'google-vertex-1',
  projectId: PROJECT,
  location: 'global',
  baseUrl: vertexBaseUrl(PROJECT),
  model: 'gemini-3.8-flash',
  processing: 'google-global',
  payer: { kind: 'google-cloud-project', projectId: PROJECT },
  credential: {
    kind: 'google-adc',
    source: 'gcloud-user',
    namedBy: 'gcloud-default',
    fingerprint: '0123456789abcdef',
    principal: null,
    quotaProject: PROJECT,
    savedAt: '2026-09-23T08:00:00.000Z',
    expiresAt: null,
  },
  revision: 2,
  createdAt: '2026-09-23T08:00:00.000Z',
  updatedAt: '2026-09-23T08:00:00.000Z',
};
const STREAM_URL = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse`;
const READ_SOURCE: ToolDescriptor = {
  name: 'read_source',
  version: '1',
  description: 'Read one attached source.',
  effect: 'read',
  permission: null,
  approval: false,
  destination: 'local',
  trustedInputRequired: false,
  cost: 0,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};
type Item = Record<string, unknown>;
const USAGE = {
  promptTokenCount: 900,
  cachedContentTokenCount: 100,
  candidatesTokenCount: 150,
  thoughtsTokenCount: 50,
  totalTokenCount: 1_100,
};
const chunk = (parts: Item[], extra: Item = {}): Item => ({
  candidates: [{ content: { role: 'model', parts }, index: 0, ...extra }],
  modelVersion: 'gemini-3.8-flash',
  responseId: 'vtx-resp-1',
});
/** Gemini's stream: text in pieces, then a final chunk with the finish reason and usage. */
function geminiStream(parts: Item[], options: { finish?: string | null; usage?: Item | null; model?: string } = {}) {
  const events: Item[] = [];
  for (const part of parts) {
    if (typeof part.text === 'string' && part.thought !== true && part.text.length > 4) {
      const middle = Math.floor(part.text.length / 2);
      events.push(chunk([{ text: part.text.slice(0, middle) }]));
      events.push(chunk([{ text: part.text.slice(middle) }]));
    } else events.push(chunk([part]));
  }
  const last: Item = chunk([], options.finish === null ? {} : { finishReason: options.finish ?? 'STOP' });
  (last.candidates as Item[])[0].content = { role: 'model', parts: [] };
  if (options.usage !== null) last.usageMetadata = options.usage ?? USAGE;
  if (options.model) for (const event of [...events, last]) event.modelVersion = options.model;
  events.push(last);
  return events;
}
const sse = (events: unknown[], headers: Record<string, string> = {}) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-goog-request-id': 'goog-req-1', ...headers },
  });
const jsonError = (status: number, code: string, message: string) =>
  new Response(JSON.stringify([{ error: { code: status, message, status: code } }]), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}
function transport(script: Array<() => Response | Promise<Response>>) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const next = script.shift();
    if (!next) throw new Error('No scripted response left.');
    return next();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

let dir: string;
let exposure: SpendExposure;
let run = 0;
const AMBIENT = ['GOOGLE_VERTEX_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_CLOUD_PROJECT'] as const;
const saved = Object.fromEntries(AMBIENT.map((name) => [name, process.env[name]]));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-vertex-transport-'));
  exposure = new SpendExposure(dir);
  await exposure.init();
  await exposure.setCap(CONNECTION.id, micro(1_000_000), { approvedBy: 'test owner', note: 'one dollar' });
  // Ambient Google settings must never be read: the route uses only the saved project and minted token.
  process.env.GOOGLE_API_KEY = 'ambient-ai-studio-key-must-not-be-sent';
  process.env.GEMINI_API_KEY = 'ambient-gemini-key-must-not-be-sent';
  process.env.GOOGLE_VERTEX_PROJECT = 'ambient-other-project';
  process.env.GOOGLE_VERTEX_LOCATION = 'us-central1';
  process.env.GOOGLE_CLOUD_PROJECT = 'ambient-other-project';
  run += 1;
});
afterEach(async () => {
  for (const name of AMBIENT)
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  await fs.rm(dir, { recursive: true, force: true });
});

function call(fetch: typeof globalThis.fetch, overrides: Partial<Parameters<typeof respondVertex>[0]> = {}) {
  const messages: ModelMessage[] = overrides.messages ?? [{ role: 'user', content: 'Reply with exactly DIOMEDES_VERTEX_OK.' }];
  return respondVertex({
    connection: CONNECTION,
    secret: TOKEN,
    card: vertexRateCard(NOW),
    exposure,
    attempt: exposureAttempt(`run-${run}`, 'model@1', messages),
    instructions: 'You are Nectovia. Answer only from attached sources.',
    messages,
    tools: [],
    effort: 'medium',
    limits: CONVERSATION_LIMITS,
    signal: new AbortController().signal,
    transport: fetch,
    now: () => NOW,
    ...overrides,
  });
}
async function failure(promise: Promise<unknown>): Promise<ModelApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelApiError);
    return error as ModelApiError;
  }
  throw new Error('Expected the call to fail.');
}
const holds = () => exposure.list(CONNECTION.id);

describe('google-vertex is its own route', () => {
  test('a distinct model-API route beside the accepted ones, which are unchanged', () => {
    expect(isModelApiRoute(GOOGLE_VERTEX_ROUTE)).toBe(true);
    expect(MODEL_API_ROUTES).toEqual(['aws-bedrock', 'azure-openai', 'openrouter', 'google-vertex']);
    expect(VERTEX_GEMINI_MODEL).toBe('gemini-3.8-flash');
  });

  test('the connection binds project, global location, model, payer and credential fingerprint', () => {
    expect(vertexConnectionSchema.parse(CONNECTION)).toEqual(CONNECTION);
    expect(vertexAccountRoute(CONNECTION)).toBe(`google-vertex:google-vertex-1:${PROJECT}@r2`);
    for (const bad of [
      { ...CONNECTION, location: 'us-central1' },
      { ...CONNECTION, model: 'gemini-3.8-flash-latest' },
      { ...CONNECTION, baseUrl: vertexBaseUrl('someone-else-project') },
      { ...CONNECTION, payer: { kind: 'google-cloud-project', projectId: 'someone-else-project' } },
      { ...CONNECTION, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    ])
      expect(() => vertexConnectionSchema.parse(bad)).toThrow();
  });
});

describe('the request the real SDK sends to Vertex', () => {
  test('a streamed final answer: the project’s global endpoint, bearer token and billed project only, one request', async () => {
    const net = transport([() => sse(geminiStream([{ text: 'thinking about it', thought: true }, { text: 'DIOMEDES_VERTEX_OK' }]))]);
    const deltas: string[] = [];
    const result = await call(net.fetch, { onDelta: (text) => deltas.push(text) });

    expect(result.outcome).toEqual({ kind: 'final', text: 'DIOMEDES_VERTEX_OK' });
    expect(deltas.join('')).toBe('DIOMEDES_VERTEX_OK');
    expect(net.sent).toHaveLength(1);
    const [sent] = net.sent;
    expect(sent.url).toBe(STREAM_URL);
    expect(sent.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(sent.headers.get('x-goog-user-project')).toBe(PROJECT);
    expect(sent.headers.get('x-goog-api-key')).toBeNull();
    expect(sent.headers.get('x-vertex-ai-llm-shared-request-type')).toBeNull();
    const serialized = JSON.stringify({ url: sent.url, headers: [...sent.headers], body: sent.body });
    expect(serialized).not.toContain('ambient');
    expect(serialized).not.toContain('diomedes-guarded-credential');
    expect(sent.body.systemInstruction).toEqual({ parts: [{ text: 'You are Nectovia. Answer only from attached sources.' }] });
    expect(sent.body.generationConfig).toMatchObject({
      maxOutputTokens: CONVERSATION_LIMITS.maxOutputTokens,
      thinkingConfig: { thinkingLevel: 'medium', includeThoughts: false },
    });
    expect(sent.body.tools).toBeUndefined();

    const card = vertexRateCard(NOW);
    const expected = usageCost(card, {
      inputTokens: 900,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      outputTokens: 200,
      reasoningTokens: 50,
    }).microUsd;
    // 800 fresh at $0.75, 100 cached at $0.075, 200 output (150 answer + 50 thinking) at $3.75.
    expect(expected).toBe(Math.ceil((800 * 750_000 + 100 * 75_000 + 200 * 3_750_000) / 1_000_000));
    expect(result.reservation.state).toBe('settled');
    expect(result.reservation.rateCardVersion).toBe('google-vertex:gemini-3.8-flash:global:standard:intro-2026.1');
    expect(result.reservation.settledMicroUsd).toBe(expected);
    expect(result.reservation.providerRequestId).toBe('goog-req-1');
    expect(result.reportedModel).toBe('gemini-3.8-flash');
    expect(result.responseId).toBe('vtx-resp-1');
    expect(result.usage).toEqual({ inputTokens: 900, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 50 });
  });

  test('an ambient Express Mode key never switches the route to key billing', async () => {
    process.env.GOOGLE_VERTEX_API_KEY = 'ambient-express-key-must-not-be-sent';
    const net = transport([() => sse(geminiStream([{ text: 'DIOMEDES_VERTEX_OK' }]))]);
    await call(net.fetch);
    expect(net.sent[0].url).toBe(STREAM_URL);
    expect(net.sent[0].headers.get('x-goog-api-key')).toBeNull();
    expect(JSON.stringify([...net.sent[0].headers])).not.toContain('ambient');
  });

  test('a genuine function call becomes one canonical tool request under the provider’s identity', async () => {
    const net = transport([
      () =>
        sse(
          geminiStream([
            { functionCall: { name: 'read_source', args: { path: 'menu.md' } }, thoughtSignature: 'sig-abc' },
          ]),
        ),
    ]);
    const activity: RawToolActivity[] = [];
    const result = await call(net.fetch, { tools: [READ_SOURCE], onToolActivity: (raw) => activity.push(raw) });
    expect(result.outcome).toMatchObject({ kind: 'tool', name: 'read_source', input: { path: 'menu.md' } });
    const callId = (result.outcome as { callId: string }).callId;
    expect(callId).toMatch(/^vtx-[0-9a-f]{12}-1-0$/);
    expect(activity).toEqual([expect.objectContaining({ callId, phase: 'started', tool: 'read_source', summary: 'Reading menu.md' })]);
    expect(net.sent[0].body.tools).toEqual([
      { functionDeclarations: [expect.objectContaining({ name: 'read_source', description: 'Read one attached source.' })] },
    ]);
    // The thought signature Gemini 3 needs back is kept in the private continuation.
    expect(JSON.stringify(result.responseMessages)).toContain('sig-abc');
  });

  test('a provider-issued function call id is the call id', async () => {
    const net = transport([
      () => sse(geminiStream([{ functionCall: { id: 'fc-google-7', name: 'read_source', args: { path: 'a.md' } } }])),
    ]);
    const result = await call(net.fetch, { tools: [READ_SOURCE] });
    expect(result.outcome).toMatchObject({ kind: 'tool', callId: 'fc-google-7' });
  });

  test('the recorded tool result goes back under the same call id, with the thought signature', async () => {
    const first = transport([
      () => sse(geminiStream([{ functionCall: { name: 'read_source', args: { path: 'menu.md' } }, thoughtSignature: 'sig-abc' }])),
    ]);
    const asked = await call(first.fetch, { tools: [READ_SOURCE] });
    const callId = (asked.outcome as { callId: string }).callId;
    const messages: ModelMessage[] = [
      { role: 'user', content: 'What is on the menu?' },
      ...asked.responseMessages,
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: callId, toolName: 'read_source', output: { type: 'json', value: { text: 'Soup.' } } }],
      },
    ];
    const second = transport([() => sse(geminiStream([{ text: 'Soup today.' }]))]);
    const warnings: unknown[] = [];
    const result = await call(second.fetch, {
      messages,
      tools: [READ_SOURCE],
      attempt: exposureAttempt(`run-${run}`, 'model@2', messages),
    });
    expect(result.outcome).toEqual({ kind: 'final', text: 'Soup today.' });
    const contents = second.sent[0].body.contents as Item[];
    const modelTurn = contents.find((entry) => entry.role === 'model') as Item;
    expect(JSON.stringify(modelTurn)).toContain('sig-abc');
    expect(JSON.stringify(modelTurn)).not.toContain('skip_thought_signature_validator');
    const answer = contents[contents.length - 1] as { parts: Item[] };
    // Gemini issued no id, so the answer is matched by name, as Vertex expects; a local id is never invented upstream.
    expect(answer.parts[0]).toMatchObject({ functionResponse: { name: 'read_source', response: expect.anything() } });
    expect((answer.parts[0].functionResponse as Item).id).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test('tool-looking prose is text: nothing is run', async () => {
    const prose = 'Calling read_source({"path":"secrets.env"}) now. <tool_call>{"name":"read_source"}</tool_call>';
    const net = transport([() => sse(geminiStream([{ text: prose }]))]);
    const activity: RawToolActivity[] = [];
    const result = await call(net.fetch, { tools: [READ_SOURCE], onToolActivity: (raw) => activity.push(raw) });
    expect(result.outcome).toEqual({ kind: 'final', text: prose });
    expect(activity).toEqual([]);
  });

  test('two function calls at once are refused, and each is reported not run', async () => {
    const net = transport([
      () =>
        sse(
          geminiStream([
            { functionCall: { name: 'read_source', args: { path: 'a.md' } } },
            { functionCall: { name: 'read_source', args: { path: 'b.md' } } },
          ]),
        ),
    ]);
    const activity: RawToolActivity[] = [];
    const error = await failure(call(net.fetch, { tools: [READ_SOURCE], onToolActivity: (raw) => activity.push(raw) }));
    expect(error.code).toBe('vertex_multiple_tools');
    expect(activity.filter((entry) => entry.phase === 'failed')).toHaveLength(2);
    expect(holds()[0].state).toBe('settled');
  });

  test('a function this turn did not offer is refused', async () => {
    const net = transport([() => sse(geminiStream([{ functionCall: { name: 'write_file', args: { path: 'x' } } }]))]);
    const error = await failure(call(net.fetch, { tools: [READ_SOURCE] }));
    expect(error.code).toBe('vertex_invalid_tool');
  });
});

describe('refusals before anything is sent', () => {
  test('a price that is no longer in force refuses; an expired introductory price is never carried forward', async () => {
    const net = transport([]);
    const error = await failure(call(net.fetch, { now: () => new Date('2027-01-02T00:00:00.000Z') }));
    expect(error.code).toBe('vertex_rate_card_expired');
    expect(error.dispatched).toBe(false);
    expect(net.sent).toHaveLength(0);
    expect(vertexRateCard(new Date('2027-01-02T00:00:00.000Z')).short).toMatchObject({ input: 1_500_000, output: 7_500_000, cacheRead: 150_000 });
    expect(() => vertexRateCard(new Date('2027-03-01T00:00:00.000Z'))).toThrow(/needs re-checking/);
    expect(() => vertexRateCard(new Date('2026-01-01T00:00:00.000Z'))).toThrow(/No Gemini 3.8 Flash price/);
    expect(VERTEX_RATE_CARDS[0].until).toBe('2027-01-01T00:00:00.000Z');
  });

  test('a server-side Google tool is refused before it leaves', async () => {
    const searchTool = { ...READ_SOURCE, name: 'google_search' };
    const net = transport([]);
    // A descriptor is always a function declaration; a request carrying anything else is refused by the body check.
    const { inspectVertexBody } = await import('../server/engines/google-vertex.js');
    expect(() => inspectVertexBody(JSON.stringify({ contents: [], tools: [{ googleSearch: {} }] }))).toThrow(/Google would run itself/);
    expect(() => inspectVertexBody(JSON.stringify({ contents: [], cachedContent: 'projects/x/cachedContents/1' }))).toThrow(/explicit cache/);
    expect(() =>
      inspectVertexBody(JSON.stringify({ contents: [], generationConfig: { thinkingConfig: { includeThoughts: true } } })),
    ).toThrow(/visible thinking/);
    const result = await call(transport([() => sse(geminiStream([{ text: 'ok' }]))]).fetch, { tools: [searchTool] });
    expect(result.outcome.kind).toBe('final');
    expect(net.sent).toHaveLength(0);
  });

  test('a different project, a partner model or the Gemini API host is refused with nothing sent', async () => {
    const { vertexBinding } = await import('../server/engines/google-vertex.js');
    const { guardedStreamFetch } = await import('../server/engines/model-api-core.js');
    const binding = vertexBinding(CONNECTION, 'low', 'vtx-test-1');
    const net = transport([]);
    const guarded = guardedStreamFetch({
      prefix: 'vertex',
      label: 'Google Vertex AI',
      ...binding.guard,
      secret: TOKEN,
      maxRequestBytes: 10_000,
      maxResponseBytes: 10_000,
      signal: new AbortController().signal,
      transport: net.fetch,
      onDispatch: () => {
        throw new Error('dispatched');
      },
      onEnvelope: () => undefined,
    });
    for (const url of [
      STREAM_URL.replace(PROJECT, 'someone-else-project'),
      STREAM_URL.replace('publishers/google/models/gemini-3.8-flash', 'publishers/anthropic/models/claude-opus-5'),
      STREAM_URL.replace('gemini-3.8-flash', 'gemini-3.8-pro'),
      STREAM_URL.replace('?alt=sse', ''),
      `${STREAM_URL}&key=x`,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
      STREAM_URL.replace('aiplatform.googleapis.com', 'us-central1-aiplatform.googleapis.com'),
    ]) {
      const error = await guarded(url, { method: 'POST', body: '{"contents":[]}' }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelApiError);
      expect((error as ModelApiError).code).toBe('vertex_destination_refused');
    }
    expect(net.sent).toHaveLength(0);
  });

  test('a missing ADC file refuses before any network I/O, token exchange included', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-no-adc-'));
    const env = { GOOGLE_APPLICATION_CREDENTIALS: path.join(empty, 'absent.json') };
    const error = await failure(mintVertexToken(CONNECTION, env));
    expect(error.code).toBe('vertex_credential_missing');
    expect(error.dispatched).toBe(false);
    await fs.rm(empty, { recursive: true, force: true });
  });

  test('a different ADC identity is a different credential: refused until verified again', async () => {
    const adcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-adc-'));
    const file = path.join(adcDir, 'adc.json');
    await fs.writeFile(
      file,
      JSON.stringify({ type: 'authorized_user', client_id: 'cid', client_secret: 'secret-never-read', refresh_token: 'rt-never-read', quota_project_id: 'other-billing-project' }),
    );
    const env = { GOOGLE_APPLICATION_CREDENTIALS: file };
    const identity = await readAdcIdentity(env);
    expect(identity).toMatchObject({ source: 'gcloud-user', quotaProject: 'other-billing-project', namedBy: 'GOOGLE_APPLICATION_CREDENTIALS' });
    expect(JSON.stringify(identity)).not.toContain('never-read');
    const error = await failure(mintVertexToken(CONNECTION, env));
    expect(error.code).toBe('vertex_credential_changed');
    await fs.rm(adcDir, { recursive: true, force: true });
  });
});

describe('what is never a finished answer', () => {
  test.each([
    ['SAFETY', 'vertex_refused'],
    ['PROHIBITED_CONTENT', 'vertex_refused'],
    ['RECITATION', 'vertex_refused'],
    ['MAX_TOKENS', 'vertex_incomplete_output'],
    ['MALFORMED_FUNCTION_CALL', 'vertex_unexpected_output'],
    ['OTHER', 'vertex_not_completed'],
  ])('finish reason %s is %s, and its reported usage is settled', async (finish, code) => {
    const net = transport([() => sse(geminiStream([{ text: 'partial answer' }], { finish }))]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe(code);
    expect(error.dispatched).toBe(true);
    expect(holds()[0].state).toBe('settled');
  });

  test('a blocked prompt is a refusal, not an answer', async () => {
    const blocked = [{ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 12, totalTokenCount: 12 }, modelVersion: 'gemini-3.8-flash' }];
    const error = await failure(call(transport([() => sse(blocked)]).fetch));
    expect(error.code).toBe('vertex_refused');
  });

  test('a stream with no finish reason is not completed; with no usage its cost stays uncertain', async () => {
    const error = await failure(call(transport([() => sse(geminiStream([{ text: 'cut off' }], { finish: null, usage: null }))]).fetch));
    expect(['vertex_not_completed', 'vertex_invalid_output']).toContain(error.code);
    expect(holds()[0].state).toBe('uncertain');
  });

  test('a completed answer without usage is held uncertain, never zero', async () => {
    const error = await failure(call(transport([() => sse(geminiStream([{ text: 'Soup.' }], { usage: null }))]).fetch));
    expect(error.code).toBe('vertex_usage_missing');
    expect(holds()[0].state).toBe('uncertain');
    expect(holds()[0].settledMicroUsd).toBeNull();
  });

  test('malformed bytes are unreadable, and nothing from them is used', async () => {
    const broken = new Response('data: {"candidates":[{"content":\n\ndata: not json\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const error = await failure(call(transport([() => broken]).fetch));
    expect(['vertex_unreadable_response', 'vertex_invalid_output']).toContain(error.code);
    expect(holds()[0].state).toBe('uncertain');
  });

  test('a code-execution part or an inline file is unexpected output', async () => {
    const net = transport([() => sse(geminiStream([{ executableCode: { language: 'PYTHON', code: 'print(1)' } }]))]);
    const error = await failure(call(net.fetch));
    expect(['vertex_unexpected_output', 'vertex_invalid_output']).toContain(error.code);
  });

  test('a different model reported back is refused', async () => {
    const net = transport([() => sse(geminiStream([{ text: 'hello' }], { model: 'gemini-3.1-pro' }))]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('vertex_model_mismatch');
  });

  test('usage whose total does not add up is not priced', () => {
    expect(vertexUsage({ ...USAGE, totalTokenCount: 5 })).toBeNull();
    expect(vertexUsage({ ...USAGE, cachedContentTokenCount: 5_000 })).toBeNull();
    expect(vertexUsage({ candidatesTokenCount: 3 })).toBeNull();
  });
});

describe('provider failures', () => {
  test.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
    [429, 'RESOURCE_EXHAUSTED'],
  ])('HTTP %s is a refusal that releases the hold, sends once, and never moves payer', async (status, code) => {
    const net = transport([() => jsonError(status, code, `Vertex said ${code}`)]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('vertex_provider_refused');
    expect(error.dispatched).toBe(true);
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0].url).toBe(STREAM_URL);
    expect(holds()[0].state).toBe('released');
    if (status === 429) expect(error.message).not.toMatch(/credit|balance|exhausted your/i);
  });

  test('HTTP 503 is one provider error: never replayed', async () => {
    const net = transport([() => jsonError(503, 'UNAVAILABLE', 'overloaded'), () => sse(geminiStream([{ text: 'late' }]))]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('vertex_provider_error');
    expect(net.sent).toHaveLength(1);
  });

  test('a timeout after sending is uncertain and never replayed', async () => {
    const sent: string[] = [];
    // Never answers; like the real fetch, it gives up when its signal aborts.
    const hang = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(input));
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
      );
    }) as typeof globalThis.fetch;
    const net = { sent };
    const error = await failure(call(hang, { limits: { ...CONVERSATION_LIMITS, callWallMs: 50 } }));
    expect(error.code).toBe('vertex_timeout');
    expect(error.dispatched).toBe(true);
    expect(net.sent).toHaveLength(1);
    expect(holds()[0].state).toBe('uncertain');
  });

  test('Stop after sending is observable and leaves the spend uncertain, not refunded', async () => {
    const controller = new AbortController();
    const net = transport([
      () =>
        new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason));
          setTimeout(() => controller.abort(), 10);
        }),
    ]);
    const error = await failure(call(net.fetch, { signal: controller.signal }));
    expect(error.code).toBe('vertex_cancelled');
    expect(error.message).toMatch(/may still have processed it/);
    expect(holds()[0].state).toBe('uncertain');
  });
});
