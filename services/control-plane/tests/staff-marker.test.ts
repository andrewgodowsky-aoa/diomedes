/**
 * The staff marker beside the session page (Andrew, 2026-09-30: staff may reserve allowance,
 * nobody else may).
 *
 * The desktop reads the signed-in person's standing from the account service, never from an
 * email address, a request, or a plan: `/account/session` answers `staff: { role }` for a person
 * with an ACTIVE staff row and `staff: null` for everyone else. Run over the faux cloud, which is
 * the Worker's own handler over a local store, so the same rule is what the deployed service
 * applies. Every person here is one of the faux seed's invented demo accounts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';

let cloud: FauxCloud;

async function call(method: string, pathname: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const init = new Headers(headers);
  if (token) init.set('authorization', `Bearer ${token}`);
  if (body !== undefined) init.set('content-type', 'application/json');
  const response = await cloud.handle(new Request(`http://127.0.0.1:8795${pathname}`, {
    method, headers: init, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function token(who: DemoAccount) {
  const result = await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD, remember: false });
  expect(result.status).toBe(200);
  return result.body.accessToken as string;
}

async function session(who: DemoAccount) {
  const page = await call('GET', '/account/session', await token(who));
  expect(page.status).toBe(200);
  return page.body as { person: { id: string }; staff?: unknown };
}

beforeEach(async () => {
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  expect((await seedDemo(cloud)).seeded).toBe(true);
});

describe('the staff marker on the session page', () => {
  it('names the role of each active staff member', async () => {
    expect((await session('staffAdmin')).staff).toEqual({ role: 'admin' });
    expect((await session('staffSupport')).staff).toEqual({ role: 'support' });
    expect((await session('staffBilling')).staff).toEqual({ role: 'billing' });
    expect((await session('staffRouting')).staff).toEqual({ role: 'routing' });
  });

  it('is an explicit null for a customer, including one whose business holds an internal-test plan', async () => {
    for (const who of ['owner', 'manager', 'employee', 'harborOwner', 'free'] as const) {
      const page = await session(who);
      expect(page).toHaveProperty('staff', null);
    }
  });

  it('stops naming a person the moment their row is disabled, and names them again when it is restored', async () => {
    const admin = await token('staffAdmin');
    const support = await session('staffSupport');
    const disabled = await call('PATCH', `/ops/staff/${support.person.id}`, admin, { role: 'support', state: 'disabled' });
    expect(disabled.status).toBe(200);
    expect((await session('staffSupport')).staff).toBeNull();

    const restored = await call('PATCH', `/ops/staff/${support.person.id}`, admin, { role: 'support', state: 'active' });
    expect(restored.status).toBe(200);
    expect((await session('staffSupport')).staff).toEqual({ role: 'support' });
  });

  it('follows a change of role', async () => {
    const admin = await token('staffAdmin');
    const billing = await session('staffBilling');
    expect((await call('PATCH', `/ops/staff/${billing.person.id}`, admin, { role: 'routing', state: 'active' })).status).toBe(200);
    expect((await session('staffBilling')).staff).toEqual({ role: 'routing' });
  });

  it('is not taken from an email domain: a new account at the company domain is no one', async () => {
    const created = await call('POST', '/auth/sign-up', undefined, { name: 'New Hire', email: 'new.hire@diomedes.test', password: FAUX_DEMO_PASSWORD, remember: false });
    expect(created.status).toBeLessThan(300);
    const page = await call('GET', '/account/session', created.body.accessToken);
    expect(page.status).toBe(200);
    expect(page.body.staff).toBeNull();
  });

  it('is not taken from the request: a customer who asks to be staff is still not', async () => {
    const owner = await token('owner');
    const page = await call('GET', '/account/session', owner, undefined, { 'x-staff-role': 'admin', 'x-staff': 'true' });
    expect(page.status).toBe(200);
    expect(page.body.staff).toBeNull();
  });

  it('keeps the rest of the page as it was', async () => {
    const page = await session('employee');
    expect(Object.keys(page).sort()).toEqual(['nextCursor', 'organizations', 'person', 'staff']);
  });
});
