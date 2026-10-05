/**
 * Shared routing records and pure eligibility checks. Persistence, identity,
 * publication and funded dispatch remain the account service's authorities.
 * Customer preferences implement NC-SETUP-2026-10-02.1 (rows accepted under
 * NC-SETUP-2026-09-27.1 keep that version's rules) and are never staff consent.
 */
import { z } from 'zod';
import { micro, type MicroUsd } from './managed-usage.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const instant = z.iso.datetime();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const rate = z.number().int().min(0).max(1_000_000_000);
const evidenceId = z.string().trim().min(1).max(500);
const country = z.string().regex(/^[A-Z]{2}$/);
/** Recorded for a route whose provider may process anywhere, so no honest country fits (E7). */
export const UNPINNED_REGION = 'ZZ';
export const ROUTING_PROVIDERS = ['aws-bedrock', 'azure-openai', 'google-vertex', 'openrouter'] as const;
export const ROUTING_TIERS = ['efficient', 'focused', 'thorough'] as const;
export const ROUTING_PROFILES = ['lowest-cost', 'balanced', 'strict'] as const;
export const routingScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('organization'), id }),
  z.strictObject({ kind: z.literal('individual'), id }),
]);
export type RoutingScope = z.infer<typeof routingScopeSchema>;
export const accountScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('organization'), id }),
  z.strictObject({ kind: z.literal('individual'), id }),
]);
export function routingScopeKey(scope: RoutingScope): string {
  return scope.kind === 'global' ? 'global' : `${scope.kind}:${scope.id}`;
}

export const HARD_RESTRICTIONS = {
  noTraining: z.boolean(),
  zeroRetention: z.boolean(),
  ingressCountries: z.array(country).min(1).max(250).nullable(),
  processingCountries: z.array(country).min(1).max(250).nullable(),
  allowedConnections: z.array(id).min(1).max(500).nullable(),
  /** Allowed, explicitly documented retention policies. Null is unrestricted, never unknown. */
  retentionPolicies: z.array(id).min(1).max(100).nullable(),
  transientCache: z.enum(['forbid', 'approved']),
};
export const hardRestrictionsSchema = z.strictObject(HARD_RESTRICTIONS);
export type HardRestrictions = z.infer<typeof hardRestrictionsSchema>;
export function mergeSourceRestrictions(...sets: readonly (readonly HardRestrictions[])[]): HardRestrictions[] {
  const unique = new Map<string, HardRestrictions>();
  for (const set of sets) for (const value of set) {
    const parsed = hardRestrictionsSchema.parse(value);
    unique.set(JSON.stringify(parsed), parsed);
  }
  if (unique.size > 32) throw new RangeError('This context has too many distinct source restrictions. Reduce the source scope.');
  return [...unique.values()];
}
export const PRIVATE_RESTRICTIONS: HardRestrictions = {
  noTraining: true, zeroRetention: false, ingressCountries: null,
  processingCountries: null, allowedConnections: null, retentionPolicies: null,
  transientCache: 'forbid',
};
/** US ingress and processing, verified zero retention, no training and no transient provider cache. */
export const STRICT_RESTRICTIONS: HardRestrictions = {
  ...PRIVATE_RESTRICTIONS, zeroRetention: true, ingressCountries: ['US'], processingCountries: ['US'],
};
/** No training is the floor everywhere. Outside Strict, an evidenced transient provider cache is allowed. */
export const NO_TRAINING_RESTRICTIONS: HardRestrictions = { ...PRIVATE_RESTRICTIONS, transientCache: 'approved' };
/** Applies until a global policy publishes its own mandatory floor, which later publications then carry forward. */
export const DEFAULT_MANDATORY_RESTRICTIONS: HardRestrictions = NO_TRAINING_RESTRICTIONS;
/** The floor each profile adds under NC-SETUP-2026-10-02.1 (owner decisions E1 and E5, 2026-10-02). */
export const PROFILE_FLOORS: Readonly<Record<typeof ROUTING_PROFILES[number], HardRestrictions>> = {
  'lowest-cost': NO_TRAINING_RESTRICTIONS, balanced: NO_TRAINING_RESTRICTIONS, strict: STRICT_RESTRICTIONS,
};
/** True when `value` enforces everything `floor` does. Narrower lists and stricter switches pass. */
export function restrictionsCover(value: HardRestrictions, floor: HardRestrictions): boolean {
  const within = (actual: readonly string[] | null, allowed: readonly string[] | null) =>
    allowed === null || (actual !== null && actual.every(x => allowed.includes(x)));
  return (!floor.noTraining || value.noTraining) && (!floor.zeroRetention || value.zeroRetention) &&
    within(value.ingressCountries, floor.ingressCountries) && within(value.processingCountries, floor.processingCountries) &&
    within(value.allowedConnections, floor.allowedConnections) && within(value.retentionPolicies, floor.retentionPolicies) &&
    (floor.transientCache === 'approved' || value.transientCache === 'forbid');
}

