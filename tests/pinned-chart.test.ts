import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { PinnedChartView } from '../client/console/InlineVisual.js';
import { newestChart, pinnedMarks, pinnedWhen } from '../client/console/pinned-chart.js';

// Slice 2 of the round 2 reskin, decision 1 option A: the thread and the home pin the newest bar,
// line or area chart a reply carried, with no change to the visual format.
const fence = (spec: unknown) => ['```visual', JSON.stringify(spec), '```'].join('\n');
const bar = (title: string, values = [10, 12, 22, 4]) => ({
  kind: 'bar',
  title,
  labels: values.map((_, i) => `${5 + i}:00 PM`),
  series: [{ name: 'Booked', values }],
});
const turn = (id: string, role: string, text: string, at = '2026-09-29T18:40:00.000Z') => ({ id, role, text, at });

describe('newestChart', () => {
  test('no chart in the thread pins nothing', () => {
    expect(newestChart([])).toBeNull();
    expect(newestChart([turn('a', 'you', 'How many covers?'), turn('b', 'diomedes', 'About 118.')])).toBeNull();
  });

  test('the newest bar, line or area chart wins, and older ones stay where they were written', () => {
    const turns = [
      turn('a', 'diomedes', fence(bar('Monday'))),
      turn('b', 'you', 'And tonight?'),
      turn('c', 'diomedes', `Here it is.\n\n${fence({ ...bar('Tonight'), kind: 'line' })}`, '2026-09-29T19:00:00.000Z'),
    ];
    const pinned = newestChart(turns);
    expect(pinned?.spec.title).toBe('Tonight');
    expect(pinned?.spec.kind).toBe('line');
    expect(pinned?.turnId).toBe('c');
    expect(pinned?.at).toBe('2026-09-29T19:00:00.000Z');
  });

  test('a pie, a stat card or a table is skipped: it has no baseline to sweep', () => {
    const pie = { kind: 'pie', title: 'Mix', labels: ['A', 'B'], series: [{ name: 'Share', values: [1, 2] }] };
    const stat = { kind: 'stat', items: [{ label: 'Covers', value: 193 }] };
    const turns = [turn('a', 'diomedes', fence(bar('Tonight'))), turn('b', 'diomedes', `${fence(pie)}\n\n${fence(stat)}`)];
    expect(newestChart(turns)?.spec.title).toBe('Tonight');
  });

  test('two charts in one reply: the last one wins', () => {
    const turns = [turn('a', 'diomedes', `${fence(bar('First'))}\n\nThen:\n\n${fence(bar('Second'))}`)];
    expect(newestChart(turns)?.spec.title).toBe('Second');
  });

  test('a chart the person pasted is not pinned, and a broken block is never half read', () => {
    const turns = [
      turn('a', 'diomedes', fence(bar('Ours'))),
      turn('b', 'you', fence(bar('Pasted'))),
      turn('c', 'diomedes', '```visual\n{"kind":"bar","labels":["a"],"series":[]}\n```'),
    ];
    expect(newestChart(turns)?.spec.title).toBe('Ours');
  });
});

describe('pinnedMarks', () => {
  test('a one series bar chart labels its first and its tallest bar only', () => {
    const chart = bar('Tonight', [10, 12, 16, 18, 17, 22, 12, 7, 4]);
    expect(pinnedMarks(chart as never)).toEqual([0, 5]);
  });
  test('when the first bar is the tallest it is labelled once', () => {
    expect(pinnedMarks(bar('Tonight', [30, 12, 4]) as never)).toEqual([0]);
  });
  test('a line, an area or a chart of several series carries no value labels', () => {
    expect(pinnedMarks({ ...bar('Tonight'), kind: 'line' } as never)).toEqual([]);
    expect(
      pinnedMarks({ ...bar('Tonight'), series: [{ name: 'A', values: [1, 2, 3, 4] }, { name: 'B', values: [4, 3, 2, 1] }] } as never),
    ).toEqual([]);
  });
});

describe('pinnedWhen', () => {
  const now = new Date(2026, 8, 29, 15, 0);
  test('says when the chart was written, so an old chart is never taken for a new one', () => {
    expect(pinnedWhen(new Date(2026, 8, 29, 14, 40).toISOString(), now)).toBe('Today at 2:40 PM');
    expect(pinnedWhen(new Date(2026, 8, 28, 9, 5).toISOString(), now)).toBe('Yesterday at 9:05 AM');
    expect(pinnedWhen(new Date(2026, 8, 21, 18, 0).toISOString(), now)).toBe('Sep 21 at 6:00 PM');
  });
  test('an unreadable time says nothing', () => {
    expect(pinnedWhen('', now)).toBe('');
    expect(pinnedWhen('not a time', now)).toBe('');
  });
});

describe('the pinned chart as drawn', () => {
  const chart = {
    spec: bar('Tonight', [10, 12, 16, 18, 17, 22, 12, 7, 4]) as never,
    turnId: 't1',
    at: '2026-09-29T18:40:00.000Z',
  };
  const draw = (running: boolean) =>
    renderToStaticMarkup(createElement(PinnedChartView, { chart, running, caption: 'Today at 2:40 PM' }));

  test('it is one named region with the chart, its numbers, its time and its hidden table', () => {
    const html = draw(false);
    expect(html).toContain('aria-label="Pinned chart"');
    expect(html).toContain('Tonight');
    expect(html).toContain('Today at 2:40 PM');
    // The first and the tallest bar carry their number; the table carries every value.
    expect(html.match(/class="iv-value[^"]*"/g)).toHaveLength(2);
    expect(html).toContain('class="iv-value top"');
    expect(html).toContain('<table class="iv-data">');
    // No value ticks on the pinned chart.
    expect(html).not.toMatch(/text-anchor="end"/);
  });

  test('the baseline sweeps only while a step runs', () => {
    expect(draw(false)).toContain('class="iv-baseline"');
    expect(draw(true)).toContain('class="iv-baseline sweep"');
  });
});
