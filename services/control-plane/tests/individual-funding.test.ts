import { describe, expect, it } from 'vitest';
import { FundingService } from '../src/funding.js';
import { FundingMemoryRepository } from './support/funding-memory.js';
import { micro } from '../../../shared/managed-usage.js';
import { individualCycle } from '../../../shared/individual-period.js';

const person = 'person_individual', account = 'individual_billing';
const allocation = { tenantId: person, organizationId: account, planId: 'individual', sourceGrantId: 'grant_person', periodId: '2026-09' };
const rate = { version: 'fixture', inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0 };

describe('Individual funding in the existing ledger', () => {
  it('allocates exactly 1,000 credits once per UTC month, including concurrent retries and a lost commit response', async () => {
    const repo = new FundingMemoryRepository();
    const funding = new FundingService(repo, { now: () => Date.parse('2026-09-29T00:00:00Z') });
    repo.failNextCommit('after-apply');
    await expect(funding.allocatePeriod(allocation)).rejects.toThrow('commit outcome');
    const rows = await Promise.all(Array.from({ length: 6 }, () => funding.allocatePeriod(allocation)));
    expect(rows.every(row => row.grantedMicroUsd === 100_000_000)).toBe(true);
    expect(repo.snapshot().periods).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: person, organizationId: account, sourceGrantId: 'grant_person',
      startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-10-01T00:00:00.000Z' });
    await funding.allocatePeriod({ ...allocation, periodId: '2026-10' });
    expect(repo.snapshot().periods.map(row => row.grantedMicroUsd)).toEqual([100_000_000, 100_000_000]);
    await expect(funding.allocatePeriod({ ...allocation, sourceGrantId: 'replacement_grant' })).rejects.toMatchObject({ code: 'period_conflict' });
    expect(repo.snapshot().periods[0]).toMatchObject({ sourceGrantId: 'grant_person', grantedMicroUsd: 100_000_000 });
  });

  it('expires unused credits and resets the next month to 0% used without carrying any balance forward', async () => {
    const repo = new FundingMemoryRepository();
    let clock = Date.parse('2026-09-30T23:59:59Z');
    const funding = new FundingService(repo, { now: () => clock });
    await funding.allocatePeriod(allocation);
    await funding.openJob({ tenantId: person, organizationId: account, rootJobId: 'new-month', runRef: 'new-month', parentRunRef: null, tier: 'efficient', capMicroUsd: null });
    clock = Date.parse('2026-10-01T00:00:01Z');
    const attempt = { tenantId: person, organizationId: account, attemptId: 'new-month', rootJobId: 'new-month', parentAttemptId: null,
      kind: 'generation' as const, route: 'route', requestDigest: 'new-month', rateSnapshot: rate,
      maxMicroUsd: micro(100_000_001), usageClass: 'metered-work' as const };
    // Last month's unused 1,000 credits cannot fund even one new request.
    await expect(funding.reserve(attempt)).rejects.toMatchObject({ code: 'no_period' });
    await funding.allocatePeriod({ ...allocation, periodId: '2026-10' });
    expect(await funding.projection(person, account)).toMatchObject({ state: 'ready', projection: {
      periodId: '2026-10', usedPercent: 0, availableMicroUsd: 100_000_000 } });
    await expect(funding.reserve(attempt)).rejects.toMatchObject({ code: 'insufficient_allowance' });
    expect(await funding.reserve({ ...attempt, maxMicroUsd: micro(100_000) })).toMatchObject({ periodId: '2026-10', monthlyHoldMicroUsd: 100_000 });
    expect(repo.snapshot().periods).toHaveLength(2); // Past records remain evidence, never spendable credit.
  });

  it('settles a late response against the original person account and expired month without moving or replenishing spending', async () => {
    const repo = new FundingMemoryRepository();
    let clock = Date.parse('2026-09-30T23:59:59Z');
    const funding = new FundingService(repo, { now: () => clock });
    await funding.allocatePeriod(allocation);
    await funding.openJob({ tenantId: person, organizationId: account, rootJobId: 'job', runRef: 'job', parentRunRef: null, tier: 'efficient', capMicroUsd: null });
    const input = { tenantId: person, organizationId: account, attemptId: 'attempt', rootJobId: 'job', parentAttemptId: null,
      kind: 'generation' as const, route: 'route', requestDigest: 'digest', rateSnapshot: rate,
      maxMicroUsd: micro(200_000), usageClass: 'metered-work' as const };
    const held = await funding.reserve(input);
    await funding.markDispatched(input);
    clock = Date.parse('2026-10-01T00:00:01Z');
    await funding.allocatePeriod({ ...allocation, periodId: '2026-10' });
    const settlement = { ...input, receiptRef: 'receipt', usage: { inputTokens: 100_000, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, reconciledFrom: 'response' as const };
    const result = await funding.settle(settlement);
    expect(result).toMatchObject({ outcome: 'settled', settlement: { tenantId: person, organizationId: account,
      periodId: '2026-09', allowanceDebitMicroUsd: 100_000 } });
    expect(await funding.settle(settlement)).toEqual(result);
    expect(await funding.reserve(input)).toMatchObject({ periodId: held.periodId, state: 'settled' });
    await expect(funding.settle({ ...settlement, organizationId: 'org_business' })).rejects.toMatchObject({ code: 'unknown_attempt' });
    await expect(funding.settle({ ...settlement, tenantId: 'other_person' })).rejects.toMatchObject({ code: 'unknown_attempt' });
    expect(repo.snapshot().settlements).toHaveLength(1);
    expect(repo.snapshot().periods).toHaveLength(2);
  });
});

describe('Individual anniversary terms in the existing ledger (DIO-128)', () => {
  const anchor = '2026-09-30T15:00:00.000Z';
  const first = individualCycle(anchor, 0), second = individualCycle(anchor, 1);
  const term = { tenantId: person, organizationId: account, sourceGrantId: 'grant_term', cycle: first };
  const hold = (id: string, cycle = first, max = 200_000) => ({ tenantId: person, organizationId: account, attemptId: id, rootJobId: 'job',
    parentAttemptId: null, kind: 'generation' as const, route: 'route', requestDigest: id, rateSnapshot: rate,
    maxMicroUsd: micro(max), usageClass: 'metered-work' as const, individualCycle: cycle });
  const usage = { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  async function opened(clock: { at: number }) {
    const repo = new FundingMemoryRepository();
    const funding = new FundingService(repo, { now: () => clock.at });
    await funding.openJob({ tenantId: person, organizationId: account, rootJobId: 'job', runRef: 'job', parentRunRef: null, tier: 'efficient', capMicroUsd: null });
    return { repo, funding };
  }

  it('records exactly one 1,000-credit row per term under concurrent retries and a lost commit, whichever grant asks', async () => {
    const clock = { at: Date.parse('2026-10-01T00:00:00Z') };
    const { repo, funding } = await opened(clock);
    repo.failNextCommit('after-apply');
    await expect(funding.allocateIndividualPeriod(term)).rejects.toThrow('commit outcome');
    const rows = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      funding.allocateIndividualPeriod({ ...term, sourceGrantId: index % 2 ? 'grant_term' : 'grant_replacement' })));
    expect(repo.snapshot().periods).toEqual([{ tenantId: person, organizationId: account, periodId: 'individual:2026-09-30T15:00:00.000Z',
      planId: 'individual', rateCardVersion: expect.any(String), grantedMicroUsd: 100_000_000, startsAt: first.startsAt, endsAt: first.endsAt,
      sourceGrantId: 'grant_term', allocatedAt: '2026-10-01T00:00:00.000Z' }]);
    expect(rows.every(row => row.sourceGrantId === 'grant_term')).toBe(true); // The historical source is never rewritten.
  });

  it('does not reset on October 1 for a September 30 subscriber, and starts the verified next term at 0% with no carryover', async () => {
    const clock = { at: Date.parse('2026-09-30T16:00:00Z') };
    const { repo, funding } = await opened(clock);
    await funding.allocateIndividualPeriod(term);
    await funding.reserve(hold('a'));
    clock.at = Date.parse('2026-10-01T00:00:01Z');
    // Still the September 30 term: no calendar month is looked up, and nothing new is recorded.
    expect(await funding.reserve(hold('b'))).toMatchObject({ periodId: 'individual:2026-09-30T15:00:00.000Z' });
    await expect(funding.reserve({ ...hold('c'), individualCycle: undefined })).rejects.toMatchObject({ code: 'no_period' });
    expect(await funding.individualProjection(person, account, first)).toMatchObject({ state: 'ready',
      projection: { periodId: 'individual:2026-09-30T15:00:00.000Z', resetsAt: '2026-10-30T15:00:00.000Z', allocation: 'recorded', pendingMicroUsd: 400_000 } });
    // At the anniversary the old term funds nothing new, and the next term is its own 1,000 credits.
    clock.at = Date.parse('2026-10-30T15:00:00Z');
    await expect(funding.reserve(hold('d'))).rejects.toMatchObject({ code: 'period_ended' });
    await expect(funding.allocateIndividualPeriod(term)).resolves.toMatchObject({ periodId: 'individual:2026-09-30T15:00:00.000Z' });
    await expect(funding.reserve(hold('e', second))).rejects.toMatchObject({ code: 'no_period' });
    expect(await funding.individualProjection(person, account, second)).toMatchObject({ state: 'ready',
      projection: { allocation: 'pending', grantedMicroUsd: 100_000_000, usedPercent: 0, availableMicroUsd: 100_000_000, resetsAt: '2026-11-30T15:00:00.000Z' } });
    expect(repo.snapshot().periods).toHaveLength(1); // The read wrote nothing.
    await funding.allocateIndividualPeriod({ ...term, cycle: second });
    await expect(funding.reserve(hold('f', second, 100_000_001))).rejects.toMatchObject({ code: 'insufficient_allowance' });
    expect(await funding.reserve(hold('g', second))).toMatchObject({ periodId: 'individual:2026-10-30T15:00:00.000Z' });
    expect(repo.snapshot().periods.map(row => row.grantedMicroUsd)).toEqual([100_000_000, 100_000_000]);
  });

  it('never records an elapsed, future or overlapping term', async () => {
    const clock = { at: Date.parse('2026-11-05T00:00:00Z') };
    const { repo, funding } = await opened(clock);
    await expect(funding.allocateIndividualPeriod(term)).rejects.toMatchObject({ code: 'period_not_current' });
    await expect(funding.allocateIndividualPeriod({ ...term, cycle: individualCycle(anchor, 2) })).rejects.toMatchObject({ code: 'period_not_current' });
    await funding.allocateIndividualPeriod({ ...term, cycle: second });
    const overlapping = individualCycle('2026-11-01T00:00:00.000Z', 0);
    await expect(funding.allocateIndividualPeriod({ ...term, cycle: overlapping })).rejects.toMatchObject({ code: 'period_overlap' });
    await expect(funding.allocateIndividualPeriod({ ...term, cycle: { ...second, endsAt: '2026-12-01T15:00:00.000Z' } })).rejects.toMatchObject({ code: 'invalid_period' });
    expect(repo.snapshot().periods).toHaveLength(1);
  });

  it('judges a reservation that waited on the lock past the end by the time it gets the lock', async () => {
    const clock = { at: Date.parse('2026-10-29T00:00:00Z') };
    const { repo, funding } = await opened(clock);
    await funding.allocateIndividualPeriod(term);
    clock.at = Date.parse('2026-10-30T14:59:59.999Z');
    // The clock passes the anniversary while this reservation waits for the billing-scope lock.
    const waiting = new FundingService({ transaction: (action) => { clock.at = Date.parse('2026-10-30T15:00:00Z'); return repo.transaction(action); } },
      { now: () => clock.at });
    await expect(waiting.reserve(hold('late'))).rejects.toMatchObject({ code: 'period_ended' });
    expect(repo.snapshot().attempts).toHaveLength(0);
  });

  it('releases an unsent hold whose term ended before dispatch, and settles a sent one late against its own term', async () => {
    const clock = { at: Date.parse('2026-10-30T14:00:00Z') };
    const { repo, funding } = await opened(clock);
    await funding.allocateIndividualPeriod(term);
    await funding.reserve(hold('unsent'));
    await funding.reserve(hold('sent'));
    await funding.markDispatched(hold('sent'));
    clock.at = Date.parse('2026-10-30T15:00:00Z');
    await funding.allocateIndividualPeriod({ ...term, cycle: second });
    await expect(funding.markDispatched(hold('unsent'))).rejects.toMatchObject({ code: 'period_ended' });
    expect(repo.snapshot().attempts.find(a => a.id === 'unsent')).toMatchObject({ state: 'released', dispatchedAt: null });
    const settled = await funding.settle({ ...hold('sent'), receiptRef: 'receipt', usage, reconciledFrom: 'response' });
    expect(settled).toMatchObject({ outcome: 'settled', settlement: { periodId: 'individual:2026-09-30T15:00:00.000Z', allowanceDebitMicroUsd: 100_000 } });
    // Neither the late debit nor the released hold moves the new term.
    expect(await funding.individualProjection(person, account, second)).toMatchObject({ state: 'ready',
      projection: { allocation: 'recorded', settledMicroUsd: 0, pendingMicroUsd: 0, availableMicroUsd: 100_000_000 } });
    // A retry under the original parent job spends current funds inside the same job cap.
    const retry = await funding.reserve({ ...hold('retry', second), parentAttemptId: 'sent' });
    expect(retry).toMatchObject({ periodId: 'individual:2026-10-30T15:00:00.000Z', rootJobId: 'job' });
  });

  it('keeps a legacy calendar row for settlement only once a monthly term covers the moment', async () => {
    const clock = { at: Date.parse('2026-10-02T00:00:00Z') };
    const { repo, funding } = await opened(clock);
    await funding.allocatePeriod({ ...allocation, periodId: '2026-10' });
    await funding.reserve({ ...hold('legacy'), individualCycle: undefined });
    await funding.markDispatched(hold('legacy'));
    const restart = individualCycle('2026-10-05T00:00:00.000Z', 0);
    clock.at = Date.parse('2026-10-06T00:00:00Z');
    await funding.allocateIndividualPeriod({ ...term, cycle: restart });
    await expect(funding.reserve({ ...hold('calendar'), individualCycle: undefined })).rejects.toMatchObject({ code: 'period_superseded' });
    expect(await funding.reserve(hold('term', restart))).toMatchObject({ periodId: 'individual:2026-10-05T00:00:00.000Z' });
    expect(await funding.settle({ ...hold('legacy'), receiptRef: 'legacy-receipt', usage, reconciledFrom: 'response' }))
      .toMatchObject({ outcome: 'settled', settlement: { periodId: '2026-10' } });
    expect(repo.snapshot().periods.map(row => row.periodId)).toEqual(['2026-10', 'individual:2026-10-05T00:00:00.000Z']);
  });
});
