/**
 * P03: installing, activating, updating, rolling back and uninstalling packs.
 *
 * Four properties are the point of this file:
 *
 * 1. **Every operation is recorded and never pruned** (`AGENTS.md` decision
 *    10). The pack store's `operations` list is append-only: an operation
 *    writes `started` before it touches the disk and `completed`, `refused` or
 *    `failed` after, and a restart that finds a `started` with no ending
 *    appends `interrupted`. What a Project turned on or off is also a History
 *    entry in that Project, through the same writer the built-in packs use.
 * 2. **Half-installed never activates.** Content is staged, verified against
 *    its digest, moved into a content-addressed object folder, and only then
 *    does one atomic write of `store.json` make it installed. A crash at any
 *    earlier point leaves the store saying what it said before; the leftover
 *    is swept on the next open.
 * 3. **Activation is not authorization** (decision 14). Nothing here touches a
 *    grant, a Need, a permission, a schedule or a connection. A manifest's
 *    requested permissions are shown as requests; Trust decides at use.
 * 4. **Contributions load only where a pack is on.** `loadedContributions`
 *    answers per Project from that Project's own activation records.
 *
 * The on-disk store is versioned. A `store.json` naming a schema this build
 * does not know is refused, and every operation refuses with it, rather than
 * being read as something it may not be.
 *
 * Sources are a bundled pack or a local folder the person names. There is no
 * registry, marketplace or GitHub acquisition here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isCapabilityPackId, isPackActive } from '../shared/capability-packs.js';
import {
  PACK_MANIFEST_SCHEMA_VERSION,
  packManifestSchema,
  resolvePacks,
  type PackManifest,
  type ResolutionRefusal,
} from '../shared/pack-manifest.js';
import { compareVersions, satisfies } from '../shared/semver.js';
import { activatePack, deactivatePack, recordPackActivation } from './capability-packs.js';
import {
  bundledPayloadRoot,
  packDigest,
  PREINSTALLED_PACK_IDS,
  sha256,
} from './pack-catalogue.js';
import { absent, ApiError, isContained, safeAbsolute } from './paths.js';
import { durableWrite, identifier, jsonWrite, now, type Store } from './store.js';

export const PACK_STORE_SCHEMA_VERSION = 1 as const;
/** The file a local pack folder carries its manifest in. */
export const PACK_MANIFEST_FILE = 'diomedes-pack.json';
const MANIFEST_MAX_BYTES = 256 * 1024;

export type PackSource =
  | { readonly kind: 'bundled'; readonly packId: string }
  | { readonly kind: 'directory'; readonly path: string };

export interface InstalledVersion {
  readonly version: string;
  readonly digest: string;
  readonly source: 'bundled' | 'directory';
  /** The folder a directory pack came from, as the person named it. */
  readonly sourcePath: string | null;
  readonly installedAt: string;
  /** Object folder under `objects/`, content-addressed by id, version and digest. */
  readonly object: string;
  /**
   * What this version depends on, copied from its verified manifest at
   * install. It keeps a damaged pack protecting what it needs: the manifest
   * may stop verifying, and this record still says what it depended on.
   */
  readonly dependencies?: readonly { readonly id: string; readonly range: string }[];
}

export interface InstalledPackRecord {
  readonly id: string;
  current: string;
  /** Every version still on disk, so a rollback needs nothing fetched. */
  versions: InstalledVersion[];
  /** The versions an update replaced, newest last. Rollback takes the last one. */
  previous: string[];
}

export type PackOperationKind =
  | 'install'
  | 'update'
  | 'rollback'
  | 'uninstall'
  | 'activate'
  | 'deactivate';
export type PackOperationPhase = 'started' | 'completed' | 'refused' | 'failed' | 'interrupted';

export interface PackOperationRecord {
  readonly opId: string;
  readonly kind: PackOperationKind;
  readonly phase: PackOperationPhase;
  readonly packId: string;
  readonly at: string;
  /** `diomedes` only for the packs that install with the application itself. */
  readonly by: 'you' | 'diomedes';
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  readonly digest: string | null;
  readonly projectId: string | null;
  readonly source: PackSource['kind'] | null;
  readonly detail: string;
}

interface PackStoreFile {
  schemaVersion: typeof PACK_STORE_SCHEMA_VERSION;
  packs: Record<string, InstalledPackRecord>;
  operations: PackOperationRecord[];
}

/** Named points a test can stop the process at, to prove recovery. */
export type PackFaultStep = 'staged' | 'placed' | 'committed';

export interface PackLifecycleOptions {
  readonly store: Store;
  /** Usually `<dataDir>/packs`. */
  readonly root: string;
  readonly catalogue: () => Promise<PackManifest[]>;
  /** Where a bundled pack's payload files are read from. */
  readonly bundledPayload?: (manifest: PackManifest) => string | null;
  /**
   * Stands in for the process stopping at a named point. A throw here
   * propagates without any clean-up, exactly as a crash would.
   */
  readonly fault?: (step: PackFaultStep) => void | Promise<void>;
  readonly clock?: () => string;
}

interface Acquired {
  readonly manifest: PackManifest;
  readonly files: readonly { path: string; bytes: Buffer }[];
  readonly source: PackSource;
}

