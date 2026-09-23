/**
 * The direct AWS Bedrock Responses route, below the harness: the real `ai` and
 * `@ai-sdk/openai` packages build and parse every request, and only the network
 * is replaced. Nothing here reaches AWS.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ToolDescriptor } from '../shared/harness.js';
import { micro } from '../shared/managed-usage.js';
import {
  AWS_LUNA_MODEL,
  AWS_LUNA_RATE_CARD,
  AWS_RESPONSES_ENDPOINTS,
  CONVERSATION_LIMITS,
  classifyEnvelope,
  exposureAttempt,
  guardedResponsesFetch,
  ModelApiError,
  respondOnce,
  type AwsConnection,
} from '../server/engines/aws-bedrock.js';
import { SpendExposure, usageCost } from '../server/spend-exposure.js';
import { responsesAnswer } from './fixtures/model-api-streams.js';

const BASE = AWS_RESPONSES_ENDPOINTS['us-east-1'];
const SECRET = 'test-only-bedrock-key-0123456789abcdef';
const CONNECTION: AwsConnection = {
  v: 1,
  id: 'aws-bedrock-1',
  accountId: '123456789012',
  region: 'us-east-1',
  baseUrl: BASE,
  modelId: AWS_LUNA_MODEL,
  processing: 'us-geo',
  credential: {
    kind: 'bedrock-api-key',
    fingerprint: 'abcdef123456',
    savedAt: '2026-09-21T08:00:00.000Z',
    expiresAt: null,
  },
  revision: 1,
  createdAt: '2026-09-21T08:00:00.000Z',
  updatedAt: '2026-09-21T08:00:00.000Z',
};
const READ_SOURCE: ToolDescriptor = {
  name: 'read_source',
  version: '1',
  description: 'Read one admitted source.',
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
  input_tokens: 1_200,
  input_tokens_details: { cached_tokens: 200 },
  output_tokens: 300,
  output_tokens_details: { reasoning_tokens: 120 },
  total_tokens: 1_500,
};

type Item = Record<string, unknown>;
const reasoning = (id = 'rs_1', encrypted = 'enc-1'): Item => ({
  type: 'reasoning',
  id,
  summary: [],
  encrypted_content: encrypted,
});
const message = (text: string): Item => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const functionCall = (callId: string, name: string, args: string, extra: Item = {}): Item => ({
  type: 'function_call',
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: args,
  status: 'completed',
  ...extra,
});
const envelope = (output: Item[], extra: Item = {}) => ({
  id: 'resp_1',
  object: 'response',
  created_at: 1_790_000_000,
  status: 'completed',
  model: AWS_LUNA_MODEL,
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

/** A network stand-in: records each request and answers from a script. */
function transport(script: Array<(sent: Sent, signal: AbortSignal | undefined) => Promise<Response> | Response>) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Sent = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    };
    sent.push(request);
    const next = script.shift();
    if (!next) throw new Error('No scripted response left.');
    return next(request, init?.signal ?? undefined);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
/** A Responses object answers as its event stream (the request asks for `stream: true`); an error body stays JSON. */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  responsesAnswer(body, status, { 'x-amzn-requestid': 'req-aws-1', ...headers });

