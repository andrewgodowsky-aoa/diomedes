/**
 * The payment ledger's SQL (PostgresRepository.storedCustomer, ensureCustomer and recordVerifiedPayment) against a recording client, and
 * against the Worker login's grant file. Protocol only: this does not run PostgreSQL. It checks what each call sends, that every
 * value is a bound parameter, the rules the statements enforce (one customer per business, an event stored once, nothing written
 * on a refusal), and that the statements need exactly the billing_customers and webhook_inbox privileges
 * scripts/runtime-permissions.sql grants cp_runtime, both ways. The funding login is checked in funding-permissions.test.ts: it
 * is granted neither table.
 */
import { describe, expect, it } from 'vitest';
import { PostgresRepository, type SqlClient } from '../src/postgres.js';
import { describePrivileges, needs, read, recording, runtimeGrants } from './support/runtime-grants.js';

const payment = {
  environment: 'test' as const, eventId: 'evt_ledger_1', customerId: 'cus_ledger_1', organizationId: 'org_1', tenantId: 'tenant_1',
  payloadHash: 'a'.repeat(64), eventType: 'checkout.session.completed',
  payload: { id: 'evt_ledger_1', data: { object: { id: 'cs_ledger_1', customer: 'cus_ledger_1' } } },
};

/** billing_customers and webhook_inbox as rows, answering the statements the ledger sends. */
function database() {
  const customers: { customer_id: string; organization_id: string; tenant_id: string; environment: string }[] = [];
  const events: { event_id: string; customer_id: string | null; organization_id: string | null; tenant_id: string | null; payload_hash: string; environment: string;
    state: string; processed_at: string | null }[] = [];
  const db = recording((sql, values) => {
    if (sql.startsWith('SELECT customer_id FROM control_plane.billing_customers'))
      return customers.filter((row) => row.tenant_id === values[1] && row.organization_id === values[2] && row.environment === values[3]).map((row) => ({ customer_id: row.customer_id }));
    if (sql.startsWith('SELECT customer_id,organization_id,tenant_id,environment FROM control_plane.billing_customers'))
      return customers.filter((row) => row.customer_id === values[1] || (row.tenant_id === values[2] && row.organization_id === values[3] && row.environment === values[4]));
    if (sql.startsWith('SELECT customer_id,organization_id,tenant_id FROM control_plane.billing_customers'))
      return customers.filter((row) => row.environment === values[1] && row.customer_id === values[2]);
    if (sql.startsWith('INSERT INTO control_plane.billing_customers(')) {
      customers.push({ customer_id: String(values[1]), organization_id: String(values[2]), tenant_id: String(values[3]), environment: String(values[4]) });
      return [];
    }
    if (sql.startsWith('SELECT customer_id,organization_id,tenant_id,payload_hash,environment FROM control_plane.webhook_inbox')
      || sql.startsWith('SELECT payload_hash,environment FROM control_plane.webhook_inbox'))
      return events.filter((row) => row.event_id === values[1]);
    if (sql.startsWith('INSERT INTO control_plane.webhook_inbox(')) {
      events.push({ event_id: String(values[1]), customer_id: values[2] as string | null, organization_id: values[3] as string | null, tenant_id: values[4] as string | null,
        payload_hash: String(values[5]), environment: String(values[8]), state: sql.includes("'ignored'") ? 'ignored' : 'pending', processed_at: null });
      return [];
    }
    if (sql.startsWith('UPDATE control_plane.webhook_inbox')) {
      // Only a pending row of this environment and event moves, as the statement says.
      const moved = events.filter((row) => row.environment === values[2] && row.event_id === values[3] && row.state === 'pending');
      for (const row of moved) { row.state = String(values[0]); row.processed_at = values[1] as string | null; }
      return moved.map((row) => ({ event_id: row.event_id }));
    }
    return [];
  });
  return { ...db, customers, events, repository: new PostgresRepository(db.factory) };
}
/**
 * The same rows with PostgreSQL's per-business advisory lock: a transaction that asks for a held key waits until the one holding
 * it commits or rolls back, as pg_advisory_xact_lock does, so two calls made at once run one after the other.
 */
