import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { WorkOSIdentityVerifier, signingKeyCache, type SigningKeyCache } from '../src/identity-workos.js';

const issuer = 'https://api.workos.com/';
/** The issuer a live AuthKit token for this client carries. */
const clientIssuer = 'https://api.workos.com/user_management/client_account_test';
const clientId = 'client_account_test';
const audience = 'https://account.example.test';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
let time: number;
let claims: Record<string, unknown>;
let keys: Record<string, unknown>[];
let session: Record<string, unknown>;
let requests: { url: string; init?: RequestInit }[];
let outage: boolean;
let unverified: boolean;
let fetcher: typeof fetch;
let verifier: WorkOSIdentityVerifier;

function jwt(
  payload: Record<string, unknown> = claims,
  privateKey: KeyObject = pair.privateKey,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'initial', typ: 'JWT' },
) {
  const signingInput = [header, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
}

beforeEach(() => {
  time = Date.parse('2026-09-20T00:00:00Z');
  claims = {
    iss: issuer,
    client_id: clientId,
    aud: audience,
    sub: 'user_alice',
    sid: 'session_alice',
    iat: time / 1000 - 1,
    exp: time / 1000 + 300,
  };
  keys = [
    { ...pair.publicKey.export({ format: 'jwk' }), kid: 'initial', alg: 'RS256', use: 'sig' },
  ];
  session = {
    id: 'session_alice',
    user_id: 'user_alice',
    status: 'active',
    expires_at: new Date(time + 3600_000).toISOString(),
    ended_at: null,
    impersonator: null,
  };
  requests = [];
  outage = false;
  unverified = false;
  fetcher = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (outage) throw new TypeError('Network unavailable');
    if (url.includes('/sso/jwks/')) return Response.json({ keys });
    if (url.includes('/sessions'))
      return Response.json({ data: [session], list_metadata: { after: null } });
    if (url.endsWith('/user_management/users/user_alice'))
      return Response.json({
        id: 'user_alice',
        email: 'Alice@Example.test',
        email_verified: !unverified,
        first_name: 'Alice',
        last_name: null,
      });
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  verifier = new WorkOSIdentityVerifier({
    clientId,
    issuer,
    audience,
    apiKey: 'sk_offline_fixture_only',
    fetch: fetcher,
    now: () => time,
  });
});

describe('WorkOS access-token and active-session verification (offline HTTP fixtures)', () => {
  test('verifies RS256, application, resource audience, user and current session', async () => {
    const identity = await verifier.verify(jwt());
    expect(identity).toMatchObject({
      issuer,
      subject: 'user_alice',
      sessionId: 'session_alice',
      emailVerified: true,
      // Email-bound invitation codes compare against this.
      email: 'alice@example.test',
    });
    expect(requests[0].url).toBe(`https://api.workos.com/sso/jwks/${clientId}`);
    expect(requests[0].init?.headers).not.toHaveProperty('Authorization');
    expect(requests.filter((request) => request.url.includes('/user_management/'))).toHaveLength(2);
    expect(JSON.stringify(identity)).not.toContain('sk_offline');
  });

  test('accepts the per-client issuer a live AuthKit token carries, and keeps the configured issuer', async () => {
    // What https://api.workos.com/user_management/<client_id>/.well-known/openid-configuration
    // publishes, and what live tokens carry (2026-09-26); the documentation shows the bare origin.
    const identity = await verifier.verify(jwt({ ...claims, iss: clientIssuer }));
    expect(identity).toMatchObject({ issuer, subject: 'user_alice', sessionId: 'session_alice' });
  });

  test.each([
    ['audience', { aud: 'https://other.example/' }, 'audience'],
    ['issuer', { iss: 'https://attacker.example/' }, 'issuer'],
    ['client', { client_id: 'client_other' }, 'client'],
    ['impersonation', { act: { sub: 'admin' } }, 'actor'],
    ['expired', { exp: Date.parse('2026-09-20T00:00:00Z') / 1000 }, 'lifetime'],
  ])('logs only the failed check (%s), never a claim value', async (_name, patch, check) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(verifier.verify(jwt({ ...claims, ...patch }))).rejects.toMatchObject({ status: 401 });
    const lines = errors.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([JSON.stringify({ event: 'identity-refused', check })]);
    expect(lines.join('\n')).not.toMatch(/user_alice|session_alice|attacker|client_other/);
  });

  test.each([
    ['issuer', { iss: 'https://attacker.example/' }],
    ['another client’s issuer', { iss: clientIssuer.replace(clientId, 'client_other') }],
    ['a longer issuer path', { iss: `${clientIssuer}/extra` }],
    ['the client issuer with a trailing slash', { iss: `${clientIssuer}/` }],
    ['the user-management root', { iss: 'https://api.workos.com/user_management' }],
    ['audience', { aud: 'https://other.example/' }],
    ['missing audience', { aud: undefined }],
    ['client', { client_id: 'client_other' }],
    ['missing client', { client_id: undefined }],
    ['expired', { exp: Date.parse('2026-09-20T00:00:00Z') / 1000 }],
    ['future issued', { iat: Date.parse('2026-09-20T00:01:00Z') / 1000 }],
    ['not yet valid', { nbf: Date.parse('2026-09-20T00:01:00Z') / 1000 }],
    ['invalid subject', { sub: '../../credentials' }],
    ['missing session', { sid: undefined }],
    ['impersonation', { act: { sub: 'admin' } }],
  ])('rejects %s before authenticated provider lookup', async (_name, patch) => {
    await expect(verifier.verify(jwt({ ...claims, ...patch }))).rejects.toMatchObject({
      status: 401,
    });
    expect(requests.some((request) => request.url.includes('/user_management/'))).toBe(false);
  });

  test.each(['none', 'HS256', 'RS512'])(
    'rejects %s and refuses header-selected keys',
    async (alg) => {
      await expect(
        verifier.verify(
          jwt(claims, pair.privateKey, { alg, kid: 'initial', jku: 'https://evil.test' }),
        ),
      ).rejects.toMatchObject({ status: 401 });
      expect(requests).toHaveLength(0);
    },
  );

  test('rejects tampered signatures and unknown keys', async () => {
    await expect(verifier.verify(jwt(claims, rotated.privateKey))).rejects.toMatchObject({
      status: 401,
    });
    // The keys were fetched moments ago, so an unknown key id is unavailable until the thirty
    // seconds pass, then refused once the keys are fetched again (DIO-188).
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      verifier.verify(jwt(claims, rotated.privateKey, { alg: 'RS256', kid: 'unknown' })),
    ).rejects.toMatchObject({ status: 503 });
    time += 30_000;
    await expect(
      verifier.verify(jwt({ ...claims, iat: time / 1000 - 1, exp: time / 1000 + 300 }, rotated.privateKey,
        { alg: 'RS256', kid: 'unknown' })),
    ).rejects.toMatchObject({ status: 401 });
  });

  test('refreshes bounded JWKS cache for a legitimate key rotation', async () => {
    await verifier.verify(jwt());
    keys = [
      { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'rotated', use: 'sig', alg: 'RS256' },
    ];
    time += 31_000;
    await expect(
      verifier.verify(jwt(claims, rotated.privateKey, { alg: 'RS256', kid: 'rotated' })),
    ).resolves.toMatchObject({ subject: 'user_alice' });
    expect(requests.filter((request) => request.url.includes('/sso/jwks/'))).toHaveLength(2);
  });

  test.each([
    { status: 'revoked' },
    { user_id: 'user_other' },
    { ended_at: '2026-09-20T00:00:00Z' },
    { expires_at: '2026-09-20T00:00:00Z' },
    { impersonator: { email: 'operator@example.test' } },
  ])(
    'rejects inactive, wrong-user, expired or impersonated provider session: %j',
    async (patch) => {
      session = { ...session, ...patch };
      await expect(verifier.verify(jwt())).rejects.toMatchObject({ status: 401 });
    },
  );

  test('does not cache session activity: provider revocation invalidates the same token', async () => {
    await verifier.verify(jwt());
    session.status = 'revoked';
    await expect(verifier.verify(jwt())).rejects.toMatchObject({ status: 401 });
  });

  test('provider outage is unavailable, not successful or an invalid-token response', async () => {
    outage = true;
    await expect(verifier.verify(jwt())).rejects.toMatchObject({ status: 503 });
  });

  test('refuses unverified user and malformed token without exposing credential bytes', async () => {
    unverified = true;
    await expect(verifier.verify(jwt())).rejects.toMatchObject({ status: 403 });
    await expect(verifier.verify('sensitive-invalid-token')).rejects.toMatchObject({ status: 401 });
    await expect(verifier.verify('sensitive-invalid-token')).rejects.not.toThrow(
      'sensitive-invalid-token',
    );
  });

  test('invalid issuer, missing audience or API key fail configuration without network', () => {
    for (const patch of [{ issuer: 'http://api.workos.com/' }, { audience: '' }, { apiKey: '' }])
      expect(
        () =>
          new WorkOSIdentityVerifier({ clientId, issuer, audience, apiKey: 'fixture', ...patch }),
      ).toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe('the identity-unavailable line names what the provider call threw (DIO-188)', () => {
  const thrower = (fetcher: typeof fetch) =>
    new WorkOSIdentityVerifier({ clientId, issuer, audience, apiKey: 'sk_offline_fixture_only', fetch: fetcher, now: () => time });
  const lines = (errors: { mock: { calls: unknown[][] } }) => errors.mock.calls.map(([line]) => String(line));

  test('a thrown TypeError logs its name and nothing of its message', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const verifier = thrower(async () => { throw new TypeError('Illegal invocation at https://api.workos.com/sso/jwks'); });
    await expect(verifier.verify(jwt())).rejects.toMatchObject({ status: 503 });
    expect(lines(errors)).toEqual([JSON.stringify({ event: 'identity-unavailable', step: 'jwks', error: 'TypeError' })]);
  });

  test('an abort from the five-second timeout logs the abort name', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const verifier = thrower((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }));
      const refused = expect(verifier.verify(jwt())).rejects.toMatchObject({ status: 503 });
      await vi.advanceTimersByTimeAsync(5000);
      await refused;
      expect(lines(errors)).toEqual([JSON.stringify({ event: 'identity-unavailable', step: 'jwks', error: 'AbortError' })]);
    } finally { vi.useRealTimers(); }
  });

  test.each([
    ['a string', 'Network unavailable'],
    ['undefined', undefined],
    ['an object with no name', { message: 'no name here' }],
    ['a name with spaces and punctuation', { name: 'Bad name: https://api.workos.com' }],
    ['a name longer than 60 characters', { name: 'E'.repeat(61) }],
    ['a name that is not a string', { name: 42 }],
  ])('a throw of %s logs unknown', async (_label, thrown) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const verifier = thrower(async () => { throw thrown; });
    await expect(verifier.verify(jwt())).rejects.toMatchObject({ status: 503 });
    expect(lines(errors)).toEqual([JSON.stringify({ event: 'identity-unavailable', step: 'jwks', error: 'unknown' })]);
  });

  test('a name of exactly 60 letters, digits and underscores is kept', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const name = `${'A1_'.repeat(20)}`;
    const verifier = thrower(async () => { throw Object.assign(new Error('hidden'), { name }); });
    await expect(verifier.verify(jwt())).rejects.toMatchObject({ status: 503 });
    expect(lines(errors)).toEqual([JSON.stringify({ event: 'identity-unavailable', step: 'jwks', error: name })]);
  });

  test('an HTTP refusal keeps the status form, with no error name', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const verifier = thrower(async () => new Response('{"message":"hidden"}', { status: 500 }));
    await expect(verifier.verify(jwt())).rejects.toMatchObject({ status: 503 });
    expect(lines(errors)).toEqual([JSON.stringify({ event: 'identity-unavailable', step: 'jwks', status: 500 })]);
  });
});

