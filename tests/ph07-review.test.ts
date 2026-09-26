/**
 * PH-07: independent acceptance reproducers for PostHog PH-01 (metadata observation) and PH-02
 * (the /batch/ transport, switched off by default). Written by the reviewer, not the author.
 *
 * Every integrated case runs the real `createApp` with the faux account service in this process,
 * a scripted AWS transport under the AI SDK, and either the memory sink or the real PostHog
 * transport over a fake network. Nothing here reaches AWS, PostHog or any other host: the only
 * PostHog origin used is `https://posthog.invalid`, and every request to it is answered in process.
 *
 * Groups follow the review brief's priorities:
 *   A exclusion and identity transitions   B spoofing              C outgoing bytes
 *   D failure isolation                    E accounting honesty    F bounds
 *   G default off (environment path)       H the normal internal trace
 *   I the durable errorCode attribute
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import type { TextRequest } from '../server/engines/contract.js';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import { textRunId } from '../server/harness/text-route.js';
import type { ObservationOperatorConfig, ObservationScope } from '../server/observability/eligibility.js';
import {
  BoundedObservationExporter,
  MemoryObservationSink,
  type ObservationSink,
  type SinkResult,
} from '../server/observability/exporter.js';
import type { ObservationOptions, ObservationRuntime } from '../server/observability/runtime.js';
import { ObservationProjector } from '../server/observability/projector.js';
import { ObservationScopes } from '../server/observability/scopes.js';
import { uuidFor } from '../server/observability/sanitize.js';
import { WIRE_KEYS, type PostHogWireEvent } from '../server/observability/wire.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import type { AccountStateView } from '../shared/accounts.js';
import type { HarnessEvent, HarnessRun, StepRecord } from '../shared/harness.js';
import { OBSERVATION_CONTRACT, known, unknown, type Observation, type ScopeFacts } from '../shared/observability.js';
import type { ApprovalCommand, Conversation, Need, Project } from '../shared/types.js';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import { SCRIPTED_MODEL, scriptedEngineService } from './fixtures/scripted-conversation.js';

const TIMEOUT = 90_000;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const ACCOUNT_ID = '123456789012';
const POSTHOG_HOST = 'https://posthog.invalid';
const CAPTURE_KEY = 'phc_testOnlyNotARealKey0';
const PSEUDONYM_HEX = '07'.repeat(32);
const FAIL = 'FailThisTurnPlease';

/** Canaries: none may leave in any encoding. Single tokens, so a split cannot hide them. */
const C = {
  prompt: 'Ph07PromptCanaryA1',
  answer: 'Ph07AnswerCanaryB2',
  toolArg: 'Ph07ToolArgCanaryC3',
  nested: 'Ph07NestedCanaryD4',
  url: 'ph07urlcanarye5',
  path: 'Ph07PathCanaryF6',
  providerError: 'Ph07ProviderErrorCanaryG7',
  providerCode: 'Ph07ProviderCodeCanaryH8',
  project: 'Ph07ProjectCanaryJ9',
  task: 'Ph07TaskCanaryK1',
  unregisteredTool: 'Ph07ToolNameCanaryL2',
  goal: 'Ph07GoalCanaryM3',
  fileBody: 'Ph07FileBodyCanaryN4',
};
const PROPOSAL = JSON.stringify({
  summary: `The plan, ${C.answer}`,
  changes: [{ path: `${C.path}.md`, text: `# ${C.answer}\n`, summary: 'A new plan' }],
});
const USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 10,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 110,
};

