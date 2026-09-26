/**
 * Typed evaluations through the managed gateway (POST /managed/v1/evaluations,
 * docs/implementation/2026-09-26-jev-managed-evaluations.md), end to end through
 * the faux cloud's real handler. The spy is the only transport the evaluation
 * caller has, so its call count is the number of provider calls and its log is
 * exactly what left for the provider. Nothing here leaves the machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFauxCloud, LIVE_EVALUATIONS_WITHOUT_CEILING, type FauxCloud } from '../src/faux/cloud.js';
import { startFauxCloud, type RunningFauxCloud } from '../src/faux/server.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';
import {
  DECISIONS_DATA_POLICY,
  EVALUATION_PROVIDER,
  decisionsBody,
  openRouterDecisionsCaller,
  scriptedDecisionsFetch,
} from '../src/managed-providers.js';
import {
  CEILING_REFUSAL,
  EVALUATION_OUTPUT_TOKENS_PER_QUESTION,
  MANAGED_INFERENCE_NOT_INCLUDED,
  MAX_EVALUATION_REQUEST_BYTES,
  PROVIDER_POLICY_REFUSAL,
} from '../src/managed-inference.js';
import { checkEvaluationRequest } from '../../../shared/evaluation-wire.js';
import { usageCost } from '../../../shared/managed-usage.js';
import { inputTokenBound } from '../../../shared/token-bound.js';
import { providerSpy, type ProviderRequest, type ProviderSpy } from './support/managed.js';

const CANARY = 'sk-or-v1-canary-4d1e8b2f7a90c3-DO-NOT-LEAK';
const RATE = EVALUATION_PROVIDER.rate;

let clock = Date.parse('2026-09-26T12:00:00.000Z');
const now = () => clock;
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let spy: ProviderSpy;
let answer: (request: ProviderRequest) => Response | Promise<Response>;
let sequence = 0;
const scripted = scriptedDecisionsFetch({ id: () => `e${++sequence}` });
const scriptedAnswer = (request: ProviderRequest) => scripted(request.url, { method: 'POST', headers: request.headers, body: request.rawBody });

async function makeCloud(options: { credential?: string | null; settings?: Record<string, string> } = {}) {
  cloud = await createFauxCloud({
    file: null, now, passwordIterations: 1_000,
    managed: {
      evaluationTransport: spy.fetch,
      evaluationCredential: options.credential === undefined ? CANARY : options.credential,
      settings: options.settings ?? {},
    },
  });
  orgs = (await seedDemo(cloud)).organizations!;
}

beforeEach(async () => {
  clock = Date.parse('2026-09-26T12:00:00.000Z');
  answer = scriptedAnswer;
  spy = providerSpy((request) => answer(request));
  await makeCloud();
});
afterEach(async () => {
  await cloud.idle();
  vi.restoreAllMocks();
});

// --- helpers ------------------------------------------------------------------------------

async function call(method: string, pathname: string, token?: string, body?: unknown) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await cloud.handle(new Request(`http://127.0.0.1:8795${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}
async function signIn(who: DemoAccount) {
  const result = await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD });
  expect(result.status).toBe(200);
  return result.body.accessToken as string;
}
async function admit(token: string, organizationId: string, admitted = true) {
  const result = await call('POST', `/account/organizations/${organizationId}/agent-admissions`, token,
    { surface: 'conversation', routeKind: 'managed', rootJobId: 'run-1' });
  expect(result.status).toBe(200);
  expect(result.body.decision.admitted).toBe(admitted);
  return result.body.admissionId as string;
}
async function employee() {
  const token = await signIn('employee');
  return { token, admission: await admit(token, orgs.juniper) };
}

/** What the desktop's preflight sends (providerQuestions()): one question of each shape. */
const question = {
  files: { type: 'boolean', instructions: 'Does the answer need the business’s files?', criteria: { true: 'It needs them.', false: 'It does not.' } },
  kind: { type: 'choice', instructions: 'What kind of work is this?', criteria: { reply: 'A short reply.', task: null } },
  effort: { type: 'score', instructions: 'How much work is it?', criteria: ['None.', 'Some.', 'A lot.'] },
};
const evaluationBody = (extra: Record<string, unknown> = {}) => ({
  state: { thread: [{ role: 'user', text: 'Can you move Saturday’s cake order to Sunday?' }] },
  questions: question,
  ...extra,
});

