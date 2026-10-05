/**
 * Customer access, company routing and staff administration (Andrew, 2026-09-25).
 *
 * Three records, each with one writer:
 *
 *   - **Feature grants** — what a business may use (the Nectovia Agent, maintained
 *     profiles, included usage), from which source, until when. Issued by Billing
 *     staff or, later, by the verified subscription path. Never by a customer, and
 *     never inferred from a connected provider.
 *   - **The route registry and tier policy** — which qualified company route and
 *     model serve Efficient, Focused and Thorough. Published as numbered
 *     revisions by Routing staff; customers only ever choose a tier. Nothing here
 *     holds a credential.
 *   - **Staff operators** — Diomedes employees and their company role. A
 *     customer's Business owner is never an operator by virtue of that role.
 *
 * Funding (credits, top-ups, reservations) stays the FundingService's; this
 * module only asks it to allocate a month or record a noted correction.
 * Every staff write is audited in the same transaction as the change.
 */
import { z } from 'zod';
import {
  ACCESS_FEATURES,
  AGENT_FEATURE,
  GRANT_SOURCES,
  ROLE_CAPABILITIES,
  STAFF_ROLES,
  planLabel,
  planTemplate,
  roleLabel,
  staffCan,
  type AccessFeature,
  type AccessState,
  type GrantSummary,
  type StaffPermission,
  type StaffRole,
} from '../../../shared/access.js';
import {
  AGENT_PERSONAL_INDIVIDUAL_REASON,
  BUSINESS_PLAN_NOT_FOR_PERSON,
  INDIVIDUAL_EXPIRED_REASON,
  INDIVIDUAL_NONE_REASON,
  INDIVIDUAL_PLAN_NOT_FOR_BUSINESS,
  INDIVIDUAL_REVOKED_REASON,
  catalogPlan,
  catalogPlanLabel,
  isPersonPlan,
  individualIncludesMonthlyCredits,
  planCatalog,
  type IndividualCoverage,
  type CoveredAccessView,
  type PersonAccessView,
  type PersonGrantSummary,
  type PersonalUsageView,
} from '../../../shared/individual-plan.js';
import {
  INDIVIDUAL_CYCLE_POLICY,
  MAX_INDIVIDUAL_CYCLE_INDEX,
  cycleContains,
  individualCycle,
  periodsOverlap,
  sameIndividualCycle,
  verifiedIndividualCycle,
  type IndividualBillingCycle,
} from '../../../shared/individual-period.js';
import { MODEL_API_PROVIDERS as MODEL_API_ROUTES } from '../../../shared/model-api.js';
import { CREDIT_MICRO_USD, creditAmount, periodIdFor, publishedMonthlyGrant, type UsageState } from '../../../shared/managed-usage.js';
import { NO_ENTITLEMENT_VIEW, type EntitlementView, type Membership, type Organization, type Person } from '../../../shared/workspaces.js';
import { decideAgentAdmission, snapshotFromView, type AgentAdmissionDecision } from '../contract/contract.js';
import type { AccountService } from './account-service.js';
import { accountId, NO_IDENTITY_DIRECTORY, type IdentityDirectory } from './domain.js';
import { AccountError } from './errors.js';
import { modelBindingSchema, routingScopeSchema, routingConfigurationSchema, hardRestrictionsSchema, bindingProblems, type IndividualAccount } from '../../../shared/routing-policy.js';
import type { RoutingTransaction } from './routing.js';
import { approvedConnections } from './managed-bindings.js';
import { registryRow } from './managed-providers.js';
import type { FundingService } from './funding.js';

export const COMMERCIAL_VERSION = 1 as const;

/** Reuse this in paid-plan provisioning before grants, even if setup has never opened.
 * The caller supplies a verified person inside its commercial transaction. Creation grants no access or credits. */
export async function ensureIndividualAccount(tx: CommercialTransaction, person: Pick<Person, 'id' | 'name'>, at: string) {
  await tx.lockPerson(person.id);
  const current = await tx.individualFor(person.id);
  if (current) return current;
  const row: IndividualAccount = { id: `individual_${crypto.randomUUID()}`, tenantId: person.id,
    personId: person.id, name: person.name, state: 'active', createdAt: at };
  await tx.saveIndividual(row);
  return row;
}

/** The three tiers, restated so the Worker bundle does not load the UI's work-style module. */
export const POLICY_TIERS = ['efficient', 'focused', 'thorough'] as const;
export type PolicyTier = (typeof POLICY_TIERS)[number];

const time = z.iso.datetime();
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const text = (max: number) => z.string().trim().max(max);
const routeEntryId = z.string().regex(/^[a-z0-9][a-z0-9.:_-]{0,127}$/);

// --- records ---------------------------------------------------------------------

export const featureGrantSchema = z.strictObject({
  v: z.literal(1),
  id: accountId,
  organizationId: accountId,
  tenantId: accountId,
  planId: z.string().max(64).nullable(),
  features: z.array(z.enum(ACCESS_FEATURES)).min(1).max(ACCESS_FEATURES.length),
  source: z.enum(GRANT_SOURCES),
  /** The invoice, agreement or ticket this grant answers to. */
  reference: text(200),
  note: text(1000),
  validFrom: time,
  validUntil: time,
  state: z.enum(['active', 'revoked']),
  issuedAt: time,
  issuedBy: accountId,
  revokedAt: time.nullable(),
  revokedBy: accountId.nullable(),
  revokedReason: text(1000).nullable(),
});
export type FeatureGrant = z.infer<typeof featureGrantSchema>;

/**
 * One verified monthly Individual term (DIO-128). Every field must be exactly what the anchor and
 * index produce, so a stored record cannot carry a hand-edited or drifted boundary.
 */
export const individualCycleSchema = z.strictObject({
  policy: z.literal(INDIVIDUAL_CYCLE_POLICY),
  anchorAt: time,
  index: z.number().int().min(0).max(MAX_INDIVIDUAL_CYCLE_INDEX),
  startsAt: time,
  endsAt: time,
}).refine((cycle) => verifiedIndividualCycle(cycle) !== null, 'A billing period must be the one its anchor and index produce.');

/**
 * An Individual grant (migration 009): what a person, not a business, may use. Issued to a person
 * and never to an organization. A person has no tenant of their own, so their rows use the
 * person's id as the tenant id.
 */
export const personFeatureGrantSchema = z.strictObject({
  v: z.literal(1),
  id: accountId,
  personId: accountId,
  tenantId: accountId,
  planId: z.string().max(64).nullable(),
  features: z.array(z.enum(ACCESS_FEATURES)).min(1).max(ACCESS_FEATURES.length),
  source: z.enum(GRANT_SOURCES),
  reference: text(200),
  note: text(1000),
  validFrom: time,
  validUntil: time,
  state: z.enum(['active', 'revoked']),
  issuedAt: time,
  issuedBy: accountId,
  revokedAt: time.nullable(),
  revokedBy: accountId.nullable(),
  revokedReason: text(1000).nullable(),
  /**
   * The monthly term a complete Individual grant pays for (DIO-128). Absent on grants issued before
   * anniversary periods and on limited overrides, which keep their explicit dates. The validity
   * interval lies inside it; a replacement or recovery grant may start later in the same term.
   */
  billingCycle: individualCycleSchema.optional(),
});
export type PersonFeatureGrant = z.infer<typeof personFeatureGrantSchema>;
/** What access resolution reads from a grant, whoever holds it. */
export type GrantTerms = Pick<FeatureGrant, 'planId' | 'features' | 'state' | 'validFrom' | 'validUntil' | 'issuedAt' | 'revokedAt'>;

export const routeEntrySchema = z.strictObject({
  v: z.literal(1),
  id: routeEntryId,
  provider: z.enum(MODEL_API_ROUTES),
  /** The exact id the route serves: a Bedrock inference profile, an Azure deployment, a Vertex model. */
  model: z.string().trim().min(1).max(200),
  /** What people call it, e.g. "GPT-6 Luna". */
  label: z.string().trim().min(1).max(120),
  region: z.string().trim().max(64).nullable(),
  /** Where data is processed and what the provider may do with it, in words. */
  processing: text(300),
  /** Only a qualified route can be published into a tier. */
  status: z.enum(['qualified', 'unqualified', 'retired']),
  /** What qualified it: a live proof, a run id, a dated account check. */
  evidence: text(1000),
  revision: epoch,
  updatedAt: time,
  updatedBy: accountId,
  binding: modelBindingSchema.optional(),
});
export type RouteEntry = z.infer<typeof routeEntrySchema>;

const resolvedRoute = z.strictObject({
  entryId: routeEntryId,
  provider: z.enum(MODEL_API_ROUTES),
  model: z.string().min(1).max(200),
  label: z.string().min(1).max(120),
  entryRevision: epoch,
});
export type ResolvedRoute = z.infer<typeof resolvedRoute>;

export const tierPolicySchema = z.strictObject({
  v: z.literal(1),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  /** A tier with no route is refused by name, never filled from another tier. */
  tiers: z.strictObject({
    efficient: resolvedRoute.nullable(),
    focused: resolvedRoute.nullable(),
    thorough: resolvedRoute.nullable(),
  }),
  kind: z.enum(['seed', 'publish', 'rollback']),
  basedOn: epoch,
  note: z.string().trim().min(1).max(1000),
  publishedAt: time,
  publishedBy: accountId,
  scope: routingScopeSchema.optional(),
  routing: routingConfigurationSchema.optional(),
  inherit: z.boolean().optional(),
  mandatory: hardRestrictionsSchema.optional(),
});
export type TierPolicy = z.infer<typeof tierPolicySchema>;

