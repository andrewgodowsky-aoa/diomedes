/**
 * PH-07 round 3: independent reproducers against the integrated PostHog candidate (f35f06e): PH-01
 * observation and PH-02 export, repaired for round 2's N-1 to N-3 (7e3765c) and merged with main
 * (bot mode #153, the account service #152; 62a2198, 2acb30a, c69394e, 81612fd). Written by the
 * round 3 reviewer, who wrote neither the candidate nor rounds 1 and 2, in the style of
 * `tests/ph07-round2-review.test.ts`, whose scaffold it reuses.
 *
 * Every integrated case runs the real `createApp` with the faux account service in this process,
 * its own managed gateway (for the `nectovia` route) and a scripted provider behind both the
 * gateway and the owner's AWS route. Nothing here reaches AWS, PostHog or any other host. The faux
 * account service is reached through an in-process fetcher a test may intercept, to answer one
 * request with a failure or to hold it.
 *
 * Groups:
 *   K  the widening in 7e3765c: which failed rechecks are final, and whether "unreachable" is seen
 *   M  N-2's definitive refusals at the admission boundary
 *   B  N-1's rule ("decide the business once, before the round trip") applied to a bind
 *   C  the gate's `refusalCode`: nothing the person sees changes, on either route
 *   P  the payer, and cost on the managed route
 *   E  per-message scopes: the 2,000-entry map, eviction, and which business a refusal ends
 *   I  round 1's invariants on the merged tree, for the `nectovia` route
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import { EngineError } from '../server/engines/process.js';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock.js';
import { nectoviaConnectionId } from '../server/engines/nectovia.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import type { AdmittedAgentWork, AgentGatePort, AgentWork } from '../server/accounts/agent-gate.js';
import type { ObservationOperatorConfig } from '../server/observability/eligibility.js';
import { BoundedObservationExporter, MemoryObservationSink } from '../server/observability/exporter.js';
import type { ObservationOptions, ObservationRuntime } from '../server/observability/runtime.js';
import { ObservationProjector } from '../server/observability/projector.js';
import { ObservationScopes } from '../server/observability/scopes.js';
import { uuidFor } from '../server/observability/sanitize.js';
import { toWireEvent, WIRE_KEYS, type PostHogWireEvent } from '../server/observability/wire.js';
import { exposureStepId } from '../server/harness/model-api-adapter.js';
import type { ExposureReservation } from '../server/spend-exposure.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import type { AccountStateView } from '../shared/accounts.js';
import type { HarnessEvent, HarnessRun, StepRecord } from '../shared/harness.js';
import { OBSERVATION_CONTRACT, known, unknown, type Observation, type ScopeFacts } from '../shared/observability.js';
import type { Conversation, Project } from '../shared/types.js';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const TIMEOUT = 90_000;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const ACCOUNT_ID = '123456789012';
const POSTHOG_HOST = 'https://posthog.invalid';
const CAPTURE_KEY = 'phc_testOnlyNotARealKey0';
const USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 10,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 110,
};
/** Round 3 canaries: single tokens, so no split can hide them. */
const C3 = {
  prompt: 'Ph07r3PromptCanaryA7',
  answer: 'Ph07r3AnswerCanaryB8',
  responseId: 'Ph07r3RespCanaryC9',
  command: 'Ph07r3CommandCanaryD1',
};

// --- the scripted provider: the owner's AWS route, and the provider behind the managed gateway -----

