/** Admission evidence for one native Agent's persistent Team exchange. No grant here authorizes itself. */
import { z } from 'zod';
import { TEAM_MODEL_ROUTES } from './model-api.js';
import type { TeamRun } from './types.js';

export const AGENT_TEAM_MODEL_CALLS = 6;
export const AGENT_TEAM_RESPONSE_UNITS = 2 * AGENT_TEAM_MODEL_CALLS;
export const AGENT_TEAM_TOOLS = [
  'team_members', 'team_task_create', 'team_task_update', 'team_task_list', 'team_send_message', 'team_read_messages',
] as const;
/** The host delivers the final answer; the responder cannot create tasks or send additional requests. */
export const AGENT_TEAM_MEMBER_TOOLS = ['team_members', 'team_task_update', 'team_task_list', 'team_read_messages'] as const;

const id = z.string().min(1).max(128);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const slot = id.refine((value) => value !== 'owner', 'Select a real Team member.');
export const agentTeamSelectionSchema = z.strictObject({ leadSlotId: slot, memberSlotId: slot })
  .refine((value) => value.leadSlotId !== value.memberSlotId, 'Select distinct lead and member slots.');
export type AgentTeamSelection = z.infer<typeof agentTeamSelectionSchema>;

const bindingSchema = z.strictObject({
  slotId: slot,
  role: z.enum(['lead', 'member']),
  agentId: id.nullable(),
  createdAt: z.string().min(1).max(80),
  threadId: id,
  route: z.enum(TEAM_MODEL_ROUTES),
  model: z.string().min(1).max(120),
  accountRoute: z.string().min(1).max(256),
  effort: z.string().min(1).max(40).nullable(),
  profile: z.strictObject({ id, revision: z.number().int().positive(), digest: sha256 }).nullable(),
});
export type AgentTeamBinding = z.infer<typeof bindingSchema>;
export const agentTeamGrantSchema = z.strictObject({
  v: z.literal(1),
  id,
  commandId: id,
  projectId: id,
  taskId: id,
  rootRunId: runId,
  lead: bindingSchema.extend({ role: z.literal('lead') }),
  member: bindingSchema.extend({ role: z.literal('member'), effort: z.literal('medium') }),
  sources: z.array(z.strictObject({ path: z.string().min(1).max(2048), sha256 })).min(1).max(16),
  maxModelCalls: z.literal(6),
  maxResponses: z.literal(1),
}).refine((value) => value.lead.slotId !== value.member.slotId, 'Select distinct lead and member slots.')
  .refine((value) => new Set(value.sources.map((source) => source.path)).size === value.sources.length, 'Source paths must be unique.');
export type AgentTeamGrant = z.infer<typeof agentTeamGrantSchema>;

export const ownedTeamResponseMetadataSchema = z.strictObject({
  v: z.literal(1),
  grantId: id,
  rootRunId: runId,
  taskId: id,
  teamRunId: id,
  assignmentTaskId: id,
  parent: z.strictObject({ runId, stepId: z.string().min(1).max(200) }),
});
export type OwnedTeamResponseMetadata = z.infer<typeof ownedTeamResponseMetadataSchema>;
export const ownedTeamResponseResultSchema = z.strictObject({
  runId,
  text: z.string().max(16000),
  model: z.string().max(256),
  version: z.string().min(1).max(256),
});
export type OwnedTeamResponseResult = z.infer<typeof ownedTeamResponseResultSchema>;

/** Additive TeamRun fields; legacy runs keep their existing shape and are never treated as owned. */
export interface OwnedTeamRun extends TeamRun {
  ownership: 'agent-team-response';
  sessionId: null;
  grant: AgentTeamGrant;
  rootRunId: string;
  rootTaskId: string;
  harnessRunId: string;
  commandId: string;
  assignmentTaskId: string;
  assignmentDigest: string;
  requestMessageId: string | null;
  requestDigest: string | null;
  replyMessageId: string | null;
  result: OwnedTeamResponseResult | null;
  parent: OwnedTeamResponseMetadata['parent'] | null;
  rootClosed: boolean;
  /** A failed/cancelled provider effect remains unknown until existing RunService reconciliation resolves it. */
  unknownOutcome: boolean;
}
const ownedTeamRunSchema = z.object({
  id, slotId: slot, sessionId: z.null(),
  status: z.enum(['accepted', 'running', 'cancelling', 'completed', 'cancelled', 'failed']),
  startedAt: z.string(), endedAt: z.string().nullable(), summary: z.string().nullable(),
  ownership: z.literal('agent-team-response'), grant: agentTeamGrantSchema,
  rootRunId: runId, rootTaskId: id, harnessRunId: runId, commandId: id,
  assignmentTaskId: id, assignmentDigest: sha256,
  requestMessageId: id.nullable(), requestDigest: sha256.nullable(), replyMessageId: id.nullable(),
  result: ownedTeamResponseResultSchema.nullable(), parent: ownedTeamResponseMetadataSchema.shape.parent.nullable(),
  rootClosed: z.boolean(), unknownOutcome: z.boolean(),
}).passthrough().refine((value) =>
  value.rootRunId === value.grant.rootRunId && value.rootTaskId === value.grant.taskId &&
  value.slotId === value.grant.member.slotId && (value.parent === null || value.parent.runId === value.rootRunId) &&
  (value.result === null || value.result.runId === value.harnessRunId),
  'Owned Team identities do not agree.',
);
export function isOwnedTeamRun(value: unknown): value is OwnedTeamRun {
  return ownedTeamRunSchema.safeParse(value).success;
}
