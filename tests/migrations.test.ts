/**
 * H21: one migration framework for every durable file family.
 *
 * The registry accounts for each family and its version; migrations are pure
 * and checked against golden fixtures of real older files; an older file is
 * backed up beside itself before it is carried forward, and the backup is
 * never removed (decision 10); a newer file is refused and left byte for byte
 * as it was. The last block proves the readers that were wired through the
 * framework keep that promise end to end.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertReadable,
  familyProblems,
  MigrationRefusal,
  migrateRecord,
  type DurableFamily,
} from '../server/migrations/framework.js';
import { backupPath, openVersionedFile } from '../server/migrations/files.js';
import {
  AUTOMATION_DEFINITIONS,
  AUTOMATION_OCCURRENCES,
  DURABLE_FAMILIES,
  HARNESS_RUN,
  PACK_STORE,
  PROJECT_STATE,
  READY_QUEUE,
  SETTINGS,
  durableFamily,
} from '../server/migrations/registry.js';
import { PACK_STORE_SCHEMA_VERSION, PackLifecycle } from '../server/pack-lifecycle.js';
import { HARNESS_CONTRACT_VERSION } from '../shared/harness.js';
import { AUTOMATION_DEFINITION_VERSION, OCCURRENCES_FILE_VERSION } from '../shared/automations.js';
import { AutomationOccurrences } from '../server/automations.js';
import { AutomationDefinitions } from '../server/automation-definitions.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { Store } from '../server/store.js';
import { ReadyScheduler } from '../server/ready-scheduler.js';

const fixtures = path.resolve('tests', 'fixtures', 'migrations');
const fixture = async (name: string) => JSON.parse(await fs.readFile(path.join(fixtures, name), 'utf8'));

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-migrations-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A family with three versions, for exercising the framework itself. */
const THREE: DurableFamily = {
  id: 'three',
  title: 'three-step record',
  location: 'three.json',
  versionField: 'v',
  oldest: 1,
  current: 3,
  unversioned: null,
  migrations: {
    1: (record) => ({ ...record, v: 2, added: 'in two' }),
    2: ({ legacy, ...record }) => ({ ...record, v: 3, renamed: legacy ?? null }),
  },
  reader: { file: 'tests/migrations.test.ts', throughFramework: true },
};

describe('the registry', () => {
  test('every durable family is registered once, with a consistent chain of migrations', () => {
    const ids = DURABLE_FAMILIES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of DURABLE_FAMILIES) expect(familyProblems(item), item.id).toEqual([]);
    expect(durableFamily('settings')).toBe(SETTINGS);
    expect(() => durableFamily('nothing')).toThrow(/No durable family/);
  });

  test('each wired family names the version its own module writes', () => {
    expect(HARNESS_RUN.current).toBe(HARNESS_CONTRACT_VERSION);
    expect(AUTOMATION_OCCURRENCES.current).toBe(OCCURRENCES_FILE_VERSION);
    expect(AUTOMATION_DEFINITIONS.current).toBe(AUTOMATION_DEFINITION_VERSION);
    expect(PACK_STORE.current).toBe(PACK_STORE_SCHEMA_VERSION);
    expect(SETTINGS.current).toBe(new Store(root).settings.version);
  });

  test('the families still reading their own version are listed with where and why', () => {
    const own = DURABLE_FAMILIES.filter((item) => !item.reader.throughFramework);
    expect(own.length).toBeGreaterThan(0);
    for (const item of own) {
      expect(item.reader.file).toMatch(/^server\/.+\.ts$/);
      expect(item.reader.note, item.id).toBeTruthy();
    }
  });

  test('a registry problem is reported, not tolerated', () => {
    expect(familyProblems({ ...THREE, migrations: { 1: THREE.migrations[1]! } })).toEqual(['no migration from 2']);
    expect(familyProblems({ ...THREE, migrations: { ...THREE.migrations, 3: (r) => r } })).toEqual([
      'stray migration from 3',
    ]);
    expect(familyProblems({ ...THREE, oldest: 4 })).toContain('oldest is outside 1..current');
  });
});

