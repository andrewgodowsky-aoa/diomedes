/**
 * Data coverage: before a workflow is sold or switched on, which authorized
 * route can supply each field it needs, and what to offer when none can.
 *
 * A workflow declares the minimum fields it reads: how old each may be, where
 * its record of truth lives, which outputs it feeds and which access it needs.
 * Routes are declared too, each tied to its current evidence, its plan and
 * access requirements, its refresh cadence and its cost. `coverageMatrix`
 * evaluates, field by field, the routes that say they read that field, in the
 * order of `COVERAGE_ROUTE_KINDS`, and says in plain words why it passed over
 * or refused every route it did not choose.
 *
 * It is a field-level matrix, not a connector list. A route that reads the
 * same kind of data as a field does not cover the field unless it declares
 * the field itself: Toast's stock operation reports menu availability, not
 * ingredient inventory (`server/connections/toast.ts`), and a kind-level match
 * such as `skillConnectorMatch` cannot tell the two apart.
 *
 * It reuses the vocabulary it touches rather than paralleling it: a field's
 * kind is a `ConnectorDataKind`; its label, requirement and `howToProvide` are
 * a playbook input's; its acceptable age is a readiness `staleAfterMs`;
 * evidence carries readiness evidence's id, source and `staleAfterMs`; and
 * every freshness judgement is a readiness `FreshnessState`.
 *
 * Pure: no clock, filesystem or network, and the caller supplies `now`.
 * Unknown stays unknown: nothing here fills in a value, and no record is said
 * to exist or to be missing when no usable route can read it.
 *
 * Type imports only, so this module loads nothing at run time.
 */
import type { PackSkillInput } from './capability-packs.js';
import type { ConnectorDataKind } from './read-connectors.js';
import type {
  FreshnessState,
  ReadinessFreshness,
  ValidatedReadinessEvidence,
} from './readiness.js';

export const DATA_COVERAGE_CONTRACT_VERSION = 1 as const;

/**
 * The kinds of route a field may come through, in the order they are
 * evaluated. The business's own read routes come before a partner-only route,
 * and permitted browser-assisted work comes last. Within a kind, declaration
 * order decides.
 */
export const COVERAGE_ROUTE_KINDS = [
  'approved-integration',
  'customer-api',
  'database-view',
  'report-export',
  'email-files',
  'partner-api',
  'browser-assisted',
] as const;
export type CoverageRouteKind = (typeof COVERAGE_ROUTE_KINDS)[number];

/**
 * `verified`: usable, set up, and backed by current validated evidence.
 * `pending`: usable, but its evidence is documentation only, stale or absent.
 * `unavailable`: the business cannot use it, or no usable route exists.
 */
export type CoverageEvidenceState = 'verified' | 'pending' | 'unavailable';

/**
 * `complete`: every required field has a verified route. `pending`: every
 * required field is covered, some only by pending evidence. `incomplete`:
 * some required field has no usable route.
 */
export type CoverageStatus = 'complete' | 'pending' | 'incomplete';

/** One field a workflow reads, declared with the same words a playbook input uses. */
export interface CoverageField extends Pick<PackSkillInput, 'label' | 'required' | 'howToProvide'> {
  /** Unique inside its workflow. Routes name the fields they read by this id. */
  readonly id: string;
  /** The kind of data, in the words playbooks and read connectors already share. */
  readonly need: ConnectorDataKind;
  /** The field's acceptable age: the oldest it may be when the work uses it. */
  readonly staleAfterMs: number;
  /** The system whose record is authoritative for this field, in plain words. */
  readonly sourceOfTruth: string;
  /** The outputs this field feeds, in plain words. */
  readonly effects: readonly string[];
  /** The data scopes a route must be approved for to read this field. */
  readonly access: readonly string[];
}