// --- the scripted AWS provider ------------------------------------------------------------------

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
function respond(n: number, output: Item[], options: { usage?: typeof USAGE | null; model?: string } = {}) {
  return sseResponse(
    responsesEvents({
      id: `resp_${n}`,
      object: 'response',
      created_at: 1_760_000_000,
      model: options.model ?? AWS_LUNA_MODEL,
      status: 'completed',
      output: output.map((item, index) => ({ ...item, id: `${item.id}_${n}_${index}` })),
      ...(options.usage === null ? {} : { usage: options.usage ?? USAGE }),
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-${n}` },
  );
}

let awsBodies: string[];
let replies: ((n: number, body: string) => Response)[];
const aws = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = String(init?.body ?? '');
  awsBodies.push(body);
  const n = awsBodies.length;
  const next = replies.shift();
  if (next) return next(n, body);
  if (body.includes(FAIL))
    return new Response(JSON.stringify({ code: C.providerCode, message: `${C.providerError}: the service is down` }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  return respond(n, [message(PROPOSAL)]);
}) as typeof globalThis.fetch;

// --- the fake PostHog network -------------------------------------------------------------------

let posts: { url: string; body: string }[];
type Network = 'ok' | 'throws' | 'hangs' | '429' | '500';
function posthogNetwork(mode: Network): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: String(init?.body ?? '') });
    if (mode === 'throws') throw new TypeError('network down');
    // A stuck socket that ignores its abort signal.
    if (mode === 'hangs') return new Promise<Response>(() => undefined);
    if (mode === '429') return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
    if (mode === '500') return new Response(null, { status: 500 });
    return new Response('{"status":1}', { status: 200 });
  }) as typeof globalThis.fetch;
}

// --- the host -----------------------------------------------------------------------------------

let root: string;
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let backendKind: 'faux' | 'cloud';
let backend: AccountBackend;
let engines: EngineService;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let sink: MemoryObservationSink;

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
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
const memory = (internal: string[], config: Partial<ObservationOperatorConfig> = {}, extra: Partial<ObservationOptions> = {}): ObservationOptions => ({
  operator: operator(internal, config),
  sink,
  timer: false,
  ...extra,
});
const exporting = (internal: string[], network: Network, extra: Partial<ObservationOptions> = {}): ObservationOptions => ({
  operator: operator(internal, {
    mode: 'posthog',
    posthog: { host: POSTHOG_HOST, captureKey: CAPTURE_KEY, fundedUntil: day(30), dailyEvents: 10_000 },
  }),
  fetch: posthogNetwork(network),
  timer: false,
  random: () => 0,
  ...extra,
});

/** A Claude Code direct engine (scripted, no binary) beside the model-API routes. */
function directEngines(dir: string): EngineService {
  const scripted = scriptedEngineService(dir, root) as unknown as {
    deps: { discover: () => Promise<unknown[]>; version: () => Promise<string>; adapter: (...args: unknown[]) => Record<string, unknown> };
  };
  const adapter = {
    ...scripted.deps.adapter('claude-code', process.execPath, dir),
    generate: async (input: TextRequest) => ({
      text: PROPOSAL,
      model: SCRIPTED_MODEL,
      version: TESTED_VERSIONS['claude-code'],
      projectId: input.projectId,
      threadId: input.threadId,
      requestId: input.requestId,
    }),
  };
  return new EngineService(dir, {
    discover: scripted.deps.discover as never,
    version: scripted.deps.version,
    adapter: (() => adapter) as never,
  });
}

async function open(observation: ObservationOptions | null | undefined, options: { direct?: boolean } = {}) {
  const dir = path.join(root, 'engines');
  engines = options.direct ? directEngines(dir) : new EngineService(dir, { discover: async () => [] });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: aws,
    accounts: { backend },
    ...(observation === undefined ? {} : { observation }),
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return 0;
  const closing = server;
  server = undefined;
  const started = Date.now();
  try {
    await app.locals.close();
  } finally {
    closing.closeAllConnections();
    await new Promise<void>((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
  }
  return Date.now() - started;
}
async function freshRoot() {
  await close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-ph07-'));
  sink = new MemoryObservationSink();
  posts = [];
  awsBodies = [];
  replies = [];
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
  project: Project;
  thread: Conversation;
}
async function connectAws() {
  await api('/ai/model-api/aws-bedrock', 'PUT', { accountId: ACCOUNT_ID, region: 'us-east-1', model: AWS_LUNA_MODEL, apiKey: SECRET, expiresAt: null, consent: true });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 5, consent: true });
}
async function workingAws(name = `${C.project} linen`, routes: string[] = ['aws-bedrock']): Promise<Target> {
  const project = await api<Project>('/projects', 'POST', { name });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes,
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  await connectAws();
  return { project, thread };
}
const say = (target: Target, commandId: string, text: string, extra: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) =>
  request(
    `/projects/${target.project.id}/threads/${target.thread.id}/messages`,
    'POST',
    { commandId, text, mode: 'auto', sources: [], consent: true, ...extra },
    extraHeaders,
  );

const parse = (bodies: string[]) => bodies.flatMap((body) => (JSON.parse(body) as { batch: PostHogWireEvent[] }).batch);
async function drained(): Promise<PostHogWireEvent[]> {
  await runtime()?.exporter.flush(10_000);
  return parse(sink.batches);
}
const of = (events: PostHogWireEvent[], name: string, capability?: string) =>
  events.filter((item) => item.event === name && (!capability || item.properties.nectovia_capability === capability));

async function tokenFor(email: string) {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}
/** Harbor Hardware buys Business, and the Juniper owner joins it: one person, two entitled businesses. */
async function harborEntitledWithJuniperOwner() {
  const billing = await tokenFor('billing@diomedes.test');
  await cloud.commercial.issueGrant(billing, orgs.harbor, { planId: 'business', source: 'internal-test', reference: 'PH-07', note: 'Review fixture.' });
  const harborOwner = await tokenFor('owner@harbor.test');
  const code = await cloud.accounts.createInvitationCode(harborOwner, orgs.harbor, { role: 'admin', email: 'owner@juniper.test', ttlMs: 86_400_000 });
  await cloud.accounts.redeemInvitationCode(await tokenFor('owner@juniper.test'), code.code);
}

function approval(need: Need): ApprovalCommand {
  return {
    protocolVersion: 1,
    commandId: `decision-${need.id}`,
    resolution: 'go-ahead',
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  };
}
async function openNeed(projectId: string, sessionId: string) {
  let found: Need | undefined;
  await vi.waitFor(
    () => {
      found = state(projectId).needs.find((need: Need) => need.sessionId === sessionId && need.state === 'open');
      expect(found).toBeDefined();
    },
    { timeout: 20_000 },
  );
  return structuredClone(found!);
}

/**
 * Every encoding of every planted value, searched in the exact bytes. A value of four characters or
 * fewer, such as the store's task id "T1", is matched only as a whole token: every ISO timestamp
 * from 10:00 to 19:59 UTC contains "t1". Its base64 and hex forms ("VDE=", "5431") are skipped,
 * because forms that short can't be told apart from ordinary text and numbers.
 */
function expectNoCanary(bodies: string, planted: string[]) {
  const lower = bodies.toLowerCase();
  for (const value of planted) {
    if (value.length <= 4) {
      for (const form of new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])) {
        const token = form.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(new RegExp(`(?<![a-z0-9])${token}(?![a-z0-9])`).test(lower), `${value} as ${form}`).toBe(false);
      }
      continue;
    }
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-ph07-'));
  sink = new MemoryObservationSink();
  posts = [];
  awsBodies = [];
  replies = [];
  backendKind = 'faux';
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  orgs = (await seedDemo(cloud)).organizations!;
  backend = {
    client: new ControlPlaneClient('http://faux.local', (req) => cloud.handle(req)),
    view: () => ({ kind: backendKind, label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// =================================================================================================
// A. Exclusion and identity transitions
// =================================================================================================

describe('A exclusion and identity transitions', () => {
  test(
    'A1 the same internal owner on a direct engine (Claude Code) sends nothing, in conversation or Work, while that owner’s AWS turn does',
    async () => {
      await open(memory([orgs.juniper]), { direct: true });
      await signIn('owner@juniper.test');
      await api('/ai/discover', 'POST', { consent: true });
      await api('/ai/check/claude-code', 'POST', {});
      await api('/ai/select', 'POST', { engine: 'claude-code', model: SCRIPTED_MODEL });
      const target = await workingAws(`${C.project} direct`, ['aws-bedrock', 'claude-code']);

      // Positive control: the model-API turn is observed.
      expect((await say(target, 'm-aws', 'Summarize the order.')).status).toBe(200);
      let events: PostHogWireEvent[] = [];
      await vi.waitFor(async () => {
        events = await drained();
        expect(of(events, '$ai_trace').length).toBe(1);
      });
      const before = new Set(events.map((item) => item.uuid));

      // The same person, the same business workspace, the same thread, on a direct engine.
      await api(`/projects/${target.project.id}/threads/${target.thread.id}`, 'PUT', { engine: 'claude-code' });
      const direct = await say(target, 'm-direct', 'Summarize the order on Claude Code.');
      expect(direct.status, await direct.clone().text()).toBe(200);
      // And a direct-engine Work turn (engine-text-turn on a non-model-API route).
      const taskId = (await api<{ id: string }>(`/projects/${target.project.id}/tasks`, 'POST', { name: `Plan ${C.task}` })).id;
      const work = await api<{ id: string }>(`/projects/${target.project.id}/work/start`, 'POST', {
        taskId,
        route: 'claude-code',
        consent: true,
        sources: [],
      });
      await openNeed(target.project.id, work.id);
      const directRun = await app.locals.harness.runs.get(textRunId(target.project.id, work.id));
      expect(directRun.capabilityId).toBe('engine-text-turn');
      expect(directRun.state).toBe('completed');

      const after = await drained();
      expect(after.map((item) => item.uuid).sort()).toEqual([...before].sort());
      expect(runtime()!.exporter.health().enqueued).toBe(before.size);
    },
    TIMEOUT,
  );

  test(
    'A2 startup: a restart with observation on sends nothing for recorded work, and the next turn in the same conversation sends only itself',
    async () => {
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      const target = await workingAws();
      expect((await say(target, 'm-1', 'Summarize the order.')).status).toBe(200);
      let first: PostHogWireEvent[] = [];
      await vi.waitFor(async () => {
        first = await drained();
        expect(of(first, '$ai_trace').length).toBe(1);
      });
      await close();

      sink = new MemoryObservationSink();
      const restartedAt = Date.now();
      await open(memory([orgs.juniper]));
      expect(await drained(), 'nothing is sent at startup').toEqual([]);
      await signIn('owner@juniper.test');
      expect(await drained(), 'nothing is sent at sign-in').toEqual([]);
      expect((await say(target, 'm-2', 'Summarize it again.')).status).toBe(200);
      let second: PostHogWireEvent[] = [];
      await vi.waitFor(async () => {
        second = await drained();
        expect(of(second, '$ai_trace').length).toBe(1);
      });
      const earlier = new Set(first.map((item) => item.uuid));
      expect(second.filter((item) => earlier.has(item.uuid))).toEqual([]);
      expect(new Set(second.map((item) => item.properties.nectovia_admission_id)).size).toBe(1);
      expect(second[0].properties.nectovia_admission_id).not.toBe(first[0].properties.nectovia_admission_id);
      for (const item of second) expect(Date.parse(item.timestamp)).toBeGreaterThanOrEqual(restartedAt - 1_000);
      // The conversation's session id is stable across the restart: one lineage.
      expect(second[0].properties.$ai_session_id).toBe(first[0].properties.$ai_session_id);
    },
    TIMEOUT,
  );

  test(
    'A3 switching between two entitled businesses: the internal one’s queued events drop, the other sends nothing, and switching back resurrects nothing',
    async () => {
      await harborEntitledWithJuniperOwner();
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      await switchTo(orgs.juniper);
      const juniper = await workingAws();
      expect((await say(juniper, 'm-1', 'Summarize the order.')).status).toBe(200);
      expect(runtime()!.exporter.health().queued).toBeGreaterThan(0);

      await switchTo(orgs.harbor);
      expect(await drained()).toEqual([]);
      expect(runtime()!.exporter.health().dropped['scope-ended']).toBeGreaterThan(0);

      const harbor = await workingAws('Harbor stock');
      expect((await say(harbor, 'm-h', 'Summarize the stock.')).status, 'Harbor is entitled, so the Agent runs').toBe(200);
      expect(await drained()).toEqual([]);
      expect(runtime()!.scopes.denials()['faux-account-not-internal']).toBeGreaterThan(0);

      await switchTo(orgs.juniper);
      expect(await drained()).toEqual([]);
      expect(runtime()!.exporter.health().exported).toBe(0);
    },
    TIMEOUT,
  );

  test(
    'A4 a revocation the host learns only from a refused admission (no reload) ends export of the queued events (contract section 3)',
    async () => {
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      const target = await workingAws();
      expect((await say(target, 'm-1', 'Summarize the order.')).status).toBe(200);
      expect(runtime()!.exporter.health().queued).toBeGreaterThan(0);

      const billing = await tokenFor('billing@diomedes.test');
      const customer = await cloud.commercial.customer(billing, orgs.juniper);
      const grant = customer.grants.find((item) => item.state === 'active')!;
      await cloud.commercial.revokeGrant(billing, orgs.juniper, grant.id, { reason: 'PH-07: plan ended.' });

      // The next admission asks the service, which refuses. No /account/refresh.
      expect((await say(target, 'm-2', 'Summarize it again.')).status).toBe(403);
      const events = await drained();
      expect(events, 'events of a revoked business leave after the service refused it').toEqual([]);
    },
    TIMEOUT,
  );
});

// =================================================================================================
// B. Spoofing
// =================================================================================================

describe('B spoofing', () => {
  test(
    'B1 a client-supplied plan, tenant, internal flag, organization, route kind or header never creates eligibility, for a paying business or Free',
    async () => {
      await harborEntitledWithJuniperOwner();
      await open(memory([orgs.juniper]));
      const spoofBody = {
        internal: true,
        plan: 'business',
        planId: 'business',
        organizationId: orgs.juniper,
        tenantId: orgs.juniper,
        class: 'internal',
        routeKind: 'managed',
        payer: 'managed',
        companyHost: true,
      };
      const spoofHeaders = {
        'X-Nectovia-Internal': '1',
        'X-Organization-Id': orgs.juniper,
        'X-Nectovia-Plan': 'business',
        'X-Tenant-Id': orgs.juniper,
      };

      // A paying business that is not internal, admitted for the Agent.
      await signIn('owner@harbor.test');
      await switchTo(orgs.harbor);
      const harbor = await workingAws('Harbor stock');
      const plain = await say(harbor, 'm-plain', 'Summarize the stock.', {}, spoofHeaders);
      expect(plain.status, 'headers do not stop an admitted turn').toBe(200);
      const bodySpoof = await say(harbor, 'm-spoof', 'Summarize the stock.', spoofBody, spoofHeaders);
      // A strict body refuses unknown fields; a lenient one ignores them. Either way nothing leaves.
      expect([200, 400]).toContain(bodySpoof.status);

      // Free, with every spoof.
      await api('/account/sign-out', 'POST');
      await signIn('free@example.test');
      const free = await workingAws('Free notes');
      expect((await say(free, 'm-free', 'Summarize it.', {}, spoofHeaders)).status).toBe(403);

      // The operator's environment is read once at startup; changing it later widens nothing.
      const saved = process.env.NECTOVIA_OBSERVATION_INTERNAL_ORGS;
      process.env.NECTOVIA_OBSERVATION_INTERNAL_ORGS = orgs.harbor;
      try {
        await api('/account/sign-out', 'POST');
        await signIn('owner@harbor.test');
        await switchTo(orgs.harbor);
        expect((await say(harbor, 'm-env', 'Summarize the stock again.')).status).toBe(200);
      } finally {
        if (saved === undefined) delete process.env.NECTOVIA_OBSERVATION_INTERNAL_ORGS;
        else process.env.NECTOVIA_OBSERVATION_INTERNAL_ORGS = saved;
      }

      expect(await drained()).toEqual([]);
      expect(runtime()!.exporter.health().enqueued).toBe(0);
      expect(runtime()!.scopes.size).toBe(0);
      expect(runtime()!.scopes.denials()['faux-account-not-internal']).toBeGreaterThanOrEqual(2);
    },
    TIMEOUT,
  );
});

// =================================================================================================
// C. The bytes the transport actually sends
// =================================================================================================

describe('C outgoing-packet privacy', () => {
  test(
    'C1 canaries in the prompt, answer, nested tool input, tool error, unregistered tool name, URL, path, provider error body and code, and profile, project and business names never appear in the POST bodies',
    async () => {
      await open(exporting([orgs.juniper], 'ok'));
      const owner = await signIn('owner@juniper.test');
      const target = await workingAws();
      const nestedArgs = {
        path: `C:/Users/${C.path}/Secret/${C.path}.md`,
        url: `https://${C.url}.example/private?token=${C.toolArg}`,
        nested: { deep: [C.nested, { again: C.toolArg }] },
      };
      // Turn 1: the model asks for an offered source tool with canary arguments; any later call
      // in the turn gets the default answer, which carries the answer and path canaries.
      replies.push((n) => respond(n, [functionCall('read_source', nestedArgs)]));
      const first = await say(target, 'm-1', `Read ${C.prompt} at https://${C.url}.example/ and ${nestedArgs.path}`);
      replies.length = 0;
      // Turn 2: the model names a tool nobody registered.
      replies.push((n) => respond(n, [functionCall(C.unregisteredTool, { q: C.toolArg })]));
      const second = await say(target, 'm-2', `Again ${C.prompt}`);
      replies.length = 0;
      // Turn 3: a provider error whose body carries a message and a code.
      const third = await say(target, 'm-3', `${FAIL} ${C.prompt}`);
      expect(third.ok).toBe(false);
      await vi.waitFor(async () => {
        await runtime()!.exporter.flush(5_000);
        const sent = posts.flatMap((post) => (JSON.parse(post.body) as { batch: PostHogWireEvent[] }).batch);
        expect(of(sent, 'nectovia_run_parked').length).toBeGreaterThan(0);
      });
      await runtime()!.exporter.flush(5_000);

      // The exact bytes that left, key included.
      const bodies = posts.map((post) => post.body).join('\n');
      expect(posts.length).toBeGreaterThan(0);
      for (const post of posts) expect(post.url).toBe(`${POSTHOG_HOST}/batch/`);
      const events = posts.flatMap((post) => (JSON.parse(post.body) as { batch: PostHogWireEvent[] }).batch);
      // A tool span exists for the offered tool; the unregistered name leaves as `other` or not at all.
      const spans = of(events, '$ai_span');
      for (const span of spans) expect(['read_source', 'other', 'list_sources', 'verification', 'scripted-step']).toContain(span.properties.$ai_span_name);

      const store = app.locals.store;
      const conversation = (store.state(target.project.id).conversations as { id: string; lineages?: { runId: string }[] }[]).find(
        (item) => item.id === target.thread.id,
      )!;
      const holds = engines.modelApi!.exposure.list('aws-bedrock-1');
      const planted = [
        ...Object.values(C),
        SECRET,
        ACCOUNT_ID,
        'owner@juniper.test',
        owner.person!.name,
        owner.person!.id,
        orgs.juniper,
        'Juniper Street Bakery',
        target.project.id,
        target.thread.id,
        ...(conversation.lineages ?? []).map((item) => item.runId),
        'aws-bedrock-1',
        ...holds.map((hold) => hold.rateCardVersion),
        ...holds.map((hold) => hold.id),
        ...holds.flatMap((hold) => (hold.providerRequestId ? [hold.providerRequestId] : [])),
      ];
      expectNoCanary(bodies, planted);
      // Every key is allowlisted for its event, and no value is nested.
      for (const item of events) {
        for (const [key, value] of Object.entries(item.properties)) {
          expect(WIRE_KEYS[item.event].has(key), `${item.event}.${key}`).toBe(true);
          expect(['string', 'number', 'boolean']).toContain(typeof value);
        }
        expect(Object.keys(item).sort()).toEqual(['event', 'properties', 'timestamp', 'uuid']);
      }
      // What the turns did, so this test is known to have exercised them.
      expect({ first: first.status, second: second.status }).toBeDefined();
    },
    TIMEOUT,
  );
});

