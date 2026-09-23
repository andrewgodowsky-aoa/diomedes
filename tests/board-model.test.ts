import { describe, expect, it } from 'vitest';
import type { HarnessRun, StepRecord } from '../shared/harness';
import type { Change, Conversation, Need, Session, Task } from '../shared/types';
import { taskEvidence } from '../client/workbench/task-evidence';
import { planGroups, stepState } from '../client/console/progress-bars';
import { segmentModel } from '../client/console/segment-bar-model';
import { boardFor, startedWorkOf, type BoardInput, type StartedWork } from '../client/console/board-model';

// The progress board in the side panel (artifacts v2, (d)). It counts only records: the tasks a
// thread's attached plan produced, and the tasks the conversation started, as its run's receipt
// phases recorded them. Nothing a model wrote is ever counted, so no denominator appears without
// a task behind every unit of it.

const AT = '2026-09-23T08:00:00.000Z';
const PROJECT = 'P1';
const PLAN = 'plans/Launch week.md';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    name: `Task ${id}`,
    description: '',
    from: null,
    owner: 'diomedes',
    state: 'todo',
    reason: null,
    needId: null,
    sessionIds: [],
    changeIds: [],
    createdBy: 'you',
    createdAt: AT,
    moves: [],
    ...over,
  } as Task;
}
const planned = (id: string, step: number, over: Partial<Task> = {}) => task(id, { from: { plan: PLAN, step }, ...over });

function session(taskId: string, state: Session['state'], id = `s-${taskId}`): Session {
  return {
    id,
    taskId,
    state,
    startedAt: AT,
    endedAt: state === 'working' || state === 'queued' || state === 'waiting' ? null : AT,
    sample: true,
    log: [],
    entryIds: [],
    needId: null,
    engine: { name: 'Sample', model: null },
  } as unknown as Session;
}
const openNeed = (taskId: string) => ({ id: `n-${taskId}`, taskId, state: 'open' }) as unknown as Need;

/** A whole thread, turns included: the board is handed all of it and must read none of the turns. */
function thread(attachedTo: Conversation['attachedTo'], text = ''): Conversation {
  return {
    id: 'C1',
    attachedTo,
    name: 'Launch plan',
    createdAt: AT,
    updatedAt: AT,
    taskId: null,
    helper: null,
    turns: text ? [{ id: 'T1', role: 'diomedes', text, createdAt: AT }] : [],
  } as unknown as Conversation;
}
const onPlan = (text = '') => thread({ kind: 'plan', ref: PLAN }, text);
const onProject = (text = '') => thread({ kind: 'project', ref: PROJECT }, text);

function input(over: Partial<BoardInput>): BoardInput {
  return { projectId: PROJECT, thread: onPlan(), started: [], tasks: [], sessions: [], needs: [], changes: [], ...over };
}

/** A reply that says the work is 90% done: words a model wrote, never a count of anything. */
const NINETY = 'Nearly there.\n\n```visual\n{"kind":"progress","label":"Launch","value":0.9,"detail":"9 of 10"}\n```';

const text = (group: { steps: { state: string }[]; noun: string }) =>
  segmentModel({ steps: group.steps as never, noun: group.noun }).text;

describe('the board counts records, never words', () => {
  it('counts the plan by its tasks, whatever a reply in the thread says about it', () => {
    const tasks = [planned('t1', 1, { state: 'done' }), planned('t2', 2), planned('t3', 3)];
    const board = boardFor(input({ thread: onPlan(NINETY), tasks }))!;
    expect(board).not.toBeNull();
    expect(board.groups).toHaveLength(1);
    const [group] = board.groups;
    expect(group).toMatchObject({ kind: 'plan', name: 'Launch week.md', label: 'Tasks from Launch week.md' });
    expect(group.steps.map((step) => [step.taskId, step.state])).toEqual([
      ['t1', 'done'],
      ['t2', 'pending'],
      ['t3', 'pending'],
    ]);
    expect(text(group)).toBe('1 of 3 tasks done');
  });

  it('draws no board where there is nothing on record to count', () => {
    // A thread on the project, with a reply's progress and no work started.
    expect(boardFor(input({ thread: onProject(NINETY), tasks: [planned('t1', 1), planned('t2', 2)] }))).toBeNull();
    // A plan with no tasks, one task, or only deleted ones.
    expect(boardFor(input({ thread: onPlan(NINETY) }))).toBeNull();
    expect(boardFor(input({ tasks: [planned('t1', 1)] }))).toBeNull();
    expect(
      boardFor(input({ tasks: [planned('t1', 1, { deletedAt: AT }), planned('t2', 2, { deletedAt: AT })] })),
    ).toBeNull();
    // Another plan's tasks.
    expect(
      boardFor(input({ tasks: [task('t1', { from: { plan: 'plans/Other.md', step: 1 } }), task('t2', { from: { plan: 'plans/Other.md', step: 2 } })] })),
    ).toBeNull();
  });

  it('shows the board only while a step is still to finish', () => {
    const done = [planned('t1', 1, { state: 'done' }), planned('t2', 2, { state: 'done' })];
    expect(boardFor(input({ tasks: done }))).toBeNull();
    // A failed run is not work still moving, and neither is a finished plan beside it.
    expect(
      boardFor(input({ tasks: [planned('t1', 1, { state: 'done' }), planned('t2', 2)], sessions: [session('t2', 'failed')] })),
    ).toBeNull();
    // A run waiting on the person keeps it: that step needs someone.
    const waiting = boardFor(
      input({
        tasks: [planned('t1', 1, { state: 'done' }), planned('t2', 2)],
        sessions: [session('t2', 'waiting')],
        needs: [openNeed('t2')],
      }),
    );
    expect(waiting?.groups[0].steps.map((step) => step.state)).toEqual(['done', 'blocked']);
  });
});

