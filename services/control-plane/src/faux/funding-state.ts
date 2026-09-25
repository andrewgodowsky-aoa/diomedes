import { micro, sumMoney, type AttemptSettlement, type FundedAttempt, type MicroUsd } from '../../../../shared/managed-usage.js';
import type { CapRequestRow, CreditAdjustmentRow, CreditPeriodRow, FundedJobRow, FundingRepository, FundingTransaction,
  JobRefRow, TopUpRow } from '../funding.js';

/** Funding rows as one JSON-serializable value, for the faux cloud and offline tests. */
export interface FundingState {
  periods: CreditPeriodRow[];
  jobs: FundedJobRow[];
  jobRefs: JobRefRow[];
  attempts: FundedAttempt[];
  settlements: AttemptSettlement[];
  adjustments: CreditAdjustmentRow[];
  topUps: TopUpRow[];
  capRequests: CapRequestRow[];
}

export const emptyFundingState = (): FundingState => ({ periods: [], jobs: [], jobRefs: [], attempts: [], settlements: [], adjustments: [], topUps: [], capRequests: [] });
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
  async capRequest(tenantId: string, id: string) { return this.state.capRequests.find((row) => row.tenantId === tenantId && row.requestId === id); }
  async saveCapRequest(row: CapRequestRow) { upsert(this.state.capRequests, row, (item) => item.tenantId === row.tenantId && item.requestId === row.requestId); }
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
      heldMicroUsd: sum(mine(this.state.attempts).filter((row) => row.state === 'pending' || row.state === 'uncertain').map((row) => row.topUpHoldMicroUsd)),
      settledMicroUsd: sum(mine(this.state.settlements).map((row) => row.topUpDebitMicroUsd)),
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
