import { describe, expect, test } from 'vitest';
import {
  applyHunkSelection,
  buildDiff,
  diffHeader,
  foldContext,
  hunkPlace,
  sideBySide,
  splitLines,
  type DiffLine,
} from '../shared/text-diff';

/**
 * P06 readable diffs: the line/word comparison every Console view shares, its
 * plain headers, its bounds and truthful states, and the hunk selection a
 * partial keep applies. Business text first; the same model serves code.
 */

const MENU = ['# Menu', '', 'Soup $7', 'Bread $3', 'Tea $2', 'Coffee $3', 'Cake $5', 'Pie $6', 'Juice $4', ''].join('\n');

type Row = {
  name: string;
  before: string | null;
  after: string | null;
  state: string;
  header: string;
  hunks: [number, number, number, number][];
  added: number;
  removed: number;
};

const table: Row[] = [
  {
    name: 'one changed price',
    before: MENU,
    after: MENU.replace('Soup $7', 'Soup $8'),
    state: 'changed',
    header: '1 line added, 1 removed in Menu/Prices.md',
    hunks: [[3, 1, 3, 1]],
    added: 1,
    removed: 1,
  },
  {
    name: 'two places: a changed line and an appended line',
    before: MENU,
    after: MENU.replace('Soup $7', 'Soup $8') + 'Water $1\n',
    state: 'changed',
    header: '2 lines added, 1 removed in Menu/Prices.md',
    hunks: [
      [3, 1, 3, 1],
      [9, 0, 10, 1],
    ],
    added: 2,
    removed: 1,
  },
  {
    name: 'three places including a removal',
    before: MENU,
    after: MENU.replace('Soup $7', 'Soup $8').replace('Coffee $3\n', '').replace('Juice $4', 'Juice $5'),
    state: 'changed',
    header: '2 lines added, 3 removed in Menu/Prices.md',
    hunks: [
      [3, 1, 3, 1],
      [6, 1, 5, 0],
      [9, 1, 8, 1],
    ],
    added: 2,
    removed: 3,
  },
  {
    name: 'lines only added',
    before: 'a\nb\n',
    after: 'a\nx\nb\n',
    state: 'changed',
    header: '1 line added in Menu/Prices.md',
    hunks: [[1, 0, 2, 1]],
    added: 1,
    removed: 0,
  },
  {
    name: 'lines only removed',
    before: 'a\nx\ny\nb\n',
    after: 'a\nb\n',
    state: 'changed',
    header: '2 lines removed in Menu/Prices.md',
    hunks: [[2, 2, 1, 0]],
    added: 0,
    removed: 2,
  },
  {
    name: 'a new file',
    before: null,
    after: 'one\ntwo\n',
    state: 'changed',
    header: '2 lines added in Menu/Prices.md, a new file',
    hunks: [[0, 0, 1, 2]],
    added: 2,
    removed: 0,
  },
  {
    name: 'a deleted file',
    before: 'one\ntwo\nthree\n',
    after: null,
    state: 'changed',
    header: '3 lines removed from Menu/Prices.md, which was deleted',
    hunks: [[1, 3, 0, 0]],
    added: 0,
    removed: 3,
  },
  {
    name: 'identical texts',
    before: MENU,
    after: MENU,
    state: 'identical',
    header: 'No differences in Menu/Prices.md',
    hunks: [],
    added: 0,
    removed: 0,
  },
  {
    name: 'a missing final line ending is a change to that line',
    before: 'a\nb',
    after: 'a\nb\n',
    state: 'changed',
    header: '1 line added, 1 removed in Menu/Prices.md',
    hunks: [[2, 1, 2, 1]],
    added: 1,
    removed: 1,
  },
  {
    name: 'Windows line endings are shown without the carriage return',
    before: 'a\r\nb\r\n',
    after: 'a\r\nc\r\n',
    state: 'changed',
    header: '1 line added, 1 removed in Menu/Prices.md',
    hunks: [[2, 1, 2, 1]],
    added: 1,
    removed: 1,
  },
];

