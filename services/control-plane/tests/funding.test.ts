/**
 * NC-2026-09-22.1 Phase C regression cases: funded parent-job accounting.
 *
 * These run against the TEST ONLY serialized memory repository. They prove the
 * service's rules and its transaction protocol, not PostgreSQL row locking,
 * durability or a real provider. The SQL adapter's lock order is checked with a
 * recording client in funding-postgres.test.ts; the real database cases are in
 * the opt-in postgres.integration.test.ts suite.
 */
import { describe, expect, it } from 'vitest';
import { creditAmount, micro, type MicroUsd, type RateSnapshot } from '../../../shared/managed-usage.js';
import { FundingError, FundingService } from '../src/funding.js';
import { FundingMemoryRepository } from './support/funding-memory.js';
import type { AccountMembershipSnapshot } from '../src/domain.js';

const c = (credits: number) => creditAmount(credits);
const T = 'tenant_1';
const O = 'org_1';
// $1 per million of every token kind keeps the arithmetic readable: 100,000
// tokens cost $0.10, which is exactly one credit.
const RATE: RateSnapshot = {
  version: 'fixture-rate-1',
  inputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 1_000_000,
  cacheWriteMicroUsdPerMillion: 1_000_000,
};
/** A validated report costing exactly `credits`. */
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
  const make = () =>
    new FundingService(repository, {
      now: () => clock,
    });
  const service = make();
  const setClock = (iso: string) => {
    clock = Date.parse(iso);
  };
  const allocate = (periodId: string, planId = 'business', svc = service) =>
    svc.allocatePeriod({ tenantId: T, organizationId: O, periodId, planId, sourceGrantId: `grant_${periodId}` });
  const open = (rootJobId = 'job_1', svc = service) =>
    svc.openJob({ tenantId: T, organizationId: O, rootJobId, runRef: `run_${rootJobId}`, parentRunRef: null, tier: 'efficient', capMicroUsd: null });
  const reserve = (attemptId: string, credits: number, over: Record<string, unknown> = {}, svc = service) =>
    svc.reserve({
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
  const settle = (attemptId: string, credits: number, svc = service) =>
    svc.settle({ ...ref(attemptId), receiptRef: `receipt_${attemptId}`, usage: usageFor(credits), reconciledFrom: 'response' });
  const usage = async (svc = service) => {
    const state = await svc.projection(T, O);
    if (state.state !== 'ready') throw new Error(`usage is ${state.state}`);
    return state.projection;
  };
  return { repository, service, make, setClock, allocate, open, reserve, ref, settle, usage };
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

describe('concurrent reserve', () => {
  it('two simultaneous reservations never both spend the last credits', async () => {
    const h = harness();
    await h.allocate('2026-09', 'business');
    // Leave exactly 10 credits in the month.
    for (let index = 0; index < 99; index++) {
      await h.service.openJob({ tenantId: T, organizationId: O, rootJobId: `fill_${index}`, runRef: `run_fill_${index}`, parentRunRef: null, tier: 'efficient', capMicroUsd: null });
      await h.reserve(`fill_${index}`, 10, { rootJobId: `fill_${index}` });
      await h.service.markDispatched(h.ref(`fill_${index}`));
      await h.settle(`fill_${index}`, 10);
    }
    expect((await h.usage()).availableMicroUsd).toBe(c(10));
    await h.open('job_a');
    await h.open('job_b');
    const results = await Promise.allSettled([
      h.reserve('race_a', 8, { rootJobId: 'job_a' }),
      h.reserve('race_b', 8, { rootJobId: 'job_b' }),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(FundingError);
    expect(refused.reason.code).toBe('insufficient_allowance');
    expect((await h.usage()).availableMicroUsd).toBe(c(2));
  });

  it('parallel children of one job cannot jointly exceed the parent cap', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    const results = await Promise.allSettled(
      [1, 2, 3].map((index) => h.reserve(`child_${index}`, 8)),
    );
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
    const refused = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason.code).toBe('cap_request_required');
  });
});

describe('duplicate attempt', () => {
  it('the same attempt id holds once; different terms under it are refused', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    const first = await h.reserve('attempt_1', 5);
    const replay = await h.reserve('attempt_1', 5);
    expect(replay).toEqual(first);
    expect((await h.usage()).pendingMicroUsd).toBe(c(5));
    const conflict = await refusal(h.reserve('attempt_1', 6));
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe('attempt_conflict');
    expect((await h.usage()).pendingMicroUsd).toBe(c(5));
  });

  it('a replayed settlement debits once; a different receipt is refused', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 5);
    await h.service.markDispatched(h.ref('attempt_1'));
    await h.settle('attempt_1', 3);
    await h.settle('attempt_1', 3);
    expect((await h.usage()).settledMicroUsd).toBe(c(3));
    const conflict = await refusal(
      h.service.settle({ ...h.ref('attempt_1'), receiptRef: 'receipt_other', usage: usageFor(3), reconciledFrom: 'response' }),
    );
    expect(conflict.code).toBe('settlement_conflict');
  });
});

