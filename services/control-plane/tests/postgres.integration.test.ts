import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { Client as NeonClient } from '@neondatabase/serverless';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate, type Migration } from '../src/migrations.js';
import { PostgresRepository, type SqlClient } from '../src/postgres.js';
import { AccountService } from '../src/account-service.js';
import { verifier, now } from './support/fixtures.js';
import { FundingService } from '../src/funding.js';
import { PostgresFundingRepository } from '../src/funding-postgres.js';
import { creditAmount } from '../../../shared/managed-usage.js';

const connectionString = process.env.CP_TEST_DATABASE_URL;
const enabled = Boolean(connectionString);
let factory: () => SqlClient;
let migrations: Migration[];
let repository: PostgresRepository;
let accounts: AccountService;

async function query(sql: string, values?: unknown[]) {
  const client = factory();
  await client.connect();
  try { return await client.query(sql, values); } finally { await client.end(); }
}

describe.skipIf(!enabled)('REAL PostgreSQL (explicit disposable database only)', () => {
  beforeAll(async () => {
    const url = new URL(connectionString!);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!/^\/b01_validation_[a-z0-9_]+$/.test(url.pathname) || process.env.CP_TEST_ALLOW_SCHEMA_RESET !== 'yes')
      throw new Error('Use a disposable b01_validation_* database and explicitly authorize schema reset.');
    if (!local && (
      !url.hostname.endsWith('.neon.tech') ||
      url.hostname !== process.env.CP_TEST_EXPECTED_HOST ||
      !process.env.CP_TEST_BRANCH_ID?.startsWith('br-') ||
      process.env.CP_TEST_BRANCH_ID === 'br-old-star-aepf7zk6'
    )) throw new Error('Pin the approved isolated branch and exact endpoint; production is prohibited.');
    factory = local
      ? () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000 })
      : () => new NeonClient({ connectionString, connectionTimeoutMillis: 5000 });
    migrations = await Promise.all(['001_accounts.sql', '002_commercial.sql', '003_funded_jobs.sql', '004_usage_contract.sql', '005_customer_access.sql'].map(async (name, index) => {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      return { version: index + 1, name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    }));
    repository = new PostgresRepository(factory);
    accounts = new AccountService(repository, verifier, { now: () => now });
  });

  it('migrates an empty DB, then upgrades a prior version and is idempotent', async () => {
    await query('DROP SCHEMA IF EXISTS control_plane CASCADE');
    expect(await migrate(factory, [migrations[0]])).toEqual([1]);
    expect(await migrate(factory, migrations)).toEqual([2, 3, 4]);
    expect(await migrate(factory, migrations)).toEqual([]);
  });
  it('rolls back interrupted DDL and its version row', async () => {
    const broken = { version: 5, name: 'interruption', sql: 'CREATE TABLE control_plane.interrupted(id integer); SELECT 1/0;', sha256: 'f'.repeat(64) };
    await expect(migrate(factory, [...migrations, broken])).rejects.toThrow();
    expect((await query("SELECT to_regclass('control_plane.interrupted') AS relation")).rows[0].relation).toBeNull();
    expect((await query('SELECT count(*)::int AS count FROM control_plane.schema_migrations')).rows[0].count).toBe(4);
  });
  it('maps concurrent identical verified subjects to exactly one person', async () => {
    const sessions = await Promise.all(Array.from({ length: 6 }, () => accounts.signIn('alice')));
    expect(new Set(sessions.map((value) => value.person.id)).size).toBe(1);
    expect((await query('SELECT count(*)::int AS count FROM control_plane.external_subjects')).rows[0].count).toBe(1);
  });
  it('rolls back all earlier writes when a tenant authorization fails', async () => {
    await expect(accounts.invite('rollback', 'org_missing', { subject: 'user_bob', role: 'member', ttlMs: 5000 })).rejects.toMatchObject({ status: 403 });
    expect((await query('SELECT count(*)::int AS count FROM control_plane.external_subjects WHERE subject=$1', ['user_rollback'])).rows[0].count).toBe(0);
  });
  it('serializes invitation redemption and competing last-owner removals', async () => {
    const org = await accounts.createOrganization('alice', 'Concurrent organization');
    const invitation = await accounts.invite('alice', org.id, { subject: 'user_bob', role: 'owner', ttlMs: 5000 });
    const accepted = await Promise.allSettled([accounts.acceptInvitation('bob', org.id, invitation.token), accounts.acceptInvitation('bob', org.id, invitation.token)]);
    expect(accepted.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const alice = await accounts.signIn('alice'); const bob = await accounts.signIn('bob');
    const changed = await Promise.allSettled([
      accounts.setMembership('alice', org.id, alice.person.id, { role: 'member', state: 'revoked' }),
      accounts.setMembership('bob', org.id, bob.person.id, { role: 'member', state: 'revoked' }),
    ]);
    expect(changed.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect((await query("SELECT count(*)::int AS count FROM control_plane.memberships WHERE organization_id=$1 AND record->>'role'='owner' AND record->>'state'='active'", [org.id])).rows[0].count).toBe(1);
  });
  it('binds unique customer mappings and deduplicates verified events atomically', async () => {
    const org = await accounts.createOrganization('alice', 'Billing fixture');
    await query('INSERT INTO control_plane.billing_customers(provider,customer_id,organization_id,tenant_id) VALUES ($1,$2,$3,$4)', ['stripe', 'cus_fixture', org.id, org.tenantId]);
    const event = { provider: 'stripe' as const, eventId: 'evt_fixture', customerId: 'cus_fixture', payloadHash: 'a'.repeat(64), eventType: 'fixture.event', payload: { fixture: true } };
    const results = await Promise.all([repository.recordVerifiedWebhook(event), repository.recordVerifiedWebhook(event)]);
    expect(results.filter((value) => value.inserted)).toHaveLength(1);
    expect(results.every((value) => value.tenantId === org.tenantId)).toBe(true);
    await expect(repository.recordVerifiedWebhook({ ...event, payloadHash: 'b'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    const other = await accounts.createOrganization('alice', 'Other tenant');
    await expect(query('INSERT INTO control_plane.billing_customers(provider,customer_id,organization_id,tenant_id) VALUES ($1,$2,$3,$4)', ['stripe', 'cus_other', other.id, org.tenantId])).rejects.toMatchObject({ code: '23503' });
  });
  async function fundedOrganization(label: string) {
    const org = await accounts.createOrganization('alice', label);
    const customer = `cus_${label.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
    const event = `evt_${label.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
    await query('INSERT INTO control_plane.billing_customers(provider,customer_id,organization_id,tenant_id) VALUES ($1,$2,$3,$4)', ['stripe', customer, org.id, org.tenantId]);
    await repository.recordVerifiedWebhook({ provider: 'stripe', eventId: event, customerId: customer, payloadHash: 'c'.repeat(64), eventType: 'fixture.grant', payload: { fixture: true } });
    await query("INSERT INTO control_plane.entitlement_grants(tenant_id,grant_id,organization_id,provider,source_event_id,kind,state,valid_from,valid_until,projection) VALUES ($1,$2,$3,'stripe',$4,'plan','active','2026-09-01T00:00:00Z','2026-10-01T00:00:00Z','{}'::jsonb)",
      [org.tenantId, `grant_${org.id}`, org.id, event]);
    const funding = new FundingService(new PostgresFundingRepository(factory), { now: () => Date.parse('2026-09-10T12:00:00Z') });
    await funding.allocatePeriod({ tenantId: org.tenantId, organizationId: org.id, periodId: '2026-09', planId: 'workflow-starter', sourceGrantId: `grant_${org.id}` });
    return { org, funding };
  }
  const rate = { version: 'fixture', inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000, cacheReadMicroUsdPerMillion: 1_000_000, cacheWriteMicroUsdPerMillion: 1_000_000 };
  it('serializes concurrent funded reservations so the last credits are held once', async () => {
    const { org, funding } = await fundedOrganization('Funding race');
    // Six Thorough jobs (100-credit caps) each ask for 90 of the month's 500 credits: five fit.
    const jobs = ['job_a', 'job_b', 'job_c', 'job_d', 'job_e', 'job_f'];
    for (const job of jobs)
      await funding.openJob({ tenantId: org.tenantId, organizationId: org.id, rootJobId: job, runRef: `run_${job}`, parentRunRef: null, tier: 'thorough', capMicroUsd: null });
    const reserve = (job: string) => funding.reserve({ tenantId: org.tenantId, organizationId: org.id, attemptId: `attempt_${job}`, rootJobId: job, parentAttemptId: null,
      kind: 'generation', route: 'aws-bedrock', requestDigest: `digest_${job}`, rateSnapshot: rate, maxMicroUsd: creditAmount(90), usageClass: 'metered-work' });
    const results = await Promise.allSettled(jobs.map(reserve));
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(5);
    const state = await funding.projection(org.tenantId, org.id);
    expect(state.state === 'ready' && state.projection.pendingMicroUsd).toBe(creditAmount(450));
  });
  it('keeps a sent hold across a restarted repository and settles it in its own period', async () => {
    const { org, funding } = await fundedOrganization('Funding restart');
    await funding.openJob({ tenantId: org.tenantId, organizationId: org.id, rootJobId: 'job_r', runRef: 'run_job_r', parentRunRef: null, tier: 'efficient', capMicroUsd: null });
    const ref = { tenantId: org.tenantId, organizationId: org.id, attemptId: 'attempt_r' };
    await funding.reserve({ ...ref, rootJobId: 'job_r', parentAttemptId: null, kind: 'generation', route: 'aws-bedrock', requestDigest: 'digest_r', rateSnapshot: rate, maxMicroUsd: creditAmount(10), usageClass: 'metered-work' });
    await funding.markDispatched(ref);
    const restarted = new FundingService(new PostgresFundingRepository(factory), { now: () => Date.parse('2026-10-02T00:00:00Z') });
    expect(await restarted.recoverAfterRestart({ tenantId: org.tenantId, organizationId: org.id })).toEqual({ released: [], uncertain: ['attempt_r'] });
    const settled = await restarted.settle({ ...ref, receiptRef: 'receipt_r', usage: { inputTokens: 400_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, reconciledFrom: 'provider-report' });
    expect(settled.outcome === 'settled' && settled.settlement.periodId).toBe('2026-09');
  });
  it('refuses a funded period bound to another tenant’s grant', async () => {
    const { org } = await fundedOrganization('Funding tenant');
    const other = await accounts.createOrganization('alice', 'Funding other tenant');
    await expect(query("INSERT INTO control_plane.credit_periods(tenant_id,organization_id,period_id,plan_id,rate_card_version,granted_micro_usd,starts_at,ends_at,source_grant_id,allocated_at) VALUES ($1,$2,'2026-09','business','r',1,'2026-09-01','2026-10-01',$3,now())",
      [other.tenantId, other.id, `grant_${org.id}`])).rejects.toMatchObject({ code: '23503' });
  });
  it('retains revoked session tombstones across repository instances', async () => {
    await accounts.revokeLocalSession('revoked');
    const restarted = new AccountService(new PostgresRepository(factory), verifier, { now: () => now });
    await expect(restarted.signIn('revoked')).rejects.toMatchObject({ status: 401 });
  });
});
