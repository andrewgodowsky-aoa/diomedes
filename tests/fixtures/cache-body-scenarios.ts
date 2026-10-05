/**
 * Fixed request scenarios on the three cache-capable bindings (AWS Luna over Responses, AWS Kimi K3
 * over Chat Completions, Azure over Responses), run through the real SDK request path with a
 * capturing transport. `tests/fixtures/cache-base-bodies.json` holds what these scenarios sent at
 * the base commit (04954ab), before any cache setting existed; the provider-default test compares
 * every byte of today's requests with it. Nothing here reaches a network.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import type { ModelRequest } from '../../shared/harness.js';
import { micro } from '../../shared/managed-usage.js';
import type { CacheRequest } from '../../shared/route-capabilities.js';
import * as aws from '../../server/engines/aws-bedrock.js';
import { azureConnectionSchema, azureEndpoint, azureQualificationTarget, azureRateCard, respondAzure } from '../../server/engines/azure-openai.js';
import { CONVERSATION_LIMITS, WORK_LIMITS } from '../../server/engines/model-api-core.js';
import { LOOKUP_FACT, runRouteQualification, type QualificationTarget } from '../../server/engines/route-qualification.js';
import { createAwsModelAdapter } from '../../server/harness/aws-model-adapter.js';
import { createAzureModelAdapter } from '../../server/harness/azure-model-adapter.js';
import { FileModelTranscripts } from '../../server/harness/model-transcripts.js';
import { SpendExposure } from '../../server/spend-exposure.js';
import { chatEvents, responsesEvents, sseResponse } from './model-api-streams.js';
import { routeCheckProvider } from './route-check-provider.js';
import { passingReceipt } from './route-qualification-receipts.js';

export const SCENARIO_NOW = new Date('2026-10-05T12:00:00.000Z');
const SECRET = 'test-only-key-0123456789abcdef-never-real';
const K3 = 'us.moonshotai.kimi-k3';
const SOL = 'gpt-6.1-sol';
const MINI = 'gpt-6-mini';

const awsConnection = (modelId: string) =>
  aws.awsConnectionSchema.parse({
    v: 1,
    id: 'aws-bedrock-1',
    accountId: '123456789012',
    region: 'us-east-1',
    baseUrl: aws.AWS_RESPONSES_ENDPOINTS['us-east-1'],
    modelId,
    processing: 'us-geo',
    credential: { kind: 'bedrock-api-key', fingerprint: 'abcdef123456', savedAt: '2026-10-01T03:00:00.000Z', expiresAt: null },
    revision: 3,
    createdAt: '2026-10-01T03:00:00.000Z',
    updatedAt: '2026-10-01T03:00:00.000Z',
  });
export const LUNA_CONNECTION = awsConnection(aws.AWS_LUNA_MODEL);
export const K3_CONNECTION = awsConnection(K3);
const rates = (source: string) => ({
  input: 2_000_000,
  output: 12_000_000,
  cacheRead: 200_000,
  cacheWrite: null,
  source,
  declaredAt: '2026-10-01T08:00:00.000Z',
});
export const AZURE_CONNECTION = azureConnectionSchema.parse({
  v: 1,
  id: 'azure-openai-1',
  resourceName: 'contoso-ai',
  baseUrl: azureEndpoint('contoso-ai'),
  apiVersion: 'v1',
  deployments: [
    { model: SOL, deployment: 'sol-prod-eastus2', reasoning: true, rates: rates('Azure pricing page, read by the test owner') },
    { model: MINI, deployment: 'mini-prod-eastus2', reasoning: false, rates: rates('Azure pricing page, read by the test owner') },
  ],
  credential: { kind: 'azure-api-key', fingerprint: 'abcdef123456', savedAt: '2026-10-01T08:00:00.000Z', expiresAt: null },
  revision: 2,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
});
export const AZURE_MODELS = { reasoning: SOL, plain: MINI } as const;

/** The stable start of a turn's instructions, then what this message adds after it. */
export const STABLE_PREFIX = [
  'You answer questions for the owner of a small bakery about its orders, deliveries and invoices.',
  'Use only the files the owner attached and say which file each fact came from.',
  'When the files do not answer, say what is unknown instead of guessing.',
].join('\n');
export const VARIABLE_PART = 'This message may read the delivery notes for the week of 28 September.';
export const INSTRUCTIONS = `${STABLE_PREFIX}\n\n${VARIABLE_PART}`;
const QUESTION = 'Which deliveries arrived short last week, and was each one invoiced in full?';

