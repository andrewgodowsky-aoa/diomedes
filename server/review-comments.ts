/**
 * P06 on the server: readable differences between recorded versions, and
 * durable review comments with the one way they reach a run.
 *
 * Every text compared or quoted here is read through the paths a person can
 * already read — the recorded objects History names (`versionBytes`, the same
 * lookup Files uses to open an older version) and the change records — so no
 * route reads a file it could not read before. Comments live on the project
 * state beside the follow-up queue; resolving one keeps it, and nothing
 * deletes one (decision 10).
 *
 * `revise` composes the exact message the person was shown
 * (`revisionRequest`) and hands it to the ordinary follow-up queue, which
 * starts work only through the Work start route's own admission path. It
 * grants nothing and widens nothing: a route that has no consent, a task that
 * is gone or a busy project is refused there, visibly, on the follow-up.
 *
 * Every method is called with the store lock held (the route helper takes it).
 */
import { ApiError } from './paths.js';
import { identifier, now, type Store } from './store.js';
import { versionBytes } from './file-drops.js';
import { plainText } from '../shared/file-drops.js';
import { identityOf, isSha256, type FileIdentity } from '../shared/file-identity.js';
import { buildDiff, splitLines, type TextDiff } from '../shared/text-diff.js';
import {
  addCommentSchema,
  MAX_QUOTE_CHARS,
  resolveCommentSchema,
  revisionFits,
  revisionRequest,
  reviseSchema,
  type ReviewComment,
  type ReviewCommentAnchor,
  type ReviewCommentTarget,
} from '../shared/review-comments.js';
import type { FollowUpCommand, QueueFollowUpRequest } from '../shared/work-control.js';

/** Enough for years of review on one project, and a bound on what state.json carries. */
export const MAX_COMMENTS_PER_PROJECT = 5_000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface DocumentDiff {
  diff: TextDiff;
  from: FileIdentity | null;
  to: FileIdentity | null;
}

async function textOf(store: Store, projectId: string, path: string, sha: string | undefined) {
  const found = await versionBytes(store, projectId, path, sha);
  return { ...found, text: plainText(found.bytes) };
}

/**
 * The difference between two recorded versions of one file. `from` absent
 * compares against nothing (the file as first written); `to` absent means the
 * file as it is now. Each sha must be one History recorded for this path.
 */
export async function documentDiff(
  store: Store,
  projectId: string,
  input: unknown,
  from: unknown,
  to: unknown,
): Promise<DocumentDiff> {
  if (from !== undefined && !isSha256(from))
    throw new ApiError(400, 'This file reference is not a recorded version.');
  if (to !== undefined && !isSha256(to))
    throw new ApiError(400, 'This file reference is not a recorded version.');
  const later = await textOf(store, projectId, input as string, to as string | undefined);
  const earlier = from === undefined ? null : await textOf(store, projectId, later.path, from as string);
  const history = store.state(projectId).history;
  const binary = later.text === null || (earlier !== null && earlier.text === null);
  return {
    diff: buildDiff({
      path: later.path,
      before: earlier ? (earlier.text ?? '') : null,
      after: later.text ?? '',
      binary,
    }),
    from: earlier ? identityOf(history, later.path, earlier.sha) : null,
    to: identityOf(history, later.path, later.sha),
  };
}

export class ReviewComments {
  constructor(
    private store: Store,
    /** The follow-up queue's own `queue`, so a revision is an ordinary follow-up. */
    private queue: (projectId: string, request: QueueFollowUpRequest) => Promise<FollowUpCommand>,
  ) {}

  list(projectId: string): ReviewComment[] {
    return [...(this.store.state(projectId).reviewComments ?? [])];
  }

  private comment(projectId: string, commentId: string): Mutable<ReviewComment> {
    const found = (this.store.state(projectId).reviewComments ?? []).find(
      (item) => item.id === commentId,
    );
    if (!found) throw new ApiError(404, 'This comment was not found.');
    return found as Mutable<ReviewComment>;
  }

  /** The recorded text a change's two sides were computed from, and its hunks. */
  private async changeSides(projectId: string, changeId: string) {
    const state = this.store.state(projectId);
    const change = state.changes.find((item) => item.id === changeId);
    if (!change) throw new ApiError(404, 'This change was not found.');
    const entry = state.history.find((item) => item.id === change.entryId);
    const file = entry?.files.find((item) => item.path === change.path);
    if (!file || !file.recorded || file.binary || !file.after)
      throw new ApiError(409, 'Only a recorded change to a text file can carry comments.');
    const before = await this.store.object(projectId, file.before);
    const after = await this.store.object(projectId, file.after);
    return { change, sha: file.after, before, after };
  }

