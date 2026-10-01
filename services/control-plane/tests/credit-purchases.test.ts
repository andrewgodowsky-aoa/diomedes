/**
 * Buying credits (Andrew, 2026-10-01, DIO-161 slice 1): an owner or an admin buys more credits for
 * their business through Stripe Checkout, and a verified payment event records the top-up.
 *
 * What these cover: the quote, the strict purchase request, the Checkout Session request the Worker
 * sends (a mocked fetch: nothing here reaches Stripe), the signature rules, and what a paid, repeated,
 * mismatched, unknown or expired event does. Offline memory adapters only.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDIT_MICRO_USD, creditAmount } from '../../../shared/managed-usage.js';
import { createHandler } from '../src/worker.js';
import { FundingService, PurchasedUsageService, UsageService } from '../src/funding.js';
import {
  CREDIT_PURCHASE_MAX_CREDITS,
  CREDIT_PURCHASE_STEP,
  CreditPurchaseService,
  STRIPE_CUSTOMER_TIMEOUT_MS,
  StripeWebhookService,
  type PaymentLedger,
  creditPriceCents,
  readBillingSettings,
  verifyStripeSignature,
} from '../src/credit-purchases.js';
import { createFauxCloud } from '../src/faux/cloud.js';
import { FAUX_STRIPE_SECRET_KEY, fauxStripeFetch } from '../src/faux/stripe.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../src/faux/seed.js';
import { PostgresFundingTransaction } from '../src/funding-postgres.js';
import { memoryPaymentLedger } from '../src/faux/payment-ledger.js';
import type { SqlClient } from '../src/postgres.js';
import { FundingMemoryRepository } from './support/funding-memory.js';
import { now, setup, validEnv } from './support/fixtures.js';

const SECRET = 'whsec_fixture_secret_for_tests';
const KEY = 'sk_test_fixture_key_for_tests';
const env = { ...validEnv, CREDIT_PRICE_CENTS_PER_100: '1200', STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET };
const ORIGIN = 'http://127.0.0.1:8791';
/** The customer a paid event names in these tests, unless one says otherwise. */
const CUSTOMER = 'cus_fixture_1';

afterEach(() => vi.restoreAllMocks());

interface StripeCall { url: string; method: string; headers: Record<string, string>; form: URLSearchParams }

/**
 * `stripe` answers a Checkout Session create and `customer` a Customer create; each default answers as Stripe would. The customers
 * the default makes are one per idempotency key (the first is CUSTOMER), as Stripe's own idempotency makes them.
 */
async function fixture(options: { env?: Record<string, unknown>; stripe?: (call: StripeCall, count: number) => Response | Promise<Response>;
  customer?: (call: StripeCall, count: number) => Response | Promise<Response> } = {}) {
  const { accounts } = setup();
  const organization = await accounts.createOrganization('alice', 'Fernbrook Joinery');
  const bobInvite = await accounts.invite('alice', organization.id, { subject: 'user_bob', role: 'member', ttlMs: 5000 });
  await accounts.acceptInvitation('bob', organization.id, bobInvite.token);
  const carolInvite = await accounts.invite('alice', organization.id, { subject: 'user_carol', role: 'admin', ttlMs: 5000 });
  await accounts.acceptInvitation('carol', organization.id, carolInvite.token);
  const other = await accounts.createOrganization('dave', 'Harbor Bakery');
  const repository = new FundingMemoryRepository();
  const clock = { at: now };
  const funding = new FundingService(repository, { now: () => clock.at });
  /** The Checkout Session create calls, in order. The Customer create calls are `customerCalls`. */
  const calls: StripeCall[] = [];
  const customerCalls: StripeCall[] = [];
  const customersByKey = new Map<string, string>();
  // The Worker login's side: the customer and the stored verified events. A separate store from the funding rows, as the two
  // logins are separate. `hooks.afterRecord` runs once the event is stored and before the purchase is paid.
  const { state: ledgerState, ledger: memoryLedger } = memoryPaymentLedger(() => clock.at);
  const hooks: { afterRecord?: () => void | Promise<void> } = {};
  const ledgerCalls: string[] = [];
  const ledger: PaymentLedger = {
    storedCustomer: (ref) => { ledgerCalls.push('storedCustomer'); return memoryLedger.storedCustomer(ref); },
    ensureCustomer: (ref, make) => { ledgerCalls.push('ensureCustomer'); return memoryLedger.ensureCustomer(ref, make); },
    recordVerifiedPayment: async (input) => {
      ledgerCalls.push('recordVerifiedPayment');
      const result = await memoryLedger.recordVerifiedPayment(input);
      await hooks.afterRecord?.();
      return result;
    },
  };
  const stripeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: StripeCall = { url: String(input), method: init?.method ?? 'GET', headers, form: new URLSearchParams(String(init?.body ?? '')) };
    if (call.url === 'https://api.stripe.com/v1/customers') {
      customerCalls.push(call);
      if (options.customer) return options.customer(call, customerCalls.length);
      const key = call.headers['idempotency-key'] ?? '';
      if (!customersByKey.has(key)) customersByKey.set(key, customersByKey.size === 0 ? CUSTOMER : `cus_fixture_${customersByKey.size + 1}`);
      return Response.json({ id: customersByKey.get(key), object: 'customer' });
    }
    calls.push(call);
    if (options.stripe) return options.stripe(call, calls.length);
    const id = `cs_test_session${calls.length}`;
    return Response.json({ id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}#fragment`, status: 'open' });
  }) as typeof fetch;
  const handler = createHandler(() => accounts, (_config, account) => new UsageService(account, funding), {
    createPurchased: (_config, account) => new PurchasedUsageService(account, funding),
    createCreditPurchases: (_config, account, runtimeEnv) => new CreditPurchaseService(account, funding, {
      settings: readBillingSettings(runtimeEnv), fetch: stripeFetch, now: () => clock.at, ledger,
    }),
    createStripeWebhook: (_config, runtimeEnv) => new StripeWebhookService(funding, { settings: readBillingSettings(runtimeEnv), now: () => clock.at, ledger }),
  });
  const runtime = options.env ?? env;
  const request = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token = 'alice', ...rest } = init;
    const headers: Record<string, string> = { origin: ORIGIN, ...(rest.headers as Record<string, string> | undefined) };
    if (rest.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return handler(new Request(`${ORIGIN}${path}`, { ...rest, headers }), runtime);
  };
  const base = `/account/organizations/${organization.id}/credit-purchases`;
  const quote = (credits: unknown, token = 'alice') => request(`${base}/quote?credits=${credits}`, { token });
  const buy = (body: unknown, token = 'alice') => request(base, { method: 'POST', token, body: JSON.stringify(body) });
  const read = (purchaseId: string, token = 'alice', organizationId = organization.id) =>
    request(`/account/organizations/${organizationId}/credit-purchases/${purchaseId}`, { token });
  const balance = (token = 'alice') => request(`/account/organizations/${organization.id}/purchased-usage`, { token });
  const sign = (body: string, at = clock.at, secret = SECRET) => {
    const seconds = Math.floor(at / 1000);
    return `t=${seconds},v1=${createHmac('sha256', secret).update(`${seconds}.${body}`).digest('hex')}`;
  };
  const webhook = (body: string, header: string | null = sign(body), runtime2: Record<string, unknown> = runtime) =>
    handler(new Request(`${ORIGIN}/billing/stripe/webhook`, {
      method: 'POST', body, headers: { 'content-type': 'application/json', ...(header === null ? {} : { 'stripe-signature': header }) },
    }), runtime2);
  const purchases = () => repository.snapshot().creditPurchases;
  const topUps = () => repository.snapshot().topUps;
  const bought = async (credits = 1000) => {
    const answer = await buy({ credits });
    expect(answer.status).toBe(201);
    const row = purchases().at(-1)!;
    return { answer: await answer.json() as { purchaseId: string; checkoutUrl: string; credits: number; amountCents: number }, row };
  };
  const sessionFor = (row: { purchaseId: string; checkoutSessionId: string | null; amountCents: number }, overrides: Record<string, unknown> = {}) => ({
    id: row.checkoutSessionId, object: 'checkout.session', payment_status: 'paid', status: 'complete', amount_total: row.amountCents, currency: 'usd',
    client_reference_id: row.purchaseId,
    customer: CUSTOMER,
    metadata: { purchase_id: row.purchaseId, organization_id: organization.id, tenant_id: organization.tenantId }, ...overrides,
  });
  const eventBody = (type: string, object: unknown, id = 'evt_paid_1') =>
    JSON.stringify({ id, object: 'event', type, created: Math.floor(clock.at / 1000), data: { object } });
  const minutes = (count: number) => { clock.at += count * 60_000; };
  return { accounts, organization, other, repository, funding, handler, calls, customerCalls, base, request, quote, buy, read, balance, sign, webhook,
    purchases, topUps, bought, sessionFor, eventBody, minutes, clock, ledger, ledgerState, ledgerCalls, hooks };
}

