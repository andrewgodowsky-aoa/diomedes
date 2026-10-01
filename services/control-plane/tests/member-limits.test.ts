/**
 * Per-member monthly credit limits (Andrew, 2026-10-01), enforced where credits are held.
 *
 * A business has one shared pool. Each member has a monthly limit on it, always on, set by role with
 * a per-person override, reset with the plan period. Past it, work stops and asks an owner or admin,
 * who may approve one job or raise the person's month, and may let the approval use bought credits.
 * Offline memory adapters only: these prove the service's rules and its API, not PostgreSQL locking.
 */
import { describe, expect, it } from 'vitest';
import { creditAmount, micro, type RateSnapshot } from '../../../shared/managed-usage.js';
import { MEMBER_LIMIT_REACHED, PLAN_MEMBER_LIMIT_CREDITS, decideMemberUse, defaultLimitFor, effectiveLimit } from '../../../shared/credit-allotments.js';
import { FundingError, FundingService, PURCHASED_HOLD_LEASE_MINUTES, PurchasedUsageService, UsageService } from '../src/funding.js';
import { MemberLimits, MemberLimitsService } from '../src/member-limits.js';
import { createHandler } from '../src/worker.js';
import { FundingMemoryRepository } from './support/funding-memory.js';
import { setup, validEnv } from './support/fixtures.js';

const c = (credits: number) => creditAmount(credits);
const RATE: RateSnapshot = {
  version: 'fixture-rate-1', inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 1_000_000, cacheWriteMicroUsdPerMillion: 1_000_000,
};
const usageFor = (credits: number) => ({ inputTokens: credits * 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });

