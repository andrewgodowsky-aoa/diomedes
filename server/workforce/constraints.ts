/**
 * DEMO-03.PREP — pure deterministic workforce-constraints evaluation.
 *
 * No scheduler, authority store, app, persistence, notification, approval
 * simulation, or policy judgment lives here. Inputs are client-supplied data
 * validated by `shared/workforce.ts`; this module only checks them against
 * owner-provided rules and searches bounded, deterministic proposals.
 *
 * Conventions:
 * - Pure and immutable: inputs are never mutated; every result is freshly
 *   allocated and sorted deterministically (by id, then start instant).
 * - Unknown critical data yields invalid/unknown, never confident feasible.
 * - Availability is NOT acceptance: every emitted draft carries
 *   `status: 'acceptance-pending'`.
 */
import {
  draftAssignmentSchema,
  instantToMs,
  intervalsOverlapMs,
  overlapMinutesMs,
  parseWorkforceSnapshot,
  type DraftAssignment,
  type WorkforceDemand,
  type WorkforceSnapshot,
  type WorkforceWorker,
} from '../../shared/workforce.js';

export const DEFAULT_MAX_NODES = 5000;
export const MAX_NODES_CAP = 50_000;
export const DEFAULT_MAX_PROPOSALS = 1;
export const MAX_PROPOSALS_CAP = 16;

export type ConflictCode =
  | 'unknown-worker'
  | 'unknown-demand'
  | 'invalid-draft'
  | 'invalid-snapshot'
  | 'role-unqualified'
  | 'unavailable'
  | 'on-absence'
  | 'double-booked'
  | 'insufficient-rest'
  | 'insufficient-travel-gap'
  | 'workweek-exceeded'
  | 'under-covered'
  | 'over-covered';

export interface WorkforceConflict {
  readonly code: ConflictCode;
  readonly demandId?: string;
  readonly workerId?: string;
  /** Human-readable reason citing the ids and the rule involved. */
  readonly reason: string;
}

export interface DemandCoverage {
  readonly demandId: string;
  readonly required: number;
  readonly assigned: number;
  readonly covered: boolean;
  readonly assigneeIds: readonly string[];
}

export interface ValidateDraftsResult {
  readonly valid: boolean;
  readonly coverage: readonly DemandCoverage[];
  readonly conflicts: readonly WorkforceConflict[];
}

export type ProposalStatus = 'feasible' | 'infeasible' | 'search-incomplete' | 'invalid';

export interface SearchOptions {
  /** Bounding budget for candidate-eligibility evaluations. Default 5000. */
  readonly maxNodes?: number;
  /** Bound for alternative search statistics; only the first draft is returned. Default 1. */
  readonly maxProposals?: number;
}

export interface SearchProposalsResult {
  readonly status: ProposalStatus;
  readonly assignments: readonly DraftAssignment[];
  readonly coverage: readonly DemandCoverage[];
  readonly conflicts: readonly WorkforceConflict[];
  readonly stats: {
    readonly nodesVisited: number;
    readonly nodesBudget: number;
    readonly proposalsConsidered: number;
  };
  readonly issues?: readonly string[];
}

interface ParsedDemand extends WorkforceDemand {
  startMs: number;
  endMs: number;
  minutes: number;
}

interface ParsedWorker extends WorkforceWorker {
  availabilityMs: ReadonlyArray<{ start: number; end: number }>;
  absencesMs: ReadonlyArray<{ start: number; end: number }>;
}

