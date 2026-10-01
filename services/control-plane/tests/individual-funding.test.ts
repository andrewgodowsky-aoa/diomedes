import { describe, expect, it } from 'vitest';
import { FundingService } from '../src/funding.js';
import { FundingMemoryRepository } from './support/funding-memory.js';
import { micro } from '../../../shared/managed-usage.js';

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
