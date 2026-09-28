/**
 * Bounded task phase approval lane (server/task-phase.ts): enforcement through
 * the real Store and the real RunService — no stubs for the gate itself.
 *
 * Covers: stop mode parks before any build model step with the pending marker
 * persisted first; stale/foreign approvals are refused; the exact approval
 * resumes the SAME run and advances once; full approval passes both phases
 * with no suspension; replay is idempotent (no duplicate history/revisions);
 * the phase intent cannot be disguised as a write or moved to another
 * project; no remembered grant can ever cover it; and the Need wording names
 * the continuation without claiming it only reads.
 *
 * Heavy suites (build, Playwright, browser, live calls) are NOT run here:
 * another lane holds the shared heavy slot. Run with `npx vitest run
 * tests/task-phase.test.ts` once the slot is granted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../server/store.js';
import { RunService, Suspended } from '../server/harness/run-service.js';
import { FileRunStore } from '../server/harness/run-store.js';
import {
  TASK_PHASE_INTENT_NAME,
  createTaskPhaseGate,
  isTaskPhaseIntent,
  taskPhaseInputSchema,
  taskPhaseStepId,
} from '../server/task-phase.js';
import {
  harnessWrites,
  identifyHarnessApproval,
} from '../server/harness/approval.js';
import { needFromWaitingStep } from '../server/harness/present.js';
import { patternForStep } from '../server/trust/remembered-approvals.js';
import { digest } from '../server/harness/policy.js';
import type {
  CapabilityManifest,
  HarnessPrincipal,
  HarnessRun,
} from '../shared/harness.js';
import type { Need, TaskContinuation } from '../shared/types.js';

const CAPABILITY: CapabilityManifest = {
  id: 'task-phase-test-loop',
  version: 'v1',
  label: 'Phase test loop',
  description: 'A minimal capability for gating phase transitions.',
  tools: [],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 8,
  supportedPlatforms: ['linux'],
};

let root: string;
let store: Store;
let runs: RunService;
let projectId: string;

async function launch() {
  root = await fs.mkdtemp(path.join('test-results', 'task-phase-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  runs = new RunService(new FileRunStore(path.join(root, 'runs')));
  projectId = await store.locked(async () => {
    const created = await store.createProject('Phase lane board');
    return created.id;
  });
}

async function close() {
  if (root) await fs.rm(root, { recursive: true, force: true });
}

const principalFor = (): HarnessPrincipal => ({
  id: 'local-client',
  tenantId: 'local',
  projectId,
  capabilities: ['write-project-file'],
  identityGeneration: 1,
});

/** A task with an explicit workflow at plan, plus a claimed run bound to it. */
async function openTaskRun(continuation: TaskContinuation) {
  const taskId: string = await store.locked(async () => {
    const state = store.state(projectId);
    const task = store.createTask(state, { name: 'Gated work', owner: 'you' });
    task.workflow = {
      revision: 1,
      phase: 'plan',
      continuation,
      inbox: false,
      parentTaskId: null,
      output: null,
      maxTurns: 8,
      pendingPhase: null,
      pendingReason: null,
      handoffs: [],
    };
    await store.persist(state);
    return task.id;
  });
  const principal = principalFor();
  const started = await runs.start({
    tenantId: 'local',
    projectId,
    taskId,
    sessionId: 'S1',
    principal,
    capability: CAPABILITY,
    budget: { units: 50, modelCalls: 20, toolCalls: 20, wallMs: null },
  });
  const owner = 'owner-1';
  await runs.claim(started.id, owner, 60_000);
  const run = await runs.get(started.id);
  const gate = createTaskPhaseGate({ store, runs, run, owner, principal });
  return { taskId, run, gate, owner, principal };
}

const taskOf = (taskId: string) =>
  store.state(projectId).tasks.find((item) => item.id === taskId)!;

const historyKinds = (taskId: string, kind: string) =>
  store
    .state(projectId)
    .history.filter(
      (entry) =>
        (entry as { kind?: string }).kind === kind &&
        (entry as { taskId?: string }).taskId === taskId,
    );

const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

