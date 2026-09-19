/**
 * The supplier price review, end to end and offline.
 *
 * This is the example the handoff package makes mandatory, and it is the right
 * one, because it is a task where the obvious answer is wrong. A synthetic
 * project holds current invoices, prior invoices, a supplier contract, a later
 * rebate amendment whose filename says nothing, staff meeting notes and a
 * marketing draft. The question is whether the supplier became more expensive.
 *
 * Read only the invoices and the answer is "yes, five per cent". Read the
 * amendment too and the answer is "no, it fell five per cent". The whole value
 * of selecting context is whether the document with the unhelpful name survives
 * — and the whole risk of selecting context is that it does not.
 *
 * So this file runs the real path: the eligibility predicate, then a scripted
 * evaluation through the real transport and the real validator, then the real
 * selection, and finally the arithmetic a main model would be asked to do on
 * what it was handed. Nothing here is mocked except the provider's answer, and
 * no provider is contacted.
 *
 * Every figure is invented. No supplier, business or amount is real.
 */
import { describe, expect, test } from 'vitest';
import { preflightDecision } from '../shared/evaluation-eligibility.js';
import {
  choiceQuestion,
  booleanQuestion,
  evaluationProfile,
  chosenOption,
  trueProbability,
} from '../shared/evaluation.js';
import { runEvaluation, scriptedEvaluationPort } from '../server/harness/evaluation-adapter.js';
import { selectContext, type SelectableSource } from '../shared/evaluation-selection.js';
import { EVALUATION_PRICE_JEV_113, evaluationCost } from '../server/harness/evaluation-price.js';

const AT = '2026-09-19T09:00:00.000Z';

// --- the synthetic project ----------------------------------------------------

/**
 * `attachment-07` is the trap: a rebate amendment that changes the answer and
 * whose name gives no hint of it. `staff-notes` and `marketing-draft` are the
 * genuinely irrelevant material this feature exists to leave behind.
 */
const PROJECT: SelectableSource[] = [
  { id: 'report-only-policy', revision: 1, authority: 'protected', bytes: 200, conflictsWith: [] },
  { id: 'current-invoice', revision: 1, authority: 'requested', bytes: 900, conflictsWith: [] },
  { id: 'prior-invoice', revision: 1, authority: 'optional', bytes: 900, conflictsWith: [] },
  { id: 'supplier-contract', revision: 1, authority: 'optional', bytes: 1_400, conflictsWith: ['attachment-07'] },
  { id: 'attachment-07', revision: 2, authority: 'optional', bytes: 700, conflictsWith: ['supplier-contract'] },
  { id: 'staff-notes', revision: 1, authority: 'optional', bytes: 2_600, conflictsWith: [] },
  { id: 'marketing-draft', revision: 1, authority: 'optional', bytes: 4_100, conflictsWith: [] },
];

/** The facts each document actually carries, for the arithmetic at the end. */
const FACTS = {
  'prior-invoice': { cases: 10, perCase: 40, rebatePerCase: 0 },
  'current-invoice': { cases: 10, perCase: 42, rebatePerCase: 0 },
  'attachment-07': { rebatePerCase: 4 },
} as const;

const profile = () =>
  evaluationProfile({
    profileId: 'thread-preparation.supplier-price-review',
    revision: 1,
    purpose: 'thread-preparation',
    questions: [
      choiceQuestion({
        id: 'most-relevant',
        instructions:
          'Which single source is most needed to decide whether this supplier raised its prices?',
        options: PROJECT.filter((s) => s.authority === 'optional').map((s) => ({
          id: s.id,
          description: null,
        })),
      }),
      booleanQuestion({
        id: 'needs-prior-period',
        instructions: 'Does answering this require a prior period to compare against?',
      }),
    ],
  });

