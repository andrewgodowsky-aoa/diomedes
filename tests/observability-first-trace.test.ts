/**
 * PH-02's boundary: an offline synthetic internal trace through the real host and the real
 * PostHog transport, whose network is a fake. Export stays switched off unless the operator has
 * named a well-formed host and key, funding that has not ended, and a daily budget above zero.
 *
 * The headline is the negative controls: with the default budget of zero, with no funding or
 * ended funding, for a business that is not internal, with observation off, and with a malformed
 * PostHog configuration, the fake network is never called.
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
import type { ObservationOperatorConfig, PostHogOperatorConfig } from '../server/observability/eligibility.js';
import type { ObservationOptions, ObservationRuntime } from '../server/observability/runtime.js';
import type { PostHogWireEvent } from '../server/observability/wire.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import type { Conversation, Project } from '../shared/types.js';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const KEY = 'phc_testOnlyNotAKey';
const HOST = 'https://posthog.invalid';
const PROMPT_CANARY = 'FirstTracePromptCanaryH2v8';
const ANSWER_CANARY = 'FirstTraceAnswerCanaryW6c3';
const TIMEOUT = 60_000;
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

let root: string;
let cloud: FauxCloud;
let juniper: string;
let backend: AccountBackend;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let posts: { url: string; body: string }[];

const aws = (async () =>
  sseResponse(
    responsesEvents({
      id: 'resp_1',
      object: 'response',
      created_at: 1_760_000_000,
      model: AWS_LUNA_MODEL,
      status: 'completed',
      output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Done, ${ANSWER_CANARY}.`, annotations: [] }] }],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 },
      incomplete_details: null,
      error: null,
    }),
  )) as unknown as typeof globalThis.fetch;

/** The PostHog network. Records every call and answers 200; it never reaches anything. */
const posthogNetwork = (async (input: RequestInfo | URL, init?: RequestInit) => {
  posts.push({ url: String(input), body: String(init?.body ?? '') });
  return new Response('{"status":1}', { status: 200 });
}) as typeof globalThis.fetch;

const posthog = (overrides: Partial<PostHogOperatorConfig> = {}): PostHogOperatorConfig => ({
  host: HOST,
  captureKey: KEY,
  fundedUntil: day(30),
  dailyEvents: 1_000,
  ...overrides,
});
const operator = (overrides: Partial<ObservationOperatorConfig> = {}): ObservationOperatorConfig => ({
  mode: 'posthog',
  environment: 'test',
  companyHost: true,
  internalOrganizations: new Set([juniper]),
  pseudonymKey: new Uint8Array(32).fill(8),
  customerExport: false,
  posthog: posthog(),
  ...overrides,
});
const exportOn = (overrides: Partial<ObservationOperatorConfig> = {}): ObservationOptions => ({
  operator: operator(overrides),
  fetch: posthogNetwork,
  timer: false,
});

async function open(observation: ObservationOptions | null | undefined) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
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

