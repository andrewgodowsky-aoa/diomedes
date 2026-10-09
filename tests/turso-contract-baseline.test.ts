/**
 * NC-TS TS00 (DIO-227): source, versions and compatibility baseline for Turso and AgentFS,
 * scenarios TS-001 to TS-008 of NC-TS-2026-10-09.1. The real engines stay outside this repository
 * until their notice gate clears. Set NCTS_TURSO_NODE_MODULES to a node_modules holding the pinned
 * packages, and NCTS_PACKAGE_DIR to the unpacked overlay, to rerun the real checks; without them
 * those checks are skipped and only the committed evidence is checked. NCTS_NCUM_ARCHIVE, a copy of
 * the NC-UM archive obtained apart from the overlay, adds the retention rerun. Nothing here admits Turso.
 */
import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { EXPERT_FEATURE, MANAGED_PLAN_IDS, planTemplate } from '../shared/access.js';
import { WORK_STYLES } from '../shared/work-style.js';
import { CREDENTIAL_VARIABLES, refuseNetwork, withoutCredentials } from './fixtures/turso-qualification/offline.js';
import { nodeSqliteFactory, type NodeSqliteDouble } from './fixtures/turso-qualification/probe-engine.js';
import {
  PROBE_SCHEMA, W01_CANDIDATE, W01_NOT_PROBED, W01_PROTECTIONS, admitsAsPatchedSqlite, classifyEngine, classifySource, conformance,
  documentedBehavior, evidenceApplies, identify, loaderOverrides, matrixConflicts, pinDigest, pinInstalled, qualifies, readSqlIdentity,
  redistribution, runProtection, sha256, supportOf, verifyPin, w01OpenCheckPasses, w01Reliances, w01VersionGuardAdmits,
  type ArtifactIdentity, type ArtifactPin, type ComponentClaim, type EngineIdentity, type NoticeFile, type NoticeRecord, type PackagePin,
  type ProtectionResult, type ProtectionStatus, type SourceObservation, type SqlIdentity, type SupportCell, type SupportKey,
} from './fixtures/turso-qualification/qualification.js';
import {
  overlayNamesPrior, priorCases, verifyRetained, type PriorCase, type RetentionRecord,
} from './fixtures/turso-qualification/retention.js';

const PLATFORM = `${process.platform}-${process.arch}`;
const EVIDENCE = path.resolve('evidence', 'turso-qualification', 'ts00');
const RUNNER = path.resolve('tests', 'fixtures', 'turso-qualification', 'run-engine-probes.ts');
const TSX = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');

const engineRoot = process.env.NCTS_TURSO_NODE_MODULES;
const realEngines = engineRoot && existsSync(path.join(engineRoot, '@tursodatabase', 'database', 'package.json'))
  ? path.resolve(engineRoot) : null;
const overlayRoot = process.env.NCTS_PACKAGE_DIR;
const overlayPackage = overlayRoot && existsSync(path.join(overlayRoot, 'baseline', 'RETENTION.json'))
  ? path.resolve(overlayRoot) : null;
const archiveCopy = process.env.NCTS_NCUM_ARCHIVE;
const independentArchive = archiveCopy && existsSync(archiveCopy) ? path.resolve(archiveCopy) : null;

interface EngineRun {
  artifact: ArtifactIdentity; loaderOverrides: string[]; identity: EngineIdentity; protections: ProtectionResult[];
  conformance: { verdict: string; missing: string[] };
}
interface SchemaRun {
  loaderOverrides: string[]; schemaSha256: string; reference: { component: string; version: string; objects: number };
  candidate: { component: string; version: string; objects?: number; error?: string };
  onlyInCandidate?: string[]; onlyInReference?: string[]; sqlTextDiffers?: string[];
}
interface ManifestComponent extends ArtifactPin {
  main: string; artifactDigest: string; packages: Array<PackagePin & { integrity: string | null }>;
  binary: { package: string; file: string; sha256: string; bytes: number } | null;
  sources: Array<{ key: string; repository: string; tag: string | null; commit: string }>;
  notices: NoticeRecord; redistribution: { status: string; reasons: string[] };
}
interface Settled<T> { ok: boolean; value?: T; error?: string; networkAttempts?: string[] }
interface OfflineResult {
  platform: string; loaderOverrides: string[];
  /** Variable names only: the ones removed before the run, and any present while it ran. */
  credentialsRemoved: string[]; credentialsDuringRun: string[];
  localDatabase: Settled<{ lookup: string }>; syncWithNoRemote: Settled<{ lookup: string }>; syncDefaultBootstrap: Settled<{ lookup: string }>;
}
interface AgentfsResult {
  loaderOverrides: string[]; sdk: { name: string; version: string; engineRange: string }; embeddedEngine: ArtifactIdentity;
  identityDirect: EngineIdentity; sqlThroughSdk: SqlIdentity;
  sdkFileOperations: Settled<{ read: string; listed: string[]; removed: boolean }>; sdkKeyValue: Settled<unknown>;
}
interface SourceBaseline {
  app: { base: string }; expertMerge: { pullRequest: number; mergedAt: string };
  observations: SourceObservation[]; releases: { latest: { tag: string; published: string } };
}
interface Recorded { cells: SupportCell[]; claims: ComponentClaim[] }
interface RetentionEvidence {
  retention: RetentionRecord; verified: { ok: boolean; problems: string[]; files: number };
  independentCopy: { bytes: number; sha256: string } | null; priorCases: PriorCase[]; overlayCases: Array<{ id: string; packet: string; status: string }>; overlayNamesPrior: string[];
}

const evidence = <T>(name: string) => JSON.parse(readFileSync(path.join(EVIDENCE, name), 'utf8')) as T;
/** Each engine's evidence is the runner's output for that one artifact, committed as printed. */
const engineRun = (component: string, version: string) => {
  const file = component === 'node:sqlite' ? 'engine-node-sqlite.json' : `engine-${component.replace('@tursodatabase/', 'turso-')}-${version}.json`;
  const run = evidence<EngineRun>(file);
  if (run.artifact.component !== component || run.artifact.version !== version)
    throw new Error(`${file} records ${run.artifact.component}@${run.artifact.version}`);
  return run;
};
const statuses = (run: { protections: ProtectionResult[] }) => Object.fromEntries(run.protections.map(item => [item.id, item.status]));

let scratch: string;
beforeEach(async () => { scratch = await mkdtemp(path.join(os.tmpdir(), 'nectovia-ts00-')); });
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

/** Real engines run in a child process, so a native fault cannot take this worker down. */
function runIn<T>(env: NodeJS.ProcessEnv, ...args: string[]): T {
  const child = spawnSync(process.execPath, [TSX, RUNNER, ...args, '--scratch', scratch], { encoding: 'utf8', timeout: 240_000, env });
  if (child.status !== 0) throw new Error(`the evidence runner failed: ${child.stderr}`);
  return JSON.parse(child.stdout) as T;
}
const runner = <T>(...args: string[]) => runIn<T>(process.env, ...args);
const driver = (root: string, embedded = false) =>
  path.join(root, ...(embedded ? ['agentfs-sdk', 'node_modules'] : []), '@tursodatabase', 'database', 'dist', 'promise.js');
