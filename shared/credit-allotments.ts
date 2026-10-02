/**
 * Per-member monthly credit limits (Andrew, 2026-10-01). Pure: no ledger, no network, no clock.
 *
 * A business has one shared credit pool, included usage first and then credits it bought. Each
 * member also has a monthly limit on how much of that pool they may use, always on, reset with
 * the plan period and never weekly. A limit comes from the member's role, with a per-person
 * override. When a member's work would go past their limit it stops and asks an owner or admin,
 * who may approve one job or raise that person's month, and may let the approval draw on bought
 * credits. Only an owner or admin buys credits, and bought credits lift a member past their limit
 * only with that approval.
 *
 * Money crosses this module as exact micro-USD and is said as credits. A limit is never a figure
 * a client sends for itself: the server reads limits and usage from its own rows.
 */
import {
  MAX_MONEY_MICRO_USD,
  creditAmount,
  formatCredits,
  micro,
  type MicroUsd,
} from './managed-usage.js';
import type { MemberRole } from './workspaces.js';

/** The refusal code a member's work stops with. A client that knows it can offer to ask. */
export const MEMBER_LIMIT_REACHED = 'member_limit_reached';

export const LIMIT_MODES = ['limit', 'unlimited', 'inherit'] as const;
/**
 * `limit`: this many credits a month. `unlimited`: no limit beyond the shared pool. `inherit`:
 * no setting of its own, so the next place down decides (a person row falls back to their role,
 * a role row falls back to the default below).
 */
export type LimitMode = (typeof LIMIT_MODES)[number];

/** Roles a limit can be set for. Owners are limited only by a per-person setting an owner makes. */
export const LIMITABLE_ROLES = ['member', 'admin'] as const;
export type LimitableRole = (typeof LIMITABLE_ROLES)[number];

export type LimitSubject =
  | { readonly kind: 'role'; readonly role: LimitableRole }
  | { readonly kind: 'person'; readonly personId: string };

/**
 * Plan-specific default member limits, in whole credits a month. THIS IS THE ONE PLACE tier
 * defaults are set. It is empty on purpose: no figure here has been decided yet, and none is
 * invented. A plan with no entry gives a member the business's whole monthly included allowance
 * for that plan, so a limit is on from the first day and never binds tighter than the pool until
 * an owner lowers it.
 */
export const PLAN_MEMBER_LIMIT_CREDITS: Readonly<Record<string, number>> = Object.freeze({});

/**
 * What a role is held to when nobody has set anything: a member, the plan's whole monthly
 * allowance (or the plan's entry above); an owner or admin, nothing beyond the shared pool, until
 * an owner sets a limit for them. Null means no limit.
 */
export function defaultLimitFor(input: {
  role: MemberRole;
  planId: string;
  monthlyGrantMicroUsd: MicroUsd;
}): MicroUsd | null {
  if (input.role !== 'member') return null;
  const credits = PLAN_MEMBER_LIMIT_CREDITS[input.planId];
  return credits === undefined ? input.monthlyGrantMicroUsd : creditAmount(credits);
}

export interface LimitSetting {
  readonly subjectKind: 'role' | 'person';
  /** A role name, or a person id. */
  readonly subjectId: string;
  readonly mode: LimitMode;
  /** Present exactly when the mode is `limit`. */
  readonly limitMicroUsd: MicroUsd | null;
}

export interface EffectiveLimit {
  /** Null means no limit beyond the shared pool. */
  readonly limitMicroUsd: MicroUsd | null;
  readonly source: 'person' | 'role' | 'default';
}

const settled = (row: LimitSetting | undefined): EffectiveLimit | null => {
  if (!row || row.mode === 'inherit') return null;
  return { limitMicroUsd: row.mode === 'unlimited' ? null : row.limitMicroUsd, source: row.subjectKind };
};

/** A person's override wins, then their role's setting, then the plan default. */
export function effectiveLimit(input: {
  role: MemberRole;
  personId: string;
  settings: readonly LimitSetting[];
  planId: string;
  monthlyGrantMicroUsd: MicroUsd;
}): EffectiveLimit {
  const person = input.settings.find((row) => row.subjectKind === 'person' && row.subjectId === input.personId);
  const role = input.settings.find((row) => row.subjectKind === 'role' && row.subjectId === input.role);
  return (
    settled(person) ??
    settled(role) ?? {
      limitMicroUsd: defaultLimitFor({
        role: input.role,
        planId: input.planId,
        monthlyGrantMicroUsd: input.monthlyGrantMicroUsd,
      }),
      source: 'default',
    }
  );
}

/** What an owner's or admin's approvals add for one member, this month and this job. */
export interface Allowance {
  /** Added to the limit. A one-job approval adds up to that job's own cap; a month approval, what the approver chose. */
  readonly extraMicroUsd: MicroUsd;
  /** Whether the approval lets this member draw on credits the business bought. */
  readonly allowPurchased: boolean;
}

