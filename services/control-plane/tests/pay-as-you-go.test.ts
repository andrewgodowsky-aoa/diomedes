/**
 * Pay as you go (Andrew, 2026-10-05, Model B section 4; DIO-219): a person with no plan buys credits for their own Personal work,
 * and while that bought balance is above zero the Nectovia Agent works for them there, funded only from it.
 *
 * Against the faux cloud: its Worker, its local Checkout page and signed webhook (nothing reaches Stripe), and a scripted model
 * transport (nothing reaches a provider). The prices are the faux cloud's stand-ins for the public ones: $130 for 1,000 credits
 * without a plan, in steps of 100, and $100 for 1,100 on a plan, in steps of 110.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { seedDemo, DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, type DemoAccount } from '../src/faux/seed.js';
import { PROFILE_FLOORS, ROUTING_CONSENT_VERSION, type AccountScope, type ModelBinding, type ProviderConnection } from '../../../shared/routing-policy.js';
import { creditAmount, micro, type RateSnapshot } from '../../../shared/managed-usage.js';
import { OUT_OF_CREDITS_PERSONAL, PAY_AS_YOU_GO_PLAN_ONLY_REASON } from '../../../shared/access.js';
import { ESCALATION_HEADER } from '../../../shared/escalation-controls.js';
import { BOUGHT_CREDITS_PERIOD, FundingError, FundingService } from '../src/funding.js';
import { FundingMemoryRepository } from './support/funding-memory.js';

const at = '2026-09-28T00:00:00.000Z', until = '2026-10-28T00:00:00.000Z';
let clock: number, cloud: FauxCloud, routing: string, billing: string, sends: number, juniper: string;
const connection: ProviderConnection = { id: 'azure-fixture', revision: 1, provider: 'azure-openai', label: 'Synthetic Azure',
  secretRef: 'AZURE_OPENAI_API_KEY', payer: 'company', account: 'fixture-account', enabled: true,
  resource: 'fixture-resource', apiVersion: 'v1', deployments: ['primary'] };
const bindings = { MANAGED_CONNECTIONS: JSON.stringify([connection]), AZURE_OPENAI_API_KEY: 'fixture-company-secret' };
const success = () => new Response([
  { id: 'fixture-completion', model: 'synthetic-v1', choices: [{ delta: { content: 'Recorded answer.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12 } },
].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' } });
const transport: typeof fetch = async () => { sends++; return success(); };

function binding(deployment: string): ModelBinding {
  return { connectionId: connection.id, connectionRevision: 1, protocol: 'chat-completions', deployment,
    modelVersion: 'synthetic-v1', upstreamEndpoint: null,
    capabilities: { contextTokens: 100_000, outputTokens: 4096, tools: true, images: false, reasoning: false },
    qualification: { id: 'synthetic-qualification', evidence: 'Transport fixture only', validUntil: until, tiers: ['efficient', 'focused', 'thorough'], qualityFloor: 0.9 },
    access: { state: 'ready', evidence: 'Transport fixture only', validUntil: until, availableRequests: 10 },
    privacy: { connectionRevision: 1, modelVersion: 'synthetic-v1', protocol: 'chat-completions', evidence: 'Transport fixture only',
      validUntil: until, ingressCountries: ['US'], decryptionCountries: ['US'], processingCountries: ['US'], retentionPolicy: 'fixture-zero-retention',
      zeroRetention: true, training: false, contentLogging: false, caching: 'off', transientCacheEvidence: null,
      features: ['text', 'tools'], allowedRetentionModes: [], effectiveRetentionMode: null, regionalEntitlement: false },
    health: { state: 'healthy', observedAt: at, validUntil: until, cooldownUntil: null, reason: 'Transport fixture only' },
    price: { version: 'fixture-price-1', evidence: 'Transport fixture only', observedAt: at, validUntil: until,
      inputMicroUsdPerMillion: 100_000, outputMicroUsdPerMillion: 200_000, reasoningMicroUsdPerMillion: 200_000,
      cacheReadMicroUsdPerMillion: 10_000, cacheWriteMicroUsdPerMillion: 125_000, requestFeeMicroUsd: 1, longContext: [] } };
}
async function call(method: string, pathname: string, token?: string, body?: unknown) {
  const response = await cloud.handle(new Request(`http://127.0.0.1:8795${pathname}`, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: response.status, body: await response.json() as any };
}
async function signIn(who: DemoAccount) {
  return (await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD })).body.accessToken as string;
}
const personOf = async (token: string) => (await cloud.accounts.signIn(token)).person;
/** An active Individual plan grant for the person, issued by billing staff. */
async function individualPlan(token: string) {
  const person = await personOf(token);
  const result = await call('POST', `/ops/people/${person.id}/grants`, billing,
    { planId: 'individual', source: 'internal-test', reference: 'Synthetic Personal plan', note: '', validUntil: until });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
}
/** The person's own Individual billing scope, with a routing preference so its policy can be read. */
async function personalScope(token: string): Promise<AccountScope> {
  const account = (await call('POST', '/account/individual', token, {})).body;
  const scope: AccountScope = { kind: 'individual', id: account.id };
  const result = await call('POST', `/account/routing/individual/${scope.id}/preference`, token, { scope, baseRevision: 0,
    profile: 'strict', restrictions: PROFILE_FLOORS.strict, exceptions: [], consentVersion: ROUTING_CONSENT_VERSION, acknowledge: true });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return scope;
}
/** A purchase for the person's own Personal work, started and (unless told not to) paid through the faux Checkout page. */
async function buyPersonal(token: string, credits: number, pay = true) {
  const started = await call('POST', '/account/credit-purchases', token, { credits });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const session = new URL(started.body.checkoutUrl).pathname.split('/').pop()!;
  if (pay) expect((await cloud.completeCheckout(session)).status).toBe(200);
  return { ...started.body as { purchaseId: string; credits: number; amountCents: number }, session };
}
const admit = (token: string, scope: AccountScope, work: { surface?: string; routeKind?: string; job?: string } = {}) =>
  call('POST', `/account/routing/individual/${scope.id}/admit`, token,
    { surface: work.surface ?? 'conversation', routeKind: work.routeKind ?? 'managed', rootJobId: work.job ?? 'payg-job' });
