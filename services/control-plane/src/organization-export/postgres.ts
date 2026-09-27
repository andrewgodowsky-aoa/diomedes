import { z } from 'zod';
import { recordSchemas, type AccountEvent, type MembershipRow } from '../domain.js';
import { inTransaction, type ClientFactory, type SqlClient } from '../postgres.js';
import { SETUP_COLUMNS, setupRow } from '../organization-setup/postgres.js';
import type { OrganizationSetupRow } from '../organization-setup/service.js';
import type { OrganizationExportRepository, OrganizationExportTransaction } from './service.js';

const generation = z.number().int().nonnegative().max(2_147_483_647);
const memberRow = z.object({ record: recordSchemas.membership, generation });

/**
 * OPS-05's reads: the owner's membership, every setup revision and the
 * business's account history. SELECT only, on tables
 * scripts/runtime-permissions.sql lets cp_runtime read; parameterized; every
 * row parsed through its record schema.
 */
export class PostgresOrganizationExportTransaction implements OrganizationExportTransaction {
  constructor(private readonly client: SqlClient) {}

  async member(organizationId: string, personId: string): Promise<MembershipRow | undefined> {
    const result = await this.client.query('SELECT record,generation FROM control_plane.memberships WHERE organization_id=$1 AND person_id=$2', [organizationId, personId]);
    return result.rows.map((row) => memberRow.parse(row)).find((row) => row.record.organizationId === organizationId && row.record.personId === personId);
  }
  async setupRevisions(organizationId: string): Promise<OrganizationSetupRow[]> {
    const result = await this.client.query(
      `SELECT ${SETUP_COLUMNS} FROM control_plane.organization_setups WHERE organization_id=$1 ORDER BY revision`, [organizationId]);
    return result.rows.map(setupRow);
  }
  async history(organizationId: string, limit: number): Promise<AccountEvent[]> {
    const result = await this.client.query(
      // Byte order ("C"), whatever the database's collation, so ties at one instant fall as the faux store sorts them.
      `SELECT record FROM control_plane.account_events WHERE organization_id=$1 ORDER BY record->>'at' COLLATE "C" DESC, id COLLATE "C" DESC LIMIT $2`,
      [organizationId, limit]);
    return result.rows
      .map((row) => recordSchemas.event.parse(typeof row.record === 'string' ? JSON.parse(row.record) : row.record))
      .filter((event) => event.organizationId === organizationId)
      .reverse();
  }
}

export class PostgresOrganizationExportRepository implements OrganizationExportRepository {
  constructor(private readonly factory: ClientFactory) {}
  transaction<T>(action: (tx: OrganizationExportTransaction) => Promise<T>) {
    return inTransaction(this.factory, (client) => action(new PostgresOrganizationExportTransaction(client)));
  }
}
