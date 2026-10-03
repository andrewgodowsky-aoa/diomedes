import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MANDATORY_RESTRICTIONS, LEGACY_ROUTING_CONSENT, PRIVATE_RESTRICTIONS, PROFILE_FLOORS, ROUTING_CONSENT_VERSION,
  STRICT_RESTRICTIONS, UNPINNED_REGION, bindingProblems, estimateRouteCost, mayFailOver,
  providerConnectionSchema, resolveRoutingCandidates, restrictionsCover, routeEligibility, routingPreferenceSchema,
  routingPreferenceWriteSchema, routingScopeKey, tierRoutingSchema, type CatalogRoute, type ModelBinding, type ProviderConnection,
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
  consentVersion: LEGACY_ROUTING_CONSENT, acceptedBy: 'owner-a', acceptedAt: observed, exceptions: [],
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

describe('profile floors under NC-SETUP-2026-10-02.1', () => {
  const current = (profile: RoutingPreference['profile']): RoutingPreference =>
    ({ ...preference, profile, restrictions: { ...PROFILE_FLOORS[profile] }, consentVersion: ROUTING_CONSENT_VERSION });
  const evaluate = (r: CatalogRoute, p: RoutingPreference, c: ProviderConnection = connection) => routeEligibility({ route: r, connection: c,
    preference: p, mandatory: DEFAULT_MANDATORY_RESTRICTIONS, sourceRestrictions: [], tier: 'efficient', envelope, qualityFloor: 0.8, now });
  const codes = (reasons: { code: string }[]) => [...new Set(reasons.map(x => x.code))];
  const rank = (routes: CatalogRoute[], p: RoutingPreference, change: Partial<TierRouting> = {}, connections: ProviderConnection[] = [connection]) =>
    resolveRoutingCandidates({ routes, connections, policy: { ...policy, ...change }, preference: p,
      mandatory: DEFAULT_MANDATORY_RESTRICTIONS, sourceRestrictions: [], tier: 'efficient', envelope, now });
  const unpinned = (r: CatalogRoute) => {
    r.binding!.privacy!.decryptionCountries = [UNPINNED_REGION]; r.binding!.privacy!.processingCountries = [UNPINNED_REGION]; return r;
  };
  const retaining = (r: CatalogRoute) => { r.binding!.privacy!.zeroRetention = false; r.binding!.privacy!.retentionPolicy = 'fixture-30-day'; return r; };
  const cheaper = (r: CatalogRoute) => { r.binding!.price.outputMicroUsdPerMillion = 100_000; r.binding!.price.reasoningMicroUsdPerMillion = 100_000; return r; };
  const openRouter: ProviderConnection = { id: 'openrouter-company', revision: 1, label: 'Synthetic OpenRouter', provider: 'openrouter',
    secretRef: 'OPENROUTER_API_KEY', payer: 'company', account: 'fixture-account', enabled: true, ingress: 'global', regionalEntitlement: false,
    allowedEndpoints: ['fixture/us'], endpointNames: { 'fixture/us': 'Fixture' } };
  const openRouterRoute = (id: string) => {
    const r = route(id), b = r.binding!;
    r.provider = 'openrouter'; r.model = 'fixture/model-a';
    b.connectionId = openRouter.id; b.protocol = 'chat-completions'; b.upstreamEndpoint = 'fixture/us'; delete b.reasoning;
    b.privacy!.protocol = 'chat-completions';
    return r;
  };

  it('refuses an unpinned region under Strict with its own reason', () => {
    expect(codes(evaluate(unpinned(route()), current('strict')))).toEqual(['geography_unpinned']);
  });
  it('serves global zero-retention and retaining no-training routes under Balanced and Lowest cost without an exception', () => {
    for (const profile of ['balanced', 'lowest-cost'] as const) {
      expect(evaluate(unpinned(route()), current(profile))).toEqual([]);
      expect(evaluate(retaining(route()), current(profile))).toEqual([]);
    }
  });
  it('keeps no training as the floor of every profile', () => {
    for (const profile of ['lowest-cost', 'balanced', 'strict'] as const) {
      const r = route(); r.binding!.privacy!.training = true;
      expect(codes(evaluate(r, current(profile)))).toContain('training_forbidden');
    }
  });
  it('allows an evidenced transient provider cache outside Strict only', () => {
    const cached = (evidence: string | null) => {
      const r = route(); r.binding!.privacy!.caching = 'transient'; r.binding!.privacy!.transientCacheEvidence = evidence; return r;
    };
    expect(evaluate(cached('Synthetic cache terms'), current('balanced'))).toEqual([]);
    expect(evaluate(cached('Synthetic cache terms'), current('lowest-cost'))).toEqual([]);
    expect(codes(evaluate(cached('Synthetic cache terms'), current('strict')))).toEqual(['cache_forbidden']);
    expect(codes(evaluate(cached(null), current('balanced')))).toEqual(['cache_forbidden']);
  });
  it('keeps the old Balanced exception rule for a preference accepted under 09-27.1', () => {
    const r = route(); r.binding!.privacy!.processingCountries = ['CA'];
    expect(codes(evaluate(r, { ...current('balanced'), consentVersion: LEGACY_ROUTING_CONSENT }))).toEqual(['balanced_consent_required']);
    expect(evaluate(r, current('balanced'))).toEqual([]);
  });
  it('ranks verified zero retention first and pinned US second under Balanced, in staff order within a rank', () => {
    const routes = [retaining(route('primary')), unpinned(route('backup')), route('third'), route('fourth')];
    const result = rank(routes, current('balanced'), { backups: ['backup', 'third', 'fourth'], maxAttempts: 4 });
    expect(result.candidates.map(x => x.route.id)).toEqual(['third', 'fourth', 'backup', 'primary']);
    expect(rank(routes, current('strict'), { backups: ['backup', 'third', 'fourth'], maxAttempts: 4 }).candidates.map(x => x.route.id)).toEqual(['third', 'fourth']);
  });
  it('does not count an OpenRouter route as US without entitled US ingress', () => {
    const routes = [openRouterRoute('primary'), route('backup')];
    expect(rank(routes, current('balanced'), {}, [connection, openRouter]).candidates.map(x => x.route.id)).toEqual(['backup', 'primary']);
    const entitled: ProviderConnection = { ...openRouter, ingress: 'us', regionalEntitlement: true };
    routes[0].binding!.privacy!.regionalEntitlement = true;
    expect(rank(routes, current('balanced'), {}, [connection, entitled]).candidates.map(x => x.route.id)).toEqual(['primary', 'backup']);
  });
  it('does not treat AWS zero retention as verified without its retention mode evidence when ranking', () => {
    const unproven = route('primary');
    unproven.binding!.privacy!.allowedRetentionModes = ['default']; unproven.binding!.privacy!.effectiveRetentionMode = 'default';
    expect(rank([unproven, route('backup')], current('balanced')).candidates.map(x => x.route.id)).toEqual(['backup', 'primary']);
  });
  it('ranks every eligible route by price under Lowest cost, the primary included, and keeps the uncapped order', () => {
    const result = rank([route('primary'), cheaper(route('backup'))], current('lowest-cost'), { maxAttempts: 1 });
    expect(result.candidates.map(x => x.route.id)).toEqual(['backup']);
    expect(result.ranked.map(x => x.route.id)).toEqual(['backup', 'primary']);
    expect(rank([route('primary'), cheaper(route('backup'))], current('strict'), { maxAttempts: 1 }).candidates.map(x => x.route.id)).toEqual(['primary']);
  });
  it('breaks a Lowest cost price tie by privacy, then by published order', () => {
    expect(rank([retaining(route('primary')), route('backup')], current('lowest-cost')).candidates.map(x => x.route.id)).toEqual(['backup', 'primary']);
    expect(rank([route('primary'), route('backup')], current('lowest-cost')).candidates.map(x => x.route.id)).toEqual(['primary', 'backup']);
  });
  it('still holds Lowest cost at or below the primary reference price', () => {
    const pricier = route('backup');
    pricier.binding!.price.outputMicroUsdPerMillion = 400_000; pricier.binding!.price.reasoningMicroUsdPerMillion = 400_000;
    const result = rank([route('primary'), pricier], current('lowest-cost'));
    expect(result.ranked.map(x => x.route.id)).toEqual(['primary']);
    expect(result.excluded[0].reasons.map(x => x.code)).toContain('reference_price_limit');
  });
  it('measures privacy limits against a profile floor', () => {
    expect(restrictionsCover(STRICT_RESTRICTIONS, PROFILE_FLOORS.balanced)).toBe(true);
    expect(restrictionsCover(PROFILE_FLOORS.balanced, STRICT_RESTRICTIONS)).toBe(false);
    expect(restrictionsCover({ ...STRICT_RESTRICTIONS, processingCountries: null }, STRICT_RESTRICTIONS)).toBe(false);
    expect(restrictionsCover({ ...STRICT_RESTRICTIONS, transientCache: 'approved' }, STRICT_RESTRICTIONS)).toBe(false);
    expect(restrictionsCover({ ...PROFILE_FLOORS.balanced, noTraining: false }, PROFILE_FLOORS.balanced)).toBe(false);
    expect(restrictionsCover({ ...STRICT_RESTRICTIONS, allowedConnections: [connection.id] }, STRICT_RESTRICTIONS)).toBe(true);
  });
  it('accepts writes only under the current consent version and without exceptions, while 09-27.1 rows still parse', () => {
    const write = { scope: preference.scope, baseRevision: 0, profile: 'balanced', restrictions: PROFILE_FLOORS.balanced,
      exceptions: [], consentVersion: ROUTING_CONSENT_VERSION, acknowledge: true };
    expect(routingPreferenceWriteSchema.safeParse(write).success).toBe(true);
    expect(routingPreferenceWriteSchema.safeParse({ ...write, consentVersion: LEGACY_ROUTING_CONSENT }).success).toBe(false);
    expect(routingPreferenceWriteSchema.safeParse({ ...write, exceptions: [{ connectionId: connection.id, model: 'us.test.model',
      ingressCountries: ['US'], processingCountries: ['CA'], retentionPolicy: 'fixture-zdr', acceptedAt: observed, savings: null,
      qualificationId: 'fixture-q1' }] }).success).toBe(false);
    expect(routingPreferenceSchema.safeParse(preference).success).toBe(true);
    expect(routingPreferenceSchema.safeParse(current('balanced')).success).toBe(true);
  });
});
