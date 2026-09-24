import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store, bytesHash, hash } from '../server/store.js';
import {
  documentFacts,
  documentVersion,
  droppedFiles,
  dropFiles,
  pictureBytes,
  workbookSheet,
  type DroppedFile,
} from '../server/file-drops.js';
import { createApp } from '../server/app.js';
import { DROP_MAX_FILES, DROP_MAX_TEXT_BYTES } from '../shared/file-drops.js';
import {
  GIF_1X1,
  JPEG_1X1,
  PDF_SMALL,
  PNG_1X1,
  SAFE_SVG,
  SCRIPTED_SVG,
  WEBP_1X1,
  XLSX_HEAD,
  buildXlsx,
  pngClaiming,
} from './fixtures/file-drop-samples.js';

let root: string;
let store: Store;
let projectId: string;
let folder: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-drop-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  projectId = (await store.createProject('Drop proof')).id;
  folder = store.state(projectId).project.folder;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const file = (name: string, bytes: Uint8Array | string): DroppedFile => ({
  name,
  bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
});
const drop = (files: DroppedFile[], how: 'drop' | 'paste' = 'drop') =>
  store.locked(() => dropFiles(store, projectId, files, how));

describe('drop and paste import through the one recorded write path', () => {
  test('pictures, PDFs, workbooks, drawings and text land in Imports/ as one attributed History entry', async () => {
    const writer = vi.spyOn(store, 'writeRecorded');
    const result = await drop([
      file('photo.png', PNG_1X1),
      file('scan.JPG', JPEG_1X1),
      file('loop.gif', GIF_1X1),
      file('small.webp', WEBP_1X1),
      file('invoice.pdf', PDF_SMALL),
      file('stock.xlsx', XLSX_HEAD),
      file('plan.svg', SAFE_SVG),
      file('notes.md', '# Notes\r\nCRLF kept\r\n'),
    ]);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(result.files.map((item) => [item.path, item.kind])).toEqual([
      ['Imports/photo.png', 'png'],
      ['Imports/scan.JPG', 'jpeg'],
      ['Imports/loop.gif', 'gif'],
      ['Imports/small.webp', 'webp'],
      ['Imports/invoice.pdf', 'pdf'],
      ['Imports/stock.xlsx', 'xlsx'],
      ['Imports/plan.svg', 'svg'],
      ['Imports/notes.md', 'text'],
    ]);
    // The bytes on disk are exactly the bytes dropped, pictures included.
    expect(new Uint8Array(await fs.readFile(path.join(folder, 'Imports/photo.png')))).toEqual(PNG_1X1);
    expect(await fs.readFile(path.join(folder, 'Imports/notes.md'), 'utf8')).toBe('# Notes\r\nCRLF kept\r\n');
    const entry = store.state(projectId).history.find((item) => item.id === result.entryId)!;
    expect(entry).toMatchObject({ actor: 'you', label: 'Dropped into Files', versionId: result.versionId });
    expect(entry.sentence).toBe('You dropped 8 files into Files.');
    expect(entry.files).toHaveLength(8);
    const png = entry.files.find((item) => item.path === 'Imports/photo.png')!;
    expect(png).toMatchObject({ op: 'created', before: null, after: bytesHash(PNG_1X1), recorded: true, binary: true });
    // Text is still text: its History hash is the ordinary text hash, with no binary flag.
    const md = entry.files.find((item) => item.path === 'Imports/notes.md')!;
    expect(md.after).toBe(hash('# Notes\r\nCRLF kept\r\n'));
    expect(md.binary).toBeUndefined();
    // The listing keeps every non-text kind 'unsupported', so no text gate admits a picture.
    const listed = await store.listDocuments(projectId);
    expect(listed.find((item) => item.path === 'Imports/photo.png')?.kind).toBe('unsupported');
    expect(listed.find((item) => item.path === 'Imports/plan.svg')?.kind).toBe('drawing');
    expect(listed.find((item) => item.path === 'Imports/photo.png')?.recorded).toBe(true);
  });

  test('a paste is its own History label and its own sentence', async () => {
    const result = await drop([file('Pasted image 2026-09-24 101500.png', PNG_1X1)], 'paste');
    const entry = store.state(projectId).history.find((item) => item.id === result.entryId)!;
    expect(entry).toMatchObject({ label: 'Pasted into Files', sentence: 'You pasted 1 file into Files.' });
  });

  test('a taken name gets the next free name, on disk and inside the batch, and never overwrites', async () => {
    await fs.mkdir(path.join(folder, 'Imports'));
    await fs.writeFile(path.join(folder, 'Imports/photo.png'), 'someone else\'s file');
    await fs.writeFile(path.join(folder, 'Imports/photo (2).png'), 'and another');
    const result = await drop([file('photo.png', PNG_1X1), file('PHOTO.png', PNG_1X1), file('a.txt', 'one')]);
    expect(result.files.map((item) => [item.path, item.renamed])).toEqual([
      ['Imports/photo (3).png', true],
      ['Imports/PHOTO (4).png', true],
      ['Imports/a.txt', false],
    ]);
    expect(await fs.readFile(path.join(folder, 'Imports/photo.png'), 'utf8')).toBe("someone else's file");
  });

  test.each([
    ['photo.pdf', PNG_1X1, 415, 'named as a PDF but contains a PNG picture'],
    ['report.txt', PDF_SMALL, 415, 'named as text but contains a PDF'],
    ['setup.png', new TextEncoder().encode('MZ\u0090\u0000binary'), 415, 'does not contain what its name says'],
    ['drawing.png', new TextEncoder().encode(SAFE_SVG), 415, 'named as a PNG picture but contains an SVG drawing'],
    ['notes.txt', new TextEncoder().encode(SAFE_SVG), 415, 'contains an SVG drawing'],
    ['archive.xlsx', new TextEncoder().encode('PK\u0003\u0004word/document.xml'), 415, 'does not contain'],
    ['run.exe', PNG_1X1, 415, 'not a file type Files takes'],
    ['evil.svg', new TextEncoder().encode(SCRIPTED_SVG), 415, 'did not pass the drawing check'],
    ['huge.png', pngClaiming(20000, 20000), 413, 'megapixel limit'],
    ['empty.md', new Uint8Array(), 415, 'is empty'],
  ])('refuses %s by its bytes (%s)', async (name, bytes, status, words) => {
    const before = store.state(projectId).history.length;
    await expect(drop([file(name, bytes as Uint8Array)])).rejects.toMatchObject({
      status,
      message: expect.stringContaining(words),
    });
    expect(store.state(projectId).history.length).toBe(before);
    await expect(fs.access(path.join(folder, 'Imports'))).rejects.toThrow();
  });

  test('one refused file refuses the whole batch before anything is written', async () => {
    await expect(drop([file('fine.md', '# ok'), file('bad.pdf', PNG_1X1)])).rejects.toMatchObject({ status: 415 });
    await expect(fs.access(path.join(folder, 'Imports/fine.md'))).rejects.toThrow();
  });

  test('count, per-file and total limits hold', async () => {
    await expect(
      drop(Array.from({ length: DROP_MAX_FILES + 1 }, (_, i) => file(`n${i}.txt`, 'x'))),
    ).rejects.toMatchObject({ status: 400 });
    await expect(drop([file('big.txt', 'a'.repeat(DROP_MAX_TEXT_BYTES + 1))])).rejects.toMatchObject({
      status: 415,
      message: expect.stringContaining('1 MB limit'),
    });
    const big = new Uint8Array(9 * 1024 * 1024);
    big.set(PDF_SMALL);
    await expect(
      drop([file('a.pdf', big), file('b.pdf', big), file('c.pdf', big)]),
    ).rejects.toMatchObject({ status: 413, message: expect.stringContaining('24 MB') });
  });

  test('names are reduced to a file name inside Imports/ and guarded names are refused', async () => {
    const result = await drop([file('..\\..\\outside/../escape.md', '# fine')]);
    expect(result.files[0]!.path).toBe('Imports/escape.md');
    await expect(drop([file('.env.md', 'x')])).rejects.toMatchObject({ status: 400 });
    await expect(drop([file('credentials.json', '{}')])).rejects.toMatchObject({ status: 403 });
  });

  test('a linked Imports folder is refused by the path guard', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(folder, 'Imports'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(drop([file('photo.png', PNG_1X1)])).rejects.toMatchObject({ status: 403 });
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  test('a model or an approval cannot write bytes through the recorded writer', async () => {
    await expect(
      store.writeRecorded(projectId, [{ path: 'x.png', text: null, bytes: PNG_1X1, expected: null }], {
        actor: 'diomedes',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('a restore of a dropped picture is refused in words and the file stays', async () => {
    const result = await drop([file('photo.png', PNG_1X1)]);
    await expect(store.restore(projectId, result.entryId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('cannot be restored from History yet'),
    });
    expect(new Uint8Array(await fs.readFile(path.join(folder, 'Imports/photo.png')))).toEqual(PNG_1X1);
  });

  test('History changes describe a picture without decoding it as text', async () => {
    const result = await drop([file('photo.png', PNG_1X1)]);
    const entry = store.state(projectId).history.find((item) => item.id === result.entryId)!;
    const change = await store.changeFromFile(projectId, entry, 0);
    expect(change.summary).toContain('Added Imports/photo.png. It is not text');
    expect(change.hunks).toEqual([]);
  });

  test('a picture survives restart and a crash between journal and project write is recovered', async () => {
    await drop([file('photo.png', PNG_1X1)]);
    const reopened = new Store(store.dataDir, store.projectRoot);
    await reopened.init();
    expect(new Uint8Array((await reopened.currentBytes(projectId, 'Imports/photo.png'))!)).toEqual(PNG_1X1);
    // Simulate a crash: the journal is durable but the project write never happened.
    const spy = vi
      .spyOn(reopened as unknown as { applyWrite: () => Promise<void> }, 'applyWrite')
      .mockRejectedValueOnce(new Error('crash'));
    // The first failure triggers recovery, which completes the byte write from the object store.
    await expect(
      reopened.locked(() => dropFiles(reopened, projectId, [file('second.gif', GIF_1X1)], 'drop')),
    ).rejects.toThrow('crash');
    spy.mockRestore();
    expect(new Uint8Array((await reopened.currentBytes(projectId, 'Imports/second.gif'))!)).toEqual(GIF_1X1);
    expect(await fs.readdir(path.join(reopened.dataDir, 'pending'))).toEqual([]);
  });
});

describe('previews are read-only, content-sniffed and identity-addressed', () => {
  test('a picture is served only when its bytes are a picture, whatever its name', async () => {
    await drop([file('photo.png', PNG_1X1)]);
    const served = await pictureBytes(store, projectId, 'Imports/photo.png');
    expect(served).toMatchObject({ mime: 'image/png', sha: bytesHash(PNG_1X1), current: true });
    // A PNG written into the folder under another name is still served by its bytes.
    await fs.writeFile(path.join(folder, 'renamed.dat'), PNG_1X1);
    expect((await pictureBytes(store, projectId, 'renamed.dat')).mime).toBe('image/png');
    await fs.writeFile(path.join(folder, 'fake.png'), SAFE_SVG);
    await expect(pictureBytes(store, projectId, 'fake.png')).rejects.toMatchObject({ status: 415 });
    await fs.writeFile(path.join(folder, 'bomb.png'), pngClaiming(20000, 20000));
    await expect(pictureBytes(store, projectId, 'bomb.png')).rejects.toMatchObject({ status: 413 });
    await expect(pictureBytes(store, projectId, '../outside.png')).rejects.toMatchObject({ status: 400 });
  });

  test('facts describe a PDF and a picture without rendering either', async () => {
    await drop([file('invoice.pdf', PDF_SMALL), file('photo.png', PNG_1X1)]);
    const pdf = await documentFacts(store, projectId, 'Imports/invoice.pdf');
    expect(pdf).toMatchObject({
      kind: 'pdf',
      current: true,
      bytes: PDF_SMALL.length,
      pdf: { version: '1.4', encrypted: false },
      identity: { path: 'Imports/invoice.pdf', sha: bytesHash(PDF_SMALL), versionId: expect.stringMatching(/^v\d{4}$/) },
    });
    const png = await documentFacts(store, projectId, 'Imports/photo.png');
    expect(png.picture).toEqual({ width: 1, height: 1, previewable: true });
  });

  test('an older version opens by identity from History; an unrecorded one is refused in words', async () => {
    await fs.writeFile(path.join(folder, 'brief.md'), 'first version');
    const first = await store.readDocument(projectId, 'brief.md');
    await store.locked(() =>
      store.writeRecorded(projectId, [{ path: 'brief.md', text: 'second version', expected: first.sha }]),
    );
    const old = await documentVersion(store, projectId, 'brief.md', first.sha);
    expect(old).toMatchObject({
      current: false,
      text: 'first version',
      identity: { path: 'brief.md', sha: first.sha, versionId: expect.stringMatching(/^v\d{4}$/) },
    });
    const now = await documentVersion(store, projectId, 'brief.md', hash('second version'));
    expect(now).toMatchObject({ current: true, text: 'second version' });
    await expect(documentVersion(store, projectId, 'brief.md', hash('never written'))).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('History has no record'),
    });
    // The pair must match: a sha recorded for one path does not open another.
    await fs.writeFile(path.join(folder, 'other.md'), 'other');
    await expect(documentVersion(store, projectId, 'other.md', first.sha)).rejects.toMatchObject({ status: 404 });
  });

  test('a recorded version whose kept bytes are gone says it is no longer available', async () => {
    await fs.writeFile(path.join(folder, 'brief.md'), 'first version');
    const first = await store.readDocument(projectId, 'brief.md');
    await store.locked(() =>
      store.writeRecorded(projectId, [{ path: 'brief.md', text: 'second', expected: first.sha }]),
    );
    await fs.rm(store.objectPath(projectId, first.sha));
    await expect(documentVersion(store, projectId, 'brief.md', first.sha)).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('no longer available'),
    });
  });

  test('an older picture version is served from History after the file is replaced', async () => {
    const result = await drop([file('photo.png', PNG_1X1)]);
    const sha = result.files[0]!.sha;
    await fs.writeFile(path.join(folder, 'Imports/photo.png'), GIF_1X1);
    const old = await pictureBytes(store, projectId, 'Imports/photo.png', sha);
    expect(old).toMatchObject({ current: false, mime: 'image/png', sha });
    expect(new Uint8Array(old.bytes)).toEqual(PNG_1X1);
    const version = await documentVersion(store, projectId, 'Imports/photo.png', sha);
    expect(version).toMatchObject({ current: false, kind: 'png', text: null });
  });
});

describe('the drop request body', () => {
  test('splits concatenated bytes by the declared sizes and refuses a mismatch', () => {
    const body = Buffer.concat([Buffer.from(PNG_1X1), Buffer.from('hello')]);
    const files = droppedFiles(
      JSON.stringify([{ name: 'a.png', bytes: PNG_1X1.length }, { name: 'b.txt', bytes: 5 }]),
      body,
    );
    expect(files.map((item) => [item.name, item.bytes.length])).toEqual([
      ['a.png', PNG_1X1.length],
      ['b.txt', 5],
    ]);
    expect(() => droppedFiles(JSON.stringify([{ name: 'a.png', bytes: 3 }]), body)).toThrow('whole');
    expect(() => droppedFiles('not json', body)).toThrow();
    expect(() => droppedFiles(JSON.stringify([{ name: 'a', bytes: 1 }]), { parsed: true })).toThrow();
  });
});

test('production HTTP routes keep the client boundary and serve pictures with a sandbox policy', async () => {
  const app = await createApp({
    dataDir: path.join(root, 'http-data'),
    projectRoot: path.join(root, 'http-projects'),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    const created = await fetch(`${url}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
      body: JSON.stringify({ name: 'HTTP drops' }),
    });
    const project = (await created.json()) as { id: string };
    const base = `${url}/projects/${project.id}/documents`;
    const meta = encodeURIComponent(JSON.stringify([{ name: 'photo.png', bytes: PNG_1X1.length }]));
    // Without the client header a drop is refused before it is read.
    expect(
      (
        await fetch(`${base}/drop?files=${meta}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: PNG_1X1,
        })
      ).status,
    ).toBe(403);
    const dropped = await fetch(`${base}/drop?files=${meta}&how=paste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Diomedes-Client': '1' },
      body: PNG_1X1,
    });
    expect(dropped.status).toBe(200);
    const result = (await dropped.json()) as { files: { path: string; sha: string }[] };
    expect(result.files[0]!.path).toBe('Imports/photo.png');
    const picture = await fetch(`${base}/picture?path=${encodeURIComponent('Imports/photo.png')}`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toBe('image/png');
    expect(picture.headers.get('x-content-type-options')).toBe('nosniff');
    expect(picture.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(PNG_1X1);
    const facts = await fetch(`${base}/facts?path=${encodeURIComponent('Imports/photo.png')}`);
    expect(((await facts.json()) as { kind: string }).kind).toBe('png');
    expect(
      (await fetch(`${base}/picture?path=${encodeURIComponent('Imports/photo.png')}`, {
        headers: { Origin: 'https://untrusted.example' },
      })).status,
    ).toBe(403);
  } finally {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('an XLSX workbook reads as a bounded first-sheet table, with no new dependency', () => {
  const sheet = (rows: string) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  test('shared, inline, boolean and number cells, gaps by reference, and entities decoded', async () => {
    const bytes = buildXlsx(
      sheet(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>Tables &amp; chairs</t></is></c><c r="B2"><v>7</v></c><c r="C2" t="b"><v>1</v></c></row>' +
          '<row r="3"><c r="A3"><f>B2*2</f><v>14</v></c></row>',
      ),
      { shared: ['item', 'in stock'] },
    );
    await drop([file('stock.xlsx', bytes)]);
    const page = await workbookSheet(store, projectId, 'Imports/stock.xlsx', undefined, undefined);
    expect(page).toMatchObject({
      sheets: ['Stock', 'Second'],
      sheet: 'Stock',
      total: 3,
      columns: 3,
      clipped: false,
      current: true,
      rows: [
        ['item', '', 'in stock'],
        ['Tables & chairs', '7', 'TRUE'],
        ['14'],
      ],
    });
  });

  test('pages past the first hundred rows', async () => {
    const rows = Array.from({ length: 130 }, (_, i) => `<row><c t="inlineStr"><is><t>r${i + 1}</t></is></c></row>`).join('');
    await drop([file('long.xlsx', buildXlsx(sheet(rows)))]);
    const page = await workbookSheet(store, projectId, 'Imports/long.xlsx', undefined, '100');
    expect(page.total).toBe(130);
    expect(page.rows[0]).toEqual(['r101']);
    expect(page.rows).toHaveLength(30);
  });

  test('a part that inflates past its cap is refused in words, and so is a non-workbook', async () => {
    const huge = `<worksheet><sheetData>${'<row><c><v>1</v></c></row>'.repeat(400_000)}</sheetData></worksheet>`;
    await drop([file('bomb.xlsx', buildXlsx(huge, { lieAboutSize: true }))]);
    await expect(workbookSheet(store, projectId, 'Imports/bomb.xlsx', undefined, undefined)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('too large for Files to preview'),
    });
    await drop([file('photo.png', PNG_1X1)]);
    await expect(workbookSheet(store, projectId, 'Imports/photo.png', undefined, undefined)).rejects.toMatchObject({
      status: 415,
    });
    await fs.writeFile(path.join(folder, 'broken.xlsx'), XLSX_HEAD);
    await expect(workbookSheet(store, projectId, 'broken.xlsx', undefined, undefined)).rejects.toMatchObject({
      status: 422,
    });
  });
});
