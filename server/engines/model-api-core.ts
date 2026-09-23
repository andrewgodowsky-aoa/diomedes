/**
 * The provider-agnostic half of every model-API route: the guarded streaming
 * transport, the spend reservation around one call, one streamed provider
 * exchange through the Vercel AI SDK, and the cross-check of what the SDK read
 * against what the provider actually sent.
 *
 * Each route supplies a small binding: its explicit SDK provider instance, the
 * one URL its credential may reach, how the credential is attached, what the
 * request body must and must not carry, and how its raw stream is classified.
 * Nothing here chooses a provider, a key or a model by itself: there is no
 * bare model string, no ambient environment key, no SDK retry, no SDK tool
 * executor and no fallback from one route (and one payer) to another.
 *
 * One call is one `streamText` step with `maxRetries: 0` and descriptor-only
 * tools. Text deltas go to an adapter-facing raw sink as they arrive; a tool
 * call the model emits is announced once as `started`. Neither is the answer:
 * the answer is accepted only after the provider's terminal event is
 * classified and its usage settled on the ledger.
 */
import { jsonSchema, stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { RawToolActivity } from '../../shared/adapter-contract.js';
import type { Json, ToolDescriptor } from '../../shared/harness.js';
import { HarnessError } from '../harness/policy.js';
import { readToolSummary } from '../harness/capabilities/read-scope-tools.js';
import { normalizeUsage } from '../../shared/usage-contract.js';
import { secretScrubber } from '../secrets.js';
import {
  ceilingCost,
  type ExposureAttempt,
  type ExposureReservation,
  type ModelRateCard,
  type ProviderUsage,
  type SpendExposure,
} from '../spend-exposure.js';

// --- errors -----------------------------------------------------------------------

/**
 * A refused or failed model-API call. `dispatched` is the fact that matters to
 * recovery: false means the request provably never left this process.
 */
export class ModelApiError extends HarnessError {
  constructor(
    code: string,
    message: string,
    readonly dispatched: boolean,
    readonly evidence: {
      reservation?: Pick<ExposureReservation, 'id' | 'state' | 'maxMicroUsd' | 'settledMicroUsd'> | null;
      status?: number | null;
      providerRequestId?: string | null;
      responseId?: string | null;
      partialText?: string | null;
    } = {},
  ) {
    super(code, message);
    this.name = 'ModelApiError';
  }
}

// --- the guarded streaming transport ----------------------------------------------

/**
 * What the transport saw, kept for classification. Bounded; the body is parsed
 * data, never executed. A streamed body is kept as its parsed SSE `data:`
 * events; a plain JSON body (an error answer) as `body`.
 */
export interface StreamEnvelope {
  status: number;
  bytes: number;
  /** The whole body parsed as JSON, when it was JSON rather than a stream. */
  body: unknown;
  /** Each SSE `data:` payload, parsed, in order. Null when the body was not an event stream. */
  events: unknown[] | null;
  /** False when some part of the body could not be parsed. */
  readable: boolean;
  providerRequestId: string | null;
}

/** Reads an event stream's `data:` payloads. `[DONE]` ends it; anything unparsable marks it unreadable. */
export function parseEventStream(text: string): { events: unknown[]; readable: boolean } {
  const events: unknown[] = [];
  let readable = true;
  for (const block of text.replace(/\r\n?/g, '\n').split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      readable = false;
    }
  }
  return { events, readable };
}

export interface GuardedFetchOptions {
  /** The route's error-code prefix: `aws`, `azure`, `openrouter`. */
  prefix: string;
  /** The provider as a person reads it in a message: `AWS`, `Azure`, `OpenRouter`. */
  label: string;
  /** The one URL (origin and path, no query) the credential may reach. */
  expectedUrl: string;
  /**
   * The exact query string that URL must carry, `?` included (Vertex streams only with
   * `?alt=sse`). Empty, the default, refuses any query at all.
   */
  expectedQuery?: string;
  secret: string;
  /** Replaces whatever credential header the SDK set with the real one. */
  attach(headers: Headers, secret: string): void;
  /** Last check of the serialized request before it leaves; throws a `ModelApiError` to refuse it. */
  inspectBody?(body: string): void;
  requestIdHeaders: readonly string[];
  maxRequestBytes: number;
  maxResponseBytes: number;
  signal: AbortSignal;
  transport?: typeof globalThis.fetch;
  onDispatch: () => void;
  /**
   * The last admission before bytes leave, awaited after every other check: a funded route
   * commits its dispatch here and re-checks that the payer still allows the send. Throwing
   * refuses the call with nothing sent.
   */
  beforeDispatch?: () => Promise<void>;
  onEnvelope: (envelope: StreamEnvelope) => void;
  /** A refusal the transport raised after dispatch, recorded even when the SDK wraps or swallows it. */
  onFailure?: (error: ModelApiError) => void;
}

