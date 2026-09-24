/**
 * Automations Milestone B: calendar-time slots, as table tests (A04).
 *
 * Every function under test is pure and takes its instants as arguments, so
 * no row depends on the clock of the machine running it. The daylight-saving
 * dates are real 2026 transitions: New York goes forward on 8 March at 2:00
 * and back on 1 November at 2:00; London goes forward on 29 March at 1:00 and
 * back on 25 October at 2:00.
 */
import { describe, expect, test } from 'vitest';
import {
  checkSchedule,
  clockText,
  describeSchedule,
  localText,
  nextSlots,
  planDue,
  resolveLocal,
  slotsBetween,
  slotText,
  type AutomationSchedule,
} from '../shared/automation-schedule.js';

const NY = 'America/New_York';
const LONDON = 'Europe/London';
const daily = (time: string, timezone = NY): AutomationSchedule => ({
  cadence: 'daily',
  weekday: null,
  time,
  timezone,
});
const weekly = (weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6, time: string, timezone = NY): AutomationSchedule => ({
  cadence: 'weekly',
  weekday,
  time,
  timezone,
});
const ms = (iso: string) => Date.parse(iso);
const iso = (value: number) => new Date(value).toISOString();

describe('a local time resolves to one instant', () => {
  test.each([
    // [zone, local date, time, expected instant, shifted]
    [NY, '2026-09-28', '08:00', '2026-09-28T12:00:00.000Z', null], // summer time
    [NY, '2026-11-02', '08:00', '2026-11-02T13:00:00.000Z', null], // winter time
    [NY, '2026-03-07', '02:30', '2026-03-07T07:30:00.000Z', null], // the day before the gap
    [NY, '2026-03-08', '02:30', '2026-03-08T07:00:00.000Z', 'gap'], // does not exist: runs at 3:00
    [NY, '2026-03-08', '02:00', '2026-03-08T07:00:00.000Z', 'gap'], // the first missing minute
    [NY, '2026-03-08', '03:00', '2026-03-08T07:00:00.000Z', null], // the jump's own time exists
    [NY, '2026-03-09', '02:30', '2026-03-09T06:30:00.000Z', null],
    [NY, '2026-11-01', '01:30', '2026-11-01T05:30:00.000Z', null], // repeated: the first one
    [NY, '2026-11-01', '01:00', '2026-11-01T05:00:00.000Z', null],
    [NY, '2026-11-01', '02:00', '2026-11-01T07:00:00.000Z', null], // after the repeat
    [LONDON, '2026-03-29', '01:30', '2026-03-29T01:00:00.000Z', 'gap'],
    [LONDON, '2026-10-25', '01:30', '2026-10-25T00:30:00.000Z', null],
    ['Asia/Kolkata', '2026-09-28', '08:00', '2026-09-28T02:30:00.000Z', null],
    ['UTC', '2026-09-28', '23:59', '2026-09-28T23:59:00.000Z', null],
  ] as const)('%s %s %s', (zone, date, time, expected, shifted) => {
    const [year, month, day] = date.split('-').map(Number) as [number, number, number];
    const [hour, minute] = time.split(':').map(Number) as [number, number];
    const resolved = resolveLocal(zone, year, month, day, hour, minute);
    expect(iso(resolved.ms)).toBe(expected);
    expect(resolved.shifted).toBe(shifted);
  });
});