/** A job's admission, which every step of the job carries. */
async function admitted(token: string, scope: AccountScope, work: { surface?: string; job?: string } = {}) {
  const admission = await admit(token, scope, work);
  expect(admission.status, JSON.stringify(admission.body)).toBe(200);
  expect(admission.body.decision, JSON.stringify(admission.body.decision)).toMatchObject({ admitted: true });
  return admission.body.admissionId as string;
}
/** One gateway call for a job, admitted just before it unless the job's admission is given, as the desktop sends it. */
async function step(token: string, scope: AccountScope, opts: { job?: string; attempt?: string; surface?: string; headers?: Record<string, string>; admissionId?: string } = {}) {
  const job = opts.job ?? 'payg-job';
  const admissionId = opts.admissionId ?? await admitted(token, scope, { surface: opts.surface, job });
  const p = (await call('GET', `/account/routing/individual/${scope.id}/policy`, token)).body;
  return cloud.handle(new Request('http://127.0.0.1:8795/managed/v1/responses', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-nectovia-scope-kind': 'individual', 'x-nectovia-account': scope.id,
    'x-nectovia-admission': admissionId, 'x-nectovia-job': job, 'x-nectovia-attempt': opts.attempt ?? 'payg-attempt',
    'x-nectovia-tier': 'efficient', 'x-nectovia-usage-class': 'metered-work', 'x-nectovia-protocol': p.protocol,
    'x-nectovia-policy-revision': String(p.revision), 'x-nectovia-global-revision': String(p.globalRevision),
    'x-nectovia-scope-revision': String(p.scopeRevision), 'x-nectovia-preference-revision': String(p.preferenceRevision),
    'x-nectovia-route-revision': String(p.tiers.efficient?.entryRevision ?? 1), 'x-nectovia-checkpoint': 'portable', ...opts.headers,
  }, body: JSON.stringify({ model: p.tiers.efficient?.model ?? 'synthetic-v1', input: [{ role: 'user', content: 'Hello.' }], max_output_tokens: 512, stream: true, store: false }) }));
}
async function completed(response: Response) {
  const body = await response.text();
  expect(response.status, body).toBe(200);
  expect(body).toContain('Recorded answer.');
  await cloud.idle();
}
const access = async (token: string, scope: AccountScope) => (await call('GET', `/account/routing/individual/${scope.id}/access`, token)).body;
const balance = async (token: string) => (await call('GET', '/account/purchased-usage', token)).body;

