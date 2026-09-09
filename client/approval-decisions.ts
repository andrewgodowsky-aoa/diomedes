import { api, ApiError } from './api';
import type { ApprovalCommand, Need } from '../shared/types';

export type ApprovalResolution = 'go-ahead' | 'declined';

interface Pending {
  projectId: string;
  needId: string;
  taskId: string;
  sessionId: string;
  command: ApprovalCommand;
}

const PREFIX = 'diomedes.approval.pending.';
const MAX_PENDING = 32;
const inFlight = new Map<string, { signature: string; promise: Promise<Need> }>();
const commandPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const intentPattern = /^[a-f0-9]{64}$/;
const invalid = () => new Error('Stored approval command is invalid; the request was not sent.');
const unavailable = () => new Error('Approval storage is unavailable; the request was not sent.');
const unresolved = () =>
  new Error(
    'Approval could not be confirmed. The request may have been accepted; ' +
      'retrying the same approval checks the original request.',
  );

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function time(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
}

function readPending(
  storage: Storage,
  key: string,
  projectId: string,
  needId: string,
): Pending | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    throw unavailable();
  }
  if (raw === null) return null;
  if (raw.length > 4096) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    !record(value) ||
    Object.keys(value).some(
      (field) => !['projectId', 'needId', 'taskId', 'sessionId', 'command'].includes(field),
    ) ||
    !text(value.projectId, 100) ||
    !text(value.needId, 100) ||
    !text(value.taskId, 100) ||
    !text(value.sessionId, 100) ||
    value.projectId !== projectId ||
    value.needId !== needId ||
    !record(value.command)
  )
    throw invalid();
  const command = value.command;
  if (
    Object.keys(command).some(
      (field) =>
        ![
          'protocolVersion',
          'commandId',
          'resolution',
          'proposalDigest',
          'actionDigest',
          'baseDigest',
        ].includes(field),
    ) ||
    command.protocolVersion !== 1 ||
    typeof command.commandId !== 'string' ||
    !commandPattern.test(command.commandId) ||
    (command.resolution !== 'go-ahead' && command.resolution !== 'declined') ||
    typeof command.proposalDigest !== 'string' ||
    !digestPattern.test(command.proposalDigest) ||
    typeof command.actionDigest !== 'string' ||
    !(digestPattern.test(command.actionDigest) || intentPattern.test(command.actionDigest)) ||
    typeof command.baseDigest !== 'string' ||
    !digestPattern.test(command.baseDigest)
  )
    throw invalid();
  return {
    projectId: value.projectId,
    needId: value.needId,
    taskId: value.taskId,
    sessionId: value.sessionId,
    command: {
      protocolVersion: 1,
      commandId: command.commandId,
      resolution: command.resolution,
      proposalDigest: command.proposalDigest,
      actionDigest: command.actionDigest,
      baseDigest: command.baseDigest,
    },
  };
}

function clearPending(storage: Storage, key: string, accepted: boolean) {
  try {
    storage.removeItem(key);
  } catch {
    throw new Error(
      accepted
        ? 'Approval was accepted, but this browser could not clear its saved request. Check approvals before deciding again.'
        : 'The approval request was refused, but this browser could not clear its saved request.',
    );
  }
}

function confirms(need: Need, pending: Pending) {
  const receipt = need?.approvalReceipt;
  if (!receipt) return false;
  if (!record(receipt)) return false;
  return (
    receipt.protocolVersion === 1 &&
    receipt.commandId === pending.command.commandId &&
    receipt.projectId === pending.projectId &&
    receipt.approvalId === pending.needId &&
    receipt.approvalId === need.id &&
    receipt.taskId === pending.taskId &&
    receipt.taskId === need.taskId &&
    receipt.sessionId === pending.sessionId &&
    receipt.sessionId === need.sessionId &&
    receipt.decision === pending.command.resolution &&
    receipt.proposalDigest === pending.command.proposalDigest &&
    receipt.actionDigest === pending.command.actionDigest &&
    receipt.baseDigest === pending.command.baseDigest &&
    receipt.actor === 'local-client' &&
    receipt.scope === 'local-prototype' &&
    typeof receipt.payloadDigest === 'string' &&
    digestPattern.test(receipt.payloadDigest) &&
    text(receipt.eventId, 100) &&
    time(receipt.createdAt) &&
    time(receipt.expiresAt) &&
    time(receipt.decidedAt) &&
    receipt.createdAt === need.createdAt &&
    receipt.expiresAt === need.approval?.expiresAt &&
    Date.parse(receipt.decidedAt) >= Date.parse(receipt.createdAt) &&
    Date.parse(receipt.decidedAt) < Date.parse(receipt.expiresAt)
  );
}

