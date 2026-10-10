/**
 * Optional AgentFS task workspaces over a pinned Core Files base (TS05 of
 * NC-TS-2026-10-09.1, DIO-31). Candidate code: the loop does not use it yet.
 *
 * A sub-task normally works in a copy of its scope (`server/sandbox/sandbox.ts`),
 * and that stays the default. This adapter holds a sub-task's files another way,
 * in `<data>/projects/<id>/harness/workspaces/<job id>/`:
 *
 * - The base is pinned. Every project file in the scope is read once, hashed and
 *   kept by hash (`base/<sha>`). `base.json` lists each path, sha and size, and
 *   the sha of its exact bytes names it. A read of the base is checked against
 *   that sha, so a changed or missing object is refused, never read as another.
 * - The job's changes go into one AgentFS database of its own (`delta-<id>.db`,
 *   a new name for every workspace), and nowhere else. One writer holds it at a
 *   time. The job's assignment fence names its owner, and giving the job to a
 *   new owner moves the fence, so the old owner's writes and results are refused.
 * - Promotion checks the fence, the digest of what was proposed, every path, every
 *   file's bytes and the generation of the sources the job was given. Then it
 *   writes through `Store.writeRecorded`, the one recorded writer, with the pinned
 *   sha as the expected version: a file that moved on in the project is a
 *   conflict and nothing is written over it. A promoted workspace is spent: it
 *   takes no more writes, and still opens to read, so a change it left waiting
 *   or in conflict can be reviewed.
 *
 * AgentFS is a place for a job's edits here. It is not the Files catalog, not
 * memory and not evidence of an external effect: its tool log is read only as
 * observations. The SDK is never a dependency of this repository, because
 * agentfs-sdk 0.6.4 cannot be redistributed. `loadAgentFsSdk` loads an install
 * an operator made, after checking the pinned versions. The adapter runs file
 * tools only: running a program needs an isolated environment, and this
 * installation has none (`server/trust/environments.ts`).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { OriginSnapshot } from '../../shared/attribution.js';
import type { Json } from '../../shared/harness.js';
import { SANDBOX_LIMITS, inScope } from '../../shared/sandbox.js';
import { ApiError, isContained, relativeName } from '../paths.js';
import { bytesHash, jsonWrite, now, type Store } from '../store.js';
import { validateRunId } from '../harness/run-store.js';
import { HarnessError, canonical } from '../harness/policy.js';
import { ToolRegistry } from '../harness/tools.js';
import { textOf } from '../sandbox/sandbox.js';
import { NO_ENVIRONMENT_REASON, listIsolatedEnvironments } from '../trust/environments.js';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const MB = 1024 * 1024;
const megabytes = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;
/** A delta's file name. Each workspace made or opened on a host gets a new one (see `WorkspaceLease.delta`). */
const DELTA_NAME = /^delta-[a-f0-9]{16}\.db$/;
const newDeltaName = () => `delta-${randomBytes(8).toString('hex')}.db`;
/** The journal files the engine keeps beside a database, named after it. */
const JOURNALS = ['-wal', '-shm', '-journal'] as const;
/** Whether a file name is this delta's database or one of its journal files. */
const isDeltaFile = (delta: string, name: string) => name === delta || JOURNALS.some((suffix) => name === `${delta}${suffix}`);

// --- the SDK, by shape --------------------------------------------------------------

/** The parts of agentfs-sdk 0.6.4 this adapter uses, typed by shape so the SDK is never a dependency. */
export interface AgentFsStats {
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface AgentFsToolCall {
  id: number;
  name: string;
  parameters?: unknown;
  result?: unknown;
  error?: string;
  status: string;
  started_at: number;
  completed_at?: number;
  duration_ms?: number;
}
export interface AgentFsHandle {
  readonly fs: {
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, data: string | Buffer): Promise<void>;
    readdir(path: string): Promise<string[]>;
    lstat(path: string): Promise<AgentFsStats>;
    statfs(): Promise<{ inodes: number; bytesUsed: number }>;
    /** The chunk size the SDK read from the database's own settings. */
    getChunkSize(): number;
  };
  readonly kv: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  readonly tools: { getRecent(since: number, limit?: number): Promise<AgentFsToolCall[]> };
  close(): Promise<void>;
}
export interface AgentFsSdk {
  readonly version: string;
  readonly engineVersion: string;
  open(options: { path: string }): Promise<AgentFsHandle>;
}

/** The build this adapter was written and qualified against (TS00). */
export const AGENTFS_PINS = Object.freeze({ sdk: '0.6.4', engine: '0.4.4' });
/**
 * The native file the pinned engine loads, by platform, with its sha256 from TS00's
 * artifact manifest. Only these platforms were qualified, so no other one loads.
 */
const AGENTFS_NATIVE: Readonly<Record<string, { readonly package: string; readonly file: string; readonly sha256: string }>> = Object.freeze({
  'win32-x64': {
    package: '@tursodatabase/database-win32-x64-msvc',
    file: 'turso.win32-x64-msvc.node',
    sha256: '30f92ca6b7dc36895099ab1b657d3a818e9b5bb08031e7428f5bb4e4eeb83165',
  },
});
/** The SDK's own chunk size. A database stores its chunk size, and the SDK writes with whatever it finds. */
const AGENTFS_CHUNK_SIZE = 4096;
const LOADER_OVERRIDES = ['NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI'] as const;

export class WorkspaceRefused extends HarnessError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

async function packageAt(folder: string): Promise<{ name?: unknown; version?: unknown } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The folder Node loads package `name` from for a file in `from`: the first
 * `node_modules/<name>` folder found walking up, skipping folders that are
 * themselves `node_modules`. Its real path, since Node resolves that package's
 * own imports from there.
 */
