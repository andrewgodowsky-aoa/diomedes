/**
 * Funded parent-job accounting (NC-2026-09-22.1 Phase C).
 *
 * The control plane is the one authority for tenant credit funding. Money
 * rules, the reservation state table, the reserve decision and the usage
 * projection are the shared contracts in `shared/managed-usage.ts`; this module
 * only sequences them against durable rows.
 *
 * The protocol, per paid attempt:
 *
 *   reserve (txn) -> markDispatched (txn) -> provider call, no txn open ->
 *   settle | markUncertain | cancel | releaseRefused (txn)
 *
 * No method calls a provider, and no method retries a transaction. A caller
 * that sees a failed COMMIT may repeat the same call with the same attempt id:
 * every write is idempotent by its key, so the retry either finds the landed
 * row or writes it once. The one exception is markDispatched, which is
 * exclusive: only the caller whose conditional update moved the attempt may
 * send, and a retry after an unknown COMMIT gets `attempt_in_flight` and must
 * not send.
 *
 * Funding writes are server-to-server seams for the runtime and the verified
 * billing path. None of them is reachable from `worker.ts`; the only HTTP
 * surface is the read-only usage projection.
 */
import {
  RATE_CARD_V1,
  approvedJobCap,
  debitsAllowance,
  isJobTier,
  isUsageClass,
  decideReserve,
  periodIdFor,
  projectUsage,
  publishedMonthlyGrant,
  reservationTransition,
  subtractMoney,
  sumMoney,
  micro,
  usageCost,
  validateProviderUsage,
  type AllowanceAdjustment,
  type AttemptSettlement,
  type ChargeKind,
  type FundedAttempt,
  type JobTier,
  type MicroUsd,
  type PeriodTotals,
  type RateSnapshot,
  type ReservationEvent,
  type TopUpTotals,
  type UsageClass,
  type UsageReceipt,
  type UsageState,
} from '../../../shared/managed-usage.js';
import { sameUsageCounts } from '../../../shared/usage-contract.js';
import { canAdministerMembers } from '../../../shared/workspaces.js';
import { AccountError } from './errors.js';
import type { AccountMembershipSnapshot } from './domain.js';
import type { AccountService } from './account-service.js';

/** A refusal with a stable code a runtime can branch on. */
export class FundingError extends AccountError {
  readonly code: string;
  constructor(status: number, message: string, code: string) {
    super(status, message);
    this.name = 'FundingError';
    this.code = code;
  }
}

export interface CreditPeriodRow {
  tenantId: string;
  organizationId: string;
  periodId: string;
  planId: string;
  rateCardVersion: string;
  grantedMicroUsd: MicroUsd;
  startsAt: string;
  endsAt: string;
  /** The verified entitlement grant this allocation came from. */
  sourceGrantId: string;
  allocatedAt: string;
}

export interface FundedJobRow {
  tenantId: string;
  organizationId: string;
  rootJobId: string;
  runRef: string;
  capMicroUsd: MicroUsd;
  /** Increments on every approved cap change, so a stale reader can tell. */
  capGeneration: number;
  state: 'open' | 'closed';
  openedAt: string;
}

export interface JobRefRow {
  tenantId: string;
  runRef: string;
  rootJobId: string;
}

