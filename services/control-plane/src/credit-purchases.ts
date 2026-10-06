/**
 * Buying credits (Andrew, 2026-10-01, DIO-161 slice 1; rates and the test and live guard from the 2026-10-05 billing foundation).
 *
 * An owner or an admin buys more credits for their business through Stripe Checkout. What a step of credits costs is the
 * Worker's own setting, written "cents:credits" per step: CREDIT_RATE_PLAN for a business on a paid plan and CREDIT_RATE_FREE for
 * one without. There is no default here, and nothing but a quoted total for an asked amount ever leaves this service. The server
 * picks the rate from the paying business's own plan grants at the moment the purchase is made and stores it, with the credits and
 * the price, on the purchase row; the event that pays the purchase credits exactly what the row says and never works a rate out
 * again. A purchase is a pending row (migration 015) until a verified Stripe event pays it, and the event that pays it records the
 * top-up in the same transaction (FundingService.resolveCreditPurchase).
 *
 * Two services, both over FundingService:
 * - CreditPurchaseService: quote, buy and read. It verifies membership and the owner or admin role,
 *   makes sure the business has its one Stripe customer (made at Stripe and stored before its first session), makes the
 *   pending row, asks Stripe for a Checkout Session by fetch, and answers where to pay.
 * - StripeWebhookService: the receiver for Stripe's events. It reads the raw body, verifies the
 *   Stripe-Signature header before it parses a byte, refuses an event from the other mode, and hands a verified event to
 *   the router (src/stripe-events.ts), which answers 200 to anything it will not act on.
 *
 * Test and live. Nothing live runs unless STRIPE_LIVE=1 is set on purpose. Without it, a secret key that is not an sk_test_ or
 * rk_test_ key is not used, and an event with livemode true is refused before anything is stored. With it, only an sk_live_ or
 * rk_live_ key is used, and an event with livemode false is refused. Every Stripe request names its API version.
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
import { AGENT_FEATURE } from '../../../shared/access.js';
import { canSeePurchasedUsage } from '../../../shared/workspaces.js';
import { CREDIT_PURCHASE_MAX_CREDITS, isAllowedCheckoutUrl,
  type CreditPurchaseStarted as CreditPurchaseAnswer, type CreditPurchaseStatus as CreditPurchaseRead, type CreditQuote } from '../../../shared/credit-purchases.js';
import { AccountError } from './errors.js';
import { readBytes } from './crypto.js';
import { FundingError, type FundingService } from './funding.js';
import { grantState, type CommercialRepository } from './commercial.js';
import { StripeEventRouter, type StripeEvent, type StripeEventContext, type StripeEventHandler, type StripeMode } from './stripe-events.js';
import type { AccountService } from './account-service.js';

export type { StripeMode };
/** Credits are bought in whole steps, and at most this many in one purchase (shared with the desktop). An engineering cap, not an owner figure. */
export { CREDIT_PURCHASE_MAX_CREDITS };
/** Stripe's largest single USD charge, in cents ($999,999.99). */
export const STRIPE_MAX_CHARGE_CENTS = 99_999_999;
/**
 * The Stripe API version every request is pinned to, so a change of the account's default version never changes what this service
 * sends or reads. Raising it is a deliberate edit, tested against Stripe's test mode (the faux Stripe refuses a request without it).
 */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';
/** A rate setting is cents for one step. These bound a setting that could only be a typing slip. */
const RATE_CENTS_MIN = 50;
const RATE_CENTS_MAX = 1_000_000;
const RATE_CREDITS_MIN = 1;
const RATE_CREDITS_MAX = 10_000;
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
const TOO_MUCH = 'That is more than one purchase can cover. Try a smaller amount.';

// --- settings ---------------------------------------------------------------------------------------

/** What a step of credits costs: `credits` credits for `cents` cents. One step is the least a purchase can be, and a purchase is whole steps. */
export interface CreditRate { cents: number; credits: number }
export type RateKind = 'plan' | 'free';

