/** Scoped extensions of the existing commercial policy, catalogue and customer setup authority. */
import { z } from 'zod';
import { staffCan, type StaffPermission } from '../../../shared/access.js';
import { CREDIT_MICRO_USD, micro, periodIdFor } from '../../../shared/managed-usage.js';
import { decideAgentAdmission, snapshotFromView } from '../contract/contract.js';
import {
  PRIVATE_RESTRICTIONS, ROUTING_TIERS, bindingProblems, routingScopeKey, routingPreferenceSchema, routingPreferenceWriteSchema,
  scopedPublicationSchema, scopedRollbackSchema, resolveRoutingCandidates,
  type AccountScope, type IndividualAccount, type RoutingPreference, type RoutingScope,
  type RoutingConfiguration, type RequestEnvelope, type ResolvedRoutingSnapshot,
  type HardRestrictions,
} from '../../../shared/routing-policy.js';
import type { AccountService } from './account-service.js';
import { AccountError } from './errors.js';
import { approvedConnections, connectionCredential, connectionView, supportsReasoningSummaries } from './managed-bindings.js';
import type { CommercialRepository, CommercialTransaction, Operator, TierPolicy } from './commercial.js';
import { entitlementFromGrants, individualEntitlement, agentAdmissionInput, featureGrantSchema, revokeGrantInput, ensureIndividualAccount } from './commercial.js';
import type { FundingService } from './funding.js';

/** Implemented on the same transaction as route/policy/grant writes, in Postgres and the faux store. */
export interface RoutingTransaction {
  individual(id: string): Promise<IndividualAccount | undefined>;
  individualFor(personId: string): Promise<IndividualAccount | undefined>;
  individuals(query: string, limit: number): Promise<IndividualAccount[]>;
  saveIndividual(row: IndividualAccount): Promise<void>;
  /** Lock the scope's authority row and read current membership/state, never infer it from a plan. */
  scopeRole(scope: AccountScope, personId: string): Promise<'owner' | 'admin' | 'member' | null>;
  routingPreference(scopeKey: string): Promise<RoutingPreference | undefined>;
  saveRoutingPreference(row: RoutingPreference): Promise<void>;
  /** Monotone union of source restrictions for this root job and all its helpers/attempts. */
  restrictJob(scopeKey: string, jobId: string, restrictions: readonly HardRestrictions[]): Promise<HardRestrictions[]>;
  circuit(routeId: string, routeRevision: number): Promise<{ until: string; reason: string } | undefined>;
  saveCircuit(routeId: string, routeRevision: number, until: string, reason: string): Promise<void>;
}

export const preferenceInputSchema = routingPreferenceWriteSchema;
export const defaultEnvelope = (): RequestEnvelope => ({ inputTokens: 1, outputTokens: 1, tools: true, images: false, reasoning: false, nativeRouteId: null });
export const individualAgreementInput = z.strictObject({ reference: z.string().trim().min(1).max(200),
  validUntil: z.iso.datetime(), credits: z.number().int().min(1).max(100_000) });

/** Identity and commercial isolation used by both customer policy reads and funded dispatch. */
export async function authorizeScope(accounts: Pick<AccountService, 'signIn'>, repository: CommercialRepository, token: string, scope: AccountScope) {
  const actor = await accounts.signIn(token);
  return repository.transaction(async tx => {
    const role = await tx.scopeRole(scope, actor.person.id);
    if (!role) throw new AccountError(403, 'This account is unavailable to this person.', 'scope_forbidden');
    const row = scope.kind === 'organization' ? await tx.organizationRecord(scope.id) : await tx.individual(scope.id);
    if (!row) throw new AccountError(403, 'This account is unavailable to this person.', 'scope_forbidden');
    return { person: actor.person, role, scope, tenantId: row.tenantId };
  });
}

/** Absence of an override inherits; a saved reset explicitly inherits. No other failure does. */
export async function effectivePolicy(tx: CommercialTransaction, scope: AccountScope) {
  const global = await tx.policy();
  const own = await tx.policy(undefined, routingScopeKey(scope));
  const inherited = !own || own.inherit === true;
  return { global, own, effective: inherited ? global : own, inherited,
    globalRevision: global?.revision ?? 0, scopeRevision: own?.revision ?? 0,
    preference: await tx.routingPreference(routingScopeKey(scope)) };
}