let tursoRun: EngineRun | undefined;
const realTurso = () => (tursoRun ??= runner<EngineRun>('probes', '--driver', driver(realEngines!), '--node-modules', realEngines!));
let agentfsRun: AgentfsResult | undefined;
const realAgentfs = () => (agentfsRun ??= runner<AgentfsResult>('agentfs', '--node-modules', realEngines!));

describe('TS-001 engine family identity', () => {
  const sqlite = { component: 'node:sqlite', version: String(process.versions.sqlite), platform: PLATFORM };
  /** The commit a pinned Turso version was built from, as the manifest records it. */
  const tursoCommit = (version: string) => evidence<{ components: ManifestComponent[] }>('artifact-manifest.json').components
    .flatMap(item => item.sources).find(source => source.key === `turso@v${version}`)?.commit;

  it("identifies the reference engine from its artifact and admits it only at W01's floor", async () => {
    const identity = await identify(nodeSqliteFactory(), sqlite, scratch);
    expect(identity).toMatchObject({
      family: 'sqlite', sqliteCompatibility: sqlite.version, sqliteSourceIdForm: 'sqlite-check-in', reportedBuild: null, writtenFileBuild: null,
      contradictions: [],
    });
    expect(identity.sourceRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(admitsAsPatchedSqlite(identity)).toBe(w01VersionGuardAdmits(sqlite.version));
  });

  it('records a Turso build that reports a patched SQLite version as Turso and never admits it', async () => {
    // The worst case: every SQL identity question answered the way patched SQLite would answer it.
    const forged = await nodeSqliteFactory({ functions: {
      sqlite_version: () => '3.51.3', sqlite_source_id: () => `2026-03-13 10:38:09 ${'a'.repeat(64)}`, turso_version: () => '0.8.2',
    } }).open(':memory:');
    const sql = await readSqlIdentity(forged).finally(() => forged.close());
    expect(w01VersionGuardAdmits(sql.sqliteVersion ?? '')).toBe(true);
    const identity = classifyEngine({ component: '@tursodatabase/database', version: '0.8.2', platform: PLATFORM }, sql, sql);
    expect(identity).toMatchObject({ family: 'turso', version: '0.8.2', sqliteCompatibility: '3.51.3', reportedBuild: '0.8.2', contradictions: [] });
    expect(admitsAsPatchedSqlite(identity)).toBe(false);
  });

  it('refuses an artifact that claims to be SQLite but answers like Turso', async () => {
    const identity = await identify(nodeSqliteFactory({ functions: { turso_version: () => '0.8.2' } }), sqlite, scratch);
    expect(identity.family).toBe('unknown');
    expect(identity.contradictions).not.toEqual([]);
    expect(admitsAsPatchedSqlite(identity)).toBe(false);
  });

  it('asks again on a file the engine wrote, because W01 opens files, not memory', async () => {
    // Answers like SQLite on a new connection, and like another engine only once its own file is reopened.
    const onFiles = nodeSqliteFactory({ rewrite: (sql, location) =>
      (location !== ':memory:' && sql === 'SELECT turso_version() AS v' ? "SELECT '3.47.0' AS v" : sql) });
    const identity = await identify(onFiles, sqlite, scratch);
    expect(identity).toMatchObject({ family: 'unknown', reportedBuild: null, writtenFileBuild: '3.47.0' });
    expect(identity.contradictions).toEqual(['a SQLite artifact answered like another engine on a file it wrote and reopened']);
    expect(admitsAsPatchedSqlite(identity)).toBe(false);
  });

  it('keeps legacy libSQL apart from the new Turso engine', () => {
    const answers = { sqliteVersion: '3.51.3', sqliteSourceId: null, tursoVersion: null };
    const identity = classifyEngine({ component: '@libsql/client', version: '0.15.0', platform: PLATFORM }, answers, answers);
    expect(identity.family).toBe('libsql');
    expect(admitsAsPatchedSqlite(identity)).toBe(false);
  });

  it('records each pinned Turso build by its artifact and source commit, whatever a written file answers', () => {
    for (const version of ['0.8.2', '0.4.4']) {
      const { identity, loaderOverrides: overrides } = engineRun('@tursodatabase/database', version);
      expect(overrides).toEqual([]);
      expect(identity).toMatchObject({ family: 'turso', version, reportedBuild: version, writtenFileBuild: '3.47.0', sqliteSourceIdForm: 'git-commit' });
      // The source id names the pinned upstream commit, which corroborates the build where the version answer does not.
      expect(identity.sourceRevision).toBe(tursoCommit(version));
      expect(identity.contradictions).toEqual([`turso_version() answered 3.47.0 on a file it wrote and reopened; the artifact is ${version}`]);
      expect(identity.sqliteCompatibility).toMatch(/^3\.\d+\.\d+$/);
      expect(admitsAsPatchedSqlite(identity)).toBe(false);
    }
  });

  it.skipIf(!realEngines)('reproduces the recorded identity from the pinned Turso build', () => {
    expect(realTurso().identity).toEqual(engineRun('@tursodatabase/database', '0.8.2').identity);
  }, 240_000);
});

describe('TS-002 pinned dependency provenance', () => {
  const binding = `@tursodatabase/database-${PLATFORM}`;
  const common = '@tursodatabase/database-common';
  const parts = [
    { name: '@tursodatabase/database', files: ['dist/promise.js'] }, { name: common, files: ['dist/index.js'] }, { name: binding, files: ['turso.node'] },
  ];
  const artifact = { component: '@tursodatabase/database', version: '0.8.2', platform: PLATFORM };
  const at = (root: string, name: string) => path.join(root, ...name.split('/'));
  async function place(dir: string, manifest: object, files: Record<string, string>) {
    for (const [file, text] of Object.entries({ 'package.json': JSON.stringify(manifest), ...files })) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text);
    }
  }
  /** The shape Turso installs: the main package requires its common code and loads one platform binding. */
  async function install(root: string, version: string, binary: string) {
    await place(at(root, '@tursodatabase/database'),
      { name: '@tursodatabase/database', version, dependencies: { [common]: version }, optionalDependencies: { [binding]: version } },
      { 'dist/promise.js': 'export const connect = () => null;\n' });
    await place(at(root, common), { name: common, version }, { 'dist/index.js': 'export {};\n' });
    await place(at(root, binding), { name: binding, version }, { 'turso.node': binary });
  }

  it('refuses qualification once the resolved package changes after approval', async () => {
    const root = path.join(scratch, 'node_modules');
    await install(root, '0.8.2', 'approved binary');
    const approved = await pinInstalled(root, artifact, parts);
    const qualified = { artifactDigest: pinDigest(approved) };
    expect(await verifyPin(approved, root)).toEqual({ ok: true, problems: [] });
    expect(evidenceApplies(qualified, await pinInstalled(root, artifact, parts))).toBe(true);
    // The same version number with different bytes: a republished or replaced binding.
    await writeFile(path.join(root, ...binding.split('/'), 'turso.node'), 'replaced binary');
    expect(await verifyPin(approved, root)).toEqual({ ok: false, problems: [`${binding}/turso.node changed`] });
    expect(evidenceApplies(qualified, await pinInstalled(root, artifact, parts))).toBe(false);
    // Another resolved version is refused even with the approved binding bytes restored.
    await install(root, '0.8.3', 'approved binary');
    expect((await verifyPin(approved, root)).problems).toContain('@tursodatabase/database resolved to 0.8.3; approved 0.8.2');
    await rm(path.join(root, '@tursodatabase', 'database', 'dist', 'promise.js'));
    expect((await verifyPin(approved, root)).problems).toContain('@tursodatabase/database/dist/promise.js is missing');
  });

  it('refuses an added binary, a nested package and a shadowing folder, because Node would load them', async () => {
    const root = path.join(scratch, 'node_modules');
    await install(root, '0.8.2', 'approved binary');
    const approved = await pinInstalled(root, artifact, parts);
    const problems = async () => (await verifyPin(approved, root)).problems;
    // Turso's loader tries a binary beside its own index.js before the pinned binding package.
    const local = path.join(at(root, '@tursodatabase/database'), 'turso.win32-x64-msvc.node');
    await writeFile(local, 'another binary');
    expect(await problems()).toEqual(['@tursodatabase/database/turso.win32-x64-msvc.node is not in the approved pin']);
    await rm(local);
    // A copy inside the main package wins Node's lookup over the approved one.
    await place(at(root, `@tursodatabase/database/node_modules/${common}`), { name: common, version: '0.8.2' }, { 'dist/index.js': 'export const changed = 1;\n' });
    expect(await problems()).toEqual([
      `@tursodatabase/database/node_modules/${common} is not in the approved pin`,
      `@tursodatabase/database resolves @tursodatabase/database/node_modules/${common}, which is not in the approved pin`,
      `@tursodatabase/database no longer resolves ${common}`,
    ]);
    await rm(at(root, '@tursodatabase/database/node_modules'), { recursive: true });
    // So does a copy in a node_modules folder beside the scope, which no approved package directory contains.
    await place(at(root, `@tursodatabase/node_modules/${common}`), { name: common, version: '0.8.2' }, { 'dist/index.js': 'export {};\n' });
    expect(await problems()).toEqual([
      `@tursodatabase/database resolves @tursodatabase/node_modules/${common}, which is not in the approved pin`,
      `@tursodatabase/database no longer resolves ${common}`,
    ]);
    await rm(at(root, '@tursodatabase/node_modules'), { recursive: true });
    expect(await verifyPin(approved, root)).toEqual({ ok: true, problems: [] });
  });

  it('records any variable that would make the Turso loader load another binary, and none was set', () => {
    expect(loaderOverrides({})).toEqual([]);
    expect(loaderOverrides({ NAPI_RS_NATIVE_LIBRARY_PATH: 'elsewhere.node', NAPI_RS_FORCE_WASI: '1', PATH: 'unrelated' }))
      .toEqual(['NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI']);
    for (const file of ['engine-node-sqlite.json', 'engine-turso-database-0.8.2.json', 'engine-turso-database-0.4.4.json',
      'schema-turso-database-0.8.2.json', 'schema-turso-database-0.4.4.json', 'offline-start.json', 'agentfs-sdk.json'])
      expect(evidence<{ loaderOverrides: string[] }>(file).loaderOverrides, file).toEqual([]);
  });

  it('names the actual binary, source and notices for every pinned component', () => {
    const { components } = evidence<{ components: ManifestComponent[] }>('artifact-manifest.json');
    expect(components.map(item => `${item.component}@${item.version}`))
      .toEqual(['@tursodatabase/database@0.8.2', '@tursodatabase/sync@0.8.2', 'agentfs-sdk@0.6.4', '@tursodatabase/database@0.4.4']);
    for (const component of components) {
      expect(component.artifactDigest).toBe(pinDigest(component));
      expect(component.sources.length).toBeGreaterThan(0);
      for (const source of component.sources) expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
      for (const item of component.packages) expect(item.integrity).toMatch(/^sha512-/);
      // Every installed package is accounted for by license, not only the ones the component is named after.
      expect(component.notices.licenses.map(item => item.package)).toEqual(component.packages.map(item => `${item.name}@${item.version}`));
      expect(redistribution(component.notices)).toEqual(component.redistribution);
      if (component.component === 'agentfs-sdk') continue;
      // The binary is one of the pinned files, so a replaced binary changes the artifact digest.
      expect(component.binary?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(component.packages.find(item => item.name === component.binary?.package)?.files[component.binary?.file ?? ''])
        .toBe(component.binary?.sha256);
    }
  });

  it('pins what each component actually loads, not only the packages it is named after', () => {
    const installed = (main: string) => evidence<{ components: ManifestComponent[] }>('artifact-manifest.json').components
      .find(item => item.main === main)?.packages.map(item => item.name) ?? [];
    expect(installed('@tursodatabase/sync')).toEqual(expect.arrayContaining(['@tursodatabase/sync-common', '@tursodatabase/serverless']));
    // The recording is win32-x64, so the embedded engine's binding is the msvc build.
    expect(installed('agentfs-sdk')).toEqual(expect.arrayContaining([
      'buffer', 'base64-js', 'ieee754', 'agentfs-sdk/node_modules/@tursodatabase/database', 'agentfs-sdk/node_modules/@tursodatabase/database-win32-x64-msvc']));
  });

  it('keeps vendoring closed until every package has its own license text and every notice is carried', () => {
    const { components } = evidence<{ components: ManifestComponent[] }>('artifact-manifest.json');
    expect(Object.fromEntries(components.map(item => [`${item.component}@${item.version}`, item.redistribution.status]))).toEqual({
      '@tursodatabase/database@0.8.2': 'needs-bundled-notices', '@tursodatabase/sync@0.8.2': 'needs-bundled-notices',
      'agentfs-sdk@0.6.4': 'blocked', '@tursodatabase/database@0.4.4': 'needs-bundled-notices',
    });
    for (const { component, version, notices } of components.filter(item => item.redistribution.status !== 'blocked')) {
      const label = `${component}@${version}`;
      expect(redistribution({ ...notices, bundled: notices.upstream }).status, label).toBe('ready');
      // Leaving out any text that no other required file carries reopens it; an identical copy still counts.
      const sharing = (file: NoticeFile) => notices.upstream.filter(other => other.sha256 === file.sha256).length;
      for (const left of notices.upstream) {
        const status = redistribution({ ...notices, bundled: notices.upstream.filter(file => file !== left) }).status;
        expect(status, `${label} without ${left.path}`).toBe(sharing(left) === 1 ? 'needs-bundled-notices' : 'ready');
      }
    }
    // Two sources ship one identical license text: both are listed, and one carried copy satisfies both.
    const sync = components[1].notices.upstream.filter(file => file.path.endsWith('/LICENSE.md')).map(file => file.path);
    expect(sync).toEqual(['turso@v0.8.2/LICENSE.md', '@tursodatabase/serverless@0.2.4/LICENSE.md']);
    // The SDK's dependencies ship their own license files; none of them is the SDK's.
    const sdk = components[2];
    expect(sdk.notices.shipped.length).toBeGreaterThan(0);
    expect(sdk.redistribution.reasons).toEqual(['agentfs-sdk@0.6.4 declares MIT, but neither its pinned source nor the package carries that text']);
    expect(redistribution({ ...sdk.notices, bundled: [...sdk.notices.upstream, ...sdk.notices.shipped] }).status).toBe('blocked');
  });

  it.skipIf(!realEngines)('finds the installed packages byte for byte as approved', async () => {
    for (const component of evidence<{ components: ManifestComponent[] }>('artifact-manifest.json').components)
      expect(await verifyPin(component, realEngines!), `${component.component}@${component.version}`).toEqual({ ok: true, problems: [] });
  });

  it.skipIf(!realEngines)('reproduces the recorded manifest, every loaded package included, from the pinned install', () => {
    expect(runner('manifest', '--node-modules', realEngines!, '--lock', path.join(EVIDENCE, 'probe-install', 'probe.package-lock.json'),
      '--notices', path.join(EVIDENCE, 'upstream-notices.json'))).toEqual(evidence('artifact-manifest.json'));
  }, 240_000);
});

