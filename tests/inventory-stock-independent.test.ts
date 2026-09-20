import { describe, expect, test } from 'vitest';
import type { InventoryBalance, InventoryCommand } from '../shared/inventory.js';
import {
  prepareInventoryCommand,
  type InventoryPreparationContext,
} from '../server/inventory/commands.js';
import {
  inventoryDigest,
  parseInventoryStockDocument,
  type InventoryStockDocument,
  type InventoryStockSnapshot,
} from '../server/inventory/ledger.js';
import { ApiError, MAX_TEXT_BYTES } from '../server/paths.js';

// Independent synthetic records. No Store, authority, disk, or device is simulated here.
const scope = {
  organizationId: 'warehouse-org',
  tenantId: 'warehouse-tenant',
  projectId: 'warehouse-project',
};
const stamp = (step = 0) => new Date(Date.UTC(2026, 8, 19, 10, 0, step)).toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function initial(scale = 0): InventoryStockDocument {
  const balances: InventoryBalance[] = ['a', 'b', 'c'].map((binId, index) => ({
    itemId: 'bolt',
    siteId: index === 2 ? 'annex' : 'main',
    binId,
    onHandMinor: index === 0 ? 20 : 10,
    reservedMinor: 3,
    availableMinor: index === 0 ? 17 : 7,
    unit: 'kg',
    scale,
    version: 'v0',
    observedAt: stamp(),
    lastMovementAt: null,
    lastPhysicalCountAt: stamp(),
    countEvidence: { countedAt: stamp(), reference: 'opening-count' },
    source: {
      kind: 'synthetic',
      reference: 'independent-fixture',
      revision: 'opening',
      observedAt: stamp(),
    },
  }));
  return {
    schemaVersion: 1,
    version: 'd0',
    operations: [],
    catalog: {
      contractVersion: 1,
      scope: { ...scope },
      authority: 'recorded-ledger',
      reservationMode: 'read-only',
      items: [
        { id: 'bolt', name: 'Steel bolt', variant: 'M12', unit: 'kg', scale, barcodes: ['000009'] },
      ],
      sites: [
        { id: 'main', name: 'Main' },
        { id: 'annex', name: 'Annex' },
      ],
      bins: [
        { id: 'a', siteId: 'main', name: 'A' },
        { id: 'b', siteId: 'main', name: 'B' },
        { id: 'c', siteId: 'annex', name: 'C' },
      ],
      balances,
    },
  };
}
function host(n = 1): InventoryPreparationContext {
  return {
    scope: { ...scope },
    actorPersonId: 'person-a',
    now: stamp(n),
    nextDocumentVersion: `d${n}`,
    receiptId: `r${n}`,
    historyEntryId: `h${n}`,
    balanceVersions: { source: `v${n}`, destination: `v${n}` },
  };
}
function intent(
  doc: InventoryStockSnapshot,
  kind: InventoryCommand['kind'],
  n = 1,
  amount = 4,
): InventoryCommand {
  const [source, destination] = doc.catalog.balances;
  const common = {
    operationId: `op${n}`,
    itemId: source.itemId,
    siteId: source.siteId,
    binId: source.binId,
    expectedVersion: source.version,
    quantity: { minor: amount, unit: source.unit, scale: source.scale },
    reason: 'Independent stock operation',
    jobId: 'job-9',
  };
  if (kind === 'transfer')
    return {
      ...common,
      kind,
      destination: {
        siteId: destination.siteId,
        binId: destination.binId,
        expectedVersion: destination.version,
      },
    };
  if (kind === 'record-count')
    return { ...common, kind, countEvidence: { countedAt: stamp(n), reference: `count-${n}` } };
  return { ...common, kind };
}
function prepare(doc: unknown, command: unknown, context = host()) {
  const result = prepareInventoryCommand(doc, command, context);
  if (result.status !== 'prepared') throw new Error('Expected a pure proposal');
  return result;
}
function expectRefusal(run: () => unknown, status?: number) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  if (status !== undefined) expect(caught).toMatchObject({ status });
}
function frozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) frozen(child);
  }
}
function setAt(input: unknown, dottedPath: string, value: unknown): void {
  const keys = dottedPath.split('.');
  let target = input as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
}
function twoOperations() {
  const doc = initial();
  const first = prepare(doc, intent(doc, 'transfer')).proposedDocument;
  return prepare(first, intent(first, 'receive', 2, 2), host(2)).proposedDocument;
}
function mutableHistory(): InventoryStockDocument {
  // Deliberately deserialize into mutable hostile input for validation probes.
  return JSON.parse(JSON.stringify(twoOperations())) as InventoryStockDocument;
}