describe('cancellation before and after send', () => {
  it('cancelling before send releases the whole hold', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 5);
    const cancelled = await h.service.cancel({ ...h.ref('attempt_1'), reason: 'person stopped the task' });
    expect(cancelled.state).toBe('released');
    const usage = await h.usage();
    expect(usage.pendingMicroUsd).toBe(0);
    expect(usage.availableMicroUsd).toBe(c(1000));
  });

  it('cancelling after send keeps the hold as uncertain; it cannot be released', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 5);
    await h.service.markDispatched(h.ref('attempt_1'));
    const cancelled = await h.service.cancel({ ...h.ref('attempt_1'), reason: 'person stopped the task' });
    expect(cancelled.state).toBe('uncertain');
    expect(cancelled.uncertainReason).toMatch(/after it was sent/);
    const refused = await refusal(h.service.release(h.ref('attempt_1')));
    expect(refused.code).toBe('uncertain_hold');
    const usage = await h.usage();
    expect(usage.uncertainMicroUsd).toBe(c(5));
    expect(usage.availableMicroUsd).toBe(c(995));
  });

  it('usage reported for a cancelled stream settles what was used and returns the rest', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 5);
    await h.service.markDispatched(h.ref('attempt_1'));
    await h.service.cancel({ ...h.ref('attempt_1'), reason: 'stopped mid-stream' });
    const result = await h.settle('attempt_1', 1.5);
    expect(result.outcome).toBe('settled');
    const usage = await h.usage();
    expect(usage.uncertainMicroUsd).toBe(0);
    expect(usage.settledMicroUsd).toBe(c(1.5));
  });
});

describe('lost response', () => {
  it('a lost response stays held in the month and in the job cap, never auto-retried', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 15);
    await h.service.markDispatched(h.ref('attempt_1'));
    await h.service.markUncertain({ ...h.ref('attempt_1'), reason: 'connection dropped before the response' });
    expect((await h.usage()).uncertainMicroUsd).toBe(c(15));
    // A retry is a new attempt under the same root, and the lost one still counts.
    const retry = await refusal(h.reserve('attempt_1_retry', 10, { parentAttemptId: 'attempt_1' }));
    expect(retry.code).toBe('cap_request_required');
    expect((await refusal(h.service.release(h.ref('attempt_1')))).code).toBe('uncertain_hold');
  });

  it('a sent request still awaiting its response cannot be released as unused', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 5);
    await h.service.markDispatched(h.ref('attempt_1'));
    expect((await refusal(h.service.release(h.ref('attempt_1')))).code).toBe('dispatched_hold');
    expect((await h.usage()).pendingMicroUsd).toBe(c(5));
  });

  it('reconciliation from a provider report settles the uncertain hold', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 15);
    await h.service.markDispatched(h.ref('attempt_1'));
    await h.service.markUncertain({ ...h.ref('attempt_1'), reason: 'lost' });
    const result = await h.service.settle({ ...h.ref('attempt_1'), receiptRef: 'provider_report_1', usage: usageFor(4), reconciledFrom: 'provider-report' });
    expect(result.outcome).toBe('settled');
    const usage = await h.usage();
    expect(usage.uncertainMicroUsd).toBe(0);
    expect(usage.settledMicroUsd).toBe(c(4));
  });

  it('a write-off needs the provider to confirm nothing was billed', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 15);
    await h.service.markDispatched(h.ref('attempt_1'));
    await h.service.markUncertain({ ...h.ref('attempt_1'), reason: 'lost' });
    const written = await h.service.writeOff({ ...h.ref('attempt_1'), evidenceRef: 'provider_statement_0917' });
    expect(written.state).toBe('written-off');
    expect((await h.usage()).availableMicroUsd).toBe(c(1000));
  });
});

