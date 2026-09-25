import { z } from 'zod';
import type { Membership, Organization, Person } from '../../../shared/workspaces.js';
import {
  admissionRecordSchema,
  auditEventSchema,
  featureGrantSchema,
  operatorSchema,
  routeEntrySchema,
  tierPolicySchema,
  type AdmissionRecord,
  type AuditEvent,
  type CommercialRepository,
  type CommercialTransaction,
  type FeatureGrant,
  type Operator,
  type RouteEntry,
  type TierPolicy,
} from './commercial.js';
import { recordSchemas } from './domain.js';
import { inTransaction, type ClientFactory, type SqlClient } from './postgres.js';

const like = (query: string) => `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/**
 * Migration 005's tables. Same discipline as the account adapter: one
 * request-owned client per transaction, parameterized SQL, rows parsed through
 * the record schemas, and no provider call inside a transaction.
 */
class PostgresCommercialTransaction implements CommercialTransaction {
  constructor(private readonly client: SqlClient) {}

  async lockOrganization(organizationId: string) {
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['commercial', organizationId])]);
  }
  async grants(organizationId: string): Promise<FeatureGrant[]> {
    const result = await this.client.query('SELECT record FROM control_plane.feature_grants WHERE organization_id=$1 ORDER BY record->>\'issuedAt\' LIMIT 500', [organizationId]);
    return result.rows.map((row) => featureGrantSchema.parse(row.record));
  }
  async saveGrant(row: FeatureGrant) {
    await this.client.query('INSERT INTO control_plane.feature_grants(tenant_id,grant_id,organization_id,record) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (tenant_id,grant_id) DO UPDATE SET record=EXCLUDED.record',
      [row.tenantId, row.id, row.organizationId, JSON.stringify(row)]);
  }
  async accessRevision(organizationId: string) {
    const result = await this.client.query('SELECT revision FROM control_plane.organization_access WHERE organization_id=$1', [organizationId]);
    return result.rows.length ? Number(result.rows[0].revision) : 0;
  }
  async bumpAccessRevision(organizationId: string, tenantId: string) {
    const result = await this.client.query('INSERT INTO control_plane.organization_access(organization_id,tenant_id,revision) VALUES ($1,$2,1) ON CONFLICT (organization_id) DO UPDATE SET revision=control_plane.organization_access.revision+1 RETURNING revision',
      [organizationId, tenantId]);
    return Number(result.rows[0].revision);
  }
  async routes(): Promise<RouteEntry[]> {
    const result = await this.client.query('SELECT record FROM control_plane.route_entries ORDER BY id LIMIT 500');
    return result.rows.map((row) => routeEntrySchema.parse(row.record));
  }
  async saveRoute(row: RouteEntry) {
    await this.client.query('INSERT INTO control_plane.route_entries(id,record) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET record=EXCLUDED.record', [row.id, JSON.stringify(row)]);
  }
  async lockPolicy() {
    await this.client.query('SELECT pg_advisory_xact_lock(474946082902)');
  }
  async policy(revision?: number): Promise<TierPolicy | undefined> {
    const result = revision === undefined
      ? await this.client.query('SELECT record FROM control_plane.tier_policies ORDER BY revision DESC LIMIT 1')
      : await this.client.query('SELECT record FROM control_plane.tier_policies WHERE revision=$1', [revision]);
    return result.rows.length ? tierPolicySchema.parse(result.rows[0].record) : undefined;
  }
  async policies(limit: number) {
    const result = await this.client.query('SELECT record FROM control_plane.tier_policies ORDER BY revision DESC LIMIT $1', [limit]);
    return result.rows.map((row) => tierPolicySchema.parse(row.record));
  }
  async savePolicy(row: TierPolicy) {
    await this.client.query('INSERT INTO control_plane.tier_policies(revision,record) VALUES ($1,$2::jsonb)', [row.revision, JSON.stringify(row)]);
  }
  async operator(personId: string): Promise<Operator | undefined> {
    const result = await this.client.query('SELECT record FROM control_plane.operators WHERE person_id=$1', [personId]);
    return result.rows.length ? operatorSchema.parse(result.rows[0].record) : undefined;
  }
  async operators() {
    const result = await this.client.query('SELECT record FROM control_plane.operators ORDER BY person_id LIMIT 1000');
    return result.rows.map((row) => operatorSchema.parse(row.record));
  }
  async saveOperator(row: Operator) {
    await this.client.query('INSERT INTO control_plane.operators(person_id,record) VALUES ($1,$2::jsonb) ON CONFLICT (person_id) DO UPDATE SET record=EXCLUDED.record', [row.personId, JSON.stringify(row)]);
  }
  async audit(row: AuditEvent) {
    await this.client.query('INSERT INTO control_plane.ops_audit(id,at,actor_person_id,organization_id,record) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [row.id, row.at, row.actorPersonId, row.organizationId, JSON.stringify(row)]);
  }
  async auditLog(input: { organizationId?: string; limit: number }) {
    const result = input.organizationId
      ? await this.client.query('SELECT record FROM control_plane.ops_audit WHERE organization_id=$1 ORDER BY at DESC LIMIT $2', [input.organizationId, input.limit])
      : await this.client.query('SELECT record FROM control_plane.ops_audit ORDER BY at DESC LIMIT $1', [input.limit]);
    return result.rows.map((row) => auditEventSchema.parse(row.record));
  }
  async saveAdmission(row: AdmissionRecord) {
    await this.client.query('INSERT INTO control_plane.agent_admissions(tenant_id,id,organization_id,person_id,at,record) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
      [row.tenantId, row.id, row.organizationId, row.personId, row.at, JSON.stringify(row)]);
  }
  async admissions(organizationId: string, limit: number) {
    const result = await this.client.query('SELECT record FROM control_plane.agent_admissions WHERE organization_id=$1 ORDER BY at DESC LIMIT $2', [organizationId, limit]);
    return result.rows.map((row) => admissionRecordSchema.parse(row.record));
  }
  async organizations(query: string, limit: number) {
    const result = await this.client.query(
      `SELECT o.record, (SELECT count(*) FROM control_plane.memberships m WHERE m.organization_id=o.id AND m.record->>'state'='active') AS active
       FROM control_plane.organizations o WHERE $1='' OR lower(o.record->>'name') LIKE $2 OR o.id=$1 ORDER BY lower(o.record->>'name') LIMIT $3`,
      [query, like(query), limit]);
    return result.rows.map((row) => ({ organization: recordSchemas.organization.parse(row.record) as Organization, activeMembers: Number(row.active) }));
  }
  async organizationRecord(id: string) {
    const result = await this.client.query('SELECT record FROM control_plane.organizations WHERE id=$1', [id]);
    return result.rows.length ? (recordSchemas.organization.parse(result.rows[0].record) as Organization) : undefined;
  }
  async roster(organizationId: string) {
    const result = await this.client.query(
      `SELECT m.record AS membership, p.record AS person, s.issuer, s.subject FROM control_plane.memberships m
       JOIN control_plane.persons p ON p.id=m.person_id JOIN control_plane.external_subjects s ON s.person_id=m.person_id
       WHERE m.organization_id=$1 ORDER BY m.person_id LIMIT 2000`, [organizationId]);
    return result.rows.map((row) => ({
      membership: recordSchemas.membership.parse(row.membership) as Membership,
      person: recordSchemas.person.parse(row.person) as Person,
      issuer: z.string().parse(row.issuer),
      subject: z.string().parse(row.subject),
    }));
  }
  async people(query: string, limit: number) {
    const result = await this.client.query(
      `SELECT p.record AS person, s.issuer, s.subject,
         COALESCE((SELECT jsonb_agg(m.record) FROM control_plane.memberships m WHERE m.person_id=p.id), '[]'::jsonb) AS memberships
       FROM control_plane.persons p JOIN control_plane.external_subjects s ON s.person_id=p.id
       WHERE $1='' OR lower(p.record->>'name') LIKE $2 OR p.id=$1 ORDER BY lower(p.record->>'name') LIMIT $3`,
      [query, like(query), limit]);
    return result.rows.map((row) => ({
      person: recordSchemas.person.parse(row.person) as Person,
      issuer: z.string().parse(row.issuer),
      subject: z.string().parse(row.subject),
      memberships: z.array(recordSchemas.membership).parse(row.memberships) as Membership[],
    }));
  }
  async person(personId: string) {
    const result = await this.client.query('SELECT p.record AS person, s.issuer, s.subject FROM control_plane.persons p JOIN control_plane.external_subjects s ON s.person_id=p.id WHERE p.id=$1', [personId]);
    if (!result.rows.length) return undefined;
    const row = result.rows[0];
    return { person: recordSchemas.person.parse(row.person) as Person, issuer: z.string().parse(row.issuer), subject: z.string().parse(row.subject) };
  }
}

export class PostgresCommercialRepository implements CommercialRepository {
  constructor(private readonly factory: ClientFactory) {}
  transaction<T>(action: (tx: CommercialTransaction) => Promise<T>) {
    return inTransaction(this.factory, (client) => action(new PostgresCommercialTransaction(client)));
  }
}
