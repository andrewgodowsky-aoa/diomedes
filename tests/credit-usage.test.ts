/**
 * NC-2026-09-22.1 Phase C and G, the pure half: credits, the published grant
 * table, parent-job reservation decisions, usage from validated provider
 * reports, and the monthly usage projection.
 *
 * Every figure is a fixture or a published website anchor. Nothing here makes a
 * plan sellable, activates billing or approves a proposed number.
 */
import { describe, expect, test } from 'vitest';
import {
  CREDIT_MICRO_USD,
  MONTHLY_CREDIT_GRANTS,
  PROPOSED_DEFAULT_JOB_CAP_CREDITS,
  creditAmount,
  creditsFor,
  decideReserve,
  formatCredits,
  micro,
  projectUsage,
  publishedMonthlyGrant,
  usageCost,
  validateProviderUsage,
  type PeriodTotals,
  type RateSnapshot,
  type TopUpTotals,
} from '../shared/managed-usage';

const c = (credits: number) => creditAmount(credits);
const zeroTotals: PeriodTotals = {
  settledMonthlyMicroUsd: micro(0),
  pendingMonthlyMicroUsd: micro(0),
  uncertainMonthlyMicroUsd: micro(0),
  correctionGrantsMicroUsd: micro(0),
  correctionWithdrawalsMicroUsd: micro(0),
  settledTopUpMicroUsd: micro(0),
};
const noTopUp: TopUpTotals = {
  purchasedMicroUsd: micro(0),
  heldMicroUsd: micro(0),
  settledMicroUsd: micro(0),
};
const period = {
  periodId: '2026-10',
  planId: 'business',
  grantedMicroUsd: c(1000),
  startsAt: '2026-10-01T00:00:00.000Z',
  endsAt: '2026-11-01T00:00:00.000Z',
  rateCardVersion: 'rate-card-2026-09-10.1',
};
const project = (totals: Partial<PeriodTotals> = {}, topUp: Partial<TopUpTotals> = {}) =>
  projectUsage({
    organizationId: 'org_a',
    period,
    totals: { ...zeroTotals, ...totals },
    topUp: { ...noTopUp, ...topUp },
    lastReceipt: null,
    observedAt: '2026-10-15T12:00:00.000Z',
  });

describe('a credit is fractional money, never a call or a task', () => {
  test('one credit is the published $0.10 eligible-inference conversion', () => {
    expect(CREDIT_MICRO_USD).toBe(100_000);
    expect(creditAmount(1)).toBe(100_000);
    expect(creditAmount(0.5)).toBe(50_000);
    expect(creditsFor(micro(1_234_567))).toBeCloseTo(12.34567, 10);
  });

  test('a fraction finer than one micro-USD is refused, not rounded', () => {
    expect(() => creditAmount(0.0000001)).toThrow(RangeError);
    expect(() => creditAmount(-1)).toThrow(RangeError);
    expect(() => creditAmount(Number.NaN)).toThrow(RangeError);
  });

  test('a small non-zero amount is never shown as zero credits', () => {
    expect(formatCredits(micro(0))).toBe('0');
    expect(formatCredits(micro(1))).toBe('less than 0.01');
    expect(formatCredits(c(12.5))).toBe('12.5');
    expect(formatCredits(c(1000))).toBe('1,000');
    expect(formatCredits(micro(123_456_789))).toBe('1,234.57');
  });
});

