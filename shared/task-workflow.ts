/**
 * Bounded backend task workflow: the pure half (Board gaps, decisions 4 and 12).
 *
 * A task may carry an optional `Task.workflow`: a revision, a phase
 * (plan/build/review), the continuation a person chose — Full approval (the
 * agent proceeds through phases within the existing scope and limits) or Stop
 * on phase change (the default: the next phase parks for approval) — an Inbox
 * gate, an optional parent, its own separate output, a turn budget and the
 * append-only handoffs. Nothing here starts anything, grants anything or
 * touches the store: the server routes (`server/task-workflow.ts`) admit and
 * persist, the Ready queue (`shared/ready-queue.ts`) refuses what is gated,
 * and the parent enforces `taskWorkflowBlocker` in Work and loop admission.
 * Pure: no clock, no store, no request, so it is tested directly
 * (tests/task-workflow.test.ts).
 *
 * Reuses the Task, Store, run and Need records: there is no parallel
 * lifecycle. A task without a workflow runs exactly as before.
 */
import type { Owner, Task, TaskContinuation, TaskHandoff, TaskWorkflow, TaskWorkflowPhase, TeamMember } from './types.js';

export const TASK_WORKFLOW_CONTRACT_VERSION = 1 as const;

/** Phases in order. A handoff always moves one step forward. */
export const TASK_WORKFLOW_PHASES: readonly TaskWorkflowPhase[] = ['plan', 'build', 'review'];

export const TASK_WORKFLOW_DEFAULT_MAX_TURNS = 8;
export const TASK_WORKFLOW_MAX_TURNS = 16;
/** Two levels deep, with at most four children created per parent. Deletion does not replenish this limit. */
export const TASK_WORKFLOW_MAX_DEPTH = 2;
export const TASK_WORKFLOW_MAX_CHILDREN = 4;

export const MAX_WORKFLOW_REASON = 500;

const ACTIVE_RUN_STATES = ['queued', 'working', 'waiting'] as const;

/** A task with no workflow reads as this: stopped at the gate, default budget, no skill, revision 1. */
export const emptyTaskWorkflow = (): TaskWorkflow => ({
  revision: 1,
  phase: 'plan',
  continuation: 'stop-on-phase-change',
  inbox: false,
  parentTaskId: null,
  output: null,
  maxTurns: TASK_WORKFLOW_DEFAULT_MAX_TURNS,
  skill: null,
  pendingPhase: null,
  pendingReason: null,
  handoffs: [],
});

/**
 * The workflow a task runs under, with defaults filled. Never mutates: the
 * server persists only what a route explicitly wrote.
 */
export function workflowOf(task: Pick<Task, 'workflow'>): TaskWorkflow {
  const stored = task.workflow;
  if (!stored) return emptyTaskWorkflow();
  return {
    revision: stored.revision,
    phase: stored.phase,
    continuation: stored.continuation,
    inbox: stored.inbox,
    parentTaskId: stored.parentTaskId ?? null,
    output: stored.output ?? null,
    maxTurns: stored.maxTurns,
    skill: stored.skill ? { packId: stored.skill.packId, skillId: stored.skill.skillId } : null,
    pendingPhase: stored.pendingPhase ?? null,
    pendingReason: stored.pendingReason ?? null,
    handoffs: [...stored.handoffs],
    // A card written before manual teams carries neither field and reads exactly as before.
    ...(stored.style === 'external-proposal' ? { style: stored.style } : {}),
    ...(stored.manual === true ? { manual: true as const } : {}),
  };
}

/**
 * S1 free manual teams (2026-10-03). A manual team is the person-run Team: the project's
 * TeamService members acting outside any Agent Team root. A card one of them makes
 * (`TeamService.taskCreateAsMember`) is a manual card. It waits in the Inbox like every
 * proposed card, starts only when the person starts it, runs on its assigned member's engine
 * through Native Work (never the Diomedes work loop) and changes phase only when the person
 * moves it. Agent Team assignments (`ownedAssignment`) are never manual.
 */
export const manualTaskWorkflow = (): TaskWorkflow => ({
  ...emptyTaskWorkflow(),
  inbox: true,
  style: 'external-proposal',
  manual: true,
});