/** A receipt every check passed, for exactly K3's identity on its connection: K3 sends only under one. */
export const K3_RECEIPT = passingReceipt(
  { ...aws.awsQualificationIdentity(K3_CONNECTION), endpoint: K3_CONNECTION.baseUrl, sdk: aws.AWS_BEDROCK_SDK },
  { createdAt: new Date(SCENARIO_NOW.getTime() - 86_400_000) },
);

/** The cache fields one scenario's call is given. Empty at the base commit, where none existed. */
export type ScenarioExtra = { cache?: CacheRequest | null; stablePrefix?: string | null };
export type ScenarioName = (typeof SCENARIO_NAMES)[number];
export const SCENARIO_NAMES = [
  'aws-luna-respond',
  'aws-luna-respond-summaries',
  'aws-luna-work',
  'aws-k3-respond',
  'aws-k3-respond-tools',
  'azure-reasoning-respond',
  'azure-plain-respond',
  'aws-luna-adapter',
  'aws-k3-adapter',
  'azure-reasoning-adapter',
  'aws-luna-route-checks',
  'aws-k3-route-checks',
  'azure-route-checks',
] as const;
/** The scenarios that are ordinary calls, which a cache setting applies to. The route checks set their own. */
export const CALL_SCENARIOS = SCENARIO_NAMES.filter((name) => !name.endsWith('-route-checks'));

