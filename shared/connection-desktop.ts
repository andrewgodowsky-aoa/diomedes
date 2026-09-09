import { z } from 'zod';
import { serviceWindowSchema } from './connection-rules.js';
import type { ConnectionInstance, ConnectionObservation, ConnectionsData } from './connections.js';
import type { Rule, RuleProposal } from './connection-rules.js';
import type { HarnessRun } from './harness.js';
import type { Task } from './types.js';

export const connectionIntentSchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  threshold: z.number().finite().min(0).max(100000).optional(),
  serviceWindow: serviceWindowSchema.optional(),
});
export const connectionPlanSchema = z.strictObject({
  id: z.string(), projectId: z.string(), connectionId: z.string(), tenantId: z.string(),
  request: connectionIntentSchema, questions: z.array(z.string()),
  resources: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  connectorDigest: z.string(), baseDigest: z.string(), expiresAt: z.string().datetime(),
  adopted: z.boolean(),
});
export type ConnectionPlan = z.infer<typeof connectionPlanSchema>;
export interface DesktopConnectionsView {
  mode: string; authorized: boolean;
  plans: { plan: ConnectionPlan; digest: string }[];
  connections: { connection: Pick<ConnectionInstance, 'id' | 'name'> & Partial<ConnectionInstance>; health: string }[];
  observations?: ConnectionObservation[];
  inbox?: ConnectionsData['inbox'];
  contextEvidence?: ConnectionsData['contextEvidence'];
  rules?: { active: Rule[]; proposals: RuleProposal[]; revisions: Rule[] };
  tasks?: Task[]; runs?: HarnessRun[]; error?: string | null;
}
export const desktopConnectionsSchema = z.strictObject({
  version: z.literal(1), plans: z.array(connectionPlanSchema).max(100),
  admissions: z.array(z.strictObject({ planId: z.string(), digest: z.string(),
    state: z.enum(['pending', 'complete']) })).max(100).default([]),
});
declare module './types.js' {
  interface ProjectState { desktopConnections?: z.infer<typeof desktopConnectionsSchema>; }
}
