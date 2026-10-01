/**
 * B06 boundary matrix — deterministic rows not covered by funding.test.ts,
 * funding-dispatch-release.test.ts, funding-postgres.test.ts or the individual
 * funding suites.
 *
 * Rows exercised here (against the TEST ONLY serialized memory repository; the
 * service's rules and transaction protocol, not PostgreSQL):
 *   - withdraw-under-live-hold: a correction withdrawal is bounded by available
 *     credit *after* pending and uncertain holds are counted, so it cannot
 *     drain money a live hold still needs;
 *   - one-period-one-grant: re-allocating a month under its recorded grant is
 *     idempotent; a different grant or plan for that month is period_conflict;
 *   - mid-run rate change: each attempt prices its settlement under the rate
 *     snapshot it reserved with — a later snapshot never reprices it;
 *   - 200 racing reservations: the funded envelope is never over-admitted and
 *     every admitted attempt is unique and replayable;
 *   - the projection envelope balances across reserve/settle/uncertain/
 *     correction/top-up.
 */
import { describe, expect, it } from 'vitest';
import { creditAmount, micro, type FundedAttempt, type RateSnapshot } from '../../../shared/managed-usage.js';
import { FundingError, FundingService } from '../src/funding.js';
import { FundingMemoryRepository } from './support/funding-memory.js';

