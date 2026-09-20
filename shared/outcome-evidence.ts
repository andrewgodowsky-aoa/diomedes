import { z } from 'zod';

const id = z.string().trim().min(1).max(200);
const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true });
const source = z.object({
  id, revision: id, role: z.enum(['baseline', 'observation', 'realization', 'review']),
}).strict();
const common = {
  id, revision: id, projectId: id, prospectId: id, causalGroup: id,
  runId: id, artifactId: id,
  period: z.object({ start: instant, end: instant }).strict()
    .refine(p => Date.parse(p.end) > Date.parse(p.start), 'Measurement period must increase.'),
  calculationVersion: z.literal(1),
  evidenceClass: z.enum(['synthetic', 'owner-estimate', 'observed', 'reviewed-attributable']),
  realization: z.enum(['proposed', 'accepted', 'realized', 'cancelled', 'no-show', 'unknown']),
  sources: z.array(source).max(64),
  exclusions: z.array(z.string().trim().min(1).max(500)).max(32),
};
const money = {
  currency: z.string().regex(/^[A-Z]{3}$/), amountMinor: quantity,
};

/** Input evidence is data, not authority. The caller must resolve these references in Core. */
export const outcomeEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('human-time'),
    baselineMinutes: quantity.nullable(), executionMinutes: quantity.nullable(),
    reviewMinutes: quantity.nullable(), correctionMinutes: quantity.nullable(),
    supportMinutes: quantity.nullable(),
  }).strict(),
  z.object({ ...common, ...money, kind: z.literal('associated-revenue') }).strict(),
  z.object({ ...common, kind: z.literal('incremental-contribution'),
    currency: money.currency, revenueMinor: quantity, fulfillmentCostMinor: quantity.nullable(),
    attributionMethod: z.string().trim().min(1).max(1000).nullable(),
  }).strict(),
  z.object({ ...common, ...money, kind: z.literal('expense-reduction') }).strict(),
  z.object({ ...common, ...money, kind: z.literal('supplier-credit') }).strict(),
  z.object({ ...common, ...money, kind: z.literal('purchase-deferral') }).strict(),
  z.object({ ...common, ...money, kind: z.literal('operating-cost') }).strict(),
  z.object({ ...common, kind: z.literal('unknown'), reason: id }).strict(),
]);

export const outcomeProjectionInputSchema = z.object({
  projectId: id, prospectId: id, records: z.array(outcomeEvidenceSchema).max(256),
}).strict();

export type OutcomeEvidence = z.infer<typeof outcomeEvidenceSchema>;
export type OutcomeProjectionInput = z.infer<typeof outcomeProjectionInputSchema>;
export interface OutcomeProjectionRow {
  readonly evidence: OutcomeEvidence;
  readonly netHumanMinutes: number | null;
  readonly realizedFinancialMinor: number | null;
  readonly excludedReasons: readonly string[];
}
export interface OutcomeProjection {
  readonly projectId: string;
  readonly prospectId: string;
  readonly rows: readonly OutcomeProjectionRow[];
  readonly measuredNetHumanMinutes: number | null;
  readonly realizedFinancial: { readonly currency: string; readonly amountMinor: number } | null;
  readonly duplicateRecordsIgnored: number;
}