export interface CapRequestRow {
  tenantId: string;
  organizationId: string;
  requestId: string;
  rootJobId: string;
  requestedCapMicroUsd: MicroUsd;
  requestedBy: string;
  state: 'pending' | 'approved' | 'declined';
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface TopUpRow {
  tenantId: string;
  organizationId: string;
  topUpId: string;
  amountMicroUsd: MicroUsd;
  provider: 'stripe';
  sourceEventId: string;
  recordedAt: string;
}

export interface CreditAdjustmentRow extends AllowanceAdjustment {
  tenantId: string;
  attemptRef: string | null;
}

/** Database operations only. Never a provider call, never a retry. */
export interface FundingTransaction {
  /** Serializes every funding write for one organization's credits. */
  lockOrganization(tenantId: string, organizationId: string): Promise<void>;
  period(tenantId: string, organizationId: string, periodId: string): Promise<CreditPeriodRow | undefined>;
  savePeriod(row: CreditPeriodRow): Promise<void>;
  job(tenantId: string, rootJobId: string): Promise<FundedJobRow | undefined>;
  jobRef(tenantId: string, runRef: string): Promise<JobRefRow | undefined>;
  saveJob(row: FundedJobRow): Promise<void>;
  saveJobRef(row: JobRefRow): Promise<void>;
  attempt(tenantId: string, attemptId: string): Promise<FundedAttempt | undefined>;
  saveAttempt(row: FundedAttempt): Promise<void>;
  pendingAttempts(tenantId: string, organizationId: string): Promise<FundedAttempt[]>;
  settlement(tenantId: string, attemptId: string): Promise<AttemptSettlement | undefined>;
  saveSettlement(row: AttemptSettlement): Promise<void>;
  adjustment(tenantId: string, adjustmentId: string): Promise<CreditAdjustmentRow | undefined>;
  saveAdjustment(row: CreditAdjustmentRow): Promise<void>;
  topUp(tenantId: string, topUpId: string): Promise<TopUpRow | undefined>;
  saveTopUp(row: TopUpRow): Promise<void>;
  capRequest(tenantId: string, requestId: string): Promise<CapRequestRow | undefined>;
  saveCapRequest(row: CapRequestRow): Promise<void>;
  periodTotals(tenantId: string, organizationId: string, periodId: string): Promise<PeriodTotals>;
  topUpTotals(tenantId: string, organizationId: string): Promise<TopUpTotals>;
  /** Pending and uncertain holds at their ceiling plus settled debits, across the root job. */
  jobUsed(tenantId: string, rootJobId: string): Promise<MicroUsd>;
  lastReceipt(tenantId: string, organizationId: string, periodId: string): Promise<UsageReceipt | null>;
  /**
   * The conditional dispatch update: set the dispatch time only on a pending
   * attempt that has none. True only when exactly one row moved.
   */
  claimDispatch(tenantId: string, attemptId: string, at: string): Promise<boolean>;
  /**
   * Serializes every reservation checked against the company spend ceiling,
   * across every tenant and organization, until this transaction ends. Always
   * the last lock a transaction takes, so it cannot deadlock with the
   * organization lock.
   */
  lockCompany(): Promise<void>;
  /**
   * What the company's provider account may already owe, across every tenant
   * and organization: settled provider cost, plus every pending, uncertain or
   * written-off hold at its full ceiling.
   */
  companySpend(): Promise<MicroUsd>;
}

export interface FundingRepository {
  transaction<T>(action: (tx: FundingTransaction) => Promise<T>): Promise<T>;
}

export interface AttemptRef {
  tenantId: string;
  organizationId: string;
  attemptId: string;
}

export type SettleResult =
  | { outcome: 'settled'; settlement: AttemptSettlement }
  | { outcome: 'held'; attempt: FundedAttempt; reason: string };

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Provider refusals that bill nothing, so a sent hold may be released on them. */
export const RELEASABLE_REFUSALS: readonly number[] = Object.freeze([400, 401, 403, 404, 413, 422, 429]);
const periodPattern = /^(\d{4})-(0[1-9]|1[0-2])$/;

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !idPattern.test(value))
    throw new FundingError(422, `A valid ${field} is required.`, 'invalid_request');
  return value;
}

function requireMoney(value: unknown, field: string, positive = true): MicroUsd {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || (positive && value === 0))
    throw new FundingError(422, `Provide ${field} as a ${positive ? 'positive ' : ''}whole number of micro-USD.`, 'invalid_amount');
  return micro(value);
}

function requireRate(rate: RateSnapshot): RateSnapshot {
  const counts = [rate?.inputMicroUsdPerMillion, rate?.outputMicroUsdPerMillion, rate?.cacheReadMicroUsdPerMillion, rate?.cacheWriteMicroUsdPerMillion];
  if (!rate || typeof rate.version !== 'string' || !rate.version || rate.version.length > 120 ||
      counts.some((count) => typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000))
    throw new FundingError(422, 'A reservation needs the exact rate snapshot it is priced under.', 'invalid_rate');
  return {
    version: rate.version,
    inputMicroUsdPerMillion: rate.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: rate.outputMicroUsdPerMillion,
    cacheReadMicroUsdPerMillion: rate.cacheReadMicroUsdPerMillion,
    cacheWriteMicroUsdPerMillion: rate.cacheWriteMicroUsdPerMillion,
  };
}

/** A UTC calendar month, from its id. */
export function monthBounds(periodId: string): { startsAt: string; endsAt: string } {
  const match = periodPattern.exec(periodId);
  if (!match) throw new FundingError(422, 'A billing period is a UTC month such as 2026-09.', 'invalid_period');
  const year = Number(match[1]);
  const month = Number(match[2]);
  return {
    startsAt: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    endsAt: new Date(Date.UTC(year, month, 1)).toISOString(),
  };
}

/** Monthly credits still reservable in a period, never below zero. */
function monthlyAvailable(period: CreditPeriodRow, totals: PeriodTotals): MicroUsd {
  const funded = sumMoney([period.grantedMicroUsd, totals.correctionGrantsMicroUsd]);
  const committed = sumMoney([
    totals.correctionWithdrawalsMicroUsd,
    totals.settledMonthlyMicroUsd,
    totals.pendingMonthlyMicroUsd,
    totals.uncertainMonthlyMicroUsd,
  ]);
  return committed > funded ? micro(0) : subtractMoney(funded, committed);
}

