/**
 * Execution-view isolation over the real HTTP surface: a per-task routing
 * override belongs to that task alone, clearing it restores the view, the read
 * view writes nothing, and a task that does not exist answers 404.
 *
 * Built exactly the way tests/agent-profiles-routing.test.ts builds its app.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { forgetCatalog } from '../server/models.js';
import type { NativeGenerator } from '../server/native-work.js';
import type { TaskExecutionView } from '../shared/task-execution.js';
import type { ProjectState } from '../shared/types.js';

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let root = '',
  url = '',
  projectId = '',
  taskA = '',
  taskB = '';
let generate: ReturnType<typeof vi.fn<NativeGenerator>>;
let savedCodexHome: string | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const state = async (): Promise<ProjectState> =>
  (await request(`/projects/${projectId}/state`)).data;
const execution = (taskId: string) =>
  request<TaskExecutionView>(`/projects/${projectId}/tasks/${taskId}/execution`);
const profile = async (name: string, patch: Record<string, unknown> = {}) =>
  (
    await request('/agent-profiles', 'POST', {
      name,
      engine: 'codex',
      model: 'gpt-6-astra',
      effort: 'xhigh',
      agentId: 'diomedes.builder',
      rules: [],
      ...patch,
    })
  ).data;

async function launch() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    nativeGenerator: (input) => generate(input),
    reviewerAdapter: null,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  const closingApp = app,
    closingServer = server;
  try {
    await closingApp?.locals.close();
  } finally {
    if (closingServer) {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve) => closingServer.close(() => resolve()));
    }
  }
}

let profileOne: any, profileTwo: any;

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'execution-iso-'));
  // An engine that has not written its list accepts the model as named.
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex');
  forgetCatalog();
  generate = vi.fn(async (input) => ({
    model: input.model ?? 'runtime-default',
    text: '{}',
  }));
  await launch();
  projectId = (await request('/projects', 'POST', { name: 'Isolation check' })).data.id;
  taskA = (
    await request(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Task A',
      description: '',
      owner: 'you',
    })
  ).data.id;
  taskB = (
    await request(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Task B',
      description: '',
      owner: 'you',
    })
  ).data.id;
  // A thread on task A, so its `requested` field is a real thing that could leak.
  await request(`/projects/${projectId}/threads`, 'POST', { taskId: taskA, name: 'A thread' });
  await request('/settings', 'PUT', { services: { codex: true } });
  profileOne = await profile('First pick');
  profileTwo = await profile('Second pick', { effort: 'low' });
});

afterEach(async () => {
  await close();
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  forgetCatalog();
  vi.restoreAllMocks();
});

describe('task execution view isolation', () => {
  test('a per-task routing override is visible on that task alone, and clears cleanly', async () => {
    // Both profiles can run here, so the saved list is a real resolution input.
    const { data: listed } = await request(`/projects/${projectId}/agent-profiles`);
    for (const picked of [profileOne, profileTwo])
      expect(
        listed.profiles.find((item: { profileId: string }) => item.profileId === picked.profileId),
      ).toMatchObject({ available: true, reason: null });

    const a0 = (await execution(taskA)).data;
    const b0 = (await execution(taskB)).data;
    expect(a0.contractVersion).toBe(1);
    expect(a0.route.id).toBe('sample');
    expect(a0.routing.task).toBeNull();
    expect(b0.routing.task).toBeNull();
    const conversations0 = (await state()).conversations;

    const saved = await request(`/projects/${projectId}/tasks/${taskA}/agent-routing`, 'PUT', {
      order: [profileOne.profileId],
      fallback: false,
    });
    expect(saved.status).toBe(200);
    expect(saved.data).toEqual({ order: [profileOne.profileId], fallback: false });

    const a1 = (await execution(taskA)).data;
    expect(a1.routing.task).toEqual({ order: [profileOne.profileId], fallback: false });
    expect(a1.routing.project).toBeNull();
    // The sample route never resolves profiles; the saved list is reported inert.
    expect(a1.routing.inert).toBe(
      'The sample route runs a scripted worker, so saved profiles do not choose for it.',
    );
    expect(a1.routing.outcome).toEqual({ outcome: 'none' });
    // The other task's view is untouched, and no thread's choices moved.
    expect((await execution(taskB)).data).toEqual(b0);
    expect((await state()).conversations).toEqual(conversations0);

    const cleared = await request(`/projects/${projectId}/tasks/${taskA}/agent-routing`, 'PUT', {
      clear: true,
    });
    expect(cleared.status).toBe(200);
    expect((await execution(taskA)).data).toEqual(a0);

    // The reverse direction: writing B's list touches nothing of A's.
    const forB = await request(`/projects/${projectId}/tasks/${taskB}/agent-routing`, 'PUT', {
      order: [profileTwo.profileId],
    });
    expect(forB.status).toBe(200);
    expect((await execution(taskA)).data).toEqual(a0);
    const b2 = (await execution(taskB)).data;
    expect(b2.routing.task).toEqual({ order: [profileTwo.profileId], fallback: false });
    expect((await state()).conversations).toEqual(conversations0);
  });

  test('on a route that resolves profiles, task A’s profile changes what task A would run and nothing else', async () => {
    // The sample route leaves profiles inert, so the case above proves the saved lists apart;
    // this one proves the resolved route, model and worker apart (research step 2).
    await request('/settings', 'PUT', { services: { codex: true, defaultEngine: 'codex' } });
    const a0 = (await execution(taskA)).data;
    const b0 = (await execution(taskB)).data;
    expect(a0.route).toMatchObject({ id: 'codex', source: 'settings' });
    expect(a0.routing.outcome).toEqual({ outcome: 'none' });
    const conversations0 = (await state()).conversations;

    await request(`/projects/${projectId}/tasks/${taskA}/agent-routing`, 'PUT', {
      order: [profileTwo.profileId],
      fallback: false,
    });
    const a1 = (await execution(taskA)).data;
    expect(a1.routing.outcome).toMatchObject({
      outcome: 'resolved',
      pick: { profileId: profileTwo.profileId, source: 'task', model: 'gpt-6-astra', effort: 'low' },
    });
    expect(a1.route).toMatchObject({ id: 'codex', source: 'profile' });
    expect(a1.model).toMatchObject({ requested: 'gpt-6-astra', effort: 'low' });
    // Task B would run exactly as before, and no thread's own choices moved.
    expect((await execution(taskB)).data).toEqual(b0);
    expect((await state()).conversations).toEqual(conversations0);

    await request(`/projects/${projectId}/tasks/${taskA}/agent-routing`, 'PUT', { clear: true });
    expect((await execution(taskA)).data).toEqual(a0);
  });

  test('the execution GET writes nothing to the project or the profiles file', async () => {
    // Non-trivial saved routing, so each read exercises the profiles store.
    await request(`/projects/${projectId}/tasks/${taskA}/agent-routing`, 'PUT', {
      order: [profileOne.profileId, profileTwo.profileId],
      fallback: true,
    });
    const stateFile = path.join(root, 'data', 'projects', projectId, 'state.json');
    const profilesFile = path.join(root, 'data', 'agent-profiles.json');
    const before = await state();
    const stateBytes = await fs.readFile(stateFile);
    const profileBytes = await fs.readFile(profilesFile);

    for (const taskId of [taskA, taskB, taskA])
      expect((await execution(taskId)).status).toBe(200);

    expect((await fs.readFile(stateFile)).equals(stateBytes)).toBe(true);
    expect((await fs.readFile(profilesFile)).equals(profileBytes)).toBe(true);
    const after = await state();
    expect(after.history.length).toBe(before.history.length);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.conversations).toEqual(before.conversations);
  });

  test('a task that does not exist answers 404', async () => {
    expect((await execution('T404')).status).toBe(404);
    expect(
      (await request(`/projects/${projectId}/tasks/T404/agent-routing`, 'PUT', {
        order: [profileOne.profileId],
      })).status,
    ).toBe(404);
  });
});
