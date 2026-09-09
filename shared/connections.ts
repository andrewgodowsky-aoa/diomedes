import { z } from 'zod';
import { ruleSchema, ruleEvidenceSchema, ruleProposalSchema } from './connection-rules.js';

export const connectionId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const timestamp = z.iso.datetime({ offset: true });
export const operationManifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  description: z.string().max(500),
  effect: z.enum(['pure', 'read', 'idempotent', 'non-idempotent']),
  permission: z.string(),
  vendorScopes: z.array(z.string()),
  source: z.strictObject({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    path: z.string().startsWith('/'),
  }),
  inputSchema: z.json(),
  resultSchema: z.json(),
});
export const connectorManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: connectionId,
  vendor: z.string().min(1),
  version: z.string().min(1),
  provenance: z.strictObject({
    source: z.url(),
    license: z.string(),
    review: z.enum(['candidate', 'host-reviewed']),
    integrity: z.string().nullable(),
  }),
  authentication: z.array(z.enum(['none', 'fixture', 'oauth-client-credentials', 'brokered'])),
  operations: z.array(operationManifestSchema).min(1).max(12),
  allowedOrigins: z.array(z.url()).max(8),
  pagination: z.string(),
  rateLimit: z.string(),
  retry: z.string(),
  idempotency: z.string(),
  reconciliation: z.string(),
  webhook: z.string(),
  freshness: z.string(),
  dataClassification: z.enum(['public', 'internal', 'restricted']),
  limitations: z.array(z.string()),
  approvals: z.array(z.string()),
  healthCheck: z.string(),
  fixtures: z.array(z.string()),
  rules: z.array(ruleSchema).max(30),
});
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
export const observationSchema = z.strictObject({
  resourceId: connectionId,
  key: connectionId,
  sourceAt: timestamp.nullable(),
  receivedAt: timestamp,
  facts: z.record(z.string(), z.json()),
  source: z.string().max(200),
});
export type ConnectionObservation = z.infer<typeof observationSchema>;
export const connectionSchema = z.strictObject({
  id: connectionId,
  connectorId: connectionId,
  version: z.string(),
  manifestDigest: z.string(),
  tenantId: connectionId,
  projectId: connectionId,
  name: z.string().max(200),
  resources: z
    .array(z.strictObject({ id: connectionId, name: z.string().max(100) }))
    .min(1)
    .max(32),
  vendorScopes: z.array(z.string()),
  operations: z.array(z.string()),
  mode: z.literal('fixture'),
  status: z.enum(['connected', 'paused', 'disconnected', 'authorization-required']),
  generation: z.number().int().positive(),
  staleAfterMs: z.number().int().min(1000).max(86400000),
  lastEventAt: timestamp.nullable(),
  lastReconciledAt: timestamp.nullable(),
  reconciledResources: z.record(z.string(), timestamp).default({}),
  problem: z.enum(['source-unavailable', 'reconciliation-required']).nullable(),
});
export type ConnectionInstance = z.infer<typeof connectionSchema>;
export const inboxEventSchema = z.strictObject({
  id: connectionId,
  connectionId,
  generation: z.number(),
  digest: z.string(),
  observation: observationSchema,
  state: z.enum(['pending', 'processed', 'ignored']),
  runId: z.string(),
  priorRunIds: z.array(z.string()).max(20).optional(),
  rules: z.array(ruleEvidenceSchema),
  issueId: z.string().nullable(),
});
export type InboxEvent = z.infer<typeof inboxEventSchema>;
export const bindingSchema = z.strictObject({
  connectionId,
  generation: z.number(),
  resources: z.array(connectionId),
  operations: z.array(z.string()),
  role: z.string(),
  principalId: z.string(),
  identityGeneration: z.number(),
});
export const connectionsDataSchema = z.strictObject({
  version: z.literal(1),
  instances: z.array(connectionSchema).max(32),
  inbox: z.array(inboxEventSchema).max(1000),
  observations: z.record(z.string(), observationSchema),
  issues: z.record(z.string(), z.string()),
  bindings: z.record(z.string(), bindingSchema),
  contextEvidence: z
    .array(
      z.strictObject({
        runId: z.string(),
        role: z.string(),
        resources: z.array(z.string()),
        tools: z.array(z.string()),
        rules: z.array(ruleEvidenceSchema),
      }),
    )
    .max(500),
});
export type ConnectionsData = z.infer<typeof connectionsDataSchema>;
export const rulesDataSchema = z.strictObject({
  version: z.literal(1),
  active: z.array(ruleSchema).max(100),
  proposals: z.array(ruleProposalSchema).max(100),
  revisions: z.array(ruleSchema).max(500),
});
// Additive state consumed by Store.persist; no second persistence or task authority.
declare module './types.js' {
  interface ProjectState {
    connections?: ConnectionsData;
    rules?: z.infer<typeof rulesDataSchema>;
  }
}
export const emptyConnections = (): ConnectionsData => ({
  version: 1,
  instances: [],
  inbox: [],
  observations: {},
  issues: {},
  bindings: {},
  contextEvidence: [],
});
