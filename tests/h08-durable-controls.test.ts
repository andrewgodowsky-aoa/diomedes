/**
 * H08 — Steer, Queue, Stop, Resume, Retry and Fork as distinct durable
 * controls. Real HTTP through `createApp`: command identity (replay returns the
 * same receipt, a changed payload under the same id is 409), receipts for every
 * outcome, capability refusal read from the route contract, Retry blocked by an
 * uncertain effect, Resume revalidation, Fork lineage that leaves the origin
 * untouched, and receipts that survive a restart.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProjectState, Session } from '../shared/types.js';
import type { ControlReceipt, RouteControlProfile } from '../shared/work-control.js';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import { DurableControls, defaultWorkContract } from '../server/durable-controls.js';
import type { WorkControl } from '../server/work-control.js';
import type { Store } from '../server/store.js';

type NativeResult = Awaited<ReturnType<NativeGenerator>>;
const proposal = (
  changes: { path: string; text: string | null; summary: string }[],
  summary = 'Update the selected work',
): NativeResult => ({ text: JSON.stringify({ summary, changes }), model: 'test-model' });
const update = {
  path: 'Fall menu.md',
  text: '# Fall menu\n\nA revised menu.\n',
  summary: 'Rewrite the menu description',
};

let server: Server,
  app: Awaited<ReturnType<typeof createApp>>,
  temp: string,
  url: string,
  projectId: string,
  taskId: string;
let invoke: NativeGenerator;
let generator: ReturnType<typeof vi.fn<NativeGenerator>>;
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
async function until(predicate: (result: ProjectState) => boolean, what = 'the expected state') {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await state();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Never reached ${what}.`);
}
const control = (body: Record<string, unknown>) =>
  request(`/projects/${projectId}/controls`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    ...body,
  });
const receiptOf = (response: { status: number; data: { receipt: ControlReceipt } }) => {
  expect(response.status).toBe(200);
  return response.data.receipt;
};
const codexStart = (sources = ['Fall menu.md']) =>
  request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    route: 'codex',
    consent: true,
    sources,
  });
const sampleStart = (threadId?: string) =>
  request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    route: 'sample',
    ...(threadId ? { threadId } : {}),
  });
const fixture = (enabled: boolean) =>
  request(`/projects/${projectId}/controls/fixture`, 'PUT', { enabled });
const settledRun = (sessionId: string) =>
  until(
    (r) =>
      !['queued', 'working', 'waiting'].includes(
        r.sessions.find((s) => s.id === sessionId)?.state ?? 'queued',
      ),
    `run ${sessionId} to settle`,
  );
async function taskThread(): Promise<string> {
  const created = await request(`/projects/${projectId}/threads`, 'POST', {
    attachedTo: { kind: 'task', ref: taskId },
  });
  expect(created.status).toBe(201);
  return created.data.id;
}
/** A stopped sample run on a project whose sample route is answered by the control fixture. */
async function stoppedSampleRun(threadId?: string): Promise<Session> {
  const started = await sampleStart(threadId);
  expect(started.status).toBe(200);
  const session = started.data as Session;
  const stop = receiptOf(await control({ control: 'stop', scope: 'task', sessionId: session.id }));
  expect(stop.outcome).toBe('applied');
  return (await state()).sessions.find((s) => s.id === session.id)!;
}

