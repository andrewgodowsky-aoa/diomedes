/**
 * The payer on an observed generation comes from the admitted decision, never from a header, a
 * body field or the route's name: `managed` when the Agent gate admitted the work as managed (the
 * `nectovia` route), `byo` otherwise.
 *
 * The Nectovia send runs through the real `createApp`, the real Agent gate and the faux account
 * service's own managed gateway, as `tests/fixtures/nectovia-home.ts` wires it. The only seam is
 * the gateway's provider transport, scripted here. The owner's AWS route calls the same scripted
 * provider directly. Nothing reaches AWS or PostHog: observation runs in `memory` mode.
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
import { MemoryObservationSink } from '../server/observability/exporter.js';
import type { ObservationRuntime } from '../server/observability/runtime.js';
import type { PostHogWireEvent } from '../server/observability/wire.js';
import { createFauxCloud, FAUX_BACKEND_LABEL } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import type { Conversation, Project } from '../shared/types.js';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const TIMEOUT = 60_000;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

/** Every provider call: the managed gateway's, and the owner's AWS route's. */
let provider: { url: string; model: string }[];
const scriptedProvider = (async (input: RequestInfo | URL, init?: RequestInit) => {
  let body: { model?: string } = {};
  try {
    body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { model?: string };
  } catch {
    // Only the model is read, and only to echo it.
  }
  provider.push({ url: String(input instanceof Request ? input.url : input), model: String(body.model ?? '') });
  const n = provider.length;
  return sseResponse(
    responsesEvents({
      id: `resp_payer_${n}`,
      object: 'response',
      created_at: 1_790_000_000,
      model: body.model ?? AWS_LUNA_MODEL,
      status: 'completed',
      output: [
        {
          type: 'message',
          id: `msg_payer_${n}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Twelve loaves are on order.', annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 90,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 98,
      },
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-payer-${n}` },
  );
}) as typeof globalThis.fetch;

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let sink: MemoryObservationSink;
let juniper: string;
/** Calls the desktop made to the account service's managed gateway. */
let gatewayCalls: number;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-payer-'));
  provider = [];
  gatewayCalls = 0;
  sink = new MemoryObservationSink();
  const cloud = await createFauxCloud({ file: null, passwordIterations: 1_000, managed: { transport: scriptedProvider } });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (request) => {
      if (new URL(request.url).pathname.startsWith('/managed/v1/')) gatewayCalls += 1;
      return cloud.handle(request);
    }),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: scriptedProvider,
    accounts: { backend },
    observation: {
      operator: {
        mode: 'memory',
        environment: 'test',
        companyHost: true,
        internalOrganizations: new Set([juniper]),
        pseudonymKey: new Uint8Array(32).fill(3),
        customerExport: false,
        posthog: null,
      },
      sink,
      timer: false,
    },
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (server) {
    const closing = server;
    server = undefined;
    await app.locals.close();
    closing.closeAllConnections();
    await new Promise<void>((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const request = (route: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api${route}`, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}
type Binding = { projectId: string; threadId: string };
const say = (binding: Binding, commandId: string, text: string, extra: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) =>
  request(
    `/projects/${binding.projectId}/threads/${binding.threadId}/messages`,
    'POST',
    { commandId, text, mode: 'auto', sources: [], consent: true, ...extra },
    extraHeaders,
  );
const runtime = () => app.locals.observation as ObservationRuntime | null;
async function drained(): Promise<PostHogWireEvent[]> {
  await runtime()!.exporter.flush(10_000);
  return sink.batches.flatMap((body) => (JSON.parse(body) as { batch: PostHogWireEvent[] }).batch);
}

const onRoute = (events: PostHogWireEvent[], route: string, name?: string) =>
  events.filter((item) => item.properties.nectovia_route === route && (!name || item.event === name));

describe('the payer comes from the admitted decision', () => {
  test(
    'a Nectovia send is observed as managed with its cost pending at the gateway; an owner AWS send stays byo, whatever the request claims',
    async () => {
      await api('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: false });

      // 1. The Home conversation, on the Nectovia route, with nothing connected. The request
      //    claims `byo` in headers; the app reads no such header, and the gate's decision wins.
      const home = await api<Binding>('/home/conversation', 'POST');
      const thread = (await api<{ conversations: Conversation[] }>(`/projects/${home.projectId}/state`)).conversations.find(
        (item) => item.id === home.threadId,
      );
      expect(thread?.engine).toBe('nectovia');
      const sent = await say(home, 'payer-n1', 'How many loaves are on order?', {}, { 'X-Nectovia-Payer': 'byo', 'X-Nectovia-Route-Kind': 'byo' });
      expect(sent.status, await sent.clone().text()).toBe(200);
      expect(gatewayCalls, 'the send went through the managed gateway').toBeGreaterThan(0);
      expect(provider.length, 'and the gateway called its provider').toBeGreaterThan(0);

      let events: PostHogWireEvent[] = [];
      await vi.waitFor(async () => {
        events = await drained();
        expect(onRoute(events, 'nectovia', '$ai_trace').length).toBeGreaterThan(0);
      });
      const generations = onRoute(events, 'nectovia', '$ai_generation');
      expect(generations.length).toBeGreaterThan(0);
      for (const generation of generations) {
        expect(generation.properties).toMatchObject({
          nectovia_payer: 'managed',
          nectovia_route: 'nectovia',
          $ai_provider: 'nectovia',
          nectovia_cost_state: 'gateway-pending',
          nectovia_class: 'internal-synthetic',
          nectovia_surface: 'conversation',
          nectovia_capability: 'model-api-turn',
        });
        // The gateway's ledger settles managed cost; the desktop never states a figure for it.
        expect(generation.properties).not.toHaveProperty('$ai_total_cost_usd');
        expect(generation.properties).not.toHaveProperty('nectovia_cost_micro_usd');
      }
      expect(onRoute(events, 'nectovia', '$ai_trace')).toHaveLength(1);
      expect(onRoute(events, 'nectovia', '$ai_trace')[0].properties.nectovia_payer).toBe('managed');

      // 2. The owner's AWS route in the same business.
      const project = await api<Project>('/projects', 'POST', { name: 'Linen order' });
      const awsThread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
      await api(`/projects/${project.id}/threads/${awsThread.id}`, 'PUT', { engine: 'aws-bedrock' });
      await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
        expectedVersion: 0,
        routes: ['aws-bedrock'],
        documents: [],
        shareConversationHistory: true,
        shareReviewPackets: false,
      });
      await api('/ai/model-api/aws-bedrock', 'PUT', {
        accountId: '123456789012',
        region: 'us-east-1',
        model: AWS_LUNA_MODEL,
        apiKey: 'test-only-bedrock-key-payer-never-real',
        expiresAt: null,
        consent: true,
      });
      await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 5, consent: true });
      const awsBinding = { projectId: project.id, threadId: awsThread.id };
      const gatewayBefore = gatewayCalls;
      const providerBefore = provider.length;

      // A body cannot carry a payer at all: the message schema is strict, so the claim is refused
      // before anything is admitted, sent or observed.
      const claimed = await say(awsBinding, 'payer-a0', 'Summarize the linen order.', { payer: 'managed', routeKind: 'managed' });
      expect(claimed.status, await claimed.clone().text()).toBe(400);
      expect(provider.length, 'a refused body sends nothing').toBe(providerBefore);

      // Headers claiming managed are not read: the owner's AWS route stays byo.
      const owner = await say(awsBinding, 'payer-a1', 'Summarize the linen order.', {}, {
        'X-Nectovia-Payer': 'managed',
        'X-Nectovia-Route-Kind': 'managed',
        'X-Nectovia-Route': 'nectovia',
      });
      expect(owner.status, await owner.clone().text()).toBe(200);
      expect(provider.length, 'the AWS send reached its provider').toBeGreaterThan(providerBefore);
      expect(gatewayCalls, 'and never touched the managed gateway').toBe(gatewayBefore);

      await vi.waitFor(async () => {
        events = await drained();
        expect(onRoute(events, 'aws-bedrock', '$ai_trace').length).toBeGreaterThan(0);
      });
      const awsGenerations = onRoute(events, 'aws-bedrock', '$ai_generation');
      expect(awsGenerations.length).toBeGreaterThan(0);
      for (const generation of awsGenerations)
        expect(generation.properties).toMatchObject({
          nectovia_payer: 'byo',
          nectovia_route: 'aws-bedrock',
          $ai_provider: 'aws-bedrock',
          nectovia_cost_state: 'settled',
        });

      // Every event: the payer is the route kind the gate admitted, and nothing else.
      expect(events.length).toBe(onRoute(events, 'nectovia').length + onRoute(events, 'aws-bedrock').length);
      for (const item of onRoute(events, 'nectovia')) expect(item.properties.nectovia_payer, item.event).toBe('managed');
      for (const item of onRoute(events, 'aws-bedrock')) expect(item.properties.nectovia_payer, item.event).toBe('byo');
    },
    TIMEOUT,
  );
});
