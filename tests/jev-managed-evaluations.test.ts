/**
 * The preflight on company-managed inference (docs/implementation/2026-09-26-jev-managed-evaluations.md).
 *
 * A business conversation on the `nectovia` route asks its preflight through the account
 * service's gateway, as the signed-in person, under an admission the Agent gate recorded for the
 * preflight's own job; the gateway pays and meters it, and its receipt is the preflight's charge,
 * recorded on this computer's guard. Nothing is connected here.
 *
 * The account service is the real control-plane handler over the faux store, in this process,
 * and its gateway's provider is the scripted Decisions provider on the faux cloud's own seam. No
 * provider is called and no money is spent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { nectoviaConnectionId } from '../server/engines/nectovia';
import { EngineError } from '../server/engines/process';
import { testOnlySecretBox } from '../server/connection-secrets';
import { ControlPlaneClient } from '../server/accounts/client';
import type { AccountBackend } from '../server/accounts/backend';
import { AGENT_NOT_INCLUDED, type AgentGatePort } from '../server/accounts/agent-gate';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import { EVALUATION_PROVIDER, scriptedDecisionsFetch } from '../services/control-plane/src/managed-providers';
import { EVALUATION_PRICE_JEV_113_OPENROUTER } from '../server/harness/evaluation-price';
import {
  MANAGED_EVALUATION_NOT_INCLUDED,
  MANAGED_EVALUATION_PORT_ID,
  createManagedJevAdvisor,
  managedEvaluationPort,
  managedEvaluationRateCard,
  recordManagedCharge,
} from '../server/harness/evaluation-managed';
import {
  createJevAdvisor,
  type PreflightAdvice,
  type PreflightChargeRecord,
  type PreflightInput,
} from '../server/harness/jev-advisor';
import {
  EvaluationTransportError,
  PRE_DISPATCH_CODES,
  scriptedEvaluationPort,
  type EvaluationReceipt,
} from '../server/harness/evaluation-adapter';
import { SpendExposure, type ExposureReservation } from '../server/spend-exposure';
import type { AccessFeature } from '../shared/access';
import type { AccountStateView } from '../shared/accounts';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const ACCOUNT_SERVICE = 'http://faux.local';
/** An ordinary request: the rule neither skips it nor reads it as demanding. */
const REQUEST = 'Draft a short note to the Saturday staff about the new opening hours.';
const PRICE_VERSION = 'evaluation-price-2026-09-22.openrouter.1';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let root: string;
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let backend: AccountBackend;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
/** Every evaluation the desktop sent the gateway, as the gateway received it. */
let evaluations: Sent[];
/** Every admission the desktop asked the account service for. */
let admissions: number;
/** Every call the gateway made to its (scripted) provider. */
let provider: Sent[];
let answer: (url: string, text: string) => Response | Promise<Response>;
const scripted = scriptedDecisionsFetch();
const scriptedAnswer = (url: string, text: string) =>
  scripted(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });

const decisions = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const text = await request.text();
  provider.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()), body: JSON.parse(text) });
  return answer(request.url, text);
}) as typeof globalThis.fetch;

async function open(options: Record<string, unknown> = { managedJev: true }) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: (async () => {
      throw new Error('No provider is called directly in this file');
    }) as typeof globalThis.fetch,
    accounts: { backend },
    ...options,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  server = undefined;
}
const request = (route: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}
const signIn = (email: string) =>
  api<AccountStateView>('/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false });
type Binding = { projectId: string; threadId: string };
const home = () => api<Binding>('/home/conversation', 'POST');
interface Preflight {
  advice: PreflightAdvice | null;
  resolution: { deterministic: unknown; advised: unknown } | null;
}
const preflight = (binding: Binding, text = REQUEST) =>
  api<Preflight>(`/projects/${binding.projectId}/threads/${binding.threadId}/preflight`, 'POST', { text });

async function staffToken(email: string) {
  const pair = await cloud.store.run((draft) =>
    cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}

/** The Nectovia route's local guard for a business this month, as this computer wrote it. */
async function localHolds(organizationId: string): Promise<ExposureReservation[]> {
  const file = path.join(root, 'data', 'spend-exposure', `${nectoviaConnectionId(organizationId, new Date())}.json`);
  try {
    return (JSON.parse(await fs.readFile(file, 'utf8')) as { reservations: ExposureReservation[] }).reservations;
  } catch {
    return [];
  }
}
const gatewayAttempts = () => cloud.store.snapshot().funding.attempts;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-managed-jev-'));
  evaluations = [];
  admissions = 0;
  provider = [];
  answer = scriptedAnswer;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000, managed: { evaluationTransport: decisions } });
  orgs = (await seedDemo(cloud)).organizations!;
  backend = {
    client: new ControlPlaneClient(ACCOUNT_SERVICE, async (req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname === '/managed/v1/evaluations')
        evaluations.push({ url: req.url, headers: Object.fromEntries(req.headers.entries()), body: await req.clone().json() });
      if (pathname.endsWith('/agent-admissions')) admissions += 1;
      return cloud.handle(req);
    }),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  await open();
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