describe('independent stock algebra and immutable proposals', () => {
  test.each([0, 1, 2, 3, 4, 5, 6])(
    'mixed operations match an integer oracle at scale %i',
    (scale) => {
      let doc: InventoryStockSnapshot = initial(scale);
      let expected = [20n, 10n, 10n];
      const kinds: InventoryCommand['kind'][] = [
        'receive',
        'use',
        'transfer',
        'adjust',
        'record-count',
      ];
      for (let step = 1; step <= 25; step++) {
        const kind = kinds[(step - 1) % kinds.length];
        const amount = kind === 'adjust' || kind === 'record-count' ? 30 + step : (step % 3) + 1;
        const original = clone(doc);
        const command = intent(doc, kind, step, amount);
        const result = prepare(doc, command, host(step));
        const delta = BigInt(amount);
        if (kind === 'receive') expected[0] += delta;
        else if (kind === 'use') expected[0] -= delta;
        else if (kind === 'transfer') {
          expected[0] -= delta;
          expected[1] += delta;
        } else expected[0] = delta;
        expect(result.proposedDocument.catalog.balances.map((row) => row.onHandMinor)).toEqual(
          expected.map(Number),
        );
        expect(result.proposedDocument.catalog.balances.map((row) => row.availableMinor)).toEqual(
          expected.map((value) => Number(value - 3n)),
        );
        expect(doc).toEqual(original);
        expect(result.proposedDocument.operations.slice(0, -1)).toEqual(original.operations);
        expect(result.proposedDocument.catalog.balances[2]).toEqual(original.catalog.balances[2]);
        expect(result.expectedDocumentDigest).toBe(inventoryDigest(doc));
        expect(result.proposedReceipt.changes).toHaveLength(kind === 'transfer' ? 2 : 1);
        expect(parseInventoryStockDocument(clone(result.proposedDocument), scope)).toEqual(
          result.proposedDocument,
        );
        doc = result.proposedDocument;
      }
      expect(doc.operations).toHaveLength(25);
    },
  );

  test('detaches and recursively freezes command, host, before-images, source and receipt', () => {
    const doc = initial();
    const command = intent(doc, 'record-count');
    const context = host();
    const result = prepare(doc, command, context);
    const saved = clone(result);
    frozen(result);
    doc.catalog.balances[0].source.reference = 'mutated input';
    command.quantity.minor = 999;
    if (command.kind === 'record-count') command.countEvidence.reference = 'mutated count';
    context.scope.projectId = 'another-project';
    expect(result).toEqual(saved);
    expect(result.proposedDocument.operations[0].before[0].countEvidence?.reference).toBe(
      'opening-count',
    );
    expect(result.proposedDocument.catalog.balances[0].lastMovementAt).toBeNull();
    expect(result.proposedDocument.catalog.balances[0].source.observedAt).toBe(stamp());
  });

  test('retains all identities and original replay after many subsequent operations', () => {
    const original = initial();
    const firstCommand = intent(original, 'receive');
    let doc = prepare(original, firstCommand).proposedDocument;
    const firstReceipt = clone(doc.operations[0].receipt);
    for (let n = 2; n <= 35; n++)
      doc = prepare(doc, intent(doc, 'receive', n, 1), host(n)).proposedDocument;
    const saved = clone(doc);
    const replay = prepareInventoryCommand(clone(doc), clone(firstCommand), host(100));
    expect(replay).toEqual({
      status: 'recorded-match',
      recordedReceipt: firstReceipt,
      requiresFreshHostAuthorization: true,
    });
    frozen(replay);
    expect(doc).toEqual(saved);
    expect(doc.operations).toHaveLength(35);
  });

  test('both endpoint versions are needed even when only the destination changed', () => {
    const doc = initial();
    const pending = intent(doc, 'transfer', 2);
    const receive = { ...intent(doc, 'receive'), binId: 'b' };
    const changed = prepare(doc, receive).proposedDocument;
    expect(changed.catalog.balances[0].version).toBe('v0');
    expectRefusal(() => prepare(changed, pending, host(2)), 409);
    expect(changed.catalog.balances.map((row) => row.onHandMinor)).toEqual([20, 14, 10]);
  });

  test('allows per-location version names to match without conflating locations', () => {
    const doc = initial();
    const first = prepare(doc, intent(doc, 'receive')).proposedDocument;
    const second = prepare(
      first,
      { ...intent(first, 'receive', 2), binId: 'c', siteId: 'annex', expectedVersion: 'v0' },
      { ...host(2), balanceVersions: { source: 'v1' } },
    );
    expect(second.proposedDocument.catalog.balances.map((row) => row.version)).toEqual([
      'v1',
      'v0',
      'v1',
    ]);
    expect(second.proposedDocument.catalog.balances.map((row) => row.onHandMinor)).toEqual([
      24, 10, 14,
    ]);
    expect(parseInventoryStockDocument(second.proposedDocument, scope)).toEqual(
      second.proposedDocument,
    );
  });

  test.each(['receive', 'transfer'] as const)(
    '%s refuses MAX_SAFE overflow without mutating either endpoint',
    (kind) => {
      const doc = initial();
      const target = doc.catalog.balances[kind === 'transfer' ? 1 : 0];
      target.onHandMinor = Number.MAX_SAFE_INTEGER;
      target.availableMinor = target.onHandMinor - target.reservedMinor!;
      const before = clone(doc);
      expectRefusal(() => prepare(doc, intent(doc, kind, 1, 1)), 422);
      expect(doc).toEqual(before);
    },
  );

  test.each(['use', 'transfer', 'adjust', 'record-count'] as const)(
    '%s cannot consume reservations or underflow',
    (kind) => {
      const doc = initial();
      const amount = kind === 'use' || kind === 'transfer' ? 18 : 2;
      expectRefusal(() => prepare(doc, intent(doc, kind, 1, amount)), 422);
      expect(doc.catalog.balances[0].onHandMinor).toBe(20);
    },
  );

  test.each(['receive', 'use', 'transfer', 'adjust', 'record-count'] as const)(
    '%s refuses destination/source unknown reservations',
    (kind) => {
      const doc = initial();
      const row = doc.catalog.balances[kind === 'transfer' ? 1 : 0];
      row.reservedMinor = null;
      row.availableMinor = null;
      expectRefusal(() => prepare(doc, intent(doc, kind)), 422);
      expect(row.reservedMinor).toBeNull();
    },
  );

  test.each(['receive', 'use', 'transfer'] as const)(
    '%s cannot derive an exact amount from unknown on-hand',
    (kind) => {
      const doc = initial();
      const row = doc.catalog.balances[kind === 'transfer' ? 1 : 0];
      row.onHandMinor = null;
      row.availableMinor = null;
      expectRefusal(() => prepare(doc, intent(doc, kind)), 422);
    },
  );
});

