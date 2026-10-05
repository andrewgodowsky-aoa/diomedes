/**
 * Thinking on every model-API conversation route, through each route's real adapter (the Plan 1
 * final review, finding C1): `prepare` then `complete` on the route's own adapter factory, with
 * the thinking sink handed over exactly as `EngineService.modelSession` hands it (only where the
 * route declares `reasoning-delta`), and a scripted network in that route's own wire format under
 * the real SDKs. Nothing here reaches a provider.
 *
 * `MODEL_API_REASONING` decides what each route must do. A route that declares `reasoning-delta`
 * streams the thinking it gets back into the sink and keeps it out of the answer. A route that
 * declares `none` is handed no sink and asks its provider for nothing. Every model-API route has
 * a row here, so a declaration without a working conversation path fails (spec 4.1).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { ModelRequest } from '../shared/harness.js';
import { micro } from '../shared/managed-usage.js';
import { MANAGED_LUNA, MODEL_API_ROUTES, type ModelApiRoute } from '../shared/model-api.js';
import { AWS_LUNA_MODEL, AWS_LUNA_RATE_CARD, AWS_RESPONSES_ENDPOINTS, type AwsConnection } from '../server/engines/aws-bedrock.js';
import { azureEndpoint, azureRateCard, type AzureConnection } from '../server/engines/azure-openai.js';
import { vertexBaseUrl, vertexRateCard, type VertexConnection } from '../server/engines/google-vertex.js';
import { nectoviaConnectionId, nectoviaRateCard, type ManagedAdmission, type NectoviaPolicy } from '../server/engines/nectovia.js';
import { OPENROUTER_BASE_URL, openRouterRateCard, type OpenRouterConnection } from '../server/engines/openrouter.js';
import { createAwsModelAdapter } from '../server/harness/aws-model-adapter.js';
import { createAzureModelAdapter } from '../server/harness/azure-model-adapter.js';
import { MODEL_API_REASONING } from '../server/harness/model-api-adapter.js';
import { FileModelTranscripts } from '../server/harness/model-transcripts.js';
import { createLocalAdapter } from '../server/engines/bonsai.js';
import { LocalModelRuntime } from '../server/bonsai/runtime.js';
import { BONSAI_MODEL, FixedLocalModel } from './fixtures/local-model.js';
import type { ModelAdapter } from '../server/harness/native-agent.js';
import { createNectoviaModelAdapter } from '../server/harness/nectovia-model-adapter.js';
import { createOpenRouterModelAdapter } from '../server/harness/openrouter-model-adapter.js';
import { createVertexModelAdapter } from '../server/harness/vertex-model-adapter.js';
import { SpendExposure } from '../server/spend-exposure.js';
import { chatEvents, responsesAnswer, sseResponse } from './fixtures/model-api-streams.js';

type Item = Record<string, unknown>;
interface Sinks {
  onDelta?(text: string): void;
  onReasoningDelta?(text: string): void;
}
interface Row {
  /** The route's own adapter over `fetch`, with the sinks a conversation turn hands it. */
  adapter(fetch: typeof globalThis.fetch, sinks: Sinks): ModelAdapter;
  /** One answer in the route's wire format: the thinking the provider returns, then the text. */
  answer(thinking: string, text: string): Response;
  /** Whether a request asked the provider for its thinking. Null: this route never asks for anything. */
  asked(body: Item): boolean | null;
}

const NOW = new Date('2026-09-23T12:00:00.000Z');
const SAVED = '2026-09-22T08:00:00.000Z';
const INSTRUCTIONS = 'You are Diomedes. Answer only from the attached files.';
const THINKING = 'Weighing the lunch menu.';
const ANSWER = 'Tomato soup and a grilled cheese.';

let dir: string;
let exposure: SpendExposure;
const transcripts = (route: ModelApiRoute) => new FileModelTranscripts(path.join(dir, 'transcripts', route), route);

