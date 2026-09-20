import { describe, expect, it } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { createHandler } from '../src/worker.js';
import { PostgresRepository, type SqlClient } from '../src/postgres.js';
import { capacitySeed, seededMemory } from './support/capacity-fixtures.js';
import { now, validEnv } from './support/fixtures.js';

async function setup(workspaces: number, members = 1, revoked = 0) {
  const seed = capacitySeed(workspaces, members, revoked);
  const memory = await seededMemory(seed.state);
  return { ...seed, memory, accounts: new AccountService(memory, seed.identity, { now: () => now }) };
}

describe('active admission and over-limit account recovery', () => {
  it('refuses workspace creation at 100 and rolls back the session draft', async () => {
    const { accounts, memory } = await setup(100); const before = memory.snapshot();
    await expect(accounts.createOrganization('alice', 'Over capacity')).rejects.toMatchObject({ status: 409 });
    expect(memory.snapshot()).toEqual(before);
  });
  it('enforces recipient workspace capacity on invitation acceptance without spending its token', async () => {
    const { accounts, memory } = await setup(100);
    const org = await accounts.createOrganization('bob', 'Recipient boundary');
    const invite = await accounts.invite('bob', org.id, { subject: 'user_alice', role: 'member', ttlMs: 5000 });
    const before = memory.snapshot();
    await expect(accounts.acceptInvitation('alice', org.id, invite.token)).rejects.toMatchObject({ status: 409 });
    expect(memory.snapshot()).toEqual(before);
  });
  it('refuses the 1001st active member without spending the invitation', async () => {
    const { accounts, memory, organizationId } = await setup(1, 1000);
    const invite = await accounts.invite('alice', organizationId(0), { subject: 'user_bob', role: 'member', ttlMs: 5000 });
    const before = memory.snapshot();
    await expect(accounts.acceptInvitation('bob', organizationId(0), invite.token)).rejects.toMatchObject({ status: 409 });
    expect(memory.snapshot()).toEqual(before);
  });
  it('ignores retained revoked rows when admitting a member and rejoining a workspace', async () => {
    const { accounts, memory, organizationId, personId } = await setup(1, 999, 1002);
    const invite = await accounts.invite('alice', organizationId(0), { subject: 'user_bob', role: 'member', ttlMs: 5000 });
    await accounts.acceptInvitation('bob', organizationId(0), invite.token);
    await accounts.setMembership('alice', organizationId(0), personId('bob'), { role: 'member', state: 'revoked' });
    const again = await accounts.invite('alice', organizationId(0), { subject: 'user_bob', role: 'member', ttlMs: 5000 });
    await accounts.acceptInvitation('bob', organizationId(0), again.token);
    const rows = memory.snapshot().memberships;
    expect(rows.filter(m => m.record.state === 'active')).toHaveLength(1000);
    expect(rows.filter(m => m.record.state === 'revoked')).toHaveLength(1002);
    expect(rows.filter(m => m.record.personId === personId('bob'))).toHaveLength(1);
  });
  it('serializes competing creations at 99 active workspaces', async () => {
    const { accounts, memory } = await setup(99);
    const results = await Promise.allSettled([accounts.createOrganization('alice', 'One'), accounts.createOrganization('alice', 'Two')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(memory.snapshot().organizations).toHaveLength(100);
  });
  it('admits from 99 active workspaces despite revoked history, then refuses a rejoin at 100', async () => {
    const { accounts, memory, organizationId, personId } = await setup(101);
    await memory.transaction(async tx => {
      const original = await tx.member(organizationId(0), personId('alice'));
      for (const i of [0, 1]) await tx.saveMembership({ generation: 0, record: { ...original!.record, organizationId: organizationId(i), personId: personId('bob') } });
    });
    for (const i of [0, 1]) await accounts.setMembership('bob', organizationId(i), personId('alice'), { role: 'member', state: 'revoked' });
    await accounts.createOrganization('alice', 'Capacity restored');
    expect((await accounts.listWorkspaces('alice')).organizations).toHaveLength(100);
    expect(memory.snapshot().memberships.filter(row => row.record.personId === personId('alice'))).toHaveLength(102);
    const invite = await accounts.invite('bob', organizationId(0), { subject: 'user_alice', role: 'member', ttlMs: 5000 });
    const before = memory.snapshot();
    await expect(accounts.acceptInvitation('alice', organizationId(0), invite.token)).rejects.toMatchObject({ status: 409 });
    expect(memory.snapshot()).toEqual(before);
  });
  it('serializes two different recipients at 999 active members', async () => {
    const { accounts, memory, organizationId } = await setup(1, 999);
    const a = await accounts.invite('alice', organizationId(0), { subject: 'user_bob', role: 'member', ttlMs: 5000 });
    const b = await accounts.invite('alice', organizationId(0), { subject: 'user_carol', role: 'member', ttlMs: 5000 });
    const results = await Promise.allSettled([accounts.acceptInvitation('bob', organizationId(0), a.token), accounts.acceptInvitation('carol', organizationId(0), b.token)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(memory.snapshot().memberships.filter(m => m.record.state === 'active')).toHaveLength(1000);
  });
  it('authorizes an owner beyond the former row window and permits reducing an over-limit organization', async () => {
    const { accounts, memory, organizationId, personId } = await setup(1, 1002);
    expect((await accounts.membership('alice', organizationId(0))).membership.role).toBe('owner');
    await accounts.setMembership('alice', organizationId(0), personId('filler_00001'), { role: 'member', state: 'revoked' });
    expect(memory.snapshot().memberships.filter(m => m.record.state === 'active')).toHaveLength(1001);
    await expect(accounts.setMembership('alice', organizationId(0), personId('alice'), { role: 'member', state: 'revoked' })).rejects.toMatchObject({ status: 409 });
  });
  it('provides bounded continuation over a preexisting account above 100 active workspaces', async () => {
    const { accounts, organizationId } = await setup(103);
    const handler = createHandler(() => accounts);
    const call = (suffix = '') => handler(new Request('https://control.example/account/session' + suffix, { headers: { Authorization: 'Bearer alice' } }), validEnv);
    const first = await (await call()).json();
    expect(first.organizations).toHaveLength(25);
    expect(first.nextCursor).toBe(organizationId(24));
    const visited: string[] = first.organizations.map((x: { organization: { id: string } }) => x.organization.id);
    let after = first.nextCursor;
    const pageSizes = [25];
    while (after !== null) {
      const page = await (await call('?after=' + encodeURIComponent(after))).json();
      visited.push(...page.organizations.map((x: { organization: { id: string } }) => x.organization.id));
      pageSizes.push(page.organizations.length); after = page.nextCursor;
    }
    expect(pageSizes).toEqual([25, 25, 25, 25, 3]);
    expect(new Set(visited).size).toBe(103);
    expect(visited).toEqual(Array.from({ length: 103 }, (_, i) => organizationId(i)));
    expect((await call('?after=bad%2Fcursor')).status).toBe(422);
    expect((await call('?after=x&after=y')).status).toBe(422);
  });
  it('allows an authenticated browser to preflight and read a continuation page', async () => {
    const { accounts, organizationId } = await setup(30);
    let serviceCalls = 0;
    const handler = createHandler(() => { serviceCalls++; return accounts; });
    const url = 'https://control.example/account/session?after=' + organizationId(24);
    const origin = validEnv.ALLOWED_ORIGINS;
    const preflight = (method: string, target = url, callerOrigin = origin) => handler(new Request(target, {
      method: 'OPTIONS', headers: { Origin: callerOrigin, 'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': 'authorization,content-type' },
    }), validEnv);
    const allowed = await preflight('GET');
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(origin);
    expect(allowed.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(serviceCalls).toBe(0);
    const response = await handler(new Request(url, { headers: { Origin: origin, Authorization: 'Bearer alice' } }), validEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect((await response.json()).organizations).toHaveLength(5);
    expect((await preflight('POST')).status).toBe(422);
    expect((await preflight('GET', url + '&unexpected=x')).status).toBe(422);
    expect((await preflight('GET', url, 'https://untrusted.example')).status).toBe(403);
  });
  it('preserves the complete local response and excludes revocations between cloud pages', async () => {
    const { accounts, memory, organizationId, personId } = await setup(205);
    // A second owner permits removal without weakening last-owner protection.
    await memory.transaction(async tx => {
      const original = await tx.member(organizationId(0), personId('alice'));
      for (const i of [24, 150]) await tx.saveMembership({ generation: 0, record: { ...original!.record, organizationId: organizationId(i), personId: personId('bob') } });
    });
    const local = await accounts.listWorkspaces('alice');
    expect(Object.keys(local).sort()).toEqual(['organizations', 'person']);
    expect(local.organizations).toHaveLength(205);
    const first = await accounts.workspacePage('alice');
    // Removing the cursor row must not shift an offset. A future revoked row
    // must disappear without omitting or duplicating the remaining active rows.
    await accounts.setMembership('bob', organizationId(24), personId('alice'), { state: 'revoked', role: 'member' });
    await accounts.setMembership('bob', organizationId(150), personId('alice'), { state: 'revoked', role: 'member' });
    const seen = first.organizations.map(x => x.organization.id);
    let after = first.nextCursor;
    while (after !== null) {
      const page = await accounts.workspacePage('alice', after);
      expect(page.organizations.length).toBeLessThanOrEqual(25);
      seen.push(...page.organizations.map(x => x.organization.id)); after = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(Array.from({ length: 205 }, (_, i) => organizationId(i)).filter(id => id !== organizationId(150)));
    expect((await accounts.listWorkspaces('alice')).organizations).toHaveLength(203);
  });
  it('refuses an inconsistent joined organization instead of silently dropping its membership', async () => {
    const { state } = capacitySeed(1);
    const calls: string[] = [];
    const client: SqlClient = { async connect() {}, async end() {}, async query(sql) {
      calls.push(sql);
      return sql.startsWith('SELECT m.record') ? { rows: [{ member_record: state.memberships[0].record, member_generation: 0,
        organization_record: null, organization_generation: null }], rowCount: 1 } : { rows: [], rowCount: 0 };
    } };
    await expect(new PostgresRepository(() => client).transaction(tx => tx.workspaceRows(state.persons[0].id))).rejects.toMatchObject({ name: 'ZodError' });
    expect(calls).toContain('ROLLBACK'); expect(calls).not.toContain('COMMIT');
  });
  it('treats another organization ID as a position, never as membership authority', async () => {
    const { accounts, personId } = await setup(30);
    const other = await accounts.createOrganization('bob', 'Other tenant');
    const page = await accounts.workspacePage('alice', other.id);
    expect(page.organizations.every(row => row.membership.personId === personId('alice'))).toBe(true);
    expect(page.organizations.some(row => row.organization.id === other.id)).toBe(false);
  });
});
