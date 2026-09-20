import { describe, expect, test } from 'vitest';
import {
  inventoryBalanceSchema,
  inventoryCatalogSchema,
  inventoryCommandSchema,
  inventoryItemSchema,
  inventoryQuantitySchema,
  inventoryReceiptSchema,
  inventoryResultSchema,
  parseInventoryCommandForItem,
} from '../shared/inventory.js';

const item = {
  id: 'hinge-brass-left',
  name: 'Brushed brass concealed hinge',
  variant: 'Left hand',
  unit: 'each',
  scale: 0,
  barcodes: ['0001042'],
};
const balance = {
  itemId: item.id,
  siteId: 'north',
  binId: 'rack-a',
  onHandMinor: 5,
  reservedMinor: 2,
  availableMinor: 3,
  unit: 'each',
  scale: 0,
  version: '7',
  observedAt: '2026-09-19T10:00:00Z',
  lastMovementAt: '2026-09-19T09:00:00Z',
  lastPhysicalCountAt: null,
  countEvidence: null,
  source: {
    kind: 'synthetic',
    reference: 'fixture-100',
    revision: '1',
    observedAt: '2026-09-19T10:00:00Z',
  },
};
const use = {
  operationId: 'use-a',
  kind: 'use',
  itemId: item.id,
  siteId: 'north',
  binId: 'rack-a',
  expectedVersion: '7',
  quantity: { minor: 2, scale: 0, unit: 'each' },
  jobId: 'job-42',
};
const catalog = () => ({
  contractVersion: 1,
  scope: { organizationId: 'org-a', tenantId: 'tenant-a', projectId: 'project-a' },
  authority: 'recorded-ledger',
  reservationMode: 'read-only',
  items: [structuredClone(item)],
  sites: [{ id: 'north', name: 'North workshop' }],
  bins: [{ id: 'rack-a', siteId: 'north', name: 'Rack A' }],
  balances: [structuredClone(balance)],
});

describe('settled receipt and timestamp integrity', () => {
  const receipt = () => ({
    id: 'receipt-1',
    operationId: 'use-a',
    scope: { organizationId: 'org-a', tenantId: 'tenant-a', projectId: 'project-a' },
    actorPersonId: 'person-a',
    kind: 'use',
    recordedAt: '2026-09-19T10:00:00Z',
    historyEntryId: 'history-1',
    reason: null as string | null,
    jobId: 'job-42',
    correctsReceiptId: null as string | null,
    changes: [
      {
        itemId: item.id,
        siteId: 'north',
        binId: 'rack-a',
        previousVersion: '7',
        version: '8',
        onHandMinor: 3,
        reservedMinor: 2,
        unit: 'each',
        scale: 0,
      },
    ],
  });

  test('refuses over-reserved stock and a version that did not change', () => {
    const input = receipt();
    input.changes[0].reservedMinor = 4;
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
    input.changes[0].reservedMinor = 2;
    input.changes[0].version = '7';
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
  });

  test('transfers require two distinct compatible endpoints and other actions require one', () => {
    const input = receipt();
    input.kind = 'transfer';
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
    input.changes.push({ ...input.changes[0] });
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
    input.changes[1].binId = 'rack-b';
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(true);
    for (const field of ['itemId', 'unit', 'scale'] as const) {
      const mismatch = structuredClone(input);
      if (field === 'scale') mismatch.changes[1].scale = 2;
      else mismatch.changes[1][field] = 'other';
      expect(inventoryReceiptSchema.safeParse(mismatch).success).toBe(false);
    }
    input.kind = 'use';
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
  });

  test('adjustment and correction keep their required reason after settling', () => {
    const input = receipt();
    input.kind = 'adjust';
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
    input.reason = 'Correct damaged count';
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(true);
    input.kind = 'receive';
    input.correctsReceiptId = 'receipt-old';
    input.reason = null;
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
  });

  test('rejects sub-millisecond timestamps rather than silently discarding ordering precision', () => {
    expect(
      inventoryBalanceSchema.safeParse({ ...balance, observedAt: '2026-09-19T10:00:00.0001Z' })
        .success,
    ).toBe(false);
    expect(
      inventoryBalanceSchema.safeParse({
        ...balance,
        source: { ...balance.source, observedAt: '2026-09-19T10:00:00.0009Z' },
      }).success,
    ).toBe(false);
    expect(
      inventoryBalanceSchema.safeParse({ ...balance, observedAt: '2026-09-19T10:00:00.001Z' })
        .success,
    ).toBe(true);
  });
});

