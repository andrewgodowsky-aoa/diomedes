import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, test } from 'vitest';
import {
  VISUAL_MAX_JSON_BYTES,
  VISUAL_MAX_PER_REPLY,
  parseVisualSpec,
  splitVisuals,
  type VisualSpec,
} from '../shared/visual-spec';
import {
  InlineVisual,
  RunStatusView,
  UpdateProgressView,
  VisualBoundary,
  formatValue,
  niceDomain,
  pieShares,
  shareOfDomain,
} from '../client/console/InlineVisual';
import { ReplyBody } from '../client/console/ReplyBody';
import { updateBar } from '../client/update-progress';
import { updateInMotion } from '../client/use-update-status';
import { ThreadView } from '../client/console/ThreadView';
import { MODES, VISUAL_INSTRUCTIONS } from '../server/modes';
import { parseProposal } from '../server/native-work';
import { defaults } from '../server/store';
import type { UpdateStatusSnapshot } from '../shared/app-updates';
import type { Conversation, Session, Turn } from '../shared/types';

const bar = {
  kind: 'bar',
  title: 'Sales by day',
  labels: ['Mon', 'Tue', 'Wed'],
  series: [{ name: 'Sales', values: [1200, 980, 1540] }],
  format: 'currency',
  currency: 'USD',
};
const fence = (value: unknown) => '```visual\n' + JSON.stringify(value) + '\n```';
const html = (spec: VisualSpec, session: Session | null = null) =>
  renderToStaticMarkup(createElement(InlineVisual, { spec, session }));
const valid = (value: unknown): VisualSpec => {
  const result = parseVisualSpec(value);
  if (!result.ok) throw new Error(result.reason);
  return result.spec;
};
const refused = (value: unknown) => {
  const result = parseVisualSpec(value);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.reason;
};

describe('visual spec validation', () => {
  test('accepts every kind in its documented shape', () => {
    for (const kind of ['bar', 'line', 'area'] as const) valid({ ...bar, kind });
    valid({ kind: 'pie', labels: ['Burger', 'Fries'], series: [{ name: 'Units', values: [42, 18] }] });
    valid({
      kind: 'stat',
      items: [{ label: 'Sales', value: 8420, delta: 4.2, deltaLabel: 'vs last week', format: 'currency', currency: 'USD' }],
    });
    valid({ kind: 'table', columns: ['Item', 'Qty'], rows: [['Buns', 40], ['Patties', null]], formats: ['number', 'number'] });
    valid({ kind: 'progress', label: 'Counted', value: 0.4 });
    valid({ kind: 'progress', label: 'Counting' });
    valid({ kind: 'progress', label: 'Counting', value: null });
    valid({ kind: 'app', key: 'update-progress' });
    valid({ kind: 'app', key: 'run-status', title: 'This run' });
  });

  test('refuses unknown kinds and non-objects with a plain reason', () => {
    expect(refused({ kind: 'scatter' })).toContain('"scatter" is not a kind of visual');
    expect(refused({})).toContain('names no kind');
    expect(refused([bar])).toContain('not a JSON object');
    expect(refused(null)).toContain('not a JSON object');
    expect(refused('bar')).toContain('not a JSON object');
  });

  test('enforces the series, point, column, row and tile bounds', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, values: [1, 2, 3] }));
    refused({ ...bar, series: nine });
    const labels = Array.from({ length: 201 }, (_, i) => `d${i}`);
    refused({ ...bar, labels, series: [{ name: 'x', values: labels.map(() => 1) }] });
    valid({ ...bar, labels: labels.slice(0, 200), series: [{ name: 'x', values: labels.slice(0, 200).map(() => 1) }] });
    expect(refused({ ...bar, series: [{ name: 'Sales', values: [1, 2] }] })).toContain(
      'one value per label',
    );
    const cols = Array.from({ length: 13 }, (_, i) => `c${i}`);
    refused({ kind: 'table', columns: cols, rows: [] });
    refused({ kind: 'table', columns: ['a'], rows: Array.from({ length: 51 }, () => ['x']) });
    expect(refused({ kind: 'table', columns: ['a', 'b'], rows: [['x']] })).toContain('one cell per column');
    refused({ kind: 'stat', items: [] });
    refused({ kind: 'stat', items: Array.from({ length: 7 }, () => ({ label: 'x', value: 1 })) });
  });

  test('numbers must be finite and in range; text must be plain and short', () => {
    refused({ ...bar, series: [{ name: 'Sales', values: [1, Infinity, 3] }] });
    refused({ ...bar, series: [{ name: 'Sales', values: [1, Number.NaN, 3] }] });
    refused({ ...bar, series: [{ name: 'Sales', values: [1, '2', 3] }] });
    refused({ kind: 'progress', label: 'x', value: 1.5 });
    refused({ kind: 'progress', label: 'x', value: -0.1 });
    refused({ kind: 'pie', labels: ['a', 'b'], series: [{ name: 'x', values: [1, -1] }] });
    refused({ kind: 'pie', labels: ['a'], series: [{ name: 'x', values: [0] }] });
    refused({ kind: 'pie', labels: ['a'], series: [{ name: 'x', values: [1] }, { name: 'y', values: [1] }] });
    refused({ ...bar, title: 'Line one\nLine two' });
    refused({ ...bar, title: 'x'.repeat(121) });
    refused({ ...bar, currency: 'usd' });
    refused({ ...bar, format: 'money' });
  });

  test('refuses fields a kind does not take', () => {
    expect(refused({ ...bar, colors: ['red'] })).toContain('does not take');
  });

  test('an app card takes no data from the model', () => {
    expect(refused({ kind: 'app', key: 'update-progress', value: 0.99 })).toContain('does not take');
    refused({ kind: 'app', key: 'run-status', state: 'done' });
    refused({ kind: 'app', key: 'billing' });
  });
});

