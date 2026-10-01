import { auditEventSchema } from './commercial.js';
import { PostgresCommercialTransaction } from './commercial-postgres.js';
import { PostgresFundingTransaction } from './funding-postgres.js';
import { inTransaction, type ClientFactory, type SqlClient } from './postgres.js';
import type { StaffFundingRepository, StaffFundingTransaction } from './staff-funding.js';

class PostgresStaffFundingTransaction extends PostgresCommercialTransaction implements StaffFundingTransaction {
  readonly funding: PostgresFundingTransaction;
  constructor(private readonly staffClient: SqlClient) {
    super(staffClient);
    this.funding = new PostgresFundingTransaction(staffClient);
  }
  async auditById(id: string) {
    const result = await this.staffClient.query('SELECT record FROM control_plane.ops_audit WHERE id=$1', [id]);
    return result.rows.length ? auditEventSchema.parse(result.rows[0].record) : undefined;
  }
}

/** STAFF_FUNDING_DATABASE_URL only; no fallback to the Worker or gateway login. */
export class PostgresStaffFundingRepository implements StaffFundingRepository {
  constructor(private readonly factory: ClientFactory) {}
  transaction<T>(action: (tx: StaffFundingTransaction) => Promise<T>): Promise<T> {
    return inTransaction(this.factory, client => action(new PostgresStaffFundingTransaction(client)));
  }
}
