import { z } from 'zod';
import type { Organization, OutputBinding, Person } from './workspaces.js';

/** Public data and intent only. Parsing these records never authenticates or grants access. */
export const INVENTORY_CONTRACT_VERSION = 1 as const;
export const INVENTORY_CONTRACT_REVISION = '2026-09-19.2' as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
// Date comparisons use JavaScript millisecond instants. Do not admit precision
// that those comparisons would silently discard.
const time = z.iso
  .datetime({ offset: true })
  .refine((value) => !/\.\d{4,}/.test(value), 'Use at most millisecond timestamp precision.');
const label = z
  .string()
  .max(500)
  .refine((value) => value.trim().length > 0, 'A label is required.');
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scale = z.number().int().min(0).max(6);
const unit = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,31}$/);
const barcode = z
  .string()
  .regex(/^[\x20-\x7e]{1,128}$/)
  .refine((value) => value.trim().length > 0);

/** The same organization, tenant and explicit project binding used by Workspaces. */
export interface InventoryScope {
  organizationId: Organization['id'];
  tenantId: Organization['tenantId'];
  projectId: OutputBinding['projectId'];
}
export const inventoryScopeSchema = z.strictObject({
  organizationId: id,
  tenantId: id,
  projectId: id,
});

/** minor / 10**scale in the declared base unit; no implicit conversion or coercion. */
export const inventoryQuantitySchema = z.strictObject({ minor, scale, unit });
export type InventoryQuantity = z.infer<typeof inventoryQuantitySchema>;

