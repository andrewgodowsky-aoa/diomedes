/**
 * The relay's SQL adapter against a recording client, and against the Worker
 * login's grant file. Protocol only: this does not run PostgreSQL. It checks
 * the statement each RelayTransaction method sends, that every value is a bound
 * parameter, that rows read back exactly as the faux store holds them, and that
 * the statements need exactly the relay_devices privileges
 * scripts/runtime-permissions.sql grants cp_runtime, both ways.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFauxCloud } from '../src/faux/cloud.js';
import { seedDemo } from '../src/faux/seed.js';
import type { SqlClient } from '../src/postgres.js';
import { PostgresRelayRepository, PostgresRelayTransaction } from '../src/relay/postgres.js';
import { RELAY_DEVICE_LIMIT, type RelayDevice, type RelayTransaction } from '../src/relay/service.js';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function recording(rows: (sql: string, values: unknown[]) => Record<string, unknown>[] = () => []) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client: SqlClient = {
    async connect() {},
    async query(sql, values = []) {
      calls.push({ sql, values });
      const result = rows(sql, values);
      return { rows: result, rowCount: result.length };
    },
    async end() {},
  };
  return { client, factory: () => client, calls };
}

const device: RelayDevice = {
  deviceId: 'relay_device_1', tenantId: 'tenant_1', organizationId: 'org_1', personId: 'person_1',
  publicKey: `${'Q'.repeat(42)}A`, label: 'Front counter', createdAt: '2026-09-26T12:00:00.000Z',
  revokedAt: null, revokedBy: null, lastSeenAt: null,
};
const deviceRow = (row: RelayDevice, time: (iso: string) => unknown) => ({
  device_id: row.deviceId, tenant_id: row.tenantId, organization_id: row.organizationId, person_id: row.personId,
  public_key: row.publicKey, label: row.label, created_at: time(row.createdAt),
  revoked_at: row.revokedAt && time(row.revokedAt), revoked_by: row.revokedBy, last_seen_at: row.lastSeenAt && time(row.lastSeenAt),
});

/** Every RelayTransaction method once, in a fixed order. */
async function everyMethod(tx: RelayTransaction) {
  await tx.lockOrganization('org_1');
  await tx.devices('org_1');
  await tx.device('org_1', 'relay_device_1');
  await tx.insertDevice(device);
  await tx.revokeDevice('org_1', 'relay_device_1', '2026-09-26T12:01:00.000Z', 'person_2');
  await tx.touchDevice('org_1', 'relay_device_1', '2026-09-26T12:02:00.000Z');
  await tx.member('org_1', 'person_1');
  await tx.grants('org_1');
  await tx.session('https://issuer.test', 'session_1');
}

