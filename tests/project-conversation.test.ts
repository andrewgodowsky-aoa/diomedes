import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import type { Store } from '../server/store';
import { diomedesThread } from '../shared/diomedes-thread';
import type { Conversation, Project, ProjectState } from '../shared/types';

// A project's own Diomedes conversation, provisioned on the Nectovia default (2026-09-25),
// through the real app over HTTP: the real Store, the real settings file, the real routes, and no
// provider at all, because nothing here sends a message. `close()` then `open()` over the same
// data directory is a crash and a restart.
// Nothing provisions a conversation except a POST to the project's conversation route.

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;

async function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
async function open() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    // No discovery reaches this machine, and no work runs: a test that tries fails loudly.
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    nativeGenerator: async () => {
      throw new Error('No native work runs in this fixture');
    },
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
}
const store = () => app.locals.store as Store;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-project-conversation-'));
  await open();
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

type Binding = { projectId: string; threadId: string };
const project = (name: string) => api<Project>('/projects', 'POST', { name });
const provision = (projectId: string) => api<Binding>(`/projects/${projectId}/conversation`, 'POST');
const threadsOf = (projectId: string) => store().state(projectId).conversations;
const byId = (projectId: string, threadId: string) =>
  threadsOf(projectId).find((thread) => thread.id === threadId)!;

/** A thread written straight into the records, so its stamp and its id are the test's to choose. */
const seeded = (projectId: string, over: Partial<Conversation> & { id: string }): Conversation => ({
  attachedTo: { kind: 'project', ref: projectId },
  turns: [],
  name: 'Seeded',
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
  taskId: null,
  helper: null,
  permission: 'show-first',
  mode: 'auto',
  ...over,
});
async function seed(projectId: string, threads: Conversation[]) {
  const state = store().state(projectId);
  for (const thread of threads) state.conversations.push(thread);
  await store().persist(state);
}

test('two first sends at once reach one conversation, not two', async () => {
  // Five fresh projects: a lucky ordering once is not five times.
  for (let round = 0; round < 5; round += 1) {
    const mine = await project(`Race ${round}`);
    const [first, second] = await Promise.all([provision(mine.id), provision(mine.id)]);
    expect(second).toEqual(first);
    expect(first).toEqual({ projectId: mine.id, threadId: threadsOf(mine.id)[0].id });
    expect(threadsOf(mine.id)).toHaveLength(1);
    expect(threadsOf(mine.id).filter((thread) => thread.name === 'Diomedes')).toHaveLength(1);
  }
});

test('the thread it makes is the threads route own thread, pinned to the Nectovia default', async () => {
  const control = await project('Control');
  await api<Conversation>(`/projects/${control.id}/threads`, 'POST', {
    name: 'Diomedes',
    mode: 'auto',
  });
  const mine = await project('Mine');
  const binding = await provision(mine.id);
  // Everything a fresh thread cannot share: its id, its stamps and the project it hangs from.
  const shape = (thread: Conversation) => ({
    ...thread,
    id: '<id>',
    createdAt: '<stamped>',
    updatedAt: '<stamped>',
    attachedTo: { ...thread.attachedTo, ref: '<project>' },
  });
  const made = threadsOf(mine.id)[0];
  const wouldBe = threadsOf(control.id)[0];
  expect(shape(made)).toEqual({ ...shape(wouldBe), engine: 'nectovia' });
  // `toEqual` passes over a key whose value is undefined, so the key sets are compared too.
  expect(Object.keys(made).sort()).toEqual([...Object.keys(wouldBe), 'engine'].sort());
  expect(binding).toEqual({ projectId: mine.id, threadId: made.id });
  expect(made.createdAt).toBe(made.updatedAt);
});

test('a conversation that is already there is adopted, not duplicated', async () => {
  const mine = await project('Adopt');
  const existing = await api<Conversation>(`/projects/${mine.id}/threads`, 'POST', {
    name: 'Talk',
    mode: 'auto',
  });
  expect(await provision(mine.id)).toEqual({ projectId: mine.id, threadId: existing.id });
  expect(threadsOf(mine.id)).toHaveLength(1);
  // Adoption takes the thread as it is: its name was never this route's to write.
  expect(threadsOf(mine.id)[0].name).toBe('Talk');
});

test('the oldest qualifying thread wins, ties break by id, and the page reads the same one', async () => {
  const older = await project('Older wins');
  await seed(older.id, [
    seeded(older.id, { id: 'Cb', createdAt: '2026-09-21T11:00:00.000Z' }),
    seeded(older.id, { id: 'Ca', createdAt: '2026-09-21T09:00:00.000Z' }),
  ]);
  const oldest = await provision(older.id);
  expect(oldest.threadId).toBe('Ca');

  const tied = await project('Tie breaks by id');
  await seed(tied.id, [
    seeded(tied.id, { id: 'Cz', createdAt: '2026-09-21T09:00:00.000Z' }),
    seeded(tied.id, { id: 'Cm', createdAt: '2026-09-21T09:00:00.000Z' }),
  ]);
  const broken = await provision(tied.id);
  expect(broken.threadId).toBe('Cm');

  // The binding is what the page would have chosen from the state the page reads.
  for (const binding of [oldest, broken]) {
    const read = await api<ProjectState>(`/projects/${binding.projectId}/state`);
    expect(diomedesThread(read.conversations)?.id).toBe(binding.threadId);
    expect(read.conversations).toHaveLength(2);
  }
});

