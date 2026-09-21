import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import type { InventoryCatalog, InventoryScope } from '../shared/inventory.js';
import { createInventoryCatalog } from '../server/inventory/catalog.js';

const scope: InventoryScope = {
  organizationId: 'org-a',
  tenantId: 'tenant-a',
  projectId: 'project-a',
};
const observedAt = '2026-09-19T12:00:00.000Z';
const clock = {
  now: '2026-09-19T12:01:00.000Z',
  maxSourceAgeMs: 120_000,
  maxCountAgeMs: 86_400_000,
};

function fixture(size = 1): InventoryCatalog {
  return {
    contractVersion: 1,
    scope: { ...scope },
    authority: 'recorded-ledger',
    reservationMode: 'read-only',
    items: Array.from({ length: size }, (_, i) => ({
      id: `hinge-${i}`,
      name: i === 3 ? `Synthetic ${'long label '.repeat(40)}` : 'Synthetic hinge',
      variant: i % 2 ? 'Left' : 'Right',
      unit: 'each',
      scale: 0,
      barcodes: [`000${1042 + i}`],
    })),
    sites: [
      { id: 'north', name: 'Fictional North warehouse' },
      { id: 'south', name: 'Fictional South warehouse' },
    ],
    bins: [
      { id: 'north-a', siteId: 'north', name: 'Shelf A' },
      { id: 'north-b', siteId: 'north', name: 'Shelf B' },
      { id: 'south-a', siteId: 'south', name: 'Shelf A' },
    ],
    balances: Array.from({ length: size }, (_, i) => ({
      itemId: `hinge-${i}`,
      siteId: i % 2 ? 'south' : 'north',
      binId: i % 2 ? 'south-a' : 'north-a',
      onHandMinor: i === 0 ? null : i === 1 ? 1 : 10,
      reservedMinor: i === 1 ? 0 : 2,
      availableMinor: i === 0 ? null : i === 1 ? 1 : 8,
      unit: 'each',
      scale: 0,
      version: 'v1',
      observedAt,
      lastMovementAt: null,
      lastPhysicalCountAt: i === 2 ? '2026-08-01T10:00:00Z' : null,
      countEvidence:
        i === 2 ? { countedAt: '2026-08-01T10:00:00Z', reference: 'synthetic-old-count' } : null,
      source: { kind: 'synthetic', reference: 'demo-source', revision: 'r1', observedAt },
    })),
  };
}

