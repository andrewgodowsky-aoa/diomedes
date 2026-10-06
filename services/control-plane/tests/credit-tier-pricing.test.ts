/**
 * Credit prices by tier (Model B): settlement from the charge, the gateway's checks against the
 * published table, and staff publishing. Every price and ceiling here is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { creditAmount, usageCost, type RateSnapshot } from '../../../shared/managed-usage.js';
import { chargeHold, chargeSnapshot, type ChargeSnapshot, type CreditPriceTable } from '../../../shared/credit-prices.js';
import { inputTokenBound } from '../../../shared/job-caps.js';
import { FundingError, FundingService } from '../src/funding.js';
import { FundingMemoryRepository } from './support/funding-memory.js';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_CREDIT_CHARGE, FAUX_CREDIT_PRICES, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';
import { MANAGED_PROVIDERS, scriptedResponsesFetch } from '../src/managed-providers.js';
import { providerSpy, readAll, type ProviderRequest, type ProviderSpy } from './support/managed.js';

// --- settlement ---------------------------------------------------------------------------------

const T = 'tenant_1';
const O = 'org_1';
// The provider: $1 per million of every token kind. 100,000 tokens cost 100,000 micro-USD.
const RATE: RateSnapshot = {
  version: 'fixture-rate-1', inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 1_000_000, cacheWriteMicroUsdPerMillion: 1_000_000,
};
// The tier charge: three ledger units per token, so 100,000 tokens debit three credits. Synthetic.
const TABLE: CreditPriceTable = {
  v: 1, version: 4, ceilingMicroUsdPerCredit: 50_000, note: 'Synthetic.', publishedAt: '2026-09-01T00:00:00.000Z', publishedBy: 'person_staff',
  tiers: {
    efficient: { inputMicroUsdPerMillion: 3_000_000, outputMicroUsdPerMillion: 3_000_000, cacheReadMicroUsdPerMillion: 3_000_000, cacheWriteMicroUsdPerMillion: 3_000_000 },
    focused: null, thorough: null,
  },
};
const CHARGE: ChargeSnapshot = chargeSnapshot(TABLE, 'efficient')!;
const tokens = (count: number) => ({ inputTokens: count, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });

function harness() {
  const repository = new FundingMemoryRepository();
  const service = new FundingService(repository, { now: () => Date.parse('2026-09-10T12:00:00.000Z') });
  const open = (rootJobId: string) =>
    service.openJob({ tenantId: T, organizationId: O, rootJobId, runRef: `run_${rootJobId}`, parentRunRef: null, tier: 'efficient', capMicroUsd: null });
  const reserve = (attemptId: string, maxMicroUsd: number, over: Record<string, unknown> = {}) => service.reserve({
    tenantId: T, organizationId: O, attemptId, rootJobId: 'job_1', parentAttemptId: null, kind: 'generation', route: 'aws-bedrock',
    requestDigest: `digest_${attemptId}`, rateSnapshot: RATE, maxMicroUsd: maxMicroUsd as never, usageClass: 'metered-work', ...over,
  });
  const ref = (attemptId: string) => ({ tenantId: T, organizationId: O, attemptId });
  const settle = (attemptId: string, count: number) =>
    service.settle({ ...ref(attemptId), receiptRef: `receipt_${attemptId}`, usage: tokens(count), reconciledFrom: 'response' });
  return { repository, service, open, reserve, ref, settle };
}

describe('settling under a tier charge', () => {
  it('debits the charge, month first then bought credits, and records the provider cost beside it', async () => {
    const h = harness();
    await h.service.allocatePeriod({ tenantId: T, organizationId: O, periodId: '2026-09', planId: 'workflow-starter', sourceGrantId: 'grant_1' });
    await h.service.recordTopUp({ tenantId: T, organizationId: O, topUpId: 'topup_1', amountMicroUsd: creditAmount(50), provider: 'stripe', sourceEventId: 'evt_1' });
    // Use all but 5 of the month's 500 credits on old-style attempts, which debit provider cost.
    for (let index = 0; index < 33; index++) {
      await h.open(`fill_${index}`);
      await h.reserve(`fill_${index}`, creditAmount(15), { rootJobId: `fill_${index}` });
      await h.service.markDispatched(h.ref(`fill_${index}`));
      await h.settle(`fill_${index}`, 1_500_000);
    }
    await h.open('job_1');
    const attempt = await h.reserve('charged', creditAmount(12), { chargeSnapshot: CHARGE });
    expect(attempt.chargeSnapshot).toEqual(CHARGE);
    expect(attempt).toMatchObject({ monthlyHoldMicroUsd: creditAmount(5), topUpHoldMicroUsd: creditAmount(7) });
    await h.service.markDispatched(h.ref('charged'));
    // 300,000 tokens: 9 credits charged; the provider's cost is 300,000 micro-USD.
    const settled = await h.settle('charged', 300_000);
    expect(settled.outcome).toBe('settled');
    if (settled.outcome !== 'settled') return;
    expect(usageCost(CHARGE, tokens(300_000))).toBe(creditAmount(9));
    expect(settled.settlement).toMatchObject({
      allowanceDebitMicroUsd: creditAmount(9), providerCostMicroUsd: usageCost(RATE, tokens(300_000)),
      monthlyDebitMicroUsd: creditAmount(5), topUpDebitMicroUsd: creditAmount(4),
    });
    expect(settled.settlement.providerCostMicroUsd).toBe(300_000);
  });

  it('settles an attempt held before tier pricing exactly as before: the debit is the provider cost', async () => {
    const h = harness();
    await h.service.allocatePeriod({ tenantId: T, organizationId: O, periodId: '2026-09', planId: 'business', sourceGrantId: 'grant_1' });
    await h.open('job_1');
    const attempt = await h.reserve('old', creditAmount(5));
    expect(attempt.chargeSnapshot).toBeUndefined();
    await h.service.markDispatched(h.ref('old'));
    const settled = await h.settle('old', 300_000);
    expect(settled).toMatchObject({ outcome: 'settled', settlement: { allowanceDebitMicroUsd: 300_000, providerCostMicroUsd: 300_000 } });
  });

  it('keeps a hold uncertain when the charge passes it, never clamped', async () => {
    const h = harness();
    await h.service.allocatePeriod({ tenantId: T, organizationId: O, periodId: '2026-09', planId: 'business', sourceGrantId: 'grant_1' });
    await h.open('job_1');
    // Enough for the provider's cost of 300,000 tokens, not for their charge.
    await h.reserve('short', creditAmount(5), { chargeSnapshot: CHARGE });
    await h.service.markDispatched(h.ref('short'));
    expect(await h.settle('short', 300_000)).toMatchObject({ outcome: 'held' });
  });

  it('binds a replayed reservation to its charge: the same id under another charge is a conflict', async () => {
    const h = harness();
    await h.service.allocatePeriod({ tenantId: T, organizationId: O, periodId: '2026-09', planId: 'business', sourceGrantId: 'grant_1' });
    await h.open('job_1');
    await h.reserve('a', creditAmount(5), { chargeSnapshot: CHARGE });
    expect(await h.reserve('a', creditAmount(5), { chargeSnapshot: CHARGE })).toMatchObject({ chargeSnapshot: CHARGE });
    const conflict = await h.reserve('a', creditAmount(5), { chargeSnapshot: { ...CHARGE, version: 'credit-prices:5:efficient', tableVersion: 5 } }).catch(e => e);
    expect(conflict).toBeInstanceOf(FundingError);
    expect((conflict as FundingError).code).toBe('attempt_conflict');
    const unpriced = await h.reserve('b', creditAmount(5), { chargeSnapshot: { ...CHARGE, inputMicroUsdPerMillion: 1.5 } }).catch(e => e);
    expect((unpriced as FundingError).code).toBe('invalid_charge');
  });
});

// --- the gateway and staff publishing, through the faux cloud's real handler --------------------

const LUNA = MANAGED_PROVIDERS[0];
let clock = Date.parse('2026-09-25T12:00:00.000Z');
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let spy: ProviderSpy;
const scripted = scriptedResponsesFetch({ now: () => clock });

beforeEach(async () => {
  clock = Date.parse('2026-09-25T12:00:00.000Z');
  spy = providerSpy((request: ProviderRequest) => scripted(request.url, { method: 'POST', headers: request.headers, body: request.rawBody }));
  cloud = await createFauxCloud({ file: null, now: () => clock, passwordIterations: 1_000, managed: { transport: spy.fetch, credential: 'ABSK-fixture-credential', settings: {} } });
  orgs = (await seedDemo(cloud)).organizations!;
});
afterEach(async () => { await cloud.idle(); vi.restoreAllMocks(); });

async function call(method: string, pathname: string, token?: string, body?: unknown) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await cloud.handle(new Request(`http://127.0.0.1:8795${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function signIn(who: DemoAccount) {
  return (await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD })).body.accessToken as string;
}
const chatBody = () => ({ model: LUNA.model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello.' }] }],
  store: false, stream: true, max_output_tokens: 1_000 });
async function ask(tier = 'efficient', attempt = 'run-1:1') {
  const token = await signIn('employee');
  const admission = await call('POST', `/account/organizations/${orgs.juniper}/agent-admissions`, token, { surface: 'conversation', routeKind: 'managed', rootJobId: 'run-1' });
  expect(admission.status).toBe(200);
  return cloud.handle(new Request('http://127.0.0.1:8795/managed/v1/responses', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-nectovia-organization': orgs.juniper,
    'x-nectovia-admission': admission.body.admissionId, 'x-nectovia-job': 'run-1', 'x-nectovia-attempt': attempt,
    'x-nectovia-tier': tier, 'x-nectovia-usage-class': 'included-chat', 'x-nectovia-policy-revision': '1',
  }, body: JSON.stringify(chatBody()) }));
}
async function refusal(response: Response) {
  const body = await response.json() as { error: { code: string; message: string } };
  return { status: response.status, ...body.error };
}
const attempts = () => cloud.store.snapshot().funding.attempts;
const tables = () => cloud.store.snapshot().commercial.priceTables;
/** Put a table straight into the store, past the publish checks: what a stale or raced table looks like at dispatch. */
const storeTable = (table: CreditPriceTable) => cloud.store.run(async draft => { draft.commercial.priceTables.push(table); });

