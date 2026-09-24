/**
 * H13 through the real host: `createApp`, the real Store, RunService, bridge,
 * Needs and recorded writer, H17's verifier, and the loop's own routes. The
 * loop runs on the scripted fixture route; a delegate that needs a model-API
 * route uses a stub admission and adapter (`fixtures/native-loop-stub.ts`).
 * Nothing here reaches a provider.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { LoopModelRoutes } from '../server/harness/capabilities/native-loop.js';
import type { ApprovalCommand, Need, Session } from '../shared/types.js';
import type { HarnessRun } from '../shared/harness.js';
import type { LoopOutcome, LoopView } from '../shared/native-loop.js';
import type { VerificationView } from '../shared/verification.js';
import { streamChecks } from '../server/harness/conformance.js';
import { STUB_ACCOUNT_ROUTE, STUB_REPORTED_MODEL, stubRoutes } from './fixtures/native-loop-stub.js';

let root: string, projectId: string, taskId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const store = (): Store => app.locals.store;
const host = (): HarnessHost => app.locals.harness;
const state = () => store().state(projectId);
const ORDER = 'Order 1182: 100 napkins, 40 tablecloths.\n';
const DELIVERY = 'Delivered 94 napkins and 40 tablecloths. Six napkins short.\n';

async function open(routes?: LoopModelRoutes) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
    ...(routes ? { loopModelRoutes: routes } : {}),
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
    await new Promise<void>((resolve, reject) => closingServer.close((error) => (error ? reject(error) : resolve())));
  }
}
async function request<T>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api/projects/${projectId}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const startBody = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  commandId: `loop-${Math.random().toString(36).slice(2)}`,
  taskId,
  goal: 'Compare the order with the delivery and write the report.',
  route: 'native-fixture',
  sources: ['order.md', 'delivery.md'],
  ...overrides,
});
async function start(overrides: Record<string, unknown> = {}) {
  const response = await request<{ runId: string; session: Session; replayed: boolean }>('/loop/start', 'POST', startBody(overrides));
  expect(response.status, JSON.stringify(response.data)).toBe(200);
  return response.data;
}
function command(need: Need): ApprovalCommand {
  return {
    protocolVersion: 1,
    commandId: `decision-${need.id}`,
    resolution: 'go-ahead',
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  };
}
async function openNeed(sessionId: string) {
  await vi.waitFor(() => expect(state().needs.some((need) => need.sessionId === sessionId && need.state === 'open')).toBe(true), {
    timeout: 15_000,
  });
  return structuredClone(state().needs.find((need) => need.sessionId === sessionId && need.state === 'open')!);
}
async function approve(sessionId: string) {
  const need = await openNeed(sessionId);
  const decided = await request<Need>(`/needs/${need.id}/resolve`, 'POST', command(need));
  expect(decided.status, JSON.stringify(decided.data)).toBe(200);
  return need;
}
async function untilRun(runId: string, expected: HarnessRun['state']) {
  await vi.waitFor(async () => expect((await host().get(projectId, runId)).state).toBe(expected), { timeout: 15_000 });
  await host().bridge.flush();
  return host().get(projectId, runId);
}
const loop = (runId: string) =>
  request<{ view: LoopView; outcome: LoopOutcome; verification: VerificationView | null }>(`/loop/runs/${runId}`);
async function declare(checks: unknown[]) {
  const response = await request(`/tasks/${taskId}/acceptance`, 'PUT', { checks });
  expect(response.status, JSON.stringify(response.data)).toBe(200);
}
function shareWithVertex() {
  return request('/cloud-sharing', 'PUT', {
    expectedVersion: 0,
    routes: ['google-vertex'],
    documents: ['order.md', 'delivery.md'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
}
function vertexOn() {
  return store().saveSettings({
    ...store().settings,
    services: { ...(store().settings.services ?? {}), 'google-vertex': true, 'google-vertexAccountRoute': STUB_ACCOUNT_ROUTE },
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-native-loop-host-'));
  await open();
  const project = await store().locked(() => store().createProject('Linen orders'));
  projectId = project.id;
  await fs.writeFile(path.join(project.folder, 'order.md'), ORDER);
  await fs.writeFile(path.join(project.folder, 'delivery.md'), DELIVERY);
  taskId = await store().locked(async () => {
    const task = store().createTask(state(), { name: 'Check the linen delivery' });
    await store().persist(state());
    return task.id;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('a Diomedes loop through the real host', () => {
  test('plan, read, delegate, an approved write and a finish: the finish is Not verified without declared checks', async () => {
    const started = await start({ delegate: { route: 'native-fixture' } });
    expect(started.session.engine.name).toBe('diomedes-loop');
    const need = await approve(started.session.id);
    // The write went through the existing Need: exact files, host-bound expected bytes.
    expect(need.files).toEqual(['Harness report.md']);
    const run = await untilRun(started.runId, 'completed');
    await vi.waitFor(async () => expect((await loop(started.runId)).data.outcome.state).toBe('not-verified'));

    const { data } = await loop(started.runId);
    expect(data.view.plan?.items).toHaveLength(4);
    expect(data.view.turns.map((turn) => [turn.decision, turn.tool])).toEqual([
      ['tool', 'read_project_file'],
      ['delegate', 'delegate'],
      ['tool', 'propose_write'],
      ['finish', null],
    ]);
    expect(data.view.turns[0].observation?.excerpt).toContain('Order 1182');
    expect(data.view.delegations).toHaveLength(1);
    expect(data.view.delegations[0]).toMatchObject({ route: 'native-fixture', childRunId: `${started.runId}-d1`, child: { state: 'completed' } });
    expect(data.view.delegations[0].result?.text).toBe('delivery.md: Delivered 94 napkins and 40 tablecloths. Six napkins short.');
    expect(data.view.finish?.claim).toMatch(/Proposed Harness report.md/);
    expect(data.outcome).toEqual({
      state: 'not-verified',
      label: 'Not verified',
      sentence: 'No acceptance checks are declared for this task, so nothing was verified.',
    });
    // The report holds what the loop and its helper read.
    const report = await fs.readFile(path.join(state().project.folder, 'Harness report.md'), 'utf8');
    expect(report).toContain('Order 1182');
    expect(report).toContain('Six napkins short');

    // Finished is not done: the task waits for review, with no verification on record.
    const task = state().tasks.find((item) => item.id === taskId)!;
    expect(task.state).toBe('waiting');
    expect(task.reason).toBe('changes-ready');
    const session = state().sessions.find((item) => item.id === started.session.id)!;
    expect(session.state).toBe('done');
    // Diomedes supervised; a scripted route names no model.
    expect(session.origin).toMatchObject({ mode: 'supervisor', executorId: 'diomedes:native-loop', model: { reported: null } });
    expect(streamChecks(run).filter((check) => check.outcome === 'failed')).toEqual([]);
    const child = await host().get(projectId, `${started.runId}-d1`);
    expect(child.sessionId).toBeNull();
    expect(child.budget).toEqual({ units: 8, modelCalls: 4, toolCalls: 4, wallMs: null });
    expect(child.input).toMatchObject({ kind: 'diomedes-loop-delegate', parent: { runId: started.runId, stepId: 'delegate:1', handoffId: `${started.runId}-h1` } });
  });

  test('declared checks run at the finish: Verified moves the task to done, and the record says Diomedes asked', async () => {
    await declare([
      { id: 'report', kind: 'file-exists', path: 'Harness report.md' },
      { id: 'short', kind: 'text-contains', path: 'Harness report.md', text: 'Order 1182' },
    ]);
    const started = await start();
    await approve(started.session.id);
    await untilRun(started.runId, 'completed');
    await vi.waitFor(async () => expect((await loop(started.runId)).data.outcome.state).toBe('verified'), { timeout: 15_000 });
    const { data } = await loop(started.runId);
    expect(data.outcome.label).toBe('Verified');
    expect(data.verification?.record?.requestedBy).toBe('diomedes-loop');
    const entry = state().history.find((item) => item.kind === 'verified')!;
    expect(entry.actor).toBe('diomedes');
    expect(entry.sentence).toMatch(/Diomedes ran your checks/);
    await vi.waitFor(() => expect(state().tasks.find((item) => item.id === taskId)!.state).toBe('done'));
    expect(state().tasks.find((item) => item.id === taskId)!.moves.at(-1)).toMatchObject({ by: 'diomedes', to: 'done' });
  });

  test('a declared check that fails: Failed verification with its evidence, and the task is not done', async () => {
    await declare([{ id: 'missing', kind: 'text-contains', path: 'Harness report.md', text: 'All napkins delivered' }]);
    const started = await start();
    await approve(started.session.id);
    await untilRun(started.runId, 'completed');
    await vi.waitFor(async () => expect((await loop(started.runId)).data.outcome.state).toBe('failed-verification'), { timeout: 15_000 });
    const { data } = await loop(started.runId);
    expect(data.outcome.label).toBe('Failed verification');
    expect(data.outcome.sentence).toMatch(/1 check failed/);
    expect(data.verification?.checks.find((check) => check.id === 'missing')?.outcome).toBe('failed');
    expect(state().tasks.find((item) => item.id === taskId)!.state).toBe('waiting');
  });

  test('a replayed command starts nothing new; the same id with another goal is refused', async () => {
    const body = startBody({ commandId: 'same-command' });
    const first = await request<{ runId: string; session: Session }>('/loop/start', 'POST', body);
    const again = await request<{ runId: string; replayed: boolean }>('/loop/start', 'POST', body);
    expect(again.data).toMatchObject({ runId: first.data.runId, replayed: true });
    const other = await request<{ code?: string }>('/loop/start', 'POST', { ...body, goal: 'Something else.' });
    expect(other.status).toBe(409);
    expect(state().sessions.filter((session) => session.engine.name === 'diomedes-loop')).toHaveLength(1);
  });

  test('refusals: an external engine keeps its own loop; a route that is off or unconsented sends nothing', async () => {
    const codex = await request<{ error: string; code?: string }>('/loop/start', 'POST', startBody({ route: 'codex' }));
    expect(codex.status).toBe(400);
    const off = await request<{ error: string }>('/loop/start', 'POST', startBody({ route: 'google-vertex' }));
    expect(off.status).toBe(409);
    expect(off.data.error).toMatch(/Turn the selected route on/);
    await vertexOn();
    const unconsented = await request<{ consentRequired?: boolean }>('/loop/start', 'POST', startBody({ route: 'google-vertex' }));
    expect(unconsented.status).toBe(409);
    expect(unconsented.data.consentRequired).toBe(true);
    const unshared = await request<{ code?: string }>('/loop/start', 'POST', startBody({ route: 'google-vertex', consent: true }));
    expect(unshared.status, JSON.stringify(unshared.data)).toBe(403);
    expect(state().sessions).toHaveLength(0);
  });
});

describe('stop and restart', () => {
  test('Stop on the loop stops the delegate it is waiting for, through the ordinary Stop control', async () => {
    await close();
    const calls: string[] = [];
    await open(stubRoutes('hang', calls));
    await vertexOn();
    expect((await shareWithVertex()).status).toBe(200);
    const started = await start({ delegate: { route: 'google-vertex' }, consent: true });
    const childId = `${started.runId}-d1`;
    await vi.waitFor(async () => expect((await host().get(projectId, childId)).steps.some((step) => step.intent.stepId === 'model:0' && step.state === 'running')).toBe(true), { timeout: 15_000 });
    const stopped = await request<Session>(`/work/${started.session.id}/stop`, 'POST', {});
    expect(stopped.status, JSON.stringify(stopped.data)).toBe(200);
    const child = await untilRun(childId, 'cancelled');
    expect(child.cancelReason).toBe('the loop that handed it this sub-task was stopped');
    // The in-flight external call is never relabelled as cancelled: it is parked as unknown.
    expect(child.steps.find((step) => step.intent.stepId === 'model:0')?.state).toBe('reconcile_required');
    const parent = await untilRun(started.runId, 'cancelled');
    const { data } = await loop(parent.id);
    expect(data.outcome.state).toBe('stopped');
    expect(data.view.delegations[0].child?.state).toBe('cancelled');
    expect(state().sessions.find((item) => item.id === started.session.id)?.state).toBe('stopped');
    expect(calls).toEqual([`delegate:${childId}`]);
  });

  test('restart while waiting for approval: the reopened host resumes the loop from its record', async () => {
    const started = await start({ delegate: { route: 'native-fixture' } });
    const need = await openNeed(started.session.id);
    const before = await host().get(projectId, started.runId);
    await close();
    await open();
    const decided = await request<Need>(`/needs/${need.id}/resolve`, 'POST', command(need));
    expect(decided.status, JSON.stringify(decided.data)).toBe(200);
    const run = await untilRun(started.runId, 'completed');
    // Every step recorded before the restart ran exactly once.
    for (const step of before.steps.filter((item) => item.state === 'succeeded'))
      expect(run.steps.find((item) => item.intent.stepId === step.intent.stepId)).toMatchObject({ attempt: 1, outputHash: step.outputHash });
    expect(streamChecks(run).filter((check) => check.outcome === 'failed')).toEqual([]);
  });

  test('an abrupt exit while a delegate is mid-call: the parent resumes, and the unknown call is never resent', async () => {
    await close();
    const output: string[] = [];
    const code = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/native-loop-host-child.ts', root, projectId, taskId], {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => output.push(String(chunk)));
      child.stderr.on('data', (chunk) => output.push(String(chunk)));
      child.on('error', reject);
      child.on('close', done);
    });
    expect(code, output.join('')).toBe(17);
    const runId = (await fs.readFile(path.join(root, 'crash-run.txt'), 'utf8')).trim();
    const calls: string[] = [];
    await open(stubRoutes('answer', calls));
    await vertexOn();
    // The loop resumed on its own; it waits for the person's OK on the write.
    await approve(state().sessions.find((item) => item.engine.name === 'diomedes-loop')!.id);
    const run = await untilRun(runId, 'completed');
    const child = await host().get(projectId, `${runId}-d1`);
    // The delegate's model call was in flight to an external route: parked, never sent again.
    expect(child.state).toBe('reconcile_required');
    expect(calls).toEqual([]);
    const delegate = run.steps.find((step) => step.intent.stepId === 'delegate:1')!;
    expect(delegate.attempt).toBe(2);
    const { data } = await loop(runId);
    expect(data.view.turns[1].observation).toMatchObject({ action: 'delegate', ok: false });
    expect(data.view.turns[1].observation?.detail).toMatch(/reconcile_required/);
    expect(data.outcome.state).toBe('not-verified');
    expect(STUB_REPORTED_MODEL).toBeTruthy();
  });
});
