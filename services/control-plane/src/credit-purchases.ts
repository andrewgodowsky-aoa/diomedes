/**
 * Buying credits (Andrew, 2026-10-01, DIO-161 slice 1).
 *
 * An owner or an admin buys more credits for their business through Stripe Checkout. The price is the
 * Worker's own setting, CREDIT_PRICE_CENTS_PER_100 (whole cents for 100 credits): there is no default
 * here, and nothing but a quoted total for an asked amount ever leaves this service. A purchase is a
 * pending row (migration 015) until a verified Stripe event pays it, and the event that pays it
 * records the top-up in the same transaction (FundingService.resolveCreditPurchase).
 *
 * Two services, both over FundingService:
 * - CreditPurchaseService: quote, buy and read. It verifies membership and the owner or admin role,
 *   makes sure the business has its one Stripe customer (made at Stripe and stored before its first session), makes the
 *   pending row, asks Stripe for a Checkout Session by fetch, and answers where to pay.
 * - StripeWebhookService: the receiver for Stripe's events. It reads the raw body, verifies the
 *   Stripe-Signature header before it parses a byte, and answers 200 to anything it will not act on.
 *
 * Two database logins, kept apart on purpose. A top-up names a stored verified event (credit_topups.source_event_id
 * references webhook_inbox), and the event is stored, with the business's Stripe customer, by the Worker's login through
 * the PaymentLedger (src/postgres.ts, PostgresRepository). The funding login records the purchase and the top-up and
 * cannot write the inbox, so it cannot make bought credits by itself: a top-up needs an event the receiver stored.
 *
 * Stripe is called with fetch and the Worker secret STRIPE_SECRET_KEY; no SDK, and the signature check uses WebCrypto only. Neither
 * secret is ever logged, answered or stored.
 */
import { z } from 'zod';
import { canSeePurchasedUsage } from '../../../shared/workspaces.js';
import { CREDIT_PURCHASE_MAX_CREDITS, CREDIT_PURCHASE_MIN_CREDITS, CREDIT_PURCHASE_STEP, isAllowedCheckoutUrl, isPurchasableCredits,
  type CreditPurchaseStarted as CreditPurchaseAnswer, type CreditPurchaseStatus as CreditPurchaseRead, type CreditQuote } from '../../../shared/credit-purchases.js';
import { AccountError } from './errors.js';
import { readBytes } from './crypto.js';
import { FundingError, type FundingService } from './funding.js';
import type { AccountService } from './account-service.js';

/**
 * Credits are bought in whole steps of 100, at least one step and at most 100,000 in one purchase (shared with the
 * desktop, which steps through the same amounts). The cap is an engineering one, not an owner figure; at any price the
 * setting allows, the total is also held under what a single Stripe charge can be.
 */
export { CREDIT_PURCHASE_STEP, CREDIT_PURCHASE_MIN_CREDITS, CREDIT_PURCHASE_MAX_CREDITS };
/** Stripe's largest single USD charge, in cents ($999,999.99). */
export const STRIPE_MAX_CHARGE_CENTS = 99_999_999;
/** The price setting is whole cents for 100 credits. These bound a setting that could only be a typing slip. */
const PRICE_MIN_CENTS = 50;
const PRICE_MAX_CENTS = 1_000_000;
/** Stripe takes a Checkout Session expiry between 30 minutes and 24 hours out; this is just past the shortest. */
const CHECKOUT_LIFETIME_SECONDS = 35 * 60;
/** Stripe's signature timestamp may differ from this service's clock by this much, either way. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
const WEBHOOK_BODY_LIMIT = 262_144;
const STRIPE_CHECKOUT_SESSIONS = 'https://api.stripe.com/v1/checkout/sessions';
const STRIPE_CUSTOMERS = 'https://api.stripe.com/v1/customers';
const STRIPE_TIMEOUT_MS = 10_000;
/**
 * The customer call runs inside a database transaction that holds the business's lock (PaymentLedger.ensureCustomer), and
 * inTransaction (src/postgres.ts) gives a waiting purchase 3 seconds for a lock and an open transaction 6 seconds idle. So this
 * call is held under both: a slow Stripe fails this one purchase, which can be retried, and never another one's wait.
 */
