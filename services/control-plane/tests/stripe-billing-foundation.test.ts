/**
 * The billing foundation's schema and reserved actor (slice 1, 2026-10-05): migration 016's text, where the runner
 * applies it, the reserved billing-system actor, and the retired single price.
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
import { accountStateSchema, emptyAccountState } from '../src/domain.js';
import { BILLING_SYSTEM_ACTOR, BILLING_SYSTEM_NAME, BILLING_SYSTEM_ROLE, isBillingSystemActor } from '../src/billing-system.js';
import { addStaffInput, auditEventSchema, featureGrantSchema } from '../src/commercial.js';

const MIGRATION = '016_stripe_billing_foundation.sql';
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
const m016 = (): Migration => ({ version: 16, name: MIGRATION, sql: sql(), sha256: createHash('sha256').update(sql()).digest('hex') });

describe('migration 016', () => {
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

describe('where the runner applies 016', () => {
  it('lists 016 in the migrate script, directly after 015', () => {
    const script = readFileSync(new URL('../scripts/migrate.ts', import.meta.url), 'utf8');
    expect(script).toContain("'015_credit_purchases.sql','016_stripe_billing_foundation.sql'");
  });

  it('is the only 016 file here', () => {
    expect(readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.startsWith('016'))).toEqual([MIGRATION]);
  });

  it('applies after 015: a new database takes 1 to 16, and an 015 database upgrades by 016 only', async () => {
    const through015 = await loadThrough015();
    const files = [...through015, m016()];
    expect(await migrate(database().factory, files)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
    const db = database(through015);
    expect(await migrate(db.factory, files)).toEqual([16]);
    expect(db.calls).not.toContain(through015[14].sql);
    expect(db.calls).toContain(sql());
  });
});

describe('the billing system actor', () => {
  it('has a persons record the account store parses and the table\'s own checks accept', () => {
    const record = JSON.parse(/'(\{"v":1,"id":"billing-system"[^']*\})'::jsonb/.exec(code())![1]);
    expect(Object.keys(record).sort()).toEqual(['assurance', 'createdAt', 'id', 'name', 'v']);
    expect(record.assurance).toBe('hosted');
    // The person record itself parses. The in-memory account state also requires every person to have an external subject, which the
    // actor must never have, so a faux store would refuse a whole state that held it: slice 1 does not put it in a faux store.
    expect(accountStateSchema.shape.persons.element.safeParse(record).success).toBe(true);
    expect(accountStateSchema.safeParse({ ...emptyAccountState(), persons: [record] }).success).toBe(false);
  });

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
