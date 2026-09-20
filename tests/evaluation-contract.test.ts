/**
 * The evaluation contract, proven against its own rules.
 *
 * An evaluation is a bounded decision asked of an external model: which of
 * these already-authorized candidates matter, how strongly, yes or no. It is
 * not a completion, and its answer is not an authorization. These tests pin the
 * three things that distinguish it from a text response — that a returned name
 * must already be a candidate, that an unknown number stays unknown instead of
 * becoming zero, and that a probability is never read as a confidence or a
 * permission.
 *
 * Every fixture is invented. No business, person, document or figure is real.
 */
import { describe, expect, test } from 'vitest';
import {
  EVALUATION_CONTRACT_VERSION,
  MAX_EVALUATION_RESPONSE_BYTES,
  EvaluationContractError,
  booleanQuestion,
  chosenOption,
  choiceQuestion,
  evaluationProfile,
  profileDigest,
  scoreQuestion,
  validateEvaluationResult,
  type EvaluationProfile,
} from '../shared/evaluation.js';

const AT = '2026-09-19T09:00:00.000Z';

// --- fixtures -----------------------------------------------------------------

/** The three authorized candidate sources for the synthetic supplier review. */
const SOURCES = [
  { id: 'src-current-invoice', description: 'Current period invoice, Supplier A' },
  { id: 'src-prior-invoice', description: 'Prior period invoice, Supplier A' },
  { id: 'src-attachment-07', description: 'Attachment 07, unnamed' },
] as const;

const relevance = (): EvaluationProfile =>
  evaluationProfile({
    profileId: 'thread-preparation.source-relevance',
    revision: 1,
    purpose: 'thread-preparation',
    questions: [
      choiceQuestion({
        id: 'most-relevant',
        instructions: 'Which source answers whether this supplier raised its prices?',
        options: SOURCES.map((s) => ({ id: s.id, description: s.description })),
      }),
      scoreQuestion({
        id: 'ambiguity',
        instructions: 'How ambiguous is the request?',
        levels: ['unambiguous', 'some ambiguity', 'materially ambiguous'],
      }),
      booleanQuestion({
        id: 'needs-history',
        instructions: 'Does answering require a prior period?',
      }),
    ],
  });

/**
 * A well-formed provider reply for `relevance()`.
 *
 * Deliberately typed loosely: these tests exist to corrupt it in the ways a
 * real provider might, and a narrow inferred literal type would stop the
 * compiler before the contract ever got the chance to refuse.
 */
type RawReply = {
  answers: Record<string, Record<string, unknown>>;
  usage?: { inputTokens?: number; outputTokens?: number };
  warnings: unknown[];
  response: Record<string, unknown>;
  rounding?: Record<string, unknown>;
};

const wellFormed = (): RawReply => ({
  answers: {
    'most-relevant': {
      type: 'choice',
      choice: 'src-attachment-07',
      probabilities: {
        'src-current-invoice': 0.25,
        'src-prior-invoice': 0.15,
        'src-attachment-07': 0.6,
      },
    },
    ambiguity: { type: 'score', score: 0.5, probabilities: { '0': 0.5, '1': 0.5, '2': 0 } },
    'needs-history': { type: 'boolean', probability: 0.91 },
  },
  usage: { inputTokens: 1840, outputTokens: undefined },
  warnings: [],
  response: { modelId: 'jev-1.13.0', id: 'req_abc123', timestamp: AT },
});

const validate = (raw: unknown, profile = relevance()) =>
  validateEvaluationResult(profile, raw, { requestedModel: 'typesafe-ai/jev', observedAt: AT });

const refusal = (raw: unknown, profile = relevance()): EvaluationContractError => {
  try {
    validate(raw, profile);
  } catch (error) {
    if (error instanceof EvaluationContractError) return error;
    throw error;
  }
  throw new Error('Expected the contract to refuse this result.');
};

// --- the profile --------------------------------------------------------------

