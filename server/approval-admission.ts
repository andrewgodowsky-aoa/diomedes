import { createHash } from 'node:crypto';
import { validateScopedAuthorization } from './trust/scope-grants.js';
import { validateReviewerDecisions } from './trust/reviewer.js';
import { z } from 'zod';
import type { ApprovalCommand, ApprovalIdentity, Need, ProjectState } from '../shared/types.js';
import { ApiError, relativeName } from './paths.js';
import type { WriteInput } from './store.js';
import {
  CODEX_ENGINE,
  FIXTURE_ENGINE,
  harnessWrites,
  identifyHarnessApproval,
} from './harness/approval.js';

import {
  commandIdSchema as commandId,
  digestSchema as digest,
  payloadDigest as canonicalDigest,
  usesCommandProtocol,
} from './command-admission.js';
const id = z.string().min(1).max(100);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
// Harness v1 intent hashes are bare SHA-256; text actions keep their prefixed digest.
const actionHash = z.union([digest, sha]);
const time = z
  .string()
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)));
export const contentHash = (text: string | null) =>
  text === null ? null : createHash('sha256').update(text).digest('hex');
export const APPROVAL_TTL_MS = 60 * 60 * 1000;
// Retention never makes a previously used command executable again.
export const MAX_APPROVAL_RECEIPTS = 1024;

const requestSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId,
  resolution: z.enum(['go-ahead', 'declined']),
  proposalDigest: digest,
  actionDigest: actionHash,
  baseDigest: digest,
  allowForTask: z.literal(false).optional(),
});
export interface ApprovalAdmission {
  command: ApprovalCommand;
  payloadDigest: string;
}
export function parseApprovalCommand(
  projectId: string,
  approvalId: string,
  body: Record<string, unknown>,
): ApprovalAdmission | undefined {
  if (!usesCommandProtocol(body, 'approval')) return;
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(400, 'Provide a valid version 1 exact approval decision.', {
      code: 'invalid_approval_command',
    });
  const { allowForTask: _allow, ...command } = parsed.data;
  return {
    command,
    payloadDigest: canonicalDigest({
      type: 'approval.decide',
      protocolVersion: 1,
      projectId,
      approvalId,
      actor: 'local-client',
      scope: 'local-prototype',
      resolution: command.resolution,
      proposalDigest: command.proposalDigest,
      actionDigest: command.actionDigest,
      baseDigest: command.baseDigest,
    }),
  };
}

export function actionDigest(writes: readonly WriteInput[]) {
  return canonicalDigest({
    type: 'text.apply',
    writes: writes.map((write) => ({
      path: write.path,
      before: write.expected,
      after: contentHash(write.text),
    })),
  });
}
export function baseDigest(sources: ApprovalIdentity['sources']) {
  return canonicalDigest({
    type: 'selected-text-base',
    sources: sources.map(({ path, sha }) => ({ path, sha })),
  });
}
export function identifyApproval(
  projectId: string,
  need: Need,
  sources: ApprovalIdentity['sources'],
): ApprovalIdentity {
  if (need.harness) return identifyHarnessApproval(projectId, need);
  const preview = need.preview;
  if (!preview?.length || preview.length > 8)
    throw new Error('An exact approval needs a bounded text preview.');
  const expiresAt = new Date(Date.parse(need.createdAt) + APPROVAL_TTL_MS).toISOString();
  const action = actionDigest(
    preview.map((change) => ({
      path: change.path,
      expected: contentHash(change.before),
      text: change.after,
    })),
  );
  const base = baseDigest(sources);
  return {
    protocolVersion: 1,
    actionDigest: action,
    baseDigest: base,
    expiresAt,
    sources: sources.map(({ path, sha }) => ({ path, sha })),
    proposalDigest: canonicalDigest({
      type: 'native-text-proposal',
      protocolVersion: 1,
      projectId,
      approvalId: need.id,
      taskId: need.taskId,
      sessionId: need.sessionId,
      createdAt: need.createdAt,
      expiresAt,
      actionDigest: action,
      baseDigest: base,
      what: need.what,
      why: need.why,
      consequence: need.consequence,
      files: need.files,
      preview: preview.map((change) => ({
        path: change.path,
        op: change.op,
        summary: change.summary,
        before: contentHash(change.before),
        after: contentHash(change.after),
        current: contentHash(change.current),
        changedSince: change.changedSince,
        hunks: change.hunks.map((hunk) => ({
          value: hunk.value,
          added: hunk.added ?? false,
          removed: hunk.removed ?? false,
          count: hunk.count ?? null,
        })),
      })),
    }),
  };
}
export function assertApprovalMatches(projectId: string, need: Need, admission: ApprovalAdmission) {
  if (!need.approval)
    throw new ApiError(409, 'This legacy request has no exact approval identity.', {
      code: 'legacy_approval',
    });
  const identity = identifyApproval(projectId, need, need.approval.sources);
  if (
    identity.expiresAt !== need.approval.expiresAt ||
    (['proposalDigest', 'actionDigest', 'baseDigest'] as const).some(
      (key) => identity[key] !== need.approval![key] || identity[key] !== admission.command[key],
    )
  )
    throw new ApiError(
      409,
      'This proposal or action changed. Reload and review its exact contents before deciding.',
      { code: 'approval_identity_changed' },
    );
}