type Item = Record<string, unknown>;
const message = (text: string, id = 'msg'): Item => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const functionCall = (name: string, args: unknown, id = 'fc'): Item => ({
  type: 'function_call',
  id,
  call_id: `call_${id}`,
  name,
  arguments: JSON.stringify(args),
  status: 'completed',
});
function respond(n: number, output: Item[], options: { model?: string; id?: string } = {}) {
  return sseResponse(
    responsesEvents({
      id: options.id ?? `resp_${n}`,
      object: 'response',
      created_at: 1_760_000_000,
      model: options.model ?? AWS_LUNA_MODEL,
      status: 'completed',
      output: output.map((item, index) => ({ ...item, id: `${item.id}_${n}_${index}` })),
      usage: USAGE,
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-${n}` },
  );
}

type Reply = (n: number, body: string) => Response | Promise<Response>;
let awsBodies: string[];
let replies: Reply[];
const aws = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = String(init?.body ?? '');
  awsBodies.push(body);
  const n = awsBodies.length;
  const next = replies.shift();
  if (next) return next(n, body);
  return respond(n, [message('The order has 100 napkins.')]);
}) as typeof globalThis.fetch;

/** Calls the managed gateway made to its provider (the Nectovia route). */
let gatewayBodies: string[];
let gatewayReplies: ((n: number, model: string) => Response | Promise<Response>)[];
const gatewayProvider = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = typeof init?.body === 'string' ? init.body : '{}';
  gatewayBodies.push(body);
  let model: string = AWS_LUNA_MODEL;
  try {
    model = String((JSON.parse(body) as { model?: string }).model ?? AWS_LUNA_MODEL);
  } catch {
    // Only the model is read, to echo it.
  }
  const n = gatewayBodies.length;
  const next = gatewayReplies.shift();
  if (next) return next(n, model);
  return respond(n, [message('Twelve loaves are on order.')], { model, id: `resp_gw_${n}` });
}) as typeof globalThis.fetch;

// --- the fake PostHog network (round 1's) -----------------------------------------------------------

let posts: { url: string; body: string }[];
type Network = 'ok' | 'throws' | 'hangs' | '500';
function posthogNetwork(mode: Network): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: String(init?.body ?? '') });
    if (mode === 'throws') throw new TypeError('network down');
    if (mode === 'hangs') return new Promise<Response>(() => undefined);
    if (mode === '500') return new Response(null, { status: 500 });
    return new Response('{"status":1}', { status: 200 });
  }) as typeof globalThis.fetch;
}

// --- the host -----------------------------------------------------------------------------------------

let root: string;
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let backend: AccountBackend;
let engines: EngineService;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let sink: MemoryObservationSink;
/** When set, answers the faux account service's requests instead of the service (null passes through). */
let intercept: ((request: Request) => Promise<Response> | null) | null;
const pathOf = (request: Request) => new URL(request.url).pathname;
const isAdmission = (request: Request) => request.method === 'POST' && pathOf(request).endsWith('/agent-admissions');
const isAccess = (request: Request) => request.method === 'GET' && /^\/account\/organizations\/[^/]+\/access$/.test(pathOf(request));

const operator = (internal: string[], overrides: Partial<ObservationOperatorConfig> = {}): ObservationOperatorConfig => ({
  mode: 'memory',
  environment: 'test',
  companyHost: true,
  internalOrganizations: new Set(internal),
  pseudonymKey: new Uint8Array(32).fill(5),
  customerExport: false,
  posthog: null,
  ...overrides,
});
const memory = (internal: string[]): ObservationOptions => ({ operator: operator(internal), sink, timer: false });
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const exporting = (internal: string[], network: Network): ObservationOptions => ({
  operator: operator(internal, {
    mode: 'posthog',
    posthog: { host: POSTHOG_HOST, captureKey: CAPTURE_KEY, fundedUntil: day(30), dailyEvents: 10_000 },
  }),
  fetch: posthogNetwork(network),
  timer: false,
  random: () => 0,
});

async function open(observation: ObservationOptions | null | undefined) {
  const dir = path.join(root, 'engines');
  engines = new EngineService(dir, { discover: async () => [] });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: aws,
    accounts: { backend },
    observation: observation as ObservationOptions | null,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  const closing = server;
  server = undefined;
  try {
    await app.locals.close();
  } finally {
    closing.closeAllConnections();
    await new Promise<void>((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
  }
}
/** A new faux account service with the demo seed and its managed gateway; the host reaches it through `intercept`. */
async function freshCloud(timeoutMs?: number) {
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000, managed: { transport: gatewayProvider } });
  orgs = (await seedDemo(cloud)).organizations!;
  backend = {
    client: new ControlPlaneClient('http://faux.local', (req) => intercept?.(req) ?? cloud.handle(req), timeoutMs),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
}
async function fresh() {
  await close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-ph07r3-'));
  sink = new MemoryObservationSink();
  awsBodies = [];
  replies = [];
  gatewayBodies = [];
  gatewayReplies = [];
  posts = [];
  intercept = null;
  await freshCloud();
}

const runtime = () => app.locals.observation as ObservationRuntime | null;
const state = (projectId: string) => app.locals.store.state(projectId);
const request = (route: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api${route}`, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}
const signIn = (email: string) => api<AccountStateView>('/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false });
const switchTo = (organizationId: string | null) =>
  api('/workspace/switch', 'POST', organizationId ? { kind: 'business', organizationId } : { kind: 'personal' });

interface Target {
  projectId: string;
  threadId: string;
}
async function connectAws(capUsd = 5) {
  await api('/ai/model-api/aws-bedrock', 'PUT', { accountId: ACCOUNT_ID, region: 'us-east-1', model: AWS_LUNA_MODEL, apiKey: SECRET, expiresAt: null, consent: true });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd, consent: true });
}
async function shareWithAws(projectId: string) {
  await api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['aws-bedrock'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
}
async function workingAws(name = 'Linen order'): Promise<Target> {
  const project = await api<Project>('/projects', 'POST', { name });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
  await shareWithAws(project.id);
  await connectAws();
  return { projectId: project.id, threadId: thread.id };
}
/** The Home conversation, on the Nectovia route: nothing is connected. */
const home = () => api<Target>('/home/conversation', 'POST');
const say = (target: Target, commandId: string, text: string, extraHeaders: Record<string, string> = {}) =>
  request(
    `/projects/${target.projectId}/threads/${target.threadId}/messages`,
    'POST',
    { commandId, text, mode: 'auto', sources: [], consent: true },
    extraHeaders,
  );

const parse = (bodies: string[]) => bodies.flatMap((body) => (JSON.parse(body) as { batch: PostHogWireEvent[] }).batch);
async function drained(): Promise<PostHogWireEvent[]> {
  await runtime()?.exporter.flush(10_000);
  return parse(sink.batches);
}
const of = (events: PostHogWireEvent[], name: string) => events.filter((item) => item.event === name);
const nonZero = (record: Readonly<Record<string, number>>) => Object.fromEntries(Object.entries(record).filter(([, n]) => n > 0));

async function tokenFor(email: string) {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}
/** Harbor Hardware buys Business, and the Juniper owner joins it: one person, two entitled businesses (round 1's fixture). */
async function harborEntitledWithJuniperOwner() {
  const billing = await tokenFor('billing@diomedes.test');
  await cloud.commercial.issueGrant(billing, orgs.harbor, { planId: 'business', source: 'internal-test', reference: 'PH-07 r3', note: 'Review fixture.' });
  const harborOwner = await tokenFor('owner@harbor.test');
  const code = await cloud.accounts.createInvitationCode(harborOwner, orgs.harbor, { role: 'admin', email: 'owner@juniper.test', ttlMs: 86_400_000 });
  await cloud.accounts.redeemInvitationCode(await tokenFor('owner@juniper.test'), code.code);
}
async function lineageOf(target: Target) {
  const conversation = (state(target.projectId).conversations as { id: string; lineages?: { runId: string }[] }[]).find(
    (item) => item.id === target.threadId,
  );
  return conversation?.lineages?.at(-1)?.runId ?? null;
}
async function turnRun(target: Target, commandId: string): Promise<HarnessRun> {
  const lineage = await lineageOf(target);
  return app.locals.harness.modelSessions.turnRun(target.projectId, lineage!, commandId);
}
/** The turn run in any of the thread's lineages (switching a thread's engine starts a new one). */
async function turnRunAnywhere(target: Target, commandId: string): Promise<HarnessRun | null> {
  const conversation = (state(target.projectId).conversations as { id: string; lineages?: { runId: string }[] }[]).find(
    (item) => item.id === target.threadId,
  );
  for (const lineage of conversation?.lineages ?? []) {
    const found = (await app.locals.harness.modelSessions.turnRun(target.projectId, lineage.runId, commandId)) as HarnessRun | null;
    if (found) return found;
  }
  return null;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** A latch: `hit` resolves when the held call is reached, `release` lets it continue. */
function latch() {
  let reached!: () => void;
  const hit = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return { hit, reached: () => reached(), release: () => release(), released };
}
const json = (status: number, value: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...extra } });
/** A body whose stream fails after its first bytes, as a read cut off by a timeout does. */
const brokenBody = (prefix: string) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix));
        controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** Every encoding of every planted value, searched in the exact bytes (round 1's check). */
function expectNoCanary(bodies: string, planted: string[]) {
  const lower = bodies.toLowerCase();
  for (const value of planted) {
    const forms = [
      value,
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('hex'),
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
    ];
    for (const form of forms) expect(lower.includes(form.toLowerCase()), `${value} as ${form}`).toBe(false);
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-ph07r3-'));
  sink = new MemoryObservationSink();
  awsBodies = [];
  replies = [];
  gatewayBodies = [];
  gatewayReplies = [];
  posts = [];
  intercept = null;
  await freshCloud();
});
afterEach(async () => {
  intercept = null;
  await close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- pure fixtures ------------------------------------------------------------------------------

const ZERO = Date.UTC(2026, 8, 26, 12, 0, 0);
const T = (ms: number) => new Date(ZERO + ms).toISOString();
const admission = (
  organizationId: string,
  admissionId: string,
  surface: AdmittedAgentWork['surface'] = 'conversation',
  routeKind: AdmittedAgentWork['routeKind'] = 'byo',
): AdmittedAgentWork => ({
  admissionId,
  organizationId,
  personId: 'person_1',
  planId: 'business',
  policyRevision: 1,
  routeKind,
  surface,
  validUntil: T(3_600_000),
});
const facts: ScopeFacts = {
  class: 'internal-synthetic',
  synthetic: true,
  sourceTrust: 'company-host',
  environment: 'test',
  organizationKey: `oorg_${'a'.repeat(32)}`,
  admissionId: 'adm_r3',
  surface: 'conversation',
  route: 'aws-bedrock',
  payer: 'byo',
  plan: 'business',
  policyRevision: 1,
  telemetryRevision: null,
};
const trace = (i: number): Observation => ({
  kind: 'trace',
  contract: OBSERVATION_CONTRACT,
  ids: { uuid: uuidFor('test', `r3-${i}`), traceId: `otr_${'b'.repeat(32)}`, spanId: `otr_${'b'.repeat(32)}`, parentId: null, sessionId: null },
  at: '2026-09-26T12:00:00.000Z',
  scope: facts,
  build: '0.2.0',
  capability: 'model-api-turn',
  outcome: 'completed',
  durationMs: known(10),
  modelSteps: 1,
  toolSteps: 0,
  childRuns: 0,
  errorClass: unknown('not-applicable'),
  loopStop: unknown('not-applicable'),
});
let seq = 0;
const event = (runId: string, type: string, at: number, stepId?: string, attempt?: number): HarnessEvent => ({
  v: 1,
  seq: ++seq,
  runId,
  at: T(at),
  type,
  ...(stepId === undefined ? {} : { stepId }),
  ...(attempt === undefined ? {} : { attempt }),
  attributes: {},
});
const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'How many loaves?' }] }];
const modelStep = (stepId: string): StepRecord =>
  ({
    intent: { stepId, stepVersion: '1', kind: 'model', effect: 'read', name: 'model-api', input: { request: { messages: MESSAGES } } },
    intentHash: 'h',
    attempt: 1,
    state: 'succeeded',
    output: { response: { type: 'final', text: 'x' } },
    leaseFence: 1,
    startedAt: null,
    endedAt: null,
    error: null,
  }) as unknown as StepRecord;
