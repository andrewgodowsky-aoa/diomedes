/**
 * Reserving usage a business bought outright (Andrew, 2026-10-01: "if usage is bought outright its
 * allowed to be reserved"). Full rule: Diomedes staff may reserve allowance; a subscriber may reserve
 * only against usage the business bought outright, never against included monthly usage.
 *
 * The desktop's local ledger keeps one pool and no purchased line, so a non-staff direct reservation
 * is held by the account service, here the faux cloud in this process, against recorded top-ups only.
 * Staff keep the local path. Every person and figure is one of the faux seed's invented demo accounts.
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
import { ManagedGateway, type OrganizationPolicy, type PurchasedUsage } from '../server/managed-gateway.js';
import { AllowanceLedger } from '../server/managed-usage.js';
import { mountManagedUsageRoutes } from '../server/managed-usage-routes.js';
import { ApiError } from '../server/paths.js';
import { Store } from '../server/store.js';
import type { WorkspaceService } from '../server/workspaces.js';
import { approvedJobCap, creditAmount, dollars } from '../shared/managed-usage.js';
import { NO_ENTITLEMENT_VIEW, type EntitlementView } from '../shared/workspaces.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';

const AT = new Date().toISOString();
const PERIOD = AT.slice(0, 7);
const paid = { ...NO_ENTITLEMENT_VIEW, managedInference: true };

let cloud: FauxCloud;
let dir: string;
let ORG: string;
let calls: string[];
let intercept: ((request: Request) => Promise<Response> | null) | null;

const pathOf = (request: Request) => new URL(request.url).pathname;

async function signedIn(email: string) {
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (request) => {
      calls.push(`${request.method} ${pathOf(request)}`);
      return intercept?.(request) ?? cloud.handle(request);
    }),
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

/** The business bought credits outright: a top-up recorded the way the verified billing path records one. */
async function buy(credits: number) {
  const { organization } = await cloud.accounts.membership(await tokenFor(DEMO_ACCOUNTS.owner.email), ORG);
  await cloud.funding.recordTopUp({ tenantId: organization.tenantId, organizationId: ORG, topUpId: `topup_${credits}`, amountMicroUsd: creditAmount(credits), provider: 'stripe', sourceEventId: `evt_${credits}` });
  return organization.tenantId;
}

