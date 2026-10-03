import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { Client as NeonClient } from '@neondatabase/serverless';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { PostgresRepository, type ClientFactory } from '../src/postgres.js';
import { PostgresCommercialRepository } from '../src/commercial-postgres.js';
import { RoutingService } from '../src/routing.js';
import { migrate, type Migration } from '../src/migrations.js';
import { now, verifier } from './support/fixtures.js';
import { ROUTING_CONSENT_VERSION, STRICT_RESTRICTIONS, routingScopeKey, type AccountScope } from '../../../shared/routing-policy.js';

const ownerUrl = process.env.CP_ROUTING_TEST_DATABASE_URL;
let ownerFactory: ClientFactory, runtimeFactory: ClientFactory, accounts: AccountService, routing: RoutingService;
let migrations: Migration[], existingOrganization: string, runtimeRole: string;
let ownerPersonId: string, originalGrant: string, originalAdmission: string;
const query = async (factory: ClientFactory, sql: string, values?: unknown[]) => {
  const client = factory(); await client.connect();
  try { return await client.query(sql, values); } finally { await client.end(); }
};
const runtime = (sql: string, values?: unknown[]) => query(runtimeFactory, sql, values);

// This suite never resets a schema and cannot use the application/staging database.
// Supply a new disposable DB explicitly; never infer a target from DATABASE_URL.
describe.skipIf(!ownerUrl)('scoped routing on an isolated real PostgreSQL database', () => {
  beforeAll(async () => {
    const url = new URL(ownerUrl!);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!/^\/b01_validation_operations_routing_[a-z0-9_]+$/.test(url.pathname) || url.hostname.includes('-pooler'))
      throw new Error('A new disposable operations-routing database on a direct endpoint is required.');
    if (!local && (process.env.CP_APPROVED_ISOLATED_BRANCH !== 'yes' ||
        url.hostname !== process.env.CP_TEST_EXPECTED_HOST || !url.hostname.endsWith('.neon.tech') ||
        !process.env.CP_TEST_BRANCH_ID?.startsWith('br-') || process.env.CP_TEST_BRANCH_ID === 'br-old-star-aepf7zk6'))
      throw new Error('Pin the approved isolated branch and its exact endpoint.');
    ownerFactory = local ? () => new pg.Client({ connectionString: ownerUrl, connectionTimeoutMillis: 5000 })
      : () => new NeonClient({ connectionString: ownerUrl, connectionTimeoutMillis: 5000 });
    if ((await query(ownerFactory, "SELECT to_regclass('control_plane.schema_migrations') AS existing")).rows[0].existing !== null)
      throw new Error('This test requires a new database; it will not reset an existing schema.');
    const names = ['001_accounts.sql', '002_commercial.sql', '003_funded_jobs.sql', '004_usage_contract.sql',
      '005_customer_access.sql', '006_staff_keys.sql', '007_relay_devices.sql', '008_organization_setup.sql',
      '009_individual_plans.sql', '010-scoped-routing.sql'];
    migrations = await Promise.all(names.map(async (name, index) => {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      return { version: index + 1, name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    }));
    expect(migrations[8].sha256).toBe('540f7bb22cc183175984fcdcf8e82718a7b093ec77d09329656ddd68196e5886');
    await migrate(ownerFactory, migrations.slice(0, 9));
    const oldAccounts = new AccountService(new PostgresRepository(ownerFactory), verifier, { now: () => now });
    existingOrganization = (await oldAccounts.createOrganization('routing_owner', 'Existing fixture organization')).id;
    const person = (await oldAccounts.signIn('routing_owner')).person;
    ownerPersonId = person.id;
    const at = new Date(now).toISOString();
    // Write the actual pre-010 schema. The new adapter already requires scope_key.
    await query(ownerFactory, 'INSERT INTO control_plane.tier_policies(revision,record) VALUES ($1,$2::jsonb)', [1,
      JSON.stringify({ v: 1, revision: 1, tiers: { efficient: null, focused: null, thorough: null },
        kind: 'publish', basedOn: 0, publishedAt: at, publishedBy: person.id, note: 'Existing no-fallback policy' })]);
    const grant = { v: 1, id: 'grant_before_routing', personId: person.id, tenantId: person.id, planId: 'individual',
      features: ['nectovia-agent'], source: 'subscription', reference: 'fixture_invoice_before_routing', note: '',
      validFrom: at, validUntil: new Date(now + 86_400_000).toISOString(), state: 'active',
      issuedAt: at, issuedBy: person.id, revokedAt: null, revokedBy: null, revokedReason: null };
    const admission = { id: 'admission_before_routing', tenantId: person.id, personId: person.id, at,
      surface: 'conversation', routeKind: 'byo', decision: 'admitted', code: null, planId: 'individual',
      accessRevision: 7, policyRevision: 1, rootJobId: 'prior_personal_work' };
    await query(ownerFactory, 'INSERT INTO control_plane.person_feature_grants(tenant_id,grant_id,person_id,record) VALUES ($1,$2,$1,$3::jsonb)',
      [person.id, grant.id, JSON.stringify(grant)]);
    await query(ownerFactory, 'INSERT INTO control_plane.person_access(person_id,tenant_id,revision) VALUES ($1,$1,7)', [person.id]);
    await query(ownerFactory, 'INSERT INTO control_plane.personal_agent_admissions(tenant_id,id,person_id,at,record) VALUES ($1,$2,$1,$3,$4::jsonb)',
      [person.id, admission.id, at, JSON.stringify(admission)]);
    const grantText = (await query(ownerFactory, 'SELECT record::text AS record FROM control_plane.person_feature_grants WHERE grant_id=$1', [grant.id])).rows[0].record;
    const admissionText = (await query(ownerFactory, 'SELECT record::text AS record FROM control_plane.personal_agent_admissions WHERE id=$1', [admission.id])).rows[0].record;
    if (typeof grantText !== 'string' || typeof admissionText !== 'string') throw new Error('The prior Personal records were not returned as text.');
    originalGrant = grantText;
    originalAdmission = admissionText;
    expect(await migrate(ownerFactory, migrations)).toEqual([10]);
    runtimeRole = `cp_routing_runtime_${randomBytes(6).toString('hex')}`;
    const runtimePassword = randomBytes(32).toString('hex');
    await query(ownerFactory, `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    const permissions = await readFile(new URL('../scripts/runtime-permissions.sql', import.meta.url), 'utf8');
    await query(ownerFactory, permissions.replace(/\bcp_runtime\b/g, runtimeRole));
    // Connect as the restricted login itself, without relying on the migration
    // owner's ability to SET ROLE or granting the fixture any role membership.
    const runtimeUrl = new URL(ownerUrl!);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtimeFactory = local ? () => new pg.Client({ connectionString: runtimeUrl.href, connectionTimeoutMillis: 5000 })
      : () => new NeonClient({ connectionString: runtimeUrl.href, connectionTimeoutMillis: 5000 });
    accounts = new AccountService(new PostgresRepository(runtimeFactory), verifier, { now: () => now });
    routing = new RoutingService(accounts, new PostgresCommercialRepository(runtimeFactory), () => now);
  }, 60_000);

  it('runs as an unprivileged login without inherited role memberships', async () => {
    expect((await runtime('SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{ name: runtimeRole, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]);
    expect((await runtime('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows)
      .toEqual([]);
  });

  it('backfills only identities for existing organizations and grant holders without creating access or funding', async () => {
    expect((await runtime("SELECT id,kind,person_id FROM control_plane.billing_scopes WHERE kind='organization'")).rows)
      .toEqual([{ id: existingOrganization, kind: 'organization', person_id: null }]);
    const individuals = (await runtime("SELECT id,tenant_id,person_id FROM control_plane.billing_scopes WHERE kind='individual'")).rows;
    expect(individuals).toHaveLength(1);
    expect(individuals[0]).toEqual({ id: expect.stringMatching(/^individual_/), tenant_id: ownerPersonId, person_id: ownerPersonId });
    const legacy = await routing.snapshot('routing_owner', { kind: 'organization', id: existingOrganization }, {});
    expect(legacy).toMatchObject({ legacy: true, revision: 1, preferenceRevision: 0 });
    const policy = await new PostgresCommercialRepository(runtimeFactory).transaction(tx => tx.policy());
    expect(policy?.routing).toBeUndefined();
    expect((await query(ownerFactory, 'SELECT count(*)::int AS count FROM control_plane.credit_periods')).rows[0].count).toBe(0);
    expect(await migrate(ownerFactory, migrations)).toEqual([]);
  });

  it('preserves 009 grant bytes, revisions and append-only Personal history while new admissions bind the billing scope', async () => {
    expect((await runtime('SELECT record::text AS record FROM control_plane.person_feature_grants WHERE grant_id=$1', ['grant_before_routing'])).rows)
      .toEqual([{ record: originalGrant }]);
    expect((await runtime('SELECT person_id,tenant_id,revision::int FROM control_plane.person_access')).rows)
      .toEqual([{ person_id: ownerPersonId, tenant_id: ownerPersonId, revision: 7 }]);
    expect((await runtime('SELECT record::text AS record,billing_account_id FROM control_plane.personal_agent_admissions WHERE id=$1', ['admission_before_routing'])).rows)
      .toEqual([{ record: originalAdmission, billing_account_id: null }]);
    const scope: AccountScope = { kind: 'individual', id: (await routing.individual('routing_owner')).id };
    const admitted = await routing.admit('routing_owner', scope, { surface: 'conversation', routeKind: 'byo', rootJobId: 'after_upgrade' });
    expect(admitted).toMatchObject({ decision: { admitted: true }, pins: { scope, organizationId: null, tenantId: ownerPersonId, personId: ownerPersonId } });
    expect((await runtime('SELECT billing_account_id,tenant_id FROM control_plane.personal_agent_admissions WHERE id=$1', [admitted.admissionId])).rows)
      .toEqual([{ billing_account_id: scope.id, tenant_id: ownerPersonId }]);
    await expect(runtime('UPDATE control_plane.personal_agent_admissions SET record=record WHERE id=$1', [admitted.admissionId]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(query(ownerFactory, 'UPDATE control_plane.personal_agent_admissions SET record=record WHERE id=$1', [admitted.admissionId]))
      .rejects.toThrow(/append-only/);
  });

  it('creates one Individual identity concurrently, locks it with the restricted runtime role and keeps membership separate', async () => {
    const individuals = await Promise.all(Array.from({ length: 4 }, () => routing.individual('routing_new')));
    expect(new Set(individuals.map(i => i.id)).size).toBe(1);
    const scope: AccountScope = { kind: 'individual', id: individuals[0].id };
    const snapshot = await routing.snapshot('routing_new', scope, {});
    expect(snapshot).toMatchObject({ scope, legacy: false, canEditPreferences: true });
    await expect(routing.snapshot('routing_other', scope, {})).rejects.toMatchObject({ status: 403 });
    const org = await accounts.createOrganization('routing_owner', 'New fixture organization');
    expect((await runtime('SELECT kind FROM control_plane.billing_scopes WHERE id=$1', [org.id])).rows).toEqual([{ kind: 'organization' }]);
    expect((await runtime('SELECT id FROM control_plane.organizations WHERE id=$1', [scope.id])).rows).toEqual([]);
  });

  it('persists append-only customer consent across new service instances and refuses history rewrites', async () => {
    const scope: AccountScope = { kind: 'individual', id: (await routing.individual('routing_owner')).id };
    const input = { scope, baseRevision: 0, profile: 'strict', restrictions: STRICT_RESTRICTIONS, exceptions: [],
      consentVersion: ROUTING_CONSENT_VERSION, acknowledge: true };
    const results = await Promise.allSettled([routing.acceptPreference('routing_owner', input), routing.acceptPreference('routing_owner', input)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const restarted = new RoutingService(accounts, new PostgresCommercialRepository(runtimeFactory), () => now);
    expect(await restarted.preference('routing_owner', scope)).toMatchObject({ revision: 1, scope, profile: 'strict' });
    await expect(runtime('UPDATE control_plane.account_routing_preferences SET revision=revision WHERE scope_key=$1', [routingScopeKey(scope)]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(query(ownerFactory, 'UPDATE control_plane.account_routing_preferences SET revision=revision WHERE scope_key=$1', [routingScopeKey(scope)]))
      .rejects.toThrow(/append-only/);
  });

  it('allows only monotone source restrictions and refuses funding or scope identity mutation from the runtime', async () => {
    const repository = new PostgresCommercialRepository(runtimeFactory);
    await repository.transaction(tx => tx.restrictJob('organization:fixture', 'job', [STRICT_RESTRICTIONS]));
    await expect(runtime("UPDATE control_plane.routing_job_constraints SET restrictions='[]'::jsonb WHERE job_id='job'"))
      .rejects.toThrow(/cannot be removed/);
    await expect(runtime("UPDATE control_plane.billing_scopes SET person_id=person_id WHERE false")).rejects.toMatchObject({ code: '42501' });
    await expect(runtime('UPDATE control_plane.credit_periods SET organization_id=organization_id WHERE false')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime('DELETE FROM control_plane.account_routing_preferences WHERE false')).rejects.toMatchObject({ code: '42501' });
  });
});
