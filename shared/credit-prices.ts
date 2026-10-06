/**
 * Credit prices by tier ("Model B", 2026-10-05).
 *
 * A credit is priced by tier, never by route. Each tier has a charge: credits per
 * million tokens for fresh input, output, cache reads and cache writes, with an
 * optional reasoning price (output's otherwise), an optional per-request price and
 * optional long-context bands. A call's debit is its tokens times its tier's charge,
 * through the same `usageCost` that prices a provider's rate snapshot, so a charge has
 * exactly the `RateSnapshot` price fields. Its amounts are ledger units: 100,000 units
 * are one credit (`CREDIT_MICRO_USD`), so a charge of 100,000 per million tokens is one
 * credit per million tokens.
 *
 * The provider's own price is still recorded beside every settled call, and never
 * debited. A route may serve a tier only when, for every token class, every band and the
 * request fee, its provider price is at most the ceiling (micro-USD of provider cost per
 * credit charged) times the tier's charge.
 *
 * Staff publish the table, versioned, into the account service's database. This module
 * holds only the shapes and the arithmetic: no price, ceiling or target is written here,
 * and the public repository never carries one. Tests and the faux cloud use obviously
 * synthetic values.
 */
import { z } from 'zod';
import { CREDIT_MICRO_USD, JOB_TIERS, MAX_MONEY_MICRO_USD, micro, type JobTier, type MicroUsd, type RateSnapshot } from './managed-usage.js';
import type { RoutingPrice } from './routing-policy.js';

/** The price fields of a rate snapshot: what a ceiling check and `usageCost` read. */
export type PriceFields = Omit<RateSnapshot, 'version' | 'routing'>;

type Band = Omit<PriceFields, 'longContext'>;

/** One tier's charge, in ledger units per million tokens (the request fee in ledger units). */
export type TierCharge = PriceFields;

/**
 * The charge an attempt was held under, stored on the attempt beside the provider's rate
 * snapshot. `version` names the table version and the tier, so a receipt never changes.
 */
export interface ChargeSnapshot extends Omit<RateSnapshot, 'routing'> {
  readonly tier: JobTier;
  readonly tableVersion: number;
  readonly ceilingMicroUsdPerCredit: number;
}

const units = z.number().int().min(0).max(1_000_000_000);
const threshold = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const bandSchema = z.strictObject({
  aboveInputTokens: threshold,
  inputMicroUsdPerMillion: units,
  outputMicroUsdPerMillion: units,
  cacheReadMicroUsdPerMillion: units,
  cacheWriteMicroUsdPerMillion: units,
  reasoningMicroUsdPerMillion: units.optional(),
  requestFeeMicroUsd: units.optional(),
});

/** A tier's charge as staff publish it. Whole ledger units only; input and output are never free. */
export const tierChargeSchema = z.strictObject({
  inputMicroUsdPerMillion: units,
  outputMicroUsdPerMillion: units,
  cacheReadMicroUsdPerMillion: units,
  cacheWriteMicroUsdPerMillion: units,
  reasoningMicroUsdPerMillion: units.optional(),
  requestFeeMicroUsd: units.optional(),
  longContext: z.array(bandSchema).max(16).optional(),
}).superRefine((charge, ctx) => {
  if (charge.inputMicroUsdPerMillion === 0 || charge.outputMicroUsdPerMillion === 0)
    ctx.addIssue({ code: 'custom', message: 'A tier charges for input and output.' });
  const bands = charge.longContext ?? [];
  if (new Set(bands.map(b => b.aboveInputTokens)).size !== bands.length)
    ctx.addIssue({ code: 'custom', message: 'Long-context thresholds must be distinct.' });
  if (bands.some(b => b.inputMicroUsdPerMillion === 0 || b.outputMicroUsdPerMillion === 0))
    ctx.addIssue({ code: 'custom', message: 'A long-context band charges for input and output.' });
});

/**
 * The ceiling, in micro-USD of provider cost per credit charged. It can never exceed
 * `CREDIT_MICRO_USD`: a hold in ledger units must stay an upper bound on the provider cost
 * of the call it holds, because the company spend ceiling adds pending holds to settled
 * provider cost (`FundingTransaction.companySpend`).
 */
export const ceilingSchema = z.number().int().min(1).max(CREDIT_MICRO_USD);

const tiersSchema = z.strictObject({
  efficient: tierChargeSchema.nullable(),
  focused: tierChargeSchema.nullable(),
  thorough: tierChargeSchema.nullable(),
});