function topUpAvailable(totals: TopUpTotals): MicroUsd {
  return subtractMoney(totals.purchasedMicroUsd, sumMoney([totals.heldMicroUsd, totals.settledMicroUsd]));
}

export interface FundingOptions {
  now?: () => number;
}

export class FundingService {
  private readonly now: () => number;

  /**
   * Every root job's default cap comes from its tier: the owner-approved
   * `APPROVED_JOB_CAP_CREDITS` (Efficient 20, Focused 50, Thorough 100). There
   * is no host option to change them, so no deployment can widen a default by
   * configuration; a higher cap is an owner-approved cap request.
   */
  constructor(private readonly repository: FundingRepository, options: FundingOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private at() {
    return new Date(this.now()).toISOString();
  }

  private move(attempt: FundedAttempt, event: ReservationEvent): FundedAttempt {
    try {
      return { ...attempt, state: reservationTransition(attempt.state, event) };
    } catch (error) {
      throw new FundingError(409, error instanceof Error ? error.message : 'That change is not allowed.', attempt.state === 'uncertain' ? 'uncertain_hold' : 'invalid_transition');
    }
  }

  private async lockedAttempt(tx: FundingTransaction, ref: AttemptRef): Promise<FundedAttempt> {
    requireId(ref.tenantId, 'tenant');
    requireId(ref.organizationId, 'organization');
    requireId(ref.attemptId, 'attempt');
    await tx.lockOrganization(ref.tenantId, ref.organizationId);
    const attempt = await tx.attempt(ref.tenantId, ref.attemptId);
    // Another tenant's or organization's attempt reads as absent.
    if (!attempt || attempt.organizationId !== ref.organizationId)
      throw new FundingError(404, 'That attempt was not found for this organization.', 'unknown_attempt');
    return attempt;
  }

  /**
   * Record a month's grant from a verified entitlement grant. Only published
   * plan grants can fund a period; Solo and proposed rows cannot. Server-only.
   */
  async allocatePeriod(input: { tenantId: string; organizationId: string; periodId: string; planId: string; sourceGrantId: string }): Promise<CreditPeriodRow> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const sourceGrantId = requireId(input.sourceGrantId, 'entitlement grant');
    const { startsAt, endsAt } = monthBounds(input.periodId);
    const granted = publishedMonthlyGrant(input.planId);
    if (granted === null)
      throw new FundingError(409, 'That plan has no approved monthly credit grant, so it cannot fund a period.', 'grant_not_approved');
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const existing = await tx.period(tenantId, organizationId, input.periodId);
      if (existing) {
        if (existing.planId !== input.planId || existing.sourceGrantId !== sourceGrantId)
          throw new FundingError(409, 'This month already has a different grant recorded. Correct it with an adjustment.', 'period_conflict');
        return existing;
      }
      const row: CreditPeriodRow = { tenantId, organizationId, periodId: input.periodId, planId: input.planId,
        rateCardVersion: RATE_CARD_V1.version, grantedMicroUsd: granted, startsAt, endsAt, sourceGrantId, allocatedAt: this.at() };
      await tx.savePeriod(row);
      return row;
    });
  }

  /** Record a purchased top-up from a verified billing event. Server-only. */
  async recordTopUp(input: { tenantId: string; organizationId: string; topUpId: string; amountMicroUsd: MicroUsd; provider: 'stripe'; sourceEventId: string }): Promise<TopUpRow> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const topUpId = requireId(input.topUpId, 'top-up');
    const sourceEventId = requireId(input.sourceEventId, 'billing event');
    const amount = requireMoney(input.amountMicroUsd, 'the top-up amount');
    if (input.provider !== 'stripe') throw new FundingError(422, 'Top-ups arrive from the verified billing provider only.', 'invalid_request');
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const existing = await tx.topUp(tenantId, topUpId);
      if (existing) {
        if (existing.organizationId !== organizationId || existing.amountMicroUsd !== amount || existing.sourceEventId !== sourceEventId)
          throw new FundingError(409, 'That top-up is already recorded with different terms.', 'topup_conflict');
        return existing;
      }
      const row: TopUpRow = { tenantId, organizationId, topUpId, amountMicroUsd: amount, provider: 'stripe', sourceEventId, recordedAt: this.at() };
      await tx.saveTopUp(row);
      return row;
    });
  }

  /**
   * Open a root job with its tier's finite cap, or attach a child run to its
   * parent's root. A child never brings a tier or a cap of its own: it spends
   * inside the root's. A root may ask for less than its tier's cap; asking for
   * more is refused here and goes through `requestCapIncrease`.
   */
  async openJob(input: { tenantId: string; organizationId: string; rootJobId: string; runRef: string; parentRunRef: string | null; tier: JobTier | null; capMicroUsd: MicroUsd | null }): Promise<FundedJobRow & { inherited: boolean }> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const runRef = requireId(input.runRef, 'run reference');
    const rootJobId = requireId(input.rootJobId, 'job');
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const existingRef = await tx.jobRef(tenantId, runRef);
      if (input.parentRunRef !== null) {
        const parentRef = await tx.jobRef(tenantId, requireId(input.parentRunRef, 'parent run reference'));
        const root = parentRef ? await tx.job(tenantId, parentRef.rootJobId) : undefined;
        if (!root || root.organizationId !== organizationId)
          throw new FundingError(404, 'The parent job was not found for this organization.', 'unknown_parent');
        if (input.capMicroUsd !== null || input.tier !== null)
          throw new FundingError(409, 'A child job spends inside its parent’s cap and cannot set its own.', 'child_cannot_set_cap');
        if (existingRef && existingRef.rootJobId !== root.rootJobId)
          throw new FundingError(409, 'That run is already attached to a different job.', 'job_conflict');
        if (!existingRef) await tx.saveJobRef({ tenantId, runRef, rootJobId: root.rootJobId });
        return { ...root, inherited: true };
      }
      if (!isJobTier(input.tier))
        throw new FundingError(422, 'A root job names its tier: efficient, focused or thorough.', 'invalid_tier');
      const tierCap = approvedJobCap(input.tier);
      const cap = input.capMicroUsd === null ? tierCap : requireMoney(input.capMicroUsd, 'the job cap');
      const existing = await tx.job(tenantId, rootJobId);
      if (existing) {
        if (existing.organizationId !== organizationId || existing.runRef !== runRef)
          throw new FundingError(409, 'That job id is already in use.', 'job_conflict');
        return { ...existing, inherited: false };
      }
      if (existingRef) throw new FundingError(409, 'That run is already attached to a job.', 'job_conflict');
      if (cap > tierCap)
        throw new FundingError(409, 'A cap above the tier’s approved cap needs an explicit request and an owner’s approval.', 'cap_request_required');
      const row: FundedJobRow = { tenantId, organizationId, rootJobId, runRef, capMicroUsd: cap, capGeneration: 0, state: 'open', openedAt: this.at() };
      await tx.saveJob(row);
      await tx.saveJobRef({ tenantId, runRef, rootJobId });
      return { ...row, inherited: false };
    });
  }

  /**
   * Hold a conservative ceiling against the root job and the organization's
   * funds in one transaction. The attempt is bound to the period current at
   * reservation, and settles there however late it finishes.
   *
   * With `companyCeilingMicroUsd`, the same transaction also refuses
   * (`company_ceiling`) a hold that would take the company's provider spend
   * past it: settled provider cost across every tenant and organization, plus
   * every pending, uncertain or written-off hold in full, plus this hold. It
   * reads that total only after taking the company lock, and transactions run
   * at READ COMMITTED, so a reservation waiting on the lock reads every hold
   * committed before it; two can never both slip under. Only a reservation
   * adds to the total: a settlement never exceeds its hold, and releases and
   * settlements only lower it. Without a ceiling there is no lock and no read.
   */
  async reserve(input: {
    tenantId: string; organizationId: string; attemptId: string; rootJobId: string; parentAttemptId: string | null;
    kind: ChargeKind; route: string; requestDigest: string; rateSnapshot: RateSnapshot; maxMicroUsd: MicroUsd;
    usageClass: UsageClass; companyCeilingMicroUsd?: MicroUsd | null;
  }): Promise<FundedAttempt> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const attemptId = requireId(input.attemptId, 'attempt');
    const rootJobId = requireId(input.rootJobId, 'job');
    const route = requireId(input.route, 'route');
    const requestDigest = requireId(input.requestDigest, 'request digest');
    const parentAttemptId = input.parentAttemptId === null ? null : requireId(input.parentAttemptId, 'parent attempt');
    const rate = requireRate(input.rateSnapshot);
    if (!isUsageClass(input.usageClass))
      throw new FundingError(422, 'Say what this attempt is for: included-chat, metered-work, worker or automation.', 'invalid_usage_class');
    const usageClass = input.usageClass;
    if (!(RATE_CARD_V1.kinds as readonly string[]).includes(input.kind) || !debitsAllowance(RATE_CARD_V1, input.kind))
      throw new FundingError(409, 'That kind of charge is not run on included credits.', 'charge_not_admissible');
    const companyCeiling = input.companyCeilingMicroUsd === undefined || input.companyCeilingMicroUsd === null
      ? null : requireMoney(input.companyCeilingMicroUsd, 'the company spend ceiling', false);
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const existing = await tx.attempt(tenantId, attemptId);
      if (existing) {
        const same = existing.organizationId === organizationId && existing.rootJobId === rootJobId && existing.parentAttemptId === parentAttemptId &&
          existing.kind === input.kind && existing.route === route && existing.requestDigest === requestDigest &&
          existing.maxMicroUsd === input.maxMicroUsd && JSON.stringify(existing.rateSnapshot) === JSON.stringify(rate) &&
          existing.usageClass === usageClass;
        if (!same) throw new FundingError(409, 'That attempt id is already used for a different hold.', 'attempt_conflict');
        return existing;
      }
      const job = await tx.job(tenantId, rootJobId);
      if (!job || job.organizationId !== organizationId)
        throw new FundingError(404, 'That job was not found for this organization.', 'unknown_job');
      if (job.state !== 'open') throw new FundingError(409, 'That job is closed.', 'job_closed');
      if (parentAttemptId !== null) {
        const parent = await tx.attempt(tenantId, parentAttemptId);
        if (!parent || parent.rootJobId !== rootJobId)
          throw new FundingError(409, 'A retry or child names an attempt under the same job.', 'parent_attempt_mismatch');
      }
      const periodId = periodIdFor(at);
      const period = await tx.period(tenantId, organizationId, periodId);
      if (!period)
        throw new FundingError(409, 'This month has no credit grant recorded yet, so nothing can be reserved.', 'no_period');
      const decision = decideReserve({
        maxMicroUsd: input.maxMicroUsd,
        monthlyAvailableMicroUsd: monthlyAvailable(period, await tx.periodTotals(tenantId, organizationId, periodId)),
        topUpAvailableMicroUsd: topUpAvailable(await tx.topUpTotals(tenantId, organizationId)),
        job: { capMicroUsd: job.capMicroUsd, usedMicroUsd: await tx.jobUsed(tenantId, rootJobId) },
      });
      if (!decision.ok)
        throw new FundingError(decision.code === 'invalid_ceiling' ? 422 : 402, decision.reason, decision.code);
      if (companyCeiling !== null) {
        await tx.lockCompany();
        if (sumMoney([await tx.companySpend(), input.maxMicroUsd]) > companyCeiling)
          throw new FundingError(503, 'This hold would take the company’s provider spend past its ceiling.', 'company_ceiling');
      }
      const attempt: FundedAttempt = {
        id: attemptId, organizationId, periodId, parentTaskId: rootJobId, kind: input.kind, route, payer: 'managed',
        maxMicroUsd: input.maxMicroUsd, rateCardVersion: period.rateCardVersion, state: 'pending', createdAt: at,
        resolvedAt: null, uncertainReason: null, tenantId, rootJobId, parentAttemptId, requestDigest, rateSnapshot: rate, usageClass,
        monthlyHoldMicroUsd: decision.monthlyHoldMicroUsd, topUpHoldMicroUsd: decision.topUpHoldMicroUsd, dispatchedAt: null,
      };
      await tx.saveAttempt(attempt);
      return attempt;
    });
  }

  /**
   * Commit that the request is about to leave. The caller sends only after
   * this commits; if it fails, the caller does not send, and restart recovery
   * still treats the attempt as possibly sent.
   *
   * Exclusive: a conditional update moves the attempt from pending with no
   * dispatch time, and only the caller whose update moved it may send. Every
   * other caller for the attempt, in any isolate or process, gets 409
   * `attempt_in_flight` and sends nothing.
   */
  async markDispatched(ref: AttemptRef): Promise<FundedAttempt> {
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      const attempt = await this.lockedAttempt(tx, ref);
      if (attempt.state !== 'pending')
        throw new FundingError(409, `A ${attempt.state} attempt cannot be sent.`, 'invalid_transition');
      if (!(await tx.claimDispatch(attempt.tenantId, attempt.id, at)))
        throw new FundingError(409, 'That request is already being answered.', 'attempt_in_flight');
      return { ...attempt, dispatchedAt: at };
    });
  }

  /**
   * Release a sent hold the provider refused before any output: the one case
   * a dispatched hold may be released. Only for a refusal status the provider
   * does not bill (400, 401, 403, 404, 413, 422 or 429), and only when the
   * caller received nothing but the error body. The status and the provider's
   * request id are recorded on the attempt as the evidence. Every other
   * failure after dispatch stays uncertain.
   */
  async releaseRefused(ref: AttemptRef & { providerStatus: number; providerRequestId: string | null }): Promise<FundedAttempt> {
    const status = ref.providerStatus;
    if (!RELEASABLE_REFUSALS.includes(status))
      throw new FundingError(422, 'Only a provider refusal of 400, 401, 403, 404, 413, 422 or 429 releases a sent hold.', 'release_not_allowed');
    const requestId = ref.providerRequestId === null ? null : requireId(ref.providerRequestId, 'provider request id');
    return this.repository.transaction(async (tx) => {
      const attempt = await this.lockedAttempt(tx, ref);
      if (attempt.state === 'released') return attempt;
      if (attempt.state !== 'pending')
        throw new FundingError(409, `A ${attempt.state} attempt cannot be released.`, 'invalid_transition');
      if (attempt.dispatchedAt === null)
        throw new FundingError(409, 'That request was never sent; release it as unsent.', 'not_dispatched');
      // uncertain_reason is the attempt's one free-text column; writeOff records its evidence there too.
      const released = { ...this.move(attempt, 'release'), resolvedAt: this.at(),
        uncertainReason: `Released: the provider refused it with HTTP ${status} before any output (provider request ${requestId ?? 'not given'}).` };
      await tx.saveAttempt(released);
      return released;
    });
  }

  /** Release a hold that never left. A sent hold is never released as unused. */
  async release(ref: AttemptRef): Promise<FundedAttempt> {
    return this.repository.transaction(async (tx) => {
      const attempt = await this.lockedAttempt(tx, ref);
      if (attempt.state === 'pending' && attempt.dispatchedAt !== null)
        throw new FundingError(409, 'That request was sent, so it may have cost money. Settle it from provider usage or reconcile it.', 'dispatched_hold');
      const released = { ...this.move(attempt, 'release'), resolvedAt: this.at() };
      await tx.saveAttempt(released);
      return released;
    });
  }

  /** Cancel: unsent holds release; sent holds stay held as uncertain. */
  async cancel(ref: AttemptRef & { reason: string }): Promise<FundedAttempt> {
    const reason = String(ref.reason ?? '').trim().slice(0, 300) || 'cancelled';
    return this.repository.transaction(async (tx) => {
      const attempt = await this.lockedAttempt(tx, ref);
      if (attempt.state !== 'pending') return attempt;
      if (attempt.dispatchedAt === null) {
        const released = { ...this.move(attempt, 'release'), resolvedAt: this.at() };
        await tx.saveAttempt(released);
        return released;
      }
      const parked = { ...this.move(attempt, 'lose'), uncertainReason: `Cancelled after it was sent (${reason}). The provider may have charged for it.` };
      await tx.saveAttempt(parked);
      return parked;
    });
  }

  /** A sent request whose response was lost. The hold stays until reconciliation. */
  async markUncertain(ref: AttemptRef & { reason: string }): Promise<FundedAttempt> {
    const reason = String(ref.reason ?? '').trim().slice(0, 300) || 'The response was lost.';
    return this.repository.transaction(async (tx) => {
      const attempt = await this.lockedAttempt(tx, ref);
      if (attempt.state === 'uncertain') return attempt;
      if (attempt.state === 'pending' && attempt.dispatchedAt === null)
        throw new FundingError(409, 'That request was never sent. Release it instead.', 'not_dispatched');
      const parked = { ...this.move(attempt, 'lose'), uncertainReason: reason };
      await tx.saveAttempt(parked);
      return parked;
    });
  }

  /**
   * Settle from a provider usage report, normalized once through the
   * `nectovia-usage/1` contract (`shared/usage-contract.ts`) with the provider's
   * raw usage kept beside the counts. A missing or refused report, or usage
   * beyond the reserved ceiling, keeps the hold as uncertain rather than
   * guessing or clamping.
   */
  async settle(ref: AttemptRef & { receiptRef: string; usage: unknown; raw?: unknown; reconciledFrom: 'response' | 'provider-report' }): Promise<SettleResult> {
    const receiptRef = requireId(ref.receiptRef, 'provider receipt');
    const reconciledFrom = ref.reconciledFrom === 'provider-report' ? 'provider-report' : 'response';
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      const attempt = await this.lockedAttempt(tx, ref);
      const checked = validateProviderUsage(ref.usage, ref.raw);
      const recorded = await tx.settlement(ref.tenantId, attempt.id);
      if (recorded) {
        if (recorded.receiptRef !== receiptRef || !checked.valid || !sameUsageCounts(recorded.usage, checked.usage))
          throw new FundingError(409, 'That attempt is already settled from a different provider record.', 'settlement_conflict');
        return { outcome: 'settled', settlement: recorded };
      }
      if (attempt.state === 'pending' && attempt.dispatchedAt === null)
        throw new FundingError(409, 'That request was never sent, so it has no usage to settle.', 'not_dispatched');
      if (attempt.state !== 'pending' && attempt.state !== 'uncertain')
        throw new FundingError(409, `A ${attempt.state} attempt cannot be settled.`, 'invalid_transition');
      const hold = async (reason: string): Promise<SettleResult> => {
        const parked = attempt.state === 'uncertain' ? { ...attempt, uncertainReason: reason } : { ...this.move(attempt, 'lose'), uncertainReason: reason };
        await tx.saveAttempt(parked);
        return { outcome: 'held', attempt: parked, reason };
      };
      if (!checked.valid) return hold(`${checked.reason} The hold stays until the provider's accounting is known.`);
      const cost = usageCost(attempt.rateSnapshot, checked.usage);
      if (cost > attempt.maxMicroUsd)
        return hold('The provider reported more than was reserved. The hold stays for reconciliation; it is not clamped.');
      const monthly = Math.min(cost, attempt.monthlyHoldMicroUsd);
      const settledAttempt = { ...this.move(attempt, attempt.state === 'uncertain' ? 'reconcile' : 'settle'), resolvedAt: at };
      const settlement: AttemptSettlement = {
        reservationId: attempt.id, organizationId: attempt.organizationId, periodId: attempt.periodId,
        providerCostMicroUsd: cost, allowanceDebitMicroUsd: cost, rateCardVersion: attempt.rateCardVersion,
        eligibility: 'included', settledAt: at, reconciledFrom, tenantId: attempt.tenantId, receiptRef,
        monthlyDebitMicroUsd: micro(monthly), topUpDebitMicroUsd: micro(cost - monthly), usage: checked.usage,
      };
      await tx.saveAttempt(settledAttempt);
      await tx.saveSettlement(settlement);
      return { outcome: 'settled', settlement };
    });
  }

  /** Close an uncertain hold the provider confirms was never billed. */
  async writeOff(ref: AttemptRef & { evidenceRef: string }): Promise<FundedAttempt> {
    const evidenceRef = requireId(ref.evidenceRef, 'provider evidence');
    return this.repository.transaction(async (tx) => {
      const attempt = await this.lockedAttempt(tx, ref);
      const written = { ...this.move(attempt, 'write-off'), resolvedAt: this.at(),
        uncertainReason: `${attempt.uncertainReason ?? 'Uncertain.'} Written off on provider evidence ${evidenceRef}.` };
      await tx.saveAttempt(written);
      return written;
    });
  }

  /**
   * Run once when a host starts. An unsent hold is released; a sent one, or
   * one whose dispatch commit may have landed, is parked as uncertain.
   */
  async recoverAfterRestart(input: { tenantId: string; organizationId: string }): Promise<{ released: string[]; uncertain: string[] }> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const released: string[] = [];
      const uncertain: string[] = [];
      for (const attempt of await tx.pendingAttempts(tenantId, organizationId)) {
        if (attempt.dispatchedAt === null) {
          await tx.saveAttempt({ ...this.move(attempt, 'release'), resolvedAt: this.at() });
          released.push(attempt.id);
        } else {
          await tx.saveAttempt({ ...this.move(attempt, 'lose'), uncertainReason: 'The host restarted before provider usage was recorded.' });
          uncertain.push(attempt.id);
        }
      }
      return { released, uncertain };
    });
  }

  /** Ask for a higher finite cap. A request is not approval and changes nothing. */
  async requestCapIncrease(input: { tenantId: string; organizationId: string; rootJobId: string; requestId: string; requestedCapMicroUsd: MicroUsd; requestedBy: string }): Promise<CapRequestRow> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const requestId = requireId(input.requestId, 'cap request');
    const requestedBy = requireId(input.requestedBy, 'requester');
    const requested = requireMoney(input.requestedCapMicroUsd, 'the requested cap');
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const existing = await tx.capRequest(tenantId, requestId);
      if (existing) {
        if (existing.rootJobId !== input.rootJobId || existing.requestedCapMicroUsd !== requested || existing.organizationId !== organizationId)
          throw new FundingError(409, 'That cap request id is already used for different terms.', 'cap_request_conflict');
        return existing;
      }
      const job = await tx.job(tenantId, input.rootJobId);
      if (!job || job.organizationId !== organizationId)
        throw new FundingError(404, 'That job was not found for this organization.', 'unknown_job');
      if (requested <= job.capMicroUsd)
        throw new FundingError(422, 'A cap request must ask for more than the current cap.', 'invalid_amount');
      const row: CapRequestRow = { tenantId, organizationId, requestId, rootJobId: job.rootJobId, requestedCapMicroUsd: requested,
        requestedBy, state: 'pending', requestedAt: this.at(), decidedBy: null, decidedAt: null };
      await tx.saveCapRequest(row);
      return row;
    });
  }

  /**
   * An organization owner approves or declines a pending cap request. The
   * membership snapshot comes from `AccountService.membership`, freshly
   * verified; an expired snapshot or a non-owner is refused.
   */
  async decideCapIncrease(input: { membership: AccountMembershipSnapshot; requestId: string; approve: boolean }): Promise<CapRequestRow> {
    const { membership } = input;
    if (Date.parse(membership.validUntil) <= this.now())
      throw new FundingError(401, 'Resolve the account session again before approving spend.', 'stale_membership');
    if (!canAdministerMembers(membership.membership) || membership.membership.organizationId !== membership.organization.id)
      throw new FundingError(403, 'An active organization owner decides a higher job cap.', 'not_authorized');
    const tenantId = membership.organization.tenantId;
    const organizationId = membership.organization.id;
    const requestId = requireId(input.requestId, 'cap request');
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const request = await tx.capRequest(tenantId, requestId);
      if (!request || request.organizationId !== organizationId)
        throw new FundingError(404, 'That cap request was not found for this organization.', 'unknown_cap_request');
      if (request.state !== 'pending') return request;
      const decided: CapRequestRow = { ...request, state: input.approve ? 'approved' : 'declined', decidedBy: membership.person.id, decidedAt: this.at() };
      if (input.approve) {
        const job = await tx.job(tenantId, request.rootJobId);
        if (!job) throw new FundingError(404, 'That job was not found.', 'unknown_job');
        await tx.saveJob({ ...job, capMicroUsd: request.requestedCapMicroUsd, capGeneration: job.capGeneration + 1 });
      }
      await tx.saveCapRequest(decided);
      return decided;
    });
  }

  /**
   * A company-funded correction or a reconciliation withdrawal, as its own
   * record. Settled history is never rewritten.
   */
  async recordCorrection(input: { tenantId: string; organizationId: string; adjustmentId: string; periodId: string; direction: 'grant' | 'withdraw'; amountMicroUsd: MicroUsd; attemptRef: string | null; note: string }): Promise<CreditAdjustmentRow> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const adjustmentId = requireId(input.adjustmentId, 'adjustment');
    const amount = requireMoney(input.amountMicroUsd, 'the correction amount');
    const attemptRef = input.attemptRef === null ? null : requireId(input.attemptRef, 'attempt');
    const note = String(input.note ?? '').trim();
    if (!note || note.length > 500) throw new FundingError(422, 'A correction needs a short note saying why.', 'invalid_request');
    if (input.direction !== 'grant' && input.direction !== 'withdraw') throw new FundingError(422, 'A correction grants or withdraws.', 'invalid_request');
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const existing = await tx.adjustment(tenantId, adjustmentId);
      if (existing) {
        if (existing.organizationId !== organizationId || existing.periodId !== input.periodId || existing.direction !== input.direction ||
            existing.amountMicroUsd !== amount || existing.attemptRef !== attemptRef || existing.note !== note)
          throw new FundingError(409, 'That adjustment id is already recorded for different terms.', 'adjustment_conflict');
        return existing;
      }
      const period = await tx.period(tenantId, organizationId, input.periodId);
      if (!period) throw new FundingError(404, 'That month has no grant to correct.', 'unknown_period');
      if (input.direction === 'withdraw' && amount > monthlyAvailable(period, await tx.periodTotals(tenantId, organizationId, input.periodId)))
        throw new FundingError(402, 'That withdrawal would take the month below zero. Record a smaller one.', 'insufficient_allowance');
      const row: CreditAdjustmentRow = { id: adjustmentId, organizationId, periodId: input.periodId, reason: 'correction',
        direction: input.direction, amountMicroUsd: amount, at: this.at(), note, sourceEventId: null, tenantId, attemptRef };
      await tx.saveAdjustment(row);
      return row;
    });
  }

  /** The current month's usage, or an honest unavailable state. Read-only. */
  async projection(tenantId: string, organizationId: string): Promise<UsageState> {
    requireId(tenantId, 'tenant');
    requireId(organizationId, 'organization');
    const observedAt = this.at();
    const periodId = periodIdFor(observedAt);
    return this.repository.transaction(async (tx) => {
      const period = await tx.period(tenantId, organizationId, periodId);
      if (!period)
        return { state: 'unavailable', organizationId, reason: 'No credit grant is recorded for this month, so there is no usage to show.' };
      return {
        state: 'ready',
        organizationId,
        projection: projectUsage({
          organizationId,
          period,
          totals: await tx.periodTotals(tenantId, organizationId, periodId),
          topUp: await tx.topUpTotals(tenantId, organizationId),
          lastReceipt: await tx.lastReceipt(tenantId, organizationId, periodId),
          observedAt,
        }),
      };
    });
  }
}

/**
 * The authenticated usage read: verified membership first, then the funding
 * read under the organization's own tenant. The membership assertion is valid
 * for at most 30 seconds, the same window every other workspace read uses.
 */
export class UsageService {
  constructor(private readonly accounts: Pick<AccountService, 'membership'>, private readonly funding: Pick<FundingService, 'projection'>) {}
  async usage(token: string, organizationId: string): Promise<UsageState> {
    const snapshot = await this.accounts.membership(token, organizationId);
    return this.funding.projection(snapshot.organization.tenantId, snapshot.organization.id);
  }
}
