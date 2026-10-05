/**
 * The gateway route checks runner (DIO-217) on scripted transports: a Kimi K3 route on Bedrock's
 * Chat Completions and a GPT-6.1 Sol route on Azure's Responses, each through callManagedProvider.
 * Nothing here reaches a network.
 */
import { describe, expect, it } from 'vitest';
import {
  FAUX_AWS_CONNECTION,
  FAUX_AZURE_CONNECTION,
  chatCompletionsStream,
  fauxRouteCheckRoutes,
  responsesStream,
  scriptedRouteChecksFetch,
  type ScriptedRouteChecksOptions,
} from '../src/faux/route-checks.js';
import {
  CACHE_OFF_UNSUPPORTED,
  GATEWAY_ROUTE_CHECKS_SDK,
  planRouteChecks,
  routeCheckIdentity,
  runRouteChecks,
  type CheckedRoute,
} from '../src/route-checks.js';
import { providerBody } from '../src/managed-bindings.js';
import { CACHE_PREFIX, CHECK_OUTPUT_TOKENS, OUTPUT_BOUND_TOKENS, TOOL_ASK, TOOL_VALUE } from '../../../shared/route-qualification-plan.js';
import {
  QUALIFICATION_VALID_DAYS,
  receiptQualifies,
  routeQualificationReceiptSchema,
  type QualificationCheckId,
  type RouteQualificationReceipt,
} from '../../../shared/route-qualification.js';
import { usageCost } from '../../../shared/managed-usage.js';
import type { ProviderConnection } from '../../../shared/routing-policy.js';

const AT = Date.parse('2026-10-05T12:00:00.000Z');
const KEY = 'test-provider-key-0123456789abcdef';
const RECEIPT = 'rq_0123456789abcdef01234567';

type RouteId = 'aws-kimi-k3' | 'azure-sol-6-1';
function target(id: RouteId): { route: CheckedRoute; connection: ProviderConnection } {
  const input = fauxRouteCheckRoutes(new Date(AT).toISOString()).find((entry) => entry.id === id)!;
  const route = { ...input, v: 1 as const, revision: 1, updatedAt: new Date(AT).toISOString(), updatedBy: 'person_routing' };
  return { route, connection: id === 'aws-kimi-k3' ? FAUX_AWS_CONNECTION : FAUX_AZURE_CONNECTION };
}

interface Seen { url: string; redirect: RequestRedirect; headers: Headers; body: Record<string, unknown> }
/** The scripted provider, with every request it was sent kept for the test to read. */
function provider(options: ScriptedRouteChecksOptions = {}) {
  const scripted = scriptedRouteChecksFetch({ now: () => AT, ...options });
  const seen: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, redirect: request.redirect, headers: request.headers, body: JSON.parse(await request.clone().text()) });
    return scripted(request);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

async function run(id: RouteId, transport: typeof globalThis.fetch, extra: { idleTimeoutMs?: number } = {}) {
  const { route, connection } = target(id);
  const plan = planRouteChecks(route, connection);
  const outcome = await runRouteChecks({ route, connection, credential: KEY, plan, transport, receiptId: RECEIPT, now: () => AT, ...extra });
  return { route, connection, plan, outcome, receipt: outcome.receipt };
}

const byId = (receipt: RouteQualificationReceipt, id: QualificationCheckId) => receipt.checks.find((check) => check.id === id)!;
const rateOf = (route: CheckedRoute) => route.binding.price;

