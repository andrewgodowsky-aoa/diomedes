/**
 * The preflight measurement harness: that it counts correctly, and what the
 * policy does on the synthetic examples. Offline and uncharged; the examples
 * and the answers are authored, so this pins the policy's behaviour, not a
 * model's accuracy.
 */
import { describe, expect, test } from 'vitest';
import {
  measurePreflight,
  SYNTHETIC_PREFLIGHT_CASES,
  tally,
  type ConfusionCounts,
  type PreflightCase,
} from '../server/harness/jev-advisor-measure.js';
import { DEFAULT_PREFLIGHT_THRESHOLDS } from '../server/harness/jev-advisor.js';

const counts = (): ConfusionCounts => ({
  truePositive: 0,
  falsePositive: 0,
  trueNegative: 0,
  falseNegative: 0,
  abstained: 0,
});

describe('the tally', () => {
  test('counts every outcome, and an abstention apart from both kinds of error', () => {
    const c = counts();
    tally(c, true, true);
    tally(c, true, false);
    tally(c, false, false);
    tally(c, false, true);
    tally(c, null, true);
    expect(c).toEqual({ truePositive: 1, falsePositive: 1, trueNegative: 1, falseNegative: 1, abstained: 1 });
  });
});

describe('a hand-computed set', () => {
  const cases: PreflightCase[] = [
    {
      id: 'right-raise',
      intent: 'Plan the week of deliveries around the new route.',
      sources: [],
      labels: { demanding: true, missingEvidence: false, needsClarification: false, needsReview: true },
      simulated: {
        workload: { lookup: 0.05, extraction: 0.05, planning: 0.85, reasoning: 0.05 },
        missing: 0.1,
        clarify: 0.1,
        review: 0.9,
      },
    },
    {
      id: 'wrong-raise',
      intent: 'Say hello to the new server in the staff chat.',
      sources: [],
      labels: { demanding: false, missingEvidence: false, needsClarification: false, needsReview: false },
      simulated: {
        workload: { lookup: 0.1, extraction: 0.1, planning: 0.1, reasoning: 0.7 },
        missing: 0.1,
        clarify: 0.1,
        review: 0.1,
      },
    },
    {
      id: 'outage',
      intent: 'Weigh the two quotes for the new fridge.',
      sources: [],
      labels: { demanding: true, missingEvidence: false, needsClarification: false, needsReview: false },
      simulated: 'unavailable',
    },
  ];

  test('gives exactly the rates the cases imply', async () => {
    const m = await measurePreflight(cases, DEFAULT_PREFLIGHT_THRESHOLDS);
    expect(m.cases).toBe(3);
    expect(m.unavailable).toBe(1);
    // Two demanding cases; the rule alone misses both; advice catches one, and
    // the outage stays on the rule's reading.
    expect(m.escalation.falsePassRate).toEqual({ baseline: 1, advised: 0.5 });
    // One ordinary case, raised wrongly by the advice.
    expect(m.escalation.falseEscalationRate).toEqual({ baseline: 0, advised: 1 });
    expect(m.needsReview).toEqual({ truePositive: 1, falsePositive: 0, trueNegative: 1, falseNegative: 0, abstained: 1 });
  });

  test('an outage is measured on the deterministic path, unchanged', async () => {
    const m = await measurePreflight(cases, DEFAULT_PREFLIGHT_THRESHOLDS);
    const outage = m.perCase.find((c) => c.id === 'outage')!;
    expect(outage.status).toBe('unavailable');
    expect(outage.advised).toBe(outage.baseline);
  });
});

describe('the synthetic set', () => {
  test('has both kinds of authored error, so the measurement is not trivially perfect', () => {
    expect(SYNTHETIC_PREFLIGHT_CASES.filter((c) => c.note?.startsWith('Authored wrong')).length).toBeGreaterThanOrEqual(3);
    expect(SYNTHETIC_PREFLIGHT_CASES.some((c) => c.simulated === 'unavailable')).toBe(true);
  });

  test('advice lowers false passes against the rule alone, and never lowers a reading', async () => {
    const m = await measurePreflight();
    expect(m.escalation.falsePassRate.advised).toBeLessThan(m.escalation.falsePassRate.baseline);
    for (const row of m.perCase) {
      if (row.baseline === 'demanding') expect(row.advised).toBe('demanding');
      if (row.baseline === 'greeting') expect(row.advised).toBe('greeting');
    }
  });

  test('pins the default-threshold figures, so a policy change shows up as a diff', async () => {
    const m = await measurePreflight();
    expect({
      falsePass: m.escalation.falsePassRate,
      falseEscalation: m.escalation.falseEscalationRate,
      unavailable: m.unavailable,
      missingEvidence: m.missingEvidence,
      needsReview: m.needsReview,
    }).toMatchInlineSnapshot(`
      {
        "falseEscalation": {
          "advised": 0.1111111111111111,
          "baseline": 0,
        },
        "falsePass": {
          "advised": 0.2222222222222222,
          "baseline": 0.8888888888888888,
        },
        "missingEvidence": {
          "abstained": 5,
          "falseNegative": 0,
          "falsePositive": 1,
          "trueNegative": 9,
          "truePositive": 3,
        },
        "needsReview": {
          "abstained": 4,
          "falseNegative": 1,
          "falsePositive": 0,
          "trueNegative": 5,
          "truePositive": 8,
        },
        "unavailable": 2,
      }
    `);
  });

  test('a stricter threshold abstains more and asserts less', async () => {
    const loose = await measurePreflight(SYNTHETIC_PREFLIGHT_CASES, { booleanTrue: 0.7, booleanFalse: 0.3, choice: 0.5 });
    const strict = await measurePreflight(SYNTHETIC_PREFLIGHT_CASES, { booleanTrue: 0.9, booleanFalse: 0.1, choice: 0.7 });
    expect(strict.needsReview.abstained).toBeGreaterThan(loose.needsReview.abstained);
    expect(strict.missingEvidence.abstained).toBeGreaterThan(loose.missingEvidence.abstained);
  });
});
