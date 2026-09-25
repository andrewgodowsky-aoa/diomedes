/**
 * The first launch of a new build (server/update-reconcile.ts).
 *
 * The upgrade test installs the state an older build leaves behind — its
 * settings, saved with one choice made through the real save path, and a
 * custom skin it applied — then launches the new build over it and checks
 * what a person would see: never-chosen values follow the new defaults, chosen
 * ones are kept, the effective theme is built from the new base, the reconcile
 * runs once and only once, a stop part way through recovers, and the record
 * is written.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaults, jsonWrite, Store } from '../server/store.js';
import {
  currentUpdateNotice,
  markUpdateNoticeSeen,
  noticeText,
  reconcileAfterUpdate,
  ReconcileInterrupted,
  RECONCILE_POLICY,
  updateRecords,
  type ApplyStep,
  type BuildStamp,
  type ProvenanceFile,
} from '../server/update-reconcile.js';
import { themeScopeKey } from '../server/themes.js';
import { packFromBaseTheme } from '../client/console/design-center/pack.js';
import { resolveAppearance } from '../shared/theme-pack/resolve.js';
import { BASE_STRUCTURE, withBaseStructure } from '../shared/appearance-structure.js';
import { createApp } from '../server/app.js';
import type { Settings } from '../shared/types.js';

const OLD: BuildStamp = { version: '0.1.11', buildId: '0.1.11+a492c42a5513' };
const NEW: BuildStamp = { version: '0.2.0', buildId: '0.2.0+0123456789ab' };

/** The older build's defaults: Field, as every build before Nectovia shipped. */
const oldDefaults = (): Settings => ({ ...defaults(), appearance: { package: 'field', motion: 'normal' } });
/** The new build's defaults: the real ones, plus a behaviour default that changed. */
const newDefaults = (): Settings => ({ ...defaults(), view: 'conversation' });

const SCOPE = themeScopeKey({ kind: 'personal' }, 'person-1');

let root: string;
let dataDir: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-update-reconcile-'));
  dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const readJson = async <T>(file: string) => JSON.parse(await fs.readFile(file, 'utf8')) as T;
const settingsOnDisk = () => readJson<Settings>(path.join(dataDir, 'settings.json'));
const provenance = () => readJson<ProvenanceFile>(path.join(dataDir, 'settings-provenance.json'));

/**
 * What the older build leaves behind: its first launch recorded, the person's
 * one choice (the technical detail level) saved through the Store, and a
 * custom skin built on Graphite with a business colour, a taller line height
 * and a denser layout applied.
 */
async function installOldBuild(options: { withSkin?: boolean } = {}) {
  await reconcileAfterUpdate({ dataDir, build: OLD, defaults: oldDefaults });
  const store = new Store(dataDir, path.join(root, 'projects'));
  await store.init();
  store.settings = oldDefaults();
  await store.saveSettings({ ...store.settings, detail: 'technical' });
  if (options.withSkin) {
    const pack = packFromBaseTheme('graphite', 'Harbour Cafe', 'harbour-cafe', 'Owner', '2026-09-01T00:00:00.000Z');
    pack.tokens.color.light = { $type: 'color', $value: '#ff8800' };
    pack.typography.lineHeight = 1.8;
    pack.geometry.density = 'guided';
    await jsonWrite(path.join(dataDir, 'themes', SCOPE, pack.id, 'pack.json'), pack);
    await store.saveSettings({
      ...store.settings,
      appearance: { ...store.settings.appearance, activeTheme: { id: pack.id, revision: 1, scope: SCOPE } },
    });
  }
  return store;
}

