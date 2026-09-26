/**
 * Which database login each part of the Worker uses, through the production
 * factories in worker.ts. Every Neon client is replaced by a recording one, so
 * each statement is attributed to the connection string it was sent on.
 *
 * - The managed gateway's funding repository runs on FUNDING_DATABASE_URL
 *   (cp_funding): its reads and its writes.
 * - Everything else stays on DATABASE_URL (cp_runtime): the gateway's
 *   admission, grant and routing reads, the usage projection and the
 *   commercial routes.
 * - Without a readable FUNDING_DATABASE_URL, every managed call answers 503
 *   route_unavailable before any statement or provider call, and nothing else
 *   changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../src/faux/seed.js';
import { ROUTE_UNAVAILABLE } from '../src/managed-inference.js';
import { MANAGED_PROVIDERS } from '../src/managed-providers.js';
import { createHandler } from '../src/worker.js';
import { validEnv } from './support/fixtures.js';

const db = vi.hoisted(() => ({
  log: [] as { url: string; sql: string }[],
  answer: (async () => []) as (url: string, sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>,
}));

vi.mock('../src/postgres.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/postgres.js')>();
  return {
    ...actual,
    neonClientFactory: (url: string) => () => ({
      async connect() {},
      async end() {},
      async query(sql: string, values: unknown[] = []) {
        db.log.push({ url, sql });
        const rows = await db.answer(url, sql, values);
        return { rows, rowCount: rows.length };
      },
    }),
  };
});

const DATABASE_URL = validEnv.DATABASE_URL;
const FUNDING_URL = 'postgresql://cp_funding:fixture_password@ep-fixture.us-east-2.aws.neon.tech/neondb?sslmode=require';
const FUNDING_TABLES = new Set(['credit_periods', 'funded_jobs', 'funded_job_refs', 'job_cap_requests', 'funding_accounts',
  'funding_reservations', 'funding_settlements', 'credit_adjustments', 'credit_topups']);
const LUNA = MANAGED_PROVIDERS[0];

let cloud: FauxCloud;
let organizationId: string;
let token: string;
let admissionId: string;
let fetchSpy: ReturnType<typeof vi.fn>;

/** Tables each connection string's statements named, in order of first use. */
function tablesOn(url: string): string[] {
  return [...new Set(db.log.filter((entry) => entry.url === url)
    .flatMap((entry) => [...entry.sql.matchAll(/\bcontrol_plane\.(\w+)/g)].map((match) => match[1])))];
}
const statementsOn = (url: string) => db.log.filter((entry) => entry.url === url).map((entry) => entry.sql.replace(/\s+/g, ' '));

beforeEach(async () => {
  fetchSpy = vi.fn(async () => { throw new Error('No provider call is expected here.'); });
  vi.stubGlobal('fetch', fetchSpy);
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  organizationId = (await seedDemo(cloud)).organizations!.juniper;
  const signIn = await cloud.handle(new Request('http://faux/auth/sign-in', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO_ACCOUNTS.employee.email, password: FAUX_DEMO_PASSWORD }),
  }));
  token = (await signIn.json()).accessToken as string;
  admissionId = (await cloud.commercial.admitAgent(token, organizationId, { surface: 'conversation', routeKind: 'managed', rootJobId: 'run-1' })).admissionId;
  // The Worker login's database holds the seeded account, grant and routing rows; the funding login's is empty.
  db.log.length = 0;
  db.answer = async (url, sql, values) => {
    if (url !== DATABASE_URL) return [];
    return cloud.store.commercial.transaction(async (tx) => {
      if (sql.includes('FROM control_plane.agent_admissions')) {
        const record = await tx.admission(String(values[0]), String(values[1]));
        return record ? [{ record }] : [];
      }
      if (sql.includes('FROM control_plane.feature_grants')) return (await tx.grants(String(values[0]))).map((record) => ({ record }));
      if (sql.includes('FROM control_plane.organization_access')) return [{ revision: await tx.accessRevision(String(values[0])) }];
      if (sql.includes('FROM control_plane.tier_policies')) {
        const record = await tx.policy();
        return record ? [{ record }] : [];
      }
      if (sql.includes('FROM control_plane.route_entries')) return (await tx.routes()).map((record) => ({ record }));
      return [];
    });
  };
});
afterEach(() => { vi.unstubAllGlobals(); });

const handler = () => createHandler(() => cloud.accounts);
/** The Worker environment with a provider key and no funding login. */
const baseEnv: Record<string, unknown> = { ...validEnv, BEDROCK_API_KEY: 'ABSK-wiring-fixture' };
const gatewayEnv = { ...baseEnv, FUNDING_DATABASE_URL: FUNDING_URL };
const envWith = (funding: unknown) => (funding === undefined ? baseEnv : { ...baseEnv, FUNDING_DATABASE_URL: funding });

