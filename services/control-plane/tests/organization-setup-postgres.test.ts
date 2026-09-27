/**
 * The business setup's SQL adapter (migration 008) against a recording client,
 * and against the Worker login's grant file. Protocol only: this does not run
 * PostgreSQL. It checks the statement each transaction method sends, that every
 * value is a bound parameter, that rows read back exactly as the faux store
 * holds them, and that the statements need exactly the organization_setups
 * privileges scripts/runtime-permissions.sql grants cp_runtime, both ways.
 */
import { describe, expect, it } from 'vitest';
import { createFauxCloud } from '../src/faux/cloud.js';
import { seedDemo } from '../src/faux/seed.js';
import { PostgresOrganizationSetupRepository, PostgresOrganizationSetupTransaction } from '../src/organization-setup/postgres.js';
import type { OrganizationSetupRow, OrganizationSetupTransaction } from '../src/organization-setup/service.js';
import { describePrivileges, needs, read, recording, runtimeGrants } from './support/runtime-grants.js';

const row: OrganizationSetupRow = {
  tenantId: 'tenant_1',
  organizationId: 'org_1',
  revision: 3,
  record: {
    v: 1,
    setup: {
      v: 1, organizationId: 'org_1', tenantId: 'tenant_1', schemaRevision: 1, state: 'drafting',
      answers: {
        name: { questionId: 'name', value: 'Juniper Street Bakery', unknown: false, origin: 'person', at: '2026-09-26T12:00:00.000Z', by: 'person_1', prompt: 'What should we call your business?' },
      },
      cursor: 'industry', startedAt: '2026-09-26T11:59:00.000Z', startedBy: 'person_1', updatedAt: '2026-09-26T12:00:00.000Z', proposalDigest: null,
    },
  },
  writtenAt: '2026-09-26T12:00:01.000Z',
  writtenBy: 'person_1',
};
const setupRow = (value: OrganizationSetupRow, time: (iso: string) => unknown, record: (json: unknown) => unknown = (json) => json) => ({
  tenant_id: value.tenantId, organization_id: value.organizationId, revision: value.revision,
  record: record(value.record), written_at: time(value.writtenAt), written_by: value.writtenBy,
});

/** Every transaction method once, in a fixed order. */
async function everyMethod(tx: OrganizationSetupTransaction) {
  await tx.lockOrganization('org_1');
  await tx.latest('org_1');
  await tx.insert(row);
  await tx.member('org_1', 'person_1');
}

