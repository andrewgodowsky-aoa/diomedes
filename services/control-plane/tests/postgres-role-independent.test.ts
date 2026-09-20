import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Client } from '@neondatabase/serverless';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { PostgresRepository, neonClientFactory } from '../src/postgres.js';
import { createHandler } from '../src/worker.js';
import { now, validEnv, verifier } from './support/fixtures.js';

const ownerUrl = process.env.CP_TEST_DATABASE_URL;
let runtimeUrl: string;
let accounts: AccountService;

async function query(connectionString: string, sql: string) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 6000 });
  await client.connect();
  try { return await client.query(sql); } finally { await client.end(); }
}

describe.skipIf(!ownerUrl)('Independent real Neon runtime role qualification', () => {
  beforeAll(async () => {
    const parsed = new URL(ownerUrl!);
    if (process.env.CP_APPROVED_ISOLATED_BRANCH !== 'yes' ||
        process.env.CP_TEST_ALLOW_SCHEMA_RESET !== 'yes' ||
        !process.env.CP_TEST_BRANCH_ID?.startsWith('br-') ||
        process.env.CP_TEST_BRANCH_ID === 'br-old-star-aepf7zk6' ||
        parsed.hostname !== process.env.CP_TEST_EXPECTED_HOST ||
        !parsed.hostname.endsWith('.neon.tech') ||
        !/^\/b01_validation_[a-z0-9_]+$/.test(parsed.pathname))
      throw new Error('An explicitly pinned disposable Neon database is required.');
    // The complete original migration/concurrency suite must run first.
    const migrated = await query(ownerUrl!, 'SELECT count(*)::int AS count FROM control_plane.schema_migrations');
    expect(migrated.rows[0].count).toBe(2);
    const password = randomBytes(32).toString('hex');
    const role = `cp_runtime_${randomBytes(6).toString('hex')}`;
    // Fixture-only role; no existing role is altered or granted to this login.
    await query(ownerUrl!, `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    const permissions = await readFile(new URL('../scripts/runtime-permissions.sql', import.meta.url), 'utf8');
    await query(ownerUrl!, permissions.replace(/\bcp_runtime\b/g, role));
    parsed.username = role;
    parsed.password = password;
    runtimeUrl = parsed.href;
    accounts = new AccountService(new PostgresRepository(neonClientFactory(runtimeUrl)), verifier, { now: () => now });
  });

  it('executes account creation, invitations, membership changes and revocation through the restricted role', async () => {
    const org = await accounts.createOrganization('role_alice', 'Restricted role qualification');
    const invite = await accounts.invite('role_alice', org.id, { subject: 'user_role_bob', role: 'member', ttlMs: 5000 });
    await accounts.acceptInvitation('role_bob', org.id, invite.token);
    const bob = await accounts.signIn('role_bob');
    await accounts.setMembership('role_alice', org.id, bob.person.id, { role: 'admin', state: 'active' });
    expect((await accounts.membership('role_bob', org.id)).membership.role).toBe('admin');
    const handler = createHandler(() => accounts);
    const response = await handler(new Request('https://account.test/account/session', {
      headers: { Authorization: 'Bearer role_bob', Origin: 'http://127.0.0.1:8791' },
    }), { ...validEnv, DATABASE_URL: runtimeUrl });
    expect(response.status).toBe(200);
    await accounts.revokeLocalSession('role_bob');
    await expect(accounts.signIn('role_bob')).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    ['schema creation', 'CREATE SCHEMA forbidden_runtime_schema'],
    ['table creation', 'CREATE TABLE control_plane.forbidden_runtime_table(id integer)'],
    ['person deletion', 'DELETE FROM control_plane.persons WHERE false'],
    ['history truncation', 'TRUNCATE control_plane.account_events'],
    ['migration mutation', 'UPDATE control_plane.schema_migrations SET name=name WHERE false'],
    ['commercial mutation', 'DELETE FROM control_plane.billing_customers WHERE false'],
    ['commercial reads', 'SELECT * FROM control_plane.billing_customers LIMIT 1'],
  ])('refuses %s with PostgreSQL insufficient_privilege', async (_name, sql) => {
    await expect(query(runtimeUrl, sql)).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps the runtime login unprivileged and without role memberships', async () => {
    const flags = await query(runtimeUrl, 'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(flags.rows).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]);
    const memberships = await query(runtimeUrl, 'SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');
    expect(memberships.rows).toEqual([]);
  });
});
