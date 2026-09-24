import { useEffect, useId, useMemo, useState } from 'react';
import type { Change, HistoryEntry, Route, Task } from '../../shared/types';
import { buildDiff } from '../../shared/text-diff';
import {
  commentPlace,
  partialSentence,
  revisionFits,
  revisionRequest,
  type ReviewComment,
} from '../../shared/review-comments';
import { ApiError, readDocument } from '../api';
import { mintCommandId } from '../work-start';
import { routeDisplayName } from '../../shared/engines';
import { DiffView } from './DiffView';
import { addComment, keepPart, resolveComment, reviewWhole, reviseWithComments } from './review-api';
import './diff-view.css';

/**
 * P06 in a task's thread: each change the task's runs wrote, as a readable
 * diff, with Keep and Undo for the whole change, a Keep checkbox per change
 * inside it when it touched several places, and comments on any line.
 *
 * A partial keep is one recorded write the server checks against the exact
 * version shown here; if the file moved on, nothing is written and the card
 * says so and offers the newer text to review. "Revise with these comments"
 * shows the exact message first and then queues it as an ordinary follow-up —
 * the queue under the composer shows what became of it.
 */

function stateWord(change: Change): string {
  if (change.state === 'waiting') return 'waiting for you';
  if (change.state === 'undone') return 'undone';
  return change.partial ? partialSentence(change.partial) : 'kept';
}

function recordOf(change: Change, history: readonly HistoryEntry[]) {
  return history.find((entry) => entry.id === change.entryId)?.files.find((file) => file.path === change.path) ?? null;
}