describe('inventory contract rejects ambiguous or unsafe stock records', () => {
  test('keeps integer precision and leading-zero barcode identity', () => {
    expect(inventoryQuantitySchema.parse({ minor: 1200, scale: 2, unit: 'board-ft' })).toEqual({
      minor: 1200,
      scale: 2,
      unit: 'board-ft',
    });
    expect(inventoryItemSchema.parse(item).barcodes).toEqual(['0001042']);
    expect(inventoryCatalogSchema.parse(catalog()).balances[0].availableMinor).toBe(3);
  });

  test.each([
    { minor: -1, scale: 0, unit: 'each' },
    { minor: 9007199254740992, scale: 0, unit: 'each' },
    { minor: 1.2, scale: 0, unit: 'each' },
    { minor: 1, scale: -1, unit: 'each' },
    { minor: 1, scale: 7, unit: 'each' },
    { minor: 1, scale: 0, unit: '' },
    { minor: '2', scale: 0, unit: 'each' },
  ])('rejects malformed fixed-scale quantity %j', (quantity) => {
    expect(inventoryQuantitySchema.safeParse(quantity).success).toBe(false);
  });

  test('preserves unknown on-hand and untracked reservations instead of inventing availability', () => {
    expect(
      inventoryBalanceSchema.parse({ ...balance, onHandMinor: null, availableMinor: null })
        .availableMinor,
    ).toBeNull();
    expect(
      inventoryBalanceSchema.parse({ ...balance, reservedMinor: null, availableMinor: null })
        .availableMinor,
    ).toBeNull();
    expect(
      inventoryBalanceSchema.safeParse({ ...balance, onHandMinor: null, availableMinor: 0 })
        .success,
    ).toBe(false);
    expect(
      inventoryBalanceSchema.safeParse({ ...balance, reservedMinor: null, availableMinor: 5 })
        .success,
    ).toBe(false);
  });

  test('rejects invented availability and reservation deficits', () => {
    expect(inventoryBalanceSchema.safeParse({ ...balance, availableMinor: 4 }).success).toBe(false);
    expect(
      inventoryBalanceSchema.safeParse({ ...balance, reservedMinor: 6, availableMinor: -1 })
        .success,
    ).toBe(false);
  });

  test('does not turn sync or movement time into a physical count', () => {
    expect(inventoryBalanceSchema.parse(balance).lastPhysicalCountAt).toBeNull();
    expect(
      inventoryBalanceSchema.safeParse({ ...balance, lastPhysicalCountAt: '2026-09-19T08:00:00Z' })
        .success,
    ).toBe(false);
    expect(
      inventoryBalanceSchema.safeParse({ ...balance, lastMovementAt: '2026-09-20T00:00:00Z' })
        .success,
    ).toBe(false);
    expect(
      inventoryBalanceSchema.safeParse({
        ...balance,
        source: { ...balance.source, observedAt: '2026-09-20T00:00:00Z' },
      }).success,
    ).toBe(false);
  });

  test('accepts an explicitly evidenced count separately from source observation', () => {
    const counted = {
      ...balance,
      lastPhysicalCountAt: '2026-09-19T08:00:00Z',
      countEvidence: { countedAt: '2026-09-19T08:00:00Z', reference: 'count-sheet-9' },
    };
    expect(inventoryBalanceSchema.parse(counted).countEvidence?.reference).toBe('count-sheet-9');
    expect(
      inventoryBalanceSchema.safeParse({ ...counted, lastPhysicalCountAt: null }).success,
    ).toBe(false);
  });

  test.each(['items', 'sites', 'bins', 'balances'] as const)(
    'rejects duplicate %s identities',
    (collection) => {
      const input = catalog();
      const rows = input[collection] as unknown[];
      rows.push(structuredClone(rows[0]));
      expect(inventoryCatalogSchema.safeParse(input).success).toBe(false);
    },
  );

  test('rejects ambiguous barcodes across variants and duplicate codes on one item', () => {
    expect(
      inventoryItemSchema.safeParse({ ...item, barcodes: ['0001042', '0001042'] }).success,
    ).toBe(false);
    const input = catalog();
    input.items.push({ ...item, id: 'hinge-right', variant: 'Right hand' });
    expect(inventoryCatalogSchema.safeParse(input).success).toBe(false);
  });

  test('rejects missing or mismatched catalog references and units', () => {
    for (const changes of [
      { itemId: 'absent' },
      { siteId: 'absent' },
      { binId: 'absent' },
      { unit: 'box' },
      { scale: 2 },
    ]) {
      const input = catalog();
      Object.assign(input.balances[0], changes);
      expect(inventoryCatalogSchema.safeParse(input).success).toBe(false);
    }
    const input = catalog();
    input.sites.push({ id: 'south', name: 'South workshop' });
    input.bins[0].siteId = 'south';
    expect(inventoryCatalogSchema.safeParse(input).success).toBe(false);
  });

  test('untracked reservations cannot contain a fabricated known reservation', () => {
    const input = { ...catalog(), reservationMode: 'untracked' };
    expect(inventoryCatalogSchema.safeParse(input).success).toBe(false);
    Object.assign(input.balances[0], { reservedMinor: null, availableMinor: null });
    expect(inventoryCatalogSchema.safeParse(input).success).toBe(true);
  });
});

