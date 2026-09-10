import path from 'node:path';
import { z } from 'zod';
import type { HarnessPrincipal } from '../../shared/harness.js';
import { connectionSchema, type ConnectorManifest } from '../../shared/connections.js';
import { Store } from '../store.js';
import { createHarnessHost } from '../harness/host.js';
import { digest } from '../harness/policy.js';
import { ConnectionsService, type FixtureConnector } from './service.js';
import { fixtureCredentials } from './credentials.js';
import {
  toastManifest,
  toastInput,
  toastResult,
  stockFixture,
  parseToastEvent,
  TOAST_RESOURCES,
  TOAST_ITEMS,
} from './toast.js';
export { connectionFixtureModel } from './fixture-model.js';

export const toastConnector: FixtureConnector = {
  manifest: toastManifest,
  operations: [
    {
      id: 'get_item_availability',
      input: toastInput,
      result: toastResult,
      resources: (input) => toastInput.parse(input).resources,
      execute: async (input, signal, at) => {
        signal.throwIfAborted();
        return stockFixture(input, at);
      },
      observations: (result) => toastResult.parse(result).observations,
    },
  ],
  parseEvent: parseToastEvent,
};
const catalogInput = z.strictObject({ resources: z.array(z.literal('catalog')).min(1).max(1) });
const catalogResult = z.strictObject({
  items: z.array(z.strictObject({ id: z.number(), name: z.string() })),
});
/** A non-stock operation using the same invocation contract and a distinct result schema. */
export const catalogManifest: ConnectorManifest = {
  ...toastManifest,
  id: 'catalog',
  vendor: 'Fixture catalogue',
  version: '1.0.0',
  authentication: ['none'],
  rules: [],
  provenance: {
    source: 'https://spec.openapis.org/oas/v3.2.0.html',
    license: 'Apache-2.0',
    review: 'host-reviewed',
    integrity: null,
  },
  operations: [
    {
      id: 'list_items',
      description: 'Read a bounded fixture catalogue.',
      effect: 'read',
      permission: 'connections.read',
      vendorScopes: [],
      source: { method: 'GET', path: '/items' },
      inputSchema: z.json().parse(z.toJSONSchema(catalogInput)),
      resultSchema: z.json().parse(z.toJSONSchema(catalogResult)),
    },
  ],
  pagination: 'One bounded fixture page.',
  rateLimit: 'Local fixture only.',
  retry: 'Two explicit reads maximum.',
  idempotency: 'Read only.',
  reconciliation: 'Refresh catalogue.',
  webhook: 'Unavailable.',
  freshness: 'Fixture only.',
  limitations: ['Synthetic catalogue; no provider access.'],
  healthCheck: 'Successful fixture read.',
  fixtures: ['one catalogue item'],
};
export const catalogConnector: FixtureConnector = {
  manifest: catalogManifest,
  operations: [
    {
      id: 'list_items',
      input: catalogInput,
      result: catalogResult,
      resources: (input) => catalogInput.parse(input).resources,
      execute: async () => ({ items: [{ id: 1, name: 'Example item' }] }),
      observations: () => [],
    },
  ],
};

export async function createConnectionFixture(
  root: string,
  options: {
    clock?: () => number;
    secret?: string;
    adapters?: FixtureConnector[];
    principal?: (projectId: string) => Promise<HarnessPrincipal>;
    timeoutMs?: number;
  } = {},
) {
  const store = new Store(path.resolve(root, 'data'), path.resolve(root, 'projects'));
  await store.init();
  const project =
    (await store.projects())[0] ??
    (await store.createProject('Three restaurants - synthetic fixture'));
  const host = createHarnessHost({ store, dataDir: store.dataDir });
  await host.init();
  const signing = fixtureCredentials('toast-group', options.secret);
  const principal =
    options.principal ??
    (async (projectId: string): Promise<HarnessPrincipal> => ({
      id: 'fixture-worker',
      tenantId: 'local',
      projectId,
      identityGeneration: 1,
      capabilities: ['connections.read', 'connections.manage', 'issues.create'],
    }));
  const service = new ConnectionsService(
    store,
    host,
    options.adapters ?? [toastConnector, catalogConnector],
    signing.credentials,
    principal,
    options.clock,
    options.timeoutMs,
  );
  if (!store.state(project.id).connections?.instances.length) {
    await service.install(
      project.id,
      connectionSchema.parse({
        id: 'toast-group',
        connectorId: 'toast',
        version: toastManifest.version,
        manifestDigest: digest(toastManifest),
        tenantId: 'local',
        projectId: project.id,
        name: 'Restaurant group / fixture',
        resources: TOAST_RESOURCES,
        vendorScopes: ['stock:read'],
        operations: ['get_item_availability'],
        mode: 'fixture',
        status: 'connected',
        generation: 1,
        staleAfterMs: 300000,
        lastEventAt: null,
        lastReconciledAt: null,
        problem: null,
      }),
    );
  }
  return { store, host, service, project, principal, ...signing, close: () => host.close() };
}

export function fixtureStockEvent(
  at: string,
  quantity = 4,
  id = '30000000-0000-4000-8000-000000000001',
) {
  return JSON.stringify({
    timestamp: at,
    eventCategory: 'stock',
    eventType: quantity === 0 ? 'out_of_stock' : quantity <= 5 ? 'low_quantity' : 'in_stock',
    guid: id,
    details: {
      itemGuid: TOAST_ITEMS[0],
      restaurantGuid: TOAST_RESOURCES[0].id,
      status: quantity === 0 ? 'OUT_OF_STOCK' : 'QUANTITY',
      ...(quantity === 0 ? {} : { quantity }),
      multiLocationId: '101',
      versionId: TOAST_ITEMS[0],
    },
  });
}