beforeEach(async () => {
  clock = Date.parse(at); sends = 0;
  cloud = await createFauxCloud({ file: null, now: () => clock, passwordIterations: 1000, managed: { transport, bindings, idleTimeoutMs: 50 } });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  routing = await signIn('staffRouting'); billing = await signIn('staffBilling');
  const route = await call('POST', '/ops/routes', routing, { id: 'primary', provider: 'azure-openai', model: 'synthetic-v1', label: 'primary',
    region: 'US', processing: 'Transport fixture only', status: 'qualified', evidence: 'Transport fixture only', binding: binding('primary') });
  expect(route.status, JSON.stringify(route.body)).toBe(200);
  const tier = { primary: 'primary', backups: [], fallbackEnabled: false, maxAttempts: 1, cost: { sameOrLower: true, maxAttemptMicroUsd: null, qualityFloor: 0.8 } };
  const published = await call('POST', '/ops/routing/scopes/publish', routing, { scope: { kind: 'global' }, baseRevision: 1, baseGlobalRevision: 1,
    routing: { efficient: tier, focused: tier, thorough: tier }, note: 'Synthetic publication' });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
});
afterEach(async () => { await cloud.idle(); vi.restoreAllMocks(); });

describe('buying credits for Personal work', () => {
  it('quotes a person with no plan at the no-plan price, and says what one step buys on a plan', async () => {
    const free = await signIn('free');
    const quote = await call('GET', '/account/credit-purchases/quote?credits=1000', free);
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    expect(quote.body).toEqual({ credits: 1000, amountCents: 13000, currency: 'usd', steps: 10, stepCredits: 100, stepCents: 1300,
      onPlan: false, planStep: { credits: 110, cents: 1000 } });
    // Asked with no amount, one step: how a screen learns the step.
    expect((await call('GET', '/account/credit-purchases/quote', free)).body).toMatchObject({ credits: 100, amountCents: 1300, steps: 1 });
    expect((await call('GET', '/account/credit-purchases/quote?credits=150', free)).status).toBe(422);
    expect((await call('GET', '/account/credit-purchases/quote?credits=100', undefined)).status).toBe(401);
  });

  it('quotes a person with an active Individual plan of their own at the plan rate', async () => {
    const free = await signIn('free');
    await individualPlan(free);
    const quote = await call('GET', '/account/credit-purchases/quote?credits=1100', free);
    expect(quote.body).toEqual({ credits: 1100, amountCents: 10000, currency: 'usd', steps: 10, stepCredits: 110, stepCents: 1000, onPlan: true, planStep: null });
    expect((await call('GET', '/account/credit-purchases/quote?credits=1000', free)).status).toBe(422);
  });

  it('never prices a person at a business plan they belong to: the business plan is the business’s', async () => {
    // The demo owner's business holds a plan; the owner has no Individual plan of their own.
    const owner = await signIn('owner');
    expect((await call('GET', '/account/credit-purchases/quote?credits=100', owner)).body).toMatchObject({ amountCents: 1300, onPlan: false });
  });

  it('locks the rate into the purchase when it starts: a plan issued before payment changes nothing', async () => {
    const free = await signIn('free');
    const person = await personOf(free);
    const bought = await buyPersonal(free, 1000, false);
    expect(bought).toMatchObject({ credits: 1000, amountCents: 13000 });
    await individualPlan(free);
    expect((await cloud.completeCheckout(bought.session)).status).toBe(200);
    const row = cloud.store.snapshot().funding.creditPurchases.find(r => r.purchaseId === bought.purchaseId)!;
    expect(row).toMatchObject({ tenantId: person.id, personId: person.id, credits: 1000, amountCents: 13000, rateCents: 1300, rateCredits: 100, state: 'paid' });
    expect((await balance(free)).purchasedMicroUsd).toBe(creditAmount(1000));
    // The next quote is at the plan rate the person now holds.
    expect((await call('GET', '/account/credit-purchases/quote', free)).body).toMatchObject({ stepCredits: 110, stepCents: 1000, onPlan: true });
  });

  it('credits the person’s own Individual scope, never a business they belong to', async () => {
    const owner = await signIn('owner');
    const person = await personOf(owner);
    const organizationId = juniper;
    const businessBefore = (await call('GET', `/account/organizations/${organizationId}/purchased-usage`, owner)).body;
    const bought = await buyPersonal(owner, 100);
    const { creditPurchases, topUps, billingCustomers } = cloud.store.snapshot().funding;
    const row = creditPurchases.find(r => r.purchaseId === bought.purchaseId)!;
    expect(row.organizationId).toMatch(/^individual_/);
    expect(row).toMatchObject({ tenantId: person.id, personId: person.id, state: 'paid' });
    expect(topUps.filter(t => t.organizationId === row.organizationId).map(t => t.amountMicroUsd)).toEqual([creditAmount(100)]);
    expect(billingCustomers.filter(c => c.organizationId === row.organizationId)).toEqual([expect.objectContaining({ tenantId: person.id, environment: 'test' })]);
    expect(await balance(owner)).toMatchObject({ purchasedMicroUsd: creditAmount(100), availableMicroUsd: creditAmount(100) });
    // The business's own bought credits did not move.
    expect((await call('GET', `/account/organizations/${organizationId}/purchased-usage`, owner)).body).toEqual(businessBefore);
    // A personal purchase is not the business's to read, and the business's are not the person's.
    expect((await call('GET', `/account/organizations/${organizationId}/credit-purchases/${bought.purchaseId}`, owner)).status).toBe(404);
    const business = await call('POST', `/account/organizations/${organizationId}/credit-purchases`, owner, { credits: 110 });
    expect(business.status).toBe(201);
    expect((await call('GET', `/account/credit-purchases/${business.body.purchaseId}`, owner)).status).toBe(404);
    expect((await call('GET', `/account/credit-purchases/${bought.purchaseId}`, owner)).body).toMatchObject({ state: 'paid', credits: 100 });
    // A second personal purchase reuses the person's one customer.
    await buyPersonal(owner, 100);
    expect(cloud.store.snapshot().funding.billingCustomers.filter(c => c.organizationId === row.organizationId)).toHaveLength(1);
  });

  it('takes nothing about the payer from the request', async () => {
    const free = await signIn('free');
    for (const body of [{ credits: 100, organizationId: 'org_other' }, { credits: 100, personId: 'person_other' }, { credits: 100, amountCents: 1 }])
      expect((await call('POST', '/account/credit-purchases', free, body)).status).toBe(422);
    expect(cloud.store.snapshot().funding.creditPurchases).toHaveLength(0);
  });
});

