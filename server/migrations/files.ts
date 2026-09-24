/**
 * Reading a versioned file through the migration framework.
 *
 * A file at the current version is returned as it is and never rewritten. An
 * older file is first copied, byte for byte, to a backup beside it, and only
 * then replaced (temp file, fsync, rename) by its migrated form. The backup is
 * named by the version and the digest of the bytes it holds, so a second open
 * after a stop between the two writes finds the same backup and finishes the
 * job instead of making another. Backups are never deleted automatically:
 * they are the evidence of what the file said before (decision 10).
 *
 * A newer or unknown version is refused and the file is left untouched.
 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { absent } from '../paths.js';
import { durableWrite } from '../store.js';
import { MigrationRefusal, migrateRecord, type DurableFamily, type DurableRecord } from './framework.js';

export interface OpenedFile {
  readonly record: DurableRecord;
  readonly from: number;
  readonly to: number;
  /** The backup written or found for this migration, or null when none was needed. */
  readonly backup: string | null;
}

/** Where the pre-migration copy of `file` at `from` with these bytes is kept. */
export function backupPath(file: string, from: number, bytes: string | Uint8Array) {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  return `${file}.v${from}.${digest}.bak`;
}

/**
 * Writes the backup (if it is not already there with these bytes) and then
 * the migrated record, replacing `file` only if it still holds `original`.
 */
export async function commitMigration(
  family: DurableFamily,
  file: string,
  original: string | Uint8Array,
  migrated: { record: DurableRecord; from: number },
  serialize: (record: DurableRecord) => string = (record) => JSON.stringify(record, null, 2),
): Promise<string> {
  const backup = backupPath(file, migrated.from, original);
  // Bytes, never decoded text: the backup is evidence of exactly what the file held.
  const originalBytes = typeof original === 'string' ? Buffer.from(original) : Buffer.from(original);
  let existing: Buffer | null;
  try {
    existing = await fs.readFile(backup);
  } catch (error) {
    if (!absent(error)) throw error;
    existing = null;
  }
  if (existing === null) await durableWrite(backup, originalBytes);
  else if (!existing.equals(originalBytes))
    throw new MigrationRefusal(
      'invalid-migration',
      family.id,
      migrated.from,
      `A backup of the ${family.title} already exists and holds different bytes. Nothing was changed.`,
    );
  await durableWrite(file, serialize(migrated.record), async () => {
    // The last look before replacing: another writer must not be overwritten
    // by a migration of what it replaced.
    if (!(await fs.readFile(file)).equals(originalBytes))
      throw new MigrationRefusal(
        'invalid-migration',
        family.id,
        migrated.from,
        `The ${family.title} changed while it was being carried forward. Nothing was changed.`,
      );
  });
  return backup;
}

/**
 * Reads `file` as `family`, carrying it forward when it is older. Returns null
 * when the file does not exist. Unparseable JSON and every refusal throw
 * without touching the file.
 */
export async function openVersionedFile(
  family: DurableFamily,
  file: string,
  serialize?: (record: DurableRecord) => string,
): Promise<OpenedFile | null> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new MigrationRefusal(
      'not-a-record',
      family.id,
      null,
      `The ${family.title} is not readable JSON. Nothing in it was changed.`,
    );
  }
  const result = migrateRecord(family, value);
  if (!result.migrated) return { record: result.record, from: result.from, to: result.to, backup: null };
  const backup = await commitMigration(family, file, bytes, result, serialize);
  return { record: result.record, from: result.from, to: result.to, backup };
}
