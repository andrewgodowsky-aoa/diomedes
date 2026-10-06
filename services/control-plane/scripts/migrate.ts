import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { Client as NeonClient } from '@neondatabase/serverless';
import { migrate } from '../src/migrations.js';

const connectionString = process.env.CP_MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('Set CP_MIGRATION_DATABASE_URL through the approved secret channel.');
const url = new URL(connectionString);
const local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
if (url.hostname.includes('-pooler')) throw new Error('Migrations require the direct database endpoint.');
// Two targets. A disposable b01_validation_* database for qualification runs, or
// the company staging database, accounts_staging, that accounts.diomedes.net
// serves. Each needs its own pinned host and approval. Production is not enabled.
if (process.env.CP_MIGRATION_TARGET === 'staging') {
  if (url.pathname !== '/accounts_staging' || !url.hostname.endsWith('.neon.tech') ||
      url.hostname !== process.env.CP_STAGING_EXPECTED_HOST || process.env.CP_APPROVED_STAGING !== 'yes')
    throw new Error('Staging migrates only accounts_staging on the pinned Neon host, with CP_APPROVED_STAGING=yes.');
} else {
  if (!/^\/b01_validation_[a-z0-9_]+$/.test(url.pathname)) throw new Error('This B01 candidate only migrates a disposable b01_validation_* database.');
  if (!local && (url.hostname !== process.env.CP_TEST_EXPECTED_HOST || !url.hostname.endsWith('.neon.tech') ||
      !process.env.CP_TEST_BRANCH_ID?.startsWith('br-') || process.env.CP_TEST_BRANCH_ID === 'br-old-star-aepf7zk6' ||
      process.env.CP_APPROVED_ISOLATED_BRANCH !== 'yes'))
    throw new Error('An approved isolated branch and pinned endpoint are required; production migration is not enabled.');
}
const factory = local ? () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000 })
  : () => new NeonClient({ connectionString, connectionTimeoutMillis: 5000 });
const migrations = await Promise.all(['001_accounts.sql','002_commercial.sql','003_funded_jobs.sql','004_usage_contract.sql','005_customer_access.sql','006_staff_keys.sql','007_relay_devices.sql','008_organization_setup.sql','009_individual_plans.sql','010-scoped-routing.sql','011_individual_funding.sql','012_individual_subscription_periods.sql','013_purchased_usage_holds.sql','014_member_credit_limits.sql','015_credit_purchases.sql','017_stripe_billing_foundation.sql'].map(async (name) => {
  const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  // The version is the file name's number, so 013 is refused until 011 and 012 are in the list before it,
  // and 015 until 014 is too. 017 is likewise refused until 016 (draft #196) is in the list before it: this runner will not
  // apply it, and so will not apply anything, until that file is here.
  return { version: Number(name.slice(0, 3)), name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
}));
try {
  console.log(JSON.stringify({ applied: await migrate(factory, migrations) }));
} catch {
  // The connection URL and raw PostgreSQL error text must not enter CI logs.
  console.error('Migration refused or failed. Inspect the approved database with its operator.');
  process.exitCode = 1;
}