export const STRIPE_CUSTOMER_TIMEOUT_MS = 2_500;

export const CREDIT_PURCHASES_UNAVAILABLE = 'Buying credits isn\'t available right now. Try again later.';
export const NOT_OWNER_OR_ADMIN = 'Only a Business owner or a Manager can buy credits for this business.';
export const PAYMENT_PAGE_UNAVAILABLE = 'The payment page couldn\'t be opened. Try again.';
const UNKNOWN_PURCHASE = 'That purchase was not found for this business.';
const THOUSANDS = (count: number) => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const BAD_CREDITS = `Credits are bought in steps of ${CREDIT_PURCHASE_STEP}, from ${CREDIT_PURCHASE_MIN_CREDITS} up to ${THOUSANDS(CREDIT_PURCHASE_MAX_CREDITS)}.`;
const TOO_MUCH = 'That is more than one purchase can cover. Try a smaller amount.';

/** What the Worker's environment says about buying. Parsed once per request; holds secrets, so it is never logged. */
export interface BillingSettings {
  /** Whole cents for 100 credits, or null when the setting is unset or unusable. */
  creditPriceCentsPer100: number | null;
  /** The rule a set but unusable price broke, or 'not-set'. Never the value. Null when the price is usable. */
  priceProblem: string | null;
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
}

const secretText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[\x21-\x7e]{8,200}$/.test(trimmed) ? trimmed : null;
};

/** CREDIT_PRICE_CENTS_PER_100, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, read as the Worker reads them. */
export function readBillingSettings(env: Record<string, unknown>): BillingSettings {
  const raw = env.CREDIT_PRICE_CENTS_PER_100;
  let price: number | null = null;
  let problem: string | null = null;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) problem = 'not-set';
  else {
    const value = typeof raw === 'string' ? (/^[1-9][0-9]{0,9}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) problem = 'not-a-whole-number';
    else if (value < PRICE_MIN_CENTS || value > PRICE_MAX_CENTS) problem = 'out-of-range';
    else price = value;
  }
  return { creditPriceCentsPer100: price, priceProblem: problem, stripeSecretKey: secretText(env.STRIPE_SECRET_KEY), stripeWebhookSecret: secretText(env.STRIPE_WEBHOOK_SECRET) };
}

/** The total for a whole number of credits, in cents. Credits must already be a whole multiple of the step. */
export function creditPriceCents(credits: number, centsPer100: number): number {
  return (credits / CREDIT_PURCHASE_STEP) * centsPer100;
}

/** A credit count from a query string (text) or a body (number): a whole multiple of 100 inside the bounds, or null. */
function wholeCredits(value: unknown): number | null {
  const credits = typeof value === 'string' ? (/^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : Number.NaN) : value;
  return isPurchasableCredits(credits) ? credits : null;
}

export const creditPurchaseInput = z.strictObject({ credits: z.number() });

/** A Stripe customer id, as Stripe makes them. */
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,128}$/;

/** What the receiver stores for one verified paid event: the event, its payload and the business's Stripe customer. */
export interface VerifiedPayment {
  eventId: string;
  /** From the verified event only. */
  customerId: string;
  /** The stored purchase's own business and tenant, never the event's metadata. */
  organizationId: string;
  tenantId: string;
  /** SHA-256 of the raw body that was verified, in hex. */
  payloadHash: string;
  eventType: string;
  /** The fields of the event this service acts on. Never the buyer's name, email or address. */
  payload: Record<string, unknown>;
}

/**
 * The payment ledger: one reusable Stripe customer per business, and the verified events its payments arrive in.
 * Both rows live in migration 002's billing_customers and webhook_inbox and are written by the Worker's login
 * (PostgresRepository), the receiver path, never by the funding login.
 */
