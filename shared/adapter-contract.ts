/**
 * Adapter contract, version 1 — the H01 seam.
 *
 * One versioned contract binds every execution route: the ten lifecycle
 * commands with an explicit support answer each, the durable event
 * vocabulary, and the cursor semantics a reconnecting reader uses. Diomedes'
 * own contract is primary here — ACP and the engine-specific protocols are
 * transports mapped onto it, not the source of it.
 *
 * What this is not: a parallel runtime. `server/harness/run-service.ts`
 * remains the one durable authority; this file names the vocabulary the
 * runtime already writes and the support modes each route honestly declares.
 * A capability a route cannot perform is `unsupported`, never implied.
 *
 * Backward handling follows the contract revision: unknown fields on a
 * descriptor or event are tolerated only where they change nothing, and an
 * unknown event type is unknown — never terminal, never safe.
 */
import { z } from 'zod';
import { HARNESS_CONTRACT_VERSION, type HarnessEvent } from './harness.js';
import type { COMMAND_FAMILIES } from './contract-revision.js';

export const ADAPTER_CONTRACT_VERSION = 1 as const;

// --- the lifecycle commands ------------------------------------------------------------

/**
 * The ten operations a route can be asked for. `start` creates work;
 * `follow-up`, `steer` and `interrupt` address live work; `resume`, `retry`
 * and `fork` continue recorded work; `status` and `reconcile` read it; and
 * `close` ends the route's own session or process — distinct from the
 * run-level `stop` command family, which cancels work.
 */
export const ADAPTER_COMMANDS = [
  'start',
  'follow-up',
  'steer',
  'interrupt',
  'resume',
  'retry',
  'fork',
  'status',
  'reconcile',
  'close',
] as const;
export type AdapterCommand = (typeof ADAPTER_COMMANDS)[number];

/**
 * How a route answers a command.
 * `native` — the route's own mechanism performs it (ACP `session/cancel`, a
 *   run-service operation, an engine interrupt).
 * `host` — Diomedes composes it from primitives the route does have (status
 *   read from a tracked process, retry as an explicit fresh dispatch).
 * `unsupported` — the route cannot do it, and the note says so instead of
 *   pretending.
 */
export type CommandSupport = 'native' | 'host' | 'unsupported';
export interface CommandAvailability {
  readonly support: CommandSupport;
  /** What the support level means on this route — never empty. */
  readonly note: string;
}
export type CommandSupportMap = Record<AdapterCommand, CommandAvailability>;

type CommandFamily = (typeof COMMAND_FAMILIES)[number];
/**
 * Every lifecycle command binds to a durable command family, so a control
 * operation carries the same versioned command identity as `work.start`.
 * Commands that read rather than act (`status`, `reconcile`) still name a
 * family: an auditable control plane correlates even its reads.
 */
export const COMMAND_FAMILY: Record<AdapterCommand, CommandFamily> = Object.freeze({
  start: 'work.start',
  'follow-up': 'follow-up.queue',
  steer: 'steer',
  interrupt: 'interrupt',
  resume: 'resume',
  retry: 'retry',
  fork: 'fork',
  status: 'status',
  reconcile: 'reconcile',
  close: 'close',
});

// --- the durable event vocabulary ---------------------------------------------------------

/**
 * The closed set of event types the durable stream may carry.
 *
 * Emitted by `RunService` today: every `run.*`, `step.*`, `approval.decided`
 * and `transcript.recorded`. Reserved for the named control items the
 * revision defines: `command.accepted`, `control.applied`, `control.rejected`
 * and `step.waiting_event` — defined here so a later item emits them rather
 * than forking the vocabulary, and so a reader meeting one knows what it is.
 * `step.failed` and `step.cancelled` are reserved likewise: the states exist;
 * no emitter exists yet.
 *
 * Output deltas are never members of this set. A delta is a transient
 * preview: bounded, sequence-numbered, redacted, and gone on reconnect —
 * the durable record is the final observation, not the stream of text.
 */
