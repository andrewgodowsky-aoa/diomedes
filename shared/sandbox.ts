/**
 * Delegate and worker sandboxes, and the change sets they hand back (H13 slice
 * 2, H14; Andrew's decision of 2026-09-24).
 *
 * Every delegate a Diomedes loop hands work to, and every H14 worker, runs in
 * its own sandbox: an isolated working copy of the scope it was handed, held in
 * the parent run's own area. Its writes land in that copy through H12's
 * containment funnel rooted at the copy, never in the project. When it
 * finishes, the copy is compared with the snapshot taken when it was made, and
 * the difference comes back to the parent as a recorded change set:
 *
 * - an entry inside what the parent may apply (the scope the person gave the
 *   loop at start, intersected with the child's own) is applied by the parent
 *   through the one recorded write path, attributed to the model that wrote it;
 * - every other entry (outside that scope, a deletion, or one the child only
 *   proposed) waits for a person as an ordinary Need, reviewed with P06's
 *   readable diff and kept or discarded per entry, or per hunk;
 * - an entry whose file changed in the project after the snapshot is a
 *   conflict, and is never written over.
 *
 * Pure: types, limits and projections. Client and server share it.
 */
import type { OriginSnapshot } from './attribution.js';
import type { HarnessBudget } from './harness.js';

/** Bounds on one sandbox. A scope that would pass them is refused whole, with the numbers. */
export const SANDBOX_LIMITS = Object.freeze({
  /** Files one sandbox copy may hold. */
  maxFiles: 200,
  /** Bytes across every file in one copy. */
  maxBytes: 8 * 1024 * 1024,
  /** Bytes one file in the copy may hold, and one write may put there. */
  maxFileBytes: 1024 * 1024,
  /** Entries a handoff may declare as its scope. */
  scopeEntries: 32,
});

/**
 * Delegation limits that allow a team. Depth counts handoffs from the loop the
 * person started: its delegates are depth 1, and theirs depth 2, which may not
 * hand work on. A run may start at most four delegates in all, and those it
 * starts in one call run at the same time. Each child's budget is carved from
 * its parent's remaining budget, never added on top of it.
 */
export const DELEGATION_LIMITS = Object.freeze({
  depth: 2,
  perRun: 4,
  /** Units a parent always keeps for itself, so a carve never leaves it unable to finish. */
  reserveUnits: 2,
  /** The most units one delegate is carved, before the parent's remaining budget decides. */
  delegateUnits: 8,
  /** A delegate below this many units could not act and answer, so it is not started. */
  minimumUnits: 2,
});

/** Whether a project-relative path sits inside a scope of files and folders. Null scope is everything. */
export function inScope(path: string, scope: readonly string[] | null): boolean {
  if (scope === null) return true;
  return scope.some((entry) => entry === '.' || path === entry || path.startsWith(`${entry}/`));
}

/**
 * A child's scope: what the handoff declared, held inside the parent's. An
 * entry the parent does not cover is dropped and named; nothing is widened.
 */
export function intersectScope(
  parent: readonly string[] | null,
  declared: readonly string[] | null,
): { scope: readonly string[] | null; outside: readonly string[] } {
  if (declared === null) return { scope: parent === null ? null : [...parent], outside: [] };
  if (parent === null) return { scope: [...declared], outside: [] };
  const kept: string[] = [];
  const outside: string[] = [];
  for (const entry of declared) {
    if (inScope(entry, parent)) kept.push(entry);
    // A folder the parent only partly covers narrows to the parent's entries under it.
    else {
      const under = parent.filter((item) => item.startsWith(`${entry}/`));
      if (under.length) kept.push(...under);
      else outside.push(entry);
    }
  }
  return { scope: [...new Set(kept)], outside };
}

/**
 * Carve `count` children's budgets from what the parent has left. The parent
 * keeps `reserveUnits`; each child gets an equal share up to `delegateUnits`,
 * with one model and one tool call per two units. Null when the share is too
 * small to be worth starting, with the sentence that says so.
 */