/** What the Worker's environment says about buying. Parsed once per request; holds secrets, so it is never logged. */
export interface BillingSettings {
  /** Test unless STRIPE_LIVE=1 was set on purpose. */
  mode: StripeMode;
  /** CREDIT_RATE_PLAN: the rate for a business with an active plan grant. Null when the setting is unset or unusable. */
  creditRatePlan: CreditRate | null;
  /** CREDIT_RATE_FREE: the rate for a business without one. */
  creditRateFree: CreditRate | null;
  /** The rule a set but unusable rate broke, or 'not-set'. Never the value. Null when the rate is usable. */
  rateProblems: Record<RateKind, string | null>;
  /** The secret key, only when it belongs to the mode: sk_test_ or rk_test_ in test, sk_live_ or rk_live_ in live. */
  stripeSecretKey: string | null;
  /** The rule a set but refused key broke, or 'not-set'. Never the key. Null when the key is usable. */
  keyProblem: string | null;
  stripeWebhookSecret: string | null;
  /** The secret this endpoint used before a rotation. A signature valid under either secret is accepted. */
  stripeWebhookSecretPrevious: string | null;
}

const secretText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[\x21-\x7e]{8,200}$/.test(trimmed) ? trimmed : null;
};

/** "cents:credits": whole numbers, no sign, no decimals, inside the bounds. */
export function parseCreditRate(raw: unknown): { rate: CreditRate | null; problem: string | null } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { rate: null, problem: 'not-set' };
  const parts = typeof raw === 'string' ? /^([1-9][0-9]{0,9}):([1-9][0-9]{0,9})$/.exec(raw.trim()) : null;
  if (parts === null) return { rate: null, problem: 'not-cents-colon-credits' };
  const cents = Number(parts[1]);
  const credits = Number(parts[2]);
  if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(credits) || cents < RATE_CENTS_MIN || cents > RATE_CENTS_MAX
    || credits < RATE_CREDITS_MIN || credits > RATE_CREDITS_MAX) return { rate: null, problem: 'out-of-range' };
  return { rate: { cents, credits }, problem: null };
}

/** The mode a Worker is in: STRIPE_LIVE=1 and nothing else is live. */
export const stripeModeOf = (env: Record<string, unknown>): StripeMode => (env.STRIPE_LIVE === '1' || env.STRIPE_LIVE === 1 ? 'live' : 'test');

/** CREDIT_RATE_PLAN, CREDIT_RATE_FREE, STRIPE_LIVE, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_WEBHOOK_SECRET_PREVIOUS, read as the Worker reads them. */
export function readBillingSettings(env: Record<string, unknown>): BillingSettings {
  const mode = stripeModeOf(env);
  const plan = parseCreditRate(env.CREDIT_RATE_PLAN);
  const free = parseCreditRate(env.CREDIT_RATE_FREE);
  const key = secretText(env.STRIPE_SECRET_KEY);
  const belongs = mode === 'live' ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/;
  // A key that is not for this mode is not used, and the guard says why without saying the key: a live key without STRIPE_LIVE=1
  // never reaches Stripe, and a test key with it never does either.
  const keyProblem = key === null ? 'not-set' : belongs.test(key) ? null : mode === 'live' ? 'not-a-live-key' : 'live-key-needs-stripe-live';
  return {
    mode,
    creditRatePlan: plan.rate,
    creditRateFree: free.rate,
    rateProblems: { plan: plan.problem, free: free.problem },
    stripeSecretKey: keyProblem === null ? key : null,
    keyProblem,
    stripeWebhookSecret: secretText(env.STRIPE_WEBHOOK_SECRET),
    stripeWebhookSecretPrevious: secretText(env.STRIPE_WEBHOOK_SECRET_PREVIOUS),
  };
}

