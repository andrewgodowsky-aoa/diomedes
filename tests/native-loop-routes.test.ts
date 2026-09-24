/**
 * H13: the Diomedes loop on two Diomedes-owned model-API routes, AWS Bedrock
 * (Responses) and Google Vertex AI (Gemini), with the same contract.
 *
 * The real route adapters build and parse every request through the real SDKs;
 * only the network below them is replaced by a scripted transport. Nothing here
 * reaches AWS or Google, no real credential exists, and nothing is spent: these
 * are fixture and mocked-provider tests, not live proof.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { AdapterRouteContract } from '../shared/adapter-contract.js';
import type { CapabilityManifest, HarnessPrincipal, HarnessRun } from '../shared/harness.js';
import { micro } from '../shared/managed-usage.js';
import { loopOutcome, loopSessionOrigin, loopView } from '../shared/native-loop.js';
import { formatOrigin } from '../shared/attribution.js';
import {
  AWS_LUNA_MODEL,
  AWS_LUNA_RATE_CARD,
  AWS_RESPONSES_ENDPOINTS,
  awsAccountRoute,
  type AwsConnection,
} from '../server/engines/aws-bedrock.js';
import { vertexAccountRoute, vertexBaseUrl, vertexRateCard, type VertexConnection } from '../server/engines/google-vertex.js';
import { AWS_MODEL_CONTRACT, createAwsModelAdapter } from '../server/harness/aws-model-adapter.js';
import { VERTEX_MODEL_CONTRACT, createVertexModelAdapter } from '../server/harness/vertex-model-adapter.js';
import { FileRunStore, RunService, Suspended, ToolRegistry, type ModelAdapter } from '../server/harness/index.js';
import { FileModelTranscripts } from '../server/harness/model-transcripts.js';
import { NativeLoop, type LoopToolBinding } from '../server/harness/native-loop.js';
import { loopEgressAuthorizer } from '../server/harness/capabilities/native-loop.js';
import { contractChecks, streamChecks } from '../server/harness/conformance.js';
import { SpendExposure } from '../server/spend-exposure.js';
import { responsesAnswer } from './fixtures/model-api-streams.js';

type Item = Record<string, unknown>;
const NOW = new Date('2026-09-23T12:00:00.000Z');
const PROJECT = 'linen-project';
const principal: HarnessPrincipal = {
  id: 'local-client',
  tenantId: 'local',
  projectId: PROJECT,
  capabilities: ['write-project-file'],
  identityGeneration: 1,
};
const LOOP_CAPABILITY: CapabilityManifest = {
  id: 'diomedes-loop',
  version: 'v1',
  label: 'Diomedes work loop',
  description: 'Synthetic.',
  tools: ['read_note', 'write_note'],
  requestedPermissions: ['write-project-file'],
  approvalPolicy: 'show-first',
  maxTurns: 16,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};
const NOTES: Record<string, string> = { 'order.md': 'Order 1182: 100 napkins.' };

// --- the two routes, each speaking its own wire format ----------------------------------------

interface Route {
  readonly id: 'aws-bedrock' | 'google-vertex';
  readonly contract: AdapterRouteContract;
  readonly accountRoute: string;
  readonly reported: string;
  readonly connectionId: string;
  adapter(fetch: typeof globalThis.fetch, transcripts: FileModelTranscripts, exposure: SpendExposure, instructions: string): ModelAdapter;
  answer(text: string): Response;
  call(id: string, name: string, args: unknown): Response;
  /** The function names a request offered. */
  offered(body: Item): string[];
  /** Whether a request carries a result for the provider's call id. */
  answers(body: Item, id: string): boolean;
  /** The system text a request carried. */
  system(body: Item): string;
}

