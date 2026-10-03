/**
 * The Individual billing period (DIO-128, recommended 2026-09-30): subscription-anniversary
 * calendar months, measured in UTC from the subscription's verified effective start.
 *
 * Every boundary is computed from the original anchor and a zero-based month index, never by adding
 * 31 days or by adding a month to a previous, possibly shortened, boundary. A January 31 anchor
 * therefore runs to February 28 (or 29), then March 31, then April 30, all at the anchor's UTC time
 * of day. A period is `[startsAt, endsAt)`: at `endsAt` its included credits stop funding new work.
 *
 * Business and explicit agreement periods keep their UTC calendar months (`periodIdFor` in
 * shared/managed-usage.ts). Nothing here can be derived from a device, a sign-in, a first use or a
 * webhook's arrival time, so none of them can mint a new period or move an anchor.
 */

export const INDIVIDUAL_CYCLE_POLICY = 'subscription-month-v1' as const;

/** One verified monthly Individual term. */
export interface IndividualBillingCycle {
  policy: typeof INDIVIDUAL_CYCLE_POLICY;
  /** The subscription's original effective start, a canonical UTC timestamp. */
  anchorAt: string;
  /** Zero-based monthly offset from the original anchor. */
  index: number;
  startsAt: string;
  endsAt: string;
}

/** Large enough for any real subscription, small enough that every boundary stays a four-digit year. */
export const MAX_INDIVIDUAL_CYCLE_INDEX = 12_000;
const MIN_YEAR = 2000;
const MAX_YEAR = 9999;
const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CYCLE_ID = /^individual:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/** A canonical UTC timestamp (`Date#toISOString` form) in a supported year, as epoch milliseconds. */
function canonical(value: unknown, field: string): number {
  if (typeof value !== 'string' || !CANONICAL.test(value)) throw new RangeError(`${field} must be a canonical UTC timestamp.`);
  const when = Date.parse(value);
  if (!Number.isFinite(when) || new Date(when).toISOString() !== value) throw new RangeError(`${field} is not a real time.`);
  const year = new Date(when).getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) throw new RangeError(`${field} is outside the supported years.`);
  return when;
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The monthly boundary `offset` months after the anchor, clamped to the end of a shorter month. */
function boundary(anchor: Date, offset: number): number {
  const months = anchor.getUTCMonth() + offset;
  const year = anchor.getUTCFullYear() + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  const day = Math.min(anchor.getUTCDate(), daysIn(year, month));
  const at = new Date(Date.UTC(year, month, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
  // Date.UTC treats years 0 to 99 as 1900 to 1999; the supported years never reach them.
  if (at.getUTCFullYear() > MAX_YEAR) throw new RangeError('That billing period ends outside the supported years.');
  return at.getTime();
}

/** The `index`th monthly term of a subscription anchored at `anchorAt`. */
export function individualCycle(anchorAt: string, index: number): IndividualBillingCycle {
  const anchor = new Date(canonical(anchorAt, 'The subscription anchor'));
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDIVIDUAL_CYCLE_INDEX)
    throw new RangeError('A billing period index is a whole number from 0.');
  return {
    policy: INDIVIDUAL_CYCLE_POLICY,
    anchorAt,
    index,
    startsAt: new Date(boundary(anchor, index)).toISOString(),
    endsAt: new Date(boundary(anchor, index + 1)).toISOString(),
  };
}

/**
 * The ledger's period id for a term: `individual:<startsAt>`. Uniqueness is still scoped by the
 * ledger's `(tenant_id, organization_id, period_id)` key, so the id carries no grant, device,
 * first-use or event time.
 */
export function individualCycleId(cycle: Pick<IndividualBillingCycle, 'startsAt'>): string {
  canonical(cycle.startsAt, 'The period start');
  return `individual:${cycle.startsAt}`;
}

export function isIndividualCycleId(periodId: string): boolean {
  return CYCLE_ID.test(periodId);
}

/** The term of this subscription containing `at`, or null before the anchor. */
export function individualCycleAt(anchorAt: string, at: string | number): IndividualBillingCycle | null {
  const anchor = new Date(canonical(anchorAt, 'The subscription anchor'));
  const when = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(when)) throw new RangeError('That is not a time.');
  if (when < anchor.getTime()) return null;
  const probe = new Date(when);
  // Whole calendar months between them, then step back once if the clamped boundary is later.
  let index = (probe.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + probe.getUTCMonth() - anchor.getUTCMonth();
  if (index > 0 && boundary(anchor, index) > when) index -= 1;
  if (index > MAX_INDIVIDUAL_CYCLE_INDEX) return null;
  return individualCycle(anchorAt, index);
}

/**
 * A stored or submitted cycle, accepted only when every field is exactly what its anchor and index
 * produce. A record that disagrees with the arithmetic is refused rather than repaired.
 */
export function verifiedIndividualCycle(value: unknown): IndividualBillingCycle | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<IndividualBillingCycle>;
  if (candidate.policy !== INDIVIDUAL_CYCLE_POLICY || typeof candidate.anchorAt !== 'string' || typeof candidate.index !== 'number') return null;
  let expected: IndividualBillingCycle;
  try { expected = individualCycle(candidate.anchorAt, candidate.index); } catch { return null; }
  return candidate.startsAt === expected.startsAt && candidate.endsAt === expected.endsAt && Object.keys(candidate).length === 5 ? expected : null;
}

export function sameIndividualCycle(a: IndividualBillingCycle, b: IndividualBillingCycle): boolean {
  return a.policy === b.policy && a.anchorAt === b.anchorAt && a.index === b.index && a.startsAt === b.startsAt && a.endsAt === b.endsAt;
}

/** Whether two half-open intervals share any instant. */
export function periodsOverlap(a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }): boolean {
  return Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);
}

/** Whether an instant falls inside a term. The end is exclusive. */
export function cycleContains(cycle: { startsAt: string; endsAt: string }, at: string | number): boolean {
  const when = typeof at === 'number' ? at : Date.parse(at);
  return Date.parse(cycle.startsAt) <= when && when < Date.parse(cycle.endsAt);
}