/** Whole steps at a rate: the credits, and the price in cents, in integers. Throws a 422 for a purchase no single charge can cover. */
export function creditStepsCost(steps: number, rate: CreditRate): { credits: number; amountCents: number } {
  const credits = steps * rate.credits;
  const amountCents = steps * rate.cents;
  if (!Number.isSafeInteger(credits) || !Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > STRIPE_MAX_CHARGE_CENTS) throw new AccountError(422, TOO_MUCH);
  return { credits, amountCents };
}

/** The most credits one purchase can be at a rate: whole steps, held under the cap. */
export const maxCreditsAt = (rate: CreditRate): number => Math.floor(CREDIT_PURCHASE_MAX_CREDITS / rate.credits) * rate.credits;

const badCredits = (rate: CreditRate) =>
  new AccountError(422, `Credits are bought in steps of ${THOUSANDS(rate.credits)}, from ${THOUSANDS(rate.credits)} up to ${THOUSANDS(maxCreditsAt(rate))}.`);

/**
 * How many whole steps an asked amount is: a credit count from a query string (text) or a body (number) that is a whole multiple of the
 * rate's step, inside the bounds. No amount asked is one step, which is how a screen learns the step before it asks for more.
 */
function stepsAsked(asked: unknown, rate: CreditRate): number {
  if (asked === undefined || asked === null) return 1;
  const credits = typeof asked === 'string' ? (/^[1-9][0-9]{0,9}$/.test(asked) ? Number(asked) : Number.NaN) : asked;
  if (typeof credits !== 'number' || !Number.isSafeInteger(credits) || credits < rate.credits || credits > CREDIT_PURCHASE_MAX_CREDITS || credits % rate.credits !== 0)
    throw badCredits(rate);
  return credits / rate.credits;
}

export const creditPurchaseInput = z.strictObject({ credits: z.number() });

/** A Stripe customer id, as Stripe makes them. */
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,128}$/;

// --- the plan the payer holds -------------------------------------------------------------------------

/** Whether a business holds an active plan grant, which is what picks its rate. */
export interface PlanLookup {
  hasActivePlan(ref: { tenantId: string; organizationId: string }, atMs: number): Promise<boolean>;
}

/**
 * A plan grant is one with the managed-inference or the nectovia-agent feature, valid now, however it was issued. Read from the
 * business's own grants on the Worker login (feature_grants is granted to cp_runtime), never from a request.
 */
export class GrantPlanLookup implements PlanLookup {
  constructor(private readonly repository: CommercialRepository) {}

  async hasActivePlan(ref: { tenantId: string; organizationId: string }, atMs: number): Promise<boolean> {
    const grants = await this.repository.transaction((tx) => tx.grants(ref.organizationId));
    return grants.some((grant) => grant.tenantId === ref.tenantId && grantState(grant, atMs) === 'active'
      && (grant.features.includes('managed-inference') || grant.features.includes(AGENT_FEATURE)));
  }
}

// --- the payment ledger -------------------------------------------------------------------------------

/** A business in one Stripe environment: it has one customer in each. */
export interface BillingRef { tenantId: string; organizationId: string; environment: StripeMode }

