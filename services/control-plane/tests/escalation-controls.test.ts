/**
 * Escalation controls (phase 2 of the gateway route checks lane): staff set a scope's control on its
 * routing record from the Operations app, members read the effective control, and the managed
 * gateway refuses an escalated call its control does not allow, before any hold or send. The faux
 * cloud runs the Worker's own handler; the provider is a scripted transport.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { seedDemo, DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, type DemoAccount } from '../src/faux/seed.js';
import {
  PROFILE_FLOORS, ROUTING_CONSENT_VERSION, resolvedRoutingSnapshotSchema,
  type AccountScope, type ModelBinding, type ProviderConnection, type RoutingScope,
} from '../../../shared/routing-policy.js';
import { ESCALATION_HEADER, escalationViewSchema, type EscalationControl } from '../../../shared/escalation-controls.js';

const at = '2026-10-05T00:00:00.000Z', until = '2026-11-05T00:00:00.000Z';
let clock: number, cloud: FauxCloud, owner: string, employee: string, outsider: string, routing: string, orgA: string, orgH: string;
let sends: string[];
const connection: ProviderConnection = { id: 'azure-fixture', revision: 1, provider: 'azure-openai', label: 'Synthetic Azure',
  secretRef: 'AZURE_OPENAI_API_KEY', payer: 'company', account: 'fixture-account', enabled: true,
  resource: 'fixture-resource', apiVersion: 'v1', deployments: ['primary'] };
const bindings = { MANAGED_CONNECTIONS: JSON.stringify([connection]), AZURE_OPENAI_API_KEY: 'fixture-company-secret' };
const transport: typeof fetch = async (url) => {
  sends.push(String(url));
  return new Response([
    { id: 'fixture-completion', model: 'synthetic-v1', choices: [{ delta: { content: 'Recorded answer.' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12 } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' } });
};
function binding(): ModelBinding {
  return { connectionId: connection.id, connectionRevision: 1, protocol: 'chat-completions', deployment: 'primary',
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
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function signIn(who: DemoAccount) {
  return (await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD })).body.accessToken as string;
}
const scopePath = (scope: AccountScope) => `${scope.kind}/${scope.id}`;
const org = (): AccountScope => ({ kind: 'organization', id: orgA });
const global = { kind: 'global' } as const;
const tier = () => ({ primary: 'primary', backups: [], fallbackEnabled: false, maxAttempts: 1, cost: { sameOrLower: true, maxAttemptMicroUsd: null, qualityFloor: 0.8 } });
const configuration = () => ({ efficient: tier(), focused: tier(), thorough: tier() });
/** The current revisions of a scope and of the global record, as an editor reads them. */
function revisions(scope: RoutingScope) {
  const policies = cloud.store.snapshot().commercial.policies;
  const latest = (key: string) => Math.max(0, ...policies.filter((row) => (row.scope ? (row.scope.kind === 'global' ? 'global' : `${row.scope.kind}:${row.scope.id}`) : 'global') === key)
    .map((row) => row.revision));
  const key = scope.kind === 'global' ? 'global' : `${scope.kind}:${scope.id}`;
  return { baseRevision: latest(key), baseGlobalRevision: latest('global') };
}
/** A scoped publication: global keeps its routing, an account scope inherits unless routing is given. */
async function publish(scope: RoutingScope, escalation?: EscalationControl | null, extra: Record<string, unknown> = {}) {
  const body = { scope, ...revisions(scope), routing: scope.kind === 'global' ? configuration() : null, note: 'Synthetic publication',
    ...(escalation === undefined ? {} : { escalation }), ...extra };
  const result = await call('POST', '/ops/routing/scopes/publish', routing, body);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body;
}
const ownRecord = (scope: RoutingScope) => {
  const key = scope.kind === 'global' ? undefined : scope.id;
  return cloud.store.snapshot().commercial.policies.filter((row) => (key === undefined ? !row.scope || row.scope.kind === 'global' : row.scope?.kind !== 'global' && row.scope?.id === key))
    .sort((a, b) => b.revision - a.revision)[0];
};
const memberRead = (token = owner, scope = org()) => call('GET', `/account/routing/${scopePath(scope)}/escalation`, token);
const ALL = ['efficient', 'focused', 'thorough'];

