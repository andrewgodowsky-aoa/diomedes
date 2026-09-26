import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { WorkOSIdentityVerifier } from '../src/identity-workos.js';

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
  const fetcher: typeof fetch = async (input, init) => {
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
    await expect(
      verifier.verify(jwt(claims, rotated.privateKey, { alg: 'RS256', kid: 'unknown' })),
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
