/**
 * Keeping part of a waiting Change (P06).
 *
 * A run's change to one file can touch several places. A person may keep some
 * of those hunks and undo the rest; the result is one new recorded write,
 * through the one recorded writer (`Store.writeRecorded`), attributed to the
 * person, base-hash checked against the exact version the run wrote, and
 * carrying on its History entry which hunks were kept and which undone.
 *
 * The hunks are recomputed here from the two versions History recorded, never
 * taken from the request, so the text written is the text the person was
 * shown. If the file has moved on since the run wrote it, nothing is written
 * and the refusal says who changed it and when, so the person can review it
 * again. Whole-change Keep and Undo are unchanged and stay the way to settle a
 * change with one hunk, a created or deleted file, or a change too large to
 * keep piece by piece.
 *
 * Called with the store lock held (the route helper takes it).
 */
import { createHash } from 'node:crypto';
import { ApiError } from '../paths.js';
import { hash, type Store } from '../store.js';
import { applyHunkSelection, buildDiff } from '../../shared/text-diff.js';
import {
  partialKeepSchema,
  type HunkReviewRecord,
} from '../../shared/review-comments.js';
import type { Change } from '../../shared/types.js';

const ACTIVE = ['queued', 'working', 'waiting'];

export interface PartialKeepResult {
  change: Change;
  entryId: string;
}

export async function keepPartially(
  store: Store,
  projectId: string,
  changeId: string,
  request: unknown,
): Promise<PartialKeepResult> {
  const parsed = partialKeepSchema.safeParse(request);
  if (!parsed.success)
    throw new ApiError(400, 'Name the version you reviewed and which changes to keep and undo.');
  const { after, keep, undo } = parsed.data;
  const state = store.state(projectId);
  const change = state.changes.find((item) => item.id === changeId);
  if (!change) throw new ApiError(404, 'This change was not found.');
  if (change.state !== 'waiting') throw new ApiError(409, 'This change has already been reviewed.');
  const session = change.sessionId
    ? state.sessions.find((item) => item.id === change.sessionId)
    : undefined;
  if (session && ACTIVE.includes(session.state))
    throw new ApiError(409, 'The run that made this change is still working. Wait for it to finish.');
  const entry = state.history.find((item) => item.id === change.entryId);
  const file = entry?.files.find((item) => item.path === change.path);
  if (!entry || !file || !file.recorded || file.binary || file.op !== 'modified' || !file.before || !file.after)
    throw new ApiError(
      409,
      'Only a recorded change to an existing text file can be kept in part. Keep or undo it whole.',
    );
  if (after !== file.after)
    throw new ApiError(
      409,
      `The run changed ${change.path} again after you opened it. Review the newest version before keeping part of it.`,
      { code: 'change_moved', path: change.path, afterSha: file.after },
    );
  const before = await store.object(projectId, file.before);
  const written = await store.object(projectId, file.after);
  if (before === null || written === null)
    throw new ApiError(409, 'The recorded versions of this change are no longer available.');
  const diff = buildDiff({ path: change.path, before, after: written });
  if (!diff.selectable)
    throw new ApiError(
      409,
      diff.hunks.length < 2
        ? 'This change has one part, so keep or undo it whole.'
        : 'This change is too large to keep piece by piece. Keep or undo it whole.',
    );
  const all = diff.hunks.map((hunk) => hunk.index);
  const named = [...keep, ...undo];
  if (
    named.length !== all.length ||
    new Set(named).size !== all.length ||
    named.some((index) => !all.includes(index))
  )
    throw new ApiError(400, `Decide each of the ${all.length} changes once: keep it or undo it.`);
  if (!keep.length || !undo.length)
    throw new ApiError(
      400,
      keep.length ? 'Every change is kept, so use Keep.' : 'Every change is undone, so use Undo.',
    );
  const text = applyHunkSelection(before, written, keep);
  const kept = new Set(keep);
  const record: HunkReviewRecord = {
    changeId: change.id,
    sourceEntryId: entry.id,
    path: change.path,
    beforeSha: file.before,
    afterSha: file.after,
    resultSha: hash(text)!,
    by: 'you',
    hunks: diff.hunks.map((hunk) => ({
      index: hunk.index,
      decision: kept.has(hunk.index) ? 'kept' : 'undone',
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      added: hunk.added,
      removed: hunk.removed,
      sha: createHash('sha256')
        .update(hunk.lines.map((line) => `${line.kind === 'added' ? '+' : '-'}${line.text}\n`).join(''))
        .digest('hex'),
    })),
  };
  let recorded;
  try {
    recorded = await store.writeRecorded(
      projectId,
      [{ path: change.path, text, expected: file.after }],
      {
        actor: 'you',
        kind: 'partial-keep',
        sentence: `You kept ${keep.length} of ${all.length} changes to ${change.path} and undid ${undo.length}`,
        taskId: change.taskId,
        merge: false,
        hunkReview: record,
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const latest = store.latestFile(store.state(projectId), change.path);
      const by =
        latest && latest.entry.id !== entry.id && latest.file.after === (error.details as { currentSha?: string } | undefined)?.currentSha
          ? latest.entry.actor === 'you'
            ? 'you'
            : 'Diomedes'
          : 'someone outside Diomedes';
      throw new ApiError(
        409,
        `${change.path} was changed by ${by} after this change was made, so nothing was written. Review it again against the current file.`,
        {
          code: 'change_conflict',
          path: change.path,
          expectedSha: file.after,
          currentSha: (error.details as { currentSha?: string | null } | undefined)?.currentSha ?? null,
        },
      );
    }
    throw error;
  }
  const fresh = store.state(projectId);
  const settled = fresh.changes.find((item) => item.id === changeId)!;
  settled.state = 'kept';
  settled.partial = { entryId: recorded.id, kept: [...keep].sort((a, b) => a - b), undone: [...undo].sort((a, b) => a - b) };
  const task = fresh.tasks.find((item) => item.id === settled.taskId);
  if (task && !fresh.changes.some((item) => item.taskId === task.id && item.state === 'waiting')) {
    store.moveTask(fresh, task, 'done', 'diomedes');
    task.reason = null;
  }
  await store.persist(fresh);
  return { change: settled, entryId: recorded.id };
}

