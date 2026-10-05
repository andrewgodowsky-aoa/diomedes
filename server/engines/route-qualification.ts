/**
 * Route checks: a bounded, owner-run set of small live calls through one model-API route's own
 * binding, recorded as a receipt (`shared/route-qualification.ts`). The receipt is what lets a
 * model that needs one (Kimi K3 on the direct AWS route) send on this exact connection revision,
 * model, protocol and rate card; for every other model it is evidence only.
 *
 * Each call is an ordinary `respondStream` exchange on the route's own binding, credential and
 * spend ledger: reserved before it leaves, settled from the usage the provider reports, released
 * when nothing was sent, uncertain when nobody knows. The prompts are fixed and carry no person's
 * content. What a call observed reaches the receipt as identifiers, counts and states through the
 * exchange's observer; no answer text is kept.
 *
 * The checks run in the contract's order and each judges only what it was built to observe:
 *   short-answer     one plain question; a complete answer saying OK, with usage.
 *   output-bound     a question built to provoke long reasoning under a 64-token limit; the
 *                    reported billed output, reasoning included, must not pass the limit.
 *   tool-round-trip  the model asks for the one offered read tool with the key alpha, then
 *                    answers from its result.
 *   cache-default    the same long prefix twice with no cache fields at all, as an ordinary
 *                    call is sent; did the second read a cache?
 *   cache-off        the same prefix twice with only the explicit no-cache option (no key, no
 *                    breakpoint); was nothing read from or written to a cache?
 *
 * Nothing is sent when the route's spend limit has less room than every planned call's ceiling
 * together. A first check that fails on the key, the network or a server error stops the run.
 * Stopping cancels the call in flight through the exchange, whose hold stays uncertain; the
 * checks after it are recorded as not run, and the partial receipt is still returned.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { Json, ToolDescriptor } from '../../shared/harness.js';
import { type MicroUsd } from '../../shared/managed-usage.js';
import {
  QUALIFICATION_CHECKS,
  QUALIFICATION_VALID_DAYS,
  ROUTE_QUALIFICATION_VERSION,
  routeQualificationReceiptSchema,
  type QualifiableRoute,
  type QualificationCall,
  type QualificationCheck,
  type QualificationCheckId,
  type QualificationOutcome,
  type QualificationProtocol,
  type QualificationVerdicts,
  type RouteQualificationReceipt,
} from '../../shared/route-qualification.js';
import { cacheRequest, type CacheRequest } from '../../shared/route-capabilities.js';
import { toolResultMessage } from '../harness/model-api-adapter.js';
import { HarnessError } from '../harness/policy.js';
import { secretScrubber } from '../secrets.js';
import type { ModelRateCard, SpendExposure } from '../spend-exposure.js';
import {
  callCeiling,
  CONVERSATION_LIMITS,
  respondStream,
  type CallObservation,
  type RespondLimits,
  type RespondResult,
  type RouteBinding,
} from './model-api-core.js';

/** The cache options now travel as a cache request; the merge lives with the exchange. */
export { withCacheOptions } from './model-api-core.js';

// --- what a route offers the checks ---------------------------------------------------

/** One route's exact identity and its own binding, as the checks use it. Nothing here is a key. */
export interface QualificationTarget {
  route: QualifiableRoute;
  connectionId: string;
  connectionRevision: number;
  /** The route's base URL, never with a key or a query in it. */
  endpoint: string;
  /** The Azure deployment the model is addressed by; null on other routes. */
  deployment: string | null;
  /** The logical model the connection asks for. */
  model: string;
  protocol: QualificationProtocol;
  sdk: string;
  /** The rate card's version, as the receipt records it. */
  rateCard: string;
  /** The rate card every check call is reserved and settled under. */
  card: ModelRateCard;
  /**
   * The route's own binding for one check call, with that call's output bound and whether the
   * call offers a tool. It names the namespace its SDK model reads cache options under; each
   * call's cache request is applied by the exchange.
   */
  binding(maxOutputTokens: number, offersTools: boolean): RouteBinding;
}

/**
 * The cache requests the checks send. Every check but the no-cache one sends no cache field at
 * all, exactly as an ordinary call on the provider's default goes out. The no-cache check sends
 * exactly what the owner's `off` setting sends, so a receipt that verifies `off` verifies the
 * shape an ordinary call with that setting carries.
 */