interface Evaluate {
  token: string; admission: string; org?: string; job?: string; attempt?: string;
  body?: unknown; rawBody?: string; method?: string; path?: string;
}
function evaluationRequest(e: Evaluate) {
  const headers = new Headers({
    authorization: `Bearer ${e.token}`,
    'content-type': 'application/json',
    'x-nectovia-organization': e.org ?? orgs.juniper,
    'x-nectovia-admission': e.admission,
    'x-nectovia-job': e.job ?? 'run-1',
    'x-nectovia-attempt': e.attempt ?? 'run-1:jev:1',
    'x-nectovia-tier': 'efficient',
    'x-nectovia-usage-class': 'included-chat',
  });
  const method = e.method ?? 'POST';
  return new Request(`http://127.0.0.1:8795${e.path ?? '/managed/v1/evaluations'}`, {
    method, headers, body: method === 'GET' ? undefined : e.rawBody ?? JSON.stringify(e.body ?? evaluationBody()),
  });
}
const evaluate = (e: Evaluate) => cloud.handle(evaluationRequest(e));

async function refusal(response: Response) {
  const body = await response.json() as { error: { code: string; message: string } };
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
  return { status: response.status, ...body.error };
}
const attempts = () => cloud.store.snapshot().funding.attempts;
const settlements = () => cloud.store.snapshot().funding.settlements;
async function available(organizationId = orgs.juniper) {
  const usage = await call('GET', `/account/organizations/${organizationId}/usage`, await signIn('owner'));
  expect(usage.body.state).toBe('ready');
  return usage.body.projection as { availableMicroUsd: number; settledMicroUsd: number; pendingMicroUsd: number; uncertainMicroUsd: number };
}
function expectNothingSentOrHeld() {
  expect(spy.calls).toHaveLength(0);
  expect(attempts()).toHaveLength(0);
}
/** The hold the gateway prices for a body exactly as it was sent. */
function holdFor(rawBody: string, questions: number) {
  const bound = inputTokenBound(new TextEncoder().encode(rawBody).byteLength, questions);
  const output = questions * EVALUATION_OUTPUT_TOKENS_PER_QUESTION;
  return Math.ceil((bound * RATE.inputMicroUsdPerMillion + output * RATE.outputMicroUsdPerMillion) / 1_000_000);
}
/** What the scripted provider reports for a body it was sent: its bytes over four, one output token a question. */
function scriptedCost(rawBody: string, questions: number) {
  const inputTokens = Math.ceil(new TextEncoder().encode(rawBody).byteLength / 4);
  return { inputTokens, cost: usageCost(RATE, { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: questions, reasoningTokens: 0 }) };
}

// --- an answered evaluation -----------------------------------------------------------------