/** The internal owner's one conversation turn on a working AWS connection. */
async function ownerTurn() {
  await api('/account/sign-in', 'POST', { email: 'owner@juniper.test', password: FAUX_DEMO_PASSWORD, remember: false });
  const project = await api<Project>('/projects', 'POST', { name: 'Linen orders' });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', { expectedVersion: 0, routes: ['aws-bedrock'], documents: [], shareConversationHistory: true, shareReviewPackets: false });
  await api('/ai/model-api/aws-bedrock', 'PUT', { accountId: '123456789012', region: 'us-east-1', model: AWS_LUNA_MODEL, apiKey: 'test-only-bedrock-key-0123456789abcdef-never-real', expiresAt: null, consent: true });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  const answered = await request(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', {
    commandId: 'm-1',
    text: `Summarize the order, ${PROMPT_CANARY}.`,
    mode: 'auto',
    sources: [],
    consent: true,
  });
  expect(answered.status, await answered.clone().text()).toBe(200);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-first-trace-'));
  posts = [];
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  backend = {
    client: new ControlPlaneClient('http://faux.local', (req) => cloud.handle(req)),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('export switched off: the PostHog network is never called', () => {
  const cases: [string, () => ObservationOptions | null | undefined, (runtime: ObservationRuntime | null) => void][] = [
    [
      'the default daily budget of zero',
      () => exportOn({ posthog: posthog({ dailyEvents: 0 }) }),
      (observation) => expect(observation!.exporter.health()).toMatchObject({ state: 'disabled:budget', exported: 0 }),
    ],
    [
      'no funding date',
      () => exportOn({ posthog: posthog({ fundedUntil: null }) }),
      (observation) => expect(observation!.exporter.health()).toMatchObject({ state: 'disabled:funding', queued: 0 }),
    ],
    [
      'funding that has ended',
      () => exportOn({ posthog: posthog({ fundedUntil: day(-1) }) }),
      (observation) => expect(observation!.exporter.health().state).toBe('disabled:funding'),
    ],
    [
      'a business that is not internal',
      () => exportOn({ internalOrganizations: new Set() }),
      (observation) => expect(observation!.scopes.denials()).toMatchObject({ 'faux-account-not-internal': expect.any(Number) }),
    ],
    ['observation off (unset options, the environment unset)', () => undefined, (observation) => expect(observation).toBeNull()],
    ['observation off (null)', () => null, (observation) => expect(observation).toBeNull()],
    ['posthog mode with no well-formed host and key', () => exportOn({ posthog: null }), (observation) => expect(observation).toBeNull()],
    ['memory mode, even with a PostHog configuration present', () => exportOn({ mode: 'memory' }), (observation) => expect(observation!.exporter.health().state).toBe('memory')],
  ];
  for (const [name, options, check] of cases)
    test(
      name,
      async () => {
        const saved = process.env.NECTOVIA_OBSERVATION;
        delete process.env.NECTOVIA_OBSERVATION;
        try {
          await open(options());
          await ownerTurn();
          await runtime()?.exporter.flush(5_000);
          await runtime()?.exporter.close();
          expect(posts).toEqual([]);
          check(runtime());
        } finally {
          if (saved !== undefined) process.env.NECTOVIA_OBSERVATION = saved;
        }
      },
      TIMEOUT,
    );
});

describe('an offline synthetic internal trace', () => {
  test(
    'funded, within budget: the owner’s turn leaves as /batch/ POSTs carrying the capture key, linked events, and no canary',
    async () => {
      await open(exportOn());
      await ownerTurn();
      let events: PostHogWireEvent[] = [];
      await vi.waitFor(async () => {
        await runtime()!.exporter.flush(5_000);
        events = posts.flatMap((post) => (JSON.parse(post.body) as { batch: PostHogWireEvent[] }).batch);
        expect(events.some((event) => event.event === '$ai_trace')).toBe(true);
      });
      for (const post of posts) {
        expect(post.url).toBe(`${HOST}/batch/`);
        const body = JSON.parse(post.body) as { api_key: string; batch: unknown[] };
        expect(Object.keys(body)).toEqual(['api_key', 'batch']);
        expect(body.api_key).toBe(KEY);
      }
      const generation = events.find((event) => event.event === '$ai_generation')!;
      const trace = events.find((event) => event.event === '$ai_trace')!;
      expect(generation.properties).toMatchObject({
        nectovia_class: 'internal-synthetic',
        nectovia_synthetic: true,
        nectovia_cost_state: 'settled',
        $ai_input_tokens: 100,
        $ai_trace_id: trace.properties.$ai_trace_id,
        $process_person_profile: false,
        $geoip_disable: true,
      });
      const everything = posts.map((post) => post.body).join('\n').toLowerCase();
      for (const canary of [PROMPT_CANARY, ANSWER_CANARY, 'owner@juniper.test', 'Juniper Street Bakery', juniper, '123456789012'])
        expect(everything.includes(canary.toLowerCase()), canary).toBe(false);
      expect(runtime()!.exporter.health()).toMatchObject({ state: 'exporting', lastFailure: null });
      expect(runtime()!.exporter.health().exported).toBe(events.length);
    },
    TIMEOUT,
  );
});