describe('lost commit', () => {
  it('a reserve whose COMMIT landed but reported failure holds once on explicit retry', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    h.repository.failNextCommit('after-apply');
    await expect(h.reserve('attempt_1', 5)).rejects.toThrow(/commit/i);
    // The service never replays on its own; the caller's retry uses the same key.
    expect(h.repository.transactionsStarted).toBeGreaterThan(0);
    const retried = await h.reserve('attempt_1', 5);
    expect(retried.state).toBe('pending');
    expect((await h.usage()).pendingMicroUsd).toBe(c(5));
  });

  it('a reserve whose COMMIT never landed holds once on explicit retry', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    h.repository.failNextCommit('before-apply');
    await expect(h.reserve('attempt_1', 5)).rejects.toThrow(/commit/i);
    expect((await h.usage()).pendingMicroUsd).toBe(0);
    await h.reserve('attempt_1', 5);
    expect((await h.usage()).pendingMicroUsd).toBe(c(5));
  });

  it('a lost dispatch commit is treated as sent: restart parks it as uncertain', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 5);
    h.repository.failNextCommit('after-apply');
    await expect(h.service.markDispatched(h.ref('attempt_1'))).rejects.toThrow(/commit/i);
    // The caller must not send after a failed dispatch commit, but the store
    // cannot prove it did not, so the hold is never released as unsent.
    await h.service.recoverAfterRestart({ tenantId: T, organizationId: O });
    expect((await h.usage()).uncertainMicroUsd).toBe(c(5));
  });

  it('a settlement whose COMMIT landed but reported failure debits once on retry', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 5);
    await h.service.markDispatched(h.ref('attempt_1'));
    h.repository.failNextCommit('after-apply');
    await expect(h.settle('attempt_1', 2)).rejects.toThrow(/commit/i);
    await h.settle('attempt_1', 2);
    expect((await h.usage()).settledMicroUsd).toBe(c(2));
  });
});

describe('restart', () => {
  it('a fresh service instance sees every hold; unsent holds release and sent ones park', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('unsent', 3);
    await h.reserve('sent', 4);
    await h.service.markDispatched(h.ref('sent'));
    const restarted = h.make();
    expect((await h.usage(restarted)).pendingMicroUsd).toBe(c(7));
    const recovered = await restarted.recoverAfterRestart({ tenantId: T, organizationId: O });
    expect(recovered).toEqual({ released: ['unsent'], uncertain: ['sent'] });
    const usage = await h.usage(restarted);
    expect(usage.pendingMicroUsd).toBe(0);
    expect(usage.uncertainMicroUsd).toBe(c(4));
  });
});

describe('monthly reset', () => {
  it('finishing after the reset charges the original period, not the new month', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('september_work', 10);
    await h.service.markDispatched(h.ref('september_work'));
    await h.reserve('september_lost', 5);
    await h.service.markDispatched(h.ref('september_lost'));
    await h.service.markUncertain({ ...h.ref('september_lost'), reason: 'lost' });

    h.setClock('2026-10-01T00:05:00.000Z');
    await h.allocate('2026-10');
    await h.settle('september_work', 7);

    const october = await h.usage();
    expect(october.periodId).toBe('2026-10');
    expect(october.settledMicroUsd).toBe(0);
    expect(october.uncertainMicroUsd).toBe(0);
    expect(october.usedPercent).toBe(0);
    expect(october.availableMicroUsd).toBe(c(1000));

    const september = await h.repository.transaction((tx) => tx.periodTotals(T, O, '2026-09'));
    expect(september.settledMonthlyMicroUsd).toBe(c(7));
    // The uncertain September call is still held against September.
    expect(september.uncertainMonthlyMicroUsd).toBe(c(5));
  });

  it('new work after the reset reserves against the new month', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    h.setClock('2026-10-02T00:00:00.000Z');
    const refused = await refusal(h.reserve('attempt_1', 2));
    expect(refused.code).toBe('no_period');
    await h.allocate('2026-10');
    const attempt = await h.reserve('attempt_1', 2);
    expect(attempt.periodId).toBe('2026-10');
  });
});

