/**
 * The allowance ledger, proven against a real store directory.
 *
 * The claims under test are the ones the brief calls out: a period allocates
 * once however many billing events arrive; a reserve holds against both the
 * organization balance and the parent envelope, and names which bound refused;
 * the same reservation id replays without holding twice while a changed
 * payload conflicts; settling releases the difference exactly once; provider
 * cost and allowance debit stay separate; uncertain money stays held until
 * reconciliation or write-off; children share one parent envelope; adjustments
 * append and never overdraw; companies stay apart; the summary adds up; and a
 * fresh ledger over the same directory reads every number back unchanged.
 *
 * Every company, period and dollar figure is invented. No person is real and
 * no amount was ever charged.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../server/store.js';
import { ApiError } from '../server/paths.js';
import { AllowanceLedger, type ReserveInput } from '../server/managed-usage.js';
import {
  RATE_CARD_V1,
  dollars,
  type AllowanceSummary,
} from '../shared/managed-usage.js';

const AT = '2026-09-10T09:00:00.000Z';
const LATER = '2026-09-10T10:00:00.000Z';
const ORG = 'org_ledger_a';
const OTHER_ORG = 'org_ledger_b';
const PERIOD = '2026-09';
const NEXT_PERIOD = '2026-10';

let root = '';
let store: Store;
let ledger: AllowanceLedger;

async function freshLedger(): Promise<{ store: Store; ledger: AllowanceLedger }> {
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'ledger-'));
  const fresh = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await fresh.init();
  const led = new AllowanceLedger(fresh);
  await led.init();
  return { store: fresh, ledger: led };
}

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  ({ store, ledger } = await freshLedger());
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

const allocate = (
  target: AllowanceLedger = ledger,
  over: Record<string, unknown> = {},
): Promise<import('../shared/managed-usage.js').AllowancePeriod> =>
  target.allocatePeriod({
    organizationId: ORG,
    periodId: PERIOD,
    planVersion: 'plan-2026-09-10.1',
    rateCardVersion: RATE_CARD_V1.version,
    grantedMicroUsd: dollars(2),
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-10-01T00:00:00.000Z',
    sourceEventId: 'evt-first',
    at: AT,
    ...over,
  } as Parameters<AllowanceLedger['allocatePeriod']>[0]);

const reserveInput = (over: Partial<ReserveInput> = {}): ReserveInput => ({
  reservationId: 'res_1',
  organizationId: ORG,
  periodId: PERIOD,
  parentTaskId: null,
  kind: 'generation',
  route: 'codex',
  payer: 'managed',
  maxMicroUsd: dollars(1.5),
  rateCardVersion: RATE_CARD_V1.version,
  parentEnvelopeMicroUsd: null,
  at: AT,
  ...over,
});

/** Run a call that must refuse, and hand back the refusal. */
const refusal = async (call: Promise<unknown>): Promise<ApiError> => {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('The call was expected to refuse, but it succeeded.');
};

const summaryOf = (
  target: AllowanceLedger = ledger,
  organizationId = ORG,
  periodId = PERIOD,
): AllowanceSummary => target.summary(organizationId, periodId);

describe('period allocation', () => {
  test('allocates once, however many billing events arrive', async () => {
    const first = await allocate();
    // A duplicate event carries a different id and even a different grant;
    // the recorded period is unchanged and no second grant appears.
    const second = await allocate(ledger, {
      grantedMicroUsd: dollars(99),
      sourceEventId: 'evt-duplicate',
      at: LATER,
    });
    expect(second).toEqual(first);
    expect(summaryOf().grantedMicroUsd).toEqual(dollars(2));
    expect(summaryOf().availableMicroUsd).toEqual(dollars(2));
  });
});

describe('reserving against both bounds', () => {
  test('admits exactly one of two oversized holds and names the organization bound', async () => {
    await allocate();
    await ledger.reserve(reserveInput({ reservationId: 'res_1' }));
    // Both bounds refuse with 402; the code says which one. A hold that the
    // company cannot afford is a question of money, not of conflicting edits,
    // so it reads as payment-required rather than as a version conflict.
    const refused = await refusal(
      ledger.reserve(reserveInput({ reservationId: 'res_2', at: LATER })),
    );
    expect(refused.status).toBe(402);
    expect(refused.details.code).toBe('insufficient_allowance');
    expect(refused.message).toMatch(/cannot afford/i);
    // The refusal held nothing: a dollar-fifty is still held, not three.
    expect(summaryOf().pendingMicroUsd).toEqual(dollars(1.5));
  });

  test('names the parent envelope as a different bound with its own fix', async () => {
    await allocate(ledger, { grantedMicroUsd: dollars(10) });
    await ledger.reserve(
      reserveInput({ reservationId: 'res_1', parentTaskId: 'task_1', parentEnvelopeMicroUsd: dollars(2) }),
    );
    const refused = await refusal(
      ledger.reserve(
        reserveInput({
          reservationId: 'res_2',
          parentTaskId: 'task_1',
          parentEnvelopeMicroUsd: dollars(2),
          at: LATER,
        }),
      ),
    );
    expect(refused.status).toBe(402);
    expect(refused.details.code).toBe('parent_envelope_exceeded');
    expect(refused.message).toMatch(/envelope/i);
  });
});

