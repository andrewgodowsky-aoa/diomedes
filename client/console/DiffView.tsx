import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  DIFF_LIMITS,
  foldContext,
  hunkPlace,
  sideBySide,
  type DiffHunk,
  type DiffLine,
  type TextDiff,
} from '../../shared/text-diff';
import type { ReviewComment } from '../../shared/review-comments';
import { time } from '../components';
import './diff-view.css';

/**
 * P06: one readable diff, wherever text is compared — a waiting Change in a
 * thread, a recorded write in the Change review panel, or two History versions
 * of a file in Files. Unified or side by side, unchanged lines folded around
 * each change, word-level marks inside a changed line, and a plain sentence on
 * top. A diff that cannot be shown line by line (not text, too large, contents
 * not kept) says why instead.
 *
 * Optional, and only where the caller offers them: a Keep checkbox per change
 * for a partial keep, and comments anchored to a line.
 */

export type DiffLayout = 'unified' | 'split';
export interface CommentAnchorPick {
  hunk: number | null;
  side: 'old' | 'new';
  line: number;
}

const LAYOUT_KEY = 'console.diff.layout';
function savedLayout(): DiffLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

/** Where a line takes a comment: removed lines on the earlier side, everything else on the later. */
function anchorOf(line: DiffLine): { side: 'old' | 'new'; line: number } {
  return line.kind === 'removed' ? { side: 'old', line: line.oldNo! } : { side: 'new', line: line.newNo! };
}

const MARK = { context: ' ', added: '+', removed: '−' } as const;
const SPOKEN = { context: '', added: 'Added: ', removed: 'Removed: ' } as const;

function LineText({ line }: { line: DiffLine }) {
  if (!line.words) return <>{line.text || ' '}</>;
  return (
    <>
      {line.words.map((word, index) =>
        word.kind === 'same' ? (
          <Fragment key={index}>{word.text}</Fragment>
        ) : (
          <mark key={index} className={`dv-w ${word.kind}`}>
            {word.text}
          </mark>
        ),
      )}
    </>
  );
}