describe('the first launch of a new build', () => {
  test('moves never-chosen values, keeps chosen ones, rebuilds the theme from the new base, and records it', async () => {
    await installOldBuild({ withSkin: true });
    const before = await settingsOnDisk();
    expect(before.appearance.package).toBe('field');

    const outcome = await reconcileAfterUpdate({ dataDir, build: NEW, defaults: newDefaults });
    expect(outcome.ran).toBe(true);
    expect(outcome.settingsChanged).toBe(true);

    const after = await settingsOnDisk();
    // Never chosen: the scheme follows the new build's default. By id, never a copy.
    expect(after.appearance.package).toBe('nectovia');
    expect(typeof after.appearance.package).toBe('string');
    // Chosen through the save path: kept.
    expect(after.detail).toBe('technical');
    // The custom skin is the person's; its pointer is untouched.
    expect(after.appearance.activeTheme).toEqual({ id: 'harbour-cafe', revision: 1, scope: SCOPE });
    // A behaviour default is held until Andrew decides D2, and the hold is recorded.
    expect(after.view).toBe('architect');

    const record = outcome.record!;
    expect(record.kind).toBe('update');
    expect(record.from).toEqual({ version: OLD.version, buildId: OLD.buildId });
    expect(record.to).toEqual(NEW);
    expect(record.settings.moved).toEqual([{ path: 'appearance.package', from: 'field', to: 'nectovia' }]);
    expect(record.settings.held).toEqual([
      { path: 'view', value: 'architect', newDefault: 'conversation', reason: 'behaviour-default-held' },
    ]);
    expect(record.settings.kept).toContainEqual({ path: 'detail', value: 'technical', source: 'chosen' });
    expect(record.cache).toEqual({ cleared: false, detail: expect.stringMatching(/not running inside the desktop shell/) });
    // The skin's structural values are superseded by the new base, and named.
    expect(record.theme.scheme).toBe('nectovia');
    expect(record.theme.pack).toMatchObject({ id: 'harbour-cafe', readable: true, baseTheme: 'graphite' });
    expect(record.theme.superseded).toEqual([
      { output: '--dm-line-body', skinValue: '1.8', baseValue: '1.55' },
      { output: 'data:density', skinValue: 'guided', baseValue: 'standard' },
    ]);
    // The record and the settings backup are on disk.
    const onDisk = await updateRecords(dataDir);
    expect(onDisk.map((item) => item.id)).toEqual([record.id]);
    const backup = await fs.readFile(path.join(dataDir, record.settings.backup!), 'utf8');
    expect(JSON.parse(backup).appearance.package).toBe('field');
    expect((await readJson<{ app: BuildStamp }>(path.join(dataDir, 'last-build.json'))).app).toEqual(NEW);

    // The effective theme: the business colour stays, and every structural
    // output comes from the running build's stylesheet, not the snapshot.
    const pack = await readJson<Parameters<typeof resolveAppearance>[0]['theme']>(
      path.join(dataDir, 'themes', SCOPE, 'harbour-cafe', 'pack.json'),
    );
    const effective = withBaseStructure(resolveAppearance({ surface: 'app-console', theme: pack })).resolved;
    expect(effective.vars['--light']).toBe('#ff8800');
    for (const output of Object.keys(BASE_STRUCTURE)) {
      if (output.startsWith('data:')) expect(effective.dataset[output.slice(5)]).toBeUndefined();
      else expect(effective.vars[output]).toBeUndefined();
    }

    // Said once, in one line.
    expect(noticeText(record)).toBe('Updated to 0.2.0: 1 setting moved to new defaults.');
    expect(await currentUpdateNotice(dataDir)).toMatchObject({ id: record.id, version: '0.2.0', moved: 1 });
    await markUpdateNoticeSeen(dataDir, record.id);
    expect(await currentUpdateNotice(dataDir)).toBeNull();
  });

  test('a restart of the same build does not run it again', async () => {
    await installOldBuild();
    const first = await reconcileAfterUpdate({ dataDir, build: NEW, defaults: newDefaults });
    expect(first.ran).toBe(true);
    const settingsBytes = await fs.readFile(path.join(dataDir, 'settings.json'));
    const provenanceBytes = await fs.readFile(path.join(dataDir, 'settings-provenance.json'));

    const second = await reconcileAfterUpdate({ dataDir, build: NEW, defaults: newDefaults });
    expect(second).toEqual({ ran: false, resumed: false, record: null, settingsChanged: false });
    expect((await fs.readFile(path.join(dataDir, 'settings.json'))).equals(settingsBytes)).toBe(true);
    expect((await fs.readFile(path.join(dataDir, 'settings-provenance.json'))).equals(provenanceBytes)).toBe(true);
    expect(await updateRecords(dataDir)).toHaveLength(1);
  });

  test.each<ApplyStep>(['journal', 'cache', 'backup', 'settings', 'provenance', 'record', 'build'])(
    'a stop after the %s step is finished by the next launch, exactly once',
    async (step) => {
      await installOldBuild({ withSkin: true });
      let cleared = 0;
      const clearRendererCache = async () => {
        cleared += 1;
      };
      await expect(
        reconcileAfterUpdate({ dataDir, build: NEW, defaults: newDefaults, clearRendererCache, interruptAfter: step }),
      ).rejects.toBeInstanceOf(ReconcileInterrupted);

      const resumed = await reconcileAfterUpdate({ dataDir, build: NEW, defaults: newDefaults, clearRendererCache });
      expect(resumed.ran).toBe(true);
      expect(resumed.resumed).toBe(true);
      expect(cleared).toBeGreaterThanOrEqual(1);

      const after = await settingsOnDisk();
      expect(after.appearance.package).toBe('nectovia');
      expect(after.detail).toBe('technical');
      // The half-applied state was not mistaken for a person's choice.
      expect((await provenance()).fields['appearance.package']).toMatchObject({ source: 'default', value: 'nectovia' });
      const records = await updateRecords(dataDir);
      expect(records).toHaveLength(1);
      expect(records[0].settings.moved).toEqual([{ path: 'appearance.package', from: 'field', to: 'nectovia' }]);
      await expect(fs.access(path.join(dataDir, 'update-reconcile', 'pending.json'))).rejects.toThrow();

      // And the launch after that does nothing.
      expect((await reconcileAfterUpdate({ dataDir, build: NEW, defaults: newDefaults })).ran).toBe(false);
    },
  );

  test('a plan made stale by a later settings write is kept as evidence and never applied', async () => {
    await installOldBuild();
    await expect(
      reconcileAfterUpdate({ dataDir, build: NEW, defaults: newDefaults, interruptAfter: 'journal' }),
    ).rejects.toBeInstanceOf(ReconcileInterrupted);
    // An older build launched in between, and the person chose Paper there.
    const stored = await settingsOnDisk();
    await jsonWrite(path.join(dataDir, 'settings.json'), { ...stored, appearance: { ...stored.appearance, package: 'paper' } });

    const outcome = await reconcileAfterUpdate({ dataDir, build: NEW, defaults: newDefaults });
    expect(outcome.resumed).toBe(false);
    expect((await settingsOnDisk()).appearance.package).toBe('paper');
    expect((await provenance()).fields['appearance.package']).toMatchObject({ source: 'chosen', inferred: true });
    const names = await fs.readdir(path.join(dataDir, 'update-reconcile', 'records'));
    expect(names.filter((name) => name.endsWith('.abandoned.json'))).toHaveLength(1);
  });

  test('a desktop cache clear is part of the run and is recorded', async () => {
    await installOldBuild();
    let cleared = 0;
    const outcome = await reconcileAfterUpdate({
      dataDir,
      build: NEW,
      defaults: newDefaults,
      clearRendererCache: async () => {
        cleared += 1;
      },
    });
    expect(cleared).toBe(1);
    expect(outcome.record!.cache).toMatchObject({ cleared: true });
  });

  test('behaviour defaults move too when the policy says so (D2)', async () => {
    await installOldBuild();
    const outcome = await reconcileAfterUpdate({
      dataDir,
      build: NEW,
      defaults: newDefaults,
      policy: { ...RECONCILE_POLICY, behaviourFollowsDefaults: true },
    });
    expect((await settingsOnDisk()).view).toBe('conversation');
    expect(outcome.record!.settings.moved.map((entry) => entry.path)).toEqual(['appearance.package', 'view']);
  });

  test('a fresh install records its build and says nothing', async () => {
    const outcome = await reconcileAfterUpdate({ dataDir, build: NEW });
    expect(outcome).toEqual({ ran: true, resumed: false, record: null, settingsChanged: false });
    await expect(fs.access(path.join(dataDir, 'settings.json'))).rejects.toThrow();
    expect((await provenance()).fields['appearance.package']).toMatchObject({ source: 'default', value: 'nectovia' });
    expect(await currentUpdateNotice(dataDir)).toBeNull();
  });

  test('a newer settings file is refused and left as it was', async () => {
    const file = path.join(dataDir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ ...defaults(), version: 9 }));
    const bytes = await fs.readFile(file);
    await expect(reconcileAfterUpdate({ dataDir, build: NEW })).rejects.toThrow(/newer Diomedes/);
    expect((await fs.readFile(file)).equals(bytes)).toBe(true);
  });
});

