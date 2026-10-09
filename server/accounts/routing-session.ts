/** Ephemeral, person-and-scope-bound routing cache. The control plane remains authoritative. */
import { z } from 'zod';
import { SIGN_IN_REQUIRED } from '../../shared/accounts.js';
import { AGENT_FEATURE, AGENT_FREE_VERSION_REASON, AGENT_PERSONAL_REASON, BUSINESS_PLAN_NEEDED_BUYER, BUSINESS_PLAN_NEEDED_MEMBER,
  OUT_OF_CREDITS_PERSONAL } from '../../shared/access.js';
import { decidePayAsYouGo } from '../../shared/pay-as-you-go.js';
import { MANAGED_USAGE_NOT_INCLUDED_PERSONAL } from '../../shared/individual-plan.js';
import { cycleContains, verifiedIndividualCycle, type IndividualBillingCycle } from '../../shared/individual-period.js';
import { routingScopeKey, type AccountScope, type IndividualAccount, type RoutingPreferenceWrite } from '../../shared/routing-policy.js';
import type { AccessFeature } from '../../shared/access.js';
import type { EscalationView } from '../../shared/escalation-controls.js';
import type { EntitlementView } from '../../shared/workspaces.js';
import type { NectoviaPolicy } from '../engines/nectovia.js';
import { EngineError } from '../engines/process.js';
import { ApiError } from '../paths.js';
import type { WorkspaceService } from '../workspaces.js';
import { refusedMembership, type AccountSessionService } from './session.js';
import { MANAGED_USAGE_NOT_INCLUDED, type AdmittedAgentWork, type AgentWork } from './agent-gate.js';

const admissionSchema = z.object({ admissionId: z.string().min(1), validUntil: z.iso.datetime(),
  billingCycle: z.custom<IndividualBillingCycle>(value => verifiedIndividualCycle(value) !== null).optional(),
  decision: z.discriminatedUnion('admitted', [
    z.object({ admitted: z.literal(true), planId: z.string().nullable(), revision: z.number().int(), validUntil: z.string().nullable() }),
    z.object({ admitted: z.literal(false), code: z.string(), reason: z.string() }),
  ]),
  pins: z.object({ scope: z.object({ kind: z.enum(['organization', 'individual']), id: z.string() }),
    organizationId: z.string().nullable(), tenantId: z.string(), personId: z.string(), planId: z.string().nullable(),
    accessRevision: z.number().int(), policyRevision: z.number().int(), rootJobId: z.string().nullable() }),
});

const NOTHING_SENT = ' Nothing was sent.';

function admissionRefusal(code: string, reason: string) {
  const refusal = new EngineError(code === SIGN_IN_REQUIRED ? 'SIGN_IN_REQUIRED' : 'AGENT_NOT_INCLUDED', reason, false);
  Object.defineProperty(refusal, 'refusalCode', { value: code, enumerable: false });
  return refusal;
}

function refusedBusinessScope(error: unknown) {
  return refusedMembership(error) || (error instanceof ApiError && error.status === 403 && error.details.code === 'scope_forbidden');
}

export class AccountRoutingSession {
  private person: string | null = null;
  private individual: IndividualAccount | null = null;
  private individualAccess: { value: EntitlementView; until: number } | null = null;
  private policies = new Map<string, { value: NectoviaPolicy; until: number }>();
  /** Each scope's escalation control, read on its own and kept the way the routing snapshot is. */
  private escalations = new Map<string, { value: EscalationView; until: number }>();
  constructor(private readonly session: AccountSessionService,
    private readonly workspaces: Pick<WorkspaceService, 'projectOwner' | 'active'>, private readonly now = Date.now) {}

  invalidate() { this.policies.clear(); this.escalations.clear(); this.individualAccess = null; this.current(); }

  private async ensureIndividual() {
    const person = this.current();
    if (!person) return null;
    if (this.individual) return this.individual;
    const row = await this.session.call(token => this.session.backend.client.individualAccount(token));
    if (this.current() !== person || row.personId !== person || row.tenantId !== person)
      throw new EngineError('ACCOUNT_CHANGED', 'The signed-in account changed. Nothing was sent.', false);
    return this.individual = row;
  }
  /** Entitlement refresh never requires a managed route or a provider connection. */
  async refreshAccess() {
    const account = await this.ensureIndividual();
    if (!account) return;
    const access = await this.session.call(token => this.session.backend.client.scopedAccess(token, { kind: 'individual', id: account.id }));
    if (this.current() !== account.personId)
      throw new EngineError('ACCOUNT_CHANGED', 'The signed-in account changed. Nothing was sent.', false);
    const expires = access.validUntil === null ? Infinity : Date.parse(access.validUntil);
    this.individualAccess = { value: access, until: Math.min(this.now() + 60_000, Number.isFinite(expires) ? expires : this.now() + 60_000) };
  }

