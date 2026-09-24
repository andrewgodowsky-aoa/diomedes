import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HistoryEntry } from '../../shared/types';
import { versionsOf } from '../../shared/file-identity';
import type { TextDiff } from '../../shared/text-diff';
import type { ReviewComment } from '../../shared/review-comments';
import { DiffView } from './DiffView';
import { addComment, listComments, resolveComment, versionDiff } from './review-api';

/**
 * P06 from a file's version list: what this recorded version changed from the
 * version before it, or how it differs from the file now. Comments are left on
 * a line of this version — its durable identity `{ path, sha }` — and stay with
 * it, resolvable, whatever happens to the file later. Nothing here writes the
 * file.
 */
export function VersionCompare({
  projectId,
  path,
  sha,
  current,
  history,
}: {
  projectId: string;
  path: string;
  sha: string;
  /** This version is the file as it is now. */
  current: boolean;
  history: readonly HistoryEntry[];
}) {
  const previous = useMemo(() => {
    const versions = versionsOf(history, path);
    const index = versions.findIndex((version) => version.sha === sha);
    return index >= 0 ? (versions[index + 1] ?? null) : null;
  }, [history, path, sha]);
  const [compare, setCompare] = useState<'previous' | 'current' | null>(null);
  const [diff, setDiff] = useState<TextDiff | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);

  const refresh = useCallback(
    (signal?: AbortSignal) =>
      listComments(projectId, signal)
        .then((all) =>
          setComments(all.filter((c) => c.target.kind === 'version' && c.target.path === path && c.target.sha === sha)),
        )
        .catch(() => undefined),
    [projectId, path, sha],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!compare) return;
    const controller = new AbortController();
    setDiff(null);
    setFailure(null);
    const request =
      compare === 'previous'
        ? versionDiff(projectId, path, previous!.sha, sha, controller.signal)
        : versionDiff(projectId, path, sha, null, controller.signal);
    request
      .then((result) => setDiff(result.diff))
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(error instanceof Error ? error.message : 'The versions could not be compared.');
      });
    return () => controller.abort();
  }, [compare, projectId, path, sha, previous]);

  const open = comments.filter((c) => !c.resolved).length;
  if (!previous && current && !comments.length) return null;
  return (
    <div className="files-compare">
      <div className="seg" role="radiogroup" aria-label="Compare this version">
        {previous && (
          <button
            type="button"
            role="radio"
            aria-checked={compare === 'previous'}
            className={compare === 'previous' ? 'on' : ''}
            onClick={() => setCompare(compare === 'previous' ? null : 'previous')}
          >
            Changes from the version before
          </button>
        )}
        {!current && (
          <button
            type="button"
            role="radio"
            aria-checked={compare === 'current'}
            className={compare === 'current' ? 'on' : ''}
            onClick={() => setCompare(compare === 'current' ? null : 'current')}
          >
            Compare with the current file
          </button>
        )}
      </div>
      {!compare && open > 0 && (
        <p className="caption">
          {open} open {open === 1 ? 'comment' : 'comments'} on this version, shown with its changes.
        </p>
      )}
      {failure && (
        <p className="caption files-fail" role="alert">
          {failure}
        </p>
      )}
      {compare && !diff && !failure && (
        <p className="caption" role="status">
          Comparing...
        </p>
      )}
      {diff && compare === 'previous' && (
        <DiffView
          diff={diff}
          comments={comments}
          commentable="new"
          onComment={async (anchor, text) => {
            await addComment(projectId, {
              target: { kind: 'version', path, sha },
              side: 'new',
              line: anchor.line,
              text,
            });
            await refresh();
          }}
          onResolve={async (comment, resolved) => {
            await resolveComment(projectId, comment.id, resolved);
            await refresh();
          }}
        />
      )}
      {diff && compare === 'current' && <DiffView diff={diff} />}
    </div>
  );
}
