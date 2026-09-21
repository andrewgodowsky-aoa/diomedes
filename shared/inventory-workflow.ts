import { z } from 'zod';
import {
  inventoryCatalogSchema,
  inventoryCommandSchema,
  inventoryQuantitySchema,
  inventoryReceiptSchema,
} from './inventory.js';

/** This consumer admits a stock receipt only, never an order or a correction. */
export const inventoryReceiveSchema = inventoryCommandSchema.refine(
  (command) => command.kind === 'receive' && !command.correctsReceiptId && !command.jobId,
  'This workflow only records received stock.',
);
export type InventoryReceive = z.infer<typeof inventoryReceiveSchema>;
export const inventoryHistoryRowSchema = z.strictObject({
  receipt: inventoryReceiptSchema,
  quantity: inventoryQuantitySchema,
  beforeOnHandMinor: z.array(z.number().int().nonnegative().nullable()).max(2),
  history: z.strictObject({
    id: inventoryReceiptSchema.shape.id,
    time: z.iso.datetime({ offset: true }),
    sentence: z.string().max(2000),
    label: inventoryReceiptSchema.shape.operationId,
  }),
});
export const inventoryViewSchema = z.strictObject({
  catalog: inventoryCatalogSchema,
  canReceive: z.boolean(),
  history: z.array(inventoryHistoryRowSchema).max(20),
  olderThan: inventoryReceiptSchema.shape.id.nullable(),
});
export type InventoryView = z.infer<typeof inventoryViewSchema>;
export const inventoryOperationStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), receipt: inventoryReceiptSchema }),
  z.strictObject({
    status: z.literal('not-found'),
    operationId: inventoryReceiptSchema.shape.operationId,
  }),
  z.strictObject({ status: z.literal('denied'), reason: z.string() }),
  z.strictObject({ status: z.literal('invalid'), reason: z.string() }),
  z.strictObject({
    status: z.literal('uncertain'),
    operationId: inventoryReceiptSchema.shape.operationId,
    reason: z.string(),
  }),
]);
