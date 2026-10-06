/**
 * The router for Stripe's verified events (billing foundation, slice 1).
 *
 * The receiver (StripeWebhookService, src/credit-purchases.ts) verifies the signature, parses the event and checks its
 * mode before anything else. What it does with a verified event is decided here, in one place: one handler per event
 * type, and one answer for every type nobody handles, which is to store the event in the inbox and mark it ignored.
 * Later slices register their types (subscription and invoice events, refunds, disputes) by adding to the handler map,
 * never by adding a branch to the receiver.
 *
 * A handler throws for a failure a retry could change (the receiver answers 503 and Stripe sends the event again) and
 * returns for everything else. Nothing here reads the database: a handler is given the stores it needs.
 */

/** The parts of a Stripe event the receiver has verified and every handler can rely on. */
export interface StripeEvent {
  id: string;
  type: string;
  /** Stripe's own flag, required on every event: the receiver has already matched it to the Worker's mode. */
  livemode: boolean;
  data: { object: unknown };
}

export type StripeMode = 'test' | 'live';

/** What a handler is given: the verified event, the raw bytes it was verified over, and the Worker's mode. */
export interface StripeEventContext {
  event: StripeEvent;
  raw: Uint8Array;
  environment: StripeMode;
}

export type StripeEventHandler = (context: StripeEventContext) => Promise<void>;

/** One handler per event type, and the answer for a type with none. */
export class StripeEventRouter {
  private readonly handlers: Map<string, StripeEventHandler>;

  constructor(handlers: Record<string, StripeEventHandler>, private readonly unknown: StripeEventHandler) {
    this.handlers = new Map(Object.entries(handlers));
  }

  /** Whether an event type has a handler of its own. */
  handles(type: string): boolean {
    return this.handlers.has(type);
  }

  /** The event types with a handler of their own, for the README and the tests. */
  types(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async dispatch(context: StripeEventContext): Promise<void> {
    const handler = this.handlers.get(context.event.type) ?? this.unknown;
    await handler(context);
  }
}
