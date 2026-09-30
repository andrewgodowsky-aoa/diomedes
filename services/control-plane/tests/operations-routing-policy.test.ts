import { describe, expect, it } from 'vitest';
import {
  PRIVATE_RESTRICTIONS, STRICT_RESTRICTIONS, bindingProblems, estimateRouteCost, mayFailOver,
  providerConnectionSchema, resolveRoutingCandidates, routeEligibility, routingPreferenceSchema,
  routingScopeKey, tierRoutingSchema, type CatalogRoute, type ModelBinding, type ProviderConnection,
  type RequestEnvelope, type RoutingPreference, type TierRouting,
} from '../../../shared/routing-policy.js';

const now = Date.parse('2026-09-28T00:00:00Z');
const expires = '2026-09-29T00:00:00Z';
const observed = '2026-09-27T00:00:00Z';
const connection: ProviderConnection = {
  id: 'aws-company', revision: 1, label: 'Synthetic AWS connection', provider: 'aws-bedrock',
  secretRef: 'BEDROCK_API_KEY', payer: 'company', account: 'fixture-account', enabled: true,
  region: 'us-east-1', endpointFamily: 'runtime', allowedProfiles: ['us.test.model'], modelProtocols: { 'us.test.model': ['converse'] },
};
function binding(): ModelBinding {
  return {
    connectionId: connection.id, connectionRevision: 1, protocol: 'converse', deployment: null,
    modelVersion: 'test-model-v1', upstreamEndpoint: null,
    capabilities: { contextTokens: 100_000, outputTokens: 10_000, tools: true, images: false, reasoning: true },
    reasoning: { kind: 'nova', levels: { low: 'low', medium: 'medium', high: 'medium' } },
    qualification: { id: 'fixture-q1', evidence: 'Synthetic only', validUntil: expires, tiers: ['efficient'], qualityFloor: 0.9 },
    access: { state: 'ready', evidence: 'Synthetic only', validUntil: expires, availableRequests: 1 },
    privacy: { connectionRevision: 1, modelVersion: 'test-model-v1', protocol: 'converse', evidence: 'Synthetic only',
      validUntil: expires, ingressCountries: ['US'], decryptionCountries: ['US'], processingCountries: ['US'], retentionPolicy: 'fixture-zdr',
      zeroRetention: true, training: false, contentLogging: false, caching: 'off', transientCacheEvidence: null,
      features: ['text', 'tools', 'reasoning'], allowedRetentionModes: ['none', 'default'], effectiveRetentionMode: 'none', regionalEntitlement: false },
    health: { state: 'healthy', observedAt: observed, validUntil: expires, cooldownUntil: null, reason: '' },
    price: { version: 'fixture-price-1', observedAt: observed, validUntil: expires, evidence: 'Synthetic only',
      inputMicroUsdPerMillion: 100_000, outputMicroUsdPerMillion: 200_000, reasoningMicroUsdPerMillion: 200_000,
      cacheReadMicroUsdPerMillion: 10_000, cacheWriteMicroUsdPerMillion: 125_000, requestFeeMicroUsd: 0, longContext: [] },
  };
}
function route(id = 'primary'): CatalogRoute {
  return { id, provider: 'aws-bedrock', model: 'us.test.model', revision: 1, status: 'qualified', binding: binding() };
}
const preference: RoutingPreference = {
  v: 1, scope: { kind: 'organization', id: 'org-a' }, revision: 1, profile: 'strict', restrictions: { ...PRIVATE_RESTRICTIONS },
  consentVersion: 'NC-SETUP-2026-09-27.1', acceptedBy: 'owner-a', acceptedAt: observed, exceptions: [],
};
const envelope: RequestEnvelope = { inputTokens: 1000, outputTokens: 100, tools: true, images: false, reasoning: true, nativeRouteId: null };
const policy: TierRouting = { primary: 'primary', backups: ['backup'], fallbackEnabled: true, maxAttempts: 2,
  cost: { sameOrLower: true, qualityFloor: 0.8, maxAttemptMicroUsd: null } };
const check = (r: CatalogRoute, p = preference) => routeEligibility({ route: r, connection, preference: p,
  mandatory: PRIVATE_RESTRICTIONS, sourceRestrictions: [], tier: 'efficient', envelope, qualityFloor: 0.8, now });
const resolve = (routes: CatalogRoute[], p = preference) => resolveRoutingCandidates({ routes, connections: [connection], policy,
  preference: p, mandatory: PRIVATE_RESTRICTIONS, sourceRestrictions: [], tier: 'efficient', envelope, now });

