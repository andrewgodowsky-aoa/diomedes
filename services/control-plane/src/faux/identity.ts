/**
 * The faux identity provider: local email-and-password accounts standing in for
 * WorkOS AuthKit while the real sign-in is not configured.
 *
 * It implements the same `IdentityVerifier` seam as `identity-workos.ts`, so the
 * account service, membership checks and every route above them run the real
 * code. Only the question "who is this bearer?" is answered locally. It is
 * labelled everywhere it appears, it runs only in the faux cloud (never in the
 * Worker entry), and nothing it issues is accepted by the production verifier:
 * its issuer is a reserved `.test` origin and its tokens are HMAC, not RS256.
 *
 * Passwords are PBKDF2-SHA256 with a per-user salt. Access tokens live ten
 * minutes; refresh tokens rotate on every use and live 30 days when the person
 * chose "keep me signed in", 12 hours otherwise.
 */
import { z } from 'zod';
import { base64url, fromBase64url } from '../crypto.js';
import { AccountError } from '../errors.js';
import type { IdentityDirectory, IdentityVerifier, VerifiedIdentity } from '../domain.js';

export const FAUX_ISSUER = 'https://identity.faux.nectovia.test';
export const ACCESS_TOKEN_MS = 10 * 60_000;
export const REMEMBERED_SESSION_MS = 30 * 24 * 60 * 60_000;
export const SESSION_MS = 12 * 60 * 60_000;
const LOCKOUT_AFTER = 5;
const LOCKOUT_MS = 60_000;

const time = z.iso.datetime();
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

const user = z.strictObject({
  subject: id,
  email: z.email().max(320),
  name: z.string().trim().min(1).max(200),
  salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  iterations: z.number().int().min(1_000).max(2_000_000),
  createdAt: time,
  failedAttempts: z.number().int().min(0).max(1_000),
  lockedUntil: time.nullable(),
});
const session = z.strictObject({
  sessionId: id,
  subject: id,
  refreshHash: z.string().regex(/^[a-f0-9]{64}$/),
  remember: z.boolean(),
  createdAt: time,
  expiresAt: time,
  lastUsedAt: time,
  revokedAt: time.nullable(),
});
export const fauxIdentityStateSchema = z.strictObject({
  v: z.literal(1),
  /** The HMAC key for access tokens. Local to this faux store; rotating it signs everyone out. */
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  users: z.array(user).max(10_000),
  sessions: z.array(session).max(100_000),
});
export type FauxIdentityState = z.infer<typeof fauxIdentityStateSchema>;
export type FauxUser = z.infer<typeof user>;

export function emptyFauxIdentity(): FauxIdentityState {
  return { v: 1, secret: base64url(crypto.getRandomValues(new Uint8Array(32))), users: [], sessions: [] };
}

