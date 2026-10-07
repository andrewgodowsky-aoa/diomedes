import { describe, expect, it, vi } from 'vitest';
import { SubscriptionService, type SubscriptionStore, type CheckoutAttempt } from '../src/subscriptions.js';
import { readBillingSettings, type PaymentLedger } from '../src/credit-purchases.js';
import { verifiedPaymentSchema } from '../src/postgres.js';

function fixture() {
  const owner = { customerId: 'cus_owned', organizationId: 'individual_a', tenantId: 'person_a', personId: 'person_a' };
  let attempt: CheckoutAttempt | null = null;
  const store: SubscriptionStore = { owner: async () => owner, view: async () => [],
    attempt: async (_owner, _mode, planId, now) => attempt ??= { id: 'checkout_stable', planId, createdAt: now, sessionId: null, url: null },
    complete: async (_customer, _mode, _id, sessionId, url) => { attempt = { ...attempt!, sessionId, url }; }, expire: async () => { attempt = null; },
    reconcile: async (_owner, _mode, _event, _suspended, read) => { await read(); } };
  const ledger: PaymentLedger = { storedCustomer: async () => owner.customerId, ensureCustomer: async () => owner.customerId,
    recordVerifiedPayment: async input => { verifiedPaymentSchema.parse(input); return { inserted: true }; },
    recordIgnoredEvent: async () => ({ inserted: true }), markEvent: async () => true };
  const requests: Array<{ path: string; options: RequestInit | undefined }> = [];
  let active = false, foreignUrl = false, failSave = false;
  const send: typeof fetch = async (url, options) => {
    const path = String(url).slice('https://api.stripe.com/v1/'.length); requests.push({ path, options });
    if (path.startsWith('prices/')) return Response.json({ id: 'price_reviewed', active: true, livemode: false, currency: 'usd', unit_amount: 20000, recurring: { interval: 'month', interval_count: 1 } });
    if (path.startsWith('subscriptions?')) return Response.json({ has_more: false, data: active ? [{ id: 'sub_existing', status: 'active', customer: owner.customerId, livemode: false }] : [] });
    if (path.startsWith('checkout/sessions/')) return Response.json({ status: 'open', url: 'https://checkout.stripe.com/c/pay/test_existing', customer: owner.customerId, livemode: false, subscription: null });
    if (path === 'checkout/sessions') { if (failSave) throw new Error('network'); return Response.json({ id: 'cs_new', url: foreignUrl ? 'https://evil.example/pay' : 'https://checkout.stripe.com/c/pay/test_new' }); }
    if (path === 'billing_portal/sessions') return Response.json({ url: 'https://billing.stripe.com/p/session/test' });
    throw new Error(`Unexpected Stripe path: ${path}`);
  };
  const resolve = vi.fn(async (_token: string, organizationId: string | null) => {
    if (organizationId) throw new Error('unauthorized scope');
    return { actor: { person: { id: 'person_a', name: 'Test' }, mapping: { issuer: 'https://identity.example', subject: 'user_a', identityGeneration: 0 } }, scope: { kind: 'individual' as const, id: 'individual_a' } };
  });
  const options = { settings: readBillingSettings({ STRIPE_SECRET_KEY: 'sk_test_fixture_only_no_external_calls' }), catalog: [{ id: 'individual' as const, priceId: 'price_reviewed', amountCents: 20000 }], store, ledger, resolve, enabled: true, send, now: () => 1_791_331_200_000 };
  return { options, requests, setActive: () => { active = true; }, setForeign: () => { foreignUrl = true; }, setFailure: (value: boolean) => { failSave = value; } };
}
const input = { organizationId: null, planId: 'individual', individualEligible: true };
describe('subscription checkout boundary', () => {
  it('uses only the owned customer and reviewed price, and reuses an open session', async () => {
    const f = fixture(), service = new SubscriptionService(f.options);
    await service.checkout('session', input); await service.checkout('session', input);
    const writes = f.requests.filter(row => row.path === 'checkout/sessions');
    expect(writes).toHaveLength(1);
    const form = new URLSearchParams(String(writes[0].options?.body));
    expect(form.get('customer')).toBe('cus_owned'); expect(form.get('line_items[0][price]')).toBe('price_reviewed');
    expect(form.get('success_url')).toBe('https://nectovia.diomedes.net/account?billing=returned#plan');
  });
  it('retries an ambiguous network result with the same idempotency key', async () => {
    const f = fixture(), service = new SubscriptionService(f.options); f.setFailure(true);
    await expect(service.checkout('session', input)).rejects.toMatchObject({ status: 503 }); f.setFailure(false);
    await service.checkout('session', input);
    const writes = f.requests.filter(row => row.path === 'checkout/sessions');
    expect(writes.map(row => new Headers(row.options?.headers).get('Idempotency-Key'))).toEqual(['checkout_stable', 'checkout_stable']);
  });
  it('refuses foreign fields, missing eligibility and active subscriptions before creating a session', async () => {
    const f = fixture(), service = new SubscriptionService(f.options);
    await expect(service.checkout('session', { ...input, customerId: 'cus_foreign' })).rejects.toMatchObject({ status: 422 });
    await expect(service.checkout('session', { ...input, individualEligible: false })).rejects.toMatchObject({ status: 422 });
    await expect(service.checkout('session', { ...input, organizationId: 'org_foreign' })).rejects.toThrow('unauthorized scope');
    f.setActive(); await expect(service.checkout('session', input)).rejects.toMatchObject({ status: 409 });
    expect(f.requests.some(row => row.path === 'checkout/sessions')).toBe(false);
  });
  it('rejects a foreign redirect and disables unavailable checkout', async () => {
    const f = fixture(); f.setForeign(); await expect(new SubscriptionService(f.options).checkout('session', input)).rejects.toMatchObject({ status: 503 });
    f.options.settings.stripeSecretKey = null;
    expect((await new SubscriptionService(f.options).view('session', null)).plans[0].available).toBe(false);
  });
  it('opens the portal for the stored customer, and records an exact verified event shape', async () => {
    const f = fixture(), service = new SubscriptionService(f.options);
    await service.portal('session', null);
    expect(new URLSearchParams(String(f.requests[0].options?.body)).get('customer')).toBe('cus_owned');
    const event = { id: 'evt_paid', object: 'event' as const, type: 'invoice.paid', livemode: false, created: 1791331200, data: { object: { id: 'in_paid', customer: 'cus_owned' } } };
    await service.handlers()['invoice.paid']({ event, environment: 'test', raw: new TextEncoder().encode(JSON.stringify(event)) });
  });
});