describe('an answered evaluation', () => {
  it('answers a Business member, sent once to the registry’s endpoint, and settles the hold at the route’s price', async () => {
    const { token, admission } = await employee();
    const before = await available();
    const response = await evaluate({ token, admission });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(spy.calls).toHaveLength(1);
    const [sent] = spy.calls;
    expect(sent.url).toBe(EVALUATION_PROVIDER.endpoint);
    expect(sent.method).toBe('POST');
    expect(sent.headers.authorization).toBe(`Bearer ${CANARY}`);
    // The state and the questions as the desktop sent them, a yes-or-no question as a `noul`, under the route's model.
    expect(sent.body).toEqual({
      model: 'typesafe/jev-1.13',
      state: evaluationBody().state,
      questions: {
        files: { type: 'noul', instructions: question.files.instructions, criteria: { true: 'It needs them.', false: 'It does not.' } },
        kind: question.kind,
        effort: question.effort,
      },
      provider: { data_collection: 'deny' },
    });

    const { inputTokens, cost } = scriptedCost(sent.rawBody, 3);
    expect(cost).toBeGreaterThan(0);
    expect(body).toEqual({
      answers: {
        files: { type: 'boolean', probability: 0.1 },
        kind: { type: 'choice', choice: 'reply', probabilities: { reply: 1 } },
        effort: { type: 'score', score: 0, probabilities: { 0: 1 } },
      },
      usage: { inputTokens, outputTokens: 3 },
      rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
      warnings: [],
      response: { modelId: 'typesafe/jev-1.13-20260917', id: expect.stringMatching(/^gen-e\d+$/) },
    });
    const named = ['x-nectovia-attempt', 'x-nectovia-model', 'x-nectovia-rate-card', 'x-nectovia-charge', 'x-nectovia-charge-micro-usd',
      'x-nectovia-input-tokens', 'x-nectovia-output-tokens'];
    expect(Object.fromEntries(named.map((name) => [name, response.headers.get(name)]))).toEqual({
      'x-nectovia-attempt': 'run-1:jev:1',
      'x-nectovia-model': 'typesafe/jev-1.13',
      'x-nectovia-rate-card': RATE.version,
      'x-nectovia-charge': 'settled',
      'x-nectovia-charge-micro-usd': String(cost),
      'x-nectovia-input-tokens': String(inputTokens),
      'x-nectovia-output-tokens': '3',
    });

    // One advisor hold at the dearest input-side rate for the whole bound, settled at what was used.
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]).toMatchObject({
      id: 'run-1:jev:1', kind: 'advisor', route: 'openrouter-jev-1.13', state: 'settled', rateSnapshot: RATE,
      maxMicroUsd: holdFor(sent.rawBody, 3), usageClass: 'included-chat', rootJobId: 'run-1',
    });
    expect(attempts()[0].maxMicroUsd).toBeGreaterThanOrEqual(cost);
    expect(settlements()).toHaveLength(1);
    expect(settlements()[0]).toMatchObject({ providerCostMicroUsd: cost, allowanceDebitMicroUsd: cost, receiptRef: body.response.id });
    const after = await available();
    expect(after.pendingMicroUsd).toBe(before.pendingMicroUsd);
    expect(after.availableMicroUsd).toBe(before.availableMicroUsd - cost);
  });

  it('prices from the published Jev terms: $0.000000042 a prompt token and nothing a completion token', () => {
    expect(RATE).toEqual({
      version: 'evaluation-price-2026-09-22.openrouter.1',
      inputMicroUsdPerMillion: 42_000, cacheReadMicroUsdPerMillion: 42_000, cacheWriteMicroUsdPerMillion: 42_000, outputMicroUsdPerMillion: 0,
    });
    // A million prompt tokens is 4.2 cents; any number of completion tokens is free.
    expect(usageCost(RATE, { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 })).toBe(42_000);
    expect(usageCost(RATE, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5_000_000, reasoningTokens: 0 })).toBe(0);
  });

  it('never sends the same attempt twice', async () => {
    const { token, admission } = await employee();
    expect((await evaluate({ token, admission })).status).toBe(200);
    expect(await refusal(await evaluate({ token, admission }))).toMatchObject({ status: 409, code: 'attempt_replayed' });
    expect(spy.calls).toHaveLength(1);
    expect(attempts()).toHaveLength(1);
  });

  it('is served in the Worker as a POST only, with no query', async () => {
    const { token, admission } = await employee();
    const get = await evaluate({ token, admission, method: 'GET' });
    expect(get.headers.get('allow')).toBe('POST');
    expect(await refusal(get)).toMatchObject({ status: 405, code: 'method_not_allowed' });
    expect(await refusal(await evaluate({ token, admission, path: '/managed/v1/evaluations?model=other' }))).toMatchObject({ status: 400, code: 'invalid_request' });
    expectNothingSentOrHeld();
  });
});

// --- private processing by default (Pillar 09) ------------------------------------------------

