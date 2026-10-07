import { useEffect, useRef, useState } from 'react';
import type { HistoryEntry, Need, Session, Task } from '../../shared/types';
import type { TaskExecutionView } from '../../shared/task-execution';
import { TASK_ROUTE_SOURCE_LABELS } from '../../shared/task-execution';
import type { BoardColumn, BoardMove } from '../../shared/board-moves';
import { readableFileName } from '../../shared/display-names';
import { routeDisplayName } from '../../shared/engines';
import { api } from '../api';
import { Modal } from '../components';
import { VerificationBadge, verificationFor } from './Verification';
import './task-inspector.css';
import { TaskWorkflowPanel } from './TaskWorkflowPanel';

/** What `GET /projects/:id/agent-profiles` returns for one profile (H09). */
interface ProfileOption {
  profileId: string;
  revision: number;
  name: string;
  engine: string;
  model: string;
  effort: string | null;
  available: boolean;
  reason: string | null;
}

/** The permission choices by id, as Settings names them (shared/permissions.ts). */
const PERMISSION_NAMES: Record<string, string> = {
  review: 'Review changes',
  project: 'Work in this project',
  'auto-review': 'Approve for me',
  full: 'Full access',
};
const THREAD_PERMISSION: Record<string, string> = {
  'show-first': 'Shows each change first',
  task: "Works within the task's scope",
};
const CHECK_KINDS: Record<string, string> = {
  'file-exists': 'a file exists',
  'file-digest': 'exact file contents',
  'text-contains': 'text is present',
  'json-valid': 'valid JSON',
  command: 'a command passes',
  review: 'a review',
};
const RUN_STATE: Record<Session['state'], string> = {
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting',
  done: 'Finished',
  stopped: 'Stopped',
  failed: 'Failed',
};

const when = (at: string | null) => (at ? new Date(at).toLocaleString() : '');

/** Where a task came from, from its own creation record. */
function originOf(task: Task): string {
  if (task.creationReceipt?.commandId.startsWith('conv.'))
    return 'Made from a conversation proposal you chose';
  if (task.createdBy === 'diomedes') return 'Put on the board by the team lead';
  if (task.from) return `Made from ${readableFileName(task.from.plan, { folder: true })}, step ${task.from.step}`;
  return 'Made by you';
}

export interface InspectorMove {
  to: BoardColumn;
  move: Extract<BoardMove, { kind: 'command' }>;
}

export interface TaskInspectorProps {
  projectId: string;
  task: Task;
  tasks: readonly Task[];
  onOpenTask(task: Task): void;
  onOpenOrigin?(): void;
  column: BoardColumn;
  /** The projection's one line for this task (client/workbench/task-evidence.ts). */
  detail: string;
  sessions: readonly Session[];
  needs: readonly Need[];
  history: readonly HistoryEntry[];
  changesWaiting: number;
  /** The commands the Board's move table offers for this task now, in menu order. */
  moves: InspectorMove[];
  /** A move waiting for the person's confirmation, when it is this task's. */
  confirming: { sentence: string; label: string } | null;
  /** What the card says while a command is under way. */
  pending: string | null;
  /**
   * The move table's last refusal for this task. A route's own refusal is reported by the
   * Shell, as it is for the card's buttons.
   */
  issue: string | null;
  busy: boolean;
  /**
   * Technical detail. Customers do not choose routes (2026-09-23), so the per-task profile
   * choice is offered only here; other levels read the task's profile, when it has one.
   */
  technical: boolean;
  /** Bumped by the Board after each change, so the execution view is read again. */
  revision: number;
  onMove(to: BoardColumn): void;
  onConfirm(): void;
  onCancelConfirm(): void;
  onReview(): void;
  onOpenThread(): void;
  onClose(): void;
}

