/**
 * Where an observation scope starts, and which scope a saved run belongs to (PH-00 contract 2.4, 3).
 *
 * `bind` is the only way a scope comes into being. `EngineService.admitModelApi` calls it once
 * every admission check has passed, keyed by the surface and the job id that caller already
 * passes to the Agent gate, and calls `refused` when the gate refuses, which ends every scope of
 * that business. Every other caller only reads a scope or ends one.
 *
 * A run resolves to a scope from what its own record says it is, never from what a request
 * claimed:
 *
 *   model-api-turn            conversation:<input.conversationRunId>, trace root = the turn
 *   engine-text-turn          work:<run.id>
 *   model-api-team-work       team:<input.commandId>   (the admission's rootJobId is the request id)
 *   diomedes-loop             loop:<run.id>
 *   loop delegate/worker/advisor
 *                             loop:<run.id> (a child admits under its own id), else the loop
 *                             root's scope; trace root = input.rootRunId ?? input.parent.runId
 *   model-api-conversation    never: the lineage run holds history, not work
 *
 * Nothing here persists. After a restart there are no scopes until work is admitted again.
 */
import type { HarnessRun } from '../../shared/harness.js';
import type { AdmittedAgentWork } from '../accounts/agent-gate.js';
import {
  ABSENT_TELEMETRY_POLICY,
  bindKeyFor,
  decideObservationEligibility,
  recheckScope,
  type EligibilityDecision,
  type ObservationAuthorityPort,
  type ObservationDenial,
  type ObservationOperatorConfig,
  type ObservationScope,
  type ScopeRecheck,
  type TelemetryPolicyPort,
} from './eligibility.js';

export interface ObservationBindInput {
  readonly admission: AdmittedAgentWork | null;
  readonly rootJobId: string | null;
  readonly route: string;
  readonly connectionId: string;
  readonly model: string | null;
}

/**
 * All `EngineService` holds: `bind` after every admission check passed; `businessFor` just before
 * the Agent gate is asked, and `refused` when the gate's answer says the business is not entitled.
 */
export interface ObservationBinder {
  bind(input: ObservationBindInput): void;
  businessFor(projectId: string | null): string | null;
  refused(input: ObservationRefusalInput): void;
}

/** A refused admission: the project it was for, and the business the gate asked about. */
export interface ObservationRefusalInput {
  readonly projectId: string | null;
  /**
   * The business, decided before the admission's round trip by the gate's own rule (PH-07 N-1), so a
   * workspace switch during the round trip cannot move the refusal to another business. Only a
   * direct caller that omits it has the business resolved from `projectId` at the call.
   */
  readonly organizationId?: string | null;
}

/**
 * The account service's refusal codes that say the business is not entitled (PH-07 N-2). Only these
 * end a business's observation. `entitlement_unknown` (the service unreachable, a 5xx, a timeout) and
 * sign-in are not refusals of the business, and end nothing.
 */
export const ENTITLEMENT_REFUSALS: ReadonlySet<string> = new Set([
  'entitlement_revoked',
  'entitlement_expired',
  'agent_not_included',
  'not_a_member',
]);

/** Whether an error the Agent gate threw is a definitive refusal of the business. */
export function refusalEndsObservation(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { refusalCode?: unknown }).refusalCode : undefined;
  return typeof code === 'string' && ENTITLEMENT_REFUSALS.has(code);
}

export interface ResolvedScope {
  readonly scope: ObservationScope;
  /** The scope was bound for this run's own admission, not inherited from its loop root. */
  readonly own: boolean;
  readonly traceRootRunId: string;
  /** The run whose span this run's steps hang from: itself. Its own parent run, for a child. */
  readonly parentRunId: string | null;
  /** A conversation's lineage run id, for `$ai_session_id`. */
  readonly lineageRunId: string | null;
}

export interface ObservationScopesOptions {
  readonly operator: ObservationOperatorConfig;
  readonly backend: () => 'faux' | 'cloud' | 'unavailable';
  readonly authority: ObservationAuthorityPort;
  readonly telemetry?: TelemetryPolicyPort;
  readonly now?: () => number;
  /** Bound scopes kept; the oldest is forgotten first. */
  readonly limit?: number;
}