const responses = (model: string, thinking: string, text: string, headers: Record<string, string>) =>
  responsesAnswer(
    {
      id: 'resp_1',
      object: 'response',
      created_at: 1_790_000_000,
      status: 'completed',
      model,
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: thinking }], encrypted_content: 'enc-1' },
        { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
      ],
      usage: {
        input_tokens: 900,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 150,
        output_tokens_details: { reasoning_tokens: 40 },
        total_tokens: 1_050,
      },
      incomplete_details: null,
      error: null,
    },
    200,
    headers,
  );
const summaryAsked = (body: Item) => (body.reasoning as Item | undefined)?.summary === 'auto';

const AWS_CONNECTION: AwsConnection = {
  v: 1,
  id: 'aws-bedrock-1',
  accountId: '123456789012',
  region: 'us-east-1',
  baseUrl: AWS_RESPONSES_ENDPOINTS['us-east-1'],
  modelId: AWS_LUNA_MODEL,
  processing: 'us-geo',
  credential: { kind: 'bedrock-api-key', fingerprint: 'abcdef123456', savedAt: SAVED, expiresAt: null },
  revision: 1,
  createdAt: SAVED,
  updatedAt: SAVED,
};
const RATES = {
  input: 1_250_000,
  output: 10_000_000,
  cacheRead: null,
  cacheWrite: null,
  source: 'the provider price page, read by the test owner',
  declaredAt: SAVED,
};
const AZURE_CONNECTION: AzureConnection = {
  v: 1,
  id: 'azure-openai-1',
  resourceName: 'contoso-ai',
  baseUrl: azureEndpoint('contoso-ai'),
  apiVersion: 'v1',
  deployments: [{ model: 'gpt-5.6-luna', deployment: 'luna-prod-eastus2', reasoning: true, rates: RATES }],
  credential: { kind: 'azure-api-key', fingerprint: 'abcdef123456', savedAt: SAVED, expiresAt: null },
  revision: 3,
  createdAt: SAVED,
  updatedAt: SAVED,
};
const OR_MODEL = 'anthropic/claude-sonnet-4.5';
const OPENROUTER_CONNECTION: OpenRouterConnection = {
  v: 1,
  id: 'openrouter-1',
  baseUrl: OPENROUTER_BASE_URL,
  models: [{ id: OR_MODEL, upstreams: ['anthropic'], rates: RATES }],
  dataCollection: 'deny',
  allowFallbacks: false,
  credential: { kind: 'openrouter-api-key', fingerprint: 'abcdef123456', savedAt: SAVED, expiresAt: null },
  revision: 2,
  createdAt: SAVED,
  updatedAt: SAVED,
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
    savedAt: SAVED,
    expiresAt: null,
  },
  revision: 2,
  createdAt: SAVED,
  updatedAt: SAVED,
};
const NECTOVIA_CONNECTION = nectoviaConnectionId('org_juniper', new Date('2026-09-25T12:00:00.000Z'));
const MANAGED: ManagedAdmission = {
  admissionId: 'adm_0123456789abcdef',
  organizationId: 'org_juniper',
  policyRevision: 7,
  tier: 'efficient',
  usageClass: 'included-chat',
  rootJobId: 'model-0123456789abcdef',
};
/** The gateway's answer: the efficient tier's upstream accepts summaries. */
const NECTOVIA_POLICY: NectoviaPolicy = {
  revision: 8,
  tiers: { efficient: { model: MANAGED_LUNA.model, label: 'GPT-5.6 Luna' }, focused: null, thorough: null },
  reasoningSummaries: { efficient: true, focused: false, thorough: false },
};