export const RUN_EVENT_TYPES = [
  'run.created',
  'run.recovered',
  'run.claimed',
  'run.lease_renewed',
  'run.cancelled',
  'run.completed',
  'run.failed',
  'run.forked',
  'step.started',
  'step.succeeded',
  'step.checkpointed',
  'step.waiting_approval',
  'step.waiting_event',
  'step.retry_wait',
  'step.reconcile_required',
  'step.failed',
  'step.cancelled',
  'approval.decided',
  'transcript.recorded',
  'command.accepted',
  'control.applied',
  'control.rejected',
  // H12 mediated effects: an effect intent and the outcome recorded against it.
  'effect.intended',
  'effect.applied',
  'effect.failed',
  'effect.uncertain',
  'effect.abandoned',
  'effect.reconciled',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export function isRunEventType(type: unknown): type is RunEventType {
  return typeof type === 'string' && (RUN_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Terminal authority. Exactly these three end a run; `reconcile_required`
 * and `waiting` are parked states, and no transport receipt — HTTP 200, an
 * ACP reply, a flushed frame — is a terminal event.
 */
export const TERMINAL_EVENT_TYPES = ['run.completed', 'run.failed', 'run.cancelled'] as const;
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];
export function isTerminalEventType(type: unknown): type is TerminalEventType {
  return (
    typeof type === 'string' && (TERMINAL_EVENT_TYPES as readonly string[]).includes(type)
  );
}

/** The transient preview channel — bounded text, never persisted. */
export const OUTPUT_DELTA = Object.freeze({
  durable: false as const,
  /** One preview frame's text budget, in UTF-8 bytes; a larger chunk is an error, not a truncation. */
  maxChunkBytes: 64 * 1024,
  note: 'A text delta is a preview only. It is sequence-numbered for gap detection by the presenter, never persisted, and a reconnect re-reads the durable record rather than the deltas.',
});

/** The advertised bound is bytes; JavaScript string length is characters, not bytes. */
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** What one preview frame may carry. Attribution is mandatory. */
export const transientPreviewSchema = z.strictObject({
  kind: z.literal('text-delta'),
  projectId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  /**
   * The authoritative runtime identity the frame was emitted under: the
   * durable run, its dispatch step and that step's attempt and lease fence.
   * A frame is preview evidence of exactly one fenced attempt — never of a
   * request id alone, which another owner or generation could share.
   */
  runId: z.string().min(1).max(200),
  stepId: z.string().min(1).max(200),
  attempt: z.number().int().positive(),
  fence: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  text: z
    .string()
    .refine((text) => utf8Bytes(text) <= OUTPUT_DELTA.maxChunkBytes, {
      message: `A preview frame may carry at most ${OUTPUT_DELTA.maxChunkBytes} UTF-8 bytes.`,
    }),
});
export type TransientPreview = z.infer<typeof transientPreviewSchema>;

/** Why a preview frame was refused — a bound violation, not a transport hiccup. */
export interface PreviewRejection {
  readonly code: 'OUTPUT_LIMIT';
  readonly reason: string;
}

// --- live redaction --------------------------------------------------------------------------

/**
 * How much of a live stream waits before it is shown, so the route's redaction reads a secret
 * whole even when the engine streams it in pieces: always the newest `holdChars` characters, and
 * the word still being written when it is longer, up to `wordChars`. A secret without spaces (a
 * key, a token, a home folder) is caught up to `wordChars` characters long, and one with spaces up
 * to `holdChars`; a longer one can still show its first part live. The saved reply and its saved
 * thinking are redacted as one piece either way.
 */
export const LIVE_REDACTION = Object.freeze({
  holdChars: 32,
  wordChars: 256,
  /** Bounds on output waiting behind another channel, measured in UTF-16 units and places. */
  pendingChars: 2 * 1024 * 1024,
  pendingFrames: 8192,
});

/** Past this, a window no clean cut has shortened is redacted again only once it grows by a quarter. */
const SLOW_WINDOW_CHARS = 16 * 1024;

const WHITESPACE = /\s/;

/** A character's UTF-8 size. A lone surrogate is encoded as U+FFFD, three bytes. */
const charBytes = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
};

/** Pieces of at most `max` UTF-8 bytes, never splitting a character. */
function splitBytes(text: string, max: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  let bytes = 0;
  for (const char of text) {
    const size = charBytes(char);
    if (piece && bytes + size > max) {
      pieces.push(piece);
      piece = '';
      bytes = 0;
    }
    piece += char;
    bytes += size;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/** How many leading UTF-16 units two strings share. */
function sharedPrefix(a: string, b: string): number {
  const most = Math.min(a.length, b.length);
  let at = 0;
  while (at < most && a.charCodeAt(at) === b.charCodeAt(at)) at += 1;
  return at;
}

/**
 * Redaction for a stream that arrives in pieces. `redact` always reads the stream's text as one
 * piece, never a chunk on its own, and only what more text can no longer change is released: the
 * part of the whole that the text before the held tail, redacted alone, already agrees with. The
 * window restarts at that cut once everything before it is released and the two sides redact the
 * same apart as together, so a chunk costs about the hold rather than the whole stream so far.
 *
 * After a restart, a pattern anchored on a word boundary can match at the window's start where the
 * whole stream would not. That only ever redacts more, never less.
 */
function streamRedaction(redact: (text: string) => string) {
  /** The raw text since the last clean cut. Everything before it is released and final. */
  let text = '';
  /** How much of `redact(text)` has been released. */
  let released = 0;
  /** The window's length when it was last redacted. */
  let read = 0;
  const reset = () => {
    text = '';
    released = 0;
    read = 0;
  };
  return {
    /** Adds a chunk and returns the redacted text that is now safe to show, often none. */
    push(chunk: string): string {
      text += chunk;
      const floor = Math.max(0, text.length - LIVE_REDACTION.wordChars);
      let word = text.length;
      while (word > floor && !WHITESPACE.test(text[word - 1])) word -= 1;
      const cut = Math.min(text.length - LIVE_REDACTION.holdChars, word);
      if (cut <= 0) return '';
      if (text.length > SLOW_WINDOW_CHARS && text.length < read + read / 4) return '';
      read = text.length;
      const whole = redact(text);
      const settled = redact(text.slice(0, cut));
      let end = sharedPrefix(whole, settled);
      // Never half a surrogate pair: the whole character goes with the next release.
      const last = whole.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      const out = end > released ? whole.slice(released, end) : '';
      released = Math.max(released, end);
      if (released === settled.length && whole === settled + redact(text.slice(cut))) {
        text = text.slice(cut);
        released = 0;
        read = text.length;
      }
      return out;
    },
    /** Everything still held, redacted with the rest of its window. The stream starts over. */
    flush(): string {
      const rest = text;
      const from = released;
      reset();
      return rest ? redact(rest).slice(from) : '';
    },
    /** Forgets what is held, unseen. */
    drop: reset,
  };
}

/** A place in the attempt's output order, released only after its channel has redacted it. */
interface LiveChannel {
  reserve(chars: number): (deliver: () => void) => void;
  fail(message: string): never;
}

/**
 * One attempt's live channels, kept in producer order. Switching channels is not an end-of-text
 * boundary: a secret can continue after a tool notification. Later frames wait for earlier text
 * to become safe, or for the attempt to finish. Stop discards the held text through each sink.
 */
export interface LiveOrder {
  join(flush: () => void, options?: { optional?: boolean }): LiveChannel;
  /** Shows what every channel still holds. */
  flush(): void;
}

export function liveOrder(): LiveOrder {
  const channels: (() => void)[] = [];
  const pending: { chars: number; deliver?: () => void }[] = [];
  let pendingChars = 0;
  let failure: Error | undefined;
  let draining = false;
  const drain = () => {
    if (draining) return;
    draining = true;
    try {
      while (pending[0]?.deliver) {
        const place = pending.shift()!;
        pendingChars -= place.chars;
        place.deliver!();
      }
    } finally {
      draining = false;
    }
  };
  return {
    join(flush, options) {
      channels.push(flush);
      const fail = (message: string): never => {
        const error = Object.assign(new Error(message), { code: 'OUTPUT_LIMIT' });
        if (!options?.optional) failure ??= error;
        throw error;
      };
      return {
        fail,
        reserve(chars) {
          if (failure) throw failure;
          if (pending.length >= LIVE_REDACTION.pendingFrames || pendingChars + chars > LIVE_REDACTION.pendingChars)
            fail('Too many live frames are waiting for redaction.');
          const place: { chars: number; deliver?: () => void } = { chars };
          pending.push(place);
          pendingChars += chars;
          let released = false;
          return (deliver: () => void) => {
            if (released) return;
            released = true;
            place.deliver = deliver;
            drain();
          };
        },
      };
    },
    flush() {
      // A transport may catch a callback error; it cannot turn a refused stream into success.
      if (failure) throw failure;
      for (const channel of channels) channel();
    },
  };
}

/**
 * Redact each channel as one stream while preserving the original chunk positions across channels.
 * A redaction spanning a chunk boundary is emitted with the later chunk; no partial credential is
 * emitted with the earlier one. Clean cuts bound the raw window, as in `streamRedaction`.
 */
function orderedRedaction(redact: (text: string) => string, channel: LiveChannel, emit: (text: string) => void) {
  let text = '';
  let released = 0;
  let read = 0;
  const chunks: { end: number; release: (deliver: () => void) => void }[] = [];
  const settle = (final: boolean) => {
    let cut = text.length;
    if (!final) {
      const floor = Math.max(0, text.length - LIVE_REDACTION.wordChars);
      let word = text.length;
      while (word > floor && !WHITESPACE.test(text[word - 1])) word -= 1;
      cut = Math.min(text.length - LIVE_REDACTION.holdChars, word);
      if (!chunks.length || chunks[0].end > cut) return;
      if (text.length > SLOW_WINDOW_CHARS && text.length < read + read / 4) return;
    }
    read = text.length;
    const whole = redact(text);
    const safeEnd = final ? whole.length : sharedPrefix(whole, redact(text.slice(0, cut)));
    let consumed = 0;
    while (chunks.length && chunks[0].end <= cut) {
      const chunk = chunks.shift()!;
      let end = Math.min(safeEnd, sharedPrefix(whole, redact(text.slice(0, chunk.end))));
      const last = whole.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      end = Math.max(released, end);
      const piece = whole.slice(released, end);
      released = end;
      consumed = chunk.end;
      chunk.release(() => { if (piece) emit(piece); });
    }
    if (final || (consumed && whole === whole.slice(0, released) + redact(text.slice(consumed)))) {
      text = final ? '' : text.slice(consumed);
      for (const chunk of chunks) chunk.end -= consumed;
      released = 0;
      read = text.length;
    }
  };
  return {
    push(chunk: string) {
      if (text.length + chunk.length > LIVE_REDACTION.pendingChars)
        channel.fail('The live redaction window exceeded its limit.');
      const release = channel.reserve(chunk.length);
      text += chunk;
      chunks.push({ end: text.length, release });
      settle(false);
    },
    flush: () => settle(true),
    drop() {
      for (const chunk of chunks.splice(0)) chunk.release(() => {});
      text = '';
      released = 0;
      read = 0;
    },
  };
}

/** The raw text sink an adapter writes the answer to. */
export interface PreviewSink {
  (raw: string): void;
  /** Shows what is still held back, as the attempt ends; nothing once the signal has aborted. */
  flush(): void;
}

/**
 * The producer half of the preview contract. An adapter-facing raw text sink
 * is wrapped into the caller-facing frame channel: the host stamps the run
 * identity and a dense sequence, applies the caller's redaction before
 * measuring, and treats an over-budget chunk as a contract violation — the
 * chunk is never emitted and the stream is poisoned rather than truncated.
 *
 * With a redaction, the stream is redacted as one piece across chunk
 * boundaries: its newest part is held back (`LIVE_REDACTION`) until more text
 * arrives, or `flush` is
 * called as the attempt ends. A release longer than one frame is split into
 * frames within the budget. Without one, each chunk is one frame, as it comes.
 * A poisoned or stopped stream never shows what it held.
 *
 * `onInvalid` decides who sees the refusal: pass it to collect the rejection
 * (EngineService turns it into an `OUTPUT_LIMIT` failure after the adapter
 * settles); omit it and the violation throws into the producer, which still
 * fails the request but with the transport's own error wording.
 */
export function previewSink(options: {
  readonly identity: {
    readonly projectId: string;
    readonly threadId: string;
    readonly requestId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly attempt: number;
    readonly fence: number;
  };
  readonly redact?: (text: string) => string;
  readonly onPreview?: (frame: TransientPreview) => void;
  readonly onInvalid?: (failure: PreviewRejection) => void;
  /**
   * The request's fence: a frame produced after the caller's signal aborted
   * is stale — dropped before redaction, measuring or emission. No late
   * preview outlives its request.
   */
  readonly signal?: AbortSignal;
  /** The attempt's other live channels, so held text is never overtaken. */
  readonly order?: LiveOrder;
}): PreviewSink {
  let seq = 0;
  let poisoned = false;
  const redact = options.redact;
  const held = redact ? streamRedaction(redact) : undefined;
  /** The frame this text would be. One that breaks the contract poisons the stream. */
  const stamp = (text: string): TransientPreview | null => {
    const parsed = transientPreviewSchema.safeParse({ kind: 'text-delta', ...options.identity, seq: seq + 1, text });
    if (parsed.success) return parsed.data;
    poisoned = true;
    const failure: PreviewRejection = {
      code: 'OUTPUT_LIMIT',
      reason: `A preview frame violated the contract: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    };
    if (options.onInvalid) {
      options.onInvalid(failure);
      return null;
    }
    throw Object.assign(new Error(failure.reason), { code: failure.code });
  };
  const send = (text: string) => {
    const frame = stamp(text);
    if (!frame) return false;
    seq += 1;
    options.onPreview?.(frame);
    return true;
  };
  /** Released text, in frames within the budget. */
  const release = (text: string) => {
    if (poisoned || options.signal?.aborted) return;
    for (const piece of splitBytes(text, OUTPUT_DELTA.maxChunkBytes)) if (!send(piece)) return;
  };
  let ordered: ReturnType<typeof orderedRedaction> | undefined;
  const flush = () => {
    if (ordered) return poisoned || options.signal?.aborted ? ordered.drop() : ordered.flush();
    if (!held) return;
    if (poisoned || options.signal?.aborted) return held.drop();
    release(held.flush());
  };
  const channel = options.order?.join(flush);
  if (redact && channel) ordered = orderedRedaction(redact, channel, release);
  const sink = ((raw: string) => {
    if (poisoned || options.signal?.aborted) return;
    if (!redact || !held) {
      if (channel) channel.reserve(raw.length)(() => { if (!poisoned && !options.signal?.aborted) send(raw); });
      else send(raw);
      return;
    }
    // The adapter's bound is still one chunk, measured after redaction. The chunk then joins the
    // rest of the stream, so a secret split across chunks is redacted whole.
    let clean: string;
    try { clean = redact(raw); } catch (error) {
      poisoned = true;
      ordered?.drop();
      held.drop();
      throw error;
    }
    if (!stamp(clean)) { ordered?.drop(); return held.drop(); }
    if (ordered) {
      try { ordered.push(raw); } catch (error) {
        poisoned = true;
        ordered.drop();
        held.drop();
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'OUTPUT_LIMIT') throw error;
        const failure: PreviewRejection = { code: 'OUTPUT_LIMIT', reason: error.message };
        if (options.onInvalid) options.onInvalid(failure);
        else throw error;
      }
    } else release(held.push(raw));
  }) as PreviewSink;
  sink.flush = flush;
  return sink;
}

// --- live tool activity ----------------------------------------------------------------------

/**
 * What an adapter reports about one tool call as it happens. `summary` is the
 * one plain sentence a person reads ("Reading menu.md", "Searching the web
 * for opening hours"); `detail` is the technical line shown under All details
 * (arguments or a short result excerpt), already free of secrets. `callId`
 * pairs a call's start with its end.
 */
export interface RawToolActivity {
  readonly callId: string;
  readonly phase: 'started' | 'finished' | 'failed';
  readonly tool: string;
  readonly summary: string;
  readonly detail?: string;
}

/**
 * The caller-facing activity frame: a preview like `text-delta`, never
 * persisted, stamped with the same run identity and its own dense sequence.
 * The durable run record stays the authority for what a tool actually did.
 */
export const toolActivitySchema = z.strictObject({
  kind: z.literal('tool-activity'),
  projectId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  stepId: z.string().min(1).max(200),
  attempt: z.number().int().positive(),
  fence: z.number().int().positive(),
  seq: z.number().int().positive(),
  callId: z.string().min(1).max(200),
  phase: z.enum(['started', 'finished', 'failed']),
  tool: z.string().min(1).max(120),
  summary: z.string().min(1).max(300),
  detail: z.string().max(4000).optional(),
});
export type ToolActivity = z.infer<typeof toolActivitySchema>;

/**
 * The producer half for tool activity, the sibling of `previewSink`. It
 * redacts, then trims overlong text rather than failing the run (activity is
 * narration, not the answer), and drops everything once the signal aborts.
 */
export function activitySink(options: {
  readonly identity: {
    readonly projectId: string;
    readonly threadId: string;
    readonly requestId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly attempt: number;
    readonly fence: number;
  };
  readonly redact?: (text: string) => string;
  readonly onActivity?: (frame: ToolActivity) => void;
  readonly signal?: AbortSignal;
  /** The attempt's other live channels: this line waits until earlier text is safe. */
  readonly order?: LiveOrder;
}): (raw: RawToolActivity) => void {
  let seq = 0;
  const channel = options.order?.join(() => undefined);
  const clean = (text: string, max: number) => {
    const redacted = (options.redact ? options.redact(text) : text)
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮]/g, '')
      .trim();
    return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
  };
  return (raw: RawToolActivity) => {
    if (options.signal?.aborted) return;
    const summary = clean(raw.summary || raw.tool, 300);
    const detail = raw.detail === undefined ? undefined : clean(raw.detail, 4000);
    const frame = {
      kind: 'tool-activity' as const,
      ...options.identity,
      seq: seq + 1,
      callId: clean(raw.callId, 200) || `call-${seq + 1}`,
      phase: raw.phase,
      tool: clean(raw.tool, 120) || 'tool',
      summary: summary || 'Using a tool',
      ...(detail ? { detail } : {}),
    };
    const parsed = toolActivitySchema.safeParse(frame);
    if (!parsed.success) return;
    seq += 1;
    const deliver = () => { if (!options.signal?.aborted) options.onActivity?.(parsed.data); };
    if (channel) channel.reserve(JSON.stringify(parsed.data).length)(deliver);
    else deliver();
  };
}

// --- live thinking ---------------------------------------------------------------------------

/** The thinking channel: live frames while it streams, then one finished record for the reply. */
export const REASONING = Object.freeze({
  /** One thinking frame's text budget, in UTF-8 bytes. A longer chunk is split, never refused. */
  maxChunkBytes: 64 * 1024,
  /** The most finished thinking one reply keeps, in UTF-8 bytes. Past it the text is cut and marked. */
  maxSavedBytes: 32 * 1024,
});

/** How much raw thinking a sink holds for the finished record; the saved text is cut far sooner. */
const MAX_RAW_REASONING_CHARS = 4 * REASONING.maxSavedBytes;

/**
 * One live thinking frame: a preview like `text-delta`, stamped with the same run identity and
 * its own dense sequence. Never persisted; the reply keeps one finished record instead.
 */
export const reasoningPreviewSchema = z.strictObject({
  kind: z.literal('reasoning-delta'),
  projectId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  stepId: z.string().min(1).max(200),
  attempt: z.number().int().positive(),
  fence: z.number().int().positive(),
  seq: z.number().int().positive(),
  text: z
    .string()
    .min(1)
    .refine((text) => utf8Bytes(text) <= REASONING.maxChunkBytes, {
      message: `A thinking frame may carry at most ${REASONING.maxChunkBytes} UTF-8 bytes.`,
    }),
});
export type ReasoningPreview = z.infer<typeof reasoningPreviewSchema>;

/** The finished thinking of one reply, as the reply keeps it (`Turn.thinking`). */
export interface ReasoningRecord {
  /** Redacted as one piece, at most `REASONING.maxSavedBytes` UTF-8 bytes. */
  text: string;
  /** From the attempt's start to its last thinking chunk. */
  ms: number;
  /** True when the text was cut to fit. */
  shortened: boolean;
}

/** The adapter-facing raw thinking sink, and the finished record it collected. */
export interface ReasoningSink {
  (raw: string): void;
  /** Shows what is still held back, as the attempt ends; nothing once the signal has aborted. */
  flush(): void;
  /** The finished thinking, or null when none came. Read it once the attempt has ended. */
  finish(): ReasoningRecord | null;
}

/** Control characters and bidirectional overrides. Line breaks and tabs stay. */
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e]/g;

/**
 * The producer half of the thinking channel, the sibling of `activitySink`. Thinking is redacted
 * as one piece across chunk boundaries, as the answer preview is (`previewSink`), then stripped of
 * control characters and split to the frame budget; with no redaction each chunk is sent as it
 * comes. Unlike the answer, thinking never fails anything: a frame that still does not parse is
 * dropped, a presenter or a redaction that throws is ignored, and everything after the signal
 * aborts is dropped, held text included. `finish` gives the whole thinking redacted as one piece,
 * cut to `REASONING.maxSavedBytes`.
 */
export function reasoningSink(options: {
  readonly identity: {
    readonly projectId: string;
    readonly threadId: string;
    readonly requestId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly attempt: number;
    readonly fence: number;
  };
  readonly redact?: (text: string) => string;
  readonly onReasoning?: (frame: ReasoningPreview) => void;
  readonly signal?: AbortSignal;
  /** The attempt's other live channels, so held thinking is never overtaken. */
  readonly order?: LiveOrder;
  /** The clock, replaceable in tests. */
  readonly now?: () => number;
}): ReasoningSink {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let seq = 0;
  let raw = '';
  let overflow = false;
  let poisoned = false;
  let lastAt: number | null = null;
  const clean = (text: string) =>
    (options.redact ? options.redact(text) : text).replace(UNSAFE_CHARACTERS, '');
  const held = options.redact ? streamRedaction(options.redact) : undefined;
  /** Redacted text as frames: stripped, split to the frame budget, and never failing anything. */
  const send = (text: string) => {
    if (poisoned || options.signal?.aborted) return;
    for (const piece of splitBytes(text.replace(UNSAFE_CHARACTERS, ''), REASONING.maxChunkBytes)) {
      const parsed = reasoningPreviewSchema.safeParse({
        kind: 'reasoning-delta',
        ...options.identity,
        seq: seq + 1,
        text: piece,
      });
      if (!parsed.success) continue;
      seq += 1;
      try {
        options.onReasoning?.(parsed.data);
      } catch {
        // Thinking is narration: a presenter's failure never reaches the answer.
      }
    }
  };
  /** What a redaction releases. One that throws shows nothing and fails nothing. */
  const redacted = (release: () => string) => {
    try {
      return release();
    } catch {
      poison();
      return '';
    }
  };
  let ordered: ReturnType<typeof orderedRedaction> | undefined;
  const poison = () => {
    // A later chunk cannot safely restart after its secret prefix was discarded.
    poisoned = true;
    raw = '';
    held?.drop();
    ordered?.drop();
  };
  const flush = () => {
    if (ordered) {
      if (poisoned || options.signal?.aborted) return ordered.drop();
      try { ordered.flush(); } catch { poison(); }
      return;
    }
    if (!held) return;
    if (poisoned || options.signal?.aborted) return held.drop();
    send(redacted(() => held.flush()));
  };
  const channel = options.order?.join(flush, { optional: true });
  if (options.redact && channel) ordered = orderedRedaction(options.redact, channel, send);
  const sink = ((chunk: string) => {
    if (poisoned || options.signal?.aborted || typeof chunk !== 'string' || !chunk) return;
    lastAt = now();
    const room = MAX_RAW_REASONING_CHARS - raw.length;
    if (chunk.length > room) overflow = true;
    if (room > 0) raw += chunk.slice(0, room);
    if (ordered) {
      try { ordered.push(chunk); } catch { poison(); }
    } else if (channel) {
      try { channel.reserve(chunk.length)(() => send(chunk)); } catch { poison(); }
    }
    else send(held ? redacted(() => held.push(chunk)) : chunk);
  }) as ReasoningSink;
  sink.flush = flush;
  sink.finish = () => {
    if (poisoned || lastAt === null) return null;
    const whole = redacted(() => clean(raw)).trim();
    if (!whole) return null;
    const [kept = ''] = splitBytes(whole, REASONING.maxSavedBytes);
    const text = kept.replace(/[\ud800-\udbff]$/, '');
    return {
      text,
      ms: Math.max(0, lastAt - startedAt),
      shortened: overflow || text.length < whole.length,
    };
  };
  return sink;
}

// --- cursor semantics ------------------------------------------------------------------------

/** A position in one run's durable stream. `afterSeq` is the last seen seq. */
export interface EventCursor {
  readonly runId: string;
  readonly afterSeq: number;
}

/** Everything after a cursor — the reconnect/replay read. */
export function eventsAfterCursor(
  events: readonly HarnessEvent[],
  afterSeq: number,
): HarnessEvent[] {
  return events.filter((event) => event.seq > afterSeq);
}

/** The one terminal event, when the stream has ended. */
export function terminalEvent(events: readonly HarnessEvent[]): HarnessEvent | undefined {
  return events.find((event) => isTerminalEventType(event.type));
}

/**
 * The invariants a durable stream must keep. `ok: false` names the first
 * violation at its position; a caller treats a failed stream as evidence of
 * corruption, never as data to tidy.
 */
export function streamIntegrity(
  events: readonly HarnessEvent[],
): { ok: true } | { ok: false; reason: string; at: number } {
  let runId: string | null = null;
  let ended = false;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.seq !== index + 1)
      return {
        ok: false,
        reason: `Sequence ${event.seq} sits where ${index + 1} belongs — a gap or a duplicate.`,
        at: index,
      };
    if (runId === null) runId = event.runId;
    else if (event.runId !== runId)
      return { ok: false, reason: 'An event names a different run.', at: index };
    if (ended)
      return { ok: false, reason: 'An event follows the terminal event.', at: index };
    if (isTerminalEventType(event.type)) ended = true;
  }
  return { ok: true };
}

// --- the route contract descriptor ----------------------------------------------------------

/** Which execution mode a route runs in. */
export const ROUTE_MODES = [
  /** The durable run service drives an agent loop (ModelAdapter). */
  'harness-agent',
  /** A sessionful external agent; Diomedes uses single turns over it. */
  'external-session',
  /** One process or connection per request, text in, text out. */
  'single-turn-text',
  /** An in-process staged worker. */
  'native-worker',
] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

const commandAvailabilitySchema = z.strictObject({
  support: z.enum(['native', 'host', 'unsupported']),
  note: z.string().min(1).max(500),
});
const id = z.string().min(1).max(200);

/**
 * The descriptor every route carries. All ten commands are required keys —
 * an absent answer is not an answer — and no eleventh command may appear.
 * `testedWith` records the historical build covered by fixture evidence.
 * Current execution checks protocol capabilities and records its observed build;
 * a vendor update alone never invalidates a conversation or grants authority.
 */
export const adapterRouteContractSchema = z.strictObject({
  contractVersion: z.literal(ADAPTER_CONTRACT_VERSION),
  routeId: id,
  mode: z.enum(ROUTE_MODES),
  engine: z.strictObject({
    id,
    version: id,
    protocolVersion: z.string().min(1).max(100).nullable(),
  }),
  commands: z.strictObject(
    Object.fromEntries(
      ADAPTER_COMMANDS.map((command) => [command, commandAvailabilitySchema]),
    ) as Record<AdapterCommand, typeof commandAvailabilitySchema>,
  ),
  streaming: z.strictObject({
    transientPreview: z.enum(['text-delta', 'none']),
    /**
     * `reasoning-delta`: the route can stream an engine's thinking as its own preview frames
     * (`reasoningSink`). `none`: it never does, and EngineService never hands it the sink.
     */
    reasoning: z.enum(['reasoning-delta', 'none']),
    /**
     * `run-record` — the run service writes the stream. `host-record` — the
     * caller persists one outcome (History, Need) with no event stream.
     * `none` — nothing durable.
     */
    durableEvents: z.enum(['run-record', 'host-record', 'none']),
  }),
  models: z.strictObject({
    source: z.enum(['runtime-reported', 'fixed', 'none']),
  }),
  authentication: z.enum([
    'native-sign-in',
    'host-credential',
    'development-fixture',
    'none',
  ]),
  testedWith: z.string().min(1).max(100).nullable(),
});
export type AdapterRouteContract = z.infer<typeof adapterRouteContractSchema>;

/** Parse a descriptor, refusing anything that is not the contract shape. */
export function checkAdapterContract(input: unknown): AdapterRouteContract {
  return adapterRouteContractSchema.parse(input);
}

/**
 * The operative half of the contract: what a dispatch must check before it
 * performs a lifecycle command. A descriptor that does not parse is not a
 * contract; a command declared `unsupported` is refused with its own note.
 * `native` and `host` both admit — for `host`, the caller asking is the
 * composition the declaration describes.
 */
export type CommandGate =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly code: 'contract_invalid' | 'command_unsupported';
      readonly reason: string;
    };

export function commandGate(contract: unknown, command: AdapterCommand): CommandGate {
  const parsed = adapterRouteContractSchema.safeParse(contract);
  if (!parsed.success)
    return {
      admitted: false,
      code: 'contract_invalid',
      reason: `The route's descriptor is not a valid contract: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    };
  const answer = parsed.data.commands[command];
  if (answer.support === 'unsupported')
    return {
      admitted: false,
      code: 'command_unsupported',
      reason: `This route declares ${command} unsupported: ${answer.note}`,
    };
  return { admitted: true };
}
