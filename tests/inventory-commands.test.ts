import { describe, expect, test } from 'vitest';
import type { InventoryCatalog, InventoryCommand } from '../shared/inventory.js';
import {
  prepareInventoryCommand,
  type InventoryPreparationContext,
} from '../server/inventory/commands.js';
import {
  INVENTORY_OPERATION_LIMIT,
  parseInventoryStockDocument,
} from '../server/inventory/ledger.js';
import { MAX_TEXT_BYTES } from '../server/paths.js';

const scope = { organizationId: 'org-a', tenantId: 'tenant-a', projectId: 'project-a' };
const at = '2026-09-19T12:00:00.000Z';
const later = '2026-09-19T12:01:00.000Z';

function fixture() {
  const catalog: InventoryCatalog = {
    contractVersion: 1,
    scope,
    authority: 'recorded-ledger',
    reservationMode: 'read-only',
    items: [
      {
        id: 'hinge',
        name: 'Synthetic hinge',
        variant: null,
        unit: 'each',
        scale: 0,
        barcodes: ['00042'],
      },
    ],
    sites: [
      { id: 'north', name: 'North' },
      { id: 'south', name: 'South' },
    ],
    bins: [
      { id: 'a', siteId: 'north', name: 'A' },
      { id: 'b', siteId: 'south', name: 'B' },
    ],
    balances: [
      { siteId: 'north', binId: 'a', onHandMinor: 5 },
      { siteId: 'south', binId: 'b', onHandMinor: 2 },
    ].map((row) => ({
      ...row,
      itemId: 'hinge',
      reservedMinor: 0,
      availableMinor: row.onHandMinor,
      unit: 'each',
      scale: 0,
      version: '7',
      observedAt: at,
      lastMovementAt: null,
      lastPhysicalCountAt: at,
      countEvidence: { countedAt: at, reference: 'synthetic-opening' },
      source: { kind: 'synthetic', reference: 'fixture', revision: 'opening', observedAt: at },
    })),
  };
  return { schemaVersion: 1 as const, version: 'doc-7', catalog, operations: [] };
}
function host(sequence = 8): InventoryPreparationContext {
  return {
    scope,
    actorPersonId: 'worker-a',
    now: later,
    nextDocumentVersion: `doc-${sequence}`,
    receiptId: `receipt-${sequence}`,
    historyEntryId: `history-${sequence}`,
    balanceVersions: { source: String(sequence), destination: String(sequence) },
  };
}
function use(overrides: Partial<InventoryCommand> = {}): InventoryCommand {
  return {
    operationId: 'use-a',
    kind: 'use',
    itemId: 'hinge',
    siteId: 'north',
    binId: 'a',
    expectedVersion: '7',
    quantity: { minor: 4, scale: 0, unit: 'each' },
    ...overrides,
  } as InventoryCommand;
}
function prepared(document: unknown, intent: unknown, context = host()) {
  const result = prepareInventoryCommand(document, intent, context);
  if (result.status !== 'prepared')
    throw new Error('Expected preparation, never an applied result.');
  return result;
}

