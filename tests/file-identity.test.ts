import { describe, expect, test } from 'vitest';
import {
  claimedKind,
  dropName,
  dropProblem,
  pastedName,
  pdfFacts,
  previewKindForName,
  sniffBytes,
  uniqueImportPath,
} from '../shared/file-drops.js';
import { delimiterFor, parseDelimited } from '../shared/delimited.js';
import { identityLabel, identityOf, turnReference, versionAt, versionsOf } from '../shared/file-identity.js';
import type { HistoryEntry } from '../shared/types.js';
import { GIF_1X1, JPEG_1X1, PDF_SMALL, PNG_1X1, SAFE_SVG, WEBP_1X1, XLSX_HEAD } from './fixtures/file-drop-samples.js';

const text = (value: string) => new TextEncoder().encode(value);

describe('content sniffing never trusts the extension alone', () => {
  test.each([
    [PNG_1X1, 'png'],
    [JPEG_1X1, 'jpeg'],
    [GIF_1X1, 'gif'],
    [WEBP_1X1, 'webp'],
    [PDF_SMALL, 'pdf'],
    [XLSX_HEAD, 'xlsx'],
    [text(SAFE_SVG), 'svg'],
    [text(`\ufeff<?xml version="1.0"?>\n<!-- a comment -->\n${SAFE_SVG}`), 'svg'],
    [text('item,count\r\nTables,7\r\n'), 'text'],
    [text('MZ\u0090\u0000'), null],
    [text('PK\u0003\u0004word/document.xml'), null],
    [Uint8Array.from([0xc3, 0x28]), null],
  ])('%#: sniffs as %s', (bytes, kind) => {
    expect(sniffBytes(bytes as Uint8Array)).toBe(kind);
  });

  test('a name and its bytes must agree', () => {
    expect(dropProblem('photo.png', PNG_1X1)).toBeNull();
    expect(dropProblem('photo.jpeg', JPEG_1X1)).toBeNull();
    expect(dropProblem('photo.png', JPEG_1X1)).toContain('contains a JPEG picture');
    expect(dropProblem('notes.md', PNG_1X1)).toContain('named as text but contains a PNG picture');
    expect(dropProblem('notes.md', Uint8Array.from([0xc3, 0x28]))).toContain('not UTF-8 text');
    expect(dropProblem('drawing.svg', text('plain words'))).toContain('named as an SVG drawing but contains text');
    expect(dropProblem('script.js', text('alert(1)'))).toContain('not a file type Files takes');
  });

  test('names are the last segment, cleaned, and a paste is dated', () => {
    expect(dropName('C:\\Users\\me\\Downloads\\report.csv')).toBe('report.csv');
    expect(dropName('a/b/../c.md')).toBe('c.md');
    expect(dropName('what?.md')).toBe('what.md');
    expect(dropName('trailing. ')).toBe('trailing');
    expect(dropName('.hidden')).toBeNull();
    expect(dropName('')).toBeNull();
    expect(pastedName('png', new Date(2026, 8, 24, 9, 5, 7))).toBe('Pasted image 2026-09-24 090507.png');
    expect(pastedName('text', new Date(2026, 8, 24, 9, 5, 7))).toBe('Pasted text 2026-09-24 090507.txt');
  });

  test('a taken name gets the next free name, compared without case', () => {
    expect(uniqueImportPath('a.png', new Set())).toBe('Imports/a.png');
    expect(uniqueImportPath('a.png', new Set(['imports/A.PNG']))).toBe('Imports/a (2).png');
    expect(uniqueImportPath('a.png', new Set(['Imports/a.png', 'Imports/a (2).png']))).toBe('Imports/a (3).png');
    expect(uniqueImportPath('README', new Set(['Imports/README']))).toBe('Imports/README (2)');
  });

  test('preview kinds from the name, and PDF facts from the bytes', () => {
    expect(previewKindForName('x.webp')).toBe('image');
    expect(previewKindForName('x.svg')).toBeNull();
    expect(previewKindForName('x.PDF')).toBe('pdf');
    expect(previewKindForName('x.tsv')).toBe('table');
    expect(previewKindForName('x.xlsx')).toBe('xlsx');
    expect(claimedKind('x.markdown')).toBe('text');
    expect(pdfFacts(PDF_SMALL)).toEqual({ version: '1.4', encrypted: false });
    expect(pdfFacts(text('%PDF-1.7\n...trailer<</Encrypt 5 0 R>>'))).toEqual({ version: '1.7', encrypted: true });
  });
});

