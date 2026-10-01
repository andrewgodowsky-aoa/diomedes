/**
 * Owned child-process driver for tests/inventory-durability.test.ts.
 * Each invocation runs the real Store + inventory stock service/repository in a
 * separate process against real files. Arguments arrive as a JSON file path in
 * argv[2]; the result is written as JSON to `args.out`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { identifier, Store } from '../../server/store.js';
import { ApiError } from '../../server/paths.js';
import { parseInventoryStockDocument } from '../../server/inventory/ledger.js';
import { InventoryStockRepository } from '../../server/inventory/stock-repository.js';
import {
  InventoryStockService,
  type InventoryStockAuthorization,
} from '../../server/inventory/stock-service.js';
import { prepareInventoryCommand } from '../../server/inventory/commands.js';
import {
  inventoryCommandSchema,
  inventoryReceiptSchema,
  type InventoryScope,
} from '../../shared/inventory.js';

interface ChildArgs {
  mode: 'execute' | 'guarded-commit' | 'status' | 'view' | 'recover';
  dataDir: string;
  projectRoot: string;
  projectId: string;
  scope: InventoryScope;
  stockPath: string;
  actorPersonId?: string;
  /** execute/guarded-commit: the command JSON. status: the operation ID string. */
  command?: unknown;
  /** Directory used for file-based synchronization markers. */
  syncDir?: string;
  /** Written before waiting on waitForMarkers / inside guarded-commit's barrier. */
  selfMarker?: string;
  /** If true, waitForMarkers are awaited BEFORE selfMarker is written (observe-then-signal). */
  selfMarkerAfterWait?: boolean;
  /** Markers this child waits for inside the guarded commit's beforeReplace. */
  peerMarkers?: string[];
  /** If true, a peer-marker timeout proceeds instead of throwing. */
  peerWaitSoft?: boolean;
  /** Markers to wait for BEFORE Store init. */
  waitForMarkers?: string[];
  /** Written once Store + service are constructed (post-init rendezvous). */
  parkedMarker?: string;
  /** Markers awaited AFTER Store init, before the mode action. */
  waitAfterInitMarkers?: string[];
  /** Written after the mode action completes (before the result file). */
  doneMarker?: string;
  /** Milliseconds a peer/marker wait may take before giving up (default 15000). */
  waitTimeoutMs?: number;
  /** Result file path. */
  out: string;
}

function allowed(scope: InventoryScope, actorPersonId: string): InventoryStockAuthorization {
  return {
    scope,
    actorPersonId,
    permissions: ['receive', 'use', 'transfer', 'adjust', 'record-count', 'correct'],
    authority: {
      principal: {
        kind: 'session',
        id: `principal-${actorPersonId}`,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        deviceId: 'child-device',
        sessionId: 'child-session',
        slotId: null,
      },
      generation: { identity: 1, principal: 1 },
      assurance: 'device-key',
      capabilities: new Set(['project.read', 'write.apply']),
      expiresAt: null,
      synthetic: false,
      resolvedAt: new Date().toISOString(),
    },
  };
}

