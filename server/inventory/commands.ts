import { z } from 'zod';
import {
  inventoryCommandSchema,
  inventoryReceiptSchema,
  inventoryScopeSchema,
  inventorySourceSchema,
  type InventoryReceipt,
} from '../../shared/inventory.js';
import { ApiError } from '../paths.js';
import {
  assertInventoryCorrection,
  assertInventoryDocumentSize,
  freezeInventory,
  INVENTORY_OPERATION_LIMIT,
  inventoryDigest,
  inventoryLocationKey,
  inventoryReceiptChanges,
  parseInventoryStockDocument,
  proposeInventoryBalances,
  type InventoryStockDocument,
  type InventoryStockSnapshot,
} from './ledger.js';

const id = inventoryReceiptSchema.shape.id;
const contextSchema = z.strictObject({
  scope: inventoryScopeSchema,
  actorPersonId: id,
  now: inventorySourceSchema.shape.observedAt,
  nextDocumentVersion: id,
  receiptId: id,
  historyEntryId: id,
  balanceVersions: z.strictObject({ source: id, destination: id.optional() }),
});
/** Supplied by trusted host resolution and the existing writer's allocation, never the request body.
 * Validating this shape is not authentication, authorization or proof that an ID was persisted. */
export type InventoryPreparationContext = z.infer<typeof contextSchema>;
type ReceiptSnapshot = InventoryStockSnapshot['operations'][number]['receipt'];
export type InventoryPreparationResult =
  | {
      readonly status: 'recorded-match';
      readonly recordedReceipt: ReceiptSnapshot;
      readonly requiresFreshHostAuthorization: true;
    }
  | {
      readonly status: 'prepared';
      readonly expectedDocumentVersion: string;
      readonly expectedDocumentDigest: string;
      readonly proposedDocument: InventoryStockSnapshot;
      readonly proposedReceipt: ReceiptSnapshot;
      readonly requiresFreshHostAuthorization: true;
    };

/** Pure only: no write, grant, applied response, retry, clock read, IO or model invocation. */
export function prepareInventoryCommand(
  documentInput: unknown,
  commandInput: unknown,
  hostInput: InventoryPreparationContext,
): InventoryPreparationResult {
  const context = contextSchema.safeParse(hostInput);
  const intent = inventoryCommandSchema.safeParse(commandInput);
  if (!context.success || !intent.success)
    throw new ApiError(
      422,
      'A valid stock intent and separately resolved host context are required.',
    );
  const host = context.data;
  const command = intent.data;
  const snapshot = parseInventoryStockDocument(documentInput, host.scope);
  // Parsing detached the entire document; this private copy is the only mutable value below.
  const document = structuredClone(snapshot) as InventoryStockDocument;
  const existing = document.operations.find(
    (record) => record.command.operationId === command.operationId,
  );
  if (existing) {
    if (
      existing.receipt.actorPersonId !== host.actorPersonId ||
      inventoryDigest(existing.command) !== inventoryDigest(command)
    )
      throw new ApiError(
        409,
        'This operation ID already identifies a different actor or complete intent.',
      );
    return freezeInventory({
      status: 'recorded-match' as const,
      recordedReceipt: existing.receipt,
      requiresFreshHostAuthorization: true as const,
    });
  }
  if (document.operations.length >= INVENTORY_OPERATION_LIMIT)
    throw new ApiError(
      409,
      'The bounded operation history is full; reviewed archival is required without dropping deduplication history.',
    );
  const item = document.catalog.items.find((row) => row.id === command.itemId);
  if (!item || command.quantity.unit !== item.unit || command.quantity.scale !== item.scale)
    throw new ApiError(422, 'Use an existing item and its exact base unit and precision.');
  const endpoints = [{ itemId: command.itemId, siteId: command.siteId, binId: command.binId }];
  if (command.kind === 'transfer')
    endpoints.push({
      itemId: command.itemId,
      siteId: command.destination.siteId,
      binId: command.destination.binId,
    });
  const before = endpoints.map((endpoint) => {
    const balance = document.catalog.balances.find(
      (row) => inventoryLocationKey(row) === inventoryLocationKey(endpoint),
    );
    if (!balance) throw new ApiError(404, 'The inventory item or location is unavailable.');
    return balance;
  });
  const last = document.operations.at(-1);
  if (last && Date.parse(host.now) < Date.parse(last.receipt.recordedAt))
    throw new ApiError(422, 'Host time precedes the last recorded operation.');
  if (
    host.nextDocumentVersion === document.version ||
    document.operations.some(
      (record) =>
        record.previousDocumentVersion === host.nextDocumentVersion ||
        record.documentVersion === host.nextDocumentVersion ||
        record.receipt.id === host.receiptId ||
        record.receipt.historyEntryId === host.historyEntryId,
    )
  )
    throw new ApiError(409, 'Proposed document, receipt and history identities must be fresh.');
  const versions = [host.balanceVersions.source];
  if (command.kind === 'transfer') {
    if (!host.balanceVersions.destination)
      throw new ApiError(422, 'Transfer needs a separately allocated destination version.');
    versions.push(host.balanceVersions.destination);
  }
  for (let index = 0; index < before.length; index++) {
    const key = inventoryLocationKey(before[index]);
    if (
      document.operations.some((record) =>
        [...record.before, ...record.receipt.changes].some(
          (balance) => inventoryLocationKey(balance) === key && balance.version === versions[index],
        ),
      )
    )
      throw new ApiError(409, 'A proposed balance version has already been used.');
  }
  assertInventoryCorrection(command, before, document.operations);
  const after = proposeInventoryBalances(command, before, host.now, versions);
  const receipt: InventoryReceipt = inventoryReceiptSchema.parse({
    id: host.receiptId,
    operationId: command.operationId,
    scope: host.scope,
    actorPersonId: host.actorPersonId,
    kind: command.kind,
    recordedAt: host.now,
    historyEntryId: host.historyEntryId,
    reason: command.reason ?? null,
    jobId: command.jobId ?? null,
    correctsReceiptId: command.correctsReceiptId ?? null,
    changes: inventoryReceiptChanges(before, after),
  });
  const replacements = new Map(after.map((balance) => [inventoryLocationKey(balance), balance]));
  document.catalog.balances = document.catalog.balances.map(
    (balance) => replacements.get(inventoryLocationKey(balance)) ?? balance,
  );
  document.operations.push({
    previousDocumentVersion: document.version,
    documentVersion: host.nextDocumentVersion,
    command,
    receipt,
    before,
  });
  document.version = host.nextDocumentVersion;
  assertInventoryDocumentSize(document);
  return freezeInventory({
    status: 'prepared' as const,
    expectedDocumentVersion: snapshot.version,
    expectedDocumentDigest: inventoryDigest(snapshot),
    proposedDocument: document,
    proposedReceipt: receipt,
    requiresFreshHostAuthorization: true as const,
  });
}
