/**
 * The Azure OpenAI model-API route below the harness: the real `ai`,
 * `@ai-sdk/azure` and `@ai-sdk/openai` packages build and parse every request,
 * and only the network is replaced by a captured transport. Nothing here
 * reaches Azure, and no real key exists.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { RawToolActivity } from '../shared/adapter-contract.js';
import type { ToolDescriptor } from '../shared/harness.js';
import { micro } from '../shared/managed-usage.js';
import {
  AZURE_OPENAI_ROUTE,
  azureBinding,
  azureConnectionSchema,
  azureEndpoint,
  azureRateCard,
  respondAzure,
  type AzureConnection,
} from '../server/engines/azure-openai.js';
import { CONVERSATION_LIMITS, guardedStreamFetch, ModelApiError } from '../server/engines/model-api-core.js';
import { exposureAttempt } from '../server/engines/aws-bedrock.js';
import { SpendExposure, usageCost } from '../server/spend-exposure.js';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const SECRET = 'test-only-azure-key-0123456789abcdef';
const BASE = azureEndpoint('contoso-ai');
const RATES = {
  input: 1_250_000,
  output: 10_000_000,
  cacheRead: 125_000,
  cacheWrite: null,
  source: 'Azure pricing page, read by the test owner',
  declaredAt: '2026-09-22T08:00:00.000Z',
};
const CONNECTION: AzureConnection = {
  v: 1,
  id: 'azure-openai-1',
  resourceName: 'contoso-ai',
  baseUrl: BASE,
  apiVersion: 'v1',
  deployments: [
    { model: 'gpt-5.6-luna', deployment: 'luna-prod-eastus2', reasoning: true, rates: RATES },
    { model: 'gpt-4.1-mini', deployment: 'mini-chat', reasoning: false, rates: { ...RATES, input: 400_000, output: 1_600_000 } },
  ],
  credential: { kind: 'azure-api-key', fingerprint: 'abcdef123456', savedAt: '2026-09-22T08:00:00.000Z', expiresAt: null },
  revision: 3,
  createdAt: '2026-09-22T08:00:00.000Z',
  updatedAt: '2026-09-22T08:00:00.000Z',
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
  input_tokens: 900,
  input_tokens_details: { cached_tokens: 100 },
  output_tokens: 200,
  output_tokens_details: { reasoning_tokens: 50 },
  total_tokens: 1_100,
};
type Item = Record<string, unknown>;
const message = (text: string): Item => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const functionCall = (callId: string, name: string, args: string): Item => ({
  type: 'function_call',
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: args,
  status: 'completed',
});
const reasoning = (): Item => ({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-azure' });
const envelope = (output: Item[], extra: Item = {}) => ({
  id: 'resp_az_1',
  object: 'response',
  created_at: 1_790_000_000,
  status: 'completed',
  model: 'gpt-5.6-luna-2026-09-01',
  output,
  usage: USAGE,
  incomplete_details: null,
  error: null,
  ...extra,
});

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
const stream = (body: Item) => sseResponse(responsesEvents(body), { 'apim-request-id': 'apim-1' });
const jsonError = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'apim-request-id': 'apim-1' } });

let dir: string;
let exposure: SpendExposure;
let run = 0;
const saved = { key: process.env.AZURE_API_KEY, resource: process.env.AZURE_RESOURCE_NAME, openai: process.env.OPENAI_API_KEY };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-azure-transport-'));
  exposure = new SpendExposure(dir);
  await exposure.init();
  await exposure.setCap(CONNECTION.id, micro(1_000_000), { approvedBy: 'test owner', note: 'one dollar' });
  // Ambient settings must never be read: the route uses only the saved resource and key.
  process.env.AZURE_API_KEY = 'ambient-azure-key-must-not-be-sent';
  process.env.AZURE_RESOURCE_NAME = 'ambient-resource';
  process.env.OPENAI_API_KEY = 'ambient-openai-key-must-not-be-sent';
  run += 1;
});
afterEach(async () => {
  for (const [name, value] of [
    ['AZURE_API_KEY', saved.key],
    ['AZURE_RESOURCE_NAME', saved.resource],
    ['OPENAI_API_KEY', saved.openai],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  await fs.rm(dir, { recursive: true, force: true });
});

function call(
  fetch: typeof globalThis.fetch,
  overrides: Partial<Parameters<typeof respondAzure>[0]> = {},
) {
  const messages: ModelMessage[] = overrides.messages ?? [{ role: 'user', content: 'What is on the lunch menu?' }];
  const model = overrides.model ?? 'gpt-5.6-luna';
  return respondAzure({
    connection: CONNECTION,
    model,
    secret: SECRET,
    card: azureRateCard(CONNECTION, model),
    exposure,
    attempt: exposureAttempt(`run-${run}`, 'model@1', messages),
    instructions: 'You are Diomedes. Answer only from attached sources.',
    messages,
    tools: [],
    effort: 'medium',
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

describe('the request the real SDK sends to Azure', () => {
  test('a streamed final answer: the resource’s v1 endpoint, the deployment as model, api-key only, no retry', async () => {
    const net = transport([() => stream(envelope([reasoning(), message('Soup and a sandwich.')]))]);
    const deltas: string[] = [];
    const result = await call(net.fetch, { onDelta: (text) => deltas.push(text) });

    expect(result.outcome).toEqual({ kind: 'final', text: 'Soup and a sandwich.' });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('Soup and a sandwich.');
    expect(net.sent).toHaveLength(1);
    const [sent] = net.sent;
    expect(sent.url).toBe('https://contoso-ai.openai.azure.com/openai/v1/responses');
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('api-key')).toBe(SECRET);
    expect(sent.headers.get('authorization')).toBeNull();
    const serialized = JSON.stringify({ url: sent.url, headers: [...sent.headers], body: sent.body });
    expect(serialized).not.toContain('ambient');
    expect(sent.body.model).toBe('luna-prod-eastus2');
    expect(sent.body.stream).toBe(true);
    expect(sent.body.store).toBe(false);
    expect(sent.body.include).toEqual(['reasoning.encrypted_content']);
    expect(sent.body.reasoning).toMatchObject({ effort: 'medium' });
    expect(sent.body.parallel_tool_calls).toBe(false);
    expect(sent.body.max_output_tokens).toBe(CONVERSATION_LIMITS.maxOutputTokens);
    expect(sent.body.previous_response_id).toBeUndefined();
    expect((sent.body.input as Item[])[0]).toEqual({
      role: 'developer',
      content: 'You are Diomedes. Answer only from attached sources.',
    });

    const card = azureRateCard(CONNECTION, 'gpt-5.6-luna');
    expect(card.version).toMatch(/^azure-openai:gpt-5\.6-luna@r3:/);
    const expected = usageCost(card, {
      inputTokens: 900,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      outputTokens: 200,
      reasoningTokens: 50,
    }).microUsd;
    expect(result.reservation.state).toBe('settled');
    expect(result.reservation.settledMicroUsd).toBe(expected);
    expect(result.reservation.providerRequestId).toBe('apim-1');
    expect(result.reportedModel).toBe('gpt-5.6-luna-2026-09-01');
  });

  test('a non-reasoning deployment gets a plain system message and no reasoning options', async () => {
    const net = transport([() => stream(envelope([message('Soup.')], { model: 'gpt-4.1-mini' }))]);
    await call(net.fetch, { model: 'gpt-4.1-mini' });
    const body = net.sent[0].body;
    expect(body.model).toBe('mini-chat');
    expect(body.reasoning).toBeUndefined();
    expect(body.include).toBeUndefined();
    expect((body.input as Item[])[0]).toMatchObject({ role: 'system' });
  });

  test('a tool call streams as started activity with a plain summary; the tool reaches Azure as a descriptor', async () => {
    const net = transport([() => stream(envelope([reasoning(), functionCall('call_9', 'read_source', '{"path":"menu.md"}')]))]);
    const activity: RawToolActivity[] = [];
    const result = await call(net.fetch, { tools: [READ_SOURCE], onToolActivity: (raw) => activity.push(raw) });
    expect(result.outcome).toEqual({ kind: 'tool', callId: 'call_9', name: 'read_source', input: { path: 'menu.md' } });
    expect(activity).toEqual([
      expect.objectContaining({ callId: 'call_9', phase: 'started', tool: 'read_source', summary: 'Reading menu.md' }),
    ]);
    expect(net.sent[0].body.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'read_source', parameters: READ_SOURCE.inputSchema }),
    ]);
    expect(net.sent[0].body.tool_choice).toBe('auto');
  });

  test('two tool calls at once: announced, then reported not run, and refused', async () => {
    const net = transport([
      () =>
        stream(
          envelope([
            functionCall('call_1', 'read_source', '{"path":"a.md"}'),
            functionCall('call_2', 'read_source', '{"path":"b.md"}'),
          ]),
        ),
    ]);
    const activity: RawToolActivity[] = [];
    const error = await failure(call(net.fetch, { tools: [READ_SOURCE], onToolActivity: (raw) => activity.push(raw) }));
    expect(error.code).toBe('azure_multiple_tools');
    expect(activity.filter((entry) => entry.phase === 'failed').map((entry) => entry.callId).sort()).toEqual(['call_1', 'call_2']);
    expect(exposure.list(CONNECTION.id)[0].state).toBe('settled');
  });
});

describe('refusals before anything is sent', () => {
  test('a model with no deployment on the connection is refused without a hold', async () => {
    const net = transport([]);
    const error = await failure(
      respondAzure({
        connection: CONNECTION,
        model: 'gpt-9',
        secret: SECRET,
        card: azureRateCard(CONNECTION, 'gpt-5.6-luna'),
        exposure,
        attempt: exposureAttempt('r', 's', 'x'),
        instructions: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        effort: 'low',
        limits: CONVERSATION_LIMITS,
        signal: new AbortController().signal,
        transport: net.fetch,
      }),
    );
    expect(error.code).toBe('azure_unknown_model');
    expect(error.dispatched).toBe(false);
    expect(net.sent).toHaveLength(0);
    expect(exposure.list(CONNECTION.id)).toHaveLength(0);
  });

  test('another model’s price never prices this call', async () => {
    const net = transport([]);
    const error = await failure(call(net.fetch, { card: azureRateCard(CONNECTION, 'gpt-4.1-mini') }));
    expect(error.code).toBe('azure_rate_card_mismatch');
    expect(net.sent).toHaveLength(0);
  });

  test('an unknown or zero price is not free: the connection record refuses it', () => {
    for (const rates of [{ ...RATES, input: 0 }, { ...RATES, output: 0 }, { ...RATES, input: undefined }])
      expect(
        azureConnectionSchema.safeParse({ ...CONNECTION, deployments: [{ ...CONNECTION.deployments[0], rates }] }).success,
      ).toBe(false);
  });

  test('the endpoint is the resource’s own: a record naming another host is not readable', () => {
    for (const baseUrl of [
      'https://api.openai.com/v1',
      'https://contoso-ai.openai.azure.com/openai',
      'https://other.openai.azure.com/openai/v1',
      'https://contoso-ai.cognitiveservices.azure.com/openai/v1',
    ])
      expect(azureConnectionSchema.safeParse({ ...CONNECTION, baseUrl }).success).toBe(false);
    expect(azureConnectionSchema.safeParse({ ...CONNECTION, resourceName: 'Contoso_AI' }).success).toBe(false);
  });

  test('the guarded fetch refuses any other destination, query or body before the key is attached', async () => {
    const net = transport([]);
    let dispatched = 0;
    const binding = azureBinding(CONNECTION, CONNECTION.deployments[0], 'low');
    const guarded = guardedStreamFetch({
      prefix: 'azure',
      label: 'Azure',
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
    const good = { model: 'luna-prod-eastus2', store: false, stream: true };
    const refusals: Array<[string, unknown, string]> = [
      // The legacy deployment path with an api-version query is a different URL.
      [`https://contoso-ai.openai.azure.com/openai/deployments/luna-prod-eastus2/responses?api-version=2025-04-01-preview`, good, 'azure_destination_refused'],
      [`${BASE}/responses?api-version=v1`, good, 'azure_destination_refused'],
      ['https://other.openai.azure.com/openai/v1/responses', good, 'azure_destination_refused'],
      ['https://api.openai.com/v1/responses', good, 'azure_destination_refused'],
      [`${BASE}/responses`, { ...good, model: 'mini-chat' }, 'azure_request_refused'],
      [`${BASE}/responses`, { ...good, store: true }, 'azure_request_refused'],
      [`${BASE}/responses`, { ...good, previous_response_id: 'resp_0' }, 'azure_request_refused'],
    ];
    for (const [url, body, code] of refusals) {
      const error = await failure(guarded(url, { method: 'POST', body: JSON.stringify(body) }));
      expect(error.code).toBe(code);
      expect(error.dispatched).toBe(false);
    }
    expect(dispatched).toBe(0);
    expect(net.sent).toHaveLength(0);
  });
});

describe('what is never a finished answer', () => {
  test('a throttle is one request, released, never retried', async () => {
    const net = transport([() => jsonError({ error: { code: '429', message: 'Rate limit is exceeded.' } }, 429)]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('azure_provider_refused');
    expect(net.sent).toHaveLength(1);
    expect(exposure.list(CONNECTION.id)[0].state).toBe('released');
  });

  test('a server error with no usage is one request and stays uncertain', async () => {
    const net = transport([() => new Response('<html>bad gateway</html>', { status: 502 })]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('azure_unreadable_response');
    expect(net.sent).toHaveLength(1);
    expect(exposure.list(CONNECTION.id)[0].state).toBe('uncertain');
  });

  test('a content-filter stop is a refusal whose usage is still recorded', async () => {
    const net = transport([
      () => stream(envelope([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } })),
    ]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('azure_refused');
    expect(exposure.list(CONNECTION.id)[0].state).toBe('settled');
  });

  test('a stream cut off before its terminal event is not an answer and stays uncertain', async () => {
    const whole = responsesEvents(envelope([message('Soup and a sandwich.')]));
    const cut = whole.slice(0, whole.lastIndexOf('data: {"type":"response.completed"'));
    const net = transport([() => sseResponse(cut)]);
    const deltas: string[] = [];
    const error = await failure(call(net.fetch, { onDelta: (text) => deltas.push(text) }));
    expect(['azure_unreadable_response', 'azure_invalid_output']).toContain(error.code);
    expect(deltas.join('')).toBe('Soup and a sandwich.');
    expect(exposure.list(CONNECTION.id)[0].state).toBe('uncertain');
  });

  test('a provider error that echoes the key never repeats it', async () => {
    const net = transport([() => jsonError({ error: { code: '401', message: `Access denied for key ${SECRET}` } }, 401)]);
    const error = await failure(call(net.fetch));
    expect(error.message).not.toContain(SECRET);
  });
});

test('the route id is the registry’s', () => {
  expect(AZURE_OPENAI_ROUTE).toBe('azure-openai');
});