describe('account-scoped routing eligibility', () => {
  it('keeps two organizations and one Individual distinct even with the same identifier', () => {
    expect(new Set([routingScopeKey({ kind: 'organization', id: 'a' }), routingScopeKey({ kind: 'organization', id: 'b' }),
      routingScopeKey({ kind: 'individual', id: 'a' })]).size).toBe(3);
    expect(routingPreferenceSchema.safeParse({ ...preference, scope: { kind: 'global' } }).success).toBe(false);
  });
  it('accepts qualifying AWS evidence under Strict', () => expect(check(route())).toEqual([]));
  it.each(['primary', 'backup'])('excludes retaining %s before any dispatch', id => {
    const r = route(id); r.binding!.privacy!.zeroRetention = false;
    const result = resolve([id === 'primary' ? r : route(), id === 'backup' ? r : route('backup')]);
    expect(result.excluded.find(x => x.routeId === id)?.reasons.map(x => x.code)).toContain('retention_forbidden');
  });
  it('does not turn a US model developer into proof of US serving geography', () => {
    const r = route(); r.binding!.privacy!.processingCountries = ['DE'];
    expect(check(r).map(x => x.code)).toContain('geography_forbidden');
  });
  it('rejects stale, wrong-account and feature-mismatched privacy evidence', () => {
    for (const mutate of [
      (b: ModelBinding) => { b.privacy!.validUntil = observed; },
      (b: ModelBinding) => { b.privacy!.connectionRevision = 2; },
      (b: ModelBinding) => { b.privacy!.features = ['text']; },
    ]) { const r = route(); mutate(r.binding!); expect(check(r).map(x => x.code)).toContain('privacy_unverified'); }
  });
  it('does not infer AWS ZDR from store:false or an unverified allowed mode', () => {
    const r = route(); r.binding!.privacy!.allowedRetentionModes = ['aws_review'];
    r.binding!.privacy!.effectiveRetentionMode = 'aws_review';
    expect(check(r).map(x => x.code)).toContain('aws_retention_unverified');
  });
  it('keeps an AWS model permitting none eligible under a compatible inherited mode', () => {
    const r = route(); r.binding!.privacy!.effectiveRetentionMode = 'default';
    expect(check(r)).toEqual([]);
  });
  it('preserves source restrictions during Lowest cost selection', () => {
    const r = route(); r.binding!.privacy!.processingCountries = ['CA'];
    const result = routeEligibility({ route: r, connection, preference: { ...preference, profile: 'lowest-cost' },
      mandatory: PRIVATE_RESTRICTIONS, sourceRestrictions: [STRICT_RESTRICTIONS], tier: 'efficient', envelope, qualityFloor: 0.8, now });
    expect(result.map(x => x.code)).toContain('geography_forbidden');
  });
  it('excludes a cheaper route without task qualification', () => {
    const r = route('backup'); r.binding!.qualification = null; r.binding!.price.inputMicroUsdPerMillion = 0;
    expect(resolve([route(), r], { ...preference, profile: 'lowest-cost' }).candidates.map(x => x.route.id)).toEqual(['primary']);
  });
  it('distinguishes zero model quota from healthy provider status', () => {
    const r = route(); r.binding!.access!.availableRequests = 0;
    expect(check(r).map(x => x.code)).toEqual(['quota_exhausted']);
  });
  it('requires an explicit Balanced exception without inventing savings thresholds', () => {
    const r = route(); r.binding!.privacy!.processingCountries = ['CA'];
    const p: RoutingPreference = { ...preference, profile: 'balanced' };
    expect(check(r, p).map(x => x.code)).toContain('balanced_consent_required');
    p.exceptions = [{ connectionId: connection.id, model: r.model, ingressCountries: ['US'], processingCountries: ['CA'],
      retentionPolicy: 'fixture-zdr', acceptedAt: observed, savings: null, qualificationId: 'fixture-q1' }];
    expect(check(r, p)).toEqual([]);
  });
  it('does not let an accepted exception weaken mandatory no-training', () => {
    const r = route(); r.binding!.privacy!.training = true;
    expect(check(r, { ...preference, profile: 'lowest-cost' }).map(x => x.code)).toContain('training_forbidden');
  });
  it('excludes native state on an incompatible backup', () => {
    const result = resolveRoutingCandidates({ routes: [route(), route('backup')], connections: [connection], policy,
      preference, mandatory: PRIVATE_RESTRICTIONS, sourceRestrictions: [], tier: 'efficient', now,
      envelope: { ...envelope, nativeRouteId: 'primary' } });
    expect(result.candidates.map(x => x.route.id)).toEqual(['primary']);
    expect(result.excluded[0].reasons.map(x => x.code)).toContain('nonportable_continuation');
  });
});