describe('pure inventory command preparation', () => {
  test.each(['receive', 'use', 'adjust', 'record-count'] as const)(
    'prepares %s with attributable proposed evidence',
    (kind) => {
      const intent = {
        ...use(),
        kind,
        reason: 'job stock',
        jobId: 'job-a',
        ...(kind === 'record-count'
          ? { countEvidence: { countedAt: later, reference: 'synthetic-recount' } }
          : {}),
      };
      const input = fixture();
      const before = structuredClone(input);
      const result = prepared(input, intent);
      expect(input).toEqual(before);
      expect(result.proposedDocument.catalog.balances[0].onHandMinor).toBe(
        kind === 'receive' ? 9 : kind === 'use' ? 1 : 4,
      );
      expect(result.proposedReceipt).toMatchObject({
        actorPersonId: 'worker-a',
        scope,
        reason: 'job stock',
        jobId: 'job-a',
        recordedAt: later,
      });
      expect(result.status).toBe('prepared');
      expect(result.requiresFreshHostAuthorization).toBe(true);
      expect(result.proposedDocument.operations).toHaveLength(1);
      expect(parseInventoryStockDocument(result.proposedDocument, scope)).toEqual(
        result.proposedDocument,
      );
    },
  );

  test('transfer returns one detached full-document proposal and retains source/count provenance', () => {
    const input = fixture();
    const result = prepared(input, {
      ...use(),
      kind: 'transfer',
      destination: { siteId: 'south', binId: 'b', expectedVersion: '7' },
    });
    expect(result.proposedDocument.catalog.balances.map((row) => row.onHandMinor)).toEqual([1, 6]);
    expect(result.proposedReceipt.changes).toHaveLength(2);
    expect(input.catalog.balances.map((row) => row.onHandMinor)).toEqual([5, 2]);
    for (const balance of result.proposedDocument.catalog.balances) {
      expect(balance.countEvidence).toEqual(input.catalog.balances[0].countEvidence);
      expect(balance.lastPhysicalCountAt).toBe(at);
      expect(balance.lastMovementAt).toBe(later);
      expect(balance.source).toEqual(input.catalog.balances[0].source);
    }
    expect(Object.isFrozen(result.proposedDocument.catalog.balances[0].source)).toBe(true);
    expect(Object.isFrozen(result.proposedDocument.operations[0].command.quantity)).toBe(true);
    input.catalog.balances[0].source.reference = 'changed caller';
    expect(result.proposedDocument.catalog.balances[0].source.reference).toBe('fixture');
  });

  test('count changes count evidence without claiming a movement; old evidence remains in the receipt record', () => {
    const result = prepared(fixture(), {
      ...use(),
      kind: 'record-count',
      quantity: { minor: 0, unit: 'each', scale: 0 },
      countEvidence: { countedAt: later, reference: 'synthetic-empty-bin' },
    });
    expect(result.proposedDocument.catalog.balances[0]).toMatchObject({
      onHandMinor: 0,
      lastMovementAt: null,
      lastPhysicalCountAt: later,
    });
    expect(result.proposedDocument.operations[0].before[0].countEvidence?.reference).toBe(
      'synthetic-opening',
    );
  });
  test('an absolute adjustment with no quantity change records its receipt without inventing a movement', () => {
    const result = prepared(fixture(), {
      ...use(),
      kind: 'adjust',
      quantity: { minor: 5, scale: 0, unit: 'each' },
      reason: 'Confirm recorded amount',
    });
    expect(result.proposedDocument.catalog.balances[0].lastMovementAt).toBe(null);
    expect(result.proposedDocument.catalog.balances[0].lastPhysicalCountAt).toBe(at);
    expect(result.proposedDocument.operations).toHaveLength(1);
  });

  test('unknown on-hand needs an absolute count, while unknown reservations never become zero', () => {
    const input = fixture();
    input.catalog.balances[0].onHandMinor = null;
    input.catalog.balances[0].availableMinor = null;
    expect(() => prepared(input, use())).toThrow(/unknown/i);
    expect(
      prepared(input, {
        ...use(),
        kind: 'record-count',
        countEvidence: { countedAt: later, reference: 'physical-count' },
      }).proposedDocument.catalog.balances[0].onHandMinor,
    ).toBe(4);
    input.catalog.balances[0].reservedMinor = null;
    expect(() =>
      prepared(input, {
        ...use(),
        kind: 'record-count',
        countEvidence: { countedAt: later, reference: 'physical-count' },
      }),
    ).toThrow(/reservation/i);
  });

  test.each(['actorPersonId', 'scope', 'now', 'nextDocumentVersion', 'role', 'authorized'])(
    'refuses client authority field %s',
    (key) => {
      expect(() =>
        prepared(fixture(), { ...use(), [key]: key === 'scope' ? scope : 'injected' }),
      ).toThrow();
    },
  );
  test.each([
    null,
    [],
    {},
    { ...use(), kind: 'delete' },
    { ...use(), quantity: { minor: 1.5, scale: 0, unit: 'each' } },
    { ...use(), quantity: { minor: 1, scale: 1, unit: 'each' } },
    { ...use(), quantity: { minor: 1, scale: 0, unit: 'case' } },
    { ...use(), quantity: { minor: 0, scale: 0, unit: 'each' } },
  ])('refuses malformed/unbound intent %#', (intent) => {
    expect(() => prepared(fixture(), intent)).toThrow();
  });
  test.each(['organizationId', 'tenantId', 'projectId'] as const)(
    'refuses a mismatching trusted %s',
    (field) => {
      expect(() =>
        prepared(fixture(), use(), { ...host(), scope: { ...scope, [field]: 'other' } }),
      ).toThrow(/scope|target/i);
    },
  );
  test.each([
    { itemId: 'absent' },
    { siteId: 'south' },
    { binId: 'absent' },
    { expectedVersion: '6' },
  ])('refuses absent/wrong object or stale version %#', (change) => {
    expect(() => prepared(fixture(), use(change))).toThrow();
  });
  test('checks reservations and both transfer endpoint versions without touching the input', () => {
    const input = fixture();
    input.catalog.balances[0].reservedMinor = 2;
    input.catalog.balances[0].availableMinor = 3;
    const copy = structuredClone(input);
    expect(() => prepared(input, use())).toThrow(/available|reserved/i);
    expect(input).toEqual(copy);
    expect(() =>
      prepared(fixture(), {
        ...use(),
        kind: 'transfer',
        destination: { siteId: 'south', binId: 'b', expectedVersion: '6' },
      }),
    ).toThrow(/version|changed/i);
  });
  test('checks safe integer addition before returning either half of a transfer', () => {
    const input = fixture();
    input.catalog.balances[1].onHandMinor = Number.MAX_SAFE_INTEGER;
    input.catalog.balances[1].availableMinor = Number.MAX_SAFE_INTEGER;
    expect(() =>
      prepared(input, {
        ...use(),
        kind: 'transfer',
        destination: { siteId: 'south', binId: 'b', expectedVersion: '7' },
      }),
    ).toThrow(/safe|overflow/i);
    expect(input.catalog.balances[0].onHandMinor).toBe(5);
    input.catalog.balances[0].onHandMinor = Number.MAX_SAFE_INTEGER;
    input.catalog.balances[0].availableMinor = Number.MAX_SAFE_INTEGER;
    expect(() => prepared(input, { ...use(), kind: 'receive' })).toThrow(/safe|overflow/i);
  });
  test.each([at, '2026-09-19T11:59:59Z', '2026-09-20T12:00:00Z'])(
    'refuses stale or future count evidence %s',
    (countedAt) => {
      expect(() =>
        prepared(fixture(), {
          ...use(),
          kind: 'record-count',
          countEvidence: { countedAt, reference: 'recount' },
        }),
      ).toThrow(/count|future/i);
    },
  );
  test('rejects a host clock before current observations', () => {
    expect(() => prepared(fixture(), use(), { ...host(), now: '2026-09-18T12:00:00Z' })).toThrow(
      /time|observation/i,
    );
  });

  test('matches a recorded operation without planning another effect, while still requiring host reauthorization', () => {
    const first = prepared(fixture(), use());
    const replay = prepareInventoryCommand(first.proposedDocument, use(), host(9));
    expect(replay.status).toBe('recorded-match');
    if (replay.status !== 'recorded-match') throw new Error('Expected recorded match.');
    expect(replay.recordedReceipt).toEqual(first.proposedReceipt);
    expect(replay.requiresFreshHostAuthorization).toBe(true);
    expect(replay).not.toHaveProperty('proposedDocument');
  });
  test.each([
    { quantity: { minor: 3, scale: 0, unit: 'each' } },
    { reason: 'changed' },
    { jobId: 'changed' },
    { expectedVersion: '8' },
    { binId: 'b', siteId: 'south' },
  ])('same operation ID refuses changed intent %#', (delta) => {
    const first = prepared(fixture(), use());
    expect(() => prepareInventoryCommand(first.proposedDocument, use(delta), host(9))).toThrow(
      /operation|intent/i,
    );
  });
  test('same operation ID cannot become another actor or scope replay', () => {
    const first = prepared(fixture(), use());
    expect(() =>
      prepareInventoryCommand(first.proposedDocument, use(), {
        ...host(9),
        actorPersonId: 'worker-b',
      }),
    ).toThrow(/operation|actor/i);
    expect(() =>
      prepareInventoryCommand(first.proposedDocument, use(), {
        ...host(9),
        scope: { ...scope, tenantId: 'tenant-b' },
      }),
    ).toThrow();
  });
  test('appends an exact inverse correction while retaining original evidence and rejecting double correction', () => {
    const first = prepared(fixture(), use());
    const correction = {
      ...use(),
      operationId: 'undo-a',
      kind: 'receive',
      expectedVersion: '8',
      reason: 'Wrong job',
      correctsReceiptId: first.proposedReceipt.id,
    };
    const second = prepared(first.proposedDocument, correction, host(9));
    expect(second.proposedDocument.catalog.balances[0].onHandMinor).toBe(5);
    expect(second.proposedDocument.operations[0]).toEqual(first.proposedDocument.operations[0]);
    expect(second.proposedDocument.operations).toHaveLength(2);
    expect(() =>
      prepared(
        second.proposedDocument,
        { ...correction, operationId: 'undo-twice', expectedVersion: '9' },
        host(10),
      ),
    ).toThrow(/correct/i);
  });
  test.each([
    { correctsReceiptId: 'missing' },
    { quantity: { minor: 3, scale: 0, unit: 'each' } },
    { siteId: 'south', binId: 'b', expectedVersion: '7' },
  ])('rejects invalid compensation %#', (change) => {
    const first = prepared(fixture(), use());
    expect(() =>
      prepared(
        first.proposedDocument,
        {
          ...use(),
          operationId: 'undo-a',
          kind: 'receive',
          expectedVersion: '8',
          reason: 'Correction',
          correctsReceiptId: first.proposedReceipt.id,
          ...change,
        },
        host(9),
      ),
    ).toThrow(/correct|inverse/i);
  });
  test('refuses forged or inconsistent recorded data before a replay', () => {
    const first = prepared(fixture(), use());
    const broken = structuredClone(first.proposedDocument);
    (broken.catalog.balances[0] as { onHandMinor: number }).onHandMinor = 2;
    (broken.catalog.balances[0] as { availableMinor: number }).availableMinor = 2;
    expect(() => prepareInventoryCommand(broken, use(), host(9))).toThrow(
      /record|document|history/i,
    );
  });

  test('frozen inputs remain unchanged and a replay does not share mutable caller references', () => {
    const original = fixture();
    const frozen = parseInventoryStockDocument(original, scope);
    const intent = Object.freeze({ ...use(), quantity: Object.freeze(use().quantity) });
    const context = Object.freeze(host());
    const first = prepared(frozen, intent, context);
    const second = prepareInventoryCommand(first.proposedDocument, intent, context);
    expect(second.status).toBe('recorded-match');
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.proposedDocument.catalog.scope).not.toBe(context.scope);
    expect(first.proposedDocument.operations[0].command).not.toBe(intent);
    expect(frozen).toEqual(original);
  });
  test.each([Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -1, '4'])(
    'refuses unsafe or coerced quantity %s',
    (minor) => {
      expect(() =>
        prepared(fixture(), { ...use(), quantity: { minor, unit: 'each', scale: 0 } }),
      ).toThrow();
    },
  );
  test('permits the exact arithmetic limit and decimal base-unit precision without conversion', () => {
    const input = fixture();
    input.catalog.items[0].scale = 6;
    input.catalog.balances.forEach((balance) => {
      balance.scale = 6;
    });
    const result = prepared(input, {
      ...use(),
      kind: 'receive',
      quantity: { minor: Number.MAX_SAFE_INTEGER - 5, unit: 'each', scale: 6 },
    });
    expect(result.proposedDocument.catalog.balances[0].onHandMinor).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.proposedReceipt.changes[0].scale).toBe(6);
  });
  test.each(['receive', 'use', 'transfer', 'adjust', 'record-count'] as const)(
    'unknown reservations refuse %s without mutation',
    (kind) => {
      const input = fixture();
      input.catalog.reservationMode = 'untracked';
      for (const row of input.catalog.balances) {
        row.reservedMinor = null;
        row.availableMinor = null;
      }
      const intent = {
        ...use(),
        kind,
        reason: 'Test',
        ...(kind === 'transfer'
          ? { destination: { siteId: 'south', binId: 'b', expectedVersion: '7' } }
          : {}),
        ...(kind === 'record-count'
          ? { countEvidence: { countedAt: later, reference: 'count' } }
          : {}),
      };
      const original = structuredClone(input);
      expect(() => prepared(input, intent)).toThrow(/reservation/i);
      expect(input).toEqual(original);
    },
  );
  test.each(['adjust', 'record-count'] as const)(
    'absolute %s cannot undercut reserved quantities',
    (kind) => {
      const input = fixture();
      input.catalog.balances[0].reservedMinor = 5;
      input.catalog.balances[0].availableMinor = 0;
      expect(() =>
        prepared(input, {
          ...use(),
          kind,
          reason: 'Reconcile',
          ...(kind === 'record-count'
            ? { countEvidence: { countedAt: later, reference: 'physical-count' } }
            : {}),
        }),
      ).toThrow(/available/i);
    },
  );
  test('record-count cannot overwrite a more recent recorded movement or observation', () => {
    const first = prepared(fixture(), use());
    expect(() =>
      prepared(
        first.proposedDocument,
        {
          ...use(),
          operationId: 'count',
          kind: 'record-count',
          expectedVersion: '8',
          countEvidence: { countedAt: '2026-09-19T12:00:30Z', reference: 'old-count' },
        },
        host(9),
      ),
    ).toThrow(/count/i);
  });
  test('exact reversed transfer is a single compensating proposal', () => {
    const first = prepared(fixture(), {
      ...use(),
      kind: 'transfer',
      destination: { siteId: 'south', binId: 'b', expectedVersion: '7' },
    });
    const second = prepared(
      first.proposedDocument,
      {
        ...use(),
        operationId: 'reverse',
        kind: 'transfer',
        siteId: 'south',
        binId: 'b',
        expectedVersion: '8',
        destination: { siteId: 'north', binId: 'a', expectedVersion: '8' },
        correctsReceiptId: first.proposedReceipt.id,
        reason: 'Wrong bin',
      },
      host(9),
    );
    expect(second.proposedDocument.catalog.balances.map((row) => row.onHandMinor)).toEqual([5, 2]);
    expect(parseInventoryStockDocument(second.proposedDocument, scope)).toEqual(
      second.proposedDocument,
    );
  });
  test('absolute correction requires known prior stock and an unchanged target version', () => {
    const first = prepared(fixture(), { ...use(), kind: 'adjust', reason: 'Correction' });
    const correction = {
      ...use(),
      operationId: 'restore',
      kind: 'adjust',
      expectedVersion: '8',
      quantity: { minor: 5, unit: 'each', scale: 0 },
      correctsReceiptId: first.proposedReceipt.id,
      reason: 'Restore mistaken adjustment',
    };
    expect(
      prepared(first.proposedDocument, correction, host(9)).proposedDocument.catalog.balances[0]
        .onHandMinor,
    ).toBe(5);
    const intervening = prepared(
      first.proposedDocument,
      { ...use(), operationId: 'receive', kind: 'receive', expectedVersion: '8' },
      host(9),
    );
    expect(() =>
      prepared(intervening.proposedDocument, { ...correction, expectedVersion: '9' }, host(10)),
    ).toThrow(/correction/i);
    const unknown = fixture();
    unknown.catalog.balances[0].onHandMinor = null;
    unknown.catalog.balances[0].availableMinor = null;
    const counted = prepared(unknown, {
      ...use(),
      kind: 'record-count',
      countEvidence: { countedAt: later, reference: 'first-count' },
    });
    expect(() => prepared(counted.proposedDocument, correction, host(9))).toThrow(/known|inverse/i);
  });
  test.each(['document', 'receipt', 'history', 'balance'] as const)(
    'rejects reused %s allocation',
    (field) => {
      const first = prepared(fixture(), use());
      const context = host(9);
      if (field === 'document') context.nextDocumentVersion = 'doc-7';
      if (field === 'receipt') context.receiptId = 'receipt-8';
      if (field === 'history') context.historyEntryId = 'history-8';
      if (field === 'balance') context.balanceVersions.source = '7';
      expect(() =>
        prepared(
          first.proposedDocument,
          { ...use(), operationId: 'receive', kind: 'receive', expectedVersion: '8' },
          context,
        ),
      ).toThrow(/fresh|used/i);
    },
  );
  test.each(['receipt', 'command', 'before', 'scope', 'chain', 'duplicate'] as const)(
    'rejects inconsistent recorded %s',
    (field) => {
      const first = prepared(fixture(), use());
      const broken = JSON.parse(JSON.stringify(first.proposedDocument));
      if (field === 'receipt') broken.operations[0].receipt.changes[0].onHandMinor = 2;
      if (field === 'command') broken.operations[0].command.quantity.minor = 3;
      if (field === 'before') broken.operations[0].before[0].version = 'fake';
      if (field === 'scope') broken.operations[0].receipt.scope.projectId = 'other';
      if (field === 'chain') broken.version = 'doc-fake';
      if (field === 'duplicate') broken.operations.push(broken.operations[0]);
      expect(() => prepareInventoryCommand(broken, use(), host(9))).toThrow();
    },
  );
  test('bounded operation history refuses overflow instead of forgetting deduplication data', () => {
    const first = prepared(fixture(), use());
    const broken = {
      ...first.proposedDocument,
      operations: Array(INVENTORY_OPERATION_LIMIT + 1).fill(first.proposedDocument.operations[0]),
    };
    expect(() => prepareInventoryCommand(broken, use(), host(9))).toThrow(/bounded|document/i);
    expect(first.proposedDocument.operations).toHaveLength(1);
  });
  test('Store text-size ceiling refuses a large valid catalog without trimming it', () => {
    const input = fixture();
    input.catalog.balances = [];
    input.catalog.items = Array.from({ length: 10000 }, (_, index) => ({
      id: `i-${index}`,
      name: 'n'.repeat(500),
      variant: 'v'.repeat(500),
      unit: 'each',
      scale: 0,
      barcodes: [],
    }));
    expect(() => prepareInventoryCommand(input, use(), host())).toThrow(/text limit/i);
    expect(input.catalog.items).toHaveLength(10000);
  });
  test('new receipt and dedup data count toward the Store limit; the full prior document remains intact', () => {
    const input = fixture();
    let bytes = Buffer.byteLength(JSON.stringify(input));
    for (let i = 0; i < 10000; i++) {
      const row = {
        id: `filler-${i}`,
        name: 'n'.repeat(500),
        variant: 'v'.repeat(500),
        unit: 'each',
        scale: 0,
        barcodes: [],
      };
      const added = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes + added > MAX_TEXT_BYTES) break;
      input.catalog.items.push(row);
      bytes += added;
    }
    expect(bytes).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(parseInventoryStockDocument(input, scope).operations).toHaveLength(0);
    expect(() => prepared(input, use())).toThrow(/text limit/i);
    expect(input.operations).toHaveLength(0);
    expect(input.catalog.balances[0].onHandMinor).toBe(5);
  });
});
