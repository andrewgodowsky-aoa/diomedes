import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { Client as NeonClient } from '@neondatabase/serverless';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { PostgresRepository, type ClientFactory, type SqlClient } from '../src/postgres.js';
import { PostgresCommercialRepository } from '../src/commercial-postgres.js';
import { RoutingService } from '../src/routing.js';
import { migrate, type Migration } from '../src/migrations.js';
import { now, verifier } from './support/fixtures.js';
import { STRICT_RESTRICTIONS, routingScopeKey, type AccountScope } from '../../../shared/routing-policy.js';

const ownerUrl = process.env.CP_ROUTING_TEST_DATABASE_URL;
let ownerFactory: ClientFactory, runtimeFactory: ClientFactory, accounts: AccountService, routing: RoutingService;
let migrations: Migration[], existingOrganization: string, runtimeRole: string;
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
      '005_customer_access.sql', '006_staff_keys.sql', '007_relay_devices.sql', '008_organization_setup.sql', '009-scoped-routing.sql'];
    migrations = await Promise.all(names.map(async (name, index) => {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      return { version: index + 1, name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    }));
    await migrate(ownerFactory, migrations.slice(0, 8));
    const oldAccounts = new AccountService(new PostgresRepository(ownerFactory), verifier, { now: () => now });
    existingOrganization = (await oldAccounts.createOrganization('routing_owner', 'Existing fixture organization')).id;
    const person = (await oldAccounts.signIn('routing_owner')).person;
    const commercial = new PostgresCommercialRepository(ownerFactory);
    await commercial.transaction(tx => tx.savePolicy({ v: 1, revision: 1, tiers: { efficient: null, focused: null, thorough: null },
      kind: 'publish', basedOn: 0, publishedAt: new Date(now).toISOString(), publishedBy: person.id, note: 'Existing no-fallback policy' }));
    expect(await migrate(ownerFactory, migrations)).toEqual([9]);
    runtimeRole = `cp_routing_runtime_${randomBytes(6).toString('hex')}`;
    await query(ownerFactory, `CREATE ROLE ${runtimeRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    const permissions = await readFile(new URL('../scripts/runtime-permissions.sql', import.meta.url), 'utf8');
    await query(ownerFactory, permissions.replace(/\bcp_runtime\b/g, runtimeRole));
    runtimeFactory = () => {
      const client = ownerFactory();
      return { connect: async () => { await client.connect(); await client.query(`SET ROLE ${runtimeRole}`); },
        query: client.query.bind(client), end: client.end.bind(client), on: client.on?.bind(client) } satisfies SqlClient;
    };
    accounts = new AccountService(new PostgresRepository(runtimeFactory), verifier, { now: () => now });
    routing = new RoutingService(accounts, new PostgresCommercialRepository(runtimeFactory), () => now);
  }, 60_000);

  it('backfills organizations while preserving a legacy no-fallback policy and creating no Individual or funding rows', async () => {
    expect((await runtime('SELECT id,kind,person_id FROM control_plane.billing_scopes')).rows)
      .toEqual([{ id: existingOrganization, kind: 'organization', person_id: null }]);
    const legacy = await routing.snapshot('routing_owner', { kind: 'organization', id: existingOrganization }, {});
    expect(legacy).toMatchObject({ legacy: true, revision: 1, preferenceRevision: 0 });
    const policy = await new PostgresCommercialRepository(runtimeFactory).transaction(tx => tx.policy());
    expect(policy?.routing).toBeUndefined();
    expect((await query(ownerFactory, 'SELECT count(*)::int AS count FROM control_plane.credit_periods')).rows[0].count).toBe(0);
    expect(await migrate(ownerFactory, migrations)).toEqual([]);
  });

  it('creates one Individual identity concurrently, locks it with the restricted runtime role and keeps membership separate', async () => {
    const individuals = await Promise.all(Array.from({ length: 4 }, () => routing.individual('routing_owner')));
    expect(new Set(individuals.map(i => i.id)).size).toBe(1);
    const scope: AccountScope = { kind: 'individual', id: individuals[0].id };
    const snapshot = await routing.snapshot('routing_owner', scope, {});
    expect(snapshot).toMatchObject({ scope, legacy: false, canEditPreferences: true });
    await expect(routing.snapshot('routing_other', scope, {})).rejects.toMatchObject({ status: 403 });
    const org = await accounts.createOrganization('routing_owner', 'New fixture organization');
    expect((await runtime('SELECT kind FROM control_plane.billing_scopes WHERE id=$1', [org.id])).rows).toEqual([{ kind: 'organization' }]);
    expect((await runtime('SELECT id FROM control_plane.organizations WHERE id=$1', [scope.id])).rows).toEqual([]);
  });

  it('persists append-only customer consent across new service instances and refuses history rewrites', async () => {
    const scope: AccountScope = { kind: 'individual', id: (await routing.individual('routing_owner')).id };
    const input = { scope, baseRevision: 0, profile: 'strict', restrictions: STRICT_RESTRICTIONS, exceptions: [],
      consentVersion: 'NC-SETUP-2026-09-27.1', acknowledge: true };
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