export const signUpInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(320),
  password: z.string().min(8).max(200),
  remember: z.boolean().optional(),
});
export const signInInput = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(1).max(200),
  remember: z.boolean().optional(),
});
export const refreshInput = z.strictObject({ refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export interface TokenPair {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  remember: boolean;
  user: { subject: string; email: string; name: string };
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function derive(password: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64url(salt), iterations }, key, 256);
  return base64url(new Uint8Array(bits));
}

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

async function hmac(secret: string, payload: string) {
  const key = await crypto.subtle.importKey('raw', fromBase64url(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

const accessPayload = z.strictObject({
  v: z.literal(1),
  iss: z.literal(FAUX_ISSUER),
  sub: id,
  sid: id,
  name: z.string().min(1).max(200),
  email: z.email().max(320),
  iat: z.number().int(),
  exp: z.number().int(),
});

/**
 * Operations over a caller-held identity state. The caller serializes them
 * (one store lock) and persists the state; these functions never do.
 */
export class FauxIdentityProvider {
  constructor(private readonly options: { now?: () => number; iterations?: number } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private iso(at = this.now()) { return new Date(at).toISOString(); }

  async signUp(state: FauxIdentityState, input: z.infer<typeof signUpInput>): Promise<TokenPair> {
    const parsed = signUpInput.safeParse(input);
    if (!parsed.success)
      throw new AccountError(422, 'Enter your name, an email address and a password of at least 8 characters.');
    const email = parsed.data.email.toLowerCase();
    if (state.users.some((row) => row.email === email))
      throw new AccountError(409, 'An account already uses that email. Sign in instead.');
    const salt = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const iterations = this.options.iterations ?? 210_000;
    const row: FauxUser = {
      subject: `user_${crypto.randomUUID().replace(/-/g, '')}`,
      email,
      name: parsed.data.name,
      salt,
      hash: await derive(parsed.data.password, salt, iterations),
      iterations,
      createdAt: this.iso(),
      failedAttempts: 0,
      lockedUntil: null,
    };
    state.users.push(row);
    return this.open(state, row, parsed.data.remember ?? false);
  }

  async signIn(state: FauxIdentityState, input: z.infer<typeof signInInput>): Promise<TokenPair> {
    const parsed = signInInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Enter your email address and password.');
    const email = parsed.data.email.toLowerCase();
    const row = state.users.find((item) => item.email === email);
    // One refusal for an unknown email and a wrong password, so neither is revealed.
    const refuse = () => new AccountError(401, 'That email and password do not match an account.');
    if (!row) {
      await derive(parsed.data.password, 'AAAAAAAAAAAAAAAAAAAAAA', this.options.iterations ?? 210_000);
      throw refuse();
    }
    if (row.lockedUntil && Date.parse(row.lockedUntil) > this.now())
      throw new AccountError(429, 'Too many attempts. Wait a minute and try again.');
    const hash = await derive(parsed.data.password, row.salt, row.iterations);
    if (!sameText(hash, row.hash)) {
      row.failedAttempts++;
      if (row.failedAttempts >= LOCKOUT_AFTER) {
        row.lockedUntil = this.iso(this.now() + LOCKOUT_MS);
        row.failedAttempts = 0;
      }
      throw refuse();
    }
    row.failedAttempts = 0;
    row.lockedUntil = null;
    return this.open(state, row, parsed.data.remember ?? false);
  }

  private async open(state: FauxIdentityState, row: FauxUser, remember: boolean): Promise<TokenPair> {
    const refreshToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const now = this.now();
    const record = {
      sessionId: `session_${crypto.randomUUID().replace(/-/g, '')}`,
      subject: row.subject,
      refreshHash: await sha256(refreshToken),
      remember,
      createdAt: this.iso(now),
      expiresAt: this.iso(now + (remember ? REMEMBERED_SESSION_MS : SESSION_MS)),
      lastUsedAt: this.iso(now),
      revokedAt: null,
    };
    state.sessions.push(record);
    return this.pair(state, row, record, refreshToken);
  }

  private async pair(state: FauxIdentityState, row: FauxUser, record: FauxIdentityState['sessions'][number], refreshToken: string): Promise<TokenPair> {
    const now = this.now();
    const exp = Math.min(now + ACCESS_TOKEN_MS, Date.parse(record.expiresAt));
    const payload = base64url(new TextEncoder().encode(JSON.stringify({
      v: 1, iss: FAUX_ISSUER, sub: row.subject, sid: record.sessionId, name: row.name, email: row.email,
      iat: Math.floor(now / 1000), exp: Math.floor(exp / 1000),
    })));
    return {
      accessToken: `fx1.${payload}.${await hmac(state.secret, `fx1.${payload}`)}`,
      accessExpiresAt: this.iso(Math.floor(exp / 1000) * 1000),
      refreshToken,
      refreshExpiresAt: record.expiresAt,
      remember: record.remember,
      user: { subject: row.subject, email: row.email, name: row.name },
    };
  }

  /** Trade a refresh token for a new pair. The old refresh token stops working. */
  async refresh(state: FauxIdentityState, input: z.infer<typeof refreshInput>): Promise<TokenPair> {
    const parsed = refreshInput.safeParse(input);
    if (!parsed.success) throw new AccountError(401, 'Sign in again.');
    const hash = await sha256(parsed.data.refreshToken);
    const record = state.sessions.find((row) => row.refreshHash === hash);
    if (!record || record.revokedAt !== null || Date.parse(record.expiresAt) <= this.now())
      throw new AccountError(401, 'This sign-in has ended. Sign in again.');
    const row = state.users.find((item) => item.subject === record.subject);
    if (!row) throw new AccountError(401, 'Sign in again.');
    const next = base64url(crypto.getRandomValues(new Uint8Array(32)));
    record.refreshHash = await sha256(next);
    record.lastUsedAt = this.iso();
    return this.pair(state, row, record, next);
  }

  /** End one sign-in. Unknown tokens succeed quietly: signing out is always allowed. */
  async signOut(state: FauxIdentityState, input: z.infer<typeof refreshInput>): Promise<void> {
    const parsed = refreshInput.safeParse(input);
    if (!parsed.success) return;
    const hash = await sha256(parsed.data.refreshToken);
    const record = state.sessions.find((row) => row.refreshHash === hash);
    if (record && record.revokedAt === null) record.revokedAt = this.iso();
  }

  /** Verify an access token against a state snapshot. */
  async verify(state: FauxIdentityState, token: string): Promise<VerifiedIdentity> {
    const refuse = () => new AccountError(401, 'A verified bearer session is required.');
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'fx1') throw refuse();
    const expected = await hmac(state.secret, `fx1.${parts[1]}`);
    if (!sameText(expected, parts[2])) throw refuse();
    let payload;
    try {
      payload = accessPayload.parse(JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]))));
    } catch {
      throw refuse();
    }
    const now = this.now();
    if (payload.exp * 1000 <= now || payload.iat * 1000 > now + 5_000) throw refuse();
    const record = state.sessions.find((row) => row.sessionId === payload.sid);
    if (!record || record.subject !== payload.sub || record.revokedAt !== null || Date.parse(record.expiresAt) <= now)
      throw new AccountError(401, 'This sign-in has ended. Sign in again.');
    const row = state.users.find((item) => item.subject === payload.sub);
    if (!row) throw refuse();
    return {
      issuer: FAUX_ISSUER,
      subject: payload.sub,
      sessionId: payload.sid,
      displayName: row.name,
      // The faux provider sends no verification email; every faux account reads as verified.
      emailVerified: true,
      email: row.email,
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      verifiedAt: new Date(now).toISOString(),
    };
  }
}

/** The IdentityVerifier the account service reads, over a live state reader. */
export class FauxIdentityVerifier implements IdentityVerifier {
  readonly issuer = FAUX_ISSUER;
  constructor(private readonly provider: FauxIdentityProvider, private readonly read: () => Promise<FauxIdentityState>) {}
  async verify(accessToken: string) {
    return this.provider.verify(await this.read(), accessToken);
  }
}

export class FauxIdentityDirectory implements IdentityDirectory {
  constructor(private readonly read: () => Promise<FauxIdentityState>) {}
  async lookup(issuer: string, subject: string) {
    if (issuer !== FAUX_ISSUER) return null;
    const row = (await this.read()).users.find((item) => item.subject === subject);
    return row ? { email: row.email, name: row.name } : null;
  }
}
