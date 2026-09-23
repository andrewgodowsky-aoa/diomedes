/**
 * PostgreSQL adapter for funded parent-job accounting (migration 003).
 *
 * Every write transaction first takes a transaction-scoped advisory lock on the
 * tenant and organization, then reads the aggregates it decides on. Two
 * concurrent reservations for one organization therefore serialize, and the
 * second reads the first one's hold. The lock releases at COMMIT or ROLLBACK.
 *
 * This adapter has only been exercised against a recording client here. The
 * real-database cases live in the opt-in postgres.integration.test.ts suite.
 */
import { micro, type AttemptSettlement, type FundedAttempt, type MicroUsd, type PeriodTotals,
  type ProviderUsage, type RateSnapshot, type ReservationState, type TopUpTotals, type ChargeKind } from '../../../shared/managed-usage.js';
import type { CapRequestRow, CreditAdjustmentRow, CreditPeriodRow, FundedJobRow, FundingRepository, FundingTransaction,
  JobRefRow, TopUpRow } from './funding.js';
import { inTransaction, type ClientFactory, type SqlClient } from './postgres.js';

type Row = Record<string, unknown>;

/** bigint arrives as text; anything outside the safe integer range is refused. */
function money(value: unknown): MicroUsd {
  const count = typeof value === 'string' ? Number(value) : value;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
    throw new Error('Stored money is not a safe whole number of micro-USD.');
  return micro(count);
}
function iso(value: unknown): string {
  const when = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(when.getTime())) throw new Error('Stored time is unreadable.');
  return when.toISOString();
}
const isoOrNull = (value: unknown) => (value === null || value === undefined ? null : iso(value));
const text = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('Stored text is missing.');
  return value;
};
const textOrNull = (value: unknown) => (value === null || value === undefined ? null : text(value));
const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;

const ATTEMPT_COLUMNS = `tenant_id,reservation_id,organization_id,root_job_id,existing_parent_task_ref,period_id,kind,route,request_digest,
  rate_snapshot,rate_card_version,reserved_micro_usd,monthly_hold_micro_usd,topup_hold_micro_usd,state,created_at,dispatched_at,resolved_at,uncertain_reason`;
const SETTLEMENT_COLUMNS = `tenant_id,reservation_id,organization_id,period_id,provider_receipt_ref,provider_cost_micro_usd,allowance_debit_micro_usd,
  monthly_debit_micro_usd,topup_debit_micro_usd,usage,reconciled_from,settled_at,rate_card_version`;

function attemptFrom(row: Row): FundedAttempt {
  return {
    id: text(row.reservation_id), organizationId: text(row.organization_id), periodId: text(row.period_id),
    parentTaskId: text(row.root_job_id), kind: text(row.kind) as ChargeKind, route: text(row.route), payer: 'managed',
    maxMicroUsd: money(row.reserved_micro_usd), rateCardVersion: text(row.rate_card_version), state: text(row.state) as ReservationState,
    createdAt: iso(row.created_at), resolvedAt: isoOrNull(row.resolved_at), uncertainReason: textOrNull(row.uncertain_reason),
    tenantId: text(row.tenant_id), rootJobId: text(row.root_job_id), parentAttemptId: textOrNull(row.existing_parent_task_ref),
    requestDigest: text(row.request_digest), rateSnapshot: json<RateSnapshot>(row.rate_snapshot),
    monthlyHoldMicroUsd: money(row.monthly_hold_micro_usd), topUpHoldMicroUsd: money(row.topup_hold_micro_usd),
    dispatchedAt: isoOrNull(row.dispatched_at),
  };
}

function settlementFrom(row: Row): AttemptSettlement {
  const cost = money(row.provider_cost_micro_usd);
  return {
    reservationId: text(row.reservation_id), organizationId: text(row.organization_id), periodId: text(row.period_id),
    providerCostMicroUsd: cost, allowanceDebitMicroUsd: money(row.allowance_debit_micro_usd),
    rateCardVersion: text(row.rate_card_version), eligibility: 'included', settledAt: iso(row.settled_at),
    reconciledFrom: text(row.reconciled_from) as 'response' | 'provider-report', tenantId: text(row.tenant_id),
    receiptRef: text(row.provider_receipt_ref), monthlyDebitMicroUsd: money(row.monthly_debit_micro_usd),
    topUpDebitMicroUsd: money(row.topup_debit_micro_usd), usage: json<ProviderUsage>(row.usage),
  };
}

export class PostgresFundingTransaction implements FundingTransaction {
  constructor(private readonly client: SqlClient) {}
  private async one(sql: string, values: unknown[]): Promise<Row | undefined> {
    return (await this.client.query(sql, values)).rows[0];
  }