describe('a plan group', () => {
  it('reads every step from the task record, as the Board columns do', () => {
    const tasks = [planned('t1', 1, { state: 'done' }), planned('t2', 2), planned('t3', 3), planned('t4', 4)];
    const sessions = [session('t2', 'working'), session('t3', 'waiting'), session('t4', 'failed')];
    const needs = [openNeed('t3')];
    const changes: Change[] = [];
    const board = boardFor(input({ tasks, sessions, needs, changes }))!;
    const steps = board.groups[0].steps;
    expect(steps.map((step) => step.state)).toEqual(['done', 'active', 'blocked', 'failed']);
    for (const [index, step] of steps.entries()) {
      const seen = taskEvidence(tasks[index], sessions, needs, changes);
      expect(step.state).toBe(stepState(seen.column, seen.session));
      expect(step.detail).toBe(seen.detail);
    }
    expect(steps[2].detail).toBe('Needs your decision');
  });

  it('orders and counts its steps exactly as the Board\'s plan groups do', () => {
    const tasks = [
      planned('t9', 3, { createdAt: '2026-09-23T08:00:03.000Z' }),
      planned('t2', 1, { state: 'done' }),
      planned('t5', 2, { createdAt: '2026-09-23T08:00:02.000Z' }),
      planned('t4', 2, { createdAt: '2026-09-23T08:00:01.000Z', name: 'Earlier on the same line' }),
      planned('t7', 2, { createdAt: '2026-09-23T08:00:01.000Z' }),
      planned('gone', 1, { deletedAt: AT }),
      task('elsewhere'),
    ];
    const sessions = [session('t5', 'working')];
    const evidence = (item: Task) => taskEvidence(item, sessions, [], []);
    const expected = planGroups(tasks, evidence).find((group) => group.plan === PLAN)!;
    const board = boardFor(input({ tasks, sessions }))!;
    expect(board.groups[0].steps.map(({ label, state }) => ({ label, state }))).toEqual(expected.steps);
    expect(board.groups[0].steps.map((step) => step.taskId)).toEqual(['t2', 't4', 't7', 't5', 't9']);
  });

  it('finds the plan however the thread spelt its path', () => {
    const tasks = [planned('t1', 1), planned('t2', 2)];
    const backslashed = thread({ kind: 'plan', ref: 'plans\\Launch week.md' });
    expect(boardFor(input({ thread: backslashed, tasks }))?.groups[0].steps).toHaveLength(2);
  });
});

// ---- work the conversation started -------------------------------------------------------------

let seq = 0;
/** One recorded interaction phase: a pure transform step, as each session run's driver saves it. */
function phase(name: string, sourceMessageId: string, body: Record<string, unknown>, state: StepRecord['state'] = 'succeeded'): StepRecord {
  seq += 1;
  return {
    intent: {
      stepId: `phase.${name}:${String(seq).padStart(40, '0')}`,
      stepVersion: '1',
      kind: 'transform',
      effect: 'pure',
      name: `Interaction ${name}`,
      input: { phase: name, sourceMessageId, body },
      cost: 0,
      maxAttempts: 3,
      permission: null,
      approval: false,
      destination: 'local',
      trustedInputRequired: false,
      label: null,
      policyVersion: '1',
    },
    intentHash: `h${seq}`,
    attempt: 1,
    state,
    output: null,
    outputHash: null,
    leaseFence: 0,
    startedAt: AT,
    endedAt: AT,
    error: null,
  } as unknown as StepRecord;
}

/** A model turn's own step: never a phase, and never counted. */
function modelStep(): StepRecord {
  const step = phase('model', 'M0', {});
  return { ...step, intent: { ...step.intent, stepId: `model.turn:${seq}`, kind: 'model', input: { prompt: 'x' } } } as unknown as StepRecord;
}

/** What Automatic records for one message whose work it started (interaction-service.ts). */
function startedMessage(message: string, projectId: string, taskId: string, sessionId?: string): StepRecord[] {
  return [
    phase('decision', message, { kind: 'act' }),
    phase('action-selected', message, { selection: 'start' }),
    phase('task-input', message, { projectId, taskCommandId: `tc-${message}`, name: `Task for ${message}` }),
    phase('task-receipt', message, { taskId }),
    phase('work-input', message, { projectId, workCommandId: `wc-${message}`, taskId, route: 'sample' }),
    ...(sessionId ? [phase('work-receipt', message, { sessionId })] : []),
  ];
}

