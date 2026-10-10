/**
 * TS05 of NC-TS-2026-10-09.1 (DIO-31): optional AgentFS task workspaces over a
 * pinned Core Files base (`server/files/agentfs-workspace.ts`). A job's edits go
 * into its own AgentFS database. They come back through the one recorded writer,
 * checked against the pinned base, the job's fence, the digest of what it
 * proposed and the sources it was given.
 *
 * Every scenario runs on an in-memory stand-in for agentfs-sdk 0.6.4
 * (`tests/fixtures/agentfs-double.ts`). Set NCTS_TURSO_NODE_MODULES to a
 * node_modules holding agentfs-sdk 0.6.4 on @tursodatabase/database 0.4.4 (TS00's
 * probe install) to run them again on the real SDK, with checks of what the
 * engine does itself. Without it that run is skipped. The SDK is never a
 * dependency of this repository.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { OriginSnapshot } from '../shared/attribution.js';
import type { CapabilityManifest, HarnessPrincipal, Json } from '../shared/harness.js';
import { Store } from '../server/store.js';
import { ApiError } from '../server/paths.js';
import { FileRunStore, RunService } from '../server/harness/index.js';
import { minimalEnvironment } from '../server/harness/containment.js';
import { SandboxStore } from '../server/sandbox/sandbox.js';
import { NO_ENVIRONMENT_REASON, listIsolatedEnvironments } from '../server/trust/environments.js';
import {
  AGENTFS_PINS,
  AgentFsWorkspaces,
  WORKSPACE_LIMITS,
  loadAgentFsSdk,
  workspaceAdapterFor,
  workspaceProcessExecution,
  type AgentFsHandle,
  type AgentFsSdk,
  type MaterializeSpec,
  type PromoteRequest,
  type WorkspaceLease,
  type WorkspaceSession,
} from '../server/files/agentfs-workspace.js';
import { agentFsDouble } from './fixtures/agentfs-double.js';

const realModules = process.env.NCTS_TURSO_NODE_MODULES;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const SESSION = 'S-loop';
const MODEL: OriginSnapshot = {
  protocolVersion: 1,
  mode: 'direct',
  engine: { id: 'google-vertex', version: 'v1' },
  model: { requested: 'gemini-3.8-flash-001', reported: 'gemini-3.8-flash-001', source: 'runtime' },
};
const PRICES = '# Prices\n\nSoup 6\nBread 3\nPie 5\n';
const SOUP_7 = PRICES.replace('Soup 6', 'Soup 7');
const SOUP_8 = PRICES.replace('Soup 6', 'Soup 8');
const ROTA = '# Rota\n\nMon: Ana\n';
const CATALOG = `# Catalog\n\n${'Linen napkin, white, 100 count.\n'.repeat(10_000)}`;
const PLENTY = 64 * 1024 ** 3;
const CANARY = 'FAKE-CANARY-NOT-A-SECRET';

const capability: CapabilityManifest = {
  id: 'agentfs-workspace-test',
  version: 'v1',
  label: 'AgentFS workspace test',
  description: 'A sub-task working in its AgentFS workspace.',
  tools: ['list_project_files', 'read_project_file', 'write_file', 'propose_file'],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 8,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};
const principal = (projectId: string): HarnessPrincipal => ({
  id: 'child',
  tenantId: 'local',
  projectId,
  capabilities: ['write-project-file'],
  identityGeneration: 1,
});

/** What another program could do with a workspace's database, beyond the slice the adapter uses. */
type Linker = { symlink(target: string, linkpath: string): Promise<void> };
type ToolLog = {
  record(name: string, startedAt: number, completedAt: number, parameters?: unknown, result?: unknown, error?: string): Promise<number>;
};

