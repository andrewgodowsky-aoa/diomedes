import { micro, sumMoney, type AttemptSettlement, type FundedAttempt, type MicroUsd } from '../../../../shared/managed-usage.js';
import type { CapRequestRow, CreditAdjustmentRow, CreditPeriodRow, FundedJobRow, FundingRepository, FundingTransaction,
  JobRefRow, TopUpHoldRow, TopUpRow } from '../funding.js';
import type { AllotmentSettingsRow, AttemptPersonRow, LimitRequestRow, MemberLimitRow, MemberUsageRow } from '../member-limits.js';

/** Funding rows as one JSON-serializable value, for the faux cloud and offline tests. */
export interface FundingState {
  periods: CreditPeriodRow[];
  jobs: FundedJobRow[];
  jobRefs: JobRefRow[];
  attempts: FundedAttempt[];
  settlements: AttemptSettlement[];
  adjustments: CreditAdjustmentRow[];
  topUps: TopUpRow[];
  /** Purchased-usage holds (migration 013). Stores written before it have none. */
  topUpHolds: TopUpHoldRow[];
  capRequests: CapRequestRow[];
  /** Per-member limits, raise requests and who each attempt was for (migration 014). Stores written before it have none. */
  memberLimits: MemberLimitRow[];
  allotmentSettings: AllotmentSettingsRow[];
  limitRequests: LimitRequestRow[];
  attemptPeople: AttemptPersonRow[];
}

export const emptyFundingState = (): FundingState => ({ periods: [], jobs: [], jobRefs: [], attempts: [], settlements: [], adjustments: [], topUps: [], topUpHolds: [], capRequests: [],
  memberLimits: [], allotmentSettings: [], limitRequests: [], attemptPeople: [] });
const sum = (values: MicroUsd[]) => (values.length ? sumMoney(values) : micro(0));
const upsert = <T>(rows: T[], row: T, same: (item: T) => boolean) => {
  const index = rows.findIndex(same);
  if (index < 0) rows.push(row); else rows[index] = row;
};

/**
 * Funding operations over an in-memory draft. The caller serializes
 * transactions and owns persistence; this class owns neither.
 */
