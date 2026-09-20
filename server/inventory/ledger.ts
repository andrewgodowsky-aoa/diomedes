import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  inventoryBalanceSchema,
  inventoryCatalogSchema,
  inventoryCommandSchema,
  inventoryReceiptSchema,
  type InventoryBalance,
  type InventoryCommand,
  type InventoryReceipt,
  type InventoryScope,
} from '../../shared/inventory.js';
import { ApiError, MAX_TEXT_BYTES } from '../paths.js';
import { assertInventoryScope } from './catalog.js';

/** A bounded document proposal for the existing Store, never a store or effect owner. */
export const INVENTORY_OPERATION_LIMIT = 10_000;
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const id = inventoryReceiptSchema.shape.id;
const operationSchema = z.strictObject({
  previousDocumentVersion: id,
  documentVersion: id,
  command: inventoryCommandSchema,
  receipt: inventoryReceiptSchema,
  before: z.array(inventoryBalanceSchema).min(1).max(2),
});
const documentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: id,
  catalog: inventoryCatalogSchema,
  operations: z.array(operationSchema).max(INVENTORY_OPERATION_LIMIT),
});
export type InventoryStockDocument = z.infer<typeof documentSchema>;
export type InventoryStockSnapshot = Immutable<InventoryStockDocument>;
export type InventoryOperationRecord = z.infer<typeof operationSchema>;

export function freezeInventory<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeInventory(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

/** Canonical semantic identity. The future Store must also CAS its actual read bytes. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export const inventoryDigest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
export const inventoryLocationKey = (row: {
  itemId: string;
  siteId: string;
  binId: string;
}): string => JSON.stringify([row.itemId, row.siteId, row.binId]);
const invalid = (message: string): never => {
  throw new ApiError(422, message);
};
const conflict = (message: string): never => {
  throw new ApiError(409, message);
};

/** Match Store's single text document ceiling; never trim receipts to make room. */
export function assertInventoryDocumentSize(
  document: InventoryStockDocument | InventoryStockSnapshot,
): void {
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_TEXT_BYTES)
    return conflict(
      'The stock document exceeds the Store text limit; reviewed archival is required without dropping operation history.',
    );
}

/** Reusable reduction of parsed values only; no mutation, clock, IO or authority. */
export function proposeInventoryBalances(
  command: InventoryCommand,
  before: readonly InventoryBalance[],
  recordedAt: string,
  versions: readonly string[],
): InventoryBalance[] {
  const endpoints = [
    {
      itemId: command.itemId,
      siteId: command.siteId,
      binId: command.binId,
      version: command.expectedVersion,
    },
  ];
  if (command.kind === 'transfer')
    endpoints.push({
      itemId: command.itemId,
      ...command.destination,
      version: command.destination.expectedVersion,
    });
  if (before.length !== endpoints.length || versions.length !== endpoints.length)
    return invalid('The command needs exactly its source and any destination records.');
  return before.map((balance, index) => {
    const endpoint = endpoints[index];
    if (
      inventoryLocationKey(balance) !== inventoryLocationKey(endpoint) ||
      command.quantity.unit !== balance.unit ||
      command.quantity.scale !== balance.scale
    )
      return invalid('Use the exact item, location, base unit and precision.');
    if (balance.version !== endpoint.version)
      return conflict('The stock version changed; refresh this location.');
    if (versions[index] === balance.version)
      return invalid('A proposed balance needs a new version.');
    if (Date.parse(balance.observedAt) > Date.parse(recordedAt))
      return invalid('Host time precedes the current stock observation.');
    if (balance.reservedMinor === null)
      return invalid('Unknown reservations cannot establish safe available stock.');
    let onHandMinor: number;
    if (command.kind === 'adjust' || command.kind === 'record-count') {
      onHandMinor = command.quantity.minor;
    } else {
      if (balance.onHandMinor === null)
        return invalid('On-hand stock is unknown; prepare an evidenced count first.');
      const add = command.kind === 'receive' || (command.kind === 'transfer' && index === 1);
      if (add && command.quantity.minor > Number.MAX_SAFE_INTEGER - balance.onHandMinor)
        return invalid('Stock addition exceeds the safe integer limit.');
      onHandMinor = balance.onHandMinor + (add ? command.quantity.minor : -command.quantity.minor);
    }
    if (!Number.isSafeInteger(onHandMinor) || onHandMinor < balance.reservedMinor)
      return invalid('The proposed quantity would leave available stock negative or unsafe.');
    if (command.kind === 'record-count') {
      const counted = Date.parse(command.countEvidence.countedAt);
      if (
        counted > Date.parse(recordedAt) ||
        counted < Date.parse(balance.observedAt) ||
        (balance.lastMovementAt !== null && counted < Date.parse(balance.lastMovementAt)) ||
        (balance.lastPhysicalCountAt !== null && counted <= Date.parse(balance.lastPhysicalCountAt))
      )
        return invalid(
          'Count evidence must follow the prior count, cover current observations and not be in the future.',
        );
    }
    return inventoryBalanceSchema.parse({
      ...balance,
      onHandMinor,
      availableMinor: onHandMinor - balance.reservedMinor,
      version: versions[index],
      observedAt: recordedAt,
      lastMovementAt:
        command.kind === 'record-count' || onHandMinor === balance.onHandMinor
          ? balance.lastMovementAt
          : recordedAt,
      lastPhysicalCountAt:
        command.kind === 'record-count'
          ? command.countEvidence.countedAt
          : balance.lastPhysicalCountAt,
      countEvidence:
        command.kind === 'record-count' ? command.countEvidence : balance.countEvidence,
      // Original source observation and physical-count provenance are never relabeled as fresh.
    });
  });
}