// =================================================================================================
// D. Failure isolation with the real transport
// =================================================================================================

describe('D failure isolation', () => {
  type Mode = 'off' | 'throws' | 'hangs' | '429' | '500' | 'tiny-queue' | 'budget-1';
  async function scenario(mode: Mode) {
    await freshRoot();
    const observation: ObservationOptions | null =
      mode === 'off'
        ? null
        : mode === 'tiny-queue'
          ? exporting([orgs.juniper], 'ok', { timer: true, limits: { queueEvents: 1, flushEveryMs: 20 } })
          : mode === 'budget-1'
            ? {
                ...exporting([orgs.juniper], 'ok', { timer: true, limits: { flushEveryMs: 20 } }),
                operator: operator([orgs.juniper], {
                  mode: 'posthog',
                  posthog: { host: POSTHOG_HOST, captureKey: CAPTURE_KEY, fundedUntil: day(30), dailyEvents: 1 },
                }),
              }
            : exporting([orgs.juniper], mode, { timer: true, limits: { flushEveryMs: 20, sendDeadlineMs: 200 } });
    await open(observation);
    await signIn('owner@juniper.test');
    const target = await workingAws();
    const response = await say(target, 'm-iso', `Summarize the order, ${C.prompt}.`);
    const body = (await response.json()) as { answerText?: string };
    // Work with an approval that writes a file.
    const taskId = (await api<{ id: string }>(`/projects/${target.project.id}/tasks`, 'POST', { name: 'Plan it' })).id;
    const work = await api<{ id: string }>(`/projects/${target.project.id}/work/start`, 'POST', {
      taskId,
      route: 'aws-bedrock',
      consent: true,
      sources: [],
    });
    const need = await openNeed(target.project.id, work.id);
    const decided = await request(`/projects/${target.project.id}/needs/${need.id}/resolve`, 'POST', approval(need));
    const decidedStatus = decided.status;
    const file = path.join(state(target.project.id).project.folder, `${C.path}.md`);
    await vi.waitFor(async () => expect(await fs.readFile(file, 'utf8')).toBe(`# ${C.answer}\n`), { timeout: 20_000 });
    await runtime()?.exporter.flush(300);

    const conversation = (state(target.project.id).conversations as { id: string; lineages?: { runId: string }[] }[]).find(
      (item) => item.id === target.thread.id,
    )!;
    const turn = await app.locals.harness.modelSessions.turnRun(target.project.id, conversation.lineages!.at(-1)!.runId, 'm-iso');
    const workRun = await app.locals.harness.runs.get(textRunId(target.project.id, work.id));
    const shape = (run: HarnessRun) => ({
      state: run.state,
      events: run.events.map((item) => [item.type, item.stepId ?? null, item.attempt ?? null]),
      steps: run.steps.map((step) => [step.intent.stepId, step.state, step.attempt]),
    });
    const health = runtime()?.exporter.health() ?? null;
    const result = {
      status: response.status,
      answer: body.answerText,
      turn: shape(turn),
      work: shape(workRun),
      decided: decidedStatus,
      need: state(target.project.id).needs.find((item: Need) => item.id === need.id)!.state,
      file: await fs.readFile(file, 'utf8'),
      history: state(target.project.id).history.map((item: { kind: string }) => item.kind),
      holds: engines.modelApi!.exposure.list('aws-bedrock-1').map((item) => [item.state, item.settledMicroUsd, item.usage]),
      providerCalls: awsBodies.length,
    };
    const closeMs = await close();
    return { result, health, closeMs, attempted: posts.length };
  }

  test(
    'D1 export throwing, hanging, answering 429 or 5xx, a one-event queue and a one-event budget leave the answer, the runs, the approval, the file, the history, the ledger and the provider calls equal to export off',
    async () => {
      const baseline = await scenario('off');
      expect(baseline.result.status).toBe(200);
      expect(baseline.result.decided).toBe(200);
      for (const mode of ['throws', 'hangs', '429', '500', 'tiny-queue', 'budget-1'] as const) {
        const run = await scenario(mode);
        expect(run.result, mode).toEqual(baseline.result);
        expect(run.health, mode).not.toBeNull();
        if (mode === 'tiny-queue') expect(run.health!.dropped['queue-full'], mode).toBeGreaterThan(0);
        else if (mode === 'budget-1') expect(run.health!.exported, mode).toBeLessThanOrEqual(1);
        else {
          expect(run.attempted, `${mode}: the transport was exercised`).toBeGreaterThan(0);
          expect(run.health!.exported, mode).toBe(0);
          expect(run.health!.lastFailure, mode).toBe(
            ({ throws: 'network', hangs: 'timeout', '429': 'http-429', '500': 'http-5xx' } as const)[mode],
          );
        }
        // Shutdown is bounded even with a socket that never answers (contract 4.7: close flushes for at most 2 s).
        expect(run.closeMs, `${mode}: close took ${run.closeMs} ms`).toBeLessThan(baseline.closeMs + 3_000);
      }
    },
    TIMEOUT * 3,
  );
});

