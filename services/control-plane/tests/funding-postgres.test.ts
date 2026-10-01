/**
 * The funding SQL adapter against a recording client. Protocol only: this does
 * not parse SQL or prove PostgreSQL locking. It checks that the organization
 * lock is taken before any aggregate is read, that a failed COMMIT is never
 * replayed, and that stored money outside the safe range is refused.
 */
import { describe, expect, it } from 'vitest';
import { creditAmount, micro } from '../../../shared/managed-usage.js';
import { FundingService, PURCHASED_HOLD_LEASE_MINUTES, type TopUpHoldRow } from '../src/funding.js';
import { PostgresFundingRepository } from '../src/funding-postgres.js';
import type { SqlClient } from '../src/postgres.js';
import { FundingMemoryRepository } from './support/funding-memory.js';

const at = '2026-09-10T12:00:00.000Z';
const now = () => Date.parse(at);

function recording(options: { failCommit?: boolean; money?: string; companySpend?: string; attempt?: Record<string, unknown>; dispatchRows?: number | null } = {}) {
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
      if (sql.includes('AS company_spend')) return { rows: [{ company_spend: options.companySpend ?? '0' }], rowCount: 1 };
      if (options.attempt && sql.includes('FROM control_plane.funding_reservations WHERE tenant_id=$1 AND reservation_id=$2')) return { rows: [options.attempt], rowCount: 1 };
      if (sql.startsWith('UPDATE control_plane.funding_reservations SET dispatched_at')) return { rows: [], rowCount: options.dispatchRows === undefined ? 1 : options.dispatchRows };
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  return { factory: () => client, calls };
}

const reserveInput = {
  tenantId: 't1', organizationId: 'org_1', attemptId: 'attempt_1', rootJobId: 'job_1', parentAttemptId: null,
  kind: 'generation' as const, route: 'aws-bedrock', requestDigest: 'digest_1', usageClass: 'metered-work' as const,
  rateSnapshot: { version: 'r1', inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1, cacheReadMicroUsdPerMillion: 1, cacheWriteMicroUsdPerMillion: 1 },
  maxMicroUsd: creditAmount(5),
};

