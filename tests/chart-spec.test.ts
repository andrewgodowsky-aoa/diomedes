import { describe, expect, it } from 'vitest';
import { LIMITS, parseChart, validateChart } from '../client/console/chart-spec';

const bar = (extra: Record<string, unknown> = {}) => ({
  type: 'bar',
  x: ['Jan', 'Feb'],
  series: [{ name: 'Sent', values: [1, 2] }],
  ...extra,
});
const refused = (value: unknown) => {
  const result = validateChart(value);
  if (result.ok) throw new Error(`accepted ${JSON.stringify(value)}`);
  return result.problem;
};
const many = (count: number, make: (index: number) => unknown) => Array.from({ length: count }, (_, index) => make(index));

describe('the chart spec accepts', () => {
  it('each chart type in its frozen shape', () => {
    expect(validateChart(bar({ id: 'sales-2025', title: '  Sales  ', unit: '$', caption: 'Two months.' }))).toEqual({
      ok: true,
      spec: {
        type: 'bar',
        id: 'sales-2025',
        title: 'Sales',
        unit: '$',
        caption: 'Two months.',
        x: ['Jan', 'Feb'],
        series: [{ name: 'Sent', values: [1, 2] }],
      },
    });
    for (const type of ['line', 'area']) expect(validateChart(bar({ type })).ok).toBe(true);
    expect(validateChart({ type: 'donut', slices: [{ label: 'A', value: 3 }, { label: 'B', value: 0 }] })).toEqual({
      ok: true,
      spec: { type: 'donut', slices: [{ label: 'A', value: 3 }, { label: 'B', value: 0 }] },
    });
    expect(validateChart({ type: 'segments', steps: [{ label: 'Collect', state: 'done' }, { label: 'Send', state: 'active' }] }).ok).toBe(true);
    expect(validateChart({ type: 'progress', done: 3, total: 5, label: 'records read' })).toEqual({
      ok: true,
      spec: { type: 'progress', done: 3, total: 5, label: 'records read' },
    });
    expect(validateChart(bar({ series: many(6, (i) => ({ name: `S${i}`, values: [1, 2] })) })).ok).toBe(true);
    expect(validateChart({ type: 'progress', done: 0, total: LIMITS.total }).ok).toBe(true);
  });

  it('a fence body as JSON', () => {
    expect(parseChart(JSON.stringify(bar())).ok).toBe(true);
  });
});

