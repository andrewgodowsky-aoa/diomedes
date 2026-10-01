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
  const names = ['001_accounts.sql', '002_commercial.sql', '003_funded_jobs.sql', '004_usage_contract.sql', '005_customer_access.sql', '006_staff_keys.sql', '007_relay_devices.sql', '008_organization_setup.sql', '009_individual_plans.sql', '010-scoped-routing.sql','011_individual_funding.sql','012_individual_subscription_periods.sql','013_purchased_usage_holds.sql','014_member_credit_limits.sql'];
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

  it('008 keeps every business setup revision, once, for its own business, and holds no credentials', async () => {
    const setup = (await load()).find((file) => file.name === '008_organization_setup.sql')!;
    expect(setup.sql).not.toMatch(/\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+SCHEMA|ALTER\s+TABLE)\b/i);
    expect(setup.sql).toContain('CREATE TABLE control_plane.organization_setups');
    for (const column of ['tenant_id', 'organization_id', 'revision', 'record', 'written_at', 'written_by'])
      expect(setup.sql).toMatch(new RegExp(`\\n  ${column} `));
    // One row per business and revision: the key is the compare-and-set.
    expect(setup.sql).toContain('PRIMARY KEY (tenant_id,organization_id,revision)');
    expect(setup.sql).toMatch(/FOREIGN KEY \(organization_id,tenant_id\) REFERENCES control_plane\.organizations\(id,tenant_id\)/);
    expect(setup.sql).toMatch(/written_by text NOT NULL REFERENCES control_plane\.persons\(id\)/);
    // The record names its own business, and a revision is never rewritten or removed.
    expect(setup.sql).toContain("record->'setup'->>'organizationId' = organization_id");
    expect(setup.sql).toContain('CREATE TRIGGER organization_setup_append_only BEFORE UPDATE OR DELETE ON control_plane.organization_setups');
    // No column or statement holds a secret (the comments may say so; the SQL may not).
    expect(setup.sql.replace(/--.*$/gm, '')).not.toMatch(/private_key|password|credential|sealed|api_key|token/i);
    expect(setup.sql.trim().endsWith('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;')).toBe(true);
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

  it('006 stores staff keys as hashes only, withdrawn once, with no key column', async () => {
    const [, , , , , keys] = await load();
    expect(keys.sql).not.toMatch(/\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+SCHEMA|GRANT)\b/i);
    expect(keys.sql).toContain('CREATE TABLE control_plane.staff_keys');
    expect(keys.sql).toContain("key_hash text PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$')");
    expect(keys.sql).toContain("CHECK (key_id = 'staff_key_' || left(key_hash, 16))");
    expect(keys.sql).toContain('CREATE TRIGGER staff_key_tombstone BEFORE UPDATE');
    expect(keys.sql).not.toMatch(/\bkey text|secret|password/i);
    expect(keys.sql.trim().endsWith('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;')).toBe(true);
  });

  it('009 issues Individual grants to a person, revoke-once, and keeps personal admissions apart from a business', async () => {
    const individual = (await load()).find((file) => file.name === '009_individual_plans.sql')!;
    expect(individual.version).toBe(9);
    expect(individual.sql).not.toMatch(/\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+SCHEMA|ALTER\s+TABLE)\b/i);
    for (const table of ['person_feature_grants', 'person_access', 'personal_agent_admissions'])
      expect(individual.sql).toContain(`CREATE TABLE control_plane.${table}`);
    // A person's grant names a person, never an organization; the existing admissions table is untouched.
    expect(individual.sql).toMatch(/person_id text NOT NULL REFERENCES control_plane\.persons\(id\)/);
    expect(individual.sql).not.toMatch(/\n  organization_id |REFERENCES control_plane\.organizations/);
    expect(individual.sql).toContain('CREATE TRIGGER person_feature_grant_tombstone BEFORE UPDATE');
    expect(individual.sql).toContain('CREATE TRIGGER personal_agent_admission_append_only BEFORE UPDATE OR DELETE');
    expect(individual.sql).toMatch(/Code and tests only: no production\s+-- migration/);
    expect(individual.sql.trim().endsWith('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;')).toBe(true);
  });

  it('keeps the applied Individual migration immutable and upgrades its exact history with additive routing and funding migrations', async () => {
    const files = await load();
    expect(files[8]).toMatchObject({ version: 9, name: '009_individual_plans.sql',
      sha256: '540f7bb22cc183175984fcdcf8e82718a7b093ec77d09329656ddd68196e5886' });
    expect(files[9]).toMatchObject({ version: 10, name: '010-scoped-routing.sql' });
    const db = database(files.slice(0, 9));
    expect(await migrate(db.factory, files)).toEqual([10, 11, 12, 13, 14]);
    expect(db.calls).not.toContain(files[8].sql);
    expect(await migrate(db.factory, files)).toEqual([]);
  });

  it('012 adds Individual anniversary periods additively, after an unchanged 011', async () => {
    const files = await load();
    expect(files[10]).toMatchObject({ version: 11, name: '011_individual_funding.sql',
      sha256: createHash('sha256').update(await readFile(new URL('../migrations/011_individual_funding.sql', import.meta.url), 'utf8')).digest('hex') });
    const periods = files[11];
    expect(periods).toMatchObject({ version: 12, name: '012_individual_subscription_periods.sql' });
    // An 011 database upgrades to 012 without replaying anything earlier.
    const db = database(files.slice(0, 11));
    expect(await migrate(db.factory, files)).toEqual([12, 13, 14]);
    expect(db.calls).not.toContain(files[10].sql);
    expect(periods.sql.replace(/--.*$/gm, '')).not.toMatch(/\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+SCHEMA|UPDATE\s+control_plane)/i);
    expect(periods.sql).not.toMatch(/^\s*GRANT\b/im);
    // Historical calendar ids stay valid; only an Individual row may use the term form.
    expect(periods.sql).toContain("period_id ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'");
    expect(periods.sql).toContain("plan_id='individual' AND period_id ~ '^individual:");
    // The term is the one its source grant names, recorded inside it, and never overlaps another.
    expect(periods.sql).toContain("record->'billingCycle'");
    expect(periods.sql).toContain('NEW.allocated_at < NEW.starts_at OR NEW.allocated_at >= NEW.ends_at');
    expect(periods.sql).toContain('Individual billing periods may not overlap');
    expect(periods.sql).toContain('pg_advisory_xact_lock');
    // A hold is never sent after its Individual period ends; re-saving an old hold is never blocked.
    expect(periods.sql).toContain('CREATE TRIGGER individual_reservation_period BEFORE INSERT OR UPDATE OF dispatched_at ON control_plane.funding_reservations');
    expect(periods.sql).toContain('NEW.dispatched_at >= funded.ends_at');
    // Narrow, fixed-path functions with no public execution.
    expect(periods.sql.match(/SET search_path=pg_catalog/g)).toHaveLength(3);
    expect(periods.sql.trim().endsWith('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;')).toBe(true);
  });
});

