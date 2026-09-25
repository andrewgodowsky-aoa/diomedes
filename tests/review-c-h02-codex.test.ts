/**
 * Review C (2026-09-24): regressions for the H02 Codex-control findings in
 * docs/implementation/2026-09-24-review-c.md (RC-H02-*), on the harness of
 * tests/h02-codex-controls.test.ts with the fixture app-server. Each RC-H02 test
 * failed on the reviewed base; the guards passed and pin behaviour worth keeping.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProjectState, Session } from '../shared/types.js';
import type { ControlReceipt, RouteControlProfile } from '../shared/work-control.js';
import { createApp } from '../server/app.js';
import { createIntegrations, createRpcClient } from '../server/integrations.js';

const FIXTURE = path.resolve('tests/fixtures/codex-app-server.mjs');
const MODEL = 'fixture-codex-model';

let server: Server,
  app: Awaited<ReturnType<typeof createApp>>,
  temp: string,
  codexDir: string,
  url: string,
  projectId: string,
  taskId: string;
let clientDelayMs = 0;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
const state = async (): Promise<ProjectState> =>
  (await request(`/projects/${projectId}/state`)).data;
async function until<T>(read: () => Promise<T | undefined | null | false>, what: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Never reached ${what}.`);
}
const sessionOf = async (id: string) => (await state()).sessions.find((s) => s.id === id)!;
const settled = (id: string) =>
  until(async () => {
    const session = await sessionOf(id);
    return !['queued', 'working', 'waiting'].includes(session.state) && session;
  }, `run ${id} to settle`);

/** What the fixture was asked, in order. */
async function calls(): Promise<
  { pid: number; method: string; params: Record<string, unknown> }[]
> {
  const text = await fs.readFile(path.join(codexDir, 'calls.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function codexBuild(control: {
  capabilities?: string[];
  hold?: boolean;
  forget?: string[];
  errors?: Record<string, { code: number; message: string } | 'exit'>;
  probeErrors?: Record<string, { code: number; message: string } | 'exit'>;
}) {
  await fs.writeFile(path.join(codexDir, 'control.json'), JSON.stringify(control));
}
const control = (body: Record<string, unknown>) =>
  request(`/projects/${projectId}/controls`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    ...body,
  });
const receiptOf = (response: { status: number; data: { receipt: ControlReceipt } }) => {
  expect(response.status, JSON.stringify(response.data)).toBe(200);
  return response.data.receipt;
};
async function codexStart(task = taskId) {
  const started = await request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId: task,
    route: 'codex',
    consent: true,
    sources: ['Fall menu.md'],
  });
  expect(started.status, JSON.stringify(started.data)).toBe(200);
  return started.data as Session;
}
const profiles = async (task = taskId) =>
  (await request(`/projects/${projectId}/controls?taskId=${task}`)).data.profiles as Record<
    string,
    RouteControlProfile
  >;
const offered = (profile: RouteControlProfile) =>
  Object.values(profile.controls)
    .filter((item) => item.support !== null)
    .map((item) => `${item.control}:${item.support}`);

/** A run whose turn Codex is holding open, with its thread recorded and its turn live. */
async function holdingRun() {
  await codexBuild({ hold: true });
  const run = await codexStart();
  const recorded = await until(async () => (await sessionOf(run.id)).nativeThread, 'the thread');
  await until(async () => (await calls()).some((c) => c.method === 'turn/start'), 'the turn');
  // The adapter registers the turn once turn/start is acknowledged.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { run, thread: recorded };
}
/**
 * Everything a control could have written about the origin run: the run, its
 * Needs and History, and (for a fork, which starts nothing on the origin's task)
 * the task and its threads as well.
 */
async function originRecords(sessionId: string, withTask = false) {
  const current = await state();
  const session = current.sessions.find((s) => s.id === sessionId)!;
  return structuredClone({
    session,
    needs: current.needs.filter((n) => n.sessionId === sessionId),
    history: current.history.filter((h) => h.sessionId === sessionId),
    ...(withTask
      ? {
          task: current.tasks.find((t) => t.id === session.taskId),
          conversations: current.conversations.filter((c) => c.taskId === session.taskId),
        }
      : {}),
  });
}