beforeEach(async () => {
  vi.stubEnv('DIOMEDES_TEST_MODE', '1');
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'h08-controls-'));
  invoke = async () => proposal([update]);
  generator = vi.fn((input: Parameters<NativeGenerator>[0]) => invoke(input));
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
async function boot() {
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
    nativeGenerator: generator,
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
afterEach(async () => {
  await shutdown();
  vi.unstubAllEnvs();
});

test('each route offers the controls its contract declares, and the Console reads the same answer', async () => {
  invoke = async () => proposal([], 'Nothing needed changing');
  const codex = (await codexStart()).data as Session;
  await settledRun(codex.id);
  const sample = await stoppedSampleRun();
  const plain = (await request(`/projects/${projectId}/controls?taskId=${taskId}`)).data
    .profiles as Record<string, RouteControlProfile>;
  const offered = (profile: RouteControlProfile) =>
    Object.values(profile.controls)
      .filter((item) => item.support !== null)
      .map((item) => `${item.control}:${item.support}`);
  expect(offered(plain[codex.id])).toEqual(['queue:host', 'stop:host', 'retry:host']);
  expect(plain[codex.id].stopScopes).toEqual(['generation', 'task', 'queued']);
  expect(plain[codex.id].controls.steer.note).toBe(
    defaultWorkContract('codex')!.commands.steer.note,
  );
  expect(offered(plain[sample.id])).toEqual(['queue:host', 'stop:host']);
  expect(plain[sample.id].stopScopes).toEqual(['task', 'queued']);
  await fixture(true);
  const all = (await request(`/projects/${projectId}/controls?taskId=${taskId}`)).data
    .profiles as Record<string, RouteControlProfile>;
  expect(offered(all[sample.id])).toEqual([
    'steer:native',
    'queue:host',
    'stop:host',
    'resume:native',
    'retry:host',
    'fork:host',
  ]);
  expect(all[sample.id].contractRouteId).toBe('control-fixture');
});

test('steer reaches the running turn once, replays its receipt, and a changed payload is 409', async () => {
  await fixture(true);
  const live = (await sampleStart()).data as Session;
  const commandId = crypto.randomUUID();
  const first = receiptOf(
    await control({ commandId, control: 'steer', sessionId: live.id, text: 'Keep it short.' }),
  );
  expect(first).toMatchObject({
    control: 'steer',
    family: 'steer',
    outcome: 'applied',
    contractRevision: '2026-09-24.1',
    requestedBy: { actor: 'you', via: 'local-client' },
    performedBy: { kind: 'engine', engine: 'control-fixture' },
    target: { taskId, sessionId: live.id },
    route: { workRoute: 'sample', contractRouteId: 'control-fixture', support: 'native' },
  });
  const again = receiptOf(
    await control({ commandId, control: 'steer', sessionId: live.id, text: 'Keep it short.' }),
  );
  expect(again).toEqual(first);
  const conflict = await control({
    commandId,
    control: 'steer',
    sessionId: live.id,
    text: 'Make it long.',
  });
  expect(conflict.status).toBe(409);
  expect(conflict.data.code).toBe('control_command_conflict');
  const after = await state();
  const steered = after.sessions
    .find((s) => s.id === live.id)!
    .log.filter((line) => line.sentence === 'Steered while running: Keep it short.');
  expect(steered).toHaveLength(1);
  expect(after.controlReceipts).toHaveLength(1);
  // A run that has ended is not steered.
  await control({ control: 'stop', scope: 'task', sessionId: live.id });
  const late = receiptOf(
    await control({ control: 'steer', sessionId: live.id, text: 'Too late.' }),
  );
  expect(late.outcome).toBe('refused');
  expect(late.refusal?.code).toBe('not-applicable');
  expect(late.performedBy).toBeNull();
});

test('a route without live steering refuses Steer with its own reason and points to Queue', async () => {
  const live = (await sampleStart()).data as Session;
  const refusal = receiptOf(
    await control({ control: 'steer', sessionId: live.id, text: 'Faster please.' }),
  );
  expect(refusal.outcome).toBe('refused');
  expect(refusal.refusal).toEqual({
    code: 'unsupported',
    reason: 'A staged run has no steering channel. Queue the message to send it after this turn.',
  });
  expect(refusal.route).toEqual({ workRoute: 'sample', contractRouteId: 'sample', support: null });
  const after = await state();
  expect(
    after.sessions.find((s) => s.id === live.id)!.log.some((l) => l.sentence.includes('Faster')),
  ).toBe(false);
  // Refused, yet recorded: what was asked for and not done is part of the task.
  expect(after.controlReceipts?.map((r) => r.outcome)).toEqual(['refused']);
});

test('queue holds a follow-up under a derived Work identity, and replays without a second one', async () => {
  const commandId = crypto.randomUUID();
  const body = {
    commandId,
    control: 'queue',
    text: 'Also refresh the dessert list.',
    waitsFor: 'task',
    route: 'codex',
  };
  const first = receiptOf(await control(body));
  expect(first).toMatchObject({ outcome: 'queued', family: 'follow-up.queue' });
  expect(first.performedBy).toEqual({ kind: 'diomedes' });
  const again = receiptOf(await control(body));
  expect(again).toEqual(first);
  const conflict = await control({ ...body, waitsFor: 'turn' });
  expect(conflict.status).toBe(409);
  const after = await state();
  expect(after.followUps).toHaveLength(1);
  expect(after.followUps![0].id).toBe(first.result.followUpId);
  expect(after.followUps![0].commandId).toBe(`${commandId}:work`);
});

test('stop keeps its three scopes, embeds what the stop did, and refuses a scope the route cannot honour', async () => {
  const live = (await sampleStart()).data as Session;
  const generation = receiptOf(
    await control({ control: 'stop', scope: 'generation', sessionId: live.id }),
  );
  expect(generation.outcome).toBe('refused');
  expect(generation.refusal?.reason).toBe(
    'This route cannot stop only the request in flight: Stop is the only interruption.',
  );
  expect((await state()).sessions.find((s) => s.id === live.id)!.state).toBe('waiting');
  const commandId = crypto.randomUUID();
  const task = receiptOf(
    await control({ commandId, control: 'stop', scope: 'task', sessionId: live.id }),
  );
  expect(task.outcome).toBe('applied');
  expect(task.result.stop).toMatchObject({ scope: 'task', acknowledged: true, sessionId: live.id });
  const replay = receiptOf(
    await control({ commandId, control: 'stop', scope: 'task', sessionId: live.id }),
  );
  expect(replay).toEqual(task);
  expect((await state()).tasks.find((t) => t.id === taskId)!.stopReceipts).toHaveLength(1);
  const conflict = await control({
    commandId,
    control: 'stop',
    scope: 'queued',
    sessionId: live.id,
  });
  expect(conflict.status).toBe(409);
  const nothing = receiptOf(await control({ control: 'stop', scope: 'task' }));
  expect(nothing.outcome).toBe('refused');
  expect(nothing.refusal?.code).toBe('nothing-to-stop');
  // The stopped run's evidence stays: its log and History are untouched by later controls.
  const stopped = (await state()).sessions.find((s) => s.id === live.id)!;
  expect(stopped.state).toBe('stopped');
  expect(stopped.log.length).toBeGreaterThan(0);
});

test('retry starts a new attempt with the same inputs, linked to the original, and never twice', async () => {
  invoke = async () => {
    throw new Error('The engine went away.');
  };
  const original = (await codexStart()).data as Session;
  await until(
    (r) => r.sessions.find((s) => s.id === original.id)?.state === 'failed',
    'a failed run',
  );
  invoke = async () => proposal([], 'Nothing needed changing');
  const commandId = crypto.randomUUID();
  const retry = receiptOf(await control({ commandId, control: 'retry', sessionId: original.id }));
  expect(retry).toMatchObject({
    outcome: 'applied',
    family: 'retry',
    performedBy: { kind: 'diomedes' },
    route: { workRoute: 'codex', contractRouteId: 'codex', support: 'host' },
    lineage: { kind: 'retry', originTaskId: taskId, originSessionId: original.id, attempt: 2 },
  });
  expect(retry.revalidated).toContain('Route: codex is still available.');
  const after = await state();
  const next = after.sessions.find((s) => s.id === retry.result.sessionId)!;
  expect(next.receipt?.commandId).toBe(`${commandId}:work`);
  expect(next.inputs).toEqual(original.inputs);
  expect(generator).toHaveBeenCalledTimes(2);
  const [first, second] = generator.mock.calls.map((call) => call[0]);
  expect(second.documents.map((d) => d.path)).toEqual(['Fall menu.md']);
  expect(second.prompt).toBe(first.prompt);
  // Replay: the same receipt, and no third dispatch.
  const again = receiptOf(await control({ commandId, control: 'retry', sessionId: original.id }));
  expect(again).toEqual(retry);
  expect(generator).toHaveBeenCalledTimes(2);
  await settledRun(next.id);
  // The original is evidence: still failed, its log intact.
  const origin = (await state()).sessions.find((s) => s.id === original.id)!;
  expect(origin.state).toBe('failed');
  expect(origin.log).toEqual(after.sessions.find((s) => s.id === original.id)!.log);
});

test('retry is blocked while an effect of the run may already have happened, and nothing is sent', async () => {
  const original = (await codexStart()).data as Session;
  const ready = await until((r) => r.needs.some((n) => n.state === 'open'), 'an open proposal');
  const need = ready.needs.find((n) => n.state === 'open')!;
  await request(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    resolution: 'go-ahead',
    allowForTask: false,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  });
  await settledRun(original.id);
  // What recovery records when an approved write met outside edits: the run
  // failed, and some of the change may have been written.
  const store = app.locals.store as Store;
  await store.locked(async () => {
    const current = store.state(projectId);
    const saved = current.needs.find((n) => n.id === need.id)!;
    saved.execution = { ...saved.execution!, state: 'conflicted', conflicts: ['Fall menu.md'] };
    current.sessions.find((s) => s.id === original.id)!.state = 'failed';
    await store.persist(current);
  });
  const calls = generator.mock.calls.length;
  const blocked = receiptOf(await control({ control: 'retry', sessionId: original.id }));
  expect(blocked.outcome).toBe('refused');
  expect(blocked.refusal?.code).toBe('uncertain-effects');
  expect(blocked.uncertainEffects).toEqual([
    `Some of the approved change “${need.what}” may have been written while outside edits were kept.`,
  ]);
  expect(generator.mock.calls.length).toBe(calls);
  expect((await state()).sessions).toHaveLength(1);
});

