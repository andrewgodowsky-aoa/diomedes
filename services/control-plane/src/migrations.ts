import type { ClientFactory } from './postgres.js';
import { inTransaction } from './postgres.js';

export interface Migration { version: number; name: string; sql: string; sha256: string }

/** Trusted, versioned source SQL only. This API is absent from the Worker entry. */
export async function migrate(factory: ClientFactory, migrations: readonly Migration[]): Promise<number[]> {
  if (migrations.some((item, index) => item.version !== index + 1 || !item.name || !item.sql || !/^[a-f0-9]{64}$/.test(item.sha256)))
    throw new Error('Migration sequence must be contiguous, named and hashed.');
  return inTransaction(factory, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(474946082901)');
    await client.query('CREATE SCHEMA IF NOT EXISTS control_plane');
    await client.query('REVOKE ALL ON SCHEMA control_plane FROM PUBLIC');
    await client.query('CREATE TABLE IF NOT EXISTS control_plane.schema_migrations (version integer PRIMARY KEY, name text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const history = (await client.query('SELECT version, name, sha256 FROM control_plane.schema_migrations ORDER BY version')).rows;
    for (let index = 0; index < history.length; index++) {
      const old = history[index]; const expected = migrations[index];
      if (!expected || old.version !== expected.version || old.name !== expected.name || old.sha256 !== expected.sha256)
        throw new Error('Migration history does not match the versioned source; repair requires review.');
    }
    const applied: number[] = [];
    for (const item of migrations.slice(history.length)) {
      await client.query(item.sql);
      await client.query('INSERT INTO control_plane.schema_migrations(version,name,sha256) VALUES ($1,$2,$3)', [item.version, item.name, item.sha256]);
      applied.push(item.version);
    }
    return applied;
  });
}
