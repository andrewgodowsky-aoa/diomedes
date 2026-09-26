/**
 * A person's WorkOS sign-in on this computer, as the account session uses it.
 *
 * The deployed account service signs people in through WorkOS AuthKit in the system browser. The
 * WorkOS access token is then the account service's bearer. The desktop's native sign-in
 * (desktop/native-auth.ts) implements this port in the Electron main process: its tokens stay
 * there, sealed in protected storage, and the renderer never receives one.
 */
import type { BrowserSignInConfig } from './deployment.js';

export interface BrowserSession {
  accessToken: string;
  user: { id: string; email: string; name: string };
}

export interface BrowserIdentity {
  /** Open the system browser at WorkOS's sign-in. Resolves once it is open. */
  begin(): Promise<void>;
  /**
   * The WorkOS session this computer keeps, or null when it keeps none. With `fresh`, WorkOS issues
   * a new access token first. Throws when a kept session could not be read or renewed just now.
   */
  session(options?: { fresh?: boolean }): Promise<BrowserSession | null>;
  /** End the WorkOS session on this computer; the kept sign-in is cleared. */
  signOut(): Promise<void>;
  /** Where the sign-in stands. `message` says why the last one did not finish, when it did not. */
  status(): { status: 'unavailable' | 'signed-out' | 'signing-in' | 'signed-in'; message: string };
  /** Told when a sign-in starts, finishes, fails or ends. Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

/** What the account session takes from a checked token. */
export interface BrowserTokenClaims {
  subject: string;
  sessionId: string;
  expiresAt: string;
}

/**
 * Check a WorkOS access token before it is sent as the account service's bearer: it names one of the
 * exact issuers the service accepts, was issued to this WorkOS client for the service's audience,
 * names a WorkOS user and session, and has not expired. Native sign-in has verified its signature,
 * and the service verifies all of it again. This keeps a token meant for anything else on this
 * computer. Null when the token fails any check.
 */
export function checkBrowserToken(token: string, expected: BrowserSignInConfig, now: number = Date.now()): BrowserTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (typeof claims.iss !== 'string' || !expected.issuers.includes(claims.iss)) return null;
  if (!audiences.includes(expected.audience)) return null;
  if (claims.client_id !== expected.clientId) return null;
  if (typeof claims.sub !== 'string' || !/^user_[A-Za-z0-9_-]+$/.test(claims.sub)) return null;
  if (typeof claims.sid !== 'string' || !/^session_[A-Za-z0-9_-]+$/.test(claims.sid)) return null;
  if (typeof claims.exp !== 'number' || !Number.isInteger(claims.exp) || claims.exp * 1000 <= now) return null;
  return { subject: claims.sub, sessionId: claims.sid, expiresAt: new Date(claims.exp * 1000).toISOString() };
}
