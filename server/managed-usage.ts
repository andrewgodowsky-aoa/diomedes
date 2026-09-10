/**
 * The durable allowance ledger: what each organization was granted, what is
 * held, what was spent, and what nobody yet knows.
 *
 *   <data>/allowance/<organizationId>.json   one company's periods, holds,
 *                                            settlements and adjustments
 *
 * One file per organization is the tenant boundary made structural. A query
 * names its company and reads only that company's file, so there is no shared
 * table to mis-filter and no cross-tenant id to accidentally resolve.
 *
 * Persistence copies `server/workspaces.ts`: files read on `init()`, written
 * atomically on every change, with an in-memory map as the read path. The
 * routes already hold `store.locked()`, so this service never takes the lock
 * itself.
 *
 * Money and state transitions are owned by `shared/managed-usage.ts`. This
 * module does arithmetic only through `sumMoney` / `subtractMoney` and moves
 * reservations only through `reservationTransition`, so neither a second money
 * rule nor a second state table can drift out of agreement with the contract.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  RATE_CARD_V1,
  chargeKindEligibility,
  formatMoney,
  reservationTransition,
  subtractMoney,
  sumMoney,
  type AllowanceAdjustment,
  type AllowancePeriod,
  type AllowanceSummary,
  type ChargeEligibility,
  type ChargeKind,
  type MicroUsd,
  type Payer,
  type Reservation,
  type SettledCharge,
} from '../shared/managed-usage.js';
import { ApiError, absent } from './paths.js';
import { jsonWrite, readJson, type Store } from './store.js';

export interface ReserveInput {
  reservationId: string; // caller-supplied idempotency key
  organizationId: string;
  periodId: string;
  parentTaskId: string | null;
  kind: ChargeKind;
  route: string;
  payer: Payer;
  maxMicroUsd: MicroUsd; // conservative ceiling, not an estimate
  rateCardVersion: string;
  parentEnvelopeMicroUsd: MicroUsd | null; // null = no parent envelope
  at: string;
}

/** One company's durable allowance records, as one file is written. */
interface StoredAllowance {
  v: 1;
  organizationId: string;
  periods: AllowancePeriod[];
  reservations: Reservation[];
  settlements: SettledCharge[];
  adjustments: AllowanceAdjustment[];
}

const emptyStored = (organizationId: string): StoredAllowance => ({
  v: 1,
  organizationId,
  periods: [],
  reservations: [],
  settlements: [],
  adjustments: [],
});

const refuse = (
  status: number,
  message: string,
  code: string,
): ApiError => new ApiError(status, message, { code });

/**
 * What a settled call cost the allowance under its rate card.
 *
 * A settlement under the known card keeps the classification it was recorded
 * under. A version this build does not know cannot be classified honestly, so
 * the debit itself is the record: money that left the allowance was included,
 * money that did not was billed elsewhere.
 */
function eligibilityFor(
  rateCardVersion: string,
  kind: ChargeKind,
  allowanceDebitMicroUsd: MicroUsd,
): ChargeEligibility {
  if (rateCardVersion === RATE_CARD_V1.version)
    return chargeKindEligibility(RATE_CARD_V1, kind);
  return allowanceDebitMicroUsd > 0 ? 'included' : 'excluded-billed-separately';
}

export class AllowanceLedger {
  private readonly files = new Map<string, StoredAllowance>();

  constructor(private readonly store: Store) {}

  private get root() {
    return path.join(this.store.dataDir, 'allowance');
  }

  private filePath(organizationId: string) {
    return path.join(this.root, `${organizationId}.json`);
  }