/** What the receiver stores for one verified paid event: the event, its payload and the business's Stripe customer. */
export interface VerifiedPayment {
  environment: StripeMode;
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

/** A verified event of a type nothing handles, stored and marked ignored. */
export interface IgnoredEvent {
  environment: StripeMode;
  eventId: string;
  /** The customer the event names, when it names one in Stripe's own form. It attributes the row only if it is a customer of ours. */
  customerId: string | null;
  payloadHash: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * The payment ledger: one reusable Stripe customer per business in each environment, and the verified events its payments arrive in.
 * Both rows live in migration 002's billing_customers and webhook_inbox and are written by the Worker's login
 * (PostgresRepository), the receiver path, never by the funding login.
 */
export interface PaymentLedger {
  /** The business's stored Stripe customer in this environment, or null when it has none yet. Our own row, nothing else. */
  storedCustomer(ref: BillingRef): Promise<string | null>;
  /**
   * The business's one Stripe customer in this environment, made before its first Checkout Session. Under a lock held per business, the same
   * lock a paid event takes, it reads the stored customer and answers it; when there is none it runs `make` (which asks
   * Stripe for a customer and answers the id Stripe gave) and stores that id in the same locked step. So two first
   * purchases made at once share one customer: the second waits, then finds the first's row. An id is trusted only from
   * `make`'s own Stripe answer, checked to be a Stripe customer id, or from our stored row, never from a request. When `make`
   * throws nothing is stored and the error reaches the caller.
   */
  ensureCustomer(ref: BillingRef, make: () => Promise<string>): Promise<string>;
  /**
   * Store a verified paid event, and the business's customer when it has none yet, in one transaction. Idempotent by
   * event id. A 409 AccountError when the event is already stored with other contents, when the customer belongs to
   * another business, or when the business already has a different customer in this environment.
   */
  recordVerifiedPayment(input: VerifiedPayment): Promise<{ inserted: boolean }>;
  /**
   * Store a verified event of a type nothing handles, marked ignored. The business comes from our own customer row for the customer
   * the event names, or the row has none. Idempotent by event id; a 409 AccountError when the event is already stored with other contents.
   */
  recordIgnoredEvent(input: IgnoredEvent): Promise<{ inserted: boolean }>;
  /** Move a stored event out of pending once it has been applied (processed) or refused for good (quarantined). False when it was not pending. */
  markEvent(ref: { environment: StripeMode; eventId: string }, state: 'processed' | 'quarantined'): Promise<boolean>;
}

export type { CreditQuote, CreditPurchaseAnswer, CreditPurchaseRead };

export interface CreditPurchaseOptions {
  settings: BillingSettings;
  /** Where a business's one Stripe customer is read, or made and stored the first time, so every purchase reuses it. */
  ledger: Pick<PaymentLedger, 'ensureCustomer'>;
  /** The business's plan grants, which pick the rate. */
  plans: PlanLookup;
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

/** The headers every Stripe request carries: the key, the form encoding, the idempotency key and the pinned API version. */
export function stripeRequestHeaders(secretKey: string, idempotencyKey: string): Record<string, string> {
  return { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idempotencyKey,
    'Stripe-Version': STRIPE_API_VERSION, Accept: 'application/json' };
}

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

  /**
   * The rate this business buys at right now: the plan rate while it holds an active plan grant, otherwise the free rate. A 503 that says
   * nothing but that buying is not available when the setting that rate needs is not usable; the Worker's log says which rule.
   */
  private async rate(ref: { tenantId: string; organizationId: string }): Promise<CreditRate> {
    const plan = await this.options.plans.hasActivePlan(ref, this.now());
    const kind: RateKind = plan ? 'plan' : 'free';
    const rate = plan ? this.options.settings.creditRatePlan : this.options.settings.creditRateFree;
    if (rate === null) {
      console.error(JSON.stringify({ event: 'credit-purchases-rate-unavailable', setting: plan ? 'CREDIT_RATE_PLAN' : 'CREDIT_RATE_FREE', rule: this.options.settings.rateProblems[kind] ?? 'not-set' }));
      throw new AccountError(503, CREDIT_PURCHASES_UNAVAILABLE);
    }
    return rate;
  }

  /** What an amount of credits would cost, and the step it is bought in. Writes nothing and asks Stripe nothing. */
  async quote(token: string, organizationId: string, asked: unknown): Promise<CreditQuote> {
    const snapshot = await this.buyer(token, organizationId);
    const rate = await this.rate({ tenantId: snapshot.organization.tenantId, organizationId: snapshot.organization.id });
    const steps = stepsAsked(asked, rate);
    const { credits, amountCents } = creditStepsCost(steps, rate);
    return { credits, amountCents, currency: 'usd', steps, stepCredits: rate.credits, stepCents: rate.cents };
  }

