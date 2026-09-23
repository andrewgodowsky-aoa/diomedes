import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MAX_SEGMENTS, segmentModel } from '../client/console/segment-bar-model';
import { SegmentBar } from '../client/console/SegmentBar';

describe('segment bar honesty', () => {
  it('draws nothing countable when the record counted nothing', () => {
    for (const input of [
      {},
      { total: 0, done: 0 },
      { total: 4 },
      { total: Number.NaN, done: 1 },
      { total: 4, done: Number.POSITIVE_INFINITY },
      { steps: [] },
    ]) {
      const model = segmentModel(input);
      expect(model.indeterminate).toBe(true);
      expect(model.segments).toEqual([]);
      expect(model.text).toBe('Working');
    }
  });

  it('lights exactly the counted units and marks the next one active while running', () => {
    const model = segmentModel({ total: 4, done: 3, noun: 'records read' });
    expect(model.segments).toEqual(['done', 'done', 'done', 'active']);
    expect(model.text).toBe('3 of 4 records read');
  });

  it('never marks a unit active once the work has stopped moving', () => {
    expect(segmentModel({ total: 3, done: 1, running: false }).segments).toEqual([
      'done',
      'pending',
      'pending',
    ]);
  });

  it('shows the waiting and failed unit in its state colour', () => {
    expect(segmentModel({ total: 3, done: 1, blocked: true }).segments[1]).toBe('blocked');
    expect(segmentModel({ total: 3, done: 2, failed: true }).segments[2]).toBe('failed');
  });

  it('clamps a count outside the record rather than drawing past the end', () => {
    expect(segmentModel({ total: 2, done: 7 }).segments).toEqual(['done', 'done']);
    expect(segmentModel({ total: 2, done: -3 }).segments).toEqual(['active', 'pending']);
  });

  it('derives counts from named steps when the record lists them', () => {
    const model = segmentModel({
      steps: [
        { label: 'Read orders', state: 'done' },
        { label: 'Read invoices', state: 'done' },
        { label: 'Match rows', state: 'active' },
        { label: 'Write checklist', state: 'pending' },
      ],
    });
    expect(model.done).toBe(2);
    expect(model.total).toBe(4);
    expect(model.text).toBe('2 of 4 steps done');
  });

  it('groups long runs without hiding the most urgent unit', () => {
    const steps = Array.from({ length: 30 }, (_, index) => ({
      state: index < 20 ? ('done' as const) : index === 25 ? ('blocked' as const) : ('pending' as const),
    }));
    const model = segmentModel({ steps });
    expect(model.segments.length).toBeLessThanOrEqual(MAX_SEGMENTS);
    expect(model.segments).toContain('blocked');
    expect(model.total).toBe(30);
    expect(model.done).toBe(20);
  });
});

describe('segment bar markup', () => {
  it('exposes a progressbar with the counted value and plain words', () => {
    const html = renderToStaticMarkup(
      createElement(SegmentBar, { label: 'Comparing delivery records', total: 4, done: 3, noun: 'records read' }),
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('aria-valuemax="4"');
    expect(html).toContain('aria-valuetext="3 of 4 records read"');
    expect(html.match(/class="seg /g)?.length).toBe(4);
    expect(html).toContain('3 of 4 records read</span>');
  });

  it('omits a value from an indeterminate bar', () => {
    const html = renderToStaticMarkup(createElement(SegmentBar, { label: 'Working on it' }));
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain('aria-valuenow');
    expect(html).toContain('aria-valuetext="Working"');
    expect(html).toContain('seg-scan');
  });
});
