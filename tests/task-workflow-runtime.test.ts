/**
 * Bounded task workflow at runtime: the real app, the real Store, RunService,
 * bridge, Needs and recorded writer, with the loop on the scripted
 * native-fixture route. No model transport is stubbed here and no provider is
 * reached: /work on the versioned sample route with a workflow task chooses
 * the fixture loop, and every approval goes through the exact Need digests.
 *
 * Covers: stop on phase change parks before build with the pending marker
 * persisted first and no build output yet; a duplicate Work command replays
 * the same session while paused; a wrong approval digest is refused; the
 * exact resolve resumes the same run without granting file permission (the
 * propose_write Need still asks); the review gate finishes the run with
 * applied executions and consistent task-handoff history; restarts over the
 * same data preserve identity with no duplicate plan/model calls; full
 * approval skips phase Needs but still asks for the file write within the
 * turn budget; Stop leaves nothing queued behind it.
 *
 * Heavy suites (build, Playwright, browser, live calls) are NOT run here:
 * another lane holds the shared heavy slot. Run with
 * `npx vitest run tests/task-workflow-runtime.test.ts` once the slot is granted.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { loopRunId } from '../server/native-loop-routes.js';
import { TASK_PHASE_INTENT_NAME } from '../server/task-phase.js';
import type { Store } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { HarnessRun } from '../shared/harness.js';
import type { LoopRunInput } from '../shared/native-loop.js';
import type { ApprovalCommand, Need, Session, Task } from '../shared/types.js';

let root: string;
let projectId: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let url: string;

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const store = (): Store => app.locals.store;
const host = (): HarnessHost => app.locals.harness;
const state = () => store().state(projectId);

async function open() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
    stepMs: 20,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close() {
  if (!server) return;
  const closingApp = app;
  const closingServer = server;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function request<T>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

const makeTask = async (name: string): Promise<Task> =>
  (await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name })).data;

async function setWorkflow(taskId: string, continuation: 'full-approval' | 'stop-on-phase-change', maxTurns: number) {
  const updated = await request<Task>(`/projects/${projectId}/tasks/${taskId}/workflow`, 'PUT', {
    expectedRevision: 1,
    continuation,
    maxTurns,
  });
  expect(updated.status, JSON.stringify(updated.data)).toBe(200);
  return updated.data;
}

const workBody = (commandId: string, taskId: string, instruction: string) => ({
  protocolVersion: 1,
  commandId,
  taskId,
  route: 'sample',
  instruction,
});

async function workStart(commandId: string, taskId: string, instruction: string) {
  const response = await request<Session>(`/projects/${projectId}/work/start`, 'POST', workBody(commandId, taskId, instruction));
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

async function openNeed(sessionId: string, name?: string) {
  await vi.waitFor(
    () =>
      expect(
        state().needs.some(
          (need) =>
            need.sessionId === sessionId &&
            need.state === 'open' &&
            (name === undefined || need.harness?.intent.name === name),
        ),
      ).toBe(true),
    { timeout: 20_000 },
  );
  return structuredClone(
    state().needs.find(
      (need) =>
        need.sessionId === sessionId &&
        need.state === 'open' &&
        (name === undefined || need.harness?.intent.name === name),
    )!,
  );
}

async function approve(sessionId: string, name?: string) {
  const need = await openNeed(sessionId, name);
  const decided = await request<Need>(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', command(need));
  expect(decided.status, JSON.stringify(decided.data)).toBe(200);
  return need;
}

async function untilRun(runId: string, expected: HarnessRun['state']) {
  await vi.waitFor(async () => expect((await host().get(projectId, runId)).state).toBe(expected), {
    timeout: 20_000,
  });
  await host().bridge.flush();
  return host().get(projectId, runId);
}

const historyKinds = (taskId: string, kind: string) =>
  state().history.filter(
    (entry) => (entry as { kind?: string }).kind === kind && (entry as { taskId?: string }).taskId === taskId,
  );

const phaseNeeds = (runId: string) =>
  state().needs.filter((need) => need.harness?.runId === runId && need.harness.intent.name === TASK_PHASE_INTENT_NAME);

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-task-workflow-runtime-')));
  await open();
  projectId = (await request<{ id: string }>('/projects', 'POST', { name: 'Workflow runtime' })).data.id;
  await fs.writeFile(path.join(state().project.folder, 'README.md'), '# Linen orders\nCount what arrived.\n');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('task workflow on the real loop runtime', () => {
  test('a task playbook reaches Work with its pinned version and digest', async () => {
    const task = await makeTask('Cash flow work');
    expect((await request(`/projects/${projectId}/packs/diomedes.small-business/activate`, 'POST', {})).status).toBe(200);
    const configured = await request(`/projects/${projectId}/tasks/${task.id}/workflow`, 'PUT', {
      expectedRevision: 1, continuation: 'full-approval', maxTurns: 5,
      skill: { packId: 'diomedes.small-business', skillId: 'cash-flow-snapshot' },
    });
    expect(configured.status, JSON.stringify(configured.data)).toBe(200);
    const commandId = 'work-playbook';
    const session = await workStart(commandId, task.id, 'Prepare a cash flow snapshot from the available figures.');
    await openNeed(session.id, 'propose_write');
    const run = await host().get(projectId, loopRunId(projectId, commandId));
    const input = run.input as unknown as LoopRunInput;
    expect(input.instructions).toContain('--- BEGIN PLAYBOOK cash-flow-snapshot ---');
    expect(input.instructions).toContain('Four rules hold');
    expect(input.skill).toMatchObject({ packId: 'diomedes.small-business', skillId: 'cash-flow-snapshot' });
    expect(input.skill?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(input.skill?.bytes).toBeGreaterThan(0);
    // Guidance does not approve the output: the file remains unwritten.
    await expect(fs.readFile(path.join(state().project.folder, 'Harness report.md'))).rejects.toThrow();
  });
  test('stop on phase change parks before build, replays the duplicate command, and resumes on the exact approval only', async () => {
    const task = await makeTask('Parked build work');
    await setWorkflow(task.id, 'stop-on-phase-change', 8);
    const commandId = `work-parked-${Math.random().toString(36).slice(2)}`;
    const session = await workStart(commandId, task.id, 'Compare the quotes and write the note.');
    expect(session.engine.name).toBe('diomedes-loop');
    const runId = loopRunId(projectId, commandId);

    // The build gate parks first: pending marker persisted, one ask, no build output yet.
    const buildNeed = await openNeed(session.id, TASK_PHASE_INTENT_NAME);
    expect(buildNeed.harness?.intent.input).toMatchObject({ projectId, runId, taskId: task.id, phase: 'build' });
    expect(buildNeed.files).toEqual([]);
    expect(buildNeed.what).toBe('Continue this task to Build?');
    const parked = state().tasks.find((item) => item.id === task.id)!;
    expect(parked.workflow).toMatchObject({ phase: 'plan', pendingPhase: 'build', revision: 3 });
    expect(historyKinds(task.id, 'task-handoff-asked')).toHaveLength(1);
    const waiting = await host().get(projectId, runId);
    expect(waiting.state).toBe('waiting');
    expect(waiting.steps.some((step) => step.intent.name === 'propose_write')).toBe(false);

    // A duplicate Work command while paused replays the same session: nothing new starts.
    const replayed = await request<Session>(
      `/projects/${projectId}/work/start`,
      'POST',
      workBody(commandId, task.id, 'Compare the quotes and write the note.'),
    );
    expect(replayed.status).toBe(200);
    expect(replayed.data.id).toBe(session.id);
    expect(state().sessions.filter((item) => item.taskId === task.id)).toHaveLength(1);

    // A wrong approval digest is refused and the run keeps waiting.
    const tampered = { ...command(buildNeed), proposalDigest: '0'.repeat(64) };
    const refused = await request(`/projects/${projectId}/needs/${buildNeed.id}/resolve`, 'POST', tampered);
    expect([400, 409]).toContain(refused.status);
    expect(state().needs.find((need) => need.id === buildNeed.id)!.state).toBe('open');
    expect((await host().get(projectId, runId)).state).toBe('waiting');

    // The exact approval resumes the same run and advances once, with an applied execution.
    const decided = await request<Need>(`/projects/${projectId}/needs/${buildNeed.id}/resolve`, 'POST', command(buildNeed));
    expect(decided.status, JSON.stringify(decided.data)).toBe(200);
    await vi.waitFor(() => expect(state().tasks.find((item) => item.id === task.id)!.workflow?.phase).toBe('build'));
    const resumed = await host().get(projectId, runId);
    expect(resumed.id).toBe(runId);
    expect(resumed.steps.filter((step) => step.intent.stepId === 'task-phase:build')).toHaveLength(1);
    const advanced = state().tasks.find((item) => item.id === task.id)!;
    expect(advanced.workflow).toMatchObject({ phase: 'build', pendingPhase: null });
    expect(advanced.workflow!.handoffs).toHaveLength(1);
    expect(advanced.workflow!.handoffs[0]).toMatchObject({ from: 'plan', to: 'build' });
    const moved = historyKinds(task.id, 'task-handoff');
    expect(moved).toHaveLength(1);
    const settledNeed = state().needs.find((need) => need.id === buildNeed.id)!;
    expect(settledNeed.execution?.state).toBe('applied');
    expect(settledNeed.execution?.eventId).toBe((moved[0] as { id: string }).id);

    // Continuing the task grants no file permission: the report still asks.
    const writeNeed = await openNeed(session.id, 'propose_write');
    expect(writeNeed.files).toEqual(['Harness report.md']);
  });

  test('the review gate finishes the run with consistent executions and history, across a restart', async () => {
    const task = await makeTask('Reviewed work');
    await setWorkflow(task.id, 'stop-on-phase-change', 8);
    const commandId = `work-review-${Math.random().toString(36).slice(2)}`;
    const session = await workStart(commandId, task.id, 'Compare the quotes and write the note.');
    const runId = loopRunId(projectId, commandId);

    await approve(session.id, TASK_PHASE_INTENT_NAME);
    await approve(session.id, 'propose_write');
    const reviewNeed = await openNeed(session.id, TASK_PHASE_INTENT_NAME);
    expect(reviewNeed.harness?.intent.input).toMatchObject({ phase: 'review' });
    const before = await host().get(projectId, runId);
    const modelCalls = before.steps.filter((step) => step.intent.kind === 'model');

    // Restart over the same data while waiting: identity holds, records replay, nothing new is called.
    await close();
    await open();
    const reopened = await host().get(projectId, runId);
    expect(reopened.sessionId).toBe(session.id);
    expect(reopened.taskId).toBe(task.id);
    for (const step of before.steps.filter((item) => item.state === 'succeeded'))
      expect(reopened.steps.find((item) => item.intent.stepId === step.intent.stepId)).toMatchObject({
        attempt: step.attempt,
        outputHash: step.outputHash,
      });

    const decided = await request<Need>(
      `/projects/${projectId}/needs/${reviewNeed.id}/resolve`,
      'POST',
      command(reviewNeed),
    );
    expect(decided.status, JSON.stringify(decided.data)).toBe(200);
    const run = await untilRun(runId, 'completed');

    const finished = state().tasks.find((item) => item.id === task.id)!;
    expect(finished.workflow).toMatchObject({ phase: 'review', pendingPhase: null });
    expect(finished.workflow!.handoffs.map((entry) => entry.to)).toEqual(['build', 'review']);
    const moved = historyKinds(task.id, 'task-handoff');
    expect(moved).toHaveLength(2);
    for (const need of phaseNeeds(runId)) {
      expect(need.state).not.toBe('open');
      const entry = moved.find((item) => (item as { id: string }).id === need.execution?.eventId);
      expect(entry, `need ${need.id} names its own history entry`).toBeTruthy();
    }
    // No duplicate plan or model calls across the restart: the same steps ran once.
    const after = await host().get(projectId, run.id);
    expect(after.steps.filter((step) => step.intent.kind === 'model')).toHaveLength(modelCalls.length);
    expect(after.steps.filter((step) => step.intent.stepId === 'plan')).toHaveLength(1);

    // Restart after settlement validates the same state: still completed, same task and session.
    await close();
    await open();
    const settled = await host().get(projectId, runId);
    expect(settled.state).toBe('completed');
    expect(state().tasks.find((item) => item.id === task.id)!.workflow?.phase).toBe('review');
    expect(state().sessions.find((item) => item.id === session.id)).toBeTruthy();
  });

  test('full approval skips phase needs but still asks for the file write within the turn budget', async () => {
    const task = await makeTask('Full approval work');
    await setWorkflow(task.id, 'full-approval', 5);
    const commandId = `work-full-${Math.random().toString(36).slice(2)}`;
    const session = await workStart(commandId, task.id, 'Compare the quotes and write the note.');
    const runId = loopRunId(projectId, commandId);

    const run = await host().get(projectId, runId);
    expect((run.input as unknown as LoopRunInput).maxTurns).toBe(5);
    expect(run.budget.modelCalls).toBe(6);

    await approve(session.id, 'propose_write');
    await untilRun(runId, 'completed');

    // Both phases advanced with no phase Need ever opening; the writes still asked.
    expect(phaseNeeds(runId)).toHaveLength(0);
    const finished = state().tasks.find((item) => item.id === task.id)!;
    expect(finished.workflow).toMatchObject({ phase: 'review', pendingPhase: null });
    expect(finished.workflow!.handoffs.map((entry) => entry.to)).toEqual(['build', 'review']);
    expect(historyKinds(task.id, 'task-handoff-asked')).toHaveLength(0);
    expect(historyKinds(task.id, 'task-handoff')).toHaveLength(2);
  });

  test('Stop at the phase gate leaves nothing queued behind it', async () => {
    const task = await makeTask('Stopped work');
    await setWorkflow(task.id, 'stop-on-phase-change', 8);
    const commandId = `work-stop-${Math.random().toString(36).slice(2)}`;
    const session = await workStart(commandId, task.id, 'Compare the quotes and write the note.');
    const runId = loopRunId(projectId, commandId);
    await openNeed(session.id, TASK_PHASE_INTENT_NAME);
    const sessionsBefore = state().sessions.length;

    const stopped = await request<Session>(`/projects/${projectId}/work/${session.id}/stop`, 'POST', {});
    expect(stopped.status, JSON.stringify(stopped.data)).toBe(200);
    expect(stopped.data.state).toBe('stopped');
    await host().bridge.flush();
    expect(state().sessions).toHaveLength(sessionsBefore);
    expect((await host().get(projectId, runId)).state).not.toBe('waiting');

    // Stopping does not approve the pending phase. A new command stays refused
    // until the person explicitly approves it with no active run.
    const refused = await request(`/projects/${projectId}/work/start`, 'POST',
      workBody(`work-still-gated-${Math.random().toString(36).slice(2)}`, task.id, 'Try again.'));
    expect(refused.status).toBe(409);
    expect(state().sessions).toHaveLength(sessionsBefore);
    const workflow = state().tasks.find((item) => item.id === task.id)!.workflow!;
    const approved = await request(`/projects/${projectId}/tasks/${task.id}/approve-phase`, 'POST', {
      expectedRevision: workflow.revision,
    });
    expect(approved.status, JSON.stringify(approved.data)).toBe(200);
    // A fresh command now starts exactly one new session.
    const next = await workStart(`work-after-stop-${Math.random().toString(36).slice(2)}`, task.id, 'Try again.');
    expect(next.id).not.toBe(session.id);
    expect(state().sessions).toHaveLength(sessionsBefore + 1);
  });
});
