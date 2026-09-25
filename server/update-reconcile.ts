/**
 * The first launch of a new build (docs/research/2026-09-25-skin-layering-and-update-refresh.md,
 * Phase 1).
 *
 * An update replaces the code and carries the data folder forward. Before this,
 * nothing compared the build that last ran with the build running now, so a
 * value the person never chose stayed at whatever an older build defaulted it
 * to, and an upgraded install could not look like a fresh one.
 *
 * On the first launch of a build whose id differs from the one recorded, this:
 *
 *   1. clears the renderer's HTTP and code caches (the shell supplies how; storage is kept);
 *   2. carries the settings schema forward through ordered, versioned steps;
 *   3. moves every tracked setting the person never chose to the new build's
 *      default, and keeps every one they did choose;
 *   4. re-derives the effective theme: a built-in scheme is an id, so the new
 *      build's scheme is the one shown; a custom skin keeps its colours, and the
 *      structural outputs it pinned come from the new base instead
 *      (`shared/appearance-structure.ts`), each one recorded;
 *   5. writes an append-only record of what changed (decision 10), and
 *   6. records the build, last, so an interrupted run is simply run again.
 *
 * Crash safety. The whole plan is computed first, from the files as they are,
 * and written to a journal. Applying it is a fixed sequence of whole-file
 * writes, each of which is the same when repeated, and the journal is removed
 * only after the build is recorded. A stop anywhere in between leaves the
 * journal, and the next launch finishes that plan instead of computing a new
 * one from half-applied files.
 *
 * What never moves. Permissions are authority, and a configuration change never
 * grants one ("Trust and permission boundaries", AGENTS.md), so no permission is
 * tracked here. Pointers the server alone writes (workspace, home), state rather
 * than preference (onboarding progress, `seen`, open projects) and the custom
 * theme pointer are not tracked either.
 *
 * Settings provenance lives beside `settings.json`, not in it, so a build from
 * before this one can still read and save its settings after a downgrade: its
 * `validateSettings` refuses keys it does not know, and the client echoes the
 * whole object back.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { absent } from './paths.js';
import { defaults as settingsDefaults, durableWrite, jsonWrite, migrateSettings } from './store.js';
import { assertReadable, MigrationRefusal } from './migrations/framework.js';
import { LAST_BUILD, SETTINGS, SETTINGS_PROVENANCE, UPDATE_RECORD } from './migrations/registry.js';
import { validateThemePack } from '../shared/theme-pack/validate.js';
import { resolveAppearance } from '../shared/theme-pack/resolve.js';
import { withBaseStructure, type SupersededOutput } from '../shared/appearance-structure.js';
import type { Settings } from '../shared/types.js';

// ---------------------------------------------------------------------------
// What is tracked, and the open decisions that shape it
// ---------------------------------------------------------------------------

export interface BuildStamp {
  version: string;
  buildId: string;
}

export type SettingKind = 'visual' | 'behaviour';

/**
 * Every setting whose origin is tracked. `visual` settings follow a new default
 * when never chosen; `behaviour` settings do only when the policy says so.
 */
export const TRACKED_SETTINGS: readonly { path: string; kind: SettingKind }[] = [
  { path: 'appearance.package', kind: 'visual' },
  { path: 'appearance.motion', kind: 'visual' },
  { path: 'view', kind: 'behaviour' },
  { path: 'detail', kind: 'behaviour' },
  { path: 'explanations', kind: 'behaviour' },
];

export interface ReconcilePolicy {
  /**
   * D2: whether a behaviour default (the view, the detail level, explanations)
   * follows a new build's default when the person never chose it. Off: only
   * visual defaults move, and a held behaviour default is recorded.
   */
  behaviourFollowsDefaults: boolean;
  /**
   * D1: for a settings file written before provenance existed, which stored
   * values count as "an older build's default" rather than a choice. Empty: a
   * value in such a file is kept, whatever it is, because nothing in the file
   * says it was not chosen. `{ 'appearance.package': ['field'] }` would move
   * every pre-Nectovia profile still on Field.
   */
  legacyDefaults: Readonly<Record<string, readonly unknown[]>>;
}

