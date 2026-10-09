/**
 * NC-TS TS00 (DIO-227) qualification rules for the Turso and AgentFS baseline. Test-only. Identity
 * comes from the pinned artifact, conformance is a list of observed protections, and support is
 * looked up exactly, never inferred from a neighbouring version, platform or capability. TS01
 * (DIO-228) decides what, if anything, becomes production code.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { EngineFactory, ProbeEngine, Row } from './probe-engine.js';

/** The W01 candidate this baseline inventories. It is not on main; DIO-228 owns it. */
export const W01_CANDIDATE = {
  branch: 'feature/memory-ledger',
  commit: 'd05a6b10d71199631ec254d5eec8e9ff9e737aad',
  blobs: {
    'server/memory/store.ts': 'b0e59810453a47dabdaa583398eb43b5a619684b',
    'server/memory/schema.ts': 'd4b93eb5ab210065ec266201a3860e2b0e072899',
    'server/memory/local-store.ts': '3b65753886c4aba2c6ccbc812b0c59baa766dbcc',
  },
} as const;

// ---------------------------------------------------------------------------------------------
// Engine identity (TS-001)

/**
 * W01's engine guard as written in local-store.ts: a version comparison and nothing else.
 * Transcribed so TS-001 can show what it would admit. TS01 must not reuse it for another family.
 */
export function w01VersionGuardAdmits(version: string): boolean {
  const parts = version.split('.').map(Number);
  return !(parts.length !== 3 || parts.some(n => !Number.isSafeInteger(n)) || parts[0] !== 3 ||
    parts[1] < 51 || (parts[1] === 51 && parts[2] < 3));
}

/** W01's last open check as written: quick_check answers ok and foreign_key_check returns no row. */
export async function w01OpenCheckPasses(engine: ProbeEngine): Promise<boolean> {
  return (await engine.get('PRAGMA quick_check'))?.quick_check === 'ok' &&
    !(await engine.get('PRAGMA foreign_key_check'));
}

export type EngineFamily = 'sqlite' | 'turso' | 'libsql' | 'unknown';

/** libSQL is the older SQLite fork. It is never the same family as the new Turso engine. */
const FAMILIES: Readonly<Record<string, EngineFamily>> = {
  'node:sqlite': 'sqlite',
  '@tursodatabase/database': 'turso',
  '@tursodatabase/sync': 'turso',
  '@libsql/client': 'libsql',
  'libsql': 'libsql',
};

export interface ArtifactIdentity { component: string; version: string; platform: string }

export interface SqlIdentity { sqliteVersion: string | null; sqliteSourceId: string | null; tursoVersion: string | null }

export async function readSqlIdentity(engine: ProbeEngine): Promise<SqlIdentity> {
  const one = async (sql: string) => {
    try {
      const value = (await engine.get(sql))?.v;
      return typeof value === 'string' ? value : null;
    } catch { return null; }
  };
  return {
    sqliteVersion: await one('SELECT sqlite_version() AS v'),
    sqliteSourceId: await one('SELECT sqlite_source_id() AS v'),
    tursoVersion: await one('SELECT turso_version() AS v'),
  };
}

/** SQLite source ids end in a 64-digit check-in hash; Turso's ends in a 40-digit git commit. */
export function sourceIdForm(id: string | null): 'sqlite-check-in' | 'git-commit' | 'other' | 'absent' {
  if (id === null) return 'absent';
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [0-9a-f]{64}$/.test(id)) return 'sqlite-check-in';
  return /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [0-9a-f]{40}$/.test(id) ? 'git-commit' : 'other';
}

/** The revision a source id names: a git commit for Turso, a check-in hash for SQLite. */
export function sourceRevision(id: string | null): string | null {
  const form = sourceIdForm(id);
  return id !== null && (form === 'git-commit' || form === 'sqlite-check-in') ? id.slice(id.lastIndexOf(' ') + 1) : null;
}

export interface EngineIdentity extends ArtifactIdentity {
  family: EngineFamily;
  /** The SQLite version the engine reports for compatibility. Recorded, never used as identity. */
  sqliteCompatibility: string | null;
  sqliteSourceIdForm: ReturnType<typeof sourceIdForm>;
  sourceRevision: string | null;
  /** What turso_version() answered on a new connection, if anything. */
  reportedBuild: string | null;
  /** What it answered on reopening a file the engine wrote. W01 opens files, not memory. */
  writtenFileBuild: string | null;
  /** Each way the engine's own answers disagree with the artifact that was installed. */
  contradictions: string[];
}

/**
 * The family is read from the installed artifact. SQL answers, on a new connection and on a file the
 * engine wrote and reopened, can only corroborate or contradict it.
 */
export function classifyEngine(artifact: ArtifactIdentity, fresh: SqlIdentity, written: SqlIdentity): EngineIdentity {
  const declared = FAMILIES[artifact.component] ?? 'unknown';
  const contradictions: string[] = [];
  let family = declared;
  const check = (sql: SqlIdentity, where: string) => {
    if (declared === 'sqlite' && (sql.tursoVersion !== null || sourceIdForm(sql.sqliteSourceId) !== 'sqlite-check-in')) {
      contradictions.push(`a SQLite artifact answered like another engine ${where}`);
      family = 'unknown';
    }
    if (declared === 'turso' && sql.tursoVersion === null) {
      contradictions.push(`a Turso artifact did not answer turso_version() ${where}`);
      family = 'unknown';
    }
    if (declared === 'sqlite' && sql.sqliteVersion !== artifact.version)
      contradictions.push(`sqlite_version() answered ${String(sql.sqliteVersion)} ${where}; the runtime ships ${artifact.version}`);
    if (declared === 'turso' && sql.tursoVersion !== null && sql.tursoVersion !== artifact.version)
      contradictions.push(`turso_version() answered ${sql.tursoVersion} ${where}; the artifact is ${artifact.version}`);
  };
  check(fresh, 'on a new connection');
  check(written, 'on a file it wrote and reopened');
  return {
    ...artifact, family, sqliteCompatibility: fresh.sqliteVersion, sqliteSourceIdForm: sourceIdForm(fresh.sqliteSourceId),
    sourceRevision: sourceRevision(fresh.sqliteSourceId), reportedBuild: fresh.tursoVersion, writtenFileBuild: written.tursoVersion,
    contradictions,
  };
}

/** Only the runtime's own SQLite, uncontradicted, at or above W01's floor. A version string admits nothing. */
export function admitsAsPatchedSqlite(identity: EngineIdentity): boolean {
  return identity.family === 'sqlite' && identity.component === 'node:sqlite' &&
    identity.contradictions.length === 0 && identity.sqliteCompatibility !== null &&
    w01VersionGuardAdmits(identity.sqliteCompatibility);
}

/** Asks on a new connection, then on reopening a file the engine wrote, which is how W01 opens its store. */
export async function identify(factory: EngineFactory, artifact: ArtifactIdentity, scratch: string): Promise<EngineIdentity> {
  const memory = await factory.open(':memory:');
  let fresh: SqlIdentity;
  try { fresh = await readSqlIdentity(memory); } finally { await memory.close(); }
  const file = path.join(scratch, `identity-${randomBytes(6).toString('hex')}.db`);
  try {
    const writer = await factory.open(file);
    try { await writer.exec('CREATE TABLE identity_probe (v TEXT)'); } finally { await writer.close(); }
    const reader = await factory.open(file);
    try { return classifyEngine(artifact, fresh, await readSqlIdentity(reader)); } finally { await reader.close(); }
  } finally { await removeDatabase(file); }
}