const run = (id: string, capabilityId: string, input: Record<string, unknown>, events: HarnessEvent[], steps: StepRecord[]): HarnessRun =>
  ({
    v: 1,
    id,
    tenantId: 't',
    projectId: 'p',
    taskId: null,
    sessionId: null,
    capabilityId,
    capabilityVersion: '1',
    capabilityTools: [],
    policyVersion: '1',
    principal: {} as never,
    input,
    state: 'completed',
    budget: {} as never,
    used: {} as never,
    owner: null,
    fence: 1,
    leaseExpiresAt: null,
    parentRunId: null,
    forkPoint: null,
    contextRevision: 0,
    transcripts: {},
    result: null,
    failure: null,
    cancelReason: null,
    createdAt: T(0),
    updatedAt: T(10),
    steps,
    approvals: [],
    lastSeq: events.at(-1)?.seq ?? 0,
    events,
  }) as HarnessRun;
/** A completed run with one succeeded model attempt. */
const completedRun = (id: string, capabilityId: string, input: Record<string, unknown>) =>
  run(
    id,
    capabilityId,
    input,
    [event(id, 'run.created', 1), event(id, 'step.started', 2, 'model:0', 1), event(id, 'step.succeeded', 3, 'model:0', 1), event(id, 'run.completed', 4)],
    [modelStep('model:0')],
  );
const capture = (seen: Observation[]) => ({
  enqueue: (item: Observation) => void seen.push(item),
  flush: async () => {},
  discard: () => 0,
  health: () => ({}) as never,
  close: async () => {},
});

// =================================================================================================
// K. The widening in 7e3765c: every failed recheck is final except `account-service-unavailable`
// =================================================================================================

