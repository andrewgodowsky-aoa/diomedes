import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { PostgresRepository, type ClientFactory } from '../src/postgres.js';
import { PostgresCommercialRepository } from '../src/commercial-postgres.js';
import { CommercialService, bootstrapFirstAdmin } from '../src/commercial.js';
import { RoutingService } from '../src/routing.js';
import { FundingService } from '../src/funding.js';
import { PostgresFundingRepository } from '../src/funding-postgres.js';
import { migrate, type Migration } from '../src/migrations.js';
import { micro, RATE_CARD_V1 } from '../../../shared/managed-usage.js';

// Never take a deployment URL or reset an existing schema. This suite owns a new local DB.
const ownerUrl = process.env.CP_INDIVIDUAL_TEST_DATABASE_URL;
const initial = Date.parse('2026-09-29T12:00:00Z');
let clock = initial;
let ownerFactory: ClientFactory, runtimeFactory: ClientFactory, fundingFactory: ClientFactory;
let accounts: AccountService, commercial: CommercialService, funding: FundingService, routing: RoutingService;
let migrations: Migration[], oldGrant: string, oldPerson: string, oldAccount: string;
let oldBusinessPeriod: Record<string, unknown>;
const query = async (factory: ClientFactory, sql: string, values?: unknown[]) => {
  const client = factory(); await client.connect();
  try { return await client.query(sql, values); } finally { await client.end(); }
};
const verifier = { issuer: 'https://fixture.invalid', async verify(token: string) {
  return { issuer: this.issuer, subject: token, sessionId: `session_${token}`, displayName: token, emailVerified: true,
    issuedAt: new Date(clock - 1_000).toISOString(), expiresAt: new Date(clock + 60_000).toISOString(), verifiedAt: new Date(clock).toISOString() };
} };
async function subscriber(name: string, validUntil = '2026-12-01T00:00:00.000Z') {
  const person = (await accounts.signIn(name)).person;
  const { grant } = await commercial.issuePersonGrant('staff', person.id,
    { planId: 'individual', source: 'internal-test', reference: name, note: 'Owned PostgreSQL fixture', validUntil });
  const account = await routing.individual(name);
  return { person, account, grant, allocation: { tenantId: person.id, organizationId: account.id,
    planId: 'individual', sourceGrantId: grant.id, periodId: '2026-09' } };
}

