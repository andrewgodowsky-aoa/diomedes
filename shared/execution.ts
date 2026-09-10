/**
 * One unit of admitted work, resolved once and rechecked at the boundary.
 *
 * Desktop, Core, Runtime, Trust, Observatory and Interop are responsibilities,
 * not six services, and this file is what keeps them one execution system:
 * every admitted unit resolves from the authenticated principal, the current
 * membership, the active configuration, the Agent and Team revisions, the
 * available route, policy, the allowed context and the budget — and carries
 * that as a single record for the rest of its life.
 *
 * Two ideas do most of the work.
 *
 * **Three gates, not one verdict.** Entitlement says a business bought a
 * feature. Trust says this person may take this action on this data. Budget
 * says someone will pay for it. They answer different questions and none of
 * them implies another, so they are separate results and `admit` requires every
 * required one. Collapsing them into a single boolean is how a Business badge
 * ends up authorizing a write, and how an approved write ends up spending the
 * company's inference allowance.
 *
 * **History is kept; authority is re-asked.** A resolution is a snapshot of
 * what was true when work was admitted, and it is never rewritten — attribution
 * has to stay truthful even after somebody switches workspace or model.
 * `recheckAtEffect` therefore returns a *new* answer built from live values and
 * leaves the snapshot alone. An old snapshot must never revive a revoked grant,
 * which is only guaranteed if the snapshot is never the thing consulted.
 *
 * Nothing here resolves anything by itself. `server/execution.ts` reads the
 * live registries — `server/workspaces.ts`, `server/agents.ts`, `server/rules.ts`,
 * `server/trust/`, `server/usage.ts` — and fills this in. This module is the
 * vocabulary and the arithmetic, so the screen and the host cannot disagree
 * about what was decided.
 */
import type { AgentResolution } from './agents.js';
import type { ProcessingPolicy } from './configuration.js';
import type { GoverningRecord } from './rule-authority.js';
import type { PermissionChoiceId } from './permissions.js';
import type { MembershipState, MemberRole, WorkspaceRef } from './workspaces.js';

export const EXECUTION_CONTRACT_VERSION = 1 as const;

// --- the three gates ----------------------------------------------------------

export type GateId = 'entitlement' | 'trust' | 'budget';
export const GATES: readonly GateId[] = Object.freeze(['entitlement', 'trust', 'budget']);

export type GateVerdict = 'passed' | 'refused' | 'not-required';

export interface GateResult {
  readonly gate: GateId;
  readonly verdict: GateVerdict;
  /** False only when this gate genuinely has nothing to decide here. */
  readonly required: boolean;
  /** What happened, and what the person can do about it. */
  readonly reason: string;
  /** What this gate answered. Deliberately not what another gate answered. */
  readonly answered: string;
}

export interface Admission {
  readonly admitted: boolean;
  readonly refusedBy: readonly GateId[];
  /** The refusals, joined. A person should not have to fix one and try again three times. */
  readonly reason: string | null;
}

/**
 * Admit only when every gate that has something to decide said yes.
 *
 * A gate that was never asked counts as a refusal. The alternative — treating
 * an absent gate as satisfied — means a caller that forgets to run the budget
 * check gets free inference, and the bug is invisible.
 */
export function admit(results: readonly GateResult[]): Admission {
  const byId = new Map(results.map((result) => [result.gate, result]));
  const refusedBy: GateId[] = [];
  const reasons: string[] = [];
  for (const gate of GATES) {
    const result = byId.get(gate);
    if (!result) {
      refusedBy.push(gate);
      reasons.push(`Nothing checked ${gate} for this work.`);
      continue;
    }
    if (result.verdict === 'passed' || (result.verdict === 'not-required' && !result.required))
      continue;
    refusedBy.push(gate);
    reasons.push(result.reason);
  }
  return {
    admitted: refusedBy.length === 0,
    refusedBy: Object.freeze(refusedBy),
    reason: reasons.length > 0 ? reasons.join(' ') : null,
  };
}

// --- who pays -----------------------------------------------------------------

export type PayerKind = 'organization' | 'person' | 'local-machine' | 'bring-your-own';

