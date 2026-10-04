import { base64url, fromBase64url, readBytes } from './crypto.js';
import { z } from 'zod';
import { AccountError as ApiError } from './errors.js';
import type { IdentityVerifier, VerifiedIdentity } from './domain.js';

const API = 'https://api.workos.com';
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const jwtClaims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string()).min(1).max(16)]),
  client_id: providerId,
  sub: providerId,
  sid: providerId,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative().optional(),
  act: z.unknown().optional(),
});
const jwkSchema = z.object({
  kty: z.literal('RSA'),
  kid: providerId,
  n: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(1400),
  e: z.literal('AQAB'),
  use: z.literal('sig').optional(),
  alg: z.literal('RS256').optional(),
  key_ops: z.array(z.literal('verify')).optional(),
  d: z.never().optional(),
});
export type SigningKey = z.infer<typeof jwkSchema>;
const keysSchema = z.object({ keys: z.array(jwkSchema).min(1).max(32) });
const userSchema = z.object({
  id: providerId,
  email: z.email().max(320).optional(),
  email_verified: z.boolean(),
  first_name: z.string().max(200).nullable().optional(),
  last_name: z.string().max(200).nullable().optional(),
});
const sessionsSchema = z.object({
  data: z
    .array(
      z.object({
        id: providerId,
        user_id: providerId,
        status: z.string(),
        expires_at: z.iso.datetime(),
        ended_at: z.iso.datetime().nullable(),
        impersonator: z.unknown().optional(),
      }),
    )
    .max(100),
  list_metadata: z.object({ after: providerId.nullable() }),
});

export interface WorkOSIdentityConfiguration {
  clientId: string;
  issuer: string;
  /** Exact resource audience configured in the application's JWT template. */
  audience: string;
  /** Server-only; used for fresh session and user checks, never returned. */
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Signing keys to share with other verifiers; omitted, this verifier keeps its own. */
  signingKeys?: SigningKeyCache;
}

/**
 * The signing keys and when they were fetched: public data, safe to share across requests. Never a
 * promise, a verifier or a secret, because a fetch belongs to the request that started it and is
 * cancelled when that request ends.
 */
export interface SigningKeyCache { keys: SigningKey[]; fetchedAt: number }
export const signingKeyCache = (): SigningKeyCache => ({ keys: [], fetchedAt: -Infinity });

const invalid = () => new ApiError(401, 'The access token or provider session is invalid.');
/** A refused token, with the one check it failed in the Worker's log. Never a claim value. */
const refused = (check: string) => {
  console.error(JSON.stringify({ event: 'identity-refused', check }));
  return invalid();
};
const unavailable = () =>
  new ApiError(503, 'Identity verification is unavailable; try again when the provider recovers.');
/** The name of what a provider call threw, such as TypeError or AbortError. Never its message. */
const thrownName = (thrown: unknown) => {
  try {
    const name = (thrown as { name?: unknown } | null | undefined)?.name;
    return typeof name === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : 'unknown';
  } catch { return 'unknown'; }
};
/**
 * An unavailable answer, with the WorkOS step in the Worker's log, and either the HTTP status or,
 * when the call itself threw, the thrown value's name as `error` ('unknown' when it has no usable
 * one). Never a message, a URL, a header or a body.
 */
const unavailableAt = (step: string, status?: number, error?: string) => {
  console.error(JSON.stringify({ event: 'identity-unavailable', step, ...(status === undefined ? {} : { status }),
    ...(error === undefined ? {} : { error }) }));
  return unavailable();
};

function decode(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw invalid();
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = fromBase64url(segment); } catch { throw invalid(); }
  if (base64url(bytes) !== segment) throw invalid();
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    throw invalid();
  }
}

/**
 * WorkOS bearer verification, following the provider's documented RS256/JWKS
 * and active-session APIs. This does not implement OAuth, refresh or a password
 * flow. PKCE/public-client login remains with the official AuthKit client.
 *
 * AuthKit's default session token has no aud. API use requires a configured
 * resource audience; never disable that check to make a default token pass.
 * Provider org/role/entitlement claims deliberately grant no Diomedes rights.
 */