async function managed(headers: Record<string, string> = {}, token = owner) {
  const scope = org(), job = `job-${Math.random().toString(36).slice(2, 10)}`;
  const admission = await call('POST', `/account/routing/${scopePath(scope)}/admit`, token, { surface: 'conversation', routeKind: 'managed', rootJobId: job });
  const snapshot = await call('GET', `/account/routing/${scopePath(scope)}/policy`, token);
  expect(admission.status, JSON.stringify(admission.body)).toBe(200);
  expect(snapshot.status).toBe(200);
  const p = snapshot.body;
  const response = await cloud.handle(new Request('http://127.0.0.1:8795/managed/v1/responses', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-nectovia-scope-kind': scope.kind, 'x-nectovia-organization': scope.id,
    'x-nectovia-admission': admission.body.admissionId, 'x-nectovia-job': job, 'x-nectovia-attempt': `${job}-attempt`,
    'x-nectovia-tier': 'efficient', 'x-nectovia-usage-class': 'metered-work', 'x-nectovia-protocol': p.protocol,
    'x-nectovia-policy-revision': String(p.revision), 'x-nectovia-global-revision': String(p.globalRevision),
    'x-nectovia-scope-revision': String(p.scopeRevision), 'x-nectovia-preference-revision': String(p.preferenceRevision),
    'x-nectovia-route-revision': String(p.tiers.efficient?.entryRevision ?? 1), 'x-nectovia-checkpoint': 'portable', ...headers,
  }, body: JSON.stringify({ model: p.tiers.efficient?.model ?? 'synthetic-v1', input: [{ role: 'user', content: 'Hello.' }], max_output_tokens: 512, stream: true, store: false }) }));
  const text = await response.text();
  await cloud.idle();
  return { status: response.status, text };
}
const holds = () => cloud.store.snapshot().funding.attempts.length;

beforeEach(async () => {
  clock = Date.parse(at); sends = [];
  cloud = await createFauxCloud({ file: null, now: () => clock, passwordIterations: 1000, managed: { transport, bindings, idleTimeoutMs: 50 } });
  ({ juniper: orgA, harbor: orgH } = (await seedDemo(cloud)).organizations!);
  owner = await signIn('owner'); employee = await signIn('employee'); outsider = await signIn('harborOwner'); routing = await signIn('staffRouting');
  const saved = await call('POST', '/ops/routes', routing, { id: 'primary', provider: 'azure-openai', model: 'synthetic-v1', label: 'Primary',
    region: 'US', processing: 'Transport fixture only', status: 'qualified', evidence: 'Transport fixture only', binding: binding() });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const accepted = await call('POST', `/account/routing/${scopePath(org())}/preference`, owner, { scope: org(), baseRevision: 0,
    profile: 'strict', restrictions: PROFILE_FLOORS.strict, exceptions: [], consentVersion: ROUTING_CONSENT_VERSION, acknowledge: true });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  // The global routing record, versioned, with no escalation control.
  await publish(global);
});
afterEach(async () => { await cloud.idle(); });

