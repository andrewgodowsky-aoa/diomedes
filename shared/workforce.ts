/**
 * DEMO-03.PREP — deterministic workforce-constraints preparation library.
 *
 * A reusable PURE preparatory subset: typed, runtime-validated scheduling
 * inputs (snapshot), draft assignments, and coverage/conflict output. It is
 * not a scheduler, authority store, or app. Full DEMO-03 stays OPEN and Core
 * integration is deferred until H/FD prerequisites are accepted.
 *
 * Standing decisions honoured: Console-only (no UI here), truthful
 * attribution (a client-supplied record is data, never authority), durable
 * evidence (unknown critical data yields invalid/unknown, never a confident
 * feasible). Rules are owner-provided configuration, not legal advice.
 */
import { z } from 'zod';

export const WORKFORCE_CONTRACT_VERSION = 1 as const;

export const MAX_WORKERS = 200;
export const MAX_DEMANDS = 200;
export const MAX_INTERVALS_PER_WORKER = 100;
export const MAX_ROLES_PER_WORKER = 16;
export const MAX_REQUIRED_PER_DEMAND = 16;
// Allows an explicitly expanded workweek spanning a daylight-saving transition.
export const MAX_INTERVAL_MINUTES = 11_520;
/** Resource bound, not a staffing policy; permits every supported window duration. */
export const MAX_WEEK_MINUTES = MAX_INTERVAL_MINUTES;
export const MAX_REST_MINUTES = 1440;
export const MAX_TRAVEL_MINUTES = 1440;

const id = z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/);
const roleName = z.string().trim().min(1).max(80);
const locationName = z.string().trim().min(1).max(120);
const provenance = z.string().trim().min(1).max(200);
const weekMinutes = z.number().int().finite().min(0).max(MAX_WEEK_MINUTES);

/** Explicit instant: requires a UTC designator or numeric offset. Overnight
 *  is natural because instants compare as epoch milliseconds. Date-only
 *  strings and offset-less datetimes are rejected (unknown, never assumed). */
export const instantSchema = z.iso.datetime({ offset: true }).max(64)
  .refine((s) => Date.parse(s) % 60_000 === 0, 'instant must use whole-minute precision');
export type WorkforceInstant = z.infer<typeof instantSchema>;

/** True when the value is an explicitly-offset, parseable instant. */
export function isExplicitInstant(value: unknown): value is string {
  return instantSchema.safeParse(value).success;
}

/** Epoch milliseconds for a validated instant string. NaN when invalid. */
export function instantToMs(instant: string): number {
  return Date.parse(instant);
}

const intervalBase = z.strictObject({
  start: instantSchema,
  end: instantSchema,
});