function unionIntervals(intervals: { start: number; end: number }[]): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = [];
  for (const interval of intervals.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function parseSnapshot(snapshot: WorkforceSnapshot): {
  demands: ParsedDemand[];
  workers: Map<string, ParsedWorker>;
} {
  const workers = new Map<string, ParsedWorker>();
  for (const worker of snapshot.workers) {
    workers.set(worker.id, {
      ...worker,
      availabilityMs: unionIntervals(worker.availability.map((interval) => ({
        start: instantToMs(interval.start),
        end: instantToMs(interval.end),
      }))),
      absencesMs: worker.absences.map((interval) => ({
        start: instantToMs(interval.start),
        end: instantToMs(interval.end),
      })),
    });
  }
  const demands: ParsedDemand[] = snapshot.demands.map((demand) => {
    const startMs = instantToMs(demand.start);
    const endMs = instantToMs(demand.end);
    return { ...demand, startMs, endMs, minutes: Math.floor((endMs - startMs) / 60_000) };
  });
  demands.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { demands, workers };
}

function demandById(demands: ParsedDemand[], id: string): ParsedDemand | undefined {
  return demands.find((demand) => demand.id === id);
}

function shiftCoveredByAvailability(worker: ParsedWorker, startMs: number, endMs: number): boolean {
  return worker.availabilityMs.some((slot) => slot.start <= startMs && endMs <= slot.end);
}

function shiftOnAbsence(worker: ParsedWorker, startMs: number, endMs: number): boolean {
  return worker.absencesMs.some((slot) => intervalsOverlapMs(startMs, endMs, slot.start, slot.end));
}

/** Minutes of a demand counted into the configured workweek window. */
function countedWeekMinutes(
  demand: ParsedDemand,
  weekStartMs: number,
  weekEndMs: number,
): number {
  return overlapMinutesMs(demand.startMs, demand.endMs, weekStartMs, weekEndMs);
}

interface AssignmentPlan {
  workerId: string;
  demand: ParsedDemand;
}

/**
 * Single-assignment eligibility of `worker` for `demand` given the worker's
 * already-planned assignments. Returns null when eligible, else a conflict
 * (without the draft-shape wrapper).
 */
function eligibilityConflict(
  snapshot: WorkforceSnapshot,
  worker: ParsedWorker,
  demand: ParsedDemand,
  planned: readonly AssignmentPlan[],
  weekStartMs: number,
  weekEndMs: number,
): WorkforceConflict | null {
  if (!worker.roles.includes(demand.role)) {
    return {
      code: 'role-unqualified',
      demandId: demand.id,
      workerId: worker.id,
      reason: `worker ${worker.id} lacks role ${demand.role} for demand ${demand.id}`,
    };
  }
  if (!shiftCoveredByAvailability(worker, demand.startMs, demand.endMs)) {
    return {
      code: 'unavailable',
      demandId: demand.id,
      workerId: worker.id,
      reason: `demand ${demand.id} is not inside worker ${worker.id} availability`,
    };
  }
  if (shiftOnAbsence(worker, demand.startMs, demand.endMs)) {
    return {
      code: 'on-absence',
      demandId: demand.id,
      workerId: worker.id,
      reason: `demand ${demand.id} overlaps approved absence of worker ${worker.id}`,
    };
  }
  const ordered = [...planned, { workerId: worker.id, demand }]
    .filter((plan) => plan.workerId === worker.id)
    .map((plan) => plan.demand)
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
  const preceding = worker.precedingShift;
  if (preceding) {
    const gap = (ordered[0].startMs - instantToMs(preceding.end)) / 60_000;
    const travel = preceding.location === ordered[0].location ? 0 : snapshot.rules.travelGapMinutes;
    if (gap < snapshot.rules.minRestMinutes || gap < travel) {
      return {
        code: gap < snapshot.rules.minRestMinutes ? 'insufficient-rest' : 'insufficient-travel-gap',
        demandId: ordered[0].id, workerId: worker.id,
        reason: `worker ${worker.id} has only ${gap} minutes after the preceding shift`,
      };
    }
  }
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const next = ordered[i];
    if (intervalsOverlapMs(prev.startMs, prev.endMs, next.startMs, next.endMs)) {
      return {
        code: 'double-booked',
        demandId: demand.id,
        workerId: worker.id,
        reason: `worker ${worker.id} already assigned overlapping demand ${prev.id} with demand ${demand.id}`,
      };
    }
    const gapMinutes = Math.floor((next.startMs - prev.endMs) / 60_000);
    if (gapMinutes < snapshot.rules.minRestMinutes) {
      return {
        code: 'insufficient-rest',
        demandId: demand.id,
        workerId: worker.id,
        reason:
          `worker ${worker.id} has ${gapMinutes} min rest between ${prev.id} and ${next.id}, ` +
          `below minimum ${snapshot.rules.minRestMinutes}`,
      };
    }
    if (prev.location !== next.location && gapMinutes < snapshot.rules.travelGapMinutes) {
      return {
        code: 'insufficient-travel-gap',
        demandId: demand.id,
        workerId: worker.id,
        reason:
          `worker ${worker.id} has ${gapMinutes} min travel gap between ${prev.id} ` +
          `(${prev.location}) and ${next.id} (${next.location}), below minimum ${snapshot.rules.travelGapMinutes}`,
      };
    }
  }
  const weekTotal =
    worker.priorWeekMinutes +
    ordered.reduce((sum, item) => sum + countedWeekMinutes(item, weekStartMs, weekEndMs), 0);
  if (weekTotal > snapshot.rules.maxWeekMinutes) {
    return {
      code: 'workweek-exceeded',
      demandId: demand.id,
      workerId: worker.id,
      reason:
        `worker ${worker.id} would reach ${weekTotal} workweek minutes, ` +
        `above maximum ${snapshot.rules.maxWeekMinutes}`,
    };
  }
  return null;
}

