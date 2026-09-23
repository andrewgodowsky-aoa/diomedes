import type { Project, Session, Task } from '../../shared/types';
import type { TaskColumn } from '../workbench/task-evidence';
import type { SegmentInput, SegmentState, SegmentStep } from './segment-bar-model';

/**
 * Where a segment bar may be drawn, and from what. A bar only ever counts what
 * a record already counts (contract A9): a project's own task tally, or the
 * tasks one plan produced. No run has a known total, so there is no bar for a
 * single run, a budget or a context window here, and nothing in this module
 * invents a fraction. Pure: no React, no DOM, no clock, tested directly
 * (tests/progress-bars.test.ts), because this repository has no jsdom.
 */

/** What a project's own status record says, as a bar. Null when it has no tasks to count. */
export function projectProgress(project: Pick<Project, 'status'>): SegmentInput | null {
  const status = project.status;
  const total = status?.tasksTotal;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  return {
    total,
    done: status.tasksDone ?? 0,
    // The next task is lit as moving only while something in the project runs,
    // and it takes the needs-you colour while the project waits on the person.
    running: (status.working ?? 0) > 0,
    blocked: (status.needsYou ?? 0) > 0,
    noun: total === 1 ? 'task done' : 'tasks done',
  };
}

/**
 * One task's place in its plan, read from the same projection the Board's
 * columns render (`taskEvidence`), never from `task.state` alone: done is done,
 * a run in progress is active, a failed run is a failure, and the rest is
 * still ahead. The needs-you colour means a person is needed, so only Review
 * takes it: an open Need, or changes or a task record waiting on the person.
 * The Board's Blocked column also holds a run waiting on its engine, a task
 * with no run recorded and a stopped run, and none of those waits on anyone.
 */
export function stepState(column: TaskColumn, session: Pick<Session, 'state'> | null): SegmentState {
  if (column === 'Done') return 'done';
  if (column === 'Working') return 'active';
  if (column === 'Review') return 'blocked';
  if (column === 'Blocked' && session?.state === 'failed') return 'failed';
  return 'pending';
}

export interface PlanGroup {
  /** The plan document as the tasks recorded it. */
  plan: string;
  /** What a person reads: the plan's file name. */
  name: string;
  /** One step per task, in the plan's own order. */
  steps: SegmentStep[];
}

/** A plan document's name without its folders: `plans/Week 38.md` reads as `Week 38.md`. */
export function planName(plan: string): string {
  const parts = plan.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? plan;
}

/**
 * The Board's plan groups: tasks that share `from.plan`, ordered by the step
 * each came from. A plan with a single task is left out, because its one
 * segment would only repeat what that task's own card already says.
 */
export function planGroups(
  tasks: readonly Task[],
  evidence: (task: Task) => { column: TaskColumn; session: Pick<Session, 'state'> | null },
): PlanGroup[] {
  const byPlan = new Map<string, Task[]>();
  for (const task of tasks) {
    const plan = task.from?.plan;
    if (!plan || task.deletedAt) continue;
    const list = byPlan.get(plan);
    if (list) list.push(task);
    else byPlan.set(plan, [task]);
  }
  const groups: PlanGroup[] = [];
  for (const [plan, list] of byPlan) {
    if (list.length < 2) continue;
    const ordered = [...list].sort(
      (a, b) =>
        (a.from?.step ?? 0) - (b.from?.step ?? 0) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
    groups.push({
      plan,
      name: planName(plan),
      steps: ordered.map((task) => {
        const seen = evidence(task);
        return { label: task.name, state: stepState(seen.column, seen.session) };
      }),
    });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name) || a.plan.localeCompare(b.plan));
}