describe('private processing by default', () => {
  it('sends every evaluation with data collection denied, never asks for zero retention, and lets no body set its own policy', async () => {
    const { token, admission } = await employee();
    expect((await evaluate({ token, admission })).status).toBe(200);
    expect((await evaluate({ token, admission, attempt: 'run-1:jev:2', body: evaluationBody({ state: 'A plain text state.' }) })).status).toBe(200);
    expect(spy.calls).toHaveLength(2);
    for (const sent of spy.calls) {
      expect(sent.body.provider).toEqual({ data_collection: 'deny' });
      expect(sent.rawBody).not.toMatch(/zdr/i);
    }
    expect(DECISIONS_DATA_POLICY).toEqual({ data_collection: 'deny' });
    expect(Object.isFrozen(DECISIONS_DATA_POLICY)).toBe(true);
    const checked = checkEvaluationRequest(evaluationBody());
    if (!checked.ok) throw new Error(checked.message);
    expect(JSON.parse(decisionsBody(EVALUATION_PROVIDER, checked.request)).provider).toEqual({ data_collection: 'deny' });

    for (const provider of [{ data_collection: 'allow' }, { zdr: true }]) {
      const own = await refusal(await evaluate({ token, admission, attempt: 'run-1:jev:3', body: evaluationBody({ provider }) }));
      expect(own).toMatchObject({ status: 400, code: 'unsupported_field' });
      expect(own.message).toContain('provider');
    }
    expect(spy.calls).toHaveLength(2);
  });

  it('fails closed when no endpoint meets the data policy: one call, the hold released, a named refusal', async () => {
    const { token, admission } = await employee();
    const before = await available();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const policyRefusals = [
      () => Response.json({ error: { code: 404, message: 'No endpoints found matching your data policy.' } }, { status: 404, headers: { 'x-request-id': 'req-policy-1' } }),
      () => Response.json({ error: { code: 404, message: 'No allowed providers are available for the selected model.' } }, { status: 404 }),
      () => Response.json({ error: { code: 404, message: 'Not found.' }, openrouter_metadata: { attempt: 0 } }, { status: 404 }),
    ];
    for (const [index, make] of policyRefusals.entries()) {
      answer = () => make();
      const response = await evaluate({ token, admission, attempt: `run-1:jev:${index + 1}` });
      expect(response.headers.get('x-nectovia-charge')).toBe('released');
      expect(await refusal(response)).toEqual({ status: 503, code: 'evaluation_provider_policy', message: PROVIDER_POLICY_REFUSAL });
    }
    // Never sent anywhere else: one call an attempt, each to the registry's endpoint and model, each under the policy.
    expect(spy.calls).toHaveLength(3);
    for (const sent of spy.calls) {
      expect(sent.url).toBe(EVALUATION_PROVIDER.endpoint);
      expect(sent.body.model).toBe(EVALUATION_PROVIDER.model);
      expect(sent.body.provider).toEqual({ data_collection: 'deny' });
    }
    expect(attempts().map((row) => row.state)).toEqual(['released', 'released', 'released']);
    expect(settlements()).toHaveLength(0);
    expect(await available()).toEqual(before);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'managed-evaluation-provider-policy', attemptId: 'run-1:jev:1' }));
  });

  it('tells a policy refusal from any other not-found, which is released as unavailable', async () => {
    const { token, admission } = await employee();
    answer = () => Response.json({ error: { code: 404, message: 'Model not found.' }, openrouter_metadata: { attempt: 1 } }, { status: 404 });
    const response = await evaluate({ token, admission });
    expect(response.headers.get('x-nectovia-charge')).toBe('released');
    expect(await refusal(response)).toMatchObject({ status: 503, code: 'route_unavailable' });
    expect(attempts().map((row) => row.state)).toEqual(['released']);
  });
});

// --- the body -------------------------------------------------------------------------------------

