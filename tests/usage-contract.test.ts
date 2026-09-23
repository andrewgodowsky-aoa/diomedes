/**
 * nectovia-usage/1: the one usage shape and the one boundary that admits a
 * report into it. Pure fixtures; no provider, no ledger file, no network.
 */
import { describe, expect, test } from 'vitest';
import {
  MAX_TOKENS_PER_FIELD,
  USAGE_CONTRACT_ID,
  USAGE_COUNT_FIELDS,
  freshInputTokens,
  isNormalizedUsage,
  normalizeUsage,
  sameUsageCounts,
} from '../shared/usage-contract';
import {
  USAGE_CLASSES,
  isUsageClass,
  usageCost,
  validateProviderUsage,
  type RateSnapshot,
} from '../shared/managed-usage';
import { usageCost as ledgerUsageCost, type ModelRateCard } from '../server/spend-exposure';
import { chatUsage } from '../server/engines/openrouter';
import { providerUsage } from '../server/engines/model-api-core';

/** USD per million tokens, as the worked example states them. */
const RATE: RateSnapshot = {
  version: 'worked-example',
  inputMicroUsdPerMillion: 750_000,
  cacheReadMicroUsdPerMillion: 75_000,
  cacheWriteMicroUsdPerMillion: 750_000,
  outputMicroUsdPerMillion: 3_750_000,
};

const counts = (over: Partial<Record<(typeof USAGE_COUNT_FIELDS)[number], number>> = {}) => ({
  inputTokens: 1_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 200,
  reasoningTokens: 0,
  ...over,
});

/** The Vertex route's mapping, exactly as its owner described it. */
function vertex(meta: {
  promptTokenCount: number;
  toolUsePromptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount: number;
  thoughtsTokenCount?: number;
}) {
  return normalizeUsage(
    {
      inputTokens: meta.promptTokenCount + (meta.toolUsePromptTokenCount ?? 0),
      cacheReadTokens: meta.cachedContentTokenCount ?? 0,
      cacheWriteTokens: 0,
      outputTokens: meta.candidatesTokenCount + (meta.thoughtsTokenCount ?? 0),
      reasoningTokens: meta.thoughtsTokenCount ?? 0,
    },
    meta,
  );
}

describe('the contract id and its meaning', () => {
  test('is nectovia-usage/1 and every normalized record carries it', () => {
    expect(USAGE_CONTRACT_ID).toBe('nectovia-usage/1');
    const evidence = normalizeUsage(counts());
    expect(evidence.state).toBe('known');
    if (evidence.state === 'known') {
      expect(evidence.usage.contract).toBe('nectovia-usage/1');
      expect(isNormalizedUsage(evidence.usage)).toBe(true);
    }
  });

  test('a report that names another contract is refused, not reinterpreted', () => {
    expect(normalizeUsage({ ...counts(), contract: 'nectovia-usage/0' }).state).toBe('refused');
    expect(normalizeUsage({ ...counts(), contract: USAGE_CONTRACT_ID }).state).toBe('known');
  });
});

describe('the worked example prices exactly', () => {
  test('1,000 prompt tokens with 800 cached, 150 candidates and 50 thoughts cost 960 micro-USD', () => {
    const evidence = vertex({ promptTokenCount: 1_000, cachedContentTokenCount: 800, candidatesTokenCount: 150, thoughtsTokenCount: 50 });
    expect(evidence.state).toBe('known');
    if (evidence.state !== 'known') return;
    expect(evidence.usage).toMatchObject({ inputTokens: 1_000, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 50 });
    expect(freshInputTokens(evidence.usage)).toBe(200);
    // 200 x 0.75 + 800 x 0.075 + 200 x 3.75 = 150 + 60 + 750.
    expect(usageCost(RATE, evidence.usage)).toBe(960);
    // The raw provider object travels beside the counts, unchanged.
    expect(evidence.usage.raw).toEqual({ promptTokenCount: 1_000, cachedContentTokenCount: 800, candidatesTokenCount: 150, thoughtsTokenCount: 50 });
  });

  test('the local ledger prices the same usage identically: one meaning, two ledgers', () => {
    const card: ModelRateCard = {
      version: 'worked-example',
      route: 'vertex',
      modelId: 'fixture',
      source: 'fixture',
      shortContextMaxInputTokens: 1_000_000,
      short: { input: 750_000, cacheRead: 75_000, cacheWrite: 750_000, output: 3_750_000 },
      long: { input: 750_000, cacheRead: 75_000, cacheWrite: 750_000, output: 3_750_000 },
    };
    const usage = { inputTokens: 1_000, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 50 };
    expect(ledgerUsageCost(card, usage).microUsd).toBe(usageCost(RATE, usage));
  });
});