describe('the chart spec refuses, naming the problem', () => {
  it('text that is not one JSON object', () => {
    expect(parseChart('{"type": "bar",')).toEqual({
      ok: false,
      problem: expect.stringMatching(/^The chart is not valid JSON: /),
    });
    for (const value of [null, [], 3, 'bar']) expect(refused(value)).toBe('The chart must be one JSON object.');
  });

  it('a missing or unknown type', () => {
    const message = '"type" must be one of bar, line, area, donut, progress, segments.';
    expect(refused({ x: ['a'] })).toBe(message);
    expect(refused(bar({ type: 'pie' }))).toBe(message);
    expect(refused(bar({ type: 3 }))).toBe(message);
  });

  it('fields the spec does not have, and fields of another chart type', () => {
    expect(refused(bar({ colour: 'red' }))).toBe('The chart has an unknown field "colour".');
    expect(refused(bar({ slices: [] }))).toBe('"slices" is only used by donut charts, not by a bar chart.');
    expect(refused({ type: 'donut', x: ['a'], slices: [{ label: 'A', value: 1 }] })).toBe(
      '"x" is only used by bar, line and area charts, not by a donut chart.',
    );
    expect(refused({ type: 'segments', done: 1, steps: [] })).toBe('"done" is only used by progress charts, not by a segments chart.');
    expect(refused({ type: 'progress', steps: [], done: 1, total: 2 })).toBe('"steps" is only used by segments charts, not by a progress chart.');
  });

  it('an id it cannot use, and text fields that are empty or too long', () => {
    const id = '"id" must start with a letter or digit and use only letters, digits, ".", "_" and "-" (64 at most).';
    expect(refused(bar({ id: 'has space' }))).toBe(id);
    expect(refused(bar({ id: '-leading' }))).toBe(id);
    expect(refused(bar({ id: 'x'.repeat(65) }))).toBe(id);
    expect(refused(bar({ id: 7 }))).toBe(id);
    expect(refused(bar({ title: '   ' }))).toBe('"title" must be text that is not empty.');
    expect(refused(bar({ title: 5 }))).toBe('"title" must be text that is not empty.');
    expect(refused(bar({ title: 'x'.repeat(LIMITS.title + 1) }))).toBe('"title" is longer than 120 characters.');
    expect(refused(bar({ unit: 'x'.repeat(LIMITS.unit + 1) }))).toBe('"unit" is longer than 16 characters.');
    expect(refused(bar({ caption: 'x'.repeat(LIMITS.caption + 1) }))).toBe('"caption" is longer than 280 characters.');
  });

  it('bar, line and area charts whose categories and series do not agree', () => {
    expect(refused({ type: 'bar', series: [{ name: 'S', values: [1] }] })).toBe('"x" is missing: list the category labels.');
    expect(refused({ type: 'line', x: ['a'] })).toBe('"series" is missing: give at least one series of values.');
    expect(refused(bar({ x: 'Jan' }))).toBe('"x" must be a list.');
    expect(refused(bar({ x: [] }))).toBe('"x" must hold 1 to 100 entries; it holds 0.');
    expect(refused(bar({ x: many(101, String), series: [{ name: 'S', values: many(101, () => 1) }] }))).toBe(
      '"x" must hold 1 to 100 entries; it holds 101.',
    );
    expect(refused(bar({ x: ['Jan', ''] }))).toBe('x label 2 must be text that is not empty.');
    expect(refused(bar({ x: ['x'.repeat(61), 'Feb'] }))).toBe('x label 1 is longer than 60 characters.');
    expect(refused(bar({ series: { name: 'S' } }))).toBe('"series" must be a list.');
    expect(refused(bar({ series: [] }))).toBe('"series" must hold 1 to 6 entries; it holds 0.');
    expect(refused(bar({ series: many(7, (i) => ({ name: `S${i}`, values: [1, 2] })) }))).toBe(
      '"series" must hold 1 to 6 entries; it holds 7.',
    );
    expect(refused(bar({ series: [[1, 2]] }))).toBe('series 1 must be an object with "name" and "values".');
    expect(refused(bar({ series: [{ name: 'S', values: [1, 2], color: 'red' }] }))).toBe('series 1 has an unknown field "color".');
    expect(refused(bar({ series: [{ values: [1, 2] }] }))).toBe('series 1 "name" must be text that is not empty.');
    expect(refused(bar({ series: [{ name: 'Sent', values: '1,2' }] }))).toBe('series 1 ("Sent") must give "values" as a list of numbers.');
    expect(refused(bar({ series: [{ name: 'Sent', values: [1, '2'] }] }))).toBe('series 1 ("Sent") value 2 is not a finite number.');
    expect(refused(bar({ series: [{ name: 'Sent', values: [1, null] }] }))).toBe('series 1 ("Sent") value 2 is not a finite number.');
    expect(refused(bar({ series: [{ name: 'Sent', values: [1, Number.POSITIVE_INFINITY] }] }))).toBe(
      'series 1 ("Sent") value 2 is not a finite number.',
    );
    expect(
      refused(
        bar({
          x: ['a', 'b', 'c', 'd', 'e'],
          series: [
            { name: 'Sent', values: [1, 2, 3, 4, 5] },
            { name: 'Received', values: [1, 2, 3, 4] },
          ],
        }),
      ),
    ).toBe('series 2 ("Received") has 4 values; "x" has 5 labels.');
  });

  it('donuts that are not parts of a whole', () => {
    expect(refused({ type: 'donut' })).toBe('"slices" is missing: give each slice a label and a value.');
    expect(refused({ type: 'donut', slices: many(9, (i) => ({ label: `P${i}`, value: 1 })) })).toBe(
      '"slices" must hold 1 to 8 entries; it holds 9.',
    );
    expect(refused({ type: 'donut', slices: ['A'] })).toBe('slice 1 must be an object with "label" and "value".');
    expect(refused({ type: 'donut', slices: [{ label: 'A', value: 1, share: 1 }] })).toBe('slice 1 has an unknown field "share".');
    expect(refused({ type: 'donut', slices: [{ value: 1 }] })).toBe('slice 1 "label" must be text that is not empty.');
    expect(refused({ type: 'donut', slices: [{ label: 'A', value: '1' }] })).toBe('slice 1 ("A") value is not a finite number.');
    expect(refused({ type: 'donut', slices: [{ label: 'A', value: 1 }, { label: 'B', value: -1 }] })).toBe(
      'slice 2 ("B") value is negative; a donut shows parts of a whole.',
    );
    expect(refused({ type: 'donut', slices: [{ label: 'A', value: 0 }] })).toBe('The slices add up to 0, so there is no whole to divide.');
  });

  it('segments whose steps are not the record states', () => {
    expect(refused({ type: 'segments' })).toBe('"steps" is missing: list each step with its state.');
    expect(refused({ type: 'segments', steps: many(51, () => ({ label: 'S', state: 'done' })) })).toBe(
      '"steps" must hold 1 to 50 entries; it holds 51.',
    );
    expect(refused({ type: 'segments', steps: ['done'] })).toBe('step 1 must be an object with "label" and "state".');
    expect(refused({ type: 'segments', steps: [{ label: 'S', state: 'done', at: 1 }] })).toBe('step 1 has an unknown field "at".');
    expect(refused({ type: 'segments', steps: [{ state: 'done' }] })).toBe('step 1 "label" must be text that is not empty.');
    expect(refused({ type: 'segments', steps: [{ label: 'Collect', state: 'finished' }] })).toBe(
      'step 1 ("Collect") state must be one of done, active, pending, failed, blocked.',
    );
  });

  it('progress that does not count whole units', () => {
    expect(refused({ type: 'progress', done: 1 })).toBe('"total" is missing: say how many units there are.');
    expect(refused({ type: 'progress', total: 4 })).toBe('"done" is missing: say how many units are done.');
    const total = '"total" must be a whole number from 1 to 1000.';
    expect(refused({ type: 'progress', done: 0, total: 0 })).toBe(total);
    expect(refused({ type: 'progress', done: 0, total: 1001 })).toBe(total);
    expect(refused({ type: 'progress', done: 0, total: 2.5 })).toBe(total);
    expect(refused({ type: 'progress', done: 0, total: '5' })).toBe('"total" is not a finite number.');
    expect(refused({ type: 'progress', done: 6, total: 5 })).toBe('"done" must be a whole number from 0 to 5.');
    expect(refused({ type: 'progress', done: -1, total: 5 })).toBe('"done" must be a whole number from 0 to 5.');
    expect(refused({ type: 'progress', done: 1.5, total: 5 })).toBe('"done" must be a whole number from 0 to 5.');
    expect(refused({ type: 'progress', done: 1, total: 5, label: '' })).toBe('"label" must be text that is not empty.');
    expect(refused({ type: 'progress', done: 1, total: 5, label: 'x'.repeat(61) })).toBe('"label" is longer than 60 characters.');
  });
});
