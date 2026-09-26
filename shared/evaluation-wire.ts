/**
 * A typed evaluation on the wire: the question shape a route is sent, the bounds a
 * request is held to, and the check the managed gateway makes on a request body
 * before it holds or sends anything (docs/implementation/2026-09-26-jev-managed-evaluations.md).
 *
 * Worker-safe: nothing here imports Node. The desktop's evaluation adapter
 * re-exports the bounds and the token estimate from here, so the desktop and the
 * gateway count one request the same way and refuse it at the same size.
 */

// --- the provider's question shape --------------------------------------------

export type ProviderQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: (string | null)[] }
  | { type: 'boolean'; instructions: string; criteria?: { true?: string | null; false?: string | null } };

// --- the bounds -----------------------------------------------------------------

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

/**
 * The bounds on a whole request, not only its state. The provider documents two:
 * the complete payload (state plus every question) and the state plus the
 * longest single question. A state that fits can still carry a question batch
 * that does not, so both are checked against the exact wire body, before I/O.
 */
export interface EvaluationRequestLimits {
  readonly maxTotalTokens: number;
  readonly maxStatePlusLongestQuestionTokens: number;
}

/**
 * TypeSafe's documented bounds for the direct model: 64k total, 32k for the
 * state and the longest question. Documented, not tested by this product.
 */
export const TYPESAFE_DOCUMENTED_LIMITS: EvaluationRequestLimits = Object.freeze({
  maxTotalTokens: 64_000,
  maxStatePlusLongestQuestionTokens: 32_000,
});

/**
 * What a route gets when it has proven nothing larger: the smallest bound any
 * listed route publishes (OpenRouter lists 32k context for Jev). An untested
 * headroom is not headroom.
 */
export const UNPROVEN_ROUTE_LIMITS: EvaluationRequestLimits = Object.freeze({
  maxTotalTokens: 32_000,
  maxStatePlusLongestQuestionTokens: 32_000,
});

/**
 * Room for what a provider wraps around state and questions: the model id, an
 * empty `providerOptions` (the gateway sends one) and the JSON punctuation.
 * Measured at well under a hundred characters; held at a flat 64 tokens.
 */
export const REQUEST_ENVELOPE_TOKENS = 64;

/** The conservative token count of the complete wire body and of its largest state+question pair. */
export function serializedRequestTokens(
  state: unknown,
  questions: Record<string, ProviderQuestion>,
): { total: number; statePlusLongestQuestion: number } {
  const stateTokens = serializedStateTokens(state);
  let longest = 0;
  for (const [id, question] of Object.entries(questions))
    longest = Math.max(longest, serializedStateTokens(JSON.stringify({ [id]: question })));
  return {
    total:
      serializedStateTokens(JSON.stringify({ state: state ?? null, questions })) +
      REQUEST_ENVELOPE_TOKENS,
    statePlusLongestQuestion: stateTokens + longest,
  };
}

/**
 * The shape bounds a profile is built under (`shared/evaluation.ts`), restated
 * so a request that no profile could have produced is refused on the wire too.
 */
export const EVALUATION_WIRE_BOUNDS = Object.freeze({
  maxQuestions: EVALUATION_ROUTE_LIMITS.maxQuestions,
  maxOptions: 64,
  minLevels: 2,
  maxLevels: 16,
  maxTextChars: 4_000,
  maxQuestionIdChars: 120,
  maxOptionIdChars: 200,
  /** How deeply the state may nest. Deeper than any state this product sends. */
  maxStateDepth: 64,
});

// --- the request a route accepts --------------------------------------------------

/** A request body that passed `checkEvaluationRequest`: exactly the client's state and questions. */
export interface EvaluationRequest {
  readonly state: string | readonly unknown[] | Readonly<Record<string, unknown>>;
  readonly questions: Readonly<Record<string, ProviderQuestion>>;
}

/**
 * `unsupported_field`: a field or a question shape this route does not send.
 * `invalid_body`: not an evaluation request. `request_too_large`: over a bound.
 */
export type EvaluationRequestRefusalCode = 'unsupported_field' | 'invalid_body' | 'request_too_large';

export interface EvaluationRequestRefusal {
  readonly ok: false;
  readonly code: EvaluationRequestRefusalCode;
  /** Where the refusal is, as a dotted path into the body. */
  readonly field: string;
  readonly message: string;
}

