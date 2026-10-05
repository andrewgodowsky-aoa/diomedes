/**
 * POST /ops/routes/:id/checks (DIO-217) on the faux cloud: the Worker's own handler, store and staff
 * rules, with the scripted route check provider as its only transport. Nothing here reaches a network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFauxCloud, type FauxCloud, type FauxCloudOptions } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';
import {
  FAUX_AWS_CONNECTION,
  fauxRouteCheckEnvironment,
  fauxRouteCheckRoutes,
  scriptedRouteChecksFetch,
  type ScriptedRouteChecksOptions,
} from '../src/faux/route-checks.js';
import { RouteChecksService, planRouteChecks, postgresRouteCheckSpend, routeCheckSpendOf, stateRouteCheckSpend } from '../src/route-checks.js';
import type { CommercialRepository, CommercialTransaction } from '../src/commercial.js';
import { ROUTE_CHECKS_REFUSALS, routeChecksPath, type RouteChecksRefusal, type RouteChecksResult } from '../../../shared/gateway-route-checks.js';
import { routeQualificationReceiptSchema } from '../../../shared/route-qualification.js';
import { read, recording, runtimeGrants } from './support/runtime-grants.js';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const KEY = 'endpoint-test-key-0123456789abcdef';
let cloud: FauxCloud;
let sends: string[] = [];

afterEach(() => { vi.restoreAllMocks(); });

/** A seeded faux cloud whose route checks provider is the scripted one, with every request it gets counted. */
async function open(options: { managed?: FauxCloudOptions['managed']; script?: ScriptedRouteChecksOptions } = {}) {
  sends = [];
  const scripted = scriptedRouteChecksFetch({ now: () => NOW, ...options.script });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sends.push(request.url);
    return scripted(request);
  }) as typeof globalThis.fetch;
  cloud = await createFauxCloud({ file: null, now: () => NOW, passwordIterations: 1_000,
    managed: { credential: KEY, routeChecksTransport: transport, ...options.managed } });
  expect((await seedDemo(cloud)).seeded).toBe(true);
}