/** Corrections append one exact inverse; this is compatibility, never permission. */
export function assertInventoryCorrection(
  command: InventoryCommand,
  before: readonly InventoryBalance[],
  operations: readonly InventoryOperationRecord[],
): void {
  if (!command.correctsReceiptId) return;
  const original = operations.find((record) => record.receipt.id === command.correctsReceiptId);
  if (!original) return invalid('The correction receipt is unavailable in this document.');
  if (operations.some((record) => record.command.correctsReceiptId === command.correctsReceiptId))
    return conflict('This receipt already has a correction.');
  const previous = original.command;
  const sameSource = inventoryLocationKey(command) === inventoryLocationKey(previous);
  const sameQuantity = inventoryDigest(command.quantity) === inventoryDigest(previous.quantity);
  let valid = false;
  if (previous.kind === 'receive' || previous.kind === 'use') {
    valid =
      sameSource &&
      sameQuantity &&
      command.kind === (previous.kind === 'receive' ? 'use' : 'receive');
  } else if (previous.kind === 'transfer' && command.kind === 'transfer') {
    valid =
      sameQuantity &&
      command.itemId === previous.itemId &&
      command.siteId === previous.destination.siteId &&
      command.binId === previous.destination.binId &&
      command.destination.siteId === previous.siteId &&
      command.destination.binId === previous.binId;
  } else if (
    (previous.kind === 'adjust' || previous.kind === 'record-count') &&
    command.kind === 'adjust'
  ) {
    valid =
      sameSource &&
      original.before[0].onHandMinor !== null &&
      command.quantity.minor === original.before[0].onHandMinor &&
      command.quantity.unit === previous.quantity.unit &&
      command.quantity.scale === previous.quantity.scale &&
      before[0]?.version === original.receipt.changes[0].version;
  }
  if (!valid)
    return invalid(
      'A correction must be the exact inverse of this receipt; absolute restoration needs its unchanged version and a known prior quantity.',
    );
}

export function inventoryReceiptChanges(
  before: readonly InventoryBalance[],
  after: readonly InventoryBalance[],
): InventoryReceipt['changes'] {
  return after.map((balance, index) => ({
    itemId: balance.itemId,
    siteId: balance.siteId,
    binId: balance.binId,
    previousVersion: before[index].version,
    version: balance.version,
    onHandMinor: balance.onHandMinor!,
    reservedMinor: balance.reservedMinor,
    unit: balance.unit,
    scale: balance.scale,
  }));
}

