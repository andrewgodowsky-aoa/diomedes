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
 * billing path. Two things reach `worker.ts`: the read-only usage projection,
 * and the purchased-usage holds below, which an active member asks for with
 * their own session. Those holds draw only on top-ups the verified billing
 * path recorded, never on the monthly grant.
 */
import { z } from 'zod';
import {
  MAX_MONEY_MICRO_USD,
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
  creditAmount,
  usageCost,
  formatCredits,
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
import { ceilingSchema, type ChargeSnapshot } from '../../../shared/credit-prices.js';
import {
  cycleContains,
  individualCycleId,
  isIndividualCycleId,
  periodsOverlap,
  verifiedIndividualCycle,
  type IndividualBillingCycle,
} from '../../../shared/individual-period.js';
import { MEMBER_ROLES, canAdministerMembers, type MemberRole } from '../../../shared/workspaces.js';
import { decideMemberUse, effectiveLimit, type Allowance } from '../../../shared/credit-allotments.js';
import { AccountError } from './errors.js';
import type { AccountMembershipSnapshot } from './domain.js';
import type { AccountService } from './account-service.js';
import type { AllotmentSettingsRow, AttemptPersonRow, LimitRequestRow, MemberLimitRow, MemberUsageRow } from './member-limits.js';

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
  /** Historical name: the Business or Individual billing-scope id, never the UI's selected workspace. */
  organizationId: string;
  periodId: string;
  planId: string;
  rateCardVersion: string;
  grantedMicroUsd: MicroUsd;
  startsAt: string;
  endsAt: string;
  /** The original person grant for Individual, or account feature grant for Business/explicit agreements. */
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

/**
 * How long a purchased-usage hold lasts before it lets go on its own, unless its holder renews it.
 * An engineering default, not an owner figure: the owner may change it. It is long enough for the
 * desktop to renew many times over before it lapses while work runs, and short enough that a crashed
 * or closed app frees bought credits within the quarter hour.
 */
export const PURCHASED_HOLD_LEASE_MINUTES = 15;

/**
 * A hold a person asked for against the credits their business bought outright (migration 013).
 * It is not a funded attempt: no job, no month, no rate and no provider call. It only keeps
 * bought credits aside, and is settled to a debit on the top-up balance or released.
 *
 * It is a lease: only the holder knows whether the work is still running, so the holder renews it.
 * A held row whose lease has lapsed stops counting as held and is let go by the next read or write
 * under the organization lock. If the work finishes after that, its real usage is still recorded.
 */
export interface TopUpHoldRow {
  tenantId: string;
  organizationId: string;
  holdId: string;
  /** The verified person who asked. Only they can settle or release it. */
  personId: string;
  requestDigest: string;
  amountMicroUsd: MicroUsd;
  /** Zero until the hold is settled. Never more than the amount. */
  debitMicroUsd: MicroUsd;
  /**
   * What a late settle asked for beyond what was free to record, which Diomedes covers. Zero unless the
   * hold was settled after it had let go. Debit plus this is what the holder asked to settle, and is never
   * more than the amount. Internal: it appears in no answer and no screen.
   */
  absorbedMicroUsd: MicroUsd;
  state: 'held' | 'settled' | 'released';
  createdAt: string;
  resolvedAt: string | null;
  /** From the service's own clock when the hold was made, moved only by a renewal. Never from a request. */
  leaseUntil: string;
  /** Who let go of a released hold: the person, or the lapse of the lease. Null unless released. */
  releasedBy: 'person' | 'expiry' | null;
}

/**
 * A purchase of credits through Stripe Checkout (migration 015). Pending from the moment an owner or
 * an admin asks for it until a verified Stripe event says what became of it. The amount charged is
 * fixed when it is made and kept here in cents; the credits granted are kept in the top-up the paid
 * event records, which carries this purchase's id as its own.
 */
export interface CreditPurchaseRow {
  tenantId: string;
  organizationId: string;
  purchaseId: string;
  /** The verified person who bought. */
  personId: string;
  /** A whole number of credits: whole steps of the rate below. */
  credits: number;
  /** What Stripe is asked to charge, in cents: the same whole steps at the rate below. */
  amountCents: number;
  /**
   * The rate the server chose when the purchase was made, from the paying business's plan at that moment: `rateCredits` credits for
   * `rateCents` cents per step. The paid event credits this row's credits and never works a rate out again.
   */
  rateCents: number;
  rateCredits: number;
  /** The Stripe environment the purchase was made in. Only an event from the same one can pay it. */
  environment: 'test' | 'live';
  currency: 'usd';
  /** Null until Stripe has made the Checkout Session. */
  checkoutSessionId: string | null;
  state: 'pending' | 'paid' | 'expired' | 'failed';
  createdAt: string;
  resolvedAt: string | null;
  /** The verified event that resolved it. Null while pending, and when a purchase failed before Stripe knew of it. */
  stripeEventId: string | null;
}

/** The credits a business bought outright, as the top-up ledger reads them. */
export interface PurchasedBalance {
  purchasedMicroUsd: MicroUsd;
  heldMicroUsd: MicroUsd;
  settledMicroUsd: MicroUsd;
  availableMicroUsd: MicroUsd;
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
  /** Every period recorded for one billing scope, for the Individual overlap and supersession checks. */
  periods(tenantId: string, organizationId: string): Promise<CreditPeriodRow[]>;
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
  topUpHold(tenantId: string, holdId: string): Promise<TopUpHoldRow | undefined>;
  /** Insert a new hold, or move an existing one from held to settled or released, or renew its lease. */
  saveTopUpHold(row: TopUpHoldRow): Promise<void>;
  /** A credit purchase by its id. A row lock in the database: held to the end of the transaction. */
  creditPurchase(tenantId: string, purchaseId: string): Promise<CreditPurchaseRow | undefined>;
  /** A credit purchase by the Stripe Checkout Session that pays it. A session id belongs to one purchase, in any tenant. */
  creditPurchaseBySession(sessionId: string): Promise<CreditPurchaseRow | undefined>;
  /** Insert a new purchase, or move a pending one: its session, its state, its resolution and its event. Nothing else moves. */
  saveCreditPurchase(row: CreditPurchaseRow): Promise<void>;
  /**
   * Let go of every held purchased-usage hold in the organization whose lease has lapsed at `at`
   * (lease_until <= at), as released by expiry. Runs under the organization lock before any balance is read.
   */
  expireTopUpHolds(tenantId: string, organizationId: string, at: string): Promise<void>;
  capRequest(tenantId: string, requestId: string): Promise<CapRequestRow | undefined>;
  saveCapRequest(row: CapRequestRow): Promise<void>;
  /** Every limit a business has set, for roles and for people (migration 014). */
  memberLimits(tenantId: string, organizationId: string): Promise<MemberLimitRow[]>;
  /** Insert a limit, or change the mode and amount of the one already set for that role or person. */
  saveMemberLimit(row: MemberLimitRow): Promise<void>;
  allotmentSettings(tenantId: string, organizationId: string): Promise<AllotmentSettingsRow | undefined>;
  saveAllotmentSettings(row: AllotmentSettingsRow): Promise<void>;
  limitRequest(tenantId: string, requestId: string): Promise<LimitRequestRow | undefined>;
  /** Insert a request, or record its decision. A request's terms are never rewritten. */
  saveLimitRequest(row: LimitRequestRow): Promise<void>;
  limitRequests(tenantId: string, organizationId: string, filter: { personId?: string; state?: LimitRequestRow['state'] }): Promise<LimitRequestRow[]>;
  /** The approved requests that add room for this person now: the month's, and the one for this root job. */
  approvedAllowances(tenantId: string, organizationId: string, personId: string, periodId: string, rootJobId: string): Promise<LimitRequestRow[]>;
  /** Which person an attempt was reserved for. Written once, in the reserving transaction. */
  saveAttemptPerson(row: AttemptPersonRow): Promise<void>;
  /**
   * What each person (or one person) holds or has settled in a period, from included and bought credits
   * alike: funded attempts that name them, and their purchased-usage holds. Held work counts at its
   * ceiling, settled work at cost, released and written-off work not at all. A purchased hold counts as
   * held only while its lease runs past `at`, and a settled one counts its recorded debit, never what was absorbed.
   */
  memberUsage(tenantId: string, organizationId: string, period: CreditPeriodRow, personId: string | null, at: string): Promise<MemberUsageRow[]>;
  periodTotals(tenantId: string, organizationId: string, periodId: string): Promise<PeriodTotals>;
  /**
   * Purchased credits, and what is held or settled against them: funded attempts' top-up holds
   * and debits, and purchased-usage holds and their debits. One balance, one place. A held
   * purchased-usage hold whose lease has lapsed at `at` is not counted as held, even when nothing
   * has let go of it yet: the funded-reserve path reads this without a sweep.
   */
  topUpTotals(tenantId: string, organizationId: string, at: string): Promise<TopUpTotals>;
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

export function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !idPattern.test(value))
    throw new FundingError(422, `A valid ${field} is required.`, 'invalid_request');
  return value;
}

