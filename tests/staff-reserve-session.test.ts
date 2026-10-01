/**
 * Who the desktop takes for Diomedes staff, and what that opens (Andrew, 2026-09-30).
 *
 * `AccountSessionService.staffRole()` asks the account service, here the faux cloud in this
 * process, whether the signed-in person has an ACTIVE staff row. It remembers nothing, and it
 * says null whenever it cannot say otherwise. The second half mounts the allowance routes over
 * that real answer: staff reserve and settle; an owner, an employee, staff whose row was
 * disabled after they signed in, and a service that cannot be reached do not.
 *
 * Every person and figure is one of the faux seed's invented demo accounts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AccountBackend } from '../server/accounts/backend.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import { AccountSessionService } from '../server/accounts/session.js';
import { BillingEventProcessor } from '../server/billing-events.js';
import { ManagedGateway } from '../server/managed-gateway.js';
import { AllowanceLedger } from '../server/managed-usage.js';
import { mountManagedUsageRoutes } from '../server/managed-usage-routes.js';
import { ApiError } from '../server/paths.js';
import { Store } from '../server/store.js';
import type { WorkspaceService } from '../server/workspaces.js';
import { approvedJobCap, dollars } from '../shared/managed-usage.js';
import { NO_ENTITLEMENT_VIEW } from '../shared/workspaces.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';

const AT = new Date().toISOString();
const ORG = 'org_staff_reserve';
const PERIOD = AT.slice(0, 7);
const paid = { ...NO_ENTITLEMENT_VIEW, managedInference: true };

let cloud: FauxCloud;
let dir: string;
let intercept: ((request: Request) => Promise<Response> | null) | null;

const pathOf = (request: Request) => new URL(request.url).pathname;
const isSession = (request: Request) => request.method === 'GET' && pathOf(request) === '/account/session';

async function signedIn(email: string) {
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (request) => intercept?.(request) ?? cloud.handle(request)),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  const session = new AccountSessionService(backend, dir, null);
  await session.init();
  await session.signIn({ email, password: FAUX_DEMO_PASSWORD, remember: false });
  return session;
}

async function tokenFor(email: string) {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}

/** What the admin does in the Operations app. */
async function setStaff(personId: string, role: 'support' | 'billing' | 'routing' | 'admin', state: 'active' | 'disabled') {
  await cloud.commercial.changeStaff(await tokenFor(DEMO_ACCOUNTS.staffAdmin.email), personId, { role, state });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-staff-reserve-'));
  intercept = null;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  await seedDemo(cloud);
});
afterEach(async () => {
  intercept = null;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the desktop reads staff standing from the account service', () => {
  test('nobody is staff while signed out', async () => {
    const backend: AccountBackend = {
      client: new ControlPlaneClient('http://faux.local', (request) => cloud.handle(request)),
      view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
      close: async () => {},
    };
    const session = new AccountSessionService(backend, dir, null);
    await session.init();
    expect(await session.staffRole()).toBeNull();
  });

  test('each active staff role is read as that role, and customers as nobody', async () => {
    expect(await (await signedIn(DEMO_ACCOUNTS.staffAdmin.email)).staffRole()).toBe('admin');
    expect(await (await signedIn(DEMO_ACCOUNTS.staffSupport.email)).staffRole()).toBe('support');
    expect(await (await signedIn(DEMO_ACCOUNTS.staffBilling.email)).staffRole()).toBe('billing');
    for (const who of ['owner', 'manager', 'employee', 'harborOwner', 'free'] as const)
      expect(await (await signedIn(DEMO_ACCOUNTS[who].email)).staffRole(), who).toBeNull();
  });

  test('a row disabled after sign-in stops counting at the next question, not the next sign-in', async () => {
    const session = await signedIn(DEMO_ACCOUNTS.staffSupport.email);
    expect(await session.staffRole()).toBe('support');
    await setStaff(session.personId()!, 'support', 'disabled');
    expect(await session.staffRole()).toBeNull();
    await setStaff(session.personId()!, 'support', 'active');
    expect(await session.staffRole()).toBe('support');
  });

  test('an unreachable service, an older service and an unreadable marker all say nobody', async () => {
    const session = await signedIn(DEMO_ACCOUNTS.staffSupport.email);
    expect(await session.staffRole()).toBe('support');

    intercept = (request) => (isSession(request) ? Promise.reject(new Error('offline')) : null);
    expect(await session.staffRole()).toBeNull();

    const withStaff = (staff: unknown, omit = false) =>
      (request: Request) =>
        isSession(request)
          ? cloud.handle(request).then(async (response) => {
              const page = (await response.json()) as Record<string, unknown>;
              if (omit) delete page.staff;
              else page.staff = staff;
              return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
            })
          : null;
    intercept = withStaff(undefined, true);
    expect(await session.staffRole(), 'a service from before the marker').toBeNull();
    intercept = withStaff({ role: 'superuser' });
    expect(await session.staffRole(), 'a role this build does not know').toBeNull();
    intercept = withStaff('admin');
    expect(await session.staffRole(), 'a marker that is not an object').toBeNull();
    intercept = withStaff({ role: 'admin' });
    expect(await session.staffRole(), 'a known role is believed').toBe('admin');
  });

  test('a marker that comes with a different person than the one signed in is not believed', async () => {
    const session = await signedIn(DEMO_ACCOUNTS.staffSupport.email);
    intercept = (request) =>
      isSession(request)
        ? cloud.handle(request).then(async (response) => {
            const page = (await response.json()) as { person: { id: string } };
            page.person = { ...page.person, id: 'person_someone_else' };
            return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
          })
        : null;
    expect(await session.staffRole()).toBeNull();
  });
});