  private current() {
    const person = this.session.personId();
    if (person !== this.person) {
      this.person = person; this.individual = null; this.individualAccess = null; this.policies.clear(); this.escalations.clear();
    }
    return person;
  }
  scopeFor(projectId: string | null): AccountScope | null {
    if (!this.current()) return null;
    const owner = projectId === null ? null : this.workspaces.projectOwner(projectId);
    if (owner) return { kind: 'organization', id: owner.organizationId };
    const active = this.workspaces.active();
    if (projectId === null && active.kind === 'business') return { kind: 'organization', id: active.organizationId };
    return this.individual ? { kind: 'individual', id: this.individual.id } : null;
  }
  private assertScope(projectId: string | null, person: string | null, scope: AccountScope) {
    if (!person || this.current() !== person || routingScopeKey(this.scopeFor(projectId) ?? { kind: 'global' }) !== routingScopeKey(scope))
      throw new EngineError('ACCOUNT_CHANGED', 'The account owning this work changed. Refresh before continuing.', false);
  }
  policy(projectId: string | null = null): NectoviaPolicy | null {
    const scope = this.scopeFor(projectId), found = scope ? this.policies.get(routingScopeKey(scope)) : null;
    return found && found.until > this.now() ? found.value : null;
  }
  async refresh(projectId: string | null = null): Promise<NectoviaPolicy | null> {
    const person = this.current();
    if (!person) return null;
    await this.ensureIndividual();
    const scope = this.scopeFor(projectId);
    if (!scope) return null;
    const key = routingScopeKey(scope);
    this.policies.delete(key);
    const snapshot = await this.session.call(token => this.session.backend.client.scopedRoutingPolicy(token, scope));
    const value: NectoviaPolicy = snapshot.legacy
      ? await this.session.call(token => this.session.backend.client.routingPolicy(token))
      : { revision: snapshot.revision, tiers: snapshot.tiers, resolved: snapshot,
        reasoningSummaries: {
          efficient: snapshot.tiers.efficient?.reasoningSummaries === true,
          focused: snapshot.tiers.focused?.reasoningSummaries === true,
          thorough: snapshot.tiers.thorough?.reasoningSummaries === true,
          expert: snapshot.tiers.expert?.reasoningSummaries === true,
        } };
    this.assertScope(projectId, person, scope);
    if (!this.individualAccess || this.individualAccess.until <= this.now() || scope.kind === 'individual') await this.refreshAccess();
    this.assertScope(projectId, person, scope);
    this.policies.set(key, { value, until: Math.min(Date.parse(snapshot.validUntil), this.now() + 60_000) });
    return value;
  }
  /** The scope's escalation control as last read, while that read is current. Null: not read, or stale. */
  escalation(projectId: string | null = null): EscalationView | null {
    const scope = this.scopeFor(projectId), found = scope ? this.escalations.get(routingScopeKey(scope)) : null;
    return found && found.until > this.now() ? found.value : null;
  }
  /**
   * Read the scope's escalation control again (`GET /account/routing/{kind}/{id}/escalation`), kept
   * for this person and scope only, for a minute at most, as the routing snapshot is. Null when
   * nobody is signed in or the work has no account. A failed read throws and keeps nothing.
   */
  async refreshEscalation(projectId: string | null = null): Promise<EscalationView | null> {
    const person = this.current();
    if (!person) return null;
    await this.ensureIndividual();
    const scope = this.scopeFor(projectId);
    if (!scope) return null;
    const key = routingScopeKey(scope);
    this.escalations.delete(key);
    const value = await this.session.call(token => this.session.backend.client.scopedEscalation(token, scope));
    this.assertScope(projectId, person, scope);
    this.escalations.set(key, { value, until: this.now() + 60_000 });
    return value;
  }
  /** Route selection only. Unknown/stale access requires fresh admission instead of
   * silently switching a previously paid Individual conversation to another payer. */
  mayHaveAgent(scope: AccountScope) {
    if (scope.kind === 'organization') return this.session.entitlement(scope.id)?.state === 'unknown' || this.session.includes(scope.id, 'nectovia-agent');
    if (!this.current() || scope.id !== this.individual?.id) return false;
    return !this.individualAccess || this.individualAccess.until <= this.now() || this.includes(scope, 'nectovia-agent') || this.paysAsYouGo(scope);
  }
  /**
   * Pay as you go (DIO-219): Personal work no plan of the person's holds the Agent for, while the account service says their own
   * bought credits are above zero. It grants no feature: `includes` stays false for every one, so nothing a plan keeps opens.
   */
  paysAsYouGo(scope: AccountScope) {
    const access = this.individualAccess;
    if (scope.kind !== 'individual' || !this.current() || scope.id !== this.individual?.id || !access || access.until <= this.now()) return false;
    return !this.includes(scope, AGENT_FEATURE) && access.value.boughtCredits === 'available';
  }
  /** Why a business workspace with no plan has no Agent, in the words for this person's role there (Model B section 7). */
  businessPlanReason(organizationId: string): string {
    const role = this.session.roleIn(organizationId);
    return role === 'owner' || role === 'admin' ? BUSINESS_PLAN_NEEDED_BUYER : BUSINESS_PLAN_NEEDED_MEMBER;
  }
  includes(scope: AccountScope, feature: AccessFeature) {
    if (scope.kind === 'organization') return this.session.includes(scope.id, feature);
    return this.current() !== null && scope.id === this.individual?.id && !!this.individualAccess &&
      this.individualAccess.until > this.now() && this.individualAccess.value.state === 'active' &&
      (this.individualAccess.value.validUntil === null || Date.parse(this.individualAccess.value.validUntil) > this.now()) &&
      this.individualAccess.value.features.includes(feature);
  }
  /** A known Personal plan refusal can precede model selection; unknown access goes to admission. */
  personalRefusal(projectId: string | null): string | null {
    const scope = this.scopeFor(projectId), access = this.individualAccess;
    if (scope?.kind !== 'individual' || !access || access.until <= this.now()) return null;
    // No plan of the person's own holds the Agent: their bought credits run it here (pay as you go, DIO-219).
    if (this.paysAsYouGo(scope)) return null;
    // Everything they bought is spent: the out-of-credits sentence (Model B section 7).
    if (access.value.state === 'none' && access.value.boughtCredits === 'spent') return OUT_OF_CREDITS_PERSONAL;
    // Never bought any: the free version keeps its own sentence (the host adds what the person can do), and anyone else reads both
    // ways in (Model B section 7).
    if (access.value.state === 'none') return this.session.agentPlan() === 'free' ? AGENT_FREE_VERSION_REASON : AGENT_PERSONAL_REASON;
    if (access.value.state === 'expired' || access.value.state === 'revoked') return access.value.reason;
    return null;
  }
  /** Confirm a cached Personal refusal so a newly granted plan takes effect before route selection. */
  async confirmedPersonalRefusal(projectId: string | null): Promise<string | null> {
    const person = this.current(), cached = this.personalRefusal(projectId);
    let scope = this.scopeFor(projectId);
    if (!person || scope?.kind === 'organization') return cached;
    const access = this.individualAccess;
    if (scope && access && access.until > this.now() &&
        (this.includes(scope, AGENT_FEATURE) || this.paysAsYouGo(scope))) return cached;
    try {
      await this.refreshAccess();
    } catch (error) {
      if ((error instanceof EngineError && error.code === 'ACCOUNT_CHANGED') || (error instanceof ApiError && error.status === 401)) throw error;
      if (scope) this.assertScope(projectId, person, scope);
      else if (this.current() !== person || this.scopeFor(projectId)?.kind === 'organization')
        throw new EngineError('ACCOUNT_CHANGED', 'The account owning this work changed. Nothing was sent.', false);
      return cached;
    }
    scope ??= this.scopeFor(projectId);
    if (!scope || scope.kind !== 'individual')
      throw new EngineError('ACCOUNT_CHANGED', 'The account owning this work changed. Nothing was sent.', false);
    this.assertScope(projectId, person, scope);
    const fresh = this.individualAccess?.value;
    if (this.includes(scope, AGENT_FEATURE) || this.paysAsYouGo(scope)) await this.session.confirmPersonalAdmitted();
    else if (fresh) await this.session.confirmPersonalDowngrade(fresh.state === 'none' ? 'entitlement_none'
      : fresh.state === 'active' ? 'agent_not_included' : fresh.state === 'unknown' ? 'entitlement_unknown' : `entitlement_${fresh.state}`);
    this.assertScope(projectId, person, scope);
    return this.personalRefusal(projectId);
  }
  async admit(work: AgentWork): Promise<AdmittedAgentWork> {
    try {
      await this.refresh(work.projectId);
    } catch (error) {
      if (this.scopeFor(work.projectId)?.kind === 'organization' && refusedBusinessScope(error))
        throw admissionRefusal('not_a_member', 'You are not a member of this business, so the Nectovia Agent cannot work for it.');
      // Starting Agent work: an unreachable account service is still a refusal, so it says nothing went out.
      // Only here; the same 503 answers sign-in and account reads elsewhere, where the sentence would be wrong.
      if (error instanceof ApiError && error.status === 503 && error.details.code === 'unreachable' && !error.message.endsWith(NOTHING_SENT))
        throw new ApiError(503, `${error.message}${NOTHING_SENT}`, error.details);
      throw error;
    }
    const scope = this.scopeFor(work.projectId), person = this.current();
    if (!scope || !person) throw new EngineError('AGENT_NOT_INCLUDED', 'This work has no authorized account. Nothing was sent.', false);
    // Known plan limits are refused before a service admission is recorded. Unknown
    // access still goes to the service, which may return a definitive revocation.
    if (scope.kind === 'individual') {
      // No plan of the person's own holds the Agent: only their bought credits can run it, and only for what a plan doesn't keep.
      if (this.paysAsYouGo(scope)) {
        const payg = decidePayAsYouGo({ surface: work.surface, routeKind: work.routeKind ?? 'byo' }, true);
        if (!payg.admitted) throw admissionRefusal(payg.code, payg.reason);
      } else if (this.individualAccess?.value.state === 'none') {
        await this.session.confirmPersonalDowngrade('agent_not_included');
        this.assertScope(work.projectId, person, scope);
        throw admissionRefusal(this.individualAccess.value.boughtCredits === 'spent' ? 'insufficient_allowance' : 'agent_not_included',
          this.personalRefusal(work.projectId) ?? AGENT_PERSONAL_REASON);
      }
      if (work.routeKind === 'managed' && this.includes(scope, AGENT_FEATURE) && !this.includes(scope, 'managed-inference'))
        throw admissionRefusal('managed_inference_not_included', MANAGED_USAGE_NOT_INCLUDED_PERSONAL);
    } else if (work.routeKind === 'managed' && this.session.includes(scope.id, AGENT_FEATURE) &&
        !this.session.includes(scope.id, 'managed-inference'))
      throw admissionRefusal('managed_inference_not_included', MANAGED_USAGE_NOT_INCLUDED);
    let raw: unknown;
    try {
      raw = await this.session.call(token => this.session.backend.client.admitScopedAgent(token, scope,
        { surface: work.surface, routeKind: work.routeKind ?? 'byo', rootJobId: work.rootJobId }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        throw admissionRefusal(SIGN_IN_REQUIRED, error.message);
      if (scope.kind === 'organization' && refusedBusinessScope(error))
        throw admissionRefusal('not_a_member', 'You are not a member of this business, so the Nectovia Agent cannot work for it.');
      throw admissionRefusal('entitlement_unknown', scope.kind === 'individual'
        ? 'The account service could not be reached, so the Nectovia Agent could not confirm your plan includes it. Nothing was sent.'
        : 'The account service could not be reached, so the Nectovia Agent could not confirm this business includes it. Nothing was sent.');
    }
    this.assertScope(work.projectId, person, scope);
    const parsed = admissionSchema.safeParse(raw);
    if (!parsed.success || this.current() !== person || parsed.data.pins.personId !== person || parsed.data.pins.scope.kind !== scope.kind ||
        parsed.data.pins.scope.id !== scope.id || parsed.data.pins.organizationId !== (scope.kind === 'organization' ? scope.id : null) ||
        (scope.kind === 'individual' && parsed.data.pins.tenantId !== person) || parsed.data.pins.rootJobId !== work.rootJobId ||
        Date.parse(parsed.data.validUntil) <= this.now())
      throw new EngineError('ACCOUNT_CHANGED', 'The account service did not return a current admission for this work. Nothing was sent.', false);
    const answer = parsed.data;
    const cycle = answer.billingCycle;
    const access = this.individualAccess?.value;
    if (cycle && (scope.kind !== 'individual' || !answer.decision.admitted || answer.decision.planId !== 'individual' ||
        answer.pins.planId !== answer.decision.planId || work.routeKind !== 'managed' || !cycleContains(cycle, this.now()) ||
        !this.includes(scope, AGENT_FEATURE) || !access?.managedInference || !access.validFrom || !access.validUntil ||
        !Number.isFinite(Date.parse(access.validFrom)) || !Number.isFinite(Date.parse(access.validUntil)) ||
        Date.parse(access.validFrom) > this.now() || Date.parse(access.validUntil) <= this.now() ||
        Date.parse(answer.validUntil) > Date.parse(access.validUntil) ||
        !answer.decision.validUntil || !Number.isFinite(Date.parse(answer.decision.validUntil)) ||
        Date.parse(answer.decision.validUntil) < Date.parse(answer.validUntil) ||
        Date.parse(answer.validUntil) > Date.parse(cycle.endsAt)))
      throw new EngineError('ACCOUNT_CHANGED', 'The account service did not return a current Individual billing period for this work. Nothing was sent.', false);
    if (!answer.decision.admitted) {
      if (scope.kind === 'organization') await this.session.confirmDowngrade(scope.id, answer.decision.code);
      else await this.session.confirmPersonalDowngrade(answer.decision.code);
      this.assertScope(work.projectId, person, scope);
      // A business with no plan says so in the words for this person's role there (Model B section 7).
      const reason = scope.kind === 'organization' && answer.decision.code === 'agent_not_included' && this.session.entitlement(scope.id)?.state === 'none'
        ? this.businessPlanReason(scope.id) : answer.decision.reason;
      throw admissionRefusal(answer.decision.code, reason);
    }
    if (scope.kind === 'organization') await this.session.confirmAdmitted(scope.id);
    else await this.session.confirmPersonalAdmitted();
    this.assertScope(work.projectId, person, scope);
    // Pay as you go (DIO-223): the amount this admission's own access read carried, for the local guard. Never for a plan holder
    // or a business, and not guessed when the service did not send it.
    const bought = scope.kind === 'individual' && answer.decision.planId === null && this.paysAsYouGo(scope)
      ? this.individualAccess?.value.boughtAvailable : undefined;
    return { admissionId: answer.admissionId, organizationId: answer.pins.organizationId, scope, personId: person,
      planId: answer.pins.planId, policyRevision: answer.pins.policyRevision, routeKind: work.routeKind ?? 'byo', surface: work.surface,
      validUntil: answer.validUntil, ...(cycle ? { billingCycle: cycle } : {}), ...(bought === undefined ? {} : { boughtAvailable: bought }) };
  }
  async preference(projectId: string | null) {
    await this.refresh(projectId);
    const scope = this.scopeFor(projectId), person = this.current();
    if (!scope) throw new EngineError('ACCOUNT_CHANGED', 'Choose an authorized account.', false);
    const snapshot = await this.session.call(token => this.session.backend.client.scopedRoutingPolicy(token, scope));
    this.assertScope(projectId, person, scope);
    const preference = await this.session.call(token => this.session.backend.client.routingPreference(token, scope));
    this.assertScope(projectId, person, scope);
    return { scope, canEdit: snapshot.canEditPreferences, preference,
      routing: this.policy(projectId) };
  }
  async accept(projectId: string | null, input: RoutingPreferenceWrite) {
    const scope = this.scopeFor(projectId), person = this.current();
    if (!scope || routingScopeKey(scope) !== routingScopeKey(input.scope)) throw new EngineError('ACCOUNT_CHANGED', 'Refresh this account before saving.', false);
    const preference = await this.session.call(token => this.session.backend.client.acceptRoutingPreference(token, input));
    this.policies.delete(routingScopeKey(scope));
    this.assertScope(projectId, person, scope);
    return preference;
  }
}
