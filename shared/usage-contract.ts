/**
 * `nectovia-usage/1`: the one shape provider usage takes once it crosses into
 * Nectovia, and the one function that decides whether a report fits it.
 *
 * Every route maps its provider's own usage fields into these five counts, and
 * then calls `normalizeUsage` exactly once. Every ledger (the funded parent-job
 * ledger in the control plane, the local spend-exposure ledger, the allowance
 * reserve) prices only what `normalizeUsage` returned as `known`. Nothing else
 * converts between meanings, because there is only one meaning:
 *
 *   inputTokens       every input token, cached or not
 *   cacheReadTokens   the part of inputTokens read back from the provider's cache
 *   cacheWriteTokens  the part of inputTokens written to the provider's cache
 *   outputTokens      every output token, reasoning included
 *   reasoningTokens   the part of outputTokens the provider reports as reasoning
 *
 * so fresh input is `inputTokens - cacheReadTokens - cacheWriteTokens`, and
 * reasoning is priced once, as the output it is part of. Before this contract the
 * funded ledger read `inputTokens` as fresh input and charged cached tokens
 * twice; `usageCost` in `shared/managed-usage.ts` now subtracts the cache parts.
 *
 * Three rules:
 *
 * 1. **Missing is unknown, never zero.** A report with no usage, or with a count
 *    absent, is `unknown`. A ledger keeps the hold at its ceiling until the
 *    provider's accounting says what happened.
 * 2. **Wrong is refused, never clamped.** A negative, fractional or unsafe
 *    count, parts that exceed their whole, or a field this contract does not
 *    define is `refused`, with the reason. Nothing is repaired, because every
 *    repair is a guess about money.
 * 3. **Nothing is lost.** The provider's own usage object travels beside the
 *    counts as `raw`: opaque JSON evidence, never read to price anything.
 *
 * Mapping notes for routes (reconciled with the Vertex route, 2026-09-23):
 * Vertex `usageMetadata` maps as input = promptTokenCount (+ toolUsePromptTokenCount),
 * cacheRead = cachedContentTokenCount, cacheWrite = 0, output = candidatesTokenCount
 * + thoughtsTokenCount, reasoning = thoughtsTokenCount. OpenAI-style Responses map
 * input_tokens, input_tokens_details.cached_tokens, output_tokens and
 * output_tokens_details.reasoning_tokens directly: their totals already include
 * the parts.
 *
 * This file is provider usage evidence only. Whether a customer is entitled to
 * spend, what is reserved and what is debited is `shared/managed-usage.ts`; the
 * company's own provider-credit position is the control plane's private
 * `provider-credits.ts`. The three are never one record.
 */

export const USAGE_CONTRACT_ID = 'nectovia-usage/1' as const;
export type UsageContractId = typeof USAGE_CONTRACT_ID;

export const USAGE_COUNT_FIELDS = [
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
] as const;
export type UsageCountField = (typeof USAGE_COUNT_FIELDS)[number];

/** A ceiling on any one count. A report past it is refused as implausible, not trimmed. */
export const MAX_TOKENS_PER_FIELD = 50_000_000;
/** A ceiling on the raw evidence carried beside the counts, serialized. */
export const MAX_RAW_USAGE_BYTES = 16_384;

/** The five counts, in the meanings above. */
export type UsageCounts = { readonly [field in UsageCountField]: number };

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
/** The provider's usage object as it arrived. Evidence only; nothing prices from it. */
export type RawUsageEvidence = { readonly [key: string]: JsonValue };

export interface NormalizedUsage extends UsageCounts {
  readonly contract: UsageContractId;
  readonly raw: RawUsageEvidence | null;
}

export type UsageEvidence =
  | { readonly state: 'known'; readonly usage: NormalizedUsage }
  | { readonly state: 'unknown'; readonly reason: string; readonly raw: RawUsageEvidence | null }
  | { readonly state: 'refused'; readonly reason: string; readonly raw: RawUsageEvidence | null };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (isPlainObject(value)) return Object.values(value).every((item) => isJson(item, depth + 1));
  return false;
}

