/**
 * The worktree sweep's reading of `external-claims/`. Those records come from
 * sessions that never went through the coordination tool, so they have no
 * schema: a worktree path can sit anywhere, in prose, with a parenthetical
 * after it. The sweep must find every worktree they name and nothing else.
 *
 * Only the pure helpers are tested; nothing here lists, reads or removes a
 * real worktree.
 */
import { describe, expect, test, vi } from 'vitest';
import { externalRecordFor, indexRecordStrings, touchedWithin } from '../scripts/worktree-sweep.js';

const WT = 'F:/Diomedes/diomedes-wt';

describe('indexRecordStrings', () => {
  test('collects every string at any depth, normalised, keyed to its file', () => {
    const index = indexRecordStrings([
      {
        file: 'a.json',
        json: {
          schema_version: 1,
          owner: { pid: 4242, note: 'Astra thread' },
          slices: [{ worktree: 'F:\\Diomedes\\Diomedes-WT\\Slice-One', done: true, ended: null }],
        },
      },
      { file: 'b.json', json: ['F:/Diomedes/diomedes-wt/other'] },
    ]);
    expect(index.get('astra thread')).toBe('a.json');
    expect(index.get('f:/diomedes/diomedes-wt/slice-one')).toBe('a.json');
    expect(index.get('f:/diomedes/diomedes-wt/other')).toBe('b.json');
    // Numbers, booleans and nulls are not names of anything.
    expect([...index.keys()]).toHaveLength(3);
  });
});

describe('externalRecordFor', () => {
  const recordsOf = (json: unknown) => indexRecordStrings([{ file: 'record.json', json }]);

  test('finds a worktree named with prose after it', () => {
    const records = recordsOf({
      worktree: `${WT}/devin-acp-20260913 (branch devin/acp-adapter-20260913 at 212106e; 20 modified)`,
    });
    expect(externalRecordFor(`${WT}/devin-acp-20260913`, records)).toBe('record.json');
  });

  test('a full stop ending the sentence is not part of the name', () => {
    const records = recordsOf({ note: `Left uncommitted in ${WT}/foo.` });
    expect(externalRecordFor(`${WT}/foo`, records)).toBe('record.json');
  });

  test('a path inside the worktree names the worktree', () => {
    const records = recordsOf({ paths: [`${WT}/slice/client/console/FilesPane.tsx`] });
    expect(externalRecordFor(`${WT}/slice`, records)).toBe('record.json');
  });

  test('ignores separators, case and a trailing slash in the directory', () => {
    const records = recordsOf({ worktree: `${WT}/inventory-mobile` });
    expect(externalRecordFor('f:\\diomedes\\DIOMEDES-WT\\Inventory-Mobile\\', records)).toBe('record.json');
  });

  test('a name is not claimed by a longer name that begins with it', () => {
    const records = recordsOf({ worktree: `${WT}/foobar`, repo: 'F:/Diomedes/diomedes-wt/foo.old' });
    expect(externalRecordFor(`${WT}/foo`, records)).toBeNull();
    // The main checkout's path is a prefix of every worktree path here.
    expect(externalRecordFor('F:/Diomedes/diomedes', recordsOf({ worktree: `${WT}/x` }))).toBeNull();
  });

  test('keeps looking past a longer name to a later exact one', () => {
    const records = recordsOf({ note: `moved ${WT}/foobar aside; ${WT}/foo is live` });
    expect(externalRecordFor(`${WT}/foo`, records)).toBe('record.json');
  });

  test('names nothing when there are no records', () => {
    expect(externalRecordFor(`${WT}/foo`, new Map())).toBeNull();
  });

  test('an unresolved Windows alias conservatively protects every tree', () => {
    expect(externalRecordFor(`${WT}/foo`, recordsOf({ worktree: 'F:/DIOMED~1/work' })))
      .toBe('record.json');
    expect(externalRecordFor(`${WT}/foo`, recordsOf({ worktree: '//?/F:/Diomedes/work' })))
      .toBe('record.json');
  });
});

describe('touchedWithin', () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.UTC(2026, 8, 20, 23, 7);

  test('the most recent touch decides, and only inside the window', () => {
    // A comparison checkout made four minutes ago, with an older reflog.
    expect(touchedWithin([now - 30 * HOUR, now - 4 * 60_000], now, 24 * HOUR)).toBe(4 * 60_000);
    expect(touchedWithin([now - 30 * HOUR, now - 25 * HOUR], now, 24 * HOUR)).toBeNull();
  });

  test('the window is half-open: exactly its length old is outside it', () => {
    expect(touchedWithin([now - 24 * HOUR], now, 24 * HOUR)).toBeNull();
    expect(touchedWithin([now - 24 * HOUR + 1], now, 24 * HOUR)).toBe(24 * HOUR - 1);
  });

  test('a touch in the future still protects, as zero minutes old', () => {
    expect(touchedWithin([now + HOUR], now, 24 * HOUR)).toBe(0);
  });

  test('nothing to judge by protects nothing', () => {
    expect(touchedWithin([], now, 24 * HOUR)).toBeNull();
  });
});

test('importing the helpers runs no sweep', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    vi.resetModules();
    await import('../scripts/worktree-sweep.js');
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
