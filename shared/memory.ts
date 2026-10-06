/**
 * NC-MEM-LC W00 portable contracts. Parsing is not authentication, source
 * verification, promotion, retention consent, or effect authority.
 *
 * The original package is retained in docs/product/memory-context/. Its record
 * shapes are a seed, not a second persistence service. W01/W02 own transactional
 * storage and live source authorization; no runtime uses this module yet.
 */
import { z } from 'zod';
import type { HarnessLabel, HarnessPrincipal } from './harness.js';
import { withinCodePoints } from './interaction.js';
import type { HardRestrictions } from './routing-policy.js';
import type { WorkspaceRef } from './workspaces.js';

export const MEMORY_CONTRACT_VERSION = 1 as const;
export const MEMORY_CONTRACT_SOURCE = 'NC-MEM-LC-2026-10-06.1' as const;

/** Preserve exact text and JSON Schema character limits, including astral text. */
export const memoryContractText = (max: number, min = 1) => z.string()
  .refine(value => [...value].length >= min, { message: `Expected at least ${min} characters.` })
  .refine(withinCodePoints(max), { message: `Expected at most ${max} characters.` });
const id = memoryContractText(512);
const count = z.number().int().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Storage identity and epochs come from the host, never generated proposals. */
export const memoryEnvelopeShape = {
  v: z.literal(MEMORY_CONTRACT_VERSION),
  id,
  revision: z.number().int().positive(),
  tenantId: id,
  workspaceId: id,
  accessEpoch: count,
  deletionEpoch: count,
  createdAt: memoryContractText(64),
};

export const sourceRefSchema = z.strictObject({
  sourceId: id,
  revision: memoryContractText(512, 0).nullable(),
  locator: memoryContractText(2000),
  sourceType: z.enum(['message', 'file', 'connector', 'tool-observation']),
  contentSha256: sha256.nullable(),
  observedAt: memoryContractText(64),
  accessPolicyRef: id,
  restrictionsRef: id,
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

const memoryKindSchema = z.enum(['fact', 'preference', 'episode', 'procedure-candidate']);

/** Model-facing shape. In particular no identity, epochs, verification or grants. */
export const memoryProposalSchema = z.strictObject({
  kind: memoryKindSchema,
  body: memoryContractText(16000),
  sourceLocators: z.array(z.strictObject({
    sourceId: id,
    locator: memoryContractText(2000),
  })).max(256),
});
export type MemoryProposal = z.infer<typeof memoryProposalSchema>;

/** Host/store-facing shape. Its epistemic and lifecycle axes are independent. */
export const memoryRecordSchema = z.strictObject({
  ...memoryEnvelopeShape,
  recordType: z.literal('memory'),
  kind: memoryKindSchema,
  body: memoryContractText(16000),
  lifecycle: z.enum(['candidate', 'active', 'superseded', 'retracted']),
  epistemic: z.enum(['asserted', 'source-supported', 'live-verified', 'inferred']),
  scopeRef: id,
  restrictionsRef: id,
  sources: z.array(sourceRefSchema).max(256),
  validFrom: memoryContractText(512, 0).nullable(),
  validTo: memoryContractText(512, 0).nullable(),
  dependencies: z.array(id).max(256),
  retentionClass: id,
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const memoryUseReceiptSchema = z.strictObject({
  ...memoryEnvelopeShape,
  recordType: z.literal('memory-use'),
  runId: id,
  stepId: id,
  sourceSnapshotId: id,
  memoryRevisionRefs: z.array(id).max(256),
  sources: z.array(sourceRefSchema).max(256),
  compilerVersion: id,
  renderedSha256: sha256,
  tokenCountQuality: z.enum(['estimated', 'local-tokenizer', 'provider-counted', 'unknown']),
  estimatedTokens: count.nullable(),
  reportedTokens: count.nullable(),
  omissions: z.array(z.strictObject({ ref: id, reason: memoryContractText(1000) })).max(256),
});
export type MemoryUseReceipt = z.infer<typeof memoryUseReceiptSchema>;

/**
 * Source authorization and deletion generations are separate from the harness
 * principal's identityGeneration. Workspace identity must be resolved by the
 * host using WorkspaceRef and the current account/person; it is not projectId.
 */
export interface MemoryHostContext {
  principal: HarnessPrincipal;
  label: HarnessLabel;
  workspace: WorkspaceRef;
  workspaceId: string;
  sourceSnapshotId: string;
  accessEpoch: number;
  deletionEpoch: number;
  sourceRestrictions: readonly HardRestrictions[];
}

export const memorySnapshotBindingSchema = z.strictObject({
  tenantId: id,
  workspaceId: id,
  sourceSnapshotId: id,
  accessEpoch: count,
  deletionEpoch: count,
});
export type MemorySnapshotBinding = z.infer<typeof memorySnapshotBindingSchema>;

export const issuedMemorySourcesSchema = z.strictObject({
  binding: memorySnapshotBindingSchema,
  sources: z.array(sourceRefSchema).max(256),
});
export type IssuedMemorySources = z.infer<typeof issuedMemorySourcesSchema>;

/**
 * A pure freshness comparison, not an access check. Both bindings must come
 * from the host; the dispatch owner still rechecks current Trust and funding.
 * Neither an old receipt nor an equal epoch grants permission.
 */
export function sameMemorySnapshot(saved: MemorySnapshotBinding, current: MemorySnapshotBinding): boolean {
  const a = memorySnapshotBindingSchema.parse(saved);
  const b = memorySnapshotBindingSchema.parse(current);
  return a.tenantId === b.tenantId && a.workspaceId === b.workspaceId &&
    a.sourceSnapshotId === b.sourceSnapshotId && a.accessEpoch === b.accessEpoch &&
    a.deletionEpoch === b.deletionEpoch;
}

/**
 * Resolve model locators only against exact spans already issued by the host.
 * This neither reads a source nor verifies its truth. A missing or ambiguous
 * match must be resolved by W02's source owner, never by fabricating provenance.
 * Return copies so later proposal/fixture changes cannot rewrite the snapshot.
 */
export function resolveMemoryProposalSources(
  value: unknown,
  issued: IssuedMemorySources,
  current: MemorySnapshotBinding,
): {
  proposal: MemoryProposal;
  sources: SourceRef[];
} {
  const proposal = memoryProposalSchema.parse(value);
  const snapshot = issuedMemorySourcesSchema.parse(issued);
  if (!sameMemorySnapshot(snapshot.binding, current)) throw new Error('stale_evidence');
  const sources = proposal.sourceLocators.map(({ sourceId, locator }) => {
    const matches = snapshot.sources.filter(source => source.sourceId === sourceId && source.locator === locator);
    if (matches.length !== 1) throw new Error('invalid_source_reference');
    return matches[0];
  });
  return { proposal, sources };
}