describe('TS-003 SQLite protective checks', () => {
  const probe = async (double: NodeSqliteDouble = {}) => {
    const context = { factory: nodeSqliteFactory(double), scratch };
    const results: ProtectionResult[] = [];
    for (const protection of W01_PROTECTIONS) results.push(await runProtection(protection, context));
    return results;
  };
  const ignoring = (pattern: RegExp): NodeSqliteDouble => ({ intercept: sql => (pattern.test(sql) ? [] : undefined) });
  const answering = (statement: string, row: Record<string, unknown>): NodeSqliteDouble =>
    ({ intercept: sql => (sql === statement ? [row] : undefined) });

  it('proves every protection on the reference engine', async () => {
    const results = await probe();
    expect(results.filter(result => result.status !== 'proven')).toEqual([]);
    expect(conformance(results)).toEqual({ verdict: 'conformant', missing: [] });
  });

  it('does not mark a driver green when it silently ignores foreign_key_check and trusted_schema', async () => {
    const results = await probe(ignoring(/^PRAGMA (foreign_key_check|trusted_schema)\b/));
    expect(statuses({ protections: results })).toMatchObject({
      'foreign-key-check-detects-orphan': 'violated', 'trusted-schema-off': 'unverified', 'trusted-schema-refuses-unsafe-function': 'violated',
    });
    expect(conformance(results)).toEqual({
      verdict: 'retain-sqlite', missing: ['foreign-key-check-detects-orphan', 'trusted-schema-off', 'trusted-schema-refuses-unsafe-function'],
    });
  });

  it('marks the rows that only read a setting back, and records the mark with every result', () => {
    expect(W01_PROTECTIONS.filter(item => item.proof === 'readback').map(item => item.id)).toEqual([
      'foreign-keys-on', 'trusted-schema-off', 'busy-timeout', 'synchronous-full', 'cache-spill-off', 'journal-size-limit', 'wal-mode',
      'wal-autocheckpoint',
    ]);
    for (const run of [engineRun('node:sqlite', '3.51.3'), engineRun('@tursodatabase/database', '0.8.2'), engineRun('@tursodatabase/database', '0.4.4')])
      expect(run.protections.map(item => [item.id, item.proof])).toEqual(W01_PROTECTIONS.map(item => [item.id, item.proof]));
  });

  it('reads the settings, options, flags, transactions and result codes a local store relies on', () => {
    const source = [
      'new DatabaseSync(file, { readOnly: true, allowExtension: false });',
      "db.exec('PRAGMA busy_timeout = 100'); db.exec('BEGIN IMMEDIATE');",
      "if (this.db.isTransaction) this.db.exec('ROLLBACK');",
      "if (Number(error.errcode) % 256 === 13) return 'memory_capacity';",
    ].join('\n');
    expect(w01Reliances(source)).toEqual([
      'BEGIN IMMEDIATE', 'PRAGMA busy_timeout', 'errcode 13', 'option allowExtension', 'option readOnly', 'property isTransaction',
    ]);
  });

  const localStore = spawnSync('git', ['cat-file', 'blob', W01_CANDIDATE.blobs['server/memory/local-store.ts']], { encoding: 'utf8' });
  it.skipIf(localStore.status !== 0)("probes, or names with a reason, everything W01's local store relies on", () => {
    const relied = w01Reliances(localStore.stdout);
    const covered = [...W01_PROTECTIONS.flatMap(item => item.covers), ...W01_NOT_PROBED.map(item => item.covers)];
    expect(relied.filter(token => !covered.includes(token))).toEqual([]);
    // Nothing claims to cover something the store does not use.
    expect([...new Set(covered)].filter(token => !relied.includes(token))).toEqual([]);
    expect(W01_NOT_PROBED.every(item => item.reason.length > 0)).toBe(true);
  });

  it("shows W01's own open check passing vacuously on that driver while an orphan exists", async () => {
    const openCheckWithOrphan = async (double: NodeSqliteDouble, name: string) => {
      const engine = await nodeSqliteFactory(double).open(path.join(scratch, `${name}.db`));
      try {
        await engine.exec('PRAGMA foreign_keys = OFF');
        await engine.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent (id));');
        await engine.run('INSERT INTO child VALUES (?)', 43);
        return await w01OpenCheckPasses(engine);
      } finally { await engine.close(); }
    };
    expect(await openCheckWithOrphan({}, 'reference')).toBe(false);
    expect(await openCheckWithOrphan(ignoring(/^PRAGMA foreign_key_check\b/), 'silent')).toBe(true);
  });

  /** A setting that reads back as set but was never applied. */
  const readsBackOnly = (set: string, read: string, row: Record<string, unknown>): NodeSqliteDouble =>
    ({ intercept: sql => (sql === set ? [] : sql === read ? [row] : undefined) });
  /** Loosens one constraint in every file's schema, and leaves the in-memory reference as written. */
  const fileSchemaDrift = (): NodeSqliteDouble => ({ rewrite: (sql, location) =>
    (sql === PROBE_SCHEMA && location !== ':memory:' ? sql.replace('payload TEXT NOT NULL', 'payload TEXT') : sql) });
  /** Keeps a failure's message and drops the SQLite result code W01 maps. */
  const withoutResultCode = (): NodeSqliteDouble => ({ failure: error => new Error(error instanceof Error ? error.message : String(error)) });

  // Each required guard removed on its own, through the same driver seam a real engine would use. The whole set
  // runs against each one: the guard's own probe must report the status given, and only the rows listed after it
  // may stop being proven.
  type Defeat = [id: string, how: string, double: () => NodeSqliteDouble, status: ProtectionStatus, collateral: Record<string, ProtectionStatus>];
  const defeated: Defeat[] = [
    ['strict-typing', 'STRICT removed', () => ({ rewrite: sql => sql.replace(/\)\s*STRICT;/g, ');') }), 'violated', {}],
    ['check-constraints', 'CHECK removed', () => ({ rewrite: sql => sql.replace(/\s*CHECK\(access_epoch >= 0\)/g, '') }), 'violated', {}],
    ['foreign-keys-on', 'setting not kept', () => answering('PRAGMA foreign_keys', { foreign_keys: 0 }), 'violated', {}],
    ['scoped-composite-foreign-key', 'scope reference removed', () => ({ rewrite: sql =>
      sql.replace(/,\s*FOREIGN KEY \(tenant_id, workspace_id, scope_ref\) REFERENCES memory_scopes \(tenant_id, workspace_id, scope_ref\)/g, '') }),
    'violated', {}],
    ['deferred-event-command-key', 'deferral removed', () => ({ rewrite: sql => sql.replace(/\s*DEFERRABLE INITIALLY DEFERRED/g, '') }), 'violated', {}],
    ['immutable-rows', 'triggers removed', () => ({ rewrite: sql => sql.replace(/CREATE TRIGGER memory_entries_immutable_\w+[\s\S]*?END;/g, '') }),
      'violated', {}],
    ['monotonic-epoch', 'trigger removed', () => ({ rewrite: sql => sql.replace(/CREATE TRIGGER memory_epochs_monotonic[\s\S]*?END;/g, '') }),
      'violated', {}],
    ['foreign-key-check-detects-orphan', 'check answers nothing', () => ignoring(/^PRAGMA foreign_key_check$/), 'violated', {}],
    ['trusted-schema-off', 'setting not kept', () => answering('PRAGMA trusted_schema', { trusted_schema: 1 }), 'violated', {}],
    // The readback row stays proven: only the refusal shows the setting never took effect.
    ['trusted-schema-refuses-unsafe-function', 'reads back OFF, never applied',
      () => readsBackOnly('PRAGMA trusted_schema = OFF', 'PRAGMA trusted_schema', { trusted_schema: 0 }), 'violated', {}],
    ['busy-timeout', 'setting not kept', () => answering('PRAGMA busy_timeout', { timeout: 0 }), 'violated', {}],
    ['busy-timeout-waits', 'reads back 100, never applied',
      () => readsBackOnly('PRAGMA busy_timeout = 100', 'PRAGMA busy_timeout', { timeout: 100 }), 'violated', {}],
    ['synchronous-full', 'setting not kept', () => answering('PRAGMA synchronous', { synchronous: 1 }), 'violated', {}],
    ['cache-spill-off', 'setting not kept', () => answering('PRAGMA cache_spill', { cache_spill: 1 }), 'violated', {}],
    // No write is refused, so there is no full-database error to read a code from.
    ['max-page-count-ceiling', 'ceiling ignored', () => ignoring(/^PRAGMA max_page_count = \d+$/), 'violated', { 'capacity-error-code': 'unverified' }],
    ['capacity-error-code', 'error without its result code', withoutResultCode, 'violated', {}],
    ['journal-size-limit', 'setting not kept', () => answering('PRAGMA journal_size_limit', { journal_size_limit: -1 }), 'violated', {}],
    // No WAL file to count or truncate, and in rollback mode the reader's open transaction blocks the writer.
    ['wal-mode', 'journal stays in rollback mode', () => answering('PRAGMA journal_mode = WAL', { journal_mode: 'delete' }), 'violated',
      { 'wal-checkpoint-truncate': 'violated', 'wal-frame-accounting': 'violated', 'read-snapshot-isolation': 'unverified' }],
    ['wal-autocheckpoint', 'setting not kept', () => answering('PRAGMA wal_autocheckpoint', { wal_autocheckpoint: 1000 }), 'violated', {}],
    ['wal-checkpoint-truncate', 'checkpoint skipped',
      () => answering('PRAGMA wal_checkpoint(TRUNCATE)', { busy: 0, log: 0, checkpointed: 0 }), 'violated', {}],
    // wal-mode reads back 'wal' and stays proven; the file and the second connection show the journal never changed.
    ['wal-frame-accounting', 'WAL claimed but never written', () => answering('PRAGMA journal_mode = WAL', { journal_mode: 'wal' }), 'violated',
      { 'wal-checkpoint-truncate': 'violated', 'read-snapshot-isolation': 'unverified' }],
    ['application-id-user-version', 'header not kept', () => answering('PRAGMA application_id', { application_id: 0 }), 'violated', {}],
    ['immediate-write-exclusion', 'BEGIN IMMEDIATE taken as BEGIN', () => ({ rewrite: sql => (sql === 'BEGIN IMMEDIATE' ? 'BEGIN' : sql) }),
      'violated', {}],
    ['quick-check-detects-corruption', 'check always ok', () => answering('PRAGMA quick_check', { quick_check: 'ok' }), 'violated', {}],
    ['read-only-inspection', 'opened writable', () => ({ readOnly: () => false }), 'violated', {}],
    ['double-quoted-identifiers-only', 'double quotes read as text', () => ({ rewrite: sql =>
      sql.replace('"nectovia_probe_missing"', "'nectovia_probe_missing'") }), 'violated', {}],
    ['extension-loading-off', 'loading allowed',
      () => ({ intercept: sql => (sql.startsWith('SELECT load_extension') ? [{ v: null }] : undefined) }), 'violated', {}],
    // Every probe that ends its transaction with ROLLBACK keeps it open instead.
    ['rollback-across-await', 'rollback skipped', () => ignoring(/^ROLLBACK$/), 'violated',
      { 'deferred-event-command-key': 'violated', 'immediate-write-exclusion': 'unverified', 'transaction-state-reported': 'unverified' }],
    ['transaction-state-reported', 'flag always false, as Turso 0.4.4 answers', () => ({ transactionState: () => false }), 'violated', {}],
    // transaction-state-reported opens with a plain BEGIN as well.
    ['read-snapshot-isolation', 'BEGIN ignored', () => ignoring(/^BEGIN$/), 'violated', { 'transaction-state-reported': 'unverified' }],
    ['same-engine-schema-reference', "a file's schema differs from the reference", fileSchemaDrift, 'violated', {}],
  ];

  it('defeats every required protection in the table, in order', () => {
    expect(defeated.map(([id]) => id)).toEqual(W01_PROTECTIONS.filter(item => item.required).map(item => item.id));
  });

  it.each(defeated)('notices %s when it is defeated (%s), and breaks only what it names', async (id, _how, double, status, collateral) => {
    const results = await probe(double());
    const notProven = Object.fromEntries(results.filter(result => result.status !== 'proven').map(result => [result.id, result.status]));
    expect(notProven).toEqual({ [id]: status, ...collateral });
  }, 60_000);

  it('does not take COMMIT or ROLLBACK as evidence where they succeed with no transaction open', async () => {
    // A driver that answers both silently when nothing is open, and passes them through inside a transaction.
    let open = false;
    const lenient: NodeSqliteDouble = {
      intercept: sql => {
        if (/^BEGIN\b/.test(sql)) open = true;
        if (sql !== 'COMMIT' && sql !== 'ROLLBACK') return undefined;
        if (!open) return [];
        open = false;
        return undefined;
      },
    };
    const flag = W01_PROTECTIONS.find(item => item.id === 'transaction-state-reported');
    expect(flag).toBeDefined();
    expect(await runProtection(flag!, { factory: nodeSqliteFactory(lenient), scratch })).toMatchObject({
      status: 'unverified', observed: expect.stringContaining('with no transaction open'),
    });
  });

  it('records both Turso builds as retaining SQLite, with each missing guard named', () => {
    const turso = engineRun('@tursodatabase/database', '0.8.2');
    expect(conformance(turso.protections)).toEqual(turso.conformance);
    expect(turso.conformance).toEqual({ verdict: 'retain-sqlite', missing: [
      'foreign-key-check-detects-orphan', 'trusted-schema-off', 'trusted-schema-refuses-unsafe-function', 'capacity-error-code',
      'journal-size-limit', 'wal-autocheckpoint', 'double-quoted-identifiers-only'] });
    expect(statuses(turso)).toMatchObject({
      'foreign-key-check-detects-orphan': 'violated', 'trusted-schema-off': 'unverified', 'trusted-schema-refuses-unsafe-function': 'unverified',
      'capacity-error-code': 'violated', 'busy-timeout-waits': 'proven', 'immediate-write-exclusion': 'proven',
      'transaction-state-reported': 'proven', 'read-snapshot-isolation': 'proven', 'fts5-module': 'unsupported',
    });
    const embedded = engineRun('@tursodatabase/database', '0.4.4');
    expect(conformance(embedded.protections)).toEqual(embedded.conformance);
    expect(embedded.conformance).toEqual({ verdict: 'retain-sqlite', missing: [
      'strict-typing', 'check-constraints', 'scoped-composite-foreign-key', 'deferred-event-command-key', 'immutable-rows', 'monotonic-epoch',
      'foreign-key-check-detects-orphan', 'trusted-schema-off', 'trusted-schema-refuses-unsafe-function', 'synchronous-full',
      'capacity-error-code', 'journal-size-limit', 'wal-autocheckpoint', 'quick-check-detects-corruption', 'double-quoted-identifiers-only',
      'transaction-state-reported', 'same-engine-schema-reference'] });
    // The flag W01's failure paths read never reports an open transaction, so a failed write would leave one open.
    expect(statuses(embedded)).toMatchObject({ 'transaction-state-reported': 'violated', 'rollback-across-await': 'proven' });
    expect(engineRun('node:sqlite', '3.51.3').conformance).toEqual({ verdict: 'conformant', missing: [] });
  });

  it("records that W01's schema builds on Turso 0.8.2 with different stored text, and not at all on 0.4.4", () => {
    const current = evidence<SchemaRun>('schema-turso-database-0.8.2.json');
    expect(current.candidate).toMatchObject({ component: '@tursodatabase/database', version: '0.8.2', objects: current.reference.objects });
    expect([current.onlyInCandidate, current.onlyInReference]).toEqual([[], []]);
    // inspectSchema compares stored text, so a file one engine built fails closed under the other.
    expect(current.sqlTextDiffers?.length).toBeGreaterThan(0);
    const embedded = evidence<SchemaRun>('schema-turso-database-0.4.4.json');
    expect(embedded.schemaSha256).toBe(current.schemaSha256);
    expect(embedded.candidate).toMatchObject({ version: '0.4.4', error: expect.stringMatching(/STRICT/) });
  });

  it.skipIf(!realEngines)('reproduces every recorded protection status on the pinned Turso build', () => {
    expect(statuses(realTurso())).toEqual(statuses(engineRun('@tursodatabase/database', '0.8.2')));
  }, 240_000);

  it.skipIf(!realEngines)("rebuilds W01's pinned schema on Turso 0.8.2 with the recorded result", async () => {
    // Straight from the pinned blob, so the rerun cannot use a stale copy of the schema.
    const blob = spawnSync('git', ['cat-file', 'blob', W01_CANDIDATE.blobs['server/memory/schema.ts']], { encoding: 'utf8' });
    expect(blob.status, 'the W01 schema blob must be in this clone').toBe(0);
    const schemaModule = path.join(scratch, 'w01-schema.ts');
    await writeFile(schemaModule, blob.stdout);
    expect(runner<SchemaRun>('schema', '--driver', driver(realEngines!), '--node-modules', realEngines!, '--schema-module', schemaModule))
      .toEqual(evidence<SchemaRun>('schema-turso-database-0.8.2.json'));
  }, 240_000);
});

