/**
 * The billing foundation's schema and reserved actor (slice 1, 2026-10-05): migration 017's text, where the runner
 * will and will not apply it, the reserved billing-system actor, and the retired single price.
 *
 * These are static checks and a protocol model of the runner. They do not run the SQL: no PostgreSQL is used here.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate, type Migration } from '../src/migrations.js';
import type { SqlClient } from '../src/postgres.js';
import { BILLING_SYSTEM_ACTOR, BILLING_SYSTEM_NAME, BILLING_SYSTEM_ROLE, isBillingSystemActor } from '../src/billing-system.js';
import { addStaffInput, auditEventSchema, featureGrantSchema } from '../src/commercial.js';

const MIGRATION = '017_stripe_billing_foundation.sql';
const sql = () => readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8');
/** The statements, with the comments taken off. */
const code = () => sql().replace(/--.*$/gm, '');

/** Protocol model only (as tests/migrations.test.ts): it does not parse SQL or prove PostgreSQL semantics. */
function database(initial: Migration[] = []) {
  const state = initial.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
  const calls: string[] = [];
  const client: SqlClient = {
    async connect() {},
    async query(text, params = []) {
      calls.push(text);
      if (text.includes('SELECT version, name, sha256')) return { rows: state, rowCount: state.length };
      if (text.startsWith('INSERT INTO control_plane.schema_migrations')) state.push({ version: Number(params[0]), name: String(params[1]), sha256: String(params[2]) });
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  return { factory: () => client, calls, state };
}

const NAMES = ['001_accounts.sql', '002_commercial.sql', '003_funded_jobs.sql', '004_usage_contract.sql', '005_customer_access.sql', '006_staff_keys.sql', '007_relay_devices.sql',
  '008_organization_setup.sql', '009_individual_plans.sql', '010-scoped-routing.sql', '011_individual_funding.sql', '012_individual_subscription_periods.sql',
  '013_purchased_usage_holds.sql', '014_member_credit_limits.sql', '015_credit_purchases.sql'];
const loadThrough015 = () => Promise.all(NAMES.map(async (name, index) => {
  const text = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  return { version: index + 1, name, sql: text, sha256: createHash('sha256').update(text).digest('hex') } satisfies Migration;
}));
const m017 = (): Migration => ({ version: 17, name: MIGRATION, sql: sql(), sha256: createHash('sha256').update(sql()).digest('hex') });
const standIn016: Migration = { version: 16, name: '016_stand_in_for_draft_196.sql', sql: 'SELECT 1', sha256: 'c'.repeat(64) };

describe('migration 017', () => {
  it('is LF only, ends by revoking public access, and names no destructive statement', () => {
    expect(sql().includes(String.fromCharCode(13))).toBe(false);
    expect(sql().trim().endsWith('REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;')).toBe(true);
    // Constraints it replaces are dropped by name found at run time; no table, row or schema is removed.
    expect(code()).not.toMatch(/\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+SCHEMA|DROP\s+COLUMN)\b/i);
    expect(sql()).toMatch(/no production migration is\s+-- authorized/);
    // Nothing is granted: privileges stay in scripts/runtime-permissions.sql and scripts/funding-permissions.sql.
    expect(code()).not.toMatch(/^\s*GRANT\b/im);
  });

  it('adds environment (test or live) to the customer, the inbox and the purchase, with existing rows backfilled to test', () => {
    for (const table of ['billing_customers', 'webhook_inbox', 'credit_purchases'])
      expect(code()).toContain(`ALTER TABLE control_plane.${table} ADD COLUMN environment text NOT NULL DEFAULT 'test' CHECK (environment IN ('test','live'));`);
  });

  it('makes a business\'s customer unique per environment, replacing the old unique found by its columns', () => {
    expect(code()).toContain('UNIQUE (provider, environment, organization_id)');
    expect(code()).toContain("ARRAY['organization_id','provider']");
    expect(code()).toContain('DROP CONSTRAINT %I');
  });

  it('adds ignored to the inbox states, lets an event carry no business (all three columns or none), and keeps processed_at only for processed', () => {
    expect(code()).toContain("CHECK (state IN ('pending','processed','quarantined','ignored'))");
    for (const column of ['customer_id', 'organization_id', 'tenant_id'])
      expect(code()).toContain(`ALTER TABLE control_plane.webhook_inbox ALTER COLUMN ${column} DROP NOT NULL;`);
    expect(code()).toContain('(customer_id IS NULL) = (organization_id IS NULL) AND (customer_id IS NULL) = (tenant_id IS NULL)');
    // 002's own check ties processed_at to the processed state; this file only replaces the state list.
    expect(code()).not.toMatch(/processed_at/);
  });

  it('stores the rate on the purchase, backfills 015\'s rows at 100 credits a step, and ties credits, rate and amount together', () => {
    expect(code()).toContain('ADD COLUMN rate_cents integer;');
    expect(code()).toContain('ADD COLUMN rate_credits integer;');
    expect(code()).toContain('SET rate_credits = 100, rate_cents = (amount_cents / (credits / 100))::integer');
    expect(code()).toContain('ALTER COLUMN rate_cents SET NOT NULL;');
    expect(code()).toContain('ALTER COLUMN rate_credits SET NOT NULL;');
    expect(code()).toContain('CHECK (credits % rate_credits = 0 AND amount_cents = (credits / rate_credits)::bigint * rate_cents)');
    // No float anywhere in the money arithmetic.
    expect(code()).not.toMatch(/\b(numeric|real|double precision|float)\b|\bROUND\s*\(/i);
  });

  it('creates the reserved billing-system person once, with no subject, membership or operator row', () => {
    expect(code()).toContain("INSERT INTO control_plane.persons(id, record)");
    expect(code()).toContain("'billing-system'");
    expect(code()).toContain('ON CONFLICT (id) DO NOTHING');
    expect(code()).not.toMatch(/external_subjects|memberships|operators|sessions/);
    const record = JSON.parse(/'(\{"v":1,"id":"billing-system"[^']*\})'::jsonb/.exec(code())![1]);
    expect(record).toMatchObject({ id: BILLING_SYSTEM_ACTOR, name: BILLING_SYSTEM_NAME });
  });
});