describe('K which failed rechecks are final', () => {
  test('K1 the account service not answering for the business is final when the session reports it as `unknown`, and not final when a read throws', () => {
    let window: 'active' | 'unanswered' | 'throws' = 'active';
    const scopes = new ObservationScopes({
      operator: operator(['org_a']),
      backend: () => 'faux',
      authority: {
        personId: () => 'person_1',
        activeOrganizationId: () => 'org_a',
        // What `AccountSessionService.entitlement()` returns when its last access read failed
        // (server/accounts/session.ts:437-446): state `unknown`, not an answer about the plan.
        entitlement: () => {
          if (window === 'throws') throw new Error('unreadable');
          return window === 'unanswered' ? { agent: false, state: 'unknown' } : { agent: true, state: 'active' };
        },
      },
      now: () => ZERO,
    });
    const bound = (job: string) => {
      const decision = scopes.decide({ admission: admission('org_a', `adm_${job}`), rootJobId: job, route: 'aws-bedrock', connectionId: 'c1', model: null });
      if (!decision.eligible) throw new Error(decision.denial);
      return decision.scope;
    };
    const unanswered = bound('turn-unanswered');
    const thrown = bound('turn-thrown');

    window = 'unanswered';
    const during = scopes.recheck(unanswered);
    window = 'throws';
    const duringThrown = scopes.recheck(thrown);
    window = 'active'; // the service answers again: the business was never refused
    const seen = { during, duringThrown, afterUnanswered: scopes.recheck(unanswered), afterThrown: scopes.recheck(thrown) };

    // The builder's own contract sentence (section 3, N-3 ruling): "only an inability to ask
    // (`account-service-unavailable`) is not [final]". Both windows are an inability to ask.
    expect(seen.duringThrown).toEqual({ live: false, denial: 'account-service-unavailable' });
    expect(seen.afterThrown, 'a read that throws is not final').toEqual({ live: true });
    expect(seen, 'the same outage, reported as `unknown`, ends the scope for good').toMatchObject({
      during: { live: false, denial: 'account-service-unavailable' },
      afterUnanswered: { live: true },
    });
  });

  test(
    'K2 an access read that fails during a refresh (503, 429, network, a body cut off mid-read, a 200 that is not JSON) ends a running turn’s observation for good; a malformed `{}` does not',
    async () => {
      const outcome: Record<string, unknown> = {};
      const lost: string[] = [];
      const modes = ['503', '429', 'network', 'cut-off body', '200 not JSON', '200 {}'] as const;
      for (const mode of modes) {
        await fresh();
        await open(memory([orgs.juniper]));
        await signIn('owner@juniper.test');
        const target = await workingAws();

        // One turn: a tool call, then a second model call that is held at the provider.
        const held = latch();
        replies.push((n) => respond(n, [functionCall('list_sources', {})]));
        replies.push(async (n) => {
          held.reached();
          await held.released;
          return respond(n, [message('There are no sources yet.')]);
        });
        const pending = say(target, 'k-1', 'List the sources.');
        await held.hit;
        const queuedBefore = runtime()!.exporter.health().queued;

        // The person presses Refresh. The account service does not answer the access read.
        intercept = (req) => {
          if (!isAccess(req)) return null;
          if (mode === '503') return Promise.resolve(json(503, { error: 'upstream unavailable' }));
          if (mode === '429') return Promise.resolve(json(429, { error: 'slow down' }, { 'retry-after': '1' }));
          if (mode === 'network') return Promise.reject(new TypeError('fetch failed'));
          if (mode === 'cut-off body') return Promise.resolve(brokenBody('{"organizationId":"'));
          if (mode === '200 not JSON') return Promise.resolve(new Response('<html>gateway</html>', { status: 200 }));
          return Promise.resolve(json(200, {}));
        };
        const failedRefresh = await request('/account/refresh', 'POST', {});
        intercept = null;
        let during: string | null;
        try {
          during = (app.locals.accounts.entitlement(orgs.juniper) as { state: string } | null)?.state ?? null;
        } catch {
          during = 'throws';
        }
        // The exporter's own timer flushes every 10 s (contract 4.7); this is that flush, mid-outage.
        await runtime()!.exporter.flush(10_000);
        const deniedDuring = { ...runtime()!.scopes.denials() };

        // The service answers again. Nothing about the business changed at any point.
        const goodRefresh = await request('/account/refresh', 'POST', {});
        const after = app.locals.accounts.entitlement(orgs.juniper) as { state: string; agent: boolean } | null;
        held.release();
        const answered = await pending;
        const events = await drained();
        const health = runtime()!.exporter.health();
        outcome[mode] = {
          refreshStatus: failedRefresh.status,
          entitlementDuring: during,
          refreshAfter: goodRefresh.status,
          entitlementAfter: after?.state ?? null,
          turn: answered.status,
          queuedBefore,
          deniedDuring,
          exportedAfter: events.map((item) => item.event),
          dropped: nonZero(health.dropped),
        };
        expect(answered.status, `${mode}: the turn itself is unaffected`).toBe(200);
        expect(after?.state, `${mode}: precondition, the service answers again`).toBe('active');
        // What was enqueued after the service answered again: the turn's last generation and its trace.
        if (of(events, '$ai_trace').length === 0) lost.push(mode);
      }
      // Contract section 3, architect ruling N-2: an outage ends nothing. N-3 as the builder wrote it:
      // only an inability to ask is not final.
      expect(lost, `the turn’s trace after the service answered again; observed: ${JSON.stringify(outcome, null, 1)}`).toEqual([]);
    },
    TIMEOUT * 4,
  );
});

// =================================================================================================
// M. N-2's definitive refusals at the admission boundary
// =================================================================================================

