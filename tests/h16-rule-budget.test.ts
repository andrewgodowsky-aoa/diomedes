/**
 * Review G finding 6: an unbounded pattern (`.*`, `+`, `{m,}`) rescans its whole window on
 * every delta, so a set of them costs window² per delta, not per chunk. H16's grammar admitted
 * 64 of them at the full 512-character window: about 16 ms for every 20-character delta a
 * provider streams. The rule set now carries a budget: one authority's unbounded patterns may
 * watch `STREAM_RULE_LIMITS.unboundedWindow` characters in total.
 */
import { describe, expect, test } from 'vitest';
import { StreamEvaluator } from '../server/stream-rules/evaluator.js';
import {
  patternUnbounded,
  STREAM_RULE_LIMITS,
  streamRuleSetSchema,
  type StreamRule,
} from '../shared/stream-rules.js';

const pattern = (id: string, text: string, window: number): StreamRule => ({
  id,
  version: 1,
  enabled: true,
  text: 'Why.',
  intervention: 'annotate',
  match: { kind: 'pattern', pattern: text, window },
});
const phrase = (id: string, text: string): StreamRule => ({
  id,
  version: 1,
  enabled: true,
  text: 'Why.',
  intervention: 'annotate',
  match: { kind: 'text', phrase: text },
});
const admitted = (rules: StreamRule[]) => streamRuleSetSchema.safeParse({ protocolVersion: 1, rules });

/** The heaviest set one authority may write: full-window `.*!` rules until the schema refuses, then phrases. */
function heaviestSet(prefix: string): StreamRule[] {
  const rules: StreamRule[] = [];
  while (rules.length < STREAM_RULE_LIMITS.rules) {
    const next = [...rules, pattern(`${prefix}-worst-${rules.length}`, '.*!', STREAM_RULE_LIMITS.window)];
    if (!admitted(next).success) break;
    rules.push(next.at(-1)!);
  }
  while (rules.length < STREAM_RULE_LIMITS.rules)
    rules.push(phrase(`${prefix}-p${rules.length}`, `phrase number ${rules.length} that is absent`));
  expect(admitted(rules).success).toBe(true);
  return rules;
}

describe('review-g finding 6: a budget for unbounded patterns', () => {
  test('which patterns count: *, + and {m,} anywhere, and a count above the long-repeat limit; escapes and classes do not', () => {
    for (const unbounded of ['.*!', 'x+y', 'a{2,}', `a{1,${STREAM_RULE_LIMITS.longRepeat + 1}}`, `[a-z]{${STREAM_RULE_LIMITS.longRepeat + 1}}`, 'x+?y'])
      expect(patternUnbounded(unbounded), unbounded).toBe(true);
    for (const bounded of ['sk-[a-z0-9]{8}', 'c\\+\\+', '[+*]x', 'a\\*b', `a{1,${STREAM_RULE_LIMITS.longRepeat}}`, 'pass(?:word)?', '(foo|bar) now'])
      expect(patternUnbounded(bounded), bounded).toBe(false);
  });

  test('one authority’s unbounded windows are capped in total; bounded patterns and phrases are not counted', () => {
    const budget = STREAM_RULE_LIMITS.unboundedWindow;
    const full = STREAM_RULE_LIMITS.window;
    const atCap = Array.from({ length: budget / full }, (_, index) => pattern(`w${index}`, '.*!', full));
    expect(admitted(atCap).success).toBe(true);
    const over = admitted([...atCap, pattern('one-more', 'x+y', 1)]);
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toBe(
      `Patterns with *, + or a long repeat may watch ${budget} characters in total; shorten a window or use a phrase.`,
    );
    // H16's own evaluator test set, 64 unbounded rules at the full window, is refused.
    expect(admitted(Array.from({ length: 64 }, (_, index) => pattern(`h${index}`, '.*!', full))).success).toBe(false);
    // Bounded patterns at the full window and phrases cost linear time per delta, and are not counted.
    const bounded = Array.from({ length: 32 }, (_, index) => pattern(`b${index}`, `sk-[a-z0-9]{8}${index}`, full));
    const phrases = Array.from({ length: 30 }, (_, index) => phrase(`p${index}`, `phrase ${index}`));
    expect(admitted([...atCap, ...bounded, ...phrases]).success).toBe(true);
  });

  test('the heaviest rules both authorities may write cost little per streamed delta', () => {
    // Organization and project rules are evaluated together, each layer at its own cap.
    const rules = [...heaviestSet('org'), ...heaviestSet('project')];
    const evaluator = new StreamEvaluator(rules, () => undefined);
    // Warm the carry to its full length, then time provider-sized deltas that fail every unbounded rule at every start.
    evaluator.push('a'.repeat(STREAM_RULE_LIMITS.window));
    const times: number[] = [];
    for (let index = 0; index < 400; index++) {
      const started = performance.now();
      evaluator.push('a'.repeat(20));
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1];
    // Measured about 1 ms per delta here at the cap; H16's admitted worst case was about 16 ms. Bound generous for CI.
    expect(median).toBeLessThan(5);
  });
});
