import { splitVisuals, type VisualSpec } from '../../shared/visual-spec';

/**
 * The chart a thread pins at its top (round 2 reskin, slice 2, decision 1 option A).
 *
 * A chart in this app is a fenced `visual` block a reply carries. A visual declares no id, so a
 * newer chart is a new chart, never a new version of an old one: "stays live with the task"
 * therefore means the newest bar, line or area chart wins. A pie, a stat card or a table has no
 * baseline to sweep and is skipped. The older charts stay in the transcript where they were
 * written. Nothing here changes the visual format or asks a model for anything.
 *
 * Pure, with the clock a parameter, so it runs under Node (tests/pinned-chart.test.ts).
 */

export type PinnedSpec = Extract<VisualSpec, { kind: 'bar' | 'line' | 'area' }>;

export interface PinnedChart {
  spec: PinnedSpec;
  /** The reply the chart was read from. */
  turnId: string;
  /** When that reply was written, as the record holds it. */
  at: string;
}

interface TurnLike {
  id?: string;
  role: string;
  text: string;
  at?: string;
}

const pinnable = (spec: VisualSpec): spec is PinnedSpec =>
  spec.kind === 'bar' || spec.kind === 'line' || spec.kind === 'area';

/** The newest bar, line or area chart a reply in these turns carried, or null when none did. */
export function newestChart(turns: readonly TurnLike[]): PinnedChart | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    // Only a reply's chart is pinned. A chart the person typed is their words, not a result.
    if (turn.role === 'you' || !turn.text) continue;
    const charts = splitVisuals(turn.text).flatMap((segment) =>
      segment.type === 'visual' && pinnable(segment.spec) ? [segment.spec] : [],
    );
    const last = charts.at(-1);
    if (last) return { spec: last, turnId: turn.id ?? String(index), at: turn.at ?? '' };
  }
  return null;
}

/**
 * Which bars carry their number on the pinned chart: the first and the tallest, as the board
 * draws them. Only a one series bar chart; a line, an area or several series carry none, and the
 * hidden table still reads every value.
 */
export function pinnedMarks(spec: PinnedSpec): number[] {
  if (spec.kind !== 'bar' || spec.series.length !== 1) return [];
  const values = spec.series[0].values;
  if (values.length === 0) return [];
  let tallest = 0;
  values.forEach((value, index) => {
    if (value > values[tallest]) tallest = index;
  });
  return tallest === 0 ? [0] : [0, tallest];
}

const clock = (date: Date) =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date);
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/**
 * When the pinned chart was written, in plain words: today, yesterday, or the date. The caption
 * carries it so Monday's chart is never read as tonight's.
 */
export function pinnedWhen(at: string, now: Date): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const when = new Date(ms);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(when) === dayKey(now)) return `Today at ${clock(when)}`;
  if (dayKey(when) === dayKey(yesterday)) return `Yesterday at ${clock(when)}`;
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(when);
  return `${date} at ${clock(when)}`;
}