describe('funding SQL adapter protocol', () => {
  it('takes the organization lock before reading any balance, then inserts once and commits', async () => {
    const db = recording();
    const service = new FundingService(new PostgresFundingRepository(db.factory), { now });
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
    const service = new FundingService(new PostgresFundingRepository(db.factory), { now });
    await expect(service.reserve(reserveInput)).rejects.toThrow('connection lost during commit');
    const sql = db.calls.map((call) => call.sql);
    expect(sql.filter((item) => item === 'BEGIN')).toHaveLength(1);
    expect(sql.filter((item) => item === 'COMMIT')).toHaveLength(1);
    expect(sql.filter((item) => item.startsWith('INSERT INTO control_plane.funding_reservations'))).toHaveLength(1);
  });

  it('refuses stored money outside the safe integer range rather than rounding it', async () => {
    const db = recording({ money: '9007199254740993' });
    const service = new FundingService(new PostgresFundingRepository(db.factory), { now });
    await expect(service.reserve(reserveInput)).rejects.toThrow(/safe whole number/);
    expect(db.calls.map((call) => call.sql)).toContain('ROLLBACK');
  });

  it('checks the company ceiling inside the reserving transaction: company lock, then the total, then the insert', async () => {
    const db = recording({ companySpend: '100' });
    const service = new FundingService(new PostgresFundingRepository(db.factory), { now });
    await service.reserve({ ...reserveInput, companyCeilingMicroUsd: micro(100 + creditAmount(5)) });
    const sql = db.calls.map((call) => call.sql);
    const organizationLock = db.calls.findIndex((call) => call.sql.includes('pg_advisory_xact_lock') && call.values[0] === JSON.stringify(['funding', 't1', 'org_1']));
    const companyLock = db.calls.findIndex((call) => call.sql.includes('pg_advisory_xact_lock') && call.values[0] === JSON.stringify(['funding-company']));
    const total = sql.findIndex((item) => item.includes('AS company_spend'));
    const insert = sql.findIndex((item) => item.startsWith('INSERT INTO control_plane.funding_reservations'));
    expect(sql.filter((item) => item === 'BEGIN')).toHaveLength(1);
    expect(sql.indexOf('BEGIN')).toBeLessThan(organizationLock);
    expect(organizationLock).toBeLessThan(companyLock);
    expect(companyLock).toBeLessThan(total);
    expect(total).toBeLessThan(insert);
    expect(insert).toBeLessThan(sql.indexOf('COMMIT'));
    // Every tenant and organization counts: the total binds no tenant, organization or amount.
    expect(db.calls[total].values).toEqual([]);
    expect(sql[total]).not.toMatch(/tenant_id|organization_id/);
  });

  it('refuses past the company ceiling with no insert, and rolls back', async () => {
    const db = recording({ companySpend: '101' });
    const service = new FundingService(new PostgresFundingRepository(db.factory), { now });
    await expect(service.reserve({ ...reserveInput, companyCeilingMicroUsd: micro(100 + creditAmount(5)) })).rejects.toMatchObject({ code: 'company_ceiling' });
    const sql = db.calls.map((call) => call.sql);
    expect(sql.some((item) => item.startsWith('INSERT INTO control_plane.funding_reservations'))).toBe(false);
    expect(sql).toContain('ROLLBACK');
  });

  it('takes no company lock and reads no company total when no ceiling is set', async () => {
    const db = recording();
    await new FundingService(new PostgresFundingRepository(db.factory), { now }).reserve(reserveInput);
    expect(db.calls.some((call) => call.values[0] === JSON.stringify(['funding-company']))).toBe(false);
    expect(db.calls.some((call) => call.sql.includes('AS company_spend'))).toBe(false);
  });

  const pendingRow = {
    tenant_id: 't1', reservation_id: 'attempt_1', organization_id: 'org_1', root_job_id: 'job_1', existing_parent_task_ref: null, period_id: '2026-09',
    kind: 'generation', route: 'aws-bedrock', request_digest: 'digest_1', rate_snapshot: reserveInput.rateSnapshot, usage_class: 'metered-work',
    rate_card_version: 'rate-card-2026-09-10.1', reserved_micro_usd: String(creditAmount(5)), monthly_hold_micro_usd: String(creditAmount(5)),
    topup_hold_micro_usd: '0', state: 'pending', created_at: new Date(at), dispatched_at: null, resolved_at: null, uncertain_reason: null,
  };

  it('dispatches with one conditional update, and sends only when exactly one row moved', async () => {
    const db = recording({ attempt: pendingRow });
    const sent = await new FundingService(new PostgresFundingRepository(db.factory), { now }).markDispatched({ tenantId: 't1', organizationId: 'org_1', attemptId: 'attempt_1' });
    expect(sent.dispatchedAt).toBe(at);
    const update = db.calls.find((call) => call.sql.startsWith('UPDATE control_plane.funding_reservations SET dispatched_at'))!;
    expect(update.sql).toContain("state='pending' AND dispatched_at IS NULL");
    expect(update.values).toEqual(['t1', 'attempt_1', at]);
    // The claim is the only write: no upsert that could overwrite another caller's dispatch.
    expect(db.calls.some((call) => call.sql.startsWith('INSERT INTO control_plane.funding_reservations'))).toBe(false);
    for (const rows of [0, 2, null]) {
      const lost = recording({ attempt: pendingRow, dispatchRows: rows });
      await expect(new FundingService(new PostgresFundingRepository(lost.factory), { now }).markDispatched({ tenantId: 't1', organizationId: 'org_1', attemptId: 'attempt_1' }))
        .rejects.toMatchObject({ code: 'attempt_in_flight' });
      expect(lost.calls.map((call) => call.sql)).toContain('ROLLBACK');
    }
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

describe('purchased-usage holds on the SQL adapter', () => {
  const amount = creditAmount(40);
  function holds(options: { purchased?: string; hold?: Record<string, unknown> } = {}) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const client: SqlClient = {
      async connect() {},
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.includes('AS purchased')) return { rows: [{ purchased: options.purchased ?? String(creditAmount(100)), held: '0', settled: '0' }], rowCount: 1 };
        if (sql.includes('FROM control_plane.credit_topup_holds WHERE tenant_id=$1 AND hold_id=$2'))
          return { rows: options.hold ? [options.hold] : [], rowCount: options.hold ? 1 : 0 };
        return { rows: [], rowCount: 0 };
      },
      async end() {},
    };
    return { factory: () => client, calls };
  }
  const leaseUntil = new Date(Date.parse(at) + PURCHASED_HOLD_LEASE_MINUTES * 60_000).toISOString();
  const input = { tenantId: 't1', organizationId: 'org_1', holdId: 'hold_1', personId: 'person_1', amountMicroUsd: amount, requestDigest: 'digest_1' };
  const stored = { tenant_id: 't1', organization_id: 'org_1', hold_id: 'hold_1', person_id: 'person_1', request_digest: 'digest_1',
    amount_micro_usd: String(amount), debit_micro_usd: '0', state: 'held', created_at: new Date(at), resolved_at: null,
    lease_until: new Date(leaseUntil), released_by: null };

  it('takes the organization lock, reads the balance, and inserts one bound row; it reads no month, job or period', async () => {
    const db = holds();
    const { hold } = await new FundingService(new PostgresFundingRepository(db.factory), { now }).holdPurchased(input);
    expect(hold.state).toBe('held');
    const sql = db.calls.map((call) => call.sql);
    const lock = sql.findIndex((item) => item.includes('pg_advisory_xact_lock'));
    const balance = sql.findIndex((item) => item.includes('AS purchased'));
    const insert = sql.findIndex((item) => item.startsWith('INSERT INTO control_plane.credit_topup_holds'));
    expect(lock).toBeGreaterThan(sql.indexOf('BEGIN'));
    expect(lock).toBeLessThan(balance);
    expect(balance).toBeLessThan(insert);
    expect(db.calls[insert].values).toEqual(['t1', 'hold_1', 'org_1', 'person_1', 'digest_1', amount, 0, 'held', at, null, leaseUntil, null]);
    expect(sql.some((item) => /credit_periods|funded_jobs|funding_reservations\b.*monthly|AS settled_monthly/.test(item) && !item.includes('AS purchased'))).toBe(false);
    expect(sql.some((item) => item.includes(String(amount)))).toBe(false);
    expect(sql.filter((item) => item === 'COMMIT')).toHaveLength(1);
  });

  it('counts open holds and settled debits in the same balance every reserve reads', async () => {
    const db = holds();
    await new FundingService(new PostgresFundingRepository(db.factory), { now }).purchasedBalance('t1', 'org_1');
    const totals = db.calls.find((call) => call.sql.includes('AS purchased'))!.sql;
    expect(totals).toMatch(/credit_topup_holds[^)]*state='held' AND lease_until > \$3\) AS held/);
    expect(totals).toMatch(/credit_topup_holds[^)]*state='settled'\) AS settled/);
  });

  it('settles by moving only the debit, state and resolution time of the row it locked', async () => {
    const db = holds({ hold: stored });
    const { hold } = await new FundingService(new PostgresFundingRepository(db.factory), { now }).settlePurchased({ ...input, debitMicroUsd: creditAmount(25) });
    expect(hold).toMatchObject({ state: 'settled', debitMicroUsd: creditAmount(25) });
    const write = db.calls.find((call) => call.sql.startsWith('INSERT INTO control_plane.credit_topup_holds'))!;
    expect(write.sql).toMatch(/DO UPDATE SET debit_micro_usd=EXCLUDED\.debit_micro_usd,state=EXCLUDED\.state,resolved_at=EXCLUDED\.resolved_at,lease_until=EXCLUDED\.lease_until,released_by=EXCLUDED\.released_by$/);
    expect(db.calls.some((call) => call.sql.includes('FOR UPDATE') && call.sql.includes('credit_topup_holds'))).toBe(true);
  });

  it('refuses another person’s stored hold as unknown and writes nothing', async () => {
    const db = holds({ hold: { ...stored, person_id: 'person_2' } });
    await expect(new FundingService(new PostgresFundingRepository(db.factory), { now }).releasePurchased(input)).rejects.toMatchObject({ status: 404, code: 'unknown_hold' });
    expect(db.calls.some((call) => call.sql.startsWith('INSERT'))).toBe(false);
  });
});

