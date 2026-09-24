import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import type { ReadyScheduler } from '../server/ready-scheduler.js';
import type { Store } from '../server/store.js';
import type { ReadyQueueView } from '../shared/ready-queue.js';
import { routeDisplayName } from '../shared/engines.js';
import type { ProjectState, Session, Task } from '../shared/types.js';

// H07: the Ready scheduler against the real app. Automatic start is opt-in and off by default,
// claims go through the Work start route's own admission, a start that asks for approval stops
// at its Need, a service route never starts without a confirmed start on it, pause never claims
// and never stops, the limits hold across projects, and a restart between the claim and the
// start never starts a task twice.

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let generate: ReturnType<typeof vi.fn<NativeGenerator>>;

async function launch() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    stepMs: 20,
    nativeGenerator: generate,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  const closingApp = app,
    closingServer = server;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
async function request<T = unknown>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const store = (): Store => app.locals.store;
const scheduler = (): ReadyScheduler => app.locals.readyScheduler;
const state = (projectId: string): ProjectState => store().state(projectId);
async function until(projectId: string, predicate: (state: ProjectState) => boolean) {
  for (let n = 0; n < 200; n++) {
    await scheduler().settled();
    if (predicate(state(projectId))) return state(projectId);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The project did not reach the expected state.');
}
/** Long enough for any pass a change could have asked for to have run. */
async function quiet() {
  for (let n = 0; n < 5; n++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await scheduler().settled();
  }
}
async function sampleProject() {
  const result = await request<{ id: string }>('/projects/sample', 'POST', {});
  expect(result.status).toBe(200);
  return result.data.id;
}
async function newTask(projectId: string, name: string) {
  const result = await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name });
  expect(result.status).toBe(200);
  return result.data;
}
const view = async (projectId: string) =>
  (await request<ReadyQueueView>(`/projects/${projectId}/ready-queue`)).data;
const configure = (projectId: string, body: unknown) =>
  request<ReadyQueueView>(`/projects/${projectId}/ready-queue`, 'PUT', body);
const sessionsOf = (projectId: string, taskId?: string): Session[] =>
  state(projectId).sessions.filter((session) => !taskId || session.taskId === taskId);
/** Tasks the sample fixture already carries are cleared so each test names its own line. */
async function clearTasks(projectId: string) {
  for (const task of state(projectId).tasks.filter((item) => !item.deletedAt))
    expect((await request(`/projects/${projectId}/tasks/${task.id}`, 'DELETE')).status).toBe(200);
}

