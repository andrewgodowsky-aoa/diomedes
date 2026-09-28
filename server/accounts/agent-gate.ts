/**
 * The Nectovia Agent's admission at the host.
 *
 * Every piece of Agent work on a model-API route (a conversation message, a
 * Work turn, a team member's turn, a work loop starting or resuming) is
 * admitted here before anything is sent. A working provider connection is not
 * a plan: a Free person with a perfectly good key still cannot start the Agent,
 * and a Business member with the same key can. Withdrawing a business's grant
 * refuses its next admission; it deletes nothing and leaves every earlier
 * charge as it was.
 *
 * Admission runs before a model step, never inside one: the run service records
 * any failure inside an external model step as possibly sent, so a check there
 * would turn "your plan ended" into an uncertain charge. A loop already running
 * keeps its admission until it next resumes. Per-call enforcement for
 * Diomedes-funded routes belongs to the company proxy, which sees every call.
 *
 * The business is the one that owns the project. An unbound project, including
 * Home, has no business payer. Projectless work uses the active Business
 * workspace. Personal work and unbound projects are admitted only under the
 * person's own Individual plan (2026-09-28), which does not include the company
 * route yet; without one they are refused. A person with no subscription anywhere reads the
 * free-version sentence instead (Andrew, 2026-09-27): nothing tells them to link or
 * switch to a business they do not have. Their conversations run on their own AI
 * before any of this is asked (`paidFor` in the host's route resolution).
 *
 * Diomedes-funded work (`managed`) also needs the business's included AI usage
 * ('managed-inference'). The host reads it from the same access as the Agent,
 * through `AccountSessionService.includes`, and refuses before the service
 * records an admission; the company gateway still checks funding on every call.
 */
import { SIGN_IN_REQUIRED } from '../../shared/accounts.js';
import { AGENT_FEATURE, AGENT_FREE_VERSION_REASON, AGENT_PERSONAL_REASON, FEATURE_LABELS, type AccessFeature } from '../../shared/access.js';
import { AGENT_PERSONAL_INDIVIDUAL_REASON, MANAGED_USAGE_NOT_INCLUDED_PERSONAL, isPersonPlan } from '../../shared/individual-plan.js';
import { EngineError } from '../engines/process.js';
import type { WorkspaceService } from '../workspaces.js';
import type { AccountSessionService, AgentRouteKind, AgentSurface } from './session.js';
import type { AccountRoutingSession } from './routing-session.js';
import type { AccountScope } from '../../shared/routing-policy.js';

export const AGENT_NOT_INCLUDED = 'AGENT_NOT_INCLUDED';
export const AGENT_SIGN_IN_REQUIRED = 'SIGN_IN_REQUIRED';
export const AGENT_PROJECT_UNLINKED = 'This project is not linked to one business. An owner or administrator must link it before the Nectovia Agent can work here. Nothing was sent.';
const MANAGED_INFERENCE: AccessFeature = 'managed-inference';
/** Why Diomedes-funded work is refused for a business whose plan has the Agent but not included usage. */
export const MANAGED_USAGE_NOT_INCLUDED = `${FEATURE_LABELS[MANAGED_INFERENCE]} isn't part of this business's plan, so the Nectovia Agent can't answer here. Nothing was sent.`;

export interface AgentWork {
  phase: 'admit' | 'dispatch';
  surface: AgentSurface;
  projectId: string | null;
  /** The run or job this call belongs to, so the service can pin the admission to it. */
  rootJobId: string | null;
  /**
   * Who pays for the call. `managed` is company-funded inference through the account service's
   * gateway; everything else on this host runs on the business's own connection (`byo`).
   * Absent means `byo`.
   */
  routeKind?: AgentRouteKind;
}

/**
 * The decision an admitted piece of Agent work carries forward. The admission id is the
 * control-plane record the managed gateway checks on every call, and what observation binds to;
 * nothing here is a credential.
 */
export interface AdmittedAgentWork {
  readonly admissionId: string;
  /** Null for Personal work admitted under the person's own Individual plan. */
  readonly organizationId: string | null;
  readonly scope?: AccountScope;
  readonly personId: string;
  readonly planId: string | null;
  /** The routing tier policy revision the service admitted under. Not a telemetry policy. */
  readonly policyRevision: number;
  readonly routeKind: AgentRouteKind;
  readonly surface: AgentSurface;
  readonly validUntil: string;
}

