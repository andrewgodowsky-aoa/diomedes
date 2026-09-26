/**
 * Revision 2 of nectovia-managed/1, at the FundingService level:
 *
 * - markDispatched is exclusive. Only the caller whose conditional update
 *   moved the attempt may send; every other caller gets `attempt_in_flight`.
 * - releaseRefused releases a sent hold, but only on a provider refusal that
 *   bills nothing, and records the evidence on the attempt.
 */
import { describe, expect, it } from 'vitest';
import { micro, type RateSnapshot } from '../../../shared/managed-usage.js';
import { FundingError, FundingService, type FundingRepository } from '../src/funding.js';
import { FundingMemoryRepository } from './support/funding-memory.js';
import { InterleavingFundingRepository } from './support/interleaving-funding.js';

const RATE: RateSnapshot = {
  version: 'fixture-rate-1',
  inputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 1_000_000,
  cacheWriteMicroUsdPerMillion: 1_000_000,
};
const HOLD = 10_000;
const now = () => Date.parse('2026-09-10T12:00:00.000Z');
const T = 'tenant_1';
const O = 'org_1';
const ref = (attemptId: string) => ({ tenantId: T, organizationId: O, attemptId });

async function funded(repository: FundingRepository) {
  const service = new FundingService(repository, { now });
  await service.allocatePeriod({ tenantId: T, organizationId: O, periodId: '2026-09', planId: 'business', sourceGrantId: 'grant_1' });
  await service.openJob({ tenantId: T, organizationId: O, rootJobId: 'job_1', runRef: 'run_1', parentRunRef: null, tier: 'efficient', capMicroUsd: null });
  const reserve = (attemptId: string) => service.reserve({
    ...ref(attemptId), rootJobId: 'job_1', parentAttemptId: null, kind: 'generation', route: 'aws-luna-6',
    requestDigest: `digest_${attemptId}`, rateSnapshot: RATE, maxMicroUsd: micro(HOLD), usageClass: 'included-chat',
  });
  const available = async () => {
    const state = await service.projection(T, O);
    if (state.state !== 'ready') throw new Error(`usage is ${state.state}`);
    return state.projection;
  };
  return { service, reserve, available };
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

describe('markDispatched is exclusive', () => {
  async function race(unconditionalDispatch: boolean) {
    // No organization lock, so the two dispatchers truly interleave: only the conditional update decides.
    const repository = new InterleavingFundingRepository({ organizationLock: false, unconditionalDispatch });
    const { reserve } = await funded(repository);
    await reserve('attempt_1');
    // Two service instances, as two Worker isolates would be, over one store.
    const first = new FundingService(repository, { now });
    const second = new FundingService(repository, { now });
    return Promise.allSettled([first.markDispatched(ref('attempt_1')), second.markDispatched(ref('attempt_1'))]);
  }

  it('lets exactly one of two interleaved dispatchers on separate service instances send', async () => {
    const results = await race(false);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409, code: 'attempt_in_flight', message: 'That request is already being answered.' });
  });

  it('would let both send with an unconditional update, so the case above has teeth', async () => {
    const results = await race(true);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
  });

  it('refuses a second dispatch of the same attempt, even from the same caller', async () => {
    const { service, reserve } = await funded(new FundingMemoryRepository());
    await reserve('attempt_1');
    const sent = await service.markDispatched(ref('attempt_1'));
    expect(sent.dispatchedAt).toBe(new Date(now()).toISOString());
    expect(await refusal(service.markDispatched(ref('attempt_1')))).toMatchObject({ code: 'attempt_in_flight' });
  });
});

describe('releaseRefused', () => {
  it('releases a sent hold on a 429, records the evidence, and restores the full credit', async () => {
    const repository = new FundingMemoryRepository();
    const { service, reserve, available } = await funded(repository);
    const before = await available();
    await reserve('attempt_1');
    await service.markDispatched(ref('attempt_1'));
    expect((await available()).availableMicroUsd).toBe(before.availableMicroUsd - HOLD);
    const released = await service.releaseRefused({ ...ref('attempt_1'), providerStatus: 429, providerRequestId: 'req-7f3a' });
    expect(released).toMatchObject({ state: 'released', resolvedAt: expect.any(String),
      uncertainReason: 'Released: the provider refused it with HTTP 429 before any output (provider request req-7f3a).' });
    expect(repository.snapshot().attempts[0]).toMatchObject({ state: 'released', dispatchedAt: expect.any(String) });
    const after = await available();
    expect(after.availableMicroUsd).toBe(before.availableMicroUsd);
    expect(after.pendingMicroUsd).toBe(0);
    expect(after.uncertainMicroUsd).toBe(0);
    // A repeat after an unknown COMMIT finds the release, and changes nothing.
    expect(await service.releaseRefused({ ...ref('attempt_1'), providerStatus: 429, providerRequestId: 'req-7f3a' })).toMatchObject({ state: 'released' });
  });

  it('accepts every billing-free refusal, with or without a provider request id', async () => {
    for (const [index, status] of [400, 401, 403, 404, 413, 422, 429].entries()) {
      const { service, reserve } = await funded(new FundingMemoryRepository());
      await reserve(`attempt_${index}`);
      await service.markDispatched(ref(`attempt_${index}`));
      expect(await service.releaseRefused({ ...ref(`attempt_${index}`), providerStatus: status, providerRequestId: null }))
        .toMatchObject({ state: 'released', uncertainReason: expect.stringContaining(`HTTP ${status}`) });
    }
  });

  it('refuses a disallowed status, and leaves the hold as it was', async () => {
    const repository = new FundingMemoryRepository();
    const { service, reserve } = await funded(repository);
    await reserve('attempt_1');
    await service.markDispatched(ref('attempt_1'));
    for (const status of [200, 408, 409, 499, 500, 502, 503, 529])
      expect(await refusal(service.releaseRefused({ ...ref('attempt_1'), providerStatus: status, providerRequestId: 'req-1' })))
        .toMatchObject({ status: 422, code: 'release_not_allowed' });
    expect(repository.snapshot().attempts[0]).toMatchObject({ state: 'pending', dispatchedAt: expect.any(String), resolvedAt: null });
  });

  it('refuses an unsent attempt, an uncertain one and a malformed request id', async () => {
    const { service, reserve } = await funded(new FundingMemoryRepository());
    await reserve('unsent');
    expect(await refusal(service.releaseRefused({ ...ref('unsent'), providerStatus: 429, providerRequestId: null }))).toMatchObject({ code: 'not_dispatched' });
    await reserve('lost');
    await service.markDispatched(ref('lost'));
    await service.markUncertain({ ...ref('lost'), reason: 'The stream was cut.' });
    expect(await refusal(service.releaseRefused({ ...ref('lost'), providerStatus: 429, providerRequestId: null }))).toMatchObject({ code: 'invalid_transition' });
    expect(await refusal(service.releaseRefused({ ...ref('lost'), providerStatus: 429, providerRequestId: 'has spaces' }))).toMatchObject({ code: 'invalid_request' });
    // A plain release still never frees a sent hold.
    await reserve('sent');
    await service.markDispatched(ref('sent'));
    expect(await refusal(service.release(ref('sent')))).toMatchObject({ code: 'dispatched_hold' });
  });
});
