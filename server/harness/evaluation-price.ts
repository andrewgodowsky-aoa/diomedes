/**
 * What an evaluation costs.
 *
 * This is the first token-to-money table in the product. Until now every figure
 * the allowance ledger saw was supplied by its caller, which is workable while
 * the only callers are tests and unworkable the moment a real provider is
 * charging for real calls.
 *
 * Two rules, and the second is the one that matters:
 *
 * 1. **Integer micro-USD, rounded once.** Rates are held as micro-USD per
 *    million tokens, so the arithmetic is integer multiplication and a single
 *    division. Rounding every token up would turn a 10-token call costing 0.42
 *    micro-USD into 10 — a 24x overcharge invisible at any single call and
 *    ruinous across a month.
 * 2. **Unknown is not zero.** A provider that reported no token count has not
 *    reported a free call, and a model with no published rate has not published
 *    a rate of nothing. Both return `known: false` with a reason, and the caller
 *    must then use the existing uncertain-charge path rather than settle a zero.
 *    A zero on a usage screen has to mean "this was free"; if it can also mean
 *    "we did not measure", it means nothing.
 *
 * Prices are dated and versioned for the reason a rate card is: a charge keeps
 * the terms it was made under. A price change is a new card, never an edit.
 */
import type { MicroUsd } from '../../shared/managed-usage.js';
import { micro } from '../../shared/managed-usage.js';

const PER_MILLION = 1_000_000;

export interface EvaluationPriceCard {
  /** Identifies these exact terms on every charge made under them. */
  readonly version: string;
  readonly effectiveFrom: string;
  /**
   * The exact model these terms price. An alias such as `typesafe-ai/jev` can
   * move to different bytes without notice, so a price is pinned to what the
   * provider actually reported answering, never to the name that was asked for.
   */
  readonly modelId: string;
  readonly inputMicroUsdPerMillion: number;
  readonly outputMicroUsdPerMillion: number;
  /** Where the figures came from, so a stale price is traceable rather than folklore. */
  readonly source: string;
}

/**
 * Jev 1.13, as published on 2026-09-19: $0.042 per million input tokens, with
 * output not charged. Output being free does not make output tokens cease to
 * exist — they still count in any efficiency measurement — it only means they
 * add nothing here.
 */
export const EVALUATION_PRICE_JEV_113: EvaluationPriceCard = Object.freeze({
  version: 'evaluation-price-2026-09-19.1',
  effectiveFrom: '2026-09-19T00:00:00.000Z',
  modelId: 'jev-1.13.0',
  inputMicroUsdPerMillion: 42_000,
  outputMicroUsdPerMillion: 0,
  source: 'https://docs.typesafe.ai/models, read 2026-09-19',
});

/** Every price this build knows, by the model id a provider actually reports. */
export const EVALUATION_PRICES: readonly EvaluationPriceCard[] = Object.freeze([
  EVALUATION_PRICE_JEV_113,
]);

/**
 * The terms for a model the provider says answered, or null when this build has
 * none. Null is a supported answer: it produces an unknown cost, which the
 * ledger already knows how to hold.
 */
export function priceFor(modelId: string | null): EvaluationPriceCard | null {
  if (!modelId) return null;
  return EVALUATION_PRICES.find((card) => card.modelId === modelId) ?? null;
}

export type EvaluationCost =
  | { readonly known: true; readonly microUsd: MicroUsd; readonly priceVersion: string }
  | { readonly known: false; readonly reason: string };

const unknown = (reason: string): EvaluationCost => ({ known: false, reason });

/**
 * One division, rounded up once. `tokens` and `perMillion` are both integers,
 * and their product stays inside the safe range for any call this product will
 * ever admit: even a billion tokens at a dollar per million is 10^15, well under
 * 2^53.
 */
const cost = (tokens: number, perMillion: number): number =>
  perMillion === 0 ? 0 : Math.ceil((tokens * perMillion) / PER_MILLION);

/**
 * What a completed evaluation actually cost.
 *
 * A dimension that is priced at zero does not need to be reported: it cannot
 * change the total, so not knowing it is not a gap. A dimension that is billable
 * and unreported is a real gap, and the whole cost is unknown.
 */
export function evaluationCost(
  card: EvaluationPriceCard | null,
  usage: { inputTokens: number | null; outputTokens: number | null },
): EvaluationCost {
  if (!card)
    return unknown(
      'There is no published price for the model that answered, so the cost is unknown.',
    );
  if (usage.inputTokens === null && card.inputMicroUsdPerMillion !== 0)
    return unknown('The provider did not report input tokens, so the cost is unknown.');
  if (usage.outputTokens === null && card.outputMicroUsdPerMillion !== 0)
    return unknown('The provider did not report output tokens, so the cost is unknown.');
  const input = cost(usage.inputTokens ?? 0, card.inputMicroUsdPerMillion);
  const output = cost(usage.outputTokens ?? 0, card.outputMicroUsdPerMillion);
  return { known: true, microUsd: micro(input + output), priceVersion: card.version };
}

/**
 * What to hold before the call.
 *
 * A reservation is a ceiling, not a forecast: it is computed from the bound the
 * caller will actually enforce on its serialized input, so the settled cost can
 * only be lower. There is no default bound — a caller that cannot say how large
 * its input may be cannot be admitted under a spending cap, which is the same
 * rule the rate card applies to provider-run tools.
 */
export function estimateEvaluationCost(
  card: EvaluationPriceCard | null,
  bound: { maxInputTokens: number; maxOutputTokens?: number },
): EvaluationCost {
  if (!Number.isSafeInteger(bound.maxInputTokens) || bound.maxInputTokens < 0)
    throw new RangeError('An evaluation reservation needs a nonnegative whole token bound.');
  const maxOutput = bound.maxOutputTokens ?? 0;
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 0)
    throw new RangeError('An evaluation reservation needs a nonnegative whole token bound.');
  if (!card)
    return unknown(
      'There is no published price for this evaluation route, so nothing can be reserved for it.',
    );
  return {
    known: true,
    microUsd: micro(
      cost(bound.maxInputTokens, card.inputMicroUsdPerMillion) +
        cost(maxOutput, card.outputMicroUsdPerMillion),
    ),
    priceVersion: card.version,
  };
}