/**
 * The only fetch an SDK provider is given. It checks the exact destination,
 * method and size, attaches the credential only then, refuses redirects, and
 * passes the response through as it streams while keeping a bounded copy. The
 * copy is parsed when the stream ends, before the SDK sees its end, so
 * classification never depends on what the SDK's schema happens to accept.
 */
export function guardedStreamFetch(options: GuardedFetchOptions): typeof globalThis.fetch {
  const expected = new URL(options.expectedUrl);
  const { prefix, label } = options;
  const refuse = (error: ModelApiError) => {
    options.onFailure?.(error);
    return error;
  };
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.search !== (options.expectedQuery ?? '') ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new ModelApiError(
        `${prefix}_destination_refused`,
        `The model request was addressed somewhere other than the approved ${label} endpoint. Nothing was sent.`,
        false,
      );
    if ((init?.method ?? 'GET').toUpperCase() !== 'POST' || typeof init?.body !== 'string')
      throw new ModelApiError(`${prefix}_request_refused`, 'Only one JSON POST is allowed on this route.', false);
    if (Buffer.byteLength(init.body) > options.maxRequestBytes)
      throw new ModelApiError(
        `${prefix}_input_too_large`,
        'This request is larger than the route allows. Nothing was sent.',
        false,
      );
    options.inspectBody?.(init.body);
    options.signal.throwIfAborted();
    if (options.beforeDispatch) {
      try {
        await options.beforeDispatch();
      } catch (error) {
        throw refuse(
          error instanceof ModelApiError && !error.dispatched
            ? error
            : new ModelApiError(
                `${prefix}_dispatch_refused`,
                `${error instanceof Error ? error.message : 'The payer refused this call.'} Nothing was sent.`,
                false,
              ),
        );
      }
      options.signal.throwIfAborted();
    }
    const headers = new Headers(init.headers);
    // The SDK was given a placeholder key; the real credential is attached here, after the checks.
    options.attach(headers, options.secret);
    headers.set('content-type', 'application/json');
    options.onDispatch();
    const response = await (options.transport ?? globalThis.fetch)(url, {
      method: 'POST',
      headers,
      body: init.body,
      redirect: 'error',
      signal: init.signal ?? options.signal,
    });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw refuse(
        new ModelApiError(
          `${prefix}_redirect_refused`,
          `${label} answered with a redirect, which this route never follows.`,
          true,
          { status: response.status },
        ),
      );
    }
    // A stop can land while the response is on its way in, before anything below subscribes.
    if (options.signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      options.signal.throwIfAborted();
    }
    const providerRequestId =
      options.requestIdHeaders.map((name) => response.headers.get(name)).find((value) => !!value) ?? null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const finish = () => {
      const bytes = Buffer.concat(chunks);
      const text = bytes.toString('utf8');
      let body: unknown = null;
      let events: unknown[] | null = null;
      let readable = false;
      try {
        body = JSON.parse(text);
        readable = true;
      } catch {
        const parsed = parseEventStream(text);
        if (parsed.events.length) {
          events = parsed.events;
          readable = parsed.readable;
        }
      }
      options.onEnvelope({ status: response.status, bytes: bytes.byteLength, body, events, readable, providerRequestId });
    };
    if (!response.body) {
      finish();
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    const guard = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > options.maxResponseBytes)
          throw refuse(
            new ModelApiError(
              `${prefix}_output_too_large`,
              `The ${label} response exceeded this route’s size limit.`,
              true,
              { status: response.status },
            ),
          );
        chunks.push(chunk);
        controller.enqueue(chunk);
      },
      // Runs before the reader sees the end of the stream, so the envelope is always
      // recorded before the SDK can report the call finished.
      flush() {
        if (options.signal.aborted) return;
        finish();
      },
    });
    return new Response(response.body.pipeThrough(guard, { signal: options.signal }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

// --- classification ---------------------------------------------------------------

/** What one exchange said, read from the provider's own bytes. Nothing in it can widen what a route does. */
export interface ClassifiedEnvelope {
  status: string | null;
  responseId: string | null;
  reportedModel: string | null;
  usage: ProviderUsage | null;
  text: string;
  refusal: string | null;
  functionCalls: { callId: string; name: string; arguments: string }[];
  unexpectedItems: string[];
  incompleteReason: string | null;
  providerError: { code: string | null; message: string } | null;
  /** Which upstream served the call, when the route reports it (OpenRouter). Evidence only. */
  servedBy?: string | null;
  /** True when the provider says the call was billed to a key other than the connection's own. */
  otherPayer?: boolean;
}

export const bounded = (text: string, max = 2_000) => (text.length > max ? `${text.slice(0, max)}…` : text);
export const str = (value: unknown) => (typeof value === 'string' ? value : null);

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const responsesUsageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  input_tokens_details: z
    .object({ cached_tokens: count.nullish(), cache_write_tokens: count.nullish() })
    .nullish(),
  output_tokens_details: z.object({ reasoning_tokens: count.nullish() }).nullish(),
});

