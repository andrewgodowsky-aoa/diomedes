import { describe, expect, it } from 'vitest';
import { catalogRequests, parsePlanCatalog, reconcileSandboxCatalog, type PlanCatalog } from '../scripts/stripe-plan-catalog.js';

const catalog = (): PlanCatalog => ({ version: 'fixture-v1', sourceCommit: 'a'.repeat(40), currency: 'usd', plans:
  ['individual', 'business', 'workflow-starter', 'managed-small', 'managed-standard', 'managed-plus'].map((id, index) => ({
    id: id as PlanCatalog['plans'][number]['id'], name: `Fixture ${id}`, amountCents: 1000 + index * 100,
    includedCredits: 100 + index,
  })),
});

function fixture() {
  const products = new Map<string, Record<string, unknown>>();
  const prices: Record<string, unknown>[] = [];
  const calls: { url: URL; init: RequestInit; body: URLSearchParams }[] = [];
  let failPriceOnce = false;
  let accountId = 'acct_test';
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(String(init.body ?? ''));
    calls.push({ url, init, body });
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    const metadata = () => Object.fromEntries([...body].filter(([key]) => key.startsWith('metadata['))
      .map(([key, value]) => [key.slice(9, -1), value]));
    if (url.pathname === '/v1/account') return response({ id: accountId, object: 'account' });
    if (url.pathname.startsWith('/v1/products/')) {
      const product = products.get(url.pathname.split('/').at(-1)!);
      return product ? response(product) : response({ error: 'missing' }, 404);
    }
    if (url.pathname === '/v1/products' && init.method === 'POST') {
      const value = { id: body.get('id'), object: 'product', active: true, livemode: false,
        name: body.get('name'), metadata: metadata() };
      products.set(String(value.id), value);
      return response(value);
    }
    if (url.pathname === '/v1/prices' && init.method === 'GET') {
      return response({ object: 'list', has_more: false, data: prices.filter(value => value.lookup_key === url.searchParams.get('lookup_keys[]')
        && String(value.active) === url.searchParams.get('active')) });
    }
    if (url.pathname === '/v1/prices' && init.method === 'POST') {
      const value = { id: `price_fixture_${prices.length}`, object: 'price', active: true, livemode: false,
        product: body.get('product'), currency: body.get('currency'), unit_amount: Number(body.get('unit_amount')),
        lookup_key: body.get('lookup_key'), billing_scheme: 'per_unit', type: 'recurring', transform_quantity: null,
        tiers_mode: null, recurring: { interval: body.get('recurring[interval]'), interval_count: 1, usage_type: 'licensed' },
        metadata: metadata() };
      prices.push(value);
      if (failPriceOnce) { failPriceOnce = false; throw new Error('fixture lost response'); }
      return response(value);
    }
    throw new Error('Unexpected fixture call');
  };
  return { products, prices, calls, fetcher,
    losePriceResponse: () => { failPriceOnce = true; },
    wrongAccount: () => { accountId = 'acct_other'; },
    run: (apply = true, input: unknown = catalog()) => reconcileSandboxCatalog(input, {
      key: 'rk_test_fixture', accountId: 'acct_test', apply, fetch: fetcher,
    }),
  };
}

