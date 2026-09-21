/**
 * The Automatic Change Review service.
 *
 * It keeps one durable record per work session under
 * `dataDir/change-review/<project>/<session>.json`: the run-start baseline,
 * the latest manifest and an append-only ledger of what the review did and
 * when. Builds are deterministic rebuilds — a manifest is never edited, only
 * recomputed from current evidence and replaced when its digest differs.
 *
 * The service learns about work two ways:
 * - `runStarted`, called by the work services before any of the run's writes
 *   can land, captures the baseline;
 * - the store's `change` event — every persist — covers terminal states,
 *   settle decisions and restores, including sessions the explicit hook
 *   missed. A rebuild is keyed on what actually changed (session state, change
 *   states, History length), not on the event count.
 *
 * No model, no network, no project-code execution anywhere in here.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Change, HistoryEntry, Session } from '../../shared/types.js';
import { isPackActive } from '../../shared/capability-packs.js';
import {
  canonicalJson,
  manifestContent,
  CHANGE_MANIFEST_SCHEMA,
  CHANGE_REVIEW_RENDERER_VERSION,
  CHANGE_REVIEW_RULES_VERSION,
  type ChangeEntry,
  type ChangeEvidenceRef,
  type ChangeReviewLedgerRow,
  type ChangeReviewManifest,
  type ChangeReviewOutcome,
  type ChangeReviewRecord,
  type ChangeTextEvidence,
  type ReviewBaseline,
  type ReviewCoverage,
  type ReviewLimit,
} from '../../shared/change-manifest.js';
import { absent, ApiError, projectFile, readTextOrNull } from '../paths.js';
import { jsonWrite, readJson, type Store } from '../store.js';
import { runChecks } from './checks.js';
import { businessExample } from './fixtures.js';
import {
  diffGitSnapshots,
  gitBlobText,
  prepareGit,
  snapshotGit,
  type GitEnvironment,
  type GitWorktreeFile,
} from './git.js';
import { outsideEntries, recordedEntries } from './recorded.js';
import { renderSummary } from './render.js';
import { runRules } from './rules.js';
import {
  baselineFrom,
  captureFolder,
  diffSnapshots,
  inspectFile,
  observedEntries,
  type FolderSnapshot,
} from './snapshot.js';
import { structuredEntry } from './structured.js';
import {
  TEXT_EVIDENCE_INPUT_LIMIT,
  TEXT_EVIDENCE_TOTAL_CHARS,
  textEvidenceFor,
} from './text-evidence.js';

const TERMINAL = new Set<Session['state']>(['done', 'stopped', 'failed']);
const TEXT_READ_LIMIT = 512 * 1024;
/** Total prefetched text per build — beyond it, entries classify without content. */
const PREFETCH_TOTAL_BYTES = 4 * 1024 * 1024;
/** Files prefetched per build. */
const PREFETCH_MAX_FILES = 64;
/** Change entries kept in one manifest — the rest are declared, not dropped silently. */
const CHANGE_CAP = 2_000;
/** Per-file baseline retention bound — before-content kept for later diffs. */
const RETAIN_FILE_BYTES = 64 * 1024;
/** Total retained before-content per baseline. */
const RETAIN_TOTAL_BYTES = 4 * 1024 * 1024;
/** Coverage notes kept per list. */
const COVERAGE_NOTE_CAP = 500;

interface SessionSeen {
  readonly state: string;
  readonly changes: ReadonlyMap<string, string>;
}

/** Bound one coverage-note list and declare the cut as a limit entry. */
function capNotes(
  notes: readonly { path: string; reason: string }[],
  name: string,
  limits: ReviewLimit[],
): { path: string; reason: string }[] {
  if (notes.length <= COVERAGE_NOTE_CAP) return [...notes];
  limits.push({
    limit: `${name}-note-cap`,
    detail: `${notes.length} ${name} paths found; the first ${COVERAGE_NOTE_CAP} are listed.`,
  });
  return notes.slice(0, COVERAGE_NOTE_CAP);
}

interface ProjectSeen {
  historyLength: number;
  readonly sessions: Map<string, SessionSeen>;
}

