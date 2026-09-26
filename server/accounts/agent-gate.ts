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
 * Home, has no payer and is refused. Projectless work uses the active Business
 * workspace. Personal work has no business, so the Agent refuses it with the
 * sentence the service would use.
 *
 * Diomedes-funded work (`managed`) also needs the business's included AI usage
 * ('managed-inference'). The host reads it from the same access as the Agent,
 * through `AccountSessionService.includes`, and refuses before the service
 * records an admission; the company gateway still checks funding on every call.
 */
import { SIGN_IN_REQUIRED } from '../../shared/accounts.js';
import { AGENT_FEATURE, AGENT_PERSONAL_REASON, FEATURE_LABELS, type AccessFeature } from '../../shared/access.js';
import { EngineError } from '../engines/process.js';
import type { WorkspaceService } from '../workspaces.js';
import type { AccountSessionService, AgentRouteKind, AgentSurface } from './session.js';

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
  readonly organizationId: string;
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

export class AccountAgentGate implements AgentGatePort {
  constructor(
    private readonly session: AccountSessionService,
    private readonly workspaces: Pick<WorkspaceService, 'projectOwner' | 'active'>,
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

  async check(work: AgentWork): Promise<AdmittedAgentWork> {
    const organizationId = this.organizationFor(work.projectId);
    if (!organizationId)
      throw new EngineError(
        AGENT_NOT_INCLUDED,
        work.projectId === null ? AGENT_PERSONAL_REASON : AGENT_PROJECT_UNLINKED,
        false,
      );
    const routeKind = work.routeKind ?? 'byo';
    // Only where the access is known (it includes the Agent): a business this host has no answer
    // for is the service's to refuse, in its own words.
    if (
      routeKind === 'managed' &&
      this.session.includes(organizationId, AGENT_FEATURE) &&
      !this.session.includes(organizationId, MANAGED_INFERENCE)
    ) {
      const refusal = new EngineError(AGENT_NOT_INCLUDED, MANAGED_USAGE_NOT_INCLUDED, false);
      Object.defineProperty(refusal, 'refusalCode', { value: 'managed_inference_not_included', enumerable: false });
      throw refusal;
    }
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
