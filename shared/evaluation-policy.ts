/** Staff-owned System One selection. No model, price or qualification is supplied by the desktop. */
import { z } from 'zod';
import { routingPriceSchema, type HardRestrictions } from './routing-policy.js';

const rate = z.number().int().min(0).max(1_000_000_000);
export const evaluationSelectionSchema = z.strictObject({
  provider: z.literal('openrouter'),
  protocol: z.literal('decisions'),
  model: z.string().trim().max(200).regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/),
  rate: z.strictObject({
    version: z.string().trim().min(1).max(128),
    inputMicroUsdPerMillion: rate,
    cacheReadMicroUsdPerMillion: rate,
    cacheWriteMicroUsdPerMillion: rate,
    outputMicroUsdPerMillion: rate,
  }),
  evidence: z.string().trim().min(1).max(1000),
  observedAt: z.iso.datetime(),
  validUntil: z.iso.datetime(),
  privacy: z.strictObject({
    noTraining: z.literal(true),
    zeroRetention: z.boolean(),
    ingressCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(250),
    processingCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(250),
    retentionPolicy: z.string().trim().min(1).max(128),
    transientCache: z.boolean(),
  }),
});
export type EvaluationSelection = z.infer<typeof evaluationSelectionSchema>;
export const evaluationRouteSchema = z.strictObject({
  model: evaluationSelectionSchema.shape.model,
  policyRevision: z.number().int().positive(),
  tableVersion: z.number().int().positive(),
  validUntil: z.iso.datetime(),
  price: routingPriceSchema,
});
export type EvaluationRoute = z.infer<typeof evaluationRouteSchema>;
export const publishEvaluationSelectionSchema = z.strictObject({
  selection: evaluationSelectionSchema.nullable(),
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  note: z.string().trim().min(1).max(1000),
});
export function currentEvaluationSelection(value: unknown, now: number): EvaluationSelection | null {
  const parsed = evaluationSelectionSchema.safeParse(value);
  return parsed.success && Date.parse(parsed.data.observedAt) <= now && Date.parse(parsed.data.validUntil) > now
    ? parsed.data : null;
}
export function evaluationAllows(selection: EvaluationSelection, restrictions: readonly HardRestrictions[]): boolean {
  const p = selection.privacy;
  const inside = (actual: string[], allowed: string[] | null) => allowed === null || actual.every(c => c !== 'ZZ' && allowed.includes(c));
  return restrictions.every(r => (!r.noTraining || p.noTraining) && (!r.zeroRetention || p.zeroRetention)
    && inside(p.ingressCountries, r.ingressCountries) && inside(p.processingCountries, r.processingCountries)
    && (r.allowedConnections === null || r.allowedConnections.includes('openrouter'))
    && (r.retentionPolicies === null || r.retentionPolicies.includes(p.retentionPolicy))
    && (r.transientCache !== 'forbid' || !p.transientCache));
}
