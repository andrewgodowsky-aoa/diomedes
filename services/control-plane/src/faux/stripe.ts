import { STRIPE_API_VERSION } from '../credit-purchases.js';

/**
 * A stand-in for the three things the faux cloud needs from Stripe so the desktop can buy credits without it:
 * the Customer create call, the Checkout Session create call, and the signed event Stripe sends when a session is paid.
 *
 * Nothing here reaches the network. The session it makes carries a local checkout page (served by the faux
 * cloud, /faux/checkout/:id) in place of checkout.stripe.com, and a test helper pays it by posting the same
 * kind of signed event to the Worker's own webhook, so the code that records a top-up is the real one.
 * Faux data only: no payment is made and no card is read.
 */

/** The values the faux cloud reads as the Worker secrets STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. */
export const FAUX_STRIPE_SECRET_KEY = 'sk_test_faux_checkout_key';
export const FAUX_STRIPE_WEBHOOK_SECRET = 'whsec_faux_checkout_secret';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomText(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

const fauxSessionId = () => `cs_faux_${randomText(24)}`;
const fauxCustomerId = () => `cus_faux_${randomText(14)}`;

/** The faux Stripe's own memory of what it made: the customers, the customer each session belongs to, and the form that asked for it. */
export type FauxStripeFetch = typeof globalThis.fetch & {
  /** The customer a session was made for: the one its form named. */
  customerOf(sessionId: string): string | null;
  /** The form each session was created from, in the order they were made. */
  readonly created: { sessionId: string; customerId: string; form: URLSearchParams }[];
  /** The customers made, one per idempotency key: a retry with the same key is answered with the customer already made, not a second. */
  readonly customers: { customerId: string; idempotencyKey: string; form: URLSearchParams }[];
};

/** The fields of a customer the faux Stripe takes: our own business and tenant ids as metadata, and nothing about a person. */
const CUSTOMER_FIELDS = ['metadata[organization_id]', 'metadata[tenant_id]'];

/**
 * POST https://api.stripe.com/v1/customers and POST https://api.stripe.com/v1/checkout/sessions, answered locally. They read
 * the same forms the Worker sends and refuse anything the real calls would refuse for a missing field or key. A customer is
 * made once per idempotency key, as Stripe does: the same key again answers the same customer. A payment session must name an
 * existing `customer` (`customer_creation` is refused outright, so a purchase that goes back to asking Checkout to make
 * one fails here), and answers a session whose page is on the origin the buyer was sent back to.
 */
export function fauxStripeFetch(): FauxStripeFetch {
  const created: FauxStripeFetch['created'] = [];
  const customers: FauxStripeFetch['customers'] = [];
  const handler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const refuse = (status: number, message: string) => Response.json({ error: { message } }, { status });
    if (!['https://api.stripe.com/v1/checkout/sessions', 'https://api.stripe.com/v1/customers'].includes(url) || init?.method !== 'POST')
      return refuse(404, 'The faux Stripe knows only the Customer and Checkout Session create calls.');
    const headers = new Headers(init.headers);
    if (headers.get('authorization') !== `Bearer ${FAUX_STRIPE_SECRET_KEY}`) return refuse(401, 'Invalid API key.');
    // Every request pins the API version, as the real service allows; a call that forgets it fails here, so a test catches it.
    if (headers.get('stripe-version') !== STRIPE_API_VERSION) return refuse(400, 'Every request must pin the Stripe-Version this service was built against.');
    const idempotencyKey = headers.get('idempotency-key');
    if (!idempotencyKey) return refuse(400, 'An idempotency key is required here.');
    const form = new URLSearchParams(String(init.body ?? ''));
    if (url === 'https://api.stripe.com/v1/customers') {
      for (const field of CUSTOMER_FIELDS) if (!form.get(field)) return refuse(400, `Missing required param: ${field}.`);
      for (const field of form.keys()) if (!CUSTOMER_FIELDS.includes(field)) return refuse(400, `The faux Stripe takes no ${field} for a customer.`);
      const made = customers.find((row) => row.idempotencyKey === idempotencyKey);
      if (made && made.form.toString() !== form.toString())
        return refuse(400, 'Keys for idempotent requests can only be used with the same parameters they were first used with.');
      const customerId = made?.customerId ?? fauxCustomerId();
      if (!made) customers.push({ customerId, idempotencyKey, form });
      return Response.json({ id: customerId, object: 'customer', metadata: { organization_id: form.get('metadata[organization_id]'), tenant_id: form.get('metadata[tenant_id]') } });
    }
    for (const field of ['mode', 'success_url', 'cancel_url', 'client_reference_id', 'line_items[0][price_data][unit_amount]'])
      if (!form.get(field)) return refuse(400, `Missing required param: ${field}.`);
    if (form.get('mode') !== 'payment') return refuse(400, 'Only payment mode is faux.');
    const existing = form.get('customer');
    if (form.has('customer_creation')) return refuse(400, 'The faux Stripe takes no customer_creation: the business has its customer before its session.');
    if (existing === null) return refuse(400, "The faux Stripe wants the business's customer on the session.");
    // Any well-formed id is taken: a faux cloud that is restarted keeps its stored customer but not this memory of it.
    if (!/^cus_[A-Za-z0-9_]{1,128}$/.test(existing)) return refuse(400, 'No such customer.');
    const id = fauxSessionId();
    created.push({ sessionId: id, customerId: existing, form });
    return Response.json({ id, object: 'checkout.session', status: 'open', url: `${new URL(form.get('success_url')!).origin}/faux/checkout/${id}` });
  }) as typeof globalThis.fetch;
  return Object.assign(handler, {
    customerOf: (sessionId: string) => created.find((row) => row.sessionId === sessionId)?.customerId ?? null,
    created,
    customers,
  });
}

