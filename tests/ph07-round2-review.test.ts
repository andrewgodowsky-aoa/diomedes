/**
 * PH-07 round 2: independent reproducers against the repaired PostHog candidate (d18f64c), which
 * repairs round 1's F-1 to F-7. Written by the round 2 reviewer, not the author, in the style of
 * `tests/ph07-review.test.ts` (round 1), whose scaffold it reuses.
 *
 * Every integrated case runs the real `createApp` with the faux account service in this process
 * and a scripted AWS transport. Nothing here reaches AWS, PostHog or any other host. The faux
 * account service is reached through an in-process fetcher that a test may intercept, to answer
 * one admission with a failure or to hold it while the person switches workspace.
 *
 * Groups:
 *   R  F-2's repair: which refusals end scopes, of which business, and when
 *   S  scope ends that are not sticky (predates the repair)
 *   T  F-1's classifier and F-7's label
 *   U  F-3 and F-4 at their exact boundaries
 *   V  F-5 calendar days under other time zones
 *   W  F-6 verification tallies
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import type { AdmittedAgentWork } from '../server/accounts/agent-gate.js';
import { isCalendarDay, type ObservationOperatorConfig, type ObservationScope } from '../server/observability/eligibility.js';
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
import { encodeEvent, toWireEvent, type PostHogWireEvent } from '../server/observability/wire.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import type { AccountStateView } from '../shared/accounts.js';
import { applicationOrigin, directOrigin } from '../shared/attribution.js';
import type { HarnessEvent, HarnessRun, StepRecord } from '../shared/harness.js';
import { supervisorOrigin } from '../shared/native-loop.js';
import { OBSERVATION_CONTRACT, known, unknown, type Observation, type ScopeFacts } from '../shared/observability.js';
import type { Conversation, Project } from '../shared/types.js';
import type { VerificationRecord, VerificationView } from '../shared/verification.js';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const TIMEOUT = 90_000;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const ACCOUNT_ID = '123456789012';
const CANARY = 'Ph07R2CanaryQ9';
const USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 10,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 110,
};

// --- the scripted AWS provider (round 1's) -------------------------------------------------------

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
function respond(n: number, output: Item[]) {
  return sseResponse(
    responsesEvents({
      id: `resp_${n}`,
      object: 'response',
      created_at: 1_760_000_000,
      model: AWS_LUNA_MODEL,
      status: 'completed',
      output: output.map((item, index) => ({ ...item, id: `${item.id}_${n}_${index}` })),
      usage: USAGE,
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
  return respond(n, [message('The order has 100 napkins.')]);
}) as typeof globalThis.fetch;

// --- the host -------------------------------------------------------------------------------------

let root: string;
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let backend: AccountBackend;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let sink: MemoryObservationSink;
/** When set, answers the faux account service's requests instead of the service (null passes through). */
let intercept: ((request: Request) => Promise<Response> | null) | null;
const isAdmission = (request: Request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/agent-admissions');

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

async function open(observation: ObservationOptions | null) {
  const dir = path.join(root, 'engines');
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(dir, { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: aws,
    accounts: { backend },
    observation,
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
async function freshRoot() {
  await close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-ph07r2-'));
  sink = new MemoryObservationSink();
  awsBodies = [];
  replies = [];
  intercept = null;
}

const runtime = () => app.locals.observation as ObservationRuntime | null;
const state = (projectId: string) => app.locals.store.state(projectId);
const request = (route: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
async function connectAws(capUsd = 5) {
  await api('/ai/model-api/aws-bedrock', 'PUT', { accountId: ACCOUNT_ID, region: 'us-east-1', model: AWS_LUNA_MODEL, apiKey: SECRET, expiresAt: null, consent: true });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd, consent: true });
}
async function workingAws(name = 'Linen order'): Promise<Target> {
  const project = await api<Project>('/projects', 'POST', { name });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['aws-bedrock'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  await connectAws();
  return { project, thread };
}
const say = (target: Target, commandId: string, text: string) =>
  request(`/projects/${target.project.id}/threads/${target.thread.id}/messages`, 'POST', {
    commandId,
    text,
    mode: 'auto',
    sources: [],
    consent: true,
  });

const parse = (bodies: string[]) => bodies.flatMap((body) => (JSON.parse(body) as { batch: PostHogWireEvent[] }).batch);
async function drained(): Promise<PostHogWireEvent[]> {
  await runtime()?.exporter.flush(10_000);
  return parse(sink.batches);
}
const of = (events: PostHogWireEvent[], name: string) => events.filter((item) => item.event === name);

async function tokenFor(email: string) {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}
/** Harbor Hardware buys Business, and the Juniper owner joins it: one person, two entitled businesses (round 1's fixture). */
async function harborEntitledWithJuniperOwner() {
  const billing = await tokenFor('billing@diomedes.test');
  await cloud.commercial.issueGrant(billing, orgs.harbor, { planId: 'business', source: 'internal-test', reference: 'PH-07 r2', note: 'Review fixture.' });
  const harborOwner = await tokenFor('owner@harbor.test');
  const code = await cloud.accounts.createInvitationCode(harborOwner, orgs.harbor, { role: 'admin', email: 'owner@juniper.test', ttlMs: 86_400_000 });
  await cloud.accounts.redeemInvitationCode(await tokenFor('owner@juniper.test'), code.code);
}
async function revokeJuniper() {
  const billing = await tokenFor('billing@diomedes.test');
  const customer = await cloud.commercial.customer(billing, orgs.juniper);
  const grant = customer.grants.find((item) => item.state === 'active')!;
  await cloud.commercial.revokeGrant(billing, orgs.juniper, grant.id, { reason: 'PH-07 r2: plan ended.' });
}
async function lineageOf(target: Target) {
  const conversation = (state(target.project.id).conversations as { id: string; lineages?: { runId: string }[] }[]).find(
    (item) => item.id === target.thread.id,
  );
  return conversation?.lineages?.at(-1)?.runId ?? null;
}
async function turnRun(target: Target, commandId: string): Promise<HarnessRun> {
  const lineage = await lineageOf(target);
  return app.locals.harness.modelSessions.turnRun(target.project.id, lineage!, commandId);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A new faux account service with the demo seed; the host reaches it through `intercept`. */
async function freshCloud() {
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  orgs = (await seedDemo(cloud)).organizations!;
  backend = {
    client: new ControlPlaneClient('http://faux.local', (req) => intercept?.(req) ?? cloud.handle(req)),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-ph07r2-'));
  sink = new MemoryObservationSink();
  awsBodies = [];
  replies = [];
  intercept = null;
  await freshCloud();
});
afterEach(async () => {
  intercept = null;
  await close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- pure fixtures ------------------------------------------------------------------------------

const ZERO = Date.UTC(2026, 8, 25, 12, 0, 0);
const T = (ms: number) => new Date(ZERO + ms).toISOString();
const admission = (organizationId: string, admissionId: string, surface: AdmittedAgentWork['surface'] = 'work'): AdmittedAgentWork => ({
  admissionId,
  organizationId,
  personId: 'person_1',
  planId: 'business',
  policyRevision: 1,
  routeKind: 'byo',
  surface,
  validUntil: T(3_600_000),
});
const facts: ScopeFacts = {
  class: 'internal-synthetic',
  synthetic: true,
  sourceTrust: 'company-host',
  environment: 'test',
  organizationKey: `oorg_${'a'.repeat(32)}`,
  admissionId: 'adm_r2',
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
  ids: { uuid: uuidFor('test', `r2-${i}`), traceId: `otr_${'b'.repeat(32)}`, spanId: `otr_${'b'.repeat(32)}`, parentId: null, sessionId: null },
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
const uuidsOf = (body: string) => (JSON.parse(body) as { batch: PostHogWireEvent[] }).batch.map((item) => item.uuid);

// =================================================================================================
// R. F-2's repair: which refusals end scopes, of which business, and when
// =================================================================================================

describe('R F-2 repair: refusals and scope ends', () => {
  test(
    'R1 a transient account-service failure on one admission (network, 503, 500) is treated as a revocation: the business’s earlier, admitted turn never leaves',
    async () => {
      const lost: string[] = [];
      const seen: Record<string, unknown> = {};
      for (const mode of ['network', '503', '500'] as const) {
        await freshRoot();
        await open(memory([orgs.juniper]));
        await signIn('owner@juniper.test');
        const target = await workingAws();
        expect((await say(target, 'm-1', 'Summarize the order.')).status).toBe(200);
        const queued = runtime()!.exporter.health().queued;
        expect(queued).toBeGreaterThan(0);

        // The next admission meets an outage. Nothing was revoked; the grant is active throughout.
        let failed = 0;
        intercept = (req) => {
          if (!isAdmission(req)) return null;
          failed += 1;
          if (mode === 'network') return Promise.reject(new TypeError('socket hang up'));
          return Promise.resolve(new Response(JSON.stringify({ error: 'upstream unavailable' }), { status: Number(mode), headers: { 'content-type': 'application/json' } }));
        };
        const refused = await say(target, 'm-2', 'Summarize it again.');
        intercept = null;
        expect(failed, `${mode}: the admission met the outage`).toBeGreaterThan(0);
        expect(refused.ok, `${mode}: the turn is refused`).toBe(false);

        const events = await drained();
        const health = runtime()!.exporter.health();
        seen[mode] = {
          status: refused.status,
          queuedBefore: queued,
          exported: events.length,
          dropped: Object.fromEntries(Object.entries(health.dropped).filter(([, n]) => n > 0)),
          denied: health.denied,
        };
        if (of(events, '$ai_trace').length === 0) lost.push(mode);

        // Recovery: the next admitted turn is observed under a fresh scope.
        expect((await say(target, 'm-3', 'And once more.')).status).toBe(200);
        expect(of(await drained(), '$ai_trace').length, `${mode}: the turn after recovery`).toBeGreaterThan(0);
      }
      // Contract section 3 ends export on a revocation, and 4.6 lists the transitions that end a
      // scope; an unreachable or failing account service is none of them.
      expect(lost, `turn 1 was admitted and its business never revoked; observed: ${JSON.stringify(seen)}`).toEqual([]);
    },
    TIMEOUT * 2,
  );

  test(
    'R2 a workspace switch while a refused admission is in flight: the refusal ends the other business’s scope, and the refused business’s queued events still leave',
    async () => {
      await harborEntitledWithJuniperOwner();
      await open(memory([orgs.juniper, orgs.harbor]));
      await signIn('owner@juniper.test');

      // Harbor (internal, entitled, never refused): one admitted turn, queued.
      await switchTo(orgs.harbor);
      const harbor = await workingAws('Harbor stock');
      expect((await say(harbor, 'm-h', 'Summarize the stock.')).status).toBe(200);
      // Juniper (internal): one admitted turn, queued. Nothing is flushed in between.
      await switchTo(orgs.juniper);
      const juniper = await workingAws();
      expect((await say(juniper, 'm-1', 'Summarize the order.')).status).toBe(200);
      expect(runtime()!.exporter.health().queued).toBeGreaterThan(0);

      // Juniper's grant ends. Its next admission is held at the account service.
      await revokeJuniper();
      let reached!: () => void;
      const hit = new Promise<void>((resolve) => (reached = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      intercept = (req) => {
        if (!isAdmission(req)) return null;
        reached();
        return released.then(() => cloud.handle(req));
      };
      const pending = say(juniper, 'm-2', 'Summarize it again.');
      await hit;
      // The person opens Harbor while Juniper's admission is on the wire.
      const switching = switchTo(orgs.harbor);
      const raced = await Promise.race([switching.then(() => true), sleep(5_000).then(() => false)]);
      release();
      await switching;
      intercept = null;
      expect(raced, 'precondition: the switch landed while the admission was in flight').toBe(true);
      const refused = await pending;
      expect(refused.status, 'the service refused Juniper').toBe(403);

      // (a) Harbor was never refused, yet its scope is gone; Juniper's is still bound.
      const harborTurn = await turnRun(harbor, 'm-h');
      const juniperTurn = await turnRun(juniper, 'm-1');
      const harborScope = runtime()!.scopes.resolve(harborTurn);
      const juniperScope = runtime()!.scopes.resolve(juniperTurn);
      expect.soft(harborScope, 'Harbor, never refused, keeps its scope').not.toBeNull();
      expect.soft(juniperScope, 'Juniper, refused, has no scope').toBeNull();

      // (b) Back in Juniper, before any flush: the revoked business's queued turn.
      await switchTo(orgs.juniper);
      const events = await drained();
      expect(
        events.map((item) => [item.event, item.properties.nectovia_capability]),
        'events of the business the service refused leave after the refusal',
      ).toEqual([]);
    },
    TIMEOUT,
  );

  test('R3 a refusal while a batch is in flight: the failed batch’s retry drops the refused business’s event and resends the other’s', async () => {
    let now = ZERO;
    const owners: Record<string, string> = { 'project-a': 'org_a', 'project-b': 'org_b' };
    const scopes = new ObservationScopes({
      operator: operator(['org_a', 'org_b']),
      backend: () => 'faux',
      authority: {
        personId: () => 'person_1',
        activeOrganizationId: () => null,
        entitlement: () => ({ agent: true, state: 'active' }),
        organizationFor: (projectId) => (projectId ? (owners[projectId] ?? null) : null),
      },
      now: () => now,
    });
    const bound = (organizationId: string, job: string) => {
      const decision = scopes.decide({ admission: admission(organizationId, `adm_${job}`), rootJobId: job, route: 'aws-bedrock', connectionId: 'c1', model: null });
      if (!decision.eligible) throw new Error(decision.denial);
      return decision.scope;
    };
    const a = bound('org_a', 'job-a');
    const b = bound('org_b', 'job-b');
    let hold!: (result: SinkResult) => void;
    const bodies: string[] = [];
    const sinkOnce: ObservationSink = {
      kind: 'posthog',
      send: (body) => {
        bodies.push(body);
        return bodies.length === 1 ? new Promise<SinkResult>((resolve) => (hold = resolve)) : Promise.resolve({ ok: true });
      },
    };
    const exporter = new BoundedObservationExporter({ sink: sinkOnce, scopes, clock: () => now, timer: false, random: () => 0, gate: { fundedUntil: '2099-12-31', dailyEvents: 1_000 } });
    exporter.enqueue(trace(1), a);
    exporter.enqueue(trace(2), b);
    const flushing = exporter.flush(60_000);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    // Both events are on the wire when the account service refuses business A.
    scopes.refused({ projectId: 'project-a' });
    hold({ ok: false, failure: 'http-5xx', retryAfterMs: null });
    await flushing;
    now += 2_000;
    await exporter.flush(5_000);
    expect(bodies).toHaveLength(2);
    expect(uuidsOf(bodies[1]), 'the retry carries only business B').toEqual([uuidFor('test', 'r2-2')]);
    expect(exporter.health().dropped['scope-ended']).toBe(1);
    expect(exporter.health().exported).toBe(1);
    expect(scopes.recheck(b)).toEqual({ live: true });
  });

  test(
    'R4 the refusal the person sees is identical with observation off, on, and on with a `refused` that throws',
    async () => {
      const outcome = async (mode: 'off' | 'on' | 'throws') => {
        await freshRoot();
        await freshCloud(); // each run revokes Juniper, so each needs its own account service
        await open(mode === 'off' ? null : memory([orgs.juniper]));
        let calls = 0;
        if (mode === 'throws') {
          const scopes = runtime()!.scopes;
          scopes.refused = () => {
            calls += 1;
            throw new Error('observation exploded');
          };
        }
        await signIn('owner@juniper.test');
        const target = await workingAws();
        await revokeJuniper();
        const response = await say(target, 'm-1', 'Summarize the order.');
        const lineage = await lineageOf(target);
        const run = lineage ? await app.locals.harness.runs.get(lineage) : null;
        return {
          calls,
          seen: {
            status: response.status,
            body: await response.text(),
            run: run && {
              state: run.state,
              events: run.events.map((item: HarnessEvent) => [item.type, item.stepId ?? null, item.attempt ?? null, item.attributes.errorCode ?? null]),
              steps: run.steps.map((step: StepRecord) => [step.intent.stepId, step.state, step.attempt]),
            },
            providerCalls: awsBodies.length,
          },
        };
      };
      const off = await outcome('off');
      const on = await outcome('on');
      const throws = await outcome('throws');
      expect(off.seen.status).toBe(403);
      expect(off.seen.run, 'the refused message left a lineage run to compare').not.toBeNull();
      expect(off.seen.run!.steps.length, 'with its refused admission step').toBeGreaterThan(0);
      expect(throws.calls, 'the throwing `refused` was reached').toBeGreaterThan(0);
      expect(on.seen).toEqual(off.seen);
      expect(throws.seen).toEqual(off.seen);
    },
    TIMEOUT * 2,
  );

  test(
    'R5 after the business is granted again, the next admission starts a fresh scope that exports, and the turn dropped at the refusal stays dropped',
    async () => {
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      const target = await workingAws();
      expect((await say(target, 'm-1', 'Summarize the order.')).status).toBe(200);
      await revokeJuniper();
      expect((await say(target, 'm-2', 'Summarize it again.')).status).toBe(403);
      const billing = await tokenFor('billing@diomedes.test');
      await cloud.commercial.issueGrant(billing, orgs.juniper, { planId: 'business', source: 'internal-test', reference: 'PH-07 r2', note: 'Granted again.' });
      const regranted = Date.now();
      expect((await say(target, 'm-3', 'And once more.')).status).toBe(200);
      const events = await drained();
      expect(of(events, '$ai_trace'), 'exactly the turn after the new grant').toHaveLength(1);
      expect(new Set(events.map((item) => item.properties.nectovia_admission_id)).size).toBe(1);
      for (const item of events) expect(Date.parse(item.timestamp)).toBeGreaterThanOrEqual(regranted - 50);
      expect(runtime()!.exporter.health().exported).toBe(events.length);
      // Nothing of turn 1 comes back on a later flush either.
      expect(await drained()).toHaveLength(events.length);
    },
    TIMEOUT,
  );

  test(
    'R6 a refusal after the admission passed (the approved spend limit set to zero) ends nothing: the earlier turn still leaves',
    async () => {
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      const target = await workingAws();
      expect((await say(target, 'm-1', 'Summarize the order.')).status).toBe(200);
      await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 0, consent: true });
      const refused = await say(target, 'm-2', 'Summarize it again.');
      expect(refused.ok, await refused.clone().text()).toBe(false);
      expect(of(await drained(), '$ai_trace')).toHaveLength(1);
      expect(runtime()!.scopes.denials()['admission-refused'] ?? 0).toBe(0);
    },
    TIMEOUT,
  );
});

// =================================================================================================
// S. Scope ends that are not sticky (PH-01, before the repair)
// =================================================================================================

describe('S scope ends that are not sticky', () => {
  test(
    'S1 a workspace round trip, or signing out and in again as the same person, before a flush: the queued events of the ended scope leave',
    async () => {
      const leaked: Record<string, number> = {};
      // A workspace switch away and back (contract 4.6: "an active-workspace change since bind").
      await freshRoot();
      await harborEntitledWithJuniperOwner();
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      await switchTo(orgs.juniper);
      const juniper = await workingAws();
      expect((await say(juniper, 'm-1', 'Summarize the order.')).status).toBe(200);
      await switchTo(orgs.harbor);
      await switchTo(orgs.juniper);
      leaked['workspace A→B→A'] = (await drained()).length;

      // Sign-out and sign-in as the same person (contract 4.6: "Sign-out").
      await freshRoot();
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      const again = await workingAws();
      expect((await say(again, 'm-1', 'Summarize the order.')).status).toBe(200);
      await api('/account/sign-out', 'POST');
      await signIn('owner@juniper.test');
      await switchTo(orgs.juniper);
      leaked['sign-out, sign-in'] = (await drained()).length;

      expect(leaked, 'events queued before the scope ended').toEqual({ 'workspace A→B→A': 0, 'sign-out, sign-in': 0 });
    },
    TIMEOUT * 2,
  );
});

// =================================================================================================
// T. F-1's classifier and F-7's label
// =================================================================================================

describe('T F-1 classifier and F-7 label', () => {
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
  const step = (stepId: string, kind: 'model' | 'tool', name: string, extra: Partial<StepRecord> = {}): StepRecord =>
    ({
      intent: { stepId, stepVersion: '1', kind, effect: 'read', name, input: {} },
      intentHash: 'h',
      attempt: 1,
      state: 'succeeded',
      output: kind === 'model' ? { response: { type: 'final', text: CANARY } } : { text: CANARY },
      leaseFence: 1,
      startedAt: null,
      endedAt: null,
      error: null,
      ...extra,
    }) as unknown as StepRecord;
  const loopRun = (events: HarnessEvent[], steps: StepRecord[]): HarnessRun =>
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

  test('T1 adversarial step names and origins: a tool is never scripted and never leaks its name; a model step is never a tool', () => {
    seq = 0;
    const scopes = new ObservationScopes({
      operator: operator(['org_a']),
      backend: () => 'faux',
      authority: { personId: () => 'person_1', activeOrganizationId: () => 'org_a', entitlement: () => ({ agent: true, state: 'active' }) },
      now: () => ZERO,
    });
    const seen: Observation[] = [];
    const capture = { enqueue: (item: Observation) => void seen.push(item), flush: async () => {}, discard: () => 0, health: () => ({}) as never, close: async () => {} };
    scopes.decide({ admission: admission('org_a', 'adm_t1', 'loop'), rootJobId: 'loop-root', route: 'aws-bedrock', connectionId: 'c1', model: AWS_LUNA_MODEL });
    const projector = new ObservationProjector({ scopes, exporter: capture, build: '0.2.0' });
    const direct = directOrigin({ engine: 'aws-bedrock', reportedModel: AWS_LUNA_MODEL, version: '1' });
    const cases: [StepRecord, 'succeeded' | 'failed'][] = [
      [step('tool:0', 'tool', 'fixture', { origin: applicationOrigin() }), 'succeeded'],
      [step('tool:1', 'tool', 'native-fixture'), 'succeeded'],
      [step('tool:2', 'tool', 'scripted-step', { origin: applicationOrigin() }), 'succeeded'],
      [step('tool:3', 'tool', 'READ_PROJECT_FILE', { origin: applicationOrigin() }), 'succeeded'],
      [step('tool:4', 'tool', 'read_project_file ', { origin: applicationOrigin() }), 'succeeded'],
      [step('tool:5', 'tool', '__proto__', { origin: applicationOrigin() }), 'succeeded'],
      [step('tool:6', 'tool', `${CANARY}_tool`, { origin: applicationOrigin() }), 'failed'],
      [step('tool:7', 'tool', 'delegate', { origin: supervisorOrigin() }), 'succeeded'],
      [step('tool:8', 'tool', 'read_project_file', { origin: applicationOrigin() }), 'failed'],
      [step('model:0', 'model', 'aws-bedrock', { origin: direct }), 'succeeded'],
      [step('model:1', 'model', 'aws-bedrock', { state: 'failed' }), 'failed'],
      [step('model:2', 'model', 'fixture', { state: 'failed' }), 'failed'],
      [step('model:plan', 'model', 'aws-bedrock', { origin: direct }), 'succeeded'],
      [step('model:3', 'model', 'aws-bedrock', { origin: supervisorOrigin() }), 'succeeded'],
    ];
    const events: HarnessEvent[] = [event('run.created', 1)];
    cases.forEach(([item, ending], index) => {
      events.push(event('step.started', 10 + index * 10, item.intent.stepId, 1));
      events.push(event(`step.${ending}`, 15 + index * 10, item.intent.stepId, 1));
    });
    projector.onRunSaved(loopRun(events, cases.map(([item]) => item)));
    expect(projector.stats().failures).toBe(0);
    const spans = seen.flatMap((item) => (item.kind === 'span' ? [[item.spanKind, item.name]] : []));
    expect(spans).toEqual([
      ['tool', 'other'],
      ['tool', 'other'],
      ['tool', 'other'],
      ['tool', 'other'],
      ['tool', 'other'],
      ['tool', 'other'],
      ['tool', 'other'],
      ['tool', 'delegate'],
      ['tool', 'read_project_file'],
      ['scripted-step', 'scripted-step'],
    ]);
    const generations = seen.flatMap((item) => (item.kind === 'generation' ? [[item.step, item.stepState]] : []));
    expect(generations).toEqual([
      ['model', 'succeeded'],
      ['model', 'failed'],
      ['model-plan', 'succeeded'],
      ['model', 'succeeded'],
    ]);
    // No raw step name outside the allowlist leaves, in any case.
    const bytes = seen.map((item) => encodeEvent(toWireEvent(item))).join('\n');
    for (const raw of ['READ_PROJECT_FILE', 'read_project_file "', '"fixture"', 'native-fixture', '__proto__']) expect(bytes.includes(raw), raw).toBe(false);
    expect(bytes.toLowerCase().includes(CANARY.toLowerCase()), CANARY).toBe(false);
  });

  test(
    'T2 an internal loop through createApp: the plan call is model-plan, the act turns are model, and the registered tool is a tool span',
    async () => {
      await open(memory([orgs.juniper]));
      await signIn('owner@juniper.test');
      await connectAws();
      const project = await api<Project>('/projects', 'POST', { name: 'Loop' });
      await fs.writeFile(path.join(state(project.id).project.folder, 'order.md'), 'Order 1182: 100 napkins.\n');
      await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
        expectedVersion: 0,
        routes: ['aws-bedrock'],
        documents: ['order.md'],
        shareConversationHistory: false,
        shareReviewPackets: false,
      });
      const taskId = (await api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', { name: 'Check the order' })).id;
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
        (n) => respond(n, [message('The order has 100 napkins.')]),
      );
      const started = await api<{ runId: string }>(`/projects/${project.id}/loop/start`, 'POST', {
        protocolVersion: 1,
        commandId: 'loop-r2',
        taskId,
        goal: 'Read the order and report the count.',
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
      const loopRun = await app.locals.harness.get(project.id, started.runId);
      const modelSteps = loopRun.steps.filter((item: StepRecord) => item.intent.kind === 'model').map((item: StepRecord) => item.intent.stepId);
      expect(modelSteps).toContain('model:plan');
      const generations = of(events, '$ai_generation').map((item) => item.properties.nectovia_step);
      expect(generations.filter((value) => value === 'model-plan')).toHaveLength(1);
      expect(generations.filter((value) => value === 'model')).toHaveLength(modelSteps.length - 1);
      const tools = of(events, '$ai_span').filter((item) => item.properties.nectovia_span_kind !== 'verification');
      expect(tools.map((item) => [item.properties.nectovia_span_kind, item.properties.$ai_span_name])).toEqual([['tool', 'read_project_file']]);
      // F-6 through the real verifier: the tallies add up to declared.
      const verification = of(events, '$ai_span').find((item) => item.properties.nectovia_span_kind === 'verification')!;
      const p = verification.properties as Record<string, number | string>;
      expect({
        declared: p.nectovia_checks_declared,
        passed: p.nectovia_checks_passed,
        failed: p.nectovia_checks_failed,
        incomplete: p.nectovia_checks_incomplete,
      }).toEqual({ declared: 2, passed: 2, failed: 0, incomplete: 0 });
    },
    TIMEOUT,
  );
});

// =================================================================================================
// U. F-3 and F-4 at their exact boundaries
// =================================================================================================

describe('U bounds at the boundary', () => {
  const scope = { scopeId: 'osc_x', facts } as ObservationScope;
  const live = { recheck: () => ({ live: true as const }), denials: () => ({}) };
  const gate = { fundedUntil: '2099-12-31', dailyEvents: 1_000_000 };
  class ScriptedSink implements ObservationSink {
    readonly kind = 'posthog' as const;
    readonly bodies: string[] = [];
    constructor(private readonly answers: SinkResult[], private readonly fallback: SinkResult = { ok: true }) {}
    send(body: string): Promise<SinkResult> {
      this.bodies.push(body);
      return Promise.resolve(this.answers.shift() ?? this.fallback);
    }
  }
  const fail: SinkResult = { ok: false, failure: 'http-5xx', retryAfterMs: null };

  test('U1 age: a retry at exactly one hour is sent, one millisecond later it is dropped; a mixed batch keeps its younger events', async () => {
    const hour = 60 * 60 * 1000;
    for (const [age, sent] of [
      [hour, true],
      [hour + 1, false],
    ] as const) {
      let now = ZERO;
      const sinkA = new ScriptedSink([fail]);
      const exporter = new BoundedObservationExporter({ sink: sinkA, scopes: live, clock: () => now, timer: false, gate, random: () => 0 });
      exporter.enqueue(trace(1), scope);
      now = ZERO + hour - 5_000;
      await exporter.flush(5_000);
      now = ZERO + age;
      await exporter.flush(5_000);
      expect(sinkA.bodies.length, `retry at age ${age}`).toBe(sent ? 2 : 1);
      expect(exporter.health().dropped.expired).toBe(sent ? 0 : 1);
      expect(exporter.health().queued).toBe(0);
    }
    // A waiting batch with an old and a young event: only the old one expires.
    let now = ZERO;
    const sinkB = new ScriptedSink([fail]);
    const exporter = new BoundedObservationExporter({ sink: sinkB, scopes: live, clock: () => now, timer: false, gate, random: () => 0 });
    exporter.enqueue(trace(1), scope);
    now = ZERO + 30 * 60 * 1000;
    exporter.enqueue(trace(2), scope);
    now = ZERO + hour - 1_000;
    await exporter.flush(5_000);
    now = ZERO + hour + 1_000;
    await exporter.flush(5_000);
    expect(sinkB.bodies).toHaveLength(2);
    expect(uuidsOf(sinkB.bodies[1])).toEqual([uuidFor('test', 'r2-2')]);
    expect(exporter.health().dropped.expired).toBe(1);
  });

  test('U2 caps: exactly the event cap is held across the queue and the waiting batch; exactly the byte cap is accepted, one byte over is not', async () => {
    const now = ZERO;
    const sinkA = new ScriptedSink([fail]);
    const exporter = new BoundedObservationExporter({ sink: sinkA, scopes: live, clock: () => now, timer: false, gate, random: () => 0, limits: { queueEvents: 100, batchEvents: 50 } });
    for (let i = 0; i < 99; i += 1) exporter.enqueue(trace(i), scope);
    await exporter.flush(5_000); // 50 fail and wait; 49 stay queued
    expect(exporter.health().queued).toBe(99);
    exporter.enqueue(trace(99), scope);
    expect(exporter.health().queued, 'the 100th is accepted').toBe(100);
    expect(exporter.health().dropped['queue-full']).toBe(0);
    exporter.enqueue(trace(100), scope);
    expect(exporter.health().queued, 'the 101st is refused').toBe(100);
    expect(exporter.health().dropped['queue-full']).toBe(1);

    const size = Buffer.byteLength(encodeEvent(toWireEvent(trace(1))), 'utf8');
    for (const [cap, accepted] of [
      [4 * size, 4],
      [4 * size - 1, 3],
    ] as const) {
      const sinkB = new ScriptedSink([fail]);
      const bytes = new BoundedObservationExporter({ sink: sinkB, scopes: live, clock: () => now, timer: false, gate, random: () => 0, limits: { queueBytes: cap, batchEvents: 2 } });
      // Same-length uuids, so every event has the same size.
      bytes.enqueue(trace(1), scope);
      bytes.enqueue(trace(2), scope);
      await bytes.flush(5_000); // two wait for a retry
      bytes.enqueue(trace(3), scope);
      bytes.enqueue(trace(4), scope);
      bytes.enqueue(trace(5), scope);
      expect(bytes.health().queued, `cap ${cap} bytes`).toBe(accepted);
      expect(bytes.health().queuedBytes).toBeLessThanOrEqual(cap);
    }
  });
});

// =================================================================================================
// V. F-5 calendar days under other time zones
// =================================================================================================

describe('V calendar days', () => {
  let savedTz: string | undefined;
  beforeEach(() => {
    savedTz = process.env.TZ;
  });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  test('V1 leap days, impossible and non-ISO dates, and the end of funding are the same in UTC+14, UTC-12 and UTC', () => {
    const valid = ['2028-02-29', '2024-02-29', '2000-02-29', '2099-12-31', '2027-02-28'];
    const invalid = [
      '2027-02-29',
      '1900-02-29',
      '2100-02-29',
      '2099-02-30',
      '2027-04-31',
      '2027-13-01',
      '2027-00-10',
      '2027-3-31',
      '2028-02-29T00:00:00Z',
      '2028-02-29+05:00',
      '2028-02-29Z',
      '20280229',
      '2028/02/29',
      ' 2028-02-29',
      '2028-02-29\n',
      '+02028-02-29',
      '２０２８-02-29',
      'Feb 29, 2028',
      '',
    ];
    const offsets: number[] = [];
    for (const zone of ['Etc/GMT-14', 'Etc/GMT+12', 'UTC']) {
      process.env.TZ = zone;
      offsets.push(new Date(ZERO).getTimezoneOffset());
      for (const day of valid) expect(isCalendarDay(day), `${zone} ${day}`).toBe(true);
      for (const day of invalid) expect(isCalendarDay(day), `${zone} ${JSON.stringify(day)}`).toBe(false);
      // Funding through 2028-02-29 lasts to the end of that UTC day, whatever the host's zone.
      const state = (at: number) =>
        new BoundedObservationExporter({
          sink: { kind: 'posthog', send: async () => ({ ok: true }) },
          scopes: { recheck: () => ({ live: true }), denials: () => ({}) },
          clock: () => at,
          timer: false,
          gate: { fundedUntil: '2028-02-29', dailyEvents: 10 },
        }).health().state;
      expect(state(Date.UTC(2028, 1, 29, 23, 59, 59, 999)), zone).toBe('exporting');
      expect(state(Date.UTC(2028, 2, 1, 0, 0, 0, 0)), zone).toBe('disabled:funding');
      expect(
        new BoundedObservationExporter({
          sink: { kind: 'posthog', send: async () => ({ ok: true }) },
          scopes: { recheck: () => ({ live: true }), denials: () => ({}) },
          clock: () => Date.UTC(2027, 1, 1),
          timer: false,
          gate: { fundedUntil: '2027-02-29', dailyEvents: 10 },
        }).health().state,
        zone,
      ).toBe('disabled:funding');
    }
    // The zone really changed: UTC+14 and UTC-12 differ.
    expect(new Set(offsets).size).toBe(3);
  });
});

// =================================================================================================
// W. F-6 verification tallies
// =================================================================================================

describe('W verification tallies', () => {
  test('W1 failed, incomplete and missing declared checks, the verifier’s own check, and zero declared checks', () => {
    const scopes = new ObservationScopes({
      operator: operator(['org_a']),
      backend: () => 'faux',
      authority: { personId: () => 'person_1', activeOrganizationId: () => 'org_a', entitlement: () => ({ agent: true, state: 'active' }) },
      now: () => ZERO,
    });
    const seen: Observation[] = [];
    const capture = { enqueue: (item: Observation) => void seen.push(item), flush: async () => {}, discard: () => 0, health: () => ({}) as never, close: async () => {} };
    scopes.decide({ admission: admission('org_a', 'adm_w1', 'loop'), rootJobId: 'loop-root', route: 'aws-bedrock', connectionId: 'c1', model: null });
    const projector = new ObservationProjector({ scopes, exporter: capture, build: '0.2.0' });
    projector.onRunSaved({
      id: 'loop-root',
      capabilityId: 'diomedes-loop',
      sessionId: 'session-1',
      input: {},
      steps: [],
      events: [{ v: 1, seq: 1, runId: 'loop-root', at: T(1), type: 'run.created', attributes: {} }],
      lastSeq: 1,
      createdAt: T(0),
      state: 'running',
    } as unknown as HarnessRun);
    const check = (id: string, kind: string, outcome: string) => ({ id, kind, outcome });
    const intact = (outcome: string) => check('outputs-intact', 'outputs-intact', outcome);
    const cases: [string, number, ReturnType<typeof check>[], VerificationView['state']][] = [
      ['one of each', 3, [intact('passed'), check('a', 'file-exists', 'passed'), check('b', 'text-contains', 'failed'), check('c', 'command', 'incomplete')], 'failed'],
      ['outputs moved, declared all pass', 2, [intact('incomplete'), check('a', 'file-exists', 'passed'), check('b', 'review', 'passed')], 'uncertain'],
      ['a declared check has no result', 2, [intact('passed'), check('a', 'file-exists', 'passed')], 'uncertain'],
      ['zero declared checks', 0, [intact('passed')], 'not-verified'],
    ];
    const tallies: Record<string, unknown> = {};
    cases.forEach(([name, declared, checks, viewState], index) => {
      projector.onVerification(
        { id: `V${index}`, sessionId: 'session-1', declaredChecks: declared, requestedBy: 'you', startedAt: T(100), endedAt: T(200), checks } as unknown as VerificationRecord,
        { state: viewState, rule: 'check-failed' } as unknown as VerificationView,
      );
      const span = seen.at(-1)!;
      tallies[name] = span.kind === 'span' && span.verification.known ? span.verification.value : null;
    });
    expect(tallies).toEqual({
      'one of each': { state: 'failed', rule: 'check-failed', declared: 3, passed: 1, failed: 1, incomplete: 1, requestedBy: 'you' },
      'outputs moved, declared all pass': { state: 'uncertain', rule: 'check-failed', declared: 2, passed: 2, failed: 0, incomplete: 0, requestedBy: 'you' },
      'a declared check has no result': { state: 'uncertain', rule: 'check-failed', declared: 2, passed: 1, failed: 0, incomplete: 0, requestedBy: 'you' },
      'zero declared checks': { state: 'not-verified', rule: 'check-failed', declared: 0, passed: 0, failed: 0, incomplete: 0, requestedBy: 'you' },
    });
  });
});
