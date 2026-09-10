/**
 * Billing events, which arrive twice, late, and out of order.
 *
 * A billing platform is not a spend gate — it reports what has already been
 * decided somewhere else, asynchronously, with at-least-once delivery. Every
 * test here is about that gap between what an event says and what may be done
 * about it.
 *
 * The one that matters most: payment cannot lift a security suspension. A
 * suspended account that pays is a suspended account that has paid, and any
 * design where a late invoice event quietly restores access has a hole in it
 * that is very hard to see from inside the billing system.
 *
 * Every company, event and figure here is invented. Nothing was charged.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../server/store.js';
import { AllowanceLedger } from '../server/managed-usage.js';
import { BillingEventProcessor, type BillingEvent } from '../server/billing-events.js';
import { dollars } from '../shared/managed-usage.js';

const AT = '2026-09-10T09:00:00.000Z';
const ORG = 'org_billing';
const PERIOD = '2026-09';

let root = '';
let store: Store;
let ledger: AllowanceLedger;
let billing: BillingEventProcessor;

const allocation = (overrides: Partial<BillingEvent> = {}): BillingEvent =>
  ({
    type: 'period.allocated',
    eventId: 'evt_alloc_1',
    organizationId: ORG,
    periodId: PERIOD,
    planVersion: 'plan-2026-09-10.1',
    grantedMicroUsd: dollars(100),
    startsAt: AT,
    endsAt: '2026-10-01T00:00:00.000Z',
    sequence: 1,
    at: AT,
    ...overrides,
  }) as BillingEvent;

async function build() {
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'billing-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  ledger = new AllowanceLedger(store);
  await ledger.init();
  billing = new BillingEventProcessor(ledger, store);
  await billing.init();
}

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  await build();
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

describe('delivered more than once', () => {
  test('the same event id grants an allowance once', async () => {
    expect((await billing.apply(allocation())).applied).toBe(true);
    const again = await billing.apply(allocation());
    expect(again.applied).toBe(false);
    expect(again.reason).toMatch(/already/i);
    expect(ledger.summary(ORG, PERIOD).grantedMicroUsd).toBe(dollars(100));
  });

  test('a different event id for the same period grants nothing further', async () => {
    await billing.apply(allocation());
    // A replayed invoice under a new id is still the same period. The period,
    // not the event, is what a grant is keyed on.
    const other = await billing.apply(allocation({ eventId: 'evt_alloc_2', sequence: 2 }));
    expect(other.applied).toBe(false);
    expect(ledger.summary(ORG, PERIOD).grantedMicroUsd).toBe(dollars(100));
  });
});

describe('delivered out of order', () => {
  test('an event older than one already applied is ignored', async () => {
    await billing.apply(allocation({ sequence: 5 }));
    const late = await billing.apply(
      allocation({
        type: 'adjustment',
        eventId: 'evt_adj_late',
        reason: 'service-grant',
        direction: 'grant',
        amountMicroUsd: dollars(25),
        sequence: 2,
      }),
    );
    expect(late.applied).toBe(false);
    expect(late.reason).toMatch(/order|earlier|already/i);
    expect(ledger.summary(ORG, PERIOD).grantsMicroUsd).toBe(0);
  });

  test('an event newer than the last one applies and moves the mark forward', async () => {
    await billing.apply(allocation({ sequence: 1 }));
    const adjustment = await billing.apply(
      allocation({
        type: 'adjustment',
        eventId: 'evt_adj',
        reason: 'service-grant',
        direction: 'grant',
        amountMicroUsd: dollars(25),
        sequence: 2,
      }),
    );
    expect(adjustment.applied).toBe(true);
    expect(ledger.summary(ORG, PERIOD).grantsMicroUsd).toBe(dollars(25));
    expect(billing.status(ORG).lastSequence).toBe(2);
  });
});

describe('what payment cannot do', () => {
  test('a later allocation does not lift a security suspension', async () => {
    await billing.apply({
      type: 'security.suspended',
      eventId: 'evt_susp',
      organizationId: ORG,
      reason: 'Credentials were reported stolen.',
      sequence: 1,
      at: AT,
    });
    expect(billing.status(ORG).suspended).toBe(true);

    const paid = await billing.apply(allocation({ eventId: 'evt_alloc_after', sequence: 2 }));
    // The money may well be real. The suspension is about something else.
    expect(paid.applied).toBe(true);
    expect(billing.status(ORG).suspended).toBe(true);
    expect(billing.status(ORG).suspendedReason).toMatch(/stolen/i);
  });
});

describe('what lapsing cannot do', () => {
  test('a lapsed subscription destroys no records', async () => {
    await billing.apply(allocation());
    await ledger.adjust({
      id: 'adj_1',
      organizationId: ORG,
      periodId: PERIOD,
      reason: 'service-grant',
      direction: 'grant',
      amountMicroUsd: dollars(5),
      note: 'Goodwill.',
      sourceEventId: null,
      at: AT,
    });

    const lapsed = await billing.apply({
      type: 'subscription.lapsed',
      eventId: 'evt_lapse',
      organizationId: ORG,
      sequence: 2,
      at: '2026-09-30T00:00:00.000Z',
    });
    expect(lapsed.applied).toBe(true);
    expect(billing.status(ORG).paidThrough).toBe('2026-09-30T00:00:00.000Z');

    // Everything is still readable. Losing a subscription is not losing a record.
    const summary = ledger.summary(ORG, PERIOD);
    expect(summary.grantedMicroUsd).toBe(dollars(100));
    expect(summary.grantsMicroUsd).toBe(dollars(5));
  });
});

describe('durability', () => {
  test('a restart does not let a duplicate event through', async () => {
    await billing.apply(allocation());
    const second = new BillingEventProcessor(ledger, store);
    await second.init();
    const again = await second.apply(allocation());
    expect(again.applied).toBe(false);
    expect(second.status(ORG).lastSequence).toBe(1);
  });
});