class Refused {
  constructor(
    readonly code: EvaluationRequestRefusalCode,
    readonly field: string,
    readonly message: string,
  ) {}
}
const refuse = (code: EvaluationRequestRefusalCode, field: string, message: string): never => {
  throw new Refused(code, field, message);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function words(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    refuse('invalid_body', field, `${field} must be text of 1 to ${max.toLocaleString('en-US')} characters.`);
  return value as string;
}

/** JSON only, nested no deeper than the bound. Walked before anything serializes it. */
function checkState(value: unknown, depth: number): void {
  if (depth > EVALUATION_WIRE_BOUNDS.maxStateDepth)
    refuse('invalid_body', 'state', `state may nest at most ${EVALUATION_WIRE_BOUNDS.maxStateDepth} levels deep.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse('invalid_body', 'state', 'state may hold only finite numbers.');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) checkState(item, depth + 1);
    return;
  }
  if (!isPlainObject(value)) refuse('invalid_body', 'state', 'state must be JSON.');
  for (const item of Object.values(value as Record<string, unknown>)) checkState(item, depth + 1);
}

function checkQuestion(id: string, value: unknown): ProviderQuestion {
  const field = `questions.${id}`;
  if (!isPlainObject(value)) return refuse('invalid_body', field, `${field} must be a question.`);
  for (const key of Object.keys(value))
    if (!['type', 'instructions', 'criteria'].includes(key))
      refuse('unsupported_field', `${field}.${key}`, `A question carries only a type, instructions and criteria, so ${field}.${key} was refused.`);
  const type = value.type;
  if (typeof type !== 'string') return refuse('invalid_body', `${field}.type`, `${field}.type must be choice, score or boolean.`);
  if (!['choice', 'score', 'boolean'].includes(type))
    refuse('unsupported_field', `${field}.type`, `${type} questions aren't asked here; use choice, score or boolean.`);
  const instructions = words(value.instructions, `${field}.instructions`, EVALUATION_WIRE_BOUNDS.maxTextChars);
  const criteria = value.criteria;

  if (type === 'choice') {
    if (!isPlainObject(criteria)) return refuse('invalid_body', `${field}.criteria`, `${field}.criteria must name the options.`);
    const options = Object.entries(criteria);
    if (options.length < 1 || options.length > EVALUATION_WIRE_BOUNDS.maxOptions)
      refuse('invalid_body', `${field}.criteria`, `A choice offers 1 to ${EVALUATION_WIRE_BOUNDS.maxOptions} options.`);
    for (const [option, description] of options) {
      if (!option.trim() || option.length > EVALUATION_WIRE_BOUNDS.maxOptionIdChars)
        refuse('invalid_body', `${field}.criteria`, `An option id is 1 to ${EVALUATION_WIRE_BOUNDS.maxOptionIdChars} characters.`);
      if (description !== null) words(description, `${field}.criteria.${option}`, EVALUATION_WIRE_BOUNDS.maxTextChars);
    }
    return { type: 'choice', instructions, criteria: criteria as Record<string, string | null> };
  }

  if (type === 'score') {
    if (!Array.isArray(criteria)) return refuse('invalid_body', `${field}.criteria`, `${field}.criteria must list the levels, lowest first.`);
    if (criteria.length < EVALUATION_WIRE_BOUNDS.minLevels || criteria.length > EVALUATION_WIRE_BOUNDS.maxLevels)
      refuse('invalid_body', `${field}.criteria`, `A score has ${EVALUATION_WIRE_BOUNDS.minLevels} to ${EVALUATION_WIRE_BOUNDS.maxLevels} levels.`);
    criteria.forEach((level, index) => {
      if (level === null)
        refuse('unsupported_field', `${field}.criteria[${index}]`, `Every score level needs a description here, and ${field}.criteria[${index}] has none.`);
      words(level, `${field}.criteria[${index}]`, EVALUATION_WIRE_BOUNDS.maxTextChars);
    });
    return { type: 'score', instructions, criteria: criteria as string[] };
  }

  if (criteria === undefined) return { type: 'boolean', instructions };
  if (!isPlainObject(criteria)) return refuse('invalid_body', `${field}.criteria`, `${field}.criteria must describe true and false.`);
  for (const key of Object.keys(criteria))
    if (key !== 'true' && key !== 'false')
      refuse('unsupported_field', `${field}.criteria.${key}`, `A yes-or-no question describes only true and false, so ${field}.criteria.${key} was refused.`);
  const whenTrue = criteria.true ?? null;
  const whenFalse = criteria.false ?? null;
  if (whenTrue !== null) words(whenTrue, `${field}.criteria.true`, EVALUATION_WIRE_BOUNDS.maxTextChars);
  if (whenFalse !== null) words(whenFalse, `${field}.criteria.false`, EVALUATION_WIRE_BOUNDS.maxTextChars);
  if ((whenTrue === null) !== (whenFalse === null))
    refuse('unsupported_field', `${field}.criteria`, `A yes-or-no question describes both true and false here, or neither.`);
  return whenTrue === null
    ? { type: 'boolean', instructions }
    : { type: 'boolean', instructions, criteria: { true: whenTrue as string, false: whenFalse as string } };
}

function check(value: unknown, limits: EvaluationRequestLimits): EvaluationRequest {
  if (!isPlainObject(value)) return refuse('invalid_body', 'body', 'The request body must be a JSON object.');
  for (const key of Object.keys(value))
    if (key !== 'state' && key !== 'questions')
      refuse('unsupported_field', key, `An evaluation carries only a state and its questions, so ${key} was refused.`);
  const state = value.state;
  if (typeof state !== 'string' && !Array.isArray(state) && !isPlainObject(state))
    refuse('invalid_body', 'state', 'state must be text, a list or an object.');
  checkState(state, 0);
  const given = value.questions;
  if (!isPlainObject(given)) return refuse('invalid_body', 'questions', 'questions must map each question id to its question.');
  const ids = Object.keys(given);
  if (ids.length === 0) refuse('invalid_body', 'questions', 'An evaluation asks at least one question.');
  if (ids.length > EVALUATION_WIRE_BOUNDS.maxQuestions)
    refuse('request_too_large', 'questions', `An evaluation asks at most ${EVALUATION_WIRE_BOUNDS.maxQuestions} questions.`);
  const checked: [string, ProviderQuestion][] = [];
  for (const id of ids) {
    if (!id.trim() || id.length > EVALUATION_WIRE_BOUNDS.maxQuestionIdChars)
      refuse('invalid_body', 'questions', `A question id is 1 to ${EVALUATION_WIRE_BOUNDS.maxQuestionIdChars} characters.`);
    checked.push([id, checkQuestion(id, given[id])]);
  }
  // Own properties only, whatever the ids are called.
  const questions: Record<string, ProviderQuestion> = Object.fromEntries(checked);
  const stateTokens = serializedStateTokens(state);
  if (stateTokens > EVALUATION_ROUTE_LIMITS.maxStateTokens)
    refuse('request_too_large', 'state', `The state is about ${stateTokens.toLocaleString('en-US')} tokens, over the ${EVALUATION_ROUTE_LIMITS.maxStateTokens.toLocaleString('en-US')} this route accepts.`);
  const size = serializedRequestTokens(state, questions);
  if (size.total > limits.maxTotalTokens)
    refuse('request_too_large', 'body', `The whole request is about ${size.total.toLocaleString('en-US')} tokens, over the ${limits.maxTotalTokens.toLocaleString('en-US')} this route accepts.`);
  if (size.statePlusLongestQuestion > limits.maxStatePlusLongestQuestionTokens)
    refuse('request_too_large', 'body', `The state and the longest question are about ${size.statePlusLongestQuestion.toLocaleString('en-US')} tokens together, over the ${limits.maxStatePlusLongestQuestionTokens.toLocaleString('en-US')} this route accepts.`);
  return { state: state as EvaluationRequest['state'], questions };
}

/**
 * Check a parsed request body against the evaluation allowlist: exactly a state
 * and a question map, every question a choice, score or boolean in the shape a
 * route can send, inside the route's token bounds. The first thing outside it is
 * named. The questions that come back are rebuilt from what was checked, so a
 * field the check did not read cannot travel on.
 */
export function checkEvaluationRequest(
  value: unknown,
  limits: EvaluationRequestLimits = UNPROVEN_ROUTE_LIMITS,
): { ok: true; request: EvaluationRequest } | EvaluationRequestRefusal {
  try {
    return { ok: true, request: check(value, limits) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, code: error.code, field: error.field, message: error.message };
    throw error;
  }
}
