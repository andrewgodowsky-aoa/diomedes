/**
 * The evaluation transport.
 *
 * The provider is injected, exactly as it is for the native loop. A transport
 * that can only be exercised by paying for it cannot be tested, and the whole
 * failure matrix for this feature — malformed answers, rate limits, cancelled
 * calls, absent usage — is about what happens when the provider misbehaves.
 * Those paths have to be reachable without a network.
 *
 * Three ports ship. `scriptedEvaluationPort` is a fixed script and declares
 * itself `scripted`, so the loop attributes its work to the application rather
 * than to a model — the same rule `isScriptedAdapter` already enforces for
 * model adapters. `gatewayEvaluationPort` reaches the real service through the
 * Vercel AI SDK, and `openRouterEvaluationPort` through OpenRouter's provider
 * for it, both loaded dynamically so that a build without the dependency still
 * compiles, runs and tests, and fails honestly at the one point where the
 * dependency is actually required. Neither real port has made a live call.
 *
 * Three provider behaviours are handled here because they cost money to
 * discover elsewhere:
 *
 * - **The SDK retries twice by default.** Left alone, one rate-limited call
 *   becomes three charges while the run service records one attempt. Retries
 *   belong to the run service's attempt policy, so the SDK's budget is zero.
 * - **The gateway reads `AI_GATEWAY_API_KEY` when no key is passed.** An
 *   ambient variable choosing the payer is precisely the silent payer switch
 *   the accounting contract exists to prevent, so the key is always explicit
 *   and an empty one is refused at construction.
 * - **A route is only proven to the limit it was tested at.** The native model
 *   documents a larger aggregate than a gateway accepts for shared state, so
 *   the smaller, route-specific bound is the one enforced, before any I/O.
 */
import type {
  EvaluationObservation,
  EvaluationProfile,
  EvaluationUsage,
} from '../../shared/evaluation.js';
import { validateEvaluationResult } from '../../shared/evaluation.js';
import {
  EVALUATION_ROUTE_LIMITS,
  REQUEST_ENVELOPE_TOKENS,
  TYPESAFE_DOCUMENTED_LIMITS,
  UNPROVEN_ROUTE_LIMITS,
  serializedRequestTokens,
  serializedStateTokens,
  type EvaluationRequestLimits,
  type ProviderQuestion,
} from '../../shared/evaluation-wire.js';

export type EvaluationTransportCode =
  | 'unsupported_question_type'
  | 'state_too_large'
  /** The complete serialized request, state and every question, is over the route's bound. */
  | 'request_too_large'
  | 'transport_unavailable'
  | 'invalid_transport'
  /**
   * The route's data policy left no provider that could take the request: it
   * reached no model and nothing was charged. The managed gateway sends every
   * evaluation to providers that do not collect data, and never falls back.
   */
  | 'provider_policy'
  /**
   * The provider answered and the answer was unusable. This is the only code
   * that means money was already spent: every other code is a refusal made
   * before anything was sent.
   */
  | 'answer_rejected';

/**
 * Codes that are always raised before anything was sent to a model, so nothing
 * can have been charged. A metered route's refusal that it released is one too.
 */
export const PRE_DISPATCH_CODES: ReadonlySet<EvaluationTransportCode> = new Set([
  'unsupported_question_type',
  'state_too_large',
  'request_too_large',
  'transport_unavailable',
  'invalid_transport',
  'provider_policy',
]);

export class EvaluationTransportError extends Error {
  constructor(
    readonly code: EvaluationTransportCode,
    message: string,
    /**
     * What the provider reported for a call that actually happened, carried on
     * the failure so it is not lost with it. A rejected answer is still a
     * charged answer, and a cost that never reaches the ledger is a cost the
     * customer paid and nobody can see.
     *
     * Null means nobody knows, which is not the same as nothing. It stays null
     * when the provider reported no usage, when the response was too malformed
     * to read one from, and on every code except `answer_rejected`.
     */
    readonly usage: EvaluationUsage | null = null,
    /**
     * The contract failure underneath, when there is one. Wrapping must not
     * cost the diagnosis: `answer_rejected` says money may be gone, and this
     * says which of the validator's rules the answer broke.
     */
    readonly cause: unknown = undefined,
  ) {
    super(message);
    this.name = 'EvaluationTransportError';
  }
}

