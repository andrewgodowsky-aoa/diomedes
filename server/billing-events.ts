/**
 * Turning billing events into ledger calls, and nothing else.
 *
 * A billing platform reports what has already happened, asynchronously, at
 * least once, and not necessarily in order. Stripe documents all three. So this
 * module is written for a stream that lies about time and repeats itself, and
 * it is deliberately not the spend gate: admission and reservations live in the
 * gateway, where a decision can be made before money is spent rather than after
 * a webhook says it was.
 *
 * Three rules do the work.
 *
 * **A period is granted once.** The key is the period, not the event. A
 * duplicate delivery and a genuinely new invoice event for a period already
 * allocated are the same thing from here: nothing more to grant. Reinstalling,
 * a new profile or a new member cannot reset credit, because none of them
 * produce a new period id.
 *
 * **Older is ignored.** Every event carries a sequence; one below the last
 * applied is a late delivery of something already superseded, and applying it
 * would move a balance backwards.
 *
 * **Payment cannot lift a suspension.** A security suspension and a paid
 * invoice answer different questions, and a system where a late billing event
 * restores suspended access has a hole in it that is invisible from inside the
 * billing system. The allocation still applies — the money is real — and the
 * suspension stays exactly where it was.
 */
import path from 'node:path';
import { RATE_CARD_V1, type AdjustmentReason, type MicroUsd } from '../shared/managed-usage.js';
import type { AllowanceLedger } from './managed-usage.js';
import { jsonWrite, readJson, type Store } from './store.js';

export type BillingEvent =
  | {
      readonly type: 'period.allocated';
      readonly eventId: string;
      readonly organizationId: string;
      readonly periodId: string;
      readonly planVersion: string;
      readonly grantedMicroUsd: MicroUsd;
      readonly startsAt: string;
      readonly endsAt: string;
      readonly sequence: number;
      readonly at: string;
    }
  | {
      readonly type: 'adjustment';
      readonly eventId: string;
      readonly organizationId: string;
      readonly periodId: string;
      readonly reason: AdjustmentReason;
      readonly direction: 'grant' | 'withdraw';
      readonly amountMicroUsd: MicroUsd;
      readonly sequence: number;
      readonly at: string;
    }
  | {
      readonly type: 'subscription.lapsed';
      readonly eventId: string;
      readonly organizationId: string;
      readonly sequence: number;
      readonly at: string;
    }
  | {
      readonly type: 'security.suspended';
      readonly eventId: string;
      readonly organizationId: string;
      readonly reason: string;
      readonly sequence: number;
      readonly at: string;
    };

export interface BillingStatus {
  readonly paidThrough: string | null;
  readonly suspended: boolean;
  readonly suspendedReason: string | null;
  readonly lastSequence: number;
}

interface Record_ {
  v: 1;
  /** Every event id seen, so an at-least-once delivery is applied at most once. */
  seen: string[];
  lastSequence: number;
  paidThrough: string | null;
  suspended: boolean;
  suspendedReason: string | null;
  /** Periods already granted, so a new event id cannot re-grant one. */
  granted: string[];
}

const empty = (): Record_ => ({
  v: 1,
  seen: [],
  lastSequence: 0,
  paidThrough: null,
  suspended: false,
  suspendedReason: null,
  granted: [],
});

const NOT_APPLIED = (reason: string) => ({ applied: false, reason });

export class BillingEventProcessor {
  private readonly records = new Map<string, Record_>();

  constructor(
    private readonly ledger: AllowanceLedger,
    private readonly store: Store,
  ) {}

  private get root() {
    return path.join(this.store.dataDir, 'billing');
  }
  private file(organizationId: string) {
    return path.join(this.root, `${organizationId}.json`);
  }

  /**
   * Nothing is read eagerly. One file per organization is the tenant boundary
   * made structural, and loading them all at start would be a list of every
   * customer held in memory for no reason.
   */
  async init(): Promise<void> {
    this.records.clear();
  }

  private async recordFor(organizationId: string): Promise<Record_> {
    const held = this.records.get(organizationId);
    if (held) return held;
    const loaded = await readJson<Record_>(this.file(organizationId), empty);
    loaded.seen ??= [];
    loaded.granted ??= [];
    this.records.set(organizationId, loaded);
    return loaded;
  }

  async apply(event: BillingEvent): Promise<{ applied: boolean; reason: string }> {
    const record = await this.recordFor(event.organizationId);

    if (record.seen.includes(event.eventId))
      return NOT_APPLIED('This event was already applied. Delivering it again changes nothing.');
    if (event.sequence < record.lastSequence)
      return NOT_APPLIED(
        `This event is older than one already applied, so it arrived out of order and was ignored.`,
      );

    switch (event.type) {
      case 'period.allocated': {
        if (record.granted.includes(event.periodId)) {
          // Seen under a different id. Record the id so a third delivery is
          // cheap, but grant nothing: the period is what a grant is keyed on.
          record.seen.push(event.eventId);
          record.lastSequence = Math.max(record.lastSequence, event.sequence);
          await this.persist(event.organizationId, record);
          return NOT_APPLIED('This period was already allocated. No further allowance was added.');
        }
        await this.ledger.allocatePeriod({
          organizationId: event.organizationId,
          periodId: event.periodId,
          planVersion: event.planVersion,
          rateCardVersion: RATE_CARD_V1.version,
          grantedMicroUsd: event.grantedMicroUsd,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          sourceEventId: event.eventId,
          at: event.at,
        });
        record.granted.push(event.periodId);
        // Deliberately not touching `suspended`. Paying is not the question a
        // security suspension asked.
        break;
      }
      case 'adjustment': {
        await this.ledger.adjust({
          id: event.eventId,
          organizationId: event.organizationId,
          periodId: event.periodId,
          reason: event.reason,
          direction: event.direction,
          amountMicroUsd: event.amountMicroUsd,
          note: `From billing event ${event.eventId}.`,
          sourceEventId: event.eventId,
          at: event.at,
        });
        break;
      }
      case 'subscription.lapsed': {
        // Paid-through, and nothing else. No record is removed: what happens to
        // a lapsed customer's data is a membership and privacy question with
        // its own answer, not a side effect of a billing event.
        record.paidThrough = event.at;
        break;
      }
      case 'security.suspended': {
        record.suspended = true;
        record.suspendedReason = event.reason;
        break;
      }
    }

    record.seen.push(event.eventId);
    record.lastSequence = Math.max(record.lastSequence, event.sequence);
    await this.persist(event.organizationId, record);
    return { applied: true, reason: '' };
  }

  private async persist(organizationId: string, record: Record_) {
    this.records.set(organizationId, record);
    await jsonWrite(this.file(organizationId), record);
  }

  status(organizationId: string): BillingStatus {
    const record = this.records.get(organizationId) ?? empty();
    return {
      paidThrough: record.paidThrough,
      suspended: record.suspended,
      suspendedReason: record.suspendedReason,
      lastSequence: record.lastSequence,
    };
  }

  /** Read a status that may not be in memory yet. */
  async statusOf(organizationId: string): Promise<BillingStatus> {
    await this.recordFor(organizationId);
    return this.status(organizationId);
  }
}
