/**
 * What an evaluation costs, and what it costs when nobody knows.
 *
 * There is no token-to-money table anywhere else in this repository: every
 * figure the allowance ledger has ever seen was supplied by its caller. This is
 * the first one, so it is also the place to fix the rule that matters most —
 * an unpriced or unreported call is *unknown*, and unknown is not zero. A zero
 * that means "we did not measure" is indistinguishable on a screen from a zero
 * that means "this was free", and only one of those is true.
 *
 * Figures here are the provider's published rate as read on 2026-09-19. They
 * are dated and versioned for the same reason a rate card is: a charge keeps
 * the terms it was made under.
 */
import { describe, expect, test } from 'vitest';
import { MICRO_PER_USD } from '../shared/managed-usage.js';
import {
  EVALUATION_PRICE_JEV_113,
  estimateEvaluationCost,
  evaluationCost,
  type EvaluationPriceCard,
} from '../server/harness/evaluation-price.js';

const usage = (inputTokens: number | null, outputTokens: number | null = null) => ({
  inputTokens,
  outputTokens,
});

describe('the price card', () => {
  test('is versioned and dated, so a past charge keeps its own terms', () => {
    expect(EVALUATION_PRICE_JEV_113.version).toMatch(/^evaluation-price-\d{4}-\d{2}-\d{2}/);
    expect(Date.parse(EVALUATION_PRICE_JEV_113.effectiveFrom)).not.toBeNaN();
  });

  test('names the exact model it prices, not a moving alias', () => {
    expect(EVALUATION_PRICE_JEV_113.modelId).toBe('jev-1.13.0');
  });

  test('records the published rate: $0.042 per million input tokens, output free', () => {
    expect(EVALUATION_PRICE_JEV_113.inputMicroUsdPerMillion).toBe(42_000);
    expect(EVALUATION_PRICE_JEV_113.outputMicroUsdPerMillion).toBe(0);
  });
});

describe('a call whose usage the provider reported', () => {
  test('costs the published rate, in whole micro-USD', () => {
    // 1,000,000 input tokens at $0.042 per million is 42,000 micro-USD.
    const cost = evaluationCost(EVALUATION_PRICE_JEV_113, usage(1_000_000));
    expect(cost.known).toBe(true);
    if (cost.known) expect(cost.microUsd).toBe(42_000);
  });

  test('rounds up once at the end, never per token', () => {
    // 10 tokens is 0.42 micro-USD. Rounding each token up would give 10.
    const cost = evaluationCost(EVALUATION_PRICE_JEV_113, usage(10));
    expect(cost.known).toBe(true);
    if (cost.known) expect(cost.microUsd).toBe(1);
  });

  test('costs nothing for a call that used nothing', () => {
    const cost = evaluationCost(EVALUATION_PRICE_JEV_113, usage(0, 0));
    expect(cost.known).toBe(true);
    if (cost.known) expect(cost.microUsd).toBe(0);
  });

  test('charges nothing for output while the provider publishes it as free', () => {
    const withOutput = evaluationCost(EVALUATION_PRICE_JEV_113, usage(1_000, 50_000));
    const withoutOutput = evaluationCost(EVALUATION_PRICE_JEV_113, usage(1_000, 0));
    expect(withOutput).toEqual(withoutOutput);
  });

  test('a real preparation batch costs a fraction of a cent', () => {
    // 10,000 input tokens over a thread.
    const cost = evaluationCost(EVALUATION_PRICE_JEV_113, usage(10_000));
    expect(cost.known).toBe(true);
    if (cost.known) expect(cost.microUsd / MICRO_PER_USD).toBeCloseTo(0.00042, 8);
  });
});

describe('a call whose usage nobody knows', () => {
  test('costs an unknown amount, not zero, when input tokens were not reported', () => {
    const cost = evaluationCost(EVALUATION_PRICE_JEV_113, usage(null));
    expect(cost.known).toBe(false);
    if (!cost.known) expect(cost.reason).toMatch(/did not report/i);
  });

  test('costs an unknown amount when output is billable but unreported', () => {
    const billableOutput: EvaluationPriceCard = {
      ...EVALUATION_PRICE_JEV_113,
      version: 'evaluation-price-2026-09-19.test',
      outputMicroUsdPerMillion: 1_000,
    };
    const cost = evaluationCost(billableOutput, usage(100, null));
    expect(cost.known).toBe(false);
  });

  test('still costs a known amount when output is unreported but free', () => {
    // Output at zero cannot change the total, so not knowing it changes nothing.
    const cost = evaluationCost(EVALUATION_PRICE_JEV_113, usage(100, null));
    expect(cost.known).toBe(true);
  });

  test('costs an unknown amount when there is no price for the model at all', () => {
    const cost = evaluationCost(null, usage(1_000));
    expect(cost.known).toBe(false);
    if (!cost.known) expect(cost.reason).toMatch(/no published price/i);
  });
});

describe('the reservation taken before the call', () => {
  test('is a ceiling, so it is at least what the call turns out to cost', () => {
    const reserved = estimateEvaluationCost(EVALUATION_PRICE_JEV_113, { maxInputTokens: 10_000 });
    const actual = evaluationCost(EVALUATION_PRICE_JEV_113, usage(10_000));
    expect(reserved.known).toBe(true);
    if (reserved.known && actual.known) expect(reserved.microUsd).toBeGreaterThanOrEqual(actual.microUsd);
  });

  test('refuses to estimate without a bound, rather than guessing one', () => {
    expect(() => estimateEvaluationCost(EVALUATION_PRICE_JEV_113, { maxInputTokens: -1 })).toThrow();
  });

  test('is unknown when the model has no published price, so nothing is admitted on a guess', () => {
    expect(estimateEvaluationCost(null, { maxInputTokens: 10_000 }).known).toBe(false);
  });
});

describe('what the ledger is handed', () => {
  test('is always a safe integer of micro-USD', () => {
    for (const tokens of [1, 7, 999, 1_000_001, 64_000]) {
      const cost = evaluationCost(EVALUATION_PRICE_JEV_113, usage(tokens));
      expect(cost.known).toBe(true);
      if (cost.known) {
        expect(Number.isSafeInteger(cost.microUsd)).toBe(true);
        expect(cost.microUsd).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('carries the price version that produced it', () => {
    const cost = evaluationCost(EVALUATION_PRICE_JEV_113, usage(1_000));
    if (cost.known) expect(cost.priceVersion).toBe(EVALUATION_PRICE_JEV_113.version);
  });
});