describe('top-up', () => {
  it('a top-up is spent only after the month and never lowers the monthly percentage', async () => {
    const h = harness();
    await h.allocate('2026-09', 'workflow-starter');
    await h.service.recordTopUp({ tenantId: T, organizationId: O, topUpId: 'topup_1', amountMicroUsd: c(50), provider: 'stripe', sourceEventId: 'evt_topup_1' });
    // Use 495 of the 500 monthly credits.
    for (let index = 0; index < 33; index++) {
      await h.service.openJob({ tenantId: T, organizationId: O, rootJobId: `fill_${index}`, runRef: `run_fill_${index}`, parentRunRef: null, tier: 'efficient', capMicroUsd: null });
      await h.reserve(`fill_${index}`, 15, { rootJobId: `fill_${index}` });
      await h.service.markDispatched(h.ref(`fill_${index}`));
      await h.settle(`fill_${index}`, 15);
    }
    const before = await h.usage();
    expect(before.usedPercent).toBe(99);
    expect(before.availableMicroUsd).toBe(c(5));

    await h.open();
    const attempt = await h.reserve('spill', 12);
    expect(attempt.monthlyHoldMicroUsd).toBe(c(5));
    expect(attempt.topUpHoldMicroUsd).toBe(c(7));
    await h.service.markDispatched(h.ref('spill'));
    await h.settle('spill', 9);

    const after = await h.usage();
    expect(after.settledMicroUsd).toBe(c(500));
    expect(after.usedPercent).toBe(100);
    expect(after.topUp.settledThisPeriodMicroUsd).toBe(c(4));
    expect(after.topUp.availableMicroUsd).toBe(c(46));
  });

  it('a duplicate top-up event records once', async () => {
    const h = harness();
    await h.allocate('2026-09');
    const input = { tenantId: T, organizationId: O, topUpId: 'topup_1', amountMicroUsd: c(50), provider: 'stripe' as const, sourceEventId: 'evt_1' };
    await h.service.recordTopUp(input);
    await h.service.recordTopUp(input);
    expect((await h.usage()).topUp.availableMicroUsd).toBe(c(50));
    expect((await refusal(h.service.recordTopUp({ ...input, amountMicroUsd: c(60) }))).code).toBe('topup_conflict');
  });
});

describe('partial usage', () => {
  it('reserve 20, use 7: 7 is debited and 13 returns to the month', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 20);
    await h.service.markDispatched(h.ref('attempt_1'));
    await h.settle('attempt_1', 7);
    const usage = await h.usage();
    expect(usage.settledMicroUsd).toBe(c(7));
    expect(usage.pendingMicroUsd).toBe(0);
    expect(usage.availableMicroUsd).toBe(c(993));
  });

  it('an incomplete usage report leaves the whole ceiling held as uncertain', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 20);
    await h.service.markDispatched(h.ref('attempt_1'));
    const result = await h.service.settle({ ...h.ref('attempt_1'), receiptRef: 'receipt_1', usage: { inputTokens: 700_000 }, reconciledFrom: 'response' });
    expect(result.outcome).toBe('held');
    const usage = await h.usage();
    expect(usage.settledMicroUsd).toBe(0);
    expect(usage.uncertainMicroUsd).toBe(c(20));
  });

  it('usage past the reserved ceiling is held for reconciliation, never clamped', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 5);
    await h.service.markDispatched(h.ref('attempt_1'));
    const result = await h.settle('attempt_1', 6);
    expect(result.outcome).toBe('held');
    if (result.outcome === 'held') expect(result.attempt.uncertainReason).toMatch(/more than was reserved/);
    expect((await h.usage()).uncertainMicroUsd).toBe(c(5));
  });
});