// --- a business on managed inference ---------------------------------------------------------------

describe('a business conversation on nectovia', () => {
  test('a Business member’s preflight is answered through the managed gateway, and its receipt lands on the local guard', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const organizationId = owner.workspaces[0].organization.id;
    const binding = await home();
    const { advice, resolution } = await preflight(binding);

    // One evaluation, as the signed-in person, under an admission pinned to the preflight's own job.
    expect(evaluations).toHaveLength(1);
    const [sent] = evaluations;
    expect(sent.url).toBe(`${ACCOUNT_SERVICE}/managed/v1/evaluations`);
    expect(sent.headers).toMatchObject({
      authorization: expect.stringMatching(/^Bearer \S{20,}$/),
      'x-nectovia-organization': organizationId,
      'x-nectovia-admission': expect.stringMatching(/^agent_admission/),
      'x-nectovia-job': expect.stringMatching(/^preflight-[0-9a-f-]{36}$/),
      'x-nectovia-attempt': expect.stringMatching(/^exp-[0-9a-f]{40}$/),
      'x-nectovia-tier': 'efficient',
      'x-nectovia-usage-class': 'included-chat',
    });
    expect(sent.headers).not.toHaveProperty('x-nectovia-policy-revision');
    // Exactly the preflight's state and questions; the gateway adds the model and the data policy.
    expect(Object.keys(sent.body).sort()).toEqual(['questions', 'state']);
    expect(Object.keys(sent.body.questions as object).sort()).toEqual([
      'needs-clarification', 'needs-extra-review', 'needs-unattached-material', 'workload',
    ]);
    expect(provider).toHaveLength(1);
    expect(provider[0].body).toMatchObject({ model: 'typesafe/jev-1.13', provider: { data_collection: 'deny' } });

    // Advice, with the gateway's receipt as its charge.
    const attempt = sent.headers['x-nectovia-attempt'];
    const settled = cloud.store.snapshot().funding.settlements.find((row) => row.reservationId === attempt);
    expect(settled).toBeDefined();
    expect(advice).toMatchObject({
      status: 'advised',
      dispatched: true,
      charge: { state: 'known', microUsd: settled!.allowanceDebitMicroUsd, priceVersion: PRICE_VERSION, tokens: { output: 4 } },
      provenance: {
        port: MANAGED_EVALUATION_PORT_ID,
        requestedModel: 'typesafe/jev-1.13',
        actualModel: 'typesafe/jev-1.13-20260917',
        scripted: false,
      },
      hints: { workload: 'lookup', demanding: false, missingEvidence: false, needsClarification: false, needsReview: false },
    });
    expect(resolution).not.toBeNull();

    // The gateway's advisor hold settled; the admission it checked is the one recorded for this job.
    expect(gatewayAttempts().map((row) => [row.id, row.kind, row.state])).toEqual([[attempt, 'advisor', 'settled']]);
    const billing = await staffToken(DEMO_ACCOUNTS.staffBilling.email);
    const recorded = (await cloud.commercial.customer(billing, organizationId)).admissions;
    expect(recorded.find((row) => row.id === sent.headers['x-nectovia-admission'])).toMatchObject({
      decision: 'admitted', routeKind: 'managed', surface: 'conversation', rootJobId: sent.headers['x-nectovia-job'],
    });

    // The same charge on this computer's guard, against the same attempt and job.
    const holds = await localHolds(organizationId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      id: attempt,
      route: 'nectovia',
      modelId: 'typesafe/jev-1.13',
      rateCardVersion: PRICE_VERSION,
      state: 'settled',
      settledMicroUsd: settled!.allowanceDebitMicroUsd,
      jobId: expect.stringMatching(/^job-[0-9a-f]{40}$/),
      attempt: { runId: sent.headers['x-nectovia-job'], stepId: 'preflight', attempt: 1 },
    });
  });

  test('a greeting is answered by rule: no admission, no gateway call, no hold', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const binding = await home();
    const before = admissions;
    const { advice } = await preflight(binding, 'thanks!');
    expect(advice).toMatchObject({ status: 'skipped', charge: { state: 'none' }, dispatched: false });
    expect(admissions).toBe(before);
    expect(evaluations).toHaveLength(0);
    expect(await localHolds(owner.workspaces[0].organization.id)).toEqual([]);
  });

  test('a refusal after the call was sent reads as unavailable, with the charge held as uncertain on both ledgers', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const organizationId = owner.workspaces[0].organization.id;
    const binding = await home();
    answer = () => new Response('upstream failed', { status: 500 });
    const { advice, resolution } = await preflight(binding);
    expect(advice).toMatchObject({ status: 'unavailable', dispatched: true, charge: { state: 'uncertain', usage: null } });
    expect(resolution!.advised).toEqual(resolution!.deterministic);
    const attempt = evaluations[0].headers['x-nectovia-attempt'];
    expect(gatewayAttempts().map((row) => [row.id, row.state])).toEqual([[attempt, 'uncertain']]);
    expect((await localHolds(organizationId)).map((hold) => [hold.id, hold.state])).toEqual([[attempt, 'uncertain']]);
  });

  test('no provider meeting the data policy is a named refusal that charged nothing, released on both ledgers', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const organizationId = owner.workspaces[0].organization.id;
    const binding = await home();
    answer = () => Response.json({ error: { code: 404, message: 'No endpoints found matching your data policy.' } }, { status: 404 });
    const { advice } = await preflight(binding);
    expect(advice).toMatchObject({ status: 'refused', dispatched: false, charge: { state: 'none' } });
    expect(advice!.reason).toContain('data policy');
    expect(advice!.reason).not.toMatch(/Jev|OpenRouter|TypeSafe/);
    expect(provider).toHaveLength(1);
    const attempt = evaluations[0].headers['x-nectovia-attempt'];
    expect(gatewayAttempts().map((row) => [row.id, row.state])).toEqual([[attempt, 'released']]);
    expect((await localHolds(organizationId)).map((hold) => [hold.id, hold.state])).toEqual([[attempt, 'released']]);
  });
});