  async lockOrganization(tenantId: string, organizationId: string) {
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['funding', tenantId, organizationId])]);
  }

  async period(tenantId: string, organizationId: string, periodId: string): Promise<CreditPeriodRow | undefined> {
    const row = await this.one('SELECT * FROM control_plane.credit_periods WHERE tenant_id=$1 AND organization_id=$2 AND period_id=$3', [tenantId, organizationId, periodId]);
    return row && {
      tenantId: text(row.tenant_id), organizationId: text(row.organization_id), periodId: text(row.period_id), planId: text(row.plan_id),
      rateCardVersion: text(row.rate_card_version), grantedMicroUsd: money(row.granted_micro_usd), startsAt: iso(row.starts_at),
      endsAt: iso(row.ends_at), sourceGrantId: text(row.source_grant_id), allocatedAt: iso(row.allocated_at),
    };
  }
  async savePeriod(row: CreditPeriodRow) {
    await this.client.query('INSERT INTO control_plane.credit_periods(tenant_id,organization_id,period_id,plan_id,rate_card_version,granted_micro_usd,starts_at,ends_at,source_grant_id,allocated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [row.tenantId, row.organizationId, row.periodId, row.planId, row.rateCardVersion, row.grantedMicroUsd, row.startsAt, row.endsAt, row.sourceGrantId, row.allocatedAt]);
  }

  async job(tenantId: string, rootJobId: string): Promise<FundedJobRow | undefined> {
    const row = await this.one('SELECT * FROM control_plane.funded_jobs WHERE tenant_id=$1 AND root_job_id=$2 FOR UPDATE', [tenantId, rootJobId]);
    return row && {
      tenantId: text(row.tenant_id), organizationId: text(row.organization_id), rootJobId: text(row.root_job_id), runRef: text(row.run_ref),
      capMicroUsd: money(row.cap_micro_usd), capGeneration: Number(row.cap_generation), state: text(row.state) as 'open' | 'closed', openedAt: iso(row.opened_at),
    };
  }
  async jobRef(tenantId: string, runRef: string): Promise<JobRefRow | undefined> {
    const row = await this.one('SELECT * FROM control_plane.funded_job_refs WHERE tenant_id=$1 AND run_ref=$2', [tenantId, runRef]);
    return row && { tenantId: text(row.tenant_id), runRef: text(row.run_ref), rootJobId: text(row.root_job_id) };
  }
  async saveJob(row: FundedJobRow) {
    await this.client.query('INSERT INTO control_plane.funded_jobs(tenant_id,root_job_id,organization_id,run_ref,cap_micro_usd,cap_generation,state,opened_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,root_job_id) DO UPDATE SET cap_micro_usd=EXCLUDED.cap_micro_usd,cap_generation=EXCLUDED.cap_generation,state=EXCLUDED.state',
      [row.tenantId, row.rootJobId, row.organizationId, row.runRef, row.capMicroUsd, row.capGeneration, row.state, row.openedAt]);
  }
  async saveJobRef(row: JobRefRow) {
    await this.client.query('INSERT INTO control_plane.funded_job_refs(tenant_id,run_ref,root_job_id) VALUES ($1,$2,$3)', [row.tenantId, row.runRef, row.rootJobId]);
  }

  async attempt(tenantId: string, attemptId: string) {
    const row = await this.one(`SELECT ${ATTEMPT_COLUMNS} FROM control_plane.funding_reservations WHERE tenant_id=$1 AND reservation_id=$2 FOR UPDATE`, [tenantId, attemptId]);
    return row && attemptFrom(row);
  }
  async saveAttempt(row: FundedAttempt) {
    await this.client.query(`INSERT INTO control_plane.funding_reservations(tenant_id,reservation_id,account_id,existing_run_ref,existing_parent_task_ref,rate_card_version,reserved_micro_usd,state,created_at,
        organization_id,root_job_id,period_id,kind,route,request_digest,rate_snapshot,monthly_hold_micro_usd,topup_hold_micro_usd,dispatched_at,resolved_at,uncertain_reason)
      VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$3,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19)
      ON CONFLICT (tenant_id,reservation_id) DO UPDATE SET state=EXCLUDED.state,dispatched_at=EXCLUDED.dispatched_at,resolved_at=EXCLUDED.resolved_at,uncertain_reason=EXCLUDED.uncertain_reason`,
      [row.tenantId, row.id, row.rootJobId, row.parentAttemptId, row.rateCardVersion, row.maxMicroUsd, row.state, row.createdAt,
        row.organizationId, row.periodId, row.kind, row.route, row.requestDigest, JSON.stringify(row.rateSnapshot),
        row.monthlyHoldMicroUsd, row.topUpHoldMicroUsd, row.dispatchedAt, row.resolvedAt, row.uncertainReason]);
  }
  async pendingAttempts(tenantId: string, organizationId: string) {
    const result = await this.client.query(`SELECT ${ATTEMPT_COLUMNS} FROM control_plane.funding_reservations WHERE tenant_id=$1 AND organization_id=$2 AND state='pending' ORDER BY created_at,reservation_id FOR UPDATE`, [tenantId, organizationId]);
    return result.rows.map(attemptFrom);
  }

  async settlement(tenantId: string, attemptId: string) {
    const row = await this.one(`SELECT ${SETTLEMENT_COLUMNS} FROM control_plane.funding_settlements WHERE tenant_id=$1 AND reservation_id=$2`, [tenantId, attemptId]);
    return row && settlementFrom(row);
  }
  async saveSettlement(row: AttemptSettlement) {
    await this.client.query(`INSERT INTO control_plane.funding_settlements(tenant_id,reservation_id,provider_receipt_ref,provider_cost_micro_usd,allowance_debit_micro_usd,invoice_micro_usd,settled_at,
        organization_id,period_id,monthly_debit_micro_usd,topup_debit_micro_usd,usage,reconciled_from)
      VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [row.tenantId, row.reservationId, row.receiptRef, row.providerCostMicroUsd, row.allowanceDebitMicroUsd, row.settledAt,
        row.organizationId, row.periodId, row.monthlyDebitMicroUsd, row.topUpDebitMicroUsd, JSON.stringify(row.usage), row.reconciledFrom]);
  }

  async adjustment(tenantId: string, adjustmentId: string): Promise<CreditAdjustmentRow | undefined> {
    const row = await this.one('SELECT * FROM control_plane.credit_adjustments WHERE tenant_id=$1 AND adjustment_id=$2', [tenantId, adjustmentId]);
    return row && {
      id: text(row.adjustment_id), organizationId: text(row.organization_id), periodId: text(row.period_id), reason: 'correction',
      direction: text(row.direction) as 'grant' | 'withdraw', amountMicroUsd: money(row.amount_micro_usd), at: iso(row.recorded_at),
      note: text(row.note), sourceEventId: null, tenantId: text(row.tenant_id), attemptRef: textOrNull(row.attempt_ref),
    };
  }
  async saveAdjustment(row: CreditAdjustmentRow) {
    await this.client.query('INSERT INTO control_plane.credit_adjustments(tenant_id,adjustment_id,organization_id,period_id,reason,direction,amount_micro_usd,attempt_ref,note,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [row.tenantId, row.id, row.organizationId, row.periodId, row.reason, row.direction, row.amountMicroUsd, row.attemptRef, row.note, row.at]);
  }

  async topUp(tenantId: string, topUpId: string): Promise<TopUpRow | undefined> {
    const row = await this.one('SELECT * FROM control_plane.credit_topups WHERE tenant_id=$1 AND topup_id=$2', [tenantId, topUpId]);
    return row && {
      tenantId: text(row.tenant_id), organizationId: text(row.organization_id), topUpId: text(row.topup_id), amountMicroUsd: money(row.amount_micro_usd),
      provider: 'stripe', sourceEventId: text(row.source_event_id), recordedAt: iso(row.recorded_at),
    };
  }
  async saveTopUp(row: TopUpRow) {
    await this.client.query('INSERT INTO control_plane.credit_topups(tenant_id,topup_id,organization_id,amount_micro_usd,provider,source_event_id,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [row.tenantId, row.topUpId, row.organizationId, row.amountMicroUsd, row.provider, row.sourceEventId, row.recordedAt]);
  }

  async capRequest(tenantId: string, requestId: string): Promise<CapRequestRow | undefined> {
    const row = await this.one('SELECT * FROM control_plane.job_cap_requests WHERE tenant_id=$1 AND request_id=$2', [tenantId, requestId]);
    return row && {
      tenantId: text(row.tenant_id), organizationId: text(row.organization_id), requestId: text(row.request_id), rootJobId: text(row.root_job_id),
      requestedCapMicroUsd: money(row.requested_cap_micro_usd), requestedBy: text(row.requested_by), state: text(row.state) as CapRequestRow['state'],
      requestedAt: iso(row.requested_at), decidedBy: textOrNull(row.decided_by), decidedAt: isoOrNull(row.decided_at),
    };
  }
  async saveCapRequest(row: CapRequestRow) {
    await this.client.query('INSERT INTO control_plane.job_cap_requests(tenant_id,request_id,organization_id,root_job_id,requested_cap_micro_usd,requested_by,state,requested_at,decided_by,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id,request_id) DO UPDATE SET state=EXCLUDED.state,decided_by=EXCLUDED.decided_by,decided_at=EXCLUDED.decided_at',
      [row.tenantId, row.requestId, row.organizationId, row.rootJobId, row.requestedCapMicroUsd, row.requestedBy, row.state, row.requestedAt, row.decidedBy, row.decidedAt]);
  }

  async periodTotals(tenantId: string, organizationId: string, periodId: string): Promise<PeriodTotals> {
    const row = await this.one(`SELECT
        (SELECT COALESCE(SUM(monthly_debit_micro_usd),0) FROM control_plane.funding_settlements WHERE tenant_id=$1 AND organization_id=$2 AND period_id=$3) AS settled_monthly,
        (SELECT COALESCE(SUM(topup_debit_micro_usd),0) FROM control_plane.funding_settlements WHERE tenant_id=$1 AND organization_id=$2 AND period_id=$3) AS settled_topup,
        (SELECT COALESCE(SUM(monthly_hold_micro_usd),0) FROM control_plane.funding_reservations WHERE tenant_id=$1 AND organization_id=$2 AND period_id=$3 AND state='pending') AS pending_monthly,
        (SELECT COALESCE(SUM(monthly_hold_micro_usd),0) FROM control_plane.funding_reservations WHERE tenant_id=$1 AND organization_id=$2 AND period_id=$3 AND state='uncertain') AS uncertain_monthly,
        (SELECT COALESCE(SUM(amount_micro_usd),0) FROM control_plane.credit_adjustments WHERE tenant_id=$1 AND organization_id=$2 AND period_id=$3 AND direction='grant') AS correction_grants,
        (SELECT COALESCE(SUM(amount_micro_usd),0) FROM control_plane.credit_adjustments WHERE tenant_id=$1 AND organization_id=$2 AND period_id=$3 AND direction='withdraw') AS correction_withdrawals`,
      [tenantId, organizationId, periodId]);
    if (!row) throw new Error('Period totals returned no row.');
    return {
      settledMonthlyMicroUsd: money(row.settled_monthly), pendingMonthlyMicroUsd: money(row.pending_monthly),
      uncertainMonthlyMicroUsd: money(row.uncertain_monthly), correctionGrantsMicroUsd: money(row.correction_grants),
      correctionWithdrawalsMicroUsd: money(row.correction_withdrawals), settledTopUpMicroUsd: money(row.settled_topup),
    };
  }
  async topUpTotals(tenantId: string, organizationId: string): Promise<TopUpTotals> {
    const row = await this.one(`SELECT
        (SELECT COALESCE(SUM(amount_micro_usd),0) FROM control_plane.credit_topups WHERE tenant_id=$1 AND organization_id=$2) AS purchased,
        (SELECT COALESCE(SUM(topup_hold_micro_usd),0) FROM control_plane.funding_reservations WHERE tenant_id=$1 AND organization_id=$2 AND state IN ('pending','uncertain')) AS held,
        (SELECT COALESCE(SUM(topup_debit_micro_usd),0) FROM control_plane.funding_settlements WHERE tenant_id=$1 AND organization_id=$2) AS settled`,
      [tenantId, organizationId]);
    if (!row) throw new Error('Top-up totals returned no row.');
    return { purchasedMicroUsd: money(row.purchased), heldMicroUsd: money(row.held), settledMicroUsd: money(row.settled) };
  }
  async jobUsed(tenantId: string, rootJobId: string): Promise<MicroUsd> {
    const row = await this.one(`SELECT
        (SELECT COALESCE(SUM(reserved_micro_usd),0) FROM control_plane.funding_reservations WHERE tenant_id=$1 AND root_job_id=$2 AND state IN ('pending','uncertain'))
      + (SELECT COALESCE(SUM(s.allowance_debit_micro_usd),0) FROM control_plane.funding_settlements s
           JOIN control_plane.funding_reservations r ON r.tenant_id=s.tenant_id AND r.reservation_id=s.reservation_id
           WHERE r.tenant_id=$1 AND r.root_job_id=$2 AND r.state='settled') AS used`,
      [tenantId, rootJobId]);
    return money(row?.used);
  }
  async lastReceipt(tenantId: string, organizationId: string, periodId: string) {
    const row = await this.one('SELECT provider_receipt_ref,settled_at,allowance_debit_micro_usd FROM control_plane.funding_settlements WHERE tenant_id=$1 AND organization_id=$2 AND period_id=$3 ORDER BY settled_at DESC, reservation_id DESC LIMIT 1',
      [tenantId, organizationId, periodId]);
    return row ? { receiptRef: text(row.provider_receipt_ref), settledAt: iso(row.settled_at), allowanceDebitMicroUsd: money(row.allowance_debit_micro_usd) } : null;
  }
}

/** One request-owned driver session per call, through the existing transaction protocol. */
export class PostgresFundingRepository implements FundingRepository {
  constructor(private readonly factory: ClientFactory) {}
  transaction<T>(action: (tx: FundingTransaction) => Promise<T>): Promise<T> {
    return inTransaction(this.factory, (client) => action(new PostgresFundingTransaction(client)));
  }
}