// =================================================================================================
// E. Accounting honesty
// =================================================================================================

describe('E accounting honesty', () => {
  test(
    'E1 usage the provider did not report stays unknown (never zero); its late reconciliation is one correlated event, never a second generation; a resent command adds nothing',
    async () => {
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      const target = await workingAws();
      replies.push((n) => respond(n, [message('An answer with no usage.')], { usage: null }));
      const failed = await say(target, 'm-nousage', 'Summarize the order.');
      expect(failed.ok).toBe(false);
      let events: PostHogWireEvent[] = [];
      await vi.waitFor(async () => {
        events = await drained();
        expect(of(events, '$ai_generation').length).toBe(1);
      });
      const generation = of(events, '$ai_generation')[0];
      expect(generation.properties).toMatchObject({ nectovia_cost_state: 'uncertain', nectovia_outcome: 'unknown-outcome', $ai_is_error: true });
      for (const key of [
        '$ai_input_tokens',
        '$ai_output_tokens',
        '$ai_cache_read_input_tokens',
        '$ai_total_cost_usd',
        'nectovia_cost_micro_usd',
        'nectovia_reasoning_tokens',
      ])
        expect(generation.properties, key).not.toHaveProperty(key);

      const hold = engines.modelApi!.exposure.list('aws-bedrock-1').find((item) => item.state === 'uncertain')!;
      expect(hold).toBeDefined();
      await engines.modelApi!.exposure.reconcile(hold.id, { microUsd: 4321 as never, note: 'The owner entered the invoice amount.' });
      await new Promise((resolve) => setImmediate(resolve));
      await vi.waitFor(async () => {
        events = await drained();
        expect(of(events, 'nectovia_cost_reconciled').length).toBe(1);
      });
      const late = of(events, 'nectovia_cost_reconciled')[0];
      expect(late.properties).toMatchObject({
        nectovia_generation_span_id: generation.properties.$ai_span_id,
        nectovia_cost_micro_usd: 4321,
        $ai_total_cost_usd: 0.004321,
        nectovia_reconciled_from: 'owner-entry',
        $ai_trace_id: generation.properties.$ai_trace_id,
      });
      expect(of(events, '$ai_generation').filter((item) => item.properties.$ai_span_id === generation.properties.$ai_span_id)).toHaveLength(1);

      // A normal turn, then the same command resent: nothing new.
      expect((await say(target, 'm-ok', 'Summarize it.')).status).toBe(200);
      await vi.waitFor(async () => {
        events = await drained();
        expect(of(events, '$ai_trace').length).toBe(1);
      });
      const count = events.length;
      const again = await say(target, 'm-ok', 'Summarize it.');
      expect(again.status).toBe(200);
      expect((await drained()).length).toBe(count);
      expect(new Set((await drained()).map((item) => item.uuid)).size).toBe(count);
    },
    TIMEOUT,
  );

  // Pure: a hand-built run through the real scopes and projector.
  const ZERO = Date.UTC(2026, 8, 25, 12, 0, 0);
  const T = (ms: number) => new Date(ZERO + ms).toISOString();
  let seq = 0;
  const event = (type: string, at: number, stepId?: string, attempt?: number): HarnessEvent => ({
    v: 1,
    seq: ++seq,
    runId: 'loop-root',
    at: T(at),
    type,
    ...(stepId === undefined ? {} : { stepId }),
    ...(attempt === undefined ? {} : { attempt }),
    attributes: {},
  });
  function projector() {
    const scopes = new ObservationScopes({
      operator: operator(['org_a']),
      backend: () => 'faux',
      authority: { personId: () => 'person_1', activeOrganizationId: () => 'org_a', entitlement: () => ({ agent: true, state: 'active' }) },
      now: () => ZERO,
    });
    const seen: Observation[] = [];
    const exporter = {
      enqueue: (observation: Observation) => void seen.push(observation),
      flush: async () => {},
      discard: () => 0,
      health: () => ({}) as never,
      close: async () => {},
    };
    scopes.decide({
      admission: {
        admissionId: 'adm_ph07',
        organizationId: 'org_a',
        personId: 'person_1',
        planId: 'business',
        policyRevision: 1,
        routeKind: 'byo',
        surface: 'loop',
        validUntil: T(3_600_000),
      },
      rootJobId: 'loop-root',
      route: 'aws-bedrock',
      connectionId: 'conn-1',
      model: AWS_LUNA_MODEL,
    });
    return { projector: new ObservationProjector({ scopes, exporter, build: '0.2.0' }), seen };
  }
  const baseRun = (events: HarnessEvent[], steps: StepRecord[]): HarnessRun =>
    ({
      v: 1,
      id: 'loop-root',
      tenantId: 't',
      projectId: 'p',
      taskId: null,
      sessionId: null,
      capabilityId: 'diomedes-loop',
      capabilityVersion: '1',
      capabilityTools: [],
      policyVersion: '1',
      principal: {} as never,
      input: {},
      state: 'running',
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

  test('E2 a retried tool step is a new span with a new uuid; saving the run again sends nothing twice', () => {
    const { projector: target, seen } = projector();
    const step = {
      intent: { stepId: 'tool:1', stepVersion: '1', kind: 'tool', effect: 'read', name: 'read_project_file', input: { path: 'x' } },
      intentHash: 'h',
      attempt: 2,
      state: 'succeeded',
      output: {},
      leaseFence: 1,
      startedAt: null,
      endedAt: null,
      error: null,
    } as unknown as StepRecord;
    const events = [
      event('step.started', 1, 'tool:1', 1),
      event('step.retry_wait', 2, 'tool:1', 1),
      event('step.started', 3, 'tool:1', 2),
      event('step.succeeded', 4, 'tool:1', 2),
    ];
    const run = baseRun(events, [step]);
    target.onRunSaved(run);
    target.onRunSaved(run);
    const spans = seen.filter((item) => item.kind === 'span');
    expect(spans).toHaveLength(2);
    expect(new Set(spans.map((item) => item.ids.spanId)).size).toBe(2);
    expect(new Set(spans.map((item) => item.ids.uuid)).size).toBe(2);
    expect(spans.map((item) => (item.kind === 'span' ? item.attempt : null))).toEqual([1, 2]);
  });
});

// =================================================================================================
// F. Bounds, on a virtual clock
// =================================================================================================

describe('F bounds', () => {
  const facts: ScopeFacts = {
    class: 'internal-synthetic',
    synthetic: true,
    sourceTrust: 'company-host',
    environment: 'test',
    organizationKey: `oorg_${'a'.repeat(32)}`,
    admissionId: 'adm_ph07',
    surface: 'conversation',
    route: 'aws-bedrock',
    payer: 'byo',
    plan: 'business',
    policyRevision: 1,
    telemetryRevision: null,
  };
  const scope = { scopeId: 'osc_x', facts } as ObservationScope;
  const live = { recheck: () => ({ live: true as const }), denials: () => ({}) };
  const trace = (i: number): Observation => ({
    kind: 'trace',
    contract: OBSERVATION_CONTRACT,
    ids: { uuid: uuidFor('test', `ph07-${i}`), traceId: `otr_${'b'.repeat(32)}`, spanId: `otr_${'b'.repeat(32)}`, parentId: null, sessionId: null },
    at: '2026-09-25T12:00:00.000Z',
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
  class ScriptedSink implements ObservationSink {
    readonly kind = 'posthog' as const;
    readonly bodies: string[] = [];
    constructor(private readonly answers: (SinkResult | 'hang')[], private readonly fallback: SinkResult | 'hang' = { ok: true }) {}
    send(body: string): Promise<SinkResult> {
      this.bodies.push(body);
      const answer = this.answers.shift() ?? this.fallback;
      return answer === 'hang' ? new Promise(() => undefined) : Promise.resolve(answer);
    }
  }
  const gate = { fundedUntil: '2099-12-31', dailyEvents: 1_000_000 };

  test('F1 an event older than the one-hour queue age is not sent when its batch is retried', async () => {
    let now = Date.UTC(2026, 8, 25, 12, 0, 0);
    const sink = new ScriptedSink([{ ok: false, failure: 'http-5xx', retryAfterMs: null }]);
    const exporter = new BoundedObservationExporter({ sink, scopes: live, clock: () => now, timer: false, gate, random: () => 0 });
    exporter.enqueue(trace(1), scope);
    now += 60 * 60 * 1000 - 1_000; // 59:59 in the queue
    await exporter.flush(5_000);
    expect(sink.bodies).toHaveLength(1);
    now += 2_000; // 60:01: past the age limit, and past the 0.5 s backoff
    await exporter.flush(5_000);
    expect(sink.bodies, 'a batch older than an hour went out again').toHaveLength(1);
    expect(exporter.health().dropped.expired).toBe(1);
  });

  test('F2 the queue never holds more than its event cap, counting a batch waiting to be retried', async () => {
    let now = Date.UTC(2026, 8, 25, 12, 0, 0);
    const sink = new ScriptedSink([{ ok: false, failure: 'http-5xx', retryAfterMs: null }]);
    const exporter = new BoundedObservationExporter({
      sink,
      scopes: live,
      clock: () => now,
      timer: false,
      gate,
      random: () => 0,
      limits: { queueEvents: 100, batchEvents: 50 },
    });
    for (let i = 0; i < 100; i += 1) exporter.enqueue(trace(i), scope);
    await exporter.flush(5_000); // 50 go out, fail, and wait to be retried
    for (let i = 100; i < 200; i += 1) exporter.enqueue(trace(i), scope);
    expect(exporter.health().queued, 'events held across the queue and the waiting retry').toBeLessThanOrEqual(100);
    now += 1;
  });

  test('F3 a full queue drops the tail; enqueue never throws or blocks with a hung sink; health never leaves the machine', async () => {
    const sink = new ScriptedSink([], 'hang');
    const exporter = new BoundedObservationExporter({ sink, scopes: live, timer: false, gate, limits: { sendDeadlineMs: 50 } });
    const started = performance.now();
    for (let i = 0; i < 5_000; i += 1) expect(() => exporter.enqueue(trace(i), scope)).not.toThrow();
    const perEvent = (performance.now() - started) / 5_000;
    expect(perEvent).toBeLessThan(2);
    const health = exporter.health();
    expect(health.queued).toBeLessThanOrEqual(1_000 + 50);
    expect(health.queuedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(health.dropped['queue-full']).toBeGreaterThanOrEqual(3_950);
    const flushStarted = performance.now();
    await exporter.flush(200);
    expect(performance.now() - flushStarted).toBeLessThan(2_000);
    await exporter.close(200);
    for (const body of sink.bodies) {
      const names = new Set((JSON.parse(body) as { batch: { event: string }[] }).batch.map((item) => item.event));
      for (const name of names) expect(Object.keys(WIRE_KEYS)).toContain(name);
      for (const word of ['queue-full', 'dropped', 'lastFailure', 'retries-exhausted', 'health']) expect(body.includes(word), word).toBe(false);
    }
  });

  test('F4 the daily budget counts a batch once, at its first send, not again for its retry', async () => {
    const now = Date.UTC(2026, 8, 25, 12, 0, 0);
    const sink = new ScriptedSink([{ ok: false, failure: 'http-5xx', retryAfterMs: 0 }]);
    const exporter = new BoundedObservationExporter({
      sink,
      scopes: live,
      clock: () => now,
      timer: false,
      gate: { fundedUntil: '2099-12-31', dailyEvents: 3 },
      random: () => 0,
    });
    exporter.enqueue(trace(1), scope);
    exporter.enqueue(trace(2), scope);
    await exporter.flush(5_000); // fails, retried at once (Retry-After 0), succeeds
    expect(exporter.health().exported).toBe(2);
    exporter.enqueue(trace(3), scope);
    await exporter.flush(5_000);
    expect(exporter.health().exported).toBe(3);
    expect(exporter.health().dropped.budget).toBe(0);
    exporter.enqueue(trace(4), scope);
    expect(exporter.health().dropped.budget).toBe(1);
  });
});

// =================================================================================================
// G. Default off, through the environment path production uses
// =================================================================================================

describe('G default off through the environment', () => {
  const KEYS = [
    'NECTOVIA_OBSERVATION',
    'NECTOVIA_OBSERVATION_ENVIRONMENT',
    'NECTOVIA_OBSERVATION_COMPANY_HOST',
    'NECTOVIA_OBSERVATION_INTERNAL_ORGS',
    'NECTOVIA_OBSERVATION_PSEUDONYM_KEY',
    'NECTOVIA_POSTHOG_HOST',
    'NECTOVIA_POSTHOG_CAPTURE_KEY',
    'NECTOVIA_OBSERVATION_FUNDED_UNTIL',
    'NECTOVIA_OBSERVATION_DAILY_EVENTS',
  ] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  });
  afterEach(() => {
    for (const key of KEYS)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  });
  const full = (): Record<(typeof KEYS)[number], string> => ({
    NECTOVIA_OBSERVATION: 'posthog',
    NECTOVIA_OBSERVATION_ENVIRONMENT: 'test',
    NECTOVIA_OBSERVATION_COMPANY_HOST: '1',
    NECTOVIA_OBSERVATION_INTERNAL_ORGS: orgs.juniper,
    NECTOVIA_OBSERVATION_PSEUDONYM_KEY: PSEUDONYM_HEX,
    NECTOVIA_POSTHOG_HOST: POSTHOG_HOST,
    NECTOVIA_POSTHOG_CAPTURE_KEY: CAPTURE_KEY,
    NECTOVIA_OBSERVATION_FUNDED_UNTIL: day(30),
    NECTOVIA_OBSERVATION_DAILY_EVENTS: '1000',
  });
  /** Global fetch, with every posthog.invalid request answered here and recorded. */
  function stubNetwork() {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('posthog')) {
        posts.push({ url, body: String(init?.body ?? '') });
        return new Response('{"status":1}', { status: 200 });
      }
      return real(input, init);
    }) as typeof globalThis.fetch);
  }
  async function posted(env: Partial<Record<(typeof KEYS)[number], string | null>>) {
    await freshRoot();
    for (const key of KEYS) delete process.env[key];
    const values = { ...full(), ...env };
    for (const key of KEYS) if (values[key] !== null && values[key] !== undefined) process.env[key] = values[key]!;
    stubNetwork();
    await open(undefined);
    await signIn('owner@juniper.test');
    const target = await workingAws();
    expect((await say(target, 'm-1', 'Summarize the order.')).status).toBe(200);
    await runtime()?.exporter.flush(5_000);
    await close();
    vi.unstubAllGlobals();
    return posts.length;
  }

  test(
    'G1 every condition present exports; removing or malforming any one of them sends nothing',
    async () => {
      expect(await posted({}), 'the positive control exports').toBeGreaterThan(0);
      const off: [string, Partial<Record<(typeof KEYS)[number], string | null>>][] = [
        ['mode unset', { NECTOVIA_OBSERVATION: null }],
        ['mode in another case', { NECTOVIA_OBSERVATION: 'PostHog' }],
        ['no funding date', { NECTOVIA_OBSERVATION_FUNDED_UNTIL: null }],
        ['funding ended yesterday', { NECTOVIA_OBSERVATION_FUNDED_UNTIL: day(-1) }],
        ['funding not a date', { NECTOVIA_OBSERVATION_FUNDED_UNTIL: 'next-year' }],
        ['no daily budget', { NECTOVIA_OBSERVATION_DAILY_EVENTS: null }],
        ['a zero daily budget', { NECTOVIA_OBSERVATION_DAILY_EVENTS: '0' }],
        ['a negative daily budget', { NECTOVIA_OBSERVATION_DAILY_EVENTS: '-5' }],
        ['a fractional daily budget', { NECTOVIA_OBSERVATION_DAILY_EVENTS: '2.5' }],
        ['no internal business', { NECTOVIA_OBSERVATION_INTERNAL_ORGS: null }],
        ['another business internal', { NECTOVIA_OBSERVATION_INTERNAL_ORGS: orgs.harbor }],
        ['not a declared company host', { NECTOVIA_OBSERVATION_COMPANY_HOST: null }],
        ['company host spelled true', { NECTOVIA_OBSERVATION_COMPANY_HOST: 'true' }],
        ['no pseudonym key', { NECTOVIA_OBSERVATION_PSEUDONYM_KEY: null }],
        ['a short pseudonym key', { NECTOVIA_OBSERVATION_PSEUDONYM_KEY: '07'.repeat(31) }],
        ['no host', { NECTOVIA_POSTHOG_HOST: null }],
        ['an http host', { NECTOVIA_POSTHOG_HOST: 'http://posthog.invalid' }],
        ['a host with a path', { NECTOVIA_POSTHOG_HOST: 'https://posthog.invalid/capture' }],
        ['no capture key', { NECTOVIA_POSTHOG_CAPTURE_KEY: null }],
        ['a capture key of the wrong shape', { NECTOVIA_POSTHOG_CAPTURE_KEY: 'phx_testOnlyNotARealKey0' }],
      ];
      const leaked: string[] = [];
      for (const [name, env] of off) if ((await posted(env)) > 0) leaked.push(name);
      expect(leaked).toEqual([]);
    },
    TIMEOUT * 3,
  );

  test(
    'G2 a funded-until date that is not a calendar date is malformed, so it reads as absent and sends nothing',
    async () => {
      expect(await posted({ NECTOVIA_OBSERVATION_FUNDED_UNTIL: '2099-02-30' })).toBe(0);
    },
    TIMEOUT,
  );
});

