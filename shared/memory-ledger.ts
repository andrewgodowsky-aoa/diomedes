/** W01 host-side ledger shapes. None of these values grant access or effects. */
import { z } from 'zod';
import { memoryContractText, memoryRecordSchema, sourceRefSchema } from './memory.js';

const id = memoryContractText(512);
const nonnegative = z.number().int().nonnegative();
const positive = z.number().int().positive();
export const memoryInstantSchema = z.string().refine(value =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
{ message: 'Expected a canonical UTC instant.' });
export const memoryScopeKeySchema = z.strictObject({ tenantId: id, workspaceId: id, scopeRef: id });
export type MemoryScopeKey = z.infer<typeof memoryScopeKeySchema>;
export const memoryEpochsSchema = z.strictObject({
  identityGeneration: nonnegative, accessEpoch: nonnegative, deletionEpoch: nonnegative,
});
export type MemoryEpochs = z.infer<typeof memoryEpochsSchema>;
export const memoryLedgerScopeSchema = memoryScopeKeySchema.extend(memoryEpochsSchema.shape);
export type MemoryLedgerScope = z.infer<typeof memoryLedgerScopeSchema>;
export const memoryRevisionRefSchema = z.strictObject({ id, revision: positive });
export type MemoryRevisionRef = z.infer<typeof memoryRevisionRefSchema>;

export const memoryEntitySchema = z.strictObject({
  id, revision: positive,
  kind: z.enum(['person', 'organization', 'location', 'other']),
  aliases: z.array(memoryContractText(512)).min(1).max(64),
  sources: z.array(sourceRefSchema).min(1).max(256),
});
export type MemoryEntity = z.infer<typeof memoryEntitySchema>;
export const memoryConflictSchema = z.strictObject({
  id, revision: positive,
  claims: z.array(memoryRevisionRefSchema).min(2).max(64),
  reason: memoryContractText(2000),
});
export type MemoryConflict = z.infer<typeof memoryConflictSchema>;
export const memoryRecordPayloadSchema = z.strictObject({
  record: memoryRecordSchema,
  /** Replacement corrects the entire prior claim; succession starts at validFrom. */
  changeMode: z.enum(['replace', 'effective-from']),
  entityId: id.nullable(),
  /** Host-declared policy identity, not a confidence score or model label. */
  authorityRef: id.nullable(),
  dependencyRevisions: z.array(memoryRevisionRefSchema).max(256),
});
export type MemoryRecordPayload = z.infer<typeof memoryRecordPayloadSchema>;
export const memoryLedgerPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('record'), value: memoryRecordPayloadSchema }),
  z.strictObject({ kind: z.literal('entity'), value: memoryEntitySchema }),
  z.strictObject({ kind: z.literal('conflict'), value: memoryConflictSchema }),
]);
export type MemoryLedgerPayload = z.infer<typeof memoryLedgerPayloadSchema>;
export const memoryLedgerEntrySchema = z.strictObject({
  kind: z.enum(['record', 'entity', 'conflict']), id, revision: positive,
  sequence: positive, recordedAt: memoryInstantSchema,
  epochs: memoryEpochsSchema, payload: memoryLedgerPayloadSchema,
});
export type MemoryLedgerEntry = z.infer<typeof memoryLedgerEntrySchema>;
export const memoryLedgerCommandSchema = z.strictObject({
  commandId: id, expectedRevision: nonnegative, payload: memoryLedgerPayloadSchema,
});
export type MemoryLedgerCommand = z.infer<typeof memoryLedgerCommandSchema>;
export const memoryChangeEventSchema = z.strictObject({
  sequence: positive, commandId: id, kind: z.enum(['record', 'entity', 'conflict']),
  id, revision: positive, recordedAt: memoryInstantSchema, epochs: memoryEpochsSchema,
});
export type MemoryChangeEvent = z.infer<typeof memoryChangeEventSchema>;
export const memoryCommitReceiptSchema = z.strictObject({
  commandId: id, entry: memoryLedgerEntrySchema, event: memoryChangeEventSchema,
});
export type MemoryCommitReceipt = z.infer<typeof memoryCommitReceiptSchema>;
export const memoryCommandReceiptSchema = z.strictObject({
  commandId: id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), result: memoryCommitReceiptSchema,
});
export type MemoryCommandReceipt = z.infer<typeof memoryCommandReceiptSchema>;

export interface MemoryLedgerSnapshot {
  scope: MemoryScopeKey;
  epochs: MemoryEpochs;
  sequence: number;
  /** Complete bounded history through sequence. Refuse rather than silently truncate. */
  entries: MemoryLedgerEntry[];
}

export const memoryScopeBackupSchema = z.strictObject({
  scope: memoryScopeKeySchema, epochs: memoryEpochsSchema, sequence: nonnegative,
  entries: z.array(memoryLedgerEntrySchema),
  commands: z.array(memoryCommandReceiptSchema),
  events: z.array(memoryChangeEventSchema),
  acknowledgements: z.array(z.strictObject({ consumerId: id, sequence: nonnegative })),
});
export const memoryLedgerBackupSchema = z.strictObject({
  v: z.literal(1), createdAt: memoryInstantSchema, scopes: z.array(memoryScopeBackupSchema),
});
export type MemoryLedgerBackup = z.infer<typeof memoryLedgerBackupSchema>;
