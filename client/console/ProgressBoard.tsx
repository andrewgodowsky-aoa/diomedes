import { useEffect, useState, type ReactNode } from 'react';
import type { HarnessRun } from '../../shared/harness';
import type { Conversation, Session, Task } from '../../shared/types';
import { api } from '../api';
import { PaneEdge } from './ArtifactPane';
import { SegmentBar } from './SegmentBar';
import { startedWorkOf, type Board, type StartedWork } from './board-model';
import type { SegmentState } from './segment-bar-model';
import './progress-board.css';

// The progress board (board-model.ts) as the artifact column draws it: its own view when no
// artifact is open, and a compact line under an open artifact's head. Each group is the Board's
// plan row (a name and a segment bar that counts tasks), and the full view lists each task with
// the Console's own point and the task record's words for where it stands.

/** A step's point, in the Console's marks (console.css `.pt`): lit while it runs, amber while it needs you. */
const POINT: Record<SegmentState, string> = { done: 'done', active: 'live', blocked: 'attn', failed: 'fail', pending: '' };

const NONE: StartedWork[] = [];

/** The groups of a board: in full, with every task listed, or compact, name and bar only. */
export function ProgressBoard({ board, compact = false }: { board: Board; compact?: boolean }) {
  return (
    <div className={`pb${compact ? ' compact' : ''}`}>
      {board.groups.map((group) => (
        <div className="pb-group" key={group.key}>
          {compact ? (
            <span className="pb-name" title={group.name}>
              {group.name}
            </span>
          ) : (
            <h3 className="pb-name" title={group.name}>
              {group.name}
            </h3>
          )}
          <SegmentBar steps={group.steps} label={group.label} noun={group.noun} size="panel" />
          {!compact && (
            <ol className="pb-steps" aria-label={group.label}>
              {group.steps.map((step) => (
                <li className={`pb-step ${step.state}`} key={step.taskId}>
                  <span className={`pt ${POINT[step.state]}`} aria-hidden="true" />
                  <span className="pb-label">{step.label}</span>
                  <span className="pb-detail">{step.detail}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The board as the artifact column's own view: the panel's plate, titled with the thread's
 * name. It opens by itself while the thread's work is still moving and no artifact is open;
 * Close (or Esc inside it) puts it away until the board counts different tasks.
 */
export function BoardPane({
  board,
  title,
  width,
  onWidth,
  onClose,
  hidden = false,
  switcher,
}: {
  board: Board;
  title: string;
  width: number;
  onWidth(width: number): void;
  onClose(): void;
  hidden?: boolean;
  switcher?: ReactNode;
}) {
  return (
    <aside
      className="art-pane pb-pane"
      aria-label="Progress"
      hidden={hidden}
      style={{ width: `min(${width}px, 100%)` }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <PaneEdge width={width} onWidth={onWidth} label="Resize the progress panel" />
      <div className="art-plate">
        <div className="art-plate-face">
          <div className="art-head">
            {switcher}
            <div className="art-head-row">
              <div>
                <span className="art-kind">Progress</span>
                <h2 className="art-title">{title}</h2>
              </div>
              <button type="button" className="art-close" onClick={onClose}>
                Close
              </button>
            </div>
            <p className="art-status">Counted from task records as they change.</p>
          </div>
          <div className="art-body">
            <ProgressBoard board={board} />
          </div>
        </div>
      </div>
    </aside>
  );
}

/**
 * What this conversation's Automatic runs recorded as started (`startedWorkOf`). Only an
 * Automatic lineage starts work (server/interaction-admission.ts), so only its runs are read:
 * one GET of each (`/harness/runs/:runId`, the route the task record's evidence uses), again
 * when a lineage comes, a message settles, a task appears or a run starts, and never on a timer.
 * The task's receipt is saved just after the task appears and before its work starts
 * (server/interaction-service.ts), so the read a new run brings finds it. A run that cannot be
 * read counts nothing, and nothing read for one thread is shown for another.
 */
export function useStartedWork(
  projectId: string,
  thread: Pick<Conversation, 'id' | 'turns' | 'lineages'> | null | undefined,
  tasks: readonly Pick<Task, 'id'>[] | null | undefined,
  sessions?: readonly Pick<Session, 'id'>[] | null,
): StartedWork[] {
  const runs = (thread?.lineages ?? []).filter((lineage) => lineage.mode === 'auto').map((lineage) => lineage.runId);
  const owner = thread ? `${projectId}\n${thread.id}` : '';
  const reads = [
    owner,
    runs.join(','),
    thread?.turns.length ?? 0,
    tasks?.length ?? 0,
    tasks?.at(-1)?.id ?? '',
    sessions?.length ?? 0,
  ].join('\n');
  const [found, setFound] = useState<{ owner: string; started: StartedWork[] }>({ owner: '', started: NONE });
  useEffect(() => {
    if (!owner || !runs.length) return;
    const controller = new AbortController();
    const base = `/projects/${encodeURIComponent(projectId)}/harness/runs`;
    void Promise.all(
      runs.map((runId) =>
        api<HarnessRun>(`${base}/${encodeURIComponent(runId)}`, 'GET', undefined, controller.signal).then(
          (run) => (run.id === runId && run.projectId === projectId ? startedWorkOf(run) : NONE),
          () => NONE,
        ),
      ),
    ).then((lists) => {
      if (!controller.signal.aborted) setFound({ owner, started: lists.flat() });
    });
    return () => controller.abort();
    // `reads` names everything these reads depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reads]);
  return runs.length && found.owner === owner ? found.started : NONE;
}