export type MemberUseDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: typeof MEMBER_LIMIT_REACHED;
      readonly reason: string;
      readonly usedMicroUsd: MicroUsd;
      readonly limitMicroUsd: MicroUsd;
      /** What the refused step would take the member to, past their limit. 0 when the limit was not the problem. */
      readonly overByMicroUsd: MicroUsd;
      /** True when the step fit but would draw bought credits nobody approved for this member. */
      readonly needsPurchasedApproval: boolean;
    };

/** The words a member reads when their limit stops a step. Ends with who can approve more. */
export function limitReachedReason(input: {
  usedMicroUsd: MicroUsd;
  limitMicroUsd: MicroUsd;
  reserveMicroUsd: MicroUsd;
}): string {
  return (
    `This step needs up to ${formatCredits(input.reserveMicroUsd)} credits, and you’ve used ${formatCredits(input.usedMicroUsd)} ` +
    `of the ${formatCredits(input.limitMicroUsd)} set for you this month. An owner or admin can approve more.`
  );
}

export const PURCHASED_APPROVAL_REASON =
  'This step would use credits your business bought, and an owner or admin hasn’t approved that for you yet.';

/**
 * Whether a member's next step fits their limit. `usedMicroUsd` already counts everything the
 * member holds or has settled this period, from included and bought credits alike (held at its
 * ceiling, settled at cost). `purchasedMicroUsd` is the part of this step the pool would draw
 * from bought credits. A step that fits the limit is admitted as it is today. Past it, an
 * approval has to cover the step, and has to allow bought credits if the step would use them.
 * The shared pool's own checks (funds, job cap) have already run.
 */
export function decideMemberUse(input: {
  limitMicroUsd: MicroUsd | null;
  usedMicroUsd: MicroUsd;
  reserveMicroUsd: MicroUsd;
  purchasedMicroUsd: MicroUsd;
  allowance: Allowance;
}): MemberUseDecision {
  if (input.limitMicroUsd === null) return { ok: true };
  const after = input.usedMicroUsd + input.reserveMicroUsd;
  if (after <= input.limitMicroUsd) return { ok: true };
  const allowed = input.limitMicroUsd + input.allowance.extraMicroUsd;
  const overBy = micro(Math.min(MAX_MONEY_MICRO_USD, after - input.limitMicroUsd));
  if (after > allowed)
    return {
      ok: false,
      code: MEMBER_LIMIT_REACHED,
      reason: limitReachedReason({
        usedMicroUsd: input.usedMicroUsd,
        limitMicroUsd: input.limitMicroUsd,
        reserveMicroUsd: input.reserveMicroUsd,
      }),
      usedMicroUsd: input.usedMicroUsd,
      limitMicroUsd: input.limitMicroUsd,
      overByMicroUsd: overBy,
      needsPurchasedApproval: false,
    };
  if (input.purchasedMicroUsd > 0 && !input.allowance.allowPurchased)
    return {
      ok: false,
      code: MEMBER_LIMIT_REACHED,
      reason: PURCHASED_APPROVAL_REASON,
      usedMicroUsd: input.usedMicroUsd,
      limitMicroUsd: input.limitMicroUsd,
      overByMicroUsd: overBy,
      needsPurchasedApproval: true,
    };
  return { ok: true };
}

// --- what the account service and the desktop exchange --------------------------------------

export const LIMIT_REQUEST_KINDS = ['job', 'month'] as const;
/** `job`: let this one job finish. `month`: raise this person's limit for the rest of the month. */
export type LimitRequestKind = (typeof LIMIT_REQUEST_KINDS)[number];
export type LimitRequestState = 'pending' | 'approved' | 'denied';

/** One person's usage this month, in micro-USD. The client shows credits. */
export interface MemberUsageView {
  readonly usedMicroUsd: number;
  readonly includedMicroUsd: number;
  readonly purchasedMicroUsd: number;
  /** Of the used figure, what is held for work still running. */
  readonly heldMicroUsd: number;
}

export interface LimitRequestView {
  readonly requestId: string;
  readonly personId: string;
  readonly kind: LimitRequestKind;
  readonly jobId: string | null;
  readonly state: LimitRequestState;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  /** What an approval added to the limit. Null while pending or when denied. */
  readonly extraMicroUsd: number | null;
  readonly allowPurchased: boolean;
  readonly periodId: string | null;
}

/** A member's own page: their usage against their own limit, never the pool and never anyone else. */
export type MyCreditUsage =
  | { readonly state: 'hidden'; readonly organizationId: string; readonly reason: string }
  | {
      readonly state: 'ready';
      readonly organizationId: string;
      readonly periodId: string;
      readonly resetsAt: string;
      readonly usage: MemberUsageView;
      /** Null means no limit beyond the shared pool. */
      readonly limitMicroUsd: number | null;
      /** What approvals added to the limit this month. */
      readonly raisedByMicroUsd: number;
      readonly requests: readonly LimitRequestView[];
    }
  | { readonly state: 'unavailable'; readonly organizationId: string; readonly reason: string };