/**
 * Usage read from a response that failed validation, which means reading it
 * from something already known to be wrong. So every field is checked on its
 * own and anything unreadable becomes null rather than zero: the point is to
 * preserve what the provider said, not to manufacture a number that would
 * settle cleanly.
 */
function reportedUsage(raw: unknown): EvaluationUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const given = (raw as { usage?: unknown }).usage;
  if (typeof given !== 'object' || given === null) return null;
  const whole = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const inputTokens = whole((given as { inputTokens?: unknown }).inputTokens);
  const outputTokens = whole((given as { outputTokens?: unknown }).outputTokens);
  if (inputTokens === null && outputTokens === null) return null;
  return { inputTokens, outputTokens };
}

// The bounds, the token estimate and the question shape live in shared/evaluation-wire.ts, so
// the managed gateway counts and refuses a request exactly as this adapter does.
export {
  EVALUATION_ROUTE_LIMITS,
  REQUEST_ENVELOPE_TOKENS,
  TYPESAFE_DOCUMENTED_LIMITS,
  UNPROVEN_ROUTE_LIMITS,
  serializedRequestTokens,
  serializedStateTokens,
};
export type { EvaluationRequestLimits, ProviderQuestion };

/**
 * Convert an authorized profile into the provider's question map.
 *
 * The keys are our own question ids and the choice criteria are keyed by our
 * own candidate ids, so whatever comes back is already in the vocabulary the
 * validator checks against. Nothing is renamed on the way out, because a
 * renaming on the way out needs an un-renaming on the way back, and that is
 * where a name quietly becomes a different name.
 */
export function providerQuestions(profile: EvaluationProfile): Record<string, ProviderQuestion> {
  const out: Record<string, ProviderQuestion> = {};
  for (const question of profile.questions) {
    if (question.type === 'choice')
      out[question.id] = {
        type: 'choice',
        instructions: question.instructions,
        criteria: Object.fromEntries(
          question.options.map((option) => [option.id, option.description]),
        ),
      };
    else if (question.type === 'score')
      out[question.id] = {
        type: 'score',
        instructions: question.instructions,
        criteria: [...question.levels],
      };
    else {
      const criteria: { true?: string | null; false?: string | null } = {};
      if (question.whenTrue !== null) criteria.true = question.whenTrue;
      if (question.whenFalse !== null) criteria.false = question.whenFalse;
      out[question.id] = Object.keys(criteria).length
        ? { type: 'boolean', instructions: question.instructions, criteria }
        : { type: 'boolean', instructions: question.instructions };
    }
  }
  return out;
}

// --- the port -----------------------------------------------------------------

/** Who one evaluation is for: the same three names a preflight is scoped by. */
export interface EvaluationScope {
  /** The organization or local installation the request belongs to. */
  readonly tenant: string;
  readonly project: string;
  readonly thread: string | null;
}

/**
 * What a metered route says one call was charged, from the ledger that paid it.
 * `settled` is exact; `uncertain` was sent and its cost is unknown until it is
 * reconciled (never zero); `released` reached no model and cost nothing.
 * `attemptId` is the hold the charge is recorded against.
 */
export type EvaluationReceipt =
  | {
      readonly state: 'settled';
      readonly attemptId: string;
      readonly microUsd: number;
      /** The terms it was priced under. */
      readonly rateCard: string;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
    }
  | { readonly state: 'uncertain'; readonly attemptId: string; readonly rateCard: string | null; readonly reason: string }
  | { readonly state: 'released'; readonly attemptId: string };

export interface EvaluationPortCall {
  state: unknown;
  questions: Record<string, ProviderQuestion>;
  signal: AbortSignal;
  /** Present when the caller knows it. A port that admits and meters each call per business reads it. */
  scope?: EvaluationScope;
  /**
   * Where a port that is metered by the service it calls reports the receipt,
   * before it returns or throws. Ports that price their own calls never call it.
   */
  onReceipt?: (receipt: EvaluationReceipt) => void;
}