beforeEach(async () => {
  await fs.mkdir('test-results', { recursive: true });
  root = await fs.mkdtemp(path.resolve('test-results', 'ready-queue-'));
  generate = vi.fn(async () => ({
    model: 'deterministic-fixture',
    version: 'fixture-1',
    text: JSON.stringify({ summary: 'Nothing.', changes: [] }),
  }));
  await launch();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('opt-in, default off', () => {
  test('a new project never starts Ready work on its own', async () => {
    const projectId = await sampleProject();
    await clearTasks(projectId);
    const task = await newTask(projectId, 'Count the walk-in');
    await quiet();
    expect(sessionsOf(projectId)).toEqual([]);
    const shown = await view(projectId);
    expect(shown).toMatchObject({ autoStart: false, paused: null, allPaused: null });
    expect(shown.items).toEqual([
      expect.objectContaining({ taskId: task.id, why: 'off', detail: 'Start explicitly to run' }),
    ]);
    expect(state(projectId).readyQueue).toBeUndefined();
  });

  test('turning it on starts the oldest Ready task through the Work start path, once', async () => {
    const projectId = await sampleProject();
    await clearTasks(projectId);
    const first = await newTask(projectId, 'First');
    const second = await newTask(projectId, 'Second');
    const turnedOn = await configure(projectId, { autoStart: true });
    expect(turnedOn.status).toBe(200);
    const current = await until(projectId, (s) => s.sessions.length === 1);
    const [session] = current.sessions;
    expect(session.taskId).toBe(first.id);
    // Admitted by the Work start route's own path: a v1 receipt under the claim's command.
    const claim = current.readyQueue!.claims[0];
    expect(claim).toMatchObject({ taskId: first.id, state: 'started', sessionId: session.id });
    expect(session.receipt).toMatchObject({ commandId: claim.commandId, route: 'sample' });
    expect(store().workCommand(projectId, claim.commandId)?.id).toBe(session.id);
    expect(current.history.map((entry) => entry.sentence)).toEqual(
      expect.arrayContaining([
        'You turned on starting Ready work automatically.',
        'Diomedes started First from the Ready queue.',
      ]),
    );
    expect(current.history.find((entry) => entry.kind === 'ready-start')?.actor).toBe('diomedes');
    await quiet();
    expect(sessionsOf(projectId)).toHaveLength(1);
    const shown = await view(projectId);
    expect(shown.items.find((item) => item.taskId === second.id)).toMatchObject({
      position: 1,
      why: 'awaiting-decision',
    });
  });

  test('turning it off again restores today’s behaviour', async () => {
    const projectId = await sampleProject();
    await clearTasks(projectId);
    await configure(projectId, { autoStart: true });
    await configure(projectId, { autoStart: false });
    await newTask(projectId, 'Stays put');
    await quiet();
    expect(sessionsOf(projectId)).toEqual([]);
  });

  test('refuses a malformed request and the home project', async () => {
    const projectId = await sampleProject();
    expect((await configure(projectId, {})).status).toBe(400);
    expect((await configure(projectId, { autoStart: 'yes' })).status).toBe(400);
    expect((await configure(projectId, { autoStart: true, extra: 1 })).status).toBe(400);
    expect((await request('/ready-queue', 'PUT', { paused: 'no' })).status).toBe(400);
  });
});

describe('Trust: automatic start has no authority a manual Start would not', () => {
  test('work that asks for approval stops at its Need, and nothing is written', async () => {
    const projectId = await sampleProject();
    await clearTasks(projectId);
    const task = await newTask(projectId, 'Needs an OK');
    await configure(projectId, { autoStart: true });
    const current = await until(projectId, (s) => s.needs.some((need) => need.state === 'open'));
    const need = current.needs.find((item) => item.state === 'open')!;
    expect(need.taskId).toBe(task.id);
    expect(need.what).toBe('start working on Needs an OK');
    expect(current.sessions[0].state).toBe('waiting');
    await quiet();
    expect(state(projectId).needs.find((item) => item.id === need.id)!.state).toBe('open');
    // Nothing was proposed or written: no change record, and the sample's file is not on disk.
    expect(state(projectId).changes).toEqual([]);
    const folder = state(projectId).project.folder;
    await expect(fs.access(folder)).resolves.toBeUndefined();
    await expect(fs.access(path.join(folder, 'Sample work notes.md'))).rejects.toThrow();
  });

  test('a service route never starts a task nobody confirmed for it', async () => {
    const projectId = await sampleProject();
    await clearTasks(projectId);
    await request('/settings', 'PUT', { services: { codex: true, defaultEngine: 'codex' } });
    const task = await newTask(projectId, 'Send to Codex');
    await configure(projectId, { autoStart: true });
    await quiet();
    expect(sessionsOf(projectId)).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect((await view(projectId)).items).toEqual([
      expect.objectContaining({
        taskId: task.id,
        position: null,
        why: 'held',
        detail: `Start it yourself: sending to ${routeDisplayName('codex')} needs your confirmation`,
      }),
    ]);
  });

  // Review batch1-a, finding H07-1: a person's earlier confirmation names the documents it sends,
  // not only the engine. The queue re-sends only exactly the request the person confirmed.
  test('a confirmed start re-sends only the documents the person confirmed', async () => {
    const projectId = (await request<{ id: string }>('/projects', 'POST', { name: 'Consent fixture' }))
      .data.id;
    expect(
      (await request(`/projects/${projectId}/documents/create`, 'POST', { path: 'Brief.md', text: 'Private brief.\n' }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(`/projects/${projectId}/cloud-sharing`, 'PUT', {
          expectedVersion: 0,
          routes: ['codex'],
          documents: ['Brief.md'],
          shareConversationHistory: false,
          shareReviewPackets: false,
        })
      ).status,
    ).toBe(200);
    await request('/settings', 'PUT', { services: { codex: true, defaultEngine: 'codex' } });
    const make = async (name: string) =>
      (await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name, sourceDocument: 'Brief.md' }))
        .data;
    const withheld = await make('Sent without the brief');
    const confirmed = await make('Sent with the brief');
    const startAndReopen = async (task: Task, sources: string[]) => {
      const started = await request<Session>(`/projects/${projectId}/work/start`, 'POST', {
        protocolVersion: 1,
        commandId: `manual-${task.id}`,
        taskId: task.id,
        route: 'codex',
        sources,
        consent: true,
      });
      expect(started.status).toBe(200);
      await until(projectId, (s) => !s.sessions.some((session) => ['queued', 'working', 'waiting'].includes(session.state)));
      expect((await request(`/projects/${projectId}/tasks/${task.id}`, 'PUT', { state: 'todo' })).status).toBe(200);
    };
    // The person unticked the brief in the send dialog: nothing but the instruction left.
    await startAndReopen(withheld, []);
    await startAndReopen(confirmed, ['Brief.md']);
    generate.mockClear();
    await configure(projectId, { autoStart: true });
    await until(projectId, (s) => s.sessions.length === 3);
    await until(projectId, (s) => !s.sessions.some((session) => ['queued', 'working', 'waiting'].includes(session.state)));
    await quiet();
    // Only the task whose confirmed request matches what the queue would send starts again.
    expect(sessionsOf(projectId, withheld.id)).toHaveLength(1);
    expect(sessionsOf(projectId, confirmed.id)).toHaveLength(2);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await view(projectId)).items.find((item) => item.taskId === withheld.id)).toMatchObject({
      why: 'held',
      detail: `Start it yourself: sending to ${routeDisplayName('codex')} needs your confirmation`,
    });
  });

  test('a service turned off in Settings holds the task', async () => {
    const projectId = await sampleProject();
    await clearTasks(projectId);
    await request('/settings', 'PUT', { services: { codex: false, defaultEngine: 'codex' } });
    await newTask(projectId, 'Engine off');
    await configure(projectId, { autoStart: true });
    await quiet();
    expect(sessionsOf(projectId)).toEqual([]);
    expect((await view(projectId)).items[0]).toMatchObject({
      why: 'held',
      detail: `Start it yourself: ${routeDisplayName('codex')} is off in Settings`,
    });
  });

  test('a stopped task is not started again; the next one is', async () => {
    const projectId = await sampleProject();
    await clearTasks(projectId);
    const first = await newTask(projectId, 'First');
    const second = await newTask(projectId, 'Second');
    await configure(projectId, { autoStart: true });
    const started = await until(projectId, (s) => s.sessions.length === 1);
    expect(
      (await request(`/projects/${projectId}/work/${started.sessions[0].id}/stop`, 'POST', {})).status,
    ).toBe(200);
    const current = await until(projectId, (s) => s.sessions.length === 2);
    expect(current.sessions.map((session) => session.taskId)).toEqual([first.id, second.id]);
    await quiet();
    expect(sessionsOf(projectId, first.id)).toHaveLength(1);
  });

  test('a refusal from the Work start path is recorded and holds the task', async () => {
    const projectId = await sampleProject();
    await clearTasks(projectId);
    const task = await newTask(projectId, 'Refused');
    // Stand in for a refusal the start path can give (an update closing, a sharing refusal).
    const deps = (app.locals.readyScheduler as unknown as { deps: { admit: unknown } }).deps;
    deps.admit = async () => {
      throw new Error('The app update is accepted. New work pauses until restart.');
    };
    await configure(projectId, { autoStart: true });
    const current = await until(projectId, (s) => s.readyQueue?.claims[0]?.state === 'refused');
    expect(current.sessions).toEqual([]);
    expect(current.readyQueue!.claims[0].reason).toBe(
      'The app update is accepted. New work pauses until restart.',
    );
    await quiet();
    expect(state(projectId).readyQueue!.claims).toHaveLength(1);
    expect((await view(projectId)).items[0]).toMatchObject({
      taskId: task.id,
      why: 'held',
      detail: 'Not started automatically: The app update is accepted. New work pauses until restart.',
    });
  });
});