describe('the gateway under the credit price table', () => {
  it('holds in charge units, and stores both the provider rate and the tier charge on the attempt', async () => {
    const response = await ask();
    expect(response.status).toBe(200);
    await readAll(response.body);
    await cloud.idle();
    const [attempt] = attempts();
    const charge = chargeSnapshot(tables()[0], 'efficient')!;
    const bound = inputTokenBound(new TextEncoder().encode(JSON.stringify(chatBody())).byteLength, 1);
    expect(attempt.rateSnapshot).toEqual(LUNA.rate);
    expect(attempt.chargeSnapshot).toEqual(charge);
    expect(attempt.maxMicroUsd).toBe(chargeHold(charge, bound, 1_000));
    expect(attempt.maxMicroUsd).toBe(Math.ceil((bound * FAUX_CREDIT_CHARGE.cacheWriteMicroUsdPerMillion + 1_000 * FAUX_CREDIT_CHARGE.outputMicroUsdPerMillion) / 1_000_000)
      + FAUX_CREDIT_CHARGE.requestFeeMicroUsd);
  });

  it('refuses with tier_unpriced, sending and holding nothing, when no table is published', async () => {
    await cloud.store.run(async draft => { draft.commercial.priceTables = []; });
    expect(await refusal(await ask())).toMatchObject({ status: 409, code: 'tier_unpriced' });
    expect(spy.calls).toHaveLength(0);
    expect(attempts()).toHaveLength(0);
  });

  it('refuses with tier_unpriced when the table has no price for the tier', async () => {
    await storeTable({ ...tables()[0], version: 2, tiers: { ...tables()[0].tiers, focused: null } });
    expect(await refusal(await ask('focused'))).toMatchObject({ status: 409, code: 'tier_unpriced', message: expect.stringContaining('Focused') });
    expect(spy.calls).toHaveLength(0);
    expect(attempts()).toHaveLength(0);
    // The tiers it does price still serve.
    const served = await ask('efficient', 'run-1:2');
    expect(served.status).toBe(200);
    await readAll(served.body);
  });

  it('refuses a route over the ceiling with over_cost_ceiling, sending and holding nothing', async () => {
    // A charge whose output is too cheap for the route's output price at this ceiling.
    const cheap = { ...FAUX_CREDIT_CHARGE, outputMicroUsdPerMillion: LUNA.rate.outputMicroUsdPerMillion - 1 };
    await storeTable({ ...tables()[0], version: 2, tiers: { efficient: cheap, focused: cheap, thorough: cheap } });
    expect(await refusal(await ask())).toMatchObject({ status: 409, code: 'over_cost_ceiling' });
    expect(spy.calls).toHaveLength(0);
    expect(attempts()).toHaveLength(0);
  });

  it('refuses with policy_changed, releasing the hold and sending nothing, when a table is published between the first read and dispatch', async () => {
    const reserve = FundingService.prototype.reserve;
    vi.spyOn(FundingService.prototype, 'reserve').mockImplementation(async function (this: FundingService, input) {
      const held = await reserve.call(this, input);
      await storeTable({ ...tables()[0], version: 2 });
      return held;
    });
    expect(await refusal(await ask())).toMatchObject({ status: 409, code: 'policy_changed' });
    expect(spy.calls).toHaveLength(0);
    expect(attempts().map(a => a.state)).toEqual(['released']);
  });
});

