/**
 * The Individual plan (Andrew, 2026-09-28): a person's own subscription.
 *
 * A business plan is issued to an organization; the Individual plan is issued to a person, never to
 * an organization. It covers the person's Personal work and projects not linked to a business.
 * Business work always needs its own Business authority, including a one-member business.
 *
 * The full Individual plan includes 1,000 credits per monthly billing period on its own billing
 * scope. A period is a subscription-anniversary calendar month in UTC (shared/individual-period.ts);
 * unused included credits expire at its end and are never carried forward. Limited feature grants
 * retain their explicit scope and dates. Legacy admission has no billing-scope pin and
 * continues to refuse managed work; scoped admission and dispatch check current person access.
 *
 * This module sits beside shared/access.ts rather than inside it while another lane holds that file.
 * Phase 2b folds INDIVIDUAL_PLAN into PLAN_TEMPLATES. The app shows no price for any plan: the public
 * site's pricing registry is the pricing authority.
 */
import {
  AGENT_FEATURE,
  AGENT_FREE_VERSION_REASON,
  PLAN_TEMPLATES,
  type AccessFeature,
  type AccessState,
  type AccessView,
  type GrantSource,
  type GrantSummary,
  type PlanTemplate,
} from './access.js';
import type { IndividualBillingCycle } from './individual-period.js';
import type { UsageState } from './managed-usage.js';

export const INDIVIDUAL_PLAN_ID = 'individual' as const;
export const INDIVIDUAL_PLAN_LABEL = 'Individual' as const;

/** Shown wherever the plan is offered or issued. Exact wording (Andrew, 2026-09-28). */
export const INDIVIDUAL_ELIGIBILITY_SENTENCE = 'Individual covers Personal work only. Every Business workspace needs its own Business plan, including a sole proprietorship.';
/**
 * The plan and a business are kept apart (Andrew, 2026-09-28): a member of a business never uses their
 * own Individual plan for that business's work, even one they pay for themselves. The coverage rule
 * enforces it; this sentence says it wherever the plan is offered or issued.
 */
export const INDIVIDUAL_SEPARATION_SENTENCE =
  "It covers your own work only. If you belong to a business, that business's work runs on the business's plan, even if you would pay for this one yourself.";

/**
 * A catalog plan: a template, and whether it is issued to an organization or to a person. Only the
 * Individual plan renews by `billingInterval: 'month'`; every other plan keeps its `termDays`.
 */
export type CatalogPlan = PlanTemplate & { scope: 'organization' | 'person'; billingInterval?: 'month' };

/** The complete phase-2a template, retained to recognize existing subscriptions without rewriting grants. */
const INDIVIDUAL_ACCESS_FEATURES: readonly AccessFeature[] = Object.freeze([
  'nectovia-agent', 'maintained-profiles', 'owner-rules', 'phone-relay',
]);

/** Limited feature overrides are not silently upgraded to the complete Individual offer. */
export function individualIncludesMonthlyCredits(grant: { planId: string | null; features: readonly string[] }): boolean {
  return grant.planId === INDIVIDUAL_PLAN_ID && grant.features.includes(AGENT_FEATURE) &&
    (grant.features.includes('managed-inference') || INDIVIDUAL_ACCESS_FEATURES.every(feature => grant.features.includes(feature)));
}

export const INDIVIDUAL_PLAN: CatalogPlan = Object.freeze({
  id: INDIVIDUAL_PLAN_ID,
  label: INDIVIDUAL_PLAN_LABEL,
  features: Object.freeze([...INDIVIDUAL_ACCESS_FEATURES, 'managed-inference']) as readonly AccessFeature[],
  // No fixed day count: each term runs to the subscription's next monthly anniversary, in UTC.
  termDays: null,
  billingInterval: 'month',
  customerVisible: true,
  note: `A person's own monthly subscription, with 1,000 credits each billing period on their Individual account. Each period runs from the subscription's start to the same day and UTC time next month; unused credits expire at its end. ${INDIVIDUAL_ELIGIBILITY_SENTENCE} ${INDIVIDUAL_SEPARATION_SENTENCE}`,
  scope: 'person',
});

/** Every plan staff may issue: the business templates, then the Individual plan. */
export function planCatalog(): readonly CatalogPlan[] {
  return [...PLAN_TEMPLATES.map((plan): CatalogPlan => ({ ...plan, scope: 'organization' })), INDIVIDUAL_PLAN];
}

export function catalogPlan(id: string | null | undefined): CatalogPlan | undefined {
  return planCatalog().find((plan) => plan.id === id);
}

/** A plan's customer-facing name, as `planLabel` in shared/access.ts answers it, with the Individual plan known. */
export function catalogPlanLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  const plan = catalogPlan(id);
  if (!plan) return id;
  return plan.customerVisible ? plan.label : 'Internal access';
}

/** Whether a plan is issued to a person rather than to a business. */
export function isPersonPlan(id: string | null | undefined): boolean {
  return catalogPlan(id)?.scope === 'person';
}

// --- coverage --------------------------------------------------------------------

export interface IndividualCoverage {
  /** Legacy configuration retained for compatibility; it never enables Business coverage. */
  maxActiveMembers: number;
}

export const INDIVIDUAL_COVERAGE_DEFAULTS: Readonly<IndividualCoverage> = Object.freeze({ maxActiveMembers: 1 });

