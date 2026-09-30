import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { seedDemo, DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, type DemoAccount } from '../src/faux/seed.js';
import { STRICT_RESTRICTIONS, type AccountScope, type ModelBinding, type ProviderConnection } from '../../../shared/routing-policy.js';
import { micro } from '../../../shared/managed-usage.js';
import { RoutingService } from '../src/routing.js';

const at = '2026-09-28T00:00:00.000Z', until = '2026-10-28T00:00:00.000Z';
let clock: number, cloud: FauxCloud, owner: string, routing: string, billing: string, orgA: string, orgB: string;
let sends: { url: string; body: Record<string, unknown> }[], answer: (deployment: string) => Response | Promise<Response>;
const connection: ProviderConnection = { id: 'azure-fixture', revision: 1, provider: 'azure-openai', label: 'Synthetic Azure',
  secretRef: 'AZURE_OPENAI_API_KEY', payer: 'company', account: 'fixture-account', enabled: true,
  resource: 'fixture-resource', apiVersion: 'v1', deployments: ['primary', 'backup', 'other'] };
const awsConnection: ProviderConnection = { id: 'aws-fixture', revision: 1, provider: 'aws-bedrock', label: 'Synthetic AWS',
  secretRef: 'BEDROCK_API_KEY', payer: 'company', account: 'fixture-account', enabled: true,
  region: 'us-east-1', endpointFamily: 'runtime', allowedProfiles: ['us.openai.gpt-5.6-luna', 'us.openai.gpt-6-luna'],
  modelProtocols: { 'us.openai.gpt-5.6-luna': ['responses', 'chat-completions'], 'us.openai.gpt-6-luna': ['responses'] } };
const bindings = { MANAGED_CONNECTIONS: JSON.stringify([connection, awsConnection]),
  AZURE_OPENAI_API_KEY: 'fixture-company-secret', BEDROCK_API_KEY: 'fixture-aws-secret' };