describe('CSV and TSV read as a bounded table', () => {
  test('quotes, doubled quotes, embedded delimiters and line breaks follow RFC 4180', () => {
    const page = parseDelimited('\ufeffname,note\r\n"Smith, J","said ""hi""\nthen left"\r\nplain,', ',');
    expect(page.rows).toEqual([
      ['name', 'note'],
      ['Smith, J', 'said "hi"\nthen left'],
      ['plain', ''],
    ]);
    expect(page).toMatchObject({ total: 3, columns: 2, clipped: false, unterminated: false });
  });

  test('pages and clips large files and reports what it left out', () => {
    const rows = Array.from({ length: 250 }, (_, i) => `${i}\t${'x'.repeat(i === 3 ? 900 : 1)}`).join('\n');
    const page = parseDelimited(rows, delimiterFor('big.TSV'), { offset: 100, limit: 50, maxColumns: 1 });
    expect(page.total).toBe(250);
    expect(page.rows).toHaveLength(50);
    expect(page.rows[0]).toEqual(['100']);
    expect(page.clipped).toBe(true);
    const long = parseDelimited(rows, '\t', { limit: 5 });
    expect(long.rows[3]![1]!.endsWith('…')).toBe(true);
    expect(long.rows[3]![1]!.length).toBe(501);
  });

  test('an unterminated quote is reported rather than guessed', () => {
    expect(parseDelimited('a,"b\nc', ',').unterminated).toBe(true);
  });
});

describe('durable identity is a projection of History', () => {
  const entry = (id: string, n: number, time: string, files: HistoryEntry['files']): HistoryEntry => ({
    id,
    time,
    actor: 'you',
    kind: 'edited',
    sentence: `entry ${n}`,
    sessionId: null,
    taskId: null,
    sample: false,
    files,
    label: null,
    restoreOf: null,
    replaced: null,
    versionId: `v${String(n).padStart(4, '0')}`,
    commit: null,
  });
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const record = (path: string, before: string | null, after: string | null, recorded = true) => ({
    path,
    op: 'modified' as const,
    before,
    after,
    recorded,
    reason: null,
  });
  const history = [
    entry('E1', 1, '2026-09-24T10:00:00.000Z', [record('brief.md', A, A)]),
    entry('E2', 2, '2026-09-24T11:00:00.000Z', [record('brief.md', A, B), record('other.md', null, A)]),
    entry('E3', 3, '2026-09-24T12:00:00.000Z', [record('brief.md', B, A)]),
    entry('E4', 4, '2026-09-24T13:00:00.000Z', [record('brief.md', A, 'c'.repeat(64), false)]),
  ];

  test('versions are distinct recorded bytes, named by the entry that first recorded them', () => {
    expect(versionsOf(history, 'brief.md').map((v) => [v.versionId, v.sha[0]])).toEqual([
      ['v0002', 'b'],
      ['v0001', 'a'],
    ]);
    expect(identityOf(history, 'brief.md', A)).toEqual({ path: 'brief.md', sha: A, versionId: 'v0001', entryId: 'E1' });
    expect(identityOf(history, 'other.md', A).versionId).toBe('v0002');
    expect(identityOf(history, 'brief.md', 'd'.repeat(64)).versionId).toBeNull();
  });

  test('the version at a moment is the last recorded bytes at or before it', () => {
    expect(versionAt(history, 'brief.md', '2026-09-24T11:30:00.000Z')?.sha).toBe(B);
    expect(versionAt(history, 'brief.md', '2026-09-24T12:00:00.000Z')?.sha).toBe(A);
    expect(versionAt(history, 'brief.md', '2026-09-24T09:00:00.000Z')).toBeNull();
    // An unrecorded write is never a version.
    expect(versionAt(history, 'brief.md', '2026-09-24T14:00:00.000Z')?.sha).toBe(A);
  });

  test('the label is the version and a short hash', () => {
    expect(identityLabel({ sha: A, versionId: 'v0001' })).toBe('v0001 · aaaaaaaa');
    expect(identityLabel({ sha: A, versionId: null })).toBe('aaaaaaaa');
  });
});

describe('a sent message names the exact version of each file it carried', () => {
  const at = (time: string, sha: string, n: number): HistoryEntry => ({
    id: `E${n}`,
    time,
    actor: 'you',
    kind: 'observed',
    sentence: '',
    sessionId: null,
    taskId: null,
    sample: false,
    files: [{ path: 'brief.md', op: 'modified', before: sha, after: sha, recorded: true, reason: null }],
    label: null,
    restoreOf: null,
    replaced: null,
    versionId: `v000${n}`,
    commit: null,
  });
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const history = [at('2026-09-24T10:00:00.000Z', A, 1), at('2026-09-24T10:00:00.050Z', B, 2)];

  test('the recorded sha wins over the time, and the time is the fallback', () => {
    const turn = { at: '2026-09-24T10:00:00.010Z' };
    expect(turnReference(turn, 'brief.md', history)?.versionId).toBe('v0001');
    expect(turnReference({ ...turn, sourceVersions: [{ path: 'brief.md', sha: B }] }, 'brief.md', history)).toEqual({
      path: 'brief.md',
      sha: B,
      versionId: 'v0002',
      entryId: 'E2',
    });
    expect(turnReference({ at: '2026-09-24T09:00:00.000Z' }, 'brief.md', history)).toBeNull();
  });
});