function lockingDatabase() {
  const db = database();
  const tails = new Map<string, Promise<void>>();
  const factory = (): SqlClient => {
    let release: (() => void) | null = null;
    return {
      async connect() {},
      async end() {},
      async query(sql, values = []) {
        if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
          const key = String(values[0]);
          const prior = tails.get(key) ?? Promise.resolve();
          let done!: () => void;
          tails.set(key, new Promise<void>((resolve) => { done = resolve; }));
          await prior;
          release = done;
        }
        // Another connection runs between this one's statements, as it would against the database.
        await new Promise((resolve) => setTimeout(resolve, 1));
        const result = await db.client.query(sql, values);
        if (sql === 'COMMIT' || sql === 'ROLLBACK') { release?.(); release = null; }
        return result;
      },
    };
  };
  return { ...db, repository: new PostgresRepository(factory) };
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
    expect(customers).toEqual([{ customer_id: 'cus_ledger_1', organization_id: 'org_1', tenant_id: 'tenant_1', environment: 'test' }]);
    expect(events).toEqual([{ event_id: 'evt_ledger_1', customer_id: 'cus_ledger_1', organization_id: 'org_1', tenant_id: 'tenant_1', payload_hash: payment.payloadHash,
      environment: 'test', state: 'pending', processed_at: null }]);
    // A row is written pending (the inbox default): nothing in the statement sets a state.
    expect(calls.find((call) => call.sql.startsWith('INSERT INTO control_plane.webhook_inbox'))!.sql).not.toMatch(/state|processed/);
  });

  it('binds every value: no id, hash or payload is ever spliced into the SQL text', async () => {
    const { repository, calls } = database();
    await repository.recordVerifiedPayment(payment);
    await repository.storedCustomer({ tenantId: 'tenant_1', organizationId: 'org_1', environment: 'test' });
    for (const { sql } of calls)
      for (const value of ['evt_ledger_1', 'cus_ledger_1', 'org_1', 'tenant_1', payment.payloadHash, 'cs_ledger_1', 'checkout.session.completed'])
        expect(sql).not.toContain(value);
    const inbox = calls.find((call) => call.sql.startsWith('INSERT INTO control_plane.webhook_inbox'))!;
    expect(inbox.values).toEqual(['stripe', 'evt_ledger_1', 'cus_ledger_1', 'org_1', 'tenant_1', payment.payloadHash, 'checkout.session.completed', JSON.stringify(payment.payload), 'test']);
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
    expect(await repository.storedCustomer({ tenantId: 'tenant_1', organizationId: 'org_1', environment: 'test' })).toBeNull();
    await repository.recordVerifiedPayment(payment);
    expect(await repository.storedCustomer({ tenantId: 'tenant_1', organizationId: 'org_1', environment: 'test' })).toBe('cus_ledger_1');
    expect(await repository.storedCustomer({ tenantId: 'tenant_1', organizationId: 'org_2', environment: 'test' })).toBeNull();
    expect(await repository.storedCustomer({ tenantId: 'tenant_2', organizationId: 'org_1', environment: 'test' })).toBeNull();
    // A test customer is never the business's live one.
    expect(await repository.storedCustomer({ tenantId: 'tenant_1', organizationId: 'org_1', environment: 'live' })).toBeNull();
    const select = calls.find((call) => call.sql.startsWith('SELECT customer_id FROM'))!;
    expect(select.sql).toBe('SELECT customer_id FROM control_plane.billing_customers WHERE provider=$1 AND tenant_id=$2 AND organization_id=$3 AND environment=$4');
    expect(select.values).toEqual(['stripe', 'tenant_1', 'org_1', 'test']);
  });
});

const business = { tenantId: 'tenant_1', organizationId: 'org_1', environment: 'test' as const };

