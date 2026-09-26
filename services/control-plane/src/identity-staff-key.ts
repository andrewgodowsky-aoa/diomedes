import { digest } from './crypto.js';
import { AccountError } from './errors.js';
import { inTransaction, type ClientFactory } from './postgres.js';
import type { IdentityVerifier, VerifiedIdentity } from './domain.js';

/**
 * Staff keys: how Diomedes staff sign in to the Operations app (2026-09-26).
 *
 * The app makes a key on the staff member's own computer and keeps it there,
 * encrypted by the operating system. An admin registers its SHA-256 in
 * control_plane.staff_keys (migrations/006_staff_keys.sql). Every /ops/* call
 * carries the key as its bearer; this verifier turns a registered, unwithdrawn
 * key into the same VerifiedIdentity a WorkOS sign-in produces, so the account
 * service maps it to a person and CommercialService checks the operator row as
 * before. The key id is both the subject and the session id: withdrawing the
 * key, or revoking its session, ends it. Customers still sign in through WorkOS.
 */
export const STAFF_KEY_ISSUER = 'https://accounts.diomedes.net/staff-keys';
/** "nsk_" and 32 random bytes, base64url without padding. */
export const STAFF_KEY = /^nsk_[A-Za-z0-9_-]{43}$/;
export const staffKeyId = (hash: string) => `staff_key_${hash.slice(0, 16)}`;
/** A verified key is re-checked on every call; this only bounds one proof. */
const PROOF_LIFETIME_MS = 10 * 60_000;

export interface StaffKeyRow {
  keyId: string;
  name: string;
  email: string | null;
  createdAt: string;
}
export type StaffKeyLookup = (hash: string) => Promise<StaffKeyRow | null>;

const unregistered = () => new AccountError(401, 'This staff key is not registered, or it was withdrawn. Ask a Diomedes admin.');

export class StaffKeyVerifier implements IdentityVerifier {
  readonly issuer = STAFF_KEY_ISSUER;
  private readonly now: () => number;
  constructor(private readonly lookup: StaffKeyLookup, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async verify(key: string): Promise<VerifiedIdentity> {
    if (typeof key !== 'string' || !STAFF_KEY.test(key)) throw unregistered();
    const hash = await digest(key);
    const row = await this.lookup(hash);
    if (!row || row.keyId !== staffKeyId(hash)) throw unregistered();
    const at = this.now();
    return {
      issuer: this.issuer,
      subject: row.keyId,
      sessionId: row.keyId,
      emailVerified: true,
      email: row.email,
      displayName: row.name,
      issuedAt: new Date(Math.min(Date.parse(row.createdAt), at)).toISOString(),
      expiresAt: new Date(at + PROOF_LIFETIME_MS).toISOString(),
      verifiedAt: new Date(at).toISOString(),
    };
  }
}

/** The Worker's lookup: one read, as the Worker login, of a registered and unwithdrawn key. */
export function postgresStaffKeys(factory: ClientFactory): StaffKeyLookup {
  return (hash) => inTransaction(factory, async (client) => {
    const result = await client.query(
      'SELECT key_id, name, email, created_at FROM control_plane.staff_keys WHERE key_hash=$1 AND revoked_at IS NULL', [hash]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      keyId: String(row.key_id),
      name: String(row.name),
      email: row.email === null ? null : String(row.email),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    };
  });
}
