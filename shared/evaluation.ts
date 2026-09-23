/**
 * The evaluation contract: a bounded decision asked of an external model.
 *
 * An evaluation is not a completion. A completion is open text that the product
 * then has to interpret; an evaluation is a judgment over a set of candidates
 * the product already authorized, returned as a primitive it declared in
 * advance. That difference is what makes the answer safe to consume without a
 * second model reading it, and it is the only reason this contract exists
 * separately from `ModelRequest`.
 *
 * Three rules carry the weight, and each has a test:
 *
 * 1. **A returned name is never authority.** Options are ids the caller already
 *    resolved and was already permitted to use. A name that was not offered is
 *    refused before anything consumes it — it cannot become a source, a tool or
 *    a route by being spelled.
 * 2. **Unknown stays unknown.** A provider that reports no token count has not
 *    reported zero, and a provider that does not say which model answered has
 *    not confirmed the one that was asked for. Both stay `null`, because a
 *    fabricated zero becomes a false cost and a fabricated identity becomes a
 *    false calibration.
 * 3. **A probability is not a confidence and not a permission.** The provider
 *    documents its boolean field as the model's estimated P(true) — explicitly
 *    "not confidence in either outcome". This contract therefore has no field
 *    called confidence anywhere, and nothing here grants or widens authority.
 *
 * The primitives mirror the provider's own three (choice, score, boolean)
 * deliberately. Inventing a fourth would mean translating at the boundary, and
 * a translation is a place for a meaning to change quietly.
 */
import { createHash } from 'node:crypto';

export const EVALUATION_CONTRACT_VERSION = 1 as const;

/**
 * The largest validated result this product will hold. A provider that returns
 * more has not returned a decision, and an unbounded answer would be written
 * into a run record that must stay readable.
 */
export const MAX_EVALUATION_RESPONSE_BYTES = 65_536;

/** Bounds on the profile itself, so an oversized question cannot be asked. */
const MAX_QUESTIONS = 32;
const MAX_OPTIONS = 64;
const MAX_LEVELS = 16;
const MAX_INSTRUCTION_CHARS = 4_000;

export type EvaluationErrorCode =
  | 'invalid_profile'
  | 'invalid_result'
  | 'missing_answer'
  | 'unknown_question'
  | 'unknown_option'
  | 'wrong_primitive'
  | 'invalid_probability'
  | 'invalid_score'
  | 'invalid_distribution'
  | 'response_too_large';

/** A refusal, never a repair. A malformed decision is discarded whole. */
export class EvaluationContractError extends Error {
  constructor(
    readonly code: EvaluationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvaluationContractError';
  }
}

const refuse = (code: EvaluationErrorCode, message: string): never => {
  throw new EvaluationContractError(code, message);
};

// --- what may be asked --------------------------------------------------------

/**
 * Why the decision is being asked. The purpose is recorded with the answer so a
 * later reader can tell a preparation from a mid-task check without inferring
 * it from the question wording.
 */
export type EvaluationPurpose =
  | 'thread-preparation'
  | 'evidence-ranking'
  | 'tool-selection'
  | 'route-recommendation'
  | 'source-support';

/** One already-authorized candidate. The id is the caller's, not the model's. */
export interface EvaluationOption {
  readonly id: string;
  readonly description: string | null;
}

export interface EvaluationChoiceQuestion {
  readonly id: string;
  readonly type: 'choice';
  readonly instructions: string;
  readonly options: readonly EvaluationOption[];
}

export interface EvaluationScoreQuestion {
  readonly id: string;
  readonly type: 'score';
  readonly instructions: string;
  /** Ordered levels, indexed from zero. At least two, or there is nothing to order. */
  readonly levels: readonly (string | null)[];
}

export interface EvaluationBooleanQuestion {
  readonly id: string;
  readonly type: 'boolean';
  readonly instructions: string;
  readonly whenTrue: string | null;
  readonly whenFalse: string | null;
}

export type EvaluationQuestion =
  | EvaluationChoiceQuestion
  | EvaluationScoreQuestion
  | EvaluationBooleanQuestion;

export type EvaluationPrimitive = EvaluationQuestion['type'];

export interface EvaluationProfile {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  /** Stable name of the question set, so a saved answer says what it answered. */
  readonly profileId: string;
  /** Bumped whenever the wording or the option meanings change. */
  readonly revision: number;
  readonly purpose: EvaluationPurpose;
  readonly questions: readonly EvaluationQuestion[];
}

const text = (value: unknown, what: string, max = MAX_INSTRUCTION_CHARS): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    refuse('invalid_profile', `${what} must be a non-empty string of at most ${max} characters.`);
  return value as string;
};