export interface PaymentLedger {
  /** The business's stored Stripe customer, or null when it has none yet. Our own row, nothing else. */
  storedCustomer(ref: { tenantId: string; organizationId: string }): Promise<string | null>;
  /**
   * The business's one Stripe customer, made before its first Checkout Session. Under a lock held per business, the same
   * lock a paid event takes, it reads the stored customer and answers it; when there is none it runs `make` (which asks
   * Stripe for a customer and answers the id Stripe gave) and stores that id in the same locked step. So two first
   * purchases made at once share one customer: the second waits, then finds the first's row. An id is trusted only from
   * `make`'s own Stripe answer, checked to be a Stripe customer id, or from our stored row, never from a request. When `make`
   * throws nothing is stored and the error reaches the caller.
   */
  ensureCustomer(ref: { tenantId: string; organizationId: string }, make: () => Promise<string>): Promise<string>;
  /**
   * Store a verified paid event, and the business's customer when it has none yet, in one transaction. Idempotent by
   * event id. A 409 AccountError when the event is already stored with other contents, when the customer belongs to
   * another business, or when the business already has a different customer.
   */
  recordVerifiedPayment(input: VerifiedPayment): Promise<{ inserted: boolean }>;
}

export type { CreditQuote, CreditPurchaseAnswer, CreditPurchaseRead };

export interface CreditPurchaseOptions {
  settings: BillingSettings;
  /** Where a business's one Stripe customer is read, or made and stored the first time, so every purchase reuses it. */
  ledger: Pick<PaymentLedger, 'ensureCustomer'>;
  /** The transport to Stripe. Tests and the faux cloud pass their own; the Worker uses the global fetch. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  newId?: () => string;
  /**
   * Hand a client the faux cloud's own local checkout page, on the origin the buyer came from, as well as Stripe's.
   * Only the faux cloud sets it; the Worker never does, so only Stripe's own hosted checkout ever leaves it.
   */
  localCheckout?: boolean;
}

const checkoutSessionSchema = z.object({ id: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/), url: z.string() });
const customerSchema = z.object({ id: z.string().regex(CUSTOMER_ID) });

/** Stripe would not make the business's customer. Kept apart from a database failure, which is not this and is not hidden. */
class CustomerNotMade extends Error {}

type BuyingFunding = Pick<FundingService, 'startCreditPurchase' | 'attachCheckoutSession' | 'failCreditPurchase' | 'readCreditPurchase'>;

export class CreditPurchaseService {
  private readonly now: () => number;
  private readonly send: typeof globalThis.fetch;
  private readonly newId: () => string;

  constructor(private readonly accounts: Pick<AccountService, 'membership'>, private readonly funding: BuyingFunding, private readonly options: CreditPurchaseOptions) {
    this.now = options.now ?? Date.now;
    this.send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.newId = options.newId ?? (() => `cpurch_${crypto.randomUUID()}`);
  }

  /** Verified membership, and then the rule that only an owner or an admin buys. */
  private async buyer(token: string, organizationId: string) {
    const snapshot = await this.accounts.membership(token, organizationId);
    if (!canSeePurchasedUsage(snapshot.membership)) throw new AccountError(403, NOT_OWNER_OR_ADMIN, 'not_owner_or_admin');
    return snapshot;
  }

  /** The price, or a 503 that says nothing but that buying is not available; the Worker's log says which rule. */
  private price(): number {
    const { creditPriceCentsPer100, priceProblem } = this.options.settings;
    if (creditPriceCentsPer100 === null) {
      console.error(JSON.stringify({ event: 'credit-purchases-price-unavailable', setting: 'CREDIT_PRICE_CENTS_PER_100', rule: priceProblem ?? 'not-set' }));
      throw new AccountError(503, CREDIT_PURCHASES_UNAVAILABLE);
    }
    return creditPriceCentsPer100;
  }

  private total(credits: number, price: number): number {
    const cents = creditPriceCents(credits, price);
    if (!Number.isSafeInteger(cents) || cents < 1 || cents > STRIPE_MAX_CHARGE_CENTS) throw new AccountError(422, TOO_MUCH);
    return cents;
  }

  /** What an amount of credits would cost. Writes nothing and asks Stripe nothing. */
  async quote(token: string, organizationId: string, asked: unknown): Promise<CreditQuote> {
    await this.buyer(token, organizationId);
    const credits = wholeCredits(asked);
    if (credits === null) throw new AccountError(422, BAD_CREDITS);
    return { credits, amountCents: this.total(credits, this.price()), currency: 'usd' };
  }

