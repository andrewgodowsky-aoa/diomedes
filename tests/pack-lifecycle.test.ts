import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import {
  PACK_MANIFEST_FILE,
  PackLifecycle,
  type PackFaultStep,
} from '../server/pack-lifecycle.js';
import { bundledCatalogue, sealManifest, sha256 } from '../server/pack-catalogue.js';
import { isPackActive } from '../shared/capability-packs.js';
import type { PackManifest, PackManifestBody } from '../shared/pack-manifest.js';
type StoredState = ReturnType<Store['state']>;

let temp: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-pack-life-'));
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

const catalogue = bundledCatalogue();

async function setup(fault?: (step: PackFaultStep) => void) {
  const store = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
  await store.init();
  const folder = path.join(temp, 'repo');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'AGENTS.md'), '# House rules\n', 'utf8');
  const one = await store.createProject('Kitchen', folder);
  const other = await fs.mkdir(path.join(temp, 'books'), { recursive: true }).then(() =>
    store.createProject('Books', path.join(temp, 'books')),
  );
  const packs = lifecycle(store, fault);
  return { store, packs, one: one.id, other: other.id };
}

const lifecycle = (store: Store, fault?: (step: PackFaultStep) => void) =>
  new PackLifecycle({
    store,
    root: path.join(store.dataDir, 'packs'),
    catalogue: () => catalogue,
    fault,
  });

