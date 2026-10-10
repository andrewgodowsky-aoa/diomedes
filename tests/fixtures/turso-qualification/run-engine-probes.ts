/**
 * NC-TS TS00 (DIO-227) evidence runner. Probes one engine, the offline start, the AgentFS SDK, the
 * installed artifacts or the retained package, and prints JSON. Absolute paths become <node_modules>,
 * <scratch>, <overlay>, <repo>, <tmp> and <home> so the output can be committed. Findings are data:
 * a violated protection or a schema an engine cannot build exits 0.
 *
 *   npx tsx tests/fixtures/turso-qualification/run-engine-probes.ts probes --engine node-sqlite --scratch <dir>
 *   npx tsx tests/fixtures/turso-qualification/run-engine-probes.ts probes --driver <package>/dist/promise.js --node-modules <dir> --scratch <dir>
 *   npx tsx tests/fixtures/turso-qualification/run-engine-probes.ts offline --node-modules <dir> --scratch <dir>
 *   npx tsx tests/fixtures/turso-qualification/run-engine-probes.ts agentfs --node-modules <dir> --scratch <dir>
 *   npx tsx tests/fixtures/turso-qualification/run-engine-probes.ts manifest --node-modules <dir> --lock <package-lock.json> --notices <json>
 *   npx tsx tests/fixtures/turso-qualification/run-engine-probes.ts schema --driver <package>/dist/promise.js --node-modules <dir> --schema-module <W01 schema.ts>
 *   npx tsx tests/fixtures/turso-qualification/run-engine-probes.ts retention --package <unpacked NC-TS overlay> [--independent <NC-UM archive>]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CREDENTIAL_VARIABLES, refuseNetwork, withoutCredentials } from './offline.js';
import {
  nodeSqliteFactory, promiseDriverFactory, wrapPromiseDatabase, type EngineFactory, type PromiseDatabase, type Row,
} from './probe-engine.js';
import {
  SCHEMA_OBJECTS, W01_PROTECTIONS, conformance, identify, installedClosure, loaderOverrides, packageContents, pinDigest,
  pinInstalled, readSqlIdentity, redistribution, runProtection, sha256, type ArtifactIdentity, type InstalledManifest,
  type NoticeFile, type PackageLicense, type Protection, type ProtectionResult,
} from './qualification.js';
import { overlayNamesPrior, priorCases, verifyRetained, type RetentionRecord } from './retention.js';

const PLATFORM = `${process.platform}-${process.arch}`;
const BINDING = process.platform === 'win32' ? `${PLATFORM}-msvc` : process.platform === 'linux' ? `${PLATFORM}-gnu` : PLATFORM;
const [mode = '', ...rest] = process.argv.slice(2);

const option = (name: string) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
};
const required = (name: string) => {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required`);
  return path.resolve(value);
};
const readJson = <T>(file: string) => JSON.parse(readFileSync(file, 'utf8')) as T;

const redactions: Array<[RegExp, string]> = [];
const pathPattern = (absolute: string) => new RegExp(absolute.split(/[\\/]+/)
  .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+'), 'gi');
for (const [name, label] of [['node-modules', '<node_modules>'], ['scratch', '<scratch>'], ['package', '<overlay>']] as const) {
  const value = option(name);
  if (value) redactions.push([pathPattern(path.resolve(value)), label]);
}
redactions.push([pathPattern(process.cwd()), '<repo>'], [pathPattern(os.tmpdir()), '<tmp>'], [pathPattern(os.homedir()), '<home>']);
const redact = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'string' ? redactions.reduce((text, [pattern, label]) => text.replace(pattern, label), item) : item));

async function settle<T>(operation: () => Promise<T>) {
  try { return { ok: true as const, value: await operation() }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
}

function within<T>(milliseconds: number, operation: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not finish within ${milliseconds / 1000} s`)), milliseconds);
  });
  return Promise.race([operation(), limit]).finally(() => clearTimeout(timer));
}

async function engineFor(): Promise<{ factory: EngineFactory; artifact: ArtifactIdentity }> {
  if (option('engine') === 'node-sqlite')
    return { factory: nodeSqliteFactory(), artifact: { component: 'node:sqlite', version: String(process.versions.sqlite), platform: PLATFORM } };
  const driver = required('driver');
  const installed = readJson<{ name: string; version: string }>(path.join(path.dirname(path.dirname(driver)), 'package.json'));
  return {
    factory: await promiseDriverFactory(driver, `${installed.name}@${installed.version}`),
    artifact: { component: installed.name, version: installed.version, platform: PLATFORM },
  };
}

/** Runs one protection in a separate process, so a native crash or a hang is recorded instead of ending the run. */
function isolated(protection: Protection): ProtectionResult {
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), mode, ...rest, '--only', protection.id],
    { encoding: 'utf8', timeout: 120_000 });
  if (child.status === 0) {
    try { return JSON.parse(child.stdout) as ProtectionResult; } catch { /* recorded below */ }
  }
  return {
    id: protection.id, proof: protection.proof, status: 'unverified',
    observed: `the probe process ended with ${String(child.status ?? child.signal ?? 'no status')}`,
  };
}

