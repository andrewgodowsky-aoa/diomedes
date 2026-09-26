import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { CommercialService, bootstrapFirstAdmin } from '../src/commercial.js';
import { identityFor, type AccountPool, type Configuration } from '../src/config.js';
import { FauxCloudStore } from '../src/faux/store.js';
import { createWorkOSStandIn } from '../src/faux/workos-standin.js';
import { FundingService } from '../src/funding.js';
import { STAFF_KEY_ISSUER, StaffKeyVerifier, staffKeyId, type StaffKeyRow } from '../src/identity-staff-key.js';
import { WorkOSIdentityVerifier } from '../src/identity-workos.js';
import { createHandler } from '../src/worker.js';
import { validEnv } from './support/fixtures.js';

// Diomedes staff sign in to the Operations app with a personal staff key; customers
// still sign in through WorkOS. The key never leaves the staff member's computer
// except as the bearer; the service stores and looks up only its SHA-256.

const newKey = () => `nsk_${randomBytes(32).toString('base64url')}`;
const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');
const request = (method: string, path: string, token: string) =>
  new Request(`http://127.0.0.1:8791${path}`, { method, headers: { authorization: `Bearer ${token}` } });

/** An in-memory staff_keys table: hash -> row, with withdrawal. */
function keyTable(now = '2026-09-26T09:00:00.000Z') {
  const rows = new Map<string, StaffKeyRow>();
  const lookups: string[] = [];
  return {
    lookups,
    register(key: string, name = 'Andrew', email: string | null = 'andrew@diomedes.example') {
      const hash = hashOf(key);
      rows.set(hash, { keyId: staffKeyId(hash), name, email, createdAt: now });
      return staffKeyId(hash);
    },
    withdraw(key: string) { rows.delete(hashOf(key)); },
    lookup: async (hash: string) => { lookups.push(hash); return rows.get(hash) ?? null; },
  };
}

