/**
 * Credit prices by tier (Model B): the charge snapshot, the ceiling, the hold and the display
 * arithmetic. Every price here is synthetic; no real price, ceiling or target is in this repository.
 */
import { describe, expect, it } from 'vitest';
import {
  ceilingFailures,
  chargeAsRoutingPrice,
  chargeHold,
  chargeSnapshot,
  checkCeiling,
  creditPriceTableSchema,
  providerCostPerCredit,
  publishCreditPricesInput,
  type CreditPriceTable,
  type PriceFields,
  type TierCharge,
} from '../shared/credit-prices.js';
import { CREDIT_MICRO_USD, usageCost } from '../shared/managed-usage.js';
import { routingPriceSchema } from '../shared/routing-policy.js';

// Synthetic: 10 credits per million input tokens, 50 per million output, and so on.
const CHARGE: TierCharge = {
  inputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 5_000_000,
  cacheReadMicroUsdPerMillion: 100_000,
  cacheWriteMicroUsdPerMillion: 1_250_000,
};
const TABLE: CreditPriceTable = {
  v: 1, version: 7, ceilingMicroUsdPerCredit: 50_000,
  tiers: { efficient: CHARGE, focused: { ...CHARGE, requestFeeMicroUsd: 400 }, thorough: null },
  note: 'Synthetic test table.', publishedAt: '2026-10-05T00:00:00.000Z', publishedBy: 'person_staff',
};
// Exactly at the ceiling for CHARGE: provider ≤ 50,000/100,000 × charge, i.e. half the charge.
const AT_CEILING: PriceFields = {
  inputMicroUsdPerMillion: 500_000,
  outputMicroUsdPerMillion: 2_500_000,
  cacheReadMicroUsdPerMillion: 50_000,
  cacheWriteMicroUsdPerMillion: 625_000,
};
const check = (price: PriceFields, charge: TierCharge = CHARGE, ceiling = 50_000) =>
  ceilingFailures({ tier: 'efficient', routeId: 'route-a', price, charge, ceilingMicroUsdPerCredit: ceiling });

describe('the charge snapshot', () => {
  it('copies a tier charge with the table version, the tier and the ceiling', () => {
    expect(chargeSnapshot(TABLE, 'efficient')).toEqual({
      version: 'credit-prices:7:efficient', tier: 'efficient', tableVersion: 7, ceilingMicroUsdPerCredit: 50_000, ...CHARGE,
    });
    expect(chargeSnapshot(TABLE, 'focused')?.requestFeeMicroUsd).toBe(400);
  });

  it('is null for a tier the table does not price, and for no table', () => {
    expect(chargeSnapshot(TABLE, 'thorough')).toBeNull();
    expect(chargeSnapshot(null, 'efficient')).toBeNull();
    expect(chargeSnapshot(undefined, 'focused')).toBeNull();
  });

  it('prices a debit through usageCost, rounded up once to a whole ledger unit', () => {
    const charge = chargeSnapshot(TABLE, 'efficient')!;
    // 1,000 fresh input at 1,000,000 per million is 1,000 units; 3 output at 5,000,000 per million is 15.
    expect(usageCost(charge, { inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0 })).toBe(1_015);
    // One cache read at 100,000 per million is 0.1 units; with the rest it rounds up once, never per class.
    expect(usageCost(charge, { inputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 })).toBe(2);
    expect(Number.isInteger(usageCost(charge, { inputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1, outputTokens: 11, reasoningTokens: 5 }))).toBe(true);
    expect(usageCost(chargeSnapshot(TABLE, 'focused')!, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 })).toBe(400);
  });
});

