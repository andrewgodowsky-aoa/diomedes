import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { PROJECT_STATE } from '../server/migrations/registry.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function seeded(count = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-store-startup-'));
  roots.push(root);
  const open = () => new Store(path.join(root, 'data'), path.join(root, 'projects'));
  const store = open();
  await store.init();
  const projects = [];
  for (let i = 0; i < count; i += 1) projects.push(await store.createProject(`Startup ${i}`));
  // Allow every existing migration to run once before measuring an unchanged launch.
  await open().init();
  return { open, projects };
}

test('reopening unchanged projects preserves their files without durable rewrites', async () => {
  const { open, projects } = await seeded(3);
  const store = open();
  const persisted = vi.spyOn(store, 'persist');
  const files = projects.map(project => store.statePath(project.id));
  const before = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  for (const file of files) await fs.utimes(file, timestamp, timestamp);
  await store.init();
  expect(persisted).not.toHaveBeenCalled();
  expect(await Promise.all(files.map(file => fs.readFile(file, 'utf8')))).toEqual(before);
  expect(await Promise.all(files.map(async file => (await fs.stat(file)).mtimeMs)))
    .toEqual(files.map(() => timestamp.getTime()));
  expect((await store.projects()).map(project => project.id)).toEqual(projects.map(project => project.id));
});

test('an older schema marker is still persisted once even when its state is otherwise current', async () => {
  const { open, projects } = await seeded();
  const file = open().statePath(projects[0].id);
  const legacy = JSON.parse(await fs.readFile(file, 'utf8'));
  delete legacy.schemaVersion;
  await fs.writeFile(file, JSON.stringify(legacy));
  const migrated = open();
  const writes = vi.spyOn(migrated, 'persist');
  await migrated.init();
  expect(writes).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await fs.readFile(file, 'utf8')).schemaVersion).toBe(PROJECT_STATE.current);
  const reopened = open();
  const repeated = vi.spyOn(reopened, 'persist');
  await reopened.init();
  expect(repeated).not.toHaveBeenCalled();
});
