import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFauxCloud, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { seedDemo, FAUX_DEMO_PASSWORD } from '../services/control-plane/src/faux/seed';
import { ControlPlaneClient } from '../server/accounts/client';
import { STRICT_RESTRICTIONS, type ModelBinding, type ProviderConnection } from '../shared/routing-policy';
import { micro } from '../shared/managed-usage';
import { nectoviaRateCard, nectoviaConnectionId, respondNectovia, type NectoviaPolicy } from '../server/engines/nectovia';
import { CONVERSATION_LIMITS } from '../server/engines/model-api-core';
import { exposureAttempt } from '../server/engines/aws-bedrock';
import { SpendExposure } from '../server/spend-exposure';
import { AccountRoutingSession } from '../server/accounts/routing-session';
import type { AccountSessionService } from '../server/accounts/session';
import type { WorkspaceService } from '../server/workspaces';
import type { ModelMessage } from 'ai';
import type { ModelRequest } from '../shared/harness';
import { createNectoviaModelAdapter } from '../server/harness/nectovia-model-adapter';
import { FileModelTranscripts } from '../server/harness/model-transcripts';
import { validatePrepared } from '../server/harness/native-agent';

let cloud: FauxCloud, client: ControlPlaneClient, exposure: SpendExposure, directory: string;
let token: string, staff: string, org: string, connectionId: string, policy: NectoviaPolicy;
let replies: (deployment: string) => Response, sent: string[];
let gatewayRequests: Request[];
const connection: ProviderConnection = { id: 'fixture-azure', revision: 1, label: 'Synthetic Azure', provider: 'azure-openai',
  secretRef: 'AZURE_OPENAI_API_KEY', payer: 'company', account: 'fixture', enabled: true,
  resource: 'fixture-resource', apiVersion: 'v1', deployments: ['primary', 'backup'] };
