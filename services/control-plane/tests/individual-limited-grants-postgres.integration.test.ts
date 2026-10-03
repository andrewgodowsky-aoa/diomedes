import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { PostgresRepository, type ClientFactory } from '../src/postgres.js';
import { PostgresCommercialRepository } from '../src/commercial-postgres.js';
import { CommercialService, bootstrapFirstAdmin, type PersonFeatureGrant } from '../src/commercial.js';
import { RoutingService } from '../src/routing.js';
import { FundingService } from '../src/funding.js';
import { PostgresFundingRepository } from '../src/funding-postgres.js';
import { migrate, type Migration } from '../src/migrations.js';
import { individualCycle } from '../../../shared/individual-period.js';
import { micro } from '../../../shared/managed-usage.js';

// This suite accepts only a fresh owned loopback database. Auth is a fixture; PostgreSQL SQL,
// transactions, restricted logins, triggers and permission refusals are real.
const ownerUrl = process.env.CP_LIMITED_INDIVIDUAL_DATABASE_URL;
const at = '2026-09-30T15:00:00.000Z';
const cycle = individualCycle(at, 0);
const legacy = ['nectovia-agent', 'maintained-profiles', 'owner-rules', 'phone-relay'];
const current = [...legacy, 'managed-inference'];
const limited = [
  { name: 'Agent only', features: ['nectovia-agent'] },
  { name: 'Agent and managed inference', features: ['nectovia-agent', 'managed-inference'] },
  ...legacy.map(missing => ({ name: `missing ${missing}`, features: current.filter(feature => feature !== missing) })),
];
const rate = { version: 'fixture', inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0 };
const usage = { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
let ownerFactory: ClientFactory, runtimeFactory: ClientFactory, fundingFactory: ClientFactory;
let accounts: AccountService, routing: RoutingService, commercial: CommercialService, funding: FundingService;
let repairSql: string, serial = 0;
let allMigrations: Migration[];
let preserved: Record<string, unknown>, functionBefore: unknown;
let history: Awaited<ReturnType<typeof source>>;
const query = async (factory: ClientFactory, sql: string, values?: unknown[]) => {
  const client = factory(); await client.connect();
  try { return await client.query(sql, values); } finally { await client.end(); }
};
const verifier = { issuer: 'https://fixture.invalid', async verify(token: string) {
  return { issuer: this.issuer, subject: token, sessionId: `session_${token}`, displayName: token, emailVerified: true,
    issuedAt: '2026-09-30T14:59:59.000Z', expiresAt: '2026-10-30T15:00:00.000Z', verifiedAt: at };
} };
async function source(features: string[], hasTerm: boolean) {
  const token = `limited_fixture_${++serial}`;
  const person = (await accounts.signIn(token)).person;
  const account = await routing.individual(token);
  const grant: PersonFeatureGrant = { v: 1, id: `grant_fixture_${serial}`, personId: person.id, tenantId: person.id,
    planId: 'individual', features: features as PersonFeatureGrant['features'], source: 'internal-test', reference: token,
    note: 'Owned disposable PostgreSQL source fixture', validFrom: at, validUntil: cycle.endsAt,
    state: 'active', issuedAt: at, issuedBy: person.id, revokedAt: null, revokedBy: null, revokedReason: null,
    ...(hasTerm ? { billingCycle: cycle } : {}) };
  await query(ownerFactory, 'INSERT INTO control_plane.person_feature_grants(tenant_id,grant_id,person_id,record) VALUES ($1,$2,$1,$3::jsonb)',
    [person.id, grant.id, JSON.stringify(grant)]);
  await query(ownerFactory, 'INSERT INTO control_plane.person_access(person_id,tenant_id,revision) VALUES ($1,$1,1)', [person.id]);
  return { token, person, account, grant, allocation: { tenantId: person.id, organizationId: account.id,
    planId: 'individual', sourceGrantId: grant.id, periodId: '2026-09' },
    term: { tenantId: person.id, organizationId: account.id, sourceGrantId: grant.id, cycle } };
}
async function snapshot() {
  const rows: Record<string, unknown> = {};
  for (const table of ['person_feature_grants', 'feature_grants', 'billing_scopes', 'billing_customers', 'webhook_inbox', 'credit_periods', 'credit_topups', 'funding_reservations', 'funding_settlements']) {
    rows[table] = (await query(ownerFactory, `SELECT to_jsonb(t) AS record FROM control_plane.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return rows;
}
const functionIdentity = async () => (await query(ownerFactory, `SELECT proowner::regrole::text AS owner,proacl::text AS acl,prosecdef,proconfig
  FROM pg_proc WHERE oid='control_plane.check_individual_period_source()'::regprocedure`)).rows[0];

it('refuses an additive 014 manifest with missing 013 before opening a database', async () => {
  let opened = 0;
  const factory: ClientFactory = () => { opened++; throw new Error('No connection is allowed for an incomplete manifest'); };
  const manifest = [...Array.from({ length: 12 }, (_, index) => index + 1), 14].map(version =>
    ({ version, name: `${version}_fixture.sql`, sql: 'SELECT 1', sha256: '0'.repeat(64) }));
  await expect(migrate(factory, manifest)).rejects.toThrow('Migration sequence must be contiguous');
  expect(opened).toBe(0);
});

describe.skipIf(!ownerUrl)('complete Individual credits through real restricted PostgreSQL roles', () => {
  beforeAll(async () => {
    const url = new URL(ownerUrl!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\/b01_validation_individual_limited_[a-z0-9_]+$/.test(url.pathname))
      throw new Error('Use a new owned disposable local limited-Individual database.');
    ownerFactory = () => new pg.Client({ connectionString: ownerUrl, connectionTimeoutMillis: 5_000 });
    if ((await query(ownerFactory, "SELECT to_regclass('control_plane.schema_migrations') AS existing")).rows[0].existing !== null)
      throw new Error('An existing schema will never be reset.');
    const names = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => /^\d{3}.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 12).sort();
    const migrations = await Promise.all(names.map(async name => {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      return { version: Number(name.slice(0, 3)), name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    }));
    await migrate(ownerFactory, migrations);
    // The repair reserves 014 without adopting PR191's 013 source into this patch. Until 013
    // lands, qualification explicitly supplies its exact reviewed source artifact.
    const external013 = process.env.CP_LIMITED_INDIVIDUAL_MIGRATION_013;
    const sql013 = await readFile(external013 ?? new URL('../migrations/013_purchased_usage_holds.sql', import.meta.url), 'utf8');
    const hash013 = createHash('sha256').update(sql013).digest('hex');
    if (external013 && hash013 !== '3ac7d82912e7bc20f0173fc807b8c3dad15968106028cb6623181c6439bc74fe')
      throw new Error('External 013 differs from pinned PR191 c8f716c source');
    repairSql = await readFile(new URL('../migrations/014_individual_complete_plan_credits.sql', import.meta.url), 'utf8');
    allMigrations = [...migrations,
      { version: 13, name: '013_purchased_usage_holds.sql', sql: sql013, sha256: hash013 },
      { version: 14, name: '014_individual_complete_plan_credits.sql', sql: repairSql, sha256: createHash('sha256').update(repairSql).digest('hex') }];
    async function login(base: 'cp_runtime' | 'cp_funding'): Promise<ClientFactory> {
      const role = `${base}_${randomBytes(6).toString('hex')}`;
      // No provider credential or persistent secret: this owned loopback cluster uses local trust.
      await query(ownerFactory, `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      const file = base === 'cp_runtime' ? 'runtime-permissions.sql' : 'funding-permissions.sql';
      await query(ownerFactory, (await readFile(new URL(`../scripts/${file}`, import.meta.url), 'utf8')).replaceAll(base, role));
      const connection = new URL(ownerUrl!); connection.username = role; connection.password = '';
      return () => new pg.Client({ connectionString: connection.toString(), connectionTimeoutMillis: 5_000 });
    }
    runtimeFactory = await login('cp_runtime'); fundingFactory = await login('cp_funding');
    const ownerAccounts = new AccountService(new PostgresRepository(ownerFactory), verifier, { now: () => Date.parse(at) });
    const staff = (await ownerAccounts.signIn('staff')).person;
    await bootstrapFirstAdmin(new PostgresCommercialRepository(ownerFactory), staff.id, at);
    accounts = new AccountService(new PostgresRepository(runtimeFactory), verifier, { now: () => Date.parse(at) });
    funding = new FundingService(new PostgresFundingRepository(fundingFactory), { now: () => Date.parse(at) });
    const repository = new PostgresCommercialRepository(runtimeFactory);
    commercial = new CommercialService(accounts, repository, funding, { now: () => Date.parse(at) });
    routing = new RoutingService(accounts, repository, () => Date.parse(at), funding);
    // A row the old permissive SQL accepted is historical evidence, even after the repair.
    history = await source(['nectovia-agent', 'managed-inference'], false);
    await funding.allocatePeriod(history.allocation);
    const refs = { tenantId: history.person.id, organizationId: history.account.id, rootJobId: 'history-job' };
    await funding.openJob({ ...refs, runRef: 'history-job', parentRunRef: null, tier: 'efficient', capMicroUsd: null });
    for (const attemptId of ['history-settled', 'history-sent']) {
      const reservation = { ...refs, attemptId, parentAttemptId: null, kind: 'generation' as const, route: 'fixture-route',
        requestDigest: attemptId, rateSnapshot: rate, maxMicroUsd: micro(200_000), usageClass: 'metered-work' as const };
      await funding.reserve(reservation); await funding.markDispatched(reservation);
      if (attemptId === 'history-settled') await funding.settle({ ...reservation, receiptRef: 'history-receipt', usage, reconciledFrom: 'response' });
    }
    // Synthetic prior purchase provenance satisfies the real ledger foreign keys;
    // no payment endpoint or provider verification is exercised by this fixture.
    await query(ownerFactory, 'INSERT INTO control_plane.billing_customers(provider,customer_id,organization_id,tenant_id) VALUES ($1,$2,$3,$4)',
      ['stripe', 'cus_history_fixture', history.account.id, history.person.id]);
    await new PostgresRepository(ownerFactory).recordVerifiedWebhook({ provider: 'stripe', eventId: 'evt_history_fixture',
      customerId: 'cus_history_fixture', payloadHash: 'a'.repeat(64), eventType: 'fixture.purchase', payload: { fixture: true } });
    await new FundingService(new PostgresFundingRepository(ownerFactory), { now: () => Date.parse(at) }).recordTopUp({
      ...refs, topUpId: 'history-purchase', amountMicroUsd: micro(2_000_000), provider: 'stripe', sourceEventId: 'evt_history_fixture' });
    preserved = await snapshot(); functionBefore = await functionIdentity();
    // Exercise real contiguous upgrade and hashed replay, including the actual external 013.
    expect(await migrate(ownerFactory, allMigrations)).toEqual([13, 14]);
  }, 60_000);

  it('preserves historical grants, allocations, purchases, holds and settlements without widening the function owner or ACL', async () => {
    expect(await snapshot()).toEqual(preserved);
    expect(await functionIdentity()).toEqual(functionBefore);
    await query(ownerFactory, repairSql);
    expect(await snapshot()).toEqual(preserved);
    expect(await functionIdentity()).toEqual(functionBefore);
  });

  it('records and replays the actual contiguous 001 through 014 history with pinned source hashes', async () => {
    expect((await query(ownerFactory, 'SELECT version,name,sha256 FROM control_plane.schema_migrations ORDER BY version')).rows)
      .toEqual(allMigrations.map(({ version, name, sha256 }) => ({ version, name, sha256 })));
    expect(await migrate(ownerFactory, allMigrations)).toEqual([]);
    const changed = allMigrations.map(row => row.version === 12 ? { ...row, sha256: '0'.repeat(64) } : row);
    await expect(migrate(ownerFactory, changed)).rejects.toThrow('Migration history does not match');
  });

  it('keeps schema and credit rewrites out of restricted logins and grants out of funding', async () => {
    for (const factory of [runtimeFactory, fundingFactory]) {
      expect((await query(factory, 'SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
        .toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      await expect(query(factory, 'CREATE TABLE control_plane.forbidden_fixture(id text)')).rejects.toMatchObject({ code: '42501' });
      expect((await query(factory, "SELECT has_function_privilege(current_user,'control_plane.check_individual_period_source()','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
    }
    await expect(query(runtimeFactory, 'INSERT INTO control_plane.credit_periods DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' });
    await expect(query(fundingFactory, 'INSERT INTO control_plane.person_feature_grants DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' });
    await expect(query(fundingFactory, "UPDATE control_plane.credit_periods SET granted_micro_usd=200000000")).rejects.toMatchObject({ code: '42501' });
    await expect(query(fundingFactory, repairSql)).rejects.toMatchObject({ code: '42501' });
  });

  it.each(limited.flatMap(row => [{ ...row, term: 'legacy calendar', hasTerm: false }, { ...row, term: 'monthly', hasTerm: true }]))
    ('$name / $term cannot manufacture 1,000 credits through the funding login', async ({ features, hasTerm }) => {
      const fixture = await source(features, hasTerm);
      await expect(hasTerm ? funding.allocateIndividualPeriod(fixture.term) : funding.allocatePeriod(fixture.allocation)).rejects.toMatchObject({ code: '23514' });
      expect((await query(ownerFactory, 'SELECT count(*)::int AS n FROM control_plane.credit_periods WHERE organization_id=$1', [fixture.account.id])).rows[0].n).toBe(0);
    });

  it.each([{ name: 'legacy four', features: legacy }, { name: 'current five', features: current }].flatMap(row =>
    [{ ...row, term: 'legacy calendar', hasTerm: false }, { ...row, term: 'monthly', hasTerm: true }]))
    ('$name / $term retains exactly one compatible allowance', async ({ features, hasTerm }) => {
      const fixture = await source(features, hasTerm);
      const allocate = () => hasTerm ? funding.allocateIndividualPeriod(fixture.term) : funding.allocatePeriod(fixture.allocation);
      const rows = await Promise.all(Array.from({ length: 4 }, allocate));
      expect(rows.every(row => row.grantedMicroUsd === 100_000_000 && row.sourceGrantId === fixture.grant.id)).toBe(true);
      expect((await query(ownerFactory, 'SELECT count(*)::int AS n FROM control_plane.credit_periods WHERE organization_id=$1', [fixture.account.id])).rows[0].n).toBe(1);
    });

  it('retries a lost successful monthly COMMIT without allocating twice after 014', async () => {
    const fixture = await source(current, true);
    let lost = false;
    const interruptedFactory: ClientFactory = () => {
      const client = fundingFactory();
      return { connect: () => client.connect(), end: () => client.end(), query: async (sql, values) => {
        const result = await client.query(sql, values);
        if (sql === 'COMMIT' && !lost) { lost = true; throw new Error('Fixture lost the successful COMMIT response'); }
        return result;
      } };
    };
    const interrupted = new FundingService(new PostgresFundingRepository(interruptedFactory), { now: () => Date.parse(at) });
    await expect(interrupted.allocateIndividualPeriod(fixture.term)).rejects.toThrow('lost the successful COMMIT');
    expect(await funding.allocateIndividualPeriod(fixture.term)).toMatchObject({
      grantedMicroUsd: 100_000_000, sourceGrantId: fixture.grant.id,
    });
    expect((await query(ownerFactory, 'SELECT count(*)::int AS n,sum(granted_micro_usd)::text AS total FROM control_plane.credit_periods WHERE organization_id=$1', [fixture.account.id])).rows)
      .toEqual([{ n: 1, total: '100000000' }]);
  });

  it('retains the grant/person/tenant/account boundary for complete templates', async () => {
    const first = await source(current, true), other = await source(current, true);
    await expect(funding.allocateIndividualPeriod({ ...first.term, sourceGrantId: other.grant.id })).rejects.toThrow();
    await expect(funding.allocateIndividualPeriod({ ...first.term, organizationId: other.account.id })).rejects.toThrow();
    await expect(funding.allocateIndividualPeriod({ ...first.term, tenantId: other.person.id })).rejects.toThrow();
    expect((await query(ownerFactory, 'SELECT count(*)::int AS n FROM control_plane.credit_periods WHERE organization_id=ANY($1::text[])', [[first.account.id, other.account.id]])).rows[0].n).toBe(0);
  });

  it('enforces limited issuance through the real runtime login and leaves compatibility intact', async () => {
    const person = (await accounts.signIn('issuance')).person;
    const common = { planId: 'individual', source: 'internal-test' as const, reference: 'Limited SQL issuance', note: '' };
    await expect(commercial.issuePersonGrant('staff', person.id, { ...common, features: ['nectovia-agent', 'managed-inference'] })).rejects.toMatchObject({ status: 422 });
    await expect(commercial.issuePersonGrant('staff', person.id, { ...common, features: ['nectovia-agent', 'managed-inference'],
      validUntil: cycle.endsAt, billingCycle: { anchorAt: at, index: 0 } })).rejects.toMatchObject({ status: 422 });
    const limited = await commercial.issuePersonGrant('staff', person.id, { ...common, features: ['nectovia-agent', 'managed-inference'], validUntil: cycle.endsAt });
    expect(limited.grant.billingCycle).toBeUndefined();
    const fullPerson = (await accounts.signIn('legacy-issuance')).person;
    const full = await commercial.issuePersonGrant('staff', fullPerson.id, { ...common, reference: 'Legacy template SQL issuance', features: legacy as PersonFeatureGrant['features'] });
    expect(full.grant.billingCycle).toEqual(cycle);
  });

  it('settles already dispatched historical work after the repair without a debit, reclaim or purchase rewrite', async () => {
    const beforePeriod = (await query(ownerFactory, 'SELECT to_jsonb(p) AS record FROM control_plane.credit_periods p WHERE organization_id=$1', [history.account.id])).rows[0];
    const beforeTopup = (await query(ownerFactory, 'SELECT to_jsonb(t) AS record FROM control_plane.credit_topups t WHERE organization_id=$1', [history.account.id])).rows[0];
    const result = await funding.settle({ tenantId: history.person.id, organizationId: history.account.id, attemptId: 'history-sent',
      receiptRef: 'history-late-receipt', usage, reconciledFrom: 'response' });
    expect(result).toMatchObject({ outcome: 'settled', settlement: { periodId: '2026-09', allowanceDebitMicroUsd: 100_000 } });
    expect((await query(ownerFactory, 'SELECT to_jsonb(p) AS record FROM control_plane.credit_periods p WHERE organization_id=$1', [history.account.id])).rows[0]).toEqual(beforePeriod);
    expect((await query(ownerFactory, 'SELECT to_jsonb(t) AS record FROM control_plane.credit_topups t WHERE organization_id=$1', [history.account.id])).rows[0]).toEqual(beforeTopup);
  });
});
