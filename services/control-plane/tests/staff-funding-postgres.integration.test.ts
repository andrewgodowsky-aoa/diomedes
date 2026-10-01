import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configuration } from '../src/config.js';
import { CommercialService, type AuditEvent } from '../src/commercial.js';
import { PostgresCommercialRepository } from '../src/commercial-postgres.js';
import { FundingService } from '../src/funding.js';
import { PostgresFundingRepository } from '../src/funding-postgres.js';
import { PostgresStaffFundingRepository } from '../src/staff-funding-postgres.js';
import { migrate } from '../src/migrations.js';
import type { ClientFactory, SqlClient } from '../src/postgres.js';
import { creditAmount, periodIdFor } from '../../../shared/managed-usage.js';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../src/faux/seed.js';
import { validEnv } from './support/fixtures.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const staffUrl = validEnv.DATABASE_URL.replace('cp_runtime:', 'cp_staff_funding:');

describe('DIO-132 staff writer configuration and SQL protocol (scripted, no database)', () => {
  it('accepts only the separate reviewed staff login on the runtime database', () => {
    expect(configuration({ ...validEnv, STAFF_FUNDING_DATABASE_URL: staffUrl }).staffFundingDatabaseUrl).toBe(staffUrl);
    for (const invalid of [validEnv.DATABASE_URL, staffUrl.replace('cp_staff_funding:', 'cp_funding:'), staffUrl.replace('ep-fixture.', 'ep-other.')]) {
      expect(configuration({ ...validEnv, STAFF_FUNDING_DATABASE_URL: invalid }).staffFundingDatabaseUrl).toBeNull();
    }
    expect(configuration(validEnv).staffFundingDatabaseUrl).toBeNull();
  });
  it('grants the exact six-table staff footprint, with no UPDATE or unused writes', () => {
    const sql = read('../scripts/staff-funding-permissions.sql').split('\n').map(line => line.replace(/--.*$/, '')).join(' ');
    const footprint: Record<string, string[]> = {};
    for (const match of sql.matchAll(/GRANT\s+(SELECT(?:, INSERT)?)\s+ON\s+([\s\S]*?)\s+TO cp_staff_funding;/g))
      for (const table of match[2].split(',')) footprint[table.trim()] = match[1].split(', ');
    expect(footprint).toEqual({
      'control_plane.operators': ['SELECT'], 'control_plane.organizations': ['SELECT'], 'control_plane.feature_grants': ['SELECT'],
      'control_plane.credit_periods': ['SELECT', 'INSERT'], 'control_plane.credit_adjustments': ['SELECT', 'INSERT'], 'control_plane.ops_audit': ['SELECT', 'INSERT'],
    });
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|CREATE|ALL PRIVILEGES)\b/);
  });
  for (const failAudit of [false, true]) it(failAudit ? 'rolls the shared SQL transaction back on audit failure' : 'sends correction and audit on one client and one commit', async () => {
    const log: { client: number; sql: string }[] = [];
    let clients = 0;
    const factory: ClientFactory = () => {
      const client = ++clients;
      return { async connect() {}, async end() {}, async query(sql) {
        log.push({ client, sql });
        if (failAudit && sql.startsWith('INSERT INTO control_plane.ops_audit')) throw new Error('audit failed');
        const rows = sql.startsWith('SELECT * FROM control_plane.credit_periods') ? [{ tenant_id: 'tenant', organization_id: 'org', period_id: '2026-09', plan_id: 'business', rate_card_version: 'nectovia-rate-card/1', granted_micro_usd: creditAmount(1000), starts_at: '2026-09-01T00:00:00Z', ends_at: '2026-10-01T00:00:00Z', source_grant_id: 'grant', allocated_at: '2026-09-01T00:00:00Z' }] : [];
        return { rows, rowCount: rows.length };
      } };
    };
    const repo = new PostgresStaffFundingRepository(factory);
    const write = repo.transaction(async tx => {
      const funding = new FundingService({ transaction: action => action(tx.funding) });
      const row = await funding.recordCorrection({ tenantId: 'tenant', organizationId: 'org', adjustmentId: 'adjustment', periodId: '2026-09', direction: 'grant', amountMicroUsd: creditAmount(10), attemptRef: null, note: 'Ticket' });
      await tx.audit({ id: 'audit', at: row.at, actorPersonId: 'staff', actorRole: 'billing', action: 'funding.added', organizationId: 'org', targetKind: 'funding', targetId: row.id, reason: row.note, detail: {} });
    });
    if (failAudit) await expect(write).rejects.toThrow('audit failed'); else await write;
    expect(clients).toBe(1);
    expect(log.filter(row => row.sql === 'BEGIN')).toHaveLength(1);
    expect(log.filter(row => row.sql === 'COMMIT')).toHaveLength(failAudit ? 0 : 1);
    expect(log.filter(row => row.sql === 'ROLLBACK')).toHaveLength(failAudit ? 1 : 0);
    expect(log.filter(row => /^INSERT INTO control_plane.(credit_adjustments|ops_audit)/.test(row.sql))).toHaveLength(2);
  });
});

