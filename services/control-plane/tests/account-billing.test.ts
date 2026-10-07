import { describe, expect, it } from 'vitest';
import { readSubscriptionCatalog, paidSubscription } from '../src/subscriptions.js';

const start = Date.parse('2026-10-07T00:00:00Z') / 1000;
const end = Date.parse('2026-11-07T00:00:00Z') / 1000;
const catalog = [{ id: 'individual' as const, priceId: 'price_individual', amountCents: 20000 }];
const subscription = () => ({ id: 'sub_a', customer: 'cus_a', livemode: false, status: 'active', start_date: start, billing_cycle_anchor: start,
  items: { has_more: false, data: [{ id: 'si_a', current_period_start: start, current_period_end: end, quantity: 1, price: { id: 'price_individual', currency: 'usd', unit_amount: 20000, recurring: { interval: 'month', interval_count: 1 } } }] },
  latest_invoice: { id: 'in_a', customer: 'cus_a', livemode: false, status: 'paid', amount_remaining: 0, currency: 'usd', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_a' } },
    lines: { has_more: false, data: [{ period: { start, end }, pricing: { price_details: { price: 'price_individual' } }, parent: { subscription_item_details: { subscription_item: 'si_a', proration: false } } }] } } });
describe('verified subscription periods', () => {
  it('derives access from the current paid invoice and exact calendar boundaries', () => {
    expect(paidSubscription(subscription(), 'cus_a', 'test', catalog)).toMatchObject({ id: 'sub_a', planId: 'individual', invoiceId: 'in_a', validFrom: '2026-10-07T00:00:00.000Z', validUntil: '2026-11-07T00:00:00.000Z', billingCycle: { index: 0 } });
  });
  it.each(['incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'canceled', 'paused', 'trialing'])('does not grant for %s', status => {
    expect(paidSubscription({ ...subscription(), status }, 'cus_a', 'test', catalog)).toBeNull();
  });
  it('refuses other customers, modes, unknown prices and unpaid invoices', () => {
    expect(paidSubscription(subscription(), 'cus_b', 'test', catalog)).toBeNull();
    expect(paidSubscription(subscription(), 'cus_a', 'live', catalog)).toBeNull();
    expect(paidSubscription(subscription(), 'cus_a', 'test', [])).toBeNull();
    const input = subscription(); input.latest_invoice.status = 'open';
    expect(paidSubscription(input, 'cus_a', 'test', catalog)).toBeNull();
  });
  it('refuses partial lines, prorations, wrong periods and quantities', () => {
    const variants = [subscription(), subscription(), subscription(), subscription()];
    variants[0].latest_invoice.lines.has_more = true;
    variants[1].latest_invoice.lines.data[0].parent.subscription_item_details.proration = true;
    variants[2].latest_invoice.lines.data[0].period.end -= 1000;
    variants[3].items.data[0].quantity = 2;
    for (const input of variants) expect(paidSubscription(input, 'cus_a', 'test', catalog)).toBeNull();
  });
  it('catalog settings are reviewed server values and fail closed on duplicate or unexpected fields', () => {
    expect(readSubscriptionCatalog({ STRIPE_SUBSCRIPTION_CATALOG: JSON.stringify(catalog) })).toEqual(catalog);
    for (const bad of ['not json', JSON.stringify([...catalog, ...catalog]), JSON.stringify([{ ...catalog[0], secret: 'wrong' }])])
      expect(readSubscriptionCatalog({ STRIPE_SUBSCRIPTION_CATALOG: bad })).toEqual([]);
  });
});
