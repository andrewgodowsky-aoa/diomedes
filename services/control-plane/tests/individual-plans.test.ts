/**
 * The Individual plan (2026-09-28): a person's own subscription, issued to a person and never to a
 * business. It covers Personal work only, regardless of any legacy member threshold. Faux cloud, in memory.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';
import { AUDIT_ACTIONS } from '../src/commercial.js';
import { configuration } from '../src/config.js';
import { organizationAccountExportSchema } from '../src/organization-export/schema.js';
import { decideAgentAdmission, snapshotFromView } from '../contract/contract.js';
import { NO_ENTITLEMENT_VIEW } from '../../../shared/workspaces.js';
import {
  BUSINESS_PLAN_NOT_FOR_PERSON,
  INDIVIDUAL_ELIGIBILITY_SENTENCE,
  INDIVIDUAL_PLAN,
  INDIVIDUAL_PLAN_NOT_FOR_BUSINESS,
  individualCovers,
  isPersonPlan,
  planCatalog,
  readIndividualCoverage,
} from '../../../shared/individual-plan.js';
import { AGENT_FREE_VERSION_REASON, PLAN_TEMPLATES } from '../../../shared/access.js';
import { validEnv } from './support/fixtures.js';

let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let clock = Date.parse('2026-09-28T12:00:00.000Z');
const now = () => clock;

async function call(method: string, pathname: string, token?: string, body?: unknown) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await cloud.handle(new Request(`http://127.0.0.1:8795${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function token(who: DemoAccount) {
  const result = await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD, remember: false });
  expect(result.status).toBe(200);
  return result.body.accessToken as string;
}
const personOf = async (who: DemoAccount) => (await cloud.accounts.signIn(await token(who))).person.id;

async function setup(maxActiveMembers?: string) {
  clock = Date.parse('2026-09-28T12:00:00.000Z');
  cloud = await createFauxCloud({ file: null, now, passwordIterations: 1_000, individualMaxActiveMembers: maxActiveMembers });
  orgs = (await seedDemo(cloud)).organizations!;
}
const issue = async (who: DemoAccount, extra: Record<string, unknown> = {}) =>
  call('POST', `/ops/people/${await personOf(who)}/grants`, await token('staffBilling'),
    { planId: 'individual', source: 'subscription', reference: 'inv_individual_1', note: '', ...extra });
const admitPersonal = async (who: DemoAccount, routeKind = 'byo') =>
  call('POST', '/account/agent-admissions', await token(who), { surface: 'conversation', routeKind, rootJobId: 'job-p1' });

beforeEach(async () => { await setup(); });

describe('the Individual plan in the catalog', () => {
  it('is a person-scoped plan with the eligibility sentence, the Agent and included usage without a dollar price', () => {
    expect(INDIVIDUAL_PLAN).toMatchObject({ id: 'individual', label: 'Individual', scope: 'person', termDays: 31, customerVisible: true });
    expect(INDIVIDUAL_PLAN.features).toEqual(['nectovia-agent', 'maintained-profiles', 'owner-rules', 'phone-relay', 'managed-inference']);
    expect(INDIVIDUAL_PLAN.note).toContain(INDIVIDUAL_ELIGIBILITY_SENTENCE);
    expect(INDIVIDUAL_ELIGIBILITY_SENTENCE).toBe('Individual covers Personal work only. Every Business workspace needs its own Business plan, including a sole proprietorship.');
    expect(INDIVIDUAL_PLAN.note).not.toMatch(/\$|\d+\s*(a|per)\s*month/);
    expect(planCatalog().map((plan) => plan.id)).toEqual([...PLAN_TEMPLATES.map((plan) => plan.id), 'individual']);
    expect(planCatalog().filter((plan) => plan.scope === 'person').map((plan) => plan.id)).toEqual(['individual']);
    expect(isPersonPlan('individual')).toBe(true);
    expect(isPersonPlan('business')).toBe(false);
    expect(AUDIT_ACTIONS).toEqual(expect.arrayContaining(['person-grant.issued', 'person-grant.revoked']));
  });

  it('reads the member threshold like the other whole-number settings', () => {
    expect(readIndividualCoverage(undefined)).toEqual({ maxActiveMembers: 1 });
    expect(readIndividualCoverage('  ')).toEqual({ maxActiveMembers: 1 });
    expect(readIndividualCoverage('2')).toEqual({ maxActiveMembers: 2 });
    for (const value of ['0', '-1', '1.5', 'two', '1e3']) expect(() => readIndividualCoverage(value)).toThrow();
    expect(configuration(validEnv).individual).toEqual({ maxActiveMembers: 1 });
    expect(configuration({ ...validEnv, INDIVIDUAL_MAX_ACTIVE_MEMBERS: '3' }).individual).toEqual({ maxActiveMembers: 3 });
    expect(() => configuration({ ...validEnv, INDIVIDUAL_MAX_ACTIVE_MEMBERS: 'many' })).toThrow();
    expect(individualCovers({ grantActive: true, organizationActiveMembers: null, maxActiveMembers: 1 })).toBe(true);
    expect(individualCovers({ grantActive: true, organizationActiveMembers: 1, maxActiveMembers: 1 })).toBe(false);
    expect(individualCovers({ grantActive: true, organizationActiveMembers: 1, maxActiveMembers: 100_000 })).toBe(false);
    expect(individualCovers({ grantActive: true, organizationActiveMembers: 2, maxActiveMembers: 1 })).toBe(false);
    expect(individualCovers({ grantActive: false, organizationActiveMembers: null, maxActiveMembers: 1 })).toBe(false);
  });

  it('lets staff read the catalog with each plan scope', async () => {
    const me = await call('GET', '/ops/me', await token('staffSupport'));
    expect(me.body.plans.find((plan: { id: string }) => plan.id === 'individual')).toMatchObject({ scope: 'person' });
    expect(me.body.plans.find((plan: { id: string }) => plan.id === 'business')).toMatchObject({ scope: 'organization' });
  });
});

describe('issuing and withdrawing an Individual grant', () => {
  it('issues to a person, audits it, bumps the revision, and never to a business', async () => {
    const issued = await issue('free');
    expect(issued.status).toBe(201);
    const personId = await personOf('free');
    expect(issued.body.grant).toMatchObject({ personId, tenantId: personId, planId: 'individual', state: 'active',
      features: ['nectovia-agent', 'maintained-profiles', 'owner-rules', 'phone-relay', 'managed-inference'] });
    expect(Date.parse(issued.body.grant.validUntil) - clock).toBe(31 * 86_400_000);

    const toBusiness = await call('POST', `/ops/customers/${orgs.harbor}/grants`, await token('staffBilling'),
      { planId: 'individual', source: 'subscription', reference: 'inv_x', note: '' });
    expect(toBusiness).toMatchObject({ status: 422, body: { error: INDIVIDUAL_PLAN_NOT_FOR_BUSINESS } });

    const businessToPerson = await issue('free', { planId: 'business' });
    expect(businessToPerson).toMatchObject({ status: 422, body: { error: BUSINESS_PLAN_NOT_FOR_PERSON } });
    expect((await issue('free', { features: ['managed-inference'] })).status).toBe(422);
    expect((await issue('free', { reference: '' })).status).toBe(422);

    const detail = await call('GET', `/ops/people/${personId}`, await token('staffSupport'));
    expect(detail.status).toBe(200);
    expect(detail.body.grants).toHaveLength(1);
    expect(detail.body.grants[0]).toMatchObject({ current: 'active' });
    expect(detail.body.audit.map((row: { action: string }) => row.action)).toEqual(['person-grant.issued']);
    expect(detail.body.audit[0]).toMatchObject({ organizationId: null, targetKind: 'person-grant', detail: { personId, accessRevision: 1 } });
  });

  it('refuses Support, who may read but not issue', async () => {
    const personId = await personOf('free');
    const refused = await call('POST', `/ops/people/${personId}/grants`, await token('staffSupport'),
      { planId: 'individual', source: 'subscription', reference: 'inv_1', note: '' });
    expect(refused.status).toBe(403);
    const customer = await call('POST', `/ops/people/${personId}/grants`, await token('free'),
      { planId: 'individual', source: 'subscription', reference: 'inv_1', note: '' });
    expect(customer.status).toBe(403);
  });

  it('answers the person own access: none, active, revoked and expired, with a growing revision', async () => {
    const free = await token('free');
    const none = await call('GET', '/account/access', free);
    expect(none.body).toMatchObject({ v: 1, state: 'none', planId: null, agent: { included: false, reason: AGENT_FREE_VERSION_REASON }, revision: 0, grants: [] });

    const grantId = (await issue('free')).body.grant.id;
    const active = await call('GET', '/account/access', free);
    expect(active.body).toMatchObject({ state: 'active', planId: 'individual', planLabel: 'Individual', agent: { included: true }, revision: 1 });
    expect(active.body.grants).toHaveLength(1);

    const personId = await personOf('free');
    const revoked = await call('POST', `/ops/people/${personId}/grants/${grantId}/revoke`, await token('staffBilling'), { reason: 'Cancelled.' });
    expect(revoked.status).toBe(200);
    expect((await call('POST', `/ops/people/${personId}/grants/${grantId}/revoke`, await token('staffBilling'), { reason: 'again' })).status).toBe(409);
    const after = await call('GET', '/account/access', await token('free'));
    expect(after.body).toMatchObject({ state: 'revoked', agent: { included: false }, revision: 2 });
    expect(after.body.agent.reason).toMatch(/withdrawn/);

    clock += 60_000;
    await issue('free');
    clock += 40 * 86_400_000;
    const expired = await call('GET', '/account/access', await token('free'));
    expect(expired.body).toMatchObject({ state: 'expired', agent: { included: false }, revision: 3 });
    const audit = await call('GET', `/ops/people/${personId}`, await token('staffAdmin'));
    expect(audit.body.audit.map((row: { action: string }) => row.action)).toEqual(['person-grant.issued', 'person-grant.revoked', 'person-grant.issued']);
  });

  it('lists a person with their Individual state and each membership business name', async () => {
    await issue('owner');
    const people = await call('GET', '/ops/people', await token('staffSupport'));
    const owner = people.body.find((row: { person: { name: string } }) => row.person.name === DEMO_ACCOUNTS.owner.name);
    expect(owner.individual).toMatchObject({ state: 'active', planId: 'individual' });
    expect(owner.memberships[0]).toMatchObject({ organizationName: 'Juniper Street Bakery', roleLabel: 'Business owner' });
    const free = people.body.find((row: { person: { name: string } }) => row.person.name === DEMO_ACCOUNTS.free.name);
    expect(free.individual).toBeNull();
  });
});

describe('Personal work under an Individual plan', () => {
  it('requires scoped admission for managed work even when the legacy Personal endpoint sees an active plan', async () => {
    await issue('free');
    const refused = await admitPersonal('free', 'managed');
    expect(refused.status).toBe(200);
    expect(refused.body.decision).toMatchObject({ admitted: false, code: 'scoped_admission_required' });
    expect(cloud.store.snapshot().funding.attempts).toHaveLength(0);
  });

  it('admits Personal work with a grant and refuses it without one, recording both', async () => {
    const refused = await admitPersonal('free');
    expect(refused.status).toBe(200);
    expect(refused.body.decision).toEqual({ admitted: false, code: 'entitlement_none', reason: AGENT_FREE_VERSION_REASON });
    await issue('free');
    const admitted = await admitPersonal('free');
    expect(admitted.body.decision).toMatchObject({ admitted: true, planId: 'individual' });
    expect(admitted.body.pins).toMatchObject({ organizationId: null, personId: await personOf('free'), planId: 'individual', policyRevision: 1 });
    const detail = await call('GET', `/ops/people/${await personOf('free')}`, await token('staffSupport'));
    expect(detail.body.admissions.map((row: { decision: string }) => row.decision)).toEqual(['admitted', 'refused']);
    expect(detail.body.admissions[0]).not.toHaveProperty('organizationId');
  });

  it('never lets a business plan admit Personal work', async () => {
    // The Juniper owner holds the Agent through the business, and no Individual plan.
    const refused = await admitPersonal('owner');
    expect(refused.body.decision).toMatchObject({ admitted: false, code: 'entitlement_none' });
    const view = { ...NO_ENTITLEMENT_VIEW, source: 'account-service' as const, state: 'active' as const, plan: 'business', features: ['nectovia-agent'], agent: true, validFrom: '2026-09-28T00:00:00.000Z', validUntil: '2026-10-28T00:00:00.000Z' };
    expect(decideAgentAdmission({ workspace: 'personal', member: true, entitlement: snapshotFromView(view), at: '2026-09-28T12:00:00.000Z' }))
      .toMatchObject({ admitted: false, code: 'personal_workspace' });
    expect(decideAgentAdmission({ workspace: 'personal', member: true, entitlement: snapshotFromView(NO_ENTITLEMENT_VIEW), individual: snapshotFromView({ ...view, plan: 'individual' }), at: '2026-09-28T12:00:00.000Z' }))
      .toMatchObject({ admitted: true, planId: 'individual' });
  });

  it('answers Personal work from the person\'s own Individual plan: withdrawn, ended, unreadable or missing', () => {
    const at = '2026-09-28T12:00:00.000Z';
    const own = { ...NO_ENTITLEMENT_VIEW, source: 'account-service' as const, plan: 'individual', features: ['nectovia-agent'], agent: true,
      validFrom: '2026-09-28T00:00:00.000Z', validUntil: '2026-10-28T00:00:00.000Z', revision: 3 };
    const decide = (individual?: ReturnType<typeof snapshotFromView>) => decideAgentAdmission({
      workspace: 'personal', member: true, entitlement: snapshotFromView(NO_ENTITLEMENT_VIEW), ...(individual ? { individual } : {}), at });
    const revoked = decide(snapshotFromView({ ...own, state: 'revoked' }));
    expect(revoked).toMatchObject({ admitted: false, code: 'entitlement_revoked' });
    const expired = decide(snapshotFromView({ ...own, state: 'expired' }));
    expect(expired).toMatchObject({ admitted: false, code: 'entitlement_expired' });
    // An active grant whose end has passed reads as expired at that moment, not as no plan.
    expect(decide(snapshotFromView({ ...own, state: 'active', validUntil: '2026-09-28T06:00:00.000Z' })))
      .toMatchObject({ admitted: false, code: 'entitlement_expired' });
    const unreadable = decide(snapshotFromView({ ...own, state: 'unknown' }));
    expect(unreadable).toMatchObject({ admitted: false, code: 'entitlement_unknown' });
    const none = decide(snapshotFromView(NO_ENTITLEMENT_VIEW));
    expect(none).toMatchObject({ admitted: false, code: 'personal_workspace' });
    // A plan without the Agent, or no Individual read at all, is still "needs an Individual plan".
    const without = decide(snapshotFromView({ ...own, state: 'active', features: ['managed-inference'], agent: false }));
    expect(without).toMatchObject({ admitted: false, code: 'personal_workspace' });
    expect(decide()).toMatchObject({ admitted: false, code: 'personal_workspace' });
    for (const decision of [revoked, expired, unreadable, none, without] as const) {
      if (decision.admitted) throw new Error('expected a refusal');
      expect(decision.reason.endsWith(' Nothing was sent.')).toBe(true);
      expect(decision.reason).not.toMatch(/[—–]/);
    }
    // Their own plan is named for the person who had one, and never a business's.
    for (const decision of [revoked, expired]) if (!decision.admitted) expect(decision.reason).toMatch(/^Your Individual plan /);
    if (!none.admitted) {
      expect(none.reason).toContain('needs an Individual plan');
      expect(none.reason).toContain('business workspace that includes it');
      expect(none.reason).toContain('your own AI tools');
      expect(none.reason).not.toContain('works for a business');
    }
  });

  it('answers the scoped admission of a withdrawn or ended Individual plan with its own code', async () => {
    const scoped = async () => {
      const free = await token('free');
      const individual = (await call('POST', '/account/individual', free)).body;
      return call('POST', `/account/routing/individual/${encodeURIComponent(individual.id)}/admit`, free,
        { surface: 'conversation', routeKind: 'byo', rootJobId: 'job-scoped' });
    };
    expect((await scoped()).body.decision).toMatchObject({ admitted: false, code: 'personal_workspace' });
    const grantId = (await issue('free')).body.grant.id;
    expect((await scoped()).body.decision).toMatchObject({ admitted: true, planId: 'individual' });
    await call('POST', `/ops/people/${await personOf('free')}/grants/${grantId}/revoke`, await token('staffBilling'), { reason: 'Cancelled.' });
    const revoked = (await scoped()).body.decision;
    expect(revoked).toMatchObject({ admitted: false, code: 'entitlement_revoked' });
    expect(revoked.reason).toMatch(/^Your Individual plan was withdrawn/);
    clock += 60_000;
    await issue('free');
    clock += 40 * 86_400_000;
    const expired = (await scoped()).body.decision;
    expect(expired).toMatchObject({ admitted: false, code: 'entitlement_expired' });
    expect(expired.reason).toMatch(/^Your Individual plan has ended/);
  });
});

describe('Business authority remains separate from Individual', () => {
  it('refuses a sole proprietor Business in access, admission and export despite a person plan', async () => {
    // Harbor Hardware has one active member, its owner, and no plan of its own.
    const before = await call('GET', `/account/organizations/${orgs.harbor}/access`, await token('harborOwner'));
    expect(before.body).toMatchObject({ state: 'none', agent: { included: false } });
    expect(before.body).not.toHaveProperty('coveredBy');
    await issue('harborOwner');
    const access = await call('GET', `/account/organizations/${orgs.harbor}/access`, await token('harborOwner'));
    expect(access.body).toMatchObject({ state: 'none', planId: null, agent: { included: false } });
    expect(access.body).not.toHaveProperty('coveredBy');
    expect(access.body.revision).toBe(before.body.revision);
    expect(access.body.grants).toEqual([]);
    const admission = await call('POST', `/account/organizations/${orgs.harbor}/agent-admissions`, await token('harborOwner'),
      { surface: 'work', routeKind: 'byo' });
    expect(admission.body.decision.admitted).toBe(false);
    const record = await call('GET', `/ops/customers/${orgs.harbor}`, await token('staffSupport'));
    expect(record.body.admissions[0]).toMatchObject({ decision: 'refused', planId: null });
    expect(record.body.admissions[0]).not.toHaveProperty('coverage');
    // The export retains the Business's own authority.
    const exported = await call('GET', `/account/organizations/${orgs.harbor}/export`, await token('harborOwner'));
    expect(exported.status).toBe(200);
    const read = organizationAccountExportSchema.safeParse(exported.body);
    expect(read.success).toBe(true);
    expect(exported.body.access).toMatchObject({ planId: null, agent: { included: false } });
    expect(exported.body.access).not.toHaveProperty('coveredBy');
  });

  it('does not cover a business with two active members, and changes nothing where the business plan has the Agent', async () => {
    // Juniper has three active members and its own Business plan.
    await issue('owner');
    const access = await call('GET', `/account/organizations/${orgs.juniper}/access`, await token('owner'));
    expect(access.body).toMatchObject({ planId: 'business', agent: { included: true } });
    expect(access.body).not.toHaveProperty('coveredBy');
    // Withdraw Juniper's own plan: the owner's Individual plan still does not cover a business of three.
    const billing = await token('staffBilling');
    const grantId = (await call('GET', `/ops/customers/${orgs.juniper}`, billing)).body.grants[0].id;
    await call('POST', `/ops/customers/${orgs.juniper}/grants/${grantId}/revoke`, billing, { reason: 'Cancelled.' });
    const after = await call('GET', `/account/organizations/${orgs.juniper}/access`, await token('owner'));
    expect(after.body).toMatchObject({ state: 'revoked', agent: { included: false } });
    const refused = await call('POST', `/account/organizations/${orgs.juniper}/agent-admissions`, await token('owner'), { surface: 'work', routeKind: 'byo' });
    expect(refused.body.decision).toMatchObject({ admitted: false, code: 'entitlement_revoked' });

    // Harbor with a second active member is not covered either.
    const harborOwner = await token('harborOwner');
    await issue('harborOwner');
    const code = await call('POST', `/account/organizations/${orgs.harbor}/invitation-codes`, harborOwner, { role: 'member', ttlMs: 3_600_000 });
    expect((await call('POST', '/account/invitation-codes/redeem', await token('free'), { code: code.body.code })).status).toBe(200);
    const two = await call('GET', `/account/organizations/${orgs.harbor}/access`, await token('harborOwner'));
    expect(two.body).toMatchObject({ state: 'none', agent: { included: false } });
    expect(two.body).not.toHaveProperty('coveredBy');
  });

  it('does not revive Business coverage when the legacy threshold is 2', async () => {
    await setup('2');
    await issue('harborOwner');
    const code = await call('POST', `/account/organizations/${orgs.harbor}/invitation-codes`, await token('harborOwner'), { role: 'member', ttlMs: 3_600_000 });
    await call('POST', '/account/invitation-codes/redeem', await token('free'), { code: code.body.code });
    const access = await call('GET', `/account/organizations/${orgs.harbor}/access`, await token('harborOwner'));
    expect(access.body).toMatchObject({ state: 'none', planId: null, agent: { included: false } });
    expect(access.body).not.toHaveProperty('coveredBy');
    // The member without an Individual plan of their own is not covered by the owner's.
    const member = await call('GET', `/account/organizations/${orgs.harbor}/access`, await token('free'));
    expect(member.body).toMatchObject({ state: 'none', agent: { included: false } });
  });
});