export interface Payer {
  readonly kind: PayerKind;
  readonly id: string | null;
  /**
   * Whether this payer also funds children, advisors, reviews, summarization
   * and correction attempts. It is always true: delegation cannot mint credit,
   * so somebody's parent budget is always the one being spent. The field exists
   * so evidence can say whose.
   */
  readonly coversChildren: true;
  readonly reason: string;
}

/** Routes that never leave this computer, and therefore never bill anybody. */
const LOCAL_ROUTES: readonly string[] = Object.freeze(['sample', 'harness-runtime']);

/**
 * Who is paying for this work.
 *
 * The distinction that matters is between an allowance a business bought and an
 * account the person happens to have signed into on this machine. Both produce
 * model output; only one of them can be spent on the company's behalf. When
 * there is no managed inference — and in this build there never is — the
 * account is the person's own, whatever workspace they are standing in.
 */
export function payerFor(input: {
  readonly routeId: string;
  readonly workspace: WorkspaceRef;
  /** Whether an entitlement service is funding inference for this organization. */
  readonly managedInference: boolean;
}): Payer {
  if (LOCAL_ROUTES.includes(input.routeId))
    return {
      kind: 'local-machine',
      id: null,
      coversChildren: true,
      reason: 'This work runs on your machine and is not billed to anyone.',
    };
  if (input.workspace.kind === 'business' && input.managedInference)
    return {
      kind: 'organization',
      id: input.workspace.organizationId,
      coversChildren: true,
      reason: 'The business pays for this work from its included usage.',
    };
  if (input.workspace.kind === 'business')
    return {
      kind: 'bring-your-own',
      id: input.workspace.organizationId,
      coversChildren: true,
      reason:
        'This runs through the account signed in on this computer, not through business usage. What it costs appears on that account.',
    };
  return {
    kind: 'person',
    id: null,
    coversChildren: true,
    reason: 'This runs through your own account on this computer.',
  };
}

// --- fallback -----------------------------------------------------------------

export interface FallbackChoice {
  readonly routeId: string | null;
  readonly reason: string;
}

/**
 * Pick a route to fall back to, or refuse to.
 *
 * The rule this exists for is the last one: a job the business said must stay
 * on this computer does not become cloud-backed because a local model stopped
 * answering. An outage is an availability problem; quietly re-routing the work
 * turns it into a data-processing one, and nobody is told.
 */
export function chooseFallback(input: {
  readonly from: string;
  readonly candidates: readonly string[];
  readonly processing: ProcessingPolicy;
  readonly remoteRoutes: ReadonlySet<string>;
  readonly budgetRemainingUsd: number | null;
  readonly fallbackAllowed: boolean;
  /** Whether a route can actually do this Agent's work. */
  readonly capable: (routeId: string) => boolean;
}): FallbackChoice {
  if (!input.fallbackAllowed)
    return {
      routeId: null,
      reason:
        'This setup does not allow a different model to pick the work up. Nothing was changed.',
    };
  for (const candidate of input.candidates) {
    if (candidate === input.from) continue;
    if (input.processing === 'local-only' && input.remoteRoutes.has(candidate)) continue;
    if (!input.capable(candidate)) continue;
    if (input.budgetRemainingUsd !== null && input.budgetRemainingUsd <= 0) continue;
    return { routeId: candidate, reason: `Continued on ${candidate}.` };
  }
  if (input.processing === 'local-only')
    return {
      routeId: null,
      reason:
        'This work has to stay on this computer, and no local model is available. It was stopped rather than sent to a cloud service.',
    };
  if (input.budgetRemainingUsd !== null && input.budgetRemainingUsd <= 0)
    return {
      routeId: null,
      reason: 'There is no allowance left, so no other model was started.',
    };
  return {
    routeId: null,
    reason: 'No other available model can do this work. Nothing was changed.',
  };
}

// --- the resolution -----------------------------------------------------------

/** The part of an Agent resolution this record pins. The full snapshot lives on the session. */
export interface ResolvedAgent {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly agentDigest: string;
  readonly agentName: string;
  readonly agentSelection: AgentResolution['agentSelection'];
  readonly effectivePermission: PermissionChoiceId;
}