/** A refusal with the pieces the Console needs to explain it or ask. */
function refuse(
  status: number,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new ApiError(status, message, details);
}

export interface InstalledPackView {
  readonly manifest: PackManifest | null;
  readonly id: string;
  readonly current: string;
  readonly versions: readonly InstalledVersion[];
  readonly rollbackTo: string | null;
  /** `wired` when this build's Runtime loads its contributions; `declared` when it only records them. */
  readonly runtime: 'wired' | 'declared';
  readonly damaged: string | null;
  readonly activeProjects: readonly { id: string; name: string }[];
  readonly dependents: readonly string[];
  readonly updateAvailable: string | null;
}

export interface LoadedPack {
  readonly id: string;
  readonly version: string;
  readonly runtime: 'wired' | 'declared';
  readonly contributions: PackManifest['contributions'];
}

export class PackLifecycle {
  private file: PackStoreFile | null = null;
  private opening: Promise<PackStoreFile> | null = null;
  private manifests = new Map<string, PackManifest | Error>();
  private catalogueCache: Promise<PackManifest[]> | null = null;
  private readonly clock: () => string;

  constructor(private readonly options: PackLifecycleOptions) {
    this.clock = options.clock ?? now;
  }

  private get storePath() {
    return path.join(this.options.root, 'store.json');
  }
  private get stagingRoot() {
    return path.join(this.options.root, 'staging');
  }
  private get objectsRoot() {
    return path.join(this.options.root, 'objects');
  }

  catalogue() {
    this.catalogueCache ??= this.options.catalogue();
    return this.catalogueCache;
  }

  /** Open the store: create it with the preinstalled packs, or read it and recover. */
  async open(): Promise<PackStoreFile> {
    if (this.file) return this.file;
    this.opening ??= this.load().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async load(): Promise<PackStoreFile> {
    await fs.mkdir(this.options.root, { recursive: true });
    // Only a missing file means "no store yet". Anything else on disk is read
    // as this schema or refused, and a refused store is never replaced.
    let text: string | null;
    try {
      text = await fs.readFile(this.storePath, 'utf8');
    } catch (error) {
      if (!absent(error)) throw error;
      text = null;
    }
    if (text === null) {
      this.file = { schemaVersion: PACK_STORE_SCHEMA_VERSION, packs: {}, operations: [] };
      await this.persist();
    } else {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        refuse(409, 'The pack store is not readable JSON. Nothing in it was changed.', {
          code: 'unreadable-store',
        });
      }
      const version = isPlainObject(raw) ? raw.schemaVersion : undefined;
      if (isPlainObject(raw) && 'schemaVersion' in raw && version !== PACK_STORE_SCHEMA_VERSION)
        refuse(
          409,
          `The pack store was written with schema ${String(version)}, which this Diomedes does not read. Nothing in it was changed.`,
          { code: 'unknown-store-version' },
        );
      if (!isPackStoreFile(raw))
        refuse(
          409,
          'The pack store does not have the shape this Diomedes writes. Nothing in it was changed.',
          { code: 'unreadable-store' },
        );
      this.file = raw;
      await this.recover();
    }
    await this.preinstall();
    return this.file!;
  }

  /**
   * The packs whose runtime ships wired are installed by Diomedes: on a new
   * store, and again on any later open that finds one missing without an
   * uninstall recorded for it, which is what a stop part-way through the
   * first open leaves. One you uninstalled stays uninstalled.
   */
  private async preinstall() {
    const file = this.file!;
    const uninstalled = new Set(
      file.operations
        .filter((op) => op.kind === 'uninstall' && op.phase === 'completed')
        .map((op) => op.packId),
    );
    const missing = PREINSTALLED_PACK_IDS.filter((id) => !file.packs[id] && !uninstalled.has(id));
    if (!missing.length) return;
    const catalogue = await this.catalogue();
    for (const id of missing) {
      const manifest = catalogue.find((item) => item.id === id);
      if (manifest) await this.commit(await this.acquireBundled(manifest), 'install', 'diomedes', null);
    }
  }

  /** Close out anything a stopped process left half done. Appends; never rewrites. */
  private async recover() {
    const file = this.file!;
    const ended = new Set(
      file.operations.filter((op) => op.phase !== 'started').map((op) => op.opId),
    );
    const open = file.operations.filter((op) => op.phase === 'started' && !ended.has(op.opId));
    for (const op of open)
      file.operations.push({
        ...op,
        phase: 'interrupted',
        at: this.clock(),
        detail:
          'Diomedes stopped before this finished. The store still says what it said before it started, and nothing from it was turned on.',
      });
    if (open.length) await this.persist();
    await fs.rm(this.stagingRoot, { recursive: true, force: true });
    // Object folders no installed version names are what an interrupted
    // operation or a finished uninstall left behind. They were never installed.
    const referenced = new Set(
      Object.values(file.packs).flatMap((pack) => pack.versions.map((v) => v.object)),
    );
    let ids: string[] = [];
    try {
      ids = await fs.readdir(this.objectsRoot);
    } catch (error) {
      if (!absent(error)) throw error;
    }
    for (const id of ids) {
      const versions = await fs.readdir(path.join(this.objectsRoot, id)).catch(() => []);
      for (const folder of versions)
        if (!referenced.has(`${id}/${folder}`))
          await fs.rm(path.join(this.objectsRoot, id, folder), { recursive: true, force: true });
      if (!(await fs.readdir(path.join(this.objectsRoot, id)).catch(() => [])).length)
        await fs.rm(path.join(this.objectsRoot, id), { recursive: true, force: true });
    }
  }

