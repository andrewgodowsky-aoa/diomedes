/**
 * propose_task as the loop host owns it (server/harness/capabilities/native-loop.ts).
 *
 * Through the real ToolRegistry dispatch against the real Store and the real
 * RunService: the model supplies name/description/output only, the host binds
 * project/run, and the tool checks at dispatch that it is the running step of
 * a task work loop in that project. Proposals branch Inbox children via the
 * trusted proposeTask helper: no start, no grants, depth 2, at most four
 * children, receipt-backed replay and reconcile.
 *
 * Model transport is never touched here; task, approval and registry code are
 * all real. Heavy suites (build, Playwright, browser, live calls) are NOT run
 * here: another lane holds the shared heavy slot. Run with
 * `npx vitest run tests/task-proposal-tool.test.ts` once the slot is granted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { FileRunStore, RunService, ToolRegistry } from '../server/harness/index.js';
import {
  NATIVE_LOOP,
  NATIVE_LOOP_DELEGATE,
  registerLoopTools,
} from '../server/harness/capabilities/native-loop.js';
import { taskWorkflowBlocker } from '../shared/task-workflow.js';
import { readyAt } from '../shared/ready-queue.js';
import type { HarnessPrincipal } from '../shared/harness.js';
import type { Session, Task } from '../shared/types.js';

let root: string;
let store: Store;
let runs: RunService;
let tools: ToolRegistry;
let projectId: string;

const principalFor = (): HarnessPrincipal => ({
  id: 'local-client',
  tenantId: 'local',
  projectId,
  capabilities: ['write-project-file'],
  identityGeneration: 1,
});

const sessionRecord = (id: string, taskId: string): Session => ({
  id, taskId, state: 'working', startedAt: new Date().toISOString(), endedAt: null,
  sample: true, log: [], entryIds: [], needId: null,
  engine: { name: 'diomedes-loop', model: null, worker: 1, branch: null, context: null, events: 0 },
});

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-propose-task-')));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  runs = new RunService(new FileRunStore(path.join(root, 'runs')));
  tools = new ToolRegistry();
  registerLoopTools(tools, store, runs);
  projectId = await store.locked(async () => {
    const created = await store.createProject('Proposal board');
    return created.id;
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A parent task with an explicit workflow plus the store session the proposal must name. */
async function makeParent(name = 'Parent work'): Promise<{ task: Task; sessionId: string }> {
  const sessionId = `S-${Math.random().toString(36).slice(2)}`;
  const task = await store.locked(async () => {
    const state = store.state(projectId);
    const created = store.createTask(state, { name, owner: 'you' });
    created.workflow = {
      revision: 1,
      phase: 'plan',
      continuation: 'stop-on-phase-change',
      inbox: false,
      parentTaskId: null,
      output: null,
      maxTurns: 8,
      pendingPhase: null,
      pendingReason: null,
      handoffs: [],
    };
    state.sessions.push(sessionRecord(sessionId, created.id));
    await store.persist(state);
    return structuredClone(created);
  });
  return { task, sessionId };
}

/** A claimed task work loop run bound to the parent task and session. */
async function startLoop(taskId: string, sessionId: string | null) {
  const principal = principalFor();
  const started = await runs.start({
    tenantId: 'local',
    projectId,
    taskId,
    sessionId,
    principal,
    capability: NATIVE_LOOP,
    budget: { units: 100, modelCalls: 20, toolCalls: 20, wallMs: null },
  });
  await runs.claim(started.id, 'host-1', 60_000);
  return { runId: started.id, principal };
}

const propose = (
  runId: string,
  stepId: string,
  body: { name: string; description: string; output?: string },
  project?: string,
) =>
  tools.dispatch<{ taskId: string; inbox: boolean }>(runs, {
    runId,
    owner: 'host-1',
    principal: principalFor(),
    stepId,
    name: 'propose_task',
    input: { projectId: project ?? projectId, runId, ...body },
  });

const childOf = (taskId: string): Task =>
  structuredClone(store.state(projectId).tasks.find((item) => item.id === taskId)!);