describe('TS-004 free native bootstrap', () => {
  it('refuses the network for real, so an empty attempt list means something, and puts every entry point back', async () => {
    const entryPoints = (): Array<[string, unknown]> => [
      ['fetch', globalThis.fetch], ['net.connect', net.connect], ['net.createConnection', net.createConnection],
      ['tls.connect', tls.connect], ['http.request', http.request], ['http.get', http.get], ['https.request', https.request],
      ['https.get', https.get], ['dns.lookup', dns.lookup], ['dns.resolve', dns.resolve], ['dns.resolve4', dns.resolve4],
      ['dns.resolve6', dns.resolve6],
    ];
    const before = entryPoints();
    const refusal = refuseNetwork();
    try {
      await expect(fetch('https://nectovia-probe.invalid/')).rejects.toThrow('network is refused');
      expect(() => net.connect(9, '127.0.0.1')).toThrow('refused');
      expect(refusal.attempts).toEqual(['fetch https://nectovia-probe.invalid/', 'net.connect']);
      // Every entry point really was replaced, so the check below is not vacuous.
      const during = entryPoints();
      expect(during.filter(([, value], index) => value === before[index][1]).map(([name]) => name)).toEqual([]);
    } finally { refusal.restore(); }
    // The process keeps no refused entry point once the check ends.
    expect(entryPoints().filter(([, value], index) => value !== before[index][1]).map(([name]) => name)).toEqual([]);
  });

  it('creates and finds a free local project with the network refused and no account credentials', async () => {
    // Set first, so finding it gone shows the removal worked rather than that nothing was there.
    const sentinel = 'NECTOVIA_PROBE_TOKEN';
    const previous = process.env[sentinel];
    process.env[sentinel] = 'set by this test';
    let afterRestore: string | undefined;
    const refusal = refuseNetwork();
    const restore = withoutCredentials();
    try {
      expect(process.env[sentinel]).toBeUndefined();
      const data = path.join(scratch, 'data');
      const projects = path.join(scratch, 'projects');
      const store = new Store(data, projects);
      await store.init();
      const project = await store.createProject('Free local work');
      expect(store.state(project.id).project.name).toBe('Free local work');
      const reopened = new Store(data, projects);
      await reopened.init();
      expect(reopened.state(project.id).project.folder).toBe(project.folder);
      expect(existsSync(path.join(data, 'accounts', 'remembered.json'))).toBe(false);
      expect(Object.keys(process.env).filter(key => CREDENTIAL_VARIABLES.test(key))).toEqual([]);
      expect(refusal.attempts).toEqual([]);
    } finally {
      refusal.restore();
      restore();
      afterRestore = process.env[sentinel];
      if (previous === undefined) delete process.env[sentinel];
      else process.env[sentinel] = previous;
    }
    expect(afterRestore).toBe('set by this test');
  });

  it('opens the reference memory engine and answers an exact lookup offline', async () => {
    const refusal = refuseNetwork();
    try {
      const engine = await nodeSqliteFactory().open(path.join(scratch, 'memory.db'));
      try {
        await engine.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT');
        await engine.run('INSERT INTO notes VALUES (?, ?)', 'note-1', 'kept on this computer');
        expect(await engine.get('SELECT body FROM notes WHERE id = ?', 'note-1')).toEqual({ body: 'kept on this computer' });
      } finally { await engine.close(); }
      expect(refusal.attempts).toEqual([]);
    } finally { refusal.restore(); }
  });

  it('records that the Turso engine starts offline, and the sync SDK only without a remote', () => {
    const result = evidence<OfflineResult>('offline-start.json');
    // The recording set one marker variable, so an empty list during the run shows the removal worked.
    expect(result.credentialsRemoved).toEqual(['NECTOVIA_PROBE_TOKEN']);
    expect(result.credentialsDuringRun).toEqual([]);
    expect(result.localDatabase).toEqual({ ok: true, value: { lookup: 'kept on this computer' }, networkAttempts: [] });
    expect(result.syncWithNoRemote).toEqual({ ok: true, value: { lookup: 'kept on this computer' }, networkAttempts: [] });
    expect(result.syncDefaultBootstrap.ok).toBe(false);
    expect(result.syncDefaultBootstrap.networkAttempts).not.toEqual([]);
  });

  it.skipIf(!realEngines)('reproduces the offline start on the pinned packages, removing a variable that was set', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !CREDENTIAL_VARIABLES.test(key)));
    expect(runIn<OfflineResult>({ ...env, NECTOVIA_PROBE_TOKEN: 'set by this test' }, 'offline', '--node-modules', realEngines!))
      .toEqual(evidence<OfflineResult>('offline-start.json'));
  }, 240_000);
});