export const operatorSchema = z.strictObject({
  v: z.literal(1),
  personId: accountId,
  role: z.enum(STAFF_ROLES),
  state: z.enum(['active', 'disabled']),
  addedAt: time,
  addedBy: accountId,
  updatedAt: time,
  updatedBy: accountId,
});
export type Operator = z.infer<typeof operatorSchema>;

export const AUDIT_ACTIONS = [
  'grant.issued',
  'grant.revoked',
  'funding.allocated',
  'funding.added',
  'route.saved',
  'policy.published',
  'policy.rolled-back',
  'staff.added',
  'staff.changed',
  'person-grant.issued',
  'person-grant.revoked',
  /** One gateway route checks run (DIO-217): the receipt and its spend, on the route it checked. */
  'route.checked',
] as const;
export const auditEventSchema = z.strictObject({
  id: accountId,
  at: time,
  actorPersonId: accountId,
  actorRole: z.enum(STAFF_ROLES),
  action: z.enum(AUDIT_ACTIONS),
  organizationId: accountId.nullable(),
  /** 'person-grant' events carry organizationId null and the person in `detail.personId`. */
  targetKind: z.enum(['grant', 'funding', 'route', 'policy', 'operator', 'person-grant']),
  targetId: z.string().min(1).max(128),
  reason: text(1000),
  detail: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const AGENT_SURFACES = ['conversation', 'work', 'team', 'loop', 'automation', 'ask', 'other'] as const;
export const ROUTE_KINDS = ['managed', 'byo', 'local', 'external-engine'] as const;
export const admissionRecordSchema = z.strictObject({
  id: accountId,
  at: time,
  organizationId: accountId,
  tenantId: accountId,
  personId: accountId,
  surface: z.enum(AGENT_SURFACES),
  routeKind: z.enum(ROUTE_KINDS),
  decision: z.enum(['admitted', 'refused']),
  code: z.string().max(64).nullable(),
  planId: z.string().max(64).nullable(),
  accessRevision: epoch,
  policyRevision: epoch,
  rootJobId: z.string().max(128).nullable(),
  /** Historical attribution only. New Business admissions never use an Individual plan. */
  coverage: z.enum(['plan', 'individual']).optional(),
});
export type AdmissionRecord = z.infer<typeof admissionRecordSchema>;

/** An admission of Personal work under an Individual plan (migration 009). No business is involved. */
export const personalAdmissionRecordSchema = z.strictObject({
  id: accountId,
  at: time,
  personId: accountId,
  /** Present only when admission is bound to the person's explicit billing scope. */
  billingAccountId: accountId.optional(),
  tenantId: accountId,
  surface: z.enum(AGENT_SURFACES),
  routeKind: z.enum(ROUTE_KINDS),
  decision: z.enum(['admitted', 'refused']),
  code: z.string().max(64).nullable(),
  planId: z.string().max(64).nullable(),
  accessRevision: epoch,
  policyRevision: epoch,
  rootJobId: z.string().max(128).nullable(),
});
export type PersonalAdmissionRecord = z.infer<typeof personalAdmissionRecordSchema>;

// --- persistence -------------------------------------------------------------------

/** Database operations only. Never a provider call, never a retry. */
export interface CommercialTransaction extends RoutingTransaction {
  /** Serializes grant writes and access-revision bumps for one organization. */
  lockOrganization(organizationId: string): Promise<void>;
  grants(organizationId: string): Promise<FeatureGrant[]>;
  saveGrant(row: FeatureGrant): Promise<void>;
  accessRevision(organizationId: string): Promise<number>;
  bumpAccessRevision(organizationId: string, tenantId: string): Promise<number>;
  routes(): Promise<RouteEntry[]>;
  saveRoute(row: RouteEntry): Promise<void>;
  /** Serializes policy publication so two publishers cannot both build on one base. */
  lockPolicy(): Promise<void>;
  policy(revision?: number, scopeKey?: string): Promise<TierPolicy | undefined>;
  policies(limit: number, scopeKey?: string): Promise<TierPolicy[]>;
  savePolicy(row: TierPolicy): Promise<void>;
  /** Serializes staff authority checks and role changes, including the last-admin check. */
  lockStaff(): Promise<void>;
  operator(personId: string): Promise<Operator | undefined>;
  operators(): Promise<Operator[]>;
  saveOperator(row: Operator): Promise<void>;
  audit(row: AuditEvent): Promise<void>;
  auditLog(input: { organizationId?: string; limit: number }): Promise<AuditEvent[]>;
  saveAdmission(row: AdmissionRecord): Promise<void>;
  admissions(organizationId: string, limit: number): Promise<AdmissionRecord[]>;
  /** One admission by id, within one tenant. Another tenant's record reads as absent. */
  admission(tenantId: string, id: string): Promise<AdmissionRecord | undefined>;
  // Staff directory reads over the account tables. Reads only; bounded.
  organizations(query: string, limit: number): Promise<{ organization: Organization; activeMembers: number }[]>;
  organizationRecord(id: string): Promise<Organization | undefined>;
  roster(organizationId: string): Promise<{ membership: Membership; person: Person; issuer: string; subject: string }[]>;
  people(query: string, limit: number): Promise<{ person: Person; issuer: string; subject: string; memberships: Membership[] }[]>;
  person(personId: string): Promise<{ person: Person; issuer: string; subject: string } | undefined>;
  // Individual plans (migration 009).
  /** Serializes grant writes and access-revision bumps for one person. */
  lockPerson(personId: string): Promise<void>;
  personGrants(personId: string): Promise<PersonFeatureGrant[]>;
  savePersonGrant(row: PersonFeatureGrant): Promise<void>;
  personAccessRevision(personId: string): Promise<number>;
  bumpPersonAccessRevision(personId: string, tenantId: string): Promise<number>;
  savePersonalAdmission(row: PersonalAdmissionRecord): Promise<void>;
  personalAdmission(tenantId: string, id: string): Promise<PersonalAdmissionRecord | undefined>;
  personalAdmissions(personId: string, limit: number): Promise<PersonalAdmissionRecord[]>;
  /** Active members of one Business, displayed to Operations staff. */
  organizationActiveMembers(organizationId: string): Promise<number>;
  /** Staff audit rows about one person's Individual grants, newest first. */
  personAudit(personId: string, limit: number): Promise<AuditEvent[]>;
}
export interface CommercialRepository {
  transaction<T>(action: (tx: CommercialTransaction) => Promise<T>): Promise<T>;
}

// --- access resolution (pure) --------------------------------------------------------

export function grantState(grant: GrantTerms, at: number): AccessState {
  if (grant.state === 'revoked') return 'revoked';
  if (Date.parse(grant.validUntil) <= at) return 'expired';
  if (Date.parse(grant.validFrom) > at) return 'none';
  return 'active';
}

/**
 * The organization's entitlement at a moment, from its grants. Active when any
 * grant is current; the features are the union of current grants. With none
 * current, the most recent grant decides whether it reads revoked or expired,
 * so a person sees why the Agent stopped rather than a bare "no plan".
 */
export function entitlementFromGrants(grants: readonly GrantTerms[], revision: number, at: string): EntitlementView {
  const when = Date.parse(at);
  const current = grants.filter((grant) => grantState(grant, when) === 'active');
  if (current.length > 0) {
    const features = [...new Set(current.flatMap((grant) => grant.features))].sort() as AccessFeature[];
    const primary = [...current].sort((a, b) =>
      Number(b.features.includes(AGENT_FEATURE)) - Number(a.features.includes(AGENT_FEATURE)) ||
      Date.parse(b.validUntil) - Date.parse(a.validUntil))[0];
    return {
      plan: primary.planId ?? 'custom',
      planLabel: planLabel(primary.planId) ?? 'Custom access',
      state: 'active',
      features,
      agent: features.includes(AGENT_FEATURE),
      managedInference: features.includes('managed-inference'),
      validFrom: primary.validFrom,
      validUntil: primary.validUntil,
      revision,
      source: 'account-service',
      reason: '',
    };
  }
  const base = {
    plan: 'none', planLabel: null, features: [] as string[], agent: false, managedInference: false,
    validFrom: null, validUntil: null, revision, source: 'account-service' as const,
  };
  // Ties (a replacement ending with the term it replaced, say) go to the grant issued last.
  const latest = [...grants].sort((a, b) =>
    Math.max(Date.parse(b.revokedAt ?? b.issuedAt), Math.min(Date.parse(b.validUntil), when)) -
    Math.max(Date.parse(a.revokedAt ?? a.issuedAt), Math.min(Date.parse(a.validUntil), when)) ||
    Date.parse(b.issuedAt) - Date.parse(a.issuedAt))[0];
  if (!latest) return { ...base, state: 'none', reason: 'This business has no Nectovia plan yet.' };
  const state = grantState(latest, when);
  if (state === 'revoked')
    return { ...base, state, validUntil: latest.revokedAt, reason: 'This business’s Nectovia access was withdrawn.' };
  if (state === 'expired')
    return { ...base, state, validUntil: latest.validUntil, reason: 'This business’s Nectovia plan has ended.' };
  return { ...base, state: 'none', validFrom: latest.validFrom, reason: `This business’s plan starts ${latest.validFrom.slice(0, 10)}.` };
}

function summary(grant: GrantTerms & Pick<FeatureGrant, 'id' | 'source'>, at: number): GrantSummary {
  return {
    id: grant.id,
    planId: grant.planId,
    planLabel: planLabel(grant.planId),
    features: grant.features,
    source: grant.source,
    validFrom: grant.validFrom,
    validUntil: grant.validUntil,
    state: grantState(grant, at),
  };
}

function personSummary(grant: PersonFeatureGrant, at: number): PersonGrantSummary {
  return {
    id: grant.id,
    personId: grant.personId,
    planId: grant.planId,
    planLabel: catalogPlanLabel(grant.planId),
    features: grant.features,
    source: grant.source,
    validFrom: grant.validFrom,
    validUntil: grant.validUntil,
    state: grantState(grant, at),
    ...(grant.billingCycle ? { billingCycle: grant.billingCycle } : {}),
  };
}

/**
 * The verified monthly Individual term that funds Personal work at `at`, from the person's current
 * complete-plan grants. Null when none is current, or when only legacy grants without a term are.
 * Grants that name one term share its one balance; two current grants naming different terms are a
 * record conflict and fund nothing. A grant's end date never selects a newer term on its own.
 */
export function currentIndividualCycle(grants: readonly PersonFeatureGrant[], at: number): { cycle: IndividualBillingCycle; grant: PersonFeatureGrant } | null {
  const current = grants
    .filter((grant) => grant.billingCycle && grantState(grant, at) === 'active' && individualIncludesMonthlyCredits(grant) &&
      cycleContains(grant.billingCycle, at) && grant.personId === grant.tenantId)
    .sort((a, b) => (a.issuedAt < b.issuedAt ? -1 : a.issuedAt > b.issuedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!current.length) return null;
  const cycle = verifiedIndividualCycle(current[0].billingCycle);
  if (!cycle || current.some((grant) => !sameIndividualCycle(grant.billingCycle!, cycle))) return null;
  return { cycle, grant: current[0] };
}

/** For Operations: the person's subscription anchor, current term and the next term a renewal would pay for. */
export function individualTerms(grants: readonly PersonFeatureGrant[], at: number) {
  const terms = grants.flatMap((grant) => (grant.billingCycle ? [grant.billingCycle] : []));
  if (!terms.length) return { anchorAt: null, current: null, next: null };
  // The latest anchor is the subscription in force; a restart after a lapse may have set a new one.
  const latest = terms.reduce((a, b) => (Date.parse(b.startsAt) > Date.parse(a.startsAt) ? b : a));
  return {
    anchorAt: latest.anchorAt,
    current: currentIndividualCycle(grants, at)?.cycle ?? null,
    next: individualCycle(latest.anchorAt, latest.index + 1),
  };
}

/** A person's own entitlement from their Individual grants, in the person's words rather than a business's. */
export function personEntitlement(grants: readonly PersonFeatureGrant[], revision: number, at: string): EntitlementView {
  // Project the approved offer over the original phase-2a template. Never mutate historical grants,
  // or broaden a limited feature override merely because it names the Individual plan.
  const view = entitlementFromGrants(grants.map(grant => individualIncludesMonthlyCredits(grant)
    ? { ...grant, features: [...new Set<AccessFeature>([...grant.features, 'managed-inference'])] } : grant), revision, at);
  const planLabel = view.plan === 'none' ? null : view.plan === 'custom' ? 'Custom access' : catalogPlanLabel(view.plan);
  const reason = view.state === 'active' ? '' : view.state === 'expired' ? INDIVIDUAL_EXPIRED_REASON
    : view.state === 'revoked' ? INDIVIDUAL_REVOKED_REASON : INDIVIDUAL_NONE_REASON;
  return { ...view, planLabel, reason };
}

/** Personal access belongs to the person. A full plan or an explicit usage agreement can fund it. */
export async function individualEntitlement(tx: CommercialTransaction, accountId: string, personId: string, at: string): Promise<EntitlementView> {
  const account = await tx.individual(accountId);
  if (!account || account.personId !== personId || account.tenantId !== personId)
    throw new AccountError(403, 'This Individual account is unavailable to this person.', 'scope_forbidden');
  const person = personEntitlement(await tx.personGrants(personId), await tx.personAccessRevision(personId), at);
  const usage = entitlementFromGrants(await tx.grants(accountId), await tx.accessRevision(accountId), at);
  // Operations can inspect disabled accounts and their history; they grant no current authority.
  if (account.state !== 'active') return { ...person, state: 'revoked', agent: false, managedInference: false,
    features: [], revision: person.revision + usage.revision, reason: 'This Individual account is disabled.' };
  const managedInference = person.state === 'active' && person.agent &&
    (person.managedInference || (usage.state === 'active' && usage.managedInference));
  return { ...person, revision: person.revision + usage.revision, managedInference,
    features: [...person.features.filter(feature => feature !== 'managed-inference'), ...(managedInference ? ['managed-inference'] : [])] };
}

// --- inputs ----------------------------------------------------------------------------

export const agentAdmissionInput = z.strictObject({
  surface: z.enum(AGENT_SURFACES),
  routeKind: z.enum(ROUTE_KINDS),
  rootJobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).nullable().optional(),
});
export const issueGrantInput = z.strictObject({
  planId: z.string().max(64).nullable(),
  /** Omitted: the plan template's features. A service agreement names its own. */
  features: z.array(z.enum(ACCESS_FEATURES)).min(1).max(ACCESS_FEATURES.length).optional(),
  source: z.enum(GRANT_SOURCES),
  reference: text(200),
  note: text(1000),
  validFrom: time.optional(),
  /** Omitted: the plan template's term. Required for a plan without one. */
  validUntil: time.optional(),
});
export const revokeGrantInput = z.strictObject({ reason: z.string().trim().min(1).max(1000) });
/** An Individual grant: a person-scoped plan, from a subscription, a courtesy or an internal test. */
export const issuePersonGrantInput = z.strictObject({
  planId: z.string().max(64),
  /** Omitted: the plan's features. */
  features: z.array(z.enum(ACCESS_FEATURES)).min(1).max(ACCESS_FEATURES.length).optional(),
  source: z.enum(['subscription', 'courtesy', 'internal-test']),
  reference: text(200),
  note: text(1000),
  /** Omitted for the complete plan: the start of its billing period. */
  validFrom: time.optional(),
  /** Omitted for the complete plan: the end of its billing period. A limited override names its own. */
  validUntil: time.optional(),
  /**
   * The verified monthly term the complete plan pays for: the subscription's original anchor and the
   * term's index from it. Omitted only for a person's first subscription, whose anchor is `validFrom`
   * (or now). A renewal names the next index; a genuinely new subscription after a lapse names a new
   * anchor. The server computes both boundaries; a submitted end date cannot move them.
   */
  billingCycle: z.strictObject({ anchorAt: time, index: z.number().int().min(0).max(MAX_INDIVIDUAL_CYCLE_INDEX) }).optional(),
});
export const addFundingInput = z.strictObject({
  credits: z.number().int().min(1).max(100_000),
  reason: z.string().trim().min(1).max(500),
});
export const saveRouteInput = z.strictObject({
  id: routeEntryId,
  provider: z.enum(MODEL_API_ROUTES),
  model: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(120),
  region: z.string().trim().max(64).nullable(),
  processing: text(300),
  status: z.enum(['qualified', 'unqualified', 'retired']),
  evidence: text(1000),
  /** The revision the editor read; a stale editor is refused, never merged. Omit for a new entry. */
  baseRevision: epoch.optional(),
  binding: modelBindingSchema.optional(),
});
export const publishPolicyInput = z.strictObject({
  tiers: z.strictObject({
    efficient: routeEntryId.nullable(),
    focused: routeEntryId.nullable(),
    thorough: routeEntryId.nullable(),
  }),
  note: z.string().trim().min(1).max(1000),
  /** The revision the publisher read. A publish built on an older one is refused. */
  baseRevision: epoch,
});
export const rollbackPolicyInput = z.strictObject({
  toRevision: z.number().int().min(1),
  note: z.string().trim().min(1).max(1000),
  baseRevision: epoch,
});
export const addStaffInput = z.strictObject({ personId: accountId, role: z.enum(STAFF_ROLES) });
export const changeStaffInput = z.strictObject({ role: z.enum(STAFF_ROLES), state: z.enum(['active', 'disabled']) });

// --- the service -------------------------------------------------------------------------

export interface CommercialOptions {
  now?: () => number;
  directory?: IdentityDirectory;
  /** A label for staff views: 'faux' for the local test service, else the deployment. */
  backend?: string;
  /** Legacy configuration remains accepted; Individual never covers Business work. */
  coverage?: IndividualCoverage;
}

const newId = (kind: string) => `${kind}_${crypto.randomUUID()}`;

interface PersonGrantDraft {
  plan: NonNullable<ReturnType<typeof catalogPlan>>;
  features: AccessFeature[];
  data: z.infer<typeof issuePersonGrantInput>;
  validFrom: string;
  validUntil: string;
  billingCycle: IndividualBillingCycle | undefined;
}

export class CommercialService {
  private readonly now: () => number;
  private readonly directory: IdentityDirectory;
  readonly backend: string;

  constructor(
    private readonly accounts: AccountService,
    private readonly repository: CommercialRepository,
    private readonly funding: FundingService | null,
    options: CommercialOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.directory = options.directory ?? NO_IDENTITY_DIRECTORY;
    this.backend = options.backend ?? 'cloud';
  }

  private at() {
    return new Date(this.now()).toISOString();
  }

  // --- customer reads -----------------------------------------------------------------

  /** One member's view of their business's access. Owners also see the grants. */
  async access(token: string, organizationId: string): Promise<CoveredAccessView> {
    const snapshot = await this.accounts.membership(token, organizationId);
    const at = this.at();
    const { grants, revision } = await this.repository.transaction(async (tx) => {
      const grants = await tx.grants(organizationId);
      const revision = await tx.accessRevision(organizationId);
      return { grants, revision };
    });
    const view = entitlementFromGrants(grants, revision, at);
    const role = snapshot.membership.role;
    const capabilities = ROLE_CAPABILITIES[role];
    const admission = decideAgentAdmission({ workspace: 'business', member: true, entitlement: snapshotFromView(view), at });
    const when = Date.parse(at);
    const summaries = grants.map((grant) => summary(grant, when));
    return {
      v: 1,
      organizationId,
      role,
      roleLabel: roleLabel(role),
      capabilities,
      state: view.state,
      planLabel: view.planLabel,
      planId: view.plan === 'none' ? null : view.plan,
      features: view.features as AccessFeature[],
      agent: { included: admission.admitted, reason: admission.admitted ? '' : admission.reason },
      validFrom: view.validFrom,
      validUntil: view.validUntil,
      revision,
      grants: capabilities.seePlan ? summaries.sort((a, b) => (a.validUntil < b.validUntil ? 1 : -1)) : null,
      checkedAt: at,
    };
  }

  /** The EntitlementView the desktop's one entitlement seam reads. */
  async entitlement(token: string, organizationId: string): Promise<EntitlementView> {
    await this.accounts.membership(token, organizationId);
    return this.repository.transaction(async (tx) =>
      entitlementFromGrants(await tx.grants(organizationId), await tx.accessRevision(organizationId), this.at()));
  }

  /**
   * Admit (or refuse) one piece of Nectovia Agent work, and record the decision
   * with what it was pinned to. Called when work starts and again before a
   * queued, resumed or retried run makes its next model call, so a withdrawn
   * grant stops new work without touching the person's files or history.
   */
  async admitAgent(token: string, organizationId: string, input: z.infer<typeof agentAdmissionInput>) {
    const parsed = agentAdmissionInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Name the surface and route kind this Agent work runs on.');
    const snapshot = await this.accounts.membership(token, organizationId);
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      const revision = await tx.accessRevision(organizationId);
      const view = entitlementFromGrants(await tx.grants(organizationId), revision, at);
      const policy = await tx.policy();
      const decision: AgentAdmissionDecision = decideAgentAdmission({
        workspace: 'business', member: true, entitlement: snapshotFromView(view), at,
      });
      const record: AdmissionRecord = {
        id: newId('agent_admission'),
        at,
        organizationId,
        tenantId: snapshot.organization.tenantId,
        personId: snapshot.person.id,
        surface: parsed.data.surface,
        routeKind: parsed.data.routeKind,
        decision: decision.admitted ? 'admitted' : 'refused',
        code: decision.admitted ? null : decision.code,
        planId: view.plan === 'none' ? null : view.plan,
        accessRevision: revision,
        policyRevision: policy?.revision ?? 0,
        rootJobId: parsed.data.rootJobId ?? null,
      };
      await tx.saveAdmission(record);
      return {
        admissionId: record.id,
        decision,
        pins: {
          organizationId,
          tenantId: snapshot.organization.tenantId,
          personId: snapshot.person.id,
          planId: record.planId,
          accessRevision: revision,
          policyRevision: record.policyRevision,
          rootJobId: record.rootJobId,
        },
        // A decision is reused for at most this long before the host asks again.
        validUntil: new Date(Math.min(Date.parse(snapshot.validUntil), this.now() + 60_000)).toISOString(),
      };
    });
  }

  /** The signed-in person's own Individual access, for `GET /account/access`. State none without a grant. */
  async personAccess(token: string): Promise<PersonAccessView> {
    const session = await this.accounts.signIn(token);
    const personId = session.person.id;
    const at = this.at();
    const { grants, revision } = await this.repository.transaction(async (tx) => ({
      grants: await tx.personGrants(personId),
      revision: await tx.personAccessRevision(personId),
    }));
    const view = personEntitlement(grants, revision, at);
    const included = view.state === 'active' && view.agent;
    const when = Date.parse(at);
    return {
      v: 1,
      personId,
      state: view.state,
      planId: view.plan === 'none' ? null : view.plan,
      planLabel: view.planLabel,
      features: view.features as AccessFeature[],
      agent: { included, reason: included ? '' : view.state === 'active' ? AGENT_PERSONAL_INDIVIDUAL_REASON : view.reason },
      validFrom: view.validFrom,
      validUntil: view.validUntil,
      revision,
      grants: grants.map((grant) => personSummary(grant, when)).sort((a, b) => (a.validUntil < b.validUntil ? 1 : -1)),
      checkedAt: at,
    };
  }

  /**
   * The signed-in person's own Individual credits, for `GET /account/usage`. Read-only: it resolves the
   * person's own billing account and current verified term on the server, so no request can name
   * another person, payer or period, and it never allocates. Grants from before monthly terms, and
   * an explicit usage agreement, read their UTC calendar month as before.
   */
  async personUsage(token: string): Promise<PersonalUsageView> {
    const session = await this.accounts.signIn(token);
    const personId = session.person.id;
    const at = this.at(), when = Date.parse(at);
    const { account, grants, agreements } = await this.repository.transaction(async (tx) => {
      const account = await tx.individualFor(personId);
      return { account, grants: await tx.personGrants(personId), agreements: account ? await tx.grants(account.id) : [] };
    });
    const view = (usage: UsageState, renewal: PersonalUsageView['renewal'] = null): PersonalUsageView =>
      ({ v: 1, personId, accountId: account?.id ?? null, usage, renewal, checkedAt: at });
    const scope = account?.id ?? personId;
    if (!account || account.personId !== personId || account.tenantId !== personId)
      return view({ state: 'unavailable', organizationId: scope, reason: 'You have no Individual account yet, so there is no usage to show.' });
    if (account.state !== 'active')
      return view({ state: 'unavailable', organizationId: scope, reason: 'This Individual account is disabled, so it funds no new work.' });
    if (!this.funding) return view({ state: 'not-connected', organizationId: scope, reason: 'The funding service is not connected here.' });
    const term = currentIndividualCycle(grants, when);
    if (term) {
      const next = individualCycle(term.cycle.anchorAt, term.cycle.index + 1);
      const renewed = grants.some((grant) => grant.billingCycle && grant.state === 'active' && sameIndividualCycle(grant.billingCycle, next) &&
        individualIncludesMonthlyCredits(grant));
      return view(await this.funding.individualProjection(personId, account.id, term.cycle),
        { state: renewed ? 'renewed' : 'not-renewed', nextStartsAt: next.startsAt, nextEndsAt: next.endsAt });
    }
    const legacy = grants.some((grant) => !grant.billingCycle && grantState(grant, when) === 'active' && individualIncludesMonthlyCredits(grant)) ||
      agreements.some((grant) => grantState(grant, when) === 'active' && grant.features.includes('managed-inference'));
    if (legacy) return view(await this.funding.projection(personId, account.id));
    return view({ state: 'unavailable', organizationId: scope, reason: 'No current Individual plan includes credits, so there is no usage to show.' });
  }

  /**
   * Admit (or refuse) Personal work, or work in a project no business owns, under the person's own
   * Individual plan, and record the decision. A business's plan never admits it.
   */
  async admitPersonalAgent(token: string, input: z.infer<typeof agentAdmissionInput>) {
    const parsed = agentAdmissionInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Name the surface and route kind this Agent work runs on.');
    const session = await this.accounts.signIn(token);
    const personId = session.person.id;
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      const revision = await tx.personAccessRevision(personId);
      const view = personEntitlement(await tx.personGrants(personId), revision, at);
      const policy = await tx.policy();
      const contract = decideAgentAdmission({
        workspace: 'personal', member: true, entitlement: snapshotFromView(NO_ENTITLEMENT_VIEW), individual: snapshotFromView(view), at,
      });
      const decision = contract.admitted && parsed.data.routeKind === 'managed'
        ? { admitted: false as const, code: 'scoped_admission_required', reason: 'Managed Personal work requires a current Nectovia client and scoped admission. Nothing was sent.' }
        : contract.admitted ? contract
        : view.state === 'revoked' ? { admitted: false as const, code: 'entitlement_revoked', reason: INDIVIDUAL_REVOKED_REASON }
        : view.state === 'expired' ? { admitted: false as const, code: 'entitlement_expired', reason: INDIVIDUAL_EXPIRED_REASON }
        : { admitted: false as const, code: 'entitlement_none', reason: INDIVIDUAL_NONE_REASON };
      const record: PersonalAdmissionRecord = {
        id: newId('agent_admission'),
        at,
        personId,
        tenantId: personId,
        surface: parsed.data.surface,
        routeKind: parsed.data.routeKind,
        decision: decision.admitted ? 'admitted' : 'refused',
        code: decision.admitted ? null : decision.code,
        planId: view.plan === 'none' ? null : view.plan,
        accessRevision: revision,
        policyRevision: policy?.revision ?? 0,
        rootJobId: parsed.data.rootJobId ?? null,
      };
      await tx.savePersonalAdmission(record);
      return {
        admissionId: record.id,
        decision,
        pins: {
          organizationId: null,
          tenantId: personId,
          personId,
          planId: record.planId,
          accessRevision: revision,
          policyRevision: record.policyRevision,
          rootJobId: record.rootJobId,
        },
        validUntil: new Date(Math.min(Date.parse(session.expiresAt), this.now() + 60_000)).toISOString(),
      };
    });
  }

  /**
   * The published tier policy, for any verified person: which route and model
   * serve each tier. Identifiers only; the credentials are never in it.
   */
  async routingPolicy(token: string) {
    await this.accounts.signIn(token);
    return this.repository.transaction(async (tx) => {
      const policy = await tx.policy();
      const tiers: TierPolicy['tiers'] = policy?.tiers ?? { efficient: null, focused: null, thorough: null };
      const routes = policy ? await tx.routes() : [];
      // This gateway accepts reasoning summaries (managed-inference.ts), and a desktop asks for them
      // only for its own tier, only when the upstream serving it is proven to accept them.
      const reasoningSummaries = Object.fromEntries(
        POLICY_TIERS.map((tier) => {
          const entry = routes.find((row) => row.id === tiers[tier]?.entryId);
          return [tier, entry ? registryRow(entry)?.reasoningSummaries === true : false];
        }),
      ) as Record<PolicyTier, boolean>;
      return policy
        ? { revision: policy.revision, publishedAt: policy.publishedAt, tiers: policy.tiers, reasoningSummaries }
        : { revision: 0, publishedAt: null, tiers, reasoningSummaries };
    });
  }

  // --- staff --------------------------------------------------------------------------

  private async staffOperator(tx: CommercialTransaction, personId: string, permission: StaffPermission) {
    const operator = await tx.operator(personId);
    if (!operator || operator.state !== 'active')
      throw new AccountError(403, 'This account is not a Diomedes staff account.');
    if (!staffCan(operator.role, permission))
      throw new AccountError(403, `The ${operator.role} role cannot do this. Ask a Diomedes admin.`);
    return operator;
  }

  private async staff(token: string, permission: StaffPermission) {
    const session = await this.accounts.signIn(token);
    const operator = await this.repository.transaction((tx) => this.staffOperator(tx, session.person.id, permission));
    return { person: session.person, operator };
  }

  private async writeStaff<T>(token: string, action: (tx: CommercialTransaction, actor: { person: Person; operator: Operator }) => Promise<T>) {
    const actor = await this.staff(token, 'staff.write');
    return this.repository.transaction(async (tx) => {
      await tx.lockStaff();
      const operator = await this.staffOperator(tx, actor.person.id, 'staff.write');
      return action(tx, { person: actor.person, operator });
    });
  }

  private async audited(tx: CommercialTransaction, actor: { person: Person; operator: Operator }, event: Omit<AuditEvent, 'id' | 'at' | 'actorPersonId' | 'actorRole'>) {
    await tx.audit({ id: newId('audit'), at: this.at(), actorPersonId: actor.person.id, actorRole: actor.operator.role, ...event });
  }

  private async contact(issuer: string, subject: string) {
    try {
      return await this.directory.lookup(issuer, subject);
    } catch {
      return null;
    }
  }

  /**
   * Whether a person the caller has already verified is active Diomedes staff, and as what. Only an
   * ACTIVE row counts: a disabled row, and a person with no row, are not staff. This reads the
   * staff table and nothing else, so it cannot be argued into by an email domain, a plan, or the
   * internal-test grant source. The caller owns the verification: pass only a personId taken from a
   * session the account service has just authenticated, never one a client supplied.
   */
  async staffMarkerFor(verifiedPersonId: string): Promise<{ role: StaffRole } | null> {
    const operator = await this.repository.transaction((tx) => tx.operator(verifiedPersonId));
    return operator && operator.state === 'active' ? { role: operator.role } : null;
  }

  /** Who is signed in to the Operations app, and what their role allows. */
  async me(token: string) {
    const actor = await this.staff(token, 'customers.read');
    return {
      person: actor.person,
      role: actor.operator.role,
      permissions: (['customers.read', 'grants.write', 'funding.write', 'routes.write', 'policy.publish', 'staff.write'] as const)
        .filter((permission) => staffCan(actor.operator.role, permission)),
      backend: this.backend,
      /** Every plan staff may issue, each with its scope: 'organization' or 'person'. */
      plans: planCatalog(),
    };
  }

  async customers(token: string, query = '') {
    await this.staff(token, 'customers.read');
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      const rows = await tx.organizations(query.trim().toLowerCase().slice(0, 100), 200);
      const out = [];
      for (const row of rows) {
        const grants = await tx.grants(row.organization.id);
        const view = entitlementFromGrants(grants, await tx.accessRevision(row.organization.id), at);
        out.push({
          organization: row.organization,
          activeMembers: row.activeMembers,
          state: view.state,
          planId: view.plan === 'none' ? null : view.plan,
          planLabel: planTemplate(view.plan)?.label ?? (view.plan === 'none' ? null : view.plan),
          agent: view.agent,
          validUntil: view.validUntil,
        });
      }
      return out;
    });
  }

  async customer(token: string, organizationId: string) {
    await this.staff(token, 'customers.read');
    const at = this.at();
    const found = await this.repository.transaction(async (tx) => {
      const organization = await tx.organizationRecord(organizationId);
      if (!organization) throw new AccountError(404, 'That customer was not found.');
      const grants = await tx.grants(organizationId);
      const revision = await tx.accessRevision(organizationId);
      return {
        organization,
        roster: await tx.roster(organizationId),
        grants,
        revision,
        admissions: await tx.admissions(organizationId, 50),
        audit: await tx.auditLog({ organizationId, limit: 50 }),
      };
    });
    const people = [];
    for (const row of found.roster) {
      const contact = await this.contact(row.issuer, row.subject);
      people.push({
        personId: row.person.id, name: row.person.name, email: contact?.email ?? null,
        role: row.membership.role, roleLabel: roleLabel(row.membership.role), state: row.membership.state,
        joinedAt: row.membership.joinedAt, revokedAt: row.membership.revokedAt,
      });
    }
    let usage: UsageState | null = null;
    if (this.funding) {
      try { usage = await this.funding.projection(found.organization.tenantId, organizationId); }
      catch { usage = { state: 'unavailable', organizationId, reason: 'Usage could not be read.' }; }
    }
    return {
      organization: found.organization,
      entitlement: entitlementFromGrants(found.grants, found.revision, at),
      grants: found.grants.map((grant) => ({ ...grant, current: grantState(grant, Date.parse(at)) })),
      people,
      usage,
      admissions: found.admissions,
      audit: found.audit,
    };
  }

  /**
   * Issue a feature grant from a plan template or an agreement. A grant with
   * included usage on a plan that carries a published monthly grant also
   * allocates this month's credits, bound to this grant.
   */
  async issueGrant(token: string, organizationId: string, input: z.infer<typeof issueGrantInput>) {
    const parsed = issueGrantInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'A grant needs a plan or features, a source, a reference and dates.');
    const actor = await this.staff(token, 'grants.write');
    // The Individual plan is a person's own subscription; it is never issued to a business.
    if (isPersonPlan(parsed.data.planId)) throw new AccountError(422, INDIVIDUAL_PLAN_NOT_FOR_BUSINESS);
    const plan = parsed.data.planId === null ? undefined : planTemplate(parsed.data.planId);
    if (parsed.data.planId !== null && !plan) throw new AccountError(422, 'That plan is not in the catalog.');
    const features = parsed.data.features ?? plan?.features;
    if (!features?.length) throw new AccountError(422, 'Choose the features this grant includes.');
    const now = this.now();
    const validFrom = parsed.data.validFrom ?? new Date(now).toISOString();
    const validUntil = parsed.data.validUntil ??
      (plan?.termDays ? new Date(Date.parse(validFrom) + plan.termDays * 86_400_000).toISOString() : undefined);
    if (!validUntil) throw new AccountError(422, 'Choose when this grant ends.');
    if (Date.parse(validUntil) <= Date.parse(validFrom) || Date.parse(validUntil) <= now)
      throw new AccountError(422, 'A grant must end after it starts, and after today.');
    if (!parsed.data.reference) throw new AccountError(422, 'Name the invoice, agreement or ticket this grant answers to.');
    const grant = await this.repository.transaction(async (tx) => {
      const organization = await tx.organizationRecord(organizationId);
      if (!organization) throw new AccountError(404, 'That customer was not found.');
      await tx.lockOrganization(organizationId);
      const row: FeatureGrant = {
        v: 1, id: newId('grant'), organizationId, tenantId: organization.tenantId,
        planId: parsed.data.planId, features: [...new Set(features)] as AccessFeature[], source: parsed.data.source,
        reference: parsed.data.reference, note: parsed.data.note, validFrom, validUntil, state: 'active',
        issuedAt: this.at(), issuedBy: actor.person.id, revokedAt: null, revokedBy: null, revokedReason: null,
      };
      await tx.saveGrant(row);
      const revision = await tx.bumpAccessRevision(organizationId, organization.tenantId);
      await this.audited(tx, actor, {
        action: 'grant.issued', organizationId, targetKind: 'grant', targetId: row.id, reason: row.note || row.reference,
        detail: { planId: row.planId, features: row.features, source: row.source, reference: row.reference, validFrom, validUntil, accessRevision: revision },
      });
      return row;
    });
    let funding: { allocated: boolean; reason: string } = { allocated: false, reason: 'This grant carries no included usage.' };
    if (this.funding && grant.features.includes('managed-inference') && grant.planId && publishedMonthlyGrant(grant.planId) !== null) {
      try {
        await this.funding.allocatePeriod({ tenantId: grant.tenantId, organizationId, periodId: periodIdFor(this.at()), planId: grant.planId, sourceGrantId: grant.id });
        await this.repository.transaction((tx) => this.audited(tx, actor, {
          action: 'funding.allocated', organizationId, targetKind: 'funding', targetId: periodIdFor(this.at()),
          reason: `Monthly credits for ${planLabel(grant.planId)}`, detail: { grantId: grant.id, planId: grant.planId },
        }));
        funding = { allocated: true, reason: 'This month’s included credits were allocated.' };
      } catch (error) {
        funding = { allocated: false, reason: error instanceof Error ? error.message : 'Credits could not be allocated.' };
      }
    }
    return { grant, funding };
  }

  async revokeGrant(token: string, organizationId: string, grantId: string, input: z.infer<typeof revokeGrantInput>) {
    const parsed = revokeGrantInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Say why this grant is being withdrawn.');
    const actor = await this.staff(token, 'grants.write');
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(organizationId);
      const grant = (await tx.grants(organizationId)).find((row) => row.id === grantId);
      if (!grant) throw new AccountError(404, 'That grant was not found for this customer.');
      if (grant.state === 'revoked') throw new AccountError(409, 'That grant is already withdrawn.');
      // Revocation stops new Agent work at its next admission. It deletes no
      // customer data, and settled or in-flight charges stay as they are.
      const row: FeatureGrant = { ...grant, state: 'revoked', revokedAt: this.at(), revokedBy: actor.person.id, revokedReason: parsed.data.reason };
      await tx.saveGrant(row);
      const revision = await tx.bumpAccessRevision(organizationId, grant.tenantId);
      await this.audited(tx, actor, {
        action: 'grant.revoked', organizationId, targetKind: 'grant', targetId: grantId, reason: parsed.data.reason,
        detail: { planId: grant.planId, features: grant.features, accessRevision: revision },
      });
      return row;
    });
  }

  // --- Individual plans, for staff ----------------------------------------------------------

  /** One person, for the Operations app: their businesses, Individual grants, personal admissions and audit. */
  async person(token: string, personId: string) {
    await this.staff(token, 'customers.read');
    const at = this.at();
    const found = await this.repository.transaction(async (tx) => {
      const person = await tx.person(personId);
      if (!person) throw new AccountError(404, 'That person was not found.');
      const row = (await tx.people(personId, 200)).find((item) => item.person.id === personId);
      const memberships = [];
      for (const membership of row?.memberships ?? []) {
        const organization = await tx.organizationRecord(membership.organizationId);
        memberships.push({
          ...membership, roleLabel: roleLabel(membership.role), organizationName: organization?.name ?? null,
          activeMembers: await tx.organizationActiveMembers(membership.organizationId),
        });
      }
      return {
        person,
        memberships,
        operator: await tx.operator(personId),
        grants: await tx.personGrants(personId),
        revision: await tx.personAccessRevision(personId),
        admissions: await tx.personalAdmissions(personId, 50),
        audit: await tx.personAudit(personId, 50),
      };
    });
    const contact = await this.contact(found.person.issuer, found.person.subject);
    return {
      person: found.person.person,
      email: contact?.email ?? null,
      staffRole: found.operator?.state === 'active' ? found.operator.role : null,
      memberships: found.memberships,
      entitlement: personEntitlement(found.grants, found.revision, at),
      grants: found.grants.map((grant) => ({ ...grant, current: grantState(grant, Date.parse(at)) })),
      /** The subscription anchor, the term in force now and the next term a renewal would pay for, all UTC. */
      individualTerm: individualTerms(found.grants, Date.parse(at)),
      admissions: found.admissions,
      audit: found.audit,
    };
  }

  /**
   * Issue Personal access. Its recurring allowance is allocated by the funding writer when needed.
   *
   * The complete plan pays for exactly one verified monthly term (DIO-128): both boundaries come from
   * the subscription's anchor and the term's index, never from a day count, a submitted end date,
   * the issue time or a new grant id. Issuing the same reference for the same term and terms again
   * returns the original grant; any other replay of that reference is refused. A different reference
   * for a term already paid (a replacement after withdrawal, say) shares that term's one balance.
   * Overlapping terms, and a term overlapping a still-current legacy plan or explicit agreement, are
   * refused so two allowances can never fund the same time.
   */
  async issuePersonGrant(token: string, personId: string, input: z.infer<typeof issuePersonGrantInput>) {
    const parsed = issuePersonGrantInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'A grant needs a plan, a source, a reference and dates.');
    const actor = await this.staff(token, 'grants.write');
    const plan = catalogPlan(parsed.data.planId);
    if (!plan) throw new AccountError(422, 'That plan is not in the catalog.');
    if (plan.scope !== 'person') throw new AccountError(422, BUSINESS_PLAN_NOT_FOR_PERSON);
    const features = [...new Set(parsed.data.features ?? plan.features)] as AccessFeature[];
    if (features.includes('managed-inference') && !features.includes(AGENT_FEATURE))
      throw new AccountError(422, 'Individual included usage requires Personal Agent access in the same grant.');
    if (!parsed.data.reference) throw new AccountError(422, 'Name the invoice, agreement or ticket this grant answers to.');
    const monthly = plan.billingInterval === 'month' && individualIncludesMonthlyCredits({ planId: plan.id, features });
    if (!monthly && parsed.data.billingCycle)
      throw new AccountError(422, 'Only the complete Individual plan has a monthly billing period. A limited grant names its own dates.');
    const now = this.now();
    const normalize = (value: string | undefined) => (value === undefined ? undefined : new Date(value).toISOString());
    const submittedFrom = normalize(parsed.data.validFrom), submittedUntil = normalize(parsed.data.validUntil);
    if (!monthly) {
      const validFrom = submittedFrom ?? new Date(now).toISOString();
      const validUntil = submittedUntil ??
        (plan.termDays ? new Date(Date.parse(validFrom) + plan.termDays * 86_400_000).toISOString() : undefined);
      if (!validUntil) throw new AccountError(422, 'Choose when this grant ends.');
      if (Date.parse(validUntil) <= Date.parse(validFrom) || Date.parse(validUntil) <= now)
        throw new AccountError(422, 'A grant must end after it starts, and after today.');
      return this.savePersonGrantRow(actor, personId, { plan, features, data: parsed.data, validFrom, validUntil, billingCycle: undefined });
    }
    return this.repository.transaction(async (tx) => {
      const person = await tx.person(personId);
      if (!person) throw new AccountError(404, 'That person was not found.');
      const account = await ensureIndividualAccount(tx, person.person, this.at());
      const prior = await tx.personGrants(personId);
      const terms = prior.filter((grant) => grant.billingCycle);
      let cycle: IndividualBillingCycle;
      try {
        if (parsed.data.billingCycle) cycle = individualCycle(new Date(parsed.data.billingCycle.anchorAt).toISOString(), parsed.data.billingCycle.index);
        else if (!terms.length) cycle = individualCycle(submittedFrom ?? new Date(now).toISOString(), 0);
        else throw new AccountError(409, 'This person already has a monthly Individual subscription. Name the billing period this grant pays for: the next term, or a new subscription start.', 'billing_period_required');
      } catch (error) {
        if (error instanceof RangeError) throw new AccountError(422, 'That billing period is not a valid subscription month.', 'invalid_billing_period');
        throw error;
      }
      const validFrom = submittedFrom ?? cycle.startsAt;
      const validUntil = submittedUntil ?? cycle.endsAt;
      if (Date.parse(validFrom) < Date.parse(cycle.startsAt) || Date.parse(validUntil) > Date.parse(cycle.endsAt) || Date.parse(validUntil) <= Date.parse(validFrom))
        throw new AccountError(422, `This grant's dates must lie inside its billing period, ${cycle.startsAt} to ${cycle.endsAt} (UTC).`, 'outside_billing_period');
      if (Date.parse(validUntil) <= now)
        throw new AccountError(422, 'That billing period has already ended. An elapsed period is never funded afterwards.', 'billing_period_ended');
      // One reference pays for one term, once. A replay with the same terms is the same grant.
      const replay = terms.find((grant) => grant.reference === parsed.data.reference);
      if (replay) {
        const same = sameIndividualCycle(replay.billingCycle!, cycle) && replay.state === 'active' && replay.planId === plan.id &&
          replay.source === parsed.data.source && replay.validFrom === validFrom && replay.validUntil === validUntil &&
          JSON.stringify([...replay.features].sort()) === JSON.stringify([...features].sort());
        if (!same) throw new AccountError(409, 'That reference already paid for a billing period on different terms. Issue a correction under its own reference.', 'billing_reference_conflict');
        return { grant: replay, replayed: true as const };
      }
      if (terms.some((grant) => !sameIndividualCycle(grant.billingCycle!, cycle) && periodsOverlap(grant.billingCycle!, cycle)))
        throw new AccountError(409, 'That billing period overlaps another recorded Individual period. One period funds any moment, once.', 'billing_period_overlap');
      const covering = (grant: { validFrom: string; validUntil: string }) => periodsOverlap({ startsAt: grant.validFrom, endsAt: grant.validUntil }, cycle);
      if (prior.some((grant) => !grant.billingCycle && grant.state === 'active' && individualIncludesMonthlyCredits(grant) && Date.parse(grant.validUntil) > now && covering(grant)))
        throw new AccountError(409, 'A current Individual plan from before monthly billing periods still covers part of this period. Start the monthly term when it ends.', 'legacy_term_overlap');
      if ((await tx.grants(account.id)).some((grant) => grant.state === 'active' && grant.features.includes('managed-inference') && Date.parse(grant.validUntil) > now && covering(grant)))
        throw new AccountError(409, 'An explicit usage agreement still funds this account during part of this period. Start the monthly term after its agreed coverage.', 'agreement_overlap');
      const grant = await this.writePersonGrant(tx, actor, personId, { plan, features, data: parsed.data, validFrom, validUntil, billingCycle: cycle });
      return { grant };
    });
  }

  private savePersonGrantRow(actor: { person: Person; operator: Operator }, personId: string, input: PersonGrantDraft) {
    return this.repository.transaction(async (tx) => {
      const person = await tx.person(personId);
      if (!person) throw new AccountError(404, 'That person was not found.');
      await ensureIndividualAccount(tx, person.person, this.at());
      return { grant: await this.writePersonGrant(tx, actor, personId, input) };
    });
  }

  private async writePersonGrant(tx: CommercialTransaction, actor: { person: Person; operator: Operator }, personId: string, input: PersonGrantDraft) {
    const { plan, features, data, validFrom, validUntil, billingCycle } = input;
    const row: PersonFeatureGrant = {
      v: 1, id: newId('grant'), personId, tenantId: personId, planId: plan.id, features, source: data.source,
      reference: data.reference, note: data.note, validFrom, validUntil, state: 'active',
      issuedAt: this.at(), issuedBy: actor.person.id, revokedAt: null, revokedBy: null, revokedReason: null,
      ...(billingCycle ? { billingCycle } : {}),
    };
    await tx.savePersonGrant(row);
    const revision = await tx.bumpPersonAccessRevision(personId, personId);
    await this.audited(tx, actor, {
      action: 'person-grant.issued', organizationId: null, targetKind: 'person-grant', targetId: row.id, reason: row.note || row.reference,
      detail: { personId, planId: row.planId, features: row.features, source: row.source, reference: row.reference, validFrom, validUntil,
        accessRevision: revision, ...(billingCycle ? { billingCycle } : {}) },
    });
    return row;
  }

  async revokePersonGrant(token: string, personId: string, grantId: string, input: z.infer<typeof revokeGrantInput>) {
    const parsed = revokeGrantInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Say why this grant is being withdrawn.');
    const actor = await this.staff(token, 'grants.write');
    return this.repository.transaction(async (tx) => {
      await tx.lockPerson(personId);
      const grant = (await tx.personGrants(personId)).find((row) => row.id === grantId);
      if (!grant) throw new AccountError(404, 'That grant was not found for this person.');
      if (grant.state === 'revoked') throw new AccountError(409, 'That grant is already withdrawn.');
      // Like a business grant: it stops new Agent work at the next admission and deletes nothing.
      const row: PersonFeatureGrant = { ...grant, state: 'revoked', revokedAt: this.at(), revokedBy: actor.person.id, revokedReason: parsed.data.reason };
      await tx.savePersonGrant(row);
      const revision = await tx.bumpPersonAccessRevision(personId, grant.tenantId);
      await this.audited(tx, actor, {
        action: 'person-grant.revoked', organizationId: null, targetKind: 'person-grant', targetId: grantId, reason: parsed.data.reason,
        detail: { personId, planId: grant.planId, features: grant.features, accessRevision: revision },
      });
      return row;
    });
  }

  /** Add included credits to this month as a noted correction. Needs a month already funded by a plan. */
  async addFunding(token: string, organizationId: string, input: z.infer<typeof addFundingInput>) {
    const parsed = addFundingInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Give a whole number of credits and a reason.');
    const actor = await this.staff(token, 'funding.write');
    if (!this.funding) throw new AccountError(503, 'The funding service is not connected here.');
    const organization = await this.repository.transaction((tx) => tx.organizationRecord(organizationId));
    if (!organization) throw new AccountError(404, 'That customer was not found.');
    const periodId = periodIdFor(this.at());
    const adjustmentId = newId('adjustment');
    const row = await this.funding.recordCorrection({
      tenantId: organization.tenantId, organizationId, adjustmentId, periodId, direction: 'grant',
      amountMicroUsd: creditAmount(parsed.data.credits), attemptRef: null, note: parsed.data.reason,
    });
    await this.repository.transaction((tx) => this.audited(tx, actor, {
      action: 'funding.added', organizationId, targetKind: 'funding', targetId: adjustmentId, reason: parsed.data.reason,
      detail: { credits: parsed.data.credits, microUsd: parsed.data.credits * CREDIT_MICRO_USD, periodId },
    }));
    return row;
  }

  async routes(token: string) {
    await this.staff(token, 'customers.read');
    return this.repository.transaction(async (tx) => ({
      routes: (await tx.routes()).sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)),
      policy: (await tx.policy()) ?? null,
      history: await tx.policies(50),
    }));
  }

  /**
   * Add or edit a registry entry. A route in the current policy cannot be
   * unqualified or retired, or have its provider or model changed, until a
   * new policy stops using it: the policy names what customers run on.
   */
  async saveRoute(token: string, input: z.infer<typeof saveRouteInput>, env: Readonly<Record<string, unknown>> = {}) {
    const parsed = saveRouteInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'A route needs an id, provider, model id, name and status.');
    const actor = await this.staff(token, 'routes.write');
    if (parsed.data.status === 'qualified' && !parsed.data.evidence)
      throw new AccountError(422, 'Say what qualified this route: a live proof, a run or a dated account check.');
    return this.repository.transaction(async (tx) => {
      await tx.lockPolicy();
      await tx.lockStaff();
      actor.operator = await this.staffOperator(tx, actor.person.id, 'routes.write');
      const existing = (await tx.routes()).find((row) => row.id === parsed.data.id);
      if (parsed.data.binding) {
        const connection = approvedConnections(env).find(c => c.id === parsed.data.binding!.connectionId);
        if (!connection) throw new AccountError(422, 'Select an approved company connection.');
        const problems = bindingProblems({ ...parsed.data, revision: existing?.revision ?? 0 }, connection);
        if (problems.length) throw new AccountError(422, problems.map(p => p.message).join(' '));
        const identity = (r: typeof parsed.data) => JSON.stringify([r.provider, r.model, r.binding?.connectionId, r.binding?.connectionRevision,
          r.binding?.modelVersion, r.binding?.protocol, r.binding?.deployment, r.binding?.upstreamEndpoint]);
        if (existing?.binding && identity(existing) !== identity(parsed.data)) {
          for (const key of ['privacy', 'qualification', 'access'] as const)
            if (parsed.data.binding[key] !== null && JSON.stringify(parsed.data.binding[key]) === JSON.stringify(existing.binding[key]))
              throw new AccountError(422, `Changing the binding requires fresh ${key} evidence or an explicitly unverified state.`);
        }
      } else if (existing?.binding) throw new AccountError(422, 'A versioned binding cannot be removed. Retire the route instead.');
      if (existing && parsed.data.baseRevision !== existing.revision)
        throw new AccountError(409, 'Someone changed this route since you opened it. Reload and try again.');
      if (!existing && parsed.data.baseRevision !== undefined)
        throw new AccountError(409, 'That route no longer exists. Reload and try again.');
      const policy = await tx.policy();
      const inUse = policy ? POLICY_TIERS.filter((tier) => policy.tiers[tier]?.entryId === parsed.data.id) : [];
      if (existing && !existing.binding && inUse.length && (parsed.data.status !== 'qualified' || parsed.data.provider !== existing.provider || parsed.data.model !== existing.model))
        throw new AccountError(409, `This route serves ${inUse.join(', ')} in the current policy. Publish a policy without it first.`);
      const { baseRevision: _base, ...fields } = parsed.data;
      const row: RouteEntry = { v: 1, ...fields, revision: (existing?.revision ?? 0) + 1, updatedAt: this.at(), updatedBy: actor.person.id };
      await tx.saveRoute(row);
      await this.audited(tx, actor, {
        action: 'route.saved', organizationId: null, targetKind: 'route', targetId: row.id, reason: row.evidence || 'Route details saved.',
        detail: { before: existing ?? null, after: row },
      });
      return row;
    });
  }

  private resolve(routes: readonly RouteEntry[], tiers: Record<PolicyTier, string | null>): TierPolicy['tiers'] {
    const out = {} as TierPolicy['tiers'];
    for (const tier of POLICY_TIERS) {
      const id = tiers[tier];
      if (id === null) { out[tier] = null; continue; }
      const entry = routes.find((row) => row.id === id);
      if (!entry) throw new AccountError(422, `There is no route "${id}" in the registry.`);
      if (entry.status !== 'qualified')
        throw new AccountError(422, `${entry.label} on ${entry.provider} is ${entry.status}. Only a qualified route can serve a tier.`);
      out[tier] = { entryId: entry.id, provider: entry.provider, model: entry.model, label: entry.label, entryRevision: entry.revision };
    }
    return out;
  }

  /** Customers affected by a policy change: every business whose plan includes the Agent. */
  private async affected(tx: CommercialTransaction) {
    const at = this.at();
    let count = 0;
    for (const row of await tx.organizations('', 10_000)) {
      const view = entitlementFromGrants(await tx.grants(row.organization.id), 0, at);
      if (view.agent) count++;
    }
    return count;
  }

  async previewPolicy(token: string, input: z.infer<typeof publishPolicyInput>) {
    const parsed = publishPolicyInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Choose a route (or none) for each tier and describe the change.');
    await this.staff(token, 'customers.read');
    return this.repository.transaction(async (tx) => {
      const current = await tx.policy();
      const tiers = this.resolve(await tx.routes(), parsed.data.tiers);
      const changes = POLICY_TIERS.filter((tier) => (current?.tiers[tier]?.entryId ?? null) !== (tiers[tier]?.entryId ?? null))
        .map((tier) => ({ tier, from: current?.tiers[tier] ?? null, to: tiers[tier] }));
      return { baseRevision: current?.revision ?? 0, changes, affectedCustomers: await this.affected(tx) };
    });
  }

  async publishPolicy(token: string, input: z.infer<typeof publishPolicyInput>) {
    const parsed = publishPolicyInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Choose a route (or none) for each tier and describe the change.');
    const actor = await this.staff(token, 'policy.publish');
    return this.repository.transaction(async (tx) => {
      await tx.lockPolicy();
      const current = await tx.policy();
      if (current?.routing) throw new AccountError(409, 'Use the scoped routing editor for this versioned policy.');
      if ((current?.revision ?? 0) !== parsed.data.baseRevision)
        throw new AccountError(409, `The policy is now revision ${current?.revision ?? 0}. Review it and publish again.`);
      const row: TierPolicy = {
        v: 1, revision: (current?.revision ?? 0) + 1, tiers: this.resolve(await tx.routes(), parsed.data.tiers),
        kind: 'publish', basedOn: current?.revision ?? 0, note: parsed.data.note, publishedAt: this.at(), publishedBy: actor.person.id,
      };
      await tx.savePolicy(row);
      await this.audited(tx, actor, {
        action: 'policy.published', organizationId: null, targetKind: 'policy', targetId: String(row.revision), reason: row.note,
        detail: { before: current?.tiers ?? null, after: row.tiers },
      });
      return row;
    });
  }

  /** Republish an earlier revision's routes as a new revision. History is never rewritten. */
  async rollbackPolicy(token: string, input: z.infer<typeof rollbackPolicyInput>) {
    const parsed = rollbackPolicyInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Choose the revision to return to and say why.');
    const actor = await this.staff(token, 'policy.publish');
    return this.repository.transaction(async (tx) => {
      await tx.lockPolicy();
      const current = await tx.policy();
      if (current?.routing) throw new AccountError(409, 'Use scoped rollback so current account restrictions are checked.');
      if ((current?.revision ?? 0) !== parsed.data.baseRevision)
        throw new AccountError(409, `The policy is now revision ${current?.revision ?? 0}. Review it and try again.`);
      const target = await tx.policy(parsed.data.toRevision);
      if (!target) throw new AccountError(404, 'That policy revision was not found.');
      const ids = Object.fromEntries(POLICY_TIERS.map((tier) => [tier, target.tiers[tier]?.entryId ?? null])) as Record<PolicyTier, string | null>;
      const row: TierPolicy = {
        v: 1, revision: (current?.revision ?? 0) + 1, tiers: this.resolve(await tx.routes(), ids),
        kind: 'rollback', basedOn: target.revision, note: parsed.data.note, publishedAt: this.at(), publishedBy: actor.person.id,
      };
      await tx.savePolicy(row);
      await this.audited(tx, actor, {
        action: 'policy.rolled-back', organizationId: null, targetKind: 'policy', targetId: String(row.revision), reason: row.note,
        detail: { before: current?.tiers ?? null, after: row.tiers, restored: target.revision },
      });
      return row;
    });
  }

  async staffList(token: string) {
    await this.staff(token, 'customers.read');
    const rows = await this.repository.transaction(async (tx) => {
      const out = [];
      for (const operator of await tx.operators()) out.push({ operator, found: await tx.person(operator.personId) });
      return out;
    });
    const staff = [];
    for (const row of rows) {
      const contact = row.found ? await this.contact(row.found.issuer, row.found.subject) : null;
      staff.push({ ...row.operator, name: row.found?.person.name ?? 'Unknown person', email: contact?.email ?? null });
    }
    return staff;
  }

  async addStaff(token: string, input: z.infer<typeof addStaffInput>) {
    const parsed = addStaffInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Choose a person and a staff role.');
    return this.writeStaff(token, async (tx, actor) => {
      if (!(await tx.person(parsed.data.personId))) throw new AccountError(404, 'That person has no account yet. They sign in once first.');
      if (await tx.operator(parsed.data.personId)) throw new AccountError(409, 'That person is already on staff. Change their role instead.');
      const at = this.at();
      const row: Operator = { v: 1, personId: parsed.data.personId, role: parsed.data.role, state: 'active', addedAt: at, addedBy: actor.person.id, updatedAt: at, updatedBy: actor.person.id };
      await tx.saveOperator(row);
      await this.audited(tx, actor, { action: 'staff.added', organizationId: null, targetKind: 'operator', targetId: row.personId, reason: `Added as ${row.role}.`, detail: { role: row.role } });
      return row;
    });
  }

  async changeStaff(token: string, personId: string, input: z.infer<typeof changeStaffInput>) {
    const parsed = changeStaffInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Choose a staff role and state.');
    return this.writeStaff(token, async (tx, actor) => {
      const existing = await tx.operator(personId);
      if (!existing) throw new AccountError(404, 'That person is not on staff.');
      // There is always an active admin, so staff administration can never lock itself out.
      const admins = (await tx.operators()).filter((row) => row.state === 'active' && row.role === 'admin' && row.personId !== personId);
      if (existing.role === 'admin' && existing.state === 'active' && (parsed.data.role !== 'admin' || parsed.data.state !== 'active') && admins.length === 0)
        throw new AccountError(409, 'Add another active admin before changing the last one.');
      const row: Operator = { ...existing, ...parsed.data, updatedAt: this.at(), updatedBy: actor.person.id };
      await tx.saveOperator(row);
      await this.audited(tx, actor, { action: 'staff.changed', organizationId: null, targetKind: 'operator', targetId: personId,
        reason: `${existing.role}/${existing.state} → ${row.role}/${row.state}`, detail: { before: existing, after: row } });
      return row;
    });
  }

  async people(token: string, query = '') {
    await this.staff(token, 'customers.read');
    const at = this.at();
    const rows = await this.repository.transaction(async (tx) => {
      const found = await tx.people(query.trim().toLowerCase().slice(0, 100), 200);
      const names = new Map<string, string | null>();
      const out = [];
      for (const row of found) {
        for (const membership of row.memberships)
          if (!names.has(membership.organizationId)) names.set(membership.organizationId, (await tx.organizationRecord(membership.organizationId))?.name ?? null);
        const grants = await tx.personGrants(row.person.id);
        const individual = grants.length ? personEntitlement(grants, await tx.personAccessRevision(row.person.id), at) : null;
        out.push({ ...row, names, individual });
      }
      return out;
    });
    const operators = new Map((await this.repository.transaction((tx) => tx.operators())).map((row) => [row.personId, row]));
    const out = [];
    for (const row of rows) {
      const contact = await this.contact(row.issuer, row.subject);
      out.push({
        person: row.person, email: contact?.email ?? null,
        memberships: row.memberships.map((membership) => ({
          ...membership, roleLabel: roleLabel(membership.role), organizationName: row.names.get(membership.organizationId) ?? null,
        })),
        staffRole: operators.get(row.person.id)?.state === 'active' ? operators.get(row.person.id)!.role : null,
        individual: row.individual
          ? { state: row.individual.state, planId: row.individual.plan === 'none' ? null : row.individual.plan, validUntil: row.individual.validUntil }
          : null,
      });
    }
    return out;
  }

  async audit(token: string, input: { organizationId?: string; limit?: number } = {}) {
    await this.staff(token, 'customers.read');
    const limit = Math.max(1, Math.min(500, input.limit ?? 200));
    return this.repository.transaction((tx) => tx.auditLog({ organizationId: input.organizationId, limit }));
  }
}

