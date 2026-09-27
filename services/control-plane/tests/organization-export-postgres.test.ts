/**
 * OPS-05's SQL adapter against a recording client, and against the Worker
 * login's grant file. Protocol only: this does not run PostgreSQL. It checks
 * the statement each transaction method sends, that every value is a bound
 * parameter, that rows read back exactly as the faux store holds them, and
 * that an export needs nothing but SELECT on tables
 * scripts/runtime-permissions.sql already lets cp_runtime read.
 */
import { describe, expect, it } from 'vitest';
import type { OrganizationSetupRow } from '../src/organization-setup/service.js';
import { createFauxCloud } from '../src/faux/cloud.js';
import { seedDemo } from '../src/faux/seed.js';
import { PostgresOrganizationExportRepository, PostgresOrganizationExportTransaction } from '../src/organization-export/postgres.js';
import type { OrganizationExportTransaction } from '../src/organization-export/service.js';
import { describePrivileges, needs, read, recording, runtimeGrants } from './support/runtime-grants.js';

/** Every transaction method once, in a fixed order. */
async function everyMethod(tx: OrganizationExportTransaction) {
  await tx.member('org_1', 'person_1');
  await tx.setupRevisions('org_1');
  await tx.history('org_1', 20_001);
}

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function seeded() {
  const cloud = await createFauxCloud({ file: null, now: () => Date.parse('2026-09-26T12:00:00.000Z'), passwordIterations: 1_000 });
  const { organizations } = await seedDemo(cloud);
  const organizationId = organizations!.juniper;
  const state = cloud.store.snapshot();
  const organization = state.accounts.organizations.find((row) => row.record.id === organizationId)!.record;
  const owner = organization.createdBy;
  const revision = (number: number, writtenAt: string): OrganizationSetupRow => ({
    tenantId: organization.tenantId,
    organizationId,
    revision: number,
    record: {
      v: 1,
      setup: {
        v: 1, organizationId, tenantId: organization.tenantId, schemaRevision: 1, state: 'drafting',
        answers: {
          name: { questionId: 'name', value: 'Juniper Street Bakery', unknown: false, origin: 'person', at: writtenAt, by: owner, prompt: 'What should we call your business?' },
        },
        cursor: 'industry', startedAt: '2026-09-26T11:59:00.000Z', startedBy: owner, updatedAt: writtenAt, proposalDigest: null,
      },
    },
    writtenAt,
    writtenBy: owner,
  });
  await cloud.store.organizationSetups.transaction(async (tx) => {
    await tx.insert(revision(1, '2026-09-26T12:01:00.000Z'));
    await tx.insert(revision(2, '2026-09-26T12:02:00.000Z'));
  });
  return { cloud, organizationId, owner };
}

