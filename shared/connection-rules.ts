import { z } from 'zod';

export const ruleScopeSchema = z.strictObject({
  tenantId: z.string().optional(),
  projectId: z.string().optional(),
  userId: z.string().optional(),
  connectorId: z.string().optional(),
  connectionId: z.string().optional(),
  resourceId: z.string().optional(),
  capabilityId: z.string().optional(),
  workflowId: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  role: z.string().optional(),
});
export type RuleScope = z.infer<typeof ruleScopeSchema>;
export const serviceWindowSchema = z.strictObject({
  timeZone: z.string().max(80).refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    catch { return false; }
  }, 'Choose an IANA time zone.'),
  start: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
  end: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
}).refine((value) => value.start !== value.end, 'Service start and end must differ.');
export const ruleSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    version: z.number().int().positive(),
    enabled: z.boolean(),
    scope: ruleScopeSchema,
    provenance: z.strictObject({
      source: z.string().max(500),
      connectorVersion: z.string().nullable(),
      trust: z.enum(['host-reviewed', 'candidate']),
    }),
    type: z.enum(['standing', 'correction', 'workflow', 'policy']),
    text: z.string().min(1).max(2000),
    predicate: z
      .strictObject({
        field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
        operator: z.enum(['eq', 'lte', 'contains']),
        value: z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
      })
      .nullable(),
    action: z.enum(['context', 'correct', 'create-issue', 'deny']),
    serviceWindow: serviceWindowSchema.optional(),
  })
  .superRefine((rule, ctx) => {
    const actions = {
      standing: 'context',
      correction: 'correct',
      workflow: 'create-issue',
      policy: 'deny',
    };
    if (rule.action !== actions[rule.type] || (rule.type !== 'standing' && !rule.predicate))
      ctx.addIssue({ code: 'custom', message: 'Rule type, action and predicate must agree.' });
  });
export type Rule = z.infer<typeof ruleSchema>;
export const ruleEvidenceSchema = z.strictObject({
  id: z.string(),
  version: z.number(),
  provenance: ruleSchema.shape.provenance,
  scope: ruleScopeSchema,
  predicate: ruleSchema.shape.predicate,
  action: ruleSchema.shape.action,
  text: z.string(),
  input: z.record(z.string(), z.json()),
  serviceWindow: serviceWindowSchema.optional(),
});
export type RuleEvidence = z.infer<typeof ruleEvidenceSchema>;
export const ruleProposalSchema = z.strictObject({
  id: z.string(),
  state: z.literal('proposed'),
  sourceText: z.string(),
  rule: ruleSchema.nullable(),
  questions: z.array(z.string()),
  preview: z.strictObject({
    when: z.string(),
    do: z.string(),
    appliesTo: z.string(),
    authority: z.string(),
    enforcement: z.string(),
  }),
  review: z.strictObject({
    baseDigest: z.string(),
    sourceSteps: z.array(z.string()).max(50),
    replay: z.array(z.strictObject({ case: z.string(), before: z.string(), after: z.string() })).max(50),
    expiresAt: z.string().datetime(),
    kind: z.enum(['improvement', 'rollback']),
  }).optional(),
});
export type RuleProposal = z.infer<typeof ruleProposalSchema>;