describe('the escalation control a scope gets', () => {
  it('comes from the scope over the global record over the default, in the member read and the Ops view', async () => {
    expect(await memberRead()).toEqual({ status: 200, body: { enabled: true, tiers: ALL, source: 'default', scopeRevision: 0, globalRevision: 2 } });

    await publish(global, { enabled: true, tiers: ['efficient', 'focused'] });
    expect((await memberRead()).body).toEqual({ enabled: true, tiers: ['efficient', 'focused'], source: 'global', scopeRevision: 0, globalRevision: 3 });

    await publish(org(), { enabled: false, tiers: [] });
    const own = await memberRead(employee);
    expect(own.body).toEqual({ enabled: false, tiers: [], source: 'scope', scopeRevision: 1, globalRevision: 3 });
    expect(() => escalationViewSchema.parse(own.body)).not.toThrow();

    const view = await call('GET', `/ops/routing/scopes/organization/${orgA}`, routing);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ inherited: true, escalation: { enabled: false, tiers: [] },
      effectiveEscalation: { enabled: false, tiers: [], source: 'scope', scopeRevision: 1, globalRevision: 3 } });
    const top = await call('GET', '/ops/routing/scopes/global', routing);
    expect(top.body).toMatchObject({ escalation: { enabled: true, tiers: ['efficient', 'focused'] },
      effectiveEscalation: { enabled: true, tiers: ['efficient', 'focused'], source: 'global', scopeRevision: 3, globalRevision: 3 } });

    // A scope with no record of its own answers null for its own control, and the global one applies.
    const recordless = await call('GET', `/ops/routing/scopes/organization/${orgH}`, routing);
    expect(recordless.body).toMatchObject({ escalation: null,
      effectiveEscalation: { enabled: true, tiers: ['efficient', 'focused'], source: 'global', scopeRevision: 0, globalRevision: 3 } });
  });

  it('keeps the control when a publish omits it, clears it with null, and sets it with an object', async () => {
    await publish(global, { enabled: true, tiers: ['thorough'] });
    expect(ownRecord(global).escalation).toEqual({ enabled: true, tiers: ['thorough'] });
    // An older Operations build sends no escalation field: the control is carried to the new revision.
    await publish(global);
    expect(ownRecord(global)).toMatchObject({ revision: 4, escalation: { enabled: true, tiers: ['thorough'] } });
    // Null clears it, and the default applies again.
    await publish(global, null);
    expect(ownRecord(global).revision).toBe(5);
    expect(Object.hasOwn(ownRecord(global), 'escalation')).toBe(false);
    expect((await memberRead()).body).toMatchObject({ enabled: true, tiers: ALL, source: 'default', globalRevision: 5 });
  });

  it('lets an inherited account scope carry its own control and stay inherited', async () => {
    await publish(org(), { enabled: true, tiers: ['focused'] });
    expect(ownRecord(org())).toMatchObject({ revision: 1, inherit: true, escalation: { enabled: true, tiers: ['focused'] } });
    await publish(org());
    expect(ownRecord(org())).toMatchObject({ revision: 2, inherit: true, escalation: { enabled: true, tiers: ['focused'] } });
    const snapshot = await call('GET', `/account/routing/${scopePath(org())}/policy`, owner);
    expect(snapshot.body).toMatchObject({ inherited: true, scopeRevision: 2 });
    expect(snapshot.body.tiers.efficient).toMatchObject({ entryId: 'primary' });
  });

  it('previews the would-be record’s control without writing it', async () => {
    await publish(org(), { enabled: true, tiers: ['focused'] });
    const before = cloud.store.snapshot().commercial.policies.length;
    const preview = await call('POST', '/ops/routing/scopes/preview', routing,
      { scope: org(), ...revisions(org()), routing: null, note: 'Turn escalation off', escalation: { enabled: false, tiers: [] } });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ escalation: { enabled: false, tiers: [] },
      effectiveEscalation: { enabled: false, tiers: [], source: 'scope', scopeRevision: 2, globalRevision: 2 } });
    const kept = await call('POST', '/ops/routing/scopes/preview', routing, { scope: org(), ...revisions(org()), routing: null, note: 'Same control' });
    expect(kept.body).toMatchObject({ escalation: { enabled: true, tiers: ['focused'] }, effectiveEscalation: { source: 'scope', tiers: ['focused'] } });
    const cleared = await call('POST', '/ops/routing/scopes/preview', routing, { scope: global, ...revisions(global), routing: configuration(), note: 'No global control', escalation: null });
    expect(cleared.body).toMatchObject({ escalation: null, effectiveEscalation: { source: 'default', scopeRevision: 3, globalRevision: 3 } });
    expect(cloud.store.snapshot().commercial.policies.length).toBe(before);
  });

  it('rolls back the whole record, its control included', async () => {
    await publish(org());
    await publish(org(), { enabled: false, tiers: [] });
    const rollback = (toRevision: number) => call('POST', '/ops/routing/scopes/rollback', routing,
      { scope: org(), ...revisions(org()), toRevision, note: `Back to revision ${toRevision}` });
    expect((await rollback(1)).status).toBe(201);
    expect(ownRecord(org())).toMatchObject({ revision: 3, kind: 'rollback', basedOn: 1, inherit: true });
    expect(Object.hasOwn(ownRecord(org()), 'escalation')).toBe(false);
    expect((await memberRead()).body).toMatchObject({ enabled: true, source: 'default', scopeRevision: 3 });
    expect((await rollback(2)).status).toBe(201);
    expect(ownRecord(org())).toMatchObject({ revision: 4, basedOn: 2, escalation: { enabled: false, tiers: [] } });
    expect((await memberRead()).body).toMatchObject({ enabled: false, source: 'scope', scopeRevision: 4 });
  });

  it('refuses a control the contract refuses', async () => {
    for (const escalation of [{ enabled: true, tiers: [] }, { enabled: true, tiers: ['efficient', 'efficient'] }, { enabled: true, tiers: ['fast'] }, { enabled: 'yes', tiers: [] }]) {
      const refused = await call('POST', '/ops/routing/scopes/publish', routing, { scope: org(), ...revisions(org()), routing: null, note: 'Bad control', escalation });
      expect(refused.status).toBe(422);
    }
    expect(ownRecord(org())).toBeUndefined();
  });
});

