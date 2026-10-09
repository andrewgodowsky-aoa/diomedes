import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../src/faux/seed.js';
import { currentEvaluationSelection, evaluationAllows, type EvaluationSelection } from '../../../shared/evaluation-policy.js';
import { DEFAULT_MANDATORY_RESTRICTIONS, STRICT_RESTRICTIONS } from '../../../shared/routing-policy.js';
import { scriptedDecisionsFetch } from '../src/managed-providers.js';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const selection: EvaluationSelection = { provider: 'openrouter', protocol: 'decisions', model: 'fixture/decision-a',
  rate: { version: 'fixture-a', inputMicroUsdPerMillion: 42000, outputMicroUsdPerMillion: 0, cacheReadMicroUsdPerMillion: 42000, cacheWriteMicroUsdPerMillion: 42000 },
  observedAt: '2026-10-01T00:00:00Z', validUntil: '2026-11-01T00:00:00Z', evidence: 'Offline fixture, no live claim',
  privacy: { noTraining: true, zeroRetention: false, ingressCountries: ['ZZ'], processingCountries: ['ZZ'], retentionPolicy: 'fixture', transientCache: false } };
let cloud: FauxCloud, token: string, customer: string, org: string;
let sent: Record<string, unknown>[];
beforeEach(async () => {
  sent = [];
  const scripted = scriptedDecisionsFetch();
  cloud = await createFauxCloud({ file: null, now: () => NOW, passwordIterations: 1000,
    managed: { evaluationTransport: async (input, init) => { sent.push(JSON.parse(String(init?.body))); return scripted(input, init); } } });
  org = (await seedDemo(cloud)).organizations!.juniper;
  token = await login('staffRouting'); customer = await login('employee');
});
afterEach(async () => { await cloud.idle(); });
async function login(who: 'staffRouting' | 'staffBilling' | 'employee') {
  const response = await cloud.handle(new Request('http://localhost/auth/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD }) }));
  return (await response.json() as { accessToken: string }).accessToken;
}
async function publish(value: EvaluationSelection | null, revision = 1, bearer = token) {
  return cloud.handle(new Request('http://localhost/ops/routing/system-one', { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ selection: value, baseRevision: revision, note: 'Explicit offline staff selection' }) }));
}
async function request(path = '/managed/v1/evaluations', method = 'POST', extra: Record<string, string> = {}) {
  const admission = await cloud.commercial.admitAgent(customer, org, { surface: 'conversation', routeKind: 'managed', rootJobId: 'selection-run' });
  return cloud.handle(new Request(`http://localhost${path}`, { method, headers: {
    authorization: `Bearer ${customer}`, 'content-type': 'application/json', 'x-nectovia-organization': org,
    'x-nectovia-admission': admission.admissionId!, 'x-nectovia-job': 'selection-run', 'x-nectovia-attempt': 'selection-run:1',
    'x-nectovia-tier': 'efficient', 'x-nectovia-usage-class': 'included-chat', ...extra,
  }, ...(method === 'POST' ? { body: JSON.stringify({ state: 'fixture', questions: { check: { type: 'boolean', instructions: 'Is this a fixture?' } } }) } : {}) }));
}