describe('inventory commands carry intent, never client authority', () => {
  test('accepts a positive amount and rejects amount coercion or zero use', () => {
    expect(inventoryCommandSchema.parse(use)).toEqual(use);
    expect(
      inventoryCommandSchema.safeParse({ ...use, quantity: { ...use.quantity, minor: 0 } }).success,
    ).toBe(false);
    expect(
      inventoryCommandSchema.safeParse({ ...use, quantity: { ...use.quantity, minor: -1 } })
        .success,
    ).toBe(false);
  });

  test.each(['actor', 'role', 'tenantId', 'organizationId', 'principal', 'authorized', 'grants'])(
    'rejects unsigned client %s claims',
    (field) => {
      expect(inventoryCommandSchema.safeParse({ ...use, [field]: 'owner' }).success).toBe(false);
    },
  );

  test('requires both transfer versions and a different destination', () => {
    const transfer = {
      ...use,
      kind: 'transfer',
      destination: { siteId: 'south', binId: 'rack-b', expectedVersion: '4' },
    };
    expect(inventoryCommandSchema.safeParse(transfer).success).toBe(true);
    expect(
      inventoryCommandSchema.safeParse({
        ...transfer,
        destination: { siteId: 'south', binId: 'rack-b' },
      }).success,
    ).toBe(false);
    expect(
      inventoryCommandSchema.safeParse({
        ...transfer,
        destination: { siteId: 'north', binId: 'rack-a', expectedVersion: '7' },
      }).success,
    ).toBe(false);
  });

  test('adjustment sets an explicit nonnegative target with a reason, not an ambiguous delta', () => {
    const adjustment = {
      ...use,
      kind: 'adjust',
      quantity: { ...use.quantity, minor: 0 },
      reason: 'Damaged stock removed',
    };
    expect(inventoryCommandSchema.safeParse(adjustment).success).toBe(true);
    expect(inventoryCommandSchema.safeParse({ ...adjustment, reason: '   ' }).success).toBe(false);
    expect(inventoryCommandSchema.safeParse({ ...adjustment, delta: -2 }).success).toBe(false);
  });

  test('an opening physical count requires its own time and source evidence', () => {
    const count = {
      ...use,
      kind: 'record-count',
      countEvidence: { countedAt: '2026-09-19T08:00:00Z', reference: 'count-sheet-9' },
    };
    expect(inventoryCommandSchema.safeParse(count).success).toBe(true);
    expect(inventoryCommandSchema.safeParse({ ...use, kind: 'record-count' }).success).toBe(false);
  });

  test('binds command item, exact units and declared precision before arithmetic', () => {
    expect(parseInventoryCommandForItem(use, item).quantity.minor).toBe(2);
    expect(() => parseInventoryCommandForItem({ ...use, itemId: 'other' }, item)).toThrow();
    expect(() =>
      parseInventoryCommandForItem({ ...use, quantity: { ...use.quantity, unit: 'box' } }, item),
    ).toThrow();
    expect(() =>
      parseInventoryCommandForItem({ ...use, quantity: { ...use.quantity, scale: 2 } }, item),
    ).toThrow();
  });

  test('keeps a version conflict and an uncertain effect distinct from success', () => {
    expect(inventoryResultSchema.parse({ status: 'conflict', currentVersion: '8' }).status).toBe(
      'conflict',
    );
    expect(
      inventoryResultSchema.parse({
        status: 'uncertain',
        operationId: 'use-a',
        reason: 'Reconcile the original operation before retrying.',
      }).status,
    ).toBe('uncertain');
    expect(inventoryResultSchema.safeParse({ status: 'applied', version: '8' }).success).toBe(
      false,
    );
  });
});