  private async persist() {
    await jsonWrite(this.storePath, this.file);
  }

  private async append(op: Omit<PackOperationRecord, 'at'>, persist = true) {
    this.file!.operations.push({ ...op, at: this.clock() });
    if (persist) await this.persist();
  }

  async operations(): Promise<readonly PackOperationRecord[]> {
    return [...(await this.open()).operations];
  }

  // --- reading what is installed -------------------------------------------------------

  /**
   * Start a public action from what is on disk now. The verification memo
   * lives for one action only, so a manifest or payload file changed since
   * the last action is caught by the next one.
   */
  private async fresh() {
    this.manifests.clear();
    return this.open();
  }

  /**
   * The installed manifest for one version, re-verified on read: the manifest
   * against its digest, and every payload file it lists against its recorded
   * size and sha. Remembered only until the next public action begins.
   */
  private async manifestOf(id: string, version: string): Promise<PackManifest | Error> {
    const file = await this.open();
    const record = file.packs[id]?.versions.find((v) => v.version === version);
    if (!record) return new Error(`${id} ${version} is not installed.`);
    const key = `${record.object}`;
    const cached = this.manifests.get(key);
    if (cached) return cached;
    const result = await this.verifyObject(record);
    this.manifests.set(key, result);
    return result;
  }

  private async verifyObject(record: InstalledVersion): Promise<PackManifest | Error> {
    const folder = path.join(this.objectsRoot, ...record.object.split('/'));
    let manifest: PackManifest;
    try {
      const text = await fs.readFile(path.join(folder, 'manifest.json'), 'utf8');
      manifest = packManifestSchema.parse(JSON.parse(text));
    } catch {
      return new Error('Its installed manifest could not be read.');
    }
    if (packDigest(manifest) !== manifest.digest || manifest.digest !== record.digest)
      return new Error('Its installed files no longer match the digest they were installed with.');
    for (const entry of manifest.files) {
      const absolute = path.join(folder, 'files', ...entry.path.split('/'));
      try {
        const stat = await fs.lstat(absolute);
        if (!stat.isFile() || stat.size !== entry.bytes)
          return new Error(`Its installed file ${entry.path} no longer matches the digest it was installed with.`);
        if (sha256(await fs.readFile(absolute)) !== entry.sha256)
          return new Error(`Its installed file ${entry.path} no longer matches the digest it was installed with.`);
      } catch {
        return new Error(`Its installed file ${entry.path} is missing.`);
      }
    }
    return manifest;
  }

  private async current(id: string): Promise<PackManifest | null> {
    const file = await this.open();
    const record = file.packs[id];
    if (!record) return null;
    const manifest = await this.manifestOf(id, record.current);
    return manifest instanceof Error ? null : manifest;
  }

  private async installedCurrent(): Promise<PackManifest[]> {
    const file = await this.open();
    const found: PackManifest[] = [];
    for (const id of Object.keys(file.packs).sort()) {
      const manifest = await this.current(id);
      if (manifest) found.push(manifest);
    }
    return found;
  }

  async isInstalled(id: string) {
    return Boolean((await this.open()).packs[id]);
  }

  private async projectsWith(id: string) {
    const projects = await this.options.store.projects();
    return projects
      .filter((project) => isPackActive(project.packs, id))
      .map((project) => ({ id: project.id, name: project.name }));
  }

  /**
   * Installed packs whose current version depends on `id`, damaged ones
   * included. A damaged pack is read from the dependencies recorded when it
   * was installed; one with none recorded is returned in `unknown`, because
   * what it depends on cannot be known and nothing may be assumed safe.
   */
  private async dependentsOf(id: string) {
    const file = await this.open();
    const dependents: Pick<PackManifest, 'id' | 'name' | 'version' | 'dependencies'>[] = [];
    const unknown: string[] = [];
    for (const packId of Object.keys(file.packs).sort()) {
      if (packId === id) continue;
      const record = file.packs[packId];
      const manifest = await this.current(packId);
      const dependencies =
        manifest?.dependencies ?? record.versions.find((v) => v.version === record.current)?.dependencies;
      if (!dependencies) unknown.push(packId);
      else if (dependencies.some((dep) => dep.id === id))
        dependents.push({
          id: packId,
          name: manifest?.name ?? packId,
          version: record.current,
          dependencies: [...dependencies],
        });
    }
    return { dependents, unknown };
  }

  async installed(): Promise<InstalledPackView[]> {
    const file = await this.fresh();
    const catalogue = await this.catalogue();
    const views: InstalledPackView[] = [];
    for (const id of Object.keys(file.packs).sort()) {
      const record = file.packs[id];
      const manifest = await this.manifestOf(id, record.current);
      const bundledNewer = catalogue.find(
        (item) => item.id === id && compareVersions(item.version, record.current) > 0,
      );
      views.push({
        id,
        manifest: manifest instanceof Error ? null : manifest,
        current: record.current,
        versions: record.versions,
        rollbackTo: record.previous.at(-1) ?? null,
        runtime: isCapabilityPackId(id) ? 'wired' : 'declared',
        damaged: manifest instanceof Error ? manifest.message : null,
        activeProjects: await this.projectsWith(id),
        dependents: (await this.dependentsOf(id)).dependents.map((m) => m.id),
        updateAvailable: bundledNewer?.version ?? null,
      });
    }
    return views;
  }

