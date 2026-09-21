import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { inventoryReceiptRoutes } from '../server/inventory/receipt-routes.js';
import { InventoryStockService } from '../server/inventory/stock-service.js';
import { createReceiptFixture, receiptTestAuthorization } from './fixtures/inventory-receipts.js';
import { inventoryResultSchema } from '../shared/inventory.js';
import { inventoryViewSchema } from '../shared/inventory-workflow.js';

describe('mobile receipt workflow over durable stock', () => {
  let root: string;
  let fixture: Awaited<ReturnType<typeof createReceiptFixture>>;
  let server: Server;
  let url: string;
  const command = (operationId = 'demo-receive-1', expectedVersion = 'bolt-opening-1') => ({
    kind: 'receive',
    operationId,
    itemId: 'bolt',
    siteId: 'workshop',
    binId: 'shelf-a',
    expectedVersion,
    quantity: { minor: 3, scale: 0, unit: 'each' },
    reason: 'Synthetic delivery note 001',
  });
  const post = (body: unknown) =>
    fetch(`${url}/receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const view = async (cursor = '') =>
    inventoryViewSchema.parse(
      await (await fetch(`${url}/view${cursor ? `?olderThan=${cursor}` : ''}`)).json(),
    );

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-receipt-workflow-'));
    fixture = await createReceiptFixture(root);
    const app = express();
    app.use(
      '/api/inventory',
      inventoryReceiptRoutes({
        service: fixture.service,
        projectId: fixture.project.id,
        claim: () => ({}),
      }),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener.');
    url = `http://127.0.0.1:${address.port}/api/inventory`;
  });
  afterEach(async () => {
    // Taken off the shared bindings before the first await, so a teardown that
    // outlives its hook can neither close nor clear the next test's server.
    const closingServer = server, closingFixture = fixture, closingRoot = root;
    if (closingServer)
      await new Promise<void>((resolve, reject) =>
        closingServer.close((error) => (error ? reject(error) : resolve())),
      );
    if (closingFixture) await closingFixture.close();
    if (closingRoot) await fs.rm(closingRoot, { recursive: true, force: true });
  });

  test('reads actual stock, preserves unknown quantities and does not invent physical counts', async () => {
    const snapshot = await view();
    expect(snapshot.canReceive).toBe(true);
    expect(snapshot.catalog.balances.map((row) => row.onHandMinor)).toEqual([12, 1250, null]);
    expect(snapshot.catalog.balances[2].availableMinor).toBeNull();
    expect(snapshot.catalog.balances.every((row) => row.lastPhysicalCountAt === null)).toBe(true);
    expect(snapshot.history).toEqual([]);
    expect((await fetch(`${url}/view`)).headers.get('cache-control')).toBe('no-store');
  });

  test('receive, same-ID replay and status use one exact Store History entry and survive restart', async () => {
    const first = inventoryResultSchema.parse(await (await post(command())).json());
    expect(first.status).toBe('applied');
    const replay = inventoryResultSchema.parse(await (await post(command())).json());
    if (first.status !== 'applied' || replay.status !== 'already-applied')
      throw new Error('Receipt did not settle.');
    expect(replay.receipt).toEqual(first.receipt);
    const current = await view();
    expect(current.catalog.balances[0].onHandMinor).toBe(15);
    expect(current.catalog.balances[0].lastPhysicalCountAt).toBeNull();
    expect(current.history).toHaveLength(1);
    expect(current.history[0].beforeOnHandMinor).toEqual([12]);
    expect(current.history[0].history.id).toBe(first.receipt.historyEntryId);
    expect(current.history[0].receipt.actorPersonId).toBe('demo-person');
    expect(JSON.stringify(current.history)).not.toContain(fixture.project.folder);
    expect(await (await fetch(`${url}/operations/demo-receive-1`)).json()).toEqual(first);
    await fixture.close();
    const reopened = await createReceiptFixture(root);
    try {
      expect((await reopened.service.view(reopened.project.id, {})).history).toEqual(
        current.history,
      );
      expect(await reopened.service.execute(reopened.project.id, command(), {})).toEqual(replay);
    } finally {
      await reopened.close();
    }
  });

  test('two devices reviewing the same version produce one receipt and an explicit conflict', async () => {
    const replies = await Promise.all([post(command('phone')), post(command('tablet'))]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect((await view()).catalog.balances[0].onHandMinor).toBe(15);
    expect(fixture.store.state(fixture.project.id).history).toHaveLength(1);
  });

  test('simultaneous duplicate requests settle once and changed intent keeps the original receipt', async () => {
    const replies = await Promise.all([post(command()), post(command())]);
    const results = await Promise.all(replies.map((reply) => reply.json()));
    expect(results.map((result) => result.status).sort()).toEqual(['already-applied', 'applied']);
    expect(
      (await post({ ...command(), quantity: { minor: 4, scale: 0, unit: 'each' } })).status,
    ).toBe(409);
    expect((await view()).history).toHaveLength(1);
    expect((await view()).catalog.balances[0].onHandMinor).toBe(15);
  });

  test.each([
    { actorPersonId: 'attacker' },
    { scope: { projectId: 'elsewhere' } },
    { stockPath: '../other.json' },
    { kind: 'use' },
    { jobId: 'purchase-order' },
    { correctsReceiptId: 'old-receipt' },
    { quantity: { minor: 1.5, scale: 0, unit: 'each' } },
  ])('rejects foreign authority, paths and out-of-scope intent: %j', async (extra) => {
    expect((await post({ ...command(), ...extra })).status).toBe(422);
    expect((await view()).history).toHaveLength(0);
  });

  test('read-only and revocation are enforced on writes, reads and replay', async () => {
    await post(command());
    fixture.control.access = 'read-only';
    expect((await view()).canReceive).toBe(false);
    expect((await post(command())).status).toBe(403);
    fixture.control.access = 'revoked';
    expect((await fetch(`${url}/view`)).status).toBe(403);
    const status = await fetch(`${url}/operations/demo-receive-1`);
    expect(status.status).toBe(403);
    expect(await status.json()).not.toHaveProperty('receipt');
    expect((await post(command())).status).toBe(403);
    expect(fixture.store.state(fixture.project.id).history).toHaveLength(1);
  });

  test('revocation immediately before replacement prevents the receipt', async () => {
    fixture.control.revokeAtEffect = true;
    expect((await post(command())).status).toBe(403);
    expect((await view()).catalog.balances[0].onHandMinor).toBe(12);
    expect(fixture.store.state(fixture.project.id).history).toHaveLength(0);
  });

  test('history authorizer cannot cross the tenant binding or use synthetic authority', async () => {
    for (const alteration of ['tenant', 'synthetic'] as const) {
      const service = new InventoryStockService({
        store: fixture.store,
        stockPath: 'inventory/stock.json',
        authorize: async () => {
          const authorization = receiptTestAuthorization(fixture.scope, 'receive');
          if (alteration === 'tenant')
            authorization.authority.principal.tenantId = 'another-tenant';
          else authorization.authority.synthetic = true;
          return authorization;
        },
      });
      await expect(service.view(fixture.project.id, {})).rejects.toMatchObject({ status: 403 });
    }
  });

  test('new receipts do not shift an older-history cursor or hide earlier evidence', async () => {
    for (let index = 0; index < 22; index++) {
      const current = await view();
      expect(
        (await post(command(`receive-${index}`, current.catalog.balances[0].version))).status,
      ).toBe(200);
    }
    const first = await view();
    expect(first.history).toHaveLength(20);
    expect(first.olderThan).toBeTruthy();
    await post(command('later-receive', first.catalog.balances[0].version));
    const older = await view(first.olderThan!);
    expect(older.history.map((row) => row.receipt.operationId)).toEqual(['receive-1', 'receive-0']);
    expect(older.olderThan).toBeNull();
    expect((await fetch(`${url}/view?olderThan=absent-receipt`)).status).toBe(404);
  });

  test('missing History evidence and damaged ledger block the view instead of returning an empty success', async () => {
    await post(command());
    fixture.store.state(fixture.project.id).history.length = 0;
    expect((await fetch(`${url}/view`)).status).toBe(409);
    await fs.writeFile(fixture.stockFile, '{broken');
    expect((await fetch(`${url}/view`)).status).toBe(422);
  });

  test('unknown stock is not treated as zero and the narrow router exposes no purchasing or admin action', async () => {
    expect(
      (await post({ ...command(), itemId: 'seal', expectedVersion: 'seal-opening-1' })).status,
    ).toBe(422);
    expect((await fetch(`${url}/orders`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${url}/projects`)).status).toBe(404);
    expect((await fetch(`${url}/operations/unrecorded`)).status).toBe(200);
    expect((await view()).history).toHaveLength(0);
  });
});