describe('the lease on the SQL adapter', () => {
  const amount = creditAmount(40);
  const leaseUntil = new Date(Date.parse(at) + PURCHASED_HOLD_LEASE_MINUTES * 60_000).toISOString();
  const stored = { tenant_id: 't1', organization_id: 'org_1', hold_id: 'hold_1', person_id: 'person_1', request_digest: 'digest_1',
    amount_micro_usd: String(amount), debit_micro_usd: '0', state: 'held', created_at: new Date(at), resolved_at: null,
    lease_until: new Date(leaseUntil), released_by: null };
  const input = { tenantId: 't1', organizationId: 'org_1', holdId: 'hold_1', personId: 'person_1' };

  function db(hold: Record<string, unknown> | null = stored) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const client: SqlClient = {
      async connect() {},
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.includes('AS purchased')) return { rows: [{ purchased: String(creditAmount(100)), held: '0', settled: '0' }], rowCount: 1 };
        if (sql.includes('FROM control_plane.credit_topup_holds WHERE tenant_id=$1 AND hold_id=$2'))
          return { rows: hold ? [hold] : [], rowCount: hold ? 1 : 0 };
        return { rows: [], rowCount: 1 };
      },
      async end() {},
    };
    return { factory: () => client, calls, sql: () => calls.map((call) => call.sql) };
  }
  const sweepSql = (item: string) => item.startsWith('UPDATE control_plane.credit_topup_holds') && item.includes("released_by='expiry'");
  const service = (fake: ReturnType<typeof db>) => new FundingService(new PostgresFundingRepository(fake.factory), { now });

  it('lets go of every lapsed hold under the lock, before it reads any balance, with the service clock', async () => {
    for (const run of [
      (fake: ReturnType<typeof db>) => service(fake).purchasedBalance('t1', 'org_1'),
      (fake: ReturnType<typeof db>) => service(fake).holdPurchased({ ...input, amountMicroUsd: amount, requestDigest: 'digest_1' }),
      (fake: ReturnType<typeof db>) => service(fake).settlePurchased({ ...input, debitMicroUsd: creditAmount(5) }),
      (fake: ReturnType<typeof db>) => service(fake).releasePurchased(input),
      (fake: ReturnType<typeof db>) => service(fake).renewPurchased(input),
    ]) {
      const fake = db();
      await run(fake);
      const sql = fake.sql();
      const lock = sql.findIndex((item) => item.includes('pg_advisory_xact_lock'));
      const sweep = sql.findIndex(sweepSql);
      const firstRead = sql.findIndex((item) => /credit_topup/.test(item) && !item.startsWith('UPDATE'));
      expect(lock).toBeGreaterThan(-1);
      expect(sweep).toBeGreaterThan(lock);
      expect(sweep).toBeLessThan(firstRead);
      expect(fake.calls[sweep].sql).toMatch(/SET state='released',released_by='expiry',resolved_at=\$3 WHERE tenant_id=\$1 AND organization_id=\$2 AND state='held' AND lease_until <= \$3$/);
      expect(fake.calls[sweep].values).toEqual(['t1', 'org_1', at]);
    }
  });

  it('counts a held row as held only while its lease has not lapsed, at the same instant the sweep uses', async () => {
    const fake = db();
    await service(fake).purchasedBalance('t1', 'org_1');
    const totals = fake.calls.find((call) => call.sql.includes('AS purchased'))!;
    expect(totals.values).toEqual(['t1', 'org_1', at]);
    expect(totals.sql).toMatch(/credit_topup_holds WHERE tenant_id=\$1 AND organization_id=\$2 AND state='held' AND lease_until > \$3\) AS held/);
    // The lapsed side of the same boundary is the sweep's: lease_until <= $3, so no instant is in neither.
    expect(fake.calls.find((call) => sweepSql(call.sql))!.sql).toMatch(/lease_until <= \$3$/);
  });

  it('renews by moving only the lease on the row it locked, and only a held, unlapsed one', async () => {
    const fake = db();
    const { hold } = await service(fake).renewPurchased(input);
    expect(hold.leaseUntil).toBe(leaseUntil);
    const write = fake.calls.find((call) => call.sql.startsWith('INSERT INTO control_plane.credit_topup_holds'))!;
    expect(write.sql).toMatch(/lease_until=EXCLUDED\.lease_until/);
    expect(fake.calls.some((call) => call.sql.includes('FOR UPDATE') && call.sql.includes('credit_topup_holds'))).toBe(true);
    const stale = db({ ...stored, state: 'released', released_by: 'person', resolved_at: new Date(at) });
    await expect(service(stale).renewPurchased(input)).rejects.toMatchObject({ status: 409, code: 'hold_not_held' });
    expect(stale.calls.some((call) => call.sql.startsWith('INSERT'))).toBe(false);
  });

  it('records a late settle by writing the row back to settled with no releaser', async () => {
    const fake = db({ ...stored, state: 'released', released_by: 'expiry', resolved_at: new Date(at) });
    const { hold } = await service(fake).settlePurchased({ ...input, debitMicroUsd: creditAmount(25) });
    expect(hold).toMatchObject({ state: 'settled', debitMicroUsd: creditAmount(25), releasedBy: null });
    const write = fake.calls.find((call) => call.sql.startsWith('INSERT INTO control_plane.credit_topup_holds'))!;
    expect(write.values).toEqual(['t1', 'hold_1', 'org_1', 'person_1', 'digest_1', amount, creditAmount(25), 'settled', at, at, leaseUntil, null]);
  });

  it('keeps who released a hold: a person’s release is written as person', async () => {
    const fake = db();
    const { hold } = await service(fake).releasePurchased(input);
    expect(hold).toMatchObject({ state: 'released', releasedBy: 'person' });
    const write = fake.calls.find((call) => call.sql.startsWith('INSERT INTO control_plane.credit_topup_holds'))!;
    expect(write.values.slice(7)).toEqual(['released', at, at, leaseUntil, 'person']);
  });

  it('reads a stored hold with a lease, and refuses one whose releaser is not a known value', async () => {
    const fake = db({ ...stored, state: 'released', released_by: 'robot', resolved_at: new Date(at) });
    await expect(service(fake).renewPurchased(input)).rejects.toThrow(/releaser/i);
  });
});

