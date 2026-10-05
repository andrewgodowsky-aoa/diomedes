/**
 * The exchange's observer (`respondStream`'s `observe`): called exactly once per call, on success
 * and on every failure, with what the call observed, and never able to change the outcome. The
 * network is a fixture; nothing reaches a provider.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { micro } from '../shared/managed-usage.js';
import * as aws from '../server/engines/aws-bedrock.js';
import { CONVERSATION_LIMITS, respondStream, type CallObservation, type RouteBinding } from '../server/engines/model-api-core.js';
import { SpendExposure } from '../server/spend-exposure.js';
import { chatEvents, sseResponse } from './fixtures/model-api-streams.js';

const K3 = 'us.moonshotai.kimi-k3';
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const CONNECTION = aws.awsConnectionSchema.parse({
  v: 1,
  id: 'aws-bedrock-1',
  accountId: '123456789012',
  region: 'us-east-1',
  baseUrl: aws.AWS_RESPONSES_ENDPOINTS['us-east-1'],
  modelId: K3,
  processing: 'us-geo',
  credential: { kind: 'bedrock-api-key', fingerprint: 'abcdef123456', savedAt: '2026-10-01T03:00:00.000Z', expiresAt: null },
  revision: 1,
  createdAt: '2026-10-01T03:00:00.000Z',
  updatedAt: '2026-10-01T03:00:00.000Z',
});
const usage = (output: number) => ({ prompt_tokens: 40, completion_tokens: output, total_tokens: 40 + output });

let dir: string;
let exposure: SpendExposure;
let calls = 0;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-observe-'));
  exposure = new SpendExposure(path.join(dir, 'spend'));
  await exposure.init();
  await exposure.setCap(CONNECTION.id, micro(10_000_000), { approvedBy: 'test owner', note: 'Fixture cap; no live request.' });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** One exchange on the K3 chat binding, observed; returns what came back and every observation. */
async function observed(
  answer: () => Response,
  options: { binding?: RouteBinding; exposure?: SpendExposure; observe?: (seen: CallObservation) => void } = {},
) {
  const seen: CallObservation[] = [];
  const messages: ModelMessage[] = [{ role: 'user', content: 'Reply with the single word OK.' }];
  let dispatches = 0;
  const outcome = await respondStream({
    binding: options.binding ?? aws.awsChatBinding(CONNECTION, 'low', 512, false),
    secret: SECRET,
    card: aws.awsModelRateCard(K3),
    exposure: options.exposure ?? exposure,
    attempt: aws.exposureAttempt(`observe-${++calls}`, 'model:0', messages),
    instructions: 'Answer briefly.',
    messages,
    tools: [],
    limits: { ...CONVERSATION_LIMITS, maxOutputTokens: 512 },
    signal: new AbortController().signal,
    transport: (async () => {
      dispatches += 1;
      return answer();
    }) as typeof globalThis.fetch,
    observe: (value) => {
      seen.push(value);
      options.observe?.(value);
    },
  }).then(
    (result) => ({ result, error: null }),
    (error: unknown) => ({ result: null, error }),
  );
  return { ...outcome, seen, dispatches };
}

