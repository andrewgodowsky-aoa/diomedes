import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { AccountError } from '../src/errors.js';
import { createHandler, customerSigningKeys } from '../src/worker.js';
import { emptyAccountState, type AccountRepository, type AccountTransaction, type IdentityVerifier } from '../src/domain.js';
import { MemoryRepository } from './support/memory.js';
import { now, validEnv, verifier } from './support/fixtures.js';

// DIO-188. A slow database start or lock wait can age a correct proof past five seconds.
// That is the service's own delay, so it checks the identity again once and never signs
// the person out for it. Synthetic identities and an in-memory store only.
const RECHECK = { status: 503, message: 'The sign-in check took too long. Try again.', code: 'identity_recheck' };

/** A verifier that proves the session at the moving clock, as the WorkOS verifier does. */
function clocked(clock: { time: number }, stale: number[] = []) {
  const verify = vi.fn(async (token: string) => {
    const call = verify.mock.calls.length;
    const at = stale.includes(call) ? clock.time - 5001 : clock.time;
    return { ...await verifier.verify(token), issuedAt: new Date(clock.time - 1000).toISOString(),
      expiresAt: new Date(clock.time + 60_000).toISOString(), verifiedAt: new Date(at).toISOString() };
  });
  const identity: IdentityVerifier = { issuer: verifier.issuer, verify };
  return { identity, verify };
}

/** The memory store, with the identity lock and the event write able to take time. */
function delayed(clock: { time: number }, delays: { lock?: number[]; event?: number } = {}) {
  const memory = new MemoryRepository();
  let locks = 0;
  const transaction = vi.fn(<T>(action: (tx: AccountTransaction) => Promise<T>) => memory.transaction(tx => {
    const slow = Object.create(tx) as AccountTransaction;
    slow.lockIdentity = async proof => { await tx.lockIdentity(proof); clock.time += delays.lock?.[locks++] ?? 0; };
    slow.event = async event => { await tx.event(event); clock.time += delays.event ?? 0; };
    return action(slow);
  }));
  const repository: AccountRepository = { transaction: transaction as AccountRepository['transaction'] };
  return { memory, transaction, repository };
}