// Explicit local-only opt-in. These cases never use Neon, a saved secret, or a shared role.
const url = process.env.DIO132_TEST_DATABASE_URL;
const roles = { runtime: `cp_runtime_dio132_${process.pid}`, gateway: `cp_funding_dio132_${process.pid}`, staff: `cp_staff_funding_dio132_${process.pid}` };
const password = 'dio132_disposable_fixture_only';
const at = Date.parse('2026-09-25T12:00:00Z');
let ownerFactory: ClientFactory;
let runtimeFactory: ClientFactory;
let staffFactory: ClientFactory;
let gatewayFactory: ClientFactory;
let cloud: FauxCloud;
let organizationId: string;
let harborId: string;
let billing: string;
let service: CommercialService;
let initialized = false;
const correction = { requestId: 'pg-correction', credits: 10, reason: 'Fixture ticket 132' };
async function query(factory: ClientFactory, sql: string, values?: unknown[]) {
  const client = factory(); await client.connect();
  try { return await client.query(sql, values); } finally { await client.end(); }
}
const counts = async () => (await query(ownerFactory, `SELECT
  (SELECT count(*)::int FROM control_plane.credit_adjustments WHERE organization_id=$1) AS credits,
  (SELECT count(*)::int FROM control_plane.ops_audit WHERE organization_id=$1 AND record->>'action'='funding.added') AS audits`, [organizationId])).rows[0];
const withFault = (factory: ClientFactory, fault: (sql: string, values: unknown[]) => 'audit' | 'commit' | null): ClientFactory => () => {
  const client = factory();
  return { connect: () => client.connect(), end: () => client.end(), on: (event, listener) => client.on?.(event, listener), async query(sql, values = []) {
    const fail = fault(sql, values);
    if (fail === 'audit') return client.query('SELECT 1/0');
    const result = await client.query(sql, values);
    if (fail === 'commit') throw new Error('Lost commit response');
    return result;
  } };
};