export function carveBudget(
  parent: { budget: HarnessBudget; used: { units: number } },
  count: number,
  ceiling: number = DELEGATION_LIMITS.delegateUnits,
): { budget: HarnessBudget; turns: number; total: number; refusal: null } | { budget: null; turns: 0; total: 0; refusal: string } {
  const remaining = Math.max(0, parent.budget.units - parent.used.units);
  const share = Math.min(ceiling, Math.floor(Math.max(0, remaining - DELEGATION_LIMITS.reserveUnits) / Math.max(1, count)));
  if (share < DELEGATION_LIMITS.minimumUnits)
    return {
      budget: null,
      turns: 0,
      total: 0,
      refusal: `This run has ${remaining} of its ${parent.budget.units} units left, which is not enough to carve ${count === 1 ? 'a sub-task' : `${count} sub-tasks`} from while keeping ${DELEGATION_LIMITS.reserveUnits} for itself.`,
    };
  const turns = Math.max(1, Math.floor(share / 2));
  return {
    budget: { units: share, modelCalls: turns, toolCalls: turns, wallMs: null },
    turns,
    total: share * count,
    refusal: null,
  };
}

/** Where a sandbox's copy was taken from: the project, or its parent delegate's sandbox (depth 2). */
export type SandboxBase = { readonly kind: 'project' } | { readonly kind: 'sandbox'; readonly runId: string };

export interface SandboxFile {
  readonly path: string;
  /** sha-256 of the exact bytes copied, which for UTF-8 text is `hash(text)`. */
  readonly sha: string;
  readonly bytes: number;
}

/** A sandbox as it is kept on disk beside its parent run. Written before the copy, finished after. */
export interface SandboxManifest {
  readonly v: 1;
  readonly projectId: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly rootRunId: string;
  readonly depth: number;
  readonly role: 'delegate' | 'worker';
  readonly base: SandboxBase;
  /** The files and folders this child may read and change; null is the parent's whole scope. */
  readonly scope: readonly string[] | null;
  readonly createdAt: string;
  /** `creating` until the copy is whole; `open` while the child works; `collected` once its change set is recorded. */
  readonly state: 'creating' | 'open' | 'collected';
  /** What was copied, as it was when copied: the snapshot a change set is measured against. */
  readonly files: readonly SandboxFile[];
}

export type ChangeSetOp = 'created' | 'modified' | 'deleted';

export interface ChangeSetEntry {
  readonly index: number;
  readonly path: string;
  readonly op: ChangeSetOp;
  /** The snapshot's sha, or null for a file the child created. */
  readonly before: string | null;
  /** The child's sha, or null for a file it deleted. */
  readonly after: string | null;
  readonly bytes: number;
  /** The child used `propose_file`: it asked for a person, so the parent never applies it. */
  readonly proposed: boolean;
}

/** One change set, recorded once when its child finished. Append-only, like every decision on it. */
export interface ChangeSetRecord {
  readonly v: 1;
  readonly id: string;
  readonly projectId: string;
  readonly rootRunId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly handoffId: string;
  readonly role: 'delegate' | 'worker';
  readonly depth: number;
  readonly taskId: string | null;
  /** The Session of the loop the person started, where the change set's Need is raised. */
  readonly sessionId: string | null;
  readonly recordedAt: string;
  /** Who wrote these changes: the model the runtime reported for the child, or an application action. */
  readonly origin: OriginSnapshot;
  readonly models: readonly { readonly engine: string | null; readonly reported: string | null; readonly calls: number }[];
  readonly scope: readonly string[] | null;
  /** What the parent may apply without asking: the scope the person gave the loop, null for none. */
  readonly applyScope: readonly string[] | null;
  readonly entries: readonly ChangeSetEntry[];
  /** Anything in the copy that was not returned, and why (a link, a file outside its scope). */
  readonly dropped: readonly { readonly path: string; readonly reason: string }[];
}

