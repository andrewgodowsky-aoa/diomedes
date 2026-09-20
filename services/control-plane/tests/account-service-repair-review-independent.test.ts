import { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { accountStateSchema, type AccountState } from '../src/domain.js';
import { inTransaction, neonClientFactory, PostgresRepository, TransactionCleanupError, type ClientFactory, type SqlClient } from '../src/postgres.js';
import { createHandler } from '../src/worker.js';
import { AccountService as DesktopAccounts } from '../../../server/business/account-service.js';
import type { AccountRepository as DesktopRepository } from '../../../server/business/account-contract.js';
import { capacitySeed, seededMemory } from './support/capacity-fixtures.js';
import { now, validEnv } from './support/fixtures.js';

// Repair-review additions only. The original thirty reviewer cases are immutable.
// Offline cases do not establish SQL locking or hosted Worker execution.
const at = new Date(now).toISOString();
async function setup(workspaces: number, members = 1, revoked = 0) {
  const seed = capacitySeed(workspaces, members, revoked);
  const memory = await seededMemory(seed.state);
  return { ...seed, memory, accounts: new AccountService(memory, seed.identity, { now: () => now }) };
}

describe('independent repair recovery and enumeration', () => {
  it('does not count revoked owners as replacements when recovering an over-limit organization', async () => {
    const seed = capacitySeed(1, 1002, 1002);
    for (const row of seed.state.memberships) if (row.record.state === 'revoked') row.record.role = 'owner';
    const memory = await seededMemory(seed.state);
    const accounts = new AccountService(memory, seed.identity, { now: () => now });
    const org = seed.organizationId(0);
    const before = memory.snapshot();
    await expect(accounts.setMembership('alice', org, seed.personId('alice'), { state: 'revoked', role: 'member' }))
      .rejects.toMatchObject({ status: 409 });
    expect(memory.snapshot()).toEqual(before);
    await accounts.setMembership('alice', org, seed.personId('filler_00001'), { state: 'active', role: 'owner' });
    await accounts.setMembership('filler_00001', org, seed.personId('alice'), { state: 'revoked', role: 'member' });
    await expect(accounts.membership('alice', org)).rejects.toMatchObject({ status: 403 });
    expect((await accounts.membership('filler_00001', org)).membership.role).toBe('owner');
  });

  it.each([0, 24, 25, 26, 50, 51])('ends correctly and returns every active workspace at count %i', async count => {
    const { accounts, organizationId } = await setup(count);
    const seen: string[] = [];
    let cursor: string | null = null;
    let requests = 0;
    do {
      const page = await accounts.workspacePage('alice', cursor ?? undefined);
      requests++;
      expect(requests).toBeLessThanOrEqual(3);
      expect(page.organizations.length).toBeLessThanOrEqual(25);
      seen.push(...page.organizations.map(row => row.organization.id));
      cursor = page.nextCursor;
      if (cursor !== null) expect(cursor).toBe(page.organizations.at(-1)?.organization.id);
    } while (cursor !== null);
    expect(seen).toEqual(Array.from({ length: count }, (_, index) => organizationId(index)));
    expect(new Set(seen).size).toBe(count);
    expect(requests).toBe(Math.max(1, Math.ceil(count / 25)));
  });

  it('keeps the desktop wrapper complete above 100 and refuses a cloud page aged beyond five seconds', async () => {
    const seed = capacitySeed(105);
    class LocalRepository implements DesktopRepository {
      state: AccountState = structuredClone(seed.state);
      readonly scope = `repair-review-${crypto.randomUUID()}`;
      async read<T>(action: (state: AccountState) => T | Promise<T>): Promise<T> { return action(structuredClone(this.state)); }
      async transact<T>(action: (state: AccountState) => T | Promise<T>): Promise<T> {
        const draft = structuredClone(this.state);
        const result = await action(draft);
        this.state = accountStateSchema.parse(draft);
        return structuredClone(result);
      }
    }
    const local = await new DesktopAccounts(new LocalRepository(), seed.identity, { now: () => now }).listWorkspaces('alice');
    expect(Object.keys(local).sort()).toEqual(['organizations', 'person']);
    expect(local.organizations.map(row => row.organization.id)).toEqual(seed.state.organizations.map(row => row.record.id));
    let time = now;
    const memory = await seededMemory(seed.state);
    const before = memory.snapshot();
    const accounts = new AccountService({ transaction: action => memory.transaction(tx => {
      const delayed = Object.create(tx) as typeof tx;
      delayed.workspaceRows = async (...args) => { const rows = await tx.workspaceRows(...args); time += 5001; return rows; };
      return action(delayed);
    }) }, seed.identity, { now: () => time });
    await expect(accounts.workspacePage('alice')).rejects.toMatchObject({ status: 401 });
    expect(memory.snapshot()).toEqual(before);
  });
});

function joinedFixture(overrides: Record<string, unknown> = {}) {
  const seed = capacitySeed(1);
  return { member_record: seed.state.memberships[0].record, member_generation: 0,
    organization_record: seed.state.organizations[0].record, organization_generation: 0, ...overrides };
}
function projectionDatabase(records: Record<string, unknown>[]) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const client: SqlClient = { async connect() {}, async end() {}, async query(sql, values = []) {
    queries.push({ sql, values });
    return sql.startsWith('SELECT m.record') ? { rows: records, rowCount: records.length } : { rows: [], rowCount: 0 };
  } };
  return { queries, repository: new PostgresRepository(() => client) };
}