describe('the gateway route checks on a Kimi K3 route over Bedrock Chat Completions', () => {
  it('passes every check it can make, records the exact identity and qualifies the route', async () => {
    const scripted = provider();
    const { route, connection, receipt, outcome, plan } = await run('aws-kimi-k3', scripted.fetch);
    expect(() => routeQualificationReceiptSchema.parse(receipt)).not.toThrow();
    expect(receipt).toMatchObject({
      v: 1, id: RECEIPT, createdAt: '2026-10-05T12:00:00.000Z',
      validUntil: new Date(AT + QUALIFICATION_VALID_DAYS * 86_400_000).toISOString(),
      route: 'aws-bedrock', connectionId: 'aws-bedrock-us-east-1', connectionRevision: 1,
      endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions',
      deployment: null, model: 'us.moonshotai.kimi-k3', servedModels: ['us.moonshotai.kimi-k3'],
      protocol: 'openai-chat-completions', sdk: GATEWAY_ROUTE_CHECKS_SDK, effort: 'low', rateCard: route.binding.price.version,
      verdicts: { answers: true, outputBound: 'bounded', tools: 'one-call', cacheDefault: 'caches', cacheOff: 'unsupported' },
    });
    expect(receipt.checks.map((check) => [check.id, check.outcome, check.calls.length])).toEqual([
      ['short-answer', 'passed', 1], ['output-bound', 'passed', 1], ['tool-round-trip', 'passed', 2],
      ['cache-default', 'passed', 2], ['cache-off', 'unsupported', 0],
    ]);
    expect(byId(receipt, 'output-bound').detail).toBe(`Reported ${OUTPUT_BOUND_TOKENS} billed output tokens, reasoning included, for a limit of ${OUTPUT_BOUND_TOKENS}.`);
    expect(byId(receipt, 'cache-default').detail).toMatch(/^The second identical request read \d+ input tokens from a cache\.$/);
    expect(byId(receipt, 'cache-off').detail).toBe(CACHE_OFF_UNSUPPORTED);
    expect(receiptQualifies(receipt, routeCheckIdentity(route, connection)!, AT)).toEqual({ ok: true });

    // Six calls, each a Chat Completions request the gateway encoded, with the key as a bearer and no redirect followed.
    expect(scripted.seen).toHaveLength(6);
    for (const request of scripted.seen) {
      expect(request.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions');
      expect(request.redirect).toBe('manual');
      expect(request.headers.get('authorization')).toBe(`Bearer ${KEY}`);
      expect(request.body).toMatchObject({ model: 'us.moonshotai.kimi-k3', stream: true, stream_options: { include_usage: true }, reasoning_effort: 'low' });
      expect(Object.hasOwn(request.body, 'store')).toBe(false);
    }
    expect(scripted.seen.map((request) => request.body.max_completion_tokens)).toEqual(
      [CHECK_OUTPUT_TOKENS, OUTPUT_BOUND_TOKENS, CHECK_OUTPUT_TOKENS, CHECK_OUTPUT_TOKENS, CHECK_OUTPUT_TOKENS, CHECK_OUTPUT_TOKENS]);
    // The round trip's second call carries the model's own call back, then the tool's result.
    const second = scripted.seen[3].body.messages as Record<string, unknown>[];
    expect(second.slice(1)).toEqual([
      { role: 'user', content: TOOL_ASK },
      { role: 'assistant', content: null, tool_calls: [{ id: 'functions.lookup_fact:0', type: 'function', function: { name: 'lookup_fact', arguments: '{"key":"alpha"}' } }] },
      { role: 'tool', tool_call_id: 'functions.lookup_fact:0', content: JSON.stringify({ value: TOOL_VALUE }) },
    ]);
    expect((scripted.seen[4].body.messages as { role: string; content: string }[])[0]).toEqual({ role: 'system', content: CACHE_PREFIX });

    // Spend: every call settled from its reported usage, and nothing left uncertain.
    const calls = receipt.checks.flatMap((check) => check.calls);
    for (const call of calls) expect(call.ledger).toEqual({ state: 'settled', microUsd: usageCost(rateOf(route), call.usage!) });
    expect(outcome.spentMicroUsd).toBe(calls.reduce((sum, call) => sum + call.ledger!.microUsd, 0));
    expect(receipt.spend).toEqual({ settledMicroUsd: outcome.spentMicroUsd, uncertainMicroUsd: 0 });
    expect(outcome.uncertainMicroUsd).toBe(0);
    expect(outcome.boundMicroUsd).toBe(plan.boundMicroUsd);
    expect(outcome.spentMicroUsd).toBeGreaterThan(0);
    expect(outcome.spentMicroUsd).toBeLessThan(outcome.boundMicroUsd);
    for (const call of calls) expect(call).toMatchObject({ providerRequestId: expect.any(String), responseId: expect.stringMatching(/^chatcmpl-/) });
  });

  it('bounds each call at the estimate a customer call is held at, and prices usage the way settlement does', () => {
    const { route, connection } = target('aws-kimi-k3');
    const plan = planRouteChecks(route, connection);
    const calls = [plan.shortAnswer, plan.outputBound, plan.toolAsk, plan.toolAnswer, ...plan.cacheDefault];
    expect(plan.boundMicroUsd).toBe(calls.reduce((sum, call) => sum + call.boundMicroUsd, 0));
    // The short answer by hand: the larger of its gateway body's and its provider request's bytes, plus 1,024 and 16
    // for its one message, at the dearest input-side rate (cache write, 4.125 dollars a million), and 512 output tokens
    // at 16.5 dollars a million.
    const size = (text: string) => new TextEncoder().encode(text).byteLength;
    const bytes = Math.max(size(providerBody(route, connection, plan.shortAnswer.body)), size(JSON.stringify(plan.shortAnswer.body)));
    expect(plan.shortAnswer.boundMicroUsd).toBe(Math.ceil(((bytes + 1_024 + 16) * 4_125_000 + 512 * 16_500_000) / 1_000_000));
    // The tool answer is planned with room for the model's call, so it is the largest non-cache bound.
    expect(plan.toolAnswer.boundMicroUsd).toBeGreaterThan(plan.toolAsk.boundMicroUsd);
    // A priced call by hand: fresh input at 3.3, cache reads at 0.33, and output, reasoning included, at 16.5 dollars a million.
    expect(usageCost(route.binding.price, { inputTokens: 2_000, cacheReadTokens: 1_536, cacheWriteTokens: 0, outputTokens: 18, reasoningTokens: 14 }))
      .toBe(Math.ceil((464 * 3_300_000 + 1_536 * 330_000 + 18 * 16_500_000) / 1_000_000));
  });

  it('fails the output bound when the provider bills more output than the limit, and then does not qualify', async () => {
    const { receipt, route, connection } = await run('aws-kimi-k3', provider({ outputBoundTokens: 80 }).fetch);
    expect(byId(receipt, 'output-bound')).toMatchObject({ outcome: 'failed', detail: `Reported 80 billed output tokens, reasoning included, for a limit of ${OUTPUT_BOUND_TOKENS}.` });
    expect(receipt.verdicts.outputBound).toBe('exceeded');
    expect(receiptQualifies(receipt, routeCheckIdentity(route, connection)!, AT))
      .toEqual({ ok: false, reason: 'The route check saw billed output above the limit it was sent with.' });
  });

  it('records a provider that never read a cache, and one whose first request already did', async () => {
    const uncached = await run('aws-kimi-k3', provider({ intercept: ({ kind, body }) => kind === 'cache'
      ? chatCompletionsStream({ model: String(body.model), text: 'OK', usage: { input: 1_600, cacheRead: 0, output: 18, reasoning: 14 } }, { id: 'chatcmpl-uncached', created: AT / 1000 })
      : undefined }).fetch);
    expect(uncached.receipt.verdicts.cacheDefault).toBe('no-cache-observed');
    expect(byId(uncached.receipt, 'cache-default')).toMatchObject({ outcome: 'passed', detail: 'Neither identical request read from a cache.' });
    let cacheCall = 0;
    const warm = await run('aws-kimi-k3', provider({ intercept: ({ kind, body }) => kind === 'cache'
      ? chatCompletionsStream({ model: String(body.model), text: 'OK', usage: { input: 1_600, cacheRead: ++cacheCall === 1 ? 1_536 : 0, output: 18, reasoning: 14 } },
        { id: `chatcmpl-warm-${cacheCall}`, created: AT / 1000 })
      : undefined }).fetch);
    expect(warm.receipt.verdicts.cacheDefault).toBe('unknown');
    expect(byId(warm.receipt, 'cache-default')).toMatchObject({ outcome: 'passed', detail: 'Both requests completed, and the first already read from a cache.' });
  });

  it('fails the tool round trip when the model answers without the tool, and the route does not qualify', async () => {
    const scripted = provider({ intercept: ({ kind, body }) => kind === 'tool-ask'
      ? chatCompletionsStream({ model: String(body.model), text: TOOL_VALUE, usage: { input: 300, cacheRead: 0, output: 9, reasoning: 4 } }, { id: 'chatcmpl-notool', created: AT / 1000 })
      : undefined });
    const { receipt, route, connection } = await run('aws-kimi-k3', scripted.fetch);
    expect(byId(receipt, 'tool-round-trip')).toMatchObject({ outcome: 'failed', detail: 'Answered without calling the offered tool.' });
    expect(byId(receipt, 'tool-round-trip').calls).toHaveLength(1);
    expect(receipt.verdicts.tools).toBe('failed');
    expect(scripted.seen).toHaveLength(5);
    expect(receiptQualifies(receipt, routeCheckIdentity(route, connection)!, AT)).toEqual({ ok: false, reason: 'The route check could not complete a tool round trip.' });
  });

  it('keeps the key out of the receipt when a 400 echoes it, and spends nothing on refusals the provider does not bill', async () => {
    const scripted = provider({ intercept: () => Response.json({ error: { message: `The key ${KEY} cannot use this request shape.` } },
      { status: 400, headers: { 'x-amzn-requestid': 'request-400' } }) });
    const { receipt, outcome } = await run('aws-kimi-k3', scripted.fetch);
    const text = JSON.stringify(receipt);
    expect(text).not.toContain(KEY);
    for (let at = 0; at + 12 <= KEY.length; at++) expect(text).not.toContain(KEY.slice(at, at + 12));
    expect(receipt.checks.map((check) => [check.id, check.outcome, check.detail])).toEqual([
      ['short-answer', 'failed', 'AWS refused the request (HTTP 400).'],
      ['output-bound', 'unsupported', 'AWS refused the request (HTTP 400).'],
      ['tool-round-trip', 'unsupported', 'AWS refused the request with the tool (HTTP 400).'],
      ['cache-default', 'failed', 'AWS refused the request (HTTP 400).'],
      ['cache-off', 'unsupported', CACHE_OFF_UNSUPPORTED],
    ]);
    const calls = receipt.checks.flatMap((check) => check.calls);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call).toMatchObject({ status: 400, finish: 'refused', providerRequestId: 'request-400', usage: null, ledger: { state: 'released', microUsd: 0 } });
      expect(call.error).toEqual({ code: 'provider_refused', message: 'The key [redacted] cannot use this request shape.' });
    }
    expect(outcome).toMatchObject({ spentMicroUsd: 0, uncertainMicroUsd: 0 });
  });

  it('holds a sent call that reported no usage as uncertain at its bound', async () => {
    const { receipt, outcome, plan } = await run('aws-kimi-k3', provider({ intercept: ({ kind, body }) => kind === 'short-answer'
      ? chatCompletionsStream({ model: String(body.model), text: 'OK', usage: null }, { id: 'chatcmpl-nousage', created: AT / 1000 })
      : undefined }).fetch);
    expect(byId(receipt, 'short-answer')).toMatchObject({ outcome: 'failed', detail: 'AWS did not report usage.' });
    expect(byId(receipt, 'short-answer').calls[0]).toMatchObject({ finish: 'completed', usage: null, ledger: { state: 'uncertain', microUsd: plan.shortAnswer.boundMicroUsd } });
    expect(outcome.uncertainMicroUsd).toBe(plan.shortAnswer.boundMicroUsd);
    expect(receipt.spend.uncertainMicroUsd).toBe(plan.shortAnswer.boundMicroUsd);
    // The run went on: a missing usage report is not a reason to stop.
    expect(byId(receipt, 'output-bound').outcome).toBe('passed');
  });

  it('stops after a first check the provider refused the key on', async () => {
    const scripted = provider({ intercept: () => Response.json({ error: { message: 'Unauthorized.' } }, { status: 401 }) });
    const { receipt, outcome } = await run('aws-kimi-k3', scripted.fetch);
    expect(scripted.seen).toHaveLength(1);
    expect(receipt.checks.map((check) => [check.id, check.outcome, check.detail])).toEqual([
      ['short-answer', 'failed', 'AWS refused the key (HTTP 401).'],
      ['output-bound', 'not-run', 'Not run: AWS refused the key on the first check.'],
      ['tool-round-trip', 'not-run', 'Not run: AWS refused the key on the first check.'],
      ['cache-default', 'not-run', 'Not run: AWS refused the key on the first check.'],
      ['cache-off', 'unsupported', CACHE_OFF_UNSUPPORTED],
    ]);
    expect(outcome).toMatchObject({ spentMicroUsd: 0, uncertainMicroUsd: 0 });
  });

  it('never follows a redirect, and stops after a first check that answered with one', async () => {
    const scripted = provider({ intercept: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/openai/v1/chat/completions' } }) });
    const { receipt, outcome, plan } = await run('aws-kimi-k3', scripted.fetch);
    expect(scripted.seen.map((request) => [request.url, request.redirect]))
      .toEqual([['https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions', 'manual']]);
    expect(receipt.checks.map((check) => [check.id, check.outcome, check.detail])).toEqual([
      ['short-answer', 'failed', 'AWS answered with a redirect (HTTP 302). The gateway does not follow redirects.'],
      ['output-bound', 'not-run', 'Not run: AWS answered the first check with a redirect.'],
      ['tool-round-trip', 'not-run', 'Not run: AWS answered the first check with a redirect.'],
      ['cache-default', 'not-run', 'Not run: AWS answered the first check with a redirect.'],
      ['cache-off', 'unsupported', CACHE_OFF_UNSUPPORTED],
    ]);
    // A redirect is not a refusal the provider does not bill, so the call stays uncertain at its bound.
    expect(byId(receipt, 'short-answer').calls[0]).toMatchObject({ status: 302, ledger: { state: 'uncertain', microUsd: plan.shortAnswer.boundMicroUsd } });
    expect(outcome.uncertainMicroUsd).toBe(plan.shortAnswer.boundMicroUsd);
  });

  it('holds a call as uncertain when the connection broke after it was sent, and stops', async () => {
    let sends = 0;
    const broken = (async () => { sends++; throw new TypeError('The connection was reset.'); }) as typeof globalThis.fetch;
    const { receipt, outcome, plan } = await run('aws-kimi-k3', broken);
    expect(sends).toBe(1);
    expect(byId(receipt, 'short-answer')).toMatchObject({ outcome: 'failed', detail: 'No answer came back from AWS.' });
    expect(byId(receipt, 'short-answer').calls[0]).toMatchObject({ status: null, finish: 'error', ledger: { state: 'uncertain', microUsd: plan.shortAnswer.boundMicroUsd },
      error: { code: 'transport_failed', message: 'The request may have reached the provider, but no answer came back.' } });
    expect(byId(receipt, 'output-bound')).toMatchObject({ outcome: 'not-run', detail: 'Not run: no answer came back from AWS on the first check.' });
    expect(outcome.uncertainMicroUsd).toBe(plan.shortAnswer.boundMicroUsd);
  });

  it('gives up on a provider that stays silent past the time limit', async () => {
    const silent = (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted.', 'AbortError')), { once: true });
    })) as typeof globalThis.fetch;
    const { receipt, plan } = await run('aws-kimi-k3', silent, { idleTimeoutMs: 20 });
    expect(byId(receipt, 'short-answer')).toMatchObject({ outcome: 'failed', detail: 'AWS did not finish within the time limit.' });
    expect(byId(receipt, 'short-answer').calls[0]).toMatchObject({ error: { code: 'timeout' }, ledger: { state: 'uncertain', microUsd: plan.shortAnswer.boundMicroUsd } });
  });

  it('refuses an answer from a model the route does not name, through the gateway’s own stream check', async () => {
    const { receipt } = await run('aws-kimi-k3', provider({ intercept: ({ kind }) => kind === 'short-answer'
      ? chatCompletionsStream({ model: 'us.other.model', text: 'OK', usage: { input: 100, cacheRead: 0, output: 1, reasoning: 0 } }, { id: 'chatcmpl-other', created: AT / 1000 })
      : undefined }).fetch);
    expect(byId(receipt, 'short-answer')).toMatchObject({ outcome: 'failed', detail: 'AWS reported serving a model this route does not name.' });
    expect(byId(receipt, 'short-answer').calls[0]).toMatchObject({ error: { code: 'served_model_mismatch' }, ledger: { state: 'uncertain' } });
  });

  it('does not send a second tool call larger than the plan allowed for it', async () => {
    const padded = `{"key":"alpha"${' '.repeat(12_000)}}`;
    const scripted = provider({ intercept: ({ kind, body }) => kind === 'tool-ask'
      ? chatCompletionsStream({ model: String(body.model), tool: { callId: 'functions.lookup_fact:0', arguments: padded }, usage: { input: 300, cacheRead: 0, output: 400, reasoning: 12 } },
        { id: 'chatcmpl-padded', created: AT / 1000 })
      : undefined });
    const { receipt } = await run('aws-kimi-k3', scripted.fetch);
    expect(byId(receipt, 'tool-round-trip')).toMatchObject({ outcome: 'failed', detail: 'Asked for a tool call this check cannot accept.' });
    expect(byId(receipt, 'tool-round-trip').calls).toHaveLength(1);
    expect(receipt.verdicts.tools).toBe('failed');
    expect(scripted.seen).toHaveLength(5);
  });
});

