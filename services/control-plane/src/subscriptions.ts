import { z } from 'zod';
import { allowedBillingUrl, billingPlanId, subscriptionInput, type BillingView } from '../../../shared/account-billing.js';
import { individualCycleAt, type IndividualBillingCycle } from '../../../shared/individual-period.js';
import { AccountError } from './errors.js';
import { stripeRequestHeaders, type BillingSettings, type PaymentLedger } from './credit-purchases.js';
import type { DeveloperScopeResolver } from './developer-keys.js';
import type { StripeEventContext, StripeEventHandler, StripeMode } from './stripe-events.js';

const catalogItem = z.strictObject({ id: billingPlanId, priceId: z.string().regex(/^price_[A-Za-z0-9_]+$/), amountCents: z.number().int().positive().max(99_999_999) });
export type SubscriptionPrice = z.infer<typeof catalogItem>;
export function readSubscriptionCatalog(env: Record<string, unknown>): SubscriptionPrice[] {
  try {
    const rows = z.array(catalogItem).max(6).parse(JSON.parse(String(env.STRIPE_SUBSCRIPTION_CATALOG ?? '[]')));
    return new Set(rows.map(row => row.id)).size === rows.length && new Set(rows.map(row => row.priceId)).size === rows.length ? rows : [];
  } catch { return []; }
}
const timestamp = z.number().int().positive().max(253402300799);
const priceShape = z.object({ id: z.string(), currency: z.literal('usd'), unit_amount: z.number().int().positive(), recurring: z.object({ interval: z.literal('month'), interval_count: z.literal(1) }) });
const invoiceShape = z.object({ id: z.string().regex(/^in_/), customer: z.string(), livemode: z.boolean(), status: z.literal('paid'), amount_remaining: z.literal(0), currency: z.literal('usd'),
  billing_reason: z.enum(['subscription_create', 'subscription_cycle']), parent: z.object({ subscription_details: z.object({ subscription: z.string() }) }),
  lines: z.object({ has_more: z.literal(false), data: z.array(z.object({ period: z.object({ start: timestamp, end: timestamp }), pricing: z.object({ price_details: z.object({ price: z.string() }) }),
    parent: z.object({ subscription_item_details: z.object({ subscription_item: z.string(), proration: z.literal(false) }) }) })).length(1) }) });
const paidShape = z.object({ id: z.string().regex(/^sub_/), customer: z.string(), livemode: z.boolean(), status: z.literal('active'), billing_cycle_anchor: timestamp,
  items: z.object({ has_more: z.literal(false), data: z.array(z.object({ id: z.string(), quantity: z.literal(1), current_period_start: timestamp, current_period_end: timestamp, price: priceShape })).length(1) }), latest_invoice: invoiceShape });
export interface PaidSubscription { id: string; planId: SubscriptionPrice['id']; invoiceId: string; validFrom: string; validUntil: string; billingCycle?: IndividualBillingCycle }
/** Only a complete, current paid monthly invoice can describe an access grant. */
export function paidSubscription(raw: unknown, customerId: string, mode: StripeMode, catalog: SubscriptionPrice[]): PaidSubscription | null {
  const parsed = paidShape.safeParse(raw);
  if (!parsed.success) return null;
  const sub = parsed.data, invoice = sub.latest_invoice, item = sub.items.data[0], line = invoice.lines.data[0];
  const plan = catalog.find(row => row.priceId === item.price.id && row.amountCents === item.price.unit_amount);
  if (!plan || plan.id === 'workflow-starter' || sub.customer !== customerId || invoice.customer !== customerId || sub.livemode !== (mode === 'live') || invoice.livemode !== sub.livemode ||
      invoice.parent.subscription_details.subscription !== sub.id || line.pricing.price_details.price !== item.price.id || line.parent.subscription_item_details.subscription_item !== item.id ||
      line.period.start !== item.current_period_start || line.period.end !== item.current_period_end || item.current_period_end <= item.current_period_start) return null;
  const validFrom = new Date(item.current_period_start * 1000).toISOString(), validUntil = new Date(item.current_period_end * 1000).toISOString();
  const cycle = individualCycleAt(new Date(sub.billing_cycle_anchor * 1000).toISOString(), validFrom);
  if (!cycle || cycle.startsAt !== validFrom || cycle.endsAt !== validUntil) return null;
  return { id: sub.id, planId: plan.id, invoiceId: invoice.id, validFrom, validUntil, ...(plan.id === 'individual' ? { billingCycle: cycle } : {}) };
}