describe.skipIf(!url)('REAL local disposable PostgreSQL: staff correction restricted roles', () => {
  beforeAll(async () => {
    const database = new URL(url!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) || !/^\/dio132_validation_[a-z0-9_]+$/.test(database.pathname) ||
        process.env.DIO132_TEST_ALLOW_RESET !== 'yes') throw new Error('Use an explicitly disposable local dio132_validation_* database; shared and remote targets are prohibited.');
    ownerFactory = () => new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    // Test role names are unique to this process. Refuse existing roles instead of changing them.
    for (const role of Object.values(roles)) {
      if ((await query(ownerFactory, 'SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rows.length) throw new Error('Test role already exists; use a fresh disposable cluster.');
    }
    await query(ownerFactory, 'DROP SCHEMA IF EXISTS control_plane CASCADE');
    const names = ['001_accounts.sql','002_commercial.sql','003_funded_jobs.sql','004_usage_contract.sql','005_customer_access.sql','006_staff_keys.sql','007_relay_devices.sql','008_organization_setup.sql','009_individual_plans.sql','010-scoped-routing.sql'];
    await migrate(ownerFactory, names.map((name, index) => { const sql = read('../migrations/' + name); return { version: index + 1, name, sql, sha256: createHash('sha256').update(sql).digest('hex') }; }));
    for (const role of Object.values(roles)) await query(ownerFactory, `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`);
    for (const [name, file] of [['runtime', 'runtime-permissions.sql'], ['gateway', 'funding-permissions.sql'], ['staff', 'staff-funding-permissions.sql']] as const) {
      const role = roles[name], original = name === 'runtime' ? 'cp_runtime' : name === 'gateway' ? 'cp_funding' : 'cp_staff_funding';
      await query(ownerFactory, read('../scripts/' + file).replace(new RegExp('\\b' + original + '\\b', 'g'), role));
    }
    const login = (name: keyof typeof roles): ClientFactory => {
      const target = new URL(url!); target.username = roles[name]; target.password = password;
      return () => new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis: 5000 });
    };
    runtimeFactory = login('runtime'); staffFactory = login('staff'); gatewayFactory = login('gateway'); initialized = true;
  });
  beforeEach(async () => {
    cloud = await createFauxCloud({ file: null, now: () => at, passwordIterations: 1000 });
    const seeded = (await seedDemo(cloud)).organizations!;
    organizationId = seeded.juniper; harborId = seeded.harbor;
    const response = await cloud.handle(new Request('http://faux/auth/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: DEMO_ACCOUNTS.staffBilling.email, password: FAUX_DEMO_PASSWORD }) }));
    billing = (await response.json()).accessToken;
    const state = cloud.store.snapshot();
    for (const person of state.accounts.persons) await query(ownerFactory, 'INSERT INTO control_plane.persons(id,record) VALUES($1,$2::jsonb)', [person.id, JSON.stringify(person)]);
    for (const row of state.accounts.organizations) { const org = row.record; await query(ownerFactory, 'INSERT INTO control_plane.organizations(id,tenant_id,created_by,record,generation) VALUES($1,$2,$3,$4::jsonb,$5)', [org.id, org.tenantId, org.createdBy, JSON.stringify(org), row.generation]); }
    const commercial = new PostgresCommercialRepository(ownerFactory);
    await commercial.transaction(async tx => { for (const operator of state.commercial.operators) await tx.saveOperator(operator); for (const grant of state.commercial.grants) await tx.saveGrant(grant); });
    const grant = state.commercial.grants.find(row => row.organizationId === organizationId)!;
    await new FundingService(new PostgresFundingRepository(staffFactory), { now: () => at }).allocatePeriod({ tenantId: grant.tenantId, organizationId, planId: grant.planId!, sourceGrantId: grant.id, periodId: periodIdFor(new Date(at).toISOString()) });
    service = new CommercialService(cloud.accounts, new PostgresCommercialRepository(runtimeFactory), null, { now: () => at, staffFunding: new PostgresStaffFundingRepository(staffFactory) });
  });
  afterAll(async () => {
    if (!initialized) return;
    await query(ownerFactory, 'DROP SCHEMA control_plane CASCADE');
    for (const role of Object.values(roles)) { await query(ownerFactory, `DROP OWNED BY ${role}`); await query(ownerFactory, `DROP ROLE ${role}`); }
  });
  it('keeps runtime/gateway credit writes and unused staff powers refused by PostgreSQL', async () => {
    for (const factory of [runtimeFactory, gatewayFactory]) {
      await expect(query(factory, 'INSERT INTO control_plane.credit_adjustments SELECT * FROM control_plane.credit_adjustments WHERE FALSE')).rejects.toMatchObject({ code: '42501' });
      await expect(query(factory, 'INSERT INTO control_plane.credit_topups SELECT * FROM control_plane.credit_topups WHERE FALSE')).rejects.toMatchObject({ code: '42501' });
    }
    for (const sql of ['UPDATE control_plane.ops_audit SET at=at', 'INSERT INTO control_plane.feature_grants SELECT * FROM control_plane.feature_grants WHERE FALSE', 'SELECT * FROM control_plane.sessions', 'INSERT INTO control_plane.credit_topups SELECT * FROM control_plane.credit_topups WHERE FALSE'])
      await expect(query(staffFactory, sql)).rejects.toMatchObject({ code: '42501' });
  });
  it('credits and audits once through actual restricted logins under concurrent replay', async () => {
    const rows = await Promise.all(Array.from({ length: 4 }, () => service.addFunding(billing, organizationId, correction)));
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    expect(await counts()).toEqual({ credits: 1, audits: 1 });
    await expect(service.addFunding(billing, organizationId, { ...correction, credits: 11 })).rejects.toMatchObject({ status: 409 });
    expect(await counts()).toEqual({ credits: 1, audits: 1 });
  });
  it('rolls back the real credit insert when the audit fails', async () => {
    const factory = withFault(staffFactory, sql => sql.startsWith('INSERT INTO control_plane.ops_audit') ? 'audit' : null);
    const broken = new CommercialService(cloud.accounts, new PostgresCommercialRepository(runtimeFactory), null, { now: () => at, staffFunding: new PostgresStaffFundingRepository(factory) });
    await expect(broken.addFunding(billing, organizationId, correction)).rejects.toMatchObject({ code: '22012' });
    expect(await counts()).toEqual({ credits: 0, audits: 0 });
  });
  it('survives a lost PostgreSQL commit acknowledgement', async () => {
    let lose = true;
    const factory = withFault(staffFactory, sql => { if (lose && sql === 'COMMIT') { lose = false; return 'commit'; } return null; });
    const uncertain = new CommercialService(cloud.accounts, new PostgresCommercialRepository(runtimeFactory), null, { now: () => at, staffFunding: new PostgresStaffFundingRepository(factory) });
    await expect(uncertain.addFunding(billing, organizationId, correction)).rejects.toThrow('Lost commit response');
    await uncertain.addFunding(billing, organizationId, correction);
    expect(await counts()).toEqual({ credits: 1, audits: 1 });
  });
  it('keeps grant-allocation credit and audit atomic on restricted logins', async () => {
    const factory = withFault(staffFactory, sql => sql.startsWith('INSERT INTO control_plane.ops_audit') ? 'audit' : null);
    const broken = new CommercialService(cloud.accounts, new PostgresCommercialRepository(runtimeFactory), null, { now: () => at, staffFunding: new PostgresStaffFundingRepository(factory) });
    const result = await broken.issueGrant(billing, harborId, { planId: 'business', source: 'subscription', reference: 'Fixture invoice', note: 'Test allocation' });
    expect(result.funding.allocated).toBe(false);
    expect((await query(ownerFactory, 'SELECT count(*)::int AS n FROM control_plane.credit_periods WHERE organization_id=$1', [harborId])).rows[0].n).toBe(0);
    expect((await query(ownerFactory, "SELECT count(*)::int AS n FROM control_plane.ops_audit WHERE organization_id=$1 AND record->>'action'='funding.allocated'", [harborId])).rows[0].n).toBe(0);
  });
});
