import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  INVENTORY_CONTRACT_VERSION,
  inventoryResultSchema,
  type InventoryCommand,
  type InventoryScope,
} from '../shared/inventory.js';
import {
  InventoryStockService,
  type InventoryStockAuthorization,
  type InventoryStockAuthorizer,
} from '../server/inventory/stock-service.js';
import { parseInventoryStockDocument } from '../server/inventory/ledger.js';
import { Store } from '../server/store.js';
import { denial } from '../server/trust/index.js';

const STOCK_PATH = 'inventory/stock.json';
const now = '2026-09-19T12:00:00.000Z';

function stockDocument(scope: InventoryScope) {
  return {
    schemaVersion: 1 as const,
    version: 'document-1',
    catalog: {
      contractVersion: INVENTORY_CONTRACT_VERSION,
      scope,
      authority: 'recorded-ledger' as const,
      reservationMode: 'read-only' as const,
      items: [
        {
          id: 'bolt',
          name: 'Bolt',
          variant: null,
          unit: 'each',
          scale: 0,
          barcodes: ['0001'],
        },
      ],
      sites: [{ id: 'north', name: 'North' }],
      bins: [
        { id: 'a1', siteId: 'north', name: 'A1' },
        { id: 'b1', siteId: 'north', name: 'B1' },
      ],
      balances: [
        {
          itemId: 'bolt',
          siteId: 'north',
          binId: 'a1',
          onHandMinor: 5,
          reservedMinor: 0,
          availableMinor: 5,
          unit: 'each',
          scale: 0,
          version: '7',
          observedAt: now,
          lastMovementAt: null,
          lastPhysicalCountAt: null,
          countEvidence: null,
          source: {
            kind: 'recorded-ledger' as const,
            reference: 'fixture',
            revision: '1',
            observedAt: now,
          },
        },
        {
          itemId: 'bolt',
          siteId: 'north',
          binId: 'b1',
          onHandMinor: 2,
          reservedMinor: 0,
          availableMinor: 2,
          unit: 'each',
          scale: 0,
          version: '3',
          observedAt: now,
          lastMovementAt: null,
          lastPhysicalCountAt: null,
          countEvidence: null,
          source: {
            kind: 'recorded-ledger' as const,
            reference: 'fixture',
            revision: '1',
            observedAt: now,
          },
        },
      ],
    },
    operations: [],
  };
}

function useCommand(): InventoryCommand {
  return {
    operationId: 'use-a',
    kind: 'use',
    itemId: 'bolt',
    siteId: 'north',
    binId: 'a1',
    expectedVersion: '7',
    quantity: { minor: 4, scale: 0, unit: 'each' },
    reason: 'Synthetic job',
    jobId: 'job-1',
  };
}

function transferCommand(): InventoryCommand {
  return {
    operationId: 'transfer-a',
    kind: 'transfer',
    itemId: 'bolt',
    siteId: 'north',
    binId: 'a1',
    expectedVersion: '7',
    quantity: { minor: 2, scale: 0, unit: 'each' },
    destination: { siteId: 'north', binId: 'b1', expectedVersion: '3' },
    reason: 'Move to point of use',
  };
}

function allowed(scope: InventoryScope): InventoryStockAuthorization {
  return {
    scope,
    actorPersonId: 'person-1',
    permissions: ['receive', 'use', 'transfer', 'adjust', 'record-count', 'correct'],
    authority: {
      principal: {
        kind: 'session',
        id: 'principal-1',
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        deviceId: 'device-1',
        sessionId: 'session-1',
        slotId: null,
      },
      generation: { identity: 1, principal: 1 },
      assurance: 'device-key',
      capabilities: new Set(['project.read', 'write.apply']),
      expiresAt: null,
      synthetic: false,
      resolvedAt: now,
    },
  };
}

