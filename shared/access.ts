/**
 * Customer access — contract version 1 (Andrew, 2026-09-25).
 *
 * Two questions are kept apart on purpose, in this file and everywhere it is read:
 *
 *   - **What a business may use.** A *feature grant* says which Nectovia features an
 *     organization holds, from what source, and until when. The Nectovia Agent is
 *     one of those features. Connecting a provider or a subscription never grants
 *     it: a route tells Nectovia what compute is available, not what was bought.
 *   - **Who pays for the model calls.** Funding (monthly credits, top-ups, an
 *     operator's bounded included amount) lives in the control plane's funding
 *     service. A top-up funds usage without unlocking the Agent, and a customer
 *     who runs the Agent on their own compute keeps the Agent.
 *
 * Roles are the stored `owner` / `admin` / `member` of `shared/workspaces.ts`,
 * read as Business owner, Manager and Employee. A role decides who may manage
 * the organization; it never grants a feature, and a feature never grants a role.
 *
 * Company staff roles (Support, Billing, Routing, Admin) are a different thing
 * again: they belong to Diomedes, not to a customer, and no customer role —
 * including a customer's Business owner — ever reads as one.
 */
import type { MemberRole } from './workspaces.js';

export const ACCESS_CONTRACT_VERSION = 1 as const;

// --- features ------------------------------------------------------------------

/**
 * Which feature each paid ability needs (Andrew, 2026-09-25 and 2026-09-26). Every
 * ability of the Nectovia bot sits behind a grant; connecting a provider unlocks none.
 *
 *   Agent work on Nectovia: Ask, Plan, Build, Fix, loops    'nectovia-agent', at admission
 *   Diomedes-funded calls, the Jev preflight included       'managed-inference', per call
 *   Owner rules and trigger rules reaching the work         'owner-rules'
 *   Reaching this business's computers from the phone      'phone-relay'
 *
 * Product rules (the plain-writing standard, safety rules) are core behaviour and
 * need no feature. With accounts off (embedded tests only) every check passes
 * through, exactly as the Agent gate does.
 */
/** The supervising Nectovia Agent: native model-API work where Nectovia owns the loop. */
export const AGENT_FEATURE = 'nectovia-agent' as const;
export const OWNER_RULES_FEATURE = 'owner-rules' as const;
export const PHONE_RELAY_FEATURE = 'phone-relay' as const;
export const ACCESS_FEATURES = [
  AGENT_FEATURE,
  /** Maintained Agent profiles from the Nectovia catalog. */
  'maintained-profiles',
  /** Diomedes-funded model calls, within the organization's funding. */
  'managed-inference',
  /** A project's instruction files, the Console's rules and trigger rules reach the work. */
  OWNER_RULES_FEATURE,
  /** A person's phone may reach this business's computers through the account service relay. */
  PHONE_RELAY_FEATURE,
] as const;
export type AccessFeature = (typeof ACCESS_FEATURES)[number];

export const FEATURE_LABELS: Record<AccessFeature, string> = {
  'nectovia-agent': 'Nectovia Agent',
  'maintained-profiles': 'Maintained Agent profiles',
  'managed-inference': 'Included AI usage',
  'owner-rules': 'Business rules',
  'phone-relay': 'Phone access',
};

export const isAccessFeature = (value: unknown): value is AccessFeature =>
  typeof value === 'string' && (ACCESS_FEATURES as readonly string[]).includes(value);

// --- plans ---------------------------------------------------------------------

/**
 * Plan templates an operator issues a feature grant from. A plan is a template,
 * not an entitlement: what a business holds is the grant's own feature list, so
 * a negotiated agreement can hold less (or more) than a template without a
 * special case. Plan ids match `MONTHLY_CREDIT_GRANTS` in `shared/managed-usage.ts`
 * where one exists, so a grant and its monthly credits name the same plan.
 */