const answer = () => new Response([
  { id: 'fixture-response', model: 'fixture-non-luna', choices: [{ delta: { content: 'A complete answer.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12 } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-provider-request' } });
async function api(method: string, url: string, bearer: string, value?: unknown) {
  const response = await cloud.handle(new Request(`${client.base}${url}`, { method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) }));
  const body = await response.json(); expect(response.ok, JSON.stringify(body)).toBe(true); return body;
}
async function refreshed() {
  const resolved = await client.scopedRoutingPolicy(token, { kind: 'organization', id: org });
  return policy = { revision: resolved.revision, tiers: resolved.tiers, resolved };
}
beforeEach(async () => {
  sent = []; gatewayRequests = []; replies = answer;
  const now = Date.now(), at = new Date(now).toISOString(), until = new Date(now + 3_600_000).toISOString();
  cloud = await createFauxCloud({ file: null, now: () => now, passwordIterations: 1000, managed: {
    bindings: { MANAGED_CONNECTIONS: JSON.stringify([connection]), AZURE_OPENAI_API_KEY: 'synthetic-provider-key' },
    transport: async (url, init) => {
      expect(String(url)).toBe('https://fixture-resource.openai.azure.com/openai/v1/chat/completions');
      expect(new Headers(init?.headers).get('api-key')).toBe('synthetic-provider-key');
      const body = JSON.parse(String(init?.body)); sent.push(body.model); return replies(body.model);
    },
  } });
  org = (await seedDemo(cloud)).organizations!.juniper;
  client = new ControlPlaneClient('http://127.0.0.1:8795', request => cloud.handle(request));
  const login = async (email: string) => {
    const response = await api('POST', '/auth/sign-in', '', { email, password: FAUX_DEMO_PASSWORD });
    return (response as { accessToken: string }).accessToken;
  };
  token = await login('owner@juniper.test'); staff = await login('routing@diomedes.test');
  const binding: ModelBinding = { connectionId: connection.id, connectionRevision: 1, protocol: 'chat-completions', deployment: 'primary',
    modelVersion: 'fixture-non-luna', upstreamEndpoint: null, capabilities: { contextTokens: 100_000, outputTokens: 4096, tools: true, images: false, reasoning: false },
    qualification: { id: 'fixture', evidence: 'Synthetic only', validUntil: until, tiers: ['efficient', 'focused', 'thorough'], qualityFloor: 1 },
    access: { state: 'ready', evidence: 'Synthetic only', validUntil: until, availableRequests: 10 },
    privacy: { connectionRevision: 1, modelVersion: 'fixture-non-luna', protocol: 'chat-completions', evidence: 'Synthetic only', validUntil: until,
      ingressCountries: ['US'], decryptionCountries: ['US'], processingCountries: ['US'], retentionPolicy: 'fixture-zdr', zeroRetention: true, training: false,
      contentLogging: false, caching: 'off', transientCacheEvidence: null, features: ['text', 'tools'], allowedRetentionModes: [], effectiveRetentionMode: null, regionalEntitlement: false },
    health: { state: 'healthy', observedAt: at, validUntil: until, cooldownUntil: null, reason: 'Synthetic only' },
    price: { version: 'fixture-v1', observedAt: at, validUntil: until, evidence: 'Synthetic only', inputMicroUsdPerMillion: 100_000,
      outputMicroUsdPerMillion: 200_000, reasoningMicroUsdPerMillion: 200_000, cacheReadMicroUsdPerMillion: 10_000, cacheWriteMicroUsdPerMillion: 125_000,
      requestFeeMicroUsd: 2, longContext: [] } };
  for (const id of ['primary', 'backup']) await api('POST', '/ops/routes', staff, { id, provider: 'azure-openai', model: 'fixture-non-luna',
    label: id, region: 'US', processing: 'Synthetic only', status: 'qualified', evidence: 'Synthetic only', binding: { ...binding, deployment: id } });
  await client.acceptRoutingPreference(token, { scope: { kind: 'organization', id: org }, baseRevision: 0, profile: 'strict', restrictions: STRICT_RESTRICTIONS,
    consentVersion: 'NC-SETUP-2026-09-27.1', exceptions: [], acknowledge: true });
  const tier = { primary: 'primary', backups: ['backup'], fallbackEnabled: true, maxAttempts: 2,
    cost: { sameOrLower: true, qualityFloor: 1, maxAttemptMicroUsd: null } };
  await api('POST', '/ops/routing/scopes/publish', staff, { scope: { kind: 'global' }, baseRevision: 1, baseGlobalRevision: 1,
    routing: { efficient: tier, focused: tier, thorough: tier }, note: 'Synthetic end-to-end client test' });
  await refreshed();
  directory = await mkdtemp(path.join(os.tmpdir(), 'nectovia-routing-client-'));
  exposure = new SpendExposure(directory); await exposure.init();
  connectionId = nectoviaConnectionId(org, new Date(now));
  await exposure.setCap(connectionId, micro(1_000_000), { approvedBy: 'test host', note: 'Disposable guard' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cloud?.idle();
  if (directory) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('nectovia-routing-client-')) throw new Error('Unexpected test directory.');
    await rm(directory, { recursive: true, force: true });
  }
});
async function respond(transform?: (response: Response) => Promise<Response>,
  messages: ModelMessage[] = [{ role: 'user', content: 'Hello.' }]) {
  const job = 'client-routing-job';
  const admission = await client.admitScopedAgent(token, { kind: 'organization', id: org }, { surface: 'conversation', routeKind: 'managed', rootJobId: job });
  return respondNectovia({ base: client.base, account: { policy: () => policy, refreshPolicy: refreshed }, connectionId,
    model: 'fixture-non-luna', managed: { admissionId: admission.admissionId, organizationId: org, scope: { kind: 'organization', id: org },
      policyRevision: policy.revision, routing: policy.resolved, tier: 'efficient', usageClass: 'metered-work', rootJobId: job },
    token, card: nectoviaRateCard('fixture-non-luna', policy), exposure, attempt: exposureAttempt(job, 'step-1', messages),
    instructions: 'Answer the request.', messages, tools: [], effort: 'low', limits: CONVERSATION_LIMITS,
    signal: new AbortController().signal, transport: async (url, init) => {
      const request = new Request(url, init); gatewayRequests.push(request);
      const response = await cloud.handle(request); return transform ? transform(response) : response;
    } });
}
describe('published account policy at the desktop model boundary', () => {
  it.each(['personal', 'business'] as const)('keeps funded Personal work on its account with %s selected', async selected => {
    const person = (await cloud.accounts.signIn(token)).person;
    const billing = (await api('POST', '/auth/sign-in', '', { email: 'billing@diomedes.test', password: FAUX_DEMO_PASSWORD })).accessToken;
    await api('POST', `/ops/people/${person.id}/grants`, billing,
      { planId: 'individual', source: 'internal-test', reference: 'Synthetic person plan', note: '' });
    const individual = await client.individualAccount(token), scope = { kind: 'individual' as const, id: individual.id };
    await api('POST', `/ops/individuals/${individual.id}/grants`, billing,
      { reference: 'Synthetic managed usage', validUntil: new Date(Date.now() + 3_600_000).toISOString(), credits: 100 });
    await client.acceptRoutingPreference(token, { scope, baseRevision: 0, profile: 'strict', restrictions: STRICT_RESTRICTIONS,
      consentVersion: 'NC-SETUP-2026-09-27.1', exceptions: [], acknowledge: true });
    const session = { personId: () => person.id, backend: { client },
      call: <T>(fn: (value: string) => Promise<T>) => fn(token) } as unknown as AccountSessionService;
    const workspaces = { projectOwner: () => null, active: () => selected === 'business'
      ? { kind: 'business', organizationId: org } : { kind: 'personal' } } as unknown as WorkspaceService;
    const projectId = selected === 'business' ? 'unowned-personal-project' : null;
    const routing = new AccountRoutingSession(session, workspaces), job = 'personal-client-job';
    const admission = await routing.admit({ phase: 'admit', surface: 'conversation', projectId, rootJobId: job, routeKind: 'managed' });
    expect(admission).toMatchObject({ scope, organizationId: null, personId: person.id });
    const personalPolicy = routing.policy(projectId)!;
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello from Personal.' }];
    const result = await respondNectovia({ base: client.base,
      account: { policy: () => routing.policy(projectId), refreshPolicy: () => routing.refresh(projectId) },
      connectionId, model: 'fixture-non-luna', managed: { admissionId: admission.admissionId,
        organizationId: scope.id, scope, policyRevision: personalPolicy.revision, routing: personalPolicy.resolved,
        tier: 'efficient', usageClass: 'metered-work', rootJobId: job },
      token, card: nectoviaRateCard('fixture-non-luna', personalPolicy), exposure, attempt: exposureAttempt(job, 'step-1', messages),
      instructions: 'Answer the request.', messages, tools: [], effort: 'low', limits: CONVERSATION_LIMITS,
      signal: new AbortController().signal, transport: async (url, init) => {
        const request = new Request(url, init); gatewayRequests.push(request); return cloud.handle(request);
      } });
    expect(result.outcome).toMatchObject({ kind: 'final', text: 'A complete answer.' });
    expect(result.rawUsage).toMatchObject({ nectovia: { attempts: [{ state: 'settled', routing: { scopeKey: `individual:${scope.id}` } }] } });
    expect(sent).toEqual(['primary']);
    expect(gatewayRequests[0].headers.get('x-nectovia-account')).toBe(scope.id);
    expect(gatewayRequests[0].headers.get('x-nectovia-organization')).toBeNull();
    const state = cloud.store.snapshot();
    expect(state.accounts.organizations.some(row => row.record.id === scope.id)).toBe(false);
    expect(state.funding.jobs.find(row => row.rootJobId === job)).toMatchObject({ organizationId: scope.id, tenantId: person.id });
    expect(state.commercial.personalAdmissions.find(row => row.id === admission.admissionId))
      .toMatchObject({ billingAccountId: scope.id, tenantId: person.id, personId: person.id });
  });

  it('preserves per-tier summary support from an authenticated scoped policy', async () => {
    const individual = await client.individualAccount(token);
    const snapshot = await client.scopedRoutingPolicy(token, { kind: 'organization', id: org });
    snapshot.tiers.efficient!.reasoningSummaries = true;
    snapshot.tiers.focused!.reasoningSummaries = false;
    snapshot.tiers.thorough = null;
    vi.spyOn(client, 'scopedRoutingPolicy').mockResolvedValue(snapshot);
    const session = { personId: () => individual.personId, backend: { client },
      call: <T>(fn: (value: string) => Promise<T>) => fn(token) } as unknown as AccountSessionService;
    const workspaces = { projectOwner: () => ({ organizationId: org }), active: () => ({ kind: 'personal' }) } as unknown as WorkspaceService;
    const routing = new AccountRoutingSession(session, workspaces);
    expect((await routing.refresh('owned-project'))?.reasoningSummaries)
      .toEqual({ efficient: true, focused: false, thorough: false });
  });

  it.each([true, false])('passes derived source restrictions through the real Nectovia adapter (destination allowed=%s)', async allowed => {
    const job = `adapter-source-${allowed ? 'allowed' : 'refused'}`;
    const scope = { kind: 'organization' as const, id: org };
    const admission = await client.admitScopedAgent(token, scope, { surface: 'conversation', routeKind: 'managed', rootJobId: job });
    let refusal: unknown;
    const bound = createNectoviaModelAdapter({ base: client.base, account: { policy: () => policy, refreshPolicy: refreshed },
      connectionId, model: 'fixture-non-luna', token, card: nectoviaRateCard('fixture-non-luna', policy), exposure,
      managed: { admissionId: admission.admissionId, organizationId: org, scope, policyRevision: policy.revision,
        routing: policy.resolved, tier: 'efficient', usageClass: 'metered-work', rootJobId: job, sourceRestrictions: [STRICT_RESTRICTIONS] },
      transcripts: new FileModelTranscripts(path.join(directory, 'transcripts'), 'nectovia'), instructions: 'Use only the synthetic source.',
      effort: 'low', limits: CONVERSATION_LIMITS, transport: async (url, init) => {
        const request = new Request(url, init); gatewayRequests.push(request);
        const response = await cloud.handle(request);
        if (!response.ok) refusal = await response.clone().json();
        return response;
      } });
    const rule = { ...STRICT_RESTRICTIONS, allowedConnections: [allowed ? connection.id : 'another-source-destination'] };
    const request: ModelRequest = { runId: job, capabilityId: 'routing-fixture', tools: [], transcript: null,
      messages: [{ role: 'user', text: 'Answer from this derived source.' }], sourceRestrictions: [rule] };
    const signal = new AbortController().signal;
    const prepared = validatePrepared(request, await bound.prepare!(request, signal));
    await bound.validatePrepared!(prepared);
    expect(bound.enforcesSourceRestrictions).toBe(true);
    if (allowed) {
      const result = await bound.complete(prepared, signal);
      expect(result.response).toEqual({ type: 'final', text: 'A complete answer.' });
      expect(result.managed).toMatchObject({ attempts: [{ state: 'settled', routing: { routeId: 'primary' } }] });
      expect(sent).toEqual(['primary']);
    } else {
      await expect(bound.complete(prepared, signal)).rejects.toThrow();
      expect(refusal).toMatchObject({ error: { code: 'no_compliant_route' } });
      expect(sent).toHaveLength(0);
      expect(cloud.store.snapshot().funding.attempts).toHaveLength(0);
    }
    expect(gatewayRequests).toHaveLength(1);
    expect(JSON.parse(gatewayRequests[0].headers.get('x-nectovia-source-restrictions')!)).toEqual([STRICT_RESTRICTIONS, rule]);
  });

  const checkpoint = (encrypted: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'reasoning', text: '',
    providerOptions: { openai: { itemId: 'rs_checkpoint', reasoningEncryptedContent: encrypted } } }] });
  it('derives the native route header from the SDK checkpoint rather than calling it portable', async () => {
    // The invented ciphertext must fail authentication, but it still exercises the real
    // desktop SDK and gateway header boundary without sending customer content onward.
    await expect(respond(undefined, [{ role: 'user', content: 'Continue.' }, checkpoint('nectovia-native-v1:primary:invalid-ciphertext')])).rejects.toThrow();
    expect(gatewayRequests).toHaveLength(1);
    expect(gatewayRequests[0].headers.get('x-nectovia-checkpoint')).toBe('native');
    expect(gatewayRequests[0].headers.get('x-nectovia-native-route')).toBe('primary');
    expect(sent).toHaveLength(0);
  });
  it.each([
    ['foreign', ['unbound-provider-state']],
    ['mixed', ['nectovia-native-v1:primary:ciphertext', 'nectovia-native-v1:backup:ciphertext']],
  ] as const)('rejects %s native state before opening a local reservation', async (_name, values) => {
    await expect(respond(undefined, [{ role: 'user', content: 'Continue.' }, ...values.map(checkpoint)]))
      .rejects.toMatchObject({ code: 'nonportable_continuation', dispatched: false });
    expect(gatewayRequests).toHaveLength(0); expect(sent).toHaveLength(0); expect(exposure.list(connectionId)).toHaveLength(0);
  });
  it.each(['admission', 'preference', 'acceptance'] as const)('rejects a late %s result after switching the active account', async operation => {
    const individual = await client.individualAccount(token);
    let activeOrganization = org;
    const session = { personId: () => individual.personId, backend: { client }, includes: () => false,
      call: <T>(fn: (value: string) => Promise<T>) => fn(token) } as unknown as AccountSessionService;
    const workspaces = { projectOwner: () => null, active: () => ({ kind: 'business', organizationId: activeOrganization }) } as unknown as WorkspaceService;
    const routing = new AccountRoutingSession(session, workspaces);
    await routing.refresh();
    let result: Promise<unknown>;
    if (operation === 'admission') {
      const admit = client.admitScopedAgent.bind(client);
      vi.spyOn(client, 'admitScopedAgent').mockImplementationOnce(async (...args) => {
        const value = await admit(...args); activeOrganization = 'another-account'; return value;
      });
      result = routing.admit({ phase: 'admit', surface: 'conversation', projectId: null, rootJobId: 'late-result', routeKind: 'managed' });
    } else if (operation === 'preference') {
      const preference = client.routingPreference.bind(client);
      vi.spyOn(client, 'routingPreference').mockImplementationOnce(async (...args) => {
        const value = await preference(...args); activeOrganization = 'another-account'; return value;
      });
      result = routing.preference(null);
    } else {
      const accept = client.acceptRoutingPreference.bind(client);
      vi.spyOn(client, 'acceptRoutingPreference').mockImplementationOnce(async (...args) => {
        const value = await accept(...args); activeOrganization = 'another-account'; return value;
      });
      result = routing.accept(null, { scope: { kind: 'organization', id: org }, baseRevision: 1, profile: 'strict', restrictions: STRICT_RESTRICTIONS,
        consentVersion: 'NC-SETUP-2026-09-27.1', exceptions: [], acknowledge: true });
    }
    await expect(result).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(routing.policy()).toBeNull(); expect(sent).toHaveLength(0);
  });
  it.each(['missing', 'other-account', 'other-request'])('keeps the desktop cost reserved when the authenticated terminal receipt is %s', async mode => {
    await expect(respond(async response => {
      const payload = (await response.text()).split('\n').map(line => {
        if (!line.startsWith('data: ')) return line;
        const event = JSON.parse(line.slice(6));
        if (event.response?.nectovia) {
          if (mode === 'missing') delete event.response.nectovia;
          else for (const attempt of event.response.nectovia.attempts) {
            if (mode === 'other-account') attempt.routing.scopeKey = 'individual:other';
            else attempt.routing.requestGroup = 'another-request';
          }
        }
        return `data: ${JSON.stringify(event)}`;
      }).join('\n');
      return new Response(payload, { status: response.status, headers: response.headers });
    })).rejects.toMatchObject({ code: 'nectovia_receipt_invalid' });
    expect(exposure.list(connectionId)[0].state).toBe('uncertain'); expect(sent).toHaveLength(1);
  });
  it('runs a non-Luna model through Operations, live account admission, gateway, real Azure binding and desktop SDK', async () => {
    const result = await respond();
    expect(result.outcome).toMatchObject({ kind: 'final', text: 'A complete answer.' });
    expect(result.servedBy).toContain('azure-openai/fixture-non-luna');
    expect(result.rawUsage).toMatchObject({ nectovia: { attempts: [{ state: 'settled', routing: { policyRevision: 2, routeId: 'primary', priceVersion: 'fixture-v1' } }] } });
    expect(sent).toEqual(['primary']); expect(exposure.list(connectionId)[0].state).toBe('settled');
  });
  it('keeps the local hold when a backup succeeds but the primary cost is unresolved', async () => {
    replies = deployment => deployment === 'primary' ? new Response(null, { status: 503 }) : answer();
    const result = await respond();
    expect(result.outcome.kind).toBe('final'); expect(result.servedBy).toContain('(backup)');
    expect(exposure.list(connectionId)[0].state).toBe('uncertain');
    expect(cloud.store.snapshot().funding.attempts.map(a => a.state)).toEqual(['uncertain', 'settled']);
  });
  it('retains unresolved primary cost when the backup returns a refusal with known usage', async () => {
    replies = deployment => deployment === 'primary' ? new Response(null, { status: 503 }) : new Response([
      { id: 'fixture-refusal', model: 'fixture-non-luna', choices: [{ delta: { refusal: 'The model declined.' }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 100, completion_tokens: 12 } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    await expect(respond()).rejects.toMatchObject({ managed: { attempts: [
      { state: 'uncertain', routing: { routeId: 'primary' } }, { state: 'settled', routing: { routeId: 'backup' } },
    ] } });
    expect(sent).toEqual(['primary', 'backup']); expect(exposure.list(connectionId)[0].state).toBe('uncertain');
  });
  it('does not release the desktop hold or say nothing was charged when all funded attempts fail', async () => {
    replies = () => new Response(null, { status: 503 });
    await expect(respond()).rejects.toMatchObject({ message: expect.stringContaining('cost remains reserved'), managed: { attempts: [
      { state: 'uncertain', routing: { routeId: 'primary', ordinal: 1, scopeKey: `organization:${org}` } },
      { state: 'uncertain', routing: { routeId: 'backup', ordinal: 2, fallbackReason: 'capacity' } },
    ] } });
    expect(sent).toEqual(['primary', 'backup']); expect(exposure.list(connectionId)[0].state).toBe('uncertain');
  });
  it('releases the desktop hold when the authenticated failure receipt confirms every attempt was refused before inference', async () => {
    replies = () => new Response(null, { status: 401 });
    await expect(respond()).rejects.toMatchObject({ managed: { heldMicroUsd: 0, attempts: [
      { state: 'released', routing: { routeId: 'primary' } },
    ] } });
    expect(sent).toEqual(['primary']); expect(exposure.list(connectionId)[0].state).toBe('released');
  });
  it('refuses unknown models and expired authenticated snapshots before a provider send', () => {
    expect(() => nectoviaRateCard('unapproved-model', policy)).toThrow();
    const expired = structuredClone(policy); expired.resolved!.validUntil = new Date(Date.now() - 1).toISOString();
    expect(() => nectoviaRateCard('fixture-non-luna', expired)).toThrow(/Refresh/); expect(sent).toHaveLength(0);
  });
});