describe('signing keys shared between verifiers, never a key fetch (DIO-188)', () => {
  const sharing = (cache: SigningKeyCache, fetch: typeof globalThis.fetch = fetcher) =>
    new WorkOSIdentityVerifier({ clientId, issuer, audience, apiKey: 'sk_offline_fixture_only', fetch, now: () => time, signingKeys: cache });
  const keyFetches = () => requests.filter((request) => request.url.includes('/sso/jwks/')).length;

  test('two verifiers on one cache fetch the signing keys once, for five minutes', async () => {
    const cache = signingKeyCache();
    await expect(sharing(cache).verify(jwt())).resolves.toMatchObject({ subject: 'user_alice' });
    time += 299_000;
    await expect(sharing(cache).verify(jwt({ ...claims, iat: time / 1000 - 1, exp: time / 1000 + 300 })))
      .resolves.toMatchObject({ subject: 'user_alice' });
    expect(keyFetches()).toBe(1);
    expect(requests.filter((request) => request.url.includes('/sessions'))).toHaveLength(2);
    time += 1_000;
    await sharing(cache).verify(jwt({ ...claims, iat: time / 1000 - 1, exp: time / 1000 + 300 }));
    expect(keyFetches()).toBe(2);
  });

  test('an unknown key id refreshes at most once per thirty seconds across verifiers on one cache', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = signingKeyCache();
    await sharing(cache).verify(jwt());
    time += 31_000;
    const unknown = jwt({ ...claims, iat: time / 1000 - 1, exp: time / 1000 + 300 }, rotated.privateKey,
      { alg: 'RS256', kid: 'unknown' });
    await expect(sharing(cache).verify(unknown)).rejects.toMatchObject({ status: 401 });
    // Inside the thirty seconds the second is unavailable, not refused, and fetches nothing (DIO-188).
    await expect(sharing(cache).verify(unknown)).rejects.toMatchObject({ status: 503 });
    expect(keyFetches()).toBe(2);
  });

  test('a key fetch that never settles does not hold up another verifier on the same cache', async () => {
    // A workerd fetch cancelled with the request that started it never settles, so its timer is faked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const cache = signingKeyCache();
      const hung: typeof fetch = (input, init) => {
        if (!String(input).includes('/sso/jwks/')) return fetcher(input, init);
        requests.push({ url: String(input), init });
        return new Promise<Response>(() => {});
      };
      let settled = false;
      void sharing(cache, hung).verify(jwt()).finally(() => { settled = true; });
      await expect(sharing(cache).verify(jwt())).resolves.toMatchObject({ subject: 'user_alice' });
      expect(settled).toBe(false);
      expect(keyFetches()).toBe(2);
      expect(cache.keys).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  test('the cache holds the signing keys and their fetch time, and nothing secret', async () => {
    const cache = signingKeyCache();
    await sharing(cache).verify(jwt());
    expect(Object.keys(cache).sort()).toEqual(['fetchedAt', 'keys']);
    expect(cache.fetchedAt).toBe(time);
    expect(cache.keys.map((key) => key.kid)).toEqual(['initial']);
    expect(JSON.stringify(cache)).not.toMatch(/sk_offline|Bearer|user_alice|session_alice/);
  });

  test.each([
    { clock: 'one second later', elapsed: 1_000 },
    { clock: 'in the same millisecond', elapsed: 0 },
    { clock: 'after the clock moves backward', elapsed: -1_000 },
  ])('an older key fetch never overwrites a newer one started $clock', async ({ elapsed }) => {
    const cache = signingKeyCache();
    const held: ((keys: Record<string, unknown>[]) => void)[] = [];
    const holding: typeof fetch = (input, init) => {
      if (!String(input).includes('/sso/jwks/')) return fetcher(input, init);
      requests.push({ url: String(input), init });
      return new Promise<Response>((resolve) => held.push((set) => resolve(Response.json({ keys: set }))));
    };
    const older = [keys[0]];
    const newer = [keys[0], { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'rotated', use: 'sig', alg: 'RS256' }];
    const first = sharing(cache, holding).verify(jwt());
    const startedFirst = time;
    time += elapsed;
    const second = sharing(cache, holding).verify(jwt());
    const startedSecond = time;
    expect(held).toHaveLength(2);
    time += 1_000;
    held[1](newer);
    await expect(second).resolves.toMatchObject({ subject: 'user_alice' });
    time += 1_000;
    held[0](older);
    await expect(first).resolves.toMatchObject({ subject: 'user_alice' });
    expect(startedSecond - startedFirst).toBe(elapsed);
    expect(cache.keys.map((key) => key.kid)).toEqual(['initial', 'rotated']);
    expect(cache.fetchedAt).toBe(startedSecond);
    await expect(sharing(cache).verify(jwt(claims, rotated.privateKey, { alg: 'RS256', kid: 'rotated' })))
      .resolves.toMatchObject({ subject: 'user_alice' });
    expect(keyFetches()).toBe(2);
  });

  test.each([
    { failure: 'HTTP failure', response: () => new Response(null, { status: 503 }) },
    { failure: 'malformed keys', response: () => Response.json({ keys: [] }) },
  ])('a newer refresh with $failure does not suppress an older successful response', async ({ response }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = signingKeyCache();
    let finish!: (response: Response) => void;
    const holding: typeof fetch = (input, init) => {
      if (!String(input).includes('/sso/jwks/')) return fetcher(input, init);
      requests.push({ url: String(input), init });
      return new Promise<Response>((resolve) => { finish = resolve; });
    };
    const first = sharing(cache, holding).verify(jwt());
    const failing: typeof fetch = async (input, init) => {
      if (!String(input).includes('/sso/jwks/')) return fetcher(input, init);
      requests.push({ url: String(input), init });
      return response();
    };
    await expect(sharing(cache, failing).verify(jwt())).rejects.toMatchObject({ status: 503 });
    expect(cache.keys).toEqual([]);
    expect(cache.fetchedAt).toBe(-Infinity);
    finish(Response.json({ keys }));
    await expect(first).resolves.toMatchObject({ subject: 'user_alice' });
    expect(cache.keys.map((key) => key.kid)).toEqual(['initial']);
    expect(cache.fetchedAt).toBe(time);
    await expect(sharing(cache).verify(jwt())).resolves.toMatchObject({ subject: 'user_alice' });
    expect(keyFetches()).toBe(2);
  });
});

describe('an unknown key id inside the thirty second window is unavailable, not refused (DIO-188)', () => {
  const sharing = (cache: SigningKeyCache) =>
    new WorkOSIdentityVerifier({ clientId, issuer, audience, apiKey: 'sk_offline_fixture_only', fetch: fetcher, now: () => time, signingKeys: cache });
  const keyFetches = () => requests.filter((request) => request.url.includes('/sso/jwks/')).length;
  const rotatedKey = () => ({ ...rotated.publicKey.export({ format: 'jwk' }), kid: 'rotated', use: 'sig', alg: 'RS256' });
  const signedWithRotated = () =>
    jwt({ ...claims, iat: time / 1000 - 1, exp: time / 1000 + 300 }, rotated.privateKey, { alg: 'RS256', kid: 'rotated' });

  test('inside the window it answers 503 with its own step in the log, and fetches nothing', async () => {
    const cache = signingKeyCache();
    await sharing(cache).verify(jwt());
    time += 29_000;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sharing(cache).verify(signedWithRotated())).rejects.toMatchObject({ status: 503 });
    expect(errors.mock.calls.map(([line]) => String(line)))
      .toEqual([JSON.stringify({ event: 'identity-unavailable', step: 'signing-key-recent' })]);
    expect(keyFetches()).toBe(1);
  });

  test('after the window the same token fetches once, then is refused if the key is still unknown', async () => {
    const cache = signingKeyCache();
    await sharing(cache).verify(jwt());
    time += 30_000;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sharing(cache).verify(signedWithRotated())).rejects.toMatchObject({ status: 401 });
    expect(keyFetches()).toBe(2);
    expect(errors.mock.calls.map(([line]) => String(line)))
      .toEqual([JSON.stringify({ event: 'identity-refused', check: 'signing-key' })]);
  });

  test('a key just rotated in answers 503 inside the window and verifies after it', async () => {
    const cache = signingKeyCache();
    await sharing(cache).verify(jwt());
    expect(cache.keys.map((key) => key.kid)).toEqual(['initial']);
    keys = [keys[0], rotatedKey()];
    time += 10_000;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sharing(cache).verify(signedWithRotated())).rejects.toMatchObject({ status: 503 });
    expect(keyFetches()).toBe(1);
    time += 20_000;
    await expect(sharing(cache).verify(signedWithRotated())).resolves.toMatchObject({ subject: 'user_alice' });
    expect(keyFetches()).toBe(2);
    expect(cache.keys.map((key) => key.kid)).toEqual(['initial', 'rotated']);
  });

  test('a token signed with an unknown key id on a cold cache is still refused after the one fetch', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sharing(signingKeyCache()).verify(signedWithRotated())).rejects.toMatchObject({ status: 401 });
    expect(keyFetches()).toBe(1);
    expect(errors.mock.calls.map(([line]) => String(line)))
      .toEqual([JSON.stringify({ event: 'identity-refused', check: 'signing-key' })]);
  });
});
