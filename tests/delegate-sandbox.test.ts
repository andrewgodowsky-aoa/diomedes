/**
 * H13 slice 2 / H14: a delegate's or worker's sandbox. Every path its tools
 * take is judged by H12's containment funnel rooted at the copy, so an escape
 * attempt (traversal, an absolute path, a link, a junction, an 8.3 alias, a
 * private name) is refused and nothing outside the copy changes. The project
 * is untouched by anything the child writes; the copy is bounded, survives a
 * restart with its snapshot intact, and is removed with its tree.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CapabilityManifest, HarnessPrincipal, Json } from '../shared/harness.js';
import { SANDBOX_LIMITS, carveBudget, inScope, intersectScope } from '../shared/sandbox.js';
import { Store } from '../server/store.js';
import { FileRunStore, RunService } from '../server/harness/index.js';
import { SandboxStore } from '../server/sandbox/sandbox.js';
import type { ToolRegistry } from '../server/harness/tools.js';

const WINDOWS = process.platform === 'win32';
let base: string, store: Store, sandboxes: SandboxStore, projectId: string, folder: string, outside: string;
let service: RunService, step = 0;

const principal = (projectId: string): HarnessPrincipal => ({
  id: 'child',
  tenantId: 'local',
  projectId,
  capabilities: ['write-project-file'],
  identityGeneration: 1,
});
const capability: CapabilityManifest = {
  id: 'sandbox-test',
  version: 'v1',
  label: 'Sandbox test',
  description: 'A child working in its copy.',
  tools: ['list_project_files', 'read_project_file', 'write_file', 'propose_file'],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 8,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};

async function open() {
  store = new Store(path.join(base, 'data'), path.join(base, 'projects'));
  await store.init();
  sandboxes = new SandboxStore(store, store.dataDir);
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegate-sandbox-')));
  outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'the outside secret\n');
  await open();
  const project = await store.locked(() => store.createProject('Linen orders'));
  projectId = project.id;
  folder = project.folder;
  await fs.mkdir(path.join(folder, 'Menu'), { recursive: true });
  await fs.writeFile(path.join(folder, 'order.md'), 'Order 1182: 100 napkins.\n');
  await fs.writeFile(path.join(folder, 'Menu', 'Prices.md'), '# Prices\n\nSoup 6\n');
  await fs.writeFile(path.join(folder, 'Menu', 'Fall.md'), '# Fall\n');
  service = new RunService(new FileRunStore(path.join(base, 'runs')), { clock: () => 1000 });
  step = 0;
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

async function child(scope: readonly string[] | null, id = 'Rparent-d0') {
  const manifest = await sandboxes.create({
    projectId,
    runId: id,
    parentRunId: 'Rparent',
    rootRunId: 'Rparent',
    depth: 1,
    role: 'delegate',
    base: { kind: 'project' },
    scope,
  });
  const tools = sandboxes.registry(manifest, { readable: () => true, write: true });
  await service.start({
    id,
    tenantId: 'local',
    projectId,
    capability,
    principal: principal(projectId),
    budget: { units: 100, modelCalls: 5, toolCalls: 100, wallMs: null },
    tools,
  });
  await service.claim(id, 'host', 60_000);
  return { manifest, tools };
}
const call = (tools: ToolRegistry, name: string, input: unknown, id = 'Rparent-d0') =>
  tools.dispatch<Json>(service, { runId: id, owner: 'host', principal: principal(projectId), stepId: `t${++step}`, name, input });

async function projectUnchanged() {
  expect(await fs.readFile(path.join(folder, 'order.md'), 'utf8')).toBe('Order 1182: 100 napkins.\n');
  expect(await fs.readFile(path.join(folder, 'Menu', 'Prices.md'), 'utf8')).toBe('# Prices\n\nSoup 6\n');
  expect((await fs.readdir(folder)).filter((name) => !name.startsWith('.')).sort()).toEqual(['Menu', 'order.md']);
  expect((await fs.readdir(outside)).sort()).toEqual(['secret.txt']);
  expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('the outside secret\n');
}

describe('scope and budget rules', () => {
  test('a scope entry covers itself and what is under it; null covers everything', () => {
    expect(inScope('Menu/Prices.md', ['Menu'])).toBe(true);
    expect(inScope('Menus/Prices.md', ['Menu'])).toBe(false);
    expect(inScope('order.md', null)).toBe(true);
  });
  test('a child’s scope is the handoff’s declared scope held inside the parent’s, never wider', () => {
    expect(intersectScope(['Menu'], ['Menu/Prices.md', 'order.md'])).toEqual({ scope: ['Menu/Prices.md'], outside: ['order.md'] });
    expect(intersectScope(['Menu/Prices.md'], ['Menu'])).toEqual({ scope: ['Menu/Prices.md'], outside: [] });
    expect(intersectScope(null, ['order.md'])).toEqual({ scope: ['order.md'], outside: [] });
    expect(intersectScope(['Menu'], null)).toEqual({ scope: ['Menu'], outside: [] });
  });
  test('budgets are carved from what the parent has left, never added on top', () => {
    const parent = { budget: { units: 20, modelCalls: 9, toolCalls: 8, wallMs: null }, used: { units: 3 } };
    expect(carveBudget(parent, 1)).toMatchObject({ budget: { units: 8, modelCalls: 4, toolCalls: 4 }, total: 8 });
    // Four at once share what is left after the parent's reserve: (17 - 2) / 4 = 3 each.
    expect(carveBudget(parent, 4)).toMatchObject({ budget: { units: 3, modelCalls: 1, toolCalls: 1 }, total: 12 });
    const spent = { budget: parent.budget, used: { units: 17 } };
    expect(carveBudget(spent, 1)).toMatchObject({ budget: null, refusal: expect.stringMatching(/3 of its 20 units left/) });
  });
});

describe('a child writes only its copy', () => {
  test('the copy holds its scope; a write lands in the copy and the project is untouched', async () => {
    const { manifest, tools } = await child(['Menu']);
    expect(manifest.state).toBe('open');
    expect(manifest.files.map((file) => file.path)).toEqual(['Menu/Fall.md', 'Menu/Prices.md']);
    expect(manifest.files[1].sha).toMatch(/^[a-f0-9]{64}$/);
    // The copy lives in the parent run's area, never beside the project.
    expect(sandboxes.work(projectId, manifest.runId).startsWith(path.join(store.dataDir, 'projects', projectId, 'harness', 'sandboxes'))).toBe(true);
    expect(await call(tools, 'write_file', { path: 'Menu/Prices.md', text: '# Prices\n\nSoup 7\n' })).toMatchObject({ path: 'Menu/Prices.md', proposed: false });
    expect(await call(tools, 'write_file', { path: 'Menu/New/Winter.md', text: '# Winter\n' })).toMatchObject({ path: 'Menu/New/Winter.md' });
    expect(await call(tools, 'read_project_file', { path: 'Menu/Prices.md' })).toMatchObject({ found: true, text: '# Prices\n\nSoup 7\n' });
    await projectUnchanged();
    const run = await service.get(manifest.runId);
    // The effect record names the sandbox, so it never reads as a project write.
    expect(run.steps.find((item) => item.intent.name === 'write_file')!.effects![0].targets).toEqual([`sandbox:${manifest.runId}/Menu/Prices.md`]);
    const { entries } = await sandboxes.collect(manifest);
    expect(entries.map((entry) => [entry.path, entry.op, entry.proposed])).toEqual([
      ['Menu/New/Winter.md', 'created', false],
      ['Menu/Prices.md', 'modified', false],
    ]);
  });

  test('a file outside the scope cannot be read or written, even inside the copy', async () => {
    const { tools } = await child(['Menu/Prices.md']);
    expect(await call(tools, 'read_project_file', { path: 'order.md' })).toMatchObject({ refused: expect.stringMatching(/outside the scope/) });
    expect(await call(tools, 'write_file', { path: 'order.md', text: 'x' })).toMatchObject({ code: 'sandbox_refused' });
    expect(await call(tools, 'list_project_files', {})).toMatchObject({ files: ['Menu/Prices.md'] });
    await projectUnchanged();
  });

  test('propose_file marks its change for a person', async () => {
    const { manifest, tools } = await child(['Menu']);
    await call(tools, 'propose_file', { path: 'Menu/Fall.md', text: '# Fall, revised\n' });
    const { entries } = await sandboxes.collect(manifest);
    expect(entries).toEqual([expect.objectContaining({ path: 'Menu/Fall.md', op: 'modified', proposed: true, text: '# Fall, revised\n' })]);
  });
});

describe('escape attempts are refused by the funnel rooted at the copy', () => {
  test.each([
    ['parent traversal', '../escape.md', 'path_traversal'],
    ['traversal out of the copy', 'Menu/../../../escape.md', 'path_traversal'],
    ['backslash traversal', 'Menu\\..\\..\\escape.md', 'path_traversal'],
    ['posix absolute', '/etc/passwd', 'path_absolute'],
    ['absolute into the project', '', 'path_absolute'],
    ['drive absolute', 'C:\\Windows\\win.ini', 'path_absolute'],
    ['UNC share', '\\\\server\\share\\x.md', 'path_absolute'],
    ['private name', 'Menu/.env', 'path_forbidden'],
    ['8.3 short-name shape', 'Menu/PRICES~1.MD', 'path_forbidden'],
    ['8.3 short-name folder', 'MENU~1/Prices.md', 'path_forbidden'],
    ['alternate data stream', 'Menu/Prices.md:hidden', 'path_invalid'],
    ['reserved device name', 'Menu/con.md', 'path_invalid'],
  ])('%s: %j → %s', async (_what, spelled, code) => {
    const { manifest, tools } = await child(['Menu']);
    const target = spelled === '' ? path.join(folder, 'Menu', 'Prices.md') : spelled;
    expect(await call(tools, 'write_file', { path: target, text: 'pwned' })).toMatchObject({ code });
    expect(await call(tools, 'read_project_file', { path: target })).toMatchObject({ refused: expect.any(String) });
    await projectUnchanged();
    expect((await sandboxes.collect(manifest)).entries).toEqual([]);
  });

  test('a link planted in the copy is never followed, and never returned', async () => {
    const { manifest, tools } = await child(['Menu']);
    const work = sandboxes.work(projectId, manifest.runId);
    try {
      await fs.symlink(outside, path.join(work, 'Menu', 'linked'), WINDOWS ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    expect(await call(tools, 'write_file', { path: 'Menu/linked/secret.txt', text: 'pwned' })).toMatchObject({ code: 'path_link' });
    expect(await call(tools, 'read_project_file', { path: 'Menu/linked/secret.txt' })).toMatchObject({ refused: expect.any(String) });
    const collected = await sandboxes.collect(manifest);
    expect(collected.entries).toEqual([]);
    expect(collected.dropped).toEqual([{ path: 'Menu/linked', reason: 'A link in the copy is never returned.' }]);
    await projectUnchanged();
  });

  test.runIf(WINDOWS)('Windows: a junction in the copy to the project itself is refused', async () => {
    const { manifest, tools } = await child(['Menu']);
    await fs.symlink(folder, path.join(sandboxes.work(projectId, manifest.runId), 'Menu', 'junction'), 'junction');
    expect(await call(tools, 'write_file', { path: 'Menu/junction/order.md', text: 'pwned' })).toMatchObject({ code: 'path_link' });
    await projectUnchanged();
  });

  test('a link in the project is never copied into a sandbox', async () => {
    try {
      await fs.symlink(outside, path.join(folder, 'Menu', 'outside'), WINDOWS ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const { manifest } = await child(['Menu']);
    expect(manifest.files.map((file) => file.path)).toEqual(['Menu/Fall.md', 'Menu/Prices.md']);
    await expect(fs.lstat(path.join(sandboxes.work(projectId, manifest.runId), 'Menu', 'outside'))).rejects.toThrow();
  });

  test('a process can only start with the copy as its root', async () => {
    const { manifest } = await child(['Menu']);
    const result = await sandboxes.spawn(manifest, 'Menu', process.execPath, ['-e', 'console.log(process.cwd())'], { timeoutMs: 10_000 });
    expect(await fs.realpath(result.stdout.trim())).toBe(await fs.realpath(path.join(sandboxes.work(projectId, manifest.runId), 'Menu')));
    await expect(sandboxes.spawn(manifest, '..', process.execPath, ['-e', '0'], { timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'path_traversal' });
  });
});

describe('bounded, durable, and removed with its tree', () => {
  test('a scope over the limit is refused whole, with the numbers', async () => {
    await fs.writeFile(path.join(folder, 'big.md'), 'x'.repeat(SANDBOX_LIMITS.maxFileBytes + 1));
    await expect(child(['big.md'])).rejects.toMatchObject({ code: 'sandbox_refused', message: expect.stringMatching(/big\.md is 1\.0 MB/) });
    await fs.rm(path.join(folder, 'big.md'));
    await fs.mkdir(path.join(folder, 'Many'));
    for (let index = 0; index <= SANDBOX_LIMITS.maxFiles; index++) await fs.writeFile(path.join(folder, 'Many', `${index}.md`), 'x');
    await expect(child(['Many'], 'Rparent-d1')).rejects.toMatchObject({ message: expect.stringMatching(/201 files .* at most 200 files/) });
  });

  test('a restart finds the sandbox with its snapshot and the child’s work; a half-made copy is taken again', async () => {
    const { manifest, tools } = await child(['Menu']);
    await call(tools, 'write_file', { path: 'Menu/Prices.md', text: '# Prices\n\nSoup 7\n' });
    // The project moves on after the snapshot: the snapshot must not.
    await fs.writeFile(path.join(folder, 'Menu', 'Prices.md'), '# Prices\n\nSoup 9\n');
    await open();
    const again = await sandboxes.create({ ...manifest, base: { kind: 'project' } });
    expect(again).toEqual(manifest);
    expect((await sandboxes.collect(again)).entries).toEqual([
      expect.objectContaining({ path: 'Menu/Prices.md', before: manifest.files[1].sha, text: '# Prices\n\nSoup 7\n' }),
    ]);
    // A copy interrupted before it was whole is made again from the start.
    const dir = sandboxes.dir(projectId, 'Rparent-d2');
    await fs.mkdir(path.join(dir, 'work'), { recursive: true });
    await fs.writeFile(path.join(dir, 'work', 'stray.md'), 'half a copy');
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, runId: 'Rparent-d2', state: 'creating', files: [] }));
    const retaken = await sandboxes.create({ ...manifest, runId: 'Rparent-d2', base: { kind: 'project' } });
    expect(retaken.state).toBe('open');
    expect(retaken.files.map((file) => file.path)).toEqual(['Menu/Fall.md', 'Menu/Prices.md']);
    await expect(fs.lstat(path.join(dir, 'work', 'stray.md'))).rejects.toThrow();
  });

  test('a depth-2 copy is taken from its parent delegate’s copy, not the project', async () => {
    const { manifest, tools } = await child(['Menu']);
    await call(tools, 'write_file', { path: 'Menu/Prices.md', text: '# Prices\n\nSoup 7\n' });
    const nested = await sandboxes.create({
      projectId,
      runId: 'Rparent-d0-d0',
      parentRunId: manifest.runId,
      rootRunId: 'Rparent',
      depth: 2,
      role: 'delegate',
      base: { kind: 'sandbox', runId: manifest.runId },
      scope: ['Menu/Prices.md'],
    });
    expect(nested.files).toHaveLength(1);
    expect(await fs.readFile(path.join(sandboxes.work(projectId, nested.runId), 'Menu', 'Prices.md'), 'utf8')).toBe('# Prices\n\nSoup 7\n');
  });

  test('collected copies are removed at once; the rest go when their root run has ended', async () => {
    const { manifest } = await child(['Menu']);
    await sandboxes.collected(manifest);
    await expect(fs.lstat(sandboxes.work(projectId, manifest.runId))).rejects.toThrow();
    expect((await sandboxes.read(projectId, manifest.runId))?.state).toBe('collected');
    expect(await sandboxes.sweep(projectId, async () => false)).toEqual([]);
    expect(await sandboxes.sweep(projectId, async (root) => root === 'Rparent')).toEqual([manifest.runId]);
    expect(await sandboxes.list(projectId)).toEqual([]);
  });
});

describe('a sandbox starts no process of its own', () => {
  test('child_process appears in no sandbox module; spawning goes through containedSpawn', async () => {
    const dir = path.join(process.cwd(), 'server', 'sandbox');
    for (const name of (await fs.readdir(dir)).filter((item) => item.endsWith('.ts'))) {
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      expect(/from ['"]node:child_process['"]|require\(['"](node:)?child_process['"]\)/.test(text), name).toBe(false);
    }
  });
});
