/**
 * Automations Milestone B: calendar-time schedules, as pure functions.
 *
 * A schedule is a local wall-clock time on a calendar ("every Monday at 8:00
 * a.m.") in an explicit IANA timezone, never a fixed UTC offset and never an
 * elapsed interval. Everything here is deterministic: no function reads the
 * clock, so every slot, preview and plan is a function of its arguments and the
 * same inputs always give the same answer (A04).
 *
 * Daylight-saving rules (proposed defaults, recorded in
 * docs/implementation/2026-09-24-automations-b.md):
 *
 * - **A local time that does not exist** that day (clocks go forward through
 *   it) runs at the next valid instant, the moment the clocks jump. The slot
 *   says so (`shifted: 'gap'`).
 * - **A local time that happens twice** (clocks go back through it) runs once,
 *   at its first occurrence. There is one slot per local date, so a repeated
 *   hour can never make a second one.
 *
 * A slot's identity is its instant (`at`, UTC ISO). Together with the
 * automation and the definition revision it names one scheduled occurrence,
 * so a duplicate dispatch, a restart or a second pass names the same one (A05).
 */

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface AutomationSchedule {
  readonly cadence: 'daily' | 'weekly';
  /** 0 is Sunday. Set for a weekly schedule, null for a daily one. */
  readonly weekday: Weekday | null;
  /** Local wall-clock time, `HH:MM`, 24-hour. */
  readonly time: string;
  /** An IANA timezone identifier, such as `America/New_York`. */
  readonly timezone: string;
}

/** Proposed default: one catch-up of the most recent missed slot, within two hours. */
export const DEFAULT_CATCH_UP_MINUTES = 120;
export const CATCH_UP_CHOICES = [0, 60, 120, 240] as const;
export const MAX_CATCH_UP_MINUTES = 24 * 60;
/** A slot started within this long of its time counts as on time, not caught up. */
export const ON_TIME_MS = 2 * 60_000;
/** Missed slots older than this are not listed one by one. */
export const MAX_BACKLOG_MS = 400 * 24 * 60 * 60_000;

const DAY = 24 * 60 * 60_000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

// --- validation ---------------------------------------------------------------

const zones = new Map<string, Intl.DateTimeFormat | null>();
function formatter(timezone: string): Intl.DateTimeFormat | null {
  if (zones.has(timezone)) return zones.get(timezone)!;
  let made: Intl.DateTimeFormat | null = null;
  if (ZONE.test(timezone))
    try {
      made = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      made = null;
    }
  zones.set(timezone, made);
  return made;
}

/** A named IANA zone this runtime knows. A bare offset such as `+05:00` is refused. */
export function isTimeZone(timezone: unknown): timezone is string {
  return typeof timezone === 'string' && timezone.length <= 64 && formatter(timezone) !== null;
}

export type ScheduleCheck =
  | { readonly ok: true; readonly schedule: AutomationSchedule }
  | { readonly ok: false; readonly message: string };

/** Check a schedule a person sent. Fixed properties only; nothing is guessed. */
export function checkSchedule(input: unknown): ScheduleCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, message: 'Send a schedule.' };
  const value = input as Record<string, unknown>;
  const extra = Object.keys(value).filter(
    (key) => !['cadence', 'weekday', 'time', 'timezone'].includes(key),
  );
  if (extra.length) return { ok: false, message: `A schedule has no ${extra[0]}.` };
  if (value.cadence !== 'daily' && value.cadence !== 'weekly')
    return { ok: false, message: 'Choose every day or every week.' };
  let weekday: Weekday | null = null;
  if (value.cadence === 'weekly') {
    if (typeof value.weekday !== 'number' || !Number.isInteger(value.weekday) || value.weekday < 0 || value.weekday > 6)
      return { ok: false, message: 'Choose the day of the week.' };
    weekday = value.weekday as Weekday;
  } else if (value.weekday !== undefined && value.weekday !== null)
    return { ok: false, message: 'A daily schedule has no day of the week.' };
  if (typeof value.time !== 'string' || !TIME.test(value.time))
    return { ok: false, message: 'Give the time as hours and minutes, such as 08:00.' };
  if (!isTimeZone(value.timezone))
    return { ok: false, message: 'Choose a named timezone, such as America/New_York.' };
  return {
    ok: true,
    schedule: { cadence: value.cadence, weekday, time: value.time, timezone: value.timezone },
  };
}

