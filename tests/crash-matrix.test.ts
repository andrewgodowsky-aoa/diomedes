/**
 * H21 crash-recovery matrix.
 *
 * One row per durable write boundary: a real child process
 * (`tests/crash-matrix-child.ts`) acknowledges one operation, starts a second
 * and SIGKILLs itself at the boundary. This process then restarts the same
 * data folder and checks three things for every row:
 *
 * - consistent: the restarted store opens, nothing is left half-prepared, and
 *   every record points at bytes that exist and match their digest;
 * - nothing acknowledged is lost;
 * - nothing is duplicated - the in-flight operation took effect once or not
 *   at all, and which one is pinned per row.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hash, Store } from '../server/store.js';
import { AutomationOccurrences } from '../server/automations.js';
import { backupPath } from '../server/migrations/files.js';
import { createApp } from '../server/app.js';
import type { ProjectState, Task } from '../shared/types.js';
import { CRASH_TEXT, crashOccurrence, type CrashBoundary } from './crash-matrix-shared.js';

let root: string;
const data = () => path.join(root, 'data');
const projects = () => path.join(root, 'projects');

beforeEach(async () => {
  await fs.mkdir('test-results', { recursive: true });
  root = await fs.mkdtemp(path.resolve('test-results', 'crash-matrix-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Runs the child to its boundary and proves it died there, not somewhere else. */
async function crash(scenario: string, boundary: CrashBoundary, projectId = '') {
  const output: string[] = [];
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/crash-matrix-child.ts', root, scenario, boundary, projectId],
      { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (chunk) => output.push(String(chunk)));
    child.stderr.on('data', (chunk) => output.push(String(chunk)));
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`The crash child did not reach ${boundary}. ${output.join('')}`));
    }, 45_000);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  expect(await fs.readFile(path.join(root, 'reached'), 'utf8').catch(() => null), output.join('')).toBe(boundary);
  // POSIX reports the signal; Windows reports the forced exit as code 1.
  if (process.platform === 'win32') expect(exit.code).not.toBe(0);
  else expect(exit.signal, output.join('')).toBe('SIGKILL');
  const acks = await fs.readFile(path.join(root, 'acks.jsonl'), 'utf8').catch(() => '');
  return acks.split('\n').filter(Boolean).map((line) => JSON.parse(line) as string);
}

describe('project writes: object, journal, project file, state file', () => {
  async function seed() {
    const store = new Store(data(), projects());
    await store.init();
    const project = await store.createProject('Crash');
    await store.writeRecorded(project.id, [{ path: 'Notes.md', text: CRASH_TEXT.zero, expected: null }]);
    return project.id;
  }

  // What the in-flight write becomes after restart. Before its journal is
  // durable it never happened; from then on recovery finishes it, once.
  const rows: [CrashBoundary, 'absent' | 'applied'][] = [
    ['object-write', 'absent'],
    ['journal-append', 'applied'],
    ['project-file', 'applied'],
    ['state-temp', 'applied'],
    ['state-rename', 'applied'],
    ['journal-unlink', 'applied'],
  ];

  test.each(rows)('killed at %s: the in-flight write is %s, the acknowledged one kept', async (boundary, outcome) => {
    const projectId = await seed();
    expect(await crash('store', boundary, projectId)).toEqual(['one']);

    const store = new Store(data(), projects());
    await store.init();
    const state = store.state(projectId);
    // Nothing is left half-prepared.
    expect(await fs.readdir(path.join(data(), 'pending'))).toEqual([]);
    // Every recorded version exists and matches its name.
    const shas = state.history.flatMap((entry) => entry.files.flatMap((file) => [file.before, file.after]));
    for (const sha of shas.filter((item): item is string => item !== null))
      await expect(store.object(projectId, sha)).resolves.toEqual(expect.any(String));
    expect(new Set(state.history.map((entry) => entry.id)).size).toBe(state.history.length);

    const recorded = (text: string) =>
      state.history.filter((entry) => entry.files.some((file) => file.path === 'Notes.md' && file.after === hash(text)));
    expect(recorded(CRASH_TEXT.zero)).toHaveLength(1);
    expect(recorded(CRASH_TEXT.one)).toHaveLength(1);
    expect(recorded(CRASH_TEXT.two)).toHaveLength(outcome === 'applied' ? 1 : 0);
    // The file on disk is what the newest record says it is.
    const onDisk = await fs.readFile(path.join(state.project.folder, 'Notes.md'), 'utf8');
    expect(onDisk).toBe(outcome === 'applied' ? CRASH_TEXT.two : CRASH_TEXT.one);
    const latest = state.history.filter((entry) => entry.files.some((file) => file.path === 'Notes.md')).at(-1)!;
    expect(latest.files.find((file) => file.path === 'Notes.md')!.after).toBe(hash(onDisk));

    // A second restart changes nothing: recovery is idempotent.
    const again = new Store(data(), projects());
    await again.init();
    expect(again.state(projectId).history.map((entry) => entry.id)).toEqual(state.history.map((entry) => entry.id));
  }, 60_000);
});

