/**
 * Coordination for the unified execution program (2026-09-13).
 *
 * One rendezvous directory under the Git common dir holds exclusive file
 * claims, recorded handoffs, one heavy-test / live-call slot, and one
 * append-only journal per role. Nothing here touches Git's own state; the
 * folder is a sibling of Git's files, never one of them.
 *
 * Rules the charter fixes and this file enforces:
 * - A path is one canonical repository-relative identity. Separators, `.` and
 *   `..` segments and letter case do not make a second path. Escaping, absolute,
 *   drive, stream, device and short-name spellings are refused, not guessed at.
 * - A claim excludes every overlapping claim: the same path, a directory above
 *   it, or a path below it. Exclusion is ordered rather than check-then-write.
 *   Each attempt is published under the next free sequence number (a hard link
 *   that fails when the number is taken), then yields to every earlier
 *   overlapping attempt that won or has not decided. Each attempt is decided
 *   once, so two overlapping attempts cannot both win, whatever their timing.
 * - A stale timestamp alone is never permission to steal. A claim ends only by
 *   its holder's release, or by the integrator's release with a recorded reason.
 * - The charter's shared hot files belong to the integrator (Fable). Others may
 *   inspect them and return patches. A non-integrator claims one only through a
 *   handoff record the integrator issued to that exact process, node, base and
 *   scope, and each handoff is used once. An id alone authorizes nothing.
 * - An owner is the full process identity: role, host, pid, process start and
 *   worktree. A reused pid, another host or another lifetime is someone else.
 * - A missing partner journal means read-only work, not a second implementation.
 *
 * Records are published by writing a private temporary file and hard-linking it
 * into place, so every name appears with complete contents or not at all. The
 * root must therefore live on a file system with hard links (NTFS, ext4, APFS).
 *
 * Library API (tested in tests/coordination.test.ts) and a small CLI:
 *   tsx scripts/coordination.ts identity|claim|release|handoff|slot|unslot|journal|mode|status ...
 */
import { promises as fs } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PROGRAM = 'unified-20260913' as const;
export type Role = 'fable' | 'astra' | 'opus';
export const ROLES: readonly Role[] = Object.freeze(['fable', 'astra', 'opus']);
export const INTEGRATOR: Role = 'fable';

/** Charter §"Shared hot files": serialized through the integrator. Prefixes end with `/`. */
export const CHARTER_HOT_FILES: readonly string[] = Object.freeze([
  'package.json',
  'package-lock.json',
  'shared/types.ts',
  'shared/harness.ts',
  'shared/engines.ts',
  'shared/agents.ts',
  'shared/capability-packs.ts',
  'shared/execution.ts',
  'shared/work-control.ts',
  'shared/contract-revision.ts',
  'server/app.ts',
  'server/store.ts',
  'server/native-work.ts',
  'client/api.ts',
  'client/console/Shell.tsx',
  'desktop/',
]);

export interface Owner {
  readonly role: Role;
  readonly host: string;
  readonly pid: number;
  /** ISO time the owning process started; identity, not a lease. */
  readonly processStart: string;
  readonly worktree: string;
}

export interface Claim {
  readonly schema_version: 1;
  readonly claimId: string;
  readonly program: typeof PROGRAM;
  readonly node: string;
  readonly owner: Owner;
  /** Canonical paths; a directory ends with `/`. */
  readonly paths: readonly string[];
  readonly baseSha: string;
  readonly createdAt: string;
  /** The handoff this claim used, recorded only after the handoff was validated and consumed. */
  readonly handoffFrom: string | null;
}

export interface ClaimRelease {
  readonly claimId: string;
  readonly releasedBy: Owner;
  /** `holder` when the owning process ended it; `integrator` when the integrator did, with a reason. */
  readonly authority: 'holder' | 'integrator';
  readonly at: string;
  readonly note: string;
}

export type ClaimResult =
  | { ok: true; claim: Claim }
  | {
      ok: false;
      reason: 'held' | 'integrator-owned' | 'handoff-invalid' | 'invalid';
      detail: string;
      heldBy?: Claim;
    };

export interface Handoff {
  readonly schema_version: 1;
  readonly handoffId: string;
  readonly program: typeof PROGRAM;
  /** Always the integrator. */
  readonly issuedBy: Owner;
  /** The one process that may use it. */
  readonly recipient: Owner;
  readonly node: string;
  readonly baseSha: string;
  /** The exact canonical scope a claim using this handoff must name. */
  readonly paths: readonly string[];
  readonly note: string;
  readonly issuedAt: string;
}

export interface Slot {
  readonly schema_version: 1;
  readonly slotId: string;
  readonly owner: Owner;
  readonly purpose: string;
  readonly node: string;
  readonly acquiredAt: string;
}

export type SlotResult =
  | { ok: true; slot: Slot }
  | { ok: false; heldBy: Slot | null; detail: string };

