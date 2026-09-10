/**
 * The questionnaire state machine, on its own.
 *
 * These are the rules the host enforces in `server/workspaces.ts`. They live in
 * a pure module so the same order, the same reveal rules and the same refusals
 * apply whether the caller is the Console, a test or a later client.
 */
import { describe, expect, test } from 'vitest';
import {
  BUSINESS_QUESTIONS,
  BUSINESS_SETUP_SCHEMA_REVISION,
  REVIEW_STEP,
  collectFacts,
  containsSecretLikeText,
  displayValue,
  nextStep,
  previousStep,
  progress,
  readyForProposal,
  validateAnswer,
  visibleQuestions,
  type AnswerMap,
  type AnswerValue,
  type BusinessAnswer,
} from '../shared/business-setup.js';

const answer = (questionId: string, value: AnswerValue, unknown = false): BusinessAnswer => ({
  questionId,
  value,
  unknown,
  origin: 'person',
  at: '2026-09-10T00:00:00.000Z',
  by: 'person_test',
});

const build = (pairs: [string, AnswerValue, boolean?][]): AnswerMap =>
  Object.fromEntries(pairs.map(([id, value, unknown]) => [id, answer(id, value, unknown)]));

/** Every applicable question answered the shortest legitimate way. */
const complete = (job = 'prepare-quotes'): AnswerMap =>
  build([
    ['name', 'Ridge Cabinetry'],
    ['industry', null, true],
    ['job', job],
    ['result', 'A quote a person checks before it is sent.'],
    ['sources', ['files']],
    ['people', 'small-team'],
    ['locations', 'one'],
    ['human-required', ['sending', 'money']],
    ['data-leaving', 'non-sensitive'],
    ['host', null, true],
    ['spend-cap', 120],
    ['first-run', 'manual'],
  ]);

describe('question set', () => {
  test('every question carries a reason a person can read', () => {
    for (const question of BUSINESS_QUESTIONS) {
      expect(question.reason.length).toBeGreaterThan(20);
      expect(question.prompt.endsWith('?')).toBe(true);
    }
  });

  test('it is short: an intake, not a company survey', () => {
    expect(BUSINESS_QUESTIONS.length).toBeLessThanOrEqual(12);
  });
});

describe('order and resumption', () => {
  test('the first step is the first question and the last is the review', () => {
    expect(nextStep({})).toBe(BUSINESS_QUESTIONS[0]!.id);
    expect(nextStep(complete())).toBe(REVIEW_STEP);
    expect(readyForProposal(complete())).toBe(true);
  });

  test('a part-answered draft resumes at the first gap, not at the start', () => {
    const partial = build([
      ['name', 'Ridge Cabinetry'],
      ['industry', 'cabinetry'],
    ]);
    expect(nextStep(partial)).toBe('job');
  });

  test('an unresolved required question still blocks the proposal', () => {
    const answers = { ...complete(), result: answer('result', null, true) };
    expect(readyForProposal(answers)).toBe(false);
    expect(nextStep(answers)).toBe('result');
  });

  test('back walks the visible questions and stops at the first', () => {
    expect(previousStep(complete(), REVIEW_STEP)).toBe('first-run');
    expect(previousStep({}, BUSINESS_QUESTIONS[0]!.id)).toBeNull();
  });
});

describe('revealing deeper questions', () => {
  test('a notes job is never asked where the information lives', () => {
    const answers = build([
      ['name', 'Ridge Cabinetry'],
      ['industry', null, true],
      ['job', 'organise-notes'],
    ]);
    expect(visibleQuestions(answers).map((q) => q.id)).not.toContain('sources');
    expect(nextStep(answers)).toBe('result');
  });

  test('a one-person business is not asked about multiple locations', () => {
    const answers = build([
      ['name', 'Ridge Cabinetry'],
      ['industry', null, true],
      ['job', 'prepare-quotes'],
      ['result', 'A quote.'],
      ['sources', ['files']],
      ['people', 'just-me'],
    ]);
    expect(visibleQuestions(answers).map((q) => q.id)).not.toContain('locations');
    expect(nextStep(answers)).toBe('human-required');
  });

  test('a question that stops applying does not block the flow', () => {
    // Answered while it applied, then hidden by a later change of job.
    const answers = build([
      ['name', 'Ridge Cabinetry'],
      ['industry', null, true],
      ['job', 'organise-notes'],
      ['result', 'A written record.'],
      ['sources', ['email']],
      ['people', 'just-me'],
      ['human-required', ['everything']],
      ['data-leaving', 'no'],
      ['host', null, true],
      ['spend-cap', null, true],
      ['first-run', 'manual'],
    ]);
    expect(readyForProposal(answers)).toBe(true);
    expect(collectFacts(answers).map((f) => f.questionId)).not.toContain('sources');
  });
});