describe('the published grant table keeps approval and proposal apart', () => {
  test('published grants are the website anchors and are totals, not additions', () => {
    expect(publishedMonthlyGrant('workflow-starter')).toBe(c(500));
    expect(publishedMonthlyGrant('business')).toBe(c(1000));
    expect(publishedMonthlyGrant('managed-small')).toBe(c(3000));
    expect(publishedMonthlyGrant('managed-standard')).toBe(c(5000));
    expect(publishedMonthlyGrant('managed-plus')).toBe(c(8000));
    // Managed Small is 3,000 in total, not Business's 1,000 plus 3,000.
    expect(publishedMonthlyGrant('managed-small')).not.toBe(c(4000));
  });

  test('Solo is directed but its grant is null; Business Plus stays a proposal', () => {
    const solo = MONTHLY_CREDIT_GRANTS.find((row) => row.planId === 'solo')!;
    expect(solo.status).toBe('directed-unapproved');
    expect(solo.monthlyCredits).toBeNull();
    expect(publishedMonthlyGrant('solo')).toBeNull();
    const plus = MONTHLY_CREDIT_GRANTS.find((row) => row.planId === 'business-plus')!;
    expect(plus.status).toBe('proposed');
    expect(publishedMonthlyGrant('business-plus')).toBeNull();
    expect(publishedMonthlyGrant('fractional-ai-ops')).toBeNull();
    expect(publishedMonthlyGrant('unknown-plan')).toBeNull();
  });

  test('no row is sellable, and no note equates a credit with a call or task', () => {
    for (const row of MONTHLY_CREDIT_GRANTS) {
      expect(row.sellable).toBe(false);
      expect(row.note).not.toMatch(/credit (is|equals|means) (one|a) (call|task|request)/i);
    }
  });

  test('the 20-credit job cap is recorded as a proposal, not applied', () => {
    expect(PROPOSED_DEFAULT_JOB_CAP_CREDITS).toEqual({ credits: 20, status: 'proposed' });
  });
});

describe('a reservation holds against the parent job and the month together', () => {
  const base = {
    maxMicroUsd: c(5),
    monthlyAvailableMicroUsd: c(100),
    topUpAvailableMicroUsd: micro(0),
    job: { capMicroUsd: c(20), usedMicroUsd: micro(0) },
  };

  test('the month pays first, then the top-up balance', () => {
    expect(decideReserve(base)).toEqual({ ok: true, monthlyHoldMicroUsd: c(5), topUpHoldMicroUsd: 0 });
    expect(
      decideReserve({ ...base, monthlyAvailableMicroUsd: c(2), topUpAvailableMicroUsd: c(10) }),
    ).toEqual({ ok: true, monthlyHoldMicroUsd: c(2), topUpHoldMicroUsd: c(3) });
  });

  test('the last credit cannot be held twice', () => {
    const refused = decideReserve({ ...base, monthlyAvailableMicroUsd: c(4) });
    expect(refused).toMatchObject({ ok: false, code: 'insufficient_allowance' });
  });

  test('the parent cap binds children and retries through the used figure', () => {
    const refused = decideReserve({ ...base, job: { capMicroUsd: c(20), usedMicroUsd: c(16) } });
    expect(refused).toMatchObject({ ok: false, code: 'cap_request_required' });
    expect(decideReserve({ ...base, job: { capMicroUsd: c(20), usedMicroUsd: c(15) } }).ok).toBe(true);
  });

  test('a ceiling that is not money is refused before any arithmetic', () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])
      expect(decideReserve({ ...base, maxMicroUsd: bad as never })).toMatchObject({
        ok: false,
        code: 'invalid_ceiling',
      });
    expect(decideReserve({ ...base, maxMicroUsd: micro(0) })).toMatchObject({
      ok: false,
      code: 'invalid_ceiling',
    });
  });
});

describe('usage settles from a validated provider report, never a guess', () => {
  const rate: RateSnapshot = {
    version: 'fixture-rate-1',
    inputMicroUsdPerMillion: 2_000_000, // $2 per million input tokens
    outputMicroUsdPerMillion: 8_000_000,
    cacheReadMicroUsdPerMillion: 200_000,
    cacheWriteMicroUsdPerMillion: 2_500_000,
  };

  test('complete usage is priced exactly, rounding up to the next micro-USD', () => {
    const usage = validateProviderUsage({
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 0,
      reasoningTokens: 20_000,
    });
    expect(usage.valid).toBe(true);
    if (!usage.valid) return;
    // 0.2 + 0.4 + 0.002 = $0.602; reasoning is inside output, not charged twice.
    expect(usageCost(rate, usage.usage)).toBe(602_000);
    expect(usageCost(rate, { ...usage.usage, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 })).toBe(2);
  });

  test('missing, negative or inconsistent usage is unknown consumption', () => {
    const complete = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    expect(validateProviderUsage({ ...complete, outputTokens: undefined }).valid).toBe(false);
    expect(validateProviderUsage({ ...complete, inputTokens: -1 }).valid).toBe(false);
    expect(validateProviderUsage({ ...complete, inputTokens: 1.5 }).valid).toBe(false);
    expect(validateProviderUsage({ ...complete, reasoningTokens: 5 }).valid).toBe(false);
    expect(validateProviderUsage(null).valid).toBe(false);
    expect(validateProviderUsage({ ...complete, extra: 1 }).valid).toBe(false);
  });
});