export const sameSchedule = (a: AutomationSchedule | null, b: AutomationSchedule | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.cadence === b.cadence &&
    a.weekday === b.weekday &&
    a.time === b.time &&
    a.timezone === b.timezone);

// --- wall clock ---------------------------------------------------------------

export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The wall-clock reading in `timezone` at an instant. */
export function wallClock(timezone: string, ms: number): WallClock {
  const format = formatter(timezone);
  if (!format) throw new Error(`Unknown timezone ${timezone}`);
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(ms)))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** The wall-clock reading written as if it were UTC: comparable, monotonic between transitions. */
const naiveOf = (wall: WallClock) =>
  Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

/** The zone's offset from UTC at an instant, in milliseconds. */
const offsetAt = (timezone: string, ms: number) =>
  naiveOf(wallClock(timezone, ms)) - Math.floor(ms / 1000) * 1000;

/**
 * The instant a local date and time names in `timezone`. A repeated time
 * gives its first occurrence; a time that does not exist gives the instant the
 * clocks jump past it, marked `gap`.
 */
export function resolveLocal(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): { readonly ms: number; readonly shifted: 'gap' | null } {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = [...new Set([-DAY, 0, DAY].map((delta) => offsetAt(timezone, naive + delta)))];
  const valid = offsets
    .map((offset) => naive - offset)
    .filter((ms) => naiveOf(wallClock(timezone, ms)) === naive)
    .sort((a, b) => a - b);
  if (valid.length) return { ms: valid[0]!, shifted: null };
  // Clocks went forward through this time. Find the jump: the first instant
  // whose wall-clock reading is past the requested one.
  const candidates = offsets.map((offset) => naive - offset);
  let low = Math.min(...candidates);
  let high = Math.max(...candidates);
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2000) * 1000;
    if (middle <= low || middle >= high) break;
    if (naiveOf(wallClock(timezone, middle)) > naive) high = middle;
    else low = middle;
  }
  return { ms: high, shifted: 'gap' };
}

// --- slots ----------------------------------------------------------------------

export interface ScheduleSlot {
  /** The instant, UTC ISO. The slot's identity. */
  readonly at: string;
  readonly ms: number;
  /** The intended local date and time, `YYYY-MM-DD HH:MM`, in the schedule's timezone. */
  readonly local: string;
  /** `gap`: the intended time did not exist that day, so it runs when the clocks jump. */
  readonly shifted: 'gap' | null;
}

const pad = (value: number) => String(value).padStart(2, '0');

function slotOn(schedule: AutomationSchedule, dateMs: number): ScheduleSlot | null {
  const date = new Date(dateMs);
  if (schedule.cadence === 'weekly' && date.getUTCDay() !== schedule.weekday) return null;
  const [hour, minute] = schedule.time.split(':').map(Number) as [number, number];
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const resolved = resolveLocal(schedule.timezone, year, month, day, hour, minute);
  return {
    at: new Date(resolved.ms).toISOString(),
    ms: resolved.ms,
    local: `${year}-${pad(month)}-${pad(day)} ${schedule.time}`,
    shifted: resolved.shifted,
  };
}

const localDate = (timezone: string, ms: number) => {
  const wall = wallClock(timezone, ms);
  return Date.UTC(wall.year, wall.month - 1, wall.day);
};

