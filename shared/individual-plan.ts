/**
 * The Individual plan (Andrew, 2026-09-28): a person's own subscription.
 *
 * A business plan is issued to an organization; the Individual plan is issued to a person, never to
 * an organization. It covers the person's Personal work and projects not linked to a business, and a
 * business workspace only while the holder is its only active member (the sole proprietor). The
 * member threshold is a control-plane setting, INDIVIDUAL_MAX_ACTIVE_MEMBERS, so it is data, not code.
 *
 * Included AI usage ('managed-inference') is not part of the plan yet: funding is keyed to an
 * organization today, and funding a person is a separate migration (phase 2b). So the grant carries
 * the Agent, maintained profiles, owner rules and phone access, and the company route refuses
 * Personal work in the person's own words.
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

export const INDIVIDUAL_PLAN_ID = 'individual' as const;
export const INDIVIDUAL_PLAN_LABEL = 'Individual' as const;

/** Shown wherever the plan is offered or issued. Exact wording (Andrew, 2026-09-28). */
export const INDIVIDUAL_ELIGIBILITY_SENTENCE = "Businesses beyond a sole proprietorship aren't eligible for this plan.";

/** A catalog plan: a template, and whether it is issued to an organization or to a person. */
export type CatalogPlan = PlanTemplate & { scope: 'organization' | 'person' };

export const INDIVIDUAL_PLAN: CatalogPlan = Object.freeze({
  id: INDIVIDUAL_PLAN_ID,
  label: INDIVIDUAL_PLAN_LABEL,
  features: Object.freeze(['nectovia-agent', 'maintained-profiles', 'owner-rules', 'phone-relay']) as readonly AccessFeature[],
  termDays: 31,
  customerVisible: true,
  note: `A person's own monthly subscription, issued to a person and never to a business. ${INDIVIDUAL_ELIGIBILITY_SENTENCE} Included AI usage is not part of it yet.`,
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
  /** The most active members a business may have for an Individual grant to cover it. */
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
 * business is covered only while its active members are within the threshold.
 */
export function individualCovers(input: { grantActive: boolean; organizationActiveMembers: number | null; maxActiveMembers: number }): boolean {
  if (!input.grantActive) return false;
  if (input.organizationActiveMembers === null) return true;
  return input.organizationActiveMembers >= 1 && input.organizationActiveMembers <= input.maxActiveMembers;
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
 * A business's access view as the service answers it now: `coveredBy` is present when the member's
 * own Individual plan covers the business, and the owner's grant list then marks that grant as the
 * person's with `scope: 'person'`.
 */
export type CoveredAccessView = Omit<AccessView, 'grants'> & {
  grants: readonly (GrantSummary & { scope?: 'person' })[] | null;
  coveredBy?: 'individual';
};

// --- sentences ---------------------------------------------------------------------

/** Personal work, for a person who holds the Agent through a business but has no Individual plan. */
export const AGENT_PERSONAL_INDIVIDUAL_REASON =
  "The Nectovia Agent isn't part of your personal work here. It comes with an Individual plan of your own, or with a business workspace that includes it. Nothing was sent.";

/** The company route, for work an Individual plan covers. Included usage is not part of the plan yet. */
export const MANAGED_USAGE_NOT_INCLUDED_PERSONAL =
  "Included AI usage isn't part of the Individual plan yet, so the Nectovia Agent can't answer on the company route here. Your own connections still work. Nothing was sent.";

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