/** The setup disclosure a preference was accepted under. Only the current one can be written. */
export const LEGACY_ROUTING_CONSENT = 'NC-SETUP-2026-09-27.1';
export const ROUTING_CONSENT_VERSION = 'NC-SETUP-2026-10-02.1';
const routingExceptionSchema = z.strictObject({
  connectionId: id,
  model: z.string().min(1).max(200),
  ingressCountries: z.array(country).min(1),
  processingCountries: z.array(country).min(1),
  retentionPolicy: id,
  acceptedAt: instant,
  /** Balanced exceptions need approved savings thresholds OR the exact task qualification. */
  savings: z.strictObject({ version: id, relativeBasisPoints: z.number().int().min(0).max(10_000), absoluteMicroUsd: count }).nullable(),
  qualificationId: id.nullable(),
});
export const routingPreferenceSchema = z.strictObject({
  v: z.literal(1),
  scope: accountScopeSchema,
  revision: count,
  profile: z.enum(ROUTING_PROFILES),
  restrictions: hardRestrictionsSchema,
  consentVersion: z.enum([LEGACY_ROUTING_CONSENT, ROUTING_CONSENT_VERSION]),
  acceptedBy: id,
  acceptedAt: instant,
  /** Only rows accepted under 09-27.1 carry exceptions. The current version has none. */
  exceptions: z.array(routingExceptionSchema).max(100),
});
export type RoutingPreference = z.infer<typeof routingPreferenceSchema>;
export const routingPreferenceWriteSchema = routingPreferenceSchema.omit({ v: true, revision: true, acceptedBy: true, acceptedAt: true })
  .extend({ baseRevision: count, acknowledge: z.literal(true),
    consentVersion: z.literal(ROUTING_CONSENT_VERSION), exceptions: z.array(routingExceptionSchema).max(0) });

export const protocolSchema = z.enum(['responses', 'chat-completions', 'converse', 'messages', 'generate-content']);
export type ManagedProtocol = z.infer<typeof protocolSchema>;
const connectionBase = {
  id, revision: count, label: z.string().trim().min(1).max(120),
  /** Names an installed server secret. Never accepted from a customer or returned with its value. */
  secretRef: z.enum(['BEDROCK_API_KEY', 'AZURE_OPENAI_API_KEY', 'VERTEX_ACCESS_TOKEN', 'VERTEX_API_KEY', 'OPENROUTER_API_KEY']),
  payer: z.literal('company'),
  account: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
};
export const providerConnectionSchema = z.discriminatedUnion('provider', [
  z.strictObject({ ...connectionBase, provider: z.literal('aws-bedrock'), secretRef: z.literal('BEDROCK_API_KEY'),
    region: z.string().regex(/^(us|eu|ap|ca|sa|me|af|il|mx)-(?:[a-z]+-)+\d$/),
    endpointFamily: z.enum(['runtime', 'mantle']).default('runtime'),
    allowedProfiles: z.array(z.string().min(1).max(200)).min(1).max(500),
    /** Approved API compatibility for each profile; Responses is not universal. */
    modelProtocols: z.record(z.string(), z.array(protocolSchema).min(1)).default({}) }),
  z.strictObject({ ...connectionBase, provider: z.literal('azure-openai'), secretRef: z.literal('AZURE_OPENAI_API_KEY'),
    resource: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    apiVersion: z.literal('v1'),
    /**
     * Which of the resource's own hosts the gateway addresses. Absent means openai.azure.com. A
     * Foundry resource also answers on services.ai.azure.com, the only host that serves Claude.
     */
    host: z.enum(['openai.azure.com', 'services.ai.azure.com']).optional(),
    deployments: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)).min(1).max(500) }),
  /** A short-lived access token is a bearer for the named project; an API key is sent as x-goog-api-key. */
  z.strictObject({ ...connectionBase, provider: z.literal('google-vertex'), secretRef: z.enum(['VERTEX_ACCESS_TOKEN', 'VERTEX_API_KEY']),
    project: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
    location: z.string().regex(/^(?:global|[a-z]+-[a-z]+\d)$/),
    publisher: z.enum(['google', 'anthropic']) }),
  z.strictObject({ ...connectionBase, provider: z.literal('openrouter'), secretRef: z.literal('OPENROUTER_API_KEY'),
    ingress: z.enum(['global', 'us', 'eu']),
    regionalEntitlement: z.boolean(),
    /** Exact endpoint identities; a broad provider slug cannot replace one. */
    allowedEndpoints: z.array(z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,199}$/)).min(1).max(500),
    /** Provider display names from the endpoint catalogue, keyed by exact endpoint tag. */
    endpointNames: z.record(z.string().max(200), z.string().trim().min(1).max(200)).default({}) }),
]);
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;

