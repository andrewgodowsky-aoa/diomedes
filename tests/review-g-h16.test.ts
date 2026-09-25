/**
 * Review G on H16: findings shown red first, then fixed.
 *
 * - A rule's target is judged by what a path resolves to, not by how the model
 *   spelled it (decision 11).
 * - The pattern grammar bounds backtracking: a choice group is a place a
 *   pattern varies, so sequential choices (exponential) and a choice under a
 *   repeat (choices × n²) are refused.
 */
import { describe, expect, test } from 'vitest';
import { patternProblem, STREAM_RULE_LIMITS, type StreamRule } from '../shared/stream-rules.js';
import { StreamEvaluator } from '../server/stream-rules/evaluator.js';
import { targetMatches, toolMatches } from '../server/stream-rules/service.js';

const patternRule = (id: string, pattern: string): StreamRule => ({
  id,
  version: 1,
  enabled: true,
  text: 'Why.',
  intervention: 'annotate',
  match: { kind: 'pattern', pattern, window: STREAM_RULE_LIMITS.window },
});

describe('review-g: a target is judged by what it resolves to', () => {
  test('a backslash spelling names the same file as the slash spelling the reader resolves it to', () => {
    expect(targetMatches('ledger\\june.md', 'ledger/')).toBe(true);
    expect(targetMatches('ledger\\june.md', 'ledger/june.md')).toBe(true);
    expect(
      toolMatches({ kind: 'tool', tool: 'read_project_file', target: 'ledger/' }, {
        tool: 'read_project_file',
        effectClass: 'read',
        targets: ['ledger\\june.md'],
      }),
    ).toBe(true);
  });

  test('where file names ignore case, another case names the same file; where they do not, it does not', () => {
    expect(targetMatches('Ledger/June.md', 'ledger/', true)).toBe(true);
    expect(targetMatches('ORDER.md', 'order.md', true)).toBe(true);
    expect(targetMatches('ORDER.md', 'order.md', false)).toBe(false);
    // Folders still bound what they cover.
    expect(targetMatches('ledgers/june.md', 'ledger/', true)).toBe(false);
    expect(targetMatches('ledger', 'ledger/', true)).toBe(false);
  });
});

describe('review-g: the pattern grammar bounds backtracking', () => {
  test('sequential choice groups, and a choice beside a repeat, are refused; one choice group alone is not', () => {
    for (const bad of ['(a|a)'.repeat(20) + 'b', '(a|b)(c|d)', '(foo|bar).*baz', '(?:x|y)z+', '((a|b)c|d)e'])
      expect(patternProblem(bad), bad).not.toBeNull();
    for (const good of ['(foo|bar|baz) now', 'api[_-]?key', 'x.*y', 'rm -rf|drop table', '(?:a|b|c|d|e|f|g|h)!'])
      expect(patternProblem(good), good).toBeNull();
  });

  test('the worst choice pattern the grammar admits stays linear per slice', () => {
    // One group of as many alternatives as fit, every one of them matching, then failing.
    const pattern = `(?:${Array.from({ length: 60 }, () => 'a').join('|')})!`;
    expect(patternProblem(pattern)).toBeNull();
    const evaluator = new StreamEvaluator(
      Array.from({ length: STREAM_RULE_LIMITS.rules }, (_, index) => patternRule(`c${index}`, pattern)),
      () => undefined,
    );
    const started = performance.now();
    evaluator.push('a'.repeat(4096));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('review-g: the evidence says exactly what matched', () => {
  const phraseRule = (phrase: string): StreamRule => ({
    id: 'p',
    version: 1,
    enabled: true,
    text: 'Why.',
    intervention: 'annotate',
    match: { kind: 'text', phrase },
  });
  const run = (phrase: string, stream: string, size: number) => {
    const hits: { start: number; end: number; text: string }[] = [];
    const evaluator = new StreamEvaluator([phraseRule(phrase)], ({ start, end, text }) => hits.push({ start, end, text }));
    for (let at = 0; at < stream.length; at += size) evaluator.push(stream.slice(at, at + size));
    evaluator.end();
    return hits;
  };

  test('case folding never moves the span: text before the match that lowercases longer (İ) leaves offsets exact', () => {
    const stream = 'İstanbul İzmir: the API KEY is here';
    const at = stream.indexOf('API KEY');
    for (const size of [1, 3, 7, stream.length])
      expect(run('api key', stream, size), `chunks of ${size}`).toEqual([{ start: at, end: at + 7, text: 'API KEY' }]);
  });

  test('astral characters and accents split at every code-unit boundary are found once, with exact offsets', () => {
    const phrase = 'déploie 🔥 now';
    const stream = `prefix ${phrase} suffix`;
    const at = stream.indexOf(phrase);
    for (let size = 1; size <= stream.length; size++)
      expect(run(phrase, stream, size), `chunks of ${size}`).toEqual([{ start: at, end: at + phrase.length, text: phrase }]);
  });
});