/** A paid event names a purchase, business and tenant; they must all be this stored purchase's own. */
function namesAnotherPurchase(stored: CreditPurchaseRow, event: { purchaseId: string | null; organizationId: string | null; tenantId: string | null }): boolean {
  return stored.purchaseId !== event.purchaseId || stored.organizationId !== event.organizationId || stored.tenantId !== event.tenantId;
}

/** A paid event must carry the stored amount and currency, the ones the purchase was made at. */
function paysAnotherAmount(stored: CreditPurchaseRow, event: { amountTotal: number | null; currency: string | null }): boolean {
  return event.amountTotal !== stored.amountCents || typeof event.currency !== 'string' || event.currency.toLowerCase() !== stored.currency;
}

export function requireMoney(value: unknown, field: string, positive = true): MicroUsd {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || (positive && value === 0))
    throw new FundingError(422, `Provide ${field} as a ${positive ? 'positive ' : ''}whole number of micro-USD.`, 'invalid_amount');
  return micro(value);
}

function requireRate(rate: RateSnapshot): RateSnapshot {
  const counts = [rate?.inputMicroUsdPerMillion, rate?.outputMicroUsdPerMillion, rate?.cacheReadMicroUsdPerMillion, rate?.cacheWriteMicroUsdPerMillion];
  if (!rate || typeof rate.version !== 'string' || !rate.version || rate.version.length > 120 ||
      counts.some((count) => typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000))
    throw new FundingError(422, 'A reservation needs the exact rate snapshot it is priced under.', 'invalid_rate');
  const extra = [rate.reasoningMicroUsdPerMillion, rate.requestFeeMicroUsd].filter(x => x !== undefined);
  if (extra.some(x => !Number.isSafeInteger(x) || x! < 0 || x! > 1_000_000_000) || (rate.longContext?.length ?? 0) > 16)
    throw new FundingError(422, 'The extended rate snapshot is invalid.', 'invalid_rate');
  const longContext = rate.longContext?.map(b => {
    if (!Number.isSafeInteger(b.aboveInputTokens) || b.aboveInputTokens < 0) throw new FundingError(422, 'The price threshold is invalid.', 'invalid_rate');
    const { version: _version, ...rates } = requireRate({ ...b, version: rate.version, longContext: undefined, routing: undefined });
    return { ...rates, aboveInputTokens: b.aboveInputTokens };
  });
  if (rate.routing && (JSON.stringify(rate.routing).length > 4096 || Object.values(rate.routing).some(x => typeof x === 'object' && x !== null)))
    throw new FundingError(422, 'The routing receipt is invalid.', 'invalid_rate');
  return {
    version: rate.version,
    inputMicroUsdPerMillion: rate.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: rate.outputMicroUsdPerMillion,
    cacheReadMicroUsdPerMillion: rate.cacheReadMicroUsdPerMillion,
    cacheWriteMicroUsdPerMillion: rate.cacheWriteMicroUsdPerMillion,
    ...(rate.reasoningMicroUsdPerMillion === undefined ? {} : { reasoningMicroUsdPerMillion: rate.reasoningMicroUsdPerMillion }),
    ...(rate.requestFeeMicroUsd === undefined ? {} : { requestFeeMicroUsd: rate.requestFeeMicroUsd }),
    ...(longContext === undefined ? {} : { longContext }),
    ...(rate.routing === undefined ? {} : { routing: { ...rate.routing } }),
  };
}

/**
 * The tier charge an attempt is held under, checked like a rate snapshot: whole ledger units, a
 * named table version and tier, and a ceiling inside its bounds. Its price fields are exactly a rate
 * snapshot's, so `usageCost` prices the debit from it.
 */