  /**
   * Make the pending purchase and a Checkout Session for it, and answer where to pay. The amount is the
   * server's own: the request names credits and nothing else. The rate it was priced at is chosen here and stored on the row, so a
   * plan that lapses before the payment changes nothing: the paid event credits what the row says. A session Stripe could not make
   * leaves the purchase failed, not pending, so it never waits for a payment that cannot come.
   */
  async create(token: string, organizationId: string, input: z.infer<typeof creditPurchaseInput>, returnBase: string): Promise<CreditPurchaseAnswer> {
    const snapshot = await this.buyer(token, organizationId);
    const rate = await this.rate({ tenantId: snapshot.organization.tenantId, organizationId: snapshot.organization.id });
    const steps = stepsAsked(input.credits, rate);
    const { credits, amountCents } = creditStepsCost(steps, rate);
    const { stripeSecretKey, keyProblem, mode } = this.options.settings;
    if (stripeSecretKey === null) {
      console.error(JSON.stringify({ event: 'credit-purchases-stripe-unavailable', setting: 'STRIPE_SECRET_KEY', rule: keyProblem ?? 'not-set' }));
      throw new AccountError(503, CREDIT_PURCHASES_UNAVAILABLE);
    }
    const ref = { tenantId: snapshot.organization.tenantId, organizationId: snapshot.organization.id, purchaseId: this.newId() };
    // The business's one customer, before anything else is written, so a customer that could not be read or made leaves no
    // purchase behind. From our own stored row or Stripe's own answer to our own request: never from a request to us.
    let customerId: string;
    try {
      customerId = await this.options.ledger.ensureCustomer({ tenantId: ref.tenantId, organizationId: ref.organizationId, environment: mode },
        () => this.createCustomer(stripeSecretKey, ref));
    } catch (error) {
      if (error instanceof CustomerNotMade) throw new AccountError(503, PAYMENT_PAGE_UNAVAILABLE);
      throw error;
    }
    await this.funding.startCreditPurchase({ ...ref, personId: snapshot.person.id, credits, amountCents, rateCents: rate.cents, rateCredits: rate.credits, environment: mode });
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
        headers: stripeRequestHeaders(secretKey, key),
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
        headers: stripeRequestHeaders(secretKey, ref.purchaseId),
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

/** `livemode` is required, never defaulted: an event that does not say which mode it came from is not an event this service will act on. */
const eventSchema = z.object({ id: z.string().regex(/^evt_[A-Za-z0-9_]{1,128}$/), type: z.string().min(1).max(200), livemode: z.boolean(), data: z.object({ object: z.unknown() }) });
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
/** What an event of any type may be asked: the id of the object it is about, and its customer when it has one. Nothing else is read or stored. */
const objectRefSchema = z.object({ id: z.string().max(255).nullish(), customer: z.unknown().optional() });

export interface WebhookAnswer { status: number; body: Record<string, unknown> }

export interface StripeWebhookOptions {
  settings: BillingSettings;
  /** Where a verified event and its customer are stored, and marked once it is applied. */
  ledger: Pick<PaymentLedger, 'recordVerifiedPayment' | 'recordIgnoredEvent' | 'markEvent'>;
  now?: () => number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class StripeWebhookService {
  private readonly now: () => number;
  /** One handler per event type: the Checkout Session events here, everything else stored and ignored. */
  readonly router: StripeEventRouter;

  constructor(private readonly funding: Pick<FundingService, 'previewCreditPurchase' | 'resolveCreditPurchase'>, private readonly options: StripeWebhookOptions) {
    this.now = options.now ?? Date.now;
    const checkout: StripeEventHandler = (context) => this.checkout(context);
    this.router = new StripeEventRouter(Object.fromEntries(Object.keys(KINDS).map((type) => [type, checkout])), (context) => this.ignore(context));
  }

  /**
   * A paid event, before the purchase is paid: ask the funding service whether this event could pay its purchase (nothing
   * is written), then store the verified event and the business's customer in the ledger, against the stored purchase's own
   * business and tenant. False when the event pays nothing, so nothing is stored for it.
   */
  private async storePayment(event: StripeEvent, object: z.infer<typeof sessionSchema>, raw: Uint8Array, environment: StripeMode): Promise<boolean> {
    const ask = {
      sessionId: object.id, purchaseId: object.metadata?.purchase_id ?? null, organizationId: object.metadata?.organization_id ?? null,
      tenantId: object.metadata?.tenant_id ?? null, amountTotal: object.amount_total ?? null, currency: object.currency ?? null, environment,
    };
    const payable = await this.funding.previewCreditPurchase(ask);
    if (payable.outcome === 'ignored') {
      if (MISMATCHES.includes(payable.reason))
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
      environment, eventId: event.id, customerId, organizationId: payable.organizationId, tenantId: payable.tenantId,
      payloadHash: await sha256Hex(raw), eventType: event.type,
      payload: { id: event.id, type: event.type, livemode: event.livemode, data: { object: {
        id: object.id, payment_status: object.payment_status ?? null, amount_total: object.amount_total ?? null, currency: object.currency ?? null,
        customer: customerId, client_reference_id: object.client_reference_id ?? null, metadata: object.metadata ?? null } } },
    });
    return true;
  }

  /** Move a stored event out of pending. A failure here is logged and nothing more: the payment it records is already applied or already refused. */
  private async mark(eventId: string, environment: StripeMode, state: 'processed' | 'quarantined'): Promise<void> {
    try {
      await this.options.ledger.markEvent({ environment, eventId }, state);
    } catch {
      console.error(JSON.stringify({ event: 'stripe-event-mark-failed', eventId, state }));
    }
  }

  /**
   * The Checkout Session events, as they were before the router: a paid event is stored and then applied to the purchase its session pays, and the
   * stored event is marked processed, or quarantined when the purchase refuses it for good. An expired or failed session changes the purchase and stores
   * nothing. A failure a retry could change is thrown, so the receiver answers 503 and the event stays pending.
   */
  private async checkout({ event, raw, environment }: StripeEventContext): Promise<void> {
    const kind = KINDS[event.type];
    if (!kind) return;
    const session = sessionSchema.safeParse(event.data.object);
    if (!session.success) return;
    const object = session.data;
    // A completed session that is not paid yet is waiting on a delayed payment; its own event settles it.
    if (kind === 'paid' && object.payment_status !== 'paid') return;
    let stored = false;
    try {
      if (kind === 'paid') {
        stored = await this.storePayment(event, object, raw, environment);
        if (!stored) return;
      }
      const result = await this.funding.resolveCreditPurchase({
        kind, sessionId: object.id, eventId: event.id, environment,
        purchaseId: object.metadata?.purchase_id ?? null, organizationId: object.metadata?.organization_id ?? null, tenantId: object.metadata?.tenant_id ?? null,
        amountTotal: object.amount_total ?? null, currency: object.currency ?? null,
      });
      const refused = result.outcome === 'ignored' && result.reason !== null && MISMATCHES.includes(result.reason);
      if (refused) console.error(JSON.stringify({ event: 'credit-purchase-mismatch', reason: result.reason, purchaseId: result.purchaseId, eventId: event.id }));
      if (stored) await this.mark(event.id, environment, refused || (result.outcome === 'ignored' && result.reason === 'unknown_session') ? 'quarantined' : 'processed');
    } catch (error) {
      if (error instanceof FundingError) {
        // A refusal a retry will not change. Answering 200 stops Stripe from sending it again; the log names it.
        console.error(JSON.stringify({ event: 'credit-purchase-refused', code: error.code, eventId: event.id }));
        if (stored) await this.mark(event.id, environment, 'quarantined');
        return;
      }
      if (error instanceof AccountError && error.status === 409) {
        // The ledger refused: the event is stored with other contents, or the customer is not this business's. A retry
        // will not change it, and nothing was paid. The log carries the event id to repair it by hand.
        console.error(JSON.stringify({ event: 'credit-purchase-ledger-refused', code: error.code ?? 'conflict', eventId: event.id }));
        return;
      }
      throw error;
    }
  }

  /**
   * An event of a type nothing handles: stored in the inbox and marked ignored, with only the id of the object it is about and its customer, never
   * the object. Idempotent, so a second delivery stores nothing.
   */
  private async ignore({ event, raw, environment }: StripeEventContext): Promise<void> {
    const ref = objectRefSchema.safeParse(event.data.object);
    const customerId = ref.success && typeof ref.data.customer === 'string' && CUSTOMER_ID.test(ref.data.customer) ? ref.data.customer : null;
    try {
      await this.options.ledger.recordIgnoredEvent({
        environment, eventId: event.id, customerId, payloadHash: await sha256Hex(raw), eventType: event.type,
        payload: { id: event.id, type: event.type, livemode: event.livemode, data: { object: { id: ref.success ? ref.data.id ?? null : null, customer: customerId } } },
      });
    } catch (error) {
      if (error instanceof AccountError && error.status === 409) {
        // Stored already with other contents: nothing to change, and a retry will not change it.
        console.error(JSON.stringify({ event: 'stripe-event-ledger-refused', code: error.code ?? 'conflict', eventId: event.id }));
        return;
      }
      throw error;
    }
  }

  /**
   * One Stripe event. 400 for a body whose signature does not verify under either secret, that is not an event, or whose mode is not the
   * Worker's, with nothing recorded. 503 when the signing secret is not set or the write could not be made, so Stripe sends it again.
   * 200 for everything else, including an event this service does not act on and one it finds already applied.
   */
  async handle(request: Request): Promise<WebhookAnswer> {
    const { stripeWebhookSecret: secret, stripeWebhookSecretPrevious: previous, mode } = this.options.settings;
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
    // A rotation: the new secret, or the one before it, may have signed the event.
    const header = request.headers.get('stripe-signature');
    const signed = (await verifyStripeSignature(raw, header, secret, this.now())) || (previous !== null && (await verifyStripeSignature(raw, header, previous, this.now())));
    if (!signed) return { status: 400, body: { error: 'The signature could not be verified.' } };
    let event: StripeEvent;
    try {
      const parsed = eventSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
      if (!parsed.success) return { status: 400, body: { error: 'That is not an event.' } };
      event = parsed.data;
    } catch {
      return { status: 400, body: { error: 'That is not an event.' } };
    }
    // The guard: an event is acted on only in the mode the Worker is in. A live event never reaches a Worker that was not set live on purpose,
    // and a test event never reaches one that was. Nothing is stored for it.
    if (event.livemode !== (mode === 'live')) {
      console.error(JSON.stringify({ event: 'stripe-event-wrong-mode', eventId: event.id, eventLivemode: event.livemode, mode }));
      return { status: 400, body: { error: 'That event is not from the mode this service is in.' } };
    }
    try {
      await this.router.dispatch({ event, raw, environment: mode });
    } catch {
      console.error(JSON.stringify({ event: 'credit-purchase-webhook-failed', eventId: event.id }));
      return { status: 503, body: { error: 'The event could not be recorded. Try again.' } };
    }
    return { status: 200, body: { received: true } };
  }
}

const KINDS: Record<string, 'paid' | 'expired' | 'failed' | undefined> = Object.assign(Object.create(null), {
  'checkout.session.completed': 'paid',
  'checkout.session.async_payment_succeeded': 'paid',
  'checkout.session.async_payment_failed': 'failed',
  'checkout.session.expired': 'expired',
});
/** Why a stored purchase can refuse an event for good: the event does not belong to it. */
const MISMATCHES: readonly string[] = ['amount_mismatch', 'metadata_mismatch', 'environment_mismatch'];

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
