import { Client } from '@neondatabase/serverless';
import { z } from 'zod';
import { AccountError } from './errors.js';
import { ACCOUNT_WORKSPACE_LIMIT, ORGANIZATION_MEMBER_LIMIT, CLOUD_WORKSPACE_PAGE_SIZE, CODE_INVITATION_PAGE, recordSchemas, type AccountRepository, type AccountTransaction, type VerifiedIdentity,
  type AccountState, type SubjectMapping, type SessionRecord, type OrganizationRow,
  type MembershipRow, type InvitationRecord, type CodeInvitationRecord, type AccountEvent } from './domain.js';

export interface SqlClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
  on?(event: 'error', listener: (error: unknown) => void): unknown;
}
export type ClientFactory = () => SqlClient;

/** Neon Client uses WebSockets, not one-shot HTTP. Each transaction owns it. */
export function neonClientFactory(connectionString: string): ClientFactory {
  return () => new Client({ connectionString, connectionTimeoutMillis: 5000,
    query_timeout: 6000, application_name: 'diomedes-control-plane' });
}

export class TransactionCleanupError extends Error {
  constructor(readonly failures: unknown[]) { super('Transaction cleanup failed; outcome may be uncertain.'); }
}

export async function inTransaction<T>(factory: ClientFactory, action: (client: SqlClient) => Promise<T>): Promise<T> {
  const client = factory();
  let began = false;
  let result: T | undefined;
  const failures: unknown[] = [];
  let closed = false;
  let eventFailed = false;
  let eventFailure: unknown;
  // Neon can emit a second socket error after its close event and end promise.
  // Keep ownership for this client's full lifetime. Only a confirmed, explicitly
  // closed client can ignore late notifications; active/closing errors fail.
  client.on?.('error', error => {
    if (!closed && !eventFailed) { eventFailed = true; eventFailure = error; }
  });
  const checkEvent = () => { if (eventFailed) throw eventFailure; };
  const recordFailure = (error: unknown) => { if (!failures.includes(error)) failures.push(error); };
  try {
    await client.connect();
    checkEvent();
    await client.query('BEGIN'); began = true;
    checkEvent();
    await client.query("SET LOCAL statement_timeout = '5s'");
    checkEvent();
    await client.query("SET LOCAL lock_timeout = '3s'");
    checkEvent();
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6s'");
    checkEvent();
    result = await action(client);
    checkEvent();
    await client.query('COMMIT'); began = false;
    checkEvent();
  } catch (error) {
    recordFailure(error);
    if (began) {
      try { await client.query('ROLLBACK'); } catch (rollback) { recordFailure(rollback); }
    }
  } finally {
    try { await client.end(); closed = true; } catch (close) { recordFailure(close); }
  }
  if (eventFailed) recordFailure(eventFailure);
  // Never replay an operation after a transport or COMMIT failure.
  if (failures.length > 1) throw new TransactionCleanupError(failures);
  if (failures.length === 1) throw failures[0];
  return result as T;
}

const generation = z.number().int().nonnegative().max(2_147_483_647);
const orgRow = z.object({ record: recordSchemas.organization, generation });
const memberRow = z.object({ record: recordSchemas.membership, generation });

