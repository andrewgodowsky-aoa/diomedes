import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Client } from '@neondatabase/serverless';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations.js';
import { PostgresRepository, type ClientFactory } from '../src/postgres.js';
import { AccountService } from '../src/account-service.js';
import { CommercialPersonScopes } from '../src/credit-purchases.js';
import { PostgresCommercialRepository } from '../src/commercial-postgres.js';
import { PostgresSubscriptions } from '../src/billing-postgres.js';
import { DeveloperKeyService, DeveloperKeyVerifier, PostgresDeveloperKeys } from '../src/developer-keys.js';
import type { PaidSubscription } from '../src/subscriptions.js';
import { individualCycleAt } from '../../../shared/individual-period.js';

const connectionString = process.env.CP_BILLING_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('account billing on isolated PostgreSQL, as cp_runtime', () => {
  const at = Date.now();
  let ownerFactory: ClientFactory, runtime: ClientFactory, accounts: AccountService, ledger: PostgresRepository, billing: PostgresSubscriptions;
  const query = async (sql: string, values?: unknown[]) => { const client = ownerFactory(); await client.connect(); try { return await client.query(sql, values); } finally { await client.end(); } };
  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (url.pathname !== '/b01_validation_stripe_billing' || url.hostname !== process.env.CP_TEST_EXPECTED_HOST || !url.hostname.endsWith('.neon.tech') ||
      !process.env.CP_TEST_BRANCH_ID?.startsWith('br-') || process.env.CP_TEST_BRANCH_ID === 'br-old-star-aepf7zk6' || process.env.CP_TEST_ALLOW_SCHEMA_RESET !== 'yes')
      throw new Error('This suite requires the exact isolated disposable billing database; production is forbidden.');
    ownerFactory = () => new Client({ connectionString, connectionTimeoutMillis: 5000 });
    const runtimeUrl = new URL(process.env.CP_BILLING_TEST_RUNTIME_URL!);
    if (runtimeUrl.hostname !== url.hostname || runtimeUrl.pathname !== url.pathname || runtimeUrl.username !== 'cp_runtime') throw new Error('Pin the same isolated database and cp_runtime login.');
    runtime = () => new Client({ connectionString: runtimeUrl.href, connectionTimeoutMillis: 5000 });
    await query('DROP SCHEMA IF EXISTS control_plane CASCADE');
    const directory = new URL('../migrations/', import.meta.url);
    const names = (await readdir(directory)).filter(name => /^\d{3}[-_].*\.sql$/.test(name)).sort();
    const migrations = await Promise.all(names.map(async name => { const sql = await readFile(new URL(name, directory), 'utf8'); return { version: Number(name.slice(0, 3)), name, sql, sha256: createHash('sha256').update(sql).digest('hex') }; }));
    expect(await migrate(ownerFactory, migrations)).toContain(21);
    expect(await migrate(ownerFactory, migrations)).toEqual([]);
    await query(await readFile(new URL('../scripts/runtime-permissions.sql', import.meta.url), 'utf8'));
    ledger = new PostgresRepository(runtime);
    accounts = new AccountService(ledger, { issuer: 'https://identity.example', async verify(token) { return { issuer: this.issuer, subject: `user_${token}`, sessionId: `session_${token}`, displayName: 'Billing fixture', emailVerified: true,
      issuedAt: new Date(at - 1000).toISOString(), verifiedAt: new Date(at).toISOString(), expiresAt: new Date(at + 3600_000).toISOString() }; } }, { now: () => at });
    billing = new PostgresSubscriptions(runtime, () => at);
  }, 60_000);
  async function fixture(label: string, personal = false) {
    const actor = await accounts.signIn(label);
    const scope = personal ? await new CommercialPersonScopes(new PostgresCommercialRepository(runtime), () => at).ensure(actor.person) : await accounts.createOrganization(label, label);
    const customerId = await ledger.ensureCustomer({ organizationId: scope.id, tenantId: scope.tenantId, environment: 'test' }, async () => `cus_${label}`);
    const owner = (await billing.owner(customerId, 'test'))!;
    const event = async (id: string) => { await ledger.recordVerifiedPayment({ customerId, organizationId: owner.organizationId, tenantId: owner.tenantId, environment: 'test', eventId: id, eventType: 'invoice.paid', payloadHash: 'a'.repeat(64), payload: { id, type: 'invoice.paid', livemode: false, data: { object: { id: 'in_fixture', customer: customerId } } } }); return id; };
    const validFrom = new Date(Math.floor(at / 1000) * 1000 - 60_000).toISOString();
    const cycle = individualCycleAt(validFrom, validFrom)!;
    const validUntil = cycle.endsAt;
    const paid: PaidSubscription = { id: `sub_${label}`, planId: personal ? 'individual' : 'business', invoiceId: `in_${label}`, validFrom, validUntil,
      ...(personal ? { billingCycle: cycle } : {}) };
    return { actor, scope, owner, event, paid };
  }
  it('serializes checkout attempts and refuses another completion identity', async () => {
    const f = await fixture('checkout');
    const attempts = await Promise.all(Array.from({ length: 4 }, () => billing.attempt(f.owner, 'test', 'business', at)));
    expect(new Set(attempts.map(row => row.id)).size).toBe(1);
    await billing.complete(f.owner.customerId, 'test', attempts[0].id, 'cs_a', 'https://checkout.stripe.com/a');
    await expect(billing.complete(f.owner.customerId, 'test', attempts[0].id, 'cs_b', 'https://checkout.stripe.com/b')).rejects.toMatchObject({ status: 409 });
  });
  it.each([false, true])('grants once, revokes once, and never revives a paid invoice (personal=%s)', async personal => {
    const f = await fixture(personal ? 'personal' : 'business', personal);
    const event = await f.event(`evt_${personal ? 'personal' : 'business'}`);
    await Promise.all(Array.from({ length: 4 }, () => billing.reconcile(f.owner, 'test', event, false, async () => [f.paid])));
    const table = personal ? 'person_feature_grants' : 'feature_grants';
    const read = () => query(`SELECT record FROM control_plane.${table} WHERE tenant_id=$1`, [f.owner.tenantId]);
    expect((await read()).rows).toHaveLength(1);
    expect((await read()).rows[0].record).toMatchObject({ state: 'active' });
    await billing.reconcile(f.owner, 'test', event, false, async () => []);
    expect((await read()).rows[0].record).toMatchObject({ state: 'revoked' });
    await billing.reconcile(f.owner, 'test', event, false, async () => [f.paid]);
    expect((await read()).rows).toHaveLength(1);
    expect((await read()).rows[0].record).toMatchObject({ state: 'revoked' });
    expect((await billing.view(f.owner.customerId, 'test'))[0].status).toBe('review');
  });
  it('rejects foreign event proofs and keeps refund holds through replays', async () => {
    const f = await fixture('refund'), other = await fixture('foreign');
    await expect(billing.reconcile(f.owner, 'test', await other.event('evt_foreign'), false, async () => [f.paid])).rejects.toMatchObject({ status: 409 });
    const event = await f.event('evt_refund');
    await billing.reconcile(f.owner, 'test', event, false, async () => [f.paid]);
    await billing.reconcile(f.owner, 'test', event, true, async () => { throw new Error('A hold must not read Stripe'); });
    await billing.reconcile(f.owner, 'test', event, false, async () => { throw new Error('A replay must not clear a hold'); });
    await expect(billing.attempt(f.owner, 'test', 'business', at)).rejects.toMatchObject({ status: 409 });
    await expect(query('UPDATE control_plane.subscription_accounts SET suspended=false WHERE customer_id=$1', [f.owner.customerId])).rejects.toMatchObject({ code: '23514' });
  });
  it('authenticates hashed keys and makes revocation immutable, with no runtime delete privilege', async () => {
    const f = await fixture('keys', true);
    const store = new PostgresDeveloperKeys(runtime);
    const service = new DeveloperKeyService(store, async () => ({ actor: f.actor, scope: { kind: 'individual', id: f.scope.id } }), () => at);
    const created = await service.create('keys', { organizationId: null, name: 'test', expiresInDays: 1 });
    const verifier = new DeveloperKeyVerifier(store, 'https://identity.example', created.key.scope, () => at);
    expect((await verifier.verify(created.secret)).subject).toBe('user_keys');
    expect(JSON.stringify((await query('SELECT * FROM control_plane.developer_keys')).rows)).not.toContain(created.secret);
    await service.revoke('keys', created.key.id);
    await expect(verifier.verify(created.secret)).rejects.toMatchObject({ status: 401 });
    await expect(query('UPDATE control_plane.developer_keys SET revoked_at=NULL WHERE id=$1', [created.key.id])).rejects.toMatchObject({ code: '23514' });
    expect((await query("SELECT has_table_privilege('cp_runtime','control_plane.developer_keys','DELETE') AS allowed")).rows[0].allowed).toBe(false);
  });
});