const c = (credits: number) => creditAmount(credits);
const T = 'tenant_b06';
const O = 'org_b06';
const RATE: RateSnapshot = {
  version: 'fixture-rate-1',
  inputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 1_000_000,
  cacheWriteMicroUsdPerMillion: 1_000_000,
};
const RATE_V2: RateSnapshot = { ...RATE, version: 'fixture-rate-2', inputMicroUsdPerMillion: 2_000_000 };
// One credit is $0.10: at $1/M input tokens, 100,000 tokens cost exactly one credit.
const usageFor = (credits: number) => ({
  inputTokens: credits * 100_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

function harness() {
  let clock = Date.parse('2026-09-10T12:00:00.000Z');
  const repository = new FundingMemoryRepository();
  const service = new FundingService(repository, { now: () => clock });
  const allocate = (periodId: string, planId = 'business', sourceGrantId = `grant_${periodId}`) =>
    service.allocatePeriod({ tenantId: T, organizationId: O, periodId, planId, sourceGrantId });
  const open = (rootJobId = 'job_1', cap: number | null = null, tier: 'efficient' | 'focused' | 'thorough' = 'thorough') =>
    service.openJob({ tenantId: T, organizationId: O, rootJobId, runRef: `run_${rootJobId}`, parentRunRef: null, tier, capMicroUsd: cap === null ? null : c(cap) });
  const reserve = (attemptId: string, credits: number, over: Record<string, unknown> = {}) =>
    service.reserve({
      tenantId: T,
      organizationId: O,
      attemptId,
      rootJobId: 'job_1',
      parentAttemptId: null,
      kind: 'generation',
      route: 'aws-bedrock',
      requestDigest: `digest_${attemptId}`,
      rateSnapshot: RATE,
      maxMicroUsd: c(credits),
      usageClass: 'metered-work',
      ...over,
    });
  const ref = (attemptId: string) => ({ tenantId: T, organizationId: O, attemptId });
  const settle = (attemptId: string, usage: unknown) =>
    service.settle({ ...ref(attemptId), receiptRef: `receipt_${attemptId}`, usage, reconciledFrom: 'response' });
  const usage = async () => {
    const state = await service.projection(T, O);
    if (state.state !== 'ready') throw new Error(`usage is ${state.state}`);
    return state.projection;
  };
  return { repository, service, allocate, open, reserve, ref, settle, usage };
}

async function refusal(promise: Promise<unknown>): Promise<FundingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FundingError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('correction bounds against live holds', () => {
  it('a withdraw correction is bounded by credit left after live holds, so it cannot drain one', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_hold', 10); // 10 pending of the 1000 granted.

    const over = await refusal(
      h.service.recordCorrection({
        tenantId: T,
        organizationId: O,
        adjustmentId: 'w_too_much',
        periodId: '2026-09',
        direction: 'withdraw',
        amountMicroUsd: c(991),
        attemptRef: null,
        note: 'Over-withdrawal while a hold is live.',
      }),
    );
    expect(over.code).toBe('insufficient_allowance');

    // The bound lands exactly at what the hold does not use.
    await h.service.recordCorrection({
      tenantId: T,
      organizationId: O,
      adjustmentId: 'w_exact',
      periodId: '2026-09',
      direction: 'withdraw',
      amountMicroUsd: c(990),
      attemptRef: null,
      note: 'Take everything the live hold does not need.',
    });
    expect((await h.usage()).availableMicroUsd).toBe(c(0));

    // The hold was never touched: it still settles against the month's money.
    await h.service.markDispatched(h.ref('attempt_hold'));
    const settled = await h.settle('attempt_hold', usageFor(10));
    expect(settled.outcome).toBe('settled');
    const usage = await h.usage();
    expect(usage.settledMicroUsd).toBe(c(10));
    expect(usage.availableMicroUsd).toBe(c(0));
    expect(usage.correctionWithdrawalsMicroUsd).toBe(c(990));
  });
});

describe('one period, one grant', () => {
  it('re-allocating a month under its recorded grant is idempotent; different funding conflicts', async () => {
    const h = harness();
    const first = await h.service.allocatePeriod({
      tenantId: T,
      organizationId: O,
      periodId: '2026-09',
      planId: 'business',
      sourceGrantId: 'grant_september',
    });

    const again = await h.service.allocatePeriod({
      tenantId: T,
      organizationId: O,
      periodId: '2026-09',
      planId: 'business',
      sourceGrantId: 'grant_september',
    });
    expect(again).toEqual(first);

    const differentGrant = await refusal(
      h.service.allocatePeriod({
        tenantId: T,
        organizationId: O,
        periodId: '2026-09',
        planId: 'business',
        sourceGrantId: 'grant_replacement',
      }),
    );
    expect(differentGrant.code).toBe('period_conflict');

    const differentPlan = await refusal(
      h.service.allocatePeriod({
        tenantId: T,
        organizationId: O,
        periodId: '2026-09',
        planId: 'managed-small',
        sourceGrantId: 'grant_september',
      }),
    );
    expect(differentPlan.code).toBe('period_conflict');
  });
});

describe('mid-run rate change', () => {
  it('an attempt settles under the rate snapshot it reserved with, never a later one', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open('job_1', 100);

    // attempt_old reserves under the v1 snapshot; attempt_new reserves under v2,
    // the rate card having moved between the two reserves.
    await h.reserve('attempt_old', 10, { rateSnapshot: RATE });
    await h.reserve('attempt_new', 10, { rateSnapshot: RATE_V2 });

    await h.service.markDispatched(h.ref('attempt_old'));
    await h.service.markDispatched(h.ref('attempt_new'));

    // Identical usage: 100k input tokens costs 1 credit under v1, 2 under v2.
    const usage = { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    const oldSettle = await h.settle('attempt_old', usage);
    const newSettle = await h.settle('attempt_new', usage);
    if (oldSettle.outcome !== 'settled' || newSettle.outcome !== 'settled')
      throw new Error('both attempts should settle');

    expect(oldSettle.settlement.providerCostMicroUsd).toBe(c(1));
    expect(newSettle.settlement.providerCostMicroUsd).toBe(c(2));
    // The stored snapshot governs: replaying old's usage under v2 would have cost 2.
    expect(oldSettle.settlement.allowanceDebitMicroUsd).toBe(c(1));
  });
});

describe('two hundred racing reservations', () => {
  it('admits only what the funded envelope allows, each admitted once', async () => {
    const h = harness();
    await h.allocate('2026-09'); // 1000 credits funded.
    // Twenty thorough jobs (cap 100 credits each) so the job cap never binds
    // before the funded envelope: the honest bound under test is the grant.
    for (let j = 0; j < 20; j++) await h.open(`job_${j}`, 100);

    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        h.service
          .reserve({
            tenantId: T,
            organizationId: O,
            attemptId: `attempt_${i}`,
            rootJobId: `job_${i % 20}`,
            parentAttemptId: null,
            kind: 'generation',
            route: 'aws-bedrock',
            requestDigest: `digest_${i}`,
            rateSnapshot: RATE,
            maxMicroUsd: c(10),
            usageClass: 'metered-work',
          })
          .then((attempt) => ({ ok: true as const, attempt }))
          .catch((error) => ({ ok: false as const, error })),
      ),
    );

    const admitted = results.filter((row): row is { ok: true; attempt: FundedAttempt } => row.ok);
    const refused = results.filter(
      (row): row is { ok: false; error: unknown } => !row.ok,
    );

    // The envelope admits exactly 100 ten-credit holds, never more.
    expect(admitted).toHaveLength(100);
    expect(refused).toHaveLength(100);
    for (const row of refused) {
      expect(row.error).toBeInstanceOf(FundingError);
      expect((row.error as FundingError).code).toBe('insufficient_allowance');
    }

    // Every admitted attempt is a distinct identity — no id was handed out twice.
    expect(new Set(admitted.map((row) => row.attempt.id)).size).toBe(100);

    const usage = await h.usage();
    expect(usage.pendingMicroUsd).toBe(c(1000));
    expect(usage.settledMicroUsd).toBe(0);
    expect(usage.availableMicroUsd).toBe(c(0));

    // Replay of any admitted attempt id returns the same hold, not a second debit.
    const replay = await h.service.reserve({
      tenantId: T,
      organizationId: O,
      attemptId: 'attempt_0',
      rootJobId: 'job_0',
      parentAttemptId: null,
      kind: 'generation',
      route: 'aws-bedrock',
      requestDigest: 'digest_0',
      rateSnapshot: RATE,
      maxMicroUsd: c(10),
      usageClass: 'metered-work',
    });
    expect(replay.id).toBe('attempt_0');
    expect((await h.usage()).pendingMicroUsd).toBe(c(1000));
  });
});