export type ChangeSetDecisionKind = 'applied' | 'kept' | 'discarded' | 'conflict' | 'waiting';

/** One decision about one entry. The newest decision of an entry is its state. */
export interface ChangeSetDecision {
  readonly v: 1;
  readonly changeSetId: string;
  readonly index: number;
  readonly kind: ChangeSetDecisionKind;
  readonly at: string;
  /** `diomedes` for the parent applying inside its scope, `you` for a person, `delegate` for a depth-1 merge. */
  readonly by: 'diomedes' | 'you' | 'delegate';
  /** The History entry the write made, when it made one. */
  readonly entryId: string | null;
  /** The Need a waiting entry is raised under. */
  readonly needId: string | null;
  /** Hunks kept when a person kept part of an entry (P06 indexes), else null. */
  readonly hunks: readonly number[] | null;
  readonly currentSha: string | null;
  readonly reason: string | null;
  readonly commandId: string | null;
}

export type ChangeSetEntryState = 'applied' | 'kept' | 'discarded' | 'conflict' | 'waiting' | 'pending';

export interface ChangeSetEntryView extends ChangeSetEntry {
  readonly state: ChangeSetEntryState;
  readonly decision: ChangeSetDecision | null;
}

export interface ChangeSetView {
  readonly id: string;
  readonly childRunId: string;
  readonly parentRunId: string;
  readonly rootRunId: string;
  readonly handoffId: string;
  readonly role: 'delegate' | 'worker';
  readonly depth: number;
  readonly recordedAt: string;
  readonly origin: OriginSnapshot;
  readonly models: ChangeSetRecord['models'];
  readonly entries: readonly ChangeSetEntryView[];
  readonly dropped: ChangeSetRecord['dropped'];
  readonly needId: string | null;
  readonly counts: Readonly<Record<ChangeSetEntryState, number>>;
}

/** What a parent's model is told about the change set its child returned. */
export interface ChangeSetSummary {
  readonly id: string;
  readonly applied: readonly string[];
  readonly waiting: readonly string[];
  readonly conflicts: readonly string[];
  readonly needId: string | null;
}

/** A change set as a person reads it: every entry with its newest decision. */
export function changeSetView(record: ChangeSetRecord, decisions: readonly ChangeSetDecision[]): ChangeSetView {
  const mine = decisions.filter((item) => item.changeSetId === record.id);
  const entries = record.entries.map((entry): ChangeSetEntryView => {
    const decision = mine.filter((item) => item.index === entry.index).at(-1) ?? null;
    return { ...entry, state: decision ? decision.kind : 'pending', decision };
  });
  const counts = { applied: 0, kept: 0, discarded: 0, conflict: 0, waiting: 0, pending: 0 };
  for (const entry of entries) counts[entry.state] += 1;
  return {
    id: record.id,
    childRunId: record.childRunId,
    parentRunId: record.parentRunId,
    rootRunId: record.rootRunId,
    handoffId: record.handoffId,
    role: record.role,
    depth: record.depth,
    recordedAt: record.recordedAt,
    origin: record.origin,
    models: record.models,
    entries,
    dropped: record.dropped,
    needId: mine.filter((item) => item.needId).at(-1)?.needId ?? null,
    counts,
  };
}

/** Whether an entry still waits for a person's decision. */
export const undecided = (entry: ChangeSetEntryView) => entry.state === 'waiting' || entry.state === 'pending';

export function summaryOf(view: ChangeSetView): ChangeSetSummary {
  return {
    id: view.id,
    applied: view.entries.filter((entry) => entry.state === 'applied').map((entry) => entry.path),
    waiting: view.entries.filter(undecided).map((entry) => entry.path),
    conflicts: view.entries.filter((entry) => entry.state === 'conflict').map((entry) => entry.path),
    needId: view.needId,
  };
}
