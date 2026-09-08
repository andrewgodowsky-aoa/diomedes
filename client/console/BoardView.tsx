import { useEffect, useRef, useState } from 'react';
import type { Slot, Task, TeamMember } from '../../shared/types';
import type { BoardProps } from './types';
import './board.css';

type Column = 'Ready' | 'Working' | 'Review' | 'Blocked' | 'Done';

const ORDER: Column[] = ['Ready', 'Working', 'Review', 'Blocked', 'Done'];
const WHY: Record<Column, string> = {
  Ready: 'Start hands it to its worker',
  Working: 'a worker holds it now',
  Review: 'waits on you',
  Blocked: 'needs an answer or a route',
  Done: 'kept; Reopen to change it',
};
const EMPTY: Record<Column, string> = {
  Ready: 'Add a task in the Workbook, or make tasks from a plan.',
  Working: 'Nothing is running.',
  Review: 'Nothing waits on you.',
  Blocked: 'Nothing is blocked.',
  Done: 'Finished tasks appear here.',
};

function columnOf(task: Task): Column {
  if (task.state === 'todo') return 'Ready';
  if (task.state === 'working') return 'Working';
  if (task.state === 'done') return 'Done';
  if (task.reason === 'needs-ok' || task.reason === 'changes-ready') return 'Review';
  return 'Blocked';
}

function pointClass(column: Column): string {
  if (column === 'Working') return 'live';
  if (column === 'Review') return 'attn';
  if (column === 'Blocked') return 'fail';
  if (column === 'Done') return 'done';
  return '';
}

function ageOf(task: Task): string {
  const last = task.moves.filter((m) => !m.undone).at(-1)?.at ?? task.createdAt;
  const at = Date.parse(last);
  if (Number.isNaN(at)) return '';
  const ms = Date.now() - at;
  if (ms < 0) return 'now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins} m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d`;
  return new Date(at).toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
}

