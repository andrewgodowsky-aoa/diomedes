/**
 * Check-in amounts: how many credits a job may use before it stops to ask whether to keep going.
 *
 * A job is never cut off mid-call or mid-write (Andrew, 2026-10-05). Every call holds its worst case
 * before it is sent, so a call that starts always finishes and is paid for. What a tier's amount
 * bounds is how far a job runs before it checks in: when the next hold would cross the job's current
 * amount, the job finishes the step in progress, saves, and asks. Keep going raises that one job by
 * exactly one more amount. Stop ends it with its work kept. The account's balance and each member's
 * monthly limit still apply to every step.
 *
 * The amount for a tier comes from the first of these that has one:
 *
 * 1. the business's own setting, which its owners and admins make and which applies to that business
 *    alone;
 * 2. the defaults Diomedes staff publish in the account service, versioned and audited;
 * 3. the code default (`JOB_CHECK_IN_CREDITS`): Efficient 100, Focused 250, Thorough 500.
 *
 * Amounts are whole credits. The account service resolves them, so no request field and no desktop
 * can name one: a desktop only reads what the service resolved.
 */
import { z } from 'zod';
import {
  JOB_CHECK_IN_CREDITS,
  JOB_TIERS,
  MONTHLY_CREDIT_GRANTS,
  creditAmount,
  type JobTier,
  type MicroUsd,
} from './managed-usage.js';
import { EXPERT_FEATURE, managedGrantFeatures } from './access.js';

/** The most a check-in amount can be set to. A business's whole pool is far smaller. */
export const MAX_CHECK_IN_CREDITS = 100_000;

const credits = z.number().int().min(1).max(MAX_CHECK_IN_CREDITS);

/** Credits per tier. */
export type CheckInCredits = Readonly<Record<Exclude<JobTier, 'expert'>, number> & { expert?: number }>;

/** All three tiers, each a whole number of credits. */
export const checkInAmountsSchema = z.strictObject({ efficient: credits, focused: credits, thorough: credits, expert: credits.optional() });

/** One published version of the staff defaults. Append-only: a change is a new version. */
export const checkInDefaultsSchema = z.strictObject({
  v: z.literal(1),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  amounts: checkInAmountsSchema.extend({ expert: credits.nullable().optional() }),
  note: z.string().trim().min(1).max(1000),
  publishedAt: z.iso.datetime(),
  publishedBy: z.string().min(1).max(128),
});
export type CheckInDefaults = z.infer<typeof checkInDefaultsSchema>;

/** What staff send to publish a version. `baseVersion` is the version they read (0 for none). */
export const publishCheckInDefaultsInput = z.strictObject({
  baseVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  amounts: checkInAmountsSchema.extend({ expert: credits.nullable().optional() }),
  note: z.string().trim().min(1).max(1000),
});
export type PublishCheckInDefaultsInput = z.infer<typeof publishCheckInDefaultsInput>;

/** A business's own amounts. A tier left null uses the defaults. */
export const checkInOverrideAmountsSchema = z.strictObject({
  efficient: credits.nullable(),
  focused: credits.nullable(),
  thorough: credits.nullable(),
  expert: credits.nullable().optional(),
});
export type CheckInOverrideAmounts = z.infer<typeof checkInOverrideAmountsSchema>;

/** What an owner or admin sends. Every tier is named, so a change is never a partial guess. */
export const setCheckInOverrideInput = z.strictObject({ amounts: checkInOverrideAmountsSchema });
export type SetCheckInOverrideInput = z.infer<typeof setCheckInOverrideInput>;

/** One business's stored setting. */
export const checkInOverrideSchema = z.strictObject({
  tenantId: z.string().min(1).max(128),
  organizationId: z.string().min(1).max(128),
  amounts: checkInOverrideAmountsSchema,
  updatedBy: z.string().min(1).max(128),
  updatedAt: z.iso.datetime(),
});
export type CheckInOverride = z.infer<typeof checkInOverrideSchema>;

export type CheckInSource = 'business' | 'staff' | 'code' | 'plan';