describe('independent joined projection refusal', () => {
  it.each([
    ['missing joined organization', { organization_record: null }],
    ['negative organization generation', { organization_generation: -1 }],
    ['non-numeric membership generation', { member_generation: '0' }],
    ['null member person', { member_record: { ...joinedFixture().member_record, personId: null } }],
    ['invalid member role', { member_record: { ...joinedFixture().member_record, role: 'administrator' } }],
  ])('rolls back for %s instead of producing a partial page', async (_label, overrides) => {
    const { repository, queries } = projectionDatabase([joinedFixture(overrides)]);
    await expect(repository.transaction(tx => tx.workspaceRows('person_zz_alice'))).rejects.toThrow();
    expect(queries.map(query => query.sql)).toContain('ROLLBACK');
    expect(queries.map(query => query.sql)).not.toContain('COMMIT');
  });
  it('validates the lookahead row as well as the first 25 returned rows', async () => {
    const { repository, queries } = projectionDatabase([
      ...Array.from({ length: 25 }, () => joinedFixture()), joinedFixture({ organization_generation: null }),
    ]);
    await expect(repository.transaction(tx => tx.workspaceRows('person_zz_alice'))).rejects.toThrow();
    expect(queries.map(query => query.sql)).not.toContain('COMMIT');
  });
  it('scopes the single bounded join to the current person, active state and exclusive cursor', async () => {
    const { repository, queries } = projectionDatabase([joinedFixture()]);
    await repository.transaction(tx => tx.workspaceRows('person_zz_alice', 'org_0024'));
    const reads = queries.filter(query => query.sql.startsWith('SELECT'));
    expect(reads).toHaveLength(1);
    expect(reads[0].values).toEqual(['person_zz_alice', 'org_0024']);
    expect(reads[0].sql).toContain('o.id=m.organization_id');
    expect(reads[0].sql).toContain("m.person_id=$1 AND m.record->>'state'='active'");
    expect(reads[0].sql).toContain('m.organization_id>$2');
    expect(reads[0].sql).toContain('ORDER BY m.organization_id LIMIT 26');
  });
});