describe('the body is the preflight’s and nothing else', () => {
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`q${index}`, { type: 'boolean', instructions: 'Yes?' }]));
  const cases: [string, unknown, number, string, string?][] = [
    ['a field outside the allowlist', evaluationBody({ model: 'another/model' }), 400, 'unsupported_field', 'model'],
    ['a question field outside the allowlist', evaluationBody({ questions: { files: { ...question.files, weight: 2 } } }), 400, 'unsupported_field', 'weight'],
    ['a question type the route does not send', evaluationBody({ questions: { rank: { type: 'ranking', instructions: 'Rank them.', criteria: {} } } }), 400, 'unsupported_field', 'ranking'],
    ['an undescribed score level', evaluationBody({ questions: { effort: { ...question.effort, criteria: ['None.', null] } } }), 400, 'unsupported_field', 'effort'],
    ['a one-sided yes-or-no question', evaluationBody({ questions: { files: { ...question.files, criteria: { true: 'Yes.' } } } }), 400, 'unsupported_field', 'true and false'],
    ['no questions', evaluationBody({ questions: {} }), 400, 'invalid_body'],
    ['no state', { questions: question }, 400, 'invalid_body'],
    ['more questions than one request asks', evaluationBody({ questions: many }), 413, 'request_too_large'],
    ['a state past the route’s token bound', evaluationBody({ state: 'x'.repeat(100_000) }), 413, 'request_too_large'],
  ];
  it.each(cases)('refuses %s, naming it, before anything is held or sent', async (_, body, status, code, named) => {
    const { token, admission } = await employee();
    const refused = await refusal(await evaluate({ token, admission, body }));
    expect(refused).toMatchObject({ status, code });
    if (named) expect(refused.message).toContain(named);
    expectNothingSentOrHeld();
  });

  it('refuses a body that is not JSON, and one past the byte bound', async () => {
    const { token, admission } = await employee();
    expect(await refusal(await evaluate({ token, admission, rawBody: '{"state":' }))).toMatchObject({ status: 400, code: 'invalid_body' });
    expect(await refusal(await evaluate({ token, admission, rawBody: ' '.repeat(MAX_EVALUATION_REQUEST_BYTES + 1) }))).toMatchObject({ status: 413, code: 'request_too_large' });
    expectNothingSentOrHeld();
  });
});

// --- entitlement, decided again on every call -------------------------------------------------------

describe('every call is checked against the business’s current grants', () => {
  it('refuses a business with no grant, whatever admission it presents', async () => {
    const { admission: juniperAdmission } = await employee();
    const harbor = await signIn('harborOwner');
    const own = await admit(harbor, orgs.harbor, false);
    expect(await refusal(await evaluate({ token: harbor, admission: own, org: orgs.harbor }))).toMatchObject({ status: 403, code: 'admission_invalid' });
    expect(await refusal(await evaluate({ token: harbor, admission: juniperAdmission, org: orgs.harbor }))).toMatchObject({ status: 403, code: 'admission_invalid' });
    expectNothingSentOrHeld();
  });

  it('refuses a grant that admits the Agent but does not include AI usage', async () => {
    const billing = await signIn('staffBilling');
    const issued = await call('POST', `/ops/customers/${orgs.harbor}/grants`, billing, {
      planId: null, features: ['nectovia-agent'], source: 'internal-test', reference: 'Agreement 8', note: 'Agent without included usage.',
      validUntil: '2026-12-31T00:00:00.000Z',
    });
    expect(issued.status).toBe(201);
    const harbor = await signIn('harborOwner');
    const admission = await admit(harbor, orgs.harbor);
    expect(await refusal(await evaluate({ token: harbor, admission, org: orgs.harbor }))).toEqual({
      status: 403, code: 'managed_inference_not_included', message: MANAGED_INFERENCE_NOT_INCLUDED,
    });
    expectNothingSentOrHeld();
  });

  it('refuses a grant revoked after the admission', async () => {
    const { token, admission } = await employee();
    const billing = await signIn('staffBilling');
    const detail = await call('GET', `/ops/customers/${orgs.juniper}`, billing);
    expect((await call('POST', `/ops/customers/${orgs.juniper}/grants/${detail.body.grants[0].id}/revoke`, billing, { reason: 'Cancelled.' })).status).toBe(200);
    expect(await refusal(await evaluate({ token, admission }))).toMatchObject({ status: 403, code: 'agent_not_included' });
    expectNothingSentOrHeld();
  });

  it('refuses a person who is not a member, a sign-in that has ended and an admission that has gone stale', async () => {
    const { admission } = await employee();
    const free = await signIn('free');
    expect(await refusal(await evaluate({ token: free, admission }))).toMatchObject({ status: 403, code: 'not_a_member' });
    expect(await refusal(await evaluate({ token: 'not-a-current-sign-in', admission }))).toMatchObject({ status: 401, code: 'sign_in_required' });
    clock += 16 * 60_000;
    expect(await refusal(await evaluate({ token: await signIn('employee'), admission }))).toMatchObject({ status: 403, code: 'admission_invalid' });
    expectNothingSentOrHeld();
  });
});

