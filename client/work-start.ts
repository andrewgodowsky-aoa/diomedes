import { api, ApiError } from './api';
import type { Route, Session } from '../shared/types';
import { isRoute } from '../shared/engines';

export interface WorkStartInput {
  taskId: string;
  route: Route;
  sources: string[];
  consent: boolean;
  instruction?: string;
  threadId?: string;
  demo?: 'fault';
}
interface Pending {
  commandId: string;
  projectId: string;
  taskId: string;
  input: WorkStartInput;
}
const PREFIX = 'diomedes.work-start.pending.';
const MAX_PENDING = 32;
const inFlight = new Map<string, { input: string; promise: Promise<Session> }>();
const commandPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** One place mints a command identity, for a Work start and for a follow-up alike. */
export const mintCommandId = (): string => crypto.randomUUID();
const invalid = () => new Error('Stored work-start command is invalid; the request was not sent.');
const unavailable = () => new Error('Work start storage is unavailable; the request was not sent.');
const unresolved = () =>
  new Error(
    'Work start could not be confirmed. The request may have been accepted; ' +
      'retrying the same task checks the original request.',
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
/** One small validator for both caller input and browser-stored input. No file bytes. */
function normalize(value: unknown): WorkStartInput {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        !['taskId', 'route', 'sources', 'consent', 'instruction', 'threadId', 'demo'].includes(key),
    ) ||
    !text(value.taskId, 100) ||
    !isRoute(value.route) ||
    !Array.isArray(value.sources) ||
    value.sources.length > 8 ||
    typeof value.consent !== 'boolean'
  )
    throw invalid();
  if (!isRoute(value.route)) throw invalid();
  const sources: string[] = [];
  for (const source of value.sources) {
    if (!text(source, 1000)) throw invalid();
    sources.push(source);
  }
  const input: WorkStartInput = {
    taskId: value.taskId.trim(),
    route: value.route,
    sources,
    consent: value.consent,
  };
  if (value.instruction !== undefined) {
    if (!text(value.instruction, 16_000)) throw invalid();
    input.instruction = value.instruction.trim();
  }
  if (value.threadId !== undefined) {
    if (!text(value.threadId, 100)) throw invalid();
    input.threadId = value.threadId.trim();
  }
  if (value.demo !== undefined) {
    if (value.demo !== 'fault') throw invalid();
    input.demo = value.demo;
  }
  return input;
}
function readPending(
  storage: Storage,
  key: string,
  projectId: string,
  taskId: string,
): Pending | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    throw unavailable();
  }
  if (raw === null) return null;
  if (raw.length > 160_000) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    !record(value) ||
    Object.keys(value).some(
      (field) => !['commandId', 'projectId', 'taskId', 'input'].includes(field),
    ) ||
    typeof value.commandId !== 'string' ||
    !commandPattern.test(value.commandId) ||
    value.projectId !== projectId ||
    value.taskId !== taskId
  )
    throw invalid();
  const input = normalize(value.input);
  if (input.taskId !== taskId) throw invalid();
  return { commandId: value.commandId, projectId, taskId, input };
}
function clearPending(storage: Storage, key: string, accepted: boolean) {
  try {
    storage.removeItem(key);
  } catch {
    throw new Error(
      accepted
        ? 'Work was accepted, but this browser could not clear its saved request. Check Work before starting again.'
        : 'The request was refused, but this browser could not clear its saved request.',
    );
  }
}
function confirms(session: Session, pending: Pending) {
  const receipt = session?.receipt;
  return (
    text(session?.id, 100) &&
    receipt?.protocolVersion === 1 &&
    receipt.commandId === pending.commandId &&
    receipt.projectId === pending.projectId &&
    receipt.taskId === pending.taskId &&
    receipt.route === pending.input.route &&
    session.taskId === pending.taskId &&
    receipt.sessionId === session.id &&
    receipt.scope === 'local-prototype' &&
    /^sha256:[a-f0-9]{64}$/.test(receipt.payloadDigest)
  );
}

