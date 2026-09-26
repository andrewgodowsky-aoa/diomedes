/**
 * A WorkOS stand-in for the faux cloud: the AuthKit endpoints that a native
 * client (the Diomedes Operations app) and the control plane's own
 * WorkOSIdentityVerifier call, answered from memory. It lets WorkOS sign-in
 * run end to end on this computer, through the same verifier the Worker uses,
 * without a WorkOS account. Test data only.
 *
 *   GET  /user_management/authorize            PKCE (S256); redirects straight back, no login page
 *   POST /user_management/authenticate         authorization_code (with code_verifier) or refresh_token
 *   GET  /sso/jwks/:clientId                   the RS256 signing key
 *   GET  /user_management/users/:id            the user                (API key)
 *   GET  /user_management/users/:id/sessions   the user's sessions     (API key)
 *
 * Shapes follow the WorkOS reference (workos.com/docs/reference/authkit). The
 * one liberty: there is no login page. The person is the `login_hint` email,
 * or admin@diomedes.test, and a new email becomes a new user, as a first
 * WorkOS sign-in would.
 */
import { base64url } from '../crypto.js';
import type { IdentityDirectory } from '../domain.js';

export const WORKOS_ISSUER = 'https://api.workos.com';
export const STANDIN_CLIENT_ID = 'client_standin_diomedes_operations';
export const STANDIN_API_KEY = 'sk_test_standin_faux_cloud_only_0000';
/** The resource audience the company service's JWT template adds; the stand-in adds the same. */
export const STANDIN_AUDIENCE = 'https://accounts.diomedes.net';
const DEFAULT_PERSON = 'admin@diomedes.test';

interface StandInUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}
interface StandInSession {
  id: string;
  userId: string;
  expiresAt: number;
  endedAt: number | null;
}

export interface TokenAnswer {
  user: { object: 'user'; id: string; email: string; email_verified: true; first_name: string; last_name: string };
  access_token: string;
  refresh_token: string;
  authentication_method: 'Password';
}

export interface WorkOSStandIn {
  readonly clientId: string;
  readonly apiKey: string;
  readonly audience: string;
  /** Serve one request; paths are WorkOS's, without any prefix. */
  handle(request: Request): Promise<Response>;
  /** A fetch that sends https://api.workos.com/... here, for the verifier. */
  fetch: typeof fetch;
  /** Sign a person in without the browser round trip: the seed and tests use this. */
  signInDirect(email: string, name?: string): Promise<TokenAnswer>;
  /** WorkOS's user id for an email: the same email is always the same user. */
  userIdFor(email: string): Promise<string>;
  readonly directory: IdentityDirectory;
}

const random = (bytes = 16) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));
const hex = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const s256 = async (verifier: string) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

