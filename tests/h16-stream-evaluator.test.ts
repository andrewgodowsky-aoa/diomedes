import { describe, expect, test } from 'vitest';
import { StreamEvaluator, type StreamHit } from '../server/stream-rules/evaluator';
import {
  patternProblem,
  resolveStreamRules,
  STREAM_RULE_LIMITS,
  streamRuleSchema,
  type AuthoredStreamRule,
  type StreamRule,
} from '../shared/stream-rules';

const rule = (id: string, match: StreamRule['match'], extra: Partial<StreamRule> = {}): StreamRule =>
  streamRuleSchema.parse({
    id,
    version: 1,
    enabled: true,
    match,
    intervention: 'annotate',
    text: `Rule ${id}.`,
    ...extra,
  });

function run(rules: StreamRule[], chunks: string[]) {
  const hits: StreamHit[] = [];
  const evaluator = new StreamEvaluator(rules, (hit) => hits.push(hit));
  for (const chunk of chunks) evaluator.push(chunk);
  return { hits, evaluator };
}

describe('H16 incremental matching', () => {
  test('a phrase split across chunks at every possible boundary is found once, at the right offsets', () => {
    const text = 'Before that, please delete the production database now.';
    const phrase = 'delete the production database';
    const at = text.indexOf(phrase);
    for (let cut = 1; cut < text.length; cut++) {
      const { hits } = run([rule('danger', { kind: 'text', phrase })], [text.slice(0, cut), text.slice(cut)]);
      expect(hits, `cut at ${cut}`).toEqual([{ rule: 0, start: at, end: at + phrase.length, text: phrase }]);
    }
  });

  test('a phrase streamed one character at a time, and across three chunks, is found', () => {
    const phrase = 'rm -rf';
    const text = `sure, I will run ${phrase} /tmp/x`;
    expect(run([rule('rm', { kind: 'text', phrase })], [...text]).hits).toHaveLength(1);
    expect(run([rule('rm', { kind: 'text', phrase })], ['sure, I will run r', 'm -', 'rf /tmp/x']).hits[0]).toMatchObject({
      start: text.indexOf(phrase),
      text: phrase,
    });
  });

  test('matching is case-insensitive unless the rule says otherwise', () => {
    expect(run([rule('a', { kind: 'text', phrase: 'Secret' })], ['a SECR', 'ET']).hits).toHaveLength(1);
    expect(run([rule('a', { kind: 'text', phrase: 'Secret', caseSensitive: true })], ['a SECR', 'ET']).hits).toHaveLength(0);
  });

  test('a pattern split across chunks is found, and the matched text is the span', () => {
    const r = rule('key', { kind: 'pattern', pattern: 'sk-[a-z0-9]{8}', window: 16 });
    const { hits } = run([r], ['the key is sk-ab', 'c12345 and more']);
    expect(hits).toEqual([{ rule: 0, start: 11, end: 22, text: 'sk-abc12345' }]);
  });

  test('a rule fires once per stream; each rule independently', () => {
    const { hits } = run(
      [rule('a', { kind: 'text', phrase: 'foo' }), rule('b', { kind: 'text', phrase: 'bar' })],
      ['foo foo ba', 'r foo bar'],
    );
    expect(hits.map((hit) => [hit.rule, hit.start])).toEqual([
      [0, 0],
      [1, 8],
    ]);
  });

  test('no false fire after the stream ends: a completion arriving late is ignored and the carry is dropped', () => {
    const hits: StreamHit[] = [];
    const evaluator = new StreamEvaluator([rule('stop', { kind: 'text', phrase: 'stop now' })], (hit) => hits.push(hit));
    evaluator.push('please sto');
    expect(evaluator.buffered).toBeGreaterThan(0);
    evaluator.end();
    expect(evaluator.buffered).toBe(0);
    evaluator.push('p now');
    evaluator.push('stop now');
    expect(hits).toEqual([]);
    expect(evaluator.ended).toBe(true);
  });

  test('a partial phrase at the end of a stream never fires', () => {
    const hits: StreamHit[] = [];
    const evaluator = new StreamEvaluator([rule('x', { kind: 'text', phrase: 'drop table' })], (hit) => hits.push(hit));
    evaluator.push('I will drop tab');
    evaluator.end();
    expect(hits).toEqual([]);
  });

  test('buffering is bounded by the longest window, whatever the stream length', () => {
    const rules = [
      rule('a', { kind: 'text', phrase: 'needle-that-never-appears' }),
      rule('b', { kind: 'pattern', pattern: 'zz[0-9]{3}q', window: 40 }),
    ];
    const evaluator = new StreamEvaluator(rules, () => undefined);
    let max = 0;
    for (let index = 0; index < 2000; index++) {
      evaluator.push('lorem ipsum dolor sit amet '.repeat(1 + (index % 7)));
      max = Math.max(max, evaluator.buffered);
    }
    expect(max).toBe(39);
    expect(evaluator.length).toBeGreaterThan(100_000);
  });

  test('cost per chunk is bounded: 64 rules over 4 KB chunks, a 1 MB chunk, and the worst allowed pattern', () => {
    const rules: StreamRule[] = [];
    for (let index = 0; index < STREAM_RULE_LIMITS.rules - 2; index++)
      rules.push(rule(`p${index}`, { kind: 'text', phrase: `phrase number ${index} that is absent` }));
    // The slowest shapes the grammar admits: one unbounded repeat that fails at every start.
    rules.push(rule('worst', { kind: 'pattern', pattern: '.*!', window: STREAM_RULE_LIMITS.window }));
    rules.push(rule('worst2', { kind: 'pattern', pattern: '(?:a)+!', window: STREAM_RULE_LIMITS.window }));
    const evaluator = new StreamEvaluator(rules, () => undefined);
    const chunk = 'a'.repeat(4096);
    const times: number[] = [];
    for (let index = 0; index < 20; index++) {
      const started = performance.now();
      evaluator.push(chunk);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    // Median well under a frame, worst case bounded; generous for slow CI runners.
    expect(times[10]).toBeLessThan(100);
    const big = performance.now();
    evaluator.push('b'.repeat(1024 * 1024));
    const perSlice = (performance.now() - big) / (1024 * 1024 / STREAM_RULE_LIMITS.slice);
    expect(perSlice).toBeLessThan(50);
    expect(evaluator.buffered).toBeLessThanOrEqual(STREAM_RULE_LIMITS.window - 1);
  });
});

describe('H16 rule declarations', () => {
  test('hold is only for tool intents, steer carries its message, and a tool rule names something', () => {
    const base = { id: 'r', version: 1, enabled: true, text: 'Why.' };
    expect(
      streamRuleSchema.safeParse({ ...base, match: { kind: 'text', phrase: 'x' }, intervention: 'hold' }).success,
    ).toBe(false);
    expect(
      streamRuleSchema.safeParse({ ...base, match: { kind: 'text', phrase: 'x' }, intervention: 'steer' }).success,
    ).toBe(false);
    expect(
      streamRuleSchema.safeParse({ ...base, match: { kind: 'text', phrase: 'x' }, intervention: 'steer', message: 'Do not.' })
        .success,
    ).toBe(true);
    expect(streamRuleSchema.safeParse({ ...base, match: { kind: 'tool' }, intervention: 'hold' }).success).toBe(false);
    expect(
      streamRuleSchema.safeParse({ ...base, match: { kind: 'tool', target: '../x' }, intervention: 'hold' }).success,
    ).toBe(false);
    expect(
      streamRuleSchema.safeParse({ ...base, match: { kind: 'tool', tool: 'propose_write' }, intervention: 'hold' }).success,
    ).toBe(true);
  });

  test('the pattern grammar refuses what makes incremental matching unsound or unbounded', () => {
    for (const bad of ['^x', 'x$', '\\bx', '(?=x)', '(?<!x)y', '(a)\\1', '(a+)+', '(a*)*b', '(a|aa)+', 'a*b*', 'a?b?', 'pass(word)?\\s*=', '.*.*!', '('])
      expect(patternProblem(bad), bad).not.toBeNull();
    for (const good of ['sk-[a-z0-9]{8}', 'rm\\s+-rf', '[^a]b', 'a\\$b', '(ab)+', 'pass(?:word)?', '\\d{3}-\\d{4}', 'x+?y'])
      expect(patternProblem(good), good).toBeNull();
  });
});

describe('H16 authority precedence', () => {
  const org = (r: StreamRule): AuthoredStreamRule => ({ rule: r, authority: 'organization' });
  const project = (r: StreamRule): AuthoredStreamRule => ({ rule: r, authority: 'project' });
  const tool = { kind: 'tool', tool: 'propose_write' } as const;

  test('a project rule cannot loosen a global one on the same requirement', () => {
    const resolution = resolveStreamRules(
      [
        org(rule('writes', tool, { intervention: 'hold', constrains: 'writes' })),
        project(rule('writes-lax', tool, { intervention: 'annotate', constrains: 'writes' })),
      ],
      'T1',
    );
    expect(resolution.active.map((item) => `${item.authority}:${item.rule.id}`)).toEqual(['organization:writes']);
    const lax = resolution.decisions.find((item) => item.ruleId === 'writes-lax')!;
    expect(lax.outcome).toBe('blocked');
    expect(lax.reason).toMatch(/cannot loosen/);
  });

  test('a project rule on its own requirement adds to the global ones; a stronger global rule still governs a shared key', () => {
    const resolution = resolveStreamRules(
      [
        org(rule('writes', tool, { intervention: 'steer', message: 'Explain first.', constrains: 'writes' })),
        project(rule('writes-strict', tool, { intervention: 'hold', constrains: 'writes' })),
        project(rule('mine', { kind: 'text', phrase: 'refund' })),
      ],
      'T1',
    );
    expect(resolution.active.map((item) => item.rule.id).sort()).toEqual(['mine', 'writes']);
    expect(resolution.decisions.find((item) => item.ruleId === 'writes-strict')!.outcome).toBe('overridden');
  });

  test('a rule limited to another task, or turned off, does not watch this run', () => {
    const resolution = resolveStreamRules(
      [project(rule('other', tool, { taskId: 'T9' })), project(rule('off', tool, { enabled: false }))],
      'T1',
    );
    expect(resolution.active).toEqual([]);
    expect(resolution.decisions.map((item) => item.outcome).sort()).toEqual(['disabled', 'other-task']);
  });

  test('two equal rules that disagree are both evaluated, so a conflict never loosens anything', () => {
    const resolution = resolveStreamRules(
      [
        project(rule('a', tool, { intervention: 'hold', constrains: 'k' })),
        project(rule('b', tool, { intervention: 'annotate', constrains: 'k' })),
      ],
      'T1',
    );
    expect(resolution.conflicts).toHaveLength(1);
    expect(resolution.active.map((item) => item.rule.id).sort()).toEqual(['a', 'b']);
  });
});