/** The conservative answers, until Andrew decides D1 and D2. */
export const RECONCILE_POLICY: ReconcilePolicy = Object.freeze({
  behaviourFollowsDefaults: false,
  legacyDefaults: Object.freeze({}),
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const LAST_BUILD_FILE = 'last-build.json';
export const PROVENANCE_FILE = 'settings-provenance.json';
const RECONCILE_DIR = 'update-reconcile';
const JOURNAL_FILE = 'pending.json';
const RECORDS_DIR = 'records';
const BACKUPS_DIR = 'backups';
const SEEN_FILE = 'notices-seen.json';

const files = (dataDir: string) => {
  const dir = path.join(dataDir, RECONCILE_DIR);
  return {
    settings: path.join(dataDir, 'settings.json'),
    lastBuild: path.join(dataDir, LAST_BUILD_FILE),
    provenance: path.join(dataDir, PROVENANCE_FILE),
    dir,
    journal: path.join(dir, JOURNAL_FILE),
    records: path.join(dir, RECORDS_DIR),
    backups: path.join(dir, BACKUPS_DIR),
    seen: path.join(dir, SEEN_FILE),
  };
};

/** Where a setting came from. */
export type FieldOrigin =
  /** The build's default, and still the value it was given. */
  | { source: 'default'; value: unknown; since: string }
  /** The person set it. `inferred` when the value moved away from a recorded default untracked. */
  | { source: 'chosen'; at: string; inferred?: true }
  /** Found in a file written before provenance; kept, because nothing says it was not chosen. */
  | { source: 'unknown'; value: unknown; since: string };

export interface ProvenanceFile {
  version: 1;
  /** How far the settings schema steps below have carried this install. */
  settingsSchemaVersion: number;
  fields: Record<string, FieldOrigin>;
}

interface LastBuildFile {
  version: 1;
  app: BuildStamp;
  recordedAt: string;
}

export interface UpdateRecord {
  version: 1;
  id: string;
  /** `update` when the build changed; `schema` when only the settings schema moved on. */
  kind: 'update' | 'schema';
  from: { version: string | null; buildId: string | null };
  to: BuildStamp;
  at: string;
  settings: {
    schemaFrom: number;
    schemaTo: number;
    moved: { path: string; from: unknown; to: unknown }[];
    held: { path: string; value: unknown; newDefault: unknown; reason: 'behaviour-default-held' }[];
    kept: { path: string; value: unknown; source: 'chosen' | 'unknown' }[];
    /** The pre-reconcile settings file, kept byte for byte, when anything in it moved. */
    backup: string | null;
  };
  theme: {
    /** The built-in scheme, by id: never a copy of its values. */
    scheme: string | null;
    pack: { id: string; revision: number; scope: string | null; baseTheme: string | null; readable: boolean } | null;
    /** Structural outputs the custom skin carried that the new base now decides. */
    superseded: SupersededOutput[];
  };
  cache: { cleared: boolean; detail: string } | null;
  policy: ReconcilePolicy;
}

interface Journal {
  version: 1;
  record: UpdateRecord;
  /** sha256 of `settings.json` as planned from; null when there was none. */
  settingsBeforeSha: string | null;
  /** The settings to write, or null when nothing in the file moves. */
  settingsAfter: Record<string, unknown> | null;
  provenance: ProvenanceFile;
  lastBuild: LastBuildFile;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function read(object: unknown, dotted: string): unknown {
  let at: unknown = object;
  for (const part of dotted.split('.')) {
    if (!isRecord(at)) return undefined;
    at = at[part];
  }
  return at;
}
function write(object: Json, dotted: string, value: unknown) {
  const parts = dotted.split('.');
  let at = object;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(at[part])) at[part] = {};
    at = at[part] as Json;
  }
  at[parts[parts.length - 1]] = value;
}

async function readBytes(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}
async function readJsonFile(file: string): Promise<unknown> {
  const bytes = await readBytes(file);
  if (bytes === null) return null;
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

/** A file-name-safe id for a transition. */
const slug = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'unknown';

/** The settings as the Store would hold them in memory: missing keys filled, legacy shapes fixed. */
function normalised(raw: Json | null, defaults: Settings): Settings {
  const fill = (target: Json, source: Json) => {
    for (const [key, value] of Object.entries(source)) {
      // A switch that is absent is a switch that is off; filling one in would
      // be a claim the person never made.
      if (key === 'services') continue;
      if (!(key in target)) target[key] = structuredClone(value);
      else if (isRecord(target[key]) && isRecord(value)) fill(target[key] as Json, value);
    }
  };
  const copy = raw ? (structuredClone(raw) as Json) : (structuredClone(defaults) as unknown as Json);
  fill(copy, defaults as unknown as Json);
  migrateSettings(copy as unknown as Settings);
  return copy as unknown as Settings;
}

// ---------------------------------------------------------------------------
// Settings schema steps
// ---------------------------------------------------------------------------

/** The settings schema this build carries an install to. */
export const SETTINGS_SCHEMA_VERSION = 2;

interface StepContext {
  settings: Settings | null;
  fields: Record<string, FieldOrigin>;
  defaults: Settings;
  policy: ReconcilePolicy;
  build: string;
}

/**
 * `SETTINGS_STEPS[n]` carries an install from settings schema n to n + 1.
 * Every step must be safe to run again over its own output.
 *
 * Version 1 is every install before provenance, including the in-place
 * normalisations `migrateSettings` still performs on every load.
 */
export const SETTINGS_STEPS: Readonly<Record<number, (context: StepContext) => void>> = {
  // 1 → 2: provenance begins. A fresh install holds only defaults. A value
  // already in an older file is kept as `unknown` unless the policy names it
  // as an older build's default (D1); a key the file lacks is a default.
  1: ({ settings, fields, defaults, policy, build }) => {
    for (const { path: key } of TRACKED_SETTINGS) {
      if (fields[key]) continue;
      const value = settings === null ? undefined : read(settings, key);
      if (value === undefined)
        fields[key] = { source: 'default', value: read(defaults, key), since: build };
      else if ((policy.legacyDefaults[key] ?? []).some((old) => same(old, value)))
        fields[key] = { source: 'default', value, since: 'legacy' };
      else fields[key] = { source: 'unknown', value, since: build };
    }
  },
};

// ---------------------------------------------------------------------------
// Reading the pieces
// ---------------------------------------------------------------------------

async function readProvenance(file: string): Promise<ProvenanceFile | null> {
  const value = await readJsonFile(file);
  if (value === null) return null;
  assertReadable(SETTINGS_PROVENANCE, value);
  const record = value as ProvenanceFile;
  if (!isRecord(record.fields) || !Number.isSafeInteger(record.settingsSchemaVersion))
    throw new MigrationRefusal('not-a-record', SETTINGS_PROVENANCE.id, null, 'The settings provenance is not readable.');
  return record;
}

async function readLastBuild(file: string): Promise<LastBuildFile | null> {
  const value = await readJsonFile(file);
  if (value === null) return null;
  assertReadable(LAST_BUILD, value);
  const record = value as LastBuildFile;
  if (!isRecord(record.app) || typeof record.app.buildId !== 'string') return null;
  return record;
}

/**
 * The version the previous launch reported, for an install that ran before
 * `last-build.json` existed. The desktop shell has written this on every launch
 * since 0.1.x, after the service started, so it still names the old build here.
 */
async function previousStartupVersion(dataDir: string): Promise<string | null> {
  try {
    const value = await readJsonFile(path.join(dataDir, 'desktop-startup.json'));
    const version = isRecord(value) ? value.version : null;
    return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** The custom skin in use, read as data and re-validated; and what the new base took back from it. */
async function themeFacts(dataDir: string, settings: Settings | null): Promise<UpdateRecord['theme']> {
  const scheme = settings?.appearance?.package ?? null;
  const pointer = settings?.appearance?.activeTheme ?? null;
  if (!pointer) return { scheme, pack: null, superseded: [] };
  const summary = {
    id: pointer.id,
    revision: pointer.revision,
    scope: pointer.scope ?? null,
    baseTheme: null as string | null,
    readable: false,
  };
  // A pointer without a scope predates scopes, and naming a folder for it
  // would be a guess. The client resolves it as it always has.
  if (!pointer.scope || !/^(personal|business)-[0-9a-f]{16}$/.test(pointer.scope) || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(pointer.id))
    return { scheme, pack: summary, superseded: [] };
  try {
    const pack = await readJsonFile(path.join(dataDir, 'themes', pointer.scope, pointer.id, 'pack.json'));
    const checked = validateThemePack(pack);
    if (!checked.ok) return { scheme, pack: summary, superseded: [] };
    const { superseded } = withBaseStructure(resolveAppearance({ surface: 'app-console', theme: checked.pack }));
    return {
      scheme,
      pack: { ...summary, revision: checked.pack.revision, baseTheme: checked.pack.baseTheme, readable: true },
      superseded,
    };
  } catch {
    return { scheme, pack: summary, superseded: [] };
  }
}

// ---------------------------------------------------------------------------
// Planning (reads only)
// ---------------------------------------------------------------------------

interface PlanInput {
  dataDir: string;
  build: BuildStamp;
  defaults: Settings;
  policy: ReconcilePolicy;
  at: string;
}

async function plan(input: PlanInput): Promise<Journal | { fresh: Journal } | null> {
  const where = files(input.dataDir);
  const [lastBuild, provenance, settingsBytes] = await Promise.all([
    readLastBuild(where.lastBuild),
    readProvenance(where.provenance),
    readBytes(where.settings),
  ]);
  const schemaFrom = provenance?.settingsSchemaVersion ?? 1;
  const buildChanged = lastBuild?.app.buildId !== input.build.buildId;
  if (!buildChanged && schemaFrom >= SETTINGS_SCHEMA_VERSION) return null;

  let raw: Json | null = null;
  if (settingsBytes !== null) {
    const parsed: unknown = JSON.parse(settingsBytes.toString('utf8'));
    // A newer settings file is refused here exactly as the Store refuses it.
    assertReadable(SETTINGS, parsed);
    raw = parsed as Json;
  }
  const current = raw === null ? null : normalised(raw, input.defaults);
  const fields: Record<string, FieldOrigin> = structuredClone(provenance?.fields ?? {});
  for (let version = schemaFrom; version < SETTINGS_SCHEMA_VERSION; version++) {
    const step = SETTINGS_STEPS[version];
    if (!step) throw new Error(`No settings step from schema ${version}.`);
    step({ settings: current, fields, defaults: input.defaults, policy: input.policy, build: input.build.buildId });
  }

  const moved: UpdateRecord['settings']['moved'] = [];
  const held: UpdateRecord['settings']['held'] = [];
  const kept: UpdateRecord['settings']['kept'] = [];
  const after: Json | null = raw === null ? null : (structuredClone(raw) as Json);
  for (const { path: key, kind } of TRACKED_SETTINGS) {
    const origin = fields[key];
    const newDefault = read(input.defaults, key);
    if (!origin) continue;
    // No settings file: the Store already holds this build's defaults, so
    // there is nothing stored to move and nothing anyone chose.
    if (current === null) {
      fields[key] = { source: 'default', value: newDefault, since: input.build.buildId };
      continue;
    }
    const value = read(current, key);
    if (origin.source === 'chosen') {
      kept.push({ path: key, value, source: 'chosen' });
      continue;
    }
    if (origin.source === 'unknown') {
      // D1 may later name this value as an older default; until then it is kept.
      if ((input.policy.legacyDefaults[key] ?? []).some((old) => same(old, value)))
        fields[key] = { source: 'default', value, since: 'legacy' };
      else {
        fields[key] = { ...origin, value };
        kept.push({ path: key, value, source: 'unknown' });
        continue;
      }
    }
    const recorded = fields[key] as Extract<FieldOrigin, { source: 'default' }>;
    // The value left its recorded default without passing through a tracked
    // save (a crash between two writes, an older build): someone chose it.
    if (!same(value, recorded.value)) {
      fields[key] = { source: 'chosen', at: input.at, inferred: true };
      kept.push({ path: key, value, source: 'chosen' });
      continue;
    }
    if (same(value, newDefault)) {
      fields[key] = { source: 'default', value, since: recorded.since };
      continue;
    }
    if (kind === 'behaviour' && !input.policy.behaviourFollowsDefaults) {
      held.push({ path: key, value, newDefault, reason: 'behaviour-default-held' });
      continue;
    }
    moved.push({ path: key, from: value, to: newDefault });
    fields[key] = { source: 'default', value: newDefault, since: input.build.buildId };
    // A key the file never had is already the new default in memory; only a
    // stored value has to be rewritten.
    if (after !== null && read(raw, key) !== undefined) write(after, key, structuredClone(newDefault));
    write(current as unknown as Json, key, structuredClone(newDefault));
  }

  const provenanceAfter: ProvenanceFile = { version: 1, settingsSchemaVersion: SETTINGS_SCHEMA_VERSION, fields };
  const lastBuildAfter: LastBuildFile = { version: 1, app: { ...input.build }, recordedAt: input.at };
  const settingsWrites = after !== null && moved.some((entry) => read(raw, entry.path) !== undefined);

  const fromVersion = lastBuild?.app.version ?? (await previousStartupVersion(input.dataDir));
  // An update is a build replacing a build this install is known to have run:
  // one recorded here, or one the desktop shell reported at its last launch.
  // A settings file with neither (a fixture, a hand-made folder) gains its
  // provenance quietly.
  const kind: UpdateRecord['kind'] = buildChanged && (lastBuild !== null || fromVersion !== null) ? 'update' : 'schema';
  const id = await freshRecordId(
    where.records,
    `${input.at.slice(0, 10)}-${slug(lastBuild?.app.buildId ?? fromVersion ?? 'unrecorded')}-to-${slug(input.build.buildId)}`,
  );
  const record: UpdateRecord = {
    version: 1,
    id,
    kind,
    from: { version: fromVersion, buildId: lastBuild?.app.buildId ?? null },
    to: { ...input.build },
    at: input.at,
    settings: {
      schemaFrom,
      schemaTo: SETTINGS_SCHEMA_VERSION,
      moved,
      held,
      kept,
      backup: settingsWrites ? path.posix.join(RECONCILE_DIR, BACKUPS_DIR, `settings-${id}.json`) : null,
    },
    theme: await themeFacts(input.dataDir, current),
    cache: null,
    policy: input.policy,
  };
  const journal: Journal = {
    version: 1,
    record,
    settingsBeforeSha: settingsBytes === null ? null : sha(settingsBytes),
    settingsAfter: settingsWrites ? after : null,
    provenance: provenanceAfter,
    lastBuild: lastBuildAfter,
  };
  // No settings file and no build recorded: a fresh install. Nothing changed
  // for anyone, so there is nothing to record and nothing to say.
  if (settingsBytes === null && lastBuild === null) return { fresh: journal };
  return journal;
}

async function freshRecordId(dir: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if ((await readBytes(path.join(dir, `${id}.json`))) === null) return id;
  }
}

// ---------------------------------------------------------------------------
// Applying (every step the same when repeated)
// ---------------------------------------------------------------------------

export type ApplyStep = 'journal' | 'cache' | 'backup' | 'settings' | 'provenance' | 'record' | 'build';

/** Write `bytes` to `file` unless it already holds exactly them; refuse to replace anything else. */
async function writeOnce(file: string, bytes: string) {
  const existing = await readBytes(file);
  if (existing !== null) {
    if (existing.equals(Buffer.from(bytes))) return;
    throw new Error(`${path.basename(file)} already exists with different contents; an update record is never rewritten.`);
  }
  await durableWrite(file, bytes);
}

const recordBytes = (record: UpdateRecord) => JSON.stringify(record, null, 2);

async function apply(
  dataDir: string,
  journal: Journal,
  options: { clearRendererCache?: () => Promise<void>; interruptAfter?: ApplyStep; settingsBytesAtStart: Buffer | null },
): Promise<UpdateRecord> {
  const where = files(dataDir);
  const stop = (step: ApplyStep) => {
    if (options.interruptAfter === step) throw new ReconcileInterrupted(step);
  };
  stop('journal');

  let cache: UpdateRecord['cache'] = null;
  if (options.clearRendererCache) {
    try {
      await options.clearRendererCache();
      cache = { cleared: true, detail: 'The renderer HTTP and code caches were cleared. Storage was kept.' };
    } catch (error) {
      cache = { cleared: false, detail: `The renderer cache could not be cleared: ${error instanceof Error ? error.message : String(error)}` };
    }
  } else cache = { cleared: false, detail: 'No renderer cache: this service is not running inside the desktop shell.' };
  stop('cache');

  if (journal.settingsAfter !== null && journal.record.settings.backup && options.settingsBytesAtStart !== null) {
    await writeOnce(path.join(dataDir, journal.record.settings.backup), options.settingsBytesAtStart.toString('utf8'));
  }
  stop('backup');

  if (journal.settingsAfter !== null) await jsonWrite(where.settings, journal.settingsAfter);
  stop('settings');

  await jsonWrite(where.provenance, journal.provenance);
  stop('provenance');

  const record = { ...journal.record, cache };
  await writeOnce(path.join(where.records, `${record.id}.json`), recordBytes(record)).catch(async (error) => {
    // A resumed run cleared the cache again, so its cache line can differ from
    // the one the interrupted run already wrote. The first write stands.
    const existing = await readJsonFile(path.join(where.records, `${record.id}.json`));
    if (isRecord(existing) && existing.id === record.id) return;
    throw error;
  });
  stop('record');

  await jsonWrite(where.lastBuild, journal.lastBuild);
  stop('build');
  await fs.rm(where.journal, { force: true });
  return record;
}

export class ReconcileInterrupted extends Error {
  constructor(readonly step: ApplyStep) {
    super(`Reconcile interrupted after ${step} (test hook).`);
    this.name = 'ReconcileInterrupted';
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ReconcileInput {
  dataDir: string;
  build: BuildStamp;
  /** The running build's defaults. Tests pass an older or newer build's. */
  defaults?: () => Settings;
  policy?: ReconcilePolicy;
  /** The desktop shell's cache hygiene; absent outside Electron. */
  clearRendererCache?: () => Promise<void>;
  now?: () => string;
  /** Tests only: stop right after this step, as a crash would. */
  interruptAfter?: ApplyStep;
}

export interface ReconcileOutcome {
  /** True when this launch carried anything forward. */
  ran: boolean;
  /** True when it finished a plan an earlier launch started. */
  resumed: boolean;
  /** The record written, or null for a fresh install or a launch with nothing to do. */
  record: UpdateRecord | null;
  /** True when `settings.json` was rewritten, so the Store must read it again. */
  settingsChanged: boolean;
}

let running: Promise<unknown> = Promise.resolve();
/** One reconcile, or one provenance write, at a time in this process. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = running.then(work, work);
  running = next.catch(() => undefined);
  return next;
}

export function reconcileAfterUpdate(input: ReconcileInput): Promise<ReconcileOutcome> {
  return serial(() => reconcileNow(input));
}

async function reconcileNow(input: ReconcileInput): Promise<ReconcileOutcome> {
  const where = files(input.dataDir);
  const at = (input.now ?? (() => new Date().toISOString()))();
  const settingsBytesAtStart = await readBytes(where.settings);

  // An earlier launch stopped part way: finish its plan first, as long as the
  // settings are still what it planned from or already what it planned to write.
  const pending = (await readJsonFile(where.journal)) as Journal | null;
  if (pending !== null) {
    const currentSha = settingsBytesAtStart === null ? null : sha(settingsBytesAtStart);
    const afterSha = pending.settingsAfter === null ? null : sha(JSON.stringify(pending.settingsAfter, null, 2));
    const intact = currentSha === pending.settingsBeforeSha || (afterSha !== null && currentSha === afterSha);
    if (intact) {
      const backupBytes =
        pending.settingsAfter !== null && pending.record.settings.backup
          ? ((await readBytes(path.join(input.dataDir, pending.record.settings.backup))) ?? settingsBytesAtStart)
          : settingsBytesAtStart;
      const record = await apply(input.dataDir, pending, {
        clearRendererCache: input.clearRendererCache,
        interruptAfter: input.interruptAfter,
        settingsBytesAtStart: backupBytes,
      });
      // The plan finished was for this build; if it was for another, carry on
      // from what it left, which is now a consistent state.
      if (pending.lastBuild.app.buildId === input.build.buildId)
        return { ran: true, resumed: true, record, settingsChanged: pending.settingsAfter !== null };
    } else {
      // Someone else wrote the settings since: the plan is stale. It is kept as
      // evidence of what was intended, never applied.
      await writeOnce(
        path.join(where.records, `${pending.record.id}.abandoned.json`),
        JSON.stringify({ abandonedAt: at, reason: 'settings-changed-since-plan', journal: pending }, null, 2),
      );
      await fs.rm(where.journal, { force: true });
    }
  }

  const planned = await plan({
    dataDir: input.dataDir,
    build: input.build,
    defaults: (input.defaults ?? settingsDefaults)(),
    policy: input.policy ?? RECONCILE_POLICY,
    at,
  });
  if (planned === null) return { ran: pending !== null, resumed: pending !== null, record: null, settingsChanged: false };
  if ('fresh' in planned) {
    await jsonWrite(where.provenance, planned.fresh.provenance);
    await jsonWrite(where.lastBuild, planned.fresh.lastBuild);
    return { ran: true, resumed: false, record: null, settingsChanged: false };
  }
  await jsonWrite(where.journal, planned);
  const record = await apply(input.dataDir, planned, {
    clearRendererCache: input.clearRendererCache,
    interruptAfter: input.interruptAfter,
    settingsBytesAtStart,
  });
  return { ran: true, resumed: false, record, settingsChanged: planned.settingsAfter !== null };
}

// ---------------------------------------------------------------------------
// Marking a choice
// ---------------------------------------------------------------------------

/**
 * Called after every settings save: a tracked setting the save changed is now
 * the person's choice. When there is no provenance yet, only the changed
 * entries are written and the schema stays at 1, so the next reconcile still
 * fills in the rest.
 *
 * A failure here is not raised to the person whose save already landed: the
 * reconcile also treats any value that left its recorded default as chosen.
 */
export function recordChosenSettings(dataDir: string, before: Settings, after: Settings, at = new Date().toISOString()) {
  const changed = TRACKED_SETTINGS.filter(({ path: key }) => !same(read(before, key), read(after, key)));
  if (changed.length === 0) return Promise.resolve();
  return serial(async () => {
    const file = files(dataDir).provenance;
    let current: ProvenanceFile | null;
    try {
      current = await readProvenance(file);
    } catch {
      return;
    }
    const next: ProvenanceFile = current ?? { version: 1, settingsSchemaVersion: 1, fields: {} };
    for (const { path: key } of changed) next.fields[key] = { source: 'chosen', at };
    await jsonWrite(file, next);
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The one quiet line
// ---------------------------------------------------------------------------

export interface UpdateNotice {
  id: string;
  version: string;
  moved: number;
  text: string;
}

/** The sentence, said once: the version, and how many settings moved. */
export function noticeText(record: Pick<UpdateRecord, 'to' | 'settings'>): string {
  const moved = record.settings.moved.length;
  if (moved === 0) return `Updated to ${record.to.version}.`;
  return `Updated to ${record.to.version}: ${moved} ${moved === 1 ? 'setting' : 'settings'} moved to new defaults.`;
}

async function listRecords(dataDir: string): Promise<UpdateRecord[]> {
  const dir = files(dataDir).records;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
  const records: UpdateRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.abandoned.json')) continue;
    try {
      const value = await readJsonFile(path.join(dir, name));
      assertReadable(UPDATE_RECORD, value);
      records.push(value as UpdateRecord);
    } catch {
      // An unreadable record is still evidence on disk; it just is not announced.
    }
  }
  return records.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** Every update record, oldest first. Read-only. */
export const updateRecords = listRecords;

async function seenIds(dataDir: string): Promise<string[]> {
  try {
    const value = await readJsonFile(files(dataDir).seen);
    return isRecord(value) && Array.isArray(value.seen) ? value.seen.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** The latest update's line, until the person has seen it. Only the latest is ever shown. */
export async function currentUpdateNotice(dataDir: string): Promise<UpdateNotice | null> {
  const records = (await listRecords(dataDir)).filter((record) => record.kind === 'update');
  const latest = records[records.length - 1];
  if (!latest || (await seenIds(dataDir)).includes(latest.id)) return null;
  return { id: latest.id, version: latest.to.version, moved: latest.settings.moved.length, text: noticeText(latest) };
}

/** The person dismissed the line. The record itself is never touched. */
export function markUpdateNoticeSeen(dataDir: string, id: string) {
  return serial(async () => {
    const seen = await seenIds(dataDir);
    if (seen.includes(id)) return;
    await jsonWrite(files(dataDir).seen, { version: 1, seen: [...seen, id] });
  });
}