function buildCoverage(
  demands: ParsedDemand[],
  assignments: readonly DraftAssignment[],
): DemandCoverage[] {
  const byDemand = new Map<string, string[]>();
  for (const assignment of assignments) {
    const list = byDemand.get(assignment.demandId) ?? [];
    list.push(assignment.workerId);
    byDemand.set(assignment.demandId, list);
  }
  return demands.map((demand) => {
    const assignees = [...(byDemand.get(demand.id) ?? [])].sort();
    return {
      demandId: demand.id,
      required: demand.requiredCount,
      assigned: assignees.length,
      covered: assignees.length >= demand.requiredCount,
      assigneeIds: assignees,
    };
  });
}

function sortConflicts(conflicts: WorkforceConflict[]): WorkforceConflict[] {
  return [...conflicts].sort((a, b) =>
    a.code < b.code ? -1
    : a.code > b.code ? 1
    : (a.demandId ?? '') < (b.demandId ?? '') ? -1
    : (a.demandId ?? '') > (b.demandId ?? '') ? 1
    : (a.workerId ?? '') < (b.workerId ?? '') ? -1
    : (a.workerId ?? '') > (b.workerId ?? '') ? 1
    : a.reason < b.reason ? -1
    : a.reason > b.reason ? 1
    : 0,
  );
}

/**
 * Independently verify proposed drafts against a snapshot. Draft shape,
 * id resolvability, qualification, availability, absence, overlap, rest,
 * travel, workweek, and coverage are all checked; every failure is reported
 * with ids and a reason. Never mutates its inputs.
 */
export function validateDrafts(
  snapshotInput: unknown,
  draftsInput: readonly unknown[],
): ValidateDraftsResult {
  const parsed = parseWorkforceSnapshot(snapshotInput);
  if (!parsed.ok) {
    return {
      valid: false,
      coverage: [],
      conflicts: parsed.issues.map((issue) => ({
        code: 'invalid-snapshot' as const,
        reason: `invalid snapshot: ${issue}`,
      })),
    };
  }
  const snapshot = parsed.snapshot;
  const { demands, workers } = parseSnapshot(snapshot);
  const weekStartMs = instantToMs(snapshot.rules.workweekStart);
  const weekEndMs = instantToMs(snapshot.rules.workweekEnd);

  const conflicts: WorkforceConflict[] = [];
  const acceptedShape: DraftAssignment[] = [];
  for (const draft of draftsInput) {
    const shape = draftAssignmentSchema.safeParse(draft);
    if (!shape.success) {
      conflicts.push({
        code: 'invalid-draft',
        reason: `draft is not an acceptance-pending assignment: ${shape.error.issues.map((issue) => issue.message).join('; ')}`,
      });
      continue;
    }
    acceptedShape.push(shape.data);
  }

  const seenPairs = new Set<string>();
  const planned: AssignmentPlan[] = [];
  for (const draft of acceptedShape) {
    const pairKey = JSON.stringify([draft.demandId, draft.workerId]);
    if (seenPairs.has(pairKey)) {
      conflicts.push({
        code: 'over-covered',
        demandId: draft.demandId,
        workerId: draft.workerId,
        reason: `duplicate draft for demand ${draft.demandId} and worker ${draft.workerId}`,
      });
      continue;
    }
    seenPairs.add(pairKey);
    const demand = demandById(demands, draft.demandId);
    if (!demand) {
      conflicts.push({
        code: 'unknown-demand',
        demandId: draft.demandId,
        workerId: draft.workerId,
        reason: `draft names unknown demand ${draft.demandId}`,
      });
      continue;
    }
    const worker = workers.get(draft.workerId);
    if (!worker) {
      conflicts.push({
        code: 'unknown-worker',
        demandId: draft.demandId,
        workerId: draft.workerId,
        reason: `draft names unknown worker ${draft.workerId}`,
      });
      continue;
    }
    const conflict = eligibilityConflict(snapshot, worker, demand, planned, weekStartMs, weekEndMs);
    if (conflict) {
      conflicts.push(conflict);
      continue;
    }
    planned.push({ workerId: worker.id, demand });
  }

  const finalAssignments: DraftAssignment[] = planned.map((plan) => ({
    demandId: plan.demand.id,
    workerId: plan.workerId,
    status: 'acceptance-pending' as const,
  }));
  const coverage = buildCoverage(demands, finalAssignments);
  for (const row of coverage) {
    if (row.assigned < row.required) {
      conflicts.push({
        code: 'under-covered',
        demandId: row.demandId,
        reason: `demand ${row.demandId} has ${row.assigned} of ${row.required} required assignments`,
      });
    }
    if (row.assigned > row.required) {
      conflicts.push({
        code: 'over-covered',
        demandId: row.demandId,
        reason: `demand ${row.demandId} has ${row.assigned} assignments above required ${row.required}`,
      });
    }
  }

  const sorted = sortConflicts(conflicts);
  return { valid: sorted.length === 0, coverage, conflicts: sorted };
}

