/**
 * PH-01 through the real host: `createApp` with the faux account service in this process, a
 * scripted AWS transport under the AI SDK, and the memory sink. Nothing reaches AWS or PostHog.
 *
 * Proven here:
 * - an internal owner's conversation and Work turns produce linked generations and traces with
 *   ledger usage and settled cost; a provider failure parks and says so;
 * - every negative control produces zero events;
 * - sign-out, another person, a workspace switch and a withdrawn grant end optional export;
 * - a projector or exporter that throws changes nothing a person or the ledger sees;
 * - no planted canary leaves in any encoding;
 * - production entries leave observation off, and nothing on the client side knows of it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, HOST_TEST_PROJECT } from '../server/engines/service.js';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import type { ObservationOperatorConfig, TelemetryPolicyPort } from '../server/observability/eligibility.js';
import { MemoryObservationSink } from '../server/observability/exporter.js';
import type { ObservationOptions, ObservationRuntime } from '../server/observability/runtime.js';
import type { PostHogWireEvent } from '../server/observability/wire.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import type { AccountStateView } from '../shared/accounts.js';
import type { Conversation, Project } from '../shared/types.js';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const ACCOUNT_ID = '123456789012';
const CANARY = {
  prompt: 'PromptCanaryK7q2',
  answer: 'AnswerCanaryZ4m9',
  path: 'pathcanaryr8w1',
  project: 'ProjectCanaryB3x6',
  providerError: 'ProviderErrorCanaryJ5n0',
};
const PROPOSAL = JSON.stringify({
  summary: `The plan, ${CANARY.answer}`,
  changes: [{ path: `${CANARY.path}.md`, text: `# ${CANARY.answer}\n`, summary: 'A new plan' }],
});
const FAIL = 'FailThisTurnPlease';
const TIMEOUT = 60_000;

let root: string;
let cloud: FauxCloud;
let organizations: { juniper: string; harbor: string };
let backendKind: 'faux' | 'cloud';
let backend: AccountBackend;
let engines: EngineService;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let sent: number;
let sink: MemoryObservationSink;

const aws = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  sent += 1;
  if (String(init?.body ?? '').includes(FAIL))
    return new Response(JSON.stringify({ message: `${CANARY.providerError}: the service is down` }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  return sseResponse(
    responsesEvents({
      id: `resp_${sent}`,
      object: 'response',
      created_at: 1_760_000_000,
      model: AWS_LUNA_MODEL,
      status: 'completed',
      output: [{ type: 'message', id: `msg_${sent}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: PROPOSAL, annotations: [] }] }],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 },
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-${sent}` },
  );
}) as typeof globalThis.fetch;

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

async function open(observation: ObservationOptions | null | undefined, accounts: { backend: AccountBackend } | null = { backend }) {
  engines = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: aws,
    accounts,
    ...(observation === undefined ? {} : { observation }),
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const memory = (internal: string[], extra: Partial<ObservationOptions> = {}, config: Partial<ObservationOperatorConfig> = {}): ObservationOptions => ({
  operator: operator(internal, config),
  sink,
  timer: false,
  ...extra,
});
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
const runtime = () => app.locals.observation as ObservationRuntime | null;
const request = (route: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}
const signIn = (email: string) => api<AccountStateView>('/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false });

async function workingAws(name = `${CANARY.project} linen`) {
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
  await api('/ai/model-api/aws-bedrock', 'PUT', { accountId: ACCOUNT_ID, region: 'us-east-1', model: AWS_LUNA_MODEL, apiKey: SECRET, expiresAt: null, consent: true });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  return { project, thread };
}
const say = (target: { project: Project; thread: Conversation }, commandId: string, text: string, extra: Record<string, unknown> = {}) =>
  request(`/projects/${target.project.id}/threads/${target.thread.id}/messages`, 'POST', { commandId, text, mode: 'auto', sources: [], consent: true, ...extra });

async function drained(): Promise<PostHogWireEvent[]> {
  await runtime()?.exporter.flush(10_000);
  return sink.batches.flatMap((body) => (JSON.parse(body) as { batch: PostHogWireEvent[] }).batch);
}
const of = (events: PostHogWireEvent[], name: string, capability?: string) =>
  events.filter((item) => item.event === name && (!capability || item.properties.nectovia_capability === capability));

async function staffToken(email: string) {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-observation-'));
  sent = 0;
  sink = new MemoryObservationSink();
  backendKind = 'faux';
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  const seeded = await seedDemo(cloud);
  organizations = seeded.organizations!;
  backend = {
    client: new ControlPlaneClient('http://faux.local', (req) => cloud.handle(req)),
    view: () => ({ kind: backendKind, label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('an internal synthetic trace, offline', () => {
  test(
    'conversation and Work turns: linked generations and traces with ledger usage and settled cost; a provider failure parks; no canary leaves',
    async () => {
      await open(memory([organizations.juniper]));
      const owner = await signIn('owner@juniper.test');
      const target = await workingAws();
      const answered = await say(target, 'm-1', `Summarize the order, ${CANARY.prompt}.`);
      expect(answered.status, await answered.clone().text()).toBe(200);

      let events: PostHogWireEvent[] = [];
      await vi.waitFor(async () => {
        events = await drained();
        expect(of(events, '$ai_trace', 'model-api-turn').length).toBeGreaterThan(0);
      });
      const generation = of(events, '$ai_generation', 'model-api-turn')[0];
      const trace = of(events, '$ai_trace', 'model-api-turn').find((item) => item.properties.$ai_trace_id === generation.properties.$ai_trace_id)!;
      expect(trace, 'the generation’s trace').toBeDefined();
      expect(generation.properties).toMatchObject({
        nectovia_class: 'internal-synthetic',
        nectovia_synthetic: true,
        nectovia_source_trust: 'company-host',
        nectovia_environment: 'test',
        nectovia_surface: 'conversation',
        nectovia_route: 'aws-bedrock',
        nectovia_payer: 'byo',
        nectovia_plan: 'business',
        nectovia_step: 'model',
        nectovia_outcome: 'answered-final',
        nectovia_step_state: 'succeeded',
        nectovia_cost_state: 'settled',
        nectovia_requested_model: AWS_LUNA_MODEL,
        $ai_model: AWS_LUNA_MODEL,
        $ai_provider: 'aws-bedrock',
        $ai_input_tokens: 100,
        $ai_output_tokens: 10,
        $ai_cache_reporting_exclusive: false,
        $ai_parent_id: generation.properties.$ai_trace_id,
        $process_person_profile: false,
      });
      expect(Number.isSafeInteger(generation.properties.nectovia_cost_micro_usd)).toBe(true);
      expect(generation.properties.$ai_total_cost_usd).toBe((generation.properties.nectovia_cost_micro_usd as number) / 1e6);
      expect(String(generation.properties.distinct_id)).toMatch(/^oorg_[0-9a-f]{32}$/);
      expect(String(generation.properties.$ai_session_id)).toMatch(/^oss_[0-9a-f]{32}$/);
      expect(trace.properties).toMatchObject({ nectovia_outcome: 'completed', $ai_is_error: false, $ai_session_id: generation.properties.$ai_session_id });

      // Work on the same connection: the fenced text dispatch is the generation.
      const taskId = (await api<{ id: string }>(`/projects/${target.project.id}/tasks`, 'POST', { name: `Plan ${CANARY.project}` })).id;
      await api(`/projects/${target.project.id}/work/start`, 'POST', { taskId, route: 'aws-bedrock', consent: true, sources: [] });
      await vi.waitFor(
        async () => {
          events = await drained();
          expect(of(events, '$ai_trace', 'engine-text-turn').length).toBe(1);
        },
        { timeout: 30_000 },
      );
      const dispatch = of(events, '$ai_generation', 'engine-text-turn')[0];
      expect(dispatch.properties).toMatchObject({
        nectovia_step: 'text-dispatch',
        nectovia_surface: 'work',
        nectovia_cost_state: 'settled',
        $ai_input_tokens: 100,
        $ai_trace_id: of(events, '$ai_trace', 'engine-text-turn')[0].properties.$ai_trace_id,
      });

      // A provider failure: the step parks, and the generation says what the hold shows.
      const failed = await say(target, 'm-fail', `${FAIL} ${CANARY.prompt}`);
      expect(failed.ok).toBe(false);
      await vi.waitFor(async () => {
        events = await drained();
        expect(of(events, 'nectovia_run_parked').length).toBeGreaterThan(0);
      });
      const failure = of(events, '$ai_generation', 'model-api-turn').find((item) => item.properties.$ai_is_error === true)!;
      expect(failure.properties).toMatchObject({ nectovia_step_state: 'reconcile_required' });
      expect(['not-charged', 'unknown-outcome', 'refused-before-send']).toContain(failure.properties.nectovia_outcome);
      expect(String(failure.properties.$ai_error)).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);

      // Canaries: nothing a person, a model, a provider or the setup wrote leaves, in any encoding.
      const planted = [
        ...Object.values(CANARY),
        SECRET,
        ACCOUNT_ID,
        'owner@juniper.test',
        owner.person!.name,
        owner.person!.id,
        organizations.juniper,
        'Juniper Street Bakery',
        target.project.id,
        target.thread.id,
      ];
      const bodies = sink.batches.join('\n');
      const lower = bodies.toLowerCase();
      for (const value of planted) {
        const forms = [
          value,
          value.toLowerCase(),
          Buffer.from(value).toString('base64'),
          Buffer.from(value).toString('hex'),
          encodeURIComponent(value),
          JSON.stringify(value).slice(1, -1),
        ];
        for (const form of forms) expect(lower.includes(form.toLowerCase()), `${value} as ${form}`).toBe(false);
      }
      expect(runtime()!.projector.stats().failures).toBe(0);
    },
    TIMEOUT,
  );

  test(
    'customer fixture: a business with a metadata policy on the cloud service is client-reported customer work',
    async () => {
      backendKind = 'cloud';
      const telemetry: TelemetryPolicyPort = {
        policyFor: (id) => (id === organizations.juniper ? { organizationId: id, revision: 4, export: 'metadata', source: 'account-service' } : null),
      };
      await open(memory([], { telemetry }, { customerExport: true }));
      await signIn('owner@juniper.test');
      const target = await workingAws();
      expect((await say(target, 'm-1', 'Summarize the order.')).status).toBe(200);
      let events: PostHogWireEvent[] = [];
      await vi.waitFor(async () => {
        events = await drained();
        expect(of(events, '$ai_generation').length).toBeGreaterThan(0);
      });
      expect(of(events, '$ai_generation')[0].properties).toMatchObject({
        nectovia_class: 'customer-agent',
        nectovia_synthetic: false,
        nectovia_source_trust: 'client-reported',
        nectovia_telemetry_revision: 4,
      });
    },
    TIMEOUT,
  );
});

describe('negative controls: zero events', () => {
  test(
    'Free, a business with no plan, Personal, a spoofed body, and the host connection test',
    async () => {
      await open(memory([organizations.juniper, organizations.harbor]));
      await signIn('free@example.test');
      const free = await workingAws();
      expect((await say(free, 'm-free', 'Summarize it.')).status).toBe(403);
      const spoofed = await say(free, 'm-spoof', 'Summarize it.', { internal: true, plan: 'business', organizationId: organizations.juniper, class: 'internal' });
      expect(spoofed.ok).toBe(false);

      await api('/account/sign-out', 'POST');
      await signIn('owner@harbor.test');
      expect((await say(free, 'm-harbor', 'Summarize it.')).status).toBe(403);

      await api('/account/sign-out', 'POST');
      await signIn('owner@juniper.test');
      await api('/workspace/switch', 'POST', { kind: 'personal' });
      const personal = await workingAws('Personal notes');
      expect((await say(personal, 'm-personal', 'Summarize it.')).status).toBe(403);

      // The host's own connection test is not Agent work, whatever workspace is open. Only external
      // engines have an HTTP connection test, and they never reach a model-API admission, so the
      // admission's host-test branch is driven directly: every check passes, and nothing binds.
      await api('/workspace/switch', 'POST', { kind: 'business', organizationId: organizations.juniper });
      const view = await api<{ connection: { accountRoute: string } }>('/ai/model-api/aws-bedrock');
      const admitted = await engines.admitModelApi(
        'aws-bedrock',
        // The host's fixed test prompt (server/engines/service.ts, TEST_PROMPT).
        { model: AWS_LUNA_MODEL, accountRoute: view.connection.accountRoute, projectId: HOST_TEST_PROJECT, prompt: 'Reply with the single word: ok' },
        { surface: 'work', rootJobId: 'host-test-run' },
      );
      expect(admitted.route).toBe('aws-bedrock');
      expect(runtime()!.scopes.size).toBe(0);
      expect(runtime()!.scopes.denials()['no-admission']).toBeGreaterThan(0);

      expect(await drained()).toEqual([]);
      expect(runtime()!.exporter.health()).toMatchObject({ enqueued: 0, exported: 0 });
    },
    TIMEOUT,
  );

  test(
    'a faux business that is not internal, and a real-service customer with no telemetry policy, are refused at bind',
    async () => {
      await open(memory([]));
      await signIn('owner@juniper.test');
      const target = await workingAws();
      expect((await say(target, 'm-1', 'Summarize it.')).status).toBe(200);
      expect(await drained()).toEqual([]);
      expect(runtime()!.scopes.denials()).toMatchObject({ 'faux-account-not-internal': expect.any(Number) });
      await close();

      backendKind = 'cloud';
      await open(memory([]));
      await signIn('owner@juniper.test');
      expect((await say(target, 'm-2', 'Summarize it.')).status).toBe(200);
      expect(await drained()).toEqual([]);
      expect(runtime()!.scopes.denials()).toMatchObject({ 'telemetry-policy-absent': expect.any(Number) });
    },
    TIMEOUT,
  );

  test(
    'no accounts means no observation runtime; unset options read the environment, whose default is off',
    async () => {
      await open(memory([organizations.juniper]), null);
      expect(runtime()).toBeNull();
      await close();
      const saved = process.env.NECTOVIA_OBSERVATION;
      delete process.env.NECTOVIA_OBSERVATION;
      try {
        await open(undefined);
        expect(runtime()).toBeNull();
      } finally {
        if (saved !== undefined) process.env.NECTOVIA_OBSERVATION = saved;
      }
    },
    TIMEOUT,
  );
});

describe('transitions end optional export; nothing is relabelled', () => {
  async function queuedTurn() {
    await open(memory([organizations.juniper]));
    await signIn('owner@juniper.test');
    const target = await workingAws();
    expect((await say(target, 'm-1', 'Summarize it.')).status).toBe(200);
    expect(runtime()!.exporter.health().queued).toBeGreaterThan(0);
    return target;
  }

  test(
    'sign-out, then another person: the first person’s queued events are dropped, the second’s carry their own admission',
    async () => {
      const target = await queuedTurn();
      await api('/account/sign-out', 'POST');
      expect(await drained()).toEqual([]);
      expect(runtime()!.exporter.health().dropped['scope-ended']).toBeGreaterThan(0);
      await signIn('employee@juniper.test');
      expect((await say(target, 'm-2', 'Summarize it again.')).status).toBe(200);
      let events: PostHogWireEvent[] = [];
      await vi.waitFor(async () => {
        events = await drained();
        expect(of(events, '$ai_trace').length).toBeGreaterThan(0);
      });
      expect(new Set(events.map((item) => item.properties.nectovia_admission_id)).size).toBe(1);
    },
    TIMEOUT,
  );

  test(
    'a workspace switch drops what was queued for the business',
    async () => {
      await queuedTurn();
      await api('/workspace/switch', 'POST', { kind: 'personal' });
      expect(await drained()).toEqual([]);
      expect(runtime()!.exporter.health().dropped['scope-ended']).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    'a withdrawn grant, once the account reloads, drops what was queued; the next message is refused and sends nothing',
    async () => {
      const target = await queuedTurn();
      const billing = await staffToken('billing@diomedes.test');
      const customer = await cloud.commercial.customer(billing, organizations.juniper);
      const grant = customer.grants.find((item) => item.state === 'active')!;
      await cloud.commercial.revokeGrant(billing, organizations.juniper, grant.id, { reason: 'Test: plan ended.' });
      await api('/account/refresh', 'POST');
      expect(await drained()).toEqual([]);
      expect((await say(target, 'm-2', 'Summarize it again.')).status).toBe(403);
      expect(await drained()).toEqual([]);
    },
    TIMEOUT,
  );
});

describe('failure isolation', () => {
  async function turnWith(mode: 'baseline' | 'projector-throws' | 'exporter-throws' | 'ledger-throws') {
    await close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-observation-'));
    sink = new MemoryObservationSink();
    await open(mode === 'baseline' ? null : memory([organizations.juniper]));
    const observation = runtime();
    if (mode === 'projector-throws')
      observation!.projector.onRunSaved = () => {
        throw new Error('projector down');
      };
    if (mode === 'exporter-throws')
      observation!.exporter.enqueue = () => {
        throw new Error('exporter down');
      };
    if (mode === 'ledger-throws')
      observation!.projector.attachLedger({
        list: () => {
          throw new Error('ledger down');
        },
      });
    await signIn('owner@juniper.test');
    const target = await workingAws();
    const response = await say(target, 'm-iso', 'Summarize the order.');
    const body = (await response.json()) as { answerText?: string };
    const thread = (app.locals.store.state(target.project.id).conversations as { id: string; lineages?: { runId: string }[] }[]).find(
      (item) => item.id === target.thread.id,
    )!;
    const turn = await app.locals.harness.modelSessions.turnRun(target.project.id, thread.lineages!.at(-1)!.runId, 'm-iso');
    return {
      status: response.status,
      answer: body.answerText,
      events: turn.events.map((item: { type: string; stepId?: string; attempt?: number }) => [item.type, item.stepId ?? null, item.attempt ?? null]),
      steps: turn.steps.map((step: { intent: { stepId: string }; state: string; attempt: number }) => [step.intent.stepId, step.state, step.attempt]),
      holds: engines.modelApi!.exposure.list('aws-bedrock-1').map((item) => [item.state, item.settledMicroUsd, item.usage]),
    };
  }

  test(
    'a projector or an exporter that throws, or a ledger that cannot be read, leaves the answer, the run and the ledger as they were',
    async () => {
      const baseline = await turnWith('baseline');
      expect(baseline.status).toBe(200);
      expect(await turnWith('projector-throws')).toEqual(baseline);
      expect(await turnWith('exporter-throws')).toEqual(baseline);
      expect(runtime()!.projector.stats().failures).toBeGreaterThan(0);
      expect(await turnWith('ledger-throws')).toEqual(baseline);
      const generation = of(await drained(), '$ai_generation')[0];
      expect(generation.properties).toMatchObject({ nectovia_cost_state: 'not-linked', nectovia_outcome: 'answered-final' });
      expect(generation.properties).not.toHaveProperty('$ai_input_tokens');
    },
    TIMEOUT * 2,
  );
});

describe('source guard', () => {
  async function files(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await files(full)));
      else if (/\.(ts|tsx|js|mjs|cjs|json|html)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  test('production entries pass no observation option, so the environment decides and its default is off', async () => {
    const service = await fs.readFile(path.resolve('server/index.ts'), 'utf8');
    const desktop = await fs.readFile(path.resolve('desktop/main.mjs'), 'utf8');
    expect(service).not.toMatch(/observation:/);
    expect(desktop).not.toMatch(/observation:/);
    expect(desktop).not.toMatch(/NECTOVIA_OBSERVATION/);
  });

  test('nothing under client/ or desktop/ imports observation or names PostHog; no capture key is in the source', async () => {
    for (const dir of ['client', 'desktop'])
      for (const file of await files(path.resolve(dir))) {
        const text = await fs.readFile(file, 'utf8');
        expect(text.includes('observability/'), file).toBe(false);
        expect(/posthog/i.test(text), file).toBe(false);
      }
    for (const dir of ['server', 'shared', 'client', 'desktop', 'services/control-plane/src'])
      for (const file of await files(path.resolve(dir))) expect(/phc_[A-Za-z0-9]{30,}/.test(await fs.readFile(file, 'utf8')), file).toBe(false);
  });
});