/**
 * A route's mapping into the five counts, through the `nectovia-usage/1`
 * boundary (`shared/usage-contract.ts`). Usage whose parts do not add up, or
 * that is missing a count, is null: any repair would be a guess about money.
 */
export function consistentUsage(usage: ProviderUsage): ProviderUsage | null {
  const evidence = normalizeUsage(usage);
  if (evidence.state !== 'known') return null;
  const { contract: _contract, raw: _raw, ...counts } = evidence.usage;
  return counts;
}

/** Responses usage in the ledger's structure: cache reads and writes and reasoning stay distinct. */
export function providerUsage(raw: unknown): ProviderUsage | null {
  const parsed = responsesUsageSchema.safeParse(raw);
  if (!parsed.success) return null;
  return consistentUsage({
    inputTokens: parsed.data.input_tokens,
    cacheReadTokens: parsed.data.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: parsed.data.input_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: parsed.data.output_tokens,
    reasoningTokens: parsed.data.output_tokens_details?.reasoning_tokens ?? 0,
  });
}

/** Reads a Responses object as data. Nothing in it can widen what the route will do. */
export function classifyEnvelope(body: unknown): ClassifiedEnvelope {
  const object = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const result: ClassifiedEnvelope = {
    status: str(object.status),
    responseId: str(object.id) || null,
    reportedModel: str(object.model) || null,
    usage: providerUsage(object.usage),
    text: '',
    refusal: null,
    functionCalls: [],
    unexpectedItems: [],
    incompleteReason: null,
    providerError: null,
  };
  const incomplete = object.incomplete_details as { reason?: unknown } | null | undefined;
  result.incompleteReason = str(incomplete?.reason);
  const error = object.error as { code?: unknown; message?: unknown } | null | undefined;
  if (error && typeof error === 'object')
    result.providerError = { code: str(error.code), message: bounded(str(error.message) ?? 'Unknown provider error.') };
  const output = Array.isArray(object.output) ? object.output : [];
  for (const item of output) {
    const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    switch (entry.type) {
      case 'reasoning':
        break;
      case 'message': {
        const content = Array.isArray(entry.content) ? entry.content : [];
        for (const part of content) {
          const piece = part && typeof part === 'object' ? (part as Record<string, unknown>) : {};
          if (piece.type === 'output_text' && typeof piece.text === 'string') result.text += piece.text;
          else if (piece.type === 'refusal')
            result.refusal ??= bounded(str(piece.refusal) ?? 'The model declined.');
          else result.unexpectedItems.push(`message:${String(piece.type)}`);
        }
        break;
      }
      case 'function_call': {
        // Only a direct, synchronous, un-namespaced call to an offered function is a tool
        // request here. Program-driven, asynchronous or namespaced calls are other contracts.
        const caller = entry.caller as { type?: unknown } | null | undefined;
        if ((caller != null && caller.type !== 'direct') || entry.async === true || entry.namespace != null) {
          result.unexpectedItems.push('function_call:non-direct');
          break;
        }
        result.functionCalls.push({
          callId: str(entry.call_id) ?? '',
          name: str(entry.name) ?? '',
          arguments: str(entry.arguments) ?? '',
        });
        break;
      }
      default:
        result.unexpectedItems.push(String(entry.type));
    }
  }
  return result;
}

const RESPONSES_TERMINAL = new Set(['response.completed', 'response.incomplete', 'response.failed']);

/**
 * The body a Responses envelope is classified from. A streamed answer is read
 * from its terminal event, which carries the whole response: output, usage,
 * status, id and model. An `error` event stands for the provider's error body.
 * A stream with no terminal event is not a readable answer.
 */