/**
 * Make the first Diomedes admin. Staff administration needs an admin to add
 * anyone, so the first one is written here, by the database's operator, never by
 * a route. It is refused once any active admin exists, and the person must have
 * signed in once so their account row exists. Audited like any staff change.
 */
export async function bootstrapFirstAdmin(repository: CommercialRepository, personId: string, at: string): Promise<Operator> {
  return repository.transaction(async (tx) => {
    if (!(await tx.person(personId))) throw new AccountError(404, 'That person has no account yet. They sign in once first.');
    const admin = (await tx.operators()).find((row) => row.state === 'active' && row.role === 'admin');
    if (admin) throw new AccountError(409, 'An active admin already exists. That admin adds staff from the Operations app.');
    const existing = await tx.operator(personId);
    const row: Operator = existing
      ? { ...existing, role: 'admin', state: 'active', updatedAt: at, updatedBy: personId }
      : { v: 1, personId, role: 'admin', state: 'active', addedAt: at, addedBy: personId, updatedAt: at, updatedBy: personId };
    await tx.saveOperator(row);
    await tx.audit({
      id: newId('audit'), at, actorPersonId: personId, actorRole: 'admin', action: existing ? 'staff.changed' : 'staff.added',
      organizationId: null, targetKind: 'operator', targetId: personId,
      reason: 'Bootstrap: the first admin, written by the database operator.', detail: { role: 'admin', bootstrap: true },
    });
    return row;
  });
}

/** Staff roles, re-exported for adapters that seed the first admin. */
export type { StaffRole };
