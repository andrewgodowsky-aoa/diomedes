import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';
import type { SoftwarePackService } from '../server/software-pack/service.js';
import type { CommandRunRecord, SoftwarePackView, WorktreeRequest } from '../shared/software-pack.js';
import type { HarnessRun } from '../shared/harness.js';
import type { Session, Task } from '../shared/types.js';

/**
 * P07, the Software Engineering pack's repository slice, through the real
 * service graph and HTTP: nothing loads where the pack is off; a worktree is
 * added and removed only after an exact approval, and never removed while it
 * holds uncommitted work; a declared command runs as plain words after its
 * approval, under a timeout that ends its process tree and an output cap; and
 * H17 reads the recorded result as evidence.
 */

// Every process the pack starts goes through H12's contained spawn. Counted here, so a test can
// prove an inactive project started none.
const spawned = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('../server/harness/containment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/harness/containment.js')>();
  return {
    ...actual,
    containedSpawn: (...args: Parameters<typeof actual.containedSpawn>) => {
      spawned.calls.push([args[2], ...args[3]]);
      return actual.containedSpawn(...args);
    },
  };
});
vi.mock('../server/integrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/integrations.js')>();
  return {
    ...actual,
    askCodex: async () => ({ text: '{"summary":"none","changes":[]}', model: 'gpt-6-astra', version: '0.153.4', threadId: 't' }),
  };
});

const PACK = 'diomedes.software-engineering';
let temp: string;
let folder: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let projectId: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

const call = async <T = Record<string, unknown>>(route: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
};
const service = () => app.locals.softwarePack as SoftwarePackService;
const store = () => app.locals.store as Store;
const run = async (runId: string) => (await app.locals.harness.runs.get(runId)) as HarnessRun;