async function probes() {
  const scratch = required('scratch');
  mkdirSync(scratch, { recursive: true });
  const { factory, artifact } = await engineFor();
  const context = { factory, scratch };
  const only = option('only');
  if (only) {
    const protection = W01_PROTECTIONS.find(item => item.id === only);
    if (!protection) throw new Error(`no protection named ${only}`);
    return runProtection(protection, context);
  }
  const protections: ProtectionResult[] = [];
  for (const protection of W01_PROTECTIONS)
    protections.push(protection.isolate && artifact.component !== 'node:sqlite'
      ? isolated(protection) : await runProtection(protection, context));
  return {
    artifact, loaderOverrides: loaderOverrides(), identity: await identify(factory, artifact, scratch),
    protections, conformance: conformance(protections),
  };
}

async function offline() {
  const root = required('node-modules');
  const run = path.join(required('scratch'), `offline-${process.pid}`);
  mkdirSync(run, { recursive: true });
  const database = await import(pathToFileURL(path.join(root, '@tursodatabase/database/dist/promise.js')).href) as
    { connect(location: string): Promise<PromiseDatabase> };
  const sync = await import(pathToFileURL(path.join(root, '@tursodatabase/sync/dist/promise.js')).href) as
    { connect(options: Record<string, unknown>): Promise<PromiseDatabase> };
  const exact = async (db: PromiseDatabase) => {
    try {
      const engine = wrapPromiseDatabase(db, 'offline');
      await engine.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT');
      await engine.run('INSERT INTO notes VALUES (?, ?)', 'note-1', 'kept on this computer');
      return { lookup: (await engine.get('SELECT body FROM notes WHERE id = ?', 'note-1'))?.body ?? null };
    } finally { await db.close(); }
  };
  const credentials = () => Object.keys(process.env).filter(key => CREDENTIAL_VARIABLES.test(key)).sort();
  const refusal = refuseNetwork();
  // Names only, read before they are removed. No value is ever recorded.
  const credentialsRemoved = credentials();
  const restore = withoutCredentials();
  const attemptsDuring = async <T>(operation: () => Promise<T>) => {
    const before = refusal.attempts.length;
    const result = await settle(operation);
    return { ...result, networkAttempts: refusal.attempts.slice(before) };
  };
  try {
    return {
      platform: PLATFORM, loaderOverrides: loaderOverrides(),
      credentialsRemoved, credentialsDuringRun: credentials(),
      localDatabase: await attemptsDuring(async () => exact(await database.connect(path.join(run, 'local.db')))),
      // url as a function that answers null turns off bootstrapIfEmpty in @tursodatabase/sync.
      syncWithNoRemote: await attemptsDuring(async () => exact(await sync.connect({ path: path.join(run, 'sync-none.db'), url: () => null }))),
      syncDefaultBootstrap: await attemptsDuring(() => within(15_000, async () =>
        exact(await sync.connect({ path: path.join(run, 'sync-remote.db'), url: 'https://nectovia-probe.invalid' })))),
    };
  } finally {
    refusal.restore();
    restore();
    await rm(run, { recursive: true, force: true });
  }
}