const rates = {
  inputMicroUsdPerMillion: rate, outputMicroUsdPerMillion: rate,
  reasoningMicroUsdPerMillion: rate, cacheReadMicroUsdPerMillion: rate, cacheWriteMicroUsdPerMillion: rate,
  requestFeeMicroUsd: rate,
};
export const routingPriceSchema = z.strictObject({
  version: id, observedAt: instant, validUntil: instant, evidence: evidenceId,
  ...rates,
  /** Apply the highest matching threshold to the whole request, including cached input. */
  longContext: z.array(z.strictObject({ aboveInputTokens: count, ...rates })).max(16),
}).superRefine((p, ctx) => {
  if (Date.parse(p.validUntil) <= Date.parse(p.observedAt)) ctx.addIssue({ code: 'custom', message: 'Price expiry must follow observation.' });
  if (new Set(p.longContext.map(b => b.aboveInputTokens)).size !== p.longContext.length) ctx.addIssue({ code: 'custom', message: 'Price thresholds must be distinct.' });
});
export type RoutingPrice = z.infer<typeof routingPriceSchema>;

const effortLevels = <T extends z.ZodType>(value: T) => z.strictObject({ low: value, medium: value, high: value });
/** Protocol-specific controls are qualified configuration, never guessed from a model name. */
export const reasoningConfigurationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('anthropic-budget'), levels: effortLevels(z.number().int().min(1024).max(1_000_000)) }),
  z.strictObject({ kind: z.literal('anthropic-adaptive'), levels: effortLevels(z.enum(['low', 'medium', 'high', 'xhigh', 'max'])) }),
  // Nova's high setting does not admit maxTokens; managed requests always need a hard output bound.
  z.strictObject({ kind: z.literal('nova'), levels: effortLevels(z.enum(['low', 'medium'])) }),
  z.strictObject({ kind: z.literal('gemini-budget'), levels: effortLevels(z.number().int().min(1).max(1_000_000)) }),
  z.strictObject({ kind: z.literal('gemini-level'), levels: effortLevels(z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'])) }),
]);

export const modelBindingSchema = z.strictObject({
  connectionId: id,
  connectionRevision: count,
  protocol: protocolSchema,
  /** Azure uses deployment for addressing, while model names the qualified model/version. */
  deployment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).nullable(),
  modelVersion: z.string().min(1).max(200),
  upstreamEndpoint: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,199}$/).nullable(),
  capabilities: z.strictObject({ contextTokens: count, outputTokens: count, tools: z.boolean(), images: z.boolean(), reasoning: z.boolean() }),
  reasoning: reasoningConfigurationSchema.optional(),
  qualification: z.strictObject({ id, evidence: evidenceId, validUntil: instant,
    tiers: z.array(z.enum(ROUTING_TIERS)).min(1), qualityFloor: z.number().min(0).max(1) }).nullable(),
  access: z.strictObject({ state: z.enum(['unverified', 'ready', 'denied', 'quota-exhausted']),
    evidence: evidenceId, validUntil: instant, availableRequests: count.nullable() }).nullable(),
  privacy: z.strictObject({
    connectionRevision: count, modelVersion: z.string().min(1).max(200), protocol: protocolSchema,
    evidence: evidenceId, validUntil: instant,
    ingressCountries: z.array(country).min(1), decryptionCountries: z.array(country).min(1), processingCountries: z.array(country).min(1),
    retentionPolicy: id, zeroRetention: z.boolean(), training: z.boolean(),
    contentLogging: z.boolean(), caching: z.enum(['off', 'transient']), transientCacheEvidence: evidenceId.nullable(),
    /** Evidence covers every enabled provider feature, not just a provider label. */
    features: z.array(z.enum(['text', 'tools', 'images', 'reasoning'])).min(1),
    allowedRetentionModes: z.array(z.string().min(1).max(100)).max(20),
    effectiveRetentionMode: z.string().min(1).max(100).nullable(),
    regionalEntitlement: z.boolean(),
  }).nullable(),
  health: z.strictObject({ state: z.enum(['unverified', 'healthy', 'degraded', 'open']),
    observedAt: instant, validUntil: instant, cooldownUntil: instant.nullable(), reason: z.string().max(300) }),
  price: routingPriceSchema,
});
export type ModelBinding = z.infer<typeof modelBindingSchema>;
export interface CatalogRoute {
  id: string; provider: typeof ROUTING_PROVIDERS[number]; model: string; status: 'qualified' | 'unqualified' | 'retired';
  revision: number; binding?: ModelBinding;
}

