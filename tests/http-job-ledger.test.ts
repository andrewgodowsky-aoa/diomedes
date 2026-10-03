/**
 * EngineService's HTTP factories must keep the host's scoped SpendExposure view.
 * Connections, protected test storage, JobCaps, RunService and provider SDKs are
 * real; only provider HTTP is replaced. No account or credential leaves the test.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { z } from 'zod';
import type { ModelRequest } from '../shared/harness.js';
import { micro } from '../shared/managed-usage.js';
import type { ModelApiRoute } from '../shared/model-api.js';
import { ConnectionSecrets, testOnlySecretBox } from '../server/connection-secrets.js';
import {
  AWS_LUNA_MODEL, AWS_LUNA_RATE_CARD, AWS_RESPONSES_ENDPOINTS,
  AwsConnections, awsAccountRoute, type AwsConnection,
} from '../server/engines/aws-bedrock.js';
import {
  AzureConnections, azureAccountRoute, azureEndpoint, azureRateCard, type AzureConnection,
} from '../server/engines/azure-openai.js';
import type { TextRequest } from '../server/engines/contract.js';
import {
  OPENROUTER_BASE_URL, OpenRouterConnections, openRouterAccountRoute, openRouterRateCard, type OpenRouterConnection,
} from '../server/engines/openrouter.js';
import { EngineService } from '../server/engines/service.js';
import { ModelSessionRuns, modelApiDispatchAuthorizer } from '../server/harness/model-session-run.js';
import { FileModelTranscripts } from '../server/harness/model-transcripts.js';
import type { ModelAdapter } from '../server/harness/native-agent.js';
import { RunService } from '../server/harness/run-service.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { TextRouteRuntime, textDispatchAuthorizer } from '../server/harness/text-route.js';
import { ToolRegistry } from '../server/harness/tools.js';
import { JobCaps, jobKeyFor } from '../server/job-caps.js';
import { SpendExposure, type ModelRateCard } from '../server/spend-exposure.js';
import { TEAM_TOOLS } from '../server/team/tools.js';
import { chatEvents, responsesAnswer, sseResponse } from './fixtures/model-api-streams.js';

const PROJECT = 'inventory-proof';
const SAVED = '2026-09-22T08:00:00.000Z';
const RATES = {
  input: 1_250_000, output: 10_000_000, cacheRead: null, cacheWrite: null,
  source: 'synthetic test rate declaration', declaredAt: SAVED,
};
const AWS: AwsConnection = {
  v: 1, id: 'aws-bedrock-1', accountId: '123456789012', region: 'us-east-1',
  baseUrl: AWS_RESPONSES_ENDPOINTS['us-east-1'], modelId: AWS_LUNA_MODEL, processing: 'us-geo',
  credential: { kind: 'bedrock-api-key', fingerprint: 'abcdef123456', savedAt: SAVED, expiresAt: null },
  revision: 1, createdAt: SAVED, updatedAt: SAVED,
};
const AZURE: AzureConnection = {
  v: 1, id: 'azure-openai-1', resourceName: 'contoso-ai', baseUrl: azureEndpoint('contoso-ai'), apiVersion: 'v1',
  deployments: [{ model: 'gpt-5.6-luna', deployment: 'luna-test', reasoning: true, rates: RATES }],
  credential: { kind: 'azure-api-key', fingerprint: 'abcdef123456', savedAt: SAVED, expiresAt: null },
  revision: 1, createdAt: SAVED, updatedAt: SAVED,
};
const SOL = 'openai/gpt-6.1-sol';
const OPENROUTER: OpenRouterConnection = {
  v: 1, id: 'openrouter-1', baseUrl: OPENROUTER_BASE_URL,
  models: [{ reasoning: { supported: ['low', 'medium', 'high'], source: 'Synthetic SDK fixture declaration; not live qualification' }, id: SOL, upstreams: ['openai'], rates: RATES, zdr: true }],
  dataCollection: 'deny', allowFallbacks: false,
  credential: { kind: 'openrouter-api-key', fingerprint: 'abcdef123456', savedAt: SAVED, expiresAt: null },
  revision: 1, createdAt: SAVED, updatedAt: SAVED,
};
interface RouteRow {
  route: ModelApiRoute;
  connectionId: string;
  model: string;
  accountRoute: string;
  card: ModelRateCard;
}
const ROWS: RouteRow[] = [
  { route: 'aws-bedrock', connectionId: AWS.id, model: AWS_LUNA_MODEL, accountRoute: awsAccountRoute(AWS), card: AWS_LUNA_RATE_CARD },
  { route: 'azure-openai', connectionId: AZURE.id, model: 'gpt-5.6-luna', accountRoute: azureAccountRoute(AZURE), card: azureRateCard(AZURE, 'gpt-5.6-luna') },
  { route: 'openrouter', connectionId: OPENROUTER.id, model: SOL, accountRoute: openRouterAccountRoute(OPENROUTER), card: openRouterRateCard(OPENROUTER, SOL) },
];

let dir: string;
let exposure: SpendExposure;
let jobs: JobCaps;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-http-job-ledger-'));
  exposure = new SpendExposure(dir);
  await exposure.init();
  jobs = new JobCaps(dir, { tierOf: () => 'efficient' });
  await jobs.init();
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function answer(row: RouteRow, withUsage = true) {
  const text = 'One discrepancy: SKU-B counted 4; inventory says 5.';
  if (row.route === 'openrouter')
    return sseResponse(chatEvents({
      model: row.model, provider: 'OpenAI', text,
      ...(withUsage ? { usage: { prompt_tokens: 800, completion_tokens: 120, total_tokens: 920, is_byok: false } } : {}),
    }), { 'x-request-id': 'or-job-1' });
  return responsesAnswer({
    id: 'resp_job_1', object: 'response', created_at: 1_790_000_000, status: 'completed',
    model: row.route === 'azure-openai' ? 'gpt-5.6-luna-2026-09-01' : row.model,
    output: [{ type: 'message', id: 'msg_job_1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }] }],
    ...(withUsage ? { usage: { input_tokens: 800, output_tokens: 120, total_tokens: 920 } } : {}),
    incomplete_details: null, error: null,
  }, 200, row.route === 'aws-bedrock' ? { 'x-amzn-requestid': 'aws-job-1' } : { 'apim-request-id': 'azure-job-1' });
}

async function fixture(row: RouteRow, withUsage = true) {
  const sent: Array<{ body: Record<string, unknown>; signal: AbortSignal | null }> = [];
  const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ body: JSON.parse(String(init?.body)), signal: init?.signal ?? null });
    return answer(row, withUsage);
  }) as typeof globalThis.fetch;
  const secrets = new ConnectionSecrets(dir, testOnlySecretBox());
  await secrets.put(row.connectionId, 'test-only-provider-key-0123456789abcdef');
  await exposure.setCap(row.connectionId, micro(10_000_000), { approvedBy: 'synthetic test owner', note: 'test only' });
  const connections = new AwsConnections(dir);
  const azure = new AzureConnections(dir);
  const openrouter = new OpenRouterConnections(dir);
  await connections.write(AWS);
  await azure.write(AZURE);
  await openrouter.write(OPENROUTER);
  const settings = { [row.route]: true, [`${row.route}AccountRoute`]: row.accountRoute };
  const textAuthorize = textDispatchAuthorizer(() => settings);
  const modelAuthorize = modelApiDispatchAuthorizer(() => settings);
  const runs: RunService = new RunService(new FileRunStore(path.join(dir, 'runs')), {
    authorizeEgress: async (runId, intent, _principal, phase) => {
      const run = await runs.get(runId);
      return run.capabilityId === 'engine-text-turn'
        ? textAuthorize(run, intent, phase)
        : modelAuthorize(run, intent, phase);
    },
  });
  const service = new EngineService(dir, { discover: async () => [] });
  service.modelApi = {
    connections, secrets, exposure, transport,
    transcripts: new FileModelTranscripts(path.join(dir, 'transcripts', 'aws'), 'aws-bedrock'),
    azure: { connections: azure, transcripts: new FileModelTranscripts(path.join(dir, 'transcripts', 'azure'), 'azure-openai') },
    openrouter: { connections: openrouter, transcripts: new FileModelTranscripts(path.join(dir, 'transcripts', 'or'), 'openrouter') },
  };
  service.jobCaps = jobs;
  service.dispatch = new TextRouteRuntime(runs).request;
  service.modelSessions = new ModelSessionRuns(runs, row.route);
  service.modelSessions.setSharingPolicy(() => {}, () => false);
  return { service, sent };
}

function input(row: RouteRow, requestId: string): TextRequest {
  return {
    projectId: PROJECT, threadId: 'inventory-thread', requestId,
    prompt: 'Reconcile the synthetic count and report its one discrepancy.',
    documents: [{ path: 'inventory.csv', text: 'sku,expected,counted\nSKU-A,3,3\nSKU-B,5,4\n' }],
    instructions: 'Use only the attached synthetic inventory.',
    model: row.model, accountRoute: row.accountRoute, effort: 'medium',
  };
}
const call = (runId: string): ModelRequest => ({
  runId, capabilityId: 'inventory-reconciliation', messages: [{ role: 'user', text: 'Find the synthetic discrepancy.' }],
  tools: [], transcript: null,
});
async function loop(service: EngineService, row: RouteRow, runId: string): Promise<ModelAdapter> {
  return service.loopAdapter(row.route, {
    projectId: PROJECT, runId, model: row.model, accountRoute: row.accountRoute,
    instructions: 'Use only the synthetic inventory.',
  }, new AbortController().signal);
}

/** Offer the real team descriptors; this final-answer fixture refuses any tool execution. */
function descriptorOnlyTeam() {
  const registry = new ToolRegistry();
  for (const definition of TEAM_TOOLS) registry.register({
    name: definition.name, version: '1', description: definition.description,
    effect: definition.effect, effectClass: definition.effect === 'read' ? 'read' : 'non-idempotent-effect',
    permission: null, approval: false, destination: 'local', trustedInputRequired: false, cost: 1,
    schema: z.object(definition.shape), outputSchema: z.json(),
    ...(definition.effect === 'read' ? {} : { targets: () => [`team:${PROJECT}`] }),
    execute: async () => { throw new Error('This effort fixture never executes a team tool.'); },
  });
  return registry;
}