const optionalText = (value: unknown, what: string): string | null =>
  value === null || value === undefined ? null : text(value, what);

export function choiceQuestion(input: {
  id: string;
  instructions: string;
  options: readonly { id: string; description?: string | null }[];
}): EvaluationChoiceQuestion {
  const id = text(input.id, 'A question id', 120);
  if (!Array.isArray(input.options) || !input.options.length)
    refuse('invalid_profile', `Question ${id} offers no options, so there is nothing to choose.`);
  if (input.options.length > MAX_OPTIONS)
    refuse('invalid_profile', `Question ${id} offers more than ${MAX_OPTIONS} options.`);
  const options = input.options.map((option) => ({
    id: text(option.id, 'An option id', 200),
    description: optionalText(option.description, 'An option description'),
  }));
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.id))
      refuse('invalid_profile', `Question ${id} offers the option ${option.id} twice.`);
    seen.add(option.id);
  }
  return {
    id,
    type: 'choice',
    instructions: text(input.instructions, 'Question instructions'),
    options: Object.freeze(options),
  };
}

export function scoreQuestion(input: {
  id: string;
  instructions: string;
  levels: readonly (string | null)[];
}): EvaluationScoreQuestion {
  const id = text(input.id, 'A question id', 120);
  if (!Array.isArray(input.levels) || input.levels.length < 2)
    refuse('invalid_profile', `Question ${id} needs at least two ordered levels.`);
  if (input.levels.length > MAX_LEVELS)
    refuse('invalid_profile', `Question ${id} declares more than ${MAX_LEVELS} levels.`);
  return {
    id,
    type: 'score',
    instructions: text(input.instructions, 'Question instructions'),
    levels: Object.freeze(input.levels.map((level) => optionalText(level, 'A level description'))),
  };
}

export function booleanQuestion(input: {
  id: string;
  instructions: string;
  whenTrue?: string | null;
  whenFalse?: string | null;
}): EvaluationBooleanQuestion {
  return {
    id: text(input.id, 'A question id', 120),
    type: 'boolean',
    instructions: text(input.instructions, 'Question instructions'),
    whenTrue: optionalText(input.whenTrue, 'A true description'),
    whenFalse: optionalText(input.whenFalse, 'A false description'),
  };
}

export function evaluationProfile(input: {
  profileId: string;
  revision: number;
  purpose: EvaluationPurpose;
  questions: readonly EvaluationQuestion[];
}): EvaluationProfile {
  const profileId = text(input.profileId, 'A profile id', 200);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    refuse('invalid_profile', `Profile ${profileId} needs a positive integer revision.`);
  if (!Array.isArray(input.questions) || !input.questions.length)
    refuse('invalid_profile', `Profile ${profileId} asks nothing.`);
  if (input.questions.length > MAX_QUESTIONS)
    refuse('invalid_profile', `Profile ${profileId} asks more than ${MAX_QUESTIONS} questions.`);
  const seen = new Set<string>();
  for (const question of input.questions) {
    if (seen.has(question.id))
      refuse('invalid_profile', `Profile ${profileId} asks ${question.id} twice.`);
    seen.add(question.id);
  }
  return {
    contractVersion: EVALUATION_CONTRACT_VERSION,
    profileId,
    revision: input.revision,
    purpose: input.purpose,
    questions: Object.freeze([...input.questions]),
  };
}

/**
 * Sorted-key JSON, so the digest depends on the meaning and not on the order a
 * literal happened to be written in.
 */
const canonical = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
};

/**
 * What a saved answer is checked against. A reworded question, a renamed option
 * or a new candidate all change this, which is what makes a cached
 * recommendation stop applying instead of quietly applying to the wrong thing.
 */
export function profileDigest(profile: EvaluationProfile): string {
  return createHash('sha256')
    .update(
      canonical({
        contractVersion: profile.contractVersion,
        profileId: profile.profileId,
        revision: profile.revision,
        purpose: profile.purpose,
        questions: profile.questions,
      }),
    )
    .digest('hex');
}

// --- what may come back -------------------------------------------------------

export type EvaluationAnswer =
  | {
      readonly type: 'choice';
      readonly questionId: string;
      /** Always one of the option ids the caller offered. */
      readonly choice: string;
      /** The full distribution over those same ids, or null when none was given. */
      readonly probabilities: Readonly<Record<string, number>> | null;
    }
  | {
      readonly type: 'score';
      readonly questionId: string;
      /** A fractional position in [0, levels - 1]. */
      readonly score: number;
      /** Keyed by zero-based level index as a string, or null. */
      readonly probabilities: Readonly<Record<string, number>> | null;
    }
  | {
      readonly type: 'boolean';
      readonly questionId: string;
      /**
       * The model's estimated P(true), in [0, 1]. The provider documents this as
       * "not confidence in either outcome", and it is never read as one here.
       */
      readonly probability: number;
    };

