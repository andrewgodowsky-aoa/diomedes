import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, seedDemo } from '../src/faux/seed.js';
import { STANDIN_CLIENT_ID, WORKOS_ISSUER } from '../src/faux/workos-standin.js';

let cloud: FauxCloud;
let clock = Date.parse('2026-09-25T12:00:00.000Z');
const now = () => clock;
const ORIGIN = 'http://127.0.0.1:8795';
const REDIRECT = 'http://127.0.0.1:47319/callback';

async function call(method: string, pathname: string, options: { token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const response = await cloud.handle(new Request(`${ORIGIN}${pathname}`, {
    method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), redirect: 'manual',
  }));
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** What the Operations app does: authorize in the browser, catch the redirect, trade the code. */
async function browserSignIn(email: string | null, overrides: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: 'code', client_id: STANDIN_CLIENT_ID, redirect_uri: REDIRECT, provider: 'authkit',
    state: 'state-123', code_challenge: challenge, code_challenge_method: 'S256', ...(email ? { login_hint: email } : {}), ...overrides,
  });
  const authorize = await call('GET', `/workos/user_management/authorize?${query}`);
  return { authorize, verifier, location: authorize.headers.get('location') ? new URL(authorize.headers.get('location')!) : null };
}

async function exchange(code: string, verifier: string) {
  return call('POST', '/workos/user_management/authenticate', {
    body: { client_id: STANDIN_CLIENT_ID, grant_type: 'authorization_code', code, code_verifier: verifier },
  });
}

async function signIn(email: string) {
  const { location, verifier } = await browserSignIn(email);
  const tokens = await exchange(location!.searchParams.get('code')!, verifier);
  expect(tokens.status).toBe(200);
  return tokens.body as { access_token: string; refresh_token: string; user: { id: string; email: string } };
}

beforeEach(async () => {
  clock = Date.parse('2026-09-25T12:00:00.000Z');
  cloud = await createFauxCloud({ file: null, now, identity: 'workos-standin' });
});

describe('the faux cloud in workos-standin mode', () => {
  it('describes its stand-in and refuses the password endpoints', async () => {
    const status = await call('GET', '/faux/status');
    expect(status.body).toMatchObject({
      backend: 'faux', identity: 'workos-standin', issuer: WORKOS_ISSUER,
      workos: { apiBase: `${ORIGIN}/workos`, clientId: STANDIN_CLIENT_ID },
    });
    const password = await call('POST', '/auth/sign-in', { body: { email: 'a@b.test', password: 'x', remember: false } });
    expect(password.status).toBe(404);
  });

  it('signs a person in with PKCE, verifies them with the Worker verifier, and refuses them as staff until bootstrapped', async () => {
    const { authorize, location, verifier } = await browserSignIn('andrew@diomedes.test');
    expect(authorize.status).toBe(302);
    expect(location!.origin + location!.pathname).toBe(REDIRECT);
    expect(location!.searchParams.get('state')).toBe('state-123');
    const tokens = await exchange(location!.searchParams.get('code')!, verifier);
    expect(tokens.status).toBe(200);
    expect(tokens.body.user).toMatchObject({ email: 'andrew@diomedes.test', email_verified: true });
    const claims = JSON.parse(Buffer.from(tokens.body.access_token.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ iss: WORKOS_ISSUER, aud: 'https://accounts.diomedes.net', client_id: STANDIN_CLIENT_ID });

    // A verified person, through WorkOSIdentityVerifier (JWKS, session and user checks).
    expect((await call('GET', '/account/session', { token: tokens.body.access_token })).status).toBe(200);
    // Not staff: the Operations app shows this refusal with the WorkOS user id.
    const refused = await call('GET', '/ops/me', { token: tokens.body.access_token });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('This account is not a Diomedes staff account.');

    const made = await call('POST', '/faux/bootstrap-admin', { body: { subject: tokens.body.user.id } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ role: 'admin', state: 'active' });
    const me = await call('GET', '/ops/me', { token: tokens.body.access_token });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: 'admin', backend: 'faux' });

    // One first admin, ever: the next is added by that admin, in the app.
    const other = await signIn('second@diomedes.test');
    expect((await call('GET', '/ops/me', { token: other.access_token })).status).toBe(403); // Their account row now exists.
    expect((await call('POST', '/faux/bootstrap-admin', { body: { subject: other.user.id } })).status).toBe(409);
    const audit = await call('GET', '/ops/audit', { token: tokens.body.access_token });
    expect(audit.body.some((row: { detail: { bootstrap?: boolean } }) => row.detail.bootstrap === true)).toBe(true);
  });

  it('refuses a bootstrap for someone who has never signed in', async () => {
    const subject = await cloud.standIn!.userIdFor('never@diomedes.test');
    expect((await call('POST', '/faux/bootstrap-admin', { body: { subject } })).status).toBe(404);
  });

  it('refuses a wrong verifier, a reused code, a foreign redirect and another client', async () => {
    const first = await browserSignIn('a@diomedes.test');
    const code = first.location!.searchParams.get('code')!;
    expect((await exchange(code, pkce().verifier)).status).toBe(400);
    expect((await exchange(code, first.verifier)).status).toBe(400); // Spent by the failed try.

    const foreign = await browserSignIn('a@diomedes.test', { redirect_uri: 'https://attacker.example/callback' });
    expect(foreign.authorize.status).toBe(422);

    const wrongClient = await browserSignIn('a@diomedes.test', { client_id: 'client_someone_else' });
    expect(wrongClient.location!.searchParams.get('error')).toBe('invalid_client');
    expect(wrongClient.location!.searchParams.get('code')).toBeNull();
  });

  it('rotates refresh tokens, and a token without the audience is refused', async () => {
    const tokens = await signIn('b@diomedes.test');
    const refreshed = await call('POST', '/workos/user_management/authenticate', {
      body: { client_id: STANDIN_CLIENT_ID, grant_type: 'refresh_token', refresh_token: tokens.refresh_token },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(tokens.refresh_token);
    const reused = await call('POST', '/workos/user_management/authenticate', {
      body: { client_id: STANDIN_CLIENT_ID, grant_type: 'refresh_token', refresh_token: tokens.refresh_token },
    });
    expect(reused.status).toBe(400);
    expect((await call('GET', '/account/session', { token: refreshed.body.access_token })).status).toBe(200);

    // A token whose claims were changed after signing does not verify.
    const [header, body, signature] = tokens.access_token.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = `${header}.${Buffer.from(JSON.stringify({ ...claims, aud: 'https://elsewhere.test' })).toString('base64url')}.${signature}`;
    expect((await call('GET', '/account/session', { token: forged })).status).toBe(401);
  });

  it('seeds the demo through the stand-in, with the first admin bootstrapped', async () => {
    const seed = await seedDemo(cloud);
    expect(seed.seeded).toBe(true);
    const admin = await cloud.seedSignIn({ ...DEMO_ACCOUNTS.staffAdmin, password: '' });
    const me = await call('GET', '/ops/me', { token: admin });
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('admin');
    const routing = await cloud.seedSignIn({ ...DEMO_ACCOUNTS.staffRouting, password: '' });
    expect((await call('GET', '/ops/me', { token: routing })).body.role).toBe('routing');
    expect((await seedDemo(cloud)).seeded).toBe(false);
  });
});
