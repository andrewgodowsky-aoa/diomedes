/** Prepare or reconcile the public monthly plan catalog in a Stripe sandbox.
 * Prices come from an explicit, reviewed manifest, never from private provider costs.
 * This tool creates Products and Prices only. It cannot create a payment or grant access.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const API_VERSION = '2026-08-26.dahlia';
const planIds = ['individual', 'business', 'workflow-starter', 'managed-small', 'managed-standard', 'managed-plus'] as const;
const planSchema = z.strictObject({
  id: z.enum(planIds),
  name: z.string().min(1).max(120).regex(/^[\x20-\x7e]+$/),
  amountCents: z.number().int().min(50).max(99_999_999),
  includedCredits: z.number().int().min(0).max(1_000_000),
  // Preserve Dashboard-created product identities when reconciling a reviewed catalog.
  existingProductId: z.string().regex(/^prod_[a-zA-Z0-9]+$/).optional(),
});
const catalogSchema = z.strictObject({
  version: z.string().regex(/^[a-zA-Z0-9._-]{1,40}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  currency: z.literal('usd'),
  plans: z.array(planSchema).length(planIds.length),
}).refine(value => new Set(value.plans.map(plan => plan.id)).size === planIds.length, 'Each plan must appear once.')
  .refine(value => {
    const ids = value.plans.flatMap(plan => plan.existingProductId ? [plan.existingProductId] : []);
    return new Set(ids).size === ids.length;
  }, 'Existing product mappings must be unique.');

export type PlanCatalog = z.infer<typeof catalogSchema>;
type Plan = PlanCatalog['plans'][number];

export function parsePlanCatalog(input: unknown): PlanCatalog {
  const parsed = catalogSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid catalog: provide all six unique plans, USD integer cents, a version and a source commit.');
  return parsed.data;
}

export function catalogRequests(input: unknown) {
  const catalog = parsePlanCatalog(input);
  return catalog.plans.map(plan => {
    const productId = plan.existingProductId ?? `nectovia_plan_${plan.id.replaceAll('-', '_')}`;
    const lookupKey = `nectovia_${plan.id}_usd_month_${catalog.version}`;
    return {
      planId: plan.id,
      productId,
      mappedExistingProduct: Boolean(plan.existingProductId),
      lookupKey,
      product: { id: productId, name: plan.name, 'metadata[nectovia_plan_id]': plan.id },
      price: {
        product: productId,
        currency: catalog.currency,
        unit_amount: String(plan.amountCents),
        'recurring[interval]': 'month',
        'recurring[interval_count]': '1',
        'recurring[usage_type]': 'licensed',
        lookup_key: lookupKey,
        'metadata[nectovia_plan_id]': plan.id,
        'metadata[catalog_version]': catalog.version,
        'metadata[source_commit]': catalog.sourceCommit,
        // Informational only: the account service's verified funding records grant credits.
        'metadata[included_credits]': String(plan.includedCredits),
      },
    };
  });
}

const productSchema = z.object({
  id: z.string(), object: z.literal('product'), livemode: z.literal(false),
  active: z.literal(true), name: z.string(), metadata: z.record(z.string(), z.string()),
});
const priceSchema = z.object({
  id: z.string().regex(/^price_[a-zA-Z0-9_]+$/), object: z.literal('price'), livemode: z.literal(false),
  active: z.literal(true), product: z.string(), currency: z.literal('usd'), unit_amount: z.number().int(),
  lookup_key: z.string(), billing_scheme: z.literal('per_unit'), type: z.literal('recurring'),
  transform_quantity: z.null(), tiers_mode: z.null(),
  recurring: z.object({ interval: z.literal('month'), interval_count: z.literal(1), usage_type: z.literal('licensed'),
    trial_period_days: z.null().optional() }),
  metadata: z.record(z.string(), z.string()),
});

type RequestRow = ReturnType<typeof catalogRequests>[number];
export interface CatalogReceipt {
  planId: Plan['id'];
  productId: string;
  priceId: string | null;
  lookupKey: string;
  productAction: 'create' | 'reuse';
  priceAction: 'create' | 'reuse';
}

function verifyProduct(value: unknown, row: RequestRow): void {
  const parsed = productSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== row.productId || parsed.data.name !== row.product.name
    || parsed.data.metadata.nectovia_plan_id !== row.planId)
    throw new Error(`Product conflict for ${row.planId}. No existing product will be changed.`);
}

function verifyPrice(value: unknown, row: RequestRow): string {
  const parsed = priceSchema.safeParse(value);
  if (!parsed.success || parsed.data.product !== row.productId || parsed.data.lookup_key !== row.lookupKey
    || parsed.data.unit_amount !== Number(row.price.unit_amount)
    || parsed.data.metadata.nectovia_plan_id !== row.planId
    || parsed.data.metadata.catalog_version !== row.price['metadata[catalog_version]']
    || parsed.data.metadata.source_commit !== row.price['metadata[source_commit]']
    || parsed.data.metadata.included_credits !== row.price['metadata[included_credits]'])
    throw new Error(`Price conflict for ${row.planId}. Use a reviewed new catalog version; existing prices are never replaced.`);
  return parsed.data.id;
}

/** Follows the account service's REST convention; no SDK or new dependency is required. */
export async function reconcileSandboxCatalog(input: unknown, options: {
  key: string;
  accountId: string;
  apply: boolean;
  fetch?: typeof fetch;
}): Promise<{ accountId: string; environment: 'sandbox'; applied: boolean; rows: CatalogReceipt[] }> {
  const requests = catalogRequests(input);
  if (!/^(rk|sk)_test_[a-zA-Z0-9]+$/.test(options.key))
    throw new Error('STRIPE_SANDBOX_KEY must be a test restricted or secret key. Live keys are refused.');
  if (!/^acct_[a-zA-Z0-9]+$/.test(options.accountId)) throw new Error('Provide the expected sandbox account ID.');
  const send = options.fetch ?? fetch;

  async function request(path: string, body?: Record<string, string>, allowMissing = false): Promise<unknown | null> {
    const encoded = body ? new URLSearchParams(body).toString() : undefined;
    const headers: Record<string, string> = { Authorization: `Bearer ${options.key}`, 'Stripe-Version': API_VERSION };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Idempotency-Key'] = `nectovia-catalog-${createHash('sha256').update(`${options.accountId}\n${path}\n${encoded}`).digest('hex')}`;
    }
    let response: Response;
    try {
      response = await send(`https://api.stripe.com${path}`, {
        method: body ? 'POST' : 'GET', headers, body: encoded, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Transport errors can include request headers. Never echo them. A POST may have succeeded;
      // rerunning inspects the stable product ID and lookup key before issuing the same keyed write.
      throw new Error(`Stripe request failed for ${body ? 'POST' : 'GET'} ${path.split('?')[0]}. Outcome may be unknown; rerun inspection before applying again.`);
    }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Stripe refused ${body ? 'POST' : 'GET'} ${path.split('?')[0]} (HTTP ${response.status}).`);
    try { return await response.json(); }
    catch { throw new Error('Stripe returned an unreadable response. Inspect the sandbox before retrying.'); }
  }

  const account = z.object({ id: z.string(), object: z.literal('account') }).safeParse(await request('/v1/account'));
  if (!account.success || account.data.id !== options.accountId)
    throw new Error('The key belongs to a different Stripe account. No catalog objects were written.');

  // Inspect the entire catalog before the first write, including archived lookup keys.
  const rows: CatalogReceipt[] = [];
  for (const row of requests) {
    const product = await request(`/v1/products/${row.productId}`, undefined, true);
    if (product === null && row.mappedExistingProduct)
      throw new Error(`Mapped product missing for ${row.planId}. Existing mappings are never recreated.`);
    if (product !== null) verifyProduct(product, row);
    const prices: unknown[] = [];
    for (const active of ['true', 'false']) {
      const query = new URLSearchParams({ 'lookup_keys[]': row.lookupKey, limit: '2', active });
      const result = z.object({ object: z.literal('list'), has_more: z.literal(false), data: z.array(z.unknown()).max(1) })
        .safeParse(await request(`/v1/prices?${query}`));
      if (!result.success) throw new Error(`Ambiguous price lookup for ${row.planId}. No catalog objects were written.`);
      prices.push(...result.data.data);
    }
    if (prices.length > 1 || (prices.length > 0 && product === null))
      throw new Error(`Inconsistent catalog for ${row.planId}. No catalog objects were written.`);
    rows.push({ planId: row.planId, productId: row.productId, lookupKey: row.lookupKey,
      priceId: prices.length ? verifyPrice(prices[0], row) : null,
      productAction: product === null ? 'create' : 'reuse', priceAction: prices.length ? 'reuse' : 'create' });
  }
  if (options.apply) {
    for (let i = 0; i < requests.length; i++) {
      const row = requests[i];
      if (rows[i].productAction === 'create') verifyProduct(await request('/v1/products', row.product), row);
      if (rows[i].priceAction === 'create') rows[i].priceId = verifyPrice(await request('/v1/prices', row.price), row);
    }
  }
  return { accountId: account.data.id, environment: 'sandbox', applied: options.apply, rows };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const values: Record<string, string> = {};
  let action: 'prepare' | 'inspect' | 'apply' = 'prepare';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--inspect' || arg === '--apply') {
      if (action !== 'prepare') throw new Error('Choose only one of --inspect and --apply.');
      action = arg === '--inspect' ? 'inspect' : 'apply';
    } else if ((arg === '--catalog' || arg === '--account') && !values[arg] && args[i + 1] && !args[i + 1].startsWith('--')) {
      values[arg] = args[++i];
    } else throw new Error('Usage: tsx scripts/stripe-plan-catalog.ts --catalog manifest.json [--inspect|--apply --account acct_...]');
  }
  if (!values['--catalog']) throw new Error('Provide --catalog with the reviewed public pricing manifest.');
  const input: unknown = JSON.parse(await readFile(resolve(values['--catalog']), 'utf8'));
  const catalog = parsePlanCatalog(input);
  const result = action === 'prepare'
    ? { environment: 'sandbox', applied: false, requests: catalogRequests(catalog) }
    : await reconcileSandboxCatalog(catalog, { key: process.env.STRIPE_SANDBOX_KEY ?? '',
      accountId: values['--account'] ?? '', apply: action === 'apply' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // Syntax errors may quote input fragments, so don't print JSON parse errors from a local file.
    console.error(error instanceof SyntaxError ? 'The catalog file is not valid JSON.' : error instanceof Error ? error.message : 'Catalog preparation failed.');
    process.exitCode = 1;
  });
}