describe('the ceiling', () => {
  it('passes a route exactly at the ceiling in every class, and fails it one unit over', () => {
    expect(check(AT_CEILING)).toEqual([]);
    expect(checkCeiling({ tier: 'efficient', routeId: 'route-a', price: AT_CEILING, charge: CHARGE, ceilingMicroUsdPerCredit: 50_000 })).toEqual({ ok: true });
    for (const [key, tokenClass] of [['inputMicroUsdPerMillion', 'input'], ['outputMicroUsdPerMillion', 'output'],
      ['cacheReadMicroUsdPerMillion', 'cacheRead'], ['cacheWriteMicroUsdPerMillion', 'cacheWrite']] as const) {
      const over = { ...AT_CEILING, [key]: AT_CEILING[key] + 1 };
      const failures = check(over);
      expect(failures.map(f => f.tokenClass)).toContain(tokenClass);
      expect(failures[0]).toMatchObject({ tier: 'efficient', routeId: 'route-a', aboveInputTokens: null });
      expect(failures[0].message).toContain('route-a');
      expect(failures[0].message).toContain('Efficient');
    }
  });

  it('checks reasoning at its own price, and at output when either side leaves it unset', () => {
    expect(check({ ...AT_CEILING, reasoningMicroUsdPerMillion: 2_500_001 }).map(f => f.tokenClass)).toEqual(['reasoning']);
    // The charge prices reasoning below output: a route reasoning at its output price is now over.
    expect(check(AT_CEILING, { ...CHARGE, reasoningMicroUsdPerMillion: 4_000_000 }).map(f => f.tokenClass)).toEqual(['reasoning']);
    expect(check({ ...AT_CEILING, reasoningMicroUsdPerMillion: 2_000_000 }, { ...CHARGE, reasoningMicroUsdPerMillion: 4_000_000 })).toEqual([]);
  });

  it('checks the request fee, naming it', () => {
    expect(check({ ...AT_CEILING, requestFeeMicroUsd: 1 }).map(f => f.tokenClass)).toEqual(['requestFee']);
    expect(check({ ...AT_CEILING, requestFeeMicroUsd: 200 }, { ...CHARGE, requestFeeMicroUsd: 400 })).toEqual([]);
    const [failure] = check({ ...AT_CEILING, requestFeeMicroUsd: 201 }, { ...CHARGE, requestFeeMicroUsd: 400 });
    expect(failure).toMatchObject({ tokenClass: 'requestFee', aboveInputTokens: null });
    expect(failure.message).toContain('per-request fee');
  });

  it('checks every long-context breakpoint from the route\'s band list', () => {
    const band = { ...AT_CEILING, aboveInputTokens: 200_000 };
    expect(check({ ...AT_CEILING, longContext: [band] })).toEqual([]);
    const failures = check({ ...AT_CEILING, longContext: [{ ...band, outputMicroUsdPerMillion: 2_500_001 }] });
    // Reasoning is priced at output where the band leaves it unset, so it is over there too.
    expect(failures.map(f => [f.tokenClass, f.aboveInputTokens])).toEqual([['output', 200_000], ['reasoning', 200_000]]);
    expect(failures[0]).toMatchObject({ tier: 'efficient', routeId: 'route-a' });
    expect(failures[0].message).toContain('above 200,000 input tokens');
  });

  it('checks every long-context breakpoint from the charge\'s band list', () => {
    // The charge gets cheaper above 100,000 input tokens; the route's price there is now over.
    const cheaper = { ...CHARGE, longContext: [{ ...CHARGE, aboveInputTokens: 100_000, inputMicroUsdPerMillion: 900_000 }] };
    const failures = check(AT_CEILING, cheaper);
    expect(failures.map(f => [f.tokenClass, f.aboveInputTokens])).toEqual([['input', 100_000]]);
  });

  it('compares the bands that apply in each region when the two lists differ', () => {
    // Route raises input above 50,000; charge raises input above 150,000. Between them the route is over.
    const route = { ...AT_CEILING, longContext: [{ ...AT_CEILING, aboveInputTokens: 50_000, inputMicroUsdPerMillion: 900_000 }] };
    const charge = { ...CHARGE, longContext: [{ ...CHARGE, aboveInputTokens: 150_000, inputMicroUsdPerMillion: 1_800_000 }] };
    expect(check(route, charge).map(f => [f.tokenClass, f.aboveInputTokens])).toEqual([['input', 50_000]]);
    // A band without a request fee prices none there, as usageCost does.
    expect(check({ ...AT_CEILING, requestFeeMicroUsd: 1, longContext: [{ ...AT_CEILING, aboveInputTokens: 10 }] }, CHARGE)
      .map(f => [f.tokenClass, f.aboveInputTokens])).toEqual([['requestFee', null]]);
  });

  it('uses integers only, so a ceiling one unit lower turns a pass into a fail', () => {
    expect(check(AT_CEILING, CHARGE, 49_999).length).toBeGreaterThan(0);
    expect(check({ inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1, cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0 },
      { inputMicroUsdPerMillion: 2, outputMicroUsdPerMillion: 2, cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0 })).toEqual([]);
    expect(check({ inputMicroUsdPerMillion: 2, outputMicroUsdPerMillion: 1, cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0 },
      { inputMicroUsdPerMillion: 3, outputMicroUsdPerMillion: 2, cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0 }).map(f => f.tokenClass)).toEqual(['input']);
  });
});