/** Write a local pack folder whose manifest digest is correct. */
async function localPack(
  name: string,
  overrides: Partial<PackManifestBody> = {},
  files: Record<string, string> = { 'playbooks/close.md': '# Month-end close\n' },
) {
  const folder = path.join(temp, 'sources', name);
  await fs.mkdir(folder, { recursive: true });
  const listed = [];
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await fs.writeFile(path.join(folder, file), text, 'utf8');
    listed.push({ path: file, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) });
  }
  const manifest = sealManifest({
    schemaVersion: 1,
    id: 'acme.bookkeeping',
    version: '1.0.0',
    name: 'Bookkeeping',
    publisher: { id: 'acme', name: 'Acme' },
    description: 'Month-end close playbooks.',
    compatibility: { contract: '^1.0.0' },
    contributions: {
      tools: [],
      agents: [],
      rules: [],
      context: [],
      workflows: [
        {
          id: 'month-end-close',
          kind: 'procedure',
          name: 'Month-end close',
          description: 'Walks the close.',
          mode: 'plan',
          acts: false,
        },
      ],
      ui: [],
    },
    permissions: {
      requested: [{ capability: 'read-accounting', reason: 'To read the ledger export.' }],
      grantsAuthority: false,
    },
    dependencies: [],
    files: listed,
    ...overrides,
  });
  await fs.writeFile(path.join(folder, PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  return { folder, manifest };
}

const phases = async (packs: PackLifecycle, kind?: string) =>
  (await packs.operations())
    .filter((op) => !kind || op.kind === kind)
    .map((op) => `${op.kind}:${op.phase}:${op.packId}`);

/** Everything in a project's state that is authority, not a pack decision. */
const authority = (state: StoredState) => ({
  scopeGrants: structuredClone(state.scopeGrants),
  needs: structuredClone(state.needs),
  conversations: structuredClone(state.conversations),
  sessions: structuredClone(state.sessions),
  tasks: structuredClone(state.tasks),
});

describe('the pack store opens with the packs that ship wired, and nothing on', () => {
  test('Software Engineering and Small Business are installed by Diomedes; no project has them on', async () => {
    const { store, packs, one } = await setup();
    const installed = await packs.installed();
    expect(installed.map((p) => [p.id, p.current, p.runtime])).toEqual([
      ['diomedes.small-business', '0.1.0', 'wired'],
      ['diomedes.software-engineering', '0.1.0', 'wired'],
    ]);
    const ops = await packs.operations();
    expect(ops.filter((op) => op.phase === 'completed').every((op) => op.by === 'diomedes')).toBe(true);
    expect(store.state(one).project.packs).toBeUndefined();
    expect(await packs.loadedContributions(one)).toEqual([]);
    expect((await packs.available()).map((m) => m.id)).toEqual([
      'diomedes.weekly-brief',
      'diomedes.industry.carpentry',
      'diomedes.industry.professional-services',
      'diomedes.industry.restaurant-operations',
      'diomedes.industry.tire-service',
    ]);
  });

  test('a store written by a newer Diomedes is refused, and left as it was', async () => {
    const { store } = await setup();
    const file = path.join(store.dataDir, 'packs', 'store.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, packs: {}, operations: [] }));
    const packs = lifecycle(store);
    await expect(packs.installed()).rejects.toThrow(/schema 2, which this Diomedes does not read/);
    await expect(packs.install({ kind: 'bundled', packId: 'diomedes.weekly-brief' })).rejects.toThrow(
      /schema 2/,
    );
    expect(JSON.parse(await fs.readFile(file, 'utf8')).schemaVersion).toBe(2);
  });
});

describe('install: from a bundled pack or a local folder, verified by digest', () => {
  test('an industry variant asks before installing the weekly brief it needs, then installs both in order', async () => {
    const { packs } = await setup();
    await expect(
      packs.install({ kind: 'bundled', packId: 'diomedes.industry.carpentry' }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: 'needs-dependencies', dependencies: [{ id: 'diomedes.weekly-brief' }] },
    });
    await packs.install(
      { kind: 'bundled', packId: 'diomedes.industry.carpentry' },
      { includeDependencies: true },
    );
    expect((await packs.installed()).map((p) => p.id)).toContain('diomedes.weekly-brief');
    expect(await phases(packs, 'install')).toEqual([
      'install:started:diomedes.software-engineering',
      'install:completed:diomedes.software-engineering',
      'install:started:diomedes.small-business',
      'install:completed:diomedes.small-business',
      'install:refused:diomedes.industry.carpentry',
      'install:started:diomedes.weekly-brief',
      'install:completed:diomedes.weekly-brief',
      'install:started:diomedes.industry.carpentry',
      'install:completed:diomedes.industry.carpentry',
    ]);
  });

  test('a local folder installs once its files and digest verify', async () => {
    const { packs } = await setup();
    const { folder, manifest } = await localPack('book-1');
    const preview = await packs.inspect({ kind: 'directory', path: folder });
    expect(preview.manifest.digest).toBe(manifest.digest);
    expect(preview.plan).toEqual({ ok: true, alsoInstalls: [] });
    expect(await packs.isInstalled('acme.bookkeeping')).toBe(false);

    await packs.install({ kind: 'directory', path: folder });
    const view = (await packs.installed()).find((p) => p.id === 'acme.bookkeeping')!;
    expect(view.current).toBe('1.0.0');
    expect(view.runtime).toBe('declared');
    expect(view.versions[0]).toMatchObject({ source: 'directory', sourcePath: folder, digest: manifest.digest });
  });

  test.each<[string, (folder: string) => Promise<void>, RegExp]>([
    [
      'a payload file changed after sealing',
      (folder) => fs.writeFile(path.join(folder, 'playbooks/close.md'), '# Month-end clos!\n'),
      /does not match the sha/,
    ],
    [
      'a manifest edited after sealing',
      async (folder) => {
        const file = path.join(folder, PACK_MANIFEST_FILE);
        const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as PackManifest;
        manifest.permissions.requested.push({ capability: 'read-bank', reason: 'Also the bank.' });
        await fs.writeFile(file, JSON.stringify(manifest));
      },
      /digest does not match its contents/,
    ],
    [
      'a listed file that is missing',
      (folder) => fs.rm(path.join(folder, 'playbooks/close.md')),
      /not in the folder/,
    ],
    [
      'a manifest schema this build does not read',
      async (folder) => {
        const file = path.join(folder, PACK_MANIFEST_FILE);
        const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
        await fs.writeFile(file, JSON.stringify({ ...manifest, schemaVersion: 9 }));
      },
      /manifest schema 9/,
    ],
  ])('refuses %s, records the refusal and installs nothing', async (_label, spoil, message) => {
    const { packs, store } = await setup();
    const { folder } = await localPack('spoiled');
    await spoil(folder);
    await expect(packs.install({ kind: 'directory', path: folder })).rejects.toThrow(message);
    expect(await packs.isInstalled('acme.bookkeeping')).toBe(false);
    expect((await phases(packs, 'install')).at(-1)).toMatch(/^install:refused:/);
    const objects = await fs.readdir(path.join(store.dataDir, 'packs', 'objects'));
    expect(objects.sort()).toEqual(['diomedes.small-business', 'diomedes.software-engineering']);
  });

  test('a local folder cannot claim the diomedes publisher or namespace', async () => {
    const { packs } = await setup();
    const { folder } = await localPack('impostor', { id: 'diomedes.software-engineering', version: '9.0.0' });
    await expect(packs.install({ kind: 'directory', path: folder })).rejects.toThrow(/reserved/);
  });

  test('a local pack that needs something not installed is refused as missing', async () => {
    const { packs } = await setup();
    const { folder } = await localPack('needy', {
      dependencies: [{ id: 'acme.ledger', range: '^1.0.0' }],
    });
    await expect(packs.install({ kind: 'directory', path: folder })).rejects.toMatchObject({
      details: { code: 'missing' },
      message: expect.stringContaining('acme.ledger is not available'),
    });
  });
});

describe('activation is per project, on demand, and never authorization', () => {
  test('contributions load only in the project that turned the pack on', async () => {
    const { packs, one, other } = await setup();
    const { folder } = await localPack('book');
    await packs.install({ kind: 'directory', path: folder });
    expect(await packs.loadedContributions(one)).toEqual([]);
    await packs.activate(one, 'acme.bookkeeping');
    const loaded = await packs.loadedContributions(one);
    expect(loaded.map((p) => [p.id, p.runtime])).toEqual([['acme.bookkeeping', 'declared']]);
    expect(loaded[0].contributions.workflows[0].id).toBe('month-end-close');
    expect(await packs.loadedContributions(other)).toEqual([]);
  });

  test('turning packs on and off changes no grant, Need, thread permission, task or setting', async () => {
    const { store, packs, one } = await setup();
    await packs.install(
      { kind: 'bundled', packId: 'diomedes.industry.restaurant-operations' },
      { includeDependencies: true },
    );
    const before = authority(store.state(one));
    const settings = structuredClone(store.settings);
    await packs.activate(one, 'diomedes.software-engineering');
    await packs.activate(one, 'diomedes.industry.restaurant-operations', { includeDependencies: true });
    await packs.deactivate(one, 'diomedes.industry.restaurant-operations');
    await packs.deactivate(one, 'diomedes.weekly-brief');
    expect(authority(store.state(one))).toEqual(before);
    expect(store.settings).toEqual(settings);
    expect(store.scopeGrants.view(one)).toEqual([]);
  });

  test('the Software Engineering pack behaves as before when turned on through the lifecycle', async () => {
    const { store, packs, one } = await setup();
    await packs.activate(one, 'diomedes.software-engineering');
    const state = store.state(one);
    expect(isPackActive(state.project.packs, 'diomedes.software-engineering')).toBe(true);
    expect(state.instructionFiles?.map((r) => [r.path, r.state])).toEqual([['AGENTS.md', 'loaded']]);
    expect(state.history.at(-1)?.sentence).toBe(
      'You turned on Software Engineering for this project. It adds no permission.',
    );
  });

  test('a pack whose dependency is off asks first, then turns both on in order', async () => {
    const { store, packs, one } = await setup();
    await packs.install(
      { kind: 'bundled', packId: 'diomedes.industry.carpentry' },
      { includeDependencies: true },
    );
    await expect(packs.activate(one, 'diomedes.industry.carpentry')).rejects.toMatchObject({
      details: { code: 'needs-dependencies', dependencies: [{ id: 'diomedes.weekly-brief' }] },
    });
    await packs.activate(one, 'diomedes.industry.carpentry', { includeDependencies: true });
    expect(store.state(one).project.packs!.map((a) => a.packId)).toEqual([
      'diomedes.weekly-brief',
      'diomedes.industry.carpentry',
    ]);
  });

  test('turning off a pack another active pack depends on is refused with the reason', async () => {
    const { packs, one } = await setup();
    await packs.install(
      { kind: 'bundled', packId: 'diomedes.industry.carpentry' },
      { includeDependencies: true },
    );
    await packs.activate(one, 'diomedes.industry.carpentry', { includeDependencies: true });
    await expect(packs.deactivate(one, 'diomedes.weekly-brief')).rejects.toMatchObject({
      status: 409,
      details: { code: 'in-use', dependents: [{ id: 'diomedes.industry.carpentry' }] },
      message: expect.stringContaining('Carpentry and cabinetry is on in this project and depends on Weekly brief'),
    });
  });

  test('a pack that is not installed cannot be turned on', async () => {
    const { packs, one } = await setup();
    await expect(packs.activate(one, 'diomedes.weekly-brief')).rejects.toMatchObject({
      details: { code: 'not-installed' },
    });
  });
});

describe('update, rollback and uninstall', () => {
  test('update keeps the old version, rollback returns to it, and each is History where the pack is on', async () => {
    const { store, packs, one, other } = await setup();
    const v1 = await localPack('v1');
    await packs.install({ kind: 'directory', path: v1.folder });
    await packs.activate(one, 'acme.bookkeeping');
    const v2 = await localPack('v2', { version: '1.1.0', description: 'Close, and a checklist.' });

    await packs.update('acme.bookkeeping', { kind: 'directory', path: v2.folder });
    let view = (await packs.installed()).find((p) => p.id === 'acme.bookkeeping')!;
    expect([view.current, view.rollbackTo, view.versions.map((v) => v.version)]).toEqual([
      '1.1.0',
      '1.0.0',
      ['1.0.0', '1.1.0'],
    ]);
    expect(store.state(one).history.at(-1)?.sentence).toBe(
      'You updated Bookkeeping from 1.0.0 to 1.1.0 while it was on in this project. It adds no permission.',
    );
    expect(store.state(other).history.some((e) => e.kind === 'pack')).toBe(false);

    await expect(packs.update('acme.bookkeeping', { kind: 'directory', path: v1.folder })).rejects.toMatchObject({
      details: { code: 'not-newer' },
    });

    await packs.rollback('acme.bookkeeping');
    view = (await packs.installed()).find((p) => p.id === 'acme.bookkeeping')!;
    expect([view.current, view.rollbackTo]).toEqual(['1.0.0', null]);
    expect((await packs.loadedContributions(one))[0].version).toBe('1.0.0');
    expect(store.state(one).history.at(-1)?.sentence).toMatch(/rolled Bookkeeping back from 1\.1\.0 to 1\.0\.0/);
    await expect(packs.rollback('acme.bookkeeping')).rejects.toMatchObject({ details: { code: 'no-previous' } });
  });

  test('an update that breaks an installed dependent range is refused as a version conflict', async () => {
    const { packs } = await setup();
    const lib = await localPack('lib', { id: 'acme.ledger', name: 'Ledger' });
    await packs.install({ kind: 'directory', path: lib.folder });
    const app = await localPack('app', { dependencies: [{ id: 'acme.ledger', range: '^1.0.0' }] });
    await packs.install({ kind: 'directory', path: app.folder });
    const lib2 = await localPack('lib2', { id: 'acme.ledger', name: 'Ledger', version: '2.0.0' });
    await expect(packs.update('acme.ledger', { kind: 'directory', path: lib2.folder })).rejects.toMatchObject({
      details: { code: 'version-conflict' },
      message: expect.stringContaining('Bookkeeping needs acme.ledger ^1.0.0, which 2.0.0 does not satisfy'),
    });
    await expect(packs.uninstall('acme.ledger')).rejects.toMatchObject({
      details: { code: 'in-use', dependents: [{ id: 'acme.bookkeeping' }] },
    });
  });

  test('uninstall refuses while a project uses the pack, then removes it and keeps every record', async () => {
    const { store, packs, one } = await setup();
    const { folder } = await localPack('book');
    await packs.install({ kind: 'directory', path: folder });
    await packs.activate(one, 'acme.bookkeeping');
    await expect(packs.uninstall('acme.bookkeeping')).rejects.toMatchObject({
      details: { code: 'in-use', projects: [{ id: one, name: 'Kitchen' }] },
    });
    await packs.deactivate(one, 'acme.bookkeeping');
    const before = await packs.operations();
    const history = store.state(one).history.length;
    await packs.uninstall('acme.bookkeeping');
    expect(await packs.isInstalled('acme.bookkeeping')).toBe(false);
    const after = await packs.operations();
    // Append-only: every earlier record is still there, byte for byte.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ kind: 'uninstall', phase: 'completed' });
    expect(store.state(one).history).toHaveLength(history);
    await expect(fs.readdir(path.join(store.dataDir, 'packs', 'objects', 'acme.bookkeeping'))).rejects.toThrow();
  });
});

describe('crash safety: half-installed never activates', () => {
  class Stop extends Error {}

  test.each<[PackFaultStep, boolean]>([
    ['staged', false],
    ['placed', false],
    ['committed', true],
  ])('stopping after %s leaves installed = %s, and the next open says so', async (step, installed) => {
    const { store, packs, one } = await setup((at) => {
      if (at === step && armed) throw new Stop(at);
    });
    let armed = false;
    await packs.installed();
    const { folder } = await localPack('book');
    armed = true;
    await expect(packs.install({ kind: 'directory', path: folder })).rejects.toBeInstanceOf(Stop);

    // A new process: same data directory, fresh lifecycle.
    const restarted = lifecycle(store);
    expect(await restarted.isInstalled('acme.bookkeeping')).toBe(installed);
    const ops = await phases(restarted, 'install');
    if (installed) expect(ops.at(-1)).toBe('install:completed:acme.bookkeeping');
    else {
      expect(ops.slice(-2)).toEqual([
        'install:started:acme.bookkeeping',
        'install:interrupted:acme.bookkeeping',
      ]);
      await expect(restarted.activate(one, 'acme.bookkeeping')).rejects.toMatchObject({
        details: { code: 'not-installed' },
      });
      expect(isPackActive(store.state(one).project.packs, 'acme.bookkeeping')).toBe(false);
      const objects = await fs.readdir(path.join(store.dataDir, 'packs', 'objects'));
      expect(objects).not.toContain('acme.bookkeeping');
    }
    await expect(fs.readdir(path.join(store.dataDir, 'packs', 'staging'))).rejects.toThrow();
    // Recovery appended; a second open appends nothing more.
    const count = (await restarted.operations()).length;
    expect((await lifecycle(store).operations()).length).toBe(count);
  });

  test('an installed pack whose files were altered on disk is reported damaged and will not turn on', async () => {
    const { store, packs, one } = await setup();
    const { folder } = await localPack('book');
    await packs.install({ kind: 'directory', path: folder });
    const root = path.join(store.dataDir, 'packs', 'objects', 'acme.bookkeeping');
    const [object] = await fs.readdir(root);
    const file = path.join(root, object, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as PackManifest;
    await fs.writeFile(file, JSON.stringify({ ...manifest, description: 'Quietly changed.' }));
    const reopened = lifecycle(store);
    const view = (await reopened.installed()).find((p) => p.id === 'acme.bookkeeping')!;
    expect(view.damaged).toMatch(/no longer match the digest/);
    await expect(reopened.activate(one, 'acme.bookkeeping')).rejects.toMatchObject({
      details: { code: 'damaged' },
    });
  });
});