let dir: string;
let exposure: SpendExposure;
let run = 0;
const envKey = process.env.OPENAI_API_KEY;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-aws-transport-'));
  exposure = new SpendExposure(dir);
  await exposure.init();
  await exposure.setCap(CONNECTION.id, micro(1_000_000), { approvedBy: 'test owner', note: 'one dollar' });
  // Any ambient key must be ignored: the route only ever sends the saved credential.
  process.env.OPENAI_API_KEY = 'ambient-env-key-must-not-be-sent';
  run += 1;
});
afterEach(async () => {
  if (envKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = envKey;
  await fs.rm(dir, { recursive: true, force: true });
});

function call(
  fetch: typeof globalThis.fetch,
  overrides: Partial<Parameters<typeof respondOnce>[0]> = {},
) {
  const messages: ModelMessage[] = overrides.messages ?? [
    { role: 'user', content: 'How many napkins were short on the last delivery?' },
  ];
  return respondOnce({
    connection: CONNECTION,
    secret: SECRET,
    card: AWS_LUNA_RATE_CARD,
    exposure,
    attempt: exposureAttempt(`run-${run}`, 'model@1', messages),
    instructions: 'You are Diomedes. Answer only from admitted sources.',
    messages,
    tools: [],
    effort: 'low',
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

describe('the request the real SDK sends', () => {
  test('a final answer: exact endpoint, saved credential only, store:false, developer role, no fallback fields', async () => {
    const net = transport([() => json(envelope([reasoning(), message('Six napkins were short.')]))]);
    const result = await call(net.fetch);

    expect(result.outcome).toEqual({ kind: 'final', text: 'Six napkins were short.' });
    expect(net.sent).toHaveLength(1);
    const [sent] = net.sent;
    expect(sent.url).toBe(`${BASE}/responses`);
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(sent.headers.get('openai-organization')).toBeNull();
    expect(sent.headers.get('openai-project')).toBeNull();
    expect(JSON.stringify(sent)).not.toContain('ambient-env-key-must-not-be-sent');
    expect(sent.body.model).toBe(AWS_LUNA_MODEL);
    expect(sent.body.store).toBe(false);
    expect(sent.body.include).toEqual(['reasoning.encrypted_content']);
    expect(sent.body.reasoning).toMatchObject({ effort: 'low' });
    expect((sent.body.reasoning as Record<string, unknown>).summary).toBeUndefined();
    expect(sent.body.max_output_tokens).toBe(CONVERSATION_LIMITS.maxOutputTokens);
    expect(sent.body.parallel_tool_calls).toBe(false);
    expect(sent.body.previous_response_id).toBeUndefined();
    expect(sent.body.stream).toBe(true);
    expect(sent.body.background).toBeUndefined();
    const input = sent.body.input as Item[];
    expect(input[0]).toEqual({ role: 'developer', content: 'You are Diomedes. Answer only from admitted sources.' });
    expect(input[1]).toMatchObject({ role: 'user' });

    // Settled from the provider's own usage, at list price.
    const expected = usageCost(AWS_LUNA_RATE_CARD, {
      inputTokens: 1_200,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 300,
      reasoningTokens: 120,
    }).microUsd;
    expect(result.reservation.state).toBe('settled');
    expect(result.reservation.settledMicroUsd).toBe(expected);
    expect(result.reservation.providerRequestId).toBe('req-aws-1');
    expect(result.reservation.maxMicroUsd).toBeGreaterThan(expected);
    expect(result.reportedModel).toBe(AWS_LUNA_MODEL);
    expect(result.responseId).toBe('resp_1');
  });

  test('one offered tool call maps the provider call id; the continuation re-sends encrypted reasoning and the matching output', async () => {
    const net = transport([
      () => json(envelope([reasoning('rs_1', 'enc-first'), functionCall('call_1', 'read_source', '{"path":"delivery.txt"}')])),
      () => json(envelope([reasoning('rs_2', 'enc-second'), message('Six were short, per delivery.txt.')], { id: 'resp_2' })),
    ]);
    const first = await call(net.fetch, { tools: [READ_SOURCE] });
    expect(first.outcome).toEqual({
      kind: 'tool',
      callId: 'call_1',
      name: 'read_source',
      input: { path: 'delivery.txt' },
    });
    const offered = net.sent[0].body;
    expect(offered.tool_choice).toBe('auto');
    expect(offered.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'read_source', parameters: READ_SOURCE.inputSchema }),
    ]);

    const messages: ModelMessage[] = [
      { role: 'user', content: 'How many napkins were short on the last delivery?' },
      ...first.responseMessages,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: first.outcome.kind === 'tool' ? first.outcome.callId : '',
            toolName: 'read_source',
            output: { type: 'json', value: { found: true, path: 'delivery.txt', text: 'Napkins: 94 of 100' } },
          },
        ],
      },
    ];
    const second = await call(net.fetch, {
      tools: [READ_SOURCE],
      messages,
      attempt: exposureAttempt(`run-${run}`, 'model@2', messages),
    });
    expect(second.outcome).toEqual({ kind: 'final', text: 'Six were short, per delivery.txt.' });

    const input = net.sent[1].body.input as Item[];
    expect(net.sent[1].body.previous_response_id).toBeUndefined();
    expect(input).toContainEqual(expect.objectContaining({ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-first' }));
    expect(input).toContainEqual(
      expect.objectContaining({ type: 'function_call', call_id: 'call_1', name: 'read_source' }),
    );
    const output = input.find((item) => item.type === 'function_call_output');
    expect(output).toMatchObject({ call_id: 'call_1' });
    expect(JSON.parse(String(output?.output))).toMatchObject({ path: 'delivery.txt' });
    expect(input.some((item) => item.type === 'item_reference')).toBe(false);
    expect(exposure.list(CONNECTION.id).map((hold) => hold.state)).toEqual(['settled', 'settled']);
  });
});

describe('what is never a finished answer', () => {
  const cases: Array<[string, () => Response, string, 'settled' | 'uncertain' | 'released']> = [
    [
      'two tool calls at once',
      () =>
        json(
          envelope([
            functionCall('call_1', 'read_source', '{"path":"a.txt"}'),
            functionCall('call_2', 'read_source', '{"path":"b.txt"}'),
          ]),
        ),
      'aws_multiple_tools',
      'settled',
    ],
    [
      'a truncated answer',
      () =>
        json(
          envelope([message('Six napk')], {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
          }),
        ),
      'aws_incomplete_output',
      'settled',
    ],
    [
      'a content-filter stop',
      () => json(envelope([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } })),
      'aws_refused',
      'settled',
    ],
    [
      'a refusal part',
      () =>
        json(
          envelope([
            {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
            },
          ]),
        ),
      'aws_refused',
      'settled',
    ],
    [
      'a provider-hosted tool item',
      () =>
        json(
          envelope([
            { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'linen' } },
            message('Found it online.'),
          ]),
        ),
      'aws_unexpected_output',
      'settled',
    ],
    [
      'a program-driven function call',
      () =>
        json(
          envelope([
            functionCall('call_1', 'read_source', '{"path":"a.txt"}', { caller: { type: 'program', caller_id: 'p1' } }),
          ]),
        ),
      'aws_unexpected_output',
      'settled',
    ],
    [
      'a tool this call did not offer',
      () => json(envelope([functionCall('call_1', 'write_file', '{"path":"a.txt"}')])),
      'aws_invalid_tool',
      'settled',
    ],
    [
      'malformed tool arguments',
      () => json(envelope([functionCall('call_1', 'read_source', '{"path":')])),
      'aws_invalid_tool',
      'settled',
    ],
    ['an empty answer', () => json(envelope([reasoning()])), 'aws_empty_output', 'settled'],
    [
      'a completed answer with no usage',
      () => json({ ...envelope([message('Six.')]), usage: null }),
      'aws_usage_missing',
      'uncertain',
    ],
    [
      'usage whose parts exceed the total',
      () =>
        json({
          ...envelope([message('Six.')]),
          usage: { ...USAGE, input_tokens_details: { cached_tokens: 5_000 } },
        }),
      'aws_usage_missing',
      'uncertain',
    ],
    [
      'a throttle with an error body',
      () =>
        json({ error: { message: 'Too many requests', type: 'throttling', code: 'throttled' } }, 429),
      'aws_provider_refused',
      'released',
    ],
    [
      'a server error with an unreadable body',
      () => new Response('<html>bad gateway</html>', { status: 502 }),
      'aws_unreadable_response',
      'uncertain',
    ],
  ];

  test.each(cases)('%s', async (_label, respond, code, state) => {
    const net = transport([() => respond()]);
    const error = await failure(call(net.fetch, { tools: [READ_SOURCE] }));
    expect(error.code).toBe(code);
    expect(error.dispatched).toBe(true);
    expect(net.sent).toHaveLength(1);
    const [hold] = exposure.list(CONNECTION.id);
    expect(hold.state).toBe(state);
    expect(error.evidence.reservation?.state).toBe(state);
    if (state === 'uncertain') expect(hold.settledMicroUsd).toBeNull();
  });

  test('a truncated answer keeps its partial text as evidence, not as an answer', async () => {
    const net = transport([
      () =>
        json(envelope([message('Six napk')], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })),
    ]);
    const error = await failure(call(net.fetch));
    expect(error.evidence.partialText).toBe('Six napk');
  });

  test('a provider error that echoes the key never repeats it', async () => {
    const net = transport([
      () => json({ error: { message: `Invalid key ${SECRET}`, type: 'auth', code: 'invalid_api_key' } }, 403),
    ]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('aws_provider_refused');
    expect(error.message).not.toContain(SECRET);
    expect(exposure.list(CONNECTION.id)[0].state).toBe('released');
  });
});

