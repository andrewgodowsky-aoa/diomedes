import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { Store } from '../server/store';
import { parseTaskCommand, validateTaskReceipts } from '../server/task-admission';
import { assertReplay, findCommand } from '../server/command-admission';
import type { ProjectState, Session, Task } from '../shared/types';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string, projectId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
const store = (): Store => app.locals.store;
const state = () => store().state(projectId);
const command = () => ({
  protocolVersion: 1,
  commandId: 'create-one',
  name: 'Prepare the weekly brief',
});
async function launch() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    stepMs: 20,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
async function request<T>(
  route: string,
  method = 'POST',
  body?: unknown,
  customHeaders: Record<string, string> = headers,
) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: customHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const create = (body: unknown = command()) =>
  request<Task>(`/projects/${projectId}/tasks`, 'POST', body);
beforeEach(async () => {
  await fs.mkdir('test-results', { recursive: true });
  root = await fs.mkdtemp(path.resolve('test-results', 'task-admission-'));
  await launch();
  projectId = (await request<{ id: string }>('/projects', 'POST', { name: 'Task admission' })).data
    .id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

describe('ordinary task creation admission', () => {
  test('concurrent normalized retries, disk state and restart retain one Task and History receipt', async () => {
    const [a, b] = await Promise.all([
      create(),
      create({
        owner: 'you',
        description: '',
        name: `  ${command().name}  `,
        commandId: 'create-one',
        protocolVersion: 1,
      }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.data).toEqual(a.data);
    expect(a.data.creationReceipt).toMatchObject({
      projectId,
      taskId: a.data.id,
      commandId: 'create-one',
      actor: 'local-client',
    });
    const disk = JSON.parse(
      await fs.readFile(store().statePath(projectId), 'utf8'),
    ) as ProjectState;
    expect(disk.tasks).toEqual([a.data]);
    expect(disk.history.filter((entry) => entry.kind === 'tasks-made')).toEqual([
      expect.objectContaining({
        id: a.data.creationReceipt!.eventId,
        taskId: a.data.id,
        time: a.data.creationReceipt!.admittedAt,
      }),
    ]);
    expect(disk.sessions).toEqual([]);
    expect(disk.tasks[0].moves).toEqual([]);
    await close();
    await launch();
    const persist = vi.spyOn(store(), 'persist');
    const createTask = vi.spyOn(store(), 'createTask');
    expect((await create()).data).toEqual(a.data);
    expect(persist).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(state().tasks).toHaveLength(1);
  });

  test.each([{ name: 'Different' }, { description: 'Different' }, { owner: 'diomedes' }])(
    'rejects command reuse with changed payload %j',
    async (change) => {
      await create();
      expect((await create({ ...command(), ...change })).status).toBe(409);
      expect(state().tasks).toHaveLength(1);
    },
  );

  test.each([
    { protocolVersion: 2 },
    { protocolVersion: undefined },
    { commandId: undefined },
    { commandId: '' },
    { commandId: 'bad/key' },
    { name: ' ' },
    { name: 'x'.repeat(201) },
    { description: 123 },
    { description: 'x'.repeat(10001) },
    { owner: 'administrator' },
    { actor: 'owner' },
    { state: 'done' },
    { creationReceipt: {} },
  ])('rejects malformed v1 commands before mutation: %j', async (change) => {
    expect([400, 409]).toContain((await create({ ...command(), ...change })).status);
    expect(state().tasks).toEqual([]);
    expect(state().history.some((entry) => entry.kind === 'tasks-made')).toBe(false);
  });

  test('legacy creation remains unversioned; new command IDs intentionally make distinct tasks', async () => {
    const legacy = await create({ name: 'Legacy' });
    expect(legacy.status).toBe(200);
    expect(legacy.data.creationReceipt).toBeUndefined();
    const first = await create();
    const next = await create({ ...command(), commandId: 'create-two' });
    expect(next.data.id).not.toBe(first.data.id);
    expect(state().tasks).toHaveLength(3);
  });

  test('replays the current task without undoing edits, moves or a soft deletion', async () => {
    const original = (await create()).data;
    await request(`/projects/${projectId}/tasks/${original.id}`, 'PUT', {
      name: 'Renamed',
      state: 'done',
    });
    state().tasks[0].deletedAt = new Date().toISOString();
    await store().persist(state());
    await close();
    await launch();
    const replay = (await create()).data;
    expect(replay).toMatchObject({
      id: original.id,
      name: 'Renamed',
      state: 'done',
      creationReceipt: original.creationReceipt,
    });
    expect(replay.deletedAt).toBeTruthy();
    expect(state().tasks).toHaveLength(1);
  });

  test('keeps the command namespace project-scoped and the ordinary HTTP boundary on replay', async () => {
    const first = (await create()).data;
    const other = (await request<{ id: string }>('/projects', 'POST', { name: 'Other project' }))
      .data.id;
    const second = await request<Task>(`/projects/${other}/tasks`, 'POST', command());
    expect(second.status).toBe(200);
    expect(second.data.creationReceipt!.projectId).toBe(other);
    expect(first.creationReceipt!.projectId).toBe(projectId);
    expect(
      (
        await request(`/projects/${projectId}/tasks`, 'POST', command(), {
          ...headers,
          Origin: 'https://untrusted.invalid',
        })
      ).status,
    ).toBe(403);
    expect((await request('/projects/missing/tasks', 'POST', command())).status).toBe(404);
    expect(state().tasks).toHaveLength(1);
  });

  test("creation and Work reject each other's keys; approval and scope use the same namespace", async () => {
    const task = (await create()).data;
    const start = (commandId: string) =>
      request<Session>(`/projects/${projectId}/work/start`, 'POST', {
        protocolVersion: 1,
        commandId,
        taskId: task.id,
        route: 'sample',
      });
    expect((await start('create-one')).status).toBe(409);
    expect((await start('work-one')).status).toBe(200);
    expect((await create({ ...command(), commandId: 'work-one' })).status).toBe(409);
    for (const family of ['approval.decide', 'scope.issue'] as const)
      expect(() => assertReplay(findCommand(state(), 'create-one'), family)).toThrow(
        'different request',
      );
    const inconsistent = structuredClone(state());
    inconsistent.tasks[0].creationReceipt = { ...task.creationReceipt!, commandId: 'work-one' };
    expect(() => validateTaskReceipts(inconsistent)).toThrow('inconsistent');
  });

  test.each(['before', 'after'] as const)(
    'a persistence failure %s saving reconciles without a phantom or duplicate task',
    async (phase) => {
      const persist = store().persist.bind(store());
      vi.spyOn(store(), 'persist').mockImplementationOnce(async (value) => {
        if (phase === 'after') await persist(value);
        throw new Error('Synthetic task persistence failure.');
      });
      expect((await create()).status).toBe(500);
      expect(state().tasks).toHaveLength(phase === 'after' ? 1 : 0);
      const retry = await create();
      expect(retry.status).toBe(200);
      expect(state().tasks).toHaveLength(1);
      expect(state().history.filter((entry) => entry.kind === 'tasks-made')).toHaveLength(1);
      expect(state().sessions).toEqual([]);
    },
  );

  test.each(['version', 'history', 'project', 'duplicate'] as const)(
    'refuses incompatible saved receipt %s without rewriting evidence',
    async (damage) => {
      await create();
      const file = store().statePath(projectId);
      await close();
      const saved = JSON.parse(await fs.readFile(file, 'utf8')) as ProjectState;
      if (damage === 'version')
        Object.assign(saved.tasks[0].creationReceipt!, { protocolVersion: 99 });
      if (damage === 'project')
        Object.assign(saved.tasks[0].creationReceipt!, { projectId: 'other' });
      if (damage === 'history')
        saved.history = saved.history.filter((entry) => entry.kind !== 'tasks-made');
      if (damage === 'duplicate') saved.tasks.push(structuredClone(saved.tasks[0]));
      const bytes = JSON.stringify(saved);
      await fs.writeFile(file, bytes);
      await expect(
        new Store(path.join(root, 'data'), path.join(root, 'projects')).init(),
      ).rejects.toThrow('saved task receipt');
      expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    },
  );

  test('canonical identity preserves description bytes and defaults independently of property order', () => {
    const original = parseTaskCommand(command())!;
    expect(parseTaskCommand({ owner: 'you', description: '', ...command() })!.admission).toEqual(
      original.admission,
    );
    expect(parseTaskCommand({ ...command(), description: ' ' })!.admission.payloadDigest).not.toBe(
      original.admission.payloadDigest,
    );
  });

  test('a document is part of the command identity and is checked against a fresh listing', async () => {
    const original = parseTaskCommand(command())!;
    const withDocument = parseTaskCommand({ ...command(), sourceDocument: 'Reopening plan.md' })!;
    expect(withDocument.input.sourceDocument).toBe('Reopening plan.md');
    expect(withDocument.admission.payloadDigest).not.toBe(original.admission.payloadDigest);
    expect(
      parseTaskCommand({ ...command(), sourceDocument: 'Reopening plan.md ' })!.admission
        .payloadDigest,
    ).toBe(withDocument.admission.payloadDigest);
    expect(() => parseTaskCommand({ ...command(), sourceDocument: '' })).toThrow();
    expect(() => parseTaskCommand({ ...command(), sourceDocument: 42 })).toThrow();

    const folder = state().project.folder;
    await fs.writeFile(path.join(folder, 'Reopening plan.md'), 'Plan text');
    const missing = await create({ ...command(), sourceDocument: 'missing.md' });
    expect(missing.status).toBe(400);
    expect(state().tasks).toHaveLength(0);
    const first = await create({ ...command(), sourceDocument: 'Reopening plan.md' });
    expect(first.status).toBe(200);
    expect(first.data.sourceDocument).toBe('Reopening plan.md');
    expect(first.data.creationReceipt?.payloadDigest).toBe(withDocument.admission.payloadDigest);
    // The same command replays; the same key with another document, or none, conflicts.
    expect((await create({ ...command(), sourceDocument: 'Reopening plan.md' })).data.id).toBe(
      first.data.id,
    );
    expect((await create({ ...command(), sourceDocument: 'Other.md' })).status).toBe(409);
    expect((await create(command())).status).toBe(409);
    expect(state().tasks).toHaveLength(1);
    // A replay answers even after the document is gone: the admitted task is the evidence.
    await fs.rm(path.join(folder, 'Reopening plan.md'));
    const replay = await create({ ...command(), sourceDocument: 'Reopening plan.md' });
    expect(replay.status).toBe(200);
    expect(replay.data.id).toBe(first.data.id);
  });
});