export function responsesBody(envelope: StreamEnvelope): { readable: boolean; body: unknown } {
  if (!envelope.readable) return { readable: false, body: null };
  if (!envelope.events) return { readable: true, body: envelope.body };
  let terminal: unknown = null;
  let error: Record<string, unknown> | null = null;
  for (const event of envelope.events) {
    const value = event && typeof event === 'object' ? (event as Record<string, unknown>) : {};
    if (typeof value.type === 'string' && RESPONSES_TERMINAL.has(value.type)) terminal = value.response ?? null;
    else if (value.type === 'error') error ??= value;
  }
  if (terminal && typeof terminal === 'object') return { readable: true, body: terminal };
  if (error) return { readable: true, body: { error: { code: str(error.code), message: str(error.message) } } };
  return { readable: false, body: null };
}

/** The usage a failed call can still be settled from, read from whatever the envelope holds. */
export function responsesUsage(envelope: StreamEnvelope): ProviderUsage | null {
  const { readable, body } = responsesBody(envelope);
  return readable ? providerUsage((body as { usage?: unknown } | null)?.usage) : null;
}

// --- tool activity ----------------------------------------------------------------

const quoted = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The one plain sentence a person reads while a tool call runs. It names the
 * file or subject from the arguments when the tool has one, and never shows
 * raw JSON: `detail` carries the arguments for All details.
 */
export function toolSummary(name: string, input: unknown): string {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const read = readToolSummary(name, input);
  if (read) return read;
  const target = quoted(args.path) ?? quoted(args.file) ?? quoted(args.name);
  switch (name) {
    case 'read_source':
      return target ? `Reading ${target}` : 'Reading an attached file';
    case 'list_sources':
      return 'Listing the attached files';
    default: {
      const words = name.replace(/[_-]+/g, ' ').trim() || 'a tool';
      return target ? `Using ${words} on ${target}` : `Using ${words}`;
    }
  }
}

const argumentDetail = (input: unknown) => {
  try {
    return bounded(JSON.stringify(input) ?? '', 1_000);
  } catch {
    return undefined;
  }
};

// --- one call -----------------------------------------------------------------------

export interface RespondLimits {
  maxOutputTokens: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  /** Enforced here, per call, because the run budget's wallMs is recorded, not enforced. */
  callWallMs: number;
}
export const CONVERSATION_LIMITS: RespondLimits = {
  maxOutputTokens: 4_096,
  maxRequestBytes: 200_000,
  maxResponseBytes: 1_048_576,
  callWallMs: 120_000,
};
export const WORK_LIMITS: RespondLimits = {
  maxOutputTokens: 16_384,
  maxRequestBytes: 400_000,
  maxResponseBytes: 2_097_152,
  callWallMs: 240_000,
};

export type RespondOutcome =
  | { kind: 'final'; text: string }
  | { kind: 'tool'; callId: string; name: string; input: Json };

export interface RespondResult {
  outcome: RespondOutcome;
  usage: ProviderUsage;
  reportedModel: string | null;
  responseId: string | null;
  providerRequestId: string | null;
  /** The SDK's provider-format messages for this exchange: private continuation state. */
  responseMessages: ModelMessage[];
  reservation: ExposureReservation;
  warnings: number;
  /** Which upstream served the call, when the route reports it. Evidence only. */
  servedBy?: string | null;
}

/** The input-token ceiling a request can reach, from its bytes: a token never covers less than one byte. */
export function inputTokenBound(bytes: number, messages: number) {
  return bytes + 1_024 + messages * 16;
}

/** The adapter-facing raw sinks a streamed call feeds. Both are previews; neither is the answer. */
export interface StreamSinks {
  onDelta?: (text: string) => void;
  onToolActivity?: (raw: RawToolActivity) => void;
}

/**
 * The ledger one call is held on. The local `SpendExposure` is the owner's own
 * cap; a managed route passes a funded ledger that also holds the customer's
 * parent-job credits. `beforeDispatch`, when present, is awaited once, after
 * every request check and immediately before the bytes leave.
 */
export type CallExposure = Pick<SpendExposure, 'reserve' | 'settle' | 'release' | 'markUncertain'> & {
  beforeDispatch?(reservation: ExposureReservation): Promise<void>;
};

