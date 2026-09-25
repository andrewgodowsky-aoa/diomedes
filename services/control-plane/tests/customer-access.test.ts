import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';
import { entitlementFromGrants, type FeatureGrant } from '../src/commercial.js';
import { decideAgentAdmission, snapshotFromView } from '../contract/contract.js';
import { NO_ENTITLEMENT_VIEW } from '../../../shared/workspaces.js';

let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let clock = Date.parse('2026-09-25T12:00:00.000Z');
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

async function signIn(who: DemoAccount, remember = false) {
  const result = await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD, remember });
  expect(result.status).toBe(200);
  return result.body as { accessToken: string; refreshToken: string; refreshExpiresAt: string };
}
const token = async (who: DemoAccount) => (await signIn(who)).accessToken;

beforeEach(async () => {
  clock = Date.parse('2026-09-25T12:00:00.000Z');
  cloud = await createFauxCloud({ file: null, now, passwordIterations: 1_000 });
  const seed = await seedDemo(cloud);
  expect(seed.seeded).toBe(true);
  orgs = seed.organizations!;
});

describe('the paid Nectovia Agent boundary', () => {
  it('admits a Business member and refuses a business with no plan, whatever routes are connected', async () => {
    const employee = await call('POST', `/account/organizations/${orgs.juniper}/agent-admissions`, await token('employee'),
      { surface: 'conversation', routeKind: 'byo' });
    expect(employee.status).toBe(200);
    expect(employee.body.decision).toMatchObject({ admitted: true, planId: 'business' });
    expect(employee.body.pins).toMatchObject({ organizationId: orgs.juniper, planId: 'business', policyRevision: 1 });

    // Harbor Hardware is a real business with an owner, but holds no plan.
    const harbor = await call('POST', `/account/organizations/${orgs.harbor}/agent-admissions`, await token('harborOwner'),
      { surface: 'work', routeKind: 'managed' });
    expect(harbor.body.decision).toMatchObject({ admitted: false, code: 'agent_not_included' });
  });

  it('refuses a person who is not a member, and never reveals the other business', async () => {
    const free = await call('POST', `/account/organizations/${orgs.juniper}/agent-admissions`, await token('free'),
      { surface: 'conversation', routeKind: 'byo' });
    expect(free.status).toBe(403);
  });

  it('stops new Agent work when Billing withdraws the grant, and records both decisions', async () => {
    const employee = await token('employee');
    expect((await call('POST', `/account/organizations/${orgs.juniper}/agent-admissions`, employee, { surface: 'loop', routeKind: 'managed', rootJobId: 'job-1' })).body.decision.admitted).toBe(true);
    const billing = await token('staffBilling');
    const detail = await call('GET', `/ops/customers/${orgs.juniper}`, billing);
    const grantId = detail.body.grants[0].id;
    expect((await call('POST', `/ops/customers/${orgs.juniper}/grants/${grantId}/revoke`, billing, { reason: 'Subscription cancelled.' })).status).toBe(200);
    const after = await call('POST', `/account/organizations/${orgs.juniper}/agent-admissions`, employee, { surface: 'loop', routeKind: 'managed', rootJobId: 'job-1' });
    expect(after.body.decision).toMatchObject({ admitted: false, code: 'entitlement_revoked' });
    // Membership and the business are untouched; only the Agent stopped.
    const access = await call('GET', `/account/organizations/${orgs.juniper}/access`, employee);
    expect(access.body).toMatchObject({ state: 'revoked', role: 'member', agent: { included: false } });
    const record = await call('GET', `/ops/customers/${orgs.juniper}`, billing);
    expect(record.body.admissions.map((row: { decision: string }) => row.decision)).toEqual(['refused', 'admitted']);
    expect(record.body.audit.some((row: { action: string }) => row.action === 'grant.revoked')).toBe(true);
    // A second revoke of the same grant is refused rather than rewritten.
    expect((await call('POST', `/ops/customers/${orgs.juniper}/grants/${grantId}/revoke`, billing, { reason: 'again' })).status).toBe(409);
  });

  it('reads an ended grant as expired, not as no plan', async () => {
    clock += 40 * 24 * 60 * 60 * 1000;
    const decision = await call('POST', `/account/organizations/${orgs.juniper}/agent-admissions`, await token('owner'), { surface: 'work', routeKind: 'byo' });
    expect(decision.body.decision).toMatchObject({ admitted: false, code: 'entitlement_expired' });
  });

  it('only an account-service view can read as active', () => {
    expect(snapshotFromView(NO_ENTITLEMENT_VIEW).state).toBe('none');
    // A hand-built "active" view that did not come from the service is still none.
    expect(snapshotFromView({ ...NO_ENTITLEMENT_VIEW, state: 'active', agent: true, features: ['nectovia-agent'] }).state).toBe('none');
    const grant: FeatureGrant = {
      v: 1, id: 'grant_1', organizationId: 'org_1', tenantId: 'tenant_1', planId: 'business', features: ['nectovia-agent'],
      source: 'subscription', reference: 'inv_1', note: '', validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2026-10-01T00:00:00.000Z',
      state: 'active', issuedAt: '2026-09-01T00:00:00.000Z', issuedBy: 'person_1', revokedAt: null, revokedBy: null, revokedReason: null,
    };
    const view = entitlementFromGrants([grant], 3, '2026-09-15T00:00:00.000Z');
    expect(decideAgentAdmission({ workspace: 'business', member: true, entitlement: snapshotFromView(view), at: '2026-09-15T00:00:00.000Z' }).admitted).toBe(true);
    expect(decideAgentAdmission({ workspace: 'personal', member: true, entitlement: snapshotFromView(view), at: '2026-09-15T00:00:00.000Z' }))
      .toMatchObject({ admitted: false, code: 'personal_workspace' });
    // Included usage without the Agent feature does not unlock the Agent.
    const fundingOnly = entitlementFromGrants([{ ...grant, features: ['managed-inference'] }], 4, '2026-09-15T00:00:00.000Z');
    expect(decideAgentAdmission({ workspace: 'business', member: true, entitlement: snapshotFromView(fundingOnly), at: '2026-09-15T00:00:00.000Z' }))
      .toMatchObject({ admitted: false, code: 'agent_not_included' });
  });
});

