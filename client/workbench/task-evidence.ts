import type { Change, Need, Session, Task } from '../../shared/types';

export type TaskColumn = 'Ready' | 'Queued' | 'Working' | 'Review' | 'Blocked' | 'Done';

export const isActiveSession = (session: Session): boolean =>
  ['queued', 'working', 'waiting'].includes(session.state);

/** A projection only: task organization never admits or starts execution. */
export function taskEvidence(
  task: Task,
  sessions: readonly Session[],
  needs: readonly Need[] = [],
  changes: readonly Change[] = [],
): { column: TaskColumn; session: Session | null; detail: string; active: boolean } {
  const linked = sessions
    .filter((session) => session.taskId === task.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  const active = linked.find(isActiveSession) ?? null;
  const session = active ?? linked[0] ?? null;
  const openNeed = needs.some((need) => need.taskId === task.id && need.state === 'open');
  const pendingChanges = changes.some(
    (change) => change.taskId === task.id && change.state === 'waiting',
  );
  const result = (column: TaskColumn, detail: string) => ({
    column,
    detail,
    session,
    active: active !== null,
  });

  if (active?.state === 'queued') return result('Queued', 'Waiting to start');
  if (active?.state === 'working') return result('Working', 'Run in progress');
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
