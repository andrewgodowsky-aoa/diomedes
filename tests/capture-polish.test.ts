/**
 * What the site's product captures of the sample bakery showed wrong (2026-09-24), held to the
 * fix: inline Markdown in answers, readable chart labels, a Board row's age and document, known
 * acronyms in labels made from file names, and a brief's source tags read as references.
 * The browser half, at 1440x900, is tests/capture-polish.spec.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { TurnBody, type Citations } from '../client/console/TurnBody';
import { InlineVisual, fitAxisLabel } from '../client/console/InlineVisual';
import { ageOf } from '../client/console/BoardView';
import { KNOWN_ACRONYMS, readableFileName, readableWords } from '../shared/display-names';
import {
  briefSources,
  citationName,
  resolveBySlug,
  sourceSlug,
  splitCitations,
} from '../shared/citations';
import { prettyFor, slugFor } from '../server/weekly-brief';
import { parseVisualSpec, type VisualSpec } from '../shared/visual-spec';

const turn = (text: string, cite?: Citations) =>
  renderToStaticMarkup(createElement(TurnBody, { text, cite }));

describe('1. inline Markdown in an answer', () => {
  const SATURDAY = [
    "- **Friday:** since it's a *weekly recurring* add-on, check it once the quote is `final`.",
    '',
    '| Inquiry | Gap |',
    '|---|---|',
    '| Millbrook | pack during *9–11 rush*, assign **Marco**, `4-mile` run |',
    '| Brightline | 5 * 3 boxes a week |',
  ].join('\n');

  test('a list item renders emphasis, bold and inline code, never the markers', () => {
    const html = turn(SATURDAY);
    expect(html).toContain(
      '<li><strong>Friday:</strong> since it&#x27;s a <em>weekly recurring</em> add-on',
    );
    expect(html).toContain('<code class="art-inline-code">final</code>');
    expect(html).not.toContain('*weekly recurring*');
  });

  test('a table cell renders them too, and a literal asterisk stays an asterisk', () => {
    const html = turn(SATURDAY);
    expect(html).toContain('<em>9–11 rush</em>');
    expect(html).toContain('<strong>Marco</strong>');
    expect(html).toContain('<code class="art-inline-code">4-mile</code>');
    expect(html).toContain('5 * 3 boxes a week');
  });

  test('emphasis inside bold renders, and arithmetic inside bold stays as written', () => {
    expect(turn('**Friday: a *weekly* order**')).toContain(
      '<strong>Friday: a <em>weekly</em> order</strong>',
    );
    expect(turn('**2 * 3 = 6**')).toContain('<strong>2 * 3 = 6</strong>');
  });
});

describe('2. chart x-axis labels', () => {
  const chart = (labels: string[]) => {
    const parsed = parseVisualSpec({
      kind: 'bar',
      labels,
      series: [{ name: 'Orders', values: labels.map((_, i) => i + 1) }],
    });
    if (!parsed.ok) throw new Error(parsed.reason);
    return renderToStaticMarkup(createElement(InlineVisual, { spec: parsed.spec as VisualSpec }));
  };
  const axisLabels = (html: string) =>
    [...html.matchAll(/<text class="iv-x"[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]);

  test('a label that fits is drawn whole, on one line, with no ellipsis', () => {
    expect(fitAxisLabel('W36 (price change)', 140)).toEqual({
      lines: ['W36 (price change)'],
      cut: false,
    });
  });

  test('a long label wraps on words over two lines before anything is cut', () => {
    expect(fitAxisLabel('Millbrook Library Friends reception', 140)).toEqual({
      lines: ['Millbrook Library', 'Friends reception'],
      cut: false,
    });
  });

  test('a label too long for two lines is cut with an ellipsis', () => {
    const fitted = fitAxisLabel('The Saturday catering run for the library friends reception', 100);
    expect(fitted.cut).toBe(true);
    expect(fitted.lines).toHaveLength(2);
    expect(fitted.lines[1].endsWith('…')).toBe(true);
  });

  test('every drawn label is whole, or wrapped or cut with its whole text as a hover title', () => {
    const long = [
      'Millbrook Library Friends reception',
      'Harper & Vale wedding brunch',
      'Brightline Dental standing Friday pastry box order',
      'Juniper Street walk-in orders',
      'W36 (price change)',
      'The Saturday catering run for the library friends reception',
    ];
    const html = chart(long);
    const drawn = axisLabels(html);
    expect(drawn.length).toBeGreaterThan(0);
    for (const label of drawn) {
      const cut = label.includes('…');
      const wrapped = (label.match(/<tspan/g) ?? []).length > 1;
      if (cut || wrapped) expect(label, label).toMatch(/<title>[^<]+<\/title>/);
    }
    expect(html).toContain(
      '<title>The Saturday catering run for the library friends reception</title>',
    );
    // Wrapped labels make room under the plot instead of running off it.
    expect(html).toMatch(/viewBox="0 0 640 253"/);
  });

  test('short labels keep the drawing as it was', () => {
    const html = chart(['Mon', 'Tue', 'Wed']);
    expect(html).toContain('viewBox="0 0 640 240"');
    expect(html).not.toContain('<title>');
  });
});

describe('3. a Board row says what its age is', () => {
  const now = Date.parse('2026-09-24T00:40:00Z');
  test('an unmoved task says when it was added; a moved one, when it moved', () => {
    expect(ageOf({ moves: [], createdAt: '2026-09-24T00:16:00Z' }, now)).toEqual({
      short: '24 m',
      title: 'Added 24 minutes ago',
    });
    expect(
      ageOf(
        {
          moves: [{ at: '2026-09-23T21:40:00Z', undone: false }] as never,
          createdAt: '2026-09-20T00:00:00Z',
        },
        now,
      ),
    ).toEqual({ short: '3 h', title: 'Last moved 3 hours ago' });
    expect(ageOf({ moves: [], createdAt: '2026-09-24T00:39:50Z' }, now)).toEqual({
      short: 'now',
      title: 'Added just now',
    });
    expect(ageOf({ moves: [], createdAt: '2026-09-23T00:40:00Z' }, now).title).toBe(
      'Added 1 day ago',
    );
  });

  test('a default document reads by its name, with its folder', () => {
    expect(readableFileName('catering/inquiries.md', { folder: true })).toBe('Catering inquiries');
    expect(readableFileName('staff/schedule-2026-W39.md', { folder: true })).toBe(
      'Staff schedule 2026 W39',
    );
  });
});

describe('5. labels made from file names keep known acronyms', () => {
  test('one list, in one place', () => {
    for (const written of ['POS', 'CSV', 'PDF', 'ID', 'SKU', 'W-2', 'QB'])
      expect(Object.values(KNOWN_ACRONYMS)).toContain(written);
  });

  test('POS, CSV, SKU, ID, QB and W-2 stay capitals; other words stay as written', () => {
    expect(readableWords('pos-weekly-summary')).toBe('POS weekly summary');
    expect(readableWords('imports_csv_export')).toBe('Imports CSV export');
    expect(readableWords('sku-list')).toBe('SKU list');
    expect(readableWords('customer-id-map')).toBe('Customer ID map');
    expect(readableWords('qb-journal')).toBe('QB journal');
    expect(readableWords('staff-w-2-forms')).toBe('Staff W-2 forms');
    expect(readableWords('w2-forms')).toBe('W2 forms');
    expect(readableWords('schedule-2026-W39')).toBe('Schedule 2026 W39');
    // A word that merely contains an acronym is not one.
    expect(readableWords('posted-idle-notes')).toBe('Posted idle notes');
  });

  test('the weekly brief names its sources through the same list', () => {
    expect(prettyFor('Imports/pos-weekly-summary.txt')).toBe('POS weekly summary');
    expect(prettyFor('exports/sku-sales.csv')).toBe('SKU sales');
    expect(prettyFor('kitchen-log.md')).toBe('Kitchen log');
  });
});

describe("6. a brief's source tags", () => {
  const SHA = 'c123909dead3bd9a187d6d93a4c8b52a53d52c134fbf24a41a0707db98aea656';
  const BRIEF = [
    '# Weekly operations brief',
    '',
    '## Weekly operations exports: POS weekly summary',
    '',
    '- 2026-W38: croissants 483 [imports-pos-weekly-summary-1]',
    '',
    '## Sources',
    '',
    `- [imports-pos-weekly-summary-1] Weekly operations exports: POS weekly summary — Imports/pos-weekly-summary.txt (SHA-256: ${SHA})`,
    '',
  ].join('\n');

  test("the slug rule is the brief's own", () => {
    expect(slugFor('Imports/pos-weekly-summary.txt')).toBe(
      sourceSlug('Imports/pos-weekly-summary.txt'),
    );
    expect(sourceSlug('Imports/pos-weekly-summary.txt')).toBe('imports-pos-weekly-summary');
  });

  test("a brief's Sources list resolves each id to its file and exact bytes", () => {
    const sources = briefSources(BRIEF);
    expect([...sources.values()]).toEqual([
      {
        id: 'imports-pos-weekly-summary-1',
        name: 'POS weekly summary',
        path: 'Imports/pos-weekly-summary.txt',
        sha: SHA,
      },
    ]);
    expect(briefSources('# Notes\n\n- [some-thing] in a list')).toEqual(new Map());
  });

  test('in a brief every tag reads as a reference, and an unknown one as its words, never its id', () => {
    const sources = briefSources(BRIEF);
    const parts = splitCitations(
      'croissants 483 [imports-pos-weekly-summary-1] and [kitchen-log-2]',
      (id) => sources.get(id) ?? null,
      false,
    );
    expect(parts.map((part) => part.type)).toEqual(['text', 'cite', 'text', 'named']);
    expect(parts[3]).toEqual({ type: 'named', id: 'kitchen-log-2', name: 'Kitchen log' });
    expect(citationName('imports-pos-weekly-summary-1')).toBe('Imports POS weekly summary');
  });

  test('in an answer a tag resolves by slug to a recorded file; any other bracket stays as written', () => {
    const paths = ['Imports/pos-weekly-summary.txt', 'catering/inquiries.md'];
    const resolve = (id: string) => resolveBySlug(id, paths);
    expect(resolve('imports-pos-weekly-summary-1')?.path).toBe('Imports/pos-weekly-summary.txt');
    expect(resolve('catering-inquiries')?.name).toBe('Inquiries');
    expect(resolve('in-progress')).toBeNull();
    const parts = splitCitations(
      'dropped [imports-pos-weekly-summary-1]; see [in-progress] and [docs](x.md)',
      resolve,
      true,
    );
    expect(parts.filter((part) => part.type === 'cite')).toHaveLength(1);
    expect(parts.map((part) => (part.type === 'text' ? part.text : '|')).join('')).toBe(
      'dropped |; see [in-progress] and [docs](x.md)',
    );
  });

  test("an answer renders the tag as the thread's reference chip, and leaves a tag in code alone", () => {
    const cite: Citations = {
      strict: true,
      resolve: (id) => resolveBySlug(id, ['Imports/pos-weekly-summary.txt']),
      onOpen: () => undefined,
    };
    const html = turn(
      '- dropped to ~487 in W36 [imports-pos-weekly-summary-1], see `[imports-pos-weekly-summary-1]`',
      cite,
    );
    expect(html).toContain(
      '<button type="button" class="ref-chip cite" title="Imports/pos-weekly-summary.txt"><span class="ref-name">POS weekly summary</span></button>',
    );
    expect(html).toContain('<code class="art-inline-code">[imports-pos-weekly-summary-1]</code>');
    expect(html.match(/imports-pos-weekly-summary-1/g)).toHaveLength(1);
    // Without citations the text is exactly what was written, as before.
    expect(turn('see [imports-pos-weekly-summary-1]')).toContain(
      'see [imports-pos-weekly-summary-1]',
    );
  });
});
