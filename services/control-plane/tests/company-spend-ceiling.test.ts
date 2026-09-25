/**
 * The company-wide spend ceiling inside FundingService.reserve. One Bedrock
 * account pays for every tenant and organization, so the ceiling counts all of
 * them: settled provider cost, plus every pending, uncertain or written-off
 * hold at its full ceiling, plus the new hold.
 *
 * The race case runs over a repository whose transactions interleave step by
 * step, with each lock a real mutex held to the end of its transaction, the way
 * pg_advisory_xact_lock behaves. It proves the service takes the company lock
 * before it reads the total, inside the reserving transaction. It does not
 * prove PostgreSQL itself; the opt-in integration suite does that.
 */
import { describe, expect, it } from 'vitest';
import { micro, type RateSnapshot } from '../../../shared/managed-usage.js';
import { FundingError, FundingService, type FundingRepository, type FundingTransaction } from '../src/funding.js';
import { emptyFundingState, StateFundingTransaction } from '../src/faux/funding-state.js';
import { FundingMemoryRepository } from './support/funding-memory.js';

// $1 per million of every token kind: 1,000 input tokens cost exactly 1,000 micro-USD.
const RATE: RateSnapshot = {
  version: 'fixture-rate-1',
  inputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 1_000_000,
  cacheWriteMicroUsdPerMillion: 1_000_000,
};
const HOLD = 10_000;
const now = () => Date.parse('2026-09-10T12:00:00.000Z');

interface Org { tenantId: string; organizationId: string }
const A: Org = { tenantId: 'tenant_a', organizationId: 'org_a' };
const B: Org = { tenantId: 'tenant_b', organizationId: 'org_b' };