const PROVIDER_DEFAULT: CacheRequest = cacheRequest({ policy: 'provider-default' })!;
export const CHECK_CACHE_OFF: CacheRequest = cacheRequest({ policy: 'off' })!;

// --- the fixed requests -----------------------------------------------------------------

export const INSTRUCTIONS = 'This is an automated route check. Follow the request exactly and keep the answer short.';
export const SHORT_ANSWER = 'Reply with the single word OK.';
export const OUTPUT_BOUND_ASK =
  'Think step by step. Factor 9699690 into primes, then list every factor pair of 9699690, showing all of your work for each pair.';
export const TOOL_ASK = 'Use the lookup_fact tool to look up the key alpha. Then reply with the value it returns and nothing else.';
export const TOOL_KEY = 'alpha';
export const TOOL_VALUE = 'blue-42';
/** Every check call's output limit, except the output bound's own. */
export const CHECK_OUTPUT_TOKENS = 512;
/** The output limit the output-bound check is sent with. */
export const OUTPUT_BOUND_TOKENS = 64;
/**
 * The tool round trip's second call carries the first call's answer (its reasoning items and its
 * tool call) as input. The plan cannot know those bytes, so it allows this many in their place;
 * the hold itself is always reserved on the real request.
 */
const ANSWER_ALLOWANCE_BYTES = 16 * CHECK_OUTPUT_TOKENS;

/** The one tool the round trip offers: a read with one string argument, run by nobody but this check. */
export const LOOKUP_FACT: ToolDescriptor = {
  name: 'lookup_fact',
  version: '1',
  description: 'Look up the value stored under one key.',
  effect: 'read',
  permission: null,
  approval: false,
  destination: 'local',
  trustedInputRequired: false,
  cost: 0,
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
};

/**
 * The cache checks' stable prefix: neutral numbered bookkeeping rules, the same bytes every time.
 * About 6,100 bytes, which is about 1,530 tokens by Diomedes' estimator (UTF-8 bytes / 4), so it
 * sits well above the 1,024-token minimum before providers cache a prefix: a check that sees no
 * cache cannot be explained by a short prefix.
 */
export const CACHE_PREFIX = [
  'Reference rules for an automated route check. Read them, then answer the request that follows.',
  ...Array.from(
    { length: 56 },
    (_, index) =>
      `Rule ${index + 1}: record entry ${index + 1} in the ledger with its date, its amount and the name of the person who entered it.`,
  ),
].join('\n');

interface PlannedCall {
  check: QualificationCheckId;
  /** The call's place in its check, from 1. */
  n: number;
  instructions: string;
  messages: ModelMessage[];
  tools: readonly ToolDescriptor[];
  limits: RespondLimits;
  cache: CacheRequest;
}

interface Plan {
  shortAnswer: PlannedCall;
  outputBound: PlannedCall;
  toolAsk: PlannedCall;
  /** Planned with an allowance in place of the first call's answer; sent with the real one. */
  toolAnswer: PlannedCall;
  cacheDefault: [PlannedCall, PlannedCall];
  cacheOff: [PlannedCall, PlannedCall];
}

const user = (content: string): ModelMessage => ({ role: 'user', content });
const limitsOf = (maxOutputTokens: number): RespondLimits => ({ ...CONVERSATION_LIMITS, maxOutputTokens });

