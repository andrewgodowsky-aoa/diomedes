import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Chart, chartSummary, chartTable, formatValue, niceTicks } from '../client/console/Chart';
import type { ChartSpec } from '../client/console/chart-spec';

const draw = (spec: ChartSpec, showTitle = false) => renderToStaticMarkup(createElement(Chart, { spec, showTitle }));
const count = (html: string, needle: string) => html.split(needle).length - 1;

const twoSeries: ChartSpec = {
  type: 'bar',
  title: 'Messages',
  unit: 'msgs',
  x: ['Jan', 'Feb', 'Mar'],
  series: [
    { name: 'Sent', values: [120, 80, 150] },
    { name: 'Replies', values: [9, 12, 20] },
  ],
};

describe('numbers', () => {
  it('ticks cover the data in round steps', () => {
    expect(niceTicks(0, 1204)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(-3, 7)).toEqual([-4, -2, 0, 2, 4, 6, 8]);
    expect(niceTicks(0, 0)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(5, 5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(0, 0.9)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it('values carry their unit the way people write it', () => {
    expect(formatValue(1204.5)).toBe('1,204.5');
    expect(formatValue(1204.5, '$')).toBe('$1,204.5');
    expect(formatValue(-3, '$')).toBe('-$3');
    expect(formatValue(45, '%')).toBe('45%');
    expect(formatValue(12, 'msgs')).toBe('12 msgs');
  });
});

describe('bar, line and area charts', () => {
  it('draw one bar per value, grouped by series, with a plain-words accessible name', () => {
    const html = draw(twoSeries);
    expect(html).toContain(
      '<svg class="art-chart-svg" role="img" aria-label="Bar chart: Messages. 2 series (Sent, Replies) across 3 categories, from 9 msgs to 150 msgs."',
    );
    expect(count(html, '<rect class="art-bar"')).toBe(6);
    expect(html).toContain('<g class="art-s1">');
    expect(html).toContain('<g class="art-s2">');
    expect(html).toContain('<title>Feb, Replies: 12 msgs</title>');
    // The unit is written once, above the axis; the categories along the bottom.
    expect(html).toContain('>msgs</text>');
    for (const label of ['Jan', 'Feb', 'Mar']) expect(html).toContain(`>${label}</text>`);
    // Two series: a legend, hidden from assistive technology (the name and the table carry it).
    expect(html).toContain('<ul class="art-legend" aria-hidden="true">');
  });

  it('draw lines with a point per value, and areas filled to the baseline', () => {
    const line = draw({ ...twoSeries, type: 'line' });
    expect(count(line, '<path class="art-line"')).toBe(2);
    expect(count(line, '<circle class="art-dot"')).toBe(6);
    expect(line).toContain('aria-label="Line chart: Messages.');
    const area = draw({ ...twoSeries, type: 'area' });
    expect(count(area, '<path class="art-area"')).toBe(2);
  });

  it('mark zero when values go below it', () => {
    const html = draw({ type: 'bar', x: ['a', 'b'], series: [{ name: 'Change', values: [-3, 7] }] });
    expect(html).toContain('class="art-zero"');
    expect(html).not.toContain('<ul class="art-legend"');
  });

  it('keep every label a text node', () => {
    const html = draw({ type: 'bar', x: ['<img src=x onerror=alert(1)>'], series: [{ name: '<script>alert(1)</script>', values: [1] }] });
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('donuts', () => {
  it('draw one slice per non-zero part, the total in the middle, and a legend with shares', () => {
    const html = draw({
      type: 'donut',
      title: 'Where replies came from',
      slices: [
        { label: 'Email', value: 30 },
        { label: 'Phone', value: 10 },
        { label: 'Walk-in', value: 0 },
      ],
    });
    expect(count(html, '<path class="art-slice')).toBe(2);
    expect(html).toContain('aria-label="Donut chart: Where replies came from. 3 parts totalling 40; the largest is Email at 75%."');
    expect(html).toContain('>40</text>');
    expect(html).toContain('Email<span class="art-value">30 · 75%</span>');
    expect(html).toContain('Walk-in<span class="art-value">0 · 0%</span>');
  });

  it('draw a whole ring when there is one part', () => {
    const html = draw({ type: 'donut', slices: [{ label: 'All', value: 5 }] });
    expect(count(html, '<path class="art-slice')).toBe(1);
    expect(html).toMatch(/d="M[^"]+Z M[^"]+Z"/);
  });
});

describe('segments and progress', () => {
  it('are the Console segment bar, drawn exactly from the record', () => {
    const steps = draw({
      type: 'segments',
      title: 'Delivery',
      steps: [
        { label: 'Collect', state: 'done' },
        { label: 'Check', state: 'failed' },
        { label: 'Send', state: 'pending' },
      ],
    });
    expect(steps).toContain('class="seg-bar panel"');
    expect(steps).toContain('aria-label="Steps: Delivery. 1 of 3 done, 1 failed."');
    expect(count(steps, 'class="seg ')).toBe(3);
    const progress = draw({ type: 'progress', done: 3, total: 5, label: 'records read' });
    expect(progress).toContain('aria-valuenow="3"');
    expect(progress).toContain('aria-valuemax="5"');
    expect(progress).toContain('aria-label="Progress. 3 of 5 records read."');
    // A snapshot is not moving: nothing is drawn as active.
    expect(progress).not.toContain('seg active');
  });
});

describe('the data under every chart', () => {
  it('is one button away, closed until asked for', () => {
    const html = draw(twoSeries);
    expect(html).toContain('<button type="button" class="art-tool" aria-expanded="false">Show data</button>');
    expect(html).not.toContain('<table');
  });

  it('reads as a table for every chart type', () => {
    expect(chartTable(twoSeries)).toMatchObject({
      header: ['Category', 'Sent (msgs)', 'Replies (msgs)'],
      rows: [
        ['Jan', '120', '9'],
        ['Feb', '80', '12'],
        ['Mar', '150', '20'],
      ],
    });
    expect(chartTable({ type: 'donut', slices: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] }).rows).toEqual([
      ['A', '1', '33.3%'],
      ['B', '2', '66.7%'],
    ]);
    expect(chartTable({ type: 'segments', steps: [{ label: 'Collect', state: 'blocked' }] }).rows).toEqual([['Collect', 'Blocked']]);
    expect(chartTable({ type: 'progress', done: 2, total: 9 }).rows).toEqual([['Units', '2', '9']]);
  });

  it('names the chart when a table was charted', () => {
    expect(draw({ ...twoSeries, title: 'Sent by Month' }, true)).toContain('<p class="art-chart-heading">Sent by Month</p>');
    expect(chartSummary({ type: 'progress', title: 'Import', done: 1, total: 2 })).toBe('Progress: Import. 1 of 2.');
  });
});
