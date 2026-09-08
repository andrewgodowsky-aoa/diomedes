import type {
  HistoryEntry,
  Mode,
  Need,
  Project,
  ProjectState,
  Session,
  Task,
} from '../../shared/types';
import { time } from '../components';

function ageOf(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function clockOf(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

function pointFor(task: Task): string {
  if (task.state === 'working') return 'live';
  if (task.state === 'waiting') return 'attn';
  if (task.state === 'done') return 'done';
  return '';
}

function reasonText(task: Task): string | null {
  if (task.state !== 'waiting') return null;
  if (task.reason === 'changes-ready') return 'Changes ready';
  if (task.reason === 'went-wrong') return 'Something went wrong';
  return 'Needs your OK';
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
}: LedgerProps) {
  const open = state.tasks.filter((t) => t.state !== 'done');
  const lastHistory: HistoryEntry | undefined = state.history.at(-1);
  const sub = open.length
    ? `N open items, updated ${lastHistory ? time(lastHistory.time) : 'never'}`.replace(
        'N open items',
        `${open.length} open ${open.length === 1 ? 'item' : 'items'}`,
      )
    : 'Ready when you are';
  const recent = [...state.history].slice(-3).reverse();
  const activity = latest ? [...latest.log].reverse().slice(0, 8) : [];
  return (
    <aside className="ledger" aria-label="This project">
      <h2>{project.name}</h2>
      <p className="sub">{sub}</p>
      {task && (
        <div className="focus" aria-label="This thread's work">
          <div className="t">
            <span className={`pt ${pointFor(task)}`} />
            {task.name}
          </div>
          <div className="m">
            <span className="mono">
              {task.state} on {taskWorker}, {ageOf(task.createdAt)}
            </span>
            <button type="button" onClick={onBoard}>
              Board
            </button>
            <button type="button" onClick={onTeam}>
              Team
            </button>
          </div>
        </div>
      )}
      <section id="secWork" className={mode === 'ask' ? 'dim' : ''}>
        <h3>
          Work <span className="mono">{open.length} open</span>
        </h3>
        <ul>
          {open.map((t) => (
            <li key={t.id}>
              <span className={`pt ${pointFor(t)}`} />
              {t.name}
              <span className="mono lc">{ageOf(t.createdAt)}</span>
              <span className="sub">
                {t.owner === 'you' ? 'You' : 'Diomedes'}
                {reasonText(t) ? `, ${reasonText(t)}` : ', not started'}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section id="secNeeds">
        <h3>
          Needs you <span className="mono">{openNeeds.length ? openNeeds.length : ''}</span>
        </h3>
        <ul>
          {openNeeds.length ? (
            openNeeds.map((n) => (
              <li key={n.id}>
                <span className="pt attn" />
                <span>{n.what}</span>
                <button type="button" onClick={() => onReviewNeed(n)}>
                  Review
                </button>
              </li>
            ))
          ) : (
            <li className="quiet">Nothing right now</li>
          )}
        </ul>
      </section>
      <section id="secActivity" className={running ? '' : 'dim'}>
        <h3>
          Activity <span className="mono">{running ? 'running' : 'quiet'}</span>
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
            recent.map((h) => (
              <li className="quiet" key={h.id}>
                {h.sentence}
              </li>
            ))
          ) : (
            <li className="quiet">No history yet</li>
          )}
        </ul>
      </section>
    </aside>
  );
}
