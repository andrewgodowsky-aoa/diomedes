/**
 * Delegate and worker sandboxes (H13 slice 2, H14; decision of 2026-09-24).
 *
 * A sandbox is an isolated working copy of the scope a child was handed, kept
 * in its parent run's own area: `<data>/projects/<id>/harness/sandboxes/<child
 * run id>/`. It holds three things:
 *
 * - `manifest.json`, written before the copy (`creating`) and again once the
 *   copy is whole (`open`): who the child is, its parent and root, its depth,
 *   its scope, and the snapshot of every file copied with its sha. A change set
 *   is measured against that snapshot, so it is written once and never again.
 * - `work/`, the copy itself. Every read, write and spawn a child makes goes
 *   through H12's containment funnel (`containedPath`, `containedWrite`,
 *   `containedSpawn`) rooted at this folder, never at the project.
 * - `proposed.json`, the paths the child asked a person to decide
 *   (`propose_file`).
 *
 * The copy is made from the project through the same guarded reads the Files
 * pane uses (links, junctions, private names and 8.3 aliases refused), or, for
 * a delegate's own delegate, from its parent's copy. It is bounded: a scope
 * over `SANDBOX_LIMITS` is refused whole, with the numbers. Everything is on
 * disk, so a restart finds the sandbox where its child left it; creation is
 * idempotent by child id, and a copy interrupted before it was whole is taken
 * again. When the child's change set is recorded the copy is removed; what is
 * left of a tree is removed when its root run ends (`sweep`).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Json } from '../../shared/harness.js';
import {
  SANDBOX_LIMITS,
  inScope,
  type ChangeSetOp,
  type SandboxBase,
  type SandboxFile,
  type SandboxManifest,
} from '../../shared/sandbox.js';
import { ApiError, relativeName } from '../paths.js';
import type { Store } from '../store.js';
import { containedPath, containedSpawn, containedWrite, type SpawnLimits } from '../harness/containment.js';
import { validateRunId } from '../harness/run-store.js';
import { HarnessError, digest } from '../harness/policy.js';
import { ToolRegistry } from '../harness/tools.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const TEMP = /^\.diomedes-[a-f0-9]{16}\.tmp$/;
const WRITE_TOOLS = ['write_file', 'propose_file'] as const;
export const SANDBOX_READ_TOOLS = ['list_project_files', 'read_project_file'] as const;
export const SANDBOX_TOOLS = [...SANDBOX_READ_TOOLS, ...WRITE_TOOLS] as const;

/** Decode exact bytes as UTF-8 text, or null when they are not text. */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export class SandboxRefused extends HarnessError {
  constructor(message: string) {
    super('sandbox_refused', message);
  }
}

/** A file the child left in its copy, measured against the snapshot. */
export interface CollectedEntry {
  readonly path: string;
  readonly op: ChangeSetOp;
  readonly before: string | null;
  readonly after: string | null;
  readonly bytes: number;
  readonly proposed: boolean;
  /** The child's text, null for a deletion. */
  readonly text: string | null;
}

export interface CreateSpec {
  readonly projectId: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly rootRunId: string;
  readonly depth: number;
  readonly role: 'delegate' | 'worker';
  readonly base: SandboxBase;
  readonly scope: readonly string[] | null;
}

async function atomicJson(target: string, value: unknown) {
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, target);
}

/** Every plain file under a folder, by relative name; links and junctions are reported, never followed. */
async function walk(root: string): Promise<{ files: string[]; links: string[] }> {
  const files: string[] = [];
  const links: string[] = [];
  const visit = async (folder: string, prefix: string) => {
    const own = await fs.lstat(folder).catch(() => null);
    if (!own || own.isSymbolicLink() || !own.isDirectory()) return;
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isSymbolicLink()) links.push(relative);
      else if (item.isDirectory()) await visit(path.join(folder, item.name), relative);
      else if (item.isFile() && !TEMP.test(item.name)) files.push(relative);
    }
  };
  await visit(root, '');
  return { files: files.sort(), links: links.sort() };
}

const tooLarge = (count: number, bytes: number) =>
  new SandboxRefused(
    `This scope holds ${count} ${count === 1 ? 'file' : 'files'} (${(bytes / (1024 * 1024)).toFixed(1)} MB); a sub-task's copy holds at most ${SANDBOX_LIMITS.maxFiles} files and ${SANDBOX_LIMITS.maxBytes / (1024 * 1024)} MB. Name fewer files for it.`,
  );