/** Reuse the existing state refresh after reload or SSE; no extra request or timer. */
export function reconcileWorkStarts(
  projectId: string,
  sessions: readonly Session[],
): Error | undefined {
  let storage: Storage;
  const projectPrefix = `${PREFIX}${encodeURIComponent(projectId)}|`;
  const keys: string[] = [];
  try {
    storage = globalThis.sessionStorage;
    for (let n = 0; n < storage.length; n++) {
      const key = storage.key(n);
      if (key?.startsWith(projectPrefix)) keys.push(key);
    }
  } catch {
    return new Error(
      'Saved Work requests could not be checked because browser storage is unavailable. Check Work before starting again.',
    );
  }
  if (!keys.length) return;
  if (keys.length > MAX_PENDING)
    return new Error('Too many saved Work requests to check. Check Work before starting again.');
  const commands = new Map<string, Session>();
  for (const session of sessions)
    if (session.receipt) commands.set(session.receipt.commandId, session);
  let issue: Error | undefined;
  for (const key of keys) {
    try {
      const taskId = decodeURIComponent(key.slice(projectPrefix.length));
      const pending = readPending(storage, key, projectId, taskId);
      if (!pending) continue;
      const session = commands.get(pending.commandId);
      if (session && confirms(session, pending)) clearPending(storage, key, true);
    } catch (error) {
      // Keep the damaged record and report it. Independent confirmed records can
      // still reconcile, and a storage fault must not block unrelated state UI.
      issue ??= new Error(
        'A saved Work request could not be checked. It has been kept; check Work before starting again.',
        { cause: error },
      );
    }
  }
  return issue;
}
async function dispatch(storage: Storage, key: string, pending: Pending, uncertain: boolean) {
  const body = { ...pending.input, protocolVersion: 1, commandId: pending.commandId };
  for (let attempt = 0; attempt < 2; attempt++) {
    let session: Session;
    try {
      session = await api<Session>(
        `/projects/${encodeURIComponent(pending.projectId)}/work/start`,
        'POST',
        body,
      );
      if (!confirms(session, pending)) throw unresolved();
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
    return session;
  }
  throw unresolved();
}

/** Only task Work starts retry. Approval, Ask and other API calls keep their own semantics. */
export async function startWork(projectId: string, input: WorkStartInput): Promise<Session> {
  if (!text(projectId, 100)) throw invalid();
  const normalized = normalize(input);
  const inputJson = JSON.stringify(normalized);
  let storage: Storage;
  try {
    storage = globalThis.sessionStorage;
    if (!storage) throw unavailable();
  } catch {
    throw unavailable();
  }
  const key = `${PREFIX}${encodeURIComponent(projectId)}|${encodeURIComponent(normalized.taskId)}`;
  let pending = readPending(storage, key, projectId, normalized.taskId);
  const uncertain = pending !== null;
  if (pending && JSON.stringify(pending.input) !== inputJson)
    throw new Error('The earlier Work start must be resolved by retrying its original request.');
  const flight = inFlight.get(key);
  if (flight) {
    if (flight.input !== inputJson) throw unresolved();
    return flight.promise;
  }
  if (!pending) {
    let count = 0;
    for (let n = 0; n < storage.length; n++) if (storage.key(n)?.startsWith(PREFIX)) count++;
    if (count >= MAX_PENDING)
      throw new Error(
        'Too many pending work starts; resolve an earlier request before starting new work.',
      );
    pending = {
      commandId: mintCommandId(),
      projectId,
      taskId: normalized.taskId,
      input: normalized,
    };
    try {
      storage.setItem(key, JSON.stringify(pending));
    } catch {
      throw unavailable();
    }
  }
  const promise = dispatch(storage, key, pending, uncertain).finally(() => inFlight.delete(key));
  inFlight.set(key, { input: inputJson, promise });
  return promise;
}
