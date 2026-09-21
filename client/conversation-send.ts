import { api, ApiError } from './api';
import { mintCommandId } from './work-start';
import type {
  ConversationMode,
  MessageRequest,
  MessageResult,
  SelectionRequest,
} from '../shared/conversation';

/**
 * One message to Diomedes, sent the way `work-start.ts` sends a Work start: the command identity
 * is minted once, the pending send is saved before the first request, and every retry carries the
 * same identity and the same body. The server compares a retry with what was first sent, so a
 * reused identity with a different body is refused there, not guessed at here.
 *
 * A thread is one sequential conversation, so it holds at most one unconfirmed message. Clearing
 * this browser's storage makes the next send a new message; that is the cost a Work start carries.
 */
export interface MessageInput {
  text: string;
  mode: ConversationMode;
  sources: { path: string; sha: string }[];
}
export interface PendingMessage {
  commandId: string;
  projectId: string;
  threadId: string;
  input: MessageInput;
}

const PENDING = 'diomedes.conversation.pending.';
const LAST = 'diomedes.conversation.last.';
const commandPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const inFlight = new Map<string, { input: string; promise: Promise<MessageResult> }>();

const invalid = () => new Error('The saved message is damaged; nothing was sent.');
const unavailable = () =>
  new Error('This browser cannot save the message before sending it; nothing was sent.');
/** The request may have been accepted. Sending the same message again checks the original. */
export class UnconfirmedMessage extends Error {
  constructor() {
    super('Diomedes could not confirm this message. Send it again to check what happened.');
  }
}

const keyOf = (prefix: string, projectId: string, threadId: string) =>
  `${prefix}${encodeURIComponent(projectId)}|${encodeURIComponent(threadId)}`;
function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

/** One validator for what a caller passes and for what this browser stored. */
function normalize(value: unknown): MessageInput {
  if (
    !record(value) ||
    !only(value, ['text', 'mode', 'sources']) ||
    typeof value.text !== 'string' ||
    !value.text.trim() ||
    value.text.length > 32_000 ||
    (value.mode !== 'ask' && value.mode !== 'plan' && value.mode !== 'auto') ||
    !Array.isArray(value.sources) ||
    value.sources.length > 8
  )
    throw invalid();
  const sources = value.sources.map((source: unknown) => {
    if (
      !record(source) ||
      !only(source, ['path', 'sha']) ||
      typeof source.path !== 'string' ||
      !source.path ||
      source.path.length > 4000 ||
      typeof source.sha !== 'string' ||
      !shaPattern.test(source.sha)
    )
      throw invalid();
    return { path: source.path, sha: source.sha };
  });
  return { text: value.text.trim(), mode: value.mode, sources };
}

function storageFor(kind: 'session' | 'local'): Storage {
  try {
    const storage = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
    if (!storage) throw unavailable();
    return storage;
  } catch {
    throw unavailable();
  }
}

function readPending(storage: Storage, projectId: string, threadId: string) {
  let raw: string | null;
  try {
    raw = storage.getItem(keyOf(PENDING, projectId, threadId));
  } catch {
    throw unavailable();
  }
  if (raw === null) return null;
  if (raw.length > 80_000) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    !record(value) ||
    !only(value, ['commandId', 'projectId', 'threadId', 'input']) ||
    typeof value.commandId !== 'string' ||
    !commandPattern.test(value.commandId) ||
    value.projectId !== projectId ||
    value.threadId !== threadId
  )
    throw invalid();
  const pending: PendingMessage = {
    commandId: value.commandId,
    projectId,
    threadId,
    input: normalize(value.input),
  };
  return pending;
}

/** The message this thread sent and never had confirmed, or null. Read on load, to offer it back. */
export function pendingMessage(projectId: string, threadId: string): PendingMessage | null {
  return readPending(storageFor('session'), projectId, threadId);
}

/**
 * The person's own choice to give up on an unconfirmed message. It may have been answered; if it
 * was, the transcript shows it. Nothing it proposed can start, because only a selection starts work.
 */
export function discardPendingMessage(projectId: string, threadId: string) {
  storageFor('session').removeItem(keyOf(PENDING, projectId, threadId));
}

/**
 * The last confirmed message on a thread. An identity, never a status: the outcome is asked for
 * again each time it is shown. Kept across restarts so a proposal can still be found afterwards.
 */