function planFor(): Plan {
  const checkLimits = limitsOf(CHECK_OUTPUT_TOKENS);
  const call = (check: QualificationCheckId, n: number, rest: Partial<PlannedCall>): PlannedCall => ({
    check,
    n,
    instructions: INSTRUCTIONS,
    messages: [user(SHORT_ANSWER)],
    tools: [],
    limits: checkLimits,
    cache: PROVIDER_DEFAULT,
    ...rest,
  });
  const plannedAnswer: ModelMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'x'.repeat(ANSWER_ALLOWANCE_BYTES) },
      { type: 'tool-call', toolCallId: 'call_planned', toolName: LOOKUP_FACT.name, input: { key: TOOL_KEY } },
    ],
  };
  return {
    shortAnswer: call('short-answer', 1, {}),
    outputBound: call('output-bound', 1, { messages: [user(OUTPUT_BOUND_ASK)], limits: limitsOf(OUTPUT_BOUND_TOKENS) }),
    toolAsk: call('tool-round-trip', 1, { messages: [user(TOOL_ASK)], tools: [LOOKUP_FACT] }),
    toolAnswer: call('tool-round-trip', 2, {
      messages: [user(TOOL_ASK), plannedAnswer, toolResultMessage('call_planned', LOOKUP_FACT.name, { value: TOOL_VALUE })],
      tools: [LOOKUP_FACT],
    }),
    // The default check sends no cache field at all, exactly as an ordinary call goes out.
    cacheDefault: [1, 2].map((n) => call('cache-default', n, { instructions: CACHE_PREFIX })) as [PlannedCall, PlannedCall],
    // The no-cache check sends the explicit mode alone: no key and no breakpoint.
    cacheOff: [1, 2].map((n) =>
      call('cache-off', n, { instructions: CACHE_PREFIX, cache: CHECK_CACHE_OFF }),
    ) as [PlannedCall, PlannedCall],
  };
}

const plannedCalls = (plan: Plan): PlannedCall[] => [
  plan.shortAnswer,
  plan.outputBound,
  plan.toolAsk,
  plan.toolAnswer,
  ...plan.cacheDefault,
  ...plan.cacheOff,
];

/** The most every planned check call together can hold on the route's spend limit. */
export function plannedCeilingMicroUsd(target: QualificationTarget): MicroUsd {
  return ceilingOf(target, planFor());
}

function ceilingOf(target: QualificationTarget, plan: Plan): MicroUsd {
  const prefix = target.binding(CHECK_OUTPUT_TOKENS, false).prefix;
  return plannedCalls(plan).reduce(
    (sum, call) =>
      sum +
      callCeiling({
        prefix,
        card: target.card,
        instructions: call.instructions,
        messages: call.messages,
        tools: call.tools,
        limits: call.limits,
      }),
    0,
  ) as MicroUsd;
}

// --- admission ----------------------------------------------------------------------------

/** A run refused before anything was sent, with its code and the sentence a person reads. */
export class QualificationRefused extends HarnessError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'QualificationRefused';
  }
}

/** Dollars as a person reads them, to the cent, rounded the safe way for what is said. */
const centsUp = (micro: number) => `$${(Math.ceil(micro / 10_000) / 100).toFixed(2)}`;
const centsDown = (micro: number) => `$${(Math.floor(micro / 10_000) / 100).toFixed(2)}`;

/**
 * Whether the route's spend limit can hold every planned call at once: null when it can,
 * otherwise the refusal. `label` is the provider as a person reads it ("AWS", "Azure").
 */
export function qualificationRoom(
  exposure: Pick<SpendExposure, 'allowance' | 'summary'>,
  connectionId: string,
  ceiling: number,
  label: string,
): { code: string; message: string } | null {
  const allowance = exposure.allowance(connectionId);
  if (!allowance || allowance.capMicroUsd <= 0)
    return { code: 'qualify_no_limit', message: `Approve a spend limit for ${label} before running route checks.` };
  const available = exposure.summary(connectionId).availableMicroUsd;
  if (available < ceiling)
    return {
      code: 'qualify_no_room',
      message: `The route checks can hold up to ${centsUp(ceiling)}, and ${centsDown(available)} of the ${label} spend limit is left. Raise the limit or resolve open calls first.`,
    };
  return null;
}

// --- one run ------------------------------------------------------------------------------

export interface QualificationRunInput {
  target: QualificationTarget;
  secret: string;
  /** The route's own spend ledger: every check call is held, settled or released on it. */
  exposure: SpendExposure;
  effort?: 'low' | 'medium' | 'high';
  signal: AbortSignal;
  now?: () => Date;
  idFactory?: () => string;
  /** Tests substitute the network here, below the SDK. Production leaves it unset. */
  transport?: typeof globalThis.fetch;
}

const RECEIPT_ID = /^rq_[a-z0-9]{8,40}$/;
const DAY_MS = 86_400_000;
const LEDGER_STATES = new Set(['released', 'settled', 'uncertain', 'pending']);