describe('idempotency', () => {
  test('replays the same id without holding twice', async () => {
    await allocate();
    const first = await ledger.reserve(reserveInput());
    const second = await ledger.reserve(reserveInput({ at: LATER }));
    expect(second).toEqual(first);
    expect(summaryOf().pendingMicroUsd).toEqual(dollars(1.5));
  });

  test('refuses a different payload under a used id', async () => {
    await allocate();
    await ledger.reserve(reserveInput());
    const conflict = await refusal(
      ledger.reserve(reserveInput({ maxMicroUsd: dollars(0.5), at: LATER })),
    );
    expect(conflict.status).toBe(409);
  });
});

describe('settling', () => {
  test('releases the difference and settles exactly once', async () => {
    await allocate();
    await ledger.reserve(reserveInput());
    expect(summaryOf().availableMicroUsd).toEqual(dollars(0.5));
    const settled = await ledger.settle({
      reservationId: 'res_1',
      organizationId: ORG,
      providerCostMicroUsd: dollars(0.4),
      allowanceDebitMicroUsd: dollars(0.4),
      reconciledFrom: 'response',
      at: LATER,
    });
    expect(settled.allowanceDebitMicroUsd).toEqual(dollars(0.4));
    const after = summaryOf();
    expect(after.pendingMicroUsd).toEqual(dollars(0));
    expect(after.settledMicroUsd).toEqual(dollars(0.4));
    // A dollar-ten of hold came back: two dollars less forty cents spent.
    expect(after.availableMicroUsd).toEqual(dollars(1.6));
    // Settling again hands back the recorded settlement, not a second debit.
    const replayed = await ledger.settle({
      reservationId: 'res_1',
      organizationId: ORG,
      providerCostMicroUsd: dollars(0.4),
      allowanceDebitMicroUsd: dollars(0.4),
      reconciledFrom: 'response',
      at: LATER,
    });
    expect(replayed).toEqual(settled);
    expect(summaryOf().availableMicroUsd).toEqual(dollars(1.6));
  });

  test('keeps provider cost and allowance debit separate', async () => {
    await allocate();
    await ledger.reserve(reserveInput());
    // A BYO call costs the provider forty cents and the allowance nothing.
    await ledger.settle({
      reservationId: 'res_1',
      organizationId: ORG,
      providerCostMicroUsd: dollars(0.4),
      allowanceDebitMicroUsd: dollars(0),
      reconciledFrom: 'response',
      at: LATER,
    });
    const after = summaryOf();
    expect(after.settledMicroUsd).toEqual(dollars(0));
    // The whole hold came back: available is untouched by the provider cost.
    expect(after.availableMicroUsd).toEqual(dollars(2));
  });
});

describe('uncertainty', () => {
  test('holds uncertain money until reconciliation, never releasing it', async () => {
    await allocate();
    await ledger.reserve(reserveInput());
    await ledger.markUncertain('res_1', ORG, 'No response arrived; the call may still be billed.', LATER);
    const held = summaryOf();
    expect(held.pendingMicroUsd).toEqual(dollars(0));
    expect(held.uncertainMicroUsd).toEqual(dollars(1.5));
    expect(held.availableMicroUsd).toEqual(dollars(0.5));
    // Releasing an uncertain hold would let a possibly-billed call be retried
    // for free, so the state machine refuses and its reason is surfaced.
    const refused = await refusal(ledger.release('res_1', ORG, LATER));
    expect(refused.status).toBe(409);
    expect(refused.message).toMatch(/reconcil/i);
    // Reconciliation settles what actually happened.
    await ledger.reconcile({
      reservationId: 'res_1',
      organizationId: ORG,
      providerCostMicroUsd: dollars(0.4),
      allowanceDebitMicroUsd: dollars(0.4),
      at: LATER,
    });
    const after = summaryOf();
    expect(after.uncertainMicroUsd).toEqual(dollars(0));
    expect(after.settledMicroUsd).toEqual(dollars(0.4));
    expect(after.availableMicroUsd).toEqual(dollars(1.6));
  });

  test('writes off with a reason and returns the money', async () => {
    await allocate();
    await ledger.reserve(reserveInput());
    await ledger.markUncertain('res_1', ORG, 'No response arrived.', LATER);
    const written = await ledger.writeOff('res_1', ORG, 'Provider confirms nothing was billed.', LATER);
    expect(written.state).toBe('written-off');
    expect(written.uncertainReason).toMatch(/nothing was billed/i);
    const after = summaryOf();
    expect(after.uncertainMicroUsd).toEqual(dollars(0));
    expect(after.settledMicroUsd).toEqual(dollars(0));
    expect(after.availableMicroUsd).toEqual(dollars(2));
  });
});