const responsesOk = (model: string) =>
  sseResponse(
    responsesEvents({
      id: 'resp_scenario',
      object: 'response',
      created_at: 1_790_000_000,
      status: 'completed',
      model,
      output: [
        { type: 'reasoning', id: 'rs_scenario', summary: [], encrypted_content: 'enc-scenario' },
        { type: 'message', id: 'msg_scenario', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Two deliveries.', annotations: [] }] },
      ],
      usage: { input_tokens: 300, output_tokens: 20, total_tokens: 320, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 8 } },
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': 'req-scenario', 'apim-request-id': 'apim-scenario' },
  );
const chatOk = (model: string) =>
  sseResponse(
    chatEvents({
      id: 'chatcmpl-scenario',
      model,
      text: 'Two deliveries.',
      usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, completion_tokens_details: { reasoning_tokens: 8 } },
    }),
    { 'x-amzn-requestid': 'req-scenario' },
  );

/**
 * Runs every scenario once and returns, for each, the exact request bodies its transport received,
 * in order. `extra` adds fields to a scenario's call; the route checks take none.
 */
export async function scenarioBodies(extra: (name: ScenarioName) => ScenarioExtra = () => ({})): Promise<Record<ScenarioName, string[]>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-cache-bodies-'));
  try {
    const exposure = new SpendExposure(path.join(dir, 'spend'));
    await exposure.init();
    for (const id of ['aws-bedrock-1', 'azure-openai-1'])
      await exposure.setCap(id, micro(50_000_000), { approvedBy: 'test owner', note: 'Fixture cap; no live request.' });
    const out = {} as Record<ScenarioName, string[]>;
    let attempts = 0;
    const capture = (name: ScenarioName, answer: () => Response): typeof globalThis.fetch => {
      out[name] = [];
      return (async (_input: RequestInfo | URL, init?: RequestInit) => {
        out[name].push(String(init?.body));
        return answer();
      }) as typeof globalThis.fetch;
    };
    const messages: ModelMessage[] = [{ role: 'user', content: QUESTION }];
    const attempt = (name: string) => aws.exposureAttempt(`scenario-${name}-${++attempts}`, 'model:0', messages);
    const signal = new AbortController().signal;
    const now = () => SCENARIO_NOW;

    const luna = async (name: ScenarioName, options: { summaries?: boolean; work?: boolean } = {}) =>
      aws.respondOnce({
        connection: LUNA_CONNECTION,
        secret: SECRET,
        card: aws.AWS_LUNA_RATE_CARD,
        exposure,
        attempt: attempt(name),
        instructions: INSTRUCTIONS,
        messages,
        tools: options.work ? [] : [LOOKUP_FACT],
        effort: 'medium',
        limits: options.work ? WORK_LIMITS : CONVERSATION_LIMITS,
        signal,
        transport: capture(name, () => responsesOk(aws.AWS_LUNA_MODEL)),
        now,
        ...(options.summaries ? { onReasoningDelta: () => undefined } : {}),
        ...extra(name),
      });
    await luna('aws-luna-respond');
    await luna('aws-luna-respond-summaries', { summaries: true });
    await luna('aws-luna-work', { work: true });

    const k3 = async (name: ScenarioName, tools: boolean) =>
      aws.respondOnce({
        connection: K3_CONNECTION,
        secret: SECRET,
        card: aws.awsModelRateCard(K3),
        exposure,
        attempt: attempt(name),
        instructions: INSTRUCTIONS,
        messages,
        tools: tools ? [LOOKUP_FACT] : [],
        effort: 'high',
        limits: CONVERSATION_LIMITS,
        signal,
        transport: capture(name, () => chatOk(K3)),
        now,
        qualification: K3_RECEIPT,
        ...extra(name),
      });
    await k3('aws-k3-respond', false);
    await k3('aws-k3-respond-tools', true);

    const azure = async (name: ScenarioName, model: string) =>
      respondAzure({
        connection: AZURE_CONNECTION,
        model,
        secret: SECRET,
        card: azureRateCard(AZURE_CONNECTION, model),
        exposure,
        attempt: attempt(name),
        instructions: INSTRUCTIONS,
        messages,
        tools: [LOOKUP_FACT],
        effort: 'medium',
        limits: CONVERSATION_LIMITS,
        signal,
        transport: capture(name, () => responsesOk(`${model}-2026-09-15`)),
        now,
        ...extra(name),
      });
    await azure('azure-reasoning-respond', SOL);
    await azure('azure-plain-respond', MINI);

    // The conversation path: one model step through each route's adapter, as a turn sends it.
    const request = (name: string): ModelRequest => ({
      runId: `scenario-${name}`,
      capabilityId: 'model-api-turn',
      messages: [{ role: 'user', text: QUESTION }],
      tools: [LOOKUP_FACT],
      transcript: null,
    });
    const awsTranscripts = new FileModelTranscripts(path.join(dir, 'transcripts-aws'), aws.AWS_BEDROCK_ROUTE);
    const azureTranscripts = new FileModelTranscripts(path.join(dir, 'transcripts-azure'), 'azure-openai');
    const awsAdapter = (name: ScenarioName, connection: aws.AwsConnection, answer: () => Response) =>
      createAwsModelAdapter({
        connection,
        secret: SECRET,
        card: aws.awsModelRateCard(connection.modelId),
        exposure,
        transcripts: awsTranscripts,
        instructions: INSTRUCTIONS,
        effort: 'medium',
        transport: capture(name, answer),
        now,
        qualification: K3_RECEIPT,
        ...extra(name),
      });
    await awsAdapter('aws-luna-adapter', LUNA_CONNECTION, () => responsesOk(aws.AWS_LUNA_MODEL)).complete(
      request('aws-luna-adapter'),
      signal,
    );
    await awsAdapter('aws-k3-adapter', K3_CONNECTION, () => chatOk(K3)).complete(request('aws-k3-adapter'), signal);
    await createAzureModelAdapter({
      connection: AZURE_CONNECTION,
      model: SOL,
      secret: SECRET,
      card: azureRateCard(AZURE_CONNECTION, SOL),
      exposure,
      transcripts: azureTranscripts,
      instructions: INSTRUCTIONS,
      effort: 'medium',
      transport: capture('azure-reasoning-adapter', () => responsesOk(`${SOL}-2026-09-15`)),
      now,
      ...extra('azure-reasoning-adapter'),
    }).complete(request('azure-reasoning-adapter'), signal);

    // The route checks: every planned call, in order, on each binding.
    let receipts = 0;
    const checks = async (name: ScenarioName, target: QualificationTarget, protocol: 'chat' | 'responses', model: string) => {
      const net = routeCheckProvider(protocol, model);
      const sent: string[] = [];
      out[name] = sent;
      await runRouteQualification({
        target,
        secret: SECRET,
        exposure,
        signal,
        now,
        idFactory: () => `rq_scenario${String(++receipts).padStart(4, '0')}`,
        transport: (async (input: RequestInfo | URL, init?: RequestInit) => {
          sent.push(String(init?.body));
          return net.fetch(input, init);
        }) as typeof globalThis.fetch,
      });
    };
    await checks('aws-luna-route-checks', aws.awsQualificationTarget(LUNA_CONNECTION, 'low'), 'responses', aws.AWS_LUNA_MODEL);
    await checks('aws-k3-route-checks', aws.awsQualificationTarget(K3_CONNECTION, 'low'), 'chat', K3);
    await checks('azure-route-checks', azureQualificationTarget(AZURE_CONNECTION, SOL, 'low'), 'responses', `${SOL}-2026-09-15`);
    return out;
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