/** What one route contributes to a call. Everything else is the same for every route. */
export interface RouteBinding {
  route: string;
  prefix: string;
  label: string;
  /** The ledger connection this call is held against. */
  connectionId: string;
  /** The logical model the rate card prices. */
  modelId: string;
  expiresAt: string | null;
  /** The explicit SDK model instance, built on the guarded fetch it is handed. */
  model(fetch: typeof globalThis.fetch): LanguageModel;
  /** The guarded transport's route-specific parts. */
  guard: Pick<GuardedFetchOptions, 'expectedUrl' | 'expectedQuery' | 'attach' | 'inspectBody' | 'requestIdHeaders'>;
  providerOptions: Record<string, Record<string, unknown>>;
  /** Reads a finished envelope. `readable: false` when it holds no complete answer. */
  classify(envelope: StreamEnvelope): { readable: boolean; classified: ClassifiedEnvelope | null };
  /** The usage a failed call can still be settled from. */
  usage(envelope: StreamEnvelope): ProviderUsage | null;
  /** Route-specific refusal of a classified answer (served by another endpoint, model or payer). */
  served?(classified: ClassifiedEnvelope): { code: string; message: string } | null;
  /** Provider statuses whose readable error body means nothing was inferred. */
  releasableStatuses?: ReadonlySet<number>;
}

const RELEASABLE_STATUSES = new Set([400, 401, 403, 404, 413, 422, 429]);
export const CREDENTIAL_PLACEHOLDER = 'diomedes-guarded-credential';

/** Descriptor-only tools: no `execute`, so the SDK can never run one. */
function descriptorTools(prefix: string, descriptors: readonly ToolDescriptor[]): ToolSet {
  const tools: ToolSet = {};
  if (descriptors.length > 16)
    throw new ModelApiError(`${prefix}_invalid_tools`, 'This call offers too many tools.', false);
  for (const descriptor of descriptors) {
    const schema = descriptor.inputSchema as Record<string, unknown> | null;
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(descriptor.name) ||
      Object.hasOwn(tools, descriptor.name) ||
      !schema ||
      typeof schema !== 'object' ||
      Array.isArray(schema) ||
      schema.type !== 'object'
    )
      throw new ModelApiError(
        `${prefix}_invalid_tools`,
        'Each offered tool needs a unique function name and an object schema.',
        false,
      );
    Object.defineProperty(tools, descriptor.name, {
      enumerable: true,
      value: {
        description: descriptor.description,
        inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
      },
    });
  }
  return tools;
}

/**
 * One provider exchange: reserve, stream once, classify, settle. Never retried.
 * Throws `ModelApiError` for everything that is not a complete, valid answer or
 * a single, offered tool call.
 */
