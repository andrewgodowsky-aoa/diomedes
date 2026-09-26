/**
 * The service names its membership refusals.
 *
 * Every customer endpoint that first checks the person is an active member of the business answers
 * a person who is not one with a 403 whose body carries the sentence and `code: 'not_a_member'`, so
 * the desktop can tell it from an edge page or any other 403 without reading the words (PH-07 R3-2,
 * round 4 follow-up). Refusals that are about a member's role, not their membership, carry no code.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';

let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };

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

/** Each membership-dependent customer endpoint, as the desktop and the Console call it. */
const endpoints = (organizationId: string): Record<string, [string, string, unknown?]> => ({
  'Agent admission': ['POST', `/account/organizations/${organizationId}/agent-admissions`, { surface: 'conversation', routeKind: 'managed' }],
  access: ['GET', `/account/organizations/${organizationId}/access`],
  roster: ['GET', `/account/organizations/${organizationId}/roster`],
  usage: ['GET', `/account/organizations/${organizationId}/usage`],
  'invitation code': ['POST', `/account/organizations/${organizationId}/invitation-codes`, { role: 'member', email: null, ttlMs: 86_400_000 }],
  'membership change': ['PATCH', `/account/organizations/${organizationId}/members/person_anyone`, { role: 'member', state: 'revoked' }],
});

beforeEach(async () => {
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  orgs = (await seedDemo(cloud)).organizations!;
});

describe('a membership refusal carries code not_a_member', () => {
  it('for a person who was never a member of the business', async () => {
    const free = await token('free');
    for (const [name, [method, pathname, body]] of Object.entries(endpoints(orgs.juniper))) {
      const answer = await call(method, pathname, free, body);
      expect(answer, name).toEqual({ status: 403, body: { error: 'This Business workspace is unavailable to this person.', code: 'not_a_member' } });
    }
  });

  it('for a member of another business', async () => {
    const harbor = await token('harborOwner');
    for (const [name, [method, pathname, body]] of Object.entries(endpoints(orgs.juniper))) {
      const answer = await call(method, pathname, harbor, body);
      expect(answer.status, name).toBe(403);
      expect(answer.body.code, name).toBe('not_a_member');
    }
  });

  it('for a member the owner removed, on the reads the desktop makes for access and admission', async () => {
    const employee = await token('employee');
    const admit = () => call('POST', `/account/organizations/${orgs.juniper}/agent-admissions`, employee, { surface: 'conversation', routeKind: 'byo' });
    expect((await admit()).body.decision.admitted, 'a member first').toBe(true);
    const roster = await call('GET', `/account/organizations/${orgs.juniper}/roster`, await token('owner'));
    const employeeId = roster.body.people.find((person: { name: string }) => person.name === DEMO_ACCOUNTS.employee.name).personId;
    const removed = await call('PATCH', `/account/organizations/${orgs.juniper}/members/${employeeId}`, await token('owner'), { role: 'member', state: 'revoked' });
    expect(removed.status).toBe(200);
    expect(await admit()).toEqual({ status: 403, body: { error: 'This Business workspace is unavailable to this person.', code: 'not_a_member' } });
    const access = await call('GET', `/account/organizations/${orgs.juniper}/access`, employee);
    expect(access).toEqual({ status: 403, body: { error: 'This Business workspace is unavailable to this person.', code: 'not_a_member' } });
  });

  it('refusals about a member’s role are not membership refusals and carry no code', async () => {
    const employee = await token('employee');
    const invite = await call('POST', `/account/organizations/${orgs.juniper}/invitation-codes`, employee, { role: 'admin', email: null, ttlMs: 86_400_000 });
    expect(invite.status).toBe(403);
    expect(invite.body).toEqual({ error: invite.body.error });
    expect(invite.body.code).toBeUndefined();
  });

  it('a signed-out request is still a 401, not a membership refusal', async () => {
    const answer = await call('GET', `/account/organizations/${orgs.juniper}/access`);
    expect(answer.status).toBe(401);
    expect(answer.body.code).not.toBe('not_a_member');
  });
});
