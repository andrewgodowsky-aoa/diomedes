/**
 * H15 decision 5 (Andrew, 2026-09-24): a correction Diomedes supervision queued
 * may start the next run on a route that cannot steer, without a person. It
 * shares the origin run's correction bound (tests/h15-ladder.test.ts), runs
 * through ordinary admission with a permission never wider than the origin
 * run's, is labelled as a supervision correction in History and in the text
 * the thread shows, and a pause or any Stop cancels it.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProjectState, Session } from '../shared/types.js';
import type { FollowUpCommand, StopReceipt } from '../shared/work-control.js';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import { WorkControl } from '../server/work-control.js';

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
  // Default-deny cloud sharing: grant the codex route and the sample source
  // this suite starts from (sources ['Fall menu.md']).
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
  // Held before the first await: a hook that outlives its timeout keeps running,
  // and by then these bindings belong to the next test.
  const closingApp = app, closingServer = server;
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
});


let threadId: string;
/** Start the task's run in its thread, the way the Console does. */
const threadStart = () =>
  request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    route: 'codex',
    consent: true,
    sources: ['Fall menu.md'],
    threadId,
  });
const control = () => app.locals.workControl as WorkControl;
/** Queue a correction exactly as supervision does: H08 Queue, in supervision's name. */
const correction = (text = '[Diomedes supervision] Stay inside the menu folder. Keep to the task.') =>
  app.locals.store.locked(() =>
    control().queue(
      projectId,
      { protocolVersion: 1, commandId: `sup.${crypto.randomUUID()}`, taskId, text, waitsFor: 'turn', route: 'codex', model: null, agentId: null, sources: ['Fall menu.md'] },
      'diomedes-supervision',
    ),
  );

beforeEach(async () => {
  threadId = (await request(`/projects/${projectId}/threads`, 'POST', { attachedTo: { kind: 'task', ref: taskId } })).data.id;
});

test('a supervision correction starts the next run without a person, labelled as supervision’s', async () => {
  const gate = deferred();
  invoke = () => gate.promise;
  const origin = (await threadStart()).data as Session;
  const queued = await correction();
  expect(queued).toMatchObject({ state: 'queued', queuedBy: 'diomedes-supervision', queuedDuringSessionId: origin.id });
  // The origin run proposes a change and the person approves it; its turn then ends.
  gate.resolve(proposal([update]));
  invoke = async () => nothing;
  await approve();
  const delivered = await until(
    (r) => (r.followUps ?? []).some((f) => f.id === queued.id && f.state === 'delivered'),
    'the correction delivered',
  );
  const next = delivered.sessions.find((s) => s.id === delivered.followUps!.find((f) => f.id === queued.id)!.deliveredSessionId)!;
  // Labelled where a person reads it: the run's own instruction and History.
  expect(next.inputs?.instruction).toMatch(/^\[Diomedes supervision\]/);
  expect(delivered.history.some((h) => h.actor === 'diomedes' && h.sentence === 'Diomedes sent its supervision correction for Prepare the reopening.')).toBe(true);
  expect(delivered.history.some((h) => h.sentence.startsWith('Diomedes supervision queued a correction'))).toBe(true);
});

test('its permission is never wider than the origin run’s, even if the thread was widened since', async () => {
  const gate = deferred();
  invoke = () => gate.promise;
  const origin = (await threadStart()).data as Session;
  expect(origin.permission).toBe('show-first');
  const queued = await correction();
  // The person widens the thread while the origin run works; a person's own follow-up may use it.
  expect((await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { permission: 'task' })).status).toBe(200);
  // The origin run proposes a change and the person approves it; its turn then ends.
  gate.resolve(proposal([update]));
  invoke = async () => nothing;
  await approve();
  const delivered = await until(
    (r) => (r.followUps ?? []).some((f) => f.id === queued.id && f.state === 'delivered'),
    'the correction delivered',
  );
  const next = delivered.sessions.find((s) => s.id === delivered.followUps!.find((f) => f.id === queued.id)!.deliveredSessionId)!;
  expect(next.permission).toBe('show-first');
  // The thread itself is wider now; only the correction was held to its origin's permission.
  expect((await state()).conversations.find((c) => c.id === threadId)!.permission).toBe('task');
});

test('a Stop of the generation cancels a queued correction, and leaves the person’s own follow-up', async () => {
  const gate = deferred();
  invoke = () => gate.promise;
  const origin = (await threadStart()).data as Session;
  const queued = await correction();
  const mine = (await queue({ waitsFor: 'turn', text: 'My own follow-up.' })).data.followUp as FollowUpCommand;
  const stopped = await stop({ scope: 'generation', taskId, sessionId: origin.id });
  gate.resolve(nothing);
  expect(stopped.status).toBe(200);
  expect((stopped.data as StopReceipt).cancelledFollowUpIds).toEqual([queued.id]);
  expect(await one(queued.id)).toMatchObject({ state: 'cancelled', cancelledBy: 'stop:generation' });
  expect(['queued', 'delivered', 'rejected']).toContain((await one(mine.id)).state);
  expect((await one(mine.id)).cancelledBy).toBeUndefined();
});

test('a supervision pause cancels a queued correction, and nothing starts', async () => {
  const gate = deferred();
  invoke = () => gate.promise;
  const origin = (await threadStart()).data as Session;
  const queued = await correction();
  await app.locals.store.locked(() => control().stop(projectId, { scope: 'task', taskId, sessionId: origin.id }, 'supervision'));
  expect(await one(queued.id)).toMatchObject({ state: 'cancelled', cancelledBy: 'stop:task' });
  gate.resolve(nothing);
  await settled();
  expect((await state()).sessions.filter((s) => s.taskId === taskId)).toHaveLength(1);
});
