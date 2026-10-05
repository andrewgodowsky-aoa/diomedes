/**
 * The OpenRouter model-API route below the harness: the real `ai` and
 * `@openrouter/ai-sdk-provider` packages build and parse every request, and
 * only the network is replaced by a captured transport. Nothing here reaches
 * OpenRouter, and no real key exists.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { RawToolActivity } from '../shared/adapter-contract.js';
import type { ModelRequest, ToolDescriptor } from '../shared/harness.js';
import { micro } from '../shared/managed-usage.js';
import { exposureAttempt } from '../server/engines/aws-bedrock.js';
import { CONVERSATION_LIMITS, guardedStreamFetch, ModelApiError } from '../server/engines/model-api-core.js';
import {
  OPENROUTER_BASE_URL,
  openRouterBinding,
  openRouterConnectionSchema,
  openRouterRateCard,
  respondOpenRouter,
  type OpenRouterConnection,
} from '../server/engines/openrouter.js';
import { SpendExposure, usageCost } from '../server/spend-exposure.js';
import { FileModelTranscripts } from '../server/harness/model-transcripts.js';
import { createOpenRouterModelAdapter } from '../server/harness/openrouter-model-adapter.js';
import { chatEvents, sseResponse } from './fixtures/model-api-streams.js';

const SECRET = 'sk-or-test-only-0123456789abcdef';
const RATES = {
  input: 3_000_000,
  output: 15_000_000,
  cacheRead: null,
  cacheWrite: null,
  source: 'OpenRouter model page, read by the test owner',
  declaredAt: '2026-09-22T08:00:00.000Z',
};
const MODEL = 'anthropic/claude-sonnet-4.5';
const CONNECTION: OpenRouterConnection = {
  v: 1,
  id: 'openrouter-1',
  baseUrl: OPENROUTER_BASE_URL,
  models: [
    { id: MODEL, upstreams: ['anthropic', 'amazon-bedrock'], rates: RATES },
    { id: 'openai/gpt-5-mini', upstreams: ['openai'], rates: { ...RATES, input: 250_000, output: 2_000_000 } },
  ],
  dataCollection: 'deny',
  allowFallbacks: false,
  credential: { kind: 'openrouter-api-key', fingerprint: 'abcdef123456', savedAt: '2026-09-22T08:00:00.000Z', expiresAt: null },
  revision: 2,
  createdAt: '2026-09-22T08:00:00.000Z',
  updatedAt: '2026-09-22T08:00:00.000Z',
};
const SOL_MODEL = 'openai/gpt-6.1-sol';
const SOL_CONNECTION: OpenRouterConnection = {
  ...CONNECTION,
  models: [{ id: SOL_MODEL, upstreams: ['openai'], rates: RATES, zdr: true,
    reasoning: { supported: ['low', 'medium', 'high'], source: 'Synthetic SDK fixture declaration; not live qualification' } }],
};
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
const USAGE = {
  prompt_tokens: 800,
  completion_tokens: 120,
  total_tokens: 920,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
  cost: 0.0042,
  is_byok: false,
};

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}
function transport(script: Array<() => Response>) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    const next = script.shift();
    if (!next) throw new Error('No scripted response left.');
    return next();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const answer = (overrides: Partial<Parameters<typeof chatEvents>[0]> = {}) =>
  sseResponse(
    chatEvents({ model: MODEL, provider: 'Anthropic', text: 'Soup and a sandwich.', usage: USAGE, ...overrides }),
    { 'x-request-id': 'or-req-1' },
  );

let dir: string;
let exposure: SpendExposure;
let run = 0;
const saved = process.env.OPENROUTER_API_KEY;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-openrouter-transport-'));
  exposure = new SpendExposure(dir);
  await exposure.init();
  await exposure.setCap(CONNECTION.id, micro(1_000_000), { approvedBy: 'test owner', note: 'one dollar' });
  process.env.OPENROUTER_API_KEY = 'ambient-openrouter-key-must-not-be-sent';
  run += 1;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = saved;
  await fs.rm(dir, { recursive: true, force: true });
});

function call(
  fetch: typeof globalThis.fetch,
  overrides: Partial<Parameters<typeof respondOpenRouter>[0]> = {},
) {
  const messages: ModelMessage[] = overrides.messages ?? [{ role: 'user', content: 'What is on the lunch menu?' }];
  const model = overrides.model ?? MODEL;
  const connection = overrides.connection ?? CONNECTION;
  return respondOpenRouter({
    connection,
    model,
    secret: SECRET,
    card: openRouterRateCard(connection, model),
    exposure,
    attempt: exposureAttempt(`run-${run}`, 'model@1', messages),
    instructions: 'You are Diomedes. Answer only from attached sources.',
    messages,
    tools: [],
    limits: CONVERSATION_LIMITS,
    signal: new AbortController().signal,
    transport: fetch,
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

describe('the request the real SDK sends to OpenRouter', () => {
  test('F1: a partial capability rejects higher levels but still serializes its supported low effort', async () => {
    const connection: OpenRouterConnection = { ...SOL_CONNECTION, models: [{ ...SOL_CONNECTION.models[0],
      reasoning: { supported: ['low'], source: 'Synthetic partial capability' } }] };
    const net = transport([() => answer({ model: SOL_MODEL, provider: 'OpenAI' })]);
    for (const effort of ['medium', 'high'] as const)
      await expect(call(net.fetch, { connection, model: SOL_MODEL, effort })).rejects.toMatchObject({ code: 'openrouter_effort_unsupported' });
    expect(net.sent).toHaveLength(0);
    expect(exposure.list(CONNECTION.id)).toHaveLength(0);
    const result = await call(net.fetch, { connection, model: SOL_MODEL, effort: 'low' });
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0].body.reasoning).toEqual({ effort: 'low' });
    expect(result.reservation.state).toBe('settled');
  });
  test('F1: an unknown capability sends no reasoning field on the real SDK wire', async () => {
    const net = transport([() => answer()]);
    const result = await call(net.fetch);
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0].body).not.toHaveProperty('reasoning');
    expect(net.sent[0].body).toMatchObject({ model: MODEL, max_tokens: CONVERSATION_LIMITS.maxOutputTokens,
      provider: { only: ['anthropic', 'amazon-bedrock'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny' } });
    expect(result.reservation.state).toBe('settled');
    expect(exposure.list(CONNECTION.id)).toHaveLength(1);
  });

  test('F1: an unknown capability refuses a direct effort before a spend hold or SDK dispatch', async () => {
    const net = transport([() => answer()]);
    await expect(call(net.fetch, { effort: 'high' })).rejects.toMatchObject({ code: 'openrouter_effort_unsupported' });
    expect(net.sent).toHaveLength(0);
    expect(exposure.list(CONNECTION.id)).toHaveLength(0);
  });

  test('F1: an adapter refuses an unknown capability before preparation can reserve', () => {
    const net = transport([]);
    expect(() => createOpenRouterModelAdapter({
      connection: CONNECTION, model: MODEL, secret: SECRET, card: openRouterRateCard(CONNECTION, MODEL), exposure,
      transcripts: new FileModelTranscripts(path.join(dir, 'transcripts'), 'openrouter'),
      instructions: 'Use only the synthetic menu.', effort: 'high', transport: net.fetch,
    })).toThrow(expect.objectContaining({ code: 'openrouter_effort_unsupported' }));
    expect(net.sent).toHaveLength(0);
    expect(exposure.list(CONNECTION.id)).toHaveLength(0);
  });

  test('the adapter snapshots selected effort so later option mutation cannot change its bound request', async () => {
    const net = transport([() => answer({ model: SOL_MODEL, provider: 'OpenAI' })]);
    const transcripts = new FileModelTranscripts(path.join(dir, 'transcripts'), 'openrouter');
    const options: Parameters<typeof createOpenRouterModelAdapter>[0] = {
      connection: SOL_CONNECTION, model: SOL_MODEL, secret: SECRET,
      card: openRouterRateCard(SOL_CONNECTION, SOL_MODEL), exposure, transcripts,
      instructions: 'Reconcile the synthetic inventory only.', effort: 'medium', transport: net.fetch,
    };
    const adapter = createOpenRouterModelAdapter(options);
    const mediumProfile = adapter.profileHash;
    options.effort = 'high';
    const request: ModelRequest = {
      runId: `snapshot-${run}`, capabilityId: 'inventory-reconciliation',
      messages: [{ role: 'user', text: 'Find the discrepancy.' }], tools: [], transcript: null,
    };
    const prepared = await adapter.prepare!(request, new AbortController().signal);
    const result = await adapter.complete(prepared, new AbortController().signal);
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0].body.reasoning).toEqual({ effort: 'medium' });
    expect(adapter.profileHash).toBe(mediumProfile);
    expect((await transcripts.read(result.transcript!)).profileHash).toBe(mediumProfile);
  });

  test('the selected effort binds the adapter profile and prepared receipt to that exact request', async () => {
    const net = transport([]);
    const adapter = (effort: 'medium' | 'high') => {
      const selection = { effort };
      return createOpenRouterModelAdapter({
        ...selection,
        connection: SOL_CONNECTION,
        model: SOL_MODEL,
        secret: SECRET,
        card: openRouterRateCard(SOL_CONNECTION, SOL_MODEL),
        exposure,
        transcripts: new FileModelTranscripts(path.join(dir, 'transcripts'), 'openrouter'),
        instructions: 'Reconcile the synthetic inventory only.',
        transport: net.fetch,
      });
    };
    const medium = adapter('medium');
    const high = adapter('high');
    expect(medium.profileHash).not.toBe(high.profileHash);
    const request: ModelRequest = {
      runId: `profile-${run}`, capabilityId: 'inventory-reconciliation',
      messages: [{ role: 'user', text: 'Find the discrepancy.' }], tools: [], transcript: null,
    };
    const prepared = await medium.prepare!(request, new AbortController().signal);
    await expect(high.validatePrepared!(prepared)).rejects.toMatchObject({ code: 'openrouter_profile_changed' });
    expect(net.sent).toHaveLength(0);
    expect(exposure.list(CONNECTION.id)).toHaveLength(0);
  });

  test('Sol medium effort reaches the real SDK wire with the bounded output and saved provider restrictions', async () => {
    const net = transport([() => answer({ model: SOL_MODEL, provider: 'OpenAI' })]);
    const effort = { effort: 'medium' as const };
    const result = await call(net.fetch, {
      ...effort,
      connection: SOL_CONNECTION,
      model: SOL_MODEL,
      card: openRouterRateCard(SOL_CONNECTION, SOL_MODEL),
      tools: [READ_SOURCE],
    });

    expect(result.reportedModel).toBe(SOL_MODEL);
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0].body.reasoning).toEqual({ effort: 'medium' });
    expect(net.sent[0].body.max_tokens).toBe(CONVERSATION_LIMITS.maxOutputTokens);
    expect(net.sent[0].body).not.toHaveProperty('max_completion_tokens');
    expect(net.sent[0].body.provider).toEqual({
      only: ['openai'],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
      zdr: true,
    });
    expect(net.sent[0].body.tools).toEqual([
      { type: 'function', function: { name: 'read_source', description: READ_SOURCE.description, parameters: READ_SOURCE.inputSchema } },
    ]);
    expect(result.reservation.state).toBe('settled');
  });

  test('a streamed final answer: one endpoint, the saved key only, the exact preferences, no fallback list', async () => {
    const net = transport([() => answer()]);
    const deltas: string[] = [];
    const result = await call(net.fetch, { onDelta: (text) => deltas.push(text) });

    expect(result.outcome).toEqual({ kind: 'final', text: 'Soup and a sandwich.' });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('Soup and a sandwich.');
    expect(net.sent).toHaveLength(1);
    const [sent] = net.sent;
    expect(sent.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(sent.headers.get('x-provider-api-keys')).toBeNull();
    expect(JSON.stringify({ headers: [...sent.headers], body: sent.body })).not.toContain('ambient');
    expect(sent.body.model).toBe(MODEL);
    expect(sent.body.provider).toEqual({
      only: ['anthropic', 'amazon-bedrock'],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
    });
    expect(sent.body).not.toHaveProperty('models');
    expect(sent.body).not.toHaveProperty('route');
    expect(sent.body).not.toHaveProperty('plugins');
    expect(sent.body.stream).toBe(true);
    expect(sent.body.stream_options).toEqual({ include_usage: true });
    expect(sent.body.usage).toEqual({ include: true });
    expect(sent.body.parallel_tool_calls).toBe(false);
    expect(sent.body.max_tokens).toBe(CONVERSATION_LIMITS.maxOutputTokens);
    expect((sent.body.messages as { role: string }[])[0]).toMatchObject({ role: 'system' });

    const card = openRouterRateCard(CONNECTION, MODEL);
    const expected = usageCost(card, {
      inputTokens: 800,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 120,
      reasoningTokens: 0,
    }).microUsd;
    expect(result.reservation.state).toBe('settled');
    expect(result.reservation.settledMicroUsd).toBe(expected);
    expect(result.reservation.providerRequestId).toBe('or-req-1');
    expect(result.reportedModel).toBe(MODEL);
    expect(result.servedBy).toBe('Anthropic');
  });

  test('thinking a model returns streams to the thinking sink, apart from the answer; nothing new is asked for', async () => {
    const net = transport([() => answer({ reasoning: 'Weighing it.' })]);
    const thoughts: string[] = [];
    const deltas: string[] = [];
    const result = await call(net.fetch, {
      onDelta: (text) => deltas.push(text),
      onReasoningDelta: (text) => thoughts.push(text),
    });
    expect(thoughts.join('')).toBe('Weighing it.');
    expect(deltas.join('')).toBe('Soup and a sandwich.');
    expect(result.outcome).toEqual({ kind: 'final', text: 'Soup and a sandwich.' });
    expect(net.sent[0].body).not.toHaveProperty('reasoning');
  });

  test('a tool call streams as started activity; the tool reaches OpenRouter as a function descriptor', async () => {
    const net = transport([
      () => answer({ text: '', toolCalls: [{ id: 'call_or_1', name: 'read_source', arguments: '{"path":"menu.md"}' }] }),
    ]);
    const activity: RawToolActivity[] = [];
    const result = await call(net.fetch, { tools: [READ_SOURCE], onToolActivity: (raw) => activity.push(raw) });
    expect(result.outcome).toEqual({ kind: 'tool', callId: 'call_or_1', name: 'read_source', input: { path: 'menu.md' } });
    expect(activity).toEqual([
      expect.objectContaining({ callId: 'call_or_1', phase: 'started', tool: 'read_source', summary: 'Reading menu.md' }),
    ]);
    expect(net.sent[0].body.tools).toEqual([
      { type: 'function', function: { name: 'read_source', description: READ_SOURCE.description, parameters: READ_SOURCE.inputSchema } },
    ]);
  });
});

describe('no silent fallback, no other payer', () => {
  const cases: Array<[string, Partial<Parameters<typeof chatEvents>[0]>, string]> = [
    ['an endpoint outside the model’s list served it', { provider: 'DeepInfra' }, 'openrouter_endpoint_refused'],
    ['no endpoint was reported', { provider: undefined }, 'openrouter_endpoint_refused'],
    ['another model answered', { model: 'meta-llama/llama-4-maverick' }, 'openrouter_model_changed'],
    ['the call was billed to a provider key (BYOK)', { usage: { ...USAGE, is_byok: true } }, 'openrouter_payer_changed'],
  ];
  test.each(cases)('%s: refused, one request, usage still recorded', async (_label, overrides, code) => {
    const net = transport([() => answer(overrides)]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe(code);
    expect(error.dispatched).toBe(true);
    expect(net.sent).toHaveLength(1);
    expect(exposure.list(CONNECTION.id)[0].state).toBe('settled');
  });

  test('a listed endpoint reported by its display name is accepted', async () => {
    const net = transport([() => answer({ provider: 'Amazon Bedrock' })]);
    const result = await call(net.fetch);
    expect(result.servedBy).toBe('Amazon Bedrock');
  });

  test('no credits (402) is one request, released, never retried and never sent elsewhere', async () => {
    const net = transport([
      () =>
        new Response(JSON.stringify({ error: { code: 402, message: 'Insufficient credits' } }), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('openrouter_provider_refused');
    expect(net.sent).toHaveLength(1);
    expect(exposure.list(CONNECTION.id)[0].state).toBe('released');
  });

  test('an answer cut at the output limit is evidence, not an answer', async () => {
    const net = transport([() => answer({ finishReason: 'length' })]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('openrouter_incomplete_output');
    expect(error.evidence.partialText).toBe('Soup and a sandwich.');
  });

  test('a stream with no usage chunk stays uncertain', async () => {
    const net = transport([() => answer({ usage: null })]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('openrouter_usage_missing');
    expect(exposure.list(CONNECTION.id)[0].state).toBe('uncertain');
  });

  test('two tool calls at once are refused and reported not run', async () => {
    const net = transport([
      () =>
        answer({
          text: '',
          toolCalls: [
            { id: 'c1', name: 'read_source', arguments: '{"path":"a.md"}' },
            { id: 'c2', name: 'read_source', arguments: '{"path":"b.md"}' },
          ],
        }),
    ]);
    const activity: RawToolActivity[] = [];
    const error = await failure(call(net.fetch, { tools: [READ_SOURCE], onToolActivity: (raw) => activity.push(raw) }));
    expect(error.code).toBe('openrouter_multiple_tools');
    expect(activity.filter((entry) => entry.phase === 'failed')).toHaveLength(2);
  });
});

describe('refusals before anything is sent', () => {
  test('a model off the allow-list is refused without a hold', async () => {
    const net = transport([]);
    const error = await failure(
      respondOpenRouter({
        connection: CONNECTION,
        model: 'openai/gpt-5',
        secret: SECRET,
        card: openRouterRateCard(CONNECTION, MODEL),
        exposure,
        attempt: exposureAttempt('r', 's', 'x'),
        instructions: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        limits: CONVERSATION_LIMITS,
        signal: new AbortController().signal,
        transport: net.fetch,
      }),
    );
    expect(error.code).toBe('openrouter_unknown_model');
    expect(net.sent).toHaveLength(0);
    expect(exposure.list(CONNECTION.id)).toHaveLength(0);
  });

  test('the record refuses routers, variants, an open endpoint list, data collection, fallbacks and a free price', () => {
    const entry = CONNECTION.models[0];
    const bad: unknown[] = [
      { ...CONNECTION, models: [{ ...entry, id: 'openrouter/auto' }] },
      { ...CONNECTION, models: [{ ...entry, id: `${MODEL}:free` }] },
      { ...CONNECTION, models: [{ ...entry, id: `${MODEL}:online` }] },
      { ...CONNECTION, models: [{ ...entry, upstreams: [] }] },
      { ...CONNECTION, models: [{ ...entry, rates: { ...RATES, input: 0 } }] },
      { ...CONNECTION, dataCollection: 'allow' },
      { ...CONNECTION, allowFallbacks: true },
      { ...CONNECTION, baseUrl: 'https://openrouter.ai/api/alpha' },
    ];
    for (const value of bad) expect(openRouterConnectionSchema.safeParse(value).success).toBe(false);
  });

  test('the guarded fetch preserves an explicit endpoint ZDR requirement before attaching the key', async () => {
    const net = transport([() => answer()]);
    const entry = { ...CONNECTION.models[0], upstreams: ['anthropic/strict-fixture'], zdr: true };
    const saved = openRouterConnectionSchema.parse({ ...CONNECTION, models: [entry] });
    const binding = openRouterBinding(saved, saved.models[0]);
    let dispatched = 0;
    const guarded = guardedStreamFetch({ prefix: 'openrouter', label: 'OpenRouter', ...binding.guard,
      secret: SECRET, maxRequestBytes: 10_000, maxResponseBytes: 10_000, signal: new AbortController().signal,
      transport: net.fetch, onDispatch: () => { dispatched++; }, onEnvelope: () => undefined });
    const provider = { only: ['anthropic/strict-fixture'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny' };
    const body = { model: MODEL, stream: true, usage: { include: true }, provider: { ...provider, zdr: true } };
    const url = `${OPENROUTER_BASE_URL}/chat/completions`;
    for (const changed of [provider, { ...provider, zdr: false }]) {
      const error = await failure(guarded(url, { method: 'POST', body: JSON.stringify({ ...body, provider: changed }) }));
      expect(error.code).toBe('openrouter_request_refused');
      expect(error.dispatched).toBe(false);
    }
    expect(net.sent).toHaveLength(0); expect(dispatched).toBe(0);
    const response = await guarded(url, { method: 'POST', body: JSON.stringify(body) });
    await response.text();
    expect(net.sent).toHaveLength(1); expect(dispatched).toBe(1);
    expect(net.sent[0].body.provider).toEqual(body.provider);
    expect(net.sent[0].headers.get('authorization')).toBe(`Bearer ${SECRET}`);
  });

  test('the guarded fetch refuses another destination or a widened body before the key is attached', async () => {
    const net = transport([]);
    let dispatched = 0;
    const entry = CONNECTION.models[0];
    const binding = openRouterBinding(CONNECTION, entry);
    const guarded = guardedStreamFetch({
      prefix: 'openrouter',
      label: 'OpenRouter',
      ...binding.guard,
      secret: SECRET,
      maxRequestBytes: 10_000,
      maxResponseBytes: 10_000,
      signal: new AbortController().signal,
      transport: net.fetch,
      onDispatch: () => {
        dispatched += 1;
      },
      onEnvelope: () => undefined,
    });
    const provider = { only: ['anthropic', 'amazon-bedrock'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny' };
    const good = { model: MODEL, stream: true, usage: { include: true }, provider };
    const url = `${OPENROUTER_BASE_URL}/chat/completions`;
    const refusals: Array<[string, unknown, string]> = [
      ['https://openrouter.ai/api/v1/responses', good, 'openrouter_destination_refused'],
      ['https://api.openai.com/v1/chat/completions', good, 'openrouter_destination_refused'],
      [`${url}?debug=1`, good, 'openrouter_destination_refused'],
      [url, { ...good, models: [MODEL, 'openai/gpt-5'] }, 'openrouter_request_refused'],
      [url, { ...good, route: 'fallback' }, 'openrouter_request_refused'],
      [url, { ...good, model: 'openai/gpt-5-mini' }, 'openrouter_request_refused'],
      [url, { ...good, provider: { ...provider, allow_fallbacks: true } }, 'openrouter_request_refused'],
      [url, { ...good, provider: { ...provider, data_collection: 'allow' } }, 'openrouter_request_refused'],
      [url, { ...good, provider: { ...provider, only: ['anthropic', 'deepinfra'] } }, 'openrouter_request_refused'],
      [url, { ...good, provider: { ...provider, sort: 'price' } }, 'openrouter_request_refused'],
      [url, { ...good, plugins: [{ id: 'web' }] }, 'openrouter_request_refused'],
    ];
    for (const [target, body, code] of refusals) {
      const error = await failure(guarded(target, { method: 'POST', body: JSON.stringify(body) }));
      expect(error.code, `${target} ${JSON.stringify(body)}`).toBe(code);
      expect(error.dispatched).toBe(false);
    }
    expect(dispatched).toBe(0);
    expect(net.sent).toHaveLength(0);
  });
});