describe('cache and reasoning are parts, never extra', () => {
  test('uncached: every input token is fresh', () => {
    expect(usageCost(RATE, counts())).toBe(Math.ceil((1_000 * 750_000 + 200 * 3_750_000) / 1e6));
  });

  test('partly cached: the cached part is priced at the cache rate and not again as input', () => {
    const usage = counts({ cacheReadTokens: 400 });
    expect(usageCost(RATE, usage)).toBe(Math.ceil((600 * 750_000 + 400 * 75_000 + 200 * 3_750_000) / 1e6));
  });

  test('fully cached: no fresh input remains', () => {
    const usage = counts({ cacheReadTokens: 1_000 });
    expect(freshInputTokens(usage)).toBe(0);
    expect(usageCost(RATE, usage)).toBe(Math.ceil((1_000 * 75_000 + 200 * 3_750_000) / 1e6));
  });

  test('cache writes are a part of input too, at their own rate', () => {
    const rate = { ...RATE, cacheWriteMicroUsdPerMillion: 937_500 };
    expect(usageCost(rate, counts({ cacheReadTokens: 300, cacheWriteTokens: 500 }))).toBe(
      Math.ceil((200 * 750_000 + 300 * 75_000 + 500 * 937_500 + 200 * 3_750_000) / 1e6),
    );
  });

  test('reasoning is inside output and priced once', () => {
    expect(usageCost(RATE, counts({ reasoningTokens: 150 }))).toBe(usageCost(RATE, counts()));
  });

  test('before the contract, the funded ledger charged cached tokens twice', () => {
    const usage = counts({ cacheReadTokens: 800 });
    const doubleCounted = Math.ceil((1_000 * 750_000 + 800 * 75_000 + 200 * 3_750_000) / 1e6);
    expect(usageCost(RATE, usage)).toBeLessThan(doubleCounted);
    expect(doubleCounted - usageCost(RATE, usage)).toBe(600);
  });
});

describe('missing is unknown, wrong is refused, nothing is clamped', () => {
  test('no report at all is unknown, never zero', () => {
    for (const value of [undefined, null]) {
      const evidence = normalizeUsage(value);
      expect(evidence.state).toBe('unknown');
    }
  });

  test('a report missing any count is unknown, whatever the others say', () => {
    for (const field of USAGE_COUNT_FIELDS) {
      const partial: Record<string, unknown> = counts();
      delete partial[field];
      expect(normalizeUsage(partial).state).toBe('unknown');
    }
  });

  test('negative, fractional, unsafe and implausible counts are refused', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, MAX_TOKENS_PER_FIELD + 1, '10'])
      expect(normalizeUsage({ ...counts(), outputTokens: bad }).state).toBe('refused');
  });

  test('parts larger than their whole are refused rather than trimmed', () => {
    expect(normalizeUsage(counts({ cacheReadTokens: 700, cacheWriteTokens: 301 })).state).toBe('refused');
    expect(normalizeUsage(counts({ reasoningTokens: 201 })).state).toBe('refused');
  });

  test('a field this contract does not define is refused', () => {
    expect(normalizeUsage({ ...counts(), totalTokens: 1_200 }).state).toBe('refused');
  });

  test('raw evidence that is not plain JSON is refused rather than dropped silently', () => {
    expect(normalizeUsage(counts(), [1, 2]).state).toBe('refused');
    expect(normalizeUsage(counts(), { at: new Date() }).state).toBe('refused');
    expect(normalizeUsage(counts(), { big: 'x'.repeat(20_000) }).state).toBe('refused');
  });

  test('validateProviderUsage is the contract, and says whether a report was missing or wrong', () => {
    const missing = validateProviderUsage(undefined);
    expect(missing).toMatchObject({ valid: false, unknown: true });
    const wrong = validateProviderUsage(counts({ reasoningTokens: 999 }));
    expect(wrong).toMatchObject({ valid: false, unknown: false });
    const right = validateProviderUsage(counts(), { provider: 'fixture' });
    expect(right.valid && right.usage.raw).toEqual({ provider: 'fixture' });
  });

  test('two reports of the same call compare by their counts alone', () => {
    const a = normalizeUsage(counts(), { id: 'a' });
    const b = normalizeUsage(counts(), { id: 'b' });
    expect(a.state === 'known' && b.state === 'known' && sameUsageCounts(a.usage, b.usage)).toBe(true);
  });
});

describe('route mappings go through the one boundary', () => {
  test('the Vertex mapping, tool-use prompt included, normalizes as its owner described', () => {
    const evidence = vertex({ promptTokenCount: 900, toolUsePromptTokenCount: 100, cachedContentTokenCount: 800, candidatesTokenCount: 150, thoughtsTokenCount: 50 });
    expect(evidence.state === 'known' && evidence.usage).toMatchObject({ inputTokens: 1_000, cacheReadTokens: 800, outputTokens: 200, reasoningTokens: 50 });
  });

  test('a Vertex report with more cached than prompted is refused', () => {
    expect(vertex({ promptTokenCount: 100, cachedContentTokenCount: 200, candidatesTokenCount: 1 }).state).toBe('refused');
  });

  test('Responses and chat-completions usage map to the same counts and refuse the same inconsistencies', () => {
    expect(providerUsage({ input_tokens: 1_000, output_tokens: 200, input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 50 } }))
      .toEqual({ inputTokens: 1_000, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 50 });
    expect(providerUsage({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 11 } })).toBeNull();
    expect(chatUsage({ prompt_tokens: 1_000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 800 } }).usage)
      .toEqual({ inputTokens: 1_000, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 0 });
    expect(chatUsage({ prompt_tokens: 1, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 2 } }).usage).toBeNull();
  });
});

describe('usage classes', () => {
  test('four classes are named and none implies a debit rule', () => {
    expect(USAGE_CLASSES).toEqual(['included-chat', 'metered-work', 'worker', 'automation']);
    expect(isUsageClass('included-chat')).toBe(true);
    expect(isUsageClass('premium')).toBe(false);
  });
});
