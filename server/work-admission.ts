import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError, relativeName } from './paths.js';
import type { ProjectState } from '../shared/types.js';

const commandId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const id = z.string().trim().min(1).max(100);
const requestSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId,
  taskId: id,
  route: z.enum(['sample', 'codex']).default('sample'),
  instruction: z.string().trim().min(1).max(16_000).optional(),
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
  if (!Object.hasOwn(body, 'protocolVersion') && !Object.hasOwn(body, 'commandId'))
    return undefined;
  if (body.protocolVersion !== 1)
    throw new ApiError(409, 'This Work command version is unsupported.', {
      code: 'unsupported_work_protocol',
      supportedVersions: [1],
    });
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(400, 'Provide a valid version 1 Work command.', {
      code: 'invalid_work_command',
    });
  const request = parsed.data;
  if (request.route === 'codex' && request.sources === undefined)
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
    instruction: request.instruction ?? null,
    sources,
    consent: request.consent,
    threadId: request.threadId ?? null,
    demo: request.demo ?? null,
  };
  const admission: WorkAdmission = {
    commandId: request.commandId,
    payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
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
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  projectId: id,
  taskId: id,
  sessionId: id,
  eventId: id,
  admittedAt: z
    .string()
    .max(40)
    .refine((value) => Number.isFinite(Date.parse(value))),
  route: z.enum(['sample', 'codex']),
  scope: z.literal('local-prototype'),
});

/** Additive format: old sessions need no migration; incompatible receipts fail closed. */
export function validateWorkReceipts(state: ProjectState) {
  const commands = new Set<string>();
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
      receipt.route !== (session.sample ? 'sample' : 'codex') ||
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