export const tierRoutingSchema = z.strictObject({
  primary: id.nullable(), backups: z.array(id).max(4), fallbackEnabled: z.boolean(),
  maxAttempts: z.number().int().min(1).max(5),
  cost: z.strictObject({ sameOrLower: z.boolean(), maxAttemptMicroUsd: count.nullable(), qualityFloor: z.number().min(0).max(1) }),
}).superRefine((value, ctx) => {
  const ids = [value.primary, ...value.backups].filter((v): v is string => v !== null);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Primary and backups must be distinct.' });
  if (!value.fallbackEnabled && value.maxAttempts !== 1) ctx.addIssue({ code: 'custom', message: 'Disabled fallback permits one attempt.' });
  if (value.maxAttempts > ids.length && ids.length !== 0) ctx.addIssue({ code: 'custom', message: 'Attempts cannot exceed configured routes.' });
  if (value.primary === null && value.backups.length) ctx.addIssue({ code: 'custom', message: 'Backups require a primary.' });
});
export type TierRouting = z.infer<typeof tierRoutingSchema>;

export const routingConfigurationSchema = z.strictObject({
  efficient: tierRoutingSchema, focused: tierRoutingSchema, thorough: tierRoutingSchema,
});
export type RoutingConfiguration = z.infer<typeof routingConfigurationSchema>;
export const scopedPublicationSchema = z.strictObject({
  scope: routingScopeSchema, baseRevision: count, baseGlobalRevision: count,
  /** Null is an explicit reset to inheritance, never a failed/invalid override. */
  routing: routingConfigurationSchema.nullable(), note: z.string().trim().min(1).max(1000),
});
export const scopedRollbackSchema = z.strictObject({
  scope: routingScopeSchema, baseRevision: count, baseGlobalRevision: count,
  toRevision: z.number().int().positive(), note: z.string().trim().min(1).max(1000),
});
export const individualAccountSchema = z.strictObject({
  id, tenantId: id, personId: id, name: z.string().min(1).max(200), state: z.enum(['active', 'disabled']), createdAt: instant,
});
export type IndividualAccount = z.infer<typeof individualAccountSchema>;
export type AccountScope = Exclude<RoutingScope, { kind: 'global' }>;

/** Protocol negotiation is explicit. A model/catalogue edit does not require a desktop rebuild. */
const resolvedTierSchema = z.strictObject({
  entryId: id, entryRevision: count, model: z.string().min(1).max(200), label: z.string().min(1).max(200),
  provider: z.enum(ROUTING_PROVIDERS), price: routingPriceSchema, capabilities: modelBindingSchema.shape.capabilities,
  reasoningSummaries: z.boolean(), guardPrices: z.array(routingPriceSchema).min(1).max(5),
  fallbackEnabled: z.boolean(), maxAttempts: z.number().int().min(1).max(5),
}).nullable();
const exclusionsSchema = z.array(z.strictObject({ routeId: z.string().max(128),
  reasons: z.array(z.strictObject({ code: z.string().max(100), message: z.string().max(1000) })).max(100) })).max(5);
export const resolvedRoutingSnapshotSchema = z.strictObject({
  protocol: z.literal('nectovia-managed/2'), legacy: z.boolean(), canEditPreferences: z.boolean(),
  scope: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('organization'), id }), z.strictObject({ kind: z.literal('individual'), id })]),
  revision: count, globalRevision: count, scopeRevision: count, preferenceRevision: count,
  inherited: z.boolean(), checkedAt: instant, validUntil: instant,
  profile: routingPreferenceSchema.shape.profile.nullable(),
  tiers: z.strictObject({ efficient: resolvedTierSchema, focused: resolvedTierSchema, thorough: resolvedTierSchema }),
  exclusions: z.strictObject({ efficient: exclusionsSchema, focused: exclusionsSchema, thorough: exclusionsSchema }),
});
export type ResolvedRoutingSnapshot = z.infer<typeof resolvedRoutingSnapshotSchema>;
export type RoutingPreferenceWrite = z.infer<typeof routingPreferenceWriteSchema>;