// ---------------------------------------------------------------------------------------------
// Pinned artifacts and notices (TS-002)

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** `name` is where the package is installed under the node_modules root: its package name when top-level. */
export interface PackagePin { name: string; version: string; files: Record<string, string> }
/** The first package is the one the component is loaded through. */
export interface ArtifactPin extends ArtifactIdentity { packages: PackagePin[] }

const packageDir = (root: string, name: string) => path.join(root, ...name.split('/'));
const slashed = (from: string, to: string) => path.relative(from, to).split(path.sep).join('/');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Every file in a package directory, and every package in a node_modules folder inside it. Nested
 * packages are listed, not walked: each one is pinned, or refused, on its own.
 */
export function packageContents(dir: string): { files: string[]; nested: string[] } {
  const files: string[] = [];
  const nested: string[] = [];
  const visit = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (!entry.isDirectory()) files.push(slashed(dir, full));
      else if (entry.name !== 'node_modules') visit(full);
      else for (const item of readdirSync(full, { withFileTypes: true })) {
        const installed = path.join(full, item.name);
        if (item.isDirectory() && item.name.startsWith('@'))
          nested.push(...readdirSync(installed).map(name => slashed(dir, path.join(installed, name))));
        else nested.push(slashed(dir, installed));
      }
    }
  };
  visit(dir);
  return { files, nested };
}

export interface InstalledManifest {
  name: string; version: string; license?: string; repository?: { url?: string } | string;
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
}

/** Every package a component loads, each dependency found where Node would find it, inside one node_modules. */
export function installedClosure(root: string, mainDir: string): string[] {
  // Node reports lookup paths in the platform's own form, so the root is compared in that form too.
  const inside = path.resolve(root);
  const found: string[] = [];
  const visit = (dir: string) => {
    if (found.includes(dir)) return;
    found.push(dir);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as InstalledManifest;
    // Asked with a name that is not a core module: `buffer` is both, and core names have no lookup paths.
    const lookup = (createRequire(path.join(dir, 'package.json')).resolve.paths('nectovia-probe-dependency') ?? [])
      .filter(folder => folder === inside || folder.startsWith(`${inside}${path.sep}`));
    const resolve = (name: string) => lookup.map(folder => path.join(folder, ...name.split('/')))
      .find(candidate => existsSync(path.join(candidate, 'package.json')));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const resolved = resolve(name);
      if (!resolved) throw new Error(`${name}, which ${manifest.name} requires, is not installed`);
      visit(resolved);
    }
    // Optional dependencies are the platform bindings; only this platform's is installed.
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      const resolved = resolve(name);
      if (resolved) visit(resolved);
    }
  };
  visit(path.resolve(mainDir));
  return found;
}

/** Hashes package.json and the listed files of each installed package under a node_modules root. */
export async function pinInstalled(root: string, artifact: ArtifactIdentity,
  packages: ReadonlyArray<{ name: string; files: readonly string[] }>): Promise<ArtifactPin> {
  const pinned: PackagePin[] = [];
  for (const item of packages) {
    const dir = packageDir(root, item.name);
    const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown };
    const files: Record<string, string> = {};
    for (const file of ['package.json', ...item.files]) files[file] = sha256(await readFile(path.join(dir, file)));
    pinned.push({ name: item.name, version: String(manifest.version), files });
  }
  return { ...artifact, packages: pinned };
}

/** A stable digest of a pin. Evidence names the digest it was produced against. */
export function pinDigest(pin: ArtifactPin): string {
  const sorted = <T>(entries: Array<[string, T]>) => entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(Buffer.from(JSON.stringify({
    component: pin.component, version: pin.version, platform: pin.platform,
    packages: sorted(pin.packages.map(p => [p.name, p] as [string, PackagePin]))
      .map(([, p]) => ({ name: p.name, version: p.version, files: sorted(Object.entries(p.files)) })),
  })));
}

/**
 * Compares what is installed now with the approved pin. Every approved file must match, nothing else
 * may sit in an approved package, and Node must still resolve each package where it was approved.
 * Turso's loader tries a binary inside the main package before the pinned binding, so an added
 * file can change what loads as surely as a changed one.
 */
export async function verifyPin(approved: ArtifactPin, root: string): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const pinned = new Set(approved.packages.map(item => item.name));
  for (const item of approved.packages) {
    const dir = packageDir(root, item.name);
    let version: unknown;
    try { version = (JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version; }
    catch { problems.push(`${item.name} is not installed`); continue; }
    if (version !== item.version) problems.push(`${item.name} resolved to ${String(version)}; approved ${item.version}`);
    for (const [file, expected] of Object.entries(item.files)) {
      let actual: string;
      try { actual = sha256(await readFile(path.join(dir, file))); }
      catch { problems.push(`${item.name}/${file} is missing`); continue; }
      if (actual !== expected) problems.push(`${item.name}/${file} changed`);
    }
    const { files, nested } = packageContents(dir);
    for (const file of files) if (!Object.hasOwn(item.files, file)) problems.push(`${item.name}/${file} is not in the approved pin`);
    for (const name of nested.map(entry => `${item.name}/${entry}`)) if (!pinned.has(name)) problems.push(`${name} is not in the approved pin`);
  }
  // A package shadowing one on Node's lookup path is outside every approved directory.
  const main = approved.packages[0]?.name;
  if (main && existsSync(path.join(packageDir(root, main), 'package.json'))) {
    try {
      const resolved = installedClosure(root, packageDir(root, main)).map(dir => slashed(root, dir));
      for (const name of resolved) if (!pinned.has(name)) problems.push(`${main} resolves ${name}, which is not in the approved pin`);
      for (const name of pinned) if (!resolved.includes(name)) problems.push(`${main} no longer resolves ${name}`);
    } catch (error) { problems.push(`${main} no longer resolves: ${message(error)}`); }
  }
  return { ok: problems.length === 0, problems };
}

/** Variables that make the Turso loader load a binary other than the pinned one. Runs record any that are set. */
export const LOADER_OVERRIDES = ['NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI'] as const;
export const loaderOverrides = (env: NodeJS.ProcessEnv = process.env): string[] =>
  LOADER_OVERRIDES.filter(name => env[name] !== undefined);

/** Evidence counts only for the exact artifact it was produced against. */
export function evidenceApplies(evidence: { artifactDigest: string }, current: ArtifactPin): boolean {
  return evidence.artifactDigest === pinDigest(current);
}

export interface NoticeFile { path: string; sha256: string }
/** One installed package, the license it declares, and the file that carries that license's text. */
export interface PackageLicense { package: string; declared: string | null; text: NoticeFile | null }
export interface NoticeRecord {
  /** Every package the artifact installs. */
  licenses: PackageLicense[];
  /** License and notice files at the pinned upstream source commits that apply to this artifact. */
  upstream: NoticeFile[];
  /** License and notice files inside the installed packages. */
  shipped: NoticeFile[];
  /** Notice files this app carries for it. */
  bundled: NoticeFile[];
}
export type Redistribution = 'ready' | 'needs-bundled-notices' | 'blocked';

/** Every package's own license text, and every upstream notice, must reach the installer by content. */
export function redistribution(record: NoticeRecord): { status: Redistribution; reasons: string[] } {
  // Each package needs the text of the license it declares; a dependency's file does not stand in.
  const unlicensed = record.licenses.filter(item => !item.declared || !item.text).map(item => (item.declared
    ? `${item.package} declares ${item.declared}, but neither its pinned source nor the package carries that text`
    : `${item.package} declares no license`));
  if (unlicensed.length) return { status: 'blocked', reasons: unlicensed };
  const carried = new Set([...record.shipped, ...record.bundled].map(file => file.sha256));
  const required = [...record.licenses.flatMap(item => (item.text ? [item.text] : [])), ...record.upstream];
  const missing = [...new Set(required.filter(file => !carried.has(file.sha256)).map(file => file.path))];
  if (missing.length) return { status: 'needs-bundled-notices', reasons: missing.map(file => `${file} is carried by neither the package nor the app`) };
  return { status: 'ready', reasons: [] };
}