export interface AgentGatePort {
  /** Resolves with the admitted decision; throws an EngineError that sends nothing otherwise. */
  check(work: AgentWork): Promise<AdmittedAgentWork>;
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Company-funded work the plan does not include. Nothing was sent. */
function usageRefusal(reason: string): EngineError {
  const refusal = new EngineError(AGENT_NOT_INCLUDED, reason, false);
  Object.defineProperty(refusal, 'refusalCode', { value: 'managed_inference_not_included', enumerable: false });
  return refusal;
}

export class AccountAgentGate implements AgentGatePort {
  constructor(
    private readonly session: AccountSessionService,
    private readonly workspaces: Pick<WorkspaceService, 'projectOwner' | 'active'>,
    private readonly routing?: AccountRoutingSession,
  ) {}

  /** The business this work is for, or null for Personal. */
  organizationFor(projectId: string | null): string | null {
    if (projectId !== null) {
      const owner = this.workspaces.projectOwner(projectId);
      return owner?.organizationId ?? null;
    }
    const active = this.workspaces.active();
    return active.kind === 'business' ? active.organizationId : null;
  }

  /**
   * Whether work here has the Agent: the business it belongs to includes it, or that business's
   * access has not been read yet, so the admission decides. Personal work and projects no business
   * owns have the Agent under the person's own Individual plan, or while that plan is not read yet.
   */
  paidFor(projectId: string | null): boolean {
    const scope = this.routing?.scopeFor(projectId);
    if (scope?.kind === 'individual') return this.routing!.mayHaveAgent(scope);
    const organizationId = this.organizationFor(projectId);
    // Personal work and projects no business owns: the person's own Individual plan, or not read yet.
    if (!organizationId) return this.session.personalIncludes(AGENT_FEATURE) || this.session.personalUnknown();
    return this.session.entitlement(organizationId)?.state === 'unknown' || this.session.includes(organizationId, AGENT_FEATURE);
  }

  /**
   * Why work no business pays for is refused: the company route an Individual plan does not include
   * yet, the free version, the missing Individual plan, or the missing link or workspace.
   */
  unpaidReason(projectId: string | null): string {
    if (this.session.personalIncludes(AGENT_FEATURE)) return MANAGED_USAGE_NOT_INCLUDED_PERSONAL;
    const plan = this.session.agentPlan();
    if (plan === 'free') return AGENT_FREE_VERSION_REASON;
    if (projectId !== null) return AGENT_PROJECT_UNLINKED;
    return plan === 'paid' ? AGENT_PERSONAL_INDIVIDUAL_REASON : AGENT_PERSONAL_REASON;
  }

  async check(work: AgentWork): Promise<AdmittedAgentWork> {
    if (this.routing) return this.routing.admit(work);
    const organizationId = this.organizationFor(work.projectId);
    const routeKind = work.routeKind ?? 'byo';
    if (!organizationId) {
      // Personal work, or a project no business owns: only the person's own Individual plan admits
      // it. Known to be missing, it is refused here; not read yet, the service decides.
      const held = this.session.personalIncludes(AGENT_FEATURE);
      if (!held && !this.session.personalUnknown()) throw new EngineError(AGENT_NOT_INCLUDED, this.unpaidReason(work.projectId), false);
      if (held && routeKind === 'managed') throw usageRefusal(MANAGED_USAGE_NOT_INCLUDED_PERSONAL);
    } else if (
      // Only where the access is known (it includes the Agent): a business this host has no answer
      // for is the service's to refuse, in its own words.
      routeKind === 'managed' &&
      this.session.includes(organizationId, AGENT_FEATURE) &&
      !this.session.includes(organizationId, MANAGED_INFERENCE)
    )
      // A sole proprietor covered by their own Individual plan reads the plan's own sentence.
      throw usageRefusal(isPersonPlan(this.session.entitlement(organizationId)?.plan) ? MANAGED_USAGE_NOT_INCLUDED_PERSONAL : MANAGED_USAGE_NOT_INCLUDED);
    const decision = await this.session.admitAgent({
      organizationId,
      surface: work.surface,
      routeKind,
      rootJobId: work.rootJobId && JOB_ID.test(work.rootJobId) ? work.rootJobId : null,
      phase: work.phase,
    });
    if (decision.admitted)
      return {
        admissionId: decision.admissionId,
        organizationId: decision.organizationId,
        personId: decision.personId,
        planId: decision.planId,
        policyRevision: decision.policyRevision,
        routeKind,
        surface: work.surface,
        validUntil: decision.validUntil,
      };
    const refusal = new EngineError(decision.code === SIGN_IN_REQUIRED ? AGENT_SIGN_IN_REQUIRED : AGENT_NOT_INCLUDED, decision.reason, false);
    // Additive: the service's own refusal code (`entitlement_revoked`, `entitlement_unknown`, ...), so
    // a caller can tell a revocation from an outage. Read-only and not enumerable: the error's class,
    // `code`, message and status are unchanged, and nothing that serializes it sees the field.
    Object.defineProperty(refusal, 'refusalCode', { value: decision.code, enumerable: false });
    throw refusal;
  }
}