describe('pause', () => {
  test('a paused queue never claims, and resuming starts the oldest', async () => {
    const projectId = await sampleProject();
    await clearTasks(projectId);
    await configure(projectId, { autoStart: true, paused: true, reason: 'Stocktake' });
    const task = await newTask(projectId, 'Waits');
    await quiet();
    expect(sessionsOf(projectId)).toEqual([]);
    const shown = await view(projectId);
    expect(shown.paused).toMatchObject({ by: 'you', reason: 'Stocktake' });
    expect(shown.items[0]).toMatchObject({ taskId: task.id, why: 'paused', detail: 'Queue paused · #1 in line' });
    await configure(projectId, { paused: false });
    await until(projectId, (s) => s.sessions.length === 1);
    expect(state(projectId).history.map((entry) => entry.sentence)).toEqual(
      expect.arrayContaining(['You paused the Ready queue: Stocktake.', 'You resumed the Ready queue.']),
    );
  });

  test('pausing never stops running work', async () => {
    const projectId = await sampleProject();
    await clearTasks(projectId);
    await newTask(projectId, 'Running');
    await configure(projectId, { autoStart: true });
    const started = await until(projectId, (s) => s.sessions.length === 1);
    await configure(projectId, { paused: true });
    await request('/ready-queue', 'PUT', { paused: true, reason: 'Closing' });
    await quiet();
    expect(state(projectId).sessions.find((s) => s.id === started.sessions[0].id)!.state).toBe('waiting');
  });

  test('project and global pauses survive a restart', async () => {
    const projectId = await sampleProject();
    await clearTasks(projectId);
    await configure(projectId, { autoStart: true, paused: true, reason: 'Stocktake' });
    const other = await sampleProject();
    await clearTasks(other);
    await configure(other, { autoStart: true });
    expect((await request('/ready-queue', 'PUT', { paused: true, reason: 'Closing' })).status).toBe(200);
    await close();
    await launch();
    await newTask(projectId, 'Still paused');
    await newTask(other, 'Globally paused');
    await quiet();
    expect(sessionsOf(projectId)).toEqual([]);
    expect(sessionsOf(other)).toEqual([]);
    expect((await view(projectId)).paused?.reason).toBe('Stocktake');
    expect((await view(other)).allPaused?.reason).toBe('Closing');
    expect((await view(other)).items[0]).toMatchObject({ why: 'all-paused' });
    expect((await request('/ready-queue')).data).toMatchObject({ allPaused: { reason: 'Closing' } });
    await request('/ready-queue', 'PUT', { paused: false });
    await until(other, (s) => s.sessions.length === 1);
  });
});

