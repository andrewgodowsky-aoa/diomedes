/**
 * Purchased-usage holds (Andrew, 2026-10-01: "if usage is bought outright its allowed to be reserved").
 *
 * A person asks the account service, with their own session, to hold some of the credits their
 * business bought outright. The hold draws only on recorded top-ups: never on the monthly
 * included grant, never on a figure in the request. Offline memory adapters only.
 */
import { describe, expect, it } from 'vitest';
import { creditAmount } from '../../../shared/managed-usage.js';
import { createHandler } from '../src/worker.js';
import { FundingService, PurchasedUsageService, UsageService } from '../src/funding.js';
import { FundingMemoryRepository } from './support/funding-memory.js';
import { now, setup, validEnv } from './support/fixtures.js';

function request(path: string, init: RequestInit & { token?: string | null } = {}) {
  const { token = 'alice', ...rest } = init;
  const headers: Record<string, string> = { origin: 'http://127.0.0.1:8791', ...(rest.headers as Record<string, string> | undefined) };
  if (rest.body !== undefined) headers['content-type'] = 'application/json';
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`http://127.0.0.1:8791${path}`, { ...rest, headers });
}

async function fixture(options: { purchased?: number; month?: boolean } = {}) {
  const { accounts } = setup();
  const organization = await accounts.createOrganization('alice', 'Fernbrook Joinery');
  const invite = await accounts.invite('alice', organization.id, { subject: 'user_bob', role: 'member', ttlMs: 5000 });
  await accounts.acceptInvitation('bob', organization.id, invite.token);
  const repository = new FundingMemoryRepository();
  const funding = new FundingService(repository, { now: () => now });
  const ref = { tenantId: organization.tenantId, organizationId: organization.id };
  if (options.month !== false)
    await funding.allocatePeriod({ ...ref, periodId: '2026-09', planId: 'business', sourceGrantId: 'grant_fixture' });
  if (options.purchased)
    await funding.recordTopUp({ ...ref, topUpId: 'topup_1', amountMicroUsd: creditAmount(options.purchased), provider: 'stripe', sourceEventId: 'evt_topup_1' });
  const handler = createHandler(() => accounts, (_config, account) => new UsageService(account, funding), {
    createPurchased: (_config, account) => new PurchasedUsageService(account, funding),
  });
  const base = `/account/organizations/${organization.id}/purchased-usage`;
  const hold = (body: unknown, token = 'alice') => handler(request(`${base}/holds`, { method: 'POST', token, body: JSON.stringify(body) }), validEnv);
  const settle = (body: unknown, token = 'alice') => handler(request(`${base}/settlements`, { method: 'POST', token, body: JSON.stringify(body) }), validEnv);
  const release = (body: unknown, token = 'alice') => handler(request(`${base}/releases`, { method: 'POST', token, body: JSON.stringify(body) }), validEnv);
  const balance = (token = 'alice') => handler(request(base, { token }), validEnv);
  return { accounts, organization, repository, funding, handler, ref, hold, settle, release, balance, base };
}

const ask = (overrides: Record<string, unknown> = {}) => ({ holdId: 'hold_1', amountMicroUsd: creditAmount(40), requestDigest: 'digest-one', ...overrides });

