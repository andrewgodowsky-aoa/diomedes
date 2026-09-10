/**
 * The managed-allowance contract, on its own.
 *
 * These tests hold the arithmetic and the vocabulary before any ledger exists,
 * because every later mistake in this area is one of four kinds: money that
 * drifted through a float, a quantity that got conflated with a different
 * quantity, a charge whose eligibility changed underneath a recorded rate card,
 * or a payer that switched without anyone choosing it.
 *
 * Every figure here is an engineering fixture. The $300/$100 shape is a
 * candidate price under review; nothing in this file makes it sellable, and the
 * plan definition it names is asserted inactive rather than assumed so.
 */
import { describe, expect, test } from 'vitest';
import {
  ALLOWANCE_MEANING,
  MANAGED_PLAN_CANDIDATE,
  RATE_CARD_V1,
  CHARGE_KIND_TEXT,
  chargeKindEligibility,
  chargeKindsBy,
  dollars,
  formatMoney,
  isAdmissibleChargeKind,
  micro,
  payerForRoute,
  reservationTransition,
  subtractMoney,
  sumMoney,
  type ChargeKind,
  type PayerResolution,
  type ReservationState,
} from '../shared/managed-usage.js';

describe('money', () => {
  test('a dollar figure becomes exact integer micro-USD', () => {
    expect(dollars(100)).toBe(100_000_000);
    expect(dollars(0.4)).toBe(400_000);
    expect(dollars(1.5)).toBe(1_500_000);
  });

  test('cent fractions that a float would lose stay exact', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. Three tenths of a dollar,
    // summed as money, is exactly three hundred thousand micro-USD.
    expect(sumMoney([dollars(0.1), dollars(0.2)])).toBe(dollars(0.3));
  });

  test('a figure finer than one micro-USD is refused rather than rounded', () => {
    expect(() => dollars(0.0000001)).toThrow(/micro-USD/i);
  });

  test('a negative amount is refused: an adjustment is an event, not a negative charge', () => {
    expect(() => micro(-1)).toThrow(/negative/i);
  });

  test('subtraction below zero is refused rather than clamped', () => {
    expect(subtractMoney(dollars(2), dollars(1.5))).toBe(dollars(0.5));
    expect(() => subtractMoney(dollars(1), dollars(1.5))).toThrow(/exceeds/i);
  });

  test('money renders as dollars without inventing precision', () => {
    expect(formatMoney(dollars(100))).toBe('$100.00');
    expect(formatMoney(dollars(0.4))).toBe('$0.40');
    expect(formatMoney(micro(1))).toBe('$0.000001');
  });
});

describe('the rate card decides eligibility, not the caller', () => {
  test('upstream inference debits the allowance', () => {
    const included: ChargeKind[] = [
      'generation',
      'billed-reasoning',
      'cache-write',
      'cache-read',
      'embedding',
    ];
    for (const kind of included)
      expect(chargeKindEligibility(RATE_CARD_V1, kind)).toBe('included');
  });

  test('a provider-billed tool service is excluded and not admissible', () => {
    // Doc 05: a route without a reliable cost bound cannot promise a hard cap.
    expect(chargeKindEligibility(RATE_CARD_V1, 'tool-service')).toBe('excluded-not-admitted');
    expect(isAdmissibleChargeKind(RATE_CARD_V1, 'tool-service')).toBe(false);
  });

  test('support and storage are excluded as not inference at all', () => {
    expect(chargeKindEligibility(RATE_CARD_V1, 'support')).toBe('excluded-billed-separately');
    expect(chargeKindEligibility(RATE_CARD_V1, 'storage')).toBe('excluded-billed-separately');
  });

  test('every charge kind is classified: no kind falls through unspoken', () => {
    for (const kind of RATE_CARD_V1.kinds)
      expect(['included', 'excluded-not-admitted', 'excluded-billed-separately']).toContain(
        chargeKindEligibility(RATE_CARD_V1, kind),
      );
  });

  test('the rate card carries its own version so a settled charge can name it', () => {
    expect(RATE_CARD_V1.version).toMatch(/^rate-card-/);
  });

  test('every kind has a label a person could read on a screen', () => {
    for (const kind of RATE_CARD_V1.kinds) {
      expect(CHARGE_KIND_TEXT[kind]).toBeTruthy();
      // Labels appear mid-sentence in a list, so they are lower case and short.
      expect(CHARGE_KIND_TEXT[kind]).toBe(CHARGE_KIND_TEXT[kind].toLowerCase());
      expect(CHARGE_KIND_TEXT[kind].length).toBeLessThan(46);
    }
  });

  test('the kinds group by what they do to the allowance', () => {
    const grouped = chargeKindsBy(RATE_CARD_V1);
    expect(grouped.included).toContain('generation');
    expect(grouped.excluded).toContain('tool-service');
    expect(grouped.excluded).toContain('support');
    // Nothing may be missing from both groups, and nothing may be in both.
    expect(grouped.included.length + grouped.excluded.length).toBe(RATE_CARD_V1.kinds.length);
    for (const kind of grouped.included) expect(grouped.excluded).not.toContain(kind);
  });
});