const identitySchema = z.strictObject({
  protocolVersion: z.literal(1),
  proposalDigest: digest,
  actionDigest: actionHash,
  baseDigest: digest,
  expiresAt: time,
  sources: z.array(z.strictObject({ path: z.string().min(1).max(1000), sha })).max(8),
});
const receiptSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId,
  payloadDigest: digest,
  projectId: id,
  approvalId: id,
  taskId: id,
  sessionId: id,
  actor: z.literal('local-client'),
  scope: z.literal('local-prototype'),
  proposalDigest: digest,
  actionDigest: actionHash,
  baseDigest: digest,
  createdAt: time,
  expiresAt: time,
  decision: z.enum(['go-ahead', 'declined']),
  decidedAt: time,
  eventId: id,
});
const executionSchema = z.strictObject({
  state: z.enum(['pending', 'applied', 'conflicted', 'not-applied', 'declined']),
  eventId: id.nullable(),
  completedAt: time.nullable(),
  reason: z.string().nullable(),
  conflicts: z.array(z.string().min(1).max(1000)).max(8),
});
const incompatible = () =>
  new Error(
    'A saved approval receipt or proposal is incompatible or inconsistent. Project state was not rewritten.',
  );

/** Validate at load/recovery, not on every state read or duplicate command. */
export function validateApprovalReceipts(state: ProjectState) {
  // One project-scoped command namespace: an exact receipt cannot reuse a Work
  // or scope-grant command, and exact receipts cannot repeat each other.
  const commands = new Set([
    ...state.sessions.flatMap((session) => (session.receipt ? [session.receipt.commandId] : [])),
    ...(state.scopeGrants ?? []).map((record) => record.grant.commandId),
  ]);
  const events = new Map(state.history.map((entry) => [entry.id, entry]));
  const sessions = new Map(state.sessions.map((session) => [session.id, session]));
  for (const need of state.needs) {
    if (!need.approval) {
      if (need.approvalReceipt || need.execution || need.authorization || need.reviews)
        throw incompatible();
      continue;
    }
    if (
      !identitySchema.safeParse(need.approval).success ||
      need.allowForTask ||
      sessions.get(need.sessionId)?.sample !== false
    )
      throw incompatible();
    try {
      if (need.harness) {
        const engine = sessions.get(need.sessionId)?.engine.name;
        if (
          ![FIXTURE_ENGINE, CODEX_ENGINE].includes(engine ?? '') ||
          (engine === FIXTURE_ENGINE && need.approval.sources.length)
        )
          throw incompatible();
        harnessWrites(state.project.id, need);
      }
      const identity = identifyApproval(state.project.id, need, need.approval.sources);
      if (
        identity.expiresAt !== need.approval.expiresAt ||
        (['proposalDigest', 'actionDigest', 'baseDigest'] as const).some(
          (key) => identity[key] !== need.approval![key],
        )
      )
        throw incompatible();
      const paths = need.approval.sources.map((source) => relativeName(source.path).toLowerCase());
      if (new Set(paths).size !== paths.length) throw incompatible();
    } catch {
      throw incompatible();
    }
    // Reviewer records are validated whatever the outcome: a refusal or a
    // failure leaves evidence on a Need that still has no decision.
    try {
      validateReviewerDecisions(state, need);
    } catch {
      throw incompatible();
    }
    const receipt = need.approvalReceipt;
    if (need.authorization) {
      validateScopedAuthorization(state, need);
      continue;
    }
    if (!receipt) {
      if (need.execution || need.state === 'go-ahead' || need.state === 'declined')
        throw incompatible();
      continue;
    }
    const execution = need.execution;
    const event = events.get(receipt.eventId);
    const session = sessions.get(need.sessionId);
    if (
      !receiptSchema.safeParse(receipt).success ||
      !executionSchema.safeParse(execution).success ||
      !execution ||
      commands.has(receipt.commandId) ||
      receipt.projectId !== state.project.id ||
      receipt.approvalId !== need.id ||
      receipt.taskId !== need.taskId ||
      session?.taskId !== need.taskId ||
      receipt.sessionId !== need.sessionId ||
      receipt.createdAt !== need.createdAt ||
      receipt.expiresAt !== need.approval.expiresAt ||
      receipt.decision !== need.state ||
      receipt.decidedAt !== need.decidedAt ||
      Date.parse(receipt.decidedAt) < Date.parse(receipt.createdAt) ||
      Date.parse(receipt.decidedAt) >= Date.parse(receipt.expiresAt) ||
      event?.kind !== 'decision' ||
      event.approvalId !== need.id ||
      event.sessionId !== need.sessionId ||
      event.taskId !== need.taskId ||
      event.time !== receipt.decidedAt ||
      (['proposalDigest', 'actionDigest', 'baseDigest'] as const).some(
        (key) => receipt[key] !== need.approval![key],
      )
    )
      throw incompatible();
    const admission = parseApprovalCommand(state.project.id, need.id, {
      protocolVersion: 1,
      commandId: receipt.commandId,
      resolution: receipt.decision,
      proposalDigest: receipt.proposalDigest,
      actionDigest: receipt.actionDigest,
      baseDigest: receipt.baseDigest,
    });
    if (admission?.payloadDigest !== receipt.payloadDigest) throw incompatible();
    const applied = execution.state === 'applied' || execution.state === 'conflicted';
    if (
      (receipt.decision === 'declined') !== (execution.state === 'declined') ||
      (execution.state === 'pending') !== (execution.completedAt === null) ||
      applied !== (execution.eventId !== null) ||
      (execution.state === 'conflicted') !== execution.conflicts.length > 0
    )
      throw incompatible();
    if (applied) {
      const write = execution.eventId ? events.get(execution.eventId) : undefined;
      if (
        write?.kind !== 'changed' ||
        write.approvalId !== need.id ||
        write.sessionId !== need.sessionId ||
        write.taskId !== need.taskId ||
        canonicalDigest({
          type: 'text.apply',
          writes: write.files.map((file) => ({
            path: file.path,
            before: file.before,
            after: file.after,
          })),
        }) !==
          (need.harness
            ? actionDigest(harnessWrites(state.project.id, need))
            : receipt.actionDigest)
      )
        throw incompatible();
    }
    commands.add(receipt.commandId);
  }
}