export function isManualCard(task: Pick<Task, 'workflow'>): boolean {
  return task.workflow?.manual === true;
}

/**
 * The engines a manual card starts on in S1: the person's own ChatGPT or Claude Code sign-in.
 * A model-API route would pass the Agent gate, and S1 makes no Agent gate or managed call,
 * so members on any other route are refused by name.
 */
export const MANUAL_CARD_ENGINES = ['codex', 'claude-code'] as const;
export type ManualCardEngine = (typeof MANUAL_CARD_ENGINES)[number];

export const MANUAL_CARD_LOOP_REFUSED =
  "A manual Team card runs on its member's engine when you start it, not in the work loop.";
export const MANUAL_CARD_PHASE_REFUSED = "A manual Team card's phase moves only when you move it.";
export const MANUAL_CARD_HOLD = "Start it yourself: a manual Team card doesn't start on its own";
/** What a Team member's tool is told when it tries to reassign a manual card: a model proposes, the person decides. */
export const MANUAL_CARD_ASSIGN_REFUSED =
  'Only the person assigns a manual Team card. To suggest someone else, ask them in the Team mailbox: send a message to owner.';
/** What a Team member's tool is told when it tries to remove a manual card. */
export const MANUAL_CARD_DELETE_REFUSED =
  'Only the person removes a manual Team card. If it should go, ask them in the Team mailbox: send a message to owner.';

/** Why a stopped member can't be given a card. Stopping is the Team's only removal, and a stopped member never resumes. */
export const stoppedMemberRefusal = (name: string) => `${name} was stopped and can't take work. Choose a current member.`;

export type ManualCardStart =
  | { ok: true; member: TeamMember; route: ManualCardEngine }
  | { ok: false; reason: string };

/** The member a manual card would start on, and its engine, or why it cannot start. */
export function manualCardStart(
  task: Pick<Task, 'assignedTo'>,
  members: readonly TeamMember[],
  routeName: (route: string) => string,
): ManualCardStart {
  const member = task.assignedTo ? members.find((item) => item.slotId === task.assignedTo) : undefined;
  if (!member)
    return {
      ok: false,
      reason: "Assign this card to a Team member before you start it. A manual card runs on its member's engine.",
    };
  if (member.status === 'stopped')
    return {
      ok: false,
      reason: `${member.name} was stopped and can't take work. Assign the card to a current member.`,
    };
  if (!(MANUAL_CARD_ENGINES as readonly string[]).includes(member.engine))
    return {
      ok: false,
      reason: `${member.name} works through ${routeName(member.engine)}. A manual card runs on ${MANUAL_CARD_ENGINES.map(routeName).join(' or ')}, so assign it to a member on one of those.`,
    };
  return { ok: true, member, route: member.engine as ManualCardEngine };
}

/**
 * The route a Board Start of this task sends and its send dialog names: a startable manual
 * card's member engine, otherwise `fallback` (the thread's or project's selected engine).
 */
export function boardStartRoute<R extends string>(
  task: Pick<Task, 'workflow' | 'assignedTo'>,
  members: readonly TeamMember[],
  fallback: R,
): R | ManualCardEngine {
  if (!isManualCard(task)) return fallback;
  const start = manualCardStart(task, members, (route) => route);
  return start.ok ? start.route : fallback;
}

/**
 * Why Work and loop admission must refuse this task right now, or null when
 * the workflow gates nothing. The Inbox holds tasks no one accepted; a pending
 * phase holds tasks whose agent asked to continue under Stop on phase change.
 * The reason is a sentence for the refusal, not a state machine of its own.
 */
export function taskWorkflowBlocker(task: Pick<Task, 'workflow' | 'ownedAssignment'>): string | null {
  if (task.ownedAssignment) return 'This assignment is owned by its root run. It cannot start as an independent job.';
  const workflow = task.workflow;
  if (!workflow) return null;
  if (workflow.inbox) return 'This task is in the Inbox. Accept it before starting work.';
  if (workflow.pendingPhase)
    return `This task waits for phase approval: ${workflow.pendingPhase} was asked for and is not approved yet.`;
  return null;
}