/** One published version of the price table. Versions are immutable; a change is a new version. */
export const creditPriceTableSchema = z.strictObject({
  v: z.literal(1),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  ceilingMicroUsdPerCredit: ceilingSchema,
  /** A tier with no charge is refused by name (`tier_unpriced`), never priced from another tier. */
  tiers: tiersSchema,
  note: z.string().trim().min(1).max(1000),
  publishedAt: z.iso.datetime(),
  publishedBy: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
});
export type CreditPriceTable = z.infer<typeof creditPriceTableSchema>;

/** What staff send to publish a version. `baseVersion` is the version they read (0 for none). */
export const publishCreditPricesInput = z.strictObject({
  baseVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  ceilingMicroUsdPerCredit: ceilingSchema,
  tiers: tiersSchema,
  note: z.string().trim().min(1).max(1000),
});
export type PublishCreditPricesInput = z.infer<typeof publishCreditPricesInput>;

/** The charge one tier is held and debited under, or null when the table or the tier has no price. */
export function chargeSnapshot(table: CreditPriceTable | null | undefined, tier: JobTier): ChargeSnapshot | null {
  const charge = table?.tiers[tier];
  if (!table || !charge) return null;
  return {
    version: `credit-prices:${table.version}:${tier}`,
    tier,
    tableVersion: table.version,
    ceilingMicroUsdPerCredit: table.ceilingMicroUsdPerCredit,
    inputMicroUsdPerMillion: charge.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: charge.outputMicroUsdPerMillion,
    cacheReadMicroUsdPerMillion: charge.cacheReadMicroUsdPerMillion,
    cacheWriteMicroUsdPerMillion: charge.cacheWriteMicroUsdPerMillion,
    ...(charge.reasoningMicroUsdPerMillion === undefined ? {} : { reasoningMicroUsdPerMillion: charge.reasoningMicroUsdPerMillion }),
    ...(charge.requestFeeMicroUsd === undefined ? {} : { requestFeeMicroUsd: charge.requestFeeMicroUsd }),
    ...(charge.longContext?.length ? { longContext: charge.longContext.map(b => ({ ...b })) } : {}),
  };
}

/**
 * A tier's charge in the shape the desktop's routing snapshot carries a price in
 * (`resolvedRoutingSnapshotSchema`: `price` and `guardPrices`). Since tier pricing, those fields
 * carry the charge, in ledger units, never a provider's price: the desktop's local guard and its job
 * estimate count credits, and no provider price leaves the account service. The shape is kept so a
 * desktop already installed reads it unchanged. Reasoning and the request fee are written out as
 * `usageCost` reads them (output's price, and nothing, when unset).
 */
export function chargeAsRoutingPrice(charge: ChargeSnapshot, observedAt: string, validUntil: string): RoutingPrice {
  const prices = (band: Band) => ({
    inputMicroUsdPerMillion: band.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: band.outputMicroUsdPerMillion,
    reasoningMicroUsdPerMillion: band.reasoningMicroUsdPerMillion ?? band.outputMicroUsdPerMillion,
    cacheReadMicroUsdPerMillion: band.cacheReadMicroUsdPerMillion,
    cacheWriteMicroUsdPerMillion: band.cacheWriteMicroUsdPerMillion,
    requestFeeMicroUsd: band.requestFeeMicroUsd ?? 0,
  });
  return {
    version: charge.version, observedAt, validUntil, evidence: `Credit price table version ${charge.tableVersion}`,
    ...prices(charge),
    longContext: (charge.longContext ?? []).map(b => ({ aboveInputTokens: b.aboveInputTokens, ...prices(b) })),
  };
}

// --- the ceiling ----------------------------------------------------------------------------

export const TOKEN_CLASSES = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'requestFee'] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];

const CLASS_LABEL: Readonly<Record<TokenClass, string>> = {
  input: 'fresh input', output: 'output', reasoning: 'reasoning', cacheRead: 'cache reads', cacheWrite: 'cache writes', requestFee: 'the per-request fee',
};
const TIER_LABEL: Readonly<Record<JobTier, string>> = { efficient: 'Efficient', focused: 'Focused', thorough: 'Thorough' };

/** The band `usageCost` would price a request of `inputTokens` at: the highest threshold below it, else the base. */
function bandAt(price: PriceFields, inputTokens: number): Band {
  return [...(price.longContext ?? [])].sort((a, b) => b.aboveInputTokens - a.aboveInputTokens)
    .find(b => inputTokens > b.aboveInputTokens) ?? price;
}

function classPrice(band: Band, tokenClass: TokenClass): number {
  switch (tokenClass) {
    case 'input': return band.inputMicroUsdPerMillion;
    case 'output': return band.outputMicroUsdPerMillion;
    case 'reasoning': return band.reasoningMicroUsdPerMillion ?? band.outputMicroUsdPerMillion;
    case 'cacheRead': return band.cacheReadMicroUsdPerMillion;
    case 'cacheWrite': return band.cacheWriteMicroUsdPerMillion;
    case 'requestFee': return band.requestFeeMicroUsd ?? 0;
  }
}