const cloudBalance = async () => {
  const { organization } = await cloud.accounts.membership(await tokenFor(DEMO_ACCOUNTS.owner.email), ORG);
  return cloud.funding.purchasedBalance(organization.tenantId, ORG);
};
const cloudHolds = () => cloud.store.snapshot().funding.topUpHolds;
const holdCalls = () => calls.filter((call) => call.includes('/purchased-usage/'));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-purchased-reserve-'));
  calls = [];
  intercept = null;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  const seeded = await seedDemo(cloud);
  ORG = seeded.organizations!.juniper;
});
afterEach(async () => {
  intercept = null;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a subscriber reserving at the allowance routes', () => {
  let root = '';
  let server: Server | undefined;
  let url = '';
  let ledger: AllowanceLedger;

  async function mount(session: AccountSessionService, options: {
    purchased?: boolean; entitlement?: EntitlementView; policy?: OrganizationPolicy; member?: boolean; jobCap?: number; assertMine?: () => void; assertCanSeePurchasedUsage?: () => void;
  } = {}) {
    await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
    root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'purchased-reserve-'));
    const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    ledger = new AllowanceLedger(store);
    await ledger.init();
    // The local ledger has a big included month. Whatever a subscriber reserves, none of it may come from here.
    await ledger.allocatePeriod({
      organizationId: ORG, periodId: PERIOD, planVersion: 'plan-test', rateCardVersion: 'rate-card-2026-09-10.1',
      grantedMicroUsd: dollars(10), startsAt: AT, endsAt: '2099-01-01T00:00:00.000Z', sourceEventId: 'evt_1', at: AT,
    });
    const billing = new BillingEventProcessor(ledger, store);
    await billing.init();
    const gateway = new ManagedGateway({
      ledger,
      entitlementFor: () => options.entitlement ?? paid,
      tenantFor: () => 'tenant_ignored_by_the_route',
      memberOf: () => options.member ?? true,
      billingStatusFor: async () => ({ suspended: false, suspendedReason: null }),
      jobCapFor: () => (options.jobCap === undefined ? approvedJobCap('thorough') : creditAmount(options.jobCap)),
      policyFor: () => options.policy ?? { processing: 'may-leave', organizationRoute: 'managed' },
      purchased: options.purchased === false ? null : session,
    });
    const workspaces = {
      assertMine: options.assertMine ?? (() => {}),
      assertCanSeePurchasedUsage: options.assertCanSeePurchasedUsage ?? (() => {}),
      currentPerson: () => ({ id: session.personId() }),
      entitlementOf: () => options.entitlement ?? paid,
    } as unknown as WorkspaceService;
    const app = express();
    app.use(express.json());
    mountManagedUsageRoutes(app, store, ledger, gateway, billing, workspaces, session, options.purchased === false ? null : session);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ error: error.message, ...error.details });
      else res.status(500).json({ error: String(error) });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  async function unmount() {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = '';
  }
  afterEach(unmount);

  async function post(route: string, body: unknown) {
    const response = await fetch(`${url}/api/workspace/organizations/${ORG}/allowance/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as any };
  }
  const ask = (overrides: Record<string, unknown> = {}) => ({
    route: 'codex', kind: 'generation', maxMicroUsd: creditAmount(40), requestDigest: 'digest-one', reservationId: 'res_1', ...overrides,
  });
  const local = () => ledger.summary(ORG, PERIOD);

  test('a subscriber with bought usage is admitted and settled by the service, and the local month is never touched', async () => {
    await buy(100);
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    const held = await post('admit', ask());
    expect(held.status).toBe(200);
    expect(held.data).toMatchObject({ admitted: true, payer: 'managed', reservation: { id: 'res_1', maxMicroUsd: creditAmount(40), state: 'pending' }, authorization: { reservationId: 'res_1', requestDigest: 'digest-one' } });
    expect(await cloudBalance()).toMatchObject({ purchasedMicroUsd: creditAmount(100), heldMicroUsd: creditAmount(40), availableMicroUsd: creditAmount(60) });
    expect(local()).toMatchObject({ pendingMicroUsd: 0, settledMicroUsd: 0 });

    const settled = await post('settle', { reservationId: 'res_1', providerCostMicroUsd: creditAmount(25), allowanceDebitMicroUsd: creditAmount(25) });
    expect(settled.status).toBe(200);
    expect(settled.data).toMatchObject({ reservationId: 'res_1', state: 'settled', debitMicroUsd: creditAmount(25) });
    expect(await cloudBalance()).toMatchObject({ heldMicroUsd: 0, settledMicroUsd: creditAmount(25), availableMicroUsd: creditAmount(75) });
    expect(local()).toMatchObject({ pendingMicroUsd: 0, settledMicroUsd: 0 });
  });

  test('a retry of the same reservation holds once', async () => {
    await buy(100);
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    expect((await post('admit', ask())).status).toBe(200);
    expect((await post('admit', ask())).status).toBe(200);
    expect(cloudHolds()).toHaveLength(1);
    expect((await cloudBalance()).heldMicroUsd).toBe(creditAmount(40));
  });

  test('a subscriber with nothing bought is refused, even though the month is funded, and nothing is held', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    const answer = await post('admit', ask());
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('no_purchased_usage');
    expect(answer.data.error).toMatch(/can’t be reserved\.$/);
    expect(answer.data.error).not.toMatch(/[–—]/);
    expect(cloudHolds()).toEqual([]);
    expect(local()).toMatchObject({ pendingMicroUsd: 0 });
  });

  test('a subscriber is refused what the bought balance cannot cover', async () => {
    await buy(30);
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    const answer = await post('admit', ask({ maxMicroUsd: creditAmount(40) }));
    expect(answer.status).toBe(409);
    expect(answer.data.code).toBe('insufficient_purchased_usage');
    expect(answer.data.error).toMatch(/free to hold\.$/);
    expect(cloudHolds()).toEqual([]);
    expect(local().pendingMicroUsd).toBe(0);
  });

  test('flags in the body are only words: they cannot make a person staff, widen the balance or skip the check', async () => {
    await buy(30);
    await mount(await signedIn(DEMO_ACCOUNTS.employee.email));
    const forged = { staff: true, staffRole: 'admin', role: 'admin', directReservation: false, paid: true, purchasedMicroUsd: creditAmount(10_000), balanceMicroUsd: creditAmount(10_000), personId: 'person_someone_else', organizationId: 'org_other', tenantId: 'tenant_other' };
    const answer = await post('admit', ask({ maxMicroUsd: creditAmount(40), ...forged }));
    expect(answer.status).toBe(409);
    expect(answer.data.code).toBe('insufficient_purchased_usage');
    expect(cloudHolds()).toEqual([]);
    expect(local().pendingMicroUsd).toBe(0);
    // The hold the service makes is the signed-in person's, whatever the body names.
    const fine = await post('admit', ask({ maxMicroUsd: creditAmount(10), ...forged }));
    expect(fine.status).toBe(200);
    expect(cloudHolds()).toHaveLength(1);
    expect(cloudHolds()[0].personId).not.toBe('person_someone_else');
    expect(cloudHolds()[0].organizationId).toBe(ORG);
  });

  test('staff keep the local path, and the service is never asked to hold anything for them', async () => {
    await buy(100);
    await mount(await signedIn(DEMO_ACCOUNTS.staffSupport.email));
    const held = await post('admit', ask({ maxMicroUsd: dollars(1) }));
    expect(held.status).toBe(200);
    expect(local().pendingMicroUsd).toBe(dollars(1));
    expect(cloudHolds()).toEqual([]);
    const settled = await post('settle', { reservationId: 'res_1', providerCostMicroUsd: dollars(0.4), allowanceDebitMicroUsd: dollars(0.4) });
    expect(settled.status).toBe(200);
    expect(local()).toMatchObject({ pendingMicroUsd: 0, settledMicroUsd: dollars(0.4) });
    expect(holdCalls()).toEqual([]);
  });

  test('a subscriber cannot settle a hold on the local, included month', async () => {
    await buy(100);
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    // A hold on the included month, made in-process (staff would have made it through the route).
    await ledger.reserve({ reservationId: 'local_hold', organizationId: ORG, periodId: PERIOD, parentTaskId: null, kind: 'generation', route: 'codex', payer: 'managed', maxMicroUsd: dollars(1), rateCardVersion: 'rate-card-2026-09-10.1', parentEnvelopeMicroUsd: null, at: AT });
    const answer = await post('settle', { reservationId: 'local_hold', providerCostMicroUsd: 1, allowanceDebitMicroUsd: 1 });
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_settle_refused');
    expect(local()).toMatchObject({ pendingMicroUsd: dollars(1), settledMicroUsd: 0 });
  });

  test('another member cannot settle a subscriber’s hold, and a hold is never settled past what was held', async () => {
    await buy(100);
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    await post('admit', ask());
    const over = await post('settle', { reservationId: 'res_1', providerCostMicroUsd: creditAmount(41), allowanceDebitMicroUsd: creditAmount(41) });
    expect(over.status).toBe(409);
    expect(over.data.code).toBe('settlement_exceeds_hold');
    expect((await cloudBalance()).heldMicroUsd).toBe(creditAmount(40));
    await unmount();
    await mount(await signedIn(DEMO_ACCOUNTS.employee.email));
    const stranger = await post('settle', { reservationId: 'res_1', providerCostMicroUsd: 1, allowanceDebitMicroUsd: 1 });
    expect(stranger.status).toBe(403);
    expect(stranger.data.code).toBe('direct_settle_refused');
    expect((await cloudBalance()).heldMicroUsd).toBe(creditAmount(40));
  });

  test('an identifier or amount the service does not accept holds nothing and says so', async () => {
    await buy(100);
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    for (const bad of [{ reservationId: 'has a space' }, { maxMicroUsd: 0 }]) {
      const answer = await post('admit', ask(bad));
      expect(answer.status, JSON.stringify(bad)).toBe(400);
      expect(answer.data.code).toBe('purchased_hold_invalid');
      expect(answer.data.error).toMatch(/can’t be held as asked\.$/);
    }
    expect(cloudHolds()).toEqual([]);
  });

  test('when the account service cannot be reached, nothing is held and the refusal says so', async () => {
    await buy(100);
    const session = await signedIn(DEMO_ACCOUNTS.owner.email);
    await mount(session);
    intercept = (request) => (pathOf(request).includes('/purchased-usage/') ? Promise.reject(new Error('offline')) : null);
    const answer = await post('admit', ask());
    expect(answer.status).toBe(503);
    expect(answer.data.error).toMatch(/bought usage can’t be held\.$/);
    expect(cloudHolds()).toEqual([]);
    expect(local().pendingMicroUsd).toBe(0);
    const settle = await post('settle', { reservationId: 'res_1', providerCostMicroUsd: 1, allowanceDebitMicroUsd: 1 });
    expect(settle.status).toBe(503);
  });

  test('with no account service wired in, as on an install without accounts, a subscriber is refused as before', async () => {
    await buy(100);
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email), { purchased: false });
    const answer = await post('admit', ask());
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('direct_reservation_refused');
    expect(cloudHolds()).toEqual([]);
  });

  describe('the lease on a bought-usage hold', () => {
    const AT_FIXED = '2026-10-01T12:00:00.000Z';
    const minutesAfter = (minutes: number) => new Date(Date.parse(AT_FIXED) + minutes * 60_000).toISOString();

    /** A service that holds whatever it is asked for, with the lease it is told to give. */
    const leasing = (leaseUntil: string): PurchasedUsage => ({
      personId: () => 'person_stub',
      purchasedBalance: async () => ({ purchasedMicroUsd: creditAmount(100), heldMicroUsd: 0, settledMicroUsd: 0, availableMicroUsd: creditAmount(100) }),
      holdPurchased: async (_organizationId, input) => ({
        holdId: input.holdId, state: 'held', amountMicroUsd: input.amountMicroUsd, debitMicroUsd: 0, createdAt: AT_FIXED, resolvedAt: null, leaseUntil,
        balance: { purchasedMicroUsd: creditAmount(100), heldMicroUsd: input.amountMicroUsd, settledMicroUsd: 0, availableMicroUsd: creditAmount(100) - input.amountMicroUsd },
      }),
      settlePurchased: async () => { throw new Error('not used'); },
      renewPurchased: async () => { throw new Error('not used'); },
    });
    const admitWith = async (leaseUntil: string) => {
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
      const gateway = new ManagedGateway({
        ledger, entitlementFor: () => paid, tenantFor: () => 'tenant_ignored', memberOf: () => true,
        billingStatusFor: async () => ({ suspended: false, suspendedReason: null }),
        jobCapFor: () => approvedJobCap('thorough'), policyFor: () => ({ processing: 'may-leave', organizationRoute: 'managed' }),
        purchased: leasing(leaseUntil),
      });
      return gateway.admit({
        organizationId: ORG, personId: 'person_stub', route: 'codex', kind: 'generation', parentTaskId: null, maxMicroUsd: creditAmount(40),
        requestDigest: 'digest-one', reservationId: 'res_lease', periodId: '2026-10', at: AT_FIXED, directReservation: true, staffRole: null,
      });
    };

    test('the authorization ends at the usual ten minutes when the lease runs longer', async () => {
      const admission = await admitWith(minutesAfter(30));
      expect(admission).toMatchObject({ admitted: true, authorization: { expiresAt: minutesAfter(10) } });
    });

    test('the authorization ends with the lease when the lease ends sooner', async () => {
      const admission = await admitWith(minutesAfter(4));
      expect(admission).toMatchObject({ admitted: true, authorization: { expiresAt: minutesAfter(4) } });
    });

    test('a lease this app cannot read is not taken as a hold', async () => {
      const admission = await admitWith('soon');
      expect(admission).toMatchObject({ admitted: false, code: 'purchased_hold_unavailable' });
      expect((admission as { message: string }).message).toMatch(/can’t be held right now\.$/);
    });

    test('a real hold through the route carries a lease from the service, and the authorization never outlasts it', async () => {
      await buy(100);
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
      const held = await post('admit', ask());
      expect(held.status).toBe(200);
      const lease = cloudHolds()[0].leaseUntil;
      expect(Date.parse(lease)).toBeGreaterThan(Date.now());
      expect(Date.parse(held.data.authorization.expiresAt)).toBeLessThanOrEqual(Date.parse(lease));
    });

    describe('renewing it', () => {
      test('a subscriber renews the hold they made, and the service moves the lease', async () => {
        await buy(100);
        await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
        await post('admit', ask());
        const first = cloudHolds()[0].leaseUntil;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const answer = await post('renew', { reservationId: 'res_1' });
        expect(answer.status).toBe(200);
        expect(answer.data).toMatchObject({ reservationId: 'res_1', organizationId: ORG, source: 'purchased', state: 'held' });
        expect(Date.parse(answer.data.leaseUntil)).toBeGreaterThan(Date.parse(first));
        expect(cloudHolds()[0].leaseUntil).toBe(answer.data.leaseUntil);
        expect(answer.data.balance).toMatchObject({ heldMicroUsd: creditAmount(40) });
        expect(holdCalls()).toContain('POST ' + `/account/organizations/${ORG}/purchased-usage/renewals`);
        expect(local()).toMatchObject({ pendingMicroUsd: 0, settledMicroUsd: 0 });
      });

      test('staff hold on this computer and do not lease, so there is nothing to renew, and the service is not asked', async () => {
        await buy(100);
        await mount(await signedIn(DEMO_ACCOUNTS.staffSupport.email));
        await post('admit', ask({ maxMicroUsd: dollars(1) }));
        const answer = await post('renew', { reservationId: 'res_1' });
        expect(answer.status).toBe(409);
        expect(answer.data.error).toMatch(/nothing to renew\.$/);
        expect(answer.data.error).not.toMatch(/[–—]/);
        expect(holdCalls()).toEqual([]);
        expect(local()).toMatchObject({ pendingMicroUsd: dollars(1) });
      });

      test('a hold that is no longer held is refused in the service’s words, and nothing is changed', async () => {
        await buy(100);
        await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
        await post('admit', ask());
        const { organization } = await cloud.accounts.membership(await tokenFor(DEMO_ACCOUNTS.owner.email), ORG);
        const person = cloudHolds()[0].personId;
        await cloud.funding.releasePurchased({ tenantId: organization.tenantId, organizationId: ORG, holdId: 'res_1', personId: person });
        const answer = await post('renew', { reservationId: 'res_1' });
        expect(answer.status).toBe(409);
        expect(answer.data.code).toBe('hold_not_held');
        expect(answer.data.error).toMatch(/can’t be renewed\.$/);
      });

      test('another member cannot renew a subscriber’s hold, and cannot tell it exists', async () => {
        await buy(100);
        await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
        await post('admit', ask());
        const before = cloudHolds()[0].leaseUntil;
        await unmount();
        await mount(await signedIn(DEMO_ACCOUNTS.employee.email));
        const stranger = await post('renew', { reservationId: 'res_1' });
        const missing = await post('renew', { reservationId: 'res_nope' });
        expect(stranger.status).toBe(403);
        expect(stranger.data.code).toBe('direct_renew_refused');
        expect(stranger.data.error).toMatch(/didn’t make\.$/);
        expect({ status: missing.status, code: missing.data.code, error: missing.data.error }).toEqual({ status: stranger.status, code: stranger.data.code, error: stranger.data.error });
        expect(cloudHolds()[0].leaseUntil).toBe(before);
      });

      test('signed out, a renewal is a 401 and nothing reaches the service', async () => {
        const backend: AccountBackend = {
          client: new ControlPlaneClient('http://faux.local', (request) => { calls.push(`${request.method} ${pathOf(request)}`); return cloud.handle(request); }),
          view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
          close: async () => {},
        };
        const session = new AccountSessionService(backend, dir, null);
        await session.init();
        await mount(session);
        const answer = await post('renew', { reservationId: 'res_1' });
        expect(answer.status).toBe(401);
        expect(holdCalls()).toEqual([]);
      });

      test('when the account service cannot be reached, it says so and nothing is changed', async () => {
        await buy(100);
        await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
        await post('admit', ask());
        const before = cloudHolds()[0].leaseUntil;
        intercept = (request) => (pathOf(request).includes('/purchased-usage/') ? Promise.reject(new Error('offline')) : null);
        const answer = await post('renew', { reservationId: 'res_1' });
        expect(answer.status).toBe(503);
        expect(answer.data.error).toMatch(/wasn’t renewed\.$/);
        expect(cloudHolds()[0].leaseUntil).toBe(before);
      });

      test('with no account service wired in, nobody renews anything', async () => {
        await buy(100);
        await mount(await signedIn(DEMO_ACCOUNTS.owner.email), { purchased: false });
        const answer = await post('renew', { reservationId: 'res_1' });
        expect(answer.status).toBe(403);
        expect(answer.data.code).toBe('direct_renew_refused');
        expect(holdCalls()).toEqual([]);
      });

      test('an outsider reads as absent before anything, and the body is only the hold’s name', async () => {
        await buy(100);
        await mount(await signedIn(DEMO_ACCOUNTS.owner.email), { assertMine: () => { throw new ApiError(404, 'Not found.'); } });
        expect((await post('renew', { reservationId: 'res_1' })).status).toBe(404);
        expect(holdCalls()).toEqual([]);
        await unmount();
        await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
        expect((await post('renew', {})).status).toBe(400);
        expect(holdCalls()).toEqual([]);
      });
    });
  });

  describe('the bought balance, as the account service reports it', () => {
    const read = async () => {
      const response = await fetch(`${url}/api/workspace/organizations/${ORG}/allowance/purchased`);
      return { status: response.status, data: (await response.json()) as any };
    };

    test('shows what was bought, held, spent and still free, to an owner or admin', async () => {
      await buy(100);
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
      expect((await read()).data).toEqual({ state: 'ready', organizationId: ORG, balance: { purchasedMicroUsd: creditAmount(100), heldMicroUsd: 0, settledMicroUsd: 0, availableMicroUsd: creditAmount(100) } });
      await post('admit', ask());
      expect((await read()).data.balance).toMatchObject({ heldMicroUsd: creditAmount(40), availableMicroUsd: creditAmount(60) });
    });

    test('a person the host refuses gets that refusal, and the account service is never asked', async () => {
      await buy(100);
      await mount(await signedIn(DEMO_ACCOUNTS.employee.email), {
        assertCanSeePurchasedUsage: () => {
          throw new ApiError(403, 'Only an owner or an admin can see the credits this business bought.', { code: 'not_owner_or_admin' });
        },
      });
      const before = calls.length;
      const answer = await read();
      expect(answer.status).toBe(403);
      expect(answer.data.code).toBe('not_owner_or_admin');
      expect(calls.slice(before).filter((call) => call.includes('/purchased-usage'))).toEqual([]);
    });

    test('shows no numbers at all when there is no account service or it cannot answer', async () => {
      await buy(100);
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email), { purchased: false });
      expect((await read()).data).toMatchObject({ state: 'not-connected' });
      await unmount();
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
      intercept = (request) => (pathOf(request).includes('/purchased-usage') ? Promise.reject(new Error('offline')) : null);
      const down = (await read()).data;
      expect(down).toMatchObject({ state: 'unavailable' });
      expect(JSON.stringify(down)).not.toMatch(/MicroUsd/);
    });

    test('a service answer this app cannot read is not shown as numbers', async () => {
      await buy(100);
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
      intercept = (request) => (pathOf(request).includes('/purchased-usage')
        ? Promise.resolve(Response.json({ purchasedMicroUsd: 'lots' }))
        : null);
      expect((await read()).data).toMatchObject({ state: 'unavailable' });
      // A hold answered with a different amount than was asked is not taken as held either.
      intercept = (request) => (pathOf(request).endsWith('/purchased-usage/holds')
        ? Promise.resolve(Response.json({ holdId: 'res_1', state: 'held', amountMicroUsd: 1, debitMicroUsd: 0, createdAt: AT, resolvedAt: null, leaseUntil: AT, balance: { purchasedMicroUsd: 1, heldMicroUsd: 1, settledMicroUsd: 0, availableMicroUsd: 0 } }))
        : null);
      const answer = await post('admit', ask());
      expect(answer.status).toBe(503);
      expect(answer.data.error).toMatch(/can’t be held right now\.$/);
    });
  });

  describe('every earlier gate answers first, and the service is not asked', () => {
    beforeEach(async () => {
      await buy(100);
    });

    test('an outsider reads as absent (404) before anything', async () => {
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email), { assertMine: () => { throw new ApiError(404, 'Not found.'); } });
      expect((await post('admit', ask())).status).toBe(404);
      expect((await post('settle', { reservationId: 'res_1', providerCostMicroUsd: 1, allowanceDebitMicroUsd: 1 })).status).toBe(404);
      expect(holdCalls()).toEqual([]);
    });

    test('a business that keeps its work on its own computers, asked for a remote route', async () => {
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email), { policy: { processing: 'local-only', organizationRoute: 'managed' } });
      const answer = await post('admit', ask());
      expect(answer.data).toMatchObject({ admitted: false, code: 'data_route_refused' });
      expect(holdCalls()).toEqual([]);
    });

    test('no entitlement', async () => {
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email), { entitlement: NO_ENTITLEMENT_VIEW });
      const answer = await post('admit', ask());
      expect(answer.data).toMatchObject({ admitted: false, code: 'no_entitlement' });
      expect(holdCalls()).toEqual([]);
    });

    test('a call that could cost more than one job is capped at', async () => {
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email), { jobCap: 10 });
      const answer = await post('admit', ask({ maxMicroUsd: creditAmount(40) }));
      expect(answer.data).toMatchObject({ admitted: false, code: 'job_cap_reached' });
      expect(holdCalls()).toEqual([]);
    });

    test('someone who is not an active member of the business', async () => {
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email), { member: false });
      const answer = await post('admit', ask());
      expect(answer.data).toMatchObject({ admitted: false, code: 'not_a_member' });
      expect(holdCalls()).toEqual([]);
    });
  });
});