export interface EvaluationPort {
  readonly id: string;
  readonly version: string;
  /** The route or alias being asked for. What actually answers comes back in the result. */
  readonly requestedModel: string;
  /** A fixed script is an application action, never model authorship. */
  readonly scripted: boolean;
  /** Question types this route is proven to support, checked before any I/O. */
  readonly supports: readonly ('choice' | 'score' | 'boolean')[];
  /**
   * The whole-request bounds this route enforces. Absent means
   * `UNPROVEN_ROUTE_LIMITS`: nothing larger than the smallest published bound.
   */
  readonly limits?: EvaluationRequestLimits;
  /**
   * A supported type can still carry a shape the route cannot send (a provider
   * that needs every score level described, say). Returns why, or null. Checked
   * before any I/O, so a shape the SDK would throw on is never half-sent.
   */
  refuses?(question: EvaluationProfile['questions'][number]): string | null;
  evaluate(call: EvaluationPortCall): Promise<unknown>;
}

export interface ScriptedEvaluationPort extends EvaluationPort {
  readonly calls: readonly EvaluationPortCall[];
}

/** A fixed script, for the tests that must not cost anything. */
export function scriptedEvaluationPort(script: {
  result?: unknown;
  failWith?: Error;
  supports?: readonly ('choice' | 'score' | 'boolean')[];
  requestedModel?: string;
}): ScriptedEvaluationPort {
  const calls: EvaluationPortCall[] = [];
  return {
    id: 'evaluation-fixture',
    version: '1',
    requestedModel: script.requestedModel ?? 'fixture',
    scripted: true,
    supports: script.supports ?? ['choice', 'score', 'boolean'],
    calls,
    async evaluate(call) {
      call.signal.throwIfAborted();
      calls.push(call);
      if (script.failWith) throw script.failWith;
      return script.result ?? null;
    },
  };
}

/** The minimum of the SDK this port uses. Kept narrow so it can be faked exactly. */
interface EvaluationSdk {
  evaluate(options: {
    model: unknown;
    state: unknown;
    questions: Record<string, ProviderQuestion>;
    maxRetries: number;
    abortSignal: AbortSignal;
  }): Promise<unknown>;
  createGateway(settings: { apiKey: string; fetch?: unknown }): {
    evaluationModel(modelId: string): unknown;
  };
}

/**
 * Resolve the installed `ai` package into the narrow SDK this port uses.
 *
 * `ai@7.0.107` exports the function as `experimental_evaluate`; there is no
 * `evaluate` export at all, so reading `sdk.evaluate` off the module (which a
 * TypeScript cast happily allowed) is `undefined` at runtime. An SDK that has
 * neither is refused as unavailable, before anything is sent.
 */
export function evaluationSdkFrom(module: Record<string, unknown>): EvaluationSdk {
  const evaluate = module.experimental_evaluate ?? module.evaluate;
  if (typeof evaluate !== 'function' || typeof module.createGateway !== 'function')
    throw new EvaluationTransportError(
      'transport_unavailable',
      'The installed AI SDK exports no evaluation function, so this route cannot run.',
    );
  return {
    evaluate: evaluate as EvaluationSdk['evaluate'],
    createGateway: module.createGateway as EvaluationSdk['createGateway'],
  };
}

/**
 * Turn what the SDK's `experimental_evaluate` returns into the plain reply the
 * contract validates, keeping only what a provider actually reported.
 *
 * The SDK fills `response.modelId` with the model that was *asked for* when the
 * provider names none, and the gateway's evaluation model always sets it to the
 * requested alias. Reading that field would confirm an identity nobody reported,
 * which the contract forbids ("unknown stays unknown"). So the answering model
 * is taken only from the provider's own response body, and is otherwise absent.
 */
