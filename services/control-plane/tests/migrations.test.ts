import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { migrate, type Migration } from '../src/migrations.js';
import type { SqlClient } from '../src/postgres.js';

const migrations: Migration[] = [
  { version: 1, name: 'accounts', sql: 'CREATE ACCOUNTS', sha256: 'a'.repeat(64) },
  { version: 2, name: 'commercial', sql: 'CREATE COMMERCIAL', sha256: 'b'.repeat(64) },
];

/** Protocol model only: it does not parse SQL or prove PostgreSQL semantics. */
function database(initial: Migration[] = [], fail?: string) {
  let state = initial.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
  let before = structuredClone(state);
  const calls: string[] = [];
  const client: SqlClient = {
    async connect() {},
    async query(sql, params = []) {
      calls.push(sql);
      if (sql === fail) throw new Error('interrupted migration');
      if (sql === 'BEGIN') before = structuredClone(state);
      if (sql === 'ROLLBACK') state = before;
      if (sql.includes('SELECT version, name, sha256')) return { rows: state, rowCount: state.length };
      if (sql.startsWith('INSERT INTO control_plane.schema_migrations')) state.push({ version: Number(params[0]), name: String(params[1]), sha256: String(params[2]) });
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  return { factory: () => client, calls, state: () => state };
}

describe('versioned migration protocol', () => {
  it('applies an empty database in a locked atomic transaction', async () => {
    const db = database();
    expect(await migrate(db.factory, migrations)).toEqual([1, 2]);
    expect(db.state()).toHaveLength(2);
    expect(db.calls.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });
  it('upgrades a prior version without replaying it and is idempotent', async () => {
    const db = database([migrations[0]]);
    expect(await migrate(db.factory, migrations)).toEqual([2]);
    expect(db.calls).not.toContain('CREATE ACCOUNTS');
    expect(await migrate(db.factory, migrations)).toEqual([]);
  });
  it('rolls back interruption, then retries the whole missing batch', async () => {
    const db = database([], 'CREATE COMMERCIAL');
    await expect(migrate(db.factory, migrations)).rejects.toThrow('interrupted migration');
    expect(db.state()).toEqual([]);
    expect(db.calls).toContain('ROLLBACK');
    const retry = database(db.state() as Migration[]);
    expect(await migrate(retry.factory, migrations)).toEqual([1, 2]);
  });
  it('rejects changed checksums, unknown versions and gaps', async () => {
    const changed = database([{ ...migrations[0], sha256: 'c'.repeat(64) }]);
    await expect(migrate(changed.factory, migrations)).rejects.toThrow('Migration history');
    await expect(migrate(database(migrations).factory, [migrations[0]])).rejects.toThrow('Migration history');
    await expect(migrate(database().factory, [migrations[1]])).rejects.toThrow('Migration sequence');
  });
});

describe('versioned migration source files', () => {
  const names = ['001_accounts.sql', '002_commercial.sql', '003_funded_jobs.sql', '004_usage_contract.sql', '005_customer_access.sql', '007_relay_devices.sql'];
  const load = () => Promise.all(names.map(async (name, index) => {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    return { version: index + 1, name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  }));

  it('are LF-only, contiguous and hash deterministically on every platform', async () => {
    const files = await load();
    for (const file of files) expect(file.sql.includes(String.fromCharCode(13))).toBe(false);
    const db = database();
    expect(await migrate(db.factory, files)).toEqual(files.map((file) => file.version));
  });

  it('003 extends the 002 funding seams without destroying data or granting public access', async () => {
    const [, , funded] = await load();
    expect(funded.sql).not.toMatch(/\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+SCHEMA)\b/i);
    expect(funded.sql).toMatch(/ALTER TABLE control_plane\.funding_reservations/);
    expect(funded.sql).toMatch(/ALTER TABLE control_plane\.funding_settlements/);
    for (const table of ['credit_periods', 'funded_jobs', 'funded_job_refs', 'job_cap_requests', 'credit_adjustments', 'credit_topups'])
      expect(funded.sql).toContain(`CREATE TABLE control_plane.${table}`);
    // A period is funded only from a verified entitlement grant, and a top-up
    // only from a verified billing event: no UI path can mint either.
    expect(funded.sql).toMatch(/REFERENCES control_plane\.entitlement_grants\(tenant_id,grant_id\)/);
    expect(funded.sql).toMatch(/REFERENCES control_plane\.webhook_inbox\(tenant_id,provider,event_id\)/);
    expect(funded.sql.trim().endsWith('REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;')).toBe(true);
  });

  it('004 records a usage class on every attempt and pins settled usage to nectovia-usage/1', async () => {
    const [, , , contract] = await load();
    expect(contract.sql).not.toMatch(/(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+SCHEMA|DEFAULT)/i);
    expect(contract.sql).toMatch(/ADD COLUMN usage_class text NOT NULL/);
    expect(contract.sql).toContain("usage_class IN ('included-chat','metered-work','worker','automation')");
    expect(contract.sql).toContain("usage->>'contract' = 'nectovia-usage/1'");
    expect(contract.sql.trim().endsWith('REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;')).toBe(true);
  });

  it('007 keeps a relay device a tombstone once revoked and stores only the public half of its key', async () => {
    const relay = (await load()).find((file) => file.name === '007_relay_devices.sql')!;
    expect(relay.sql).not.toMatch(/\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+SCHEMA)\b/i);
    expect(relay.sql).toContain('CREATE TABLE control_plane.relay_devices');
    for (const column of ['tenant_id', 'device_id', 'organization_id', 'person_id', 'public_key', 'label', 'created_at', 'revoked_at', 'revoked_by', 'last_seen_at'])
      expect(relay.sql).toMatch(new RegExp(`\\n  ${column} `));
    // A device belongs to one business within its own tenant, and is registered by a person.
    expect(relay.sql).toMatch(/FOREIGN KEY \(organization_id,tenant_id\) REFERENCES control_plane\.organizations\(id,tenant_id\)/);
    expect(relay.sql).toMatch(/person_id text NOT NULL REFERENCES control_plane\.persons\(id\)/);
    expect(relay.sql).toContain("public_key ~ '^[A-Za-z0-9_-]{43}$'");
    expect(relay.sql).toContain('CREATE TRIGGER relay_device_tombstone BEFORE UPDATE ON control_plane.relay_devices');
    // Only the public half of a key is ever stored here.
    expect(relay.sql).not.toMatch(/private_key|secret|password|credential|sealed/i);
    expect(relay.sql.trim().endsWith('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;')).toBe(true);
  });

  it('005 keeps grants revoke-once, policy and audit append-only, and binds credits to a feature grant', async () => {
    const [, , , , access] = await load();
    expect(access.sql).not.toMatch(/\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+SCHEMA)\b/i);
    for (const table of ['feature_grants', 'organization_access', 'invitation_codes', 'route_entries', 'tier_policies', 'operators', 'ops_audit', 'agent_admissions'])
      expect(access.sql).toContain(`CREATE TABLE control_plane.${table}`);
    // Monthly credits move from the Stripe-only grant table to the feature grant that funded them.
    expect(access.sql).toContain('DROP CONSTRAINT credit_periods_tenant_id_source_grant_id_fkey');
    expect(access.sql).toMatch(/REFERENCES control_plane\.feature_grants\(tenant_id,grant_id\)/);
    expect(access.sql).toContain('CREATE TRIGGER feature_grant_tombstone');
    expect(access.sql).toContain('CREATE TRIGGER tier_policy_append_only BEFORE UPDATE OR DELETE');
    expect(access.sql).toContain('CREATE TRIGGER ops_audit_append_only BEFORE UPDATE OR DELETE');
    // No credential column anywhere in the route registry.
    expect(access.sql).not.toMatch(/secret|api_key|password|credential/i);
    expect(access.sql.trim().endsWith('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;')).toBe(true);
  });
});
