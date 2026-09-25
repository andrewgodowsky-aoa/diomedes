/**
 * P04: a pack's contributions load on demand.
 *
 * When a pack is turned on in a Project, what is registered is an **index**:
 * one entry per contribution with its kind, id, name, a one-line description,
 * its triggers and the sha-256 digest of its body. Bodies are not loaded. A
 * body loads only when it is actually needed — a skill when the person chooses
 * it or a model asks for it by its triggers, a tool when a run's plan selects
 * it, context when context assembly selects it, a UI panel when a person opens
 * it — and every load is recorded with the contribution's identity, the pack
 * version and the digest, so History can say exactly what was used (`AGENTS.md`
 * decision 8). A body whose digest no longer matches the one the index
 * registered is refused, never silently used.
 *
 * Three things are the same as everywhere else in the pack contract:
 *
 * - **Nothing loads for a Project that has not turned the pack on** (decision
 *   14). The index exists only for active packs, and a load resolves through a
 *   run's pinned index or not at all.
 * - **Loading is not authorization.** A loaded tool body is a declaration; the
 *   tool host and Trust still decide whether anything runs.
 * - **Records are appended, never rewritten** (decision 10). Unloading on
 *   deactivation is a new record, not an edit of the load it ends.
 *
 * Pure: no clock, no filesystem, no hashing. The host computes digests.
 */

/** The six contribution kinds, singular, as a load names one. */
export type ContributionKind = 'tool' | 'agent' | 'rule' | 'context' | 'workflow' | 'ui';

export const CONTRIBUTION_KINDS: readonly ContributionKind[] = Object.freeze([
  'tool',
  'agent',
  'rule',
  'context',
  'workflow',
  'ui',
]);

export function isContributionKind(value: unknown): value is ContributionKind {
  return CONTRIBUTION_KINDS.some((kind) => kind === value);
}

/** The most one index line's description may say. An index is a list, not a manual. */
export const INDEX_LINE_MAX_CHARS = 160;
/** At most this many triggers per entry reach the index; the rest stay searchable in the pack. */
export const INDEX_TRIGGERS_MAX = 4;

/** One contribution as the index knows it. Never its body. */
export interface ContributionIndexEntry {
  readonly kind: ContributionKind;
  readonly id: string;
  readonly name: string;
  /** One line, at most `INDEX_LINE_MAX_CHARS`. */
  readonly line: string;
  /** Phrases a person might say when this is the right contribution. Hints, never commands. */
  readonly triggers: readonly string[];
  /** `sha256:<hex>` of the body's UTF-8 bytes, as registered when the pack was turned on. */
  readonly digest: string;
  /** Body size in UTF-8 bytes: what loading it would add. */
  readonly bytes: number;
  /** For a UI contribution, the existing Console surface it lights up. */
  readonly surface?: 'files' | 'thread' | 'palette' | 'project-settings';
}

/** The index registered for one pack in one Project, at one pack version. */
export interface RegisteredPackIndex {
  readonly packId: string;
  readonly packVersion: string;
  readonly packName: string;
  readonly registeredAt: string;
  readonly entries: readonly ContributionIndexEntry[];
}

/** Why a body was loaded. Each maps to one of the task's four triggers, plus a person reading it. */
export type ContributionLoadReason =
  /** The person picked it (a skill from the palette). */
  | 'chosen'
  /** A model asked for it by its index entry, on a run where the index was offered. */
  | 'triggered'
  /** A run's plan selected it (a tool). */
  | 'selected'
  /** Context assembly selected it. */
  | 'assembled'
  /** A person opened the panel that shows it. */
  | 'opened';

export type ContributionRecordOutcome =
  /** The index was registered (on activation, update, rollback or first use). */
  | 'indexed'
  | 'loaded'
  | 'refused'
  /** The pack was turned off in this Project; its loaded contributions are gone from it. */
  | 'unloaded';

/**
 * One event in a Project's contribution record. Append-only.
 *
 * `runKey` names the run or request the load was for, so a load can be read
 * back against the turn that used it. `pinnedAt` is when that run's index was
 * pinned: a run admitted before a deactivation or a rollback keeps the version
 * it pinned, and this is what shows it.
 */
export interface ContributionRecord {
  readonly id: string;
  readonly at: string;
  readonly outcome: ContributionRecordOutcome;
  readonly packId: string;
  readonly packVersion: string;
  /** Absent on `indexed` and `unloaded`, which are about the whole pack. */
  readonly kind?: ContributionKind;
  readonly contributionId?: string;
  readonly name?: string;
  /** The digest the index registered. On a refusal, the one the body should have had. */
  readonly digest?: string;
  /** On a digest refusal, what the body actually hashed to. */
  readonly actualDigest?: string;
  readonly bytes?: number;
  readonly reason?: ContributionLoadReason;
  readonly runKey?: string | null;
  readonly pinnedAt?: string;
  /** Machine-readable refusal code. */
  readonly code?: string;
  readonly detail: string;
}