describe('the monthly usage projection', () => {
  test('settled 300 of a 1,000 grant is 30%', () => {
    const result = project({ settledMonthlyMicroUsd: c(300) });
    expect(result.usedPercent).toBe(30);
    expect(result.availableMicroUsd).toBe(c(700));
  });

  test('pending 100 and uncertain 50 are held separately and leave 550 available', () => {
    const result = project({
      settledMonthlyMicroUsd: c(300),
      pendingMonthlyMicroUsd: c(100),
      uncertainMonthlyMicroUsd: c(50),
    });
    expect(result.usedPercent).toBe(30);
    expect(result.pendingMicroUsd).toBe(c(100));
    expect(result.uncertainMicroUsd).toBe(c(50));
    expect(result.availableMicroUsd).toBe(c(550));
  });

  test('top-ups are a separate balance and never lower the monthly percentage', () => {
    const without = project({ settledMonthlyMicroUsd: c(300) });
    const withTopUp = project(
      { settledMonthlyMicroUsd: c(300), settledTopUpMicroUsd: c(40) },
      { purchasedMicroUsd: c(500), heldMicroUsd: c(10), settledMicroUsd: c(40) },
    );
    expect(withTopUp.usedPercent).toBe(without.usedPercent);
    expect(withTopUp.availableMicroUsd).toBe(without.availableMicroUsd);
    expect(withTopUp.topUp).toEqual({
      availableMicroUsd: c(450),
      heldMicroUsd: c(10),
      settledThisPeriodMicroUsd: c(40),
    });
  });

  test('a company-funded correction is its own line and does not rewrite usage', () => {
    const result = project({ settledMonthlyMicroUsd: c(300), correctionGrantsMicroUsd: c(10) });
    expect(result.usedPercent).toBe(30);
    expect(result.correctionsMicroUsd).toBe(c(10));
    expect(result.availableMicroUsd).toBe(c(710));
  });

  test('overspend is reported past 100% with a reconciliation note, never clamped', () => {
    const result = project({ settledMonthlyMicroUsd: c(1000), uncertainMonthlyMicroUsd: c(20) });
    expect(result.availableMicroUsd).toBe(0);
    expect(result.overspentMicroUsd).toBe(c(20));
    expect(result.reconciliation).toMatch(/reconcil/i);
    const over = project({ settledMonthlyMicroUsd: c(1100) });
    expect(over.usedPercent).toBe(110);
    expect(over.overspentMicroUsd).toBe(c(100));
  });

  test('a zero grant has no percentage rather than a division by zero', () => {
    const result = projectUsage({
      organizationId: 'org_a',
      period: { ...period, grantedMicroUsd: micro(0) },
      totals: zeroTotals,
      topUp: noTopUp,
      lastReceipt: null,
      observedAt: '2026-10-15T12:00:00.000Z',
    });
    expect(result.usedPercent).toBeNull();
  });

  test('reset time, timezone, freshness and the credit unit travel with the numbers', () => {
    const result = project();
    expect(result.resetsAt).toBe('2026-11-01T00:00:00.000Z');
    expect(result.timezone).toBe('UTC');
    expect(result.observedAt).toBe('2026-10-15T12:00:00.000Z');
    expect(result.microUsdPerCredit).toBe(CREDIT_MICRO_USD);
    expect(result.includedChat).toBeNull();
  });
});