// --- a business whose plan does not include AI usage ---------------------------------------------------

describe('a business whose plan does not include AI usage', () => {
  test.each<[string, AccessFeature[] | null]>([
    ['holds no grant at all', null],
    ['holds the Agent without included usage', ['nectovia-agent']],
  ])('%s: the preflight is refused before anything is sent, and the conversation goes on as without it', async (_, features) => {
    if (features) {
      const billing = await staffToken(DEMO_ACCOUNTS.staffBilling.email);
      await cloud.commercial.issueGrant(billing, orgs.harbor, {
        planId: null, features, source: 'internal-test', reference: 'Agreement 9', note: 'Agent without included usage.',
        validUntil: '2026-12-31T00:00:00.000Z',
      });
    }
    await signIn(DEMO_ACCOUNTS.harborOwner.email);
    const organizationId = orgs.harbor;
    const binding = await home();
    const before = admissions;
    const { advice, resolution } = await preflight(binding);
    expect(advice).toMatchObject({ status: 'refused', dispatched: false, charge: { state: 'none' } });
    expect(advice!.reason).toContain(MANAGED_EVALUATION_NOT_INCLUDED);
    // Only the rule's hints; the resolution is exactly the one without a preflight.
    expect(advice!.origins).not.toMatchObject({ workload: 'advice' });
    expect(resolution!.advised).toEqual(resolution!.deterministic);
    expect(admissions).toBe(before);
    expect(evaluations).toHaveLength(0);
    expect(provider).toHaveLength(0);
    expect(await localHolds(organizationId)).toEqual([]);
  });
});

// --- the payer never switches ------------------------------------------------------------------------------

