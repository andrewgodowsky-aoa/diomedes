import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProjectState, Session } from '../shared/types.js';
import type { FollowUpCommand, StopReceipt } from '../shared/work-control.js';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import { NativeWorkService } from '../server/native-work.js';
import { Store } from '../server/store.js';
import { WorkControl, CONSENT_REQUIRED, UNCERTAIN_AFTER_STOP } from '../server/work-control.js';

type NativeResult = Awaited<ReturnType<NativeGenerator>>;
function deferred() {
  let resolve!: (result: NativeResult) => void;
  const promise = new Promise<NativeResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const proposal = (
  changes: { path: string; text: string | null; summary: string }[],
  summary = 'Update the selected work',
) => ({ text: JSON.stringify({ summary, changes }), model: 'test-model' });
const update = {
  path: 'Fall menu.md',
  text: '# Fall menu\n\nA revised menu.\n',
  summary: 'Rewrite the menu description',
};
const nothing = proposal([], 'Nothing needed changing');

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
const followUps = async (): Promise<FollowUpCommand[]> => (await state()).followUps ?? [];
const one = async (id: string) => (await followUps()).find((item) => item.id === id)!;
async function until(predicate: (result: ProjectState) => boolean, what = 'the expected state') {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await state();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Work control never reached ${what}.`);
}
const settled = () =>
  until(
    (result) => !result.sessions.some((s) => ['queued', 'working', 'waiting'].includes(s.state)),
    'a settled project',
  );

/** A Start the way `client/work-start.ts` sends one: protocol 1 with its own command. */
const commandedStart = (sources = ['Fall menu.md'], task = taskId) =>
  request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId: task,
    route: 'codex',
    consent: true,
    sources,
  });
/** A Start from a client that predates the Work command protocol: no receipt. */
const legacyStart = (sources = ['Fall menu.md']) =>
  request(`/projects/${projectId}/work/start`, 'POST', {
    taskId,
    route: 'codex',
    consent: true,
    sources,
  });
const approve = async () => {
  const ready = await until((r) => r.needs.some((n) => n.state === 'open'), 'an open proposal');
  const need = ready.needs.find((n) => n.state === 'open')!;
  return request(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    resolution: 'go-ahead',
    allowForTask: false,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  });
};
const queue = (body: Partial<Record<string, unknown>> = {}) =>
  request(`/projects/${projectId}/follow-ups`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    text: 'Also refresh the dessert list.',
    waitsFor: 'task',
    route: 'codex',
    ...body,
  });
const stop = (body: Record<string, unknown>) =>
  request(`/projects/${projectId}/stop`, 'POST', body);

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'work-control-'));
  invoke = async () => proposal([update]);
  generator = vi.fn((input: Parameters<NativeGenerator>[0]) => invoke(input));
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
    nativeGenerator: generator,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await request('/projects/sample', 'POST', {})).data.id;
  taskId = (
    await request(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Prepare the reopening',
      description: 'Update the menu and write an announcement',
    })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
});
afterEach(async () => {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

// 1
test('a follow-up command is queued once however often it is sent', async () => {
  const commandId = crypto.randomUUID();
  const first = await queue({ commandId });
  expect(first.status).toBe(200);
  const again = await queue({ commandId });
  expect(again.status).toBe(200);
  expect(again.data.followUp.id).toBe(first.data.followUp.id);
  expect(await followUps()).toHaveLength(1);
  const separate = await queue({ commandId: crypto.randomUUID() });
  expect(separate.status).toBe(200);
  expect(separate.data.followUp.id).not.toBe(first.data.followUp.id);
  const all = await followUps();
  expect(all).toHaveLength(2);
  expect(all.map((item) => item.order)).toEqual([1, 2]);
  const history = (await state()).history.filter((entry) => entry.kind === 'follow-up');
  expect(history).toHaveLength(2);
  expect(history[0].sentence).toBe(
    'You queued a follow-up for Prepare the reopening, after the task is done.',
  );
});

// 2
test('stopping the generation interrupts the request and leaves everything else standing', async () => {
  const gate = deferred();
  invoke = () => gate.promise;
  const started = await commandedStart();
  expect(started.status).toBe(200);
  const sessionId = (started.data as Session).id;
  const queued = await queue({ waitsFor: 'turn' });
  expect(queued.status).toBe(200);
  const stopped = await stop({ scope: 'generation', taskId, sessionId });
  expect(stopped.status).toBe(200);
  const receipt = stopped.data as StopReceipt;
  expect(receipt.scope).toBe('generation');
  expect(receipt.acknowledged).toBe(true);
  expect(receipt.uncertainEffects).toEqual([UNCERTAIN_AFTER_STOP]);
  expect(receipt.cancelledFollowUpIds).toEqual([]);
  expect(generator.mock.calls[0][0].signal?.aborted).toBe(true);
  const after = await state();
  const session = after.sessions.find((item) => item.id === sessionId)!;
  expect(session.state).toBe('working');
  expect(session.log.some((line) => line.sentence === 'Interrupted the current request.')).toBe(
    true,
  );
  expect((after.followUps ?? []).map((item) => item.state)).toEqual(['queued']);
  expect(after.tasks.find((t) => t.id === taskId)!.stopReceipts).toHaveLength(1);
  gate.resolve(nothing);
});

// 3
test('stopping the task ends the session and cancels only that task queue', async () => {
  const other = (
    await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Order the wine' })
  ).data.id;
  const gate = deferred();
  invoke = () => gate.promise;
  const started = await commandedStart();
  const sessionId = (started.data as Session).id;
  const mine = (await queue({ waitsFor: 'turn' })).data.followUp as FollowUpCommand;
  const theirs = (await queue({ taskId: other, waitsFor: 'task' })).data
    .followUp as FollowUpCommand;
  const stopped = await stop({ scope: 'task', taskId, sessionId });
  expect(stopped.status).toBe(200);
  const receipt = stopped.data as StopReceipt;
  expect(receipt.acknowledged).toBe(true);
  expect(receipt.uncertainEffects).toEqual([UNCERTAIN_AFTER_STOP]);
  expect(receipt.cancelledFollowUpIds).toEqual([mine.id]);
  const after = await state();
  expect(after.sessions.find((item) => item.id === sessionId)!.state).toBe('stopped');
  expect((await one(mine.id)).state).toBe('cancelled');
  expect((await one(mine.id)).cancelledBy).toBe('stop:task');
  expect((await one(theirs.id)).state).toBe('queued');
  gate.resolve(nothing);
});

// 4
test('stopping the queue cancels queued follow-ups and touches no session', async () => {
  await commandedStart();
  await approve();
  await until((r) => r.tasks.find((t) => t.id === taskId)!.state === 'waiting', 'a finished turn');
  const before = await state();
  const mine = (await queue({ waitsFor: 'task' })).data.followUp as FollowUpCommand;
  const stopped = await stop({ scope: 'queued', taskId });
  expect(stopped.status).toBe(200);
  const receipt = stopped.data as StopReceipt;
  expect(receipt.acknowledged).toBe(true);
  expect(receipt.uncertainEffects).toEqual([]);
  expect(receipt.cancelledFollowUpIds).toEqual([mine.id]);
  const after = await state();
  expect((await one(mine.id)).cancelledBy).toBe('stop:queued');
  expect(after.sessions.map((s) => [s.id, s.state])).toEqual(
    before.sessions.map((s) => [s.id, s.state]),
  );
});

// 5
test('a turn follow-up delivers when the turn ends and a task follow-up waits for the task', async () => {
  await commandedStart();
  await approve();
  await until((r) => r.tasks.find((t) => t.id === taskId)!.state === 'waiting', 'a finished turn');
  const later = (await queue({ waitsFor: 'task' })).data.followUp as FollowUpCommand;
  expect((await one(later.id)).state).toBe('queued');
  invoke = async () => nothing;
  const soon = (await queue({ waitsFor: 'turn', text: 'Now tidy the wording.' })).data
    .followUp as FollowUpCommand;
  await until((r) => (r.followUps ?? []).some((f) => f.id === soon.id && f.state === 'delivered'));
  const delivered = await one(soon.id);
  const after = await state();
  const started = after.sessions.find((s) => s.receipt?.commandId === soon.commandId);
  expect(started).toBeDefined();
  expect(delivered.deliveredSessionId).toBe(started!.id);
  expect(
    after.sessions.filter((s) => s.receipt?.commandId === soon.commandId),
  ).toHaveLength(1);
  // That delivery changed no files, so the task is done and the waiting
  // follow-up becomes due on the same trigger.
  await until((r) => (r.followUps ?? []).some((f) => f.id === later.id && f.state === 'delivered'));
  expect((await one(later.id)).deliveredSessionId).toBeTruthy();
});

// 6
test('a follow-up stays queued while the task still has work in progress', async () => {
  const gate = deferred();
  invoke = () => gate.promise;
  await commandedStart();
  const item = (await queue({ waitsFor: 'turn' })).data.followUp as FollowUpCommand;
  expect((await one(item.id)).state).toBe('queued');
  const control = app.locals.workControl as WorkControl;
  const outcome = await app.locals.store.locked(() =>
    control.deliverDue(projectId, { taskId, turnEnded: true, taskDone: false }),
  );
  expect(outcome).toBeNull();
  expect((await one(item.id)).state).toBe('queued');
  expect(generator).toHaveBeenCalledOnce();
  gate.resolve(nothing);
});

// 7
test('a follow-up whose route is gone is rejected in plain words and starts nothing', async () => {
  await commandedStart();
  await approve();
  await until((r) => r.tasks.find((t) => t.id === taskId)!.state === 'waiting', 'a finished turn');
  const item = (await queue({ waitsFor: 'task' })).data.followUp as FollowUpCommand;
  expect((await one(item.id)).state).toBe('queued');
  const admit = vi.fn(async () => {
    throw new Error('Delivery must not admit a Work command for a withdrawn route.');
  });
  const withdrawn = new WorkControl({
    store: app.locals.store,
    native: app.locals.nativeWork,
    admit,
    stopSession: async () => undefined,
    routeAvailable: (route) => route !== 'codex',
  });
  const outcome = await app.locals.store.locked(() =>
    withdrawn.deliverDue(projectId, { taskId, turnEnded: true, taskDone: true }),
  );
  expect(outcome?.state).toBe('rejected');
  expect(outcome?.rejectedReason).toBe(
    'The codex route is no longer available, so this follow-up was not sent.',
  );
  expect(admit).not.toHaveBeenCalled();
  expect((await one(item.id)).state).toBe('rejected');
});

// 8
test('a follow-up on a task whose start recorded no consent is rejected before any send', async () => {
  await legacyStart();
  await approve();
  await until((r) => r.tasks.find((t) => t.id === taskId)!.state === 'waiting', 'a finished turn');
  expect(generator).toHaveBeenCalledOnce();
  const item = (await queue({ waitsFor: 'turn' })).data.followUp as FollowUpCommand;
  await until((r) => (r.followUps ?? []).some((f) => f.id === item.id && f.state !== 'queued'));
  const rejected = await one(item.id);
  expect(rejected.state).toBe('rejected');
  expect(rejected.rejectedReason).toBe(CONSENT_REQUIRED);
  expect(generator).toHaveBeenCalledOnce();
});

// 9
test('a delivered follow-up is immutable and a reorder must name the queue exactly', async () => {
  await commandedStart();
  await approve();
  await until((r) => r.tasks.find((t) => t.id === taskId)!.state === 'waiting', 'a finished turn');
  // The delivered run is held open, so the task never finishes and a second
  // follow-up stays queued for the reorder to name.
  const gate = deferred();
  invoke = () => gate.promise;
  const sent = (await queue({ waitsFor: 'turn' })).data.followUp as FollowUpCommand;
  await until((r) => (r.followUps ?? []).some((f) => f.id === sent.id && f.state === 'delivered'));
  const base = `/projects/${projectId}/follow-ups`;
  expect((await request(`${base}/${sent.id}`, 'PUT', { text: 'Changed my mind.' })).status).toBe(
    400,
  );
  expect((await request(`${base}/${sent.id}`, 'DELETE')).status).toBe(400);
  const still = (await queue({ waitsFor: 'task' })).data.followUp as FollowUpCommand;
  expect(
    (await request(`${base}/reorder`, 'POST', { taskId, order: [still.id, sent.id] })).status,
  ).toBe(400);
  expect((await request(`${base}/reorder`, 'POST', { taskId, order: ['F-missing'] })).status).toBe(
    400,
  );
  const ok = await request(`${base}/reorder`, 'POST', { taskId, order: [still.id] });
  expect(ok.status).toBe(200);
  expect(ok.data.followUps.map((f: FollowUpCommand) => f.order)).toEqual([1]);
  gate.resolve(nothing);
});

// 10
test('the queue survives a restart and an already delivered follow-up is not sent again', async () => {
  await commandedStart();
  await approve();
  await until((r) => r.tasks.find((t) => t.id === taskId)!.state === 'waiting', 'a finished turn');
  invoke = async () => nothing;
  const sent = (await queue({ waitsFor: 'turn' })).data.followUp as FollowUpCommand;
  await until((r) => (r.followUps ?? []).some((f) => f.id === sent.id && f.state === 'delivered'));
  await settled();

  const store = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
  await store.init();
  const reloaded = store.state(projectId).followUps ?? [];
  expect(reloaded.map((item) => [item.id, item.state])).toEqual([[sent.id, 'delivered']]);
  expect(reloaded[0].commandId).toBe(sent.commandId);
  const admit = vi.fn(async () => {
    throw new Error('An already delivered follow-up must never be admitted twice.');
  });
  const fresh = new WorkControl({
    store,
    native: new NativeWorkService(store),
    admit,
    stopSession: async () => undefined,
  });
  const again = await store.locked(() =>
    fresh.deliverDue(projectId, { taskId, turnEnded: true, taskDone: true }),
  );
  expect(again).toBeNull();
  expect(admit).not.toHaveBeenCalled();
  expect(store.state(projectId).followUps!.find((f) => f.id === sent.id)!.state).toBe('delivered');
});
