import { describe, expect, test } from 'vitest';
import { selectTaskSources } from '../shared/task-sources.js';
import type { DocumentInfo } from '../shared/types.js';

const doc = (path: string, size = 100, kind: DocumentInfo['kind'] = 'markdown'): DocumentInfo => ({
  path,
  kind,
  size,
  changedAt: '2026-09-12T00:00:00.000Z',
  hasChangesWaiting: false,
  recorded: true,
});

describe('documents a Board-started task carries', () => {
  const documents = [
    doc('weekly-operations-brief.md'),
    doc('bakery-inventory.md'),
    doc('notes/weekly-brief.md'),
    doc('Plan.md', 100, 'plan'),
    doc('data.csv', 100, 'unsupported'),
  ];

  test('the documents the task names, in the order it names them', () => {
    expect(
      selectTaskSources(
        {
          name: 'Add a stock-to-watch section to the weekly brief',
          description:
            'Read weekly-operations-brief.md and bakery-inventory.md in this project, and propose adding a short section to weekly-operations-brief.md.',
        },
        documents,
      ),
    ).toEqual(['weekly-operations-brief.md', 'bakery-inventory.md']);
  });

  test('a task that names no document sends none', () => {
    expect(selectTaskSources({ name: 'Add NOTES.md for src/greet.js' }, documents)).toEqual([]);
  });

  test('a file name matches whole tokens only, and a nested path matches by its name too', () => {
    expect(selectTaskSources({ name: 'Shorten brief.md' }, documents)).toEqual([]);
    expect(selectTaskSources({ name: 'Shorten weekly-brief.md' }, documents)).toEqual([
      'notes/weekly-brief.md',
    ]);
    expect(selectTaskSources({ name: 'Shorten notes/weekly-brief.md' }, documents)).toEqual([
      'notes/weekly-brief.md',
    ]);
  });

  test('plans and unsupported kinds are never sent, even when named', () => {
    expect(selectTaskSources({ name: 'Rewrite Plan.md and data.csv' }, documents)).toEqual([]);
  });

  test('matching is case-insensitive', () => {
    expect(selectTaskSources({ name: 'Fix Bakery-Inventory.MD' }, documents)).toEqual([
      'bakery-inventory.md',
    ]);
  });

  test('a sentence-ending period names a document without matching a longer path or extension', () => {
    for (const name of ['Read bakery-inventory.md.', 'Read bakery-inventory.md. Keep the markers.'])
      expect(selectTaskSources({ name }, documents)).toEqual(['bakery-inventory.md']);
    for (const name of ['Read bakery-inventory.md.bak', 'Read bakery-inventory.md/child', 'Read ../bakery-inventory.md'])
      expect(selectTaskSources({ name }, documents)).toEqual([]);
  });

  test("the server's limits hold: eight files, 128 KB", () => {
    const many = Array.from({ length: 10 }, (_, i) => doc(`d${i}.md`, 10));
    const names = many.map((d) => d.path).join(' ');
    expect(selectTaskSources({ name: names }, many)).toHaveLength(8);
    const big = [doc('big.md', 120_000), doc('also.md', 10_000), doc('small.md', 100)];
    expect(selectTaskSources({ name: 'big.md also.md small.md' }, big)).toEqual([
      'big.md',
      'small.md',
    ]);
  });
});
