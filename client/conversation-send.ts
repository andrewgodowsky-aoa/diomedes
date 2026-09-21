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
 * A thread is one sequential conversation, so it holds at most one unconfirmed message, and that
 * message belongs to the person rather than to the window that typed it. Two records say so: a
 * shared claim in local storage, which every window of this browser reads and which alone decides
 * whether a message is pending, and a window reference in session storage, which records that this
 * window is the one waiting for it. An exclusive Web Lock covers a whole send, so a second window
 * waits for the first to finish and then reuses the command the claim holds instead of minting its
 * own. Clearing this browser's local storage makes the next send a new message; that is the cost a
 * Work start carries. Nothing here deduplicates equal text once it has been confirmed: only a
 * pending claim is shared, and only until it settles, so two windows that each send the same text
 * after a confirmation send two messages, exactly as pressing Enter twice does.
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
const CLAIM = 'diomedes.conversation.claim.';
const LAST = 'diomedes.conversation.last.';
const LOCK = 'diomedes.conversation.send.';
const commandPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const inFlight = new Map<string, { input: string; promise: Promise<MessageResult> }>();

const invalid = () => new Error('The saved message is damaged; nothing was sent.');
const unavailable = () =>
  new Error('This browser cannot save the message before sending it; nothing was sent.');
const busy = () =>
  new Error('Another window is still sending on this conversation. Nothing was sent from this one.');
const elsewhere = () =>
  new Error('That message was discarded or settled in another window. Nothing was sent from this one.');
const earlier = () =>
  new Error(
    'An earlier message on this conversation was never confirmed. Send it again or discard it first.',
  );
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