describe('projection envelope', () => {
  it('granted plus corrections equals settled plus pending plus uncertain plus available plus withdrawals', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open('job_1', 100);

    await h.reserve('attempt_settled', 20);
    await h.service.markDispatched(h.ref('attempt_settled'));
    await h.settle('attempt_settled', usageFor(7)); // settles 7, returns 13

    await h.reserve('attempt_pending', 10); // stays pending

    await h.reserve('attempt_uncertain', 5);
    await h.service.markDispatched(h.ref('attempt_uncertain'));
    const over = await h.settle('attempt_uncertain', usageFor(6)); // more than reserved
    expect(over.outcome).toBe('held');

    await h.service.recordCorrection({
      tenantId: T,
      organizationId: O,
      adjustmentId: 'adj_grant',
      periodId: '2026-09',
      direction: 'grant',
      amountMicroUsd: c(4),
      attemptRef: null,
      note: 'A good-faith grant for rework.',
    });
    await h.service.recordCorrection({
      tenantId: T,
      organizationId: O,
      adjustmentId: 'adj_withdraw',
      periodId: '2026-09',
      direction: 'withdraw',
      amountMicroUsd: c(2),
      attemptRef: null,
      note: 'Chargeback for a disputed line.',
    });

    const usage = await h.usage();
    // funded = 1000 granted + 4 grant-correction; committed = 2 withdrawn +
    // 7 settled + 10 pending + 5 uncertain; available is the remainder.
    expect(usage.settledMicroUsd).toBe(c(7));
    expect(usage.pendingMicroUsd).toBe(c(10));
    expect(usage.uncertainMicroUsd).toBe(c(5));
    expect(usage.availableMicroUsd).toBe(c(980));
    expect(usage.correctionsMicroUsd).toBe(c(4));
    expect(usage.correctionWithdrawalsMicroUsd).toBe(c(2));
    // Envelope: 1000 + 4 − 2 = 7 + 10 + 5 + 980.
    expect(usage.settledMicroUsd + usage.pendingMicroUsd + usage.uncertainMicroUsd + usage.availableMicroUsd).toBe(
      c(1004) - c(2),
    );
  });
});