/**
 * INDIVIDUAL_MAX_ACTIVE_MEMBERS, read as the control plane reads its other whole-number settings:
 * unset or blank is the default, and anything that is not a whole number of at least 1 is refused
 * rather than guessed. A threshold that ignored a typo would not be a threshold.
 */
export function readIndividualCoverage(value: string | number | undefined | null): IndividualCoverage {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return { ...INDIVIDUAL_COVERAGE_DEFAULTS };
  const count = typeof value === 'number' ? value
    : /^[0-9]{1,6}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100_000)
    throw new RangeError('INDIVIDUAL_MAX_ACTIVE_MEMBERS must be a whole number of at least 1.');
  return { maxActiveMembers: count };
}

/**
 * Whether an Individual grant covers a piece of work. `organizationActiveMembers` is null for
 * Personal work and projects not linked to a business, which an active grant always covers. A
 * business is never covered, regardless of the legacy member threshold.
 */
export function individualCovers(input: { grantActive: boolean; organizationActiveMembers: number | null; maxActiveMembers: number }): boolean {
  return input.grantActive && input.organizationActiveMembers === null;
}

// --- the person's access view --------------------------------------------------------

/** One Individual grant as its holder reads it. */
export interface PersonGrantSummary {
  id: string;
  personId: string;
  planId: string | null;
  planLabel: string | null;
  features: readonly AccessFeature[];
  source: GrantSource;
  validFrom: string;
  validUntil: string;
  state: AccessState;
  /** The verified monthly term a complete plan grant pays for. Absent on legacy and limited grants. */
  billingCycle?: IndividualBillingCycle;
}

/** What `GET /account/access` answers: the signed-in person's own Individual access. */
export interface PersonAccessView {
  v: 1;
  personId: string;
  state: AccessState;
  planId: string | null;
  planLabel: string | null;
  features: readonly AccessFeature[];
  agent: { included: boolean; reason: string };
  validFrom: string | null;
  validUntil: string | null;
  /** Monotonic across the person's grant changes. */
  revision: number;
  grants: readonly PersonGrantSummary[];
  checkedAt: string;
}

/**
 * What `GET /account/usage` answers: the signed-in person's own Individual credits for the billing
 * period in force now. Read-only; it never records a period. `usage` is `unavailable`, never a
 * zero, whenever no current period can be verified.
 */
export interface PersonalUsageView {
  v: 1;
  personId: string;
  /** The person's own Individual billing account, or null before one exists. */
  accountId: string | null;
  usage: UsageState;
  /**
   * Whether the next billing period is already paid for (Billing records each paid term). Null when
   * no monthly period is current. `not-renewed` means a new allowance needs a renewal: nothing is
   * promised merely because the clock reaches `resetsAt`.
   */
  renewal: { state: 'renewed' | 'not-renewed'; nextStartsAt: string; nextEndsAt: string } | null;
  checkedAt: string;
}

/**
 * Historical Business snapshots may carry Individual attribution. Retain their readable shape;
 * new Business access views never derive authority from a person's plan.
 */
export type CoveredAccessView = Omit<AccessView, 'grants'> & {
  grants: readonly (GrantSummary & { scope?: 'person' })[] | null;
  coveredBy?: 'individual';
};

// --- sentences ---------------------------------------------------------------------

/** Personal work, for a person who holds the Agent through a business but has no Individual plan. */
export const AGENT_PERSONAL_INDIVIDUAL_REASON =
  "The Nectovia Agent isn't part of your personal work here. It comes with an Individual plan of your own, or with a business workspace that includes it. Nothing was sent.";

/** Legacy Personal admission cannot bind a managed request to its Individual billing scope. */
export const MANAGED_USAGE_NOT_INCLUDED_PERSONAL =
  'Managed Personal work requires Individual account routing and setup. Refresh your account in a current app to continue. Nothing was sent.';

/** Staff tried to issue the Individual plan to a business. */
export const INDIVIDUAL_PLAN_NOT_FOR_BUSINESS =
  `The Individual plan is a person's own subscription and is issued to a person, never to a business. ${INDIVIDUAL_ELIGIBILITY_SENTENCE}`;

/** Staff tried to issue a business plan to a person. */
export const BUSINESS_PLAN_NOT_FOR_PERSON = 'That plan is issued to a business, not to a person.';

/** The person's own access, when they hold no Individual plan. */
export const INDIVIDUAL_NONE_REASON = AGENT_FREE_VERSION_REASON;
export const INDIVIDUAL_EXPIRED_REASON = 'Your Individual plan has ended, so the Nectovia Agent is not available for your personal work. Your files and history are unchanged.';
export const INDIVIDUAL_REVOKED_REASON = 'Your Individual plan was withdrawn, so the Nectovia Agent is not available for your personal work. Your files and history are unchanged.';

/**
 * A person with no Individual plan, as a host records it when the account service it talks to
 * predates Individual plans (its own "action not found" answer): that service issues none.
 */
export function noIndividualAccess(personId: string, at: string): PersonAccessView {
  return {
    v: 1, personId, state: 'none', planId: null, planLabel: null, features: [],
    agent: { included: false, reason: INDIVIDUAL_NONE_REASON },
    validFrom: null, validUntil: null, revision: 0, grants: [], checkedAt: at,
  };
}

/** Whether a person view holds a feature now. */
export function personIncludes(view: PersonAccessView | null | undefined, feature: AccessFeature = AGENT_FEATURE): boolean {
  return view?.state === 'active' && view.features.includes(feature);
}