/** The identity a load names: pack, kind and id. The pinned index supplies the version and digest. */
export interface ContributionRef {
  readonly packId: string;
  readonly kind: ContributionKind;
  readonly id: string;
}

/** One loaded body, with the identity it was loaded under. */
export interface LoadedContribution {
  readonly packId: string;
  readonly packVersion: string;
  readonly kind: ContributionKind;
  readonly id: string;
  readonly name: string;
  readonly digest: string;
  readonly bytes: number;
  readonly body: string;
  /** The record this load wrote. */
  readonly recordId: string;
}

/** Cut to one line of at most `max` characters, on a word boundary where there is one. */
export function oneLine(text: string, max = INDEX_LINE_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * One index entry as a model reads it. Deterministic, so the index costs the
 * same bytes on every route and a test can pin its size.
 */
export function renderIndexLine(entry: ContributionIndexEntry): string {
  const triggers = entry.triggers.slice(0, INDEX_TRIGGERS_MAX);
  return `- ${entry.id}: ${entry.name}. ${entry.line}${triggers.length ? ` (for: ${triggers.join('; ')})` : ''}`;
}

/** The index of one kind across the given packs, as the lines a model reads. Empty when there is none. */
export function renderIndex(
  indexes: readonly RegisteredPackIndex[],
  kind: ContributionKind,
): string {
  return indexes
    .flatMap((index) => index.entries.filter((entry) => entry.kind === kind).map(renderIndexLine))
    .join('\n');
}

/** UTF-8 length, the same in the browser and on the host. */
const utf8 = (text: string) => new TextEncoder().encode(text).length;

/**
 * What the index costs against what loading every body would, in bytes and in
 * the H18 estimate (`utf8-bytes/4`, rounded up; `shared/context-accounting.ts`).
 */
export interface IndexBudget {
  readonly entries: number;
  readonly indexBytes: number;
  readonly indexTokens: number;
  readonly allBodiesBytes: number;
  readonly allBodiesTokens: number;
  readonly savedBytes: number;
  readonly savedTokens: number;
}

export function indexBudget(indexText: string, bodies: readonly string[]): IndexBudget {
  const indexBytes = utf8(indexText);
  const allBodiesBytes = bodies.reduce((total, body) => total + utf8(body), 0);
  const tokens = (bytes: number) => Math.ceil(bytes / 4);
  return {
    entries: bodies.length,
    indexBytes,
    indexTokens: tokens(indexBytes),
    allBodiesBytes,
    allBodiesTokens: tokens(allBodiesBytes),
    savedBytes: allBodiesBytes - indexBytes,
    savedTokens: tokens(allBodiesBytes) - tokens(indexBytes),
  };
}

const KIND_WORD: Record<ContributionKind, string> = {
  tool: 'tool',
  agent: 'Agent',
  rule: 'rule',
  context: 'context source',
  workflow: 'playbook',
  ui: 'panel',
};

const REASON_WORD: Record<ContributionLoadReason, string> = {
  chosen: 'you chose it',
  triggered: 'the model asked for it',
  selected: 'the run’s plan selected it',
  assembled: 'context assembly selected it',
  opened: 'you opened it',
};

/** The short sha a sentence names; the record keeps the whole digest. */
export const shortDigest = (digest: string | undefined) =>
  digest ? digest.replace(/^sha256:/, '').slice(0, 12) : '';

/**
 * The History sentence for one record. Names the contribution, the pack
 * version and the digest; never the body. Loads are Diomedes application
 * actions, so the sentence says Diomedes did the loading and who or what asked.
 */
export function contributionSentence(record: ContributionRecord, packName: string): string {
  const what = record.kind ? `${KIND_WORD[record.kind]} ${record.name ?? record.contributionId}` : '';
  const pinned = `${packName} ${record.packVersion}`;
  switch (record.outcome) {
    case 'indexed':
      return `Diomedes registered the contribution index for ${pinned}. Nothing in it is loaded until it is used.`;
    case 'loaded':
      return `Diomedes loaded the ${what} from ${pinned} (${shortDigest(record.digest)}) because ${
        REASON_WORD[record.reason ?? 'chosen']
      }.`;
    case 'refused':
      return `Diomedes refused to load the ${what} from ${pinned}: ${record.detail}`;
    case 'unloaded':
      return `Diomedes unloaded ${pinned} from this project. Runs already admitted keep the version they pinned.`;
  }
}

/*
 * P04 adds its records to the existing Project state and History entry rather
 * than introducing a second store. Both fields are absent on everything written
 * before 2026-09-24.
 */
declare module './types.js' {
  interface ProjectState {
    /** The index registered for each pack that is on in this Project, by pack id. Replaced, never merged. */
    packIndex?: Record<string, RegisteredPackIndex>;
    /** Every index registration, load, refusal and unload in this Project. Append-only. */
    contributionRecords?: ContributionRecord[];
  }
  interface HistoryEntry {
    /** The contribution record this History entry states. */
    contribution?: ContributionRecord;
  }
}