/** Deterministic manifest identity: sha256 over the content fields only. */
export function manifestDigest(manifest: Omit<ChangeReviewManifest, 'id' | 'digest'>): string {
  const hash = createHash('sha256');
  hash.update(canonicalJson(manifestContent(manifest as ChangeReviewManifest)));
  return `sha256:${hash.digest('hex')}`;
}

export class ChangeReviewService {
  private readonly records = new Map<string, Map<string, ChangeReviewRecord>>();
  private readonly seen = new Map<string, ProjectSeen>();
  private readonly chains = new Map<string, Promise<void>>();
  private gitEnvs = new Map<string, GitEnvironment>();
  private loaded = false;
  private closed = false;
  private readonly onChange = (projectId: string) => this.noteChange(projectId);

  constructor(
    private readonly store: Store,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    store.on('change', this.onChange);
  }

  /**
   * Shutdown drains what the change listener queued. The service writes into
   * the project data dir, so the app close must wait for in-flight builds —
   * otherwise a persist can land while the data dir is being removed. The
   * listener comes off first so closing services that still emit `change`
   * cannot queue new work behind the drain.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.store.off('change', this.onChange);
    await Promise.allSettled([...this.chains.values()]);
    const envs = [...this.gitEnvs.values()];
    this.gitEnvs.clear();
    for (const env of envs) await env.cleanup().catch(() => undefined);
  }

  private dir(projectId: string): string {
    return path.join(this.store.dataDir, 'change-review', projectId);
  }

  private file(projectId: string, sessionId: string): string {
    return path.join(this.dir(projectId), `${sessionId}.json`);
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let projectDirs: string[] = [];
    try {
      projectDirs = await fs.readdir(path.join(this.store.dataDir, 'change-review'));
    } catch (error) {
      if (!absent(error)) throw error;
      return;
    }
    for (const projectId of projectDirs) {
      let names: string[] = [];
      try {
        names = await fs.readdir(this.dir(projectId));
      } catch {
        continue;
      }
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        try {
          const record = await readJson<ChangeReviewRecord | null>(
            path.join(this.dir(projectId), name),
            () => null,
          );
          if (record && record.v === 1 && record.sessionId)
            this.mapFor(projectId).set(record.sessionId, record);
        } catch {
          // A damaged record is ignored; the next build recomputes from evidence.
        }
      }
    }
  }

  private mapFor(projectId: string): Map<string, ChangeReviewRecord> {
    let map = this.records.get(projectId);
    if (!map) {
      map = new Map();
      this.records.set(projectId, map);
    }
    return map;
  }

  private recordFor(projectId: string, sessionId: string): ChangeReviewRecord {
    const map = this.mapFor(projectId);
    let record = map.get(sessionId);
    if (!record) {
      record = { v: 1, projectId, sessionId, manifest: null, baseline: null, ledger: [] };
      map.set(sessionId, record);
    }
    return record;
  }

  private async persistRecord(record: ChangeReviewRecord): Promise<void> {
    await fs.mkdir(this.dir(record.projectId), { recursive: true });
    await jsonWrite(this.file(record.projectId, record.sessionId), record);
  }

  /**
   * Serialize the work each session needs so emits, lifecycle hooks and HTTP
   * reads can never interleave writes to the same record file. The chain
   * itself swallows failures so one bad job cannot stall the next; the caller
   * receives the real promise and sees its error.
   */
  private enqueue<T>(projectId: string, sessionId: string, job: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ApiError(503, 'The review service is closed.'));
    const key = `${projectId}/${sessionId}`;
    const run = (this.chains.get(key) ?? Promise.resolve()).then(job);
    this.chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  // --- baseline -----------------------------------------------------------------