describe('organization export SQL adapter protocol', () => {
  it('sends three parameterized SELECTs and nothing else', async () => {
    const db = recording();
    await everyMethod(new PostgresOrganizationExportTransaction(db.client));
    expect(db.calls.map((call) => call.sql)).toEqual([
      'SELECT record,generation FROM control_plane.memberships WHERE organization_id=$1 AND person_id=$2',
      expect.stringMatching(/^SELECT .+ FROM control_plane\.organization_setups WHERE organization_id=\$1 ORDER BY revision$/),
      `SELECT record FROM control_plane.account_events WHERE organization_id=$1 ORDER BY record->>'at' COLLATE "C" DESC, id COLLATE "C" DESC LIMIT $2`,
    ]);
    expect(db.calls.map((call) => call.values)).toEqual([['org_1', 'person_1'], ['org_1'], ['org_1', 20_001]]);
    // No id or number is ever spliced into the SQL text.
    for (const { sql } of db.calls)
      for (const value of ['org_1', 'person_1', '20001'])
        expect(sql).not.toContain(value);
  });

  it('reads the membership, every revision and the history back exactly as the faux store holds them', async () => {
    const { cloud, organizationId, owner } = await seeded();
    const state = cloud.store.snapshot();
    const stray = { ...state.accounts.events[0], id: 'account_event_elsewhere', organizationId: 'organization_elsewhere' };
    for (const [time, record] of [
      [(iso: string) => new Date(iso), (json: unknown) => json],
      [(iso: string) => iso.replace('.000Z', '+00:00'), (json: unknown) => JSON.stringify(json)],
    ] as const) {
      const db = recording((sql, values) => {
        if (sql.includes('FROM control_plane.memberships'))
          return state.accounts.memberships.filter((item) => item.record.organizationId === values[0] && item.record.personId === values[1])
            .map((item) => ({ record: item.record, generation: item.generation }));
        if (sql.includes('FROM control_plane.organization_setups'))
          return state.organizationSetups.filter((row) => row.organizationId === values[0]).sort((a, b) => a.revision - b.revision)
            .map((row) => ({ tenant_id: row.tenantId, organization_id: row.organizationId, revision: row.revision,
              record: record(row.record), written_at: time(row.writtenAt), written_by: row.writtenBy }));
        if (sql.includes('FROM control_plane.account_events'))
          // What PostgreSQL answers: this business's rows, newest first, then the limit. A row for
          // another business that came back anyway is dropped by the adapter.
          return [...state.accounts.events.filter((event) => event.organizationId === values[0])
            .sort((a, b) => byteOrder(b.at, a.at) || byteOrder(b.id, a.id)).slice(0, values[1] as number), stray]
            .map((event) => ({ record: record(event) }));
        return [];
      });
      const sql = new PostgresOrganizationExportTransaction(db.client);
      const faux = <T>(action: (tx: OrganizationExportTransaction) => Promise<T>) => cloud.store.organizationExports.transaction(action);
      expect(await sql.member(organizationId, owner)).toEqual(await faux((tx) => tx.member(organizationId, owner)));
      expect(await sql.member(organizationId, 'person_nobody')).toBeUndefined();
      const revisions = await sql.setupRevisions(organizationId);
      expect(revisions.map((row) => row.revision)).toEqual([1, 2]);
      expect(revisions).toEqual(await faux((tx) => tx.setupRevisions(organizationId)));
      for (const limit of [1_000, 2]) {
        const history = await sql.history(organizationId, limit);
        expect(history).toEqual(await faux((tx) => tx.history(organizationId, limit)));
        expect(history.some((event) => event.id === stray.id)).toBe(false);
      }
    }
  });

  it('refuses an unreadable event instead of exporting it', async () => {
    const db = recording(() => [{ record: { id: 'account_event_1', at: 'not a time' } }]);
    await expect(new PostgresOrganizationExportTransaction(db.client).history('org_1', 10)).rejects.toThrow();
  });

  it('runs an export in one transaction and rolls back when it fails', async () => {
    const committed = recording();
    await new PostgresOrganizationExportRepository(committed.factory).transaction(everyMethod);
    expect(committed.calls[0].sql).toBe('BEGIN');
    expect(committed.calls.at(-1)!.sql).toBe('COMMIT');
    const failed = recording();
    await expect(new PostgresOrganizationExportRepository(failed.factory).transaction(async (tx) => {
      await tx.member('org_1', 'person_1');
      throw new Error('refused');
    })).rejects.toThrow('refused');
    expect(failed.calls.map((call) => call.sql)).toContain('ROLLBACK');
    expect(failed.calls.map((call) => call.sql)).not.toContain('COMMIT');
  });
});

describe('the Worker login and the export', () => {
  it('needs only SELECT, on three tables cp_runtime may already read', async () => {
    const db = recording();
    await new PostgresOrganizationExportRepository(db.factory).transaction(everyMethod);
    const used = needs(db.calls.map((call) => call.sql));
    const granted = runtimeGrants(read('../scripts/runtime-permissions.sql'));
    expect([...used.keys()].sort()).toEqual(['account_events', 'memberships', 'organization_setups']);
    for (const table of used.keys()) {
      expect(describePrivileges(used.get(table))).toEqual({ select: true, insert: false, update: [] });
      expect(granted.get(table)?.select, table).toBe(true);
    }
  });

  it('never writes', () => {
    expect(read('../src/organization-export/postgres.ts')).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|GRANT)\b/);
  });
});