  /**
   * Make the pending purchase and a Checkout Session for it, and answer where to pay. The amount is the
   * server's own: the request names credits and nothing else. A session Stripe could not make leaves
   * the purchase failed, not pending, so it never waits for a payment that cannot come.
   */
  async create(token: string, organizationId: string, input: z.infer<typeof creditPurchaseInput>, returnBase: string): Promise<CreditPurchaseAnswer> {
    const snapshot = await this.buyer(token, organizationId);
    const credits = wholeCredits(input.credits);
    if (credits === null) throw new AccountError(422, BAD_CREDITS);
    const amountCents = this.total(credits, this.price());
    const { stripeSecretKey } = this.options.settings;
    if (stripeSecretKey === null) {
      console.error(JSON.stringify({ event: 'credit-purchases-stripe-unavailable', setting: 'STRIPE_SECRET_KEY', rule: 'not-set' }));
      throw new AccountError(503, CREDIT_PURCHASES_UNAVAILABLE);
    }
    const ref = { tenantId: snapshot.organization.tenantId, organizationId: snapshot.organization.id, purchaseId: this.newId() };
    // The business's one customer, before anything else is written, so a customer that could not be read or made leaves no
    // purchase behind. From our own stored row or Stripe's own answer to our own request: never from a request to us.
    let customerId: string;
    try {
      customerId = await this.options.ledger.ensureCustomer({ tenantId: ref.tenantId, organizationId: ref.organizationId },
        () => this.createCustomer(stripeSecretKey, ref));
    } catch (error) {
      if (error instanceof CustomerNotMade) throw new AccountError(503, PAYMENT_PAGE_UNAVAILABLE);
      throw error;
    }
    await this.funding.startCreditPurchase({ ...ref, personId: snapshot.person.id, credits, amountCents });
    const session = await this.checkoutSession(stripeSecretKey, ref, credits, amountCents, returnBase, customerId);
    if (session === null) {
      await this.funding.failCreditPurchase(ref).catch(() => undefined);
      throw new AccountError(503, PAYMENT_PAGE_UNAVAILABLE);
    }
    try {
      await this.funding.attachCheckoutSession(ref, session.id);
    } catch (error) {
      // Stripe made a session this purchase could not keep. It stays pending and unpayable here: a paid event
      // would find no session on it. The log carries the ids to repair it by hand.
      console.error(JSON.stringify({ event: 'credit-purchase-session-not-kept', purchaseId: ref.purchaseId, sessionId: session.id,
        reason: error instanceof FundingError ? error.code : 'unavailable' }));
      throw new AccountError(503, PAYMENT_PAGE_UNAVAILABLE);
    }
    return { purchaseId: ref.purchaseId, checkoutUrl: session.url, credits, amountCents };
  }