test('resume revalidates permission, inputs and the route before it continues a stopped run', async () => {
  await fixture(true);
  const threadId = await taskThread();
  const stopped = await stoppedSampleRun(threadId);
  expect(stopped.inputs).toEqual({ instruction: '', sources: [], agentId: null, mode: 'build' });
  // Widened since the stop: refused, nothing started.
  await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { permission: 'task' });
  const widened = receiptOf(await control({ control: 'resume', sessionId: stopped.id }));
  expect(widened.refusal?.code).toBe('permission-widened');
  expect((await state()).sessions).toHaveLength(1);
  await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { permission: 'show-first' });
  const commandId = crypto.randomUUID();
  const resumed = receiptOf(await control({ commandId, control: 'resume', sessionId: stopped.id }));
  expect(resumed).toMatchObject({
    outcome: 'applied',
    performedBy: { kind: 'engine', engine: 'control-fixture' },
    lineage: { kind: 'resume', originSessionId: stopped.id },
  });
  expect(resumed.revalidated).toEqual([
    'Route: sample is still available.',
    'Permission: every change waits for your OK.',
  ]);
  const after = await state();
  const next = after.sessions.find((s) => s.id === resumed.result.sessionId)!;
  expect(next.receipt?.commandId).toBe(`${commandId}:work`);
  expect(next.permission).toBe('show-first');
  // A live run is not resumed, and Retry is a different command with its own lineage.
  const notStopped = receiptOf(await control({ control: 'resume', sessionId: next.id }));
  expect(notStopped.refusal?.code).toBe('not-applicable');
});