export function BoardView({
  project,
  state,
  tasks,
  policy,
  focusTaskId,
  busy,
  onStart,
  onPause,
  onReview,
  onRoute,
  onReopen,
  onOpenTeam,
  onOpenThread,
  onPolicyChange,
}: BoardProps) {
  const [compact, setCompact] = useState(true);
  const [localPolicy, setLocalPolicy] = useState(policy);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
  const prevCol = useRef(new Map<string, Column>());

  const effective = onPolicyChange ? policy : localPolicy;
  useEffect(() => {
    if (onPolicyChange) setLocalPolicy(policy);
  }, [onPolicyChange, policy]);

  // Rows that just changed column get the 180 ms arrival fade.
  useEffect(() => {
    const changed: string[] = [];
    for (const task of tasks) {
      const col = columnOf(task);
      const was = prevCol.current.get(task.id);
      if (was !== undefined && was !== col) changed.push(task.id);
      prevCol.current.set(task.id, col);
    }
    for (const id of [...prevCol.current.keys()]) {
      if (!tasks.some((t) => t.id === id)) prevCol.current.delete(id);
    }
    if (!changed.length) return;
    setArrived(new Set(changed));
    const timer = setTimeout(() => setArrived(new Set()), 300);
    return () => clearTimeout(timer);
  }, [tasks]);

  const members = state.team?.members ?? [];
  const changes = state.changes ?? [];
  const workingCount = tasks.filter((t) => columnOf(t) === 'Working').length;
  const slotBusy = workingCount > 0;

  function pickPolicy(next: 'first' | 'go') {
    setLocalPolicy(next);
    if (onPolicyChange) onPolicyChange(next);
  }

  function closeInline() {
    setConfirmId(null);
    setRouteId(null);
  }

  return (
    <div className="board" aria-label="Board">
      <div className="bhead">
        <h1>Board</h1>
        <span className="mono ctx">
          {project.name} · {tasks.length} tasks
        </span>
        <button
          type="button"
          className={`mono link${compact ? ' on' : ''}`}
          aria-pressed={compact}
          title="Compact rows: title, worker and age on one line"
          onClick={() => setCompact(!compact)}
        >
          compact
        </button>
        <div className="seg" role="radiogroup" aria-label="Board policy">
          <button
            type="button"
            role="radio"
            aria-checked={effective === 'first'}
            className={effective === 'first' ? 'on' : ''}
            onClick={() => pickPolicy('first')}
          >
            Show me first
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={effective === 'go'}
            className={effective === 'go' ? 'on' : ''}
            onClick={() => pickPolicy('go')}
          >
            Go ahead for tasks
          </button>
        </div>
      </div>
      <div className={`columns${compact ? ' compact' : ''}`}>
        {ORDER.map((column) => {
          const rows = tasks.filter((t) => columnOf(t) === column);
          const count =
            column === 'Working' ? `${rows.length} of 1 slot` : String(rows.length);
          const amber = (column === 'Review' || column === 'Blocked') && rows.length > 0;
          return (
            <div className="column" key={column} aria-label={column}>
              <h3>
                {column}
                <span className={`mono${amber ? ' attn' : ''}`}>{count}</span>
              </h3>
              <div className="why">{WHY[column]}</div>
              <ul>
                {rows.length === 0 && <li className="empty">{EMPTY[column]}</li>}
                {rows.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    column={column}
                    worker={workerOf(task)}
                    workerTitle={workerTitleOf(task)}
                    age={ageOf(task)}
                    focus={task.id === focusTaskId}
                    arrived={arrived.has(task.id)}
                    busy={busy}
                    slotBusy={slotBusy}
                    policy={effective}
                    members={members}
                    reviewCount={
                      column === 'Review' && task.reason !== 'needs-ok'
                        ? changes.filter((c) => c.state === 'waiting' && task.changeIds.includes(c.id)).length
                        : 0
                    }
                    confirmOpen={confirmId === task.id}
                    routeOpen={routeId === task.id}
                    onToggleConfirm={() =>
                      setConfirmId(confirmId === task.id ? null : task.id)
                    }
                    onToggleRoute={() => setRouteId(routeId === task.id ? null : task.id)}
                    onCloseInline={closeInline}
                    onStart={onStart}
                    onPause={onPause}
                    onReview={onReview}
                    onRoute={onRoute}
                    onReopen={onReopen}
                    onOpenTeam={onOpenTeam}
                    onOpenThread={onOpenThread}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );

  function workerOf(task: Task): string {
    const running = state.sessions.find(
      (s) => s.taskId === task.id && ['queued', 'working', 'waiting'].includes(s.state),
    );
    if (running) return running.engine.name;
    const member = members.find((m) => m.slotId === task.assignedTo);
    if (member) return member.name;
    return task.owner === 'you' ? 'You' : 'Diomedes';
  }

  function workerTitleOf(task: Task): string | undefined {
    const running = state.sessions.find(
      (s) => s.taskId === task.id && ['queued', 'working', 'waiting'].includes(s.state),
    );
    if (running) return running.engine.model ? `${running.engine.name} ${running.engine.model}` : running.engine.name;
    const member = members.find((m) => m.slotId === task.assignedTo);
    if (member) return member.model ? `${member.name} ${member.model}` : member.name;
    return undefined;
  }
}

function TaskRow({
  task,
  column,
  worker,
  workerTitle,
  age,
  focus,
  arrived,
  busy,
  slotBusy,
  policy,
  members,
  reviewCount,
  confirmOpen,
  routeOpen,
  onToggleConfirm,
  onToggleRoute,
  onCloseInline,
  onStart,
  onPause,
  onReview,
  onRoute,
  onReopen,
  onOpenTeam,
  onOpenThread,
}: {
  task: Task;
  column: Column;
  worker: string;
  workerTitle: string | undefined;
  age: string;
  focus: boolean;
  arrived: boolean;
  busy: boolean;
  slotBusy: boolean;
  policy: 'first' | 'go';
  members: TeamMember[];
  reviewCount: number;
  confirmOpen: boolean;
  routeOpen: boolean;
  onToggleConfirm(): void;
  onToggleRoute(): void;
  onCloseInline(): void;
  onStart(task: Task): Promise<void>;
  onPause(task: Task): Promise<void>;
  onReview(task: Task): void;
  onRoute(task: Task, to: Slot): Promise<void>;
  onReopen(task: Task): Promise<void>;
  onOpenTeam(task: Task): void;
  onOpenThread(task: Task): void;
}) {
  const blockedReason =
    column === 'Blocked'
      ? task.reason === 'went-wrong'
        ? 'something went wrong'
        : 'waiting'
      : null;
  const reviewLine =
    column === 'Review'
      ? task.reason === 'needs-ok'
        ? 'needs your OK'
        : `proposal, ${reviewCount} files`
      : null;
  const startBlocked = column === 'Ready' && slotBusy;

  function onKeyClose(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onCloseInline();
  }

  return (
    <li className={`crow${arrived ? ' arrived' : ''}`} onKeyDown={onKeyClose}>
      <span
        className={`pt ${pointClass(column)}`}
        data-task-point={task.id}
        {...(focus ? { 'data-focus-point': '' } : {})}
      />
      <button type="button" className="t" title={task.name} onClick={() => onOpenThread(task)}>
        {task.name}
      </button>
      <div className="m">
        <span className="mono" title={workerTitle}>
          {worker}
        </span>
        <span className="mono age">{age}</span>
      </div>
      {(blockedReason ?? reviewLine ?? focus) && (
        <div className="x">
          {blockedReason && <span className="mono why">{blockedReason}</span>}
          {reviewLine && (
            <span className={`mono${task.reason === 'needs-ok' ? ' why' : ''}`}>{reviewLine}</span>
          )}
          {focus && <span className="mono here">this thread</span>}
        </div>
      )}
      {column === 'Working' && (
        <div className="prog" aria-hidden="true">
          <span className="run" />
        </div>
      )}
      <span className="acts">
        {column === 'Ready' && (
          <button
            type="button"
            className="verb light"
            disabled={busy || startBlocked}
            title={startBlocked ? 'One run at a time in this version' : undefined}
            onClick={() => {
              if (policy === 'go') {
                void onStart(task);
                return;
              }
              onToggleConfirm();
            }}
          >
            Start
          </button>
        )}
        {column === 'Working' && (
          <>
            <button type="button" className="verb" disabled={busy} onClick={() => void onPause(task)}>
              Pause
            </button>
            <button type="button" className="teamlink" onClick={() => onOpenTeam(task)}>
              Team
            </button>
          </>
        )}
        {column === 'Review' && (
          <button type="button" className="verb" onClick={() => onReview(task)}>
            Review
          </button>
        )}
        {column === 'Blocked' && (
          <button type="button" className="verb" onClick={onToggleRoute}>
            Route to
          </button>
        )}
        {column === 'Done' && (
          <button type="button" className="verb" disabled={busy} onClick={() => void onReopen(task)}>
            Reopen
          </button>
        )}
      </span>
      {column === 'Ready' && confirmOpen && (
        <div className="confirm">
          <span>Hand to {worker}?</span>
          <button type="button" className="go" disabled={busy || startBlocked} onClick={() => void onStart(task)}>
            Start
          </button>
          <button type="button" onClick={onToggleConfirm}>
            Not now
          </button>
        </div>
      )}
      {column === 'Blocked' && routeOpen && (
        <div className="route" role="list">
          {members.length === 0 && (
            <button type="button" disabled={busy} onClick={() => void onStart(task)}>
              Retry
            </button>
          )}
          {members.map((m) => (
            <button key={m.slotId} type="button" role="listitem" disabled={busy} onClick={() => void onRoute(task, m.slotId)}>
              <span>{m.name}</span>
              <span className="mono">{m.engine}</span>
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