describe('M which admission failures end a business’s observation', () => {
  test(
    'M1 a 404 or 403 that is not the service’s membership answer (a Worker that does not know the route, an edge block) is read as `not_a_member` and ends the business’s observation',
    async () => {
      const outcome: Record<string, unknown> = {};
      const ended: string[] = [];
      const modes = {
        // The Worker's own answer for an action it does not have (services/control-plane/src/worker.ts:225).
        '404 unknown action': () => json(404, { error: 'This account action was not found.' }),
        // An edge or proxy refusal: HTML, no JSON, no code.
        '403 edge page': () => new Response('<html><body>Access denied</body></html>', { status: 403, headers: { 'content-type': 'text/html' } }),
      };
      for (const [mode, answer] of Object.entries(modes)) {
        await fresh();
        await open(memory([orgs.juniper]));
        await signIn('owner@juniper.test');
        const target = await workingAws();
        expect((await say(target, 'm-1', 'Summarize the order.')).status).toBe(200);
        intercept = (req) => (isAdmission(req) ? Promise.resolve(answer()) : null);
        const refused = await say(target, 'm-2', 'Summarize it again.');
        intercept = null;
        const events = await drained();
        const denied = runtime()!.scopes.denials();
        outcome[mode] = { person: refused.status, body: await refused.text(), exported: events.map((item) => item.event), denied };
        if ((denied['admission-refused'] ?? 0) > 0 || of(events, '$ai_trace').length === 0) ended.push(mode);
      }
      // The membership and the grant are intact throughout: the service never refused the business.
      expect(ended, `observed: ${JSON.stringify(outcome, null, 1)}`).toEqual([]);
    },
    TIMEOUT * 2,
  );

  test(
    'M2 positive control: a real membership withdrawal ends the business’s observation',
    async () => {
      await harborEntitledWithJuniperOwner();
      await open(memory([orgs.harbor]));
      const person = await signIn('owner@juniper.test');
      await switchTo(orgs.harbor);
      const target = await workingAws('Harbor stock');
      expect((await say(target, 'm-h1', 'Summarize the stock.')).status).toBe(200);
      const harborOwner = await tokenFor('owner@harbor.test');
      await cloud.accounts.setMembership(harborOwner, orgs.harbor, person.person!.id, { role: 'admin', state: 'revoked' });
      const refused = await say(target, 'm-h2', 'Summarize it again.');
      expect(refused.status).toBe(403);
      expect(of(await drained(), '$ai_trace')).toHaveLength(0);
      expect(runtime()!.scopes.denials()['admission-refused']).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    'M3 failures that are not a refusal end nothing: 429, a body cut off mid-read, a 200 that is `{}` or not JSON, a 422',
    async () => {
      const outcome: Record<string, unknown> = {};
      const ended: string[] = [];
      const modes = {
        '429': () => json(429, { error: 'slow down' }, { 'retry-after': '1' }),
        'cut-off body': () => brokenBody('{"admissionId":"agent_admission_'),
        '200 {}': () => json(200, {}),
        '200 not JSON': () => new Response('<html>gateway</html>', { status: 200 }),
        '422': () => json(422, { error: 'The account request contains invalid or unexpected fields.' }),
      };
      for (const [mode, answer] of Object.entries(modes)) {
        await fresh();
        await open(memory([orgs.juniper]));
        await signIn('owner@juniper.test');
        const target = await workingAws();
        expect((await say(target, 'm-1', 'Summarize the order.')).status).toBe(200);
        intercept = (req) => (isAdmission(req) ? Promise.resolve(answer()) : null);
        const failed = await say(target, 'm-2', 'Summarize it again.');
        intercept = null;
        const events = await drained();
        const denied = runtime()!.scopes.denials();
        outcome[mode] = { person: failed.status, exported: events.map((item) => item.event), denied };
        expect(failed.ok, `${mode}: the second turn is not admitted`).toBe(false);
        if ((denied['admission-refused'] ?? 0) > 0 || of(events, '$ai_trace').length === 0) ended.push(mode);
      }
      console.info(`M3 observed: ${JSON.stringify(outcome)}`);
      expect(ended, `observed: ${JSON.stringify(outcome, null, 1)}`).toEqual([]);
    },
    TIMEOUT * 3,
  );
});

// =================================================================================================
// B. N-1's rule applied to a bind: the workspace a scope is compared against
// =================================================================================================

describe('B the workspace a scope is bound against', () => {
  test(
    'B1 a workspace switch during an admitted turn’s round trip: the scope is bound against the business switched to, so the turn’s events leave while the person is in the other business, and are dropped if they come back',
    async () => {
      /** Juniper's admission held at the account service while the person opens Harbor; then flushed in Harbor, or back in Juniper. */
      const scenario = async (flushIn: 'harbor' | 'juniper') => {
        await fresh();
        await harborEntitledWithJuniperOwner();
        await open(memory([orgs.juniper, orgs.harbor]));
        await signIn('owner@juniper.test');
        await switchTo(orgs.juniper);
        const juniper = await workingAws(); // not owned by a business: the gate asks about the active one
        const held = latch();
        intercept = (req) => {
          if (!isAdmission(req)) return null;
          held.reached();
          return held.released.then(() => cloud.handle(req));
        };
        const pending = say(juniper, 'b-1', 'Summarize the order.');
        await held.hit;
        const switching = switchTo(orgs.harbor);
        const raced = await Promise.race([switching.then(() => true), sleep(5_000).then(() => false)]);
        held.release();
        await switching;
        intercept = null;
        expect(raced, 'precondition: the switch landed while the admission was in flight').toBe(true);
        expect((await pending).status, 'the service admitted Juniper').toBe(200);
        const scope = runtime()!.scopes.resolve(await turnRun(juniper, 'b-1'))!.scope;
        const bound = {
          organization: scope.organizationId === orgs.juniper ? 'juniper' : 'other',
          activeAtBind: scope.activeOrganizationAtBind === orgs.harbor ? 'harbor' : scope.activeOrganizationAtBind,
        };
        if (flushIn === 'juniper') await switchTo(orgs.juniper);
        const events = await drained();
        return { bound, exported: events.map((item) => item.event), dropped: nonZero(runtime()!.exporter.health().dropped), denied: runtime()!.scopes.denials() };
      };
      const backInJuniper = await scenario('juniper');
      const inHarbor = await scenario('harbor');
      const observed = { inHarbor, backInJuniper };
      // Contract 4.6 and open question 4 (accepted provisionally): a workspace switch ends optional
      // export for already-admitted work in the other business. N-1's ruling: the business is decided
      // once, before the round trip, and never re-derived after it.
      expect(inHarbor.exported, `Juniper’s turn while the person is in Harbor; observed: ${JSON.stringify(observed)}`).toEqual([]);
    },
    TIMEOUT * 2,
  );
});

// =================================================================================================
// C. The gate's `refusalCode`: nothing the person sees changes, on either route
// =================================================================================================

describe('C refusalCode is invisible to the person', () => {
  test(
    'C1 every refusal the gate can raise gives the same status and the same body bytes with the field as without it, on the AWS route and on the Nectovia route',
    async () => {
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      await switchTo(orgs.juniper);
      const awsTarget = await workingAws();
      const nectovia = await home();

      // The live gate, and a copy of each refusal without the field: the error the gate threw before 7e3765c.
      const gate = engines.agentGate as AgentGatePort;
      const live = gate.check.bind(gate);
      let strip = false;
      const codes: (string | null)[] = [];
      gate.check = async (work: AgentWork) => {
        try {
          return await live(work);
        } catch (error) {
          const code = (error as { refusalCode?: unknown }).refusalCode;
          codes.push(typeof code === 'string' ? code : null);
          if (strip && error instanceof EngineError) throw new EngineError(error.code, error.message, error.ambiguous);
          throw error;
        }
      };
      const refusalBody = (code: string, reason: string) => ({
        admissionId: 'agent_admission_00000000-0000-4000-8000-000000000000',
        decision: { admitted: false, code, reason },
        pins: { organizationId: orgs.juniper, tenantId: 't', personId: 'p', planId: 'business', accessRevision: 1, policyRevision: 1, rootJobId: null },
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      });
      const cases: Record<string, () => Response> = {
        entitlement_revoked: () => json(200, refusalBody('entitlement_revoked', 'This business’s Nectovia Agent access was withdrawn. Your files and history are unchanged.')),
        entitlement_expired: () => json(200, refusalBody('entitlement_expired', 'This business’s plan has ended, so the Nectovia Agent is not available. Your files and history are unchanged.')),
        agent_not_included: () => json(200, refusalBody('agent_not_included', 'The Nectovia Agent is part of a Business plan. You can still use your workspace and your own AI tools directly.')),
        personal_workspace: () => json(200, refusalBody('personal_workspace', 'The Nectovia Agent works for a business.')),
        'not_a_member (403)': () => json(403, { error: 'Current membership could not be established.' }),
        'entitlement_unknown (503)': () => json(503, { error: 'upstream unavailable' }),
        'sign_in_required (401)': () => json(401, { error: 'A verified bearer session is required.' }),
      };
      const seen: Record<string, { withField: unknown; without: unknown }> = {};
      let n = 0;
      const send = async (target: Target) => {
        const response = await say(target, `c-${++n}`, 'Summarize the order.');
        return { status: response.status, body: await response.text() };
      };
      for (const [name, answer] of Object.entries(cases))
        for (const [label, target] of [['aws', awsTarget], ['nectovia', nectovia]] as const) {
          intercept = (req) => (isAdmission(req) ? Promise.resolve(answer()) : null);
          strip = false;
          const withField = await send(target);
          strip = true;
          const without = await send(target);
          intercept = null;
          seen[`${name} / ${label}`] = { withField, without };
        }
      // Personal: the gate refuses before it asks the service, so no field is set at all.
      await switchTo(null);
      strip = false;
      const personalAws = await send(awsTarget);
      const personalNectovia = await send(nectovia);
      strip = true;
      seen['personal / aws'] = { withField: personalAws, without: await send(awsTarget) };
      seen['personal / nectovia'] = { withField: personalNectovia, without: await send(nectovia) };

      console.info(
        `C1 observed: ${JSON.stringify(Object.fromEntries(Object.entries(seen).map(([name, pair]) => [name, pair.withField])))}; codes ${JSON.stringify(codes)}`,
      );
      // Not vacuous: the live gate did attach the service's code, for every service refusal on both routes.
      for (const code of ['entitlement_revoked', 'entitlement_expired', 'agent_not_included', 'personal_workspace', 'not_a_member', 'entitlement_unknown', 'sign_in_required'])
        expect(codes.filter((item) => item === code).length, code).toBeGreaterThanOrEqual(4);
      for (const [name, pair] of Object.entries(seen)) {
        expect((pair.withField as { status: number }).status, `${name}: refused`).toBeGreaterThanOrEqual(400);
        expect(pair.withField, name).toEqual(pair.without);
      }
      // The error bodies name only the gate's `code` (AGENT_NOT_INCLUDED or sign_in_required), never the service's.
      for (const [name, pair] of Object.entries(seen)) {
        const body = JSON.parse((pair.withField as { body: string }).body) as Record<string, unknown>;
        expect(['AGENT_NOT_INCLUDED', 'sign_in_required'], name).toContain(body.code);
        expect(JSON.stringify(body), name).not.toMatch(/refusalCode|entitlement_|not_a_member|personal_workspace|agent_not_included/);
      }
    },
    TIMEOUT * 2,
  );
});

// =================================================================================================
// P. The payer, and cost on the managed route
// =================================================================================================

describe('P payer and managed cost', () => {
  test(
    'P1 a Nectovia turn whose thread is switched to AWS while the gateway is answering: every event of that turn stays nectovia/managed, the next turn is aws-bedrock/byo, and no trace mixes',
    async () => {
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      await switchTo(orgs.juniper);
      await connectAws();
      const target = await home();
      const held = latch();
      gatewayReplies.push(async (n, model) => {
        held.reached();
        await held.released;
        return respond(n, [message('Twelve loaves are on order.')], { model, id: `resp_gw_${n}` });
      });
      const pending = say(target, 'p-1', 'How many loaves are on order?', { 'X-Nectovia-Payer': 'byo' });
      await held.hit;
      const switched = await request(`/projects/${target.projectId}/threads/${target.threadId}`, 'PUT', { engine: 'aws-bedrock' });
      const switchStatus = switched.status;
      held.release();
      const first = await pending;
      expect(first.status, await first.clone().text()).toBe(200);
      await shareWithAws(target.projectId).catch(() => undefined);
      const second = switchStatus === 200 ? await say(target, 'p-2', 'Summarize the linen order.', { 'X-Nectovia-Payer': 'managed' }) : null;

      const events = await drained();
      const byTrace = new Map<string, Set<string>>();
      for (const item of events) {
        const key = String(item.properties.$ai_trace_id);
        const set = byTrace.get(key) ?? new Set<string>();
        set.add(`${item.properties.nectovia_route}/${item.properties.nectovia_payer}`);
        byTrace.set(key, set);
      }
      const firstTurn = await turnRunAnywhere(target, 'p-1');
      const firstTrace = events.find((item) => item.event === '$ai_trace' && item.properties.nectovia_route === 'nectovia');
      const summary = {
        switchStatus,
        second: second?.status ?? null,
        firstTurn: firstTurn?.state ?? null,
        events: events.map((item) => [item.event, item.properties.nectovia_route, item.properties.nectovia_payer]),
      };
      console.info(`P1 observed: ${JSON.stringify(summary)}`);
      expect(firstTrace, `the Nectovia turn’s trace; ${JSON.stringify(summary)}`).toBeDefined();
      expect(firstTurn?.state).toBe('completed');
      for (const [traceId, kinds] of byTrace) expect([...kinds], `trace ${traceId} carries one route and payer`).toHaveLength(1);
      for (const item of events) {
        if (item.properties.nectovia_route === 'nectovia') {
          expect(item.properties.nectovia_payer, item.event).toBe('managed');
          expect(item.properties, item.event).not.toHaveProperty('nectovia_cost_micro_usd');
          expect(item.properties, item.event).not.toHaveProperty('$ai_total_cost_usd');
          expect(item.properties, item.event).not.toHaveProperty('nectovia_rate_card_key');
        } else expect(item.properties.nectovia_payer, item.event).toBe('byo');
      }
      expect(of(events, 'nectovia_cost_reconciled').filter((item) => item.properties.nectovia_route === 'nectovia')).toEqual([]);
      if (second) {
        expect(second.status, await second.clone().text()).toBe(200);
        expect(events.some((item) => item.event === '$ai_trace' && item.properties.nectovia_route === 'aws-bedrock')).toBe(true);
      }
    },
    TIMEOUT,
  );

  test('P2 a managed hold that reaches a final cost later emits no late cost; the same late cost on a byo hold does (control)', () => {
    seq = 0;
    const scopes = new ObservationScopes({
      operator: operator(['org_a']),
      backend: () => 'faux',
      authority: { personId: () => 'person_1', activeOrganizationId: () => 'org_a', entitlement: () => ({ agent: true, state: 'active' }) },
      now: () => ZERO,
    });
    const bind = (job: string, routeKind: 'managed' | 'byo', route: string, connectionId: string) => {
      const decision = scopes.decide({ admission: admission('org_a', `adm_${job}`, 'conversation', routeKind), rootJobId: job, route, connectionId, model: null });
      if (!decision.eligible) throw new Error(decision.denial);
    };
    bind('lin.tmanaged', 'managed', 'nectovia', 'nectovia-conn');
    bind('lin.tbyo', 'byo', 'aws-bedrock', 'aws-conn');
    const stepId = exposureStepId({ messages: MESSAGES as never });
    const hold = (runId: string, connectionId: string): ExposureReservation =>
      ({
        id: `exp-${runId}`,
        connectionId,
        route: connectionId,
        modelId: AWS_LUNA_MODEL,
        rateCardVersion: 'rc-1',
        attempt: { runId, stepId, attempt: 1, requestDigest: '0'.repeat(64) },
        jobId: null,
        maxMicroUsd: 9_000,
        state: 'pending',
        createdAt: T(1),
        resolvedAt: null,
        uncertainAt: null,
        uncertainReason: null,
        settledMicroUsd: null,
        usage: null,
        band: null,
        overCeiling: false,
        providerRequestId: null,
        reconciledFrom: null,
        note: null,
      }) as unknown as ExposureReservation;
    const holds = [hold('lin.tmanaged', 'nectovia-conn'), hold('lin.tbyo', 'aws-conn')];
    const late: { resolved: ((reservation: ExposureReservation) => void) | null } = { resolved: null };
    const seen: Observation[] = [];
    const projector = new ObservationProjector({
      scopes,
      exporter: capture(seen),
      build: '0.2.0',
      ledger: {
        list: (connectionId) => holds.filter((item) => item.connectionId === connectionId),
        onResolved: (listener) => {
          late.resolved = listener;
        },
      },
    });
    projector.onRunSaved(completedRun('lin.tmanaged', 'model-api-turn', { conversationRunId: 'lin' }));
    projector.onRunSaved(completedRun('lin.tbyo', 'model-api-turn', { conversationRunId: 'lin' }));
    expect(late.resolved, 'the projector listens for late costs').not.toBeNull();
    for (const item of holds)
      late.resolved!({ ...item, state: 'settled', settledMicroUsd: 4_321 as never, resolvedAt: T(20), reconciledFrom: 'owner-entry', usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 } as never });

    const wire = seen.map((item) => toWireEvent(item));
    const managed = wire.filter((item) => item.properties.nectovia_payer === 'managed');
    const byo = wire.filter((item) => item.properties.nectovia_payer === 'byo');
    expect(of(managed, '$ai_generation')).toHaveLength(1);
    expect(of(managed, '$ai_generation')[0].properties.nectovia_cost_state).toBe('gateway-pending');
    for (const item of managed) {
      expect(item.properties, item.event).not.toHaveProperty('nectovia_cost_micro_usd');
      expect(item.properties, item.event).not.toHaveProperty('$ai_total_cost_usd');
      expect(item.properties, item.event).not.toHaveProperty('nectovia_rate_card_key');
    }
    expect(of(managed, 'nectovia_cost_reconciled'), 'no late cost for a managed hold').toEqual([]);
    // Control: the byo generation's late cost is emitted, so the path above was reachable.
    expect(of(byo, 'nectovia_cost_reconciled')).toHaveLength(1);
    expect(of(byo, 'nectovia_cost_reconciled')[0].properties.nectovia_cost_micro_usd).toBe(4_321);
  });
});