async function boot() {
  const codex = createIntegrations({
    platform: 'win32',
    verifySandbox: async () => {},
    turnTimeoutMs: 20_000,
    createClient: async () => {
      if (clientDelayMs) await new Promise((resolve) => setTimeout(resolve, clientDelayMs));
      return createRpcClient(
        spawn(process.execPath, [FIXTURE], {
          env: { PATH: process.env.PATH, CODEX_FIXTURE_DIR: codexDir },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        }),
      );
    },
  });
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
    codexIntegration: codex,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function shutdown() {
  const closingApp = app,
    closingServer = server;
  try {
    await closingApp?.locals.close();
  } finally {
    if (closingServer) {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        closingServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'h02-codex-'));
  codexDir = path.join(temp, 'codex');
  await fs.mkdir(codexDir, { recursive: true });
  await codexBuild({});
  await boot();
  projectId = (await request('/projects/sample', 'POST', {})).data.id;
  taskId = (
    await request(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Prepare the reopening',
      description: 'Update the menu and write an announcement',
    })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
  expect(
    (
      await request(`/projects/${projectId}/cloud-sharing`, 'PUT', {
        expectedVersion: 0,
        routes: ['codex'],
        documents: ['Fall menu.md'],
        shareConversationHistory: false,
        shareReviewPackets: false,
      })
    ).status,
  ).toBe(200);
});
afterEach(async () => {
  clientDelayMs = 0;
  await shutdown();
  vi.unstubAllEnvs();
});

test('RC-H02-2: Fork is offered and claimed as continuable where Codex cannot resume the branch', async () => {
  await codexBuild({ capabilities: ['fork', 'steer'] });
  const run = await codexStart();
  const done = await settled(run.id);
  expect(done.nativeThread).toMatchObject({
    kept: true,
    capabilities: { resume: false, fork: true },
  });
  const profile = (await profiles())[run.id];
  const receipt = receiptOf(await control({ control: 'fork', sessionId: run.id }));
  const forkRun = await settled((await codexStart(receipt.result.taskId!)).id);
  // What was claimed vs what happened:
  //   profile.fork = native, receipt 'the new task’s first run continues it', performed by Codex;
  //   the first run is 'restarted-fresh' because this build cannot thread/resume the branch.
  expect({
    offered: profile.controls.fork.support,
    claimed: receipt.detail.includes('first run continues it'),
    firstRun: forkRun.nativeThread!.origin,
  }).toEqual({ offered: null, claimed: false, firstRun: 'started' });
});

test('RC-H02-3: an overloaded/internal Codex error during thread/resume fails the run, not a fresh start', async () => {
  const { run, thread } = await holdingRun();
  receiptOf(await control({ control: 'stop', scope: 'task', sessionId: run.id }));
  await settled(run.id);
  await codexBuild({
    errors: { 'thread/resume': { code: -32001, message: 'Server overloaded; retry later.' } },
  });
  const receipt = receiptOf(await control({ control: 'resume', sessionId: run.id }));
  const next = await settled(receipt.result.sessionId!);
  expect(receipt.detail).not.toContain('Codex no longer has that thread');
  expect(next.nativeThread?.origin).not.toBe('restarted-fresh');
  expect(next.state).toBe('failed');
  const all = await calls();
  const firstPid = all.find((x) => x.method === 'thread/start')!.pid;
  // No second thread/start: the run must not silently start fresh.
  expect(all.filter((c) => c.method === 'thread/start' && c.pid !== firstPid)).toEqual([]);
  void thread;
});

test('RC-H02-3 (probe): an overloaded answer to the capability probe is not a capability', async () => {
  await codexBuild({
    capabilities: [],
    probeErrors: { 'thread/resume': { code: -32001, message: 'Server overloaded; retry later.' } },
  });
  const run = await codexStart();
  const done = await settled(run.id);
  // Either the run fails (the probe had no answer) or resume is recorded absent; never 'present'.
  expect(done.nativeThread?.capabilities.resume ?? false).toBe(false);
});