describe('what each customer role sees and may do', () => {
  it('shows the plan to everyone and the grants only to the Business owner', async () => {
    const owner = await call('GET', `/account/organizations/${orgs.juniper}/access`, await token('owner'));
    expect(owner.body).toMatchObject({ roleLabel: 'Business owner', planLabel: 'Business', agent: { included: true } });
    expect(owner.body.grants).toHaveLength(1);
    const manager = await call('GET', `/account/organizations/${orgs.juniper}/access`, await token('manager'));
    expect(manager.body).toMatchObject({ roleLabel: 'Manager', planLabel: 'Business', grants: null, capabilities: { managePeople: 'employees', seePlan: false } });
    const employee = await call('GET', `/account/organizations/${orgs.juniper}/access`, await token('employee'));
    expect(employee.body).toMatchObject({ roleLabel: 'Employee', grants: null, capabilities: { managePeople: 'nobody', configure: false } });
  });

  it('lets a Manager invite and remove Employees, and nothing more', async () => {
    const manager = await token('manager');
    expect((await call('POST', `/account/organizations/${orgs.juniper}/invitation-codes`, manager, { role: 'member', ttlMs: 3_600_000 })).status).toBe(201);
    expect((await call('POST', `/account/organizations/${orgs.juniper}/invitation-codes`, manager, { role: 'admin', ttlMs: 3_600_000 })).status).toBe(403);
    expect((await call('POST', `/account/organizations/${orgs.juniper}/invitation-codes`, manager, { role: 'owner', ttlMs: 3_600_000 })).status).toBe(403);
    const roster = await call('GET', `/account/organizations/${orgs.juniper}/roster`, manager);
    const byRole = (role: string) => roster.body.people.find((person: { role: string }) => person.role === role).personId;
    // No promotion, not even of an Employee; no changes to the owner; not themselves.
    expect((await call('PATCH', `/account/organizations/${orgs.juniper}/members/${byRole('member')}`, manager, { role: 'admin', state: 'active' })).status).toBe(403);
    expect((await call('PATCH', `/account/organizations/${orgs.juniper}/members/${byRole('owner')}`, manager, { role: 'owner', state: 'revoked' })).status).toBe(403);
    expect((await call('PATCH', `/account/organizations/${orgs.juniper}/members/${byRole('admin')}`, manager, { role: 'admin', state: 'revoked' })).status).toBe(403);
    const removed = await call('PATCH', `/account/organizations/${orgs.juniper}/members/${byRole('member')}`, manager, { role: 'member', state: 'revoked' });
    expect(removed.body).toMatchObject({ state: 'revoked', revokedReason: 'Removed by a Manager.' });
    // The removed Employee can no longer use the Agent here.
    expect((await call('POST', `/account/organizations/${orgs.juniper}/agent-admissions`, await token('employee'), { surface: 'work', routeKind: 'byo' })).status).toBe(403);
  });

  it('keeps Employees out of people management and hides removed members from them', async () => {
    const employee = await token('employee');
    expect((await call('POST', `/account/organizations/${orgs.juniper}/invitation-codes`, employee, { role: 'member', ttlMs: 3_600_000 })).status).toBe(403);
    const roster = await call('GET', `/account/organizations/${orgs.juniper}/roster`, employee);
    expect(roster.body.invitations).toBeNull();
    expect(roster.body.people.every((person: { state: string }) => person.state === 'active')).toBe(true);
  });

  it('makes invitation codes single-use, email-bound when asked, and void when the inviter loses authority', async () => {
    const owner = await token('owner');
    const bound = await call('POST', `/account/organizations/${orgs.juniper}/invitation-codes`, owner, { role: 'member', email: 'someone@else.test', ttlMs: 3_600_000 });
    expect((await call('POST', '/account/invitation-codes/redeem', await token('free'), { code: bound.body.code })).status).toBe(403);

    const open = await call('POST', `/account/organizations/${orgs.harbor}/invitation-codes`, await token('harborOwner'), { role: 'member', ttlMs: 3_600_000 });
    const joined = await call('POST', '/account/invitation-codes/redeem', await token('free'), { code: open.body.code.toLowerCase() });
    expect(joined.status).toBe(200);
    expect((await call('POST', '/account/invitation-codes/redeem', await token('employee'), { code: open.body.code })).status).toBe(409);

    // A Manager's code stops working once the Manager is removed.
    const manager = await token('manager');
    const code = await call('POST', `/account/organizations/${orgs.juniper}/invitation-codes`, manager, { role: 'member', ttlMs: 3_600_000 });
    const roster = await call('GET', `/account/organizations/${orgs.juniper}/roster`, owner);
    const managerId = roster.body.people.find((person: { role: string }) => person.role === 'admin').personId;
    await call('PATCH', `/account/organizations/${orgs.juniper}/members/${managerId}`, owner, { role: 'admin', state: 'revoked' });
    expect((await call('POST', '/account/invitation-codes/redeem', await token('harborOwner'), { code: code.body.code })).status).toBe(403);

    // Withdrawn codes are refused by name.
    const withdrawn = await call('POST', `/account/organizations/${orgs.juniper}/invitation-codes`, owner, { role: 'member', ttlMs: 3_600_000 });
    expect((await call('POST', `/account/organizations/${orgs.juniper}/invitation-codes/${withdrawn.body.id}/revoke`, owner, {})).status).toBe(204);
    expect((await call('POST', '/account/invitation-codes/redeem', await token('harborOwner'), { code: withdrawn.body.code })).status).toBe(410);
  });
});