type TextSurface = 'conversation' | 'work' | 'team-work';
async function textSurface(service: EngineService, row: RouteRow, surface: TextSurface, request: TextRequest) {
  if (surface === 'conversation') {
    const result = await service.modelSession(row.route, 'start', 'effort-conversation', request);
    return result.response?.text;
  }
  if (surface === 'team-work')
    return (await service.generateModelApiTools(row.route, request, descriptorOnlyTeam())).text;
  return (await service.generateModelApi(row.route, request)).text;
}

test.each(['conversation', 'work', 'team-work'] as const)(
  'OpenRouter %s preserves omitted effort without adding a reasoning request', async (surface) => {
    const row = ROWS.find(row => row.route === 'openrouter')!;
    const { service, sent } = await fixture(row);
    const { effort: _effort, ...request } = input(row, `omitted-${surface}`);
    expect(await textSurface(service, row, surface, request)).toContain('One discrepancy');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).not.toHaveProperty('reasoning');
    expect(exposure.list(row.connectionId)[0].jobId).toBe(jobKeyFor(PROJECT, request.requestId));
  },
);

test.each((['conversation', 'work', 'team-work'] as const).flatMap(surface =>
  (['low', 'medium', 'high'] as const).map(effort => ({ surface, effort })),
))('OpenRouter $surface preserves explicitly selected $effort effort', async ({ surface, effort }) => {
  const row = ROWS.find(row => row.route === 'openrouter')!;
  const { service, sent } = await fixture(row);
  expect(await textSurface(service, row, surface, { ...input(row, `explicit-${surface}-${effort}`), effort })).toContain('One discrepancy');
  expect(sent).toHaveLength(1);
  expect(sent[0].body.reasoning).toEqual({ effort });
});

