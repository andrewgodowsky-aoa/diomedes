/**
 * The payment ledger's SQL (PostgresRepository.storedCustomer and recordVerifiedPayment) against a recording client, and
 * against the Worker login's grant file. Protocol only: this does not run PostgreSQL. It checks what each call sends, that every
 * value is a bound parameter, the rules the statements enforce (one customer per business, an event stored once, nothing written
 * on a refusal), and that the statements need exactly the billing_customers and webhook_inbox privileges
 * scripts/runtime-permissions.sql grants cp_runtime, both ways. The funding login is checked in funding-permissions.test.ts: it
 * is granted neither table.
 */
import { describe, expect, it } from 'vitest';
import { PostgresRepository } from '../src/postgres.js';
import { describePrivileges, needs, read, recording, runtimeGrants } from './support/runtime-grants.js';

const payment = {
  eventId: 'evt_ledger_1', customerId: 'cus_ledger_1', organizationId: 'org_1', tenantId: 'tenant_1',
  payloadHash: 'a'.repeat(64), eventType: 'checkout.session.completed',
  payload: { id: 'evt_ledger_1', data: { object: { id: 'cs_ledger_1', customer: 'cus_ledger_1' } } },
};

/** billing_customers and webhook_inbox as rows, answering the statements the ledger sends. */
function database() {
  const customers: { customer_id: string; organization_id: string; tenant_id: string }[] = [];
  const events: { event_id: string; customer_id: string; organization_id: string; tenant_id: string; payload_hash: string }[] = [];
  const db = recording((sql, values) => {
    if (sql.startsWith('SELECT customer_id FROM control_plane.billing_customers'))
      return customers.filter((row) => row.tenant_id === values[1] && row.organization_id === values[2]).map((row) => ({ customer_id: row.customer_id }));
    if (sql.startsWith('SELECT customer_id,organization_id,tenant_id FROM control_plane.billing_customers'))
      return customers.filter((row) => row.customer_id === values[1] || (row.tenant_id === values[2] && row.organization_id === values[3]));
    if (sql.startsWith('INSERT INTO control_plane.billing_customers(')) {
      customers.push({ customer_id: String(values[1]), organization_id: String(values[2]), tenant_id: String(values[3]) });
      return [];
    }
    if (sql.startsWith('SELECT customer_id,organization_id,tenant_id,payload_hash FROM control_plane.webhook_inbox'))
      return events.filter((row) => row.event_id === values[1]);
    if (sql.startsWith('INSERT INTO control_plane.webhook_inbox(')) {
      events.push({ event_id: String(values[1]), customer_id: String(values[2]), organization_id: String(values[3]), tenant_id: String(values[4]), payload_hash: String(values[5]) });
      return [];
    }
    return [];
  });
  return { ...db, customers, events, repository: new PostgresRepository(db.factory) };
}
const statementsOf = (calls: { sql: string }[]) => calls.map((call) => call.sql).filter((sql) => !/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SELECT pg_advisory)/.test(sql))
  .map((sql) => /^(INSERT INTO|SELECT).*?control_plane\.(\w+)/.exec(sql)!.slice(1, 3).join(' '));