function refineIntervalOrder(
  value: { start: string; end: string },
  ctx: z.RefinementCtx,
): void {
  const startMs = Date.parse(value.start);
  const endMs = Date.parse(value.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
  if (endMs <= startMs) {
    ctx.addIssue({
      code: 'custom',
      message: 'interval end must be after start',
    });
    return;
  }
  const minutes = (endMs - startMs) / 60_000;
  if (minutes > MAX_INTERVAL_MINUTES) {
    ctx.addIssue({
      code: 'custom',
      message: `interval exceeds ${MAX_INTERVAL_MINUTES} minutes`,
    });
  }
}

/** A closed-open [start, end) window over explicit instants. */
export const intervalSchema = intervalBase.superRefine(refineIntervalOrder);
export type WorkforceInterval = z.infer<typeof intervalSchema>;

/**
 * Availability entered as explicitly expanded intervals. Reviewed recurring
 * availability arrives here already expanded by the caller, with provenance
 * naming the review/export it came from. This library never invents timezone
 * recurrence semantics.
 */
export const availabilityIntervalSchema = intervalBase
  .extend({ source: provenance })
  .superRefine(refineIntervalOrder);
export type AvailabilityInterval = z.infer<typeof availabilityIntervalSchema>;

/** Approved absence. Partial-day is natural: any overlap with a shift blocks
 *  it. No leave-reason field exists by design (no sensitive data). */
export const absenceIntervalSchema = intervalSchema;
export type AbsenceInterval = z.infer<typeof absenceIntervalSchema>;

export const workerSchema = z.strictObject({
  id,
  roles: z.array(roleName).min(1).max(MAX_ROLES_PER_WORKER),
  availability: z.array(availabilityIntervalSchema).max(MAX_INTERVALS_PER_WORKER),
  absences: z.array(absenceIntervalSchema).max(MAX_INTERVALS_PER_WORKER),
  /** Minutes already worked in the configured workweek before this snapshot. */
  priorWeekMinutes: weekMinutes,
  /** Explicit null means the source confirms no preceding shift, not unknown. */
  precedingShift: z.strictObject({ end: instantSchema, location: locationName }).nullable(),
});
export type WorkforceWorker = z.infer<typeof workerSchema>;

/** One unit of demand: a shift needing `requiredCount` qualified workers. */
export const demandSchema = z
  .strictObject({
    id,
    role: roleName,
    start: instantSchema,
    end: instantSchema,
    location: locationName,
    requiredCount: z.number().int().finite().min(1).max(MAX_REQUIRED_PER_DEMAND),
  })
  .superRefine((value, ctx) => {
    refineIntervalOrder({ start: value.start, end: value.end }, ctx);
  });
export type WorkforceDemand = z.infer<typeof demandSchema>;

/**
 * Owner-provided configuration. Not legal advice and not staffing policy:
 * numbers the search and validator enforce, nothing more.
 */
export const workforceRulesSchema = z
  .strictObject({
    workweekStart: instantSchema,
    workweekEnd: instantSchema,
    maxWeekMinutes: z.number().int().finite().min(1).max(MAX_WEEK_MINUTES),
    minRestMinutes: z.number().int().finite().min(0).max(MAX_REST_MINUTES),
    travelGapMinutes: z.number().int().finite().min(0).max(MAX_TRAVEL_MINUTES),
  })
  .superRefine((value, ctx) => {
    refineIntervalOrder({ start: value.workweekStart, end: value.workweekEnd }, ctx);
  });
export type WorkforceRules = z.infer<typeof workforceRulesSchema>;

export const workforceSnapshotSchema = z
  .strictObject({
    contractVersion: z.literal(WORKFORCE_CONTRACT_VERSION),
    /** Identity references only: the record is data, never authority. */
    projectId: id,
    prospectId: id,
    source: provenance,
    configurationId: id,
    workers: z.array(workerSchema).max(MAX_WORKERS),
    demands: z.array(demandSchema).min(1).max(MAX_DEMANDS),
    rules: workforceRulesSchema,
  })
  .superRefine((value, ctx) => {
    if (value.demands.reduce((sum, demand) => sum + demand.requiredCount, 0) > 512) {
      ctx.addIssue({ code: 'custom', message: 'snapshot exceeds 512 assignment slots' });
    }
    const workerIds = new Set<string>();
    for (const worker of value.workers) {
      if (worker.precedingShift && Date.parse(worker.precedingShift.end) > Date.parse(value.rules.workweekStart)) {
        ctx.addIssue({ code: 'custom', message: `preceding shift for ${worker.id} must end before the window starts` });
      }
      if (workerIds.has(worker.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate worker id: ${worker.id}` });
      }
      workerIds.add(worker.id);
    }
    const demandIds = new Set<string>();
    for (const demand of value.demands) {
      if (Date.parse(demand.start) < Date.parse(value.rules.workweekStart) || Date.parse(demand.end) > Date.parse(value.rules.workweekEnd)) {
        ctx.addIssue({ code: 'custom', message: `demand ${demand.id} is outside the configured workweek` });
      }
      if (demandIds.has(demand.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate demand id: ${demand.id}` });
      }
      demandIds.add(demand.id);
    }
  });
export type WorkforceSnapshot = z.infer<typeof workforceSnapshotSchema>;

/**
 * A proposed assignment. Availability is NOT acceptance: drafts are always
 * `acceptance-pending`. There is no accepted/published state in this library.
 */
export const draftAssignmentSchema = z.strictObject({
  demandId: id,
  workerId: id,
  status: z.literal('acceptance-pending'),
});
export type DraftAssignment = z.infer<typeof draftAssignmentSchema>;

export type ParseWorkforceSnapshotResult =
  | { readonly ok: true; readonly snapshot: WorkforceSnapshot }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Runtime-validate an untrusted client-supplied record. Unknown or critical
 * bad data yields `{ ok: false }` — never a confident feasible.
 */
export function parseWorkforceSnapshot(input: unknown): ParseWorkforceSnapshotResult {
  const parsed = workforceSnapshotSchema.safeParse(input);
  if (parsed.success) return { ok: true, snapshot: parsed.data };
  const issues = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });
  return { ok: false, issues };
}

/** Half-open overlap test over epoch milliseconds. */
export function intervalsOverlapMs(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Whole minutes of overlap between two half-open millisecond ranges. */
export function overlapMinutesMs(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  if (overlap <= 0) return 0;
  return Math.floor(overlap / 60_000);
}
