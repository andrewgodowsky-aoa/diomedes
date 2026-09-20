import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { FileAccountRepository } from '../server/business/account-store.js';
import { AccountService } from '../server/business/account-service.js';
import type { IdentityVerifier, VerifiedIdentity } from '../server/business/account-contract.js';

// Offline provider double only. The separate WorkOS suite verifies real RSA signatures.
const issuer = 'https://api.workos.com/';
let time: number;
let root: string;
let repository: FileAccountRepository;
let accounts: AccountService;
let identities: Map<string, VerifiedIdentity>;
let verifier: IdentityVerifier;

function identity(subject: string, sessionId = `session_${subject}`): VerifiedIdentity {
  return {
    issuer,
    subject,
    sessionId,
    displayName: 'Same display name',
    emailVerified: true,
    issuedAt: new Date(time - 1000).toISOString(),
    expiresAt: new Date(time + 300_000).toISOString(),
    verifiedAt: new Date(time).toISOString(),
  };
}

async function open() {
  const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  repository = new FileAccountRepository(store);
  accounts = new AccountService(repository, verifier, { now: () => time });
}

beforeEach(async () => {
  time = Date.parse('2026-09-20T00:00:00Z');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-account-foundation-'));
  identities = new Map(['alice', 'bob', 'eve'].map((name) => [name, identity(`user_${name}`)]));
  verifier = {
    issuer,
    verify: async (token) => {
      const value = identities.get(token);
      if (!value) throw new Error('Offline identity fixture rejected the token.');
      return { ...value, verifiedAt: new Date(time).toISOString() };
    },
  };
  await open();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function inviteBob(role: 'owner' | 'admin' | 'member' = 'member') {
  const org = await accounts.createOrganization('alice', 'Warehouse');
  const invite = await accounts.invite('alice', org.id, {
    subject: 'user_bob',
    role,
    ttlMs: 60_000,
  });
  await accounts.acceptInvitation('bob', org.id, invite.token);
  return org;
}

describe('durable hosted account membership foundation', () => {
  test('maps issuer/subject once, keeps equal display names distinct, and survives restart', async () => {
    const first = await accounts.signIn('alice');
    const other = await accounts.signIn('bob');
    expect(first.person.id).not.toBe(other.person.id);
    await open();
    expect((await accounts.signIn('alice')).person.id).toBe(first.person.id);
    expect((await repository.read((state) => state.subjects)).length).toBe(2);
  });

  test('creates only an explicit hosted organization and no paid or execution entitlement', async () => {
    expect((await accounts.listWorkspaces('alice')).organizations).toEqual([]);
    const org = await accounts.createOrganization('alice', 'Warehouse');
    expect(org.identitySource).toBe('hosted');
    const view = await accounts.listWorkspaces('alice');
    expect(view.organizations.map((row) => row.organization.id)).toEqual([org.id]);
    expect(view.organizations[0].entitlement).toMatchObject({
      plan: 'none',
      managedInference: false,
    });
    expect((await accounts.listWorkspaces('bob')).organizations).toEqual([]);
  });

  test('denies cross-tenant access and does not infer membership from provider org/role', async () => {
    const a = await accounts.createOrganization('alice', 'A');
    const b = await accounts.createOrganization('bob', 'B');
    await expect(accounts.membership('alice', b.id)).rejects.toMatchObject({ status: 403 });
    expect((await accounts.membership('alice', a.id)).membership.personId).toBe(
      (await accounts.signIn('alice')).person.id,
    );
  });

  test('invitation binds exact recipient and tenant, is single-use under concurrent redemption', async () => {
    const org = await accounts.createOrganization('alice', 'A');
    const other = await accounts.createOrganization('alice', 'B');
    const invite = await accounts.invite('alice', org.id, {
      subject: 'user_bob',
      role: 'member',
      ttlMs: 60_000,
    });
    await expect(accounts.acceptInvitation('eve', org.id, invite.token)).rejects.toMatchObject({
      status: 403,
    });
    await expect(accounts.acceptInvitation('bob', other.id, invite.token)).rejects.toMatchObject({
      status: 403,
    });
    const results = await Promise.allSettled([
      accounts.acceptInvitation('bob', org.id, invite.token),
      accounts.acceptInvitation('bob', org.id, invite.token),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const bytes = await fs.readFile(repository.filePath, 'utf8');
    expect(bytes).not.toContain(invite.token);
    await open();
    await expect(accounts.acceptInvitation('bob', org.id, invite.token)).rejects.toMatchObject({
      status: 409,
    });
  });

  test('expired invitation and unverified recipient cannot join', async () => {
    const org = await accounts.createOrganization('alice', 'A');
    const invite = await accounts.invite('alice', org.id, {
      subject: 'user_bob',
      role: 'member',
      ttlMs: 1000,
    });
    identities.set('bob', { ...identity('user_bob'), emailVerified: false });
    await expect(accounts.acceptInvitation('bob', org.id, invite.token)).rejects.toMatchObject({
      status: 403,
    });
    identities.set('bob', identity('user_bob'));
    time += 1000;
    await expect(accounts.acceptInvitation('bob', org.id, invite.token)).rejects.toMatchObject({
      status: 410,
    });
  });

  test('changed or revoked inviter cannot leave a redeemable invitation behind', async () => {
    const org = await inviteBob('owner');
    const invite = await accounts.invite('bob', org.id, {
      subject: 'user_eve',
      role: 'member',
      ttlMs: 60_000,
    });
    const bob = await accounts.signIn('bob');
    await accounts.setMembership('alice', org.id, bob.person.id, {
      role: 'member',
      state: 'revoked',
    });
    await expect(accounts.acceptInvitation('eve', org.id, invite.token)).rejects.toMatchObject({
      status: 403,
    });
  });

  test('last owner cannot leave, be revoked, or demoted; ordinary members cannot administer', async () => {
    const org = await inviteBob();
    const alice = await accounts.signIn('alice');
    for (const change of [
      { role: 'member', state: 'active' },
      { role: 'owner', state: 'revoked' },
    ] as const)
      await expect(
        accounts.setMembership('alice', org.id, alice.person.id, change),
      ).rejects.toMatchObject({ status: 409 });
    await expect(
      accounts.invite('bob', org.id, { subject: 'user_eve', role: 'member', ttlMs: 1000 }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('membership revocation and generations survive restart without affecting another tenant', async () => {
    const org = await inviteBob();
    const bobOwn = await accounts.createOrganization('bob', 'B');
    const previous = await accounts.membership('bob', org.id);
    await accounts.setMembership('alice', org.id, previous.membership.personId, {
      role: 'member',
      state: 'revoked',
    });
    await open();
    await expect(accounts.withCurrentMembership(previous, () => true)).rejects.toMatchObject({
      status: 403,
    });
    expect((await accounts.membership('bob', bobOwn.id)).organization.id).toBe(bobOwn.id);
  });

  test('role change invalidates a snapshot even if the role is subsequently restored', async () => {
    const org = await inviteBob('admin');
    const previous = await accounts.membership('bob', org.id);
    await accounts.setMembership('alice', org.id, previous.membership.personId, {
      role: 'member',
      state: 'active',
    });
    await accounts.setMembership('alice', org.id, previous.membership.personId, {
      role: 'admin',
      state: 'active',
    });
    await expect(accounts.withCurrentMembership(previous, () => true)).rejects.toMatchObject({
      status: 409,
    });
  });

  test('local session revocation denies replay after restart but leaves a new provider session usable', async () => {
    const person = (await accounts.signIn('alice')).person;
    await accounts.revokeLocalSession('alice');
    await open();
    await expect(accounts.signIn('alice')).rejects.toMatchObject({ status: 401 });
    identities.set('fresh', identity('user_alice', 'session_fresh'));
    expect((await accounts.signIn('fresh')).person.id).toBe(person.id);
  });

  test('expired token and short membership snapshot deny before callback', async () => {
    const org = await accounts.createOrganization('alice', 'A');
    const snapshot = await accounts.membership('alice', org.id);
    time += 30_001;
    let called = false;
    await expect(
      accounts.withCurrentMembership(snapshot, () => {
        called = true;
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(called).toBe(false);
    time += 300_000;
    await expect(accounts.signIn('alice')).rejects.toMatchObject({ status: 401 });
  });

  test('concurrent sign-ins yield one mapping and a provider session cannot change person', async () => {
    const people = await Promise.all(Array.from({ length: 12 }, () => accounts.signIn('alice')));
    expect(new Set(people.map((value) => value.person.id)).size).toBe(1);
    identities.set('attack', identity('user_eve', 'session_user_alice'));
    await expect(accounts.signIn('attack')).rejects.toMatchObject({ status: 401 });
  });

  test('corrupt/versioned/fixture state fails closed and is not overwritten', async () => {
    await accounts.signIn('alice');
    for (const bytes of [
      '{broken',
      JSON.stringify({ v: 99 }),
      JSON.stringify({ v: 1, persons: [{ assurance: 'development-fixture' }] }),
    ]) {
      await fs.writeFile(repository.filePath, bytes);
      await expect(accounts.signIn('alice')).rejects.toMatchObject({ status: 503 });
      expect(await fs.readFile(repository.filePath, 'utf8')).toBe(bytes);
    }
  });

  test('failed transaction cannot leak partial account state or mutate returned records', async () => {
    const person = (await accounts.signIn('alice')).person;
    await expect(
      repository.transact((state) => {
        state.persons[0].name = 'partial';
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    person.name = 'outside mutation';
    expect((await accounts.signIn('alice')).person.name).toBe('Same display name');
  });

  test('serialized or edited membership snapshots never become credentials', async () => {
    const org = await accounts.createOrganization('alice', 'A');
    const snapshot = await accounts.membership('alice', org.id);
    await expect(
      accounts.withCurrentMembership(structuredClone(snapshot), () => true),
    ).rejects.toMatchObject({ status: 401 });
    snapshot.organization.tenantId = 'tenant_attacker';
    const resolved = await accounts.withCurrentMembership(
      snapshot,
      (current) => current.organization.tenantId,
    );
    expect(resolved).toBe(org.tenantId);
  });

  test('fresh process sees the durable session tombstone and cannot replay the revoked token', async () => {
    await accounts.signIn('alice');
    await accounts.revokeLocalSession('alice');
    const moduleUrl = (file: string) => pathToFileURL(path.resolve(file)).href;
    const script = `
      import { Store } from ${JSON.stringify(moduleUrl('server/store.ts'))};
      import { FileAccountRepository } from ${JSON.stringify(moduleUrl('server/business/account-store.ts'))};
      import { AccountService } from ${JSON.stringify(moduleUrl('server/business/account-service.ts'))};
      const proof = ${JSON.stringify(identity('user_alice'))};
      const store = new Store(${JSON.stringify(path.join(root, 'data'))}, ${JSON.stringify(path.join(root, 'projects'))});
      await store.init();
      const service = new AccountService(new FileAccountRepository(store), {
        issuer: proof.issuer, verify: async () => proof,
      }, { now: () => ${time} });
      try { await service.signIn('offline-only'); process.exitCode = 7; }
      catch (error) { if (error.status !== 401) throw error; process.stdout.write('revoked-after-process-restart'); }
    `;
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: process.cwd(), timeout: 15_000 },
    );
    expect(result.stdout).toBe('revoked-after-process-restart');
  });
});