  /** Bundled packs that are not installed, newest version of each. */
  async available(): Promise<PackManifest[]> {
    const file = await this.open();
    return (await this.catalogue()).filter((manifest) => !file.packs[manifest.id]);
  }

  /**
   * What a Project has loaded: the contributions of packs that are installed
   * and on in that Project, and nothing for any other pack or Project.
   */
  async loadedContributions(projectId: string): Promise<LoadedPack[]> {
    await this.fresh();
    const state = this.options.store.state(projectId);
    const loaded: LoadedPack[] = [];
    for (const manifest of await this.installedCurrent())
      if (isPackActive(state.project.packs, manifest.id))
        loaded.push({
          id: manifest.id,
          version: manifest.version,
          runtime: isCapabilityPackId(manifest.id) ? 'wired' : 'declared',
          contributions: manifest.contributions,
        });
    return loaded;
  }

  // --- acquiring content -------------------------------------------------------------

  private async acquireBundled(manifest: PackManifest): Promise<Acquired> {
    const root = (this.options.bundledPayload ?? ((m) => bundledPayloadRoot(m)))(manifest);
    const files: { path: string; bytes: Buffer }[] = [];
    for (const entry of manifest.files) {
      if (!root) refuse(500, `${manifest.name} lists files but ships none.`);
      const bytes = await fs.readFile(path.join(root, ...entry.path.split('/')));
      if (sha256(bytes) !== entry.sha256)
        refuse(409, `${manifest.name}'s bundled file ${entry.path} does not match its digest.`, {
          code: 'digest-mismatch',
        });
      files.push({ path: entry.path, bytes });
    }
    return { manifest, files, source: { kind: 'bundled', packId: manifest.id } };
  }