describe('the Agent on bought credits', () => {
  it('refuses a person with no plan and no credits, and their access view says none were bought', async () => {
    const free = await signIn('free');
    const scope = await personalScope(free);
    expect(await access(free, scope)).toMatchObject({ state: 'none', agent: false, boughtCredits: 'none' });
    const refused = await admit(free, scope);
    expect(refused.body.decision).toMatchObject({ admitted: false });
    expect(sends).toBe(0);
    expect(cloud.store.snapshot().funding.attempts).toHaveLength(0);
  });

  it('admits at the account service and the gateway with a positive balance, and draws only on bought credits, with no period', async () => {
    const free = await signIn('free');
    const person = await personOf(free);
    const scope = await personalScope(free);
    await buyPersonal(free, 1000);
    // The access view says the credits are there, never how many, and grants no feature.
    const view = await access(free, scope);
    expect(view).toMatchObject({ state: 'none', agent: false, managedInference: false, boughtCredits: 'available' });
    expect(view.features ?? []).toEqual([]);
    const admitted = await admit(free, scope);
    expect(admitted.body.decision).toEqual({ admitted: true, planId: null, revision: expect.any(Number), validUntil: null });
    expect(admitted.body.pins).toMatchObject({ organizationId: null, planId: null, tenantId: person.id, personId: person.id, scope });
    // Work (a task) is one a person starts too.
    expect((await admit(free, scope, { surface: 'work', job: 'payg-task' })).body.decision).toMatchObject({ admitted: true });
    await completed(await step(free, scope));
    expect(sends).toBe(1);
    const { attempts, periods, settlements } = cloud.store.snapshot().funding;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ tenantId: person.id, organizationId: scope.id, periodId: BOUGHT_CREDITS_PERIOD, monthlyHoldMicroUsd: 0 });
    expect(attempts[0].topUpHoldMicroUsd).toBeGreaterThan(0);
    // The one bought-credits row: no grant and no source. It funds nothing; the bought balance does.
    expect(periods.filter(p => p.organizationId === scope.id)).toEqual([expect.objectContaining({ periodId: BOUGHT_CREDITS_PERIOD,
      planId: 'bought-credits', grantedMicroUsd: 0, sourceGrantId: '' })]);
    expect(settlements.filter(s => s.organizationId === scope.id)).toHaveLength(1);
    const after = await balance(free);
    expect(after.settledMicroUsd).toBeGreaterThan(0);
    expect(after.availableMicroUsd).toBe(creditAmount(1000) - after.settledMicroUsd);
    // A second step of other work reuses the same row.
    await completed(await step(free, scope, { job: 'payg-second', attempt: 'payg-second' }));
    expect(cloud.store.snapshot().funding.periods.filter(p => p.organizationId === scope.id)).toHaveLength(1);
  });

  it('stops at the step boundary when the credits run out, with the out-of-credits sentence, and sends nothing more', async () => {
    const free = await signIn('free');
    const person = await personOf(free);
    const scope = await personalScope(free);
    await buyPersonal(free, 100);
    const admissionId = await admitted(free, scope);
    await completed(await step(free, scope, { attempt: 'step-1', admissionId }));
    expect(sends).toBe(1);
    // Other work of the person's holds everything that is left.
    const left = (await balance(free)).availableMicroUsd;
    await cloud.funding.openJob({ tenantId: person.id, organizationId: scope.id, rootJobId: 'other-work', runRef: 'run_other_work', parentRunRef: null, tier: 'thorough', capMicroUsd: null });
    await cloud.funding.reserve({ tenantId: person.id, organizationId: scope.id, attemptId: 'other-hold', rootJobId: 'other-work', parentAttemptId: null,
      kind: 'generation', route: 'primary', requestDigest: 'digest_other', rateSnapshot: RATE, maxMicroUsd: micro(left), usageClass: 'metered-work', boughtOnly: true });
    expect((await balance(free)).availableMicroUsd).toBe(0);
    // The next step of the same job is refused before anything is held or sent.
    const attemptsBefore = cloud.store.snapshot().funding.attempts.length;
    const stopped = await step(free, scope, { attempt: 'step-2', admissionId });
    expect(stopped.status).toBe(402);
    expect(await stopped.json()).toEqual({ error: { code: 'insufficient_allowance', message: OUT_OF_CREDITS_PERSONAL } });
    expect(sends).toBe(1);
    expect(cloud.store.snapshot().funding.attempts).toHaveLength(attemptsBefore);
    // The first step stays settled and paid for.
    expect(cloud.store.snapshot().funding.settlements.filter(s => s.organizationId === scope.id)).toHaveLength(1);
  });

  it('refuses admission at zero with the out-of-credits sentence once everything bought is spent or held', async () => {
    const free = await signIn('free');
    const person = await personOf(free);
    const scope = await personalScope(free);
    await buyPersonal(free, 100);
    await cloud.funding.openJob({ tenantId: person.id, organizationId: scope.id, rootJobId: 'other-work', runRef: 'run_other_work', parentRunRef: null, tier: 'thorough', capMicroUsd: null });
    await cloud.funding.reserve({ tenantId: person.id, organizationId: scope.id, attemptId: 'other-hold', rootJobId: 'other-work', parentAttemptId: null,
      kind: 'generation', route: 'primary', requestDigest: 'digest_other', rateSnapshot: RATE, maxMicroUsd: creditAmount(100), usageClass: 'metered-work', boughtOnly: true });
    expect(await access(free, scope)).toMatchObject({ boughtCredits: 'spent' });
    expect((await admit(free, scope)).body.decision).toEqual({ admitted: false, code: 'insufficient_allowance', reason: OUT_OF_CREDITS_PERSONAL });
    // Buying more lets the work continue.
    await buyPersonal(free, 100);
    expect((await admit(free, scope)).body.decision).toMatchObject({ admitted: true });
  });

  it('keeps every plan-only kind of work refused for a person paying as they go', async () => {
    const free = await signIn('free');
    const scope = await personalScope(free);
    await buyPersonal(free, 1000);
    // The team lead's members, unattended automations and loops on the person's own keys, and the Agent on their own keys.
    for (const work of [{ surface: 'team' }, { surface: 'automation' }, { surface: 'conversation', routeKind: 'byo' },
      { surface: 'loop', routeKind: 'byo' }, { surface: 'conversation', routeKind: 'local' }, { surface: 'work', routeKind: 'external-engine' }])
      expect((await admit(free, scope, work)).body.decision, JSON.stringify(work)).toEqual({ admitted: false, code: 'plan_required', reason: PAY_AS_YOU_GO_PLAN_ONLY_REASON });
    // At the gateway: automation usage, and a role working under another lead, are refused before anything is held or sent.
    const planOnly: Record<string, string>[] = [{ 'x-nectovia-usage-class': 'automation' }, { [ESCALATION_HEADER]: 'worker' }, { [ESCALATION_HEADER]: 'advisor' }];
    for (const headers of planOnly) {
      const refused = await step(free, scope, { headers, attempt: `plan-only-${Object.values(headers)[0]}` });
      expect(refused.status, JSON.stringify(headers)).toBe(403);
      expect(await refused.json()).toEqual({ error: { code: 'plan_required', message: PAY_AS_YOU_GO_PLAN_ONLY_REASON } });
    }
    expect(sends).toBe(0);
    expect(cloud.store.snapshot().funding.attempts).toHaveLength(0);
    // Bought credits add no feature to the person's access: no business rules, no phone access, no Agent feature.
    expect((await access(free, scope)).features ?? []).toEqual([]);
  });

  it('runs a person whose own plan has ended on their bought credits, never on the ended plan', async () => {
    let free = await signIn('free');
    const person = await personOf(free);
    const short = await call('POST', `/ops/people/${person.id}/grants`, billing, { planId: 'individual', source: 'internal-test',
      reference: 'Synthetic short plan', note: '', validUntil: new Date(clock + 3_600_000).toISOString() });
    expect(short.status, JSON.stringify(short.body)).toBe(201);
    const scope = await personalScope(free);
    // Bought while the plan was active, so at the plan rate.
    expect((await buyPersonal(free, 110)).amountCents).toBe(1000);
    clock += 2 * 3_600_000;
    free = await signIn('free');
    expect(await access(free, scope)).toMatchObject({ agent: false, boughtCredits: 'available' });
    expect((await access(free, scope)).state).not.toBe('active');
    expect((await admit(free, scope)).body.decision).toMatchObject({ admitted: true, planId: null });
    await completed(await step(free, scope));
    const attempts = cloud.store.snapshot().funding.attempts.filter(a => a.organizationId === scope.id);
    expect(attempts.map(a => a.periodId)).toEqual([BOUGHT_CREDITS_PERIOD]);
    expect(attempts[0].monthlyHoldMicroUsd).toBe(0);
  });

  it('leaves a person with an Individual plan on their plan’s monthly credits', async () => {
    const free = await signIn('free');
    await individualPlan(free);
    const scope = await personalScope(free);
    await buyPersonal(free, 110);
    expect((await admit(free, scope)).body.decision).toMatchObject({ admitted: true, planId: 'individual' });
    await completed(await step(free, scope));
    const attempt = cloud.store.snapshot().funding.attempts[0];
    expect(attempt.periodId).not.toBe(BOUGHT_CREDITS_PERIOD);
    expect(attempt.monthlyHoldMicroUsd).toBeGreaterThan(0);
  });
});