export const inventoryItemSchema = z.strictObject({
  id,
  name: label,
  variant: label.nullable(),
  unit,
  scale,
  barcodes: z
    .array(barcode)
    .max(32)
    .refine((codes) => new Set(codes).size === codes.length, 'Duplicate barcode.'),
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export const inventorySiteSchema = z.strictObject({ id, name: label });
export const inventoryBinSchema = z.strictObject({ id, siteId: id, name: label });

export const inventorySourceSchema = z.strictObject({
  kind: z.enum(['synthetic', 'approved-file', 'connected', 'recorded-ledger']),
  reference: label,
  revision: label,
  observedAt: time,
});
export const inventoryCountEvidenceSchema = z.strictObject({ countedAt: time, reference: label });

export const inventoryBalanceSchema = z
  .strictObject({
    itemId: id,
    siteId: id,
    binId: id,
    onHandMinor: minor.nullable(),
    reservedMinor: minor.nullable(),
    availableMinor: minor.nullable(),
    unit,
    scale,
    version: id,
    observedAt: time,
    lastMovementAt: time.nullable(),
    lastPhysicalCountAt: time.nullable(),
    countEvidence: inventoryCountEvidenceSchema.nullable(),
    source: inventorySourceSchema,
  })
  .superRefine((balance, context) => {
    const problem = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    const available =
      balance.onHandMinor === null || balance.reservedMinor === null
        ? null
        : balance.onHandMinor - balance.reservedMinor;
    if (balance.availableMinor !== available)
      problem(
        'availableMinor',
        'Availability must preserve unknown quantities and equal on-hand minus reserved.',
      );
    if (available !== null && available < 0)
      problem('reservedMinor', 'Reserved stock cannot exceed recorded on-hand.');
    if ((balance.lastPhysicalCountAt === null) !== (balance.countEvidence === null)) {
      problem('countEvidence', 'A physical count needs its own time and evidence.');
    } else if (
      balance.countEvidence &&
      balance.lastPhysicalCountAt &&
      Date.parse(balance.countEvidence.countedAt) !== Date.parse(balance.lastPhysicalCountAt)
    ) {
      problem('countEvidence', 'Count evidence must identify the stated physical count.');
    }
    for (const field of ['lastMovementAt', 'lastPhysicalCountAt'] as const) {
      const value = balance[field];
      if (value !== null && Date.parse(value) > Date.parse(balance.observedAt)) {
        problem(field, 'An event cannot follow this record observation.');
      }
    }
    if (Date.parse(balance.source.observedAt) > Date.parse(balance.observedAt)) {
      problem('source', 'A source observation cannot follow the record observation.');
    }
  });
export type InventoryBalance = z.infer<typeof inventoryBalanceSchema>;

/** Bounded pilot snapshot. A connected source is provenance, not a second writable master. */
export const inventoryCatalogSchema = z
  .strictObject({
    contractVersion: z.literal(INVENTORY_CONTRACT_VERSION),
    scope: inventoryScopeSchema,
    authority: z.literal('recorded-ledger'),
    reservationMode: z.enum(['untracked', 'read-only']),
    items: z.array(inventoryItemSchema).max(10000),
    sites: z.array(inventorySiteSchema).max(100),
    bins: z.array(inventoryBinSchema).max(10000),
    balances: z.array(inventoryBalanceSchema).max(50000),
  })
  .superRefine((catalog, context) => {
    const problem = (collection: string, index: number, message: string) =>
      context.addIssue({ code: 'custom', path: [collection, index], message });
    for (const collection of ['items', 'sites', 'bins'] as const) {
      const seen = new Set<string>();
      catalog[collection].forEach((row, index) => {
        if (seen.has(row.id)) problem(collection, index, 'Duplicate identifier.');
        seen.add(row.id);
      });
    }
    const items = new Map(catalog.items.map((item) => [item.id, item]));
    const sites = new Set(catalog.sites.map((site) => site.id));
    const bins = new Map(catalog.bins.map((bin) => [bin.id, bin]));
    const codes = new Set<string>();
    catalog.items.forEach((item, index) => {
      for (const code of item.barcodes) {
        if (codes.has(code))
          problem('items', index, 'A barcode must identify one item in this tenant.');
        codes.add(code);
      }
    });
    catalog.bins.forEach((bin, index) => {
      if (!sites.has(bin.siteId)) problem('bins', index, 'The physical site does not exist.');
    });
    const locations = new Set<string>();
    catalog.balances.forEach((balance, index) => {
      const key = JSON.stringify([balance.itemId, balance.siteId, balance.binId]);
      if (locations.has(key)) problem('balances', index, 'Duplicate stock location.');
      locations.add(key);
      const item = items.get(balance.itemId);
      if (!item || item.unit !== balance.unit || item.scale !== balance.scale) {
        problem('balances', index, 'Stock must reference the item base unit and precision.');
      }
      if (!sites.has(balance.siteId) || bins.get(balance.binId)?.siteId !== balance.siteId) {
        problem('balances', index, 'Stock must reference a bin in its stated site.');
      }
      if (catalog.reservationMode === 'untracked' && balance.reservedMinor !== null) {
        problem('balances', index, 'Untracked reservations must remain unknown.');
      }
    });
  });
export type InventoryCatalog = z.infer<typeof inventoryCatalogSchema>;

const commandFields = {
  operationId: id,
  itemId: id,
  siteId: id,
  binId: id,
  expectedVersion: id,
  reason: label.optional(),
  jobId: id.optional(),
  correctsReceiptId: id.optional(),
};
const positiveQuantity = inventoryQuantitySchema.extend({ minor: minor.positive() });
export const inventoryCommandSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ ...commandFields, kind: z.literal('receive'), quantity: positiveQuantity }),
    z.strictObject({ ...commandFields, kind: z.literal('use'), quantity: positiveQuantity }),
    z.strictObject({
      ...commandFields,
      kind: z.literal('transfer'),
      quantity: positiveQuantity,
      destination: z.strictObject({ siteId: id, binId: id, expectedVersion: id }),
    }),
    // Adjust and record-count set an absolute on-hand amount. A count additionally attests evidence.
    z.strictObject({
      ...commandFields,
      kind: z.literal('adjust'),
      quantity: inventoryQuantitySchema,
      reason: label,
    }),
    z.strictObject({
      ...commandFields,
      kind: z.literal('record-count'),
      quantity: inventoryQuantitySchema,
      countEvidence: inventoryCountEvidenceSchema,
    }),
  ])
  .superRefine((command, context) => {
    if (
      command.kind === 'transfer' &&
      command.siteId === command.destination.siteId &&
      command.binId === command.destination.binId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['destination'],
        message: 'Transfer to a different bin.',
      });
    }
    if (command.correctsReceiptId && !command.reason) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A correction requires a reason.',
      });
    }
  });
