import { useEffect, useRef, useState } from 'react';
import type { Slot, Task, TeamMember } from '../../shared/types';
import { formatOrigin, originForSession } from '../../shared/attribution';
import type { BoardProps } from './types';
import { travel } from './motion';
import {
  isActiveSession,
  taskEvidence,
  type TaskColumn as Column,
} from '../workbench/task-evidence';
import './board.css';

const ORDER: Column[] = ['Ready', 'Queued', 'Working', 'Review', 'Blocked', 'Done'];
const WHY: Record<Column, string> = {
  Ready: 'Start explicitly to run',
  Queued: 'Admitted; waiting to start',
  Working: 'A run is in progress',
  Review: 'waits on you',
  Blocked: 'needs an answer or a route',
  Done: 'Completion evidence stays in the thread',
};
const EMPTY: Record<Column, string> = {
  Ready: 'Make tasks from a plan.',
  Queued: 'Nothing is queued.',
  Working: 'Nothing is running.',
  Review: 'Nothing waits on you.',
  Blocked: 'Nothing is blocked.',
  Done: 'Finished tasks appear here.',
};

function selForTask(taskId: string): string {
  try {
    const esc = (CSS as unknown as { escape?: (value: string) => string }).escape;
    if (typeof esc === 'function') return `[data-task-point="${esc(taskId)}"]`;
  } catch {
    // Fall through to the raw id; the query simply misses.
  }
  return `[data-task-point="${taskId}"]`;
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
  const evidenceOf = (task: Task) => taskEvidence(task, state.sessions, state.needs, state.changes);
  const columnOf = (task: Task): Column => evidenceOf(task).column;
  const [compact, setCompact] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
  const prevCol = useRef(new Map<string, Column>());
  // The row's point rect and column before a board action. After the Shell's
  // handler resolves and the row has re-rendered in its new column, the point
  // travels to it; the `arrived` fade above still plays. If the row never
  // left its column (a failed or approval-gated start), no trip runs: motion
  // only explains movement that happened.
  const pendingTravel = useRef<{
    id: string;
    from: { x: number; y: number };
    kind: string;
    ms: number;
    column: Column;
  } | null>(null);

  // The thread's permission owns board policy. The board never keeps its own
  // override: when Shell passes no callback it shows the prop read-only.
  const effective = policy;
  const controlled = typeof onPolicyChange === 'function';

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
  }, [tasks, state.sessions, state.needs, state.changes]);

  // A board action resolved above: fly the remembered point to the row's new
  // home, but only when the row actually changed column. Start 280 ms,
  // Route to 420 ms (the one board handoff), Review 220 ms.
  useEffect(() => {
    const p = pendingTravel.current;
    if (!p) return;
    pendingTravel.current = null;
    const task = tasks.find((t) => t.id === p.id);
    if (!task || columnOf(task) === p.column) return;
    const sel = selForTask(p.id);
    requestAnimationFrame(() => {
      try {
        const to = document.querySelector(sel);
        if (!to) return;
        travel(p.from, to, p.kind, p.ms);
      } catch {
        // Motion never breaks the board.
      }
    });
  }, [tasks, state.sessions, state.needs, state.changes]);

  const members = state.team?.members ?? [];
  const changes = state.changes ?? [];
  const slotBusy = state.sessions.some(isActiveSession);

  function pickPolicy(next: 'first' | 'go') {
    if (onPolicyChange) onPolicyChange(next);
  }

  function noteTravel(task: Task, kind: string, ms: number) {
    try {
      const el = document.querySelector(selForTask(task.id));
      if (!el) {
        pendingTravel.current = null;
        return;
      }
      const r = el.getBoundingClientRect();
      pendingTravel.current = {
        id: task.id,
        from: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        kind,
        ms,
        column: columnOf(task),
      };
    } catch {
      pendingTravel.current = null;
    }
  }

  async function handleStart(task: Task): Promise<void> {
    noteTravel(task, 'start', 280);
    await onStart(task);
  }
  async function handleRoute(task: Task, to: Slot): Promise<void> {
    noteTravel(task, 'route', 420);
    await onRoute(task, to);
  }
  function handleReview(task: Task): void {
    noteTravel(task, 'review', 220);
    onReview(task);
  }

  function closeInline() {
    setConfirmId(null);
    setRouteId(null);
  }

  return (
    <div className="board" aria-label="Board">
      <div className="bhead">
        <h1>Board</h1>
        <span className="mono">
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
        {controlled ? (
          <div className="seg" role="radiogroup" aria-label="Start confirmation">
            <button
              type="button"
              role="radio"
              aria-checked={effective === 'first'}
              className={effective === 'first' ? 'on' : ''}
              onClick={() => pickPolicy('first')}
            >
              Confirm each start
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={effective === 'go'}
              className={effective === 'go' ? 'on' : ''}
              onClick={() => pickPolicy('go')}
            >
              Start on click
            </button>
          </div>
        ) : (
          <span className="ctx" data-board-policy={effective} aria-label="Start confirmation">
            {effective === 'first' ? 'Confirm each start' : 'Start on click'}
          </span>
        )}
      </div>
      <div className={`columns${compact ? ' compact' : ''}`}>
        {ORDER.map((column) => {
          const rows = tasks.filter((t) => columnOf(t) === column);
          const count = column === 'Working' ? `${rows.length} of 1 slot` : String(rows.length);
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
                    evidence={evidenceOf(task)}
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
                        ? changes.filter(
                            (c) => c.state === 'waiting' && task.changeIds.includes(c.id),
                          ).length
                        : 0
                    }
                    confirmOpen={confirmId === task.id}
                    routeOpen={routeId === task.id}
                    onToggleConfirm={() => setConfirmId(confirmId === task.id ? null : task.id)}
                    onToggleRoute={() => setRouteId(routeId === task.id ? null : task.id)}
                    onCloseInline={closeInline}
                    onStart={handleStart}
                    onPause={onPause}
                    onReview={handleReview}
                    onRoute={handleRoute}
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
    const session = evidenceOf(task).session;
    if (session) return formatOrigin(originForSession(session)).primary;
    const member = members.find((m) => m.slotId === task.assignedTo);
    if (member) return member.name;
    return task.owner === 'you' ? 'You' : 'Unassigned';
  }

  function workerTitleOf(task: Task): string | undefined {
    const session = evidenceOf(task).session;
    if (session) return formatOrigin(originForSession(session)).label;
    const member = members.find((m) => m.slotId === task.assignedTo);
    if (member) return member.model ? `${member.name} ${member.model}` : member.name;
    return undefined;
  }
}

function TaskRow({
  task,
  column,
  evidence,
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
  evidence: ReturnType<typeof taskEvidence>;
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
  // Working owns the column for its progress bar, and Ready repeats the
  // column caption unless the row has a distinct reason (a stopped run).
  const evidenceLine =
    column === 'Working' || (column === 'Ready' && evidence.detail === WHY.Ready)
      ? null
      : evidence.detail;
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
      {(evidenceLine || focus) && (
        <div className="x">
          {evidenceLine && <span className="why">{evidenceLine}</span>}
          {column === 'Review' && reviewCount > 0 && <span>{reviewCount} files</span>}
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
        {evidence.active && (
          <>
            <button
              type="button"
              className="verb"
              disabled={busy}
              onClick={() => void onPause(task)}
            >
              Stop
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
        {column === 'Blocked' && !evidence.active && (
          <button type="button" className="verb" onClick={onToggleRoute}>
            Route to
          </button>
        )}
        {column === 'Done' && (
          <button
            type="button"
            className="verb"
            disabled={busy}
            onClick={() => void onReopen(task)}
          >
            Reopen
          </button>
        )}
      </span>
      {column === 'Ready' && confirmOpen && (
        <div className="confirm">
          <span>Hand to {worker}?</span>
          <button
            type="button"
            className="go"
            disabled={busy || startBlocked}
            onClick={() => void onStart(task)}
          >
            Start
          </button>
          <button type="button" onClick={onToggleConfirm}>
            Not now
          </button>
        </div>
      )}
      {column === 'Blocked' && !evidence.active && routeOpen && (
        <div className="route" role="list">
          {members.length === 0 && (
            <button type="button" disabled={busy || slotBusy} onClick={() => void onStart(task)}>
              Retry
            </button>
          )}
          {members.map((m) => (
            <button
              key={m.slotId}
              type="button"
              role="listitem"
              disabled={busy || slotBusy}
              onClick={() => void onRoute(task, m.slotId)}
            >
              <span>{m.name}</span>
              <span className="mono">{m.engine}</span>
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
