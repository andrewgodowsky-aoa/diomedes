import type { Task, TaskState } from '../../shared/types';
import type { BoardProps } from './types';

const GROUPS: TaskState[] = ['todo', 'working', 'waiting', 'done'];
const GROUP_NAMES: Record<TaskState, string> = {
  todo: 'Ready',
  working: 'Working',
  waiting: 'Review',
  done: 'Done',
};

/**
 * Placeholder board: a plain list grouped by the four task states with the
 * verbs wired to the Shell callbacks. The full executable board arrives in a
 * later pass; this keeps every route live behind the placeholder.
 */
export function BoardView({
  tasks,
  policy,
  focusTaskId,
  busy,
  onStart,
  onPause,
  onReview,
  onReopen,
  onOpenTeam,
  onOpenThread,
}: BoardProps) {
  return (
    <div className="col board-placeholder" aria-label="Board">
      <p className="caption">
        Board policy: {policy === 'go' ? 'Go ahead for tasks' : 'Show me first'}. The full
        executable board arrives in the next pass.
      </p>
      {GROUPS.map((state) => (
        <section key={state} aria-label={GROUP_NAMES[state]}>
          <h3>
            {GROUP_NAMES[state]} ({tasks.filter((t) => t.state === state).length})
          </h3>
          {tasks
            .filter((t) => t.state === state)
            .map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                focus={task.id === focusTaskId}
                busy={busy}
                onStart={onStart}
                onPause={onPause}
                onReview={onReview}
                onReopen={onReopen}
                onOpenTeam={onOpenTeam}
                onOpenThread={onOpenThread}
              />
            ))}
        </section>
      ))}
    </div>
  );
}

function TaskRow({
  task,
  focus,
  busy,
  onStart,
  onPause,
  onReview,
  onReopen,
  onOpenTeam,
  onOpenThread,
}: {
  task: Task;
  focus: boolean;
  busy: boolean;
  onStart(t: Task): Promise<void>;
  onPause(t: Task): Promise<void>;
  onReview(t: Task): void;
  onReopen(t: Task): Promise<void>;
  onOpenTeam(t: Task): void;
  onOpenThread(t: Task): void;
}) {
  return (
    <div className="board-row">
      <span>
        {task.name}
        {focus ? ' (this thread)' : ''}
      </span>
      <span className="actions">
        {task.state === 'todo' && (
          <button type="button" disabled={busy} onClick={() => void onStart(task)}>
            Start
          </button>
        )}
        {task.state === 'working' && (
          <button type="button" disabled={busy} onClick={() => void onPause(task)}>
            Stop
          </button>
        )}
        {task.state === 'waiting' && (
          <>
            <button type="button" onClick={() => onReview(task)}>
              Go ahead
            </button>
            <button type="button" onClick={() => onReview(task)}>
              Look at changes
            </button>
          </>
        )}
        {task.state === 'done' && (
          <button type="button" disabled={busy} onClick={() => void onReopen(task)}>
            Reopen
          </button>
        )}
        <button type="button" onClick={() => onOpenThread(task)}>
          Thread
        </button>
        <button type="button" onClick={() => onOpenTeam(task)}>
          Team
        </button>
      </span>
    </div>
  );
}