/** Authenticated attempt evidence, kept in the existing runtime model-step output. */
export const routingReceiptSchema = z.strictObject({
  attempts: z.array(z.strictObject({
    attemptId: id, state: z.enum(['pending', 'uncertain', 'settled', 'released', 'written-off']),
    routing: z.strictObject({ scopeKey: z.string().max(150), policyRevision: count, globalRevision: count, scopeRevision: count,
      preferenceRevision: count, requestGroup: id, ordinal: z.number().int().min(1).max(5), fallbackReason: z.string().max(200).nullable(),
      routeId: id, routeRevision: count, provider: z.enum(ROUTING_PROVIDERS), model: z.string().max(200), modelVersion: z.string().max(200),
      deployment: z.string().max(128).nullable(), upstreamEndpoint: z.string().max(200).nullable(),
      connectionId: id, connectionRevision: count, protocol: protocolSchema, priceVersion: id, priceObservedAt: instant, priceValidUntil: instant,
    }).nullable(),
    heldMicroUsd: count, providerCostMicroUsd: count.nullable(), allowanceDebitMicroUsd: count.nullable(),
  })).min(1).max(5),
  allowanceDebitMicroUsd: count, heldMicroUsd: count,
});
export type RoutingReceipt = z.infer<typeof routingReceiptSchema>;

/** Read-only projection of existing model-step receipts for one conversation page. */
export const routingReceiptPageSchema = z.strictObject({
  entries: z.array(z.strictObject({ runId: id, stepId: z.string().min(1).max(200), receipt: routingReceiptSchema })).max(200),
  nextBefore: z.string().min(1).max(400).nullable(),
});
export type RoutingReceiptPage = z.infer<typeof routingReceiptPageSchema>;

export interface RequestEnvelope {
  inputTokens: number; outputTokens: number; tools: boolean; images: boolean; reasoning: boolean;
  /** Provider-native state must remain on the exact model and connection. */
  nativeRouteId: string | null;
}
export type EligibilityReason = { code: string; message: string };
const fresh = (until: string, now: number) => Number.isFinite(Date.parse(until)) && Date.parse(until) > now;
const subset = (actual: readonly string[], allowed: readonly string[] | null) => allowed === null || actual.every(x => allowed.includes(x));
type PrivacyEvidence = NonNullable<ModelBinding['privacy']>;
const countries = (p: PrivacyEvidence) => [...p.ingressCountries, ...(p.decryptionCountries ?? []), ...p.processingCountries];
/** The evidence Strict demands for zero retention, AWS retention modes included. */
function zeroRetentionVerified(p: PrivacyEvidence, connection: ProviderConnection): boolean {
  return p.zeroRetention && !p.contentLogging && (connection.provider !== 'aws-bedrock' ||
    (p.effectiveRetentionMode !== null && p.allowedRetentionModes.includes(p.effectiveRetentionMode) && p.allowedRetentionModes.includes('none')));
}
/** Every recorded country is US, and an OpenRouter route also proves entitled US ingress. */
function pinnedToUs(p: PrivacyEvidence, connection: ProviderConnection): boolean {
  return countries(p).every(c => c === 'US') &&
    (connection.provider !== 'openrouter' || (connection.ingress === 'us' && connection.regionalEntitlement && p.regionalEntitlement));
}

/** A conservative bound: no cache hit assumed, and all output may be billed reasoning. */
export function estimateRouteCost(price: RoutingPrice, envelope: Pick<RequestEnvelope, 'inputTokens' | 'outputTokens'>): MicroUsd {
  if (![envelope.inputTokens, envelope.outputTokens].every(x => Number.isSafeInteger(x) && x >= 0))
    throw new RangeError('A bounded request envelope is required.');
  // The bound is not an actual token count. A shorter request can have a more expensive band.
  const bands = [price, ...price.longContext.filter(b => envelope.inputTokens > b.aboveInputTokens)];
  const input = Math.max(...bands.flatMap(b => [b.inputMicroUsdPerMillion, b.cacheReadMicroUsdPerMillion, b.cacheWriteMicroUsdPerMillion]));
  const output = Math.max(...bands.flatMap(b => [b.outputMicroUsdPerMillion, b.reasoningMicroUsdPerMillion]));
  const scaled = BigInt(envelope.inputTokens) * BigInt(input) + BigInt(envelope.outputTokens) * BigInt(output);
  return micro(Number((scaled + 999_999n) / 1_000_000n) + Math.max(...bands.map(b => b.requestFeeMicroUsd)));
}

