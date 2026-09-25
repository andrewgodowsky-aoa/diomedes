/**
 * Review C (2026-09-24): regressions for the H08 durable-control findings in
 * docs/implementation/2026-09-24-review-c.md (RC-H08-*), on the same harness as
 * tests/h08-durable-controls.test.ts. Each non-positive test failed on the reviewed base.
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

import { AWS_MODEL_CONTRACT } from '../server/harness/aws-model-adapter.js';

const hang: NativeGenerator = ({ signal }) =>
  new Promise<NativeResult>((_resolve, reject) =>
    signal?.addEventListener('abort', () => reject(new Error('Stopped.'))),
  );
const fail: NativeGenerator = async () => {
  throw new Error('The engine went away.');
};
async function failedCodexRun(): Promise<Session> {
  invoke = fail;
  const run = (await codexStart()).data as Session;
  await until((r) => r.sessions.find((s) => s.id === run.id)?.state === 'failed', 'a failed run');
  return run;
}

test('RC-H08-6: stop(task) with nothing running but a queued follow-up does not say a stop was sent', async () => {
  receiptOf(await control({ control: 'queue', text: 'Later.', waitsFor: 'task', route: 'codex' }));
  const stop = receiptOf(await control({ control: 'stop', scope: 'task' }));
  expect(stop.result.stop?.acknowledged).toBe(false);
  expect(stop.outcome).toBe('applied');
  expect(stop.detail).not.toMatch(/stop was sent/);
});

test('RC-H08-5: stop naming a settled run of the task while another run of it is live is not "sent, unconfirmed"', async () => {
  const settled = await failedCodexRun();
  invoke = hang;
  const live = (await codexStart()).data as Session;
  await until(
    (r) => r.sessions.find((s) => s.id === live.id)?.state === 'working',
    'a working run',
  );
  const stop = receiptOf(await control({ control: 'stop', scope: 'task', sessionId: settled.id }));
  // The live run was never touched...
  expect((await state()).sessions.find((s) => s.id === live.id)!.state).toBe('working');
  // ...so the receipt must not claim a stop was sent.
  expect(stop.outcome).not.toBe('uncertain');
  expect(stop.detail).not.toMatch(/stop was sent/);
});

test('RC-H08-1: a generation stop on a route whose interrupt is host is not attributed to the engine', async () => {
  invoke = hang;
  const live = (await codexStart()).data as Session;
  await until(
    (r) => r.sessions.find((s) => s.id === live.id)?.state === 'working',
    'a working run',
  );
  const store = app.locals.store as Store;
  expect(AWS_MODEL_CONTRACT.commands.interrupt.support).toBe('host');
  const controls = new DurableControls({
    store,
    workControl: app.locals.workControl as WorkControl,
    admit: async () => ({ id: 'never' }),
    contractFor: () => AWS_MODEL_CONTRACT,
  });
  const receipt = await store.locked(() =>
    controls.perform(projectId, {
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      taskId,
      control: 'stop',
      scope: 'generation',
      sessionId: live.id,
    }),
  );
  expect(receipt.outcome).toBe('applied');
  expect(receipt.performedBy).toEqual({ kind: 'diomedes' });
  expect(receipt.route.support).toBe('host');
});

test('RC-H08-4: a Work start under "<id>:work" makes a later control <id> claim a retry it never performed', async () => {
  await fixture(true);
  const stopped = await stoppedSampleRun();
  const other = (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Unrelated task' }))
    .data.id as string;
  const commandId = crypto.randomUUID();
  const unrelated = await request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: `${commandId}:work`,
    taskId: other,
    route: 'sample',
  });
  expect(unrelated.status).toBe(200);
  const sessionsBefore = (await state()).sessions.length;
  const res = await control({ commandId, control: 'retry', sessionId: stopped.id });
  const receipt = res.data.receipt as ControlReceipt | undefined;
  const after = await state();
  // Either refused as a conflict, or a real retry of *this* task's run.
  if (res.status === 200 && receipt?.outcome === 'applied') {
    const started = after.sessions.find((s) => s.id === receipt.result.sessionId)!;
    expect(started.taskId).toBe(taskId);
    expect(after.sessions.length).toBe(sessionsBefore + 1);
  } else expect(res.status).toBe(409);
});

test('RC-H08-2: retrying an earlier run is blocked by an uncertain effect of a later retry of it', async () => {
  const original = await failedCodexRun();
  invoke = async () => proposal([update]);
  const first = receiptOf(await control({ control: 'retry', sessionId: original.id }));
  expect(first.outcome).toBe('applied');
  const attempt = first.result.sessionId!;
  const ready = await until(
    (r) => r.needs.some((n) => n.state === 'open' && n.sessionId === attempt),
    'an open proposal',
  );
  const need = ready.needs.find((n) => n.state === 'open' && n.sessionId === attempt)!;
  await request(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    resolution: 'go-ahead',
    allowForTask: false,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  });
  await settledRun(attempt);
  const store = app.locals.store as Store;
  await store.locked(async () => {
    const current = store.state(projectId);
    const saved = current.needs.find((n) => n.id === need.id)!;
    saved.execution = { ...saved.execution!, state: 'conflicted', conflicts: ['Fall menu.md'] };
    current.sessions.find((s) => s.id === attempt)!.state = 'failed';
    await store.persist(current);
  });
  // Retrying the attempt itself is blocked...
  const direct = receiptOf(await control({ control: 'retry', sessionId: attempt }));
  expect(direct.refusal?.code).toBe('uncertain-effects');
  // ...but naming the original instead sends the same request again.
  const calls = generator.mock.calls.length;
  const bypass = receiptOf(await control({ control: 'retry', sessionId: original.id }));
  expect(bypass.refusal?.code).toBe('uncertain-effects');
  expect(generator.mock.calls.length).toBe(calls);
});

test('RC-H08-7: retry attempt numbers are unique within a lineage', async () => {
  const original = await failedCodexRun();
  const a = receiptOf(await control({ control: 'retry', sessionId: original.id }));
  await until((r) => r.sessions.find((s) => s.id === a.result.sessionId)?.state === 'failed', 'a');
  const b = receiptOf(await control({ control: 'retry', sessionId: original.id }));
  expect(b.outcome).toBe('applied');
  expect(a.lineage?.attempt).toBe(2);
  expect(b.lineage?.attempt).not.toBe(a.lineage?.attempt);
});

test('RC-H08-3: a project at the control receipt limit can still Stop a running run', async () => {
  const live = (await sampleStart()).data as Session;
  const seed = receiptOf(await control({ control: 'stop', scope: 'queued' }));
  const store = app.locals.store as Store;
  await store.locked(async () => {
    const current = store.state(projectId);
    current.controlReceipts = Array.from({ length: 2048 }, (_v, i) => ({
      ...seed,
      id: `CR-fill-${i}`,
      commandId: `fill-${i}`,
    }));
    await store.persist(current);
  });
  const stop = await control({ control: 'stop', scope: 'task', sessionId: live.id });
  expect(stop.status).toBe(200);
  expect((await state()).sessions.find((s) => s.id === live.id)!.state).toBe('stopped');
});

test('RC-H08 guard: a crash between the retry start and its receipt replays to exactly one run', async () => {
  await fixture(true);
  const stopped = await stoppedSampleRun();
  const commandId = crypto.randomUUID();
  const retry = receiptOf(await control({ commandId, control: 'retry', sessionId: stopped.id }));
  const store = app.locals.store as Store;
  await store.locked(async () => {
    const current = store.state(projectId);
    current.controlReceipts = current.controlReceipts!.filter((r) => r.commandId !== commandId);
    await store.persist(current);
  });
  await shutdown();
  await boot();
  await fixture(true);
  const count = (await state()).sessions.length;
  const replay = receiptOf(await control({ commandId, control: 'retry', sessionId: stopped.id }));
  expect(replay.outcome).toBe('applied');
  expect(replay.result.sessionId).toBe(retry.result.sessionId);
  expect((await state()).sessions.length).toBe(count);
});

test('RC-H08 guard: two concurrent identical retries perform once', async () => {
  await fixture(true);
  const stopped = await stoppedSampleRun();
  const commandId = crypto.randomUUID();
  const before = (await state()).sessions.length;
  const [x, y] = await Promise.all([
    control({ commandId, control: 'retry', sessionId: stopped.id }),
    control({ commandId, control: 'retry', sessionId: stopped.id }),
  ]);
  expect(receiptOf(x)).toEqual(receiptOf(y));
  expect((await state()).sessions.length).toBe(before + 1);
  expect((await state()).controlReceipts!.filter((r) => r.commandId === commandId)).toHaveLength(1);
});

test("RC-H08 guard: a control naming another task's run is 404 and leaves no receipt", async () => {
  const other = (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Other' })).data
    .id as string;
  const live = (
    await request(`/projects/${projectId}/work/start`, 'POST', {
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      taskId: other,
      route: 'sample',
    })
  ).data as Session;
  const res = await control({ control: 'stop', scope: 'task', sessionId: live.id });
  expect(res.status).toBe(404);
  expect((await state()).sessions.find((s) => s.id === live.id)!.state).not.toBe('stopped');
});

test("RC-H08-8: legacy /stop with a taskId and another task's sessionId", async () => {
  const other = (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Other' })).data
    .id as string;
  const live = (
    await request(`/projects/${projectId}/work/start`, 'POST', {
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      taskId: other,
      route: 'sample',
    })
  ).data as Session;
  const res = await request(`/projects/${projectId}/stop`, 'POST', {
    scope: 'task',
    taskId,
    sessionId: live.id,
  });
  expect(res.status).toBe(404);
  expect((await state()).sessions.find((s) => s.id === live.id)!.state).not.toBe('stopped');
});