describe('slots', () => {
  test('a weekly schedule names its next Mondays', () => {
    const next = nextSlots(weekly(1, '08:00'), ms('2026-09-24T12:00:00Z'), 3);
    expect(next.map((slot) => slot.at)).toEqual([
      '2026-09-28T12:00:00.000Z',
      '2026-10-05T12:00:00.000Z',
      '2026-10-12T12:00:00.000Z',
    ]);
    expect(next[0]!.local).toBe('2026-09-28 08:00');
  });

  test('a weekly schedule keeps its local time across the autumn change', () => {
    const next = nextSlots(weekly(1, '08:00'), ms('2026-10-20T00:00:00Z'), 3);
    expect(next.map((slot) => slot.at)).toEqual([
      '2026-10-26T12:00:00.000Z',
      '2026-11-02T13:00:00.000Z',
      '2026-11-09T13:00:00.000Z',
    ]);
  });

  test('a slot at its exact instant is not "next"; one after it is', () => {
    const at = ms('2026-09-28T12:00:00Z');
    expect(nextSlots(weekly(1, '08:00'), at, 1)[0]!.at).toBe('2026-10-05T12:00:00.000Z');
    expect(nextSlots(weekly(1, '08:00'), at - 1, 1)[0]!.at).toBe('2026-09-28T12:00:00.000Z');
  });

  test('the repeated hour runs once, at its first occurrence', () => {
    for (const time of ['01:00', '01:30', '01:59']) {
      const day = slotsBetween(daily(time), ms('2026-11-01T00:00:00Z'), ms('2026-11-02T00:00:00Z'));
      expect(day, time).toHaveLength(1);
      expect(day[0]!.shifted).toBeNull();
    }
  });

  test('the missing hour still runs that day, at the jump, and says so', () => {
    const days = slotsBetween(daily('02:30'), ms('2026-03-07T00:00:00Z'), ms('2026-03-10T00:00:00Z'));
    expect(days.map((slot) => [slot.at, slot.shifted])).toEqual([
      ['2026-03-07T07:30:00.000Z', null],
      ['2026-03-08T07:00:00.000Z', 'gap'],
      ['2026-03-09T06:30:00.000Z', null],
    ]);
    expect(slotText(daily('02:30'), days[1]!)).toBe(
      'Sun 8 Mar 2026, 3:00 a.m. (2:30 a.m. does not exist that day: the clocks go forward)',
    );
  });

  test('slots are identical however often they are computed', () => {
    const a = slotsBetween(weekly(5, '17:45', LONDON), ms('2026-01-01T00:00:00Z'), ms('2027-01-01T00:00:00Z'));
    const b = slotsBetween(weekly(5, '17:45', LONDON), ms('2026-01-01T00:00:00Z'), ms('2027-01-01T00:00:00Z'));
    expect(a).toEqual(b);
    expect(a).toHaveLength(52);
    expect(new Set(a.map((slot) => slot.at)).size).toBe(52);
  });
});

describe('the missed-run plan (A02)', () => {
  const schedule = daily('08:00');
  const catchUp = 120;
  const off = ms('2026-09-25T00:00:00Z');

  test('on time: the due slot runs, nothing is missed', () => {
    const plan = planDue({
      schedule,
      afterMs: off,
      nowMs: ms('2026-09-25T12:00:20Z'),
      covered: new Set(),
      catchUpMinutes: catchUp,
    });
    expect(plan.due?.at).toBe('2026-09-25T12:00:00.000Z');
    expect(plan.late).toBe(false);
    expect(plan.missed).toEqual([]);
  });

  test('back within the window: the most recent slot catches up, earlier ones are only recorded', () => {
    const plan = planDue({
      schedule,
      afterMs: off,
      nowMs: ms('2026-09-27T13:30:00Z'),
      covered: new Set(),
      catchUpMinutes: catchUp,
    });
    expect(plan.due?.at).toBe('2026-09-27T12:00:00.000Z');
    expect(plan.late).toBe(true);
    expect(plan.missed.map((slot) => slot.at)).toEqual([
      '2026-09-25T12:00:00.000Z',
      '2026-09-26T12:00:00.000Z',
    ]);
  });

  test('back after the window: nothing runs, every slot is recorded missed', () => {
    const plan = planDue({
      schedule,
      afterMs: off,
      nowMs: ms('2026-09-27T15:00:00Z'),
      covered: new Set(),
      catchUpMinutes: catchUp,
    });
    expect(plan.due).toBeNull();
    expect(plan.missed).toHaveLength(3);
  });

  test('no catch-up at all when the window is zero, beyond two minutes late', () => {
    const plan = planDue({
      schedule,
      afterMs: off,
      nowMs: ms('2026-09-25T12:05:00Z'),
      covered: new Set(),
      catchUpMinutes: 0,
    });
    expect(plan.due).toBeNull();
    expect(plan.missed.map((slot) => slot.at)).toEqual(['2026-09-25T12:00:00.000Z']);
  });

  test('a covered slot is never planned again, and nothing before the lower bound is', () => {
    const covered = new Set(['2026-09-25T12:00:00.000Z']);
    const plan = planDue({
      schedule,
      afterMs: off,
      nowMs: ms('2026-09-25T12:01:00Z'),
      covered,
      catchUpMinutes: catchUp,
    });
    expect(plan).toEqual({ due: null, late: false, missed: [] });
    expect(
      planDue({
        schedule,
        afterMs: ms('2026-09-25T12:00:30Z'),
        nowMs: ms('2026-09-25T12:01:00Z'),
        covered: new Set(),
        catchUpMinutes: catchUp,
      }),
    ).toEqual({ due: null, late: false, missed: [] });
  });

  test('a year away lists at most the backlog bound, never runs it', () => {
    const plan = planDue({
      schedule,
      afterMs: ms('2024-01-01T00:00:00Z'),
      nowMs: ms('2026-09-25T20:00:00Z'),
      covered: new Set(),
      catchUpMinutes: catchUp,
    });
    expect(plan.due).toBeNull();
    expect(plan.missed.length).toBeLessThanOrEqual(401);
    expect(plan.missed.length).toBeGreaterThan(390);
  });
});

