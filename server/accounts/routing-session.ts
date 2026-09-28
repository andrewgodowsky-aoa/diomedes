/** Ephemeral, person-and-scope-bound routing cache. The control plane remains authoritative. */
import { z } from 'zod';
import { routingScopeKey, type AccountScope, type IndividualAccount, type RoutingPreferenceWrite } from '../../shared/routing-policy.js';
import type { AccessFeature } from '../../shared/access.js';
import type { EntitlementView } from '../../shared/workspaces.js';
import type { NectoviaPolicy } from '../engines/nectovia.js';
import { EngineError } from '../engines/process.js';
import type { WorkspaceService } from '../workspaces.js';
import type { AccountSessionService } from './session.js';
import type { AdmittedAgentWork, AgentWork } from './agent-gate.js';

const admissionSchema = z.object({ admissionId: z.string().min(1), validUntil: z.iso.datetime(),
  decision: z.discriminatedUnion('admitted', [
    z.object({ admitted: z.literal(true), planId: z.string().nullable(), revision: z.number().int(), validUntil: z.string().nullable() }),
    z.object({ admitted: z.literal(false), code: z.string(), reason: z.string() }),
  ]),
  pins: z.object({ scope: z.object({ kind: z.enum(['organization', 'individual']), id: z.string() }),
    organizationId: z.string().nullable(), tenantId: z.string(), personId: z.string(), planId: z.string().nullable(),
    accessRevision: z.number().int(), policyRevision: z.number().int(), rootJobId: z.string().nullable() }),
});

export class AccountRoutingSession {
  private person: string | null = null;
  private individual: IndividualAccount | null = null;
  private individualAccess: { value: EntitlementView; until: number } | null = null;
  private policies = new Map<string, { value: NectoviaPolicy; until: number }>();
  constructor(private readonly session: AccountSessionService,
    private readonly workspaces: Pick<WorkspaceService, 'projectOwner' | 'active'>, private readonly now = Date.now) {}

  invalidate() { this.policies.clear(); this.individualAccess = null; this.current(); }

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
    this.individualAccess = { value: access, until: this.now() + 60_000 };
  }

  private current() {
    const person = this.session.personId();
    if (person !== this.person) { this.person = person; this.individual = null; this.individualAccess = null; this.policies.clear(); }
    return person;
  }
  scopeFor(projectId: string | null): AccountScope | null {
    if (!this.current()) return null;
    const owner = projectId === null ? null : this.workspaces.projectOwner(projectId);
    if (owner) return { kind: 'organization', id: owner.organizationId };
    const active = this.workspaces.active();
    if (active.kind === 'business') return projectId === null ? { kind: 'organization', id: active.organizationId } : null;
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
      : { revision: snapshot.revision, tiers: snapshot.tiers, resolved: snapshot };
    this.assertScope(projectId, person, scope);
    if (!this.individualAccess || this.individualAccess.until <= this.now() || scope.kind === 'individual') await this.refreshAccess();
    this.assertScope(projectId, person, scope);
    this.policies.set(key, { value, until: Math.min(Date.parse(snapshot.validUntil), this.now() + 60_000) });
    return value;
  }
  /** Route selection only. Unknown/stale access requires fresh admission instead of
   * silently switching a previously paid Individual conversation to another payer. */
  mayHaveAgent(scope: AccountScope) {
    if (scope.kind === 'organization') return this.session.entitlement(scope.id)?.state === 'unknown' || this.session.includes(scope.id, 'nectovia-agent');
    if (!this.current() || scope.id !== this.individual?.id) return false;
    return !this.individualAccess || this.individualAccess.until <= this.now() || this.includes(scope, 'nectovia-agent');
  }
  includes(scope: AccountScope, feature: AccessFeature) {
    if (scope.kind === 'organization') return this.session.includes(scope.id, feature);
    return this.current() !== null && scope.id === this.individual?.id && !!this.individualAccess &&
      this.individualAccess.until > this.now() && this.individualAccess.value.state === 'active' &&
      (this.individualAccess.value.validUntil === null || Date.parse(this.individualAccess.value.validUntil) > this.now()) &&
      this.individualAccess.value.features.includes(feature);
  }
  async admit(work: AgentWork): Promise<AdmittedAgentWork> {
    await this.refresh(work.projectId);
    const scope = this.scopeFor(work.projectId), person = this.current();
    if (!scope || !person) throw new EngineError('AGENT_NOT_INCLUDED', 'This work has no authorized account. Nothing was sent.', false);
    const raw = await this.session.call(token => this.session.backend.client.admitScopedAgent(token, scope,
      { surface: work.surface, routeKind: work.routeKind ?? 'byo', rootJobId: work.rootJobId }));
    this.assertScope(work.projectId, person, scope);
    const parsed = admissionSchema.safeParse(raw);
    if (!parsed.success || this.current() !== person || parsed.data.pins.personId !== person || parsed.data.pins.scope.kind !== scope.kind ||
        parsed.data.pins.scope.id !== scope.id || parsed.data.pins.organizationId !== (scope.kind === 'organization' ? scope.id : null) ||
        (scope.kind === 'individual' && parsed.data.pins.tenantId !== person) || parsed.data.pins.rootJobId !== work.rootJobId ||
        Date.parse(parsed.data.validUntil) <= this.now())
      throw new EngineError('ACCOUNT_CHANGED', 'The account service did not return a current admission for this work. Nothing was sent.', false);
    const answer = parsed.data;
    if (!answer.decision.admitted) throw new EngineError('AGENT_NOT_INCLUDED', answer.decision.reason, false);
    return { admissionId: answer.admissionId, organizationId: answer.pins.organizationId, scope, personId: person,
      planId: answer.pins.planId, policyRevision: answer.pins.policyRevision, routeKind: work.routeKind ?? 'byo', surface: work.surface,
      validUntil: answer.validUntil };
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