export async function respondStream(input: {
  binding: RouteBinding;
  secret: string;
  card: ModelRateCard;
  exposure: CallExposure;
  attempt: ExposureAttempt;
  instructions: string;
  messages: ModelMessage[];
  tools: readonly ToolDescriptor[];
  limits: RespondLimits;
  signal: AbortSignal;
  transport?: typeof globalThis.fetch;
  now?: () => Date;
} & StreamSinks): Promise<RespondResult> {
  const { binding } = input;
  const { prefix, label } = binding;
  const now = input.now ?? (() => new Date());
  const scrub = secretScrubber([input.secret]);
  if (input.card.route !== binding.route || input.card.modelId !== binding.modelId)
    throw new ModelApiError(`${prefix}_rate_card_mismatch`, 'No rate card is approved for this model.', false);
  if (binding.expiresAt && Date.parse(binding.expiresAt) <= now().getTime() + 60_000)
    throw new ModelApiError(
      `${prefix}_credential_expired`,
      `The saved ${label} key has expired or is about to. A pasted short-term key does not renew itself; enter a new one in AI setup.`,
      false,
    );
  const tools = descriptorTools(prefix, input.tools);
  const estimateBytes = Buffer.byteLength(
    JSON.stringify({ instructions: input.instructions, messages: input.messages, tools: input.tools }),
  );
  if (estimateBytes > input.limits.maxRequestBytes)
    throw new ModelApiError(
      `${prefix}_input_too_large`,
      'The conversation and its sources are larger than this route allows. Nothing was sent.',
      false,
    );
  const maxInputTokens = inputTokenBound(estimateBytes, input.messages.length + 1);
  const ceiling = ceilingCost(input.card, {
    maxInputTokens,
    maxOutputTokens: input.limits.maxOutputTokens,
  });
  let reservation: ExposureReservation;
  try {
    reservation = await input.exposure.reserve({
      connectionId: binding.connectionId,
      route: binding.route,
      modelId: binding.modelId,
      card: input.card,
      attempt: input.attempt,
      maxMicroUsd: ceiling,
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'spend_refused';
    const message = error instanceof Error ? error.message : 'The spend limit refused this call.';
    throw new ModelApiError(
      code === 'attempt_exists' ? `${prefix}_attempt_exists` : `${prefix}_spend_refused`,
      code === 'attempt_exists'
        ? 'This exact call was already attempted. It is never sent twice; check the run before continuing.'
        : `${message} Nothing was sent.`,
      false,
    );
  }
  let dispatched = false;
  let envelope: StreamEnvelope | null = null;
  let transportError: ModelApiError | null = null;
  const wall = AbortSignal.timeout(input.limits.callWallMs);
  const signal = AbortSignal.any([input.signal, wall]);
  const started: { callId: string; tool: string }[] = [];
  const evidence = () => ({
    reservation: {
      id: reservation.id,
      state: reservation.state,
      maxMicroUsd: reservation.maxMicroUsd,
      settledMicroUsd: reservation.settledMicroUsd,
    },
    status: envelope?.status ?? null,
    providerRequestId: envelope?.providerRequestId ?? null,
  });
  const activity = (raw: RawToolActivity) => {
    try {
      input.onToolActivity?.(raw);
    } catch {
      // Narration never decides a call's outcome.
    }
  };
  /**
   * Settle from reported usage. A settle the ledger refuses or cannot persist leaves
   * the hold uncertain, never pending and never zero; a hold even that cannot
   * record is left for the startup sweep, which parks every pending hold.
   */
  const settleOrLose = async (usage: ProviderUsage, why: string) => {
    try {
      reservation = await input.exposure.settle(reservation.id, {
        usage,
        card: input.card,
        providerRequestId: envelope?.providerRequestId ?? null,
      });
      return true;
    } catch {
      try {
        reservation = await input.exposure.markUncertain(
          reservation.id,
          `Sent, and ${label} reported usage, but it could not be recorded (${why}). The cost is unknown until reconciled.`,
        );
      } catch {
        // The sweep at the next start turns this pending hold uncertain.
      }
      return false;
    }
  };
  /** Resolves the hold from what is known, then throws. Missing usage is never zero. */
  const fail = async (
    code: string,
    message: string,
    extra: { partialText?: string | null; responseId?: string | null } = {},
  ): Promise<never> => {
    // A tool call the model announced is never run once its answer is refused.
    for (const call of started)
      activity({ callId: call.callId, phase: 'failed', tool: call.tool, summary: `Not run: ${call.tool}` });
    const usage = envelope ? binding.usage(envelope) : null;
    const releasable = binding.releasableStatuses ?? RELEASABLE_STATUSES;
    try {
      if (!dispatched) reservation = await input.exposure.release(reservation.id, `Not sent: ${code}.`);
      else if (usage) await settleOrLose(usage, code);
      else if (envelope && releasable.has(envelope.status) && envelope.readable)
        // A provider rejection with an error body is a refusal before inference, not a lost answer.
        reservation = await input.exposure.release(
          reservation.id,
          `${label} refused the request with HTTP ${envelope.status}.`,
        );
      else
        reservation = await input.exposure.markUncertain(
          reservation.id,
          `Sent, but no usage came back (${code}). The cost is unknown until reconciled.`,
        );
    } catch {
      // A hold that cannot be resolved stays pending on disk; the startup sweep parks it
      // uncertain. The call's own failure is still the one reported.
    }
    throw new ModelApiError(code, scrub(message), dispatched, { ...evidence(), ...extra });
  };

  let sdk: {
    text: string;
    toolCalls: { toolCallId: string; toolName: string; invalid?: boolean }[];
    messages: ModelMessage[];
    warnings: number;
  } | null = null;
  let sdkError: unknown = null;
  try {
    const fetch = guardedStreamFetch({
      prefix,
      label,
      ...binding.guard,
      secret: input.secret,
      maxRequestBytes: input.limits.maxRequestBytes,
      maxResponseBytes: input.limits.maxResponseBytes,
      signal,
      transport: input.transport,
      ...(input.exposure.beforeDispatch
        ? { beforeDispatch: () => input.exposure.beforeDispatch!(reservation) }
        : {}),
      onDispatch: () => {
        dispatched = true;
      },
      onEnvelope: (value) => {
        envelope = value;
      },
      onFailure: (error) => {
        transportError ??= error;
      },
    });
    const offered = new Set(input.tools.map((tool) => tool.name));
    const result = streamText({
      model: binding.model(fetch),
      system: input.instructions,
      messages: input.messages,
      tools,
      toolChoice: 'auto',
      maxOutputTokens: input.limits.maxOutputTokens,
      maxRetries: 0,
      stopWhen: stepCountIs(1),
      abortSignal: signal,
      providerOptions: binding.providerOptions as never,
      onError: ({ error }) => {
        sdkError ??= error;
      },
    });
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        if (part.text && !signal.aborted)
          try {
            input.onDelta?.(part.text);
          } catch {
            // The preview sink records its own contract failures.
          }
      } else if (part.type === 'tool-call') {
        if (part.invalid || !offered.has(part.toolName) || signal.aborted) continue;
        started.push({ callId: part.toolCallId, tool: part.toolName });
        activity({
          callId: part.toolCallId,
          phase: 'started',
          tool: part.toolName,
          summary: toolSummary(part.toolName, part.input),
          detail: argumentDetail(part.input),
        });
      } else if (part.type === 'error') sdkError ??= part.error;
    }
    if (!sdkError) {
      const [text, toolCalls, response, warnings] = await Promise.all([
        result.text,
        result.toolCalls,
        result.response,
        result.warnings,
      ]);
      sdk = {
        text,
        toolCalls: toolCalls.map((call) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          invalid: 'invalid' in call && call.invalid === true,
        })),
        messages: structuredClone(response.messages) as ModelMessage[],
        warnings: warnings?.length ?? 0,
      };
    }
  } catch (error) {
    sdkError ??= error;
  }
  if (!dispatched) {
    const refusedEarly = transportError as ModelApiError | null;
    if (refusedEarly) return fail(refusedEarly.code, refusedEarly.message);
    if (sdkError instanceof ModelApiError) return fail(sdkError.code, sdkError.message);
    return fail(`${prefix}_request_not_prepared`, 'The model request could not be prepared. Nothing was sent.');
  }
  if (signal.aborted && !envelope)
    return fail(
      wall.aborted ? `${prefix}_timeout` : `${prefix}_cancelled`,
      wall.aborted
        ? `${label} did not answer within this route’s time limit. The request was sent; its cost is unknown until reconciled.`
        : `Stopped after the request was sent. ${label} may still have processed it; its cost is unknown until reconciled.`,
    );
  const refused = transportError as ModelApiError | null;
  if (refused) return fail(refused.code, refused.message);
  if (!envelope)
    return fail(
      sdkError instanceof ModelApiError ? sdkError.code : `${prefix}_unknown_outcome`,
      'The request was sent but no complete answer came back. Check this run before retrying.',
    );
  const seen = envelope as StreamEnvelope;
  if (signal.aborted)
    return fail(
      wall.aborted ? `${prefix}_timeout` : `${prefix}_cancelled`,
      `Stopped after ${label} answered. The answer was not used; its reported usage is recorded.`,
    );
  const read = binding.classify(seen);
  if (!read.readable || !read.classified)
    return fail(
      `${prefix}_unreadable_response`,
      `${label} returned a response Diomedes could not read. Nothing from it was used.`,
    );
  const classified = read.classified;
  const partialText = classified.text ? bounded(classified.text) : null;
  const common = { responseId: classified.responseId };
  if (seen.status >= 400 || classified.providerError)
    return fail(
      seen.status >= 500 ? `${prefix}_provider_error` : `${prefix}_provider_refused`,
      `${label} returned an error${classified.providerError?.message ? `: ${classified.providerError.message}` : '.'}`,
      common,
    );
  if (classified.status === 'incomplete')
    return fail(
      classified.incompleteReason === 'content_filter' ? `${prefix}_refused` : `${prefix}_incomplete_output`,
      classified.incompleteReason === 'max_output_tokens'
        ? 'The answer stopped at the output limit before it was complete. The partial text is kept as evidence, not as an answer.'
        : `${label} stopped before the answer was complete (${classified.incompleteReason ?? 'no reason given'}).`,
      { ...common, partialText },
    );
  if (classified.status !== 'completed')
    return fail(
      `${prefix}_not_completed`,
      `${label} reported the response as ${classified.status ?? 'unknown'}, not completed.`,
      common,
    );
  if (classified.refusal)
    return fail(`${prefix}_refused`, 'The model declined this request.', { ...common, partialText: classified.refusal });
  if (classified.unexpectedItems.length)
    return fail(
      `${prefix}_unexpected_output`,
      `${label} returned output this route does not accept. Nothing from it was used.`,
      common,
    );
  if (classified.functionCalls.length > 1)
    return fail(
      `${prefix}_multiple_tools`,
      'The model asked for more than one tool at once. None of them were run.',
      common,
    );
  if (!classified.usage)
    return fail(
      `${prefix}_usage_missing`,
      `${label} did not report usage for a completed answer. Its cost is unknown until reconciled.`,
      common,
    );
  const served = binding.served?.(classified);
  if (served) return fail(served.code, served.message, common);
  if (sdkError || !sdk)
    return fail(
      `${prefix}_invalid_output`,
      `The ${label} answer did not pass the SDK’s own validation. Nothing from it was used.`,
      common,
    );
  const read_ = sdk as NonNullable<typeof sdk>;
  let outcome: RespondOutcome;
  const call = classified.functionCalls[0];
  if (call) {
    const offered = input.tools.some((tool) => tool.name === call.name);
    const sdkCall = read_.toolCalls[0];
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments);
    } catch {
      parsed = undefined;
    }
    if (
      !offered ||
      !call.callId ||
      read_.toolCalls.length !== 1 ||
      sdkCall.invalid === true ||
      sdkCall.toolCallId !== call.callId ||
      sdkCall.toolName !== call.name ||
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    )
      return fail(
        `${prefix}_invalid_tool`,
        'The model named a tool call this turn did not offer, or its arguments were malformed. It was not run.',
        common,
      );
    outcome = { kind: 'tool', callId: call.callId, name: call.name, input: z.json().parse(parsed) as Json };
  } else {
    if (!classified.text.trim()) return fail(`${prefix}_empty_output`, `${label} returned no answer.`, common);
    if (read_.toolCalls.length || read_.text !== classified.text)
      return fail(
        `${prefix}_invalid_output`,
        `The SDK’s reading of the answer differs from ${label}’s response. Nothing was used.`,
        common,
      );
    outcome = { kind: 'final', text: classified.text };
  }
  if (!(await settleOrLose(classified.usage, 'settle refused'))) {
    for (const started_ of started)
      activity({ callId: started_.callId, phase: 'failed', tool: started_.tool, summary: `Not run: ${started_.tool}` });
    // Fail closed: an answer whose cost is not on the ledger is not used.
    throw new ModelApiError(
      `${prefix}_usage_unrecorded`,
      `${label} answered, but Diomedes could not record what it cost. The answer was not used; the call is held as uncertain.`,
      true,
      { ...evidence(), responseId: classified.responseId },
    );
  }
  return {
    outcome,
    usage: classified.usage,
    reportedModel: classified.reportedModel,
    responseId: classified.responseId,
    providerRequestId: seen.providerRequestId,
    responseMessages: read_.messages,
    reservation,
    warnings: read_.warnings,
    ...(classified.servedBy !== undefined ? { servedBy: classified.servedBy } : {}),
  };
}