describe('P06 text diff: correctness table', () => {
  test.each(table)('$name', (row) => {
    const diff = buildDiff({ path: 'Menu/Prices.md', before: row.before, after: row.after });
    expect(diff.state).toBe(row.state);
    expect(diff.header).toBe(row.header);
    expect(diff.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual(row.hunks);
    expect([diff.added, diff.removed]).toEqual([row.added, row.removed]);
    if (row.state === 'identical') return expect(diff.segments).toEqual([]);
    // Every line of both texts appears exactly once, in order, on its own side.
    const lines = diff.segments.flatMap((segment) =>
      segment.kind === 'context' ? segment.lines : diff.hunks[segment.hunk].lines,
    );
    const old = lines.filter((l) => l.kind !== 'added').sort((a, b) => a.oldNo! - b.oldNo!);
    const next = lines.filter((l) => l.kind !== 'removed').sort((a, b) => a.newNo! - b.newNo!);
    expect(old.map((l) => l.text)).toEqual(splitLines(row.before ?? ''));
    expect(next.map((l) => l.text)).toEqual(splitLines(row.after ?? ''));
    expect(old.map((l) => l.oldNo)).toEqual(old.map((_, i) => i + 1));
    expect(next.map((l) => l.newNo)).toEqual(next.map((_, i) => i + 1));
  });

  test('keeping every hunk gives the later text and keeping none gives the earlier, for every row', () => {
    for (const row of table) {
      const before = row.before ?? '';
      const after = row.after ?? '';
      const count = buildDiff({ path: 'x', before: row.before, after: row.after }).hunks.length;
      expect(applyHunkSelection(before, after, [...Array(count).keys()]), row.name).toBe(after);
      expect(applyHunkSelection(before, after, []), row.name).toBe(before);
    }
  });

  test('keeping some hunks takes the later side of those and the earlier side of the rest', () => {
    const after = MENU.replace('Soup $7', 'Soup $8').replace('Coffee $3\n', '').replace('Juice $4', 'Juice $5');
    expect(applyHunkSelection(MENU, after, [0, 2])).toBe(
      MENU.replace('Soup $7', 'Soup $8').replace('Juice $4', 'Juice $5'),
    );
    expect(applyHunkSelection(MENU, after, [1])).toBe(MENU.replace('Coffee $3\n', ''));
  });

  test('a changed line pairs word by word; an unrelated replacement does not', () => {
    const diff = buildDiff({ path: 'p.md', before: 'Soup of the day $7\n', after: 'Soup of the day $8\n' });
    const [removed, added] = diff.hunks[0].lines;
    expect(removed.words?.filter((w) => w.kind === 'removed').map((w) => w.text)).toEqual(['7']);
    expect(added.words?.filter((w) => w.kind === 'added').map((w) => w.text)).toEqual(['8']);
    const unrelated = buildDiff({ path: 'p.md', before: 'Soup of the day\n', after: 'Closed Mondays\n' });
    expect(unrelated.hunks[0].lines.every((l) => l.words === undefined)).toBe(true);
  });

  test('side by side pairs removed and added rows and leaves the rest blank', () => {
    const diff = buildDiff({ path: 'p.md', before: 'a\nb\nc\n', after: 'a\nB\nC\nD\n' });
    const rows = sideBySide(diff.hunks[0]);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['b', 'B'],
      ['c', 'C'],
      [null, 'D'],
    ]);
  });

  test('a hunk says where it is in plain words', () => {
    const diff = buildDiff({ path: 'p.md', before: MENU, after: MENU.replace('Tea $2\nCoffee $3', 'Tea $3\nCoffee $4') });
    expect(hunkPlace(diff.hunks[0])).toBe('lines 5–6');
    expect(hunkPlace(buildDiff({ path: 'p', before: 'a\nb\n', after: 'a\n' }).hunks[0])).toBe('line 2');
  });

  test('context folds to a few lines around each change', () => {
    const lines: DiffLine[] = [...Array(20).keys()].map((i) => ({ kind: 'context', text: `l${i}`, oldNo: i + 1, newNo: i + 1 }));
    expect(foldContext(lines, 'middle')).toMatchObject({ head: { length: 3 }, hidden: { length: 14 }, tail: { length: 3 } });
    expect(foldContext(lines, 'first')).toMatchObject({ head: { length: 0 }, hidden: { length: 17 }, tail: { length: 3 } });
    expect(foldContext(lines, 'last')).toMatchObject({ head: { length: 3 }, hidden: { length: 17 }, tail: { length: 0 } });
    expect(foldContext(lines.slice(0, 7), 'middle').hidden).toHaveLength(0);
  });

  test('headers read in plain language', () => {
    expect(diffHeader('Menu/Prices.md', 'modified', 3, 1)).toBe('3 lines added, 1 removed in Menu/Prices.md');
    expect(diffHeader('a.md', 'modified', 1, 0)).toBe('1 line added in a.md');
  });
});