describe('splitVisuals', () => {
  test('text with no visual block is one untouched text segment', () => {
    const text = 'First paragraph.\n\nSecond paragraph.';
    expect(splitVisuals(text)).toEqual([{ type: 'text', text }]);
    expect(splitVisuals('')).toEqual([]);
  });

  test('keeps several blocks in order with the text between them', () => {
    const pie = { kind: 'pie', labels: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }] };
    const segments = splitVisuals(`Intro.\n${fence(bar)}\nBetween.\n\n${fence(pie)}\nAfter.`);
    expect(segments.map((s) => s.type)).toEqual(['text', 'visual', 'text', 'visual', 'text']);
    expect(segments[1]).toMatchObject({ type: 'visual', spec: { kind: 'bar' } });
    expect(segments[3]).toMatchObject({ type: 'visual', spec: { kind: 'pie' } });
    expect(segments[4]).toEqual({ type: 'text', text: 'After.' });
  });

  test('malformed JSON and invalid specs become notes; the reply keeps reading', () => {
    const segments = splitVisuals('Before.\n```visual\n{"kind": "bar", \n```\nAfter.');
    expect(segments).toEqual([
      { type: 'text', text: 'Before.' },
      { type: 'invalid', reason: 'the block is not valid JSON' },
      { type: 'text', text: 'After.' },
    ]);
    expect(splitVisuals(fence({ kind: 'nope' }))[0].type).toBe('invalid');
  });

  test('an unclosed block is pending while streaming and invalid once final', () => {
    const partial = 'Here is the week.\n```visual\n{"kind":"bar","labels":["Mon"';
    expect(splitVisuals(partial, { streaming: true })).toEqual([
      { type: 'text', text: 'Here is the week.' },
      { type: 'pending' },
    ]);
    expect(splitVisuals(partial)).toEqual([
      { type: 'text', text: 'Here is the week.' },
      { type: 'invalid', reason: 'the block was never closed' },
    ]);
    // The opening line itself still being typed.
    expect(splitVisuals('Look:\n```vis', { streaming: true }).at(-1)).toEqual({ type: 'pending' });
    expect(splitVisuals('Look:\n```', { streaming: true }).at(-1)).toEqual({ type: 'pending' });
  });

  test('code fences of other languages are left exactly as written', () => {
    const code = 'Run this:\n```ts\nconst a = 1;\n\nconst b = 2;\n```\nDone.';
    expect(splitVisuals(code)).toEqual([{ type: 'text', text: code }]);
    const quoted = `~~~md\n${fence(bar)}\n~~~`;
    expect(splitVisuals(quoted)).toEqual([{ type: 'text', text: quoted }]);
    const longer = `\`\`\`\`markdown\n${fence(bar)}\n\`\`\`\``;
    expect(splitVisuals(longer)).toEqual([{ type: 'text', text: longer }]);
    const decision = 'Answer.\n```diomedes-decision\n{"disposition":"respond"}\n```';
    expect(splitVisuals(decision)).toEqual([{ type: 'text', text: decision }]);
    const json = '```json\n{"kind":"bar"}\n```';
    expect(splitVisuals(json)).toEqual([{ type: 'text', text: json }]);
  });

  test('reads CRLF replies', () => {
    const segments = splitVisuals(`Intro.\r\n${fence(bar).replace(/\n/g, '\r\n')}\r\nAfter.`);
    expect(segments.map((s) => s.type)).toEqual(['text', 'visual', 'text']);
  });

  test('bounds the size of a block and the number of blocks in a reply', () => {
    const huge = '```visual\n{"kind":"bar","title":"' + 'x'.repeat(VISUAL_MAX_JSON_BYTES) + '"}\n```';
    expect(splitVisuals(huge)).toEqual([{ type: 'invalid', reason: 'the block is too large' }]);
    const many = Array.from({ length: VISUAL_MAX_PER_REPLY + 1 }, () => fence(bar)).join('\n');
    const segments = splitVisuals(many);
    expect(segments.filter((s) => s.type === 'visual')).toHaveLength(VISUAL_MAX_PER_REPLY);
    expect(segments.at(-1)?.type).toBe('invalid');
  });

  test('the example the models are taught is itself a valid visual', () => {
    const example = VISUAL_INSTRUCTIONS.slice(VISUAL_INSTRUCTIONS.indexOf('```visual'));
    const block = example.slice(0, example.indexOf('```', 3) + 3);
    expect(splitVisuals(block)).toMatchObject([{ type: 'visual', spec: { kind: 'bar' } }]);
  });
});