describe('the hold and the display', () => {
  it('holds the dearest input-side price for the whole input bound, the dearer of output and reasoning, rounded up once, and the request fee', () => {
    const charge = { ...CHARGE, reasoningMicroUsdPerMillion: 6_000_000, requestFeeMicroUsd: 400 };
    // 1,000 × 1,250,000 (cache write is dearest) + 10 × 6,000,000, over a million, rounded up: 1,310; plus the fee.
    expect(chargeHold(charge, 1_000, 10)).toBe(1_310 + 400);
    expect(chargeHold(CHARGE, 1, 0)).toBe(2);
  });

  it('holds the dearest band the input bound can reach, and never one it cannot', () => {
    const banded = { ...CHARGE, longContext: [{ ...CHARGE, aboveInputTokens: 1_000, inputMicroUsdPerMillion: 3_000_000 }] };
    expect(chargeHold(banded, 1_000, 0)).toBe(chargeHold(CHARGE, 1_000, 0));
    expect(chargeHold(banded, 1_001, 0)).toBe(Math.ceil(1_001 * 3_000_000 / 1_000_000));
  });

  it('is never less than what any usage inside the bounds is debited', () => {
    const charge = chargeSnapshot(TABLE, 'focused')!;
    const hold = chargeHold(charge, 5_000, 2_000);
    for (const usage of [
      { inputTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 5_000, outputTokens: 2_000, reasoningTokens: 2_000 },
      { inputTokens: 5_000, cacheReadTokens: 5_000, cacheWriteTokens: 0, outputTokens: 2_000, reasoningTokens: 0 },
      { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 },
    ]) expect(usageCost(charge, usage)).toBeLessThanOrEqual(hold);
  });

  it('shows provider cost per credit charged, rounded up to a whole micro-USD', () => {
    expect(providerCostPerCredit(3, CREDIT_MICRO_USD)).toBe(3);
    expect(providerCostPerCredit(1, 3)).toBe(Math.ceil(CREDIT_MICRO_USD / 3));
    expect(providerCostPerCredit(5, 0)).toBeNull();
    expect(() => providerCostPerCredit(1.5, 10)).toThrow(RangeError);
  });

  it('writes a charge in the routing snapshot\'s price shape, which the installed desktop reads unchanged', () => {
    const charge = chargeSnapshot({ ...TABLE, tiers: { ...TABLE.tiers, thorough: { ...CHARGE, longContext: [{ ...CHARGE, aboveInputTokens: 9 }] } } }, 'thorough')!;
    const price = routingPriceSchema.parse(chargeAsRoutingPrice(charge, TABLE.publishedAt));
    expect(price).toMatchObject({ version: 'credit-prices:7:thorough', inputMicroUsdPerMillion: 1_000_000,
      reasoningMicroUsdPerMillion: 5_000_000, requestFeeMicroUsd: 0 });
    expect(price.longContext[0]).toMatchObject({ aboveInputTokens: 9, reasoningMicroUsdPerMillion: 5_000_000, requestFeeMicroUsd: 0 });
  });
});

describe('the table schema', () => {
  const input = { baseVersion: 0, ceilingMicroUsdPerCredit: 50_000, tiers: { efficient: CHARGE, focused: null, thorough: null }, note: 'Synthetic.' };
  it('takes whole units only, and a ceiling no higher than the ledger scale', () => {
    expect(publishCreditPricesInput.safeParse(input).success).toBe(true);
    expect(publishCreditPricesInput.safeParse({ ...input, tiers: { ...input.tiers, efficient: { ...CHARGE, inputMicroUsdPerMillion: 1.5 } } }).success).toBe(false);
    expect(publishCreditPricesInput.safeParse({ ...input, ceilingMicroUsdPerCredit: CREDIT_MICRO_USD + 1 }).success).toBe(false);
    expect(publishCreditPricesInput.safeParse({ ...input, ceilingMicroUsdPerCredit: 0 }).success).toBe(false);
    expect(publishCreditPricesInput.safeParse({ ...input, tiers: { ...input.tiers, efficient: { ...CHARGE, outputMicroUsdPerMillion: 0 } } }).success).toBe(false);
    expect(publishCreditPricesInput.safeParse({ ...input, tiers: { efficient: CHARGE } }).success).toBe(false);
    expect(creditPriceTableSchema.safeParse(TABLE).success).toBe(true);
  });
});
