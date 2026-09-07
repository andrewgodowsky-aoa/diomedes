import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import {
  ROSTER_ORDER,
  createUsageService,
  fakeCodexSnapshot,
  meterFromTokenUsage,
  tightestWindow,
  windowsFromRateLimits,
} from '../server/usage.js';
import type { UsageSnapshot } from '../shared/types.js';

describe('UsageService', () => {
  test('records and merges windows, thread and source per engine', () => {
    const service = createUsageService();
    expect(service.get('codex').windows).toEqual([]);
    expect(service.get('codex').source).toBe('none');
    service.record('codex', {
      windows: [
        { id: 'primary', label: '5 hours', usedPercent: 62, resetsAt: null, durationMins: 300 },
      ],
      plan: 'Plus',
      source: 'poll',
    });
    service.record('codex', {
      thread: {
        id: 'T1',
        meter: { input: 100, output: 40, cached: 20, total: 160, contextWindow: 200000, costUsd: null },
      },
      source: 'turn',
    });
    const snapshot = service.get('codex');
    // The later record keeps the earlier windows and plan, and takes the thread.
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.plan).toBe('Plus');
    expect(snapshot.thread?.id).toBe('T1');
    expect(snapshot.thread?.meter.output).toBe(40);
    expect(snapshot.source).toBe('turn');
  });

  test('notifies subscribers on change', () => {
    const service = createUsageService();
    const seen: UsageSnapshot[][] = [];
    const off = service.subscribe((snapshots) => seen.push(snapshots));
    service.record('codex', { source: 'poll' });
    expect(seen).toHaveLength(1);
    expect(seen[0].find((s) => s.engine === 'codex')?.source).toBe('poll');
    off();
    service.record('codex', { source: 'turn' });
    expect(seen).toHaveLength(1);
  });

  test('engines without data carry empty windows and a detail sentence', () => {
    const service = createUsageService();
    const all = service.all();
    expect(all.map((s) => s.engine)).toEqual(ROSTER_ORDER);
    const sample = all.find((s) => s.engine === 'sample')!;
    expect(sample.windows).toEqual([]);
    expect(sample.detail).toBe('Sample work uses no service.');
    expect(all.find((s) => s.engine === 'opencode')!.detail).toContain('OpenCode');
    expect(all.find((s) => s.engine === 'claude-code')!.detail).toContain('Claude Code');
    for (const snapshot of all) expect(snapshot.detail.trim().length).toBeGreaterThan(0);
  });

  test('tightest window is the highest percent used', () => {
    const snapshot = fakeCodexSnapshot();
    expect(tightestWindow(snapshot)?.usedPercent).toBe(91);
    expect(tightestWindow(snapshot)?.label).toBe('week');
    expect(tightestWindow({ ...snapshot, windows: [] })).toBeNull();
  });
});

describe('Codex filler mapping', () => {
  test('maps a GetAccountRateLimitsResponse into windows, plan and credits', () => {
    const mapped = windowsFromRateLimits({
      rateLimits: {
        primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: 1725670000 },
        secondary: { usedPercent: 91, windowDurationMins: 10080, resetsAt: null },
        planType: 'plus',
        credits: { balance: null, unlimited: false },
      },
    });
    expect(mapped.windows).toHaveLength(2);
    expect(mapped.windows[0]).toMatchObject({ id: 'primary', label: '5 hours', usedPercent: 62, durationMins: 300 });
    expect(typeof mapped.windows[0].resetsAt).toBe('string');
    expect(mapped.windows[1]).toMatchObject({ id: 'secondary', label: 'week', usedPercent: 91 });
    expect(mapped.windows[1].resetsAt).toBeNull();
    expect(mapped.plan).toBe('plus');
    expect(mapped.credits).toEqual({ balance: null, unlimited: false });
  });

  test('maps a thread/tokenUsage/updated notification into a thread meter', () => {
    const mapped = meterFromTokenUsage({
      threadId: 'thread-1',
      last: { inputTokens: 10, cachedInputTokens: 1, outputTokens: 5, totalTokens: 16 },
      total: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 10,
        totalTokens: 160,
      },
      modelContextWindow: 200000,
    });
    expect(mapped?.threadId).toBe('thread-1');
    expect(mapped?.meter).toEqual({
      input: 100,
      output: 40,
      cached: 20,
      total: 160,
      contextWindow: 200000,
      costUsd: null,
    });
  });

  test('unknown shapes map to empty windows, never guessed numbers', () => {
    expect(windowsFromRateLimits({})).toEqual({ windows: [], plan: null, credits: null });
    expect(windowsFromRateLimits(null)).toEqual({ windows: [], plan: null, credits: null });
    expect(meterFromTokenUsage({})).toBeNull();
  });
});

describe('/api/usage route', () => {
  let server: Server, app: Awaited<ReturnType<typeof createApp>>, temp: string, url: string;
  const jsonHeaders = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  beforeEach(async () => {
    await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
    temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'usage-'));
    app = await createApp({
      dataDir: path.join(temp, 'data'),
      projectRoot: path.join(temp, 'projects'),
      stepMs: 20,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  test('returns snapshots in roster order', async () => {
    const response = await fetch(`${url}/api/usage`, { headers: jsonHeaders });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { usage: UsageSnapshot[] };
    expect(data.usage.map((s) => s.engine)).toEqual(ROSTER_ORDER);
    for (const snapshot of data.usage) {
      expect(typeof snapshot.at).toBe('string');
      expect(Array.isArray(snapshot.windows)).toBe(true);
      expect(typeof snapshot.detail).toBe('string');
    }
  });

  test('?fake=1 is 404 outside test mode and fixed inside it', async () => {
    const plain = await fetch(`${url}/api/usage?fake=1`, { headers: jsonHeaders });
    expect(plain.status).toBe(404);
    vi.stubEnv('DIOMEDES_TEST_MODE', '1');
    const faked = await fetch(`${url}/api/usage?fake=1`, { headers: jsonHeaders });
    expect(faked.status).toBe(200);
    const data = (await faked.json()) as { usage: UsageSnapshot[] };
    const codex = data.usage.find((s) => s.engine === 'codex')!;
    expect(codex.windows.map((w) => w.usedPercent).sort((a, b) => a - b)).toEqual([62, 91]);
  });
});
