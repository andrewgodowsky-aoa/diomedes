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
if (!/^\/b01_validation_[a-z0-9_]+$/.test(url.pathname)) throw new Error('This B01 candidate only migrates a disposable b01_validation_* database.');
if (!local && (url.hostname !== process.env.CP_TEST_EXPECTED_HOST || !url.hostname.endsWith('.neon.tech') ||
    !process.env.CP_TEST_BRANCH_ID?.startsWith('br-') || process.env.CP_TEST_BRANCH_ID === 'br-old-star-aepf7zk6' ||
    process.env.CP_APPROVED_ISOLATED_BRANCH !== 'yes'))
  throw new Error('An approved isolated branch and pinned endpoint are required; production migration is not enabled.');
const factory = local ? () => new pg.Client({ connectionString, connectionTimeoutMillis: 5000 })
  : () => new NeonClient({ connectionString, connectionTimeoutMillis: 5000 });
const migrations = await Promise.all(['001_accounts.sql','002_commercial.sql','003_funded_jobs.sql','004_usage_contract.sql'].map(async (name, index) => {
  const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  return { version: index + 1, name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
}));
try {
  console.log(JSON.stringify({ applied: await migrate(factory, migrations) }));
} catch {
  // The connection URL and raw PostgreSQL error text must not enter CI logs.
  console.error('Migration refused or failed. Inspect the approved database with its operator.');
  process.exitCode = 1;
}