/** What a helper that did its job returns. */
const goodAnswer = {
  answers: {
    'most-relevant': {
      type: 'choice',
      choice: 'attachment-07',
      probabilities: {
        'prior-invoice': 0.25,
        'supplier-contract': 0.1,
        'attachment-07': 0.6,
        'staff-notes': 0.03,
        'marketing-draft': 0.02,
      },
    },
    'needs-prior-period': { type: 'boolean', probability: 0.97 },
  },
  usage: { inputTokens: 2_400 },
  warnings: [],
  response: { modelId: 'jev-1.13.0', id: 'req_synthetic_01' },
};

const prepare = async (result: unknown) =>
  runEvaluation({
    port: scriptedEvaluationPort({ result, requestedModel: 'typesafe-ai/jev' }),
    profile: profile(),
    state: 'A synthetic supplier review over six project documents.',
    signal: new AbortController().signal,
    observedAt: AT,
  });

const eligible = {
  turnsAlready: 0,
  wake: false,
  replayedCommand: false,
  route: 'claude-code',
  processing: 'cloud-permitted' as const,
  featureEnabled: true,
  disclosureConsented: true,
  candidateCount: PROJECT.length,
  pricedRoute: true,
  helperBudgetRemainingMicroUsd: 10_000,
  reservationCeilingMicroUsd: 1_344,
};

// --- the journey --------------------------------------------------------------

describe('a supplier price review that should prepare', () => {
  test('is eligible: six candidates, a cloud-permitted route, a funded helper', () => {
    expect(preflightDecision(eligible)).toEqual({ fire: true });
  });

  test('keeps the rebate amendment its filename would have hidden', async () => {
    const observed = await prepare(goodAnswer);
    expect(chosenOption(observed, 'most-relevant')).toBe('attachment-07');

    const { selected } = selectContext({
      candidates: PROJECT,
      ranked: ['attachment-07', 'current-invoice', 'prior-invoice'],
      budgetBytes: 6_000,
      coverageRequired: false,
    });
    expect(selected).toContain('attachment-07');
  });

  test('leaves the staff notes and the marketing draft behind', async () => {
    const { selected, omitted } = selectContext({
      candidates: PROJECT,
      ranked: ['attachment-07', 'current-invoice', 'prior-invoice'],
      budgetBytes: 6_000,
      coverageRequired: false,
    });
    expect(selected).not.toContain('staff-notes');
    expect(selected).not.toContain('marketing-draft');
    // Left behind, not lost: each one is on the record with a reason.
    expect(omitted.map((o) => o.id).sort()).toEqual(['marketing-draft', 'staff-notes']);
  });

  test('carries the contract along with the amendment that changes it', () => {
    // Selecting one of a contradicting pair would read as agreement.
    const { selected } = selectContext({
      candidates: PROJECT,
      ranked: ['attachment-07'],
      budgetBytes: 6_000,
      coverageRequired: false,
    });
    expect(selected).toContain('supplier-contract');
  });

  test('never drops the report-only instruction, which scored nothing at all', async () => {
    const { selected, protectedRetained } = selectContext({
      candidates: PROJECT,
      ranked: ['attachment-07'],
      budgetBytes: 6_000,
      coverageRequired: false,
    });
    expect(selected).toContain('report-only-policy');
    expect(protectedRetained).toEqual(['report-only-policy']);
  });
});

// --- the answer the selection makes possible ----------------------------------

/** What a main model computes deterministically from what it was handed. */
function priceMovement(selected: readonly string[]) {
  const has = (id: string) => selected.includes(id);
  if (!has('current-invoice')) return { known: false as const, why: 'no current period' };
  if (!has('prior-invoice')) return { known: false as const, why: 'no prior period' };
  const rebate = has('attachment-07') ? FACTS['attachment-07'].rebatePerCase : 0;
  const before = FACTS['prior-invoice'].perCase;
  const after = FACTS['current-invoice'].perCase - rebate;
  return { known: true as const, before, after, direction: after > before ? 'up' : 'down' };
}