const newReceiptId = () => `rq_${randomBytes(12).toString('hex')}`;
const clip = (value: string | null | undefined, max: number) => (value == null ? null : value.slice(0, max));
const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** What one check call came back with: the exchange's own result or error, and what it observed. */
interface Sent {
  result: RespondResult | null;
  error: unknown;
  observation: CallObservation;
  call: QualificationCall;
}

const SKELETON_VERDICTS: QualificationVerdicts = {
  answers: false,
  outputBound: 'unknown',
  tools: 'unknown',
  cacheDefault: 'unknown',
  cacheOff: 'unknown',
};

/**
 * Runs the five checks on one route and returns the receipt, validated. Throws
 * `QualificationRefused` with nothing sent when the run cannot start. Never retries a call.
 */
export async function runRouteQualification(input: QualificationRunInput): Promise<RouteQualificationReceipt> {
  const { target, signal } = input;
  const now = input.now ?? (() => new Date());
  const effort = input.effort ?? 'low';
  const id = (input.idFactory ?? newReceiptId)();
  if (!RECEIPT_ID.test(id)) throw new QualificationRefused('qualify_invalid_target', 'The route check could not be named.');
  const { prefix, label } = target.binding(CHECK_OUTPUT_TOKENS, false);
  const createdAt = now();
  const identity = {
    v: ROUTE_QUALIFICATION_VERSION,
    id,
    createdAt: createdAt.toISOString(),
    validUntil: new Date(createdAt.getTime() + QUALIFICATION_VALID_DAYS * DAY_MS).toISOString(),
    route: target.route,
    connectionId: target.connectionId,
    connectionRevision: target.connectionRevision,
    endpoint: target.endpoint,
    deployment: target.deployment,
    model: target.model,
    protocol: target.protocol,
    sdk: target.sdk,
    effort,
    rateCard: target.rateCard,
  };
  // The identity must make a valid receipt before anything is spent on it.
  const skeleton = routeQualificationReceiptSchema.safeParse({
    ...identity,
    servedModels: [],
    checks: QUALIFICATION_CHECKS.map((check) => ({ id: check, outcome: 'not-run', detail: 'Not run.', calls: [] })),
    verdicts: SKELETON_VERDICTS,
    spend: { settledMicroUsd: 0, uncertainMicroUsd: 0 },
  });
  if (!skeleton.success)
    throw new QualificationRefused('qualify_invalid_target', 'This connection cannot be recorded as a route check.');
  const plan = planFor();
  const room = qualificationRoom(input.exposure, target.connectionId, ceilingOf(target, plan), label);
  if (room) throw new QualificationRefused(room.code, room.message);

  const scrub = secretScrubber([input.secret]);
  const send = async (planned: PlannedCall, messages: ModelMessage[] = planned.messages): Promise<Sent> => {
    let observed: CallObservation | null = null;
    let result: RespondResult | null = null;
    let error: unknown = null;
    const started = now().getTime();
    try {
      result = await respondStream({
        binding: target.binding(planned.limits.maxOutputTokens, planned.tools.length > 0),
        cache: planned.cache,
        stablePrefix: null,
        secret: input.secret,
        card: target.card,
        exposure: input.exposure,
        attempt: {
          runId: `qualify:${id}`,
          stepId: `${planned.check}:${planned.n}`,
          attempt: 1,
          requestDigest: createHash('sha256')
            .update(JSON.stringify({ model: target.model, instructions: planned.instructions, messages, tools: planned.tools, limits: planned.limits, cache: planned.cache }))
            .digest('hex'),
        },
        instructions: planned.instructions,
        messages,
        tools: planned.tools,
        limits: planned.limits,
        signal,
        ...(input.transport ? { transport: input.transport } : {}),
        now,
        observe: (value) => {
          observed = value;
        },
      });
    } catch (caught) {
      error = caught;
    }
    const elapsedMs = Math.max(0, now().getTime() - started);
    const observation: CallObservation = observed ?? {
      dispatched: false,
      status: null,
      providerRequestId: null,
      responseId: null,
      reportedModel: null,
      classifiedStatus: null,
      incompleteReason: null,
      usage: null,
      functionCalls: 0,
      text: null,
      providerError: null,
      reservation: null,
      code: error instanceof HarnessError ? error.code : 'qualify_unexpected_error',
    };
    const usage = observation.usage;
    const finish: QualificationCall['finish'] = result
      ? result.outcome.kind === 'tool'
        ? 'tool-call'
        : 'completed'
      : !observation.dispatched
        ? 'not-sent'
        : observation.code === `${prefix}_cancelled`
          ? 'cancelled'
          : observation.classifiedStatus === 'incomplete'
            ? observation.incompleteReason === 'content_filter'
              ? 'refused'
              : 'incomplete'
            : observation.code === `${prefix}_refused`
              ? 'refused'
              : 'error';
    const reservation = observation.reservation;
    const call: QualificationCall = {
      status: observation.status !== null && observation.status >= 100 && observation.status <= 599 ? observation.status : null,
      providerRequestId: clip(observation.providerRequestId, 200),
      responseId: clip(observation.responseId, 200),
      reportedModel: clip(observation.reportedModel, 200),
      finish,
      incompleteReason: clip(observation.incompleteReason, 100),
      maxOutputTokens: planned.limits.maxOutputTokens,
      usage: usage
        ? {
            inputTokens: usage.inputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
          }
        : null,
      error: result
        ? null
        : {
            code: clip(observation.code, 100),
            message: scrub(error instanceof Error ? error.message : 'The call failed.').slice(0, 500),
          },
      ledger:
        reservation && LEDGER_STATES.has(reservation.state)
          ? { state: reservation.state as 'released' | 'settled' | 'uncertain' | 'pending', microUsd: reservation.microUsd }
          : null,
      elapsedMs,
    };
    return { result, error, observation, call };
  };

  /** What a check that a Stop interrupted says, whether a call was in flight or between calls. */
  const STOPPED = 'Stopped before this check finished.';
  /** One plain sentence for a call that did not give its check what it needed. */
  const failure = (sent: Sent): string => {
    const o = sent.observation;
    if (signal.aborted && (o.code === `${prefix}_cancelled` || !o.dispatched)) return STOPPED;
    if (!o.dispatched) return 'Refused before it left this computer.';
    if (o.code === `${prefix}_timeout`) return `${label} did not finish within the time limit.`;
    if (o.status === 401 || o.status === 403) return `${label} refused the key (HTTP ${o.status}).`;
    if (o.status !== null && o.status >= 500) return `${label} answered with a server error (HTTP ${o.status}).`;
    if (o.status !== null && o.status >= 400)
      return o.providerError
        ? `${label} refused the request (HTTP ${o.status}).`
        : `${label} answered HTTP ${o.status} with no readable error.`;
    if (o.status === null) return `No answer came back from ${label}.`;
    if (o.classifiedStatus === 'incomplete')
      return o.incompleteReason === 'max_output_tokens'
        ? 'The answer stopped at its output limit before it was complete.'
        : 'The answer stopped before it was complete.';
    if (!o.usage) return `${label} did not report usage.`;
    return 'The answer could not be used.';
  };
  /** A 4xx answer with a readable error body: the provider refused the request's shape. */
  const refusedShape = (o: CallObservation) => o.status !== null && o.status >= 400 && o.status < 500 && o.providerError !== null;
  const check = (id: QualificationCheckId, outcome: QualificationOutcome, detail: string, calls: Sent[]): QualificationCheck => ({
    id,
    outcome,
    detail: detail.slice(0, 500),
    calls: calls.map((sent) => sent.call),
  });

  const verdicts: QualificationVerdicts = { ...SKELETON_VERDICTS };
  const runners: Record<QualificationCheckId, () => Promise<{ check: QualificationCheck; stop?: string }>> = {
    'short-answer': async () => {
      const sent = await send(plan.shortAnswer);
      const text = sent.result?.outcome.kind === 'final' ? sent.result.outcome.text : null;
      if (text !== null && /\bok\b/i.test(text) && sent.observation.usage) {
        verdicts.answers = true;
        return { check: check('short-answer', 'passed', 'Answered OK in full, with usage reported.', [sent]) };
      }
      const o = sent.observation;
      const detail =
        text !== null ? 'Answered in full, but not with the word OK.' : sent.result ? 'Asked for a tool instead of answering.' : failure(sent);
      // A first check that fails on the key, the network or a server error ends the run.
      const stop = signal.aborted
        ? undefined
        : o.status === 401 || o.status === 403
          ? `Not run: ${label} refused the key on the first check.`
          : o.status !== null && o.status >= 500
            ? `Not run: ${label} answered the first check with a server error.`
            : o.dispatched && o.status === null
              ? `Not run: no answer came back from ${label} on the first check.`
              : undefined;
      return { check: check('short-answer', 'failed', detail, [sent]), stop };
    },
    'output-bound': async () => {
      const sent = await send(plan.outputBound);
      const o = sent.observation;
      const limit = OUTPUT_BOUND_TOKENS;
      const counted =
        !!sent.result || o.classifiedStatus === 'completed' || (o.classifiedStatus === 'incomplete' && o.incompleteReason === 'max_output_tokens');
      if (o.usage && o.usage.outputTokens > limit) {
        verdicts.outputBound = 'exceeded';
        return {
          check: check(
            'output-bound',
            'failed',
            `Reported ${o.usage.outputTokens} billed output tokens, reasoning included, for a limit of ${limit}.`,
            [sent],
          ),
        };
      }
      if (o.usage && counted) {
        verdicts.outputBound = 'bounded';
        return {
          check: check(
            'output-bound',
            'passed',
            `Reported ${o.usage.outputTokens} billed output tokens, reasoning included, for a limit of ${limit}.`,
            [sent],
          ),
        };
      }
      if (refusedShape(o))
        return { check: check('output-bound', 'unsupported', `${label} refused the request (HTTP ${o.status}).`, [sent]) };
      return { check: check('output-bound', 'failed', `${failure(sent)} The output bound could not be read.`, [sent]) };
    },
    'tool-round-trip': async () => {
      const first = await send(plan.toolAsk);
      const asked = first.result?.outcome.kind === 'tool' ? first.result.outcome : null;
      const args = asked ? record(asked.input) : null;
      if (!asked || asked.name !== LOOKUP_FACT.name || !args || args.key !== TOOL_KEY || Object.keys(args).length !== 1) {
        const o = first.observation;
        if (first.result) {
          verdicts.tools = 'failed';
          return {
            check: check(
              'tool-round-trip',
              'failed',
              asked ? 'Called the tool with arguments other than the key alpha.' : 'Answered without calling the offered tool.',
              [first],
            ),
          };
        }
        if (o.code === `${prefix}_invalid_tool` || o.code === `${prefix}_multiple_tools`) {
          verdicts.tools = 'failed';
          return { check: check('tool-round-trip', 'failed', 'Asked for a tool call this check cannot accept.', [first]) };
        }
        if (refusedShape(o)) {
          verdicts.tools = 'failed';
          return { check: check('tool-round-trip', 'unsupported', `${label} refused the request with the tool (HTTP ${o.status}).`, [first]) };
        }
        return { check: check('tool-round-trip', 'failed', failure(first), [first]) };
      }
      if (signal.aborted) return { check: check('tool-round-trip', 'failed', STOPPED, [first]) };
      const messages = [
        ...plan.toolAsk.messages,
        ...first.result!.responseMessages,
        toolResultMessage(asked.callId, asked.name, { value: TOOL_VALUE } satisfies Json),
      ];
      const second = await send(plan.toolAnswer, messages);
      const calls = [first, second];
      if (second.result?.outcome.kind === 'final') {
        if (second.result.outcome.text.includes(TOOL_VALUE)) {
          verdicts.tools = 'one-call';
          return { check: check('tool-round-trip', 'passed', 'Called lookup_fact with the key alpha, then answered from its result.', calls) };
        }
        verdicts.tools = 'failed';
        return { check: check('tool-round-trip', 'failed', 'Called the tool, but the answer did not use its result.', calls) };
      }
      if (second.result) {
        verdicts.tools = 'failed';
        return { check: check('tool-round-trip', 'failed', 'Asked for a tool again instead of answering from the result.', calls) };
      }
      const o = second.observation;
      if (o.code === `${prefix}_invalid_tool` || o.code === `${prefix}_multiple_tools`) {
        verdicts.tools = 'failed';
        return { check: check('tool-round-trip', 'failed', 'Asked for a tool call this check cannot accept.', calls) };
      }
      if (refusedShape(o)) {
        verdicts.tools = 'failed';
        return { check: check('tool-round-trip', 'unsupported', `${label} refused the tool result (HTTP ${o.status}).`, calls) };
      }
      return { check: check('tool-round-trip', 'failed', failure(second), calls) };
    },
    'cache-default': async () => {
      const first = await send(plan.cacheDefault[0]);
      // The second request is sent only when the first was processed: otherwise nothing could be cached.
      if (!first.observation.usage) return { check: check('cache-default', 'failed', failure(first), [first]) };
      if (signal.aborted) return { check: check('cache-default', 'failed', STOPPED, [first]) };
      const second = await send(plan.cacheDefault[1]);
      const calls = [first, second];
      const a = first.observation.usage;
      const b = second.observation.usage;
      verdicts.cacheDefault =
        b && b.cacheReadTokens > 0 ? 'caches' : b && a.cacheReadTokens === 0 && b.cacheReadTokens === 0 ? 'no-cache-observed' : 'unknown';
      // This check observes; it does not judge. It passes when both requests completed with usage.
      if (!first.result || !second.result || !b)
        return { check: check('cache-default', 'failed', first.result ? failure(second) : failure(first), calls) };
      return {
        check: check(
          'cache-default',
          'passed',
          verdicts.cacheDefault === 'caches'
            ? `The second identical request read ${b.cacheReadTokens} input tokens from a cache.`
            : verdicts.cacheDefault === 'no-cache-observed'
              ? 'Neither identical request read from a cache.'
              : 'Both requests completed; the first already read from a cache.',
          calls,
        ),
      };
    },
    'cache-off': async () => {
      const first = await send(plan.cacheOff[0]);
      if (refusedShape(first.observation)) {
        verdicts.cacheOff = 'unsupported';
        return {
          check: check('cache-off', 'unsupported', `${label} refused the no-cache option (HTTP ${first.observation.status}).`, [first]),
        };
      }
      if (!first.observation.usage) return { check: check('cache-off', 'failed', failure(first), [first]) };
      if (signal.aborted) return { check: check('cache-off', 'failed', STOPPED, [first]) };
      const second = await send(plan.cacheOff[1]);
      const calls = [first, second];
      if (refusedShape(second.observation)) {
        verdicts.cacheOff = 'unsupported';
        return {
          check: check('cache-off', 'unsupported', `${label} refused the no-cache option (HTTP ${second.observation.status}).`, calls),
        };
      }
      const usages = [first.observation.usage, second.observation.usage];
      const cached = usages.some((usage) => usage && (usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0));
      if (cached) {
        verdicts.cacheOff = 'not-verified';
        return { check: check('cache-off', 'failed', 'With the no-cache option, a request still read or wrote cache tokens.', calls) };
      }
      if (usages.every((usage) => usage !== null)) {
        verdicts.cacheOff = 'verified';
        return { check: check('cache-off', 'passed', 'With the no-cache option, neither request read or wrote any cache tokens.', calls) };
      }
      return { check: check('cache-off', 'failed', failure(second), calls) };
    },
  };

  const checks: QualificationCheck[] = [];
  let skip: string | null = null;
  for (const id_ of QUALIFICATION_CHECKS) {
    if (!skip && signal.aborted) skip = 'Not run: the route checks were stopped.';
    if (skip) {
      checks.push(check(id_, 'not-run', skip, []));
      continue;
    }
    const ran = await runners[id_]();
    checks.push(ran.check);
    if (signal.aborted) skip = 'Not run: the route checks were stopped.';
    else if (ran.stop) skip = ran.stop;
  }

  const calls = checks.flatMap((entry) => entry.calls);
  const servedModels = [...new Set(calls.map((call) => call.reportedModel).filter((model): model is string => !!model))].slice(0, 8);
  const sum = (states: string[]) =>
    calls.reduce((total, call) => total + (call.ledger && states.includes(call.ledger.state) ? call.ledger.microUsd : 0), 0);
  return routeQualificationReceiptSchema.parse({
    ...identity,
    servedModels,
    checks,
    verdicts,
    spend: { settledMicroUsd: sum(['settled']), uncertainMicroUsd: sum(['uncertain', 'pending']) },
  });
}