function readRecord(storage: Storage, prefix: string, projectId: string, threadId: string) {
  let raw: string | null;
  try {
    raw = storage.getItem(keyOf(prefix, projectId, threadId));
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

/** The record every window of this browser reads. It alone says whether a message is pending. */
const readClaim = (projectId: string, threadId: string) =>
  readRecord(storageFor('local'), CLAIM, projectId, threadId);
/** This window's own note that it is the one waiting. Never the only record a second window has. */
const readReference = (projectId: string, threadId: string) =>
  readRecord(storageFor('session'), PENDING, projectId, threadId);

/**
 * The claim first, then this window's reference, both before the first request. A write that fails
 * leaves nothing half saved: a claim this send minted is taken back, and nothing is sent.
 */
function save(pending: PendingMessage, minted: boolean) {
  const json = JSON.stringify(pending);
  const claimKey = keyOf(CLAIM, pending.projectId, pending.threadId);
  const shared = storageFor('local');
  if (minted) {
    try {
      shared.setItem(claimKey, json);
    } catch {
      throw unavailable();
    }
  }
  try {
    storageFor('session').setItem(keyOf(PENDING, pending.projectId, pending.threadId), json);
  } catch {
    if (minted)
      try {
        shared.removeItem(claimKey);
      } catch {
        // Nothing was sent under it. The next send reads it and sends that command, not a new one.
      }
    throw unavailable();
  }
}

/**
 * Both records of ONE command go when that command stops being pending. The claim is shared, so
 * it is removed only while it still names the command being settled: a cleanup that runs late, or
 * a control pressed beside an older message, must never take a newer message's claim with it.
 * Call it inside the lock. A cleanup fault never retries a send.
 */
function clear(projectId: string, threadId: string, commandId: string) {
  try {
    if (readClaim(projectId, threadId)?.commandId === commandId)
      storageFor('local').removeItem(keyOf(CLAIM, projectId, threadId));
  } catch {
    // The same body and identity read back the same answer.
  }
  // The claim decides; a reference no claim backs is dropped the next time it is read.
  dropReference(projectId, threadId, commandId);
}

/**
 * A reference no claim backs points at nothing: the message it names was confirmed or discarded in
 * another window. Given a command, only a reference naming that command is dropped, so a reference
 * to a different message still pending is left alone. Damaged storage is left for a send to refuse.
 */
function dropReference(projectId: string, threadId: string, commandId?: string) {
  try {
    if (commandId !== undefined) {
      const reference = readReference(projectId, threadId);
      if (!reference || reference.commandId !== commandId) return;
    }
    storageFor('session').removeItem(keyOf(PENDING, projectId, threadId));
  } catch {
    // A reference that cannot be read or removed is not what decides anything.
  }
}

/**
 * One sender per conversation, across every window of this browser. Reading the claim, deciding the
 * command, both writes, both attempts and the cleanup happen inside one lock, so a second window
 * acts on what the first settled rather than on what it read before the first began. Web Locks are
 * the only atomicity a browser offers here: without them this sends nothing rather than guess.
 *
 * The caller's Stop ends a wait for the lock. A wait that ends that way held nothing, wrote nothing
 * and sent nothing, so it is told so plainly rather than told its message may have been accepted.
 */
async function underLock<T>(
  projectId: string,
  threadId: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (!locks || typeof locks.request !== 'function') throw unavailable();
  const settled: ({ value: T } | { error: unknown })[] = [];
  try {
    await locks.request(
      keyOf(LOCK, projectId, threadId),
      { mode: 'exclusive', signal },
      async () => {
        try {
          settled.push({ value: await run() });
        } catch (error) {
          settled.push({ error });
        }
      },
    );
  } catch (error) {
    // The lock was never granted. What the callback would have written and sent, it did not.
    if (settled.length === 0) throw signal?.aborted ? busy() : error;
  }
  if (settled.length === 0) throw signal?.aborted ? busy() : unavailable();
  const outcome = settled[0];
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

/**
 * The message this thread sent and never had confirmed, or null. Read on load, to offer it back.
 * The shared claim answers: a send another window began is found here, and one another window
 * confirmed or discarded is not offered again.
 */
export function pendingMessage(projectId: string, threadId: string): PendingMessage | null {
  const claim = readClaim(projectId, threadId);
  if (!claim) {
    dropReference(projectId, threadId);
    return null;
  }
  // A claim naming the last confirmed command is a cleanup that failed, not a message to resend.
  // It is not offered, and it is removed under the lock and by its own name, so a message another
  // window claims before that cleanup runs is left alone.
  if (claim.commandId === lastCommand(projectId, threadId)) {
    const settled = claim.commandId;
    void underLock(projectId, threadId, undefined, async () =>
      clear(projectId, threadId, settled),
    ).catch(() => undefined);
    return null;
  }
  return claim;
}

/**
 * The person's own choice to give up on an unconfirmed message. It may have been answered; if it
 * was, the transcript shows it. Nothing it proposed can start, because only a selection starts work.
 *
 * It gives up the command it was shown, never whatever is pending now. It waits its turn for the
 * lock and looks again once it has it: if that command was settled meanwhile, or another message
 * has been claimed since, nothing shared is touched and the answer is false.
 */
export async function discardPendingMessage(
  projectId: string,
  threadId: string,
  commandId: string,
): Promise<boolean> {
  if (!id(projectId) || !id(threadId)) throw invalid();
  return underLock(projectId, threadId, undefined, async () => {
    const held = readClaim(projectId, threadId)?.commandId === commandId;
    clear(projectId, threadId, commandId);
    return held;
  });
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
  pending: PendingMessage,
  uncertain: boolean,
  signal: AbortSignal | undefined,
) {
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
      clear(pending.projectId, pending.threadId, pending.commandId);
      rememberLast(pending.projectId, pending.threadId, pending.commandId);
      return result;
    } catch (error) {
      if (final(error)) {
        // A first attempt the server refused was never accepted. After an uncertain attempt a
        // refusal may be about the retry, not the original, so the saved message is kept.
        if (!uncertain) clear(pending.projectId, pending.threadId, pending.commandId);
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
  const key = keyOf(PENDING, projectId, threadId);
  // This window's own second press, answered before the lock: the send that holds it is this one.
  const flight = inFlight.get(key);
  if (flight) {
    // A different message while one is on its way was never sent, so it is refused as itself
    // and stays the person's to keep. Only the message in flight can be unconfirmed.
    if (flight.input !== inputJson) throw earlier();
    return flight.promise;
  }
  const promise = underLock(projectId, threadId, signal, async () => {
    const reference = readReference(projectId, threadId);
    let claim = readClaim(projectId, threadId);
    // A claim naming the last confirmed command is a cleanup that failed. It is settled, so it
    // neither blocks a new message nor lends it an identity.
    if (claim && claim.commandId === lastCommand(projectId, threadId)) {
      clear(projectId, threadId, claim.commandId);
      claim = null;
    }
    if (claim && JSON.stringify(claim.input) !== inputJson) throw earlier();
    // A claim still pending is this message, whichever window began it. Without one the text is a
    // new message however often it has been sent before, and any reference left here named a
    // command another window confirmed or discarded.
    if (!claim && reference) dropReference(projectId, threadId);
    const pending =
      claim ?? { commandId: mintCommandId(), projectId, threadId, input: normalized };
    save(pending, claim === null);
    return dispatch(pending, claim !== null, signal);
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, { input: inputJson, promise });
  return promise;
}

/**
 * Send again, for the message a window was offered back. It can only ever send the command the
 * shared claim still holds. If that command settled or was discarded in another window while this
 * one was showing it, the record is read instead and nothing is sent, so Send again never mints a
 * second command for a message that already has one.
 */
export async function resendPending(
  projectId: string,
  threadId: string,
  commandId: string,
  signal?: AbortSignal,
): Promise<MessageResult> {
  if (!id(projectId) || !id(threadId)) throw invalid();
  return underLock(projectId, threadId, signal, async () => {
    const claim = readClaim(projectId, threadId);
    if (claim && claim.commandId === commandId) return dispatch(claim, true, signal);
    const settled = await readOutcome(projectId, threadId, commandId, signal);
    dropReference(projectId, threadId, commandId);
    if (!settled) throw elsewhere();
    rememberLast(projectId, threadId, commandId);
    return settled;
  });
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
