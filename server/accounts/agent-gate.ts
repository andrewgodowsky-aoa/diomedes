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
 * The business is the one the work belongs to: the organization that owns the
 * project, or else the active Business workspace. Personal work has no
 * business, so the Agent refuses it with the sentence the service would use.
 */
import { SIGN_IN_REQUIRED } from '../../shared/accounts.js';
import { AGENT_PERSONAL_REASON } from '../../shared/access.js';
import { EngineError } from '../engines/process.js';
import type { WorkspaceService } from '../workspaces.js';
import type { AccountSessionService, AgentRouteKind, AgentSurface } from './session.js';

export const AGENT_NOT_INCLUDED = 'AGENT_NOT_INCLUDED';
export const AGENT_SIGN_IN_REQUIRED = 'SIGN_IN_REQUIRED';

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
    const owner = projectId ? this.workspaces.projectOwner(projectId) : null;
    if (owner) return owner.organizationId;
    const active = this.workspaces.active();
    return active.kind === 'business' ? active.organizationId : null;
  }

  async check(work: AgentWork): Promise<AdmittedAgentWork> {
    const organizationId = this.organizationFor(work.projectId);
    if (!organizationId) throw new EngineError(AGENT_NOT_INCLUDED, AGENT_PERSONAL_REASON, false);
    const routeKind = work.routeKind ?? 'byo';
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