describe('TS-005 runtime source drift', () => {
  const merged: SourceObservation = {
    subject: 'expert-tier', kind: 'git-main', ref: '92bc57bd678865390f17291beb382642769e73e5', state: 'merged', observed: '2026-10-09T13:58:07Z',
  };
  const draft: SourceObservation = {
    subject: 'expert-tier', kind: 'canonical-doc', ref: 'Live Roadmap 2026-10-06.1', state: 'draft', observed: '2026-10-09T13:58:07Z',
  };

  it('keeps Expert eligible on every Managed plan in current source', () => {
    expect(WORK_STYLES).toContain('expert');
    for (const planId of MANAGED_PLAN_IDS) expect(planTemplate(planId)?.features).toContain(EXPERT_FEATURE);
  });

  it('classifies the merge as current source and keeps the dated draft dated', () => {
    expect(classifySource([draft, merged], 'expert-tier')).toEqual({ source: 'merged', sourceRef: merged.ref, dated: [draft], released: false, releaseRef: null });
  });

  it('claims a release only from a release record, never from a merge or a document', () => {
    expect(classifySource([merged, { ...draft, state: 'released' }], 'expert-tier').released).toBe(false);
    const record: SourceObservation = { subject: 'expert-tier', kind: 'release-record', ref: 'a later tag', state: 'released', observed: '2026-11-01T00:00:00Z' };
    expect(classifySource([merged, record], 'expert-tier')).toMatchObject({ released: true, releaseRef: 'a later tag' });
  });

  it('records this base as merged source, dated documents as draft, and no release containing Expert', () => {
    const baseline = evidence<SourceBaseline>('source-baseline.json');
    const classified = classifySource(baseline.observations, 'expert-tier');
    expect(classified).toMatchObject({ source: 'merged', sourceRef: baseline.app.base, released: false });
    expect(classified.dated.length).toBeGreaterThan(0);
    expect(classified.dated.every(item => item.state === 'draft')).toBe(true);
    expect(Date.parse(baseline.releases.latest.published)).toBeLessThan(Date.parse(baseline.expertMerge.mergedAt));
  });
});