describe('staff publishing the credit price table', () => {
  const body = (over: Record<string, unknown> = {}) => ({ ...FAUX_CREDIT_PRICES, baseVersion: 1, note: 'Synthetic retune.', ...over });

  it('is for routing staff and admins only', async () => {
    for (const who of ['staffSupport', 'staffBilling', 'owner', 'free'] as const) {
      const token = await signIn(who);
      expect((await call('GET', '/ops/credit-prices', token)).status).toBe(403);
      expect((await call('POST', '/ops/credit-prices/publish', token, body())).status).toBe(403);
    }
    expect((await call('GET', '/ops/credit-prices')).status).toBe(401);
    expect(tables()).toHaveLength(1);
  });

  it('publishes a new version on the one read, audits it, and keeps every version readable', async () => {
    const routing = await signIn('staffRouting');
    const published = await call('POST', '/ops/credit-prices/publish', routing, body());
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(published.body).toMatchObject({ v: 1, version: 2, note: 'Synthetic retune.' });
    // Built on a version that is no longer the newest: refused, and nothing is written.
    expect((await call('POST', '/ops/credit-prices/publish', routing, body())).status).toBe(409);
    const read = await call('GET', '/ops/credit-prices', await signIn('staffAdmin'));
    expect(read.status).toBe(200);
    expect(read.body.table.version).toBe(2);
    expect(read.body.history.map((t: CreditPriceTable) => t.version)).toEqual([2, 1]);
    const audit = cloud.store.snapshot().commercial.audit.filter(a => a.action === 'credit-prices.published');
    expect(audit.map(a => [a.targetKind, a.targetId])).toEqual([['credit-prices', '1'], ['credit-prices', '2']]);
  });

  it('never rewrites a version', async () => {
    await expect(cloud.store.commercial.transaction(tx => tx.savePriceTable(tables()[0]))).rejects.toThrow(/append-only/);
    expect(tables()).toHaveLength(1);
  });

  it('refuses a table that leaves a bound route over its ceiling, naming the route, tier and class', async () => {
    const routing = await signIn('staffRouting');
    const cheap = { ...FAUX_CREDIT_CHARGE, cacheWriteMicroUsdPerMillion: 1 };
    const refused = await call('POST', '/ops/credit-prices/publish', routing, body({ tiers: { efficient: FAUX_CREDIT_CHARGE, focused: FAUX_CREDIT_CHARGE, thorough: cheap } }));
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('over_cost_ceiling');
    expect(refused.body.error).toContain('aws-luna-5-6');
    expect(refused.body.error).toContain('Thorough');
    expect(refused.body.error).toContain('cache writes');
    expect(tables()).toHaveLength(1);
    // A lower ceiling fails the same way.
    expect((await call('POST', '/ops/credit-prices/publish', routing, body({ ceilingMicroUsdPerCredit: 1 }))).status).toBe(422);
  });
});