async function markerExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function waitForMarkers(dir: string, names: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(names);
  while (pending.size > 0) {
    for (const name of [...pending]) {
      if (await markerExists(path.join(dir, name))) pending.delete(name);
    }
    if (pending.size === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for markers: ${[...pending].join(', ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function writeMarker(dir: string, name: string): Promise<void> {
  await fs.writeFile(path.join(dir, name), String(process.pid));
}

async function main() {
  const args: ChildArgs = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const actor = args.actorPersonId ?? 'person-1';
  const timeout = args.waitTimeoutMs ?? 15_000;
  const result: Record<string, unknown> = { pid: process.pid };
  try {
    if (args.syncDir && args.waitForMarkers?.length) {
      if (args.selfMarker && !args.selfMarkerAfterWait) {
        await writeMarker(args.syncDir, args.selfMarker);
      }
      await waitForMarkers(args.syncDir, args.waitForMarkers, timeout);
      if (args.selfMarker && args.selfMarkerAfterWait) {
        await writeMarker(args.syncDir, args.selfMarker);
      }
    }
    const store = new Store(args.dataDir, args.projectRoot);
    await store.init();
    const authorize = async () => allowed(args.scope, actor);
    const service = new InventoryStockService({
      store,
      stockPath: args.stockPath,
      authorize,
    });
    if (args.syncDir && args.parkedMarker) await writeMarker(args.syncDir, args.parkedMarker);
    if (args.syncDir && args.waitAfterInitMarkers?.length) {
      await waitForMarkers(args.syncDir, args.waitAfterInitMarkers, timeout);
    }

    switch (args.mode) {
      case 'recover': {
        await service.init(args.projectId);
        result.status = 'ok';
        break;
      }
      case 'execute': {
        const command = inventoryCommandSchema.parse(args.command);
        result.result = await service.execute(args.projectId, command, 'child');
        result.status = 'result';
        break;
      }
      case 'status': {
        result.result = await service.status(args.projectId, String(args.command), 'child');
        result.status = 'result';
        break;
      }
      case 'view': {
        const view = await service.view(args.projectId, 'child');
        result.result = {
          canReceive: view.canReceive,
          receipts: view.history.map((row) => ({
            operationId: row.receipt.operationId,
            historyEntryId: row.receipt.historyEntryId,
          })),
          historyEntries: view.history.length,
          historyLabels: view.history.map((row) => row.history.label),
        };
        result.status = 'result';
        break;
      }
      case 'guarded-commit': {
        const command = inventoryCommandSchema.parse(args.command);
        const repo = new InventoryStockRepository(store, args.stockPath);
        const beforeText = await repo.read(args.projectId);
        if (beforeText === null) throw new Error('stock document missing');
        const outcome = await store.locked(() =>
          repo.commit(
            args.projectId,
            beforeText,
            {
              sentence: `Inventory ${command.kind} recorded for ${actor}.`,
              label: command.operationId,
            },
            (entry) => {
              const snapshot = parseInventoryStockDocument(
                JSON.parse(beforeText),
                args.scope,
              );
              const prepared = prepareInventoryCommand(snapshot, command, {
                scope: args.scope,
                actorPersonId: actor,
                now: entry.time,
                nextDocumentVersion: identifier('D'),
                receiptId: identifier('R'),
                historyEntryId: entry.id,
                balanceVersions: {
                  source: identifier('B'),
                  destination: command.kind === 'transfer' ? identifier('B') : undefined,
                },
              });
              if (prepared.status !== 'prepared') {
                throw new Error(`unexpected recorded match: ${prepared.status}`);
              }
              return {
                afterText: JSON.stringify(prepared.proposedDocument, null, 2),
                receipt: inventoryReceiptSchema.parse(prepared.proposedReceipt),
              };
            },
            async () => {
              if (args.syncDir && args.selfMarker) await writeMarker(args.syncDir, args.selfMarker);
              if (args.syncDir && args.peerMarkers?.length) {
                try {
                  await waitForMarkers(args.syncDir, args.peerMarkers, timeout);
                } catch (error) {
                  if (!args.peerWaitSoft) throw error;
                }
              }
            },
          ),
        );
        inventoryReceiptSchema.parse(outcome);
        result.status = 'applied';
        result.receipt = outcome;
        break;
      }
    }
    if (args.syncDir && args.doneMarker) await writeMarker(args.syncDir, args.doneMarker);
  } catch (error) {
    result.status = 'thrown';
    result.error =
      error instanceof ApiError
        ? { kind: 'api', status: error.status, code: error.details.code, message: error.message }
        : { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(result, null, 2));
  process.exit(result.status === 'thrown' ? 2 : 0);
}

main().catch((error) => {
  console.error('inventory-stock-child fatal:', error);
  process.exit(3);
});