// --- the hold's lifecycle ---------------------------------------------------------------------------

describe('what becomes of the hold once the call is sent', () => {
  it('holds the charge as uncertain, never zero, when the usage is missing, incomplete, another model’s or above the price', async () => {
    const { token, admission } = await employee();
    const answered = async (request: ProviderRequest, change: (reply: Record<string, unknown>) => void) => {
      const reply = await (await scriptedAnswer(request)).json() as Record<string, unknown>;
      change(reply);
      return Response.json(reply, { headers: { 'x-request-id': `req-${spy.calls.length}` } });
    };
    const changes: ((reply: Record<string, unknown>) => void)[] = [
      (reply) => { delete reply.usage; },
      (reply) => { reply.usage = { input_tokens: 12, cost: 0 }; },
      (reply) => { reply.model = 'another/model-20260917'; },
      (reply) => { (reply.usage as Record<string, unknown>).cost = 1; },
    ];
    for (const [index, change] of changes.entries()) {
      answer = (request) => answered(request, change);
      const response = await evaluate({ token, admission, attempt: `run-1:jev:${index + 1}` });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-nectovia-charge')).toBe('uncertain');
      expect(response.headers.get('x-nectovia-charge-micro-usd')).toBeNull();
      expect(Object.keys((await response.json()).answers)).toEqual(['files', 'kind', 'effort']);
    }
    expect(attempts().map((row) => row.state)).toEqual(['uncertain', 'uncertain', 'uncertain', 'uncertain']);
    expect(attempts().every((row) => row.uncertainReason !== null && row.maxMicroUsd > 0)).toBe(true);
    expect(settlements()).toHaveLength(0);
  });

  it('releases the hold when the provider refuses before any output, and says nothing of the key', async () => {
    const { token, admission } = await employee();
    const before = await available();
    answer = () => Response.json({ error: { message: `Invalid questions for key ${CANARY}` } }, { status: 400 });
    const refused = await evaluate({ token, admission, attempt: 'run-1:jev:1' });
    expect(refused.headers.get('x-nectovia-charge')).toBe('released');
    const said = await refusal(refused);
    expect(said).toMatchObject({ status: 400, code: 'provider_refused' });
    for (let at = 0; at + 12 <= CANARY.length; at++) expect(said.message).not.toContain(CANARY.slice(at, at + 12));

    answer = () => Response.json({ error: { message: 'Slow down.' } }, { status: 429, headers: { 'retry-after': '2' } });
    const busy = await evaluate({ token, admission, attempt: 'run-1:jev:2' });
    expect(busy.headers.get('retry-after')).toBe('2');
    expect(await refusal(busy)).toMatchObject({ status: 429, code: 'provider_busy' });

    answer = () => Response.json({ error: { message: 'No auth credentials found.' } }, { status: 401 });
    expect(await refusal(await evaluate({ token, admission, attempt: 'run-1:jev:3' }))).toMatchObject({ status: 503, code: 'route_unavailable' });

    expect(attempts().map((row) => row.state)).toEqual(['released', 'released', 'released']);
    expect(settlements()).toHaveLength(0);
    expect(await available()).toEqual(before);
  });

  it('holds the charge as uncertain when the call fails after it was sent, or the provider fails without saying why', async () => {
    const { token, admission } = await employee();
    answer = () => { throw new TypeError('network connection lost'); };
    const lost = await evaluate({ token, admission, attempt: 'run-1:jev:1' });
    expect(lost.headers.get('x-nectovia-charge')).toBe('uncertain');
    expect(await refusal(lost)).toMatchObject({ status: 503, code: 'route_unavailable' });
    answer = () => new Response('upstream failed', { status: 500 });
    const failed = await evaluate({ token, admission, attempt: 'run-1:jev:2' });
    expect(failed.headers.get('x-nectovia-charge')).toBe('uncertain');
    expect(await refusal(failed)).toMatchObject({ status: 503, code: 'route_unavailable' });
    answer = () => new Response('{"answers":', { status: 200 });
    const unreadable = await evaluate({ token, admission, attempt: 'run-1:jev:3' });
    expect(unreadable.headers.get('x-nectovia-charge')).toBe('uncertain');
    expect(await refusal(unreadable)).toMatchObject({ status: 503, code: 'route_unavailable' });
    expect(attempts().map((row) => row.state)).toEqual(['uncertain', 'uncertain', 'uncertain']);
    expect(spy.calls).toHaveLength(3);
  });
});