export const LOOP_CHILD_CAPABILITIES: readonly string[] = Object.freeze([
  'diomedes-loop-delegate',
  'diomedes-loop-worker',
  'diomedes-loop-advisor',
]);

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export class ObservationScopes implements ObservationBinder {
  readonly operator: ObservationOperatorConfig;
  private readonly scopes = new Map<string, ObservationScope>();
  private readonly denied = new Map<ObservationDenial, number>();
  /** Refused admissions per business. A scope bound before its business's latest refusal has ended. */
  private readonly refusals = new Map<string, number>();
  /**
   * Who is signed in and which business is active, as last seen, and how many times that has
   * changed. A scope bound before the latest change has ended for good (contract 4.6; PH-07 N-3).
   */
  private context: { person: string | null; active: string | null } | null = null;
  private contextChanges = 0;
  /** Why each recent change ended what came before it, by change number; the oldest are forgotten. */
  private readonly contextEnds = new Map<number, ObservationDenial>();
  /** What each bound scope saw at bind. Weak, so a forgotten scope is not kept. */
  private readonly generation = new WeakMap<ObservationScope, { refusals: number; context: number }>();
  /** A scope whose recheck once failed stays ended, with the reason it first failed. */
  private readonly ended = new WeakMap<ObservationScope, ObservationDenial>();
  private readonly telemetry: TelemetryPolicyPort;
  private readonly now: () => number;
  private readonly limit: number;

  constructor(private readonly options: ObservationScopesOptions) {
    this.operator = options.operator;
    this.telemetry = options.telemetry ?? ABSENT_TELEMETRY_POLICY;
    this.now = options.now ?? Date.now;
    this.limit = Math.max(1, options.limit ?? 2_000);
  }

  bind(input: ObservationBindInput): void {
    this.decide(input);
  }

  /** `bind`, returning the decision so tests can read it. A denial is counted, never thrown. */
  decide(input: ObservationBindInput): EligibilityDecision {
    // A change not yet seen ends what was bound before it, never this new scope.
    this.observeContext();
    const decision = decideObservationEligibility({
      operator: this.operator,
      backend: this.options.backend(),
      admission: input.admission,
      work: { rootJobId: input.rootJobId, route: input.route, connectionId: input.connectionId, model: input.model },
      activeOrganizationId: this.options.authority.activeOrganizationId(),
      telemetry: this.telemetry,
      now: this.now(),
    });
    if (!decision.eligible) {
      this.count(decision.denial);
      // A later admission that is refused ends the earlier scope for the same work.
      if (input.admission && input.rootJobId) this.scopes.delete(bindKeyFor(input.admission.surface, input.rootJobId));
      return decision;
    }
    this.scopes.delete(decision.scope.bindKey);
    this.scopes.set(decision.scope.bindKey, decision.scope);
    this.generation.set(decision.scope, {
      refusals: this.refusals.get(decision.scope.organizationId) ?? 0,
      context: this.contextChanges,
    });
    while (this.scopes.size > this.limit) this.scopes.delete(this.scopes.keys().next().value as string);
    return decision;
  }

  /**
   * The business an admission for this project is asked about, by the Agent gate's rule: the
   * project's owner, else the active business. Null is Personal. `EngineService` reads it on the
   * same turn the gate does, before the round trip to the account service (PH-07 N-1).
   */
  businessFor(projectId: string | null): string | null {
    const authority = this.options.authority;
    return authority.organizationFor ? authority.organizationFor(projectId) : authority.activeOrganizationId();
  }

  /**
   * The account service refused the business (contract section 3, as amended by the architect ruling
   * of 2026-09-25: a definitive refusal ends optional export at the next admission). Every scope of
   * that business ends: no later event of its runs is projected, and the recheck drops whatever is
   * queued or waiting for a retry at the next flush. A later admission the service admits binds
   * anew. Personal work (no business) ends nothing. `EngineService` calls this only for
   * `ENTITLEMENT_REFUSALS`, with the business it read before the round trip.
   */
  refused(input: ObservationRefusalInput): void {
    const organizationId = input.organizationId !== undefined ? input.organizationId : this.businessFor(input.projectId);
    if (!organizationId) return;
    this.refusals.set(organizationId, (this.refusals.get(organizationId) ?? 0) + 1);
    for (const [key, scope] of this.scopes) if (scope.organizationId === organizationId) this.scopes.delete(key);
    this.count('admission-refused');
  }

  /** The bound scope for one run, or null: no observation of anything that has none. */
  resolve(run: HarnessRun): ResolvedScope | null {
    const input = record(run.input);
    const found = (key: string, own: boolean, traceRootRunId: string, parentRunId: string | null, lineageRunId: string | null) => {
      const scope = this.scopes.get(key);
      return scope ? { scope, own, traceRootRunId, parentRunId, lineageRunId } : null;
    };
    switch (run.capabilityId) {
      case 'model-api-turn': {
        const lineage = text(input.conversationRunId);
        return lineage ? found(`conversation:${lineage}`, true, run.id, null, lineage) : null;
      }
      case 'engine-text-turn':
        return found(`work:${run.id}`, true, run.id, null, null);
      case 'model-api-team-work': {
        const command = text(input.commandId);
        return command ? found(`team:${command}`, true, run.id, null, null) : null;
      }
      case 'diomedes-loop':
        return found(`loop:${run.id}`, true, run.id, null, null);
      default: {
        if (!LOOP_CHILD_CAPABILITIES.includes(run.capabilityId)) return null;
        const parent = text(record(input.parent).runId);
        const root = text(input.rootRunId) ?? parent;
        if (!root || !parent) return null;
        return found(`loop:${run.id}`, true, root, parent, null) ?? found(`loop:${root}`, false, root, parent, null);
      }
    }
  }

  /** The live recheck, run at enqueue and before each send. A failure is counted. */
  recheck(scope: ObservationScope): ScopeRecheck {
    let result: ScopeRecheck;
    try {
      this.observeContext();
      const bound = this.generation.get(scope) ?? { refusals: 0, context: 0 };
      const ended = this.ended.get(scope);
      result = ended
        ? { live: false, denial: ended }
        : // Ended by a later refusal, even when the cached entitlement has not caught up yet.
          bound.refusals < (this.refusals.get(scope.organizationId) ?? 0)
          ? { live: false, denial: 'admission-refused' }
          : // Ended by a sign-out, another person or another business since bind, even if it is back.
            bound.context < this.contextChanges
            ? { live: false, denial: this.contextEnds.get(bound.context + 1) ?? 'workspace-changed' }
            : recheckScope(scope, this.options.authority, this.operator, this.telemetry);
    } catch {
      result = { live: false, denial: 'account-service-unavailable' };
    }
    if (!result.live) {
      this.count(result.denial);
      // An end is final for the scope (contract 4.6; PH-07 N-3). Not being able to ask is not an end.
      if (result.denial !== 'account-service-unavailable' && !this.ended.has(scope)) this.ended.set(scope, result.denial);
    }
    return result;
  }

  /**
   * Sample who is signed in and which business is active. A change from the last sample, even one
   * that is later undone, ends every scope bound before it. Called on every settings save and every
   * account projection (sign-in, sign-out, reload), at bind and at every recheck. Never throws.
   */
  observeContext(): void {
    let now: { person: string | null; active: string | null };
    try {
      now = { person: this.options.authority.personId(), active: this.options.authority.activeOrganizationId() };
    } catch {
      return;
    }
    const seen = this.context;
    this.context = now;
    // The first sample only sets the baseline: no scope can exist before it.
    if (!seen || (seen.person === now.person && seen.active === now.active)) return;
    this.contextChanges += 1;
    this.contextEnds.set(
      this.contextChanges,
      now.person === null ? 'signed-out' : now.person !== seen.person ? 'person-changed' : 'workspace-changed',
    );
    this.contextEnds.delete(this.contextChanges - 256);
  }

  denials(): Readonly<Partial<Record<ObservationDenial, number>>> {
    return Object.fromEntries(this.denied);
  }

  get size() {
    return this.scopes.size;
  }

  private count(denial: ObservationDenial) {
    this.denied.set(denial, (this.denied.get(denial) ?? 0) + 1);
  }
}
