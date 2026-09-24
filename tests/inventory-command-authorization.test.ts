// DIO-95: every inventory command and read resolves the local principal, checks
// membership and access-profile permission for the project's organization, and
// refuses any request that did not arrive over loopback. Local-principal
// authorization, not device identity (MI01).
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { WorkspaceService } from '../server/workspaces.js';
import { ApiError } from '../server/paths.js';
import { InventoryStockService } from '../server/inventory/stock-service.js';
import { inventoryReceiptRoutes } from '../server/inventory/receipt-routes.js';
import {
  createLocalInventoryAccess,
  INVENTORY_REFUSAL,
  inventoryTenantId,
  inventoryIngressRefusal,
  type LocalInventoryClaim,
} from '../server/inventory/local-access.js';
import { FIXTURE_STOCK_PATH, receiptFixtureDocument } from './fixtures/inventory-receipts.js';
import { inventoryResultSchema } from '../shared/inventory.js';
import { inventoryViewSchema } from '../shared/inventory-workflow.js';

const token = randomBytes(32).toString('hex');
const OTHER_PERSON = 'person_other_tenant_owner';
const command = (operationId: string, expectedVersion = 'bolt-opening-1') => ({
  kind: 'receive' as const,
  operationId,
  itemId: 'bolt',
  siteId: 'workshop',
  binId: 'shelf-a',
  expectedVersion,
  quantity: { minor: 3, scale: 0, unit: 'each' },
  reason: 'Synthetic delivery note 001',
});
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((item) => item && item.family === 'IPv4' && !item.internal);