describe('TS-006 Windows CLI versus sandbox', () => {
  const isolation: SupportKey = { component: 'agentfs-cli', version: '0.6.4', platform: 'win32-x64', capability: 'native-run-isolation' };
  const files: SupportKey = { component: 'agentfs-sdk', version: '0.6.4', platform: 'win32-x64', capability: 'sdk-file-operations' };
  const recorded = () => evidence<Recorded>('support-matrix.json');

  it('keeps the Windows sandbox unqualified when SDK files and basic CLI commands work', () => {
    const installed: SupportCell = { component: 'agentfs-cli', version: '0.6.4', platform: 'win32-x64', capability: 'basic-commands', status: 'supported', evidence: 'TS-006 setup' };
    expect(supportOf(recorded().cells, files)).toBe('supported');
    expect(qualifies([...recorded().cells, installed], [isolation, files])).toEqual({ qualifies: false, missing: [isolation] });
  });

  it('answers only for the exact component, version, platform and capability', () => {
    const { cells } = recorded();
    expect(matrixConflicts(cells)).toEqual([]);
    expect(supportOf(cells, { ...files, version: '0.6.5' })).toBe('unknown');
    expect(supportOf(cells, { ...files, platform: 'linux-x64' })).toBe('unknown');
    expect(supportOf(cells, { ...files, capability: 'native-run-isolation' })).toBe('unknown');
    expect(supportOf(cells, { ...isolation, platform: 'linux-x64' })).toBe('unknown');
  });

  it('records a published Windows CLI build while its run isolation stays undocumented and unknown', () => {
    const { cells, claims } = recorded();
    expect(supportOf(cells, { ...isolation, capability: 'published-build' })).toBe('supported');
    expect(supportOf(cells, isolation)).toBe('unknown');
    expect(documentedBehavior(claims, 'agentfs-cli', '0.6.4', 'run-isolation:linux').status).toBe('documented');
    expect(documentedBehavior(claims, 'agentfs-cli', '0.6.4', 'run-isolation:macos').status).toBe('documented');
    expect(documentedBehavior(claims, 'agentfs-cli', '0.6.4', 'run-isolation:windows').status).toBe('unknown');
  });

  it('records SDK file support on Windows from an actual run', () => {
    expect(evidence<AgentfsResult>('agentfs-sdk.json').sdkFileOperations).toEqual({ ok: true, value: { read: 'alpha', listed: ['a.txt'], removed: true } });
  });

  it.skipIf(!realEngines)('reproduces SDK file support on the pinned AgentFS SDK', () => {
    expect(realAgentfs().sdkFileOperations).toEqual(evidence<AgentfsResult>('agentfs-sdk.json').sdkFileOperations);
  }, 240_000);
});

