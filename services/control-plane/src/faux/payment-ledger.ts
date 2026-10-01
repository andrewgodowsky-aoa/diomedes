/**
 * The payment ledger over in-memory state, for the faux cloud and offline tests: the same rules as
 * PostgresRepository.ensureCustomer and recordVerifiedPayment (src/postgres.ts), without a database.
 *
 * It is the Worker login's side of buying credits, kept apart from the funding rows: the ledger stores a verified paid
 * event and the business's one Stripe customer, and the funding side's top-up refers to the stored event. Each method
 * checks everything before it writes anything, so a refusal leaves the state as it was.
 */
import { AccountError } from '../errors.js';
import type { PaymentLedger, VerifiedPayment } from '../credit-purchases.js';

/** A Stripe customer id, as Stripe makes them (the same rule as src/credit-purchases.ts). */
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,128}$/;

export interface BillingCustomerRow { customerId: string; tenantId: string; organizationId: string }
/** A stored verified event, the way webhook_inbox keeps it: a stored event no processor has taken yet is pending. */
export interface VerifiedEventRow extends VerifiedPayment { state: 'pending'; receivedAt: string }

export interface LedgerState {
  /** billing_customers: at most one per business, and a customer belongs to one business. */
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

  /** Runs `work` after every earlier call for the same business has finished, as the Worker's per-business lock does. */
  private serialized<T>(ref: { tenantId: string; organizationId: string }, work: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([ref.tenantId, ref.organizationId]);
    const run = (this.queues.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return run;
  }

  storedCustomer(ref: { tenantId: string; organizationId: string }): Promise<string | null> {
    return this.access((state) =>
      state.billingCustomers.find((row) => row.tenantId === ref.tenantId && row.organizationId === ref.organizationId)?.customerId ?? null);
  }

  /** Read the business's customer, or make one with `make` and store it, with every other call for the business waiting its turn. */
  ensureCustomer(ref: { tenantId: string; organizationId: string }, make: () => Promise<string>): Promise<string> {
    return this.serialized(ref, async () => {
      const stored = await this.storedCustomer(ref);
      if (stored !== null) return stored;
      const customerId = await make();
      if (!CUSTOMER_ID.test(customerId)) throw new AccountError(502, 'The billing customer is not a Stripe customer id.');
      await this.access((state) => {
        // billing_customers' primary key: a customer id belongs to one business.
        if (state.billingCustomers.some((row) => row.customerId === customerId))
          throw new AccountError(409, 'The billing customer does not belong to this business.', 'customer_mismatch');
        state.billingCustomers.push({ customerId, tenantId: ref.tenantId, organizationId: ref.organizationId });
      });
      return customerId;
    });
  }

  recordVerifiedPayment(input: VerifiedPayment): Promise<{ inserted: boolean }> {
    return this.serialized(input, () => this.recordNow(input));
  }

  private recordNow(input: VerifiedPayment): Promise<{ inserted: boolean }> {
    return this.access((state) => {
      const mapped = state.billingCustomers.filter((row) => row.customerId === input.customerId
        || (row.tenantId === input.tenantId && row.organizationId === input.organizationId));
      if (mapped.length > 1 || (mapped.length === 1 && (mapped[0].customerId !== input.customerId
        || mapped[0].organizationId !== input.organizationId || mapped[0].tenantId !== input.tenantId)))
        throw new AccountError(409, 'The billing customer does not belong to this business.', 'customer_mismatch');
      const old = state.verifiedEvents.find((row) => row.eventId === input.eventId);
      if (old) {
        if (old.customerId !== input.customerId || old.organizationId !== input.organizationId || old.tenantId !== input.tenantId || old.payloadHash !== input.payloadHash)
          throw new AccountError(409, 'The duplicate event has conflicting provenance.', 'event_conflict');
        return { inserted: false };
      }
      if (mapped.length === 0) state.billingCustomers.push({ customerId: input.customerId, tenantId: input.tenantId, organizationId: input.organizationId });
      state.verifiedEvents.push({ ...structuredClone(input), state: 'pending', receivedAt: new Date(this.now()).toISOString() });
      return { inserted: true };
    });
  }
}

/** A ledger with state of its own, for tests that do not use the faux store. */
export function memoryPaymentLedger(now: () => number = Date.now) {
  const state = emptyLedgerState();
  return { state, ledger: new StatePaymentLedger(async (use) => use(state), now) };
}