describe('the quote', () => {
  it('prices credits at the setting: 100 is 1200 cents and 1000 is 12000', async () => {
    const { quote } = await fixture();
    expect(await (await quote(100)).json()).toEqual({ credits: 100, amountCents: 1200, currency: 'usd' });
    expect(await (await quote(1000)).json()).toEqual({ credits: 1000, amountCents: 12000, currency: 'usd' });
    expect(await (await quote(2300)).json()).toEqual({ credits: 2300, amountCents: 27600, currency: 'usd' });
  });

  it('follows the setting, so the price never lives in code', async () => {
    const { quote } = await fixture({ env: { ...env, CREDIT_PRICE_CENTS_PER_100: '1500' } });
    expect(await (await quote(100)).json()).toMatchObject({ amountCents: 1500 });
    expect(creditPriceCents(300, 1500)).toBe(4500);
  });

  it('takes whole steps of 100, from 100 up to the cap, and refuses anything else with 422', async () => {
    const { quote, request, base } = await fixture();
    for (const credits of ['0', '50', '99', '101', '150', '-100', '1.5', '1e3', 'abc', '', '+100', '0100', ` 100`, '100000000000000000000', String(CREDIT_PURCHASE_MAX_CREDITS + CREDIT_PURCHASE_STEP)]) {
      const answer = await quote(encodeURIComponent(credits));
      expect(answer.status, `credits=${credits}`).toBe(422);
      expect((await answer.json()).error).toMatch(/steps of 100/);
    }
    expect((await quote(CREDIT_PURCHASE_MAX_CREDITS)).status).toBe(200);
    expect((await quote(CREDIT_PURCHASE_STEP)).status).toBe(200);
    expect((await request(`${base}/quote`)).status).toBe(422);
  });

  it('refuses a query it does not know, and a second credits value', async () => {
    const { request, base } = await fixture();
    expect((await request(`${base}/quote?credits=100&amountCents=1`)).status).toBe(422);
    expect((await request(`${base}/quote?credits=100&credits=200`)).status).toBe(422);
  });

  it('answers 503 with a plain reason, and logs a structured event, when the price is unset or unusable', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const value of [undefined, '', '   ', 'abc', '0', '-1200', '12.5', '1e3', '49', 1200.5, Number.NaN, '99999999999']) {
      const { quote, buy } = await fixture({ env: { ...env, CREDIT_PRICE_CENTS_PER_100: value } });
      const answer = await quote(100);
      expect(answer.status, String(value)).toBe(503);
      const body = await answer.json();
      expect(body.error).toBe('Buying credits isn\'t available right now. Try again later.');
      expect((await buy({ credits: 100 })).status).toBe(503);
    }
    const events = logged.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event).toMatchObject({ event: 'credit-purchases-price-unavailable', setting: 'CREDIT_PRICE_CENTS_PER_100' });
    expect(events.some((event) => event.rule === 'not-set')).toBe(true);
    expect(events.some((event) => event.rule !== 'not-set')).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/1200/);
  });

  it('refuses a price that would push one purchase past what a single charge can be', async () => {
    const { quote } = await fixture({ env: { ...env, CREDIT_PRICE_CENTS_PER_100: '1000000' } });
    expect((await quote(CREDIT_PURCHASE_MAX_CREDITS)).status).toBe(422);
    expect((await quote(100)).status).toBe(200);
  });

  it('is for an owner or an admin: a member is 403 with a plain reason, an outsider 403 not_a_member', async () => {
    const { quote } = await fixture();
    expect((await quote(100, 'alice')).status).toBe(200);
    expect((await quote(100, 'carol')).status).toBe(200);
    const member = await quote(100, 'bob');
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({ error: 'Only a Business owner or a Manager can buy credits for this business.', code: 'not_owner_or_admin' });
    const outsider = await quote(100, 'mallory');
    expect(outsider.status).toBe(403);
    expect(await outsider.json()).toMatchObject({ code: 'not_a_member' });
    const anonymous = await (await fixture()).request('/account/organizations/org/credit-purchases/quote?credits=100', { token: null });
    expect(anonymous.status).toBe(401);
  });

  it('writes nothing and never calls Stripe', async () => {
    const { quote, calls, purchases } = await fixture();
    await quote(100);
    expect(calls).toEqual([]);
    expect(purchases()).toEqual([]);
  });
});

describe('buying', () => {
  it('creates a pending purchase and a Checkout Session, and answers the purchase and where to pay', async () => {
    const { buy, calls, purchases, organization } = await fixture();
    const answer = await buy({ credits: 1000 });
    expect(answer.status).toBe(201);
    const body = await answer.json();
    expect(Object.keys(body).sort()).toEqual(['amountCents', 'checkoutUrl', 'credits', 'purchaseId']);
    expect(body).toMatchObject({ credits: 1000, amountCents: 12000, checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_session1#fragment' });
    expect(purchases()).toEqual([expect.objectContaining({
      tenantId: organization.tenantId, organizationId: organization.id, purchaseId: body.purchaseId, credits: 1000, amountCents: 12000,
      currency: 'usd', checkoutSessionId: 'cs_test_session1', state: 'pending', resolvedAt: null, stripeEventId: null,
    })]);
    expect(purchases()[0].personId).toMatch(/^person_/);
    expect(calls).toHaveLength(1);
  });

  it('sends Stripe a form-encoded one-line payment with the purchase carried in its metadata, and the purchase id as the idempotency key', async () => {
    const { buy, calls, clock, organization } = await fixture();
    const { purchaseId } = await (await buy({ credits: 1000 })).json();
    const [call] = calls;
    expect(call.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.headers['idempotency-key']).toBe(purchaseId);
    const form = Object.fromEntries(call.form.entries());
    expect(form).toMatchObject({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '12000',
      'line_items[0][price_data][product_data][name]': '1,000 Nectovia credits',
      client_reference_id: purchaseId,
      'metadata[purchase_id]': purchaseId,
      'metadata[organization_id]': organization.id,
      'metadata[tenant_id]': organization.tenantId,
      success_url: `${ORIGIN}/billing/return?purchase=${purchaseId}`,
      // The business's customer was made before the session, and the session names it.
      customer: CUSTOMER,
    });
    expect(call.form.has('customer_creation')).toBe(false);
    expect(form.cancel_url).toBe(`${ORIGIN}/billing/return?purchase=${purchaseId}&canceled=1`);
    // Stripe takes an expiry between 30 minutes and 24 hours out; this one is just past the shortest.
    const lifetime = Number(form.expires_at) - Math.floor(clock.at / 1000);
    expect(lifetime).toBeGreaterThanOrEqual(31 * 60);
    expect(lifetime).toBeLessThanOrEqual(40 * 60);
    // Nothing on the request names a markup, a percentage or a rate.
    expect(call.form.toString()).not.toMatch(/markup|percent|%25|rate/i);
  });

  it('names a single credit total in the product name for any amount', async () => {
    const { buy, calls } = await fixture();
    await buy({ credits: 100 });
    await buy({ credits: 25_000 });
    expect(calls.map((call) => call.form.get('line_items[0][price_data][product_data][name]'))).toEqual(['100 Nectovia credits', '25,000 Nectovia credits']);
  });

  it('never takes an amount, a price or a business from the request body', async () => {
    const { buy, purchases, calls } = await fixture();
    for (const body of [{ credits: 100, amountCents: 1 }, { credits: 100, organizationId: 'org_other' }, { credits: 100, priceCents: 1 }, { credits: 100, currency: 'eur' }, {}, { credits: '100' }, { credits: 150 }, { credits: 0 }, { credits: CREDIT_PURCHASE_MAX_CREDITS + 100 }, []]) {
      const answer = await buy(body);
      expect(answer.status, JSON.stringify(body)).toBe(422);
    }
    expect(purchases()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('is for an owner or an admin: a member is 403 and nothing is written or sent', async () => {
    const { buy, purchases, calls } = await fixture();
    expect((await buy({ credits: 100 }, 'bob')).status).toBe(403);
    expect((await buy({ credits: 100 }, 'mallory')).status).toBe(403);
    expect(purchases()).toEqual([]);
    expect(calls).toEqual([]);
    const admin = await buy({ credits: 100 }, 'carol');
    expect(admin.status).toBe(201);
    expect(purchases()[0].personId).not.toBe(purchases()[0].organizationId);
  });

  it('answers 503 before writing anything when the price or the Stripe key is not set', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const missing of ['CREDIT_PRICE_CENTS_PER_100', 'STRIPE_SECRET_KEY']) {
      const { buy, purchases, calls } = await fixture({ env: { ...env, [missing]: undefined } });
      const answer = await buy({ credits: 100 });
      expect(answer.status, missing).toBe(503);
      expect((await answer.json()).error).toBe('Buying credits isn\'t available right now. Try again later.');
      expect(purchases()).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  it('marks the purchase failed and answers 503 when Stripe refuses or cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const stripe of [() => Response.json({ error: { message: 'No.' } }, { status: 400 }), () => { throw new TypeError('fetch failed'); }, () => new Response('upstream', { status: 502 }), () => Response.json({ id: 'cs_test_x' })]) {
      const { buy, purchases } = await fixture({ stripe });
      const answer = await buy({ credits: 100 });
      expect(answer.status).toBe(503);
      expect((await answer.json()).error).toBe('The payment page couldn\'t be opened. Try again.');
      expect(purchases()).toEqual([expect.objectContaining({ state: 'failed', checkoutSessionId: null })]);
      expect(purchases()[0].resolvedAt).not.toBeNull();
    }
  });

  it('refuses a payment page that is not Stripe’s', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const url of ['https://evil.example/c/pay/cs_test_1', 'http://checkout.stripe.com/c/pay/cs_test_1', 'https://checkout.stripe.com.evil.example/x', 'https://user@evil.example/', 'javascript:alert(1)', 'https://checkout.stripe.com@evil.example/']) {
      const { buy, purchases } = await fixture({ stripe: () => Response.json({ id: 'cs_test_1', url }) });
      expect((await buy({ credits: 100 })).status, url).toBe(503);
      expect(purchases()[0].state).toBe('failed');
    }
  });

  it('gives every purchase its own id and its own idempotency key', async () => {
    const { buy, calls } = await fixture();
    const first = await (await buy({ credits: 100 })).json();
    const second = await (await buy({ credits: 100 })).json();
    expect(first.purchaseId).not.toBe(second.purchaseId);
    expect(calls.map((call) => call.headers['idempotency-key'])).toEqual([first.purchaseId, second.purchaseId]);
  });

  it('reads a purchase for the business that made it, as an owner or an admin, and as nobody else', async () => {
    const { buy, read, organization, other } = await fixture();
    const { purchaseId } = await (await buy({ credits: 500 })).json();
    const answer = await read(purchaseId);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ purchaseId, credits: 500, amountCents: 6000, state: 'pending' });
    expect((await read(purchaseId, 'carol')).status).toBe(200);
    expect((await read(purchaseId, 'bob')).status).toBe(403);
    expect((await read(purchaseId, 'mallory')).status).toBe(403);
    // Another business's owner, asking under their own business, finds nothing.
    const foreign = await read(purchaseId, 'dave', other.id);
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error).toBe('That purchase was not found for this business.');
    expect((await read('cpurch_unknown')).status).toBe(404);
    // The first business's purchase is not readable by the other business's owner under the first's address.
    expect((await read(purchaseId, 'dave', organization.id)).status).toBe(403);
  });
});

