import { EventEmitter } from 'node:events';
import type { UsageMeter, UsageSnapshot, UsageWindow } from '../shared/types.js';

/** Roster order matches getIntegrationStatuses() in server/integrations.ts. */
export const ROSTER_ORDER = [
  'sample',
  'codex',
  'claude-code',
  'opencode',
  'oh-my-pi',
  'cursor',
  'hermes',
  'localai',
  'ollama',
  'aioncore',
];

const DETAILS: Record<string, string> = {
  sample: 'Sample work uses no service.',
  codex:
    'Codex has not reported its allowance yet. It appears after the next connection check or turn.',
  'claude-code': 'Claude Code reports cost per answer; a plan window is not available yet.',
  opencode: 'OpenCode does not report what is left on the Go plan. See your OpenCode account.',
  'oh-my-pi': 'oh-my-pi keeps its own counts where it runs; nothing is reported here yet.',
  cursor: 'Cursor is reported as installed; no allowance is reported here yet.',
  hermes: 'Hermes is reported as installed; no allowance is reported here yet.',
  localai: 'The loopback supervisor reports status only; no allowance is reported.',
  ollama: 'Ollama reports per-request counts only; no allowance is reported.',
  aioncore: 'AionCore is not configured in this build.',
};
const FALLBACK_DETAIL = 'This helper does not report its allowance here yet.';

export const now = () => new Date().toISOString();

export function detailFor(engine: string): string {
  return DETAILS[engine] ?? FALLBACK_DETAIL;
}

export function emptySnapshot(engine: string): UsageSnapshot {
  return {
    engine,
    at: now(),
    windows: [],
    plan: null,
    credits: null,
    thread: null,
    source: 'none',
    detail: detailFor(engine),
  };
}

/** The window closest to empty: the highest percent used. */
export function tightestWindow(snapshot: UsageSnapshot): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const window of snapshot.windows)
    if (!best || window.usedPercent > best.usedPercent) best = window;
  return best;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function normalizeResets(value: unknown): string | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    // Unix seconds from the native protocol; milliseconds if already large.
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  return null;
}

function labelFor(id: string, durationMins: number | null): string {
  if (durationMins !== null) {
    if (durationMins === 300) return '5 hours';
    if (durationMins === 60) return 'hour';
    if (durationMins === 1440) return 'day';
    if (durationMins === 10080) return 'week';
    if (durationMins < 60) return `${durationMins} minutes`;
    if (durationMins < 1440 && durationMins % 60 === 0) return `${durationMins / 60} hours`;
    if (durationMins < 10080 && durationMins % 1440 === 0) return `${durationMins / 1440} days`;
    return `${durationMins} minutes`;
  }
  return id === 'primary' ? 'Primary window' : id === 'secondary' ? 'Secondary window' : id;
}

/**
 * Map a GetAccountRateLimitsResponse (or a rateLimits/updated notification,
 * which carries the same snapshot) into windows, plan and credits. Unknown
 * shapes map to empty windows rather than guessed numbers.
 */
export function windowsFromRateLimits(result: unknown): {
  windows: UsageWindow[];
  plan: string | null;
  credits: { balance: number | null; unlimited: boolean } | null;
} {
  const root = object(result);
  const body = object(root.rateLimits ?? result);
  const windows: UsageWindow[] = [];
  for (const id of ['primary', 'secondary']) {
    const entry = object(body[id]);
    const used = num(entry.usedPercent);
    if (used === null) continue;
    const duration = num(entry.windowDurationMins);
    windows.push({
      id,
      label:
        typeof entry.label === 'string' && entry.label.trim()
          ? entry.label.trim().slice(0, 60)
          : labelFor(id, duration === null ? null : Math.round(duration)),
      usedPercent: used,
      resetsAt: normalizeResets(entry.resetsAt),
      durationMins: duration === null ? null : Math.round(duration),
    });
  }
  const plan =
    typeof body.planType === 'string' && body.planType.trim()
      ? body.planType.trim().slice(0, 80)
      : null;
  const rawCredits = object(body.credits);
  const credits =
    'credits' in body || 'balance' in rawCredits || 'unlimited' in rawCredits
      ? {
          balance: num(rawCredits.balance),
          unlimited: rawCredits.unlimited === true,
        }
      : null;
  return { windows, plan, credits };
}