describe('the owner’s own route', () => {
  test('is never asked for a business conversation, with or without the managed preflight', async () => {
    const owners = scriptedEvaluationPort({ result: { answers: {} } });
    await close();
    await open({ managedJev: false, jevAdvisor: createJevAdvisor({ port: owners }) });
    await signIn(DEMO_ACCOUNTS.owner.email);
    const binding = await home();
    const off = await preflight(binding);
    expect(off.advice).toBeNull();
    expect(off.resolution!.advised).toEqual(off.resolution!.deterministic);
    expect(owners.calls).toHaveLength(0);
    expect(evaluations).toHaveLength(0);

    await close();
    await open({ managedJev: true, jevAdvisor: createJevAdvisor({ port: owners }) });
    await signIn(DEMO_ACCOUNTS.owner.email);
    const on = await preflight(await home());
    expect(on.advice).toMatchObject({ status: 'advised', provenance: { port: MANAGED_EVALUATION_PORT_ID } });
    expect(owners.calls).toHaveLength(0);
    expect(evaluations).toHaveLength(1);
  });

  test('is off unless the host is told: without it, no preflight route exists', async () => {
    await close();
    await open({ managedJev: false });
    await signIn(DEMO_ACCOUNTS.owner.email);
    const binding = await home();
    const response = await request(`/projects/${binding.projectId}/threads/${binding.threadId}/preflight`, 'POST', { text: REQUEST });
    expect(response.status).toBe(404);
    expect(evaluations).toHaveLength(0);
  });
});

// --- the port on its own ----------------------------------------------------------------------------------