describe('the question profile', () => {
  test('carries its contract version, so an old saved profile is recognisable', () => {
    expect(relevance().contractVersion).toBe(EVALUATION_CONTRACT_VERSION);
  });

  test('digests to the same value for the same questions and differs on any change', () => {
    expect(profileDigest(relevance())).toBe(profileDigest(relevance()));
    const reworded = evaluationProfile({
      ...relevance(),
      questions: [
        choiceQuestion({
          id: 'most-relevant',
          instructions: 'Which source is most relevant?',
          options: SOURCES.map((s) => ({ id: s.id, description: s.description })),
        }),
        ...relevance().questions.slice(1),
      ],
    });
    expect(profileDigest(reworded)).not.toBe(profileDigest(relevance()));
  });

  test('refuses a choice question with no options, and a score with fewer than two levels', () => {
    expect(() => choiceQuestion({ id: 'q', instructions: 'i', options: [] })).toThrow(
      EvaluationContractError,
    );
    expect(() => scoreQuestion({ id: 'q', instructions: 'i', levels: ['only'] })).toThrow(
      EvaluationContractError,
    );
  });

  test('refuses two questions with the same id, because answers are keyed by it', () => {
    expect(() =>
      evaluationProfile({
        profileId: 'p',
        revision: 1,
        purpose: 'thread-preparation',
        questions: [
          booleanQuestion({ id: 'same', instructions: 'a' }),
          booleanQuestion({ id: 'same', instructions: 'b' }),
        ],
      }),
    ).toThrow(EvaluationContractError);
  });

  test('refuses two options with the same id in one question', () => {
    expect(() =>
      choiceQuestion({
        id: 'q',
        instructions: 'i',
        options: [
          { id: 'dup', description: null },
          { id: 'dup', description: null },
        ],
      }),
    ).toThrow(EvaluationContractError);
  });
});

// --- a well-formed result -----------------------------------------------------

describe('a well-formed result', () => {
  test('validates, and every answer is bound to the question it answers', () => {
    const observed = validate(wellFormed());
    expect(observed.answers.map((a) => a.questionId)).toEqual([
      'most-relevant',
      'ambiguity',
      'needs-history',
    ]);
    expect(observed.profileDigest).toBe(profileDigest(relevance()));
  });

  test('records what the model actually reported, not what was asked for', () => {
    const observed = validate(wellFormed());
    expect(observed.requestedModel).toBe('typesafe-ai/jev');
    expect(observed.actualModel).toBe('jev-1.13.0');
  });

  test('resolves a choice back to the authorized candidate id', () => {
    expect(chosenOption(validate(wellFormed()), 'most-relevant')).toBe('src-attachment-07');
  });

  test('returns null for a question the profile does not contain', () => {
    expect(chosenOption(validate(wellFormed()), 'no-such-question')).toBeNull();
  });
});

// --- a returned name is never authority ---------------------------------------

describe('an option the caller never offered', () => {
  test('is refused before anything can consume it', () => {
    const raw = wellFormed();
    raw.answers['most-relevant'].choice = 'src-payroll-notes';
    const error = refusal(raw);
    expect(error.code).toBe('unknown_option');
    expect(error.message).toMatch(/src-payroll-notes/);
  });

  test('is refused even when it appears only in the distribution', () => {
    const raw = wellFormed();
    raw.answers['most-relevant'].probabilities = {
      ...(raw.answers['most-relevant'].probabilities as Record<string, number>),
      'src-payroll-notes': 0,
    };
    expect(refusal(raw).code).toBe('unknown_option');
  });
});

// --- strictness ---------------------------------------------------------------