/** One token class, in one band, where a route costs more than the ceiling allows for a tier. */
export interface CeilingFailure {
  readonly tier: JobTier;
  readonly routeId: string;
  readonly tokenClass: TokenClass;
  /** The band's lower bound: null for the base band, else the threshold the band starts above. */
  readonly aboveInputTokens: number | null;
  readonly message: string;
}

/**
 * Every place a route's provider price exceeds the ceiling times a tier's charge. Each class is
 * compared in each band region: the base, and the region above every threshold from both band
 * lists, because either list can change which price applies. Integers only:
 * `provider × CREDIT_MICRO_USD ≤ ceiling × charge`.
 */
export function ceilingFailures(input: {
  tier: JobTier; routeId: string; price: PriceFields; charge: TierCharge; ceilingMicroUsdPerCredit: number;
}): CeilingFailure[] {
  const { tier, routeId, price, charge } = input;
  const ceiling = BigInt(input.ceilingMicroUsdPerCredit);
  const thresholds = [...new Set([...(price.longContext ?? []), ...(charge.longContext ?? [])].map(b => b.aboveInputTokens))].sort((a, b) => a - b);
  const regions: (number | null)[] = [null, ...thresholds];
  const failures: CeilingFailure[] = [];
  for (const region of regions) {
    const at = region === null ? 0 : region + 1;
    const provider = bandAt(price, at), charged = bandAt(charge, at);
    for (const tokenClass of TOKEN_CLASSES) {
      if (BigInt(classPrice(provider, tokenClass)) * BigInt(CREDIT_MICRO_USD) <= ceiling * BigInt(classPrice(charged, tokenClass))) continue;
      const where = region === null ? '' : ` above ${region.toLocaleString('en-US')} input tokens`;
      failures.push({ tier, routeId, tokenClass, aboveInputTokens: region,
        message: `Route ${routeId} costs more than the ceiling allows for the ${TIER_LABEL[tier]} tier's ${CLASS_LABEL[tokenClass]}${where}.` });
    }
  }
  return failures;
}

/** The first ceiling failure for a route and a tier, or ok. */
export function checkCeiling(input: Parameters<typeof ceilingFailures>[0]): { ok: true } | { ok: false; failure: CeilingFailure } {
  const failures = ceilingFailures(input);
  return failures.length ? { ok: false, failure: failures[0] } : { ok: true };
}

// --- holds and display ----------------------------------------------------------------------

/**
 * The hold for one call under a charge: every input token the bound allows at the dearest
 * input-side price (fresh input, cache write or cache read), the output bound at the dearer of
 * output and reasoning, rounded up once, plus the request fee. Taken in the dearest band the
 * input bound can reach, so no usage inside the bounds can cost more than the hold.
 */
export function chargeHold(charge: TierCharge, inputBound: number, outputBound: number): MicroUsd {
  const bands: Band[] = [charge, ...(charge.longContext ?? []).filter(b => inputBound > b.aboveInputTokens)];
  let most = 0n;
  for (const band of bands) {
    const inputRate = BigInt(Math.max(band.inputMicroUsdPerMillion, band.cacheWriteMicroUsdPerMillion, band.cacheReadMicroUsdPerMillion));
    const outputRate = BigInt(Math.max(band.outputMicroUsdPerMillion, band.reasoningMicroUsdPerMillion ?? band.outputMicroUsdPerMillion));
    const amount = (BigInt(inputBound) * inputRate + BigInt(outputBound) * outputRate + 999_999n) / 1_000_000n + BigInt(band.requestFeeMicroUsd ?? 0);
    if (amount > most) most = amount;
  }
  if (most > BigInt(MAX_MONEY_MICRO_USD)) throw new RangeError('That hold cannot be priced exactly.');
  return micro(Number(most));
}

/**
 * Provider cost per credit charged, in whole micro-USD, rounded up: for Operations' cost per
 * credit by tier, route and week. Null when nothing was charged.
 */
export function providerCostPerCredit(providerCostMicroUsd: number, chargedUnits: number): number | null {
  if (!Number.isSafeInteger(providerCostMicroUsd) || providerCostMicroUsd < 0 || !Number.isSafeInteger(chargedUnits) || chargedUnits < 0)
    throw new RangeError('Provider cost and charge are whole, non-negative amounts.');
  if (chargedUnits === 0) return null;
  const scaled = BigInt(providerCostMicroUsd) * BigInt(CREDIT_MICRO_USD);
  return Number((scaled + BigInt(chargedUnits) - 1n) / BigInt(chargedUnits));
}

export { JOB_TIERS as CREDIT_PRICE_TIERS };