describe('TS-007 sync documentation divergence', () => {
  it("never merges one product's documented behaviour into another", () => {
    const claims: ComponentClaim[] = [
      { component: '@tursodatabase/sync', version: '0.8.2', topic: 'offline-conflict', statement: 'statement A', source: 'TS-007 setup' },
      { component: 'agentfs-cli', version: '0.6.4', topic: 'offline-conflict', statement: 'statement B', source: 'TS-007 setup' },
    ];
    expect(documentedBehavior(claims, '@tursodatabase/sync', '0.8.2', 'offline-conflict')).toEqual({ status: 'documented', claims: [claims[0]] });
    expect(documentedBehavior(claims, 'agentfs-cli', '0.6.4', 'offline-conflict')).toEqual({ status: 'documented', claims: [claims[1]] });
    expect(documentedBehavior(claims, '@tursodatabase/sync', '0.8.3', 'offline-conflict').status).toBe('unknown');
    expect(documentedBehavior([...claims, { ...claims[0], statement: 'statement C' }], '@tursodatabase/sync', '0.8.2', 'offline-conflict').status)
      .toBe('conflicting');
  });

  it('leaves conflict behaviour unqualified until the pinned library is tested', () => {
    const { cells, claims } = evidence<Recorded>('support-matrix.json');
    expect(supportOf(cells, { component: '@tursodatabase/sync', version: '0.8.2', platform: 'win32-x64', capability: 'offline-conflict-replay' }))
      .toBe('unknown');
    for (const [component, version] of [['@tursodatabase/sync', '0.8.2'], ['agentfs-cli', '0.6.4'], ['agentfs-sdk', '0.6.4']])
      expect(documentedBehavior(claims, component, version, 'offline-conflict').status).toBe('unknown');
    // The pinned sync library documents a hook for an application's own conflict strategy, not its default behaviour.
    expect(documentedBehavior(claims, '@tursodatabase/sync', '0.8.2', 'conflict-transform-hook').status).toBe('documented');
    // AgentFS documents libSQL's encryption; neither Turso engine inherits that claim.
    expect(documentedBehavior(claims, 'agentfs-cli', '0.6.4', 'encryption-at-rest').status).toBe('documented');
    for (const version of ['0.4.4', '0.8.2'])
      expect(documentedBehavior(claims, '@tursodatabase/database', version, 'encryption-at-rest').status).toBe('unknown');
  });

  it('records that AgentFS 0.6.4 embeds a different engine from the one probed directly', () => {
    const { sdk, embeddedEngine } = evidence<AgentfsResult>('agentfs-sdk.json');
    expect(sdk.engineRange).toBe('^0.4.0-pre.18');
    expect(embeddedEngine.version).toBe('0.4.4');
    const direct = statuses(engineRun('@tursodatabase/database', '0.8.2'));
    const embedded = statuses(engineRun('@tursodatabase/database', '0.4.4'));
    expect(direct['strict-typing']).toBe('proven');
    expect(embedded['strict-typing']).not.toBe('proven');
    expect([direct['synchronous-full'], embedded['synchronous-full']]).toEqual(['proven', 'violated']);
  });

  it('takes identity from the artifact, because the embedded engine misreports its build on any file it wrote', () => {
    const { embeddedEngine, identityDirect, sqlThroughSdk, loaderOverrides: overrides } = evidence<AgentfsResult>('agentfs-sdk.json');
    expect(overrides).toEqual([]);
    expect(identityDirect).toMatchObject({
      family: 'turso', version: embeddedEngine.version, reportedBuild: embeddedEngine.version, writtenFileBuild: '3.47.0',
    });
    expect(identityDirect.contradictions).toEqual([
      `turso_version() answered 3.47.0 on a file it wrote and reopened; the artifact is ${embeddedEngine.version}`]);
    // The SDK's own connection gives the same answer on its file, so the file causes it, not the SDK.
    expect(sqlThroughSdk.tursoVersion).toBe(identityDirect.writtenFileBuild);
  });

  it.skipIf(!realEngines)('reproduces the embedded engine, its probe statuses and identity, and what the SDK answers', () => {
    const recorded = evidence<AgentfsResult>('agentfs-sdk.json');
    expect(realAgentfs().identityDirect).toEqual(recorded.identityDirect);
    expect(realAgentfs().sqlThroughSdk).toEqual(recorded.sqlThroughSdk);
    const embedded = runner<EngineRun>('probes', '--driver', driver(realEngines!, true), '--node-modules', realEngines!);
    expect(statuses(embedded)).toEqual(statuses(engineRun('@tursodatabase/database', '0.4.4')));
    expect(embedded.identity).toEqual(engineRun('@tursodatabase/database', '0.4.4').identity);
  }, 240_000);
});