/** Both fields null means the provider reported nothing, not that nothing was used. */
export interface EvaluationUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface EvaluationRounding {
  readonly probabilityDecimals: number | null;
  readonly scoreDecimals: number | null;
}

/**
 * One validated decision, bound to the exact questions it answered and the
 * model that actually answered them.
 */
export interface EvaluationObservation {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly profileDigest: string;
  readonly purpose: EvaluationPurpose;
  /** The route or model that was asked for. */
  readonly requestedModel: string;
  /** What the provider said answered. Null when it did not say. */
  readonly actualModel: string | null;
  readonly answers: readonly EvaluationAnswer[];
  readonly usage: EvaluationUsage;
  readonly rounding: EvaluationRounding;
  readonly warnings: readonly string[];
  readonly providerRequestId: string | null;
  readonly observedAt: string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const wholeTokens = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const decimals = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 12
    ? value
    : null;

const probability = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    refuse('invalid_probability', `${what} must be a finite number between 0 and 1.`);
  return value as number;
};

/**
 * Half a unit in the last place per rounded value, which is the tolerance the
 * provider's own contract documents. Unrounded values get a floating-point
 * epsilon and nothing more.
 */
const distributionTolerance = (count: number, places: number | null): number =>
  places === null ? 1e-9 : (count * 5) / 10 ** (places + 1) + 1e-9;

function distribution(
  raw: unknown,
  allowed: readonly string[],
  what: string,
  places: number | null,
): Readonly<Record<string, number>> | null {
  if (raw === null || raw === undefined) return null;
  const given = record(raw);
  if (!given) refuse('invalid_distribution', `${what} must be an object of option to probability.`);
  const permitted = new Set(allowed);
  const out: Record<string, number> = {};
  let total = 0;
  for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
    if (!permitted.has(key))
      refuse('unknown_option', `${what} scores ${key}, which was never offered.`);
    const p = probability(value, `${what} for ${key}`);
    out[key] = p;
    total += p;
  }
  if (Math.abs(total - 1) > distributionTolerance(Object.keys(out).length, places))
    refuse('invalid_distribution', `${what} sums to ${total}, not to one.`);
  return Object.freeze(out);
}

function answerFor(
  question: EvaluationQuestion,
  raw: unknown,
  places: EvaluationRounding,
): EvaluationAnswer {
  const given = record(raw);
  if (!given) refuse('invalid_result', `The answer to ${question.id} is not an object.`);
  const body = given as Record<string, unknown>;
  if (body.type !== question.type)
    refuse(
      'wrong_primitive',
      `Question ${question.id} is a ${question.type} question; the answer is a ${String(body.type)}.`,
    );

  if (question.type === 'choice') {
    const ids = question.options.map((option) => option.id);
    const choice = typeof body.choice === 'string' ? body.choice : '';
    if (!ids.includes(choice))
      refuse(
        'unknown_option',
        `Question ${question.id} was answered with ${String(body.choice)}, which was never offered.`,
      );
    const probabilities = distribution(
      body.probabilities,
      ids,
      `The distribution for ${question.id}`,
      places.probabilityDecimals,
    );
    if (probabilities && !(choice in probabilities))
      refuse(
        'invalid_distribution',
        `Question ${question.id} chose ${choice}, which its own distribution does not score.`,
      );
    // A choice its own distribution ranks below another option is not one
    // decision but two that disagree. The SDK core refuses the same thing.
    if (probabilities) {
      const slack = distributionTolerance(1, places.probabilityDecimals) * 2;
      const chosen = probabilities[choice];
      for (const [option, p] of Object.entries(probabilities))
        if (p > chosen + slack)
          refuse(
            'invalid_distribution',
            `Question ${question.id} chose ${choice}, but its own distribution ranks ${option} higher.`,
          );
    }
    return { type: 'choice', questionId: question.id, choice, probabilities };
  }

  if (question.type === 'score') {
    const top = question.levels.length - 1;
    const score = body.score;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > top)
      refuse(
        'invalid_score',
        `Question ${question.id} scores ${String(score)}, outside its range of 0 to ${top}.`,
      );
    const probabilities = distribution(
      body.probabilities,
      question.levels.map((_level, index) => String(index)),
      `The distribution for ${question.id}`,
      places.probabilityDecimals,
    );
    // A score is the distribution's weighted mean; a score that is not has
    // come from somewhere else. Tolerance is the declared rounding of both.
    if (probabilities) {
      const mean = Object.entries(probabilities).reduce(
        (total, [index, p]) => total + Number(index) * p,
        0,
      );
      const perLevel = distributionTolerance(1, places.probabilityDecimals);
      const slack =
        question.levels.reduce((total, _level, index) => total + index * perLevel, 0) +
        distributionTolerance(1, places.scoreDecimals) +
        1e-6;
      if (Math.abs(mean - (score as number)) > slack)
        refuse(
          'invalid_score',
          `Question ${question.id} scores ${String(score)}, but its own distribution averages ${mean}.`,
        );
    }
    return { type: 'score', questionId: question.id, score: score as number, probabilities };
  }

  return {
    type: 'boolean',
    questionId: question.id,
    probability: probability(body.probability, `The probability for ${question.id}`),
  };
}