/**
 * Map a thread/tokenUsage/updated notification into a thread meter. The
 * notification carries `last` and `total` TokenUsageBreakdown blocks and the
 * context size; cost is reported per thread elsewhere, so it stays null here
 * unless the payload states it outright.
 */
export function meterFromTokenUsage(params: unknown): {
  threadId: string | null;
  meter: UsageMeter;
} | null {
  const root = object(params);
  const total = object(root.total ?? root.usage);
  const input = num(total.inputTokens) ?? 0;
  const cached = num(total.cachedInputTokens) ?? 0;
  const output = (num(total.outputTokens) ?? 0) + (num(total.reasoningOutputTokens) ?? 0);
  const totalTokens = num(total.totalTokens) ?? input + cached + output;
  const contextWindow = num(root.modelContextWindow ?? root.contextWindow);
  const costUsd = num(root.costUsd ?? root.totalCostUsd);
  const hasData =
    'total' in root || 'usage' in root
      ? true
      : input > 0 || cached > 0 || output > 0 || totalTokens > 0;
  if (!hasData) return null;
  return {
    threadId: typeof root.threadId === 'string' ? root.threadId : null,
    meter: {
      input,
      output,
      cached,
      total: totalTokens,
      contextWindow,
      costUsd,
    },
  };
}

export interface UsageRecord {
  windows?: UsageWindow[];
  plan?: string | null;
  credits?: { balance: number | null; unlimited: boolean } | null;
  thread?: { id: string; meter: UsageMeter } | null;
  source?: UsageSnapshot['source'];
  detail?: string;
}

export function createUsageService() {
  const latest = new Map<string, UsageSnapshot>();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  function get(engine: string): UsageSnapshot {
    return latest.get(engine) ?? emptySnapshot(engine);
  }
  function all(): UsageSnapshot[] {
    const seen = new Set<string>();
    const ordered = ROSTER_ORDER.map((engine) => {
      seen.add(engine);
      return get(engine);
    });
    for (const [engine, snapshot] of latest) if (!seen.has(engine)) ordered.push(snapshot);
    return ordered;
  }
  function record(engine: string, partial: UsageRecord): UsageSnapshot {
    const current = get(engine);
    const snapshot: UsageSnapshot = {
      engine,
      at: now(),
      windows: partial.windows ?? current.windows,
      plan: partial.plan !== undefined ? partial.plan : current.plan,
      credits: partial.credits !== undefined ? partial.credits : current.credits,
      thread: partial.thread !== undefined ? partial.thread : current.thread,
      source: partial.source ?? current.source,
      detail: partial.detail ?? current.detail,
    };
    latest.set(engine, snapshot);
    emitter.emit('change', all());
    return snapshot;
  }
  function subscribe(listener: (snapshots: UsageSnapshot[]) => void): () => void {
    emitter.on('change', listener);
    return () => emitter.off('change', listener);
  }
  return { get, all, record, subscribe };
}

export type UsageService = ReturnType<typeof createUsageService>;

/** Shared instance used by the integrations filler and the /api/usage route. */
export const usageService = createUsageService();

/** Fixed Codex snapshot for the UI suite: windows at 62 and 91 percent. */
export function fakeCodexSnapshot(): UsageSnapshot {
  const at = now();
  return {
    engine: 'codex',
    at,
    windows: [
      {
        id: 'primary',
        label: '5 hours',
        usedPercent: 62,
        resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
        durationMins: 300,
      },
      {
        id: 'secondary',
        label: 'week',
        usedPercent: 91,
        resetsAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
        durationMins: 10080,
      },
    ],
    plan: 'Plus',
    credits: { balance: null, unlimited: false },
    thread: {
      id: 'test-thread',
      meter: {
        input: 12400,
        output: 3100,
        cached: 5200,
        total: 20700,
        contextWindow: 200000,
        costUsd: 0.04,
      },
    },
    source: 'poll',
    detail: 'Codex reports its allowance per window and its last thread below.',
  };
}

// In UI-test runs the client has no real Codex session, so the shared service
// starts with the fixed snapshot; the live filler overwrites it on real data.
if (process.env.DIOMEDES_TEST_MODE === '1') usageService.record('codex', fakeCodexSnapshot());
