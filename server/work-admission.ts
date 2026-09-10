import { z } from 'zod';
import { ApiError, relativeName } from './paths.js';
import type { ProjectState } from '../shared/types.js';
import { ROUTES } from '../shared/engines.js';

import {
  commandIdSchema as commandId,
  digestSchema,
  payloadDigest,
  usesCommandProtocol,
} from './command-admission.js';
const id = z.string().trim().min(1).max(100);
const requestSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId,
  taskId: id,
  route: z.enum(ROUTES).default('sample'),
  capabilityId: z.literal('codex-report').optional(),
  model: z.string().trim().min(1).max(120).optional(),
  effort: z.string().trim().min(1).max(40).optional(),
  instruction: z.string().trim().min(1).max(16_000).optional(),
  // Which Agent was asked for, or `auto`. Part of the command identity: a
  // retry that changes the worker is a different request, not the same one.
  agentId: z.string().trim().min(1).max(80).optional(),
  sources: z.array(z.string().min(1).max(1000)).max(8).optional(),
  consent: z.boolean().default(false),
  threadId: id.nullable().optional(),
  demo: z.literal('fault').optional(),
});

export interface WorkAdmission {
  commandId: string;
  payloadDigest: string;
}

/** Legacy clients remain compatible; supplying either version field opts into strict v1. */
export function parseWorkCommand(body: Record<string, unknown>) {
  if (!usesCommandProtocol(body, 'work')) return undefined;
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(400, 'Provide a valid version 1 Work command.', {
      code: 'invalid_work_command',
    });
  const request = parsed.data;
  if (request.capabilityId && request.route !== 'codex')
    throw new ApiError(400, 'This capability requires the Codex route.', {
      code: 'invalid_work_command',
    });
  if ((request.model || request.effort) && !request.capabilityId)
    throw new ApiError(400, 'Explicit capability selections require a capability command.', {
      code: 'invalid_work_command',
    });
  if (request.route !== 'sample' && request.sources === undefined)
    throw new ApiError(400, 'Provide the explicitly selected source documents, or an empty list.', {
      code: 'invalid_work_command',
    });
  const sources = (request.sources ?? []).map(relativeName);
  if (new Set(sources.map((name) => name.toLowerCase())).size !== sources.length)
    throw new ApiError(400, 'Select each source document only once.', {
      code: 'invalid_work_command',
    });
  // Construct the canonical payload explicitly: input key order and omitted defaults
  // cannot change the digest. It contains the requested action, never file contents.
  const payload = {
    type: 'work.start',
    protocolVersion: 1,
    taskId: request.taskId,
    route: request.route,
    ...(request.capabilityId
      ? {
          capabilityId: request.capabilityId,
          model: request.model ?? null,
          effort: request.effort ?? null,
        }
      : {}),
    instruction: request.instruction ?? null,
    // Present only when a worker was actually named, so a receipt saved before
    // Agents existed keeps its exact digest and still replays. Naming one is a
    // different request, and swapping it conflicts.
    ...(request.agentId ? { agentId: request.agentId } : {}),
    sources,
    consent: request.consent,
    threadId: request.threadId ?? null,
    demo: request.demo ?? null,
  };
  const admission: WorkAdmission = {
    commandId: request.commandId,
    payloadDigest: payloadDigest(payload),
  };
  return { request: { ...request, sources }, admission };
}

export function validateWorkCommandId(value: string) {
  if (!commandId.safeParse(value).success)
    throw new ApiError(400, 'Provide a valid Work command identifier.', {
      code: 'invalid_work_command',
    });
  return value;
}

// Never evict a receipt and silently make an old command executable again. A future
// retention migration must define an explicit expired-command response first.
export const MAX_WORK_RECEIPTS = 1024;

const receiptSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId,
  payloadDigest: digestSchema,
  projectId: id,
  taskId: id,
  sessionId: id,
  eventId: id,
  admittedAt: z
    .string()
    .max(40)
    .refine((value) => Number.isFinite(Date.parse(value))),
  route: z.enum(ROUTES),
  scope: z.literal('local-prototype'),
});

/** Additive format: old sessions need no migration; incompatible receipts fail closed. */
export function validateWorkReceipts(state: ProjectState) {
  // One project-scoped command namespace: a Work receipt cannot reuse a scope
  // grant or exact-approval command, and Work receipts cannot repeat each other.
  const commands = new Set<string>([
    ...(state.scopeGrants ?? []).map((record) => record.grant.commandId),
    ...state.needs.flatMap((need) =>
      need.approvalReceipt ? [need.approvalReceipt.commandId] : [],
    ),
  ]);
  const events = new Map(state.history.map((event) => [event.id, event]));
  for (const session of state.sessions) {
    if (session.receipt === undefined) continue;
    const parsed = receiptSchema.safeParse(session.receipt);
    const receipt = parsed.success ? parsed.data : undefined;
    const event = receipt ? events.get(receipt.eventId) : undefined;
    if (
      !receipt ||
      commands.has(receipt.commandId) ||
      receipt.projectId !== state.project.id ||
      receipt.sessionId !== session.id ||
      receipt.taskId !== session.taskId ||
      receipt.route !== (session.route ?? (session.sample ? 'sample' : 'codex')) ||
      event?.kind !== 'work-admitted' ||
      event.sessionId !== session.id ||
      event.taskId !== session.taskId ||
      event.time !== receipt.admittedAt
    )
      throw new Error(
        'A saved Work receipt is incompatible or inconsistent. Project state was not rewritten.',
      );
    commands.add(receipt.commandId);
  }
}