const ROWS: Record<ModelApiRoute, Row> = {
  bonsai: {
    adapter: (fetch, sinks) => createLocalAdapter({
      runtime: new LocalModelRuntime(new FixedLocalModel(), {
        inspect: async () => ({ state: 'unloaded', installed: true, mode: null, owned: false, detail: '' }),
        acquire: async profile => ({ status: { state: 'ready', installed: true, mode: profile.mode, owned: true, detail: '' },
          release: async () => {} }),
      }),
      model: 'local:gaming', instructions: INSTRUCTIONS, transcripts: transcripts('bonsai'), transport: fetch, sinks,
    }),
    answer: (thinking, text) => Response.json({ id: 'local-1', model: BONSAI_MODEL,
      choices: [{ finish_reason: 'stop', message: { content: text, reasoning_content: thinking } }],
      usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 } }),
    asked: () => null,
  },
  'aws-bedrock': {
    adapter: (fetch, sinks) =>
      createAwsModelAdapter({
        connection: AWS_CONNECTION,
        secret: 'test-only-bedrock-key-0123456789abcdef',
        card: AWS_LUNA_RATE_CARD,
        exposure,
        transcripts: transcripts('aws-bedrock'),
        instructions: INSTRUCTIONS,
        effort: 'low',
        transport: fetch,
        ...sinks,
      }),
    answer: (thinking, text) => responses(AWS_LUNA_MODEL, thinking, text, { 'x-amzn-requestid': 'req-1' }),
    asked: summaryAsked,
  },
  'azure-openai': {
    adapter: (fetch, sinks) =>
      createAzureModelAdapter({
        connection: AZURE_CONNECTION,
        model: 'gpt-5.6-luna',
        secret: 'test-only-azure-key-0123456789abcdef',
        card: azureRateCard(AZURE_CONNECTION, 'gpt-5.6-luna'),
        exposure,
        transcripts: transcripts('azure-openai'),
        instructions: INSTRUCTIONS,
        effort: 'low',
        transport: fetch,
        ...sinks,
      }),
    answer: (thinking, text) => responses('gpt-5.6-luna-2026-09-01', thinking, text, { 'apim-request-id': 'apim-1' }),
    asked: summaryAsked,
  },
  openrouter: {
    adapter: (fetch, sinks) =>
      createOpenRouterModelAdapter({
        connection: OPENROUTER_CONNECTION,
        model: OR_MODEL,
        secret: 'sk-or-test-only-0123456789abcdef',
        card: openRouterRateCard(OPENROUTER_CONNECTION, OR_MODEL),
        exposure,
        transcripts: transcripts('openrouter'),
        instructions: INSTRUCTIONS,
        transport: fetch,
        ...sinks,
      }),
    answer: (thinking, text) =>
      sseResponse(
        chatEvents({
          model: OR_MODEL,
          provider: 'Anthropic',
          reasoning: thinking,
          text,
          usage: { prompt_tokens: 800, completion_tokens: 120, total_tokens: 920, is_byok: false },
        }),
        { 'x-request-id': 'or-req-1' },
      ),
    // OpenRouter shows only the reasoning its models return; nothing new is asked for.
    asked: () => null,
  },
  'google-vertex': {
    adapter: (fetch, sinks) =>
      createVertexModelAdapter({
        connection: VERTEX_CONNECTION,
        secret: 'ya29.test-only-access-token-0123456789',
        card: vertexRateCard(NOW),
        exposure,
        transcripts: transcripts('google-vertex'),
        instructions: INSTRUCTIONS,
        effort: 'low',
        transport: fetch,
        now: () => NOW,
        ...sinks,
      }),
    answer: (thinking, text) =>
      new Response(
        [
          {
            candidates: [{ content: { role: 'model', parts: [{ text: thinking, thought: true }, { text }] }, index: 0 }],
            modelVersion: 'gemini-3.8-flash-001',
            responseId: 'vtx-1',
          },
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
      ),
    asked: (body) => ((body.generationConfig as Item | undefined)?.thinkingConfig as Item | undefined)?.includeThoughts === true,
  },
  nectovia: {
    adapter: (fetch, sinks) =>
      createNectoviaModelAdapter({
        base: 'https://accounts.nectovia.test',
        account: { refreshPolicy: async () => NECTOVIA_POLICY, policy: () => NECTOVIA_POLICY },
        connectionId: NECTOVIA_CONNECTION,
        model: MANAGED_LUNA.model,
        managed: MANAGED,
        token: 'session-access-token-test-only-0123456789',
        card: nectoviaRateCard(MANAGED_LUNA.model),
        exposure,
        transcripts: transcripts('nectovia'),
        instructions: INSTRUCTIONS,
        effort: 'low',
        transport: fetch,
        ...sinks,
      }),
    answer: (thinking, text) => responses(MANAGED_LUNA.model, thinking, text, { 'x-nectovia-attempt': 'gw-attempt-1' }),
    asked: summaryAsked,
  },
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-model-api-thinking-'));
  exposure = new SpendExposure(path.join(dir, 'spend'));
  await exposure.init();
  for (const id of [AWS_CONNECTION.id, AZURE_CONNECTION.id, OPENROUTER_CONNECTION.id, VERTEX_CONNECTION.id, NECTOVIA_CONNECTION])
    await exposure.setCap(id, micro(1_000_000), { approvedBy: 'test owner', note: 'one dollar' });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** One conversation step on `route`: the sinks `modelSession` would hand it, and what was sent. */
async function turn(route: ModelApiRoute, listening: boolean) {
  const sent: Item[] = [];
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (String(_input).endsWith('/apply-template')) return Response.json({ prompt: 'Fixture prompt' });
    if (String(_input).endsWith('/tokenize')) return Response.json({ tokens: [1, 2, 3] });
    sent.push(JSON.parse(String(init?.body)) as Item);
    return ROWS[route].answer(THINKING, ANSWER);
  }) as typeof globalThis.fetch;
  const thoughts: string[] = [];
  const deltas: string[] = [];
  // EngineService builds a thinking sink only while someone watches a route that declares thinking.
  const sink = listening && MODEL_API_REASONING[route] === 'reasoning-delta';
  const adapter = ROWS[route].adapter(fetch, {
    onDelta: (text) => deltas.push(text),
    ...(sink ? { onReasoningDelta: (text: string) => thoughts.push(text) } : {}),
  });
  const request: ModelRequest = {
    runId: `run-${route}-${listening ? 'watched' : 'unwatched'}`,
    capabilityId: 'model-turn',
    messages: [{ role: 'user', text: 'What is for lunch?' }],
    tools: [],
    transcript: null,
  };
  const signal = new AbortController().signal;
  const result = await adapter.complete(await adapter.prepare!(request, signal), signal);
  return { result, sent, thoughts: thoughts.join(''), deltas: deltas.join('') };
}