class PostgresTransaction implements AccountTransaction {
  constructor(private readonly client: SqlClient) {}
  private async record<T>(query: string, params: unknown[], schema: z.ZodType<T>): Promise<T | undefined> {
    const result = await this.client.query(query, params);
    if (result.rows.length === 0) return undefined;
    return schema.parse(result.rows[0].record);
  }
  async lockIdentity(proof: VerifiedIdentity) {
    // Same subject serializes mapping creation; same provider session cannot
    // be concurrently attached to two subjects. Hash collisions only serialize.
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['subject', proof.issuer, proof.subject])]);
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['session', proof.issuer, proof.sessionId])]);
  }
  subject(issuer: string, subject: string) {
    return this.record('SELECT record FROM control_plane.external_subjects WHERE issuer=$1 AND subject=$2', [issuer, subject], recordSchemas.subject);
  }
  person(id: string) { return this.record('SELECT record FROM control_plane.persons WHERE id=$1', [id], recordSchemas.person); }
  session(issuer: string, sessionId: string) {
    return this.record('SELECT record FROM control_plane.sessions WHERE issuer=$1 AND session_id=$2', [issuer, sessionId], recordSchemas.session);
  }
  async savePerson(person: AccountState['persons'][number], mapping: SubjectMapping) {
    await this.client.query('INSERT INTO control_plane.persons(id,record) VALUES ($1,$2::jsonb)', [person.id, JSON.stringify(person)]);
    await this.client.query('INSERT INTO control_plane.external_subjects(issuer,subject,person_id,record) VALUES ($1,$2,$3,$4::jsonb)',
      [mapping.issuer, mapping.subject, mapping.personId, JSON.stringify(mapping)]);
  }
  async saveSession(record: SessionRecord) {
    await this.client.query('INSERT INTO control_plane.sessions(issuer,session_id,subject,person_id,principal_id,record) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (issuer,session_id) DO UPDATE SET record=EXCLUDED.record',
      [record.issuer, record.sessionId, record.subject, record.personId, record.principalId, JSON.stringify(record)]);
  }
  async organization(id: string, lock = false) {
    const result = await this.client.query(lock
      ? 'SELECT record,generation FROM control_plane.organizations WHERE id=$1 FOR UPDATE'
      : 'SELECT record,generation FROM control_plane.organizations WHERE id=$1', [id]);
    return result.rows.length ? orgRow.parse(result.rows[0]) : undefined;
  }
  async members(organizationId: string) {
    const result = await this.client.query(`SELECT record,generation FROM control_plane.memberships WHERE organization_id=$1 AND record->>'state'='active' ORDER BY person_id LIMIT ${ORGANIZATION_MEMBER_LIMIT + 1}`, [organizationId]);
    return result.rows.map((row) => memberRow.parse(row));
  }
  async memberships(personId: string, after?: string) {
    const result = await this.client.query(`SELECT record,generation FROM control_plane.memberships WHERE person_id=$1 AND record->>'state'='active' AND ($2::text IS NULL OR organization_id>$2) ORDER BY organization_id LIMIT ${ACCOUNT_WORKSPACE_LIMIT + 1}`, [personId, after ?? null]);
    return result.rows.map((row) => memberRow.parse(row));
  }
  async member(organizationId: string, personId: string) {
    const result = await this.client.query('SELECT record,generation FROM control_plane.memberships WHERE organization_id=$1 AND person_id=$2', [organizationId, personId]);
    return result.rows.map(row => memberRow.parse(row)).find(row => row.record.organizationId === organizationId && row.record.personId === personId);
  }
  async workspaceRows(personId: string, after?: string) {
    const result = await this.client.query(`SELECT m.record AS member_record,m.generation AS member_generation,o.record AS organization_record,o.generation AS organization_generation FROM control_plane.memberships m LEFT JOIN control_plane.organizations o ON o.id=m.organization_id WHERE m.person_id=$1 AND m.record->>'state'='active' AND ($2::text IS NULL OR m.organization_id>$2) ORDER BY m.organization_id LIMIT ${CLOUD_WORKSPACE_PAGE_SIZE + 1}`, [personId, after ?? null]);
    return result.rows.map(row => ({
      membership: memberRow.parse({ record: row.member_record, generation: row.member_generation }),
      organization: orgRow.parse({ record: row.organization_record, generation: row.organization_generation }),
    }));
  }
  async hasOtherActiveOwner(organizationId: string, personId: string) {
    const result = await this.client.query("SELECT record,generation FROM control_plane.memberships WHERE organization_id=$1 AND person_id<>$2 AND record->>'state'='active' AND record->>'role'='owner' LIMIT 1", [organizationId, personId]);
    return result.rows.some(row => { const { record } = memberRow.parse(row); return record.organizationId === organizationId && record.personId !== personId && record.state === 'active' && record.role === 'owner'; });
  }
  async saveOrganization(row: OrganizationRow) {
    await this.client.query('INSERT INTO control_plane.organizations(id,tenant_id,created_by,record,generation) VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (id) DO UPDATE SET record=EXCLUDED.record,generation=EXCLUDED.generation',
      [row.record.id, row.record.tenantId, row.record.createdBy, JSON.stringify(row.record), row.generation]);
  }
  async saveMembership(row: MembershipRow) {
    await this.client.query('INSERT INTO control_plane.memberships(organization_id,person_id,record,generation) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (organization_id,person_id) DO UPDATE SET record=EXCLUDED.record,generation=EXCLUDED.generation',
      [row.record.organizationId, row.record.personId, JSON.stringify(row.record), row.generation]);
  }
  invitation(hash: string) { return this.record('SELECT record FROM control_plane.invitations WHERE token_hash=$1', [hash], recordSchemas.invitation); }
  async saveInvitation(record: InvitationRecord) {
    await this.client.query('INSERT INTO control_plane.invitations(token_hash,organization_id,invited_by,record) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (token_hash) DO UPDATE SET record=EXCLUDED.record',
      [record.tokenHash, record.organizationId, record.invitedBy, JSON.stringify(record)]);
  }
  codeInvitation(hash: string) {
    return this.record('SELECT record FROM control_plane.invitation_codes WHERE code_hash=$1', [hash], recordSchemas.codeInvitation);
  }
  async saveCodeInvitation(record: CodeInvitationRecord) {
    await this.client.query('INSERT INTO control_plane.invitation_codes(code_hash,organization_id,invited_by,record) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (code_hash) DO UPDATE SET record=EXCLUDED.record',
      [record.codeHash, record.organizationId, record.invitedBy, JSON.stringify(record)]);
  }
  async openCodeInvitations(organizationId: string, at: string) {
    const result = await this.client.query(`SELECT record FROM control_plane.invitation_codes WHERE organization_id=$1 AND record->>'redeemedAt' IS NULL AND record->>'revokedAt' IS NULL AND (record->>'expiresAt')::timestamptz > $2::timestamptz ORDER BY record->>'createdAt' DESC LIMIT ${CODE_INVITATION_PAGE}`, [organizationId, at]);
    return result.rows.map((row) => recordSchemas.codeInvitation.parse(row.record));
  }
  async roster(organizationId: string) {
    const result = await this.client.query(`SELECT m.record AS member_record,m.generation AS member_generation,p.record AS person_record FROM control_plane.memberships m JOIN control_plane.persons p ON p.id=m.person_id WHERE m.organization_id=$1 ORDER BY m.person_id LIMIT ${ORGANIZATION_MEMBER_LIMIT * 2}`, [organizationId]);
    return result.rows.map((row) => ({
      membership: memberRow.parse({ record: row.member_record, generation: row.member_generation }),
      person: recordSchemas.person.parse(row.person_record),
    }));
  }
  async event(record: AccountEvent) {
    await this.client.query('INSERT INTO control_plane.account_events(id,organization_id,actor_person_id,record) VALUES ($1,$2,$3,$4::jsonb)',
      [record.id, record.organizationId, record.actorPersonId, JSON.stringify(record)]);
  }
}

