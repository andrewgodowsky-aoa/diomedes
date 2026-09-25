/**
 * The managed inference gateway, end to end through the faux cloud's real
 * handler (contract nectovia-managed/1, section 7). The provider spy is the only
 * transport the gateway has, so its call count is the number of provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage } from 'ai';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';
import { MANAGED_PROVIDERS, scriptedResponsesFetch } from '../src/managed-providers.js';
import { creditAmount, usageCost, periodIdFor } from '../../../shared/managed-usage.js';
import { inputTokenBound } from '../../../shared/job-caps.js';
import { chunkedStream, concat, providerSpy, readAll, type ProviderRequest, type ProviderSpy } from './support/managed.js';

const LUNA = MANAGED_PROVIDERS[0];
const CANARY = 'ABSK-canary-7f3a9c2e5b1d-DO-NOT-LEAK';
const SCRIPTED_COST = usageCost(LUNA.rate, { inputTokens: 900, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 40, reasoningTokens: 8 });

let clock = Date.parse('2026-09-25T12:00:00.000Z');
const now = () => clock;
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let spy: ProviderSpy;
let answer: (request: ProviderRequest) => Response | Promise<Response>;
const scripted = scriptedResponsesFetch({ now });
const scriptedAnswer = (request: ProviderRequest) => scripted(request.url, { method: 'POST', headers: request.headers, body: request.rawBody });

async function makeCloud(credential: string | null = CANARY) {
  cloud = await createFauxCloud({ file: null, now, passwordIterations: 1_000, managed: { transport: spy.fetch, credential } });
  const seed = await seedDemo(cloud);
  orgs = seed.organizations!;
}

beforeEach(async () => {
  clock = Date.parse('2026-09-25T12:00:00.000Z');
  answer = scriptedAnswer;
  spy = providerSpy((request) => answer(request));
  await makeCloud();
});
afterEach(async () => { await cloud.idle(); });

// --- helpers ------------------------------------------------------------------------------

async function call(method: string, pathname: string, token?: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers = new Headers(extra);
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
async function admit(token: string, organizationId: string, input: Record<string, unknown> = { surface: 'conversation', routeKind: 'managed', rootJobId: 'run-1' }) {
  const result = await call('POST', `/account/organizations/${organizationId}/agent-admissions`, token, input);
  expect(result.status).toBe(200);
  return result.body.admissionId as string;
}

const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: LUNA.model,
  input: [{ role: 'developer', content: 'Be brief.' }, { role: 'user', content: [{ type: 'input_text', text: 'Hello.' }] }],
  reasoning: { effort: 'low' },
  include: ['reasoning.encrypted_content'],
  store: false,
  stream: true,
  parallel_tool_calls: false,
  max_output_tokens: 4_096,
  ...extra,
});

interface Ask {
  token: string; admission: string; org?: string; job?: string; attempt?: string; parent?: string; tier?: string;
  usageClass?: string; revision?: string; body?: unknown; rawBody?: string; omit?: string[]; set?: Record<string, string>;
}
function askRequest(a: Ask) {
  const headers = new Headers({
    authorization: `Bearer ${a.token}`,
    'content-type': 'application/json',
    'x-nectovia-organization': a.org ?? orgs.juniper,
    'x-nectovia-admission': a.admission,
    'x-nectovia-job': a.job ?? 'run-1',
    'x-nectovia-attempt': a.attempt ?? 'run-1:1',
    'x-nectovia-tier': a.tier ?? 'efficient',
    'x-nectovia-usage-class': a.usageClass ?? 'included-chat',
    'x-nectovia-policy-revision': a.revision ?? '1',
  });
  if (a.parent) headers.set('x-nectovia-parent-attempt', a.parent);
  for (const [name, value] of Object.entries(a.set ?? {})) headers.set(name, value);
  for (const name of a.omit ?? []) headers.delete(name);
  return new Request('http://127.0.0.1:8795/managed/v1/responses', { method: 'POST', headers, body: a.rawBody ?? JSON.stringify(a.body ?? chatBody()) });
}
const ask = (a: Ask) => cloud.handle(askRequest(a));
async function refusal(response: Response) {
  const body = await response.json() as { error: { code: string; message: string } };
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
  return { status: response.status, ...body.error };
}
const attempts = () => cloud.store.snapshot().funding.attempts;
const settlements = () => cloud.store.snapshot().funding.settlements;
async function employee() {
  const token = await signIn('employee');
  return { token, admission: await admit(token, orgs.juniper) };
}
async function available(token: string, organizationId = orgs.juniper) {
  const usage = await call('GET', `/account/organizations/${organizationId}/usage`, token);
  expect(usage.body.state).toBe('ready');
  return usage.body.projection as { availableMicroUsd: number; settledMicroUsd: number; pendingMicroUsd: number; uncertainMicroUsd: number };
}
function expectNothingSentOrHeld() {
  expect(spy.calls).toHaveLength(0);
  expect(attempts()).toHaveLength(0);
}

// --- section 7: refusals before dispatch ------------------------------------------------------

describe('refusals before dispatch send nothing to the provider and hold nothing', () => {
  it('refuses a free person, and a free organization', async () => {
    const { admission } = await employee();
    const free = await signIn('free');
    expect(await refusal(await ask({ token: free, admission }))).toMatchObject({ status: 403, code: 'not_a_member' });
    const plumbing = await call('POST', '/account/organizations', free, { name: 'Jordan Lee Plumbing' });
    const refused = await admit(free, plumbing.body.id);
    expect(await refusal(await ask({ token: free, admission: refused, org: plumbing.body.id }))).toMatchObject({ status: 403, code: 'admission_invalid' });
    expectNothingSentOrHeld();
  });

  it('refuses Harbor Hardware, which holds no grant, whatever admission it presents', async () => {
    const { admission: juniperAdmission } = await employee();
    const harbor = await signIn('harborOwner');
    const own = await admit(harbor, orgs.harbor);
    expect(await refusal(await ask({ token: harbor, admission: own, org: orgs.harbor }))).toMatchObject({ status: 403, code: 'admission_invalid' });
    expect(await refusal(await ask({ token: harbor, admission: juniperAdmission, org: orgs.harbor }))).toMatchObject({ status: 403, code: 'admission_invalid' });
    expectNothingSentOrHeld();
  });

  it('refuses a revoked grant inside the admission’s window, with the contract’s reason sentence', async () => {
    const { token, admission } = await employee();
    const billing = await signIn('staffBilling');
    const detail = await call('GET', `/ops/customers/${orgs.juniper}`, billing);
    expect((await call('POST', `/ops/customers/${orgs.juniper}/grants/${detail.body.grants[0].id}/revoke`, billing, { reason: 'Cancelled.' })).status).toBe(200);
    expect(await refusal(await ask({ token, admission }))).toEqual({
      status: 403, code: 'agent_not_included',
      message: 'This business’s Nectovia Agent access was withdrawn. Your files and history are unchanged.',
    });
    expectNothingSentOrHeld();
  });

  it('refuses an admission from another organization the same person belongs to', async () => {
    const owner = await signIn('owner');
    const catering = await call('POST', '/account/organizations', owner, { name: 'Juniper Catering' });
    const admission = await admit(owner, orgs.juniper);
    expect(await refusal(await ask({ token: owner, admission, org: catering.body.id }))).toMatchObject({ status: 403, code: 'admission_invalid' });
    expectNothingSentOrHeld();
  });

  it('refuses a stale admission', async () => {
    const { admission } = await employee();
    clock += 16 * 60_000;
    const token = await signIn('employee');
    expect(await refusal(await ask({ token, admission }))).toMatchObject({ status: 403, code: 'admission_invalid' });
    expectNothingSentOrHeld();
  });

  it('refuses a refused admission, a non-managed one, another person’s and one pinned to a different job', async () => {
    const { token, admission } = await employee();
    const byo = await admit(token, orgs.juniper, { surface: 'conversation', routeKind: 'byo', rootJobId: 'run-1' });
    const manager = await admit(await signIn('manager'), orgs.juniper);
    for (const presented of [byo, manager, 'agent_admission_unknown'])
      expect(await refusal(await ask({ token, admission: presented }))).toMatchObject({ status: 403, code: 'admission_invalid' });
    expect(await refusal(await ask({ token, admission, job: 'run-2' }))).toMatchObject({ status: 403, code: 'admission_invalid' });
    expectNothingSentOrHeld();
  });

  it('names a missing or malformed header, and refuses an unverified session', async () => {
    const { token, admission } = await employee();
    const headers = ['authorization', 'x-nectovia-organization', 'x-nectovia-admission', 'x-nectovia-job', 'x-nectovia-attempt',
      'x-nectovia-tier', 'x-nectovia-usage-class', 'x-nectovia-policy-revision'];
    for (const name of headers) {
      const refused = await refusal(await ask({ token, admission, omit: [name] }));
      expect(refused).toMatchObject({ status: 400, code: 'invalid_header' });
      expect(refused.message.toLowerCase()).toContain(name);
    }
    for (const [name, value] of [['x-nectovia-tier', 'premium'], ['x-nectovia-usage-class', 'free'], ['x-nectovia-policy-revision', '-1'],
      ['x-nectovia-job', 'bad job'], ['x-nectovia-parent-attempt', '../x'], ['authorization', 'Basic abc']])
      expect(await refusal(await ask({ token, admission, set: { [name]: value } }))).toMatchObject({ status: 400, code: 'invalid_header' });
    expect(await refusal(await ask({ token: 'not-a-session', admission }))).toMatchObject({ status: 401, code: 'sign_in_required' });
    expectNothingSentOrHeld();
  });
});

// --- section 7: the body allowlist at the gateway ------------------------------------------------

describe('the body allowlist at the gateway', () => {
  it('refuses every unsupported field, a remote image URL, a built-in tool and store: true with 400 and no provider call', async () => {
    const { token, admission } = await employee();
    const cases: [Record<string, unknown>, string][] = [
      ...['temperature', 'top_p', 'previous_response_id', 'conversation', 'background', 'metadata', 'user', 'service_tier', 'truncation',
        'prompt', 'prompt_cache_key', 'safety_identifier', 'top_logprobs', 'max_tool_calls', 'stream_options']
        .map((field) => [chatBody({ [field]: field === 'metadata' ? {} : 1 }), 'unsupported_field'] as [Record<string, unknown>, string]),
      [chatBody({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/cat.png' }] }] }), 'unsupported_field'],
      [chatBody({ tools: [{ type: 'web_search' }] }), 'unsupported_field'],
      [chatBody({ tools: [{ type: 'file_search', vector_store_ids: ['vs_1'] }] }), 'unsupported_field'],
      [chatBody({ tools: [{ type: 'mcp', server_label: 'x', server_url: 'https://example.test' }] }), 'unsupported_field'],
      [chatBody({ store: true }), 'unsupported_field'],
      [chatBody({ input: [{ type: 'item_reference', id: 'msg_1' }] }), 'unsupported_field'],
      [chatBody({ input: 'Hello.' }), 'invalid_body'],
    ];
    for (const [body, code] of cases) {
      const refused = await refusal(await ask({ token, admission, body }));
      expect(refused, JSON.stringify(body)).toMatchObject({ status: 400, code });
    }
    expect(await refusal(await ask({ token, admission, rawBody: '{"model":' }))).toMatchObject({ status: 400, code: 'invalid_body' });
    expectNothingSentOrHeld();
  });

  it('refuses an oversized request and an over-long context before any hold', async () => {
    const { token, admission } = await employee();
    const huge = JSON.stringify(chatBody({ instructions: 'x'.repeat(2_000_000) }));
    expect(await refusal(await ask({ token, admission, rawBody: huge }))).toMatchObject({ status: 413, code: 'request_too_large' });
    const long = chatBody({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'y'.repeat(272_000) }] }] });
    expect(await refusal(await ask({ token, admission, body: long }))).toMatchObject({ status: 413, code: 'context_too_long' });
    expectNothingSentOrHeld();
  });

  it('refuses max_output_tokens above the route’s product cap', async () => {
    const { token, admission } = await employee();
    expect(await refusal(await ask({ token, admission, body: chatBody({ max_output_tokens: 16_001 }) })))
      .toMatchObject({ status: 400, code: 'invalid_body' });
    expectNothingSentOrHeld();
  });
});

// --- route resolution ------------------------------------------------------------------------------

describe('route resolution', () => {
  it('refuses a stale policy revision, and a model the tier does not resolve to, with 409 policy_changed', async () => {
    const { token, admission } = await employee();
    expect(await refusal(await ask({ token, admission, revision: '0' }))).toMatchObject({ status: 409, code: 'policy_changed' });
    expect(await refusal(await ask({ token, admission, body: chatBody({ model: 'us.openai.gpt-6-sol' }) }))).toMatchObject({ status: 409, code: 'policy_changed' });
    expectNothingSentOrHeld();
  });

  it('refuses a tier the policy leaves empty with 409 tier_unrouted', async () => {
    const { token, admission } = await employee();
    const routing = await signIn('staffRouting');
    expect((await call('POST', '/ops/routing/publish', routing, { tiers: { efficient: 'aws-luna-6', focused: 'aws-luna-6', thorough: null }, note: 'Hold Thorough.', baseRevision: 1 })).status).toBe(201);
    expect(await refusal(await ask({ token, admission, tier: 'thorough', revision: '2' }))).toMatchObject({ status: 409, code: 'tier_unrouted' });
    expectNothingSentOrHeld();
  });

  it('answers 503 route_unavailable, naming no provider, for a route outside the registry', async () => {
    const { token, admission } = await employee();
    const routing = await signIn('staffRouting');
    expect((await call('POST', '/ops/routing/publish', routing, { tiers: { efficient: 'aws-luna-5-6', focused: 'aws-luna-6', thorough: 'aws-luna-6' }, note: 'Back to 5.6.', baseRevision: 1 })).status).toBe(201);
    const refused = await refusal(await ask({ token, admission, revision: '2', body: chatBody({ model: 'us.openai.gpt-5.6-luna' }) }));
    expect(refused).toEqual({ status: 503, code: 'route_unavailable', message: 'Nectovia’s model service is not available right now.' });
    expectNothingSentOrHeld();
  });

  it('answers 503 route_unavailable when no key is configured', async () => {
    await makeCloud(null);
    const { token, admission } = await employee();
    expect(await refusal(await ask({ token, admission }))).toMatchObject({ status: 503, code: 'route_unavailable' });
    expectNothingSentOrHeld();
  });
});

// --- section 7: an entitled Business call --------------------------------------------------------

describe('an entitled Business call', () => {
  it('makes one provider call with the model pinned and store off, streams the bytes unchanged, and settles at exactly usageCost', async () => {
    const { token, admission } = await employee();
    const owner = await signIn('owner');
    const before = await available(owner);
    let providerBytes = new Uint8Array();
    answer = async (request) => {
      const response = await scriptedAnswer(request);
      providerBytes = await readAll(response.body);
      return new Response(providerBytes, { status: 200, headers: response.headers });
    };
    const response = await ask({ token, admission });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('x-nectovia-attempt')).toBe('run-1:1');
    expect(response.headers.get('x-nectovia-route')).toBe('aws-luna-6');
    expect(response.headers.get('x-nectovia-model')).toBe(LUNA.model);
    expect(response.headers.get('x-nectovia-rate-card')).toBe(LUNA.rate.version);
    const clientBytes = await readAll(response.body);
    expect(providerBytes.byteLength).toBeGreaterThan(1_000);
    expect(Buffer.from(clientBytes).equals(Buffer.from(providerBytes))).toBe(true);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe(LUNA.endpoint);
    expect(spy.calls[0].body).toEqual({ ...chatBody(), model: LUNA.model, store: false, stream: true });

    await cloud.idle();
    const [attempt] = attempts();
    expect(attempt).toMatchObject({ id: 'run-1:1', state: 'settled', route: 'aws-luna-6', rootJobId: 'run-1', usageClass: 'included-chat', rateSnapshot: LUNA.rate });
    const [settlement] = settlements();
    expect(SCRIPTED_COST).toBe(112);
    expect(settlement).toMatchObject({ providerCostMicroUsd: SCRIPTED_COST, allowanceDebitMicroUsd: SCRIPTED_COST, reconciledFrom: 'response',
      receiptRef: expect.stringMatching(/^resp_/), usage: { inputTokens: 900, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 40, reasoningTokens: 8 } });
    const after = await available(owner);
    expect(before.availableMicroUsd - after.availableMicroUsd).toBe(SCRIPTED_COST);
    expect(after.settledMicroUsd - before.settledMicroUsd).toBe(SCRIPTED_COST);
    expect(after.pendingMicroUsd).toBe(0);

    const read = await call('GET', '/managed/v1/attempts/run-1:1', token, undefined, { 'x-nectovia-organization': orgs.juniper });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      attemptId: 'run-1:1', state: 'settled', providerCostMicroUsd: SCRIPTED_COST, allowanceDebitMicroUsd: SCRIPTED_COST,
      usage: { inputTokens: 900, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 40, reasoningTokens: 8 },
    });
  });

  it('holds the input bound at the input rate plus the output cap at the output rate, rounded up, and forwards the cap when none is given', async () => {
    const { token, admission } = await employee();
    const body = chatBody();
    delete (body as Record<string, unknown>).max_output_tokens;
    const raw = JSON.stringify(body);
    const response = await ask({ token, admission, rawBody: raw });
    expect(response.status).toBe(200);
    expect(spy.calls[0].body.max_output_tokens).toBe(16_000);
    const bound = inputTokenBound(new TextEncoder().encode(raw).byteLength, body.input.length);
    const ceiling = Math.ceil((bound * 110_000 + 16_000 * 550_000) / 1_000_000);
    expect(attempts()[0].maxMicroUsd).toBe(ceiling);
    await readAll(response.body);
  });

  it('carries the desktop’s own SDK loop offline: a tool call, its result, then the answer', async () => {
    const token = await signIn('employee');
    const admission = await admit(token, orgs.juniper);
    let step = 0;
    const nectovia = (attempt: string) => ({
      'x-nectovia-organization': orgs.juniper, 'x-nectovia-admission': admission, 'x-nectovia-job': 'run-1', 'x-nectovia-attempt': attempt,
      'x-nectovia-tier': 'focused', 'x-nectovia-usage-class': 'included-chat', 'x-nectovia-policy-revision': '1',
    });
    const model = createOpenAI({
      name: 'nectovia', baseURL: 'http://127.0.0.1:8795/managed/v1', apiKey: token,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => cloud.handle(new Request(input, init))) as typeof fetch,
    }).responses(LUNA.model);
    const common = {
      model, system: 'You are the Nectovia agent.', maxOutputTokens: 4_096, maxRetries: 0, stopWhen: stepCountIs(1),
      tools: { read_file: tool({ description: 'Read a file.', inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }) }) },
      providerOptions: { openai: { forceReasoning: true, systemMessageMode: 'developer', include: ['reasoning.encrypted_content'], reasoningEffort: 'medium', reasoningSummary: null, store: false, parallelToolCalls: false } } as never,
    };
    const opening: ModelMessage[] = [{ role: 'user', content: 'Check the notes. [[tool:read_file {"path":"notes.txt"}]]' }];
    const first = streamText({ ...common, messages: opening, headers: nectovia(`run-1:${++step}`) });
    const [toolCall] = await first.toolCalls;
    expect(toolCall).toMatchObject({ toolName: 'read_file', input: { path: 'notes.txt' } });
    const second = streamText({
      ...common, headers: nectovia(`run-1:${++step}`),
      messages: [...opening, ...((await first.response).messages as ModelMessage[]),
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: toolCall.toolCallId, toolName: 'read_file', output: { type: 'text', value: 'Order rye.' } }] }],
    });
    expect(await second.text).toMatch(/scripted model/);
    await cloud.idle();
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.every((request) => request.headers.authorization === `Bearer ${CANARY}`)).toBe(true);
    expect(attempts().map((row) => row.state)).toEqual(['settled', 'settled']);
  });

  it('accepts an admission until fifteen minutes have passed', async () => {
    const { admission } = await employee();
    clock += 14 * 60_000;
    const token = await signIn('employee');
    const response = await ask({ token, admission });
    expect(response.status).toBe(200);
    await readAll(response.body);
    expect(spy.calls).toHaveLength(1);
  });
});

// --- section 7: replays ------------------------------------------------------------------------------

describe('replaying an attempt', () => {
  it('makes no second provider call for the same attempt id and body, and refuses a different body under that id', async () => {
    const { token, admission } = await employee();
    await readAll((await ask({ token, admission })).body);
    await cloud.idle();
    const replay = await refusal(await ask({ token, admission }));
    expect(replay).toMatchObject({ status: 409, code: 'attempt_replayed' });
    expect(replay.message).toContain('/managed/v1/attempts/run-1:1');
    expect(await refusal(await ask({ token, admission, body: chatBody({ max_output_tokens: 100 }) }))).toMatchObject({ status: 409, code: 'attempt_conflict' });
    expect(spy.calls).toHaveLength(1);
    expect(attempts()).toHaveLength(1);
  });

  it('sends once when the same attempt arrives twice at once', async () => {
    const { token, admission } = await employee();
    const responses = await Promise.all([ask({ token, admission }), ask({ token, admission })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await Promise.all(responses.map((response) => readAll(response.body)));
    expect(spy.calls).toHaveLength(1);
  });
});

// --- section 7: provider failures ------------------------------------------------------------------

describe('provider failures', () => {
  it('answers a 429 before any byte with provider_busy and its Retry-After, and leaves no hold pending', async () => {
    const { token, admission } = await employee();
    answer = () => Response.json({ error: { message: 'Too many requests.' } }, { status: 429, headers: { 'retry-after': '7' } });
    const response = await ask({ token, admission });
    expect(response.headers.get('retry-after')).toBe('7');
    expect(await refusal(response)).toMatchObject({ status: 429, code: 'provider_busy' });
    expect(spy.calls).toHaveLength(1);
    await cloud.idle();
    // Contract section 3 asks for funding.release here. FundingService refuses to release a
    // dispatched hold (see the next test), so the gateway parks it for reconciliation instead.
    expect(attempts()[0]).toMatchObject({ state: 'uncertain', uncertainReason: expect.stringContaining('HTTP 429') });
  });

  it('cannot release a hold once it is dispatched: FundingService.release refuses (the contract section 3 conflict)', async () => {
    const owner = await signIn('owner');
    const tenantId = (await call('GET', `/ops/customers/${orgs.juniper}`, await signIn('staffSupport'))).body.organization.tenantId as string;
    const ref = { tenantId, organizationId: orgs.juniper, attemptId: 'probe:1' };
    await cloud.funding.openJob({ tenantId, organizationId: orgs.juniper, rootJobId: 'probe', runRef: 'probe', parentRunRef: null, tier: 'efficient', capMicroUsd: null });
    await cloud.funding.reserve({ ...ref, rootJobId: 'probe', parentAttemptId: null, kind: 'generation', route: 'aws-luna-6', requestDigest: 'a'.repeat(64),
      rateSnapshot: LUNA.rate, maxMicroUsd: creditAmount(1), usageClass: 'included-chat' });
    await cloud.funding.markDispatched(ref);
    await expect(cloud.funding.release(ref)).rejects.toMatchObject({ code: 'dispatched_hold' });
    expect(owner).toBeTruthy();
  });

  it('leaves the attempt uncertain when the stream is cut after dispatch', async () => {
    const { token, admission } = await employee();
    answer = async (request) => {
      const full = await readAll((await scriptedAnswer(request)).body);
      return new Response(chunkedStream([full.slice(0, 200), full.slice(200, 400)], { failAfter: 2 }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const response = await ask({ token, admission });
    expect(response.status).toBe(200);
    await expect(readAll(response.body)).rejects.toThrow();
    await cloud.idle();
    expect(spy.calls).toHaveLength(1);
    expect(attempts()[0]).toMatchObject({ state: 'uncertain' });
  });

  it('leaves the attempt uncertain when the stream ends without a terminal event, or the client disconnects', async () => {
    const { token, admission } = await employee();
    answer = async (request) => {
      const text = new TextDecoder().decode(await readAll((await scriptedAnswer(request)).body));
      return new Response(text.slice(0, text.indexOf('event: response.completed')), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    await readAll((await ask({ token, admission })).body);
    answer = scriptedAnswer;
    const second = await ask({ token, admission, attempt: 'run-1:2' });
    const reader = second.body!.getReader();
    await reader.read();
    await reader.cancel();
    await cloud.idle();
    expect(spy.calls).toHaveLength(2);
    expect(attempts().map((row) => [row.id, row.state])).toEqual([['run-1:1', 'uncertain'], ['run-1:2', 'uncertain']]);
    expect(attempts()[1].uncertainReason).toMatch(/disconnected/);
  });

  it('answers a provider 401, 403 or 404 with 503 route_unavailable and no credential text', async () => {
    const { token, admission } = await employee();
    for (const [index, status] of [401, 403, 404].entries()) {
      answer = () => Response.json({ error: { message: `The security token ${CANARY} is invalid.` } }, { status });
      const response = await ask({ token, admission, attempt: `run-1:${index + 1}` });
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(JSON.parse(text)).toEqual({ error: { code: 'route_unavailable', message: 'Nectovia’s model service is not available right now.' } });
      expect(text).not.toContain(CANARY);
    }
    expect(spy.calls).toHaveLength(3);
  });

  it('passes a provider 400 through as provider_refused, scrubbed of the key and cut to 300 characters', async () => {
    const { token, admission } = await employee();
    answer = () => Response.json({ error: { message: `Bad request for key ${CANARY}: ${'z'.repeat(500)}` } }, { status: 400 });
    const refused = await refusal(await ask({ token, admission }));
    expect(refused).toMatchObject({ status: 400, code: 'provider_refused' });
    expect(refused.message).not.toContain(CANARY);
    expect(refused.message.startsWith('Bad request for key [redacted]: zzz')).toBe(true);
    expect(Array.from(refused.message)).toHaveLength(300);
  });

  it('treats a 5xx or a network failure before any byte as uncertain, and tells the customer the service is unavailable', async () => {
    const { token, admission } = await employee();
    answer = () => new Response('upstream exploded', { status: 502 });
    expect(await refusal(await ask({ token, admission }))).toMatchObject({ status: 503, code: 'route_unavailable' });
    answer = () => { throw new TypeError('fetch failed'); };
    expect(await refusal(await ask({ token, admission, attempt: 'run-1:2' }))).toMatchObject({ status: 503, code: 'route_unavailable' });
    await cloud.idle();
    expect(attempts().map((row) => row.state)).toEqual(['uncertain', 'uncertain']);
  });

  it('stops waiting for a silent provider and parks the attempt', async () => {
    spy = providerSpy(() => new Promise<Response>(() => {}));
    cloud = await createFauxCloud({ file: null, now, passwordIterations: 1_000, managed: { transport: spy.fetch, credential: CANARY, idleTimeoutMs: 50 } });
    orgs = (await seedDemo(cloud)).organizations!;
    const { token, admission } = await employee();
    expect(await refusal(await ask({ token, admission }))).toMatchObject({ status: 503, code: 'route_unavailable' });
    await cloud.idle();
    expect(attempts()[0]).toMatchObject({ state: 'uncertain' });
  });
});

// --- byte-for-byte passthrough ------------------------------------------------------------------------

describe('stream passthrough', () => {
  it('forwards bytes unchanged across awkward chunk boundaries, including inside a UTF-8 character, and still settles exactly', async () => {
    const { token, admission } = await employee();
    let providerBytes = new Uint8Array();
    const pieces: Uint8Array[] = [];
    answer = async (request) => {
      providerBytes = await readAll((await scriptedAnswer(request)).body);
      // The scripted answer's ’ is E2 80 99: cut between its first and second byte.
      const quote = Buffer.from(providerBytes).indexOf(Buffer.from('’'));
      expect(quote).toBeGreaterThan(0);
      const cuts = new Set<number>([quote + 1, quote + 2]);
      const terminal = Buffer.from(providerBytes).indexOf(Buffer.from('response.completed'));
      for (let at = terminal - 3; at < terminal + 40; at += 3) cuts.add(at);
      for (let at = 1; at < providerBytes.byteLength; at += 1 + (at % 7)) cuts.add(at);
      const sorted = [...cuts].filter((at) => at > 0 && at < providerBytes.byteLength).sort((a, b) => a - b);
      let from = 0;
      for (const at of sorted) { pieces.push(providerBytes.slice(from, at)); from = at; }
      pieces.push(providerBytes.slice(from));
      return new Response(chunkedStream(pieces), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const response = await ask({ token, admission });
    const clientBytes = await readAll(response.body);
    expect(pieces.length).toBeGreaterThan(100);
    expect(Buffer.from(clientBytes).equals(Buffer.from(concat(pieces)))).toBe(true);
    expect(Buffer.from(clientBytes).equals(Buffer.from(providerBytes))).toBe(true);
    await cloud.idle();
    expect(settlements()[0]).toMatchObject({ providerCostMicroUsd: SCRIPTED_COST });
  });
});

// --- section 7: out of credit --------------------------------------------------------------------

describe('out of credit', () => {
  it('refuses with 402 and the funding reason when the month is spent, making no provider call', async () => {
    const { token, admission } = await employee();
    const owner = await signIn('owner');
    const tenantId = (await call('GET', `/ops/customers/${orgs.juniper}`, await signIn('staffSupport'))).body.organization.tenantId as string;
    await cloud.funding.recordCorrection({ tenantId, organizationId: orgs.juniper, adjustmentId: 'spent', periodId: periodIdFor(new Date(clock).toISOString()),
      direction: 'withdraw', amountMicroUsd: (await available(owner)).availableMicroUsd as never, attemptRef: null, note: 'Spent for the test.' });
    const refused = await refusal(await ask({ token, admission }));
    expect(refused).toMatchObject({ status: 402, code: 'insufficient_allowance' });
    expect(refused.message).toMatch(/^This step needs up to [\d.,]+ credits and 0 are available\. Nothing switches payer or buys more on its own\.$/);
    expectNothingSentOrHeld();
  });

  it('passes no_period and cap_request_required through as 402', async () => {
    const billing = await signIn('staffBilling');
    const issued = await call('POST', `/ops/customers/${orgs.harbor}/grants`, billing, {
      planId: null, features: ['nectovia-agent', 'managed-inference'], source: 'internal-test', reference: 'Agreement 7', note: 'Agent without a funded plan.',
      validUntil: '2026-12-31T00:00:00.000Z',
    });
    expect(issued.body.funding.allocated).toBe(false);
    const harbor = await signIn('harborOwner');
    const harborAdmission = await admit(harbor, orgs.harbor);
    expect(await refusal(await ask({ token: harbor, admission: harborAdmission, org: orgs.harbor }))).toMatchObject({ status: 402, code: 'no_period' });

    const { token, admission } = await employee();
    const tenantId = (await call('GET', `/ops/customers/${orgs.juniper}`, await signIn('staffSupport'))).body.organization.tenantId as string;
    await cloud.funding.openJob({ tenantId, organizationId: orgs.juniper, rootJobId: 'run-1', runRef: 'run-1', parentRunRef: null, tier: 'efficient', capMicroUsd: null });
    await cloud.funding.reserve({ tenantId, organizationId: orgs.juniper, attemptId: 'earlier', rootJobId: 'run-1', parentAttemptId: null, kind: 'generation',
      route: 'aws-luna-6', requestDigest: 'b'.repeat(64), rateSnapshot: LUNA.rate, maxMicroUsd: creditAmount(20) - 1_000 as never, usageClass: 'included-chat' });
    expect(await refusal(await ask({ token, admission }))).toMatchObject({ status: 402, code: 'cap_request_required' });
    expect(spy.calls).toHaveLength(0);
  });
});

// --- section 7: the credential canary ---------------------------------------------------------------

describe('the credential never leaves the gateway', () => {
  it('reaches the provider as a bearer and appears in no response body, header, log line, error or stored row', async () => {
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const { token, admission } = await employee();
    const seen: string[] = [];
    const record = async (response: Response) => {
      response.headers.forEach((value, name) => seen.push(`${name}: ${value}`));
      try { seen.push(new TextDecoder().decode(await readAll(response.body))); } catch (error) { seen.push(String(error)); }
    };
    const scriptedThen = (make: () => Response) => (request: ProviderRequest) => (request.body.max_output_tokens === 7 ? make() : scriptedAnswer(request));
    const failures: (() => Response)[] = [
      () => Response.json({ error: { message: `Invalid key ${CANARY}` } }, { status: 401 }),
      () => Response.json({ error: { message: `Key ${CANARY} lacks access to model` } }, { status: 403 }),
      () => Response.json({ error: { message: `Validation failed for ${CANARY.slice(3, 20)}` } }, { status: 400 }),
      () => Response.json({ error: { message: `Slow down ${CANARY}` } }, { status: 429, headers: { 'retry-after': '1' } }),
      () => new Response(`upstream said ${CANARY}`, { status: 500 }),
      // A 2xx stream is forwarded byte for byte, so this one fails with the key in its error instead.
      () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
          controller.error(new TypeError(`socket closed while sending Bearer ${CANARY}`));
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      () => { throw new TypeError(`connect ECONNREFUSED with Bearer ${CANARY}`); },
    ];
    await record(await ask({ token, admission, attempt: 'ok:1' }));
    for (const [index, make] of failures.entries()) {
      answer = scriptedThen(make);
      await record(await ask({ token, admission, attempt: `fail:${index}`, body: chatBody({ max_output_tokens: 7 }) }));
    }
    await cloud.idle();
    for (const id of ['ok:1', ...failures.map((_, index) => `fail:${index}`)])
      await record(await cloud.handle(new Request(`http://127.0.0.1:8795/managed/v1/attempts/${id}`, { headers: { authorization: `Bearer ${token}`, 'x-nectovia-organization': orgs.juniper } })));

    expect(spy.calls.length).toBe(1 + failures.length);
    expect(spy.calls.every((request) => request.headers.authorization === `Bearer ${CANARY}`)).toBe(true);
    const everything = [...seen, ...logged, JSON.stringify(cloud.store.snapshot())].join('\n');
    // The key, and any twelve characters of it.
    for (let at = 0; at + 12 <= CANARY.length; at++) expect(everything).not.toContain(CANARY.slice(at, at + 12));
  });
});

// --- monthly credit, allocated when the gateway first needs it ------------------------------------------

describe('each month’s credit is allocated on the first call that needs it', () => {
  const periods = () => cloud.store.snapshot().funding.periods.filter((row) => row.organizationId === orgs.juniper);
  const grantId = () => cloud.store.snapshot().commercial.grants.find((row) => row.organizationId === orgs.juniper)!.id;
  const october = () => { clock = Date.parse('2026-10-02T09:00:00.000Z'); };

  it('allocates October once, from the September grant, and reserves against it', async () => {
    expect(periods().map((row) => row.periodId)).toEqual(['2026-09']);
    october();
    const { token, admission } = await employee();
    await readAll((await ask({ token, admission })).body);
    await readAll((await ask({ token, admission, attempt: 'run-1:2' })).body);
    await cloud.idle();
    expect(periods().map((row) => row.periodId)).toEqual(['2026-09', '2026-10']);
    expect(periods()[1]).toMatchObject({ planId: 'business', sourceGrantId: grantId(), grantedMicroUsd: creditAmount(1_000), startsAt: '2026-10-01T00:00:00.000Z' });
    expect(attempts().map((row) => [row.periodId, row.state])).toEqual([['2026-10', 'settled'], ['2026-10', 'settled']]);
    expect(spy.calls).toHaveLength(2);
  });

  it('allocates once when two first calls of the month arrive together', async () => {
    october();
    const { token, admission } = await employee();
    const responses = await Promise.all([ask({ token, admission }), ask({ token, admission, attempt: 'run-1:2' })]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await Promise.all(responses.map((response) => readAll(response.body)));
    expect(periods().filter((row) => row.periodId === '2026-10')).toHaveLength(1);
    expect(spy.calls).toHaveLength(2);
  });

  it('keeps FundingService.allocatePeriod idempotent under two concurrent calls', async () => {
    const tenantId = cloud.store.snapshot().accounts.organizations.find((row) => row.record.id === orgs.juniper)!.record.tenantId;
    const input = { tenantId, organizationId: orgs.juniper, periodId: '2026-11', planId: 'business', sourceGrantId: grantId() };
    const [first, second] = await Promise.all([cloud.funding.allocatePeriod(input), cloud.funding.allocatePeriod(input)]);
    expect(second).toEqual(first);
    expect(periods().filter((row) => row.periodId === '2026-11')).toHaveLength(1);
  });

  it('allocates nothing for a revoked grant, and refuses with the entitlement code before any provider call', async () => {
    october();
    const { token, admission } = await employee();
    const billing = await signIn('staffBilling');
    expect((await call('POST', `/ops/customers/${orgs.juniper}/grants/${grantId()}/revoke`, billing, { reason: 'Cancelled.' })).status).toBe(200);
    expect(await refusal(await ask({ token, admission }))).toMatchObject({ status: 403, code: 'agent_not_included' });
    expect(periods().map((row) => row.periodId)).toEqual(['2026-09']);
    expectNothingSentOrHeld();
  });

  it('allocates nothing for an expired grant', async () => {
    clock = Date.parse('2026-10-26T11:55:00.000Z');
    const { admission } = await employee();
    clock = Date.parse('2026-10-26T12:01:00.000Z');
    const token = await signIn('employee');
    expect(await refusal(await ask({ token, admission }))).toEqual({
      status: 403, code: 'agent_not_included',
      message: 'This business’s plan has ended, so the Nectovia Agent is not available. Your files and history are unchanged.',
    });
    expect(periods().map((row) => row.periodId)).toEqual(['2026-09']);
    expectNothingSentOrHeld();
  });
});

// --- the attempt read -----------------------------------------------------------------------------------

describe('reading an attempt', () => {
  it('returns an organization’s own attempt and 404 for anyone else’s', async () => {
    const { token, admission } = await employee();
    await readAll((await ask({ token, admission })).body);
    await cloud.idle();
    const harbor = await signIn('harborOwner');
    const other = await call('GET', '/managed/v1/attempts/run-1:1', harbor, undefined, { 'x-nectovia-organization': orgs.harbor });
    expect(other).toMatchObject({ status: 404, body: { error: { code: 'unknown_attempt' } } });
    const stranger = await call('GET', '/managed/v1/attempts/run-1:1', harbor, undefined, { 'x-nectovia-organization': orgs.juniper });
    expect(stranger).toMatchObject({ status: 403, body: { error: { code: 'not_a_member' } } });
    const missing = await call('GET', '/managed/v1/attempts/run-1:9', token, undefined, { 'x-nectovia-organization': orgs.juniper });
    expect(missing.status).toBe(404);
  });
});
