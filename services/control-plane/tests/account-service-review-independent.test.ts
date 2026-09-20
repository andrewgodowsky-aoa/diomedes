import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { AccountError } from '../src/errors.js';
import { WorkOSIdentityVerifier } from '../src/identity-workos.js';
import { inTransaction, PostgresRepository, TransactionCleanupError, type SqlClient } from '../src/postgres.js';
import { createHandler } from '../src/worker.js';
import { StateTransaction } from '../src/state-transaction.js';
import { accountStateSchema, emptyAccountState, type AccountState, type IdentityVerifier } from '../src/domain.js';
import { AccountService as DesktopAccounts } from '../../../server/business/account-service.js';
import type { AccountRepository as DesktopRepository } from '../../../server/business/account-contract.js';
import { MemoryRepository } from './support/memory.js';
import { now, verifier, validEnv } from './support/fixtures.js';

// Reviewer-authored cases. All identities, SQL clients and HTTP responses are
// synthetic. These cases do not qualify PostgreSQL locking or hosted CPU.
afterEach(() => { vi.useRealTimers(); });
const iso = (offset: number) => new Date(now + offset).toISOString();
const request = (path: string, init: RequestInit = {}) => new Request(`https://account.invalid${path}`, {
  ...init, headers: { Authorization: 'Bearer alice', ...init.headers },
});

describe('independent freshness and atomic refusal', () => {
  it.each([
    ['expired', { expiresAt: iso(0) }],
    ['stale verification', { verifiedAt: iso(-5001) }],
    ['future verification', { verifiedAt: iso(5001) }],
    ['future issue', { issuedAt: iso(5001) }],
    ['wrong issuer', { issuer: 'https://wrong.invalid' }],
    ['unverified email', { emailVerified: false }],
  ])('never opens storage for %s proof', async (_label, override) => {
    const transaction = vi.fn();
    const identity: IdentityVerifier = { issuer: verifier.issuer,
      async verify(token) { return { ...await verifier.verify(token), ...override }; } };
    const accounts = new AccountService({ transaction }, identity, { now: () => now });
    await expect(accounts.createOrganization('alice', 'Refused')).rejects.toBeInstanceOf(AccountError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rechecks freshness after the actual identity lock, before the first write', async () => {
    let time = now;
    const memory = new MemoryRepository();
    const save = vi.fn();
    const accounts = new AccountService({ transaction: action => memory.transaction(tx => {
      const delayed = Object.create(tx) as typeof tx;
      delayed.lockIdentity = async () => { time += 5001; };
      delayed.savePerson = save;
      return action(delayed);
    }) }, verifier, { now: () => time });
    await expect(accounts.createOrganization('alice', 'Refused')).rejects.toMatchObject({ status: 401 });
    expect(save).not.toHaveBeenCalled();
    expect(memory.snapshot()).toEqual(emptyAccountState());
  });

  it('rolls back person, session, organization, member and event when proof ages at the last write', async () => {
    let time = now;
    const memory = new MemoryRepository();
    const accounts = new AccountService({ transaction: action => memory.transaction(tx => {
      const delayed = Object.create(tx) as typeof tx;
      delayed.event = async event => { await tx.event(event); time += 5001; };
      return action(delayed);
    }) }, verifier, { now: () => time });
    await expect(accounts.createOrganization('alice', 'Refused')).rejects.toMatchObject({ status: 401 });
    expect(memory.snapshot()).toEqual(emptyAccountState());
  });

  it('does not persist a second person when a provider session is reused by another subject', async () => {
    const memory = new MemoryRepository();
    const accounts = new AccountService(memory, verifier, { now: () => now });
    await accounts.signIn('alice');
    const before = memory.snapshot();
    const conflicting: IdentityVerifier = { issuer: verifier.issuer,
      async verify(token) { return { ...await verifier.verify(token), sessionId: 'session_alice' }; } };
    await expect(new AccountService(memory, conflicting, { now: () => now }).signIn('bob'))
      .rejects.toMatchObject({ status: 401 });
    expect(memory.snapshot()).toEqual(before);
  });

  it('retains a session tombstone even with a later expiry and a new service instance', async () => {
    const memory = new MemoryRepository();
    await new AccountService(memory, verifier, { now: () => now }).revokeLocalSession('alice');
    const before = memory.snapshot();
    const refreshed: IdentityVerifier = { issuer: verifier.issuer,
      async verify(token) { return { ...await verifier.verify(token), expiresAt: iso(600_000) }; } };
    await expect(new AccountService(memory, refreshed, { now: () => now }).createOrganization('alice', 'Refused'))
      .rejects.toMatchObject({ status: 401 });
    expect(memory.snapshot()).toEqual(before);
  });
});

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
function providerFixture(extraClaims: Record<string, unknown> = {}) {
  let active = true;
  const calls: { url: string; init?: RequestInit }[] = [];
  const key = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'review', alg: 'RS256', use: 'sig' };
  const unsigned = [{ alg: 'RS256', kid: 'review', typ: 'JWT' }, {
    iss: verifier.issuer, client_id: 'client_review', aud: 'review-resource',
    sub: 'user_attacker', sid: 'session_attacker', iat: now / 1000 - 1, exp: now / 1000 + 300,
    ...extraClaims,
  }].map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
  const token = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url')}`;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url === 'https://api.workos.com/sso/jwks/client_review') return Response.json({ keys: [key] });
    if (url === 'https://api.workos.com/user_management/users/user_attacker/sessions?limit=100')
      return Response.json({ data: [{ id: 'session_attacker', user_id: 'user_attacker',
        status: active ? 'active' : 'revoked', expires_at: iso(600_000), ended_at: active ? null : iso(0) }],
        list_metadata: { after: null } });
    if (url === 'https://api.workos.com/user_management/users/user_attacker')
      return Response.json({ id: 'user_attacker', email_verified: true, first_name: 'Reviewer fixture' });
    throw new Error('Unexpected offline provider fixture URL.');
  };
  const identity = new WorkOSIdentityVerifier({ issuer: verifier.issuer, clientId: 'client_review',
    audience: 'review-resource', apiKey: 'sk_test_review_fixture_only', fetch: fetcher, now: () => now });
  return { identity, token, calls, revoke: () => { active = false; } };
}