describe('organization setup SQL adapter protocol', () => {
  it('binds every value, locks per business, and reads only the newest revision', async () => {
    const db = recording();
    await everyMethod(new PostgresOrganizationSetupTransaction(db.client));
    expect(db.calls[0]).toEqual({
      sql: 'SELECT id FROM control_plane.organizations WHERE id=$1 FOR UPDATE', values: ['org_1'],
    });
    expect(db.calls[1].sql).toMatch(/FROM control_plane\.organization_setups WHERE organization_id=\$1 ORDER BY revision DESC LIMIT 1$/);
    expect(db.calls[2].sql).toBe('INSERT INTO control_plane.organization_setups(tenant_id,organization_id,revision,record,written_at,written_by) VALUES ($1,$2,$3,$4,$5,$6)');
    expect(db.calls[2].values).toEqual(['tenant_1', 'org_1', 3, JSON.stringify(row.record), '2026-09-26T12:00:01.000Z', 'person_1']);
    // No id, answer, name or time is ever spliced into the SQL text.
    for (const { sql } of db.calls)
      for (const value of ['org_1', 'tenant_1', 'person_1', 'Juniper', '2026-09-26'])
        expect(sql).not.toContain(value);
  });

  it('refuses a malformed row before it reaches the database', async () => {
    const db = recording();
    const tx = new PostgresOrganizationSetupTransaction(db.client);
    await expect(tx.insert({ ...row, revision: 0 })).rejects.toThrow();
    await expect(tx.insert({ ...row, record: { ...row.record, setup: { ...row.record.setup, cursor: 'NOT A QUESTION' } } })).rejects.toThrow();
    await expect(tx.insert({ ...row, writtenBy: '' })).rejects.toThrow();
    expect(db.calls).toEqual([]);
  });

  it('reads a revision back the same whether the driver answers with Dates, text or a JSON string', async () => {
    for (const [time, record] of [
      [(iso: string) => new Date(iso), (json: unknown) => json],
      [(iso: string) => iso.replace('.000Z', '+00:00'), (json: unknown) => JSON.stringify(json)],
    ] as const) {
      const db = recording((sql) => (sql.includes('FROM control_plane.organization_setups') ? [setupRow(row, time, record)] : []));
      expect(await new PostgresOrganizationSetupTransaction(db.client).latest('org_1')).toEqual(row);
    }
    expect(await new PostgresOrganizationSetupTransaction(recording().client).latest('org_1')).toBeUndefined();
    const unreadable = recording(() => [{ ...setupRow(row, (iso) => iso), written_at: 'not a time' }]);
    await expect(new PostgresOrganizationSetupTransaction(unreadable.client).latest('org_1')).rejects.toThrow('unreadable');
  });

  it('reads the membership row a write rechecks exactly as the faux store holds it', async () => {
    const cloud = await createFauxCloud({ file: null, now: () => Date.parse('2026-09-26T12:00:00.000Z'), passwordIterations: 1_000 });
    const { organizations } = await seedDemo(cloud);
    const state = cloud.store.snapshot();
    const organizationId = organizations!.juniper;
    const membership = state.accounts.memberships.find((item) => item.record.organizationId === organizationId && item.record.role === 'admin')!;
    const db = recording((sql, values) => sql.includes('FROM control_plane.memberships')
      ? state.accounts.memberships.filter((item) => item.record.organizationId === values[0] && item.record.personId === values[1])
        .map((item) => ({ record: item.record, generation: item.generation }))
      : []);
    const sql = new PostgresOrganizationSetupTransaction(db.client);
    expect(await sql.member(organizationId, membership.record.personId))
      .toEqual(await cloud.store.organizationSetups.transaction((tx) => tx.member(organizationId, membership.record.personId)));
    expect(await sql.member(organizationId, 'person_nobody')).toBeUndefined();
  });

  it('runs each use in one transaction and rolls back when it fails', async () => {
    const committed = recording();
    await new PostgresOrganizationSetupRepository(committed.factory).transaction((tx) => tx.latest('org_1'));
    expect(committed.calls[0].sql).toBe('BEGIN');
    expect(committed.calls.at(-1)!.sql).toBe('COMMIT');
    const failed = recording();
    await expect(new PostgresOrganizationSetupRepository(failed.factory).transaction(async (tx) => {
      await tx.lockOrganization('org_1');
      throw new Error('refused');
    })).rejects.toThrow('refused');
    expect(failed.calls.map((call) => call.sql)).toContain('ROLLBACK');
    expect(failed.calls.map((call) => call.sql)).not.toContain('COMMIT');
  });
});

describe('the Worker login and business setups', () => {
  it('needs exactly the organization_setups privileges cp_runtime is granted, and only reads memberships', async () => {
    const db = recording();
    await new PostgresOrganizationSetupRepository(db.factory).transaction(everyMethod);
    const used = needs(db.calls.map((call) => call.sql));
    const granted = runtimeGrants(read('../scripts/runtime-permissions.sql'));
    expect(describePrivileges(used.get('organization_setups'))).toEqual(describePrivileges(granted.get('organization_setups')));
    expect(describePrivileges(used.get('organization_setups'))).toEqual({ select: true, insert: true, update: [] });
    expect(describePrivileges(used.get('memberships'))).toEqual({ select: true, insert: false, update: [] });
    expect(granted.get('memberships')?.select).toBe(true);
    expect(describePrivileges(used.get('organizations'))).toEqual({ select: true, insert: false, update: ['*'] });
    expect(granted.get('organizations')?.select).toBe(true);
    expect(granted.get('organizations')?.update.has('*')).toBe(true);
    expect([...used.keys()].sort()).toEqual(['memberships', 'organization_setups', 'organizations']);
  });

  it('never updates or deletes a revision', () => {
    const adapter = read('../src/organization-setup/postgres.ts');
    expect(adapter.replaceAll('FOR UPDATE', '')).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP)\b/);
    expect(runtimeGrants(read('../scripts/runtime-permissions.sql')).get('organization_setups')!.update.size).toBe(0);
  });
});