describe('holding bought usage', () => {
  it('holds against the top-up balance and never touches the month', async () => {
    const { hold, funding, ref, repository } = await fixture({ purchased: 100 });
    const before = await funding.projection(ref.tenantId, ref.organizationId);
    const answer = await hold(ask());
    expect(answer.status).toBe(200);
    const body = await answer.json();
    expect(body).toMatchObject({ holdId: 'hold_1', state: 'held', amountMicroUsd: creditAmount(40), balance: { purchasedMicroUsd: creditAmount(100), heldMicroUsd: creditAmount(40), settledMicroUsd: 0, availableMicroUsd: creditAmount(60) } });

    const after = await funding.projection(ref.tenantId, ref.organizationId);
    if (before.state !== 'ready' || after.state !== 'ready') throw new Error('The month should be funded.');
    // The month is exactly as it was: nothing pending, nothing settled, the whole grant still available.
    expect(after.projection.pendingMicroUsd).toBe(0);
    expect(after.projection.settledMicroUsd).toBe(0);
    expect(after.projection.availableMicroUsd).toBe(before.projection.availableMicroUsd);
    expect(after.projection.topUp).toMatchObject({ heldMicroUsd: creditAmount(40), availableMicroUsd: creditAmount(60) });
    // No funded attempt, job or settlement was written.
    const rows = repository.snapshot();
    expect([rows.attempts.length, rows.jobs.length, rows.settlements.length]).toEqual([0, 0, 0]);
  });

  it('refuses a business that has bought nothing, even with a full month, and holds nothing', async () => {
    const { hold, repository, funding, ref } = await fixture();
    const answer = await hold(ask());
    expect(answer.status).toBe(402);
    const body = await answer.json();
    expect(body.code).toBe('no_purchased_usage');
    expect(body.error).toMatch(/Nothing was held\.$/);
    expect(body.error).toMatch(/included usage/i);
    expect(repository.snapshot().topUpHolds).toEqual([]);
    const state = await funding.projection(ref.tenantId, ref.organizationId);
    if (state.state !== 'ready') throw new Error('The month should be funded.');
    expect(state.projection.availableMicroUsd).toBe(creditAmount(1000));
  });

  it('refuses more than the bought balance has free, naming the amounts', async () => {
    const { hold, repository } = await fixture({ purchased: 100 });
    const answer = await hold(ask({ amountMicroUsd: creditAmount(150) }));
    expect(answer.status).toBe(402);
    const body = await answer.json();
    expect(body.code).toBe('insufficient_purchased_usage');
    expect(body.error).toMatch(/150/);
    expect(body.error).toMatch(/100/);
    expect(body.error).toMatch(/Nothing was held\.$/);
    expect(repository.snapshot().topUpHolds).toEqual([]);
  });

  it('counts what is already held: a second hold sees the first', async () => {
    const { hold } = await fixture({ purchased: 100 });
    expect((await hold(ask({ holdId: 'hold_a', amountMicroUsd: creditAmount(70) }))).status).toBe(200);
    const second = await hold(ask({ holdId: 'hold_b', amountMicroUsd: creditAmount(40), requestDigest: 'digest-two' }));
    expect(second.status).toBe(402);
    expect((await second.json()).code).toBe('insufficient_purchased_usage');
  });

  it('is idempotent by hold id: a retry finds the same hold and holds once', async () => {
    const { hold, balance, repository } = await fixture({ purchased: 100 });
    const first = await (await hold(ask())).json();
    const again = await hold(ask());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(repository.snapshot().topUpHolds).toHaveLength(1);
    expect((await (await balance()).json()).heldMicroUsd).toBe(creditAmount(40));
  });

  it('does not hold again for a retry after the hold was settled or released', async () => {
    const { hold, settle, release, balance } = await fixture({ purchased: 100 });
    await hold(ask({ holdId: 'hold_a' }));
    await settle({ holdId: 'hold_a', debitMicroUsd: creditAmount(10) });
    await hold(ask({ holdId: 'hold_b', requestDigest: 'digest-two' }));
    await release({ holdId: 'hold_b' });
    for (const [holdId, requestDigest] of [['hold_a', 'digest-one'], ['hold_b', 'digest-two']]) {
      const again = await hold(ask({ holdId, requestDigest }));
      expect(again.status).toBe(409);
      expect((await again.json()).code).toBe('hold_closed');
    }
    expect(await (await balance()).json()).toMatchObject({ heldMicroUsd: 0, settledMicroUsd: creditAmount(10), availableMicroUsd: creditAmount(90) });
  });

  it('refuses a hold id reused for different terms, and by somebody else', async () => {
    const { hold, repository } = await fixture({ purchased: 100 });
    await hold(ask());
    const other = await hold(ask({ amountMicroUsd: creditAmount(10) }));
    expect(other.status).toBe(409);
    expect((await other.json()).code).toBe('hold_conflict');
    const bob = await hold(ask(), 'bob');
    expect(bob.status).toBe(409);
    expect(repository.snapshot().topUpHolds).toHaveLength(1);
  });

  it('reads the balance from recorded top-ups only: a figure in the request is refused, and cannot widen a hold', async () => {
    const { hold, repository } = await fixture({ purchased: 100 });
    for (const forged of [{ purchasedMicroUsd: creditAmount(10_000) }, { balanceMicroUsd: creditAmount(10_000) }, { topUpMicroUsd: creditAmount(10_000) }, { monthly: true }, { organizationId: 'org_other' }, { tenantId: 'tenant_other' }]) {
      const answer = await hold(ask({ amountMicroUsd: creditAmount(500), ...forged }));
      expect(answer.status).toBe(422);
    }
    // Asking for more than was bought is refused whatever else the body says it has.
    expect((await hold(ask({ amountMicroUsd: creditAmount(500) }))).status).toBe(402);
    expect(repository.snapshot().topUpHolds).toEqual([]);
  });

  it('validates what it is given', async () => {
    const { hold } = await fixture({ purchased: 100 });
    for (const bad of [{ amountMicroUsd: 0 }, { amountMicroUsd: -5 }, { amountMicroUsd: 1.5 }, { amountMicroUsd: '40' }, { amountMicroUsd: Number.MAX_SAFE_INTEGER + 1 }, { holdId: '' }, { holdId: 'has space' }, { requestDigest: '' }, { requestDigest: 'x'.repeat(201) }])
      expect((await hold(ask(bad))).status, JSON.stringify(bad)).toBe(422);
    expect((await hold({ holdId: 'hold_1' })).status).toBe(422);
  });

  it('refuses a person who is not an active member, without revealing whether the business exists', async () => {
    const { hold, repository, base, handler } = await fixture({ purchased: 100 });
    const outsider = await hold(ask(), 'mallory');
    expect(outsider.status).toBe(403);
    expect(await outsider.text()).not.toMatch(/MicroUsd|purchased/);
    const missing = await handler(request('/account/organizations/org_missing/purchased-usage/holds', { method: 'POST', token: 'mallory', body: JSON.stringify(ask()) }), validEnv);
    expect(missing.status).toBe(403);
    expect((await handler(request(base, { token: 'mallory' }), validEnv)).status).toBe(403);
    expect((await handler(request(`${base}/holds`, { method: 'POST', token: null, body: JSON.stringify(ask()) }), validEnv)).status).toBe(401);
    expect(repository.snapshot().topUpHolds).toEqual([]);
  });
});

