import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store, hash } from '../server/store.js';
import { browseImports, importExports, inspectImport } from '../server/file-imports.js';
import { createApp } from '../server/app.js';
import { IMPORT_EXTENSIONS, IMPORT_MAX_BYTES } from '../shared/file-imports.js';

let root: string;
let exportsFolder: string;
let store: Store;
let projectId: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-import-'));
  exportsFolder = path.join(root, 'exports');
  await fs.mkdir(exportsFolder);
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  projectId = (await store.createProject('Import proof')).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function exported(name: string, text: string | Buffer = 'A fictional export.\r\n') {
  const file = path.join(exportsFolder, name);
  await fs.writeFile(file, text);
  return file;
}
const imported = (files: unknown) => store.locked(() => importExports(store, projectId, files));

test.each(IMPORT_EXTENSIONS)(
  'imported %s exports remain readable in the existing Files preview',
  async (extension) => {
    const candidate = await inspectImport(await exported(`export${extension}`));
    const result = await imported([candidate]);
    const copied = result.files[0]!;
    expect(
      (await store.listDocuments(projectId)).find((file) => file.path === copied.path)?.kind,
    ).not.toBe('unsupported');
    expect(await store.readDocument(projectId, copied.path)).toMatchObject({
      path: copied.path,
      sha: candidate.sha,
      text: 'A fictional export.\r\n',
    });
  },
);

test('copies selected UTF-8 bytes into one recorded write, leaving originals and grants unchanged across restart', async () => {
  const text = '\ufeffitem,count\r\nTables,7\r\n';
  const first = await inspectImport(await exported('operations.csv', text));
  await exported('unselected.md', 'Do not include this.');
  expect(first).not.toHaveProperty('text');
  const before = structuredClone(store.state(projectId));
  const writer = vi.spyOn(store, 'writeRecorded');
  const result = await imported([first]);
  expect(writer).toHaveBeenCalledTimes(1);
  expect(writer.mock.calls[0]?.[1]).toEqual([
    { path: 'Imports/operations.csv', text, expected: null },
  ]);
  expect(await fs.readFile(first.path, 'utf8')).toBe(text);
  expect(await store.current(projectId, 'Imports/unselected.md')).toBeNull();
  expect(store.state(projectId).needs).toEqual(before.needs);
  expect(store.state(projectId).project.packs).toEqual(before.project.packs);
  const reopened = new Store(store.dataDir, store.projectRoot);
  await reopened.init();
  expect(await reopened.current(projectId, result.files[0]!.path)).toBe(text);
  const entry = reopened.state(projectId).history.find((item) => item.id === result.entryId)!;
  expect(entry.actor).toBe('you');
  expect(entry.files[0]).toMatchObject({ before: null, after: hash(text), recorded: true });
});

test.each(['credentials.json', 'auth.json', '.env.csv'])(
  'refuses private filename %s before import',
  async (name) => {
    const file = await exported(name);
    await expect(inspectImport(file)).rejects.toMatchObject({ status: 403 });
  },
);

test('refuses private folders and junctions both during browse and inspection', async () => {
  const privateFolder = path.join(exportsFolder, '.ssh');
  await fs.mkdir(privateFolder);
  await fs.writeFile(path.join(privateFolder, 'notes.md'), 'private');
  await expect(inspectImport(path.join(privateFolder, 'notes.md'))).rejects.toMatchObject({
    status: 403,
  });
  const linked = path.join(exportsFolder, 'linked');
  await fs.symlink(privateFolder, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(inspectImport(path.join(linked, 'notes.md'))).rejects.toMatchObject({ status: 403 });
  await expect(browseImports(linked)).rejects.toMatchObject({ status: 403 });
  const listed = await browseImports(exportsFolder);
  expect(listed.folders).toEqual([]);
});

test.each([
  ['invalid.csv', Buffer.from([0xc3, 0x28])],
  ['renamed.csv', Buffer.from('MZThis is an executable')],
  ['binary.md', Buffer.from([65, 0, 66])],
  ['report.pdf', Buffer.from('%PDF-1.7')],
])('refuses unsupported or malformed bytes in %s', async (name, bytes) => {
  await expect(inspectImport(await exported(name, bytes))).rejects.toMatchObject({ status: 415 });
});

test('enforces byte and count limits before writing', async () => {
  await expect(
    inspectImport(await exported('large.txt', 'x'.repeat(IMPORT_MAX_BYTES + 1))),
  ).rejects.toMatchObject({ status: 413 });
  const file = await inspectImport(await exported('normal.txt'));
  await expect(imported(Array.from({ length: 9 }, () => file))).rejects.toMatchObject({
    status: 400,
  });
  const files = [];
  for (let i = 0; i < 5; i++)
    files.push(await inspectImport(await exported(`total-${i}.txt`, 'x'.repeat(IMPORT_MAX_BYTES))));
  await expect(imported(files)).rejects.toMatchObject({ status: 413 });
  expect(await store.current(projectId, 'Imports/total-0.txt')).toBeNull();
});

test('a changed source and an existing destination refuse the entire batch', async () => {
  const first = await inspectImport(await exported('first.csv'));
  const second = await inspectImport(await exported('second.csv'));
  await fs.writeFile(second.path, 'Changed after the selection.');
  await expect(imported([first, second])).rejects.toMatchObject({ status: 409 });
  expect(await store.current(projectId, 'Imports/first.csv')).toBeNull();
  await imported([first]);
  const currentSecond = await inspectImport(second.path);
  await expect(imported([currentSecond, first])).rejects.toMatchObject({ status: 409 });
  expect(await store.current(projectId, 'Imports/second.csv')).toBeNull();
});

test('duplicate names, deleted sources and linked destinations cannot write', async () => {
  const file = await inspectImport(await exported('notes.md'));
  const otherFolder = path.join(root, 'other');
  await fs.mkdir(otherFolder);
  const otherPath = path.join(otherFolder, 'notes.md');
  await fs.writeFile(otherPath, 'another');
  await expect(imported([file, await inspectImport(otherPath)])).rejects.toMatchObject({
    status: 409,
  });
  await fs.unlink(otherPath);
  await expect(imported([{ path: otherPath, sha: file.sha }])).rejects.toThrow();
  const projectFolder = store.state(projectId).project.folder;
  await fs.symlink(
    otherFolder,
    path.join(projectFolder, 'Imports'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(imported([file])).rejects.toMatchObject({ status: 403 });
  await expect(fs.access(otherPath)).rejects.toThrow();
});

test('production HTTP routes enforce local client boundaries and perform the recorded import', async () => {
  const app = await createApp({
    dataDir: path.join(root, 'http-data'),
    projectRoot: path.join(root, 'http-projects'),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  try {
    const created = await fetch(`${url}/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'HTTP imports' }),
    });
    const project = (await created.json()) as { id: string };
    const base = `${url}/projects/${project.id}/imports`;
    const source = await exported('http.csv', 'item,count\nTables,4');
    expect(
      (
        await fetch(`${base}/inspect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: source }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/browse`, { headers: { Origin: 'https://untrusted.example' } })).status,
    ).toBe(403);
    const inspected = await fetch(`${base}/inspect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: source }),
    });
    expect(inspected.status).toBe(200);
    const candidate: unknown = await inspected.json();
    const response = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ files: [candidate] }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { files: { path: string }[] };
    expect(result.files[0]?.path).toBe('Imports/http.csv');
    expect(
      (await fetch(base, { method: 'POST', headers, body: JSON.stringify({ files: [candidate] }) }))
        .status,
    ).toBe(409);
  } finally {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