/** Validate an adapter's addressing contract without ever accepting a URL from route data. */
export function bindingProblems(route: CatalogRoute, connection: ProviderConnection): EligibilityReason[] {
  const fail = (message: string): EligibilityReason[] => [{ code: 'binding_invalid', message }];
  const b = route.binding;
  if (!b || b.connectionId !== connection.id || b.connectionRevision !== connection.revision || route.provider !== connection.provider)
    return fail('The model binding does not match the approved connection revision.');
  if (!connection.enabled) return fail('The provider connection is disabled.');
  if (b.reasoning && (!b.capabilities.reasoning ||
      (b.reasoning.kind.startsWith('anthropic-') && !['messages', 'converse'].includes(b.protocol)) ||
      (b.reasoning.kind === 'nova' && b.protocol !== 'converse') ||
      (b.reasoning.kind.startsWith('gemini-') && b.protocol !== 'generate-content')))
    return fail('The reasoning configuration does not match this protocol and capability.');
  if (b.capabilities.reasoning && !['responses', 'chat-completions'].includes(b.protocol) && !b.reasoning)
    return fail('This protocol requires a qualified model-specific reasoning configuration.');
  if (connection.provider === 'aws-bedrock') {
    if (!connection.allowedProfiles.includes(route.model)) return fail('This AWS profile has not been approved on this connection.');
    if (!connection.modelProtocols[route.model]?.includes(b.protocol)) return fail('This AWS model has no approved compatibility evidence for the selected API.');
    if (!['responses', 'chat-completions', 'converse', 'messages'].includes(b.protocol)) return fail('This AWS protocol is not supported.');
    if (b.protocol === 'messages' && !/(?:^|\.)anthropic\./.test(route.model)) return fail('AWS Messages requires an Anthropic model.');
    if (b.protocol === 'converse' && connection.endpointFamily !== 'runtime') return fail('Converse requires the Bedrock runtime endpoint.');
  } else if (connection.provider === 'azure-openai') {
    if (!['responses', 'chat-completions', 'messages'].includes(b.protocol) || !b.deployment || !connection.deployments.includes(b.deployment))
      return fail('The Azure deployment or API protocol is not approved.');
    if (b.protocol === 'messages' && (connection.host !== 'services.ai.azure.com' || !/^claude-[a-z0-9][a-z0-9.-]{0,127}$/.test(route.model)))
      return fail('Azure Messages requires a Claude model on the Foundry services host.');
  } else if (connection.provider === 'google-vertex') {
    if ((connection.publisher === 'google' && b.protocol !== 'generate-content') ||
        (connection.publisher === 'anthropic' && b.protocol !== 'messages') || !/^[A-Za-z0-9][A-Za-z0-9@._-]{0,199}$/.test(route.model))
      return fail('The Vertex publisher, model or request format is invalid.');
    if (connection.secretRef === 'VERTEX_API_KEY' && connection.publisher !== 'google')
      return fail('A Vertex API key reaches Google models only. Use an access token for partner models.');
  } else if (b.protocol !== 'chat-completions' || !b.upstreamEndpoint || !b.upstreamEndpoint.includes('/') ||
      !connection.allowedEndpoints.includes(b.upstreamEndpoint) || !connection.endpointNames[b.upstreamEndpoint] ||
      !/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/.test(route.model) || route.model.startsWith('openrouter/'))
    return fail('OpenRouter requires an exact approved downstream endpoint and Chat Completions binding.');
  return [];
}

