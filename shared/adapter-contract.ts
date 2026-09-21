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

/**
 * The producer half of the preview contract. An adapter-facing raw text sink
 * is wrapped into the caller-facing frame channel: the host stamps the run
 * identity and a dense sequence, applies the caller's redaction before
 * measuring, and treats an over-budget frame as a contract violation — the
 * frame is never emitted and the stream is poisoned rather than truncated.
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
}): (text: string) => void {
  let seq = 0;
  let poisoned = false;
  return (raw: string) => {
    if (poisoned || options.signal?.aborted) return;
    seq += 1;
    const text = options.redact ? options.redact(raw) : raw;
    const frame: TransientPreview = {
      kind: 'text-delta',
      ...options.identity,
      seq,
      text,
    };
    const parsed = transientPreviewSchema.safeParse(frame);
    if (!parsed.success) {
      poisoned = true;
      const failure: PreviewRejection = {
        code: 'OUTPUT_LIMIT',
        reason: `A preview frame violated the contract: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      };
      if (options.onInvalid) {
        options.onInvalid(failure);
        return;
      }
      throw Object.assign(new Error(failure.reason), { code: failure.code });
    }
    options.onPreview?.(parsed.data);
  };
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
 * `testedWith` is the exact version the conformance evidence covers; a
 * version change invalidates the proof rather than stretching it.
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
