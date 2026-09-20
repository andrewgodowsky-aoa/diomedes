import { beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { AccountError } from '../src/errors.js';
import { inTransaction, neonClientFactory, PostgresRepository, type ClientFactory } from '../src/postgres.js';
import { capacitySeed } from './support/capacity-fixtures.js';
import { now } from './support/fixtures.js';

const url = process.env.CP_TEST_DATABASE_URL;
let factory: ClientFactory;
const query = (sql: string, values?: unknown[]) => inTransaction(factory, c => c.query(sql, values));

async function setup(workspaces: number, members = 1, revoked = 0) {
  const prefix = `repair_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}_`;
  const seed = capacitySeed(workspaces, members, revoked, prefix);
  // Synthetic fixtures use unique identifiers and insert only in the explicitly
  // pinned disposable database. They do not clear prior evidence or schemas.
  await inTransaction(factory, async c => {
    await c.query("INSERT INTO control_plane.persons(id,record) SELECT r->>'id',r FROM jsonb_array_elements($1::jsonb) r", [JSON.stringify(seed.state.persons)]);
    await c.query("INSERT INTO control_plane.external_subjects(issuer,subject,person_id,record) SELECT r->>'issuer',r->>'subject',r->>'personId',r FROM jsonb_array_elements($1::jsonb) r", [JSON.stringify(seed.state.subjects)]);
    await c.query("INSERT INTO control_plane.organizations(id,tenant_id,created_by,record,generation) SELECT r->'record'->>'id',r->'record'->>'tenantId',r->'record'->>'createdBy',r->'record',(r->>'generation')::integer FROM jsonb_array_elements($1::jsonb) r", [JSON.stringify(seed.state.organizations)]);
    await c.query("INSERT INTO control_plane.memberships(organization_id,person_id,record,generation) SELECT r->'record'->>'organizationId',r->'record'->>'personId',r->'record',(r->>'generation')::integer FROM jsonb_array_elements($1::jsonb) r", [JSON.stringify(seed.state.memberships)]);
  });
  return { ...seed, prefix, accounts: new AccountService(new PostgresRepository(factory), seed.identity, { now: () => now }) };
}
async function attempt(action: Promise<unknown>) {
  try { await action; return true; }
  catch (error) { if (!(error instanceof AccountError)) throw error; return false; }
}
async function count(column: 'organization_id' | 'person_id', value: string, state?: 'active' | 'revoked') {
  const result = await query(`SELECT count(*)::integer AS count FROM control_plane.memberships WHERE ${column}=$1${state ? " AND record->>'state'=$2" : ''}`, state ? [value, state] : [value]);
  return Number(result.rows[0].count);
}

describe.skipIf(!url)('REAL pinned Neon capacity admission and recovery', () => {
  beforeAll(() => {
    const target = new URL(url!);
    if (process.env.CP_TEST_BRANCH_ID !== 'br-spring-rice-aewy6iui' || target.hostname !== 'ep-proud-pine-ae5x76kc.c-2.us-east-2.aws.neon.tech' || target.pathname !== '/b01_validation_accounts')
      throw new Error('Only the authorized isolated B01 repair fixture is allowed.');
    factory = neonClientFactory(url!);
  });
  it('refuses creation at 100 without making enumeration unavailable', async () => {
    const { accounts, personId } = await setup(100);
    const created = await attempt(accounts.createOrganization('alice', 'Beyond capacity'));
    const readable = await accounts.listWorkspaces('alice').then(v => v.organizations.length, error => {
      if (!(error instanceof AccountError)) throw error; return `HTTP ${error.status}`;
    });
    expect({ created, rows: await count('person_id', personId('alice')), readable }).toEqual({ created: false, rows: 100, readable: 100 });
  }, 30_000);
  it('refuses member 1001 and leaves owner management usable', async () => {
    const { accounts, organizationId, prefix } = await setup(1, 1000);
    const invite = await accounts.invite('alice', organizationId(0), { subject: `user_${prefix}bob`, role: 'member', ttlMs: 5000 });
    const accepted = await attempt(accounts.acceptInvitation('bob', organizationId(0), invite.token));
    const ownerStatus = await accounts.membership('alice', organizationId(0)).then(() => 200, error => {
      if (!(error instanceof AccountError)) throw error; return error.status;
    });
    expect({ accepted, rows: await count('organization_id', organizationId(0)), ownerStatus }).toEqual({ accepted: false, rows: 1000, ownerStatus: 200 });
  }, 30_000);
  it('counts active members rather than retained revoked rows and enforces recipient capacity', async () => {
    const { accounts, organizationId, prefix, personId } = await setup(100, 999, 1010);
    const invite = await accounts.invite('alice', organizationId(0), { subject: `user_${prefix}bob`, role: 'member', ttlMs: 5000 });
    expect(await attempt(accounts.acceptInvitation('bob', organizationId(0), invite.token))).toBe(true);
    expect(await count('organization_id', organizationId(0), 'active')).toBe(1000);
    expect(await count('organization_id', organizationId(0), 'revoked')).toBe(1010);
    const bobOrg = await accounts.createOrganization('bob', 'Other organization');
    const tooMany = await accounts.invite('bob', bobOrg.id, { subject: `user_${prefix}alice`, role: 'member', ttlMs: 5000 });
    expect(await attempt(accounts.acceptInvitation('alice', bobOrg.id, tooMany.token))).toBe(false);
    expect(await count('person_id', personId('alice'), 'active')).toBe(100);
  }, 30_000);
  it('permits over-limit recovery and protects the last owner beyond the former read window', async () => {
    const { accounts, organizationId, personId } = await setup(103, 1002);
    await query("INSERT INTO control_plane.memberships(organization_id,person_id,record,generation) SELECT organization_id,$1,jsonb_set(record,'{personId}',to_jsonb($1::text)),0 FROM control_plane.memberships WHERE person_id=$2 AND organization_id IN ($3,$4)", [personId('bob'), personId('alice'), organizationId(24), organizationId(26)]);
    expect((await accounts.membership('alice', organizationId(0))).membership.role).toBe('owner');
    await accounts.setMembership('alice', organizationId(0), personId('filler_00001'), { role: 'member', state: 'revoked' });
    expect(await count('organization_id', organizationId(0), 'active')).toBe(1001);
    await expect(accounts.setMembership('alice', organizationId(0), personId('alice'), { role: 'member', state: 'revoked' })).rejects.toMatchObject({ status: 409 });
    const first = await accounts.workspacePage('alice');
    expect(first.organizations).toHaveLength(25);
    await accounts.setMembership('bob', organizationId(24), personId('alice'), { role: 'member', state: 'revoked' });
    await accounts.setMembership('bob', organizationId(26), personId('alice'), { role: 'member', state: 'revoked' });
    const visited = first.organizations.map(row => row.organization.id);
    let after = first.nextCursor;
    while (after !== null) {
      const page = await accounts.workspacePage('alice', after);
      expect(page.organizations.length).toBeLessThanOrEqual(25);
      visited.push(...page.organizations.map(row => row.organization.id)); after = page.nextCursor;
    }
    expect(new Set(visited).size).toBe(102);
    expect(visited).toEqual(Array.from({ length: 103 }, (_, i) => organizationId(i)).filter(id => id !== organizationId(26)));
  }, 30_000);
  it('serializes creation versus invitation admission for one person at 99 workspaces', async () => {
    const { accounts, prefix, personId } = await setup(99);
    const target = await accounts.createOrganization('bob', 'Incoming');
    const invite = await accounts.invite('bob', target.id, { subject: `user_${prefix}alice`, role: 'member', ttlMs: 5000 });
    const outcomes = await Promise.all([attempt(accounts.createOrganization('alice', 'Concurrent')), attempt(accounts.acceptInvitation('alice', target.id, invite.token))]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await count('person_id', personId('alice'), 'active')).toBe(100);
  }, 30_000);
  it('serializes different recipients competing for member 1000', async () => {
    const { accounts, organizationId, prefix } = await setup(1, 999);
    const a = await accounts.invite('alice', organizationId(0), { subject: `user_${prefix}bob`, role: 'member', ttlMs: 5000 });
    const b = await accounts.invite('alice', organizationId(0), { subject: `user_${prefix}carol`, role: 'member', ttlMs: 5000 });
    const outcomes = await Promise.all([attempt(accounts.acceptInvitation('bob', organizationId(0), a.token)), attempt(accounts.acceptInvitation('carol', organizationId(0), b.token))]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await count('organization_id', organizationId(0), 'active')).toBe(1000);
  }, 30_000);
});