// =================================================================================================
// H. The normal internal trace, through the real runtime
// =================================================================================================

describe('H the normal internal trace', () => {
  test(
    'H1 an internal loop on AWS through createApp: generations, a registered tool span and the recorded verification share one trace, with mapped fields',
    async () => {
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      await connectAws();
      const project = await api<Project>('/projects', 'POST', { name: `${C.project} loop` });
      const folder = state(project.id).project.folder;
      await fs.writeFile(path.join(folder, 'order.md'), `Order 1182: 100 napkins. ${C.fileBody}\n`);
      await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
        expectedVersion: 0,
        routes: ['aws-bedrock'],
        documents: ['order.md'],
        shareConversationHistory: false,
        shareReviewPackets: false,
      });
      const taskId = (await api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', { name: `Check ${C.task}` })).id;
      await api(`/projects/${project.id}/tasks/${taskId}/acceptance`, 'PUT', {
        checks: [
          { id: 'order', kind: 'file-exists', path: 'order.md' },
          { id: 'count', kind: 'text-contains', path: 'order.md', text: 'Order 1182' },
        ],
      });
      const store = app.locals.store;
      await store.saveSettings({ ...store.settings, services: { ...(store.settings.services ?? {}), 'aws-bedrock': true } });
      const view = await api<{ connection: { accountRoute: string } }>('/ai/model-api/aws-bedrock');

      replies.push(
        (n) => respond(n, [message('1. Read order.md\n2. Report the count.')]),
        (n) => respond(n, [functionCall('read_project_file', { path: 'order.md' })]),
        (n) => respond(n, [message(`The order has 100 napkins. ${C.answer}`)]),
      );
      const started = await api<{ runId: string }>(`/projects/${project.id}/loop/start`, 'POST', {
        protocolVersion: 1,
        commandId: 'loop-ph07',
        taskId,
        goal: `Read the order and report the count. ${C.goal}`,
        route: 'aws-bedrock',
        model: AWS_LUNA_MODEL,
        accountRoute: view.connection.accountRoute,
        consent: true,
        sources: ['order.md'],
      });
      await vi.waitFor(
        async () => {
          const loop = await api<{ outcome: { state: string } }>(`/projects/${project.id}/loop/runs/${started.runId}`);
          expect(loop.outcome.state).toBe('verified');
        },
        { timeout: 30_000 },
      );
      let events: PostHogWireEvent[] = [];
      await vi.waitFor(async () => {
        events = await drained();
        expect(of(events, '$ai_span').some((item) => item.properties.nectovia_span_kind === 'verification')).toBe(true);
      });

      const traces = of(events, '$ai_trace', 'diomedes-loop');
      expect(traces).toHaveLength(1);
      const trace = traces[0];
      const traceId = trace.properties.$ai_trace_id;
      expect(trace.properties).toMatchObject({ nectovia_outcome: 'completed', $ai_is_error: false, $ai_span_name: 'diomedes-loop', nectovia_surface: 'loop' });
      expect(typeof trace.properties.$ai_latency).toBe('number');
      expect(trace.properties.$ai_latency as number).toBeLessThan(60);

      const generations = of(events, '$ai_generation', 'diomedes-loop');
      expect(generations.length).toBe(3);
      for (const generation of generations) {
        expect(generation.properties).toMatchObject({
          $ai_trace_id: traceId,
          $ai_parent_id: traceId,
          $ai_provider: 'aws-bedrock',
          $ai_model: AWS_LUNA_MODEL,
          nectovia_requested_model: AWS_LUNA_MODEL,
          nectovia_cost_state: 'settled',
          $ai_input_tokens: 100,
          $ai_output_tokens: 10,
          $ai_cache_reporting_exclusive: false,
          nectovia_payer: 'byo',
          nectovia_class: 'internal-synthetic',
        });
        expect(generation.properties.$ai_total_cost_usd).toBe((generation.properties.nectovia_cost_micro_usd as number) / 1e6);
        expect(generation.properties.$ai_latency as number).toBeLessThan(60);
      }
      expect(generations.map((item) => item.properties.nectovia_outcome).sort()).toEqual(['answered-final', 'answered-final', 'answered-tool-call']);

      const verification = of(events, '$ai_span').find((item) => item.properties.nectovia_span_kind === 'verification')!;
      expect(verification.properties).toMatchObject({
        $ai_trace_id: traceId,
        $ai_parent_id: traceId,
        nectovia_verification_state: 'verified',
        nectovia_checks_declared: 2,
        nectovia_checks_failed: 0,
        nectovia_verification_requested_by: 'diomedes-loop',
      });
      // P3: the tallies count every check the verifier ran, the declared count only the person's.
      const { nectovia_checks_passed: passed, nectovia_checks_failed: failed, nectovia_checks_incomplete: incomplete } = verification.properties as Record<string, number>;
      expect.soft(passed + failed + incomplete, 'passed + failed + incomplete equals declared').toBe(2);
      expect(trace.properties.nectovia_model_steps).toBe(3);

      const bodies = sink.batches.join('\n');
      expectNoCanary(bodies, [...Object.values(C), 'Order 1182', 'napkins', project.id, taskId, started.runId, orgs.juniper]);

      // The loop ran exactly one registered tool step, `tool:0` read_project_file, recorded by the
      // host registry. It must leave as a tool span under the trace, named by its allowlisted id.
      const loopRun = await app.locals.harness.get(project.id, started.runId);
      expect(loopRun.steps.filter((step: StepRecord) => step.intent.kind === 'tool').map((step: StepRecord) => [step.intent.stepId, step.intent.name, step.state])).toEqual([
        ['tool:0', 'read_project_file', 'succeeded'],
      ]);
      const toolSpans = of(events, '$ai_span').filter((item) => item.properties.nectovia_span_kind !== 'verification');
      expect(toolSpans).toHaveLength(1);
      expect(toolSpans[0].properties, 'the registered tool span').toMatchObject({
        $ai_trace_id: traceId,
        $ai_parent_id: traceId,
        $ai_span_name: 'read_project_file',
        nectovia_span_kind: 'tool',
        nectovia_step_state: 'succeeded',
        $ai_is_error: false,
      });
    },
    TIMEOUT,
  );
});

