/**
 * Review comments and partial keeps (P06): the records a person leaves while
 * reading a change, and the exact words a revision request carries.
 *
 * A comment is anchored to one line of either a waiting Change (by the change
 * id and the sha of the version the run wrote) or a recorded version of a file
 * (by `{ path, sha }`, the durable identity of shared/file-identity.ts). The
 * server derives the quoted line from the recorded text itself, so an anchor
 * never names a line the person could not have seen. Comments are durable and
 * resolvable; nothing deletes one.
 *
 * "Revise with these comments" is not a side channel. It composes one plain
 * message (`revisionRequest`), shows it to the person in full, and queues it as
 * an ordinary follow-up (shared/work-control.ts), so the run that revises gets
 * exactly the words on screen through the ordinary admission path, and the
 * queue shows what became of it.
 */
import { z } from 'zod';
import { MAX_FOLLOW_UP_CHARS } from './work-control.js';

export const MAX_COMMENT_CHARS = 2_000;
export const MAX_QUOTE_CHARS = 200;
export const MAX_COMMENTS_PER_REVISION = 20;
export const MAX_REVISION_NOTE_CHARS = 1_000;

export type ReviewCommentTarget =
  | {
      readonly kind: 'change';
      readonly changeId: string;
      readonly path: string;
      /** The sha of the version the run wrote, which the change's hunks are computed against. */
      readonly sha: string;
    }
  | { readonly kind: 'version'; readonly path: string; readonly sha: string };

export interface ReviewCommentAnchor {
  /** The hunk the line belongs to, when it is a changed line or the comment is on a change. */
  readonly hunk: number | null;
  /** `old` is the earlier text (a removed line); `new` is the later text. */
  readonly side: 'old' | 'new';
  /** 1-based line number on that side. */
  readonly line: number;
  /** The line as recorded, cut to `MAX_QUOTE_CHARS`. Set by the server, never by the request. */
  readonly quote: string;
}

export interface ReviewComment {
  readonly id: string;
  readonly target: ReviewCommentTarget;
  /** The task whose change it is; null on a comment left on a file version. */
  readonly taskId: string | null;
  readonly anchor: ReviewCommentAnchor;
  readonly text: string;
  readonly by: 'you';
  readonly at: string;
  readonly resolved: { readonly at: string; readonly by: 'you' } | null;
  /** The follow-up that carried it to a run. Once sent it stays sent. */
  readonly sent: { readonly followUpId: string; readonly at: string } | null;
}

const id = z.string().trim().min(1).max(100);
const sha = z.string().regex(/^[a-f0-9]{64}$/);

export const addCommentSchema = z.strictObject({
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('change'), changeId: id }),
    z.strictObject({ kind: z.literal('version'), path: z.string().min(1).max(1000), sha }),
  ]),
  hunk: z.number().int().min(0).max(10_000).nullable().default(null),
  side: z.enum(['old', 'new']),
  line: z.number().int().min(1).max(10_000_000),
  text: z.string().trim().min(1).max(MAX_COMMENT_CHARS),
});
export type AddCommentRequest = z.input<typeof addCommentSchema>;

export const resolveCommentSchema = z.strictObject({ resolved: z.boolean() });

export const reviseSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: id,
  taskId: id,
  commentIds: z.array(id).min(1).max(MAX_COMMENTS_PER_REVISION),
  route: z.string().trim().min(1).max(40),
  note: z.string().trim().max(MAX_REVISION_NOTE_CHARS).default(''),
});
export type ReviseRequest = z.input<typeof reviseSchema>;

export const partialKeepSchema = z.strictObject({
  /** The sha of the version the person reviewed. A newer write refuses rather than guesses. */
  after: sha,
  keep: z.array(z.number().int().min(0)).max(10_000),
  undo: z.array(z.number().int().min(0)).max(10_000),
});
export type PartialKeepRequest = z.input<typeof partialKeepSchema>;

/**
 * What a partial keep recorded on its History entry: the change it settled,
 * the three versions involved, and every hunk with the decision taken on it.
 */
export interface HunkReviewRecord {
  readonly changeId: string;
  /** The History entry whose write the change came from. */
  readonly sourceEntryId: string;
  readonly path: string;
  readonly beforeSha: string;
  readonly afterSha: string;
  /** The sha of the text written: kept hunks from `after`, undone hunks from `before`. */
  readonly resultSha: string;
  readonly by: 'you';
  readonly hunks: readonly {
    readonly index: number;
    readonly decision: 'kept' | 'undone';
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
    readonly added: number;
    readonly removed: number;
    /** SHA-256 of the hunk's removed and added lines, so the evidence names exact text. */
    readonly sha: string;
  }[];
}

/** Where the comment sits, in words: "Menu/Prices.md, change 2, line 12". */
export function commentPlace(comment: Pick<ReviewComment, 'target' | 'anchor'>): string {
  const where =
    comment.anchor.side === 'old'
      ? `line ${comment.anchor.line} of the earlier text`
      : `line ${comment.anchor.line}`;
  const hunk = comment.anchor.hunk === null ? '' : `, change ${comment.anchor.hunk + 1}`;
  const version = comment.target.kind === 'version' ? ` (version ${comment.target.sha.slice(0, 8)})` : '';
  return `${comment.target.path}${version}${hunk}, ${where}`;
}

/**
 * The exact message a revision request queues. Deterministic, so the preview a
 * person reads and approves is byte for byte what the follow-up carries.
 */
export function revisionRequest(
  comments: readonly Pick<ReviewComment, 'target' | 'anchor' | 'text'>[],
  note = '',
): string {
  const lines = [
    `Revise your changes with ${comments.length === 1 ? 'this review comment' : `these ${comments.length} review comments`}.`,
  ];
  if (note.trim()) lines.push('', note.trim());
  comments.forEach((comment, index) => {
    lines.push('', `${index + 1}. ${commentPlace(comment)}: "${comment.anchor.quote}"`);
    for (const line of comment.text.split('\n')) lines.push(`   ${line}`);
  });
  return lines.join('\n');
}

export const revisionFits = (text: string) => text.length <= MAX_FOLLOW_UP_CHARS;

/** The sentence a change kept in part shows: "Kept 2 of 3 changes; undid 1". */
export function partialSentence(partial: { kept: readonly number[]; undone: readonly number[] }): string {
  const total = partial.kept.length + partial.undone.length;
  return `Kept ${partial.kept.length} of ${total} changes; undid ${partial.undone.length}`;
}