describe('migrateRecord', () => {
  test('a current record comes back as the same object, unmigrated', () => {
    const record = { v: 3, renamed: 'x' };
    const result = migrateRecord(THREE, record);
    expect(result).toEqual({ record, from: 3, to: 3, migrated: false });
    expect(result.record).toBe(record);
  });

  test('an older record is carried forward one step at a time without touching the input', () => {
    const record = { v: 1, legacy: 'kept', other: [1, 2] };
    const frozen = structuredClone(record);
    const result = migrateRecord(THREE, record);
    expect(result).toEqual({
      record: { v: 3, added: 'in two', renamed: 'kept', other: [1, 2] },
      from: 1,
      to: 3,
      migrated: true,
    });
    expect(record).toEqual(frozen);
  });

  test('is idempotent: migrating the result again changes nothing', () => {
    const once = migrateRecord(THREE, { v: 1, legacy: 'a' }).record;
    const twice = migrateRecord(THREE, once);
    expect(twice.migrated).toBe(false);
    expect(twice.record).toEqual(once);
  });

  test.each([
    ['a newer version', { v: 4 }, 'newer-version', /newer Diomedes \(version 4\).*up to version 3/],
    ['a version below the oldest', { v: 0 }, 'unknown-version', /version 0, which no Diomedes writes/],
    ['a version that is not a number', { v: '3' }, 'unknown-version', /version 3, which no Diomedes writes/],
    ['a missing version', {}, 'unknown-version', /does not say which version/],
    ['an array', [], 'not-a-record', /not a record/],
    ['null', null, 'not-a-record', /not a record/],
  ])('%s is refused with its reason', (_label, value, code, message) => {
    expect(() => migrateRecord(THREE, value)).toThrow(message);
    try {
      migrateRecord(THREE, value);
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationRefusal);
      expect((error as MigrationRefusal).code).toBe(code);
      expect((error as MigrationRefusal).family).toBe('three');
    }
  });

  test('a retired version and a broken step are refused, never half-applied', () => {
    expect(() => assertReadable({ ...THREE, oldest: 2, migrations: { 2: THREE.migrations[2]! } }, { v: 1 })).toThrow(
      /older than this build can carry forward/,
    );
    expect(() => migrateRecord({ ...THREE, migrations: { 1: THREE.migrations[1]! } }, { v: 1 })).toThrow(
      /no way to carry the three-step record from version 2 to 3/,
    );
    expect(() => migrateRecord({ ...THREE, migrations: { ...THREE.migrations, 1: (r) => r } }, { v: 1 })).toThrow(
      /did not produce version 2/,
    );
  });

  test('an unversioned record is read as the version its family names', () => {
    expect(migrateRecord(PROJECT_STATE, { project: {} })).toMatchObject({ from: 1, migrated: false });
    expect(() => migrateRecord(HARNESS_RUN, { id: 'R1' })).toThrow(/does not say which version/);
  });
});

describe('golden fixtures of older files', () => {
  test('a Milestone A automation record (v1) becomes exactly the v2 record', async () => {
    const result = migrateRecord(AUTOMATION_OCCURRENCES, await fixture('automation-occurrences.v1.json'));
    expect(result).toMatchObject({ from: 1, to: 2, migrated: true });
    expect(result.record).toEqual(await fixture('automation-occurrences.v2.expected.json'));
  });

  test.each([
    [SETTINGS, 'settings.v1.json'],
    [SETTINGS, 'settings.v1-0.1.8.json'],
    [PROJECT_STATE, 'project-state.pre-h21.json'],
    [PACK_STORE, 'pack-store.v1.json'],
    [READY_QUEUE, 'ready-queue.v1.json'],
    [AUTOMATION_DEFINITIONS, 'automation-definitions.v1.json'],
    [AUTOMATION_OCCURRENCES, 'automation-occurrences.v2.expected.json'],
  ].map(([family, name]) => [(family as DurableFamily).id, name, family] as const))(
    '%s reads %s as current',
    async (_id, name, family) => {
      const value = await fixture(name as string);
      const result = migrateRecord(family as DurableFamily, value);
      expect(result.migrated).toBe(false);
      expect(result.record).toEqual(value);
    },
  );
});