/** Validate detached recorded data, including history continuity, before any planning/replay. */
export function parseInventoryStockDocument(
  input: unknown,
  hostScope: InventoryScope,
): InventoryStockSnapshot {
  const parsed = documentSchema.safeParse(input);
  if (!parsed.success)
    return invalid('Invalid inventory document, records or bounded operation history.');
  const document = parsed.data;
  assertInventoryScope(document.catalog.scope, hostScope);
  assertInventoryDocumentSize(document);
  const current = new Map(
    document.catalog.balances.map((balance) => [inventoryLocationKey(balance), balance]),
  );
  const last = new Map<string, InventoryBalance>();
  const seenVersions = new Map<string, Set<string>>();
  const operationIds = new Set<string>();
  const receiptIds = new Set<string>();
  const historyIds = new Set<string>();
  const documentVersions = new Set<string>();
  let previous: InventoryOperationRecord | undefined;
  const verified: InventoryOperationRecord[] = [];
  for (const record of document.operations) {
    const { command, receipt, before } = record;
    assertInventoryScope(receipt.scope, hostScope);
    if (
      operationIds.has(command.operationId) ||
      receiptIds.has(receipt.id) ||
      historyIds.has(receipt.historyEntryId)
    )
      return invalid('Duplicate operation, receipt or history identity in recorded document.');
    operationIds.add(command.operationId);
    receiptIds.add(receipt.id);
    historyIds.add(receipt.historyEntryId);
    if (!previous) documentVersions.add(record.previousDocumentVersion);
    if (
      (previous && record.previousDocumentVersion !== previous.documentVersion) ||
      documentVersions.has(record.documentVersion)
    )
      return invalid('Recorded document versions do not form an append-only chain.');
    documentVersions.add(record.documentVersion);
    if (previous && Date.parse(receipt.recordedAt) < Date.parse(previous.receipt.recordedAt))
      return invalid('Recorded operation time cannot go backwards.');
    if (
      receipt.operationId !== command.operationId ||
      receipt.kind !== command.kind ||
      receipt.reason !== (command.reason ?? null) ||
      receipt.jobId !== (command.jobId ?? null) ||
      receipt.correctsReceiptId !== (command.correctsReceiptId ?? null)
    )
      return invalid('Recorded receipt does not match the complete command.');
    for (const balance of before) {
      const key = inventoryLocationKey(balance);
      const currentBalance = current.get(key);
      if (
        !currentBalance ||
        currentBalance.unit !== balance.unit ||
        currentBalance.scale !== balance.scale ||
        (last.has(key) && inventoryDigest(last.get(key)) !== inventoryDigest(balance))
      )
        return invalid(
          'Recorded stock history is inconsistent with its item/location or previous receipt.',
        );
      if (!seenVersions.has(key)) seenVersions.set(key, new Set([balance.version]));
    }
    assertInventoryCorrection(command, before, verified);
    const after = proposeInventoryBalances(
      command,
      before,
      receipt.recordedAt,
      receipt.changes.map((change) => change.version),
    );
    if (
      inventoryDigest(receipt.changes) !== inventoryDigest(inventoryReceiptChanges(before, after))
    )
      return invalid('Recorded receipt quantities or versions do not match its command.');
    for (const balance of after) {
      const key = inventoryLocationKey(balance);
      const versions = seenVersions.get(key)!;
      if (versions.has(balance.version)) return invalid('A recorded balance version was reused.');
      versions.add(balance.version);
      last.set(key, balance);
    }
    verified.push(record);
    previous = record;
  }
  if (previous && previous.documentVersion !== document.version)
    return invalid('Document version does not match its recorded history.');
  for (const [key, balance] of last) {
    if (inventoryDigest(balance) !== inventoryDigest(current.get(key)))
      return invalid('Current stock does not match the final recorded receipt.');
  }
  return freezeInventory(document);
}