export function normalizeSdkEvaluation(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const given = result as Record<string, unknown>;
  const response =
    typeof given.response === 'object' && given.response !== null
      ? (given.response as Record<string, unknown>)
      : {};
  const body =
    typeof response.body === 'object' && response.body !== null
      ? (response.body as Record<string, unknown>)
      : {};
  const reportedModel = typeof body.model === 'string' && body.model ? body.model : undefined;
  const reportedId =
    typeof response.id === 'string' ? response.id : typeof body.id === 'string' ? body.id : undefined;
  const usage =
    typeof given.usage === 'object' && given.usage !== null
      ? (given.usage as Record<string, unknown>)
      : undefined;
  return {
    answers: given.answers,
    ...(usage ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } } : {}),
    ...(given.rounding ? { rounding: given.rounding } : {}),
    warnings: Array.isArray(given.warnings) ? given.warnings : [],
    response: {
      ...(reportedModel ? { modelId: reportedModel } : {}),
      ...(reportedId ? { id: reportedId } : {}),
    },
  };
}

const loadAi = async (): Promise<EvaluationSdk> =>
  evaluationSdkFrom((await import('ai' as string)) as Record<string, unknown>);

/**
 * The real route, through the Vercel AI Gateway.
 *
 * The SDK is imported at call time rather than at module load, so a build
 * without the dependency still type-checks, still runs and still passes every
 * contract test — and the one operation that genuinely needs it says so plainly
 * instead of looking like an outage.
 */