// =================================================================================================
// E. Per-message scopes: the 2,000-entry map
// =================================================================================================

describe('E per-message scopes and the scope map', () => {
  const authority = { personId: () => 'person_1', activeOrganizationId: () => 'org_a', entitlement: () => ({ agent: true, state: 'active' }) };

  test('E1 a work loop admitted before 2,000 later messages loses its scope: its trace is never projected, and nothing counts the loss', () => {
    seq = 0;
    const scopes = new ObservationScopes({ operator: operator(['org_a']), backend: () => 'faux', authority, now: () => ZERO });
    scopes.decide({ admission: admission('org_a', 'adm_loop', 'loop'), rootJobId: 'loop-L', route: 'aws-bedrock', connectionId: 'c1', model: null });
    const loop = completedRun('loop-L', 'diomedes-loop', {});
    const before = scopes.resolve(loop) !== null;
    // 2,000 conversation messages while the loop runs: since bot mode each message is its own scope.
    for (let i = 0; i < 2_000; i += 1)
      scopes.decide({ admission: admission('org_a', `adm_m${i}`), rootJobId: `lineage-1.t${i}`, route: 'aws-bedrock', connectionId: 'c1', model: null });
    const seen: Observation[] = [];
    const projector = new ObservationProjector({ scopes, exporter: capture(seen), build: '0.2.0' });
    projector.onRunSaved(loop);
    const observed = {
      resolvedBefore: before,
      resolvedAfter: scopes.resolve(loop) !== null,
      size: scopes.size,
      projected: seen.map((item) => item.kind),
      denials: scopes.denials(),
      stats: projector.stats(),
    };
    expect(observed.resolvedBefore).toBe(true);
    expect(observed.size).toBe(2_000);
    expect(observed.resolvedAfter, `the loop still running when the 2,000th message was admitted; observed: ${JSON.stringify(observed)}`).toBe(true);
  });

  test('E2 after eviction a refusal still drops the evicted scope’s queued event, and only its own business’s', async () => {
    let now = ZERO;
    const scopes = new ObservationScopes({
      operator: operator(['org_a', 'org_b']),
      backend: () => 'faux',
      authority: { ...authority, entitlement: () => ({ agent: true, state: 'active' }) },
      now: () => now,
    });
    const bound = (organizationId: string, job: string, surface: AdmittedAgentWork['surface'] = 'conversation') => {
      const decision = scopes.decide({ admission: admission(organizationId, `adm_${job}`, surface), rootJobId: job, route: 'aws-bedrock', connectionId: 'c1', model: null });
      if (!decision.eligible) throw new Error(decision.denial);
      return decision.scope;
    };
    const memorySink = new MemoryObservationSink();
    const exporter = new BoundedObservationExporter({ sink: memorySink, scopes, clock: () => now, timer: false });
    const loopA = bound('org_a', 'loop-A', 'loop');
    exporter.enqueue(trace(1), loopA);
    for (let i = 0; i < 2_000; i += 1) bound(i % 2 ? 'org_a' : 'org_b', `lineage-${i % 7}.t${i}`);
    const turnB = bound('org_b', 'lineage-9.tlast');
    exporter.enqueue(trace(2), turnB);
    expect(scopes.resolve(completedRun('loop-A', 'diomedes-loop', {})), 'precondition: evicted').toBeNull();
    scopes.refused({ projectId: null, organizationId: 'org_a' });
    now += 1_000;
    await exporter.flush(5_000);
    const sent = parse(memorySink.batches).map((item) => item.uuid);
    expect(sent, 'only business B’s event leaves').toEqual([uuidFor('test', 'r3-2')]);
    expect(exporter.health().dropped['scope-ended']).toBe(1);
    expect(scopes.recheck(turnB)).toEqual({ live: true });
    expect(scopes.recheck(loopA)).toEqual({ live: false, denial: 'admission-refused' });
  });
});

