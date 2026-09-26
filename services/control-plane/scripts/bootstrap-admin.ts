/**
 * npm run bootstrap-admin -- --subject user_...
 *
 * Makes the first Diomedes admin on the staging account service. Staff
 * administration needs an admin to add anyone, so the first one is written here,
 * by the database operator, never by a route. Everyone after is added in the
 * Diomedes Operations app by that admin.
 *
 *   1. Sign in once in the Operations app (company build). It refuses you as
 *      "not a Diomedes staff account" and shows your WorkOS user id (user_...).
 *   2. Run this with that id, the owner connection in CP_MIGRATION_DATABASE_URL
 *      and the same staging pins the migration uses:
 *        CP_MIGRATION_TARGET=staging CP_STAGING_EXPECTED_HOST=<direct host> CP_APPROVED_STAGING=yes
 *
 * Refused when an active admin already exists, or when that person has never
 * signed in. Audited as a staff change, like every other one.
 */
import { neonClientFactory, PostgresRepository } from '../src/postgres.js';
import { PostgresCommercialRepository } from '../src/commercial-postgres.js';
import { bootstrapFirstAdmin } from '../src/commercial.js';
import { AccountError } from '../src/errors.js';

const WORKOS_ISSUER = 'https://api.workos.com';
const args = process.argv.slice(2);
const subject = args[args.indexOf('--subject') + 1];
if (!args.includes('--subject') || !/^user_[A-Za-z0-9]{1,120}$/.test(subject ?? ''))
  throw new Error('Pass --subject with the WorkOS user id (user_...) the Operations app showed.');

const connectionString = process.env.CP_MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('Set CP_MIGRATION_DATABASE_URL through the approved secret channel.');
const url = new URL(connectionString);
if (process.env.CP_MIGRATION_TARGET !== 'staging' || url.pathname !== '/accounts_staging' || url.hostname.includes('-pooler') ||
    !url.hostname.endsWith('.neon.tech') || url.hostname !== process.env.CP_STAGING_EXPECTED_HOST || process.env.CP_APPROVED_STAGING !== 'yes')
  throw new Error('Bootstrap runs only on accounts_staging, over the pinned direct Neon host, with CP_APPROVED_STAGING=yes.');

const factory = neonClientFactory(connectionString);
try {
  const mapping = await new PostgresRepository(factory).transaction((tx) => tx.subject(WORKOS_ISSUER, subject));
  if (!mapping) throw new AccountError(404, 'That WorkOS user has not signed in to the account service yet. Sign in once in the Operations app first.');
  const operator = await bootstrapFirstAdmin(new PostgresCommercialRepository(factory), mapping.personId, new Date().toISOString());
  console.log(JSON.stringify({ personId: operator.personId, role: operator.role, state: operator.state }));
} catch (error) {
  // A refusal is safe to print. Raw PostgreSQL errors and the URL are not.
  console.error(error instanceof AccountError ? error.message : 'Bootstrap failed. Inspect the staging database with its operator.');
  process.exitCode = 1;
}