interface AgentHandle {
  getDatabase(): PromiseDatabase;
  fs: {
    mkdir(at: string): Promise<void>; writeFile(at: string, text: string): Promise<void>;
    readFile(at: string, encoding: 'utf8'): Promise<string>; readdir(at: string): Promise<string[]>;
    unlink(at: string): Promise<void>; stat(at: string): Promise<unknown>;
  };
  kv: { set(key: string, value: unknown): Promise<void>; get(key: string): Promise<unknown> };
  close(): Promise<void>;
}

async function agentfs() {
  const root = required('node-modules');
  const run = path.join(required('scratch'), `agentfs-${process.pid}`);
  mkdirSync(run, { recursive: true });
  const sdkRoot = path.join(root, 'agentfs-sdk');
  const sdk = readJson<{ name: string; version: string; dependencies: Record<string, string> }>(path.join(sdkRoot, 'package.json'));
  const engineRoot = path.join(sdkRoot, 'node_modules', '@tursodatabase', 'database');
  const engine = readJson<{ name: string; version: string }>(path.join(engineRoot, 'package.json'));
  const artifact = { component: engine.name, version: engine.version, platform: PLATFORM };
  try {
    const direct = await identify(
      await promiseDriverFactory(path.join(engineRoot, 'dist', 'promise.js'), `${engine.name}@${engine.version}`), artifact, run);
    const { AgentFS } = await import(pathToFileURL(path.join(sdkRoot, 'dist', 'index_node.js')).href) as
      { AgentFS: { open(options: { path: string }): Promise<AgentHandle> } };
    const agent = await AgentFS.open({ path: path.join(run, 'agent.db') });
    try {
      // The SDK's own connection, on the file it has already written. Recorded as answered, not classified.
      const sqlThroughSdk = await readSqlIdentity(wrapPromiseDatabase(agent.getDatabase(), 'agentfs-sdk'));
      const files = await settle(async () => {
        await agent.fs.mkdir('/work');
        await agent.fs.writeFile('/work/a.txt', 'alpha');
        const read = await agent.fs.readFile('/work/a.txt', 'utf8');
        const listed = await agent.fs.readdir('/work');
        await agent.fs.unlink('/work/a.txt');
        return { read, listed, removed: !(await settle(() => agent.fs.stat('/work/a.txt'))).ok };
      });
      const keyValue = await settle(async () => { await agent.kv.set('k', { v: 1 }); return agent.kv.get('k'); });
      return {
        platform: PLATFORM, loaderOverrides: loaderOverrides(),
        sdk: { name: sdk.name, version: sdk.version, engineRange: sdk.dependencies[engine.name] },
        embeddedEngine: artifact, identityDirect: direct, sqlThroughSdk, sdkFileOperations: files, sdkKeyValue: keyValue,
      };
    } finally { await agent.close(); }
  } finally { await rm(run, { recursive: true, force: true }); }
}

/** Files in a package directory; nested packages are pinned as packages of their own. */
const walk = (dir: string) => packageContents(dir).files;

/** The upstream source a notices record keys a package by: `turso@v0.8.2` for a tursodatabase/turso package. */
function sourceKeys(manifest: InstalledManifest): string[] {
  const url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const repository = url?.match(/github\.com[/:]tursodatabase\/([\w.-]+?)(?:\.git)?\/?$/i)?.[1];
  return [`${manifest.name}@${manifest.version}`, ...(repository ? [`${repository}@v${manifest.version}`] : [])];
}

interface SourceRecord {
  repository: string; tag: string | null; commit: string; files: NoticeFile[];
  excluded?: Array<NoticeFile & { reason: string }>;
}