test('every model-API route has a row, so every declaration is exercised', () => {
  expect(Object.keys(ROWS).sort()).toEqual([...MODEL_API_ROUTES].sort());
  expect(Object.keys(MODEL_API_REASONING).sort()).toEqual([...MODEL_API_ROUTES].sort());
});

test.each([...MODEL_API_ROUTES])('%s: a watched conversation step gets the thinking its declaration promises', async (route) => {
  const { result, sent, thoughts, deltas } = await turn(route, true);
  expect(result.response).toEqual({ type: 'final', text: ANSWER });
  expect(deltas).toBe(ANSWER);
  if (MODEL_API_REASONING[route] === 'reasoning-delta') {
    expect(thoughts).toBe(THINKING);
    expect(ROWS[route].asked(sent[0])).not.toBe(false);
  } else {
    expect(thoughts).toBe('');
    expect(ROWS[route].asked(sent[0])).not.toBe(true);
  }
});

test.each([...MODEL_API_ROUTES])('%s: with nobody watching, no thinking is asked for or kept', async (route) => {
  const { result, sent, thoughts } = await turn(route, false);
  expect(result.response).toEqual({ type: 'final', text: ANSWER });
  expect(thoughts).toBe('');
  expect(ROWS[route].asked(sent[0])).not.toBe(true);
});