/** A Stripe-Signature header for a body, the way Stripe computes it. */
export async function signFauxEvent(body: string, nowMs: number, secret = FAUX_STRIPE_WEBHOOK_SECRET): Promise<string> {
  const seconds = Math.floor(nowMs / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${seconds}.${body}`)));
  return `t=${seconds},v1=${Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export interface FauxPaidSession { sessionId: string; purchaseId: string; organizationId: string; tenantId: string; amountCents: number; customerId: string }

/** The checkout.session.completed event a paid session sends. Its id is the session's, so paying twice is one event. */
export function fauxPaidEvent(session: FauxPaidSession, nowMs: number): string {
  return JSON.stringify({
    id: `evt_faux_${session.sessionId.replace(/^cs_/, '')}`, object: 'event', type: 'checkout.session.completed', created: Math.floor(nowMs / 1000), livemode: false,
    data: { object: {
      id: session.sessionId, object: 'checkout.session', status: 'complete', payment_status: 'paid', amount_total: session.amountCents, currency: 'usd',
      client_reference_id: session.purchaseId, customer: session.customerId,
      metadata: { purchase_id: session.purchaseId, organization_id: session.organizationId, tenant_id: session.tenantId },
    } },
  });
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The local checkout page: what is being bought and for how much, and one button that pays it. Faux data only. */
export function fauxCheckoutPage(session: { sessionId: string; credits: number; amountCents: number }): string {
  const dollars = `$${(session.amountCents / 100).toFixed(2)}`;
  const credits = String(session.credits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test checkout</title>`
    + `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8ecf4;font:16px/1.5 system-ui,sans-serif}main{max-width:26rem;margin:0 16px}`
    + `button{font:inherit;padding:8px 16px}</style></head><body><main><p>Test checkout, no card is read.</p>`
    + `<p>${escapeHtml(credits)} Nectovia credits for ${escapeHtml(dollars)}</p>`
    + `<form method="post" action="/faux/checkout/${escapeHtml(session.sessionId)}/complete"><button type="submit">Pay ${escapeHtml(dollars)}</button></form></main></body></html>`;
}