export interface JournalEntry {
  readonly at: string;
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface WorkMode {
  readonly mode: 'edit' | 'read-only';
  readonly why: string;
}

/** Where each record lives. Other sessions read these files, so the layout is part of the protocol. */
export function coordinationLayout(root: string) {
  const claims = path.join(root, 'claims');
  return {
    root,
    /** Winning claims (`<id>.json`) and releases (`<id>.released.json`). */
    claims,
    /** Every attempt, as first published. */
    attempts: path.join(claims, 'attempts'),
    /** Dense sequence of attempts: `000000000000.json` onward, never removed. */
    order: path.join(claims, 'order'),
    /** The one decision per attempt: won, lost or abandoned. */
    decisions: path.join(claims, 'decisions'),
    /**
     * Releases of ordered claims whose `<id>.released.json` name was already taken by a record
     * without authority, such as the earlier tool's role-only release.
     */
    releases: path.join(claims, 'releases'),
    /** Per-path lock files the earlier tool checks; written for its sake, never trusted here. */
    locks: path.join(claims, 'paths'),
    /** Integrator-issued handoffs (`<id>.json`) and their single use (`<id>.consumed.json`). */
    handoffs: path.join(root, 'handoffs', 'issued'),
    /** The heavy slot (`heavy.json`) and its release history (`history.jsonl`). */
    slot: path.join(root, 'slot'),
    /** One record per released slot (`<slotId>.json`), published before the slot file is removed. */
    slotReleases: path.join(root, 'slot', 'releases'),
    journals: path.join(root, 'journals'),
  };
}
type Layout = ReturnType<typeof coordinationLayout>;

export const orderEntryName = (seq: number) => `${String(seq).padStart(12, '0')}.json`;
const ORDER_ENTRY = /^\d{12}\.json$/;
const CLAIM_ID = /^claim_[a-z0-9]+_[0-9a-f]{8}$/;
const HANDOFF_ID = /^handoff_[a-z0-9]+_[0-9a-f]{8}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** How long an attempt waits for an earlier overlapping attempt to decide before refusing. */
const DEFAULT_SETTLE_MS = 5000;

// --- path identity -------------------------------------------------------------------

export interface CanonicalPath {
  /** Repository-relative, `/`-separated, dot segments resolved, spelling kept; a directory ends with `/`. */
  readonly path: string;
  /** The comparison identity: `path` without a trailing `/`, lower-cased as Windows compares names. */
  readonly key: string;
  readonly directory: boolean;
}

const MAX_PATH_INPUT = 1024;
const RESERVED_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i;

/** One repository path identity, or a refusal naming why the spelling is ambiguous or escapes. */
export function canonicalPath(
  input: string,
): { ok: true; value: CanonicalPath } | { ok: false; detail: string } {
  const refuse = (why: string) => ({
    ok: false as const,
    detail: `The path ${JSON.stringify(input)} ${why}.`,
  });
  if (typeof input !== 'string' || input.length === 0) return refuse('is empty');
  if (input.length > MAX_PATH_INPUT) return refuse(`is longer than ${MAX_PATH_INPUT} characters`);
  if (/[^\x20-\x7e]/.test(input)) return refuse('contains a control or non-ASCII character');
  if (/[<>:"|?*]/.test(input))
    return refuse('contains a character Windows reserves (<>:"|?*), a drive or a stream name');
  const slashed = input.replace(/\\/g, '/');
  if (slashed.startsWith('/')) return refuse('is absolute; name a repository-relative path');
  const raw = slashed.split('/');
  const segments: string[] = [];
  for (const segment of raw) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return refuse('escapes the repository');
      segments.pop();
      continue;
    }
    if (segment.trim() !== segment)
      return refuse(`has a segment with leading or trailing spaces (${JSON.stringify(segment)})`);
    if (segment.endsWith('.'))
      return refuse(
        `has a segment ending in a dot (${JSON.stringify(segment)}), which Windows drops`,
      );
    if (RESERVED_DEVICE.test(segment)) return refuse(`names the reserved device ${segment}`);
    if (/~\d/.test(segment)) return refuse(`looks like a Windows short name (${segment})`);
    segments.push(segment);
  }
  if (segments.length === 0) return refuse('names the repository root, not a path in it');
  const last = raw[raw.length - 1];
  const directory = last === '' || last === '.' || last === '..';
  const joined = segments.join('/');
  return {
    ok: true,
    value: { path: directory ? `${joined}/` : joined, key: joined.toLowerCase(), directory },
  };
}

/** Same identity, or one is a directory above the other. */
const keysOverlap = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
/** `outer` is `inner` or a directory above it. */
const keyContains = (outer: string, inner: string) =>
  outer === inner || inner.startsWith(`${outer}/`);

const HOT_KEYS: readonly string[] = CHARTER_HOT_FILES.map((hot) => {
  const result = canonicalPath(hot);
  if (!result.ok) throw new Error(result.detail);
  return result.value.key;
});

/**
 * A charter hot file, a path inside a hot directory, or a directory holding one. A spelling
 * that is not a valid repository path counts as hot: an unreadable path never slips past.
 */
export function isHotFile(relPath: string): boolean {
  const result = canonicalPath(relPath);
  return !result.ok || HOT_KEYS.some((hot) => keysOverlap(hot, result.value.key));
}

/**
 * Canonical, de-duplicated and sorted, without entries a directory in the same set already
 * covers. The first invalid spelling refuses the whole set.
 */
function canonicalSet(
  paths: readonly string[],
): { ok: true; value: CanonicalPath[] } | { ok: false; detail: string } {
  if (!Array.isArray(paths)) return { ok: false, detail: 'The paths must be a list.' };
  const byKey = new Map<string, CanonicalPath>();
  for (const spelling of paths) {
    const result = canonicalPath(spelling);
    if (!result.ok) return result;
    const known = byKey.get(result.value.key);
    if (!known || (result.value.directory && !known.directory))
      byKey.set(result.value.key, result.value);
  }
  const entries = [...byKey.values()];
  const value = entries
    .filter(
      (entry) => !entries.some((other) => other !== entry && keyContains(other.key, entry.key)),
    )
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { ok: true, value };
}

/** Identities a recorded claim covers. A record whose paths cannot be read covers everything. */
function recordedKeys(claim: { readonly paths?: unknown }): readonly string[] | 'everything' {
  if (!Array.isArray(claim.paths) || claim.paths.length === 0) return 'everything';
  const keys: string[] = [];
  for (const spelling of claim.paths) {
    const result = canonicalPath(spelling as string);
    if (!result.ok) return 'everything';
    keys.push(result.value.key);
  }
  return keys;
}
const overlapsAny = (recorded: readonly string[] | 'everything', wanted: readonly string[]) =>
  recorded === 'everything' || recorded.some((a) => wanted.some((b) => keysOverlap(a, b)));

// --- owner identity ------------------------------------------------------------------

/** Why an owner record is not a complete process identity, or null when it is. */
function ownerProblem(owner: unknown): string | null {
  if (typeof owner !== 'object' || owner === null) return 'there is no owner';
  const o = owner as Record<string, unknown>;
  if (!ROLES.includes(o.role as Role)) return `the role ${JSON.stringify(o.role)} is unknown`;
  if (typeof o.host !== 'string' || o.host.trim() === '') return 'the host is empty';
  if (typeof o.pid !== 'number' || !Number.isSafeInteger(o.pid) || o.pid <= 0)
    return `pid ${String(o.pid)} is not a positive integer`;
  if (
    typeof o.processStart !== 'string' ||
    !ISO_INSTANT.test(o.processStart) ||
    Number.isNaN(Date.parse(o.processStart))
  )
    return `the process start ${JSON.stringify(o.processStart)} is not an ISO instant`;
  if (typeof o.worktree !== 'string' || o.worktree.trim() === '') return 'the worktree is empty';
  return null;
}

const worktreeKey = (value: string) =>
  value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * One process: the same role, host, pid, start instant and worktree. Spelling differences
 * (host or worktree case, separators, time zone) are not identity differences.
 */
export function sameOwner(a: Owner, b: Owner): boolean {
  return (
    ownerProblem(a) === null &&
    ownerProblem(b) === null &&
    a.role === b.role &&
    a.host.trim().toLowerCase() === b.host.trim().toLowerCase() &&
    a.pid === b.pid &&
    Date.parse(a.processStart) === Date.parse(b.processStart) &&
    worktreeKey(a.worktree) === worktreeKey(b.worktree)
  );
}

const describeOwner = (owner: Owner) =>
  `${owner.role} (pid ${owner.pid} on ${owner.host}, started ${owner.processStart}, worktree ${owner.worktree})`;

// --- atomic publication --------------------------------------------------------------

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
const isExists = (error: unknown) => errorCode(error) === 'EEXIST';
const isAbsent = (error: unknown) => errorCode(error) === 'ENOENT';
const isBusy = (error: unknown) =>
  process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

/** Windows briefly reports a file another process is opening or linking as busy. */
async function retryBusy<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isBusy(error) || attempt >= 20) throw error;
      await pause(5 + attempt * 5);
    }
  }
}