export interface SubscriptionOwner { customerId: string; organizationId: string; tenantId: string; personId: string | null }
export interface CheckoutAttempt { id: string; planId: string; createdAt: number; sessionId: string | null; url: string | null }
export interface SubscriptionStore {
  owner(customerId: string, mode: StripeMode): Promise<SubscriptionOwner | null>;
  view(customerId: string, mode: StripeMode): Promise<BillingView['subscriptions']>;
  attempt(owner: SubscriptionOwner, mode: StripeMode, planId: string, now: number): Promise<CheckoutAttempt>;
  complete(customerId: string, mode: StripeMode, attemptId: string, sessionId: string, url: string): Promise<void>;
  expire(customerId: string, mode: StripeMode, attemptId: string): Promise<void>;
  reconcile(owner: SubscriptionOwner, mode: StripeMode, eventId: string, suspended: boolean, read: () => Promise<PaidSubscription[]>): Promise<void>;
}
const unavailable = () => new AccountError(503, 'Billing is not ready for this account yet. Try again later.');
const objectRef = z.object({ id: z.string(), customer: z.string().nullish(), charge: z.string().optional() });
const listShape = z.object({ has_more: z.literal(false), data: z.array(z.unknown()).max(100) });
const subRef = z.object({ id: z.string(), status: z.string(), customer: z.string(), livemode: z.boolean() });
const SELF_SERVICE = new Set(['individual', 'business']);

