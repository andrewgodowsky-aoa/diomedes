// Pure pieces of the performance gate (scripts/perf-gate.ts), kept apart so a
// test can import them without seeding a project or spawning a service.

/**
 * The absolute headroom every metric gets on top of its baseline. A 12 ms
 * baseline would otherwise fail at 25 ms, which is scheduler noise on a busy
 * laptop, not a regression. Threshold = max(baseline x factor, baseline + FLOOR_MS).
 */
export const FLOOR_MS = 250;
export const DEFAULT_FACTOR = 2;
export const DEFAULT_RUNS = 5;

export interface BaselineFile {
  version: 1;
  recordedAt: string;
  machine: { platform: string; arch: string; cpus: number; node: string };
  synthetic: { historyEntries: number; files: number; tasks: number };
  metrics: Record<string, { medianMs: number }>;
}

export type RowStatus = 'pass' | 'fail' | 'new' | 'missing';
export interface Row {
  name: string;
  medianMs: number | null;
  baselineMs: number | null;
  thresholdMs: number | null;
  status: RowStatus;
}

export function median(values: readonly number[]): number {
  if (!values.length) throw new Error('A median needs at least one sample.');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const thresholdFor = (baselineMs: number, factor: number) =>
  Math.max(baselineMs * factor, baselineMs + FLOOR_MS);

/**
 * Judge the current medians against recorded ones. A metric with no baseline is
 * reported as `new` and never fails: the gate cannot regress against nothing,
 * and the next `--record` adopts it. A baseline the run no longer measures is
 * reported as `missing`, also non-failing, so a renamed metric is visible.
 */
export function compareMetrics(
  current: Record<string, number>,
  baseline: BaselineFile['metrics'] | undefined,
  factor = DEFAULT_FACTOR,
): { rows: Row[]; failed: boolean } {
  const rows: Row[] = [];
  for (const [name, medianMs] of Object.entries(current)) {
    const recorded = baseline?.[name]?.medianMs;
    if (typeof recorded !== 'number' || !Number.isFinite(recorded)) {
      rows.push({ name, medianMs, baselineMs: null, thresholdMs: null, status: 'new' });
      continue;
    }
    const thresholdMs = thresholdFor(recorded, factor);
    rows.push({
      name,
      medianMs,
      baselineMs: recorded,
      thresholdMs,
      status: medianMs > thresholdMs ? 'fail' : 'pass',
    });
  }
  for (const [name, entry] of Object.entries(baseline ?? {}))
    if (!(name in current))
      rows.push({
        name,
        medianMs: null,
        baselineMs: entry.medianMs,
        thresholdMs: thresholdFor(entry.medianMs, factor),
        status: 'missing',
      });
  return { rows, failed: rows.some((row) => row.status === 'fail') };
}

export interface GateArgs {
  record: boolean;
  small: boolean;
  runs: number;
  factor: number;
  json: string | null;
}

export function parseGateArgs(argv: readonly string[]): GateArgs {
  const args: GateArgs = {
    record: false,
    small: false,
    runs: DEFAULT_RUNS,
    factor: DEFAULT_FACTOR,
    json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      return next;
    };
    if (flag === '--record') args.record = true;
    else if (flag === '--small') args.small = true;
    else if (flag === '--json') args.json = value();
    else if (flag === '--runs') {
      args.runs = Number(value());
      if (!Number.isInteger(args.runs) || args.runs < 1)
        throw new Error('--runs takes a whole number of at least 1.');
    } else if (flag === '--factor') {
      args.factor = Number(value());
      // Below 1 the gate would fail an unchanged build.
      if (!Number.isFinite(args.factor) || args.factor < 1)
        throw new Error('--factor takes a number of at least 1.');
    } else throw new Error(`Unknown flag: ${flag}`);
  }
  return args;
}

const cell = (value: number | null) => (value === null ? '-' : value.toFixed(1));

export function formatTable(rows: readonly Row[]): string {
  const header = ['metric', 'median ms', 'baseline ms', 'threshold ms', 'status'];
  const body = rows.map((row) => [
    row.name,
    cell(row.medianMs),
    cell(row.baselineMs),
    cell(row.thresholdMs),
    row.status.toUpperCase(),
  ]);
  const widths = header.map((_, col) =>
    Math.max(...[header, ...body].map((line) => line[col].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((text, col) => (col ? text.padStart(widths[col]) : text.padEnd(widths[col])))
      .join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}