/** A Need shell around a recorded phase intent, for bridge validation. */
function phaseNeed(taskId: string, runId: string, intent: HarnessRun['steps'][number]['intent']): Need {
  return {
    id: 'N1',
    taskId,
    sessionId: 'S1',
    what: 'Continue this task to Build?',
    why: 'The agent finished this phase and asks to continue.',
    consequence: 'Continues within existing permissions.',
    files: [],
    state: 'open',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedFrom: '',
    allowForTask: false,
    preview: [],
    harness: { runId, intent: structuredClone(intent) },
  } as unknown as Need;
}

beforeEach(launch);
afterEach(close);

describe('task phase gate on the real run service', () => {
  test('stop mode parks before any build model step, with pending persisted first', async () => {
    const { taskId, run, gate } = await openTaskRun('stop-on-phase-change');
    await expect(gate('build')).rejects.toBeInstanceOf(Suspended);

    // The pending marker landed before the suspension: revision +1, one ask.
    const task = taskOf(taskId);
    expect(task.workflow!.pendingPhase).toBe('build');
    expect(task.workflow!.revision).toBe(2);
    expect(historyKinds(taskId, 'task-handoff-asked')).toHaveLength(1);

    // The run waits on the exact phase step; no phase advanced, no model ran.
    const waiting: HarnessRun = await runs.get(run.id);
    expect(waiting.state).toBe('waiting');
    const step = waiting.steps.find((item) => item.intent.stepId === 'task-phase:build')!;
    expect(step.state).toBe('waiting_approval');
    expect(step.intent.name).toBe(TASK_PHASE_INTENT_NAME);
    expect(taskOf(taskId).workflow!.phase).toBe('plan');
    expect(waiting.steps.some((item) => item.intent.kind === 'model')).toBe(false);
  });

  test('stale and foreign approvals are refused', async () => {
    const { taskId, run, gate, principal } = await openTaskRun('stop-on-phase-change');
    await expect(gate('build')).rejects.toBeInstanceOf(Suspended);

    // A decision for a step that is not waiting is refused.
    await expect(
      runs.decide(
        { runId: run.id, stepId: 'task-phase:review', decision: 'approved', decidedBy: 'local-client', ttlMs: 60_000, expiresAt: future() },
        principal,
      ),
    ).rejects.toThrow(/not waiting/i);

    const waiting = await runs.get(run.id);
    const step = waiting.steps.find((item) => item.intent.stepId === 'task-phase:build')!;

    // A tampered intent no longer matches the approval digest.
    const tampered = structuredClone(step.intent);
    (tampered.input as Record<string, unknown>).phase = 'review';
    const need = phaseNeed(taskId, run.id, step.intent);
    need.approval = identifyHarnessApproval(projectId, need);
    need.harness = { runId: run.id, intent: tampered };
    expect(() => harnessWrites(projectId, need)).toThrow(/no longer matches/i);

    // The same intent aimed at another project is refused.
    const crossProject = phaseNeed(taskId, run.id, step.intent);
    crossProject.approval = identifyHarnessApproval(projectId, crossProject);
    expect(() => harnessWrites('another-project', crossProject)).toThrow(/inconsistent/i);
    expect(() => identifyHarnessApproval('another-project', phaseNeed(taskId, run.id, step.intent))).toThrow(
      /inconsistent/i,
    );
  });

  test('the exact approval resumes the same run and advances exactly once', async () => {
    const { taskId, run, gate, principal } = await openTaskRun('stop-on-phase-change');
    await expect(gate('build')).rejects.toBeInstanceOf(Suspended);

    await runs.decide(
      { runId: run.id, stepId: 'task-phase:build', decision: 'approved', decidedBy: 'local-client', ttlMs: 60_000, expiresAt: future() },
      principal,
    );
    // Resume is the same run id: no second run, and the gate now passes.
    await gate('build');
    const resumed: HarnessRun = await runs.get(run.id);
    expect(resumed.id).toBe(run.id);
    expect(resumed.steps.filter((item) => item.intent.stepId === 'task-phase:build')).toHaveLength(1);

    const task = taskOf(taskId);
    expect(task.workflow!.phase).toBe('build');
    expect(task.workflow!.pendingPhase).toBeNull();
    expect(task.workflow!.handoffs).toHaveLength(1);
    expect(task.workflow!.handoffs[0]).toMatchObject({ from: 'plan', to: 'build' });
    expect(historyKinds(taskId, 'task-handoff')).toHaveLength(1);
    expect(task.workflow!.revision).toBe(3);
  });

  test('replay after the advance adds no history or revisions', async () => {
    const { taskId, run, gate, principal } = await openTaskRun('stop-on-phase-change');
    await expect(gate('build')).rejects.toBeInstanceOf(Suspended);
    await runs.decide(
      { runId: run.id, stepId: 'task-phase:build', decision: 'approved', decidedBy: 'local-client', ttlMs: 60_000, expiresAt: future() },
      principal,
    );
    await gate('build');
    const revision = taskOf(taskId).workflow!.revision;
    const handoffs = taskOf(taskId).workflow!.handoffs.length;
    const asked = historyKinds(taskId, 'task-handoff-asked').length;
    const moved = historyKinds(taskId, 'task-handoff').length;

    await gate('build');
    await gate('build');
    expect(taskOf(taskId).workflow!.revision).toBe(revision);
    expect(taskOf(taskId).workflow!.handoffs).toHaveLength(handoffs);
    expect(historyKinds(taskId, 'task-handoff-asked')).toHaveLength(asked);
    expect(historyKinds(taskId, 'task-handoff')).toHaveLength(moved);
  });

  test('full approval passes build and review with no suspension', async () => {
    const { taskId, run, gate } = await openTaskRun('full-approval');
    await gate('build');
    await gate('review');

    const task = taskOf(taskId);
    expect(task.workflow!.phase).toBe('review');
    expect(task.workflow!.pendingPhase).toBeNull();
    expect(task.workflow!.handoffs.map((entry) => entry.to)).toEqual(['build', 'review']);
    expect(historyKinds(taskId, 'task-handoff-asked')).toHaveLength(0);
    expect(historyKinds(taskId, 'task-handoff')).toHaveLength(2);

    const finished: HarnessRun = await runs.get(run.id);
    expect(finished.state).not.toBe('waiting');
    expect(finished.steps.some((item) => item.state === 'waiting_approval')).toBe(false);
  });

  test('legacy tasks without a workflow skip the gate entirely', async () => {
    const taskId: string = await store.locked(async () => {
      const state = store.state(projectId);
      const task = store.createTask(state, { name: 'Ungated work', owner: 'you' });
      await store.persist(state);
      return task.id;
    });
    const principal = principalFor();
    const started = await runs.start({
      tenantId: 'local',
      projectId,
      taskId,
      sessionId: 'S1',
      principal,
      capability: CAPABILITY,
      budget: { units: 50, modelCalls: 20, toolCalls: 20, wallMs: null },
    });
    await runs.claim(started.id, 'owner-1', 60_000);
    const gate = createTaskPhaseGate({ store, runs, run: await runs.get(started.id), owner: 'owner-1', principal });
    await gate('build');
    await gate('review');
    const after: HarnessRun = await runs.get(started.id);
    expect(after.steps.some((item) => item.intent.name === TASK_PHASE_INTENT_NAME)).toBe(false);
  });
});

