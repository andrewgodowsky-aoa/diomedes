/**
 * Buying credits from the desktop (Andrew, 2026-10-01, DIO-161 slice 1).
 *
 * The three allowance routes a screen builds on: quote an amount, start a purchase, read a purchase.
 * Only an owner or an admin buys. The server never opens anything: it answers the payment page, and
 * only Stripe's own page (or the test service's own, in the test service) is ever answered. The
 * session is a real AccountSessionService over the faux cloud in this process, so what these routes
 * parse is what the service really sends. Every person and figure is one of the faux seed's invented
 * demo accounts.
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
import { WorkspaceService } from '../server/workspaces.js';
import { approvedJobCap, creditAmount } from '../shared/managed-usage.js';
import { isAllowedCheckoutUrl, isAskableCredits } from '../shared/credit-purchases.js';
import { SIGN_IN_REQUIRED } from '../shared/accounts.js';
import { NO_ENTITLEMENT_VIEW } from '../shared/workspaces.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';

const paid = { ...NO_ENTITLEMENT_VIEW, managedInference: true };

type Role = 'owner' | 'admin' | 'member' | 'outsider';

let cloud: FauxCloud;
let dir: string;
let root = '';
let server: Server | undefined;
let url = '';
let ORG: string;
let calls: string[];
let intercept: ((request: Request) => Promise<Response> | Response | null) | null;
let role: Role;

const pathOf = (request: Request) => new URL(request.url).pathname;

async function signedIn(email: string, kind: 'faux' | 'cloud' = 'faux') {
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (request) => {
      calls.push(`${request.method} ${pathOf(request)}`);
      return Promise.resolve(intercept?.(request) ?? null).then((answer) => answer ?? cloud.handle(request));
    }),
    view: () => ({ kind, label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  const session = new AccountSessionService(backend, dir, null);
  await session.init();
  await session.signIn({ email, password: FAUX_DEMO_PASSWORD, remember: false });
  return session;
}

async function mount(session: AccountSessionService | null, options: { credits?: AccountSessionService | null } = {}) {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'credit-purchases-'));
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
  // Only what the routes read of the workspace service. A stranger reads as absent, as in the host; the owner-or-admin rule is the host's own.
  const workspaces = {
    assertMine: () => {
      if (role === 'outsider') throw new ApiError(404, 'That business was not found.', { code: 'organization_not_found' });
    },
    assertCanBuyCredits: (organizationId: string) =>
      (WorkspaceService.prototype as unknown as { assertCanBuyCredits(this: unknown, id: string): void }).assertCanBuyCredits.call(
        { mine: () => ({ membership: { role: role === 'outsider' ? 'member' : role, state: 'active' } }) }, organizationId),
    assertCanSeePurchasedUsage: () => {},
    currentPerson: () => ({ id: session?.personId() ?? 'nobody' }),
    entitlementOf: () => paid,
  } as unknown as WorkspaceService;
  const app = express();
  app.use(express.json());
  mountManagedUsageRoutes(app, store, ledger, gateway, billing, workspaces, session, session, options.credits === undefined ? session : options.credits);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) res.status(error.status).json({ error: error.message, ...error.details });
    else res.status(500).json({ error: String(error) });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const base = () => `${url}/api/workspace/organizations/${ORG}/allowance/credit-purchases`;
async function get(target: string) {
  const response = await fetch(target);
  return { status: response.status, data: (await response.json()) as any };
}
async function post(body: unknown) {
  const response = await fetch(base(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: (await response.json()) as any };
}
const cloudCalls = () => calls.filter((call) => call.includes('/credit-purchases'));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-credit-purchases-'));
  calls = [];
  intercept = null;
  role = 'owner';
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

describe('the quote', () => {
  // Juniper Street Bakery holds a plan in the faux seed, so it buys at the faux plan rate: $10.00 for 110 credits a step.
  test('answers what an amount of credits costs and the step it is bought in, and nothing else', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    const answer = await get(`${base()}/quote?credits=1100`);
    expect(answer).toEqual({ status: 200, data: { credits: 1100, amountCents: 10000, currency: 'usd', steps: 10, stepCredits: 110, stepCents: 1000, onPlan: true, planStep: null } });
    expect(cloudCalls()).toEqual([`GET /account/organizations/${ORG}/credit-purchases/quote`]);
    expect(JSON.stringify(answer.data)).not.toMatch(/mark-?up|percent|rate|price/i);
  });

  test('with no amount, quotes one step: how the screen learns the step before it asks for more', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    expect(await get(`${base()}/quote`)).toEqual({ status: 200, data: { credits: 110, amountCents: 1000, currency: 'usd', steps: 1, stepCredits: 110, stepCents: 1000, onPlan: true, planStep: null } });
  });

  test('refuses an amount that is not a whole number inside the cap before asking the service', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    for (const credits of ['0', '-100', '1.5', 'many', '', '100000000000', '100100', '1e3', '%20100']) {
      const answer = await get(`${base()}/quote?credits=${credits}`);
      expect(answer.status, credits).toBe(422);
      expect(answer.data.code).toBe('invalid_credits');
      expect(answer.data.error).toBe('Enter a whole number of credits, up to 100,000.');
    }
    expect((await get(`${base()}/quote?credits=100&credits=200`)).status).toBe(422);
    expect(cloudCalls()).toEqual([]);
  });

  test('leaves whether an amount is a whole number of steps to the service, which knows the business\'s step', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    for (const credits of ['100', '150', '1000']) {
      const answer = await get(`${base()}/quote?credits=${credits}`);
      expect(answer.status, credits).toBe(422);
      expect(answer.data.error).toBe('Credits are bought in steps of 110, from 110 up to 99,990.');
    }
    expect(cloudCalls()).toHaveLength(3);
  });

  test('is for an owner or an admin: a member is refused here and the service is never asked', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.employee.email));
    role = 'member';
    const answer = await get(`${base()}/quote?credits=100`);
    expect(answer.status).toBe(403);
    expect(answer.data).toEqual({ error: 'Only an owner or an admin can buy credits for this business.', code: 'not_owner_or_admin' });
    expect(cloudCalls()).toEqual([]);
    // The service is the authority on the role: an admin there is let through here as well.
    role = 'admin';
    await mount(await signedIn(DEMO_ACCOUNTS.manager.email));
    expect((await get(`${base()}/quote?credits=110`)).status).toBe(200);
  });

  test('reads a stranger as absent, as every other route here does', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    role = 'outsider';
    const answer = await get(`${base()}/quote?credits=100`);
    expect(answer.status).toBe(404);
    expect(cloudCalls()).toEqual([]);
  });

  test('passes on the service’s own refusal when the person is a member there, whatever this app believed', async () => {
    // A stale local role: this app lets the request through, the service is the authority and says no.
    await mount(await signedIn(DEMO_ACCOUNTS.employee.email));
    role = 'owner';
    const answer = await get(`${base()}/quote?credits=100`);
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('not_owner_or_admin');
    expect(answer.data.error).toMatch(/Only a Business owner or a Manager can buy credits/);
  });
});

describe('starting a purchase', () => {
  test('answers the payment page and what it is for, and opens nothing itself', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    const answer = await post({ credits: 550 });
    expect(answer.status).toBe(201);
    expect(Object.keys(answer.data).sort()).toEqual(['amountCents', 'checkoutUrl', 'credits', 'purchaseId']);
    expect(answer.data).toMatchObject({ credits: 550, amountCents: 5000 });
    expect(answer.data.checkoutUrl).toMatch(/^http:\/\/faux\.local\/faux\/checkout\/cs_faux_[a-z0-9]{24}$/);
    expect(cloudCalls()).toEqual([`POST /account/organizations/${ORG}/credit-purchases`]);
  });

  test('takes the credits and nothing else: no amount, price or business from the body', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    for (const body of [{ credits: 100, amountCents: 1 }, { credits: 100, organizationId: 'org_other' }, { credits: 100, checkoutUrl: 'https://evil.example/' }, []]) {
      const answer = await post(body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.data.code).toBe('invalid_request');
    }
    for (const credits of ['110', 0, 100100, 1.5, null, undefined]) {
      const answer = await post({ credits });
      expect(answer.status, String(credits)).toBe(422);
      expect(answer.data.code).toBe('invalid_credits');
    }
    expect(cloudCalls()).toEqual([]);
  });

  test('is for an owner or an admin: a member starts nothing', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.employee.email));
    role = 'member';
    const answer = await post({ credits: 100 });
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('not_owner_or_admin');
    expect(cloudCalls()).toEqual([]);
    expect(cloud.store.snapshot().funding.creditPurchases).toEqual([]);
  });

  test('an admin starts one too', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.manager.email));
    role = 'admin';
    const answer = await post({ credits: 110 });
    expect(answer.status).toBe(201);
    expect(cloud.store.snapshot().funding.creditPurchases).toHaveLength(1);
  });

  test('refuses a payment page that is not Stripe’s, and never passes the link on', async () => {
    for (const checkoutUrl of ['https://evil.example/c/pay/cs_test_1', 'http://checkout.stripe.com/c/pay/cs_test_1', 'https://checkout.stripe.com.evil.example/',
      'https://checkout.stripe.com@evil.example/', 'javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'diomedes-auth://callback', '/faux/checkout/cs_faux_aaaaaaaaaaaaaaaaaaaaaaaa']) {
      intercept = (request) => request.method === 'POST' && pathOf(request).endsWith('/credit-purchases')
        ? Response.json({ purchaseId: 'cpurch_1', checkoutUrl, credits: 100, amountCents: 1200 }) : null;
      await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
      const answer = await post({ credits: 100 });
      expect(answer.status, checkoutUrl).toBe(502);
      expect(answer.data.code).toBe('checkout_url_refused');
      expect(JSON.stringify(answer.data)).not.toContain('evil');
      expect(JSON.stringify(answer.data)).not.toContain(checkoutUrl);
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  test('allows Stripe’s own page, and the test service’s page only when the service is the test one', async () => {
    const stripe = 'https://checkout.stripe.com/c/pay/cs_test_a1B2#fragment';
    intercept = (request) => request.method === 'POST' && pathOf(request).endsWith('/credit-purchases')
      ? Response.json({ purchaseId: 'cpurch_1', checkoutUrl: stripe, credits: 110, amountCents: 1000 }) : null;
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email, 'cloud'));
    const answer = await post({ credits: 110 });
    expect(answer.status).toBe(201);
    expect(answer.data.checkoutUrl).toBe(stripe);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    // The same local page, from a deployed service that is not the test one: refused.
    intercept = null;
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email, 'cloud'));
    const local = await post({ credits: 110 });
    expect(local.status).toBe(502);
    expect(local.data.code).toBe('checkout_url_refused');
  });

  test('the allow rule, on its own', () => {
    const faux = 'http://faux.local';
    const page = `${faux}/faux/checkout/cs_faux_${'a'.repeat(24)}`;
    expect(isAllowedCheckoutUrl('https://checkout.stripe.com/c/pay/cs_live_x', null)).toBe(true);
    expect(isAllowedCheckoutUrl(page, faux)).toBe(true);
    expect(isAllowedCheckoutUrl(page, null)).toBe(false);
    expect(isAllowedCheckoutUrl(page, 'http://127.0.0.1:1')).toBe(false);
    expect(isAllowedCheckoutUrl(`${faux}/anywhere`, faux)).toBe(false);
    expect(isAllowedCheckoutUrl(`${faux}/faux/checkout/cs_faux_short`, faux)).toBe(false);
    for (const bad of [undefined, null, 5, '', 'not a url', 'https://checkout.stripe.com:8443/', 'https://user:pw@checkout.stripe.com/', 'https://Checkout.Stripe.com.evil.example/', `https://checkout.stripe.com/${'x'.repeat(5000)}`])
      expect(isAllowedCheckoutUrl(bad, faux), String(bad)).toBe(false);
    // Askable is a whole number inside the cap; whether it is a whole number of the business's steps is the service's to say.
    for (const good of [1, 100, 110, 150, 100_000]) expect(isAskableCredits(good), String(good)).toBe(true);
    for (const bad of [0, 100_100, -100, 1.5, '100', null, undefined, Number.NaN, Infinity, 2 ** 53]) expect(isAskableCredits(bad), String(bad)).toBe(false);
  });
});

describe('reading a purchase', () => {
  test('follows it from pending to paid, and the credits show up in what the business bought', async () => {
    const session = await signedIn(DEMO_ACCOUNTS.owner.email);
    await mount(session);
    const started = await post({ credits: 1100 });
    expect(started.status).toBe(201);
    const { purchaseId, checkoutUrl } = started.data;
    expect(await get(`${base()}/${purchaseId}`)).toEqual({ status: 200, data: { purchaseId, credits: 1100, amountCents: 10000, state: 'pending' } });
    const before = await get(`${url}/api/workspace/organizations/${ORG}/allowance/purchased`);
    const sessionId = new URL(checkoutUrl).pathname.split('/').pop()!;
    expect(await cloud.completeCheckout(sessionId)).toEqual({ purchaseId, status: 200 });
    expect(await get(`${base()}/${purchaseId}`)).toEqual({ status: 200, data: { purchaseId, credits: 1100, amountCents: 10000, state: 'paid' } });
    const after = await get(`${url}/api/workspace/organizations/${ORG}/allowance/purchased`);
    expect(after.data.balance.purchasedMicroUsd - before.data.balance.purchasedMicroUsd).toBe(creditAmount(1100));
  });

  test('an unknown purchase, and one named with characters no id has, are not found', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    const unknown = await get(`${base()}/cpurch_nothing`);
    expect(unknown.status).toBe(404);
    expect(unknown.data.error).toBe('That purchase was not found for this business.');
    for (const id of ['%2e%2e', 'a%2fb', 'a%20b', '-start', `x${'a'.repeat(200)}`]) {
      const answer = await get(`${base()}/${id}`);
      expect(answer.status, id).toBe(404);
    }
    expect(cloudCalls()).toEqual([`GET /account/organizations/${ORG}/credit-purchases/cpurch_nothing`]);
  });

  test('is for an owner or an admin', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.employee.email));
    role = 'member';
    const answer = await get(`${base()}/cpurch_any`);
    expect(answer.status).toBe(403);
    expect(answer.data.code).toBe('not_owner_or_admin');
    expect(cloudCalls()).toEqual([]);
  });
});

describe('when the account service can’t be asked', () => {
  test('signed out is a 401 on every route, and nothing is sent', async () => {
    const session = await signedIn(DEMO_ACCOUNTS.owner.email);
    await session.signOut();
    calls = [];
    await mount(session);
    for (const answer of [await get(`${base()}/quote?credits=100`), await post({ credits: 100 }), await get(`${base()}/cpurch_1`)]) {
      expect(answer.status).toBe(401);
      expect(answer.data).toEqual({ error: 'Sign in to use Nectovia.', code: SIGN_IN_REQUIRED });
    }
    expect(cloudCalls()).toEqual([]);
  });

  test('an install with no account service at all is a 401 too, in the same words', async () => {
    await mount(null, { credits: null });
    for (const answer of [await get(`${base()}/quote?credits=100`), await post({ credits: 100 }), await get(`${base()}/cpurch_1`)])
      expect(answer).toEqual({ status: 401, data: { error: 'Sign in to use Nectovia.', code: SIGN_IN_REQUIRED } });
  });

  test('a service that can’t be reached is a 503 with a plain reason', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    intercept = () => { throw new TypeError('connect ECONNREFUSED'); };
    for (const answer of [await get(`${base()}/quote?credits=100`), await post({ credits: 100 }), await get(`${base()}/cpurch_1`)]) {
      expect(answer.status).toBe(503);
      expect(answer.data.code).toBe('unreachable');
      expect(answer.data.error).toBe('The account service could not be reached. Check the connection and try again.');
    }
  });

  test('a rate that isn’t set up is the service’s own 503, passed on', async () => {
    cloud = await createFauxCloud({ file: null, passwordIterations: 1_000, billing: { creditRatePlan: null } });
    ORG = (await seedDemo(cloud)).organizations!.juniper;
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    const answer = await get(`${base()}/quote?credits=100`);
    expect(answer.status).toBe(503);
    expect(answer.data.error).toBe('Buying credits isn\'t available right now. Try again later.');
  });

  test('an answer this app can’t read is a 502, and shows nothing of it', async () => {
    await mount(await signedIn(DEMO_ACCOUNTS.owner.email));
    intercept = () => Response.json({ credits: 100, amountCents: '1200', currency: 'usd', extra: true });
    const answer = await get(`${base()}/quote?credits=100`);
    expect(answer.status).toBe(502);
    expect(answer.data.code).toBe('unreadable_answer');
    intercept = () => Response.json({ purchaseId: 'cpurch_1', credits: 100, amountCents: 1200, state: 'refunded' });
    expect((await get(`${base()}/cpurch_1`)).status).toBe(502);
  });
});

describe('what a customer reads', () => {
  test('keeps every sentence plain: no dashes, no exclamation marks, no markup, no vendor, no reassurance tail', async () => {
    const owner = await signedIn(DEMO_ACCOUNTS.owner.email);
    await mount(owner);
    const messages: string[] = [];
    const note = (answer: { data: { error?: string } }) => { if (answer.data.error) messages.push(answer.data.error); };
    note(await get(`${base()}/quote?credits=150`));
    note(await post({ credits: 150 }));
    note(await post({ extra: 1 }));
    note(await get(`${base()}/cpurch_nothing`));
    role = 'member';
    note(await get(`${base()}/quote?credits=100`));
    role = 'owner';
    intercept = () => { throw new TypeError('down'); };
    note(await get(`${base()}/quote?credits=100`));
    intercept = (request) => request.method === 'POST' ? Response.json({ purchaseId: 'p', checkoutUrl: 'https://evil.example/', credits: 100, amountCents: 1200 }) : null;
    note(await post({ credits: 100 }));
    intercept = () => Response.json({});
    note(await get(`${base()}/quote?credits=100`));
    await owner.signOut();
    note(await get(`${base()}/quote?credits=100`));
    expect(messages.length).toBeGreaterThanOrEqual(8);
    for (const message of messages) {
      expect(message, message).not.toMatch(/[\u2013\u2014!]|--/);
      expect(message, message).not.toMatch(/mark-?up|percent|%|stripe|bedrock|openrouter|luna|claude|gpt/i);
      expect(message, message).not.toMatch(/Nothing was (charged|sent|held|changed)\.\s*$/);
    }
  });
});

describe('the owner-or-admin rule', () => {
  const ask = (membership: unknown) =>
    () => (WorkspaceService.prototype as unknown as { assertCanBuyCredits(this: unknown, id: string): void }).assertCanBuyCredits.call({ mine: () => ({ membership }) }, 'org_a');

  test('lets an active owner and an active admin through, and nobody else', () => {
    expect(ask({ role: 'owner', state: 'active' })).not.toThrow();
    expect(ask({ role: 'admin', state: 'active' })).not.toThrow();
    for (const membership of [{ role: 'member', state: 'active' }, { role: 'admin', state: 'revoked' }, { role: 'owner', state: 'invited' }, null, undefined])
      expect(ask(membership), JSON.stringify(membership)).toThrow(/Only an owner or an admin can buy credits for this business\./);
  });
});