// --- the owner's limits and settings ------------------------------------------------------------------

describe('the owner’s spend ceiling and the provider key', () => {
  it('refuses before any hold when the company ceiling would be passed', async () => {
    await makeCloud({ settings: { MANAGED_SPEND_CEILING_MICRO_USD: '0' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { token, admission } = await employee();
    expect(await refusal(await evaluate({ token, admission }))).toEqual({ status: 503, code: 'route_unavailable', message: CEILING_REFUSAL });
    expectNothingSentOrHeld();
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'managed-spend-ceiling-reached', attemptId: 'run-1:jev:1' }));

    await makeCloud({ settings: { MANAGED_SPEND_CEILING_MICRO_USD: '100000000' } });
    const allowed = await employee();
    expect((await evaluate(allowed)).status).toBe(200);
  });

  it('answers 503 without OPENROUTER_API_KEY, and logs the setting and the rule it broke, never the value', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const keys: [string | null, string][] = [[null, 'missing'], [' sk-or-padded-key ', 'whitespace'], ['sk-or-kéy', 'format']];
    for (const [credential, rule] of keys) {
      await makeCloud({ credential });
      const { token, admission } = await employee();
      expect(await refusal(await evaluate({ token, admission }))).toMatchObject({ status: 503, code: 'route_unavailable' });
      expect(logged.at(-1)).toBe(JSON.stringify({ event: 'managed-configuration-unavailable', setting: 'OPENROUTER_API_KEY', rule }));
      expectNothingSentOrHeld();
    }
    expect(logged.join('\n')).not.toMatch(/padded|kéy/);
  });

  it('sends the key it is given once, never an ambient one, and follows no redirect', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-ambient-must-not-be-read');
    try {
      const redirecting = providerSpy(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/decisions' } }));
      const response = await openRouterDecisionsCaller(redirecting.fetch)({
        row: EVALUATION_PROVIDER, credential: 'sk-or-given', body: '{}', signal: new AbortController().signal,
      });
      expect(response.status).toBe(302);
      expect(redirecting.calls).toHaveLength(1);
      expect(redirecting.calls[0].url).toBe(EVALUATION_PROVIDER.endpoint);
      expect(redirecting.calls[0].headers.authorization).toBe('Bearer sk-or-given');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// --- the faux cloud ---------------------------------------------------------------------------------------

describe('the faux cloud’s evaluation provider', () => {
  let running: RunningFauxCloud | null = null;
  afterEach(async () => {
    await running?.close();
    running = null;
    vi.unstubAllEnvs();
  });

  it('is scripted and offline by default', async () => {
    await expect(createFauxCloud({ file: null })).resolves.toMatchObject({ evaluationProvider: 'scripted' });
  });

  it('refuses to start with a live OpenRouter key and no readable spend ceiling, before anything opens', async () => {
    // A placeholder, never a real key, and no evaluation is made in live mode.
    vi.stubEnv('NECTOVIA_FAUX_OPENROUTER_API_KEY', 'sk-or-placeholder-not-a-key');
    for (const ceiling of ['', '  ', 'a hundred dollars', '-1']) {
      vi.stubEnv('MANAGED_SPEND_CEILING_MICRO_USD', ceiling);
      await expect(startFauxCloud({ file: null, port: 0 })).rejects.toThrow(LIVE_EVALUATIONS_WITHOUT_CEILING);
    }
    await expect(createFauxCloud({ file: null, liveOpenRouterApiKey: 'sk-or-placeholder-not-a-key' })).rejects.toThrow(LIVE_EVALUATIONS_WITHOUT_CEILING);
    vi.stubEnv('MANAGED_SPEND_CEILING_MICRO_USD', '100000000');
    running = await startFauxCloud({ file: null, port: 0 });
    expect(running.cloud.evaluationProvider).toBe('live');
    expect(running.cloud.provider).toBe('scripted');
  });
});
