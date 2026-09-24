import { useEffect, useRef, useState } from 'react';
import { pendingTaskCreation } from '../task-create';
import type { HistoryEntry, Slot, Task, TeamMember } from '../../shared/types';
import { formatOrigin, originForSession } from '../attribution-display';
import type { BoardProps } from './types';
import { travel } from './motion';
import {
  isActiveSession,
  taskEvidence,
  type TaskColumn as Column,
} from '../workbench/task-evidence';
import './board.css';
import { TaskDocumentSelect } from './TaskDocumentSelect';
import { SegmentBar } from './SegmentBar';
import { planGroups } from './progress-bars';
import { VerificationBadge, verificationFor } from './Verification';
import { taskDocumentProblem } from '../../shared/task-sources';
import type { ReadyItem, ReadyQueueView } from '../../shared/ready-queue';
import {
  configureReadyQueue,
  pauseAllReadyQueues,
  queueStatus,
  readReadyQueue,
} from '../ready-queue';

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
  Ready: 'Nothing is ready. New task adds one.',
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
  documents,
  documentsLoading,
  documentsFailure,
  onStart,
  onPause,
  onReview,
  onRoute,
  onReopen,
  onOpenTeam,
  onOpenThread,
  onCreateTask,
  onPolicyChange,
}: BoardProps) {
  const evidenceOf = (task: Task) => taskEvidence(task, state.sessions, state.needs, state.changes);
  const columnOf = (task: Task): Column => evidenceOf(task).column;
  const [compact, setCompact] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newDocument, setNewDocument] = useState('');
  const [retryingCreate, setRetryingCreate] = useState(false);
  const [creationIssue, setCreationIssue] = useState('');
  function restoreCreation() {
    try {
      const pending = pendingTaskCreation(project.id);
      setCreationIssue('');
      setRetryingCreate(!!pending);
      if (pending) {
        setNewName(pending.name);
        setNewDescription(pending.description);
        // The saved request names one exact document or none; the retry sends that.
        setNewDocument(pending.sourceDocument ?? '');
        setCreating(true);
      }
    } catch (error) {
      setCreationIssue(
        error instanceof Error ? error.message : 'The saved task request could not be checked.',
      );
    }
  }
  useEffect(() => {
    setCreating(false);
    setNewName('');
    setNewDescription('');
    setNewDocument('');
    restoreCreation();
  }, [project.id]);
  const invalidDocument = !!newDocument && (
    documentsLoading || !!documentsFailure || !!taskDocumentProblem(newDocument, documents)
  );
  // A retry re-sends the saved request as it is; the server answers with the replayed
  // task or with the reason the document no longer qualifies.
  const blockedDocument = invalidDocument && !retryingCreate;
  // `busy` only turns true after the Shell's state settles, so a second click
  // can arrive before the first render. The ref refuses it in the same tick.
  const sending = useRef(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // The Ready queue as the local service derives it from the records (H07). Read again whenever
  // the project's records change, and after each queue control.
  const [queue, setQueue] = useState<ReadyQueueView | null>(null);
  const [queueIssue, setQueueIssue] = useState('');
  const [pausing, setPausing] = useState<'project' | 'all' | null>(null);
  const [pauseReason, setPauseReason] = useState('');
  const [queueBusy, setQueueBusy] = useState(false);
  const queueRead = useRef(0);
  async function refreshQueue(signal?: AbortSignal) {
    const read = ++queueRead.current;
    try {
      const next = await readReadyQueue(project.id, signal);
      if (read === queueRead.current && next.projectId === project.id) setQueue(next);
    } catch (error) {
      if (signal?.aborted) return;
      if (read === queueRead.current)
        setQueueIssue(error instanceof Error ? error.message : 'The Ready queue could not be read.');
    }
  }
  useEffect(() => {
    const control = new AbortController();
    void refreshQueue(control.signal);
    return () => control.abort();
  }, [project.id, state]);
  useEffect(() => {
    setQueue(null);
    setPausing(null);
    setPauseReason('');
    setQueueIssue('');
  }, [project.id]);
  async function changeQueue(action: () => Promise<unknown>) {
    if (queueBusy) return;
    setQueueBusy(true);
    setQueueIssue('');
    try {
      await action();
      setPausing(null);
      setPauseReason('');
    } catch (error) {
      setQueueIssue(error instanceof Error ? error.message : 'The Ready queue could not be changed.');
    } finally {
      setQueueBusy(false);
      await refreshQueue();
    }
  }
  const queueItems = new Map<string, ReadyItem>(
    queue?.autoStart ? queue.items.map((item) => [item.taskId, item]) : [],
  );
  const readyWhy = !queue?.autoStart
    ? WHY.Ready
    : queue.allPaused || queue.paused
      ? 'Queue paused · Start runs one by hand'
      : 'Starts automatically, oldest first';
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
  // Tasks one plan produced, counted from the same projection the columns show.
  const plans = planGroups(tasks, evidenceOf);

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

  function closeNew() {
    setCreating(false);
    setNewName('');
    setNewDescription('');
    setNewDocument('');
  }

  // One control, one path: the same `POST /tasks` the plan import already uses.
  // A created task has no run, so `taskEvidence` projects it into Ready, and the
  // row's own Start is the next action.
  async function submitNew(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || sending.current || blockedDocument) return;
    sending.current = true;
    try {
      await onCreateTask({
        name,
        description: retryingCreate ? newDescription : newDescription.trim(),
        ...(newDocument ? { sourceDocument: newDocument } : {}),
      });
      closeNew();
    } catch {
      // The Shell reported it. Keep the words the person typed.
      restoreCreation();
    } finally {
      sending.current = false;
    }
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
          className="verb light new"
          aria-expanded={creating}
          disabled={busy}
          onClick={() => {
            if (creating) closeNew();
            else {
              setCreating(true);
              restoreCreation();
            }
          }}
        >
          New task
        </button>
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
        {queue && (
          <div className="queue" aria-label="Ready queue">
            <label className="auto">
              <input
                type="checkbox"
                role="switch"
                checked={queue.autoStart}
                disabled={queueBusy}
                onChange={(event) => {
                  const autoStart = event.target.checked;
                  void changeQueue(() => configureReadyQueue(project.id, { autoStart }));
                }}
              />
              Start ready work automatically
            </label>
            <span
              className={`ctx state${queue.paused || queue.allPaused ? ' attn' : ''}`}
              data-queue-state={
                queue.allPaused ? 'all-paused' : queue.paused ? 'paused' : queue.autoStart ? 'on' : 'off'
              }
            >
              {queueStatus(queue)}
            </span>
            {queue.paused ? (
              <button
                type="button"
                className="verb"
                disabled={queueBusy}
                onClick={() => void changeQueue(() => configureReadyQueue(project.id, { paused: false }))}
              >
                Resume queue
              </button>
            ) : (
              <button
                type="button"
                className="verb"
                disabled={queueBusy}
                aria-expanded={pausing === 'project'}
                onClick={() => setPausing(pausing === 'project' ? null : 'project')}
              >
                Pause queue
              </button>
            )}
            {queue.allPaused ? (
              <button
                type="button"
                className="verb"
                disabled={queueBusy}
                onClick={() => void changeQueue(() => pauseAllReadyQueues(false))}
              >
                Resume all
              </button>
            ) : (
              <button
                type="button"
                className="verb quiet"
                disabled={queueBusy}
                aria-expanded={pausing === 'all'}
                onClick={() => setPausing(pausing === 'all' ? null : 'all')}
              >
                Pause all
              </button>
            )}
            {pausing && (
              <form
                className="pause"
                aria-label={pausing === 'all' ? 'Pause every queue' : 'Pause this queue'}
                onSubmit={(event) => {
                  event.preventDefault();
                  const reason = pauseReason.trim() || undefined;
                  void changeQueue(() =>
                    pausing === 'all'
                      ? pauseAllReadyQueues(true, reason)
                      : configureReadyQueue(project.id, { paused: true, ...(reason ? { reason } : {}) }),
                  );
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setPausing(null);
                }}
              >
                <input
                  aria-label="Reason"
                  placeholder="Reason (optional)"
                  maxLength={200}
                  value={pauseReason}
                  onChange={(event) => setPauseReason(event.target.value)}
                />
                <button type="submit" className="go" disabled={queueBusy}>
                  {pausing === 'all' ? 'Pause all queues' : 'Pause'}
                </button>
                <span className="mono">Running work keeps running; Stop ends it.</span>
              </form>
            )}
          </div>
        )}
        {queueIssue && (
          <p className="creation-issue" role="alert">
            {queueIssue}
          </p>
        )}
        {creationIssue && (
          <p className="creation-issue" role="alert">
            {creationIssue}
          </p>
        )}
        {creating && (
          <form
            className="newtask"
            aria-label="New task"
            onSubmit={(event) => void submitNew(event)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeNew();
            }}
          >
            <input
              autoFocus
              type="text"
              aria-label="Task name"
              placeholder="Task name"
              maxLength={200}
              value={newName}
              readOnly={busy || retryingCreate}
              onChange={(event) => setNewName(event.target.value)}
            />
            <input
              type="text"
              aria-label="What should happen (optional)"
              placeholder="What should happen (optional)"
              maxLength={10_000}
              value={newDescription}
              readOnly={busy || retryingCreate}
              onChange={(event) => setNewDescription(event.target.value)}
            />
            <TaskDocumentSelect
              documents={documents}
              loading={documentsLoading}
              failure={documentsFailure}
              value={newDocument}
              onChange={setNewDocument}
              disabled={busy || retryingCreate}
            />
            <button
              type="submit"
              className="go"
              disabled={busy || !!creationIssue || !newName.trim() || blockedDocument}
            >
              {retryingCreate ? 'Retry create' : 'Create'}
            </button>
            <button type="button" onClick={closeNew}>
              Not now
            </button>
          </form>
        )}
        {plans.length > 0 && (
          <ul className="plans" aria-label="Plans on this board">
            {plans.map((group) => (
              <li className="plan" key={group.plan}>
                <span className="plan-name" title={group.plan}>
                  {group.name}
                </span>
                <SegmentBar
                  steps={group.steps}
                  label={`Tasks from ${group.name}`}
                  noun="tasks done"
                  size="panel"
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={`columns${compact ? ' compact' : ''}`}>
        {ORDER.map((column) => {
          const listed = tasks.filter((t) => columnOf(t) === column);
          // With automatic start on, Ready reads in the queue's own order; held tasks last.
          const place = (task: Task) => queueItems.get(task.id)?.position ?? Number.MAX_SAFE_INTEGER;
          const rows =
            column === 'Ready' && queueItems.size
              ? [...listed].sort((a, b) => place(a) - place(b))
              : listed;
          const count = column === 'Working' ? `${rows.length} of 1 slot` : String(rows.length);
          const amber = (column === 'Review' || column === 'Blocked') && rows.length > 0;
          return (
            <div className="column" key={column} aria-label={column}>
              <h3>
                {column}
                <span className={`mono${amber ? ' attn' : ''}`}>{count}</span>
              </h3>
              <div className="why">{column === 'Ready' ? readyWhy : WHY[column]}</div>
              <ul>
                {rows.length === 0 && <li className="empty">{EMPTY[column]}</li>}
                {rows.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    column={column}
                    evidence={evidenceOf(task)}
                    history={state.history}
                    queued={column === 'Ready' ? (queueItems.get(task.id) ?? null) : null}
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
  history,
  queued,
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
  /** H17: the project's History, from which a finished run's result is projected. */
  history: readonly HistoryEntry[];
  /** Where this Ready task stands in the queue, when automatic start is on. */
  queued: ReadyItem | null;
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
  // Working owns the column for its running bar, and Ready repeats the
  // column caption unless the row has a distinct reason (a stopped run).
  // With automatic start on, a Ready row says its place and the one reason it is not starting.
  const evidenceLine = queued
    ? queued.detail
    : column === 'Working' || (column === 'Ready' && evidence.detail === WHY.Ready)
      ? null
      : evidence.detail;
  // The fault sentence says "Start again to request a new proposal", so the row
  // that carries the fault offers exactly that, through the same admission the
  // Ready column uses. A stopped or unrecorded run is a different state and is
  // not restarted from here.
  const failed = !evidence.active && evidence.session?.state === 'failed';
  // H17: a finished run's four-state result sits with the row's own words, "Not verified" included.
  const verification = evidence.active ? null : verificationFor(evidence.session, task, history);
  const canStart = column === 'Ready' || (column === 'Blocked' && failed);
  const startLabel = column === 'Ready' ? 'Start' : 'Start again';
  const startBlocked = canStart && slotBusy;
  const canRoute = column === 'Blocked' && !evidence.active && members.length > 0;

  function onKeyClose(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onCloseInline();
  }

  return (
    <li
      className={`crow${arrived ? ' arrived' : ''}`}
      onKeyDown={onKeyClose}
      {...(queued ? { 'data-queue-why': queued.why } : {})}
    >
      <span
        className={`pt ${pointClass(column)}`}
        data-task-point={task.id}
        {...(focus ? { 'data-focus-point': '' } : {})}
      />
      <button type="button" className="t" title={task.name} onClick={() => onOpenThread(task)}>
        {task.name}
      </button>
      <div className="m">
        {/* The queue's place, short enough for a compact row; the reason is its title and,
            outside compact, the row's own line below. */}
        {queued && (
          <span className={`mono q${queued.why === 'held' ? ' attn' : ''}`} title={queued.detail}>
            {queued.position === null ? 'held' : `#${queued.position}`}
          </span>
        )}
        <span className="mono" title={workerTitle}>
          {worker}
        </span>
        <span className="mono age">{age}</span>
      </div>
      {task.sourceDocument && (
        <div className="x" title={task.sourceDocument}>Default document: {task.sourceDocument}</div>
      )}
      {(evidenceLine || focus || verification) && (
        <div className="x">
          {evidenceLine && <span className="why">{evidenceLine}</span>}
          {verification && <VerificationBadge view={verification} />}
          {column === 'Review' && reviewCount > 0 && <span>{reviewCount} files</span>}
          {focus && <span className="mono here">this thread</span>}
        </div>
      )}
      {/* A run has no known total, so this is the indeterminate bar, and it is
          decorative: the column already says the task is working. */}
      {column === 'Working' && (
        <SegmentBar className="prog" label={task.name} caption={null} decorative />
      )}
      <span className="acts">
        {canStart && (
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
            {startLabel}
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
        {canRoute && (
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
      {task.creationReceipt && (
        <details className="creation-receipt">
          <summary>Creation receipt</summary>
          <dl>
            <dt>Created</dt>
            <dd>
              <time dateTime={task.creationReceipt.admittedAt}>
                {new Date(task.creationReceipt.admittedAt).toLocaleString()}
              </time>
            </dd>
            <dt>Command</dt>
            <dd className="mono">{task.creationReceipt.commandId}</dd>
            <dt>History event</dt>
            <dd className="mono">{task.creationReceipt.eventId}</dd>
          </dl>
        </details>
      )}
      {canStart && confirmOpen && (
        <div className="confirm">
          <span>Hand to {worker}?</span>
          <button
            type="button"
            className="go"
            disabled={busy || startBlocked}
            onClick={() => void onStart(task)}
          >
            {startLabel}
          </button>
          <button type="button" onClick={onToggleConfirm}>
            Not now
          </button>
        </div>
      )}
      {canRoute && routeOpen && (
        <div className="route" role="list">
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
