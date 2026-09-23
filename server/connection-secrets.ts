/**
 * Protected storage for one model-API connection's credential.
 *
 *   <data>/connection-secrets/<connectionId>.sealed   the sealed bytes, nothing else
 *
 * The server never keeps a provider credential in Settings, a run record, a
 * transcript, an error or a log. It asks a `SecretBox` to seal the bytes and
 * keeps only the sealed blob. The desktop shell supplies the box from the
 * operating system's protected storage (Electron `safeStorage`: DPAPI on
 * Windows, Keychain on macOS), the same mechanism `desktop/native-auth-storage.ts`
 * uses for the person's own sign-in. A server started without a box (plain
 * `npm run dev`) stores nothing and says so; there is no plaintext fallback.
 *
 * `server/secrets.ts` stays what it is, a redaction helper. This is the store.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HarnessError } from './harness/policy.js';
import { durableWrite } from './store.js';

/** OS-backed sealing supplied by the desktop shell. `kind` names the backend for evidence. */
export interface SecretBox {
  readonly kind: string;
  available(): boolean;
  seal(plain: string): Buffer;
  open(sealed: Buffer): string;
}

const CONNECTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SECRET_BYTES = 16_384;
const MAX_SEALED_BYTES = 65_536;

/** A short, one-way identifier for noticing a changed credential. Never the credential. */
export const secretFingerprint = (secret: string) =>
  createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12);

export class ConnectionSecrets {
  constructor(
    private readonly dataDir: string,
    private readonly box: SecretBox | null,
  ) {}

  /** Whether a credential can be stored at all. False means setup must refuse, not degrade. */
  available(): boolean {
    try {
      return this.box?.available() === true;
    } catch {
      return false;
    }
  }

  backend(): string | null {
    return this.available() ? this.box!.kind : null;
  }

  private file(connectionId: string) {
    if (!CONNECTION_ID.test(connectionId))
      throw new HarnessError('invalid_connection', 'That connection id is not valid.');
    return path.join(this.dataDir, 'connection-secrets', `${connectionId}.sealed`);
  }

  async put(connectionId: string, secret: string): Promise<{ fingerprint: string }> {
    const target = this.file(connectionId);
    if (!this.available())
      throw new HarnessError(
        'credential_storage_unavailable',
        'Protected credential storage is available only in the Diomedes desktop app. Nothing was saved.',
      );
    if (
      typeof secret !== 'string' ||
      !secret ||
      secret !== secret.trim() ||
      Buffer.byteLength(secret) > MAX_SECRET_BYTES ||
      /[\r\n\0]/.test(secret)
    )
      throw new HarnessError('invalid_credential', 'That credential is not in a form Diomedes can store.');
    const sealed = this.box!.seal(secret);
    if (!Buffer.isBuffer(sealed) || !sealed.length || sealed.length > MAX_SEALED_BYTES)
      throw new HarnessError('credential_storage_failed', 'The credential could not be protected. Nothing was saved.');
    await durableWrite(target, sealed);
    return { fingerprint: secretFingerprint(secret) };
  }

  async get(connectionId: string): Promise<string> {
    const target = this.file(connectionId);
    if (!this.available())
      throw new HarnessError(
        'credential_storage_unavailable',
        'Protected credential storage is not available in this process.',
      );
    let sealed: Buffer;
    try {
      sealed = await fs.readFile(target);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new HarnessError('credential_missing', 'This connection has no saved credential.');
      throw error;
    }
    if (sealed.length > MAX_SEALED_BYTES)
      throw new HarnessError('credential_corrupt', 'The saved credential is not readable.');
    try {
      return this.box!.open(sealed);
    } catch {
      // Another OS account, a reset profile or a changed machine key: never guess.
      throw new HarnessError(
        'credential_unreadable',
        'The saved credential cannot be opened by this computer account. Enter it again.',
      );
    }
  }

  async remove(connectionId: string): Promise<void> {
    try {
      await fs.unlink(this.file(connectionId));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}

/**
 * A box for tests only. It is reversible by construction and labels itself so a
 * record made with it can never be mistaken for protected storage.
 */
export function testOnlySecretBox(): SecretBox {
  return {
    kind: 'test-only-reversible',
    available: () => true,
    seal: (plain) => Buffer.from(`test-only:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    open: (sealed) => {
      const text = sealed.toString('utf8');
      if (!text.startsWith('test-only:')) throw new Error('not sealed by this box');
      return Buffer.from(text.slice('test-only:'.length), 'base64').toString('utf8');
    },
  };
}