async function fund(service: FundingService, org: Org) {
  await service.allocatePeriod({ ...org, periodId: '2026-09', planId: 'business', sourceGrantId: `grant_${org.organizationId}` });
  await service.openJob({ ...org, rootJobId: `job_${org.organizationId}`, runRef: `run_${org.organizationId}`, parentRunRef: null, tier: 'efficient', capMicroUsd: null });
}
function reserve(service: FundingService, org: Org, attemptId: string, ceiling?: number | null) {
  return service.reserve({
    ...org, attemptId, rootJobId: `job_${org.organizationId}`, parentAttemptId: null, kind: 'generation', route: 'aws-luna-6',
    requestDigest: `digest_${attemptId}`, rateSnapshot: RATE, maxMicroUsd: micro(HOLD), usageClass: 'included-chat',
    ...(ceiling === undefined ? {} : { companyCeilingMicroUsd: ceiling === null ? null : micro(ceiling) }),
  });
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

describe('the company spend ceiling in FundingService.reserve', () => {
  it('counts every tenant and organization: settled provider cost, and pending, uncertain and written-off holds in full', async () => {
    const repository = new FundingMemoryRepository();
    const service = new FundingService(repository, { now });
    await fund(service, A);
    await fund(service, B);
    const ref = (org: Org, attemptId: string) => ({ ...org, attemptId });

    // Tenant A: one call settled at 3,000, one parked uncertain, one written off, one released unsent.
    await reserve(service, A, 'a_settled');
    await service.markDispatched(ref(A, 'a_settled'));
    await service.settle({ ...ref(A, 'a_settled'), receiptRef: 'receipt_a', reconciledFrom: 'response',
      usage: { inputTokens: 3_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } });
    await reserve(service, A, 'a_uncertain');
    await service.markDispatched(ref(A, 'a_uncertain'));
    await service.markUncertain({ ...ref(A, 'a_uncertain'), reason: 'The stream was cut.' });
    await reserve(service, A, 'a_written_off');
    await service.markDispatched(ref(A, 'a_written_off'));
    await service.markUncertain({ ...ref(A, 'a_written_off'), reason: 'The stream was cut.' });
    await service.writeOff({ ...ref(A, 'a_written_off'), evidenceRef: 'bedrock_request_1' });
    await reserve(service, A, 'a_released');
    await service.release(ref(A, 'a_released'));
    // Company spend so far: 3,000 settled + 10,000 uncertain + 10,000 written off. The released hold never left.
    const spent = 3_000 + 2 * HOLD;

    // Tenant B's call lands exactly on the ceiling, and passes.
    expect(await reserve(service, B, 'b_1', spent + HOLD)).toMatchObject({ state: 'pending', maxMicroUsd: HOLD });
    // Its hold now counts in full while it is pending: one more micro-USD of room is not enough.
    const refused = await refusal(reserve(service, B, 'b_2', spent + 2 * HOLD - 1));
    expect(refused).toMatchObject({ status: 503, code: 'company_ceiling' });
    expect(repository.snapshot().attempts.map((row) => row.id)).not.toContain('b_2');
    // Exactly enough room passes.
    expect(await reserve(service, B, 'b_2', spent + 2 * HOLD)).toMatchObject({ state: 'pending' });
    // A replay of an existing reservation adds nothing, so no ceiling refuses it.
    expect(await reserve(service, B, 'b_1', 0)).toMatchObject({ id: 'b_1', state: 'pending' });
    // No ceiling, no check: production's default.
    expect(await reserve(service, B, 'b_3', null)).toMatchObject({ state: 'pending' });
    expect(await reserve(service, B, 'b_4')).toMatchObject({ state: 'pending' });
  });

  it('refuses a ceiling that is not a whole, non-negative number of micro-USD', async () => {
    const service = new FundingService(new FundingMemoryRepository(), { now });
    await fund(service, A);
    for (const ceiling of [-1, 1.5, Number.NaN])
      expect(await refusal(service.reserve({
        ...A, attemptId: 'a_1', rootJobId: 'job_org_a', parentAttemptId: null, kind: 'generation', route: 'aws-luna-6',
        requestDigest: 'digest_a_1', rateSnapshot: RATE, maxMicroUsd: micro(HOLD), usageClass: 'included-chat',
        companyCeilingMicroUsd: ceiling as never,
      }))).toMatchObject({ status: 422, code: 'invalid_amount' });
    // Zero is a valid ceiling: nothing passes.
    expect(await refusal(reserve(service, A, 'a_1', 0))).toMatchObject({ code: 'company_ceiling' });
  });
});

/**
 * Transactions that interleave one repository call at a time over one shared
 * ledger, so two reservations for different organizations both read the
 * company total before either writes, unless a lock keeps them apart. Each
 * lock is a real mutex released only when its transaction ends.
 */
class InterleavingFundingRepository implements FundingRepository {
  private readonly state = emptyFundingState();
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly options: { companyLock: boolean }) {}

  private async acquire(key: string): Promise<() => void> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, prior.then(() => mine));
    await prior;
    return release;
  }

  async transaction<T>(action: (tx: FundingTransaction) => Promise<T>): Promise<T> {
    const held: (() => void)[] = [];
    const inner = new StateFundingTransaction(this.state);
    const tx = new Proxy(inner, {
      get: (target, name) => {
        const value = Reflect.get(target, name);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          // Let the other transaction take a step first.
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (name === 'lockOrganization') { held.push(await this.acquire(`organization:${String(args[0])}:${String(args[1])}`)); return undefined; }
          if (name === 'lockCompany') { if (this.options.companyLock) held.push(await this.acquire('company')); return undefined; }
          return (value as (...parameters: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    try {
      return await action(tx);
    } finally {
      for (const release of held) release();
    }
  }
}

describe('two reservations near the company ceiling at once', () => {
  async function race(companyLock: boolean) {
    const service = new FundingService(new InterleavingFundingRepository({ companyLock }), { now });
    await fund(service, A);
    await fund(service, B);
    // Room for one hold, not two.
    return Promise.allSettled([reserve(service, A, 'a_edge', 2 * HOLD - 1), reserve(service, B, 'b_edge', 2 * HOLD - 1)]);
  }

  it('lets exactly one through while the company lock is held to the end of the reserving transaction', async () => {
    const results = await race(true);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'company_ceiling' });
  });

  it('would let both through without the lock, so the case above has teeth', async () => {
    const results = await race(false);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
  });
});