describe('independent real signature and current provider checks', () => {
  it('cannot use signed provider role, organization or paid claims to administer another tenant', async () => {
    const memory = new MemoryRepository();
    const owner = new AccountService(memory, verifier, { now: () => now });
    const org = await owner.createOrganization('alice', 'Owner workspace');
    const before = memory.snapshot();
    const fixture = providerFixture({ org_id: org.id, role: 'owner', permissions: ['admin'], plan: 'paid' });
    const attacker = new AccountService(memory, fixture.identity, { now: () => now });
    await expect(attacker.invite(fixture.token, org.id, { subject: 'user_other', role: 'owner', ttlMs: 5000 }))
      .rejects.toMatchObject({ status: 403 });
    expect(memory.snapshot()).toEqual(before);
    expect(fixture.calls).toHaveLength(3);
  });

  it('rechecks provider revocation for the same signed token despite the cached signing key', async () => {
    const fixture = providerFixture();
    const memory = new MemoryRepository();
    const accounts = new AccountService(memory, fixture.identity, { now: () => now });
    await accounts.signIn(fixture.token);
    const before = memory.snapshot(); fixture.revoke();
    await expect(accounts.createOrganization(fixture.token, 'Revoked')).rejects.toMatchObject({ status: 401 });
    expect(memory.snapshot()).toEqual(before);
    expect(fixture.calls.filter(call => call.url.includes('/sso/jwks/'))).toHaveLength(1);
    expect(fixture.calls.filter(call => call.url.includes('/sessions?'))).toHaveLength(2);
    for (const call of fixture.calls) {
      expect(call.init?.redirect).toBe('error');
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(call.init?.headers);
      expect(headers.has('Authorization')).toBe(!call.url.includes('/sso/jwks/'));
    }
  });
});

// A separate local snapshot adapter exercises only the portable-to-desktop
// boundary. Original file-store/Trust tests remain unchanged in the candidate.
class LocalRepository implements DesktopRepository {
  state: AccountState = emptyAccountState();
  readonly scope = `review-${crypto.randomUUID()}`;
  async read<T>(action: (state: AccountState) => T | Promise<T>): Promise<T> {
    return action(structuredClone(this.state));
  }
  async transact<T>(action: (state: AccountState) => T | Promise<T>): Promise<T> {
    const draft = structuredClone(this.state);
    const result = await action(draft);
    this.state = accountStateSchema.parse(draft);
    return structuredClone(result);
  }
}