const run = (steps: StepRecord[]) => ({ steps }) as Pick<HarnessRun, 'steps'>;

describe('the work a conversation started', () => {
  it('is read back from its run\'s receipt phases alone, as after a reload', () => {
    const steps = [
      modelStep(),
      ...startedMessage('M1', PROJECT, 't1', 's-t1'),
      // A message whose task was made but whose work was refused: a task, and no session.
      ...startedMessage('M2', PROJECT, 't2'),
      phase('work-refused', 'M2', { status: 409, message: 'Busy.' }),
      // Refused before any task was made, and a receipt that never finished: nothing to count.
      phase('task-input', 'M3', { projectId: PROJECT, taskCommandId: 'tc-M3', name: 'Refused' }),
      phase('task-refused', 'M3', { status: 409, message: 'No.' }),
      phase('task-input', 'M4', { projectId: PROJECT, taskCommandId: 'tc-M4', name: 'Running' }),
      phase('task-receipt', 'M4', { taskId: 't4' }, 'running'),
      // Work started in another project.
      ...startedMessage('M5', 'P2', 'x1', 's-x1'),
      // A receipt with no task-input to say where the task is: nothing is guessed.
      phase('task-receipt', 'M6', { taskId: 't6' }),
    ];
    expect(startedWorkOf(run(steps))).toEqual<StartedWork[]>([
      { sourceMessageId: 'M1', projectId: PROJECT, taskId: 't1', sessionId: 's-t1' },
      { sourceMessageId: 'M2', projectId: PROJECT, taskId: 't2', sessionId: null },
      { sourceMessageId: 'M5', projectId: 'P2', taskId: 'x1', sessionId: 's-x1' },
    ]);
    expect(startedWorkOf(null)).toEqual([]);
    expect(startedWorkOf(run([modelStep()]))).toEqual([]);
  });

  it('is a group of its own tasks, one step each, and none for a task this project does not hold', () => {
    const started = startedWorkOf(
      run([
        ...startedMessage('M1', PROJECT, 't1', 's-t1'),
        ...startedMessage('M2', PROJECT, 't2', 's-t2'),
        // The same task again (a retried message reaches the receipt it already had).
        ...startedMessage('M3', PROJECT, 't1', 's-t1'),
        ...startedMessage('M4', 'P2', 'x1', 's-x1'),
        ...startedMessage('M5', PROJECT, 'deleted', 's-deleted'),
        ...startedMessage('M6', PROJECT, 'missing', 's-missing'),
      ]),
    );
    const tasks = [task('t1', { name: 'Tidy the plan' }), task('t2', { name: 'Draft the offer', state: 'done' }), task('deleted', { deletedAt: AT })];
    const sessions = [session('t1', 'working', 's-t1'), session('t2', 'done', 's-t2')];
    const board = boardFor(input({ thread: onProject(NINETY), started, tasks, sessions }))!;
    expect(board.groups).toHaveLength(1);
    const [group] = board.groups;
    expect(group).toMatchObject({ kind: 'started', name: 'Started from this conversation', label: 'Work this conversation started' });
    expect(group.steps.map((step) => [step.taskId, step.label, step.state])).toEqual([
      ['t1', 'Tidy the plan', 'active'],
      ['t2', 'Draft the offer', 'done'],
    ]);
    expect(text(group)).toBe('1 of 2 tasks done');
    // One started task reads in the singular.
    const one = boardFor(input({ thread: onProject(), started: started.slice(0, 1), tasks, sessions }))!;
    expect(text(one.groups[0])).toBe('0 of 1 task done');
  });

  it('sits beside the plan group, and a task the plan already counts is not counted twice', () => {
    const tasks = [planned('t1', 1, { state: 'done' }), planned('t2', 2), task('t3')];
    const started = startedWorkOf(run([...startedMessage('M1', PROJECT, 't2'), ...startedMessage('M2', PROJECT, 't3')]));
    const board = boardFor(input({ tasks, started }))!;
    expect(board.groups.map((group) => [group.kind, group.steps.map((step) => step.taskId)])).toEqual([
      ['plan', ['t1', 't2']],
      ['started', ['t3']],
    ]);
  });
});

describe('the board key', () => {
  it('changes when a counted task comes or goes, and not when a step moves', () => {
    const tasks = [planned('t1', 1), planned('t2', 2)];
    const first = boardFor(input({ tasks }))!;
    const moved = boardFor(input({ tasks: [planned('t1', 1, { state: 'done' }), planned('t2', 2)] }))!;
    expect(moved.key).toBe(first.key);
    const grown = boardFor(input({ tasks: [...tasks, planned('t3', 3)] }))!;
    expect(grown.key).not.toBe(first.key);
    const elsewhere = boardFor(input({ tasks, thread: { ...onPlan(), id: 'C2' } }))!;
    expect(elsewhere.key).not.toBe(first.key);
  });
});
