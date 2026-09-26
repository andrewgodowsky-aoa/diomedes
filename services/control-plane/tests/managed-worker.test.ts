import { describe, expect, it, vi } from 'vitest';
import type { Configuration } from '../src/config.js';
import { createFauxCloud } from '../src/faux/cloud.js';
import { FAUX_ISSUER } from '../src/faux/identity.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../src/faux/seed.js';
import { MANAGED_PROVIDERS, scriptedResponsesFetch } from '../src/managed-providers.js';
import { createHandler } from '../src/worker.js';
import { validEnv } from './support/fixtures.js';
import { providerSpy, readAll } from './support/managed.js';

const LUNA = MANAGED_PROVIDERS[0];
const now = () => Date.parse('2026-09-25T12:00:00.000Z');
const config: Configuration = {
  environment: 'local', origins: ['http://127.0.0.1:8791'], databaseUrl: 'faux://local-store', fundingDatabaseUrl: 'faux://local-store',
  identity: { clientId: 'faux', issuer: FAUX_ISSUER, audience: 'faux', apiKey: 'faux' },
};

async function setup() {
  const scripted = scriptedResponsesFetch({ now });
  const spy = providerSpy((request) => scripted(request.url, { method: 'POST', headers: request.headers, body: request.rawBody }));
  const cloud = await createFauxCloud({ file: null, now, passwordIterations: 1_000, managed: { transport: spy.fetch } });
  const { organizations } = await seedDemo(cloud);
  const signIn = await cloud.handle(new Request('http://faux/auth/sign-in', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO_ACCOUNTS.employee.email, password: FAUX_DEMO_PASSWORD }),
  }));
  const token = (await signIn.json()).accessToken as string;
  const admitted = await cloud.commercial.admitAgent(token, organizations!.juniper, { surface: 'conversation', routeKind: 'managed', rootJobId: 'run-1' });
  const handler = createHandler(() => cloud.accounts, undefined, {
    configuration: () => config, createCommercial: () => cloud.commercial, createManaged: () => cloud.managed,
  });
  const request = (attempt: string, init: { origin?: string } = {}) => new Request('http://127.0.0.1:8791/managed/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.origin ? { origin: init.origin } : {}),
      'x-nectovia-organization': organizations!.juniper, 'x-nectovia-admission': admitted.admissionId, 'x-nectovia-job': 'run-1',
      'x-nectovia-attempt': attempt, 'x-nectovia-tier': 'efficient', 'x-nectovia-usage-class': 'included-chat', 'x-nectovia-policy-revision': '1',
    },
    body: JSON.stringify({ model: LUNA.model, input: [{ role: 'user', content: 'Hello.' }], store: false, stream: true }),
  });
  return { cloud, spy, handler, request };
}

describe('the Worker entry for managed inference', () => {
  it('reads BEDROCK_API_KEY from the Worker environment at call time, and settles under ctx.waitUntil', async () => {
    const { cloud, spy, handler, request } = await setup();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } };
    const first = await handler(request('run-1:1'), { BEDROCK_API_KEY: 'ABSK-first-key' }, ctx);
    expect(first.status).toBe(200);
    await readAll(first.body);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(cloud.store.snapshot().funding.attempts[0].state).toBe('settled');
    const second = await handler(request('run-1:2'), { BEDROCK_API_KEY: 'ABSK-second-key' }, ctx);
    await readAll(second.body);
    await Promise.all(waits);
    expect(spy.calls.map((call) => call.headers.authorization)).toEqual(['Bearer ABSK-first-key', 'Bearer ABSK-second-key']);
    const missing = await handler(request('run-1:3'), {}, ctx);
    expect(missing.status).toBe(503);
    expect(spy.calls).toHaveLength(2);
  });

  it('answers every managed refusal in the managed error shape, before configuration and at the edge', async () => {
    const unconfigured = await createHandler()(new Request('http://127.0.0.1:8791/managed/v1/responses', { method: 'POST' }), {});
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: { code: 'unavailable', message: expect.any(String) } });

    const { handler, request, spy } = await setup();
    const refusedOrigin = await handler(request('run-1:1', { origin: 'https://evil.example' }), {});
    expect(refusedOrigin.status).toBe(403);
    expect((await refusedOrigin.json()).error.code).toBe('origin_refused');
    const query = await handler(new Request('http://127.0.0.1:8791/managed/v1/responses?key=x', { method: 'POST' }), {});
    expect([query.status, (await query.json()).error.code]).toEqual([400, 'invalid_request']);
    const wrongMethod = await handler(new Request('http://127.0.0.1:8791/managed/v1/responses'), {});
    expect([wrongMethod.status, (await wrongMethod.json()).error.code]).toEqual([405, 'method_not_allowed']);
    const unknown = await handler(new Request('http://127.0.0.1:8791/managed/v1/chat/completions', { method: 'POST' }), {});
    expect([unknown.status, (await unknown.json()).error.code]).toEqual([404, 'not_found']);
    expect(spy.calls).toHaveLength(0);
    // The account routes keep their own shape.
    const account = await createHandler()(new Request('http://127.0.0.1:8791/account/session'), validEnv);
    expect((await account.json()).error).toEqual(expect.any(String));
  });

  it('reads MANAGED_MAX_OUTPUT_TOKENS and MANAGED_SPEND_CEILING_MICRO_USD from the Worker environment at call time', async () => {
    const { spy, handler, request } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { BEDROCK_API_KEY: 'ABSK-key', MANAGED_MAX_OUTPUT_TOKENS: '2000', MANAGED_SPEND_CEILING_MICRO_USD: '0' };
    const refused = await handler(request('run-1:1'), env);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('x-nectovia-max-output')).toBe('2000');
    expect(await refused.json()).toEqual({ error: { code: 'route_unavailable', message: 'Nectovia’s model service isn’t available right now. Nothing was charged.' } });
    expect(spy.calls).toHaveLength(0);
    // Numbers are read too, as a JSON var would arrive.
    const passed = await handler(request('run-1:2'), { ...env, MANAGED_MAX_OUTPUT_TOKENS: 1_500, MANAGED_SPEND_CEILING_MICRO_USD: 100_000_000 });
    expect(passed.status).toBe(200);
    await readAll(passed.body);
    expect(spy.calls.map((call) => call.body.max_output_tokens)).toEqual([1_500]);
    warn.mockRestore();
  });
});
