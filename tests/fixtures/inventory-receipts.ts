/** Explicit test composition. Never import this authority double into server/ or desktop/. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../../server/store.js';
import { claimDataFolder } from '../../server/lock.js';
import {
  InventoryStockService,
  type InventoryStockAuthorization,
  type InventoryStockAuthorizer,
} from '../../server/inventory/stock-service.js';
import {
  parseInventoryStockDocument,
  type InventoryStockDocument,
} from '../../server/inventory/ledger.js';
import { denial } from '../../server/trust/index.js';
import type { InventoryScope } from '../../shared/inventory.js';

export const FIXTURE_REVISION = 'inventory-receipts-1';
export const FIXTURE_STOCK_PATH = 'inventory/stock.json';
export const FIXTURE_TIME = '2026-09-19T12:00:00.000Z';
export type FixtureAccess = 'receive' | 'read-only' | 'revoked';

export function receiptFixtureDocument(scope: InventoryScope): InventoryStockDocument {
  const source = {
    kind: 'synthetic' as const,
    reference: 'Receipt demonstration fixture',
    revision: FIXTURE_REVISION,
    observedAt: FIXTURE_TIME,
  };
  const endpoint = (
    itemId: string,
    unit: string,
    scale: number,
    onHandMinor: number | null,
    reservedMinor: number | null,
  ) => ({
    itemId,
    siteId: 'workshop',
    binId: 'shelf-a',
    unit,
    scale,
    onHandMinor,
    reservedMinor,
    availableMinor:
      onHandMinor === null || reservedMinor === null ? null : onHandMinor - reservedMinor,
    version: `${itemId}-opening-1`,
    observedAt: FIXTURE_TIME,
    lastMovementAt: null,
    lastPhysicalCountAt: null,
    countEvidence: null,
    source,
  });
  return {
    schemaVersion: 1,
    version: 'opening-1',
    operations: [],
    catalog: {
      contractVersion: 1,
      scope,
      authority: 'recorded-ledger',
      reservationMode: 'read-only',
      items: [
        {
          id: 'bolt',
          name: 'M8 bolts',
          variant: 'Zinc plated',
          unit: 'each',
          scale: 0,
          barcodes: ['00000001'],
        },
        {
          id: 'cable',
          name: 'Control cable',
          variant: 'Two core',
          unit: 'm',
          scale: 2,
          barcodes: ['00000002'],
        },
        {
          id: 'seal',
          name: 'Uncounted seals',
          variant: null,
          unit: 'each',
          scale: 0,
          barcodes: [],
        },
      ],
      sites: [{ id: 'workshop', name: 'Sample workshop' }],
      bins: [{ id: 'shelf-a', siteId: 'workshop', name: 'Shelf A' }],
      balances: [
        endpoint('bolt', 'each', 0, 12, 2),
        endpoint('cable', 'm', 2, 1250, 125),
        endpoint('seal', 'each', 0, null, null),
      ],
    },
  };
}

/** Simulates the authorizer output, not proof of a person, membership or device. */
export function receiptTestAuthorization(
  scope: InventoryScope,
  access: FixtureAccess,
): InventoryStockAuthorization {
  return {
    scope,
    actorPersonId: 'demo-person',
    permissions: access === 'receive' ? ['receive'] : [],
    authority: {
      principal: {
        kind: 'session',
        id: 'demo-principal',
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        deviceId: 'demo-device',
        sessionId: 'demo-session',
        slotId: null,
      },
      generation: { identity: 1, principal: 1 },
      assurance: 'device-key',
      capabilities: new Set(
        access === 'receive' ? ['project.read', 'write.apply'] : ['project.read'],
      ),
      // This is a test double of the genuine result. The real service's synthetic guard stays intact.
      synthetic: false,
      expiresAt: null,
      resolvedAt: new Date().toISOString(),
    },
  };
}

export async function createReceiptFixture(root: string) {
  await fs.mkdir(root, { recursive: true });
  const marker = path.join(root, 'INVENTORY_RECEIPT_FIXTURE');
  const names = await fs.readdir(root);
  if (names.length && !names.includes('INVENTORY_RECEIPT_FIXTURE'))
    throw new Error('Choose an empty directory for the synthetic receipt fixture.');
  if (!names.length) await fs.writeFile(marker, FIXTURE_REVISION, { flag: 'wx' });
  else if ((await fs.readFile(marker, 'utf8')) !== FIXTURE_REVISION)
    throw new Error('Unsupported receipt fixture revision.');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const lock = await claimDataFolder(dataDir);
  try {
    const store = new Store(dataDir, path.join(root, 'projects'));
    await store.init();
    const projects = await store.projects();
    const fresh = projects.length === 0;
    if (projects.length > 1)
      throw new Error('The receipt fixture must contain exactly one project.');
    const projectFolder = path.join(root, 'stock-project');
    await fs.mkdir(projectFolder, { recursive: true });
    const project =
      projects[0] ??
      (await store.locked(() =>
        store.createProject('Synthetic receipt demonstration', projectFolder),
      ));
    if (path.resolve(project.folder) !== path.resolve(projectFolder))
      throw new Error('The fixture project is outside its owned folder.');
    const scope = {
      organizationId: 'demo-organization',
      tenantId: 'demo-tenant',
      projectId: project.id,
    };
    const stockFile = path.join(projectFolder, FIXTURE_STOCK_PATH);
    if (fresh) {
      await fs.mkdir(path.dirname(stockFile), { recursive: true });
      await fs.writeFile(stockFile, JSON.stringify(receiptFixtureDocument(scope), null, 2), {
        flag: 'wx',
      });
    }
    // Preserve and validate the durable state on restart; never silently reseed it.
    parseInventoryStockDocument(JSON.parse(await fs.readFile(stockFile, 'utf8')), scope);
    const control: { access: FixtureAccess; revokeAtEffect: boolean } = {
      access: 'receive',
      revokeAtEffect: false,
    };
    const authorize: InventoryStockAuthorizer<{ access?: FixtureAccess }> = async (
      claim,
      request,
    ) => {
      const access =
        control.access === 'revoked' ||
        claim.access === 'revoked' ||
        (control.revokeAtEffect && request.phase === 'effect')
          ? 'revoked'
          : control.access === 'read-only' || claim.access === 'read-only'
            ? 'read-only'
            : 'receive';
      return access === 'revoked'
        ? denial(403, 'revoked', 'Demo access revoked.')
        : receiptTestAuthorization(scope, access);
    };
    const service = new InventoryStockService({ store, stockPath: FIXTURE_STOCK_PATH, authorize });
    await service.init(project.id);
    return {
      store,
      service,
      project,
      scope,
      stockFile,
      control,
      authorize,
      close: () => lock.release(),
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}
