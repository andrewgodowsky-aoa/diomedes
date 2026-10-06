import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Client } from '@neondatabase/serverless';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { PostgresRepository, neonClientFactory } from '../src/postgres.js';
import { createHandler } from '../src/worker.js';
import { OrganizationSetupService } from '../src/organization-setup/service.js';
import { PostgresOrganizationSetupRepository } from '../src/organization-setup/postgres.js';
import { PostgresOrganizationExportRepository } from '../src/organization-export/postgres.js';
import type { OrganizationSetupRecord } from '../../../shared/organization-setup.js';
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
    // The complete original migration/concurrency suite must run first, and must have applied every migration.
    const files = (await readdir(new URL('../migrations/', import.meta.url))).filter((name) => /^\d{3}[-_][a-z0-9_-]+\.sql$/.test(name));
    const migrated = await query(ownerUrl!, 'SELECT count(*)::int AS count FROM control_plane.schema_migrations');
    expect(migrated.rows[0].count).toBe(files.length);
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

  it('reads and appends business setup revisions through the restricted role (ORG-01)', async () => {
    const org = await accounts.createOrganization('role_carol', 'Restricted setup qualification');
    const carol = (await accounts.signIn('role_carol')).person.id;
    const setups = new OrganizationSetupService(accounts, new PostgresOrganizationSetupRepository(neonClientFactory(runtimeUrl)), { now: () => now });
    const at = new Date(now).toISOString();
    const record: OrganizationSetupRecord = {
      v: 1,
      setup: {
        v: 1, organizationId: org.id, tenantId: org.tenantId, schemaRevision: 1, state: 'drafting', answers: {},
        cursor: 'name', startedAt: at, startedBy: carol, updatedAt: at, proposalDigest: null,
      },
    };
    expect((await setups.write('role_carol', org.id, { expectedRevision: 0, record })).revision).toBe(1);
    expect(await setups.read('role_carol', org.id)).toMatchObject({ revision: 1, writtenBy: carol });
    const exports = new PostgresOrganizationExportRepository(neonClientFactory(runtimeUrl));
    await exports.transaction(async (tx) => {
      expect((await tx.member(org.id, carol))?.record.role).toBe('owner');
      expect(await tx.setupRevisions(org.id)).toMatchObject([{ revision: 1, writtenBy: carol, record }]);
      expect((await tx.history(org.id, 10)).length).toBeGreaterThan(0);
    });
  });

  it.each([
    ['schema creation', 'CREATE SCHEMA forbidden_runtime_schema'],
    ['table creation', 'CREATE TABLE control_plane.forbidden_runtime_table(id integer)'],
    ['person deletion', 'DELETE FROM control_plane.persons WHERE false'],
    ['history truncation', 'TRUNCATE control_plane.account_events'],
    ['migration mutation', 'UPDATE control_plane.schema_migrations SET name=name WHERE false'],
    ['commercial mutation', 'DELETE FROM control_plane.billing_customers WHERE false'],
    // The credit purchase receiver stores customers and verified events on this login (SELECT, INSERT), never rewrites or removes one.
    ['customer rewrite', 'UPDATE control_plane.billing_customers SET customer_id=customer_id WHERE false'],
    // The one thing it may move on an inbox row is its state and processed_at (016's markEvent); the rest of the row is written once.
    ['inbox payload rewrite', 'UPDATE control_plane.webhook_inbox SET payload=payload WHERE false'],
    ['inbox customer rewrite', 'UPDATE control_plane.webhook_inbox SET customer_id=customer_id WHERE false'],
    ['inbox environment rewrite', 'UPDATE control_plane.webhook_inbox SET environment=environment WHERE false'],
    ['inbox removal', 'DELETE FROM control_plane.webhook_inbox WHERE false'],
    ['commercial reads', 'SELECT * FROM control_plane.subscriptions LIMIT 1'],
    ['setup rewrite', 'UPDATE control_plane.organization_setups SET revision=revision WHERE false'],
    ['setup removal', 'DELETE FROM control_plane.organization_setups WHERE false'],
  ])('refuses %s with PostgreSQL insufficient_privilege', async (_name, sql) => {
    await expect(query(runtimeUrl, sql)).rejects.toMatchObject({ code: '42501' });
  });

  it('lets the runtime login mark the state of an inbox event, which 016 grants it, and no other column', async () => {
    await expect(query(runtimeUrl, 'UPDATE control_plane.webhook_inbox SET state=state, processed_at=processed_at WHERE false')).resolves.toBeDefined();
  });

  it('keeps the runtime login unprivileged and without role memberships', async () => {
    const flags = await query(runtimeUrl, 'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(flags.rows).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]);
    const memberships = await query(runtimeUrl, 'SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');
    expect(memberships.rows).toEqual([]);
  });
});
