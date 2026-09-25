/**
 * H13 slice 2 / H14 through the real host (`createApp`, Store, RunService,
 * bridge, Needs, recorded writer): a delegate or worker works in its sandbox
 * and the project is untouched until its change set is settled; an in-scope
 * change applies with the model's attribution; an out-of-scope change becomes
 * an ordinary Need that outlives the run and is kept through its own route;
 * Stop cancels the whole tree, a depth-2 delegate included; and every sandbox
 * of a loop is removed when the loop ends. Stub routes only; no provider.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { LoopModelRoutes } from '../server/harness/capabilities/native-loop.js';
import type { ApprovalCommand, Need, Session } from '../shared/types.js';
import type { HarnessRun, Json } from '../shared/harness.js';
import type { LoopView } from '../shared/native-loop.js';
import type { ChangeSetView } from '../shared/sandbox.js';
import { TEAM_STUB_ACCOUNT_ROUTE, TEAM_STUB_REPORTED, pause, teamRoutes, type Script } from './fixtures/team-loop-stub.js';
import { CRASH_NOTE, localDelegateRoutes } from './fixtures/sandbox-loop-stub.js';

let root: string, projectId: string, taskId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const store = (): Store => app.locals.store;
const host = (): HarnessHost => app.locals.harness;
const state = () => store().state(projectId);
const folder = () => state().project.folder;
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
async function start(overrides: Record<string, unknown> = {}) {
  const response = await request<{ runId: string; session: Session }>('/loop/start', 'POST', {
    protocolVersion: 1,
    commandId: `loop-${Math.random().toString(36).slice(2)}`,
    taskId,
    goal: 'Compare the order with the delivery and write the report.',
    route: 'native-fixture',
    sources: ['order.md', 'delivery.md'],
    ...overrides,
  });
  expect(response.status, JSON.stringify(response.data)).toBe(200);
  return response.data;
}
const approvalOf = (sessionId: string) =>
  state().needs.find((need) => need.sessionId === sessionId && need.state === 'open' && need.harness);
async function approve(sessionId: string) {
  await vi.waitFor(() => expect(approvalOf(sessionId)).toBeTruthy(), { timeout: 15_000 });
  const need = structuredClone(approvalOf(sessionId)!);
  const command: ApprovalCommand = {
    protocolVersion: 1,
    commandId: `decision-${need.id}`,
    resolution: 'go-ahead',
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  };
  const decided = await request<Need>(`/needs/${need.id}/resolve`, 'POST', command);
  expect(decided.status, JSON.stringify(decided.data)).toBe(200);
}
async function untilRun(runId: string, expected: HarnessRun['state']) {
  await vi.waitFor(async () => expect((await host().get(projectId, runId)).state).toBe(expected), { timeout: 15_000 });
  await host().bridge.flush();
  return host().get(projectId, runId);
}
const sandboxDir = () => path.join(root, 'data', 'projects', projectId, 'harness', 'sandboxes');
const sandboxesLeft = async () => (await fs.readdir(sandboxDir()).catch(() => [] as string[])).sort();
const read = (relative: string) => fs.readFile(path.join(folder(), ...relative.split('/')), 'utf8');
async function vertexOn() {
  const shared = await request('/cloud-sharing', 'PUT', {
    expectedVersion: state().cloudSharing?.version ?? 0,
    routes: ['google-vertex'],
    documents: ['order.md', 'delivery.md', 'Notes/delivery.md'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  expect(shared.status, JSON.stringify(shared.data)).toBe(200);
  return store().saveSettings({
    ...store().settings,
    services: { ...(store().settings.services ?? {}), 'google-vertex': true, 'google-vertexAccountRoute': TEAM_STUB_ACCOUNT_ROUTE },
  });
}
const tool = (name: string, input: Json) => ({ response: { type: 'tool' as const, name, input } });
const final = (text: string) => ({ response: { type: 'final' as const, text } });
const outputs = (call: Parameters<Script>[0]) => call.messages.filter((message) => message.role === 'tool');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-sandbox-host-'));
  await open();
  const project = await store().locked(() => store().createProject('Linen orders'));
  projectId = project.id;
  await fs.mkdir(path.join(project.folder, 'Notes'));
  await fs.writeFile(path.join(project.folder, 'Notes', 'delivery.md'), '# Delivery\n');
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

describe('a delegate’s change set, settled into the project', () => {
  test('in scope it applies as the model’s change; out of scope it waits under a Need that outlives the run', async () => {
    await close();
    // The delegate writes a note inside the loop's scope and edits the order outside it.
    await open(
      teamRoutes({
        delegate: (call) => {
          const done = outputs(call).length;
          if (done === 0) return tool('write_file', { path: 'Notes/delivery-check.md', text: '# Delivery check\n\nSix napkins short.\n' });
          if (done === 1) return tool('write_file', { path: 'order.md', text: 'Order 1182: 94 napkins, 40 tablecloths.\n' });
          return final('Wrote the check and corrected the order in my copy.');
        },
      }),
    );
    await vertexOn();
    const started = await start({ delegate: { route: 'google-vertex' }, consent: true, applyScope: ['Notes'] });
    // The loop's own write still asks first; approve it so the loop finishes.
    await approve(started.session.id);
    const run = await untilRun(started.runId, 'completed');
    const childId = `${started.runId}-d1`;
    expect((await host().get(projectId, childId)).capabilityTools).toEqual([
      'list_project_files',
      'read_project_file',
      'write_file',
      'propose_file',
      'delegate',
    ]);

    // In scope: applied through the recorded writer, as the stub model's change, reviewable as a Change.
    expect(await read('Notes/delivery-check.md')).toBe('# Delivery check\n\nSix napkins short.\n');
    const applied = state().history.find((entry) => entry.kind === 'delegate-change')!;
    expect(applied).toMatchObject({ actor: 'diomedes', sessionId: started.session.id, origin: { mode: 'direct', model: { reported: TEAM_STUB_REPORTED } } });
    expect(state().changes.find((change) => change.entryId === applied.id)).toMatchObject({ path: 'Notes/delivery-check.md', state: 'waiting' });

    // Out of scope: the project is untouched, and a Need waits for a person, after the run ended.
    expect(await read('order.md')).toBe(ORDER);
    const need = state().needs.find((item) => item.changeSet)!;
    expect(need).toMatchObject({ state: 'open', sessionId: started.session.id, files: ['order.md'] });
    const { data } = await request<{ view: LoopView; changeSets: ChangeSetView[] }>(`/loop/runs/${run.id}`);
    expect(data.view.delegations[0].result?.changeSet).toMatchObject({ applied: ['Notes/delivery-check.md'], waiting: ['order.md'] });
    const [changeSet] = data.changeSets;
    expect(changeSet.entries.map((entry) => [entry.path, entry.state])).toEqual([
      ['Notes/delivery-check.md', 'applied'],
      ['order.md', 'waiting'],
    ]);
    // What the parent's model was told.
    expect(data.view.turns[1].observation?.excerpt).toContain('waitingForAPerson');

    // P06's readable diff of the waiting entry, then the person keeps it through its route.
    const diff = await request<{ diff: { header: string; hunks: unknown[] } }>(`/change-sets/${changeSet.id}/entries/1/diff`);
    expect(diff.data.diff.header).toMatch(/order\.md/);
    const kept = await request<{ changeSet: ChangeSetView }>(`/change-sets/${changeSet.id}/decide`, 'POST', {
      protocolVersion: 1,
      commandId: 'keep-order',
      decisions: [{ index: 1, decision: 'keep' }],
    });
    expect(kept.status, JSON.stringify(kept.data)).toBe(200);
    expect(await read('order.md')).toBe('Order 1182: 94 napkins, 40 tablecloths.\n');
    expect(state().history.find((entry) => entry.kind === 'delegate-change-kept')).toMatchObject({ actor: 'you' });
    expect(state().needs.find((item) => item.id === need.id)!.state).toBe('go-ahead');
    // The loop has ended, so its sandboxes are gone.
    await vi.waitFor(async () => expect(await sandboxesLeft()).toEqual([]), { timeout: 5_000 });
  });

  test('with no scope given, every change waits; the ordinary Need answer can decline it and nothing is written', async () => {
    const started = await start({ delegate: { route: 'native-fixture' }, goal: 'Check the delivery.' });
    await approve(started.session.id);
    await untilRun(started.runId, 'completed');
    // The fixture delegate only reads, so it returns nothing; its sandbox was still made and removed.
    expect((await request<{ changeSets: ChangeSetView[] }>(`/loop/runs/${started.runId}`)).data.changeSets).toEqual([
      expect.objectContaining({ entries: [] }),
    ]);
    await close();
    await open(teamRoutes({ delegate: (call) => (outputs(call).length ? final('Done.') : tool('write_file', { path: 'Notes/a.md', text: 'a\n' })) }));
    await vertexOn();
    const second = await start({ delegate: { route: 'google-vertex' }, consent: true });
    await approve(second.session.id);
    await untilRun(second.runId, 'completed');
    const need = state().needs.find((item) => item.changeSet)!;
    expect(need.why).toMatch(/not given a scope it may apply changes in/);
    await expect(read('Notes/a.md')).rejects.toThrow();
    const declined = await request<Need>(`/needs/${need.id}/resolve`, 'POST', { resolution: 'declined' });
    expect(declined.status, JSON.stringify(declined.data)).toBe(200);
    expect(declined.data.state).toBe('declined');
    await expect(read('Notes/a.md')).rejects.toThrow();
  });
});

describe('Stop, depth and restart', () => {
  test('a delegate may hand one part on; Stop on the loop cancels the whole tree and removes its sandboxes', async () => {
    await close();
    await open(
      teamRoutes({
        delegate: async (call, { signal }) => {
          const nested = call.tools.some((item) => item.name === 'delegate');
          // Depth 1 hands a part on; depth 2 is never offered `delegate`, and works until stopped.
          if (nested && !outputs(call).length) return tool('delegate', { task: 'Check order.md closely.', files: ['order.md'] });
          if (!nested) {
            if (!outputs(call).length) return tool('write_file', { path: 'order.md', text: 'changed deep down\n' });
            await pause(60_000, signal);
          }
          return final('Done.');
        },
      }),
    );
    await vertexOn();
    const started = await start({ delegate: { route: 'google-vertex' }, consent: true, applyScope: ['.'] });
    const childId = `${started.runId}-d1`;
    let grandId = '';
    await vi.waitFor(
      async () => {
        const nested = (await host().loop.sandboxes.list(projectId)).find((item) => item.depth === 2);
        expect(nested).toBeTruthy();
        grandId = nested!.runId;
        const grand = await host().get(projectId, grandId);
        expect(grand.steps.some((step) => step.intent.name === 'write_file' && step.state === 'succeeded')).toBe(true);
      },
      { timeout: 15_000 },
    );
    const grand = await host().get(projectId, grandId);
    expect(grand.capabilityTools).not.toContain('delegate');
    expect(grand.input).toMatchObject({ depth: 2, rootRunId: started.runId, scope: ['order.md'] });
    expect(grand.budget.units).toBeLessThanOrEqual((await host().get(projectId, childId)).budget.units);
    expect(await sandboxesLeft()).toEqual([childId, grandId].sort());
    const stopped = await request<Session>(`/work/${started.session.id}/stop`, 'POST', {});
    expect(stopped.status, JSON.stringify(stopped.data)).toBe(200);
    await untilRun(started.runId, 'cancelled');
    for (const id of [childId, grandId]) expect(['cancelled', 'reconcile_required']).toContain((await host().get(projectId, id)).state);
    expect((await host().get(projectId, grandId)).state).not.toBe('running');
    // Nothing the stopped tree wrote reached the project, and its sandboxes are gone.
    expect(await read('order.md')).toBe(ORDER);
    await vi.waitFor(async () => expect(await sandboxesLeft()).toEqual([]), { timeout: 5_000 });
  });

  test('an abrupt exit mid-delegate: its sandbox survives with the child’s work, the child resumes in it, and it is removed at the end', async () => {
    await close();
    const output: string[] = [];
    const code = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/delegate-sandbox-host-child.ts', root, projectId, taskId], {
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
    const childId = `${runId}-d1`;
    // The process is gone; the sandbox is not: its manifest, and the file the child wrote.
    const work = path.join(sandboxDir(), childId, 'work', 'Notes', 'check.md');
    expect(await fs.readFile(work, 'utf8')).toBe(CRASH_NOTE);
    expect(JSON.parse(await fs.readFile(path.join(sandboxDir(), childId, 'manifest.json'), 'utf8'))).toMatchObject({ state: 'open', runId: childId });
    await expect(read('Notes/check.md')).rejects.toThrow();
    await open(localDelegateRoutes());
    await vertexOn();
    // The loop resumes on its own, the child finishes in the same copy, and its change applies.
    await approve(state().sessions.find((item) => item.engine.name === 'diomedes-loop')!.id);
    await untilRun(runId, 'completed');
    expect((await host().get(projectId, childId)).state).toBe('completed');
    expect(await read('Notes/check.md')).toBe(CRASH_NOTE);
    // The write the child made before the exit ran once; its copy is gone with the loop.
    expect((await host().get(projectId, childId)).steps.filter((step) => step.intent.name === 'write_file')).toEqual([
      expect.objectContaining({ state: 'succeeded', attempt: 1 }),
    ]);
    await vi.waitFor(async () => expect(await sandboxesLeft()).toEqual([]), { timeout: 5_000 });
  });
});

describe('H14 workers work in sandboxes too', () => {
  test('a worker’s change comes back as a change set and applies inside the lead’s scope', async () => {
    await close();
    await open(
      teamRoutes({
        loop: (call) => {
          if (!call.tools.length) return final('1. Hand delivery.md to a worker.\n2. Finish.');
          const done = outputs(call).length;
          if (done === 0)
            return tool('assign_workers', { tasks: [{ task: 'Write Notes/delivery.md from delivery.md', files: ['delivery.md', 'Notes/delivery.md'] }] });
          return final('A worker wrote the note.');
        },
        worker: (call) => {
          const done = outputs(call).length;
          if (done === 0) return tool('write_file', { path: 'Notes/delivery.md', text: '# Delivery\n\nSix short.\n' });
          return final('Wrote Notes/delivery.md in my copy.');
        },
      }),
    );
    await vertexOn();
    const started = await start({
      route: 'google-vertex',
      consent: true,
      applyScope: ['Notes'],
      team: { scope: ['delivery.md', 'Notes/delivery.md'], worker: {}, advisor: null },
    });
    await untilRun(started.runId, 'completed');
    const { data } = await request<{ team: { workers: { childRunId: string }[] }; changeSets: ChangeSetView[] }>(`/loop/runs/${started.runId}`);
    const worker = await host().get(projectId, data.team.workers[0].childRunId);
    expect(worker.capabilityTools).toEqual(['list_project_files', 'read_project_file', 'write_file', 'propose_file']);
    expect(data.changeSets).toEqual([expect.objectContaining({ role: 'worker', entries: [expect.objectContaining({ path: 'Notes/delivery.md', state: 'applied' })] })]);
    expect(await read('Notes/delivery.md')).toBe('# Delivery\n\nSix short.\n');
    await vi.waitFor(async () => expect(await sandboxesLeft()).toEqual([]), { timeout: 5_000 });
  });
});