const AWS_CONNECTION: AwsConnection = {
  v: 1,
  id: 'aws-bedrock-1',
  accountId: '123456789012',
  region: 'us-east-1',
  baseUrl: AWS_RESPONSES_ENDPOINTS['us-east-1'],
  modelId: AWS_LUNA_MODEL,
  processing: 'us-geo',
  credential: { kind: 'bedrock-api-key', fingerprint: 'abcdef123456', savedAt: '2026-09-21T08:00:00.000Z', expiresAt: null },
  revision: 1,
  createdAt: '2026-09-21T08:00:00.000Z',
  updatedAt: '2026-09-21T08:00:00.000Z',
};
const awsEnvelope = (output: Item[]) =>
  responsesAnswer(
    {
      id: `resp_${Math.random().toString(36).slice(2)}`,
      object: 'response',
      created_at: 1_790_000_000,
      status: 'completed',
      model: AWS_LUNA_MODEL,
      output,
      usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 150, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1050 },
      incomplete_details: null,
      error: null,
    },
    200,
    { 'x-amzn-requestid': 'req-1' },
  );
const AWS: Route = {
  id: 'aws-bedrock',
  contract: AWS_MODEL_CONTRACT,
  accountRoute: awsAccountRoute(AWS_CONNECTION),
  reported: AWS_LUNA_MODEL,
  connectionId: AWS_CONNECTION.id,
  adapter: (fetch, transcripts, exposure, instructions) =>
    createAwsModelAdapter({
      connection: AWS_CONNECTION,
      secret: 'test-only-bedrock-key-0123456789abcdef',
      card: AWS_LUNA_RATE_CARD,
      exposure,
      transcripts,
      instructions,
      effort: 'low',
      transport: fetch,
    }),
  answer: (text) =>
    awsEnvelope([
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
    ]),
  call: (id, name, args) =>
    awsEnvelope([{ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' }]),
  offered: (body) => ((body.tools as Item[] | undefined) ?? []).map((tool) => String(tool.name)).sort(),
  answers: (body, id) =>
    ((body.input as Item[]) ?? []).some((item) => item.type === 'function_call_output' && item.call_id === id),
  system: (body) =>
    JSON.stringify([
      body.instructions ?? null,
      ((body.input as Item[]) ?? []).filter((item) => item.role === 'system' || item.role === 'developer'),
    ]),
};

const VERTEX_PROJECT = 'nectovia-founder-proof';
const VERTEX_CONNECTION: VertexConnection = {
  v: 1,
  id: 'google-vertex-1',
  projectId: VERTEX_PROJECT,
  location: 'global',
  baseUrl: vertexBaseUrl(VERTEX_PROJECT),
  model: 'gemini-3.8-flash',
  processing: 'google-global',
  payer: { kind: 'google-cloud-project', projectId: VERTEX_PROJECT },
  credential: {
    kind: 'google-adc',
    source: 'gcloud-user',
    namedBy: 'gcloud-default',
    fingerprint: '0123456789abcdef',
    principal: null,
    quotaProject: VERTEX_PROJECT,
    savedAt: '2026-09-23T08:00:00.000Z',
    expiresAt: null,
  },
  revision: 2,
  createdAt: '2026-09-23T08:00:00.000Z',
  updatedAt: '2026-09-23T08:00:00.000Z',
};
const geminiFrames = (parts: Item[]) =>
  new Response(
    [
      { candidates: [{ content: { role: 'model', parts }, index: 0 }], modelVersion: 'gemini-3.8-flash-001', responseId: 'vtx-1' },
      {
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 30, thoughtsTokenCount: 10, totalTokenCount: 640 },
        modelVersion: 'gemini-3.8-flash-001',
        responseId: 'vtx-1',
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream', 'x-goog-request-id': 'goog-1' } },
  );
const VERTEX: Route = {
  id: 'google-vertex',
  contract: VERTEX_MODEL_CONTRACT,
  accountRoute: vertexAccountRoute(VERTEX_CONNECTION),
  reported: 'gemini-3.8-flash-001',
  connectionId: VERTEX_CONNECTION.id,
  adapter: (fetch, transcripts, exposure, instructions) =>
    createVertexModelAdapter({
      connection: VERTEX_CONNECTION,
      secret: 'ya29.test-only-access-token-0123456789',
      card: vertexRateCard(NOW),
      exposure,
      transcripts,
      instructions,
      effort: 'low',
      transport: fetch,
      now: () => NOW,
    }),
  answer: (text) => geminiFrames([{ text }]),
  call: (id, name, args) => geminiFrames([{ functionCall: { id, name, args }, thoughtSignature: `sig-${id}` }]),
  offered: (body) =>
    ((body.tools as { functionDeclarations?: { name: string }[] }[] | undefined) ?? [])
      .flatMap((tool) => tool.functionDeclarations ?? [])
      .map((tool) => tool.name)
      .sort(),
  answers: (body, id) => JSON.stringify(body.contents).includes('functionResponse') && JSON.stringify(body.contents).includes(`sig-${id}`),
  system: (body) => JSON.stringify(body.systemInstruction ?? ''),
};

// --- the loop's tools, as in the host: the model supplies content, the host binds scope --------

function registry(writes: string[]) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'read_note',
    version: 'v1',
    description: 'Read a note.',
    effect: 'read',
    effectClass: 'read',
    permission: null,
    approval: false,
    destination: 'local',
    trustedInputRequired: false,
    cost: 0,
    schema: z.strictObject({ path: z.string() }),
    outputSchema: z.strictObject({ path: z.string(), text: z.string().nullable() }),
    execute: ({ input }) => ({ path: input.path, text: NOTES[input.path] ?? null }),
  });
  tools.register({
    name: 'write_note',
    version: 'v1',
    description: 'Write the report.',
    effect: 'idempotent',
    effectClass: 'idempotent-write',
    permission: 'write-project-file',
    approval: true,
    destination: 'local',
    trustedInputRequired: false,
    cost: 1,
    schema: z.strictObject({ path: z.literal('report.md'), text: z.string() }),
    outputSchema: z.strictObject({ written: z.string() }),
    targets: (input) => [input.path],
    execute: ({ input }) => {
      writes.push(input.text);
      return { written: input.path };
    },
  });
  return tools;
}
const bindings: LoopToolBinding[] = [
  { name: 'read_note', description: 'Read a note by path.', schema: z.strictObject({ path: z.string() }), bind: (input) => input as { path: string } },
  {
    name: 'write_note',
    description: 'Propose the report text.',
    schema: z.strictObject({ text: z.string() }),
    bind: (input) => ({ path: 'report.md', text: (input as { text: string }).text }),
  },
];

interface Sent {
  url: string;
  body: Item;
}
function network(script: ((body: Item) => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Item;
    sent.push({ url: String(input), body });
    const next = script.shift();
    if (!next) throw new Error('Unexpected provider request.');
    return next(body);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

let dir: string;
let services: Record<string, unknown>;
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-loop-routes-'));
});

function service() {
  const authorize = loopEgressAuthorizer(() => services);
  const runs: RunService = new RunService(new FileRunStore(path.join(dir, 'runs')), {
    authorizeEgress: async (runId, intent, _principal, phase) => authorize(await runs.get(runId), intent, phase),
  });
  return runs;
}
async function ledger(route: Route) {
  const exposure = new SpendExposure(path.join(dir, 'spend'));
  await exposure.init();
  await exposure.setCap(route.connectionId, micro(1_000_000), { approvedBy: 'test owner', note: 'one dollar' });
  return exposure;
}
async function start(runs: RunService, route: Route, id: string, tools: ToolRegistry) {
  await runs.start({
    id,
    tenantId: 'local',
    projectId: PROJECT,
    capability: LOOP_CAPABILITY,
    principal,
    tools,
    input: { v: 1, kind: 'diomedes-loop', route: route.id, accountRoute: route.accountRoute },
    budget: { units: 40, modelCalls: 9, toolCalls: 8, wallMs: null },
  });
  await runs.claim(id, 'host', 600_000);
}
const loopFor = (runs: RunService, adapter: ModelAdapter, tools: ToolRegistry, route: Route) =>
  new NativeLoop(runs, adapter, tools, { maxTurns: 8, instructions: 'You are the model inside a Diomedes work loop.', bindings, route: route.id, model: null });

describe.each([AWS, VERTEX])('the Diomedes loop on $id', (route) => {
  test('the route contract passes the conformance suite, as the loop requires of every route', () => {
    const failed = contractChecks(route.contract).filter((check) => check.outcome === 'failed');
    expect(failed).toEqual([]);
    expect(route.contract.commands.start.support).not.toBe('unsupported');
    expect(route.contract.models.source).toBe('runtime-reported');
  });

  test('plan, read, an approved write and a finish over the provider wire, attributed to the reported model under Diomedes', async () => {
    services = { [route.id]: true, [`${route.id}AccountRoute`]: route.accountRoute };
    const runs = service();
    const writes: string[] = [];
    const tools = registry(writes);
    const exposure = await ledger(route);
    const transcripts = new FileModelTranscripts(path.join(dir, 'transcripts'), route.id);
    await start(runs, route, 'loop-1', tools);
    const net = network([
      (body) => {
        // The plan call offers no tools.
        expect(route.offered(body)).toEqual([]);
        return route.answer('1. Read order.md.\n2. Write the report.');
      },
      (body) => {
        expect(route.offered(body)).toEqual(['read_note', 'write_note']);
        return route.call('call_read', 'read_note', { path: 'order.md' });
      },
      (body) => {
        expect(route.answers(body, 'call_read')).toBe(true);
        return route.call('call_write', 'write_note', { text: '# Report\n\nOrder 1182: 100 napkins.' });
      },
      (body) => {
        expect(route.answers(body, 'call_write')).toBe(true);
        return route.answer('Wrote report.md from order.md.');
      },
    ]);
    const adapter = route.adapter(net.fetch, transcripts, exposure, 'You are the model inside a Diomedes work loop.');
    await expect(loopFor(runs, adapter, tools, route).run('loop-1', 'host', 'Summarise the order into report.md.', principal)).rejects.toBeInstanceOf(
      Suspended,
    );
    expect(writes).toEqual([]);
    expect(net.sent).toHaveLength(3);
    // The model named only the text; the host bound where it goes.
    expect((await runs.get('loop-1')).steps.find((step) => step.intent.stepId === 'tool:1')?.intent.input).toEqual({
      path: 'report.md',
      text: '# Report\n\nOrder 1182: 100 napkins.',
    });
    await runs.decide({ runId: 'loop-1', stepId: 'tool:1', decision: 'approved', decidedBy: 'local-client', ttlMs: 60_000 }, principal);
    await runs.claim('loop-1', 'host', 600_000);
    // A fresh adapter instance: the continuation comes from the private transcript, not memory.
    await loopFor(runs, route.adapter(net.fetch, transcripts, exposure, 'You are the model inside a Diomedes work loop.'), tools, route).run(
      'loop-1',
      'host',
      'Summarise the order into report.md.',
      principal,
    );
    expect(writes).toEqual(['# Report\n\nOrder 1182: 100 napkins.']);
    expect(net.sent).toHaveLength(4);
    for (const request of net.sent) expect(route.system(request.body)).toContain('Diomedes work loop');

    const run: HarnessRun = await runs.get('loop-1');
    expect(run.state).toBe('completed');
    expect(streamChecks(run).filter((check) => check.outcome === 'failed')).toEqual([]);
    // Every model step is the route's, with the model the provider reported; Diomedes owns the loop's own steps.
    const models = run.steps.filter((step) => step.intent.kind === 'model');
    expect(models.map((step) => step.intent.destination)).toEqual(['external', 'external', 'external', 'external']);
    for (const step of models)
      expect(step.origin).toMatchObject({ mode: 'direct', engine: { id: route.id }, model: { reported: route.reported, source: 'runtime' } });
    expect(run.steps.find((step) => step.intent.stepId === 'plan')?.origin?.mode).toBe('supervisor');
    const view = loopView(run);
    expect(view.models).toEqual([{ engine: route.id, reported: route.reported, calls: 4 }]);
    const origin = loopSessionOrigin(run);
    expect(origin).toMatchObject({ mode: 'supervisor', model: { reported: route.reported } });
    expect(formatOrigin(origin).primary).toBe('Diomedes');
    expect(formatOrigin(origin).secondary).toContain(route.reported);
    // H18: the account reconciles the first call against what the provider reported.
    expect(view.account?.provider?.reportedCalls).toBe(4);
    expect(view.account?.reconciliation?.reported).toBeGreaterThan(0);
    // Finished is a claim; with no verification on record it is Not verified.
    expect(loopOutcome(view, null).state).toBe('not-verified');
    // Each paid call was held and settled from reported usage.
    expect(exposure.list(route.connectionId).map((hold) => hold.state)).toEqual(['settled', 'settled', 'settled', 'settled']);
  });

  test('a route switched off before a call sends nothing, and the loop stops truthfully', async () => {
    services = { [route.id]: false, [`${route.id}AccountRoute`]: route.accountRoute };
    const runs = service();
    const tools = registry([]);
    const exposure = await ledger(route);
    await start(runs, route, 'loop-2', tools);
    const net = network([]);
    await expect(
      loopFor(runs, route.adapter(net.fetch, new FileModelTranscripts(path.join(dir, 'transcripts'), route.id), exposure, 'x'), tools, route).run(
        'loop-2',
        'host',
        'Anything.',
        principal,
      ),
    ).rejects.toMatchObject({ code: 'egress_denied' });
    expect(net.sent).toHaveLength(0);
    expect((await runs.get('loop-2')).state).toBe('failed');
  });

  test('a restart mid-loop: a fresh service and adapter continue from the record and never resend a settled call', async () => {
    services = { [route.id]: true, [`${route.id}AccountRoute`]: route.accountRoute };
    const runs = service();
    const tools = registry([]);
    const exposure = await ledger(route);
    const transcripts = new FileModelTranscripts(path.join(dir, 'transcripts'), route.id);
    await start(runs, route, 'loop-3', tools);
    const before = network([
      () => route.answer('1. Read order.md.'),
      () => route.call('call_a', 'read_note', { path: 'order.md' }),
    ]);
    // The first process stops just before turn 1's model call.
    const gate: { resume?: () => void } = {};
    runs.use(async ({ step }) => {
      if (step.stepId === 'context:1') await new Promise<void>((resolve) => (gate.resume = resolve));
    });
    const stalled = loopFor(runs, route.adapter(before.fetch, transcripts, exposure, 'x'), tools, route)
      .run('loop-3', 'host', 'Read the order.', principal)
      .catch((error: unknown) => error);
    while (!gate.resume) await new Promise((resolve) => setTimeout(resolve, 5));

    const restarted = service();
    await restarted.recover('loop-3', principal);
    await restarted.claim('loop-3', 'host-2', 600_000);
    const after = network([
      (body) => {
        expect(route.answers(body, 'call_a')).toBe(true);
        return route.answer('Read order.md: 100 napkins.');
      },
    ]);
    await loopFor(restarted, route.adapter(after.fetch, transcripts, exposure, 'x'), tools, route).run('loop-3', 'host-2', 'Read the order.', principal);
    expect(before.sent).toHaveLength(2);
    expect(after.sent).toHaveLength(1);
    const run = await restarted.get('loop-3');
    expect(run.state).toBe('completed');
    expect(loopView(run).turns.map((turn) => turn.decision)).toEqual(['tool', 'finish']);
    gate.resume?.();
    expect(await stalled).toMatchObject({ code: 'stale_lease' });
  });
});
