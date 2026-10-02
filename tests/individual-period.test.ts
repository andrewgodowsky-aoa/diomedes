/**
 * DIO-128: the Individual billing period is a subscription-anniversary calendar month in UTC.
 * Every boundary comes from the original anchor and an index, so a short month never drifts it.
 */
import { describe, expect, it } from 'vitest';
import {
  cycleContains,
  individualCycle,
  individualCycleAt,
  individualCycleId,
  isIndividualCycleId,
  periodsOverlap,
  verifiedIndividualCycle,
} from '../shared/individual-period.js';

describe('Individual anniversary periods', () => {
  it('runs a September 30 subscription to October 30 at the same UTC time', () => {
    expect(individualCycle('2026-09-30T15:00:00.000Z', 0)).toEqual({
      policy: 'subscription-month-v1', anchorAt: '2026-09-30T15:00:00.000Z', index: 0,
      startsAt: '2026-09-30T15:00:00.000Z', endsAt: '2026-10-30T15:00:00.000Z',
    });
    expect(individualCycle('2026-09-30T15:00:00.000Z', 1)).toMatchObject({
      startsAt: '2026-10-30T15:00:00.000Z', endsAt: '2026-11-30T15:00:00.000Z' });
  });

  it('clamps a January 31 anchor to February 28 and returns to March 31 and April 30', () => {
    const anchor = '2026-01-31T15:00:00.000Z';
    expect(individualCycle(anchor, 1)).toMatchObject({ startsAt: '2026-02-28T15:00:00.000Z', endsAt: '2026-03-31T15:00:00.000Z' });
    expect(individualCycle(anchor, 2)).toMatchObject({ startsAt: '2026-03-31T15:00:00.000Z', endsAt: '2026-04-30T15:00:00.000Z' });
    expect(individualCycle(anchor, 12)).toMatchObject({ startsAt: '2027-01-31T15:00:00.000Z', endsAt: '2027-02-28T15:00:00.000Z' });
  });

  it('uses February 29 in a leap year and the original day afterwards', () => {
    expect(individualCycle('2028-01-30T00:00:00.000Z', 1)).toMatchObject({ startsAt: '2028-02-29T00:00:00.000Z', endsAt: '2028-03-30T00:00:00.000Z' });
    expect(individualCycle('2028-02-29T08:30:00.000Z', 12)).toMatchObject({ startsAt: '2029-02-28T08:30:00.000Z', endsAt: '2029-03-29T08:30:00.000Z' });
  });

  it('keeps the UTC instant through daylight-saving changes and across years', () => {
    // America/New_York leaves daylight time on 2026-11-01; the UTC boundary does not move.
    expect(individualCycle('2026-10-15T03:45:12.345Z', 1)).toMatchObject({ startsAt: '2026-11-15T03:45:12.345Z', endsAt: '2026-12-15T03:45:12.345Z' });
    expect(individualCycle('2026-12-31T23:59:59.999Z', 2)).toMatchObject({ startsAt: '2027-02-28T23:59:59.999Z', endsAt: '2027-03-31T23:59:59.999Z' });
  });

  it('chains every term end to the next term start without a gap or overlap', () => {
    const anchor = '2026-01-31T15:00:00.000Z';
    for (let index = 0; index < 36; index++) {
      const term = individualCycle(anchor, index), next = individualCycle(anchor, index + 1);
      expect(term.endsAt).toBe(next.startsAt);
      expect(periodsOverlap(term, next)).toBe(false);
    }
  });

  it('finds the term containing an instant, with an exclusive end, from the original anchor', () => {
    const anchor = '2026-01-31T15:00:00.000Z';
    expect(individualCycleAt(anchor, '2026-01-31T14:59:59.999Z')).toBeNull();
    expect(individualCycleAt(anchor, anchor)?.index).toBe(0);
    expect(individualCycleAt(anchor, '2026-02-28T14:59:59.999Z')?.index).toBe(0);
    expect(individualCycleAt(anchor, '2026-02-28T15:00:00.000Z')?.index).toBe(1);
    expect(individualCycleAt(anchor, '2026-03-30T23:00:00.000Z')?.index).toBe(1);
    expect(individualCycleAt(anchor, '2026-03-31T15:00:00.000Z')?.index).toBe(2);
    // A September 30 subscriber has no new term on October 1.
    expect(individualCycleAt('2026-09-30T15:00:00.000Z', '2026-10-01T00:00:00.000Z')?.index).toBe(0);
    expect(individualCycleAt('2026-09-30T15:00:00.000Z', '2026-10-30T15:00:00.000Z')?.index).toBe(1);
  });

  it('names a term by its start, never by a grant, device or first use', () => {
    const term = individualCycle('2026-09-30T15:00:00.000Z', 1);
    expect(individualCycleId(term)).toBe('individual:2026-10-30T15:00:00.000Z');
    expect(isIndividualCycleId(individualCycleId(term))).toBe(true);
    expect(isIndividualCycleId('2026-10')).toBe(false);
    expect(cycleContains(term, term.startsAt)).toBe(true);
    expect(cycleContains(term, term.endsAt)).toBe(false);
  });

  it('accepts a stored term only when it is exactly what its anchor and index produce', () => {
    const term = individualCycle('2026-01-31T15:00:00.000Z', 1);
    expect(verifiedIndividualCycle(term)).toEqual(term);
    expect(verifiedIndividualCycle({ ...term, endsAt: '2026-03-03T15:00:00.000Z' })).toBeNull();
    expect(verifiedIndividualCycle({ ...term, startsAt: '2026-03-03T15:00:00.000Z' })).toBeNull();
    expect(verifiedIndividualCycle({ ...term, policy: 'thirty-one-days' })).toBeNull();
    expect(verifiedIndividualCycle({ ...term, extra: true })).toBeNull();
    expect(verifiedIndividualCycle(null)).toBeNull();
  });

  it('refuses non-canonical times, unsupported years and invalid indices', () => {
    for (const anchor of ['2026-09-30', '2026-09-30T15:00:00Z', '2026-02-30T15:00:00.000Z', '1999-12-31T00:00:00.000Z', 'soon'])
      expect(() => individualCycle(anchor, 0)).toThrow(RangeError);
    for (const index of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER])
      expect(() => individualCycle('2026-09-30T15:00:00.000Z', index)).toThrow(RangeError);
    expect(() => individualCycle('9999-12-15T00:00:00.000Z', 0)).toThrow(RangeError);
  });
});
