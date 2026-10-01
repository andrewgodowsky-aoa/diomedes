/**
 * The business's included month on the desktop's usage route (DIO-161).
 *
 * The route used to answer "not connected" to everyone, signed in or not, so the Usage screen in
 * Settings never drew a bar. It now reads the account service as the person signed in. The session is a
 * real AccountSessionService over the faux cloud in this process, so what the route parses is what the
 * service really sends. Every person and figure is one of the faux seed's invented demo ones.
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
import { NOT_CONNECTED_REASON, mountManagedUsageRoutes } from '../server/managed-usage-routes.js';
import { ApiError } from '../server/paths.js';
import { Store } from '../server/store.js';
import type { WorkspaceService } from '../server/workspaces.js';
import { RATE_CARD_V1, approvedJobCap, creditAmount, micro, periodIdFor, type AttemptSettlement } from '../shared/managed-usage.js';
import { NO_ENTITLEMENT_VIEW } from '../shared/workspaces.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';

const paid = { ...NO_ENTITLEMENT_VIEW, managedInference: true };
const GRANTED_CREDITS = 1000;
const USED_CREDITS = 250;

let cloud: FauxCloud;
let dir: string;
let root = '';
let server: Server | undefined;
let url = '';
let ORG: string;
let intercept: ((request: Request) => Promise<Response | null> | Response | null) | null;

async function sessionOf(email: string | null) {
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (request) =>
      Promise.resolve(intercept?.(request) ?? null).then((answer) => answer ?? cloud.handle(request))),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  const session = new AccountSessionService(backend, dir, null);
  await session.init();
  if (email) await session.signIn({ email, password: FAUX_DEMO_PASSWORD, remember: false });
  return session;
}

/** This month as a grant of GRANTED_CREDITS with USED_CREDITS of it settled, in the faux store the service reads. */
async function grantTheMonth() {
  const at = new Date().toISOString();
  const periodId = periodIdFor(at);
  const spent = micro(creditAmount(USED_CREDITS));
  await cloud.store.run(async (draft) => {
    const tenantId = draft.accounts.organizations.find((row) => row.record.id === ORG)!.record.tenantId;
    const start = new Date(`${periodId}-01T00:00:00.000Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    draft.funding.periods = draft.funding.periods.filter((row) => !(row.organizationId === ORG && row.periodId === periodId));
    draft.funding.periods.push({
      tenantId, organizationId: ORG, periodId, planId: 'business', rateCardVersion: RATE_CARD_V1.version,
      grantedMicroUsd: creditAmount(GRANTED_CREDITS), startsAt: start.toISOString(), endsAt: end.toISOString(), sourceGrantId: 'organization-usage-route-test', allocatedAt: at,
    });
    draft.funding.settlements.push({
      reservationId: 'organization-usage-route-test', organizationId: ORG, periodId, providerCostMicroUsd: spent, allowanceDebitMicroUsd: spent,
      rateCardVersion: RATE_CARD_V1.version, eligibility: 'included', settledAt: at, reconciledFrom: 'response', tenantId,
      receiptRef: 'receipt_organization_usage_route_test', monthlyDebitMicroUsd: spent, topUpDebitMicroUsd: micro(0), usage: {},
    } as unknown as AttemptSettlement);
  });
}

async function mount(session: AccountSessionService | null) {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'organization-usage-'));
  const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  const ledger = new AllowanceLedger(store);
  await ledger.init();
  const billing = new BillingEventProcessor(ledger, store);
  await billing.init();
  const gateway = new ManagedGateway({
    ledger, entitlementFor: () => paid, tenantFor: () => 'tenant_ignored', memberOf: () => true,
    billingStatusFor: async () => ({ suspended: false, suspendedReason: null }),
    jobCapFor: () => approvedJobCap('thorough'), policyFor: () => ({ processing: 'may-leave', organizationRoute: 'managed' }),
  });
  const workspaces = { assertMine: () => {}, assertCanSeePurchasedUsage: () => {}, currentPerson: () => ({ id: session?.personId() ?? 'nobody' }), entitlementOf: () => paid } as unknown as WorkspaceService;
  const app = express();
  app.use(express.json());
  mountManagedUsageRoutes(app, store, ledger, gateway, billing, workspaces, session, session, session, session);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) res.status(error.status).json({ error: error.message, ...error.details });
    else res.status(500).json({ error: String(error) });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function usage() {
  const response = await fetch(`${url}/api/workspace/organizations/${ORG}/usage`);
  return { status: response.status, data: (await response.json()) as any };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-organization-usage-'));
  intercept = null;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  ORG = (await seedDemo(cloud)).organizations!.juniper;
});
afterEach(async () => {
  intercept = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the usage route, signed in', () => {
  test('answers the account service figures for the month, never the not-connected line', async () => {
    await grantTheMonth();
    await mount(await sessionOf(DEMO_ACCOUNTS.owner.email));
    const answer = await usage();
    expect(answer.status).toBe(200);
    expect(answer.data.state).toBe('ready');
    expect(answer.data.organizationId).toBe(ORG);
    expect(answer.data.projection).toMatchObject({
      organizationId: ORG,
      grantedMicroUsd: creditAmount(GRANTED_CREDITS),
      settledMicroUsd: creditAmount(USED_CREDITS),
      usedPercent: (USED_CREDITS / GRANTED_CREDITS) * 100,
    });
    expect(JSON.stringify(answer.data)).not.toContain(NOT_CONNECTED_REASON);
  });

  test('passes on the service plain unavailable when no grant is recorded for the month, with no figures', async () => {
    await cloud.store.run(async (draft) => {
      draft.funding.periods = draft.funding.periods.filter((row) => row.organizationId !== ORG);
    });
    await mount(await sessionOf(DEMO_ACCOUNTS.owner.email));
    const answer = await usage();
    expect(answer.status).toBe(200);
    expect(answer.data).toMatchObject({ state: 'unavailable', organizationId: ORG });
    expect(answer.data.projection).toBeUndefined();
  });

  test('shows nothing when the service answers for another business', async () => {
    await grantTheMonth();
    intercept = async (request) => {
      if (!new URL(request.url).pathname.endsWith('/usage')) return null;
      const real = await cloud.handle(request);
      const body = (await real.json()) as any;
      body.organizationId = 'org_other';
      if (body.projection) body.projection.organizationId = 'org_other';
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await mount(await sessionOf(DEMO_ACCOUNTS.owner.email));
    const answer = await usage();
    expect(answer.data).toMatchObject({ state: 'unavailable', organizationId: ORG });
    expect(answer.data.projection).toBeUndefined();
  });

  test('says unavailable, without figures, when the service answers in a shape it cannot read', async () => {
    intercept = (request) =>
      new URL(request.url).pathname.endsWith('/usage')
        ? new Response(JSON.stringify({ state: 'ready', organizationId: ORG, projection: { usedPercent: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : null;
    await mount(await sessionOf(DEMO_ACCOUNTS.owner.email));
    const answer = await usage();
    expect(answer.data).toMatchObject({ state: 'unavailable', organizationId: ORG });
    expect(answer.data.projection).toBeUndefined();
  });
});

describe('the usage route, not reading', () => {
  test('says not connected, with no figures, when nobody is signed in', async () => {
    await grantTheMonth();
    await mount(await sessionOf(null));
    const answer = await usage();
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ state: 'not-connected', organizationId: ORG, reason: NOT_CONNECTED_REASON });
  });

  test('says not connected when there is no account service at all', async () => {
    await mount(null);
    expect((await usage()).data).toMatchObject({ state: 'not-connected', organizationId: ORG });
  });
});