export class StateFundingTransaction implements FundingTransaction {
  constructor(private readonly state: FundingState) {}
  async lockOrganization() {}
  async period(tenantId: string, organizationId: string, periodId: string) {
    return this.state.periods.find((row) => row.tenantId === tenantId && row.organizationId === organizationId && row.periodId === periodId);
  }
  async savePeriod(row: CreditPeriodRow) { this.state.periods.push(row); }
  async job(tenantId: string, rootJobId: string) { return this.state.jobs.find((row) => row.tenantId === tenantId && row.rootJobId === rootJobId); }
  async jobRef(tenantId: string, runRef: string) { return this.state.jobRefs.find((row) => row.tenantId === tenantId && row.runRef === runRef); }
  async saveJob(row: FundedJobRow) { upsert(this.state.jobs, row, (item) => item.tenantId === row.tenantId && item.rootJobId === row.rootJobId); }
  async saveJobRef(row: JobRefRow) { this.state.jobRefs.push(row); }
  async attempt(tenantId: string, attemptId: string) { return this.state.attempts.find((row) => row.tenantId === tenantId && row.id === attemptId); }
  async saveAttempt(row: FundedAttempt) { upsert(this.state.attempts, row, (item) => item.tenantId === row.tenantId && item.id === row.id); }
  async pendingAttempts(tenantId: string, organizationId: string) {
    return this.state.attempts.filter((row) => row.tenantId === tenantId && row.organizationId === organizationId && row.state === 'pending');
  }
  async settlement(tenantId: string, attemptId: string) { return this.state.settlements.find((row) => row.tenantId === tenantId && row.reservationId === attemptId); }
  async saveSettlement(row: AttemptSettlement) { this.state.settlements.push(row); }
  async adjustment(tenantId: string, id: string) { return this.state.adjustments.find((row) => row.tenantId === tenantId && row.id === id); }
  async saveAdjustment(row: CreditAdjustmentRow) { this.state.adjustments.push(row); }
  async topUp(tenantId: string, id: string) { return this.state.topUps.find((row) => row.tenantId === tenantId && row.topUpId === id); }
  async saveTopUp(row: TopUpRow) { this.state.topUps.push(row); }
  async topUpHold(tenantId: string, holdId: string) { return this.state.topUpHolds.find((row) => row.tenantId === tenantId && row.holdId === holdId); }
  async saveTopUpHold(row: TopUpHoldRow) { upsert(this.state.topUpHolds, row, (item) => item.tenantId === row.tenantId && item.holdId === row.holdId); }
  async capRequest(tenantId: string, id: string) { return this.state.capRequests.find((row) => row.tenantId === tenantId && row.requestId === id); }
  async saveCapRequest(row: CapRequestRow) { upsert(this.state.capRequests, row, (item) => item.tenantId === row.tenantId && item.requestId === row.requestId); }
  async memberLimits(tenantId: string, organizationId: string) {
    return this.state.memberLimits.filter((row) => row.tenantId === tenantId && row.organizationId === organizationId);
  }
  async saveMemberLimit(row: MemberLimitRow) {
    upsert(this.state.memberLimits, row, (item) => item.tenantId === row.tenantId && item.organizationId === row.organizationId
      && item.subjectKind === row.subjectKind && item.subjectId === row.subjectId);
  }
  async allotmentSettings(tenantId: string, organizationId: string) {
    return this.state.allotmentSettings.find((row) => row.tenantId === tenantId && row.organizationId === organizationId);
  }
  async saveAllotmentSettings(row: AllotmentSettingsRow) {
    upsert(this.state.allotmentSettings, row, (item) => item.tenantId === row.tenantId && item.organizationId === row.organizationId);
  }
  async limitRequest(tenantId: string, requestId: string) {
    return this.state.limitRequests.find((row) => row.tenantId === tenantId && row.requestId === requestId);
  }
  async saveLimitRequest(row: LimitRequestRow) {
    upsert(this.state.limitRequests, row, (item) => item.tenantId === row.tenantId && item.requestId === row.requestId);
  }
  async limitRequests(tenantId: string, organizationId: string, filter: { personId?: string; state?: LimitRequestRow['state'] }) {
    return this.state.limitRequests.filter((row) => row.tenantId === tenantId && row.organizationId === organizationId
      && (filter.personId === undefined || row.personId === filter.personId) && (filter.state === undefined || row.state === filter.state))
      .sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : a.requestId < b.requestId ? -1 : 1));
  }
  async approvedAllowances(tenantId: string, organizationId: string, personId: string, periodId: string, rootJobId: string) {
    return this.state.limitRequests.filter((row) => row.tenantId === tenantId && row.organizationId === organizationId && row.scopeKind === 'person'
      && row.personId === personId && row.state === 'approved'
      && ((row.kind === 'month' && row.periodId === periodId) || (row.kind === 'job' && row.rootJobId === rootJobId)));
  }
  async saveAttemptPerson(row: AttemptPersonRow) { this.state.attemptPeople.push(row); }
  async memberUsage(tenantId: string, organizationId: string, period: CreditPeriodRow, personId: string | null): Promise<MemberUsageRow[]> {
    const personOf = (attemptId: string) => this.state.attemptPeople.find((row) => row.tenantId === tenantId && row.attemptId === attemptId)?.personId;
    const totals = new Map<string, { included: number; purchased: number; held: number }>();
    const add = (person: string | undefined, included: number, purchased: number, held: number) => {
      if (person === undefined || (personId !== null && person !== personId)) return;
      const row = totals.get(person) ?? { included: 0, purchased: 0, held: 0 };
      totals.set(person, { included: row.included + included, purchased: row.purchased + purchased, held: row.held + held });
    };
    for (const row of this.state.attempts)
      if (row.tenantId === tenantId && row.organizationId === organizationId && row.periodId === period.periodId && (row.state === 'pending' || row.state === 'uncertain'))
        add(personOf(row.id), row.monthlyHoldMicroUsd, row.topUpHoldMicroUsd, row.maxMicroUsd);
    for (const row of this.state.settlements)
      if (row.tenantId === tenantId && row.organizationId === organizationId && row.periodId === period.periodId)
        add(personOf(row.reservationId), row.monthlyDebitMicroUsd, row.topUpDebitMicroUsd, 0);
    for (const row of this.state.topUpHolds) {
      if (row.tenantId !== tenantId || row.organizationId !== organizationId) continue;
      if (row.state === 'held') add(row.personId, 0, row.amountMicroUsd, row.amountMicroUsd);
      else if (row.state === 'settled' && row.resolvedAt !== null && row.resolvedAt >= period.startsAt && row.resolvedAt < period.endsAt) add(row.personId, 0, row.debitMicroUsd, 0);
    }
    return [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([person, row]) => ({ personId: person, includedMicroUsd: micro(row.included), purchasedMicroUsd: micro(row.purchased), heldMicroUsd: micro(row.held) }));
  }
  async periodTotals(tenantId: string, organizationId: string, periodId: string) {
    const attempts = this.state.attempts.filter((row) => row.tenantId === tenantId && row.organizationId === organizationId && row.periodId === periodId);
    const settlements = this.state.settlements.filter((row) => row.tenantId === tenantId && row.organizationId === organizationId && row.periodId === periodId);
    const adjustments = this.state.adjustments.filter((row) => row.tenantId === tenantId && row.organizationId === organizationId && row.periodId === periodId);
    return {
      settledMonthlyMicroUsd: sum(settlements.map((row) => row.monthlyDebitMicroUsd)),
      pendingMonthlyMicroUsd: sum(attempts.filter((row) => row.state === 'pending').map((row) => row.monthlyHoldMicroUsd)),
      uncertainMonthlyMicroUsd: sum(attempts.filter((row) => row.state === 'uncertain').map((row) => row.monthlyHoldMicroUsd)),
      correctionGrantsMicroUsd: sum(adjustments.filter((row) => row.direction === 'grant').map((row) => row.amountMicroUsd)),
      correctionWithdrawalsMicroUsd: sum(adjustments.filter((row) => row.direction === 'withdraw').map((row) => row.amountMicroUsd)),
      settledTopUpMicroUsd: sum(settlements.map((row) => row.topUpDebitMicroUsd)),
    };
  }
  async topUpTotals(tenantId: string, organizationId: string) {
    const mine = <T extends { tenantId: string; organizationId: string }>(rows: T[]) => rows.filter((row) => row.tenantId === tenantId && row.organizationId === organizationId);
    return {
      purchasedMicroUsd: sum(mine(this.state.topUps).map((row) => row.amountMicroUsd)),
      heldMicroUsd: sum([
        ...mine(this.state.attempts).filter((row) => row.state === 'pending' || row.state === 'uncertain').map((row) => row.topUpHoldMicroUsd),
        ...mine(this.state.topUpHolds).filter((row) => row.state === 'held').map((row) => row.amountMicroUsd),
      ]),
      settledMicroUsd: sum([
        ...mine(this.state.settlements).map((row) => row.topUpDebitMicroUsd),
        ...mine(this.state.topUpHolds).filter((row) => row.state === 'settled').map((row) => row.debitMicroUsd),
      ]),
    };
  }
  async jobUsed(tenantId: string, rootJobId: string) {
    const attempts = this.state.attempts.filter((row) => row.tenantId === tenantId && row.rootJobId === rootJobId);
    const held = attempts.filter((row) => row.state === 'pending' || row.state === 'uncertain').map((row) => row.maxMicroUsd);
    const settled = attempts.filter((row) => row.state === 'settled').map((row) => {
      const charge = this.state.settlements.find((item) => item.tenantId === tenantId && item.reservationId === row.id);
      if (!charge) throw new Error(`Attempt ${row.id} is settled with no charge.`);
      return charge.allowanceDebitMicroUsd;
    });
    return sum([...held, ...settled]);
  }
  async claimDispatch(tenantId: string, attemptId: string, at: string) {
    const index = this.state.attempts.findIndex((row) => row.tenantId === tenantId && row.id === attemptId && row.state === 'pending' && row.dispatchedAt === null);
    if (index < 0) return false;
    this.state.attempts[index] = { ...this.state.attempts[index], dispatchedAt: at };
    return true;
  }
  async lockCompany() {}
  async companySpend() {
    const held = this.state.attempts.filter((row) => row.state === 'pending' || row.state === 'uncertain' || row.state === 'written-off');
    return sum([...this.state.settlements.map((row) => row.providerCostMicroUsd), ...held.map((row) => row.maxMicroUsd)]);
  }
  async lastReceipt(tenantId: string, organizationId: string, periodId: string) {
    const rows = this.state.settlements.filter((row) => row.tenantId === tenantId && row.organizationId === organizationId && row.periodId === periodId)
      .sort((a, b) => (a.settledAt < b.settledAt ? -1 : a.settledAt > b.settledAt ? 1 : 0));
    const last = rows.at(-1);
    return last ? { receiptRef: last.receiptRef, settledAt: last.settledAt, allowanceDebitMicroUsd: last.allowanceDebitMicroUsd } : null;
  }
}
