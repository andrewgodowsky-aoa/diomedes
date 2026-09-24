/**
 * H02 — Codex native steering, resume and fork for Work runs, through the H08
 * durable controls. Real HTTP through `createApp`, the real Codex adapter
 * (`createIntegrations`) and a real child process speaking the app-server's
 * JSON-RPC over stdio (`tests/fixtures/codex-app-server.mjs`), which keeps its
 * threads on disk so a second process finds them.
 *
 * What is proven: the thread id is recorded with the run before the turn is
 * sent; what the installed Codex offers is asked of it and decides what the
 * Console is offered; Steer reaches the running turn where Codex offers it and
 * is refused in favour of Queue where it does not; Resume continues the same
 * thread after a Stop and after a restart, and starts a new thread and says so
 * where it cannot; Fork branches a settled thread or is refused with a reason;
 * the origin's records never change; and each control leaves its H08 receipt
 * with truthful attribution. No live Codex is used or claimed.
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
async function calls(): Promise<{ pid: number; method: string; params: Record<string, unknown> }[]> {
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
    createClient: async () =>
      createRpcClient(
        spawn(process.execPath, [FIXTURE], {
          env: { PATH: process.env.PATH, CODEX_FIXTURE_DIR: codexDir },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        }),
      ),
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
  await shutdown();
  vi.unstubAllEnvs();
});

test('a Codex Work run records its thread before the turn, and offers what this Codex advertised', async () => {
  const { run, thread } = await holdingRun();
  // Recorded before the turn was sent, with what Codex itself answered.
  expect(thread).toMatchObject({
    provider: 'codex',
    kept: true,
    origin: 'started',
    from: null,
    capabilities: { resume: true, fork: true, steer: true },
    version: '0.153.4',
    model: MODEL,
  });
  const asked = await calls();
  const start = asked.find((c) => c.method === 'thread/start')!;
  expect(start.params.ephemeral).toBe(false);
  expect(asked.findIndex((c) => c.method === 'thread/start')).toBeLessThan(
    asked.findIndex((c) => c.method === 'turn/start'),
  );
  // The three methods were asked of the process, not assumed from its version.
  expect(asked.filter((c) => ['thread/resume', 'thread/fork', 'turn/steer'].includes(c.method)).map((c) => [c.method, c.params])).toEqual([
    ['thread/resume', {}],
    ['thread/fork', {}],
    ['turn/steer', {}],
  ]);
  const working = (await profiles())[run.id];
  expect(working.contractRouteId).toBe('codex');
  expect(offered(working)).toEqual([
    'steer:native',
    'queue:host',
    'stop:host',
    'resume:native',
    'retry:host',
    'fork:native',
  ]);
  await codexBuild({});
  receiptOf(await control({ control: 'steer', sessionId: run.id, text: 'Keep it short.' }));
  const done = await settled(run.id);
  expect(done.state).toBe('done');
  // The thread record stays with the run's evidence; a settled run is not steered.
  expect(done.nativeThread).toEqual(thread);
  expect((await profiles())[run.id].controls.steer.support).toBeNull();
});

test('Steer reaches the running Codex turn and leaves a receipt performed by Codex', async () => {
  const { run, thread } = await holdingRun();
  const receipt = receiptOf(
    await control({ control: 'steer', sessionId: run.id, text: 'Mention the new opening hours.' }),
  );
  expect(receipt).toMatchObject({
    control: 'steer',
    outcome: 'applied',
    route: { workRoute: 'codex', contractRouteId: 'codex', support: 'native' },
    performedBy: { kind: 'engine', engine: 'codex', version: '0.153.4', model: MODEL },
    refusal: null,
  });
  expect(receipt.detail).toContain(thread.id);
  const steer = (await calls()).find((c) => c.method === 'turn/steer' && c.params.threadId)!;
  const turn = (await calls()).find((c) => c.method === 'turn/start')!;
  expect(steer.params).toMatchObject({
    threadId: thread.id,
    input: [{ type: 'text', text: 'Mention the new opening hours.' }],
  });
  expect(steer.params.expectedTurnId).toMatch(/^turn_/);
  expect(steer.pid).toBe(turn.pid);
  const done = await settled(run.id);
  // The running turn itself answered with the message in it.
  expect(done.log.map((l) => l.sentence).join('\n')).toContain(
    'Steered: Mention the new opening hours.',
  );
  expect(done.log.map((l) => l.sentence)).toContain('Codex took your message into the running turn.');
});

test('where Codex does not offer mid-turn input, Steer is refused and Queue is what is offered', async () => {
  await codexBuild({ capabilities: ['resume', 'fork'], hold: true });
  const run = await codexStart();
  await until(async () => (await sessionOf(run.id)).nativeThread, 'the thread');
  const profile = (await profiles())[run.id];
  expect(profile.controls.steer.support).toBeNull();
  expect(profile.controls.steer.note).toBe(
    'This Codex build does not take input into a running turn, so a message waits for the turn to end.',
  );
  expect(profile.controls.queue.support).toBe('host');
  const refusedSteer = receiptOf(
    await control({ control: 'steer', sessionId: run.id, text: 'Now, please.' }),
  );
  expect(refusedSteer).toMatchObject({
    outcome: 'refused',
    performedBy: null,
    refusal: { code: 'unsupported' },
  });
  expect(refusedSteer.refusal!.reason).toContain('Queue the message');
  expect((await calls()).filter((c) => c.method === 'turn/steer' && c.params.threadId)).toEqual([]);
  const queued = receiptOf(
    await control({
      control: 'queue',
      text: 'Now, please.',
      waitsFor: 'task',
      route: 'codex',
      sources: ['Fall menu.md'],
    }),
  );
  expect(queued).toMatchObject({ outcome: 'queued', performedBy: { kind: 'diomedes' } });
  expect(queued.detail).toMatch(/^Queued to send/);
});

test('Resume after Stop continues the same Codex thread in a new run; the stopped run is untouched', async () => {
  const { run, thread } = await holdingRun();
  receiptOf(await control({ control: 'stop', scope: 'task', sessionId: run.id }));
  const stopped = await settled(run.id);
  expect(stopped.state).toBe('stopped');
  expect(stopped.nativeThread).toEqual(thread);
  const before = await originRecords(run.id);
  expect(offered((await profiles())[run.id])).toContain('resume:native');
  await codexBuild({});
  const receipt = receiptOf(await control({ control: 'resume', sessionId: run.id }));
  expect(receipt).toMatchObject({
    control: 'resume',
    outcome: 'applied',
    route: { contractRouteId: 'codex', support: 'native' },
    performedBy: { kind: 'engine', engine: 'codex', version: '0.153.4', model: MODEL },
    lineage: { kind: 'resume', originSessionId: run.id },
    result: { nativeThreadId: thread.id },
  });
  expect(receipt.detail).toBe(
    `Codex continued thread ${thread.id} in a new run (${receipt.result.sessionId}).`,
  );
  const resumed = await settled(receipt.result.sessionId!);
  expect(resumed.nativeThread).toMatchObject({ id: thread.id, origin: 'resumed', from: thread.id });
  // A new process continued the thread the stopped one had kept.
  const resume = (await calls()).find((c) => c.method === 'thread/resume' && c.params.threadId)!;
  expect(resume.params).toMatchObject({ threadId: thread.id, sandbox: 'read-only', approvalPolicy: 'never' });
  expect(resume.pid).not.toBe((await calls()).find((c) => c.method === 'thread/start')!.pid);
  expect(resumed.log.map((l) => l.sentence)).toContain(`Codex continued thread ${thread.id}.`);
  // The thread carried the stopped turn: this answer is its second user turn.
  expect(resumed.log.map((l) => l.sentence).join('\n')).toContain('after 2 user turns');
  expect(await originRecords(run.id)).toEqual(before);
  // Replaying the control changes nothing and starts nothing.
  const replay = await request(`/projects/${projectId}/controls`, 'POST', {
    protocolVersion: 1,
    commandId: receipt.commandId,
    taskId,
    control: 'resume',
    sessionId: run.id,
  });
  expect(replay.data.receipt).toEqual(receipt);
});

test('Resume after a Diomedes restart continues the thread the run recorded', async () => {
  const { run, thread } = await holdingRun();
  await shutdown();
  await codexBuild({});
  await boot();
  const stopped = await sessionOf(run.id);
  expect(stopped.state).toBe('stopped');
  expect(stopped.nativeThread).toEqual(thread);
  const receipt = receiptOf(await control({ control: 'resume', sessionId: run.id }));
  expect(receipt).toMatchObject({
    outcome: 'applied',
    performedBy: { kind: 'engine', engine: 'codex' },
    result: { nativeThreadId: thread.id },
  });
  const resumed = await settled(receipt.result.sessionId!);
  expect(resumed.nativeThread).toMatchObject({ id: thread.id, origin: 'resumed' });
  expect(resumed.log.map((l) => l.sentence).join('\n')).toContain('after 2 user turns');
});

test('where Codex cannot resume, Resume starts a new Codex thread and says so', async () => {
  // This build offers no resume or fork, so the thread is not kept at all.
  await codexBuild({ capabilities: [], hold: true });
  const run = await codexStart();
  const thread = await until(async () => (await sessionOf(run.id)).nativeThread, 'the thread');
  expect(thread).toMatchObject({ kept: false, capabilities: { resume: false, fork: false, steer: false } });
  expect((await calls()).find((c) => c.method === 'thread/start')!.params.ephemeral).toBe(true);
  receiptOf(await control({ control: 'stop', scope: 'task', sessionId: run.id }));
  await settled(run.id);
  const profile = (await profiles())[run.id];
  expect(offered(profile)).toEqual(['queue:host', 'stop:host', 'resume:host', 'retry:host']);
  expect(profile.controls.fork.note).toBe(
    'This Codex build does not offer thread fork, so a Codex run cannot be forked.',
  );
  await codexBuild({ capabilities: [] });
  const receipt = receiptOf(await control({ control: 'resume', sessionId: run.id }));
  expect(receipt).toMatchObject({
    outcome: 'applied',
    route: { support: 'host' },
    performedBy: { kind: 'diomedes' },
  });
  const fresh = await settled(receipt.result.sessionId!);
  const sentence = `Couldn't resume Codex thread ${thread.id}: the run that used it could not keep it, because that Codex build offered no resume. Started a new Codex thread; earlier messages were not carried.`;
  expect(receipt.detail).toBe(`${sentence} The new run is ${fresh.id}.`);
  expect(fresh.nativeThread).toMatchObject({ origin: 'restarted-fresh', from: thread.id, detail: sentence });
  expect(fresh.nativeThread!.id).not.toBe(thread.id);
  expect(receipt.result.nativeThreadId).toBe(fresh.nativeThread!.id);
  expect(fresh.log.map((l) => l.sentence)).toContain(sentence);
  expect((await calls()).filter((c) => c.method === 'thread/resume' && c.params.threadId)).toEqual([]);
});

test('a kept thread Codex no longer has, or a build that dropped resume, also starts fresh and says why', async () => {
  const first = await holdingRun();
  receiptOf(await control({ control: 'stop', scope: 'task', sessionId: first.run.id }));
  await settled(first.run.id);
  await codexBuild({ forget: [first.thread.id] });
  const gone = receiptOf(await control({ control: 'resume', sessionId: first.run.id }));
  expect(gone.performedBy).toEqual({ kind: 'diomedes' });
  expect(gone.detail).toContain(
    `Couldn't resume Codex thread ${first.thread.id}: Codex no longer has that thread.`,
  );
  const goneRun = await settled(gone.result.sessionId!);
  expect(goneRun.nativeThread).toMatchObject({ origin: 'restarted-fresh', from: first.thread.id });

  // A later build without resume: the saved id is not even asked for.
  await codexBuild({ capabilities: ['fork', 'steer'], hold: true });
  const second = await codexStart();
  const secondThread = await until(async () => (await sessionOf(second.id)).nativeThread, 'thread');
  receiptOf(await control({ control: 'stop', scope: 'task', sessionId: second.id }));
  await settled(second.id);
  await codexBuild({ capabilities: ['fork', 'steer'] });
  const dropped = receiptOf(await control({ control: 'resume', sessionId: second.id }));
  expect(dropped.detail).toContain(
    `Couldn't resume Codex thread ${secondThread.id}: this Codex build does not offer thread resume.`,
  );
});

test('Fork branches a settled Codex thread into a new task, leaves the origin untouched, and its first run continues the branch', async () => {
  const run = await codexStart();
  const done = await settled(run.id);
  const thread = done.nativeThread!;
  const before = await originRecords(run.id, true);
  const tasksBefore = (await state()).tasks.length;
  expect((await profiles())[run.id].controls.fork.support).toBe('native');
  const receipt = receiptOf(await control({ control: 'fork', sessionId: run.id }));
  expect(receipt).toMatchObject({
    control: 'fork',
    outcome: 'applied',
    route: { contractRouteId: 'codex', support: 'native' },
    performedBy: { kind: 'engine', engine: 'codex', version: '0.153.4', model: MODEL },
    lineage: { kind: 'fork', originTaskId: taskId, originSessionId: run.id },
  });
  const branch = receipt.result.nativeThreadId!;
  expect(branch).toMatch(/^thr_/);
  expect(branch).not.toBe(thread.id);
  expect(receipt.detail).toBe(
    `Codex forked thread ${thread.id} into ${branch}; the new task’s first run continues it. Forked into Fork of Prepare the reopening, from ${run.id}. Nothing runs until you start it.`,
  );
  const saved = JSON.parse(await fs.readFile(path.join(codexDir, 'threads', `${branch}.json`), 'utf8'));
  expect(saved.forkedFrom).toBe(thread.id);
  // Nothing ran: the fork asked Codex for a branch and sent no turn.
  expect((await calls()).filter((c) => c.method === 'turn/start')).toHaveLength(1);
  const after = await state();
  expect(after.tasks).toHaveLength(tasksBefore + 1);
  expect(after.sessions.filter((s) => s.taskId === receipt.result.taskId)).toEqual([]);
  expect(after.conversations.find((c) => c.id === receipt.result.threadId)).toMatchObject({
    taskId: receipt.result.taskId,
    permission: 'show-first',
  });
  expect(await originRecords(run.id, true)).toEqual(before);

  const forkRun = await codexStart(receipt.result.taskId!);
  const forkDone = await settled(forkRun.id);
  expect(forkDone.nativeThread).toMatchObject({ id: branch, origin: 'forked', from: thread.id });
  expect(forkDone.log.map((l) => l.sentence)).toContain(
    `Codex continued thread ${branch}, its branch of ${thread.id}.`,
  );
  expect(forkDone.log.map((l) => l.sentence).join('\n')).toContain('after 2 user turns');
  // Only the first run continues the branch; a later Start is a new thread.
  const later = await settled((await codexStart(receipt.result.taskId!)).id);
  expect(later.nativeThread).toMatchObject({ origin: 'started' });
  expect(later.nativeThread!.id).not.toBe(branch);
  expect(await originRecords(run.id, true)).toEqual(before);
});

test('Fork is refused with the reason where Codex cannot fork, and nothing is made', async () => {
  await codexBuild({ capabilities: ['resume', 'steer'] });
  const run = await codexStart();
  await settled(run.id);
  const before = await originRecords(run.id, true);
  const tasksBefore = (await state()).tasks.length;
  const receipt = receiptOf(await control({ control: 'fork', sessionId: run.id }));
  expect(receipt).toMatchObject({
    outcome: 'refused',
    performedBy: null,
    refusal: {
      code: 'unsupported',
      reason: 'This Codex build does not offer thread fork, so a Codex run cannot be forked.',
    },
  });
  expect(await originRecords(run.id, true)).toEqual(before);

  // A build that forks, asked to fork a thread it no longer has: Codex refuses.
  await codexBuild({});
  const kept = await settled((await codexStart()).id);
  const keptBefore = await originRecords(kept.id, true);
  await codexBuild({ forget: [kept.nativeThread!.id] });
  const declined = receiptOf(await control({ control: 'fork', sessionId: kept.id }));
  expect(declined).toMatchObject({
    outcome: 'refused',
    performedBy: null,
    refusal: {
      code: 'route-refused',
      reason: `Codex did not accept a fork of thread ${kept.nativeThread!.id} (it may no longer have it), so no fork was made.`,
    },
  });
  expect((await state()).tasks).toHaveLength(tasksBefore);
  expect(await originRecords(kept.id, true)).toEqual(keptBefore);
});