export interface ResolvedTeam {
  readonly teamId: string;
  readonly revision: string;
  readonly handoffId: string | null;
}

export interface ExecutionResolution {
  readonly v: 1;
  readonly resolvedAt: string;
  readonly principal: {
    readonly kind: string;
    readonly id: string;
    readonly tenantId: string | null;
    readonly assurance: string;
  };
  readonly workspace: WorkspaceRef;
  readonly membership: { readonly role: MemberRole; readonly state: MembershipState } | null;
  readonly configuration: {
    readonly organizationId: string;
    readonly revision: number;
    readonly digest: string;
  } | null;
  readonly agent: ResolvedAgent;
  readonly team: ResolvedTeam | null;
  readonly route: {
    readonly routeId: string;
    readonly requestedModel: string | null;
    readonly modelSelection: AgentResolution['modelSelection'];
  };
  readonly rules: { readonly revision: string; readonly governing: readonly GoverningRecord[] };
  readonly context: {
    readonly scopeIds: readonly string[];
    readonly instructionRevision: string;
  };
  readonly payer: Payer;
  readonly budget: {
    readonly reservationId: string;
    readonly reservedUsd: number;
    readonly capUsd: number | null;
  } | null;
  readonly gates: readonly GateResult[];
  readonly admitted: boolean;
}

// --- rechecking at the effect boundary ---------------------------------------

/** What is true right now. Read fresh at the boundary; never taken from the snapshot. */
export interface LiveAuthority {
  readonly tenantId: string | null;
  readonly membershipState: MembershipState | null;
  readonly configurationRevision: number | null;
  readonly agentDigest: string | null;
  readonly grantRevoked: boolean;
  /** True when Trust says a generation moved under this principal. */
  readonly generationAdvanced: boolean;
  readonly budgetRemainingUsd: number | null;
  /** Whether this route proves that revoking actually stops future effects. */
  readonly revocationProven: boolean;
}

export interface AuthorityChange {
  readonly what: string;
  readonly was: string;
  readonly now: string;
  /** `stops` refuses the effect. `noted` is recorded and does not. */
  readonly effect: 'stops' | 'noted';
}

export interface RecheckResult {
  readonly ok: boolean;
  readonly changed: readonly AuthorityChange[];
  readonly reason: string | null;
  readonly checkedAt: string;
}

/**
 * Ask again, at the moment the effect would happen.
 *
 * Every branch below is a way the world can move between "this was admitted"
 * and "this is about to write". The snapshot is read-only here on purpose: the
 * function that decides whether a revoked grant still works must not be able to
 * take the answer from the record the grant was written into.
 */
export function recheckAtEffect(
  resolution: ExecutionResolution,
  live: LiveAuthority,
  at: string = new Date().toISOString(),
): RecheckResult {
  const changed: AuthorityChange[] = [];
  const stop = (what: string, was: string, now: string) =>
    changed.push({ what, was, now, effect: 'stops' });

  if (live.generationAdvanced)
    stop('generation', 'the access you had when this started', 'access has been reissued since');
  if (resolution.principal.tenantId !== live.tenantId)
    stop('tenant', String(resolution.principal.tenantId), String(live.tenantId));
  if (resolution.membership && live.membershipState !== 'active')
    stop('membership', resolution.membership.state, live.membershipState ?? 'no longer a member');
  if (live.grantRevoked) stop('grant', 'granted', 'withdrawn');
  if (
    resolution.configuration &&
    live.configurationRevision !== null &&
    live.configurationRevision !== resolution.configuration.revision
  )
    stop(
      'configuration',
      `setup ${resolution.configuration.revision}`,
      `setup ${live.configurationRevision}`,
    );
  if (live.agentDigest !== null && live.agentDigest !== resolution.agent.agentDigest)
    stop('agent', resolution.agent.agentName, 'the definition has been edited');
  if (live.budgetRemainingUsd !== null && live.budgetRemainingUsd <= 0)
    stop('allowance', 'available', 'used up');
  if (!live.revocationProven)
    changed.push({
      what: 'revocation-proof',
      was: 'unknown',
      now: 'this route has not been shown to stop work already sent to it',
      effect: 'noted',
    });

  const stopping = changed.filter((item) => item.effect === 'stops');
  return {
    ok: stopping.length === 0,
    changed: Object.freeze(changed),
    reason:
      stopping.length === 0
        ? null
        : `${sentenceFor(stopping)} Nothing was changed. Start the work again to continue under what is true now.`,
    checkedAt: at,
  };
}

