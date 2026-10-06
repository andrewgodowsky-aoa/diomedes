import type {
  Mode,
  Need,
  Project,
  ProjectState,
  Session,
  Task,
} from '../../shared/types';
import { formatOrigin, originForSession } from '../attribution-display';
import { OriginLine } from '../components';
import { taskEvidence } from '../workbench/task-evidence';
import { evidenceTone } from '../../shared/needs-you';
// The Board's own reading, so a task's age is the same number on both: since it last moved.
import { ageOf } from './BoardView';
import { cardNeed, workBoard, type BoardCard } from './work-view';

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
  /** Opens a task's own thread, from its card. */
  onOpenTask?(taskId: string): void;
  /** H13: start a work loop run on this thread's task. */
  onLoopRun?(): void;
}

/**
 * The board beside a thread in Work (round 2 board BD1). It keeps the place the project aside
 * held, so the column and its widths are unchanged: the thread's own work first, then Needs your
 * input, Working, Up next and Finished today, read from the same records as the Board screen.
 * Each card opens its thread, and a decision opens where it waits. Open full board goes to the
 * Board screen.
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
  onOpenTask,
  onLoopRun,
}: LedgerProps) {
  const focus = task ? taskEvidence(task, state.sessions, state.needs, state.changes) : null;
  const worker = (item: Task, session: Session | null) =>
    session
      ? formatOrigin(originForSession(session)).label
      : item.owner === 'you'
        ? 'You'
        : item.id === task?.id && taskWorker
          ? taskWorker
          : 'Assistant - model not recorded';
  const board = workBoard(state, worker);
  const open = (card: BoardCard) => {
    const need = cardNeed(card, openNeeds);
    if (need) onReviewNeed(need);
    else if (card.taskId && onOpenTask) onOpenTask(card.taskId);
    else onBoard();
  };
  const cards = (list: BoardCard[], go?: string) =>
    list.map((card) => (
      <li key={card.id}>
        <button
          type="button"
          className="bc"
          aria-current={card.taskId && card.taskId === task?.id ? 'true' : undefined}
          onClick={() => open(card)}
        >
          <span className="bt">{card.title}</span>
          {card.meta && <span className="bm">{card.meta}</span>}
          <span className="bs">
            <span className={`pt ${card.tone}`} aria-hidden="true" />
            <span className="bx">{card.status}</span>
            {go && <span className="go">{go}</span>}
          </span>
        </button>
      </li>
    ));
  const activity = running && latest?.state === 'working' ? 'running' : latest?.state === 'waiting' ? 'waiting' : null;
  return (
    <aside className="ledger" aria-label="This project">
      <div className="bh">
        <h2>Board</h2>
        <button type="button" className="bh-open" onClick={onBoard}>
          Open full board
        </button>
      </div>
      <p className="sub">
        {project.name}, {board.open} open
      </p>
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
            {activity && <span className="mono">{activity}</span>}
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
      <section id="secNeeds" aria-labelledby="secNeedsH">
        <h3 id="secNeedsH">
          Needs your input <span className="mono">{board.needs.length}</span>
        </h3>
        {board.needs.length ? <ul className="bcs">{cards(board.needs, 'Review')}</ul> : <p className="quiet">Nothing right now</p>}
      </section>
      <section id="secWork" className={mode === 'ask' ? 'dim' : ''} aria-labelledby="secWorkH">
        <h3 id="secWorkH">
          Working <span className="mono">{board.working.length}</span>
        </h3>
        {board.working.length > 0 && <ul className="bcs">{cards(board.working)}</ul>}
      </section>
      <section id="secNext" aria-labelledby="secNextH">
        <h3 id="secNextH">
          Up next <span className="mono">{board.next.length}</span>
        </h3>
        {board.next.length > 0 && <ul className="bcs">{cards(board.next)}</ul>}
      </section>
      <section id="secDone" aria-labelledby="secDoneH">
        <h3 id="secDoneH">
          Finished today <span className="mono">{board.finished.length}</span>
        </h3>
        {board.finished.length > 0 && (
          <ul>
            {board.finished.map((card) => (
              <li key={card.id} className="fin">
                <span>{card.title}</span>
                <span className="mono lc">{card.at}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