  /**
   * Read and verify a local pack folder. Every refusal names what was wrong;
   * nothing is written. Links are refused at every component, only the files
   * the manifest lists are read, and each must match its recorded sha before
   * the manifest's own digest is checked.
   */
  async acquireDirectory(input: unknown): Promise<Acquired> {
    if (typeof input !== 'string' || !input.trim() || !path.isAbsolute(input.trim()))
      refuse(400, 'Name the pack folder by its full path.');
    const folder = await safeAbsolute(input.trim());
    const manifestPath = path.join(folder, PACK_MANIFEST_FILE);
    let stat;
    try {
      stat = await fs.lstat(manifestPath);
    } catch (error) {
      if (absent(error)) refuse(404, `That folder has no ${PACK_MANIFEST_FILE}.`, { code: 'no-manifest' });
      throw error;
    }
    if (!stat.isFile()) refuse(400, `${PACK_MANIFEST_FILE} is not a regular file.`);
    if (stat.size > MANIFEST_MAX_BYTES) refuse(400, `${PACK_MANIFEST_FILE} is larger than 256 KB.`);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      refuse(400, `${PACK_MANIFEST_FILE} is not valid JSON.`, { code: 'invalid-manifest' });
    }
    const schemaVersion = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (schemaVersion !== PACK_MANIFEST_SCHEMA_VERSION)
      refuse(
        400,
        `This pack is written in manifest schema ${String(schemaVersion)}; this Diomedes reads schema ${PACK_MANIFEST_SCHEMA_VERSION}.`,
        { code: 'unknown-manifest-version' },
      );
    const parsed = packManifestSchema.safeParse(raw);
    if (!parsed.success)
      refuse(400, 'This pack manifest is not valid.', {
        code: 'invalid-manifest',
        problems: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.') || 'manifest'}: ${issue.message}`,
        ),
      });
    const manifest = parsed.data;
    if (
      manifest.id.startsWith('diomedes.') ||
      manifest.publisher.id === 'diomedes' ||
      manifest.publisher.name.trim().toLowerCase() === 'diomedes'
    )
      refuse(400, 'The diomedes publisher and ids are reserved for packs that ship with Diomedes.', {
        code: 'reserved-id',
      });
    const files: { path: string; bytes: Buffer }[] = [];
    for (const entry of manifest.files) {
      const absolute = path.join(folder, ...entry.path.split('/'));
      if (!isContained(folder, absolute)) refuse(400, `${entry.path} leaves the pack folder.`);
      await safeAbsolute(absolute);
      let fileStat;
      try {
        fileStat = await fs.lstat(absolute);
      } catch (error) {
        if (absent(error)) refuse(400, `The pack lists ${entry.path}, which is not in the folder.`, { code: 'missing-file' });
        throw error;
      }
      if (!fileStat.isFile()) refuse(400, `${entry.path} is not a regular file.`);
      if (fileStat.size !== entry.bytes)
        refuse(409, `${entry.path} is ${fileStat.size} bytes; the manifest says ${entry.bytes}.`, {
          code: 'digest-mismatch',
        });
      const bytes = await fs.readFile(absolute);
      if (sha256(bytes) !== entry.sha256)
        refuse(409, `${entry.path} does not match the sha the manifest records for it.`, {
          code: 'digest-mismatch',
        });
      files.push({ path: entry.path, bytes });
    }
    if (packDigest(manifest) !== manifest.digest)
      refuse(409, "The pack's digest does not match its contents. Nothing was installed.", {
        code: 'digest-mismatch',
      });
    return { manifest, files, source: { kind: 'directory', path: folder } };
  }

  private async acquire(source: unknown): Promise<Acquired> {
    const value = (source ?? {}) as Partial<{ kind: string; packId: string; path: string }>;
    if (value.kind === 'directory') return this.acquireDirectory(value.path);
    if (value.kind === 'bundled') {
      const manifest = (await this.catalogue()).find((item) => item.id === value.packId);
      if (!manifest) refuse(404, 'That pack does not ship with this Diomedes.');
      return this.acquireBundled(manifest);
    }
    return refuse(400, 'Choose a bundled pack or a local pack folder.');
  }

  // --- the one commit path -------------------------------------------------------------

  private async fault(step: PackFaultStep) {
    await this.options.fault?.(step);
  }

  /**
   * Stage, verify, place, then commit with one atomic write. The fault hook
   * sits between the steps and outside every clean-up, so a test that stops
   * there leaves exactly what a crash would.
   */
  private async commit(
    acquired: Acquired,
    kind: 'install' | 'update',
    by: 'you' | 'diomedes',
    fromVersion: string | null,
  ) {
    const file = this.file!;
    const { manifest } = acquired;
    const opId = identifier('pk');
    const base = {
      opId,
      kind,
      packId: manifest.id,
      by,
      fromVersion,
      toVersion: manifest.version,
      digest: manifest.digest,
      projectId: null,
      source: acquired.source.kind,
    } as const;
    await this.append({ ...base, phase: 'started', detail: `${manifest.name} ${manifest.version}` });
    const object = `${manifest.id}/${manifest.version}-${manifest.digest.slice(7, 19)}`;
    const target = path.join(this.objectsRoot, ...object.split('/'));
    const staging = path.join(this.stagingRoot, opId);
    const already = Object.values(file.packs).some((pack) =>
      pack.versions.some((v) => v.object === object),
    );
    try {
      if (!already) {
        await durableWrite(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
        for (const entry of acquired.files)
          await durableWrite(path.join(staging, 'files', ...entry.path.split('/')), entry.bytes);
      }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      await this.append({ ...base, phase: 'failed', detail: messageOf(error) });
      throw error;
    }
    await this.fault('staged');
    try {
      if (!already) {
        await fs.rm(target, { recursive: true, force: true });
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(staging, target);
      }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      await this.append({ ...base, phase: 'failed', detail: messageOf(error) });
      throw error;
    }
    await this.fault('placed');
    const record: InstalledPackRecord = file.packs[manifest.id] ?? {
      id: manifest.id,
      current: manifest.version,
      versions: [],
      previous: [],
    };
    if (!record.versions.some((v) => v.object === object))
      record.versions = [
        ...record.versions.filter((v) => v.version !== manifest.version),
        {
          version: manifest.version,
          digest: manifest.digest,
          source: acquired.source.kind,
          sourcePath: acquired.source.kind === 'directory' ? acquired.source.path : null,
          installedAt: this.clock(),
          object,
          dependencies: manifest.dependencies.map((dep) => ({ id: dep.id, range: dep.range })),
        },
      ];
    if (fromVersion) record.previous = [...record.previous, fromVersion];
    record.current = manifest.version;
    file.packs[manifest.id] = record;
    this.manifests.delete(object);
    await this.append({
      ...base,
      phase: 'completed',
      detail:
        kind === 'install'
          ? by === 'diomedes'
            ? `${manifest.name} ${manifest.version} installed with Diomedes. It is off in every project until someone turns it on.`
            : `You installed ${manifest.name} ${manifest.version}. It is off in every project until you turn it on, and it grants nothing.`
          : `You updated ${manifest.name} from ${fromVersion} to ${manifest.version}. ${fromVersion} is kept for rollback.`,
    });
    await this.fault('committed');
  }

  private async refused(
    kind: PackOperationKind,
    packId: string,
    detail: string,
    extra: Partial<PackOperationRecord> = {},
  ) {
    await this.append({
      opId: identifier('pk'),
      kind,
      phase: 'refused',
      packId,
      by: 'you',
      fromVersion: null,
      toVersion: null,
      digest: null,
      projectId: null,
      source: null,
      detail,
      ...extra,
    });
  }

  /** Every refusal on a lifecycle action is recorded before it is returned. */
  private async guarded<T>(kind: PackOperationKind, packId: string, action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ApiError && error.status < 500 && this.file)
        await this.refused(kind, packId, error.message);
      throw error;
    }
  }

  // --- install, update, rollback, uninstall ---------------------------------------------

  /** Read and verify a source, and say what installing it would do. Writes nothing. */
  async inspect(source: unknown) {
    await this.fresh();
    const acquired = await this.acquire(source);
    return { manifest: acquired.manifest, plan: await this.installPlan(acquired.manifest) };
  }

  private async installPlan(manifest: PackManifest) {
    const installed = await this.installedCurrent();
    const catalogue = await this.catalogue();
    const others = installed.filter((m) => m.id !== manifest.id);
    const withInstalled = resolvePacks({
      requests: [{ id: manifest.id, range: manifest.version }],
      available: [...others, manifest],
    });
    if (withInstalled.ok) return { ok: true as const, alsoInstalls: [] as PackManifest[] };
    const installedIds = new Set(others.map((m) => m.id));
    const withBundled = resolvePacks({
      requests: [{ id: manifest.id, range: manifest.version }],
      available: [
        ...others,
        ...catalogue.filter((m) => !installedIds.has(m.id) && m.id !== manifest.id),
        manifest,
      ],
    });
    if (!withBundled.ok) return { ok: false as const, refusals: withInstalled.refusals };
    const alsoInstalls = withBundled.order
      .filter((item) => item.id !== manifest.id && !installedIds.has(item.id))
      .map((item) => catalogue.find((m) => m.id === item.id && m.version === item.version)!);
    return { ok: true as const, alsoInstalls };
  }

  async install(source: unknown, options: { includeDependencies?: boolean } = {}) {
    await this.fresh();
    const hint =
      (source as { packId?: unknown; path?: unknown } | null)?.packId ??
      (source as { path?: unknown } | null)?.path;
    return this.guarded('install', typeof hint === 'string' ? hint : '(unknown)', async () => {
      const acquired = await this.acquire(source);
      const { manifest } = acquired;
      const existing = this.file!.packs[manifest.id];
      if (existing)
        refuse(
          409,
          existing.current === manifest.version
            ? `${manifest.name} ${manifest.version} is already installed.`
            : `${manifest.name} ${existing.current} is installed. Use Update to move to ${manifest.version}.`,
          { code: 'already-installed' },
        );
      const plan = await this.installPlan(manifest);
      if (!plan.ok) refuseResolution(manifest.name, plan.refusals);
      if (plan.alsoInstalls.length && !options.includeDependencies)
        refuse(409, `${manifest.name} needs ${names(plan.alsoInstalls)} installed too.`, {
          code: 'needs-dependencies',
          dependencies: plan.alsoInstalls.map(brief),
        });
      for (const dependency of plan.alsoInstalls)
        await this.commit(await this.acquireBundled(dependency), 'install', 'you', null);
      await this.commit(acquired, 'install', 'you', null);
      return { installed: manifest.id, version: manifest.version };
    });
  }

  /** Refuse a version change that would break an installed pack's range. */
  private async assertDependentsAccept(id: string, version: string) {
    const { dependents, unknown } = await this.dependentsOf(id);
    if (unknown.length) refuseUnknownDependents(unknown);
    const breaks = dependents.filter(
      (dependent) => !satisfies(version, dependent.dependencies.find((d) => d.id === id)!.range),
    );
    if (breaks.length)
      refuse(
        409,
        `${breaks.map((m) => `${m.name} needs ${id} ${m.dependencies.find((d) => d.id === id)!.range}`).join('; ')}, which ${version} does not satisfy.`,
        { code: 'version-conflict', dependents: breaks.map(brief) },
      );
  }

  /**
   * Refuse a version change that would leave the pack on in a project where a
   * pack the new version needs is off. Activation asks before turning a
   * dependency on; a version change has no one to ask, so it refuses and
   * names each project and what is off there.
   */
  private async assertDependenciesOn(manifest: PackManifest) {
    const projects = await this.projectsWith(manifest.id);
    if (!projects.length) return;
    const installed = (await this.installedCurrent()).filter((m) => m.id !== manifest.id);
    const resolution = resolvePacks({
      requests: [{ id: manifest.id, range: manifest.version }],
      available: [...installed, manifest],
    });
    // An unresolvable version is refused by the install plan, with its reason.
    if (!resolution.ok) return;
    const byId = new Map(installed.map((m) => [m.id, m]));
    const off = projects
      .map((project) => {
        const packs = this.options.store.state(project.id).project.packs;
        const dependencies = resolution.order
          .filter((item) => item.id !== manifest.id && !isPackActive(packs, item.id))
          .map((item) => brief(byId.get(item.id)!));
        return { ...project, dependencies };
      })
      .filter((project) => project.dependencies.length);
    if (off.length)
      refuse(
        409,
        off
          .map(
            (project) =>
              `In ${project.name}, ${manifest.name} is on and ${manifest.version} needs ${names(project.dependencies)}, which ${project.dependencies.length === 1 ? 'is' : 'are'} off there.`,
          )
          .join(' ') + ` Turn ${off.length === 1 && off[0].dependencies.length === 1 ? 'it' : 'them'} on there first, or turn ${manifest.name} off.`,
        { code: 'dependency-off', projects: off },
      );
  }

  private async noteProjects(id: string, sentence: string) {
    for (const project of await this.projectsWith(id)) {
      const state = this.options.store.state(project.id);
      this.options.store.addEntry(state, { kind: 'pack', sentence });
      await this.options.store.persist(state);
    }
  }

  async update(packId: string, source: unknown) {
    await this.fresh();
    return this.guarded('update', packId, async () => {
      const record = this.file!.packs[packId];
      if (!record) refuse(404, 'That pack is not installed.');
      const acquired = await this.acquire(source ?? { kind: 'bundled', packId });
      const { manifest } = acquired;
      if (manifest.id !== packId) refuse(400, `That folder holds ${manifest.id}, not ${packId}.`);
      if (compareVersions(manifest.version, record.current) <= 0)
        refuse(
          409,
          `${manifest.version} is not newer than the installed ${record.current}. Rollback returns to the previous version.`,
          { code: 'not-newer' },
        );
      await this.assertDependentsAccept(packId, manifest.version);
      const plan = await this.installPlan(manifest);
      if (!plan.ok) refuseResolution(manifest.name, plan.refusals);
      if (plan.alsoInstalls.length)
        refuse(409, `${manifest.name} ${manifest.version} needs ${names(plan.alsoInstalls)} installed first.`, {
          code: 'needs-dependencies',
          dependencies: plan.alsoInstalls.map(brief),
        });
      await this.assertDependenciesOn(manifest);
      const from = record.current;
      await this.commit(acquired, 'update', 'you', from);
      await this.noteProjects(
        packId,
        `You updated ${manifest.name} from ${from} to ${manifest.version} while it was on in this project. It adds no permission.`,
      );
      return { updated: packId, from, to: manifest.version };
    });
  }

  async rollback(packId: string) {
    await this.fresh();
    return this.guarded('rollback', packId, async () => {
      const record = this.file!.packs[packId];
      if (!record) refuse(404, 'That pack is not installed.');
      const target = record.previous.at(-1);
      if (!target) refuse(409, 'There is no previous version to roll back to.', { code: 'no-previous' });
      const manifest = await this.manifestOf(packId, target);
      if (manifest instanceof Error) refuse(409, `${target} cannot be restored: ${manifest.message}`);
      await this.assertDependentsAccept(packId, target);
      const plan = await this.installPlan(manifest);
      if (!plan.ok || plan.alsoInstalls.length)
        refuse(409, `${manifest.name} ${target} no longer resolves against what is installed.`, {
          code: 'version-conflict',
        });
      await this.assertDependenciesOn(manifest);
      const from = record.current;
      const opId = identifier('pk');
      const base = {
        opId,
        kind: 'rollback' as const,
        packId,
        by: 'you' as const,
        fromVersion: from,
        toVersion: target,
        digest: manifest.digest,
        projectId: null,
        source: null,
      };
      await this.append({ ...base, phase: 'started', detail: `${manifest.name} ${from} → ${target}` });
      record.current = target;
      record.previous = record.previous.slice(0, -1);
      await this.append({
        ...base,
        phase: 'completed',
        detail: `You rolled ${manifest.name} back from ${from} to ${target}. ${from} stays on disk; rolling back grants and restores no permission.`,
      });
      await this.noteProjects(
        packId,
        `You rolled ${manifest.name} back from ${from} to ${target} while it was on in this project. It adds no permission.`,
      );
      return { rolledBack: packId, from, to: target };
    });
  }

  async uninstall(packId: string) {
    await this.fresh();
    return this.guarded('uninstall', packId, async () => {
      const record = this.file!.packs[packId];
      if (!record) refuse(404, 'That pack is not installed.');
      const manifest = await this.current(packId);
      const name = manifest?.name ?? packId;
      const projects = await this.projectsWith(packId);
      if (projects.length)
        refuse(
          409,
          `${name} is on in ${projects.map((p) => p.name).join(', ')}. Turn it off there first; uninstalling never turns a pack off for you.`,
          { code: 'in-use', projects },
        );
      const { dependents, unknown } = await this.dependentsOf(packId);
      if (dependents.length)
        refuse(409, `${names(dependents)} ${dependents.length === 1 ? 'depends' : 'depend'} on ${name}. Uninstall ${dependents.length === 1 ? 'it' : 'them'} first.`, {
          code: 'in-use',
          dependents: dependents.map(brief),
        });
      if (unknown.length) refuseUnknownDependents(unknown);
      const opId = identifier('pk');
      const base = {
        opId,
        kind: 'uninstall' as const,
        packId,
        by: 'you' as const,
        fromVersion: record.current,
        toVersion: null,
        digest: manifest?.digest ?? null,
        projectId: null,
        source: null,
      };
      await this.append({ ...base, phase: 'started', detail: name });
      delete this.file!.packs[packId];
      await this.append({
        ...base,
        phase: 'completed',
        detail: `You uninstalled ${name} ${record.current}. Its History in each project stays as it was.`,
      });
      // After the commit: a crash here leaves folders nothing names, swept on the next open.
      await fs.rm(path.join(this.objectsRoot, packId), { recursive: true, force: true });
      for (const version of record.versions) this.manifests.delete(version.object);
      return { uninstalled: packId };
    });
  }

  // --- per-project activation ----------------------------------------------------------

  async activate(projectId: string, packId: string, options: { includeDependencies?: boolean } = {}) {
    await this.fresh();
    return this.guarded('activate', packId, async () => {
      const state = this.options.store.state(projectId);
      const record = this.file!.packs[packId];
      if (!record) refuse(409, 'That pack is not installed. Install it first.', { code: 'not-installed' });
      const manifest = await this.current(packId);
      if (!manifest)
        refuse(409, 'That pack cannot be turned on: its installed files do not verify.', {
          code: 'damaged',
        });
      const resolution = resolvePacks({
        requests: [{ id: packId, range: manifest.version }],
        available: await this.installedCurrent(),
      });
      if (!resolution.ok) refuseResolution(manifest.name, resolution.refusals);
      const installed = await this.installedCurrent();
      const byId = new Map(installed.map((m) => [m.id, m]));
      const missing = resolution.order
        .filter((item) => item.id !== packId && !isPackActive(state.project.packs, item.id))
        .map((item) => byId.get(item.id)!);
      if (missing.length && !options.includeDependencies)
        refuse(409, `${manifest.name} needs ${names(missing)} on in this project too.`, {
          code: 'needs-dependencies',
          dependencies: missing.map(brief),
        });
      for (const item of [...missing, manifest]) await this.turn(projectId, item, 'active');
      return this.options.store.state(projectId);
    });
  }

  async deactivate(projectId: string, packId: string) {
    await this.fresh();
    return this.guarded('deactivate', packId, async () => {
      const state = this.options.store.state(projectId);
      const manifest = await this.current(packId);
      const name = manifest?.name ?? packId;
      const found = await this.dependentsOf(packId);
      const dependents = found.dependents.filter((m) => isPackActive(state.project.packs, m.id));
      // A damaged pack that is on here and whose dependencies are unknown may need this one.
      const unknown = found.unknown.filter((id) => isPackActive(state.project.packs, id));
      if (dependents.length)
        refuse(
          409,
          `${names(dependents)} ${dependents.length === 1 ? 'is' : 'are'} on in this project and ${dependents.length === 1 ? 'depends' : 'depend'} on ${name}. Turn ${dependents.length === 1 ? 'it' : 'them'} off first.`,
          { code: 'in-use', dependents: dependents.map(brief) },
        );
      if (unknown.length) refuseUnknownDependents(unknown);
      await this.turn(projectId, manifest ?? { id: packId, name, version: '0.0.0' }, 'inactive');
      return this.options.store.state(projectId);
    });
  }

  /** One project decision, through the one activation writer. */
  private async turn(
    projectId: string,
    manifest: Pick<PackManifest, 'id' | 'name' | 'version'>,
    next: 'active' | 'inactive',
  ) {
    const before = (this.options.store.state(projectId).project.packs ?? []).length;
    if (isCapabilityPackId(manifest.id))
      await (next === 'active' ? activatePack : deactivatePack)(
        this.options.store,
        projectId,
        manifest.id,
      );
    else await recordPackActivation(this.options.store, projectId, manifest, next, now());
    if ((this.options.store.state(projectId).project.packs ?? []).length === before) return;
    await this.append({
      opId: identifier('pk'),
      kind: next === 'active' ? 'activate' : 'deactivate',
      phase: 'completed',
      packId: manifest.id,
      by: 'you',
      fromVersion: null,
      toVersion: manifest.version,
      digest: null,
      projectId,
      source: null,
      detail: `You turned ${next === 'active' ? 'on' : 'off'} ${manifest.name} in one project. It grants nothing.`,
    });
  }
}