  async add(projectId: string, request: unknown): Promise<ReviewComment> {
    const parsed = addCommentSchema.safeParse(request);
    if (!parsed.success)
      throw new ApiError(400, 'Write a comment and choose the line it is about.');
    const { target: wanted, side, line, text } = parsed.data;
    const state = this.store.state(projectId);
    if ((state.reviewComments?.length ?? 0) >= MAX_COMMENTS_PER_PROJECT)
      throw new ApiError(409, `This project holds ${MAX_COMMENTS_PER_PROJECT} comments, the most it can keep.`);
    let target: ReviewCommentTarget;
    let taskId: string | null;
    let lines: string[];
    let hunk: number | null = null;
    if (wanted.kind === 'change') {
      const sides = await this.changeSides(projectId, wanted.changeId);
      // A run still writing the change can rewrite the same entry under the same
      // change id, which would move the line out from under the comment.
      const session = sides.change.sessionId
        ? state.sessions.find((item) => item.id === sides.change.sessionId)
        : undefined;
      if (session && ['queued', 'working', 'waiting'].includes(session.state))
        throw new ApiError(409, 'The run that made this change is still working. Comment on it when it finishes.');
      target = { kind: 'change', changeId: sides.change.id, path: sides.change.path, sha: sides.sha };
      taskId = sides.change.taskId;
      lines = splitLines((side === 'old' ? sides.before : sides.after) ?? '');
      const diff = buildDiff({ path: sides.change.path, before: sides.before, after: sides.after });
      hunk =
        diff.hunks.find((item) =>
          item.lines.some((row) =>
            side === 'old'
              ? row.kind === 'removed' && row.oldNo === line
              : row.kind === 'added' && row.newNo === line,
          ),
        )?.index ?? null;
    } else {
      if (side !== 'new')
        throw new ApiError(400, 'A comment on a file version is about a line of that version.');
      const found = await textOf(this.store, projectId, wanted.path, wanted.sha);
      if (found.text === null)
        throw new ApiError(415, 'This version is not text, so a comment cannot point at one of its lines.');
      target = { kind: 'version', path: found.path, sha: found.sha };
      taskId = null;
      lines = splitLines(found.text);
    }
    if (parsed.data.hunk !== null && parsed.data.hunk !== hunk)
      throw new ApiError(400, 'That line is not part of the change it was attached to.');
    if (line > lines.length) throw new ApiError(400, 'That line is not in this version of the file.');
    const anchor: ReviewCommentAnchor = {
      hunk,
      side,
      line,
      quote: lines[line - 1].slice(0, MAX_QUOTE_CHARS),
    };
    const comment: ReviewComment = {
      id: identifier('C'),
      target,
      taskId,
      anchor,
      text,
      by: 'you',
      at: now(),
      resolved: null,
      sent: null,
    };
    state.reviewComments ??= [];
    state.reviewComments.push(comment);
    await this.store.persist(state);
    return structuredClone(comment);
  }

  async resolve(projectId: string, commentId: string, request: unknown): Promise<ReviewComment> {
    const parsed = resolveCommentSchema.safeParse(request);
    if (!parsed.success) throw new ApiError(400, 'Say whether the comment is resolved.');
    const comment = this.comment(projectId, commentId);
    comment.resolved = parsed.data.resolved ? { at: now(), by: 'you' } : null;
    await this.store.persist(this.store.state(projectId));
    return structuredClone(comment as ReviewComment);
  }

  /**
   * Queue the chosen open comments as one follow-up for the task. Nothing is
   * marked sent unless the queue accepted it.
   */
  async revise(projectId: string, request: unknown) {
    const parsed = reviseSchema.safeParse(request);
    if (!parsed.success)
      throw new ApiError(400, 'Choose the comments to send, the task and the route.');
    const { commandId, taskId, commentIds, route, note } = parsed.data;
    const state = this.store.state(projectId);
    const task = state.tasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task) throw new ApiError(404, 'This task was not found.');
    const taskPaths = new Set(
      state.changes.filter((item) => item.taskId === task.id).map((item) => item.path),
    );
    const replay = (state.followUps ?? []).find((item) => item.commandId === commandId);
    // A comment chosen twice is still one comment, sent once.
    const comments = [...new Set(commentIds)].map((commentId) => this.comment(projectId, commentId));
    for (const comment of comments) {
      if (replay && comment.sent?.followUpId === replay.id) continue;
      if (comment.resolved) throw new ApiError(409, 'A resolved comment is not sent. Reopen it first.');
      if (comment.sent) throw new ApiError(409, 'A comment was already sent with an earlier revision request.');
      const belongs =
        comment.target.kind === 'change' ? comment.taskId === task.id : taskPaths.has(comment.target.path);
      if (!belongs) throw new ApiError(400, 'A chosen comment is not about this task’s changes.');
    }
    const text = revisionRequest(comments, note);
    if (!revisionFits(text))
      throw new ApiError(413, 'These comments are too long for one request. Send fewer at a time.');
    const sources: string[] = [];
    for (const path of new Set(comments.map((comment) => comment.target.path)))
      if (sources.length < 8 && (await this.store.current(projectId, path)) !== null) sources.push(path);
    const followUp = await this.queue(projectId, {
      protocolVersion: 1,
      commandId,
      taskId: task.id,
      text,
      // A done task has no next turn to wait for; its follow-up goes when asked.
      waitsFor: task.state === 'done' ? 'task' : 'turn',
      route,
      model: null,
      agentId: null,
      sources,
    });
    const fresh = this.store.state(projectId);
    for (const comment of comments) {
      const stored = (fresh.reviewComments ?? []).find((item) => item.id === comment.id) as
        | Mutable<ReviewComment>
        | undefined;
      if (stored && !stored.sent) stored.sent = { followUpId: followUp.id, at: now() };
    }
    await this.store.persist(fresh);
    return { followUp, comments: comments.map((comment) => structuredClone(comment as ReviewComment)) };
  }
}
