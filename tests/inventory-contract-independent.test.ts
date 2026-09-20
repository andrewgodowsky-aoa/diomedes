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

const at = '2026-09-19T10:00:00Z';
const item = {
  id: 'part-1', name: 'Part', variant: null, unit: 'each', scale: 0, barcodes: ['00017'],
};
const stock = {
  itemId: 'part-1', siteId: 'site-1', binId: 'bin-1', onHandMinor: 8,
  reservedMinor: 3, availableMinor: 5, unit: 'each', scale: 0, version: 'v1',
  observedAt: at, lastMovementAt: null, lastPhysicalCountAt: null, countEvidence: null,
  source: { kind: 'synthetic', reference: 'review-fixture', revision: '1', observedAt: at },
};
const command = {
  kind: 'use', operationId: 'op-1', itemId: 'part-1', siteId: 'site-1', binId: 'bin-1',
  expectedVersion: 'v1', quantity: { minor: 2, scale: 0, unit: 'each' },
};
function catalog() {
  return {
    contractVersion: 1,
    scope: { organizationId: 'org-1', tenantId: 'tenant-1', projectId: 'project-1' },
    authority: 'recorded-ledger', reservationMode: 'read-only', items: [structuredClone(item)],
    sites: [{ id: 'site-1', name: 'Site' }], bins: [{ id: 'bin-1', siteId: 'site-1', name: 'Bin' }],
    balances: [structuredClone(stock)],
  };
}
function receipt() {
  return {
    id: 'receipt-1', operationId: 'op-1', scope: catalog().scope, actorPersonId: 'person-1',
    kind: 'use', recordedAt: at, historyEntryId: 'history-1', reason: null, jobId: null,
    correctsReceiptId: null,
    changes: [{ itemId: 'part-1', siteId: 'site-1', binId: 'bin-1', previousVersion: 'v1',
      version: 'v2', onHandMinor: 6, reservedMinor: 3, unit: 'each', scale: 0 }],
  };
}

describe('independent MI00 quantity and input boundaries', () => {
  test.each([NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', null, true])(
    'rejects non-safe minor quantity %s', (minor) => {
      expect(inventoryQuantitySchema.safeParse({ minor, scale: 0, unit: 'each' }).success).toBe(false);
    },
  );
  test('preserves the maximum safe amount and exact subtraction at the boundary', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(inventoryQuantitySchema.parse({ minor: max, scale: 6, unit: 'board-ft' }).minor).toBe(max);
    expect(inventoryBalanceSchema.parse({ ...stock, onHandMinor: max, reservedMinor: max - 1,
      availableMinor: 1 }).availableMinor).toBe(1);
  });
  test.each(['../outside', 'a/b', 'a\\b', 'a:b', 'a\u0000b', ' a', 'a ', 'a\n', 'a\r', 'a\u2028'])(
    'rejects hostile or noncanonical item ID %j', (id) => {
      expect(inventoryItemSchema.safeParse({ ...item, id }).success).toBe(false);
    },
  );
  test.each(['each\n', 'each\r', 'each\u2028'])(
    'rejects line terminators in unit %j', (unit) => {
      expect(inventoryQuantitySchema.safeParse({ minor: 1, scale: 0, unit }).success).toBe(false);
    },
  );
  test.each(['00017\n', '00017\r', '00017\u2028'])(
    'rejects line terminators in barcode %j', (code) => {
      expect(inventoryItemSchema.safeParse({ ...item, barcodes: [code] }).success).toBe(false);
    },
  );
  test('keeps lookalike labels and leading-zero barcodes as separate records', () => {
    const input = catalog();
    input.items.push({ ...item, id: 'part-2', barcodes: ['17'] });
    expect(inventoryCatalogSchema.parse(input).items.map((value) => value.barcodes[0]))
      .toEqual(['00017', '17']);
  });
  test.each(['actorPersonId', 'scope', 'projectId', 'capabilities', 'authority', 'role', 'principalRef'])(
    'refuses client-supplied authority field %s', (field) => {
      expect(inventoryCommandSchema.safeParse({ ...command, [field]: 'forged' }).success).toBe(false);
    },
  );
  test('refuses authority fields nested in quantities and destinations', () => {
    expect(inventoryCommandSchema.safeParse({ ...command,
      quantity: { ...command.quantity, role: 'owner' } }).success).toBe(false);
    expect(inventoryCommandSchema.safeParse({ ...command, kind: 'transfer', destination: {
      siteId: 'site-2', binId: 'bin-2', expectedVersion: 'v1', tenantId: 'other',
    } }).success).toBe(false);
  });
  test('binds both exact item identity and precision at the exported domain seam', () => {
    expect(() => parseInventoryCommandForItem({ ...command, itemId: 'part-2' }, item)).toThrow();
    expect(() => parseInventoryCommandForItem({ ...command,
      quantity: { ...command.quantity, scale: 1 } }, item)).toThrow();
  });
});

