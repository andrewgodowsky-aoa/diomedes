/**
 * The Automatic Change Review manifest — revision 1.
 *
 * A change review is a deterministic record of what changed while one task or
 * run was live, built from evidence the store already keeps: recorded writes in
 * History, folder listings and hashes, structured before/after records, and
 * check results. Every human-readable sentence is a fixed template filled from
 * facts, and every fact names the evidence it came from. If no evidence exists,
 * the sentence does not exist. No model writes, classifies or checks any of it.
 *
 * The same input state, the same rules version and the same checks produce the
 * same manifest — `digest` is computed over the content fields only, so a
 * regenerated review of unchanged evidence keeps its identity while
 * `generatedAt` still records when the build happened.
 *
 * Everything here is data and pure functions. No clock, no filesystem, no
 * network, no process. The host supplies the facts; this file decides their
 * shape.
 */

export const CHANGE_MANIFEST_SCHEMA = 1 as const;
export const CHANGE_REVIEW_RULES_VERSION = '2026-09-15.2' as const;
export const CHANGE_REVIEW_RENDERER_VERSION = '2026-09-15.2' as const;

// --- evidence ------------------------------------------------------------------

/**
 * A typed pointer to the record a claim rests on. `kind` tells the reader where
 * to look it up; the remaining fields identify it exactly. A sentence is never
 * emitted without at least one of these behind its facts.
 */
export type ChangeEvidenceRef =
  | { readonly kind: 'history-entry'; readonly entryId: string; readonly path?: string }
  | {
      readonly kind: 'file-record';
      readonly path: string;
      readonly beforeSha: string | null;
      readonly afterSha: string | null;
    }
  | { readonly kind: 'folder-listing'; readonly listingDigest: string; readonly capturedAt?: string }
  | { readonly kind: 'object'; readonly sha: string }
  | { readonly kind: 'check'; readonly checkId: string }
  | { readonly kind: 'rule'; readonly ruleId: string; readonly rulesVersion: string }
  | { readonly kind: 'manifest'; readonly manifestId: string }
  | {
      readonly kind: 'baseline';
      /** Null pair means the baseline slot itself is the evidence — there is none. */
      readonly listingDigest: string | null;
      readonly capturedAt: string | null;
    }
  | { readonly kind: 'git-record'; readonly record: string; readonly path?: string }
  | { readonly kind: 'structured'; readonly recordId: string; readonly fieldPath: string };

// --- the baseline ---------------------------------------------------------------

/** One file as the baseline walk recorded it. */
export interface BaselineFile {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  /**
   * Deterministic content classification: a NUL byte within the first
   * `BINARY_PROBE_BYTES` of content marks the file binary — the same boundary
   * Git's own `buffer_is_binary` applies. Never inferred from the name.
   */
  readonly binary: boolean;
}

/** One worktree path as the Git source saw it at baseline. */
export interface GitBaselineFile {
  readonly path: string;
  readonly x: string;
  readonly y: string;
  readonly blobSha: string | null;
  readonly stagedSha: string | null;
  readonly renamedFrom: string | null;
  /** HEAD blob oid — addresses the committed content for before-text. */
  readonly headSha: string | null;
  /** Porcelain v2 modes: HEAD, index and worktree — null when Git has none. */
  readonly headMode: string | null;
  readonly indexMode: string | null;
  readonly worktreeMode: string | null;
  /** Git's own binary verdict (numstat) or the bounded head probe for untracked. */
  readonly binary: boolean;
}

/**
 * What was true when a run started, captured before any of its writes could
 * land. The folder listing is the honest scope of what comparison can see:
 * dot-folders, skipped build folders and symlinks are never walked, so a change
 * inside them cannot be observed and is never claimed.
 *
 * `historyLength` scopes attribution: History entries at or after this index
 * are the run's recorded evidence; earlier entries describe pre-existing work.
 */
export interface ReviewBaseline {
  readonly capturedAt: string;
  readonly files: readonly BaselineFile[];
  readonly listingDigest: string;
  readonly historyLength: number;
  /**
   * Git state at capture, when the Software Engineering pack supplied it.
   * `files` stays in the persisted record as diff evidence; the manifest
   * carries only the summary so a dirty listing cannot bloat the review.
   */
  readonly git: {
    readonly captured: boolean;
    readonly head: string | null;
    readonly statusDigest: string | null;
    readonly reason: string | null;
    readonly files?: readonly GitBaselineFile[];
  } | null;
}