export function gatewayEvaluationPort(options: {
  apiKey: string;
  modelId: string;
  /** A custom fetch, which is also how a conformance test observes the wire. */
  fetch?: unknown;
  /** Injected in tests; production resolves the real package. */
  loadSdk?: () => Promise<EvaluationSdk>;
}): EvaluationPort {
  if (!options.apiKey)
    throw new EvaluationTransportError(
      'invalid_transport',
      'An evaluation route needs an explicit credential. Falling back to an ambient environment variable would let it bill a payer nobody admitted.',
    );
  const load = options.loadSdk ?? loadAi;
  return {
    id: 'vercel-gateway-evaluation',
    version: '1',
    requestedModel: options.modelId,
    scripted: false,
    supports: ['choice', 'score', 'boolean'],
    limits: UNPROVEN_ROUTE_LIMITS,
    async evaluate(call) {
      call.signal.throwIfAborted();
      let sdk: EvaluationSdk;
      try {
        sdk = await load();
      } catch (error) {
        if (error instanceof EvaluationTransportError) throw error;
        throw new EvaluationTransportError(
          'transport_unavailable',
          `The evaluation SDK is not installed in this build, so this route cannot run: ${(error as Error).message}`,
        );
      }
      const gateway = sdk.createGateway({
        apiKey: options.apiKey,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return normalizeSdkEvaluation(
        await sdk.evaluate({
          model: gateway.evaluationModel(options.modelId),
          state: call.state,
          questions: call.questions,
          // Attempts belong to the run service, which records and budgets each one.
          maxRetries: 0,
          abortSignal: call.signal,
        }),
      );
    },
  };
}

/** The part of `@openrouter/ai-sdk-provider` this port uses. */
interface OpenRouterEvaluationSdk {
  evaluate: EvaluationSdk['evaluate'];
  createOpenRouter(settings: { apiKey: string; fetch?: unknown }): {
    evaluationModel(modelId: string): unknown;
  };
}

/**
 * OpenRouter's Decisions API sends a boolean as `noul`, and the installed
 * provider (3.1.0) throws on two shapes this contract allows: a score level
 * with no description, and a boolean that describes only one side. Both are
 * refused here, before anything is serialized.
 */
function openRouterRefuses(question: EvaluationProfile['questions'][number]): string | null {
  if (question.type === 'score' && question.levels.some((level) => level === null))
    return `OpenRouter needs a description for every level of ${question.id}.`;
  if (question.type === 'boolean' && (question.whenTrue === null) !== (question.whenFalse === null))
    return `OpenRouter needs both a true and a false description for ${question.id}, or neither.`;
  return null;
}

/**
 * Jev through OpenRouter's Decisions API, with the installed provider.
 *
 * Optional, and unqualified beyond the offline conformance tests: the endpoint
 * is OpenRouter's `/alpha` path, and its route context is 32k. Unlike the
 * gateway, this provider reports the model that answered, so an observation
 * through it can carry a real identity. The key is explicit for the same
 * reason as the gateway's: the provider otherwise reads `OPENROUTER_API_KEY`.
 */
export function openRouterEvaluationPort(options: {
  apiKey: string;
  modelId: string;
  fetch?: unknown;
  loadSdk?: () => Promise<OpenRouterEvaluationSdk>;
}): EvaluationPort {
  if (!options.apiKey)
    throw new EvaluationTransportError(
      'invalid_transport',
      'An evaluation route needs an explicit credential. Falling back to an ambient environment variable would let it bill a payer nobody admitted.',
    );
  const load =
    options.loadSdk ??
    (async (): Promise<OpenRouterEvaluationSdk> => {
      const ai = (await import('ai' as string)) as Record<string, unknown>;
      const provider = (await import('@openrouter/ai-sdk-provider' as string)) as Record<
        string,
        unknown
      >;
      if (typeof provider.createOpenRouter !== 'function')
        throw new EvaluationTransportError(
          'transport_unavailable',
          'The installed OpenRouter provider has no createOpenRouter, so this route cannot run.',
        );
      return {
        evaluate: evaluationSdkFrom(ai).evaluate,
        createOpenRouter: provider.createOpenRouter as OpenRouterEvaluationSdk['createOpenRouter'],
      };
    });
  return {
    id: 'openrouter-evaluation',
    version: '1',
    requestedModel: options.modelId,
    scripted: false,
    supports: ['choice', 'score', 'boolean'],
    limits: UNPROVEN_ROUTE_LIMITS,
    refuses: openRouterRefuses,
    async evaluate(call) {
      call.signal.throwIfAborted();
      let sdk: OpenRouterEvaluationSdk;
      try {
        sdk = await load();
      } catch (error) {
        if (error instanceof EvaluationTransportError) throw error;
        throw new EvaluationTransportError(
          'transport_unavailable',
          `The OpenRouter provider is not installed in this build, so this route cannot run: ${(error as Error).message}`,
        );
      }
      const openrouter = sdk.createOpenRouter({
        apiKey: options.apiKey,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return normalizeSdkEvaluation(
        await sdk.evaluate({
          model: openrouter.evaluationModel(options.modelId),
          state: call.state,
          questions: call.questions,
          maxRetries: 0,
          abortSignal: call.signal,
        }),
      );
    },
  };
}

// --- one evaluation -----------------------------------------------------------

/**
 * Ask one bounded batch and validate what comes back.
 *
 * Everything refusable is refused before the call, so a payload that cannot
 * succeed is never disclosed and never reserved against. What returns is
 * validated whole: a decision that is partly wrong is not partly useful.
 */
export async function runEvaluation(input: {
  port: EvaluationPort;
  profile: EvaluationProfile;
  state: unknown;
  signal: AbortSignal;
  observedAt: string;
  /** Passed to the port as given. */
  scope?: EvaluationScope;
  onReceipt?: (receipt: EvaluationReceipt) => void;
}): Promise<EvaluationObservation> {
  const { port, profile, state, signal } = input;
  signal.throwIfAborted();

  const supported = new Set(port.supports);
  for (const question of profile.questions)
    if (!supported.has(question.type))
      throw new EvaluationTransportError(
        'unsupported_question_type',
        `Route ${port.id} does not support ${question.type} questions, so ${question.id} cannot be asked on it.`,
      );

  if (profile.questions.length > EVALUATION_ROUTE_LIMITS.maxQuestions)
    throw new EvaluationTransportError(
      'state_too_large',
      `Route ${port.id} accepts at most ${EVALUATION_ROUTE_LIMITS.maxQuestions} questions in one batch.`,
    );

  for (const question of profile.questions) {
    const refusal = port.refuses?.(question) ?? null;
    if (refusal)
      throw new EvaluationTransportError(
        'unsupported_question_type',
        `Route ${port.id} cannot send ${question.id} in this shape: ${refusal}`,
      );
  }

  const tokens = serializedStateTokens(state);
  if (tokens > EVALUATION_ROUTE_LIMITS.maxStateTokens)
    throw new EvaluationTransportError(
      'state_too_large',
      `The shared state is about ${tokens} tokens, over the ${EVALUATION_ROUTE_LIMITS.maxStateTokens} this route is proven to accept. Select less, or split the batch.`,
    );

  // The state fitting is not the request fitting: the complete body the route
  // will serialize, questions included, is bounded too, before it is disclosed.
  const questions = providerQuestions(profile);
  const limits = port.limits ?? UNPROVEN_ROUTE_LIMITS;
  const request = serializedRequestTokens(state, questions);
  if (request.total > limits.maxTotalTokens)
    throw new EvaluationTransportError(
      'request_too_large',
      `The whole request is about ${request.total} tokens, over the ${limits.maxTotalTokens} route ${port.id} accepts. Ask fewer questions, or select less.`,
    );
  if (request.statePlusLongestQuestion > limits.maxStatePlusLongestQuestionTokens)
    throw new EvaluationTransportError(
      'request_too_large',
      `The state and the longest question together are about ${request.statePlusLongestQuestion} tokens, over the ${limits.maxStatePlusLongestQuestionTokens} route ${port.id} accepts.`,
    );

  const raw = await port.evaluate({
    state,
    questions,
    signal,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.onReceipt ? { onReceipt: input.onReceipt } : {}),
  });
  try {
    return validateEvaluationResult(profile, raw, {
      requestedModel: port.requestedModel,
      observedAt: input.observedAt,
    });
  } catch (cause) {
    // Past this line the call has happened and may already be billed. Refusing
    // the answer is right; refusing it silently would throw away the only
    // record of what it cost, so the usage travels with the failure.
    throw new EvaluationTransportError(
      'answer_rejected',
      `Route ${port.id} answered, but the answer could not be validated: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      reportedUsage(raw),
      cause,
    );
  }
}

/**
 * Which route Jev runs through when nothing names one (owner decision
 * 2026-09-23): OpenRouter, whose Decisions API reports the model that answered
 * and so can be priced from what actually ran. The Vercel AI Gateway stays
 * available only by name. The advisor itself stays off until the host is given
 * one (`AppOptions.jevAdvisor`), and nothing here makes a call.
 */
export const DEFAULT_EVALUATION_ROUTE = 'openrouter' as const;
export const EVALUATION_ROUTES = ['openrouter', 'vercel-gateway'] as const;
export type EvaluationRoute = (typeof EVALUATION_ROUTES)[number];
/** Jev 1.13 as OpenRouter lists it; priced by `EVALUATION_PRICE_JEV_113_OPENROUTER`. */
export const DEFAULT_OPENROUTER_JEV_MODEL = 'typesafe/jev-1.13';

/**
 * The evaluation port for Jev on a route, OpenRouter unless another is named.
 * The credential is always explicit: no route reads an ambient key.
 */
export function jevEvaluationPort(options: {
  route?: EvaluationRoute;
  apiKey: string;
  modelId?: string;
  fetch?: unknown;
  loadOpenRouterSdk?: () => Promise<OpenRouterEvaluationSdk>;
  loadGatewaySdk?: () => Promise<EvaluationSdk>;
}): EvaluationPort {
  const route = options.route ?? DEFAULT_EVALUATION_ROUTE;
  if (route === 'vercel-gateway') {
    if (!options.modelId)
      throw new EvaluationTransportError('invalid_transport', 'Name the Jev model to ask on the Vercel AI Gateway.');
    return gatewayEvaluationPort({
      apiKey: options.apiKey,
      modelId: options.modelId,
      fetch: options.fetch,
      loadSdk: options.loadGatewaySdk,
    });
  }
  return openRouterEvaluationPort({
    apiKey: options.apiKey,
    modelId: options.modelId ?? DEFAULT_OPENROUTER_JEV_MODEL,
    fetch: options.fetch,
    loadSdk: options.loadOpenRouterSdk,
  });
}