describe('openVersionedFile', () => {
  const file = () => path.join(root, 'three.json');
  const write = (value: unknown) => fs.writeFile(file(), JSON.stringify(value));
  const backups = async () => (await fs.readdir(root)).filter((name) => name.endsWith('.bak')).sort();

  test('an absent file is null and creates nothing', async () => {
    expect(await openVersionedFile(THREE, file())).toBeNull();
    expect(await fs.readdir(root)).toEqual([]);
  });

  test('a current file is read without being rewritten or backed up', async () => {
    await write({ v: 3, renamed: null });
    const before = await fs.stat(file());
    const opened = await openVersionedFile(THREE, file());
    expect(opened).toEqual({ record: { v: 3, renamed: null }, from: 3, to: 3, backup: null });
    expect((await fs.stat(file())).mtimeMs).toBe(before.mtimeMs);
    expect(await backups()).toEqual([]);
  });

  test('an older file is backed up byte for byte, then rewritten at the current version', async () => {
    await write({ v: 1, legacy: 'kept' });
    const original = await fs.readFile(file(), 'utf8');
    const opened = await openVersionedFile(THREE, file());
    expect(opened).toMatchObject({ from: 1, to: 3, record: { v: 3, renamed: 'kept', added: 'in two' } });
    expect(opened!.backup).toBe(backupPath(file(), 1, original));
    expect(await fs.readFile(opened!.backup!, 'utf8')).toBe(original);
    expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual(opened!.record);
    // No temp file is left behind.
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('is idempotent: a second open neither migrates nor makes another backup', async () => {
    await write({ v: 1, legacy: 'kept' });
    const first = await openVersionedFile(THREE, file());
    const after = await fs.readFile(file(), 'utf8');
    const second = await openVersionedFile(THREE, file());
    expect(second).toMatchObject({ from: 3, backup: null, record: first!.record });
    expect(await fs.readFile(file(), 'utf8')).toBe(after);
    expect(await backups()).toHaveLength(1);
  });

  test('a stop between the backup and the rewrite is finished by the next open, with the same backup', async () => {
    await write({ v: 2, legacy: 'kept' });
    const original = await fs.readFile(file(), 'utf8');
    // What a process stopped after its backup write leaves behind.
    await fs.writeFile(backupPath(file(), 2, original), original);
    const opened = await openVersionedFile(THREE, file());
    expect(opened).toMatchObject({ from: 2, record: { v: 3, renamed: 'kept' } });
    expect(await backups()).toEqual([path.basename(backupPath(file(), 2, original))]);
  });

  test('a backup is never replaced or removed, even by a later migration of other bytes', async () => {
    await write({ v: 1, legacy: 'first' });
    const first = (await openVersionedFile(THREE, file()))!.backup!;
    await write({ v: 1, legacy: 'second' });
    const second = (await openVersionedFile(THREE, file()))!.backup!;
    expect(second).not.toBe(first);
    expect(await backups()).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(first, 'utf8'))).toEqual({ v: 1, legacy: 'first' });
  });

  test('a damaged backup already in the way stops the migration with the file untouched', async () => {
    await write({ v: 1, legacy: 'kept' });
    const original = await fs.readFile(file(), 'utf8');
    await fs.writeFile(backupPath(file(), 1, original), 'something else');
    await expect(openVersionedFile(THREE, file())).rejects.toThrow(/backup .* holds different bytes/);
    expect(await fs.readFile(file(), 'utf8')).toBe(original);
  });

  test.each([
    ['a newer version', JSON.stringify({ v: 9, future: true }), /newer Diomedes/],
    ['an unknown version', JSON.stringify({ v: 'x' }), /which no Diomedes writes/],
    ['unreadable JSON', '{"v": 1,', /not readable JSON/],
  ])('%s is refused and the file is left exactly as it was', async (_label, text, message) => {
    await fs.writeFile(file(), text);
    await expect(openVersionedFile(THREE, file())).rejects.toThrow(message);
    expect(await fs.readFile(file(), 'utf8')).toBe(text);
    expect(await backups()).toEqual([]);
  });
});

