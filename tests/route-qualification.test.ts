/**
 * The route checks end to end on the real SDK request path: `respondStream`, the route's own
 * binding and guard, the real spend ledger. Only the network is a scripted fixture that reads
 * each request's own bytes to decide its answer. Nothing here reaches AWS or Azure.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { estimateTokens } from '../shared/context-accounting.js';
import { micro } from '../shared/managed-usage.js';
import {
  QUALIFICATION_CHECKS,
  receiptQualifies,
  routeQualificationReceiptSchema,
  type RouteQualificationReceipt,
} from '../shared/route-qualification.js';
import * as aws from '../server/engines/aws-bedrock.js';
import {
  azureBinding,
  azureConnectionSchema,
  azureEndpoint,
  azureQualificationIdentity,
  azureQualificationTarget,
  azureRateCard,
} from '../server/engines/azure-openai.js';
import { CONVERSATION_LIMITS, respondStream, type RouteBinding } from '../server/engines/model-api-core.js';
import {
  CACHE_PREFIX,
  CHECK_OUTPUT_TOKENS,
  OUTPUT_BOUND_TOKENS,
  plannedCeilingMicroUsd,
  runRouteQualification,
  withCacheOptions,
  type QualificationTarget,
} from '../server/engines/route-qualification.js';
import { SpendExposure, type ModelRateCard } from '../server/spend-exposure.js';
import { chatEvents, responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import { hanging, routeCheckProvider, type CallKind, type Script, type Seen } from './fixtures/route-check-provider.js';

type Item = Record<string, unknown>;
const K3 = 'us.moonshotai.kimi-k3';
const SOL = 'gpt-6.1-sol';
const SOL_SERVED = 'gpt-6.1-sol-2026-09-15';
const AWS_SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const AZURE_SECRET = 'test-only-azure-key-0123456789abcdef';
const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-05T12:00:00.000Z');

const K3_CONNECTION = aws.awsConnectionSchema.parse({
  v: 1,
  id: 'aws-bedrock-1',
  accountId: '123456789012',
  region: 'us-east-1',
  baseUrl: aws.AWS_RESPONSES_ENDPOINTS['us-east-1'],
  modelId: K3,
  processing: 'us-geo',
  credential: { kind: 'bedrock-api-key', fingerprint: 'abcdef123456', savedAt: '2026-10-01T03:00:00.000Z', expiresAt: null },
  revision: 4,
  createdAt: '2026-10-01T03:00:00.000Z',
  updatedAt: '2026-10-01T03:00:00.000Z',
});
const AZURE_BASE = azureEndpoint('contoso-ai');
const AZURE_CONNECTION = azureConnectionSchema.parse({
  v: 1,
  id: 'azure-openai-1',
  resourceName: 'contoso-ai',
  baseUrl: AZURE_BASE,
  apiVersion: 'v1',
  deployments: [
    {
      model: SOL,
      deployment: 'sol-prod-eastus2',
      reasoning: true,
      rates: {
        input: 2_000_000,
        output: 12_000_000,
        cacheRead: 200_000,
        cacheWrite: null,
        source: 'Azure pricing page, read by the test owner',
        declaredAt: '2026-10-01T08:00:00.000Z',
      },
    },
  ],
  credential: { kind: 'azure-api-key', fingerprint: 'abcdef123456', savedAt: '2026-10-01T08:00:00.000Z', expiresAt: null },
  revision: 2,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
});

const awsProvider = (script: Script = {}) => routeCheckProvider('chat', K3, script);
const azureProvider = (script: Script = {}) => routeCheckProvider('responses', SOL_SERVED, script);

// --- the runs -------------------------------------------------------------------------------

let dir: string;
let exposure: SpendExposure;
let ids = 0;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-route-checks-'));
  exposure = new SpendExposure(path.join(dir, 'spend'));
  await exposure.init();
  for (const id of [K3_CONNECTION.id, AZURE_CONNECTION.id])
    await exposure.setCap(id, micro(10_000_000), { approvedBy: 'test owner', note: 'Fixture cap; no live request.' });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const awsTarget = () => aws.awsQualificationTarget(K3_CONNECTION, 'low');
const azureTarget = () => azureQualificationTarget(AZURE_CONNECTION, SOL, 'low');
const runOn = (target: QualificationTarget, net: { fetch: typeof globalThis.fetch }, signal = new AbortController().signal) =>
  runRouteQualification({
    target,
    secret: target.route === 'aws-bedrock' ? AWS_SECRET : AZURE_SECRET,
    exposure,
    signal,
    now: () => NOW,
    idFactory: () => `rq_fixture${String(++ids).padStart(4, '0')}`,
    transport: net.fetch,
  });
const outcomes = (receipt: RouteQualificationReceipt) => Object.fromEntries(receipt.checks.map((check) => [check.id, check.outcome]));
const detail = (receipt: RouteQualificationReceipt, id: (typeof QUALIFICATION_CHECKS)[number]) =>
  receipt.checks.find((check) => check.id === id)!.detail;
const bodiesOf = (seen: Seen[], kind: CallKind) => seen.filter((call) => call.kind === kind).map((call) => call.body);

describe('route checks on the AWS Kimi K3 route, over Chat Completions', () => {
  test('every check passes, and each request has exactly the shape its check needs', async () => {
    const net = awsProvider();
    const receipt = await runOn(awsTarget(), net);

    expect(routeQualificationReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({
      v: 1,
      id: 'rq_fixture0001',
      createdAt: NOW.toISOString(),
      validUntil: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
      route: 'aws-bedrock',
      connectionId: 'aws-bedrock-1',
      connectionRevision: 4,
      endpoint: K3_CONNECTION.baseUrl,
      deployment: null,
      model: K3,
      servedModels: [K3],
      protocol: 'openai-chat-completions',
      sdk: aws.AWS_BEDROCK_SDK,
      effort: 'low',
      rateCard: aws.awsModelRateCard(K3).version,
      verdicts: { answers: true, outputBound: 'bounded', tools: 'one-call', cacheDefault: 'caches', cacheOff: 'verified' },
    });
    expect(receipt.checks.map((check) => check.id)).toEqual([...QUALIFICATION_CHECKS]);
    expect(Object.values(outcomes(receipt))).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
    expect(detail(receipt, 'output-bound')).toBe('Reported 64 billed output tokens, reasoning included, for a limit of 64.');
    expect(detail(receipt, 'cache-default')).toBe('The second identical request read 1280 input tokens from a cache.');
    expect(receiptQualifies(receipt, aws.awsQualificationIdentity(K3_CONNECTION), NOW.getTime())).toEqual({ ok: true });

    // Eight calls, each held on the route's own ledger under this run, and each settled.
    expect(net.seen.map((call) => call.kind)).toEqual([
      'short-answer', 'output-bound', 'tool-ask', 'tool-answer', 'cache-default', 'cache-default', 'cache-off', 'cache-off',
    ]);
    const holds = exposure.list(K3_CONNECTION.id);
    expect(holds.map((hold) => hold.attempt.stepId)).toEqual([
      'short-answer:1', 'output-bound:1', 'tool-round-trip:1', 'tool-round-trip:2',
      'cache-default:1', 'cache-default:2', 'cache-off:1', 'cache-off:2',
    ]);
    expect(new Set(holds.map((hold) => hold.attempt.runId))).toEqual(new Set([`qualify:${receipt.id}`]));
    expect(holds.every((hold) => hold.state === 'settled')).toBe(true);
    const calls = receipt.checks.flatMap((check) => check.calls);
    expect(calls.every((call) => call.ledger?.state === 'settled')).toBe(true);
    expect(receipt.spend).toEqual({ settledMicroUsd: holds.reduce((sum, hold) => sum + (hold.settledMicroUsd ?? 0), 0), uncertainMicroUsd: 0 });
    // Cache writes are billed at the dearer rate, so every call records them.
    expect(receipt.checks.find((check) => check.id === 'cache-default')!.calls.map((call) => call.usage?.cacheWriteTokens)).toEqual([1_536, 0]);
    const placed = new Map<CallKind, number>();
    const expectedIds = net.seen.map((call) => {
      const n = (placed.get(call.kind) ?? 0) + 1;
      placed.set(call.kind, n);
      return `req-${call.kind}-${n}`;
    });
    expect(calls.map((call) => call.providerRequestId)).toEqual(expectedIds);

    // The shapes: the chat endpoint and the key, the exact output limits, one offered tool.
    for (const call of net.seen) {
      expect(call.url).toBe(`${K3_CONNECTION.baseUrl}/chat/completions`);
      expect(call.headers.get('authorization')).toBe(`Bearer ${AWS_SECRET}`);
      expect(call.body).toMatchObject({ model: K3, stream: true, stream_options: { include_usage: true }, store: false });
      expect(call.body).not.toHaveProperty('max_tokens');
      expect(call.body.max_completion_tokens).toBe(call.kind === 'output-bound' ? OUTPUT_BOUND_TOKENS : CHECK_OUTPUT_TOKENS);
    }
    const [ask] = bodiesOf(net.seen, 'tool-ask');
    expect(ask.tools).toHaveLength(1);
    expect((ask.tools as Item[])[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'lookup_fact',
        parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
      },
    });
    const [answer] = bodiesOf(net.seen, 'tool-answer');
    expect((answer.messages as Item[]).at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_lookup_1', content: '{"value":"blue-42"}' });

    // The cache checks: the same prefix both times; no cache field by default; the no-cache option alone.
    const defaults = bodiesOf(net.seen, 'cache-default');
    const offs = bodiesOf(net.seen, 'cache-off');
    expect(JSON.stringify(defaults[0].messages)).toBe(JSON.stringify(defaults[1].messages));
    expect((defaults[0].messages as Item[])[0]).toEqual({ role: 'system', content: CACHE_PREFIX });
    for (const body of defaults) {
      expect(body).not.toHaveProperty('prompt_cache_key');
      expect(body).not.toHaveProperty('prompt_cache_options');
    }
    for (const body of offs) {
      expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
      expect(body).not.toHaveProperty('prompt_cache_key');
    }

    // Identifiers, counts and sentences only: no key, no prompt, no answer text.
    const written = JSON.stringify(receipt);
    for (const absent of [AWS_SECRET, 'Reply with the single word', 'Rule 1:', 'blue-42', '9699690'])
      expect(written).not.toContain(absent);
  });

  test('billed output above the limit fails the output bound: 300 reported for a limit of 64', async () => {
    const receipt = await runOn(awsTarget(), awsProvider({ outputBound: 300 }));
    expect(receipt.verdicts.outputBound).toBe('exceeded');
    expect(outcomes(receipt)['output-bound']).toBe('failed');
    expect(detail(receipt, 'output-bound')).toBe('Reported 300 billed output tokens, reasoning included, for a limit of 64.');
    const [call] = receipt.checks.find((check) => check.id === 'output-bound')!.calls;
    expect(call).toMatchObject({ finish: 'incomplete', incompleteReason: 'max_output_tokens', maxOutputTokens: 64, usage: { outputTokens: 300 } });
    // The run goes on: the other checks still observe the route.
    expect(outcomes(receipt)).toMatchObject({ 'tool-round-trip': 'passed', 'cache-default': 'passed', 'cache-off': 'passed' });
    expect(receiptQualifies(receipt, aws.awsQualificationIdentity(K3_CONNECTION), NOW.getTime())).toEqual({
      ok: false,
      reason: 'The route check saw billed output above the limit it was sent with.',
    });
  });

  test('a 400 on prompt_cache_options marks the no-cache option unsupported and releases its hold', async () => {
    const receipt = await runOn(awsTarget(), awsProvider({ cacheOff: 'refused' }));
    expect(receipt.verdicts.cacheOff).toBe('unsupported');
    expect(outcomes(receipt)['cache-off']).toBe('unsupported');
    expect(detail(receipt, 'cache-off')).toBe('AWS refused the no-cache option (HTTP 400).');
    const calls = receipt.checks.find((check) => check.id === 'cache-off')!.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 400, finish: 'error', usage: null, ledger: { state: 'released', microUsd: 0 } });
    // Cache verdicts do not decide use: K3 still qualifies.
    expect(receiptQualifies(receipt, aws.awsQualificationIdentity(K3_CONNECTION), NOW.getTime())).toEqual({ ok: true });
  });

  test('cache tokens under the no-cache option leave it not verified', async () => {
    const receipt = await runOn(awsTarget(), awsProvider({ cacheOff: 'writes', cacheReads: [0, 0] }));
    expect(receipt.verdicts).toMatchObject({ cacheDefault: 'no-cache-observed', cacheOff: 'not-verified' });
    expect(outcomes(receipt)).toMatchObject({ 'cache-default': 'passed', 'cache-off': 'failed' });
    expect(detail(receipt, 'cache-default')).toBe('Neither identical request read from a cache.');
  });

  test('a 401 on the first check stops the run: nothing else is sent', async () => {
    const net = awsProvider({ unauthorized: true });
    const receipt = await runOn(awsTarget(), net);
    expect(net.seen).toHaveLength(1);
    expect(receipt.checks.map((check) => [check.id, check.outcome, check.detail])).toEqual([
      ['short-answer', 'failed', 'AWS refused the key (HTTP 401).'],
      ['output-bound', 'not-run', 'Not run: AWS refused the key on the first check.'],
      ['tool-round-trip', 'not-run', 'Not run: AWS refused the key on the first check.'],
      ['cache-default', 'not-run', 'Not run: AWS refused the key on the first check.'],
      ['cache-off', 'not-run', 'Not run: AWS refused the key on the first check.'],
    ]);
    expect(receipt.checks[0].calls[0]).toMatchObject({ status: 401, finish: 'error', ledger: { state: 'released' } });
    expect(receipt.verdicts).toEqual({ answers: false, outputBound: 'unknown', tools: 'unknown', cacheDefault: 'unknown', cacheOff: 'unknown' });
    expect(receipt.spend).toEqual({ settledMicroUsd: 0, uncertainMicroUsd: 0 });
    expect(receiptQualifies(receipt, aws.awsQualificationIdentity(K3_CONNECTION), NOW.getTime())).toEqual({
      ok: false,
      reason: 'The route check did not get a complete answer.',
    });
  });

  test('Stop cancels the call in flight, leaves its hold uncertain and records the rest as not run', async () => {
    const stop = new AbortController();
    const net = awsProvider({
      intercept: (kind, signal) => {
        if (kind !== 'tool-ask') return undefined;
        setTimeout(() => stop.abort(), 20);
        return hanging(signal);
      },
    });
    const receipt = await runOn(awsTarget(), net, stop.signal);
    expect(net.seen.map((call) => call.kind)).toEqual(['short-answer', 'output-bound', 'tool-ask']);
    expect(receipt.checks.map((check) => [check.id, check.outcome, check.detail])).toEqual([
      ['short-answer', 'passed', 'Answered OK in full, with usage reported.'],
      ['output-bound', 'passed', 'Reported 64 billed output tokens, reasoning included, for a limit of 64.'],
      ['tool-round-trip', 'failed', 'Stopped before this check finished.'],
      ['cache-default', 'not-run', 'Not run: the route checks were stopped.'],
      ['cache-off', 'not-run', 'Not run: the route checks were stopped.'],
    ]);
    const [inFlight] = receipt.checks[2].calls;
    expect(inFlight).toMatchObject({ finish: 'cancelled', ledger: { state: 'uncertain' } });
    expect(receipt.spend.uncertainMicroUsd).toBe(inFlight.ledger!.microUsd);
    expect(receipt.spend.uncertainMicroUsd).toBeGreaterThan(0);
    expect(exposure.list(K3_CONNECTION.id).map((hold) => hold.state)).toEqual(['settled', 'settled', 'uncertain']);
    expect(receipt.verdicts.tools).toBe('unknown');
  });

  test('refuses before anything is sent when the spend limit cannot hold every planned call', async () => {
    const ceiling = plannedCeilingMicroUsd(awsTarget());
    expect(ceiling).toBeGreaterThan(50_000);
    await exposure.setCap(K3_CONNECTION.id, micro(50_000), { approvedBy: 'test owner', note: 'A small fixture cap.' });
    const net = awsProvider();
    const dollars = `$${(Math.ceil(ceiling / 10_000) / 100).toFixed(2)}`;
    await expect(runOn(awsTarget(), net)).rejects.toMatchObject({
      name: 'QualificationRefused',
      code: 'qualify_no_room',
      message: `The route checks can hold up to ${dollars}, and $0.05 of the AWS spend limit is left. Raise the limit or resolve open calls first. Nothing was sent.`,
    });
    expect(net.seen).toEqual([]);
    expect(exposure.list(K3_CONNECTION.id)).toEqual([]);
  });

  test('refuses with no spend limit approved', async () => {
    const empty = new SpendExposure(path.join(dir, 'spend-empty'));
    await empty.init();
    const net = awsProvider();
    await expect(
      runRouteQualification({ target: awsTarget(), secret: AWS_SECRET, exposure: empty, signal: new AbortController().signal, transport: net.fetch }),
    ).rejects.toMatchObject({ code: 'qualify_no_limit', message: 'Approve a spend limit for AWS before running route checks. Nothing was sent.' });
    expect(net.seen).toEqual([]);
  });

  test('the cache prefix is about 1,500 tokens by the estimator, well above the 1,024-token cache minimum', () => {
    const tokens = estimateTokens(CACHE_PREFIX);
    expect(tokens).toBeGreaterThanOrEqual(1_450);
    expect(tokens).toBeLessThanOrEqual(1_650);
  });
});

describe('route checks on an Azure deployment, over Responses', () => {
  test('every check passes on GPT-6.1 Sol, with the no-cache option under the azure namespace', async () => {
    const net = azureProvider();
    const receipt = await runOn(azureTarget(), net);
    expect(receipt).toMatchObject({
      route: 'azure-openai',
      connectionId: 'azure-openai-1',
      connectionRevision: 2,
      endpoint: AZURE_BASE,
      deployment: 'sol-prod-eastus2',
      model: SOL,
      servedModels: [SOL_SERVED],
      protocol: 'openai-responses',
      rateCard: azureRateCard(AZURE_CONNECTION, SOL).version,
      verdicts: { answers: true, outputBound: 'bounded', tools: 'one-call', cacheDefault: 'caches', cacheOff: 'verified' },
    });
    expect(Object.values(outcomes(receipt))).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
    expect(receiptQualifies(receipt, azureQualificationIdentity(AZURE_CONNECTION, SOL), NOW.getTime())).toEqual({ ok: true });
    for (const call of net.seen) {
      expect(call.url).toBe(`${AZURE_BASE}/responses`);
      expect(call.headers.get('api-key')).toBe(AZURE_SECRET);
      expect(call.body).toMatchObject({ model: 'sol-prod-eastus2', store: false, stream: true });
      expect(call.body.max_output_tokens).toBe(call.kind === 'output-bound' ? OUTPUT_BOUND_TOKENS : CHECK_OUTPUT_TOKENS);
    }
    for (const body of bodiesOf(net.seen, 'cache-default')) {
      expect(body).not.toHaveProperty('prompt_cache_key');
      expect(body).not.toHaveProperty('prompt_cache_options');
    }
    const offs = bodiesOf(net.seen, 'cache-off');
    expect(offs).toHaveLength(2);
    for (const body of offs) {
      expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
      expect(body).not.toHaveProperty('prompt_cache_key');
    }
    const [answer] = bodiesOf(net.seen, 'tool-answer');
    expect((answer.input as Item[]).at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call_lookup_1', output: '{"value":"blue-42"}' });
    expect(exposure.list(AZURE_CONNECTION.id).every((hold) => hold.state === 'settled')).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain(AZURE_SECRET);
  });
});

describe('cache options reach the request only under the namespace the SDK reads', () => {
  const one = async (binding: RouteBinding, card: ModelRateCard, secret: string, answer: () => Response) => {
    const bodies: Item[] = [];
    const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Item);
      return answer();
    }) as typeof globalThis.fetch;
    const messages: ModelMessage[] = [{ role: 'user', content: 'Reply with the single word OK.' }];
    await respondStream({
      binding,
      secret,
      card,
      exposure,
      attempt: aws.exposureAttempt(`namespace-${++ids}`, 'model:0', messages),
      instructions: 'Answer briefly.',
      messages,
      tools: [],
      limits: { ...CONVERSATION_LIMITS, maxOutputTokens: CHECK_OUTPUT_TOKENS },
      signal: new AbortController().signal,
      transport,
    });
    return bodies[0];
  };
  const chatOk = () =>
    sseResponse(chatEvents({ model: K3, text: 'OK', usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }));
  const responsesOk = () =>
    sseResponse(
      responsesEvents({
        id: 'resp_ns',
        object: 'response',
        created_at: 1_790_000_000,
        status: 'completed',
        model: SOL_SERVED,
        output: [{ type: 'message', id: 'msg_ns', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }],
        usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 },
        incomplete_details: null,
        error: null,
      }),
    );

  test('AWS Chat Completions reads openai; the same option under azure is dropped', async () => {
    const chat = aws.awsChatBinding(K3_CONNECTION, 'low', CHECK_OUTPUT_TOKENS, false);
    const card = aws.awsModelRateCard(K3);
    expect((await one(withCacheOptions(chat, 'openai', { cacheOff: true }), card, AWS_SECRET, chatOk)).prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(await one(withCacheOptions(chat, 'azure', { cacheOff: true }), card, AWS_SECRET, chatOk)).not.toHaveProperty('prompt_cache_options');
  });

  test('Azure Responses reads azure; the same option under openai is dropped', async () => {
    const entry = AZURE_CONNECTION.deployments[0];
    const responses = azureBinding(AZURE_CONNECTION, entry, 'low', false);
    const card = azureRateCard(AZURE_CONNECTION, SOL);
    expect((await one(withCacheOptions(responses, 'azure', { cacheOff: true }), card, AZURE_SECRET, responsesOk)).prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(await one(withCacheOptions(responses, 'openai', { cacheOff: true }), card, AZURE_SECRET, responsesOk)).not.toHaveProperty('prompt_cache_options');
  });
});
