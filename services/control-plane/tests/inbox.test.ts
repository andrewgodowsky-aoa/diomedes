import { describe, expect, it } from 'vitest';
import { PostgresRepository, type SqlClient } from '../src/postgres.js';

/** Deliberate protocol fixture: real SQL uniqueness is a separately opt-in test. */
function inbox() {
  const rows = new Map<string, Record<string, unknown>>();
  const queries: { text: string; values: unknown[] }[] = [];
  const factory = (): SqlClient => ({
    async connect() {}, async end() {},
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.startsWith('SELECT organization_id')) return { rows: [{ organization_id: 'org_one', tenant_id: 'tenant_one' }], rowCount: 1 };
      if (text.startsWith('INSERT INTO control_plane.webhook_inbox')) {
        const key = JSON.stringify(values.slice(0,2));
        if (rows.has(key)) return { rows: [], rowCount: 0 };
        rows.set(key, { customer_id: values[2], tenant_id: values[4], payload_hash: values[5] });
        return { rows: [{ event_id: values[1] }], rowCount: 1 };
      }
      if (text.startsWith('SELECT customer_id')) return { rows: [rows.get(JSON.stringify(values))!], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  });
  return { repository: new PostgresRepository(factory), queries };
}
const event = { provider: 'stripe' as const, eventId: 'evt_offline', customerId: 'cus_offline', payloadHash: 'a'.repeat(64), eventType: 'fixture.event', payload: { fixture: true } };

describe('durable inbox repository protocol', () => {
  it('uses tenant from the customer mapping and treats identical event insertion as duplicate', async () => {
    const { repository, queries } = inbox();
    const results = await Promise.all([repository.recordVerifiedWebhook(event), repository.recordVerifiedWebhook(event)]);
    expect(results.filter((row) => row.inserted)).toHaveLength(1);
    expect(results.every((row) => row.tenantId === 'tenant_one')).toBe(true);
    const insert = queries.find((row) => row.text.startsWith('INSERT INTO control_plane.webhook_inbox'))!;
    expect(insert.text).not.toContain('evt_offline');
    expect(insert.values).toContain('evt_offline');
  });
  it('refuses conflicting duplicate payload or customer provenance', async () => {
    const { repository } = inbox();
    await repository.recordVerifiedWebhook(event);
    await expect(repository.recordVerifiedWebhook({ ...event, payloadHash: 'b'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    await expect(repository.recordVerifiedWebhook({ ...event, customerId: 'cus_other' })).rejects.toMatchObject({ status: 409 });
  });
});
