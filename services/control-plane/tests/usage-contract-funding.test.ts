/**
 * The funded ledger under nectovia-usage/1, the usage class on every attempt,
 * and the company's private provider-credit line.
 *
 * These run against the TEST ONLY serialized memory repository. They prove
 * policy: what is priced, what stays held, what is idempotent. They do not prove
 * durable crash recovery or cross-process concurrency; those need the opt-in
 * real-database suite (postgres.integration.test.ts), which needs a disposable
 * Postgres this workstation does not have.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { creditAmount, micro, type RateSnapshot, type UsageClass } from '../../../shared/managed-usage.js';
import { USAGE_CONTRACT_ID } from '../../../shared/usage-contract.js';
import { FundingError, FundingService } from '../src/funding.js';
import { confirmCreditApplication, providerCreditLine } from '../src/provider-credits.js';
import { FundingMemoryRepository } from './support/funding-memory.js';

const T = 'tenant_1';
const O = 'org_1';
const c = (credits: number) => creditAmount(credits);
// The worked example's rates: input $0.75/M, cache read $0.075/M, output $3.75/M.
const RATE: RateSnapshot = {
  version: 'worked-example',
  inputMicroUsdPerMillion: 750_000,
  cacheReadMicroUsdPerMillion: 75_000,
  cacheWriteMicroUsdPerMillion: 750_000,
  outputMicroUsdPerMillion: 3_750_000,
};
const WORKED = { inputTokens: 1_000, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 50 };
const RAW = { promptTokenCount: 1_000, cachedContentTokenCount: 800, candidatesTokenCount: 150, thoughtsTokenCount: 50 };

async function refusal(promise: Promise<unknown>): Promise<FundingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FundingError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

async function funded() {
  let clock = Date.parse('2026-09-10T12:00:00.000Z');
  const repository = new FundingMemoryRepository();
  const make = () => new FundingService(repository, { now: () => clock });
  const service = make();
  await service.allocatePeriod({ tenantId: T, organizationId: O, periodId: '2026-09', planId: 'business', sourceGrantId: 'grant_1' });
  await service.openJob({ tenantId: T, organizationId: O, rootJobId: 'job_1', runRef: 'run_job_1', parentRunRef: null, tier: 'focused', capMicroUsd: null });
  const ref = (attemptId: string) => ({ tenantId: T, organizationId: O, attemptId });
  const reserve = (attemptId: string, over: Partial<{ usageClass: UsageClass; parentAttemptId: string | null; maxMicroUsd: number }> = {}) =>
    service.reserve({
      tenantId: T, organizationId: O, attemptId, rootJobId: 'job_1', parentAttemptId: over.parentAttemptId ?? null,
      kind: 'generation', route: 'vertex', requestDigest: `digest_${attemptId}`, rateSnapshot: RATE,
      maxMicroUsd: micro(over.maxMicroUsd ?? c(1)), usageClass: over.usageClass ?? 'metered-work',
    });
  const sent = async (attemptId: string, over: Parameters<typeof reserve>[1] = {}) => {
    await reserve(attemptId, over);
    await service.markDispatched(ref(attemptId));
  };
  const usage = async () => {
    const state = await service.projection(T, O);
    if (state.state !== 'ready') throw new Error('no usage');
    return state.projection;
  };
  return { repository, service, make, ref, reserve, sent, usage, setClock: (iso: string) => (clock = Date.parse(iso)) };
}

describe('settlement consumes only the contract shape', () => {
  it('the worked example settles at exactly 960 micro-USD, with the raw evidence kept', async () => {
    const h = await funded();
    await h.sent('a1');
    const result = await h.service.settle({ ...h.ref('a1'), receiptRef: 'r1', usage: WORKED, raw: RAW, reconciledFrom: 'response' });
    expect(result.outcome).toBe('settled');
    if (result.outcome !== 'settled') return;
    expect(result.settlement.providerCostMicroUsd).toBe(960);
    expect(result.settlement.allowanceDebitMicroUsd).toBe(960);
    expect(result.settlement.usage).toEqual({ contract: USAGE_CONTRACT_ID, ...WORKED, raw: RAW });
  });

  it('fully cached, partly cached and uncached input price the cache once', async () => {
    const h = await funded();
    const cases = [
      { id: 'full', usage: { ...WORKED, cacheReadTokens: 1_000 }, cost: Math.ceil((1_000 * 75_000 + 200 * 3_750_000) / 1e6) },
      { id: 'part', usage: { ...WORKED, cacheReadTokens: 400 }, cost: Math.ceil((600 * 750_000 + 400 * 75_000 + 200 * 3_750_000) / 1e6) },
      { id: 'none', usage: { ...WORKED, cacheReadTokens: 0 }, cost: Math.ceil((1_000 * 750_000 + 200 * 3_750_000) / 1e6) },
    ];
    for (const item of cases) {
      await h.sent(item.id);
      const result = await h.service.settle({ ...h.ref(item.id), receiptRef: `r_${item.id}`, usage: item.usage, reconciledFrom: 'response' });
      expect(result.outcome === 'settled' && result.settlement.providerCostMicroUsd).toBe(item.cost);
    }
  });

  it('reasoning inside output is not charged again', async () => {
    const h = await funded();
    await h.sent('with');
    await h.sent('without');
    const a = await h.service.settle({ ...h.ref('with'), receiptRef: 'rw', usage: { ...WORKED, reasoningTokens: 150 }, reconciledFrom: 'response' });
    const b = await h.service.settle({ ...h.ref('without'), receiptRef: 'ro', usage: { ...WORKED, reasoningTokens: 0 }, reconciledFrom: 'response' });
    expect(a.outcome === 'settled' && b.outcome === 'settled' && a.settlement.providerCostMicroUsd === b.settlement.providerCostMicroUsd).toBe(true);
  });

  it('missing usage keeps the hold uncertain at its ceiling, never settled at zero', async () => {
    const h = await funded();
    await h.sent('lost');
    const result = await h.service.settle({ ...h.ref('lost'), receiptRef: 'r_lost', usage: undefined, reconciledFrom: 'response' });
    expect(result.outcome).toBe('held');
    expect((await h.usage()).uncertainMicroUsd).toBe(c(1));
    expect((await h.usage()).settledMicroUsd).toBe(0);
  });

  it('malformed counts keep the hold uncertain and are never clamped', async () => {
    const h = await funded();
    for (const [id, usage] of [
      ['neg', { ...WORKED, outputTokens: -1 }],
      ['frac', { ...WORKED, inputTokens: 10.5 }],
      ['parts', { ...WORKED, cacheReadTokens: 1_001 }],
      ['think', { ...WORKED, reasoningTokens: 201 }],
      ['extra', { ...WORKED, totalTokens: 1_200 }],
    ] as const) {
      await h.sent(id);
      const result = await h.service.settle({ ...h.ref(id), receiptRef: `r_${id}`, usage, reconciledFrom: 'response' });
      expect(result.outcome).toBe('held');
    }
    expect((await h.usage()).settledMicroUsd).toBe(0);
  });

  it('an interrupted stream with partial usage stays held and uncertain until the provider reports', async () => {
    const h = await funded();
    await h.sent('stream');
    await h.service.cancel({ ...h.ref('stream'), reason: 'stopped mid-stream' });
    const partial = { inputTokens: 1_000, cacheReadTokens: 800, outputTokens: 120 };
    const held = await h.service.settle({ ...h.ref('stream'), receiptRef: 'r_partial', usage: partial, reconciledFrom: 'response' });
    expect(held.outcome).toBe('held');
    expect((await h.usage()).uncertainMicroUsd).toBe(c(1));
    // The provider's own report later settles it exactly once.
    const settled = await h.service.settle({ ...h.ref('stream'), receiptRef: 'r_report', usage: WORKED, raw: RAW, reconciledFrom: 'provider-report' });
    expect(settled.outcome === 'settled' && settled.settlement.providerCostMicroUsd).toBe(960);
    expect((await h.usage()).uncertainMicroUsd).toBe(0);
  });

  it('a duplicate settlement is idempotent; a different report for the same attempt is refused', async () => {
    const h = await funded();
    await h.sent('dup');
    const first = await h.service.settle({ ...h.ref('dup'), receiptRef: 'r_dup', usage: WORKED, raw: RAW, reconciledFrom: 'response' });
    // Same receipt and counts, even with other raw evidence: the recorded settlement comes back.
    const again = await h.service.settle({ ...h.ref('dup'), receiptRef: 'r_dup', usage: WORKED, raw: { replay: true }, reconciledFrom: 'response' });
    expect(again).toEqual(first);
    expect((await h.usage()).settledMicroUsd).toBe(960);
    const conflict = await refusal(h.service.settle({ ...h.ref('dup'), receiptRef: 'r_dup', usage: { ...WORKED, outputTokens: 201 }, reconciledFrom: 'response' }));
    expect(conflict.code).toBe('settlement_conflict');
  });
});

describe('attempt identity: repeats, recovery and retries', () => {
  it('a repeated attempt id with the same terms returns the same hold, never a second one', async () => {
    const h = await funded();
    const one = await h.reserve('same');
    const two = await h.reserve('same');
    expect(two).toEqual(one);
    expect((await h.usage()).pendingMicroUsd).toBe(c(1));
    const different = await refusal(h.reserve('same', { usageClass: 'automation' }));
    expect(different.code).toBe('attempt_conflict');
  });

  it('a recovered attempt that was sent stays uncertain and is never replayed automatically', async () => {
    const h = await funded();
    await h.sent('sent_before_crash');
    await h.reserve('unsent_before_crash');
    const restarted = h.make();
    const recovered = await restarted.recoverAfterRestart({ tenantId: T, organizationId: O });
    expect(recovered).toEqual({ released: ['unsent_before_crash'], uncertain: ['sent_before_crash'] });
    // Reserving the same id again hands back the uncertain attempt; it is not sent again.
    const replay = await h.reserve('sent_before_crash');
    expect(replay.state).toBe('uncertain');
    expect((await refusal(restarted.markDispatched(h.ref('sent_before_crash')))).code).toBe('invalid_transition');
    expect((await h.usage()).uncertainMicroUsd).toBe(c(1));
  });

  it('a retry is a distinct attempt that spends from the same parent budget', async () => {
    const h = await funded();
    // Focused job: 50 credits. The lost first try still counts at its ceiling.
    await h.sent('try_1', { maxMicroUsd: c(30) });
    await h.service.markUncertain({ ...h.ref('try_1'), reason: 'connection dropped' });
    const retry = await h.reserve('try_2', { parentAttemptId: 'try_1', maxMicroUsd: c(20) });
    expect(retry.id).not.toBe('try_1');
    expect(retry.rootJobId).toBe('job_1');
    const over = await refusal(h.reserve('try_3', { parentAttemptId: 'try_1', maxMicroUsd: c(0.01) }));
    expect(over.code).toBe('cap_request_required');
  });
});

describe('usage class', () => {
  it('is required, recorded on every attempt, and changes no reservation decision', async () => {
    const h = await funded();
    const bad = await refusal(h.service.reserve({
      tenantId: T, organizationId: O, attemptId: 'noclass', rootJobId: 'job_1', parentAttemptId: null, kind: 'generation',
      route: 'vertex', requestDigest: 'd', rateSnapshot: RATE, maxMicroUsd: c(1), usageClass: 'premium' as UsageClass,
    }));
    expect(bad.code).toBe('invalid_usage_class');
    for (const usageClass of ['included-chat', 'metered-work', 'worker', 'automation'] as const) {
      const attempt = await h.reserve(`class_${usageClass}`, { usageClass });
      expect(attempt.usageClass).toBe(usageClass);
      expect(attempt.monthlyHoldMicroUsd).toBe(c(1));
    }
  });

  it('every class records its provider cost', async () => {
    const h = await funded();
    await h.sent('chat', { usageClass: 'included-chat' });
    const result = await h.service.settle({ ...h.ref('chat'), receiptRef: 'r_chat', usage: WORKED, reconciledFrom: 'response' });
    expect(result.outcome === 'settled' && result.settlement.providerCostMicroUsd).toBe(960);
  });
});

describe('the company provider-credit line is private and evidence-bound', () => {
  it('a promotion is never marked applied without billing evidence', () => {
    for (const evidence of [null, undefined, '', ' '])
      expect(() => confirmCreditApplication({ source: 'welcome-credit', amountMicroUsd: 1_000_000, billingEvidenceRef: evidence, confirmedAt: '2026-09-30T00:00:00Z' })).toThrow(/billing record/);
  });

  it('keeps gross cost, expected promotions, confirmed credit, customer debit and invoice as five facts', () => {
    const applied = confirmCreditApplication({ source: 'promotion', amountMicroUsd: 300_000, billingEvidenceRef: 'invoice-2026-09#line-4', confirmedAt: '2026-09-30T00:00:00Z' });
    const line = providerCreditLine({
      provider: 'vertex',
      periodId: '2026-09',
      estimatedGrossProviderCostMicroUsd: micro(1_000_000),
      expectedPromotionsMicroUsd: micro(900_000),
      confirmedCreditApplications: [applied],
      customerDebitMicroUsd: micro(1_200_000),
      customerInvoiceMicroUsd: micro(0),
    });
    expect(line.confirmedCreditAppliedMicroUsd).toBe(300_000);
    // The expected promotion never reduces the net; only confirmed credit does.
    expect(line.estimatedNetProviderCostMicroUsd).toBe(700_000);
    expect(line.expectedPromotionsMicroUsd).toBe(900_000);
    expect(line.customerDebitMicroUsd).toBe(1_200_000);
    expect(line.customerInvoiceMicroUsd).toBe(0);
    expect(Object.keys(line).some((key) => /secret|credential|key|account/i.test(key))).toBe(false);
  });

  it('shows confirmed credit beyond cost instead of pushing the net below zero', () => {
    const applied = confirmCreditApplication({ source: 'welcome-credit', amountMicroUsd: 5_000_000, billingEvidenceRef: 'credit-memo-77', confirmedAt: '2026-09-30T00:00:00Z' });
    const line = providerCreditLine({
      provider: 'vertex', periodId: '2026-09', estimatedGrossProviderCostMicroUsd: micro(1_000_000), expectedPromotionsMicroUsd: micro(0),
      confirmedCreditApplications: [applied], customerDebitMicroUsd: micro(0), customerInvoiceMicroUsd: micro(0),
    });
    expect(line.estimatedNetProviderCostMicroUsd).toBe(0);
    expect(line.confirmedCreditBeyondCostMicroUsd).toBe(4_000_000);
  });

  it('no customer-facing route reads it', async () => {
    const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(worker).not.toMatch(/provider-credits/);
  });
});