describe('topUpTotals: the SQL adapter and the faux backend agree on a lapsed row', () => {
  const t = 't1';
  const o = 'org_1';
  const hold = (holdId: string, state: 'held' | 'settled' | 'released', leaseMinutes: number, extra: Record<string, unknown> = {}) => ({
    tenantId: t, organizationId: o, holdId, personId: 'person_1', requestDigest: `digest_${holdId}`, amountMicroUsd: creditAmount(10),
    debitMicroUsd: micro(0), state, createdAt: at, resolvedAt: state === 'held' ? null : at,
    leaseUntil: new Date(Date.parse(at) + leaseMinutes * 60_000).toISOString(), releasedBy: state === 'released' ? 'person' : null, ...extra,
  }) as TopUpHoldRow;

  async function fauxTotals(when: string) {
    const repository = new FundingMemoryRepository();
    await repository.transaction(async (tx) => {
      await tx.saveTopUp({ tenantId: t, organizationId: o, topUpId: 'topup_1', amountMicroUsd: creditAmount(100), provider: 'stripe', sourceEventId: 'evt_1', recordedAt: at });
      await tx.saveTopUpHold(hold('live', 'held', 5));
      await tx.saveTopUpHold(hold('boundary', 'held', 0));
      await tx.saveTopUpHold(hold('lapsed', 'held', -30));
      await tx.saveTopUpHold(hold('settled', 'settled', -30, { debitMicroUsd: creditAmount(4) }));
      await tx.saveTopUpHold(hold('released', 'released', 30));
    });
    return repository.transaction((tx) => tx.topUpTotals(t, o, when));
  }

  it('the faux backend counts only the hold whose lease runs past now, at the boundary and after', async () => {
    expect(await fauxTotals(at)).toEqual({ purchasedMicroUsd: creditAmount(100), heldMicroUsd: creditAmount(10), settledMicroUsd: creditAmount(4) });
    // A moment later the live hold has lapsed too, and nothing swept it.
    const later = new Date(Date.parse(at) + 5 * 60_000).toISOString();
    expect(await fauxTotals(later)).toEqual({ purchasedMicroUsd: creditAmount(100), heldMicroUsd: 0, settledMicroUsd: creditAmount(4) });
  });

  it('the SQL asks the same question of the same instant, and the settled debit is not conditioned on the lease', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const client: SqlClient = {
      async connect() {},
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.includes('AS purchased')) return { rows: [{ purchased: String(creditAmount(100)), held: String(creditAmount(10)), settled: String(creditAmount(4)) }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      async end() {},
    };
    const totals = await new PostgresFundingRepository(() => client).transaction((tx) => tx.topUpTotals(t, o, at));
    expect(totals).toEqual(await fauxTotals(at));
    const sql = calls.find((call) => call.sql.includes('AS purchased'))!;
    expect(sql.values).toEqual([t, o, at]);
    expect(sql.sql).toMatch(/credit_topup_holds WHERE tenant_id=\$1 AND organization_id=\$2 AND state='held' AND lease_until > \$3\)\s*AS held/);
    expect(sql.sql).toMatch(/credit_topup_holds WHERE tenant_id=\$1 AND organization_id=\$2 AND state='settled'\) AS settled/);
  });
});