describe('Diomedes staff administration', () => {
  it('keeps customers, including a Business owner, out of the staff API', async () => {
    expect((await call('GET', '/ops/me', await token('owner'))).status).toBe(403);
    expect((await call('GET', '/ops/customers', await token('free'))).status).toBe(403);
  });

  it('gives each staff role only its own powers', async () => {
    const support = await token('staffSupport');
    expect((await call('GET', '/ops/customers?q=juniper', support)).body).toHaveLength(1);
    expect((await call('POST', `/ops/customers/${orgs.harbor}/grants`, support, { planId: 'business', source: 'subscription', reference: 'inv_1', note: '' })).status).toBe(403);
    const routing = await token('staffRouting');
    expect((await call('POST', `/ops/customers/${orgs.harbor}/grants`, routing, { planId: 'business', source: 'subscription', reference: 'inv_1', note: '' })).status).toBe(403);
    const billing = await token('staffBilling');
    expect((await call('POST', '/ops/routing/publish', billing, { tiers: { efficient: 'aws-luna-5-6', focused: null, thorough: null }, note: 'x', baseRevision: 1 })).status).toBe(403);
    const issued = await call('POST', `/ops/customers/${orgs.harbor}/grants`, billing, { planId: 'business', source: 'subscription', reference: 'inv_1', note: 'Signed up.' });
    expect(issued.status).toBe(201);
    expect(issued.body.funding.allocated).toBe(true);
    expect((await call('POST', `/account/organizations/${orgs.harbor}/agent-admissions`, await token('harborOwner'), { surface: 'work', routeKind: 'managed' })).body.decision.admitted).toBe(true);
    // Credits: this month's 1,000 plus 250 added by Billing.
    expect((await call('POST', `/ops/customers/${orgs.harbor}/funding`, billing, { credits: 250, reason: 'Implementation includes 250 credits.' })).status).toBe(201);
    const usage = await call('GET', `/account/organizations/${orgs.harbor}/usage`, await token('harborOwner'));
    expect(usage.body.state).toBe('ready');
    expect((await call('POST', '/ops/staff', support, { personId: 'person_x', role: 'admin' })).status).toBe(403);
  });

  it('publishes only qualified routes, refuses a stale publish, and rolls back as a new revision', async () => {
    const routing = await token('staffRouting');
    expect((await call('POST', '/ops/routing/publish', routing, { tiers: { efficient: 'aws-luna-6', focused: null, thorough: null }, note: 'Try GPT-6 Luna', baseRevision: 1 })).status).toBe(422);
    const qualified = await call('POST', '/ops/routes', routing, { id: 'aws-luna-6', provider: 'aws-bedrock', model: 'us.openai.gpt-6-luna', label: 'GPT-6 Luna', region: 'us',
      processing: 'AWS Bedrock US.', status: 'qualified', evidence: 'Live proof run 2026-09-25 on the company account.', baseRevision: 1 });
    expect(qualified.status).toBe(200);
    const preview = await call('POST', '/ops/routing/preview', routing, { tiers: { efficient: 'aws-luna-6', focused: 'vertex-gemini-3-8-flash', thorough: null }, note: 'Move Efficient', baseRevision: 1 });
    expect(preview.body).toMatchObject({ baseRevision: 1, affectedCustomers: 1 });
    expect(preview.body.changes).toHaveLength(1);
    const published = await call('POST', '/ops/routing/publish', routing, { tiers: { efficient: 'aws-luna-6', focused: 'vertex-gemini-3-8-flash', thorough: null }, note: 'Move Efficient to GPT-6 Luna.', baseRevision: 1 });
    expect(published.body).toMatchObject({ revision: 2, tiers: { efficient: { model: 'us.openai.gpt-6-luna' } } });
    expect((await call('POST', '/ops/routing/publish', routing, { tiers: { efficient: 'aws-luna-5-6', focused: null, thorough: null }, note: 'stale', baseRevision: 1 })).status).toBe(409);
    // A route in use cannot be unqualified until a policy stops using it.
    expect((await call('POST', '/ops/routes', routing, { id: 'aws-luna-6', provider: 'aws-bedrock', model: 'us.openai.gpt-6-luna', label: 'GPT-6 Luna', region: 'us',
      processing: 'AWS Bedrock US.', status: 'unqualified', evidence: '', baseRevision: 2 })).status).toBe(409);
    const rolled = await call('POST', '/ops/routing/rollback', routing, { toRevision: 1, note: 'Back to GPT-5.6 Luna.', baseRevision: 2 });
    expect(rolled.body).toMatchObject({ revision: 3, kind: 'rollback', basedOn: 1, tiers: { efficient: { model: 'us.openai.gpt-5.6-luna' } } });
    // Customers read the policy by tier, with identifiers only.
    const policy = await call('GET', '/account/routing-policy', await token('employee'));
    expect(policy.body).toMatchObject({ revision: 3, tiers: { efficient: { provider: 'aws-bedrock' }, thorough: null } });
    expect(JSON.stringify(policy.body)).not.toMatch(/secret|password|apiKey/i);
    const audit = await call('GET', '/ops/audit?limit=50', routing);
    expect(audit.body.map((row: { action: string }) => row.action)).toEqual(expect.arrayContaining(['policy.published', 'policy.rolled-back', 'route.saved']));
  });

  it('never leaves staff without an active admin', async () => {
    const admin = await token('staffAdmin');
    const staff = await call('GET', '/ops/staff', admin);
    const adminId = staff.body.find((row: { role: string }) => row.role === 'admin').personId;
    expect((await call('PATCH', `/ops/staff/${adminId}`, admin, { role: 'support', state: 'active' })).status).toBe(409);
    const supportId = staff.body.find((row: { role: string }) => row.role === 'support').personId;
    expect((await call('PATCH', `/ops/staff/${supportId}`, admin, { role: 'support', state: 'disabled' })).status).toBe(200);
    expect((await call('GET', '/ops/me', await token('staffSupport'))).status).toBe(403);
  });
});