const PHRASES: Readonly<Record<string, string>> = Object.freeze({
  generation: 'Your access was reissued while this was running.',
  tenant: 'This work belongs to a different business than the one you are in now.',
  membership: 'Your membership of this business is no longer active.',
  grant: 'The permission this was working under has been withdrawn.',
  configuration: 'The business setup changed while this was running.',
  agent: 'The worker used for this job was edited while it was running.',
  allowance: 'The allowance for this business ran out while this was running.',
});

function sentenceFor(changes: readonly AuthorityChange[]): string {
  return changes
    .map((change) => PHRASES[change.what] ?? `${change.what} changed while this was running.`)
    .join(' ');
}

// --- evidence -----------------------------------------------------------------

/** Known or not. There is no third state and no placeholder that reads like a value. */
export type Known<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly why: string };

const known = <T>(value: T): Known<T> => ({ known: true, value });
const unknown = <T>(why: string): Known<T> => ({ known: false, why });
const maybe = <T>(value: T | null, why: string): Known<T> =>
  value === null || value === undefined ? unknown<T>(why) : known(value);

export interface EvidenceObserved {
  /** What the runtime reported it actually ran. Never a request field. */
  readonly runtimeModel: string | null;
  readonly runtimeEngine: string | null;
  readonly proposer: string | null;
  readonly reviewer: string | null;
  readonly writer: string | null;
  readonly verifier: string | null;
  readonly effect: string | null;
  readonly verification: string | null;
}

/**
 * The machine identifiers, kept beside the readable answers rather than parsed
 * back out of them. An earlier cut of `telemetryOf` recovered the Agent id by
 * splitting its display name, which produced `Weekly` for the Weekly
 * Operations Analyst — a telemetry field that silently reports the wrong thing
 * is worse than one that reports nothing.
 */
export interface EvidenceIds {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly routeId: string;
  readonly configurationRevision: number | null;
  readonly payerKind: PayerKind;
}

export interface EvidenceView {
  readonly ids: EvidenceIds;
  readonly person: Known<string>;
  readonly organization: Known<string>;
  readonly agent: Known<string>;
  readonly team: Known<string>;
  readonly handoff: Known<string>;
  readonly model: Known<string>;
  readonly runtime: Known<string>;
  readonly choice: {
    readonly agent: AgentResolution['agentSelection'];
    readonly model: AgentResolution['modelSelection'];
  };
  readonly configuration: Known<string>;
  readonly rules: Known<string>;
  readonly governing: readonly GoverningRecord[];
  readonly authority: Known<string>;
  readonly payer: Known<string>;
  readonly reservation: Known<string>;
  readonly effect: Known<string>;
  readonly verification: Known<string>;
  /**
   * Four distinct answers. Filling one in from another is how a run that
   * nobody reviewed comes to look reviewed.
   */
  readonly roles: {
    readonly proposer: Known<string>;
    readonly reviewer: Known<string>;
    readonly writer: Known<string>;
    readonly verifier: Known<string>;
  };
}

