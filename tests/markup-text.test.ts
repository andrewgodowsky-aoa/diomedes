import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contentCheck } from '../server/native-work.js';
import { Store, hash } from '../server/store.js';
import { MARKUP_TEXT, PLAIN_TEXT } from './fixtures/markup-text.js';

describe('markup disguised as Markdown or Mermaid (P2-B)', () => {
  for (const name of ['notes.md', 'notes.MARKDOWN', 'flow.MMD']) {
    test.each(MARKUP_TEXT)(`${name} refuses %s before an exact review exists`, (_label, text) => {
      expect(() => contentCheck(name, text)).toThrow(/starts with markup/);
    });
  }
  test.each(PLAIN_TEXT)('%s retains ordinary text authorization', (name, text) => {
    expect(contentCheck(name, text)).toBeNull();
  });
});

describe('the recorded writer also protects model text outside proposals', () => {
  let root: string, store: Store, id: string, folder: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-markup-'));
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    const project = await store.createProject('Text fixture');
    id = project.id;
    folder = project.folder;
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  test.each(['diomedes', 'diomedes-with-ok'] as const)('%s cannot write any part of a mixed batch', async (actor) => {
    const before = structuredClone(store.state(id).history);
    await expect(store.locked(() => store.writeRecorded(id, [
      { path: 'safe.md', text: '# Safe\n', expected: null },
      { path: 'unsafe.mmd', text: MARKUP_TEXT[2][1], expected: null },
    ], { actor }))).rejects.toMatchObject({ status: 422 });
    await expect(fs.stat(path.join(folder, 'safe.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(folder, 'unsafe.mmd'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.state(id).history).toEqual(before);
  });
  test('a refused replacement preserves the existing file and recorded version', async () => {
    const text = '# Existing notes\n';
    await store.locked(() => store.writeRecorded(id, [{ path: 'notes.md', text, expected: null }]));
    const before = structuredClone(store.state(id).history);
    await expect(store.locked(() => store.writeRecorded(id, [
      { path: 'notes.md', text: MARKUP_TEXT[4][1], expected: hash(text) },
    ], { actor: 'diomedes' }))).rejects.toMatchObject({ status: 422 });
    expect(await fs.readFile(path.join(folder, 'notes.md'), 'utf8')).toBe(text);
    expect(store.state(id).history).toEqual(before);
  });
  test('normal model text and the person\'s markup stay byte-for-byte writes', async () => {
    for (const [name, text] of PLAIN_TEXT) {
      await store.locked(() => store.writeRecorded(id, [{ path: name, text, expected: null }], { actor: 'diomedes' }));
      expect(await fs.readFile(path.join(folder, name), 'utf8')).toBe(text);
    }
    const text = MARKUP_TEXT[0][1];
    await store.locked(() => store.writeRecorded(id, [{ path: 'mine.md', text, expected: null }]));
    expect(await fs.readFile(path.join(folder, 'mine.md'), 'utf8')).toBe(text);
    await store.locked(() => store.writeRecorded(id, [{ path: 'mine.md', text: null, expected: hash(text) }], { actor: 'diomedes-with-ok' }));
    await expect(fs.stat(path.join(folder, 'mine.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
