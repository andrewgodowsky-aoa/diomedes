/**
 * H10 — guidance maintenance: proposals from evidence, signed revisions,
 * evaluation and rollback for a project's instruction files.
 *
 * Diomedes watches the records a project already keeps for corrections of the
 * same kind, repeated: a run's write a person undid, a run H15 paused for
 * leaving its folder that a person then stopped or redirected, the same review
 * comment left again and again. When one kind reaches its threshold it
 * *proposes* one line for the instruction file that governs it. It never
 * writes on its own: a person approves or declines, and a decline suppresses
 * that proposal until new evidence arrives.
 *
 * Every applied revision, and every rollback, is one record in an append-only
 * chain. Each record names the previous and new content digests, who made it
 * (a person, or a person approving a named proposal), when, and the evidence;
 * and it carries the digest of the record before it, so an edited, dropped or
 * reordered record is detected. There is no local signing key for this today,
 * so "signed" is a SHA-256 digest chain, not an HMAC (a proposed default,
 * recorded in the lane's implementation record). No PKI is implied.
 *
 * Nothing here grants authority. An instruction file is a project rule
 * (`server/capability-packs.ts`), and a revision changes guidance, never a
 * permission (decision 7).
 */

/** The three kinds of repeated correction Diomedes reads. Stable codes; tests and records cite them. */
export const GUIDANCE_EVIDENCE_KINDS = ['undone-write', 'scope-drift', 'review-comment'] as const;
export type GuidanceEvidenceKind = (typeof GUIDANCE_EVIDENCE_KINDS)[number];

/**
 * How many distinct occurrences make a proposal. Distinct means distinct runs
 * for a write or a drift, and distinct changes or file versions for a comment:
 * one run undone twice is one occurrence. A product constant, not a setting
 * (the D5 precedent): changing it can make a proposal appear sooner, and can
 * never write anything.
 */
export const GUIDANCE_THRESHOLDS: Readonly<Record<GuidanceEvidenceKind, number>> = Object.freeze({
  'undone-write': 3,
  'scope-drift': 3,
  'review-comment': 3,
});

/** Bounds on what one evaluation replays. */
export const GUIDANCE_EVALUATION_MAX_CASES = 20;
/** Never evicted: a project at the limit records nothing new rather than forgetting (decision 10). */
export const MAX_GUIDANCE_REVISIONS = 1024;
export const MAX_GUIDANCE_DECLINES = 1024;
/** A proposed line is one line. */
export const MAX_GUIDANCE_LINE_CHARS = 240;

export const GUIDANCE_KIND_LABELS: Readonly<Record<GuidanceEvidenceKind, string>> = Object.freeze({
  'undone-write': 'Writes you undid',
  'scope-drift': 'Runs you stopped for leaving their folder',
  'review-comment': 'A comment you keep leaving',
});

/** One fact a proposal rests on, pointing at the durable record that holds it. */
export interface GuidanceEvidence {
  readonly kind: GuidanceEvidenceKind;
  /** The record's own id: a Change, a supervision record, a review comment. */
  readonly ref: string;
  /** The run it came from, when it came from one. */
  readonly sessionId: string | null;
  readonly taskId: string | null;
  /** The file or folder it is about. */
  readonly path: string;
  readonly at: string;
  /** One plain sentence. Names paths; never file content beyond a person's own comment. */
  readonly detail: string;
}

/** What the replay found. `not-evaluable` says why; it is never shown as a pass. */
export type GuidanceVerdict = 'improved' | 'unchanged' | 'worse' | 'not-evaluable';

export const GUIDANCE_VERDICT_LABELS: Readonly<Record<GuidanceVerdict, string>> = Object.freeze({
  improved: 'Improved',
  unchanged: 'Unchanged',
  worse: 'Worse',
  'not-evaluable': 'Not evaluable',
});

/** One recorded run, replayed through H15's instruction check with and without the line. */
export interface GuidanceCase {
  readonly sessionId: string;
  /** `targeted`: a run whose write was the correction. `control`: a run whose write to the same place you kept. */
  readonly role: 'targeted' | 'control';
  /** Whether the check flags the run's write under the current file. */
  readonly without: boolean;
  /** Whether it flags it under the revised file. */
  readonly with: boolean;
}

export interface GuidanceEvaluation {
  readonly verdict: GuidanceVerdict;
  /**
   * Where it ran: the recorded cases replayed through the deterministic H15
   * instruction-drift detector. No model is called and nothing is sent.
   */
  readonly route: 'recorded-replay';
  readonly cases: readonly GuidanceCase[];
  /** Targeted runs the revision would now flag, that the current file does not. */
  readonly gained: number;
  /** Kept runs the revision would now flag, that the current file does not. */
  readonly lost: number;
  /** One plain sentence. */
  readonly summary: string;
}