async function manifest() {
  const root = required('node-modules');
  const lock = readJson<{ packages: Record<string, { integrity?: string }> }>(required('lock'));
  const { sources } = readJson<{ sources: Record<string, SourceRecord> }>(required('notices'));
  // Each component is one package and everything it loads. The last is the engine AgentFS embeds.
  const families = [
    { component: '@tursodatabase/database', main: '@tursodatabase/database' },
    { component: '@tursodatabase/sync', main: '@tursodatabase/sync' },
    { component: 'agentfs-sdk', main: 'agentfs-sdk' },
    { component: '@tursodatabase/database', main: 'agentfs-sdk/node_modules/@tursodatabase/database' },
  ];
  const at = (name: string) => path.join(root, ...name.split('/'));
  const isLicense = (file: string) => !file.includes('/') && /^(licen[cs]e|copying)/i.test(file);
  // An upstream file is named by the source it was read at: `turso@v0.8.2/LICENSE.md`.
  const atSource = (key: string, file: NoticeFile): NoticeFile => ({ path: `${key}/${file.path}`, sha256: file.sha256 });
  const components = [];
  for (const family of families) {
    const installed = installedClosure(root, at(family.main)).map(dir => path.relative(root, dir).split(path.sep).join('/'));
    const main = readJson<InstalledManifest>(path.join(at(family.main), 'package.json'));
    const pin = await pinInstalled(root, { component: family.component, version: main.version, platform: PLATFORM },
      installed.map(name => ({ name, files: walk(at(name)).filter(file => file !== 'package.json') })));
    const used = new Map<string, SourceRecord>();
    const licenses: PackageLicense[] = [];
    const shipped: NoticeFile[] = [];
    for (const name of installed) {
      const own = readJson<InstalledManifest>(path.join(at(name), 'package.json'));
      const carriedHere = walk(at(name)).filter(file => /^(licen[cs]e|notice|copying)/i.test(path.basename(file)))
        .map(file => ({ file, notice: { path: `${name}/${file}`, sha256: sha256(readFileSync(path.join(at(name), file))) } }));
      shipped.push(...carriedHere.map(item => item.notice));
      const key = sourceKeys(own).find(candidate => sources[candidate]);
      if (key) used.set(key, sources[key]);
      // Its own text: a license file at the package root, else the root license at its pinned source.
      const atPinnedSource = key ? sources[key].files.find(file => isLicense(file.path)) : undefined;
      const text = carriedHere.find(item => isLicense(item.file))?.notice ?? (key && atPinnedSource ? atSource(key, atPinnedSource) : null);
      licenses.push({ package: `${name}@${own.version}`, declared: own.license ?? null, text });
    }
    // Two sources can carry identical text; each is still listed, and one carried copy satisfies both by content.
    const upstream = [...used].flatMap(([key, source]) => source.files.map(file => atSource(key, file)));
    const notices = { licenses, upstream, shipped, bundled: [] as NoticeFile[] };
    const binaryPackage = installed.find(name => name === `${family.main}-${BINDING}`);
    const binaryFile = binaryPackage ? Object.keys(pin.packages.find(item => item.name === binaryPackage)?.files ?? {}).find(file => file.endsWith('.node')) : undefined;
    const binaryPath = binaryPackage && binaryFile ? path.join(at(binaryPackage), binaryFile) : null;
    components.push({
      component: family.component, version: main.version, platform: PLATFORM, main: family.main,
      artifactDigest: pinDigest(pin),
      packages: pin.packages.map(item => ({ ...item, integrity: lock.packages[`node_modules/${item.name}`]?.integrity ?? null })),
      binary: binaryPath ? { package: binaryPackage, file: binaryFile, bytes: statSync(binaryPath).size, sha256: sha256(readFileSync(binaryPath)) } : null,
      sources: [...used].map(([key, source]) => ({ key, repository: source.repository, tag: source.tag, commit: source.commit, excluded: source.excluded ?? [] })),
      notices, redistribution: redistribution(notices),
    });
  }
  const electron = readJson<{ version: string }>(path.join(process.cwd(), 'node_modules', 'electron', 'package.json')).version;
  return {
    platform: PLATFORM, components,
    runtime: { node: process.version, sqlite: process.versions.sqlite, electron, electronSqlite: 'not measured by this runner' },
  };
}