describe('relay SQL adapter protocol', () => {
  it('binds every value, locks per business, and keeps revoked devices out of the list', async () => {
    const db = recording();
    await everyMethod(new PostgresRelayTransaction(db.client));
    expect(db.calls[0]).toEqual({ sql: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', values: [JSON.stringify(['relay', 'org_1'])] });
    expect(db.calls[1].sql).toMatch(/WHERE organization_id=\$1 AND revoked_at IS NULL ORDER BY created_at, device_id LIMIT (\d+)$/);
    expect(db.calls[1].sql.endsWith(`LIMIT ${RELAY_DEVICE_LIMIT + 1}`)).toBe(true);
    expect(db.calls[3].values).toEqual(['relay_device_1', 'tenant_1', 'org_1', 'person_1', device.publicKey, 'Front counter',
      '2026-09-26T12:00:00.000Z', null, null, null]);
    expect(db.calls[4]).toEqual({
      sql: 'UPDATE control_plane.relay_devices SET revoked_at=$3, revoked_by=$4 WHERE organization_id=$1 AND device_id=$2 AND revoked_at IS NULL RETURNING device_id',
      values: ['org_1', 'relay_device_1', '2026-09-26T12:01:00.000Z', 'person_2'],
    });
    // Last seen only ever moves forward, and never on a revoked device.
    expect(db.calls[5].sql).toContain('AND revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at < $3)');
    // No id, key, name or time is ever spliced into the SQL text.
    for (const { sql } of db.calls)
      for (const value of ['org_1', 'relay_device_1', 'person_1', 'tenant_1', device.publicKey, 'Front counter', '2026-09-26', 'issuer.test', 'session_1'])
        expect(sql).not.toContain(value);
  });

  it('refuses a malformed device before it reaches the database', async () => {
    const db = recording();
    const tx = new PostgresRelayTransaction(db.client);
    await expect(tx.insertDevice({ ...device, publicKey: 'too-short' })).rejects.toThrow();
    await expect(tx.insertDevice({ ...device, label: '' })).rejects.toThrow();
    expect(db.calls).toEqual([]);
  });

  it('answers whether a revocation wrote the tombstone', async () => {
    const written = recording((sql) => (sql.startsWith('UPDATE') ? [{ device_id: 'relay_device_1' }] : []));
    expect(await new PostgresRelayTransaction(written.client).revokeDevice('org_1', 'relay_device_1', '2026-09-26T12:01:00.000Z', 'person_1')).toBe(true);
    const none = recording();
    expect(await new PostgresRelayTransaction(none.client).revokeDevice('org_1', 'relay_device_1', '2026-09-26T12:01:00.000Z', 'person_1')).toBe(false);
  });

  it('reads a device back the same whether the driver answers with Dates or text', async () => {
    const revoked: RelayDevice = { ...device, revokedAt: '2026-09-26T12:05:00.000Z', revokedBy: 'person_2', lastSeenAt: '2026-09-26T12:04:00.000Z' };
    for (const time of [(iso: string) => new Date(iso), (iso: string) => iso.replace('.000Z', '+00:00')]) {
      const db = recording((sql) => (sql.includes('FROM control_plane.relay_devices') ? [deviceRow(device, time), deviceRow(revoked, time)] : []));
      const tx = new PostgresRelayTransaction(db.client);
      expect(await tx.devices('org_1')).toEqual([device, revoked]);
      expect(await tx.device('org_1', 'relay_device_1')).toEqual(device);
    }
    const unreadable = recording(() => [{ ...deviceRow(device, (iso) => iso), created_at: 'not a time' }]);
    await expect(new PostgresRelayTransaction(unreadable.client).device('org_1', 'relay_device_1')).rejects.toThrow('unreadable');
  });

  it('reads the member, plan and sign-in rows the relay rechecks exactly as the faux store holds them', async () => {
    const cloud = await createFauxCloud({ file: null, now: () => Date.parse('2026-09-26T12:00:00.000Z'), passwordIterations: 1_000 });
    const { organizations } = await seedDemo(cloud);
    const state = cloud.store.snapshot();
    const organizationId = organizations!.juniper;
    const membership = state.accounts.memberships.find((row) => row.record.organizationId === organizationId && row.record.role === 'admin')!;
    const session = state.accounts.sessions[0];
    const db = recording((sql, values) => {
      if (sql.includes('FROM control_plane.memberships'))
        return state.accounts.memberships.filter((row) => row.record.organizationId === values[0] && row.record.personId === values[1])
          .map((row) => ({ record: row.record, generation: row.generation }));
      if (sql.includes('FROM control_plane.feature_grants'))
        return state.commercial.grants.filter((row) => row.organizationId === values[0]).map((record) => ({ record }));
      if (sql.includes('FROM control_plane.sessions'))
        return state.accounts.sessions.filter((row) => row.issuer === values[0] && row.sessionId === values[1]).map((record) => ({ record }));
      return [];
    });
    const sql = new PostgresRelayTransaction(db.client);
    expect(await sql.member(organizationId, membership.record.personId)).toEqual(await cloud.store.relay.transaction((tx) => tx.member(organizationId, membership.record.personId)));
    expect(await sql.member(organizationId, 'person_nobody')).toBeUndefined();
    const grants = await sql.grants(organizationId);
    expect(grants.length).toBeGreaterThan(0);
    expect(grants).toEqual(await cloud.store.relay.transaction((tx) => tx.grants(organizationId)));
    expect(await sql.session(session.issuer, session.sessionId)).toEqual(await cloud.store.relay.transaction((tx) => tx.session(session.issuer, session.sessionId)));
  });

  it('runs each use in one transaction and rolls back when it fails', async () => {
    const committed = recording();
    await new PostgresRelayRepository(committed.factory).transaction((tx) => tx.devices('org_1'));
    const sql = committed.calls.map((call) => call.sql);
    expect(sql[0]).toBe('BEGIN');
    expect(sql.at(-1)).toBe('COMMIT');
    const failed = recording();
    await expect(new PostgresRelayRepository(failed.factory).transaction(async (tx) => {
      await tx.lockOrganization('org_1');
      throw new Error('refused');
    })).rejects.toThrow('refused');
    expect(failed.calls.map((call) => call.sql)).toContain('ROLLBACK');
    expect(failed.calls.map((call) => call.sql)).not.toContain('COMMIT');
  });
});

// --- the Worker login's grants -------------------------------------------------------------------

interface Privileges { select: boolean; insert: boolean; update: Set<string> }

/** Split at commas outside parentheses. */
function topLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** cp_runtime's table grants. Statements other than table GRANTs (the schema and revoke lines) are not table grants. */
function runtimeGrants(sql: string): Map<string, Privileges> {
  const tables = new Map<string, Privileges>();
  const statements = sql.split('\n').map((line) => line.replace(/--.*$/, '')).join(' ')
    .split(';').map((statement) => statement.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const statement of statements) {
    const grant = /^GRANT (.+?) ON (control_plane\.\w+(?:, control_plane\.\w+)*) TO cp_runtime$/.exec(statement);
    if (!grant) continue;
    for (const table of grant[2].split(',').map((name) => name.trim().replace(/^control_plane\./, ''))) {
      const entry = tables.get(table) ?? { select: false, insert: false, update: new Set<string>() };
      for (const privilege of topLevel(grant[1])) {
        const parsed = /^(SELECT|INSERT|UPDATE)(?: \(([a-z_]+(?:, [a-z_]+)*)\))?$/.exec(privilege);
        if (!parsed) throw new Error(`Unrecognized privilege "${privilege}" in: ${statement}`);
        if (parsed[1] === 'SELECT') entry.select = true;
        if (parsed[1] === 'INSERT') entry.insert = true;
        if (parsed[1] === 'UPDATE') for (const column of parsed[2] ? parsed[2].split(', ') : ['*']) entry.update.add(column);
      }
      tables.set(table, entry);
    }
  }
  return tables;
}

/** What each recorded statement needs, per table (PostgreSQL's GRANT, INSERT, UPDATE and SELECT pages). */
function needs(statements: string[]): Map<string, Privileges> {
  const tables = new Map<string, Privileges>();
  const entry = (table: string) => {
    const found = tables.get(table) ?? { select: false, insert: false, update: new Set<string>() };
    tables.set(table, found);
    return found;
  };
  for (const text of statements) {
    let match: RegExpExecArray | null;
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text) || /^SET LOCAL \w+ = '[^']*'$/.test(text)) continue;
    if (text === 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))') continue;
    if ((match = /^INSERT INTO control_plane\.(\w+)\(/.exec(text))) {
      if (/ ON CONFLICT | RETURNING /.test(text)) throw new Error(`Name what this needs: ${text}`);
      entry(match[1]).insert = true;
    } else if ((match = /^UPDATE control_plane\.(\w+) SET (.+?) WHERE /.exec(text))) {
      for (const assignment of topLevel(match[2])) entry(match[1]).update.add(assignment.split('=')[0].trim());
      // The WHERE clause and RETURNING read the row.
      entry(match[1]).select = true;
    } else if ((match = /^SELECT .+? FROM control_plane\.(\w+) WHERE /.exec(text))) {
      if (/ FOR (UPDATE|SHARE)\b| JOIN /.test(text)) throw new Error(`Name what this needs: ${text}`);
      entry(match[1]).select = true;
    } else throw new Error(`Unrecognized statement: ${text}`);
  }
  return tables;
}