async function resolvePackage(from: string, name: string) {
  for (let at = path.resolve(from); ; ) {
    if (path.basename(at) !== 'node_modules') {
      const folder = path.join(at, 'node_modules', ...name.split('/'));
      if ((await fs.stat(folder).catch(() => null))?.isDirectory()) {
        const real = await fs.realpath(folder);
        return { folder: real, json: await packageAt(real) };
      }
    }
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * Load agentfs-sdk from a `node_modules` folder an operator installed. It loads
 * only on a qualified platform, with no loader override set in this process,
 * and only when each package Node would load is the pinned one: the SDK, the
 * engine it imports, the engine's common package, and the native file the
 * engine loads, checked by its sha256. A native file beside the engine's own
 * loader would be loaded before the pinned one, so it is refused.
 */
export async function loadAgentFsSdk(
  nodeModules: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly platform?: string; readonly arch?: string } = {},
): Promise<AgentFsSdk> {
  // The engine's loader reads this process's environment, whatever a caller passes.
  const env = { ...process.env, ...options.env };
  const overrides = LOADER_OVERRIDES.filter((name) => env[name] !== undefined);
  if (overrides.length)
    throw new WorkspaceRefused(
      'agentfs_loader_override',
      `AgentFS was not loaded: ${overrides.join(' and ')} can make Node load a different native file than the pinned one.`,
    );
  const platform = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
  const native = AGENTFS_NATIVE[platform];
  if (!native)
    throw new WorkspaceRefused(
      'agentfs_platform_unqualified',
      `AgentFS was not loaded: agentfs-sdk ${AGENTFS_PINS.sdk} was qualified on ${Object.keys(AGENTFS_NATIVE).join(', ')} only, and this is ${platform}.`,
    );
  const root = path.resolve(nodeModules);
  const sdkFolder = path.join(root, 'agentfs-sdk');
  const sdk = await packageAt(sdkFolder);
  if (sdk?.name !== 'agentfs-sdk' || sdk.version !== AGENTFS_PINS.sdk)
    throw new WorkspaceRefused(
      'agentfs_not_pinned',
      `AgentFS was not loaded: this adapter runs agentfs-sdk ${AGENTFS_PINS.sdk}, and ${sdk ? `${String(sdk.name)} ${String(sdk.version)}` : 'no agentfs-sdk'} is installed there.`,
    );
  const pinned = async (from: string, name: string, version: string) => {
    const found = await resolvePackage(from, name);
    if (found?.json?.name !== name || found.json.version !== version)
      throw new WorkspaceRefused(
        'agentfs_not_pinned',
        `AgentFS was not loaded: agentfs-sdk ${AGENTFS_PINS.sdk} must run on ${name} ${version}, and ${found?.json ? String(found.json.version) : 'none'} resolves there.`,
      );
    return found.folder;
  };
  // Each package is found from the file that imports it: the engine from the SDK's code, its common package from
  // the engine's code, and its native file from the engine's loader.
  const engine = await pinned(path.join(sdkFolder, 'dist'), '@tursodatabase/database', AGENTFS_PINS.engine);
  const stray = (await fs.readdir(engine)).filter((name) => /^turso\..+\.node$/.test(name));
  if (stray.length)
    throw new WorkspaceRefused(
      'agentfs_not_pinned',
      `AgentFS was not loaded: ${stray[0]} beside the engine’s loader would be loaded instead of the pinned native file.`,
    );
  await pinned(path.join(engine, 'dist'), '@tursodatabase/database-common', AGENTFS_PINS.engine);
  const binding = await pinned(engine, native.package, AGENTFS_PINS.engine);
  const loads = await fs.readFile(path.join(binding, native.file)).catch(() => null);
  if (!loads || sha256(loads) !== native.sha256)
    throw new WorkspaceRefused(
      'agentfs_not_pinned',
      `AgentFS was not loaded: ${native.file} in ${native.package} ${AGENTFS_PINS.engine} is ${loads ? `sha256 ${sha256(loads)}` : 'missing'}, not the pinned ${native.sha256}.`,
    );
  type Agent = { fs: AgentFsHandle['fs']; kv: AgentFsHandle['kv']; tools: AgentFsHandle['tools']; close(): Promise<void> };
  const loaded = (await import(pathToFileURL(path.join(sdkFolder, 'dist', 'index_node.js')).href)) as {
    AgentFS?: { open?: (options: { path: string }) => Promise<Agent> };
  };
  const AgentFS = loaded.AgentFS;
  if (typeof AgentFS?.open !== 'function')
    throw new WorkspaceRefused('agentfs_not_pinned', 'AgentFS was not loaded: the installed SDK has no AgentFS.open.');
  return {
    version: AGENTFS_PINS.sdk,
    engineVersion: AGENTFS_PINS.engine,
    async open({ path: file }) {
      const agent = await AgentFS.open!({ path: file });
      return { fs: agent.fs, kv: agent.kv, tools: agent.tools, close: () => agent.close() };
    },
  };
}

// --- choosing an adapter ------------------------------------------------------------

/**
 * Which workspace a sub-task gets. The copy sandbox stays the default: AgentFS is
 * used only when an operator loaded it and the sub-task needs no program run.
 */
export function workspaceAdapterFor(options: { sdk: AgentFsSdk | null; runsPrograms: boolean }) {
  if (!options.sdk) return { adapter: 'copy' as const, reason: 'AgentFS is not set up on this installation.' };
  if (options.runsPrograms)
    return { adapter: 'copy' as const, reason: 'A sub-task that runs programs works in a copy: an AgentFS workspace has file tools only.' };
  return { adapter: 'agentfs' as const, reason: `agentfs-sdk ${options.sdk.version} on ${options.sdk.engineVersion}, file tools only.` };
}

/** Running a program inside an AgentFS workspace needs an isolated environment. There is none, and AgentFS runs are unqualified. */
export function workspaceProcessExecution(): { available: false; reason: string } {
  return {
    available: false,
    reason: listIsolatedEnvironments().length
      ? 'AgentFS has not been qualified to run programs on any platform, so a workspace runs file tools only.'
      : NO_ENVIRONMENT_REASON,
  };
}

/** Encryption and sync, when asked for. The pinned SDK offers neither, so either is refused by name, never dropped. */
export function refuseUnsupportedModes(mode: { readonly encryption?: boolean; readonly sync?: boolean } | undefined) {
  if (mode?.encryption && mode.sync)
    throw new WorkspaceRefused(
      'agentfs_encryption_with_sync',
      'No workspace was made: AgentFS 0.6.4 cannot keep a workspace encrypted and synced at once, and a workspace is never made without the encryption asked for.',
    );
  if (mode?.encryption)
    throw new WorkspaceRefused(
      'agentfs_encryption_unsupported',
      'No workspace was made: this AgentFS build cannot encrypt a workspace, and a workspace is never made without the encryption asked for.',
    );
  if (mode?.sync)
    throw new WorkspaceRefused('agentfs_sync_unsupported', 'No workspace was made: workspaces are not synced by this adapter.');
}

// --- records ------------------------------------------------------------------------

export interface WorkspaceLimits {
  /** Files the pinned base may hold, and files a job's changes may hold. */
  readonly maxFiles: number;
  /** Bytes across the pinned base. */
  readonly maxBaseBytes: number;
  /** Bytes one file may hold, pinned or written. */
  readonly maxFileBytes: number;
  /** Bytes a job's changes may hold. A change to a pinned file counts at least the whole file. */
  readonly maxDeltaBytes: number;
  /**
   * Bytes the workspace's own database may take on disk, its journal files
   * included. The engine keeps a write-ahead log beside the database, so a
   * few bytes of change can take far more space than the change itself.
   */
  readonly maxDeltaDiskBytes: number;
  /** Free space a write must leave on the workspace's disk beyond what it reserves. */
  readonly diskHeadroomBytes: number;
}
export const WORKSPACE_LIMITS: WorkspaceLimits = Object.freeze({
  maxFiles: SANDBOX_LIMITS.maxFiles,
  maxBaseBytes: SANDBOX_LIMITS.maxBytes,
  maxFileBytes: SANDBOX_LIMITS.maxFileBytes,
  maxDeltaBytes: SANDBOX_LIMITS.maxBytes,
  maxDeltaDiskBytes: 4 * SANDBOX_LIMITS.maxBytes,
  diskHeadroomBytes: 256 * MB,
});
const limitsSchema = z.strictObject({
  maxFiles: z.number().int().positive(),
  maxBaseBytes: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  maxDeltaBytes: z.number().int().positive(),
  maxDeltaDiskBytes: z.number().int().positive(),
  diskHeadroomBytes: z.number().int().nonnegative(),
});

export interface BaseFile {
  readonly path: string;
  readonly sha: string;
  readonly bytes: number;
  /** The History version that recorded these bytes, when one did. */
  readonly revision: string | null;
}
export interface BaseManifest {
  readonly v: 1;
  readonly projectId: string;
  readonly jobId: string;
  readonly scope: readonly string[] | null;
  readonly files: readonly BaseFile[];
}
const baseManifestSchema = z.strictObject({
  v: z.literal(1),
  projectId: z.string(),
  jobId: z.string(),
  scope: z.array(z.string()).nullable(),
  files: z.array(
    z.strictObject({ path: z.string(), sha: z.string().regex(SHA), bytes: z.number().int().nonnegative(), revision: z.string().nullable() }),
  ),
});

export interface WorkspaceLease {
  readonly v: 1;
  readonly projectId: string;
  readonly jobId: string;
  /** `<job id>#<generation>`: the one owner that may write and promote. */
  readonly assignmentFence: string;
  /** The sha of `base.json`'s exact bytes. */
  readonly baseManifestRef: string;
  readonly workspaceRef: string;
  /**
   * The delta's file name, new for every workspace made or opened on a host.
   * In one process, Turso 0.4.4 keeps a database it opened in memory by path:
   * a database removed and made again at the same path comes back with its old
   * rows, and its writes never reach the new file. A new name never meets that.
   */
  readonly delta: string;
  /** The scope the job was given. Every output must fall inside it. */
  readonly allowedOutputPaths: readonly string[] | null;
  /** The generation of the sources' grants when the base was pinned. */
  readonly sourceGeneration: string;
  readonly adapter: 'agentfs';
  readonly sdk: { readonly version: string; readonly engineVersion: string };
  readonly isolation: 'file-tools-only';
  readonly state: 'materializing' | 'open' | 'promoted';
  readonly createdAt: string;
  readonly promotedAt: string | null;
  readonly limits: WorkspaceLimits;
}
const leaseSchema = z.strictObject({
  v: z.literal(1),
  projectId: z.string(),
  jobId: z.string(),
  assignmentFence: z.string(),
  baseManifestRef: z.string(),
  workspaceRef: z.string(),
  // A checkpoint carries its lease, and this name becomes part of a path.
  delta: z.string().regex(DELTA_NAME),
  allowedOutputPaths: z.array(z.string()).nullable(),
  sourceGeneration: z.string(),
  adapter: z.literal('agentfs'),
  sdk: z.strictObject({ version: z.string(), engineVersion: z.string() }),
  isolation: z.literal('file-tools-only'),
  state: z.enum(['materializing', 'open', 'promoted']),
  createdAt: z.string(),
  promotedAt: z.string().nullable(),
  limits: limitsSchema,
});

interface Assignment {
  readonly v: 1;
  readonly jobId: string;
  readonly generation: number;
  readonly owner: string;
  readonly at: string;
}
const fenceOf = (assignment: Assignment) => `${assignment.jobId}#${assignment.generation}`;

/** One changed file a job proposes, measured against the pinned base. */
export interface WorkspaceOutput {
  readonly path: string;
  readonly op: 'created' | 'modified';
  readonly before: string | null;
  readonly after: string;
  readonly bytes: number;
  readonly proposed: boolean;
}
export interface WorkspaceOutputs {
  readonly v: 1;
  readonly jobId: string;
  readonly assignmentFence: string;
  readonly baseManifestRef: string;
  readonly entries: readonly WorkspaceOutput[];
  readonly dropped: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * Who may still read the files a job was given. The generation is a digest of
 * the grants that cover those paths; any change makes the job's output stale.
 * A hand-back reads it inside the Store's lock, right before its writes, so it
 * must not wait for that lock.
 */
export interface WorkspaceSources {
  generation(projectId: string, paths: readonly string[]): Promise<string> | string;
}

export interface MaterializeSpec {
  readonly projectId: string;
  readonly jobId: string;
  /** Who the job is assigned to. A job already assigned to someone else is refused. */
  readonly owner: string;
  readonly scope: readonly string[] | null;
  readonly mode?: { readonly encryption?: boolean; readonly sync?: boolean };
  readonly limits?: Partial<WorkspaceLimits>;
}

export interface PromoteRequest {
  /** The digest `proposeOutputs` returned. Anything else in the workspace now is refused. */
  readonly digest: string;
  readonly canWrite: boolean;
  readonly applyScope: readonly string[] | null;
  readonly origin: OriginSnapshot;
  readonly sessionId: string | null;
  readonly taskId: string | null;
}
/**
 * What a hand-back did with each change. A change that waits or conflicts stays
 * in the spent workspace, where a reader can still open it, and carries the
 * shas a person's review needs: the pinned file it was made against and its own.
 */
export interface PromoteResult {
  readonly applied: readonly { readonly path: string; readonly sha: string; readonly entryId: string | null; readonly replayed: boolean }[];
  readonly conflicts: readonly { readonly path: string; readonly currentSha: string | null; readonly before: string | null; readonly after: string }[];
  readonly waiting: readonly { readonly path: string; readonly reason: string; readonly before: string | null; readonly after: string }[];
  readonly dropped: WorkspaceOutputs['dropped'];
}

export interface WorkspaceObservation {
  readonly source: 'agentfs-tool-log';
  readonly trust: 'observation';
  readonly name: string;
  readonly status: 'pending' | 'success' | 'error' | 'unknown';
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface WorkspaceSession {
  readonly lease: WorkspaceLease;
  readonly tools: ToolRegistry;
  close(): Promise<void>;
}

const checkpointSchema = z.strictObject({
  v: z.literal(1),
  lease: leaseSchema,
  delta: z.strictObject({
    files: z.array(z.strictObject({ name: z.string(), sha: z.string().regex(SHA), bytes: z.number().int().nonnegative() })),
    entries: z.array(z.strictObject({ path: z.string(), sha: z.string().regex(SHA) })),
  }),
  createdAt: z.string(),
});

/** A failure inside the Store's own writer, to be thrown inside its lock so the Store recovers its state (see `exclusive`). */
class StoreFailure {
  constructor(readonly cause: unknown) {}
}

const DEPTH = 32;
/** Entries a walk of one delta visits before it refuses: a database written outside the tools can hold any number of folders. */
const MAX_ENTRIES = 10_000;
/**
 * Writers open in this process: the nonce each holds, by workspace folder. Kept for
 * the whole process, not per instance: a lock naming this process is live exactly
 * when its folder is here. A writer lets go of a lock or an entry only when it
 * holds that lock's nonce, so a writer that outlived its workspace never frees
 * the next one's.
 */
const openWriters = new Map<string, string>();
/**
 * Checkpoints being opened in this process, by workspace folder. Kept for the whole
 * process, as `openWriters` is: two imports for one job would copy into one folder.
 */
const importing = new Set<string>();
/** Names in code-unit order, the same on every host, unlike a locale's order. */
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** The generation in a fence `<job id>#<generation>`, or null when it names another job or no number. */
function fenceGeneration(fence: string, jobId: string) {
  const digits = fence.startsWith(`${jobId}#`) ? fence.slice(jobId.length + 1) : '';
  return /^[1-9]\d{0,8}$/.test(digits) ? Number(digits) : null;
}
const toDelta = (relative: string) => `/${relative}`;
const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
/** Whether a file at `relative` would need a pinned file to be a folder, or would stand where a pinned file's folder is. */
function folderClash(relative: string, pinned: ReadonlyMap<string, unknown>) {
  const parts = relative.split('/');
  for (let depth = 1; depth < parts.length; depth++) if (pinned.has(parts.slice(0, depth).join('/'))) return true;
  const folder = `${relative}/`;
  for (const name of pinned.keys()) if (name.startsWith(folder)) return true;
  return false;
}
/** The folder, or the nearest folder above it that exists: free space is asked of a folder that is there. */
async function existingFolder(folder: string) {
  let at = path.resolve(folder);
  while (!(await fs.lstat(at).catch(() => null))) {
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  return at;
}
/** A folder's real path, found through its nearest existing folder when it is not there yet, so a link cannot hide where it leads. */
async function realFolder(folder: string) {
  const resolved = path.resolve(folder);
  const there = await existingFolder(resolved);
  return path.join(await fs.realpath(there).catch(() => there), path.relative(there, resolved));
}
/** One file of a checkpoint, read only when it is a plain file of the size it was listed at, and only when its bytes match its sha. */
async function verifiedCopy(file: string, sha: string, bytes: number): Promise<Buffer | null> {
  const found = await fs.lstat(file).catch(() => null);
  if (!found?.isFile() || found.size !== bytes) return null;
  const read = await fs.readFile(file).catch(() => null);
  return read && read.byteLength === bytes && sha256(read) === sha ? read : null;
}

// --- the workspaces -----------------------------------------------------------------

export interface AgentFsWorkspacesOptions {
  readonly store: Store;
  readonly sdk: AgentFsSdk;
  readonly sources: WorkspaceSources;
  /** Where workspaces live. The store's data folder unless another host's is named. */
  readonly dataDir?: string;
  /** Free bytes on the disk holding a folder. */
  readonly freeBytes?: (folder: string) => Promise<number>;
}

export class AgentFsWorkspaces {
  private readonly store: Store;
  private readonly sdk: AgentFsSdk;
  private readonly sources: WorkspaceSources;
  private readonly dataDir: string;
  private readonly freeBytes: (folder: string) => Promise<number>;

  constructor(options: AgentFsWorkspacesOptions) {
    this.store = options.store;
    this.sdk = options.sdk;
    this.sources = options.sources;
    this.dataDir = options.dataDir ?? options.store.dataDir;
    this.freeBytes =
      options.freeBytes ??
      (async (folder) => {
        const stats = await fs.statfs(folder);
        return Number(stats.bavail) * Number(stats.bsize);
      });
  }

  private harness(projectId: string) {
    this.store.state(projectId);
    return path.join(this.dataDir, 'projects', projectId, 'harness');
  }
  dir(projectId: string, jobId: string) {
    return path.join(this.harness(projectId), 'workspaces', validateRunId(jobId));
  }
  private assignmentFile(projectId: string, jobId: string) {
    return path.join(this.harness(projectId), 'workspace-assignments', `${validateRunId(jobId)}.json`);
  }

  // --- assignment -------------------------------------------------------------------

  async assignment(projectId: string, jobId: string): Promise<Assignment | null> {
    try {
      return JSON.parse(await fs.readFile(this.assignmentFile(projectId, jobId), 'utf8')) as Assignment;
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  }
  /**
   * Run under the Store's lock, so it never interleaves with a hand-back's writes.
   * The Store takes anything thrown inside its lock as a failure of its own: it
   * reloads every project and interrupts every approval waiting to run. A refusal
   * or a failure in a workspace's own files leaves the Store as it was, so it is
   * carried out of the lock and thrown there. Only a failure inside the Store's
   * writer, which can leave its state behind what is on disk, is thrown inside.
   */
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const outcome: { value: T } | { failed: unknown } = await this.store.locked(async () => {
      try {
        return { value: await action() };
      } catch (error) {
        if (error instanceof StoreFailure) throw error.cause;
        return { failed: error };
      }
    });
    if ('failed' in outcome) throw outcome.failed;
    return outcome.value;
  }
  /** Give the job to a new owner. Every lease under the old fence can no longer write or promote. */
  async reassign(projectId: string, jobId: string, owner: string): Promise<string> {
    const file = this.assignmentFile(projectId, jobId);
    return this.exclusive(async () => {
      const current = await this.assignment(projectId, jobId);
      const next: Assignment = { v: 1, jobId, generation: (current?.generation ?? 0) + 1, owner, at: now() };
      await jsonWrite(file, next);
      return fenceOf(next);
    });
  }
  /** The job's assignment, made for `owner` when the job has none. A job assigned to someone else is refused. */
  private async claim(projectId: string, jobId: string, owner: string): Promise<Assignment> {
    const file = this.assignmentFile(projectId, jobId);
    return this.exclusive(async () => {
      const current = await this.assignment(projectId, jobId);
      if (current && current.owner !== owner)
        throw new WorkspaceRefused('workspace_stale_assignment', 'This job belongs to another owner, so no workspace was made for this one.');
      if (current) return current;
      const first: Assignment = { v: 1, jobId, generation: 1, owner, at: now() };
      await jsonWrite(file, first);
      return first;
    });
  }
  private async assertFence(lease: WorkspaceLease) {
    const current = await this.assignment(lease.projectId, lease.jobId);
    if (!current || fenceOf(current) !== lease.assignmentFence)
      throw new WorkspaceRefused(
        'workspace_stale_assignment',
        'This job has a newer owner, so this workspace can no longer write or hand back changes.',
      );
  }

  // --- leases -----------------------------------------------------------------------

  async read(projectId: string, jobId: string): Promise<WorkspaceLease | null> {
    let text: string;
    try {
      text = await fs.readFile(path.join(this.dir(projectId, jobId), 'lease.json'), 'utf8');
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
    return leaseSchema.parse(JSON.parse(text)) as WorkspaceLease;
  }
  /** Whether the lease on disk is the workspace a caller's lease names: the same owner's fence, database and base. */
  private static same(found: WorkspaceLease, given: WorkspaceLease) {
    return found.assignmentFence === given.assignmentFence && found.delta === given.delta && found.baseManifestRef === given.baseManifestRef;
  }
  /**
   * The lease as it is on disk now, and only when it is the workspace the caller's
   * lease names. A caller's copy is never trusted for anything else: its state may
   * be stale, and a lease for a workspace that was since replaced opens nothing,
   * even though the new one lives in the same folder.
   */
  private async current(given: WorkspaceLease, wanted: 'open' | 'readable' | 'any' = 'open') {
    const found = await this.read(given.projectId, given.jobId);
    if (!found) throw new WorkspaceRefused('workspace_missing', 'This workspace is no longer there.');
    if (found.assignmentFence !== given.assignmentFence)
      throw new WorkspaceRefused(
        'workspace_stale_assignment',
        'This job has a newer owner, so this workspace can no longer write or hand back changes.',
      );
    if (!AgentFsWorkspaces.same(found, given))
      throw new WorkspaceRefused('workspace_replaced', 'This job’s workspace was made again since this lease was given, so the lease opens nothing.');
    if (wanted !== 'any' && found.state === 'materializing')
      throw new WorkspaceRefused('workspace_not_ready', 'This workspace was not finished being made.');
    if (wanted === 'open' && found.state === 'promoted')
      throw new WorkspaceRefused('workspace_spent', 'This workspace already handed back its changes, so it takes no more.');
    return found;
  }

  /** The pinned base, read back and checked against the lease's reference. */
  private async base(lease: WorkspaceLease): Promise<BaseManifest> {
    const bytes = await fs.readFile(path.join(this.dir(lease.projectId, lease.jobId), 'base.json')).catch(() => null);
    if (!bytes || sha256(bytes) !== lease.baseManifestRef)
      throw new WorkspaceRefused('workspace_base_changed', 'The list of files this workspace was given is missing or changed.');
    return baseManifestSchema.parse(JSON.parse(bytes.toString('utf8'))) as BaseManifest;
  }
  /** One pinned file's exact bytes, or null when its object is missing or does not match its sha. */
  private async pinned(lease: WorkspaceLease, file: BaseFile): Promise<Buffer | null> {
    const bytes = await fs.readFile(path.join(this.dir(lease.projectId, lease.jobId), 'base', file.sha)).catch(() => null);
    return bytes && sha256(bytes) === file.sha ? bytes : null;
  }

  /**
   * Pin the job's base and make its empty delta. Idempotent while the fence
   * holds: an open workspace made for the same scope and limits is returned as
   * it is, and one interrupted while it was being made is made again.
   */
  async materialize(spec: MaterializeSpec): Promise<WorkspaceLease> {
    refuseUnsupportedModes(spec.mode);
    const jobId = validateRunId(spec.jobId);
    const dir = this.dir(spec.projectId, jobId);
    const limits = limitsSchema.parse({ ...WORKSPACE_LIMITS, ...spec.limits }) as WorkspaceLimits;
    const scope = spec.scope === null ? null : [...spec.scope];
    const assignment = await this.claim(spec.projectId, jobId, spec.owner);
    const existing = await this.read(spec.projectId, jobId);
    if (existing && existing.state !== 'materializing') {
      if (existing.assignmentFence !== fenceOf(assignment))
        throw new WorkspaceRefused('workspace_stale_assignment', 'An earlier owner left a workspace for this job. Dispose of it first.');
      if (existing.state === 'promoted')
        throw new WorkspaceRefused('workspace_spent', 'This workspace already handed back its changes, so it takes no more.');
      // Asking again returns the same workspace, never one with a wider scope or other limits than were asked for.
      if (canonical(existing.allowedOutputPaths) !== canonical(scope) || canonical(existing.limits) !== canonical(limits))
        throw new WorkspaceRefused(
          'workspace_spec_changed',
          'This job already has a workspace with another scope or other limits. Dispose of it before asking for a different one.',
        );
      return existing;
    }
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.join(dir, 'base'), { recursive: true });
    const draft: WorkspaceLease = {
      v: 1,
      projectId: spec.projectId,
      jobId,
      assignmentFence: fenceOf(assignment),
      baseManifestRef: '',
      workspaceRef: `workspace:${spec.projectId}/${jobId}`,
      delta: newDeltaName(),
      allowedOutputPaths: scope,
      sourceGeneration: '',
      adapter: 'agentfs',
      sdk: { version: this.sdk.version, engineVersion: this.sdk.engineVersion },
      isolation: 'file-tools-only',
      state: 'materializing',
      createdAt: now(),
      promotedAt: null,
      limits,
    };
    await jsonWrite(path.join(dir, 'lease.json'), draft);
    try {
      return await this.pinBase(scope, draft, dir);
    } catch (error) {
      // A refusal leaves nothing behind. Any other failure leaves the lease materializing, and the next call makes it again.
      if (error instanceof WorkspaceRefused) await fs.rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Read every file in the scope once, keep it by sha, list it, and bind an empty delta to that list. */
  private async pinBase(scope: readonly string[] | null, draft: WorkspaceLease, dir: string): Promise<WorkspaceLease> {
    const { projectId, jobId, limits } = draft;
    const documents = (await this.store.listDocuments(projectId)).filter((document) => inScope(document.path, scope));
    const declared = documents.reduce((sum, document) => sum + document.size, 0);
    if (documents.length > limits.maxFiles || declared > limits.maxBaseBytes)
      throw new WorkspaceRefused(
        'workspace_too_large',
        `This scope holds ${documents.length} ${documents.length === 1 ? 'file' : 'files'} (${megabytes(declared)}); a workspace holds at most ${limits.maxFiles} files and ${megabytes(limits.maxBaseBytes)}. Name fewer files for it.`,
      );
    await this.reserveCopy(
      dir,
      declared,
      limits.diskHeadroomBytes,
      `This scope needs ${megabytes(declared)} of disk space for its workspace, and that would leave too little free, so no workspace was made.`,
    );
    // Read rights are read before the bytes and again after them, so the generation a lease records is the one its bytes were read under.
    const scoped = documents.map((document) => document.path);
    const before = await this.sources.generation(projectId, scoped);
    const state = this.store.state(projectId);
    const files: BaseFile[] = [];
    let total = 0;
    for (const document of documents) {
      let bytes: Buffer | null;
      try {
        bytes = await this.store.currentBytes(projectId, document.path);
      } catch (error) {
        // The path guard refused it (a link, a private name): it is not pinned, so the job never sees it.
        if (error instanceof ApiError) continue;
        throw error;
      }
      if (!bytes) continue;
      if (bytes.byteLength > limits.maxFileBytes)
        throw new WorkspaceRefused(
          'workspace_too_large',
          `${document.path} is ${megabytes(bytes.byteLength)}; a workspace holds files of at most ${megabytes(limits.maxFileBytes)}. Leave it out of the scope.`,
        );
      total += bytes.byteLength;
      if (total > limits.maxBaseBytes)
        throw new WorkspaceRefused('workspace_too_large', `This scope holds more than ${megabytes(limits.maxBaseBytes)}. Name fewer files for it.`);
      const sha = sha256(bytes);
      const object = path.join(dir, 'base', sha);
      if (!(await fs.lstat(object).catch(() => null))) await fs.writeFile(object, bytes, { flag: 'wx' });
      const recorded = this.store.latestFile(state, document.path);
      files.push({
        path: document.path,
        sha,
        bytes: bytes.byteLength,
        revision: recorded?.file.after === sha ? recorded.entry.versionId : null,
      });
    }
    const manifest: BaseManifest = { v: 1, projectId, jobId, scope: draft.allowedOutputPaths, files };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    await fs.writeFile(path.join(dir, 'base.json'), manifestBytes);
    // A subset has its own digest. Capture it before the final full-scope check, so a later generation is never bound to earlier bytes.
    // If every path was pinned, retain the generation already checked around its bytes instead of reading it again unchecked.
    const sourceGeneration =
      files.length === scoped.length ? before : await this.sources.generation(projectId, files.map((file) => file.path));
    if ((await this.sources.generation(projectId, scoped)) !== before)
      throw new WorkspaceRefused(
        'workspace_source_changed',
        'Who may read the files in this scope changed while they were being pinned, so no workspace was made. Ask for it again.',
      );
    const baseManifestRef = sha256(manifestBytes);
    // The delta is bound to its project, job and base, so a database from another workspace is never taken for this one's.
    const handle = await this.sdk.open({ path: path.join(dir, draft.delta) });
    try {
      await handle.kv.set('nectovia:workspace', { projectId, jobId, baseManifestRef });
    } finally {
      await handle.close();
    }
    const open: WorkspaceLease = { ...draft, baseManifestRef, sourceGeneration, state: 'open' };
    await jsonWrite(path.join(dir, 'lease.json'), open);
    return open;
  }

  // --- the one writer ---------------------------------------------------------------

  private lockFile(lease: WorkspaceLease) {
    return path.join(this.dir(lease.projectId, lease.jobId), 'writer.lock');
  }
  /** Take the workspace's one writer. Returns the nonce that lets this writer, and only it, let go. */
  private async takeWriter(lease: WorkspaceLease): Promise<string> {
    const dir = this.dir(lease.projectId, lease.jobId);
    const busy = () => new WorkspaceRefused('workspace_writer_busy', 'This workspace already has a writer.');
    if (openWriters.has(dir)) throw busy();
    const nonce = randomBytes(8).toString('hex');
    // Held from before the lock file is made, with nothing awaited since the check above. A second writer opened
    // meanwhile in this process is refused there, so it never finds this lock written but not yet held, and never
    // takes it for one left behind.
    openWriters.set(dir, nonce);
    const lock = this.lockFile(lease);
    const body = JSON.stringify({ fence: lease.assignmentFence, delta: lease.delta, pid: process.pid, nonce, at: now() });
    const create = () =>
      fs.writeFile(lock, body, { flag: 'wx' }).catch((error: unknown) => {
        throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? busy() : error;
      });
    try {
      try {
        await create();
      } catch (error) {
        if (!(error instanceof WorkspaceRefused) || (await this.lockHeld(lease))) throw error;
        // A writer that ended without closing left its lock; its process is gone. Another taking it over first wins.
        await fs.rm(lock, { force: true });
        await create();
      }
    } catch (error) {
      // Whatever stopped this writer, it holds nothing now, so no later writer is refused for it.
      await this.releaseWriter(lease, nonce);
      throw error;
    }
    return nonce;
  }
  /** Whether a writer holds this workspace: one in this process, or a live one elsewhere whose lock is on disk. */
  private async writerAlive(lease: WorkspaceLease) {
    if (openWriters.has(this.dir(lease.projectId, lease.jobId))) return true;
    return this.lockHeld(lease);
  }
  /**
   * Whether the lock file names a live writer in another process. This process's own writers are the ones in
   * `openWriters`, so a lock it wrote that has no entry there was left behind.
   */
  private async lockHeld(lease: WorkspaceLease) {
    let held: { pid?: unknown };
    try {
      held = JSON.parse(await fs.readFile(this.lockFile(lease), 'utf8')) as { pid?: unknown };
    } catch (error) {
      if (absent(error)) return false;
      return true;
    }
    if (typeof held.pid !== 'number' || held.pid === process.pid) return false;
    try {
      process.kill(held.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  /** Let go of the writer holding `nonce`. A lock or entry with another nonce belongs to a later writer and stays. */
  private async releaseWriter(lease: WorkspaceLease, nonce: string) {
    const dir = this.dir(lease.projectId, lease.jobId);
    if (openWriters.get(dir) === nonce) openWriters.delete(dir);
    const held = await fs
      .readFile(this.lockFile(lease), 'utf8')
      .then((text) => JSON.parse(text) as { nonce?: unknown })
      .catch(() => null);
    if (held?.nonce === nonce) await fs.rm(this.lockFile(lease), { force: true });
  }

  /** Open the delta and check it belongs to this workspace's base. */
  private async delta(lease: WorkspaceLease): Promise<AgentFsHandle> {
    const file = path.join(this.dir(lease.projectId, lease.jobId), lease.delta);
    // Opening a missing database would make an empty one, so a missing delta is refused before it is opened.
    // An empty file is refused too: a pinned delta always holds its binding, and an empty file at a path
    // this process opened before is what Turso 0.4.4 leaves while it answers from its earlier database.
    const found = await fs.lstat(file).catch(() => null);
    if (!found?.isFile() || found.size === 0)
      throw new WorkspaceRefused('workspace_delta_mismatch', 'The changes in this workspace are missing.');
    const handle = await this.sdk.open({ path: file });
    // The SDK writes in chunks of the size a database stores, so a database that stores another size could write
    // far more than was reserved, or, with a size below one, never finish a write.
    if (handle.fs.getChunkSize() !== AGENTFS_CHUNK_SIZE) {
      await handle.close();
      throw new WorkspaceRefused('workspace_delta_settings', 'This workspace’s database was not made with the SDK’s own settings, so it was not opened.');
    }
    const bound = await handle.kv
      .get<{ projectId?: unknown; jobId?: unknown; baseManifestRef?: unknown }>('nectovia:workspace')
      .catch(() => undefined);
    if (bound?.projectId !== lease.projectId || bound?.jobId !== lease.jobId || bound?.baseManifestRef !== lease.baseManifestRef) {
      await handle.close();
      throw new WorkspaceRefused('workspace_delta_mismatch', 'The changes in this workspace were not made against its own base.');
    }
    return handle;
  }

  /** Refuse a copy of `bytes` into `folder` that would leave less than `headroom` free on its disk. */
  private async reserveCopy(folder: string, bytes: number, headroom: number, refusal: string) {
    const free = await this.freeBytes(await existingFolder(folder));
    if (free - bytes < headroom) throw new WorkspaceRefused('workspace_disk_full', refusal);
  }

  /** Bytes the workspace's database takes on disk now, its journal files included. */
  private async deltaDiskBytes(lease: WorkspaceLease) {
    const dir = this.dir(lease.projectId, lease.jobId);
    let total = 0;
    for (const name of await fs.readdir(dir))
      if (isDeltaFile(lease.delta, name)) total += (await fs.lstat(path.join(dir, name)).catch(() => null))?.size ?? 0;
    return total;
  }

  /** Every plain file in the delta, bounded. Links, folders past the depth limit and odd names are reported, never followed. */
  private async walkDelta(handle: AgentFsHandle, limits: WorkspaceLimits) {
    const files: { path: string; size: number }[] = [];
    const dropped: { path: string; reason: string }[] = [];
    let entries = 0;
    const visit = async (folder: string, depth: number) => {
      if (depth > DEPTH) {
        dropped.push({ path: folder.slice(1), reason: 'Folders this deep are never returned.' });
        return;
      }
      for (const name of await handle.fs.readdir(folder)) {
        if (++entries > MAX_ENTRIES)
          throw new WorkspaceRefused('workspace_too_large', `This workspace holds more than ${MAX_ENTRIES} files and folders.`);
        const spelled = folder === '/' ? `/${name}` : `${folder}/${name}`;
        const stat = await handle.fs.lstat(spelled);
        if (stat.isSymbolicLink()) dropped.push({ path: spelled.slice(1), reason: 'A link in the workspace is never returned.' });
        else if (stat.isDirectory()) await visit(spelled, depth + 1);
        else if (stat.isFile()) {
          files.push({ path: spelled.slice(1), size: stat.size });
          if (files.length > limits.maxFiles)
            throw new WorkspaceRefused('workspace_too_large', `This workspace holds more than ${limits.maxFiles} changed files.`);
        } else dropped.push({ path: spelled.slice(1), reason: 'Only a plain file can be returned.' });
      }
    };
    await visit('/', 0);
    return { files: files.sort((a, b) => byName(a.path, b.path)), dropped };
  }

  /**
   * Open the job's tools. The four tools match the copy sandbox's names and
   * answers. Writes go into this workspace's delta only, and only while its
   * fence holds; each reserves its whole cost before anything is written. A
   * spent workspace still opens to read, so the changes a hand-back left
   * waiting or in conflict can be reviewed.
   */
  async open(given: WorkspaceLease, options: { readable: (path: string) => boolean; write: boolean }): Promise<WorkspaceSession> {
    const lease = await this.current(given, options.write ? 'open' : 'readable');
    await this.assertFence(lease);
    const base = await this.base(lease);
    const nonce = options.write ? await this.takeWriter(lease) : null;
    let handle: AgentFsHandle;
    try {
      handle = await this.delta(lease);
    } catch (error) {
      if (nonce) await this.releaseWriter(lease, nonce);
      throw error;
    }
    const pinned = new Map(base.files.map((file) => [file.path, file]));
    const registry = this.registry(lease, handle, pinned, options);
    let closed = false;
    return {
      lease,
      tools: registry,
      close: async () => {
        if (closed) return;
        closed = true;
        await handle.close();
        if (nonce) await this.releaseWriter(lease, nonce);
      },
    };
  }

  private registry(
    lease: WorkspaceLease,
    handle: AgentFsHandle,
    pinned: Map<string, BaseFile>,
    options: { readable: (path: string) => boolean; write: boolean },
  ): ToolRegistry {
    const registry = new ToolRegistry();
    const scope = lease.allowedOutputPaths;
    const refusal = (error: unknown) =>
      error instanceof HarnessError || error instanceof ApiError ? error.message : 'That path cannot be used.';
    const resolve = (spelled: string) => {
      const relative = relativeName(spelled);
      if (!inScope(relative, scope)) throw new WorkspaceRefused('path_outside_scope', 'This file is outside the scope you were given.');
      return relative;
    };
    /** The delta's own copy of a path: its bytes, null when it holds none, or a refusal for anything but a plain file. */
    const own = async (relative: string): Promise<Buffer | null> => {
      let stat: AgentFsStats;
      try {
        stat = await handle.fs.lstat(toDelta(relative));
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
      if (!stat.isFile()) throw new WorkspaceRefused('path_link', 'Only a plain file can be read.');
      return handle.fs.readFile(toDelta(relative));
    };
    const read = {
      version: 'agentfs-workspace-v1',
      effect: 'read',
      effectClass: 'read',
      permission: null,
      approval: false,
      destination: 'local',
      trustedInputRequired: false,
      cost: 0,
    } as const;
    registry.register({
      ...read,
      name: 'list_project_files',
      description: 'List the files in your working copy of the scope you were given.',
      schema: z.strictObject({}),
      outputSchema: z.strictObject({ files: z.array(z.string()), note: z.string() }) as unknown as z.ZodType<Json>,
      execute: async () => {
        const written = (await this.walkDelta(handle, lease.limits)).files.map((file) => file.path);
        // As in the copy sandbox: a pinned file the route may not read stays hidden, even once the job wrote over it.
        const listed = new Set([...pinned.keys(), ...written].filter((name) => !pinned.has(name) || options.readable(name)));
        return {
          files: [...listed].sort(),
          note: 'This is your own working copy. Changes you make here come back to the loop that handed you this task as a change set.',
        };
      },
    });
    registry.register({
      ...read,
      name: 'read_project_file',
      description: 'Read one file from your working copy, by its path.',
      schema: z.strictObject({ path: z.string().trim().min(1).max(400) }),
      outputSchema: z.union([
        z.strictObject({ path: z.string(), refused: z.string() }),
        z.strictObject({ path: z.string(), found: z.literal(false) }),
        z.strictObject({ path: z.string(), found: z.literal(true), sha: z.string(), bytes: z.number().int(), text: z.string(), truncated: z.boolean() }),
      ]) as unknown as z.ZodType<Json>,
      execute: async ({ input }): Promise<Json> => {
        let relative: string;
        try {
          relative = resolve(input.path);
        } catch (error) {
          return { path: input.path, refused: refusal(error) };
        }
        if (pinned.has(relative) && !options.readable(relative))
          return { path: relative, refused: 'This file is not shared with the route this answer goes to, so it was not read.' };
        let bytes: Buffer | null;
        try {
          bytes = await own(relative);
        } catch (error) {
          return { path: relative, refused: refusal(error) };
        }
        if (bytes === null) {
          const file = pinned.get(relative);
          if (!file) return { path: relative, found: false };
          bytes = await this.pinned(lease, file);
          if (!bytes) return { path: relative, refused: 'The pinned copy of this file is missing or damaged, so it was not read.' };
        }
        const text = textOf(bytes);
        if (text === null) return { path: relative, refused: 'This file is not text.' };
        const max = 24_000;
        return {
          path: relative,
          found: true,
          sha: sha256(bytes),
          bytes: bytes.byteLength,
          text: text.length > max ? text.slice(0, max) : text,
          truncated: text.length > max,
        };
      },
    });
    if (!options.write) return registry;

    const writeOutput = z.union([
      z.strictObject({ path: z.string(), bytes: z.number().int().nonnegative(), proposed: z.boolean() }),
      z.strictObject({ path: z.string(), refused: z.string(), code: z.string() }),
    ]) as unknown as z.ZodType<Json>;
    const codeOf = (error: unknown) => (error instanceof HarnessError ? error.code : 'path_invalid');
    const target = (relative: string) => `workspace:${lease.jobId}/${relative}`;
    const maxText = Math.min(lease.limits.maxFileBytes, 4 * MB - 4096);
    /** Refuse a write that would take the delta past its budget or the disk past its headroom, before anything is written. */
    const reserve = async (relative: string, size: number) => {
      // A link or folder at the path is never written through: AgentFS 0.6.4 cannot read a link back.
      const there = await handle.fs.lstat(toDelta(relative)).catch((error: unknown) => {
        if (absent(error)) return null;
        throw error;
      });
      if (there && !there.isFile()) throw new WorkspaceRefused('path_not_file', 'Only a plain file can be written.');
      // The delta does not hold the pinned files, so it cannot see a clash with them; the project would.
      if (folderClash(relative, pinned))
        throw new WorkspaceRefused('path_not_folder', 'A file and a folder would have the same name here, so nothing was written.');
      if (size > lease.limits.maxFileBytes)
        throw new WorkspaceRefused('workspace_too_large', `This file would be ${megabytes(size)}; a workspace holds files of at most ${megabytes(lease.limits.maxFileBytes)}.`);
      const { files } = await this.walkDelta(handle, lease.limits);
      const already = files.find((file) => file.path === relative);
      const lower = relative.toLowerCase();
      const twin = [...pinned.keys(), ...files.map((file) => file.path)].find((name) => name !== relative && name.toLowerCase() === lower);
      if (twin) throw new WorkspaceRefused('path_case_twin', `${twin} is already in your copy with different capitals. Write to ${twin} instead.`);
      if (!already && files.length + 1 > lease.limits.maxFiles)
        throw new WorkspaceRefused('workspace_full', `Your copy already holds ${files.length} changed files, as many as a sub-task may.`);
      // A change to a pinned file is a whole-file copy, however few bytes changed.
      const cost = Math.max(size, already ? 0 : (pinned.get(relative)?.bytes ?? 0));
      const used = files.reduce((sum, file) => sum + (file.path === relative ? 0 : file.size), 0);
      if (used + cost > lease.limits.maxDeltaBytes)
        throw new WorkspaceRefused(
          'workspace_budget',
          `Writing ${relative} costs ${megabytes(cost)} in this workspace, because a change rewrites the whole file, and it has ${megabytes(Math.max(0, lease.limits.maxDeltaBytes - used))} left.`,
        );
      // The engine's journal grows with every write, so the database is measured on disk, not by its files' sizes.
      const onDisk = await this.deltaDiskBytes(lease);
      if (onDisk + cost > lease.limits.maxDeltaDiskBytes)
        throw new WorkspaceRefused(
          'workspace_budget',
          `This workspace’s database already takes ${megabytes(onDisk)} on disk, and writing ${relative} would take it past the ${megabytes(lease.limits.maxDeltaDiskBytes)} it may use, so nothing was written.`,
        );
      const free = await this.freeBytes(this.dir(lease.projectId, lease.jobId));
      if (free - cost < lease.limits.diskHeadroomBytes)
        throw new WorkspaceRefused('workspace_disk_full', `Writing ${relative} would leave too little free disk space, so nothing was written.`);
    };
    const writer = (name: 'write_file' | 'propose_file', description: string, proposed: boolean) =>
      registry.register({
        name,
        version: 'agentfs-workspace-v1',
        description,
        effect: 'idempotent',
        effectClass: 'idempotent-write',
        permission: 'write-project-file',
        // The workspace is the job's own: writing it touches nothing of the project, so it asks no one.
        approval: false,
        destination: 'local',
        trustedInputRequired: false,
        cost: 1,
        limits: { maxInputBytes: maxText + 4096, maxOutputBytes: 4096, timeoutMs: 30_000 },
        schema: z.strictObject({ path: z.string().min(1).max(400), text: z.string().max(maxText) }),
        outputSchema: writeOutput,
        // Named as the workspace's, so the effect record never reads as a project write.
        targets: (input) => {
          try {
            return [target(resolve(input.path))];
          } catch {
            return [];
          }
        },
        reconcile: async ({ input }) => {
          const { path: spelled, text } = input as { path: string; text: string };
          try {
            const bytes = await own(resolve(spelled));
            return bytes !== null && sha256(bytes) === sha256(text) ? 'applied' : 'unknown';
          } catch {
            return 'unknown';
          }
        },
        execute: async ({ input, targets, signal }): Promise<Json> => {
          signal.throwIfAborted();
          let relative: string;
          try {
            relative = resolve(input.path);
          } catch (error) {
            return { path: input.path, refused: refusal(error), code: codeOf(error) };
          }
          if (!targets?.includes(target(relative)))
            return { path: relative, refused: 'This write did not declare that file as its target.', code: 'path_not_declared' };
          try {
            const fresh = await this.current(lease);
            await this.assertFence(fresh);
            await reserve(relative, Buffer.byteLength(input.text, 'utf8'));
          } catch (error) {
            if (!(error instanceof HarnessError)) throw error;
            return { path: relative, refused: error.message, code: error.code };
          }
          try {
            await handle.fs.writeFile(toDelta(relative), Buffer.from(input.text, 'utf8'));
          } catch (error) {
            const code = (error as { code?: unknown })?.code;
            if (code !== 'ENOTDIR' && code !== 'EISDIR') throw error;
            return { path: relative, refused: 'A folder on this path is a file in your copy.', code: 'path_not_folder' };
          }
          if (proposed) await handle.kv.set(`nectovia:proposed:${relative}`, true);
          return { path: relative, bytes: Buffer.byteLength(input.text, 'utf8'), proposed };
        },
      });
    writer(
      'write_file',
      'Write the whole text of one file in your working copy, by its path. Nothing in the project changes: the loop that handed you this task decides what to apply.',
      false,
    );
    writer(
      'propose_file',
      'Propose the whole text of one file for a person to decide. It is written in your working copy and always shown to a person before anything in the project changes.',
      true,
    );
    return registry;
  }

  // --- handing back -----------------------------------------------------------------

  /** What changed against the base, measured from the delta now. */
  private async collect(lease: WorkspaceLease, handle: AgentFsHandle): Promise<WorkspaceOutputs> {
    const base = await this.base(lease);
    const pinned = new Map(base.files.map((file) => [file.path, file]));
    const walked = await this.walkDelta(handle, lease.limits);
    const dropped = [...walked.dropped];
    const entries: WorkspaceOutput[] = [];
    for (const file of walked.files) {
      let relative: string;
      try {
        relative = relativeName(file.path);
      } catch {
        dropped.push({ path: file.path, reason: 'This name cannot be used in a project.' });
        continue;
      }
      // A name the guard spells differently (a backslash inside one name) is not the file that was walked.
      if (relative !== file.path) {
        dropped.push({ path: file.path, reason: 'This name cannot be used in a project.' });
        continue;
      }
      if (!inScope(relative, lease.allowedOutputPaths)) {
        dropped.push({ path: relative, reason: 'Outside the scope this sub-task was given.' });
        continue;
      }
      if (folderClash(relative, pinned)) {
        dropped.push({ path: relative, reason: 'A file and a folder would have the same name in the project.' });
        continue;
      }
      if (file.size > lease.limits.maxFileBytes) {
        dropped.push({ path: relative, reason: 'Larger than a workspace file may be.' });
        continue;
      }
      const bytes = await handle.fs.readFile(toDelta(relative));
      const sha = sha256(bytes);
      const before = pinned.get(relative) ?? null;
      if (before?.sha === sha) continue;
      if (textOf(bytes) === null) {
        dropped.push({ path: relative, reason: 'Not text, so it cannot be returned as a change.' });
        continue;
      }
      entries.push({
        path: relative,
        op: before ? 'modified' : 'created',
        before: before?.sha ?? null,
        after: sha,
        bytes: bytes.byteLength,
        proposed: (await handle.kv.get(`nectovia:proposed:${relative}`)) === true,
      });
    }
    return {
      v: 1,
      jobId: lease.jobId,
      assignmentFence: lease.assignmentFence,
      baseManifestRef: lease.baseManifestRef,
      entries: entries.sort((a, b) => byName(a.path, b.path)),
      dropped: dropped.sort((a, b) => byName(a.path, b.path)),
    };
  }

  /** List what the job changed, record it beside the workspace and return its digest. */
  async proposeOutputs(given: WorkspaceLease): Promise<{ manifestRef: string; digest: string; outputs: WorkspaceOutputs }> {
    const lease = await this.current(given);
    await this.assertFence(lease);
    const handle = await this.delta(lease);
    let outputs: WorkspaceOutputs;
    try {
      outputs = await this.collect(lease, handle);
    } finally {
      await handle.close();
    }
    await jsonWrite(path.join(this.dir(lease.projectId, lease.jobId), 'outputs.json'), outputs);
    return { manifestRef: 'outputs.json', digest: sha256(canonical(outputs)), outputs };
  }

  /**
   * Write the job's changes into the project. Every check runs before the first
   * write: the workspace is open and unspent, its fence holds, its writer is
   * closed, its base is intact, its changes still match the proposed digest and
   * its sources have not changed. Each change then lands through the recorded
   * writer, base-checked; each write is read back before it counts as applied.
   */
  async promote(given: WorkspaceLease, request: PromoteRequest): Promise<PromoteResult> {
    return this.exclusive(async () => {
      const lease = await this.current(given);
      await this.assertFence(lease);
      if (await this.writerAlive(lease))
        throw new WorkspaceRefused('workspace_writer_open', 'Close this workspace’s tools before handing back its changes.');
      const handle = await this.delta(lease);
      let outputs: WorkspaceOutputs;
      const texts = new Map<string, string>();
      try {
        outputs = await this.collect(lease, handle);
        if (sha256(canonical(outputs)) !== request.digest)
          throw new WorkspaceRefused('workspace_outputs_changed', 'This workspace changed after its changes were listed, so nothing was handed back.');
        for (const entry of outputs.entries) {
          const bytes = await handle.fs.readFile(toDelta(entry.path));
          if (sha256(bytes) !== entry.after)
            throw new WorkspaceRefused('workspace_outputs_changed', 'This workspace changed while its changes were read, so nothing was handed back.');
          texts.set(entry.path, textOf(bytes)!);
        }
      } finally {
        await handle.close();
      }
      const base = await this.base(lease);
      const generation = await this.sources.generation(lease.projectId, base.files.map((file) => file.path));
      if (generation !== lease.sourceGeneration)
        throw new WorkspaceRefused(
          'workspace_source_changed',
          'Who may read the files this job was given changed after it started, so its changes were not handed back.',
        );

      const applied: { path: string; sha: string; entryId: string | null; replayed: boolean }[] = [];
      const conflicts: { path: string; currentSha: string | null; before: string | null; after: string }[] = [];
      const waiting: { path: string; reason: string; before: string | null; after: string }[] = [];
      for (const entry of outputs.entries) {
        const reason = entry.proposed
          ? 'the sub-task asked for a person to decide it'
          : !request.canWrite
            ? 'this loop may not write project files'
            : request.applyScope === null
              ? 'this loop was not given a scope it may apply changes in'
              : !inScope(entry.path, request.applyScope)
                ? `it is outside what this loop may apply (${request.applyScope.join(', ')})`
                : null;
        if (reason) {
          waiting.push({ path: entry.path, reason, before: entry.before, after: entry.after });
          continue;
        }
        // The Store's lock keeps this process's reassignments out, but another process can still move the fence
        // on disk, so it is read again before each write. Writes made before it moved stay, each in History.
        await this.assertFence(lease);
        try {
          const written = await this.store.writeRecorded(
            lease.projectId,
            [{ path: entry.path, text: texts.get(entry.path)!, expected: entry.before }],
            {
              actor: 'diomedes',
              kind: 'workspace-change',
              sessionId: request.sessionId,
              taskId: request.taskId,
              origin: request.origin,
              merge: false,
              sentence: `Diomedes applied a sub-task's change to ${entry.path} from its workspace, inside the scope you gave this loop`,
            },
          );
          // The receipt: the History entry names these bytes, and the project holds them.
          const recorded = written.files.find((file) => file.path === entry.path);
          const landed = bytesHash(await this.store.currentBytes(lease.projectId, entry.path));
          if (recorded?.after !== entry.after || landed !== entry.after)
            throw new HarnessError('workspace_receipt_mismatch', `The write of ${entry.path} did not record the bytes it was given.`, true);
          applied.push({ path: entry.path, sha: entry.after, entryId: written.id, replayed: false });
        } catch (error) {
          // A failure in the write itself may leave the Store's state behind its files, so the Store recovers from it.
          if (!(error instanceof ApiError)) throw error instanceof HarnessError ? error : new StoreFailure(error);
          const currentSha = (error.details as { currentSha?: string | null } | undefined)?.currentSha ?? null;
          if (error.status === 409 && currentSha === entry.after) {
            // The write landed before the workspace was marked spent: the bytes say so.
            const latest = this.store.latestFile(this.store.state(lease.projectId), entry.path);
            applied.push({ path: entry.path, sha: entry.after, entryId: latest?.file.after === entry.after ? latest.entry.id : null, replayed: true });
          } else if (error.status === 409) conflicts.push({ path: entry.path, currentSha, before: entry.before, after: entry.after });
          // As in change sets: a write the Store refuses for its content (not text, markup) waits for a person.
          else waiting.push({ path: entry.path, reason: error.message, before: entry.before, after: entry.after });
        }
      }
      await jsonWrite(path.join(this.dir(lease.projectId, lease.jobId), 'lease.json'), {
        ...lease,
        state: 'promoted',
        promotedAt: now(),
      } satisfies WorkspaceLease);
      return { applied, conflicts, waiting, dropped: outputs.dropped };
    });
  }

  /** AgentFS's own tool log, read as observations only: no arguments, results or errors, and never a receipt. */
  async observations(given: WorkspaceLease): Promise<{ observations: WorkspaceObservation[]; unreadable: string | null }> {
    const lease = await this.current(given, 'any');
    const handle = await this.delta(lease);
    try {
      const calls = await handle.tools.getRecent(0, 500);
      const at = (seconds: unknown) =>
        typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds < 1e11 ? new Date(seconds * 1000).toISOString() : null;
      return {
        observations: calls.map((call) => ({
          source: 'agentfs-tool-log',
          trust: 'observation',
          name: String(call.name).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120),
          status: call.status === 'pending' || call.status === 'success' || call.status === 'error' ? call.status : 'unknown',
          startedAt: at(call.started_at),
          completedAt: at(call.completed_at),
        })),
        unreadable: null,
      };
    } catch {
      return { observations: [], unreadable: 'The workspace’s tool log could not be read.' };
    } finally {
      await handle.close();
    }
  }

  // --- checkpoints ------------------------------------------------------------------

  /**
   * Copy a quiet workspace somewhere another host can open it: the delta, the
   * complete base manifest and every pinned file. The delta alone is not a
   * workspace, because it holds only what the job wrote.
   */
  async exportCheckpoint(given: WorkspaceLease, destination: string) {
    const lease = await this.current(given);
    // A checkpoint carries its fence to a host that may have no record of this job, so a stale owner may not make one.
    await this.assertFence(lease);
    if (await this.writerAlive(lease))
      throw new WorkspaceRefused('workspace_writer_open', 'Close this workspace’s tools before copying it.');
    const base = await this.base(lease);
    // A checkpoint is a copy to carry elsewhere. Inside app data or a project, its files would sit among the ones
    // the Store and the projects keep, so it goes only to a folder of its own. Project folders are read from the
    // registry as they are, without the listing that refreshes their counts.
    const target = await realFolder(destination);
    const kept = [this.dataDir, this.store.dataDir, ...this.store.projectIds().map((id) => this.store.state(id).project.folder)];
    for (const folder of kept)
      if (isContained(await realFolder(folder), target))
        throw new WorkspaceRefused('checkpoint_destination_refused', 'A checkpoint is never copied into app data or into a project’s folder.');
    const existed = (await fs.lstat(destination).catch(() => null)) !== null;
    if ((await fs.readdir(destination).catch(() => [])).length)
      throw new WorkspaceRefused('checkpoint_destination_used', 'A checkpoint is copied only into an empty folder.');
    const dir = this.dir(lease.projectId, lease.jobId);
    const handle = await this.delta(lease);
    let entries: { path: string; sha: string }[];
    try {
      const walked = await this.walkDelta(handle, lease.limits);
      entries = [];
      for (const file of walked.files) entries.push({ path: file.path, sha: sha256(await handle.fs.readFile(toDelta(file.path))) });
    } finally {
      await handle.close();
    }
    const needed = base.files.reduce((sum, file) => sum + file.bytes, 0) + (await this.deltaDiskBytes(lease));
    await this.reserveCopy(
      destination,
      needed,
      lease.limits.diskHeadroomBytes,
      `This checkpoint needs ${megabytes(needed)} of disk space, and that would leave too little free, so nothing was copied.`,
    );
    try {
      await fs.mkdir(path.join(destination, 'base'), { recursive: true });
      await fs.mkdir(path.join(destination, 'delta'), { recursive: true });
      await fs.copyFile(path.join(dir, 'base.json'), path.join(destination, 'base.json'));
      let baseBytes = 0;
      for (const file of base.files) {
        const bytes = await this.pinned(lease, file);
        if (!bytes) throw new WorkspaceRefused('workspace_base_changed', `The pinned copy of ${file.path} is missing or damaged, so no checkpoint was made.`);
        await fs.writeFile(path.join(destination, 'base', file.sha), bytes);
        baseBytes += bytes.byteLength;
      }
      const deltaFiles: { name: string; sha: string; bytes: number }[] = [];
      for (const name of (await fs.readdir(dir)).filter((item) => isDeltaFile(lease.delta, item)).sort()) {
        const bytes = await fs.readFile(path.join(dir, name));
        await fs.writeFile(path.join(destination, 'delta', name), bytes);
        deltaFiles.push({ name, sha: sha256(bytes), bytes: bytes.byteLength });
      }
      // Written last: a folder without it is not a checkpoint.
      await jsonWrite(path.join(destination, 'checkpoint.json'), { v: 1, lease, delta: { files: deltaFiles, entries }, createdAt: now() });
      return { baseBytes, deltaBytes: deltaFiles.reduce((sum, file) => sum + file.bytes, 0), entries: entries.length };
    } catch (error) {
      // A copy that failed leaves nothing of itself: what it wrote goes, and so does a folder it made.
      if (existed) for (const name of await fs.readdir(destination).catch(() => [])) await fs.rm(path.join(destination, name), { recursive: true, force: true });
      else await fs.rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Open a checkpoint on this host as the job a caller names. Refused unless it
   * is that job's and is complete: its lease names this project and job, its
   * base manifest matches its reference and names the same job and scope, every
   * pinned file is there with its size and sha, the delta files match, and the
   * delta holds exactly the files it listed. A checkpoint carries the limits it
   * was made under, and they are not trusted here: this host's apply, and a
   * checkpoint larger than they allow is refused before anything is copied.
   */
  async importCheckpoint(source: string, job: { readonly projectId: string; readonly jobId: string; readonly owner: string }): Promise<WorkspaceLease> {
    let parsed: z.infer<typeof checkpointSchema>;
    try {
      parsed = checkpointSchema.parse(JSON.parse(await fs.readFile(path.join(source, 'checkpoint.json'), 'utf8')));
    } catch {
      throw new WorkspaceRefused('checkpoint_incomplete', 'This folder is not a complete workspace checkpoint.');
    }
    const lease = parsed.lease as WorkspaceLease;
    if (lease.projectId !== job.projectId || lease.jobId !== job.jobId)
      throw new WorkspaceRefused('checkpoint_other_job', 'This checkpoint holds another job’s workspace, so it was not opened as this one.');
    if (lease.state !== 'open') throw new WorkspaceRefused('workspace_spent', 'This checkpoint’s workspace already handed back its changes.');
    // The fence becomes this host's record of who owns the job, so it must name this job and a generation.
    const generation = fenceGeneration(lease.assignmentFence, lease.jobId);
    if (generation === null)
      throw new WorkspaceRefused('checkpoint_incomplete', 'This checkpoint does not name its job’s owner in a form this host reads.');
    if (lease.sdk.version !== this.sdk.version || lease.sdk.engineVersion !== this.sdk.engineVersion)
      throw new WorkspaceRefused('checkpoint_other_sdk', 'This checkpoint was made with another AgentFS build than this host runs, so it was not opened.');
    const manifestBytes = await fs.readFile(path.join(source, 'base.json')).catch(() => null);
    if (!manifestBytes || sha256(manifestBytes) !== lease.baseManifestRef)
      throw new WorkspaceRefused(
        'checkpoint_incomplete',
        'This checkpoint holds the changes without the list of files they were made against, so it cannot be opened as a workspace.',
      );
    let base: BaseManifest;
    try {
      base = baseManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8'))) as BaseManifest;
    } catch {
      throw new WorkspaceRefused('checkpoint_incomplete', 'This checkpoint’s list of files cannot be read.');
    }
    if (base.projectId !== lease.projectId || base.jobId !== lease.jobId || canonical(base.scope) !== canonical(lease.allowedOutputPaths))
      throw new WorkspaceRefused('checkpoint_incomplete', 'This checkpoint’s list of files was made for another workspace, so it cannot be opened as this one.');
    const limits = WORKSPACE_LIMITS;
    if (
      base.files.length > limits.maxFiles ||
      base.files.reduce((sum, file) => sum + file.bytes, 0) > limits.maxBaseBytes ||
      base.files.some((file) => file.bytes > limits.maxFileBytes) ||
      parsed.delta.entries.length > limits.maxFiles ||
      parsed.delta.files.reduce((sum, file) => sum + file.bytes, 0) > limits.maxDeltaDiskBytes
    )
      throw new WorkspaceRefused('workspace_too_large', 'This checkpoint is larger than a workspace on this host may be, so it was not opened.');
    // Names come from the checkpoint, so each must be its lease's delta or one of that delta's journal files before it is used in a path.
    if (!parsed.delta.files.some((file) => file.name === lease.delta))
      throw new WorkspaceRefused('checkpoint_incomplete', 'This checkpoint’s changes are missing or damaged.');
    let incoming = manifestBytes.byteLength;
    for (const file of parsed.delta.files) {
      if (!isDeltaFile(lease.delta, file.name) || !(await verifiedCopy(path.join(source, 'delta', file.name), file.sha, file.bytes)))
        throw new WorkspaceRefused('checkpoint_incomplete', 'This checkpoint’s changes are missing or damaged.');
      incoming += file.bytes;
    }
    const missing: string[] = [];
    for (const file of base.files) {
      if (!(await verifiedCopy(path.join(source, 'base', file.sha), file.sha, file.bytes))) missing.push(file.path);
      else incoming += file.bytes;
    }
    if (missing.length)
      throw new WorkspaceRefused(
        'checkpoint_incomplete',
        `This checkpoint holds the changes but not ${missing.length} of the files they were made against (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' and more' : ''}), so it cannot be opened as a workspace.`,
      );
    // Who may read these files is this host's to say. A job is not given files here under grants this host never made.
    if ((await this.sources.generation(lease.projectId, base.files.map((file) => file.path))) !== lease.sourceGeneration)
      throw new WorkspaceRefused(
        'workspace_source_changed',
        'Who may read the files this job was given is not the same on this host, so its checkpoint was not opened.',
      );
    const ownedElsewhere = (assignment: Assignment | null) =>
      assignment !== null && (fenceOf(assignment) !== lease.assignmentFence || assignment.owner !== job.owner);
    const stale = () => new WorkspaceRefused('workspace_stale_assignment', 'This job has a different owner on this host, so its checkpoint was not opened.');
    const used = () => new WorkspaceRefused('checkpoint_destination_used', 'This host already has a workspace for this job.');
    if (ownedElsewhere(await this.assignment(lease.projectId, lease.jobId))) throw stale();
    if (await this.read(lease.projectId, lease.jobId)) throw used();
    const dir = this.dir(lease.projectId, lease.jobId);
    // Two imports for one job would copy into the same folder, and the one that failed would overwrite or remove
    // what the other made. While one is under way in this process, another is refused.
    if (importing.has(dir)) throw new WorkspaceRefused('checkpoint_destination_used', 'This host is already opening a checkpoint for this job.');
    importing.add(dir);
    try {
      await this.reserveCopy(
        dir,
        incoming,
        limits.diskHeadroomBytes,
        `This checkpoint needs ${megabytes(incoming)} of disk space on this host, and that would leave too little free, so it was not opened.`,
      );
      // A new name on this host: this process may already have opened a database at the checkpoint's own name.
      const here: WorkspaceLease = { ...lease, workspaceRef: `workspace:${lease.projectId}/${lease.jobId}`, delta: newDeltaName(), limits };
      try {
        await fs.mkdir(path.join(dir, 'base'), { recursive: true });
        await fs.writeFile(path.join(dir, 'base.json'), manifestBytes);
        // Each file is read and checked again as it is copied, so what lands is what was checked.
        const copy = async (from: string, to: string, sha: string, bytes: number) => {
          const checked = await verifiedCopy(from, sha, bytes);
          if (!checked) throw new WorkspaceRefused('checkpoint_incomplete', 'This checkpoint changed while it was being opened.');
          await fs.writeFile(to, checked);
        };
        for (const file of base.files) await copy(path.join(source, 'base', file.sha), path.join(dir, 'base', file.sha), file.sha, file.bytes);
        // Each journal file keeps its database's name. On Turso 0.4.4 a closed database keeps its rows in its
        // -wal file, and the database file without it opens empty, with no error.
        for (const file of parsed.delta.files)
          await copy(path.join(source, 'delta', file.name), path.join(dir, `${here.delta}${file.name.slice(lease.delta.length)}`), file.sha, file.bytes);
        const handle = await this.delta(here).catch((error: unknown) => {
          if (error instanceof WorkspaceRefused && error.code === 'workspace_delta_mismatch')
            throw new WorkspaceRefused('checkpoint_incomplete', 'This checkpoint’s database does not hold the changes it lists.');
          throw error;
        });
        try {
          const walked = await this.walkDelta(handle, here.limits);
          const found: { path: string; sha: string }[] = [];
          for (const file of walked.files) found.push({ path: file.path, sha: sha256(await handle.fs.readFile(toDelta(file.path))) });
          if (canonical(found) !== canonical(parsed.delta.entries))
            throw new WorkspaceRefused('checkpoint_incomplete', 'This checkpoint’s database does not hold the changes it lists.');
        } finally {
          await handle.close();
        }
        // The owner and the workspace are made together, under the lock that reassigning takes, and checked again there.
        await this.exclusive(async () => {
          const assignment = await this.assignment(lease.projectId, lease.jobId);
          if (ownedElsewhere(assignment)) throw stale();
          if (await this.read(lease.projectId, lease.jobId)) throw used();
          const file = this.assignmentFile(lease.projectId, lease.jobId);
          if (!assignment) await jsonWrite(file, { v: 1, jobId: lease.jobId, generation, owner: job.owner, at: now() } satisfies Assignment);
          try {
            await jsonWrite(path.join(dir, 'lease.json'), here);
          } catch (error) {
            // An owner made for a workspace that was never made would refuse the job's next owner, so it goes too.
            if (!assignment) await fs.rm(file, { force: true });
            throw error;
          }
        });
        return here;
      } catch (error) {
        // What this call copied goes. A workspace another call made here meanwhile is that call's, and it stays.
        if (!(await this.read(lease.projectId, lease.jobId).catch(() => null))) await fs.rm(dir, { recursive: true, force: true });
        throw error;
      }
    } finally {
      importing.delete(dir);
    }
  }

  /**
   * Remove the workspace a lease names: its delta, its pinned files and its
   * lease. The job's assignment stays. A lease for a workspace made again since
   * removes nothing, so a late caller never throws away its successor's work.
   */
  async dispose(given: WorkspaceLease) {
    const dir = this.dir(given.projectId, given.jobId);
    const named = async () => {
      const found = await this.read(given.projectId, given.jobId);
      if (found && !AgentFsWorkspaces.same(found, given))
        throw new WorkspaceRefused('workspace_replaced', 'This job’s workspace was made again since this lease was given, so nothing was removed.');
      return found !== null;
    };
    // Checked before the lock, so a stale lease is refused without waiting, and again under it, where the removal runs.
    if (!(await named())) return;
    await this.exclusive(async () => {
      if (!(await named())) return;
      openWriters.delete(dir);
      await fs.rm(dir, { recursive: true, force: true });
    });
  }
}