describe('independent full-intent replay and contamination', () => {
  const changes: [string, unknown][] = [
    ['kind', 'receive'],
    ['itemId', 'other'],
    ['siteId', 'annex'],
    ['binId', 'b'],
    ['expectedVersion', 'other'],
    ['quantity.minor', 5],
    ['quantity.unit', 'each'],
    ['quantity.scale', 1],
    ['destination.siteId', 'annex'],
    ['destination.binId', 'c'],
    ['destination.expectedVersion', 'other'],
    ['reason', 'Changed reason'],
    ['jobId', 'job-other'],
    ['correctsReceiptId', 'missing'],
  ];
  test.each(changes)('same operation ID refuses changed %s', (field, value) => {
    const doc = initial();
    const original = intent(doc, 'transfer');
    const recorded = prepare(doc, original).proposedDocument;
    const changed = clone(original);
    setAt(changed, field, value);
    expectRefusal(() => prepareInventoryCommand(recorded, changed, host(2)));
    expect(recorded.operations).toHaveLength(1);
  });

  test.each(['countedAt', 'reference'] as const)(
    'count replay identity includes evidence %s',
    (field) => {
      const doc = initial();
      const command = intent(doc, 'record-count');
      const recorded = prepare(doc, command).proposedDocument;
      const changed = clone(command);
      setAt(changed, `countEvidence.${field}`, field === 'reference' ? 'other-count' : stamp(2));
      expectRefusal(() => prepareInventoryCommand(recorded, changed, host(2)), 409);
    },
  );

  test.each(['organizationId', 'tenantId', 'projectId'] as const)(
    'host %s cannot replay a foreign document',
    (field) => {
      const doc = initial();
      const command = intent(doc, 'receive');
      const recorded = prepare(doc, command).proposedDocument;
      const context = host(2);
      context.scope[field] = 'other';
      expectRefusal(() => prepareInventoryCommand(recorded, command, context), 403);
    },
  );

  test('another actor cannot reuse a recorded operation', () => {
    const doc = initial();
    const command = intent(doc, 'receive');
    const recorded = prepare(doc, command).proposedDocument;
    expectRefusal(
      () => prepareInventoryCommand(recorded, command, { ...host(2), actorPersonId: 'person-b' }),
      409,
    );
  });

  test.each(['actorPersonId', 'scope', 'authorized', 'role', 'historyEntryId'])(
    'client %s cannot impersonate trusted context',
    (field) => {
      const doc = initial();
      const command = { ...intent(doc, 'use'), [field]: field === 'scope' ? scope : 'supervisor' };
      expectRefusal(() => prepare(doc, command), 422);
    },
  );

  test('JSON property order is not different semantic intent or document identity', () => {
    const doc = initial();
    const command = intent(doc, 'receive');
    const reordered = Object.fromEntries(Object.entries(command).reverse());
    const first = prepare(doc, command);
    expect(inventoryDigest(command)).toBe(inventoryDigest(reordered));
    const replay = prepareInventoryCommand(first.proposedDocument, reordered, host(2));
    expect(replay.status).toBe('recorded-match');
    expect(inventoryDigest(doc)).toBe(
      inventoryDigest(Object.fromEntries(Object.entries(doc).reverse())),
    );
  });
});