// ---------------------------------------------------------------------------------------------
// Protection inventory (TS-003): every W01 guard, observed rather than assumed

export type ProtectionStatus = 'proven' | 'violated' | 'unverified' | 'unsupported';
/**
 * behavior: the probe observes an effect, such as a refusal, a wait, a file or a row count.
 * readback: it observes only what the engine reports about its own setting. Proven then means the
 * setting was accepted and reads back, not that the engine behaves the way the setting says.
 */
export type Proof = 'behavior' | 'readback';
export interface ProtectionResult { id: string; proof: Proof; status: ProtectionStatus; observed: string }
type Outcome = Pick<ProtectionResult, 'status' | 'observed'>;
type Attempt<T> = { ok: true; value: T } | { ok: false; error: string; thrown: unknown };

export interface ProbeContext {
  factory: EngineFactory;
  /** A directory the probe may create and delete database files in. */
  scratch: string;
}

export interface Protection {
  id: string;
  /** Where the W01 candidate relies on it. */
  source: string;
  /** The local-store settings and statements it covers, named the way w01Reliances() reads them. */
  covers: readonly string[];
  proof: Proof;
  required: boolean;
  /** Probes that can crash or block a native engine, so runners give each its own process. */
  isolate?: boolean;
  probe(context: ProbeContext): Promise<Outcome>;
}

async function attempt<T>(operation: () => Promise<T>): Promise<Attempt<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, error: message(error), thrown: error }; }
}

/** What W01's translated() reads from a failure: the SQLite result code on an Error, or nothing. */
const resultCode = (error: unknown) =>
  (error instanceof Error && 'errcode' in error && Number.isInteger(Number(error.errcode)) ? Number(error.errcode) : null);
const BUSY = /busy|locked/i;

const firstValue = (row: Row | undefined) => (row === undefined ? undefined : Object.values(row)[0]);
const databaseFile = (context: ProbeContext) => path.join(context.scratch, `probe-${randomBytes(6).toString('hex')}.db`);