const transport: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body)); sends.push({ url: String(url), body });
  if (!String(url).includes('bedrock-runtime')) expect(new Headers(init?.headers).get('api-key')).toBe('fixture-company-secret');
  expect(init?.redirect).toBe('manual'); return answer(String(body.model));
};
const events = (items: unknown[]) => new Response(items.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' } });
const success = () => events([
  { id: 'fixture-completion', model: 'synthetic-v1', choices: [{ delta: { content: 'Recorded answer.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12 } },
]);
function binding(deployment: string): ModelBinding {
  return { connectionId: connection.id, connectionRevision: 1, protocol: 'chat-completions', deployment,
    modelVersion: 'synthetic-v1', upstreamEndpoint: null,
    capabilities: { contextTokens: 100_000, outputTokens: 4096, tools: true, images: false, reasoning: false },
    qualification: { id: 'synthetic-qualification', evidence: 'Transport fixture only', validUntil: until, tiers: ['efficient', 'focused', 'thorough'], qualityFloor: 0.9 },
    access: { state: 'ready', evidence: 'Transport fixture only', validUntil: until, availableRequests: 10 },
    privacy: { connectionRevision: 1, modelVersion: 'synthetic-v1', protocol: 'chat-completions', evidence: 'Transport fixture only',
      validUntil: until, ingressCountries: ['US'], decryptionCountries: ['US'], processingCountries: ['US'], retentionPolicy: 'fixture-zero-retention',
      zeroRetention: true, training: false, contentLogging: false, caching: 'off', transientCacheEvidence: null,
      features: ['text', 'tools'], allowedRetentionModes: [], effectiveRetentionMode: null, regionalEntitlement: false },
    health: { state: 'healthy', observedAt: at, validUntil: until, cooldownUntil: null, reason: 'Transport fixture only' },
    price: { version: 'fixture-price-1', evidence: 'Transport fixture only', observedAt: at, validUntil: until,
      inputMicroUsdPerMillion: 100_000, outputMicroUsdPerMillion: 200_000, reasoningMicroUsdPerMillion: 200_000,
      cacheReadMicroUsdPerMillion: 10_000, cacheWriteMicroUsdPerMillion: 125_000, requestFeeMicroUsd: 1, longContext: [] } };
}
async function call(method: string, pathname: string, token?: string, body?: unknown) {
  const response = await cloud.handle(new Request(`http://127.0.0.1:8795${pathname}`, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: response.status, body: await response.json() as any };
}
async function signIn(who: DemoAccount) { return (await call('POST', '/auth/sign-in', undefined,
  { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD })).body.accessToken as string; }
async function personPlan(token = owner, reference = 'Synthetic Personal plan') {
  const person = (await cloud.accounts.signIn(token)).person;
  const result = await call('POST', `/ops/people/${person.id}/grants`, billing,
    { planId: 'individual', source: 'internal-test', reference, note: '', validUntil: until });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return { person, grant: result.body.grant };
}
const scopePath = (s: AccountScope) => `${s.kind}/${s.id}`;
async function preference(scope: AccountScope, token = owner) {
  const result = await call('POST', `/account/routing/${scopePath(scope)}/preference`, token, { scope, baseRevision: 0,
    profile: 'strict', restrictions: STRICT_RESTRICTIONS, exceptions: [], consentVersion: 'NC-SETUP-2026-09-27.1', acknowledge: true });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}
function tier(primary = 'primary', fallback = false) { return { primary, backups: fallback ? ['backup'] : [], fallbackEnabled: fallback,
  maxAttempts: fallback ? 2 : 1, cost: { sameOrLower: true, maxAttemptMicroUsd: null, qualityFloor: 0.8 } }; }
const configuration = (primary = 'primary', fallback = false) => ({ efficient: tier(primary, fallback), focused: tier(primary, fallback), thorough: tier(primary, fallback) });
async function publish(primary = 'primary', fallback = false, scope: AccountScope | { kind: 'global' } = { kind: 'global' }, baseRevision = scope.kind === 'global' ? 1 : 0, globalRevision = 1) {
  return call('POST', '/ops/routing/scopes/publish', routing, { scope, baseRevision, baseGlobalRevision: globalRevision, routing: configuration(primary, fallback), note: 'Synthetic publication' });
}
async function editRoute(id: string, change: (b: ModelBinding) => void) {
  const row = cloud.store.snapshot().commercial.routes.find(r => r.id === id)!;
  const b = structuredClone(row.binding!); change(b);
  const { v: _v, revision, updatedAt: _at, updatedBy: _by, ...fields } = row;
  const result = await call('POST', '/ops/routes', routing, { ...fields, binding: b, baseRevision: revision });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}
async function addAwsRoute(id: string, model: string, protocol: ModelBinding['protocol'] = 'responses') {
  const b = binding(id);
  b.connectionId = awsConnection.id; b.protocol = protocol; b.deployment = null; b.modelVersion = model;
  b.capabilities.reasoning = true;
  b.privacy = { ...b.privacy!, modelVersion: model, protocol, features: ['text', 'tools', 'reasoning'],
    allowedRetentionModes: ['none'], effectiveRetentionMode: 'none' };
  const result = await call('POST', '/ops/routes', routing, { id, provider: 'aws-bedrock', model, label: id,
    region: 'us', processing: 'Transport fixture only', status: 'qualified', evidence: 'Transport fixture only', binding: b });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}
async function request(scope: AccountScope = { kind: 'organization', id: orgA }, opts: { job?: string; attempt?: string; token?: string; headers?: Record<string, string> } = {}) {
  const token = opts.token ?? owner, job = opts.job ?? 'routing-job';
  const admission = await call('POST', `/account/routing/${scopePath(scope)}/admit`, token, { surface: 'conversation', routeKind: 'managed', rootJobId: job });
  const snapshot = await call('GET', `/account/routing/${scopePath(scope)}/policy`, token);
  expect(admission.status, JSON.stringify(admission.body)).toBe(200); expect(snapshot.status).toBe(200);
  const p = snapshot.body;
  return new Request('http://127.0.0.1:8795/managed/v1/responses', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-nectovia-scope-kind': scope.kind,
    [scope.kind === 'individual' ? 'x-nectovia-account' : 'x-nectovia-organization']: scope.id,
    'x-nectovia-admission': admission.body.admissionId, 'x-nectovia-job': job, 'x-nectovia-attempt': opts.attempt ?? 'routing-attempt',
    'x-nectovia-tier': 'efficient', 'x-nectovia-usage-class': 'metered-work', 'x-nectovia-protocol': p.protocol,
    'x-nectovia-policy-revision': String(p.revision), 'x-nectovia-global-revision': String(p.globalRevision),
    'x-nectovia-scope-revision': String(p.scopeRevision), 'x-nectovia-preference-revision': String(p.preferenceRevision),
    'x-nectovia-route-revision': String(p.tiers.efficient?.entryRevision ?? 1), 'x-nectovia-checkpoint': 'portable', ...opts.headers,
  }, body: JSON.stringify({ model: p.tiers.efficient?.model ?? 'synthetic-v1', input: [{ role: 'user', content: 'Hello.' }], max_output_tokens: 512, stream: true, store: false }) });
}
async function completed(req: Request) {
  const response = await cloud.handle(req), body = await response.text();
  expect(response.status, body).toBe(200); expect(body).toContain('Recorded answer.'); await cloud.idle(); return { response, body };
}
beforeEach(async () => {
  clock = Date.parse(at); sends = []; answer = success;
  cloud = await createFauxCloud({ file: null, now: () => clock, passwordIterations: 1000, managed: { transport, bindings, idleTimeoutMs: 50 } });
  orgA = (await seedDemo(cloud)).organizations!.juniper;
  owner = await signIn('owner'); routing = await signIn('staffRouting'); billing = await signIn('staffBilling');
  orgB = (await call('POST', '/account/organizations', owner, { name: 'Second synthetic organization' })).body.id;
  expect((await call('POST', `/ops/customers/${orgB}/grants`, billing, { planId: 'business', source: 'internal-test', reference: 'Synthetic', note: 'Synthetic grant' })).status).toBe(201);
  for (const id of ['primary', 'backup', 'other']) {
    const result = await call('POST', '/ops/routes', routing, { id, provider: 'azure-openai', model: 'synthetic-v1', label: id,
      region: 'US', processing: 'Transport fixture only', status: 'qualified', evidence: 'Transport fixture only', binding: binding(id) });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  }
  await preference({ kind: 'organization', id: orgA }); await preference({ kind: 'organization', id: orgB });
});
afterEach(async () => { await cloud.idle(); vi.restoreAllMocks(); });

describe('Operations publication through authenticated funded dispatch', () => {
  it('does not advertise Responses summaries for a registered model using Chat Completions', async () => {
    await addAwsRoute('aws-chat', 'us.openai.gpt-5.6-luna', 'chat-completions');
    expect((await publish('aws-chat')).status).toBe(201);
    const snapshot = await call('GET', `/account/routing/organization/${orgA}/policy`, owner);
    expect(snapshot.body.tiers.efficient).toMatchObject({ entryId: 'aws-chat', reasoningSummaries: false });
  });

  it('removes optional summary on an unsupported fallback while retaining reasoning effort', async () => {
    await addAwsRoute('aws-supported', 'us.openai.gpt-5.6-luna');
    await addAwsRoute('aws-unsupported', 'us.openai.gpt-6-luna');
    const published = await call('POST', '/ops/routing/scopes/publish', routing, { scope: { kind: 'global' }, baseRevision: 1,
      baseGlobalRevision: 1, routing: { efficient: { ...tier('aws-supported'), backups: ['aws-unsupported'], fallbackEnabled: true, maxAttempts: 2 },
        focused: tier('aws-supported'), thorough: tier('aws-supported') }, note: 'Synthetic publication' });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    answer = model => model === 'us.openai.gpt-5.6-luna' ? new Response(null, { status: 503 })
      : (sends.at(-1)?.body.reasoning as Record<string, unknown> | undefined)?.summary
        ? new Response(null, { status: 400 })
        : events([
          { type: 'response.output_text.delta', delta: 'Recorded answer.' },
          { type: 'response.completed', response: { id: 'fixture-response', model, status: 'completed', output: [],
            usage: { input_tokens: 100, output_tokens: 12, output_tokens_details: { reasoning_tokens: 2 } } } },
        ]);
    const original = await request();
    const payload = await original.clone().json() as Record<string, unknown>;
    const result = await completed(new Request(original, { body: JSON.stringify({ ...payload, reasoning: { effort: 'low', summary: 'auto' } }) }));
    expect(sends.map(s => s.body.model)).toEqual(['us.openai.gpt-5.6-luna', 'us.openai.gpt-6-luna']);
    expect(sends[0].body.reasoning).toEqual({ effort: 'low', summary: 'auto' });
    expect(sends[1].body.reasoning).toEqual({ effort: 'low' });
    expect(result.response.headers.get('x-nectovia-route')).toBe('aws-unsupported');
    expect(result.body).toContain('"fallbackReason":"capacity"');
    expect(cloud.store.snapshot().funding.attempts.map(a => a.state)).toEqual(['uncertain', 'settled']);
  });

  it('reports summary support only for the selected registered provider route', async () => {
    expect((await publish()).status).toBe(201);
    const model = 'us.openai.gpt-5.6-luna';
    const aws: ProviderConnection = { id: 'aws-fixture', revision: 1, provider: 'aws-bedrock', label: 'Synthetic AWS',
      secretRef: 'BEDROCK_API_KEY', payer: 'company', account: 'fixture', enabled: true, region: 'us-east-1',
      endpointFamily: 'runtime', allowedProfiles: [model], modelProtocols: { [model]: ['responses'] } };
    await cloud.store.run(async draft => {
      const route = draft.commercial.routes.find(row => row.id === 'primary')!;
      route.provider = 'aws-bedrock'; route.region = 'us'; route.model = model;
      const b = route.binding!;
      b.connectionId = aws.id; b.protocol = 'responses'; b.modelVersion = model; b.deployment = null;
      b.privacy!.modelVersion = model; b.privacy!.protocol = 'responses';
      b.privacy!.allowedRetentionModes = ['none']; b.privacy!.effectiveRetentionMode = 'none';
    });
    const service = new RoutingService(cloud.accounts, cloud.store.commercial, () => clock);
    const env = { ...bindings, BEDROCK_API_KEY: 'synthetic-key', MANAGED_CONNECTIONS: JSON.stringify([connection, aws]) };
    const scope = { kind: 'organization' as const, id: orgA };
    const supported = await service.snapshot(owner, scope, env);
    expect(supported.tiers.efficient).toMatchObject({ entryId: 'primary', reasoningSummaries: true });
    // An unregistered Azure model must not inherit the registered AWS capability.
    expect((await publish('backup', false, { kind: 'global' }, 2, 2)).status).toBe(201);
    expect((await service.snapshot(owner, scope, env)).tiers.efficient)
      .toMatchObject({ entryId: 'backup', reasoningSummaries: false });
  });

  it('new-main: provisions one person-bound billing identity when the plan is issued before setup', async () => {
    const { person } = await personPlan();
    await Promise.all([personPlan(owner, 'Concurrent plan A'), personPlan(owner, 'Concurrent plan B')]);
    const state = cloud.store.snapshot();
    const accounts = state.commercial.individuals.filter(account => account.personId === person.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ tenantId: person.id, personId: person.id });
    expect(accounts[0].id).not.toBe(person.id);
    expect(state.accounts.organizations.some(org => org.record.id === accounts[0].id)).toBe(false);
    expect(state.funding.periods.filter(period => period.organizationId === accounts[0].id)).toHaveLength(0);
    expect((await call('POST', '/account/individual', owner, {})).body.id).toBe(accounts[0].id);
  });

  it('new-main: a person plan admits scoped Personal BYO without inventing managed usage', async () => {
    await personPlan();
    const individual = (await call('POST', '/account/individual', owner, {})).body;
    const path = `/account/routing/individual/${individual.id}/admit`;
    const byo = await call('POST', path, owner, { surface: 'conversation', routeKind: 'byo', rootJobId: 'personal-byo' });
    expect(byo.body.decision).toMatchObject({ admitted: true, planId: 'individual' });
    expect(byo.body.pins).toMatchObject({ organizationId: null, scope: { kind: 'individual', id: individual.id } });
    const managed = await call('POST', path, owner, { surface: 'conversation', routeKind: 'managed', rootJobId: 'personal-managed' });
    expect(managed.body.decision).toMatchObject({ admitted: false, code: 'managed_inference_not_included' });
    expect(sends).toHaveLength(0);
    expect(cloud.store.snapshot().funding.attempts).toHaveLength(0);
  });

  it('new-main: a funded agreement cannot substitute for the current person plan', async () => {
    const individual = (await call('POST', '/account/individual', owner, {})).body;
    const scope: AccountScope = { kind: 'individual', id: individual.id };
    expect((await call('POST', `/ops/individuals/${scope.id}/grants`, billing,
      { reference: 'Usage agreement without Agent access', validUntil: until, credits: 100 })).status).toBe(201);
    await preference(scope); await publish();
    const response = await cloud.handle(await request(scope));
    expect(response.status, await response.text()).toBe(403);
    expect(sends).toHaveLength(0);
    expect(cloud.store.snapshot().funding.attempts).toHaveLength(0);
  });

  it('new-main: revoking the person plan invalidates an already issued funded admission before send', async () => {
    const { person, grant } = await personPlan();
    const individual = (await call('POST', '/account/individual', owner, {})).body;
    const scope: AccountScope = { kind: 'individual', id: individual.id };
    expect((await call('POST', `/ops/individuals/${scope.id}/grants`, billing,
      { reference: 'Usage with Personal access', validUntil: until, credits: 100 })).status).toBe(201);
    await preference(scope); await publish();
    const pending = await request(scope);
    expect((await call('POST', `/ops/people/${person.id}/grants/${grant.id}/revoke`, billing,
      { reason: 'Person access withdrawn before dispatch' })).status).toBe(200);
    const response = await cloud.handle(pending);
    expect(response.status, await response.text()).toBe(403);
    expect(sends).toHaveLength(0);
    expect(cloud.store.snapshot().funding.attempts).toHaveLength(0);
  });

  it('new-main: an Individual plan never covers a one-member Business', async () => {
    const harbor = await signIn('harborOwner');
    await personPlan(harbor);
    const person = (await cloud.accounts.signIn(harbor)).person;
    const membership = cloud.store.snapshot().accounts.memberships.find(m => m.record.personId === person.id)!;
    const organizationId = membership.record.organizationId;
    const access = await call('GET', `/account/organizations/${organizationId}/access`, harbor);
    expect(access.body.agent.included).toBe(false);
    expect(access.body).not.toHaveProperty('coveredBy');
    const admission = await call('POST', `/account/organizations/${organizationId}/agent-admissions`, harbor,
      { surface: 'conversation', routeKind: 'byo', rootJobId: 'business-with-one-member' });
    expect(admission.body.decision.admitted).toBe(false);
  });

  it.each([null, 'nectovia-managed/1'])('refuses protocol %s before reserving or sending a versioned route', async protocol => {
    await publish('primary', true);
    const req = await request();
    if (protocol === null) req.headers.delete('x-nectovia-protocol');
    else req.headers.set('x-nectovia-protocol', protocol);
    const reserve = vi.spyOn(cloud.funding, 'reserve');
    const response = await cloud.handle(req);
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ error: { code: 'client_update_required' } });
    expect(reserve).not.toHaveBeenCalled();
    expect(sends).toHaveLength(0);
    expect(cloud.store.snapshot().funding.attempts).toHaveLength(0);
  });

  it('stops cancellation during the dispatch write before provider transport or fallback', async () => {
    await publish('primary', true);
    const cancel = new AbortController();
    const req = new Request(await request(), { signal: cancel.signal });
    const markDispatched = cloud.funding.markDispatched.bind(cloud.funding);
    vi.spyOn(cloud.funding, 'markDispatched').mockImplementationOnce(async ref => {
      const result = await markDispatched(ref);
      cancel.abort();
      return result;
    });
    const response = await cloud.handle(req);
    const body = await response.text();
    await cloud.idle();
    // The real exclusive dispatch record committed, so its hold remains truthful
    // even though this process can prevent the imminent provider transport.
    expect(sends, body).toHaveLength(0);
    expect(response.status, body).toBe(499);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'cancelled' }, nectovia: {
      attempts: [{ state: 'uncertain', routing: { routeId: 'primary', ordinal: 1 } }], allowanceDebitMicroUsd: 0,
    } });
    const state = cloud.store.snapshot();
    expect(state.funding.attempts).toHaveLength(1);
    expect(state.funding.attempts[0]).toMatchObject({ state: 'uncertain', dispatchedAt: at });
    expect(state.funding.settlements).toHaveLength(0);
    expect(state.commercial.circuits).toEqual({});
  });

  it('does not display or dispatch global routes through an override without a versioned configuration', async () => {
    expect((await publish()).status).toBe(201);
    await cloud.store.commercial.transaction(async tx => {
      const global = (await tx.policy())!;
      await tx.savePolicy({ ...global, scope: { kind: 'organization', id: orgA }, revision: 1, inherit: false,
        routing: undefined, tiers: { efficient: null, focused: null, thorough: null } });
    });
    const view = await call('GET', `/ops/routing/scopes/organization/${orgA}`, routing);
    expect(view.status).toBe(200); expect(view.body.inherited).toBe(false);
    expect(view.body.routing.efficient.primary).toBeNull();
    const snapshot = await call('GET', `/account/routing/organization/${orgA}/policy`, owner);
    expect(snapshot.body.tiers.efficient).toBeNull();
    expect((await cloud.handle(await request())).status).toBe(409);
    expect(sends).toHaveLength(0);
  });

  it('preserves the original lower job cap when an uncertain primary would leave too little for a backup', async () => {
    for (const id of ['primary', 'backup']) await editRoute(id, b => { b.price.requestFeeMicroUsd = 60_000; });
    await publish('primary', true);
    const organization = cloud.store.snapshot().accounts.organizations.find(o => o.record.id === orgA)!;
    await cloud.funding.openJob({ tenantId: organization.record.tenantId, organizationId: orgA, rootJobId: 'bounded', runRef: 'bounded',
      parentRunRef: null, tier: 'efficient', capMicroUsd: micro(100_000) });
    answer = () => new Response(null, { status: 503 });
    const response = await cloud.handle(await request(undefined, { job: 'bounded' }));
    expect(response.status).toBe(402); expect(sends.map(s => s.body.model)).toEqual(['primary']);
    const state = cloud.store.snapshot().funding;
    expect(state.jobs.find(j => j.rootJobId === 'bounded')!.capMicroUsd).toBe(100_000);
    expect(state.attempts).toHaveLength(1); expect(state.attempts[0].state).toBe('uncertain');
  });
  it('rechecks a route withdrawn while its reservation was being written, and releases the unsent hold', async () => {
    await publish();
    const reserve = cloud.funding.reserve.bind(cloud.funding);
    vi.spyOn(cloud.funding, 'reserve').mockImplementationOnce(async input => {
      const reserved = await reserve(input);
      await editRoute('primary', b => { b.access!.state = 'denied'; });
      return reserved;
    });
    const response = await cloud.handle(await request());
    expect(response.status).toBe(409); expect(sends).toHaveLength(0);
    expect(cloud.store.snapshot().funding.attempts).toMatchObject([{ state: 'released', dispatchedAt: null }]);
  });
  it('requires versioned setup for a newly paid Individual and rechecks a withdrawn agreement', async () => {
    await personPlan();
    const individual = (await call('POST', '/account/individual', owner, {})).body;
    const scope: AccountScope = { kind: 'individual', id: individual.id };
    const grant = await call('POST', `/ops/individuals/${scope.id}/grants`, billing, { reference: 'Synthetic agreement', validUntil: until, credits: 100 });
    expect(grant.status).toBe(201);
    expect((await call('GET', `/account/routing/${scopePath(scope)}/policy`, owner)).body.legacy).toBe(false);
    const notConfigured = await cloud.handle(await request(scope));
    expect(notConfigured.status).toBe(409); expect(sends).toHaveLength(0);
    await preference(scope); await publish(); const admitted = await request(scope);
    expect((await call('POST', `/ops/individuals/${scope.id}/grants/${grant.body.grant.id}/revoke`, billing, { reason: 'Synthetic revocation' })).status).toBe(200);
    expect((await cloud.handle(admitted)).status).toBe(403); expect(sends).toHaveLength(0);
  });
  it('does not preview or publish a route during its model-specific cooldown', async () => {
    await publish('primary', true); answer = d => d === 'primary' ? new Response(null, { status: 503 }) : success();
    await completed(await request());
    const preview = await call('POST', '/ops/routing/scopes/preview', routing, { scope: { kind: 'global' }, baseRevision: 2,
      baseGlobalRevision: 2, routing: configuration('primary'), note: 'Cooled down route' });
    expect(preview.status).toBe(422);
    clock += 31_000;
    expect((await publish('primary', false, { kind: 'global' }, 2, 2)).status).toBe(201);
  });
  it('isolates two organizations and the same person paid Individual, and resets an override to inheritance', async () => {
    await personPlan();
    const individual = (await call('POST', '/account/individual', owner, {})).body;
    const personal: AccountScope = { kind: 'individual', id: individual.id };
    expect(cloud.store.snapshot().accounts.organizations.some(o => o.record.id === personal.id)).toBe(false);
    await preference(personal);
    expect((await call('POST', `/ops/individuals/${personal.id}/grants`, billing, { reference: 'Synthetic paid agreement', validUntil: until, credits: 100 })).status).toBe(201);
    expect((await publish()).status).toBe(201);
    expect((await publish('backup', false, { kind: 'organization', id: orgB }, 0, 2)).status).toBe(201);
    expect((await publish('other', false, personal, 0, 2)).status).toBe(201);
    await completed(await request()); await completed(await request({ kind: 'organization', id: orgB }, { job: 'org-b', attempt: 'b' }));
    await completed(await request(personal, { job: 'personal', attempt: 'p' }));
    expect(sends.map(s => s.body.model)).toEqual(['primary', 'backup', 'other']);
    const reset = await call('POST', '/ops/routing/scopes/publish', routing, { scope: personal, baseRevision: 1, baseGlobalRevision: 2, routing: null, note: 'Inherit' });
    expect(reset.status).toBe(201);
    await completed(await request(personal, { job: 'personal-2', attempt: 'p2' })); expect(sends.at(-1)!.body.model).toBe('primary');
  });
  it('refuses Billing publication, member consent and a forged account scope before sending', async () => {
    expect((await call('POST', '/ops/routing/scopes/publish', billing, { scope: { kind: 'global' }, baseRevision: 1, baseGlobalRevision: 1, routing: configuration(), note: 'Forbidden' })).status).toBe(403);
    const employee = await signIn('employee');
    expect((await call('GET', `/account/routing/organization/${orgB}/policy`, employee)).status).toBe(403);
    const pref = await call('GET', `/account/routing/organization/${orgA}/preference`, employee);
    const { v: _v, revision, acceptedBy: _by, acceptedAt: _at, ...input } = pref.body;
    expect((await call('POST', `/account/routing/organization/${orgA}/preference`, employee, { ...input, baseRevision: revision, acknowledge: true })).status).toBe(403);
    expect(sends).toHaveLength(0);
  });
  it('applies Strict to both candidates before send, with specific exclusions', async () => {
    expect((await publish('primary', true)).status).toBe(201);
    for (const id of ['primary', 'backup']) await editRoute(id, b => { b.privacy!.processingCountries = ['DE']; });
    const response = await cloud.handle(await request());
    expect(response.status).toBe(409); expect(sends).toHaveLength(0); expect(cloud.store.snapshot().funding.attempts).toHaveLength(0);
    const snapshot = (await call('GET', `/account/routing/organization/${orgA}/policy`, owner)).body;
    expect(snapshot.exclusions.efficient.map((e: any) => e.routeId)).toEqual(['primary', 'backup']);
  });
  it('excludes zero quota despite healthy endpoint status without sending to that deployment', async () => {
    await publish('primary', true); await editRoute('primary', b => { b.access!.availableRequests = 0; });
    await completed(await request()); expect(sends.map(s => s.body.model)).toEqual(['backup']);
  });
  it('keeps a failed attempt reserved, funds its backup in the same job and records actual route and costs', async () => {
    await publish('primary', true); answer = deployment => deployment === 'primary' ? new Response(null, { status: 503 }) : success();
    const result = await completed(await request());
    expect(sends.map(s => s.body.model)).toEqual(['primary', 'backup']);
    const state = cloud.store.snapshot().funding;
    expect(state.attempts.map(a => a.state)).toEqual(['uncertain', 'settled']);
    expect(new Set(state.attempts.map(a => a.rootJobId)).size).toBe(1); expect(state.jobs).toHaveLength(1);
    expect(result.body).toContain('"fallbackReason":"capacity"'); expect(result.body).toContain('"heldMicroUsd":');
    expect(result.response.headers.get('x-nectovia-route')).toBe('backup');
    expect((await call('GET', '/ops/routing/scopes/global', routing)).body.routes.find((r: any) => r.id === 'primary').binding.health.state).toBe('open');
    clock += 31_000; answer = success;
    await completed(await request(undefined, { job: 'recovery', attempt: 'recovery' })); expect(sends.at(-1)!.body.model).toBe('primary');
  });
  it('does not splice a backup into partial visible output or retry a safety refusal', async () => {
    await publish('primary', true);
    answer = () => events([{ id: 'partial', model: 'synthetic-v1', choices: [{ delta: { content: 'Partial' } }] }]);
    const response = await cloud.handle(await request()); expect(response.status).toBe(200); await expect(response.text()).rejects.toThrow();
    await cloud.idle(); expect(sends).toHaveLength(1);
    answer = () => events([{ id: 'refusal', model: 'synthetic-v1', choices: [{ delta: { refusal: 'No.' }, finish_reason: 'content_filter' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }]);
    const refused = await cloud.handle(await request(undefined, { job: 'refusal', attempt: 'refusal' }));
    expect(await refused.text()).toContain('"type":"refusal"'); expect(sends).toHaveLength(2);
  });
  it('retains source restrictions across new attempts and skips unqualified optional advisors', async () => {
    await publish();
    const restriction = { ...STRICT_RESTRICTIONS, allowedConnections: ['different-company'] };
    const first = await cloud.handle(await request(undefined, { headers: { 'x-nectovia-source-restrictions': JSON.stringify([restriction]) } }));
    expect(first.status).toBe(409);
    const second = await cloud.handle(await request(undefined, { attempt: 'second' })); expect(second.status).toBe(409); expect(sends).toHaveLength(0);
    const req = await request(undefined, { attempt: 'advisor' });
    const advisor = await cloud.handle(new Request('http://127.0.0.1:8795/managed/v1/evaluations', { method: 'POST', headers: req.headers, body: '{}' }));
    expect(advisor.status).toBe(422); expect(await advisor.text()).toContain('helper_privacy_unverified');
  });
  it('rejects a stale request and concurrent publication, and rechecks revoked routes on rollback', async () => {
    await publish(); const old = await request();
    const body = { scope: { kind: 'global' }, baseRevision: 2, baseGlobalRevision: 2, routing: configuration('backup'), note: 'Concurrent' };
    const results = await Promise.all([call('POST', '/ops/routing/scopes/publish', routing, body), call('POST', '/ops/routing/scopes/publish', routing, body)]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]); expect((await cloud.handle(old)).status).toBe(409);
    await editRoute('primary', b => { b.access!.state = 'denied'; });
    const rollback = await call('POST', '/ops/routing/scopes/rollback', routing, { scope: { kind: 'global' }, baseRevision: 3, baseGlobalRevision: 3, toRevision: 2, note: 'Must not revive revoked route' });
    expect(rollback.status).toBe(422); expect(sends).toHaveLength(0);
  });
  it('uses real binding and normalization for a non-Luna SDK answer', async () => {
    await publish(); const template = await request();
    const model = createOpenAI({ baseURL: 'http://127.0.0.1:8795/managed/v1', apiKey: 'unused',
      fetch: async (url, init) => cloud.handle(new Request(String(url), { ...init, headers: template.headers })) }).responses('synthetic-v1');
    const result = streamText({ model, prompt: 'Hello.', maxOutputTokens: 512, maxRetries: 0, providerOptions: { openai: { store: false, parallelToolCalls: false } } });
    expect(await result.text).toBe('Recorded answer.'); expect(await result.usage).toMatchObject({ inputTokens: 100, outputTokens: 12 });
    expect(sends[0].url).toBe('https://fixture-resource.openai.azure.com/openai/v1/chat/completions');
  });
  it('retains published policy, consent and receipts across a store restart without manufacturing another balance', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nectovia-routing-'));
    try {
      const file = path.join(directory, 'cloud.json');
      const persisted = await createFauxCloud({ file, now: () => clock, passwordIterations: 1000, managed: { transport, bindings } });
      const state = cloud.store.snapshot(); await persisted.store.run(async draft => { Object.assign(draft, state); }); cloud = persisted;
      await publish(); await completed(await request());
      const before = cloud.store.snapshot().funding;
      cloud = await createFauxCloud({ file, now: () => clock, passwordIterations: 1000, managed: { transport, bindings } });
      const snapshot = (await call('GET', `/account/routing/organization/${orgA}/policy`, owner)).body;
      expect(snapshot.revision).toBe(2); expect(snapshot.preferenceRevision).toBe(1); expect(cloud.store.snapshot().funding).toEqual(before);
    } finally {
      await cloud.idle();
      if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('nectovia-routing-')) throw new Error('Unexpected temporary directory.');
      await rm(directory, { recursive: true, force: true });
    }
  });
});