describe('independent continuation preflight boundary', () => {
  it.each(['?after=', '?after=org_1&%61fter=org_2', '?after=org_1&role=owner', '?after=org%2F1'])
    ('refuses malformed continuation %s before creating an adapter', async query => {
      const factory = vi.fn();
      const handler = createHandler(factory);
      for (const method of ['GET', 'OPTIONS']) {
        const response = await handler(new Request(`https://review.invalid/account/session${query}`, {
          method, headers: { Origin: validEnv.ALLOWED_ORIGINS, Authorization: 'Bearer alice',
            'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
        }), validEnv);
        expect(response.status).toBe(422);
      }
      expect(factory).not.toHaveBeenCalled();
    });
  it('allows the preflight without an account adapter but still requires bearer proof for the page', async () => {
    const factory = vi.fn();
    const handler = createHandler(factory);
    const url = 'https://review.invalid/account/session?after=org_0024';
    const preflight = await handler(new Request(url, { method: 'OPTIONS', headers: {
      Origin: validEnv.ALLOWED_ORIGINS, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
    } }), validEnv);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(validEnv.ALLOWED_ORIGINS);
    expect((await handler(new Request(url, { headers: { Origin: validEnv.ALLOWED_ORIGINS } }), validEnv)).status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });
});

class ReviewClient extends EventEmitter implements SqlClient {
  calls: string[] = [];
  queryHook: (sql: string) => void = () => {};
  endHook: () => void | Promise<void> = () => {};
  async connect() { this.calls.push('connect'); }
  async query(sql: string) { this.calls.push(sql); this.queryHook(sql); return { rows: [], rowCount: 0 }; }
  async end() { this.calls.push('end'); await this.endHook(); }
}

describe('independent error events and uncertain outcomes', () => {
  it.each(['BEGIN', "SET LOCAL statement_timeout = '5s'", "SET LOCAL lock_timeout = '3s'", "SET LOCAL idle_in_transaction_session_timeout = '6s'"])
    ('owns an event at %s before any account action', async stage => {
      const client = new ReviewClient();
      const failure = new Error('review setup transport error');
      client.queryHook = sql => { if (sql === stage) client.emit('error', failure); };
      const action = vi.fn(async () => 'not reached');
      await expect(inTransaction(() => client, action)).rejects.toBe(failure);
      expect(action).not.toHaveBeenCalled();
      expect(client.calls).toContain('ROLLBACK');
      expect(client.calls).not.toContain('COMMIT');
      expect(client.calls.filter(call => call === 'end')).toHaveLength(1);
    });
  it('retains separate action, rollback, close and asynchronous errors without replay', async () => {
    const client = new ReviewClient();
    const failures = ['action', 'rollback', 'close', 'event'].map(label => new Error(label));
    client.queryHook = sql => { if (sql === 'ROLLBACK') throw failures[1]; };
    client.endHook = () => { throw failures[2]; };
    const action = vi.fn(async () => { client.emit('error', failures[3]); throw failures[0]; });
    await expect(inTransaction(() => client, action)).rejects.toMatchObject({ failures });
    expect(action).toHaveBeenCalledTimes(1);
    expect(client.calls).not.toContain('COMMIT');
    // A failed close still has an error owner; a later duplicate is not unhandled.
    expect(() => client.emit('error', failures[3])).not.toThrow();
  });
  it('fails on an asynchronous event while awaiting end, without rolling back an acknowledged commit', async () => {
    const client = new ReviewClient();
    const failure = new Error('pending close transport error');
    let signalClosing!: () => void;
    let releaseClose!: () => void;
    const closing = new Promise<void>(resolve => { signalClosing = resolve; });
    const gate = new Promise<void>(resolve => { releaseClose = resolve; });
    client.endHook = () => { signalClosing(); return gate; };
    const action = vi.fn(async () => 'durable');
    const transaction = inTransaction(() => client, action);
    const rejected = expect(transaction).rejects.toBe(failure);
    await closing;
    expect(() => client.emit('error', failure)).not.toThrow();
    releaseClose();
    await rejected;
    expect(client.calls).not.toContain('ROLLBACK');
    expect(client.calls.filter(call => call === 'COMMIT')).toHaveLength(1);
    expect(action).toHaveBeenCalledTimes(1);
  });
  it('does not classify a rejected COMMIT as confirmed closure or discard its event and cleanup failures', async () => {
    const client = new ReviewClient();
    const commit = new Error('commit response lost');
    const event = new Error('transport notification');
    const close = new Error('close failed');
    client.queryHook = sql => { if (sql === 'COMMIT') { client.emit('error', event); throw commit; } };
    client.endHook = () => { throw close; };
    const action = vi.fn(async () => 'uncertain');
    const failure = await inTransaction(() => client, action).catch(error => error);
    expect(failure).toBeInstanceOf(TransactionCleanupError);
    expect(failure.failures).toEqual([commit, close, event]);
    expect(client.calls.filter(call => call === 'COMMIT')).toHaveLength(1);
    expect(client.calls.filter(call => call === 'ROLLBACK')).toHaveLength(1);
    expect(action).toHaveBeenCalledTimes(1);
  });
  it('keeps post-close notifications local while a subsequent request can still fail independently', async () => {
    const first = new ReviewClient();
    expect(await inTransaction(() => first, async () => 'committed')).toBe('committed');
    const second = new ReviewClient();
    const failure = new Error('second request active failure');
    await expect(inTransaction(() => second, async () => {
      first.emit('error', new Error('late first notification'));
      first.emit('error', new Error('duplicate first notification'));
      second.emit('error', failure);
    })).rejects.toBe(failure);
    expect(first.calls.filter(call => call === 'COMMIT')).toHaveLength(1);
    expect(second.calls).not.toContain('COMMIT');
  });
});

const databaseUrl = process.env.CP_TEST_DATABASE_URL;
let liveFactory: ClientFactory;
async function liveSetup(workspaces: number, members = 1, revoked = 0, revokedBob = false) {
  const prefix = `review2_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}_`;
  const seed = capacitySeed(workspaces, members, revoked, prefix);
  if (revokedBob) seed.state.memberships.push({ generation: 7, record: { ...seed.state.memberships[0].record,
    personId: seed.personId('bob'), role: 'member', state: 'revoked', revokedAt: at, revokedReason: 'Review history' } });
  await inTransaction(liveFactory, async client => {
    await client.query("INSERT INTO control_plane.persons(id,record) SELECT r->>'id',r FROM jsonb_array_elements($1::jsonb) r", [JSON.stringify(seed.state.persons)]);
    await client.query("INSERT INTO control_plane.external_subjects(issuer,subject,person_id,record) SELECT r->>'issuer',r->>'subject',r->>'personId',r FROM jsonb_array_elements($1::jsonb) r", [JSON.stringify(seed.state.subjects)]);
    await client.query("INSERT INTO control_plane.organizations(id,tenant_id,created_by,record,generation) SELECT r->'record'->>'id',r->'record'->>'tenantId',r->'record'->>'createdBy',r->'record',(r->>'generation')::integer FROM jsonb_array_elements($1::jsonb) r", [JSON.stringify(seed.state.organizations)]);
    await client.query("INSERT INTO control_plane.memberships(organization_id,person_id,record,generation) SELECT r->'record'->>'organizationId',r->'record'->>'personId',r->'record',(r->>'generation')::integer FROM jsonb_array_elements($1::jsonb) r", [JSON.stringify(seed.state.memberships)]);
  });
  const repository = new PostgresRepository(liveFactory);
  return { ...seed, prefix, repository, accounts: new AccountService(repository, seed.identity, { now: () => now }) };
}

describe.skipIf(!databaseUrl)('REAL independent pinned Neon repair', () => {
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (process.env.CP_TEST_BRANCH_ID !== 'br-spring-rice-aewy6iui' || target.hostname !== 'ep-proud-pine-ae5x76kc.c-2.us-east-2.aws.neon.tech' || target.pathname !== '/b01_validation_accounts')
      throw new Error('Only the approved disposable repair fixture is permitted.');
    liveFactory = neonClientFactory(databaseUrl!);
  });
  it('reuses a refused invitation after freeing capacity and increments the existing revoked membership', async () => {
    const { accounts, repository, organizationId, personId, prefix } = await liveSetup(1, 1000, 1002, true);
    const org = organizationId(0);
    const invitation = await accounts.invite('alice', org, { subject: `user_${prefix}bob`, role: 'member', ttlMs: 5000 });
    await expect(accounts.acceptInvitation('bob', org, invitation.token)).rejects.toMatchObject({ status: 409 });
    expect((await repository.transaction(tx => tx.member(org, personId('bob'))))?.generation).toBe(7);
    await accounts.setMembership('alice', org, personId('filler_00001'), { state: 'revoked', role: 'member' });
    expect((await accounts.acceptInvitation('bob', org, invitation.token)).state).toBe('active');
    const row = await repository.transaction(tx => tx.member(org, personId('bob')));
    expect(row).toMatchObject({ generation: 8, record: { state: 'active', revokedAt: null, revokedReason: null } });
    await expect(accounts.acceptInvitation('bob', org, invitation.token)).rejects.toMatchObject({ status: 409 });
    const result = await inTransaction(liveFactory, client => client.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE record->>'state'='active')::int AS active FROM control_plane.memberships WHERE organization_id=$1", [org]));
    expect(result.rows[0]).toEqual({ total: 2003, active: 1000 });
  }, 30_000);
  it('uses current membership after cursor and lookahead revocation without omitting other workspaces', async () => {
    const { accounts, repository, organizationId, personId } = await liveSetup(51);
    const bobOrgs = [24, 25, 26, 40, 50];
    await repository.transaction(async tx => {
      for (const index of bobOrgs) await tx.saveMembership({ generation: 0,
        record: { ...(await tx.member(organizationId(index), personId('alice')))!.record, personId: personId('bob') } });
    });
    const first = await accounts.workspacePage('alice');
    expect(first.nextCursor).toBe(organizationId(24));
    for (const index of [24, 25]) await accounts.setMembership('bob', organizationId(index), personId('alice'), { state: 'revoked', role: 'member' });
    await accounts.setMembership('bob', organizationId(26), personId('alice'), { state: 'active', role: 'member' });
    const second = await accounts.workspacePage('alice', first.nextCursor!);
    expect(second.nextCursor).toBeNull();
    expect(second.organizations.map(row => row.organization.id)).toEqual(Array.from({ length: 25 }, (_, index) => organizationId(index + 26)));
    expect(second.organizations[0].membership.role).toBe('member');
    const seen = [...first.organizations, ...second.organizations].map(row => row.organization.id);
    expect(new Set(seen).size).toBe(50);
    expect((await accounts.workspacePage('bob')).organizations.map(row => row.organization.id)).toEqual(bobOrgs.map(organizationId));
    expect((await accounts.listWorkspaces('alice')).organizations).toHaveLength(49);
  }, 30_000);
  it('rejects inconsistent JSON-to-column identity before a joined projection can disclose another row', async () => {
    const { repository, organizationId, personId } = await liveSetup(2);
    const mutations: [string, unknown[]][] = [
      ["UPDATE control_plane.memberships SET record=jsonb_set(record,'{personId}',to_jsonb($1::text)) WHERE organization_id=$2 AND person_id=$3", [personId('bob'), organizationId(0), personId('alice')]],
      ["UPDATE control_plane.memberships SET record=jsonb_set(record,'{organizationId}',to_jsonb($1::text)) WHERE organization_id=$2 AND person_id=$3", [organizationId(1), organizationId(0), personId('alice')]],
      ["UPDATE control_plane.organizations SET record=jsonb_set(record,'{id}',to_jsonb($1::text)) WHERE id=$2", [organizationId(1), organizationId(0)]],
    ];
    for (const [sql, values] of mutations) await expect(inTransaction(liveFactory, client => client.query(sql, values))).rejects.toMatchObject({ code: '23514' });
    const rows = await repository.transaction(tx => tx.workspaceRows(personId('alice')));
    expect(rows.map(row => row.organization.record.id)).toEqual([organizationId(0), organizationId(1)]);
    expect(rows.every(row => row.membership.record.personId === personId('alice') && row.membership.record.organizationId === row.organization.record.id)).toBe(true);
  }, 30_000);
});