describe('parent envelopes', () => {
  test('children share one envelope and use is reported live', async () => {
    await allocate(ledger, { grantedMicroUsd: dollars(10) });
    const envelope = dollars(2);
    await ledger.reserve(
      reserveInput({ reservationId: 'child_1', parentTaskId: 'task_1', parentEnvelopeMicroUsd: envelope, maxMicroUsd: dollars(0.6) }),
    );
    await ledger.reserve(
      reserveInput({ reservationId: 'child_2', parentTaskId: 'task_1', parentEnvelopeMicroUsd: envelope, maxMicroUsd: dollars(0.6), at: LATER }),
    );
    // Pending holds count at their ceiling while in flight.
    expect(ledger.parentEnvelopeUsed(ORG, 'task_1')).toEqual(dollars(1.2));
    const refused = await refusal(
      ledger.reserve(
        reserveInput({ reservationId: 'child_3', parentTaskId: 'task_1', parentEnvelopeMicroUsd: envelope, maxMicroUsd: dollars(1), at: LATER }),
      ),
    );
    expect(refused.details.code).toBe('parent_envelope_exceeded');
    // Settling shrinks that child's share to what was actually spent.
    await ledger.settle({
      reservationId: 'child_1',
      organizationId: ORG,
      providerCostMicroUsd: dollars(0.1),
      allowanceDebitMicroUsd: dollars(0.1),
      reconciledFrom: 'response',
      at: LATER,
    });
    expect(ledger.parentEnvelopeUsed(ORG, 'task_1')).toEqual(dollars(0.7));
  });
});

describe('adjustments', () => {
  test('appends grants and refuses a withdrawal past zero', async () => {
    await allocate();
    await ledger.adjust({
      id: 'adj_grant',
      organizationId: ORG,
      periodId: PERIOD,
      reason: 'service-grant',
      direction: 'grant',
      amountMicroUsd: dollars(1),
      note: 'Goodwill after the delayed report.',
      sourceEventId: null,
      at: LATER,
    });
    expect(summaryOf().availableMicroUsd).toEqual(dollars(3));
    expect(summaryOf().grantsMicroUsd).toEqual(dollars(1));
    await ledger.adjust({
      id: 'adj_withdraw',
      organizationId: ORG,
      periodId: PERIOD,
      reason: 'chargeback',
      direction: 'withdraw',
      amountMicroUsd: dollars(0.5),
      note: 'Card transaction reversed.',
      sourceEventId: null,
      at: LATER,
    });
    expect(summaryOf().availableMicroUsd).toEqual(dollars(2.5));
    // A withdrawal past zero is refused, not clamped into an invisible debt.
    const refused = await refusal(
      ledger.adjust({
        id: 'adj_overdraw',
        organizationId: ORG,
        periodId: PERIOD,
        reason: 'chargeback',
        direction: 'withdraw',
        amountMicroUsd: dollars(99),
        note: 'Too much.',
        sourceEventId: null,
        at: LATER,
      }),
    );
    expect(refused.status).toBe(402);
    expect(summaryOf().availableMicroUsd).toEqual(dollars(2.5));
  });

  test('leaves past periods alone', async () => {
    await allocate();
    await ledger.reserve(reserveInput());
    await ledger.settle({
      reservationId: 'res_1',
      organizationId: ORG,
      providerCostMicroUsd: dollars(0.4),
      allowanceDebitMicroUsd: dollars(0.4),
      reconciledFrom: 'response',
      at: LATER,
    });
    const before = summaryOf();
    await ledger.allocatePeriod({
      organizationId: ORG,
      periodId: NEXT_PERIOD,
      planVersion: 'plan-2026-09-10.1',
      rateCardVersion: RATE_CARD_V1.version,
      grantedMicroUsd: dollars(5),
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-11-01T00:00:00.000Z',
      sourceEventId: 'evt-october',
      at: LATER,
    });
    await ledger.adjust({
      id: 'adj_october',
      organizationId: ORG,
      periodId: NEXT_PERIOD,
      reason: 'upgrade',
      direction: 'grant',
      amountMicroUsd: dollars(5),
      note: 'Mid-cycle upgrade for October.',
      sourceEventId: null,
      at: LATER,
    });
    expect(summaryOf()).toEqual(before);
    expect(summaryOf(ledger, ORG, NEXT_PERIOD).availableMicroUsd).toEqual(dollars(10));
  });
});

