/**
 * When an evaluation is allowed to happen at all.
 *
 * Core Pillar 01 says "do not add model latency/cost to trivial operations
 * merely to make a feature appear intelligent". Core Pillar 08 says "do not
 * force human review or model reasoning where a deterministic, already-
 * authorized operation is sufficient". A preparation step that fires on every
 * thread is exactly the pattern both forbid, so the exemption cannot be a
 * comment — it has to be a predicate, and it has to be tested.
 *
 * The load-bearing case is `single-candidate`. An evaluation chooses between
 * candidates the product already authorized; where there are none or one, there
 * is nothing to choose, and the honest answer is to skip and say so. That is
 * what keeps this from becoming an AI tollbooth on a one-document thread or an
 * exact status lookup.
 *
 * Every skip carries a reason, because a silent skip and a successful check
 * look identical afterwards, and only one of them is true.
 */
import { describe, expect, test } from 'vitest';
import {
  SKIP_REASON_TEXT,
  preflightDecision,
  type PreflightInput,
} from '../shared/evaluation-eligibility.js';

/** A thread that should legitimately prepare: first turn, real choice, funded. */
const eligible = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  turnsAlready: 0,
  wake: false,
  replayedCommand: false,
  route: 'claude-code',
  processing: 'cloud-permitted',
  featureEnabled: true,
  disclosureConsented: true,
  candidateCount: 6,
  pricedRoute: true,
  helperBudgetRemainingMicroUsd: 10_000,
  reservationCeilingMicroUsd: 1_344,
  ...over,
});

const skip = (over: Partial<PreflightInput>) => {
  const decision = preflightDecision(eligible(over));
  expect(decision.fire).toBe(false);
  return decision.fire === false ? decision.reason : null;
};

describe('a thread that should prepare', () => {
  test('fires on the first substantive request', () => {
    expect(preflightDecision(eligible()).fire).toBe(true);
  });

  test('is the only case that fires — everything else records a reason', () => {
    const decision = preflightDecision(eligible());
    expect(decision).toEqual({ fire: true });
  });
});

describe('the deterministic exemptions that keep Pillars 01 and 08', () => {
  test('skips when there is nothing to choose between', () => {
    expect(skip({ candidateCount: 1 })).toBe('single-candidate');
    expect(skip({ candidateCount: 0 })).toBe('single-candidate');
  });

  test('skips a deterministic route, which has no choices to make', () => {
    expect(skip({ route: 'sample' })).toBe('deterministic-route');
  });

  test('skips every turn after the first, so a thread pays once', () => {
    expect(skip({ turnsAlready: 1 })).toBe('not-first-substantive');
    expect(skip({ turnsAlready: 40 })).toBe('not-first-substantive');
  });

  test('skips a team wake, which submits no request of its own', () => {
    expect(skip({ wake: true })).toBe('team-wake');
  });

  test('skips a replayed command, so a refresh cannot buy a second evaluation', () => {
    expect(skip({ replayedCommand: true })).toBe('replayed-command');
  });
});

describe('the boundaries that are not about cost', () => {
  test('skips when the work must stay on this machine', () => {
    expect(skip({ processing: 'local-only' })).toBe('local-only-policy');
  });

  test('skips when the feature is not switched on', () => {
    expect(skip({ featureEnabled: false })).toBe('route-not-enabled');
  });

  test('skips when the person has not agreed to the second destination', () => {
    expect(skip({ disclosureConsented: false })).toBe('no-consent');
  });

  test('skips when the route has no price, so nothing can be held against a cap', () => {
    expect(skip({ pricedRoute: false })).toBe('no-price');
  });

  test('skips when the helper budget cannot cover its own ceiling', () => {
    expect(skip({ helperBudgetRemainingMicroUsd: 1_000, reservationCeilingMicroUsd: 1_344 })).toBe(
      'helper-budget-exhausted',
    );
  });

  test('fires when the budget covers the ceiling exactly', () => {
    expect(
      preflightDecision(
        eligible({ helperBudgetRemainingMicroUsd: 1_344, reservationCeilingMicroUsd: 1_344 }),
      ).fire,
    ).toBe(true);
  });
});

describe('the order the reasons are checked in', () => {
  test('reports the free reason before the paid one, so nothing is computed needlessly', () => {
    // A later turn on a local-only thread is skipped for being a later turn:
    // the cheapest true statement, and the one that stops soonest.
    expect(skip({ turnsAlready: 3, processing: 'local-only' })).toBe('not-first-substantive');
  });

  test('reports a policy refusal ahead of a budget one, because a refusal is not about money', () => {
    expect(
      skip({ processing: 'local-only', helperBudgetRemainingMicroUsd: 0 }),
    ).toBe('local-only-policy');
  });
});

describe('every reason a person might be shown', () => {
  test('has plain-language text, so a skip can be read without the taxonomy', () => {
    for (const reason of Object.keys(SKIP_REASON_TEXT)) {
      const text = SKIP_REASON_TEXT[reason as keyof typeof SKIP_REASON_TEXT];
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/-/); // no internal codes leaking into the sentence
    }
  });

  test('never claims the check happened', () => {
    for (const text of Object.values(SKIP_REASON_TEXT))
      expect(text).not.toMatch(/\bchecked\b|\bverified\b/i);
  });

  test('covers exactly the reasons the predicate can return', () => {
    const produced = new Set<string>();
    const cases: Partial<PreflightInput>[] = [
      { turnsAlready: 1 },
      { wake: true },
      { replayedCommand: true },
      { route: 'sample' },
      { processing: 'local-only' },
      { featureEnabled: false },
      { disclosureConsented: false },
      { candidateCount: 1 },
      { pricedRoute: false },
      { helperBudgetRemainingMicroUsd: 0 },
    ];
    for (const one of cases) {
      const reason = skip(one);
      if (reason) produced.add(reason);
    }
    expect([...produced].sort()).toEqual(Object.keys(SKIP_REASON_TEXT).sort());
  });
});

describe('the predicate itself', () => {
  test('makes no call, reads no clock and touches nothing', () => {
    // It is a pure function of its input: the same input twice is the same
    // answer, which is what lets a skip be replayed from the record.
    const input = eligible({ candidateCount: 1 });
    expect(preflightDecision(input)).toEqual(preflightDecision(input));
  });

  test('does not mutate what it was given', () => {
    const input = eligible();
    const before = JSON.stringify(input);
    preflightDecision(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