function loopbackRedirect(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export async function createWorkOSStandIn(options: { now?: () => number; accessTtlSeconds?: number; clientId?: string } = {}): Promise<WorkOSStandIn> {
  const now = options.now ?? Date.now;
  const clientId = options.clientId ?? STANDIN_CLIENT_ID;
  const ttl = options.accessTtlSeconds ?? 300;
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const kid = `standin_${random(8)}`;
  const jwk = { kty: 'RSA', kid, n: exported.n, e: exported.e, use: 'sig', alg: 'RS256' };

  const users = new Map<string, StandInUser>();
  const sessions = new Map<string, StandInSession>();
  const codes = new Map<string, { userId: string; challenge: string; redirectUri: string; expiresAt: number }>();
  const refreshTokens = new Map<string, string>(); // refresh token -> session id

  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  const refuse = (status: number, error: string, message: string) => json({ error, error_description: message, message }, status);

  async function userIdFor(email: string) {
    return `user_standin${(await hex(email.trim().toLowerCase())).slice(0, 26)}`;
  }

  async function userFor(email: string, name?: string): Promise<StandInUser> {
    const id = await userIdFor(email);
    let user = users.get(id);
    if (!user) {
      const [first, ...rest] = (name ?? email.split('@')[0]).trim().split(/\s+/);
      user = { id, email: email.trim().toLowerCase(), firstName: first || 'Staff', lastName: rest.join(' ') };
      users.set(id, user);
    }
    return user;
  }

  async function sign(claims: Record<string, unknown>) {
    const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })));
    const body = base64url(new TextEncoder().encode(JSON.stringify(claims)));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${header}.${body}`));
    return `${header}.${body}.${base64url(new Uint8Array(signature))}`;
  }

  async function answer(user: StandInUser, session: StandInSession): Promise<TokenAnswer> {
    const iat = Math.floor(now() / 1000);
    const access = await sign({
      iss: WORKOS_ISSUER,
      aud: STANDIN_AUDIENCE,
      sub: user.id,
      sid: session.id,
      client_id: clientId,
      iat,
      exp: iat + ttl,
      jti: random(12),
    });
    const refresh = `standin_refresh_${random(24)}`;
    refreshTokens.set(refresh, session.id);
    return {
      user: { object: 'user', id: user.id, email: user.email, email_verified: true, first_name: user.firstName, last_name: user.lastName },
      access_token: access,
      refresh_token: refresh,
      authentication_method: 'Password',
    };
  }

  function newSession(user: StandInUser): StandInSession {
    const session = { id: `session_standin${random(12)}`, userId: user.id, expiresAt: now() + 24 * 3600_000, endedAt: null };
    sessions.set(session.id, session);
    return session;
  }

  const authorized = (request: Request) => request.headers.get('authorization') === `Bearer ${STANDIN_API_KEY}`;

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/user_management/authorize' && request.method === 'GET') {
      const redirect = loopbackRedirect(url.searchParams.get('redirect_uri'));
      if (!redirect) return refuse(422, 'invalid_redirect_uri', 'The stand-in only redirects to 127.0.0.1 or localhost.');
      const state = url.searchParams.get('state');
      const back = (params: Record<string, string>) => {
        for (const [key, value] of Object.entries(params)) redirect.searchParams.set(key, value);
        if (state) redirect.searchParams.set('state', state);
        return new Response(null, { status: 302, headers: { location: redirect.href } });
      };
      if (url.searchParams.get('client_id') !== clientId) return back({ error: 'invalid_client' });
      if (url.searchParams.get('response_type') !== 'code' || url.searchParams.get('provider') !== 'authkit')
        return back({ error: 'invalid_request' });
      const challenge = url.searchParams.get('code_challenge');
      if (!challenge || url.searchParams.get('code_challenge_method') !== 'S256') return back({ error: 'invalid_request' });
      const user = await userFor(url.searchParams.get('login_hint') || DEFAULT_PERSON);
      const code = `standin_code_${random(18)}`;
      codes.set(code, { userId: user.id, challenge, redirectUri: redirect.origin + redirect.pathname, expiresAt: now() + 600_000 });
      return back({ code });
    }
    if (path === '/user_management/authenticate' && request.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return refuse(400, 'invalid_request', 'A JSON body is required.');
      }
      if (body.client_id !== clientId) return refuse(400, 'invalid_client', 'Unknown client.');
      if (body.grant_type === 'authorization_code') {
        const code = typeof body.code === 'string' ? codes.get(body.code) : undefined;
        if (typeof body.code === 'string') codes.delete(body.code); // One use, right or wrong.
        if (!code || code.expiresAt <= now()) return refuse(400, 'invalid_grant', 'The code is invalid or expired.');
        if (typeof body.code_verifier !== 'string' || (await s256(body.code_verifier)) !== code.challenge)
          return refuse(400, 'invalid_grant', 'The code verifier does not match the code challenge.');
        const user = users.get(code.userId)!;
        return json(await answer(user, newSession(user)));
      }
      if (body.grant_type === 'refresh_token') {
        const sessionId = typeof body.refresh_token === 'string' ? refreshTokens.get(body.refresh_token) : undefined;
        if (typeof body.refresh_token === 'string') refreshTokens.delete(body.refresh_token); // Rotated on use.
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session || session.endedAt !== null || session.expiresAt <= now())
          return refuse(400, 'invalid_grant', 'The refresh token is invalid or the session ended.');
        return json(await answer(users.get(session.userId)!, session));
      }
      return refuse(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }
    if (path === `/sso/jwks/${clientId}` && request.method === 'GET') return json({ keys: [jwk] });
    let match: RegExpExecArray | null;
    if ((match = /^\/user_management\/users\/([A-Za-z0-9_-]+)\/sessions$/.exec(path)) && request.method === 'GET') {
      if (!authorized(request)) return refuse(401, 'unauthorized', 'The API key is invalid.');
      const data = [...sessions.values()]
        .filter((session) => session.userId === match![1])
        .map((session) => ({
          object: 'session',
          id: session.id,
          user_id: session.userId,
          status: session.endedAt === null && session.expiresAt > now() ? 'active' : 'inactive',
          expires_at: new Date(session.expiresAt).toISOString(),
          ended_at: session.endedAt === null ? null : new Date(session.endedAt).toISOString(),
        }));
      return json({ data, list_metadata: { after: null } });
    }
    if ((match = /^\/user_management\/users\/([A-Za-z0-9_-]+)$/.exec(path)) && request.method === 'GET') {
      if (!authorized(request)) return refuse(401, 'unauthorized', 'The API key is invalid.');
      const user = users.get(match[1]);
      if (!user) return refuse(404, 'not_found', 'User not found.');
      return json({ object: 'user', id: user.id, email: user.email, email_verified: true, first_name: user.firstName, last_name: user.lastName });
    }
    return refuse(404, 'not_found', 'The stand-in does not serve this WorkOS path.');
  }

  return {
    clientId,
    apiKey: STANDIN_API_KEY,
    audience: STANDIN_AUDIENCE,
    handle,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== WORKOS_ISSUER) throw new TypeError('The stand-in only answers for api.workos.com.');
      return handle(new Request(url, init));
    }) as typeof fetch,
    async signInDirect(email: string, name?: string) {
      const user = await userFor(email, name);
      return answer(user, newSession(user));
    },
    userIdFor,
    directory: {
      async lookup(issuer: string, subject: string) {
        if (issuer !== WORKOS_ISSUER) return null;
        const user = users.get(subject);
        return user ? { email: user.email, name: `${user.firstName} ${user.lastName}`.trim() } : null;
      },
    },
  };
}