export class SandboxStore {
  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
  ) {}

  private root(projectId: string) {
    this.store.state(projectId);
    return path.join(this.dataDir, 'projects', projectId, 'harness', 'sandboxes');
  }
  dir(projectId: string, runId: string) {
    return path.join(this.root(projectId), validateRunId(runId));
  }
  /** The copy a child works in: the root every contained path, write and spawn is judged against. */
  work(projectId: string, runId: string) {
    return path.join(this.dir(projectId, runId), 'work');
  }

  async read(projectId: string, runId: string): Promise<SandboxManifest | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir(projectId, runId), 'manifest.json'), 'utf8')) as SandboxManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(projectId: string): Promise<SandboxManifest[]> {
    const names = await fs.readdir(this.root(projectId)).catch(() => [] as string[]);
    const found: SandboxManifest[] = [];
    for (const name of names) {
      try {
        const manifest = await this.read(projectId, name);
        if (manifest) found.push(manifest);
      } catch {
        // An unreadable manifest is left where it is; sweep removes it with its tree.
      }
    }
    return found;
  }

  /** The files the base holds inside a scope, with their exact bytes, bounded. */
  private async source(projectId: string, base: SandboxBase, scope: readonly string[] | null) {
    let names: string[];
    let read: (name: string) => Promise<Buffer | null>;
    if (base.kind === 'project') {
      const documents = (await this.store.listDocuments(projectId)).filter((document) => inScope(document.path, scope));
      const total = documents.reduce((sum, document) => sum + document.size, 0);
      if (documents.length > SANDBOX_LIMITS.maxFiles || total > SANDBOX_LIMITS.maxBytes) throw tooLarge(documents.length, total);
      names = documents.map((document) => document.path);
      read = (name) => this.store.currentBytes(projectId, name);
    } else {
      const parent = this.work(projectId, base.runId);
      names = (await walk(parent)).files.filter((name) => inScope(name, scope));
      if (names.length > SANDBOX_LIMITS.maxFiles) throw tooLarge(names.length, 0);
      read = async (name) => {
        const found = await containedPath(parent, name, { write: false });
        const stat = await fs.lstat(found.absolute).catch(() => null);
        return stat?.isFile() ? fs.readFile(found.absolute) : null;
      };
    }
    const files: { path: string; bytes: Buffer }[] = [];
    let total = 0;
    for (const name of names) {
      let bytes: Buffer | null;
      try {
        bytes = await read(name);
      } catch {
        // The path guard refused it (a link, a private name): it is not copied, so the child never sees it.
        continue;
      }
      if (!bytes) continue;
      if (bytes.byteLength > SANDBOX_LIMITS.maxFileBytes)
        throw new SandboxRefused(
          `${name} is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB; a sub-task's copy holds files of at most ${SANDBOX_LIMITS.maxFileBytes / (1024 * 1024)} MB. Leave it out of the sub-task's scope.`,
        );
      total += bytes.byteLength;
      if (total > SANDBOX_LIMITS.maxBytes) throw tooLarge(names.length, total);
      files.push({ path: name, bytes });
    }
    return files;
  }

  /**
   * Make the child's copy, or return the one already made. Idempotent by child
   * id: an open sandbox is never copied again, because its snapshot is what the
   * change set is measured against; one interrupted while `creating` is taken again.
   */
  async create(spec: CreateSpec): Promise<SandboxManifest> {
    const dir = this.dir(spec.projectId, spec.runId);
    const existing = await this.read(spec.projectId, spec.runId);
    if (existing && existing.state !== 'creating') return existing;
    const work = path.join(dir, 'work');
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(work, { recursive: true });
    const manifest: SandboxManifest = {
      v: 1,
      projectId: spec.projectId,
      runId: spec.runId,
      parentRunId: spec.parentRunId,
      rootRunId: spec.rootRunId,
      depth: spec.depth,
      role: spec.role,
      base: spec.base,
      scope: spec.scope === null ? null : [...spec.scope],
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      state: 'creating',
      files: [],
    };
    await atomicJson(path.join(dir, 'manifest.json'), manifest);
    const files = await this.source(spec.projectId, spec.base, spec.scope);
    const snapshot: SandboxFile[] = [];
    for (const file of files) {
      const target = path.join(work, ...file.path.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.bytes, { flag: 'wx' });
      snapshot.push({ path: file.path, sha: sha256(file.bytes), bytes: file.bytes.byteLength });
    }
    const open: SandboxManifest = { ...manifest, state: 'open', files: snapshot };
    await atomicJson(path.join(dir, 'manifest.json'), open);
    return open;
  }

  private async proposed(projectId: string, runId: string): Promise<string[]> {
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.dir(projectId, runId), 'proposed.json'), 'utf8'));
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }
  private async propose(projectId: string, runId: string, relative: string) {
    const list = await this.proposed(projectId, runId);
    if (!list.includes(relative)) await atomicJson(path.join(this.dir(projectId, runId), 'proposed.json'), [...list, relative]);
  }
  /** Mark paths as asked of a person, for a depth-2 child's proposals merged into this copy. */
  async markProposed(projectId: string, runId: string, paths: readonly string[]) {
    for (const item of paths) await this.propose(projectId, runId, item);
  }

  /** Compare the copy with its snapshot. Links are never returned; a file outside the scope is dropped and named. */
  async collect(manifest: SandboxManifest): Promise<{ entries: CollectedEntry[]; dropped: { path: string; reason: string }[] }> {
    const work = this.work(manifest.projectId, manifest.runId);
    const { files, links } = await walk(work);
    const proposed = new Set(await this.proposed(manifest.projectId, manifest.runId));
    const snapshot = new Map(manifest.files.map((file) => [file.path, file]));
    const dropped = links.map((item) => ({ path: item, reason: 'A link in the copy is never returned.' }));
    const entries: CollectedEntry[] = [];
    for (const name of files) {
      let relative: string;
      try {
        relative = relativeName(name);
      } catch {
        dropped.push({ path: name, reason: 'This name cannot be used in a project.' });
        continue;
      }
      if (!inScope(relative, manifest.scope)) {
        dropped.push({ path: relative, reason: 'Outside the scope this sub-task was given.' });
        continue;
      }
      const bytes = await fs.readFile(path.join(work, ...relative.split('/')));
      const sha = sha256(bytes);
      const before = snapshot.get(relative) ?? null;
      if (before?.sha === sha) continue;
      const text = textOf(bytes);
      if (text === null) {
        dropped.push({ path: relative, reason: 'Not text, so it cannot be returned as a change.' });
        continue;
      }
      entries.push({
        path: relative,
        op: before ? 'modified' : 'created',
        before: before?.sha ?? null,
        after: sha,
        bytes: bytes.byteLength,
        proposed: proposed.has(relative),
        text,
      });
    }
    const present = new Set(files);
    for (const file of manifest.files)
      if (!present.has(file.path))
        entries.push({ path: file.path, op: 'deleted', before: file.sha, after: null, bytes: 0, proposed: true, text: null });
    return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)), dropped };
  }

  /** The copy is no longer needed once its change set is recorded; the manifest stays until the tree is swept. */
  async collected(manifest: SandboxManifest) {
    const dir = this.dir(manifest.projectId, manifest.runId);
    await atomicJson(path.join(dir, 'manifest.json'), { ...manifest, state: 'collected' });
    await fs.rm(path.join(dir, 'work'), { recursive: true, force: true });
  }

  async remove(projectId: string, runId: string) {
    await fs.rm(this.dir(projectId, runId), { recursive: true, force: true });
  }

  /** Remove every sandbox whose root run has ended (or is gone). Returns the child ids removed. */
  async sweep(projectId: string, ended: (rootRunId: string) => Promise<boolean>): Promise<string[]> {
    const removed: string[] = [];
    const names = await fs.readdir(this.root(projectId)).catch(() => [] as string[]);
    for (const name of names) {
      let manifest: SandboxManifest | null = null;
      try {
        manifest = await this.read(projectId, name);
      } catch {
        manifest = null;
      }
      if (!manifest || (await ended(manifest.rootRunId))) {
        await fs.rm(path.join(this.root(projectId), name), { recursive: true, force: true });
        removed.push(name);
      }
    }
    return removed;
  }

  /** The only way a process starts for a child: `containedSpawn` rooted at its copy. */
  spawn(manifest: SandboxManifest, cwd: string, command: string, args: readonly string[], limits: SpawnLimits) {
    return containedSpawn(this.work(manifest.projectId, manifest.runId), cwd, command, args, limits);
  }

  /**
   * A child's tools, every one rooted at its copy. `readable` says whether a
   * snapshot file may be read (on a cloud route, the project's sharing grant);
   * a file the child wrote itself is its own. The two writers exist only when
   * the child's grant holds `write-project-file`.
   */
  registry(manifest: SandboxManifest, options: { readable: (path: string) => boolean; write: boolean }): ToolRegistry {
    const work = this.work(manifest.projectId, manifest.runId);
    const snapshot = new Set(manifest.files.map((file) => file.path));
    const registry = new ToolRegistry();
    const refusal = (error: unknown) =>
      error instanceof HarnessError || error instanceof ApiError ? error.message : 'That path cannot be used.';
    const read = {
      version: 'sandbox-v1',
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
      execute: async () => ({
        files: (await walk(work)).files.filter((name) => !snapshot.has(name) || options.readable(name)),
        note: 'This is your own working copy. Changes you make here come back to the loop that handed you this task as a change set.',
      }),
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
        let found;
        try {
          found = await containedPath(work, input.path, { write: false });
        } catch (error) {
          return { path: input.path, refused: refusal(error) };
        }
        if (!inScope(found.relative, manifest.scope)) return { path: found.relative, refused: 'This file is outside the scope you were given.' };
        if (snapshot.has(found.relative) && !options.readable(found.relative))
          return { path: found.relative, refused: 'This file is not shared with the route this answer goes to, so it was not read.' };
        const stat = await fs.lstat(found.absolute).catch(() => null);
        if (!stat) return { path: found.relative, found: false };
        if (!stat.isFile()) return { path: found.relative, refused: 'Only a plain file can be read.' };
        const bytes = await fs.readFile(found.absolute);
        const text = textOf(bytes);
        if (text === null) return { path: found.relative, refused: 'This file is not text.' };
        const max = 24_000;
        return {
          path: found.relative,
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
    const resolve = async (spelled: string) => {
      const found = await containedPath(work, spelled, { write: true });
      if (!inScope(found.relative, manifest.scope)) throw new SandboxRefused('This file is outside the scope you were given.');
      return found;
    };
    const writer = (name: (typeof WRITE_TOOLS)[number], description: string, proposed: boolean) =>
      registry.register({
        name,
        version: 'sandbox-v1',
        description,
        effect: 'idempotent',
        effectClass: 'idempotent-write',
        permission: 'write-project-file',
        // The copy is the child's own: writing it touches nothing of the project, so it asks no one.
        approval: false,
        destination: 'local',
        trustedInputRequired: false,
        cost: 1,
        limits: { maxInputBytes: SANDBOX_LIMITS.maxFileBytes + 4096, maxOutputBytes: 4096, timeoutMs: 30_000 },
        schema: z.strictObject({ path: z.string().min(1).max(400), text: z.string().max(SANDBOX_LIMITS.maxFileBytes) }),
        outputSchema: writeOutput,
        // Named as the sandbox's, so the effect record never reads as a project write.
        targets: async (input) => {
          try {
            return [`sandbox:${manifest.runId}/${(await resolve(input.path)).relative}`];
          } catch {
            return [];
          }
        },
        reconcile: async ({ input }) => {
          const { path: spelled, text } = input as { path: string; text: string };
          const found = await resolve(spelled).catch(() => null);
          const now = found ? await fs.readFile(found.absolute, 'utf8').catch(() => null) : null;
          return now !== null && digest(now) === digest(text) ? 'applied' : 'unknown';
        },
        execute: async ({ input, targets, signal }): Promise<Json> => {
          signal.throwIfAborted();
          let found;
          try {
            found = await resolve(input.path);
          } catch (error) {
            return { path: input.path, refused: refusal(error), code: codeOf(error) };
          }
          if (!targets?.includes(`sandbox:${manifest.runId}/${found.relative}`))
            return { path: found.relative, refused: 'This write did not declare that file as its target.', code: 'path_not_declared' };
          const size = Buffer.byteLength(input.text, 'utf8');
          const { files } = await walk(work);
          let total = size;
          for (const file of files)
            if (file !== found.relative) total += (await fs.lstat(path.join(work, ...file.split('/')))).size;
          if (!files.includes(found.relative) && files.length + 1 > SANDBOX_LIMITS.maxFiles)
            return { path: found.relative, refused: `Your copy already holds ${files.length} files, as many as a sub-task may.`, code: 'sandbox_full' };
          if (total > SANDBOX_LIMITS.maxBytes)
            return { path: found.relative, refused: `This would take your copy past ${SANDBOX_LIMITS.maxBytes / (1024 * 1024)} MB.`, code: 'sandbox_full' };
          // Folders are made one at a time, each judged by the funnel before it exists.
          const parts = found.relative.split('/').slice(0, -1);
          for (let depth = 1; depth <= parts.length; depth++) {
            const folder = await containedPath(work, parts.slice(0, depth).join('/'), { write: true });
            const stat = await fs.lstat(folder.absolute).catch(() => null);
            if (!stat) await fs.mkdir(folder.absolute);
            else if (!stat.isDirectory() || stat.isSymbolicLink())
              return { path: found.relative, refused: 'A folder on this path is not a plain folder.', code: 'path_link' };
          }
          try {
            await containedWrite(work, found.relative, input.text, {
              declared: [found.relative],
              maxBytes: SANDBOX_LIMITS.maxFileBytes,
            });
          } catch (error) {
            if (error instanceof HarnessError && error.outcomeUnknown) throw error;
            return { path: found.relative, refused: refusal(error), code: codeOf(error) };
          }
          if (proposed) await this.propose(manifest.projectId, manifest.runId, found.relative);
          return { path: found.relative, bytes: size, proposed };
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
}
