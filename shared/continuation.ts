/**
 * W00 continuation projections. Existing Task/Run/Step records remain the
 * authority. No capsule schedules, resumes, approves or replays an effect.
 * Opaque provider transcripts and live Effect objects are intentionally absent.
 */
import { z } from 'zod';
import { memoryContractText, memoryEnvelopeShape, sourceRefSchema } from './memory.js';

export const CONTINUATION_CONTRACT_VERSION = 1 as const;
const id = memoryContractText(512);

/** The optional generated part; exact goals, constraints and refs are host-owned. */
export const continuationNarrativeSchema = z.strictObject({
  openQuestions: z.array(memoryContractText(4000)).max(64),
  nextIntentions: z.array(memoryContractText(4000)).max(32),
});
export type ContinuationNarrative = z.infer<typeof continuationNarrativeSchema>;

export const continuationCapsuleSchema = z.strictObject({
  ...memoryEnvelopeShape,
  v: z.literal(CONTINUATION_CONTRACT_VERSION),
  recordType: z.literal('capsule'),
  taskId: id,
  runId: id,
  sourceSnapshotId: id,
  goal: memoryContractText(8000),
  constraints: z.array(z.strictObject({
    text: memoryContractText(8000),
    sources: z.array(sourceRefSchema).max(256),
  })).max(64),
  runtimeStateRefs: z.array(id).max(256),
  memoryRevisionRefs: z.array(id).max(256),
  ...continuationNarrativeSchema.shape,
  coverageRefs: z.array(id).max(256),
  previousRevision: z.number().int().positive().nullable(),
  continuationIndex: z.number().int().nonnegative(),
});
export type ContinuationCapsule = z.infer<typeof continuationCapsuleSchema>;