describe('independent portable extraction boundary', () => {
  it('does not accept an otherwise current cloud snapshot as a local in-process capability', async () => {
    const repository = new LocalRepository();
    const local = new DesktopAccounts(repository, verifier, { now: () => now });
    const org = await local.createOrganization('alice', 'One');
    const portable = new AccountService({ transaction: action => repository.transact(state => action(new StateTransaction(state))) }, verifier, { now: () => now });
    const cloud = await portable.membership('alice', org.id);
    const effect = vi.fn();
    await expect(local.withCurrentMembership(cloud, effect)).rejects.toMatchObject({ status: 401 });
    expect(effect).not.toHaveBeenCalled();
    const current = await local.membership('alice', org.id);
    expect(await local.withCurrentMembership(current, value => value.organization.id)).toBe(org.id);
  });

  it('pins the shorter JWT lifetime even when the persisted provider session had a longer expiry', async () => {
    const repository = new LocalRepository();
    let time = now;
    const long = new DesktopAccounts(repository, verifier, { now: () => time });
    const org = await long.createOrganization('alice', 'One');
    const shortIdentity: IdentityVerifier = { issuer: verifier.issuer,
      async verify(token) { return { ...await verifier.verify(token), expiresAt: iso(1000) }; } };
    const short = new DesktopAccounts(repository, shortIdentity, { now: () => time });
    const snapshot = await short.membership('alice', org.id);
    expect(snapshot.validUntil).toBe(iso(1000));
    time += 1000;
    const effect = vi.fn();
    await expect(short.withCurrentMembership(snapshot, effect)).rejects.toMatchObject({ status: 401 });
    expect(effect).not.toHaveBeenCalled();
  });
});

