/**
 * A stand-in for the two things the faux cloud needs from Stripe so the desktop can buy credits without it:
 * the Checkout Session create call, and the signed event Stripe sends when a session is paid.
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

function fauxSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `cs_faux_${Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('')}`;
}

/**
 * POST https://api.stripe.com/v1/checkout/sessions, answered locally. It reads the same form the Worker
 * sends, refuses anything the real call would refuse for a missing field or key, and answers a session whose
 * page is on the origin the buyer was sent back to.
 */
export function fauxStripeFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const refuse = (status: number, message: string) => Response.json({ error: { message } }, { status });
    if (url !== 'https://api.stripe.com/v1/checkout/sessions' || init?.method !== 'POST') return refuse(404, 'The faux Stripe knows only the Checkout Session create call.');
    const headers = new Headers(init.headers);
    if (headers.get('authorization') !== `Bearer ${FAUX_STRIPE_SECRET_KEY}`) return refuse(401, 'Invalid API key.');
    if (!headers.get('idempotency-key')) return refuse(400, 'An idempotency key is required here.');
    const form = new URLSearchParams(String(init.body ?? ''));
    for (const field of ['mode', 'success_url', 'cancel_url', 'client_reference_id', 'line_items[0][price_data][unit_amount]'])
      if (!form.get(field)) return refuse(400, `Missing required param: ${field}.`);
    if (form.get('mode') !== 'payment') return refuse(400, 'Only payment mode is faux.');
    const id = fauxSessionId();
    return Response.json({ id, object: 'checkout.session', status: 'open', url: `${new URL(form.get('success_url')!).origin}/faux/checkout/${id}` });
  }) as typeof globalThis.fetch;
}

/** A Stripe-Signature header for a body, the way Stripe computes it. */
export async function signFauxEvent(body: string, nowMs: number, secret = FAUX_STRIPE_WEBHOOK_SECRET): Promise<string> {
  const seconds = Math.floor(nowMs / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${seconds}.${body}`)));
  return `t=${seconds},v1=${Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export interface FauxPaidSession { sessionId: string; purchaseId: string; organizationId: string; tenantId: string; amountCents: number }

/** The checkout.session.completed event a paid session sends. Its id is the session's, so paying twice is one event. */
export function fauxPaidEvent(session: FauxPaidSession, nowMs: number): string {
  return JSON.stringify({
    id: `evt_faux_${session.sessionId.replace(/^cs_/, '')}`, object: 'event', type: 'checkout.session.completed', created: Math.floor(nowMs / 1000),
    data: { object: {
      id: session.sessionId, object: 'checkout.session', status: 'complete', payment_status: 'paid', amount_total: session.amountCents, currency: 'usd',
      client_reference_id: session.purchaseId,
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