/** A failed model is cooled down independently; a later funded request is its recovery check. */
export async function routesWithCircuits(tx: CommercialTransaction, now: number) {
  const routes = await tx.routes();
  return Promise.all(routes.map(async route => {
    const circuit = await tx.circuit(route.id, route.revision);
    if (!route.binding || !circuit || Date.parse(circuit.until) <= now) return route;
    return { ...route, binding: { ...route.binding, health: { ...route.binding.health,
      state: 'open' as const, cooldownUntil: circuit.until, reason: circuit.reason } } };
  }));
}

export function legacyRouting(policy: TierPolicy | undefined): RoutingConfiguration {
  const tierRouting = (tier: typeof ROUTING_TIERS[number]): RoutingConfiguration[typeof tier] => ({
    primary: policy?.tiers[tier]?.entryId ?? null, backups: [], fallbackEnabled: false, maxAttempts: 1,
    cost: { sameOrLower: true, maxAttemptMicroUsd: null, qualityFloor: 0 },
  });
  return { efficient: tierRouting('efficient'), focused: tierRouting('focused'), thorough: tierRouting('thorough') };
}

export class RoutingService {
  constructor(private readonly accounts: AccountService, private readonly repository: CommercialRepository, private readonly now = Date.now, private readonly funding: FundingService | null = null) {}
  private at() { return new Date(this.now()).toISOString(); }
  private async operator(tx: CommercialTransaction, personId: string, permission: StaffPermission): Promise<Operator> {
    await tx.lockStaff();
    const actor = await tx.operator(personId);
    if (!actor || actor.state !== 'active' || !staffCan(actor.role, permission)) throw new AccountError(403, 'This staff role cannot perform this action.');
    return actor;
  }
  private async exists(tx: CommercialTransaction, scope: RoutingScope) {
    if (scope.kind === 'global') return;
    const row = scope.kind === 'organization' ? await tx.organizationRecord(scope.id) : await tx.individual(scope.id);
    if (!row) throw new AccountError(404, 'That account was not found.');
  }
  private async individualForWrite(tx: CommercialTransaction, id: string) {
    const account = await tx.individual(id);
    if (!account) throw new AccountError(404, 'That Individual account was not found.');
    // Match grant-first provisioning: always lock the person before the account.
    await tx.lockPerson(account.personId);
    await tx.lockOrganization(id);
    return account;
  }
  async individual(token: string) {
    const actor = await this.accounts.signIn(token);
    return this.repository.transaction(tx => ensureIndividualAccount(tx, actor.person, this.at()));
  }
  async preference(token: string, scope: AccountScope) {
    await authorizeScope(this.accounts, this.repository, token, scope);
    return this.repository.transaction(tx => tx.routingPreference(routingScopeKey(scope))).then(v => v ?? null);
  }
  async access(token: string, scope: AccountScope) {
    const actor = await authorizeScope(this.accounts, this.repository, token, scope);
    return this.repository.transaction(async tx => {
      if (!await tx.scopeRole(scope, actor.person.id)) throw new AccountError(403, 'Account access was withdrawn.');
      return scope.kind === 'individual' ? individualEntitlement(tx, scope.id, actor.person.id, this.at())
        : entitlementFromGrants(await tx.grants(scope.id), await tx.accessRevision(scope.id), this.at());
    });
  }
  async admit(token: string, scope: AccountScope, raw: unknown) {
    const input = agentAdmissionInput.parse(raw), actor = await authorizeScope(this.accounts, this.repository, token, scope);
    return this.repository.transaction(async tx => {
      if (!await tx.scopeRole(scope, actor.person.id)) throw new AccountError(403, 'Account access was withdrawn.');
      const at = this.at();
      const view = scope.kind === 'individual' ? await individualEntitlement(tx, scope.id, actor.person.id, at)
        : entitlementFromGrants(await tx.grants(scope.id), await tx.accessRevision(scope.id), at);
      const revision = view.revision, policy = await effectivePolicy(tx, scope);
      const included = decideAgentAdmission({ workspace: scope.kind === 'individual' ? 'personal' : 'business', member: true,
        entitlement: snapshotFromView(view), ...(scope.kind === 'individual' ? { individual: snapshotFromView(view) } : {}), at });
      const decision = included.admitted && input.routeKind === 'managed' && !view.managedInference
        ? { admitted: false as const, code: 'managed_inference_not_included', reason: 'This account does not include managed AI usage. Nothing was sent.' } : included;
      const record = { id: `agent_admission_${crypto.randomUUID()}`, at, tenantId: actor.tenantId,
        personId: actor.person.id, surface: input.surface, routeKind: input.routeKind, decision: decision.admitted ? 'admitted' as const : 'refused' as const,
        code: decision.admitted ? null : decision.code, planId: view.plan === 'none' ? null : view.plan,
        accessRevision: revision, policyRevision: policy.effective?.revision ?? 0, rootJobId: input.rootJobId ?? null };
      if (scope.kind === 'individual') await tx.savePersonalAdmission({ ...record, billingAccountId: scope.id });
      else await tx.saveAdmission({ ...record, organizationId: scope.id });
      return { admissionId: record.id, decision, pins: { scope, organizationId: scope.kind === 'organization' ? scope.id : null, tenantId: actor.tenantId, personId: actor.person.id,
        planId: record.planId, accessRevision: revision, policyRevision: record.policyRevision, rootJobId: record.rootJobId }, validUntil: new Date(this.now() + 60_000).toISOString() };
    });
  }
  async individuals(token: string, query: string) {
    const person = (await this.accounts.signIn(token)).person;
    return this.repository.transaction(async tx => {
      await this.operator(tx, person.id, 'customers.read');
      const rows = [];
      for (const account of await tx.individuals(query.trim().toLowerCase().slice(0, 100), 200))
        rows.push({ account, entitlement: await individualEntitlement(tx, account.id, account.personId, this.at()) });
      return rows;
    });
  }
  async individualDetail(token: string, id: string) {
    const person = (await this.accounts.signIn(token)).person;
    const detail = await this.repository.transaction(async tx => {
      await this.operator(tx, person.id, 'customers.read');
      const account = await tx.individual(id); if (!account) throw new AccountError(404, 'That Individual account was not found.');
      const grants = await tx.grants(id);
      return { account, grants, entitlement: await individualEntitlement(tx, id, account.personId, this.at()),
        admissions: await tx.personalAdmissions(account.personId, 50) };
    });
    return detail;
  }
  /** Reuse Billing's explicit service-agreement grant and existing funded-period authority. */
  async issueIndividualAgreement(token: string, id: string, raw: unknown) {
    const input = individualAgreementInput.parse(raw), person = (await this.accounts.signIn(token)).person;
    if (!this.funding) throw new AccountError(503, 'The funding writer is not configured.');
    if (Date.parse(input.validUntil) <= this.now()) throw new AccountError(422, 'The agreement must end in the future.');
    const grant = await this.repository.transaction(async tx => {
      const account = await this.individualForWrite(tx, id);
      const actor = await this.operator(tx, person.id, 'grants.write'); await this.operator(tx, person.id, 'funding.write');
      if (account.state !== 'active') throw new AccountError(404, 'That Individual account is unavailable.');
      const existing = (await tx.grants(id)).find(g => g.source === 'service-agreement' && g.reference === input.reference);
      if (existing) {
        if (existing.state !== 'active' || existing.validUntil !== input.validUntil) throw new AccountError(409, 'This agreement reference has different recorded terms.');
        return existing;
      }
      const row = featureGrantSchema.parse({ v: 1, id: `grant_${crypto.randomUUID()}`, organizationId: id, tenantId: account.tenantId,
        planId: null, features: ['managed-inference'], source: 'service-agreement', reference: input.reference,
        note: 'Managed usage agreement. Personal Agent access is granted separately to the person.', validFrom: this.at(), validUntil: input.validUntil,
        state: 'active', issuedAt: this.at(), issuedBy: person.id, revokedAt: null, revokedBy: null, revokedReason: null });
      await tx.saveGrant(row); await tx.bumpAccessRevision(id, account.tenantId);
      await tx.audit({ id: `audit_${crypto.randomUUID()}`, at: this.at(), actorPersonId: person.id, actorRole: actor.role,
        action: 'grant.issued', organizationId: null, targetKind: 'grant', targetId: row.id, reason: input.reference,
        detail: { scope: { kind: 'individual', id }, grantId: row.id, credits: input.credits, validUntil: input.validUntil } });
      return row;
    });
    const period = await this.funding.allocateAgreementPeriod({ tenantId: grant.tenantId, organizationId: id,
      periodId: periodIdFor(this.at()), sourceGrantId: grant.id, amountMicroUsd: micro(input.credits * CREDIT_MICRO_USD) });
    return { grant, period };
  }
  async revokeIndividualAgreement(token: string, id: string, grantId: string, raw: unknown) {
    const input = revokeGrantInput.parse(raw), person = (await this.accounts.signIn(token)).person;
    return this.repository.transaction(async tx => {
      await this.individualForWrite(tx, id);
      const actor = await this.operator(tx, person.id, 'grants.write');
      const account = await tx.individual(id), grant = (await tx.grants(id)).find(g => g.id === grantId);
      if (!account || !grant) throw new AccountError(404, 'That Individual agreement was not found.');
      if (grant.state === 'revoked') return grant;
      const row = { ...grant, state: 'revoked' as const, revokedAt: this.at(), revokedBy: person.id, revokedReason: input.reason };
      await tx.saveGrant(row); await tx.bumpAccessRevision(id, account.tenantId);
      await tx.audit({ id: `audit_${crypto.randomUUID()}`, at: this.at(), actorPersonId: person.id, actorRole: actor.role,
        action: 'grant.revoked', organizationId: null, targetKind: 'grant', targetId: row.id, reason: input.reason,
        detail: { scope: { kind: 'individual', id } } });
      return row;
    });
  }
  async acceptPreference(token: string, raw: unknown) {
    const input = preferenceInputSchema.safeParse(raw);
    if (!input.success) throw new AccountError(422, 'Choose a routing profile and explicitly accept its current disclosure.');
    const actor = await this.accounts.signIn(token);
    return this.repository.transaction(async tx => {
      await tx.lockOrganization(input.data.scope.id);
      const role = await tx.scopeRole(input.data.scope, actor.person.id);
      if (role !== 'owner' && role !== 'admin') throw new AccountError(403, 'An active account owner or administrator must accept routing preferences.');
      const current = await tx.routingPreference(routingScopeKey(input.data.scope));
      if ((current?.revision ?? 0) !== input.data.baseRevision) throw new AccountError(409, 'The routing preference changed. Read it before accepting again.');
      const { baseRevision, acknowledge: _acknowledge, ...fields } = input.data;
      const row = routingPreferenceSchema.parse({ ...fields, v: 1, revision: baseRevision + 1, acceptedBy: actor.person.id, acceptedAt: this.at() });
      await tx.saveRoutingPreference(row);
      return row;
    });
  }
  async view(token: string, scope: RoutingScope, env: Readonly<Record<string, unknown>>) {
    const person = (await this.accounts.signIn(token)).person;
    return this.repository.transaction(async tx => {
      await this.operator(tx, person.id, 'customers.read'); await this.exists(tx, scope);
      const key = routingScopeKey(scope), global = await tx.policy(), policy = await tx.policy(undefined, key);
      const preference = scope.kind === 'global' ? null : (await tx.routingPreference(key)) ?? null;
      const connections = approvedConnections(env);
      const effective = policy && !policy.inherit ? policy : global;
      return { scope, policy: policy ?? null, globalPolicy: global ?? null, inherited: scope.kind !== 'global' && (!policy || policy.inherit === true),
        preference, routing: effective?.routing ?? legacyRouting(effective), history: await tx.policies(50, key),
        routes: await routesWithCircuits(tx, this.now()), connections: connections.map(c => connectionView(c, env)) };
    });
  }
  async snapshot(token: string, scope: AccountScope, env: Readonly<Record<string, unknown>>): Promise<ResolvedRoutingSnapshot> {
    const actor = await authorizeScope(this.accounts, this.repository, token, scope);
    return this.repository.transaction(async tx => {
      if (!await tx.scopeRole(scope, actor.person.id)) throw new AccountError(403, 'This account access was withdrawn.');
      const state = await effectivePolicy(tx, scope), routes = await routesWithCircuits(tx, this.now());
      const connections = approvedConnections(env).filter(c => connectionCredential(c, env));
      const tiers = {} as ResolvedRoutingSnapshot['tiers'], exclusions = {} as ResolvedRoutingSnapshot['exclusions'];
      for (const tier of ROUTING_TIERS) {
        const configured = (state.effective?.routing ?? legacyRouting(state.effective))[tier];
        if (!state.effective?.routing || !state.preference) {
          tiers[tier] = null; exclusions[tier] = [{ routeId: configured.primary ?? '', reasons: [{ code: 'routing_setup_required', message: 'A versioned route policy and accepted account privacy profile are required.' }] }]; continue;
        }
        const selected = resolveRoutingCandidates({ routes, connections, policy: configured, preference: state.preference,
          mandatory: state.global?.mandatory ?? PRIVATE_RESTRICTIONS, sourceRestrictions: [], tier, envelope: defaultEnvelope(), now: this.now() });
        const entry = selected.candidates[0]?.route, binding = entry?.binding;
        const catalogEntry = entry && routes.find(r => r.id === entry.id);
        tiers[tier] = entry && binding && catalogEntry ? { entryId: entry.id, entryRevision: entry.revision, model: entry.model,
          label: catalogEntry.label, provider: entry.provider, price: binding.price, capabilities: binding.capabilities,
          reasoningSummaries: supportsReasoningSummaries(catalogEntry, selected.candidates[0].connection), guardPrices: selected.candidates.map(c => c.route.binding!.price),
          fallbackEnabled: configured.fallbackEnabled, maxAttempts: configured.maxAttempts } : null;
        exclusions[tier] = selected.excluded;
      }
      return { protocol: 'nectovia-managed/2', legacy: scope.kind === 'organization' && !state.effective?.routing && !state.own && !state.preference,
        canEditPreferences: actor.role === 'owner' || actor.role === 'admin', scope, revision: state.effective?.revision ?? 0,
        globalRevision: state.globalRevision, scopeRevision: state.scopeRevision, preferenceRevision: state.preference?.revision ?? 0,
        inherited: state.inherited, profile: state.preference?.profile ?? null, checkedAt: this.at(),
        validUntil: new Date(this.now() + 60_000).toISOString(), tiers, exclusions };
    });
  }
  private async previewIn(tx: CommercialTransaction, input: z.infer<typeof scopedPublicationSchema>, env: Readonly<Record<string, unknown>>) {
    await this.exists(tx, input.scope);
    const global = await tx.policy(), current = await tx.policy(undefined, routingScopeKey(input.scope));
    if ((current?.revision ?? 0) !== input.baseRevision || (global?.revision ?? 0) !== input.baseGlobalRevision)
      throw new AccountError(409, 'The scope or global policy changed. Refresh and preview again.');
    if (input.scope.kind === 'global' && input.routing === null) throw new AccountError(422, 'Global policy cannot inherit.');
    const routes = await routesWithCircuits(tx, this.now()), connections = approvedConnections(env).filter(c => connectionCredential(c, env));
    for (const tier of ROUTING_TIERS) for (const id of input.routing ? [input.routing[tier].primary, ...input.routing[tier].backups] : []) {
      if (id === null) continue;
      const r = routes.find(r => r.id === id), c = connections.find(c => c.id === r?.binding?.connectionId);
      if (!r || r.status !== 'qualified' || !r.binding || !c || !connectionCredential(c, env) || bindingProblems(r, c).length)
        throw new AccountError(422, `Route ${id} is unavailable or its connection is not ready.`);
      const b = r.binding, now = this.now();
      if (!b.qualification || !b.qualification.tiers.includes(tier) || Date.parse(b.qualification.validUntil) <= now ||
          !b.access || b.access.state !== 'ready' || b.access.availableRequests === 0 || Date.parse(b.access.validUntil) <= now ||
          !b.privacy || Date.parse(b.privacy.validUntil) <= now || b.privacy.connectionRevision !== c.revision ||
          b.privacy.modelVersion !== b.modelVersion || b.privacy.protocol !== b.protocol ||
          b.health.state !== 'healthy' || Date.parse(b.health.validUntil) <= now || Date.parse(b.price.validUntil) <= now || Date.parse(b.price.observedAt) > now)
        throw new AccountError(422, `Route ${id} needs current qualification, access, privacy, health and price evidence before publication.`);
    }
    const scopes: AccountScope[] = input.scope.kind === 'global'
      ? [...(await tx.organizations('', 10_000)).map(r => ({ kind: 'organization' as const, id: r.organization.id })),
        ...(await tx.individuals('', 10_000)).map(r => ({ kind: 'individual' as const, id: r.id }))] : [input.scope];
    const affected = [];
    for (const scope of scopes) {
      const key = routingScopeKey(scope), override = await tx.policy(undefined, key);
      if (input.scope.kind === 'global' && override && !override.inherit) continue;
      const access = entitlementFromGrants(await tx.grants(scope.id), await tx.accessRevision(scope.id), this.at());
      const preference = await tx.routingPreference(key), routing = input.routing ?? global?.routing;
      const tiers = Object.fromEntries(ROUTING_TIERS.map(tier => [tier, preference && routing
        ? resolveRoutingCandidates({ routes, connections, preference, mandatory: global?.mandatory ?? PRIVATE_RESTRICTIONS,
          sourceRestrictions: [], tier, policy: routing[tier], envelope: defaultEnvelope(), now: this.now() })
        : { candidates: [], excluded: [{ routeId: '', reasons: [{ code: 'routing_setup_required', message: 'Accepted customer privacy settings are missing.' }] }] }]));
      affected.push({ scope, paid: access.agent && access.managedInference, profile: preference?.profile ?? null,
        tiers: Object.fromEntries(ROUTING_TIERS.map(t => [t, { eligible: tiers[t].candidates.map(c => c.route.id), excluded: tiers[t].excluded }])) });
    }
    return { scope: input.scope, baseRevision: current?.revision ?? 0, baseGlobalRevision: global?.revision ?? 0, affected };
  }
  async preview(token: string, raw: unknown, env: Readonly<Record<string, unknown>>) {
    const input = scopedPublicationSchema.parse(raw), actor = await this.accounts.signIn(token);
    return this.repository.transaction(async tx => { await this.operator(tx, actor.person.id, 'policy.publish'); return this.previewIn(tx, input, env); });
  }
  async publish(token: string, raw: unknown, env: Readonly<Record<string, unknown>>, rollback = false) {
    const actor = await this.accounts.signIn(token);
    const request = rollback ? scopedRollbackSchema.parse(raw) : scopedPublicationSchema.parse(raw);
    return this.repository.transaction(async tx => {
      await tx.lockPolicy();
      const operator = await this.operator(tx, actor.person.id, 'policy.publish');
      const key = routingScopeKey(request.scope);
      const restored = 'toRevision' in request ? await tx.policy(request.toRevision, key) : undefined;
      if ('toRevision' in request && (!restored || !restored.routing && !restored.inherit)) throw new AccountError(422, 'That revision has no versioned route configuration.');
      const publication = 'toRevision' in request ? (() => { const { toRevision: _target, ...rest } = request;
        return { ...rest, routing: restored!.inherit ? null : restored!.routing }; })() : request;
      const input = scopedPublicationSchema.parse(publication);
      const preview = await this.previewIn(tx, input, env);
      // A scope-specific override must have a primary permitted by its actual customer's profile.
      if (input.scope.kind !== 'global' && input.routing !== null && preview.affected.some(a => ROUTING_TIERS.some(t => input.routing![t].primary !== null && !a.tiers[t].eligible.includes(input.routing![t].primary!))))
        throw new AccountError(422, 'The override primary conflicts with this account privacy or capability requirements. Review the exclusions.');
      const routes = await tx.routes(), global = await tx.policy();
      const row: TierPolicy = { v: 1, scope: input.scope, revision: input.baseRevision + 1, routing: input.routing ?? undefined,
        inherit: input.routing === null, mandatory: input.scope.kind === 'global' ? global?.mandatory ?? PRIVATE_RESTRICTIONS : undefined,
        tiers: Object.fromEntries(ROUTING_TIERS.map(t => { const r = routes.find(r => r.id === input.routing?.[t].primary); return [t, r ? { entryId: r.id, provider: r.provider, model: r.model, label: r.label, entryRevision: r.revision } : null]; })) as TierPolicy['tiers'],
        kind: rollback ? 'rollback' : 'publish', basedOn: restored?.revision ?? input.baseRevision, note: input.note, publishedAt: this.at(), publishedBy: actor.person.id };
      await tx.savePolicy(row);
      await tx.audit({ id: `audit_${crypto.randomUUID()}`, at: this.at(), actorPersonId: actor.person.id, actorRole: operator.role,
        action: rollback ? 'policy.rolled-back' : 'policy.published', organizationId: input.scope.kind === 'organization' ? input.scope.id : null,
        targetKind: 'policy', targetId: key, reason: input.note, detail: { scope: input.scope, revision: row.revision, basedOn: row.basedOn, routing: input.routing } });
      return { policy: row, preview };
    });
  }
}