describe('an install from before provenance existed', () => {
  /** What 0.1.11 leaves: a settings file and the shell's startup record, nothing else. */
  async function legacyInstall(overrides: Partial<Settings> = {}) {
    await jsonWrite(path.join(dataDir, 'settings.json'), { ...oldDefaults(), ...overrides });
    await jsonWrite(path.join(dataDir, 'desktop-startup.json'), { version: '0.1.11', packaged: true });
  }

  test('keeps every stored value, because nothing says it was not chosen (D1)', async () => {
    await legacyInstall();
    const bytes = await fs.readFile(path.join(dataDir, 'settings.json'));
    const outcome = await reconcileAfterUpdate({ dataDir, build: NEW });
    expect(outcome.settingsChanged).toBe(false);
    expect((await fs.readFile(path.join(dataDir, 'settings.json'))).equals(bytes)).toBe(true);
    const record = outcome.record!;
    expect(record.kind).toBe('update');
    expect(record.from).toEqual({ version: '0.1.11', buildId: null });
    expect(record.settings.schemaFrom).toBe(1);
    expect(record.settings.moved).toEqual([]);
    expect(record.settings.kept).toContainEqual({ path: 'appearance.package', value: 'field', source: 'unknown' });
    expect(noticeText(record)).toBe('Updated to 0.2.0.');
  });

  test('moves a legacy default when the policy names it as one (D1 answered yes)', async () => {
    await legacyInstall({ detail: 'technical' });
    const outcome = await reconcileAfterUpdate({
      dataDir,
      build: NEW,
      policy: { ...RECONCILE_POLICY, legacyDefaults: { 'appearance.package': ['field'] } },
    });
    expect((await settingsOnDisk()).appearance.package).toBe('nectovia');
    expect((await settingsOnDisk()).detail).toBe('technical');
    expect(outcome.record!.settings.moved).toEqual([{ path: 'appearance.package', from: 'field', to: 'nectovia' }]);
  });

  test('a settings folder with no known history gains provenance quietly', async () => {
    await jsonWrite(path.join(dataDir, 'settings.json'), oldDefaults());
    const outcome = await reconcileAfterUpdate({ dataDir, build: NEW });
    expect(outcome.record!.kind).toBe('schema');
    expect(await currentUpdateNotice(dataDir)).toBeNull();
  });
});