describe('the business\'s one customer, made before its first session', () => {
  it('reads the stored customer and makes none when there is one, taking the business\'s lock first and writing nothing', async () => {
    const { repository, calls, customers } = database();
    await repository.recordVerifiedPayment(payment);
    const before = calls.length;
    let made = 0;
    expect(await repository.ensureCustomer(business, async () => { made++; return 'cus_new'; })).toBe('cus_ledger_1');
    expect(made).toBe(0);
    const sent = calls.slice(before);
    expect(sent.map((call) => call.sql)[0]).toBe('BEGIN');
    expect(sent.map((call) => call.sql).at(-1)).toBe('COMMIT');
    expect(sent.find((call) => call.sql.startsWith('SELECT pg_advisory_xact_lock'))!.values).toEqual([JSON.stringify(['payment-ledger', 'tenant_1', 'org_1'])]);
    expect(statementsOf(sent)).toEqual(['SELECT billing_customers']);
    expect(customers).toHaveLength(1);
  });

  it('runs the Stripe call under the lock, after the read found none, and stores what it answers with the business and tenant in the same transaction', async () => {
    const { repository, calls, customers } = database();
    let seenInCall: string[] = [];
    expect(await repository.ensureCustomer(business, async () => { seenInCall = calls.map((call) => call.sql); return 'cus_made_1'; })).toBe('cus_made_1');
    // The lock and the read were sent before the call ran, and the row after it, all inside one BEGIN and COMMIT.
    const beforeCall = seenInCall.filter((sql) => !/^(BEGIN|SET LOCAL)/.test(sql));
    expect(beforeCall).toHaveLength(2);
    expect(beforeCall[0]).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(beforeCall[1]).toMatch(/^SELECT customer_id FROM control_plane.billing_customers /);
    const sql = calls.map((call) => call.sql);
    expect(sql.filter((text) => text === 'BEGIN')).toHaveLength(1);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(statementsOf(calls)).toEqual(['SELECT billing_customers', 'INSERT INTO billing_customers']);
    const insert = calls.find((call) => call.sql.startsWith('INSERT INTO control_plane.billing_customers'))!;
    expect(insert.values).toEqual(['stripe', 'cus_made_1', 'org_1', 'tenant_1', 'test']);
    expect(insert.sql).not.toMatch(/state|processed|ON CONFLICT|webhook_inbox/);
    expect(customers).toEqual([{ customer_id: 'cus_made_1', organization_id: 'org_1', tenant_id: 'tenant_1', environment: 'test' }]);
  });

  it('stores nothing and rolls back when the Stripe call fails, and the next call asks again', async () => {
    const { repository, calls, customers } = database();
    await expect(repository.ensureCustomer(business, async () => { throw new Error('stripe is down'); })).rejects.toThrow('stripe is down');
    expect(customers).toEqual([]);
    const sql = calls.map((call) => call.sql);
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
    expect(sql.filter((text) => text.startsWith('INSERT'))).toEqual([]);
    expect(await repository.ensureCustomer(business, async () => 'cus_second_try')).toBe('cus_second_try');
    expect(customers).toHaveLength(1);
  });

  it('refuses an answer that is not a Stripe customer id before it stores anything', async () => {
    for (const answer of ['not_a_customer', 'cus_', '', 'cus_' + 'a'.repeat(129), "cus_x'); DROP TABLE control_plane.billing_customers;--"]) {
      const { repository, calls, customers } = database();
      await expect(repository.ensureCustomer(business, async () => answer), answer).rejects.toThrow();
      expect(customers).toEqual([]);
      expect(calls.map((call) => call.sql).filter((text) => text.startsWith('INSERT'))).toEqual([]);
    }
  });

  it('binds the business and the customer: nothing is spliced into the SQL text', async () => {
    const { repository, calls } = database();
    await repository.ensureCustomer(business, async () => 'cus_made_1');
    for (const { sql } of calls) for (const value of ['cus_made_1', 'org_1', 'tenant_1']) expect(sql).not.toContain(value);
  });

  it('gives two first calls made at once one customer: the second waits for the lock, finds the first\'s row and never calls Stripe', async () => {
    const { repository, customers, calls } = lockingDatabase();
    let made = 0;
    const make = async () => { made++; await new Promise((resolve) => setTimeout(resolve, 10)); return `cus_made_${made}`; };
    const answers = await Promise.all([repository.ensureCustomer(business, make), repository.ensureCustomer(business, make), repository.ensureCustomer(business, make)]);
    expect(answers).toEqual(['cus_made_1', 'cus_made_1', 'cus_made_1']);
    expect(made).toBe(1);
    expect(customers).toEqual([{ customer_id: 'cus_made_1', organization_id: 'org_1', tenant_id: 'tenant_1', environment: 'test' }]);
    expect(calls.filter((call) => call.sql.startsWith('INSERT INTO control_plane.billing_customers'))).toHaveLength(1);
  });

  it('serializes with a paid event for the same business, so an event cannot store another customer between the read and the write', async () => {
    const { repository, customers, events } = lockingDatabase();
    const first = repository.ensureCustomer(business, async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return 'cus_made_1'; });
    // The event names the customer the business is about to be given: it waits, then finds that customer already stored.
    const event = repository.recordVerifiedPayment({ ...payment, customerId: 'cus_made_1' });
    expect(await first).toBe('cus_made_1');
    expect(await event).toEqual({ inserted: true });
    expect(customers).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('lets two businesses make their customers at once', async () => {
    const { repository, customers } = lockingDatabase();
    let made = 0;
    const make = async () => `cus_biz_${++made}`;
    await Promise.all([repository.ensureCustomer(business, make), repository.ensureCustomer({ ...business, organizationId: 'org_2' }, make)]);
    expect(made).toBe(2);
    expect(customers.map((row) => row.organization_id).sort()).toEqual(['org_1', 'org_2']);
  });

  it('keeps a customer that belongs to the business even when the event after it names another: the mismatch is still refused', async () => {
    const { repository, customers, events } = database();
    await repository.ensureCustomer(business, async () => 'cus_made_1');
    await expect(repository.recordVerifiedPayment({ ...payment, customerId: 'cus_ledger_2' })).rejects.toMatchObject({ status: 409, code: 'customer_mismatch' });
    expect(customers).toHaveLength(1);
    expect(events).toEqual([]);
    expect(await repository.recordVerifiedPayment({ ...payment, customerId: 'cus_made_1' })).toEqual({ inserted: true });
  });
});

describe('the Worker login and the payment ledger', () => {
  async function everyPath() {
    const first = database();
    await first.repository.recordVerifiedPayment(payment);
    await first.repository.recordVerifiedPayment(payment);
    await first.repository.recordVerifiedPayment({ ...payment, eventId: 'evt_ledger_2', payloadHash: 'b'.repeat(64) });
    await first.repository.storedCustomer(business);
    // The customer made before a first session: a read that finds none and writes one, and a read that finds it.
    const second = database();
    await second.repository.ensureCustomer(business, async () => 'cus_ledger_1');
    await second.repository.ensureCustomer(business, async () => 'cus_ledger_1');
    // An event of a type nothing handles, with a customer of ours and without, and the marks that move a stored event.
    const third = database();
    await third.repository.recordVerifiedPayment(payment);
    await third.repository.recordIgnoredEvent({ environment: 'test', eventId: 'evt_ignored_1', customerId: 'cus_ledger_1', payloadHash: 'd'.repeat(64), eventType: 'customer.created', payload: {} });
    await third.repository.recordIgnoredEvent({ environment: 'test', eventId: 'evt_ignored_2', customerId: null, payloadHash: 'e'.repeat(64), eventType: 'product.created', payload: {} });
    await third.repository.markEvent({ environment: 'test', eventId: 'evt_ledger_1' }, 'processed');
    await third.repository.markEvent({ environment: 'test', eventId: 'evt_ledger_1' }, 'quarantined');
    return [...first.calls, ...second.calls, ...third.calls].map((call) => call.sql);
  }

  it('needs exactly the SELECT and INSERT on billing_customers, and the SELECT, INSERT and UPDATE of state and processed_at on webhook_inbox, that cp_runtime is granted, and nothing else', async () => {
    const used = needs(await everyPath());
    const granted = runtimeGrants(read('../scripts/runtime-permissions.sql'));
    for (const table of ['billing_customers', 'webhook_inbox']) {
      // Both ways: every privilege the ledger uses is granted, and nothing granted on the table goes unused.
      expect(describePrivileges(used.get(table)), table).toEqual(describePrivileges(granted.get(table)));
    }
    expect(describePrivileges(used.get('billing_customers'))).toEqual({ select: true, insert: true, update: [] });
    // An event is marked, and nothing else of it is ever rewritten: UPDATE on these two columns and no more.
    expect(describePrivileges(used.get('webhook_inbox'))).toEqual({ select: true, insert: true, update: ['processed_at', 'state'] });
    expect([...used.keys()].sort()).toEqual(['billing_customers', 'webhook_inbox']);
  });

  it('needs nothing more for making the customer than the SELECT and INSERT on billing_customers it is already granted', async () => {
    const { repository, calls } = database();
    await repository.ensureCustomer(business, async () => 'cus_ledger_1');
    const used = needs(calls.map((call) => call.sql));
    expect([...used.keys()]).toEqual(['billing_customers']);
    expect(describePrivileges(used.get('billing_customers'))).toEqual({ select: true, insert: true, update: [] });
    const granted = runtimeGrants(read('../scripts/runtime-permissions.sql'));
    expect(describePrivileges(granted.get('billing_customers'))).toEqual(describePrivileges(used.get('billing_customers')));
    // The advisory lock is a function every role may call: no grant, and none is asked for.
    expect(read('../scripts/runtime-permissions.sql')).not.toMatch(/pg_advisory/);
  });

  it('writes an event or a customer once and never rewrites or deletes one, apart from marking an event\'s state', () => {
    const adapter = read('../src/postgres.ts');
    // Code only: the comments above the methods may name the statements they do not send.
    const ledger = adapter.slice(adapter.indexOf('async storedCustomer('), adapter.indexOf('async markEvent(')).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(ledger).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP|FOR (KEY )?(SHARE|UPDATE)|ON CONFLICT)\b/);
    // The one UPDATE moves a pending event's state and time, and nothing else of it.
    const mark = adapter.slice(adapter.indexOf('async markEvent('), adapter.indexOf('\n}', adapter.indexOf('async markEvent(')));
    expect(mark.match(/UPDATE control_plane\./g)).toHaveLength(1);
    expect(mark).toContain("SET state=$1, processed_at=$2 WHERE provider='stripe' AND environment=$3 AND event_id=$4 AND state='pending'");
    expect(mark).not.toMatch(/\b(DELETE|TRUNCATE|DROP)\b/);
    const granted = runtimeGrants(read('../scripts/runtime-permissions.sql'));
    expect(granted.get('billing_customers')!.update.size).toBe(0);
    expect([...granted.get('webhook_inbox')!.update].sort()).toEqual(['processed_at', 'state']);
  });
});