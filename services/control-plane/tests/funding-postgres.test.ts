/**
 * The funding SQL adapter against a recording client. Protocol only: this does
 * not parse SQL or prove PostgreSQL locking. It checks that the organization
 * lock is taken before any aggregate is read, that a failed COMMIT is never
 * replayed, and that stored money outside the safe range is refused.
 */
import { describe, expect, it } from 'vitest';
import { creditAmount } from '../../../shared/managed-usage.js';
import { FundingService } from '../src/funding.js';
import { PostgresFundingRepository } from '../src/funding-postgres.js';
import type { SqlClient } from '../src/postgres.js';

const at = '2026-09-10T12:00:00.000Z';
const now = () => Date.parse(at);

function recording(options: { failCommit?: boolean; money?: string } = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client: SqlClient = {
    async connect() {},
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql === 'COMMIT' && options.failCommit) throw Object.assign(new Error('connection lost during commit'), { code: '08006' });
      if (sql.includes('FROM control_plane.funded_jobs'))
        return { rows: [{ tenant_id: 't1', organization_id: 'org_1', root_job_id: 'job_1', run_ref: 'run_1', cap_micro_usd: String(creditAmount(20)), cap_generation: 0, state: 'open', opened_at: new Date(at) }], rowCount: 1 };
      if (sql.includes('FROM control_plane.credit_periods'))
        return { rows: [{ tenant_id: 't1', organization_id: 'org_1', period_id: '2026-09', plan_id: 'business', rate_card_version: 'rate-card-2026-09-10.1', granted_micro_usd: options.money ?? String(creditAmount(1000)), starts_at: new Date('2026-09-01T00:00:00Z'), ends_at: new Date('2026-10-01T00:00:00Z'), source_grant_id: 'grant_1', allocated_at: new Date(at) }], rowCount: 1 };
      if (sql.includes('AS settled_monthly'))
        return { rows: [{ settled_monthly: '0', settled_topup: '0', pending_monthly: '0', uncertain_monthly: '0', correction_grants: '0', correction_withdrawals: '0' }], rowCount: 1 };
      if (sql.includes('AS purchased')) return { rows: [{ purchased: '0', held: '0', settled: '0' }], rowCount: 1 };
      if (sql.includes('AS used')) return { rows: [{ used: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  return { factory: () => client, calls };
}

const reserveInput = {
  tenantId: 't1', organizationId: 'org_1', attemptId: 'attempt_1', rootJobId: 'job_1', parentAttemptId: null,
  kind: 'generation' as const, route: 'aws-bedrock', requestDigest: 'digest_1',
  rateSnapshot: { version: 'r1', inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1, cacheReadMicroUsdPerMillion: 1, cacheWriteMicroUsdPerMillion: 1 },
  maxMicroUsd: creditAmount(5),
};

describe('funding SQL adapter protocol', () => {
  it('takes the organization lock before reading any balance, then inserts once and commits', async () => {
    const db = recording();
    const service = new FundingService(new PostgresFundingRepository(db.factory), { now, approvedDefaultJobCapMicroUsd: creditAmount(20) });
    const attempt = await service.reserve(reserveInput);
    expect(attempt.monthlyHoldMicroUsd).toBe(creditAmount(5));
    const sql = db.calls.map((call) => call.sql);
    const lock = sql.findIndex((item) => item.includes('pg_advisory_xact_lock'));
    const firstRead = sql.findIndex((item) => item.includes('control_plane.'));
    expect(lock).toBeGreaterThan(sql.indexOf('BEGIN'));
    expect(lock).toBeLessThan(firstRead);
    expect(db.calls[lock].values).toEqual([JSON.stringify(['funding', 't1', 'org_1'])]);
    const totals = sql.findIndex((item) => item.includes('AS settled_monthly'));
    const insert = sql.findIndex((item) => item.startsWith('INSERT INTO control_plane.funding_reservations'));
    expect(lock).toBeLessThan(totals);
    expect(totals).toBeLessThan(insert);
    expect(sql.filter((item) => item === 'COMMIT')).toHaveLength(1);
    // Every value is a bound parameter; no amount is spliced into SQL text.
    expect(sql.some((item) => item.includes(String(creditAmount(5))))).toBe(false);
  });

  it('never replays a reservation after an uncertain COMMIT', async () => {
    const db = recording({ failCommit: true });
    const service = new FundingService(new PostgresFundingRepository(db.factory), { now, approvedDefaultJobCapMicroUsd: creditAmount(20) });
    await expect(service.reserve(reserveInput)).rejects.toThrow('connection lost during commit');
    const sql = db.calls.map((call) => call.sql);
    expect(sql.filter((item) => item === 'BEGIN')).toHaveLength(1);
    expect(sql.filter((item) => item === 'COMMIT')).toHaveLength(1);
    expect(sql.filter((item) => item.startsWith('INSERT INTO control_plane.funding_reservations'))).toHaveLength(1);
  });

  it('refuses stored money outside the safe integer range rather than rounding it', async () => {
    const db = recording({ money: '9007199254740993' });
    const service = new FundingService(new PostgresFundingRepository(db.factory), { now, approvedDefaultJobCapMicroUsd: creditAmount(20) });
    await expect(service.reserve(reserveInput)).rejects.toThrow(/safe whole number/);
    expect(db.calls.map((call) => call.sql)).toContain('ROLLBACK');
  });

  it('the projection is a read: it takes no lock and writes nothing', async () => {
    const db = recording();
    const service = new FundingService(new PostgresFundingRepository(db.factory), { now });
    const state = await service.projection('t1', 'org_1');
    expect(state.state).toBe('ready');
    const sql = db.calls.map((call) => call.sql);
    expect(sql.some((item) => item.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(sql.some((item) => /^(INSERT|UPDATE|DELETE)/.test(item.trim()))).toBe(false);
  });
});