describe('the plan definition is inactive', () => {
  test('the candidate is not sellable and says why', () => {
    expect(MANAGED_PLAN_CANDIDATE.status).toBe('candidate');
    expect(MANAGED_PLAN_CANDIDATE.sellable).toBe(false);
    expect(MANAGED_PLAN_CANDIDATE.notSellableReason).toMatch(/approv/i);
  });

  test('the candidate carries the price shape without approving it', () => {
    expect(MANAGED_PLAN_CANDIDATE.priceMicroUsd).toBe(dollars(300));
    expect(MANAGED_PLAN_CANDIDATE.includedAllowanceMicroUsd).toBe(dollars(100));
  });

  test('limits nobody has approved are absent rather than guessed', () => {
    const limits = MANAGED_PLAN_CANDIDATE.limits;
    for (const key of ['seats', 'hosts', 'locations', 'supportHours', 'storageGb'] as const)
      expect(limits[key]).toBeNull();
    expect(MANAGED_PLAN_CANDIDATE.limitsReason).toMatch(/approved value/i);
  });

  test('the allowance is described as a debited USD allowance, not as money or tokens', () => {
    expect(ALLOWANCE_MEANING).toMatch(/not withdrawable/i);
    expect(ALLOWANCE_MEANING).toMatch(/not.*token/i);
  });
});

describe('payer resolution never switches silently', () => {
  const managed: PayerResolution = { payer: 'managed', debitsAllowance: true };

  test('a subscription-native company route is paid by the managed allowance', () => {
    expect(payerForRoute({ route: 'codex', organizationRoute: 'managed' })).toEqual(managed);
  });

  test("an organization's own key does not debit the allowance", () => {
    const resolved = payerForRoute({ route: 'codex', organizationRoute: 'byo' });
    expect(resolved.payer).toBe('byo');
    expect(resolved.debitsAllowance).toBe(false);
  });

  test('a local call debits nothing', () => {
    const resolved = payerForRoute({ route: 'ollama', organizationRoute: 'managed' });
    expect(resolved.payer).toBe('local');
    expect(resolved.debitsAllowance).toBe(false);
  });

  test('a personal subscription is refused for organization work rather than resold', () => {
    const resolved = payerForRoute({
      route: 'claude-code',
      organizationRoute: 'personal-subscription',
    });
    expect(resolved.payer).toBe('refused');
    expect(resolved.reason).toMatch(/personal subscription/i);
  });
});

describe('the reservation state machine', () => {
  const step = (from: ReservationState, event: Parameters<typeof reservationTransition>[1]) =>
    reservationTransition(from, event);

  test('a settled call releases nothing it did not hold', () => {
    expect(step('pending', 'settle')).toBe('settled');
  });

  test('an admitted call that never dispatched releases its hold', () => {
    expect(step('pending', 'release')).toBe('released');
  });

  test('a lost response goes uncertain, and uncertain never auto-releases', () => {
    expect(step('pending', 'lose')).toBe('uncertain');
    expect(() => step('uncertain', 'release')).toThrow(/reconcil/i);
  });

  test('an uncertain hold is settled or written off by reconciliation only', () => {
    expect(step('uncertain', 'reconcile')).toBe('settled');
    expect(step('uncertain', 'write-off')).toBe('written-off');
  });

  test('a terminal reservation cannot be moved again', () => {
    for (const terminal of ['settled', 'released', 'written-off'] as ReservationState[])
      expect(() => step(terminal, 'settle')).toThrow(/already/i);
  });
});
