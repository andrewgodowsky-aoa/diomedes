/**
 * The company's private provider-credit position: what our own provider
 * accounts are estimated to cost, what promotions we expect, and what billing
 * has actually confirmed.
 *
 * Three domains stay apart, and this file is only the third:
 *
 * 1. Provider usage and cost evidence: what a call used and what that usage
 *    costs at list price (`shared/usage-contract.ts`, `usageCost`).
 * 2. Customer entitlement, reservation and debit authority: what a customer may
 *    spend, what is held and what came off their allowance
 *    (`shared/managed-usage.ts`, `funding.ts`).
 * 3. The company's provider-credit dashboard (here). It is never customer
 *    facing: no route in `worker.ts` reads it, no customer projection includes
 *    it, and it carries no credential and no provider account identifier.
 *
 * The five figures below are separate numbers that are easy to confuse, and each
 * one is a different fact. A promotion or welcome credit is only ever
 * *expected* until a billing record confirms it was applied: there is no path
 * from an expectation to a confirmation that does not name that evidence.
 */
import {
  micro,
  subtractMoney,
  sumMoney,
  type MicroUsd,
} from '../../../shared/managed-usage.js';

export type CreditSource = 'promotion' | 'welcome-credit' | 'committed-use' | 'other';

/** A provider credit that billing confirmed was applied. The evidence is the point. */
export interface ConfirmedCreditApplication {
  readonly source: CreditSource;
  readonly amountMicroUsd: MicroUsd;
  /** The provider's billing record (invoice line, credit memo) that shows it applied. */
  readonly billingEvidenceRef: string;
  readonly confirmedAt: string;
}

export interface ProviderCreditLine {
  readonly provider: string;
  readonly periodId: string;
  /** Usage evidence priced at list price, before any credit. An estimate. */
  readonly estimatedGrossProviderCostMicroUsd: MicroUsd;
  /** Promotions and welcome credits we expect to apply. Never counted as applied. */
  readonly expectedPromotionsMicroUsd: MicroUsd;
  /** Credits billing has confirmed, each with its evidence. */
  readonly confirmedCreditApplications: readonly ConfirmedCreditApplication[];
  readonly confirmedCreditAppliedMicroUsd: MicroUsd;
  /** Gross less confirmed credit only. Expected promotions never reduce it. */
  readonly estimatedNetProviderCostMicroUsd: MicroUsd;
  /** Confirmed credit beyond this period's gross cost, shown rather than dropped. */
  readonly confirmedCreditBeyondCostMicroUsd: MicroUsd;
  /** What came off customers' allowances. A different fact from what we paid. */
  readonly customerDebitMicroUsd: MicroUsd;
  /** What customers were invoiced. A different fact again. */
  readonly customerInvoiceMicroUsd: MicroUsd;
}

const EVIDENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,199}$/;
const SOURCES: readonly CreditSource[] = ['promotion', 'welcome-credit', 'committed-use', 'other'];

/**
 * Record a credit as applied. Refused without a billing evidence reference:
 * an expected promotion is not an applied one, however certain it looks.
 */
export function confirmCreditApplication(input: {
  source: CreditSource;
  amountMicroUsd: number;
  billingEvidenceRef: string | null | undefined;
  confirmedAt: string;
}): ConfirmedCreditApplication {
  if (!SOURCES.includes(input.source)) throw new RangeError('Name where this credit came from.');
  if (typeof input.billingEvidenceRef !== 'string' || !EVIDENCE.test(input.billingEvidenceRef))
    throw new RangeError(
      'A credit is marked applied only with the billing record that shows it. Keep it as expected until then.',
    );
  if (!Number.isFinite(Date.parse(input.confirmedAt))) throw new RangeError('When billing confirmed it is not readable.');
  return Object.freeze({
    source: input.source,
    amountMicroUsd: micro(input.amountMicroUsd),
    billingEvidenceRef: input.billingEvidenceRef,
    confirmedAt: input.confirmedAt,
  });
}

/**
 * One provider's line for one period. Confirmed credit comes only from
 * confirmed applications. Credit beyond the gross cost is its own figure, so the
 * net is never pushed below zero and never hides a surplus.
 */
export function providerCreditLine(input: {
  provider: string;
  periodId: string;
  estimatedGrossProviderCostMicroUsd: MicroUsd;
  expectedPromotionsMicroUsd: MicroUsd;
  confirmedCreditApplications: readonly ConfirmedCreditApplication[];
  customerDebitMicroUsd: MicroUsd;
  customerInvoiceMicroUsd: MicroUsd;
}): ProviderCreditLine {
  for (const application of input.confirmedCreditApplications)
    if (!EVIDENCE.test(application.billingEvidenceRef))
      throw new RangeError('Every applied credit carries its billing evidence.');
  const confirmed = sumMoney(input.confirmedCreditApplications.map((item) => item.amountMicroUsd));
  return Object.freeze({
    provider: input.provider,
    periodId: input.periodId,
    estimatedGrossProviderCostMicroUsd: input.estimatedGrossProviderCostMicroUsd,
    expectedPromotionsMicroUsd: input.expectedPromotionsMicroUsd,
    confirmedCreditApplications: Object.freeze([...input.confirmedCreditApplications]),
    confirmedCreditAppliedMicroUsd: confirmed,
    estimatedNetProviderCostMicroUsd:
      confirmed > input.estimatedGrossProviderCostMicroUsd
        ? micro(0)
        : subtractMoney(input.estimatedGrossProviderCostMicroUsd, confirmed),
    confirmedCreditBeyondCostMicroUsd:
      confirmed > input.estimatedGrossProviderCostMicroUsd
        ? subtractMoney(confirmed, input.estimatedGrossProviderCostMicroUsd)
        : micro(0),
    customerDebitMicroUsd: input.customerDebitMicroUsd,
    customerInvoiceMicroUsd: input.customerInvoiceMicroUsd,
  });
}