describe('scope-bound recorded inventory', () => {
  test('preserves the unknown-count and leading-zero barcode regression', () => {
    const catalog = createInventoryCatalog(fixture(), scope);
    const result = catalog.lookup(scope, { by: 'barcode', value: '0001042' }, clock);
    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('Expected a recorded item.');
    expect(result.item).toMatchObject({ id: 'hinge-0', variant: 'Right', barcodes: ['0001042'] });
    expect(result.locations[0]).toMatchObject({
      balance: { onHandMinor: null, availableMinor: null },
      countStatus: 'unknown',
      countLabel: 'Count unknown',
      sourceStatus: 'current',
    });
    expect(catalog.getItemByBarcode(scope, '1042')).toBeNull();
    expect(catalog.lookup(scope, { by: 'barcode', value: 'unknown' }, clock)).toEqual({
      status: 'missing',
    });
  });

  test.each(['organizationId', 'tenantId', 'projectId'] as const)(
    'rejects a different host %s on construction and every read',
    (key) => {
      const wrong = { ...scope, [key]: 'another' };
      expect(() => createInventoryCatalog(fixture(), wrong)).toThrow();
      const catalog = createInventoryCatalog(fixture(), scope);
      for (const read of [
        () => catalog.snapshot(wrong),
        () => catalog.getItem(wrong, 'hinge-0'),
        () => catalog.getItemByBarcode(wrong, '0001042'),
        () => catalog.getSite(wrong, 'north'),
        () => catalog.getBin(wrong, 'north', 'north-a'),
        () => catalog.getBalance(wrong, 'hinge-0', 'north', 'north-a'),
        () => catalog.lookup(wrong, { by: 'item', value: 'hinge-0' }, clock),
      ])
        expect(read).toThrow();
    },
  );

  test('indexes physical sites/bins and does not create stock or stations', () => {
    const data = fixture();
    data.balances.push({
      ...data.balances[0],
      siteId: 'south',
      binId: 'south-a',
      onHandMinor: 5,
      reservedMinor: 1,
      availableMinor: 4,
    });
    const catalog = createInventoryCatalog(data, scope);
    expect(catalog.getSite(scope, 'south')?.name).toBe('Fictional South warehouse');
    expect(catalog.getSite(scope, 'tablet-1')).toBeNull();
    expect(catalog.getBin(scope, 'south', 'north-a')).toBeNull();
    expect(catalog.getBalance(scope, 'hinge-0', 'south', 'south-a')?.availableMinor).toBe(4);
    expect(catalog.getBalance(scope, 'hinge-0', 'north', 'north-b')).toBeNull();
    const result = catalog.lookup(scope, { by: 'item', value: 'hinge-0' }, clock);
    expect(result.status === 'found' && result.locations.map((row) => row.site.id)).toEqual([
      'north',
      'south',
    ]);
    data.items.push({ ...data.items[0], id: 'unrecorded', barcodes: [] });
    const unrecorded = createInventoryCatalog(data, scope).lookup(
      scope,
      { by: 'item', value: 'unrecorded' },
      clock,
    );
    expect(unrecorded.status === 'found' && unrecorded.locations).toEqual([]);
  });

  test('does not allow caller mutation to corrupt indexed identity or quantities', () => {
    const data = fixture();
    const catalog = createInventoryCatalog(data, scope);
    data.items[0].barcodes[0] = 'changed';
    data.balances[0].onHandMinor = 99;
    const item = catalog.getItem(scope, 'hinge-0')!;
    expect(() => {
      (item.barcodes as string[])[0] = 'changed-again';
    }).toThrow();
    expect(catalog.getItemByBarcode(scope, '0001042')?.id).toBe('hinge-0');
    expect(catalog.getBalance(scope, 'hinge-0', 'north', 'north-a')?.onHandMinor).toBeNull();
  });

  test.each([
    (d: InventoryCatalog) => d.items.push(d.items[0]),
    (d: InventoryCatalog) => d.items.push({ ...d.items[0], id: 'other' }),
    (d: InventoryCatalog) => {
      d.items[0].id = '';
    },
    (d: InventoryCatalog) => {
      d.balances[0].unit = 'box';
    },
    (d: InventoryCatalog) => {
      d.balances[0].scale = 2;
    },
    (d: InventoryCatalog) => {
      d.balances[0].binId = 'absent';
    },
    (d: InventoryCatalog) => d.balances.push(d.balances[0]),
    (d: InventoryCatalog) => {
      d.reservationMode = 'untracked';
    },
  ])('refuses malformed catalog identity, location or quantity (%#)', (mutate) => {
    const data = fixture();
    mutate(data);
    expect(() => createInventoryCatalog(data, scope)).toThrow();
  });

  test('keeps source freshness separate from stale physical-count evidence', () => {
    const data = fixture();
    const countedAt = '2026-09-01T10:00:00Z';
    Object.assign(data.balances[0], {
      onHandMinor: 0,
      reservedMinor: 0,
      availableMinor: 0,
      lastPhysicalCountAt: countedAt,
      countEvidence: { countedAt, reference: 'count-sheet-1' },
    });
    const result = createInventoryCatalog(data, scope).lookup(
      scope,
      { by: 'item', value: 'hinge-0' },
      clock,
    );
    expect(result.status === 'found' && result.locations[0]).toMatchObject({
      sourceStatus: 'current',
      countStatus: 'stale',
      countLabel: 'Count stale',
      balance: { availableMinor: 0 },
    });
  });

  test('labels old observations and future clock skew explicitly', () => {
    const catalog = createInventoryCatalog(fixture(), scope);
    const old = catalog.lookup(
      scope,
      { by: 'item', value: 'hinge-0' },
      { ...clock, maxSourceAgeMs: 1 },
    );
    expect(old.status === 'found' && old.locations[0].sourceStatus).toBe('stale');
    const future = catalog.lookup(
      scope,
      { by: 'item', value: 'hinge-0' },
      { ...clock, now: '2026-09-18T12:00:00Z' },
    );
    expect(future.status === 'found' && future.locations[0].sourceStatus).toBe('future');
  });

  test.each([100, 1000])('measures exact lookups on %i deterministic synthetic items', (size) => {
    const began = performance.now();
    const catalog = createInventoryCatalog(fixture(size), scope);
    const constructionMs = performance.now() - began;
    const samples: number[] = [];
    for (let n = 0; n < 1000; n++) {
      const i = n % size;
      const start = performance.now();
      const result = catalog.lookup(scope, { by: 'barcode', value: `000${1042 + i}` }, clock);
      samples.push(performance.now() - start);
      expect(result.status === 'found' && result.item.id).toBe(`hinge-${i}`);
    }
    samples.sort((a, b) => a - b);
    console.info(
      JSON.stringify({
        measurement: 'pure-catalog-local',
        items: size,
        sites: 2,
        bins: 3,
        constructionMs,
        requests: samples.length,
        failedRequests: 0,
        p50Ms: samples[499],
        p95Ms: samples[949],
      }),
    );
  });
});
