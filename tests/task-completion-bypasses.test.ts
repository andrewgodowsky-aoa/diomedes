import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { Store } from '../server/store';
import type { Change, Need, Task } from '../shared/types';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string, projectId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
const store = (): Store => app.locals.store;

async function request<T>(route: string, method = 'POST', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
async function makeTask(): Promise<Task> {
  const made = await request<Task>(`/projects/${projectId}/tasks`, 'POST', {
    protocolVersion: 1,
    commandId: 'make-one',
    name: 'Prepare the weekly brief',
  });
  expect(made.status).toBe(200);
  return made.data;
}
const put = (taskId: string, state: string) =>
  request<{ error?: string; message?: string } & Partial<Task>>(
    `/projects/${projectId}/tasks/${taskId}`,
    'PUT',
    { state },
  );
const taskState = (taskId: string) =>
  store().state(projectId).tasks.find((t) => t.id === taskId)!.state;
const waitingChange = (taskId: string) =>
  ({ id: 'c1', taskId, state: 'waiting' }) as unknown as Change;
const openNeed = (taskId: string) =>
  ({ id: 'n1', taskId, sessionId: 's1', state: 'open' }) as unknown as Need;

beforeEach(async () => {
  await fs.mkdir('test-results', { recursive: true });
  root = await fs.mkdtemp(path.resolve('test-results', 'task-completion-'));
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    stepMs: 20,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await request<{ id: string }>('/projects', 'POST', { name: 'Completion guard' }))
    .data.id;
});
afterEach(async () => {
  const closingApp = app, closingServer = server;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer!.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer!.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe('manual Done honours the completion guard', () => {
  test('a waiting Change refuses Done and leaves the task where it was', async () => {
    const task = await makeTask();
    store().state(projectId).changes.push(waitingChange(task.id));
    const before = taskState(task.id);
    const result = await put(task.id, 'done');
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.data)).toContain(
      `Cannot complete '${task.name}': a waiting Change (c1) needs review.`,
    );
    expect(taskState(task.id)).toBe(before);
  });

  test('an open Need refuses Done and leaves the task where it was', async () => {
    const task = await makeTask();
    store().state(projectId).needs.push(openNeed(task.id));
    const before = taskState(task.id);
    const result = await put(task.id, 'done');
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.data)).toContain(
      `Cannot complete '${task.name}': an open Need (n1) is waiting for the owner.`,
    );
    expect(taskState(task.id)).toBe(before);
  });

  test('Done succeeds with no Change waiting and no open Need', async () => {
    const task = await makeTask();
    const result = await put(task.id, 'done');
    expect(result.status).toBe(200);
    expect(taskState(task.id)).toBe('done');
  });

  test('a move to another state is still allowed with a waiting Change', async () => {
    const task = await makeTask();
    store().state(projectId).changes.push(waitingChange(task.id));
    const result = await put(task.id, 'todo');
    expect(result.status).toBe(200);
    expect(taskState(task.id)).toBe('todo');
  });
});