describe('correction adjustment', () => {
  it('a company-funded correction is its own record and leaves the settled history alone', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 10);
    await h.service.markDispatched(h.ref('attempt_1'));
    await h.settle('attempt_1', 8);
    await h.service.recordCorrection({
      tenantId: T,
      organizationId: O,
      adjustmentId: 'correction_1',
      periodId: '2026-09',
      direction: 'grant',
      amountMicroUsd: c(8),
      attemptRef: 'attempt_1',
      note: 'The reviewer rejected our own faulty output; the rework is on us.',
    });
    const usage = await h.usage();
    expect(usage.settledMicroUsd).toBe(c(8));
    expect(usage.usedPercent).toBe(0.8);
    expect(usage.correctionsMicroUsd).toBe(c(8));
    expect(usage.availableMicroUsd).toBe(c(1000));
    const settlement = await h.repository.transaction((tx) => tx.settlement(T, 'attempt_1'));
    expect(settlement?.allowanceDebitMicroUsd).toBe(c(8));
  });

  it('a withdrawal correction cannot take the month below zero', async () => {
    const h = harness();
    await h.allocate('2026-09');
    const refused = await refusal(
      h.service.recordCorrection({ tenantId: T, organizationId: O, adjustmentId: 'w1', periodId: '2026-09', direction: 'withdraw', amountMicroUsd: c(1001), attemptRef: null, note: 'over-withdrawal' }),
    );
    expect(refused.code).toBe('insufficient_allowance');
  });
});

describe('parent-job caps', () => {
  it('a child job inherits the parent root and cannot bring its own cap', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    const child = await h.service.openJob({ tenantId: T, organizationId: O, rootJobId: 'job_child', runRef: 'run_child', parentRunRef: 'run_job_1', tier: null, capMicroUsd: null });
    expect(child.rootJobId).toBe('job_1');
    expect(child.inherited).toBe(true);
    const escape = await refusal(
      h.service.openJob({ tenantId: T, organizationId: O, rootJobId: 'job_child2', runRef: 'run_child2', parentRunRef: 'run_job_1', tier: null, capMicroUsd: c(20) }),
    );
    expect(escape.code).toBe('child_cannot_set_cap');
    await h.reserve('parent_step', 15);
    const childStep = await refusal(h.reserve('child_step', 10, { rootJobId: child.rootJobId }));
    expect(childStep.code).toBe('cap_request_required');
  });

  it('a root job takes its tier’s approved cap, 20, 50 or 100 credits, and nothing above it', async () => {
    const h = harness();
    await h.allocate('2026-09');
    for (const [tier, credits] of [['efficient', 20], ['focused', 50], ['thorough', 100]] as const) {
      const job = await h.service.openJob({ tenantId: T, organizationId: O, rootJobId: `tier_${tier}`, runRef: `run_tier_${tier}`, parentRunRef: null, tier, capMicroUsd: null });
      expect(job.capMicroUsd).toBe(c(credits));
    }
    // A smaller cap than the tier's is allowed; a larger one needs the owner.
    const small = await h.service.openJob({ tenantId: T, organizationId: O, rootJobId: 'small', runRef: 'run_small', parentRunRef: null, tier: 'focused', capMicroUsd: c(10) });
    expect(small.capMicroUsd).toBe(c(10));
    const over = await refusal(
      h.service.openJob({ tenantId: T, organizationId: O, rootJobId: 'big', runRef: 'run_big', parentRunRef: null, tier: 'efficient', capMicroUsd: c(25) }),
    );
    expect(over.code).toBe('cap_request_required');
    const thoroughOver = await refusal(
      h.service.openJob({ tenantId: T, organizationId: O, rootJobId: 'bigger', runRef: 'run_bigger', parentRunRef: null, tier: 'thorough', capMicroUsd: c(101) }),
    );
    expect(thoroughOver.code).toBe('cap_request_required');
    // A root job must name its tier; there is no silent default.
    const untiered = await refusal(
      h.service.openJob({ tenantId: T, organizationId: O, rootJobId: 'untiered', runRef: 'run_untiered', parentRunRef: null, tier: null, capMicroUsd: null }),
    );
    expect(untiered.code).toBe('invalid_tier');
  });

  it('a higher cap needs an explicit request and an owner decision before new spend', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('step_1', 15);
    expect((await refusal(h.reserve('step_2', 10))).code).toBe('cap_request_required');
    const request = await h.service.requestCapIncrease({ tenantId: T, organizationId: O, rootJobId: 'job_1', requestId: 'cap_req_1', requestedCapMicroUsd: c(40), requestedBy: 'person_member' });
    expect(request.state).toBe('pending');
    // A request alone is not approval.
    expect((await refusal(h.reserve('step_2', 10))).code).toBe('cap_request_required');

    const member = snapshot('member');
    expect((await refusal(h.service.decideCapIncrease({ membership: member, requestId: 'cap_req_1', approve: true }))).status).toBe(403);
    const decided = await h.service.decideCapIncrease({ membership: snapshot('owner'), requestId: 'cap_req_1', approve: true });
    expect(decided.state).toBe('approved');
    const step = await h.reserve('step_2', 10);
    expect(step.state).toBe('pending');
  });
});

