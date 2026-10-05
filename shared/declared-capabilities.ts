/**
 * Capability facts a cited source declares, per route and model (DIO-215). A fact is here only
 * when a page the owner can open states it, and it carries that page as its evidence. Everything
 * else reads as not known: nothing is inferred from a model's name. In this build only Kimi K3 on
 * the direct AWS route declares anything; Luna on AWS and every Azure deployment declare nothing.
 */
import { AWS_KIMI_K3 } from './model-api.js';
import type { CapabilityFact, DeclaredCapabilities } from './route-capabilities.js';

/** The one source the Kimi K3 facts below were read from. */
export const KIMI_K3_MODEL_CARD =
  'AWS Bedrock model card for Kimi K3, https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k3.html, read 2026-10-05';

/** Kimi K3's context window as its model card states it; the context record reads the same number. */
export const KIMI_K3_CONTEXT_TOKENS = 1_000_000;

const fromModelCard = <T>(value: T): CapabilityFact<T> => ({
  value,
  source: 'declared',
  evidence: KIMI_K3_MODEL_CARD,
});

/**
 * Kimi K3 on the direct AWS route, as its model card states it. The card names explicit prompt
 * caching on both Chat Completions and Responses, and a minimum of 1,024 tokens per cache
 * checkpoint. It does not state an output limit, parallel tool calls or reasoning, so those are
 * left out and read as not known.
 */
const KIMI_K3: DeclaredCapabilities = Object.freeze({
  contextTokens: fromModelCard(KIMI_K3_CONTEXT_TOKENS),
  tools: fromModelCard(true),
  structuredOutput: fromModelCard(true),
  images: fromModelCard(true),
  explicitPrefix: fromModelCard(true),
  minimumCacheTokens: fromModelCard(1_024),
});

/** What a cited source declares for one route and model. Empty when nothing is declared. */
export function declaredCapabilities(route: string, model: string): DeclaredCapabilities {
  if (route === 'aws-bedrock' && model === AWS_KIMI_K3.model) return KIMI_K3;
  return {};
}