export function DiffView({
  diff,
  selection,
  comments = [],
  commentable,
  onComment,
  onResolve,
  decisions,
}: {
  diff: TextDiff;
  /** Per-change keep choices, offered only while the change can be kept in part. */
  selection?: { kept: ReadonlySet<number>; onToggle(index: number): void; disabled?: boolean };
  comments?: readonly ReviewComment[];
  /** Which lines may take a new comment; absent, none. */
  commentable?: 'both' | 'new';
  onComment?(anchor: CommentAnchorPick, text: string): Promise<void>;
  onResolve?(comment: ReviewComment, resolved: boolean): Promise<void>;
  /** What a partial keep decided for each change, shown on a settled change. */
  decisions?: ReadonlyMap<number, 'kept' | 'undone'>;
}) {
  const [layout, setLayout] = useState<DiffLayout>(savedLayout);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [composing, setComposing] = useState<CommentAnchorPick | null>(null);
  const [draft, setDraft] = useState('');
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const bySpot = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      const key = `${comment.anchor.side}:${comment.anchor.line}`;
      map.set(key, [...(map.get(key) ?? []), comment]);
    }
    return map;
  }, [comments]);

  const choose = (next: DiffLayout) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // A per-viewer convenience only.
    }
  };

  const act = async (action: () => Promise<void>) => {
    setWorking(true);
    setProblem(null);
    try {
      await action();
      return true;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That could not be saved.');
      return false;
    } finally {
      setWorking(false);
    }
  };

  const canComment = (line: DiffLine) =>
    Boolean(onComment && commentable && (commentable === 'both' || line.kind !== 'removed'));

  /** Comments at this line, and the composer when it is open here. */
  const thread = (line: DiffLine, hunk: number | null): ReactNode => {
    const spot = anchorOf(line);
    const here = bySpot.get(`${spot.side}:${spot.line}`) ?? [];
    const composingHere = composing?.side === spot.side && composing.line === spot.line;
    if (!here.length && !composingHere) return null;
    return (
      <div className="dv-comments">
        {here.map((comment) => (
          <div key={comment.id} className={`dv-comment${comment.resolved ? ' resolved' : ''}`} data-comment={comment.id}>
            <p className="dv-comment-text">{comment.text}</p>
            <p className="dv-comment-meta">
              <span>You · {time(comment.at)}</span>
              {comment.sent && <span>sent with a revision request</span>}
              {comment.resolved && <span>resolved</span>}
              {onResolve && (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void act(() => onResolve(comment, !comment.resolved))}
                >
                  {comment.resolved ? 'Reopen' : 'Resolve'}
                </button>
              )}
            </p>
          </div>
        ))}
        {composingHere && (
          <form
            className="dv-compose"
            onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              if (!text || !onComment) return;
              void act(() => onComment({ hunk, ...spot }, text)).then((saved) => {
                if (saved) {
                  setComposing(null);
                  setDraft('');
                }
              });
            }}
          >
            <textarea
              autoFocus
              rows={2}
              maxLength={2000}
              value={draft}
              aria-label={`Comment on line ${spot.line}`}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="dv-compose-actions">
              <button type="submit" disabled={working || !draft.trim()}>
                Save comment
              </button>
              <button
                type="button"
                onClick={() => {
                  setComposing(null);
                  setDraft('');
                  setProblem(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {problem && composingHere && (
          <p className="dv-problem" role="alert">
            {problem}
          </p>
        )}
      </div>
    );
  };

  const commentButton = (line: DiffLine, hunk: number | null) => {
    if (!canComment(line)) return null;
    const spot = anchorOf(line);
    return (
      <button
        type="button"
        className="dv-add"
        aria-label={`Comment on ${spot.side === 'old' ? 'earlier ' : ''}line ${spot.line}`}
        title="Comment on this line"
        onClick={() => {
          setComposing({ hunk, ...spot });
          setDraft('');
          setProblem(null);
        }}
      >
        +
      </button>
    );
  };

  const unifiedRow = (line: DiffLine, hunk: number | null, key: string) => (
    <Fragment key={key}>
      <div className={`dv-row ${line.kind}`}>
        <span className="dv-no">{line.oldNo ?? ''}</span>
        <span className="dv-no">{line.newNo ?? ''}</span>
        <span className="dv-mark" aria-hidden="true">
          {MARK[line.kind]}
        </span>
        <span className="dv-text">
          {SPOKEN[line.kind] && <span className="dv-sr">{SPOKEN[line.kind]}</span>}
          <LineText line={line} />
        </span>
        {commentButton(line, hunk)}
      </div>
      {thread(line, hunk)}
    </Fragment>
  );

  const splitCell = (line: DiffLine | null, side: 'old' | 'new') =>
    line ? (
      <>
        <span className="dv-no">{side === 'old' ? line.oldNo : line.newNo}</span>
        <span className={`dv-text ${line.kind}`}>
          {SPOKEN[line.kind] && <span className="dv-sr">{SPOKEN[line.kind]}</span>}
          <LineText line={line} />
        </span>
      </>
    ) : (
      <>
        <span className="dv-no" />
        <span className="dv-text blank" />
      </>
    );

  const splitRow = (left: DiffLine | null, right: DiffLine | null, hunk: number | null, key: string) => {
    return (
      <Fragment key={key}>
        <div className="dv-split-row">
          {splitCell(left, 'old')}
          {splitCell(right, 'new')}
          <span className="dv-split-add">
            {left && left.kind === 'removed' && commentButton(left, hunk)}
            {right && commentButton(right, hunk)}
          </span>
        </div>
        {left && left.kind === 'removed' && thread(left, hunk)}
        {right && thread(right, hunk)}
      </Fragment>
    );
  };

  const contextRows = (lines: readonly DiffLine[], key: string) =>
    lines.map((line, index) =>
      layout === 'split' ? splitRow(line, line, null, `${key}-${index}`) : unifiedRow(line, null, `${key}-${index}`),
    );

  if (diff.state !== 'changed')
    return (
      <div className={`dv dv-${diff.state}`} data-diff-state={diff.state}>
        <p className="dv-head">{diff.header}</p>
        {diff.reason && diff.reason !== diff.header && <p className="dv-note">{diff.reason}</p>}
      </div>
    );

  let budget = DIFF_LIMITS.maxRenderedLines;
  let stopped = false;
  const body: ReactNode[] = [];
  diff.segments.forEach((segment, index) => {
    if (stopped) return;
    if (segment.kind === 'context') {
      const position =
        diff.segments.length === 1
          ? 'only'
          : index === 0
            ? 'first'
            : index === diff.segments.length - 1
              ? 'last'
              : 'middle';
      const folded = foldContext(segment.lines, position);
      const anchored = folded.hidden.some((line) => bySpot.has(`new:${line.newNo}`));
      if (!folded.hidden.length || open.has(index) || anchored) {
        body.push(...contextRows(segment.lines, `c${index}`));
        return;
      }
      body.push(...contextRows(folded.head, `h${index}`));
      body.push(
        <button
          key={`f${index}`}
          type="button"
          className="dv-fold"
          onClick={() => setOpen(new Set([...open, index]))}
        >
          Show {folded.hidden.length} unchanged {folded.hidden.length === 1 ? 'line' : 'lines'}
        </button>,
      );
      body.push(...contextRows(folded.tail, `t${index}`));
      return;
    }
    const hunk: DiffHunk = diff.hunks[segment.hunk];
    if (hunk.lines.length > budget) {
      stopped = true;
      return;
    }
    budget -= hunk.lines.length;
    const label = `change ${hunk.index + 1} of ${diff.hunks.length}`;
    body.push(
      <div key={`hh${hunk.index}`} className="dv-hunk-head" data-hunk={hunk.index}>
        {selection ? (
          <label className="dv-keep">
            <input
              type="checkbox"
              checked={selection.kept.has(hunk.index)}
              disabled={selection.disabled}
              onChange={() => selection.onToggle(hunk.index)}
            />
            Keep {label}
          </label>
        ) : (
          <span className="dv-hunk-name">{label[0].toUpperCase() + label.slice(1)}</span>
        )}
        <span className="dv-place">{hunkPlace(hunk)}</span>
        {selection && !selection.kept.has(hunk.index) && <span className="dv-undoing">will be undone</span>}
        {!selection && decisions?.get(hunk.index) && (
          <span className={`dv-decision ${decisions.get(hunk.index)}`}>{decisions.get(hunk.index)}</span>
        )}
      </div>,
    );
    if (layout === 'split')
      sideBySide(hunk).forEach((row, rowIndex) =>
        body.push(splitRow(row.left, row.right, hunk.index, `s${hunk.index}-${rowIndex}`)),
      );
    else hunk.lines.forEach((line, lineIndex) => body.push(unifiedRow(line, hunk.index, `u${hunk.index}-${lineIndex}`)));
  });
  const shown = DIFF_LIMITS.maxRenderedLines - budget;
  const hidden = diff.added + diff.removed - shown;

  return (
    <div className={`dv dv-${layout}`} data-diff-state={diff.state}>
      <div className="dv-bar">
        <p className="dv-head">{diff.header}</p>
        <div className="seg" role="radiogroup" aria-label="Diff layout">
          {(['unified', 'split'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={layout === choice}
              className={layout === choice ? 'on' : ''}
              onClick={() => choose(choice)}
            >
              {choice === 'unified' ? 'Unified' : 'Side by side'}
            </button>
          ))}
        </div>
      </div>
      <div className="dv-body">{body}</div>
      {hidden > 0 && (
        <p className="dv-note">
          {hidden} more changed {hidden === 1 ? 'line is' : 'lines are'} not shown here.
        </p>
      )}
      {problem && !composing && (
        <p className="dv-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