describe('the signature', () => {
  const body = '{"id":"evt_1"}';
  const header = (at: number, secret = SECRET, payload = body) => `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex')}`;
  const at = 1_800_000_000;

  it('accepts the HMAC-SHA256 of "t.rawBody" under the endpoint secret', async () => {
    expect(await verifyStripeSignature(body, header(at), SECRET, at * 1000)).toBe(true);
    expect(await verifyStripeSignature(new TextEncoder().encode(body), header(at), SECRET, at * 1000)).toBe(true);
  });

  it('refuses a wrong secret, a tampered body, a tampered timestamp and a malformed header', async () => {
    expect(await verifyStripeSignature(body, header(at, 'whsec_other'), SECRET, at * 1000)).toBe(false);
    expect(await verifyStripeSignature(`${body} `, header(at), SECRET, at * 1000)).toBe(false);
    expect(await verifyStripeSignature(body, header(at).replace(`t=${at}`, `t=${at + 1}`), SECRET, at * 1000)).toBe(false);
    for (const bad of [null, '', 't=', `t=${at}`, `v1=${'a'.repeat(64)}`, `t=abc,v1=${'a'.repeat(64)}`, `t=${at},v1=nothex`, `t=${at},v1=${'a'.repeat(63)}`, `t=${at},v0=${'a'.repeat(64)}`, `t=${at},v1=`, 'garbage'])
      expect(await verifyStripeSignature(body, bad, SECRET, at * 1000), String(bad)).toBe(false);
    expect(await verifyStripeSignature(body, header(at), '', at * 1000)).toBe(false);
  });

  it('holds a 300 second tolerance either way', async () => {
    expect(await verifyStripeSignature(body, header(at), SECRET, (at + 300) * 1000)).toBe(true);
    expect(await verifyStripeSignature(body, header(at), SECRET, (at + 301) * 1000)).toBe(false);
    expect(await verifyStripeSignature(body, header(at), SECRET, (at - 300) * 1000)).toBe(true);
    expect(await verifyStripeSignature(body, header(at), SECRET, (at - 301) * 1000)).toBe(false);
  });

  it('accepts a header that carries several v1 signatures when one of them matches, and ignores v0', async () => {
    const good = createHmac('sha256', SECRET).update(`${at}.${body}`).digest('hex');
    const bad = 'b'.repeat(64);
    expect(await verifyStripeSignature(body, `t=${at},v1=${bad},v1=${good}`, SECRET, at * 1000)).toBe(true);
    expect(await verifyStripeSignature(body, `t=${at},v0=${good}`, SECRET, at * 1000)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${at},v1=${bad},v1=${bad}`, SECRET, at * 1000)).toBe(false);
  });

  it('compares in constant time: the check reads no secret-dependent branch', () => {
    const source = readFileSync(new URL('../src/credit-purchases.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:crypto|timingSafeEqual/);
    expect(source).toMatch(/crypto\.subtle/);
  });
});

describe('the webhook', () => {
  it('records the top-up once, with the credits bought, and marks the purchase paid', async () => {
    const { bought, webhook, purchases, topUps, sessionFor, eventBody, organization, balance } = await fixture();
    const { row, answer } = await bought(1000);
    const paid = await webhook(eventBody('checkout.session.completed', sessionFor(row)));
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ received: true });
    expect(topUps()).toEqual([expect.objectContaining({
      tenantId: organization.tenantId, organizationId: organization.id, topUpId: answer.purchaseId, provider: 'stripe',
      sourceEventId: 'evt_paid_1', amountMicroUsd: creditAmount(1000),
    })]);
    expect(topUps()[0].amountMicroUsd).toBe(1000 * CREDIT_MICRO_USD);
    expect(purchases()).toEqual([expect.objectContaining({ state: 'paid', stripeEventId: 'evt_paid_1', amountCents: 12000, credits: 1000 })]);
    expect(purchases()[0].resolvedAt).not.toBeNull();
    // The credits are in the business's bought balance afterwards, for anyone in it to read.
    const after = await (await balance('alice')).json();
    expect(after).toMatchObject({ purchasedMicroUsd: creditAmount(1000), heldMicroUsd: 0, settledMicroUsd: 0, availableMicroUsd: creditAmount(1000) });
    expect(await (await balance('bob')).json()).toMatchObject({ purchasedMicroUsd: creditAmount(1000) });
  });

  it('adds to what the business already bought', async () => {
    const { bought, webhook, sessionFor, eventBody, balance } = await fixture();
    const first = await bought(100);
    await webhook(eventBody('checkout.session.completed', sessionFor(first.row), 'evt_a'));
    const second = await bought(300);
    await webhook(eventBody('checkout.session.completed', sessionFor(second.row), 'evt_b'));
    expect(await (await balance()).json()).toMatchObject({ purchasedMicroUsd: creditAmount(400) });
  });

  it('shows the buyer the purchase as paid', async () => {
    const { bought, webhook, sessionFor, eventBody, read } = await fixture();
    const { row, answer } = await bought(200);
    await webhook(eventBody('checkout.session.completed', sessionFor(row)));
    expect(await (await read(answer.purchaseId)).json()).toEqual({ purchaseId: answer.purchaseId, credits: 200, amountCents: 2400, state: 'paid' });
  });

  it('answers 400 and records nothing for a signature it cannot verify', async () => {
    const { bought, webhook, purchases, topUps, sessionFor, eventBody, sign, clock } = await fixture();
    const { row } = await bought(1000);
    const body = eventBody('checkout.session.completed', sessionFor(row));
    const bad: (string | null)[] = [null, '', 'garbage', sign(body, clock.at, 'whsec_other'), sign(body, clock.at - 301_000), sign(body, clock.at + 301_000), sign(`${body} `)];
    for (const header of bad) {
      const answer = await webhook(body, header);
      expect(answer.status, String(header)).toBe(400);
      expect(Object.keys(await answer.json())).toEqual(['error']);
    }
    expect(topUps()).toEqual([]);
    expect(purchases()[0].state).toBe('pending');
  });

  it('applies a replay of the same event once, and answers 200 to it', async () => {
    const { bought, webhook, topUps, sessionFor, eventBody, purchases } = await fixture();
    const { row } = await bought(1000);
    const body = eventBody('checkout.session.completed', sessionFor(row));
    expect((await webhook(body)).status).toBe(200);
    expect((await webhook(body)).status).toBe(200);
    expect((await webhook(body)).status).toBe(200);
    expect(topUps()).toHaveLength(1);
    expect(purchases()[0].stripeEventId).toBe('evt_paid_1');
  });

  it('changes nothing for a second event on a purchase that is already paid', async () => {
    const { bought, webhook, topUps, sessionFor, eventBody, purchases } = await fixture();
    const { row } = await bought(1000);
    await webhook(eventBody('checkout.session.completed', sessionFor(row), 'evt_first'));
    const again = await webhook(eventBody('checkout.session.async_payment_succeeded', sessionFor(row), 'evt_second'));
    expect(again.status).toBe(200);
    expect(topUps()).toEqual([expect.objectContaining({ sourceEventId: 'evt_first', amountMicroUsd: creditAmount(1000) })]);
    expect(purchases()[0].stripeEventId).toBe('evt_first');
  });

  it('changes nothing, and answers 200, when the amount or the currency is not the one stored', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bought, webhook, topUps, sessionFor, eventBody, purchases } = await fixture();
    const { row } = await bought(1000);
    for (const [index, change] of [{ amount_total: 11999 }, { amount_total: 12001 }, { amount_total: 1200 }, { amount_total: null }, { amount_total: '12000' }, { currency: 'eur' }, { currency: null }].entries()) {
      const answer = await webhook(eventBody('checkout.session.completed', sessionFor(row, change), `evt_mismatch_${index}`));
      expect(answer.status, JSON.stringify(change)).toBe(200);
    }
    expect(topUps()).toEqual([]);
    expect(purchases()[0]).toMatchObject({ state: 'pending', stripeEventId: null });
    expect(logged.mock.calls.some((call) => JSON.parse(String(call[0])).event === 'credit-purchase-mismatch')).toBe(true);
    // The right amount, afterwards, still pays it.
    expect((await webhook(eventBody('checkout.session.completed', sessionFor(row), 'evt_right'))).status).toBe(200);
    expect(topUps()).toHaveLength(1);
  });

  it('changes nothing for a session it does not know, or one whose purchase, business or tenant does not match', async () => {
    const { bought, webhook, topUps, sessionFor, eventBody, purchases, organization, other } = await fixture();
    const { row } = await bought(1000);
    const variants: Record<string, unknown>[] = [
      { id: 'cs_test_unknown' },
      { id: null },
      { metadata: { purchase_id: 'cpurch_other', organization_id: organization.id, tenant_id: organization.tenantId } },
      { metadata: { purchase_id: row.purchaseId, organization_id: other.id, tenant_id: organization.tenantId } },
      { metadata: { purchase_id: row.purchaseId, organization_id: organization.id, tenant_id: other.tenantId } },
      { metadata: { organization_id: organization.id, tenant_id: organization.tenantId } },
      { metadata: null },
      { metadata: {} },
    ];
    for (const [index, change] of variants.entries()) {
      const answer = await webhook(eventBody('checkout.session.completed', sessionFor(row, change), `evt_odd_${index}`));
      expect(answer.status, JSON.stringify(change)).toBe(200);
    }
    expect((await webhook(eventBody('checkout.session.completed', 'not an object', 'evt_odd_text'))).status).toBe(200);
    expect(topUps()).toEqual([]);
    expect(purchases()[0].state).toBe('pending');
  });

  it('does not pay a purchase from a session another purchase made', async () => {
    const { bought, webhook, topUps, sessionFor, eventBody, purchases } = await fixture();
    const first = await bought(100);
    const second = await bought(900);
    // The first purchase's session, claiming the second purchase and its bigger amount.
    await webhook(eventBody('checkout.session.completed', sessionFor(first.row, {
      amount_total: second.row.amountCents,
      metadata: { purchase_id: second.row.purchaseId, organization_id: second.row.organizationId, tenant_id: second.row.tenantId },
    })));
    expect(topUps()).toEqual([]);
    expect(purchases().map((row) => row.state)).toEqual(['pending', 'pending']);
  });

  it('waits for an unpaid completed session, and pays it on async_payment_succeeded', async () => {
    const { bought, webhook, topUps, sessionFor, eventBody, purchases } = await fixture();
    const { row } = await bought(1000);
    expect((await webhook(eventBody('checkout.session.completed', sessionFor(row, { payment_status: 'unpaid' }), 'evt_wait'))).status).toBe(200);
    expect(topUps()).toEqual([]);
    expect(purchases()[0].state).toBe('pending');
    expect((await webhook(eventBody('checkout.session.async_payment_succeeded', sessionFor(row), 'evt_later'))).status).toBe(200);
    expect(topUps()).toEqual([expect.objectContaining({ sourceEventId: 'evt_later', amountMicroUsd: creditAmount(1000) })]);
    expect(purchases()[0].state).toBe('paid');
  });

  it('marks a purchase expired when its session expires, and never pays it afterwards', async () => {
    const { bought, webhook, topUps, sessionFor, eventBody, purchases } = await fixture();
    const { row } = await bought(1000);
    expect((await webhook(eventBody('checkout.session.expired', sessionFor(row, { payment_status: 'unpaid', status: 'expired' }), 'evt_expired'))).status).toBe(200);
    expect(purchases()[0]).toMatchObject({ state: 'expired', stripeEventId: 'evt_expired' });
    expect(purchases()[0].resolvedAt).not.toBeNull();
    expect((await webhook(eventBody('checkout.session.completed', sessionFor(row), 'evt_late'))).status).toBe(200);
    expect(topUps()).toEqual([]);
    expect(purchases()[0].state).toBe('expired');
  });

  it('marks a purchase failed when a delayed payment fails', async () => {
    const { bought, webhook, topUps, sessionFor, eventBody, purchases } = await fixture();
    const { row } = await bought(1000);
    await webhook(eventBody('checkout.session.async_payment_failed', sessionFor(row, { payment_status: 'unpaid' }), 'evt_failed'));
    expect(purchases()[0].state).toBe('failed');
    expect(topUps()).toEqual([]);
  });

  it('ignores an event type it does not handle, and answers 200', async () => {
    const { bought, webhook, topUps, sessionFor, eventBody, purchases } = await fixture();
    const { row } = await bought(1000);
    for (const type of ['payment_intent.succeeded', 'charge.refunded', 'customer.created', 'invoice.paid']) {
      expect((await webhook(eventBody(type, sessionFor(row), `evt_${type.replace(/\W/g, '_')}`))).status, type).toBe(200);
    }
    expect(topUps()).toEqual([]);
    expect(purchases()[0].state).toBe('pending');
  });

  it('answers 400 for a signed body that is not an event, and 200 for one without a session to act on', async () => {
    const { webhook, sign } = await fixture();
    const text = 'not json at all';
    expect((await webhook(text, sign(text))).status).toBe(400);
    const arrays = '[1,2,3]';
    expect((await webhook(arrays, sign(arrays))).status).toBe(400);
    const noType = JSON.stringify({ id: 'evt_1' });
    expect((await webhook(noType, sign(noType))).status).toBe(400);
  });

  it('needs no bearer and no origin, and answers a browser preflight or a GET with a refusal', async () => {
    const { handler, bought, sessionFor, eventBody, sign } = await fixture();
    const { row } = await bought(100);
    const body = eventBody('checkout.session.completed', sessionFor(row));
    const answer = await handler(new Request(`${ORIGIN}/billing/stripe/webhook`, { method: 'POST', body, headers: { 'stripe-signature': sign(body) } }), env);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('access-control-allow-origin')).toBeNull();
    const get = await handler(new Request(`${ORIGIN}/billing/stripe/webhook`), env);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('answers 503, and records nothing, when the signing secret is not set, so Stripe tries again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bought, webhook, topUps, sessionFor, eventBody, purchases } = await fixture({ env: { ...env, STRIPE_WEBHOOK_SECRET: undefined } });
    const { row } = await bought(100);
    const answer = await webhook(eventBody('checkout.session.completed', sessionFor(row)));
    expect(answer.status).toBe(503);
    expect(topUps()).toEqual([]);
    expect(purchases()[0].state).toBe('pending');
  });

  it('refuses a body over the limit with 413 before reading it all', async () => {
    const { webhook, sign } = await fixture();
    const huge = 'x'.repeat(300_000);
    expect((await webhook(huge, sign(huge))).status).toBe(413);
  });

  it('writes the paid purchase and its top-up in one transaction: a failed commit leaves neither, and the retry lands both', async () => {
    const { bought, webhook, topUps, sessionFor, eventBody, purchases, repository, hooks } = await fixture();
    const { row } = await bought(1000);
    const body = eventBody('checkout.session.completed', sessionFor(row));
    // The event is stored first; the funding transaction that pays the purchase then fails its commit.
    hooks.afterRecord = () => { hooks.afterRecord = undefined; repository.failNextCommit('before-apply'); };
    const failed = await webhook(body);
    expect(failed.status).toBe(503);
    expect(topUps()).toEqual([]);
    expect(purchases()[0].state).toBe('pending');
    expect((await webhook(body)).status).toBe(200);
    expect(topUps()).toHaveLength(1);
    expect(purchases()[0].state).toBe('paid');
  });

  it('serves the same event twice at once as one top-up', async () => {
    const { bought, webhook, topUps, sessionFor, eventBody } = await fixture();
    const { row } = await bought(1000);
    const body = eventBody('checkout.session.completed', sessionFor(row));
    const answers = await Promise.all([webhook(body), webhook(body), webhook(body)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(topUps()).toHaveLength(1);
  });
});

describe('one Stripe customer per business, and the stored event a top-up names', () => {
  it('stores the verified event and the customer it names before the purchase is paid, and the top-up names that event', async () => {
    const { bought, webhook, sessionFor, eventBody, organization, ledgerState, hooks, topUps, purchases } = await fixture();
    const { row } = await bought(1000);
    const body = eventBody('checkout.session.completed', sessionFor(row, { customer_details: { email: 'buyer@example.test', name: 'A Buyer', address: { line1: '1 Test Street' } } }));
    let seenAtStore: { topUps: number; state: string } | null = null;
    hooks.afterRecord = () => { seenAtStore = { topUps: topUps().length, state: purchases()[0].state }; };
    expect((await webhook(body)).status).toBe(200);
    // The ledger had the event, and the funding rows had not yet moved.
    expect(seenAtStore).toEqual({ topUps: 0, state: 'pending' });
    expect(ledgerState.billingCustomers).toEqual([{ customerId: CUSTOMER, tenantId: organization.tenantId, organizationId: organization.id }]);
    expect(ledgerState.verifiedEvents).toEqual([expect.objectContaining({
      eventId: 'evt_paid_1', customerId: CUSTOMER, organizationId: organization.id, tenantId: organization.tenantId,
      eventType: 'checkout.session.completed', state: 'pending',
      payloadHash: createHash('sha256').update(body).digest('hex'),
    })]);
    // The top-up refers to the stored event, and the payload keeps what is acted on and nothing the buyer typed.
    expect(topUps()[0].sourceEventId).toBe(ledgerState.verifiedEvents[0].eventId);
    expect(JSON.stringify(ledgerState.verifiedEvents[0].payload)).not.toMatch(/buyer@example|A Buyer|Test Street/);
    expect(ledgerState.verifiedEvents[0].payload).toMatchObject({ id: 'evt_paid_1', data: { object: { id: row.checkoutSessionId, customer: CUSTOMER, amount_total: 12000 } } });
  });

  it('takes the business and tenant from the stored purchase, never from the event', async () => {
    const { bought, webhook, sessionFor, eventBody, organization, ledgerState, other } = await fixture();
    const { row } = await bought(1000);
    // Metadata that names another business does not match the stored purchase, so nothing is stored for it.
    await webhook(eventBody('checkout.session.completed', sessionFor(row, { metadata: { purchase_id: row.purchaseId, organization_id: other.id, tenant_id: other.tenantId } }), 'evt_other'));
    // No event is stored: the only row is the customer the purchase itself made, before any event.
    expect(ledgerState.verifiedEvents).toEqual([]);
    expect(ledgerState.billingCustomers).toEqual([expect.objectContaining({ customerId: CUSTOMER })]);
    await webhook(eventBody('checkout.session.completed', sessionFor(row), 'evt_own'));
    expect(ledgerState.verifiedEvents.map((event) => [event.organizationId, event.tenantId])).toEqual([[organization.id, organization.tenantId]]);
  });

  it('makes the business\'s customer at Stripe before its first session, stores it, and reuses the stored one on every later purchase', async () => {
    const { buy, calls, customerCalls, ledgerState, organization, webhook, sessionFor, eventBody, purchases } = await fixture();
    expect((await buy({ credits: 100 })).status).toBe(201);
    // Stored before any payment: it needs no verified event.
    expect(ledgerState.billingCustomers).toEqual([{ customerId: CUSTOMER, tenantId: organization.tenantId, organizationId: organization.id }]);
    expect(customerCalls).toHaveLength(1);
    expect(calls[0].form.get('customer')).toBe(CUSTOMER);
    expect(calls[0].form.has('customer_creation')).toBe(false);
    expect((await buy({ credits: 200 })).status).toBe(201);
    await webhook(eventBody('checkout.session.completed', sessionFor(purchases()[0]), 'evt_a'));
    expect((await buy({ credits: 300 })).status).toBe(201);
    // Stripe was asked for a customer once, and every session names that customer.
    expect(customerCalls).toHaveLength(1);
    expect(calls.map((call) => call.form.get('customer'))).toEqual([CUSTOMER, CUSTOMER, CUSTOMER]);
    expect(ledgerState.billingCustomers).toHaveLength(1);
  });

  it('asks Stripe for the customer with the business and tenant ids as metadata, nothing about a person, and a key derived from them', async () => {
    const { buy, customerCalls, organization, other, request } = await fixture();
    await buy({ credits: 100 });
    const [call] = customerCalls;
    expect(call.url).toBe('https://api.stripe.com/v1/customers');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect([...call.form.entries()]).toEqual([['metadata[organization_id]', organization.id], ['metadata[tenant_id]', organization.tenantId]]);
    const key = `nectovia-customer-${createHash('sha256').update(JSON.stringify(['stripe-customer', organization.tenantId, organization.id])).digest('hex')}`;
    expect(call.headers['idempotency-key']).toBe(key);
    // Another business has another key.
    await request(`/account/organizations/${other.id}/credit-purchases`, { method: 'POST', token: 'dave', body: JSON.stringify({ credits: 100 }) });
    expect(customerCalls).toHaveLength(2);
    expect(customerCalls[1].headers['idempotency-key']).not.toBe(key);
  });

  it('gives two first purchases made at once one customer, so both are paid and both top-ups are recorded against it', async () => {
    // Stripe is slow to answer the customer call, so the second purchase starts while the first is still waiting on it.
    const { buy, purchases, customerCalls, calls, ledgerState, webhook, sessionFor, eventBody, topUps, organization } = await fixture({
      customer: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return Response.json({ id: 'cus_slow_one', object: 'customer' });
      },
    });
    const answers = await Promise.all([buy({ credits: 100 }), buy({ credits: 300 })]);
    expect(answers.map((answer) => answer.status)).toEqual([201, 201]);
    expect(customerCalls).toHaveLength(1);
    const customer = ledgerState.billingCustomers[0].customerId;
    expect(ledgerState.billingCustomers).toEqual([{ customerId: customer, tenantId: organization.tenantId, organizationId: organization.id }]);
    expect(calls.map((call) => call.form.get('customer'))).toEqual([customer, customer]);
    // Both are paid before either event lands, each event naming the customer its own session was made for.
    const [first, second] = purchases();
    const bodies = [first, second].map((row, index) => eventBody('checkout.session.completed', sessionFor(row, { customer }), `evt_both_${index}`));
    expect((await Promise.all(bodies.map((body) => webhook(body)))).map((answer) => answer.status)).toEqual([200, 200]);
    expect(purchases().map((row) => row.state)).toEqual(['paid', 'paid']);
    expect(topUps()).toHaveLength(2);
    expect(topUps().map((row) => row.sourceEventId).sort()).toEqual(['evt_both_0', 'evt_both_1']);
    expect(ledgerState.billingCustomers).toHaveLength(1);
    expect(ledgerState.verifiedEvents.map((event) => event.customerId)).toEqual([customer, customer]);
  });

  it('gets the same customer back when a retry follows a customer that was made but not stored', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { buy, customerCalls, ledger, ledgerState, purchases } = await fixture();
    // Stripe answers, and then the store fails before the row is kept: nothing is stored, and no purchase is left.
    vi.spyOn(ledger, 'ensureCustomer').mockImplementationOnce(async (_ref, make) => { await make(); throw new Error('connection reset'); });
    expect((await buy({ credits: 100 })).status).toBeGreaterThanOrEqual(500);
    expect(ledgerState.billingCustomers).toEqual([]);
    expect(purchases()).toEqual([]);
    expect((await buy({ credits: 100 })).status).toBe(201);
    // The retry asked with the same key, so Stripe answered with the customer it had already made.
    expect(customerCalls).toHaveLength(2);
    expect(customerCalls[1].headers['idempotency-key']).toBe(customerCalls[0].headers['idempotency-key']);
    expect(ledgerState.billingCustomers.map((row) => row.customerId)).toEqual([CUSTOMER]);
  });

  it('leaves no purchase and answers 503 when Stripe will not make the customer, or answers something that is not one', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const answers = [() => Response.json({ error: { message: 'No.' } }, { status: 400 }), () => { throw new TypeError('fetch failed'); }, () => new Response('upstream', { status: 502 }),
      () => Response.json({ object: 'customer' }), () => Response.json({ id: 'cus_' }), () => Response.json({ id: 'not_a_customer' }), () => Response.json({ id: { nested: 'cus_x' } })];
    for (const customer of answers) {
      const { buy, purchases, calls, ledgerState } = await fixture({ customer });
      const answer = await buy({ credits: 100 });
      expect(answer.status).toBe(503);
      expect((await answer.json()).error).toBe('The payment page couldn\'t be opened. Try again.');
      expect(purchases()).toEqual([]);
      expect(calls).toEqual([]);
      expect(ledgerState.billingCustomers).toEqual([]);
    }
    expect(logged.mock.calls.map((call) => JSON.parse(String(call[0])).event)).toEqual(expect.arrayContaining(
      ['credit-purchase-customer-refused', 'credit-purchase-customer-unreachable', 'credit-purchase-customer-unreadable']));
  });

  it('holds the customer call under the limits the lock is taken with: a waiting purchase gets 3 seconds, an open transaction 6 idle', () => {
    const adapter = readFileSync(new URL('../src/postgres.ts', import.meta.url), 'utf8');
    expect(adapter).toContain("SET LOCAL lock_timeout = '3s'");
    expect(adapter).toContain("SET LOCAL idle_in_transaction_session_timeout = '6s'");
    expect(STRIPE_CUSTOMER_TIMEOUT_MS).toBeLessThan(3000);
  });

  it('reuses one customer for every payment of a business, and stores each event once', async () => {
    const { bought, webhook, sessionFor, eventBody, ledgerState, topUps } = await fixture();
    const first = await bought(100);
    const second = await bought(300);
    await webhook(eventBody('checkout.session.completed', sessionFor(first.row), 'evt_a'));
    await webhook(eventBody('checkout.session.completed', sessionFor(second.row), 'evt_b'));
    expect(ledgerState.billingCustomers).toHaveLength(1);
    expect(ledgerState.verifiedEvents.map((event) => event.eventId)).toEqual(['evt_a', 'evt_b']);
    expect(topUps().map((row) => row.sourceEventId)).toEqual(['evt_a', 'evt_b']);
  });

  it('refuses a paid event that names another customer than the business already has, and pays nothing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bought, webhook, sessionFor, eventBody, ledgerState, topUps, purchases } = await fixture();
    const first = await bought(100);
    const second = await bought(300);
    await webhook(eventBody('checkout.session.completed', sessionFor(first.row), 'evt_a'));
    const refused = await webhook(eventBody('checkout.session.completed', sessionFor(second.row, { customer: 'cus_someone_else' }), 'evt_b'));
    expect(refused.status).toBe(200);
    expect(ledgerState.billingCustomers).toEqual([expect.objectContaining({ customerId: CUSTOMER })]);
    expect(ledgerState.verifiedEvents.map((event) => event.eventId)).toEqual(['evt_a']);
    expect(topUps()).toHaveLength(1);
    expect(purchases().map((row) => row.state)).toEqual(['paid', 'pending']);
    expect(logged.mock.calls.map((call) => JSON.parse(String(call[0])))).toContainEqual({ event: 'credit-purchase-ledger-refused', code: 'customer_mismatch', eventId: 'evt_b' });
  });

  it('refuses a customer that already belongs to another business', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bought, webhook, sessionFor, eventBody, ledgerState, topUps, organization, other, ledger } = await fixture();
    // Another business already owns the customer a paid event now names for this one.
    const daves = 'cus_fixture_dave';
    await ledger.recordVerifiedPayment({ eventId: 'evt_dave', customerId: daves, organizationId: other.id, tenantId: other.tenantId,
      payloadHash: 'a'.repeat(64), eventType: 'checkout.session.completed', payload: {} });
    const { row } = await bought(100);
    expect((await webhook(eventBody('checkout.session.completed', sessionFor(row, { customer: daves }), 'evt_a'))).status).toBe(200);
    expect(ledgerState.verifiedEvents.map((event) => event.eventId)).toEqual(['evt_dave']);
    expect(ledgerState.billingCustomers).toEqual([
      { customerId: daves, tenantId: other.tenantId, organizationId: other.id },
      { customerId: CUSTOMER, tenantId: organization.tenantId, organizationId: organization.id },
    ]);
    expect(topUps()).toEqual([]);
    expect(organization.id).not.toBe(other.id);
  });

  it('stores nothing, and pays nothing, for a paid event with no customer', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bought, webhook, sessionFor, eventBody, ledgerState, topUps, purchases } = await fixture();
    const { row } = await bought(100);
    for (const [index, customer] of [null, undefined, 'not_a_customer', 'cus_', { id: 'cus_object' }, 42].entries())
      expect((await webhook(eventBody('checkout.session.completed', sessionFor(row, { customer }), `evt_none_${index}`))).status).toBe(200);
    // No event is stored: the only row is the customer the purchase itself made, before any event.
    expect(ledgerState.verifiedEvents).toEqual([]);
    expect(ledgerState.billingCustomers).toEqual([expect.objectContaining({ customerId: CUSTOMER })]);
    expect(topUps()).toEqual([]);
    expect(purchases()[0].state).toBe('pending');
    expect(logged.mock.calls.some((call) => JSON.parse(String(call[0])).event === 'credit-purchase-no-customer')).toBe(true);
  });

  it('stores nothing for an event it does not verify, replay, mismatch, expire or fail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bought, webhook, sessionFor, eventBody, ledgerState, ledgerCalls, sign, clock } = await fixture();
    const { row } = await bought(1000);
    const body = eventBody('checkout.session.completed', sessionFor(row));
    expect((await webhook(body, sign(body, clock.at, 'whsec_other'))).status).toBe(400);
    expect((await webhook(eventBody('checkout.session.completed', sessionFor(row, { amount_total: 1 }), 'evt_amount'))).status).toBe(200);
    expect((await webhook(eventBody('checkout.session.completed', sessionFor(row, { id: 'cs_test_unknown' }), 'evt_unknown'))).status).toBe(200);
    expect((await webhook(eventBody('checkout.session.completed', sessionFor(row, { payment_status: 'unpaid' }), 'evt_unpaid'))).status).toBe(200);
    expect((await webhook(eventBody('checkout.session.expired', sessionFor(row, { payment_status: 'unpaid' }), 'evt_expired'))).status).toBe(200);
    expect((await webhook(eventBody('checkout.session.async_payment_failed', sessionFor(row), 'evt_failed'))).status).toBe(200);
    // No event is stored: the only row is the customer the purchase itself made, before any event.
    expect(ledgerState.verifiedEvents).toEqual([]);
    expect(ledgerState.billingCustomers).toEqual([expect.objectContaining({ customerId: CUSTOMER })]);
    expect(ledgerCalls.filter((call) => call === 'recordVerifiedPayment')).toEqual([]);
    // A replay of a paid event, once it is paid, is not stored a second time either.
    const paid = await bought(100);
    const paidBody = eventBody('checkout.session.completed', sessionFor(paid.row), 'evt_paid_once');
    await webhook(paidBody);
    await webhook(paidBody);
    expect(ledgerCalls.filter((call) => call === 'recordVerifiedPayment')).toHaveLength(1);
    expect(ledgerState.verifiedEvents).toHaveLength(1);
  });

  it('lets Stripe\'s retry finish a payment whose funding step failed, with the event and the customer stored once', async () => {
    const { bought, webhook, sessionFor, eventBody, ledgerState, topUps, purchases, repository, hooks } = await fixture();
    const { row } = await bought(1000);
    const body = eventBody('checkout.session.completed', sessionFor(row));
    hooks.afterRecord = () => { hooks.afterRecord = undefined; repository.failNextCommit('before-apply'); };
    expect((await webhook(body)).status).toBe(503);
    // Stored, not yet applied.
    expect(ledgerState.verifiedEvents).toHaveLength(1);
    expect(ledgerState.billingCustomers).toHaveLength(1);
    expect(topUps()).toEqual([]);
    expect(purchases()[0].state).toBe('pending');
    expect((await webhook(body)).status).toBe(200);
    expect(ledgerState.verifiedEvents).toHaveLength(1);
    expect(ledgerState.billingCustomers).toHaveLength(1);
    expect(topUps()).toHaveLength(1);
    expect(purchases()[0].state).toBe('paid');
  });

  it('answers 503 so Stripe tries again when the ledger cannot be written, and pays nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bought, webhook, sessionFor, eventBody, topUps, purchases, ledger } = await fixture();
    const { row } = await bought(100);
    vi.spyOn(ledger, 'recordVerifiedPayment').mockRejectedValueOnce(new Error('connection reset'));
    const body = eventBody('checkout.session.completed', sessionFor(row));
    expect((await webhook(body)).status).toBe(503);
    expect(topUps()).toEqual([]);
    expect(purchases()[0].state).toBe('pending');
    expect((await webhook(body)).status).toBe(200);
    expect(topUps()).toHaveLength(1);
  });

  it('has the customer before anything is written, and leaves no purchase when that fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { buy, purchases, calls, ledger } = await fixture();
    vi.spyOn(ledger, 'ensureCustomer').mockRejectedValueOnce(new Error('connection reset'));
    expect((await buy({ credits: 100 })).status).toBeGreaterThanOrEqual(500);
    expect(purchases()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('never takes a customer id from the request: a body that names one is refused', async () => {
    const { buy, purchases, calls } = await fixture();
    for (const body of [{ credits: 100, customer: 'cus_attacker' }, { credits: 100, customerId: 'cus_attacker' }])
      expect((await buy(body)).status).toBe(422);
    expect(purchases()).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('the page Stripe returns the buyer to', () => {
  it('says in one line to go back to Nectovia, needs no sign-in and echoes nothing', async () => {
    const { handler } = await fixture();
    const paid = await handler(new Request(`${ORIGIN}/billing/return?purchase=cpurch_1`), env);
    expect(paid.status).toBe(200);
    expect(paid.headers.get('content-type')).toMatch(/^text\/html/);
    expect(paid.headers.get('cache-control')).toBe('no-store');
    expect(paid.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const page = await paid.text();
    expect(page).toContain('Go back to Nectovia.');
    expect(page).not.toContain('cpurch_1');
    const hostile = await (await handler(new Request(`${ORIGIN}/billing/return?purchase=${encodeURIComponent('<script>alert(1)</script>')}`), env)).text();
    expect(hostile).not.toContain('<script>alert');
    const canceled = await (await handler(new Request(`${ORIGIN}/billing/return?purchase=cpurch_1&canceled=1`), env)).text();
    expect(canceled).toContain('Go back to Nectovia.');
    expect(canceled).not.toMatch(/credits show up/);
    expect((await handler(new Request(`${ORIGIN}/billing/return`, { method: 'POST' }), env)).status).toBe(405);
  });
});

describe('what a customer reads', () => {
  it('keeps every sentence plain: no dashes, no exclamation marks, no markup, no vendor, no reassurance tail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { quote, buy, read, handler, request, base } = await fixture({ env: { ...env, CREDIT_PRICE_CENTS_PER_100: undefined } });
    const unset = await fixture({ env: { ...env, STRIPE_SECRET_KEY: undefined } });
    const failing = await fixture({ stripe: () => new Response('no', { status: 500 }) });
    const noCustomer = await fixture({ customer: () => new Response('no', { status: 500 }) });
    const answers = [
      await quote(100, 'bob'), await quote(150), await quote(100), await buy({ credits: 100 }), await read('cpurch_nope'),
      await unset.buy({ credits: 100 }), await failing.buy({ credits: 100 }), await noCustomer.buy({ credits: 100 }), await request(`${base}/nowhere`),
      await handler(new Request(`${ORIGIN}/billing/return`), env),
    ];
    for (const answer of answers) {
      // A page is read by its words: the line a person sees, not the markup around it.
      const text = answer.headers.get('content-type')?.startsWith('application/json') ? String((await answer.json()).error) : /<p>(.*)<\/p>/.exec(await answer.text())![1];
      expect(text).not.toMatch(/[–—!]|--/);
      expect(text).not.toMatch(/mark-?up|percent|%|stripe|bedrock|openrouter|luna|claude|gpt/i);
      expect(text).not.toMatch(/Nothing was (charged|sent|held|changed)\.\s*$/);
    }
  });
});

describe('the Postgres rows', () => {
  const at = '2026-10-01T09:00:00.000Z';
  const row = { tenantId: 't1', organizationId: 'o1', purchaseId: 'cpurch_1', personId: 'person_1', credits: 1000, amountCents: 12000, currency: 'usd' as const,
    checkoutSessionId: 'cs_test_1', state: 'pending' as const, createdAt: at, resolvedAt: null, stripeEventId: null };
  function recording(answer: Record<string, unknown>[] = []) {
    const sent: { sql: string; values: unknown[] }[] = [];
    const client: SqlClient = { async connect() {}, async end() {}, async query(sql, values) { sent.push({ sql, values: values ?? [] }); return { rows: answer, rowCount: answer.length }; } };
    return { sent, tx: new PostgresFundingTransaction(client) };
  }

  it('inserts a purchase and moves only its session, state, resolution and event', async () => {
    const { sent, tx } = recording();
    await tx.saveCreditPurchase(row);
    expect(sent[0].sql).toMatch(/^INSERT INTO control_plane\.credit_purchases\(/);
    expect(sent[0].sql).toMatch(/ON CONFLICT \(tenant_id,purchase_id\) DO UPDATE SET stripe_checkout_session_id=EXCLUDED\.stripe_checkout_session_id,state=EXCLUDED\.state,resolved_at=EXCLUDED\.resolved_at,stripe_event_id=EXCLUDED\.stripe_event_id$/);
    expect(sent[0].values).toEqual(['t1', 'cpurch_1', 'o1', 'person_1', 1000, 12000, 'usd', 'cs_test_1', 'pending', at, null, null]);
  });

  it('locks the row it reads by purchase, and finds one by session without a tenant', async () => {
    const stored = { tenant_id: 't1', purchase_id: 'cpurch_1', organization_id: 'o1', person_id: 'person_1', credits: 1000, amount_cents: '12000', currency: 'usd',
      stripe_checkout_session_id: 'cs_test_1', state: 'paid', created_at: new Date(at), resolved_at: new Date(at), stripe_event_id: 'evt_1' };
    const { sent, tx } = recording([stored]);
    expect(await tx.creditPurchase('t1', 'cpurch_1')).toEqual({ ...row, state: 'paid', resolvedAt: at, stripeEventId: 'evt_1' });
    expect(sent[0].sql).toMatch(/FROM control_plane\.credit_purchases WHERE tenant_id=\$1 AND purchase_id=\$2 FOR UPDATE$/);
    expect(await tx.creditPurchaseBySession('cs_test_1')).toMatchObject({ purchaseId: 'cpurch_1' });
    expect(sent[1].sql).toMatch(/WHERE stripe_checkout_session_id=\$1$/);
    expect(sent[1].sql).not.toMatch(/FOR UPDATE/);
  });
});

describe('migration 015 and its place in the list', () => {
  const sql = readFileSync(new URL('../migrations/015_credit_purchases.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../scripts/migrate.ts', import.meta.url), 'utf8');

  it('is LF only, adds one table and removes no table, column or row', () => {
    expect(sql.includes('\r')).toBe(false);
    expect(sql).toContain('CREATE TABLE control_plane.credit_purchases');
    expect(sql).not.toMatch(/\b(DROP\s+TABLE|DROP\s+COLUMN|DELETE\s+FROM|TRUNCATE|DROP\s+SCHEMA)\b/i);
    expect(sql.trim().endsWith('REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;')).toBe(true);
  });

  it('keeps the columns and the checks that make a purchase mean one thing', () => {
    for (const column of ['tenant_id', 'purchase_id', 'organization_id', 'person_id', 'credits', 'amount_cents', 'currency', 'stripe_checkout_session_id', 'state', 'created_at', 'resolved_at', 'stripe_event_id'])
      expect(sql).toMatch(new RegExp(`\\n  ${column} `));
    expect(sql).toContain("currency = 'usd'");
    expect(sql).toContain("state IN ('pending','paid','expired','failed')");
    expect(sql).toContain('credits % 100 = 0');
    expect(sql).toContain('stripe_checkout_session_id text UNIQUE');
    expect(sql).toContain('stripe_event_id text UNIQUE');
    expect(sql).toContain('PRIMARY KEY (tenant_id,purchase_id)');
    expect(sql).toMatch(/FOREIGN KEY \(organization_id,tenant_id\) REFERENCES control_plane\.organizations\(id,tenant_id\)/);
    expect(sql).toContain('person_id text NOT NULL REFERENCES control_plane.persons(id)');
    expect(sql).toContain("CHECK ((state = 'pending') = (resolved_at IS NULL))");
    expect(sql).toMatch(/CHECK \(state <> 'paid' OR \(stripe_event_id IS NOT NULL AND stripe_checkout_session_id IS NOT NULL\)\)/);
  });

  it('is purely additive: it keeps credit_topups\'s reference to the stored webhook event and changes no existing table', () => {
    const code = sql.split('\n').filter((line) => !line.startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bALTER\b|\bDROP\b|DROP CONSTRAINT|\bDO\s+\$\$|\bUPDATE\b|\bINSERT\b|regclass|credit_topups|webhook_inbox|billing_customers/i);
    expect(code.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(code.match(/CREATE INDEX/g)).toHaveLength(1);
    expect(code.match(/\bCREATE\b/g)).toHaveLength(2);
    // The reference it leaves alone is still in migration 003.
    const funded = readFileSync(new URL('../migrations/003_funded_jobs.sql', import.meta.url), 'utf8');
    expect(funded).toMatch(/CREATE TABLE control_plane\.credit_topups[\s\S]*FOREIGN KEY \(tenant_id,provider,source_event_id\) REFERENCES control_plane\.webhook_inbox\(tenant_id,provider,event_id\)/);
  });

  it('is listed in the runner after 014, and names no markup', () => {
    expect(runner).toMatch(/'014_member_credit_limits\.sql','015_credit_purchases\.sql'\]/);
    expect(sql).not.toMatch(/markup|percent|%\s*markup/i);
    const everything = [sql, readFileSync(new URL('../src/credit-purchases.ts', import.meta.url), 'utf8'), readFileSync(new URL('../README.md', import.meta.url), 'utf8')].join('\n');
    expect(everything).not.toMatch(/\b20 ?%|twenty percent|1\.2x|markup/i);
  });
});

describe('the faux cloud', () => {
  async function faux(options: Parameters<typeof createFauxCloud>[0]['billing'] = undefined) {
    const cloud = await createFauxCloud({ file: null, passwordIterations: 1_000, billing: options });
    const seeded = await seedDemo(cloud);
    const signIn = await cloud.handle(new Request('http://127.0.0.1:8795/auth/sign-in', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD }),
    }));
    const token = (await signIn.json()).accessToken as string;
    const call = (method: string, path: string, body?: unknown) => cloud.handle(new Request(`http://127.0.0.1:8795${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    return { cloud, organizationId: seeded.organizations!.juniper, call };
  }

  it('hands back a local checkout page, and a test helper completes it into a top-up', async () => {
    const { cloud, organizationId, call } = await faux();
    const before = await (await call('GET', `/account/organizations/${organizationId}/purchased-usage`)).json();
    const answer = await call('POST', `/account/organizations/${organizationId}/credit-purchases`, { credits: 500 });
    expect(answer.status).toBe(201);
    const body = await answer.json();
    expect(body).toMatchObject({ credits: 500, amountCents: 6000 });
    expect(body.checkoutUrl).toMatch(/^http:\/\/127\.0\.0\.1:8795\/faux\/checkout\/cs_faux_[A-Za-z0-9]+$/);
    const page = await cloud.handle(new Request(body.checkoutUrl));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('500 Nectovia credits');
    const sessionId = new URL(body.checkoutUrl).pathname.split('/').pop()!;
    const done = await cloud.completeCheckout(sessionId);
    expect(done).toEqual({ purchaseId: body.purchaseId, status: 200 });
    expect(await (await call('GET', `/account/organizations/${organizationId}/credit-purchases/${body.purchaseId}`)).json()).toMatchObject({ state: 'paid' });
    const after = await (await call('GET', `/account/organizations/${organizationId}/purchased-usage`)).json();
    expect(after.purchasedMicroUsd - before.purchasedMicroUsd).toBe(creditAmount(500));
    // Completing it again changes nothing.
    await cloud.completeCheckout(sessionId);
    expect((await (await call('GET', `/account/organizations/${organizationId}/purchased-usage`)).json()).purchasedMicroUsd).toBe(after.purchasedMicroUsd);
  });

  it('completes through the checkout page itself, and sends the buyer to the page that says to go back', async () => {
    const { cloud, organizationId, call } = await faux();
    const body = await (await call('POST', `/account/organizations/${organizationId}/credit-purchases`, { credits: 100 })).json();
    const paid = await cloud.handle(new Request(`${body.checkoutUrl}/complete`, { method: 'POST' }));
    expect(paid.status).toBe(303);
    expect(paid.headers.get('location')).toBe(`http://127.0.0.1:8795/billing/return?purchase=${body.purchaseId}`);
    expect((await cloud.handle(new Request(`${body.checkoutUrl}/complete`, { method: 'GET' }))).status).toBe(405);
    expect((await cloud.handle(new Request(`http://127.0.0.1:8795/faux/checkout/cs_faux_${'a'.repeat(24)}`))).status).toBe(404);
  });

  it('makes the business one customer before its first session and reuses it on the next', async () => {
    const { cloud, organizationId, call } = await faux();
    const buy = async (credits: number) => {
      const body = await (await call('POST', `/account/organizations/${organizationId}/credit-purchases`, { credits })).json();
      return new URL(body.checkoutUrl).pathname.split('/').pop()!;
    };
    const first = await buy(100);
    const { tenantId } = cloud.store.snapshot().funding.creditPurchases[0];
    // Made before the session, so before any payment.
    const customer = await cloud.paymentLedger.storedCustomer({ tenantId, organizationId });
    expect(customer).toMatch(/^cus_faux_[a-z0-9]+$/);
    expect(cloud.store.snapshot().funding.verifiedEvents).toEqual([]);
    await cloud.completeCheckout(first);
    const second = await buy(200);
    await cloud.completeCheckout(second);
    const { billingCustomers, verifiedEvents, topUps } = cloud.store.snapshot().funding;
    expect(billingCustomers).toEqual([{ customerId: customer, tenantId, organizationId }]);
    expect(verifiedEvents.map((event) => event.customerId)).toEqual([customer, customer]);
    expect(topUps.slice(-2).map((row) => row.sourceEventId)).toEqual(verifiedEvents.map((event) => event.eventId));
    // Paying the first again changes nothing: the event is already stored, once.
    await cloud.completeCheckout(first);
    expect(cloud.store.snapshot().funding.verifiedEvents).toHaveLength(2);
  });

  it('gives two first purchases made at once one customer, and both are paid and recorded against it', async () => {
    const { cloud, organizationId, call } = await faux();
    const answers = await Promise.all([call('POST', `/account/organizations/${organizationId}/credit-purchases`, { credits: 100 }),
      call('POST', `/account/organizations/${organizationId}/credit-purchases`, { credits: 200 })]);
    expect(answers.map((answer) => answer.status)).toEqual([201, 201]);
    const sessions = await Promise.all(answers.map(async (answer) => new URL((await answer.json()).checkoutUrl).pathname.split('/').pop()!));
    const done = await Promise.all(sessions.map((session) => cloud.completeCheckout(session)));
    expect(done.map((row) => row.status)).toEqual([200, 200]);
    const { billingCustomers, verifiedEvents, topUps, creditPurchases } = cloud.store.snapshot().funding;
    expect(billingCustomers).toHaveLength(1);
    expect(verifiedEvents.map((event) => event.customerId)).toEqual([billingCustomers[0].customerId, billingCustomers[0].customerId]);
    expect(creditPurchases.filter((row) => row.organizationId === organizationId).map((row) => row.state)).toEqual(['paid', 'paid']);
    expect(topUps.filter((row) => verifiedEvents.some((event) => event.eventId === row.sourceEventId))).toHaveLength(2);
  });

  it('can leave the price unset, which answers 503 as the Worker does', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { organizationId, call } = await faux({ creditPriceCentsPer100: null });
    expect((await call('GET', `/account/organizations/${organizationId}/credit-purchases/quote?credits=100`)).status).toBe(503);
  });

  it('prices from the option it is given, and quotes a member out', async () => {
    const { organizationId, call } = await faux({ creditPriceCentsPer100: 1500 });
    expect(await (await call('GET', `/account/organizations/${organizationId}/credit-purchases/quote?credits=200`)).json()).toEqual({ credits: 200, amountCents: 3000, currency: 'usd' });
  });
});

describe('the faux Stripe', () => {
  const customerRequest = (key: string | null, body = 'metadata[organization_id]=org_1&metadata[tenant_id]=tenant_1', secret = FAUX_STRIPE_SECRET_KEY) => ({
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(key === null ? {} : { 'Idempotency-Key': key }) },
    body,
  });
  const CUSTOMERS = 'https://api.stripe.com/v1/customers';

  it('makes a customer once per idempotency key: a retry with the same key returns the same id, and another key makes another', async () => {
    const stripe = fauxStripeFetch();
    const first = await (await stripe(CUSTOMERS, customerRequest('key-1'))).json();
    expect(first.id).toMatch(/^cus_faux_[a-z0-9]{14}$/);
    expect((await (await stripe(CUSTOMERS, customerRequest('key-1'))).json()).id).toBe(first.id);
    expect(stripe.customers).toHaveLength(1);
    const other = await (await stripe(CUSTOMERS, customerRequest('key-2'))).json();
    expect(other.id).not.toBe(first.id);
    expect(stripe.customers).toHaveLength(2);
    // The same key with other parameters is refused, as Stripe refuses it.
    expect((await stripe(CUSTOMERS, customerRequest('key-1', 'metadata[organization_id]=org_2&metadata[tenant_id]=tenant_1'))).status).toBe(400);
  });

  it('refuses a customer call with no key, the wrong key, a missing id, or a field about a person', async () => {
    const stripe = fauxStripeFetch();
    expect((await stripe(CUSTOMERS, customerRequest(null))).status).toBe(400);
    expect((await stripe(CUSTOMERS, customerRequest('key-1', undefined, 'sk_test_other'))).status).toBe(401);
    expect((await stripe(CUSTOMERS, customerRequest('key-1', 'metadata[tenant_id]=tenant_1'))).status).toBe(400);
    for (const field of ['email=buyer%40example.test', 'name=A+Buyer', 'address[line1]=1+Test+Street', 'phone=555'])
      expect((await stripe(CUSTOMERS, customerRequest('key-1', `metadata[organization_id]=org_1&metadata[tenant_id]=tenant_1&${field}`))).status, field).toBe(400);
    expect((await stripe(CUSTOMERS, { ...customerRequest('key-1'), method: 'GET' })).status).toBe(404);
    expect(stripe.customers).toEqual([]);
  });

  it('wants the business\'s customer on every session, and refuses customer_creation outright', async () => {
    const stripe = fauxStripeFetch();
    const session = (extra: string) => stripe('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${FAUX_STRIPE_SECRET_KEY}`, 'Idempotency-Key': 'cpurch_1' },
      body: `mode=payment&success_url=http%3A%2F%2F127.0.0.1%3A8795%2Fbilling%2Freturn&cancel_url=http%3A%2F%2F127.0.0.1%3A8795%2Fbilling%2Freturn&client_reference_id=cpurch_1&line_items[0][price_data][unit_amount]=1200${extra}`,
    });
    expect((await session('')).status).toBe(400);
    expect((await session('&customer_creation=always')).status).toBe(400);
    expect((await session('&customer=cus_faux_abc&customer_creation=always')).status).toBe(400);
    expect((await session('&customer=not_a_customer')).status).toBe(400);
    expect(stripe.created).toEqual([]);
    const made = await (await session('&customer=cus_faux_abc')).json();
    expect(stripe.customerOf(made.id)).toBe('cus_faux_abc');
  });
});