test.each(ROWS.filter(row => row.route !== 'openrouter').flatMap(row =>
  (['conversation', 'work', 'team-work'] as const).map(surface => ({ ...row, surface })),
))('$route $surface retains its existing low effort default', async (row) => {
  const { service, sent } = await fixture(row);
  const { effort: _effort, ...request } = input(row, `default-${row.surface}`);
  expect(await textSurface(service, row, row.surface, request)).toContain('One discrepancy');
  expect(sent).toHaveLength(1);
  expect(sent[0].body.reasoning).toMatchObject({ effort: 'low' });
});

test.each(ROWS.flatMap(row => ['loop', 'conversation', 'work'].map(surface => ({ ...row, surface }))))(
  '$route $surface settles its actual HTTP call under the host-issued job', async (row) => {
    const { service, sent } = await fixture(row);
    const requestId = `${row.surface}-job`;
    if (row.surface === 'loop') {
      const adapter = await loop(service, row, requestId);
      const prepared = await adapter.prepare!(call(requestId), new AbortController().signal);
      await adapter.validatePrepared!(prepared);
      await adapter.complete(prepared, new AbortController().signal);
    } else if (row.surface === 'conversation') {
      const result = await service.modelSession(row.route, 'start', 'conversation-run', input(row, requestId));
      expect(result.response?.text).toContain('One discrepancy');
    } else {
      const result = await service.generateModelApi(row.route, input(row, requestId));
      expect(result.text).toContain('One discrepancy');
    }
    expect(sent).toHaveLength(1);
    const [hold] = exposure.list(row.connectionId);
    expect(hold.state).toBe('settled');
    expect(hold.jobId).toBe(jobKeyFor(PROJECT, requestId));
    expect(exposure.jobUsed(hold.jobId!)).toBe(hold.settledMicroUsd);
    if (row.route === 'openrouter') expect(sent[0].body.reasoning).toEqual({ effort: 'medium' });
  },
);