function normalizeSearchOptions(options: SearchOptions | undefined): {
  nodesBudget: number;
  proposalsBudget: number;
} {
  const rawNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const rawProposals = options?.maxProposals ?? DEFAULT_MAX_PROPOSALS;
  const nodesBudget = Number.isFinite(rawNodes)
    ? Math.max(0, Math.min(Math.floor(rawNodes), MAX_NODES_CAP))
    : DEFAULT_MAX_NODES;
  const proposalsBudget = Number.isFinite(rawProposals)
    ? Math.max(1, Math.min(Math.floor(rawProposals), MAX_PROPOSALS_CAP))
    : DEFAULT_MAX_PROPOSALS;
  return { nodesBudget, proposalsBudget };
}

/**
 * Bounded deterministic proposal search over a validated snapshot.
 *
 * - `feasible`: every demand covered by valid acceptance-pending drafts.
 * - `infeasible`: the bounded search exhausted with no complete assignment.
 * - `search-incomplete`: the node budget ran out first; no false
 *   no-solution is reported.
 * - `invalid`: the snapshot itself failed runtime validation.
 *
 * Demands are visited in (start, end, id) order; candidate workers in id
 * order; required slots of one demand fill in worker-id combination order.
 * Nothing is mutated; repeated calls with the same input and budget return
 * the same result.
 */