describe('the payment ledger on the Worker login', () => {
  it('stores the customer and then the event on a first payment, in one transaction, taking one lock for the business', async () => {
    const { repository, calls, customers, events } = database();
    expect(await repository.recordVerifiedPayment(payment)).toEqual({ inserted: true });
    const sql = calls.map((call) => call.sql);
    expect(sql[0]).toBe('BEGIN');
    expect(sql.at(-1)).toBe('COMMIT');
    expect(calls.find((call) => call.sql.startsWith('SELECT pg_advisory_xact_lock'))!.values).toEqual([JSON.stringify(['payment-ledger', 'tenant_1', 'org_1'])]);
    expect(statementsOf(calls)).toEqual(['SELECT billing_customers', 'INSERT INTO billing_customers', 'SELECT webhook_inbox', 'INSERT INTO webhook_inbox']);
    expect(customers).toEqual([{ customer_id: 'cus_ledger_1', organization_id: 'org_1', tenant_id: 'tenant_1' }]);
    expect(events).toEqual([{ event_id: 'evt_ledger_1', customer_id: 'cus_ledger_1', organization_id: 'org_1', tenant_id: 'tenant_1', payload_hash: payment.payloadHash }]);
    // A row is written pending (the inbox default): nothing in the statement sets a state.
    expect(calls.find((call) => call.sql.startsWith('INSERT INTO control_plane.webhook_inbox'))!.sql).not.toMatch(/state|processed/);
  });

  it('binds every value: no id, hash or payload is ever spliced into the SQL text', async () => {
    const { repository, calls } = database();
    await repository.recordVerifiedPayment(payment);
    await repository.storedCustomer({ tenantId: 'tenant_1', organizationId: 'org_1' });
    for (const { sql } of calls)
      for (const value of ['evt_ledger_1', 'cus_ledger_1', 'org_1', 'tenant_1', payment.payloadHash, 'cs_ledger_1', 'checkout.session.completed'])
        expect(sql).not.toContain(value);
    const inbox = calls.find((call) => call.sql.startsWith('INSERT INTO control_plane.webhook_inbox'))!;
    expect(inbox.values).toEqual(['stripe', 'evt_ledger_1', 'cus_ledger_1', 'org_1', 'tenant_1', payment.payloadHash, 'checkout.session.completed', JSON.stringify(payment.payload)]);
  });

  it('stores a replay once: the same event again writes nothing', async () => {
    const { repository, calls, customers, events } = database();
    await repository.recordVerifiedPayment(payment);
    const before = calls.length;
    expect(await repository.recordVerifiedPayment(payment)).toEqual({ inserted: false });
    expect(calls.slice(before).filter((call) => call.sql.startsWith('INSERT'))).toEqual([]);
    expect(customers).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('stores a later event for the same customer without storing the customer again', async () => {
    const { repository, calls, customers, events } = database();
    await repository.recordVerifiedPayment(payment);
    const before = calls.length;
    expect(await repository.recordVerifiedPayment({ ...payment, eventId: 'evt_ledger_2', payloadHash: 'b'.repeat(64) })).toEqual({ inserted: true });
    expect(calls.slice(before).filter((call) => call.sql.startsWith('INSERT INTO control_plane.billing_customers'))).toEqual([]);
    expect(customers).toHaveLength(1);
    expect(events.map((row) => row.event_id)).toEqual(['evt_ledger_1', 'evt_ledger_2']);
  });

  it('refuses another customer for the business, a customer that is another business\'s, and an event stored with other contents, writing nothing', async () => {
    const cases: [string, Parameters<PostgresRepository['recordVerifiedPayment']>[0], string][] = [
      ['another customer', { ...payment, eventId: 'evt_ledger_2', customerId: 'cus_ledger_2' }, 'customer_mismatch'],
      ['another business\'s customer', { ...payment, eventId: 'evt_ledger_2', organizationId: 'org_2' }, 'customer_mismatch'],
      ['another payload', { ...payment, payloadHash: 'c'.repeat(64) }, 'event_conflict'],
    ];
    for (const [name, input, code] of cases) {
      const { repository, calls, customers, events } = database();
      await repository.recordVerifiedPayment(payment);
      const before = calls.length;
      await expect(repository.recordVerifiedPayment(input), name).rejects.toMatchObject({ status: 409, code });
      const after = calls.slice(before).map((call) => call.sql);
      expect(after.filter((sql) => sql.startsWith('INSERT')), name).toEqual([]);
      expect(after, name).toContain('ROLLBACK');
      expect(after, name).not.toContain('COMMIT');
      expect(customers, name).toHaveLength(1);
      expect(events, name).toHaveLength(1);
    }
  });

  it('refuses an oversized payload before it connects, and ids that are not Stripe\'s', async () => {
    const { repository, calls } = database();
    await expect(repository.recordVerifiedPayment({ ...payment, payload: { data: 'é'.repeat(131_073) } })).rejects.toMatchObject({ status: 413 });
    await expect(repository.recordVerifiedPayment({ ...payment, customerId: 'not_a_customer' })).rejects.toThrow();
    await expect(repository.recordVerifiedPayment({ ...payment, eventId: 'not_an_event' })).rejects.toThrow();
    await expect(repository.recordVerifiedPayment({ ...payment, payloadHash: 'xyz' })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('reads the stored customer by tenant and business, and answers null when there is none', async () => {
    const { repository, calls } = database();
    expect(await repository.storedCustomer({ tenantId: 'tenant_1', organizationId: 'org_1' })).toBeNull();
    await repository.recordVerifiedPayment(payment);
    expect(await repository.storedCustomer({ tenantId: 'tenant_1', organizationId: 'org_1' })).toBe('cus_ledger_1');
    expect(await repository.storedCustomer({ tenantId: 'tenant_1', organizationId: 'org_2' })).toBeNull();
    expect(await repository.storedCustomer({ tenantId: 'tenant_2', organizationId: 'org_1' })).toBeNull();
    const select = calls.find((call) => call.sql.startsWith('SELECT customer_id FROM'))!;
    expect(select.sql).toBe('SELECT customer_id FROM control_plane.billing_customers WHERE provider=$1 AND tenant_id=$2 AND organization_id=$3');
    expect(select.values).toEqual(['stripe', 'tenant_1', 'org_1']);
  });
});

describe('the Worker login and the payment ledger', () => {
  async function everyPath() {
    const first = database();
    await first.repository.recordVerifiedPayment(payment);
    await first.repository.recordVerifiedPayment(payment);
    await first.repository.recordVerifiedPayment({ ...payment, eventId: 'evt_ledger_2', payloadHash: 'b'.repeat(64) });
    await first.repository.storedCustomer({ tenantId: 'tenant_1', organizationId: 'org_1' });
    return first.calls.map((call) => call.sql);
  }

  it('needs exactly the SELECT and INSERT on billing_customers and webhook_inbox that cp_runtime is granted, and nothing else', async () => {
    const used = needs(await everyPath());
    const granted = runtimeGrants(read('../scripts/runtime-permissions.sql'));
    for (const table of ['billing_customers', 'webhook_inbox']) {
      // Both ways: every privilege the ledger uses is granted, and nothing granted on the table goes unused.
      expect(describePrivileges(used.get(table)), table).toEqual(describePrivileges(granted.get(table)));
      expect(describePrivileges(used.get(table)), table).toEqual({ select: true, insert: true, update: [] });
    }
    expect([...used.keys()].sort()).toEqual(['billing_customers', 'webhook_inbox']);
  });

  it('writes an event or a customer once and never rewrites or deletes one', () => {
    const adapter = read('../src/postgres.ts');
    const ledger = adapter.slice(adapter.indexOf('async storedCustomer('), adapter.indexOf('\n}', adapter.indexOf('async recordVerifiedPayment(')));
    expect(ledger).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP|FOR (KEY )?(SHARE|UPDATE)|ON CONFLICT)\b/);
    const granted = runtimeGrants(read('../scripts/runtime-permissions.sql'));
    for (const table of ['billing_customers', 'webhook_inbox']) expect(granted.get(table)!.update.size).toBe(0);
  });
});