export function lastCommand(projectId: string, threadId: string): string | null {
  try {
    const saved = storageFor('local').getItem(keyOf(LAST, projectId, threadId));
    return saved !== null && commandPattern.test(saved) ? saved : null;
  } catch {
    return null;
  }
}
function rememberLast(projectId: string, threadId: string, commandId: string) {
  try {
    storageFor('local').setItem(keyOf(LAST, projectId, threadId), commandId);
  } catch {
    // The answer is already on screen. Only finding its proposal after a restart is lost.
  }
}

const base = (projectId: string, threadId: string) =>
  `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/messages`;
const final = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
const confirms = (result: MessageResult, pending: PendingMessage) =>
  record(result) && result.commandId === pending.commandId && record(result.outcome);

async function dispatch(
  storage: Storage,
  pending: PendingMessage,
  uncertain: boolean,
  signal: AbortSignal | undefined,
) {
  const key = keyOf(PENDING, pending.projectId, pending.threadId);
  const body: MessageRequest = { ...pending.input, commandId: pending.commandId, consent: true };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await api<MessageResult>(
        base(pending.projectId, pending.threadId),
        'POST',
        body,
        signal,
      );
      if (!confirms(result, pending)) throw new UnconfirmedMessage();
      // A cleanup failure must never retry a confirmed send.
      try {
        storage.removeItem(key);
      } catch {
        /* the same body and identity read back the same answer */
      }
      rememberLast(pending.projectId, pending.threadId, pending.commandId);
      return result;
    } catch (error) {
      if (final(error)) {
        // A first attempt the server refused was never accepted. After an uncertain attempt a
        // refusal may be about the retry, not the original, so the saved message is kept.
        if (!uncertain) storage.removeItem(key);
        throw error;
      }
      // Stopping is the person's act, not a fault to retry. The saved message stays, so sending
      // it again reads what the record says rather than asking the model twice.
      if (signal?.aborted) throw new UnconfirmedMessage();
      uncertain = true;
    }
  }
  throw new UnconfirmedMessage();
}

export async function sendMessage(
  projectId: string,
  threadId: string,
  input: MessageInput,
  signal?: AbortSignal,
): Promise<MessageResult> {
  if (!id(projectId) || !id(threadId)) throw invalid();
  const normalized = normalize(input);
  const inputJson = JSON.stringify(normalized);
  const storage = storageFor('session');
  const key = keyOf(PENDING, projectId, threadId);
  let pending = readPending(storage, projectId, threadId);
  const uncertain = pending !== null;
  if (pending && JSON.stringify(pending.input) !== inputJson)
    throw new Error(
      'An earlier message on this conversation was never confirmed. Send it again or discard it first.',
    );
  const flight = inFlight.get(key);
  if (flight) {
    if (flight.input !== inputJson) throw new UnconfirmedMessage();
    return flight.promise;
  }
  if (!pending) {
    pending = { commandId: mintCommandId(), projectId, threadId, input: normalized };
    try {
      storage.setItem(key, JSON.stringify(pending));
    } catch {
      throw unavailable();
    }
  }
  const promise = dispatch(storage, pending, uncertain, signal).finally(() =>
    inFlight.delete(key),
  );
  inFlight.set(key, { input: inputJson, promise });
  return promise;
}

/**
 * Starts what Diomedes proposed for one message. The server binds the selection to that message,
 * that proposal and that project, and answers a repeated selection with the same result, so one
 * retry after an uncertain failure is safe and nothing needs saving here.
 */
export async function selectProposal(
  projectId: string,
  threadId: string,
  commandId: string,
  selection: Omit<SelectionRequest, 'consent'>,
): Promise<MessageResult> {
  const body: SelectionRequest = { ...selection, consent: true };
  const path = `${base(projectId, threadId)}/${encodeURIComponent(commandId)}/select`;
  try {
    return await api<MessageResult>(path, 'POST', body);
  } catch (error) {
    if (final(error)) throw error;
    return api<MessageResult>(path, 'POST', body);
  }
}

/** What the record says about one message now. Null when this thread never held it. */
export async function readOutcome(
  projectId: string,
  threadId: string,
  commandId: string,
  signal?: AbortSignal,
): Promise<MessageResult | null> {
  try {
    return await api<MessageResult>(
      `${base(projectId, threadId)}/${encodeURIComponent(commandId)}`,
      'GET',
      undefined,
      signal,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