describe('propose_task through the real registry and host authority', () => {
  test('a loop proposes an Inbox child bound to its project and run, with a creation receipt', async () => {
    const { task: parent, sessionId } = await makeParent();
    const { runId } = await startLoop(parent.id, sessionId);

    const out = await propose(runId, 'propose:1', {
      name: 'Check the cellar stock',
      description: 'Count what is downstairs.',
      output: 'The cellar count, as its own result.',
    });
    expect(out.inbox).toBe(true);

    const child = childOf(out.taskId);
    expect(child.workflow).toMatchObject({
      inbox: true,
      parentTaskId: parent.id,
      output: 'The cellar count, as its own result.',
      phase: 'plan',
      continuation: 'stop-on-phase-change',
    });
    expect(child.workflow!.maxTurns).toBeLessThanOrEqual(8);
    expect(child.createdBy).toBe('diomedes');
    expect(child.sessionIds).toEqual([]);
    expect(child.creationReceipt?.commandId).toMatch(/^proposal\./);
    expect(child.creationReceipt?.projectId).toBe(projectId);
    expect(child.creationReceipt?.actor).toBe('harness');
    const reopened = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await reopened.init();
    expect(reopened.state(projectId).tasks.find((task) => task.id === child.id)?.creationReceipt).toEqual(child.creationReceipt);
    // The gate itself: Inbox, never auto-started, nothing granted.
    expect(taskWorkflowBlocker(child)).toContain('Inbox');
    expect(readyAt(child, [], [], [])).toBeNull();
    expect((child as unknown as Record<string, unknown>).approval).toBeUndefined();
    // The effect intent names exactly the task list it may change.
    const step = (await runs.get(runId)).steps.find((item) => item.intent.stepId === 'propose:1')!;
    expect(step.effects?.[0]).toMatchObject({
      tool: 'propose_task',
      effectClass: 'idempotent-write',
      targets: [`tasks/${projectId}/${runId}`],
    });
  });

  test('replaying the same step returns the one task; the same identity with another payload is refused', async () => {
    const { task: parent, sessionId } = await makeParent();
    const { runId } = await startLoop(parent.id, sessionId);
    const body = {
      name: 'Count the napkins',
      description: 'Count what is on the shelf.',
      output: 'The napkin count, as its own result.',
    };

    const first = await propose(runId, 'propose:2', body);
    const again = await propose(runId, 'propose:2', body);
    expect(again).toEqual(first);
    expect(
      store.state(projectId).tasks.filter((item) => item.workflow?.parentTaskId === parent.id),
    ).toHaveLength(1);

    await expect(propose(runId, 'propose:2', { ...body, name: 'Something else entirely' })).rejects.toThrow(
      /step intent mismatch/,
    );
    expect(
      store.state(projectId).tasks.filter((item) => item.workflow?.parentTaskId === parent.id),
    ).toHaveLength(1);
  });

  test('a child without its own separate output is refused and nothing is branched', async () => {
    const { task: parent, sessionId } = await makeParent();
    const { runId } = await startLoop(parent.id, sessionId);

    await expect(
      propose(runId, 'propose:3', { name: 'Vague follow-up', description: 'No result named.' }),
    ).rejects.toThrow(/rejected/);
    expect(
      store.state(projectId).tasks.filter((item) => item.workflow?.parentTaskId === parent.id),
    ).toHaveLength(0);
  });

  test('a spoofed project, run or delegate identity is refused', async () => {
    const { task: parent, sessionId } = await makeParent();
    const { runId } = await startLoop(parent.id, sessionId);
    const body = {
      name: 'Honest child',
      description: 'An honest proposal.',
      output: 'Its own result.',
    };

    await expect(
      propose(runId, 'propose:4', body, 'another-project'),
    ).rejects.toThrow(/not the active step of a loop run/);

    const other = await startLoop(parent.id, sessionId);
    await expect(
      tools.dispatch(runs, {
        runId,
        owner: 'host-1',
        principal: principalFor(),
        stepId: 'propose:5',
        name: 'propose_task',
        input: { projectId, runId: other.runId, ...body },
      }),
    ).rejects.toThrow(/not the active step of a loop run/);

    // A delegate run is not a task work loop: it cannot propose children.
    const delegate = await runs.start({
      tenantId: 'local',
      projectId,
      taskId: parent.id,
      sessionId: null,
      principal: principalFor(),
      capability: NATIVE_LOOP_DELEGATE,
      budget: { units: 50, modelCalls: 10, toolCalls: 10, wallMs: null },
    });
    await runs.claim(delegate.id, 'host-1', 60_000);
    await expect(
      tools.dispatch(runs, {
        runId: delegate.id,
        owner: 'host-1',
        principal: principalFor(),
        stepId: 'propose:6',
        name: 'propose_task',
        input: { projectId, runId: delegate.id, ...body },
      }),
    ).rejects.toThrow(/Only a task work loop can propose a child/);
    expect(
      store.state(projectId).tasks.filter((item) => item.workflow?.parentTaskId === parent.id),
    ).toHaveLength(0);
  });

  test('at most four children: the fifth proposal is refused', async () => {
    const { task: parent, sessionId } = await makeParent('Busy parent');
    const { runId } = await startLoop(parent.id, sessionId);

    for (let index = 1; index <= 4; index++) {
      const out = await propose(runId, `child:${index}`, {
        name: `Child ${index}`,
        description: `The ${index}th separate piece.`,
        output: `Separate result ${index}.`,
      });
      expect(out.taskId).toBeTruthy();
    }
    await expect(
      propose(runId, 'child:5', {
        name: 'Child 5',
        description: 'One too many.',
        output: 'A fifth separate result.',
      }),
    ).rejects.toThrow(/limit of 4 branched tasks/);
    expect(
      store.state(projectId).tasks.filter((item) => item.workflow?.parentTaskId === parent.id),
    ).toHaveLength(4);
  });

  test('depth two: a grandchild is admitted, a great-grandchild is refused', async () => {
    const { task: parent, sessionId } = await makeParent('Deep parent');
    const { runId } = await startLoop(parent.id, sessionId);
    const childId = (
      await propose(runId, 'depth:1', {
        name: 'Child task',
        description: 'First level.',
        output: 'The child result.',
      })
    ).taskId;

    const childSession = `S-${childId}`;
    await store.locked(async () => {
      const state = store.state(projectId);
      state.sessions.push(sessionRecord(childSession, childId));
      await store.persist(state);
    });
    const childRun = await startLoop(childId, childSession);
    const grandId = (
      await tools.dispatch<{ taskId: string; inbox: boolean }>(runs, {
        runId: childRun.runId,
        owner: 'host-1',
        principal: principalFor(),
        stepId: 'depth:2',
        name: 'propose_task',
        input: {
          projectId,
          runId: childRun.runId,
          name: 'Grandchild task',
          description: 'Second level.',
          output: 'The grandchild result.',
        },
      })
    ).taskId;

    const grandSession = `S-${grandId}`;
    await store.locked(async () => {
      const state = store.state(projectId);
      state.sessions.push(sessionRecord(grandSession, grandId));
      await store.persist(state);
    });
    const grandRun = await startLoop(grandId, grandSession);
    await expect(
      tools.dispatch(runs, {
        runId: grandRun.runId,
        owner: 'host-1',
        principal: principalFor(),
        stepId: 'depth:3',
        name: 'propose_task',
        input: {
          projectId,
          runId: grandRun.runId,
          name: 'Too deep',
          description: 'Third level.',
          output: 'A result too far down.',
        },
      }),
    ).rejects.toThrow(/2 levels deep/);
  });

  test('the reconciler finds the recorded task under its idempotency key and nothing else', async () => {
    const { task: parent, sessionId } = await makeParent();
    const { runId } = await startLoop(parent.id, sessionId);
    const out = await propose(runId, 'propose:7', {
      name: 'Reconciled child',
      description: 'Recorded under its key.',
      output: 'The reconciled result.',
    });

    const step = (await runs.get(runId)).steps.find((item) => item.intent.stepId === 'propose:7')!;
    const key = childOf(out.taskId).creationReceipt!.commandId.replace(/^proposal\./, '');
    const definition = tools.get('propose_task');
    await expect(
      definition.reconcile!({
        input: step.intent.input as { projectId: string; runId: string; name: string; description: string; output: string },
        record: { idempotencyKey: key } as never,
      }),
    ).resolves.toEqual({ applied: { taskId: out.taskId, inbox: true } });
    await expect(
      definition.reconcile!({
        input: step.intent.input as { projectId: string; runId: string; name: string; description: string; output: string },
        record: { idempotencyKey: 'no-such-key' } as never,
      }),
    ).resolves.toBe('not-applied');
  });
});