/** A smaller version of the workflow that the workflow itself declares. */
export interface CoverageNarrowerVersion {
  readonly id: string;
  readonly title: string;
  /** What the owner still gets, in one plain line. */
  readonly value: string;
  /** The ids of the workflow's fields this version cannot run without. */
  readonly requires: readonly string[];
}

export interface CoverageWorkflow {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly CoverageField[];
  /** Declared widest first. The first one that is fully covered is offered. */
  readonly narrower: readonly CoverageNarrowerVersion[];
}

/**
 * What shows that a route works for this business. Only `validated` evidence,
 * a trusted check that read this business's data through the route, can
 * verify it. `documented` evidence (documentation, a manifest or a
 * declaration) keeps a route pending however recent it is.
 */
export interface CoverageEvidence
  extends Pick<ValidatedReadinessEvidence, 'evidenceId' | 'source' | 'staleAfterMs'> {
  readonly basis: 'validated' | 'documented';
  /** When the check was made or the documentation was read. */
  readonly observedAt: string;
}

export interface CoverageRouteAccess {
  /**
   * `granted`: set up and approved for this business. `available`: the
   * business could set it up itself. `unavailable`: the business cannot use it.
   */
  readonly status: 'granted' | 'available' | 'unavailable';
  /** Why, in plain words. */
  readonly detail: string;
}

export interface CoverageRoute {
  readonly id: string;
  readonly kind: CoverageRouteKind;
  /** The plain name a person reads. */
  readonly name: string;
  /** The ids of the workflow fields this route can read. Declared, never discovered. */
  readonly reads: readonly string[];
  /**
   * Every kind of data the route reads and every outside party it sends data
   * to, in plain words. For a primary route this is its approved scope.
   */
  readonly scopes: readonly string[];
  readonly access: CoverageRouteAccess;
  /** Plan and access requirements, one plain sentence each. */
  readonly requirements: readonly string[];
  /** How often new data arrives through the route: 0 means on request, null means not known. */
  readonly refreshEveryMs: number | null;
  /** What using the route costs, in plain words. An unknown price is said to be unknown. */
  readonly cost: string;
  readonly evidence: CoverageEvidence | null;
  /** Set on a fallback: the primary route whose approved scope it must stay within. */
  readonly fallbackFor?: string;
}

/** Why a candidate route was refused for a field. */
export type CoverageRefusal = 'access' | 'field-access' | 'fallback-scope' | 'freshness';

export interface CoverageCandidate {
  readonly route: string;
  readonly name: string;
  readonly kind: CoverageRouteKind;
  readonly verdict: 'chosen' | 'usable' | 'rejected';
  /** The route's own evidence state. */
  readonly evidence: CoverageEvidenceState;
  /** Whether the route's refresh cadence meets this field's acceptable age. */
  readonly freshness: FreshnessState;
  /** Every rule that refused it. Empty unless it was rejected. */
  readonly refusedBy: readonly CoverageRefusal[];
  /** Plain words for every candidate, and the reasons for every rejected one. */
  readonly reason: string;
}

export interface CoverageFieldRow {
  readonly field: string;
  readonly label: string;
  readonly required: boolean;
  readonly need: ConnectorDataKind;
  readonly staleAfterMs: number;
  readonly sourceOfTruth: string;
  readonly effects: readonly string[];
  readonly access: readonly string[];
  /** The chosen route's id, or null when no usable route reads this field. */
  readonly route: string | null;
  readonly evidence: CoverageEvidenceState;
  /** How old the chosen route's evidence is at `now`. Null when there is none. */
  readonly evidenceAgeMs: number | null;
  /** The chosen route's evidence judged at `now`, in readiness's freshness words. */
  readonly evidenceFreshness: ReadinessFreshness;
  /** The freshness verdict: whether the chosen route refreshes often enough. `unknown` with no route. */
  readonly freshness: FreshnessState;
  /** The chosen route's cost note. */
  readonly cost: string;
  readonly detail: string;
  /** The routes that declare they read this field, in evaluation order. */
  readonly candidates: readonly CoverageCandidate[];
}

