/**
 * Field-named refusals for POST /ops/routes (DIO-198 item 3): every refusal of a route save carries
 * the request body fields it is about as `fields`, an empty list when it is about none, and a body
 * the schema refuses gets one plain sentence per failing field. Runs on the faux cloud's own handler.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';
import { FAUX_AZURE_CONNECTION, fauxRouteCheckRoutes } from '../src/faux/route-checks.js';
import { saveRouteInput } from '../src/commercial.js';
import { AccountError } from '../src/errors.js';
import { BINDING_RULE_SENTENCES, bindingProblemFields, routeInputRefusal } from '../src/route-field-refusals.js';
import { bindingProblems, type CatalogRoute } from '../../../shared/routing-policy.js';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const AT = new Date(NOW).toISOString();
let cloud: FauxCloud;

async function open() {
  cloud = await createFauxCloud({ file: null, now: () => NOW, passwordIterations: 1_000 });
  expect((await seedDemo(cloud)).seeded).toBe(true);
}
async function call(method: string, pathname: string, token?: string, body?: unknown, contentType = 'application/json') {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', contentType);
  const response = await cloud.handle(new Request(`http://127.0.0.1:8795${pathname}`, {
    method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function token(who: DemoAccount) {
  const result = await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD });
  expect(result.status).toBe(200);
  return result.body.accessToken as string;
}
/** The seeded Kimi K3 route as staff send it back, with one change applied. */
function k3(change: (route: ReturnType<typeof fauxRouteCheckRoutes>[number] & Record<string, unknown>) => void = () => {}) {
  const route = structuredClone({ ...fauxRouteCheckRoutes(AT)[0], baseRevision: 1 }) as ReturnType<typeof fauxRouteCheckRoutes>[number] & Record<string, unknown>;
  change(route);
  return route;
}
const refusal = (input: unknown) => {
  const parsed = saveRouteInput.safeParse(input);
  expect(parsed.success).toBe(false);
  const error = routeInputRefusal(parsed.error!.issues, input);
  return { status: error.status, error: error.message, fields: error.fields };
};

describe('a route body the schema refuses', () => {
  it('names each failing field by its request body path, in a plain sentence', () => {
    expect(refusal(k3((route) => { delete (route.binding.price as Partial<typeof route.binding.price>).evidence; })))
      .toEqual({ status: 422, error: 'binding.price.evidence is required.', fields: ['binding.price.evidence'] });
    expect(refusal(k3((route) => { route.binding.price.validUntil = route.binding.price.observedAt; })))
      .toEqual({ status: 422, error: 'binding.price.validUntil must be after binding.price.observedAt.', fields: ['binding.price.validUntil'] });
    expect(refusal(k3((route) => { route.binding.price.inputMicroUsdPerMillion = '5' as unknown as number; })))
      .toEqual({ status: 422, error: 'binding.price.inputMicroUsdPerMillion must be a number.', fields: ['binding.price.inputMicroUsdPerMillion'] });
    expect(refusal(k3((route) => { route.binding.price.outputMicroUsdPerMillion = 1.5; })).error)
      .toBe('binding.price.outputMicroUsdPerMillion must be a whole number.');
    expect(refusal(k3((route) => { route.label = '   '; })).error).toBe('label is required.');
    expect(refusal(k3((route) => { route.label = 'x'.repeat(121); })).error).toBe('label can be at most 120 characters.');
    expect(refusal(k3((route) => { route.status = 'live' as 'qualified'; })).error).toBe('status must be one of qualified, unqualified, retired.');
    expect(refusal(k3((route) => { route.binding.price.observedAt = 'yesterday'; })))
      .toMatchObject({ error: 'binding.price.observedAt must be a UTC date and time, such as 2026-10-05T12:00:00Z.', fields: ['binding.price.observedAt'] });
    expect(refusal(k3((route) => { route.binding.capabilities.contextTokens = -1; })).error).toBe('binding.capabilities.contextTokens must be at least 0.');
  });

  it('names array members with their index, unknown keys by their own path, and a repeated price band', () => {
    const privacy = { connectionRevision: 1, modelVersion: 'us.moonshotai.kimi-k3', protocol: 'chat-completions', evidence: 'Synthetic.',
      validUntil: '2026-11-01T00:00:00.000Z', ingressCountries: ['us'], decryptionCountries: ['US'], processingCountries: [],
      retentionPolicy: 'none', zeroRetention: true, training: false, contentLogging: false, caching: 'off', transientCacheEvidence: null,
      features: ['text'], allowedRetentionModes: [], effectiveRetentionMode: null, regionalEntitlement: false };
    expect(refusal(k3((route) => { route.binding.privacy = privacy as never; }))).toEqual({
      status: 422,
      error: 'binding.privacy.ingressCountries.0 is not in the accepted format. binding.privacy.processingCountries needs at least one entry.',
      fields: ['binding.privacy.ingressCountries.0', 'binding.privacy.processingCountries'],
    });
    expect(refusal(k3((route) => { route.extra = 1; (route.binding as Record<string, unknown>).nope = true; })).fields).toEqual(['binding.nope', 'extra']);
    expect(refusal(k3((route) => { route.extra = 1; })).error).toBe('extra is not a field a route accepts.');
    const band = { aboveInputTokens: 200_000, inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1, reasoningMicroUsdPerMillion: 1,
      cacheReadMicroUsdPerMillion: 1, cacheWriteMicroUsdPerMillion: 1, requestFeeMicroUsd: 0 };
    expect(refusal(k3((route) => { route.binding.price.longContext = [band, band]; }))).toEqual({ status: 422,
      error: 'binding.price.longContext repeats an aboveInputTokens threshold. Each band needs its own.', fields: ['binding.price.longContext'] });
    expect(refusal(k3((route) => { route.binding.reasoning = { kind: 'magic' } as never; })))
      .toMatchObject({ fields: ['binding.reasoning.kind'], error: expect.stringMatching(/^binding\.reasoning\.kind must be one of anthropic-budget, /) });
  });

  it('spells out five fields, counts the rest, and lists every one', () => {
    const result = refusal({});
    expect(result.fields).toEqual(['id', 'provider', 'model', 'label', 'region', 'processing', 'status', 'evidence']);
    expect(result.error).toBe('id is required. provider is required. model is required. label is required. region is required. 3 more fields need fixing.');
    expect(refusal('a route')).toEqual({ status: 422, error: 'The route must be an object.', fields: [] });
  });
});