describe('the member read', () => {
  it('answers members of the scope only', async () => {
    expect((await memberRead(employee)).status).toBe(200);
    const refused = await memberRead(outsider);
    expect(refused).toEqual({ status: 403, body: { error: 'This account is unavailable to this person.', code: 'scope_forbidden' } });
    expect((await call('GET', `/account/routing/${scopePath(org())}/escalation`)).status).toBe(401);
    expect((await call('POST', `/account/routing/${scopePath(org())}/escalation`, owner, {})).status).toBe(404);
  });

  it('leaves the strict routing snapshot as it was', async () => {
    await publish(org(), { enabled: false, tiers: [] });
    const snapshot = await call('GET', `/account/routing/${scopePath(org())}/policy`, owner);
    expect(snapshot.status).toBe(200);
    expect(() => resolvedRoutingSnapshotSchema.parse(snapshot.body)).not.toThrow();
    expect(JSON.stringify(snapshot.body)).not.toContain('escalation');
  });
});

describe('the managed gateway', () => {
  it('refuses an escalated call its control turns off, before any hold or send', async () => {
    await publish(org(), { enabled: false, tiers: [] });
    const off = await managed({ [ESCALATION_HEADER]: 'worker' });
    expect(off.status).toBe(403);
    expect(JSON.parse(off.text)).toEqual({ error: { code: 'escalation_off', message: 'Handing work to Nectovia is turned off for this account.' } });

    await publish(org(), { enabled: true, tiers: ['focused', 'thorough'] });
    const tierOff = await managed({ [ESCALATION_HEADER]: 'advisor' });
    expect(tierOff.status).toBe(403);
    expect(JSON.parse(tierOff.text)).toEqual({ error: { code: 'escalation_tier_off', message: 'Handing work to Nectovia Efficient is turned off for this account.' } });
    expect(sends).toEqual([]);
    expect(holds()).toBe(0);
  });

  it('refuses an escalation header that names no role it knows', async () => {
    for (const value of ['lead', 'Worker', '']) {
      const refused = await managed({ [ESCALATION_HEADER]: value });
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text)).toEqual({ error: { code: 'invalid_header', message: 'The X-Nectovia-Escalation header must name worker or advisor.' } });
    }
    expect(sends).toEqual([]);
    expect(holds()).toBe(0);
  });

  it('sends an escalated call its control allows, and leaves calls without the header as they were', async () => {
    await publish(global, { enabled: true, tiers: ['efficient'] });
    const allowed = await managed({ [ESCALATION_HEADER]: 'worker' });
    expect(allowed.status, allowed.text).toBe(200);
    expect(allowed.text).toContain('Recorded answer.');
    expect(sends).toHaveLength(1);

    // Turned off for this account: escalated calls stop, and a call without the header goes on as before.
    await publish(org(), { enabled: false, tiers: [] });
    expect((await managed({ [ESCALATION_HEADER]: 'worker' })).status).toBe(403);
    const plain = await managed();
    expect(plain.status, plain.text).toBe(200);
    expect(plain.text).toContain('Recorded answer.');
    expect(sends).toHaveLength(2);
    expect(holds()).toBe(2);
  });
});

