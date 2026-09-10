import { describe, expect, test } from 'vitest';
import type { UsageSnapshot } from '../shared/types.js';
import {
  freshnessLine,
  hasReportedAllowance,
  planLine,
  shouldShowEmptyDetail,
} from '../client/usage-presentation.js';

function baseSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    engine: 'codex',
    at: '2026-09-09T12:00:00.000Z',
    windows: [],
    plan: null,
    credits: null,
    thread: null,
    source: 'none',
    detail:
      'Codex has not reported its allowance yet. It appears after the next connection check or turn.',
    ...overrides,
  };
}

describe('usage presentation policy', () => {
  test('empty snapshot shows the server fallback and claims no freshness', () => {
    const snapshot = baseSnapshot();
    expect(hasReportedAllowance(snapshot)).toBe(false);
    expect(shouldShowEmptyDetail(snapshot)).toBe(true);
    expect(freshnessLine(snapshot)).toBeNull();
    expect(planLine(snapshot)).toBeNull();
  });

  test('the screenshot case: week window present but allowance fallback hidden', () => {
    const snapshot = baseSnapshot({
      windows: [
        {
          id: 'secondary',
          label: 'week',
          usedPercent: 91,
          resetsAt: null,
          durationMins: 10080,
        },
      ],
      source: 'poll',
    });
    // Windows are reported, so the "has not reported its allowance" sentence
    // must not render alongside the numeric week meter.
    expect(hasReportedAllowance(snapshot)).toBe(true);
    expect(shouldShowEmptyDetail(snapshot)).toBe(false);
    expect(freshnessLine(snapshot)).toContain('checked');
  });

  test('allowance with a thread shows the meter path, never the empty fallback', () => {
    const snapshot = baseSnapshot({
      windows: [
        {
          id: 'primary',
          label: '5 hours',
          usedPercent: 62,
          resetsAt: null,
          durationMins: 300,
        },
      ],
      thread: {
        id: 'T1',
        meter: {
          input: 100,
          output: 40,
          cached: 20,
          total: 160,
          contextWindow: 200000,
          costUsd: null,
        },
      },
      plan: 'Plus',
      source: 'turn',
    });
    expect(hasReportedAllowance(snapshot)).toBe(true);
    expect(shouldShowEmptyDetail(snapshot)).toBe(false);
    expect(planLine(snapshot)).toBe('Plan: Plus.');
    expect(freshnessLine(snapshot)).toContain('last run');
  });

  test('thread without windows still hides the empty fallback', () => {
    const snapshot = baseSnapshot({
      source: 'turn',
      thread: {
        id: 'T1',
        meter: {
          input: 100,
          output: 40,
          cached: 20,
          total: 160,
          contextWindow: null,
          costUsd: null,
        },
      },
    });
    expect(hasReportedAllowance(snapshot)).toBe(false);
    expect(shouldShowEmptyDetail(snapshot)).toBe(false);
  });

  test('freshness never invents a report and plan never invents a value', () => {
    expect(freshnessLine(baseSnapshot({ source: 'poll', at: 'not-a-date' }))).toBeNull();
    expect(planLine(baseSnapshot({ plan: '  ' }))).toBeNull();
    expect(planLine(baseSnapshot({ plan: null }))).toBeNull();
  });
});