describe('the gateway route checks on a GPT-6.1 Sol route over Azure Responses', () => {
  it('passes every check it can make with the deployment in the identity, and qualifies the route', async () => {
    const scripted = provider();
    const { route, connection, receipt, outcome } = await run('azure-sol-6-1', scripted.fetch);
    expect(receipt).toMatchObject({
      route: 'azure-openai', connectionId: 'azure-foundry-dev', connectionRevision: 1,
      endpoint: 'https://diomedes-foundry-dev-rg.services.ai.azure.com/openai/v1/responses',
      deployment: 'gpt-6.1-sol', model: 'gpt-6.1-sol', servedModels: ['gpt-6.1-sol'], protocol: 'openai-responses',
      verdicts: { answers: true, outputBound: 'bounded', tools: 'one-call', cacheDefault: 'caches', cacheOff: 'unsupported' },
    });
    expect(receiptQualifies(receipt, routeCheckIdentity(route, connection)!, AT)).toEqual({ ok: true });
    expect(scripted.seen).toHaveLength(6);
    for (const request of scripted.seen) {
      expect(request.url).toBe('https://diomedes-foundry-dev-rg.services.ai.azure.com/openai/v1/responses');
      expect(request.redirect).toBe('manual');
      expect(request.headers.get('api-key')).toBe(KEY);
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true, parallel_tool_calls: false, reasoning: { effort: 'low' } });
    }
    const [ask, answer] = [scripted.seen[2].body, scripted.seen[3].body];
    expect(ask.tools).toEqual([{ type: 'function', name: 'lookup_fact', description: 'Look up the value stored under one key.',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }]);
    const items = answer.input as Record<string, unknown>[];
    expect(items).toHaveLength(3);
    expect(items[1]).toEqual({ type: 'function_call', call_id: expect.stringMatching(/^call_/), name: 'lookup_fact', arguments: '{"key":"alpha"}' });
    expect(items[2]).toEqual({ type: 'function_call_output', call_id: items[1].call_id, output: JSON.stringify({ value: TOOL_VALUE }) });
    expect(outcome.spentMicroUsd).toBe(receipt.checks.flatMap((check) => check.calls).reduce((sum, call) => sum + usageCost(route.binding.price, call.usage!), 0));
  });

  it('reads an incomplete Responses answer at its output limit as bounded', async () => {
    const { receipt } = await run('azure-sol-6-1', provider({ intercept: ({ kind, body }) => kind === 'output-bound'
      ? responsesStream({ model: String(body.model), incomplete: true, usage: { input: 120, cacheRead: 0, output: 64, reasoning: 64 } },
        { id: 'resp_bound', created: AT / 1000, itemId: 'bound' })
      : undefined }).fetch);
    expect(byId(receipt, 'output-bound')).toMatchObject({ outcome: 'passed' });
    expect(byId(receipt, 'output-bound').calls[0]).toMatchObject({ finish: 'incomplete' });
    expect(receipt.verdicts.outputBound).toBe('bounded');
  });
});