/** Every restriction is checked independently, so a narrower policy cannot erase a source rule. */
export function routeEligibility(input: {
  route: CatalogRoute; connection: ProviderConnection | undefined; preference: RoutingPreference;
  mandatory: HardRestrictions; sourceRestrictions: readonly HardRestrictions[];
  tier: typeof ROUTING_TIERS[number]; envelope: RequestEnvelope; qualityFloor: number; now: number;
  referenceCost?: MicroUsd;
}): EligibilityReason[] {
  const { route, connection, preference, envelope, now } = input;
  const reasons: EligibilityReason[] = [];
  const reject = (code: string, message: string) => reasons.push({ code, message });
  const b = route.binding;
  if (route.status !== 'qualified') reject('route_unqualified', 'The model route is not qualified.');
  if (!b || !connection) return [...reasons, { code: 'connection_missing', message: 'A current approved provider connection is required.' }];
  reasons.push(...bindingProblems(route, connection));
  if (!b.qualification || !fresh(b.qualification.validUntil, now) || !b.qualification.tiers.includes(input.tier) || b.qualification.qualityFloor < input.qualityFloor)
    reject('quality_unqualified', 'No current qualification meets this task tier and quality floor.');
  if (!b.access || !fresh(b.access.validUntil, now) || b.access.state !== 'ready' || b.access.availableRequests === 0)
    reject(b.access?.state === 'quota-exhausted' || b.access?.availableRequests === 0 ? 'quota_exhausted' : 'access_unverified', 'Account access and available quota are not verified for this model.');
  if (b.health.state !== 'healthy' || !fresh(b.health.validUntil, now) || (b.health.cooldownUntil !== null && fresh(b.health.cooldownUntil, now)))
    reject('endpoint_unavailable', b.health.reason || 'The endpoint needs a successful recovery check.');
  if (!fresh(b.price.validUntil, now) || Date.parse(b.price.observedAt) > now)
    reject('price_stale', 'A current versioned price is required.');
  if (envelope.inputTokens + envelope.outputTokens > b.capabilities.contextTokens || envelope.outputTokens > b.capabilities.outputTokens ||
      (envelope.tools && !b.capabilities.tools) || (envelope.images && !b.capabilities.images) || (envelope.reasoning && !b.capabilities.reasoning))
    reject('capability_missing', 'This route cannot serve the bounded request and enabled features.');
  if (envelope.nativeRouteId !== null && envelope.nativeRouteId !== route.id)
    reject('nonportable_continuation', 'Provider-native continuation state requires its original route. Resume from a portable checkpoint.');
  const privacy = b.privacy;
  const features = ['text', ...(envelope.tools ? ['tools'] : []), ...(envelope.images ? ['images'] : []), ...(envelope.reasoning || b.capabilities.reasoning ? ['reasoning'] : [])];
  if (!privacy || !fresh(privacy.validUntil, now) || privacy.connectionRevision !== connection.revision ||
      privacy.modelVersion !== b.modelVersion || privacy.protocol !== b.protocol || !features.every(f => (privacy.features as string[]).includes(f))) {
    reject('privacy_unverified', 'Privacy evidence is missing, stale or mismatched to this account, model, protocol or feature set.');
    return reasons;
  }
  // The chosen profile's floor applies on top of the stored restrictions, so a stored row can only narrow it.
  const restrictions = [input.mandatory, preference.restrictions, ...input.sourceRestrictions, PROFILE_FLOORS[preference.profile]];
  for (const r of restrictions) {
    if (r.noTraining && privacy.training) reject('training_forbidden', 'An applicable policy forbids model training.');
    if (r.zeroRetention && (!privacy.zeroRetention || privacy.contentLogging)) reject('retention_forbidden', 'This endpoint does not meet the required zero-retention policy.');
    if (!subset(privacy.ingressCountries, r.ingressCountries) || !privacy.decryptionCountries?.length ||
        !subset(privacy.decryptionCountries, r.ingressCountries) || !subset(privacy.processingCountries, r.processingCountries)) {
      if (countries(privacy).includes(UNPINNED_REGION)) reject('geography_unpinned', 'This provider doesn\'t say which country it runs in, and a policy here requires named countries.');
      else reject('geography_forbidden', 'Ingress, decryption or processing geography is unknown or outside the accepted policy.');
    }
    if (r.allowedConnections !== null && !r.allowedConnections.includes(connection.id)) reject('destination_forbidden', 'A source or account rule excludes this destination.');
    if (r.retentionPolicies !== null && !r.retentionPolicies.includes(privacy.retentionPolicy)) reject('retention_policy_forbidden', 'This retention policy was not accepted.');
    if (privacy.caching !== 'off' && (r.transientCache === 'forbid' || !privacy.transientCacheEvidence)) reject('cache_forbidden', 'The enabled cache is not permitted by every applicable policy.');
  }
  const requiresRegion = restrictions.some(r => r.ingressCountries !== null || r.processingCountries !== null);
  if (connection.provider === 'openrouter' && requiresRegion &&
      (!connection.regionalEntitlement || !privacy.regionalEntitlement || connection.ingress === 'global'))
    reject('regional_access_missing', 'OpenRouter regional ingress and account entitlement are required.');
  if (connection.provider === 'aws-bedrock' && restrictions.some(r => r.zeroRetention) &&
      (privacy.effectiveRetentionMode === null || !privacy.allowedRetentionModes.includes(privacy.effectiveRetentionMode) || !privacy.allowedRetentionModes.includes('none')))
    reject('aws_retention_unverified', 'The effective AWS retention mode and model allowed_modes do not establish zero retention.');
  // Only a 09-27.1 Balanced row needs exceptions for a route outside its preferred set.
  const preferred = !privacy.training && zeroRetentionVerified(privacy, connection) && pinnedToUs(privacy, connection);
  if (preference.profile === 'balanced' && preference.consentVersion === LEGACY_ROUTING_CONSENT && !preferred) {
    const cost = estimateRouteCost(b.price, envelope);
    const accepted = preference.exceptions.some(e => {
      if (e.connectionId !== connection.id || e.model !== route.model || e.retentionPolicy !== privacy.retentionPolicy ||
          !subset(privacy.ingressCountries, e.ingressCountries) || !subset(privacy.decryptionCountries, e.ingressCountries) || !subset(privacy.processingCountries, e.processingCountries)) return false;
      if (e.qualificationId !== null && e.qualificationId === b.qualification?.id) return true;
      if (e.savings === null || input.referenceCost === undefined || cost > input.referenceCost) return false;
      const savings = input.referenceCost - cost;
      return savings >= e.savings.absoluteMicroUsd && BigInt(savings) * 10_000n >= BigInt(input.referenceCost) * BigInt(e.savings.relativeBasisPoints);
    });
    if (!accepted) reject('balanced_consent_required', 'This nonpreferred route needs an accepted exception and its savings or task-quality condition.');
  }
  return reasons;
}

