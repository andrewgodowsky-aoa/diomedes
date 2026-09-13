import { z } from 'zod';
import type { ProjectState } from '../shared/types.js';
import {
  commandIdSchema,
  digestSchema,
  payloadDigest,
  usesCommandProtocol,
} from './command-admission.js';
import { ApiError } from './paths.js';

const id = z.string().trim().min(1).max(100);
const requestSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: commandIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
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
  const { protocolVersion, commandId, name, description, owner } = parsed.data;
  return {
    input: { name, description, owner },
    admission: {
      commandId,
      payloadDigest: payloadDigest({
        type: 'task.create',
        protocolVersion,
        name,
        description,
        owner,
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
  actor: z.literal('local-client'),
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
    if (
      !receipt ||
      commands.has(receipt.commandId) ||
      receipt.projectId !== state.project.id ||
      receipt.taskId !== task.id ||
      event?.kind !== 'tasks-made' ||
      event.taskId !== task.id ||
      event.actor !== 'you' ||
      event.time !== receipt.admittedAt
    )
      throw new Error(
        'A saved task receipt is incompatible or inconsistent. Project state was not rewritten.',
      );
    commands.add(receipt.commandId);
  }
}