describe('014 monthly credit limits for members', () => {
  const load = () => readFile(new URL('../migrations/014_member_credit_limits.sql', import.meta.url), 'utf8');

  it('is LF-only, additive, and leaves every earlier table as it was', async () => {
    const sql = await load();
    expect(sql.includes(String.fromCharCode(13))).toBe(false);
    expect(sql).not.toMatch(/\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+SCHEMA|ALTER\s+TABLE|UPDATE\s+control_plane)\b/i);
    expect([...sql.matchAll(/CREATE TABLE control_plane\.(\w+)/g)].map((match) => match[1]).sort())
      .toEqual(['credit_allotment_settings', 'credit_attempt_people', 'credit_limit_requests', 'credit_member_limits']);
    expect(sql.trim().endsWith('REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;')).toBe(true);
  });

  it('stores no credit figure nobody decided, and constrains what a limit and a request can be', async () => {
    const sql = await load();
    // Comments may say the word; no column carries a default value.
    expect(sql.replace(/--.*/g, '')).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).toMatch(/limit_micro_usd bigint CHECK \(limit_micro_usd BETWEEN 0 AND 9007199254740991\)/);
    // A limit row names a role or a person, and a limit has a number only when its mode is a limit.
    expect(sql).toContain("subject_kind text NOT NULL CHECK (subject_kind IN ('role','person'))");
    expect(sql).toContain("CHECK ((mode = 'limit') = (limit_micro_usd IS NOT NULL))");
    // A request is decided once, and sized only when approved.
    expect(sql).toContain("CHECK ((state = 'approved') = (extra_micro_usd IS NOT NULL))");
    expect(sql).toContain("CHECK (state = 'approved' OR allow_purchased = false)");
    // The hot funding tables are not altered: a person is recorded in a side table.
    expect(sql).toMatch(/CREATE TABLE control_plane\.credit_attempt_people[\s\S]*REFERENCES control_plane\.funding_reservations\(tenant_id,reservation_id\)/);
    // Every row belongs to one business within its own tenant.
    expect([...sql.matchAll(/FOREIGN KEY \(organization_id,tenant_id\) REFERENCES control_plane\.organizations\(id,tenant_id\)/g)]).toHaveLength(4);
  });
});
