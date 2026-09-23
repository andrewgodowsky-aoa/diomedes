import type { HarnessRun } from '../../shared/harness';
import type { Change, Conversation, Need, Session, Task } from '../../shared/types';
import { taskEvidence } from '../workbench/task-evidence';
import { planName, stepState } from './progress-bars';
import type { SegmentState, SegmentStep } from './segment-bar-model';

// The progress board in the artifact column (artifacts v2, (d)): how far a conversation's work
// has come, counted only from records. A thread attached to a plan counts the tasks that plan
// produced; a conversation that started work counts the tasks its run's receipt phases name.
// Nothing here reads a turn, so nothing a model wrote (a `progress` visual included) is ever
// counted, and every unit of every count is a task record (contract A9). A model's own steps
// inside one reply have no honest total, so they are not counted at all. Pure: no React, no DOM,
// no clock and no request, so it is tested directly (tests/board-model.test.ts).

/** One piece of work a conversation started, as its run's receipt phases recorded it. */
export interface StartedWork {
  /** The message the work was started from. */
  sourceMessageId: string;
  /** Where the task was made: the conversation's own project, or the one Automatic chose. */
  projectId: string;
  taskId: string;
  /** The run that took the task on, or null when its work was refused or is not started yet. */
  sessionId: string | null;
}

const PHASE_PREFIX = 'phase.';
const named = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const fieldsOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The work a conversation's run recorded as started, in the order its task receipts were saved.
 * It reads the interaction phases the host saves as pure steps (`phase.<name>:<digest>`, input
 * `{phase, sourceMessageId, body}`, recorded by server/interaction-service.ts through each session
 * run's driver) the way the host reads them back: succeeded `transform` steps only. A task receipt
 * counts only beside the task input that says which project its task is in; nothing is guessed.
 */
export function startedWorkOf(run: Pick<HarnessRun, 'steps'> | null | undefined): StartedWork[] {
  if (!run) return [];
  const projects = new Map<string, string>();
  const sessions = new Map<string, string>();
  const receipts = new Map<string, string>();
  for (const step of run.steps) {
    if (step.state !== 'succeeded' || step.intent.kind !== 'transform' || !step.intent.stepId.startsWith(PHASE_PREFIX))
      continue;
    const input = fieldsOf(step.intent.input);
    const message = named(input?.sourceMessageId);
    const body = fieldsOf(input?.body);
    if (!input || !message || !body) continue;
    if (input.phase === 'task-input') {
      const project = named(body.projectId);
      if (project && !projects.has(message)) projects.set(message, project);
    } else if (input.phase === 'task-receipt') {
      const task = named(body.taskId);
      if (task && !receipts.has(message)) receipts.set(message, task);
    } else if (input.phase === 'work-receipt') {
      const session = named(body.sessionId);
      if (session && !sessions.has(message)) sessions.set(message, session);
    }
  }
  return [...receipts].flatMap(([sourceMessageId, taskId]) => {
    const projectId = projects.get(sourceMessageId);
    return projectId ? [{ sourceMessageId, projectId, taskId, sessionId: sessions.get(sourceMessageId) ?? null }] : [];
  });
}

/** One task on the board. */
export interface BoardStep extends SegmentStep {
  taskId: string;
  label: string;
  /** The task record's own words for where it stands, as the Board's cards say them (taskEvidence). */
  detail: string;
}

export interface BoardGroup {
  kind: 'plan' | 'started';
  key: string;
  /** What a person reads above the bar: the plan's file name, or where the work came from. */
  name: string;
  /** The bar's accessible name. */
  label: string;
  /** The bar's words for what it counts, singular for one task. */
  noun: string;
  steps: BoardStep[];
}

export interface Board {
  /**
   * The same while the board counts the same tasks in the same thread, whatever state they are
   * in, and different once a task comes or goes: a board a person closed stays closed until then.
   */
  key: string;
  groups: BoardGroup[];
}

export interface BoardInput {
  /** The project whose records these are. Only its own tasks are counted. */
  projectId: string;
  thread: Pick<Conversation, 'id' | 'attachedTo'>;
  /** What the conversation's runs recorded as started (`startedWorkOf`). */
  started: readonly StartedWork[];
  tasks: readonly Task[];
  sessions: readonly Session[];
  needs?: readonly Need[];
  changes?: readonly Change[];
}

/** A step still to finish. The board is shown while one of its steps is in one of these. */
const OPEN: ReadonlySet<SegmentState> = new Set(['active', 'pending', 'blocked']);

/** A plan's path as the server keeps it (server/paths.ts relativeName: backslashes become slashes). */
const planPath = (value: string) => value.replaceAll('\\', '/');

const noun = (count: number) => (count === 1 ? 'task done' : 'tasks done');

/**
 * The board for one thread, or null when there is nothing on record still to finish. Up to two
 * groups: the tasks of the plan the thread is attached to, ordered and counted exactly as the
 * Board's plan groups are (progress-bars.ts planGroups: two tasks at least, deleted ones left
 * out), and the tasks the conversation started, one step each. A task counted by the plan is not
 * counted again, and a started task this project does not hold (made in another project, or
 * deleted) has no step: nothing is guessed. Each step's state is the one the Board's columns
 * show (`taskEvidence`, then `stepState`), so the two never disagree.
 */
export function boardFor(input: BoardInput): Board | null {
  const needs = input.needs ?? [];
  const changes = input.changes ?? [];
  const kept = input.tasks.filter((task) => !task.deletedAt);
  const step = (task: Task): BoardStep => {
    const seen = taskEvidence(task, input.sessions, needs, changes);
    return { taskId: task.id, label: task.name, state: stepState(seen.column, seen.session), detail: seen.detail };
  };
  const groups: BoardGroup[] = [];
  const counted = new Set<string>();

  const attached = input.thread.attachedTo;
  if (attached?.kind === 'plan') {
    const plan = planPath(attached.ref);
    const planned = kept
      .filter((task) => task.from && planPath(task.from.plan) === plan)
      .sort(
        (a, b) =>
          (a.from?.step ?? 0) - (b.from?.step ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    if (planned.length >= 2) {
      for (const task of planned) counted.add(task.id);
      const name = planName(plan);
      groups.push({
        kind: 'plan',
        key: `plan:${plan}`,
        name,
        label: `Tasks from ${name}`,
        noun: noun(planned.length),
        steps: planned.map(step),
      });
    }
  }

  const byId = new Map(kept.map((task) => [task.id, task]));
  const started: Task[] = [];
  for (const work of input.started) {
    if (work.projectId !== input.projectId || counted.has(work.taskId)) continue;
    const task = byId.get(work.taskId);
    if (!task) continue;
    counted.add(task.id);
    started.push(task);
  }
  if (started.length)
    groups.push({
      kind: 'started',
      key: 'started',
      name: 'Started from this conversation',
      label: 'Work this conversation started',
      noun: noun(started.length),
      steps: started.map(step),
    });

  if (!groups.some((group) => group.steps.some((item) => OPEN.has(item.state)))) return null;
  return {
    key: [input.thread.id, ...groups.map((group) => `${group.key}=${group.steps.map((item) => item.taskId).join(',')}`)].join('\n'),
    groups,
  };
}