export function searchProposals(
  snapshotInput: unknown,
  options?: SearchOptions,
): SearchProposalsResult {
  const parsed = parseWorkforceSnapshot(snapshotInput);
  const { nodesBudget, proposalsBudget } = normalizeSearchOptions(options);
  if (!parsed.ok) {
    return {
      status: 'invalid',
      assignments: [],
      coverage: [],
      conflicts: parsed.issues.map((issue) => ({
        code: 'invalid-snapshot' as const,
        reason: `invalid snapshot: ${issue}`,
      })),
      stats: { nodesVisited: 0, nodesBudget, proposalsConsidered: 0 },
      issues: parsed.issues,
    };
  }
  const snapshot = parsed.snapshot;
  const { demands, workers } = parseSnapshot(snapshot);
  const weekStartMs = instantToMs(snapshot.rules.workweekStart);
  const weekEndMs = instantToMs(snapshot.rules.workweekEnd);
  const workerIds = [...workers.keys()].sort();

  const slots: ParsedDemand[] = [];
  for (const demand of demands) {
    for (let i = 0; i < demand.requiredCount; i += 1) slots.push(demand);
  }

  let nodesVisited = 0;
  const found: DraftAssignment[][] = [];
  const planned: AssignmentPlan[] = [];
  const usedPairs = new Set<string>();

  // Static per-slot candidate order (role + availability + absence only) so
  // the DFS visits a deterministic, pre-sorted neighbourhood.
  const staticEligible = (demand: ParsedDemand): string[] =>
    workerIds.filter((workerId) => {
      const worker = workers.get(workerId);
      if (!worker) return false;
      if (!worker.roles.includes(demand.role)) return false;
      if (!shiftCoveredByAvailability(worker, demand.startMs, demand.endMs)) return false;
      if (shiftOnAbsence(worker, demand.startMs, demand.endMs)) return false;
      return true;
    });

  const slotCandidates: string[][] = slots.map((slot) => staticEligible(slot));

  // False means the budget ended before this subtree could be exhausted.
  const visitWithCompletion = (index: number): boolean => {
    if (found.length >= proposalsBudget) return true;
    if (index >= slots.length) {
      found.push(
        planned.map((plan) => ({
          demandId: plan.demand.id,
          workerId: plan.workerId,
          status: 'acceptance-pending' as const,
        })),
      );
      return true;
    }
    const slot = slots[index];
    for (const workerId of slotCandidates[index]) {
      if (found.length >= proposalsBudget) return true;
      const pairKey = JSON.stringify([slot.id, workerId]);
      if (usedPairs.has(pairKey)) continue;
      const previous = planned[index - 1];
      if (previous?.demand.id === slot.id && previous.workerId >= workerId) continue;
      const worker = workers.get(workerId);
      if (!worker) continue;
      if (nodesVisited >= nodesBudget) return false;
      nodesVisited += 1;
      const conflict = eligibilityConflict(snapshot, worker, slot, planned, weekStartMs, weekEndMs);
      if (conflict) continue;
      planned.push({ workerId, demand: slot });
      usedPairs.add(pairKey);
      const childComplete = visitWithCompletion(index + 1);
      planned.pop();
      usedPairs.delete(pairKey);
      if (found.length >= proposalsBudget) return true;
      if (!childComplete) return false;
    }
    // No candidate led anywhere and every candidate was examined.
    return true;
  };

  const completedWithoutBudgetHit = visitWithCompletion(0);

  if (found.length > 0) {
    const assignments = [...found[0]].sort((a, b) =>
      a.demandId < b.demandId ? -1
      : a.demandId > b.demandId ? 1
      : a.workerId < b.workerId ? -1
      : a.workerId > b.workerId ? 1
      : 0,
    );
    const verification = validateDrafts(snapshot, assignments);
    return {
      status: verification.valid ? 'feasible' : 'invalid',
      assignments,
      coverage: verification.coverage,
      conflicts: verification.conflicts,
      stats: { nodesVisited, nodesBudget, proposalsConsidered: found.length },
    };
  }

  if (!completedWithoutBudgetHit) {
    const partial = validateDrafts(snapshot, []);
    return {
      status: 'search-incomplete',
      assignments: [],
      coverage: partial.coverage,
      conflicts: [
        {
          code: 'under-covered',
          reason:
            `search budget of ${nodesBudget} nodes exhausted with no complete assignment; ` +
            `no-solution is not established`,
        },
      ],
      stats: { nodesVisited, nodesBudget, proposalsConsidered: 0 },
    };
  }

  // Infeasible: search exhausted. Explain per demand with static reasons.
  const conflicts: WorkforceConflict[] = [];
  for (const demand of demands) {
    const eligible = staticEligible(demand);
    if (eligible.length < demand.requiredCount) {
      conflicts.push({
        code: 'under-covered',
        demandId: demand.id,
        reason:
          `demand ${demand.id} needs ${demand.requiredCount} ${demand.role} ` +
          `but only ${eligible.length} eligible (${eligible.join(', ') || 'none'}) ` +
          `by role, availability, and absence`,
      });
      for (const workerId of workerIds) {
        const worker = workers.get(workerId);
        if (!worker || eligible.includes(workerId)) continue;
        const conflict = eligibilityConflict(snapshot, worker, demand, [], weekStartMs, weekEndMs);
        if (conflict) conflicts.push(conflict);
      }
    } else {
      conflicts.push({
        code: 'under-covered',
        demandId: demand.id,
        reason:
          `demand ${demand.id} has ${eligible.length} statically eligible workers ` +
          `but no complete assignment satisfies rest, travel, overlap, and workweek together`,
      });
    }
  }
  if (demands.length === 0) {
    conflicts.push({ code: 'under-covered', reason: 'snapshot carries no demand' });
  }
  const emptyCoverage = buildCoverage(demands, []);
  return {
    status: 'infeasible',
    assignments: [],
    coverage: emptyCoverage,
    conflicts: sortConflicts(conflicts),
    stats: { nodesVisited, nodesBudget, proposalsConsidered: 0 },
  };
}
