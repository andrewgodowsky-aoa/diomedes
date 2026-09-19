/**
 * The evaluation transport.
 *
 * The provider is injected, exactly as it is for the native loop. A transport
 * that can only be exercised by paying for it cannot be tested, and the whole
 * failure matrix for this feature — malformed answers, rate limits, cancelled
 * calls, absent usage — is about what happens when the provider misbehaves.
 * Those paths have to be reachable without a network.
 *
 * Two ports ship. `scriptedEvaluationPort` is a fixed script and declares
 * itself `scripted`, so the loop attributes its work to the application rather
 * than to a model — the same rule `isScriptedAdapter` already enforces for
 * model adapters. `gatewayEvaluationPort` reaches the real service through the
 * Vercel AI SDK, loaded dynamically so that a build without the dependency
 * still compiles, runs and tests, and fails honestly at the one point where the
 * dependency is actually required.
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

export type EvaluationTransportCode =
  | 'unsupported_question_type'
  | 'state_too_large'
  | 'transport_unavailable'
  | 'invalid_transport'
  /**
   * The provider answered and the answer was unusable. This is the only code
   * that means money was already spent: the other four are refusals made
   * before anything was sent.
   */
  | 'answer_rejected';

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

/**
 * What a route was actually tested at, not what the model's own documentation
 * advertises. The direct model documents a 64k aggregate across state and
 * questions; the shared-state bound proven for a gateway call is half that, and
 * an untested headroom is not headroom.
 */
export const EVALUATION_ROUTE_LIMITS = Object.freeze({
  maxStateTokens: 32_000,
  maxQuestions: 32,
});

/**
 * A deliberately pessimistic token estimate: three characters per token, where
 * English prose averages closer to four. Under-counting here would mean sending
 * a payload the provider rejects after it has already been serialized and
 * disclosed, and reserving less money than the call goes on to cost.
 */
export function serializedStateTokens(state: unknown): number {
  const text = typeof state === 'string' ? state : JSON.stringify(state ?? null);
  return Math.ceil(text.length / 3);
}

// --- the provider's question shape --------------------------------------------

export type ProviderQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: (string | null)[] }
  | { type: 'boolean'; instructions: string; criteria?: { true?: string | null; false?: string | null } };

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

export interface EvaluationPortCall {
  state: unknown;
  questions: Record<string, ProviderQuestion>;
  signal: AbortSignal;
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
  const load =
    options.loadSdk ?? (() => import('ai' as string) as unknown as Promise<EvaluationSdk>);
  return {
    id: 'vercel-gateway-evaluation',
    version: '1',
    requestedModel: options.modelId,
    scripted: false,
    supports: ['choice', 'score', 'boolean'],
    async evaluate(call) {
      call.signal.throwIfAborted();
      let sdk: EvaluationSdk;
      try {
        sdk = await load();
      } catch (error) {
        throw new EvaluationTransportError(
          'transport_unavailable',
          `The evaluation SDK is not installed in this build, so this route cannot run: ${(error as Error).message}`,
        );
      }
      const gateway = sdk.createGateway({
        apiKey: options.apiKey,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return sdk.evaluate({
        model: gateway.evaluationModel(options.modelId),
        state: call.state,
        questions: call.questions,
        // Attempts belong to the run service, which records and budgets each one.
        maxRetries: 0,
        abortSignal: call.signal,
      });
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

  const tokens = serializedStateTokens(state);
  if (tokens > EVALUATION_ROUTE_LIMITS.maxStateTokens)
    throw new EvaluationTransportError(
      'state_too_large',
      `The shared state is about ${tokens} tokens, over the ${EVALUATION_ROUTE_LIMITS.maxStateTokens} this route is proven to accept. Select less, or split the batch.`,
    );

  const raw = await port.evaluate({ state, questions: providerQuestions(profile), signal });
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
    );
  }
}