/**
 * Validate a provider reply against the profile that produced it.
 *
 * Every question is answered exactly once with the primitive it declared, every
 * name is one the caller offered, every number is finite and in range, and
 * anything the provider left out stays left out. A result that fails any of
 * these is refused whole rather than consumed in part: a decision that is
 * partly wrong is not partly useful.
 */
export function validateEvaluationResult(
  profile: EvaluationProfile,
  raw: unknown,
  context: { requestedModel: string; observedAt: string },
): EvaluationObservation {
  const given = record(raw);
  if (!given) refuse('invalid_result', 'An evaluation result must be an object.');
  const body = given as Record<string, unknown>;

  if (canonical(body).length > MAX_EVALUATION_RESPONSE_BYTES)
    refuse(
      'response_too_large',
      `An evaluation result may not exceed ${MAX_EVALUATION_RESPONSE_BYTES} bytes.`,
    );

  const answers = record(body.answers);
  if (!answers) refuse('invalid_result', 'An evaluation result must carry an answers object.');

  const asked = new Set(profile.questions.map((question) => question.id));
  for (const key of Object.keys(answers as Record<string, unknown>))
    if (!asked.has(key))
      refuse('unknown_question', `The result answers ${key}, which was never asked.`);

  const roundingGiven = record(body.rounding);
  const rounding: EvaluationRounding = {
    probabilityDecimals: decimals(roundingGiven?.probabilityDecimals),
    scoreDecimals: decimals(roundingGiven?.scoreDecimals),
  };

  const validated: EvaluationAnswer[] = [];
  for (const question of profile.questions) {
    const answer = (answers as Record<string, unknown>)[question.id];
    if (answer === undefined || answer === null)
      refuse('missing_answer', `The result does not answer ${question.id}.`);
    validated.push(answerFor(question, answer, rounding));
  }

  const usageGiven = record(body.usage);
  const responseGiven = record(body.response);
  const warningsGiven = body.warnings;

  return {
    contractVersion: EVALUATION_CONTRACT_VERSION,
    profileId: profile.profileId,
    profileRevision: profile.revision,
    profileDigest: profileDigest(profile),
    purpose: profile.purpose,
    requestedModel: context.requestedModel,
    actualModel: typeof responseGiven?.modelId === 'string' ? responseGiven.modelId : null,
    answers: Object.freeze(validated),
    usage: {
      inputTokens: wholeTokens(usageGiven?.inputTokens),
      outputTokens: wholeTokens(usageGiven?.outputTokens),
    },
    rounding,
    warnings: Object.freeze(
      Array.isArray(warningsGiven)
        ? warningsGiven.map((warning) =>
            typeof warning === 'string' ? warning : JSON.stringify(warning),
          )
        : [],
    ),
    providerRequestId: typeof responseGiven?.id === 'string' ? responseGiven.id : null,
    observedAt: context.observedAt,
  };
}

// --- reading an answer --------------------------------------------------------

/**
 * The chosen candidate id, or null when that question was not asked or was not
 * a choice. Null is the honest answer for "no recommendation": the caller then
 * proceeds on its own ordinary path rather than on a guess.
 */
export function chosenOption(
  observation: EvaluationObservation,
  questionId: string,
): string | null {
  const answer = observation.answers.find((candidate) => candidate.questionId === questionId);
  return answer && answer.type === 'choice' ? answer.choice : null;
}

/** P(true) for a boolean question, or null when it was not asked. */
export function trueProbability(
  observation: EvaluationObservation,
  questionId: string,
): number | null {
  const answer = observation.answers.find((candidate) => candidate.questionId === questionId);
  return answer && answer.type === 'boolean' ? answer.probability : null;
}