describe('a business without a plan', () => {
  it('still refuses the Agent, even to an owner who bought credits for their own Personal work, and still buys at the no-plan price', async () => {
    const owner = await signIn('owner');
    const created = await call('POST', '/account/organizations', owner, { name: 'Synthetic planless business' });
    expect(created.status).toBe(201);
    const organizationId = created.body.id as string;
    await personalScope(owner);
    await buyPersonal(owner, 100);
    const refused = await call('POST', `/account/routing/organization/${organizationId}/admit`, owner, { surface: 'conversation', routeKind: 'managed', rootJobId: 'business-job' });
    expect(refused.body.decision).toMatchObject({ admitted: false, code: 'agent_not_included' });
    // Its buy box keeps slice 1's path: the no-plan price, and the quote says it is not on a plan.
    const quote = await call('GET', `/account/organizations/${organizationId}/credit-purchases/quote?credits=1000`, owner);
    expect(quote.body).toEqual({ credits: 1000, amountCents: 13000, currency: 'usd', steps: 10, stepCredits: 100, stepCents: 1300,
      onPlan: false, planStep: { credits: 110, cents: 1000 } });
    expect((await call('POST', `/account/organizations/${organizationId}/credit-purchases`, owner, { credits: 100 })).status).toBe(201);
    expect(sends).toBe(0);
  });
});