describe('POST /ops/routes refusals carry their fields', () => {
  it('answers a schema refusal with its fields and keeps the status', async () => {
    await open();
    const routing = await token('staffRouting');
    const answer = await call('POST', '/ops/routes', routing, k3((route) => { route.binding.price.validUntil = route.binding.price.observedAt; }));
    expect(answer).toEqual({ status: 422,
      body: { error: 'binding.price.validUntil must be after binding.price.observedAt.', fields: ['binding.price.validUntil'] } });
    const missing = await call('POST', '/ops/routes', routing, k3((route) => { delete (route.binding.price as Partial<typeof route.binding.price>).evidence; }));
    expect(missing.body).toEqual({ error: 'binding.price.evidence is required.', fields: ['binding.price.evidence'] });
  });

  it('names the binding field a cross-field rule is about', async () => {
    await open();
    const routing = await token('staffRouting');
    const save = (route: unknown) => call('POST', '/ops/routes', routing, route);
    expect(await save(k3((route) => { route.binding.connectionId = 'aws-bedrock-elsewhere'; })))
      .toEqual({ status: 422, body: { error: 'Select an approved company connection.', fields: ['binding.connectionId'] } });
    expect(await save(k3((route) => { route.binding.connectionRevision = 2; })))
      .toEqual({ status: 422, body: { error: 'The model binding does not match the approved connection revision.', fields: ['binding.connectionRevision'] } });
    expect(await save(k3((route) => { route.binding.protocol = 'responses'; })))
      .toEqual({ status: 422, body: { error: 'This AWS model has no approved compatibility evidence for the selected API.', fields: ['binding.protocol'] } });
    expect(await save(k3((route) => { route.model = 'us.moonshotai.kimi-k2'; })))
      .toEqual({ status: 422, body: { error: 'This AWS profile has not been approved on this connection.', fields: ['model'] } });
    expect(await save(k3((route) => { route.status = 'qualified'; route.evidence = ''; })))
      .toEqual({ status: 422, body: { error: 'Say what qualified this route: a live proof, a run or a dated account check.', fields: ['evidence'] } });
    const { binding: _binding, ...unbound } = k3();
    expect(await save(unbound))
      .toEqual({ status: 422, body: { error: 'A versioned binding cannot be removed. Retire the route instead.', fields: ['binding'] } });
  });

  it('names the stale evidence block when the binding identity changes without fresh evidence', async () => {
    await open();
    const routing = await token('staffRouting');
    const access = { state: 'unverified' as const, evidence: 'Synthetic access check.', validUntil: '2026-11-01T00:00:00.000Z', availableRequests: null };
    const first = await call('POST', '/ops/routes', routing, k3((route) => { route.binding.access = access; }));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const changed = await call('POST', '/ops/routes', routing, k3((route) => {
      route.baseRevision = 2; route.binding.access = access; route.binding.modelVersion = 'us.moonshotai.kimi-k3-v2';
    }));
    expect(changed).toEqual({ status: 422,
      body: { error: 'Changing the binding requires fresh access evidence or an explicitly unverified state.', fields: ['binding.access'] } });
  });

  it('answers fields: [] when a refusal is about no field, and leaves other endpoints’ refusals as they were', async () => {
    await open();
    const routing = await token('staffRouting');
    expect(await call('POST', '/ops/routes', routing, k3((route) => { route.baseRevision = 7; })))
      .toEqual({ status: 409, body: { error: 'Someone changed this route since you opened it. Reload and try again.', fields: [] } });
    const billing = await call('POST', '/ops/routes', await token('staffBilling'), k3());
    expect(billing).toEqual({ status: 403, body: { error: expect.any(String), fields: [] } });
    expect(await call('POST', '/ops/routes', routing, 'id=aws-kimi-k3', 'text/plain'))
      .toEqual({ status: 415, body: { error: 'Use a JSON request body.', fields: [] } });
    expect(await call('POST', '/ops/routes', routing, '{"id":', 'application/json'))
      .toEqual({ status: 422, body: { error: 'The JSON request body is invalid.', fields: [] } });
    const publish = await call('POST', '/ops/routing/publish', routing, { tiers: { efficient: null, focused: null, thorough: null }, note: 'x', baseRevision: 'one' });
    expect(publish).toEqual({ status: 422, body: { error: 'The account request contains invalid or unexpected fields.' } });
  });

  it('refuses the same way when the service is called directly', async () => {
    await open();
    const routing = await token('staffRouting');
    const bad = k3((route) => { route.binding.price.validUntil = route.binding.price.observedAt; });
    const error = await cloud.commercial.saveRoute(routing, bad as never, cloud.connectionSettings).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountError);
    const refused = error as AccountError;
    expect({ status: refused.status, message: refused.message, fields: refused.fields })
      .toEqual({ status: 422, message: 'binding.price.validUntil must be after binding.price.observedAt.', fields: ['binding.price.validUntil'] });
  });
});