describe('independent HTTP admission and failure confidentiality', () => {
  it.each([
    ['same-site missing Origin', { 'Sec-Fetch-Site': 'same-site' }, 403],
    ['cross-site missing Origin', { 'Sec-Fetch-Site': 'cross-site' }, 403],
    ['opaque Origin', { Origin: 'null' }, 403],
    ['duplicate bearer', { Authorization: 'Bearer alice, Bearer bob' }, 401],
    ['overlong bearer', { Authorization: `Bearer ${'a'.repeat(16_385)}` }, 401],
    ['ambient cookie', { Authorization: '', Cookie: 'session=alice' }, 401],
  ] as const)('refuses %s before constructing an account adapter', async (_label, headers, status) => {
    const create = vi.fn();
    const response = await createHandler(create)(request('/account/session', { headers }), validEnv);
    expect(response.status).toBe(status);
    expect(create).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each([
    ['invalid UTF-8', new Uint8Array([0xff]), 422],
    ['extra authority field', new TextEncoder().encode('{"name":"One","tenantId":"stolen"}'), 422],
    ['oversize multi-byte body', new TextEncoder().encode(JSON.stringify({ name: '\u00e9'.repeat(8192) })), 413],
  ] as const)('refuses %s before verifying identity or writing', async (_label, bytes, status) => {
    const memory = new MemoryRepository();
    const verify = vi.fn(verifier.verify.bind(verifier));
    const accounts = new AccountService(memory, { issuer: verifier.issuer, verify }, { now: () => now });
    const response = await createHandler(() => accounts)(request('/account/organizations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bytes,
    }), validEnv);
    expect(response.status).toBe(status);
    expect(verify).not.toHaveBeenCalled();
    expect(memory.snapshot()).toEqual(emptyAccountState());
  });

  it('redacts raw transaction and nested cleanup errors from response and logs', async () => {
    const secret = 'REVIEW_FIXTURE_PRIVATE_DRIVER_DETAIL';
    const accounts = new AccountService({ transaction: async () => {
      throw new TransactionCleanupError([new Error(secret), new Error(`nested ${secret}`)]);
    } }, verifier, { now: () => now });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await createHandler(() => accounts)(request('/account/session'), validEnv);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(secret);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('independent transaction uncertainty and durable inbox protocol', () => {
  it('retains commit, rollback and close failures without replaying the action', async () => {
    const failures = [new Error('lost commit response'), new Error('lost rollback response'), new Error('close failed')];
    const calls: string[] = [];
    const client: SqlClient = { async connect() {}, async query(sql) {
      calls.push(sql);
      if (sql === 'COMMIT') throw failures[0];
      if (sql === 'ROLLBACK') throw failures[1];
      return { rows: [], rowCount: 0 };
    }, async end() { throw failures[2]; } };
    const action = vi.fn(async () => 'effect-result');
    await expect(inTransaction(() => client, action)).rejects.toMatchObject({ failures });
    expect(action).toHaveBeenCalledTimes(1);
    expect(calls.filter(sql => sql === 'COMMIT')).toHaveLength(1);
  });

  it('does not roll back or replay after an acknowledged commit followed by close failure', async () => {
    const calls: string[] = [];
    const failure = new Error('close failed after durable commit');
    const client: SqlClient = { async connect() {}, async query(sql) {
      calls.push(sql); return { rows: [], rowCount: 0 };
    }, async end() { throw failure; } };
    const action = vi.fn(async () => 'effect-result');
    await expect(inTransaction(() => client, action)).rejects.toBe(failure);
    expect(action).toHaveBeenCalledTimes(1);
    expect(calls).toContain('COMMIT');
    expect(calls).not.toContain('ROLLBACK');
  });

  it('does not insert or commit an inbox event for an unmapped customer', async () => {
    const calls: string[] = [];
    const client: SqlClient = { async connect() {}, async query(sql) {
      calls.push(sql); return { rows: [], rowCount: 0 };
    }, async end() {} };
    await expect(new PostgresRepository(() => client).recordVerifiedWebhook({ provider: 'stripe',
      eventId: 'evt_review', customerId: 'cus_unknown', payloadHash: 'a'.repeat(64), eventType: 'review', payload: {} }))
      .rejects.toMatchObject({ status: 409 });
    expect(calls.some(sql => sql.startsWith('INSERT INTO control_plane.webhook_inbox'))).toBe(false);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  it('rejects an oversized inbox payload before connecting to SQL', async () => {
    const factory = vi.fn();
    await expect(new PostgresRepository(factory).recordVerifiedWebhook({ provider: 'stripe',
      eventId: 'evt_review', customerId: 'cus_review', payloadHash: 'a'.repeat(64), eventType: 'review',
      payload: { data: '\u00e9'.repeat(131_073) } })).rejects.toMatchObject({ status: 413 });
    expect(factory).not.toHaveBeenCalled();
  });
});

/** SQL protocol model for the read-capacity edge only. The real adapter parses
 * rows, chooses LIMITs and performs its ordinary writes; this fixture supplies
 * no SQL constraint or concurrency proof. Parent owns real-DB confirmation. */
function capacityDatabase(seed: AccountState) {
  let durable = structuredClone(seed);
  const factory = (): SqlClient => {
    let draft = structuredClone(durable);
    const rows = (values: unknown[]) => ({ rows: values as Record<string, unknown>[], rowCount: values.length });
    return {
      async connect() {}, async end() {},
      async query(sql, values = []) {
        if (sql === 'BEGIN') { draft = structuredClone(durable); return rows([]); }
        if (sql === 'COMMIT') { durable = structuredClone(draft); return rows([]); }
        if (sql === 'ROLLBACK' || sql.startsWith('SET LOCAL') || sql.startsWith('SELECT pg_advisory')) return rows([]);
        if (sql.startsWith('SELECT record FROM control_plane.external_subjects'))
          return rows(draft.subjects.filter(row => row.issuer === values[0] && row.subject === values[1]).map(record => ({ record })));
        if (sql.startsWith('SELECT record FROM control_plane.persons'))
          return rows(draft.persons.filter(row => row.id === values[0]).map(record => ({ record })));
        if (sql.startsWith('SELECT record FROM control_plane.sessions'))
          return rows(draft.sessions.filter(row => row.issuer === values[0] && row.sessionId === values[1]).map(record => ({ record })));
        if (sql.startsWith('SELECT record,generation FROM control_plane.organizations'))
          return rows(draft.organizations.filter(row => row.record.id === values[0]));
        if (sql.startsWith('SELECT record,generation FROM control_plane.memberships WHERE organization_id'))
          return rows(draft.memberships.filter(row => row.record.organizationId === values[0]).slice(0, 1001));
        if (sql.startsWith('SELECT record,generation FROM control_plane.memberships WHERE person_id'))
          return rows(draft.memberships.filter(row => row.record.personId === values[0]).slice(0, 101));
        if (sql.startsWith('SELECT record FROM control_plane.invitations'))
          return rows(draft.invitations.filter(row => row.tokenHash === values[0]).map(record => ({ record })));
        const tx = new StateTransaction(draft);
        if (sql.startsWith('INSERT INTO control_plane.sessions')) await tx.saveSession(JSON.parse(String(values[5])));
        else if (sql.startsWith('INSERT INTO control_plane.organizations'))
          await tx.saveOrganization({ record: JSON.parse(String(values[3])), generation: Number(values[4]) });
        else if (sql.startsWith('INSERT INTO control_plane.memberships'))
          await tx.saveMembership({ record: JSON.parse(String(values[2])), generation: Number(values[3]) });
        else if (sql.startsWith('INSERT INTO control_plane.invitations')) await tx.saveInvitation(JSON.parse(String(values[3])));
        else if (sql.startsWith('INSERT INTO control_plane.account_events')) await tx.event(JSON.parse(String(values[3])));
        else throw new Error(`Unexpected capacity fixture query: ${sql}`);
        return rows([]);
      },
    };
  };
  return { repository: new PostgresRepository(factory), snapshot: () => structuredClone(durable) };
}

describe('independent capacity boundary regressions', () => {
  it('does not commit a 101st organization that makes workspace enumeration unavailable', async () => {
    const memory = new MemoryRepository();
    const source = new AccountService(memory, verifier, { now: () => now });
    await source.createOrganization('alice', 'Seed');
    const seed = memory.snapshot();
    seed.organizations = Array.from({ length: 100 }, (_, index) => ({ ...seed.organizations[0],
      record: { ...seed.organizations[0].record, id: `org_capacity_${index}`, tenantId: `tenant_capacity_${index}` } }));
    seed.memberships = seed.organizations.map(org => ({ ...seed.memberships[0],
      record: { ...seed.memberships[0].record, organizationId: org.record.id } }));
    seed.events = [];
    const database = capacityDatabase(accountStateSchema.parse(seed));
    const accounts = new AccountService(database.repository, verifier, { now: () => now });
    expect((await accounts.listWorkspaces('alice')).organizations).toHaveLength(100);
    const created = await accounts.createOrganization('alice', 'One beyond readable capacity')
      .then(() => true, error => { if (!(error instanceof AccountError)) throw error; return false; });
    const readableCount = await accounts.listWorkspaces('alice').then(value => value.organizations.length,
      error => { if (!(error instanceof AccountError)) throw error; return `HTTP ${error.status}`; });
    // This intentionally fails on b52e9dd: success persisted an unreadable account.
    expect({ created, persisted: database.snapshot().organizations.length, readableCount })
      .toEqual({ created: false, persisted: 100, readableCount: 100 });
  });

  it('does not accept member 1001 and prevent the owner from removing that member', async () => {
    const memory = new MemoryRepository();
    const source = new AccountService(memory, verifier, { now: () => now });
    const org = await source.createOrganization('alice', 'Seed');
    const bob = await source.signIn('bob');
    const invitation = await source.invite('alice', org.id, { subject: 'user_bob', role: 'member', ttlMs: 5000 });
    const seed = memory.snapshot();
    const ownerPerson = seed.persons[0];
    const ownerMapping = seed.subjects[0];
    const ownerMembership = seed.memberships[0];
    for (let index = 1; index < 1000; index++) {
      const personId = `person_capacity_${index}`;
      seed.persons.push({ ...ownerPerson, id: personId });
      seed.subjects.push({ ...ownerMapping, personId, subject: `user_capacity_${index}` });
      seed.memberships.push({ generation: 0, record: { ...ownerMembership.record, personId, role: 'member' } });
    }
    const database = capacityDatabase(accountStateSchema.parse(seed));
    const accounts = new AccountService(database.repository, verifier, { now: () => now });
    const accepted = await accounts.acceptInvitation('bob', org.id, invitation.token)
      .then(() => true, error => { if (!(error instanceof AccountError)) throw error; return false; });
    const ownerStatus = await accounts.membership('alice', org.id).then(() => 200,
      error => { if (!(error instanceof AccountError)) throw error; return error.status; });
    if (accepted) await expect(accounts.setMembership('alice', org.id, bob.person.id, { state: 'revoked', role: 'member' }))
      .rejects.toMatchObject({ status: 503 });
    // This intentionally fails on b52e9dd: the owner can no longer recover via API.
    expect({ accepted, persisted: database.snapshot().memberships.length, ownerStatus })
      .toEqual({ accepted: false, persisted: 1000, ownerStatus: 200 });
  });
});
