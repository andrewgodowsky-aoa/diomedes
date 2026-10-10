import { expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FileRunStore } from '../server/harness/run-store.js';
import type { HarnessRun } from '../shared/harness.js';

// The run service polls `read` while it writes. Windows refuses to rename over
// a file that has any open handle, so a slow in-process read must finish before
// the replacement renames, and a read that arrives meanwhile must wait for it.
test('a record replacement waits for reads in flight and holds back new ones', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-run-store-gate-'));
  const files = new FileRunStore(root);
  const base = {
    v: 1, id: 'R-gate', tenantId: 'fixture', projectId: 'fixture', state: 'queued',
    steps: [], events: [], updatedAt: new Date(1000).toISOString(),
  } as unknown as HarnessRun;
  await files.create(base);
  const target = path.join(root, 'R-gate.json');

  const events: string[] = [];
  const readFile = fs.readFile.bind(fs);
  const rename = fs.rename.bind(fs);
  let reads = 0;
  const readSpy = vi.spyOn(fs, 'readFile').mockImplementation((async (file: never, options: never) => {
    const n = ++reads;
    events.push(`read${n}-open`);
    // Hold a real handle on the destination for a while, like a slow poll under load.
    const held = await fs.open(target, 'r');
    try {
      await delay(300);
      return await readFile(file, options);
    } finally {
      await held.close();
      events.push(`read${n}-close`);
    }
  }) as never);
  const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    events.push('rename');
    await rename(from, to);
  });
  try {
    const first = files.read(base.id);
    await delay(50);                       // the first read now holds the destination
    const next = { ...base, updatedAt: new Date(2000).toISOString() } as HarnessRun;
    const write = files.write(next);
    await delay(50);
    const late = files.read(base.id);      // arrives while the replacement is pending
    const [before, , after] = await Promise.all([first, write, late]);
    expect(before?.updatedAt).toBe(base.updatedAt);
    expect(after?.updatedAt).toBe(next.updatedAt);
    expect(events).toEqual(['read1-open', 'read1-close', 'rename', 'read2-open', 'read2-close']);
  } finally {
    readSpy.mockRestore();
    renameSpy.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// DIO-318: a listing can miss a file while the folder's files are replaced, and the
// host then asks `has` whether the run is really gone. That answer waits for a
// replacement in flight, so it never lands inside one.
test('a presence check waits for a replacement in flight and reports a missing record', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-run-store-has-'));
  const files = new FileRunStore(root);
  const base = {
    v: 1, id: 'R-has', tenantId: 'fixture', projectId: 'fixture', state: 'queued',
    steps: [], events: [], updatedAt: new Date(1000).toISOString(),
  } as unknown as HarnessRun;
  await files.create(base);

  const events: string[] = [];
  const rename = fs.rename.bind(fs);
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    events.push('rename-start');
    await held;
    await rename(from, to);
    events.push('rename-end');
  });
  try {
    const write = files.write({ ...base, updatedAt: new Date(2000).toISOString() } as HarnessRun);
    await vi.waitFor(() => expect(events).toEqual(['rename-start']), { timeout: 15_000 });
    const present = files.has(base.id).then((found) => {
      events.push('has');
      return found;
    });
    await delay(50);                       // an ungated check would have answered by now
    expect(events).toEqual(['rename-start']);
    release();
    await write;
    expect(await present).toBe(true);
    expect(events).toEqual(['rename-start', 'rename-end', 'has']);
    expect(await files.has('R-none')).toBe(false);
    expect(await files.has('../outside')).toBe(false);   // no run id, so never there
  } finally {
    renameSpy.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