/**
 * A task in full, over the Board: the work on the left and how it runs on the right.
 *
 * The left is the task's own record: what it is for, what it may read, what would count as
 * finished, what its latest run did and what waits on the person. The right is the execution
 * view (shared/task-execution.ts): the worker, the route, the model and the permissions a
 * Start would resolve now, read through the services admission uses, with every reason a
 * Start would be refused, and the one per-task choice this build keeps, the task's own profile
 * list (H09), at Technical detail only. Past runs are listed as their records say; the thread
 * holds each run's full record, so it is linked rather than repeated here.
 *
 * Every action is a Board move, sent through the same table and command a drag sends.
 */
export function TaskInspector(props: TaskInspectorProps) {
  const { projectId, task, sessions, needs, history } = props;
  const [view, setView] = useState<TaskExecutionView | null>(null);
  const [viewIssue, setViewIssue] = useState('');
  const [profiles, setProfiles] = useState<ProfileOption[] | null>(null);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [routingIssue, setRoutingIssue] = useState('');
  const read = useRef(0);

  async function refresh(signal?: AbortSignal) {
    const mine = ++read.current;
    try {
      const [next, listed] = await Promise.all([
        api<TaskExecutionView>(
          `/projects/${projectId}/tasks/${encodeURIComponent(task.id)}/execution`,
          'GET',
          undefined,
          signal,
        ),
        api<{ profiles: ProfileOption[] }>(
          `/projects/${projectId}/agent-profiles?taskId=${encodeURIComponent(task.id)}`,
          'GET',
          undefined,
          signal,
        ),
      ]);
      if (mine !== read.current) return;
      setView(next);
      setProfiles(listed.profiles);
      setViewIssue('');
    } catch (error) {
      if (signal?.aborted || mine !== read.current) return;
      setViewIssue(error instanceof Error ? error.message : "This task's settings couldn't be read.");
    }
  }
  useEffect(() => {
    const control = new AbortController();
    void refresh(control.signal);
    return () => control.abort();
  }, [projectId, task.id, props.revision]);

  async function saveRouting(value: { order: string[]; fallback: boolean } | null) {
    if (routingBusy) return;
    setRoutingBusy(true);
    setRoutingIssue('');
    try {
      await api(
        `/projects/${projectId}/tasks/${encodeURIComponent(task.id)}/agent-routing`,
        'PUT',
        value ?? { clear: true },
      );
    } catch (error) {
      setRoutingIssue(error instanceof Error ? error.message : "The connection choices couldn't be saved.");
    } finally {
      setRoutingBusy(false);
      await refresh();
    }
  }

  const own = sessions
    .filter((session) => session.taskId === task.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  const latest = own[0] ?? null;
  const activity = (latest?.log ?? []).filter((line) => line.level === 'plain').slice(-8);
  const verification = latest ? verificationFor(latest, task, history) : null;
  const openNeeds = needs.filter((need) => need.taskId === task.id && need.state === 'open');
  const checks = task.acceptance?.checks ?? [];
  const taskChoice = view?.routing.task?.order[0] ?? '';
  const fallback = view?.routing.task?.fallback ?? false;
  const canEditRouting = !routingBusy && profiles !== null && !props.pending;
  const taskProfile = taskChoice
    ? profiles?.find((profile) => profile.profileId === taskChoice)?.name ?? taskChoice
    : null;

  return (
    <Modal title={task.name} wide onClose={props.onClose}>
      <div className="task-inspector" data-task-inspector={task.id}>
        <p className="ti-status">
          <span className={`ti-column ${props.column.toLowerCase()}`}>{props.column}</span>
          <span>{props.pending ?? props.detail}</span>
          <span className="ti-origin">
            {originOf(task)} · <time dateTime={task.createdAt}>{when(task.createdAt)}</time>
          </span>
        </p>
        <div className="ti-grid">
          <section className="ti-work" aria-label="The work">
            <h3>Objective</h3>
            <p className="ti-objective">
              {task.description.trim() || 'Use the task name as the instruction.'}
            </p>
            <h3>Default document</h3>
            <p title={task.sourceDocument}>
              {task.sourceDocument
                ? readableFileName(task.sourceDocument, { folder: true })
                : 'None. Start asks which documents to send.'}
            </p>
            <h3>Finished means</h3>
            <p>
              {checks.length
                ? `${checks.length} completion ${checks.length === 1 ? 'check' : 'checks'}: ${[
                    ...new Set(checks.map((check) => CHECK_KINDS[check.kind] ?? check.kind)),
                  ].join(', ')}.`
                : 'Add completion checks to verify the result.'}
            </p>
            {verification && (
              <p className="ti-result">
                <VerificationBadge view={verification} />
                <span>{verification.sentence}</span>
              </p>
            )}
            {(openNeeds.length > 0 || props.changesWaiting > 0) && (
              <div className="ti-waiting" role="status">
                <span>
                  {openNeeds.length > 0
                    ? `${openNeeds.length === 1 ? 'A decision needs' : `${openNeeds.length} decisions need`} your review.`
                    : `${props.changesWaiting} ${props.changesWaiting === 1 ? 'change needs' : 'changes need'} review.`}
                </span>
                <button type="button" className="verb light" onClick={props.onReview}>
                  Review
                </button>
              </div>
            )}
            <h3>{latest ? `Latest run · ${RUN_STATE[latest.state]}` : 'Activity'}</h3>
            {activity.length ? (
              <ol className="ti-activity" aria-label="Latest run activity">
                {activity.map((line, index) => (
                  <li key={`${line.time}-${index}`}>
                    <time dateTime={line.time}>{new Date(line.time).toLocaleTimeString()}</time>
                    <span>{line.sentence}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="ti-quiet">{latest ? "No activity reported for this job." : "No job history."}</p>
            )}
          </section>
          <aside className="ti-controls" aria-label="How it runs">
            <TaskWorkflowPanel key={task.id} projectId={projectId} task={task} tasks={props.tasks}
              busy={props.busy || own.some((run) => ['queued', 'working', 'waiting'].includes(run.state))}
              onOpenTask={props.onOpenTask} onOpenOrigin={props.onOpenOrigin} onReview={props.onReview} />
            {viewIssue && (
              <p className="ti-issue" role="alert">
                {viewIssue}
              </p>
            )}
            {!view && !viewIssue && <p className="ti-quiet">Reading how this task would run…</p>}
            {view && (
              <>
                <dl className="ti-facts">
                  <dt>Worker</dt>
                  <dd>
                    {view.worker.resolved ? (
                      <>
                        {view.worker.resolved.agentName}
                        <small>
                          {view.worker.resolved.selection === 'automatic' ? 'Auto chose it' : 'Chosen for this task'}
                          {' · '}v{view.worker.resolved.agentVersion}
                        </small>
                      </>
                    ) : (
                      <small>{view.worker.note ?? 'Not resolved.'}</small>
                    )}
                  </dd>
                  <dt>Connection</dt>
                  <dd>
                    {view.route.name}
                    <small>
                      {TASK_ROUTE_SOURCE_LABELS[view.route.source]}
                      {view.route.on ? '' : ' · off in Settings'}
                    </small>
                  </dd>
                  <dt>Model</dt>
                  <dd>
                    {view.model ? (
                      <>
                        <span className="ti-machine">{view.model.requested ?? 'Connection default'}</span>
                        <small>
                          {view.model.effort ? `${view.model.effort} reasoning · ` : ''}
                          {view.model.selection === 'manual'
                            ? 'chosen'
                            : view.model.selection === 'automatic'
                              ? 'chosen automatically'
                              : 'chosen by the service'}
                        </small>
                      </>
                    ) : (
                      <small>None</small>
                    )}
                  </dd>
                  <dt>May do</dt>
                  <dd>
                    {view.permission.effective
                      ? PERMISSION_NAMES[view.permission.effective] ?? view.permission.effective
                      : THREAD_PERMISSION[view.permission.thread]}
                    <small>
                      {view.permission.effective
                        ? `${THREAD_PERMISSION[view.permission.thread]} · worker cap ${
                            PERMISSION_NAMES[view.permission.agentCeiling ?? ''] ?? view.permission.agentCeiling
                          }`
                        : 'Permissions apply to every worker.'}
                    </small>
                  </dd>
                  {view.queue && (
                    <>
                      <dt>Queue</dt>
                      <dd>{view.queue.detail}</dd>
                    </>
                  )}
                  {!props.technical && taskProfile && (
                    <>
                      <dt>Profile</dt>
                      <dd>{taskProfile}</dd>
                    </>
                  )}
                </dl>
                {!props.technical && view.routing.inert && taskProfile && (
                  <p className="ti-note">{view.routing.inert}</p>
                )}
                {props.technical && (
                  <fieldset className="ti-routing" disabled={!canEditRouting}>
                    <legend>Profile for this task</legend>
                    <select
                      aria-label="Profile for this task"
                      value={taskChoice}
                      onChange={(event) =>
                        void saveRouting(
                          event.target.value ? { order: [event.target.value], fallback } : null,
                        )
                      }
                    >
                      <option value="">
                        {view.routing.project?.order.length
                          ? 'Follow the project’s list'
                          : 'Use this connection and model'}
                      </option>
                      {(profiles ?? []).map((profile) => (
                        <option key={profile.profileId} value={profile.profileId} disabled={!profile.available}>
                          {profile.name} · {routeDisplayName(profile.engine)} · {profile.model}
                          {profile.available ? '' : ' (unavailable)'}
                        </option>
                      ))}
                    </select>
                    {taskChoice && (
                      <label className="ti-fallback">
                        <input
                          type="checkbox"
                          checked={fallback}
                          onChange={(event) =>
                            void saveRouting({ order: [taskChoice], fallback: event.target.checked })
                          }
                        />
                        Try the project’s list if this profile can’t run
                      </label>
                    )}
                    {view.routing.inert && <p className="ti-note">{view.routing.inert}</p>}
                    {!profiles?.length && (
                      <p className="ti-note">Create a profile in Settings › Agent profiles.</p>
                    )}
                    {routingIssue && (
                      <p className="ti-issue" role="alert">
                        {routingIssue}
                      </p>
                    )}
                  </fieldset>
                )}
                {view.blockers.length > 0 && (
                  <div className="ti-blockers" role="status" aria-label="Resolve before starting">
                    <h4>Resolve before starting</h4>
                    <ul>
                      {view.blockers.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {view.notes.length > 0 && (
                  <ul className="ti-notes">
                    {view.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
                <h4>Runs</h4>
                {view.runs.length ? (
                  <ul className="ti-runs" aria-label="Runs of this task">
                    {view.runs.map((run) => (
                      <li key={run.sessionId}>
                        <span className="ti-run-state">{RUN_STATE[run.state]}</span>
                        <time dateTime={run.startedAt}>{when(run.startedAt)}</time>
                        <small>
                          {[
                            run.route ? routeDisplayName(run.route) || run.route : null,
                            run.worker,
                            run.profile ? `${run.profile.name} r${run.profile.revision}` : null,
                            run.model.reported ?? run.model.requested,
                            run.instructions
                              ? `${run.instructions.sent} instruction ${run.instructions.sent === 1 ? 'file' : 'files'} sent`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="ti-quiet">No runs yet.</p>
                )}
              </>
            )}
          </aside>
        </div>
        <div className="ti-actions">
          {props.issue && (
            <p className="ti-issue" role="alert">
              {props.issue}
            </p>
          )}
          {props.confirming ? (
            <div className="ti-confirm" role="group" aria-label="Confirm">
              <span>{props.confirming.sentence}</span>
              <button
                type="button"
                className="go"
                disabled={props.busy || !!props.pending}
                onClick={props.onConfirm}
              >
                {props.confirming.label}
              </button>
              <button type="button" onClick={props.onCancelConfirm}>
                Not now
              </button>
            </div>
          ) : (
            <div className="ti-verbs">
              {props.moves.map(({ to, move }) => (
                <button
                  key={to}
                  type="button"
                  className={move.command === 'start' ? 'verb light' : 'verb'}
                  disabled={props.busy || !!props.pending}
                  onClick={() => props.onMove(to)}
                >
                  {move.label}
                </button>
              ))}
              <button type="button" className="verb" onClick={props.onOpenThread}>
                Open thread
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