export type FailureKind = 'credential' | 'configuration' | 'quota' | 'capacity' | 'health' | 'timeout' | 'invalid-request' | 'privacy' | 'refusal' | 'cancelled';

export interface EligibleCandidate { route: CatalogRoute; connection: ProviderConnection; estimateMicroUsd: MicroUsd }
export function resolveRoutingCandidates(input: {
  policy: TierRouting; routes: readonly CatalogRoute[]; connections: readonly ProviderConnection[];
  preference: RoutingPreference; mandatory: HardRestrictions; sourceRestrictions: readonly HardRestrictions[];
  tier: typeof ROUTING_TIERS[number]; envelope: RequestEnvelope; now: number;
  /** Pin the approved primary price for the entire request, including its backups. */
  referencePrice?: ModelBinding['price'] | null;
}): {
  /** The attempts, in order, capped at the policy's maximum. */
  candidates: EligibleCandidate[];
  /** Every eligible route in the same order before the cap. Recheck a selected route against this list. */
  ranked: EligibleCandidate[];
  excluded: { routeId: string; reasons: EligibilityReason[] }[]; referenceCost: MicroUsd | null;
} {
  const excluded: { routeId: string; reasons: EligibilityReason[] }[] = [];
  const primary = input.routes.find(r => r.id === input.policy.primary);
  const price = input.referencePrice === undefined ? primary?.binding?.price : input.referencePrice;
  const referenceCost = price && fresh(price.validUntil, input.now) && Date.parse(price.observedAt) <= input.now
    ? estimateRouteCost(price, input.envelope) : null;
  const candidates: EligibleCandidate[] = [];
  const routeIds = input.policy.primary === null ? [] : [input.policy.primary, ...(input.policy.fallbackEnabled ? input.policy.backups : [])];
  for (const routeId of routeIds) {
    const route = input.routes.find(r => r.id === routeId);
    if (!route) { excluded.push({ routeId, reasons: [{ code: 'route_missing', message: 'The configured route no longer exists.' }] }); continue; }
    const connection = input.connections.find(c => c.id === route.binding?.connectionId);
    const reasons = routeEligibility({ ...input, route, connection, qualityFloor: input.policy.cost.qualityFloor,
      ...(referenceCost === null ? {} : { referenceCost }) });
    const estimate = route.binding ? estimateRouteCost(route.binding.price, input.envelope) : null;
    if (estimate !== null && input.policy.cost.maxAttemptMicroUsd !== null && estimate > input.policy.cost.maxAttemptMicroUsd)
      reasons.push({ code: 'attempt_cost_limit', message: 'The request exceeds the approved per-attempt cost limit.' });
    if ((input.policy.cost.sameOrLower || input.preference.profile === 'lowest-cost') &&
        (referenceCost === null || (estimate !== null && estimate > referenceCost)))
      reasons.push({ code: 'reference_price_limit', message: 'The bounded request cannot be priced at or below the original approved reference.' });
    if (reasons.length || estimate === null || !connection) excluded.push({ routeId, reasons });
    else candidates.push({ route, connection, estimateMicroUsd: estimate });
  }
  // Lowest cost prices every eligible route, the primary included, and breaks a price tie by privacy.
  // Balanced puts verified zero retention first and pinned US second. Strict keeps the published order.
  // The sort is stable, so remaining ties keep the published order too.
  const privacy = (c: EligibleCandidate) =>
    (zeroRetentionVerified(c.route.binding!.privacy!, c.connection) ? 0 : 2) + (pinnedToUs(c.route.binding!.privacy!, c.connection) ? 0 : 1);
  if (input.preference.profile === 'lowest-cost') candidates.sort((a, b) => a.estimateMicroUsd - b.estimateMicroUsd || privacy(a) - privacy(b));
  else if (input.preference.profile === 'balanced') candidates.sort((a, b) => privacy(a) - privacy(b));
  return { candidates: candidates.slice(0, input.policy.maxAttempts), ranked: candidates, excluded, referenceCost };
}

/** No continuation after visible output or an uncertain external effect. */
export function mayFailOver(input: { enabled: boolean; kind: FailureKind; attempts: number; maxAttempts: number;
  visibleOutput: boolean; uncertainToolEffect: boolean; portableCheckpoint: boolean }): boolean {
  return input.enabled && input.attempts < input.maxAttempts && !input.visibleOutput && !input.uncertainToolEffect && input.portableCheckpoint &&
    ['quota', 'capacity', 'health', 'timeout'].includes(input.kind);
}