describe('the exchange observer', () => {
  test('a completed answer is observed once with its identifiers, usage, text and settled hold', async () => {
    const { result, seen } = await observed(() =>
      sseResponse(chatEvents({ id: 'chatcmpl-ok', model: K3, text: 'OK', usage: usage(2) }), { 'x-amzn-requestid': 'req-ok' }),
    );
    expect(result?.outcome).toEqual({ kind: 'final', text: 'OK' });
    expect(seen).toEqual([
      {
        dispatched: true,
        status: 200,
        providerRequestId: 'req-ok',
        responseId: 'chatcmpl-ok',
        reportedModel: K3,
        classifiedStatus: 'completed',
        incompleteReason: null,
        usage: { inputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0 },
        functionCalls: 0,
        text: 'OK',
        providerError: null,
        reservation: { state: 'settled', microUsd: result!.reservation.settledMicroUsd },
        code: null,
      },
    ]);
  });

  test('an answer cut at the output limit is observed as incomplete, with the usage it reported', async () => {
    const { error, seen } = await observed(() =>
      sseResponse(chatEvents({ model: K3, text: 'The prime factors', finishReason: 'length', usage: usage(300) })),
    );
    expect(error).toMatchObject({ code: 'aws_incomplete_output' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      dispatched: true,
      status: 200,
      classifiedStatus: 'incomplete',
      incompleteReason: 'max_output_tokens',
      usage: { outputTokens: 300 },
      text: 'The prime factors',
      code: 'aws_incomplete_output',
    });
    expect(seen[0].reservation?.state).toBe('settled');
  });

  test('a 400 with an error body is observed with the provider error and a released hold', async () => {
    const { error, seen } = await observed(
      () =>
        new Response(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: prompt_cache_options', code: 'invalid_request_error' } }), {
          status: 400,
          headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'req-400' },
        }),
    );
    expect(error).toMatchObject({ code: 'aws_provider_refused', dispatched: true });
    expect(seen).toEqual([
      expect.objectContaining({
        dispatched: true,
        status: 400,
        providerRequestId: 'req-400',
        usage: null,
        text: null,
        providerError: { code: 'invalid_request_error', message: 'Unrecognized request argument supplied: prompt_cache_options' },
        reservation: { state: 'released', microUsd: 0 },
        code: 'aws_provider_refused',
      }),
    ]);
  });

  test('a call the guard refuses is observed as not sent, its hold released', async () => {
    // The binding was built for a different output limit: the serialized request does not match it.
    const { error, seen, dispatches } = await observed(() => sseResponse(chatEvents({ model: K3, text: 'OK', usage: usage(2) })), {
      binding: aws.awsChatBinding(CONNECTION, 'low', 100, false),
    });
    expect(error).toMatchObject({ code: 'aws_request_refused', dispatched: false });
    expect(dispatches).toBe(0);
    expect(seen).toEqual([
      expect.objectContaining({ dispatched: false, status: null, usage: null, reservation: { state: 'released', microUsd: 0 }, code: 'aws_request_refused' }),
    ]);
  });

  test('a call the spend limit refuses is observed as not sent, with no hold at all', async () => {
    const empty = new SpendExposure(path.join(dir, 'spend-empty'));
    await empty.init();
    const { error, seen, dispatches } = await observed(() => sseResponse(chatEvents({ model: K3, text: 'OK', usage: usage(2) })), {
      exposure: empty,
    });
    expect(error).toMatchObject({ dispatched: false });
    expect(dispatches).toBe(0);
    expect(seen).toEqual([expect.objectContaining({ dispatched: false, reservation: null, code: (error as { code: string }).code })]);
  });

  test('an observer that throws changes nothing, on success or on failure', async () => {
    const thrower = () => {
      throw new Error('The observer broke.');
    };
    const ok = await observed(() => sseResponse(chatEvents({ model: K3, text: 'OK', usage: usage(2) })), { observe: thrower });
    expect(ok.error).toBeNull();
    expect(ok.result?.outcome).toEqual({ kind: 'final', text: 'OK' });
    expect(ok.seen).toHaveLength(1);
    const failed = await observed(
      () => new Response(JSON.stringify({ error: { message: 'No.', code: 'bad' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
      { observe: thrower },
    );
    expect(failed.error).toMatchObject({ code: 'aws_provider_refused' });
    expect(failed.seen).toHaveLength(1);
  });

  test('observed text is bounded to 2,000 characters', async () => {
    const long = 'x'.repeat(3_000);
    const { result, seen } = await observed(() => sseResponse(chatEvents({ model: K3, text: long, usage: usage(400), split: 500 })));
    expect(result?.outcome).toEqual({ kind: 'final', text: long });
    expect(seen[0].text).toHaveLength(2_000);
  });
});