test('a task, document or review thread is never adopted, and neither is a work mode', async () => {
  const mine = await project('Never these');
  const early = '2026-09-21T08:00:00.000Z';
  const ignored = ['Ctask', 'Cdocument', 'Creview', 'Cbuild'];
  await seed(mine.id, [
    seeded(mine.id, {
      id: 'Ctask',
      createdAt: early,
      attachedTo: { kind: 'task', ref: 'T1' },
      taskId: 'T1',
    }),
    seeded(mine.id, {
      id: 'Cdocument',
      createdAt: early,
      attachedTo: { kind: 'document', ref: 'Notes.md' },
    }),
    seeded(mine.id, { id: 'Creview', createdAt: early, attachedTo: { kind: 'review', ref: 'R1' } }),
    // A work mode with nothing said through the conversation routes is not one either.
    seeded(mine.id, { id: 'Cbuild', createdAt: early, mode: 'build' }),
  ]);
  const binding = await provision(mine.id);
  expect(ignored).not.toContain(binding.threadId);
  expect(threadsOf(mine.id)).toHaveLength(5);
  expect(byId(mine.id, binding.threadId)).toMatchObject({
    name: 'Diomedes',
    mode: 'auto',
    engine: 'nectovia',
    attachedTo: { kind: 'project', ref: mine.id },
    taskId: null,
  });
  for (const id of ignored) expect(byId(mine.id, id).engine).toBeUndefined();
});

test('an adopted conversation on another engine is pinned, and no sibling moves', async () => {
  const mine = await project('Pin one');
  await seed(mine.id, [
    seeded(mine.id, { id: 'Coldest', createdAt: '2026-09-21T09:00:00.000Z', engine: 'sample' }),
    // Qualifying too, and newer: a candidate this operation still leaves alone.
    seeded(mine.id, { id: 'Cnewer', createdAt: '2026-09-21T11:00:00.000Z', engine: 'codex' }),
    seeded(mine.id, {
      id: 'Cordinary',
      createdAt: '2026-09-21T10:00:00.000Z',
      mode: 'ask',
      engine: 'codex',
    }),
  ]);
  expect((await provision(mine.id)).threadId).toBe('Coldest');
  expect(byId(mine.id, 'Coldest').engine).toBe('nectovia');
  expect(byId(mine.id, 'Cnewer').engine).toBe('codex');
  expect(byId(mine.id, 'Cordinary').engine).toBe('codex');
  expect(threadsOf(mine.id)).toHaveLength(3);
  // The pin was written by the same operation that adopted, so a restart still reads it.
  await close();
  await open();
  expect(byId(mine.id, 'Coldest').engine).toBe('nectovia');
  expect(byId(mine.id, 'Cnewer').engine).toBe('codex');
});

test('a second send finds the same conversation and writes nothing at all', async () => {
  const mine = await project('Quiet');
  const first = await provision(mine.id);
  const file = store().statePath(mine.id);
  const before = await fs.readFile(file);
  const stamp = byId(mine.id, first.threadId).updatedAt;
  const persist = vi.spyOn(store(), 'persist');
  try {
    expect(await provision(mine.id)).toEqual(first);
    expect(persist).not.toHaveBeenCalled();
  } finally {
    persist.mockRestore();
  }
  expect((await fs.readFile(file)).equals(before)).toBe(true);
  expect(byId(mine.id, first.threadId).updatedAt).toBe(stamp);
  expect(threadsOf(mine.id)).toHaveLength(1);
});

test('reading a project before any send creates nothing', async () => {
  const mine = await project('Read only');
  const read = await api<ProjectState>(`/projects/${mine.id}/state`);
  expect(read.conversations).toEqual([]);
  expect(diomedesThread(read.conversations)).toBe(null);
  expect(threadsOf(mine.id)).toEqual([]);
  // Nor did the read leave one on disk to be found after a restart.
  await close();
  await open();
  expect(threadsOf(mine.id)).toEqual([]);
});

test('the reserved home Project is refused, and its own conversation is untouched', async () => {
  const home = await api<Binding>('/home/conversation', 'POST');
  const refused = await request(`/projects/${home.projectId}/conversation`, 'POST');
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain(
    'The conversation across all projects has its own provisioner. Ask for it there.',
  );
  expect(threadsOf(home.projectId)).toHaveLength(1);
  expect(await api<Binding>('/home/conversation')).toEqual(home);
});

test('a project that is not there is not found', async () => {
  const missing = await request('/projects/nosuchproject/conversation', 'POST');
  expect(missing.status).toBe(404);
});

test('the conversation a project has survives closing and reopening the app', async () => {
  const mine = await project('Restart');
  const first = await provision(mine.id);
  await close();
  await open();
  const read = await api<ProjectState>(`/projects/${mine.id}/state`);
  expect(diomedesThread(read.conversations)?.id).toBe(first.threadId);
  expect(await provision(mine.id)).toEqual(first);
  expect(threadsOf(mine.id)).toHaveLength(1);
});

test('an ordinary thread is still made and still routed after a conversation exists', async () => {
  const mine = await project('Still ordinary');
  const binding = await provision(mine.id);
  const ordinary = await api<Conversation>(`/projects/${mine.id}/threads`, 'POST', {
    name: 'Orders',
  });
  const rerouted = await api<Conversation>(
    `/projects/${mine.id}/threads/${ordinary.id}`,
    'PUT',
    { engine: 'sample' },
  );
  expect([rerouted.name, rerouted.mode, rerouted.engine]).toEqual(['Orders', 'ask', 'sample']);
  expect(byId(mine.id, binding.threadId).engine).toBe('nectovia');
  expect(await provision(mine.id)).toEqual(binding);
});