async function call(method: string, pathname: string, token?: string, body?: unknown) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await cloud.handle(new Request(`http://127.0.0.1:8795${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function token(who: DemoAccount) {
  const result = await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD });
  expect(result.status).toBe(200);
  return result.body.accessToken as string;
}
const checks = (routeId: string, bearer: string, baseRevision = 1) => call('POST', routeChecksPath(routeId), bearer, { baseRevision });
const audits = () => cloud.store.snapshot().commercial.audit.filter((row) => row.action === 'route.checked');
const routeRow = (id: string) => cloud.store.snapshot().commercial.routes.find((row) => row.id === id);
const refused = (answer: { status: number; body: { code?: string; error?: string } }, code: RouteChecksRefusal) => {
  expect(answer.status).toBe(ROUTE_CHECKS_REFUSALS[code]);
  expect(answer.body).toEqual({ code, error: expect.any(String) });
};
const seededRoutes = () => fauxRouteCheckRoutes(new Date(NOW).toISOString());

describe('POST /ops/routes/:id/checks', () => {
  it('runs the checks on the seeded K3 and Sol routes, answers the result, and writes one audit row per run', async () => {
    await open();
    const routing = await token('staffRouting');
    const before = routeRow('aws-kimi-k3');
    const k3 = await checks('aws-kimi-k3', routing);
    expect(k3.status).toBe(200);
    const result = k3.body as RouteChecksResult;
    expect(() => routeQualificationReceiptSchema.parse(result.receipt)).not.toThrow();
    expect(result).toMatchObject({
      routeId: 'aws-kimi-k3', routeRevision: 1, qualifies: { ok: true }, uncertainMicroUsd: 0,
      receipt: { route: 'aws-bedrock', connectionId: 'aws-bedrock-us-east-1', connectionRevision: 1, model: 'us.moonshotai.kimi-k3',
        protocol: 'openai-chat-completions', rateCard: before!.binding!.price.version, createdAt: '2026-10-05T12:00:00.000Z' },
    });
    expect(result.evidence).toBe(`Route checks ${result.receipt.id}, audit ${result.auditId}, 2026-10-05.`);
    expect(result.spentMicroUsd).toBeGreaterThan(0);
    expect(result.boundMicroUsd).toBeGreaterThan(result.spentMicroUsd);
    expect(sends).toHaveLength(6);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      id: result.auditId, at: '2026-10-05T12:00:00.000Z', action: 'route.checked', organizationId: null,
      targetKind: 'route', targetId: 'aws-kimi-k3', actorRole: 'routing', reason: result.evidence,
    });
    expect(audits()[0].detail).toEqual({ receipt: result.receipt, routeRevision: 1,
      boundMicroUsd: result.boundMicroUsd, spentMicroUsd: result.spentMicroUsd, uncertainMicroUsd: 0 });
    // The run writes nothing to the route: the person records the evidence themselves.
    expect(routeRow('aws-kimi-k3')).toEqual(before);

    const sol = await checks('azure-sol-6-1', routing);
    expect(sol.status).toBe(200);
    expect(sol.body).toMatchObject({ routeId: 'azure-sol-6-1', qualifies: { ok: true },
      receipt: { route: 'azure-openai', connectionId: 'azure-foundry-dev', deployment: 'gpt-6.1-sol', protocol: 'openai-responses' } });
    expect(sends).toHaveLength(12);
    expect(audits()).toHaveLength(2);
    // The audit log reads both rows back, and an earlier run's spend counts for the next.
    const log = await call('GET', '/ops/audit', routing);
    expect(log.status).toBe(200);
    expect((log.body as { action: string }[]).filter((row) => row.action === 'route.checked')).toHaveLength(2);
    expect(routeCheckSpendOf(audits())).toBe(result.spentMicroUsd + (sol.body as RouteChecksResult).spentMicroUsd);
  });

  it('refuses with the contract statuses and codes before anything is sent or written', async () => {
    await open();
    const routing = await token('staffRouting');
    for (const who of ['staffBilling', 'staffSupport', 'employee'] as const) refused(await checks('aws-kimi-k3', await token(who)), 'forbidden');
    refused(await checks('no-such-route', routing), 'unknown_route');
    refused(await call('POST', '/ops/routes/%E0%A4%A/checks', routing, { baseRevision: 1 }), 'unknown_route');
    refused(await checks('aws-kimi-k3', routing, 2), 'route_changed');
    // A route with no binding has nothing to check.
    refused(await checks('aws-luna-5-6', routing), 'route_not_checkable');

    const [k3, sol] = seededRoutes();
    const save = async (entry: unknown) => expect((await call('POST', '/ops/routes', routing, entry)).status).toBe(200);
    await save({ ...k3, id: 'aws-kimi-k3-retired', status: 'retired' });
    refused(await checks('aws-kimi-k3-retired', routing), 'route_not_checkable');
    await save({ ...k3, id: 'aws-kimi-k3-short', binding: { ...k3.binding, capabilities: { ...k3.binding.capabilities, outputTokens: 256 } } });
    const short = await checks('aws-kimi-k3-short', routing);
    refused(short, 'route_not_checkable');
    expect(short.body.error).toBe('The checks cannot be sent on this route. A bounded supported output limit is required.');
    await save({ ...k3, id: 'aws-kimi-k3-unpriced', binding: { ...k3.binding, price: { ...k3.binding.price, outputMicroUsdPerMillion: 0 } } });
    refused(await checks('aws-kimi-k3-unpriced', routing), 'price_missing');
    await save({ ...sol, id: 'azure-claude-messages', model: 'claude-opus-5-5', label: 'Claude Opus 5.5',
      binding: { ...sol.binding, protocol: 'messages', deployment: 'claude-opus-5-5', modelVersion: 'claude-opus-5-5',
        capabilities: { ...sol.binding.capabilities, reasoning: false } } });
    refused(await checks('azure-claude-messages', routing), 'protocol_unsupported');

    expect(sends).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it('answers 503 when the connection’s Worker secret is not set', async () => {
    await open({ managed: { credential: null } });
    const answer = await checks('aws-kimi-k3', await token('staffRouting'));
    expect(answer).toEqual({ status: 503, body: { code: 'credential_unavailable', error: 'The Worker secret BEDROCK_API_KEY for this connection is not set or not usable.' } });
    expect(sends).toEqual([]);
  });

  it('refuses a run whose bound would pass the company spend ceiling, counting earlier route checks', async () => {
    const [k3] = seededRoutes();
    const bound = planRouteChecks({ ...k3, v: 1, revision: 1, updatedAt: new Date(NOW).toISOString(), updatedBy: 'person_routing' }, FAUX_AWS_CONNECTION).boundMicroUsd;

    // Nothing spent yet: a ceiling below one run's bound refuses the first run.
    await open({ managed: { settings: { MANAGED_SPEND_CEILING_MICRO_USD: bound - 1 } } });
    refused(await checks('aws-kimi-k3', await token('staffRouting')), 'company_ceiling');
    expect(sends).toEqual([]);

    // Room for exactly one run and a little more: the first run passes, and its own spend refuses the second.
    await open({ managed: { settings: { MANAGED_SPEND_CEILING_MICRO_USD: bound + 1_000 } } });
    const routing = await token('staffRouting');
    const first = await checks('aws-kimi-k3', routing);
    expect(first.status).toBe(200);
    expect(first.body.boundMicroUsd).toBe(bound);
    expect(first.body.spentMicroUsd).toBeGreaterThan(1_000);
    const second = await checks('aws-kimi-k3', routing);
    refused(second, 'company_ceiling');
    expect(second.body.error).toMatch(/^The checks could spend up to \$\d+\.\d{2}\. With company spend and earlier route checks, that would pass the company spend ceiling\.$/);
    expect(sends).toHaveLength(6);
    expect(audits()).toHaveLength(1);

    // A ceiling the Worker cannot read refuses too.
    await open({ managed: { settings: { MANAGED_SPEND_CEILING_MICRO_USD: 'about a dollar' } } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await checks('aws-kimi-k3', await token('staffRouting'))).toEqual({ status: 503, body: { error: 'The company spend ceiling setting cannot be read.' } });
    expect(sends).toEqual([]);
  });

  it('keeps the key out of the answer and the store when the provider echoes it', async () => {
    await open({ script: { intercept: () => Response.json({ error: { message: `Key ${KEY} is not allowed here.` } }, { status: 400 }) } });
    const answer = await checks('aws-kimi-k3', await token('staffRouting'));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ qualifies: { ok: false }, spentMicroUsd: 0, uncertainMicroUsd: 0 });
    expect(answer.body.receipt.checks[0].calls[0].error).toEqual({ code: 'provider_refused', message: 'Key [redacted] is not allowed here.' });
    expect(JSON.stringify(answer.body)).not.toContain(KEY);
    expect(JSON.stringify(cloud.store.snapshot())).not.toContain(KEY);
    expect(audits()).toHaveLength(1);
  });
});

describe('the route checks service', () => {
  const service = (commercial: CommercialRepository = cloud.store.commercial) => new RouteChecksService({
    accounts: cloud.accounts, commercial, spend: stateRouteCheckSpend(cloud.store.funding, cloud.store.commercial),
    transport: scriptedRouteChecksFetch({ now: () => NOW }), now: () => NOW,
  });
  const env = (connections: unknown = JSON.parse(fauxRouteCheckEnvironment().MANAGED_CONNECTIONS)) =>
    ({ MANAGED_CONNECTIONS: JSON.stringify(connections), BEDROCK_API_KEY: KEY });

  it('refuses a route whose connection is not approved here, is disabled, or is on another revision', async () => {
    await open();
    const routing = await token('staffRouting');
    const run = (settings: Record<string, unknown>) => service().run(routing, 'aws-kimi-k3', { baseRevision: 1 }, settings);
    await expect(run({ BEDROCK_API_KEY: KEY })).rejects.toMatchObject({ status: 422, code: 'route_not_checkable',
      message: 'This route’s connection is not an approved company connection.' });
    await expect(run(env([{ ...FAUX_AWS_CONNECTION, revision: 2 }]))).rejects.toMatchObject({ status: 422, code: 'route_not_checkable',
      message: 'This route is bound to another revision of its connection. Save it on the current revision first.' });
    await expect(run(env([{ ...FAUX_AWS_CONNECTION, enabled: false }]))).rejects.toMatchObject({ status: 422, code: 'route_not_checkable',
      message: 'The provider connection is disabled.' });
    expect(audits()).toEqual([]);
  });

  it('answers 500 and logs the run’s spend, never the key, when the audit row cannot be written', async () => {
    await open();
    const failing: CommercialRepository = {
      transaction: (action) => cloud.store.commercial.transaction((tx) => {
        const broken = Object.create(tx) as CommercialTransaction;
        broken.audit = async () => { throw new Error('The audit table is unavailable.'); };
        return action(broken);
      }),
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(service(failing).run(await token('staffRouting'), 'aws-kimi-k3', { baseRevision: 1 }, env())).rejects.toMatchObject({
      status: 500, message: expect.stringMatching(/^The route checks ran, but their record could not be saved\. Their receipt is rq_[0-9a-f]{24}\.$/),
    });
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({ event: 'route-checks-audit-unwritten', routeId: 'aws-kimi-k3', receiptId: expect.stringMatching(/^rq_/),
      boundMicroUsd: expect.any(Number), spentMicroUsd: expect.any(Number), uncertainMicroUsd: 0 });
    expect(line).not.toContain(KEY);
    expect(audits()).toEqual([]);
  });

  it('reads company spend with the ceiling’s own query and earlier runs from their audit rows, on the Worker login', async () => {
    const db = recording((sql) => sql.includes('AS company_spend') ? [{ company_spend: '1200' }] : sql.includes('AS route_checks') ? [{ route_checks: '345' }] : []);
    expect(await postgresRouteCheckSpend(db.factory).read()).toEqual({ companyMicroUsd: 1_200, routeChecksMicroUsd: 345 });
    const spend = db.calls.find((entry) => entry.sql.includes('AS company_spend'))!;
    expect(spend.sql).toMatch(/FROM control_plane\.funding_settlements/);
    expect(spend.sql).toMatch(/FROM control_plane\.funding_reservations WHERE state IN \('pending','uncertain','written-off'\)/);
    const earlier = db.calls.find((entry) => entry.sql.includes('AS route_checks'))!;
    expect(earlier.sql).toMatch(/FROM control_plane\.ops_audit WHERE record->>'action'=\$1/);
    expect(earlier.values).toEqual(['route.checked']);
    // The Worker login (cp_runtime) may read all three tables.
    const granted = runtimeGrants(read('../scripts/runtime-permissions.sql'));
    for (const table of ['funding_settlements', 'funding_reservations', 'ops_audit']) expect(granted.get(table)?.select).toBe(true);
  });
});