describe('the faux sign-in service', () => {
  it('refuses a wrong password without saying which part was wrong, and locks after five tries', async () => {
    const wrong = { email: DEMO_ACCOUNTS.owner.email, password: 'not-it' };
    const unknown = await call('POST', '/auth/sign-in', undefined, { email: 'nobody@juniper.test', password: 'whatever' });
    const bad = await call('POST', '/auth/sign-in', undefined, wrong);
    expect([unknown.status, bad.status]).toEqual([401, 401]);
    expect(unknown.body.error).toBe(bad.body.error);
    for (let attempt = 0; attempt < 4; attempt++) await call('POST', '/auth/sign-in', undefined, wrong);
    expect((await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD })).status).toBe(429);
    clock += 61_000;
    expect((await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD })).status).toBe(200);
  });

  it('remembers a sign-in for 30 days when asked and 12 hours otherwise, and rotates refresh tokens', async () => {
    const remembered = await signIn('owner', true);
    const brief = await signIn('owner', false);
    expect(Date.parse(remembered.refreshExpiresAt) - clock).toBe(30 * 24 * 60 * 60 * 1000);
    expect(Date.parse(brief.refreshExpiresAt) - clock).toBe(12 * 60 * 60 * 1000);
    const next = await call('POST', '/auth/refresh', undefined, { refreshToken: remembered.refreshToken });
    expect(next.status).toBe(200);
    expect((await call('POST', '/auth/refresh', undefined, { refreshToken: remembered.refreshToken })).status).toBe(401);
    // Access tokens expire after ten minutes; the refreshed one keeps working until then.
    expect((await call('GET', '/account/session', next.body.accessToken)).status).toBe(200);
    clock += 11 * 60_000;
    expect((await call('GET', '/account/session', next.body.accessToken)).status).toBe(401);
  });

  it('ends a sign-in on sign-out, for its access token too', async () => {
    const pair = await signIn('employee', true);
    expect((await call('POST', '/auth/sign-out', undefined, { refreshToken: pair.refreshToken })).status).toBe(204);
    expect((await call('GET', '/account/session', pair.accessToken)).status).toBe(401);
    expect((await call('POST', '/auth/refresh', undefined, { refreshToken: pair.refreshToken })).status).toBe(401);
  });

  it('creates an account, which starts with no business and no Agent', async () => {
    const created = await call('POST', '/auth/sign-up', undefined, { name: 'New Person', email: 'New@Example.test', password: 'long-enough' });
    expect(created.status).toBe(201);
    expect((await call('POST', '/auth/sign-up', undefined, { name: 'Again', email: 'new@example.test', password: 'long-enough' })).status).toBe(409);
    const session = await call('GET', '/account/session', created.body.accessToken);
    expect(session.body.organizations).toEqual([]);
    const business = await call('POST', '/account/organizations', created.body.accessToken, { name: 'New Person Plumbing' });
    const access = await call('GET', `/account/organizations/${business.body.id}/access`, created.body.accessToken);
    expect(access.body).toMatchObject({ role: 'owner', state: 'none', agent: { included: false } });
  });
});

describe('the faux store on disk', () => {
  it('keeps accounts, grants and policy across a restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'faux-cloud-'));
    try {
      const file = path.join(dir, 'faux.json');
      const first = await createFauxCloud({ file, now, passwordIterations: 1_000 });
      const seeded = await seedDemo(first);
      const again = await createFauxCloud({ file, now, passwordIterations: 1_000 });
      expect((await seedDemo(again)).seeded).toBe(false);
      cloud = again;
      const access = await call('GET', `/account/organizations/${seeded.organizations!.juniper}/access`, await token('owner'));
      expect(access.body).toMatchObject({ planLabel: 'Business', agent: { included: true } });
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ faux: true, v: 1 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
