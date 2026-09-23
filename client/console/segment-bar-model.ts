// The segment bar's arithmetic, kept pure so its honesty rule can be tested
// without a DOM. A bar only ever shows what a record counted: named steps, k
// of n from the record itself, or a share the source reported (bytes received
// over the size it declared, a figure a visual carried). Anything else is
// drawn as indeterminate work, never as an invented fraction.
//
// Precedence, when a record carries more than one: steps, then a whole count,
// then a share, then indeterminate.

export type SegmentState = 'done' | 'active' | 'pending' | 'failed' | 'blocked';

export interface SegmentStep {
  label?: string;
  state: SegmentState;
}

export interface SegmentInput {
  /** Steps exactly as the record lists them. When present, counts derive from them. */
  steps?: readonly SegmentStep[] | null;
  /** Countable progress from a record. Ignored when steps are given. */
  total?: number | null;
  done?: number | null;
  /**
   * The share done, 0 to 1, exactly as the source reported it. Read only when
   * there are no steps and no whole count, and drawn as one continuous track.
   * Clamped to [0, 1]; NaN, an infinity, null or nothing is no share at all, so
   * the bar is indeterminate.
   */
  fraction?: number | null;
  /** Whether the work is still moving. The next unit is only "active" while it is. */
  running?: boolean;
  /** The work is waiting on a person: the active unit turns to the needs-you colour. */
  blocked?: boolean;
  /** The work stopped on a failure: the active unit turns to the failed colour. */
  failed?: boolean;
  /** The record's own words for what is counted, e.g. "records read". */
  noun?: string;
}

export interface SegmentModel {
  indeterminate: boolean;
  /** The share drawn as one track, clamped to [0, 1]: set only in fraction mode, otherwise null. */
  fraction: number | null;
  /** One entry per drawn segment (at most MAX_SEGMENTS); empty in fraction and indeterminate modes. */
  segments: SegmentState[];
  done: number;
  total: number;
  /**
   * Plain words: "3 of 4 records read" for a count, "40%" for a share, "Working"
   * when nothing was counted. A share never becomes "k of n": the source said
   * how far, not how many.
   */
  text: string;
}

export const MAX_SEGMENTS = 12;

const RANK: Record<SegmentState, number> = { failed: 4, blocked: 3, active: 2, done: 1, pending: 0 };

function whole(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.floor(value);
}

// More units than segments: each drawn segment stands for a run of units. A
// group is done only when all of its units are, and otherwise shows the most
// urgent state inside it.
function group(units: SegmentState[]): SegmentState[] {
  if (units.length <= MAX_SEGMENTS) return units;
  const size = Math.ceil(units.length / MAX_SEGMENTS);
  const out: SegmentState[] = [];
  for (let start = 0; start < units.length; start += size) {
    const slice = units.slice(start, start + size);
    if (slice.every((state) => state === 'done')) {
      out.push('done');
      continue;
    }
    const worst = slice.reduce<SegmentState>(
      (best, state) => (state !== 'done' && RANK[state] > RANK[best] ? state : best),
      'pending',
    );
    out.push(worst);
  }
  return out;
}

function words(done: number, total: number, noun?: string): string {
  const what = noun?.trim() || 'steps done';
  return `${done} of ${total} ${what}`;
}

/** A reported share, clamped to [0, 1], or null when it is not a number the bar can draw. */
export function shareOf(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

export function segmentModel(input: SegmentInput): SegmentModel {
  const running = input.running ?? true;
  const steps = input.steps?.filter((step) => step && typeof step.state === 'string') ?? [];

  if (steps.length > 0) {
    const units = steps.map((step) => step.state);
    const done = units.filter((state) => state === 'done').length;
    return {
      indeterminate: false,
      fraction: null,
      segments: group(units),
      done,
      total: units.length,
      text: words(done, units.length, input.noun),
    };
  }

  const total = whole(input.total);
  const doneRaw = whole(input.done);
  if (total === null || total <= 0 || doneRaw === null) {
    // Nothing whole was counted. A share the source reported is the next best
    // thing, drawn as it was reported; without one the work is indeterminate.
    const fraction = shareOf(input.fraction);
    if (fraction !== null)
      return {
        indeterminate: false,
        fraction,
        segments: [],
        done: 0,
        total: 0,
        text: `${Math.round(fraction * 100)}%`,
      };
    return { indeterminate: true, fraction: null, segments: [], done: 0, total: 0, text: 'Working' };
  }

  const done = Math.min(Math.max(doneRaw, 0), total);
  const units: SegmentState[] = [];
  for (let index = 0; index < total; index += 1) {
    if (index < done) units.push('done');
    else if (index === done && input.failed) units.push('failed');
    else if (index === done && input.blocked) units.push('blocked');
    else if (index === done && running) units.push('active');
    else units.push('pending');
  }
  return {
    indeterminate: false,
    fraction: null,
    segments: group(units),
    done,
    total,
    text: words(done, total, input.noun),
  };
}