const brief = (m: Pick<PackManifest, 'id' | 'name' | 'version'>) => ({
  id: m.id,
  name: m.name,
  version: m.version,
});
const names = (items: readonly Pick<PackManifest, 'name'>[]) =>
  items.map((item) => item.name).join(', ');
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function refuseResolution(name: string, refusals: readonly ResolutionRefusal[]): never {
  return refuse(409, `${name} cannot be resolved. ${refusals.map((r) => r.message).join(' ')}`, {
    code: refusals[0]?.code ?? 'unresolved',
    refusals,
  });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isStringList = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The shape this build writes, checked before a single field of it is trusted. */
function isPackStoreFile(value: unknown): value is PackStoreFile {
  if (!isPlainObject(value) || value.schemaVersion !== PACK_STORE_SCHEMA_VERSION) return false;
  if (!isPlainObject(value.packs) || !Array.isArray(value.operations)) return false;
  const packsOk = Object.entries(value.packs).every(
    ([id, record]) =>
      isPlainObject(record) &&
      record.id === id &&
      typeof record.current === 'string' &&
      isStringList(record.previous) &&
      Array.isArray(record.versions) &&
      record.versions.every(
        (version: unknown) =>
          isPlainObject(version) &&
          typeof version.version === 'string' &&
          typeof version.digest === 'string' &&
          typeof version.object === 'string' &&
          (version.dependencies === undefined || Array.isArray(version.dependencies)),
      ),
  );
  const operationsOk = value.operations.every(
    (op: unknown) =>
      isPlainObject(op) &&
      typeof op.opId === 'string' &&
      typeof op.kind === 'string' &&
      typeof op.phase === 'string' &&
      typeof op.packId === 'string',
  );
  return packsOk && operationsOk;
}

function refuseUnknownDependents(unknown: readonly string[]): never {
  const one = unknown.length === 1;
  return refuse(
    409,
    `${unknown.join(', ')} ${one ? 'is' : 'are'} damaged, and what ${one ? 'it depends' : 'they depend'} on cannot be read. Turn ${one ? 'it' : 'them'} off or uninstall ${one ? 'it' : 'them'} first.`,
    { code: 'damaged-dependent', damaged: [...unknown] },
  );
}