// =================================================================================================
// I. The durable errorCode attribute
// =================================================================================================

describe('I durable run records', () => {
  async function runFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await runFiles(full)));
      else if (entry.name.endsWith('.json')) out.push(full);
    }
    return out;
  }

  test(
    'I1 a stored run written before errorCode existed still loads, projects and lets its conversation continue',
    async () => {
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      const target = await workingAws();
      expect((await say(target, 'm-fail', `${FAIL} once`)).ok).toBe(false);
      const conversation = (state(target.project.id).conversations as { id: string; lineages?: { runId: string }[] }[]).find(
        (item) => item.id === target.thread.id,
      )!;
      const lineage = conversation.lineages!.at(-1)!.runId;
      const turn = await app.locals.harness.modelSessions.turnRun(target.project.id, lineage, 'm-fail');
      const parked = turn.events.find((item: HarnessEvent) => item.type === 'step.reconcile_required');
      expect(parked?.attributes.errorCode, 'the new attribute is written').toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      await close();

      // Rewrite every stored run as a pre-PH-01 build would have written it.
      let stripped = 0;
      for (const file of [...(await runFiles(path.join(root, 'data'))), ...(await runFiles(path.join(root, 'projects')))]) {
        const text = await fs.readFile(file, 'utf8');
        if (!text.includes('"errorCode"')) continue;
        const parsed = JSON.parse(text) as { events?: { attributes?: Record<string, unknown> }[] };
        if (!Array.isArray(parsed.events)) continue;
        for (const item of parsed.events) if (item.attributes) delete item.attributes.errorCode;
        await fs.writeFile(file, JSON.stringify(parsed, null, 2));
        stripped += 1;
      }
      expect(stripped, 'a stored run carried errorCode').toBeGreaterThan(0);

      sink = new MemoryObservationSink();
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      const reloaded = await app.locals.harness.modelSessions.turnRun(target.project.id, lineage, 'm-fail');
      expect(reloaded.state).toBe('reconcile_required');
      expect(reloaded.events.some((item: HarnessEvent) => 'errorCode' in item.attributes)).toBe(false);
      // Projecting the old record directly, as a re-save would, does not throw or emit (it predates any binding).
      runtime()!.projector.onRunSaved(reloaded);
      expect(runtime()!.projector.stats().failures).toBe(0);
      // The conversation goes on.
      expect((await say(target, 'm-next', 'Summarize the order.')).status).toBe(200);
      await vi.waitFor(async () => expect(of(await drained(), '$ai_trace').length).toBe(1));
    },
    TIMEOUT,
  );
});
