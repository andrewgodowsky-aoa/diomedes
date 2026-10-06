/**
 * The desktop's job estimate and local guard under tier pricing (Model B). The account service's
 * routing snapshot carries the tier's charge in the price fields an installed desktop already reads,
 * so the rate card the desktop builds from it, and the estimate built from that card, count credits.
 * No provider price reaches the desktop. Every price here is synthetic.
 */
import { describe, expect, it } from 'vitest';
import { chargeAsRoutingPrice, chargeSnapshot, type CreditPriceTable } from '../shared/credit-prices.js';
import { resolvedRoutingSnapshotSchema, type ResolvedRoutingSnapshot } from '../shared/routing-policy.js';
import { estimateJob } from '../shared/job-caps.js';
import { nectoviaRateCard } from '../server/engines/nectovia.js';
import { jobRatesOf } from '../server/job-cap-routes.js';

const charge = { inputMicroUsdPerMillion: 3_000_000, outputMicroUsdPerMillion: 7_000_000, cacheReadMicroUsdPerMillion: 300_000,
  cacheWriteMicroUsdPerMillion: 4_000_000, requestFeeMicroUsd: 50 };
const table: CreditPriceTable = { v: 1, version: 3, ceilingMicroUsdPerCredit: 40_000, note: 'Synthetic.', publishedAt: '2026-10-05T00:00:00.000Z',
  publishedBy: 'person_staff', tiers: { efficient: charge, focused: charge, thorough: null } };

function snapshot(maxAttempts: number): ResolvedRoutingSnapshot {
  const validUntil = new Date(Date.now() + 60_000).toISOString();
  const price = chargeAsRoutingPrice(chargeSnapshot(table, 'efficient')!, table.publishedAt, validUntil);
  const tier = { entryId: 'route-a', entryRevision: 1, model: 'synthetic-model', label: 'Synthetic', provider: 'azure-openai' as const, price,
    capabilities: { contextTokens: 100_000, outputTokens: 4_096, tools: true, images: false, reasoning: false },
    reasoningSummaries: false, guardPrices: [price], fallbackEnabled: maxAttempts > 1, maxAttempts };
  return { protocol: 'nectovia-managed/2', legacy: false, canEditPreferences: false, scope: { kind: 'organization', id: 'org_1' },
    revision: 2, globalRevision: 2, scopeRevision: 0, preferenceRevision: 1, inherited: true, checkedAt: new Date().toISOString(), validUntil,
    profile: 'balanced', tiers: { efficient: tier, focused: null, thorough: null },
    exclusions: { efficient: [], focused: [], thorough: [{ routeId: '', reasons: [{ code: 'tier_unpriced', message: 'This tier has no credit price right now.' }] }] } };
}

describe('the desktop estimate under tier pricing', () => {
  it('reads a snapshot carrying the charge with the schema an installed desktop parses', () => {
    expect(resolvedRoutingSnapshotSchema.safeParse(snapshot(1)).success).toBe(true);
  });

  it('estimates from the tier charge, across every attempt the tier permits', () => {
    for (const attempts of [1, 2]) {
      const resolved = snapshot(attempts);
      const card = nectoviaRateCard('synthetic-model', { revision: 2, tiers: { efficient: { model: 'synthetic-model', label: 'Synthetic' }, focused: null, thorough: null }, resolved });
      expect(jobRatesOf(card)).toEqual({ input: 3_000_000 * attempts, output: 7_000_000 * attempts, cacheRead: 300_000 * attempts, cacheWrite: 4_000_000 * attempts });
      expect(card.requestFeeMicroUsd).toBe(50 * attempts);
      const estimate = estimateJob({ tier: 'efficient', metering: 'metered', rates: jobRatesOf(card), shape: {
        inputBytes: 4_000, messages: 1, maxOutputTokensPerStep: 1_000, maxSteps: 1, maxRequestBytes: 262_144, toolResultBytesPerStep: 0 } });
      expect(estimate.kind).toBe('estimate');
      if (estimate.kind !== 'estimate') return;
      // One step at its bound: the input bound at the dearest input-side charge and the output bound at the output charge.
      const bound = 4_000 + 1_024 + 16;
      expect(estimate.worstMicroUsd).toBe(Math.ceil((bound * 4_000_000 * attempts + 1_000 * 7_000_000 * attempts) / 1_000_000));
    }
  });
});