/** Every slot after `afterMs` up to and including `untilMs`, oldest first. */
export function slotsBetween(
  schedule: AutomationSchedule,
  afterMs: number,
  untilMs: number,
  limit = 1000,
): ScheduleSlot[] {
  const out: ScheduleSlot[] = [];
  if (untilMs <= afterMs) return out;
  const last = localDate(schedule.timezone, untilMs) + DAY;
  for (let date = localDate(schedule.timezone, afterMs) - DAY; date <= last; date += DAY) {
    const slot = slotOn(schedule, date);
    if (slot && slot.ms > afterMs && slot.ms <= untilMs) out.push(slot);
    if (out.length >= limit) break;
  }
  return out;
}

/** The next `count` slots strictly after `afterMs`. */
export function nextSlots(schedule: AutomationSchedule, afterMs: number, count: number): ScheduleSlot[] {
  const out: ScheduleSlot[] = [];
  for (
    let date = localDate(schedule.timezone, afterMs) - DAY, guard = 0;
    out.length < count && guard < 800;
    date += DAY, guard += 1
  ) {
    const slot = slotOn(schedule, date);
    if (slot && slot.ms > afterMs) out.push(slot);
  }
  return out;
}

export interface DuePlan {
  /** The one slot to admit now, or null. */
  readonly due: ScheduleSlot | null;
  /** The due slot started more than `ON_TIME_MS` after its time: a catch-up. */
  readonly late: boolean;
  /** Slots that passed while nothing could run them, oldest first. Each is recorded, never run. */
  readonly missed: readonly ScheduleSlot[];
}

/**
 * What a pass at `nowMs` does with the slots after `afterMs` that have no
 * occurrence yet. The policy is bounded: every slot that passed unseen is
 * recorded as missed, and only the most recent may still run, when it is on
 * time or within the catch-up window. A backlog never runs (A02).
 */
export function planDue(input: {
  readonly schedule: AutomationSchedule;
  readonly afterMs: number;
  readonly nowMs: number;
  /** Slot instants (`at`) that already have an occurrence, of any revision. */
  readonly covered: ReadonlySet<string>;
  readonly catchUpMinutes: number;
}): DuePlan {
  const from = Math.max(input.afterMs, input.nowMs - MAX_BACKLOG_MS);
  const open = slotsBetween(input.schedule, from, input.nowMs).filter(
    (slot) => !input.covered.has(slot.at),
  );
  const last = open.at(-1);
  if (!last) return { due: null, late: false, missed: [] };
  const lateBy = input.nowMs - last.ms;
  const runs = lateBy <= ON_TIME_MS || lateBy <= input.catchUpMinutes * 60_000;
  return {
    due: runs ? last : null,
    late: runs && lateBy > ON_TIME_MS,
    missed: runs ? open.slice(0, -1) : open,
  };
}

// --- words ------------------------------------------------------------------------

/** `08:00` as `8:00 a.m.`. */
export function clockText(time: string): string {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${pad(minute)} ${hour < 12 ? 'a.m.' : 'p.m.'}`;
}

/** "Every Monday at 8:00 a.m. America/New_York". */
export function describeSchedule(schedule: AutomationSchedule): string {
  const when = schedule.cadence === 'weekly' ? WEEKDAY_NAMES[schedule.weekday ?? 0] : 'day';
  return `Every ${when} at ${clockText(schedule.time)} ${schedule.timezone}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An instant as the schedule's own local time: "Mon 28 Sep 2026, 8:00 a.m.". */
export function localText(timezone: string, ms: number): string {
  const wall = wallClock(timezone, ms);
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  return `${WEEKDAY_NAMES[weekday]!.slice(0, 3)} ${wall.day} ${MONTHS[wall.month - 1]} ${wall.year}, ${clockText(
    `${pad(wall.hour)}:${pad(wall.minute)}`,
  )}`;
}

/** A slot in words, saying so when the clocks moved it. */
export function slotText(schedule: AutomationSchedule, slot: ScheduleSlot): string {
  const at = localText(schedule.timezone, slot.ms);
  return slot.shifted === 'gap'
    ? `${at} (${clockText(slot.local.slice(11))} does not exist that day: the clocks go forward)`
    : at;
}