export async function removeDatabase(file: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${file}${suffix}`, { force: true });
}

async function withDatabase(context: ProbeContext, use: (engine: ProbeEngine, file: string) => Promise<Outcome>) {
  const file = databaseFile(context);
  try {
    const engine = await context.factory.open(file);
    try { return await use(engine, file); }
    finally { await engine.close(); }
  } finally { await removeDatabase(file); }
}

/** Sets a PRAGMA and reads it back. No row after the set means the engine ignored it or cannot say. */
async function readback(engine: ProbeEngine, set: string, read: string, expected: unknown): Promise<Outcome> {
  const changed = await attempt(() => engine.exec(set));
  if (!changed.ok) return { status: 'unsupported', observed: `${set} failed: ${changed.error}` };
  const rows = await attempt(() => engine.all(read));
  if (!rows.ok) return { status: 'unsupported', observed: `${read} failed: ${rows.error}` };
  if (rows.value.length === 0) return { status: 'unverified', observed: `${read} returned no row after ${set}` };
  const value = firstValue(rows.value[0]);
  return value === expected
    ? { status: 'proven', observed: `${read} = ${String(value)}` }
    : { status: 'violated', observed: `${read} = ${String(value)}; expected ${String(expected)}` };
}

export const SCHEMA_OBJECTS = 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql';
export const PROBE_APPLICATION_ID = 0x4e435453;

const SCOPE = 'tenant_id, workspace_id, scope_ref';
const SCOPE_COLUMNS = 'tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope_ref TEXT NOT NULL';
const SCOPE_KEY = ['t1', 'w1', 'project:a'] as const;

/** The W01 constructs the probes depend on, written the way schema.ts writes them. */
export const PROBE_SCHEMA = `
CREATE TABLE memory_scopes (
  ${SCOPE_COLUMNS},
  access_epoch INTEGER NOT NULL CHECK(access_epoch >= 0),
  PRIMARY KEY (${SCOPE})
) STRICT;
CREATE TABLE memory_entries (
  ${SCOPE_COLUMNS},
  id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0), payload TEXT NOT NULL,
  PRIMARY KEY (${SCOPE}, id),
  UNIQUE (${SCOPE}, sequence),
  FOREIGN KEY (${SCOPE}) REFERENCES memory_scopes (${SCOPE})
) STRICT;
CREATE TABLE memory_commands (
  ${SCOPE_COLUMNS}, command_id TEXT NOT NULL,
  PRIMARY KEY (${SCOPE}, command_id),
  FOREIGN KEY (${SCOPE}) REFERENCES memory_scopes (${SCOPE})
) STRICT;
CREATE TABLE memory_events (
  ${SCOPE_COLUMNS}, sequence INTEGER NOT NULL, command_id TEXT NOT NULL,
  PRIMARY KEY (${SCOPE}, sequence),
  FOREIGN KEY (${SCOPE}, sequence) REFERENCES memory_entries (${SCOPE}, sequence),
  FOREIGN KEY (${SCOPE}, command_id) REFERENCES memory_commands (${SCOPE}, command_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER memory_entries_immutable_update BEFORE UPDATE ON memory_entries
  BEGIN SELECT RAISE(ABORT, 'immutable_memory'); END;
CREATE TRIGGER memory_entries_immutable_delete BEFORE DELETE ON memory_entries
  BEGIN SELECT RAISE(ABORT, 'immutable_memory'); END;
CREATE TRIGGER memory_epochs_monotonic BEFORE UPDATE ON memory_scopes
WHEN NEW.access_epoch < OLD.access_epoch
BEGIN SELECT RAISE(ABORT, 'revoked_epoch'); END;
`;

async function seeded(engine: ProbeEngine) {
  await engine.exec('PRAGMA foreign_keys = ON');
  await engine.exec(PROBE_SCHEMA);
  await engine.run('INSERT INTO memory_scopes VALUES (?, ?, ?, ?)', ...SCOPE_KEY, 0);
}

const refusedWith = (result: Attempt<unknown>, message: string) => !result.ok && result.error.includes(message);
const describe = (result: Attempt<unknown>) => (result.ok ? 'applied' : result.error);

/**
 * A refusal proves a guard only after the same statement shape succeeded with valid values. Without
 * that control, an engine that cannot run the statement at all would look like one that guards it.
 */
function refusalAfterControl(control: Attempt<unknown>, refused: Attempt<unknown>, accepted: string): Outcome {
  if (!control.ok) return { status: 'unverified', observed: `the valid control failed: ${control.error}` };
  return refused.ok ? { status: 'violated', observed: accepted } : { status: 'proven', observed: refused.error };
}

export const W01_PROTECTIONS: readonly Protection[] = [
  {
    id: 'strict-typing', proof: 'behavior', covers: [],
    source: 'schema.ts: every ledger table is STRICT', required: true,
    probe: context => withDatabase(context, async engine => {
      await seeded(engine);
      const control = await attempt(() => engine.run('INSERT INTO memory_scopes VALUES (?, ?, ?, ?)', 't2', 'w1', 'project:a', 3));
      const wrong = await attempt(() => engine.run('INSERT INTO memory_scopes VALUES (?, ?, ?, ?)', 't3', 'w1', 'project:a', 'not a number'));
      return refusalAfterControl(control, wrong, 'a STRICT INTEGER column stored text');
    }),
  },
  {
    id: 'check-constraints', proof: 'behavior', covers: [],
    source: 'schema.ts: CHECK bounds on epochs, revisions and sequences', required: true,
    probe: context => withDatabase(context, async engine => {
      await seeded(engine);
      const control = await attempt(() => engine.run('INSERT INTO memory_scopes VALUES (?, ?, ?, ?)', 't2', 'w1', 'project:a', 0));
      const negative = await attempt(() => engine.run('INSERT INTO memory_scopes VALUES (?, ?, ?, ?)', 't3', 'w1', 'project:a', -1));
      return refusalAfterControl(control, negative, 'a negative epoch was stored');
    }),
  },
  {
    id: 'foreign-keys-on', proof: 'readback', covers: ['PRAGMA foreign_keys', 'option enableForeignKeyConstraints'],
    source: 'local-store.ts: enableForeignKeyConstraints and PRAGMA foreign_keys = ON', required: true,
    probe: context => withDatabase(context, engine => readback(engine, 'PRAGMA foreign_keys = ON', 'PRAGMA foreign_keys', 1)),
  },
  {
    id: 'scoped-composite-foreign-key', proof: 'behavior', covers: [],
    source: 'schema.ts: rows reference their full (tenant, workspace, scope) key', required: true,
    probe: context => withDatabase(context, async engine => {
      await seeded(engine);
      const control = await attempt(() => engine.run(`INSERT INTO memory_entries VALUES (?, ?, ?, 'r1', 1, '{}')`, ...SCOPE_KEY));
      const missing = await attempt(() => engine.run(`INSERT INTO memory_entries VALUES (?, ?, ?, 'r2', 2, '{}')`, 't1', 'w1', 'project:b'));
      const crossed = await attempt(() => engine.run(`INSERT INTO memory_entries VALUES (?, ?, ?, 'r3', 3, '{}')`, 't1', 'w2', 'project:a'));
      if (!missing.ok && !crossed.ok) return refusalAfterControl(control, missing, '');
      return { status: 'violated', observed: `stored a row for ${missing.ok ? 'a missing scope' : 'another workspace'}` };
    }),
  },
  {
    id: 'deferred-event-command-key', proof: 'behavior', covers: [],
    source: 'schema.ts: memory_events references memory_commands DEFERRABLE INITIALLY DEFERRED', required: true,
    probe: context => withDatabase(context, async engine => {
      await seeded(engine);
      const write = async (id: string, sequence: number, command: string, withCommand: boolean) => {
        await engine.exec('BEGIN IMMEDIATE');
        try {
          await engine.run(`INSERT INTO memory_entries VALUES (?, ?, ?, ?, ?, '{}')`, ...SCOPE_KEY, id, sequence);
          await engine.run('INSERT INTO memory_events VALUES (?, ?, ?, ?, ?)', ...SCOPE_KEY, sequence, command);
          if (withCommand) await engine.run('INSERT INTO memory_commands VALUES (?, ?, ?, ?)', ...SCOPE_KEY, command);
          await engine.exec('COMMIT');
        } finally { await attempt(() => engine.exec('ROLLBACK')); }
      };
      const valid = await attempt(() => write('r1', 1, 'c1', true));
      const invalid = await attempt(() => write('r2', 2, 'c-missing', false));
      const counts = await engine.get(
        'SELECT (SELECT count(*) FROM memory_entries) AS entries, (SELECT count(*) FROM memory_events) AS events');
      if (valid.ok && !invalid.ok && Number(counts?.entries) === 1 && Number(counts?.events) === 1)
        return { status: 'proven', observed: invalid.error };
      return { status: 'violated', observed: `event before command: ${describe(valid)}; event without command: ${describe(invalid)}; ` +
        `entries ${String(counts?.entries)}, events ${String(counts?.events)}` };
    }),
  },
  {
    id: 'immutable-rows', proof: 'behavior', covers: [],
    source: 'schema.ts: BEFORE UPDATE and BEFORE DELETE triggers raise immutable_memory', required: true,
    probe: context => withDatabase(context, async engine => {
      await seeded(engine);
      await engine.run(`INSERT INTO memory_entries VALUES (?, ?, ?, 'r1', 1, '{"v":1}')`, ...SCOPE_KEY);
      const update = await attempt(() => engine.exec(`UPDATE memory_entries SET payload = '{"v":2}'`));
      const remove = await attempt(() => engine.exec('DELETE FROM memory_entries'));
      const row = await engine.get('SELECT payload FROM memory_entries');
      return refusedWith(update, 'immutable_memory') && refusedWith(remove, 'immutable_memory') && row?.payload === '{"v":1}'
        ? { status: 'proven', observed: 'update and delete raised immutable_memory' }
        : { status: 'violated', observed: `update: ${describe(update)}; delete: ${describe(remove)}` };
    }),
  },
  {
    id: 'monotonic-epoch', proof: 'behavior', covers: [],
    source: 'schema.ts: memory_epochs_monotonic raises revoked_epoch when an epoch falls', required: true,
    probe: context => withDatabase(context, async engine => {
      await seeded(engine);
      const raise = await attempt(() => engine.exec('UPDATE memory_scopes SET access_epoch = 5'));
      const lower = await attempt(() => engine.exec('UPDATE memory_scopes SET access_epoch = 4'));
      const epoch = firstValue(await engine.get('SELECT access_epoch FROM memory_scopes'));
      return raise.ok && refusedWith(lower, 'revoked_epoch') && epoch === 5
        ? { status: 'proven', observed: 'a lower epoch raised revoked_epoch' }
        : { status: 'violated', observed: `raise: ${describe(raise)}; lower: ${describe(lower)}; epoch ${String(epoch)}` };
    }),
  },
  {
    id: 'foreign-key-check-detects-orphan', proof: 'behavior', covers: ['PRAGMA foreign_key_check'],
    source: 'local-store.ts: open fails when PRAGMA foreign_key_check returns a row', required: true,
    probe: context => withDatabase(context, async engine => {
      await engine.exec('PRAGMA foreign_keys = OFF');
      // Not STRICT: this row is about foreign_key_check, and strict-typing covers STRICT on its own.
      await engine.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent (id));');
      await engine.run('INSERT INTO child VALUES (?)', 43);
      const orphans = await engine.all('SELECT parent_id FROM child WHERE parent_id NOT IN (SELECT id FROM parent)');
      if (orphans.length !== 1) return { status: 'unverified', observed: 'the orphan row could not be created' };
      const check = await attempt(() => engine.all('PRAGMA foreign_key_check'));
      if (!check.ok) return { status: 'unsupported', observed: check.error };
      return check.value.length > 0
        ? { status: 'proven', observed: `foreign_key_check reported ${check.value.length} row` }
        : { status: 'violated', observed: 'an orphan row exists and foreign_key_check returned no row' };
    }),
  },
  {
    id: 'trusted-schema-off', proof: 'readback', covers: ['PRAGMA trusted_schema'],
    source: 'local-store.ts: PRAGMA trusted_schema = OFF', required: true,
    probe: context => withDatabase(context, engine => readback(engine, 'PRAGMA trusted_schema = OFF', 'PRAGMA trusted_schema', 0)),
  },
  {
    id: 'trusted-schema-refuses-unsafe-function', proof: 'behavior', covers: ['PRAGMA trusted_schema'],
    source: 'local-store.ts: PRAGMA trusted_schema = OFF, so a view or trigger stored in a file cannot call an application function',
    required: true,
    probe: async context => {
      const file = databaseFile(context);
      try {
        const opened = await attempt(() => context.factory.open(file, { functions: { nectovia_probe_unsafe: () => 'called' } }));
        if (!opened.ok) return { status: 'unverified', observed: `no application function could be registered to test it: ${opened.error}` };
        const engine = opened.value;
        try {
          await engine.exec('CREATE VIEW probe_view AS SELECT nectovia_probe_unsafe() AS v');
          // The control: with the schema trusted, the same view calls the function.
          await engine.exec('PRAGMA trusted_schema = ON');
          const control = await attempt(() => engine.get('SELECT v FROM probe_view'));
          await engine.exec('PRAGMA trusted_schema = OFF');
          const refused = await attempt(() => engine.get('SELECT v FROM probe_view'));
          if (!refused.ok && !/unsafe use/i.test(refused.error))
            return { status: 'unverified', observed: `the view failed for another reason: ${refused.error}` };
          return refusalAfterControl(control, refused, 'a view called an application function with trusted_schema OFF');
        } finally { await engine.close(); }
      } finally { await removeDatabase(file); }
    },
  },
  {
    id: 'busy-timeout', proof: 'readback', covers: ['PRAGMA busy_timeout'],
    source: 'local-store.ts: PRAGMA busy_timeout = 100', required: true,
    probe: context => withDatabase(context, engine => readback(engine, 'PRAGMA busy_timeout = 100', 'PRAGMA busy_timeout', 100)),
  },
  {
    id: 'busy-timeout-waits', proof: 'behavior', covers: ['PRAGMA busy_timeout'],
    source: 'local-store.ts: PRAGMA busy_timeout = 100, so a second writer waits for the lock before it reports busy',
    required: true, isolate: true,
    probe: context => withDatabase(context, async (first, file) => {
      await first.get('PRAGMA journal_mode = WAL');
      await first.exec('CREATE TABLE t (v INTEGER)');
      const second = await context.factory.open(file);
      try {
        await second.exec('PRAGMA busy_timeout = 100');
        await first.exec('BEGIN IMMEDIATE');
        let blocked: Attempt<void>;
        let waited: number;
        try {
          await first.run('INSERT INTO t VALUES (?)', 1);
          const started = performance.now();
          blocked = await attempt(() => second.run('INSERT INTO t VALUES (?)', 2));
          waited = performance.now() - started;
        } finally { await attempt(() => first.exec('ROLLBACK')); }
        if (blocked.ok) return { status: 'unverified', observed: 'the second writer was not held back, so there was no wait to see' };
        if (!BUSY.test(blocked.error)) return { status: 'unverified', observed: `the second writer failed for another reason: ${blocked.error}` };
        if (waited < 80) return { status: 'violated', observed: `the second writer gave up in under 80 ms: ${blocked.error}` };
        // Bounded both ways, so a driver that ignores the setting and waits its own default is caught too.
        return waited < 1000
          ? { status: 'proven', observed: `the second writer waited at least 80 ms, then: ${blocked.error}` }
          : { status: 'violated', observed: `the second writer waited 1 s or more for a 100 ms timeout: ${blocked.error}` };
      } finally { await second.close(); }
    }),
  },
  {
    id: 'synchronous-full', proof: 'readback', covers: ['PRAGMA synchronous'],
    source: 'local-store.ts: PRAGMA synchronous = FULL', required: true,
    probe: context => withDatabase(context, engine => readback(engine, 'PRAGMA synchronous = FULL', 'PRAGMA synchronous', 2)),
  },
  {
    id: 'cache-spill-off', proof: 'readback', covers: ['PRAGMA cache_spill'],
    source: 'local-store.ts: PRAGMA cache_spill = OFF; reserveWal counts one frame per page on that basis', required: true,
    probe: context => withDatabase(context, engine => readback(engine, 'PRAGMA cache_spill = OFF', 'PRAGMA cache_spill', 0)),
  },
  {
    id: 'max-page-count-ceiling', proof: 'behavior', covers: ['PRAGMA max_page_count', 'PRAGMA page_count'],
    source: 'local-store.ts: PRAGMA max_page_count bounds the database', required: true,
    probe: context => withDatabase(context, async engine => {
      await engine.exec('CREATE TABLE big (b BLOB)');
      const ceiling = Number(firstValue(await engine.get('PRAGMA page_count'))) + 4;
      await engine.exec(`PRAGMA max_page_count = ${ceiling}`);
      let rows = 0;
      const fill = await attempt(async () => { for (; rows < 64; rows++) await engine.run('INSERT INTO big VALUES (randomblob(4096))'); });
      if (fill.ok) return { status: 'violated', observed: `stored 64 pages of rows past a ceiling of ${ceiling} pages` };
      return rows === 0 ? { status: 'unverified', observed: `the first row failed: ${fill.error}` }
        : { status: 'proven', observed: `refused after ${rows} rows: ${fill.error}` };
    }),
  },
  {
    id: 'capacity-error-code', proof: 'behavior', covers: ['errcode 13'],
    source: 'local-store.ts: translated() reports memory_capacity only for an Error whose errcode % 256 is 13, SQLITE_FULL',
    required: true,
    probe: context => withDatabase(context, async engine => {
      await engine.exec('CREATE TABLE big (b BLOB)');
      const ceiling = Number(firstValue(await engine.get('PRAGMA page_count'))) + 4;
      await engine.exec(`PRAGMA max_page_count = ${ceiling}`);
      const fill = await attempt(async () => { for (let rows = 0; rows < 64; rows++) await engine.run('INSERT INTO big VALUES (randomblob(4096))'); });
      if (fill.ok) return { status: 'unverified', observed: 'no write was refused, so there was no full-database error to read' };
      const code = resultCode(fill.thrown);
      if (code === null) return { status: 'violated', observed: `the full-database error carries no SQLite result code: ${fill.error}` };
      return code % 256 === 13
        ? { status: 'proven', observed: `result code ${code}: ${fill.error}` }
        : { status: 'violated', observed: `result code ${code}, not 13: ${fill.error}` };
    }),
  },
  {
    id: 'journal-size-limit', proof: 'readback', covers: ['PRAGMA journal_size_limit'],
    source: 'local-store.ts: PRAGMA journal_size_limit = 0', required: true,
    probe: context => withDatabase(context, engine => readback(engine, 'PRAGMA journal_size_limit = 0', 'PRAGMA journal_size_limit', 0)),
  },
  {
    id: 'wal-mode', proof: 'readback', covers: ['PRAGMA journal_mode'],
    source: "local-store.ts: PRAGMA journal_mode = WAL must answer 'wal'", required: true,
    probe: context => withDatabase(context, async engine => {
      const mode = await attempt(() => engine.get('PRAGMA journal_mode = WAL'));
      if (!mode.ok) return { status: 'unsupported', observed: mode.error };
      const value = firstValue(mode.value);
      return value === 'wal' ? { status: 'proven', observed: 'journal_mode = wal' } : { status: 'violated', observed: `journal_mode = ${String(value)}` };
    }),
  },
  {
    id: 'wal-autocheckpoint', proof: 'readback', covers: ['PRAGMA wal_autocheckpoint'],
    source: 'local-store.ts: PRAGMA wal_autocheckpoint = 100', required: true,
    probe: context => withDatabase(context, engine => readback(engine, 'PRAGMA wal_autocheckpoint = 100', 'PRAGMA wal_autocheckpoint', 100)),
  },
  {
    id: 'wal-checkpoint-truncate', proof: 'behavior', covers: ['PRAGMA wal_checkpoint'],
    source: 'local-store.ts: checkpoint() runs wal_checkpoint(TRUNCATE) and requires busy = 0', required: true,
    probe: context => withDatabase(context, async (engine, file) => {
      await engine.get('PRAGMA journal_mode = WAL');
      await engine.exec('CREATE TABLE t (v TEXT)');
      for (let i = 0; i < 20; i++) await engine.run('INSERT INTO t VALUES (?)', 'x'.repeat(500));
      const wal = `${file}-wal`;
      const before = existsSync(wal) ? statSync(wal).size : -1;
      const result = await attempt(() => engine.get('PRAGMA wal_checkpoint(TRUNCATE)'));
      const after = existsSync(wal) ? statSync(wal).size : -1;
      if (!result.ok) return { status: 'unsupported', observed: result.error };
      if (!result.value || !('busy' in result.value)) return { status: 'unverified', observed: 'wal_checkpoint returned no busy column' };
      if (before <= 0) return { status: 'violated', observed: `no WAL at <file>-wal before the checkpoint (${before} bytes)` };
      return Number(result.value.busy) === 0 && after <= 0
        ? { status: 'proven', observed: `WAL ${before} bytes, then ${Math.max(after, 0)}` }
        : { status: 'violated', observed: `busy ${String(result.value.busy)}; WAL ${before} bytes, then ${after}` };
    }),
  },
  {
    id: 'wal-frame-accounting', proof: 'behavior', covers: ['PRAGMA page_size'],
    source: 'local-store.ts: reserveWal sizes <file>-wal as a 32-byte header plus page + 24 bytes per frame', required: true,
    probe: context => withDatabase(context, async (engine, file) => {
      await engine.get('PRAGMA journal_mode = WAL');
      const pageSize = Number(firstValue(await engine.get('PRAGMA page_size')));
      await engine.exec('CREATE TABLE t (v TEXT)');
      for (let i = 0; i < 5; i++) await engine.run('INSERT INTO t VALUES (?)', 'x'.repeat(500));
      const wal = `${file}-wal`;
      const size = existsSync(wal) ? statSync(wal).size : -1;
      if (size <= 32) return { status: 'violated', observed: `<file>-wal is ${size} bytes after five writes` };
      return (size - 32) % (pageSize + 24) === 0
        ? { status: 'proven', observed: `${(size - 32) / (pageSize + 24)} frames of ${pageSize + 24} bytes` }
        : { status: 'violated', observed: `${size} bytes is not a header plus whole ${pageSize}-byte frames` };
    }),
  },
  {
    id: 'application-id-user-version', proof: 'behavior', covers: ['PRAGMA application_id', 'PRAGMA user_version'],
    source: 'local-store.ts: inspectSchema reads application_id and user_version before trusting a file', required: true,
    probe: async context => {
      const file = databaseFile(context);
      try {
        const first = await context.factory.open(file);
        try { await first.exec(`PRAGMA application_id = ${PROBE_APPLICATION_ID}; PRAGMA user_version = 7; CREATE TABLE t (v TEXT);`); }
        finally { await first.close(); }
        const second = await context.factory.open(file);
        try {
          const application = firstValue(await second.get('PRAGMA application_id'));
          const user = firstValue(await second.get('PRAGMA user_version'));
          return application === PROBE_APPLICATION_ID && user === 7
            ? { status: 'proven', observed: 'both survived a reopen' }
            : { status: 'violated', observed: `after reopen application_id ${String(application)}, user_version ${String(user)}` };
        } finally { await second.close(); }
      } finally { await removeDatabase(file); }
    },
  },
  {
    id: 'immediate-write-exclusion', proof: 'behavior', covers: ['BEGIN IMMEDIATE'],
    source: 'local-store.ts: BEGIN IMMEDIATE holds the write lock from the start, so a competing initializer or writer is kept out',
    required: true, isolate: true,
    probe: context => withDatabase(context, async (first, file) => {
      await first.get('PRAGMA journal_mode = WAL');
      await first.exec('CREATE TABLE t (v INTEGER)');
      const second = await context.factory.open(file);
      try {
        await second.exec('PRAGMA busy_timeout = 0');
        // The control: alone, the second connection can take the lock.
        const control = await attempt(async () => { await second.exec('BEGIN IMMEDIATE'); await second.exec('ROLLBACK'); });
        await first.exec('BEGIN IMMEDIATE');
        let competing: Attempt<void>;
        try {
          // The first has written nothing, so only BEGIN IMMEDIATE itself can be holding the lock.
          competing = await attempt(() => second.exec('BEGIN IMMEDIATE'));
          if (competing.ok) await attempt(() => second.exec('ROLLBACK'));
        } finally { await attempt(() => first.exec('ROLLBACK')); }
        if (!control.ok) return { status: 'unverified', observed: `the second connection could not take the lock alone: ${control.error}` };
        if (competing.ok) return { status: 'violated', observed: 'a second BEGIN IMMEDIATE succeeded while the first was open' };
        return BUSY.test(competing.error)
          ? { status: 'proven', observed: competing.error }
          : { status: 'unverified', observed: `the second BEGIN IMMEDIATE failed for another reason: ${competing.error}` };
      } finally { await second.close(); }
    }),
  },
  {
    id: 'quick-check-detects-corruption', proof: 'behavior', covers: ['PRAGMA quick_check'],
    source: "local-store.ts: open fails unless PRAGMA quick_check answers 'ok'", required: true, isolate: true,
    probe: async context => {
      const file = databaseFile(context);
      try {
        let pageSize = 0;
        let healthy: Attempt<Row | undefined>;
        const writer = await context.factory.open(file);
        try {
          await writer.get('PRAGMA journal_mode = WAL');
          await writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
          for (let i = 0; i < 200; i++) await writer.run('INSERT INTO t (v) VALUES (?)', `row-${i}-${'x'.repeat(200)}`);
          pageSize = Number(firstValue(await writer.get('PRAGMA page_size')));
          // The control: a healthy file must answer 'ok', or a later failure proves nothing.
          healthy = await attempt(() => writer.get('PRAGMA quick_check'));
          await writer.get('PRAGMA wal_checkpoint(TRUNCATE)');
        } finally { await writer.close(); }
        if (!healthy.ok) return { status: 'unsupported', observed: `quick_check failed on a healthy file: ${healthy.error}` };
        if (firstValue(healthy.value) !== 'ok') return { status: 'unverified', observed: `quick_check answered ${String(firstValue(healthy.value))} on a healthy file` };
        const wal = `${file}-wal`;
        if (existsSync(wal) && statSync(wal).size > 0)
          return { status: 'unverified', observed: 'the WAL still held pages after close, so a damaged main-file page could be shadowed' };
        if (statSync(file).size < 2 * pageSize) return { status: 'unverified', observed: 'the table never reached the main file' };
        // Page 2 is the root of the first table; an invalid page type is unambiguous damage.
        const handle = await open(file, 'r+');
        try { await handle.write(Buffer.alloc(8, 0xff), 0, 8, pageSize); } finally { await handle.close(); }
        const reader = await attempt(() => context.factory.open(file));
        if (!reader.ok) return { status: 'proven', observed: `open refused the file: ${reader.error}` };
        try {
          const check = await attempt(() => reader.value.get('PRAGMA quick_check'));
          if (!check.ok) return { status: 'proven', observed: `quick_check failed: ${check.error}` };
          const verdict = firstValue(check.value);
          return verdict === 'ok'
            ? { status: 'violated', observed: "quick_check answered 'ok' for a page with an invalid type" }
            : { status: 'proven', observed: String(verdict).slice(0, 160) };
        } finally { await reader.value.close(); }
      } finally { await removeDatabase(file); }
    },
  },
  {
    id: 'read-only-inspection', proof: 'behavior', covers: ['option readOnly'],
    source: 'local-store.ts: an existing file is inspected read-only before any PRAGMA changes it', required: true,
    probe: async context => {
      const file = databaseFile(context);
      try {
        const writer = await context.factory.open(file);
        try { await writer.exec('CREATE TABLE t (v TEXT)'); } finally { await writer.close(); }
        const reader = await attempt(() => context.factory.open(file, { readonly: true }));
        if (!reader.ok) return { status: 'unsupported', observed: reader.error };
        try {
          const control = await attempt(() => reader.value.get('SELECT count(*) AS n FROM t'));
          const write = await attempt(() => reader.value.run('INSERT INTO t VALUES (?)', 'x'));
          const pragma = await attempt(() => reader.value.exec('PRAGMA user_version = 9'));
          const version = firstValue(await reader.value.get('PRAGMA user_version'));
          if (!write.ok && version === 0) return refusalAfterControl(control, write, '');
          return { status: 'violated', observed: `insert: ${describe(write)}; user_version set: ${describe(pragma)}, now ${String(version)}` };
        } finally { await reader.value.close(); }
      } finally { await removeDatabase(file); }
    },
  },
  {
    id: 'double-quoted-identifiers-only', proof: 'behavior', covers: ['option enableDoubleQuotedStringLiterals'],
    source: 'local-store.ts: enableDoubleQuotedStringLiterals: false', required: true,
    probe: context => withDatabase(context, async engine => {
      const control = await attempt(() => engine.get(`SELECT 'nectovia_probe_missing' AS v`));
      const quoted = await attempt(() => engine.get('SELECT "nectovia_probe_missing" AS v'));
      return refusalAfterControl(control, quoted, `a double-quoted name read as the string ${JSON.stringify(quoted.ok ? quoted.value?.v : null)}`);
    }),
  },
  {
    id: 'extension-loading-off', proof: 'behavior', covers: ['option allowExtension'],
    source: 'local-store.ts: allowExtension: false', required: true,
    probe: context => withDatabase(context, async engine => {
      const load = await attempt(() => engine.get('SELECT load_extension(?) AS v', path.join(context.scratch, 'nectovia-probe-missing-extension')));
      if (load.ok) return { status: 'violated', observed: 'load_extension returned without an error' };
      return /not authori[sz]ed|disabled|not enabled|not allowed/i.test(load.error)
        ? { status: 'proven', observed: load.error }
        : { status: 'unverified', observed: `failed for another reason, so loading may still be on: ${load.error}` };
    }),
  },
  {
    id: 'rollback-across-await', proof: 'behavior', covers: [],
    source: 'store.ts: a failed write leaves nothing; an asynchronous facade must keep that across an await', required: true,
    probe: context => withDatabase(context, async engine => {
      // Not STRICT: this row is about the transaction, and strict-typing covers STRICT on its own.
      await engine.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      // Only a failure at the deliberate duplicate counts; an earlier one would prove nothing.
      let stage = 'begin';
      const failed = await attempt(async () => {
        await engine.exec('BEGIN IMMEDIATE');
        stage = 'first write';
        await engine.run('INSERT INTO t VALUES (?)', 1);
        await new Promise(resolve => setImmediate(resolve));
        stage = 'duplicate';
        await engine.run('INSERT INTO t VALUES (?)', 1);
        stage = 'commit';
        await engine.exec('COMMIT');
      });
      // Unconditional, and judged by the rows left: transaction-state-reported tests the driver's flag.
      const rollback = await attempt(() => engine.exec('ROLLBACK'));
      const count = Number(firstValue(await engine.get('SELECT count(*) AS n FROM t')));
      if (failed.ok) return { status: 'violated', observed: `a duplicate key committed; ${count} rows` };
      if (stage === 'commit') return { status: 'violated', observed: `the duplicate key was accepted, then commit failed: ${failed.error}` };
      if (stage !== 'duplicate') return { status: 'unverified', observed: `failed at ${stage}: ${failed.error}` };
      return count === 0 ? { status: 'proven', observed: failed.error }
        : { status: 'violated', observed: `${count} row left after ROLLBACK (${describe(rollback)}), so the write outlived its transaction` };
    }),
  },
  {
    id: 'transaction-state-reported', proof: 'behavior', covers: ['property isTransaction'],
    source: 'local-store.ts: each failure path rolls back only when isTransaction says a transaction is still open',
    required: true,
    probe: context => withDatabase(context, async engine => {
      await engine.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      // Read without the flag, COMMIT or ROLLBACK succeeding shows a transaction was open, but only
      // where both fail with none open. Each run measures that first instead of assuming it.
      const idle = [await attempt(() => engine.exec('COMMIT')), await attempt(() => engine.exec('ROLLBACK'))];
      const answers: Array<[string, boolean, boolean]> = [];
      const note = (moment: string, expected: boolean) => answers.push([moment, engine.inTransaction(), expected]);
      note('before BEGIN', false);
      await engine.exec('BEGIN');
      note('after BEGIN', true);
      const commit = await attempt(() => engine.exec('COMMIT'));
      note('after COMMIT', false);
      await engine.exec('BEGIN IMMEDIATE');
      let duplicate: Attempt<void>;
      let again: Attempt<void>;
      let rollback: Attempt<void>;
      try {
        await engine.run('INSERT INTO t VALUES (?)', 1);
        note('after a write', true);
        // A failed statement leaves its transaction open. This is the moment W01 reads the flag.
        duplicate = await attempt(() => engine.run('INSERT INTO t VALUES (?)', 1));
        note('after a failed statement', true);
        // What W01's next write meets when its failure path skips ROLLBACK.
        again = await attempt(() => engine.exec('BEGIN IMMEDIATE'));
      } finally { rollback = await attempt(() => engine.exec('ROLLBACK')); }
      note('after ROLLBACK', false);
      const count = Number(firstValue(await engine.get('SELECT count(*) AS n FROM t')));
      if (idle.some(result => result.ok))
        return { status: 'unverified', observed: 'COMMIT or ROLLBACK succeeded with no transaction open, so neither can show one was open' };
      if (!commit.ok) return { status: 'unverified', observed: `COMMIT after BEGIN failed, so no transaction was open: ${commit.error}` };
      if (duplicate.ok) return { status: 'unverified', observed: 'a duplicate key was accepted, so no statement failed' };
      if (again.ok || !rollback.ok || count !== 0) {
        const seen = `second BEGIN IMMEDIATE ${describe(again)}; ROLLBACK ${describe(rollback)}; ${count} rows`;
        return { status: 'unverified', observed: `the transaction did not stay open after the failed statement (${seen})` };
      }
      const wrong = answers.filter(([, answered, expected]) => answered !== expected);
      return wrong.length === 0
        ? { status: 'proven', observed: `the flag tracked ${answers.length} moments, from before BEGIN to after ROLLBACK` }
        : {
          status: 'violated',
          observed: `the flag answered ${wrong.map(([moment, answered]) => `${String(answered)} ${moment}`).join(', ')}; `
            + `a second BEGIN IMMEDIATE inside the failed transaction then failed: ${again.error}`,
        };
    }),
  },
  {
    id: 'read-snapshot-isolation', proof: 'behavior', covers: ['BEGIN'],
    source: "local-store.ts: read() runs a read's statements inside one BEGIN, so they all see one snapshot",
    required: true, isolate: true,
    probe: context => withDatabase(context, async (reader, file) => {
      await reader.get('PRAGMA journal_mode = WAL');
      await reader.exec('CREATE TABLE t (v INTEGER)');
      await reader.run('INSERT INTO t VALUES (?)', 1);
      const writer = await context.factory.open(file);
      try {
        await writer.exec('PRAGMA busy_timeout = 0');
        const rows = async () => Number(firstValue(await reader.get('SELECT count(*) AS n FROM t')));
        await reader.exec('BEGIN');
        let before: number;
        let write: Attempt<void>;
        let during: number;
        try {
          before = await rows();
          write = await attempt(() => writer.run('INSERT INTO t VALUES (?)', 2));
          during = await rows();
        } finally { await attempt(() => reader.exec('COMMIT')); }
        const after = await rows();
        if (!write.ok) return { status: 'unverified', observed: `the other connection could not write during the read: ${write.error}` };
        if (after !== 2) return { status: 'unverified', observed: `the other connection's row never arrived (${after} rows after the read)` };
        return before === during
          ? { status: 'proven', observed: `both reads saw ${before} row; the new row appeared after COMMIT` }
          : { status: 'violated', observed: `one read saw ${before} row and the next, in the same transaction, saw ${during}` };
      } finally { await writer.close(); }
    }),
  },
  {
    id: 'same-engine-schema-reference', proof: 'behavior', covers: [],
    source: 'local-store.ts: inspectSchema compares sqlite_schema with a reference built by the same runtime', required: true,
    probe: async context => {
      const reference = await context.factory.open(':memory:');
      let expected: Row[];
      try {
        await reference.exec(PROBE_SCHEMA);
        expected = await reference.all(SCHEMA_OBJECTS);
      } finally { await reference.close(); }
      return withDatabase(context, async engine => {
        await engine.exec(PROBE_SCHEMA);
        const actual = await engine.all(SCHEMA_OBJECTS);
        return JSON.stringify(actual) === JSON.stringify(expected)
          ? { status: 'proven', observed: `${actual.length} schema objects match` }
          : { status: 'violated', observed: "a file's schema text differs from the same engine's reference" };
      });
    },
  },
  {
    id: 'fts5-module', proof: 'behavior', covers: [],
    source: 'W03 lexical search plans SQLite FTS5; not a W01 guard', required: false,
    probe: context => withDatabase(context, async engine => {
      const fts = await attempt(() => engine.exec('CREATE VIRTUAL TABLE notes USING fts5(body)'));
      return fts.ok ? { status: 'proven', observed: 'fts5 table created' } : { status: 'unsupported', observed: fts.error };
    }),
  },
];