  /**
   * Load every company's file. A missing directory is a fresh install. A file
   * from another contract version, or one filed under the wrong name, is
   * refused loudly rather than reinterpreted, so no company's money is ever
   * read under rules it was not written with.
   */
  async init(): Promise<void> {
    this.files.clear();
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
      const stored = await readJson<StoredAllowance>(path.join(this.root, name), () => {
        throw new Error(`The stored allowance ${name} could not be read.`);
      });
      if (stored.v !== 1 || stored.organizationId !== name.slice(0, -'.json'.length))
        throw new Error(
          `The stored allowance ${name} was written by another build and was left alone.`,
        );
      stored.periods ??= [];
      stored.reservations ??= [];
      stored.settlements ??= [];
      stored.adjustments ??= [];
      this.files.set(stored.organizationId, stored);
    }
  }

  private storedFor(organizationId: string): StoredAllowance {
    let stored = this.files.get(organizationId);
    if (!stored) {
      stored = emptyStored(organizationId);
      this.files.set(organizationId, stored);
    }
    return stored;
  }

  private async persist(organizationId: string, stored: StoredAllowance) {
    await jsonWrite(this.filePath(organizationId), stored);
    this.files.set(organizationId, stored);
  }

  private periodOf(stored: StoredAllowance, periodId: string): AllowancePeriod {
    const period = stored.periods.find((item) => item.periodId === periodId);
    if (!period)
      throw refuse(
        404,
        'That billing period has no allowance here yet. It is allocated when its billing event arrives.',
        'unknown_period',
      );
    return period;
  }

  /**
   * A reservation by id, or nothing. Only this company's file is searched: an
   * id recorded under another company reads as absent here, never as a read
   * of that company's rows.
   */
  private reservationOf(stored: StoredAllowance, reservationId: string): Reservation {
    const found = stored.reservations.find((item) => item.id === reservationId);
    if (!found)
      throw refuse(
        404,
        'That reservation was not found in this company. Check the id, or reserve again.',
        'unknown_reservation',
      );
    return found;
  }

  private settlementOf(stored: StoredAllowance, reservationId: string): SettledCharge | undefined {
    return stored.settlements.find((item) => item.reservationId === reservationId);
  }

  /**
   * Move a reservation through the contract's state table. The table's own
   * wording is the refusal message: it already explains, for example, why an
   * uncertain hold cannot be released, and restating it here would say the
   * same thing twice.
   */
  private move(reservation: Reservation, event: 'settle' | 'release' | 'lose' | 'reconcile' | 'write-off'): Reservation {
    try {
      const state = reservationTransition(reservation.state, event);
      return { ...reservation, state };
    } catch (error) {
      const message = error instanceof Error ? error.message : `A ${reservation.state} reservation cannot be changed that way.`;
      const code = reservation.state === 'uncertain' ? 'uncertain_hold' : 'invalid_transition';
      throw refuse(409, message, code);
    }
  }

  /**
   * Allocate a period's grant, or hand back the recorded one. The period id is
   * the allocation key: a duplicate billing event returns the existing period
   * unchanged, whatever event id it carries, so retrying an invoice never
   * grants twice.
   */
  async allocatePeriod(input: {
    organizationId: string;
    periodId: string;
    planVersion: string;
    rateCardVersion: string;
    grantedMicroUsd: MicroUsd;
    startsAt: string;
    endsAt: string;
    sourceEventId: string;
    at: string;
  }): Promise<AllowancePeriod> {
    const stored = this.storedFor(input.organizationId);
    const existing = stored.periods.find((item) => item.periodId === input.periodId);
    if (existing) return existing;
    const period: AllowancePeriod = {
      organizationId: input.organizationId,
      periodId: input.periodId,
      planVersion: input.planVersion,
      rateCardVersion: input.rateCardVersion,
      grantedMicroUsd: input.grantedMicroUsd,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allocatedAt: input.at,
      sourceEventId: input.sourceEventId,
    };
    stored.periods.push(period);
    await this.persist(input.organizationId, stored);
    return period;
  }

  /**
   * The numbers a person sees. Grants and withdrawals are reported apart:
   * money is non-negative here, so a single net figure could not hold a
   * chargeback larger than the grants against it, and would let a withdrawal
   * happen without ever appearing on this view.
   */
  summary(organizationId: string, periodId: string): AllowanceSummary {
    const stored = this.storedFor(organizationId);
    const period = this.periodOf(stored, periodId);
    const inPeriod = <T extends { periodId: string }>(rows: readonly T[]): T[] =>
      rows.filter((item) => item.periodId === periodId);
    const pending = sumMoney(
      inPeriod(stored.reservations)
        .filter((item) => item.state === 'pending')
        .map((item) => item.maxMicroUsd),
    );
    const uncertain = sumMoney(
      inPeriod(stored.reservations)
        .filter((item) => item.state === 'uncertain')
        .map((item) => item.maxMicroUsd),
    );
    const settled = sumMoney(
      inPeriod(stored.settlements).map((item) => item.allowanceDebitMicroUsd),
    );
    const grants = sumMoney(
      inPeriod(stored.adjustments)
        .filter((item) => item.direction === 'grant')
        .map((item) => item.amountMicroUsd),
    );
    const withdrawals = sumMoney(
      inPeriod(stored.adjustments)
        .filter((item) => item.direction === 'withdraw')
        .map((item) => item.amountMicroUsd),
    );
    // Each bound was enforced when it was written, so this reads rather than
    // decides. A throw here means the file was edited outside the ledger, and
    // refusing to present it is the honest response.
    const funded = sumMoney([period.grantedMicroUsd, grants]);
    const available = subtractMoney(
      subtractMoney(subtractMoney(subtractMoney(funded, withdrawals), settled), pending),
      uncertain,
    );
    return {
      organizationId,
      periodId,
      grantedMicroUsd: period.grantedMicroUsd,
      pendingMicroUsd: pending,
      uncertainMicroUsd: uncertain,
      settledMicroUsd: settled,
      grantsMicroUsd: grants,
      withdrawalsMicroUsd: withdrawals,
      availableMicroUsd: available,
      exhausted: available === 0,
      rateCardVersion: period.rateCardVersion,
    };
  }

  /**
   * Hold a conservative ceiling before a call. Both refusals use 402: the
   * company cannot afford the hold, or the parent task's envelope cannot, and
   * either way the fix involves money rather than retrying an edit. The code
   * names the bound, because the fixes differ — top up the allowance, or raise
   * the envelope.
   */
  async reserve(input: ReserveInput): Promise<Reservation> {
    const stored = this.storedFor(input.organizationId);
    const existing = stored.reservations.find((item) => item.id === input.reservationId);
    if (existing) {
      // An idempotency key replays the same hold; a changed payload under a
      // used key is a conflicting write, not an update. The parent envelope is
      // a bound checked at admission, not a term of the hold, so it is not
      // part of the comparison.
      const same =
        existing.periodId === input.periodId &&
        existing.parentTaskId === input.parentTaskId &&
        existing.kind === input.kind &&
        existing.route === input.route &&
        existing.payer === input.payer &&
        existing.maxMicroUsd === input.maxMicroUsd &&
        existing.rateCardVersion === input.rateCardVersion;
      if (!same)
        throw refuse(
          409,
          'That reservation id is already in use for a different hold. Reserve again with a fresh id.',
          'reservation_conflict',
        );
      return existing;
    }
    this.periodOf(stored, input.periodId);
    const available = this.summary(input.organizationId, input.periodId).availableMicroUsd;
    if (input.maxMicroUsd > available)
      throw refuse(
        402,
        `The company cannot afford a ${formatMoney(input.maxMicroUsd)} hold with only ${formatMoney(available)} left in this period. Settle or release work in flight, or wait for the next period.`,
        'insufficient_allowance',
      );
    if (input.parentTaskId !== null && input.parentEnvelopeMicroUsd !== null) {
      const used = this.parentEnvelopeUsed(input.organizationId, input.parentTaskId);
      if (sumMoney([used, input.maxMicroUsd]) > input.parentEnvelopeMicroUsd)
        throw refuse(
          402,
          `The parent task cannot afford a ${formatMoney(input.maxMicroUsd)} hold inside its ${formatMoney(input.parentEnvelopeMicroUsd)} envelope with ${formatMoney(used)} already held. Settle work under it first, or raise the envelope.`,
          'parent_envelope_exceeded',
        );
    }
    const reservation: Reservation = {
      id: input.reservationId,
      organizationId: input.organizationId,
      periodId: input.periodId,
      parentTaskId: input.parentTaskId,
      kind: input.kind,
      route: input.route,
      payer: input.payer,
      maxMicroUsd: input.maxMicroUsd,
      rateCardVersion: input.rateCardVersion,
      state: 'pending',
      createdAt: input.at,
      resolvedAt: null,
      uncertainReason: null,
    };
    stored.reservations.push(reservation);
    await this.persist(input.organizationId, stored);
    return reservation;
  }

  /**
   * Record what a call actually cost. The hold is exchanged for the debit, so
   * the difference returns to available. Replaying a settlement hands back the
   * recorded charge rather than debiting twice.
   */
  async settle(input: {
    reservationId: string;
    organizationId: string;
    providerCostMicroUsd: MicroUsd;
    allowanceDebitMicroUsd: MicroUsd;
    reconciledFrom: 'response' | 'provider-report';
    at: string;
  }): Promise<SettledCharge> {
    const stored = this.storedFor(input.organizationId);
    const existing = this.settlementOf(stored, input.reservationId);
    if (existing) return existing;
    const reservation = this.reservationOf(stored, input.reservationId);
    if (input.allowanceDebitMicroUsd > reservation.maxMicroUsd)
      throw refuse(
        409,
        `That call settled at ${formatMoney(input.allowanceDebitMicroUsd)}, past its ${formatMoney(reservation.maxMicroUsd)} ceiling. This is a reconciliation problem, not a rounding one.`,
        'settlement_exceeds_reservation',
      );
    const moved = this.move(reservation, 'settle');
    const charge: SettledCharge = {
      reservationId: reservation.id,
      organizationId: reservation.organizationId,
      periodId: reservation.periodId,
      providerCostMicroUsd: input.providerCostMicroUsd,
      allowanceDebitMicroUsd: input.allowanceDebitMicroUsd,
      rateCardVersion: reservation.rateCardVersion,
      eligibility: eligibilityFor(
        reservation.rateCardVersion,
        reservation.kind,
        input.allowanceDebitMicroUsd,
      ),
      settledAt: input.at,
      reconciledFrom: input.reconciledFrom,
    };
    this.replace(stored, { ...moved, resolvedAt: input.at });
    stored.settlements.push(charge);
    await this.persist(input.organizationId, stored);
    return charge;
  }

  /** Release a hold on work that never ran. The money was never spent. */
  async release(reservationId: string, organizationId: string, at: string): Promise<Reservation> {
    const stored = this.storedFor(organizationId);
    const reservation = this.reservationOf(stored, reservationId);
    const moved = this.move(reservation, 'release');
    const released = { ...moved, resolvedAt: at };
    this.replace(stored, released);
    await this.persist(organizationId, stored);
    return released;
  }

  /**
   * Park a hold whose response was lost. The call may well have cost money
   * upstream, so the ceiling stays held until reconciliation says otherwise.
   */
  async markUncertain(
    reservationId: string,
    organizationId: string,
    reason: string,
    at: string,
  ): Promise<Reservation> {
    void at;
    const stored = this.storedFor(organizationId);
    const reservation = this.reservationOf(stored, reservationId);
    const moved = this.move(reservation, 'lose');
    const parked = { ...moved, uncertainReason: reason };
    this.replace(stored, parked);
    await this.persist(organizationId, stored);
    return parked;
  }

  /**
   * Resolve an uncertain hold once the provider's accounting is known. Like
   * settling, replaying hands back the recorded charge.
   */
  async reconcile(input: {
    reservationId: string;
    organizationId: string;
    providerCostMicroUsd: MicroUsd;
    allowanceDebitMicroUsd: MicroUsd;
    at: string;
  }): Promise<SettledCharge> {
    const stored = this.storedFor(input.organizationId);
    const existing = this.settlementOf(stored, input.reservationId);
    if (existing) return existing;
    const reservation = this.reservationOf(stored, input.reservationId);
    if (input.allowanceDebitMicroUsd > reservation.maxMicroUsd)
      throw refuse(
        409,
        `That call reconciled at ${formatMoney(input.allowanceDebitMicroUsd)}, past its ${formatMoney(reservation.maxMicroUsd)} ceiling. This is a reconciliation problem, not a rounding one.`,
        'settlement_exceeds_reservation',
      );
    const moved = this.move(reservation, 'reconcile');
    const charge: SettledCharge = {
      reservationId: reservation.id,
      organizationId: reservation.organizationId,
      periodId: reservation.periodId,
      providerCostMicroUsd: input.providerCostMicroUsd,
      allowanceDebitMicroUsd: input.allowanceDebitMicroUsd,
      rateCardVersion: reservation.rateCardVersion,
      eligibility: eligibilityFor(
        reservation.rateCardVersion,
        reservation.kind,
        input.allowanceDebitMicroUsd,
      ),
      settledAt: input.at,
      reconciledFrom: 'provider-report',
    };
    this.replace(stored, { ...moved, resolvedAt: input.at });
    stored.settlements.push(charge);
    await this.persist(input.organizationId, stored);
    return charge;
  }

  /**
   * Give up on an uncertain hold the provider confirms was never billed. The
   * ceiling returns to available, and the note is kept where the uncertainty
   * was recorded so the ledger still answers why.
   */
  async writeOff(
    reservationId: string,
    organizationId: string,
    note: string,
    at: string,
  ): Promise<Reservation> {
    const stored = this.storedFor(organizationId);
    const reservation = this.reservationOf(stored, reservationId);
    const moved = this.move(reservation, 'write-off');
    const written = { ...moved, resolvedAt: at, uncertainReason: note };
    this.replace(stored, written);
    await this.persist(organizationId, stored);
    return written;
  }

  /**
   * Record a grant or withdrawal as a new event. History is never rewritten:
   * a withdrawal that would take available below zero is refused rather than
   * clamped into an invisible debt.
   */
  async adjust(input: {
    id: string;
    organizationId: string;
    periodId: string;
    reason: AllowanceAdjustment['reason'];
    direction: 'grant' | 'withdraw';
    amountMicroUsd: MicroUsd;
    note: string;
    sourceEventId: string | null;
    at: string;
  }): Promise<AllowanceAdjustment> {
    const stored = this.storedFor(input.organizationId);
    const existing = stored.adjustments.find((item) => item.id === input.id);
    if (existing) {
      const same =
        existing.periodId === input.periodId &&
        existing.reason === input.reason &&
        existing.direction === input.direction &&
        existing.amountMicroUsd === input.amountMicroUsd &&
        existing.note === input.note &&
        existing.sourceEventId === input.sourceEventId;
      if (!same)
        throw refuse(
          409,
          'That adjustment id is already recorded for different terms. Adjust again with a fresh id.',
          'adjustment_conflict',
        );
      return existing;
    }
    this.periodOf(stored, input.periodId);
    if (input.direction === 'withdraw') {
      const available = this.summary(input.organizationId, input.periodId).availableMicroUsd;
      if (input.amountMicroUsd > available)
        throw refuse(
          402,
          `Withdrawing ${formatMoney(input.amountMicroUsd)} would take this period below its ${formatMoney(available)} available. Record a smaller withdrawal instead.`,
          'insufficient_allowance',
        );
    }
    const adjustment: AllowanceAdjustment = {
      id: input.id,
      organizationId: input.organizationId,
      periodId: input.periodId,
      reason: input.reason,
      direction: input.direction,
      amountMicroUsd: input.amountMicroUsd,
      at: input.at,
      note: input.note,
      sourceEventId: input.sourceEventId,
    };
    stored.adjustments.push(adjustment);
    await this.persist(input.organizationId, stored);
    return adjustment;
  }

  reservation(id: string, organizationId: string): Reservation | undefined {
    return this.storedFor(organizationId).reservations.find((item) => item.id === id);
  }

  /**
   * What one parent task currently holds across its children. Calls in flight
   * and calls whose outcome is unknown count at their ceiling; settled calls
   * count at what they actually cost; released and written-off holds count
   * nothing, because their money is back.
   */
  parentEnvelopeUsed(organizationId: string, parentTaskId: string): MicroUsd {
    const stored = this.storedFor(organizationId);
    const children = stored.reservations.filter((item) => item.parentTaskId === parentTaskId);
    const held = children
      .filter((item) => item.state === 'pending' || item.state === 'uncertain')
      .map((item) => item.maxMicroUsd);
    const spent = children
      .filter((item) => item.state === 'settled')
      .map((item) => {
        const charge = this.settlementOf(stored, item.id);
        // Settle writes both rows in one persist, so a settled hold always has
        // its charge. Without one the file was edited outside the ledger, and
        // guessing a number would be the worse response.
        if (!charge)
          throw new Error(
            `Reservation ${item.id} is settled with no recorded charge. The stored allowance was changed outside the ledger.`,
          );
        return charge.allowanceDebitMicroUsd;
      });
    // Released and written-off holds count nothing: their money is back.
    return sumMoney([...held, ...spent]);
  }

  private replace(stored: StoredAllowance, reservation: Reservation) {
    const index = stored.reservations.findIndex((item) => item.id === reservation.id);
    if (index < 0)
      throw refuse(
        404,
        'That reservation was not found in this company. Check the id, or reserve again.',
        'unknown_reservation',
      );
    stored.reservations[index] = reservation;
  }
}