test('resume refuses when a source changed since the stop, and when the route is turned off', async () => {
  // A resumable route with documents: the codex route answered by a contract that
  // declares resume, and a driver that continues through ordinary admission.
  invoke = ({ signal }) =>
    new Promise<NativeResult>((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new Error('Stopped.'))),
    );
  const original = (await codexStart()).data as Session;
  const stopped = receiptOf(
    await control({ control: 'stop', scope: 'task', sessionId: original.id }),
  );
  expect(stopped.outcome).toBe('applied');
  const store = app.locals.store as Store;
  const base = defaultWorkContract('codex')!;
  const admitted: Record<string, unknown>[] = [];
  const controls = new DurableControls({
    store,
    workControl: app.locals.workControl as WorkControl,
    admit: async (_projectId, command) => {
      admitted.push(command);
      return { id: 'S-admitted' };
    },
    contractFor: () => ({
      ...base,
      commands: { ...base.commands, resume: { support: 'native', note: 'Test resume.' } },
    }),
  });
  controls.registerDriver('codex', {
    resume: async (context) => ({ sessionId: (await context.start()).id }),
  });
  const perform = (body: Record<string, unknown>) =>
    store.locked(() =>
      controls.perform(projectId, {
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        taskId,
        ...body,
      }),
    );
  await fs.writeFile(
    path.join(store.state(projectId).project.folder, 'Fall menu.md'),
    '# Fall menu\n\nEdited by hand after the stop.\n',
  );
  const changed = await perform({ control: 'resume', sessionId: original.id });
  expect(changed.refusal).toEqual({
    code: 'inputs-changed',
    reason:
      'Fall menu.md changed since this run stopped. Retry to run again on the current version.',
  });
  expect(admitted).toHaveLength(0);
  const gone = new DurableControls({
    store,
    workControl: app.locals.workControl as WorkControl,
    admit: async () => ({ id: 'never' }),
    routeAvailable: (route) => route !== 'codex',
    contractFor: () => ({
      ...base,
      commands: { ...base.commands, resume: { support: 'native', note: 'Test resume.' } },
    }),
  });
  gone.registerDriver('codex', { resume: async () => ({ sessionId: 'never' }) });
  const withdrawn = await store.locked(() =>
    gone.perform(projectId, {
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      taskId,
      control: 'resume',
      sessionId: original.id,
    }),
  );
  expect(withdrawn.refusal).toEqual({
    code: 'admission-refused',
    reason: 'The codex route is no longer available.',
  });
});

