import { api } from '../api';
import type { FileIdentity } from '../../shared/file-identity';
import type { TextDiff } from '../../shared/text-diff';
import type {
  AddCommentRequest,
  PartialKeepRequest,
  ReviewComment,
  ReviseRequest,
} from '../../shared/review-comments';
import type { Change } from '../../shared/types';
import type { FollowUpCommand } from '../../shared/work-control';

// P06: readable diffs, partial keeps and review comments. Every call is an
// ordinary project route; the next project state carries the result.

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

/** Keep or undo a whole waiting change (the existing review route). */
export const reviewWhole = (projectId: string, changeId: string, action: 'keep' | 'undo') =>
  api<{ change: Change }>(`${base(projectId)}/review/${encodeURIComponent(changeId)}`, 'POST', { action });

/** Keep some hunks and undo the rest, against the exact version the person reviewed. */
export const keepPart = (projectId: string, changeId: string, request: PartialKeepRequest) =>
  api<{ change: Change; entryId: string }>(
    `${base(projectId)}/review/${encodeURIComponent(changeId)}/partial`,
    'POST',
    request,
  );

/** The difference between two recorded versions; `to` absent is the current file. */
export const versionDiff = (
  projectId: string,
  path: string,
  from: string | null,
  to: string | null,
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams({ path });
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  return api<{ diff: TextDiff; from: FileIdentity | null; to: FileIdentity | null }>(
    `${base(projectId)}/documents/diff?${query.toString()}`,
    'GET',
    undefined,
    signal,
  );
};

export const listComments = (projectId: string, signal?: AbortSignal) =>
  api<{ comments: ReviewComment[] }>(`${base(projectId)}/review-comments`, 'GET', undefined, signal).then(
    (result) => result.comments,
  );

export const addComment = (projectId: string, request: AddCommentRequest) =>
  api<{ comment: ReviewComment }>(`${base(projectId)}/review-comments`, 'POST', request).then(
    (result) => result.comment,
  );

export const resolveComment = (projectId: string, commentId: string, resolved: boolean) =>
  api<{ comment: ReviewComment }>(
    `${base(projectId)}/review-comments/${encodeURIComponent(commentId)}/resolve`,
    'POST',
    { resolved },
  ).then((result) => result.comment);

/** Queue the chosen comments as one follow-up; the queue shows what becomes of it. */
export const reviseWithComments = (projectId: string, request: ReviseRequest) =>
  api<{ followUp: FollowUpCommand; comments: ReviewComment[] }>(
    `${base(projectId)}/review-comments/revise`,
    'POST',
    request,
  );