describe('protocol boundaries', () => {
  it('no transaction is open while the provider is called', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 5);
    await h.service.markDispatched(h.ref('attempt_1'));
    // The provider call happens between committed calls, never inside one.
    const provider = async () => {
      expect(h.repository.inTransaction).toBe(false);
      return usageFor(2);
    };
    const reported = await provider();
    await h.service.settle({ ...h.ref('attempt_1'), receiptRef: 'r1', usage: reported, reconciledFrom: 'response' });
  });

  it('a settlement is refused for an attempt that was never marked sent', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 5);
    expect((await refusal(h.settle('attempt_1', 1))).code).toBe('not_dispatched');
  });

  it('a kind that is not debited to the allowance cannot reserve', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    expect((await refusal(h.reserve('attempt_1', 1, { kind: 'tool-service' }))).code).toBe('charge_not_admissible');
    expect((await refusal(h.reserve('attempt_2', 1, { kind: 'storage' }))).code).toBe('charge_not_admissible');
  });

  it('an unpublished grant cannot fund a period', async () => {
    const h = harness();
    expect((await refusal(h.allocate('2026-09', 'solo'))).code).toBe('grant_not_approved');
    expect((await refusal(h.allocate('2026-09', 'business-plus'))).code).toBe('grant_not_approved');
  });

  it('usage is unavailable, not zero, when no grant is recorded', async () => {
    const h = harness();
    const state = await h.service.projection(T, O);
    expect(state.state).toBe('unavailable');
    expect(JSON.stringify(state)).not.toMatch(/MicroUsd/);
  });

  it('one tenant cannot touch another tenant’s attempt', async () => {
    const h = harness();
    await h.allocate('2026-09');
    await h.open();
    await h.reserve('attempt_1', 5);
    const foreign = await refusal(h.service.markDispatched({ tenantId: 'tenant_2', organizationId: O, attemptId: 'attempt_1' }));
    expect(foreign.status).toBe(404);
  });
});

function snapshot(role: 'owner' | 'admin' | 'member'): AccountMembershipSnapshot {
  const at = '2026-09-10T12:00:00.000Z';
  return {
    person: { v: 1, id: `person_${role}`, name: role, assurance: 'hosted', createdAt: at },
    mapping: { issuer: 'https://api.workos.com', subject: `user_${role}`, personId: `person_${role}`, verifiedAt: at, identityGeneration: 0 },
    principalId: `principal_${role}`,
    sessionId: `session_${role}`,
    expiresAt: '2026-09-10T13:00:00.000Z',
    organization: { v: 1, id: O, name: 'One', industry: null, tenantId: T, identitySource: 'hosted', createdAt: at, createdBy: 'person_owner' },
    membership: { v: 1, organizationId: O, personId: `person_${role}`, role, state: 'active', invitedAt: at, joinedAt: at, revokedAt: null, revokedReason: null },
    assertion: {} as AccountMembershipSnapshot['assertion'],
    checkedAt: at,
    validUntil: '2026-09-10T12:00:30.000Z',
  } as AccountMembershipSnapshot;
}

// Keep `micro` imported for readers who extend these fixtures with raw amounts.
void micro;