const describePrivileges = (entry: Privileges | undefined) =>
  entry && { select: entry.select, insert: entry.insert, update: [...entry.update].sort() };

describe('the Worker login and the relay', () => {
  it('needs exactly the relay_devices privileges cp_runtime is granted, and only reads the rows it rechecks', async () => {
    const db = recording();
    await new PostgresRelayRepository(db.factory).transaction(everyMethod);
    const used = needs(db.calls.map((call) => call.sql));
    const granted = runtimeGrants(read('../scripts/runtime-permissions.sql'));
    // Both ways: every privilege the adapter uses is granted, and nothing granted on the table goes unused.
    expect(describePrivileges(used.get('relay_devices'))).toEqual(describePrivileges(granted.get('relay_devices')));
    expect(describePrivileges(used.get('relay_devices'))).toEqual({ select: true, insert: true, update: ['last_seen_at', 'revoked_at', 'revoked_by'] });
    // The account and plan rows are only read, and cp_runtime may read them.
    for (const table of ['memberships', 'feature_grants', 'sessions']) {
      expect(describePrivileges(used.get(table))).toEqual({ select: true, insert: false, update: [] });
      expect(granted.get(table)?.select).toBe(true);
    }
    expect([...used.keys()].sort()).toEqual(['feature_grants', 'memberships', 'relay_devices', 'sessions']);
  });

  it('never deletes or rewrites who registered a key', () => {
    const adapter = read('../src/relay/postgres.ts');
    expect(adapter).not.toMatch(/\b(DELETE|TRUNCATE|DROP)\b/);
    const granted = runtimeGrants(read('../scripts/runtime-permissions.sql')).get('relay_devices')!;
    for (const column of ['device_id', 'tenant_id', 'organization_id', 'person_id', 'public_key', 'label', 'created_at', '*'])
      expect(granted.update.has(column)).toBe(false);
  });
});