/** The funding rate the direct holds above use. Any synthetic rate does: the hold's size is what matters. */
const RATE: RateSnapshot = { version: 'fixture-rate-1', inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 1_000_000, cacheWriteMicroUsdPerMillion: 1_000_000 };

describe('the bought-only reservation', () => {
  const T = 'person_payg', SCOPE = 'individual_payg', ORG = 'org_payg';
  function harness() {
    const repository = new FundingMemoryRepository();
    const service = new FundingService(repository, { now: () => Date.parse('2026-10-05T12:00:00.000Z') });
    const reserve = (organizationId: string, attemptId: string, credits: number, boughtOnly = true) =>
      service.openJob({ tenantId: T, organizationId, rootJobId: `job_${attemptId}`, runRef: `run_${attemptId}`, parentRunRef: null, tier: 'thorough', capMicroUsd: null })
        .then(() => service.reserve({ tenantId: T, organizationId, attemptId, rootJobId: `job_${attemptId}`, parentAttemptId: null, kind: 'generation',
          route: 'primary', requestDigest: `digest_${attemptId}`, rateSnapshot: RATE, maxMicroUsd: creditAmount(credits), usageClass: 'metered-work', boughtOnly }));
    const topUp = (organizationId: string, credits: number) => service.recordTopUp({ tenantId: T, organizationId, topUpId: `topup_${organizationId}_${credits}`,
      amountMicroUsd: creditAmount(credits), provider: 'stripe', sourceEventId: `evt_${organizationId}_${credits}` });
    return { repository, service, reserve, topUp };
  }
  const refusal = async (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a refusal'); }, (error: unknown) => {
    if (error instanceof FundingError) return error; throw error; });

  it('draws on bought credits only, on the scope’s one bought-credits row, instead of failing no_period', async () => {
    const h = harness();
    await h.topUp(SCOPE, 50);
    const first = await h.reserve(SCOPE, 'a', 10);
    expect(first).toMatchObject({ periodId: BOUGHT_CREDITS_PERIOD, monthlyHoldMicroUsd: 0, topUpHoldMicroUsd: creditAmount(10) });
    await h.reserve(SCOPE, 'b', 40);
    expect((await refusal(h.reserve(SCOPE, 'c', 1))).code).toBe('insufficient_allowance');
    const rows = h.repository.snapshot().periods.filter(p => p.organizationId === SCOPE);
    expect(rows).toEqual([expect.objectContaining({ periodId: BOUGHT_CREDITS_PERIOD, planId: 'bought-credits', grantedMicroUsd: 0, sourceGrantId: '' })]);
    expect(await h.service.boughtState(T, SCOPE)).toBe('spent');
    expect(await h.service.boughtAvailable(T, SCOPE)).toBe(0);
  });

  it('still fails no_period without the flag, and never takes the path for a business', async () => {
    const h = harness();
    await h.topUp(SCOPE, 50);
    await h.topUp(ORG, 50);
    expect((await refusal(h.reserve(SCOPE, 'plain', 1, false))).code).toBe('no_period');
    expect((await refusal(h.reserve(ORG, 'business', 1, true))).code).toBe('no_period');
    expect(h.repository.snapshot().periods).toEqual([]);
  });

  it('says none for a scope that never bought, and available while any is left', async () => {
    const h = harness();
    expect(await h.service.boughtState(T, SCOPE)).toBe('none');
    await h.topUp(SCOPE, 5);
    expect(await h.service.boughtState(T, SCOPE)).toBe('available');
    expect(await h.service.boughtAvailable(T, SCOPE)).toBe(creditAmount(5));
  });
});

