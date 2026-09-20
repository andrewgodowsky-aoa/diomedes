import { describe, expect, it } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { MemoryRepository } from './support/memory.js';
import type { IdentityVerifier, VerifiedIdentity } from '../src/domain.js';

import { now, verifier, setup } from './support/fixtures.js';

describe('portable account rules from the foundation candidate', () => {
  it('maps issuer/subject once under concurrent sign-in, never by display name', async () => {
    const { accounts } = setup();
    const result = await Promise.all(Array.from({ length: 8 }, () => accounts.signIn('alice')));
    expect(new Set(result.map((row) => row.person.id)).size).toBe(1);
    expect((await accounts.signIn('bob')).person.id).not.toBe(result[0].person.id);
  });
  it('isolates tenants and retains entitlement none', async () => {
    const { accounts } = setup();
    const org = await accounts.createOrganization('alice', 'One');
    await accounts.createOrganization('bob', 'Two');
    await expect(accounts.membership('bob', org.id)).rejects.toMatchObject({ status: 403 });
    const view = await accounts.listWorkspaces('alice');
    expect(view.organizations).toHaveLength(1);
    expect(view.organizations[0].entitlement.plan).toBe('none');
  });
  it('binds an invitation to subject and tenant, stores only its digest, accepts once', async () => {
    const { accounts, repository } = setup();
    const one = await accounts.createOrganization('alice', 'One');
    const two = await accounts.createOrganization('alice', 'Two');
    const invitation = await accounts.invite('alice', one.id, { subject: 'user_bob', role: 'member', ttlMs: 5000 });
    expect(JSON.stringify(repository.snapshot())).not.toContain(invitation.token);
    await expect(accounts.acceptInvitation('charlie', one.id, invitation.token)).rejects.toMatchObject({ status: 403 });
    await expect(accounts.acceptInvitation('bob', two.id, invitation.token)).rejects.toMatchObject({ status: 403 });
    const attempts = await Promise.allSettled([accounts.acceptInvitation('bob', one.id, invitation.token), accounts.acceptInvitation('bob', one.id, invitation.token)]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await accounts.membership('bob', one.id)).membership.role).toBe('member');
  });
  it('serializes concurrent owner removals so an active owner remains', async () => {
    const { accounts } = setup();
    const org = await accounts.createOrganization('alice', 'One');
    const invite = await accounts.invite('alice', org.id, { subject: 'user_bob', role: 'owner', ttlMs: 5000 });
    await accounts.acceptInvitation('bob', org.id, invite.token);
    const alice = await accounts.signIn('alice');
    const bob = await accounts.signIn('bob');
    const attempts = await Promise.allSettled([
      accounts.setMembership('alice', org.id, alice.person.id, { role: 'member', state: 'revoked' }),
      accounts.setMembership('bob', org.id, bob.person.id, { role: 'member', state: 'revoked' }),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('rolls back session creation when a later tenant authorization fails', async () => {
    const { accounts, repository } = setup();
    const before = repository.snapshot();
    await expect(accounts.invite('alice', 'org_missing', { subject: 'user_bob', role: 'member', ttlMs: 5000 })).rejects.toMatchObject({ status: 403 });
    expect(repository.snapshot()).toEqual(before);
  });
  it('refuses a revoked session after constructing a new service', async () => {
    const { accounts, repository } = setup();
    await accounts.revokeLocalSession('alice');
    const restarted = new AccountService(repository, verifier, { now: () => now });
    await expect(restarted.signIn('alice')).rejects.toMatchObject({ status: 401 });
  });
  it('does not hold a transaction during provider verification', async () => {
    const repository = new MemoryRepository();
    const checked: IdentityVerifier = { issuer: verifier.issuer, async verify(token): Promise<VerifiedIdentity> {
      expect(repository.inTransaction).toBe(false); return verifier.verify(token);
    } };
    await new AccountService(repository, checked, { now: () => now }).createOrganization('alice', 'One');
  });
  it('invalidates invitation authority after inviter membership changes', async () => {
    const { accounts } = setup();
    const org = await accounts.createOrganization('alice', 'One');
    const invitation = await accounts.invite('alice', org.id, { subject: 'user_bob', role: 'member', ttlMs: 5000 });
    const alice = await accounts.signIn('alice');
    await accounts.setMembership('alice', org.id, alice.person.id, { role: 'owner', state: 'active' });
    await expect(accounts.acceptInvitation('bob', org.id, invitation.token)).rejects.toMatchObject({ status: 403 });
  });
  it('refuses an identity proof that ages while waiting for the transaction lock', async () => {
    let time = now;
    const repository = new MemoryRepository();
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const holding = repository.transaction(async () => { await held; });
    let verified!: () => void;
    const seen = new Promise<void>((done) => { verified = done; });
    const identity: IdentityVerifier = { issuer: verifier.issuer, async verify(token) { const proof = await verifier.verify(token); verified(); return proof; } };
    const accounts = new AccountService(repository, identity, { now: () => time });
    const pending = accounts.createOrganization('alice', 'Expired while queued');
    const rejected = expect(pending).rejects.toMatchObject({ status: 401 });
    await seen; time += 5001; release(); await holding; await rejected;
    expect(repository.snapshot().organizations).toEqual([]);
    expect(repository.snapshot().persons).toEqual([]);
  });
  it('cannot reactivate revoked membership through a role edit', async () => {
    const { accounts } = setup();
    const org = await accounts.createOrganization('alice', 'One');
    const invitation = await accounts.invite('alice', org.id, { subject: 'user_bob', role: 'member', ttlMs: 5000 });
    const bob = await accounts.acceptInvitation('bob', org.id, invitation.token);
    await accounts.setMembership('alice', org.id, bob.personId, { role: 'member', state: 'revoked' });
    await expect(accounts.setMembership('alice', org.id, bob.personId, { role: 'owner', state: 'active' })).rejects.toMatchObject({ status: 409 });
  });
  it('does not let an admin invite new members', async () => {
    const { accounts } = setup();
    const org = await accounts.createOrganization('alice', 'One');
    const invitation = await accounts.invite('alice', org.id, { subject: 'user_bob', role: 'admin', ttlMs: 5000 });
    await accounts.acceptInvitation('bob', org.id, invitation.token);
    await expect(accounts.invite('bob', org.id, { subject: 'user_charlie', role: 'owner', ttlMs: 5000 })).rejects.toMatchObject({ status: 403 });
  });
});