// =================================================================================================
// I. Round 1's invariants on the merged tree, for the `nectovia` route
// =================================================================================================

describe('I invariants on the Nectovia route', () => {
  test(
    'I1 observation off, by the option and by the unset environment: nothing is constructed and a Nectovia send is unchanged',
    async () => {
      const saved = process.env.NECTOVIA_OBSERVATION;
      delete process.env.NECTOVIA_OBSERVATION;
      try {
        for (const option of [null, undefined] as const) {
          await fresh();
          await open(option);
          await signIn('owner@juniper.test');
          const target = await home();
          const sent = await say(target, 'i1-1', 'How many loaves are on order?');
          expect(sent.status, await sent.clone().text()).toBe(200);
          expect(gatewayBodies.length, 'the send reached the managed gateway’s provider').toBeGreaterThan(0);
          expect(runtime(), `observation ${String(option)}`).toBeNull();
          expect(engines.observation, `observation ${String(option)}`).toBeUndefined();
        }
      } finally {
        if (saved === undefined) delete process.env.NECTOVIA_OBSERVATION;
        else process.env.NECTOVIA_OBSERVATION = saved;
      }
    },
    TIMEOUT,
  );

  test(
    'I2 Personal, Free, no plan, and a paying business that is not internal with spoofed headers: Nectovia sends observe nothing',
    async () => {
      const spoof = { 'X-Nectovia-Internal': '1', 'X-Organization-Id': 'org_spoof', 'X-Nectovia-Payer': 'managed', 'X-Nectovia-Route-Kind': 'managed', 'X-Nectovia-Plan': 'business' };
      await harborEntitledWithJuniperOwner();
      await open(memory([orgs.juniper]));
      const seen: Record<string, number> = {};

      await signIn('owner@juniper.test');
      await switchTo(null);
      const personal = await request('/home/conversation', 'POST');
      const personalTarget = personal.ok ? ((await personal.json()) as Target) : null;
      seen.personal = personalTarget ? (await say(personalTarget, 'i2-p', 'How many loaves?', spoof)).status : personal.status;
      await api('/account/sign-out', 'POST');

      await signIn('free@example.test');
      const free = await request('/home/conversation', 'POST');
      const freeTarget = free.ok ? ((await free.json()) as Target) : null;
      seen.free = freeTarget ? (await say(freeTarget, 'i2-f', 'How many loaves?', spoof)).status : free.status;
      await api('/account/sign-out', 'POST');

      // Harbor, entitled by the fixture but not on the internal list: admitted, observed as nothing.
      await signIn('owner@harbor.test');
      await switchTo(orgs.harbor);
      const harbor = await home();
      seen.harborNotInternal = (await say(harbor, 'i2-h', 'How many screws?', spoof)).status;

      expect(seen.personal, JSON.stringify(seen)).not.toBe(200);
      expect(seen.free, JSON.stringify(seen)).not.toBe(200);
      expect(await drained()).toEqual([]);
      expect(runtime()!.exporter.health().enqueued).toBe(0);
      expect(runtime()!.scopes.size).toBe(0);
      expect(runtime()!.scopes.denials()['faux-account-not-internal']).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );

  test(
    'I3 the POST bytes of a Nectovia turn carry none of the planted values, in any of six encodings',
    async () => {
      await open(exporting([orgs.juniper], 'ok'));
      const owner = await signIn('owner@juniper.test');
      const target = await home();
      gatewayReplies.push((n, model) => respond(n, [message(`Twelve loaves, ${C3.answer}.`)], { model, id: `resp_${C3.responseId}` }));
      const sent = await say(target, C3.command, `How many loaves? ${C3.prompt}`);
      expect(sent.status, await sent.clone().text()).toBe(200);
      await runtime()!.exporter.flush(10_000);
      expect(posts.length).toBeGreaterThan(0);
      const events = posts.flatMap((post) => (JSON.parse(post.body) as { batch: PostHogWireEvent[] }).batch);
      expect(of(events, '$ai_trace').length).toBe(1);
      for (const item of events) {
        expect(item.properties.nectovia_payer, item.event).toBe('managed');
        for (const key of Object.keys(item.properties)) expect(WIRE_KEYS[item.event].has(key), `${item.event}.${key}`).toBe(true);
      }
      const lineage = (await lineageOf(target))!;
      const turn = await turnRun(target, C3.command);
      const funding = cloud.store.snapshot().funding;
      const planted = [
        ...Object.values(C3),
        owner.person!.id,
        owner.person!.name,
        'owner@juniper.test',
        orgs.juniper,
        'Juniper Street Bakery',
        target.projectId,
        target.threadId,
        lineage,
        turn.id,
        nectoviaConnectionId(orgs.juniper, new Date()),
        ...funding.attempts.map((item) => item.id),
        ...funding.attempts.map((item) => item.rootJobId),
      ];
      expectNoCanary(posts.map((post) => post.body).join('\n'), planted);
    },
    TIMEOUT,
  );

  test(
    'I4 a PostHog that throws, answers 500 or hangs leaves a Nectovia turn, its local hold and the gateway’s settlement identical to export off',
    async () => {
      /** Numbers, booleans and states only: ids and times differ between runs by design. */
      const shape = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(shape);
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([key, item]) => typeof item !== 'string' || /^(state|kind|usageClass|chargeKind|status|model|route)$/.test(key))
              .map(([key, item]) => [key, shape(item)]),
          );
        return value;
      };
      const outcome = async (mode: 'off' | Network) => {
        await fresh();
        await open(mode === 'off' ? null : exporting([orgs.juniper], mode));
        await signIn('owner@juniper.test');
        const target = await home();
        const sent = await say(target, 'i4-1', 'How many loaves are on order?');
        const body = (await sent.json()) as Record<string, unknown>;
        if (mode !== 'off') await runtime()!.exporter.flush(3_000);
        await cloud.idle();
        const turn = await turnRun(target, 'i4-1');
        const funding = cloud.store.snapshot().funding;
        const local = engines.modelApi!.exposure.list(nectoviaConnectionId(orgs.juniper, new Date()));
        const started = Date.now();
        await close();
        return {
          closedWithin: Date.now() - started < 5_000,
          reached: mode === 'off' ? true : posts.length > 0,
          seen: {
            status: sent.status,
            text: body.text ?? body.answer ?? null,
            turn: {
              state: turn.state,
              events: turn.events.map((item: HarnessEvent) => [item.type, item.stepId ?? null, item.attempt ?? null]),
              steps: turn.steps.map((step: StepRecord) => [step.intent.stepId, step.state, step.attempt]),
            },
            local: local.map((item) => [item.state, item.settledMicroUsd, item.usage]),
            gateway: { attempts: shape(funding.attempts), settlements: shape(funding.settlements) },
            providerCalls: gatewayBodies.length,
          },
        };
      };
      const off = await outcome('off');
      expect(off.seen.status).toBe(200);
      expect(off.seen.providerCalls).toBeGreaterThan(0);
      expect((off.seen.gateway.settlements as unknown[]).length, 'the gateway settled the call').toBeGreaterThan(0);
      for (const mode of ['throws', '500', 'hangs'] as const) {
        const failing = await outcome(mode);
        expect(failing.reached, `${mode}: the transport was called`).toBe(true);
        expect(failing.closedWithin, `${mode}: close finished`).toBe(true);
        expect(failing.seen, mode).toEqual(off.seen);
      }
    },
    TIMEOUT * 3,
  );
});