describe('words and validation', () => {
  test.each([
    ['00:00', '12:00 a.m.'],
    ['08:00', '8:00 a.m.'],
    ['12:30', '12:30 p.m.'],
    ['23:05', '11:05 p.m.'],
  ])('%s reads %s', (time, text) => expect(clockText(time)).toBe(text));

  test('a schedule is said the way a person reads it', () => {
    expect(describeSchedule(weekly(1, '08:00'))).toBe('Every Monday at 8:00 a.m. America/New_York');
    expect(describeSchedule(daily('17:30', LONDON))).toBe('Every day at 5:30 p.m. Europe/London');
    expect(localText(NY, ms('2026-09-28T12:00:00Z'))).toBe('Mon 28 Sep 2026, 8:00 a.m.');
  });

  test.each([
    [{ cadence: 'weekly', weekday: 1, time: '08:00', timezone: NY }, true],
    [{ cadence: 'daily', weekday: null, time: '08:00', timezone: 'UTC' }, true],
    [{ cadence: 'weekly', time: '08:00', timezone: NY }, false],
    [{ cadence: 'weekly', weekday: 7, time: '08:00', timezone: NY }, false],
    [{ cadence: 'daily', weekday: 2, time: '08:00', timezone: NY }, false],
    [{ cadence: 'daily', weekday: null, time: '8:00', timezone: NY }, false],
    [{ cadence: 'daily', weekday: null, time: '24:00', timezone: NY }, false],
    [{ cadence: 'daily', weekday: null, time: '08:00', timezone: '+05:00' }, false],
    [{ cadence: 'daily', weekday: null, time: '08:00', timezone: 'Mars/Olympus_Mons' }, false],
    [{ cadence: 'hourly', weekday: null, time: '08:00', timezone: NY }, false],
    [{ cadence: 'daily', weekday: null, time: '08:00', timezone: NY, every: 24 }, false],
    [null, false],
  ])('%j is %s', (input, ok) => expect(checkSchedule(input).ok).toBe(ok));
});

describe('independent review (review-e): calendar edges', () => {
  test('a skipped calendar day never makes two slots at one instant (Pacific/Apia, 30 Dec 2011)', () => {
    const apia = daily('00:00', 'Pacific/Apia');
    const slots = slotsBetween(apia, ms('2011-12-28T12:00:00Z'), ms('2012-01-02T12:00:00Z'));
    expect(new Set(slots.map((slot) => slot.at)).size).toBe(slots.length);
    // The day that exists runs; the one that never existed adds nothing.
    expect(slots.find((slot) => slot.at === '2011-12-30T10:00:00.000Z')).toMatchObject({ local: '2011-12-31 00:00', shifted: null });
    const preview = nextSlots(apia, ms('2011-12-29T11:00:00Z'), 3);
    expect(new Set(preview.map((slot) => slot.at)).size).toBe(3);
    // On time at the jump, the slot runs; it is not recorded as missed as well.
    const plan = planDue({ schedule: apia, afterMs: ms('2011-12-29T11:00:00Z'), nowMs: ms('2011-12-30T10:00:30Z'), covered: new Set(), catchUpMinutes: 120 });
    expect(plan.missed).toEqual([]);
    expect(plan.due?.at).toBe('2011-12-30T10:00:00.000Z');
  });

  test('the on-time and catch-up windows include their last millisecond and no more', () => {
    const schedule = daily('08:00');
    const slot = ms('2026-09-28T12:00:00Z');
    const plan = (nowMs: number, catchUpMinutes: number) =>
      planDue({ schedule, afterMs: slot - 60_000, nowMs, covered: new Set(), catchUpMinutes });
    expect(plan(slot + 120_000, 0)).toMatchObject({ late: false, due: { ms: slot } });
    expect(plan(slot + 120_001, 0)).toMatchObject({ due: null, missed: [{ ms: slot }] });
    expect(plan(slot + 120_001, 60)).toMatchObject({ late: true, due: { ms: slot } });
    expect(plan(slot + 3_600_000, 60)).toMatchObject({ late: true, due: { ms: slot } });
    expect(plan(slot + 3_600_001, 60)).toMatchObject({ due: null, missed: [{ ms: slot }] });
  });

  test('a slot exactly at the moment a schedule was turned on or edited is not its own', () => {
    const schedule = daily('08:00');
    const slot = ms('2026-09-28T12:00:00Z');
    expect(slotsBetween(schedule, slot, slot + 60_000)).toEqual([]);
  });
});