// --- one changed thing ----------------------------------------------------------

/**
 * Who observed the change. `recorded` is a Diomedes write with exact History
 * evidence. `observed` is a folder or Git comparison noticing the file differs —
 * it changed while the task ran, not necessarily because of it. `declared` is a
 * structured record's own before/after values.
 */
export type ChangeAttribution = 'recorded' | 'observed' | 'declared';

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'unchanged';

/**
 * One field inside a structured (Business) record, compared mechanically.
 * `before`/`after` are display strings produced by the caller; collection
 * changes name their members. `sensitive` fields carry no values at all — the
 * review reports that they changed, never what they changed to.
 */
export interface StructuredFieldChange {
  readonly path: string;
  readonly label: string;
  readonly kind: 'added' | 'removed' | 'changed' | 'collection' | 'unchanged';
  readonly before: string | null;
  readonly after: string | null;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** True member counts even when `added`/`removed` are truncated at the member cap. */
  readonly addedTotal: number;
  readonly removedTotal: number;
  /** A display value was cut at the scalar bound — the manifest never stores more. */
  readonly valueTruncated: boolean;
  readonly flagCodes: readonly string[];
  readonly sensitive: boolean;
}

/**
 * The exact text evidence behind a changed file, bounded before it is stored.
 * `diff` is a before→after line comparison; `excerpt` is one side only (the
 * other side was not retained); `none` means no text exists — `reason` then
 * says why ('binary', 'no-before', 'evidence-limit', 'unreadable'). Truncation
 * is always declared, never silent.
 */
export interface ChangeTextEvidence {
  readonly kind: 'diff' | 'excerpt' | 'none';
  readonly text: string | null;
  readonly truncated: boolean;
  /** Changed lines cut by the bound; zero when nothing was cut. */
  readonly truncatedLines: number;
  readonly reason: string | null;
}

/** Sources fill this until the review computes real text evidence for the entry. */
export const EMPTY_TEXT_EVIDENCE: ChangeTextEvidence = {
  kind: 'none',
  text: null,
  truncated: false,
  truncatedLines: 0,
  reason: null,
};

export interface ChangeEntry {
  readonly id: string;
  /** Display path: a project-relative file path or a structured record path. */
  readonly path: string;
  readonly kind: ChangeKind;
  readonly attribution: ChangeAttribution;
  readonly source: 'recorded' | 'folder' | 'git' | 'structured';
  readonly beforeSha: string | null;
  readonly afterSha: string | null;
  readonly sizeBefore: number | null;
  readonly sizeAfter: number | null;
  /** Line counts where a text comparison produced them; null means unknown. */
  readonly addedLines: number | null;
  readonly removedLines: number | null;
  readonly binary: boolean;
  /**
   * Git file modes around the change ('100644', '100755', ...) when the source
   * exposed them; null elsewhere. A transition is evidence Git recorded — it
   * never claims OS-level executable semantics on its own.
   */
  readonly modeBefore: string | null;
  readonly modeAfter: string | null;
  /** True when the file existed before the baseline and after, with equal hashes. */
  readonly renamedFrom: string | null;
  /** Bounded exact content evidence; `kind:'none'` for binary or missing sides. */
  readonly textEvidence: ChangeTextEvidence;
  /** The owning change/settle record ids when this came from recorded writes. */
  readonly changeIds: readonly string[];
  /** The settle state of the newest matching change record, when one exists. */
  readonly settled: 'waiting' | 'kept' | 'undone' | null;
  readonly historyEntryIds: readonly string[];
  /** Structured field diffs for declared (Business) changes. */
  readonly fields: readonly StructuredFieldChange[];
  readonly evidence: readonly ChangeEvidenceRef[];
}

// --- facts, flags, checks --------------------------------------------------------

/**
 * A machine statement of what happened. `code` is stable across renderer
 * versions; `params` are the structured values the template fills from. Facts
 * are the only thing sentences may cite.
 */