describe('TS-008 original acceptance preservation', () => {
  /** A stored, uncompressed archive: enough to exercise the reader without the real package. */
  function storedZip(files: Record<string, string>): Buffer {
    const parts: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const nameBytes = Buffer.from(name);
      const data = Buffer.from(text);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(data), 14);
      local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc32(data), 16);
      central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
      central.writeUInt32LE(offset, 42);
      parts.push(local, nameBytes, data);
      directory.push(central, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const listing = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
    end.writeUInt32LE(listing.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, listing, end]);
  }
  const suites = {
    'pkg/baseline/NC-MEM-LC-2026-10-06.1/eval/acceptance.json': JSON.stringify({ cases: [{ id: 'M01', status: 'specified-not-run' }] }),
    'pkg/evaluation/unified-acceptance.json': JSON.stringify({ scenarios: [{ id: 'U01', status: 'not_run' }] }),
    'pkg/evaluation/cloud-bot-acceptance.json': JSON.stringify({ scenarios: [{ id: 'BOT01', status: 'not_run' }] }),
  };
  const recordFor = (zip: Buffer, files: number): RetentionRecord => ({ path: 'baseline/archive.zip', bytes: zip.length, sha256: sha256(zip), prior_file_count: files });

  it('reads a retained archive in place and refuses a changed or unsafe one', () => {
    const zip = storedZip(suites);
    expect(verifyRetained(zip, recordFor(zip, 3))).toEqual({ ok: true, problems: [], files: Object.keys(suites) });
    expect(priorCases(zip).map(item => `${item.id}:${item.status}`)).toEqual(['M01:specified-not-run', 'U01:not_run', 'BOT01:not_run']);
    const changed = Buffer.from(zip);
    changed[changed.indexOf('specified')] ^= 0x20;
    expect(verifyRetained(changed, recordFor(zip, 3)).problems).toEqual(['SHA-256 differs from the recorded value']);
    const unsafe = storedZip({ ...suites, '../outside.txt': 'x' });
    expect(verifyRetained(unsafe, recordFor(unsafe, 4)).problems).toEqual(['unsafe member ../outside.txt']);
  });

  it('keeps all 180 prior cases at their original statuses, apart from the 80 new ones', () => {
    const retained = evidence<RetentionEvidence>('package-retention.json');
    expect(retained.verified).toEqual({ ok: true, problems: [], files: retained.retention.prior_file_count });
    const ids = new Set(retained.priorCases.map(item => item.id));
    expect(ids.size).toBe(180);
    for (const [prefix, count] of [['M', 48], ['L', 48], ['U', 60], ['BOT', 24]] as const)
      for (let n = 1; n <= count; n++) expect(ids.has(`${prefix}${String(n).padStart(2, '0')}`), `${prefix}${n}`).toBe(true);
    expect(new Set(retained.priorCases.map(item => item.status))).toEqual(new Set(['specified-not-run', 'not_run']));
    expect(retained.overlayCases.map(item => item.id)).toEqual(Array.from({ length: 80 }, (_, n) => `TS-${String(n + 1).padStart(3, '0')}`));
    expect(overlayNamesPrior(retained.priorCases, retained.overlayCases)).toEqual([]);
    expect(retained.overlayNamesPrior).toEqual([]);
    // A copy obtained apart from the overlay has the size and hash the overlay records.
    expect(retained.independentCopy).toEqual({ bytes: retained.retention.bytes, sha256: retained.retention.sha256 });
  });

  it.skipIf(!overlayPackage)('verifies the retained NC-UM archive byte for byte and reads the same 180 cases', async () => {
    const record = JSON.parse(await readFile(path.join(overlayPackage!, 'baseline', 'RETENTION.json'), 'utf8')) as RetentionRecord;
    const retained = evidence<RetentionEvidence>('package-retention.json');
    expect(record).toEqual(retained.retention);
    const zip = await readFile(path.join(overlayPackage!, ...record.path.split('/')));
    const verified = verifyRetained(zip, record);
    expect(verified).toMatchObject({ ok: true, problems: [] });
    expect(verified.files).toHaveLength(118);
    expect(priorCases(zip)).toEqual(retained.priorCases);
    const changed = Buffer.from(zip);
    changed[Math.floor(changed.length / 2)] ^= 0xff;
    expect(verifyRetained(changed, record).ok).toBe(false);
  });

  it.skipIf(!overlayPackage || !independentArchive)('reproduces the retention record, the separate copy included', () => {
    expect(runner('retention', '--package', overlayPackage!, '--independent', independentArchive!))
      .toEqual(evidence('package-retention.json'));
  }, 240_000);
});
