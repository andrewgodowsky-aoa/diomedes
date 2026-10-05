/**
 * DIO-215: the scoped cache key, the three request shapes, where a breakpoint goes, the capability
 * record and its receipt overlay, and the run record's cache line. Pure functions and synthetic
 * receipts only; nothing here is sent anywhere.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { accountContext, withCacheSetting, type TurnCacheReport } from '../server/harness/context-assembly.js';
import { ModelApiError } from '../server/engines/model-api-core.js';
import * as aws from '../server/engines/aws-bedrock.js';
import { azureQualificationIdentity } from '../server/engines/azure-openai.js';
import {
  awsCapability,
  azureCapability,
  cacheKey,
  cacheRequestWithKey,
  routeCacheRequest,
  routeCapability,
} from '../server/engines/route-cache.js';
import { modelContextWindow } from '../shared/context-accounting.js';
import { declaredCapabilities, KIMI_K3_MODEL_CARD } from '../shared/declared-capabilities.js';
import {
  CACHE_KEY_MAX,
  CACHE_KEY_PATTERN,
  cacheAccount,
  cacheRequest,
  EXPLICIT_CACHE_TTL,
  routeCapabilitySchema,
  systemParts,
  type CacheAccount,
  type CacheKeyScope,
  type RouteCapability,
} from '../shared/route-capabilities.js';
import type { QualificationIdentity, RouteQualificationReceipt } from '../shared/route-qualification.js';
import { AZURE_CONNECTION, K3_CONNECTION, LUNA_CONNECTION, SCENARIO_NOW } from './fixtures/cache-body-scenarios.js';
import { passingReceipt } from './fixtures/route-qualification-receipts.js';

const NOW = SCENARIO_NOW.getTime();
const SCOPE: CacheKeyScope = {
  tenantId: 'local',
  route: 'aws-bedrock',
  connectionId: 'aws-bedrock-1',
  connectionRevision: 3,
  model: 'us.moonshotai.kimi-k3',
};
const K3_IDENTITY = aws.awsQualificationIdentity(K3_CONNECTION);
const DAY_MS = 86_400_000;
const receiptFor = (identity: QualificationIdentity, daysOld = 1) =>
  passingReceipt(
    { ...identity, endpoint: K3_CONNECTION.baseUrl, sdk: aws.AWS_BEDROCK_SDK },
    { createdAt: new Date(NOW - daysOld * DAY_MS) },
  );
const refusalOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelApiError);
    return error as ModelApiError;
  }
  throw new Error('Expected a refusal.');
};

describe('the cache key', () => {
  test('is dio1- and the first 40 hex digits of sha-256 over the scope’s canonical JSON', () => {
    const key = cacheKey(SCOPE);
    // Canonical JSON sorts keys; these five are strings and one integer, so this literal is it.
    const canonical = JSON.stringify({
      connectionId: SCOPE.connectionId,
      connectionRevision: SCOPE.connectionRevision,
      model: SCOPE.model,
      route: SCOPE.route,
      tenantId: SCOPE.tenantId,
    });
    expect(key).toBe(`dio1-${createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`);
    expect(key).toMatch(CACHE_KEY_PATTERN);
    expect(key.length).toBeLessThanOrEqual(CACHE_KEY_MAX);
  });

  test('every scope field changes it; field order and anything outside the scope do not', () => {
    const key = cacheKey(SCOPE);
    const changed = [
      { ...SCOPE, tenantId: 'org-tenant-7' },
      { ...SCOPE, route: 'azure-openai' },
      { ...SCOPE, connectionId: 'aws-bedrock-2' },
      { ...SCOPE, connectionRevision: 4 },
      { ...SCOPE, model: 'us.openai.gpt-5.6-luna' },
    ].map(cacheKey);
    expect(new Set([key, ...changed]).size).toBe(6);
    const reordered: CacheKeyScope = {
      model: SCOPE.model,
      connectionRevision: SCOPE.connectionRevision,
      connectionId: SCOPE.connectionId,
      route: SCOPE.route,
      tenantId: SCOPE.tenantId,
    };
    expect(cacheKey(reordered)).toBe(key);
    expect(cacheKey({ ...SCOPE, note: 'not part of the scope' } as CacheKeyScope)).toBe(key);
  });

  test('carries no part of its scope in clear', () => {
    const key = cacheKey({ ...SCOPE, tenantId: 'tenant-acme-bakery' });
    for (const part of ['tenant-acme-bakery', 'aws-bedrock', 'kimi', 'local']) expect(key).not.toContain(part);
  });

  test('the pattern admits only derived keys', () => {
    expect(CACHE_KEY_PATTERN.test(`dio1-${'a'.repeat(40)}`)).toBe(true);
    for (const bad of [`dio1-${'A'.repeat(40)}`, `dio1-${'a'.repeat(39)}`, `dio1-${'a'.repeat(41)}`, `dio2-${'a'.repeat(40)}`, 'tenant-acme'])
      expect(CACHE_KEY_PATTERN.test(bad), bad).toBe(false);
  });
});

describe('the request each setting sends', () => {
  const key = cacheKey(SCOPE);
  test('cacheRequest makes exactly three shapes', () => {
    expect(cacheRequest({ policy: 'provider-default' })).toEqual({ policy: 'provider-default', options: {}, breakpoint: null });
    expect(cacheRequest({ policy: 'off' })).toEqual({
      policy: 'off',
      options: { promptCacheOptions: { mode: 'explicit' } },
      breakpoint: null,
    });
    expect(cacheRequest({ policy: 'explicit-prefix', key })).toEqual({
      policy: 'explicit-prefix',
      options: { promptCacheKey: key, promptCacheOptions: { mode: 'explicit', ttl: EXPLICIT_CACHE_TTL } },
      breakpoint: { mode: 'explicit' },
    });
    expect(cacheRequest({ policy: 'explicit-prefix', key: 'tenant-acme' })).toBeNull();
  });

  test('the host derives the key from the whole scope, and only for an explicit prefix', () => {
    expect(routeCacheRequest('aws', 'provider-default', SCOPE)).toEqual(cacheRequest({ policy: 'provider-default' }));
    expect(routeCacheRequest('aws', 'off', SCOPE)).toEqual(cacheRequest({ policy: 'off' }));
    expect(routeCacheRequest('aws', 'explicit-prefix', SCOPE)).toEqual(cacheRequest({ policy: 'explicit-prefix', key }));
    // The other settings need no scope at all.
    expect(routeCacheRequest('azure', 'off', { ...SCOPE, tenantId: '' })).toEqual(cacheRequest({ policy: 'off' }));
  });

  test('a key that is not a derived key, or a scope with an empty part, is a refusal before anything is held', () => {
    for (const run of [
      () => cacheRequestWithKey('aws', 'explicit-prefix', 'tenant-acme'),
      () => cacheRequestWithKey('aws', 'explicit-prefix', `dio1-${'A'.repeat(40)}`),
      () => routeCacheRequest('aws', 'explicit-prefix', { ...SCOPE, tenantId: '' }),
      () => routeCacheRequest('aws', 'explicit-prefix', { ...SCOPE, connectionId: '' }),
      () => routeCacheRequest('aws', 'explicit-prefix', { ...SCOPE, connectionRevision: 0 }),
    ]) {
      const error = refusalOf(run);
      expect(error).toMatchObject({ code: 'aws_cache_refused', dispatched: false });
      expect(error.message).toBe('The cache key for this call could not be made.');
    }
    expect(refusalOf(() => cacheRequestWithKey('azure', 'explicit-prefix', 'x')).code).toBe('azure_cache_refused');
  });
});

describe('where a breakpoint goes', () => {
  const explicit = cacheRequest({ policy: 'explicit-prefix', key: cacheKey(SCOPE) })!;
  const prefix = 'Stable lines.\nMore stable lines.';
  const instructions = `${prefix}\n\nWhat this message adds.`;

  test('with no breakpoint the instructions are sent as one string, exactly', () => {
    for (const request of [cacheRequest({ policy: 'provider-default' })!, cacheRequest({ policy: 'off' })!])
      expect(systemParts(instructions, prefix, request, 'openai')).toEqual({ system: instructions, marked: null });
  });

  test('an explicit prefix marks the stable start as its own part, under the namespace given', () => {
    for (const namespace of ['openai', 'azure'] as const)
      expect(systemParts(instructions, prefix, explicit, namespace)).toEqual({
        system: [
          { role: 'system', content: prefix, providerOptions: { [namespace]: { promptCacheBreakpoint: { mode: 'explicit' } } } },
          { role: 'system', content: 'What this message adds.' },
        ],
        marked: 'stable-prefix',
      });
    expect(systemParts(prefix, prefix, explicit, 'openai')).toEqual({
      system: [{ role: 'system', content: prefix, providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } } }],
      marked: 'stable-prefix',
    });
  });

  test('with no stable prefix, or one the instructions do not start with, the whole text is marked', () => {
    const whole = {
      system: [{ role: 'system', content: instructions, providerOptions: { azure: { promptCacheBreakpoint: { mode: 'explicit' } } } }],
      marked: 'whole-instructions',
    };
    expect(systemParts(instructions, null, explicit, 'azure')).toEqual(whole);
    expect(systemParts(instructions, 'Some other start.', explicit, 'azure')).toEqual(whole);
  });
});

describe('the capability record', () => {
  test('Kimi K3 on AWS: the model card’s facts, each cited; what the card does not state is not known', () => {
    const record = routeCapability({ identity: K3_IDENTITY, endpoint: K3_CONNECTION.baseUrl, receipt: null, now: NOW });
    expect(routeCapabilitySchema.parse(record)).toEqual(record);
    const declared = (value: unknown) => ({ value, source: 'declared', evidence: KIMI_K3_MODEL_CARD });
    expect(record).toMatchObject({
      route: 'aws-bedrock',
      model: 'us.moonshotai.kimi-k3',
      protocol: 'openai-chat-completions',
      endpoint: K3_CONNECTION.baseUrl,
      contextTokens: declared(1_000_000),
      tools: declared(true),
      structuredOutput: declared(true),
      images: declared(true),
      cache: { byDefault: 'unknown', off: 'unknown', explicitPrefix: declared(true), minimumTokens: declared(1_024) },
      receiptId: null,
    });
    for (const fact of [record.outputTokens, record.parallelToolCalls, record.reasoning])
      expect(fact).toMatchObject({ value: null, source: 'not-known' });
    expect(KIMI_K3_MODEL_CARD).toBe(
      'AWS Bedrock model card for Kimi K3, https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k3.html, read 2026-10-05',
    );
  });

  test('Luna on AWS and every Azure deployment declare nothing', () => {
    expect(declaredCapabilities('aws-bedrock', aws.AWS_LUNA_MODEL)).toEqual({});
    for (const entry of AZURE_CONNECTION.deployments) expect(declaredCapabilities('azure-openai', entry.model)).toEqual({});
    const luna = routeCapability({
      identity: aws.awsQualificationIdentity(LUNA_CONNECTION),
      endpoint: LUNA_CONNECTION.baseUrl,
      receipt: null,
      now: NOW,
    });
    for (const fact of [luna.contextTokens, luna.outputTokens, luna.tools, luna.images, luna.reasoning, luna.cache.minimumTokens])
      expect(fact.source).toBe('not-known');
  });

  test('a receipt that qualifies this exact identity adds what it observed', () => {
    const receipt = receiptFor(K3_IDENTITY);
    const record = routeCapability({ identity: K3_IDENTITY, endpoint: K3_CONNECTION.baseUrl, receipt, now: NOW });
    const observed = { value: true, source: 'observed', evidence: `Route check ${receipt.id}, ${receipt.createdAt}.` };
    expect(record.tools).toEqual(observed);
    expect(record.reasoning).toEqual(observed);
    expect(record.cache).toMatchObject({ byDefault: 'no-cache-observed', off: 'verified' });
    expect(record.receiptId).toBe(receipt.id);
    // Windows and caching support stay declared: no route check measures them.
    expect(record.contextTokens.source).toBe('declared');
    expect(record.cache.explicitPrefix.source).toBe('declared');
  });

  test('a receipt for another revision, protocol or rate card, or an expired one, contributes nothing', () => {
    const bare = routeCapability({ identity: K3_IDENTITY, endpoint: K3_CONNECTION.baseUrl, receipt: null, now: NOW });
    const others: RouteQualificationReceipt[] = [
      receiptFor({ ...K3_IDENTITY, connectionRevision: K3_IDENTITY.connectionRevision - 1 }),
      receiptFor({ ...K3_IDENTITY, protocol: 'openai-responses' }),
      receiptFor({ ...K3_IDENTITY, rateCard: 'aws-bedrock-kimi-k3-us-standard-2026-09-01.1' }),
      // Receipts are valid for 30 days.
      receiptFor(K3_IDENTITY, 31),
    ];
    for (const receipt of others)
      expect(routeCapability({ identity: K3_IDENTITY, endpoint: K3_CONNECTION.baseUrl, receipt, now: NOW })).toEqual(bare);
  });

  test('the host reads the newest receipt for the connection’s model, or for one Azure deployment', async () => {
    const k3 = receiptFor(K3_IDENTITY);
    const asked: unknown[] = [];
    const store = {
      latest: async (...args: unknown[]) => {
        asked.push(args);
        return args[0] === 'aws-bedrock' ? k3 : null;
      },
    };
    expect((await awsCapability(store, K3_CONNECTION, NOW)).receiptId).toBe(k3.id);
    expect((await azureCapability(store, AZURE_CONNECTION, 'gpt-6-mini', NOW)).receiptId).toBeNull();
    expect(asked).toEqual([
      ['aws-bedrock', 'aws-bedrock-1', { model: 'us.moonshotai.kimi-k3', deployment: null }],
      ['azure-openai', 'azure-openai-1', { model: 'gpt-6-mini', deployment: 'mini-prod-eastus2' }],
    ]);
    expect(azureQualificationIdentity(AZURE_CONNECTION, 'gpt-6-mini').deployment).toBe('mini-prod-eastus2');
    expect((await awsCapability(undefined, K3_CONNECTION, NOW)).receiptId).toBeNull();
  });

  test('the K3 window reaches the context record with the same source', () => {
    expect(modelContextWindow('aws-bedrock', 'us.moonshotai.kimi-k3')).toEqual({ tokens: 1_000_000, source: KIMI_K3_MODEL_CARD });
    expect(modelContextWindow('aws-bedrock', aws.AWS_LUNA_MODEL)).toEqual({ tokens: null, source: 'not declared' });
  });
});

describe('the run record’s cache line', () => {
  const prefix = 'p'.repeat(2_000);
  const instructions = `${prefix}\n\nWhat this message adds.`;
  const account = (tools: readonly unknown[] = []) =>
    accountContext({
      route: 'aws-bedrock',
      model: 'us.moonshotai.kimi-k3',
      system: instructions,
      guidance: [],
      tools,
      parts: { history: '', files: '', message: 'Which deliveries arrived short?' },
      separatorBytes: 0,
      documents: 0,
      requestLimitBytes: 200_000,
      prefix: { sha: 'a'.repeat(64), bytes: prefix.length },
      previousPrefixSha: null,
      history: null,
      compaction: null,
    });
  const k3 = (receipt: RouteQualificationReceipt | null = null): RouteCapability =>
    routeCapability({ identity: K3_IDENTITY, endpoint: K3_CONNECTION.baseUrl, receipt, now: NOW });
  const report = (value: TurnCacheReport) => value;

  test('without a report the account is exactly as before, so older records read as they did', () => {
    const before = account();
    expect(withCacheSetting(before, null, { prefix, instructions })).toBe(before);
    expect(before.cache).toEqual({ support: 'automatic-prefix', note: expect.any(String) });
    expect(before.cache).not.toHaveProperty('policy');
  });

  test('each setting records its policy, whether off is verified, what was marked and cacheAccount’s note', () => {
    const verified = k3(receiptFor(K3_IDENTITY));
    const cases: [TurnCacheReport, CacheAccount][] = [
      [report({ policy: 'provider-default', record: null, marked: null }), cacheAccount('provider-default', null, null)],
      [report({ policy: 'off', record: verified, marked: null }), cacheAccount('off', verified, null)],
      [report({ policy: 'off', record: k3(), marked: null }), cacheAccount('off', k3(), null)],
    ];
    for (const [value, expected] of cases)
      expect(withCacheSetting(account(), value, { prefix, instructions }).cache).toEqual({ support: 'automatic-prefix', ...expected });
    expect(withCacheSetting(account(), cases[1][0], { prefix, instructions }).cache.offVerified).toBe(true);
    expect(withCacheSetting(account(), cases[2][0], { prefix, instructions }).cache.offVerified).toBe(false);
  });

  test('a marked start under the declared minimum says it is too short to be cached', () => {
    // 2,000 bytes is about 500 tokens by the estimator, under K3's declared 1,024.
    const short = withCacheSetting(account(), report({ policy: 'explicit-prefix', record: k3(), marked: 'stable-prefix' }), {
      prefix,
      instructions,
    }).cache;
    expect(short).toMatchObject({ policy: 'explicit-prefix', offVerified: null, marked: 'stable-prefix' });
    expect(short.note).toBe(
      `${cacheAccount('explicit-prefix', k3(), 'stable-prefix').note} The marked start is about 500 tokens, under this model’s minimum of 1,024 tokens for a cache checkpoint, so it is too short to be cached.`,
    );
    // The tool definitions come before the system text, so they count toward the marked start.
    const tools = [{ name: 'lookup_fact', description: 'x'.repeat(2_400), inputSchema: { type: 'object' } }];
    const long = withCacheSetting(account(tools), report({ policy: 'explicit-prefix', record: k3(), marked: 'stable-prefix' }), {
      prefix,
      instructions,
    }).cache;
    expect(long.note).toBe(cacheAccount('explicit-prefix', k3(), 'stable-prefix').note);
    // A model with no declared minimum gets no such sentence.
    const luna = routeCapability({ identity: aws.awsQualificationIdentity(LUNA_CONNECTION), endpoint: LUNA_CONNECTION.baseUrl, receipt: null, now: NOW });
    expect(
      withCacheSetting(account(), report({ policy: 'explicit-prefix', record: luna, marked: 'whole-instructions' }), { prefix, instructions })
        .cache.note,
    ).toBe(cacheAccount('explicit-prefix', luna, 'whole-instructions').note);
  });
});