export class WorkOSIdentityVerifier implements IdentityVerifier {
  readonly issuer: string;
  private readonly clientId: string;
  private readonly audience: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cache: SigningKeyCache;
  /** This verifier's own key fetch, so a request only ever waits on a fetch it started. */
  private refreshing: Promise<void> | null = null;

  constructor(config: WorkOSIdentityConfiguration) {
    const url = new URL(config.issuer);
    if (
      !/^client_[A-Za-z0-9_-]{1,120}$/.test(config.clientId) ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !config.audience.trim() ||
      config.audience.length > 500 ||
      !config.apiKey.trim() ||
      /[\r\n]/.test(config.apiKey)
    )
      throw new Error(
        'Configure WORKOS_CLIENT_ID, WORKOS_ISSUER, WORKOS_TOKEN_AUDIENCE and server-only WORKOS_API_KEY.',
      );
    this.clientId = config.clientId;
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.apiKey = config.apiKey;
    // workerd refuses fetch called as this.fetcher(...) ("Illegal invocation"); call the global itself.
    this.fetcher = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = config.now ?? Date.now;
    this.cache = config.signingKeys ?? signingKeyCache();
  }

  private async getJson(url: string, authenticated: boolean, step: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: 'GET',
          // workerd refuses 'error'; with 'manual' a 3xx fails the !response.ok check below unfollowed.
          redirect: 'manual',
          headers: authenticated
            ? { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' }
            : { Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch (error) {
        throw unavailableAt(step, undefined, thrownName(error));
      } // Transport only; no fallback or credentials in the error.
      if (response.status === 404 && authenticated) throw invalid();
      if (!response.ok || !response.body) throw unavailableAt(step, response.status);
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(response, 1024 * 1024)));
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw unavailableAt(step);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async refreshKeys() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const started = this.now();
        const parsed = keysSchema.safeParse(
          await this.getJson(`${API}/sso/jwks/${this.clientId}`, false, 'jwks'),
        );
        if (
          !parsed.success ||
          new Set(parsed.data.keys.map((key) => key.kid)).size !== parsed.data.keys.length
        )
          throw unavailableAt('jwks-shape');
        // A fetch that started before the stored keys were fetched finished late with older keys:
        // keep the newer ones. Both together, with no await between, so a reader never sees new
        // keys with an old time. The time kept is when the fetch started.
        if (started < this.cache.fetchedAt) return;
        this.cache.keys = parsed.data.keys;
        this.cache.fetchedAt = started;
      })();
    }
    const pending = this.refreshing;
    try {
      await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = null;
    }
  }

  private async key(kid: string): Promise<SigningKey> {
    let fetched = false;
    if (this.now() - this.cache.fetchedAt >= 300_000) {
      await this.refreshKeys();
      fetched = true;
    }
    let match = this.cache.keys.find((key) => key.kid === kid);
    if (!match && !fetched) {
      // The keys are shared across requests, so another request may have fetched them moments
      // before WorkOS published this key. That is no reason to refuse the token: answer unavailable
      // until the thirty seconds pass and the keys may be fetched again.
      if (this.now() - this.cache.fetchedAt < 30_000) throw unavailableAt('signing-key-recent');
      await this.refreshKeys();
      match = this.cache.keys.find((key) => key.kid === kid);
    }
    if (!match) throw refused('signing-key');
    let modulus: Uint8Array<ArrayBuffer>;
    try { modulus = fromBase64url(match.n); } catch { throw unavailable(); }
    if (
      base64url(modulus) !== match.n ||
      modulus.length < 256 ||
      modulus.length > 1024 ||
      modulus[0] < 128
    )
      throw unavailable();
    return match;
  }

  private async activeSession(subject: string, sessionId: string) {
    let after: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${API}/user_management/users/${subject}/sessions`);
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);
      const result = sessionsSchema.safeParse(await this.getJson(url.href, true, 'sessions'));
      if (!result.success) throw unavailableAt('sessions-shape');
      const match = result.data.data.find((session) => session.id === sessionId);
      if (match) {
        if (
          match.user_id !== subject ||
          match.status !== 'active' ||
          match.ended_at !== null ||
          match.impersonator != null ||
          Date.parse(match.expires_at) <= this.now()
        )
          throw invalid();
        return Date.parse(match.expires_at);
      }
      after = result.data.list_metadata.after;
      if (after === null) throw invalid();
      if (cursors.has(after)) throw unavailable();
      cursors.add(after);
    }
    throw unavailable(); // A bounded lookup cannot prove this session active.
  }

  async verify(accessToken: string): Promise<VerifiedIdentity> {
    if (typeof accessToken !== 'string' || accessToken.length > 16_384) throw invalid();
    const parts = accessToken.split('.');
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[2])) throw invalid();
    const header = z
      .strictObject({ alg: z.literal('RS256'), kid: providerId, typ: z.literal('JWT').optional() })
      .safeParse(decode(parts[0]));
    const parsed = jwtClaims.safeParse(decode(parts[1]));
    if (!header.success) throw refused('header');
    if (!parsed.success) throw refused('claims-shape');
    const claims = parsed.data;
    const seconds = this.now() / 1000;
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    // WorkOS's documentation shows the bare API origin as the issuer, but a live AuthKit
    // token carries its client's issuer, the one its OpenID configuration publishes:
    // https://api.workos.com/user_management/<client_id>. Both are exact matches, and
    // client_id and the signature below still bind the token to this client.
    const checks: [string, boolean][] = [
      ['issuer', claims.iss === this.issuer || claims.iss === `${this.issuer.replace(/\/+$/, '')}/user_management/${this.clientId}`],
      ['client', claims.client_id === this.clientId],
      ['audience', audiences.includes(this.audience)],
      ['subject', claims.sub.startsWith('user_')],
      ['session', claims.sid.startsWith('session_')],
      ['actor', claims.act === undefined],
      ['lifetime', !(claims.exp <= seconds || claims.iat > seconds + 5 || claims.exp <= claims.iat ||
        claims.exp - claims.iat > 3600 || (claims.nbf !== undefined && claims.nbf > seconds + 5))],
    ];
    const failed = checks.find(([, passed]) => !passed);
    if (failed) throw refused(failed[0]);
    const key = await this.key(header.data.kid);
    let signature: Uint8Array<ArrayBuffer>;
    try { signature = fromBase64url(parts[2]); } catch { throw invalid(); }
    if (base64url(signature) !== parts[2]) throw invalid();
    let valid: boolean;
    try {
      const publicKey = await crypto.subtle.importKey('jwk', key,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey,
        signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    } catch (error) {
      if (!(error instanceof DOMException) && !(error instanceof TypeError)) throw error;
      throw unavailable();
    }
    if (!valid) throw refused('signature');
    const [sessionExpires, userInput] = await Promise.all([
      this.activeSession(claims.sub, claims.sid),
      this.getJson(`${API}/user_management/users/${claims.sub}`, true, 'user'),
    ]);
    const user = userSchema.safeParse(userInput);
    if (!user.success) throw unavailableAt('user-shape');
    if (user.data.id !== claims.sub) throw invalid();
    if (!user.data.email_verified)
      throw new ApiError(403, 'Verify the account email before joining a Business workspace.');
    const expires = Math.min(claims.exp * 1000, sessionExpires);
    if (expires <= this.now()) throw invalid();
    return {
      issuer: this.issuer,
      subject: claims.sub,
      sessionId: claims.sid,
      emailVerified: true,
      // Verified above. Only an email-bound invitation code reads it.
      email: user.data.email?.toLowerCase() ?? null,
      displayName:
        [user.data.first_name, user.data.last_name]
          .filter(Boolean)
          .join(' ')
          .trim()
          .slice(0, 200) || 'Account holder',
      issuedAt: new Date(claims.iat * 1000).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      verifiedAt: new Date(this.now()).toISOString(),
    };
  }
}