/** The phase after this one, or null past review. */
export function nextPhase(phase: TaskWorkflowPhase): TaskWorkflowPhase | null {
  const index = TASK_WORKFLOW_PHASES.indexOf(phase);
  return index < 0 || index + 1 >= TASK_WORKFLOW_PHASES.length
    ? null
    : TASK_WORKFLOW_PHASES[index + 1];
}

/** How deep this task sits under its parents: a root is 0, its child 1. */
export function taskDepth(
  tasks: readonly Pick<Task, 'id' | 'workflow'>[],
  task: Pick<Task, 'id' | 'workflow'>,
): number {
  let depth = 0;
  let current = task.workflow?.parentTaskId ?? null;
  const seen = new Set([task.id]);
  while (current) {
    if (seen.has(current)) return Number.POSITIVE_INFINITY;
    seen.add(current);
    const parent = tasks.find((item) => item.id === current);
    if (!parent) return Number.POSITIVE_INFINITY;
    depth += 1;
    current = parent.workflow?.parentTaskId ?? null;
  }
  return depth;
}

export function childCount(
  tasks: readonly Pick<Task, 'id' | 'workflow'>[],
  parentId: string,
): number {
  return tasks.filter((item) => item.workflow?.parentTaskId === parentId).length;
}

/** Why this task cannot take another child, or null when it can. */
export function childBlocker(
  tasks: readonly Pick<Task, 'id' | 'workflow'>[],
  parent: Pick<Task, 'id' | 'workflow'>,
): string | null {
  if (taskDepth(tasks, parent) >= TASK_WORKFLOW_MAX_DEPTH)
    return `This task is already ${TASK_WORKFLOW_MAX_DEPTH} levels deep. A deeper task cannot be branched.`;
  if (childCount(tasks, parent.id) >= TASK_WORKFLOW_MAX_CHILDREN)
    return `This task has used its limit of ${TASK_WORKFLOW_MAX_CHILDREN} branched tasks, including deleted tasks.`;
  return null;
}

/** Whether any run on this task has not finished: workflow edits wait for it. */
export function hasActiveRun(
  sessions: readonly { taskId: string; state: string }[],
  taskId: string,
): boolean {
  return sessions.some(
    (session) => session.taskId === taskId && (ACTIVE_RUN_STATES as readonly string[]).includes(session.state),
  );
}

export function isWorkflowPhase(value: unknown): value is TaskWorkflowPhase {
  return value === 'plan' || value === 'build' || value === 'review';
}

export function isContinuation(value: unknown): value is TaskContinuation {
  return value === 'full-approval' || value === 'stop-on-phase-change';
}

export function checkRevision(workflow: TaskWorkflow, expectedRevision: unknown): void {
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision))
    throw new WorkflowValidationError('Name the workflow revision this change is based on.');
  if (expectedRevision !== workflow.revision)
    throw new WorkflowConflictError(
      `This task changed since revision ${expectedRevision}. Read it again before changing it.`,
    );
}

export function checkReason(reason: unknown): string {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > MAX_WORKFLOW_REASON)
    throw new WorkflowValidationError(
      `Give a reason of up to ${MAX_WORKFLOW_REASON} characters.`,
    );
  return reason.trim();
}

export function checkMaxTurns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new WorkflowValidationError('A turn budget is a whole number from 1 up.');
  if (value > TASK_WORKFLOW_MAX_TURNS)
    throw new WorkflowValidationError(
      `A turn budget is at most ${TASK_WORKFLOW_MAX_TURNS} turns.`,
    );
  return value;
}

/** Appended on every applied phase move, by either path. Never rewritten. */
export function handoffRecord(options: {
  at: string;
  by: Owner;
  from: TaskWorkflowPhase;
  to: TaskWorkflowPhase;
  reason: string;
}): TaskHandoff {
  return {
    at: options.at,
    by: options.by,
    from: options.from,
    to: options.to,
    reason: options.reason,
  };
}

/** Thrown for a 400: the request is not one the workflow can admit. */
export class WorkflowValidationError extends Error {}
/** Thrown for a 409: the revision moved, a command repeats, or a limit is reached. */
export class WorkflowConflictError extends Error {}