// --- owner-declared rate cards ------------------------------------------------------

/**
 * List prices the owner declared at setup for one model, in whole micro-USD
 * per million tokens. Input and output must be more than zero: an unknown or
 * zero price is never treated as free. Cached input defaults to the full input
 * price, which can only overstate a call.
 */
export const declaredRatesSchema = z.strictObject({
  input: z.number().int().positive().max(1_000_000_000),
  output: z.number().int().positive().max(1_000_000_000),
  cacheRead: z.number().int().nonnegative().max(1_000_000_000).nullable(),
  cacheWrite: z.number().int().nonnegative().max(1_000_000_000).nullable(),
  /** Where the owner read these figures. */
  source: z.string().trim().min(1).max(300),
  declaredAt: z.string().datetime({ offset: true }),
});
export type DeclaredRates = z.infer<typeof declaredRatesSchema>;

/** A declared price as the ledger's card. One band: the owner declares no long-context price. */
export function declaredRateCard(route: string, modelId: string, rates: DeclaredRates, version: string): ModelRateCard {
  const band = {
    input: rates.input,
    output: rates.output,
    cacheRead: rates.cacheRead ?? rates.input,
    cacheWrite: rates.cacheWrite ?? rates.input,
  };
  return {
    version,
    route,
    modelId,
    source: `Declared by the owner at setup: ${rates.source} (${rates.declaredAt}). Estimate only, never an invoice.`,
    shortContextMaxInputTokens: 10_000_000,
    short: band,
    long: band,
  };
}