describe('what an answer may contain', () => {
  test('a required question cannot be answered "unknown"', () => {
    const result = validateAnswer('name', { value: null, unknown: true }, {});
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem.code).toBe('required');
  });

  test('an optional question may be left unknown', () => {
    const result = validateAnswer('industry', { value: null, unknown: true }, {});
    expect(result).toEqual({ ok: true, value: null, unknown: true });
  });

  test('a question that does not apply is refused rather than stored', () => {
    const answers = build([['job', 'organise-notes']]);
    const result = validateAnswer('sources', { value: ['files'], unknown: false }, answers);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem.code).toBe('not-visible');
  });

  test('a choice outside the list is refused unless the question allows one', () => {
    expect(validateAnswer('people', { value: 'made-up', unknown: false }, {}).ok).toBe(false);
    expect(validateAnswer('job', { value: 'Something we do', unknown: false }, {}).ok).toBe(true);
  });

  test('a spending limit is a bounded whole number of dollars', () => {
    expect(validateAnswer('spend-cap', { value: 250.4, unknown: false }, {})).toEqual({
      ok: true,
      value: 250,
      unknown: false,
    });
    expect(validateAnswer('spend-cap', { value: -1, unknown: false }, {}).ok).toBe(false);
    expect(validateAnswer('spend-cap', { value: 'lots' as never, unknown: false }, {}).ok).toBe(
      false,
    );
  });

  test('credentials and card numbers are refused, not stored', () => {
    for (const text of [
      'our key is sk-live-AbCdEfGhIjKlMnOpQrSt',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'password: hunter2',
      'AKIAIOSFODNN7EXAMPLE',
      'card 4242 4242 4242 4242',
    ]) {
      expect(containsSecretLikeText(text)).toBe(true);
      const result = validateAnswer('result', { value: text, unknown: false }, {});
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.problem.code).toBe('secret-like');
    }
  });

  test('ordinary business text is not mistaken for a credential', () => {
    for (const text of [
      'A quote a person checks before it is sent to the customer.',
      'We keep job files in a shared drive, one folder per address.',
      'Invoice 4242 goes out on the first of the month.',
    ])
      expect(containsSecretLikeText(text)).toBe(false);
  });
});

describe('what the review shows', () => {
  test('unresolved questions stay visible as unresolved', () => {
    const answers = { ...complete(), host: answer('host', null, true) };
    const fact = collectFacts(answers).find((item) => item.questionId === 'host');
    expect(fact?.origin).toBe('unresolved');
    expect(fact?.display).toBe('Not answered');
  });

  test('facts keep the origin they were recorded with', () => {
    const facts = collectFacts(complete());
    expect(facts.find((item) => item.questionId === 'name')?.origin).toBe('person');
  });

  test('values read as labels rather than identifiers', () => {
    const job = BUSINESS_QUESTIONS.find((q) => q.id === 'job')!;
    expect(displayValue(job, 'prepare-quotes')).toBe('Prepare quotes, estimates or proposals');
    const cap = BUSINESS_QUESTIONS.find((q) => q.id === 'spend-cap')!;
    expect(displayValue(cap, 1200)).toBe('$1,200 per month');
  });

  test('progress counts only the questions that apply', () => {
    const answers = build([
      ['name', 'Ridge Cabinetry'],
      ['industry', null, true],
      ['job', 'organise-notes'],
    ]);
    const counts = progress(answers);
    expect(counts.answered).toBe(3);
    expect(counts.total).toBe(BUSINESS_QUESTIONS.length - 1);
  });
});

test('the schema revision is stated, so a stale draft can be recognised', () => {
  expect(BUSINESS_SETUP_SCHEMA_REVISION).toBe(1);
});