function requireCharge(charge: ChargeSnapshot): ChargeSnapshot {
  if (!charge || !isJobTier(charge.tier) || !Number.isSafeInteger(charge.tableVersion) || charge.tableVersion < 1 ||
      !ceilingSchema.safeParse(charge.ceilingMicroUsdPerCredit).success)
    throw new FundingError(422, 'A reservation needs the exact tier charge it is held under.', 'invalid_charge');
  let prices: RateSnapshot;
  try {
    prices = requireRate({ ...charge, routing: undefined });
  } catch {
    throw new FundingError(422, 'A reservation needs the exact tier charge it is held under.', 'invalid_charge');
  }
  const { routing: _routing, ...fields } = prices;
  return { ...fields, tier: charge.tier, tableVersion: charge.tableVersion, ceilingMicroUsdPerCredit: charge.ceilingMicroUsdPerCredit };
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

/**
 * What is free to hold or reserve right now, never less than nothing. A late settle records only
 * what is free here (settlePurchased), so the ledger itself never goes past what was bought.
 */
function topUpAvailable(totals: TopUpTotals): MicroUsd {
  const committed = sumMoney([totals.heldMicroUsd, totals.settledMicroUsd]);
  return committed >= totals.purchasedMicroUsd ? micro(0) : subtractMoney(totals.purchasedMicroUsd, committed);
}

function balanceOf(totals: TopUpTotals): PurchasedBalance {
  // An overdrawn balance can only come from an edit outside the ledger; subtractMoney refuses to
  // present it rather than clamp it.
  return { ...totals, availableMicroUsd: subtractMoney(totals.purchasedMicroUsd, sumMoney([totals.heldMicroUsd, totals.settledMicroUsd])) };
}

const leaseFrom = (at: string) => new Date(Date.parse(at) + PURCHASED_HOLD_LEASE_MINUTES * 60_000).toISOString();

/**
 * Pay as you go (DIO-219, migration 017). A person with no plan has no billing period, so a reservation for their own
 * Individual billing scope draws on the credits they bought and binds to the scope's one bought-credits row: no grant,
 * no source, and no end inside the life of the product. It never funds anything itself; only the scope's bought balance does.
 */
export const BOUGHT_CREDITS_PLAN = 'bought-credits';
export const BOUGHT_CREDITS_PERIOD = 'bought-credits';
const BOUGHT_CREDITS_ENDS_AT = '9999-12-31T00:00:00.000Z';
/** A person's own Individual billing scope (010: ids `individual_...`). Only such a scope may hold a bought-credits row. */
export const isIndividualScopeId = (id: string): boolean => id.startsWith('individual_');

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
   * plan grants can fund a period; Solo and proposed rows cannot. Individual
   * uses the verified person's own billing scope and person grant. The database
   * binds that source without copying a grant into a Business. Server-only.
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

  /** Explicit paid Individual agreement; no default plan, price, balance or renewal is inferred. */
  async allocateAgreementPeriod(input: { tenantId: string; organizationId: string; periodId: string; sourceGrantId: string; amountMicroUsd: MicroUsd }): Promise<CreditPeriodRow> {
    const tenantId = requireId(input.tenantId, 'tenant'), organizationId = requireId(input.organizationId, 'account');
    const sourceGrantId = requireId(input.sourceGrantId, 'grant'), granted = requireMoney(input.amountMicroUsd, 'agreed credits');
    const { startsAt, endsAt } = monthBounds(input.periodId);
    return this.repository.transaction(async tx => {
      await tx.lockOrganization(tenantId, organizationId);
      const existing = await tx.period(tenantId, organizationId, input.periodId);
      if (existing) {
        if (existing.sourceGrantId !== sourceGrantId || existing.grantedMicroUsd !== granted || existing.planId !== 'individual-agreement')
          throw new FundingError(409, 'This month already has different funding. Apply an explicit correction instead.', 'period_conflict');
        return existing;
      }
      const row: CreditPeriodRow = { tenantId, organizationId, periodId: input.periodId, planId: 'individual-agreement',
        rateCardVersion: RATE_CARD_V1.version, grantedMicroUsd: granted, startsAt, endsAt, sourceGrantId, allocatedAt: this.at() };
      await tx.savePeriod(row); return row;
    });
  }

  /**
   * Record one verified Individual term's 1,000 credits (DIO-128), on first use inside that term.
   * The period id and both bounds come from the term alone, so a replacement grant, a reinstall, a
   * device or a repeated payment event names the same row. An existing row for the term is returned
   * unchanged when its payer, plan, bounds and amount agree, whichever current grant asks: its
   * historical source is never rewritten. Server-only; the caller has already verified that
   * `sourceGrantId` is a current complete-plan grant naming this term, and the database checks it again.
   */
  async allocateIndividualPeriod(input: { tenantId: string; organizationId: string; sourceGrantId: string; cycle: IndividualBillingCycle }): Promise<CreditPeriodRow> {
    const tenantId = requireId(input.tenantId, 'tenant'), organizationId = requireId(input.organizationId, 'account');
    const sourceGrantId = requireId(input.sourceGrantId, 'person grant');
    const cycle = verifiedIndividualCycle(input.cycle);
    if (!cycle) throw new FundingError(422, 'That is not a verified Individual billing period.', 'invalid_period');
    const granted = publishedMonthlyGrant('individual');
    if (granted === null) throw new FundingError(409, 'The Individual plan has no approved grant.', 'grant_not_approved');
    const periodId = individualCycleId(cycle);
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      // The time is read after the lock: a wait that crosses the period's end funds nothing.
      const at = this.at();
      const existing = await tx.period(tenantId, organizationId, periodId);
      if (existing) {
        if (existing.planId !== 'individual' || existing.grantedMicroUsd !== granted || existing.startsAt !== cycle.startsAt || existing.endsAt !== cycle.endsAt)
          throw new FundingError(409, 'This billing period already has different funding. Apply an explicit correction instead.', 'period_conflict');
        return existing;
      }
      if (!cycleContains(cycle, at))
        throw new FundingError(409, 'Credits are recorded only during their own billing period. An elapsed or future period is not funded now.', 'period_not_current');
      const others = (await tx.periods(tenantId, organizationId)).filter((row) => isIndividualCycleId(row.periodId) && periodsOverlap(row, cycle));
      if (others.length)
        throw new FundingError(409, 'Another Individual billing period already covers part of this time.', 'period_overlap');
      const row: CreditPeriodRow = { tenantId, organizationId, periodId, planId: 'individual', rateCardVersion: RATE_CARD_V1.version,
        grantedMicroUsd: granted, startsAt: cycle.startsAt, endsAt: cycle.endsAt, sourceGrantId, allocatedAt: at };
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
      return this.recordTopUpWithin(tx, { tenantId, organizationId, topUpId, amountMicroUsd: amount, sourceEventId });
    });
  }

  /** The top-up write, inside a transaction that already holds the organization's lock. */
  private async recordTopUpWithin(tx: FundingTransaction, input: { tenantId: string; organizationId: string; topUpId: string; amountMicroUsd: MicroUsd; sourceEventId: string }): Promise<TopUpRow> {
    const { tenantId, organizationId, topUpId, sourceEventId } = input;
    const existing = await tx.topUp(tenantId, topUpId);
    if (existing) {
      if (existing.organizationId !== organizationId || existing.amountMicroUsd !== input.amountMicroUsd || existing.sourceEventId !== sourceEventId)
        throw new FundingError(409, 'That top-up is already recorded with different terms.', 'topup_conflict');
      return existing;
    }
    const row: TopUpRow = { tenantId, organizationId, topUpId, amountMicroUsd: input.amountMicroUsd, provider: 'stripe', sourceEventId, recordedAt: this.at() };
    await tx.saveTopUp(row);
    return row;
  }

  /**
   * What a billing scope's bought credits leave free right now, read with SELECT only: no lock and no sweep, so it runs on the
   * Worker login, which may only read funding rows. A hold whose lease has lapsed is not counted (topUpTotals reads it so), so
   * this is never less than the locked read would give. Admission asks it; the reservation decides under the lock.
   */
  async boughtAvailable(tenantId: string, organizationId: string): Promise<MicroUsd> {
    requireId(tenantId, 'tenant');
    requireId(organizationId, 'organization');
    const at = this.at();
    return this.repository.transaction(async (tx) => topUpAvailable(await tx.topUpTotals(tenantId, organizationId, at)));
  }

  /**
   * Whether a billing scope's bought credits are above zero now, all spent or held, or were never bought: the same SELECT-only
   * read, saying no figure. Admission and the person's own access view ask it.
   */
  async boughtState(tenantId: string, organizationId: string): Promise<'available' | 'spent' | 'none'> {
    requireId(tenantId, 'tenant');
    requireId(organizationId, 'organization');
    const at = this.at();
    const totals = await this.repository.transaction((tx) => tx.topUpTotals(tenantId, organizationId, at));
    if (topUpAvailable(totals) > 0) return 'available';
    return totals.purchasedMicroUsd > 0 ? 'spent' : 'none';
  }

  /** What a business bought outright and what of it is held or spent. Read-only; money only from recorded top-ups. */
  async purchasedBalance(tenantId: string, organizationId: string): Promise<PurchasedBalance> {
    requireId(tenantId, 'tenant');
    requireId(organizationId, 'organization');
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      await tx.expireTopUpHolds(tenantId, organizationId, at);
      return balanceOf(await tx.topUpTotals(tenantId, organizationId, at));
    });
  }

  /**
   * Start a credit purchase (migration 015): the pending row, before Stripe is asked for a Checkout
   * Session. Idempotent by purchase id; the same terms find the row, different terms are a 409.
   * Server-only: the credits, the price and the rate come from the Worker's own settings and the business's plan, never from a request.
   * The credits are whole steps of the rate and the price is those steps at its price, in integers, so a row cannot say it bought credits
   * at a rate it was not charged.
   */
  async startCreditPurchase(input: { tenantId: string; organizationId: string; purchaseId: string; personId: string; credits: number; amountCents: number;
    rateCents: number; rateCredits: number; environment: 'test' | 'live' }): Promise<CreditPurchaseRow> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const purchaseId = requireId(input.purchaseId, 'purchase');
    const personId = requireId(input.personId, 'person');
    const { credits, amountCents, rateCents, rateCredits, environment } = input;
    if (environment !== 'test' && environment !== 'live')
      throw new FundingError(422, 'A purchase is made in the test or the live environment.', 'invalid_request');
    if (!Number.isSafeInteger(rateCents) || rateCents < 1 || rateCents > 99_999_999 || !Number.isSafeInteger(rateCredits) || rateCredits < 1 || rateCredits > 1_000_000)
      throw new FundingError(422, 'A purchase needs a rate in whole cents and whole credits.', 'invalid_amount');
    if (!Number.isSafeInteger(credits) || credits < rateCredits || credits > 1_000_000 || credits % rateCredits !== 0)
      throw new FundingError(422, 'Credits are bought in whole steps.', 'invalid_request');
    if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 99_999_999 || amountCents !== (credits / rateCredits) * rateCents)
      throw new FundingError(422, 'A purchase needs a price in whole cents that is its steps at the rate.', 'invalid_amount');
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const existing = await tx.creditPurchase(tenantId, purchaseId);
      if (existing) {
        if (existing.organizationId !== organizationId || existing.personId !== personId || existing.credits !== credits || existing.amountCents !== amountCents
          || existing.rateCents !== rateCents || existing.rateCredits !== rateCredits || existing.environment !== environment)
          throw new FundingError(409, 'That purchase already exists with different terms.', 'purchase_conflict');
        return existing;
      }
      const row: CreditPurchaseRow = { tenantId, organizationId, purchaseId, personId, credits, amountCents, rateCents, rateCredits, environment, currency: 'usd',
        checkoutSessionId: null, state: 'pending', createdAt: this.at(), resolvedAt: null, stripeEventId: null };
      await tx.saveCreditPurchase(row);
      return row;
    });
  }

  /** Keep the Checkout Session Stripe made for a pending purchase. A replay of the same session is a no-op. */
  async attachCheckoutSession(ref: { tenantId: string; organizationId: string; purchaseId: string }, sessionId: string): Promise<CreditPurchaseRow> {
    const tenantId = requireId(ref.tenantId, 'tenant');
    const organizationId = requireId(ref.organizationId, 'organization');
    const purchaseId = requireId(ref.purchaseId, 'purchase');
    if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]{1,250}$/.test(sessionId))
      throw new FundingError(422, 'A valid checkout session is required.', 'invalid_request');
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const row = await tx.creditPurchase(tenantId, purchaseId);
      if (!row || row.organizationId !== organizationId)
        throw new FundingError(404, 'That purchase was not found for this business.', 'unknown_purchase');
      if (row.checkoutSessionId === sessionId) return row;
      if (row.state !== 'pending' || row.checkoutSessionId !== null)
        throw new FundingError(409, 'That purchase is already closed.', 'purchase_closed');
      const next: CreditPurchaseRow = { ...row, checkoutSessionId: sessionId };
      await tx.saveCreditPurchase(next);
      return next;
    });
  }

  /** A pending purchase that never reached a Checkout Session ends here. Anything already resolved is left as it is. */
  async failCreditPurchase(ref: { tenantId: string; organizationId: string; purchaseId: string }): Promise<CreditPurchaseRow> {
    const tenantId = requireId(ref.tenantId, 'tenant');
    const organizationId = requireId(ref.organizationId, 'organization');
    const purchaseId = requireId(ref.purchaseId, 'purchase');
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const row = await tx.creditPurchase(tenantId, purchaseId);
      if (!row || row.organizationId !== organizationId)
        throw new FundingError(404, 'That purchase was not found for this business.', 'unknown_purchase');
      if (row.state !== 'pending' || row.checkoutSessionId !== null) return row;
      const next: CreditPurchaseRow = { ...row, state: 'failed', resolvedAt: this.at() };
      await tx.saveCreditPurchase(next);
      return next;
    });
  }

  /** A purchase, for the business that made it. Another business's purchase and an unknown one read the same. */
  async readCreditPurchase(ref: { tenantId: string; organizationId: string; purchaseId: string }): Promise<CreditPurchaseRow> {
    const tenantId = requireId(ref.tenantId, 'tenant');
    const organizationId = requireId(ref.organizationId, 'organization');
    const purchaseId = requireId(ref.purchaseId, 'purchase');
    return this.repository.transaction(async (tx) => {
      const row = await tx.creditPurchase(tenantId, purchaseId);
      if (!row || row.organizationId !== organizationId)
        throw new FundingError(404, 'That purchase was not found for this business.', 'unknown_purchase');
      return row;
    });
  }

  /**
   * Whether a verified paid event could pay a purchase, read-only: the checks resolveCreditPurchase makes
   * before it writes, in the same order, with nothing written. The webhook asks it first so the business
   * and tenant it stores the payment against are this stored purchase's own, never the event's metadata.
   * Replays, mismatches and unknown sessions come back ignored, with the reason, and change nothing.
   */
  async previewCreditPurchase(input: { sessionId: string; purchaseId: string | null; tenantId: string | null; organizationId: string | null;
    amountTotal: number | null; currency: string | null; environment: 'test' | 'live' }):
    Promise<{ outcome: 'payable'; tenantId: string; organizationId: string; purchaseId: string } | { outcome: 'ignored'; reason: string; purchaseId: string | null }> {
    const ignored = (reason: string, purchaseId: string | null = null) => ({ outcome: 'ignored' as const, reason, purchaseId });
    return this.repository.transaction(async (tx) => {
      const found = await tx.creditPurchaseBySession(input.sessionId);
      if (!found) return ignored('unknown_session');
      if (found.environment !== input.environment) return ignored('environment_mismatch', found.purchaseId);
      if (namesAnotherPurchase(found, input)) return ignored('metadata_mismatch', found.purchaseId);
      if (found.state !== 'pending') return ignored(`already_${found.state}`, found.purchaseId);
      if (paysAnotherAmount(found, input)) return ignored('amount_mismatch', found.purchaseId);
      return { outcome: 'payable' as const, tenantId: found.tenantId, organizationId: found.organizationId, purchaseId: found.purchaseId };
    });
  }

  /**
   * Apply a verified Stripe event to the purchase its Checkout Session pays. Only a pending purchase
   * moves, and only when the session and the purchase, business and tenant the event names are this
   * row's own. A paid event also needs the amount and currency to be the stored ones, and then marks the
   * purchase paid and records the top-up (the credits bought, keyed by the purchase id) in this one
   * transaction. Anything else changes nothing and says why. Server-only: the webhook calls it after
   * the signature has been verified.
   */
  async resolveCreditPurchase(input: { kind: 'paid' | 'expired' | 'failed'; sessionId: string; purchaseId: string | null; tenantId: string | null;
    organizationId: string | null; amountTotal: number | null; currency: string | null; eventId: string; environment: 'test' | 'live' }):
    Promise<{ outcome: 'paid' | 'expired' | 'failed' | 'ignored'; reason: string | null; purchaseId: string | null }> {
    const eventId = requireId(input.eventId, 'billing event');
    const ignored = (reason: string, purchaseId: string | null = null) => ({ outcome: 'ignored' as const, reason, purchaseId });
    return this.repository.transaction(async (tx) => {
      const found = await tx.creditPurchaseBySession(input.sessionId);
      if (!found) return ignored('unknown_session');
      if (found.environment !== input.environment) return ignored('environment_mismatch', found.purchaseId);
      if (namesAnotherPurchase(found, input)) return ignored('metadata_mismatch', found.purchaseId);
      await tx.lockOrganization(found.tenantId, found.organizationId);
      const purchase = await tx.creditPurchase(found.tenantId, found.purchaseId);
      if (!purchase || purchase.checkoutSessionId !== input.sessionId) return ignored('unknown_session', found.purchaseId);
      if (purchase.state !== 'pending') return ignored(`already_${purchase.state}`, purchase.purchaseId);
      const resolvedAt = this.at();
      if (input.kind !== 'paid') {
        await tx.saveCreditPurchase({ ...purchase, state: input.kind, resolvedAt, stripeEventId: eventId });
        return { outcome: input.kind, reason: null, purchaseId: purchase.purchaseId };
      }
      if (paysAnotherAmount(purchase, input)) return ignored('amount_mismatch', purchase.purchaseId);
      await this.recordTopUpWithin(tx, { tenantId: purchase.tenantId, organizationId: purchase.organizationId, topUpId: purchase.purchaseId,
        amountMicroUsd: creditAmount(purchase.credits), sourceEventId: eventId });
      await tx.saveCreditPurchase({ ...purchase, state: 'paid', resolvedAt, stripeEventId: eventId });
      return { outcome: 'paid', reason: null, purchaseId: purchase.purchaseId };
    });
  }

  private async lockedHold(tx: FundingTransaction, ref: { tenantId: string; organizationId: string; holdId: string; personId: string }, at: string): Promise<TopUpHoldRow> {
    await tx.lockOrganization(ref.tenantId, ref.organizationId);
    // Let go of lapsed leases before anything is read, so a hold is seen as it stands now.
    await tx.expireTopUpHolds(ref.tenantId, ref.organizationId, at);
    const hold = await tx.topUpHold(ref.tenantId, ref.holdId);
    // Another business's hold, and another person's, read as absent.
    if (!hold || hold.organizationId !== ref.organizationId || hold.personId !== ref.personId)
      throw new FundingError(404, 'That hold was not found for you in this business.', 'unknown_hold');
    return hold;
  }

  /**
   * Hold some of the credits a business bought outright, for a person who asked.
   *
   * Top-up only: this never reads the month, never takes a period or a job, and never draws on the
   * included grant. The balance it decides on is the recorded top-ups less what is already held or
   * settled against them, read under the organization lock; no figure in the request is a balance.
   * Idempotent by hold id: a retry with the same terms finds the hold, a different one is refused.
   */
  async holdPurchased(input: { tenantId: string; organizationId: string; holdId: string; personId: string; amountMicroUsd: MicroUsd; requestDigest: string }):
    Promise<{ hold: TopUpHoldRow; balance: PurchasedBalance }> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const holdId = requireId(input.holdId, 'hold');
    const personId = requireId(input.personId, 'person');
    const amount = requireMoney(input.amountMicroUsd, 'the amount to hold');
    const digest = typeof input.requestDigest === 'string' ? input.requestDigest : '';
    if (!digest || digest.length > 200) throw new FundingError(422, 'A hold names the request it is for.', 'invalid_request');
    if (amount > MAX_MONEY_MICRO_USD) throw new FundingError(422, 'That amount is too large to hold.', 'invalid_amount');
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      await tx.expireTopUpHolds(tenantId, organizationId, at);
      const existing = await tx.topUpHold(tenantId, holdId);
      const totals = await tx.topUpTotals(tenantId, organizationId, at);
      if (existing) {
        if (existing.organizationId !== organizationId || existing.personId !== personId || existing.amountMicroUsd !== amount || existing.requestDigest !== digest)
          throw new FundingError(409, 'That hold id is already used for a different hold.', 'hold_conflict');
        if (existing.state !== 'held')
          throw new FundingError(409, 'That hold is already closed.', 'hold_closed');
        return { hold: existing, balance: balanceOf(totals) };
      }
      const available = topUpAvailable(totals);
      if (available === 0)
        throw new FundingError(402, 'No bought usage is free to hold. Included usage can’t be reserved.', 'no_purchased_usage');
      if (amount > available)
        throw new FundingError(402, `This needs ${formatCredits(amount)} credits and ${formatCredits(available)} bought credits are free to hold.`, 'insufficient_purchased_usage');
      const hold: TopUpHoldRow = { tenantId, organizationId, holdId, personId, requestDigest: digest, amountMicroUsd: amount, debitMicroUsd: micro(0), absorbedMicroUsd: micro(0), state: 'held', createdAt: at, resolvedAt: null, leaseUntil: leaseFrom(at), releasedBy: null };
      await tx.saveTopUpHold(hold);
      return { hold, balance: balanceOf({ ...totals, heldMicroUsd: sumMoney([totals.heldMicroUsd, amount]) }) };
    });
  }

  /**
   * Settle a purchased-usage hold to a debit on the top-up balance, never on the month. The debit
   * is at most the hold; the rest is free again. A replay of the same figure returns the recorded
   * settlement and a different one is refused.
   *
   * Work that finishes after its hold let go on its own is still settled, but a business can't use more
   * bought credits than it had left. A hold released by expiry (a lapsed lease is let go before this
   * reads it) records against the business the least of the debit asked for, the amount held, and what
   * is free to hold at this moment under the organization lock, so the bought balance never goes below
   * zero. Diomedes covers the rest: it is kept on the row as absorbed and goes into no answer. A settle
   * on a live hold is recorded as asked. A hold the person released is still refused.
   *
   * The figure a replay is compared with is what was asked, which is the debit recorded plus what was
   * absorbed (for a live hold that is just the debit). Storing it needs no further column.
   */
  async settlePurchased(input: { tenantId: string; organizationId: string; holdId: string; personId: string; debitMicroUsd: MicroUsd }):
    Promise<{ hold: TopUpHoldRow; balance: PurchasedBalance }> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const holdId = requireId(input.holdId, 'hold');
    const personId = requireId(input.personId, 'person');
    const debit = requireMoney(input.debitMicroUsd, 'the amount to settle', false);
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      const hold = await this.lockedHold(tx, { tenantId, organizationId, holdId, personId }, at);
      if (hold.state === 'settled') {
        if (sumMoney([hold.debitMicroUsd, hold.absorbedMicroUsd]) !== debit) throw new FundingError(409, 'That hold is already settled for a different amount.', 'settlement_conflict');
        return { hold, balance: balanceOf(await tx.topUpTotals(tenantId, organizationId, at)) };
      }
      if (hold.state === 'released' && hold.releasedBy !== 'expiry')
        throw new FundingError(409, 'That hold was released, so it can’t be settled.', 'invalid_transition');
      if (debit > hold.amountMicroUsd)
        throw new FundingError(409, 'That is more than was held.', 'settlement_exceeds_hold');
      // Released by expiry, or still held with a lease that has lapsed: only what is free right now may be recorded.
      const late = hold.state === 'released' || Date.parse(hold.leaseUntil) <= Date.parse(at);
      const recorded = late
        ? micro(Math.min(debit, hold.amountMicroUsd, topUpAvailable(await tx.topUpTotals(tenantId, organizationId, at))))
        : debit;
      const settled: TopUpHoldRow = {
        ...hold, state: 'settled', debitMicroUsd: recorded, absorbedMicroUsd: subtractMoney(debit, recorded), resolvedAt: at, releasedBy: null,
      };
      await tx.saveTopUpHold(settled);
      return { hold: settled, balance: balanceOf(await tx.topUpTotals(tenantId, organizationId, at)) };
    });
  }

  /** Give a purchased-usage hold back unused. A settled hold can't be released. */
  async releasePurchased(input: { tenantId: string; organizationId: string; holdId: string; personId: string }):
    Promise<{ hold: TopUpHoldRow; balance: PurchasedBalance }> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const holdId = requireId(input.holdId, 'hold');
    const personId = requireId(input.personId, 'person');
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      const hold = await this.lockedHold(tx, { tenantId, organizationId, holdId, personId }, at);
      if (hold.state === 'settled') throw new FundingError(409, 'That hold was settled, so it can’t be released.', 'invalid_transition');
      if (hold.state === 'held') {
        const released: TopUpHoldRow = { ...hold, state: 'released', resolvedAt: at, releasedBy: 'person' };
        await tx.saveTopUpHold(released);
        return { hold: released, balance: balanceOf(await tx.topUpTotals(tenantId, organizationId, at)) };
      }
      // Already released, by the person or by the lapse of its lease: a replay, and it keeps who let go.
      return { hold, balance: balanceOf(await tx.topUpTotals(tenantId, organizationId, at)) };
    });
  }

  /**
   * Keep a purchased-usage hold: only the person who made it, and only while it is still held. The
   * new lease is a full lease from the service's own clock now; nothing in the request sets it. A hold
   * whose lease has lapsed, or that was settled or released, is refused and nothing is changed.
   */
  async renewPurchased(input: { tenantId: string; organizationId: string; holdId: string; personId: string }):
    Promise<{ hold: TopUpHoldRow; balance: PurchasedBalance }> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const holdId = requireId(input.holdId, 'hold');
    const personId = requireId(input.personId, 'person');
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      const hold = await this.lockedHold(tx, { tenantId, organizationId, holdId, personId }, at);
      if (hold.state === 'settled')
        throw new FundingError(409, 'That hold was settled, so it can’t be renewed.', 'hold_not_held');
      if (hold.state === 'released')
        throw new FundingError(409, hold.releasedBy === 'expiry'
          ? 'That hold’s lease ran out and it was let go, so it can’t be renewed.'
          : 'That hold was released, so it can’t be renewed.', 'hold_not_held');
      // A lapsed lease was let go above, so a held row here is live; this says so again in case it is not.
      if (Date.parse(hold.leaseUntil) <= Date.parse(at))
        throw new FundingError(409, 'That hold’s lease ran out, so it can’t be renewed.', 'hold_not_held');
      const renewed: TopUpHoldRow = { ...hold, leaseUntil: leaseFrom(at) };
      await tx.saveTopUpHold(renewed);
      return { hold: renewed, balance: balanceOf(await tx.topUpTotals(tenantId, organizationId, at)) };
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
    /**
     * The tier charge this attempt is held and debited under (Model B). The hold (`maxMicroUsd`) is
     * in its units, and `rateSnapshot` then prices only the provider's cost. Left out, the attempt
     * holds and debits at provider cost, as every attempt before tier pricing did.
     */
    chargeSnapshot?: ChargeSnapshot;
    /**
     * The verified member this work is for, and their role. Given by the gateway from the membership it
     * has just checked, never from a request. When present, the member's monthly limit is enforced here,
     * under the organization lock, and the attempt is recorded against them. Left out, as for a personal
     * workspace or a server-side caller, nothing is limited and nothing is attributed. Member limits
     * apply to businesses only: given together with `individualCycle`, the member is ignored, because a
     * personal Individual billing scope has no members.
     */
    member?: { personId: string; role: MemberRole };
    /**
     * The verified Individual term resolved by the server from the person's current grant. Never a
     * client value. Without it, the attempt binds to the UTC calendar month (Business, agreements
     * and legacy Individual grants).
     */
    individualCycle?: IndividualBillingCycle;
    /**
     * Pay as you go (DIO-219): the gateway sets it for a person's own Individual billing scope when no plan funds the work.
     * Never a client value. When the scope has no billing period, the reservation draws on its bought credits only and binds
     * to the scope's bought-credits row instead of failing `no_period`. A business scope never takes this path.
     */
    boughtOnly?: boolean;
  }): Promise<FundedAttempt> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const attemptId = requireId(input.attemptId, 'attempt');
    const rootJobId = requireId(input.rootJobId, 'job');
    const route = requireId(input.route, 'route');
    const requestDigest = requireId(input.requestDigest, 'request digest');
    const parentAttemptId = input.parentAttemptId === null ? null : requireId(input.parentAttemptId, 'parent attempt');
    const rate = requireRate(input.rateSnapshot);
    const charge = input.chargeSnapshot === undefined ? undefined : requireCharge(input.chargeSnapshot);
    if (!isUsageClass(input.usageClass))
      throw new FundingError(422, 'Say what this attempt is for: included-chat, metered-work, worker or automation.', 'invalid_usage_class');
    const usageClass = input.usageClass;
    if (!(RATE_CARD_V1.kinds as readonly string[]).includes(input.kind) || !debitsAllowance(RATE_CARD_V1, input.kind))
      throw new FundingError(409, 'That kind of charge is not run on included credits.', 'charge_not_admissible');
    const companyCeiling = input.companyCeilingMicroUsd === undefined || input.companyCeilingMicroUsd === null
      ? null : requireMoney(input.companyCeilingMicroUsd, 'the company spend ceiling', false);
    const member = input.member === undefined ? null
      : { personId: requireId(input.member.personId, 'person'), role: input.member.role };
    if (member && !MEMBER_ROLES.includes(member.role)) throw new FundingError(422, 'A member has an owner, admin or member role.', 'invalid_request');
    const cycle = input.individualCycle === undefined ? null : verifiedIndividualCycle(input.individualCycle);
    if (input.individualCycle !== undefined && !cycle) throw new FundingError(422, 'That is not a verified Individual billing period.', 'invalid_period');
    const boughtOnly = input.boughtOnly === true && !cycle && isIndividualScopeId(organizationId);
    // A personal Individual billing scope has no members: nothing there is limited or attributed to a person.
    const limitedMember = cycle || boughtOnly ? null : member;
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      // Read after the lock, so a reservation that waited past a period's end is judged at its end.
      const at = this.at();
      const existing = await tx.attempt(tenantId, attemptId);
      if (existing) {
        const same = existing.organizationId === organizationId && existing.rootJobId === rootJobId && existing.parentAttemptId === parentAttemptId &&
          existing.kind === input.kind && existing.route === route && existing.requestDigest === requestDigest &&
          existing.maxMicroUsd === input.maxMicroUsd && JSON.stringify(existing.rateSnapshot) === JSON.stringify(rate) &&
          JSON.stringify(existing.chargeSnapshot ?? null) === JSON.stringify(charge ?? null) &&
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
      if (cycle && !cycleContains(cycle, at))
        throw new FundingError(409, 'This billing period has ended, so its credits fund nothing new. Nothing was reserved.', 'period_ended');
      const periodId = cycle ? individualCycleId(cycle) : periodIdFor(at);
      let period = await tx.period(tenantId, organizationId, periodId);
      // No billing period, and the person pays as they go: bought credits only, on the scope's bought-credits row.
      if (!period && boughtOnly) period = await this.boughtCreditsRow(tx, tenantId, organizationId, at);
      if (!period)
        throw new FundingError(409, 'This billing period has no credit grant recorded yet, so nothing can be reserved.', 'no_period');
      if (cycle && (period.planId !== 'individual' || period.startsAt !== cycle.startsAt || period.endsAt !== cycle.endsAt))
        throw new FundingError(409, 'The recorded billing period does not match the verified term.', 'period_conflict');
      // Once an anniversary term covers this moment, a calendar row on the same account is history only.
      if (!cycle && (period.planId === 'individual' || period.planId === 'individual-agreement') &&
          (await tx.periods(tenantId, organizationId)).some((row) => isIndividualCycleId(row.periodId) && cycleContains(row, at)))
        throw new FundingError(409, 'A monthly Individual term now funds this account; earlier funding is kept for settlement only.', 'period_superseded');
      const decision = decideReserve({
        maxMicroUsd: input.maxMicroUsd,
        monthlyAvailableMicroUsd: monthlyAvailable(period, await tx.periodTotals(tenantId, organizationId, period.periodId)),
        topUpAvailableMicroUsd: topUpAvailable(await tx.topUpTotals(tenantId, organizationId, at)),
        job: { capMicroUsd: job.capMicroUsd, usedMicroUsd: await tx.jobUsed(tenantId, rootJobId) },
      });
      if (!decision.ok)
        throw new FundingError(decision.code === 'invalid_ceiling' ? 422 : 402, decision.reason, decision.code);
      // The shared pool has the funds and the job has the room. Now the member's own monthly limit,
      // read in the same transaction that holds the credits, so two steps by one member cannot both
      // slip under it. A refusal throws and rolls everything back: nothing is held and nothing is sent.
      if (limitedMember) await this.enforceMemberLimit(tx, { tenantId, organizationId, rootJobId, period, member: limitedMember, at, maxMicroUsd: input.maxMicroUsd, purchasedMicroUsd: decision.topUpHoldMicroUsd });
      if (companyCeiling !== null) {
        await tx.lockCompany();
        if (sumMoney([await tx.companySpend(), input.maxMicroUsd]) > companyCeiling)
          throw new FundingError(503, 'This hold would take the company’s provider spend past its ceiling.', 'company_ceiling');
      }
      const attempt: FundedAttempt = {
        id: attemptId, organizationId, periodId: period.periodId, parentTaskId: rootJobId, kind: input.kind, route, payer: 'managed',
        maxMicroUsd: input.maxMicroUsd, rateCardVersion: period.rateCardVersion, state: 'pending', createdAt: at,
        resolvedAt: null, uncertainReason: null, tenantId, rootJobId, parentAttemptId, requestDigest, rateSnapshot: rate,
        ...(charge ? { chargeSnapshot: charge } : {}), usageClass,
        monthlyHoldMicroUsd: decision.monthlyHoldMicroUsd, topUpHoldMicroUsd: decision.topUpHoldMicroUsd, dispatchedAt: null,
      };
      await tx.saveAttempt(attempt);
      if (limitedMember) await tx.saveAttemptPerson({ tenantId, attemptId, organizationId, personId: limitedMember.personId });
      return attempt;
    });
  }

  /**
   * The person's own bought-credits row (migration 017), written once, on their first reservation with no billing period,
   * inside the reserving transaction and under its lock. It grants nothing: a reservation bound to it draws on bought credits only.
   */
  private async boughtCreditsRow(tx: FundingTransaction, tenantId: string, organizationId: string, at: string): Promise<CreditPeriodRow> {
    const existing = await tx.period(tenantId, organizationId, BOUGHT_CREDITS_PERIOD);
    if (existing) return existing;
    const row: CreditPeriodRow = { tenantId, organizationId, periodId: BOUGHT_CREDITS_PERIOD, planId: BOUGHT_CREDITS_PLAN, rateCardVersion: RATE_CARD_V1.version,
      grantedMicroUsd: micro(0), startsAt: at, endsAt: BOUGHT_CREDITS_ENDS_AT, sourceGrantId: '', allocatedAt: at };
    await tx.savePeriod(row);
    return row;
  }

  /**
   * A member's monthly limit, checked for one reservation. The limit is the member's own setting, else
   * their role's, else the plan default (`shared/credit-allotments.ts`); an owner or admin has none
   * unless an owner set one. The member's usage is everything they hold or have settled this period, from
   * included and bought credits, and the purchased holds they asked for count too. Approvals add room
   * for this month and for this one job, and a step that would draw bought credits past the limit needs
   * an approval that allows them.
   */
  private async enforceMemberLimit(tx: FundingTransaction, input: {
    tenantId: string; organizationId: string; rootJobId: string; period: CreditPeriodRow; at: string;
    member: { personId: string; role: MemberRole }; maxMicroUsd: MicroUsd; purchasedMicroUsd: MicroUsd;
  }): Promise<void> {
    const { tenantId, organizationId, period, member, at } = input;
    const limit = effectiveLimit({
      role: member.role, personId: member.personId, settings: await tx.memberLimits(tenantId, organizationId),
      planId: period.planId, monthlyGrantMicroUsd: period.grantedMicroUsd,
    });
    if (limit.limitMicroUsd === null) return;
    const usage = (await tx.memberUsage(tenantId, organizationId, period, member.personId, at))[0];
    const approved = await tx.approvedAllowances(tenantId, organizationId, member.personId, period.periodId, input.rootJobId);
    const allowance: Allowance = {
      extraMicroUsd: sumMoney(approved.map((row) => row.extraMicroUsd ?? micro(0))),
      allowPurchased: approved.some((row) => row.allowPurchased),
    };
    const decided = decideMemberUse({
      limitMicroUsd: limit.limitMicroUsd, usedMicroUsd: micro((usage?.includedMicroUsd ?? 0) + (usage?.purchasedMicroUsd ?? 0)),
      reserveMicroUsd: input.maxMicroUsd, purchasedMicroUsd: input.purchasedMicroUsd, allowance,
    });
    if (!decided.ok) throw new FundingError(402, decided.reason, decided.code);
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
    const outcome = await this.repository.transaction(async (tx) => {
      const attempt = await this.lockedAttempt(tx, ref);
      const at = this.at();
      if (attempt.state !== 'pending')
        throw new FundingError(409, `A ${attempt.state} attempt cannot be sent.`, 'invalid_transition');
      // An Individual allowance ends at its period's end. An unsent hold from that period is released
      // as unsent, in this same transaction, rather than sent on credits that have expired.
      if (attempt.dispatchedAt === null) {
        const period = await tx.period(attempt.tenantId, attempt.organizationId, attempt.periodId);
        if (period?.planId === 'individual' && Date.parse(at) >= Date.parse(period.endsAt)) {
          await tx.saveAttempt({ ...this.move(attempt, 'release'), resolvedAt: at,
            uncertainReason: 'Released unsent: its Individual billing period ended before it was sent.' });
          return { expired: true as const };
        }
      }
      if (!(await tx.claimDispatch(attempt.tenantId, attempt.id, at)))
        throw new FundingError(409, 'That request is already being answered.', 'attempt_in_flight');
      return { expired: false as const, attempt: { ...attempt, dispatchedAt: at } };
    });
    if (outcome.expired)
      throw new FundingError(409, 'This billing period ended before the request was sent. Nothing was sent, and its hold was released.', 'period_ended');
    return outcome.attempt;
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
      // Model B: the debit is the tier's charge and the provider's cost is recorded beside it, never
      // debited. An attempt held before tier pricing has no charge and debits its provider cost, as before.
      const providerCost = usageCost(attempt.rateSnapshot, checked.usage);
      const cost = attempt.chargeSnapshot ? usageCost(attempt.chargeSnapshot, checked.usage) : providerCost;
      if (cost > attempt.maxMicroUsd)
        return hold('The provider reported more than was reserved. The hold stays for reconciliation; it is not clamped.');
      const monthly = Math.min(cost, attempt.monthlyHoldMicroUsd);
      const settledAttempt = { ...this.move(attempt, attempt.state === 'uncertain' ? 'reconcile' : 'settle'), resolvedAt: at };
      const settlement: AttemptSettlement = {
        reservationId: attempt.id, organizationId: attempt.organizationId, periodId: attempt.periodId,
        providerCostMicroUsd: providerCost, allowanceDebitMicroUsd: cost, rateCardVersion: attempt.rateCardVersion,
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
          topUp: await tx.topUpTotals(tenantId, organizationId, observedAt),
          lastReceipt: await tx.lastReceipt(tenantId, organizationId, periodId),
          observedAt,
        }),
      };
    });
  }

  /**
   * One verified Individual term's usage, for the person's own read. Read-only: before the term's
   * ledger row exists (it is written on first use) this projects the term's approved 1,000 credits
   * with nothing used and `allocation: 'pending'`; afterwards, ledger totals and `recorded`. The
   * caller has verified the term from the person's current grant; an ended term is refused.
   */
  async individualProjection(tenantId: string, organizationId: string, verified: IndividualBillingCycle): Promise<UsageState> {
    requireId(tenantId, 'tenant');
    requireId(organizationId, 'account');
    const cycle = verifiedIndividualCycle(verified);
    const granted = publishedMonthlyGrant('individual');
    const observedAt = this.at();
    if (!cycle || granted === null || !cycleContains(cycle, observedAt))
      return { state: 'unavailable', organizationId, reason: 'No current Individual billing period is recorded, so there is no usage to show.' };
    const periodId = individualCycleId(cycle);
    return this.repository.transaction(async (tx) => {
      const period = await tx.period(tenantId, organizationId, periodId);
      if (period && (period.planId !== 'individual' || period.startsAt !== cycle.startsAt || period.endsAt !== cycle.endsAt))
        return { state: 'unavailable', organizationId, reason: 'This billing period’s record needs review, so its usage is not shown.' };
      return {
        state: 'ready',
        organizationId,
        projection: projectUsage({
          organizationId,
          period: period ?? { periodId, planId: 'individual', grantedMicroUsd: granted, startsAt: cycle.startsAt, endsAt: cycle.endsAt, rateCardVersion: RATE_CARD_V1.version },
          totals: await tx.periodTotals(tenantId, organizationId, periodId),
          topUp: await tx.topUpTotals(tenantId, organizationId, observedAt),
          lastReceipt: await tx.lastReceipt(tenantId, organizationId, periodId),
          observedAt,
          allocation: period ? 'recorded' : 'pending',
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

const holdIdField = z.string().regex(idPattern);
export const purchasedHoldInput = z.strictObject({
  holdId: holdIdField,
  amountMicroUsd: z.number().int().positive().max(MAX_MONEY_MICRO_USD),
  requestDigest: z.string().min(1).max(200),
});
export const purchasedSettleInput = z.strictObject({
  holdId: holdIdField,
  debitMicroUsd: z.number().int().nonnegative().max(MAX_MONEY_MICRO_USD),
});
export const purchasedReleaseInput = z.strictObject({ holdId: holdIdField });
export const purchasedRenewInput = z.strictObject({ holdId: holdIdField });

function holdAnswer(result: { hold: TopUpHoldRow; balance: PurchasedBalance }) {
  const { hold, balance } = result;
  return {
    holdId: hold.holdId,
    state: hold.state,
    amountMicroUsd: hold.amountMicroUsd,
    debitMicroUsd: hold.debitMicroUsd,
    createdAt: hold.createdAt,
    resolvedAt: hold.resolvedAt,
    leaseUntil: hold.leaseUntil,
    balance,
  };
}

/**
 * Purchased-usage holds, asked for by a person with their own session (Andrew, 2026-10-01: usage a
 * business bought outright may be reserved; included usage may not). Membership is verified first,
 * the same assertion every workspace read uses, and the funding write runs under the organization's
 * own tenant and the verified person's id: nothing in a body names either. The only money these read
 * or move is the recorded top-up balance.
 */
export class PurchasedUsageService {
  constructor(
    private readonly accounts: Pick<AccountService, 'membership'>,
    private readonly funding: Pick<FundingService, 'purchasedBalance' | 'holdPurchased' | 'settlePurchased' | 'releasePurchased' | 'renewPurchased'>,
  ) {}

  async balance(token: string, organizationId: string): Promise<PurchasedBalance> {
    const snapshot = await this.accounts.membership(token, organizationId);
    return this.funding.purchasedBalance(snapshot.organization.tenantId, snapshot.organization.id);
  }

  async hold(token: string, organizationId: string, input: z.infer<typeof purchasedHoldInput>) {
    const snapshot = await this.accounts.membership(token, organizationId);
    return holdAnswer(await this.funding.holdPurchased({
      tenantId: snapshot.organization.tenantId, organizationId: snapshot.organization.id, personId: snapshot.person.id,
      holdId: input.holdId, amountMicroUsd: micro(input.amountMicroUsd), requestDigest: input.requestDigest,
    }));
  }

  async settle(token: string, organizationId: string, input: z.infer<typeof purchasedSettleInput>) {
    const snapshot = await this.accounts.membership(token, organizationId);
    return holdAnswer(await this.funding.settlePurchased({
      tenantId: snapshot.organization.tenantId, organizationId: snapshot.organization.id, personId: snapshot.person.id,
      holdId: input.holdId, debitMicroUsd: micro(input.debitMicroUsd),
    }));
  }

  async release(token: string, organizationId: string, input: z.infer<typeof purchasedReleaseInput>) {
    const snapshot = await this.accounts.membership(token, organizationId);
    return holdAnswer(await this.funding.releasePurchased({
      tenantId: snapshot.organization.tenantId, organizationId: snapshot.organization.id, personId: snapshot.person.id, holdId: input.holdId,
    }));
  }

  async renew(token: string, organizationId: string, input: z.infer<typeof purchasedRenewInput>) {
    const snapshot = await this.accounts.membership(token, organizationId);
    return holdAnswer(await this.funding.renewPurchased({
      tenantId: snapshot.organization.tenantId, organizationId: snapshot.organization.id, personId: snapshot.person.id, holdId: input.holdId,
    }));
  }
}