describe('the managed port', () => {
  const ORG = 'org_juniper';
  let dir: string;
  let exposure: SpendExposure;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-managed-port-'));
    exposure = new SpendExposure(dir);
    await exposure.init();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const admitted: AgentGatePort = {
    check: async () => ({
      admissionId: 'agent_admission_1', organizationId: ORG, personId: 'person_1', planId: 'business',
      policyRevision: 1, routeKind: 'managed', surface: 'conversation', validUntil: '2026-09-26T13:00:00.000Z',
    }),
  };
  const input: PreflightInput = {
    scope: { tenant: ORG, project: 'project-1', thread: 'thread-1' },
    intent: REQUEST,
    mode: 'ask',
    style: 'efficient',
    sources: [],
    shortlist: [],
  };
  function portWith(options: { gate?: AgentGatePort; fetch?: typeof globalThis.fetch; includes?: boolean }) {
    const calls: Request[] = [];
    const port = managedEvaluationPort({
      account: {
        base: ACCOUNT_SERVICE,
        signedIn: () => true,
        token: async () => 'session-token',
        fetch: async (input, init) => {
          calls.push(new Request(input, init));
          return (options.fetch ?? (async () => new Response(null, { status: 599 })))(input, init);
        },
      },
      includes: () => options.includes ?? true,
      gate: options.gate ?? admitted,
      tierOf: () => 'efficient',
      exposure,
      jobId: () => 'preflight-fixed',
    });
    return { port, calls };
  }
  const holds = () => exposure.list(nectoviaConnectionId(ORG, new Date()));
  const refusal = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
    async () => Response.json({ error: { code, message } }, { status, headers: extra });

  test('a cancellation while the admission is asked sends nothing, holds nothing and charges nothing', async () => {
    let asked = 0;
    const hanging: AgentGatePort = { check: () => { asked += 1; return new Promise(() => {}); } };
    const { port, calls } = portWith({ gate: hanging });
    const records: PreflightChargeRecord[] = [];
    const advisor = createJevAdvisor({ port, recordCharge: (record) => records.push(record) });
    const controller = new AbortController();
    const pending = advisor.preflight(input, controller.signal);
    while (asked === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    controller.abort();
    const advice = await pending;
    expect(advice).toMatchObject({ status: 'unavailable', charge: { state: 'none' }, dispatched: false });
    expect(calls).toHaveLength(0);
    expect(records).toHaveLength(0);
    expect(holds()).toEqual([]);
  });

  test('a refusal from the Agent gate is a refusal that sent nothing, in the gate’s words', async () => {
    const refusing: AgentGatePort = {
      check: async () => { throw new EngineError(AGENT_NOT_INCLUDED, 'This business’s Nectovia Agent access was withdrawn.', false); },
    };
    const { port, calls } = portWith({ gate: refusing });
    const advice = await createJevAdvisor({ port, recordCharge: () => {} }).preflight(input);
    expect(advice).toMatchObject({ status: 'refused', charge: { state: 'none' }, dispatched: false });
    expect(advice.reason).toContain('access was withdrawn');
    expect(calls).toHaveLength(0);
    expect(holds()).toEqual([]);
  });

  test.each([
    ['a plan without included usage', refusal(403, 'agent_not_included', 'Included AI usage isn’t part of this business’s plan, so the Nectovia Agent can’t answer here. Nothing was charged.'), 'not_included'],
    ['a membership that ended', refusal(403, 'not_a_member', 'You are not an active member of this business.'), 'not_included'],
    ['a sign-in that ended', refusal(401, 'sign_in_required', 'Your Nectovia sign-in has ended. Sign in again to continue.'), 'transport_unavailable'],
    ['credits that ran out', refusal(402, 'insufficient_allowance', 'This step needs up to 1 credits and 0 are available.'), 'transport_unavailable'],
    ['an oversized request', refusal(413, 'request_too_large', 'This evaluation is too large for one request.'), 'request_too_large'],
    ['a body the gateway refuses', refusal(400, 'unsupported_field', 'An evaluation carries only a state and its questions.'), 'invalid_transport'],
    ['the company ceiling', refusal(503, 'route_unavailable', 'Nectovia’s model service isn’t available right now. Nothing was charged.'), 'transport_unavailable'],
  ])('%s, before the gateway dispatched, keeps its meaning and releases the local hold', async (_, answer, code) => {
    const { port, calls } = portWith({ fetch: answer });
    const receipts: EvaluationReceipt[] = [];
    const error = await port
      .evaluate({ state: 'x', questions: { q: { type: 'boolean', instructions: 'Yes?' } }, signal: new AbortController().signal, scope: input.scope, onReceipt: (receipt) => receipts.push(receipt) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvaluationTransportError);
    expect((error as EvaluationTransportError).code).toBe(code);
    expect(PRE_DISPATCH_CODES.has(code as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(receipts).toEqual([]);
    expect(holds().map((hold) => hold.state)).toEqual(['released']);
  });

  test('once the request may have left, an outcome the gateway did not name is an uncertain receipt, never a release', async () => {
    const outcomes: (() => Promise<Response>)[] = [
      async () => { throw new TypeError('network connection lost'); },
      async () => new Response('<html>Bad gateway</html>', { status: 502 }),
      refusal(409, 'attempt_in_flight', 'That request is already being answered.'),
    ];
    for (const outcome of outcomes) {
      const { port } = portWith({ fetch: outcome });
      const receipts: EvaluationReceipt[] = [];
      const error = await port
        .evaluate({ state: 'x', questions: { q: { type: 'boolean', instructions: 'Yes?' } }, signal: new AbortController().signal, scope: input.scope, onReceipt: (receipt) => receipts.push(receipt) })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EvaluationTransportError);
      expect(receipts).toMatchObject([{ state: 'uncertain', attemptId: expect.stringMatching(/^exp-/) }]);
      // The port leaves the hold for the charge sink, which marks it uncertain.
      expect(exposure.get(receipts[0].attemptId)?.state).toBe('pending');
      await exposure.markUncertain(receipts[0].attemptId, 'test cleanup');
      await fs.rm(path.join(dir, 'spend-exposure'), { recursive: true, force: true });
      exposure = new SpendExposure(dir);
      await exposure.init();
    }
  });

  test('a plan the session already knows leaves out included usage is refused without asking anyone', async () => {
    let asked = 0;
    const counting: AgentGatePort = { check: async (work) => { asked += 1; return admitted.check(work); } };
    const { port, calls } = portWith({ gate: counting, includes: false });
    const advice = await createJevAdvisor({ port, recordCharge: () => {} }).preflight(input);
    expect(advice).toMatchObject({ status: 'refused', charge: { state: 'none' }, dispatched: false });
    expect(advice.reason).toContain(MANAGED_EVALUATION_NOT_INCLUDED);
    expect(asked).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('the charge sink settles only at the amount this computer prices the same usage at', async () => {
    const card = managedEvaluationRateCard();
    const reserve = (runId: string) =>
      exposure.setCap(nectoviaConnectionId(ORG, new Date()), 1_000_000 as never, { approvedBy: 'the test', note: '' }).then(() =>
        exposure.reserve({
          connectionId: nectoviaConnectionId(ORG, new Date()), route: card.route, modelId: card.modelId, card,
          attempt: { runId, stepId: 'preflight', attempt: 1, requestDigest: 'a'.repeat(64) }, maxMicroUsd: 100 as never,
        }));
    const record = (receipt: EvaluationReceipt): PreflightChargeRecord => ({
      key: 'k', scope: input.scope, at: '2026-09-26T12:00:00.000Z', provenance: null, receipt,
      charge: receipt.state === 'settled'
        ? { state: 'known', microUsd: receipt.microUsd, priceVersion: receipt.rateCard, tokens: { input: receipt.usage.inputTokens, output: receipt.usage.outputTokens } }
        : { state: 'uncertain', usage: null, reason: 'unknown' },
    });
    // 1,000 input tokens at $0.042 a million is 42 micro-USD.
    const agreed = await reserve('agreed');
    await recordManagedCharge(exposure, record({ state: 'settled', attemptId: agreed.id, microUsd: 42, rateCard: card.version, usage: { inputTokens: 1_000, outputTokens: 4 } }));
    expect(exposure.get(agreed.id)).toMatchObject({ state: 'settled', settledMicroUsd: 42 });
    const differs = await reserve('differs');
    await recordManagedCharge(exposure, record({ state: 'settled', attemptId: differs.id, microUsd: 43, rateCard: card.version, usage: { inputTokens: 1_000, outputTokens: 4 } }));
    expect(exposure.get(differs.id)).toMatchObject({ state: 'uncertain', settledMicroUsd: null });
    const otherTerms = await reserve('other-terms');
    await recordManagedCharge(exposure, record({ state: 'settled', attemptId: otherTerms.id, microUsd: 42, rateCard: 'evaluation-price-2027-01-01.1', usage: { inputTokens: 1_000, outputTokens: 4 } }));
    expect(exposure.get(otherTerms.id)).toMatchObject({ state: 'uncertain' });
  });

  test('the advisor’s guarantees hold on the managed port: a hint is never authority, and a rule still decides first', async () => {
    const { port } = portWith({});
    const advisor = createManagedJevAdvisor({
      account: { base: ACCOUNT_SERVICE, signedIn: () => true, token: async () => 'session-token', fetch: async () => new Response(null, { status: 599 }) },
      includes: () => true, gate: admitted, tierOf: () => 'efficient', exposure,
    });
    const advice = await advisor.preflight(input);
    // Not required: an unreachable service is unavailable advice with only the rule's hints.
    expect(advice.status).toBe('unavailable');
    expect(Object.keys(advice).sort()).toEqual([
      'assessedAt', 'charge', 'dispatched', 'hints', 'key', 'origins', 'policyRevision', 'provenance', 'reason', 'redactions', 'status',
    ]);
    expect(Object.keys(advice.hints).sort()).toEqual(['demanding', 'missingEvidence', 'needsClarification', 'needsReview', 'shortlist', 'workload']);
    // Not asked when a rule decides: a demanding request is never asked what kind of work it is.
    const demanding = `${'Compare the three suppliers, reconcile the invoices, draft the plan, then list the risks and the next steps. '.repeat(12)}`;
    const seen: Request[] = [];
    const recording = managedEvaluationPort({
      account: { base: ACCOUNT_SERVICE, signedIn: () => true, token: async () => 't', fetch: async (i, init) => { seen.push(new Request(i, init)); return new Response(null, { status: 599 }); } },
      includes: () => true, gate: admitted, tierOf: () => 'efficient', exposure, jobId: () => 'preflight-demanding',
    });
    await createJevAdvisor({ port: recording, recordCharge: () => {} }).preflight({ ...input, intent: demanding });
    expect(seen).toHaveLength(1);
    const body = (await seen[0].json()) as { questions: Record<string, unknown> };
    expect(Object.keys(body.questions)).not.toContain('workload');
    expect(port.requestedModel).toBe('typesafe/jev-1.13');
  });
});

// --- one price on both sides ------------------------------------------------------------------------------

describe('the terms', () => {
  test('the gateway prices Jev exactly as this computer does', () => {
    const price = EVALUATION_PRICE_JEV_113_OPENROUTER;
    expect(EVALUATION_PROVIDER.model).toBe(price.modelId);
    expect(EVALUATION_PROVIDER.rate).toEqual({
      version: price.version,
      inputMicroUsdPerMillion: price.inputMicroUsdPerMillion,
      cacheReadMicroUsdPerMillion: price.inputMicroUsdPerMillion,
      cacheWriteMicroUsdPerMillion: price.inputMicroUsdPerMillion,
      outputMicroUsdPerMillion: price.outputMicroUsdPerMillion,
    });
    const card = managedEvaluationRateCard();
    expect(card).toMatchObject({ version: price.version, route: 'nectovia', modelId: price.modelId });
    expect(card.short).toEqual({ input: 42_000, cacheWrite: 42_000, cacheRead: 42_000, output: 0 });
  });
});