describe('StaffKeyVerifier', () => {
  const time = Date.parse('2026-09-26T09:05:00.000Z');

  it('turns a registered key into a verified identity, looking it up by hash alone', async () => {
    const table = keyTable();
    const key = newKey();
    const keyId = table.register(key);
    const identity = await new StaffKeyVerifier(table.lookup, { now: () => time }).verify(key);
    expect(identity).toEqual({
      issuer: STAFF_KEY_ISSUER, subject: keyId, sessionId: keyId, emailVerified: true, email: 'andrew@diomedes.example',
      displayName: 'Andrew', issuedAt: '2026-09-26T09:00:00.000Z', expiresAt: '2026-09-26T09:15:00.000Z', verifiedAt: '2026-09-26T09:05:00.000Z',
    });
    expect(table.lookups).toEqual([hashOf(key)]);
    expect(keyId).toBe(`staff_key_${hashOf(key).slice(0, 16)}`);
  });

  it.each([
    ['a WorkOS-shaped token', 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln'],
    ['a short key', 'nsk_short'],
    ['a key with padding', `${newKey().slice(0, -1)}=`],
    ['another prefix', `sk_${randomBytes(32).toString('base64url')}`],
  ])('refuses %s before any lookup', async (_name, token) => {
    const table = keyTable();
    await expect(new StaffKeyVerifier(table.lookup).verify(token)).rejects.toMatchObject({ status: 401 });
    expect(table.lookups).toEqual([]);
  });

  it('refuses an unregistered or withdrawn key without repeating it', async () => {
    const table = keyTable();
    const key = newKey();
    const verifier = new StaffKeyVerifier(table.lookup);
    const unknown = await verifier.verify(key).catch((error: Error) => error);
    expect(unknown).toMatchObject({ status: 401, message: 'This staff key is not registered, or it was withdrawn. Ask a Diomedes admin.' });
    expect(String((unknown as Error).message)).not.toContain(key.slice(4));
    table.register(key);
    await expect(verifier.verify(key)).resolves.toMatchObject({ issuer: STAFF_KEY_ISSUER });
    table.withdraw(key);
    await expect(verifier.verify(key)).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a row whose key id does not belong to the hash', async () => {
    const key = newKey();
    const lookup = async () => ({ keyId: 'staff_key_0000000000000000', name: 'Someone', email: null, createdAt: '2026-09-26T09:00:00.000Z' });
    await expect(new StaffKeyVerifier(lookup).verify(key)).rejects.toMatchObject({ status: 401 });
  });
});

describe('the Worker signs staff in with a key, and customers through WorkOS', () => {
  it('refuses /ops/* with 401 for a bearer that is not a staff key, before any database or provider call', async () => {
    const response = await createHandler()(request('GET', '/ops/me', 'opaque'), validEnv);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'This staff key is not registered, or it was withdrawn. Ask a Diomedes admin.' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  async function service() {
    const customers = await createWorkOSStandIn({ clientId: 'client_standin_customers' });
    const env = { ...validEnv, WORKOS_CLIENT_ID: customers.clientId, WORKOS_API_KEY: customers.apiKey, WORKOS_TOKEN_AUDIENCE: customers.audience };
    const store = await FauxCloudStore.open(null);
    const table = keyTable();
    // The Worker's own composition, with the key table in memory and WorkOS pointed at its stand-in.
    const accounts = (config: Configuration, pool: AccountPool) => pool === 'staff'
      ? new AccountService(store.accounts, new StaffKeyVerifier(table.lookup))
      : new AccountService(store.accounts, new WorkOSIdentityVerifier({ ...identityFor(config, pool), fetch: customers.fetch }));
    const handler = createHandler(accounts, undefined, {
      createCommercial: (_config, verified) => new CommercialService(verified, store.commercial, new FundingService(store.funding)),
    });
    const call = (method: string, path: string, token: string) => handler(request(method, path, token), env);
    const customer = (await customers.signInDirect('owner@juniper.example')).access_token;
    const key = newKey();
    const keyId = table.register(key);
    const bootstrap = async () => {
      const mapping = await store.accounts.transaction((tx) => tx.subject(STAFF_KEY_ISSUER, keyId));
      return bootstrapFirstAdmin(store.commercial, mapping!.personId, new Date().toISOString());
    };
    return { call, customer, key, table, bootstrap };
  }

  it('maps a registered key to a person, who is refused until made admin and then signed in', async () => {
    const { call, key, bootstrap } = await service();
    const refused = await call('GET', '/ops/me', key);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'This account is not a Diomedes staff account.' });
    expect(await bootstrap()).toMatchObject({ role: 'admin', state: 'active' });
    const me = await call('GET', '/ops/me', key);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ role: 'admin', person: { name: 'Andrew' } });
    // The same person on every call: no second account row for the same key.
    expect((await call('GET', '/ops/staff', key)).status).toBe(200);
  });

  it('keeps each sign-in to its own routes', async () => {
    const { call, customer, key, bootstrap } = await service();
    await call('GET', '/ops/me', key);
    await bootstrap();
    expect((await call('GET', '/ops/me', customer)).status).toBe(401);
    expect((await call('GET', '/account/session', key)).status).toBe(401);
    expect((await call('GET', '/account/session', customer)).status).toBe(200);
    expect((await call('GET', '/ops/me', key)).status).toBe(200);
  });

  it('ends a key when it is withdrawn, or when its session is revoked', async () => {
    const withdrawn = await service();
    await withdrawn.call('GET', '/ops/me', withdrawn.key);
    await withdrawn.bootstrap();
    withdrawn.table.withdraw(withdrawn.key);
    expect((await withdrawn.call('GET', '/ops/me', withdrawn.key)).status).toBe(401);

    const revoked = await service();
    await revoked.call('GET', '/ops/me', revoked.key);
    await revoked.bootstrap();
    expect((await revoked.call('POST', '/ops/session/revoke', revoked.key)).status).toBe(204);
    expect((await revoked.call('GET', '/ops/me', revoked.key)).status).toBe(401);
  });
});