/**
 * Publish `text` at `target` only if nothing is there. The bytes go to a private temporary
 * file that is then hard-linked into place: the name appears complete or not at all, and a
 * second publisher gets EEXIST instead of overwriting. False when the name was taken.
 */
async function publishExclusive(target: string, text: string): Promise<boolean> {
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, text, { flag: 'wx' });
  try {
    await retryBusy(() => fs.link(temp, target));
    return true;
  } catch (error) {
    if (isExists(error)) return false;
    throw error;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

/** A JSON record, or null when absent. The earlier tool's records can read as truncated for a moment. */
async function readJson<T>(file: string): Promise<T | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return JSON.parse(await retryBusy(() => fs.readFile(file, 'utf8'))) as T;
    } catch (error) {
      if (isAbsent(error)) return null;
      if (!(error instanceof SyntaxError) || attempt >= 10) throw error;
      await pause(10);
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await retryBusy(() => fs.access(file));
    return true;
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await retryBusy(() => fs.readdir(dir));
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
}

async function ensureDirs(layout: Layout) {
  for (const dir of [
    layout.attempts,
    layout.order,
    layout.decisions,
    layout.locks,
    layout.handoffs,
    layout.slot,
    layout.journals,
  ])
    await fs.mkdir(dir, { recursive: true });
}

// --- claims --------------------------------------------------------------------------

