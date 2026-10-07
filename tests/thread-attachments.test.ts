/**
 * A thread's attached files stay on its composer until the person removes one (Andrew,
 * 2026-10-06), kept per project and thread in this browser (client/console/thread-attachments.ts).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DocumentInfo } from '../shared/types';

function makeStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
  };
}
const file = (path: string, size = 120): DocumentInfo => ({
  path,
  kind: 'markdown',
  size,
  changedAt: '2026-10-06T12:00:00.000Z',
  hasChangesWaiting: false,
  recorded: true,
});

let storage: ReturnType<typeof makeStorage>;
let mod: typeof import('../client/console/thread-attachments');
beforeEach(async () => {
  vi.resetModules();
  storage = makeStorage();
  vi.stubGlobal('localStorage', storage);
  mod = await import('../client/console/thread-attachments');
});

const paths = (files: readonly DocumentInfo[]) => files.map((item) => item.path);

describe("a thread's attached files", () => {
  test('are kept in path order, whatever order they were picked in, and read back after a reload', async () => {
    const picked = [file('menu.md'), file('Notes/linen.md'), file('brief.md')];
    expect(paths(mod.saveThreadAttachments('p1', 't1', picked))).toEqual(['Notes/linen.md', 'brief.md', 'menu.md']);
    // A reload starts the module again over the same storage.
    vi.resetModules();
    const reloaded = await import('../client/console/thread-attachments');
    expect(reloaded.readThreadAttachments('p1', 't1')).toEqual([file('Notes/linen.md'), file('brief.md'), file('menu.md')]);
  });

  test('belong to one thread of one project, so a new thread starts with none', () => {
    mod.saveThreadAttachments('p1', 't1', [file('brief.md')]);
    expect(mod.readThreadAttachments('p1', 't1')).toHaveLength(1);
    expect(mod.readThreadAttachments('p1', 't2')).toEqual([]);
    expect(mod.readThreadAttachments('p2', 't1')).toEqual([]);
    // Names that would collide when joined plainly stay apart.
    mod.saveThreadAttachments('p|1', 't', [file('a.md')]);
    expect(mod.readThreadAttachments('p', '1|t')).toEqual([]);
  });

  test('removing one keeps the rest; removing the last forgets the thread', () => {
    mod.saveThreadAttachments('p1', 't1', [file('brief.md'), file('menu.md')]);
    mod.saveThreadAttachments('p1', 't1', [file('menu.md')]);
    expect(paths(mod.readThreadAttachments('p1', 't1'))).toEqual(['menu.md']);
    mod.saveThreadAttachments('p1', 't1', []);
    expect(storage.items.has(mod.threadAttachmentsKey('p1', 't1'))).toBe(false);
    expect(mod.readThreadAttachments('p1', 't1')).toEqual([]);
  });

  test('each path once', () => {
    expect(paths(mod.saveThreadAttachments('p1', 't1', [file('brief.md'), file('brief.md', 9), file('a.md')]))).toEqual([
      'a.md',
      'brief.md',
    ]);
  });

  test('a damaged or foreign entry reads as none, and a damaged file is dropped', () => {
    const key = mod.threadAttachmentsKey('p1', 't1');
    for (const raw of ['not json', '{"path":"a.md"}', '"a.md"', JSON.stringify([file('a.md')]).padEnd(70_000)]) {
      storage.items.set(key, raw);
      expect(mod.readThreadAttachments('p1', 't1')).toEqual([]);
    }
    storage.items.set(key, JSON.stringify([file('b.md'), { path: 'c.md', kind: 'executable', size: 1 }, { path: '', kind: 'text', size: 1 }, 7]));
    expect(paths(mod.readThreadAttachments('p1', 't1'))).toEqual(['b.md']);
  });

  test('a browser that refuses storage keeps them for the session: nothing throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(paths(mod.saveThreadAttachments('p1', 't1', [file('menu.md'), file('brief.md')]))).toEqual(['brief.md', 'menu.md']);
    expect(mod.readThreadAttachments('p1', 't1')).toEqual([]);
  });
});