export async function runProtection(protection: Protection, context: ProbeContext): Promise<ProtectionResult> {
  const outcome = await attempt(() => protection.probe(context));
  return outcome.ok
    ? { id: protection.id, proof: protection.proof, ...outcome.value }
    : { id: protection.id, proof: protection.proof, status: 'unverified', observed: `the probe itself failed: ${outcome.error}` };
}

/** Local-store settings no probe covers, each with the reason. */
export const W01_NOT_PROBED: ReadonlyArray<{ covers: string; reason: string }> = [
  {
    covers: 'PRAGMA cache_size',
    reason: 'It caps the page cache in memory. No statement answers differently because of it, and with cache_spill OFF ' +
      'a write may hold more pages than it allows, so a probe cannot observe it.',
  },
];

/**
 * What W01's local store sets or relies on, read from its source text: each PRAGMA, each DatabaseSync
 * option, each property it reads from the connection, each kind of transaction it begins and each
 * SQLite result code it maps.
 */
export function w01Reliances(source: string): string[] {
  const found = new Set<string>();
  for (const [, name] of source.matchAll(/PRAGMA (\w+)/g)) found.add(`PRAGMA ${name}`);
  for (const [, options] of source.matchAll(/DatabaseSync\([^,()]+,\s*\{([^}]*)\}/g))
    for (const [, name] of options.matchAll(/(\w+)\s*:/g)) found.add(`option ${name}`);
  for (const [, name] of source.matchAll(/\bdb\.(\w+)\b(?!\s*\()/g)) found.add(`property ${name}`);
  for (const [, statement] of source.matchAll(/exec\('(BEGIN[^']*)'\)/g)) found.add(statement);
  for (const [, code] of source.matchAll(/errcode\)\s*%\s*256\s*===\s*(\d+)/g)) found.add(`errcode ${code}`);
  return [...found].sort();
}

/** Green only when every required protection was observed working. Anything else keeps SQLite. */
export function conformance(results: readonly ProtectionResult[], protections: readonly Protection[] = W01_PROTECTIONS) {
  const missing = protections.filter(protection => protection.required)
    .filter(protection => results.find(result => result.id === protection.id)?.status !== 'proven')
    .map(protection => protection.id);
  return { verdict: missing.length === 0 ? 'conformant' : 'retain-sqlite', missing } as const;
}

// ---------------------------------------------------------------------------------------------
// Support matrix (TS-006) and documented claims (TS-007)

export type Support = 'supported' | 'unsupported' | 'unknown';
export interface SupportKey { component: string; version: string; platform: string; capability: string }
export interface SupportCell extends SupportKey { status: Support; evidence: string }

const sameKey = (a: SupportKey, b: SupportKey) =>
  a.component === b.component && a.version === b.version && a.platform === b.platform && a.capability === b.capability;

/** Exact lookup. Another version, platform, component or capability never answers for this one. */
export function supportOf(matrix: readonly SupportCell[], key: SupportKey): Support {
  return matrix.find(cell => sameKey(cell, key))?.status ?? 'unknown';
}

export function qualifies(matrix: readonly SupportCell[], required: readonly SupportKey[]) {
  const missing = required.filter(key => supportOf(matrix, key) !== 'supported');
  return { qualifies: missing.length === 0, missing };
}

/** Two cells for one key with different answers mean the matrix itself is unreliable. */
export function matrixConflicts(matrix: readonly SupportCell[]): SupportKey[] {
  return matrix.filter((cell, index) => matrix.some((other, at) => at < index && sameKey(cell, other) && other.status !== cell.status));
}

export interface ComponentClaim { component: string; version: string; topic: string; statement: string; source: string }

/** What one exact library and version documents. Claims about another product are never merged in. */
export function documentedBehavior(claims: readonly ComponentClaim[], component: string, version: string, topic: string) {
  const exact = claims.filter(claim => claim.component === component && claim.version === version && claim.topic === topic);
  const statements = new Set(exact.map(claim => claim.statement));
  const status = exact.length === 0 ? 'unknown' : statements.size > 1 ? 'conflicting' : 'documented';
  return { status, claims: exact } as const;
}

// ---------------------------------------------------------------------------------------------
// Source state (TS-005)

export interface SourceObservation {
  subject: string;
  kind: 'git-main' | 'canonical-doc' | 'release-record';
  ref: string;
  state: 'draft' | 'merged' | 'released';
  observed: string;
}

/** Current source comes from git; dated documents stay dated; only a release record says released. */
export function classifySource(observations: readonly SourceObservation[], subject: string) {
  const about = observations.filter(observation => observation.subject === subject);
  const main = about.filter(observation => observation.kind === 'git-main')
    .sort((a, b) => (a.observed < b.observed ? 1 : a.observed > b.observed ? -1 : 0))[0];
  const release = about.find(observation => observation.kind === 'release-record' && observation.state === 'released');
  return {
    source: main?.state ?? 'unknown',
    sourceRef: main?.ref ?? null,
    dated: about.filter(observation => observation.kind === 'canonical-doc'),
    released: release !== undefined,
    releaseRef: release?.ref ?? null,
  };
}