describe('inventory command authorization (DIO-95)', () => {
  let root: string;
  let store: Store;
  let workspaces: WorkspaceService;
  let service: InventoryStockService<LocalInventoryClaim>;
  let access: ReturnType<typeof createLocalInventoryAccess>;
  let server: Server;
  let wide: Server;
  let base: string;
  let widePort: number;
  let personId: string;
  const projects: Record<'own' | 'foreign' | 'staff', { id: string; folder: string }> = {} as never;
  let ownOrganization: { id: string; tenantId: string };

  const stockText = (which: keyof typeof projects) =>
    fs.readFile(path.join(projects[which].folder, FIXTURE_STOCK_PATH), 'utf8');
  const request = (
    route: string,
    init: { body?: unknown; session?: string | null; headers?: Record<string, string> } = {},
  ) =>
    fetch(`${base}${route}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(init.session === null ? {} : { 'X-Diomedes-Session': init.session ?? token }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const ingress = (overrides: Partial<{ remote: string; local: string; host: string }> = {}) => ({
    socket: {
      remoteAddress: overrides.remote ?? '127.0.0.1',
      localAddress: overrides.local ?? '127.0.0.1',
    },
    headers: { host: overrides.host ?? '127.0.0.1:47631', 'x-diomedes-session': token },
  });

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-inventory-auth-'));
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    for (const which of ['own', 'foreign', 'staff'] as const) {
      const folder = path.join(root, `stock-${which}`);
      await fs.mkdir(folder, { recursive: true });
      const project = await store.locked(() => store.createProject(`Stock ${which}`, folder));
      projects[which] = { id: project.id, folder: project.folder };
    }
    // The local person owns one business through the ordinary workspace flow.
    const first = new WorkspaceService(store);
    await first.init();
    personId = first.currentPerson().id;
    await first.createOrganization({ name: 'Local Workshop' });
    const own = first
      .view()
      .organizations.find((row) => row.organization.name === 'Local Workshop');
    // A local organization's tenant is `org:<id>`; its inventory scope label is `org.<id>`.
    expect(own!.organization.tenantId).toBe(`org:${own!.organization.id}`);
    ownOrganization = {
      id: own!.organization.id,
      tenantId: inventoryTenantId(own!.organization)!,
    };
    expect(ownOrganization.tenantId).toBe(`org.${own!.organization.id}`);
    await first.bindOutputProject(ownOrganization.id, projects.own.id);
    // Two other businesses on this install: one the local person is not in (another
    // tenant), and one where they are an ordinary member with a view-only profile.
    const registryPath = path.join(store.dataDir, 'workspaces', 'registry.json');
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    const at = new Date().toISOString();
    const organization = (id: string, name: string) => ({
      v: registry.v,
      id,
      name,
      industry: null,
      tenantId: `org:${id}`,
      identitySource: 'development-fixture',
      createdAt: at,
      createdBy: OTHER_PERSON,
    });
    const membership = (organizationId: string, who: string, role: string) => ({
      v: registry.v,
      organizationId,
      personId: who,
      role,
      state: 'active',
      invitedAt: at,
      joinedAt: at,
      revokedAt: null,
      revokedReason: null,
    });
    const binding = (projectId: string) => ({
      projectId,
      projectName: 'Stock',
      boundAt: at,
      boundBy: OTHER_PERSON,
    });
    registry.organizations.push(
      organization('org_foreign', 'Other Tenant Co'),
      organization('org_staff', 'Staff Co'),
    );
    registry.memberships.push(
      membership('org_foreign', OTHER_PERSON, 'owner'),
      membership('org_staff', OTHER_PERSON, 'owner'),
      membership('org_staff', personId, 'member'),
    );
    registry.outputs.org_foreign = binding(projects.foreign.id);
    registry.outputs.org_staff = binding(projects.staff.id);
    registry.access.profiles.push({
      v: 1,
      organizationId: 'org_staff',
      id: 'access_profile_viewer',
      revision: 1,
      name: 'Stock viewer',
      description: 'Sees stock; records nothing.',
      systemKind: 'custom',
      state: 'active',
      permissions: ['inventory:view'],
      digest: 'fixture',
      createdAt: at,
      createdBy: OTHER_PERSON,
    });
    registry.access.assignments.push({
      v: 1,
      organizationId: 'org_staff',
      id: 'assignment_viewer',
      personId,
      profileId: 'access_profile_viewer',
      profileRevision: 1,
      scopes: [{ resourceId: `project:${projects.staff.id}`, includeDescendants: false }],
      revision: 1,
      createdAt: at,
      createdBy: OTHER_PERSON,
      revokedAt: null,
      revokedBy: null,
    });
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
    workspaces = new WorkspaceService(store);
    await workspaces.init();
    const scopes = {
      own: { organizationId: ownOrganization.id, tenantId: ownOrganization.tenantId },
      foreign: { organizationId: 'org_foreign', tenantId: 'org.org_foreign' },
      staff: { organizationId: 'org_staff', tenantId: 'org.org_staff' },
    };
    for (const which of ['own', 'foreign', 'staff'] as const) {
      const file = path.join(projects[which].folder, FIXTURE_STOCK_PATH);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        JSON.stringify(
          receiptFixtureDocument({ ...scopes[which], projectId: projects[which].id }),
          null,
          2,
        ),
      );
    }
    access = createLocalInventoryAccess({ workspaces, sessionToken: token });
    service = new InventoryStockService({
      store,
      stockPath: FIXTURE_STOCK_PATH,
      authorize: (claim, phase) => access.authorize(claim, phase),
    });
    for (const which of ['own', 'foreign', 'staff'] as const)
      await service.init(projects[which].id);
    const app = express();
    const mount = (prefix: string, projectId: string) =>
      app.use(prefix, inventoryReceiptRoutes({ service, projectId, claim: access.claim }));
    mount('/own', projects.own.id);
    mount('/foreign', projects.foreign.id);
    mount('/staff', projects.staff.id);
    mount('/missing', 'Pnotaproject01');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A listener bound beyond loopback, as a mistaken future mount would be.
    wide = app.listen(0, '0.0.0.0');
    await new Promise<void>((resolve) => wide.once('listening', resolve));
    widePort = (wide.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await Promise.all(
      [server, wide].map(
        (listener) =>
          listener &&
          new Promise<void>((resolve, reject) =>
            listener.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  test('the local owner reads and receives, and the receipt names the resolved local person', async () => {
    const view = inventoryViewSchema.parse(await (await request('/own/view')).json());
    expect(view.canReceive).toBe(true);
    const response = await request('/own/receipts', { body: command('owner-receive-1') });
    expect(response.status).toBe(200);
    const result = inventoryResultSchema.parse(await response.json());
    if (result.status !== 'applied') throw new Error(`Expected applied, got ${result.status}.`);
    expect(result.receipt.actorPersonId).toBe(personId);
    expect(result.receipt.scope).toEqual({
      organizationId: ownOrganization.id,
      tenantId: ownOrganization.tenantId,
      projectId: projects.own.id,
    });
    const entry = store
      .state(projects.own.id)
      .history.find((item) => item.id === result.receipt.historyEntryId);
    expect(entry?.sentence).toBe(`Inventory receive recorded for ${personId}.`);
    const status = await (await request('/own/operations/owner-receive-1')).json();
    expect(status).toEqual({ status: 'applied', receipt: result.receipt });
    const replay = inventoryResultSchema.parse(
      await (await request('/own/receipts', { body: command('owner-receive-1') })).json(),
    );
    expect(replay).toEqual({ status: 'already-applied', receipt: result.receipt });
  });

  test('(a) a command or read with no identity is refused before any effect', async () => {
    const before = await stockText('own');
    const historyBefore = store.state(projects.own.id).history.length;
    for (const session of [null, '0'.repeat(64), 'not-a-token']) {
      const post = await request('/own/receipts', { body: command('anon-1'), session });
      expect(post.status).toBe(401);
      expect(await post.json()).toMatchObject({ code: INVENTORY_REFUSAL.unauthenticated });
      const read = await request('/own/view', { session });
      expect(read.status).toBe(401);
      expect(await read.json()).toMatchObject({ code: INVENTORY_REFUSAL.unauthenticated });
      const status = await request('/own/operations/owner-receive-1', { session });
      expect(status.status).toBe(401);
    }
    // An actor named in the body is not an identity; the command schema rejects it.
    const named = await request('/own/receipts', {
      body: { ...command('anon-2'), actorPersonId: personId },
    });
    expect(named.status).toBe(422);
    // A claim-shaped object the host did not mint is not a principal either.
    const forged = {
      personId,
      organizationId: ownOrganization.id,
      tenantId: ownOrganization.tenantId,
      projectId: projects.own.id,
      resourceId: `project:${projects.own.id}`,
    } satisfies LocalInventoryClaim;
    expect(await service.execute(projects.own.id, command('anon-3'), forged)).toEqual({
      status: 'denied',
      reason: 'Inventory access needs a principal resolved by this host.',
    });
    await expect(service.view(projects.own.id, forged)).rejects.toMatchObject({ status: 401 });
    expect(await service.status(projects.own.id, 'owner-receive-1', forged)).toMatchObject({
      status: 'denied',
    });
    expect(await stockText('own')).toBe(before);
    expect(store.state(projects.own.id).history).toHaveLength(historyBefore);
  });

  test("(b) another tenant's project reads as absent, never as forbidden", async () => {
    const before = await stockText('foreign');
    const missingPost = await request('/missing/receipts', { body: command('cross-1') });
    const missingBody = await missingPost.json();
    expect(missingPost.status).toBe(404);
    expect(missingBody).toEqual({
      error: 'Inventory is unavailable.',
      code: INVENTORY_REFUSAL.notFound,
    });
    for (const [route, body] of [
      ['/foreign/receipts', command('cross-1')],
      ['/foreign/view', undefined],
      ['/foreign/operations/cross-1', undefined],
    ] as const) {
      const response = await request(route, { body });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(missingBody);
    }
    // A principal resolved for the local owner's own project cannot be pointed
    // at another tenant's project through the service either.
    const ownClaim = access.claim(ingress(), {
      projectId: projects.own.id,
      action: 'command',
      command: command('cross-2'),
    });
    expect(await service.execute(projects.foreign.id, command('cross-2'), ownClaim)).toEqual({
      status: 'denied',
      reason: 'Inventory is unavailable.',
    });
    await expect(service.view(projects.foreign.id, ownClaim)).rejects.toMatchObject({
      status: 403,
      message: 'Inventory is unavailable.',
    });
    // Claiming directly for it is refused identically to a project that does not exist.
    for (const projectId of [projects.foreign.id, 'Pnotaproject01']) {
      let refusal: unknown;
      try {
        access.claim(ingress(), { projectId, action: 'read' });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(ApiError);
      expect(refusal).toMatchObject({
        status: 404,
        message: 'Inventory is unavailable.',
        details: { code: INVENTORY_REFUSAL.notFound },
      });
    }
    expect(await stockText('foreign')).toBe(before);
    expect(store.state(projects.foreign.id).history).toHaveLength(0);
  });

  test('a member without the inventory role may read but not record', async () => {
    const before = await stockText('staff');
    const view = inventoryViewSchema.parse(await (await request('/staff/view')).json());
    expect(view.canReceive).toBe(false);
    const post = await request('/staff/receipts', { body: command('staff-1') });
    expect(post.status).toBe(403);
    expect(await post.json()).toMatchObject({ code: INVENTORY_REFUSAL.forbidden });
    // Admitted on a stale claim, the service still refuses from current access.
    const readClaim = access.claim(ingress(), { projectId: projects.staff.id, action: 'read' });
    expect(await service.execute(projects.staff.id, command('staff-2'), readClaim)).toEqual({
      status: 'denied',
      reason: 'Current authority does not permit recorded writes.',
    });
    expect(await stockText('staff')).toBe(before);
  });

  test('an access change between admission and the stock effect refuses the write', async () => {
    const before = await stockText('own');
    const racing = new InventoryStockService<LocalInventoryClaim>({
      store,
      stockPath: FIXTURE_STOCK_PATH,
      authorize: async (claim, phase) => {
        if (phase.phase === 'effect')
          await workspaces.createAccessProfile(ownOrganization.id, {
            name: 'Late profile',
            description: 'Created while a receipt was in flight.',
            permissions: ['inventory:view'],
          });
        return access.authorize(claim, phase);
      },
    });
    const current = inventoryViewSchema.parse(await (await request('/own/view')).json());
    const version = current.catalog.balances.find((row) => row.itemId === 'bolt')!.version;
    const claim = access.claim(ingress(), {
      projectId: projects.own.id,
      action: 'command',
      command: command('race-1', version),
    });
    expect(await racing.execute(projects.own.id, command('race-1', version), claim)).toEqual({
      status: 'denied',
      reason: 'Inventory authority changed before the stock effect; retry after refreshing access.',
    });
    expect(await stockText('own')).toBe(before);
  });

  test('(c) the ingress guard refuses anything that is not loopback', async () => {
    expect(inventoryIngressRefusal(ingress())).toBeNull();
    expect(
      inventoryIngressRefusal(ingress({ remote: '::1', local: '::1', host: '[::1]:5' })),
    ).toBeNull();
    for (const refused of [
      ingress({ remote: '192.0.2.10' }),
      ingress({ remote: '10.0.0.4', local: '10.0.0.2' }),
      ingress({ local: '192.0.2.2' }),
      ingress({ host: '192.0.2.2:47631' }),
      ingress({ host: 'localhost:47631' }),
      { ...ingress(), headers: { ...ingress().headers, 'x-forwarded-for': '192.0.2.10' } },
      { ...ingress(), headers: { ...ingress().headers, forwarded: 'for=192.0.2.10' } },
    ])
      expect(inventoryIngressRefusal(refused)).toMatchObject({
        status: 403,
        details: { code: INVENTORY_REFUSAL.loopbackOnly },
      });
    // Over a real loopback socket: a relayed request and a non-loopback Host are refused.
    const relayed = await request('/own/view', { headers: { 'X-Forwarded-For': '192.0.2.10' } });
    expect(relayed.status).toBe(403);
    expect(await relayed.json()).toMatchObject({ code: INVENTORY_REFUSAL.loopbackOnly });
    const port = (server.address() as AddressInfo).port;
    const hosted = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/own/view',
          headers: { Host: `192.0.2.2:${port}`, 'X-Diomedes-Session': token },
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(hosted.status).toBe(403);
    expect(JSON.parse(hosted.body)).toMatchObject({ code: INVENTORY_REFUSAL.loopbackOnly });
  });

  test.skipIf(!lan)(
    '(c) a listener bound beyond loopback refuses a request from another address',
    async () => {
      const before = await stockText('own');
      const response = await fetch(`http://${lan!.address}:${widePort}/own/receipts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Diomedes-Session': token },
        body: JSON.stringify(command('lan-1')),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: INVENTORY_REFUSAL.loopbackOnly });
      expect(await stockText('own')).toBe(before);
    },
  );

  test('a tenant label is mapped only from the exact local form, never guessed', () => {
    expect(inventoryTenantId({ id: 'org_a', tenantId: 'tenant-a' })).toBe('tenant-a');
    expect(inventoryTenantId({ id: 'org_a', tenantId: 'org:org_a' })).toBe('org.org_a');
    expect(inventoryTenantId({ id: 'org_a', tenantId: 'org:org_b' })).toBeNull();
    expect(inventoryTenantId({ id: 'org_a', tenantId: 'hosted:tenant/a' })).toBeNull();
  });

  test('the local access has no unauthenticated mode', () => {
    for (const sessionToken of ['', 'abc', 'g'.repeat(64)])
      expect(() => createLocalInventoryAccess({ workspaces, sessionToken })).toThrow(
        'Inventory access needs the desktop session token.',
      );
  });
});

describe('inventory composition boundary', () => {
  const sourceFiles = async (directory: string): Promise<string[]> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.(?:ts|tsx|mjs|cjs|js)$/.test(entry.name) ? [full] : [];
      }),
    );
    return nested.flat();
  };

  test('shipped code never composes inventory routes without the local access check', async () => {
    const files = [...(await sourceFiles('server')), ...(await sourceFiles('desktop'))];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      // The receipt test authority double stays in tests/ and scripts/.
      expect(text, file).not.toMatch(/fixtures\/inventory-receipts/);
      if (file.replace(/\\/g, '/').endsWith('server/inventory/receipt-routes.ts')) continue;
      if (/inventoryReceiptRoutes\s*[<(]/.test(text))
        expect(text, `${file} mounts inventory without local access`).toMatch(
          /createLocalInventoryAccess\s*\(/,
        );
    }
  });
});