  /**
   * Capture the run-start record. Called by the work services before the run's
   * own writes can land, and by the change listener when a session appears
   * without one (crash recovery, older paths). Idempotent per session, and
   * best-effort: a capture or persistence failure degrades to "no baseline"
   * and never fails the run it was trying to observe.
   */
  runStarted(projectId: string, sessionId: string, taskId: string | null): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.enqueue(projectId, sessionId, () =>
      this.captureBaseline(projectId, sessionId, taskId),
    ).catch(() => undefined);
  }

  /**
   * The blob store a baseline retains small text before-content into —
   * `dataDir/change-review/<project>/blobs/<sha256hex>`. Content-addressed, so
   * the same bytes are stored once across every baseline in the project, and
   * bounded per file (64 KB) and in total (4 MB) by the capture callback.
   */
  private blobDir(projectId: string): string {
    return path.join(this.dir(projectId), 'blobs');
  }

  private blobPath(projectId: string, sha: string): string {
    return path.join(this.blobDir(projectId), sha.replace(/^sha256:/, ''));
  }

  /** Retained before-content for a baseline file; null when nothing was kept. */
  private async retainedText(projectId: string, sha: string | null): Promise<string | null> {
    if (sha === null) return null;
    try {
      return await fs.readFile(this.blobPath(projectId, sha), 'utf8');
    } catch {
      return null;
    }
  }

  private async captureBaseline(
    projectId: string,
    sessionId: string,
    taskId: string | null,
  ): Promise<void> {
    const record = this.recordFor(projectId, sessionId);
    if (record.baseline) return;
    try {
      const state = this.store.state(projectId);
      let retained = 0;
      const snapshot = await captureFolder(state.project.folder, this.clock(), {
        retain: async (file) => {
          if (file.binary || file.size <= 0 || file.size > RETAIN_FILE_BYTES) return;
          if (retained >= RETAIN_TOTAL_BYTES) return;
          const target = this.blobPath(projectId, file.sha);
          try {
            await fs.stat(target);
            return; // Same bytes already retained by an earlier baseline.
          } catch {
            /* not retained yet */
          }
          const text = await readTextOrNull(file.absolute);
          if (text === null) return;
          await fs.mkdir(this.blobDir(projectId), { recursive: true });
          await fs.writeFile(target, text, 'utf8');
          retained += file.size;
        },
      });
      let git: ReviewBaseline['git'] = null;
      if (isPackActive(state.project.packs, 'diomedes.software-engineering')) {
        const env = await prepareGit(state.project.folder).catch(() => null);
        if (env) {
          this.gitEnvs.set(`${projectId}/${sessionId}`, env);
          const probe = await snapshotGit(env);
          git = probe.captured
            ? {
                captured: true,
                head: probe.head,
                statusDigest: probe.statusDigest,
                reason: null,
                files: probe.files.map((f) => ({ ...f })),
              }
            : { captured: false, head: env.head, statusDigest: null, reason: probe.reason };
        }
      }
      // The scope boundary is the session's first own entry: earlier History
      // is pre-existing work. A session that has not written yet scopes from now.
      const ownStart = state.history.findIndex(
        (entry: HistoryEntry) => entry.sessionId === sessionId || entry.taskId === taskId,
      );
      const historyStart = ownStart === -1 ? state.history.length : ownStart;
      record.baseline = baselineFrom(snapshot, historyStart, git);
      this.pushLedger(
        record,
        'baseline-captured',
        `${snapshot.files.length} files recorded`,
        null,
      );
      await this.persistRecord(record);
    } catch (error) {
      this.pushLedger(
        record,
        'baseline-captured',
        `baseline capture failed: ${error instanceof Error ? error.message : 'unknown'}`,
        null,
      );
      await this.persistRecord(record).catch(() => undefined);
    }
  }

  private pushLedger(
    record: ChangeReviewRecord,
    event: ChangeReviewLedgerRow['event'],
    detail: string,
    digest: string | null,
  ): void {
    (record.ledger as ChangeReviewLedgerRow[]).push({
      at: this.clock(),
      event,
      detail,
      digest,
    });
  }

  // --- the change listener --------------------------------------------------------

  /**
   * Scoped invalidation: a persist rebuilds only the reviews whose evidence
   * could have moved. A session rebuilds when its own state, a review decision
   * on a change in its scope or History entries scoped to it changed — and a
   * session still live (running or awaiting review) also rebuilds on any new
   * write in the project, because another writer's file lands in its observed
   * folder diff. Terminal sessions are never touched by later appends, even
   * from a later run of the same task: their manifest froze when they ended,
   * and serves as evidence of their own window. A keep or undo still reaches
   * them, because a task's review is its newest session's frozen manifest.
   */
  private noteChange(projectId: string): void {
    if (this.closed) return;
    let state;
    try {
      state = this.store.state(projectId);
    } catch {
      return; // Project went away mid-emit.
    }
    let seen = this.seen.get(projectId);
    if (!seen) {
      seen = { historyLength: 0, sessions: new Map<string, SessionSeen>() };
      this.seen.set(projectId, seen);
    }
    const newHistory = state.history.slice(seen.historyLength);
    seen.historyLength = state.history.length;
    const touchedSessions = new Set<string>();
    const touchedTasks = new Set<string>();
    let outsideChange = false;
    for (const entry of newHistory) {
      if (entry.sessionId) touchedSessions.add(entry.sessionId);
      if (entry.taskId) touchedTasks.add(entry.taskId);
      if (entry.kind === 'outside') outsideChange = true;
    }
    const projectChanged = newHistory.length > 0;
    for (const session of state.sessions) {
      const prior = seen.sessions.get(session.id);
      const changes = new Map(
        state.changes
          .filter((c: Change) => c.sessionId === session.id || c.taskId === session.taskId)
          .map((c: Change) => [c.id, c.state]),
      );
      seen.sessions.set(session.id, { state: session.state, changes });
      if (!prior) {
        // A session this service never saw. Eager work stays bounded: live
        // sessions get a baseline now, sessions waiting on review get a build,
        // and historical terminal sessions are left for the lazy read path —
        // a project with a long history must not pay for N folder walks on
        // the first emit.
        if (TERMINAL.has(session.state as Session['state']) && session.state !== 'waiting') {
          continue;
        }
        void this.enqueue(projectId, session.id, async () => {
          await this.captureBaseline(projectId, session.id, session.taskId);
          if (session.state === 'waiting' || TERMINAL.has(session.state as Session['state']))
            await this.build(projectId, session.id, 'built');
        }).catch(() => undefined);
        continue;
      }
      const stateMoved = prior.state !== session.state;
      // A change record seen for the first time is a new write, not a decision.
      const settles = [...changes.entries()].filter(
        ([id, nowState]) => prior.changes.has(id) && prior.changes.get(id) !== nowState,
      );
      const live = !TERMINAL.has(session.state as Session['state']);
      const ownHistory =
        touchedSessions.has(session.id) ||
        (live && session.taskId !== null && touchedTasks.has(session.taskId));
      const affected =
        stateMoved ||
        settles.length > 0 ||
        ownHistory ||
        (live && (projectChanged || outsideChange));
      if (!affected) continue;
      const record = this.recordFor(projectId, session.id);
      const event: ChangeReviewLedgerRow['event'] = settles.some(([, s]) => s === 'undone')
        ? 'rebuilt-undone'
        : settles.some(([, s]) => s === 'kept')
          ? 'rebuilt-kept'
          : ownHistory && state.history.at(-1)?.restoreOf
            ? 'rebuilt-restored'
            : record.manifest
              ? 'rebuilt-state'
              : 'built';
      void this.enqueue(projectId, session.id, async () => {
        if (!record.baseline) await this.captureBaseline(projectId, session.id, session.taskId);
        await this.build(projectId, session.id, event);
      }).catch(() => undefined);
    }
  }

  // --- accessors the rules and checks share ----------------------------------------

  /**
   * Bounded text reads for one build — recorded objects plus small worktree
   * files for observed entries. Local to the build: two sessions' prefetches
   * can never clobber each other. Keys are `path` for after-text and
   * `path\0before` for before-text; the map stops filling at
   * `PREFETCH_MAX_FILES` files or `PREFETCH_TOTAL_BYTES` bytes and reports
   * how many entries it left out.
   */
  private async prefetchTexts(
    projectId: string,
    folder: string,
    entries: readonly ChangeEntry[],
    gitEnv: GitEnvironment | null,
    baseline: ReviewBaseline | null,
  ): Promise<{ texts: Map<string, string>; omitted: number }> {
    const texts = new Map<string, string>();
    let bytes = 0;
    let filesRead = 0;
    let omitted = 0;
    const baselineByPath = new Map((baseline?.files ?? []).map((f) => [f.path, f]));
    const gitBaselineByPath = new Map((baseline?.git?.files ?? []).map((f) => [f.path, f]));
    const put = (key: string, text: string | null): boolean => {
      if (text === null) return false;
      if (bytes + text.length > PREFETCH_TOTAL_BYTES) return false;
      texts.set(key, text);
      bytes += text.length;
      return true;
    };
    const readWorktree = async (p: string): Promise<string | null> => {
      try {
        const { absolute } = await projectFile(folder, p);
        const stat = await fs.stat(absolute);
        if (stat.size > TEXT_READ_LIMIT) return null;
        return await readTextOrNull(absolute);
      } catch {
        return null;
      }
    };
    for (const entry of entries) {
      const budgeted = filesRead < PREFETCH_MAX_FILES;
      if (entry.kind !== 'deleted') {
        let after: string | null = null;
        if (!entry.binary && budgeted) {
          if (entry.attribution === 'recorded' && entry.afterSha) {
            after = await this.store.object(projectId, entry.afterSha).catch(() => null);
          } else if (entry.source !== 'structured') {
            after = await readWorktree(entry.path);
          }
        }
        if (after !== null && after.length > TEXT_EVIDENCE_INPUT_LIMIT)
          after = after.slice(0, TEXT_EVIDENCE_INPUT_LIMIT);
        if (!put(entry.path, after)) {
          if (after !== null || entry.attribution === 'recorded' || entry.kind === 'added')
            omitted += 1;
        } else filesRead += 1;
      }
      // Before-content for diffs: recorded object, retained baseline blob, or
      // the Git object store via the baseline's staged/HEAD blob id.
      let before: string | null = null;
      if (budgeted && !entry.binary) {
        if (entry.attribution === 'recorded' && entry.beforeSha) {
          before = await this.store.object(projectId, entry.beforeSha).catch(() => null);
        } else if (entry.source === 'folder' || entry.source === 'git') {
          const file = baselineByPath.get(entry.path);
          if (file) before = await this.retainedText(projectId, file.sha);
          if (before === null && gitEnv) {
            const gitFile = gitBaselineByPath.get(entry.path);
            // A baseline row carries its staged/HEAD blob ids; a path that was
            // clean at baseline has no row — its entry's beforeSha is then the
            // committed HEAD blob, which the object store can still serve.
            const sha = gitFile?.stagedSha ?? gitFile?.headSha ?? entry.beforeSha;
            if (sha) {
              const blob = await gitBlobText(gitEnv, sha);
              if (blob !== null && blob.length <= TEXT_EVIDENCE_INPUT_LIMIT) before = blob;
            }
          }
        }
      }
      if (!put(`${entry.path}\0before`, before)) {
        if (before !== null) omitted += 1;
      }
    }
    return { texts, omitted };
  }

  // --- the build --------------------------------------------------------------------

  private outcomeOf(
    session: Session | null,
    changes: readonly ChangeEntry[],
    declined: boolean,
  ): ChangeReviewOutcome {
    if (!session) return 'no-writes';
    if (session.state === 'queued' || session.state === 'working') return 'active';
    if (session.state === 'waiting') return 'waiting-review';
    if (session.state === 'failed') return 'failed';
    if (session.state === 'stopped') return declined ? 'declined' : 'stopped';
    return changes.length ? 'completed' : 'no-writes';
  }

  /**
   * Recompute the manifest for one session from current evidence, persist it
   * when the digest moved, and return it. Safe to call at any state — a live
   * session simply yields a live review.
   */
  async build(
    projectId: string,
    sessionId: string,
    event: ChangeReviewLedgerRow['event'] = 'built',
  ): Promise<ChangeReviewManifest> {
    const state = this.store.state(projectId);
    const session = state.sessions.find((s) => s.id === sessionId) ?? null;
    const record = this.recordFor(projectId, sessionId);
    const baseline = record.baseline;
    const task = session?.taskId ? state.tasks.find((t) => t.id === session.taskId) : null;
    const scope = {
      sessionId,
      taskId: session?.taskId ?? null,
      historyStart: baseline?.historyLength ?? 0,
    };

    // 1. Recorded writes — the exact attribution.
    const changes = state.changes.filter(
      (c: Change) => c.sessionId === sessionId || c.taskId === scope.taskId,
    );
    const recorded = recordedEntries(state.history, changes, scope);
    const claimed = new Set(recorded.map((c) => c.path));

    // 2. Folder comparison — what changed while the run was live.
    const limits: ReviewLimit[] = [];
    const coverage: {
      skipped: { path: string; reason: string }[];
      blocked: { path: string; reason: string }[];
      unavailable: { path: string; reason: string }[];
      inspected: number;
    } = { skipped: [], blocked: [], unavailable: [], inspected: 0 };
    let observed: ChangeEntry[] = [];
    if (baseline) {
      const endSnapshot = await captureFolder(state.project.folder, this.clock());
      coverage.skipped.push(...endSnapshot.skipped);
      coverage.blocked.push(...endSnapshot.blocked);
      coverage.unavailable.push(...endSnapshot.unavailable);
      coverage.inspected = endSnapshot.files.length;
      if (endSnapshot.filesSeen > endSnapshot.files.length)
        limits.push({
          limit: 'walk-cap',
          detail: `${endSnapshot.filesSeen} files seen; the first ${endSnapshot.files.length} were indexed.`,
        });
      // No wall-clock in the live listing ref: the same tree must digest to the
      // same evidence no matter when the rebuild happens.
      const listingEvidence = [
        { kind: 'baseline', listingDigest: baseline.listingDigest, capturedAt: baseline.capturedAt },
        {
          kind: 'folder-listing',
          listingDigest: endSnapshot.listingDigest,
        },
      ] as const;
      observed = observedEntries(
        diffSnapshots(baseline.files, endSnapshot.files),
        claimed,
        listingEvidence,
      );
      for (const entry of observed) claimed.add(entry.path);
      // Outside-change detections the store itself recorded in the window are
      // observed evidence with exact History behind them.
      for (const entry of outsideEntries(state.history, scope, claimed)) {
        observed.push(entry);
        claimed.add(entry.path);
      }
    }

    // 3. Git — when the pack captured a baseline, diff it to now.
    let gitObserved: ChangeEntry[] = [];
    let gitEnv: GitEnvironment | null = null;
    const gitKey = `${projectId}/${sessionId}`;
    if (baseline?.git?.captured && baseline.git.files) {
      try {
        gitEnv = this.gitEnvs.get(gitKey) ?? (await prepareGit(state.project.folder));
        if (gitEnv) {
          this.gitEnvs.set(gitKey, gitEnv);
          const probe = await snapshotGit(gitEnv);
          if (probe.captured) {
            const before = baseline.git.files as readonly GitWorktreeFile[];
            gitObserved = diffGitSnapshots(before, probe.files, [
              { kind: 'git-record', record: `head:${probe.head ?? 'none'}` },
            ]).filter((entry) => !claimed.has(entry.path));
            for (const entry of gitObserved) claimed.add(entry.path);
          }
        }
      } catch {
        // Git evidence is additive; a failed probe never fails the review.
      }
    }

    const detected = recorded.length + observed.length + gitObserved.length;
    let entries = [...recorded, ...observed, ...gitObserved].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    if (entries.length > CHANGE_CAP) {
      entries = entries.slice(0, CHANGE_CAP);
      limits.push({
        limit: 'change-cap',
        detail: `${detected} changed entries detected; the first ${CHANGE_CAP} were indexed.`,
      });
    }

    // 4. Bounded content reads, then exact text evidence per entry.
    const { texts, omitted } = await this.prefetchTexts(
      projectId,
      state.project.folder,
      entries,
      gitEnv,
      baseline,
    );
    if (omitted > 0)
      limits.push({
        limit: 'prefetch-budget',
        detail: `Text prefetch stopped at its budget; ${omitted} ${omitted === 1 ? 'entry was' : 'entries were'} left without content.`,
      });
    const changesByPath = new Map(changes.map((c: Change) => [c.path, c]));
    const recordedPaths = new Set(entries.filter((e) => e.attribution === 'recorded').map((e) => e.path));
    const textFor = (p: string, side: 'before' | 'after'): string | null => {
      if (recordedPaths.has(p)) {
        const change = changesByPath.get(p);
        const text = side === 'after' ? change?.after : change?.before;
        if (text !== null && text !== undefined) return text;
      }
      return texts.get(side === 'before' ? `${p}\0before` : p) ?? null;
    };
    let evidenceChars = 0;
    const withEvidence: ChangeEntry[] = [];
    for (const entry of entries) {
      let evidence = entry.textEvidence;
      if (entry.source !== 'structured') {
        const change = changesByPath.get(entry.path);
        evidence = textEvidenceFor({
          binary: entry.binary,
          deleted: entry.kind === 'deleted',
          before: textFor(entry.path, 'before'),
          after: entry.kind === 'deleted' ? null : textFor(entry.path, 'after'),
          hunks: change?.hunks ?? null,
        });
        if (evidence.text !== null && evidenceChars + evidence.text.length > TEXT_EVIDENCE_TOTAL_CHARS) {
          evidence = {
            kind: 'none',
            text: null,
            truncated: false,
            truncatedLines: 0,
            reason: 'evidence-limit',
          };
        } else if (evidence.text !== null) {
          evidenceChars += evidence.text.length;
        }
      }
      withEvidence.push(evidence === entry.textEvidence ? entry : { ...entry, textEvidence: evidence });
    }
    entries = withEvidence;
    if (entries.some((e) => e.textEvidence.reason === 'evidence-limit'))
      limits.push({
        limit: 'text-evidence-budget',
        detail: `Exact text evidence stopped at ${Math.floor(TEXT_EVIDENCE_TOTAL_CHARS / 1024)} KB across the manifest.`,
      });
    const currentSha = async (p: string): Promise<string | null> => {
      try {
        const { absolute } = await projectFile(state.project.folder, p);
        const stat = await fs.stat(absolute);
        if (!stat.isFile()) return null;
        // Streamed — arbitrary file sizes never buffer whole.
        return (await inspectFile(absolute)).sha;
      } catch {
        return null;
      }
    };

    // 5. Checks, then rules (rules see check staleness), then render.
    const declined = state.needs.some(
      (n) => n.sessionId === sessionId && n.state === 'declined',
    );
    const uncertainEffects = (task?.stopReceipts ?? [])
      .filter((receipt) => receipt.sessionId === sessionId || receipt.sessionId === null)
      .flatMap((receipt) => receipt.uncertainEffects);
    const inputDigest = `sha256:${createHash('sha256')
      .update(canonicalJson(entries.map((e) => [e.path, e.kind, e.afterSha])))
      .digest('hex')}`;
    const checks = await runChecks({
      changes: entries,
      textFor,
      currentSha,
      structuredRecords: [],
      ranAt: this.clock(),
      softwarePack: isPackActive(state.project.packs, 'diomedes.software-engineering'),
    });
    const baselineEvidence: ChangeEvidenceRef[] = baseline
      ? [
          {
            kind: 'baseline',
            listingDigest: baseline.listingDigest,
            capturedAt: baseline.capturedAt,
          },
        ]
      : [{ kind: 'baseline', listingDigest: null, capturedAt: null }];
    const { flags, facts } = runRules({
      changes: entries,
      textFor,
      coverage,
      uncertainEffects,
      checks,
      currentInputDigest: inputDigest,
      baselineEvidence,
    });
    const outcome = this.outcomeOf(session, entries, declined);
    const summary = renderSummary(facts, flags, checks, {
      outcome,
      baseline,
    });

    const draft: Omit<ChangeReviewManifest, 'id' | 'digest'> = {
      schemaVersion: CHANGE_MANIFEST_SCHEMA,
      subject: {
        kind: 'task-run' as const,
        projectId,
        taskId: scope.taskId,
        sessionId,
        label: task ? `Task: ${task.name}` : `Run ${sessionId}`,
      },
      outcome,
      baseline: baseline ? { ...baseline, git: baseline.git ? { ...baseline.git, files: undefined } : null } : null,
      baselineReason: baseline
        ? null
        : 'This run started before its review baseline existed; only recorded writes and current state are shown.',
      changes: entries,
      facts,
      flags,
      checks,
      summary,
      coverage: {
        inspected: coverage.inspected,
        skipped: capNotes(coverage.skipped, 'skipped', limits),
        blocked: capNotes(coverage.blocked, 'blocked', limits),
        unavailable: capNotes(coverage.unavailable, 'unavailable', limits),
        limits,
      } satisfies ReviewCoverage,
      generatedAt: this.clock(),
      rulesVersion: CHANGE_REVIEW_RULES_VERSION,
      rendererVersion: CHANGE_REVIEW_RENDERER_VERSION,
    };
    const digest = manifestDigest(draft);
    const manifest: ChangeReviewManifest = {
      ...draft,
      id: `cr_${digest.slice(7, 23)}`,
      digest,
    };

    if (record.manifest?.digest !== digest || record.baseline === null) {
      record.manifest = manifest;
      this.pushLedger(
        record,
        event,
        `${entries.length} ${entries.length === 1 ? 'change' : 'changes'}, outcome ${outcome}`,
        digest,
      );
      await this.persistRecord(record);
    }
    // A terminal session never rebuilds — its private Git index copy and temp
    // dir are released here rather than held for the app's lifetime.
    if (session && TERMINAL.has(session.state)) {
      const env = this.gitEnvs.get(gitKey);
      if (env) {
        this.gitEnvs.delete(gitKey);
        await env.cleanup().catch(() => undefined);
      }
    }
    return manifest;
  }

  /** The manifest a task shows: its most recent session's review. */
  manifestForTask(projectId: string, taskId: string): Promise<ChangeReviewManifest | null> {
    const state = this.store.state(projectId);
    const sessions = state.sessions
      .filter((s) => s.taskId === taskId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const session = sessions.at(-1);
    if (!session) return Promise.resolve(null);
    return this.enqueue(projectId, session.id, () => this.serve(projectId, session));
  }

  /**
   * Live sessions rebuild on demand; a terminal session's manifest is frozen
   * evidence of its own window and is served as it was recorded — rebuilding
   * it later would mislabel post-run writes as having changed during the run.
   */
  private async serve(projectId: string, session: Session): Promise<ChangeReviewManifest> {
    const record = this.recordFor(projectId, session.id);
    if (record.manifest && TERMINAL.has(session.state)) return record.manifest;
    if (!record.baseline)
      await this.captureBaseline(projectId, session.id, session.taskId);
    return this.build(projectId, session.id, 'rebuilt-state');
  }

  manifestForSession(projectId: string, sessionId: string): Promise<ChangeReviewManifest> {
    return this.enqueue(projectId, sessionId, async () => {
      const session = this.store.state(projectId).sessions.find((s) => s.id === sessionId);
      if (!session) throw new ApiError(404, 'This work session was not found.');
      return this.serve(projectId, session);
    });
  }

  /** A deterministic example review: same differ, rules, checks and renderer. */
  async exampleManifest(exampleId: string, projectId: string): Promise<ChangeReviewManifest> {
    const example = businessExample(exampleId);
    if (!example) throw new ApiError(404, 'This example was not found.');
    const entry = structuredEntry(example.record, example.before, example.after);
    const { flags, facts } = runRules({
      changes: [entry],
      textFor: () => null,
      coverage: { skipped: [], blocked: [], unavailable: [] },
      uncertainEffects: [],
      checks: [],
      currentInputDigest: null,
      baselineEvidence: [{ kind: 'baseline', listingDigest: null, capturedAt: null }],
    });
    const summary = renderSummary(facts, flags, [], { outcome: 'completed', baseline: null });
    const draft: Omit<ChangeReviewManifest, 'id' | 'digest'> = {
      schemaVersion: CHANGE_MANIFEST_SCHEMA,
      subject: {
        kind: 'example' as const,
        projectId,
        taskId: null,
        sessionId: null,
        label: example.title,
      },
      outcome: 'completed' as const,
      baseline: null,
      baselineReason: 'An example review built from a fixed before/after record.',
      changes: [entry],
      facts,
      flags,
      checks: [],
      summary,
      coverage: { inspected: 0, skipped: [], blocked: [], unavailable: [], limits: [] },
      generatedAt: this.clock(),
      rulesVersion: CHANGE_REVIEW_RULES_VERSION,
      rendererVersion: CHANGE_REVIEW_RENDERER_VERSION,
    };
    const digest = manifestDigest(draft);
    return { ...draft, id: `cr_${digest.slice(7, 23)}`, digest };
  }
}