const SCRIPTS: Record<string, string> = {
  'pass.js': `require('fs').writeFileSync('ran-pass.txt', 'yes'); console.log('4 tests passed');\n`,
  'fail.js': `console.error('1 test failed: adds numbers'); process.exit(3);\n`,
  // A child that starts a grandchild, writes both pids, and outlives any sane timeout.
  'hang.js': [
    `const { spawn } = require('child_process');`,
    `const fs = require('fs');`,
    `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
    `fs.writeFileSync('pids.txt', JSON.stringify([process.pid, child.pid]));`,
    `console.log('started');`,
    `setInterval(() => {}, 1000);`,
  ].join('\n'),
  'flood.js': `const line = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < 3000; i++) process.stdout.write(line);\n`,
  'env.js': `console.log(JSON.stringify(Object.keys(process.env).sort()));\n`,
};

beforeEach(async () => {
  spawned.calls = [];
  temp = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-p07-')));
  folder = path.join(temp, 'repo');
  await fs.mkdir(folder);
  git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'config', 'user.name', 'Grace Hopper');
  git(folder, 'config', 'user.email', 'grace@example.com');
  git(folder, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(folder, 'README.md'), '# Compiler\n');
  for (const [name, text] of Object.entries(SCRIPTS)) await fs.writeFile(path.join(folder, name), text);
  await fs.writeFile(path.join(folder, '.gitignore'), 'ran-pass.txt\npids.txt\n');
  git(folder, 'add', '.');
  git(folder, 'commit', '-q', '-m', 'Initial compiler');
  app = await createApp({ dataDir: path.join(temp, 'data'), projectRoot: path.join(temp, 'projects'), stepMs: 20 });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const created = await call<{ id: string }>('/projects', 'POST', { name: 'Compiler', folder });
  expect(created.status).toBe(200);
  projectId = created.data.id;
});
afterEach(async () => {
  const closingApp = app;
  const closingServer = server;
  try {
    await closingApp?.locals.close();
  } finally {
    if (closingServer) {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => closingServer.close((error) => (error ? reject(error) : resolve())));
    }
  }
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const activate = async () => {
  const on = await call(`/projects/${projectId}/packs/${PACK}/activate`, 'POST');
  expect(on.status).toBe(200);
};
const declare = async (commands: unknown[]) => call(`/projects/${projectId}/software/commands`, 'PUT', { commands });
const view = async () => (await call<SoftwarePackView>(`/projects/${projectId}/software`)).data;
const answer = async (kind: 'runs' | 'worktrees', id: string, decision: string, intentHash: string) =>
  call(`/projects/${projectId}/software/${kind}/${id}/decision`, 'POST', { decision, intentHash });
const settle = () => service().settled();
const latestRun = () => store().state(projectId).softwarePack!.runs.at(-1)!;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('the pack loads only where it is on', () => {
  test('every route refuses in a project that has not turned the pack on, and starts no process', async () => {
    const routes: [string, string, unknown?][] = [
      ['/software', 'GET'],
      ['/software/repository', 'GET'],
      ['/software/file?path=README.md', 'GET'],
      ['/software/diff', 'POST', { paths: ['README.md'] }],
      ['/software/commands', 'PUT', { commands: [{ command: 'node pass.js' }] }],
      ['/software/commands/cmd-000000000000/run', 'POST'],
      ['/software/worktrees', 'POST', { operation: 'add', name: 'task-1' }],
    ];
    for (const [route, method, body] of routes) {
      const response = await call(`/projects/${projectId}${route}`, method, body);
      expect([route, response.status, response.data.code]).toEqual([route, 409, 'pack_inactive']);
    }
    expect(spawned.calls).toEqual([]);
    expect(store().state(projectId).softwarePack).toBeUndefined();
    expect(await app.locals.harness.list(projectId)).toEqual([]);
  });

  test('turning the pack off again refuses again, and what it recorded stays', async () => {
    await activate();
    expect((await declare([{ command: 'node pass.js' }])).status).toBe(200);
    expect((await call(`/projects/${projectId}/packs/${PACK}/deactivate`, 'POST')).status).toBe(200);
    expect((await call(`/projects/${projectId}/software`)).data.code).toBe('pack_inactive');
    expect(store().state(projectId).softwarePack!.commands.map((item) => item.command)).toEqual(['node pass.js']);
  });

  test('a tool refuses at the point of use when the pack is off, whatever the caller', async () => {
    await expect(
      service().tools.get('git_status').execute({
        input: { projectId },
        idempotencyKey: 'k',
        attempt: 1,
        fence: 0,
        signal: new AbortController().signal,
        publishPreview: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'pack_inactive' });
  });
});

describe('the repository view', () => {
  test('branch, changed files and recent commits, read-only', async () => {
    await activate();
    await fs.writeFile(path.join(folder, 'README.md'), '# Compiler\n\nNow optimising.\n');
    const before = git(folder, 'status', '--porcelain');
    const shown = await view();
    expect(shown.repository).toMatchObject({ state: 'repository', branch: 'main', detached: false });
    expect(shown.repository.changes).toEqual([{ path: 'README.md', from: null, kind: 'modified', staged: false, unstaged: true }]);
    expect(shown.repository.commits.map((commit) => [commit.author, commit.subject])).toEqual([['Grace Hopper', 'Initial compiler']]);
    expect(git(folder, 'status', '--porcelain')).toBe(before);
    // The readable diff's two sides, and the diff offered as message text.
    const file = await call(`/projects/${projectId}/software/file?path=README.md`);
    expect(file.data).toMatchObject({ path: 'README.md', before: '# Compiler\n', after: '# Compiler\n\nNow optimising.\n' });
    const diff = await call<{ text: string; tooLarge: boolean }>(`/projects/${projectId}/software/diff`, 'POST', { paths: ['README.md'] });
    expect(diff.data.tooLarge).toBe(false);
    expect(diff.data.text).toContain('+Now optimising.');
    // Only a changed file may be chosen: never the whole repository.
    const unchanged = await call(`/projects/${projectId}/software/diff`, 'POST', { paths: ['pass.js'] });
    expect([unchanged.status, unchanged.data.code]).toEqual([400, 'not_changed']);
    const outside = await call(`/projects/${projectId}/software/file?path=../outside.txt`);
    expect(outside.status).toBe(403);
  });

  test('a project folder that is not a repository says so', async () => {
    await fs.rm(path.join(folder, '.git'), { recursive: true, force: true });
    await activate();
    const shown = await view();
    expect(shown.repository).toMatchObject({ state: 'not-a-repository', detail: 'This project folder is not a Git repository.' });
  });
});

describe('worktrees', () => {
  const request = async (body: unknown) => call<WorktreeRequest & { code?: string }>(`/projects/${projectId}/software/worktrees`, 'POST', body);

  test('add waits for an exact approval, then works on a branch without touching your checkout', async () => {
    await activate();
    await fs.writeFile(path.join(folder, 'README.md'), '# Compiler\n\nMy own edit in progress.\n');
    const checkout = { branch: git(folder, 'branch', '--show-current'), status: git(folder, 'status', '--porcelain'), readme: await fs.readFile(path.join(folder, 'README.md'), 'utf8') };
    const asked = await request({ operation: 'add', name: 'task-parser' });
    expect(asked.status).toBe(200);
    expect(asked.data).toMatchObject({ state: 'waiting-approval', path: '.diomedes-worktrees/task-parser', branch: 'diomedes/task-parser' });
    // Red: asked is not approved. Nothing exists yet.
    await expect(fs.access(path.join(folder, '.diomedes-worktrees', 'task-parser'))).rejects.toThrow();
    const waiting = await run(asked.data.runId);
    expect(waiting.state).toBe('waiting');
    expect(waiting.steps[0]!.effects?.at(-1)).toBeUndefined();
    // An answer for a different intent is refused and changes nothing.
    const wrong = await answer('worktrees', asked.data.id, 'go-ahead', 'f'.repeat(64));
    expect([wrong.status, wrong.data.code]).toEqual([409, 'exact_approval_required']);
    // Green: the exact approval.
    expect((await answer('worktrees', asked.data.id, 'go-ahead', asked.data.intentHash)).status).toBe(200);
    await settle();
    const done = store().state(projectId).softwarePack!;
    expect(done.worktreeRequests.at(-1)).toMatchObject({ state: 'done' });
    expect(done.worktrees).toMatchObject([{ name: 'task-parser', branch: 'diomedes/task-parser', removedAt: null }]);
    const worktree = path.join(folder, '.diomedes-worktrees', 'task-parser');
    expect(git(worktree, 'branch', '--show-current').trim()).toBe('diomedes/task-parser');
    expect(await fs.readFile(path.join(worktree, 'README.md'), 'utf8')).toBe('# Compiler\n');
    // The person's checkout: same branch, same edit, same status.
    expect(git(folder, 'branch', '--show-current')).toBe(checkout.branch);
    expect(await fs.readFile(path.join(folder, 'README.md'), 'utf8')).toBe(checkout.readme);
    expect((await view()).repository.changes.map((change) => change.path)).toEqual(['README.md']);
    // The effect was recorded before it ran, with its targets and the exact approval.
    const finished = await run(asked.data.runId);
    expect(finished.state).toBe('completed');
    expect(finished.steps[0]!.effects).toMatchObject([
      {
        tool: 'worktree_add',
        effectClass: 'non-idempotent-effect',
        targets: ['.diomedes-worktrees/task-parser', 'git-branch:diomedes/task-parser'],
        authorization: `approval:${asked.data.intentHash}`,
        status: 'applied',
      },
    ]);
    const sentences = store().state(projectId).history.map((entry) => entry.sentence);
    expect(sentences).toContain('You approved adding .diomedes-worktrees/task-parser on diomedes/task-parser, once.');
  });

  test('a worktree with uncommitted work is never removed; a clean one is, and its branch stays', async () => {
    await activate();
    const added = await request({ operation: 'add', name: 'task-lexer', branch: 'lexer-work' });
    await answer('worktrees', added.data.id, 'go-ahead', added.data.intentHash);
    await settle();
    const worktree = path.join(folder, '.diomedes-worktrees', 'task-lexer');
    await fs.writeFile(path.join(worktree, 'draft.txt'), 'not committed\n');

    const dirty = await request({ operation: 'remove', name: 'task-lexer' });
    await answer('worktrees', dirty.data.id, 'go-ahead', dirty.data.intentHash);
    await settle();
    const refused = store().state(projectId).softwarePack!.worktreeRequests.at(-1)!;
    expect(refused.state).toBe('refused');
    expect(refused.detail).toMatch(/1 file with uncommitted changes \(draft\.txt\).*never force-removes.*Nothing was removed\./);
    expect(await fs.readFile(path.join(worktree, 'draft.txt'), 'utf8')).toBe('not committed\n');
    expect(store().state(projectId).softwarePack!.worktrees[0]!.removedAt).toBeNull();

    git(worktree, 'add', 'draft.txt');
    git(worktree, '-c', 'user.name=Grace Hopper', '-c', 'user.email=grace@example.com', 'commit', '-q', '-m', 'Draft the lexer');
    const clean = await request({ operation: 'remove', name: 'task-lexer' });
    await answer('worktrees', clean.data.id, 'go-ahead', clean.data.intentHash);
    await settle();
    expect(store().state(projectId).softwarePack!.worktreeRequests.at(-1)).toMatchObject({ state: 'done' });
    await expect(fs.access(worktree)).rejects.toThrow();
    expect(git(folder, 'log', '-1', '--format=%s', 'lexer-work').trim()).toBe('Draft the lexer');
    expect(store().state(projectId).softwarePack!.worktrees[0]!.removedAt).not.toBeNull();
  });

  test('declining changes nothing; names outside the rules and a linked worktree folder are refused', async () => {
    await activate();
    const asked = await request({ operation: 'add', name: 'task-x' });
    expect((await answer('worktrees', asked.data.id, 'declined', asked.data.intentHash)).status).toBe(200);
    await settle();
    expect(store().state(projectId).softwarePack!.worktreeRequests.at(-1)).toMatchObject({ state: 'declined' });
    expect((await run(asked.data.runId)).state).toBe('cancelled');
    await expect(fs.access(path.join(folder, '.diomedes-worktrees'))).rejects.toThrow();

    for (const name of ['../escape', '.git', 'UPPER', 'a/b', '']) {
      const bad = await request({ operation: 'add', name });
      expect([name, bad.status, bad.data.code]).toEqual([name, 400, 'invalid_worktree']);
    }
    for (const branch of ['-D', '../x', 'a..b', 'x.lock']) {
      const bad = await request({ operation: 'add', name: 'task-y', branch });
      expect([branch, bad.status, bad.data.code]).toEqual([branch, 400, 'branch_invalid']);
    }
    // The path guard, at the point of use: the worktree folder swapped for a link to outside.
    const outside = path.join(temp, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(folder, '.diomedes-worktrees'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await request({ operation: 'add', name: 'task-z' });
    await answer('worktrees', linked.data.id, 'go-ahead', linked.data.intentHash);
    await settle();
    expect(store().state(projectId).softwarePack!.worktreeRequests.at(-1)).toMatchObject({ state: 'refused' });
    expect(await fs.readdir(outside)).toEqual([]);
    const removeUnknown = await request({ operation: 'remove', name: 'never-added' });
    expect([removeUnknown.status, removeUnknown.data.code]).toEqual([404, 'worktree_unknown']);
  });
});

describe('declared commands', () => {
  const ask = async (commandId: string) =>
    call<CommandRunRecord & { code?: string }>(`/projects/${projectId}/software/commands/${commandId}/run`, 'POST');
  const declared = async (command: string, extra: Record<string, unknown> = {}) => {
    const response = await declare([{ command, ...extra }]);
    expect(response.status).toBe(200);
    return (response.data as { commands: { id: string }[] }).commands[0]!.id;
  };

  test('nothing runs before its exact approval; declining runs nothing; approving runs it once', async () => {
    await activate();
    const id = await declared('node pass.js');
    const first = await ask(id);
    expect(first.data).toMatchObject({ state: 'waiting-approval', argv: ['node', 'pass.js'] });
    // Red: requested, not approved. The program has not started.
    expect(spawned.calls.some((call) => call[0] === 'node')).toBe(false);
    await expect(fs.access(path.join(folder, 'ran-pass.txt'))).rejects.toThrow();
    const second = await ask(id);
    expect([second.status, second.data.code]).toEqual([409, 'command_pending']);
    expect((await answer('runs', first.data.id, 'declined', first.data.intentHash)).status).toBe(200);
    await settle();
    expect(latestRun()).toMatchObject({ state: 'declined', detail: 'You declined. Nothing ran.' });
    await expect(fs.access(path.join(folder, 'ran-pass.txt'))).rejects.toThrow();

    // Green: approved, it runs, as exactly those words, and its result is recorded.
    const again = await ask(id);
    expect((await answer('runs', again.data.id, 'go-ahead', again.data.intentHash)).status).toBe(200);
    await settle();
    expect(latestRun()).toMatchObject({ state: 'passed', exitCode: 0, decidedBy: 'you' });
    expect(latestRun().stdoutTail).toContain('4 tests passed');
    expect(latestRun().fingerprint?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(spawned.calls.filter((call) => call[0] === 'node')).toEqual([['node', 'pass.js']]);
    const record = await run(again.data.runId);
    expect(record.steps[0]!.effects).toMatchObject([
      {
        tool: 'run_command',
        effectClass: 'non-idempotent-effect',
        targets: ['.', 'command:node pass.js'],
        authorization: `approval:${again.data.intentHash}`,
        status: 'applied',
      },
    ]);
    // It said it would ask each time, and it does: the next run waits again.
    expect((await ask(id)).data.state).toBe('waiting-approval');
    expect((await view()).commands[0]).toMatchObject({ approvedBefore: true, source: 'project' });
  });

  test('a failing command is a recorded failure with its output, not an error', async () => {
    await activate();
    const id = await declared('node fail.js');
    const asked = await ask(id);
    await answer('runs', asked.data.id, 'go-ahead', asked.data.intentHash);
    await settle();
    expect(latestRun()).toMatchObject({ state: 'failed', exitCode: 3 });
    expect(latestRun().stderrTail).toContain('1 test failed');
    expect((await run(asked.data.runId)).steps[0]!.effects?.at(-1)?.status).toBe('applied');
  });

  test('a timeout ends the command and every process it started', async () => {
    await activate();
    // Long enough for a slow Windows runner to start node and its child before the limit.
    const id = await declared('node hang.js', { timeoutMs: 5000 });
    const asked = await ask(id);
    await answer('runs', asked.data.id, 'go-ahead', asked.data.intentHash);
    await settle();
    expect(latestRun()).toMatchObject({ state: 'timed-out', exitCode: null });
    expect(latestRun().stdoutTail).toContain('started');
    const pids = JSON.parse(await fs.readFile(path.join(folder, 'pids.txt'), 'utf8')) as number[];
    await expect.poll(() => pids.map(alive), { timeout: 5000 }).toEqual([false, false]);
  });

  test('output past the cap ends the command', async () => {
    await activate();
    const id = await declared('node flood.js');
    const asked = await ask(id);
    await answer('runs', asked.data.id, 'go-ahead', asked.data.intentHash);
    await settle();
    expect(latestRun().state).toBe('output-capped');
    expect(Buffer.byteLength(latestRun().stdoutTail)).toBeLessThanOrEqual(16 * 1024 + 3);
  });

  test('the command runs with a minimal environment: no secret reaches it', async () => {
    await activate();
    process.env.DIOMEDES_P07_CANARY_TOKEN = 'canary-secret';
    try {
      const id = await declared('node env.js');
      const asked = await ask(id);
      await answer('runs', asked.data.id, 'go-ahead', asked.data.intentHash);
      await settle();
    } finally {
      delete process.env.DIOMEDES_P07_CANARY_TOKEN;
    }
    expect(latestRun().state).toBe('passed');
    const names = JSON.parse(latestRun().stdoutTail) as string[];
    expect(names).not.toContain('DIOMEDES_P07_CANARY_TOKEN');
    expect(names.filter((name) => /TOKEN|SECRET|KEY/i.test(name))).toEqual([]);
  });

  test('a shell metacharacter or a shell program is refused at declaration and never reaches a process', async () => {
    await activate();
    for (const command of ['node pass.js && rm -rf /', 'node pass.js; echo pwned', 'node $(echo pass.js)', 'node pass.js > out.txt']) {
      const refused = await declare([{ command }]);
      expect([command, refused.status, refused.data.code]).toEqual([command, 400, 'command_shell_refused']);
    }
    const shell = await declare([{ command: 'bash -c ls' }]);
    expect([shell.status, shell.data.code]).toEqual([400, 'command_shell_program']);
    expect(spawned.calls).toEqual(expect.not.arrayContaining([expect.arrayContaining(['node'])]));
    // A task's H17 command check with a metacharacter is listed, and refused when asked to run.
    const state = store().state(projectId);
    state.tasks.push(task('T9', [{ id: 'bad', kind: 'command', command: 'npm test | tee log' }]));
    await store().persist(state);
    const listed = (await view()).commands.find((item) => item.source === 'acceptance')!;
    expect(listed.parsed).toMatchObject({ ok: false, code: 'command_shell_refused' });
    const asked = await ask(listed.id);
    expect([asked.status, asked.data.code]).toEqual([400, 'command_shell_refused']);
    expect(await app.locals.harness.list(projectId)).toEqual([]);
  });

  test('a run a stop interrupted is said to be unconfirmed, is never re-run, and does not block the next one', async () => {
    await activate();
    const id = await declared('node pass.js');
    const asked = await ask(id);
    // What a stop between Go ahead and the result leaves behind: a record that says running,
    // which no job in this process is carrying out.
    const state = store().state(projectId);
    state.softwarePack!.runs.at(-1)!.state = 'running';
    await store().persist(state);
    const shown = await view();
    expect(shown.runs[0]).toMatchObject({ id: asked.data.id, state: 'uncertain' });
    expect(shown.runs[0]!.detail).toMatch(/not confirmed\. It will not run it again on its own\./);
    await expect(fs.access(path.join(folder, 'ran-pass.txt'))).rejects.toThrow();
    expect((await ask(id)).data.state).toBe('waiting-approval');
  });

  test('a declaration outside the project folder is refused', async () => {
    await activate();
    const refused = await declare([{ command: 'node pass.js', cwd: '../elsewhere' }]);
    expect([refused.status, refused.data.code]).toEqual([400, 'path_traversal']);
  });
});

function task(id: string, checks: unknown[]): Task {
  return {
    id,
    name: 'Make the parser pass',
    description: 'Fix the parser.',
    from: null,
    owner: 'diomedes',
    state: 'done',
    reason: null,
    needId: null,
    sessionIds: [],
    changeIds: [],
    createdBy: 'you',
    createdAt: '2026-09-24T00:00:00.000Z',
    moves: [],
    ...(checks.length
      ? { acceptance: { protocolVersion: 1, checks, digest: 'x', declaredAt: '2026-09-24T00:00:00.000Z', declaredBy: 'you' } }
      : {}),
  } as Task;
}

describe('H17 reads a declared command run as evidence', () => {
  async function finishedRun() {
    const state = store().state(projectId);
    state.tasks.push({ ...task('T1', []), sessionIds: ['S1'] });
    const session: Session = {
      id: 'S1',
      taskId: 'T1',
      route: 'codex',
      state: 'done',
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      endedAt: new Date(Date.now() - 60_000).toISOString(),
      sample: false,
      log: [],
      entryIds: [],
      needId: null,
      engine: { name: 'codex', model: 'gpt-6-astra', worker: 1, branch: null, context: null, events: 0, verified: true },
    };
    state.sessions.push(session);
    await store().persist(state);
    const declared = await call(`/projects/${projectId}/tasks/T1/acceptance`, 'PUT', {
      checks: [{ id: 'tests', kind: 'command', command: 'node  pass.js' }],
    });
    expect(declared.status).toBe(200);
  }
  const verify = async () =>
    (await call<{ state: string; record: { checks: { id: string; outcome: string; sentence: string }[] } }>(
      `/projects/${projectId}/sessions/S1/verification`,
      'POST',
    )).data;
  const commandCheck = (result: Awaited<ReturnType<typeof verify>>) => result.record.checks.find((check) => check.id === 'tests')!;

  test('without the pack a command check is never run; with it, an approved passing run verifies', async () => {
    await finishedRun();
    // Red: the pack is off, so the command is only declared, as before P07.
    const off = await verify();
    expect(commandCheck(off)).toMatchObject({ outcome: 'incomplete' });
    expect(commandCheck(off).sentence).toMatch(/Trust decision this build does not make/);
    expect(off.state).toBe('uncertain');

    await activate();
    // On, but not run yet on this output: still not evidence.
    const notRun = await verify();
    expect(commandCheck(notRun).outcome).toBe('incomplete');
    expect(commandCheck(notRun).sentence).toMatch(/Not run on this output yet: run node pass\.js/);

    // Green: the task's own check is offered to run, approved, run, and read as evidence.
    const offered = (await view()).commands.find((item) => item.source === 'acceptance')!;
    expect(offered).toMatchObject({ command: 'node pass.js', parsed: { ok: true } });
    const asked = await call<CommandRunRecord>(`/projects/${projectId}/software/commands/${offered.id}/run`, 'POST');
    await answer('runs', asked.data.id, 'go-ahead', asked.data.intentHash);
    await settle();
    const passed = await verify();
    expect(commandCheck(passed).outcome).toBe('passed');
    expect(commandCheck(passed).sentence).toMatch(/^node pass\.js exited 0 at .* against repository state [0-9a-f]{12} \(command run CR/);
    expect(passed.state).toBe('verified');

    // The repository moves on: the old result no longer describes it.
    await fs.writeFile(path.join(folder, 'README.md'), '# Compiler\n\nChanged after the tests ran.\n');
    const stale = await verify();
    expect(commandCheck(stale).outcome).toBe('incomplete');
    expect(commandCheck(stale).sentence).toMatch(/repository has changed since/);
  });

  test('a failing declared command fails verification with its evidence', async () => {
    await finishedRun();
    const state = store().state(projectId);
    state.tasks.find((item) => item.id === 'T1')!.acceptance = undefined;
    await store().persist(state);
    await call(`/projects/${projectId}/tasks/T1/acceptance`, 'PUT', { checks: [{ id: 'tests', kind: 'command', command: 'node fail.js' }] });
    await activate();
    const offered = (await view()).commands.find((item) => item.source === 'acceptance')!;
    const asked = await call<CommandRunRecord>(`/projects/${projectId}/software/commands/${offered.id}/run`, 'POST');
    await answer('runs', asked.data.id, 'go-ahead', asked.data.intentHash);
    await settle();
    const failed = await verify();
    expect(commandCheck(failed)).toMatchObject({ outcome: 'failed' });
    expect(commandCheck(failed).sentence).toMatch(/exited 3 .*1 test failed: adds numbers/);
    expect(failed.state).toBe('failed');
  });
});