describe('tenant separation', () => {
  test('a reservation id means nothing outside its company', async () => {
    await allocate();
    await ledger.reserve(reserveInput({ reservationId: 'shared_id' }));
    // The same id in another company is simply absent there.
    expect(ledger.reservation('shared_id', OTHER_ORG)).toBeUndefined();
    const missing = await refusal(
      ledger.settle({
        reservationId: 'shared_id',
        organizationId: OTHER_ORG,
        providerCostMicroUsd: dollars(0.1),
        allowanceDebitMicroUsd: dollars(0.1),
        reconciledFrom: 'response',
        at: LATER,
      }),
    );
    // Not found, never a cross-tenant read: the error must not confirm the
    // other company's id exists.
    expect(missing.status).toBe(404);
    expect(missing.message).not.toMatch(/org_ledger_a/);
  });
});

describe('summary arithmetic', () => {
  test('adds up and reports exhaustion at exactly zero', async () => {
    await allocate();
    await ledger.reserve(reserveInput({ maxMicroUsd: dollars(2) }));
    const empty = summaryOf();
    expect(empty.grantedMicroUsd).toEqual(dollars(2));
    expect(empty.pendingMicroUsd).toEqual(dollars(2));
    expect(empty.uncertainMicroUsd).toEqual(dollars(0));
    expect(empty.settledMicroUsd).toEqual(dollars(0));
    expect(empty.availableMicroUsd).toEqual(dollars(0));
    expect(empty.exhausted).toBe(true);
    await ledger.release('res_1', ORG, LATER);
    const freed = summaryOf();
    expect(freed.availableMicroUsd).toEqual(dollars(2));
    expect(freed.exhausted).toBe(false);
  });
});

describe('durability', () => {
  test('a fresh ledger over the same directory reads every number back', async () => {
    await allocate(ledger, { grantedMicroUsd: dollars(10) });
    await ledger.reserve(
      reserveInput({ reservationId: 'keep_1', parentTaskId: 'task_1', parentEnvelopeMicroUsd: dollars(2) }),
    );
    await ledger.reserve(reserveInput({ reservationId: 'keep_2', at: LATER }));
    await ledger.settle({
      reservationId: 'keep_2',
      organizationId: ORG,
      providerCostMicroUsd: dollars(0.4),
      allowanceDebitMicroUsd: dollars(0.4),
      reconciledFrom: 'response',
      at: LATER,
    });
    await ledger.adjust({
      id: 'adj_keep',
      organizationId: ORG,
      periodId: PERIOD,
      reason: 'service-grant',
      direction: 'grant',
      amountMicroUsd: dollars(1),
      note: 'Kept across restarts.',
      sourceEventId: null,
      at: LATER,
    });
    const before = summaryOf();
    const dataDir = (store as unknown as { dataDir: string }).dataDir;
    const next = new Store(dataDir, path.join(root, 'projects'));
    await next.init();
    const revived = new AllowanceLedger(next);
    await revived.init();
    expect(revived.summary(ORG, PERIOD)).toEqual(before);
    expect(revived.reservation('keep_1', ORG)).toEqual(ledger.reservation('keep_1', ORG));
    expect(revived.parentEnvelopeUsed(ORG, 'task_1')).toEqual(
      ledger.parentEnvelopeUsed(ORG, 'task_1'),
    );
  });
});

/**
 * Added after review of the first pass.
 *
 * `adjustmentsMicroUsd` totalled grants alone, because the money type cannot
 * hold a negative and a net figure would throw on a chargeback larger than the
 * grants. The reasoning was right and the resulting view was not: a person
 * reading one adjustments figure could not tell that money had also been taken
 * back. Two figures, each non-negative, say what one could not.
 */
describe('a withdrawal is visible, not merely subtracted', () => {
  test('grants and withdrawals are reported apart', async () => {
    await allocate();
    await ledger.adjust({
      id: 'adj_grant',
      organizationId: ORG,
      periodId: PERIOD,
      reason: 'service-grant',
      direction: 'grant',
      amountMicroUsd: dollars(20),
      note: 'Goodwill after an outage.',
      sourceEventId: null,
      at: AT,
    });
    await ledger.adjust({
      id: 'adj_back',
      organizationId: ORG,
      periodId: PERIOD,
      reason: 'chargeback',
      direction: 'withdraw',
      amountMicroUsd: dollars(5),
      note: 'A disputed payment was reversed.',
      sourceEventId: null,
      at: LATER,
    });

    const summary = ledger.summary(ORG, PERIOD);
    expect(summary.grantsMicroUsd).toBe(dollars(20));
    expect(summary.withdrawalsMicroUsd).toBe(dollars(5));
    // The one figure that could hide a withdrawal is gone.
    expect((summary as unknown as Record<string, unknown>).adjustmentsMicroUsd).toBeUndefined();
  });
});