async function fixture() {
  const { accounts } = setup();
  let clock = Date.parse('2026-09-20T12:00:00.000Z');
  const organization = await accounts.createOrganization('alice', 'Fernbrook Joinery');
  for (const [token, role] of [['carol', 'admin'], ['erin', 'admin'], ['bob', 'member'], ['dave', 'member']] as const) {
    const invite = await accounts.invite('alice', organization.id, { subject: `user_${token}`, role, ttlMs: 5000 });
    await accounts.acceptInvitation(token, organization.id, invite.token);
  }
  const people = {} as Record<'alice' | 'carol' | 'erin' | 'bob' | 'dave', { id: string; role: 'owner' | 'admin' | 'member' }>;
  for (const [token, role] of [['alice', 'owner'], ['carol', 'admin'], ['erin', 'admin'], ['bob', 'member'], ['dave', 'member']] as const)
    people[token] = { id: (await accounts.membership(token, organization.id)).person.id, role };
  const repository = new FundingMemoryRepository();
  const funding = new FundingService(repository, { now: () => clock });
  const limits = new MemberLimits(repository, { now: () => clock });
  const ref = { tenantId: organization.tenantId, organizationId: organization.id };
  await funding.allocatePeriod({ ...ref, periodId: '2026-09', planId: 'business', sourceGrantId: 'grant_sep' });

  const open = (rootJobId: string) => funding.openJob({ ...ref, rootJobId, runRef: `run_${rootJobId}`, parentRunRef: null, tier: 'efficient', capMicroUsd: null });
  /** A reservation for one of the business's people, the way the gateway makes it. */
  const reserve = async (who: keyof typeof people, attemptId: string, credits: number, rootJobId = 'job_1', over: Record<string, unknown> = {}) => {
    await open(rootJobId);
    return funding.reserve({
      ...ref, attemptId, rootJobId, parentAttemptId: null, kind: 'generation', route: 'aws-bedrock', requestDigest: `digest_${attemptId}`,
      rateSnapshot: RATE, maxMicroUsd: c(credits), usageClass: 'metered-work', member: { personId: people[who].id, role: people[who].role }, ...over,
    });
  };
  const attemptRef = (attemptId: string) => ({ ...ref, attemptId });
  const settle = async (attemptId: string, credits: number) => {
    await funding.markDispatched(attemptRef(attemptId));
    return funding.settle({ ...attemptRef(attemptId), receiptRef: `receipt_${attemptId}`, usage: usageFor(credits), reconciledFrom: 'response' });
  };
  const spend = async (who: keyof typeof people, attemptId: string, credits: number, rootJobId = `job_${attemptId}`) => {
    await reserve(who, attemptId, credits, rootJobId);
    return settle(attemptId, credits);
  };
  const actor = (who: keyof typeof people) => ({ personId: people[who].id, role: people[who].role });
  const setLimit = (who: keyof typeof people, target: keyof typeof people, mode: 'limit' | 'unlimited' | 'inherit', credits: number | null = null) =>
    limits.setLimit({ ...ref, actor: actor(who), subject: { kind: 'person', personId: people[target].id }, targetRole: people[target].role, mode, limitMicroUsd: credits === null ? null : c(credits) });
  const setRole = (who: keyof typeof people, role: 'member' | 'admin', mode: 'limit' | 'unlimited' | 'inherit', credits: number | null = null) =>
    limits.setLimit({ ...ref, actor: actor(who), subject: { kind: 'role', role }, targetRole: null, mode, limitMicroUsd: credits === null ? null : c(credits) });
  const ask = (who: keyof typeof people, requestId: string, kind: 'job' | 'month', jobId: string | null = null) =>
    limits.ask({ ...ref, requestId, actor: actor(who), kind, jobId });
  const decide = (who: keyof typeof people, requestId: string, approve: boolean, extra?: { extraMicroUsd?: number; allowPurchased?: boolean }) =>
    limits.decide({ ...ref, requestId, actor: actor(who), approve, ...extra });
  const usage = async (who: keyof typeof people) => {
    const period = (await repository.transaction((tx) => tx.period(ref.tenantId, ref.organizationId, '2026-09')))!;
    return (await repository.transaction((tx) => tx.memberUsage(ref.tenantId, ref.organizationId, period, people[who].id, new Date(clock).toISOString())))[0];
  };
  const service = new MemberLimitsService(accounts, limits);
  const handler = createHandler(() => accounts, (_config, account) => new UsageService(account, funding), {
    createLimits: () => service,
    createPurchased: (_config, account) => new PurchasedUsageService(account, funding),
  });
  const base = `/account/organizations/${organization.id}`;
  const call = (path: string, token: string | null, init: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { origin: 'http://127.0.0.1:8791' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return handler(new Request(`http://127.0.0.1:8791${base}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), validEnv);
  };
  return { accounts, organization, repository, funding, limits, ref, people, setClock: (iso: string) => { clock = Date.parse(iso); },
    open, reserve, settle, spend, setLimit, setRole, ask, decide, usage, call, base, actor };
}

async function refusal(promise: Promise<unknown>): Promise<FundingError> {
  try { await promise; } catch (error) {
    if (error instanceof FundingError) return error;
    throw error;
  }
  throw new Error('Expected a refusal.');
}

describe('the rules, as pure functions', () => {
  it('has no tier default decided: a plan with no entry gets its whole monthly allowance', () => {
    expect(PLAN_MEMBER_LIMIT_CREDITS).toEqual({});
    expect(defaultLimitFor({ role: 'member', planId: 'business', monthlyGrantMicroUsd: c(1000) })).toBe(c(1000));
    expect(defaultLimitFor({ role: 'admin', planId: 'business', monthlyGrantMicroUsd: c(1000) })).toBeNull();
    expect(defaultLimitFor({ role: 'owner', planId: 'business', monthlyGrantMicroUsd: c(1000) })).toBeNull();
  });

  it('resolves a person, then their role, then the default', () => {
    const base = { role: 'member' as const, personId: 'p1', planId: 'business', monthlyGrantMicroUsd: c(1000) };
    const role = { subjectKind: 'role' as const, subjectId: 'member', mode: 'limit' as const, limitMicroUsd: c(300) };
    const person = { subjectKind: 'person' as const, subjectId: 'p1', mode: 'limit' as const, limitMicroUsd: c(50) };
    expect(effectiveLimit({ ...base, settings: [] })).toEqual({ limitMicroUsd: c(1000), source: 'default' });
    expect(effectiveLimit({ ...base, settings: [role] })).toEqual({ limitMicroUsd: c(300), source: 'role' });
    expect(effectiveLimit({ ...base, settings: [role, person] })).toEqual({ limitMicroUsd: c(50), source: 'person' });
    expect(effectiveLimit({ ...base, settings: [role, { ...person, mode: 'unlimited', limitMicroUsd: null }] })).toEqual({ limitMicroUsd: null, source: 'person' });
    expect(effectiveLimit({ ...base, settings: [role, { ...person, mode: 'inherit', limitMicroUsd: null }] })).toEqual({ limitMicroUsd: c(300), source: 'role' });
  });

  it('admits what fits, refuses what does not in plain words, and never counts an approval it was not given', () => {
    const base = { limitMicroUsd: c(30), usedMicroUsd: c(20), reserveMicroUsd: c(10), purchasedMicroUsd: micro(0), allowance: { extraMicroUsd: micro(0), allowPurchased: false } };
    expect(decideMemberUse(base)).toEqual({ ok: true });
    const over = decideMemberUse({ ...base, reserveMicroUsd: c(11) });
    expect(over).toMatchObject({ ok: false, code: MEMBER_LIMIT_REACHED, usedMicroUsd: c(20), limitMicroUsd: c(30), overByMicroUsd: c(1) });
    if (over.ok) throw new Error('unreachable');
    expect(over.reason).toMatch(/Nothing was sent\.$/);
    expect(over.reason).not.toMatch(/[$—–]/);
    expect(decideMemberUse({ ...base, limitMicroUsd: null, usedMicroUsd: c(9999) })).toEqual({ ok: true });
    expect(decideMemberUse({ ...base, reserveMicroUsd: c(11), allowance: { extraMicroUsd: c(5), allowPurchased: false } })).toEqual({ ok: true });
    expect(decideMemberUse({ ...base, reserveMicroUsd: c(11), allowance: { extraMicroUsd: c(0.5), allowPurchased: false } })).toMatchObject({ ok: false });
    // Bought credits lift past the limit only when the approval says so.
    const bought = { ...base, reserveMicroUsd: c(11), purchasedMicroUsd: c(11), allowance: { extraMicroUsd: c(5), allowPurchased: false } };
    expect(decideMemberUse(bought)).toMatchObject({ ok: false, needsPurchasedApproval: true });
    expect(decideMemberUse({ ...bought, allowance: { ...bought.allowance, allowPurchased: true } })).toEqual({ ok: true });
  });
});

describe('a member’s limit at admission', () => {
  it('changes nothing while every member is under their limit: the default is the whole allowance, and each attempt is attributed', async () => {
    const f = await fixture();
    const before = await f.funding.projection(f.ref.tenantId, f.ref.organizationId);
    await f.spend('bob', 'a1', 20);
    await f.spend('bob', 'a2', 20);
    const after = await f.funding.projection(f.ref.tenantId, f.ref.organizationId);
    if (before.state !== 'ready' || after.state !== 'ready') throw new Error('The month should be funded.');
    expect(after.projection.settledMicroUsd).toBe(c(40));
    expect(after.projection.availableMicroUsd).toBe(c(960));
    expect(f.repository.snapshot().attemptPeople.map((row) => [row.attemptId, row.personId])).toEqual([['a1', f.people.bob.id], ['a2', f.people.bob.id]]);
    expect(await f.usage('bob')).toMatchObject({ includedMicroUsd: c(40), purchasedMicroUsd: 0, heldMicroUsd: 0 });
  });

  it('refuses a step past a per-person limit with a stable code and words that end "Nothing was sent.", and holds nothing', async () => {
    const f = await fixture();
    await f.setLimit('alice', 'bob', 'limit', 30);
    await f.spend('bob', 'a1', 20);
    const attemptsBefore = f.repository.snapshot().attempts.length;
    const refused = await refusal(f.reserve('bob', 'a2', 11, 'job_a2'));
    expect(refused).toMatchObject({ status: 402, code: 'member_limit_reached' });
    expect(refused.message).toBe('This step needs up to 11 credits, and you’ve used 20 of the 30 set for you this month. An owner or admin can approve more. Nothing was sent.');
    expect(f.repository.snapshot().attempts).toHaveLength(attemptsBefore);
    expect(f.repository.snapshot().attemptPeople).toHaveLength(1);
    // What fits is still admitted, right up to the limit.
    await expect(f.reserve('bob', 'a3', 10, 'job_a3')).resolves.toMatchObject({ state: 'pending' });
    expect((await refusal(f.reserve('bob', 'a4', 1, 'job_a4'))).code).toBe('member_limit_reached');
  });

  it('counts held work at its ceiling and settled work at cost, and gives back what was released', async () => {
    const f = await fixture();
    await f.setLimit('alice', 'bob', 'limit', 30);
    await f.reserve('bob', 'a1', 20);
    expect(await f.usage('bob')).toMatchObject({ includedMicroUsd: c(20), heldMicroUsd: c(20) });
    await f.funding.release({ ...f.ref, attemptId: 'a1' });
    expect(await f.usage('bob')).toBeUndefined();
    await f.spend('bob', 'a2', 20);
    // A settlement at less than the ceiling frees the difference.
    await f.reserve('bob', 'a3', 10, 'job_a3');
    await f.funding.markDispatched({ ...f.ref, attemptId: 'a3' });
    await f.funding.markUncertain({ ...f.ref, attemptId: 'a3', reason: 'The response was lost.' });
    expect(await f.usage('bob')).toMatchObject({ includedMicroUsd: c(30), heldMicroUsd: c(10) });
    expect((await refusal(f.reserve('bob', 'a4', 1, 'job_a4'))).code).toBe('member_limit_reached');
  });

  it('counts the bought credits a member holds on their own, so a purchased hold counts too', async () => {
    const f = await fixture();
    await f.funding.recordTopUp({ ...f.ref, topUpId: 'topup_1', amountMicroUsd: c(100), provider: 'stripe', sourceEventId: 'evt_1' });
    await f.setLimit('alice', 'bob', 'limit', 20);
    const purchased = new PurchasedUsageService(f.accounts, f.funding);
    await purchased.hold('bob', f.organization.id, { holdId: 'hold_1', amountMicroUsd: c(15), requestDigest: 'digest-1' });
    expect(await f.usage('bob')).toMatchObject({ includedMicroUsd: 0, purchasedMicroUsd: c(15), heldMicroUsd: c(15) });
    expect((await refusal(f.reserve('bob', 'a1', 10))).code).toBe('member_limit_reached');
    await purchased.settle('bob', f.organization.id, { holdId: 'hold_1', debitMicroUsd: c(5) });
    expect(await f.usage('bob')).toMatchObject({ purchasedMicroUsd: c(5), heldMicroUsd: 0 });
    await expect(f.reserve('bob', 'a2', 10, 'job_a2')).resolves.toMatchObject({ state: 'pending' });
  });

// A purchased hold is a lease. Past it the hold is not held, even before anything has let go of it, so it
  // stops counting against the member the moment the lease lapses, the same instant the bought balance frees it.
  it('does not count a purchased hold whose lease has lapsed as held, before anything has let go of it', async () => {
    const f = await fixture();
    await f.funding.recordTopUp({ ...f.ref, topUpId: 'topup_1', amountMicroUsd: c(100), provider: 'stripe', sourceEventId: 'evt_1' });
    await f.setLimit('alice', 'bob', 'limit', 20);
    const purchased = new PurchasedUsageService(f.accounts, f.funding);
    await purchased.hold('bob', f.organization.id, { holdId: 'hold_1', amountMicroUsd: c(15), requestDigest: 'digest-1' });
    f.setClock('2026-09-20T12:14:00.000Z');
    expect(await f.usage('bob')).toMatchObject({ purchasedMicroUsd: c(15), heldMicroUsd: c(15) });
    expect((await refusal(f.reserve('bob', 'a1', 10))).code).toBe('member_limit_reached');
    // The lease runs out at exactly 15 minutes: from that instant the hold is not held.
    f.setClock(new Date(Date.parse('2026-09-20T12:00:00.000Z') + PURCHASED_HOLD_LEASE_MINUTES * 60_000).toISOString());
    expect(await f.usage('bob')).toBeUndefined();
    await expect(f.reserve('bob', 'a2', 10, 'job_a2')).resolves.toMatchObject({ state: 'pending' });
    // Nothing swept the row: it is still held in storage, and only the reading changed.
    expect(f.repository.snapshot().topUpHolds.find((row) => row.holdId === 'hold_1')).toMatchObject({ state: 'held', releasedBy: null });
  });

  it('counts a settled purchased hold at its recorded debit only, never at what was absorbed', async () => {
    const f = await fixture();
    await f.funding.recordTopUp({ ...f.ref, topUpId: 'topup_1', amountMicroUsd: c(10), provider: 'stripe', sourceEventId: 'evt_1' });
    await f.setLimit('alice', 'bob', 'limit', 50);
    const purchased = new PurchasedUsageService(f.accounts, f.funding);
    await purchased.hold('bob', f.organization.id, { holdId: 'hold_a', amountMicroUsd: c(7), requestDigest: 'digest-a' });
    f.setClock(new Date(Date.parse('2026-09-20T12:00:00.000Z') + PURCHASED_HOLD_LEASE_MINUTES * 60_000).toISOString());
    // The lapsed credits are held again by other work, so a late settle of the first can record only what is free.
    await purchased.hold('dave', f.organization.id, { holdId: 'hold_b', amountMicroUsd: c(7), requestDigest: 'digest-b' });
    const late = await purchased.settle('bob', f.organization.id, { holdId: 'hold_a', debitMicroUsd: c(7) });
    expect(late).toMatchObject({ state: 'settled', debitMicroUsd: c(3) });
    const row = f.repository.snapshot().topUpHolds.find((item) => item.holdId === 'hold_a')!;
    expect(row).toMatchObject({ debitMicroUsd: c(3), absorbedMicroUsd: c(4) });
    expect(await f.usage('bob')).toMatchObject({ includedMicroUsd: 0, purchasedMicroUsd: c(3), heldMicroUsd: 0 });
    expect(await f.usage('dave')).toMatchObject({ purchasedMicroUsd: c(7), heldMicroUsd: c(7) });
  });

  it('sets a limit for a role, lets a person override it, and lets an override clear', async () => {
    const f = await fixture();
    await f.setRole('alice', 'member', 'limit', 25);
    await f.spend('bob', 'b1', 20);
    await f.spend('dave', 'd1', 20);
    expect((await refusal(f.reserve('bob', 'b2', 6, 'job_b2'))).code).toBe('member_limit_reached');
    await f.setLimit('alice', 'bob', 'limit', 100);
    await expect(f.reserve('bob', 'b2', 6, 'job_b2')).resolves.toMatchObject({ state: 'pending' });
    // Dave still has the role's 25.
    expect((await refusal(f.reserve('dave', 'd2', 6, 'job_d2'))).code).toBe('member_limit_reached');
    await f.setLimit('alice', 'dave', 'unlimited');
    await expect(f.reserve('dave', 'd2', 6, 'job_d2')).resolves.toMatchObject({ state: 'pending' });
    await f.setLimit('alice', 'dave', 'inherit');
    expect((await refusal(f.reserve('dave', 'd3', 6, 'job_d3'))).code).toBe('member_limit_reached');
  });

  it('leaves an owner and an admin unlimited within the pool until an owner sets a limit for them', async () => {
    const f = await fixture();
    await f.setRole('alice', 'member', 'limit', 5);
    await f.spend('alice', 'o1', 20);
    await f.spend('carol', 'c1', 20);
    await expect(f.reserve('alice', 'o2', 20, 'job_o2')).resolves.toMatchObject({ state: 'pending' });
    await expect(f.reserve('carol', 'c2', 20, 'job_c2')).resolves.toMatchObject({ state: 'pending' });
    // An owner sets one for an admin, and it binds.
    await f.setLimit('alice', 'carol', 'limit', 30);
    expect((await refusal(f.reserve('carol', 'c3', 11, 'job_c3'))).code).toBe('member_limit_reached');
    await f.setRole('alice', 'admin', 'limit', 10);
    await f.setLimit('alice', 'carol', 'inherit');
    expect((await refusal(f.reserve('carol', 'c4', 1, 'job_c4'))).code).toBe('member_limit_reached');
    // Erin, the other admin, is held to the role's 10 too, and the owner is not.
    expect((await refusal(f.reserve('erin', 'e1', 11, 'job_e1'))).code).toBe('member_limit_reached');
    await expect(f.reserve('alice', 'o3', 20, 'job_o3')).resolves.toMatchObject({ state: 'pending' });
  });

  it('applies the limit to every member separately, and the shared pool still bounds everyone', async () => {
    const f = await fixture();
    await f.setRole('alice', 'member', 'limit', 20);
    await f.spend('bob', 'b1', 20);
    await expect(f.reserve('dave', 'd1', 20, 'job_d1')).resolves.toMatchObject({ state: 'pending' });
    // The pool is what funds both: take almost all of it, and the pool refuses first, with its own code.
    await f.setLimit('alice', 'dave', 'unlimited');
    await f.funding.recordCorrection({ ...f.ref, adjustmentId: 'adj_1', periodId: '2026-09', direction: 'withdraw', amountMicroUsd: c(950), attemptRef: null, note: 'Test.' });
    expect((await refusal(f.reserve('dave', 'd2', 20, 'job_d2'))).code).toBe('insufficient_allowance');
  });

  it('is idempotent: a retry of a landed hold is not refused by the limit and counts once', async () => {
    const f = await fixture();
    await f.setLimit('alice', 'bob', 'limit', 20);
    const first = await f.reserve('bob', 'a1', 20);
    // The member is now at the limit; the same attempt id with the same terms finds the same hold.
    const again = await f.funding.reserve({ ...f.ref, attemptId: 'a1', rootJobId: 'job_1', parentAttemptId: null, kind: 'generation', route: 'aws-bedrock',
      requestDigest: 'digest_a1', rateSnapshot: RATE, maxMicroUsd: c(20), usageClass: 'metered-work', member: { personId: f.people.bob.id, role: 'member' } });
    expect(again).toEqual(first);
    expect(f.repository.snapshot().attemptPeople).toHaveLength(1);
    expect(await f.usage('bob')).toMatchObject({ includedMicroUsd: c(20) });
    // A different attempt is refused, and a different hold under the same id is a conflict, not a limit.
    expect((await refusal(f.reserve('bob', 'a2', 1, 'job_a2'))).code).toBe('member_limit_reached');
    expect((await refusal(f.funding.reserve({ ...f.ref, attemptId: 'a1', rootJobId: 'job_1', parentAttemptId: null, kind: 'generation', route: 'aws-bedrock',
      requestDigest: 'digest_other', rateSnapshot: RATE, maxMicroUsd: c(20), usageClass: 'metered-work', member: { personId: f.people.bob.id, role: 'member' } }))).code).toBe('attempt_conflict');
  });

  it('lets only one of two concurrent steps by one member slip under the limit', async () => {
    const f = await fixture();
    await f.setLimit('alice', 'bob', 'limit', 20);
    await f.open('job_x');
    await f.open('job_y');
    const attempt = (id: string, job: string) => f.funding.reserve({ ...f.ref, attemptId: id, rootJobId: job, parentAttemptId: null, kind: 'generation', route: 'aws-bedrock',
      requestDigest: `digest_${id}`, rateSnapshot: RATE, maxMicroUsd: c(11), usageClass: 'metered-work', member: { personId: f.people.bob.id, role: 'member' } });
    const results = await Promise.allSettled([attempt('x1', 'job_x'), attempt('y1', 'job_y')]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(f.repository.snapshot().attemptPeople).toHaveLength(1);
  });

  it('does not limit, or attribute, a caller that names no member', async () => {
    const f = await fixture();
    await f.setRole('alice', 'member', 'limit', 1);
    await f.reserve('bob', 'a0', 1, 'job_a0');
    await f.open('job_s');
    await f.funding.reserve({ ...f.ref, attemptId: 's1', rootJobId: 'job_s', parentAttemptId: null, kind: 'generation', route: 'aws-bedrock',
      requestDigest: 'digest_s1', rateSnapshot: RATE, maxMicroUsd: c(20), usageClass: 'metered-work' });
    expect(f.repository.snapshot().attemptPeople.map((row) => row.attemptId)).toEqual(['a0']);
  });
});

describe('asking for more, and the answer', () => {
  it('raises one job: that job may run past the limit, and no other job may', async () => {
    const f = await fixture();
    await f.setLimit('alice', 'bob', 'limit', 30);
    await f.spend('bob', 'a1', 20);
    expect((await refusal(f.reserve('bob', 'a2', 15, 'job_2'))).code).toBe('member_limit_reached');
    const asked = await f.ask('bob', 'req_1', 'job', 'job_2');
    expect(asked).toMatchObject({ state: 'pending', kind: 'job', rootJobId: 'job_2', requesterRole: 'member' });
    // A request is not an approval.
    expect((await refusal(f.reserve('bob', 'a2', 15, 'job_2'))).code).toBe('member_limit_reached');
    const approved = await f.decide('alice', 'req_1', true);
    expect(approved).toMatchObject({ state: 'approved', decidedBy: f.people.alice.id, extraMicroUsd: c(20), allowPurchased: false, periodId: null });
    await expect(f.reserve('bob', 'a2', 15, 'job_2')).resolves.toMatchObject({ state: 'pending' });
    // Another job gets nothing from it, and neither does another person on the same job id.
    expect((await refusal(f.reserve('bob', 'a3', 5, 'job_3'))).code).toBe('member_limit_reached');
    expect((await refusal(f.reserve('bob', 'a4', 5, 'job_3'))).code).toBe('member_limit_reached');
  });

  it('raises the month by what the approver chose, for that person only, and it lapses when the period rolls over', async () => {
    const f = await fixture();
    await f.setLimit('alice', 'bob', 'limit', 20);
    await f.spend('bob', 'a1', 20);
    await f.ask('bob', 'req_m', 'month');
    expect((await refusal(f.decide('alice', 'req_m', true))).code).toBe('invalid_amount');
    const approved = await f.decide('carol', 'req_m', true, { extraMicroUsd: c(30) });
    expect(approved).toMatchObject({ state: 'approved', extraMicroUsd: c(30), periodId: '2026-09', decidedBy: f.people.carol.id });
    await expect(f.reserve('bob', 'a2', 20, 'job_2')).resolves.toMatchObject({ state: 'pending' });
    await f.settle('a2', 20);
    expect((await refusal(f.reserve('bob', 'a3', 11, 'job_3'))).code).toBe('member_limit_reached');
    await expect(f.reserve('bob', 'a3', 10, 'job_3')).resolves.toMatchObject({ state: 'pending' });
    // Dave never asked and is untouched.
    await f.setLimit('alice', 'dave', 'limit', 20);
    await f.spend('dave', 'd1', 20);
    expect((await refusal(f.reserve('dave', 'd2', 1, 'job_d2'))).code).toBe('member_limit_reached');

    // October: a new period, usage resets, the limit is back to what was set, and last month's raise is gone.
    f.setClock('2026-10-02T09:00:00.000Z');
    await f.funding.allocatePeriod({ ...f.ref, periodId: '2026-10', planId: 'business', sourceGrantId: 'grant_oct' });
    await expect(f.reserve('bob', 'o1', 20, 'job_o1')).resolves.toMatchObject({ state: 'pending' });
    await f.settle('o1', 20);
    expect((await refusal(f.reserve('bob', 'o2', 1, 'job_o2'))).code).toBe('member_limit_reached');
    const mine = await f.limits.mine({ ...f.ref, actor: f.actor('bob') });
    expect(mine).toMatchObject({ state: 'ready', periodId: '2026-10', limitMicroUsd: c(20), raisedByMicroUsd: 0, usage: { usedMicroUsd: c(20) } });
  });

  it('draws on bought credits only when the approval says so, and refuses that approval when none are free', async () => {
    const f = await fixture();
    await f.setLimit('alice', 'bob', 'limit', 20);
    await f.spend('bob', 'a1', 20);
    // Use up the included month, so the next step would draw bought credits.
    await f.funding.recordCorrection({ ...f.ref, adjustmentId: 'adj_1', periodId: '2026-09', direction: 'withdraw', amountMicroUsd: c(980), attemptRef: null, note: 'Test.' });
    await f.ask('bob', 'req_1', 'month');
    expect((await refusal(f.decide('alice', 'req_1', true, { extraMicroUsd: c(50), allowPurchased: true }))).code).toBe('no_purchased_usage');
    expect((await f.limits.requests({ ...f.ref, actor: f.actor('alice') }))[0].state).toBe('pending');
    await f.funding.recordTopUp({ ...f.ref, topUpId: 'topup_1', amountMicroUsd: c(100), provider: 'stripe', sourceEventId: 'evt_1' });
    await f.decide('alice', 'req_1', true, { extraMicroUsd: c(50) });
    // Room under the raised limit, but the step would use bought credits nobody approved for this member.
    const needsBought = await refusal(f.reserve('bob', 'a2', 10, 'job_2'));
    expect(needsBought).toMatchObject({ status: 402, code: 'member_limit_reached' });
    expect(needsBought.message).toBe('This step would use credits your business bought, and an owner or admin hasn’t approved that for you yet. Nothing was sent.');
    await f.ask('bob', 'req_2', 'month');
    await f.decide('alice', 'req_2', true, { extraMicroUsd: c(10), allowPurchased: true });
    const held = await f.reserve('bob', 'a2', 10, 'job_2');
    expect(held).toMatchObject({ state: 'pending', monthlyHoldMicroUsd: 0, topUpHoldMicroUsd: c(10) });
    expect(await f.usage('bob')).toMatchObject({ includedMicroUsd: c(20), purchasedMicroUsd: c(10) });
  });

  it('is idempotent by request id, returns an open ask instead of a second, and refuses a reused id', async () => {
    const f = await fixture();
    const first = await f.ask('bob', 'req_1', 'job', 'job_1').catch((error) => error);
    expect(first).toMatchObject({ code: 'unknown_job' });
    await f.open('job_1');
    const asked = await f.ask('bob', 'req_1', 'job', 'job_1');
    expect(await f.ask('bob', 'req_1', 'job', 'job_1')).toEqual(asked);
    expect(await f.ask('bob', 'req_other', 'job', 'job_1')).toEqual(asked);
    expect(await refusal(f.ask('bob', 'req_1', 'month'))).toMatchObject({ status: 409, code: 'limit_request_conflict' });
    expect(await refusal(f.ask('dave', 'req_1', 'job', 'job_1'))).toMatchObject({ status: 409, code: 'limit_request_conflict' });
    expect(await f.limits.requests({ ...f.ref, actor: f.actor('alice') })).toHaveLength(1);
    // A decision is final: asking the same question again returns what was decided.
    const decided = await f.decide('alice', 'req_1', false);
    expect(decided).toMatchObject({ state: 'denied', extraMicroUsd: null, allowPurchased: false });
    expect(await f.decide('alice', 'req_1', true)).toEqual(decided);
    expect(await f.decide('alice', 'req_1', false)).toEqual(decided);
  });

  it('lets an admin decide a member’s request, never an admin’s, an owner’s or their own', async () => {
    const f = await fixture();
    await f.open('job_1');
    await f.ask('carol', 'req_admin', 'job', 'job_1');
    expect(await refusal(f.decide('erin', 'req_admin', true))).toMatchObject({ status: 403, code: 'owner_required' });
    expect(await refusal(f.decide('carol', 'req_admin', true))).toMatchObject({ status: 403, code: 'owner_required' });
    expect(await f.decide('alice', 'req_admin', true)).toMatchObject({ state: 'approved' });
    await f.ask('bob', 'req_member', 'job', 'job_1');
    expect(await f.decide('erin', 'req_member', true)).toMatchObject({ state: 'approved', decidedBy: f.people.erin.id });
  });

  it('refuses a member who tries to decide, set a limit or read what is not theirs', async () => {
    const f = await fixture();
    await f.open('job_1');
    await f.ask('bob', 'req_1', 'job', 'job_1');
    expect(await refusal(f.decide('dave', 'req_1', true))).toMatchObject({ status: 403, code: 'not_authorized' });
    expect(await refusal(f.decide('bob', 'req_1', true))).toMatchObject({ status: 403, code: 'not_authorized' });
    expect(await refusal(f.setLimit('bob', 'bob', 'unlimited'))).toMatchObject({ status: 403, code: 'not_authorized' });
    expect(await refusal(f.setRole('dave', 'member', 'unlimited'))).toMatchObject({ status: 403, code: 'not_authorized' });
    expect(await refusal(f.limits.limits({ ...f.ref, actor: f.actor('bob') }))).toMatchObject({ code: 'not_authorized' });
    expect(await refusal(f.limits.report({ ...f.ref, actor: f.actor('bob'), people: [] }))).toMatchObject({ code: 'not_authorized' });
    // A member sees their own requests and nobody else's.
    expect((await f.limits.requests({ ...f.ref, actor: f.actor('dave') }))).toEqual([]);
    expect((await f.limits.requests({ ...f.ref, actor: f.actor('bob') })).map((row) => row.requestId)).toEqual(['req_1']);
  });

  it('lets an admin set a limit for a member but not for an admin or an owner; only an owner may', async () => {
    const f = await fixture();
    await expect(f.setLimit('carol', 'bob', 'limit', 10)).resolves.toMatchObject({ mode: 'limit', updatedBy: f.people.carol.id });
    await expect(f.setRole('carol', 'member', 'limit', 50)).resolves.toMatchObject({ mode: 'limit' });
    expect(await refusal(f.setLimit('carol', 'erin', 'limit', 10))).toMatchObject({ code: 'owner_required' });
    expect(await refusal(f.setLimit('carol', 'carol', 'unlimited'))).toMatchObject({ code: 'owner_required' });
    expect(await refusal(f.setLimit('carol', 'alice', 'limit', 10))).toMatchObject({ code: 'owner_required' });
    expect(await refusal(f.setRole('carol', 'admin', 'limit', 10))).toMatchObject({ code: 'owner_required' });
    await expect(f.setLimit('alice', 'erin', 'limit', 10)).resolves.toMatchObject({ mode: 'limit' });
    // A limit is a number of credits or one of the two words; nothing else.
    expect(await refusal(f.setLimit('alice', 'bob', 'limit', null))).toMatchObject({ code: 'invalid_amount' });
    expect(await refusal(limitsWithAmount(f))).toMatchObject({ code: 'invalid_amount' });
  });
});

function limitsWithAmount(f: Awaited<ReturnType<typeof fixture>>) {
  return f.limits.setLimit({ ...f.ref, actor: f.actor('alice'), subject: { kind: 'person', personId: f.people.bob.id }, targetRole: 'member', mode: 'unlimited', limitMicroUsd: c(5) });
}

describe('the account API', () => {
  it('lets an owner read the limits, with the default read from the plan', async () => {
    const f = await fixture();
    await f.setRole('alice', 'member', 'limit', 40);
    await f.setLimit('alice', 'bob', 'unlimited');
    const answer = await f.call('/credit-limits', 'alice');
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      organizationId: f.organization.id, periodId: '2026-09', planId: 'business', defaultMemberLimitMicroUsd: c(1000),
      roles: [{ role: 'member', mode: 'limit', limitMicroUsd: c(40), effectiveMicroUsd: c(40), source: 'role' },
        { role: 'admin', mode: 'inherit', limitMicroUsd: null, effectiveMicroUsd: null, source: 'default' }],
      people: [{ personId: f.people.bob.id, mode: 'unlimited', limitMicroUsd: null }],
      settings: { membersSeeOwnUsage: true, adminsSeeMemberUsage: true },
    });
    expect((await f.call('/credit-limits', 'bob')).status).toBe(403);
    expect((await f.call('/credit-limits', 'mallory')).status).toBe(403);
    expect((await f.call('/credit-limits', null)).status).toBe(401);
  });

  it('changes a limit by role and by person through the API, reading the person’s role from the roster', async () => {
    const f = await fixture();
    const set = (token: string, body: unknown) => f.call('/credit-limits', token, { method: 'POST', body });
    expect((await set('alice', { subject: { kind: 'role', role: 'member' }, mode: 'limit', limitMicroUsd: c(60) })).status).toBe(200);
    expect((await set('carol', { subject: { kind: 'person', personId: f.people.bob.id }, mode: 'limit', limitMicroUsd: c(10) })).status).toBe(200);
    const adminTarget = await set('carol', { subject: { kind: 'person', personId: f.people.erin.id }, mode: 'limit', limitMicroUsd: c(10) });
    expect(adminTarget.status).toBe(403);
    expect((await adminTarget.json()).code).toBe('owner_required');
    expect((await set('bob', { subject: { kind: 'role', role: 'member' }, mode: 'unlimited' })).status).toBe(403);
    const stranger = await set('alice', { subject: { kind: 'person', personId: 'person_nobody' }, mode: 'limit', limitMicroUsd: c(10) });
    expect(stranger.status).toBe(404);
    // Nothing a client sends can name the business, the actor or a figure the server believes.
    for (const forged of [{ organizationId: 'org_other' }, { tenantId: 't' }, { by: 'x' }, { usedMicroUsd: 0 }])
      expect((await set('alice', { subject: { kind: 'role', role: 'member' }, mode: 'unlimited', ...forged })).status, JSON.stringify(forged)).toBe(422);
    expect((await set('alice', { subject: { kind: 'role', role: 'owner' }, mode: 'unlimited' })).status).toBe(422);
    expect((await set('alice', { subject: { kind: 'role', role: 'member' }, mode: 'limit', limitMicroUsd: -1 })).status).toBe(422);
  });

  it('answers a member their own usage against their own limit, and never the pool or anyone else', async () => {
    const f = await fixture();
    await f.setLimit('alice', 'bob', 'limit', 50);
    await f.spend('bob', 'b1', 20);
    await f.spend('dave', 'd1', 10);
    const own = await (await f.call('/credit-usage/mine', 'bob')).json();
    expect(own).toEqual({
      state: 'ready', organizationId: f.organization.id, periodId: '2026-09', resetsAt: '2026-10-01T00:00:00.000Z',
      usage: { usedMicroUsd: c(20), includedMicroUsd: c(20), purchasedMicroUsd: 0, heldMicroUsd: 0 }, limitMicroUsd: c(50), raisedByMicroUsd: 0, requests: [],
    });
    const text = JSON.stringify(own);
    expect(text).not.toContain(f.people.dave.id);
    expect(text).not.toMatch(/pool|available|granted|purchased balance/i);
    // The report is for owners and admins.
    expect((await f.call('/credit-usage/members', 'bob')).status).toBe(403);
    expect((await f.call('/credit-usage/members', 'dave')).status).toBe(403);
  });

  it('answers an owner or admin who used what this month, in micro-USD, for everyone including those who used nothing', async () => {
    const f = await fixture();
    await f.setLimit('alice', 'bob', 'limit', 50);
    await f.spend('bob', 'b1', 20);
    await f.spend('dave', 'd1', 10);
    await f.reserve('dave', 'd2', 5, 'job_d2');
    for (const token of ['alice', 'carol']) {
      const answer = await f.call('/credit-usage/members', token);
      expect(answer.status).toBe(200);
      const report = await answer.json();
      expect(report).toMatchObject({ organizationId: f.organization.id, periodId: '2026-09', startsAt: '2026-09-01T00:00:00.000Z', resetsAt: '2026-10-01T00:00:00.000Z' });
      const byPerson = Object.fromEntries(report.members.map((member: { personId: string }) => [member.personId, member]));
      expect(byPerson[f.people.bob.id]).toMatchObject({ role: 'member', usage: { usedMicroUsd: c(20), includedMicroUsd: c(20) }, limitMicroUsd: c(50), limitSource: 'person' });
      expect(byPerson[f.people.dave.id]).toMatchObject({ usage: { usedMicroUsd: c(15), heldMicroUsd: c(5) }, limitMicroUsd: c(1000), limitSource: 'default' });
      expect(byPerson[f.people.alice.id]).toMatchObject({ role: 'owner', usage: { usedMicroUsd: 0 }, limitMicroUsd: null });
      expect(JSON.stringify(report)).not.toMatch(/dollar|"usd"|\$/i);
    }
  });

  it('asks and decides through the API, and an approval reaches the next admission', async () => {
    const f = await fixture();
    await f.setLimit('alice', 'bob', 'limit', 20);
    await f.spend('bob', 'a1', 20);
    await f.open('job_2');
    const asked = await f.call('/credit-limit-requests', 'bob', { method: 'POST', body: { requestId: 'req_1', kind: 'job', jobId: 'job_2' } });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toMatchObject({ requestId: 'req_1', personId: f.people.bob.id, kind: 'job', jobId: 'job_2', state: 'pending' });
    // The asker cannot answer; a body cannot name a different person, a figure or a business.
    expect((await f.call('/credit-limit-requests/req_1/decision', 'bob', { method: 'POST', body: { approve: true } })).status).toBe(403);
    for (const forged of [{ personId: f.people.dave.id }, { extraMicroUsd: c(1000), kind: 'month' }, { organizationId: 'org_other' }])
      expect((await f.call('/credit-limit-requests', 'bob', { method: 'POST', body: { requestId: 'req_9', kind: 'month', ...forged } })).status, JSON.stringify(forged)).toBe(422);
    // Owners and admins list everything, and a member lists only their own.
    expect((await (await f.call('/credit-limit-requests', 'alice')).json()).requests).toHaveLength(1);
    expect((await (await f.call('/credit-limit-requests', 'dave')).json()).requests).toEqual([]);
    expect((await (await f.call('/credit-limit-requests', 'bob')).json()).requests).toHaveLength(1);
    const decided = await f.call('/credit-limit-requests/req_1/decision', 'alice', { method: 'POST', body: { approve: true } });
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ state: 'approved', extraMicroUsd: c(20), decidedBy: f.people.alice.id });
    await expect(f.reserve('bob', 'a2', 15, 'job_2')).resolves.toMatchObject({ state: 'pending' });
    expect((await f.call('/credit-limit-requests/req_nope/decision', 'alice', { method: 'POST', body: { approve: true } })).status).toBe(404);
  });

  it('lets only an owner change who sees what, and the setting is honoured', async () => {
    const f = await fixture();
    const change = (token: string, body: unknown) => f.call('/credit-limits/settings', token, { method: 'POST', body });
    expect((await change('carol', { adminsSeeMemberUsage: false })).status).toBe(403);
    expect((await change('bob', { membersSeeOwnUsage: false })).status).toBe(403);
    expect((await change('alice', {})).status).toBe(422);
    expect((await change('alice', { membersSeeOwnUsage: false, adminsSeeMemberUsage: false })).status).toBe(200);
    expect(await (await f.call('/credit-usage/mine', 'bob')).json()).toEqual({ state: 'hidden', organizationId: f.organization.id, reason: 'This business doesn’t show members their usage.' });
    expect((await f.call('/credit-usage/members', 'carol')).status).toBe(403);
    expect((await f.call('/credit-usage/members', 'alice')).status).toBe(200);
    // An owner always sees their own, even with members hidden.
    expect((await (await f.call('/credit-usage/mine', 'alice')).json()).state).toBe('ready');
  });

  it('answers 503 when the funding login is not configured, instead of writing as the Worker login', async () => {
    const { accounts } = setup();
    const organization = await accounts.createOrganization('alice', 'Fernbrook Joinery');
    const handler = createHandler(() => accounts);
    const answer = await handler(new Request(`http://127.0.0.1:8791/account/organizations/${organization.id}/credit-limits`, { headers: { origin: 'http://127.0.0.1:8791', authorization: 'Bearer alice' } }), validEnv);
    expect(answer.status).toBe(503);
    expect(await answer.text()).not.toMatch(/MicroUsd/);
  });
});
