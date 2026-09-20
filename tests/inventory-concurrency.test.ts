import { describe, expect, test } from 'vitest';
import { prepareInventoryCommand } from '../server/inventory/commands.js';
import { inventoryDigest } from '../server/inventory/ledger.js';

test('controlled CAS fixture: two uses of four from five choose one proposal, final one, one receipt (not Store atomicity)', () => {
  const scope = { organizationId: 'o', tenantId: 't', projectId: 'p' };
  const at = '2026-09-19T12:00:00Z';
  const initial = {
    schemaVersion: 1,
    version: 'document-7',
    operations: [],
    catalog: {
      contractVersion: 1,
      scope,
      authority: 'recorded-ledger',
      reservationMode: 'read-only',
      items: [{ id: 'i', name: 'Synthetic', variant: null, unit: 'each', scale: 0, barcodes: [] }],
      sites: [{ id: 's', name: 'Site' }],
      bins: [{ id: 'b', siteId: 's', name: 'Bin' }],
      balances: [
        {
          itemId: 'i',
          siteId: 's',
          binId: 'b',
          onHandMinor: 5,
          reservedMinor: 0,
          availableMinor: 5,
          unit: 'each',
          scale: 0,
          version: '7',
          observedAt: at,
          lastMovementAt: null,
          lastPhysicalCountAt: null,
          countEvidence: null,
          source: { kind: 'synthetic', reference: 'fixture', revision: '1', observedAt: at },
        },
      ],
    },
  };
  const plans = ['a', 'b'].map((id) =>
    prepareInventoryCommand(
      initial,
      {
        operationId: id,
        kind: 'use',
        itemId: 'i',
        siteId: 's',
        binId: 'b',
        expectedVersion: '7',
        quantity: { minor: 4, unit: 'each', scale: 0 },
      },
      {
        scope,
        actorPersonId: id,
        now: at,
        nextDocumentVersion: `document-${id}`,
        receiptId: `receipt-${id}`,
        historyEntryId: `history-${id}`,
        balanceVersions: { source: `8-${id}` },
      },
    ),
  );
  let current: unknown = initial;
  let version = initial.version;
  let accepted = 0;
  let conflicts = 0;
  for (const plan of plans) {
    if (plan.status !== 'prepared') throw new Error('Expected proposal.');
    if (plan.expectedDocumentVersion !== version) {
      conflicts++;
      continue;
    }
    current = plan.proposedDocument;
    version = plan.proposedDocument.version;
    accepted++;
  }
  expect({ accepted, conflicts }).toEqual({ accepted: 1, conflicts: 1 });
  expect(current).toMatchObject({
    catalog: { balances: [{ onHandMinor: 1, availableMinor: 1 }] },
    operations: [{ receipt: { id: 'receipt-a' } }],
  });
  expect((current as { operations: unknown[] }).operations).toHaveLength(1);
  expect(initial.catalog.balances[0].onHandMinor).toBe(5);
});

describe('fault-injected in-memory full-document fixture (no real Store/restart proof)', () => {
  function fixture() {
    const scope = { organizationId: 'o', tenantId: 't', projectId: 'p' };
    const at = '2026-09-19T12:00:00Z';
    const initial = {
      schemaVersion: 1,
      version: 'document-7',
      operations: [],
      catalog: {
        contractVersion: 1,
        scope,
        authority: 'recorded-ledger',
        reservationMode: 'read-only',
        items: [
          { id: 'i', name: 'Synthetic', variant: null, unit: 'each', scale: 0, barcodes: [] },
        ],
        sites: [{ id: 's', name: 'Site' }],
        bins: [
          { id: 'a', siteId: 's', name: 'A' },
          { id: 'b', siteId: 's', name: 'B' },
        ],
        balances: ['a', 'b'].map((binId, index) => ({
          itemId: 'i',
          siteId: 's',
          binId,
          onHandMinor: index === 0 ? 5 : 0,
          reservedMinor: 0,
          availableMinor: index === 0 ? 5 : 0,
          unit: 'each',
          scale: 0,
          version: '7',
          observedAt: at,
          lastMovementAt: null,
          lastPhysicalCountAt: null,
          countEvidence: null,
          source: { kind: 'synthetic', reference: 'fixture', revision: '1', observedAt: at },
        })),
      },
    };
    const command = {
      operationId: 'move',
      kind: 'transfer',
      itemId: 'i',
      siteId: 's',
      binId: 'a',
      expectedVersion: '7',
      quantity: { minor: 4, unit: 'each', scale: 0 },
      destination: { siteId: 's', binId: 'b', expectedVersion: '7' },
    };
    const host = {
      scope,
      actorPersonId: 'worker',
      now: at,
      nextDocumentVersion: 'document-8',
      receiptId: 'receipt-8',
      historyEntryId: 'history-8',
      balanceVersions: { source: '8', destination: '8' },
    };
    return { initial, command, host };
  }
  test.each(['before-planning', 'after-planning', 'after-cas-before-response'] as const)(
    '%s leaves the fixture either wholly old or wholly new; reconciliation does not apply again',
    (point) => {
      const { initial, command, host } = fixture();
      let recorded: unknown = initial;
      let effects = 0;
      const delivery = () => {
        if (point === 'before-planning') throw new Error('fixture fault before planning');
        const proposal = prepareInventoryCommand(recorded, command, host);
        if (proposal.status !== 'prepared') throw new Error('Expected proposal.');
        if (point === 'after-planning') throw new Error('fixture fault after planning');
        expect(proposal.expectedDocumentDigest).toBe(inventoryDigest(recorded));
        // The fixture supplies a single replacement; the production Store has not been integrated.
        recorded = JSON.parse(JSON.stringify(proposal.proposedDocument));
        effects++;
        throw new Error('fixture lost response after replacement');
      };
      expect(delivery).toThrow(/fixture/);
      const current = recorded as typeof initial;
      const replaced = point === 'after-cas-before-response';
      expect(current.catalog.balances.map((row) => row.onHandMinor)).toEqual(
        replaced ? [1, 4] : [5, 0],
      );
      expect(current.operations).toHaveLength(replaced ? 1 : 0);
      const reconciled = prepareInventoryCommand(recorded, command, host);
      expect(reconciled.status).toBe(replaced ? 'recorded-match' : 'prepared');
      expect(effects).toBe(replaced ? 1 : 0);
      expect(initial.catalog.balances.map((row) => row.onHandMinor)).toEqual([5, 0]);
    },
  );
  test('a conflict requires a current plan; it never silently reuses stale endpoint versions', () => {
    const { initial, command, host } = fixture();
    const first = prepareInventoryCommand(initial, command, host);
    if (first.status !== 'prepared') throw new Error('Expected proposal.');
    expect(() =>
      prepareInventoryCommand(
        first.proposedDocument,
        { ...command, operationId: 'move-again' },
        {
          ...host,
          receiptId: 'receipt-9',
          historyEntryId: 'history-9',
          nextDocumentVersion: 'document-9',
          balanceVersions: { source: '9', destination: '9' },
        },
      ),
    ).toThrow(/changed/i);
    expect(() =>
      prepareInventoryCommand(
        first.proposedDocument,
        {
          ...command,
          operationId: 'move-again',
          expectedVersion: '8',
          destination: { ...command.destination, expectedVersion: '8' },
        },
        {
          ...host,
          receiptId: 'receipt-9',
          historyEntryId: 'history-9',
          nextDocumentVersion: 'document-9',
          balanceVersions: { source: '9', destination: '9' },
        },
      ),
    ).toThrow(/available/i);
    expect(first.proposedDocument.operations).toHaveLength(1);
  });
});