export type InventoryCommand = z.infer<typeof inventoryCommandSchema>;

/** Domain compatibility only. The service must separately resolve current membership and Trust. */
export function parseInventoryCommandForItem(
  input: unknown,
  itemInput: InventoryItem,
): InventoryCommand {
  const item = inventoryItemSchema.parse(itemInput);
  return inventoryCommandSchema
    .refine(
      (command) =>
        command.itemId === item.id &&
        command.quantity.unit === item.unit &&
        command.quantity.scale === item.scale,
      'Use the selected item and its declared base unit and precision.',
    )
    .parse(input);
}

export const inventoryReceiptSchema = z
  .strictObject({
    id,
    operationId: id,
    scope: inventoryScopeSchema,
    actorPersonId: id,
    kind: z.enum(['receive', 'use', 'transfer', 'adjust', 'record-count']),
    recordedAt: time,
    historyEntryId: id,
    reason: label.nullable(),
    jobId: id.nullable(),
    correctsReceiptId: id.nullable(),
    changes: z
      .array(
        z.strictObject({
          itemId: id,
          siteId: id,
          binId: id,
          previousVersion: id,
          version: id,
          onHandMinor: minor,
          reservedMinor: minor.nullable(),
          unit,
          scale,
        }),
      )
      .min(1)
      .max(2),
  })
  .superRefine((receipt, context) => {
    const problem = (path: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    if (receipt.changes.length !== (receipt.kind === 'transfer' ? 2 : 1)) {
      problem(['changes'], 'A transfer changes exactly two endpoints; other commands change one.');
    }
    receipt.changes.forEach((change, index) => {
      if (change.reservedMinor !== null && change.reservedMinor > change.onHandMinor)
        problem(
          ['changes', index, 'reservedMinor'],
          'Reserved stock cannot exceed recorded on-hand.',
        );
      if (change.version === change.previousVersion)
        problem(['changes', index, 'version'], 'A settled change must have a new version.');
    });
    if (receipt.kind === 'transfer' && receipt.changes.length === 2) {
      const [source, destination] = receipt.changes;
      if (source.siteId === destination.siteId && source.binId === destination.binId)
        problem(['changes'], 'Transfer endpoints must be distinct.');
      if (
        source.itemId !== destination.itemId ||
        source.unit !== destination.unit ||
        source.scale !== destination.scale
      )
        problem(['changes'], 'Transfer endpoints must describe the same item, unit and precision.');
    }
    if (
      (receipt.kind === 'adjust' || receipt.correctsReceiptId !== null) &&
      receipt.reason === null
    )
      problem(['reason'], 'An adjustment or correction must retain its reason.');
  });
export type InventoryReceipt = z.infer<typeof inventoryReceiptSchema> & {
  actorPersonId: Person['id'];
};
export const inventoryResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), receipt: inventoryReceiptSchema }),
  z.strictObject({ status: z.literal('already-applied'), receipt: inventoryReceiptSchema }),
  z.strictObject({ status: z.literal('conflict'), currentVersion: id }),
  z.strictObject({ status: z.literal('denied'), reason: label }),
  z.strictObject({ status: z.literal('invalid'), reason: label }),
  z.strictObject({ status: z.literal('uncertain'), operationId: id, reason: label }),
]);
export type InventoryCommandResult = z.infer<typeof inventoryResultSchema>;
