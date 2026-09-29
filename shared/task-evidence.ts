import type { Change, Need, Session, Task } from './types.js';

export type TaskColumn = 'Inbox' | 'Ready' | 'Queued' | 'Working' | 'Review' | 'Blocked' | 'Done';

/**
 * Whether a task waits on the person, and why. `review`: every Review task, a
 * decision or a result only the person can accept. `failed`: a Blocked task
 * whose run failed or went wrong, to look at before it is retried. Null for
 * everything else, including a run waiting on its engine and a task record
 * with no run behind it: those wait on no one (`shared/needs-you.ts`).
 */
export type TaskWait = 'review' | 'failed' | null;

export interface TaskEvidence {
  column: TaskColumn;
  session: Session | null;
  detail: string;
  active: boolean;
  wait: TaskWait;
}

export const isActiveSession = (session: Session): boolean =>
  ['queued', 'working', 'waiting'].includes(session.state);

/**
 * A projection only: task organization never admits or starts execution. It
 * lives in `shared/` so the server's needs-you count and the Board read one
 * answer (`client/workbench/task-evidence.ts` re-exports it).
 */
export function taskEvidence(
  task: Task,
  sessions: readonly Session[],
  needs: readonly Need[] = [],
  changes: readonly Change[] = [],
): TaskEvidence {
  const linked = sessions
    .filter((session) => session.taskId === task.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  const active = linked.find(isActiveSession) ?? null;
  const session = active ?? linked[0] ?? null;
  const openNeed = needs.some((need) => need.taskId === task.id && need.state === 'open');
  const pendingChanges = changes.some(
    (change) => change.taskId === task.id && change.state === 'waiting',
  );
  const result = (column: TaskColumn, detail: string): TaskEvidence => ({
    column,
    detail,
    session,
    active: active !== null,
    wait:
      column === 'Review'
        ? 'review'
        : column === 'Blocked' && (session?.state === 'failed' || task.reason === 'went-wrong')
          ? 'failed'
          : null,
  });

  if (active?.state === 'queued') return result('Queued', 'Waiting to start');
  if (active?.state === 'working') return result('Working', 'Run in progress');
  if (task.workflow?.inbox) return result('Inbox', 'Accept this proposed task before it can run');
  if (task.workflow?.pendingPhase) return result('Review', 'Approve the next phase to continue');
  if (openNeed) return result('Review', 'Needs your decision');
  if (active?.state === 'waiting') {
    if (pendingChanges || task.reason === 'changes-ready')
      return result('Review', 'Changes to review');
    return result(
      'Blocked',
      task.reason === 'went-wrong' ? 'Check the run before retrying' : 'Run is waiting',
    );
  }
  if (pendingChanges) return result('Review', 'Changes to review');
  const move = task.moves.filter((item) => !item.undone).at(-1);
  if (task.state === 'done') {
    if (
      move?.to === 'done' &&
      move.by === 'you' &&
      (!session?.endedAt || move.at >= session.endedAt)
    )
      return result('Done', 'Marked done by you');
    return result('Done', session?.state === 'done' ? 'Run finished' : 'Marked done');
  }
  const reopened =
    task.state === 'todo' &&
    move?.to === 'todo' &&
    move.by === 'you' &&
    (!session || move.at >= (session.endedAt ?? session.startedAt));
  if (!reopened) {
    if (session?.state === 'done') return result('Done', 'Run finished');
    if (session?.state === 'failed') return result('Blocked', 'Run failed');
    if (session?.state === 'stopped') {
      if (task.reason === 'went-wrong')
        return result('Blocked', 'Stopped; check the run before retrying');
      return result('Ready', 'Stopped; Start begins new work');
    }
  }
  if (task.state === 'working') return result('Blocked', 'No active run recorded');
  if (task.state === 'waiting') {
    if (task.reason === 'needs-ok' || task.reason === 'changes-ready')
      return result('Review', 'Review the task record');
    return result('Blocked', session?.state === 'failed' ? 'Run failed' : 'Check the task record');
  }
  return result(
    'Ready',
    session?.state === 'stopped' ? 'Stopped; Start begins new work' : 'Start explicitly to run',
  );
}
