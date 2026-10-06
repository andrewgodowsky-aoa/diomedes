/**
 * Job check-ins (Andrew, 2026-10-05): how many credits a job runs before it asks whether to keep going,
 * and the one thing a person can do there, Keep going.
 *
 * The account service is the authority on holds, so it is also the authority on the amount. The
 * gateway reads the same three layers (`resolveCheckIns`) when it opens a job, and this service
 * serves them to the people they concern:
 *
 * - any active member of an account reads the amounts its jobs check in at (so the desktop can say them);
 * - an owner or admin of a business reads and changes the business's own amounts, which apply to that
 *   business alone. Staff set the defaults under `/ops/job-check-ins` (`CommercialService`);
 * - a member whose job reached its amount chooses Keep going, which raises that one job by exactly one
 *   more amount, for the tier the job was opened under (`FundingService.keepGoing`).
 *
 * Nothing in a request names an amount, a tier or a person: the amounts come from settings, the tier
 * from the job, and the person from the verified session. The balance and a member's monthly limit
 * are still checked at every hold, so Keep going lends no credits and lifts no limit.
 */
import { MAX_MONEY_MICRO_USD, micro, type JobTier } from '../../../shared/managed-usage.js';
import { isActiveMember, type Membership } from '../../../shared/workspaces.js';
import type { AccountScope } from '../../../shared/routing-policy.js';
import {
  checkInAmount,
  resolveCheckIns,
  setCheckInOverrideInput,
  viewOf,
  type CheckInSettingsView,
  type CheckInView,
  type KeepGoingAnswer,
  type ResolvedCheckIns,
} from '../../../shared/job-check-ins.js';
import { z } from 'zod';
import type { AccountService } from './account-service.js';
import type { CommercialRepository } from './commercial.js';
import { AccountError } from './errors.js';
import { FundingError, type FundingService } from './funding.js';
import { authorizeScope } from './routing.js';

/** What a person sends to keep a job going: the job, and the cap they saw it stop at. */
export const keepGoingInput = z.strictObject({
  jobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  atCapMicroUsd: z.number().int().min(1).max(MAX_MONEY_MICRO_USD),
});
export type KeepGoingInput = z.infer<typeof keepGoingInput>;

export { setCheckInOverrideInput };

/** Owners and admins manage a business's settings; a member does not. */
const manages = (membership: Membership | undefined | null) => isActiveMember(membership) && (membership!.role === 'owner' || membership!.role === 'admin');

const JOB_TIER_LIST: readonly JobTier[] = ['efficient', 'focused', 'thorough'];

/** Every tier's amount as exact money, for the funding service. */
export const amountsOf = (resolved: ResolvedCheckIns): Record<JobTier, ReturnType<typeof micro>> =>
  Object.fromEntries(JOB_TIER_LIST.map((tier) => [tier, checkInAmount(resolved, tier)])) as Record<JobTier, ReturnType<typeof micro>>;

export class JobCheckInService {
  constructor(
    private readonly accounts: Pick<AccountService, 'signIn' | 'membership'>,
    private readonly repository: CommercialRepository,
    private readonly funding: Pick<FundingService, 'keepGoing'> | null,
    private readonly now: () => number = Date.now,
  ) {}

  private at() {
    return new Date(this.now()).toISOString();
  }

  /** The amounts an account's jobs check in at, for any active member of it. */
  async read(token: string, scope: AccountScope): Promise<CheckInView> {
    const member = await authorizeScope(this.accounts, this.repository, token, scope);
    return viewOf(await this.resolved(member.tenantId, scope));
  }

  private resolved(tenantId: string, scope: AccountScope): Promise<ResolvedCheckIns> {
    return this.repository.transaction(async (tx) =>
      resolveCheckIns(await tx.checkInDefaults(), scope.kind === 'organization' ? (await tx.checkInOverride(tenantId, scope.id))?.amounts : undefined));
  }

  /** An owner or admin: the business's own amounts beside what it would get without them. */
  async settings(token: string, organizationId: string): Promise<CheckInSettingsView> {
    const snapshot = await this.accounts.membership(token, organizationId);
    if (!manages(snapshot.membership))
      throw new AccountError(403, 'Only an owner or an admin can see or change how far a job runs before it checks in.', 'not_authorized');
    return this.settingsView(snapshot.organization.tenantId, organizationId);
  }

  private settingsView(tenantId: string, organizationId: string): Promise<CheckInSettingsView> {
    return this.repository.transaction(async (tx) => {
      const defaults = await tx.checkInDefaults();
      const override = await tx.checkInOverride(tenantId, organizationId);
      return {
        effective: viewOf(resolveCheckIns(defaults, override?.amounts)),
        defaults: { ...resolveCheckIns(defaults, undefined).credits },
        override: override?.amounts ?? { efficient: null, focused: null, thorough: null },
        updatedAt: override?.updatedAt ?? null,
      };
    });
  }

  /**
   * An owner or admin sets the business's own amounts. Every tier is named: a number replaces it, null
   * goes back to the default. It changes the next job a member opens; a job already open keeps the
   * amount it was opened with.
   */
  async setOverride(token: string, organizationId: string, input: z.infer<typeof setCheckInOverrideInput>): Promise<CheckInSettingsView> {
    const snapshot = await this.accounts.membership(token, organizationId);
    if (!manages(snapshot.membership))
      throw new AccountError(403, 'Only an owner or an admin can see or change how far a job runs before it checks in.', 'not_authorized');
    const tenantId = snapshot.organization.tenantId;
    await this.repository.transaction((tx) => tx.saveCheckInOverride({
      tenantId, organizationId, amounts: input.amounts, updatedBy: snapshot.person.id, updatedAt: this.at(),
    }));
    return this.settingsView(tenantId, organizationId);
  }

  /** A member whose job reached its check-in amount chooses to keep going: that one job, one more amount. */
  async keepGoing(token: string, scope: AccountScope, input: KeepGoingInput): Promise<KeepGoingAnswer> {
    if (!this.funding) throw new AccountError(503, 'Account service is unavailable. Try again later.');
    const member = await authorizeScope(this.accounts, this.repository, token, scope);
    const resolved = await this.resolved(member.tenantId, scope);
    try {
      const result = await this.funding.keepGoing({
        tenantId: member.tenantId, organizationId: scope.id, rootJobId: input.jobId, atCapMicroUsd: micro(input.atCapMicroUsd), amounts: amountsOf(resolved),
      });
      const tier = result.job.tier as JobTier;
      return { jobId: result.job.rootJobId, capMicroUsd: result.job.capMicroUsd, addedCredits: resolved.credits[tier], raised: result.raised };
    } catch (error) {
      if (error instanceof FundingError) throw new AccountError(error.status, error.message, error.code);
      throw error;
    }
  }
}