describe('migration 019', () => {
  const sql = readFileSync(new URL('../migrations/019_personal_pay_as_you_go.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../scripts/migrate.ts', import.meta.url), 'utf8');

  it('is LF only and is not listed in the runner: numbers are assigned at merge', () => {
    expect(sql).not.toContain('\r');
    expect(runner).not.toContain('019_personal_pay_as_you_go');
  });

  it('maps a Stripe customer to one person per environment, and a person’s purchase to their own scope', () => {
    expect(sql).toMatch(/billing_customers ADD COLUMN person_id text\s+GENERATED ALWAYS AS \(CASE WHEN organization_id LIKE 'individual\\_%' THEN tenant_id END\) STORED/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX billing_customers_person_environment ON control_plane\.billing_customers\(provider, environment, person_id\)\s+WHERE person_id IS NOT NULL/);
    expect(sql).toMatch(/credit_purchases_payer_scope\s+FOREIGN KEY \(organization_id, tenant_id\) REFERENCES control_plane\.billing_scopes\(id, tenant_id\)/);
    expect(sql).toMatch(/billing_customers_person_scope\s+FOREIGN KEY \(organization_id, tenant_id, person_id\) REFERENCES control_plane\.billing_scopes\(id, tenant_id, person_id\)/);
    expect(sql).toMatch(/credit_purchases_person_buys_own_scope[\s\S]*person_id = tenant_id/i);
  });

  it('allows the bought-credits row only for a person’s own scope, with no grant and no source', () => {
    expect(sql).toMatch(/credit_periods_bought_credits_row CHECK \(\s+plan_id<>'bought-credits' OR \(granted_micro_usd=0 AND organization_id LIKE 'individual\\_%'\)/);
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i);
  });

  it('names no private economics', () => {
    expect(sql).not.toMatch(/margin|markup|ceiling|provider cost|cost per credit/i);
  });
});