describe('Stripe sandbox catalog', () => {
  it('prepares distinct products and monthly prices without credentials or network access', () => {
    const rows = catalogRequests(catalog());
    expect(new Set(rows.map(row => row.productId)).size).toBe(6);
    expect(rows.map(row => Number(row.price.unit_amount))).toEqual([1000, 1100, 1200, 1300, 1400, 1500]);
    expect(rows.every(row => row.price['recurring[interval]'] === 'month')).toBe(true);
  });

  it.each([
    ['missing plan', (value: PlanCatalog) => { value.plans.pop(); }],
    ['duplicate plan', (value: PlanCatalog) => { value.plans[1].id = 'individual'; }],
    ['fractional cents', (value: PlanCatalog) => { value.plans[0].amountCents = 10.5; }],
    ['negative price', (value: PlanCatalog) => { value.plans[0].amountCents = -100; }],
    ['invalid provenance', (value: PlanCatalog) => { value.sourceCommit = 'main'; }],
    ['duplicate product mapping', (value: PlanCatalog) => { value.plans[0].existingProductId = value.plans[1].existingProductId = 'prod_same'; }],
  ] as const)('refuses %s before a request', async (_, change) => {
    const value = catalog(); change(value);
    const f = fixture();
    await expect(f.run(true, value)).rejects.toThrow('Invalid catalog');
    expect(f.calls).toHaveLength(0);
  });

  it('rejects unexpected manifest settings instead of ignoring them', () => {
    expect(() => parsePlanCatalog({ ...catalog(), live: true })).toThrow('Invalid catalog');
  });

  it.each(['sk_live_fixture', 'rk_live_fixture', '', 'rk_test_fixture\nInjected: header'])('refuses an unsafe key before networking', async key => {
    const f = fixture();
    await expect(reconcileSandboxCatalog(catalog(), { key, accountId: 'acct_test', apply: true, fetch: f.fetcher })).rejects.toThrow('Live keys are refused');
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a different account before reading or writing its catalog', async () => {
    const f = fixture(); f.wrongAccount();
    await expect(f.run()).rejects.toThrow('different Stripe account');
    expect(f.calls).toHaveLength(1);
  });

  it('inspection makes only GET calls and reports the missing objects', async () => {
    const f = fixture();
    const result = await f.run(false);
    expect(result.applied).toBe(false);
    expect(result.rows.every(row => row.productAction === 'create' && row.priceAction === 'create' && row.priceId === null)).toBe(true);
    expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
    expect(f.products.size).toBe(0);
  });

  it('creates the catalog once and reuses it on the next run', async () => {
    const f = fixture();
    const first = await f.run();
    expect(first.rows.every(row => row.priceId?.startsWith('price_'))).toBe(true);
    expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(12);
    f.calls.length = 0;
    const second = await f.run();
    expect(second.rows.every(row => row.productAction === 'reuse' && row.priceAction === 'reuse')).toBe(true);
    expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
  });

  it('recovers a created price whose successful response was lost without duplicating it', async () => {
    const f = fixture(); f.losePriceResponse();
    await expect(f.run()).rejects.toThrow('Outcome may be unknown');
    expect(f.products.size).toBe(1);
    expect(f.prices).toHaveLength(1);
    await f.run();
    expect(f.products.size).toBe(6);
    expect(f.prices).toHaveLength(6);
  });

  it('reuses a Dashboard product identity instead of creating a duplicate', async () => {
    const f = fixture();
    const input = catalog(); input.plans[0].existingProductId = 'prod_dashboard';
    f.products.set('prod_dashboard', { id: 'prod_dashboard', object: 'product', active: true, livemode: false,
      name: input.plans[0].name, metadata: { nectovia_plan_id: 'individual' } });
    const result = await f.run(true, input);
    expect(result.rows[0]).toMatchObject({ productId: 'prod_dashboard', productAction: 'reuse' });
    expect(f.products.size).toBe(6);
    expect(f.products.has('nectovia_plan_individual')).toBe(false);
  });

  it('refuses a missing mapped product before any write', async () => {
    const f = fixture(); const input = catalog(); input.plans[5].existingProductId = 'prod_missing';
    await expect(f.run(true, input)).rejects.toThrow('Mapped product missing');
    expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
  });

  it.each([
    ['changed amount', (price: Record<string, unknown>) => { price.unit_amount = 1; }],
    ['wrong product', (price: Record<string, unknown>) => { price.product = 'unrelated'; }],
    ['live price', (price: Record<string, unknown>) => { price.livemode = true; }],
    ['archived price', (price: Record<string, unknown>) => { price.active = false; }],
    ['annual price', (price: Record<string, unknown>) => { price.recurring = { interval: 'year', interval_count: 1, usage_type: 'licensed' }; }],
    ['quantity transform', (price: Record<string, unknown>) => { price.transform_quantity = { divide_by: 100 }; }],
    ['changed credits', (price: Record<string, unknown>) => { price.metadata = { ...(price.metadata as object), included_credits: '999999' }; }],
    ['changed provenance', (price: Record<string, unknown>) => { price.metadata = { ...(price.metadata as object), source_commit: 'b'.repeat(40) }; }],
  ] as const)('refuses %s without a write', async (_, change) => {
    const f = fixture(); await f.run(); change(f.prices[5]); f.calls.length = 0;
    await expect(f.run()).rejects.toThrow('Price conflict');
    expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
  });

  it('checks later conflicts before creating an earlier missing product', async () => {
    const f = fixture(); await f.run();
    f.products.delete('nectovia_plan_individual'); f.prices.shift();
    f.prices[4].unit_amount = 1; f.calls.length = 0;
    await expect(f.run()).rejects.toThrow('Price conflict');
    expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
  });

  it('refuses a product with another owner marker', async () => {
    const f = fixture(); await f.run();
    f.products.get('nectovia_plan_business')!.metadata = {}; f.calls.length = 0;
    await expect(f.run()).rejects.toThrow('Product conflict');
    expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
  });

  it('refuses duplicate lookup keys', async () => {
    const f = fixture(); await f.run(); f.prices.push({ ...f.prices[0], id: 'price_duplicate' }); f.calls.length = 0;
    await expect(f.run()).rejects.toThrow('Ambiguous price lookup');
    expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
  });

  it('pins the API, blocks redirects, and provides stable write idempotency keys', async () => {
    const f = fixture(); await f.run();
    for (const call of f.calls) {
      expect(call.url.origin).toBe('https://api.stripe.com');
      expect(call.init.redirect).toBe('error');
      expect(call.init.headers).toMatchObject({ 'Stripe-Version': '2026-08-26.dahlia' });
      if (call.init.method === 'POST') expect(new Headers(call.init.headers).get('Idempotency-Key')).toMatch(/^nectovia-catalog-[a-f0-9]{64}$/);
    }
    const other = fixture(); await other.run();
    expect(f.calls.filter(call => call.init.method === 'POST').map(call => new Headers(call.init.headers).get('Idempotency-Key')))
      .toEqual(other.calls.filter(call => call.init.method === 'POST').map(call => new Headers(call.init.headers).get('Idempotency-Key')));
  });

  it('does not echo Stripe error bodies or transport errors containing secrets', async () => {
    for (const fetcher of [async () => new Response('rk_test_DO_NOT_PRINT', { status: 403 }), async () => { throw new Error('rk_test_DO_NOT_PRINT'); }]) {
      const result = reconcileSandboxCatalog(catalog(), { key: 'rk_test_fixture', accountId: 'acct_test', apply: true, fetch: fetcher });
      await expect(result).rejects.not.toThrow('DO_NOT_PRINT');
    }
  });
});