describe('durable inventory stock receipts', () => {
  let root: string;
  let projectFolder: string;
  let store: Store;
  let projectId: string;
  let scope: InventoryScope;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-inventory-stock-'));
    projectFolder = path.join(root, 'project');
    await fs.mkdir(projectFolder, { recursive: true });
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    projectId = (await store.locked(() => store.createProject('Inventory', projectFolder))).id;
    scope = { organizationId: 'org-1', tenantId: 'tenant-1', projectId };
    const absolute = path.join(projectFolder, STOCK_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, JSON.stringify(stockDocument(scope)), 'utf8');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('denial leaves the stock document and History unchanged', async () => {
    const authorize: InventoryStockAuthorizer<string> = async () =>
      denial(403, 'missing-capability', 'Stock writes are not allowed for this person.');
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });
    const before = await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8');
    const pendingDirectory = path.join(store.dataDir, 'inventory-pending');
    await fs.mkdir(pendingDirectory, { recursive: true });
    await fs.writeFile(path.join(pendingDirectory, 'untrusted-write-probe.json'), '{bad', 'utf8');

    const result = await service.execute(projectId, useCommand(), 'denied-claim');

    expect(inventoryResultSchema.parse(result)).toEqual({
      status: 'denied',
      reason: 'Stock writes are not allowed for this person.',
    });
    expect(await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8')).toBe(before);
    expect(store.state(projectId).history).toHaveLength(0);
  });

  test('applies one authorized proposal as a durable receipt linked to attributable History', async () => {
    const authorize: InventoryStockAuthorizer<string> = async () => allowed(scope);
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });

    const result = inventoryResultSchema.parse(
      await service.execute(projectId, useCommand(), 'allowed-claim'),
    );

    if (result.status !== 'applied') throw new Error(JSON.stringify(result));
    expect(result.receipt.actorPersonId).toBe('person-1');
    expect(result.receipt.operationId).toBe('use-a');
    expect(result.receipt.changes).toMatchObject([
      { previousVersion: '7', onHandMinor: 1, reservedMinor: 0 },
    ]);
    const history = store.state(projectId).history;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: result.receipt.historyEntryId,
      kind: 'inventory-stock',
      actor: 'you',
      label: 'use-a',
    });
    expect(history[0].sentence).toContain('person-1');
    expect(await store.changeFromFile(projectId, history[0], 0)).toMatchObject({
      entryId: result.receipt.historyEntryId,
      path: STOCK_PATH,
      before: expect.any(String),
      after: expect.any(String),
    });
    const saved = parseInventoryStockDocument(
      JSON.parse(await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8')),
      scope,
    );
    expect(saved.catalog.balances[0]).toMatchObject({
      onHandMinor: 1,
      version: result.receipt.changes[0].version,
    });
    expect(saved.operations).toHaveLength(1);
    expect(saved.operations[0].receipt).toEqual(result.receipt);
  });

  test('rechecks authority before disclosing an idempotent retry receipt', async () => {
    let denyEffect = false;
    const authorize: InventoryStockAuthorizer<string> = async (_claim, request) =>
      request.phase === 'effect' && denyEffect
        ? denial(403, 'revoked', 'Stock access was revoked.')
        : allowed(scope);
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });
    const first = inventoryResultSchema.parse(
      await service.execute(projectId, useCommand(), 'allowed-claim'),
    );
    if (first.status !== 'applied') throw new Error(JSON.stringify(first));
    denyEffect = true;

    const denied = inventoryResultSchema.parse(
      await service.execute(projectId, useCommand(), 'allowed-claim'),
    );

    expect(denied).toEqual({ status: 'denied', reason: 'Stock access was revoked.' });
    expect(store.state(projectId).history).toHaveLength(1);
    denyEffect = false;
    const retry = inventoryResultSchema.parse(
      await service.execute(projectId, useCommand(), 'allowed-claim'),
    );
    expect(retry).toEqual({ status: 'already-applied', receipt: first.receipt });
    expect(store.state(projectId).history).toHaveLength(1);
  });

  test('returns the authoritative version when a command is stale without writing', async () => {
    const authorize: InventoryStockAuthorizer<string> = async () => allowed(scope);
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });
    const stale = { ...useCommand(), expectedVersion: '6' };
    const before = await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8');

    const result = inventoryResultSchema.parse(
      await service.execute(projectId, stale, 'allowed-claim'),
    );

    expect(result).toEqual({ status: 'conflict', currentVersion: '7' });
    expect(await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8')).toBe(before);
    expect(store.state(projectId).history).toHaveLength(0);
  });

  test('preserves a competing stock write discovered during the final effect guard', async () => {
    const absolute = path.join(projectFolder, STOCK_PATH);
    let replacedDuringEffect = false;
    const authorize: InventoryStockAuthorizer<string> = async (_claim, request) => {
      if (request.phase === 'effect' && !replacedDuringEffect) {
        replacedDuringEffect = true;
        const competing = stockDocument(scope);
        competing.version = 'document-2';
        competing.catalog.balances[0].version = '8';
        competing.catalog.balances[0].onHandMinor = 4;
        competing.catalog.balances[0].availableMinor = 4;
        await fs.writeFile(absolute, JSON.stringify(competing), 'utf8');
      }
      return allowed(scope);
    };
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });

    const result = inventoryResultSchema.parse(
      await service.execute(projectId, useCommand(), 'allowed-claim'),
    );

    expect(result).toEqual({ status: 'conflict', currentVersion: '8' });
    const saved = parseInventoryStockDocument(
      JSON.parse(await fs.readFile(absolute, 'utf8')),
      scope,
    );
    expect(saved).toMatchObject({ version: 'document-2', operations: [] });
    expect(saved.catalog.balances[0]).toMatchObject({ version: '8', onHandMinor: 4 });
    expect(store.state(projectId).history).toHaveLength(0);
    expect(await fs.readdir(path.join(store.dataDir, 'inventory-pending'))).toEqual([]);
  });

  test('drops a prepared journal when authority is revoked before the durable effect', async () => {
    const authorize: InventoryStockAuthorizer<string> = async (_claim, request) =>
      request.phase === 'effect'
        ? denial(403, 'revoked', 'Stock access was revoked before the write.')
        : allowed(scope);
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });
    const before = await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8');

    const result = inventoryResultSchema.parse(
      await service.execute(projectId, transferCommand(), 'revoked-claim'),
    );

    expect(result).toEqual({
      status: 'denied',
      reason: 'Stock access was revoked before the write.',
    });
    expect(await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8')).toBe(before);
    const unchanged = parseInventoryStockDocument(JSON.parse(before), scope);
    expect(unchanged.catalog.balances.map((balance) => balance.onHandMinor)).toEqual([5, 2]);
    expect(store.state(projectId).history).toHaveLength(0);
    const pending = await fs
      .readdir(path.join(store.dataDir, 'inventory-pending'))
      .catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? [] : Promise.reject(error),
      );
    expect(pending).toEqual([]);
  });

  test('refuses a changed session identity at the final effect guard', async () => {
    const authorize: InventoryStockAuthorizer<string> = async (_claim, request) => {
      const authorization = allowed(scope);
      return request.phase === 'effect'
        ? {
            ...authorization,
            authority: {
              ...authorization.authority,
              principal: {
                ...authorization.authority.principal,
                sessionId: 'session-2',
              },
            },
          }
        : authorization;
    };
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });

    expect(await service.execute(projectId, useCommand(), 'changed-session')).toEqual({
      status: 'denied',
      reason: 'Inventory authority changed before the stock effect; retry after refreshing access.',
    });
    expect(store.state(projectId).history).toHaveLength(0);
    expect(await fs.readdir(path.join(store.dataDir, 'inventory-pending'))).toEqual([]);
  });

  test('recovers History from a durable receipt after the stock replacement wins a crash', async () => {
    const authorize: InventoryStockAuthorizer<string> = async () => allowed(scope);
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });
    const persist = store.persist.bind(store);
    let failInventoryPersist = true;
    store.persist = async (state) => {
      if (failInventoryPersist && state.history.some((entry) => entry.kind === 'inventory-stock')) {
        failInventoryPersist = false;
        throw new Error('injected crash after stock replacement');
      }
      return persist(state);
    };

    await expect(service.execute(projectId, useCommand(), 'allowed-claim')).rejects.toThrow(
      'injected crash after stock replacement',
    );
    const replaced = parseInventoryStockDocument(
      JSON.parse(await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8')),
      scope,
    );
    expect(replaced.operations).toHaveLength(1);

    const restarted = new Store(store.dataDir, store.projectRoot);
    await restarted.init();
    expect(restarted.state(projectId).history).toHaveLength(0);
    const pendingDirectory = path.join(store.dataDir, 'inventory-pending');
    const [journalName] = await fs.readdir(pendingDirectory);
    if (!journalName) throw new Error('Expected the interrupted stock journal.');
    const journalText = await fs.readFile(path.join(pendingDirectory, journalName), 'utf8');
    await restarted.locked(async () => {
      const state = structuredClone(restarted.state(projectId));
      restarted.addEntry(state, {
        kind: 'edited',
        sentence: 'An unrelated durable event happened before stock recovery.',
      });
      await restarted.persist(state);
    });
    const recovered = new InventoryStockService({
      store: restarted,
      stockPath: STOCK_PATH,
      authorize,
    });

    await recovered.init(projectId);

    const receipt = replaced.operations[0].receipt;
    expect(restarted.state(projectId).history).toHaveLength(2);
    expect(restarted.state(projectId).history[1]).toMatchObject({
      id: receipt.historyEntryId,
      kind: 'inventory-stock',
      label: receipt.operationId,
      versionId: 'v0002',
    });
    const retry = inventoryResultSchema.parse(
      await recovered.execute(projectId, useCommand(), 'allowed-claim'),
    );
    expect(retry).toEqual({ status: 'already-applied', receipt });
    expect(restarted.state(projectId).history).toHaveLength(2);

    await fs.writeFile(path.join(pendingDirectory, journalName), journalText, 'utf8');
    const replayedRestart = new Store(store.dataDir, store.projectRoot);
    await replayedRestart.init();
    const replayedRecovery = new InventoryStockService({
      store: replayedRestart,
      stockPath: STOCK_PATH,
      authorize,
    });
    await replayedRecovery.init(projectId);
    expect(replayedRestart.state(projectId).history).toHaveLength(2);
    expect(await fs.readdir(pendingDirectory)).toEqual([]);
  });

  test('reconciles operation status from the authoritative receipt without replaying the effect', async () => {
    const authorize: InventoryStockAuthorizer<string> = async () => allowed(scope);
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });

    expect(await service.status(projectId, 'use-a', 'allowed-claim')).toEqual({
      status: 'not-found',
      operationId: 'use-a',
    });
    const applied = inventoryResultSchema.parse(
      await service.execute(projectId, useCommand(), 'allowed-claim'),
    );
    if (applied.status !== 'applied') throw new Error(JSON.stringify(applied));

    expect(await service.status(projectId, 'use-a', 'allowed-claim')).toEqual({
      status: 'applied',
      receipt: applied.receipt,
    });
    expect(store.state(projectId).history).toHaveLength(1);
    const saved = parseInventoryStockDocument(
      JSON.parse(await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8')),
      scope,
    );
    expect(saved.operations).toHaveLength(1);
  });

  test('checks current read authority before disclosing operation status', async () => {
    const writer = new InventoryStockService({
      store,
      stockPath: STOCK_PATH,
      authorize: async () => allowed(scope),
    });
    const applied = await writer.execute(projectId, useCommand(), 'writer-claim');
    if (applied.status !== 'applied') throw new Error(JSON.stringify(applied));
    const reader = new InventoryStockService({
      store,
      stockPath: STOCK_PATH,
      authorize: async () => denial(403, 'revoked', 'Inventory reads were revoked.'),
    });
    await fs.writeFile(
      path.join(store.dataDir, 'inventory-pending', 'untrusted-status-probe.json'),
      '{not valid json',
      'utf8',
    );

    expect(await reader.status(projectId, 'use-a', 'revoked-reader')).toEqual({
      status: 'denied',
      reason: 'Inventory reads were revoked.',
    });
    expect(store.state(projectId).history).toHaveLength(1);
  });

  test('serializes competing workers so only one can consume the last available units', async () => {
    const authorize: InventoryStockAuthorizer<string> = async () => allowed(scope);
    const first = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });
    const second = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });
    const useB = { ...useCommand(), operationId: 'use-b' };

    const results = await Promise.all([
      first.execute(projectId, useCommand(), 'worker-a'),
      second.execute(projectId, useB, 'worker-b'),
    ]);

    expect(results.filter((result) => result.status === 'applied')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'conflict')).toEqual([
      expect.objectContaining({ status: 'conflict' }),
    ]);
    const saved = parseInventoryStockDocument(
      JSON.parse(await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8')),
      scope,
    );
    expect(saved.catalog.balances[0].onHandMinor).toBe(1);
    expect(saved.operations).toHaveLength(1);
    expect(store.state(projectId).history).toHaveLength(1);
  });

  test('rejects operation ID reuse with changed intent and keeps the original receipt', async () => {
    const authorize: InventoryStockAuthorizer<string> = async () => allowed(scope);
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });
    const first = inventoryResultSchema.parse(
      await service.execute(projectId, useCommand(), 'allowed-claim'),
    );
    if (first.status !== 'applied') throw new Error(JSON.stringify(first));
    const changed = {
      ...useCommand(),
      quantity: { ...useCommand().quantity, minor: 3 },
    };

    await expect(service.execute(projectId, changed, 'allowed-claim')).rejects.toMatchObject({
      status: 409,
    });

    const saved = parseInventoryStockDocument(
      JSON.parse(await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8')),
      scope,
    );
    expect(saved.operations).toHaveLength(1);
    expect(saved.operations[0].receipt).toEqual(first.receipt);
    expect(store.state(projectId).history).toHaveLength(1);
  });

  test('commits both transfer endpoints and one History link as a single receipt', async () => {
    const authorize: InventoryStockAuthorizer<string> = async () => allowed(scope);
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });

    const result = inventoryResultSchema.parse(
      await service.execute(projectId, transferCommand(), 'allowed-claim'),
    );

    if (result.status !== 'applied') throw new Error(JSON.stringify(result));
    expect(result.receipt.changes).toHaveLength(2);
    const saved = parseInventoryStockDocument(
      JSON.parse(await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8')),
      scope,
    );
    expect(saved.catalog.balances.map((balance) => balance.onHandMinor)).toEqual([3, 4]);
    expect(saved.operations).toHaveLength(1);
    expect(saved.operations[0].receipt).toEqual(result.receipt);
    expect(store.state(projectId).history).toHaveLength(1);
    expect(store.state(projectId).history[0].id).toBe(result.receipt.historyEntryId);
  });

  test('denies an adjustment when the current stock policy does not grant that operation', async () => {
    const authorize: InventoryStockAuthorizer<string> = async () => ({
      ...allowed(scope),
      permissions: ['receive', 'use', 'transfer'],
    });
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });
    const adjust: InventoryCommand = {
      operationId: 'adjust-a',
      kind: 'adjust',
      itemId: 'bolt',
      siteId: 'north',
      binId: 'a1',
      expectedVersion: '7',
      quantity: { minor: 4, scale: 0, unit: 'each' },
      reason: 'Verified correction',
    };

    expect(await service.execute(projectId, adjust, 'worker-claim')).toEqual({
      status: 'denied',
      reason: 'Current authority does not permit inventory adjust.',
    });
    expect(store.state(projectId).history).toHaveLength(0);
  });

  test('records an authorized correction as a second compensating receipt without rewriting history', async () => {
    const authorize: InventoryStockAuthorizer<string> = async () => allowed(scope);
    const service = new InventoryStockService({ store, stockPath: STOCK_PATH, authorize });
    const original = inventoryResultSchema.parse(
      await service.execute(projectId, useCommand(), 'supervisor-claim'),
    );
    if (original.status !== 'applied') throw new Error(JSON.stringify(original));
    const correction: InventoryCommand = {
      operationId: 'correct-use-a',
      kind: 'receive',
      itemId: 'bolt',
      siteId: 'north',
      binId: 'a1',
      expectedVersion: original.receipt.changes[0].version,
      quantity: { minor: 4, scale: 0, unit: 'each' },
      reason: 'The synthetic usage was entered against the wrong job.',
      correctsReceiptId: original.receipt.id,
    };

    const corrected = inventoryResultSchema.parse(
      await service.execute(projectId, correction, 'supervisor-claim'),
    );

    if (corrected.status !== 'applied') throw new Error(JSON.stringify(corrected));
    expect(corrected.receipt.correctsReceiptId).toBe(original.receipt.id);
    const saved = parseInventoryStockDocument(
      JSON.parse(await fs.readFile(path.join(projectFolder, STOCK_PATH), 'utf8')),
      scope,
    );
    expect(saved.catalog.balances[0].onHandMinor).toBe(5);
    expect(saved.operations.map((record) => record.receipt.id)).toEqual([
      original.receipt.id,
      corrected.receipt.id,
    ]);
    expect(store.state(projectId).history.map((entry) => entry.id)).toEqual([
      original.receipt.historyEntryId,
      corrected.receipt.historyEntryId,
    ]);
  });
});
