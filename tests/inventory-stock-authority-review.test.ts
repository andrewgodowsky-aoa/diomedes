import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { InventoryCommand, InventoryScope } from '../shared/inventory.js';
import {
  InventoryStockService,
  type InventoryStockAuthorization,
} from '../server/inventory/stock-service.js';
import { Store } from '../server/store.js';
import { denial } from '../server/trust/index.js';

describe('inventory stock authority and recovery boundaries', () => {
  let root: string;
  let stockFile: string;
  let store: Store;
  let projectId: string;
  let scope: InventoryScope;
  let original: string;
  const stockPath = 'inventory/stock.json';

  function authority(person = 'person-a'): InventoryStockAuthorization {
    return {
      actorPersonId: person,
      scope,
      permissions: ['receive', 'use', 'transfer', 'record-count', 'adjust', 'correct'],
      authority: {
        principal: {
          kind: 'session',
          id: 'principal-a',
          tenantId: scope.tenantId,
          projectId,
          deviceId: 'device-a',
          sessionId: 'session-a',
          slotId: null,
        },
        generation: { identity: 1, principal: 1 },
        assurance: 'device-key',
        capabilities: new Set(['project.read', 'write.apply']),
        synthetic: false,
        expiresAt: null,
        resolvedAt: new Date().toISOString(),
      },
    };
  }

  function command(): InventoryCommand {
    return {
      operationId: 'use-material',
      kind: 'use',
      itemId: 'material',
      siteId: 'site-a',
      binId: 'shelf-a',
      expectedVersion: 'balance-a',
      quantity: { minor: 2, scale: 0, unit: 'each' },
      reason: 'Recorded consumption',
    };
  }

  async function unchanged() {
    expect(await fs.readFile(stockFile, 'utf8')).toBe(original);
    expect(store.state(projectId).history).toHaveLength(0);
  }

  async function interruptedStockEffect() {
    const persist = store.persist.bind(store);
    let interrupt = true;
    store.persist = async (state) => {
      if (interrupt && state.history.some((entry) => entry.kind === 'inventory-stock')) {
        interrupt = false;
        throw new Error('Interrupted after stock replacement');
      }
      return persist(state);
    };
    const service = new InventoryStockService({
      store,
      stockPath,
      authorize: async () => authority(),
    });
    await expect(service.execute(projectId, command(), null)).rejects.toThrow(
      'Interrupted after stock replacement',
    );
    const pendingDirectory = path.join(store.dataDir, 'inventory-pending');
    expect(await fs.readdir(pendingDirectory)).toHaveLength(1);
    expect(store.state(projectId).history).toHaveLength(0);
    return { service, pendingDirectory };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-authority-review-'));
    const folder = path.join(root, 'project');
    await fs.mkdir(folder);
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    projectId = (await store.locked(() => store.createProject('Stock review', folder))).id;
    scope = { organizationId: 'org-a', tenantId: 'tenant-a', projectId };
    const observedAt = '2026-09-20T00:00:00.000Z';
    original = JSON.stringify({
      schemaVersion: 1,
      version: 'document-a',
      operations: [],
      catalog: {
        contractVersion: 1,
        scope,
        authority: 'recorded-ledger',
        reservationMode: 'read-only',
        items: [
          { id: 'material', name: 'Material', variant: null, unit: 'each', scale: 0, barcodes: [] },
        ],
        sites: [{ id: 'site-a', name: 'Site' }],
        bins: [
          { id: 'shelf-a', siteId: 'site-a', name: 'Shelf A' },
          { id: 'shelf-b', siteId: 'site-a', name: 'Shelf B' },
        ],
        balances: ['a', 'b'].map((id) => ({
          itemId: 'material',
          siteId: 'site-a',
          binId: `shelf-${id}`,
          onHandMinor: 10,
          reservedMinor: 0,
          availableMinor: 10,
          unit: 'each',
          scale: 0,
          version: `balance-${id}`,
          observedAt,
          lastMovementAt: null,
          lastPhysicalCountAt: null,
          countEvidence: null,
          source: { kind: 'recorded-ledger', reference: 'fixture', revision: '1', observedAt },
        })),
      },
    });
    stockFile = path.join(folder, stockPath);
    await fs.mkdir(path.dirname(stockFile));
    await fs.writeFile(stockFile, original);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const resolved = path.resolve(root);
    expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(resolved)).toMatch(/^inventory-authority-review-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });

  test.each(['synthetic', 'missing-write', 'other-tenant'] as const)(
    '%s cannot change stock',
    async (fault) => {
      const resolved = authority();
      const supplied: InventoryStockAuthorization =
        fault === 'synthetic'
          ? { ...resolved, authority: { ...resolved.authority, synthetic: true } }
          : fault === 'missing-write'
            ? {
                ...resolved,
                authority: { ...resolved.authority, capabilities: new Set(['project.read']) },
              }
            : {
                ...resolved,
                authority: {
                  ...resolved.authority,
                  principal: { ...resolved.authority.principal, tenantId: 'tenant-b' },
                },
              };
      const service = new InventoryStockService({
        store,
        stockPath,
        authorize: async () => supplied,
      });
      expect(await service.execute(projectId, command(), null)).toMatchObject({ status: 'denied' });
      await unchanged();
    },
  );

  test('a changed Person at final authorization cannot inherit the prepared receipt', async () => {
    const service = new InventoryStockService({
      store,
      stockPath,
      authorize: async (_claim, request) =>
        authority(request.phase === 'effect' ? 'person-b' : 'person-a'),
    });
    expect(await service.execute(projectId, command(), null)).toMatchObject({ status: 'denied' });
    await unchanged();
  });

  test('an identity generation change after admission refuses the pending replacement', async () => {
    const service = new InventoryStockService({
      store,
      stockPath,
      authorize: async (_claim, request) => {
        const resolved = authority();
        return request.phase === 'effect'
          ? {
              ...resolved,
              authority: { ...resolved.authority, generation: { identity: 2, principal: 1 } },
            }
          : resolved;
      },
    });
    expect(await service.execute(projectId, command(), null)).toMatchObject({ status: 'denied' });
    await unchanged();
  });

  test('a new Person cannot replay another Persons operation ID', async () => {
    let person = 'person-a';
    const service = new InventoryStockService({
      store,
      stockPath,
      authorize: async () => authority(person),
    });
    const first = await service.execute(projectId, command(), null);
    expect(first.status).toBe('applied');
    const saved = await fs.readFile(stockFile, 'utf8');
    person = 'person-b';
    await expect(service.execute(projectId, command(), null)).rejects.toMatchObject({
      status: 409,
    });
    expect(await fs.readFile(stockFile, 'utf8')).toBe(saved);
    expect(store.state(projectId).history).toHaveLength(1);
  });

  test('ordinary receive permission does not authorize a compensating correction', async () => {
    const writer = new InventoryStockService({
      store,
      stockPath,
      authorize: async () => authority(),
    });
    const used = await writer.execute(projectId, command(), null);
    if (used.status !== 'applied') throw new Error('Fixture stock effect did not apply');
    const saved = await fs.readFile(stockFile, 'utf8');
    const receiver = new InventoryStockService({
      store,
      stockPath,
      authorize: async () => ({ ...authority(), permissions: ['receive'] }),
    });
    const correction: InventoryCommand = {
      ...command(),
      operationId: 'correct-material',
      kind: 'receive',
      expectedVersion: used.receipt.changes[0].version,
      correctsReceiptId: used.receipt.id,
    };
    expect(await receiver.execute(projectId, correction, null)).toMatchObject({ status: 'denied' });
    expect(await fs.readFile(stockFile, 'utf8')).toBe(saved);
    expect(store.state(projectId).history).toHaveLength(1);
  });

  test('a stale transfer destination leaves both endpoints unchanged', async () => {
    const service = new InventoryStockService({
      store,
      stockPath,
      authorize: async () => authority(),
    });
    const transfer: InventoryCommand = {
      ...command(),
      kind: 'transfer',
      destination: { siteId: 'site-a', binId: 'shelf-b', expectedVersion: 'old-destination' },
    };
    expect(await service.execute(projectId, transfer, null)).toEqual({
      status: 'conflict',
      currentVersion: 'balance-b',
    });
    await unchanged();
  });

  test('an unrecognized replacement preserves the pending receipt and blocks newer effects', async () => {
    const { service, pendingDirectory } = await interruptedStockEffect();
    const pendingNames = await fs.readdir(pendingDirectory);
    const replacement = JSON.parse(original);
    replacement.version = 'external-document';
    replacement.catalog.balances[0].version = 'external-count';
    replacement.catalog.balances[0].onHandMinor = 7;
    replacement.catalog.balances[0].availableMinor = 7;
    const changedText = JSON.stringify(replacement);
    await fs.writeFile(stockFile, changedText);

    expect(await service.status(projectId, command().operationId, null)).toMatchObject({
      status: 'uncertain',
      operationId: command().operationId,
    });
    await expect(
      service.execute(
        projectId,
        { ...command(), operationId: 'new-use', expectedVersion: 'external-count' },
        null,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await fs.readdir(pendingDirectory)).toEqual(pendingNames);
    expect(await fs.readFile(stockFile, 'utf8')).toBe(changedText);
    expect(store.state(projectId).history).toHaveLength(0);
  });

  test('unreadable stock JSON yields uncertainty without discarding the pending receipt', async () => {
    const { service, pendingDirectory } = await interruptedStockEffect();
    const pendingNames = await fs.readdir(pendingDirectory);
    await fs.writeFile(stockFile, '{interrupted external edit');

    await expect(service.status(projectId, command().operationId, null)).resolves.toMatchObject({
      status: 'uncertain',
      operationId: command().operationId,
    });
    expect(await fs.readdir(pendingDirectory)).toEqual(pendingNames);
    expect(await fs.readFile(stockFile, 'utf8')).toBe('{interrupted external edit');
    expect(store.state(projectId).history).toHaveLength(0);
  });

  test.each(['missing', 'different'] as const)(
    'an ambiguous replacement failure retains a %s receipt for reconciliation',
    async (fault) => {
      const rename = fs.rename.bind(fs);
      let changedText = '';
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        await rename(from, to);
        if (path.resolve(String(to)) !== stockFile) return;
        const replacement = JSON.parse(await fs.readFile(stockFile, 'utf8'));
        if (fault === 'missing') replacement.operations = [];
        else replacement.operations[0].receipt.id = 'different-receipt';
        changedText = JSON.stringify(replacement);
        await fs.writeFile(stockFile, changedText);
        throw new Error('Replacement outcome was interrupted');
      });
      const service = new InventoryStockService({
        store,
        stockPath,
        authorize: async () => authority(),
      });

      await expect(service.execute(projectId, command(), null)).rejects.toMatchObject({
        status: 409,
      });
      expect(await fs.readdir(path.join(store.dataDir, 'inventory-pending'))).toHaveLength(1);
      expect(await service.status(projectId, command().operationId, null)).toMatchObject({
        status: 'uncertain',
      });
      expect(await fs.readFile(stockFile, 'utf8')).toBe(changedText);
      expect(store.state(projectId).history).toHaveLength(0);
    },
  );

  test.runIf(process.platform === 'win32')(
    'a Windows sharing retry rechecks revoked stock authority',
    async () => {
      const rename = fs.rename.bind(fs);
      let attempts = 0;
      let effectChecks = 0;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (path.resolve(String(to)) === stockFile && ++attempts === 1)
          throw Object.assign(new Error('Simulated Windows sharing collision'), {
            code: 'EPERM',
            syscall: 'rename',
          });
        return rename(from, to);
      });
      const service = new InventoryStockService({
        store,
        stockPath,
        authorize: async (_claim, request) => {
          if (request.phase === 'effect' && ++effectChecks > 1)
            return denial(403, 'revoked', 'Access was revoked during the sharing retry.');
          return authority();
        },
      });
      expect(await service.execute(projectId, command(), null)).toEqual({
        status: 'denied',
        reason: 'Access was revoked during the sharing retry.',
      });
      expect(effectChecks).toBe(2);
      expect(attempts).toBe(1);
      await unchanged();
    },
  );
});