describe('the binding rule fields', () => {
  it('cover every sentence bindingProblems can answer', () => {
    const source = readFileSync(new URL('../../../shared/routing-policy.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export function bindingProblems'), source.indexOf('export function routeEligibility'));
    const sentences = [...body.matchAll(/fail\('([^']+)'\)/g)].map((match) => match[1]);
    expect(sentences.length).toBeGreaterThan(10);
    expect([...BINDING_RULE_SENTENCES].sort()).toEqual([...new Set(sentences)].sort());
  });

  it('name the Azure deployment or protocol that is not approved', () => {
    const sol = { ...fauxRouteCheckRoutes(AT)[1], revision: 1 } as CatalogRoute;
    const withBinding = (change: Partial<NonNullable<CatalogRoute['binding']>>) => ({ ...sol, binding: { ...sol.binding!, ...change } });
    const fieldsOf = (route: CatalogRoute) => {
      const [problem] = bindingProblems(route, FAUX_AZURE_CONNECTION);
      return bindingProblemFields(problem.message, route, FAUX_AZURE_CONNECTION);
    };
    expect(fieldsOf(withBinding({ deployment: 'gpt-6.1-sol-unknown' }))).toEqual(['binding.deployment']);
    // With reasoning on, a protocol outside Responses and Chat Completions breaks the reasoning rule first.
    expect(fieldsOf(withBinding({ protocol: 'converse' }))).toEqual(['binding.reasoning']);
    expect(fieldsOf(withBinding({ protocol: 'converse', capabilities: { ...sol.binding!.capabilities, reasoning: false } }))).toEqual(['binding.protocol']);
    expect(fieldsOf({ ...sol, provider: 'aws-bedrock' })).toEqual(['provider']);
    expect(bindingProblemFields('A rule this table does not know yet.', sol, FAUX_AZURE_CONNECTION)).toEqual(['binding']);
  });
});