export interface PlanTemplate {
  id: string;
  label: string;
  features: readonly AccessFeature[];
  /** Default grant length, in days. Null: the operator must choose an end date. */
  termDays: number | null;
  /** Whether customers see this plan by name. Internal plans read as "Internal access". */
  customerVisible: boolean;
  note: string;
}

export const PLAN_TEMPLATES: readonly PlanTemplate[] = Object.freeze([
  {
    id: 'business',
    label: 'Business',
    features: ['nectovia-agent', 'maintained-profiles', 'managed-inference', 'owner-rules', 'phone-relay'],
    termDays: 31,
    customerVisible: true,
    note: 'The $300/month Business subscription. Monthly credits come from the funding service.',
  },
  {
    id: 'workflow-starter',
    label: '90-Day Workflow Starter',
    features: ['nectovia-agent', 'maintained-profiles', 'managed-inference', 'owner-rules', 'phone-relay'],
    termDays: 92,
    customerVisible: true,
    note: '$250/month for three months, one workflow or location. Never add Business on top.',
  },
  {
    id: 'managed-small',
    label: 'Managed Small',
    features: ['nectovia-agent', 'maintained-profiles', 'managed-inference', 'owner-rules', 'phone-relay'],
    termDays: 31,
    customerVisible: true,
    note: 'Business included.',
  },
  {
    id: 'managed-standard',
    label: 'Managed Standard',
    features: ['nectovia-agent', 'maintained-profiles', 'managed-inference', 'owner-rules', 'phone-relay'],
    termDays: 31,
    customerVisible: true,
    note: 'Business included.',
  },
  {
    id: 'managed-plus',
    label: 'Managed Plus',
    features: ['nectovia-agent', 'maintained-profiles', 'managed-inference', 'owner-rules', 'phone-relay'],
    termDays: 31,
    customerVisible: true,
    note: 'Business included.',
  },
  {
    id: 'service-agreement',
    label: 'Service agreement',
    features: ['nectovia-agent', 'maintained-profiles', 'owner-rules', 'phone-relay'],
    termDays: null,
    customerVisible: true,
    note: 'What a quoted implementation explicitly grants. Choose the features and end date from the agreement; funding is separate.',
  },
  {
    id: 'internal-test',
    label: 'Internal test',
    features: ['nectovia-agent', 'maintained-profiles', 'owner-rules', 'phone-relay'],
    termDays: 30,
    customerVisible: false,
    note: 'Diomedes staff and test accounts. No included usage unless funding is added separately.',
  },
] satisfies PlanTemplate[]);

export function planTemplate(id: string | null | undefined): PlanTemplate | undefined {
  return PLAN_TEMPLATES.find((plan) => plan.id === id);
}

/** A plan's customer-facing name, or a neutral one for plans customers do not see. */
export function planLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  const plan = planTemplate(id);
  if (!plan) return id;
  return plan.customerVisible ? plan.label : 'Internal access';
}

/** Where a grant came from. A paid audit is not a source: it buys an assessment. */
export const GRANT_SOURCES = [
  'subscription',
  'service-agreement',
  'internal-test',
  'courtesy',
] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

// --- customer roles ------------------------------------------------------------

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: 'Business owner',
  admin: 'Manager',
  member: 'Employee',
};

export function roleLabel(role: MemberRole | null | undefined): string {
  return role ? ROLE_LABELS[role] : 'No role';
}

/** What a role may manage in its own organization. Never a feature, never a staff role. */
export interface RoleCapabilities {
  /** See the plan, grants and billing. */
  seePlan: boolean;
  /** Invite and remove people: everyone, Employees only, or nobody. */
  managePeople: 'everyone' | 'employees' | 'nobody';
  /** Configure how the business works: setup, where work is written, access profiles. */
  configure: boolean;
}

export const ROLE_CAPABILITIES: Record<MemberRole, RoleCapabilities> = {
  owner: { seePlan: true, managePeople: 'everyone', configure: true },
  admin: { seePlan: false, managePeople: 'employees', configure: true },
  member: { seePlan: false, managePeople: 'nobody', configure: false },
};

