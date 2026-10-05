/** One explicitly selected review. This contract carries evidence, never authority by itself. */
import { z } from 'zod';
import type { EvaluationProfile } from './evaluation.js';

export const INVENTORY_REVIEW_MAX_INPUT_TOKENS = 5_000 as const;
const profileId = z.literal('agent.inventory-reconciliation');
const id = z.string().min(1).max(128).refine(value => value.trim().length > 0, 'An identity is required.');
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Renderer input selects the saved connection; the host resolves its account and policy. */
export const agentReviewSelectionSchema = z.strictObject({ profileId, connectionId: id });
export type AgentReviewSelection = z.infer<typeof agentReviewSelectionSchema>;

export const agentReviewGrantSchema = z.strictObject({
  version: z.literal(1),
  grantId: id,
  revocationId: id,
  revocationRevision: revision,
  rootRunId: runId,
  rootJobId: z.string().regex(/^job-[a-f0-9]{40}$/),
  tenantId: id,
  projectId: id,
  taskId: id,
  principalId: id,
  identityGeneration: revision,
  profileId,
  profileRevision: z.literal(1),
  profileDigest: sha256,
  route: z.strictObject({
    provider: z.literal('openrouter'),
    connectionId: id,
    modelId: z.literal('typesafe/jev-1.13'),
  }),
  account: z.strictObject({ id, revision, digest: sha256 }),
  dataPolicyDigest: sha256,
  sources: z.array(z.strictObject({ sourceId: z.string().min(1).max(2_048), digest: sha256 })).min(1).max(8),
  reportDigest: sha256,
  maxCalls: z.literal(1),
}).refine(value => new Set(value.sources.map(source => source.sourceId)).size === value.sources.length,
  'Review source identities must be unique.');
export type AgentReviewGrant = z.infer<typeof agentReviewGrantSchema>;

/**
 * A browser-safe, immutable profile. Importing a selection must not pull the
 * server's hashing implementation into the renderer. Both boolean descriptions
 * are absent, which is a shape the direct Decisions API supports.
 */
export const INVENTORY_REVIEW_PROFILE: EvaluationProfile = Object.freeze({
  contractVersion: 1,
  profileId: 'agent.inventory-reconciliation',
  revision: 1,
  purpose: 'source-support',
  questions: Object.freeze([
    Object.freeze({
      id: 'sole-discrepancy', type: 'boolean' as const,
      instructions: 'Check only the selected synthetic rows and report. A has 10 expected and 10 counted, B has 8 expected and 6 counted, and C has 5 expected and 5 counted. Is the report supported in identifying B as the sole discrepancy, without inventing another discrepancy?',
      whenTrue: null, whenFalse: null,
    }),
    Object.freeze({
      id: 'totals', type: 'boolean' as const,
      instructions: 'Check only the selected synthetic rows and report. Expected quantities are A 10, B 8, C 5; counted quantities are A 10, B 6, C 5. Does the report correctly state 23 expected and 21 counted in total?',
      whenTrue: null, whenFalse: null,
    }),
    Object.freeze({
      id: 'shortage', type: 'boolean' as const,
      instructions: 'Check only the selected synthetic rows and report. B has 8 expected and 6 counted at a unit cost of $3.75. Does the report correctly state a shortage of 2 units worth $7.50, without implying an inventory adjustment was applied?',
      whenTrue: null, whenFalse: null,
    }),
    Object.freeze({
      id: 'no-inventory-update', type: 'boolean' as const,
      instructions: 'Check only the selected synthetic rows and report. This task reconciles synthetic data and writes a report; it performs no inventory action. Does the report explicitly state that no inventory system was updated, without claiming that stock or any inventory system changed?',
      whenTrue: null, whenFalse: null,
    }),
  ]),
});