export interface GuidanceProposal {
  /** Stable while the pattern and its evidence are the same. */
  readonly id: string;
  /** The kind and what it is about: `undone-write:reports/summary.md`. */
  readonly pattern: string;
  readonly kind: GuidanceEvidenceKind;
  readonly target: string;
  /** The instruction file the line goes into. */
  readonly file: { readonly path: string; readonly sha: string; readonly scope: string };
  readonly line: string;
  readonly before: string;
  readonly after: string;
  readonly evidence: readonly GuidanceEvidence[];
  readonly evidenceDigest: string;
  readonly threshold: number;
  readonly occurrences: number;
  readonly evaluation: GuidanceEvaluation;
  /** Diomedes application code proposed it; a person decides it (decision 8). */
  readonly proposedBy: 'diomedes';
}

/** A person's decline. It suppresses the pattern until an evidence ref it does not hold appears. */
export interface GuidanceDecline {
  readonly pattern: string;
  readonly proposalId: string;
  readonly evidenceRefs: readonly string[];
  readonly at: string;
  readonly by: 'you';
  /** A rollback of an applied proposal counts as a decline of that evidence. */
  readonly via: 'decline' | 'rollback';
}

/** Who made a revision. A proposal is never an author on its own: a person approved it. */
export type GuidanceAuthor =
  | { readonly kind: 'person'; readonly who: 'you' }
  | {
      readonly kind: 'proposal';
      readonly proposalId: string;
      readonly proposedBy: 'diomedes';
      readonly approvedBy: 'you';
    };

export interface GuidanceRevision {
  readonly protocolVersion: 1;
  /** 1-based position in the chain. */
  readonly seq: number;
  readonly id: string;
  readonly action: 'apply' | 'rollback';
  readonly path: string;
  readonly previousSha: string | null;
  readonly newSha: string;
  /** The exact texts, so any revision can be restored without anything else surviving. */
  readonly previousText: string | null;
  readonly newText: string;
  readonly author: GuidanceAuthor;
  readonly at: string;
  readonly evidence: readonly GuidanceEvidence[];
  readonly evaluation: GuidanceEvaluation | null;
  /** The pattern of the proposal applied, or of the one a rollback took back. */
  readonly pattern: string | null;
  /** For a rollback: the revision whose previous text was restored. */
  readonly rollbackOf: string | null;
  /** The History entry that recorded the write. */
  readonly historyEntryId: string;
  /** The digest of the record before this one; null for the first. */
  readonly prevDigest: string | null;
  readonly scheme: 'sha256-chain-v1';
  /** SHA-256 over the canonical form of every other field. */
  readonly digest: string;
}

export interface GuidanceLedger {
  readonly formatVersion: 1;
  readonly revisions: readonly GuidanceRevision[];
  readonly declines: readonly GuidanceDecline[];
}

export type ChainCheck =
  | { readonly ok: true; readonly length: number; readonly head: string | null }
  | { readonly ok: false; readonly length: number; readonly brokenAt: number; readonly reason: string };

/** JSON with object keys in a fixed order, so a digest never depends on how a record was built. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** Normalise a person's comment so the same words, however punctuated or spaced, are one kind. */
export function commentKind(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?;:,]+$/g, '')
    .trim();
}

/** Make one line from free text: no line breaks, no leading list marker, bounded. */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/^[-*+]\s+/, '');
  return flat.length > MAX_GUIDANCE_LINE_CHARS ? `${flat.slice(0, MAX_GUIDANCE_LINE_CHARS - 1)}…` : flat;
}

/** The file with one bullet appended, keeping everything above it byte for byte. */
export function appendGuidanceLine(before: string, line: string): string {
  const base = before === '' || before.endsWith('\n') ? before : `${before}\n`;
  return `${base}- ${line}\n`;
}

/**
 * The verdict, conservatively. A revision that would flag a run whose write you
 * kept is worse, however many it also catches: it would have interrupted work
 * you wanted.
 */
export function guidanceVerdict(cases: readonly GuidanceCase[]): {
  verdict: GuidanceVerdict;
  gained: number;
  lost: number;
} {
  const gained = cases.filter((item) => item.role === 'targeted' && item.with && !item.without).length;
  const lost = cases.filter((item) => item.role === 'control' && item.with && !item.without).length;
  if (!cases.some((item) => item.role === 'targeted')) return { verdict: 'not-evaluable', gained, lost };
  if (lost > 0) return { verdict: 'worse', gained, lost };
  if (gained > 0) return { verdict: 'improved', gained, lost };
  return { verdict: 'unchanged', gained, lost };
}

/** A decline holds while every evidence ref of the proposal was already declined. */
export function isSuppressed(
  declines: readonly GuidanceDecline[],
  pattern: string,
  evidenceRefs: readonly string[],
): boolean {
  const declined = new Set(
    declines.filter((item) => item.pattern === pattern).flatMap((item) => item.evidenceRefs),
  );
  return declined.size > 0 && evidenceRefs.every((ref) => declined.has(ref));
}

export const emptyGuidanceLedger = (): GuidanceLedger => ({
  formatVersion: 1,
  revisions: [],
  declines: [],
});
