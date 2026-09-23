// The segment bar's arithmetic, kept pure so its honesty rule can be tested
// without a DOM. A bar only ever shows what a record counted: named steps, or
// k of n from the record itself. Anything else is drawn as indeterminate work,
// never as an invented fraction.

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
  /** One entry per drawn segment (at most MAX_SEGMENTS). */
  segments: SegmentState[];
  done: number;
  total: number;
  /** Plain words, e.g. "3 of 4 records read"; "Working" when nothing was counted. */
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

export function segmentModel(input: SegmentInput): SegmentModel {
  const running = input.running ?? true;
  const steps = input.steps?.filter((step) => step && typeof step.state === 'string') ?? [];

  if (steps.length > 0) {
    const units = steps.map((step) => step.state);
    const done = units.filter((state) => state === 'done').length;
    return {
      indeterminate: false,
      segments: group(units),
      done,
      total: units.length,
      text: words(done, units.length, input.noun),
    };
  }

  const total = whole(input.total);
  const doneRaw = whole(input.done);
  if (total === null || total <= 0 || doneRaw === null) {
    return { indeterminate: true, segments: [], done: 0, total: 0, text: 'Working' };
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
  return { indeterminate: false, segments: group(units), done, total, text: words(done, total, input.noun) };
}