export function evidenceFor(
  resolution: ExecutionResolution,
  observed: EvidenceObserved,
): EvidenceView {
  return {
    ids: {
      agentId: resolution.agent.agentId,
      agentVersion: resolution.agent.agentVersion,
      routeId: resolution.route.routeId,
      configurationRevision: resolution.configuration?.revision ?? null,
      payerKind: resolution.payer.kind,
    },
    person: known(resolution.principal.id),
    organization:
      resolution.workspace.kind === 'business'
        ? known(resolution.workspace.organizationId)
        : unknown('This was personal work, so no business is involved.'),
    agent: known(`${resolution.agent.agentName} ${resolution.agent.agentVersion}`),
    team: maybe(resolution.team?.teamId ?? null, 'This job did not run as part of a team.'),
    handoff: maybe(resolution.team?.handoffId ?? null, 'Nothing was handed to this job.'),
    model: maybe(
      observed.runtimeModel,
      'The runtime did not report which model answered, so it is not recorded.',
    ),
    runtime: maybe(observed.runtimeEngine, 'The runtime did not identify itself.'),
    choice: {
      agent: resolution.agent.agentSelection,
      model: resolution.route.modelSelection,
    },
    configuration: maybe(
      resolution.configuration ? `revision ${resolution.configuration.revision}` : null,
      'No business setup was active for this work.',
    ),
    rules: known(resolution.rules.revision),
    governing: resolution.rules.governing,
    authority: known(resolution.agent.effectivePermission),
    payer: known(resolution.payer.kind),
    reservation: maybe(
      resolution.budget?.reservationId ?? null,
      'Nothing was reserved for this work.',
    ),
    effect: maybe(observed.effect, 'Nothing was changed yet.'),
    verification: maybe(observed.verification, 'This has not been checked yet.'),
    roles: {
      proposer: maybe(observed.proposer, 'Nobody is recorded as having proposed this.'),
      reviewer: maybe(observed.reviewer, 'Nobody reviewed this.'),
      writer: maybe(observed.writer, 'Nothing has been written.'),
      verifier: maybe(observed.verifier, 'Nobody has checked the result.'),
    },
  };
}

/**
 * What may leave the machine as ordinary telemetry.
 *
 * Identifiers, revisions and counts. No effect description, no verification
 * text, no rule text, no reasoning — every one of those can name a customer,
 * quote a document or restate something private, and generic telemetry is
 * exactly the place nobody re-reads before it is sent.
 */
export interface Telemetry {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly agentSelection: string;
  readonly modelSelection: string;
  readonly runtime: string | null;
  readonly routeId: string;
  readonly rulesRevision: string;
  readonly governingRuleCount: number;
  readonly configurationRevision: number | null;
  readonly payerKind: PayerKind;
  readonly hasReservation: boolean;
  readonly rolesKnown: readonly string[];
  readonly effectRecorded: boolean;
  readonly verified: boolean;
}

export function telemetryOf(view: EvidenceView): Telemetry {
  const roles = Object.entries(view.roles)
    .filter(([, value]) => value.known)
    .map(([name]) => name);
  return {
    agentId: view.ids.agentId,
    agentVersion: view.ids.agentVersion,
    agentSelection: view.choice.agent,
    modelSelection: view.choice.model,
    runtime: view.runtime.known ? view.runtime.value : null,
    routeId: view.ids.routeId,
    rulesRevision: view.rules.known ? view.rules.value : 'unknown',
    governingRuleCount: view.governing.length,
    configurationRevision: view.ids.configurationRevision,
    payerKind: view.ids.payerKind,
    hasReservation: view.reservation.known,
    rolesKnown: Object.freeze(roles),
    effectRecorded: view.effect.known,
    verified: view.verification.known,
  };
}

// --- the ordinary view --------------------------------------------------------

export interface PlainSummary {
  readonly business: string;
  readonly job: string;
  readonly state: string;
  readonly approval: string;
  readonly allowance: string;
}

/**
 * What the Console shows without expanding anything: which business, which job,
 * where it is, whether it is waiting on a person, and what is left to spend.
 * Everything technical belongs behind the inspector, which reads `evidenceFor`.
 */
export function plainSummary(
  resolution: ExecutionResolution,
  work: { readonly job: string; readonly state: string },
): PlainSummary {
  const approval =
    resolution.agent.effectivePermission === 'review'
      ? 'Every change comes to you before anything is written.'
      : resolution.agent.effectivePermission === 'auto-review'
        ? 'Routine changes inside the scope you approved are reviewed automatically; anything else comes to you.'
        : 'Changes inside the scope you approved are applied without asking again.';
  return {
    business:
      resolution.workspace.kind === 'business' ? resolution.workspace.organizationId : 'Personal',
    job: work.job,
    state: work.state,
    approval,
    allowance:
      resolution.budget && resolution.budget.capUsd !== null
        ? `Up to ${resolution.budget.capUsd} dollars a month for this business.`
        : 'No spending limit has been set for this business yet.',
  };
}