describe('readers wired through the framework', () => {
  const data = () => path.join(root, 'data');

  async function seedStore() {
    const store = new Store(data(), path.join(root, 'projects'));
    await store.init();
    const project = await store.createProject('Wired');
    return { store, project, state: path.join(data(), 'projects', project.id, 'state.json') };
  }

  test('project state is written with its schema version and still read without one', async () => {
    const { project, state } = await seedStore();
    expect(JSON.parse(await fs.readFile(state, 'utf8')).schemaVersion).toBe(PROJECT_STATE.current);
    // A file written before H21, as the golden fixture shows, has no version and still opens.
    const legacy = await fixture('project-state.pre-h21.json');
    expect(legacy.schemaVersion).toBeUndefined();
    await fs.writeFile(
      state,
      JSON.stringify({ ...legacy, project: { ...legacy.project, id: project.id, folder: project.folder } }),
    );
    const reopened = new Store(data(), path.join(root, 'projects'));
    await reopened.init();
    expect(reopened.state(project.id).history).toHaveLength(legacy.history.length);
    // The version is a property of the file, not of the record in memory.
    expect((reopened.state(project.id) as { schemaVersion?: unknown }).schemaVersion).toBeUndefined();
  });

  test('a project record from a newer Diomedes stops the service with the file untouched', async () => {
    const { state } = await seedStore();
    const newer = JSON.stringify({ ...JSON.parse(await fs.readFile(state, 'utf8')), schemaVersion: 2 });
    await fs.writeFile(state, newer);
    await expect(new Store(data(), path.join(root, 'projects')).init()).rejects.toThrow(
      /project record was written by a newer Diomedes \(version 2\)/,
    );
    expect(await fs.readFile(state, 'utf8')).toBe(newer);
  });

  test('settings from a newer Diomedes stop the service with the file untouched', async () => {
    await seedStore();
    const file = path.join(data(), 'settings.json');
    const newer = JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), version: 2 });
    await fs.writeFile(file, newer);
    await expect(new Store(data(), path.join(root, 'projects')).init()).rejects.toThrow(
      /settings file was written by a newer Diomedes \(version 2\)/,
    );
    expect(await fs.readFile(file, 'utf8')).toBe(newer);
  });

  test('a saved run from a newer contract keeps its existing refusal code', async () => {
    const runs = new FileRunStore(path.join(root, 'runs'));
    await fs.mkdir(runs.dir, { recursive: true });
    const text = JSON.stringify({ v: 2, id: 'R1' });
    await fs.writeFile(path.join(runs.dir, 'R1.json'), text);
    await expect(runs.read('R1')).rejects.toMatchObject({ code: 'unsupported_run_version' });
    await expect(runs.read('R1')).rejects.toThrow(/newer Diomedes \(version 2\)/);
    expect(await fs.readFile(path.join(runs.dir, 'R1.json'), 'utf8')).toBe(text);
    await fs.writeFile(path.join(runs.dir, 'R2.json'), JSON.stringify({ id: 'R2' }));
    await expect(runs.read('R2')).rejects.toMatchObject({ code: 'unsupported_run_version' });
  });

  test('a Milestone A automation record is backed up and carried to v2 when the store opens', async () => {
    const dir = path.join(root, 'workspaces', 'automations');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'org_old.json');
    const original = await fs.readFile(path.join(fixtures, 'automation-occurrences.v1.json'), 'utf8');
    await fs.writeFile(file, original);
    const occurrences = new AutomationOccurrences(root);
    await occurrences.init();
    expect(occurrences.list('org_old').map((item) => item.trigger.commandId)).toEqual(['a1']);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(await fixture('automation-occurrences.v2.expected.json'));
    expect(await fs.readFile(backupPath(file, 1, original), 'utf8')).toBe(original);
    // The backup is not mistaken for another organization's file.
    const again = new AutomationOccurrences(root);
    await again.init();
    expect(again.isUnreadable('org_old')).toBe(false);
    expect((await fs.readdir(dir)).sort()).toEqual(['org_old.json', path.basename(backupPath(file, 1, original))]);
  });

  test('an automation definition from a newer build is left alone and refused', async () => {
    const dir = path.join(root, 'workspaces', 'automations', 'definitions');
    await fs.mkdir(dir, { recursive: true });
    const text = JSON.stringify({ v: 2, organizationId: 'org_new', definitions: [] });
    await fs.writeFile(path.join(dir, 'org_new.json'), text);
    const definitions = new AutomationDefinitions(root);
    await definitions.init();
    expect(definitions.isUnreadable('org_new')).toBe(true);
    expect(await fs.readFile(path.join(dir, 'org_new.json'), 'utf8')).toBe(text);
  });

  test('a pack store from a newer build keeps its refusal code and is not replaced', async () => {
    const packs = path.join(root, 'packs');
    await fs.mkdir(packs, { recursive: true });
    const text = JSON.stringify({ schemaVersion: 2, packs: {}, operations: [] });
    await fs.writeFile(path.join(packs, 'store.json'), text);
    const { store } = await seedStore();
    const lifecycle = new PackLifecycle({ store, root: packs, catalogue: async () => [] });
    await expect(lifecycle.open()).rejects.toMatchObject({ details: { code: 'unknown-store-version' } });
    expect(await fs.readFile(path.join(packs, 'store.json'), 'utf8')).toBe(text);
  });
  test('a Ready queue pause from a newer build is refused by name, and not rewritten', async () => {
    const { store } = await seedStore();
    const file = path.join(data(), 'ready-queue.json');
    const text = JSON.stringify({ version: 2, paused: null, future: [] });
    await fs.writeFile(file, text);
    const scheduler = new ReadyScheduler({ store, admit: async () => undefined, running: () => false });
    await expect(scheduler.init()).rejects.toThrow(/Ready queue pause was written by a newer Diomedes/);
    expect(await fs.readFile(file, 'utf8')).toBe(text);
  });
});
