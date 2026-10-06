/**
 * The payment ledger over in-memory state, for the faux cloud and offline tests: the same rules as
 * PostgresRepository.ensureCustomer, recordVerifiedPayment, recordIgnoredEvent and markEvent (src/postgres.ts), without a database.
 *
 * It is the Worker login's side of buying credits, kept apart from the funding rows: the ledger stores a verified paid
 * event and the business's one Stripe customer in each environment, and the funding side's top-up refers to the stored event.
 * Each method checks everything before it writes anything, so a refusal leaves the state as it was.
 */
import { AccountError } from '../errors.js';
import type { BillingRef, IgnoredEvent, PaymentLedger, VerifiedPayment } from '../credit-purchases.js';
import type { StripeMode } from '../stripe-events.js';

/** A Stripe customer id, as Stripe makes them (the same rule as src/credit-purchases.ts). */
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,128}$/;

export interface BillingCustomerRow { customerId: string; tenantId: string; organizationId: string; environment: StripeMode }
/**
 * A stored verified event, the way webhook_inbox keeps it: a stored event no processor has taken yet is pending. A paid event is stored pending and
 * moves to processed or quarantined; an event of a type nothing handles is stored ignored, with no business when it names none of ours.
 */
export interface VerifiedEventRow {
  environment: StripeMode;
  eventId: string;
  customerId: string | null;
  organizationId: string | null;
  tenantId: string | null;
  payloadHash: string;
  eventType: string;
  payload: Record<string, unknown>;
  state: 'pending' | 'processed' | 'quarantined' | 'ignored';
  receivedAt: string;
  processedAt: string | null;
}

export interface LedgerState {
  /** billing_customers: at most one per business in each environment, and a customer belongs to one business. */
  billingCustomers: BillingCustomerRow[];
  /** webhook_inbox. */
  verifiedEvents: VerifiedEventRow[];
}

export const emptyLedgerState = (): LedgerState => ({ billingCustomers: [], verifiedEvents: [] });

/** Runs `use` over the ledger's state. The faux store passes its own draft, so the write is persisted and rolled back with it. */
export type LedgerAccess = <T>(use: (state: LedgerState) => T) => Promise<T>;

export class StatePaymentLedger implements PaymentLedger {
  /** The tail of each business's queue: what the advisory lock is in PostgreSQL. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly access: LedgerAccess, private readonly now: () => number = Date.now) {}

  /** Runs `work` after every earlier call under the same key has finished, as the Worker's advisory lock does. */
  private serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return run;
  }

  private business(ref: { tenantId: string; organizationId: string }): string {
    return JSON.stringify(['business', ref.tenantId, ref.organizationId]);
  }

  storedCustomer(ref: BillingRef): Promise<string | null> {
    return this.access((state) =>
      state.billingCustomers.find((row) => row.tenantId === ref.tenantId && row.organizationId === ref.organizationId && row.environment === ref.environment)?.customerId ?? null);
  }

  /** Read the business's customer, or make one with `make` and store it, with every other call for the business waiting its turn. */
  ensureCustomer(ref: BillingRef, make: () => Promise<string>): Promise<string> {
    return this.serialized(this.business(ref), async () => {
      const stored = await this.storedCustomer(ref);
      if (stored !== null) return stored;
      const customerId = await make();
      if (!CUSTOMER_ID.test(customerId)) throw new AccountError(502, 'The billing customer is not a Stripe customer id.');
      await this.access((state) => {
        // billing_customers' primary key: a customer id belongs to one business.
        if (state.billingCustomers.some((row) => row.customerId === customerId))
          throw new AccountError(409, 'The billing customer does not belong to this business.', 'customer_mismatch');
        state.billingCustomers.push({ customerId, tenantId: ref.tenantId, organizationId: ref.organizationId, environment: ref.environment });
      });
      return customerId;
    });
  }

  recordVerifiedPayment(input: VerifiedPayment): Promise<{ inserted: boolean }> {
    return this.serialized(this.business(input), () => this.recordNow(input));
  }

  private recordNow(input: VerifiedPayment): Promise<{ inserted: boolean }> {
    return this.access((state) => {
      const mapped = state.billingCustomers.filter((row) => row.customerId === input.customerId
        || (row.tenantId === input.tenantId && row.organizationId === input.organizationId && row.environment === input.environment));
      if (mapped.length > 1 || (mapped.length === 1 && (mapped[0].customerId !== input.customerId
        || mapped[0].organizationId !== input.organizationId || mapped[0].tenantId !== input.tenantId || mapped[0].environment !== input.environment)))
        throw new AccountError(409, 'The billing customer does not belong to this business.', 'customer_mismatch');
      const old = state.verifiedEvents.find((row) => row.eventId === input.eventId);
      if (old) {
        if (old.customerId !== input.customerId || old.organizationId !== input.organizationId || old.tenantId !== input.tenantId || old.payloadHash !== input.payloadHash
          || old.environment !== input.environment)
          throw new AccountError(409, 'The duplicate event has conflicting provenance.', 'event_conflict');
        return { inserted: false };
      }
      if (mapped.length === 0) state.billingCustomers.push({ customerId: input.customerId, tenantId: input.tenantId, organizationId: input.organizationId, environment: input.environment });
      state.verifiedEvents.push({ ...structuredClone(input), state: 'pending', receivedAt: new Date(this.now()).toISOString(), processedAt: null });
      return { inserted: true };
    });
  }

  /** The event is serialized on its id, as the Worker's advisory lock serializes two deliveries of it. */
  recordIgnoredEvent(input: IgnoredEvent): Promise<{ inserted: boolean }> {
    return this.serialized(JSON.stringify(['event', input.eventId]), () => this.access((state) => {
      const old = state.verifiedEvents.find((row) => row.eventId === input.eventId);
      if (old) {
        if (old.payloadHash !== input.payloadHash || old.environment !== input.environment)
          throw new AccountError(409, 'The duplicate event has conflicting provenance.', 'event_conflict');
        return { inserted: false };
      }
      // The business comes from our own customer row, never from the event.
      const owner = input.customerId === null ? undefined
        : state.billingCustomers.find((row) => row.customerId === input.customerId && row.environment === input.environment);
      state.verifiedEvents.push({
        environment: input.environment, eventId: input.eventId, customerId: owner?.customerId ?? null, organizationId: owner?.organizationId ?? null,
        tenantId: owner?.tenantId ?? null, payloadHash: input.payloadHash, eventType: input.eventType, payload: structuredClone(input.payload),
        state: 'ignored', receivedAt: new Date(this.now()).toISOString(), processedAt: null,
      });
      return { inserted: true };
    }));
  }

  /** Only a pending event moves, and only processed carries a time, as the inbox's checks require. */
  markEvent(ref: { environment: StripeMode; eventId: string }, state: 'processed' | 'quarantined'): Promise<boolean> {
    return this.access((ledger) => {
      const row = ledger.verifiedEvents.find((item) => item.eventId === ref.eventId && item.environment === ref.environment);
      if (!row || row.state !== 'pending') return false;
      row.state = state;
      row.processedAt = state === 'processed' ? new Date(this.now()).toISOString() : null;
      return true;
    });
  }
}

/** A ledger with state of its own, for tests that do not use the faux store. */
export function memoryPaymentLedger(now: () => number = Date.now) {
  const state = emptyLedgerState();
  return { state, ledger: new StatePaymentLedger(async (use) => use(state), now) };
}