describe('transport guards and uncertain outcomes', () => {
  test('a redirect is refused and the sent call stays uncertain', async () => {
    const net = transport([() => new Response(null, { status: 307, headers: { location: 'https://example.com/v1/responses' } })]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('aws_redirect_refused');
    expect(error.dispatched).toBe(true);
    expect(exposure.list(CONNECTION.id)[0].state).toBe('uncertain');
  });

  test('an oversized response is cut off and stays uncertain', async () => {
    const net = transport([() => new Response('x'.repeat(4_096), { status: 200 })]);
    const error = await failure(
      call(net.fetch, { limits: { ...CONVERSATION_LIMITS, maxResponseBytes: 1_024 } }),
    );
    expect(error.code).toBe('aws_output_too_large');
    expect(exposure.list(CONNECTION.id)[0].state).toBe('uncertain');
  });

  test('stopping after dispatch leaves the hold uncertain, never released', async () => {
    const controller = new AbortController();
    const net = transport([
      (_sent, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          controller.abort(new Error('person pressed Stop'));
        }),
    ]);
    const error = await failure(call(net.fetch, { signal: controller.signal }));
    expect(error.code).toBe('aws_cancelled');
    expect(error.dispatched).toBe(true);
    expect(exposure.list(CONNECTION.id)[0].state).toBe('uncertain');
    expect(exposure.summary(CONNECTION.id).uncertainMicroUsd).toBeGreaterThan(0);
  });

  test('the per-call wall clock times out a silent provider', async () => {
    const net = transport([
      (_sent, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    ]);
    const error = await failure(call(net.fetch, { limits: { ...CONVERSATION_LIMITS, callWallMs: 50 } }));
    expect(error.code).toBe('aws_timeout');
    expect(exposure.list(CONNECTION.id)[0].state).toBe('uncertain');
  });

  test('a stop that lands as the response arrives cancels the body read instead of waiting on it', async () => {
    const controller = new AbortController();
    let cancelled = 0;
    let dispatched = 0;
    let delivered = 0;
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const guarded = guardedResponsesFetch({
      baseUrl: BASE,
      secret: SECRET,
      maxRequestBytes: 10_000,
      maxResponseBytes: 10_000,
      signal: controller.signal,
      onDispatch: () => {
        dispatched += 1;
      },
      onEnvelope: () => {
        delivered += 1;
      },
      // The transport ignores the signal: the stop lands after dispatch, just before the body.
      transport: (async () => {
        controller.abort(new Error('stopped at response headers'));
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              body = stream;
            },
            cancel() {
              cancelled += 1;
            },
          }),
        );
      }) as typeof globalThis.fetch,
    });
    const outcome = guarded(`${BASE}/responses`, { method: 'POST', body: '{}', signal: controller.signal }).then(
      () => 'resolved',
      () => 'rejected',
    );
    const settled = await Promise.race([
      outcome,
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 250)),
    ]);
    if (settled === 'pending') body?.close();
    expect(settled).toBe('rejected');
    expect(dispatched).toBe(1);
    expect(cancelled).toBe(1);
    expect(delivered).toBe(0);
  });

  test('the guarded fetch refuses any other destination, method or query before sending', async () => {
    const net = transport([]);
    let dispatched = 0;
    const guarded = guardedResponsesFetch({
      baseUrl: BASE,
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
    const refusals: Array<[string, RequestInit, string]> = [
      ['https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses', { method: 'POST', body: '{}' }, 'aws_destination_refused'],
      [`${BASE}/responses?debug=1`, { method: 'POST', body: '{}' }, 'aws_destination_refused'],
      [`${BASE}/models`, { method: 'GET' }, 'aws_destination_refused'],
      ['https://api.openai.com/v1/responses', { method: 'POST', body: '{}' }, 'aws_destination_refused'],
      [`${BASE}/responses`, { method: 'GET' }, 'aws_request_refused'],
      [`${BASE}/responses`, { method: 'POST', body: 'x'.repeat(10_001) }, 'aws_input_too_large'],
    ];
    for (const [url, init, code] of refusals) {
      const error = await failure(guarded(url, init));
      expect(error.code).toBe(code);
      expect(error.dispatched).toBe(false);
    }
    expect(dispatched).toBe(0);
    expect(net.sent).toHaveLength(0);
  });
});

