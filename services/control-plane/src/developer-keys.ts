import { z } from 'zod';
import { developerKeyInput, developerKeyView } from '../../../shared/account-billing.js';
import type { AccountScope } from '../../../shared/routing-policy.js';
import { AccountError } from './errors.js';
import { base64url, digest } from './crypto.js';
import type { IdentityVerifier, VerifiedIdentity } from './domain.js';
import { inTransaction, type ClientFactory } from './postgres.js';

const rowSchema = developerKeyView.extend({ hash: z.string().regex(/^[a-f0-9]{64}$/), personId: z.string(), issuer: z.string(), subject: z.string(), identityGeneration: z.number().int().nonnegative(), displayName: z.string() });
export type DeveloperKeyRow = z.infer<typeof rowSchema>;
export interface DeveloperKeyStore {
  insert(row: DeveloperKeyRow): Promise<void>;
  list(personId: string): Promise<DeveloperKeyRow[]>;
  revoke(personId: string, id: string, at: string): Promise<boolean>;
  find(hash: string): Promise<DeveloperKeyRow | null>;
}
export interface DeveloperActor { actor: { person: { id: string; name: string }; mapping: { issuer: string; subject: string; identityGeneration: number } }; scope: AccountScope; tenantId?: string }
export type DeveloperScopeResolver = (token: string, organizationId: string | null) => Promise<DeveloperActor>;
const refused = () => new AccountError(401, 'This developer key is invalid, expired, revoked or unavailable for this account.');

export class DeveloperKeyService {
  constructor(private readonly store: DeveloperKeyStore, private readonly resolve: DeveloperScopeResolver, private readonly now = Date.now) {}
  async list(token: string) {
    const { actor } = await this.resolve(token, null);
    return (await this.store.list(actor.person.id)).map(row => developerKeyView.parse(row));
  }
  async create(token: string, input: unknown) {
    const parsed = developerKeyInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'Choose a name, account and expiry between 1 and 365 days.');
    const { actor, scope } = await this.resolve(token, parsed.data.organizationId);
    const at = this.now();
    const secret = `ndk_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const row: DeveloperKeyRow = { id: `developer_key_${crypto.randomUUID()}`, name: parsed.data.name, prefix: secret.slice(0, 12), hash: await digest(secret),
      personId: actor.person.id, issuer: actor.mapping.issuer, subject: actor.mapping.subject, identityGeneration: actor.mapping.identityGeneration, displayName: actor.person.name, scope,
      createdAt: new Date(at).toISOString(), expiresAt: new Date(at + parsed.data.expiresInDays * 86_400_000).toISOString(), revokedAt: null };
    await this.store.insert(row);
    return { key: developerKeyView.parse(row), secret };
  }
  async revoke(token: string, id: string) {
    const { actor } = await this.resolve(token, null);
    if (!await this.store.revoke(actor.person.id, id, new Date(this.now()).toISOString())) throw new AccountError(404, 'This developer key was not found.');
    return { revoked: true };
  }
}

/** Only constructed on /developer/v1. Never accepted by account, billing or Operations routes. */
export class DeveloperKeyVerifier implements IdentityVerifier {
  constructor(private readonly store: DeveloperKeyStore, readonly issuer: string, private readonly scope: AccountScope, private readonly now = Date.now) {}
  async verify(secret: string): Promise<VerifiedIdentity> {
    if (!/^ndk_[A-Za-z0-9_-]{43}$/.test(secret)) throw refused();
    const row = await this.store.find(await digest(secret));
    const at = this.now();
    if (!row || row.revokedAt || Date.parse(row.expiresAt) <= at || row.issuer !== this.issuer || row.scope.kind !== this.scope.kind || row.scope.id !== this.scope.id) throw refused();
    return { issuer: this.issuer, subject: row.subject, sessionId: row.id, displayName: row.displayName, emailVerified: true,
      issuedAt: row.createdAt, verifiedAt: new Date(at).toISOString(), expiresAt: new Date(Math.min(at + 60_000, Date.parse(row.expiresAt))).toISOString() };
  }
}

export class PostgresDeveloperKeys implements DeveloperKeyStore {
  constructor(private readonly factory: ClientFactory) {}
  insert(row: DeveloperKeyRow) {
    return inTransaction(this.factory, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`developer-keys:${row.personId}`]);
      const count = await client.query('SELECT count(*) AS total FROM control_plane.developer_keys WHERE person_id=$1 AND revoked_at IS NULL AND expires_at>now()', [row.personId]);
      if (Number(count.rows[0]?.total) >= 20) throw new AccountError(409, 'Revoke an existing developer key before creating another.');
      await client.query('INSERT INTO control_plane.developer_keys(id,person_id,key_hash,scope_id,issuer,subject,identity_generation,expires_at,record) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
        [row.id, row.personId, row.hash, row.scope.id, row.issuer, row.subject, row.identityGeneration, row.expiresAt, JSON.stringify(row)]);
    });
  }
  list(personId: string) {
    return inTransaction(this.factory, async client => (await client.query('SELECT record,revoked_at FROM control_plane.developer_keys WHERE person_id=$1 ORDER BY record->>\'createdAt\' DESC LIMIT 100', [personId])).rows.map(row => this.read(row)));
  }
  revoke(personId: string, id: string, at: string) {
    return inTransaction(this.factory, async client => (await client.query('UPDATE control_plane.developer_keys SET revoked_at=COALESCE(revoked_at,$3::timestamptz) WHERE person_id=$1 AND id=$2 RETURNING id', [personId, id, at])).rows.length === 1);
  }
  find(hash: string) {
    return inTransaction(this.factory, async client => {
      // Subject remapping and loss of the original Business owner/Manager role withdraw keys too.
      const result = await client.query(`SELECT k.record,k.revoked_at FROM control_plane.developer_keys k
        JOIN control_plane.external_subjects s ON s.issuer=k.issuer AND s.subject=k.subject AND s.person_id=k.person_id
        JOIN control_plane.billing_scopes b ON b.id=k.scope_id
        WHERE k.key_hash=$1 AND k.revoked_at IS NULL AND k.expires_at>now()
          AND (s.record->>'identityGeneration')::integer=k.identity_generation
          AND ((b.kind='individual' AND b.person_id=k.person_id AND b.record->>'state'='active') OR
            (b.kind='organization' AND EXISTS (SELECT 1 FROM control_plane.memberships m WHERE m.organization_id=b.id AND m.person_id=k.person_id
             AND m.record->>'state'='active' AND m.record->>'role' IN ('owner','admin'))))`, [hash]);
      return result.rows[0] ? this.read(result.rows[0]) : null;
    });
  }
  private read(row: Record<string, unknown>) {
    return rowSchema.parse({ ...rowSchema.parse(row.record), revokedAt: row.revoked_at ? new Date(row.revoked_at as string).toISOString() : null });
  }
}
