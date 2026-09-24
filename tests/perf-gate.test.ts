import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../server/store';
import { PERF_PROJECT_ID, SMALL_SIZE, seedSyntheticProject } from '../scripts/perf-gate-seed';
import {
  FLOOR_MS,
  compareMetrics,
  median,
  parseGateArgs,
  thresholdFor,
} from '../scripts/perf-gate-compare';

const baseline = (metrics: Record<string, number>) =>
  Object.fromEntries(Object.entries(metrics).map(([name, medianMs]) => [name, { medianMs }]));

describe('perf gate comparison', () => {
  it('takes the median of odd and even samples', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow();
  });

  it('passes a metric under its threshold', () => {
    const result = compareMetrics({ historyPage: 900 }, baseline({ historyPage: 500 }), 2);
    expect(result.failed).toBe(false);
    expect(result.rows).toEqual([
      expect.objectContaining({ name: 'historyPage', status: 'pass', thresholdMs: 1000 }),
    ]);
  });

  it('fails a metric over twice its baseline', () => {
    const result = compareMetrics(
      { historyPage: 1001, filesList: 100 },
      baseline({ historyPage: 500, filesList: 100 }),
      2,
    );
    expect(result.failed).toBe(true);
    expect(result.rows.find((row) => row.name === 'historyPage')?.status).toBe('fail');
    expect(result.rows.find((row) => row.name === 'filesList')?.status).toBe('pass');
  });

  it('applies the absolute floor so tiny baselines do not flap', () => {
    // 10 ms baseline: 2x is 20 ms, but the floor lifts the threshold to 260 ms.
    expect(thresholdFor(10, 2)).toBe(10 + FLOOR_MS);
    expect(compareMetrics({ tiny: 200 }, baseline({ tiny: 10 }), 2).failed).toBe(false);
    expect(compareMetrics({ tiny: 261 }, baseline({ tiny: 10 }), 2).failed).toBe(true);
    // A large baseline is judged by the factor, not the floor.
    expect(thresholdFor(1000, 2)).toBe(2000);
    expect(thresholdFor(1000, 1.5)).toBe(1500);
  });

  it('reports a new metric without failing, and a vanished one as missing', () => {
    const result = compareMetrics({ fresh: 99999 }, baseline({ gone: 5 }), 2);
    expect(result.failed).toBe(false);
    expect(result.rows).toEqual([
      expect.objectContaining({
        name: 'fresh',
        status: 'new',
        baselineMs: null,
        thresholdMs: null,
      }),
      expect.objectContaining({ name: 'gone', status: 'missing', medianMs: null }),
    ]);
  });

  it('treats a missing baseline file as all-new', () => {
    const result = compareMetrics({ coldStart: 1234 }, undefined, 2);
    expect(result.failed).toBe(false);
    expect(result.rows[0].status).toBe('new');
  });

  it('parses the gate flags', () => {
    expect(parseGateArgs([])).toEqual({
      record: false,
      small: false,
      runs: 5,
      factor: 2,
      json: null,
    });
    expect(
      parseGateArgs([
        '--record',
        '--small',
        '--runs',
        '3',
        '--factor',
        '1.5',
        '--json',
        'out.json',
      ]),
    ).toEqual({ record: true, small: true, runs: 3, factor: 1.5, json: 'out.json' });
    expect(() => parseGateArgs(['--runs', '0'])).toThrow();
    expect(() => parseGateArgs(['--factor', '0.5'])).toThrow();
    expect(() => parseGateArgs(['--bogus'])).toThrow();
  });
});

describe('perf gate seeding', () => {
  it('writes a small synthetic project that Store.init accepts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-gate-seed-'));
    try {
      const seeded = await seedSyntheticProject(root, SMALL_SIZE);
      expect(seeded.projectId).toBe(PERF_PROJECT_ID);
      const store = new Store(seeded.dataDir, seeded.projectsDir);
      await store.init();
      const state = store.state(PERF_PROJECT_ID);
      expect(state.history).toHaveLength(SMALL_SIZE.historyEntries);
      expect(state.tasks).toHaveLength(SMALL_SIZE.tasks);
      expect(await store.listDocuments(PERF_PROJECT_ID)).toHaveLength(SMALL_SIZE.files);
      // Fixed ids and timestamps: the seed is the same on every run.
      expect(state.history[0]).toMatchObject({
        id: 'E000000000001',
        time: '2026-01-05T09:00:00.000Z',
      });
      expect(state.history.at(-1)?.files[0]).toMatchObject({ op: 'modified', recorded: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20000);
});