/** Reuse the existing state refresh after reload or SSE; no extra request or timer. */
export function reconcileApprovals(projectId: string, needs: readonly Need[]): Error | undefined {
  let storage: Storage;
  const projectPrefix = `${PREFIX}${encodeURIComponent(projectId)}|`;
  const keys: string[] = [];
  try {
    storage = globalThis.sessionStorage;
    if (!storage) throw new Error('unavailable');
    for (let n = 0; n < storage.length; n++) {
      const key = storage.key(n);
      if (key?.startsWith(projectPrefix)) keys.push(key);
    }
  } catch {
    return new Error(
      'Saved approval requests could not be checked because browser storage is unavailable. Check approvals before deciding again.',
    );
  }
  if (!keys.length) return;
  if (keys.length > MAX_PENDING)
    return new Error(
      'Too many saved approval requests to check. Check approvals before deciding again.',
    );
  const byId = new Map<string, Need>();
  for (const need of needs) byId.set(need.id, need);
  let issue: Error | undefined;
  for (const key of keys) {
    try {
      const needId = decodeURIComponent(key.slice(projectPrefix.length));
      const pending = readPending(storage, key, projectId, needId);
      if (!pending) continue;
      const need = byId.get(pending.needId);
      if (!need) continue;
      if (!need.approvalReceipt) continue;
      if (confirms(need, pending)) {
        clearPending(storage, key, true);
      } else {
        issue ??= new Error(
          'A saved approval request could not be checked. It has been kept; check approvals before deciding again.',
        );
      }
    } catch (error) {
      // Keep the damaged record and report it. Independent confirmed records can
      // still reconcile, and a storage fault must not block unrelated state UI.
      issue ??= new Error(
        'A saved approval request could not be checked. It has been kept; check approvals before deciding again.',
        { cause: error },
      );
    }
  }
  return issue;
}

async function dispatch(storage: Storage, key: string, pending: Pending, uncertain: boolean) {
  const body = {
    protocolVersion: 1,
    commandId: pending.command.commandId,
    resolution: pending.command.resolution,
    proposalDigest: pending.command.proposalDigest,
    actionDigest: pending.command.actionDigest,
    baseDigest: pending.command.baseDigest,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let need: Need;
    try {
      need = await api<Need>(
        `/projects/${encodeURIComponent(pending.projectId)}/needs/${encodeURIComponent(pending.needId)}/resolve`,
        'POST',
        body,
      );
      if (!confirms(need, pending)) throw unresolved();
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        if (!uncertain) clearPending(storage, key, false);
        throw error;
      }
      uncertain = true;
      if (attempt === 1) throw unresolved();
      continue;
    }
    // A cleanup error is surfaced separately; it must not retry a confirmed send.
    clearPending(storage, key, true);
    return need;
  }
  throw unresolved();
}

/** Exact approval decisions retry the same command; legacy sample requests send once. */
export async function decideApproval(
  projectId: string,
  need: Need,
  resolution: ApprovalResolution,
  allowForTask = false,
): Promise<Need> {
  if (!text(projectId, 100)) throw invalid();
  if (resolution !== 'go-ahead' && resolution !== 'declined') throw invalid();
  if (!record(need) || !text(need.id, 100) || !text(need.taskId, 100) || !text(need.sessionId, 100))
    throw invalid();

  // Legacy path: no exact identity, keep the existing plain POST once without retries.
  if (!need.approval) {
    return api<Need>(
      `/projects/${encodeURIComponent(projectId)}/needs/${encodeURIComponent(need.id)}/resolve`,
      'POST',
      { resolution, allowForTask },
    );
  }

  if (allowForTask)
    throw new Error('Task allowance is not supported for exact approval decisions.');
  const approval = need.approval;
  if (
    !record(approval) ||
    approval.protocolVersion !== 1 ||
    typeof approval.proposalDigest !== 'string' ||
    !digestPattern.test(approval.proposalDigest) ||
    typeof approval.actionDigest !== 'string' ||
    !(need.harness ? intentPattern : digestPattern).test(approval.actionDigest) ||
    typeof approval.baseDigest !== 'string' ||
    !digestPattern.test(approval.baseDigest)
  )
    throw new Error('Provide a valid version 1 exact approval identity.');

  let storage: Storage;
  try {
    storage = globalThis.sessionStorage;
    if (!storage) throw unavailable();
  } catch {
    throw unavailable();
  }
  const key = `${PREFIX}${encodeURIComponent(projectId)}|${encodeURIComponent(need.id)}`;
  let pending = readPending(storage, key, projectId, need.id);
  const uncertain = pending !== null;
  if (pending) {
    if (
      pending.command.resolution !== resolution ||
      pending.taskId !== need.taskId ||
      pending.sessionId !== need.sessionId ||
      pending.command.proposalDigest !== approval.proposalDigest ||
      pending.command.actionDigest !== approval.actionDigest ||
      pending.command.baseDigest !== approval.baseDigest
    )
      throw new Error(
        'The earlier approval decision must be resolved by retrying its original request.',
      );
  }
  const signature = pending
    ? JSON.stringify(pending)
    : JSON.stringify({
        projectId,
        needId: need.id,
        taskId: need.taskId,
        sessionId: need.sessionId,
        resolution,
        proposalDigest: approval.proposalDigest,
        actionDigest: approval.actionDigest,
        baseDigest: approval.baseDigest,
      });
  const flight = inFlight.get(key);
  if (flight) {
    if (flight.signature !== signature) throw unresolved();
    return flight.promise;
  }
  if (!pending) {
    let count = 0;
    try {
      for (let n = 0; n < storage.length; n++) if (storage.key(n)?.startsWith(PREFIX)) count++;
    } catch {
      throw unavailable();
    }
    if (count >= MAX_PENDING)
      throw new Error(
        'Too many pending approvals; resolve an earlier request before deciding again.',
      );
    pending = {
      projectId,
      needId: need.id,
      taskId: need.taskId,
      sessionId: need.sessionId,
      command: {
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        resolution,
        proposalDigest: approval.proposalDigest,
        actionDigest: approval.actionDigest,
        baseDigest: approval.baseDigest,
      },
    };
    try {
      storage.setItem(key, JSON.stringify(pending));
    } catch {
      throw unavailable();
    }
  }
  const promise = dispatch(storage, key, pending, uncertain).finally(() => inFlight.delete(key));
  inFlight.set(key, { signature: JSON.stringify(pending), promise });
  return promise;
}
