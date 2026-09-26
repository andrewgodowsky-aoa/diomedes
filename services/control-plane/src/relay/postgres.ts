import { z } from 'zod';
import { featureGrantSchema, type FeatureGrant } from '../commercial.js';
import { recordSchemas, type MembershipRow, type SessionRecord } from '../domain.js';
import { inTransaction, type ClientFactory, type SqlClient } from '../postgres.js';
import { RELAY_DEVICE_LIMIT, relayDeviceSchema, type RelayDevice, type RelayRepository, type RelayTransaction } from './service.js';

/** A timestamptz as the driver returns it (a Date, or text), as ISO 8601 in UTC. */
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('A relay device time is unreadable.');
  return date.toISOString();
}

const COLUMNS = 'device_id,tenant_id,organization_id,person_id,public_key,label,created_at,revoked_at,revoked_by,last_seen_at';

function deviceRow(row: Record<string, unknown>): RelayDevice {
  return relayDeviceSchema.parse({
    deviceId: row.device_id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    personId: row.person_id,
    publicKey: row.public_key,
    label: row.label,
    createdAt: iso(row.created_at),
    revokedAt: iso(row.revoked_at),
    revokedBy: row.revoked_by ?? null,
    lastSeenAt: iso(row.last_seen_at),
  });
}

const generation = z.number().int().nonnegative().max(2_147_483_647);
const memberRow = z.object({ record: recordSchemas.membership, generation });

/**
 * Migration 006's table, and the account and access rows the relay rechecks by
 * id. Same discipline as the other adapters: one request-owned client per
 * transaction, parameterized SQL, rows parsed through the record schemas, and
 * only the statements scripts/runtime-permissions.sql grants cp_runtime.
 */
export class PostgresRelayTransaction implements RelayTransaction {
  constructor(private readonly client: SqlClient) {}

  async lockOrganization(organizationId: string) {
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['relay', organizationId])]);
  }
  async devices(organizationId: string): Promise<RelayDevice[]> {
    const result = await this.client.query(
      `SELECT ${COLUMNS} FROM control_plane.relay_devices WHERE organization_id=$1 AND revoked_at IS NULL ORDER BY created_at, device_id LIMIT ${RELAY_DEVICE_LIMIT + 1}`,
      [organizationId]);
    return result.rows.map(deviceRow);
  }
  async device(organizationId: string, deviceId: string): Promise<RelayDevice | undefined> {
    const result = await this.client.query(
      `SELECT ${COLUMNS} FROM control_plane.relay_devices WHERE organization_id=$1 AND device_id=$2`, [organizationId, deviceId]);
    return result.rows.length ? deviceRow(result.rows[0]) : undefined;
  }
  async insertDevice(row: RelayDevice) {
    const checked = relayDeviceSchema.parse(row);
    await this.client.query(`INSERT INTO control_plane.relay_devices(${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      checked.deviceId, checked.tenantId, checked.organizationId, checked.personId, checked.publicKey, checked.label,
      checked.createdAt, checked.revokedAt, checked.revokedBy, checked.lastSeenAt,
    ]);
  }
  async revokeDevice(organizationId: string, deviceId: string, at: string, by: string) {
    const result = await this.client.query(
      'UPDATE control_plane.relay_devices SET revoked_at=$3, revoked_by=$4 WHERE organization_id=$1 AND device_id=$2 AND revoked_at IS NULL RETURNING device_id',
      [organizationId, deviceId, at, by]);
    return result.rows.length === 1;
  }
  async touchDevice(organizationId: string, deviceId: string, at: string) {
    await this.client.query(
      'UPDATE control_plane.relay_devices SET last_seen_at=$3 WHERE organization_id=$1 AND device_id=$2 AND revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at < $3)',
      [organizationId, deviceId, at]);
  }
  async member(organizationId: string, personId: string): Promise<MembershipRow | undefined> {
    const result = await this.client.query('SELECT record,generation FROM control_plane.memberships WHERE organization_id=$1 AND person_id=$2', [organizationId, personId]);
    return result.rows.map((row) => memberRow.parse(row)).find((row) => row.record.organizationId === organizationId && row.record.personId === personId);
  }
  async grants(organizationId: string): Promise<FeatureGrant[]> {
    const result = await this.client.query("SELECT record FROM control_plane.feature_grants WHERE organization_id=$1 ORDER BY record->>'issuedAt' LIMIT 500", [organizationId]);
    return result.rows.map((row) => featureGrantSchema.parse(row.record));
  }
  async session(issuer: string, sessionId: string): Promise<SessionRecord | undefined> {
    const result = await this.client.query('SELECT record FROM control_plane.sessions WHERE issuer=$1 AND session_id=$2', [issuer, sessionId]);
    return result.rows.length ? recordSchemas.session.parse(result.rows[0].record) : undefined;
  }
}

export class PostgresRelayRepository implements RelayRepository {
  constructor(private readonly factory: ClientFactory) {}
  transaction<T>(action: (tx: RelayTransaction) => Promise<T>) {
    return inTransaction(this.factory, (client) => action(new PostgresRelayTransaction(client)));
  }
}
