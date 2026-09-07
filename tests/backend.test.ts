import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { createApp } from '../server/app.js';
import {
  claimDataFolder,
  DataFolderInUse,
  inspectLock,
  LOCK_NAME,
  ownStartedAt,
  portListening,
  processAlive,
  processStartedAt,
  START_TIME_TOLERANCE_MS,
} from '../server/lock.js';
import { findTasks, hash, Store } from '../server/store.js';
import type { ProjectState } from '../shared/types.js';

// The Codex runtime is stubbed: no binary launches, no quota is spent. The stub
// reports a runtime engine the way `thread/start` metadata does, and its text is
// a valid empty file proposal so Codex Work runs reach `done`.
vi.mock('../server/integrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/integrations.js')>();
  return {
    ...actual,
    askCodex: async () => ({
      text: '{"summary":"A mocked proposal.","changes":[]}',
      model: 'gpt-6-astra',
      version: '0.153.4',
      threadId: 'mock-thread',
    }),
  };
});

let server: Server, app: Awaited<ReturnType<typeof createApp>>, temp: string, url: string;
const jsonHeaders = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function request(
  route: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = jsonHeaders,
) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function sample() {
  const result = await request('/projects/sample', 'POST', {});
  expect(result.status).toBe(200);
  return result.data.id as string;
}
async function state(id: string): Promise<ProjectState> {
  return (await request(`/projects/${id}/state`)).data;
}
async function until(id: string, predicate: (state: ProjectState) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await state(id);
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The sample worker did not reach its expected state.');
}
beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'backend-'));
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('real project files and durable history', () => {
  test('starts empty and creates three sample documents only when requested', async () => {
    expect((await request('/projects')).data.projects).toEqual([]);
    const id = await sample();
    const result = await state(id);
    expect(result.documents).toHaveLength(3);
    expect(result.history[0].sample).toBe(true);
    expect(await fs.readFile(path.join(result.project.folder, 'Fall menu.md'), 'utf8')).toContain(
      'Mushroom risotto',
    );
  });
  test('editor writes require the opened version, merge, restore, and undo a restore', async () => {
    const id = await sample();
    const document = (await request(`/projects/${id}/documents/read?path=Fall%20menu.md`)).data;
    const first = await request(`/projects/${id}/documents/write`, 'POST', {
      path: document.path,
      text: 'first',
      baseSha: document.sha,
    });
    expect(first.status).toBe(200);
    const stale = await request(`/projects/${id}/documents/write`, 'POST', {
      path: document.path,
      text: 'stale',
      baseSha: document.sha,
    });
    expect(stale.status).toBe(409);
    const second = await request(`/projects/${id}/documents/write`, 'POST', {
      path: document.path,
      text: 'second',
      baseSha: first.data.sha,
    });
    expect(second.data.entryId).toBe(first.data.entryId);
    const restored = await request(
      `/projects/${id}/history/${first.data.entryId}/restore`,
      'POST',
      {},
    );
    expect(restored.status).toBe(200);
    expect((await request(`/projects/${id}/documents/read?path=Fall%20menu.md`)).data.text).toBe(
      document.text,
    );
    const undone = await request(
      `/projects/${id}/history/${restored.data.entryId}/restore`,
      'POST',
      {},
    );
    expect(undone.status).toBe(200);
    expect((await request(`/projects/${id}/documents/read?path=Fall%20menu.md`)).data.text).toBe(
      'second',
    );
  });
  test('empty files are distinct from absent files across restore and redo', async () => {
    const id = await sample();
    const created = await request(`/projects/${id}/documents/create`, 'POST', {
      path: 'Empty.txt',
      text: '',
    });
    expect(created.status).toBe(200);
    expect(created.data.files[0].before).toBeNull();
    expect(created.data.files[0].after).toBe(hash(''));
    const restored = await request(
      `/projects/${id}/history/${created.data.id}/restore`,
      'POST',
      {},
    );
    expect(restored.status).toBe(200);
    expect((await request(`/projects/${id}/documents/read?path=Empty.txt`)).status).toBe(404);
    expect(
      (await request(`/projects/${id}/history/${restored.data.entryId}/restore`, 'POST', {}))
        .status,
    ).toBe(200);
    expect((await request(`/projects/${id}/documents/read?path=Empty.txt`)).data.text).toBe('');
  });
  test('preserves exact UTF-8 BOM and CRLF bytes through read, edit, and restore', async () => {
    const id = await sample(),
      current = await state(id),
      target = path.join(current.project.folder, 'BOM-and-CRLF.md');
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# Original\r\n\r\nTwo lines.\r\n', 'utf8'),
    ]);
    await fs.writeFile(target, original);
    const read = await request(`/projects/${id}/documents/read?path=BOM-and-CRLF.md`);
    expect(read.status).toBe(200);
    expect(read.data.text.charCodeAt(0)).toBe(0xfeff);
    expect(Buffer.from(read.data.text, 'utf8').equals(original)).toBe(true);
    const edited = await request(`/projects/${id}/documents/write`, 'POST', {
      path: 'BOM-and-CRLF.md',
      text: '# Edited\nChanged.\n',
      baseSha: read.data.sha,
    });
    expect(edited.status).toBe(200);
    expect(
      (await request(`/projects/${id}/history/${edited.data.entryId}/restore`, 'POST', {})).status,
    ).toBe(200);
    expect((await fs.readFile(target)).equals(original)).toBe(true);
  });
  test('detects outside changes and preserves overwritten contents before a forced restore', async () => {
    const id = await sample(),
      result = await state(id);
    const original = result.history[0];
    await fs.writeFile(path.join(result.project.folder, 'Fall menu.md'), 'outside work');
    const read = await request(`/projects/${id}/documents/read?path=Fall%20menu.md`);
    expect(read.data.outsideChange.kind).toBe('outside');
    const conflict = await request(`/projects/${id}/history/${original.id}/restore`, 'POST', {
      files: ['Fall menu.md'],
    });
    expect(conflict.status).toBe(409);
    expect(conflict.data.conflicts[0].path).toBe('Fall menu.md');
    const restore = await request(`/projects/${id}/history/${original.id}/restore`, 'POST', {
      files: ['Fall menu.md'],
      mode: 'all',
    });
    expect(restore.status).toBe(200);
    const history = (await state(id)).history;
    const saved = history.find((e) => e.kind === 'replaced-by-restore')!;
    const store: Store = app.locals.store;
    expect(await store.object(id, saved.files[0].before)).toBe('outside work');
  });
  test('restores copies without modifying newer files', async () => {
    const id = await sample();
    const first = (await request(`/projects/${id}/documents/read?path=Fall%20menu.md`)).data;
    const edited = await request(`/projects/${id}/documents/write`, 'POST', {
      path: first.path,
      baseSha: first.sha,
      text: 'new menu',
    });
    const copy = await request(`/projects/${id}/history/${edited.data.entryId}/restore`, 'POST', {
      mode: 'copies',
    });
    expect(copy.status).toBe(200);
    expect((await request(`/projects/${id}/documents/read?path=Fall%20menu.md`)).data.text).toBe(
      'new menu',
    );
    const name = copy.data.entry.files[0].path;
    expect(
      (await request(`/projects/${id}/documents/read?path=${encodeURIComponent(name)}`)).data.text,
    ).toBe(first.text);
  });
  test('concurrent stale saves admit one winner', async () => {
    const id = await sample(),
      first = (await request(`/projects/${id}/documents/read?path=Fall%20menu.md`)).data;
    const results = await Promise.all(
      ['one', 'two'].map((text) =>
        request(`/projects/${id}/documents/write`, 'POST', {
          path: first.path,
          baseSha: first.sha,
          text,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  test('a saved version restores the whole folder and later file removal can be undone', async () => {
    const id = await sample();
    const saved = await request(`/projects/${id}/history/label`, 'POST', {
      label: 'Before adding a document',
    });
    await request(`/projects/${id}/documents/create`, 'POST', {
      path: 'Later.md',
      text: 'Later work',
      kind: 'plan',
    });
    expect((await state(id)).project.plans).toContain('Later.md');
    expect(
      (await request(`/projects/${id}/history/${saved.data.id}/restore`, 'POST', {})).status,
    ).toBe(409);
    const restore = await request(`/projects/${id}/history/${saved.data.id}/restore`, 'POST', {
      mode: 'all',
    });
    expect(restore.status).toBe(200);
    expect((await request(`/projects/${id}/documents/read?path=Later.md`)).status).toBe(404);
    expect(
      (await request(`/projects/${id}/history/${restore.data.entryId}/restore`, 'POST', {})).status,
    ).toBe(200);
    expect((await request(`/projects/${id}/documents/read?path=Later.md`)).data.text).toBe(
      'Later work',
    );
  });
  test('rejects invalid task edits without leaving changes in memory', async () => {
    const id = await sample(),
      task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Original name' })).data;
    expect(
      (
        await request(`/projects/${id}/tasks/${task.id}`, 'PUT', {
          name: 'Must not survive',
          owner: 'invalid',
        })
      ).status,
    ).toBe(400);
    expect((await state(id)).tasks[0].name).toBe('Original name');
  });
  test('recovers a durable interrupted write and complete intended history on startup', async () => {
    const id = await sample(),
      store: Store = app.locals.store;
    const intended = structuredClone(store.state(id));
    const target = 'Recovered.txt',
      text = 'Recovered after interrupted save',
      sha = hash(text)!;
    const entry = store.addEntry(intended, { kind: 'edited', sentence: 'Recovery test' });
    entry.files.push({
      path: target,
      op: 'created',
      before: null,
      after: sha,
      recorded: true,
      reason: null,
    });
    await fs.writeFile(store.objectPath(id, sha), text);
    await fs.writeFile(
      path.join(temp, 'data', 'pending', 'test-recovery.json'),
      JSON.stringify({
        id: 'test-recovery',
        projectId: id,
        writes: [{ path: target, before: null, after: sha }],
        state: intended,
      }),
    );
    const restarted = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
    await restarted.init();
    expect(await restarted.current(id, target)).toBe(text);
    expect(restarted.state(id).history.at(-1)?.id).toBe(entry.id);
    expect(await fs.readdir(path.join(temp, 'data', 'pending'))).toEqual([]);
  });
});

describe('task, approval, sample worker, and review flow', () => {
  test('parser skips done tasks and code blocks and retains person ownership', () => {
    expect(
      findTasks(
        '1. update menu\n- [ ] call supplier\n- [x] done\n* Tagged task T4\n```\n- not a task\n```',
      ),
    ).toEqual([
      { line: 1, name: 'Update menu', owner: 'diomedes-with-ok' },
      { line: 2, name: 'Call supplier', owner: 'you' },
    ]);
  });
  test('finds real plan tasks, adds suffixes, and prevents duplicate tasks', async () => {
    const id = await sample();
    const found = (
      await request(`/projects/${id}/plans/find-tasks`, 'POST', { path: 'Reopening plan.md' })
    ).data.found;
    expect(found).toHaveLength(4);
    const added = await request(`/projects/${id}/plans/add-tasks`, 'POST', {
      path: 'Reopening plan.md',
      items: found,
    });
    expect(added.data.tasks).toHaveLength(4);
    expect(
      (await request(`/projects/${id}/plans/find-tasks`, 'POST', { path: 'Reopening plan.md' }))
        .data.found,
    ).toEqual([]);
  });
  test('approval propagates, disallows concurrent sessions, finishes real writes, and Keep all completes task', async () => {
    const id = await sample(),
      task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Update the menu' })).data;
    const started = await request(`/projects/${id}/work/start`, 'POST', { taskId: task.id });
    expect(started.data.state).toBe('waiting');
    expect((await request(`/projects/${id}/work/start`, 'POST', { taskId: task.id })).status).toBe(
      409,
    );
    let current = await state(id);
    const initial = current.needs.find((n) => n.state === 'open')!;
    expect(current.project.status.needsYou).toBe(1);
    expect(current.tasks[0].needId).toBe(initial.id);
    expect(
      (
        await request(`/projects/${id}/needs/${initial.id}/resolve`, 'POST', {
          resolution: 'go-ahead',
          allowForTask: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/projects/${id}/needs/${initial.id}/resolve`, 'POST', {
          resolution: 'go-ahead',
        })
      ).status,
    ).toBe(409);
    current = await until(id, (s) => s.sessions[0].state === 'done');
    expect(current.changes).toHaveLength(2);
    expect(current.changes.every((c) => c.changedSince === null)).toBe(true);
    expect(current.project.status.needsYou).toBe(0);
    expect(
      (
        await request(`/projects/${id}/review/all`, 'POST', {
          action: 'keep',
          sessionId: started.data.id,
        })
      ).status,
    ).toBe(200);
    expect((await state(id)).tasks[0].state).toBe('done');
  });
  test('declines file creation while continuing the recorded plan update', async () => {
    await request('/settings', 'PUT', { permissions: { changingFiles: false } });
    const id = await sample(),
      task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Update plan' })).data;
    await request(`/projects/${id}/work/start`, 'POST', { taskId: task.id });
    let current = await until(id, (s) => s.needs.some((n) => n.state === 'open'));
    const need = current.needs.find((n) => n.state === 'open')!;
    await request(`/projects/${id}/needs/${need.id}/resolve`, 'POST', { resolution: 'declined' });
    current = await until(id, (s) => s.sessions[0].state === 'done');
    expect(current.changes).toHaveLength(1);
    expect(current.documents.some((d) => d.path === 'Sample work notes.md')).toBe(false);
  });
  test('stop expires needs immediately and fault preserves its partial changes', async () => {
    const id = await sample(),
      task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Fault sample' })).data;
    const stopped = await request(`/projects/${id}/work/start`, 'POST', { taskId: task.id });
    await request(`/projects/${id}/work/${stopped.data.id}/stop`, 'POST', {});
    expect((await state(id)).needs[0].state).toBe('expired');
    const started = await request(`/projects/${id}/work/start`, 'POST', {
      taskId: task.id,
      demo: 'fault',
    });
    const need = (await state(id)).needs.find((n) => n.state === 'open')!;
    await request(`/projects/${id}/needs/${need.id}/resolve`, 'POST', {
      resolution: 'go-ahead',
      allowForTask: true,
    });
    const current = await until(
      id,
      (s) => s.sessions.find((session) => session.id === started.data.id)?.state === 'failed',
    );
    expect(current.changes).toHaveLength(1);
    expect(current.tasks[0].reason).toBe('went-wrong');
  });
});

describe('request and filesystem boundaries', () => {
  test('rejects foreign/null origins, missing custom headers, and DNS-rebinding hosts', async () => {
    expect(
      (
        await request(
          '/settings',
          'PUT',
          { detail: 'standard' },
          { 'Content-Type': 'application/json', 'X-Diomedes-Client': '' },
        )
      ).status,
    ).toBe(403);
    for (const origin of ['null', 'http://evil.example', 'http://127.0.0.1.evil.example:5173'])
      expect(
        (await request('/settings', 'GET', undefined, { ...jsonHeaders, Origin: origin })).status,
      ).toBe(403);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        `${url}/api/settings`,
        { headers: { Host: 'evil.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
  test('rejects path traversal, credential stores, junctions, and reserved names', async () => {
    const id = await sample(),
      result = await state(id);
    for (const name of ['../escape.txt', '.git/config', '.codex/auth.json', '.env', 'CON.txt'])
      expect(
        (await request(`/projects/${id}/documents/create`, 'POST', { path: name, text: 'bad' }))
          .status,
      ).toBeGreaterThanOrEqual(400);
    const outside = path.join(temp, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(result.project.folder, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(
      (
        await request(`/projects/${id}/documents/create`, 'POST', {
          path: 'linked/escape.txt',
          text: 'bad',
        })
      ).status,
    ).toBe(403);
    expect(await fs.readdir(outside)).toEqual([]);
  });
  test('settings survive restart and every supported appearance validates', async () => {
    for (const name of ['deep-field', 'cobalt', 'graphite', 'verdigris', 'paper'])
      expect((await request('/settings', 'PUT', { appearance: { package: name } })).status).toBe(
        200,
      );
    await request('/settings', 'PUT', { detail: 'technical', onboarding: { resumeAt: 'q2' } });
    const restarted = new Store(path.join(temp, 'data'));
    await restarted.init();
    expect(restarted.settings.detail).toBe('technical');
    expect(restarted.settings.onboarding.resumeAt).toBe('q2');
    expect((await request('/settings', 'PUT', { detail: 'invented' })).status).toBe(400);
  });
});

describe('threads are first-class conversations', () => {
  test('old state without thread fields loads with fields filled and stays stable', async () => {
    const id = await sample();
    const task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Fix patio' })).data;
    const statePath = path.join(temp, 'data', 'projects', id, 'state.json');
    const raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const longText =
      'Hello world this is a very long first message that should be trimmed at a word boundary properly for the thread name';
    raw.conversations = [
      {
        id: 'Clegacy1',
        attachedTo: { kind: 'project', ref: id },
        turns: [
          {
            id: 'U1',
            role: 'you',
            mode: 'ask',
            text: longText,
            at: '2026-01-01T00:00:00.000Z',
            sources: [],
          },
          {
            id: 'U2',
            role: 'diomedes',
            mode: 'ask',
            text: 'reply',
            at: '2026-01-02T00:00:00.000Z',
            sources: [],
          },
        ],
      },
      { id: 'Clegacy2', attachedTo: { kind: 'project', ref: id }, turns: [] },
      {
        id: 'Clegacy3',
        attachedTo: { kind: 'task', ref: task.id },
        turns: [
          {
            id: 'U3',
            role: 'you',
            mode: 'ask',
            text: 'task question',
            at: '2026-01-03T00:00:00.000Z',
            sources: [],
          },
        ],
      },
    ];
    await fs.writeFile(statePath, JSON.stringify(raw));
    const reloaded = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
    await reloaded.init();
    const byId = new Map(reloaded.state(id).conversations.map((c) => [c.id, c]));
    const first = byId.get('Clegacy1')!;
    expect(first.name!.length).toBeLessThanOrEqual(60);
    expect(longText.startsWith(first.name!)).toBe(true);
    expect(first.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(first.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(first.taskId).toBeNull();
    expect(first.helper).toBeNull();
    const empty = byId.get('Clegacy2')!;
    expect(empty.name).toBe('New thread');
    expect(typeof empty.createdAt).toBe('string');
    expect(empty.updatedAt).toBe(empty.createdAt);
    expect(empty.taskId).toBeNull();
    expect(empty.helper).toBeNull();
    const taskThread = byId.get('Clegacy3')!;
    expect(taskThread.name).toBe('Thread for Fix patio');
    expect(taskThread.taskId).toBe(task.id);
    expect(taskThread.createdAt).toBe('2026-01-03T00:00:00.000Z');
    expect(taskThread.updatedAt).toBe('2026-01-03T00:00:00.000Z');
    const snapshot = JSON.stringify(reloaded.state(id).conversations);
    const reloadedAgain = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
    await reloadedAgain.init();
    expect(JSON.stringify(reloadedAgain.state(id).conversations)).toBe(snapshot);
  });
  test("settings without surface get 'book' (standard) and 'desk' (technical)", async () => {
    const settingsPath = path.join(temp, 'data', 'settings.json');
    await request('/settings', 'PUT', { detail: 'standard' });
    let raw = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    delete raw.surface;
    raw.detail = 'standard';
    await fs.writeFile(settingsPath, JSON.stringify(raw));
    let reloaded = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
    await reloaded.init();
    expect(reloaded.settings.detail).toBe('standard');
    expect(reloaded.settings.surface).toBe('book');
    raw = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    delete raw.surface;
    raw.detail = 'technical';
    await fs.writeFile(settingsPath, JSON.stringify(raw));
    reloaded = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
    await reloaded.init();
    expect(reloaded.settings.detail).toBe('technical');
    expect(reloaded.settings.surface).toBe('desk');
  });
  test('POST /threads creates, PUT renames, GET lists newest-updated first', async () => {
    const id = await sample();
    const first = await request(`/projects/${id}/threads`, 'POST', { name: 'First thread' });
    expect(first.status).toBe(201);
    expect(first.data.name).toBe('First thread');
    expect(first.data.turns).toEqual([]);
    expect(first.data.attachedTo).toEqual({ kind: 'project', ref: id });
    expect(first.data.taskId).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Patio task' })).data;
    const forTask = await request(`/projects/${id}/threads`, 'POST', { taskId: task.id });
    expect(forTask.status).toBe(201);
    expect(forTask.data.attachedTo).toEqual({ kind: 'task', ref: task.id });
    expect(forTask.data.name).toBe('Thread for Patio task');
    const renamed = await request(`/projects/${id}/threads/${first.data.id}`, 'PUT', {
      name: 'Renamed thread',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.data.name).toBe('Renamed thread');
    expect(
      (await request(`/projects/${id}/threads/${first.data.id}`, 'PUT', { name: '   ' })).status,
    ).toBe(400);
    expect(
      (await request(`/projects/${id}/threads/Cmissing`, 'PUT', { name: 'Nope' })).status,
    ).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await request(`/projects/${id}/ask`, 'POST', {
      mode: 'ask',
      text: 'Bump the first thread',
      threadId: first.data.id,
    });
    const listed = await request(`/projects/${id}/threads`);
    expect(listed.status).toBe(200);
    expect(listed.data.threads.map((t: { id: string }) => t.id)).toEqual([
      first.data.id,
      forTask.data.id,
    ]);
  });
  test('POST /ask with threadId appends to that thread and bumps updatedAt', async () => {
    const id = await sample();
    const created = await request(`/projects/${id}/threads`, 'POST', {});
    expect(created.status).toBe(201);
    expect(created.data.name).toBe('New thread');
    const before = created.data.updatedAt as string;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const answer = await request(`/projects/${id}/ask`, 'POST', {
      mode: 'ask',
      text: 'Hello from the thread test',
      threadId: created.data.id,
    });
    expect(answer.status).toBe(200);
    expect(answer.data.conversation.id).toBe(created.data.id);
    expect(answer.data.conversation.turns).toHaveLength(2);
    expect(answer.data.conversation.attachedTo).toEqual({ kind: 'project', ref: id });
    expect(answer.data.conversation.name).toBe('Hello from the thread test');
    expect(answer.data.conversation.updatedAt > before).toBe(true);
    expect(
      (
        await request(`/projects/${id}/ask`, 'POST', {
          mode: 'ask',
          text: 'missing thread',
          threadId: 'Cmissing',
        })
      ).status,
    ).toBe(404);
    const workThread = (await request(`/projects/${id}/threads`, 'POST', {})).data;
    const work = await request(`/projects/${id}/ask`, 'POST', {
      mode: 'work',
      text: 'Do some thread work',
      threadId: workThread.id,
    });
    expect(work.status).toBe(200);
    expect(work.data.conversation.id).toBe(workThread.id);
    expect(work.data.conversation.taskId).toBeTruthy();
  });
  test('Work task names use the trimmed first line at an 80-character word boundary', async () => {
    const cases = [
      {
        firstLine: `  ${'Plan '.repeat(15)}finishing touches  `,
        name: 'Plan '.repeat(15).trim(),
      },
      { firstLine: `  ${'Plan '.repeat(15)}steps follow  `, name: `${'Plan '.repeat(15)}steps` },
      { firstLine: '  Short task name  ', name: 'Short task name' },
    ];
    for (const { firstLine, name } of cases) {
      const id = await sample();
      const thread = (await request(`/projects/${id}/threads`, 'POST', {})).data;
      const text = `${firstLine}\r\nKeep every detail in the task description.\nIncluding this line.`;
      const work = await request(`/projects/${id}/ask`, 'POST', {
        mode: 'work',
        text,
        threadId: thread.id,
      });
      expect(work.status).toBe(200);
      const task = (await state(id)).tasks.find(
        (item) => item.id === work.data.conversation.taskId,
      );
      expect(task?.name).toBe(name);
      expect(task?.description).toBe(text);
    }
  });
  test('threads default to show-first, PUT sets task, and full is rejected', async () => {
    const id = await sample();
    const created = await request(`/projects/${id}/threads`, 'POST', {});
    expect(created.status).toBe(201);
    expect(created.data.permission).toBe('show-first');
    const explicit = await request(`/projects/${id}/threads`, 'POST', { permission: 'task' });
    expect(explicit.status).toBe(201);
    expect(explicit.data.permission).toBe('task');
    const updated = await request(`/projects/${id}/threads/${created.data.id}`, 'PUT', {
      permission: 'task',
    });
    expect(updated.status).toBe(200);
    expect(updated.data.permission).toBe('task');
    expect(updated.data.id).toBe(created.data.id);
    const rejected = await request(`/projects/${id}/threads/${created.data.id}`, 'PUT', {
      permission: 'full',
    });
    expect(rejected.status).toBe(400);
    expect(rejected.data.error).toBe('That permission mode is not available in this version.');
    const rejectedPost = await request(`/projects/${id}/threads`, 'POST', {
      permission: 'full',
    });
    expect(rejectedPost.status).toBe(400);
    expect(rejectedPost.data.error).toBe('That permission mode is not available in this version.');
    const listed = await request(`/projects/${id}/threads`);
    expect(listed.status).toBe(200);
    for (const thread of listed.data.threads) expect(thread.permission).toBeDefined();
    const current = await state(id);
    for (const conversation of current.conversations) expect(conversation.permission).toBeDefined();
  });
  test('migration fills missing thread permission with show-first and stays stable', async () => {
    const id = await sample();
    const statePath = path.join(temp, 'data', 'projects', id, 'state.json');
    const raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
    raw.conversations = [{ id: 'Cperm1', attachedTo: { kind: 'project', ref: id }, turns: [] }];
    await fs.writeFile(statePath, JSON.stringify(raw));
    const reloaded = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
    await reloaded.init();
    expect(reloaded.state(id).conversations[0].permission).toBe('show-first');
    const snapshot = JSON.stringify(reloaded.state(id).conversations);
    const reloadedAgain = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
    await reloadedAgain.init();
    expect(JSON.stringify(reloadedAgain.state(id).conversations)).toBe(snapshot);
  });
  test('work sessions carry the thread permission, defaulting to show-first', async () => {
    const id = await sample();
    const thread = (await request(`/projects/${id}/threads`, 'POST', { permission: 'task' })).data;
    const task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Thread work' })).data;
    const started = await request(`/projects/${id}/work/start`, 'POST', {
      taskId: task.id,
      threadId: thread.id,
    });
    expect(started.status).toBe(200);
    expect(started.data.permission).toBe('task');
    expect((await state(id)).sessions[0].permission).toBe('task');
    const other = await sample();
    const otherTask = (
      await request(`/projects/${other}/tasks`, 'POST', { name: 'No thread work' })
    ).data;
    const plain = await request(`/projects/${other}/work/start`, 'POST', {
      taskId: otherTask.id,
    });
    expect(plain.status).toBe(200);
    expect(plain.data.permission).toBe('show-first');
    const askProject = await sample();
    const askThread = (
      await request(`/projects/${askProject}/threads`, 'POST', { permission: 'task' })
    ).data;
    const askWork = await request(`/projects/${askProject}/ask`, 'POST', {
      mode: 'work',
      text: 'Do ask work from a task thread',
      threadId: askThread.id,
    });
    expect(askWork.status).toBe(200);
    expect(askWork.data.session.permission).toBe('task');
  });
});

describe('request and filesystem boundaries (continued)', () => {
  test('sample Ask is honest, sample Plan writes a real file, and Codex requires explicit settings and consent', async () => {
    const id = await sample();
    const answer = await request(`/projects/${id}/ask`, 'POST', {
      mode: 'ask',
      text: 'What should we do?',
    });
    expect(answer.data.turn.text).toContain('cannot answer yet');
    const plan = await request(`/projects/${id}/ask`, 'POST', {
      mode: 'plan',
      text: 'Reopen the patio',
    });
    expect(plan.data.document).toBe('Reopen the patio.md');
    expect(
      (await request(`/projects/${id}/documents/read?path=Reopen%20the%20patio.md`)).data.text,
    ).toContain('Sample plan written without a service');
    expect(
      (await request(`/projects/${id}/ask`, 'POST', { route: 'codex', mode: 'ask', text: 'test' }))
        .status,
    ).toBe(409);
    await request('/settings', 'PUT', { services: { codex: true } });
    const consent = await request(`/projects/${id}/ask`, 'POST', {
      route: 'codex',
      mode: 'ask',
      text: 'test',
    });
    expect(consent.data.consentRequired).toBe(true);
    expect(
      (await request(`/projects/${id}/work/start`, 'POST', { route: 'codex', taskId: 'T1' }))
        .status,
    ).toBe(409);
  });
});

describe('the data folder lock tells a live owner from a reused pid', () => {
  const folder = async () => {
    const dir = path.join(temp, `lock-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };
  const write = async (dir: string, record: Record<string, unknown>) => {
    await fs.writeFile(path.join(dir, LOCK_NAME), JSON.stringify(record));
    return path.join(dir, LOCK_NAME);
  };
  const read = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
  // The suite's own server gives a port that is genuinely accepting connections.
  const livePort = () => (server.address() as AddressInfo).port;
  const deadPid = () =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('exit', () => resolve(child.pid as number));
    });

  test('this platform reports its own start time, and a loopback port is testable', async () => {
    const measured = await processStartedAt(process.pid);
    expect(measured).not.toBeNull();
    expect(Math.abs((measured as number) - ownStartedAt())).toBeLessThanOrEqual(
      START_TIME_TOLERANCE_MS,
    );
    expect(await portListening(livePort())).toBe(true);
    // Borrow a port, then hand it back, so nothing is listening on it.
    const spare = createServer();
    await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
    const idle = (spare.address() as AddressInfo).port;
    await new Promise<void>((resolve) => spare.close(() => resolve()));
    expect(await portListening(idle, 200)).toBe(false);
  });

  test('a live pid whose start time matches still owns the folder', async () => {
    const dir = await folder();
    const file = await write(dir, {
      pid: process.pid,
      startedAt: ownStartedAt(),
      port: livePort(),
    });
    expect(await inspectLock(await read(file))).toEqual({
      held: true,
      reason: 'start-time-match',
    });
    await expect(claimDataFolder(dir)).rejects.toBeInstanceOf(DataFolderInUse);
    await expect(claimDataFolder(dir)).rejects.toThrow(
      `Another process (${process.pid}) holds this Diomedes data folder.`,
    );
    // A refused claim must leave the owner's lock exactly as it found it.
    expect((await read(file)).pid).toBe(process.pid);
  });

  test('a live pid whose start time differs is a reused pid, so the lock is stale', async () => {
    const dir = await folder();
    // A listening port as well, to prove the start time settles it on its own.
    const file = await write(dir, {
      pid: process.pid,
      startedAt: ownStartedAt() - 60 * 60 * 1000,
      port: livePort(),
    });
    expect(await inspectLock(await read(file))).toEqual({
      held: false,
      reason: 'start-time-mismatch',
    });
    const claim = await claimDataFolder(dir, { port: 47631 });
    const replaced = await read(file);
    expect(replaced.pid).toBe(process.pid);
    expect(replaced.port).toBe(47631);
    expect(typeof replaced.token).toBe('string');
    expect(Math.abs(replaced.startedAt - ownStartedAt())).toBeLessThanOrEqual(
      START_TIME_TOLERANCE_MS,
    );
    await claim.release();
    expect(
      await fs.access(file).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test('a dead pid leaves a stale lock that a new start clears', async () => {
    const dir = await folder();
    const pid = await deadPid();
    expect(processAlive(pid)).toBe(false);
    const file = await write(dir, { pid, startedAt: ownStartedAt(), port: livePort() });
    expect((await inspectLock(await read(file))).held).toBe(false);
    const claim = await claimDataFolder(dir);
    expect((await read(file)).pid).toBe(process.pid);
    await claim.release();
  });

  test('an unreadable start time falls back to the recorded port', async () => {
    const probes = { alive: () => true, startedAt: async () => null };
    expect(
      await inspectLock(
        { pid: 4242, startedAt: 1, port: 47631 },
        { ...probes, listening: async () => true },
      ),
    ).toEqual({ held: true, reason: 'port-active' });
    expect(
      await inspectLock(
        { pid: 4242, startedAt: 1, port: 47631 },
        { ...probes, listening: async () => false },
      ),
    ).toEqual({ held: false, reason: 'port-idle' });
    // A lock with neither signal is left alone rather than risking two owners.
    expect(await inspectLock({ pid: 4242 }, probes)).toEqual({
      held: true,
      reason: 'unverifiable',
    });
  });

  test('a corrupt or pidless lock is cleared instead of blocking a start', async () => {
    const dir = await folder();
    const file = path.join(dir, LOCK_NAME);
    await fs.writeFile(file, 'not json at all');
    const claim = await claimDataFolder(dir, { port: livePort() });
    expect((await read(file)).pid).toBe(process.pid);
    await claim.release();
    expect(await inspectLock({ pid: 0 })).toEqual({ held: false, reason: 'unreadable' });
  });
});

describe('verified helper is stored with every turn and session', () => {
  test('a Codex Ask turn carries the runtime-reported helper', async () => {
    await request('/settings', 'PUT', { services: { codex: true } });
    const id = await sample();
    const answer = await request(`/projects/${id}/ask`, 'POST', {
      mode: 'ask',
      text: 'What should we do?',
      route: 'codex',
      consent: true,
    });
    expect(answer.status).toBe(200);
    expect(answer.data.turn.helper).toEqual({
      engine: 'codex',
      model: 'gpt-6-astra',
      version: '0.153.4',
      verified: true,
    });
    expect(answer.data.conversation.helper).toEqual({ engine: 'codex', model: 'gpt-6-astra' });
  });
  test('a Codex Plan names the verified helper in its History sentence', async () => {
    await request('/settings', 'PUT', { services: { codex: true } });
    const id = await sample();
    const plan = await request(`/projects/${id}/ask`, 'POST', {
      mode: 'plan',
      text: 'Reopen the patio',
      route: 'codex',
      consent: true,
    });
    expect(plan.status).toBe(200);
    expect(plan.data.turn.helper).toMatchObject({
      engine: 'codex',
      model: 'gpt-6-astra',
      verified: true,
    });
    const current = await state(id);
    const entry = current.history.find(
      (item) => item.kind === 'edited' && item.sentence.includes(plan.data.document),
    );
    expect(entry?.sentence).toContain('Diomedes, with Codex gpt-6-astra');
  });
  test("sample work carries engine 'sample' with verified true on the turn and session", async () => {
    const id = await sample();
    const work = await request(`/projects/${id}/ask`, 'POST', {
      mode: 'work',
      text: 'Do some sample work',
    });
    expect(work.status).toBe(200);
    expect(work.data.turn.helper).toEqual({
      engine: 'sample',
      model: null,
      version: null,
      verified: true,
    });
    expect(work.data.session.engine).toMatchObject({ verified: true });
  });
  test('Codex Work marks the session engine and the thread turn verified once the runtime reports', async () => {
    await request('/settings', 'PUT', { services: { codex: true } });
    const id = await sample();
    const started = await request(`/projects/${id}/ask`, 'POST', {
      mode: 'work',
      text: 'Do some Codex work',
      route: 'codex',
      consent: true,
    });
    expect(started.status).toBe(200);
    const sessionId = started.data.session.id as string;
    const turnId = started.data.turn.id as string;
    const current = await until(
      id,
      (candidates) =>
        ['done', 'failed', 'stopped'].includes(
          candidates.sessions.find((item) => item.id === sessionId)?.state ?? '',
        ),
    );
    const session = current.sessions.find((item) => item.id === sessionId)!;
    expect(session.state).toBe('done');
    expect(session.engine).toMatchObject({
      model: 'gpt-6-astra',
      version: '0.153.4',
      verified: true,
    });
    const conversation = current.conversations.find((item) =>
      item.turns.some((turn) => turn.id === turnId),
    )!;
    expect(conversation.turns.find((turn) => turn.id === turnId)?.helper).toMatchObject({
      engine: 'codex',
      model: 'gpt-6-astra',
      verified: true,
    });
  });
});