describe('a choice made after the update', () => {
  test('is kept by the next update even when it equals the default it replaced', async () => {
    await installOldBuild();
    await reconcileAfterUpdate({ dataDir, build: NEW, defaults: newDefaults });
    const store = new Store(dataDir, path.join(root, 'projects'));
    await store.init();
    // The person tries Field, then goes back to Nectovia on purpose.
    await store.saveSettings({ ...store.settings, appearance: { ...store.settings.appearance, package: 'field' } });
    await store.saveSettings({ ...store.settings, appearance: { ...store.settings.appearance, package: 'nectovia' } });
    expect((await provenance()).fields['appearance.package']).toMatchObject({ source: 'chosen' });

    const later: BuildStamp = { version: '0.3.0', buildId: '0.3.0+fedcba987654' };
    const outcome = await reconcileAfterUpdate({
      dataDir,
      build: later,
      defaults: () => ({ ...newDefaults(), appearance: { package: 'paper', motion: 'normal' } }),
    });
    expect((await settingsOnDisk()).appearance.package).toBe('nectovia');
    expect(outcome.record!.settings.moved).toEqual([]);
  });
});

describe('createApp', () => {
  test('reconciles before the first request and serves the one-line notice', async () => {
    await installOldBuild();
    const app = await createApp({
      dataDir,
      projectRoot: path.join(root, 'projects'),
      updateReconcile: { build: NEW },
      automationTickMs: null,
    });
    try {
      const notice = await currentUpdateNotice(dataDir);
      expect(notice?.text).toBe('Updated to 0.2.0: 1 setting moved to new defaults.');
    } finally {
      await app.locals.close();
    }
  });
});

describe('the structural outputs', () => {
  test('mirror what the base stylesheet declares, so taking them back shows the base', async () => {
    const css = await fs.readFile(path.resolve('client', 'styles.css'), 'utf8');
    const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
    for (const [output, value] of Object.entries(BASE_STRUCTURE)) {
      if (output.startsWith('data:')) continue;
      expect(root, output).toContain(`${output}: ${value};`);
    }
    // No `html[data-density]` rule applies to `standard`: absent is the base.
    expect(BASE_STRUCTURE['data:density']).toBe('standard');
    expect(css).not.toMatch(/html\[data-density='standard'\]/);
  });

  test('only a skin value that differs from the base is reported as superseded', () => {
    const pack = packFromBaseTheme('field', 'Plain', 'plain-skin', 'Owner', '2026-09-01T00:00:00.000Z');
    const plain = withBaseStructure(resolveAppearance({ theme: pack }));
    expect(plain.superseded).toEqual([]);
    expect(plain.resolved.vars['--dm-line-body']).toBeUndefined();
    expect(plain.resolved.vars['--surface']).toBe(pack.tokens.color.surface.$value);
  });
});