test.each(ROWS)('$route refuses a loop step against the same job already held on another connection', async (row) => {
  const { service, sent } = await fixture(row);
  const runId = 'capped-job';
  const scope = await jobs.scope(PROJECT, runId, `loop-${runId}`);
  const otherConnection = 'another-synthetic-connection';
  await exposure.setCap(otherConnection, micro(100_000_000), { approvedBy: 'synthetic test owner', note: 'test only' });
  const prior = await exposure.forJob(scope).reserve({
    connectionId: otherConnection, route: row.route, modelId: row.model, card: row.card,
    attempt: { runId: 'prior-step', stepId: 'model@1', attempt: 1, requestDigest: 'a'.repeat(64) },
    maxMicroUsd: scope.capMicroUsd,
  });
  await exposure.markUncertain(prior.id, 'Synthetic earlier call has unknown usage.');
  const adapter = await loop(service, row, runId);
  const prepared = await adapter.prepare!(call(runId), new AbortController().signal);
  await expect(adapter.validatePrepared!(prepared)).rejects.toMatchObject({ code: expect.stringContaining('job_cap_reached') });
  expect(sent).toHaveLength(0);
  expect(exposure.list(row.connectionId)).toHaveLength(0);
  expect(exposure.jobUsed(scope.id)).toBe(scope.capMicroUsd);
});

test.each(ROWS)('$route keeps an uncertain call charged to the same job', async (row) => {
  const { service, sent } = await fixture(row, false);
  const runId = 'uncertain-job';
  const adapter = await loop(service, row, runId);
  const prepared = await adapter.prepare!(call(runId), new AbortController().signal);
  await adapter.validatePrepared!(prepared);
  await expect(adapter.complete(prepared, new AbortController().signal)).rejects.toBeTruthy();
  expect(sent).toHaveLength(1);
  const [hold] = exposure.list(row.connectionId);
  expect(hold.state).toBe('uncertain');
  expect(hold.jobId).toBe(jobKeyFor(PROJECT, runId));
  expect(exposure.jobUsed(hold.jobId!)).toBe(hold.maxMicroUsd);
});

test.each(ROWS)('$route still refuses the connection cap when its job has room', async (row) => {
  const { service, sent } = await fixture(row);
  await exposure.setCap(row.connectionId, micro(1), { approvedBy: 'synthetic test owner', note: 'tight test cap' });
  const adapter = await loop(service, row, 'connection-capped-job');
  const prepared = await adapter.prepare!(call('connection-capped-job'), new AbortController().signal);
  await adapter.validatePrepared!(prepared);
  await expect(adapter.complete(prepared, new AbortController().signal)).rejects.toBeTruthy();
  expect(sent).toHaveLength(0);
  expect(exposure.list(row.connectionId)).toHaveLength(0);
});