export const verifiedWebhookSchema = z.strictObject({ provider: z.literal('stripe'), eventId: z.string().regex(/^evt_[A-Za-z0-9_]{1,128}$/),
  customerId: z.string().regex(/^cus_[A-Za-z0-9_]{1,128}$/), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  eventType: z.string().min(1).max(200), payload: z.record(z.string(), z.unknown()) });
export type VerifiedWebhook = z.infer<typeof verifiedWebhookSchema>;

export class PostgresRepository implements AccountRepository {
  constructor(private readonly factory: ClientFactory) {}
  transaction<T>(action: (tx: AccountTransaction) => Promise<T>) {
    return inTransaction(this.factory, (client) => action(new PostgresTransaction(client)));
  }
  /** Internal B04 seam only. The future receiver MUST verify raw-body signatures first.
   * There is deliberately no webhook HTTP route or payment provider call in B01. */
  async recordVerifiedWebhook(input: VerifiedWebhook) {
    const event = verifiedWebhookSchema.parse(input);
    const payload = JSON.stringify(event.payload);
    if (new TextEncoder().encode(payload).length > 262_144) throw new AccountError(413, 'Webhook payload exceeds the storage limit.');
    return inTransaction(this.factory, async (client) => {
      const customer = (await client.query('SELECT organization_id,tenant_id FROM control_plane.billing_customers WHERE provider=$1 AND customer_id=$2 FOR KEY SHARE', [event.provider, event.customerId])).rows[0];
      if (!customer) throw new AccountError(409, 'The billing customer is not mapped to a tenant.');
      const row = z.object({ organization_id: z.string(), tenant_id: z.string() }).parse(customer);
      const added = await client.query('INSERT INTO control_plane.webhook_inbox(provider,event_id,customer_id,organization_id,tenant_id,payload_hash,event_type,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (provider,event_id) DO NOTHING RETURNING event_id',
        [event.provider, event.eventId, event.customerId, row.organization_id, row.tenant_id, event.payloadHash, event.eventType, payload]);
      if (added.rowCount !== 1) {
        const old = (await client.query('SELECT customer_id,tenant_id,payload_hash FROM control_plane.webhook_inbox WHERE provider=$1 AND event_id=$2', [event.provider, event.eventId])).rows[0];
        if (!old || old.customer_id !== event.customerId || old.tenant_id !== row.tenant_id || old.payload_hash !== event.payloadHash)
          throw new AccountError(409, 'The duplicate event has conflicting provenance.');
      }
      return { inserted: added.rowCount === 1, tenantId: row.tenant_id };
    });
  }
}