describe('the answer that selection makes possible', () => {
  test('is that the supplier got cheaper, which the invoices alone deny', () => {
    const withAmendment = priceMovement([
      'current-invoice',
      'prior-invoice',
      'attachment-07',
    ]);
    expect(withAmendment).toMatchObject({ known: true, before: 40, after: 38, direction: 'down' });

    // The same arithmetic on the obvious selection gets the sign wrong.
    const withoutAmendment = priceMovement(['current-invoice', 'prior-invoice']);
    expect(withoutAmendment).toMatchObject({ known: true, direction: 'up' });
  });

  test('is unknown, not invented, when the prior period is missing', () => {
    // Doc 04: current totals may be calculated; a historical change stays
    // unknown rather than guessed.
    const missing = PROJECT.filter((s) => s.id !== 'prior-invoice');
    const { selected } = selectContext({
      candidates: missing,
      ranked: ['attachment-07', 'current-invoice'],
      budgetBytes: 6_000,
      coverageRequired: false,
    });
    expect(priceMovement(selected)).toEqual({ known: false, why: 'no prior period' });
  });

  test('stays partial when the request asked for every location and one is absent', () => {
    const { coverage } = selectContext({
      candidates: PROJECT,
      ranked: ['attachment-07', 'current-invoice'],
      budgetBytes: 6_000,
      coverageRequired: true,
    });
    expect(coverage).toBe('partial');
  });
});

// --- what the helper is not allowed to do -------------------------------------

describe('a helper that answers badly', () => {
  test('cannot name a document the project does not have', async () => {
    await expect(
      prepare({
        ...goodAnswer,
        answers: {
          ...goodAnswer.answers,
          'most-relevant': { type: 'choice', choice: 'payroll-export' },
        },
      }),
    ).rejects.toMatchObject({ code: 'unknown_option' });
  });

  test('cannot make the task proceed by being confident about it', async () => {
    const observed = await prepare(goodAnswer);
    // A high probability is the model's estimate, not a finding and not a
    // permission. The task still has to go and read the prior period.
    expect(trueProbability(observed, 'needs-prior-period')).toBeGreaterThan(0.9);
    const missing = PROJECT.filter((s) => s.id !== 'prior-invoice');
    const { selected } = selectContext({
      candidates: missing,
      ranked: ['attachment-07', 'current-invoice'],
      budgetBytes: 6_000,
      coverageRequired: false,
    });
    expect(priceMovement(selected).known).toBe(false);
  });

  test('cannot pick the irrelevant documents into an obligation', async () => {
    const observed = await prepare({
      ...goodAnswer,
      answers: {
        ...goodAnswer.answers,
        'most-relevant': { type: 'choice', choice: 'marketing-draft' },
      },
    });
    const { selected, protectedRetained } = selectContext({
      candidates: PROJECT,
      ranked: [chosenOption(observed, 'most-relevant') ?? ''],
      budgetBytes: 6_000,
      coverageRequired: false,
    });
    // A bad ranking wastes budget. It cannot drop the policy or the document
    // the person asked for, which is the difference between bad and unsafe.
    expect(protectedRetained).toEqual(['report-only-policy']);
    expect(selected).toContain('current-invoice');
  });
});

// --- what it cost -------------------------------------------------------------

describe('what the preparation cost', () => {
  test('is a known, tiny, whole number of micro-USD', async () => {
    const observed = await prepare(goodAnswer);
    const cost = evaluationCost(EVALUATION_PRICE_JEV_113, observed.usage);
    expect(cost.known).toBe(true);
    // 2,400 input tokens at $0.042 per million.
    if (cost.known) expect(cost.microUsd).toBe(101);
  });

  test('is unknown, not zero, when the provider reports no usage', async () => {
    const observed = await prepare({ ...goodAnswer, usage: undefined });
    expect(evaluationCost(EVALUATION_PRICE_JEV_113, observed.usage).known).toBe(false);
  });

  test('is well inside the per-request ceiling, which is the point', async () => {
    const observed = await prepare(goodAnswer);
    const cost = evaluationCost(EVALUATION_PRICE_JEV_113, observed.usage);
    // The internal ceiling on a whole request is 100,000 micro-USD. A
    // preparation that costs 101 is not what would exhaust it.
    if (cost.known) expect(cost.microUsd).toBeLessThan(100_000 / 100);
  });
});