  /**
   * POST /v1/customers: the business's Stripe customer, carrying our business and tenant ids as metadata and nothing about
   * the buyer. The idempotency key is derived from the tenant and the business alone, so a retry (a commit that failed after
   * Stripe answered, say) gets the same customer back from Stripe instead of a second one. Throws CustomerNotMade when
   * Stripe refuses, cannot be reached or answers something that is not a customer.
   */
  private async createCustomer(secretKey: string, ref: { tenantId: string; organizationId: string; purchaseId: string }): Promise<string> {
    const form = new URLSearchParams([['metadata[organization_id]', ref.organizationId], ['metadata[tenant_id]', ref.tenantId]]);
    const key = `nectovia-customer-${await sha256Hex(encoder.encode(JSON.stringify(['stripe-customer', ref.tenantId, ref.organizationId])))}`;
    let answer: unknown;
    try {
      const response = await this.send(STRIPE_CUSTOMERS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': key, Accept: 'application/json' },
        body: form.toString(),
        signal: AbortSignal.timeout(STRIPE_CUSTOMER_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error(JSON.stringify({ event: 'credit-purchase-customer-refused', purchaseId: ref.purchaseId, status: response.status }));
        throw new CustomerNotMade();
      }
      answer = await response.json();
    } catch (error) {
      if (!(error instanceof CustomerNotMade)) console.error(JSON.stringify({ event: 'credit-purchase-customer-unreachable', purchaseId: ref.purchaseId }));
      throw new CustomerNotMade();
    }
    const parsed = customerSchema.safeParse(answer);
    if (!parsed.success) {
      console.error(JSON.stringify({ event: 'credit-purchase-customer-unreadable', purchaseId: ref.purchaseId }));
      throw new CustomerNotMade();
    }
    return parsed.data.id;
  }

  private async checkoutSession(secretKey: string, ref: { tenantId: string; organizationId: string; purchaseId: string }, credits: number, amountCents: number, returnBase: string,
    customerId: string) {
    const back = `${returnBase}/billing/return?purchase=${ref.purchaseId}`;
    const form = new URLSearchParams([
      ['mode', 'payment'],
      ['line_items[0][quantity]', '1'],
      ['line_items[0][price_data][currency]', 'usd'],
      ['line_items[0][price_data][unit_amount]', String(amountCents)],
      ['line_items[0][price_data][product_data][name]', `${THOUSANDS(credits)} Nectovia credits`],
      ['client_reference_id', ref.purchaseId],
      ['metadata[purchase_id]', ref.purchaseId],
      ['metadata[organization_id]', ref.organizationId],
      ['metadata[tenant_id]', ref.tenantId],
      // One reusable customer per business, made and stored before the session (ensureCustomer): every session names it, so
      // the paid event of any of the business's purchases names that same customer.
      ['customer', customerId],
      ['expires_at', String(Math.floor(this.now() / 1000) + CHECKOUT_LIFETIME_SECONDS)],
      ['success_url', back],
      ['cancel_url', `${back}&canceled=1`],
    ]);
    try {
      const response = await this.send(STRIPE_CHECKOUT_SESSIONS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': ref.purchaseId, Accept: 'application/json' },
        body: form.toString(),
        signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error(JSON.stringify({ event: 'credit-purchase-checkout-refused', purchaseId: ref.purchaseId, status: response.status }));
        return null;
      }
      const parsed = checkoutSessionSchema.safeParse(await response.json());
      const url = parsed.success && isAllowedCheckoutUrl(parsed.data.url, this.options.localCheckout ? returnBase : null) ? parsed.data.url : null;
      if (!parsed.success || url === null) {
        console.error(JSON.stringify({ event: 'credit-purchase-checkout-unreadable', purchaseId: ref.purchaseId }));
        return null;
      }
      return { id: parsed.data.id, url };
    } catch {
      console.error(JSON.stringify({ event: 'credit-purchase-checkout-unreachable', purchaseId: ref.purchaseId }));
      return null;
    }
  }

  /** A purchase, for the business that made it, as an owner or an admin. */
  async read(token: string, organizationId: string, purchaseId: string): Promise<CreditPurchaseRead> {
    const snapshot = await this.buyer(token, organizationId);
    let row;
    try {
      row = await this.funding.readCreditPurchase({ tenantId: snapshot.organization.tenantId, organizationId: snapshot.organization.id, purchaseId });
    } catch (error) {
      if (error instanceof FundingError && error.status === 404) throw new AccountError(404, UNKNOWN_PURCHASE, 'unknown_purchase');
      throw error;
    }
    return { purchaseId: row.purchaseId, credits: row.credits, amountCents: row.amountCents, state: row.state };
  }
}

// --- Stripe's signature ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** Equal-length byte strings, compared without stopping at the first difference. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

/**
 * Stripe-Signature: `t=<seconds>,v1=<hex>[,v1=<hex>][,v0=<hex>]`. The signed text is "<t>.<raw body>",
 * HMAC-SHA256 under the endpoint's signing secret. Any one v1 may match; v0 is Stripe's test scheme and
 * is never accepted. The timestamp must be within the tolerance of this service's own clock, either way.
 * The raw bytes are checked, never a parsed and re-serialized body.
 */
export async function verifyStripeSignature(rawBody: string | Uint8Array, header: string | null, secret: string, nowMs: number,
  toleranceSeconds = STRIPE_SIGNATURE_TOLERANCE_SECONDS): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp: string | null = null;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't') {
      if (timestamp !== null) return false;
      timestamp = value;
    } else if (key === 'v1') candidates.push(value);
  }
  if (timestamp === null || !/^[0-9]{1,12}$/.test(timestamp)) return false;
  const signatures = candidates.filter((value) => /^[0-9a-f]{64}$/.test(value));
  if (signatures.length === 0) return false;
  const body = typeof rawBody === 'string' ? encoder.encode(rawBody) : rawBody;
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
  let matched = false;
  for (const signature of signatures) if (sameBytes(expected, hexBytes(signature))) matched = true;
  return matched && Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) <= toleranceSeconds;
}

