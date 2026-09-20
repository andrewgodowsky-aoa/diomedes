import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { FileAccountRepository } from '../server/business/account-store.js';
import { AccountService } from '../server/business/account-service.js';
import type { AccountRepository } from '../server/business/account-contract.js';
import { createAccountHandler } from '../server/business/identity-host.js';

// The provider seam supplies already-verified identities. All account policy,
// transaction serialization, disk persistence and HTTP parsing remain real.
let root: string;
let store: Store;
let accounts: AccountService;
let now: number;
const issuer = 'https://identity.example.test';
const origin = 'https://inventory.example.test';

function service(repository: AccountRepository = new FileAccountRepository(store)) {
  return new AccountService(repository, {
    issuer,
    verify: async token => {
      const result = {
        issuer, subject: `user_${token}`, sessionId: `session_${token}`,
        displayName: 'Same displayed name', emailVerified: true,
        issuedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        verifiedAt: new Date(now).toISOString(),
      };
      return result;
    },
  }, { now: () => now });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-account-independent-'));
  now = Date.parse('2026-09-20T00:00:00Z');
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  accounts = service();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('a provider proof that expires in the Store queue cannot create an organization', async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const inQueue = new Promise<void>(resolve => { entered = resolve; });
  const blocker = store.locked(async () => { entered(); await held; });
  await inQueue;
  let queued!: () => void;
  const transactionQueued = new Promise<void>(resolve => { queued = resolve; });
  const repository = new FileAccountRepository(store);
  accounts = service({
    scope: repository.scope,
    read: action => repository.read(action),
    transact: action => {
      const pending = repository.transact(action);
      queued();
      return pending;
    },
  });
  const result = accounts.createOrganization('alice', 'Must not exist');
  const refusal = expect(result).rejects.toMatchObject({ status: 401 });
  await transactionQueued;
  now += 5001;
  release();
  await blocker;
  await refusal;
  expect((await accounts.listWorkspaces('alice')).organizations).toEqual([]);
});

test('concurrent owner removals serialize and preserve exactly one owner', async () => {
  const org = await accounts.createOrganization('alice', 'Warehouse');
  const invite = await accounts.invite('alice', org.id, { subject: 'user_bob', role: 'owner', ttlMs: 30_000 });
  const bob = await accounts.acceptInvitation('bob', org.id, invite.token);
  const alice = await accounts.signIn('alice');
  const results = await Promise.allSettled([
    accounts.setMembership('alice', org.id, alice.person.id, { state: 'revoked', role: 'member' }),
    accounts.setMembership('bob', org.id, bob.personId, { state: 'revoked', role: 'member' }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const denied = results.find(result => result.status === 'rejected');
  expect(denied).toMatchObject({ status: 'rejected', reason: { status: 409 } });
  const remaining = (await Promise.all(['alice', 'bob'].map(token => accounts.listWorkspaces(token))))
    .flatMap(result => result.organizations);
  expect(remaining).toHaveLength(1);
  expect(remaining[0].membership.role).toBe('owner');
});

test('a spent invitation remains spent after reopening the actual file repository', async () => {
  const org = await accounts.createOrganization('alice', 'Warehouse');
  const invite = await accounts.invite('alice', org.id, { subject: 'user_bob', role: 'member', ttlMs: 30_000 });
  await accounts.acceptInvitation('bob', org.id, invite.token);
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  accounts = service();
  await expect(accounts.acceptInvitation('bob', org.id, invite.token)).rejects.toMatchObject({ status: 409 });
  expect((await accounts.listWorkspaces('bob')).organizations).toHaveLength(1);
});

test('a copied or mutated membership snapshot cannot select a different tenant', async () => {
  const org = await accounts.createOrganization('alice', 'Warehouse');
  const snapshot = await accounts.membership('alice', org.id);
  await expect(accounts.withCurrentMembership(structuredClone(snapshot), () => 'effect'))
    .rejects.toMatchObject({ status: 401 });
  snapshot.organization.tenantId = 'tenant_forged';
  snapshot.person.id = 'person_forged';
  const current = await accounts.withCurrentMembership(snapshot, value => ({
    tenant: value.organization.tenantId, person: value.person.id,
  }));
  expect(current.tenant).toBe(org.tenantId);
  expect(current.person).not.toBe('person_forged');
});

test('a revoked session invalidates a previously issued in-process snapshot', async () => {
  const org = await accounts.createOrganization('alice', 'Warehouse');
  const snapshot = await accounts.membership('alice', org.id);
  await accounts.revokeLocalSession('alice');
  let effects = 0;
  await expect(accounts.withCurrentMembership(snapshot, () => { effects++; }))
    .rejects.toMatchObject({ status: 401 });
  expect(effects).toBe(0);
});

test('corrupt persisted account state fails closed without replacing its bytes', async () => {
  await accounts.createOrganization('alice', 'Warehouse');
  const file = path.join(root, 'data', 'business', 'accounts-v1.json');
  const corrupt = '{"v":1,"persons":';
  await fs.writeFile(file, corrupt);
  await expect(accounts.createOrganization('bob', 'Must not replace corrupt state'))
    .rejects.toMatchObject({ status: 503 });
  expect(await fs.readFile(file, 'utf8')).toBe(corrupt);
});

test('the actual Fetch handler rejects a streamed oversized body before any account effect', async () => {
  const handler = createAccountHandler(accounts, { allowedOrigins: [origin] });
  const request = new Request(`${origin}/account/organizations`, {
    method: 'POST', headers: { Origin: origin, Authorization: 'Bearer alice', 'Content-Type': 'application/json' },
    body: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"name":"'));
      controller.enqueue(new Uint8Array(65_537).fill(65));
      controller.close();
    } }),
    duplex: 'half',
  } as RequestInit);
  const response = await handler(request);
  expect(response.status).toBe(413);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await accounts.listWorkspaces('alice')).organizations).toEqual([]);
});