/** Builds W01's real schema in the reference engine and in a candidate, and compares the stored text. */
async function schema() {
  const driver = required('driver');
  const text = (await import(pathToFileURL(required('schema-module')).href) as { MEMORY_SQLITE_INITIAL_SCHEMA?: unknown })
    .MEMORY_SQLITE_INITIAL_SCHEMA;
  if (typeof text !== 'string') throw new Error('the schema module exports no MEMORY_SQLITE_INITIAL_SCHEMA');
  const installed = readJson<{ name: string; version: string }>(path.join(path.dirname(path.dirname(driver)), 'package.json'));
  const build = async (factory: EngineFactory) => {
    const engine = await factory.open(':memory:');
    try {
      await engine.exec(text);
      return await engine.all(SCHEMA_OBJECTS);
    } finally { await engine.close(); }
  };
  const reference = await build(nodeSqliteFactory());
  const built = await settle(async () => build(await promiseDriverFactory(driver, `${installed.name}@${installed.version}`)));
  const recorded = {
    loaderOverrides: loaderOverrides(),
    schemaSha256: sha256(Buffer.from(text)),
    reference: { component: 'node:sqlite', version: process.versions.sqlite, objects: reference.length },
  };
  // An engine that cannot build W01's schema at all is a finding, recorded like any other.
  if (!built.ok) return { ...recorded, candidate: { component: installed.name, version: installed.version, error: built.error } };
  const candidate = built.value;
  const key = (row: Row) => `${String(row.type)}:${String(row.name)}`;
  const referenceByKey = new Map(reference.map(row => [key(row), row]));
  const candidateKeys = new Set(candidate.map(key));
  return {
    ...recorded,
    candidate: { component: installed.name, version: installed.version, objects: candidate.length },
    onlyInCandidate: [...candidateKeys].filter(name => !referenceByKey.has(name)),
    onlyInReference: [...referenceByKey.keys()].filter(name => !candidateKeys.has(name)),
    sqlTextDiffers: candidate.filter(row => referenceByKey.has(key(row)) && referenceByKey.get(key(row))?.sql !== row.sql).map(key),
  };
}

/**
 * Reads the overlay's retained NC-UM archive in place, and both case inventories beside it. With
 * --independent, also hashes a copy of the archive obtained apart from the overlay; only its size
 * and hash are recorded.
 */
async function retention() {
  const root = required('package');
  const record = readJson<RetentionRecord>(path.join(root, 'baseline', 'RETENTION.json'));
  const zip = readFileSync(path.join(root, ...record.path.split('/')));
  const verified = verifyRetained(zip, record);
  const prior = priorCases(zip);
  const overlay = readJson<{ cases: Array<{ id: string; packet: string; status: string }> }>(path.join(root, 'evaluation', 'acceptance.json'))
    .cases.map(item => ({ id: item.id, packet: item.packet, status: item.status }));
  const separate = option('independent') ? readFileSync(required('independent')) : null;
  return {
    retention: record,
    verified: { ok: verified.ok, problems: verified.problems, files: verified.files.length },
    independentCopy: separate ? { bytes: separate.length, sha256: sha256(separate) } : null,
    priorCases: prior,
    overlayCases: overlay,
    overlayNamesPrior: overlayNamesPrior(prior, overlay),
  };
}

const modes: Record<string, () => Promise<unknown>> = { probes, offline, agentfs, manifest, schema, retention };
const selected = modes[mode];
if (!selected) {
  process.stderr.write(`usage: run-engine-probes.ts ${Object.keys(modes).join('|')} [options]\n`);
  process.exitCode = 2;
} else {
  selected().then(
    result => { process.stdout.write(`${JSON.stringify(redact(result), null, 1)}\n`); },
    (error: unknown) => {
      process.stderr.write(`${String(redact(error instanceof Error ? error.stack ?? error.message : error))}\n`);
      process.exitCode = 1;
    },
  );
}