/** Raw evidence as it will be kept, or a reason it cannot be. */
function rawOf(value: unknown): { raw: RawUsageEvidence | null } | { reason: string } {
  if (value === undefined || value === null) return { raw: null };
  if (!isPlainObject(value) || !isJson(value))
    return { reason: 'The raw usage evidence is not a plain JSON object.' };
  const text = JSON.stringify(value);
  // Serialized UTF-8 bytes, not UTF-16 units. TextEncoder, because the client bundles this module.
  if (new TextEncoder().encode(text).byteLength > MAX_RAW_USAGE_BYTES)
    return { reason: 'The raw usage evidence is too large to keep.' };
  return { raw: JSON.parse(text) as RawUsageEvidence };
}

/**
 * The single boundary. `counts` is the route's mapping into the five fields
 * (it may also carry `contract`, which must be this one, and `raw`); `raw`, when
 * given separately, is the provider's own usage object.
 */
export function normalizeUsage(counts: unknown, raw?: unknown): UsageEvidence {
  const embedded = isPlainObject(counts) ? counts.raw : undefined;
  const evidence = rawOf(raw !== undefined ? raw : embedded);
  const keptRaw = 'raw' in evidence ? evidence.raw : null;
  if ('reason' in evidence) return { state: 'refused', reason: evidence.reason, raw: null };
  if (counts === undefined || counts === null)
    return { state: 'unknown', reason: 'The provider reported no usage.', raw: keptRaw };
  if (!isPlainObject(counts))
    return { state: 'refused', reason: 'The usage report is not a set of counts.', raw: keptRaw };
  for (const key of Object.keys(counts))
    if (key !== 'contract' && key !== 'raw' && !(USAGE_COUNT_FIELDS as readonly string[]).includes(key))
      return { state: 'refused', reason: `The usage report has a field this contract does not define: ${key}.`, raw: keptRaw };
  if (counts.contract !== undefined && counts.contract !== USAGE_CONTRACT_ID)
    return { state: 'refused', reason: `The usage report follows ${String(counts.contract)}, not ${USAGE_CONTRACT_ID}.`, raw: keptRaw };
  for (const field of USAGE_COUNT_FIELDS)
    if (counts[field] === undefined || counts[field] === null)
      return { state: 'unknown', reason: `The usage report has no ${field}, so what it cost is not known.`, raw: keptRaw };
  for (const field of USAGE_COUNT_FIELDS) {
    const count = counts[field];
    if (typeof count !== 'number' || !Number.isSafeInteger(count))
      return { state: 'refused', reason: `${field} is not a whole number of tokens.`, raw: keptRaw };
    if (count < 0) return { state: 'refused', reason: `${field} is negative.`, raw: keptRaw };
    if (count > MAX_TOKENS_PER_FIELD)
      return { state: 'refused', reason: `${field} is larger than any one call can report.`, raw: keptRaw };
  }
  const usage = counts as unknown as UsageCounts;
  if (usage.cacheReadTokens + usage.cacheWriteTokens > usage.inputTokens)
    return {
      state: 'refused',
      reason: 'Cache reads and writes are part of the input, so together they cannot exceed it.',
      raw: keptRaw,
    };
  if (usage.reasoningTokens > usage.outputTokens)
    return { state: 'refused', reason: 'Reasoning is part of the output, so it cannot exceed it.', raw: keptRaw };
  return {
    state: 'known',
    usage: Object.freeze({
      contract: USAGE_CONTRACT_ID,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      raw: keptRaw,
    }),
  };
}

/** Input tokens that were neither read from nor written to the cache. */
export function freshInputTokens(usage: UsageCounts): number {
  const fresh = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  if (!Number.isSafeInteger(fresh) || fresh < 0)
    throw new RangeError('Cache parts exceed the input they are part of; this usage was never normalized.');
  return fresh;
}

/** The counts alone, for comparing two reports of the same call. */
export function sameUsageCounts(a: UsageCounts, b: UsageCounts): boolean {
  return USAGE_COUNT_FIELDS.every((field) => a[field] === b[field]);
}

/** A stored record that already carries this contract's shape. */
export function isNormalizedUsage(value: unknown): value is NormalizedUsage {
  if (!isPlainObject(value) || value.contract !== USAGE_CONTRACT_ID) return false;
  const again = normalizeUsage(
    Object.fromEntries(USAGE_COUNT_FIELDS.map((field) => [field, value[field]])),
    value.raw ?? null,
  );
  return again.state === 'known';
}