describe('independent MI00 catalog and provenance boundaries', () => {
  test.each([[null, null], [null, 0], [8, null]] as const)(
    'retains unknown availability for onHand=%s reserved=%s', (onHandMinor, reservedMinor) => {
      expect(inventoryBalanceSchema.parse({ ...stock, onHandMinor, reservedMinor,
        availableMinor: null }).availableMinor).toBeNull();
      expect(inventoryBalanceSchema.safeParse({ ...stock, onHandMinor, reservedMinor,
        availableMinor: 0 }).success).toBe(false);
    },
  );
  test('refuses missing sites, missing bins and duplicate stock addresses', () => {
    const missingSite = catalog();
    missingSite.sites = [];
    expect(inventoryCatalogSchema.safeParse(missingSite).success).toBe(false);
    const missingBin = catalog();
    missingBin.bins = [];
    expect(inventoryCatalogSchema.safeParse(missingBin).success).toBe(false);
    const duplicate = catalog();
    duplicate.balances.push({ ...stock, version: 'v2' });
    expect(inventoryCatalogSchema.safeParse(duplicate).success).toBe(false);
  });
  test('validates prototype-looking opaque IDs without object-map aliasing', () => {
    const input = catalog();
    input.items[0].id = 'constructor';
    input.balances[0].itemId = 'constructor';
    expect(inventoryCatalogSchema.parse(input).items[0].id).toBe('constructor');
  });
  test.each(['onHandMinor', 'reservedMinor', 'availableMinor'] as const)(
    'refuses unsafe stock component %s', (field) => {
      expect(inventoryBalanceSchema.safeParse({ ...stock,
        [field]: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    },
  );
  test('does not substitute an imported observation for a physical count', () => {
    const input = { ...stock, source: { ...stock.source, kind: 'approved-file' } };
    expect(inventoryBalanceSchema.parse(input).lastPhysicalCountAt).toBeNull();
    expect(inventoryBalanceSchema.safeParse({ ...input, lastPhysicalCountAt: at }).success).toBe(false);
  });
  test('rejects a physical count after the enclosing observation', () => {
    const future = '2026-09-19T10:00:01Z';
    expect(inventoryBalanceSchema.safeParse({ ...stock, lastPhysicalCountAt: future,
      countEvidence: { countedAt: future, reference: 'sheet-1' } }).success).toBe(false);
  });
  test('compares timestamp instants across offsets, not lexicographic strings', () => {
    expect(inventoryBalanceSchema.safeParse({ ...stock, lastMovementAt: '2026-09-19T09:30:00-01:00' })
      .success).toBe(false);
    expect(inventoryBalanceSchema.safeParse({ ...stock, lastMovementAt: '2026-09-19T11:00:00+01:00' })
      .success).toBe(true);
  });
  test.each(['+24:00', '+00:60', '+99:99'])(
    'rejects an unparseable observation offset %s instead of disabling chronology', (offset) => {
      expect(inventoryBalanceSchema.safeParse({ ...stock,
        observedAt: `2026-09-19T10:00:00${offset}`,
        lastMovementAt: '2099-01-01T00:00:00Z',
      }).success).toBe(false);
    },
  );
  test('rejects source timestamps that cannot denote an instant', () => {
    expect(inventoryBalanceSchema.safeParse({ ...stock, source: { ...stock.source,
      observedAt: '2099-01-01T00:00:00+99:99' } }).success).toBe(false);
  });
  test('rejects a count evidence time that cannot denote an instant', () => {
    const invalid = '2099-01-01T00:00:00+99:99';
    expect(inventoryBalanceSchema.safeParse({ ...stock, lastPhysicalCountAt: invalid,
      countEvidence: { countedAt: invalid, reference: 'sheet-1' } }).success).toBe(false);
  });
  test('rejects a physical count later than observation at accepted fractional precision', () => {
    const observedAt = '2026-09-19T10:00:00.0001Z';
    const countedAt = '2026-09-19T10:00:00.0009Z';
    expect(inventoryBalanceSchema.safeParse({ ...stock, observedAt,
      lastPhysicalCountAt: countedAt, countEvidence: { countedAt, reference: 'sheet-1' },
      source: { ...stock.source, observedAt },
    }).success).toBe(false);
  });
  test('rejects source observation later than record at accepted fractional precision', () => {
    expect(inventoryBalanceSchema.safeParse({ ...stock,
      observedAt: '2026-09-19T10:00:00.0001Z',
      source: { ...stock.source, observedAt: '2026-09-19T10:00:00.0009Z' },
    }).success).toBe(false);
  });
  test('rejects mismatched count provenance at accepted fractional precision', () => {
    expect(inventoryBalanceSchema.safeParse({ ...stock,
      lastPhysicalCountAt: '2026-09-19T09:00:00.0001Z',
      countEvidence: { countedAt: '2026-09-19T09:00:00.0009Z', reference: 'sheet-1' },
    }).success).toBe(false);
  });
  test('refuses an incompatible contract version and a second writable owner', () => {
    expect(inventoryCatalogSchema.safeParse({ ...catalog(), contractVersion: 2 }).success).toBe(false);
    expect(inventoryCatalogSchema.safeParse({ ...catalog(), authority: 'connected' }).success).toBe(false);
  });
});

describe('independent MI00 command and settled receipt structure', () => {
  test('requires transfer destination version while admitting a distinct endpoint', () => {
    const input = { ...command, kind: 'transfer', destination: {
      siteId: 'site-1', binId: 'bin-2', expectedVersion: 'v8',
    } };
    expect(inventoryCommandSchema.safeParse(input).success).toBe(true);
    expect(inventoryCommandSchema.safeParse({ ...input, destination: {
      siteId: 'site-1', binId: 'bin-2',
    } }).success).toBe(false);
  });
  test('keeps zero target counts separate from positive movement amounts', () => {
    const zero = { ...command, quantity: { ...command.quantity, minor: 0 } };
    for (const kind of ['receive', 'use']) {
      expect(inventoryCommandSchema.safeParse({ ...zero, kind }).success).toBe(false);
    }
    expect(inventoryCommandSchema.safeParse({ ...zero, kind: 'record-count', countEvidence: {
      countedAt: at, reference: 'empty-bin-check',
    } }).success).toBe(true);
  });
  test('requires a reason for corrective commands', () => {
    expect(inventoryCommandSchema.safeParse({ ...command, correctsReceiptId: 'older' }).success).toBe(false);
  });
  test('supports attributable settled receipts and explicit uncertainty without fake success', () => {
    for (const status of ['applied', 'already-applied']) {
      expect(inventoryResultSchema.safeParse({ status, receipt: receipt() }).success).toBe(true);
      expect(inventoryResultSchema.safeParse({ status, receiptId: 'receipt-1' }).success).toBe(false);
    }
    expect(inventoryResultSchema.safeParse({ status: 'uncertain', operationId: 'op-1',
      reason: 'Reconcile before another effect.' }).success).toBe(true);
  });
  test('rejects a settled receipt with reserved stock above on-hand', () => {
    const input = receipt();
    input.changes[0].reservedMinor = 7;
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
  });
  test('rejects a settled transfer missing its other endpoint', () => {
    expect(inventoryReceiptSchema.safeParse({ ...receipt(), kind: 'transfer' }).success).toBe(false);
  });
  test('rejects a settled transfer with duplicate stock endpoints', () => {
    const input = receipt();
    input.kind = 'transfer';
    input.changes.push(structuredClone(input.changes[0]));
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
  });
  test('rejects a settled transfer between different items or incompatible units', () => {
    const input = receipt();
    input.kind = 'transfer';
    input.changes.push({ ...input.changes[0], itemId: 'part-2', binId: 'bin-2', unit: 'box' });
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
  });
  test('rejects two stock changes under a single-endpoint use receipt', () => {
    const input = receipt();
    input.changes.push({ ...input.changes[0], binId: 'bin-2' });
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
  });
  test('rejects a settled change whose version does not advance', () => {
    const input = receipt();
    input.changes[0].version = input.changes[0].previousVersion;
    expect(inventoryReceiptSchema.safeParse(input).success).toBe(false);
  });
  test('retains mandatory adjustment reasons in the settled receipt', () => {
    expect(inventoryReceiptSchema.safeParse({ ...receipt(), kind: 'adjust' }).success).toBe(false);
  });
  test('retains mandatory correction reasons in the settled receipt', () => {
    expect(inventoryReceiptSchema.safeParse({ ...receipt(), correctsReceiptId: 'older' }).success).toBe(false);
  });
});