describe('limits and fairness across projects', () => {
  test('two runs at most across projects; the third waits for a free slot', async () => {
    const ids = [await sampleProject(), await sampleProject(), await sampleProject()];
    for (const id of ids) {
      await clearTasks(id);
      await newTask(id, `Work in ${id}`);
    }
    for (const id of ids) await configure(id, { autoStart: true });
    await quiet();
    const running = ids.filter((id) => sessionsOf(id).length > 0);
    expect(running).toHaveLength(2);
    const waiting = ids.find((id) => !running.includes(id))!;
    expect((await view(waiting)).items[0]).toMatchObject({ why: 'limit', position: 1 });
    expect((await view(waiting)).running).toBe(2);
    // One run ends; the waiting project, never served, is next.
    const done = running[0];
    await request(`/projects/${done}/work/${sessionsOf(done)[0].id}/stop`, 'POST', {});
    await until(waiting, (s) => s.sessions.length === 1);
  });

  test('manual work counts toward the global limit', async () => {
    const manualA = await sampleProject();
    const manualB = await sampleProject();
    const automatic = await sampleProject();
    for (const id of [manualA, manualB, automatic]) await clearTasks(id);
    for (const id of [manualA, manualB]) {
      const task = await newTask(id, 'By hand');
      expect((await request(`/projects/${id}/work/start`, 'POST', { taskId: task.id })).status).toBe(200);
    }
    await newTask(automatic, 'Automatic');
    await configure(automatic, { autoStart: true });
    await quiet();
    expect(sessionsOf(automatic)).toEqual([]);
    expect((await view(automatic)).items[0]).toMatchObject({ why: 'limit' });
  });
});

describe('restart between claim and start', () => {
  for (const phase of ['claimed', 'admitted'] as const)
    test(`a restart after the ${phase} write starts the task exactly once`, async () => {
      const projectId = await sampleProject();
      await clearTasks(projectId);
      const task = await newTask(projectId, 'Once only');
      await close();
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'tests/ready-scheduler-child.ts', root, projectId, phase],
          { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stderr = '';
        child.stderr.on('data', (data) => {
          stderr += String(data).slice(0, 4000);
        });
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error(`The crash fixture did not exit. ${stderr}`));
        }, 30_000);
        child.once('exit', (exitCode) => {
          clearTimeout(timeout);
          resolve(exitCode);
        });
      });
      expect(code).toBe(phase === 'claimed' ? 70 : 71);
      const saved = JSON.parse(
        await fs.readFile(path.join(root, 'data', 'projects', projectId, 'state.json'), 'utf8'),
      ) as ProjectState;
      expect(saved.readyQueue!.claims).toEqual([expect.objectContaining({ taskId: task.id, state: 'claimed' })]);
      expect(saved.sessions.filter((s) => s.taskId === task.id)).toHaveLength(phase === 'claimed' ? 0 : 1);

      await launch();
      await quiet();
      const current = state(projectId);
      const sessions = current.sessions.filter((s) => s.taskId === task.id);
      expect(sessions).toHaveLength(1);
      const [claim] = current.readyQueue!.claims;
      expect(current.readyQueue!.claims).toHaveLength(1);
      expect(claim).toMatchObject({ state: 'started', sessionId: sessions[0].id });
      expect(sessions[0].receipt?.commandId).toBe(claim.commandId);
      // After the admitted write the restart stopped the run; Stop means stop, so it stays.
      if (phase === 'admitted') expect(sessions[0].state).toBe('stopped');
      else expect(sessions[0].state).toBe('waiting');
    }, 60_000);
});