test('fork makes a new lineage that refers to the origin and leaves every origin record unchanged', async () => {
  await fixture(true);
  const threadId = await taskThread();
  const stopped = await stoppedSampleRun(threadId);
  const before = await state();
  const originRecords = (s: ProjectState) => ({
    task: s.tasks.find((t) => t.id === taskId),
    sessions: s.sessions.filter((x) => x.taskId === taskId),
    thread: s.conversations.find((c) => c.id === threadId),
    history: s.history.filter((h) => h.taskId === taskId),
    needs: s.needs.filter((n) => n.taskId === taskId),
  });
  const commandId = crypto.randomUUID();
  const fork = receiptOf(await control({ commandId, control: 'fork', sessionId: stopped.id }));
  expect(fork).toMatchObject({
    outcome: 'applied',
    family: 'fork',
    performedBy: { kind: 'diomedes' },
    lineage: { kind: 'fork', originTaskId: taskId, originSessionId: stopped.id },
  });
  const after = await state();
  expect(originRecords(after)).toEqual(originRecords(before));
  const forked = after.tasks.find((t) => t.id === fork.result.taskId)!;
  expect(forked.name).toBe('Fork of Prepare the reopening');
  expect(forked.sessionIds).toEqual([]);
  const forkThread = after.conversations.find((c) => c.id === fork.result.threadId)!;
  expect(forkThread).toMatchObject({ taskId: forked.id, turns: [], permission: 'show-first' });
  // Replay makes no second fork.
  expect(receiptOf(await control({ commandId, control: 'fork', sessionId: stopped.id }))).toEqual(
    fork,
  );
  expect((await state()).tasks.filter((t) => t.name === forked.name)).toHaveLength(1);
  // A route that declares no fork refuses it by its contract's own words.
  await fixture(false);
  const refused = receiptOf(await control({ control: 'fork', sessionId: stopped.id }));
  expect(refused.refusal).toEqual({ code: 'unsupported', reason: 'A staged run has no lineage.' });
});

test('control identities share the project command namespace with Work starts', async () => {
  const commandId = crypto.randomUUID();
  receiptOf(await control({ commandId, control: 'stop', scope: 'queued' }));
  const start = await request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId,
    taskId,
    route: 'codex',
    consent: true,
    sources: [],
  });
  expect(start.status).toBe(409);
  const started = (await sampleStart()).data as Session;
  const reuse = await control({
    commandId: started.receipt!.commandId,
    control: 'stop',
    scope: 'task',
  });
  expect(reuse.status).toBe(409);
  expect(reuse.data.code).toBe('control_command_conflict');
  const invalid = await control({ control: 'teleport', sessionId: started.id });
  expect(invalid.status).toBe(400);
  const unknownRun = await control({ control: 'retry', sessionId: 'S-nope' });
  expect(unknownRun.status).toBe(404);
});

test('receipts survive a restart, and a replay after it performs nothing', async () => {
  await fixture(true);
  const stopped = await stoppedSampleRun();
  const commandId = crypto.randomUUID();
  const retry = receiptOf(await control({ commandId, control: 'retry', sessionId: stopped.id }));
  expect(retry.outcome).toBe('applied');
  const before = (await request(`/projects/${projectId}/controls`)).data
    .receipts as ControlReceipt[];
  expect(before.map((r) => r.control)).toEqual(['stop', 'retry']);
  await shutdown();
  await boot();
  const after = (await request(`/projects/${projectId}/controls`)).data
    .receipts as ControlReceipt[];
  expect(after).toEqual(before);
  const byId = await request(`/projects/${projectId}/controls/${encodeURIComponent(commandId)}`);
  expect(byId.data).toEqual(retry);
  const sessions = (await state()).sessions.length;
  const replay = receiptOf(await control({ commandId, control: 'retry', sessionId: stopped.id }));
  expect(replay).toEqual(retry);
  expect((await state()).sessions).toHaveLength(sessions);
  const conflict = await control({ commandId, control: 'resume', sessionId: stopped.id });
  expect(conflict.status).toBe(409);
});