describe('a publish that keeps the routing and changes the control', () => {
  const dayAfter = '2026-10-06T00:00:00.000Z';
  /** A second route whose qualification ends a day after `at`; its other evidence runs to `until`. */
  async function saveExpiringRoute() {
    const saved = await call('POST', '/ops/routes', routing, { id: 'expiring', provider: 'azure-openai', model: 'synthetic-v1', label: 'Expiring',
      region: 'US', processing: 'Transport fixture only', status: 'qualified', evidence: 'Transport fixture only',
      binding: { ...binding(), qualification: { id: 'synthetic-qualification', evidence: 'Transport fixture only', validUntil: dayAfter,
        tiers: ['efficient', 'focused', 'thorough'], qualityFloor: 0.9 } } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  }
  /** The next day: the expiring route's qualification has ended. Sign-ins last minutes, so people sign in again. */
  async function qualificationEnds() {
    clock = Date.parse(dayAfter) + 60_000;
    owner = await signIn('owner'); routing = await signIn('staffRouting');
  }
  const onExpiring = () => ({ ...configuration(), efficient: { ...tier(), primary: 'expiring' } });

  it('turns escalation off while a published route’s qualification has expired', async () => {
    await saveExpiringRoute();
    await publish(global, undefined, { routing: onExpiring() });
    await publish(org(), undefined, { routing: onExpiring() });
    await qualificationEnds();
    // The same routing with its keys in another order, as jsonb hands them back, and escalation turned off.
    const reordered = Object.fromEntries(Object.entries(onExpiring()).reverse()
      .map(([name, policy]) => [name, Object.fromEntries(Object.entries(policy).reverse())]));
    await publish(global, { enabled: false, tiers: [] }, { routing: reordered });
    await publish(org(), { enabled: false, tiers: [] }, { routing: reordered });
    expect(ownRecord(global)).toMatchObject({ revision: 4, escalation: { enabled: false, tiers: [] } });
    expect(ownRecord(org())).toMatchObject({ revision: 2, inherit: false, escalation: { enabled: false, tiers: [] } });
    expect((await memberRead()).body).toEqual({ enabled: false, tiers: [], source: 'scope', scopeRevision: 2, globalRevision: 4 });
  });

  it('still refuses an unqualified route when one tier’s primary changes', async () => {
    await saveExpiringRoute();
    await qualificationEnds();
    const refusal = { status: 422, body: { error: 'Route expiring needs current qualification, access, privacy, health and price evidence before publication.' } };
    expect(await call('POST', '/ops/routing/scopes/publish', routing, { scope: global, ...revisions(global), routing: onExpiring(),
      note: 'Synthetic publication', escalation: { enabled: false, tiers: [] } })).toEqual(refusal);
    expect(await call('POST', '/ops/routing/scopes/publish', routing, { scope: org(), ...revisions(org()), routing: onExpiring(),
      note: 'Synthetic publication', escalation: { enabled: false, tiers: [] } })).toEqual(refusal);
    expect(ownRecord(global).revision).toBe(2);
    expect(ownRecord(org())).toBeUndefined();
  });
});
