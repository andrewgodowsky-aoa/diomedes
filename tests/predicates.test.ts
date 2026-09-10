import { describe, expect, test } from 'vitest';
import {
  MATCH_SURFACES,
  PATTERN_MAX_INPUT,
  PATTERN_MAX_SOURCE,
  RULE_OPERATIONS,
  describePredicate,
  evaluatePredicate,
  screenPattern,
  type PredicateSubject,
} from '../shared/predicates.js';

const subject = (over: Partial<PredicateSubject> = {}): PredicateSubject => ({
  routeId: 'codex',
  operation: 'text.modify',
  capabilities: ['work.submit'],
  paths: ['notes/weekly.md'],
  budgetUsd: 2,
  surfaces: {
    'tool-name': 'format-report',
    'operation-name': 'text.modify',
    'destination-label': 'local',
    'output-summary': 'Wrote the weekly brief.',
  },
  ...over,
});

describe('typed predicates', () => {
  test('a path predicate matches canonical relative names inside a declared root', () => {
    const inside = evaluatePredicate({ kind: 'path', within: ['notes'] }, subject());
    expect(inside.matched).toBe(true);
    const outside = evaluatePredicate(
      { kind: 'path', within: ['reports'] },
      subject({ paths: ['notes/weekly.md'] }),
    );
    expect(outside.matched).toBe(false);
  });

  test('a path predicate refuses anything that is not already canonical', () => {
    for (const bad of ['../secrets.md', 'C:\\keys\\id_rsa', '/etc/passwd', 'notes/../../out.md']) {
      const answer = evaluatePredicate(
        { kind: 'path', within: ['notes'] },
        subject({ paths: [bad] }),
      );
      expect(answer.matched).toBe(false);
      expect(answer.detail).toContain('canonical');
    }
  });

  test('a root named with a traversal segment never matches', () => {
    expect(
      evaluatePredicate({ kind: 'path', within: ['..'] }, subject({ paths: ['notes/weekly.md'] }))
        .matched,
    ).toBe(false);
  });

  test('a path predicate needs a full path segment, not a prefix of one', () => {
    expect(
      evaluatePredicate({ kind: 'path', within: ['note'] }, subject({ paths: ['notes/weekly.md'] }))
        .matched,
    ).toBe(false);
  });

  test('a capability predicate reads the capability list, never a name', () => {
    expect(
      evaluatePredicate({ kind: 'capability', requires: 'work.submit' }, subject()).matched,
    ).toBe(true);
    expect(
      evaluatePredicate({ kind: 'capability', requires: 'write.apply' }, subject()).matched,
    ).toBe(false);
  });

  test('a budget predicate compares numbers and refuses an unknown amount', () => {
    expect(evaluatePredicate({ kind: 'budget', maxUsd: 5 }, subject()).matched).toBe(true);
    expect(evaluatePredicate({ kind: 'budget', maxUsd: 1 }, subject()).matched).toBe(false);
    const unknown = evaluatePredicate({ kind: 'budget', maxUsd: 5 }, subject({ budgetUsd: null }));
    expect(unknown.matched).toBe(false);
    expect(unknown.detail).toContain('not known');
  });

  test('an operation predicate only knows the operations that exist', () => {
    expect(RULE_OPERATIONS).toEqual(['text.create', 'text.modify']);
    expect(
      evaluatePredicate({ kind: 'operation', anyOf: ['text.modify'] }, subject()).matched,
    ).toBe(true);
    expect(
      evaluatePredicate({ kind: 'operation', anyOf: ['text.create'] }, subject()).matched,
    ).toBe(false);
  });

  test('a route predicate matches the resolved route', () => {
    expect(evaluatePredicate({ kind: 'route', anyOf: ['codex'] }, subject()).matched).toBe(true);
    expect(evaluatePredicate({ kind: 'route', anyOf: ['sample'] }, subject()).matched).toBe(false);
  });

  test('every predicate explains itself in plain words', () => {
    expect(describePredicate({ kind: 'path', within: ['notes'] })).toContain('notes');
    expect(describePredicate({ kind: 'budget', maxUsd: 5 })).toContain('5');
    expect(describePredicate({ kind: 'capability', requires: 'write.apply' })).toContain(
      'write.apply',
    );
  });
});

describe('bounded text matching', () => {
  test('the matching surfaces are a closed list', () => {
    expect(MATCH_SURFACES).toEqual([
      'tool-name',
      'operation-name',
      'destination-label',
      'output-summary',
    ]);
  });

  test('a simple pattern is accepted and matches its named surface only', () => {
    const screened = screenPattern('weekly brief');
    expect(screened.ok).toBe(true);
    if (!screened.ok) return;
    expect(
      evaluatePredicate(
        { kind: 'text-match', surface: 'output-summary', pattern: screened.pattern },
        subject(),
      ).matched,
    ).toBe(true);
    expect(
      evaluatePredicate(
        { kind: 'text-match', surface: 'tool-name', pattern: screened.pattern },
        subject(),
      ).matched,
    ).toBe(false);
  });

  test('groups, backreferences and lookaround are refused', () => {
    for (const source of ['(a+)+b', '(\\w)\\1', 'a(?=b)', 'a(?<!b)c', '(?:ab)*c']) {
      const screened = screenPattern(source);
      expect(screened.ok).toBe(false);
      if (screened.ok) continue;
      expect(screened.reason.length).toBeGreaterThan(20);
    }
  });

  test('a pattern longer than the limit is refused', () => {
    const screened = screenPattern('a'.repeat(PATTERN_MAX_SOURCE + 1));
    expect(screened.ok).toBe(false);
  });

  test('matching stops at the input limit rather than scanning a transcript', () => {
    const screened = screenPattern('needle');
    expect(screened.ok).toBe(true);
    if (!screened.ok) return;
    const long = `${'x'.repeat(PATTERN_MAX_INPUT + 50)}needle`;
    const answer = evaluatePredicate(
      { kind: 'text-match', surface: 'output-summary', pattern: screened.pattern },
      subject({
        surfaces: {
          'tool-name': '',
          'operation-name': '',
          'destination-label': '',
          'output-summary': long,
        },
      }),
    );
    expect(answer.matched).toBe(false);
    expect(answer.detail).toContain(String(PATTERN_MAX_INPUT));
  });

  test('a screened pattern records what was actually checked', () => {
    const screened = screenPattern('weekly');
    expect(screened.ok).toBe(true);
    if (!screened.ok) return;
    expect(screened.pattern.source).toBe('weekly');
    expect(screened.pattern.checks.length).toBeGreaterThan(2);
  });

  test('a pattern cannot be used to reach a surface that does not exist', () => {
    const screened = screenPattern('anything');
    expect(screened.ok).toBe(true);
    if (!screened.ok) return;
    const answer = evaluatePredicate(
      // A caller reaching past the closed surface list gets nothing, not everything.
      { kind: 'text-match', surface: 'transcript' as never, pattern: screened.pattern },
      subject(),
    );
    expect(answer.matched).toBe(false);
    expect(answer.detail).toContain('surface');
  });
});