describe('price and failover bounds', () => {
  it('prices cache writes, reasoning, long context and per-request fees in the reference comparison', () => {
    const r = route('backup');
    r.binding!.price.inputMicroUsdPerMillion = 1;
    r.binding!.price.longContext = [{ aboveInputTokens: 900, inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1,
      cacheReadMicroUsdPerMillion: 1, cacheWriteMicroUsdPerMillion: 1_000_000, reasoningMicroUsdPerMillion: 2_000_000, requestFeeMicroUsd: 50 }];
    expect(estimateRouteCost(r.binding!.price, envelope)).toBe(1250);
    expect(resolve([route(), r]).excluded[0].reasons.map(x => x.code)).toContain('reference_price_limit');
  });
  it('refuses a stale original reference instead of silently choosing another ceiling', () => {
    const r = route(); r.binding!.price.validUntil = observed;
    expect(resolve([r, route('backup')]).candidates).toEqual([]);
  });
  it('does not enable legacy fallback by listing backups', () => {
    const result = resolveRoutingCandidates({ routes: [route(), route('backup')], connections: [connection],
      policy: { ...policy, fallbackEnabled: false, maxAttempts: 1 }, preference, mandatory: PRIVATE_RESTRICTIONS,
      sourceRestrictions: [], tier: 'efficient', envelope, now });
    expect(result.candidates.map(x => x.route.id)).toEqual(['primary']);
  });
  it('rejects repeated routes and unbounded attempt configuration', () => {
    expect(tierRoutingSchema.safeParse({ ...policy, backups: ['primary'] }).success).toBe(false);
    expect(tierRoutingSchema.safeParse({ ...policy, maxAttempts: 6 }).success).toBe(false);
  });
  it.each(['refusal', 'privacy', 'invalid-request', 'credential', 'configuration', 'cancelled'] as const)('never retries %s through another model', kind => {
    expect(mayFailOver({ enabled: true, kind, attempts: 1, maxAttempts: 2, visibleOutput: false, uncertainToolEffect: false, portableCheckpoint: true })).toBe(false);
  });
  it('permits a bounded pre-output timeout only at a portable checkpoint without an uncertain tool effect', () => {
    const safe = { enabled: true, kind: 'timeout' as const, attempts: 1, maxAttempts: 2, visibleOutput: false, uncertainToolEffect: false, portableCheckpoint: true };
    expect(mayFailOver(safe)).toBe(true);
    for (const change of [{ visibleOutput: true }, { uncertainToolEffect: true }, { portableCheckpoint: false }, { attempts: 2 }])
      expect(mayFailOver({ ...safe, ...change })).toBe(false);
  });
});

describe('approved connection boundary', () => {
  it('does not raise the original reference ceiling when a later primary price changes', () => {
    const originalPrice = binding().price;
    const primary = route(), backup = route('backup');
    primary.binding!.price.requestFeeMicroUsd = 100_000;
    backup.binding!.price.requestFeeMicroUsd = 50_000;
    const result = resolveRoutingCandidates({ routes: [primary, backup], connections: [connection], policy,
      preference, mandatory: PRIVATE_RESTRICTIONS, sourceRestrictions: [], tier: 'efficient', envelope, now,
      referencePrice: originalPrice });
    expect(result.candidates).toEqual([]);
    expect(result.excluded.every(r => r.reasons.some(e => e.code === 'reference_price_limit'))).toBe(true);
  });
  it('rejects arbitrary endpoints, secret names and another payer', () => {
    for (const change of [{ endpoint: 'https://attacker.invalid' }, { secretRef: 'DATABASE_URL' }, { payer: 'customer' }, { region: 'us-east-1.attacker.invalid' }])
      expect(providerConnectionSchema.safeParse({ ...connection, ...change }).success).toBe(false);
  });
  it('requires exact OpenRouter endpoint approval', () => {
    const c: ProviderConnection = { id: 'or', revision: 1, label: 'Fixture', provider: 'openrouter', secretRef: 'OPENROUTER_API_KEY',
      payer: 'company', account: 'fixture', enabled: true, ingress: 'us', regionalEntitlement: true, allowedEndpoints: ['example/us-east'], endpointNames: { 'example/us-east': 'Example' } };
    const r = route(); r.provider = 'openrouter'; r.binding = { ...r.binding!, connectionId: 'or', protocol: 'chat-completions', upstreamEndpoint: 'example' };
    expect(bindingProblems(r, c).map(x => x.code)).toEqual(['binding_invalid']);
  });
});
