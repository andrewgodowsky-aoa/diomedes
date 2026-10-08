/**
 * Who may reserve allowance through the HTTP route (Andrew, 2026-09-30).
 *
 * "No one should be allowed to reserve allowance ... any member of diomedes
 * can, but not nectovia subscribers unless they've paid for that api outright
 * (e.g. not our included usage)."
 *
 * The account service now says which signed-in person is active Diomedes
 * staff (an active staff row, never an email domain or anything in a request),
 * so staff may reserve and settle. The local allowance ledger still keeps one
 * pool with no line for usage bought outright, so nobody else can: a person
 * asking over HTTP to hold or settle included allowance is refused whatever
 * their role in the business, owner included, and so is staff whose row is
 * disabled or whose standing cannot be read. What stays as it was: a
 * non-member still reads as absent (staff included), a route that costs the
 * allowance nothing still admits, and the app's own admission (no HTTP
 * caller) still holds allowance for a paid business.
 *
 * The route is mounted here over a real ledger and gateway with an invented
 * paid, may-leave business, because the real host has no entitlement service
 * and would refuse earlier for that reason. Every person and figure is invented.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BillingEventProcessor } from '../server/billing-events.js';
import { ManagedGateway } from '../server/managed-gateway.js';
import { AllowanceLedger } from '../server/managed-usage.js';
import { mountManagedUsageRoutes } from '../server/managed-usage-routes.js';
import { ApiError } from '../server/paths.js';
import { Store } from '../server/store.js';
import type { WorkspaceService } from '../server/workspaces.js';
import { approvedJobCap, dollars } from '../shared/managed-usage.js';
import { NO_ENTITLEMENT_VIEW } from '../shared/workspaces.js';

const AT = new Date().toISOString();
const ORG = 'org_reserve';
const PERIOD = AT.slice(0, 7);

// `staff` is an active staff row. `disabledStaff` is a person whose row is disabled, and
// `unreadStaff` is staff the account service could not be asked about: both read as not staff.
type Who = 'owner' | 'member' | 'outsider' | 'staff' | 'disabledStaff' | 'unreadStaff';

let root = '';
let server: Server | undefined;
let url = '';
let ledger: AllowanceLedger;
let who: Who = 'owner';

const paid = { ...NO_ENTITLEMENT_VIEW, managedInference: true };

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

beforeEach(async () => {
  who = 'owner';
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'reserve-access-'));
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
    tenantFor: () => 'tenant_reserve',
    memberOf: (_organizationId, personId) => personId !== 'person_outsider',
    billingStatusFor: async () => ({ suspended: false, suspendedReason: null }),
    jobCapFor: () => approvedJobCap('efficient'),
    policyFor: () => ({ processing: 'may-leave', organizationRoute: 'managed' }),
  });
  // Only what the route reads of the workspace service. A stranger reads as absent, as in the host.
  const workspaces = {
    assertMine: () => {
      if (who === 'outsider')
        throw new ApiError(404, 'That business was not found.', { code: 'organization_not_found' });
    },
    currentPerson: () => ({ id: `person_${who}` }),
    entitlementOf: () => paid,
  } as unknown as WorkspaceService;
  const app = express();
  app.use(express.json());
  // The host's own read of the signed-in person's standing, as AccountSessionService.staffRole() answers it.
  const staff = {
    staffRole: async () => {
      if (who === 'unreadStaff') throw new Error('The account service did not answer.');
      return who === 'staff' ? ('support' as const) : null;
    },
  };
  mountManagedUsageRoutes(app, store, ledger, gateway, billing, workspaces, staff);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) res.status(error.status).json({ error: error.message, ...error.details });
    else res.status(500).json({ error: String(error) });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

describe('reserving included allowance over HTTP', () => {
  test('an owner is refused with a 403 and a plain reason, and nothing is held', async () => {
    who = 'owner';
    const answer = await post('admit', ask());
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_reservation_refused');
    expect(answer.data.error).toMatch(/can’t reserve this business’s included usage/i);
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('an employee is refused the same way', async () => {
    who = 'member';
    const answer = await post('admit', ask());
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_reservation_refused');
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('a body that calls itself staff, internal or paid changes nothing', async () => {
    who = 'member';
    const answer = await post(
      'admit',
      ask({ staff: true, internal: true, paid: true, purchased: true, directReservation: false, role: 'admin' }),
    );
    expect(answer.status).toBe(403);
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('a body that names a staff role for itself changes nothing', async () => {
    who = 'member';
    const answer = await post(
      'admit',
      ask({ staffRole: 'admin', staff: { role: 'admin' }, directReservation: false, reservationId: 'res_forged' }),
    );
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_reservation_refused');
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('active staff reserve, and the hold is real', async () => {
    who = 'staff';
    const answer = await post('admit', ask({ reservationId: 'res_staff' }));
    expect(answer.status).toBe(200);
    expect(answer.data.admitted).toBe(true);
    expect(answer.data.payer).toBe('managed');
    expect(answer.data.reservation.id).toBe('res_staff');
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(dollars(1));
  });

  test('staff still meet every other gate: a call past the job cap is held to it', async () => {
    who = 'staff';
    const answer = await post('admit', ask({ maxMicroUsd: dollars(500), reservationId: 'res_big' }));
    expect(answer.status).toBe(200);
    expect(answer.data.admitted).toBe(false);
    expect(answer.data.code).toBe('job_cap_reached');
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('staff whose row is disabled are refused like anyone else, and nothing is held', async () => {
    who = 'disabledStaff';
    const answer = await post('admit', ask({ reservationId: 'res_disabled' }));
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_reservation_refused');
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('when the account service cannot be asked, nobody is staff', async () => {
    who = 'unreadStaff';
    const answer = await post('admit', ask({ reservationId: 'res_unread' }));
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_reservation_refused');
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('a non-member still reads as absent, not as forbidden', async () => {
    who = 'outsider';
    const answer = await post('admit', ask());
    expect(answer.status).toBe(404);
    expect(answer.data.code).toBe('organization_not_found');
  });

  test('a route that costs the allowance nothing is admitted as before', async () => {
    who = 'member';
    const answer = await post('admit', ask({ route: 'ollama', reservationId: 'res_local' }));
    expect(answer.status).toBe(200);
    expect(answer.data.admitted).toBe(true);
    expect(answer.data.payer).toBe('local');
    expect(answer.data.reservation).toBeNull();
  });

  test('a malformed request is still a 400, not a 403', async () => {
    who = 'owner';
    const answer = await post('admit', ask({ maxMicroUsd: 1.5 }));
    expect(answer.status).toBe(400);
  });

  test('the app’s own admission for this paid business still holds allowance', async () => {
    // The same gateway the route uses, asked the way the host asks (no direct flag).
    const gateway = new ManagedGateway({
      ledger,
      entitlementFor: () => paid,
      tenantFor: () => 'tenant_reserve',
      memberOf: () => true,
      billingStatusFor: async () => ({ suspended: false, suspendedReason: null }),
      jobCapFor: () => approvedJobCap('efficient'),
      policyFor: () => ({ processing: 'may-leave', organizationRoute: 'managed' }),
    });
    const admitted = await gateway.admit({
      organizationId: ORG,
      personId: 'person_owner',
      route: 'codex',
      kind: 'generation',
      parentTaskId: null,
      maxMicroUsd: dollars(1),
      requestDigest: 'digest-host',
      reservationId: 'res_host',
      periodId: PERIOD,
      at: AT,
    });
    expect(admitted.admitted).toBe(true);
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(dollars(1));
  });
});

describe('settling included allowance over HTTP', () => {
  const settle = (overrides: Record<string, unknown> = {}) => ({
    reservationId: 'res_held',
    providerCostMicroUsd: dollars(0.5),
    allowanceDebitMicroUsd: dollars(0.5),
    ...overrides,
  });

  // A hold the way the app takes one: through the gateway the host asks, with no direct flag.
  async function holdOne() {
    const gateway = new ManagedGateway({
      ledger,
      entitlementFor: () => paid,
      tenantFor: () => 'tenant_reserve',
      memberOf: () => true,
      billingStatusFor: async () => ({ suspended: false, suspendedReason: null }),
      jobCapFor: () => approvedJobCap('efficient'),
      policyFor: () => ({ processing: 'may-leave', organizationRoute: 'managed' }),
    });
    const held = await gateway.admit({
      organizationId: ORG,
      personId: 'person_owner',
      route: 'codex',
      kind: 'generation',
      parentTaskId: null,
      maxMicroUsd: dollars(1),
      requestDigest: 'digest-held',
      reservationId: 'res_held',
      periodId: PERIOD,
      at: AT,
    });
    expect(held.admitted).toBe(true);
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(dollars(1));
  }

  test('an owner cannot settle, and the hold is left exactly as it was', async () => {
    await holdOne();
    who = 'owner';
    const answer = await post('settle', settle());
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_settle_refused');
    expect(answer.data.error).toMatch(/You can’t settle it directly/i);
    expect(answer.data.error).toMatch(/Nectovia records usage when your work finishes\./);
    const summary = ledger.summary(ORG, PERIOD);
    expect(summary.pendingMicroUsd).toBe(dollars(1));
    expect(summary.settledMicroUsd).toBe(0);
  });

  test('an employee cannot settle either', async () => {
    await holdOne();
    who = 'member';
    const answer = await post('settle', settle());
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_settle_refused');
    expect(ledger.summary(ORG, PERIOD).settledMicroUsd).toBe(0);
  });

  test('a body that calls itself staff or paid changes nothing', async () => {
    await holdOne();
    who = 'member';
    const answer = await post(
      'settle',
      settle({ staff: true, staffRole: 'admin', internal: true, paid: true, purchased: true, role: 'admin' }),
    );
    expect(answer.status).toBe(403);
    expect(ledger.summary(ORG, PERIOD).settledMicroUsd).toBe(0);
  });

  test('a refused settle does not say whether the body would have been valid', async () => {
    await holdOne();
    who = 'owner';
    const answer = await post('settle', { reservationId: 'res_held' });
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_settle_refused');
  });

  test('staff whose row is disabled cannot settle', async () => {
    await holdOne();
    who = 'disabledStaff';
    const answer = await post('settle', settle());
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_settle_refused');
    expect(ledger.summary(ORG, PERIOD).settledMicroUsd).toBe(0);
  });

  test('when the account service cannot be asked, nobody can settle', async () => {
    await holdOne();
    who = 'unreadStaff';
    const answer = await post('settle', settle());
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_settle_refused');
  });

  test('active staff can settle, and the hold becomes a settled charge', async () => {
    await holdOne();
    who = 'staff';
    const answer = await post('settle', settle());
    expect(answer.status).toBe(200);
    expect(answer.data.reservationId).toBe('res_held');
    const summary = ledger.summary(ORG, PERIOD);
    expect(summary.pendingMicroUsd).toBe(0);
    expect(summary.settledMicroUsd).toBe(dollars(0.5));
  });

  test('a non-member still reads as absent when settling', async () => {
    who = 'outsider';
    const answer = await post('settle', settle());
    expect(answer.status).toBe(404);
    expect(answer.data.code).toBe('organization_not_found');
  });

  test('the ledger itself still settles for an in-process caller', async () => {
    await holdOne();
    const charge = await ledger.settle({
      reservationId: 'res_held',
      organizationId: ORG,
      providerCostMicroUsd: dollars(0.25),
      allowanceDebitMicroUsd: dollars(0.25),
      reconciledFrom: 'response',
      at: AT,
    });
    expect(charge.allowanceDebitMicroUsd).toBe(dollars(0.25));
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });
});