describe('Operations is the System One model and pricing authority', () => {
  it.each([['managed-small', 750], ['managed-standard', 850], ['managed-plus', 1_000]] as const)('Expert advisor on %s uses the same plan check-in as generation', async (planId, cap) => {
    const billing = await login('staffBilling');
    await cloud.commercial.issueGrant(billing, org, { planId, source: 'internal-test', reference: 'Offline Expert fixture', note: '' });
    const price = cloud.store.snapshot().commercial.priceTables.at(-1)!;
    await cloud.commercial.publishCreditPrices(token, { baseVersion: price.version, ceilingMicroUsdPerCredit: price.ceilingMicroUsdPerCredit,
      tiers: { ...price.tiers, expert: price.tiers.efficient }, note: 'Offline Expert charge' });
    await publish(selection);
    const metadata = await request('/managed/v1/evaluations/route', 'GET', { 'x-nectovia-tier': 'expert' });
    expect(metadata.status).toBe(200); expect(sent).toHaveLength(0);
    expect((await request('/managed/v1/evaluations', 'POST', { 'x-nectovia-tier': 'expert' })).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(cloud.store.snapshot().funding.jobs).toMatchObject([{ tier: 'expert', capMicroUsd: cap * 100_000 }]);
  });
  it.each([['/managed/v1/evaluations/route', 'GET'], ['/managed/v1/evaluations', 'POST']])('rejects non-Managed Expert on %s before a hold', async (path, method) => {
    await publish(selection);
    const before = cloud.store.snapshot().funding;
    const response = await request(path, method, { 'x-nectovia-tier': 'expert' });
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: { code: 'expert_not_included' } });
    expect(sent).toHaveLength(0); expect(cloud.store.snapshot().funding).toEqual(before);
  });
  it('refuses missing selection without a hold or provider call', async () => {
    const response = await request();
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'evaluation_unavailable' } });
    expect(sent).toHaveLength(0); expect(cloud.store.snapshot().funding.attempts).toHaveLength(0);
  });
  it('publishes and dispatches an arbitrary supported model selected by staff, with metadata reads costing nothing', async () => {
    expect((await publish(selection)).status).toBe(201);
    const metadata = await request('/managed/v1/evaluations/route', 'GET');
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ model: 'fixture/decision-a', policyRevision: 2, tableVersion: 1, price: { version: 'credit-prices:1:efficient' } });
    expect(sent).toHaveLength(0); expect(cloud.store.snapshot().funding.attempts).toHaveLength(0);
    const response = await request();
    expect(response.status).toBe(200); expect(sent[0]).toMatchObject({ model: 'fixture/decision-a' });
    expect(cloud.store.snapshot().funding.attempts[0].rateSnapshot).toMatchObject({ version: 'fixture-a' });
  });
  it('rejects customer writes, stale editors, expired evidence and arbitrary destinations', async () => {
    expect((await publish(selection, 1, customer)).status).toBe(403);
    expect((await publish({ ...selection, validUntil: '2026-01-01T00:00:00Z' })).status).toBe(422);
    expect((await publish({ ...selection, endpoint: 'https://untrusted.example' } as EvaluationSelection)).status).toBe(422);
    expect((await publish(selection)).status).toBe(201);
    expect((await publish({ ...selection, model: 'fixture/decision-b' })).status).toBe(409);
    expect(sent).toHaveLength(0);
  });
  it('changes models without a rebuild and refuses a stale desktop snapshot', async () => {
    expect((await publish(selection)).status).toBe(201);
    expect((await publish({ ...selection, model: 'fixture/decision-b' }, 2)).status).toBe(201);
    const stale = await request('/managed/v1/evaluations', 'POST', { 'x-nectovia-evaluation-policy': '2:1' });
    expect(stale.status).toBe(409); expect(sent).toHaveLength(0);
    expect((await request()).status).toBe(200); expect(sent[0].model).toBe('fixture/decision-b');
  });
  it('preserves the selection on tier publication and restores it on rollback', async () => {
    await publish(selection);
    const policy = cloud.store.snapshot().commercial.policies.at(-1)!;
    await cloud.commercial.publishPolicy(token, { tiers: Object.fromEntries(Object.entries(policy.tiers).map(([k, v]) => [k, v?.entryId ?? null])) as never,
      baseRevision: 2, note: 'Keep explicit System One selection' });
    expect(cloud.store.snapshot().commercial.policies.at(-1)?.systemOne).toEqual(selection);
    await publish(null, 3);
    expect((await request()).status).toBe(409);
    await cloud.commercial.rollbackPolicy(token, { toRevision: 3, baseRevision: 4, note: 'Restore explicit selection' });
    expect(cloud.store.snapshot().commercial.policies.at(-1)?.systemOne).toEqual(selection);
  });
  it('never treats unpinned or missing privacy evidence as regional qualification', () => {
    expect(evaluationAllows(selection, [DEFAULT_MANDATORY_RESTRICTIONS])).toBe(true);
    expect(evaluationAllows(selection, [STRICT_RESTRICTIONS])).toBe(false);
    expect(currentEvaluationSelection({ ...selection, observedAt: '2027-01-01T00:00:00Z' }, NOW)).toBeNull();
  });
});