function ChangeDiffCard({
  projectId,
  change,
  history,
  comments,
  onError,
}: {
  projectId: string;
  change: Change;
  history: readonly HistoryEntry[];
  comments: readonly ReviewComment[];
  onError?(error: Error): void;
}) {
  const record = recordOf(change, history);
  const waiting = change.state === 'waiting';
  const diff = useMemo(
    () =>
      buildDiff({
        path: change.path,
        before: change.before,
        after: change.after,
        binary: record?.binary === true,
        unavailable: !record?.recorded,
      }),
    [change.path, change.before, change.after, record?.binary, record?.recorded],
  );
  const all = useMemo(() => diff.hunks.map((hunk) => hunk.index), [diff]);
  const [kept, setKept] = useState<ReadonlySet<number>>(new Set(all));
  const [open, setOpen] = useState(waiting);
  const [working, setWorking] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [since, setSince] = useState(false);
  /** The file as "Review again" read it: newer than the last project state when it moved on. */
  const [latest, setLatest] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setKept(new Set(all));
  }, [all, record?.after]);
  // A newer project state carries the file as it is now; the one "Review again" read is spent.
  useEffect(() => {
    setLatest(undefined);
  }, [change.current]);

  const decisions = useMemo(
    () =>
      change.partial
        ? new Map<number, 'kept' | 'undone'>([
            ...change.partial.kept.map((index) => [index, 'kept'] as const),
            ...change.partial.undone.map((index) => [index, 'undone'] as const),
          ])
        : undefined,
    [change.partial],
  );
  const selectable = waiting && diff.selectable && !change.changedSince && Boolean(record?.after);
  const n = diff.hunks.length;
  const k = kept.size;
  const mine = comments.filter((comment) => comment.target.kind === 'change' && comment.target.changeId === change.id);
  const now = latest !== undefined ? latest : change.current;
  const sinceDiff = useMemo(
    () =>
      since || (waiting && change.changedSince)
        ? buildDiff({ path: change.path, before: change.after, after: now })
        : null,
    [since, waiting, change.changedSince, change.path, change.after, now],
  );
  /**
   * Read the file as it is now, through the Files read path. That read records
   * an outside edit in History, so the next project state knows it too.
   */
  const reviewAgain = () => {
    setSince(true);
    readDocument(projectId, change.path)
      .then((content) => setLatest(content.text))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) setLatest(null);
        else onError?.(error instanceof Error ? error : new Error(String(error)));
      });
  };

  const act = async (action: () => Promise<unknown>) => {
    setWorking(true);
    setConflict(null);
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(error.message);
      else onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setWorking(false);
    }
  };
  const whole = (action: 'keep' | 'undo') => act(() => reviewWhole(projectId, change.id, action));
  const partial = () =>
    act(() =>
      keepPart(projectId, change.id, {
        after: record!.after!,
        keep: all.filter((index) => kept.has(index)),
        undo: all.filter((index) => !kept.has(index)),
      }),
    );

  return (
    <article className="cdiff-card" data-change={change.id}>
      <div className="cdiff-title">
        <button
          type="button"
          className="cdiff-path"
          aria-expanded={open}
          title={change.path}
          onClick={() => setOpen(!open)}
        >
          {change.path}
        </button>
        <span className="cdiff-state">{stateWord(change)}</span>
      </div>
      {open && (
        <>
          <DiffView
            diff={diff}
            selection={
              selectable
                ? {
                    kept,
                    disabled: working,
                    onToggle: (index) => {
                      const next = new Set(kept);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      setKept(next);
                    },
                  }
                : undefined
            }
            comments={mine}
            decisions={decisions}
            commentable={diff.state === 'changed' ? 'both' : undefined}
            onComment={async (anchor, text) => {
              await addComment(projectId, {
                target: { kind: 'change', changeId: change.id },
                hunk: anchor.hunk,
                side: anchor.side,
                line: anchor.line,
                text,
              });
            }}
            onResolve={async (comment, resolved) => {
              await resolveComment(projectId, comment.id, resolved);
            }}
          />
          {conflict && (
            <p className="cdiff-conflict" role="alert">
              {conflict}{' '}
              {!since && (
                <button type="button" onClick={reviewAgain}>
                  Review again
                </button>
              )}
            </p>
          )}
          {waiting && change.changedSince && !conflict && (
            <p className="cdiff-conflict">
              {change.path} changed after this change was made, so it can be kept or undone only as a
              whole.
            </p>
          )}
          {sinceDiff && sinceDiff.state !== 'identical' && (
            <div className="cdiff-since">
              <p className="cdiff-note">Since this change was made:</p>
              <DiffView diff={sinceDiff} />
            </div>
          )}
          {waiting && (
            <div className="cdiff-actions">
              {selectable && k > 0 && k < n ? (
                <>
                  <button type="button" className="primary" disabled={working} onClick={() => void partial()}>
                    Keep {k} of {n} changes
                  </button>
                  <button type="button" disabled={working} onClick={() => void whole('undo')}>
                    Undo all
                  </button>
                </>
              ) : selectable && k === 0 ? (
                <>
                  <button type="button" className="primary" disabled={working} onClick={() => void whole('undo')}>
                    Undo
                  </button>
                  <button type="button" disabled={working} onClick={() => void whole('keep')}>
                    Keep all
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="primary" disabled={working} onClick={() => void whole('keep')}>
                    Keep
                  </button>
                  <button type="button" disabled={working} onClick={() => void whole('undo')}>
                    Undo
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}

function RevisePanel({
  projectId,
  task,
  route,
  comments,
  onError,
}: {
  projectId: string;
  task: Task;
  /** The route of the run that made the changes: a revision goes back to it. */
  route: Route;
  comments: readonly ReviewComment[];
  onError?(error: Error): void;
}) {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState('');
  const [commandId, setCommandId] = useState(mintCommandId);
  const [working, setWorking] = useState(false);
  const [queued, setQueued] = useState(false);
  const picked = comments.filter((comment) => !left.has(comment.id));
  const message = revisionRequest(picked, note);
  const fits = revisionFits(message);

  if (!open)
    return (
      <div className="cdiff-actions cdiff-revise-open">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setQueued(false);
          }}
        >
          Revise with these comments ({comments.length})
        </button>
        {queued && <span className="cdiff-note" role="status">Queued as a follow-up.</span>}
      </div>
    );
  return (
    <div className="cdiff-revise" role="group" aria-label="Revise with these comments">
      <ul>
        {comments.map((comment) => (
          <li key={comment.id}>
            <label>
              <input
                type="checkbox"
                checked={!left.has(comment.id)}
                onChange={() => {
                  const next = new Set(left);
                  if (next.has(comment.id)) next.delete(comment.id);
                  else next.add(comment.id);
                  setLeft(next);
                }}
              />
              <span>
                {commentPlace(comment)}: {comment.text}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <textarea
        rows={2}
        maxLength={1000}
        value={note}
        placeholder="Add a note (optional)"
        aria-label="Note for the revision"
        onChange={(event) => setNote(event.target.value)}
      />
      <p className="cdiff-note">
        This message is queued as a follow-up for {task.name}, on {routeDisplayName(route)}:
      </p>
      <pre className="cdiff-message">{message}</pre>
      {!fits && <p className="cdiff-conflict">This is too long for one request. Send fewer comments at a time.</p>}
      <div className="cdiff-actions">
        <button
          type="button"
          className="primary"
          disabled={working || !picked.length || !fits}
          onClick={() => {
            setWorking(true);
            reviseWithComments(projectId, {
              protocolVersion: 1,
              commandId,
              taskId: task.id,
              commentIds: picked.map((comment) => comment.id),
              route,
              note,
            })
              .then(() => {
                setOpen(false);
                setQueued(true);
                setNote('');
                setLeft(new Set());
                setCommandId(mintCommandId());
              })
              .catch((error: unknown) => onError?.(error instanceof Error ? error : new Error(String(error))))
              .finally(() => setWorking(false));
          }}
        >
          Queue the revision
        </button>
        <button type="button" disabled={working} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ChangeDiffs({
  projectId,
  task,
  changes,
  history,
  comments,
  route,
  onError,
}: {
  projectId: string;
  task: Task;
  changes: readonly Change[];
  history: readonly HistoryEntry[];
  comments: readonly ReviewComment[];
  route: Route;
  onError?(error: Error): void;
}) {
  const headingId = useId();
  const mine = changes.filter((change) => change.taskId === task.id);
  if (!mine.length) return null;
  const paths = new Set(mine.map((change) => change.path));
  const waiting = mine.filter((change) => change.state === 'waiting').length;
  const unsent = comments.filter(
    (comment) =>
      !comment.resolved &&
      !comment.sent &&
      (comment.target.kind === 'change' ? comment.taskId === task.id : paths.has(comment.target.path)),
  );
  return (
    <section className="cdiff" aria-labelledby={headingId}>
      <header className="cdiff-head">
        <h2 id={headingId}>Review changes</h2>
        {waiting > 0 && <span className="caption">{waiting} waiting for you</span>}
      </header>
      {mine.map((change) => (
        <ChangeDiffCard
          key={change.id}
          projectId={projectId}
          change={change}
          history={history}
          comments={comments}
          onError={onError}
        />
      ))}
      {unsent.length > 0 && (
        <RevisePanel projectId={projectId} task={task} route={route} comments={unsent} onError={onError} />
      )}
    </section>
  );
}
