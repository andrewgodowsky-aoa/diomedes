import type {
  HistoryEntry,
  Mode,
  Need,
  Project,
  ProjectState,
  Session,
  Task,
} from '../../shared/types';
import { formatOrigin, originForSession } from '../attribution-display';
import { OriginLine, time } from '../components';
import { taskEvidence } from '../workbench/task-evidence';
import { evidenceTone, needsYou } from '../../shared/needs-you';
// The Board's own reading, so a task's age is the same number on both: since it last moved.
import { ageOf } from './BoardView';

function clockOf(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

interface LedgerProps {
  project: Project;
  state: ProjectState;
  task: Task | null;
  taskWorker: string;
  mode: Mode;
  running: boolean;
  latest: Session | null;
  openNeeds: Need[];
  onBoard(): void;
  onTeam(): void;
  onReviewNeed(need: Need): void;
  /** H13: start a work loop run on this thread's task. */
  onLoopRun?(): void;
}

/**
 * The project aside: name, the thread's own work on a stronger hairline,
 * then Work, Needs you, Activity and Recent. Dimming follows the mode.
 */
export function Ledger({
  project,
  state,
  task,
  taskWorker,
  mode,
  running,
  latest,
  openNeeds,
  onBoard,
  onTeam,
  onReviewNeed,
  onLoopRun,
}: LedgerProps) {
  const projection = (item: Task) => taskEvidence(item, state.sessions, state.needs, state.changes);
  const open = state.tasks
    .filter((item) => !item.deletedAt)
    .map((item) => ({ task: item, evidence: projection(item) }))
    .filter((item) => item.evidence.column !== 'Done');
  const focus = task ? projection(task) : null;
  // The one needs-you rule: the same items the home counts and the Board marks.
  const waiting = needsYou(state);
  const worker = (item: Task, session: Session | null) =>
    session
      ? formatOrigin(originForSession(session)).label
      : item.owner === 'you'
        ? 'You'
        : item.id === task?.id && taskWorker
          ? taskWorker
          : 'Assistant - model not recorded';
  const activityRunning = running && latest?.state === 'working';
  const lastHistory: HistoryEntry | undefined = state.history.at(-1);
  const sub = open.length
    ? `N open items, updated ${lastHistory ? time(lastHistory.time) : 'never'}`.replace(
        'N open items',
        `${open.length} open ${open.length === 1 ? 'item' : 'items'}`,
      )
    : 'Ready when you are';
  const recent = state.history.slice(-3).reverse();
  const activity = latest ? [...latest.log].reverse().slice(0, 8) : [];
  const sessionOf = (sessionId: string | null) =>
    sessionId ? (state.sessions.find((s) => s.id === sessionId) ?? null) : null;
  const originLabelOf = (entry: HistoryEntry): string | null => {
    const session = sessionOf(entry.sessionId);
    const snapshot = entry.origin ?? (session ? originForSession(session) : undefined);
    return snapshot ? formatOrigin(snapshot).label : null;
  };
  return (
    <aside className="ledger" aria-label="This project">
      <h2>{project.name}</h2>
      <p className="sub">{sub}</p>
      {task && focus && (
        <div className="focus" aria-label="This thread's work">
          <div className="t">
            <span className={`pt ${evidenceTone(focus)}`} />
            {task.name}
          </div>
          <div className="m">
            <span className="mono" title={ageOf(task).title}>
              {focus.detail}, {ageOf(task).short}
            </span>
            <button type="button" onClick={onBoard}>
              Board
            </button>
            <button type="button" onClick={onTeam}>
              Team
            </button>
            {onLoopRun && (
              <button type="button" onClick={onLoopRun}>
                Loop run
              </button>
            )}
          </div>
          {focus.session ? (
            <div className="m">
              <OriginLine origin={originForSession(focus.session)} />
            </div>
          ) : (
            <div className="m">{worker(task, null)}</div>
          )}
        </div>
      )}
      <section id="secWork" className={mode === 'ask' ? 'dim' : ''}>
        <h3>
          Work <span className="mono">{open.length} open</span>
        </h3>
        <ul>
          {open.map(({ task: t, evidence }) => (
            <li key={t.id}>
              <span className={`pt ${evidenceTone(evidence)}`} />
              {t.name}
              <span className="mono lc" title={ageOf(t).title}>
                {ageOf(t).short}
              </span>
              <span className="sub">
                {worker(t, evidence.session)} · {evidence.detail}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section id="secNeeds">
        <h3>
          Needs you <span className="mono">{waiting.length ? waiting.length : ''}</span>
        </h3>
        <ul>
          {waiting.length ? (
            waiting.map((item) => {
              const need = item.needId ? openNeeds.find((n) => n.id === item.needId) : undefined;
              return (
                <li key={item.id}>
                  <span className={`pt ${item.kind === 'failed' ? 'fail' : 'attn'}`} />
                  <span title={item.detail}>{need ? need.what : item.label}</span>
                  {need ? (
                    <button type="button" onClick={() => onReviewNeed(need)}>
                      Review
                    </button>
                  ) : (
                    <button type="button" onClick={onBoard}>
                      Board
                    </button>
                  )}
                </li>
              );
            })
          ) : (
            <li className="quiet">Nothing right now</li>
          )}
        </ul>
      </section>
      <section id="secActivity" className={activityRunning ? '' : 'dim'}>
        <h3>
          Activity{' '}
          <span className="mono">
            {activityRunning
              ? 'running'
              : latest?.state === 'waiting'
                ? 'waiting'
                : latest?.state === 'queued'
                  ? 'queued'
                  : 'quiet'}
          </span>
        </h3>
        {latest ? (
          <ul className="ev">
            {activity.map((l, i) => (
              <li key={i}>
                <b>{clockOf(l.time)}</b>
                <span>{l.sentence}</span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="ev">
            <li className="quiet">No runs yet</li>
          </ul>
        )}
      </section>
      <section id="secRecent" className={mode === 'ask' || mode === 'plan' ? 'dim' : ''}>
        <h3>Recent</h3>
        <ul>
          {recent.length ? (
            recent.map((h) => {
              const label = originLabelOf(h);
              return (
                <li className="quiet" key={h.id}>
                  {h.sentence}
                  {label ? <span className="mono lc"> · {label}</span> : null}
                </li>
              );
            })
          ) : (
            <li className="quiet">No history yet</li>
          )}
        </ul>
      </section>
    </aside>
  );
}