test('RC-H02-4: thread/resume carries the same isolation fields as thread/start', async () => {
  const { run } = await holdingRun();
  receiptOf(await control({ control: 'stop', scope: 'task', sessionId: run.id }));
  await settled(run.id);
  await codexBuild({});
  const receipt = receiptOf(await control({ control: 'resume', sessionId: run.id }));
  await settled(receipt.result.sessionId!);
  const all = await calls();
  const start = all.find((c) => c.method === 'thread/start')!.params;
  const resume = all.find((c) => c.method === 'thread/resume' && c.params.threadId)!.params;
  const isolation = [
    'environments',
    'runtimeWorkspaceRoots',
    'selectedCapabilityRoots',
    'dynamicTools',
    'allowProviderModelFallback',
  ];
  expect(Object.fromEntries(isolation.map((k) => [k, resume[k]]))).toEqual(
    Object.fromEntries(isolation.map((k) => [k, start[k]])),
  );
});

test('RC-H02 guard: Codex exiting during thread/resume fails the run, never a fresh start', async () => {
  const { run } = await holdingRun();
  receiptOf(await control({ control: 'stop', scope: 'task', sessionId: run.id }));
  await settled(run.id);
  await codexBuild({ errors: { 'thread/resume': 'exit' } });
  const receipt = receiptOf(await control({ control: 'resume', sessionId: run.id }));
  const next = await settled(receipt.result.sessionId!);
  expect(next.state).toBe('failed');
  expect(next.nativeThread).toBeUndefined();
  expect(receipt.performedBy).toEqual({ kind: 'diomedes' });
});

test('RC-H02 guard: steer before the turn id is known is refused, not sent', async () => {
  await codexBuild({ hold: true });
  clientDelayMs = 800;
  const run = await codexStart();
  const early = receiptOf(await control({ control: 'steer', sessionId: run.id, text: 'early' }));
  expect(early.outcome).toBe('refused');
  expect((await calls()).filter((c) => c.method === 'turn/steer' && c.params.threadId)).toEqual([]);
  receiptOf(await control({ control: 'stop', scope: 'task', sessionId: run.id }));
  await settled(run.id);
});

test('RC-H02-5: resuming the same stopped run twice never continues a thread that has moved on', async () => {
  const { run } = await holdingRun();
  receiptOf(await control({ control: 'stop', scope: 'task', sessionId: run.id }));
  await settled(run.id);
  await codexBuild({});
  const first = receiptOf(await control({ control: 'resume', sessionId: run.id }));
  const s2 = await settled(first.result.sessionId!);
  expect(s2.nativeThread?.origin).toBe('resumed');
  const before = (await state()).sessions.length;
  const second = receiptOf(await control({ control: 'resume', sessionId: run.id }));
  // Thread T already carries S2's turn: resuming S1 again would continue S2, not S1.
  expect(second.outcome).toBe('refused');
  expect(second.refusal?.code).toBe('not-applicable');
  expect(second.refusal?.reason).toContain(s2.id);
  expect((await state()).sessions.length).toBe(before);
});

test('RC-H02-6: the restart replay (already) credits Codex with a native resume it never did', async () => {
  await codexBuild({ capabilities: ['resume', 'fork'], hold: true });
  const run = await codexStart();
  await until(async () => (await sessionOf(run.id)).nativeThread, 'thread');
  receiptOf(await control({ control: 'stop', scope: 'task', sessionId: run.id }));
  await settled(run.id);
  // Simulate a crash after the Resume's run was admitted and before its receipt:
  // the derived Work command exists; here Codex had started a fresh thread for it.
  const commandId = crypto.randomUUID();
  await codexBuild({
    capabilities: ['resume', 'fork'],
    forget: [(await sessionOf(run.id)).nativeThread!.id],
  });
  const admitted = await request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: `${commandId}:work`,
    taskId,
    route: 'codex',
    consent: true,
    sources: ['Fall menu.md'],
  });
  expect(admitted.status, JSON.stringify(admitted.data)).toBe(200);
  const fresh = await settled(admitted.data.id);
  expect(fresh.nativeThread!.origin).not.toBe('resumed');
  const receipt = receiptOf(
    await request(`/projects/${projectId}/controls`, 'POST', {
      protocolVersion: 1,
      commandId,
      taskId,
      control: 'resume',
      sessionId: run.id,
    }),
  );
  expect(receipt.performedBy).toEqual({ kind: 'diomedes' });
});
