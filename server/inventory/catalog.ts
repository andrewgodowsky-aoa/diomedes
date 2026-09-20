import { z } from 'zod';
import {
  inventoryCatalogSchema,
  inventoryScopeSchema,
  inventorySourceSchema,
  type InventoryCatalog,
  type InventoryScope,
} from '../../shared/inventory.js';
import { ApiError } from '../paths.js';

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type InventoryCatalogSnapshot = Immutable<InventoryCatalog>;
type Item = InventoryCatalogSnapshot['items'][number];
type Site = InventoryCatalogSnapshot['sites'][number];
type Bin = InventoryCatalogSnapshot['bins'][number];
type Balance = InventoryCatalogSnapshot['balances'][number];
export type InventoryFreshness = 'current' | 'stale' | 'future';

const freshnessSchema = z.strictObject({
  now: inventorySourceSchema.shape.observedAt,
  maxSourceAgeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxCountAgeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type InventoryFreshnessPolicy = z.infer<typeof freshnessSchema>;
const lookupSchema = z.strictObject({
  by: z.enum(['item', 'barcode']),
  value: z.string().min(1).max(128),
});
export type InventoryLookup = z.infer<typeof lookupSchema>;

export interface InventoryLocationView {
  site: Site;
  bin: Bin;
  balance: Balance;
  recordStatus: InventoryFreshness;
  sourceStatus: InventoryFreshness;
  countStatus: InventoryFreshness | 'unknown';
  countLabel: 'Count unknown' | 'Count stale' | 'Count time in future' | 'Recorded count';
}
export type InventoryLookupResult =
  | { status: 'missing' }
  | { status: 'found'; item: Item; locations: InventoryLocationView[] };

/**
 * Scope equality is data validation, never authentication. Both arguments must
 * originate from the owning host's current authorization/target resolution.
 */
export function assertInventoryScope(declared: unknown, host: InventoryScope): InventoryScope {
  const a = inventoryScopeSchema.safeParse(declared);
  const b = inventoryScopeSchema.safeParse(host);
  if (!a.success || !b.success) throw new ApiError(422, 'A complete inventory scope is required.');
  if (
    a.data.tenantId !== b.data.tenantId ||
    a.data.organizationId !== b.data.organizationId ||
    a.data.projectId !== b.data.projectId
  )
    throw new ApiError(403, 'Inventory scope does not match the selected work target.');
  return a.data;
}

function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

function freshness(at: string, now: number, budget: number): InventoryFreshness {
  const age = now - Date.parse(at);
  return age < 0 ? 'future' : age > budget ? 'stale' : 'current';
}

const locationKey = (item: string, site: string, bin: string) => JSON.stringify([item, site, bin]);

/** Immutable, indexed view of one already-read snapshot; no Store, Files or route owner. */
export function createInventoryCatalog(input: unknown, hostScope: InventoryScope) {
  const parsed = inventoryCatalogSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(422, 'Inventory records have invalid identities, references or quantities.');
  const boundScope = assertInventoryScope(parsed.data.scope, hostScope);
  const data = freeze(parsed.data);
  const items = new Map(data.items.map((item) => [item.id, item]));
  const barcodes = new Map<string, Item>();
  for (const item of data.items) for (const code of item.barcodes) barcodes.set(code, item);
  const sites = new Map(data.sites.map((site) => [site.id, site]));
  const bins = new Map(data.bins.map((bin) => [bin.id, bin]));
  const balances = new Map<string, Balance>();
  const byItem = new Map<string, Balance[]>();
  for (const balance of data.balances) {
    balances.set(locationKey(balance.itemId, balance.siteId, balance.binId), balance);
    const list = byItem.get(balance.itemId) ?? [];
    list.push(balance);
    byItem.set(balance.itemId, list);
  }
  const check = (scope: InventoryScope) => assertInventoryScope(scope, boundScope);

  return Object.freeze({
    snapshot(scope: InventoryScope): InventoryCatalogSnapshot {
      check(scope);
      return data;
    },
    getItem(scope: InventoryScope, id: string): Item | null {
      check(scope);
      return items.get(id) ?? null;
    },
    getItemByBarcode(scope: InventoryScope, code: string): Item | null {
      check(scope);
      return barcodes.get(code) ?? null;
    },
    getSite(scope: InventoryScope, id: string): Site | null {
      check(scope);
      return sites.get(id) ?? null;
    },
    getBin(scope: InventoryScope, siteId: string, binId: string): Bin | null {
      check(scope);
      const bin = bins.get(binId);
      return bin?.siteId === siteId ? bin : null;
    },
    getBalance(
      scope: InventoryScope,
      itemId: string,
      siteId: string,
      binId: string,
    ): Balance | null {
      check(scope);
      return balances.get(locationKey(itemId, siteId, binId)) ?? null;
    },
    lookup(
      scope: InventoryScope,
      query: InventoryLookup,
      policy: InventoryFreshnessPolicy,
    ): InventoryLookupResult {
      check(scope);
      const q = lookupSchema.safeParse(query);
      const p = freshnessSchema.safeParse(policy);
      if (!q.success || !p.success)
        throw new ApiError(422, 'Use an exact item or barcode and a valid observation policy.');
      const item = (q.data.by === 'item' ? items : barcodes).get(q.data.value);
      if (!item) return { status: 'missing' };
      const now = Date.parse(p.data.now);
      return {
        status: 'found',
        item,
        locations: (byItem.get(item.id) ?? []).map((balance) => {
          const countStatus =
            balance.lastPhysicalCountAt === null
              ? 'unknown'
              : freshness(balance.lastPhysicalCountAt, now, p.data.maxCountAgeMs);
          return {
            site: sites.get(balance.siteId)!,
            bin: bins.get(balance.binId)!,
            balance,
            recordStatus: freshness(balance.observedAt, now, p.data.maxSourceAgeMs),
            sourceStatus: freshness(balance.source.observedAt, now, p.data.maxSourceAgeMs),
            countStatus,
            countLabel:
              countStatus === 'unknown'
                ? 'Count unknown'
                : countStatus === 'stale'
                  ? 'Count stale'
                  : countStatus === 'future'
                    ? 'Count time in future'
                    : 'Recorded count',
          };
        }),
      };
    },
  });
}

export type InventoryCatalogIndex = ReturnType<typeof createInventoryCatalog>;