export interface CoverageGap {
  readonly field: string;
  readonly label: string;
  /** What the owner can export, upload or connect instead, as the workflow declares it. */
  readonly howToProvide: string;
}

export interface CoverageRouteSummary {
  readonly route: string;
  readonly name: string;
  readonly kind: CoverageRouteKind;
  readonly access: CoverageRouteAccess;
  readonly requirements: readonly string[];
  readonly refreshEveryMs: number | null;
  readonly cost: string;
  readonly evidence: CoverageEvidenceState;
  readonly evidenceAgeMs: number | null;
  readonly evidenceFreshness: ReadinessFreshness;
  readonly evidenceDetail: string;
  readonly fallbackFor: string | null;
  /** The fields this route was chosen for. */
  readonly chosenFor: readonly string[];
}

export interface CoverageNarrowerOffer {
  readonly id: string;
  readonly title: string;
  readonly value: string;
  readonly requires: readonly string[];
  /** The workflow's fields this version leaves out. */
  readonly leavesOut: readonly string[];
  readonly reason: string;
}

export interface CoverageMatrix {
  readonly contractVersion: typeof DATA_COVERAGE_CONTRACT_VERSION;
  readonly workflow: string;
  readonly title: string;
  readonly generatedAt: string;
  readonly status: CoverageStatus;
  /** One row per declared field, in the workflow's order. */
  readonly fields: readonly CoverageFieldRow[];
  /** Required fields no usable route reads. Any entry makes the workflow incomplete. */
  readonly missing: readonly CoverageGap[];
  /** Optional fields no usable route reads. They never change the status. */
  readonly missingOptional: readonly CoverageGap[];
  /** Routes chosen for required fields whose evidence is still pending, in evaluation order. */
  readonly awaitingVerification: readonly string[];
  /** Every declared route, in evaluation order. */
  readonly routes: readonly CoverageRouteSummary[];
  /** A declared narrower version that is fully covered, offered when the workflow is not complete. */
  readonly narrower: CoverageNarrowerOffer | null;
  /** Plain words, when the workflow is not complete and no narrower version is fully covered. */
  readonly decline: string | null;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const noFreshness = (): ReadinessFreshness => ({ state: 'unknown', observedAt: null, staleAfterMs: null });

/** A duration in plain words: `15 minutes`, `1 day`, `7 days`. */
function duration(ms: number): string {
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (ms >= DAY && ms % DAY === 0) return count(ms / DAY, 'day');
  if (ms >= HOUR && ms % HOUR === 0) return count(ms / HOUR, 'hour');
  if (ms >= MINUTE && ms % MINUTE === 0) return count(ms / MINUTE, 'minute');
  return count(Math.round(ms / SECOND), 'second');
}

const list = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * One observation judged at `now`, with the same predicate readiness uses
 * (`isFreshAt` in `server/readiness/projection.ts`): fresh when both times
 * are valid, the limit is positive, the observation is not in the future and
 * its age is within the limit.
 */
function freshnessAt(now: string, observedAt: string, staleAfterMs: number): ReadinessFreshness {
  const age = Date.parse(now) - Date.parse(observedAt);
  const valid = Number.isFinite(age) && Number.isFinite(staleAfterMs) && staleAfterMs > 0 && age >= 0;
  return { state: !valid ? 'unknown' : age <= staleAfterMs ? 'fresh' : 'stale', observedAt, staleAfterMs };
}

function ageAt(now: string, observedAt: string): number | null {
  const age = Date.parse(now) - Date.parse(observedAt);
  return Number.isFinite(age) && age >= 0 ? age : null;
}

interface RouteAssessment {
  readonly evidence: CoverageEvidenceState;
  readonly ageMs: number | null;
  readonly freshness: ReadinessFreshness;
  readonly detail: string;
}

/** A route's evidence state, derived rather than declared: verified needs access, validation and currency. */
function assess(route: CoverageRoute, now: string): RouteAssessment {
  const proof = route.evidence;
  const freshness = proof ? freshnessAt(now, proof.observedAt, proof.staleAfterMs) : noFreshness();
  const ageMs = proof ? ageAt(now, proof.observedAt) : null;
  const state = (evidence: CoverageEvidenceState, detail: string): RouteAssessment => ({
    evidence,
    ageMs,
    freshness,
    detail,
  });
  if (route.access.status === 'unavailable')
    return state('unavailable', `Not available to this business. ${route.access.detail}`);
  if (!proof) return state('pending', 'No evidence yet.');
  if (proof.basis === 'documented') return state('pending', `Documented, not verified: ${proof.source}.`);
  if (route.access.status !== 'granted')
    return state('pending', `Not set up for this business yet, so its evidence cannot verify it: ${proof.source}.`);
  if (freshness.state === 'stale') return state('pending', `Validated evidence is stale: ${proof.source}.`);
  if (freshness.state !== 'fresh')
    return state('pending', `Validated evidence has no usable time: ${proof.source}.`);
  return state('verified', `Verified: ${proof.source}.`);
}

/** Rule 2: a route whose refresh cadence exceeds the field's acceptable age cannot serve it. */
function cadence(field: CoverageField, route: CoverageRoute): { state: FreshnessState; problem: string | null } {
  const limit = field.staleAfterMs;
  const every = route.refreshEveryMs;
  if (!(Number.isFinite(limit) && limit >= 0))
    return { state: 'unknown', problem: 'This field has no usable acceptable age, so no route can be shown to meet it.' };
  if (every === null || !(Number.isFinite(every) && every >= 0))
    return {
      state: 'unknown',
      problem: `How often it refreshes is not recorded, so it cannot be shown to meet this field's limit of ${duration(limit)}.`,
    };
  if (every > limit)
    return {
      state: 'stale',
      problem: `It refreshes every ${duration(every)}, but this field may be at most ${duration(limit)} old.`,
    };
  return { state: 'fresh', problem: null };
}

interface CandidateCheck {
  readonly route: CoverageRoute;
  readonly assessment: RouteAssessment;
  readonly freshness: FreshnessState;
  readonly refusedBy: readonly CoverageRefusal[];
  readonly problems: readonly string[];
}

function judgeCandidate(
  field: CoverageField,
  route: CoverageRoute,
  assessment: RouteAssessment,
  byId: ReadonlyMap<string, CoverageRoute>,
): CandidateCheck {
  const refusedBy: CoverageRefusal[] = [];
  const problems: string[] = [];
  // Rule 1: a route the business cannot use is unavailable, with its reason.
  if (assessment.evidence === 'unavailable') {
    refusedBy.push('access');
    problems.push(assessment.detail);
  }
  const lacking = field.access.filter((scope) => !route.scopes.includes(scope));
  if (lacking.length > 0) {
    refusedBy.push('field-access');
    problems.push(`It is not approved for ${list(lacking)}, which this field needs.`);
  }
  // Rule 4: a fallback never widens processing or permissions beyond its primary's approved scope.
  if (route.fallbackFor !== undefined) {
    const primary = byId.get(route.fallbackFor);
    if (!primary) {
      refusedBy.push('fallback-scope');
      problems.push(
        `It is declared as a fallback for ${route.fallbackFor}, which is not declared, so nothing bounds what it may reach.`,
      );
    } else {
      const wider = route.scopes.filter((scope) => !primary.scopes.includes(scope));
      if (wider.length > 0) {
        refusedBy.push('fallback-scope');
        problems.push(
          `As a fallback for ${primary.name}, it would add ${list(wider)}, beyond that route's approved scope. A fallback never widens what is read or where data goes.`,
        );
      }
    }
  }
  const fresh = cadence(field, route);
  if (fresh.problem !== null) {
    refusedBy.push('freshness');
    problems.push(fresh.problem);
  }
  return { route, assessment, freshness: fresh.state, refusedBy, problems };
}

function evaluationOrder(routes: readonly CoverageRoute[]): CoverageRoute[] {
  const rank = (kind: CoverageRouteKind) => {
    const index = COVERAGE_ROUTE_KINDS.indexOf(kind);
    return index < 0 ? COVERAGE_ROUTE_KINDS.length : index;
  };
  return routes
    .map((route, index) => ({ route, index }))
    .sort((a, b) => rank(a.route.kind) - rank(b.route.kind) || a.index - b.index)
    .map((entry) => entry.route);
}

function assertUnique(ids: readonly string[], what: string) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate ${what} id: ${id}.`);
    seen.add(id);
  }
}

/**
 * The action-level coverage matrix for one workflow over the declared routes,
 * judged at `now`. Deterministic, and it never changes its inputs.
 */
export function coverageMatrix(
  workflow: CoverageWorkflow,
  routes: readonly CoverageRoute[],
  options: { readonly now: string },
): CoverageMatrix {
  const { now } = options;
  assertUnique(
    workflow.fields.map((field) => field.id),
    'field',
  );
  assertUnique(
    routes.map((route) => route.id),
    'route',
  );
  const ordered = evaluationOrder(routes);
  const byId = new Map(ordered.map((route) => [route.id, route]));
  const assessments = new Map(ordered.map((route) => [route.id, assess(route, now)]));
  const chosenFor = new Map<string, string[]>(ordered.map((route) => [route.id, []]));

  const fields = workflow.fields.map((field): CoverageFieldRow => {
    const checked = ordered
      .filter((route) => route.reads.includes(field.id))
      .map((route) => judgeCandidate(field, route, assessments.get(route.id)!, byId));
    const usable = checked.filter((entry) => entry.refusedBy.length === 0);
    // A verified route is chosen over a pending one; among equals, the earlier in the order.
    const chosen = usable.find((entry) => entry.assessment.evidence === 'verified') ?? usable[0] ?? null;
    if (chosen) chosenFor.get(chosen.route.id)!.push(field.id);

    const candidates = checked.map((entry): CoverageCandidate => {
      const verdict = entry === chosen ? 'chosen' : entry.refusedBy.length === 0 ? 'usable' : 'rejected';
      const reason =
        verdict === 'chosen'
          ? `Chosen. ${entry.assessment.detail}`
          : verdict === 'usable'
            ? `Usable, but ${chosen!.route.name} ${
                chosen!.assessment.evidence === 'verified' && entry.assessment.evidence !== 'verified'
                  ? 'is verified'
                  : 'comes first in the order'
              }.`
            : entry.problems.join(' ');
      return {
        route: entry.route.id,
        name: entry.route.name,
        kind: entry.route.kind,
        verdict,
        evidence: entry.assessment.evidence,
        freshness: entry.freshness,
        refusedBy: [...entry.refusedBy],
        reason,
      };
    });

    const shared = {
      field: field.id,
      label: field.label,
      required: field.required,
      need: field.need,
      staleAfterMs: field.staleAfterMs,
      sourceOfTruth: field.sourceOfTruth,
      effects: [...field.effects],
      access: [...field.access],
      candidates,
    };
    // Rule 6: with no usable route nothing is borrowed from refused routes, and nothing is filled in.
    if (!chosen)
      return {
        ...shared,
        route: null,
        evidence: 'unavailable',
        evidenceAgeMs: null,
        evidenceFreshness: noFreshness(),
        freshness: 'unknown',
        cost: 'None: no route is chosen.',
        detail:
          'Unknown. No usable route reads this field, so nothing is filled in and no record is assumed to exist or to be missing.',
      };
    return {
      ...shared,
      route: chosen.route.id,
      evidence: chosen.assessment.evidence,
      evidenceAgeMs: chosen.assessment.ageMs,
      evidenceFreshness: { ...chosen.assessment.freshness },
      freshness: chosen.freshness,
      cost: chosen.route.cost,
      detail:
        chosen.assessment.evidence === 'verified'
          ? `Verified through ${chosen.route.name}.`
          : `Covered through ${chosen.route.name}, pending verification.`,
    };
  });

  const gap = (row: CoverageFieldRow): CoverageGap => ({
    field: row.field,
    label: row.label,
    howToProvide: workflow.fields.find((field) => field.id === row.field)!.howToProvide,
  });
  const uncovered = fields.filter((row) => row.route === null);
  const missing = uncovered.filter((row) => row.required).map(gap);
  const missingOptional = uncovered.filter((row) => !row.required).map(gap);
  const required = fields.filter((row) => row.required);
  // Rule 3: only a required field decides the status.
  const status: CoverageStatus =
    missing.length > 0
      ? 'incomplete'
      : required.some((row) => row.evidence !== 'verified')
        ? 'pending'
        : 'complete';
  const pendingRoutes = new Set(
    required.filter((row) => row.route !== null && row.evidence === 'pending').map((row) => row.route!),
  );
  const awaitingVerification = ordered.filter((route) => pendingRoutes.has(route.id)).map((route) => route.id);

  const rowById = new Map(fields.map((row) => [row.field, row]));
  const labelOf = (id: string) => rowById.get(id)?.label ?? id;
  const fullyCovered = (version: CoverageNarrowerVersion) =>
    version.requires.length > 0 && version.requires.every((id) => rowById.get(id)?.evidence === 'verified');
  const offered = status === 'complete' ? undefined : workflow.narrower.find(fullyCovered);

  let narrower: CoverageNarrowerOffer | null = null;
  let decline: string | null = null;
  if (offered) {
    const leavesOut = workflow.fields.map((field) => field.id).filter((id) => !offered.requires.includes(id));
    narrower = {
      id: offered.id,
      title: offered.title,
      value: offered.value,
      requires: [...offered.requires],
      leavesOut,
      reason:
        `Offered instead of ${workflow.title}: every field it needs has a verified route.` +
        (leavesOut.length > 0 ? ` It leaves out ${list(leavesOut.map(labelOf))}.` : ''),
    };
  } else if (status !== 'complete') {
    const parts: string[] = [];
    if (missing.length > 0)
      parts.push(
        `no usable route reads ${list(missing.map((entry) => entry.label))}, and nothing is filled in for ${
          missing.length === 1 ? 'it' : 'them'
        }`,
      );
    if (awaitingVerification.length > 0)
      parts.push(
        `it depends on ${list(awaitingVerification.map((id) => byId.get(id)!.name))}, which ${
          awaitingVerification.length === 1 ? 'is' : 'are'
        } not verified`,
      );
    decline =
      `Not offered as automated${status === 'pending' ? ' yet' : ''}: ${parts.join('; ')}.` +
      (workflow.narrower.length > 0 ? ' No narrower version is fully covered either.' : '');
  }

  return {
    contractVersion: DATA_COVERAGE_CONTRACT_VERSION,
    workflow: workflow.id,
    title: workflow.title,
    generatedAt: now,
    status,
    fields,
    missing,
    missingOptional,
    awaitingVerification,
    routes: ordered.map((route): CoverageRouteSummary => {
      const assessment = assessments.get(route.id)!;
      return {
        route: route.id,
        name: route.name,
        kind: route.kind,
        access: { status: route.access.status, detail: route.access.detail },
        requirements: [...route.requirements],
        refreshEveryMs: route.refreshEveryMs,
        cost: route.cost,
        evidence: assessment.evidence,
        evidenceAgeMs: assessment.ageMs,
        evidenceFreshness: { ...assessment.freshness },
        evidenceDetail: assessment.detail,
        fallbackFor: route.fallbackFor ?? null,
        chosenFor: [...chosenFor.get(route.id)!],
      };
    }),
    narrower,
    decline,
  };
}