// --- the receiver -----------------------------------------------------------------------------------

const eventSchema = z.object({ id: z.string().regex(/^evt_[A-Za-z0-9_]{1,128}$/), type: z.string().min(1).max(200), data: z.object({ object: z.unknown() }) });
const sessionSchema = z.object({
  id: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/),
  payment_status: z.string().nullish(),
  amount_total: z.number().nullish(),
  currency: z.string().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  /** The customer's id. Stripe sends the id (not an expanded object) in an event, and null for a guest. */
  customer: z.unknown().optional(),
  client_reference_id: z.string().nullish(),
});

export interface WebhookAnswer { status: number; body: Record<string, unknown> }

export interface StripeWebhookOptions {
  settings: BillingSettings;
  /** Where a verified paid event and its customer are stored before the purchase is paid. */
  ledger: Pick<PaymentLedger, 'recordVerifiedPayment'>;
  now?: () => number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class StripeWebhookService {
  private readonly now: () => number;

  constructor(private readonly funding: Pick<FundingService, 'previewCreditPurchase' | 'resolveCreditPurchase'>, private readonly options: StripeWebhookOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * A paid event, before the purchase is paid: ask the funding service whether this event could pay its purchase (nothing
   * is written), then store the verified event and the business's customer in the ledger, against the stored purchase's own
   * business and tenant. False when the event pays nothing, so nothing is stored for it.
   */
  private async storePayment(event: z.infer<typeof eventSchema>, object: z.infer<typeof sessionSchema>, raw: Uint8Array): Promise<boolean> {
    const ask = {
      sessionId: object.id, purchaseId: object.metadata?.purchase_id ?? null, organizationId: object.metadata?.organization_id ?? null,
      tenantId: object.metadata?.tenant_id ?? null, amountTotal: object.amount_total ?? null, currency: object.currency ?? null,
    };
    const payable = await this.funding.previewCreditPurchase(ask);
    if (payable.outcome === 'ignored') {
      if (payable.reason === 'amount_mismatch' || payable.reason === 'metadata_mismatch')
        console.error(JSON.stringify({ event: 'credit-purchase-mismatch', reason: payable.reason, purchaseId: payable.purchaseId, eventId: event.id }));
      return false;
    }
    // The customer comes from this verified event, and nothing else.
    const customerId = typeof object.customer === 'string' && CUSTOMER_ID.test(object.customer) ? object.customer : null;
    if (customerId === null) {
      console.error(JSON.stringify({ event: 'credit-purchase-no-customer', purchaseId: payable.purchaseId, eventId: event.id }));
      return false;
    }
    await this.options.ledger.recordVerifiedPayment({
      eventId: event.id, customerId, organizationId: payable.organizationId, tenantId: payable.tenantId,
      payloadHash: await sha256Hex(raw), eventType: event.type,
      payload: { id: event.id, type: event.type, data: { object: {
        id: object.id, payment_status: object.payment_status ?? null, amount_total: object.amount_total ?? null, currency: object.currency ?? null,
        customer: customerId, client_reference_id: object.client_reference_id ?? null, metadata: object.metadata ?? null } } },
    });
    return true;
  }

  /**
   * One Stripe event. 400 for a body whose signature does not verify, or that is not an event, with nothing
   * recorded. 503 when the signing secret is not set or the write could not be made, so Stripe sends it again.
   * 200 for everything else, including an event this service does not act on and one it finds already applied.
   */
  async handle(request: Request): Promise<WebhookAnswer> {
    const secret = this.options.settings.stripeWebhookSecret;
    if (secret === null) {
      console.error(JSON.stringify({ event: 'credit-purchases-webhook-unavailable', setting: 'STRIPE_WEBHOOK_SECRET', rule: 'not-set' }));
      return { status: 503, body: { error: 'Payments are not set up here yet.' } };
    }
    let raw: Uint8Array;
    try {
      raw = await readBytes(request, WEBHOOK_BODY_LIMIT);
    } catch (error) {
      if (error instanceof RangeError) return { status: 413, body: { error: 'The event is too large.' } };
      return { status: 400, body: { error: 'A readable event is required.' } };
    }
    if (!(await verifyStripeSignature(raw, request.headers.get('stripe-signature'), secret, this.now())))
      return { status: 400, body: { error: 'The signature could not be verified.' } };
    let event: z.infer<typeof eventSchema>;
    try {
      const parsed = eventSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
      if (!parsed.success) return { status: 400, body: { error: 'That is not an event.' } };
      event = parsed.data;
    } catch {
      return { status: 400, body: { error: 'That is not an event.' } };
    }
    const received = { status: 200, body: { received: true } };
    const kind = KINDS[event.type];
    if (!kind) return received;
    const session = sessionSchema.safeParse(event.data.object);
    if (!session.success) return received;
    const object = session.data;
    // A completed session that is not paid yet is waiting on a delayed payment; its own event settles it.
    if (kind === 'paid' && object.payment_status !== 'paid') return received;
    try {
      if (kind === 'paid' && !(await this.storePayment(event, object, raw))) return received;
      const result = await this.funding.resolveCreditPurchase({
        kind, sessionId: object.id, eventId: event.id,
        purchaseId: object.metadata?.purchase_id ?? null, organizationId: object.metadata?.organization_id ?? null, tenantId: object.metadata?.tenant_id ?? null,
        amountTotal: object.amount_total ?? null, currency: object.currency ?? null,
      });
      if (result.outcome === 'ignored' && (result.reason === 'amount_mismatch' || result.reason === 'metadata_mismatch'))
        console.error(JSON.stringify({ event: 'credit-purchase-mismatch', reason: result.reason, purchaseId: result.purchaseId, eventId: event.id }));
    } catch (error) {
      if (error instanceof FundingError) {
        // A refusal a retry will not change. Answering 200 stops Stripe from sending it again; the log names it.
        console.error(JSON.stringify({ event: 'credit-purchase-refused', code: error.code, eventId: event.id }));
        return received;
      }
      if (error instanceof AccountError && error.status === 409) {
        // The ledger refused: the event is stored with other contents, or the customer is not this business's. A retry
        // will not change it, and nothing was paid. The log carries the event id to repair it by hand.
        console.error(JSON.stringify({ event: 'credit-purchase-ledger-refused', code: error.code ?? 'conflict', eventId: event.id }));
        return received;
      }
      console.error(JSON.stringify({ event: 'credit-purchase-webhook-failed', eventId: event.id }));
      return { status: 503, body: { error: 'The event could not be recorded. Try again.' } };
    }
    return received;
  }
}

const KINDS: Record<string, 'paid' | 'expired' | 'failed' | undefined> = Object.assign(Object.create(null), {
  'checkout.session.completed': 'paid',
  'checkout.session.async_payment_succeeded': 'paid',
  'checkout.session.async_payment_failed': 'failed',
  'checkout.session.expired': 'expired',
});

// --- the page Stripe sends the buyer back to ----------------------------------------------------------

/** Plain text and nothing from the request: the buyer goes back to Nectovia, which shows what happened. */
export function returnPage(canceled: boolean): { status: number; headers: Record<string, string>; body: string } {
  const line = canceled ? 'Go back to Nectovia.' : 'Go back to Nectovia. Your credits show up there once the payment clears.';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nectovia</title>`
    + `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8ecf4;font:16px/1.5 system-ui,sans-serif}p{max-width:28rem;margin:0 16px}</style>`
    + `</head><body><p>${line}</p></body></html>`;
  return {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
    body,
  };
}