export class SubscriptionService {
  constructor(private readonly options: { settings: BillingSettings; catalog: SubscriptionPrice[]; store: SubscriptionStore; ledger: PaymentLedger; resolve: DeveloperScopeResolver;
    enabled: boolean; send?: typeof fetch; now?: () => number }) {}
  private get now() { return this.options.now ?? Date.now; }
  private async request(path: string, form?: URLSearchParams, key?: string): Promise<unknown> {
    const secret = this.options.settings.stripeSecretKey;
    if (!secret) throw unavailable();
    let response: Response;
    try { response = await (this.options.send ?? fetch)(`https://api.stripe.com/v1/${path}`, { method: form ? 'POST' : 'GET', headers: stripeRequestHeaders(secret, key ?? crypto.randomUUID()),
      ...(form ? { body: form.toString() } : {}), redirect: 'error', signal: AbortSignal.timeout(2500) }); }
    catch { throw unavailable(); }
    if (!response.ok) throw unavailable();
    try { return await response.json(); } catch { throw unavailable(); }
  }
  private async payer(token: string, organizationId: string | null) {
    const { actor, scope, tenantId } = await this.options.resolve(token, organizationId);
    // The scope resolver reads verified membership; tenant comes from that same account boundary.
    if (scope.kind === 'organization' && !tenantId) throw unavailable();
    return { actor, scope, organizationId: scope.id, tenantId: scope.kind === 'individual' ? actor.person.id : tenantId! };
  }
  async view(token: string, organizationId: string | null): Promise<BillingView> {
    const payer = await this.payer(token, organizationId), environment = this.options.settings.mode;
    const customer = await this.options.ledger.storedCustomer({ ...payer, environment });
    return { mode: environment, portalAvailable: !!customer && !!this.options.settings.stripeSecretKey,
      plans: this.options.catalog.map(plan => ({ id: plan.id, available: this.options.enabled && !!this.options.settings.stripeSecretKey && SELF_SERVICE.has(plan.id) && (plan.id === 'individual') === (payer.scope.kind === 'individual') })),
      subscriptions: customer ? await this.options.store.view(customer, environment) : [] };
  }
  async checkout(token: string, raw: unknown) {
    const parsed = subscriptionInput.safeParse(raw);
    if (!parsed.success) throw new AccountError(422, 'Choose a plan and the account it belongs to.');
    const input = parsed.data, payer = await this.payer(token, input.organizationId), environment = this.options.settings.mode;
    if ((input.planId === 'individual') !== (payer.scope.kind === 'individual')) throw new AccountError(422, 'Individual is for your own work; Business plans belong to a business.');
    if (input.planId === 'individual' && !input.individualEligible) throw new AccountError(422, 'Confirm Individual eligibility before continuing. Businesses and sole proprietorships cannot buy this plan; freelancers are eligible.');
    if (!SELF_SERVICE.has(input.planId)) throw new AccountError(409, 'This plan needs a written scope and agreed price. Contact Diomedes to arrange it.');
    const plan = this.options.catalog.find(row => row.id === input.planId);
    if (!this.options.enabled || !plan) throw unavailable();
    const price = z.object({ ...priceShape.shape, livemode: z.boolean(), active: z.literal(true) }).safeParse(await this.request(`prices/${encodeURIComponent(plan.priceId)}`));
    if (!price.success || price.data.id !== plan.priceId || price.data.unit_amount !== plan.amountCents || price.data.livemode !== (environment === 'live')) throw unavailable();
    const customerId = await this.options.ledger.ensureCustomer({ ...payer, environment }, async () => {
      const answer = z.object({ id: z.string().regex(/^cus_[A-Za-z0-9_]+$/) }).safeParse(await this.request('customers', new URLSearchParams({ 'metadata[scope_id]': payer.scope.id }), `subscription-customer:${environment}:${payer.scope.id}`));
      if (!answer.success) throw unavailable();
      return answer.data.id;
    });
    const existing = await this.subscriptions(customerId);
    if (existing.some(value => !['canceled', 'incomplete_expired'].includes(subRef.parse(value).status))) throw new AccountError(409, 'This account already has a subscription. Manage it in billing.');
    const owner = await this.options.store.owner(customerId, environment);
    if (!owner) throw unavailable();
    let attempt = await this.options.store.attempt(owner, environment, plan.id, this.now());
    if (attempt.sessionId) {
      const old = z.object({ status: z.enum(['open', 'complete', 'expired']), url: z.string().nullable(), customer: z.string(), livemode: z.boolean(), subscription: z.string().nullable() }).parse(await this.request(`checkout/sessions/${encodeURIComponent(attempt.sessionId)}`));
      if (old.customer !== customerId || old.livemode !== (environment === 'live')) throw unavailable();
      if (old.status === 'complete' && !existing.some(row => {
        const subscription = subRef.parse(row);
        return subscription.id === old.subscription && ['canceled', 'incomplete_expired'].includes(subscription.status);
      })) throw new AccountError(409, 'Your payment is being confirmed. Refresh your plan in a moment.');
      if (old.status === 'open') {
        if (attempt.planId !== plan.id || !old.url || !allowedBillingUrl(old.url)) throw new AccountError(409, 'Finish or cancel the payment page already opened for this account.');
        return { url: old.url };
      }
      await this.options.store.expire(customerId, environment, attempt.id);
      attempt = await this.options.store.attempt(owner, environment, plan.id, this.now());
    }
    if (attempt.planId !== plan.id || this.now() - attempt.createdAt > 30 * 60_000) throw new AccountError(409, 'A payment request needs review before another can be opened. Contact Diomedes.');
    const form = new URLSearchParams({ mode: 'subscription', customer: customerId, 'line_items[0][price]': plan.priceId, 'line_items[0][quantity]': '1',
      'subscription_data[metadata][nectovia_plan_id]': plan.id, 'metadata[subscription_attempt]': attempt.id,
      success_url: 'https://nectovia.diomedes.net/account?billing=returned#plan', cancel_url: 'https://nectovia.diomedes.net/account?billing=canceled#plan',
      expires_at: String(Math.floor(attempt.createdAt / 1000) + 3600), 'billing_address_collection': 'required', 'tax_id_collection[enabled]': 'true' });
    const answer = z.object({ id: z.string().regex(/^cs_/), url: z.string() }).safeParse(await this.request('checkout/sessions', form, attempt.id));
    if (!answer.success || !allowedBillingUrl(answer.data.url)) throw unavailable();
    await this.options.store.complete(customerId, environment, attempt.id, answer.data.id, answer.data.url);
    return { url: answer.data.url };
  }
  async portal(token: string, organizationId: string | null) {
    const payer = await this.payer(token, organizationId), environment = this.options.settings.mode;
    const customer = await this.options.ledger.storedCustomer({ ...payer, environment });
    if (!customer) throw new AccountError(404, 'There is no billing account to manage yet.');
    const answer = z.object({ url: z.string() }).safeParse(await this.request('billing_portal/sessions', new URLSearchParams({ customer, return_url: 'https://nectovia.diomedes.net/account#plan' })));
    if (!answer.success || !allowedBillingUrl(answer.data.url)) throw unavailable();
    return { url: answer.data.url };
  }
  private async subscriptions(customer: string): Promise<unknown[]> {
    const result = listShape.safeParse(await this.request(`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100&expand%5B%5D=data.latest_invoice`));
    if (!result.success) throw unavailable();
    for (const raw of result.data.data) {
      const row = subRef.safeParse(raw);
      if (!row.success || row.data.customer !== customer || row.data.livemode !== (this.options.settings.mode === 'live')) throw unavailable();
    }
    return result.data.data;
  }
  handlers(): Record<string, StripeEventHandler> {
    return Object.fromEntries(['invoice.paid', 'invoice.payment_failed', 'invoice.voided', 'invoice.marked_uncollectible', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
      'charge.refunded', 'charge.dispute.created', 'credit_note.created'].map(type => [type, context => this.reconcile(context)]));
  }
  private async reconcile(context: StripeEventContext) {
    const ref = objectRef.safeParse(context.event.data.object);
    if (!ref.success) throw unavailable();
    const suspended = ['charge.refunded', 'charge.dispute.created', 'credit_note.created'].includes(context.event.type);
    let customer = ref.data.customer;
    if (!customer && context.event.type === 'charge.dispute.created' && ref.data.charge?.startsWith('ch_')) {
      customer = objectRef.parse(await this.request(`charges/${encodeURIComponent(ref.data.charge)}`)).customer;
    }
    if (!customer) return;
    const owner = await this.options.store.owner(customer, context.environment);
    if (!owner) return;
    const payloadHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', context.raw as Uint8Array<ArrayBuffer>)), byte => byte.toString(16).padStart(2, '0')).join('');
    await this.options.ledger.recordVerifiedPayment({ customerId: owner.customerId, organizationId: owner.organizationId, tenantId: owner.tenantId, environment: context.environment, eventId: context.event.id, eventType: context.event.type, payloadHash,
      payload: { id: context.event.id, type: context.event.type, livemode: context.event.livemode, data: { object: { id: ref.data.id, customer } } } });
    // Re-fetch after the customer's database lock. Arrival order never chooses the current period.
    await this.options.store.reconcile(owner, context.environment, context.event.id, suspended, async () => {
      const all = await this.subscriptions(customer);
      const active = all.filter(row => !['canceled', 'incomplete_expired'].includes(subRef.parse(row).status));
      if (active.length > 1) return [];
      return active.map(row => paidSubscription(row, customer, context.environment, this.options.catalog)).filter((row): row is PaidSubscription => row !== null);
    });
    await this.options.ledger.markEvent({ environment: context.environment, eventId: context.event.id }, suspended ? 'quarantined' : 'processed');
  }
}