describe('admission before anything is sent', () => {
  test('a cap too small for the ceiling refuses without a hold or a request', async () => {
    await exposure.setCap(CONNECTION.id, micro(1), { approvedBy: 'test owner', note: 'one micro-dollar' });
    const net = transport([]);
    const error = await failure(call(net.fetch));
    expect(error.code).toBe('aws_spend_refused');
    expect(error.dispatched).toBe(false);
    expect(net.sent).toHaveLength(0);
    expect(exposure.list(CONNECTION.id)).toHaveLength(0);
  });

  test('the same attempt is never sent twice', async () => {
    const net = transport([() => json(envelope([message('Six.')]))]);
    const attempt = exposureAttempt(`run-${run}`, 'model@same', ['same']);
    await call(net.fetch, { attempt });
    const error = await failure(call(net.fetch, { attempt }));
    expect(error.code).toBe('aws_attempt_exists');
    expect(net.sent).toHaveLength(1);
  });

  test('an expired saved key refuses before reserving', async () => {
    const net = transport([]);
    const error = await failure(
      call(net.fetch, {
        connection: {
          ...CONNECTION,
          credential: { ...CONNECTION.credential, expiresAt: '2026-09-21T08:00:30.000Z' },
        },
        now: () => new Date('2026-09-21T08:00:00.000Z'),
      }),
    );
    expect(error.code).toBe('aws_credential_expired');
    expect(net.sent).toHaveLength(0);
    expect(exposure.list(CONNECTION.id)).toHaveLength(0);
  });

  test('a rate card for another model refuses', async () => {
    const net = transport([]);
    const error = await failure(
      call(net.fetch, { card: { ...AWS_LUNA_RATE_CARD, modelId: 'openai.gpt-5.6-luna' } }),
    );
    expect(error.code).toBe('aws_rate_card_mismatch');
    expect(net.sent).toHaveLength(0);
  });

  test('an input larger than the route allows refuses before reserving', async () => {
    const net = transport([]);
    const error = await failure(
      call(net.fetch, { messages: [{ role: 'user', content: 'x'.repeat(CONVERSATION_LIMITS.maxRequestBytes + 1) }] }),
    );
    expect(error.code).toBe('aws_input_too_large');
    expect(exposure.list(CONNECTION.id)).toHaveLength(0);
  });

  test('an answer whose cost cannot be recorded is not used', async () => {
    const net = transport([() => json(envelope([message('Six.')]))]);
    const ledger = Object.create(exposure) as SpendExposure;
    ledger.settle = async () => {
      throw new Error('disk full');
    };
    const error = await failure(call(net.fetch, { exposure: ledger }));
    expect(error.code).toBe('aws_usage_unrecorded');
    expect(exposure.list(CONNECTION.id)[0].state).toBe('uncertain');
  });
});

describe('classification reads the raw envelope', () => {
  test('text across parts joins; reasoning is not output; missing ids read as null', () => {
    const classified = classifyEnvelope({
      status: 'completed',
      output: [
        reasoning(),
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Six ' },
            { type: 'output_text', text: 'napkins.' },
          ],
        },
      ],
      usage: USAGE,
    });
    expect(classified.text).toBe('Six napkins.');
    expect(classified.responseId).toBeNull();
    expect(classified.reportedModel).toBeNull();
    expect(classified.unexpectedItems).toEqual([]);
    expect(classified.usage).toEqual({
      inputTokens: 1_200,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 300,
      reasoningTokens: 120,
    });
  });

  test('non-object bodies classify as empty, never as success', () => {
    for (const body of [null, 'text', [1, 2], 42]) {
      const classified = classifyEnvelope(body);
      expect(classified.status).toBeNull();
      expect(classified.text).toBe('');
      expect(classified.usage).toBeNull();
    }
  });
});
