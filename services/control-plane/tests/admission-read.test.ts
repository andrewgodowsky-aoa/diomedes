import { describe, expect, it } from 'vitest';
import { PostgresCommercialRepository } from '../src/commercial-postgres.js';
import type { AdmissionRecord } from '../src/commercial.js';
import { FauxCloudStore } from '../src/faux/store.js';
import type { SqlClient } from '../src/postgres.js';

const record: AdmissionRecord = {
  id: 'agent_admission_1', at: '2026-09-25T12:00:00.000Z', organizationId: 'org_1', tenantId: 'tenant_1', personId: 'person_1',
  surface: 'conversation', routeKind: 'managed', decision: 'admitted', code: null, planId: 'business',
  accessRevision: 1, policyRevision: 1, rootJobId: null,
};

describe('reading one admission record by id', () => {
  it('finds it within its tenant and reads another tenant’s id as absent (faux store)', async () => {
    const store = await FauxCloudStore.open(null, '2026-09-25T12:00:00.000Z');
    // The admission is saved through the same seam the service uses.
    await store.run(async (draft) => { draft.commercial.admissions.push(record); });
    expect(await store.commercial.transaction((tx) => tx.admission('tenant_1', 'agent_admission_1'))).toEqual(record);
    expect(await store.commercial.transaction((tx) => tx.admission('tenant_2', 'agent_admission_1'))).toBeUndefined();
    expect(await store.commercial.transaction((tx) => tx.admission('tenant_1', 'agent_admission_2'))).toBeUndefined();
  });

  it('reads by the table’s primary key with parameters, and parses the row (Postgres adapter)', async () => {
    const queries: { text: string; values?: unknown[] }[] = [];
    const client: SqlClient = {
      async connect() {},
      async query(text, values) {
        queries.push({ text, values });
        if (text.includes('agent_admissions')) return { rows: values?.[1] === record.id ? [{ record }] : [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      async end() {},
    };
    const repository = new PostgresCommercialRepository(() => client);
    expect(await repository.transaction((tx) => tx.admission('tenant_1', record.id))).toEqual(record);
    expect(await repository.transaction((tx) => tx.admission('tenant_1', 'agent_admission_x'))).toBeUndefined();
    const read = queries.find((query) => query.text.includes('agent_admissions'))!;
    expect(read.text).toBe('SELECT record FROM control_plane.agent_admissions WHERE tenant_id=$1 AND id=$2');
    expect(read.values).toEqual(['tenant_1', record.id]);
  });
});