/** The plan's included API allowance determines Expert's default, never bought credits. */
export function expertPlanCheckIn(grants: readonly {
  planId: string | null; features: readonly string[]; state: string; validFrom: string; validUntil: string;
}[], at: number): number | undefined {
  const allowances = grants.filter((grant) => grant.state === 'active' &&
    Date.parse(grant.validFrom) <= at && at < Date.parse(grant.validUntil) &&
    managedGrantFeatures(grant).includes(EXPERT_FEATURE))
    .map((grant) => MONTHLY_CREDIT_GRANTS.find((plan) => plan.planId === grant.planId)?.monthlyCredits)
    .filter((amount): amount is number => typeof amount === 'number');
  if (!allowances.length) return undefined;
  // Owner decision 2026-10-06: 750 at Managed Small's 3,000; 1,000 at Plus's 8,000.
  const allowance = Math.max(...allowances);
  return Math.min(1_000, Math.max(750, 750 + Math.floor((allowance - 3_000) * 250 / 5_000)));
}

/** The amounts one account's jobs check in at, and where each came from. */
export interface ResolvedCheckIns {
  readonly credits: CheckInCredits;
  readonly source: Readonly<Record<Exclude<JobTier, 'expert'>, CheckInSource> & { expert?: CheckInSource }>;
  /** The staff defaults version in force, or null when staff have published none. */
  readonly defaultsVersion: number | null;
}

/** The code defaults alone: what an account with no staff version and no setting of its own gets. */
export function codeCheckIns(): ResolvedCheckIns {
  return {
    credits: { ...JOB_CHECK_IN_CREDITS.credits },
    source: { efficient: 'code', focused: 'code', thorough: 'code', expert: 'code' },
    defaultsVersion: null,
  };
}

/** The business's setting, else the staff defaults, else the code default, for each tier. */
export function resolveCheckIns(
  defaults: Pick<CheckInDefaults, 'version' | 'amounts'> | null | undefined,
  override: CheckInOverrideAmounts | null | undefined,
  expertPlanAmount?: number,
): ResolvedCheckIns {
  const out = { ...JOB_CHECK_IN_CREDITS.credits } as Record<JobTier, number>;
  const source = { efficient: 'code', focused: 'code', thorough: 'code', expert: 'code' } as Record<JobTier, CheckInSource>;
  if (expertPlanAmount !== undefined) {
    out.expert = credits.parse(expertPlanAmount);
    source.expert = 'plan';
  }
  for (const tier of JOB_TIERS) {
    const own = override?.[tier];
    if (typeof own === 'number') {
      out[tier] = own;
      source[tier] = 'business';
    } else if (typeof defaults?.amounts[tier] === 'number') {
      out[tier] = defaults.amounts[tier] as number;
      source[tier] = 'staff';
    }
  }
  return { credits: out, source, defaultsVersion: defaults?.version ?? null };
}

/** A tier's check-in amount as exact money. */
export function checkInAmount(resolved: Pick<ResolvedCheckIns, 'credits'>, tier: JobTier): MicroUsd {
  return creditAmount(resolved.credits[tier] ?? JOB_CHECK_IN_CREDITS.credits[tier]);
}

/** What the account service answers when a signed-in member reads their account's amounts. */
export const checkInView = z.strictObject({
  amounts: checkInAmountsSchema,
  source: z.strictObject({
    efficient: z.enum(['business', 'staff', 'code', 'plan']),
    focused: z.enum(['business', 'staff', 'code', 'plan']),
    thorough: z.enum(['business', 'staff', 'code', 'plan']),
    expert: z.enum(['business', 'staff', 'code', 'plan']).optional(),
  }),
  defaultsVersion: z.number().int().min(1).nullable(),
});
export type CheckInView = z.infer<typeof checkInView>;

/** What an owner or admin reads in Settings: the resolved amounts, the defaults, and their own setting. */
export const checkInSettingsView = z.strictObject({
  effective: checkInView,
  /** What each tier is without the business's setting. */
  defaults: checkInAmountsSchema,
  override: checkInOverrideAmountsSchema,
  updatedAt: z.iso.datetime().nullable(),
});
export type CheckInSettingsView = z.infer<typeof checkInSettingsView>;

export function viewOf(resolved: ResolvedCheckIns): CheckInView {
  return { amounts: { ...resolved.credits }, source: { ...resolved.source }, defaultsVersion: resolved.defaultsVersion };
}

/** What the account service answers when one job asks to keep going. */
export const keepGoingAnswer = z.strictObject({
  jobId: z.string().min(1).max(128),
  /** The job's cap after this check-in, in ledger units. */
  capMicroUsd: z.number().int().min(1),
  /** Whole credits one check-in adds for this job's tier. */
  addedCredits: z.number().int().min(1),
  /** False when this check-in was already granted: the answer is the same, nothing is added twice. */
  raised: z.boolean(),
});
export type KeepGoingAnswer = z.infer<typeof keepGoingAnswer>;