/**
 * Whether an actor may invite someone into a role. Owners invite anyone; a
 * Manager invites Employees only (Andrew, 2026-09-25). An inactive actor
 * invites nobody.
 */
export function canInviteRole(actor: MemberRole | null, active: boolean, role: MemberRole): boolean {
  if (!active || !actor) return false;
  if (actor === 'owner') return true;
  if (actor === 'admin') return role === 'member';
  return false;
}

/**
 * Whether an actor may change a member. An owner may change anyone (the
 * last-owner rule is enforced where the change is written). A Manager may only
 * remove an Employee, and may not change anyone's role — so a Manager can never
 * promote anyone, including themselves.
 */
export function canChangeMember(input: {
  actor: MemberRole | null;
  actorActive: boolean;
  actorPersonId: string;
  target: MemberRole;
  targetPersonId: string;
  change: { role: MemberRole; state: 'active' | 'revoked' };
}): boolean {
  if (!input.actorActive || !input.actor) return false;
  if (input.actor === 'owner') return true;
  if (input.actor !== 'admin') return false;
  if (input.targetPersonId === input.actorPersonId) return false;
  return input.target === 'member' && input.change.role === 'member' && input.change.state === 'revoked';
}

// --- staff roles ---------------------------------------------------------------

/** Diomedes company staff, in the private Operations app. Never a customer role. */
export const STAFF_ROLES = ['support', 'billing', 'routing', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  support: 'Support',
  billing: 'Billing',
  routing: 'Routing',
  admin: 'Admin',
};

export const STAFF_PERMISSIONS = [
  'customers.read',
  'grants.write',
  'funding.write',
  'routes.write',
  'policy.publish',
  'staff.write',
] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

const STAFF_MATRIX: Record<StaffRole, readonly StaffPermission[]> = {
  support: ['customers.read'],
  billing: ['customers.read', 'grants.write', 'funding.write'],
  routing: ['customers.read', 'routes.write', 'policy.publish'],
  admin: [...STAFF_PERMISSIONS],
};

export function staffCan(role: StaffRole | null | undefined, permission: StaffPermission): boolean {
  return !!role && STAFF_MATRIX[role].includes(permission);
}

export function staffPermissions(role: StaffRole): readonly StaffPermission[] {
  return STAFF_MATRIX[role];
}

// --- the customer's access view ------------------------------------------------

export type AccessState = 'none' | 'active' | 'expired' | 'revoked' | 'unknown';

/** One grant as the customer's owner reads it. Employees and Managers see none of these. */
export interface GrantSummary {
  id: string;
  planId: string | null;
  planLabel: string | null;
  features: readonly AccessFeature[];
  source: GrantSource;
  validFrom: string;
  validUntil: string;
  state: AccessState;
}

/** What `GET /account/organizations/:id/access` answers for one member. */
export interface AccessView {
  v: typeof ACCESS_CONTRACT_VERSION;
  organizationId: string;
  role: MemberRole;
  roleLabel: string;
  capabilities: RoleCapabilities;
  state: AccessState;
  /** The customer-visible plan name, or null. Shown to every member; the grant detail is not. */
  planLabel: string | null;
  planId: string | null;
  features: readonly AccessFeature[];
  agent: { included: boolean; reason: string };
  validFrom: string | null;
  validUntil: string | null;
  /** Monotonic across grant changes, so a stale reader can tell. */
  revision: number;
  /** Present only when `capabilities.seePlan`. */
  grants: readonly GrantSummary[] | null;
  checkedAt: string;
}

/** The sentence a person reads when the Agent is not part of their workspace. */
export const AGENT_NOT_INCLUDED_REASON =
  'The Nectovia Agent is part of a Business plan. You can still use your workspace and your own AI tools directly.';
export const AGENT_PERSONAL_REASON =
  'The Nectovia Agent works for a business. Switch to a business workspace that includes it, or use your own AI tools directly.';