export interface ReviewFact {
  readonly id: string;
  readonly code: string;
  readonly templateId: string;
  readonly params: Readonly<Record<string, string | number | boolean | null>>;
  readonly evidence: readonly ChangeEvidenceRef[];
}

/** Deterministic attention rule output. A flag classifies; it never judges. */
export interface ReviewFlag {
  readonly code: string;
  readonly ruleId: string;
  readonly severity: 'attention' | 'info';
  readonly text: string;
  readonly paths: readonly string[];
  readonly evidence: readonly ChangeEvidenceRef[];
}

export const REVIEW_CHECK_STATES = ['passed', 'failed', 'not-run', 'skipped', 'error'] as const;
export type ReviewCheckState = (typeof REVIEW_CHECK_STATES)[number];

export interface ReviewCheck {
  readonly id: string;
  readonly label: string;
  readonly state: ReviewCheckState;
  /** Why a check did not run, or what an error was. Never vague. */
  readonly reason: string | null;
  /** Bounded deterministic result text; null when nothing ran. */
  readonly detail: string | null;
  /** Digest of the inputs the check ran against — staleness is visible. */
  readonly inputDigest: string | null;
  readonly ranAt: string | null;
  readonly durationMs: number | null;
  readonly evidence: readonly ChangeEvidenceRef[];
}

// --- the rendered summary --------------------------------------------------------

/**
 * One displayable sentence. `text` is the fixed-template rendering — display it
 * verbatim, it is already escaped. `evidence` holds the typed references the
 * sentence resolves to; `factIds` and `flagCodes` are the drill-down ids. A
 * sentence is never emitted with an empty `evidence` list — that is the
 * evidence invariant.
 */
export interface ReviewSentence {
  readonly id: string;
  readonly templateId: string;
  readonly text: string;
  readonly factIds: readonly string[];
  readonly flagCodes: readonly string[];
  readonly evidence: readonly ChangeEvidenceRef[];
}

export interface ReviewSummary {
  /** The "What changed" sentences — plain wording first. */
  readonly whatChanged: readonly ReviewSentence[];
  /** "Needs your attention" — one sentence per attention flag. */
  readonly attention: readonly ReviewSentence[];
  /** One sentence per check, in manifest order. */
  readonly checks: readonly ReviewSentence[];
}

// --- coverage: what the review could not see --------------------------------------

export interface CoverageNote {
  readonly path: string;
  readonly reason: string;
}

/**
 * A bound the review hit while building evidence. `limit` names the bound
 * ('walk-cap', 'change-cap', 'prefetch-budget', 'text-evidence-budget', ...)
 * and `detail` states plainly what was seen versus what was indexed — partial
 * coverage is always declared here, never implied complete.
 */
export interface ReviewLimit {
  readonly limit: string;
  readonly detail: string;
}

export interface ReviewCoverage {
  readonly inspected: number;
  readonly skipped: readonly CoverageNote[];
  readonly blocked: readonly CoverageNote[];
  readonly unavailable: readonly CoverageNote[];
  readonly limits: readonly ReviewLimit[];
}

// --- the manifest ------------------------------------------------------------------

export type ChangeReviewOutcome =
  | 'active'
  | 'waiting-review'
  | 'completed'
  | 'no-writes'
  | 'declined'
  | 'failed'
  | 'stopped';

export interface ChangeReviewSubject {
  readonly kind: 'task-run' | 'example';
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  /** One plain line naming what this review covers. */
  readonly label: string;
}

export interface ChangeReviewManifest {
  readonly schemaVersion: typeof CHANGE_MANIFEST_SCHEMA;
  /** `cr_` + digest — deterministic per content. */
  readonly id: string;
  readonly subject: ChangeReviewSubject;
  readonly outcome: ChangeReviewOutcome;
  readonly baseline: ReviewBaseline | null;
  /** Why there is no baseline, when there is none. */
  readonly baselineReason: string | null;
  readonly changes: readonly ChangeEntry[];
  readonly facts: readonly ReviewFact[];
  readonly flags: readonly ReviewFlag[];
  readonly checks: readonly ReviewCheck[];
  readonly summary: ReviewSummary;
  readonly coverage: ReviewCoverage;
  readonly generatedAt: string;
  readonly rulesVersion: string;
  readonly rendererVersion: string;
  readonly digest: string;
}