describe('independent hostile deserialized history validation', () => {
  const mutations: [string, unknown][] = [
    ['catalog.scope.projectId', 'foreign'],
    ['operations.0.receipt.scope.organizationId', 'foreign'],
    ['operations.0.receipt.scope.tenantId', 'foreign'],
    ['operations.0.receipt.scope.projectId', 'foreign'],
    ['operations.0.command.quantity.minor', 5],
    ['operations.0.command.quantity.unit', 'each'],
    ['operations.0.command.quantity.scale', 6],
    ['operations.0.command.destination.expectedVersion', 'bad'],
    ['operations.0.receipt.kind', 'use'],
    ['operations.0.receipt.operationId', 'bad'],
    ['operations.0.receipt.reason', 'bad'],
    ['operations.0.receipt.jobId', 'bad'],
    ['operations.0.receipt.correctsReceiptId', 'bad'],
    ['operations.0.receipt.changes.0.onHandMinor', 15],
    ['operations.0.receipt.changes.1.onHandMinor', 15],
    ['operations.0.receipt.changes.0.reservedMinor', null],
    ['operations.0.receipt.changes.0.previousVersion', 'bad'],
    ['operations.0.before.0.binId', 'c'],
    ['operations.0.before.0.availableMinor', null],
    ['operations.0.before.0.source.observedAt', stamp(100)],
    ['operations.1.before.0.source.reference', 'rewritten-provenance'],
    ['operations.1.before.0.onHandMinor', 15],
    ['operations.1.before.0.version', 'v0'],
    ['operations.1.before.0.countEvidence.reference', 'rewritten-count'],
    ['operations.1.receipt.recordedAt', stamp()],
    ['operations.1.previousDocumentVersion', 'd0'],
    ['operations.1.documentVersion', 'd0'],
    ['operations.1.receipt.id', 'r1'],
    ['operations.1.receipt.historyEntryId', 'h1'],
    ['operations.1.command.operationId', 'op1'],
    ['version', 'd0'],
    ['catalog.balances.0.version', 'v0'],
    ['catalog.balances.0.source.reference', 'rewritten-source'],
    ['catalog.balances.0.lastMovementAt', stamp()],
    ['catalog.balances.0.countEvidence.reference', 'rewritten-count'],
    ['catalog.balances.1.onHandMinor', null],
    ['operations.0.receipt.applied', true],
    ['operations.0.command.authorized', true],
    ['operations.0.before.0.version', ''],
    ['catalog.balances.0.availableMinor', Number.MAX_SAFE_INTEGER + 1],
  ];
  test.each(mutations)('rejects %s tampering before any replay', (field, value) => {
    const doc = mutableHistory();
    const command = clone(doc.operations[0].command);
    setAt(doc, field, value);
    const before = clone(doc);
    expectRefusal(() => parseInventoryStockDocument(doc, scope));
    expectRefusal(() => prepareInventoryCommand(doc, command, host(3)));
    expect(doc).toEqual(before);
  });

  test.each(['before', 'receipt'] as const)(
    'rejects transfer endpoint permutation in %s',
    (field) => {
      const doc = mutableHistory();
      if (field === 'before') doc.operations[0].before.reverse();
      else doc.operations[0].receipt.changes.reverse();
      expectRefusal(() => parseInventoryStockDocument(doc, scope), 422);
    },
  );

  test('rejects a self-consistent reused location version in a later receipt', () => {
    const doc = mutableHistory();
    doc.operations[1].receipt.changes[0].version = 'v0';
    doc.catalog.balances[0].version = 'v0';
    expectRefusal(() => parseInventoryStockDocument(doc, scope), 422);
  });

  test.each([null, [], 'serialized-not-decoded', 9, { schemaVersion: 2 }])(
    'rejects invalid root %j',
    (value) => {
      expectRefusal(() => parseInventoryStockDocument(value, scope), 422);
    },
  );
});