describe('a malformed result', () => {
  test('is refused when a question is missing, rather than consumed in part', () => {
    const raw = wellFormed();
    delete (raw.answers as Record<string, unknown>).ambiguity;
    expect(refusal(raw).code).toBe('missing_answer');
  });

  test('is refused when it answers a question that was not asked', () => {
    const raw = wellFormed();
    (raw.answers as Record<string, unknown>)['invented'] = { type: 'boolean', probability: 1 };
    expect(refusal(raw).code).toBe('unknown_question');
  });

  test('is refused when the primitive is not the one the question declared', () => {
    const raw = wellFormed();
    (raw.answers as Record<string, unknown>)['needs-history'] = {
      type: 'choice',
      choice: 'src-prior-invoice',
    };
    expect(refusal(raw).code).toBe('wrong_primitive');
  });

  test.each([
    ['not a number', 'x'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['below zero', -0.1],
    ['above one', 1.1],
  ])('is refused when a probability is %s', (_label, value) => {
    const raw = wellFormed();
    (raw.answers['needs-history'] as { probability: unknown }).probability = value;
    expect(refusal(raw).code).toBe('invalid_probability');
  });

  test('is refused when a score falls outside its own levels', () => {
    const raw = wellFormed();
    (raw.answers.ambiguity as { score: number; probabilities?: unknown }).score = 2.5;
    delete (raw.answers.ambiguity as { probabilities?: unknown }).probabilities;
    expect(refusal(raw).code).toBe('invalid_score');
  });

  test('is refused when a distribution does not sum to one beyond the rounding tolerance', () => {
    const raw = wellFormed();
    raw.answers['most-relevant'].probabilities = {
      'src-current-invoice': 0.25,
      'src-prior-invoice': 0.15,
      'src-attachment-07': 0.1,
    };
    expect(refusal(raw).code).toBe('invalid_distribution');
  });

  test('accepts a rounded distribution within half a unit in the last place', () => {
    const raw = wellFormed();
    raw.answers['most-relevant'].probabilities = {
      'src-current-invoice': 0.33,
      'src-prior-invoice': 0.33,
      'src-attachment-07': 0.33,
    };
    (raw as { rounding?: unknown }).rounding = { probabilityDecimals: 2 };
    expect(() => validate(raw)).not.toThrow();
  });

  test('is refused when the payload is larger than the response cap', () => {
    const raw = wellFormed();
    (raw as { warnings: string[] }).warnings = ['w'.repeat(MAX_EVALUATION_RESPONSE_BYTES)];
    expect(refusal(raw).code).toBe('response_too_large');
  });

  test('is refused when the choice is absent from its own distribution', () => {
    const raw = wellFormed();
    raw.answers['most-relevant'].probabilities = {
      'src-current-invoice': 0.5,
      'src-prior-invoice': 0.5,
    };
    expect(refusal(raw).code).toBe('invalid_distribution');
  });
});

// --- unknown stays unknown ----------------------------------------------------

describe('what the provider did not say', () => {
  test('leaves absent usage unknown rather than reporting zero', () => {
    const observed = validate(wellFormed());
    expect(observed.usage.inputTokens).toBe(1840);
    expect(observed.usage.outputTokens).toBeNull();
  });

  test('leaves usage entirely unknown when the provider reports none', () => {
    const raw = wellFormed();
    delete (raw as { usage?: unknown }).usage;
    const observed = validate(raw);
    expect(observed.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  test('leaves the actual model unknown rather than echoing the requested one', () => {
    const raw = wellFormed();
    delete (raw.response as { modelId?: unknown }).modelId;
    const observed = validate(raw);
    expect(observed.actualModel).toBeNull();
    expect(observed.requestedModel).toBe('typesafe-ai/jev');
  });

  test('leaves an absent distribution null rather than inventing a uniform one', () => {
    const raw = wellFormed();
    delete (raw.answers['most-relevant'] as { probabilities?: unknown }).probabilities;
    const [choice] = validate(raw).answers;
    expect(choice.type).toBe('choice');
    if (choice.type === 'choice') expect(choice.probabilities).toBeNull();
  });
});

// --- a probability is not a confidence, and not a permission ------------------

describe('the shape of an answer', () => {
  test('never carries a field called confidence', () => {
    const observed = validate(wellFormed());
    for (const answer of observed.answers)
      expect(Object.keys(answer)).not.toContain('confidence');
    expect(JSON.stringify(observed)).not.toMatch(/confidence/i);
  });

  test('is plain JSON, so it survives the run record unchanged', () => {
    const observed = validate(wellFormed());
    expect(JSON.parse(JSON.stringify(observed))).toEqual(observed);
  });

  test('carries no permission, capability, approval or authority field', () => {
    const text = JSON.stringify(validate(wellFormed()));
    for (const forbidden of ['permission', 'capability', 'approved', 'authority', 'grant'])
      expect(text).not.toMatch(new RegExp(forbidden, 'i'));
  });
});