describe('where the runner applies 017', () => {
  it('lists 017 after 015 in the migrate script, and the script says it waits for 016', () => {
    const script = readFileSync(new URL('../scripts/migrate.ts', import.meta.url), 'utf8');
    expect(script).toContain("'015_credit_purchases.sql','017_stripe_billing_foundation.sql']");
    expect(script).toMatch(/017 is likewise refused until 016 \(draft #196\)/);
  });

  it('has no 016 file here, and the number is kept for draft #196', () => {
    expect(readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.startsWith('016'))).toEqual([]);
  });

  it('refuses 017 as the sixteenth entry: with 016 absent the runner will not apply it, or anything', async () => {
    const files = [...(await loadThrough015()), m017()];
    const db = database();
    await expect(migrate(db.factory, files)).rejects.toThrow('Migration sequence');
    // It refused before opening a transaction: nothing ran, nothing was recorded.
    expect(db.calls).toEqual([]);
    expect(db.state).toEqual([]);
  });

  it('applies 017 once a 016 is listed before it, and an 015 database upgrades by 016 and 017 only', async () => {
    const through015 = await loadThrough015();
    const files = [...through015, standIn016, m017()];
    expect(await migrate(database().factory, files)).toEqual(Array.from({ length: 17 }, (_, index) => index + 1));
    const db = database(through015);
    expect(await migrate(db.factory, files)).toEqual([16, 17]);
    expect(db.calls).not.toContain(through015[14].sql);
    expect(db.calls).toContain(sql());
  });

  it('cannot take 016 after 017: a database that applied 017 first refuses the list that adds 016 (016 must land first)', async () => {
    const through015 = await loadThrough015();
    // The state of a database that was migrated by a runner that let 017 follow 015, then gets the list with 016 in its place.
    const first = database([...through015, m017()]);
    await expect(migrate(first.factory, [...through015, standIn016, m017()])).rejects.toThrow('Migration history');
    expect(first.calls.filter((text) => text === 'SELECT 1')).toEqual([]);
  });
});

describe('the billing system actor', () => {
  it('is one reserved id, in the audit role billing, and nothing else is it', () => {
    expect(BILLING_SYSTEM_ACTOR).toBe('billing-system');
    expect(BILLING_SYSTEM_ROLE).toBe('billing');
    expect(isBillingSystemActor('billing-system')).toBe(true);
    for (const other of ['billing', 'billing-system ', 'Billing-System', 'person_1', '']) expect(isBillingSystemActor(other), other).toBe(false);
  });

  it('is accepted as issuedBy on a grant and as the actor of an audit row', () => {
    const grant = {
      v: 1, id: 'grant_1', organizationId: 'org_1', tenantId: 'tenant_1', planId: 'business', features: ['managed-inference'], source: 'internal-test',
      reference: 'sub_1', note: 'Paid period', validFrom: '2026-10-01T00:00:00.000Z', validUntil: '2026-11-01T00:00:00.000Z', state: 'active',
      issuedAt: '2026-10-01T00:00:00.000Z', issuedBy: BILLING_SYSTEM_ACTOR, revokedAt: null, revokedBy: null, revokedReason: null,
    };
    expect(featureGrantSchema.safeParse(grant).success).toBe(true);
    const audit = {
      id: 'audit_1', at: '2026-10-01T00:00:00.000Z', actorPersonId: BILLING_SYSTEM_ACTOR, actorRole: BILLING_SYSTEM_ROLE, action: 'grant.issued',
      organizationId: 'org_1', targetKind: 'grant', targetId: 'grant_1', reason: 'A paid period', detail: {},
    };
    expect(auditEventSchema.safeParse(audit).success).toBe(true);
  });

  it('is never added to the staff directory: it is an actor, not a person on the billing team', () => {
    expect(addStaffInput.safeParse({ personId: BILLING_SYSTEM_ACTOR, role: 'billing' }).success).toBe(false);
    expect(addStaffInput.safeParse({ personId: 'person_1', role: 'billing' }).success).toBe(true);
  });
});

describe('the retired single price', () => {
  it('is named nowhere in the account service, the shared code, the desktop client or the server', () => {
    // Built by concatenation so this file does not name it either.
    const retired = ['CREDIT_PRICE', 'CENTS_PER_100'].join('_');
    const roots = ['../src/', '../scripts/', '../README.md', '../../../shared/', '../../../server/', '../../../client/'];
    const walk = (path: string): string[] => {
      let entries;
      try { entries = readdirSync(path, { withFileTypes: true }); } catch { return [path]; }
      return entries.flatMap((entry) => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]);
    };
    const files = roots.flatMap((root) => walk(fileURLToPath(new URL(root, import.meta.url))));
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) if (/\.(ts|tsx|md|sql|json)$/.test(file)) expect(readFileSync(file, 'utf8'), file).not.toContain(retired);
  });
});