type Decision = 'won' | 'lost' | 'abandoned';
interface DecisionRecord {
  readonly schema_version: 1;
  readonly claimId: string;
  readonly decision: Decision;
  readonly at: string;
}
interface HandoffUse {
  readonly schema_version: 1;
  readonly handoffId: string;
  readonly claimId: string;
  readonly at: string;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';
const attemptFile = (layout: Layout, claimId: string) =>
  path.join(layout.attempts, `${claimId}.json`);
const decisionFile = (layout: Layout, claimId: string) =>
  path.join(layout.decisions, `${claimId}.json`);
const claimFile = (layout: Layout, claimId: string) => path.join(layout.claims, `${claimId}.json`);
const releaseFile = (layout: Layout, claimId: string) =>
  path.join(layout.claims, `${claimId}.released.json`);
const releaseRecordFile = (layout: Layout, claimId: string) =>
  path.join(layout.releases, `${claimId}.json`);
/** The name of the lock file the earlier tool checks for a recorded path. */
const legacyLockName = (recordedPath: string) => `${encodeURIComponent(recordedPath)}.lock`;
const legacyLockFile = (layout: Layout, recordedPath: string) =>
  path.join(layout.locks, legacyLockName(recordedPath));
/** File systems cap one name at 255 characters (NTFS) or bytes (ext4); lock names are ASCII. */
const MAX_FILE_NAME = 255;
const handoffFile = (layout: Layout, handoffId: string) =>
  path.join(layout.handoffs, `${handoffId}.json`);
const handoffUseFile = (layout: Layout, handoffId: string) =>
  path.join(layout.handoffs, `${handoffId}.consumed.json`);
const describePaths = (claim: Claim) =>
  Array.isArray(claim.paths) ? claim.paths.join(', ') : 'unreadable paths';

/** The one decision an attempt ever gets: the first publisher decides, everyone else reads it. */
async function decide(
  layout: Layout,
  claimId: string,
  decision: Decision,
): Promise<{ decision: Decision; mine: boolean }> {
  const record: DecisionRecord = {
    schema_version: 1,
    claimId,
    decision,
    at: new Date().toISOString(),
  };
  if (await publishExclusive(decisionFile(layout, claimId), JSON.stringify(record, null, 2)))
    return { decision, mine: true };
  const existing = await readJson<DecisionRecord>(decisionFile(layout, claimId));
  if (!existing) throw new Error(`The decision for ${claimId} exists but cannot be read.`);
  return { decision: existing.decision, mine: false };
}

/**
 * Link the attempt into the order under the lowest free sequence number. Entries are never
 * removed and a publisher only moves past numbers it found taken, so the numbers stay dense:
 * when an attempt lands at `n`, the attempts at 0..n-1 are all already published.
 */
async function publishInOrder(layout: Layout, attempt: string): Promise<number> {
  let seq = (await listNames(layout.order)).filter((name) => ORDER_ENTRY.test(name)).length;
  for (;;) {
    try {
      await retryBusy(() => fs.link(attempt, path.join(layout.order, orderEntryName(seq))));
      return seq;
    } catch (error) {
      if (!isExists(error)) throw error;
      seq += 1;
    }
  }
}

async function orderEntries(layout: Layout): Promise<Claim[]> {
  const entries: Claim[] = [];
  const names = (await listNames(layout.order)).filter((name) => ORDER_ENTRY.test(name)).sort();
  for (const name of names) {
    const entry = await readJson<Claim>(path.join(layout.order, name));
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Unreleased claims the earlier tool wrote: a claim file with no attempt record behind it. */
async function legacyActiveClaims(layout: Layout): Promise<Claim[]> {
  const names = await listNames(layout.claims);
  const released = new Set(
    names
      .filter((name) => name.endsWith('.released.json'))
      .map((name) => name.slice(0, -'.released.json'.length)),
  );
  const claims: Claim[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.released.json')) continue;
    const claimId = name.slice(0, -'.json'.length);
    if (released.has(claimId) || (await exists(attemptFile(layout, claimId)))) continue;
    const claim = await readJson<Claim>(path.join(layout.claims, name));
    if (claim) claims.push(claim);
  }
  return claims;
}

/** A release by the claim's holder, or by the integrator with a recorded reason. */
function authoritative(release: ClaimRelease | null, claim: Claim): release is ClaimRelease {
  if (!release || release.claimId !== claim.claimId) return false;
  if (sameOwner(release.releasedBy, claim.owner)) return true;
  return (
    ownerProblem(release.releasedBy) === null &&
    release.releasedBy.role === INTEGRATOR &&
    nonEmpty(release.note)
  );
}

/**
 * The release that ended a claim, or null. A claim the earlier tool wrote ends with its release
 * record, as that tool decides. An ordered claim ends only by its holder or by the integrator with
 * a recorded reason: the earlier tool checks nothing but the releasing role, so a record it leaves
 * is not a release here, and the authoritative release is then recorded under `claims/releases/`.
 */
async function releaseOf(
  layout: Layout,
  claim: Claim,
  ordered: boolean,
): Promise<ClaimRelease | null> {
  const recorded = await readJson<ClaimRelease>(releaseFile(layout, claim.claimId));
  if (!ordered || authoritative(recorded, claim)) return recorded;
  const later = await readJson<ClaimRelease>(releaseRecordFile(layout, claim.claimId));
  return authoritative(later, claim) ? later : null;
}

/** won (and not released), done (lost, abandoned or released), or undecided at the deadline. */
async function settledOutcome(
  layout: Layout,
  entry: Claim,
  deadline: number,
): Promise<'won' | 'done' | 'undecided'> {
  for (;;) {
    const record = await readJson<DecisionRecord>(decisionFile(layout, entry.claimId));
    if (record) {
      if (record.decision === 'lost' || record.decision === 'abandoned') return 'done';
      return (await releaseOf(layout, entry, true)) ? 'done' : 'won';
    }
    if (Date.now() >= deadline) return 'undecided';
    await pause(Math.max(1, Math.min(25, deadline - Date.now())));
  }
}

interface Block {
  readonly claim: Claim | null;
  readonly detail: string;
}

const heldBlock = (claim: Claim): Block => ({
  claim,
  detail: `${describePaths(claim)} ${Array.isArray(claim.paths) && claim.paths.length === 1 ? 'is' : 'are'} held by ${describeOwner(claim.owner)} (claim ${claim.claimId}, node ${claim.node}, since ${claim.createdAt}). A stale timestamp is not permission to steal: wait for a release or obtain a recorded handoff.`,
});

/**
 * The first reason an attempt at `mySeq` cannot win: an unreleased claim from the earlier tool, or
 * an earlier overlapping attempt that won or has not decided by the deadline. The earlier tool
 * claims outside the order, so its claims are read again after waiting, just before winning.
 */
async function firstBlocking(
  layout: Layout,
  mySeq: number,
  wanted: readonly string[],
  settleMs: number,
): Promise<Block | null> {
  const legacyBlock = async () => {
    for (const legacy of await legacyActiveClaims(layout))
      if (overlapsAny(recordedKeys(legacy), wanted)) return heldBlock(legacy);
    return null;
  };
  const early = await legacyBlock();
  if (early) return early;
  const deadline = Date.now() + settleMs;
  for (let seq = 0; seq < mySeq; seq += 1) {
    const entry = await readJson<Claim>(path.join(layout.order, orderEntryName(seq)));
    if (!entry)
      return {
        claim: null,
        detail: `Order entry ${seq} is missing, so ${layout.order} was edited by hand. Nothing later can be claimed until the integrator repairs it.`,
      };
    if (!overlapsAny(recordedKeys(entry), wanted)) continue;
    const outcome = await settledOutcome(layout, entry, deadline);
    if (outcome === 'won') return heldBlock(entry);
    if (outcome === 'undecided')
      return {
        claim: entry,
        detail: `Claim ${entry.claimId} by ${describeOwner(entry.owner)} for ${describePaths(entry)} has not finished deciding. If that process has exited, its owner or the integrator can end it with release.`,
      };
  }
  return legacyBlock();
}

/** Every claim holding its paths now: won and not released, or an unreleased earlier-tool claim. */
export async function activeClaims(root: string): Promise<Claim[]> {
  const layout = coordinationLayout(root);
  const claims = await legacyActiveClaims(layout);
  for (const entry of await orderEntries(layout)) {
    const record = await readJson<DecisionRecord>(decisionFile(layout, entry.claimId));
    if (!record || record.decision === 'lost' || record.decision === 'abandoned') continue;
    if (!(await releaseOf(layout, entry, true))) claims.push(entry);
  }
  return claims.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Attempts with no decision yet. One that stays here means a process exited while claiming. */
export async function pendingAttempts(root: string): Promise<Claim[]> {
  const layout = coordinationLayout(root);
  const pending: Claim[] = [];
  for (const entry of await orderEntries(layout))
    if (!(await exists(decisionFile(layout, entry.claimId)))) pending.push(entry);
  return pending;
}

/** The active claim holding a path, a directory above it or a path below it, or null. */
export async function holderOf(root: string, relPath: string): Promise<Claim | null> {
  const wanted = canonicalPath(relPath);
  if (!wanted.ok) throw new Error(wanted.detail);
  const active = await activeClaims(root);
  return active.find((claim) => overlapsAny(recordedKeys(claim), [wanted.value.key])) ?? null;
}

/**
 * Claim paths for one node. The attempt is published in order and yields to every earlier
 * overlapping attempt that won and is not released, or that has not decided within `settleMs`.
 * A refused attempt is recorded as lost and leaves no claim behind.
 */
export async function claimPaths(
  root: string,
  input: {
    owner: Owner;
    node: string;
    baseSha: string;
    paths: readonly string[];
    /** The id of a handoff the integrator issued to this process for exactly these paths. */
    handoffFrom?: string | null;
    createdAt?: string;
    /** Only for tests and status displays; a later "now" never permits a steal. */
    now?: string;
    /** How long to wait for an earlier overlapping attempt to decide before refusing. */
    settleMs?: number;
  },
): Promise<ClaimResult> {
  const problem = ownerProblem(input.owner);
  if (problem)
    return {
      ok: false,
      reason: 'invalid',
      detail: `The claiming identity is incomplete: ${problem}.`,
    };
  if (!nonEmpty(input.node) || !nonEmpty(input.baseSha))
    return { ok: false, reason: 'invalid', detail: 'A claim names its node and base commit.' };
  const set = canonicalSet(input.paths);
  if (!set.ok) return { ok: false, reason: 'invalid', detail: set.detail };
  if (set.value.length === 0)
    return { ok: false, reason: 'invalid', detail: 'A claim needs at least one path.' };
  // Refuse before publishing: a lock file that cannot be written would fail after the claim won.
  const unlockable = set.value.find((entry) => legacyLockName(entry.path).length > MAX_FILE_NAME);
  if (unlockable)
    return {
      ok: false,
      reason: 'invalid',
      detail: `The path ${JSON.stringify(unlockable.path)} is too long for the lock file the earlier tool checks (a ${legacyLockName(unlockable.path).length}-character name; at most ${MAX_FILE_NAME}). Claim a shorter path or a directory above it.`,
    };
  const layout = coordinationLayout(root);
  let handoff: Handoff | null = null;
  if (input.handoffFrom !== undefined && input.handoffFrom !== null) {
    const applicable = await applicableHandoff(layout, input.handoffFrom, {
      owner: input.owner,
      node: input.node,
      baseSha: input.baseSha,
      paths: set.value,
    });
    if (!applicable.ok) return { ok: false, reason: 'handoff-invalid', detail: applicable.detail };
    handoff = applicable.handoff;
  }
  const hot = set.value.filter((entry) => isHotFile(entry.path)).map((entry) => entry.path);
  if (hot.length > 0 && input.owner.role !== INTEGRATOR && !handoff)
    return {
      ok: false,
      reason: 'integrator-owned',
      detail: `${hot.join(', ')}: charter hot files belong to the integrator (${INTEGRATOR}). Return a patch instead, or claim under a handoff the integrator issued to this process.`,
    };

  await ensureDirs(layout);
  const claim: Claim = {
    schema_version: 1,
    claimId: newId('claim'),
    program: PROGRAM,
    node: input.node,
    owner: input.owner,
    paths: set.value.map((entry) => entry.path),
    baseSha: input.baseSha,
    createdAt: input.createdAt ?? new Date().toISOString(),
    handoffFrom: handoff?.handoffId ?? null,
  };
  const text = JSON.stringify(claim, null, 2);
  const attempt = attemptFile(layout, claim.claimId);
  if (!(await publishExclusive(attempt, text)))
    throw new Error(`Claim id ${claim.claimId} is already taken; retry.`);
  const seq = await publishInOrder(layout, attempt);
  const settleMs =
    typeof input.settleMs === 'number' && Number.isFinite(input.settleMs) && input.settleMs >= 0
      ? input.settleMs
      : DEFAULT_SETTLE_MS;
  const wanted = set.value.map((entry) => entry.key);
  const block = await firstBlocking(layout, seq, wanted, settleMs);
  if (block) {
    await decide(layout, claim.claimId, 'lost');
    return {
      ok: false,
      reason: 'held',
      detail: block.detail,
      ...(block.claim ? { heldBy: block.claim } : {}),
    };
  }
  const outcome = await decide(layout, claim.claimId, 'won');
  if (outcome.decision !== 'won')
    return {
      ok: false,
      reason: 'held',
      detail: `Claim ${claim.claimId} was ended (${outcome.decision}) before it could decide; nothing was claimed.`,
    };
  // Only a claim that has won uses its handoff, so an attempt ended while it waited leaves the
  // handoff for the next one. Another claim by the same process can still have used it first.
  if (handoff) {
    const use: HandoffUse = {
      schema_version: 1,
      handoffId: handoff.handoffId,
      claimId: claim.claimId,
      at: new Date().toISOString(),
    };
    const useFile = handoffUseFile(layout, handoff.handoffId);
    if (!(await publishExclusive(useFile, JSON.stringify(use, null, 2)))) {
      const used = await readJson<HandoffUse>(useFile);
      const detail = `Handoff ${handoff.handoffId} was already used by claim ${used?.claimId ?? 'unknown'}.`;
      await releaseClaim(root, claim.claimId, {
        by: input.owner,
        note: `${detail} This attempt won after that, so it gave the paths back.`,
      });
      return { ok: false, reason: 'handoff-invalid', detail };
    }
  }
  await publishExclusive(claimFile(layout, claim.claimId), text);
  await writeLegacyLocks(layout, claim);
  return { ok: true, claim };
}

/** The earlier tool only checks per-path lock files; leave one per claimed path so it sees this claim. */
async function writeLegacyLocks(layout: Layout, claim: Claim) {
  for (const recorded of claim.paths)
    await fs
      .writeFile(legacyLockFile(layout, recorded), claim.claimId, { flag: 'wx' })
      .catch((error: unknown) => {
        if (!isExists(error)) throw error;
      });
}

async function clearLegacyLocks(layout: Layout, claim: Claim) {
  for (const recorded of Array.isArray(claim.paths) ? claim.paths : []) {
    if (typeof recorded !== 'string') continue;
    const lock = legacyLockFile(layout, recorded);
    const holder = await fs.readFile(lock, 'utf8').catch(() => null);
    if (holder?.trim() === claim.claimId) await retryBusy(() => fs.rm(lock, { force: true }));
  }
}

/**
 * End a claim. Its holder (the same full process identity) may, and so may the integrator with
 * a recorded reason; anyone else is refused. An attempt that never decided is recorded as
 * abandoned, which lets the attempts waiting behind it proceed. The claim stays as evidence; a
 * `.released.json` beside it says who ended it, with which authority and why. When a record
 * without authority already took that name, the release is recorded as `claims/releases/<id>.json`.
 */
export async function releaseClaim(
  root: string,
  claimId: string,
  input: { by: Owner; note: string; at?: string },
): Promise<ClaimRelease> {
  const problem = ownerProblem(input.by);
  if (problem) throw new Error(`The releasing identity is incomplete: ${problem}.`);
  if (typeof claimId !== 'string' || !CLAIM_ID.test(claimId))
    throw new Error(`${JSON.stringify(claimId)} is not a claim id.`);
  const layout = coordinationLayout(root);
  const attempt = await readJson<Claim>(attemptFile(layout, claimId));
  const claim = attempt ?? (await readJson<Claim>(claimFile(layout, claimId)));
  if (!claim) throw new Error(`No claim ${claimId}.`);
  const ordered = attempt !== null;
  if (await releaseOf(layout, claim, ordered))
    throw new Error(`Claim ${claimId} was already released.`);
  const note = typeof input.note === 'string' ? input.note : '';
  let authority: ClaimRelease['authority'];
  if (sameOwner(claim.owner, input.by)) authority = 'holder';
  else if (input.by.role === INTEGRATOR) {
    if (note.trim() === '')
      throw new Error(
        `The integrator ends another holder's claim ${claimId} only with a recorded reason (a note).`,
      );
    authority = 'integrator';
  } else
    throw new Error(
      `Only the holder, ${describeOwner(claim.owner)}, or the integrator (${INTEGRATOR}) with a recorded reason may release claim ${claimId}.`,
    );
  if (attempt) {
    const outcome = await decide(layout, claimId, 'abandoned');
    if (!outcome.mine && outcome.decision !== 'won')
      throw new Error(
        `Claim ${claimId} holds nothing: it was ${outcome.decision === 'lost' ? 'refused when it was made' : 'already ended'}.`,
      );
  }
  const release: ClaimRelease = {
    claimId,
    releasedBy: input.by,
    authority,
    at: input.at ?? new Date().toISOString(),
    note,
  };
  const text = JSON.stringify(release, null, 2);
  if (!(await publishExclusive(releaseFile(layout, claimId), text))) {
    // The name is taken. A record without authority does not end an ordered claim, so its release
    // is recorded beside the claims instead; any other record means the claim was released already.
    const taken = await readJson<ClaimRelease>(releaseFile(layout, claimId));
    if (!ordered || authoritative(taken, claim))
      throw new Error(`Claim ${claimId} was already released.`);
    await fs.mkdir(layout.releases, { recursive: true });
    if (!(await publishExclusive(releaseRecordFile(layout, claimId), text)))
      throw new Error(
        authoritative(await readJson<ClaimRelease>(releaseRecordFile(layout, claimId)), claim)
          ? `Claim ${claimId} was already released.`
          : `Both release records of claim ${claimId} are taken by records without authority; the integrator must inspect ${releaseFile(layout, claimId)} and ${releaseRecordFile(layout, claimId)}.`,
      );
  }
  await clearLegacyLocks(layout, claim);
  return release;
}

// --- handoffs ------------------------------------------------------------------------

/**
 * The integrator hands one exact scope to one exact process for one node and base. The record
 * is what authorizes a non-integrator's hot-file claim: an id alone authorizes nothing, and a
 * handoff is used by at most one winning claim.
 */
export async function issueHandoff(
  root: string,
  input: {
    by: Owner;
    to: Owner;
    node: string;
    baseSha: string;
    paths: readonly string[];
    note: string;
    at?: string;
  },
): Promise<Handoff> {
  const issuer = ownerProblem(input.by);
  if (issuer) throw new Error(`The issuing identity is incomplete: ${issuer}.`);
  if (input.by.role !== INTEGRATOR)
    throw new Error(
      `Only the integrator (${INTEGRATOR}) issues handoffs; ${input.by.role} cannot.`,
    );
  const recipient = ownerProblem(input.to);
  if (recipient) throw new Error(`The recipient identity is incomplete: ${recipient}.`);
  if (!nonEmpty(input.note)) throw new Error('A handoff records a note saying why.');
  if (!nonEmpty(input.node) || !nonEmpty(input.baseSha))
    throw new Error('A handoff names its node and base commit.');
  const set = canonicalSet(input.paths);
  if (!set.ok) throw new Error(set.detail);
  if (set.value.length === 0) throw new Error('A handoff names at least one path.');
  const layout = coordinationLayout(root);
  await ensureDirs(layout);
  const handoff: Handoff = {
    schema_version: 1,
    handoffId: newId('handoff'),
    program: PROGRAM,
    issuedBy: input.by,
    recipient: input.to,
    node: input.node,
    baseSha: input.baseSha,
    paths: set.value.map((entry) => entry.path),
    note: input.note,
    issuedAt: input.at ?? new Date().toISOString(),
  };
  const text = JSON.stringify(handoff, null, 2);
  if (!(await publishExclusive(handoffFile(layout, handoff.handoffId), text)))
    throw new Error(`Handoff id ${handoff.handoffId} is already taken; retry.`);
  return handoff;
}

/** The handoff behind `handoffId` when it authorizes exactly this claim, or why it does not. */
async function applicableHandoff(
  layout: Layout,
  handoffId: string,
  claim: { owner: Owner; node: string; baseSha: string; paths: readonly CanonicalPath[] },
): Promise<{ ok: true; handoff: Handoff } | { ok: false; detail: string }> {
  const refuse = (why: string) => ({
    ok: false as const,
    detail: `Handoff ${JSON.stringify(handoffId)} does not authorize this claim: ${why}.`,
  });
  if (typeof handoffId !== 'string' || !HANDOFF_ID.test(handoffId))
    return refuse('that is not the id of an issued handoff');
  const handoff = await readJson<Handoff>(handoffFile(layout, handoffId));
  if (!handoff) return refuse('no such handoff was issued');
  if (handoff.program !== PROGRAM || handoff.handoffId !== handoffId)
    return refuse('the record belongs to another handoff or program');
  if (ownerProblem(handoff.issuedBy) !== null || handoff.issuedBy.role !== INTEGRATOR)
    return refuse(`it was not issued by the integrator (${INTEGRATOR})`);
  if (ownerProblem(handoff.recipient) !== null)
    return refuse('its recipient is not a complete process identity');
  if (!sameOwner(handoff.recipient, claim.owner))
    return refuse(`it was issued to ${describeOwner(handoff.recipient)}, not to this process`);
  if (handoff.node !== claim.node) return refuse(`it is for node ${String(handoff.node)}`);
  if (handoff.baseSha !== claim.baseSha) return refuse(`it is for base ${String(handoff.baseSha)}`);
  const scope = canonicalSet(Array.isArray(handoff.paths) ? handoff.paths : []);
  const exact =
    scope.ok &&
    scope.value.length === claim.paths.length &&
    scope.value.every(
      (entry, index) =>
        entry.key === claim.paths[index].key && entry.directory === claim.paths[index].directory,
    );
  if (!exact)
    return refuse(
      `its scope is ${Array.isArray(handoff.paths) ? handoff.paths.join(', ') : 'unreadable'}, not exactly the claimed paths`,
    );
  const used = await readJson<HandoffUse>(handoffUseFile(layout, handoffId));
  if (used) return refuse(`it was already used by claim ${used.claimId}`);
  return { ok: true, handoff };
}

/** Active claims this process holds under an integrator handoff that this very claim used. */
async function handedOffClaims(
  layout: Layout,
  active: readonly Claim[],
  me: Owner,
): Promise<Claim[]> {
  const claims: Claim[] = [];
  for (const claim of active) {
    const handoffId = claim.handoffFrom;
    if (!nonEmpty(handoffId) || !HANDOFF_ID.test(handoffId) || !sameOwner(claim.owner, me))
      continue;
    const handoff = await readJson<Handoff>(handoffFile(layout, handoffId));
    if (
      !handoff ||
      ownerProblem(handoff.issuedBy) !== null ||
      handoff.issuedBy.role !== INTEGRATOR ||
      ownerProblem(handoff.recipient) !== null ||
      !sameOwner(handoff.recipient, me)
    )
      continue;
    const use = await readJson<HandoffUse>(handoffUseFile(layout, handoffId));
    if (use?.claimId === claim.claimId) claims.push(claim);
  }
  return claims;
}

// --- the heavy slot ------------------------------------------------------------------

const slotFile = (layout: Layout) => path.join(layout.slot, 'heavy.json');

/** The one heavy-test / Playwright / packaging / live-call slot, shared by both repositories. */
export async function requestSlot(
  root: string,
  input: { owner: Owner; purpose: string; node: string; at?: string },
): Promise<SlotResult> {
  const problem = ownerProblem(input.owner);
  if (problem)
    return {
      ok: false,
      heldBy: null,
      detail: `The requesting identity is incomplete: ${problem}.`,
    };
  const layout = coordinationLayout(root);
  await ensureDirs(layout);
  const slot: Slot = {
    schema_version: 1,
    slotId: newId('slot'),
    owner: input.owner,
    purpose: input.purpose,
    node: input.node,
    acquiredAt: input.at ?? new Date().toISOString(),
  };
  if (await publishExclusive(slotFile(layout), JSON.stringify(slot, null, 2)))
    return { ok: true, slot };
  const heldBy = await readJson<Slot>(slotFile(layout));
  return {
    ok: false,
    heldBy,
    detail: heldBy
      ? `The heavy slot is held by ${describeOwner(heldBy.owner)} for ${heldBy.purpose} (${heldBy.node}, since ${heldBy.acquiredAt}). Wait; do not start Playwright, a full suite, packaging or a live call.`
      : 'The heavy slot was released while this request was refused; retry.',
  };
}

const SLOT_ID = /^slot_[a-z0-9]+_[0-9a-f]{8}$/;
const slotReleaseFile = (layout: Layout, slotId: string) =>
  path.join(layout.slotReleases, `${slotId}.json`);

/**
 * Only the holder, by full process identity, releases the slot, and each slot is released once.
 * The release is published exclusively before the slot file is removed, so a retried or
 * concurrent release that read the same slot finds the record and removes nothing: it cannot
 * remove the slot the next holder took.
 */
export async function releaseSlot(root: string, slotId: string, input: { by: Owner; at?: string }) {
  const problem = ownerProblem(input.by);
  if (problem) throw new Error(`The releasing identity is incomplete: ${problem}.`);
  if (typeof slotId !== 'string' || !SLOT_ID.test(slotId))
    throw new Error(`${JSON.stringify(slotId)} is not a slot id.`);
  const layout = coordinationLayout(root);
  const held = await readJson<Slot>(slotFile(layout));
  if (!held || held.slotId !== slotId) throw new Error(`Slot ${slotId} is not the current holder.`);
  if (!sameOwner(held.owner, input.by))
    throw new Error(`Only the holder, ${describeOwner(held.owner)}, may release slot ${slotId}.`);
  const released = {
    ...held,
    releasedAt: input.at ?? new Date().toISOString(),
    releasedBy: input.by,
  };
  await fs.mkdir(layout.slotReleases, { recursive: true });
  if (!(await publishExclusive(slotReleaseFile(layout, slotId), JSON.stringify(released, null, 2))))
    throw new Error(`Slot ${slotId} was already released; nothing was removed.`);
  // Only the removal sits between the record and a free slot, so no other failure can leave a slot
  // that is recorded as released but still held.
  await retryBusy(() => fs.rm(slotFile(layout), { force: true }));
  await fs.appendFile(path.join(layout.slot, 'history.jsonl'), JSON.stringify(released) + '\n');
}

export async function currentSlot(root: string): Promise<Slot | null> {
  return readJson<Slot>(slotFile(coordinationLayout(root)));
}

// --- journals and work mode ----------------------------------------------------------

const journalFile = (layout: Layout, role: Role) => path.join(layout.journals, `${role}.jsonl`);

export async function writeJournal(root: string, owner: Owner, entry: JournalEntry) {
  const problem = ownerProblem(owner);
  if (problem) throw new Error(`The journal identity is incomplete: ${problem}.`);
  const layout = coordinationLayout(root);
  await ensureDirs(layout);
  const identity = {
    pid: owner.pid,
    host: owner.host,
    processStart: owner.processStart,
    worktree: owner.worktree,
  };
  await fs.appendFile(
    journalFile(layout, owner.role),
    JSON.stringify({ ...entry, ...identity }) + '\n',
  );
}

export async function readJournal(root: string, role: Role): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(journalFile(coordinationLayout(root), role), 'utf8');
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEntry);
}

/**
 * What a worker may do right now. Read-only when the partner has not shown up in the journals,
 * when the worker's identity is incomplete or a wanted path cannot be read, when a non-integrator
 * wants a hot path that its own handed-off claim does not cover, or when another process holds an
 * overlapping claim or has an overlapping attempt that has not decided. Read-only work is useful
 * work: source inventory, black-box tests, fixtures, review; never a second implementation.
 */
export async function workMode(
  root: string,
  input: { me: Owner; partner: Role; wantsToEdit: readonly string[] },
): Promise<WorkMode> {
  const partnerJournal = await readJournal(root, input.partner);
  if (partnerJournal.length === 0)
    return {
      mode: 'read-only',
      why: `No journal from ${input.partner} in ${root}: the partner has not joined this coordination root. Do read-only analysis or isolated disjoint work; do not start a second implementation.`,
    };
  const problem = ownerProblem(input.me);
  if (problem)
    return {
      mode: 'read-only',
      why: `Your identity is incomplete: ${problem}. Name the long-lived process with --pid.`,
    };
  const set = canonicalSet(input.wantsToEdit);
  if (!set.ok) return { mode: 'read-only', why: set.detail };
  const layout = coordinationLayout(root);
  const active = await activeClaims(root);
  if (input.me.role !== INTEGRATOR) {
    const handedOff = await handedOffClaims(layout, active, input.me);
    const covered = (key: string) =>
      handedOff.some((claim) => {
        const keys = recordedKeys(claim);
        return keys !== 'everything' && keys.some((held) => keyContains(held, key));
      });
    const uncovered = set.value.filter((entry) => isHotFile(entry.path) && !covered(entry.key));
    if (uncovered.length > 0)
      return {
        mode: 'read-only',
        why: `${uncovered.map((entry) => entry.path).join(', ')} belong to the integrator (${INTEGRATOR}). Inspect and return a patch, or work under a handoff the integrator issued to this process; do not edit.`,
      };
  }
  const wanted = set.value.map((entry) => entry.key);
  const holder = active.find(
    (claim) => !sameOwner(claim.owner, input.me) && overlapsAny(recordedKeys(claim), wanted),
  );
  if (holder)
    return {
      mode: 'read-only',
      why: `${describePaths(holder)} held by ${describeOwner(holder.owner)} (claim ${holder.claimId}, node ${holder.node}).`,
    };
  // An attempt that has not decided may still win, so its paths are not free to edit either.
  const deciding = (await pendingAttempts(root)).find(
    (attempt) => !sameOwner(attempt.owner, input.me) && overlapsAny(recordedKeys(attempt), wanted),
  );
  if (deciding)
    return {
      mode: 'read-only',
      why: `${describePaths(deciding)} being claimed by ${describeOwner(deciding.owner)} (claim ${deciding.claimId}, node ${deciding.node}), which has not decided. If that process has exited, its owner or the integrator can end it with release.`,
    };
  return {
    mode: 'edit',
    why: 'Partner present, no hot path outside the integrator or a handoff, and no overlapping claim held or being decided by another process.',
  };
}

// --- command line --------------------------------------------------------------------

export function defaultRoot(cwd = process.cwd()): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  const absolute = path.isAbsolute(common) ? common : path.resolve(cwd, common);
  return path.join(absolute, 'diomedes-coordination', PROGRAM);
}

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * When process `pid` started, as the operating system records it, or null when no such process
 * is running here. Windows asks CIM (`Win32_Process.CreationDate`). Linux derives it from
 * `/proc` (boot time plus start ticks, which a clock step can shift, so pin it with --start when
 * that matters). Other platforms return null and the caller passes --start.
 */
export async function processStartOf(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    // `pid` is a checked integer, so interpolating it cannot change the command.
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`;
    for (const shell of ['pwsh.exe', 'powershell.exe']) {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          shell,
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { encoding: 'utf8', timeout: 30_000, windowsHide: true },
        ));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      const value = stdout.trim();
      if (value === '') return null;
      if (!ISO_INSTANT.test(value))
        throw new Error(
          `${shell} reported an unreadable start for pid ${pid}: ${value.slice(0, 200)}`,
        );
      return value;
    }
    throw new Error(
      'Neither pwsh.exe nor powershell.exe can report process start times; pass --start.',
    );
  }
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
    // Field 22 is starttime in clock ticks since boot; the command name before it may hold spaces.
    const ticks = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]);
    const boot = (await fs.readFile('/proc/stat', 'utf8'))
      .split('\n')
      .find((line) => line.startsWith('btime '));
    const bootSeconds = Number(boot?.split(/\s+/)[1]);
    const hertz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
    if (!Number.isFinite(ticks) || !Number.isFinite(bootSeconds) || !(hertz > 0)) return null;
    return new Date(bootSeconds * 1000 + (ticks * 1000) / hertz).toISOString();
  }
  return null;
}

async function identityFromArgs(
  args: readonly string[],
  prefix: '' | 'to-',
  lookupStart: (pid: number) => Promise<string | null>,
  defaults: { host: string; worktree?: string },
): Promise<Owner> {
  const flag = (name: string) => `--${prefix}${name}`;
  const role = argValue(args, `${prefix}role`) as Role | undefined;
  if (!role || !ROLES.includes(role))
    throw new Error(`${flag('role')} must be one of ${ROLES.join(', ')}.`);
  const pidText = argValue(args, `${prefix}pid`);
  if (pidText === undefined)
    throw new Error(
      `${flag('pid')} is required: name the long-lived process this identity belongs to (the agent session), never the short-lived command.`,
    );
  const pid = Number(pidText);
  if (!/^\d+$/.test(pidText) || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`${flag('pid')} must be a positive integer, not ${JSON.stringify(pidText)}.`);
  const worktree = argValue(args, `${prefix}worktree`) ?? defaults.worktree;
  if (worktree === undefined) throw new Error(`${flag('worktree')} is required.`);
  const processStart = argValue(args, `${prefix}start`) ?? (await lookupStart(pid));
  if (processStart === null)
    throw new Error(
      `Process ${pid} is not running on this host, or this platform cannot report its start; pass ${flag('start')} with the time it started.`,
    );
  const owner: Owner = {
    role,
    host: argValue(args, `${prefix}host`) ?? defaults.host,
    pid,
    processStart,
    worktree,
  };
  const problem = ownerProblem(owner);
  if (problem)
    throw new Error(`The identity named by ${flag('*')} flags is incomplete: ${problem}.`);
  return owner;
}

/**
 * The owner a command speaks for. The command is short-lived, so it never describes itself:
 * --pid names the long-lived process (the agent session) and the start time is read for that
 * pid from the operating system unless --start gives it. --host defaults to this machine and
 * --worktree to the current directory.
 */
export function ownerFromArgs(
  args: readonly string[],
  lookupStart: (pid: number) => Promise<string | null> = processStartOf,
): Promise<Owner> {
  return identityFromArgs(args, '', lookupStart, {
    host: os.hostname(),
    worktree: process.cwd().replace(/\\/g, '/'),
  });
}

const COMMANDS = [
  'identity',
  'claim',
  'release',
  'handoff',
  'slot',
  'unslot',
  'journal',
  'mode',
  'status',
] as const;
const USAGE = `usage: tsx scripts/coordination.ts <command> --role ROLE --pid PID [--start ISO] [--host HOST] [--worktree DIR] [--root DIR]
  identity                      print the identity these flags name
  claim    --node N --base SHA --paths a,b [--handoff ID] [--settle-ms MS]
  release  --claim ID --note WHY
  handoff  --to-role R --to-pid P --to-worktree DIR [--to-start ISO] [--to-host H]
           --node N --base SHA --paths a,b --note WHY          (integrator only)
  slot     --purpose P --node N
  unslot   --slot ID
  journal  --event TEXT
  mode     --partner ROLE --paths a,b
  status                        slot, active claims, undecided attempts, journal sizes
`;

async function main(argv: string[]) {
  const [command, ...args] = argv;
  if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const root = argValue(args, 'root') ?? defaultRoot();
  const out = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  const list = (name: string) =>
    (argValue(args, name) ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  switch (command) {
    case 'identity': {
      out(await ownerFromArgs(args));
      return;
    }
    case 'claim': {
      const owner = await ownerFromArgs(args);
      const settle = argValue(args, 'settle-ms');
      const result = await claimPaths(root, {
        owner,
        node: argValue(args, 'node') ?? '',
        baseSha: argValue(args, 'base') ?? '',
        paths: list('paths'),
        handoffFrom: argValue(args, 'handoff') ?? argValue(args, 'handoff-from') ?? null,
        ...(settle === undefined ? {} : { settleMs: Number(settle) }),
      });
      out(result);
      if (result.ok)
        await writeJournal(root, owner, {
          at: new Date().toISOString(),
          event: 'claim',
          claimId: result.claim.claimId,
          node: result.claim.node,
          paths: result.claim.paths,
          handoffFrom: result.claim.handoffFrom,
        });
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    case 'release': {
      const owner = await ownerFromArgs(args);
      const claimId = argValue(args, 'claim');
      if (!claimId) throw new Error('--claim is required.');
      const release = await releaseClaim(root, claimId, {
        by: owner,
        note: argValue(args, 'note') ?? '',
      });
      await writeJournal(root, owner, {
        at: release.at,
        event: 'release',
        claimId,
        authority: release.authority,
        note: release.note,
      });
      out(release);
      return;
    }
    case 'handoff': {
      const by = await ownerFromArgs(args);
      const to = await identityFromArgs(args, 'to-', processStartOf, { host: os.hostname() });
      const handoff = await issueHandoff(root, {
        by,
        to,
        node: argValue(args, 'node') ?? '',
        baseSha: argValue(args, 'base') ?? '',
        paths: list('paths'),
        note: argValue(args, 'note') ?? '',
      });
      await writeJournal(root, by, {
        at: handoff.issuedAt,
        event: 'handoff',
        handoffId: handoff.handoffId,
        recipient: handoff.recipient,
        node: handoff.node,
        paths: handoff.paths,
        note: handoff.note,
      });
      out(handoff);
      return;
    }
    case 'slot': {
      const owner = await ownerFromArgs(args);
      const result = await requestSlot(root, {
        owner,
        purpose: argValue(args, 'purpose') ?? 'unspecified',
        node: argValue(args, 'node') ?? 'unspecified',
      });
      out(result);
      if (result.ok)
        await writeJournal(root, owner, {
          at: result.slot.acquiredAt,
          event: 'slot',
          slotId: result.slot.slotId,
          purpose: result.slot.purpose,
        });
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    case 'unslot': {
      const owner = await ownerFromArgs(args);
      const slotId = argValue(args, 'slot');
      if (!slotId) throw new Error('--slot is required.');
      await releaseSlot(root, slotId, { by: owner });
      await writeJournal(root, owner, { at: new Date().toISOString(), event: 'unslot', slotId });
      out({ ok: true });
      return;
    }
    case 'journal': {
      const owner = await ownerFromArgs(args);
      const entry = { at: new Date().toISOString(), event: argValue(args, 'event') ?? '' };
      await writeJournal(root, owner, entry);
      out(entry);
      return;
    }
    case 'mode': {
      const owner = await ownerFromArgs(args);
      const partner = argValue(args, 'partner') as Role | undefined;
      if (!partner || !ROLES.includes(partner)) throw new Error('--partner must name a role.');
      out(await workMode(root, { me: owner, partner, wantsToEdit: list('paths') }));
      return;
    }
    case 'status': {
      out({
        root,
        slot: await currentSlot(root),
        claims: await activeClaims(root),
        pendingAttempts: await pendingAttempts(root),
        journals: Object.fromEntries(
          await Promise.all(
            ROLES.map(async (role) => [role, (await readJournal(root, role)).length]),
          ),
        ),
      });
      return;
    }
  }
}

if (process.argv[1] && /coordination\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/'))) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
