import { z } from 'zod';
import { createHash } from 'node:crypto';
import { projectedTurnIds, turnIdentityText } from '../shared/conversation-turn-id.js';
import type { ProjectState } from '../shared/types.js';
import {
  commandIdSchema,
  digestSchema,
  payloadDigest,
  usesCommandProtocol,
} from './command-admission.js';
import { ApiError } from './paths.js';
import { automaticWorkRequestSchema } from '../shared/automatic-work.js';
import { automaticRequestDigest, isExplicitWorkRequest } from './automatic-work-admission.js';
import { conversationCommandIds } from './interaction-admission.js';
import { sourceMessageIdFor } from './interaction-turn.js';

const id = z.string().trim().min(1).max(100);
const requestSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: commandIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
  /** A reference into the project's Files listing; the route re-checks it against a fresh walk. */
  sourceDocument: z.string().trim().min(1).max(1000).optional(),
  owner: z.enum(['you', 'diomedes', 'diomedes-with-ok']).default('you'),
});

/** Existing unversioned callers retain their contract. Console opts into v1. */
export function parseTaskCommand(body: Record<string, unknown>) {
  if (!usesCommandProtocol(body, 'task')) return undefined;
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(400, 'Provide a valid version 1 task command.', {
      code: 'invalid_task_command',
    });
  const { protocolVersion, commandId, name, description, sourceDocument, owner } = parsed.data;
  return {
    input: { name, description, owner, ...(sourceDocument === undefined ? {} : { sourceDocument }) },
    admission: {
      commandId,
      payloadDigest: payloadDigest({
        type: 'task.create',
        protocolVersion,
        name,
        description,
        owner,
        // Two commands that differ only by document must never digest alike. An absent
        // document is dropped by JSON.stringify, so commands without one keep their digest.
        sourceDocument,
      }),
    },
  };
}

const receiptSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: commandIdSchema,
  payloadDigest: digestSchema,
  projectId: id,
  taskId: id,
  eventId: id,
  admittedAt: z
    .string()
    .max(40)
    .refine((value) => Number.isFinite(Date.parse(value))),
  actor: z.enum(['local-client', 'harness']),
  scope: z.literal('local-prototype'),
});

/** Validate on every Store load/recovery, including prepared document journals. */
export function validateTaskReceipts(state: ProjectState) {
  const commands = new Set([
    ...state.sessions.flatMap((session) => (session.receipt ? [session.receipt.commandId] : [])),
    ...state.needs.flatMap((need) =>
      need.approvalReceipt ? [need.approvalReceipt.commandId] : [],
    ),
    ...(state.scopeGrants ?? []).map((record) => record.grant.commandId),
  ]);
  const events = new Map(state.history.map((entry) => [entry.id, entry]));
  for (const task of state.tasks) {
    if (task.creationReceipt === undefined) continue;
    const parsed = receiptSchema.safeParse(task.creationReceipt);
    const receipt = parsed.success ? parsed.data : undefined;
    const event = receipt ? events.get(receipt.eventId) : undefined;
    const harnessProposal = receipt?.actor === 'harness';
    const requested = automaticWorkRequestSchema.safeParse(task.automaticWork?.request);
    const originalCommand = receipt && requested.success ? parseTaskCommand({
      protocolVersion: 1, commandId: receipt.commandId, owner: 'diomedes-with-ok',
      name: requested.data.goal.trim().split('\n')[0]!.slice(0, 200), description: requested.data.goal,
    }) : undefined;
    const automaticCreation = receipt?.actor === 'local-client' && requested.success
      && requested.data.sourceProjectId === state.project.id && requested.data.targetProjectId === state.project.id
      && requested.data.sourceMessageId === sourceMessageIdFor(state.project.id, requested.data.threadId, requested.data.commandId)
      && automaticRequestDigest(requested.data) === requested.data.requestDigest && isExplicitWorkRequest(requested.data.goal)
      && receipt.commandId === conversationCommandIds(requested.data.sourceMessageId).taskCommandId
      && task.origin?.projectId === state.project.id && task.origin.threadId === requested.data.threadId
      && receipt.payloadDigest === originalCommand?.admission.payloadDigest
      && typeof task.origin.runId === 'string' && task.origin.runId.length > 0
      && task.origin.turnId === projectedTurnIds(createHash('sha256')
        .update(turnIdentityText(task.origin.runId, requested.data.commandId)).digest('hex')).user;
    const parent = task.workflow?.parentTaskId;
    const proposalSession = event?.sessionId && state.sessions.find((session) => session.id === event.sessionId);
    if (
      !receipt ||
      commands.has(receipt.commandId) ||
      receipt.projectId !== state.project.id ||
      receipt.taskId !== task.id ||
      event?.kind !== 'tasks-made' ||
      event.taskId !== task.id ||
      (task.automaticWork !== undefined && !automaticCreation) ||
      event.actor !== (harnessProposal || automaticCreation ? 'diomedes' : 'you') ||
      (harnessProposal && (!receipt.commandId.startsWith('proposal.') || task.createdBy !== 'diomedes' ||
        !parent || !proposalSession || proposalSession.taskId !== parent)) ||
      event.time !== receipt.admittedAt
    )
      throw new Error(
        'A saved task receipt is incompatible or inconsistent. Project state was not rewritten.',
      );
    commands.add(receipt.commandId);
  }
}