describe('independent correction and observation semantics', () => {
  test.each(['receive', 'use', 'transfer', 'adjust', 'record-count'] as const)(
    '%s correction restores amounts and preserves the original evidence',
    (kind) => {
      const doc = initial();
      const original = intent(doc, kind);
      const first = prepare(doc, original);
      const inverseKind =
        kind === 'receive'
          ? 'use'
          : kind === 'use'
            ? 'receive'
            : kind === 'transfer'
              ? 'transfer'
              : 'adjust';
      const inverse = intent(
        first.proposedDocument,
        inverseKind,
        2,
        kind === 'adjust' || kind === 'record-count' ? 20 : 4,
      );
      inverse.correctsReceiptId = first.proposedReceipt.id;
      if (inverse.kind === 'transfer') {
        inverse.binId = 'b';
        inverse.destination.binId = 'a';
      }
      const second = prepare(first.proposedDocument, inverse, host(2));
      expect(second.proposedDocument.catalog.balances.map((row) => row.onHandMinor)).toEqual([
        20, 10, 10,
      ]);
      expect(second.proposedDocument.operations[0]).toEqual(first.proposedDocument.operations[0]);
      expect(second.proposedDocument.operations[1].receipt.correctsReceiptId).toBe('r1');
      expect(parseInventoryStockDocument(clone(second.proposedDocument), scope)).toEqual(
        second.proposedDocument,
      );
      const repeat = { ...inverse, operationId: 'double-correction', expectedVersion: 'v2' };
      expectRefusal(() => prepare(second.proposedDocument, repeat, host(3)), 409);
    },
  );

  test('a correction can itself be reversed while each original receipt remains single-corrected', () => {
    const doc = initial();
    const first = prepare(doc, intent(doc, 'receive'));
    const undo = { ...intent(first.proposedDocument, 'use', 2), correctsReceiptId: 'r1' };
    const second = prepare(first.proposedDocument, undo, host(2));
    const redo = { ...intent(second.proposedDocument, 'receive', 3), correctsReceiptId: 'r2' };
    const third = prepare(second.proposedDocument, redo, host(3));
    expect(third.proposedDocument.catalog.balances[0].onHandMinor).toBe(24);
    expect(third.proposedDocument.operations.map((row) => row.receipt.correctsReceiptId)).toEqual([
      null,
      'r1',
      'r2',
    ]);
    expect(parseInventoryStockDocument(third.proposedDocument, scope)).toEqual(
      third.proposedDocument,
    );
  });

  test.each(['adjust', 'record-count'] as const)(
    '%s inverse refuses intervening target movement but permits unrelated location movement',
    (kind) => {
      const doc = initial();
      const first = prepare(doc, intent(doc, kind));
      const unrelated = prepare(
        first.proposedDocument,
        { ...intent(first.proposedDocument, 'receive', 2), binId: 'b', expectedVersion: 'v0' },
        host(2),
      );
      const restore = {
        ...intent(unrelated.proposedDocument, 'adjust', 3, 20),
        correctsReceiptId: 'r1',
      };
      expect(
        prepare(unrelated.proposedDocument, restore, host(3)).proposedDocument.catalog.balances[0]
          .onHandMinor,
      ).toBe(20);
      const changed = prepare(
        first.proposedDocument,
        intent(first.proposedDocument, 'receive', 2),
        host(2),
      );
      const staleRestore = { ...restore, expectedVersion: 'v2' };
      expectRefusal(() => prepare(changed.proposedDocument, staleRestore, host(3)), 422);
    },
  );

  test.each(['amount', 'item', 'location', 'missing-receipt'] as const)(
    'refuses correction with wrong %s',
    (field) => {
      const doc = initial();
      const first = prepare(doc, intent(doc, 'receive'));
      const undo = { ...intent(first.proposedDocument, 'use', 2), correctsReceiptId: 'r1' };
      if (field === 'amount') undo.quantity.minor = 3;
      if (field === 'item') undo.itemId = 'foreign';
      if (field === 'location') {
        undo.binId = 'b';
        undo.expectedVersion = 'v0';
      }
      if (field === 'missing-receipt') undo.correctsReceiptId = 'foreign-r';
      expectRefusal(() => prepare(first.proposedDocument, undo, host(2)), 422);
    },
  );

  test.each([stamp(), '2026-09-19T09:59:59.999Z', stamp(2)])(
    'refuses stale/repeated/future count %s',
    (countedAt) => {
      const doc = initial();
      const command = intent(doc, 'record-count');
      if (command.kind !== 'record-count') throw new Error('Wrong fixture');
      command.countEvidence.countedAt = countedAt;
      expectRefusal(() => prepare(doc, command), 422);
    },
  );

  test('compares timezone instants, and never freshens source or count on receipt', () => {
    const doc = initial();
    const first = prepare(doc, intent(doc, 'receive'), {
      ...host(),
      now: '2026-09-19T06:00:01-04:00',
    });
    expect(first.proposedDocument.catalog.balances[0].observedAt).toBe('2026-09-19T06:00:01-04:00');
    expect(first.proposedDocument.catalog.balances[0].source).toEqual(
      doc.catalog.balances[0].source,
    );
    expect(first.proposedDocument.catalog.balances[0].countEvidence).toEqual(
      doc.catalog.balances[0].countEvidence,
    );
    expectRefusal(
      () =>
        prepare(first.proposedDocument, intent(first.proposedDocument, 'use', 2), {
          ...host(2),
          now: '2026-09-19T06:00:00.999-04:00',
        }),
      422,
    );
  });
});