describe('rendering each kind', () => {
  test('bar: an accessible SVG with a summary and a hidden data table', () => {
    const out = html(valid(bar));
    expect(out).toContain('role="img"');
    expect(out).toContain(
      'aria-label="Bar chart: Sales by day. 3 points, Mon to Wed. Sales from $980 to $1,540."',
    );
    expect(out).toContain('<table class="iv-data">');
    expect(out).toContain('<th scope="row">Tue</th><td>$980</td>');
    expect(out).toContain('<figcaption class="iv-title">Sales by day</figcaption>');
    expect(out.match(/class="iv-mark"/g)).toHaveLength(3);
  });

  test('line and area draw a line per series, area adds its fill, and a legend names series', () => {
    const two = { ...bar, series: [...bar.series, { name: 'Labor', values: [400, 380, 420] }] };
    const line = html(valid({ ...two, kind: 'line' }));
    expect(line).toContain('aria-label="Line chart: Sales by day.');
    expect(line.match(/<polyline/g)).toHaveLength(2);
    expect(line).toContain('class="iv-legend" aria-hidden="true"');
    expect(line).not.toContain('iv-fill');
    const area = html(valid({ ...bar, kind: 'area' }));
    expect(area).toContain('class="iv-fill"');
    expect(area).toContain('Area chart');
  });

  test('pie renders a donut with shares, a summary and the hidden table', () => {
    const out = html(
      valid({ kind: 'pie', title: 'Top items', labels: ['Burger', 'Fries'], series: [{ name: 'Units', values: [75, 25] }] }),
    );
    expect(out).toContain('aria-label="Donut chart: Top items. 2 slices, total 100. Largest: Burger, 75%."');
    expect(out.match(/class="iv-slice/g)).toHaveLength(2);
    expect(out).toContain('<table class="iv-data">');
  });

  test('stat renders one tile per KPI with a spoken delta direction', () => {
    const out = html(
      valid({
        kind: 'stat',
        items: [
          { label: 'Sales', value: 8420, delta: 4.2, deltaLabel: 'vs last week', format: 'currency', currency: 'USD' },
          { label: 'Labor', value: 31.5, delta: -1.5, format: 'percent' },
        ],
      }),
    );
    expect(out.match(/class="iv-stat"/g)).toHaveLength(2);
    expect(out).toContain('$8,420');
    expect(out).toContain('31.5%');
    expect(out).toContain('<span class="iv-sr">up </span>4.2% vs last week');
    expect(out).toContain('<span class="iv-sr">down </span>1.5%');
  });

  test('table renders a real table with column headers and formatted numbers', () => {
    const out = html(
      valid({
        kind: 'table',
        title: 'Low stock',
        columns: ['Item', 'On hand', 'Cost'],
        rows: [['Buns', 12, 3.5], ['Cheese', null, 12]],
        formats: ['number', 'number', 'currency'],
        currency: 'USD',
      }),
    );
    expect(out).toContain('<caption>Low stock</caption>');
    expect(out).toContain('<th scope="col">On hand</th>');
    expect(out).toContain('<td class="iv-num">$3.50</td>');
    expect(out).toContain('<td>—</td>');
  });

  test('progress is the segment bar: a share of the track, or indeterminate', () => {
    const out = html(valid({ kind: 'progress', label: 'Counted', value: 0.4, detail: '40 of 100 items' }));
    // Marked as the reply's own (contract A15): drawn apart from a bar a record keeps.
    expect(out).toContain('<div class="seg-bar panel fraction words" data-source="reply">');
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-label="Counted"');
    expect(out).toContain('aria-valuemin="0"');
    expect(out).toContain('aria-valuemax="100"');
    expect(out).toContain('aria-valuenow="40"');
    expect(out).toContain('<span class="seg-caption" aria-hidden="true">Counted · 40 of 100 items</span>');
    // The model's value, never a count the model did not write.
    expect(html(valid({ kind: 'progress', label: 'Counted', value: 0.4 }))).toContain(
      '<span class="seg-caption" aria-hidden="true">Counted</span>',
    );
    for (const busy of [
      html(valid({ kind: 'progress', label: 'Counting' })),
      html(valid({ kind: 'progress', label: 'Counting', value: null })),
    ]) {
      expect(busy).toContain('<div class="seg-bar panel indeterminate words" data-source="reply">');
      expect(busy).not.toContain('aria-valuenow');
      expect(busy).toContain('seg-scan');
      expect(busy).toContain('<span class="seg-caption" aria-hidden="true">Counting</span>');
    }
    // The superseded bar is gone.
    expect(out).not.toContain('iv-track');
    expect(out).not.toContain('iv-fillbar');
  });

  test('formatting helpers', () => {
    expect(formatValue(1234.5, 'currency', 'EUR')).toBe('€1,234.50');
    expect(formatValue(980, 'currency', 'USD')).toBe('$980');
    expect(formatValue(12.5, 'percent', undefined)).toBe('12.5%');
    expect(formatValue(125000, 'number', undefined, true)).toBe('125K');
    expect(niceDomain([0, 1540]).ticks).toEqual([0, 500, 1000, 1500, 2000]);
    expect(niceDomain([-20, 30]).min).toBeLessThan(0);
  });
});

describe('a visual never throws, hangs or draws NaN, whatever finite numbers it holds', () => {
  const finiteDomain = (values: number[]) => {
    const domain = niceDomain(values);
    expect([domain.min, domain.max, ...domain.ticks].every(Number.isFinite), JSON.stringify(values)).toBe(true);
    expect(domain.max).toBeGreaterThan(domain.min);
    expect(domain.ticks.length).toBeGreaterThanOrEqual(2);
    expect(domain.ticks.length).toBeLessThanOrEqual(12);
    return domain;
  };

  test('the tiny value that made the old chart throw draws as a chart', () => {
    const spec = valid({ kind: 'bar', labels: ['a'], series: [{ name: 's', values: [1e-120] }] });
    let out = '';
    expect(() => {
      out = html(spec);
    }).not.toThrow();
    expect(out).toContain('role="img"');
    expect(out).toContain('<rect class="iv-mark"');
    expect(out).not.toMatch(/NaN|Infinity/);
    finiteDomain([1e-120]);
  });

  test('ranges that overflow or vanish stay finite and bounded', () => {
    for (const values of [[1.7e308], [-1.7e308, 1.7e308], [5e-324], [-5e-324], [0], [1e308, -1e-308]]) {
      finiteDomain(values);
      const spec = valid({ kind: 'line', labels: values.map((_, at) => `p${at}`), series: [{ name: 's', values }] });
      const out = html(spec);
      expect(out, JSON.stringify(values)).not.toMatch(/NaN|Infinity/);
    }
    expect(shareOfDomain(1.7e308, -1.7e308, 1.7e308)).toBe(1);
    expect(shareOfDomain(0, -1.7e308, 1.7e308)).toBe(0.5);
    expect(shareOfDomain(5, 5, 5)).toBe(0);
  });

  test('a pie whose total overflows keeps every share and shows no total it cannot hold', () => {
    const big = pieShares([1.5e308, 1.5e308]);
    expect(big.total).toBeNull();
    expect(big.shares).toEqual([0.5, 0.5]);
    expect(pieShares([1, 1, 2])).toEqual({ total: 4, shares: [0.25, 0.25, 0.5] });
    const spec = valid({ kind: 'pie', labels: ['a', 'b'], series: [{ name: 's', values: [1.5e308, 1.5e308] }] });
    const out = html(spec);
    expect(out).not.toMatch(/NaN|Infinity|∞/);
    expect(out).not.toContain('class="iv-total"');
    expect(out).toContain('2 slices. Largest: a, 50%.');
  });

  test('a visual that throws becomes one plain line through its boundary', () => {
    const boundary = new VisualBoundary({ children: createElement('p', null, 'the chart') });
    expect(renderToStaticMarkup(createElement('div', null, boundary.render()))).toBe('<div><p>the chart</p></div>');
    boundary.state = VisualBoundary.getDerivedStateFromError();
    expect(renderToStaticMarkup(createElement('div', null, boundary.render()))).toBe(
      '<div><p class="iv-note">A visual could not be shown: something in it could not be drawn.</p></div>',
    );
    const hosted = new VisualBoundary({ children: null, fallback: createElement('p', null, 'Host words.') });
    hosted.state = VisualBoundary.getDerivedStateFromError();
    expect(renderToStaticMarkup(createElement('div', null, hosted.render()))).toBe('<div><p>Host words.</p></div>');
  });

  test('a chart is drawn at the width its host measured, with fewer labels where it is narrow', () => {
    const labels = Array.from({ length: 16 }, (_, at) => `d${at + 1}`);
    const spec = valid({ kind: 'bar', labels, series: [{ name: 's', values: labels.map((_, at) => at) }] });
    const shownLabels = (out: string) => (out.match(/<text class="iv-x" x="[\d.]+" y="232" text-anchor="middle">/g) ?? []).length;
    const turn = html(spec);
    expect(turn).toContain('viewBox="0 0 640 240"');
    expect(shownLabels(turn)).toBe(8);
    const panel = renderToStaticMarkup(createElement(InlineVisual, { spec, width: 448 }));
    expect(panel).toContain('viewBox="0 0 448 240"');
    expect(shownLabels(panel)).toBeLessThan(8);
    expect(renderToStaticMarkup(createElement(InlineVisual, { spec, width: 90 }))).toContain('viewBox="0 0 280 240"');
    expect(renderToStaticMarkup(createElement(InlineVisual, { spec, width: Number.NaN }))).toContain(
      'viewBox="0 0 640 240"',
    );
  });
});

const session = (over: Partial<Session> = {}): Session => ({
  id: 'session-1',
  taskId: 'task-1',
  state: 'working',
  startedAt: '2026-09-23T14:02:00.000Z',
  endedAt: null,
  sample: false,
  log: [{ time: '2026-09-23T14:02:05.000Z', sentence: 'Reading the inventory export.', level: 'plain' }],
  entryIds: [],
  needId: null,
  engine: { name: 'claude-code', model: null, worker: 0, branch: null, context: null, events: 1 },
  ...over,
});

const snapshot: UpdateStatusSnapshot = {
  installedVersion: '0.1.6',
  channel: 'stable Windows per-user installer',
  owner: 'o',
  repo: 'r',
  releasesUrl: 'https://example.invalid',
  platform: 'win32',
  packaged: true,
  installed: true,
  supported: true,
  supportReason: '',
  workActive: false,
  check: { phase: 'done', at: null, outcome: 'available', latestVersion: '0.1.7', notesUrl: null, detail: null },
  download: { ready: true, version: '0.1.7', assetName: 'a.exe', bytes: 1, sha256: null, verified: 'size-origin-digest' },
  install: { phase: 'idle', version: null },
};

describe('app cards read live client state, never the spec', () => {
  test('update-progress ignores numbers smuggled into the spec', () => {
    // Even a spec that bypassed the parser carries nothing the card reads.
    const smuggled = { kind: 'app', key: 'update-progress', value: 0.99, latestVersion: '9.9.9' } as unknown as VisualSpec;
    const out = html(smuggled);
    expect(out).toContain('Reading the update status.');
    expect(out).not.toContain('99');
    expect(out).not.toContain('9.9.9');
  });

  test('update-progress shows what the host snapshot says', () => {
    const card = (status: UpdateStatusSnapshot | null, failed = false) =>
      renderToStaticMarkup(createElement(UpdateProgressView, { status, failed, loading: false }));
    // Downloaded and verified is a sentence. Nothing moves, so nothing is drawn as a share.
    const out = card(snapshot);
    expect(out).toContain('Version 0.1.7 downloaded and verified');
    expect(out).toContain('Installed 0.1.6');
    expect(out).not.toContain('role="progressbar"');
    const checking = card({ ...snapshot, check: { ...snapshot.check, phase: 'checking' } });
    expect(checking).toContain('aria-label="Checking for updates"');
    expect(checking).toContain('seg-scan');
    expect(checking).not.toContain('aria-valuenow');
    expect(card(null, true)).toContain('could not be read');
  });

  test('update-progress draws bytes as a share only while the host reports them', () => {
    const card = (status: UpdateStatusSnapshot) =>
      renderToStaticMarkup(createElement(UpdateProgressView, { status, failed: false, loading: false }));
    const mb = 1024 * 1024;
    const available: UpdateStatusSnapshot = {
      ...snapshot,
      download: { ready: false, version: '0.1.7', assetName: null, bytes: null, sha256: null, verified: null },
    };
    // Offered, not moving: a sentence, no bar and no invented quarter.
    const offered = card(available);
    expect(offered).toContain('Version 0.1.7 is available');
    expect(offered).not.toContain('role="progressbar"');
    // Mid-download with a declared size: the bytes, as a share and in words.
    const mid = card({
      ...available,
      download: { ...available.download, progress: { transferred: Math.round(12.3 * mb), total: 80 * mb } },
    });
    expect(mid).toContain('aria-label="Downloading version 0.1.7"');
    expect(mid).toContain('aria-valuenow="15"');
    expect(mid).toContain('aria-valuetext="15%, 12.3 of 80.0 MB"');
    expect(mid).toContain('<span class="seg-caption" aria-hidden="true">Downloading version 0.1.7 · 12.3 of 80.0 MB</span>');
    // No size declared: indeterminate, with what did arrive and no guessed total.
    const open = card({
      ...available,
      download: { ...available.download, progress: { transferred: Math.round(12.3 * mb), total: null } },
    });
    expect(open).toContain('seg-scan');
    expect(open).not.toContain('aria-valuenow');
    expect(open).toContain('Downloading version 0.1.7 · 12.3 MB received');
    expect(open).not.toContain(' of ');
    // Handed to the installer: said, not drawn as a whole bar.
    const launched = card({ ...snapshot, install: { phase: 'launched', version: '0.1.7' } });
    expect(launched).toContain('Installer for 0.1.7 started.');
    expect(launched).not.toContain('role="progressbar"');
  });

  test('the update rule is one rule for the card and Settings', () => {
    const available: UpdateStatusSnapshot = {
      ...snapshot,
      download: { ready: false, version: '0.1.7', assetName: null, bytes: null, sha256: null, verified: null },
    };
    expect(updateBar(available)).toBeNull();
    expect(updateBar(snapshot)).toBeNull();
    expect(updateBar(null)).toBeNull();
    // A request Settings has sent and not heard back from moves too, with no number until the host has one.
    expect(updateBar(available, 'downloading')).toEqual({
      label: 'Downloading version 0.1.7',
      fraction: null,
      detail: null,
    });
    expect(
      updateBar({ ...available, download: { ...available.download, progress: { transferred: 512, total: 2048 } } }, 'downloading'),
    ).toMatchObject({ fraction: 0.25, detail: '0.0 of 0.0 MB' });
    expect(updateBar({ ...snapshot, install: { phase: 'installing', version: null } })?.label).toBe('Starting the installer');
    expect(updateInMotion({ ...available, download: { ...available.download, progress: { transferred: 0, total: null } } })).toBe(true);
    expect(updateInMotion(available)).toBe(false);
  });

  test('run-status reads the session, or says it is not available here', () => {
    expect(html(valid({ kind: 'app', key: 'run-status' }))).toContain('Not available here.');
    const live = html(valid({ kind: 'app', key: 'run-status' }), session());
    expect(live).toContain('Working');
    expect(live).toContain('Reading the inventory export.');
    // A run has no known total: indeterminate, never a made-up share.
    expect(live).toContain('seg-scan');
    expect(live).not.toContain('aria-valuenow');
    const done = renderToStaticMarkup(
      createElement(RunStatusView, {
        session: session({ state: 'done', endedAt: '2026-09-23T14:05:00.000Z' }),
      }),
    );
    expect(done).toContain('aria-valuenow="100"');
    const smuggled = { kind: 'app', key: 'run-status', state: 'failed' } as unknown as VisualSpec;
    expect(html(smuggled, session())).toContain('Working');
  });
});

describe('ReplyBody and the reply renderers', () => {
  const body = (text: string, streaming = false) =>
    renderToStaticMarkup(createElement(ReplyBody, { text, streaming }));

  it('renders plain text as the same paragraphs as before', () => {
    expect(body('One.\n\nTwo.')).toBe('<p>One.</p><p>Two.</p>');
  });

  it('draws a visual in place between paragraphs', () => {
    const out = body(`Sales were up.\n${fence(bar)}\nLabor held.`);
    expect(out.startsWith('<p>Sales were up.</p><figure class="iv iv-bar">')).toBe(true);
    expect(out.endsWith('<p>Labor held.</p>')).toBe(true);
  });

  it('never shows half-written JSON while streaming', () => {
    const out = body('Here it comes.\n```visual\n{"kind":"bar","labels":["Mon"', true);
    expect(out).toContain('Drawing a chart…');
    expect(out).toContain('role="status"');
    expect(out).not.toContain('kind');
  });

  it('shows an invalid block as a short plain note', () => {
    expect(body(fence({ kind: 'bar', labels: [] }))).toContain('A visual could not be shown:');
  });

  it('ThreadView draws visuals in replies and leaves the person\'s own text as text', () => {
    const at = '2026-09-23T12:00:00.000Z';
    const turns: Turn[] = [
      { id: 'you-1', role: 'you', mode: 'ask', text: `Show me\n${fence(bar)}`, at, sources: [] },
      { id: 'dio-1', role: 'diomedes', mode: 'ask', text: `This week:\n${fence(bar)}`, at, sources: [] },
    ];
    const thread: Conversation = {
      id: 'thread-visuals',
      attachedTo: { kind: 'project', ref: 'project-visuals' },
      name: 'Visuals',
      mode: 'ask',
      turns,
    };
    const noAction = () => {};
    const out = renderToStaticMarkup(
      createElement(ThreadView, {
        thread, title: 'Visuals', task: null, sessions: [], mail: [], members: [], member: null,
        needs: [], settings: defaults(), mode: 'ask', route: 'codex', busy: false, online: true,
        onMode: noAction, onPermission: noAction, onRename: noAction, prepareSources: async () => [],
        onSend: noAction, onResolve: noAction, onPreview: noAction, onStopSession: noAction,
        onOpenBoard: noAction,
        streaming: { requestId: 'r1', text: 'Drafting\n```visual\n{"kind"', engine: 'codex' },
      }),
    );
    expect(out.match(/role="img"/g)).toHaveLength(1);
    expect(out).toContain('<p>Show me\n```visual');
    expect(out).toContain('Drawing a chart…');
  });
});

describe('Build and Fix proposals stay strict JSON', () => {
  const refusal = 'The engine did not return a valid file proposal.';

  test('only Ask and Plan are taught the visual block', () => {
    expect(MODES.ask.instructions).toContain(VISUAL_INSTRUCTIONS);
    expect(MODES.plan.instructions).toContain(VISUAL_INSTRUCTIONS);
    for (const mode of ['build', 'fix', 'auto'] as const)
      expect(MODES[mode].instructions).not.toContain('```visual');
  });

  test('proposal parsing still refuses a reply that is not the proposal JSON', () => {
    expect(() => parseProposal(`Here is a chart:\n${fence(bar)}`)).toThrow('No files were changed');
    const proposal = JSON.stringify({ summary: 'S', changes: [] });
    expect(() => parseProposal(`${proposal}\n\n${fence(bar)}`)).toThrow();
    expect(() => parseProposal('Sales were up this week.')).toThrow(refusal);
  });
});