function conformance(load: () => Promise<AgentFsSdk>) {
  let base: string, store: Store, sdk: AgentFsSdk, workspaces: AgentFsWorkspaces, service: RunService;
  let projectId: string, folder: string, taskId: string;
  let grants: string, free: number, step: number, runs: number;
  const sessions: WorkspaceSession[] = [];
  const handles: AgentFsHandle[] = [];

  /** Another host's workspaces over the same project: its own data folder, the same sources. */
  const host = (name: string) =>
    new AgentFsWorkspaces({ store, sdk, sources: { generation: () => grants }, dataDir: path.join(base, name), freeBytes: async () => free });

  beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentfs-workspaces-')));
    store = new Store(path.join(base, 'data'), path.join(base, 'projects'));
    await store.init();
    sdk = await load();
    grants = 'grants-1';
    free = PLENTY;
    workspaces = new AgentFsWorkspaces({ store, sdk, sources: { generation: () => grants }, freeBytes: async () => free });
    const project = await store.locked(() => store.createProject('Bistro'));
    projectId = project.id;
    folder = project.folder;
    await fs.mkdir(path.join(folder, 'Menu'));
    await fs.mkdir(path.join(folder, 'Staff'));
    await fs.writeFile(path.join(folder, 'Menu', 'Prices.md'), PRICES);
    await fs.writeFile(path.join(folder, 'Menu', 'Fall.md'), '# Fall\n');
    await fs.writeFile(path.join(folder, 'Staff', 'Rota.md'), ROTA);
    taskId = await store.locked(async () => {
      const task = store.createTask(store.state(projectId), { name: 'Update the menu' });
      await store.persist(store.state(projectId));
      return task.id;
    });
    service = new RunService(new FileRunStore(path.join(base, 'runs')), { clock: () => 1000 });
    step = 0;
    runs = 0;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
    for (const handle of handles.splice(0)) await handle.close().catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true });
  });

  const materialize = (jobId: string, scope: readonly string[] | null = ['Menu'], extra: Partial<MaterializeSpec> = {}) =>
    workspaces.materialize({ projectId, jobId, owner: 'worker-a', scope, ...extra });
  /** The job a checkpoint is opened as: this project's, by default Rjob-a for worker-a. */
  const job = (owner = 'worker-a', jobId = 'Rjob-a') => ({ projectId, jobId, owner });

  /** A lease's tools inside a run, the way the loop hands them to a sub-task. */
  async function session(lease: WorkspaceLease, options: { write?: boolean; readable?: (path: string) => boolean; on?: AgentFsWorkspaces } = {}) {
    const opened = await (options.on ?? workspaces).open(lease, { readable: options.readable ?? (() => true), write: options.write ?? true });
    sessions.push(opened);
    const runId = `Rws-${++runs}`;
    await service.start({
      id: runId,
      tenantId: 'local',
      projectId,
      // A reader's registry has no write tools, and a run may only name tools its registry holds.
      capability: { ...capability, tools: capability.tools.filter((name) => opened.tools.has(name)) },
      principal: principal(projectId),
      budget: { units: 100, modelCalls: 5, toolCalls: 100, wallMs: null },
      tools: opened.tools,
    });
    await service.claim(runId, 'host', 60_000);
    const call = (name: string, input: unknown) =>
      opened.tools.dispatch<Json>(service, { runId, owner: 'host', principal: principal(projectId), stepId: `t${++step}`, name, input });
    return { ...opened, runId, call };
  }

  /** Write files through a fresh session and close it. */
  async function edit(lease: WorkspaceLease, files: Record<string, string>) {
    const opened = await session(lease);
    for (const [relative, text] of Object.entries(files))
      expect(await opened.call('write_file', { path: relative, text })).toMatchObject({ path: relative, proposed: false });
    await opened.close();
  }

  /** A workspace's database opened directly, the way another program could. */
  async function direct(lease: WorkspaceLease, on: AgentFsWorkspaces = workspaces) {
    const handle = await sdk.open({ path: path.join(on.dir(projectId, lease.jobId), lease.delta) });
    handles.push(handle);
    return handle;
  }

  const request = (digest: string, overrides: Partial<PromoteRequest> = {}): PromoteRequest => ({
    digest,
    canWrite: true,
    applyScope: ['Menu'],
    origin: MODEL,
    sessionId: SESSION,
    taskId,
    ...overrides,
  });
  const read = (relative: string) => fs.readFile(path.join(folder, ...relative.split('/')), 'utf8');
  const recorded = () => store.state(projectId).history.filter((entry) => entry.kind === 'workspace-change');
  const projectState = () => {
    const state = store.state(projectId);
    return structuredClone({ history: state.history, needs: state.needs, changes: state.changes, tasks: state.tasks });
  };

  describe('TS-041: two jobs on one file', () => {
    test('each job edits its own copy; the first change applies and the second is a conflict that never overwrites it', async () => {
      const a = await materialize('Rjob-a');
      const b = await workspaces.materialize({ projectId, jobId: 'Rjob-b', owner: 'worker-b', scope: ['Menu'] });
      await edit(a, { 'Menu/Prices.md': SOUP_7 });
      const other = await session(b);
      // B's copy still holds the pinned text, not A's change.
      expect(await other.call('read_project_file', { path: 'Menu/Prices.md' })).toMatchObject({ found: true, text: PRICES, sha: sha256(PRICES) });
      expect(await other.call('write_file', { path: 'Menu/Prices.md', text: SOUP_8 })).toMatchObject({ proposed: false });
      await other.close();
      expect(await read('Menu/Prices.md')).toBe(PRICES);

      const first = await workspaces.proposeOutputs(a);
      expect(first.outputs.entries).toEqual([
        { path: 'Menu/Prices.md', op: 'modified', before: sha256(PRICES), after: sha256(SOUP_7), bytes: Buffer.byteLength(SOUP_7), proposed: false },
      ]);
      expect(await workspaces.promote(a, request(first.digest))).toMatchObject({
        applied: [{ path: 'Menu/Prices.md', sha: sha256(SOUP_7), replayed: false }],
        conflicts: [],
        waiting: [],
      });
      const second = await workspaces.proposeOutputs(b);
      expect(await workspaces.promote(b, request(second.digest))).toMatchObject({
        applied: [],
        // A conflict carries what a person needs to review it: the pinned file it was made against and its own bytes.
        conflicts: [{ path: 'Menu/Prices.md', currentSha: sha256(SOUP_7), before: sha256(PRICES), after: sha256(SOUP_8) }],
      });
      expect(await read('Menu/Prices.md')).toBe(SOUP_7);
      expect(recorded()).toHaveLength(1);
      expect(recorded()[0]).toMatchObject({
        actor: 'diomedes',
        sessionId: SESSION,
        files: [expect.objectContaining({ path: 'Menu/Prices.md', before: sha256(PRICES), after: sha256(SOUP_7) })],
      });
      // It is an ordinary waiting Change of the loop's session, so review, keep and Undo apply as for any change.
      expect(store.state(projectId).changes.find((change) => change.entryId === recorded()[0].id)).toMatchObject({ path: 'Menu/Prices.md', state: 'waiting' });
    });

    test('one writer per workspace: a second writer is refused until the first closes', async () => {
      const lease = await materialize('Rjob-a');
      const writer = await session(lease);
      await expect(workspaces.open(lease, { readable: () => true, write: true })).rejects.toMatchObject({ code: 'workspace_writer_busy' });
      // Another host's instance over the same folder sees the same lock.
      const same = new AgentFsWorkspaces({ store, sdk, sources: { generation: () => grants }, freeBytes: async () => free });
      await expect(same.open(lease, { readable: () => true, write: true })).rejects.toMatchObject({ code: 'workspace_writer_busy' });
      // A reader alongside it has no write tools.
      const reader = await session(lease, { write: false });
      expect(reader.tools.has('write_file')).toBe(false);
      expect(reader.tools.has('propose_file')).toBe(false);
      await reader.close();
      await writer.close();
      const again = await session(lease);
      expect(await again.call('write_file', { path: 'Menu/Fall.md', text: '# Fall\n\nPumpkin soup\n' })).toMatchObject({ proposed: false });
    });

    test('two writers opened at the same moment in one process: the second is refused, and the first holds the only lock', async () => {
      const lease = await materialize('Rjob-a');
      const lock = path.join(workspaces.dir(projectId, 'Rjob-a'), 'writer.lock');
      const write = fs.writeFile.bind(fs);
      let second: Promise<string> | undefined;
      // The second open runs to its end once the first has made its lock file, before the first holds it.
      vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
        await write(file, data, options);
        if (second || path.resolve(String(file)) !== lock) return;
        second = workspaces.open(lease, { readable: () => true, write: true }).then(
          async (opened) => {
            await opened.close();
            return 'opened';
          },
          (error: { code?: string }) => error.code ?? 'failed',
        );
        await second;
      });
      const first = await session(lease);
      expect(await second).toBe('workspace_writer_busy');
      vi.restoreAllMocks();
      // The first writer holds the workspace and its lock, and only its close lets go of them.
      await expect(workspaces.open(lease, { readable: () => true, write: true })).rejects.toMatchObject({ code: 'workspace_writer_busy' });
      expect(await first.call('write_file', { path: 'Menu/Fall.md', text: '# Fall\n\nCider\n' })).toMatchObject({ proposed: false });
      await first.close();
      await expect(fs.lstat(lock)).rejects.toThrow();
      const again = await session(lease);
      await again.close();
    });

    test('a writer whose lock file cannot be made holds nothing, so no later writer is refused for it', async () => {
      const lease = await materialize('Rjob-a');
      const lock = path.join(workspaces.dir(projectId, 'Rjob-a'), 'writer.lock');
      const write = fs.writeFile.bind(fs);
      vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
        if (path.resolve(String(file)) === lock) throw Object.assign(new Error('EACCES: refused by the test'), { code: 'EACCES' });
        return write(file, data, options);
      });
      await expect(workspaces.open(lease, { readable: () => true, write: true })).rejects.toMatchObject({ code: 'EACCES' });
      vi.restoreAllMocks();
      const writer = await session(lease);
      expect(await writer.call('write_file', { path: 'Menu/Fall.md', text: '# Fall\n\nCider\n' })).toMatchObject({ proposed: false });
      await writer.close();
      const { digest } = await workspaces.proposeOutputs(lease);
      expect(await workspaces.promote(lease, request(digest))).toMatchObject({ applied: [{ path: 'Menu/Fall.md' }] });
    });
  });

  describe('TS-042: a checkpoint carries its base', () => {
    test('a complete checkpoint opens on another host, reads the files the job never touched and hands back the same changes', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7, 'Menu/New/Winter.md': '# Winter\n' });
      const out = path.join(base, 'checkpoint');
      expect(await workspaces.exportCheckpoint(lease, out)).toMatchObject({ entries: 2 });
      const other = host('host-b');
      const moved = await other.importCheckpoint(out, job());
      // The same workspace, with its database under a name new to this host.
      expect(moved).toEqual({ ...lease, delta: moved.delta });
      expect(moved.delta).not.toBe(lease.delta);
      const reader = await session(moved, { write: false, on: other });
      expect(await reader.call('read_project_file', { path: 'Menu/Fall.md' })).toMatchObject({ found: true, text: '# Fall\n' });
      expect(await reader.call('read_project_file', { path: 'Menu/Prices.md' })).toMatchObject({ found: true, text: SOUP_7 });
      expect(await reader.call('list_project_files', {})).toMatchObject({ files: ['Menu/Fall.md', 'Menu/New/Winter.md', 'Menu/Prices.md'] });
      await reader.close();
      expect((await other.proposeOutputs(moved)).digest).toBe((await workspaces.proposeOutputs(lease)).digest);
    });

    test('a checkpoint missing a pinned file, its base list or a database file is refused, naming what is missing', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const out = path.join(base, 'checkpoint');
      await workspaces.exportCheckpoint(lease, out);
      const variant = async (name: string, damage: (copy: string) => Promise<unknown>) => {
        const copy = path.join(base, name);
        await fs.cp(out, copy, { recursive: true });
        await damage(copy);
        return copy;
      };

      const noFall = await variant('no-fall', (copy) => fs.rm(path.join(copy, 'base', sha256('# Fall\n'))));
      await expect(host('host-b').importCheckpoint(noFall, job())).rejects.toMatchObject({
        code: 'checkpoint_incomplete',
        message: expect.stringMatching(/not 1 of the files they were made against \(Menu\/Fall\.md\)/),
      });
      await expect(fs.lstat(host('host-b').dir(projectId, 'Rjob-a'))).rejects.toThrow();

      const noList = await variant('no-list', (copy) => fs.rm(path.join(copy, 'base.json')));
      await expect(host('host-c').importCheckpoint(noList, job())).rejects.toMatchObject({
        code: 'checkpoint_incomplete',
        message: expect.stringMatching(/without the list of files they were made against/),
      });

      const changed = await variant('changed', (copy) => fs.writeFile(path.join(copy, 'base', sha256(PRICES)), PRICES.replace('Bread 3', 'Bread 4')));
      await expect(host('host-d').importCheckpoint(changed, job())).rejects.toMatchObject({
        code: 'checkpoint_incomplete',
        message: expect.stringMatching(/\(Menu\/Prices\.md\)/),
      });

      // On the real engine the last database file is its -wal file, which holds the rows.
      const databaseFiles = (await fs.readdir(path.join(out, 'delta'))).sort();
      const noDatabase = await variant('no-database', (copy) => fs.rm(path.join(copy, 'delta', databaseFiles.at(-1)!)));
      await expect(host('host-e').importCheckpoint(noDatabase, job())).rejects.toMatchObject({ code: 'checkpoint_incomplete' });
      await expect(fs.lstat(host('host-e').dir(projectId, 'Rjob-a'))).rejects.toThrow();

      // A database file name from the checkpoint is never used as a path until it is one of the delta's own names. This one
      // walks out of the delta folder to a file the checkpoint really holds, listed with its true sha and size, so only the
      // name check keeps a copy of it from landing outside the workspace's folder.
      const escaping = await variant('escaping', async (copy) => {
        const record = JSON.parse(await fs.readFile(path.join(copy, 'checkpoint.json'), 'utf8')) as { delta: { files: unknown[] } };
        const list = await fs.readFile(path.join(copy, 'base.json'));
        record.delta.files.push({ name: `${lease.delta}/../../base.json`, sha: sha256(list), bytes: list.byteLength });
        await fs.writeFile(path.join(copy, 'checkpoint.json'), JSON.stringify(record));
      });
      await expect(host('host-f').importCheckpoint(escaping, job())).rejects.toMatchObject({ code: 'checkpoint_incomplete' });
      await expect(fs.lstat(path.join(host('host-f').dir(projectId, 'Rjob-a'), '..', 'base.json'))).rejects.toThrow();
      await expect(fs.lstat(host('host-f').dir(projectId, 'Rjob-a'))).rejects.toThrow();

      // The database's own name comes from the checkpoint too, so a name that is not a delta's is refused before any path is made.
      const renamed = await variant('renamed', async (copy) => {
        const record = JSON.parse(await fs.readFile(path.join(copy, 'checkpoint.json'), 'utf8')) as { lease: { delta: string } };
        record.lease.delta = '../../escaped.db';
        await fs.writeFile(path.join(copy, 'checkpoint.json'), JSON.stringify(record));
      });
      await expect(host('host-g').importCheckpoint(renamed, job())).rejects.toMatchObject({
        code: 'checkpoint_incomplete',
        message: 'This folder is not a complete workspace checkpoint.',
      });
      await expect(fs.lstat(host('host-g').dir(projectId, 'Rjob-a'))).rejects.toThrow();
      expect(await fs.readdir(base)).not.toContain('escaped.db');
    });

    test('the job’s database alone holds only what the job wrote', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const out = path.join(base, 'checkpoint');
      await workspaces.exportCheckpoint(lease, out);
      const alone = path.join(base, 'alone');
      await fs.cp(path.join(out, 'delta'), alone, { recursive: true });
      const handle = await sdk.open({ path: path.join(alone, lease.delta) });
      handles.push(handle);
      expect((await handle.fs.readFile('/Menu/Prices.md')).toString('utf8')).toBe(SOUP_7);
      await expect(handle.fs.readFile('/Menu/Fall.md')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('TS-043: whole-file changes are reserved before they are written', () => {
    test('a few-byte change to a large pinned file costs the whole file, and is refused before anything is written', async () => {
      await fs.writeFile(path.join(folder, 'Menu', 'Catalog.md'), CATALOG);
      const lease = await materialize('Rjob-a', ['Menu'], { limits: { maxDeltaBytes: 200 * 1024 } });
      const opened = await session(lease);
      expect(await opened.call('write_file', { path: 'Menu/Catalog.md', text: CATALOG.replace('white', 'cream') })).toMatchObject({
        code: 'workspace_budget',
        refused: expect.stringMatching(/costs 0\.3 MB in this workspace, because a change rewrites the whole file, and it has 0\.2 MB left/),
      });
      expect(await opened.call('read_project_file', { path: 'Menu/Catalog.md' })).toMatchObject({ found: true, sha: sha256(CATALOG), truncated: true });
      // A small new file fits.
      expect(await opened.call('write_file', { path: 'Menu/Note.md', text: '# Note\n' })).toMatchObject({ path: 'Menu/Note.md' });
      await opened.close();
      const handle = await direct(lease);
      expect(await handle.fs.readdir('/Menu')).toEqual(['Note.md']);
    });

    test('a write that would leave too little free disk is refused before anything is written', async () => {
      const lease = await materialize('Rjob-a');
      const opened = await session(lease);
      free = WORKSPACE_LIMITS.diskHeadroomBytes + 4;
      expect(await opened.call('write_file', { path: 'Menu/Note.md', text: '# Note\n' })).toMatchObject({ code: 'workspace_disk_full' });
      expect(await opened.call('list_project_files', {})).toMatchObject({ files: ['Menu/Fall.md', 'Menu/Prices.md'] });
      free = PLENTY;
      expect(await opened.call('write_file', { path: 'Menu/Note.md', text: '# Note\n' })).toMatchObject({ path: 'Menu/Note.md' });
    });

    test('the database is measured on disk, journal files included, and a write that would take it past its cap is refused', async () => {
      const sizes = async (lease: WorkspaceLease) => {
        const dir = workspaces.dir(projectId, lease.jobId);
        const found: Record<string, number> = {};
        for (const name of await fs.readdir(dir)) if (name.startsWith(lease.delta)) found[name] = (await fs.lstat(path.join(dir, name))).size;
        return found;
      };
      // An empty job's database, as made: the engine's own files beside it count.
      const made = await sizes(await materialize('Rjob-a'));
      const [main, ...journals] = Object.keys(made).sort();
      expect(main).toMatch(/^delta-[a-f0-9]{16}\.db$/);
      for (const name of journals) expect(name).toMatch(/^delta-[a-f0-9]{16}\.db(?:-wal|-shm|-journal)$/);
      const empty = Object.values(made).reduce((sum, size) => sum + size, 0);
      expect(empty).toBeGreaterThan(0);
      // The real engine keeps a journal that outweighs its database file, and the stand-in keeps none. A cap between
      // the database file and the whole refuses even a small first write, so the journal is what pushed it past.
      if (empty - made[main] > 1024) {
        const journaled = await materialize('Rjob-c', ['Menu'], { limits: { maxDeltaDiskBytes: made[main] + 1024 } });
        const first = await session(journaled);
        expect(await first.call('write_file', { path: 'Menu/Note.md', text: '# Note\n' })).toMatchObject({ code: 'workspace_budget' });
        await first.close();
      }
      const cap = empty + 50 * 1024;
      const lease = await materialize('Rjob-b', ['Menu'], { limits: { maxDeltaDiskBytes: cap } });
      const opened = await session(lease);
      // Larger than the whole cap, so it is refused however the engine keeps its journal.
      expect(await opened.call('write_file', { path: 'Menu/Big.md', text: `# Big\n${'x'.repeat(cap + 1024)}\n` })).toMatchObject({
        code: 'workspace_budget',
        refused: expect.stringMatching(/database already takes \d+\.\d MB on disk, and writing Menu\/Big\.md would take it past the \d+\.\d MB it may use, so nothing was written/),
      });
      expect(await opened.call('write_file', { path: 'Menu/Note.md', text: '# Note\n' })).toMatchObject({ path: 'Menu/Note.md' });
      await opened.close();
      const handle = await direct(lease);
      expect(await handle.fs.readdir('/Menu')).toEqual(['Note.md']);
    });

    test('pinning a scope, copying a checkpoint and opening one each reserve their disk space first', async () => {
      const tight = WORKSPACE_LIMITS.diskHeadroomBytes + 4;
      free = tight;
      await expect(materialize('Rjob-a')).rejects.toMatchObject({
        code: 'workspace_disk_full',
        message: expect.stringMatching(/This scope needs \d+\.\d MB of disk space for its workspace, and that would leave too little free/),
      });
      await expect(fs.lstat(workspaces.dir(projectId, 'Rjob-a'))).rejects.toThrow();
      free = PLENTY;
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const copy = path.join(base, 'checkpoint');
      free = tight;
      await expect(workspaces.exportCheckpoint(lease, copy)).rejects.toMatchObject({
        code: 'workspace_disk_full',
        message: expect.stringMatching(/This checkpoint needs \d+\.\d MB of disk space, and that would leave too little free, so nothing was copied/),
      });
      expect(await fs.readdir(copy).catch(() => [])).toEqual([]);
      free = PLENTY;
      await workspaces.exportCheckpoint(lease, copy);
      const other = host('host-b');
      free = tight;
      await expect(other.importCheckpoint(copy, job())).rejects.toMatchObject({
        code: 'workspace_disk_full',
        message: expect.stringMatching(/needs \d+\.\d MB of disk space on this host, and that would leave too little free, so it was not opened/),
      });
      await expect(fs.lstat(other.dir(projectId, 'Rjob-a'))).rejects.toThrow();
      free = PLENTY;
      expect(await other.importCheckpoint(copy, job())).toMatchObject({ jobId: 'Rjob-a', state: 'open' });
    });

    test('a scope larger than a workspace may hold is refused whole and leaves nothing behind', async () => {
      await fs.writeFile(path.join(folder, 'Menu', 'Catalog.md'), CATALOG);
      await expect(materialize('Rjob-a', ['Menu'], { limits: { maxBaseBytes: 100 * 1024 } })).rejects.toMatchObject({
        code: 'workspace_too_large',
        message: expect.stringMatching(/This scope holds 3 files \(0\.3 MB\); a workspace holds at most 200 files and 0\.1 MB/),
      });
      await expect(fs.lstat(workspaces.dir(projectId, 'Rjob-a'))).rejects.toThrow();
      await expect(materialize('Rjob-b', ['Menu'], { limits: { maxFileBytes: 100 * 1024 } })).rejects.toMatchObject({
        message: expect.stringMatching(/Menu\/Catalog\.md is 0\.3 MB; a workspace holds files of at most 0\.1 MB/),
      });
      await expect(fs.lstat(workspaces.dir(projectId, 'Rjob-b'))).rejects.toThrow();
    });
  });

  describe('TS-044: the workspace reaches nothing of the host', () => {
    test('host paths are refused or not found, and nothing reaches a fake home holding a fake credential', async () => {
      const home = path.join(base, 'home');
      await fs.mkdir(path.join(home, '.aws'), { recursive: true });
      await fs.writeFile(path.join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key = ${CANARY}\n`);
      await fs.writeFile(path.join(folder, '.env'), `TOKEN=${CANARY}\n`);
      vi.stubEnv('HOME', home);
      vi.stubEnv('USERPROFILE', home);
      const lease = await materialize('Rjob-a', null);
      const opened = await session(lease);
      const hostile = [
        '../home/.aws/credentials',
        'Menu/../../home/.aws/credentials',
        path.join(home, '.aws', 'credentials'),
        'C:/Windows/win.ini',
        'c:win.ini',
        '\\\\?\\C:\\Windows\\win.ini',
        '\\\\server\\share\\Prices.md',
        '~/.aws/credentials',
        '%USERPROFILE%/.aws/credentials',
        '$HOME/.aws/credentials',
        'Menu/Prices.md:hidden',
        'CON',
        'Menu/nul.md',
        '.env',
      ];
      for (const spelled of hostile) {
        const answer = await opened.call('read_project_file', { path: spelled });
        expect(JSON.stringify(answer)).not.toContain(CANARY);
        expect(answer).toSatisfy((value: { refused?: string; found?: boolean }) => typeof value.refused === 'string' || value.found === false);
      }
      // What the copy lists is the pinned scope, and nothing else of the disk.
      expect(await opened.call('list_project_files', {})).toMatchObject({ files: ['Menu/Fall.md', 'Menu/Prices.md', 'Staff/Rota.md'] });
      // Each is refused as a write too, so none of them reaches even the job's own database.
      for (const spelled of hostile)
        expect(await opened.call('write_file', { path: spelled, text: 'x\n' })).toMatchObject({ code: expect.any(String), refused: expect.any(String) });
      await opened.close();
      const handle = await direct(lease);
      expect(await handle.fs.readdir('/')).toEqual([]);
      await handle.close();
      expect(await fs.readdir(path.join(home, '.aws'))).toEqual(['credentials']);
      expect(await fs.readFile(path.join(home, '.aws', 'credentials'), 'utf8')).toContain(CANARY);
      expect((await fs.readdir(base)).sort()).toEqual(['data', 'home', 'projects', 'runs']);
      expect(await read('Menu/Prices.md')).toBe(PRICES);
    });

    test('a file the route may not read stays hidden and unread', async () => {
      const lease = await materialize('Rjob-a');
      const opened = await session(lease, { readable: (relative) => relative !== 'Menu/Fall.md' });
      expect(await opened.call('list_project_files', {})).toMatchObject({ files: ['Menu/Prices.md'] });
      expect(await opened.call('read_project_file', { path: 'Menu/Fall.md' })).toMatchObject({
        refused: 'This file is not shared with the route this answer goes to, so it was not read.',
      });
    });

    test('no program runs in a workspace: there is no isolated environment, and a copy passes no home or credentials on', async () => {
      expect(listIsolatedEnvironments()).toEqual([]);
      expect(workspaceProcessExecution()).toEqual({ available: false, reason: NO_ENVIRONMENT_REASON });
      const lease = await materialize('Rjob-a');
      const opened = await session(lease);
      for (const name of ['list_project_files', 'read_project_file', 'write_file', 'propose_file']) expect(opened.tools.has(name)).toBe(true);
      for (const name of ['run_command', 'run_program', 'shell', 'exec', 'spawn']) expect(opened.tools.has(name)).toBe(false);
      // A sub-task that runs programs works in a copy, whose processes inherit only the search path and system folders.
      expect(workspaceAdapterFor({ sdk, runsPrograms: true })).toMatchObject({ adapter: 'copy' });
      const env = minimalEnvironment(
        {},
        { PATH: 'C:/bin', HOME: 'C:/home', USERPROFILE: 'C:/home', APPDATA: 'C:/home/AppData', AWS_SECRET_ACCESS_KEY: CANARY, GITHUB_TOKEN: CANARY },
      );
      expect(env).toEqual({ PATH: 'C:/bin' });
      let refused: unknown;
      try {
        minimalEnvironment({ GITHUB_TOKEN: CANARY }, {});
      } catch (error) {
        refused = error;
      }
      expect(refused).toMatchObject({ code: 'spawn_env_refused' });
    });
  });

  describe('TS-045: encryption and sync are refused by name', () => {
    test.each([
      [{ encryption: true, sync: true }, 'agentfs_encryption_with_sync'],
      [{ encryption: true }, 'agentfs_encryption_unsupported'],
      [{ sync: true }, 'agentfs_sync_unsupported'],
    ] as const)('%o is refused as %s, and nothing is made', async (mode, code) => {
      await expect(materialize('Rjob-a', ['Menu'], { mode })).rejects.toMatchObject({ code });
      await expect(fs.lstat(workspaces.dir(projectId, 'Rjob-a'))).rejects.toThrow();
      expect(await workspaces.assignment(projectId, 'Rjob-a')).toBeNull();
    });
  });

  describe('TS-046: a stale owner or a changed source hands nothing back', () => {
    test('after the job moves to a new owner, the old workspace can no longer write, list, copy or hand back', async () => {
      const lease = await materialize('Rjob-a');
      const opened = await session(lease);
      expect(await opened.call('write_file', { path: 'Menu/Prices.md', text: SOUP_7 })).toMatchObject({ proposed: false });
      const { digest } = await workspaces.proposeOutputs(lease);
      expect(lease.assignmentFence).toBe('Rjob-a#1');
      expect(await workspaces.reassign(projectId, 'Rjob-a', 'worker-b')).toBe('Rjob-a#2');
      expect(await opened.call('write_file', { path: 'Menu/Fall.md', text: '# Fall\n\nPumpkin soup\n' })).toMatchObject({
        code: 'workspace_stale_assignment',
      });
      await opened.close();
      await expect(workspaces.proposeOutputs(lease)).rejects.toMatchObject({ code: 'workspace_stale_assignment' });
      await expect(workspaces.promote(lease, request(digest))).rejects.toMatchObject({ code: 'workspace_stale_assignment' });
      await expect(workspaces.open(lease, { readable: () => true, write: false })).rejects.toMatchObject({ code: 'workspace_stale_assignment' });
      // A checkpoint would carry the old fence to a host with no record of the job, so none is made.
      const copy = path.join(base, 'stale-checkpoint');
      await expect(workspaces.exportCheckpoint(lease, copy)).rejects.toMatchObject({ code: 'workspace_stale_assignment' });
      await expect(fs.readdir(copy)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await read('Menu/Prices.md')).toBe(PRICES);
      expect(recorded()).toHaveLength(0);
      // The new owner starts from a fresh workspace, never the old one's changes.
      await expect(workspaces.materialize({ projectId, jobId: 'Rjob-a', owner: 'worker-b', scope: ['Menu'] })).rejects.toMatchObject({
        code: 'workspace_stale_assignment',
      });
      await workspaces.dispose(lease);
      const fresh = await workspaces.materialize({ projectId, jobId: 'Rjob-a', owner: 'worker-b', scope: ['Menu'] });
      expect(fresh.assignmentFence).toBe('Rjob-a#2');
      expect((await workspaces.proposeOutputs(fresh)).outputs.entries).toEqual([]);
    });

    test('when who may read the job’s files changes, its changes are not handed back, and nothing is spent', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const { digest } = await workspaces.proposeOutputs(lease);
      grants = 'grants-2';
      await expect(workspaces.promote(lease, request(digest))).rejects.toMatchObject({ code: 'workspace_source_changed' });
      expect(await read('Menu/Prices.md')).toBe(PRICES);
      expect(recorded()).toHaveLength(0);
      grants = 'grants-1';
      expect(await workspaces.promote(lease, request(digest))).toMatchObject({ applied: [{ path: 'Menu/Prices.md' }] });
    });
  });

  describe('TS-047: a spent workspace changes nothing more', () => {
    test('after an acknowledged hand-back, neither the tools nor a direct write to the database reach the project', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const { digest } = await workspaces.proposeOutputs(lease);
      expect(await workspaces.promote(lease, request(digest))).toMatchObject({ applied: [{ path: 'Menu/Prices.md', sha: sha256(SOUP_7) }] });
      const entry = structuredClone(recorded()[0]);
      const object = await fs.readFile(store.objectPath(projectId, sha256(SOUP_7)), 'utf8');
      expect(object).toBe(SOUP_7);
      expect((await workspaces.read(projectId, 'Rjob-a'))?.state).toBe('promoted');

      await expect(workspaces.open(lease, { readable: () => true, write: true })).rejects.toMatchObject({ code: 'workspace_spent' });
      await expect(workspaces.promote(lease, request(digest))).rejects.toMatchObject({ code: 'workspace_spent' });
      const handle = await direct(lease);
      await handle.fs.writeFile('/Menu/Prices.md', PRICES.replace('Soup 6', 'Soup 99'));
      await handle.close();
      await expect(workspaces.proposeOutputs(lease)).rejects.toMatchObject({ code: 'workspace_spent' });
      await expect(workspaces.promote(lease, request(digest))).rejects.toMatchObject({ code: 'workspace_spent' });
      await expect(workspaces.exportCheckpoint(lease, path.join(base, 'checkpoint'))).rejects.toMatchObject({ code: 'workspace_spent' });

      expect(await read('Menu/Prices.md')).toBe(SOUP_7);
      expect(recorded()).toEqual([entry]);
      expect(await fs.readFile(store.objectPath(projectId, sha256(SOUP_7)), 'utf8')).toBe(object);
    });

    test('a writer still open blocks the hand-back, in this process or a live one; a lock left by a process that is gone does not', async () => {
      const lease = await materialize('Rjob-a');
      const opened = await session(lease);
      await opened.call('write_file', { path: 'Menu/Prices.md', text: SOUP_7 });
      const { digest } = await workspaces.proposeOutputs(lease);
      await expect(workspaces.promote(lease, request(digest))).rejects.toMatchObject({ code: 'workspace_writer_open' });
      await opened.close();
      const lock = path.join(workspaces.dir(projectId, 'Rjob-a'), 'writer.lock');
      await fs.writeFile(lock, JSON.stringify({ fence: lease.assignmentFence, pid: process.ppid, at: 'then' }));
      await expect(workspaces.promote(lease, request(digest))).rejects.toMatchObject({ code: 'workspace_writer_open' });
      // A process id no operating system issues, so the lock's process is gone however long the test machine has run.
      const gone = 2 ** 30;
      await fs.writeFile(lock, JSON.stringify({ fence: lease.assignmentFence, pid: gone, at: 'then' }));
      expect(await workspaces.promote(lease, request(digest))).toMatchObject({ applied: [{ path: 'Menu/Prices.md' }] });
    });
  });

  describe('TS-048: AgentFS’s own tool log is an observation, never a receipt', () => {
    test('a forged successful send shows as an observation without its arguments, and changes nothing', async () => {
      const lease = await materialize('Rjob-a');
      const before = projectState();
      const handle = await direct(lease);
      const log = handle.tools as unknown as ToolLog;
      await log.record('send_email', 1_760_000_000, 1_760_000_002, { to: 'owner@example.com', body: 'Your order shipped' }, { sent: true, id: 'msg-1' });
      await log.record('charge_card\u0007', 1_760_000_003, 1_760_000_004, { amount: CANARY }, undefined, 'declined');
      await handle.close();
      const seen = await workspaces.observations(lease);
      expect(seen).toEqual({
        unreadable: null,
        observations: [
          {
            source: 'agentfs-tool-log',
            trust: 'observation',
            name: 'charge_card ',
            status: 'error',
            startedAt: new Date(1_760_000_003_000).toISOString(),
            completedAt: new Date(1_760_000_004_000).toISOString(),
          },
          {
            source: 'agentfs-tool-log',
            trust: 'observation',
            name: 'send_email',
            status: 'success',
            startedAt: new Date(1_760_000_000_000).toISOString(),
            completedAt: new Date(1_760_000_002_000).toISOString(),
          },
        ],
      });
      for (const secret of ['owner@example.com', 'msg-1', CANARY, 'declined']) expect(JSON.stringify(seen)).not.toContain(secret);
      const { digest, outputs } = await workspaces.proposeOutputs(lease);
      expect(outputs.entries).toEqual([]);
      expect(await workspaces.promote(lease, request(digest))).toEqual({ applied: [], conflicts: [], waiting: [], dropped: [] });
      expect(projectState()).toEqual(before);
    });
  });

  describe('handing back', () => {
    test('what the loop may not apply waits for a person, with its reason', async () => {
      const lease = await materialize('Rjob-a', null);
      const opened = await session(lease);
      expect(await opened.call('propose_file', { path: 'Menu/Fall.md', text: '# Fall\n\nPumpkin soup\n' })).toMatchObject({ proposed: true });
      await opened.call('write_file', { path: 'Staff/Rota.md', text: '# Rota\n\nMon: Bo\n' });
      await opened.call('write_file', { path: 'Menu/Specials.md', text: '<script>alert(1)</script>\n' });
      await opened.call('write_file', { path: 'Menu/Prices.md', text: SOUP_7 });
      await opened.close();
      const { digest, outputs } = await workspaces.proposeOutputs(lease);
      expect(outputs.entries.map((entry) => [entry.path, entry.op, entry.proposed])).toEqual([
        ['Menu/Fall.md', 'modified', true],
        ['Menu/Prices.md', 'modified', false],
        ['Menu/Specials.md', 'created', false],
        ['Staff/Rota.md', 'modified', false],
      ]);
      const result = await workspaces.promote(lease, request(digest));
      expect(result.applied.map((entry) => entry.path)).toEqual(['Menu/Prices.md']);
      expect(result.waiting).toEqual([
        { path: 'Menu/Fall.md', reason: 'the sub-task asked for a person to decide it', before: sha256('# Fall\n'), after: sha256('# Fall\n\nPumpkin soup\n') },
        {
          path: 'Menu/Specials.md',
          reason: expect.stringMatching(/starts with markup that a browser can run as code/),
          before: null,
          after: sha256('<script>alert(1)</script>\n'),
        },
        { path: 'Staff/Rota.md', reason: 'it is outside what this loop may apply (Menu)', before: sha256(ROTA), after: sha256('# Rota\n\nMon: Bo\n') },
      ]);
      expect(await read('Menu/Fall.md')).toBe('# Fall\n');
      expect(await read('Staff/Rota.md')).toBe(ROTA);
      await expect(fs.lstat(path.join(folder, 'Menu', 'Specials.md'))).rejects.toThrow();

      const other = await materialize('Rjob-b');
      await edit(other, { 'Menu/Fall.md': '# Fall\n\nCider\n' });
      const listed = await workspaces.proposeOutputs(other);
      expect(await workspaces.promote(other, request(listed.digest, { canWrite: false }))).toMatchObject({
        applied: [],
        waiting: [{ path: 'Menu/Fall.md', reason: 'this loop may not write project files' }],
      });
    });

    test('changes made after they were listed are refused, and nothing is written', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const { digest } = await workspaces.proposeOutputs(lease);
      await edit(lease, { 'Menu/Fall.md': '# Fall\n\nCider\n' });
      await expect(workspaces.promote(lease, request(digest))).rejects.toMatchObject({ code: 'workspace_outputs_changed' });
      expect(await read('Menu/Prices.md')).toBe(PRICES);
      const listed = await workspaces.proposeOutputs(lease);
      expect((await workspaces.promote(lease, request(listed.digest))).applied.map((entry) => entry.path)).toEqual(['Menu/Fall.md', 'Menu/Prices.md']);
    });

    test('a hand-back retried after a crash is recognised by its bytes and recorded once', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const { digest } = await workspaces.proposeOutputs(lease);
      await workspaces.promote(lease, request(digest));
      // The crash came after the write landed and before the workspace was marked spent.
      const file = path.join(workspaces.dir(projectId, 'Rjob-a'), 'lease.json');
      await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), state: 'open', promotedAt: null }));
      expect(await workspaces.promote(lease, request(digest))).toMatchObject({
        applied: [{ path: 'Menu/Prices.md', sha: sha256(SOUP_7), replayed: true, entryId: recorded()[0].id }],
      });
      expect(recorded()).toHaveLength(1);
    });

    test('a name the project could not hold the same way is refused when written, and dropped when handed back', async () => {
      const lease = await materialize('Rjob-a', null);
      const opened = await session(lease);
      expect(await opened.call('write_file', { path: 'menu/prices.md', text: SOUP_7 })).toMatchObject({ code: 'path_case_twin' });
      expect(await opened.call('write_file', { path: 'Menu/Prices.md/Notes.md', text: '# Notes\n' })).toMatchObject({ code: 'path_not_folder' });
      expect(await opened.call('write_file', { path: 'Menu', text: '# Menu\n' })).toMatchObject({ code: 'path_not_folder' });
      expect(await opened.call('write_file', { path: 'Menu/New/Winter.md', text: '# Winter\n' })).toMatchObject({ path: 'Menu/New/Winter.md' });
      expect(await opened.call('write_file', { path: 'Menu/New', text: '# New\n' })).toMatchObject({ code: 'path_not_file' });
      expect(await opened.call('write_file', { path: 'Menu/New/Winter.md/Notes.md', text: '# Notes\n' })).toMatchObject({ code: 'path_not_folder' });
      await opened.close();
      // Another program writes the database directly: a link, a name with a backslash in it and bytes that are not text.
      const handle = await direct(lease);
      await (handle.fs as unknown as Linker).symlink('/Menu/Prices.md', '/Menu/Link.md');
      await handle.fs.writeFile('/Menu/odd\\name.md', '# Odd\n');
      await handle.fs.writeFile('/Menu/Logo.md', Buffer.from([0xff, 0xfe, 0x00, 0x01]));
      await handle.close();
      const reader = await session(lease, { write: false });
      expect(await reader.call('read_project_file', { path: 'Menu/Link.md' })).toMatchObject({ refused: 'Only a plain file can be read.' });
      await reader.close();
      const { outputs } = await workspaces.proposeOutputs(lease);
      expect(outputs.entries.map((entry) => entry.path)).toEqual(['Menu/New/Winter.md']);
      expect(outputs.dropped).toEqual([
        { path: 'Menu/Link.md', reason: 'A link in the workspace is never returned.' },
        { path: 'Menu/Logo.md', reason: 'Not text, so it cannot be returned as a change.' },
        { path: 'Menu/odd\\name.md', reason: 'This name cannot be used in a project.' },
      ]);
    });
  });

  describe('making and keeping workspaces', () => {
    test('the copy sandbox stays the default, and its sweep leaves AgentFS workspaces alone', async () => {
      expect(workspaceAdapterFor({ sdk: null, runsPrograms: false })).toMatchObject({ adapter: 'copy' });
      expect(workspaceAdapterFor({ sdk, runsPrograms: false })).toMatchObject({ adapter: 'agentfs' });
      const lease = await materialize('Rjob-a');
      expect(workspaces.dir(projectId, 'Rjob-a')).toBe(path.join(store.dataDir, 'projects', projectId, 'harness', 'workspaces', 'Rjob-a'));
      const sandboxes = new SandboxStore(store, store.dataDir);
      const manifest = await sandboxes.create({
        projectId,
        runId: 'Rloop-d0',
        parentRunId: 'Rloop',
        rootRunId: 'Rloop',
        depth: 1,
        role: 'delegate',
        base: { kind: 'project' },
        scope: ['Menu'],
      });
      expect(manifest.state).toBe('open');
      expect(await sandboxes.sweep(projectId, async () => true)).toEqual(['Rloop-d0']);
      expect(await workspaces.read(projectId, 'Rjob-a')).toEqual(lease);
    });

    test('a workspace interrupted while it was made is made again, and asking again returns it as it is', async () => {
      let interrupt = true;
      const flaky = new AgentFsWorkspaces({
        store,
        sdk,
        sources: {
          generation: () => {
            if (interrupt) {
              interrupt = false;
              throw new Error('interrupted');
            }
            return grants;
          },
        },
        freeBytes: async () => free,
      });
      const spec = { projectId, jobId: 'Rjob-a', owner: 'worker-a', scope: ['Menu'] };
      await expect(flaky.materialize(spec)).rejects.toThrow('interrupted');
      expect((await flaky.read(projectId, 'Rjob-a'))?.state).toBe('materializing');
      await expect(flaky.open((await flaky.read(projectId, 'Rjob-a'))!, { readable: () => true, write: true })).rejects.toMatchObject({
        code: 'workspace_not_ready',
      });
      const lease = await flaky.materialize(spec);
      expect(lease).toMatchObject({ state: 'open', assignmentFence: 'Rjob-a#1', isolation: 'file-tools-only', adapter: 'agentfs' });
      expect(lease.sdk).toEqual({ version: AGENTFS_PINS.sdk, engineVersion: AGENTFS_PINS.engine });
      expect(await flaky.materialize(spec)).toEqual(lease);
      await expect(flaky.materialize({ ...spec, owner: 'worker-b' })).rejects.toMatchObject({ code: 'workspace_stale_assignment' });
    });

    test('a workspace whose database is missing or empty is refused, and a refused open lets go of its writer', async () => {
      const lease = await materialize('Rjob-a');
      const dir = workspaces.dir(projectId, 'Rjob-a');
      for (const name of await fs.readdir(dir)) if (name.startsWith(lease.delta)) await fs.rm(path.join(dir, name));
      await expect(workspaces.proposeOutputs(lease)).rejects.toMatchObject({ code: 'workspace_delta_mismatch' });
      await expect(workspaces.open(lease, { readable: () => true, write: true })).rejects.toMatchObject({ code: 'workspace_delta_mismatch' });
      await expect(fs.lstat(path.join(dir, 'writer.lock'))).rejects.toThrow();
      // An empty file is what Turso 0.4.4 leaves at a path it answers for from memory.
      await fs.writeFile(path.join(dir, lease.delta), '');
      await expect(workspaces.open(lease, { readable: () => true, write: true })).rejects.toMatchObject({ code: 'workspace_delta_mismatch' });
      await expect(fs.lstat(path.join(dir, 'writer.lock'))).rejects.toThrow();
    });

    test('a database made for another workspace is refused, even in a checkpoint whose own lists were made to match it', async () => {
      const a = await materialize('Rjob-a');
      const b = await materialize('Rjob-b');
      await edit(b, { 'Menu/Prices.md': SOUP_8 });
      const forged = path.join(base, 'forged');
      await workspaces.exportCheckpoint(a, forged);
      // B's database under A's name, with the checkpoint's lists rewritten to describe it. Only its binding is wrong.
      for (const name of await fs.readdir(path.join(forged, 'delta'))) await fs.rm(path.join(forged, 'delta', name));
      const from = workspaces.dir(projectId, 'Rjob-b');
      const files: { name: string; sha: string; bytes: number }[] = [];
      for (const name of (await fs.readdir(from)).filter((item) => item.startsWith(b.delta)).sort()) {
        const bytes = await fs.readFile(path.join(from, name));
        const renamed = `${a.delta}${name.slice(b.delta.length)}`;
        await fs.writeFile(path.join(forged, 'delta', renamed), bytes);
        files.push({ name: renamed, sha: sha256(bytes), bytes: bytes.byteLength });
      }
      const record = JSON.parse(await fs.readFile(path.join(forged, 'checkpoint.json'), 'utf8')) as { delta: unknown };
      record.delta = { files, entries: [{ path: 'Menu/Prices.md', sha: sha256(SOUP_8) }] };
      await fs.writeFile(path.join(forged, 'checkpoint.json'), JSON.stringify(record));
      const other = host('host-b');
      await expect(other.importCheckpoint(forged, job())).rejects.toMatchObject({
        code: 'checkpoint_incomplete',
        message: 'This checkpoint’s database does not hold the changes it lists.',
      });
      await expect(fs.lstat(other.dir(projectId, 'Rjob-a'))).rejects.toThrow();
    });

    test('a workspace made again for a job starts from its pinned base, even while this process still holds the old one’s database', async () => {
      const old = await materialize('Rjob-a');
      await edit(old, { 'Menu/Prices.md': SOUP_7 });
      // Another connection to the old database, still referenced: Turso 0.4.4 then keeps that database in memory by path.
      const held = await direct(old);
      expect((await held.fs.readFile('/Menu/Prices.md')).toString('utf8')).toBe(SOUP_7);
      await held.close();
      await workspaces.dispose(old);
      const fresh = await materialize('Rjob-a');
      expect(fresh.delta).not.toBe(old.delta);
      expect((await workspaces.proposeOutputs(fresh)).outputs.entries).toEqual([]);
      const opened = await session(fresh);
      expect(await opened.call('read_project_file', { path: 'Menu/Prices.md' })).toMatchObject({ found: true, text: PRICES });
      expect(await opened.call('write_file', { path: 'Menu/Fall.md', text: '# Fall\n\nSquash soup\n' })).toMatchObject({ proposed: false });
      await opened.close();
      expect((await workspaces.proposeOutputs(fresh)).outputs.entries).toMatchObject([{ path: 'Menu/Fall.md', op: 'modified' }]);
      expect((await fs.lstat(path.join(workspaces.dir(projectId, 'Rjob-a'), fresh.delta))).size).toBeGreaterThan(0);
    });

    test('a checkpoint opened again on the host it came from keeps its writes on disk, even while this process still holds the old database', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const copy = path.join(base, 'checkpoint');
      await workspaces.exportCheckpoint(lease, copy);
      // Another connection to the old database, still referenced, as in the test above.
      const held = await direct(lease);
      expect((await held.fs.readFile('/Menu/Prices.md')).toString('utf8')).toBe(SOUP_7);
      await held.close();
      await workspaces.dispose(lease);
      const back = await workspaces.importCheckpoint(copy, job());
      expect(back.delta).not.toBe(lease.delta);
      await edit(back, { 'Menu/Fall.md': '# Fall\n\nCider\n' });
      // What is on disk, copied under a name this process never opened, holds both changes.
      const dir = workspaces.dir(projectId, 'Rjob-a');
      const elsewhere = path.join(base, 'elsewhere');
      const name = 'delta-00000000000000ff.db';
      await fs.mkdir(elsewhere);
      for (const item of await fs.readdir(dir))
        if (item.startsWith(back.delta)) await fs.copyFile(path.join(dir, item), path.join(elsewhere, `${name}${item.slice(back.delta.length)}`));
      const reopened = await sdk.open({ path: path.join(elsewhere, name) });
      handles.push(reopened);
      expect((await reopened.fs.readFile('/Menu/Prices.md')).toString('utf8')).toBe(SOUP_7);
      expect((await reopened.fs.readFile('/Menu/Fall.md')).toString('utf8')).toBe('# Fall\n\nCider\n');
    });
  });

  /** Store a chunk size in a workspace's database, the way another program could: the SDK writes with whatever it finds. */
  async function storeChunkSize(lease: WorkspaceLease, value: string) {
    const handle = await direct(lease);
    const db = (handle.kv as unknown as { db?: { prepare(sql: string): { run(...values: unknown[]): Promise<unknown> } } }).db;
    if (db) await db.prepare("UPDATE fs_config SET value = ? WHERE key = 'chunk_size'").run(value);
    await handle.close();
    if (db) return;
    // The stand-in keeps its whole state in its file, its settings included.
    const file = path.join(workspaces.dir(projectId, lease.jobId), lease.delta);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { config?: Record<string, string> };
    saved.config = { ...saved.config, chunk_size: value };
    await fs.writeFile(file, JSON.stringify(saved));
  }
  /** A checkpoint's own record rewritten, the way someone crafting one could. */
  async function rewriteCheckpoint(folder: string, change: (record: { lease: Record<string, unknown> }) => void) {
    const file = path.join(folder, 'checkpoint.json');
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as { lease: Record<string, unknown> };
    change(record);
    await fs.writeFile(file, JSON.stringify(record));
  }

  describe('AUDIT-03: logical delta bytes are checked at host boundaries', () => {
    /** Database size metadata need not describe the bytes a read really returns. */
    const understateDeltaSizes = () => {
      const open = sdk.open.bind(sdk);
      vi.spyOn(sdk, 'open').mockImplementation(async (options) => {
        const handle = await open(options);
        const lstat = handle.fs.lstat.bind(handle.fs);
        vi.spyOn(handle.fs, 'lstat').mockImplementation(async (file) => {
          const stat = await lstat(file);
          return {
            size: 0,
            isFile: () => stat.isFile(),
            isDirectory: () => stat.isDirectory(),
            isSymbolicLink: () => stat.isSymbolicLink(),
          };
        });
        vi.spyOn(handle.fs, 'statfs').mockResolvedValue({ inodes: 1, bytesUsed: 0 });
        return handle;
      });
    };

    test('a delta at exactly its byte limit can be proposed and promoted', async () => {
      const lease = await materialize('Rjob-a', ['Menu'], { limits: { maxDeltaBytes: 64 } });
      const handle = await direct(lease);
      await handle.fs.writeFile('/Menu/A.md', 'a'.repeat(32));
      await handle.fs.writeFile('/Menu/B.md', 'b'.repeat(32));
      await handle.close();
      const { digest, outputs } = await workspaces.proposeOutputs(lease);
      expect(outputs.entries.map(({ path, bytes }) => ({ path, bytes }))).toEqual([
        { path: 'Menu/A.md', bytes: 32 },
        { path: 'Menu/B.md', bytes: 32 },
      ]);
      expect(outputs.dropped).toEqual([]);
      expect((await workspaces.promote(lease, request(digest))).applied.map((file) => file.path)).toEqual(['Menu/A.md', 'Menu/B.md']);
      expect(await read('Menu/A.md')).toBe('a'.repeat(32));
      expect(await read('Menu/B.md')).toBe('b'.repeat(32));
    });

    test.each([
      { label: 'changed pinned full bytes', path: '/Menu/Prices.md', text: SOUP_7 },
      { label: 'unchanged pinned bytes', path: '/Menu/Prices.md', text: PRICES },
      { label: 'out-of-scope bytes', path: '/Staff/Extra.md', text: SOUP_7 },
    ])('the aggregate budget counts $label before output filtering', async ({ path: extra, text }) => {
      // A one-byte edit to Prices would fit as a diff, but its whole-file copy does not.
      const lease = await materialize('Rjob-a', ['Menu'], { limits: { maxDeltaBytes: 33 } });
      await edit(lease, { 'Menu/Note.md': 'n'.repeat(32) });
      const { digest } = await workspaces.proposeOutputs(lease);
      const before = projectState();
      const written = vi.spyOn(store, 'writeRecorded');
      const handle = await direct(lease);
      await handle.fs.writeFile(extra, text);
      await handle.close();
      await expect(workspaces.proposeOutputs(lease)).rejects.toMatchObject({ code: 'workspace_budget' });
      await expect(workspaces.promote(lease, request(digest))).rejects.toMatchObject({ code: 'workspace_budget' });
      expect(written).not.toHaveBeenCalled();
      expect(projectState()).toEqual(before);
      expect(await read('Menu/Prices.md')).toBe(PRICES);
      await expect(fs.lstat(path.join(folder, 'Menu', 'Note.md'))).rejects.toThrow();
      expect((await workspaces.read(projectId, 'Rjob-a'))?.state).toBe('open');
    });

    test('understated SDK size metadata cannot hide an oversized delta from proposal or promotion', async () => {
      const lease = await materialize('Rjob-a', ['Menu'], { limits: { maxDeltaBytes: 64 } });
      await edit(lease, { 'Menu/A.md': 'a'.repeat(32) });
      const { digest } = await workspaces.proposeOutputs(lease);
      const handle = await direct(lease);
      await handle.fs.writeFile('/Menu/B.md', 'b'.repeat(33));
      await handle.close();
      understateDeltaSizes();
      const before = projectState();
      const written = vi.spyOn(store, 'writeRecorded');
      await expect(workspaces.proposeOutputs(lease)).rejects.toMatchObject({ code: 'workspace_budget' });
      await expect(workspaces.promote(lease, request(digest))).rejects.toMatchObject({ code: 'workspace_budget' });
      expect(written).not.toHaveBeenCalled();
      expect(projectState()).toEqual(before);
      expect(recorded()).toEqual([]);
    });

    test('actual bytes preserve the per-file limit when the SDK understates a file size', async () => {
      const lease = await materialize('Rjob-a', ['Menu'], { limits: { maxFileBytes: 64, maxDeltaBytes: 128 } });
      const handle = await direct(lease);
      await handle.fs.writeFile('/Menu/Big.md', 'b'.repeat(65));
      await handle.close();
      understateDeltaSizes();
      const { digest, outputs } = await workspaces.proposeOutputs(lease);
      expect(outputs.entries).toEqual([]);
      expect(outputs.dropped).toEqual([{ path: 'Menu/Big.md', reason: 'Larger than a workspace file may be.' }]);
      expect(await workspaces.promote(lease, request(digest))).toMatchObject({ applied: [] });
      expect(recorded()).toEqual([]);
      await expect(fs.lstat(path.join(folder, 'Menu', 'Big.md'))).rejects.toThrow();
    });

    test('import accepts exactly the host byte limit and refuses one extra byte before publishing an owner', async () => {
      const lease = await materialize('Rjob-a', ['Menu'], { limits: { maxDeltaBytes: WORKSPACE_LIMITS.maxDeltaBytes + 1 } });
      const handle = await direct(lease);
      const text = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 8; i++) await handle.fs.writeFile(`/Menu/Part-${i}.md`, text);
      await handle.close();
      const atLimit = path.join(base, 'at-limit');
      await workspaces.exportCheckpoint(lease, atLimit);
      const larger = await direct(lease);
      await larger.fs.writeFile('/Staff/Extra.md', 'x');
      await larger.close();
      const tooLarge = path.join(base, 'too-large');
      await workspaces.exportCheckpoint(lease, tooLarge);
      await rewriteCheckpoint(tooLarge, (record) => {
        record.lease.limits = { ...WORKSPACE_LIMITS, maxDeltaBytes: 1024 ** 4, maxDeltaDiskBytes: 1024 ** 4 };
      });
      understateDeltaSizes();
      const receiver = host('host-b');
      const moved = await receiver.importCheckpoint(atLimit, job());
      expect(moved.limits).toEqual(WORKSPACE_LIMITS);
      const accepted = await receiver.proposeOutputs(moved);
      expect(accepted.outputs.entries.map((file) => file.bytes)).toEqual(Array(8).fill(1024 * 1024));
      expect(accepted.outputs.dropped).toEqual([]);
      const refused = host('host-c');
      const before = projectState();
      await expect(refused.importCheckpoint(tooLarge, job())).rejects.toMatchObject({ code: 'workspace_budget' });
      expect(await refused.assignment(projectId, 'Rjob-a')).toBeNull();
      expect(await refused.read(projectId, 'Rjob-a')).toBeNull();
      await expect(fs.lstat(refused.dir(projectId, 'Rjob-a'))).rejects.toThrow();
      expect(projectState()).toEqual(before);
      // Refusal on a host with an existing workspace must preserve that workspace.
      await expect(receiver.importCheckpoint(tooLarge, job())).rejects.toMatchObject({ code: 'checkpoint_destination_used' });
      expect(await receiver.read(projectId, 'Rjob-a')).toEqual(moved);
      expect((await receiver.proposeOutputs(moved)).digest).toBe(accepted.digest);
    });
  });

  describe('a lease opens only the workspace it was given', () => {
    test('a lease for a workspace that was made again opens, hands back, copies and removes nothing of the new one', async () => {
      const old = await materialize('Rjob-a');
      await edit(old, { 'Menu/Prices.md': SOUP_7 });
      const { digest } = await workspaces.proposeOutputs(old);
      await workspaces.dispose(old);
      const fresh = await materialize('Rjob-a');
      await edit(fresh, { 'Menu/Fall.md': '# Fall\n\nCider\n' });
      // The old lease names the same job and the same owner's fence, and the job's folder now holds the new workspace.
      expect(fresh.assignmentFence).toBe(old.assignmentFence);
      for (const write of [true, false])
        await expect(workspaces.open(old, { readable: () => true, write })).rejects.toMatchObject({ code: 'workspace_replaced' });
      await expect(workspaces.proposeOutputs(old)).rejects.toMatchObject({ code: 'workspace_replaced' });
      await expect(workspaces.promote(old, request(digest))).rejects.toMatchObject({ code: 'workspace_replaced' });
      await expect(workspaces.observations(old)).rejects.toMatchObject({ code: 'workspace_replaced' });
      const copy = path.join(base, 'old-checkpoint');
      await expect(workspaces.exportCheckpoint(old, copy)).rejects.toMatchObject({ code: 'workspace_replaced' });
      await expect(fs.lstat(copy)).rejects.toThrow();
      await expect(workspaces.dispose(old)).rejects.toMatchObject({ code: 'workspace_replaced', message: expect.stringMatching(/so nothing was removed/) });
      expect(await workspaces.read(projectId, 'Rjob-a')).toEqual(fresh);
      expect((await workspaces.proposeOutputs(fresh)).outputs.entries).toEqual([
        expect.objectContaining({ path: 'Menu/Fall.md', after: sha256('# Fall\n\nCider\n') }),
      ]);
      expect(await read('Menu/Prices.md')).toBe(PRICES);
      expect(recorded()).toHaveLength(0);
    });

    test('tools that outlived their workspace write nothing into the next one and never let go of its writer', async () => {
      const old = await materialize('Rjob-a');
      const stale = await session(old);
      await workspaces.dispose(old);
      const fresh = await materialize('Rjob-a');
      const current = await session(fresh);
      expect(await stale.call('write_file', { path: 'Menu/Fall.md', text: '# Fall\n\nStale\n' })).toMatchObject({ code: 'workspace_replaced' });
      await stale.close();
      await expect(workspaces.open(fresh, { readable: () => true, write: true })).rejects.toMatchObject({ code: 'workspace_writer_busy' });
      expect(await current.call('write_file', { path: 'Menu/Fall.md', text: '# Fall\n\nCider\n' })).toMatchObject({ proposed: false });
      await current.close();
      expect((await workspaces.proposeOutputs(fresh)).outputs.entries).toEqual([
        expect.objectContaining({ path: 'Menu/Fall.md', after: sha256('# Fall\n\nCider\n') }),
      ]);
    });
  });

  describe('the Store’s lock', () => {
    /**
     * Workspaces whose sources, asked once during a hand-back, start another call and give it time to land. The hand-back
     * holds the Store's lock then, so a call that takes the lock waits, and one that does not lands first.
     */
    const during = (start: () => Promise<unknown>) => {
      let started: Promise<unknown> | null = null;
      const hooked = new AgentFsWorkspaces({
        store,
        sdk,
        freeBytes: async () => free,
        sources: {
          generation: async () => {
            if (!started) {
              started = start();
              started.catch(() => undefined);
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
            return grants;
          },
        },
      });
      return { hooked, started: () => started! };
    };

    test('a reassignment asked for during a hand-back waits for it, so the hand-back finishes as the owner that began it', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const { digest } = await workspaces.proposeOutputs(lease);
      const { hooked, started } = during(() => workspaces.reassign(projectId, 'Rjob-a', 'worker-b'));
      expect(await hooked.promote(lease, request(digest))).toMatchObject({ applied: [{ path: 'Menu/Prices.md', sha: sha256(SOUP_7) }] });
      expect(await started()).toBe('Rjob-a#2');
      expect(recorded()).toHaveLength(1);
      expect(await read('Menu/Prices.md')).toBe(SOUP_7);
    });

    test('a disposal asked for during a hand-back waits for it, then removes the spent workspace', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const { digest } = await workspaces.proposeOutputs(lease);
      const { hooked, started } = during(() => workspaces.dispose(lease));
      expect(await hooked.promote(lease, request(digest))).toMatchObject({ applied: [{ path: 'Menu/Prices.md', sha: sha256(SOUP_7) }] });
      await started();
      await expect(fs.lstat(workspaces.dir(projectId, 'Rjob-a'))).rejects.toThrow();
      expect(recorded()).toHaveLength(1);
    });

    test('an owner change another process makes on disk during a hand-back stops it before its write', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const { digest } = await workspaces.proposeOutputs(lease);
      // Another process gives the job to a new owner: its record changes on disk, outside this process's lock.
      const assignment = path.join(store.dataDir, 'projects', projectId, 'harness', 'workspace-assignments', 'Rjob-a.json');
      const moved = new AgentFsWorkspaces({
        store,
        sdk,
        freeBytes: async () => free,
        sources: {
          generation: async () => {
            await fs.writeFile(assignment, JSON.stringify({ v: 1, jobId: 'Rjob-a', generation: 2, owner: 'worker-b', at: 'elsewhere' }));
            return grants;
          },
        },
      });
      await expect(moved.promote(lease, request(digest))).rejects.toMatchObject({ code: 'workspace_stale_assignment' });
      expect(await read('Menu/Prices.md')).toBe(PRICES);
      expect(recorded()).toHaveLength(0);
      expect((await workspaces.read(projectId, 'Rjob-a'))?.state).toBe('open');
    });

    test('a write the Store fails partway through a hand-back makes the Store recover, and a retry finishes it with each change recorded once', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Fall.md': '# Fall\n\nCider\n', 'Menu/Prices.md': SOUP_7 });
      const { digest } = await workspaces.proposeOutputs(lease);
      const recover = vi.spyOn(store as unknown as { recoverAndReload(): Promise<void> }, 'recoverAndReload');
      const write = store.writeRecorded.bind(store);
      let calls = 0;
      vi.spyOn(store, 'writeRecorded').mockImplementation(async (...args) => {
        if (++calls === 2) throw new Error('the disk went away');
        return write(...args);
      });
      await expect(workspaces.promote(lease, request(digest))).rejects.toThrow('the disk went away');
      // The Store's own writer failed, so the Store reloaded what is on disk. The first change had landed.
      expect(recover).toHaveBeenCalledTimes(1);
      expect(await read('Menu/Fall.md')).toBe('# Fall\n\nCider\n');
      expect(await read('Menu/Prices.md')).toBe(PRICES);
      expect(recorded()).toHaveLength(1);
      expect((await workspaces.read(projectId, 'Rjob-a'))?.state).toBe('open');
      // A refusal leaves the Store as it was, so it reloads nothing.
      await expect(workspaces.promote(lease, request('another digest'))).rejects.toMatchObject({ code: 'workspace_outputs_changed' });
      expect(recover).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
      expect(await workspaces.promote(lease, request(digest))).toMatchObject({
        applied: [
          { path: 'Menu/Fall.md', sha: sha256('# Fall\n\nCider\n'), replayed: true, entryId: recorded()[0].id },
          { path: 'Menu/Prices.md', sha: sha256(SOUP_7), replayed: false },
        ],
      });
      expect(recorded()).toHaveLength(2);
      expect(await read('Menu/Prices.md')).toBe(SOUP_7);
      expect((await workspaces.read(projectId, 'Rjob-a'))?.state).toBe('promoted');
    });

    test('a write whose record names other bytes stops the hand-back without making the Store recover, and a retry finds what landed', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const { digest } = await workspaces.proposeOutputs(lease);
      const recover = vi.spyOn(store as unknown as { recoverAndReload(): Promise<void> }, 'recoverAndReload');
      const write = store.writeRecorded.bind(store);
      // The write lands, and the record it returns names other bytes than it was given.
      vi.spyOn(store, 'writeRecorded').mockImplementation(async (...args) => {
        const written = await write(...args);
        return { ...written, files: written.files.map((file) => ({ ...file, after: '0'.repeat(64) })) };
      });
      await expect(workspaces.promote(lease, request(digest))).rejects.toMatchObject({ code: 'workspace_receipt_mismatch' });
      // The Store's state agrees with its files, so it reloads nothing and interrupts no approval waiting elsewhere.
      expect(recover).not.toHaveBeenCalled();
      expect((await workspaces.read(projectId, 'Rjob-a'))?.state).toBe('open');
      vi.restoreAllMocks();
      expect(await workspaces.promote(lease, request(digest))).toMatchObject({
        applied: [{ path: 'Menu/Prices.md', sha: sha256(SOUP_7), replayed: true, entryId: recorded()[0].id }],
      });
      expect(recorded()).toHaveLength(1);
    });
  });

  describe('a checkpoint opens only as the job it was asked for', () => {
    test('a checkpoint is refused as another job or in another project, and leaves no owner behind', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const out = path.join(base, 'checkpoint');
      await workspaces.exportCheckpoint(lease, out);
      const other = host('host-b');
      await expect(other.importCheckpoint(out, job('worker-a', 'Rjob-b'))).rejects.toMatchObject({ code: 'checkpoint_other_job' });
      const cafe = await store.locked(() => store.createProject('Cafe'));
      await expect(other.importCheckpoint(out, { projectId: cafe.id, jobId: 'Rjob-a', owner: 'worker-a' })).rejects.toMatchObject({
        code: 'checkpoint_other_job',
      });
      for (const [id, jobId] of [
        [projectId, 'Rjob-a'],
        [projectId, 'Rjob-b'],
        [cafe.id, 'Rjob-a'],
      ] as const) {
        expect(await other.assignment(id, jobId)).toBeNull();
        await expect(fs.lstat(other.dir(id, jobId))).rejects.toThrow();
      }
      // A record rewritten to name the job asked for still holds another job's list of files and database.
      const renamed = path.join(base, 'renamed');
      await fs.cp(out, renamed, { recursive: true });
      await rewriteCheckpoint(renamed, (record) => {
        record.lease.jobId = 'Rjob-b';
        record.lease.assignmentFence = 'Rjob-b#1';
      });
      await expect(other.importCheckpoint(renamed, job('worker-a', 'Rjob-b'))).rejects.toMatchObject({
        code: 'checkpoint_incomplete',
        message: 'This checkpoint’s list of files was made for another workspace, so it cannot be opened as this one.',
      });
      expect(await other.assignment(projectId, 'Rjob-b')).toBeNull();
      expect(await other.importCheckpoint(out, job())).toMatchObject({ projectId, jobId: 'Rjob-a', assignmentFence: 'Rjob-a#1' });
    });

    test('a checkpoint’s owner must be one this host reads, and the owner this host has for the job', async () => {
      const lease = await materialize('Rjob-a');
      const out = path.join(base, 'checkpoint');
      await workspaces.exportCheckpoint(lease, out);
      for (const fence of ['Rjob-a#0', 'Rjob-a#01', 'Rjob-a#x', 'Rjob-a', 'Rjob-b#1', 'Rjob-a#1#2']) {
        const copy = path.join(base, `fence-${fence.replace(/[^a-z0-9]/gi, '_')}`);
        await fs.cp(out, copy, { recursive: true });
        await rewriteCheckpoint(copy, (record) => {
          record.lease.assignmentFence = fence;
        });
        await expect(host('host-b').importCheckpoint(copy, job())).rejects.toMatchObject({ code: 'checkpoint_incomplete' });
      }
      expect(await host('host-b').assignment(projectId, 'Rjob-a')).toBeNull();
      // Where the job already belongs to worker-b at the same generation, worker-a opens nothing.
      const other = host('host-c');
      expect(await other.reassign(projectId, 'Rjob-a', 'worker-b')).toBe('Rjob-a#1');
      await expect(other.importCheckpoint(out, job('worker-a'))).rejects.toMatchObject({ code: 'workspace_stale_assignment' });
      await expect(fs.lstat(other.dir(projectId, 'Rjob-a'))).rejects.toThrow();
      expect(await other.importCheckpoint(out, job('worker-b'))).toMatchObject({ assignmentFence: 'Rjob-a#1' });
    });

    test('an owner made for a checkpoint whose workspace could not be written is taken back', async () => {
      const lease = await materialize('Rjob-a');
      const out = path.join(base, 'checkpoint');
      await workspaces.exportCheckpoint(lease, out);
      const other = host('host-b');
      const target = path.join(other.dir(projectId, 'Rjob-a'), 'lease.json');
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (path.resolve(String(to)) === target) throw Object.assign(new Error('EIO: refused by the test'), { code: 'EIO' });
        return rename(from, to);
      });
      await expect(other.importCheckpoint(out, job())).rejects.toMatchObject({ code: 'EIO' });
      expect(await other.assignment(projectId, 'Rjob-a')).toBeNull();
      await expect(fs.lstat(other.dir(projectId, 'Rjob-a'))).rejects.toThrow();
      vi.restoreAllMocks();
      // The job is still free on this host, so another owner can open it.
      expect(await other.importCheckpoint(out, job('worker-b'))).toMatchObject({ assignmentFence: 'Rjob-a#1' });
    });

    test('a checkpoint uses this host\'s limits, and oversized base metadata is refused before copying', async () => {
      const lease = await materialize('Rjob-a', ['Menu'], { limits: { maxDeltaBytes: 300 * 1024 } });
      await edit(lease, { 'Menu/Prices.md': SOUP_7 });
      const out = path.join(base, 'checkpoint');
      await workspaces.exportCheckpoint(lease, out);
      // The limits a checkpoint carries are only its own say.
      const raised = path.join(base, 'raised');
      await fs.cp(out, raised, { recursive: true });
      await rewriteCheckpoint(raised, (record) => {
        record.lease.limits = { ...WORKSPACE_LIMITS, maxDeltaBytes: 1024 ** 4, maxDeltaDiskBytes: 1024 ** 4, diskHeadroomBytes: 0 };
      });
      expect((await host('host-b').importCheckpoint(raised, job())).limits).toEqual(WORKSPACE_LIMITS);
      // A list of pinned files larger than this host allows is refused whole, before anything is read or copied.
      const large = path.join(base, 'large');
      await fs.cp(out, large, { recursive: true });
      const list = JSON.parse(await fs.readFile(path.join(large, 'base.json'), 'utf8')) as { files: { bytes: number }[] };
      list.files[0].bytes = WORKSPACE_LIMITS.maxFileBytes + 1;
      const listBytes = Buffer.from(JSON.stringify(list, null, 2), 'utf8');
      await fs.writeFile(path.join(large, 'base.json'), listBytes);
      await rewriteCheckpoint(large, (record) => {
        record.lease.baseManifestRef = sha256(listBytes);
      });
      await expect(host('host-c').importCheckpoint(large, job())).rejects.toMatchObject({ code: 'workspace_too_large' });
      await expect(fs.lstat(host('host-c').dir(projectId, 'Rjob-a'))).rejects.toThrow();
    });

    test('a checkpoint is copied only from closed tools into an empty folder, and opened only where the job has no newer owner or workspace', async () => {
      const lease = await materialize('Rjob-a');
      const opened = await session(lease);
      await opened.call('write_file', { path: 'Menu/Prices.md', text: SOUP_7 });
      const out = path.join(base, 'checkpoint');
      await expect(workspaces.exportCheckpoint(lease, out)).rejects.toMatchObject({ code: 'workspace_writer_open' });
      await expect(fs.lstat(out)).rejects.toThrow();
      await opened.close();
      await fs.mkdir(out);
      await fs.writeFile(path.join(out, 'note.txt'), 'kept\n');
      await expect(workspaces.exportCheckpoint(lease, out)).rejects.toMatchObject({ code: 'checkpoint_destination_used' });
      expect(await fs.readdir(out)).toEqual(['note.txt']);
      await fs.rm(path.join(out, 'note.txt'));
      expect(await workspaces.exportCheckpoint(lease, out)).toMatchObject({ entries: 1 });
      // A host where the job moved on to a newer owner opens nothing of it.
      const newer = host('host-b');
      await newer.reassign(projectId, 'Rjob-a', 'worker-a');
      expect(await newer.reassign(projectId, 'Rjob-a', 'worker-a')).toBe('Rjob-a#2');
      await expect(newer.importCheckpoint(out, job())).rejects.toMatchObject({ code: 'workspace_stale_assignment' });
      await expect(fs.lstat(newer.dir(projectId, 'Rjob-a'))).rejects.toThrow();
      // A host that already has a workspace for the job keeps it.
      const busy = host('host-c');
      const imported = await busy.importCheckpoint(out, job());
      await expect(busy.importCheckpoint(out, job())).rejects.toMatchObject({ code: 'checkpoint_destination_used' });
      expect(await busy.read(projectId, 'Rjob-a')).toEqual(imported);
    });

    test('a second checkpoint opened for a job while one is being opened is refused, and the first’s workspace stays whole', async () => {
      const first = await materialize('Rjob-a', ['Menu']);
      await edit(first, { 'Menu/Prices.md': SOUP_7 });
      const one = path.join(base, 'checkpoint-1');
      await workspaces.exportCheckpoint(first, one);
      // The same job and owner, made again over another base, so the two checkpoints' lists of files differ.
      await workspaces.dispose(first);
      const again = await materialize('Rjob-a', ['Staff']);
      expect(again.assignmentFence).toBe(first.assignmentFence);
      expect(again.baseManifestRef).not.toBe(first.baseManifestRef);
      const two = path.join(base, 'checkpoint-2');
      await workspaces.exportCheckpoint(again, two);
      // The second import starts when the first reserves its disk space, after the first's checks passed, and runs to its end.
      const race: { second?: Promise<WorkspaceLease> } = {};
      const racing: AgentFsWorkspaces = new AgentFsWorkspaces({
        store,
        sdk,
        sources: { generation: () => grants },
        dataDir: path.join(base, 'host-b'),
        freeBytes: async () => {
          if (!race.second) {
            race.second = racing.importCheckpoint(two, job());
            await race.second.catch(() => undefined);
          }
          return free;
        },
      });
      const opened = await racing.importCheckpoint(one, job());
      await expect(race.second).rejects.toMatchObject({ code: 'checkpoint_destination_used' });
      expect(await racing.read(projectId, 'Rjob-a')).toEqual(opened);
      // Nothing of the refused import is in the job's folder, and the first's own files and changes open.
      const deltas = (await fs.readdir(racing.dir(projectId, 'Rjob-a'))).filter((name) => name.startsWith('delta-'));
      expect(deltas).toContain(opened.delta);
      expect(deltas.filter((name) => !name.startsWith(opened.delta))).toEqual([]);
      const reader = await session(opened, { write: false, on: racing });
      expect(await reader.call('read_project_file', { path: 'Menu/Fall.md' })).toMatchObject({ found: true, text: '# Fall\n' });
      await reader.close();
      expect((await racing.proposeOutputs(opened)).outputs.entries).toMatchObject([{ path: 'Menu/Prices.md', after: sha256(SOUP_7) }]);
    });

    test('a checkpoint opens only where the same people may read its files as when they were pinned', async () => {
      const lease = await materialize('Rjob-a');
      const out = path.join(base, 'checkpoint');
      await workspaces.exportCheckpoint(lease, out);
      grants = 'grants-2';
      const other = host('host-b');
      await expect(other.importCheckpoint(out, job())).rejects.toMatchObject({ code: 'workspace_source_changed' });
      expect(await other.assignment(projectId, 'Rjob-a')).toBeNull();
      await expect(fs.lstat(other.dir(projectId, 'Rjob-a'))).rejects.toThrow();
      grants = 'grants-1';
      expect(await other.importCheckpoint(out, job())).toMatchObject({ sourceGeneration: 'grants-1' });
    });

    test('a checkpoint file changed after it was checked is refused as it is copied, and nothing of the copy is kept', async () => {
      const lease = await materialize('Rjob-a');
      const out = path.join(base, 'checkpoint');
      await workspaces.exportCheckpoint(lease, out);
      // The pinned copy of the price list changes on disk once the import's checks have passed, before it is copied.
      let changed = false;
      const other = new AgentFsWorkspaces({
        store,
        sdk,
        sources: { generation: () => grants },
        dataDir: path.join(base, 'host-b'),
        freeBytes: async () => {
          if (!changed) {
            changed = true;
            await fs.writeFile(path.join(out, 'base', sha256(PRICES)), SOUP_8);
          }
          return free;
        },
      });
      await expect(other.importCheckpoint(out, job())).rejects.toMatchObject({
        code: 'checkpoint_incomplete',
        message: 'This checkpoint changed while it was being opened.',
      });
      expect(changed).toBe(true);
      expect(await other.assignment(projectId, 'Rjob-a')).toBeNull();
      await expect(fs.lstat(other.dir(projectId, 'Rjob-a'))).rejects.toThrow();
    });

    test('a checkpoint is never copied into app data or a project’s folder, even through a link', async () => {
      const lease = await materialize('Rjob-a');
      for (const inside of [path.join(store.dataDir, 'checkpoint'), store.dataDir, path.join(folder, 'checkpoint'), path.join(folder, 'Menu')])
        await expect(workspaces.exportCheckpoint(lease, inside)).rejects.toMatchObject({ code: 'checkpoint_destination_refused' });
      const link = path.join(base, 'link');
      await fs.symlink(folder, link, 'junction');
      try {
        await expect(workspaces.exportCheckpoint(lease, path.join(link, 'checkpoint'))).rejects.toMatchObject({
          code: 'checkpoint_destination_refused',
        });
      } finally {
        await fs.unlink(link);
      }
      await expect(fs.lstat(path.join(folder, 'checkpoint'))).rejects.toThrow();
      await expect(fs.lstat(path.join(store.dataDir, 'checkpoint'))).rejects.toThrow();
      expect(await workspaces.exportCheckpoint(lease, path.join(base, 'checkpoint'))).toMatchObject({ entries: 0 });
    });
  });

  describe('asking for a workspace again', () => {
    test('returns the same workspace only for the same scope and limits', async () => {
      const lease = await materialize('Rjob-a', ['Menu']);
      for (const [scope, extra] of [
        [null, {}],
        [['Menu', 'Staff'], {}],
        [['Staff'], {}],
        [['Menu'], { limits: { maxDeltaBytes: 1024 } }],
      ] as const)
        await expect(materialize('Rjob-a', scope, extra)).rejects.toMatchObject({ code: 'workspace_spec_changed' });
      expect(await materialize('Rjob-a', ['Menu'])).toEqual(lease);
      expect(await materialize('Rjob-a', ['Menu'], { limits: { ...WORKSPACE_LIMITS } })).toEqual(lease);
    });
  });

  describe('reviewing and keeping changes', () => {
    test('changes are listed in the same order on every host, by the code units of their names', async () => {
      const lease = await materialize('Rjob-a');
      await edit(lease, { 'Menu/a.md': '# a\n', 'Menu/B.md': '# B\n', 'Menu/_.md': '# _\n' });
      const { outputs } = await workspaces.proposeOutputs(lease);
      // A locale's order would put these as _, a, B, and another locale could put them otherwise.
      expect(outputs.entries.map((entry) => entry.path)).toEqual(['Menu/B.md', 'Menu/_.md', 'Menu/a.md']);
    });

    test('a spent workspace still opens to read, so a change left waiting can be reviewed by its sha', async () => {
      const lease = await materialize('Rjob-a');
      const opened = await session(lease);
      await opened.call('propose_file', { path: 'Menu/Fall.md', text: '# Fall\n\nPumpkin soup\n' });
      await opened.close();
      const { digest } = await workspaces.proposeOutputs(lease);
      const { waiting } = await workspaces.promote(lease, request(digest));
      expect(waiting).toEqual([
        { path: 'Menu/Fall.md', reason: 'the sub-task asked for a person to decide it', before: sha256('# Fall\n'), after: sha256('# Fall\n\nPumpkin soup\n') },
      ]);
      const reader = await session(lease, { write: false });
      expect(await reader.call('read_project_file', { path: 'Menu/Fall.md' })).toMatchObject({
        found: true,
        sha: waiting[0].after,
        text: '# Fall\n\nPumpkin soup\n',
      });
      await reader.close();
      await expect(workspaces.open(lease, { readable: () => true, write: true })).rejects.toMatchObject({ code: 'workspace_spent' });
      expect(await read('Menu/Fall.md')).toBe('# Fall\n');
    });

    test('a file written into the database outside the scope is refused by the tools and dropped on hand-back', async () => {
      const lease = await materialize('Rjob-a', ['Menu']);
      const opened = await session(lease);
      expect(await opened.call('write_file', { path: 'Staff/Rota.md', text: '# Rota\n\nMon: Bo\n' })).toMatchObject({ refused: expect.any(String) });
      await opened.close();
      const handle = await direct(lease);
      await handle.fs.writeFile('/Staff/Rota.md', '# Rota\n\nMon: Bo\n');
      await handle.fs.writeFile('/Menu/Prices.md', SOUP_7);
      await handle.close();
      const { digest, outputs } = await workspaces.proposeOutputs(lease);
      expect(outputs.entries.map((entry) => entry.path)).toEqual(['Menu/Prices.md']);
      expect(outputs.dropped).toEqual([{ path: 'Staff/Rota.md', reason: 'Outside the scope this sub-task was given.' }]);
      expect(await workspaces.promote(lease, request(digest))).toMatchObject({ applied: [{ path: 'Menu/Prices.md' }], dropped: outputs.dropped });
      expect(await read('Staff/Rota.md')).toBe(ROTA);
    });

    test('a file written into the database under a name the project holds as a file is dropped on hand-back', async () => {
      const lease = await materialize('Rjob-a', ['Menu']);
      // The tools refuse this name. Another program writing the database directly does not ask them.
      const handle = await direct(lease);
      await handle.fs.writeFile('/Menu/Prices.md/Notes.md', '# Notes\n');
      await handle.close();
      const { outputs } = await workspaces.proposeOutputs(lease);
      expect(outputs.entries).toEqual([]);
      expect(outputs.dropped).toEqual([{ path: 'Menu/Prices.md/Notes.md', reason: 'A file and a folder would have the same name in the project.' }]);
    });

    test('a pinned file or the list of them changed on disk is refused, never read as another, and a failed copy leaves nothing', async () => {
      const lease = await materialize('Rjob-a');
      const dir = workspaces.dir(projectId, 'Rjob-a');
      await fs.writeFile(path.join(dir, 'base', sha256(PRICES)), SOUP_8);
      const reader = await session(lease, { write: false });
      expect(await reader.call('read_project_file', { path: 'Menu/Prices.md' })).toMatchObject({
        refused: 'The pinned copy of this file is missing or damaged, so it was not read.',
      });
      await reader.close();
      // A copy that fails partway takes back what it wrote: a folder it made goes, and one it was given is left empty.
      const made = path.join(base, 'made');
      await expect(workspaces.exportCheckpoint(lease, made)).rejects.toMatchObject({ code: 'workspace_base_changed' });
      await expect(fs.lstat(made)).rejects.toThrow();
      const given = path.join(base, 'given');
      await fs.mkdir(given);
      await expect(workspaces.exportCheckpoint(lease, given)).rejects.toMatchObject({ code: 'workspace_base_changed' });
      expect(await fs.readdir(given)).toEqual([]);
      const list = path.join(dir, 'base.json');
      await fs.writeFile(list, (await fs.readFile(list, 'utf8')).replace('Menu/Fall.md', 'Menu/Fail.md'));
      for (const write of [true, false])
        await expect(workspaces.open(lease, { readable: () => true, write })).rejects.toMatchObject({ code: 'workspace_base_changed' });
      await expect(fs.lstat(path.join(dir, 'writer.lock'))).rejects.toThrow();
      await expect(workspaces.proposeOutputs(lease)).rejects.toMatchObject({ code: 'workspace_base_changed' });
      await expect(workspaces.promote(lease, request('any'))).rejects.toMatchObject({ code: 'workspace_base_changed' });
      expect(recorded()).toHaveLength(0);
    });

    test('a database that stores another chunk size than the SDK’s own is refused before it is used', async () => {
      const lease = await materialize('Rjob-a');
      await storeChunkSize(lease, '1');
      await expect(workspaces.open(lease, { readable: () => true, write: true })).rejects.toMatchObject({ code: 'workspace_delta_settings' });
      await expect(fs.lstat(path.join(workspaces.dir(projectId, 'Rjob-a'), 'writer.lock'))).rejects.toThrow();
      await expect(workspaces.proposeOutputs(lease)).rejects.toMatchObject({ code: 'workspace_delta_settings' });
      await storeChunkSize(lease, '4096');
      expect((await workspaces.proposeOutputs(lease)).outputs.entries).toEqual([]);
    });

    test('a database bound to the same job and base in another project is refused', async () => {
      const lease = await materialize('Rjob-a');
      const handle = await direct(lease);
      expect(await handle.kv.get('nectovia:workspace')).toEqual({ projectId, jobId: 'Rjob-a', baseManifestRef: lease.baseManifestRef });
      await handle.kv.set('nectovia:workspace', { projectId: 'Pother', jobId: 'Rjob-a', baseManifestRef: lease.baseManifestRef });
      await handle.close();
      await expect(workspaces.proposeOutputs(lease)).rejects.toMatchObject({ code: 'workspace_delta_mismatch' });
    });
  });

  describe('pinning a base', () => {
    describe('source-generation binding', () => {
      test('a same-scope generation validated while pinning is retained, so later read-rights drift refuses promotion', async () => {
        let reads = 0;
        workspaces = new AgentFsWorkspaces({
          store,
          sdk,
          sources: {
            generation: () => {
              // The first two snapshots agree. Any later snapshot observes changed rights.
              if (++reads > 2) grants = 'grants-2';
              return grants;
            },
          },
          freeBytes: async () => free,
        });
        const lease = await materialize('Rjob-a');
        await edit(lease, { 'Menu/Prices.md': SOUP_7 });
        const proposal = await workspaces.proposeOutputs(lease);
        await expect(workspaces.promote(lease, request(proposal.digest))).rejects.toMatchObject({ code: 'workspace_source_changed' });
        expect(lease.sourceGeneration).toBe('grants-1');
        expect(await read('Menu/Prices.md')).toBe(PRICES);
        expect(recorded()).toHaveLength(0);
      });

      test('rights that drift while the generation for a guarded-path subset is captured make no workspace', async () => {
        const current = store.currentBytes.bind(store);
        vi.spyOn(store, 'currentBytes').mockImplementation(async (id, relative) => {
          if (relative === 'Menu/Fall.md') throw new ApiError(403, 'The test path guard refused this file.');
          return current(id, relative);
        });
        workspaces = new AgentFsWorkspaces({
          store,
          sdk,
          sources: {
            generation: (_id, paths) => {
              // Digests differ by path set even when rights agree. Capturing the subset moves its rights on.
              if (paths.length === 1) grants = 'grants-2';
              return `${grants}:${[...paths].sort().join('|')}`;
            },
          },
          freeBytes: async () => free,
        });
        await expect(materialize('Rjob-a')).rejects.toMatchObject({ code: 'workspace_source_changed' });
        await expect(fs.lstat(workspaces.dir(projectId, 'Rjob-a'))).rejects.toThrow();
        expect(recorded()).toHaveLength(0);
      });

      test('a stable subset keeps its own generation and can promote when a listed file disappeared before pinning', async () => {
        let first = true;
        workspaces = new AgentFsWorkspaces({
          store,
          sdk,
          sources: {
            generation: async (_id, paths) => {
              if (first) {
                first = false;
                await fs.rm(path.join(folder, 'Menu', 'Fall.md'));
              }
              return `${grants}:${[...paths].sort().join('|')}`;
            },
          },
          freeBytes: async () => free,
        });
        const lease = await materialize('Rjob-a');
        expect(lease.sourceGeneration).toBe('grants-1:Menu/Prices.md');
        const reader = await session(lease, { write: false });
        expect(await reader.call('list_project_files', {})).toMatchObject({ files: ['Menu/Prices.md'] });
        expect(await reader.call('read_project_file', { path: 'Menu/Prices.md' })).toMatchObject({ found: true, text: PRICES });
        await reader.close();
        await edit(lease, { 'Menu/Prices.md': SOUP_7 });
        const proposal = await workspaces.proposeOutputs(lease);
        expect(await workspaces.promote(lease, request(proposal.digest))).toMatchObject({
          applied: [{ path: 'Menu/Prices.md', sha: sha256(SOUP_7), replayed: false }],
          conflicts: [],
          waiting: [],
        });
        expect(await read('Menu/Prices.md')).toBe(SOUP_7);
        expect(recorded()).toHaveLength(1);
      });
    });

    test('a change in who may read the scope while its files are pinned makes no workspace', async () => {
      // Read rights change while the files are being read.
      const current = store.currentBytes.bind(store);
      vi.spyOn(store, 'currentBytes').mockImplementation(async (id, relative) => {
        grants = 'grants-2';
        return current(id, relative);
      });
      await expect(materialize('Rjob-a')).rejects.toMatchObject({ code: 'workspace_source_changed' });
      await expect(fs.lstat(workspaces.dir(projectId, 'Rjob-a'))).rejects.toThrow();
      vi.restoreAllMocks();
      expect(await materialize('Rjob-a')).toMatchObject({ state: 'open', sourceGeneration: 'grants-2' });
    });

    test('a file that cannot be read while it is pinned stops the workspace, and is never left out of it', async () => {
      const current = store.currentBytes.bind(store);
      vi.spyOn(store, 'currentBytes').mockImplementation(async (id, relative) => {
        if (relative === 'Menu/Fall.md') throw Object.assign(new Error('EIO: refused by the test'), { code: 'EIO' });
        return current(id, relative);
      });
      await expect(materialize('Rjob-a')).rejects.toMatchObject({ code: 'EIO' });
      // Not a refusal, so the workspace is left being made, and the next call makes it again.
      expect((await workspaces.read(projectId, 'Rjob-a'))?.state).toBe('materializing');
      vi.restoreAllMocks();
      const lease = await materialize('Rjob-a');
      const reader = await session(lease, { write: false });
      expect(await reader.call('read_project_file', { path: 'Menu/Fall.md' })).toMatchObject({ found: true, text: '# Fall\n' });
    });
  });
}

describe('AgentFS workspaces on the stand-in for agentfs-sdk 0.6.4', () => conformance(async () => agentFsDouble()));
describe.skipIf(!realModules)('AgentFS workspaces on the installed agentfs-sdk 0.6.4', () => conformance(() => loadAgentFsSdk(realModules!)));

describe('loading the SDK', () => {
  const loaderOverrides = ['NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI'] as const;
  let dir: string, modules: string;
  beforeEach(async () => {
    for (const name of loaderOverrides) vi.stubEnv(name, undefined);
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentfs-pins-')));
    modules = path.join(dir, 'node_modules');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });
  /** A qualified platform with no loader override, whatever machine runs the test. */
  const qualified = { env: {}, platform: 'win32', arch: 'x64' } as const;
  const NATIVE = 'turso.win32-x64-msvc.node';
  const pkg = async (folder: string, name: string, version: string) => {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name, version }));
  };

  test.each(loaderOverrides)('a caller\'s %s loader override is refused before anything is read, including an empty string', async (name) => {
    const missing = path.join(dir, 'missing');
    await expect(loadAgentFsSdk(missing, { ...qualified, env: { [name]: 'test-loader-override' } })).rejects.toMatchObject({
      code: 'agentfs_loader_override',
    });
    await expect(loadAgentFsSdk(missing, { ...qualified, env: { [name]: '' } })).rejects.toMatchObject({ code: 'agentfs_loader_override' });
  });

  describe.each(loaderOverrides)('this process\'s %s loader override', (name) => {
    test.each([
      { label: 'a nonempty value', value: 'test-loader-override' },
      { label: 'an empty string', value: '' },
    ])('cannot be hidden by an omitted or undefined caller option ($label)', async ({ value }) => {
      const missing = path.join(dir, 'missing');
      vi.stubEnv(name, value);
      await expect(loadAgentFsSdk(missing, { platform: qualified.platform, arch: qualified.arch })).rejects.toMatchObject({
        code: 'agentfs_loader_override',
      });
      await expect(loadAgentFsSdk(missing, qualified)).rejects.toMatchObject({ code: 'agentfs_loader_override' });
      await expect(loadAgentFsSdk(missing, { ...qualified, env: { [name]: undefined } })).rejects.toMatchObject({
        code: 'agentfs_loader_override',
      });
    });
  });

  test('absent loader overrides still reach the SDK pin checks when the caller explicitly passes undefined', async () => {
    await expect(
      loadAgentFsSdk(path.join(dir, 'missing'), {
        ...qualified,
        env: { NAPI_RS_NATIVE_LIBRARY_PATH: undefined, NAPI_RS_FORCE_WASI: undefined },
      }),
    ).rejects.toMatchObject({ code: 'agentfs_not_pinned' });
  });

  test('only a platform the pins were qualified on loads', async () => {
    await expect(loadAgentFsSdk(modules, { env: {}, platform: 'linux', arch: 'x64' })).rejects.toMatchObject({
      code: 'agentfs_platform_unqualified',
      message: expect.stringMatching(/qualified on win32-x64 only, and this is linux-x64/),
    });
    await expect(loadAgentFsSdk(modules, { env: {}, platform: 'win32', arch: 'arm64' })).rejects.toMatchObject({ code: 'agentfs_platform_unqualified' });
  });

  test('only the pinned SDK on the pinned engine, found the way Node finds it, is loaded', async () => {
    await expect(loadAgentFsSdk(modules, qualified)).rejects.toMatchObject({
      code: 'agentfs_not_pinned',
      message: expect.stringMatching(/and no agentfs-sdk is installed there/),
    });
    await pkg(path.join(modules, 'agentfs-sdk'), 'agentfs-sdk', '0.6.3');
    await expect(loadAgentFsSdk(modules, qualified)).rejects.toMatchObject({ message: expect.stringMatching(/and agentfs-sdk 0\.6\.3 is installed there/) });
    await pkg(path.join(modules, 'agentfs-sdk'), 'agentfs-sdk', '0.6.4');
    await expect(loadAgentFsSdk(modules, qualified)).rejects.toMatchObject({
      message: expect.stringMatching(/must run on @tursodatabase\/database 0\.4\.4, and none resolves there/),
    });
    await pkg(path.join(modules, '@tursodatabase', 'database'), '@tursodatabase/database', '0.4.4');
    await pkg(path.join(modules, 'agentfs-sdk', 'node_modules', '@tursodatabase', 'database'), '@tursodatabase/database', '0.8.2');
    // The copy beside the SDK's own files is the one Node would load.
    await expect(loadAgentFsSdk(modules, qualified)).rejects.toMatchObject({
      message: expect.stringMatching(/@tursodatabase\/database 0\.4\.4, and 0\.8\.2 resolves there/),
    });
  });

  test('the engine’s own imports and the native file its loader loads must be the pinned ones too', async () => {
    const nested = path.join(modules, 'agentfs-sdk', 'node_modules', '@tursodatabase');
    await pkg(path.join(modules, 'agentfs-sdk'), 'agentfs-sdk', '0.6.4');
    await pkg(path.join(nested, 'database'), '@tursodatabase/database', '0.4.4');
    // A native file beside the engine's loader is the first one it tries.
    await fs.writeFile(path.join(nested, 'database', NATIVE), 'stray');
    await expect(loadAgentFsSdk(modules, qualified)).rejects.toMatchObject({
      code: 'agentfs_not_pinned',
      message: expect.stringMatching(/turso\.win32-x64-msvc\.node beside the engine’s loader would be loaded instead of the pinned native file/),
    });
    await fs.rm(path.join(nested, 'database', NATIVE));
    await expect(loadAgentFsSdk(modules, qualified)).rejects.toMatchObject({
      message: expect.stringMatching(/@tursodatabase\/database-common 0\.4\.4, and none resolves there/),
    });
    // The newer engine's packages beside the SDK are what a plain install of the newest engine leaves there.
    await pkg(path.join(modules, '@tursodatabase', 'database-common'), '@tursodatabase/database-common', '0.8.2');
    await expect(loadAgentFsSdk(modules, qualified)).rejects.toMatchObject({
      message: expect.stringMatching(/@tursodatabase\/database-common 0\.4\.4, and 0\.8\.2 resolves there/),
    });
    await pkg(path.join(nested, 'database-common'), '@tursodatabase/database-common', '0.4.4');
    await expect(loadAgentFsSdk(modules, qualified)).rejects.toMatchObject({
      message: expect.stringMatching(/@tursodatabase\/database-win32-x64-msvc 0\.4\.4, and none resolves there/),
    });
    await pkg(path.join(modules, '@tursodatabase', 'database-win32-x64-msvc'), '@tursodatabase/database-win32-x64-msvc', '0.8.2');
    await expect(loadAgentFsSdk(modules, qualified)).rejects.toMatchObject({
      message: expect.stringMatching(/@tursodatabase\/database-win32-x64-msvc 0\.4\.4, and 0\.8\.2 resolves there/),
    });
    await pkg(path.join(nested, 'database-win32-x64-msvc'), '@tursodatabase/database-win32-x64-msvc', '0.4.4');
    await expect(loadAgentFsSdk(modules, qualified)).rejects.toMatchObject({
      message: expect.stringMatching(/turso\.win32-x64-msvc\.node in @tursodatabase\/database-win32-x64-msvc 0\.4\.4 is missing, not the pinned 30f92ca6/),
    });
    await fs.writeFile(path.join(nested, 'database-win32-x64-msvc', NATIVE), 'not the engine');
    await expect(loadAgentFsSdk(modules, qualified)).rejects.toMatchObject({
      message: expect.stringContaining(`is sha256 ${sha256('not the engine')}, not the pinned 30f92ca6`),
    });
  });

  test.skipIf(!realModules)('the pinned install loads', async () => {
    expect(await loadAgentFsSdk(realModules!)).toMatchObject({ version: AGENTFS_PINS.sdk, engineVersion: AGENTFS_PINS.engine });
  });
});

describe.skipIf(!realModules)('what agentfs-sdk 0.6.4 on Turso 0.4.4 does itself', () => {
  let dir: string, sdk: AgentFsSdk;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentfs-engine-')));
    sdk = await loadAgentFsSdk(realModules!, {});
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a closed database keeps its rows in delta.db-wal, and the main file copied alone opens empty with no error', async () => {
    const file = path.join(dir, 'delta.db');
    const handle = await sdk.open({ path: file });
    await handle.fs.writeFile('/Menu/Prices.md', PRICES);
    await handle.close();
    expect((await fs.readdir(dir)).sort()).toEqual(['delta.db', 'delta.db-wal']);
    const bare = path.join(dir, 'bare');
    await fs.mkdir(bare);
    await fs.copyFile(file, path.join(bare, 'delta.db'));
    const thin = await sdk.open({ path: path.join(bare, 'delta.db') });
    try {
      expect(await thin.fs.readdir('/')).toEqual([]);
    } finally {
      await thin.close();
    }
  });

  test('a second connection can write the same database, so the workspace lock covers the adapter’s own tools only', async () => {
    const file = path.join(dir, 'delta.db');
    const first = await sdk.open({ path: file });
    const second = await sdk.open({ path: file });
    try {
      await second.fs.writeFile('/Menu/Prices.md', SOUP_7);
      expect((await first.fs.readFile('/Menu/Prices.md')).toString('utf8')).toBe(SOUP_7);
    } finally {
      await second.close();
      await first.close();
    }
  });

  test('a link is reported as a link and cannot be read through', async () => {
    const handle = await sdk.open({ path: path.join(dir, 'delta.db') });
    try {
      await handle.fs.writeFile('/Menu/Prices.md', PRICES);
      await (handle.fs as unknown as Linker).symlink('/Menu/Prices.md', '/Menu/Link.md');
      expect((await handle.fs.lstat('/Menu/Link.md')).isSymbolicLink()).toBe(true);
      await expect(handle.fs.readFile('/Menu/Link.md')).rejects.toMatchObject({ code: 'ENOSYS' });
    } finally {
      await handle.close();
    }
  });

  test('a database removed and made again at the same path in one process comes back with its old rows, and its new file stays empty', async () => {
    const folder = path.join(dir, 'job');
    const file = path.join(folder, 'delta.db');
    await fs.mkdir(folder);
    // Kept referenced for the whole test, so the result does not depend on when garbage is collected.
    const kept: AgentFsHandle[] = [];
    const first = await sdk.open({ path: file });
    kept.push(first);
    await first.fs.writeFile('/Menu/Prices.md', PRICES);
    await first.close();
    await fs.rm(folder, { recursive: true, force: true });
    await fs.mkdir(folder);
    const again = await sdk.open({ path: file });
    kept.push(again);
    try {
      expect(await again.fs.readdir('/')).toEqual(['Menu']);
      await again.fs.writeFile('/Menu/Fall.md', '# Fall\n');
    } finally {
      await again.close();
    }
    expect(await fs.readdir(folder)).toEqual(['delta.db']);
    expect((await fs.lstat(file)).size).toBe(0);
    expect(kept).toHaveLength(2);
  });

  test('a database copied with its journal under a new name keeps its rows', async () => {
    const file = path.join(dir, 'delta-0000000000000001.db');
    const handle = await sdk.open({ path: file });
    await handle.fs.writeFile('/Menu/Prices.md', SOUP_7);
    await handle.close();
    const moved = path.join(dir, 'moved');
    await fs.mkdir(moved);
    for (const name of await fs.readdir(dir))
      if (name.startsWith('delta-0000000000000001.db'))
        await fs.copyFile(path.join(dir, name), path.join(moved, name.replace('0000000000000001', '0000000000000002')));
    const copy = await sdk.open({ path: path.join(moved, 'delta-0000000000000002.db') });
    try {
      expect((await copy.fs.readFile('/Menu/Prices.md')).toString('utf8')).toBe(SOUP_7);
    } finally {
      await copy.close();
    }
  });
});