const respond = () => new Request('http://127.0.0.1:8791/managed/v1/responses', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-nectovia-organization': organizationId, 'x-nectovia-admission': admissionId, 'x-nectovia-job': 'run-1',
    'x-nectovia-attempt': 'run-1:1', 'x-nectovia-tier': 'efficient', 'x-nectovia-usage-class': 'included-chat', 'x-nectovia-policy-revision': '1',
  },
  body: JSON.stringify({ model: LUNA.model, input: [{ role: 'user', content: 'Hello.' }], store: false, stream: true }),
});
const readAttempt = () => new Request('http://127.0.0.1:8791/managed/v1/attempts/run-1:1', {
  headers: { authorization: `Bearer ${token}`, 'x-nectovia-organization': organizationId },
});
const usage = () => new Request(`http://127.0.0.1:8791/account/organizations/${organizationId}/usage`, {
  headers: { authorization: `Bearer ${token}` },
});
const routingPolicy = () => new Request('http://127.0.0.1:8791/account/routing-policy', { headers: { authorization: `Bearer ${token}` } });

describe('the managed gateway’s funding login', () => {
  it('sends the gateway’s funding writes and reads on FUNDING_DATABASE_URL, and its account, grant and routing reads on DATABASE_URL', async () => {
    const response = await handler()(respond(), gatewayEnv);
    // No funded job exists in the empty funding database, so the reservation stops at unknown_job,
    // after the job, its reference and the month's credit were written, and before any provider call.
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('unknown_job');
    const funding = statementsOn(FUNDING_URL);
    for (const table of ['funded_job_refs', 'funded_jobs', 'credit_periods'])
      expect(funding.some((sql) => sql.startsWith(`INSERT INTO control_plane.${table}(`))).toBe(true);
    expect(tablesOn(FUNDING_URL).every((table) => FUNDING_TABLES.has(table))).toBe(true);
    expect(tablesOn(FUNDING_URL)).toEqual(expect.arrayContaining(['funded_job_refs', 'funded_jobs', 'credit_periods', 'funding_reservations']));
    expect(tablesOn(DATABASE_URL).sort()).toEqual(['agent_admissions', 'feature_grants', 'organization_access', 'route_entries', 'tier_policies']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads an attempt on FUNDING_DATABASE_URL only', async () => {
    const response = await handler()(readAttempt(), gatewayEnv);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('unknown_attempt');
    expect(tablesOn(FUNDING_URL)).toEqual(['funding_reservations', 'funding_settlements']);
    expect(statementsOn(DATABASE_URL)).toEqual([]);
  });

  it('keeps the usage projection and the commercial routes on DATABASE_URL', async () => {
    const projection = await handler()(usage(), gatewayEnv);
    expect(projection.status).toBe(200);
    expect((await projection.json()).state).toBe('unavailable');
    expect(tablesOn(DATABASE_URL)).toContain('credit_periods');
    const policy = await handler()(routingPolicy(), gatewayEnv);
    expect(policy.status).toBe(200);
    expect(tablesOn(DATABASE_URL)).toEqual(['credit_periods', 'tier_policies']);
    expect(statementsOn(FUNDING_URL)).toEqual([]);
  });
});

describe('without a readable FUNDING_DATABASE_URL', () => {
  // The third column is the rule the Worker logs, never the value.
  const cases: [string, unknown, string][] = [
    ['unset', undefined, 'not-set'],
    ['blank', '', 'not-set'],
    ['whitespace', '   ', 'not-set'],
    ['the Worker login', DATABASE_URL, 'login'],
    ['another database', FUNDING_URL.replace('/neondb?', '/otherdb?'), 'other-database'],
    ['another host', FUNDING_URL.replace('ep-fixture.', 'ep-elsewhere.'), 'other-database'],
    ['not Neon', 'postgresql://cp_funding:fixture_password@db.example.com/neondb?sslmode=require', 'host'],
    ['without TLS', FUNDING_URL.replace('?sslmode=require', ''), 'sslmode'],
    ['not a URL', 'cp_funding', 'not-a-url'],
    ['not text', 5432, 'not-set'],
  ];

  it.each(cases)('refuses every managed call with 503 route_unavailable when it is %s, before any statement or provider call', async (_name, funding, rule) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const request of [respond(), readAttempt()]) {
      const response = await handler()(request, envWith(funding));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'route_unavailable', message: ROUTE_UNAVAILABLE } });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(db.log).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const logged = error.mock.calls.map((call) => String(call[0]));
    expect(logged).toEqual(Array(2).fill(JSON.stringify({ event: 'managed-funding-database-unavailable', setting: 'FUNDING_DATABASE_URL', rule })));
    expect(logged.join('\n')).not.toContain('fixture_password');
    error.mockRestore();
  });

  it('changes nothing else: the account routes answer exactly as they do with it', async () => {
    const answers = async (env: Record<string, unknown>) => {
      db.log.length = 0;
      const projection = await handler()(usage(), env);
      const policy = await handler()(routingPolicy(), env);
      return { projection: [projection.status, await projection.json()], policy: [policy.status, await policy.json()], sql: db.log.map((entry) => [entry.url, entry.sql]) };
    };
    const without = await answers(baseEnv);
    expect(without.projection[0]).toBe(200);
    expect(without.policy[0]).toBe(200);
    expect(await answers(gatewayEnv)).toEqual(without);
  });
});
