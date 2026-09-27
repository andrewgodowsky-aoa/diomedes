import { z } from 'zod';
import { recordSchemas, type MembershipRow } from '../domain.js';
import { inTransaction, type ClientFactory, type SqlClient } from '../postgres.js';
import {
  organizationSetupRowSchema,
  type OrganizationSetupRepository,
  type OrganizationSetupRow,
  type OrganizationSetupTransaction,
} from './service.js';

/** A timestamptz as the driver returns it (a Date, or text), as ISO 8601 in UTC. */
function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('An organization setup time is unreadable.');
  return date.toISOString();
}

const COLUMNS = 'tenant_id,organization_id,revision,record,written_at,written_by';

function setupRow(row: Record<string, unknown>): OrganizationSetupRow {
  return organizationSetupRowSchema.parse({
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    revision: Number(row.revision),
    record: typeof row.record === 'string' ? JSON.parse(row.record) : row.record,
    writtenAt: iso(row.written_at),
    writtenBy: row.written_by,
  });
}

const generation = z.number().int().nonnegative().max(2_147_483_647);
const memberRow = z.object({ record: recordSchemas.membership, generation });

/**
 * Migration 008's table, and the membership row a write rechecks. Same
 * discipline as the relay adapter: one request-owned client per transaction,
 * parameterized SQL, rows parsed through the record schemas, and only the
 * statements scripts/runtime-permissions.sql grants cp_runtime (SELECT and
 * INSERT: a revision is never updated or deleted).
 */
export class PostgresOrganizationSetupTransaction implements OrganizationSetupTransaction {
  constructor(private readonly client: SqlClient) {}

  async lockOrganization(organizationId: string) {
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['organization-setup', organizationId])]);
  }
  async latest(organizationId: string): Promise<OrganizationSetupRow | undefined> {
    const result = await this.client.query(
      `SELECT ${COLUMNS} FROM control_plane.organization_setups WHERE organization_id=$1 ORDER BY revision DESC LIMIT 1`, [organizationId]);
    return result.rows.length ? setupRow(result.rows[0]) : undefined;
  }
  async insert(row: OrganizationSetupRow) {
    const checked = organizationSetupRowSchema.parse(row);
    await this.client.query(`INSERT INTO control_plane.organization_setups(${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6)`, [
      checked.tenantId, checked.organizationId, checked.revision, JSON.stringify(checked.record), checked.writtenAt, checked.writtenBy,
    ]);
  }
  async member(organizationId: string, personId: string): Promise<MembershipRow | undefined> {
    const result = await this.client.query('SELECT record,generation FROM control_plane.memberships WHERE organization_id=$1 AND person_id=$2', [organizationId, personId]);
    return result.rows.map((row) => memberRow.parse(row)).find((row) => row.record.organizationId === organizationId && row.record.personId === personId);
  }
}

export class PostgresOrganizationSetupRepository implements OrganizationSetupRepository {
  constructor(private readonly factory: ClientFactory) {}
  transaction<T>(action: (tx: OrganizationSetupTransaction) => Promise<T>) {
    return inTransaction(this.factory, (client) => action(new PostgresOrganizationSetupTransaction(client)));
  }
}