describe('task phase approval identity', () => {
  test('the phase intent shape is exact and admits zero writes', async () => {
    const { taskId, run, gate } = await openTaskRun('stop-on-phase-change');
    await expect(gate('build')).rejects.toBeInstanceOf(Suspended);
    const waiting = await runs.get(run.id);
    const step = waiting.steps.find((item) => item.intent.stepId === 'task-phase:build')!;

    expect(isTaskPhaseIntent(step.intent)).toBe(true);
    expect(taskPhaseInputSchema.parse(step.intent.input)).toMatchObject({
      projectId,
      runId: run.id,
      taskId,
      phase: 'build',
    });
    expect(taskPhaseStepId('build')).toBe('task-phase:build');
    expect(taskPhaseStepId('review')).toBe('task-phase:review');

    const base = phaseNeed(taskId, run.id, step.intent);
    const identified = identifyHarnessApproval(projectId, base);
    const need = structuredClone(base);
    need.approval = identified;
    expect(harnessWrites(projectId, need)).toEqual([]);
    // Replay the same recorded Need, including createdAt: a newly created Need
    // can have a different expiry and therefore a different proposal digest.
    const again = identifyHarnessApproval(projectId, structuredClone(base));
    expect(again).toEqual(identified);
    const other = structuredClone(step.intent);
    (other.input as Record<string, unknown>).phase = 'review';
    const otherNeed = structuredClone(base);
    otherNeed.harness!.intent = other;
    const otherIdentity = identifyHarnessApproval(projectId, otherNeed);
    expect(otherIdentity.actionDigest).not.toBe(identified.actionDigest);
    expect(otherIdentity.baseDigest).not.toBe(identified.baseDigest);
  });

  test('the phase intent cannot be disguised as a write or widened', async () => {
    const { taskId, run, gate } = await openTaskRun('stop-on-phase-change');
    await expect(gate('build')).rejects.toBeInstanceOf(Suspended);
    const waiting = await runs.get(run.id);
    const step = waiting.steps.find((item) => item.intent.stepId === 'task-phase:build')!;

    // Same name but a tool kind is not a phase intent: the write checks refuse it.
    const disguised = { ...structuredClone(step.intent), kind: 'tool', effect: 'idempotent' } as typeof step.intent;
    expect(isTaskPhaseIntent(disguised)).toBe(false);
    const disguisedNeed = phaseNeed(taskId, run.id, disguised);
    disguisedNeed.approval = {
      protocolVersion: 1,
      actionDigest: digest(disguised),
      baseDigest: 'b',
      expiresAt: future(),
      sources: [],
      proposalDigest: 'p',
    };
    expect(() => harnessWrites(projectId, disguisedNeed)).toThrow(/not a recorded local write/i);

    // Extra input fields, a permission, or files/preview all fail validation.
    const extra = structuredClone(step.intent);
    (extra.input as Record<string, unknown>).text = 'hello';
    expect(isTaskPhaseIntent(extra)).toBe(false);
    const permitted = { ...structuredClone(step.intent), permission: 'write-project-file' };
    expect(isTaskPhaseIntent(permitted)).toBe(false);
    const valid = phaseNeed(taskId, run.id, step.intent);
    valid.approval = identifyHarnessApproval(projectId, valid);
    valid.files = ['Harness report.md'];
    expect(() => harnessWrites(projectId, valid)).toThrow(/inconsistent/i);
  });

  test('no remembered grant can ever cover a phase approval', async () => {
    const { taskId, run, gate } = await openTaskRun('stop-on-phase-change');
    await expect(gate('build')).rejects.toBeInstanceOf(Suspended);
    const waiting = await runs.get(run.id);
    const step = waiting.steps.find((item) => item.intent.stepId === 'task-phase:build')!;
    // Null permission (and no bound destination) means no pattern to remember.
    expect(
      patternForStep({
        projectId,
        procedure: 'task-phase-test-loop',
        intent: step.intent,
        engine: 'native-fixture',
        accountRoute: null,
      }),
    ).toBeNull();
    expect(taskId).toBeTruthy();
  });

  test('the Need wording names the continuation, never only reads', async () => {
    const { run, gate } = await openTaskRun('stop-on-phase-change');
    await expect(gate('build')).rejects.toBeInstanceOf(Suspended);
    const waiting = await runs.get(run.id);
    const step = waiting.steps.find((item) => item.intent.stepId === 'task-phase:build')!;
    const fields = needFromWaitingStep(waiting, step);
    expect(fields.what).toBe('Continue this task to Build?');
    expect(fields.files).toEqual([]);
    expect(fields.consequence).toMatch(/existing file, service and spend permissions/i);
    expect(fields.consequence).toMatch(/grants nothing new/i);
    expect(fields.consequence).not.toMatch(/only reads/i);
  });
});