describe.skipIf(!ownerUrl)('Individual funding with real PostgreSQL runtime and funding logins', () => {
  beforeAll(async () => {
    const url = new URL(ownerUrl!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\/b01_validation_individual_funding_[a-z0-9_]+$/.test(url.pathname))
      throw new Error('Use a new, explicitly named disposable local Individual-funding database.');
    ownerFactory = () => new pg.Client({ connectionString: ownerUrl, connectionTimeoutMillis: 5_000 });
    if ((await query(ownerFactory, "SELECT to_regclass('control_plane.schema_migrations') AS existing")).rows[0].existing !== null)
      throw new Error('This test will not reset an existing schema.');
    const names = (await readdir(new URL('../migrations/', import.meta.url))).filter(n => /^\d{3}.*\.sql$/.test(n)).sort();
    migrations = await Promise.all(names.map(async name => {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      return { version: Number(name.slice(0, 3)), name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    }));
    await migrate(ownerFactory, migrations.filter(m => m.version <= 10));
    const ownerAccounts = new AccountService(new PostgresRepository(ownerFactory), verifier, { now: () => clock });
    const ownerCommercial = new PostgresCommercialRepository(ownerFactory);
    const staff = (await ownerAccounts.signIn('staff')).person;
    await bootstrapFirstAdmin(ownerCommercial, staff.id, new Date(clock).toISOString());
    const service = new CommercialService(ownerAccounts, ownerCommercial, null, { now: () => clock });
    oldPerson = (await ownerAccounts.signIn('legacy')).person.id;
    const { grant } = await service.issuePersonGrant('staff', oldPerson, { planId: 'individual', source: 'subscription',
      reference: 'Pre-011 subscription', note: '', features: ['nectovia-agent', 'maintained-profiles', 'owner-rules', 'phone-relay'],
      validUntil: '2026-12-01T00:00:00.000Z' });
    oldGrant = JSON.stringify(grant);
    oldAccount = (await new RoutingService(ownerAccounts, ownerCommercial, () => clock).individual('legacy')).id;
    const business = await ownerAccounts.createOrganization('legacy', 'Pre-011 Business');
    const issued = await service.issueGrant('staff', business.id, { planId: 'business', source: 'internal-test', reference: 'Pre-011 Business', note: '' });
    // Insert exactly the pre-011 row shape, without using the new adapter against the old schema.
    await query(ownerFactory, `INSERT INTO control_plane.credit_periods(tenant_id,organization_id,period_id,plan_id,rate_card_version,
      granted_micro_usd,starts_at,ends_at,source_grant_id,allocated_at) VALUES($1,$2,'2026-09','business',$3,100000000,
      '2026-09-01T00:00:00Z','2026-10-01T00:00:00Z',$4,$5)`, [business.tenantId, business.id, RATE_CARD_V1.version, issued.grant.id, new Date(clock).toISOString()]);
    oldBusinessPeriod = (await query(ownerFactory, 'SELECT to_jsonb(p) AS record FROM control_plane.credit_periods p WHERE organization_id=$1', [business.id])).rows[0].record as Record<string, unknown>;
    await migrate(ownerFactory, migrations);
    const login = async (base: string) => {
      const role = `${base}_${randomBytes(6).toString('hex')}`, password = randomBytes(24).toString('hex');
      await query(ownerFactory, `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      const file = base === 'cp_runtime' ? 'runtime-permissions.sql' : 'funding-permissions.sql';
      await query(ownerFactory, (await readFile(new URL(`../scripts/${file}`, import.meta.url), 'utf8')).replaceAll(base, role));
      const connection = new URL(ownerUrl!); connection.username = role; connection.password = password;
      return () => new pg.Client({ connectionString: connection.toString(), connectionTimeoutMillis: 5_000 });
    };
    runtimeFactory = await login('cp_runtime'); fundingFactory = await login('cp_funding');
    accounts = new AccountService(new PostgresRepository(runtimeFactory), verifier, { now: () => clock });
    funding = new FundingService(new PostgresFundingRepository(fundingFactory), { now: () => clock });
    const repository = new PostgresCommercialRepository(runtimeFactory);
    commercial = new CommercialService(accounts, repository, null, { now: () => clock });
    routing = new RoutingService(accounts, repository, () => clock, funding);
  }, 60_000);
  beforeEach(() => { clock = initial; });

  it('preserves the phase-2a person grant and billing identity and replays migration without allocation', async () => {
    expect(migrations.at(-1)?.version).toBe(11);
    expect(await migrate(ownerFactory, migrations)).toEqual([]);
    const grants = await new PostgresCommercialRepository(runtimeFactory).transaction(tx => tx.personGrants(oldPerson));
    expect(JSON.stringify(grants[0])).toBe(oldGrant);
    expect((await routing.individual('legacy')).id).toBe(oldAccount);
    expect((await query(ownerFactory, 'SELECT to_jsonb(p) - \'source_person_grant_id\' AS record FROM control_plane.credit_periods p')).rows)
      .toEqual([{ record: oldBusinessPeriod }]);
    expect(await routing.access('legacy', { kind: 'individual', id: oldAccount })).toMatchObject({ agent: true, managedInference: true });
  });

  it('uses actual restricted logins and keeps identity, schema, grant and staff-correction writes away from funding', async () => {
    for (const factory of [runtimeFactory, fundingFactory]) {
      expect((await query(factory, 'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
        .toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await query(factory, 'SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows).toEqual([]);
      await expect(query(factory, 'CREATE TABLE control_plane.forbidden_fixture(id text)')).rejects.toMatchObject({ code: '42501' });
    }
    for (const table of ['person_feature_grants', 'billing_scopes', 'account_routing_preferences', 'ops_audit', 'credit_adjustments'])
      expect((await query(fundingFactory, 'SELECT has_table_privilege(current_user,$1,\'INSERT\') AS allowed', [`control_plane.${table}`])).rows[0].allowed).toBe(false);
    const { allocation } = await subscriber('runtime-denied');
    await expect(new FundingService(new PostgresFundingRepository(runtimeFactory), { now: () => clock }).allocatePeriod(allocation)).rejects.toMatchObject({ code: '42501' });
  });

  it('allocates one 1,000-credit period under simultaneous funding connections and binds the person source', async () => {
    const { person, account, grant, allocation } = await subscriber('concurrent');
    const periods = await Promise.all(Array.from({ length: 8 }, () => funding.allocatePeriod(allocation)));
    expect(periods.every(p => p.grantedMicroUsd === 100_000_000 && p.sourceGrantId === grant.id)).toBe(true);
    const rows = (await query(ownerFactory, 'SELECT tenant_id,organization_id,source_grant_id,source_person_grant_id,granted_micro_usd::text FROM control_plane.credit_periods WHERE organization_id=$1', [account.id])).rows;
    expect(rows).toEqual([{ tenant_id: person.id, organization_id: account.id, source_grant_id: null,
      source_person_grant_id: grant.id, granted_micro_usd: '100000000' }]);
  });

  it('retries an unknown COMMIT outcome without crediting the real database twice', async () => {
    const { account, allocation } = await subscriber('lost-commit');
    let lost = false;
    const interruptedFactory: ClientFactory = () => {
      const client = fundingFactory();
      return { connect: () => client.connect(), end: () => client.end(), query: async (sql, values) => {
        const result = await client.query(sql, values);
        if (sql === 'COMMIT' && !lost) { lost = true; throw new Error('Fixture lost the successful COMMIT response'); }
        return result;
      } };
    };
    const interrupted = new FundingService(new PostgresFundingRepository(interruptedFactory), { now: () => clock });
    await expect(interrupted.allocatePeriod(allocation)).rejects.toThrow('lost the successful COMMIT');
    expect((await funding.allocatePeriod(allocation)).grantedMicroUsd).toBe(100_000_000);
    expect((await query(ownerFactory, 'SELECT count(*)::int AS n, sum(granted_micro_usd)::text AS total FROM control_plane.credit_periods WHERE organization_id=$1', [account.id])).rows)
      .toEqual([{ n: 1, total: '100000000' }]);
  });

  it('rejects an altered allowance, backdated month, or widened limited grant instead of manufacturing funding', async () => {
    const { person, account, grant, allocation } = await subscriber('invalid-terms');
    const repository = new PostgresFundingRepository(fundingFactory);
    const row = { ...allocation, rateCardVersion: RATE_CARD_V1.version, grantedMicroUsd: micro(100_000_000),
      startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-10-01T00:00:00.000Z', allocatedAt: new Date(clock).toISOString() };
    await expect(repository.transaction(tx => tx.savePeriod({ ...row, grantedMicroUsd: micro(200_000_000) }))).rejects.toMatchObject({ code: '23514' });
    await expect(repository.transaction(tx => tx.savePeriod({ ...row, periodId: '2026-08' }))).rejects.toMatchObject({ code: '23514' });
    await commercial.revokePersonGrant('staff', person.id, grant.id, { reason: 'Replace with limited access' });
    const limited = await commercial.issuePersonGrant('staff', person.id, { planId: 'individual', source: 'internal-test',
      reference: 'Agent access only', note: '', features: ['nectovia-agent'], validUntil: '2026-12-01T00:00:00.000Z' });
    await expect(funding.allocatePeriod({ ...allocation, sourceGrantId: limited.grant.id })).rejects.toMatchObject({ code: '23514' });
    expect((await query(ownerFactory, 'SELECT count(*)::int AS n FROM control_plane.credit_periods WHERE organization_id=$1', [account.id])).rows[0].n).toBe(0);
  });

  it('refuses cross-person and Business source substitution at the database boundary', async () => {
    const first = await subscriber('source-a'), other = await subscriber('source-b');
    await expect(funding.allocatePeriod({ ...first.allocation, sourceGrantId: other.grant.id })).rejects.toThrow();
    await expect(funding.allocatePeriod({ ...first.allocation, organizationId: other.account.id })).rejects.toThrow();
    const business = await accounts.createOrganization('source-a', 'Owned Business fixture');
    await expect(funding.allocatePeriod({ ...first.allocation, organizationId: business.id, tenantId: business.tenantId })).rejects.toThrow();
    const businessGrant = await commercial.issueGrant('staff', business.id,
      { planId: 'business', source: 'internal-test', reference: 'Business fixture', note: '' });
    await expect(funding.allocatePeriod({ ...first.allocation, planId: 'business', sourceGrantId: businessGrant.grant.id })).rejects.toThrow();
    expect((await query(ownerFactory, 'SELECT count(*)::int AS n FROM control_plane.credit_periods WHERE organization_id=ANY($1::text[])', [[first.account.id, other.account.id, business.id]])).rows[0].n).toBe(0);
  });

  it('refuses revoked or lapsed sources for a new month and preserves their original allocation', async () => {
    const revoked = await subscriber('revoked'), lapsed = await subscriber('lapsed', '2026-10-01T00:00:00.000Z');
    await funding.allocatePeriod(revoked.allocation); await funding.allocatePeriod(lapsed.allocation);
    await commercial.revokePersonGrant('staff', revoked.person.id, revoked.grant.id, { reason: 'Fixture withdrawal' });
    clock = Date.parse('2026-10-01T00:00:00Z');
    for (const source of [revoked, lapsed]) {
      await expect(funding.allocatePeriod({ ...source.allocation, periodId: '2026-10' })).rejects.toThrow();
      expect((await routing.admit(source === revoked ? 'revoked' : 'lapsed', { kind: 'individual', id: source.account.id },
        { surface: 'conversation', routeKind: 'managed' })).decision.admitted).toBe(false);
      expect((await query(ownerFactory, 'SELECT period_id FROM control_plane.credit_periods WHERE organization_id=$1', [source.account.id])).rows).toEqual([{ period_id: '2026-09' }]);
    }
  });

  it('settles dispatched work after revocation and rollover on its original account and rejects a forged settlement period', async () => {
    const { person, account, grant, allocation } = await subscriber('settlement');
    await funding.allocatePeriod(allocation);
    const ref = { tenantId: person.id, organizationId: account.id, attemptId: 'held-personal' };
    await funding.openJob({ ...ref, rootJobId: 'root-personal', runRef: 'root-personal', parentRunRef: null, tier: 'efficient', capMicroUsd: null });
    const reservation = { ...ref, rootJobId: 'root-personal', parentAttemptId: null, kind: 'generation' as const, route: 'fixture-route',
      requestDigest: 'fixture-digest', maxMicroUsd: micro(200_000), usageClass: 'metered-work' as const, rateSnapshot: { version: 'fixture',
        inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000, cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0 } };
    await funding.reserve(reservation);
    await funding.markDispatched(ref);
    await funding.reserve({ ...reservation, attemptId: 'forged-period' });
    await funding.markDispatched({ ...ref, attemptId: 'forged-period' });
    clock = Date.parse('2026-10-01T00:00:00Z'); await funding.allocatePeriod({ ...allocation, periodId: '2026-10' });
    await commercial.revokePersonGrant('staff', person.id, grant.id, { reason: 'Withdraw after dispatch' });
    const result = await funding.settle({ ...ref, receiptRef: 'fixture-receipt', reconciledFrom: 'response',
      usage: { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } });
    expect(result).toMatchObject({ outcome: 'settled', settlement: { tenantId: person.id, organizationId: account.id,
      periodId: '2026-09', allowanceDebitMicroUsd: 100_000 } });
    if (result.outcome !== 'settled') throw new Error('Expected a settled fixture');
    // A distinct real reservation keeps the primary key from masking the period constraint.
    await expect(new PostgresFundingRepository(fundingFactory).transaction(tx => tx.saveSettlement({ ...result.settlement,
      reservationId: 'forged-period', receiptRef: 'forged-receipt', periodId: '2026-10' }))).rejects.toMatchObject({ code: '23503' });
    await expect(query(fundingFactory, "UPDATE control_plane.funding_reservations SET period_id='2026-10' WHERE reservation_id=$1", [ref.attemptId])).rejects.toMatchObject({ code: '42501' });
    await expect(query(fundingFactory, "UPDATE control_plane.credit_periods SET granted_micro_usd=200000000 WHERE organization_id=$1", [account.id])).rejects.toMatchObject({ code: '42501' });
  });
});