describe('automation occurrences and their migration', () => {
  const file = () => path.join(data(), 'workspaces', 'automations', 'org_crash.json');

  test.each([
    ['occurrence-temp', ['one']],
    ['occurrence-rename', ['one', 'two']],
  ] as const)('killed at %s: the file holds %j, each once', async (boundary, expected) => {
    expect(await crash('occurrence', boundary)).toEqual(['one']);
    const occurrences = new AutomationOccurrences(data());
    await occurrences.init();
    expect(occurrences.isUnreadable('org_crash')).toBe(false);
    expect(occurrences.list('org_crash').map((item) => item.trigger.commandId)).toEqual(expected);
    // The file itself parses and names the current version.
    expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toMatchObject({ v: 2, organizationId: 'org_crash' });
  }, 60_000);

  test.each(['migration-backup', 'migration-rewrite'] as const)(
    'killed at %s: the next open finishes the migration with one backup of the original',
    async (boundary) => {
      await fs.mkdir(path.dirname(file()), { recursive: true });
      const original = JSON.stringify({ v: 1, organizationId: 'org_crash', occurrences: [crashOccurrence('old')] });
      await fs.writeFile(file(), original);
      expect(await crash('occurrence', boundary)).toEqual([]);

      const occurrences = new AutomationOccurrences(data());
      await occurrences.init();
      expect(occurrences.list('org_crash').map((item) => item.trigger.commandId)).toEqual(['old']);
      expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toMatchObject({ v: 2 });
      const backups = (await fs.readdir(path.dirname(file()))).filter((name) => name.endsWith('.bak'));
      expect(backups).toEqual([path.basename(backupPath(file(), 1, original))]);
      expect(await fs.readFile(backupPath(file(), 1, original), 'utf8')).toBe(original);
    },
    60_000,
  );
});

describe('Ready queue claims', () => {
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: Server | undefined;
  let url = '';
  async function launch() {
    app = await createApp({
      dataDir: data(),
      projectRoot: projects(),
      stepMs: 20,
      nativeGenerator: async () => ({
        model: 'deterministic-fixture',
        version: 'fixture-1',
        text: JSON.stringify({ summary: 'Nothing.', changes: [] }),
      }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  }
  async function close() {
    if (!server || !app) return;
    const [closingApp, closingServer] = [app, server];
    server = app = undefined;
    try {
      await closingApp.locals.close();
    } finally {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => closingServer.close((e) => (e ? reject(e) : resolve())));
    }
  }
  const request = async <T>(route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return (await response.json()) as T;
  };
  afterEach(close);

  test.each(['claim-temp', 'claim-rename'] as const)(
    'killed at %s: after restart the task starts exactly once',
    async (boundary) => {
      await launch();
      const { id: projectId } = await request<{ id: string }>('/projects/sample', 'POST', {});
      const state = (): ProjectState => app!.locals.store.state(projectId);
      for (const task of state().tasks.filter((item) => !item.deletedAt))
        await request(`/projects/${projectId}/tasks/${task.id}`, 'DELETE');
      const task = await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Once only' });
      await close();

      await crash('claim', boundary, projectId);
      const saved = JSON.parse(
        await fs.readFile(path.join(data(), 'projects', projectId, 'state.json'), 'utf8'),
      ) as ProjectState;
      // The boundary really was where the claim becomes durable.
      expect(saved.readyQueue?.claims ?? []).toHaveLength(boundary === 'claim-temp' ? 0 : 1);
      expect(saved.sessions.filter((s) => s.taskId === task.id)).toEqual([]);

      await launch();
      for (let n = 0; n < 300 && !state().sessions.some((s) => s.taskId === task.id); n++) {
        await app!.locals.readyScheduler.settled();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (let n = 0; n < 5; n++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await app!.locals.readyScheduler.settled();
      }
      const sessions = state().sessions.filter((s) => s.taskId === task.id);
      expect(sessions).toHaveLength(1);
      expect(state().readyQueue!.claims).toHaveLength(1);
      expect(state().readyQueue!.claims[0]).toMatchObject({ state: 'started', sessionId: sessions[0]!.id });
      expect(sessions[0]!.receipt?.commandId).toBe(state().readyQueue!.claims[0]!.commandId);
    },
    90_000,
  );
});