describe('independent bounded bytes preserve replay history', () => {
  test('UTF-8 bytes, not character length, bound hostile large snapshots', () => {
    const doc = initial();
    doc.catalog.items.push(
      ...Array.from({ length: 3000 }, (_, n) => ({
        id: `filler-${n}`,
        name: '\u754c'.repeat(500),
        variant: '\u754c'.repeat(500),
        unit: 'kg',
        scale: 0,
        barcodes: [],
      })),
    );
    const json = JSON.stringify(doc);
    expect(json.length).toBeLessThan(MAX_TEXT_BYTES);
    expect(Buffer.byteLength(json)).toBeGreaterThan(MAX_TEXT_BYTES);
    expectRefusal(() => parseInventoryStockDocument(doc, scope), 409);
    expect(doc.operations).toHaveLength(0);
  });

  test('a full document may replay an old receipt while refusing a new append without deleting anything', () => {
    const original = initial();
    const command = intent(original, 'receive');
    const recorded = clone(prepare(original, command).proposedDocument) as InventoryStockDocument;
    let size = Buffer.byteLength(JSON.stringify(recorded));
    for (let n = 0; n < 9999; n++) {
      const filler = {
        id: `padding-${n}`,
        name: 'n'.repeat(500),
        variant: 'v'.repeat(500),
        unit: 'kg',
        scale: 0,
        barcodes: [],
      };
      const bytes = Buffer.byteLength(JSON.stringify(filler)) + 1;
      if (size + bytes > MAX_TEXT_BYTES) break;
      recorded.catalog.items.push(filler);
      size += bytes;
    }
    expect(Buffer.byteLength(JSON.stringify(recorded))).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    const digest = inventoryDigest(recorded);
    const match = prepareInventoryCommand(recorded, command, host(2));
    expect(match.status).toBe('recorded-match');
    expectRefusal(() => prepare(recorded, intent(recorded, 'receive', 2), host(2)), 409);
    expect(inventoryDigest(recorded)).toBe(digest);
    expect(recorded.operations).toHaveLength(1);
    expect(recorded.operations[0].command.operationId).toBe('op1');
  });
});