// --- the persisted record -----------------------------------------------------------

export const CHANGE_REVIEW_LEDGER_EVENTS = [
  'baseline-captured',
  'built',
  'rebuilt-kept',
  'rebuilt-undone',
  'rebuilt-restored',
  'rebuilt-state',
  'cleared',
] as const;
export type ChangeReviewLedgerEvent = (typeof CHANGE_REVIEW_LEDGER_EVENTS)[number];

export interface ChangeReviewLedgerRow {
  readonly at: string;
  readonly event: ChangeReviewLedgerEvent;
  readonly detail: string;
  /** The manifest digest this row produced or superseded. */
  readonly digest: string | null;
}

/**
 * The durable artifact at `<dataDir>/change-review/<project>/<session>.json`.
 * Fields are mutable in the service's working copy — a record is rewritten
 * whole, never patched.
 */
export interface ChangeReviewRecord {
  v: 1;
  projectId: string;
  sessionId: string;
  manifest: ChangeReviewManifest | null;
  baseline: ReviewBaseline | null;
  ledger: ChangeReviewLedgerRow[];
}

// --- canonical serialization and digest ----------------------------------------------

/**
 * Deterministic JSON: object keys sorted at every level, array order preserved,
 * `undefined` dropped the way `JSON.stringify` drops it. Two manifests built
 * from the same evidence serialize byte-for-byte identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) out[key] = sortDeep(item);
    }
    return out;
  }
  return value;
}

/**
 * The fields the digest covers — the review's content, not its bookkeeping.
 * `id`, `generatedAt` and the append-only ledger stay outside so rebuilding the
 * same evidence at a different time keeps the same identity, while any change
 * to what the review says produces a new one.
 */
export function manifestContent(manifest: ChangeReviewManifest): unknown {
  return {
    schemaVersion: manifest.schemaVersion,
    subject: manifest.subject,
    outcome: manifest.outcome,
    baseline: manifest.baseline,
    baselineReason: manifest.baselineReason,
    changes: manifest.changes,
    facts: manifest.facts,
    flags: manifest.flags,
    // Check timing (`ranAt`, `durationMs`) is bookkeeping like `generatedAt`:
    // the identity of a check is what it scanned and what it concluded.
    checks: manifest.checks.map((check) => ({
      id: check.id,
      label: check.label,
      state: check.state,
      reason: check.reason,
      detail: check.detail,
      inputDigest: check.inputDigest,
      evidence: check.evidence,
    })),
    summary: manifest.summary,
    coverage: manifest.coverage,
    rulesVersion: manifest.rulesVersion,
    rendererVersion: manifest.rendererVersion,
  };
}

// --- display safety -------------------------------------------------------------------

/**
 * Make untrusted text safe to render: control characters, bidi overrides and
 * other invisible marks become visible `\uXXXX` escapes so a malicious path or
 * value cannot disguise itself or reorder the sentence around it.
 */
export function escapeVisible(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    )
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
}

/** A value that stays in evidence is masked to a fixed token plus its digest prefix. */
export const MASKED_VALUE = '••• (recorded, not shown)';

// --- the honesty boundary --------------------------------------------------------------

/**
 * Words a deterministic review may never say. They assert judgment — safety,
 * correctness, absence of problems — that no mechanical fact proves. The
 * renderer scans every sentence against this list at build time and throws on a
 * hit, so an overclaim cannot ship in a template either.
 */
export const BANNED_SUMMARY_WORDS = [
  'safe',
  'secure',
  'correct',
  'verified',
  'guaranteed',
  'risk',
  'score',
  'no issues',
  'no problems',
  'nothing wrong',
  'looks good',
  'all good',
] as const;

export function bannedWordHits(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const word of BANNED_SUMMARY_WORDS) {
    const pattern = word.includes(' ') ? word : `\\b${word}\\b`;
    if (new RegExp(pattern, 'i').test(lower)) hits.push(word);
  }
  return hits;
}

// --- pluralization and counts -------------------------------------------------------------

export function plural(count: number, one: string, many?: string): string {
  return count === 1 ? one : (many ?? `${one}s`);
}

export function countText(count: number, one: string, many?: string): string {
  return `${count} ${plural(count, one, many)}`;
}