describe('what that opens at the allowance routes', () => {
  let root = '';
  let server: Server | undefined;
  let url = '';
  let ledger: AllowanceLedger;

  async function mount(session: AccountSessionService, withReader = true) {
    await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
    root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'staff-reserve-'));
    const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    ledger = new AllowanceLedger(store);
    await ledger.init();
    await ledger.allocatePeriod({
      organizationId: ORG,
      periodId: PERIOD,
      planVersion: 'plan-test',
      rateCardVersion: 'rate-card-2026-09-10.1',
      grantedMicroUsd: dollars(10),
      startsAt: AT,
      endsAt: '2099-01-01T00:00:00.000Z',
      sourceEventId: 'evt_1',
      at: AT,
    });
    const billing = new BillingEventProcessor(ledger, store);
    await billing.init();
    const gateway = new ManagedGateway({
      ledger,
      entitlementFor: () => paid,
      tenantFor: () => 'tenant_staff_reserve',
      memberOf: () => true,
      billingStatusFor: async () => ({ suspended: false, suspendedReason: null }),
      jobCapFor: () => approvedJobCap('efficient'),
      policyFor: () => ({ processing: 'may-leave', organizationRoute: 'managed' }),
    });
    const workspaces = {
      assertMine: () => {},
      currentPerson: () => ({ id: session.personId() }),
      entitlementOf: () => paid,
    } as unknown as WorkspaceService;
    const app = express();
    app.use(express.json());
    mountManagedUsageRoutes(app, store, ledger, gateway, billing, workspaces, withReader ? session : null);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ error: error.message, ...error.details });
      else res.status(500).json({ error: String(error) });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = '';
  });

  async function post(route: string, body: unknown) {
    const response = await fetch(`${url}/api/workspace/organizations/${ORG}/allowance/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as any };
  }
  const ask = (overrides: Record<string, unknown> = {}) => ({
    route: 'codex',
    kind: 'generation',
    maxMicroUsd: dollars(1),
    requestDigest: 'digest-one',
    reservationId: 'res_1',
    ...overrides,
  });
  const pending = () => ledger.summary(ORG, PERIOD).pendingMicroUsd;

  test('active staff reserve, then settle what they held', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.staffSupport.email));
    const held = await post('admit', ask());
    expect(held.status).toBe(200);
    expect(held.data.admitted).toBe(true);
    expect(pending()).toBe(dollars(1));

    const settled = await post('settle', { reservationId: 'res_1', providerCostMicroUsd: dollars(0.4), allowanceDebitMicroUsd: dollars(0.4) });
    expect(settled.status).toBe(200);
    expect(pending()).toBe(0);
    expect(ledger.summary(ORG, PERIOD).settledMicroUsd).toBe(dollars(0.4));
  });

  test('a business owner is refused both, whatever the body says about itself', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    const admit = await post('admit', ask({ staff: true, staffRole: 'admin', directReservation: false, role: 'admin' }));
    expect(admit.status).toBe(403);
    expect(admit.data.code).toBe('direct_reservation_refused');
    expect(pending()).toBe(0);

    const settle = await post('settle', { reservationId: 'res_1', providerCostMicroUsd: 1, allowanceDebitMicroUsd: 1, staffRole: 'admin' });
    expect(settle.status).toBe(403);
    expect(settle.data.code).toBe('direct_settle_refused');
  });

  test('an employee is refused', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.employee.email));
    expect((await post('admit', ask())).status).toBe(403);
    expect(pending()).toBe(0);
  });

  test('staff disabled after they signed in are refused on their very next request', async () => {
    const session = await signedIn(DEMO_ACCOUNTS.staffSupport.email);
    await mount(session);
    expect((await post('admit', ask())).status).toBe(200);
    expect(pending()).toBe(dollars(1));

    await setStaff(session.personId()!, 'support', 'disabled');
    const again = await post('admit', ask({ reservationId: 'res_2', requestDigest: 'digest-two' }));
    expect(again.status).toBe(403);
    expect(again.data.code).toBe('direct_reservation_refused');
    expect(pending()).toBe(dollars(1));
    const settle = await post('settle', { reservationId: 'res_1', providerCostMicroUsd: 1, allowanceDebitMicroUsd: 1 });
    expect(settle.status).toBe(403);
    expect(ledger.summary(ORG, PERIOD).settledMicroUsd).toBe(0);
  });

  test('when the account service goes quiet, staff are refused rather than trusted', async () => {
    const session = await signedIn(DEMO_ACCOUNTS.staffSupport.email);
    await mount(session);
    intercept = (request) => (isSession(request) ? Promise.reject(new Error('offline')) : null);
    const answer = await post('admit', ask());
    expect(answer.status).toBe(403);
    expect(pending()).toBe(0);
  });

  test('with no reader mounted, as on an install without accounts, nobody is staff', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.staffSupport.email), false);
    expect((await post('admit', ask())).status).toBe(403);
    expect(pending()).toBe(0);
  });
});