describe('a stale proof never signs a person out', () => {
  it('checks again once when the identity lock was slow, and runs the action once', async () => {
    const clock = { time: now };
    const { identity, verify } = clocked(clock);
    const { memory, transaction, repository } = delayed(clock, { lock: [5001, 0] });
    const organization = await new AccountService(repository, identity, { now: () => clock.time }).createOrganization('alice', 'Kept');
    expect(organization).toMatchObject({ name: 'Kept' });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(2);
    const state = memory.snapshot();
    expect(state.organizations).toHaveLength(1);
    expect(state.persons).toHaveLength(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.events).toHaveLength(1);
  });

  it('checks again once when the proof was already stale on arrival', async () => {
    const clock = { time: now };
    const { identity, verify } = clocked(clock, [1]);
    const { memory, transaction, repository } = delayed(clock);
    await expect(new AccountService(repository, identity, { now: () => clock.time }).signIn('alice'))
      .resolves.toMatchObject({ sessionId: 'session_alice' });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(memory.snapshot().sessions).toHaveLength(1);
  });

  it('answers 503 identity_recheck when both attempts are stale, and stores nothing', async () => {
    const clock = { time: now };
    const { identity, verify } = clocked(clock);
    const { memory, transaction, repository } = delayed(clock, { lock: [5001, 5001] });
    await expect(new AccountService(repository, identity, { now: () => clock.time }).createOrganization('alice', 'Refused'))
      .rejects.toMatchObject(RECHECK);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(memory.snapshot()).toEqual(emptyAccountState());
  });

  it('answers 503 identity_recheck without a retry when the proof aged after the action', async () => {
    const clock = { time: now };
    const { identity, verify } = clocked(clock);
    const { memory, transaction, repository } = delayed(clock, { event: 5001 });
    await expect(new AccountService(repository, identity, { now: () => clock.time }).createOrganization('alice', 'Refused'))
      .rejects.toMatchObject(RECHECK);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(memory.snapshot()).toEqual(emptyAccountState());
  });

  it.each([
    ['expired', { expiresAt: new Date(now).toISOString() }],
    ['expired and stale', { expiresAt: new Date(now).toISOString(), verifiedAt: new Date(now - 5001).toISOString() }],
    ['issued in the future', { issuedAt: new Date(now + 5001).toISOString() }],
    ['verified in the future', { verifiedAt: new Date(now + 5001).toISOString() }],
  ])('still answers 401 for a proof %s, with no second check', async (_label, override) => {
    const verify = vi.fn(async (token: string) => ({ ...await verifier.verify(token), ...override }));
    const transaction = vi.fn();
    const accounts = new AccountService({ transaction }, { issuer: verifier.issuer, verify }, { now: () => now });
    await expect(accounts.signIn('alice')).rejects.toMatchObject({
      status: 401, message: 'The verified session has expired or must be checked again.' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('never replays an action whose own refusal carries the recheck code', async () => {
    const clock = { time: now };
    const { identity, verify } = clocked(clock);
    const { transaction, repository } = delayed(clock);
    const accounts = new AccountService(repository, identity, { now: () => clock.time });
    const nested = vi.spyOn(accounts as unknown as { requireWorkspaceCapacity: () => Promise<void> }, 'requireWorkspaceCapacity')
      .mockRejectedValue(new AccountError(503, 'nested', 'identity_recheck'));
    await expect(accounts.createOrganization('alice', 'Refused')).rejects.toThrow('nested');
    expect(nested).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('answers the HTTP 503 with Retry-After: 1 and the code', async () => {
    const clock = { time: now };
    const { identity } = clocked(clock);
    const { repository } = delayed(clock, { lock: [5001, 5001] });
    const accounts = new AccountService(repository, identity, { now: () => clock.time });
    const response = await createHandler(() => accounts)(new Request('http://127.0.0.1:8791/account/session', {
      headers: { origin: 'http://127.0.0.1:8791', authorization: 'Bearer alice' } }), validEnv);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: RECHECK.message, code: RECHECK.code });
  });

  it('keeps every other refusal without Retry-After', async () => {
    const accounts = new AccountService(new MemoryRepository(), {
      issuer: verifier.issuer, async verify(token) { return { ...await verifier.verify(token), expiresAt: new Date(now).toISOString() }; },
    }, { now: () => now });
    const response = await createHandler(() => accounts)(new Request('http://127.0.0.1:8791/account/session', {
      headers: { origin: 'http://127.0.0.1:8791', authorization: 'Bearer alice' } }), validEnv);
    expect(response.status).toBe(401);
    expect(response.headers.get('retry-after')).toBeNull();
  });
});

describe('the customer signing keys per isolate', () => {
  it('returns the same cache for the same client id, so the signing keys are kept', () => {
    expect(customerSigningKeys('client_cache_fixture')).toBe(customerSigningKeys('client_cache_fixture'));
  });

  it('gives a different client id a new cache, and keeps one client id at a time', () => {
    const first = customerSigningKeys('client_cache_fixture');
    const other = customerSigningKeys('client_cache_fixture_other');
    expect(other).not.toBe(first);
    expect(customerSigningKeys('client_cache_fixture_other')).toBe(other);
    expect(customerSigningKeys('client_cache_fixture')).not.toBe(first);
  });

  it('holds only the signing keys and their fetch time: no secret, verifier or promise', () => {
    const cache = customerSigningKeys('client_cache_fixture');
    expect(cache).toEqual({ keys: [], fetchedAt: -Infinity });
    expect(Object.keys(cache).sort()).toEqual(['fetchedAt', 'keys']);
  });
});

describe('the default handler hands the customer verifier the kept signing keys', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('fills the cache kept for the customer client id, refusing a bad signature before any database', async () => {
    // A published key and a different signing key: verification stops at the signature, so the
    // request never reaches the repository and no socket is opened.
    const published = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signer = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url === `https://api.workos.com/sso/jwks/${validEnv.WORKOS_CLIENT_ID}`)
        return Response.json({ keys: [{ ...published.publicKey.export({ format: 'jwk' }), kid: 'key_wiring', alg: 'RS256', use: 'sig' }] });
      throw new Error(`Unexpected fixture URL: ${url}`);
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    customerSigningKeys('client_wiring_reset');
    const seconds = Math.floor(Date.now() / 1000);
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${part({ alg: 'RS256', kid: 'key_wiring', typ: 'JWT' })}.${part({
      iss: `https://api.workos.com/user_management/${validEnv.WORKOS_CLIENT_ID}`, client_id: validEnv.WORKOS_CLIENT_ID,
      aud: validEnv.WORKOS_TOKEN_AUDIENCE, sub: 'user_wiring', sid: 'session_wiring', iat: seconds - 1, exp: seconds + 300 })}`;
    const token = `${input}.${sign('RSA-SHA256', Buffer.from(input), signer.privateKey).toString('base64url')}`;
    const response = await createHandler()(new Request('http://127.0.0.1:8791/account/session', {
      headers: { origin: 'http://127.0.0.1:8791', authorization: `Bearer ${token}` } }), validEnv);
    expect(response.status).toBe(401);
    expect(fetched).toEqual([`https://api.workos.com/sso/jwks/${validEnv.WORKOS_CLIENT_ID}`]);
    expect(customerSigningKeys(validEnv.WORKOS_CLIENT_ID).keys.map((key) => key.kid)).toEqual(['key_wiring']);
  });
});