describe('settling and releasing a hold', () => {
  it('settles to a debit on the top-up balance only, and the rest is free again', async () => {
    const { hold, settle, balance, funding, ref, repository } = await fixture({ purchased: 100 });
    await hold(ask());
    const answer = await settle({ holdId: 'hold_1', debitMicroUsd: creditAmount(25) });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ holdId: 'hold_1', state: 'settled', debitMicroUsd: creditAmount(25), balance: { heldMicroUsd: 0, settledMicroUsd: creditAmount(25), availableMicroUsd: creditAmount(75) } });
    expect(await (await balance()).json()).toEqual({ purchasedMicroUsd: creditAmount(100), heldMicroUsd: 0, settledMicroUsd: creditAmount(25), availableMicroUsd: creditAmount(75) });

    const state = await funding.projection(ref.tenantId, ref.organizationId);
    if (state.state !== 'ready') throw new Error('The month should be funded.');
    expect(state.projection.settledMicroUsd).toBe(0);
    expect(state.projection.availableMicroUsd).toBe(creditAmount(1000));
    expect(repository.snapshot().settlements).toEqual([]);
  });

  it('replays a settlement, and refuses a different one', async () => {
    const { hold, settle, balance } = await fixture({ purchased: 100 });
    await hold(ask());
    const first = await (await settle({ holdId: 'hold_1', debitMicroUsd: creditAmount(25) })).json();
    const again = await settle({ holdId: 'hold_1', debitMicroUsd: creditAmount(25) });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    const different = await settle({ holdId: 'hold_1', debitMicroUsd: creditAmount(30) });
    expect(different.status).toBe(409);
    expect((await different.json()).code).toBe('settlement_conflict');
    expect((await (await balance()).json()).settledMicroUsd).toBe(creditAmount(25));
  });

  it('never debits more than was held, and a zero debit gives it all back', async () => {
    const { hold, settle, balance } = await fixture({ purchased: 100 });
    await hold(ask());
    const over = await settle({ holdId: 'hold_1', debitMicroUsd: creditAmount(41) });
    expect(over.status).toBe(409);
    expect((await over.json()).code).toBe('settlement_exceeds_hold');
    expect((await (await balance()).json()).heldMicroUsd).toBe(creditAmount(40));
    expect((await settle({ holdId: 'hold_1', debitMicroUsd: 0 })).status).toBe(200);
    expect(await (await balance()).json()).toMatchObject({ heldMicroUsd: 0, settledMicroUsd: 0, availableMicroUsd: creditAmount(100) });
  });

  it('releases an unused hold, and refuses to release a settled one or settle a released one', async () => {
    const { hold, settle, release, balance } = await fixture({ purchased: 100 });
    await hold(ask({ holdId: 'hold_a' }));
    await hold(ask({ holdId: 'hold_b', requestDigest: 'digest-two' }));
    expect((await release({ holdId: 'hold_a' })).status).toBe(200);
    expect((await release({ holdId: 'hold_a' })).status, 'a release replays').toBe(200);
    expect((await settle({ holdId: 'hold_a', debitMicroUsd: 1 })).status).toBe(409);
    await settle({ holdId: 'hold_b', debitMicroUsd: creditAmount(5) });
    expect((await release({ holdId: 'hold_b' })).status).toBe(409);
    expect(await (await balance()).json()).toMatchObject({ heldMicroUsd: 0, settledMicroUsd: creditAmount(5), availableMicroUsd: creditAmount(95) });
  });

  it('answers 404 for a hold that is unknown, someone else’s, or another business’s', async () => {
    const { hold, settle, release, handler, accounts } = await fixture({ purchased: 100 });
    await hold(ask());
    expect((await settle({ holdId: 'hold_nope', debitMicroUsd: 1 })).status).toBe(404);
    expect((await settle({ holdId: 'hold_1', debitMicroUsd: 1 }, 'bob')).status, 'another member’s hold').toBe(404);
    expect((await release({ holdId: 'hold_1' }, 'bob')).status).toBe(404);
    // A hold in one business cannot be reached through another the same person belongs to.
    const second = await accounts.createOrganization('alice', 'Harbor Bakery');
    const through = await handler(request(`/account/organizations/${second.id}/purchased-usage/settlements`, { method: 'POST', body: JSON.stringify({ holdId: 'hold_1', debitMicroUsd: 1 }) }), validEnv);
    expect(through.status).toBe(404);
  });

  it('is not reachable by a settle body that names a balance or an organization', async () => {
    const { hold, settle } = await fixture({ purchased: 100 });
    await hold(ask());
    for (const extra of [{ purchasedMicroUsd: 1 }, { organizationId: 'org_other' }, { state: 'settled' }])
      expect((await settle({ holdId: 'hold_1', debitMicroUsd: 1, ...extra })).status).toBe(422);
  });
});

describe('the funded-attempt path sees what is held', () => {
  it('a purchased hold takes the balance a funded attempt would otherwise draw on', async () => {
    const { hold, funding, ref } = await fixture({ purchased: 100 });
    await hold(ask({ amountMicroUsd: creditAmount(100) }));
    const state = await funding.projection(ref.tenantId, ref.organizationId);
    if (state.state !== 'ready') throw new Error('The month should be funded.');
    expect(state.projection.topUp.availableMicroUsd).toBe(0);
    expect(state.projection.topUp.heldMicroUsd).toBe(creditAmount(100));
  });
});

describe('the worker keeps its funding writes narrow', () => {
  it('answers 503 when the funding login is not configured, instead of writing as the Worker login', async () => {
    const { accounts, organization } = await (async () => {
      const { accounts } = setup();
      return { accounts, organization: await accounts.createOrganization('alice', 'Fernbrook Joinery') };
    })();
    const handler = createHandler(() => accounts);
    const answer = await handler(request(`/account/organizations/${organization.id}/purchased-usage/holds`, { method: 'POST', body: JSON.stringify(ask()) }), validEnv);
    expect(answer.status).toBe(503);
    expect((await answer.text())).not.toMatch(/MicroUsd/);
  });
});