describe('P06 text diff: bounds and truthful states', () => {
  test('a NUL byte is not text, so nothing is compared line by line', () => {
    const diff = buildDiff({ path: 'photo.png', before: 'a', after: 'b\0c' });
    expect(diff).toMatchObject({ state: 'binary', hunks: [], selectable: false });
    expect(diff.reason).toBe('photo.png is not text, so no line differences are shown.');
    expect(buildDiff({ path: 'x.pdf', before: 'a', after: 'b', binary: true }).state).toBe('binary');
  });

  test('versions whose contents were not kept say so', () => {
    const diff = buildDiff({ path: 'a.md', before: null, after: null });
    expect(diff.state).toBe('unavailable');
    expect(diff.reason).toContain('were not kept');
  });

  test('over the byte bound the pair is described, not compared', () => {
    const big = 'x'.repeat(600_000);
    const diff = buildDiff({ path: 'export.csv', before: big, after: `${big}y` });
    expect(diff.state).toBe('too-large');
    expect(diff.reason).toBe('export.csv is too large to compare here: 1.1 MB across both versions, over the 1 MB limit.');
  });

  test('past the edit bound the comparison gives up and says why', () => {
    const before = [...Array(40).keys()].map((i) => `a${i}`).join('\n');
    const after = [...Array(40).keys()].map((i) => `b${i}`).join('\n');
    const diff = buildDiff({ path: 'report.md', before, after, limits: { maxEditLines: 10 } });
    expect(diff.state).toBe('too-large');
    expect(diff.reason).toBe('More than 10 lines differ in report.md, too many to compare here.');
    expect(() => applyHunkSelection(before, after, [0], { maxEditLines: 10 })).toThrow('too large');
  });

  test('rendering is bounded and a truncated diff cannot be kept piece by piece', () => {
    const before = [...Array(30).keys()].map((i) => `row ${i}`).join('\n') + '\n';
    const after = before.replace('row 3\n', 'row three\n').replace('row 20\n', 'row twenty\n');
    const diff = buildDiff({ path: 'rows.csv', before, after, limits: { maxRenderedLines: 3 } });
    expect(diff).toMatchObject({ state: 'changed', truncated: true, hiddenLines: 1, selectable: false });
    expect(buildDiff({ path: 'rows.csv', before, after }).selectable).toBe(true);
  });

  test('only a modified file with two or more hunks is selectable', () => {
    expect(buildDiff({ path: 'a', before: 'a\n', after: 'b\n' }).selectable).toBe(false);
    expect(buildDiff({ path: 'a', before: null, after: 'a\nb\n' }).selectable).toBe(false);
    expect(buildDiff({ path: 'a', before: MENU, after: MENU.replace('Soup', 'Stew').replace('Pie', 'Tart') }).selectable).toBe(true);
  });
});
