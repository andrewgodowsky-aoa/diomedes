/**
 * Bounded backend task workflow regressions (Board gaps, decisions 4 and 12).
 *
 * Fixture note: the parent owns `server/app.ts` and wires
 * `mountTaskWorkflowRoutes` there, so `createApp` cannot serve these routes in
 * this lane (its `/api` 404 catch-all is registered before any later mount).
 * These tests mount the same `mountTaskWorkflowRoutes(app, store)` export on a
 * minimal express app over a real `Store`, and assert the actual
 * authorization, conflict and persistence outcomes over HTTP, plus the pure
 * helpers directly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store } from '../server/store';
import {
  mountTaskWorkflowRoutes,
  proposeTask,
  requestTaskHandoff,
} from '../server/task-workflow';
import { ApiError } from '../server/paths';
import { readyAt } from '../shared/ready-queue';
import {
  childBlocker,
  taskDepth,
  taskWorkflowBlocker,
  workflowOf,
} from '../shared/task-workflow';
import type { Session, Task } from '../shared/types';

let root: string;
let store: Store;
let app: express.Express;
let server: Server | undefined;
let url: string;
let projectId: string;

async function launch() {
  root = await fs.mkdtemp(path.resolve('test-results', 'task-workflow-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  projectId = (
    await store.locked(async () => {
      const created = await store.createProject('Workflow board');
      return created.id;
    })
  );
  app = express();
  app.use(express.json());
  mountTaskWorkflowRoutes(app, store);
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'This action was not found.')));
  // Same ApiError contract as server/app.ts: status plus details, never a stack.
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message, ...error.details });
        return;
      }
      res.status(500).json({ error: 'The local service could not complete this action.' });
    },
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close() {
  const closing = server;
  server = undefined;
  if (!closing) return;
  closing.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    closing.close((error) => (error ? reject(error) : resolve())),
  );
}

async function request<T>(route: string, method = 'POST', payload?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, data: (await response.json()) as T };
}

const makeTask = (over: { name?: string; owner?: Task['owner'] } = {}) =>
  store.locked(async () => {
    const state = store.state(projectId);
    const task = store.createTask(state, {
      name: over.name ?? 'Bounded task',
      description: '',
      owner: over.owner ?? 'you',
    });
    await store.persist(state);
    return structuredClone(task);
  });

const readTask = (id: string): Task =>
  structuredClone(store.state(projectId).tasks.find((item) => item.id === id)!);

const readDiskTask = async (id: string): Promise<Task> => {
  const disk = JSON.parse(await fs.readFile(store.statePath(projectId), 'utf8')) as {
    tasks: Task[];
  };
  return disk.tasks.find((item) => item.id === id)!;
};

const addSession = (taskId: string, state: Session['state']) =>
  store.locked(async () => {
    const project = store.state(projectId);
    project.sessions.push({
      id: `S-${taskId}`,
      taskId,
      state,
      startedAt: '2026-09-27T00:00:00.000Z',
      endedAt: state === 'working' ? null : '2026-09-27T01:00:00.000Z',
      sample: true,
      log: [],
      entryIds: [],
      needId: null,
      engine: { name: 'Sample worker', model: null, worker: 1, branch: null, context: null, events: 0 },
    } as unknown as Session);
    await store.persist(project);
  });

const workflow = (taskId: string) => `/projects/${projectId}/tasks/${taskId}/workflow`;
const taskBase = (taskId: string) => `/projects/${projectId}/tasks/${taskId}`;

beforeEach(async () => {
  await fs.mkdir('test-results', { recursive: true });
  await launch();
});
afterEach(async () => close());

describe('task workflow settings', () => {
  test('PUT sets continuation and budget with revision guard and disk persistence', async () => {
    const task = await makeTask();
    const first = await request<Task>(workflow(task.id), 'PUT', {
      expectedRevision: 1,
      continuation: 'full-approval',
      maxTurns: 12,
    });
    expect(first.status).toBe(200);
    expect(first.data.workflow).toMatchObject({
      revision: 2,
      continuation: 'full-approval',
      maxTurns: 12,
      phase: 'plan',
    });
    // What the route returned is what the disk holds.
    expect(await readDiskTask(task.id)).toEqual(first.data);
    const stale = await request(workflow(task.id), 'PUT', {
      expectedRevision: 1,
      continuation: 'stop-on-phase-change',
    });
    expect(stale.status).toBe(409);
    expect(readTask(task.id).workflow?.continuation).toBe('full-approval');
  });

  test('PUT refuses unknown continuation, over-budget turns and missing revision', async () => {
    const task = await makeTask();
    for (const payload of [
      { expectedRevision: 1, continuation: 'always-go' },
      { expectedRevision: 1, maxTurns: 17 },
      { expectedRevision: 1, maxTurns: 0 },
      { continuation: 'full-approval' },
    ]) {
      const response = await request(workflow(task.id), 'PUT', payload);
      expect(response.status).toBe(400);
    }
    expect(readTask(task.id).workflow).toBeUndefined();
  });

  test('tasks without a workflow run exactly as before', async () => {
    const task = await makeTask();
    expect(task.workflow).toBeUndefined();
    expect(workflowOf(task)).toMatchObject({
      revision: 1,
      phase: 'plan',
      continuation: 'stop-on-phase-change',
      inbox: false,
      maxTurns: 8,
    });
    expect(taskWorkflowBlocker(task)).toBeNull();
    expect(readyAt(task, [], [], [])).toBe(task.createdAt);
  });
});

describe('inbox acceptance', () => {
  test('proposed tasks wait in the Inbox until accepted', async () => {
    const proposed = await store.locked(async () => {
      const state = store.state(projectId);
      const task = proposeTask(store, state, { name: 'Runtime proposal' });
      await store.persist(state);
      return structuredClone(task);
    });
    expect(proposed.createdBy).toBe('diomedes');
    expect(proposed.workflow).toMatchObject({ inbox: true, revision: 1 });
    expect(taskWorkflowBlocker(proposed)).toContain('Inbox');
    expect(readyAt(proposed, [], [], [])).toBeNull();

    const accepted = await request<Task>(`${taskBase(proposed.id)}/accept`, 'POST', {
      expectedRevision: 1,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.data.workflow).toMatchObject({ inbox: false, revision: 2 });
    expect(taskWorkflowBlocker(accepted.data)).toBeNull();
    expect(await readDiskTask(proposed.id)).toEqual(accepted.data);

    const again = await request(`${taskBase(proposed.id)}/accept`, 'POST', {
      expectedRevision: 2,
    });
    expect(again.status).toBe(409);
  });

  test('proposeTask checks scoped references and honours explicit acceptance', async () => {
    const parent = await makeTask({ name: 'Parent' });
    const accepted = await store.locked(async () => {
      const state = store.state(projectId);
      const task = proposeTask(store, state, {
        name: 'Accepted up front',
        output: 'A separate accepted result',
        parentTaskId: parent.id,
        acceptedByPerson: true,
        origin: { projectId, threadId: 'C1', turnId: 'T1' },
      });
      await store.persist(state);
      return structuredClone(task);
    });
    expect(accepted.workflow).toMatchObject({ inbox: false, parentTaskId: parent.id });
    expect(accepted.origin).toMatchObject({ projectId, threadId: 'C1' });
    await expect(
      store.locked(async () => proposeTask(store, store.state(projectId), { name: 'Orphan', parentTaskId: 'T999' })),
    ).rejects.toThrow();
  });
});

describe('phase handoffs', () => {
  test('stop-on-phase-change parks the phase until approval', async () => {
    const task = await makeTask();
    const parked = await request<Task>(`${taskBase(task.id)}/handoff`, 'POST', {
      expectedRevision: 1,
      phase: 'build',
      reason: 'The plan is ready to build.',
    });
    expect(parked.status).toBe(200);
    expect(parked.data.workflow).toMatchObject({
      phase: 'plan',
      pendingPhase: 'build',
      revision: 2,
      handoffs: [],
    });
    expect(taskWorkflowBlocker(parked.data)).toContain('build');
    expect(readyAt(parked.data, [], [], [])).toBeNull();

    const approved = await request<Task>(`${taskBase(task.id)}/approve-phase`, 'POST', {
      expectedRevision: 2,
    });
    expect(approved.status).toBe(200);
    expect(approved.data.workflow).toMatchObject({
      phase: 'build',
      pendingPhase: null,
      revision: 3,
    });
    expect(approved.data.workflow?.handoffs).toEqual([
      expect.objectContaining({
        by: 'you',
        from: 'plan',
        to: 'build',
        reason: 'The plan is ready to build.',
      }),
    ]);
    expect(await readDiskTask(task.id)).toEqual(approved.data);

    const empty = await request(`${taskBase(task.id)}/approve-phase`, 'POST', {
      expectedRevision: 3,
    });
    expect(empty.status).toBe(409);
  });

  test('full approval advances at once and never trusts the request actor', async () => {
    const task = await makeTask();
    await request(workflow(task.id), 'PUT', {
      expectedRevision: 1,
      continuation: 'full-approval',
    });
    const moved = await request<Task>(`${taskBase(task.id)}/handoff`, 'POST', {
      expectedRevision: 2,
      phase: 'build',
      reason: 'Building now.',
      actor: 'diomedes',
    });
    expect(moved.status).toBe(200);
    expect(moved.data.workflow).toMatchObject({ phase: 'build', revision: 3 });
    expect(moved.data.workflow?.handoffs).toEqual([
      expect.objectContaining({ by: 'you', from: 'plan', to: 'build' }),
    ]);
  });

  test('handoff refuses skips, backwards moves and missing reasons', async () => {
    const task = await makeTask();
    for (const payload of [
      { expectedRevision: 1, phase: 'review', reason: 'Skipping build.' },
      { expectedRevision: 1, phase: 'plan', reason: 'Same phase.' },
      { expectedRevision: 1, phase: 'build', reason: '' },
      { expectedRevision: 1, phase: 'deploy', reason: 'Unknown phase.' },
    ]) {
      const response = await request(`${taskBase(task.id)}/handoff`, 'POST', payload);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(readTask(task.id).workflow).toBeUndefined();
  });

  test('an active run refuses human changes but not the trusted phase request', async () => {
    const task = await makeTask();
    await addSession(task.id, 'working');
    const refused = await request(workflow(task.id), 'PUT', {
      expectedRevision: 1,
      continuation: 'full-approval',
    });
    expect(refused.status).toBe(409);
    const handoffRefused = await request(`${taskBase(task.id)}/handoff`, 'POST', {
      expectedRevision: 1,
      phase: 'build',
      reason: 'Mid-run ask.',
    });
    expect(handoffRefused.status).toBe(409);
    const trusted = await store.locked(async () => {
      const state = store.state(projectId);
      const live = state.tasks.find((item) => item.id === task.id)!;
      const result = requestTaskHandoff(store, state, live, 'build', 'diomedes');
      await store.persist(state);
      return result;
    });
    expect(trusted).toMatchObject({ advanced: false, pending: true });
    expect(readTask(task.id).workflow?.pendingPhase).toBe('build');
  });
});

describe('branched child tasks', () => {
  test('children inherit continuation in the Inbox within the parent budget', async () => {
    const parent = await makeTask({ name: 'Parent' });
    await request(workflow(parent.id), 'PUT', {
      expectedRevision: 1,
      continuation: 'full-approval',
      maxTurns: 6,
    });
    const first = await request<Task>(`${taskBase(parent.id)}/children`, 'POST', {
      commandId: 'branch-one',
      name: 'Child task',
      description: 'Scoped work.',
      output: 'Scoped result.',
    });
    expect(first.status).toBe(200);
    expect(first.data.workflow).toMatchObject({
      continuation: 'full-approval',
      inbox: true,
      parentTaskId: parent.id,
      output: 'Scoped result.',
      maxTurns: 6,
      phase: 'plan',
    });
    expect(first.data.creationReceipt).toMatchObject({ commandId: 'branch-one', projectId });
    expect(taskWorkflowBlocker(first.data)).toContain('Inbox');

    // The same command with the same payload replays the same child, not a second one.
    const replay = await request<Task>(`${taskBase(parent.id)}/children`, 'POST', {
      commandId: 'branch-one',
      name: 'Child task',
      description: 'Scoped work.',
      output: 'Scoped result.',
    });
    expect(replay.status).toBe(200);
    expect(replay.data.id).toBe(first.data.id);
    expect(store.state(projectId).tasks.filter((item) => item.workflow?.parentTaskId === parent.id)).toHaveLength(1);

    // The same command with a different payload conflicts.
    const conflict = await request(`${taskBase(parent.id)}/children`, 'POST', {
      commandId: 'branch-one',
      name: 'A different child',
      output: 'A different result',
    });
    expect(conflict.status).toBe(409);

    // A child cannot outspend its parent.
    const over = await request(`${taskBase(parent.id)}/children`, 'POST', {
      commandId: 'branch-over',
      name: 'Greedy child',
      output: 'An over-budget result',
      maxTurns: 7,
    });
    expect(over.status).toBe(400);
  });

  test('at most four children and two levels deep', async () => {
    const parent = await makeTask({ name: 'Parent' });
    for (let n = 1; n <= 4; n++) {
      const response = await request(`${taskBase(parent.id)}/children`, 'POST', {
        commandId: `branch-${n}`,
        name: `Child ${n}`,
        output: `Result ${n}`,
      });
      expect(response.status).toBe(200);
    }
    const fifth = await request(`${taskBase(parent.id)}/children`, 'POST', {
      commandId: 'branch-5',
      name: 'Child 5',
      output: 'Fifth result',
    });
    expect(fifth.status).toBe(409);

    const tasks = store.state(projectId).tasks;
    const child = tasks.find((item) => item.workflow?.parentTaskId === parent.id)!;
    expect(taskDepth(tasks, child)).toBe(1);
    expect(childBlocker(tasks, parent)).toContain('4');
    child.deletedAt = new Date().toISOString();
    // Deletion cannot replenish the parent's fan-out limit, and restoring a
    // deleted child cannot exceed it either.
    const afterDelete = await request(`${taskBase(parent.id)}/children`, 'POST', {
      commandId: 'branch-after-delete', name: 'Replacement', output: 'Another result',
    });
    expect(afterDelete.status).toBe(409);
    expect(childBlocker(tasks, parent)).toContain('including deleted');
  });

  test('depth limit refuses a third level', () => {
    const rootTask = { id: 'T1' } as Task;
    const child = { id: 'T2', workflow: { parentTaskId: 'T1' } } as unknown as Task;
    const grandchild = { id: 'T3', workflow: { parentTaskId: 'T2' } } as unknown as Task;
    const tasks = [rootTask, child, grandchild];
    expect(taskDepth(tasks, grandchild)).toBe(2);
    expect(childBlocker(tasks, grandchild)).toContain('2 levels deep');
    expect(childBlocker(tasks, child)).toBeNull();
  });
});
