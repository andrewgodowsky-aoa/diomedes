/**
 * DIO-216 slice A: the local model as an H14 role beside two cloud routes. One lead on Azure (a Sol
 * deployment), a worker on the local model's Gaming profile and a Kimi K3 advisor on AWS, each
 * through the real engine service and its own adapter. Fixtures only: one transport answers every
 * route by host, and a mocked local host reports which profile runs. Nothing reaches Azure, AWS or
 * a real local model, and nothing here starts one.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { AWS_BEDROCK_SDK, AWS_RESPONSES_ENDPOINTS, awsQualificationIdentity } from '../server/engines/aws-bedrock.js';
import { LOCAL_MODEL_CONNECTION } from '../server/engines/bonsai.js';
import { RouteQualifications } from '../server/engines/route-qualification-store.js';
import { EngineService } from '../server/engines/service.js';
import {
  LocalModelError,
  LOCAL_MODEL_NOT_INSTALLED,
  LOCAL_MODEL_NOT_RUNNING,
  LOCAL_MODEL_UNKNOWN_PROFILE,
  localModelOtherProfile,
  type LocalModelHost,
} from '../server/bonsai/runtime.js';
import type { Store } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import { LOCAL_MODEL_ACCOUNT as BONSAI_ACCOUNT, type LocalModelStatus } from '../shared/local-model.js';
import { BONSAI_MODEL, FixedLocalModel, localAnswerStream } from './fixtures/local-model.js';
import { AWS_KIMI_K3, AWS_KIMI_K3_REFUSAL, MODEL_API_PROVIDERS, type AwsConnectionView, type AzureConnectionView } from '../shared/model-api.js';
import type { HarnessRun } from '../shared/harness.js';
import type { TeamLeadView } from '../shared/team-delegation.js';
import { chatEvents, responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import { passingReceipt } from './fixtures/route-qualification-receipts.js';

const K3 = AWS_KIMI_K3.model;
const SOL = 'gpt-5.6-sol';
const AZURE_HOST = 'https://contoso-ai.openai.azure.com/';
const AWS_BASE = AWS_RESPONSES_ENDPOINTS['us-east-1'];
const LOCAL_BASE = 'http://127.0.0.1:18082/';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const rates = {
  inputUsdPerMillion: 3,
  outputUsdPerMillion: 15,
  cacheReadUsdPerMillion: null,
  cacheWriteUsdPerMillion: null,
  source: 'Synthetic fixture price, declared by the test owner',
};
const ORDER = 'Order 1182: 100 napkins, 40 tablecloths.\n';
const DELIVERY = 'Delivered 94 napkins and 40 tablecloths. Six napkins short.\n';
const WORKER_ANSWER = 'delivery.md: six napkins short.';
const ADVICE = 'Check the napkin count against order.md before answering.';
const LEAD_ANSWER = 'Six napkins are short. The advisor agrees the count needs checking.';

type Item = Record<string, unknown>;
type Route = 'azure-openai' | 'aws-bedrock' | 'bonsai';
interface Call {
  route: Route;
  url: string;
  body: Record<string, unknown> | null;
}

let root: string, url: string, projectId: string, taskId: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined, service: EngineService;
let host: LocalModelHost, running: string | null, installed: boolean;
let calls: Call[], admissions: string[];
let azureConnection: string, awsConnection: { id: string; revision: number; endpoint: string };
const store = (): Store => app.locals.store;
const harness = (): HarnessHost => app.locals.harness;

/** The scripted Azure lead: a plan, one task for the worker, one question for the advisor, then its answer. */
function leadAnswer(body: Record<string, unknown>, n: number): Response {
  const input = (body.input as Item[] | undefined) ?? [];
  const tools = (body.tools as unknown[] | undefined) ?? [];
  const answered = input.filter((item) => item.type === 'function_call_output').length;
  const message = (text: string): Item => ({
    type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  });
  const call = (name: string, args: unknown): Item => ({
    type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args), status: 'completed',
  });
  const output = !tools.length
    ? message('1. Hand delivery.md to the worker.\n2. Ask the advisor what to check.\n3. Answer.')
    : answered === 0
      ? call('assign_workers', { tasks: [{ task: 'Read delivery.md and say what is short.', files: ['delivery.md'] }] })
      : answered === 1
        ? call('consult_advisor', { question: 'What should be checked before answering?' })
        : message(LEAD_ANSWER);
  const response = {
    id: `resp_sol_${n}`, object: 'response', created_at: 1_790_000_000, status: 'completed', model: `${SOL}-2026-09-01`,
    output: [{ type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: `enc-sol-${n}` }, output],
    usage: { input_tokens: 400, input_tokens_details: { cached_tokens: 0 }, output_tokens: 60, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 460 },
    incomplete_details: null, error: null,
  };
  return sseResponse(responsesEvents(response), { 'apim-request-id': `apim-${n}` });
}

/** The scripted local worker: it reads delivery.md once through its own tool, then answers. */
function workerAnswer(target: string, body: Record<string, unknown>): Response {
  if (target.endsWith('/apply-template')) return Response.json({ prompt: 'Fixture template' });
  if (target.endsWith('/tokenize')) return Response.json({ tokens: [1, 2, 3] });
  expect(target).toBe(`${LOCAL_BASE}v1/chat/completions`);
  const messages = body.messages as { role: string; content: unknown }[];
  const read = messages.some((message) => message.role === 'tool');
  const usage = { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 };
  // The local route reads a stream (DIO-247), in llama.cpp's final-chunk order.
  return localAnswerStream(read
    ? { id: 'local-2', model: BONSAI_MODEL, usage, choices: [{ finish_reason: 'stop', message: { content: WORKER_ANSWER } }] }
    : { id: 'local-1', model: BONSAI_MODEL, usage, choices: [{ finish_reason: 'tool_calls', message: { content: null,
        tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_project_file', arguments: '{"path":"delivery.md"}' } }] } }] });
}

const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = String(input);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  const route: Route | null = target.startsWith(AZURE_HOST) ? 'azure-openai'
    : target.startsWith(AWS_BASE) ? 'aws-bedrock' : target.startsWith(LOCAL_BASE) ? 'bonsai' : null;
  if (!route) throw new Error(`This fixture never reaches ${target}.`);
  calls.push({ route, url: target, body });
  if (route === 'azure-openai') return leadAnswer(body!, calls.length);
  if (route === 'bonsai') return workerAnswer(target, body!);
  return sseResponse(chatEvents({ id: `chatcmpl-k3-${calls.length}`, model: K3, text: ADVICE,
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 12 } } }),
  { 'x-amzn-requestid': `req-k3-${calls.length}` });
}) as typeof globalThis.fetch;

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text) as T };
}
async function ok<T = any>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request<T>(route, method, body);
  expect(response.status, `${method} ${route}: ${response.text}`).toBe(200);
  return response.data;
}

async function open(configured = true) {
  calls = [];
  admissions = [];
  host = {
    // An inspect only: what runs now. Nothing here starts a profile.
    inspect: vi.fn(async (): Promise<LocalModelStatus> => !installed
      ? { state: 'missing', installed: false, mode: null, owned: false, detail: 'Not installed.' }
      : running
        ? { state: 'ready', installed: true, mode: running, owned: true, detail: `${running} is ready.` }
        : { state: 'unloaded', installed: true, mode: null, owned: false, detail: 'Choose a profile.' }),
    // A send acquires without starting: a profile that isn't the running one is refused, as the host script does.
    acquire: vi.fn(async (profile, options) => {
      if (running !== profile.mode && !options?.start) throw new LocalModelError('unloaded', LOCAL_MODEL_NOT_RUNNING);
      return { status: { state: 'ready' as const, installed: true, mode: profile.mode, owned: true, detail: 'Ready.' }, release: async () => {} };
    }),
  };
  service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: transport,
    // Bonsai's own descriptor, from a copy; with none, no local model is set up on this computer.
    localModel: { host, source: new FixedLocalModel(configured ? undefined : null) },
    automationTickMs: null,
  });
  // Every model-API admission, by route: the lead's must never happen when a role refuses.
  const admit = service.admitModelApi.bind(service);
  vi.spyOn(service, 'admitModelApi').mockImplementation((route, ...rest) => {
    admissions.push(route);
    return admit(route, ...rest);
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setUp(options: { receipt?: boolean; configured?: boolean } = {}) {
  await open(options.configured ?? true);
  projectId = (await ok<{ id: string }>('/projects', 'POST', { name: 'Linen orders' })).id;
  const folder = store().state(projectId).project.folder;
  await fs.writeFile(path.join(folder, 'order.md'), ORDER);
  await fs.writeFile(path.join(folder, 'delivery.md'), DELIVERY);
  taskId = (await ok<{ id: string }>(`/projects/${projectId}/tasks`, 'POST', { name: 'Check the linen delivery' })).id;
  const azure = await ok<AzureConnectionView>('/ai/model-api/azure-openai', 'PUT', {
    resourceName: 'contoso-ai',
    deployments: [{ model: SOL, deployment: 'sol-prod', reasoning: true, rates }],
    apiKey: 'test-only-azure-key-0123456789abcdef-never-real',
    expiresAt: null,
    consent: true,
  });
  azureConnection = azure.connection!.id;
  await ok('/ai/model-api/azure-openai/spend-limit', 'PUT', { capUsd: 5, consent: true });
  const aws = await ok<AwsConnectionView>('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: K3,
    apiKey: 'test-only-bedrock-key-0123456789abcdef-never-real',
    expiresAt: null,
    consent: true,
  });
  awsConnection = aws.connection!;
  await ok('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 5, consent: true });
  if (options.receipt !== false)
    await new RouteQualifications(path.join(root, 'data')).record(passingReceipt({
      ...awsQualificationIdentity({ id: awsConnection.id, revision: awsConnection.revision, modelId: K3 }),
      endpoint: awsConnection.endpoint,
      sdk: AWS_BEDROCK_SDK,
    }));
  await ok(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['azure-openai', 'bonsai', 'aws-bedrock'],
    documents: ['order.md', 'delivery.md'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
}

/** The exact API body for a three-model team: a Sol lead, a local Gaming worker and a K3 advisor. */
const startBody = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  commandId: `three-model-${Math.random().toString(36).slice(2)}`,
  taskId,
  goal: 'Compare the delivery with the order and say what is short.',
  route: 'azure-openai',
  model: SOL,
  consent: true,
  sources: ['order.md', 'delivery.md'],
  team: {
    worker: { route: 'bonsai', model: 'bonsai-gaming', accountRoute: BONSAI_ACCOUNT },
    advisor: { route: 'aws-bedrock', model: K3 },
  },
  ...overrides,
});

const holds = (connectionId: string) => service.modelApi!.exposure.list(connectionId);
async function untilRun(runId: string, expected: HarnessRun['state']) {
  await vi.waitFor(async () => expect((await harness().get(projectId, runId)).state).toBe(expected), { timeout: 20_000 });
  await harness().bridge.flush();
  return harness().get(projectId, runId);
}
/** Nothing was sent anywhere, nothing was held and no run exists. */
async function nothingHappened() {
  expect(calls).toEqual([]);
  for (const connection of [azureConnection, awsConnection.id, LOCAL_MODEL_CONNECTION]) expect(holds(connection)).toEqual([]);
  expect(store().state(projectId).sessions).toEqual([]);
  expect(await harness().list(projectId)).toEqual([]);
  expect(host.acquire).not.toHaveBeenCalled();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dio216-three-model-'));
  running = 'Gaming';
  installed = true;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    const closing = server;
    server = undefined;
    try { await app.locals.close(); }
    finally {
      closing.closeAllConnections();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a three-model H14 team: Sol leads on Azure, the local model works, K3 advises on AWS', () => {
  test('each role runs on its own route; the Team view shows all three; only the cloud calls hold spend', async () => {
    await setUp();
    const started = await ok<{ runId: string }>(`/projects/${projectId}/loop/start`, 'POST', startBody());
    const lead = await untilRun(started.runId, 'completed');
    expect(lead.state).toBe('completed');

    // All three routes were called, each through its own exchange.
    const routes = new Set(calls.map((call) => call.route));
    expect([...routes].sort()).toEqual(['aws-bedrock', 'azure-openai', 'bonsai']);
    expect(calls.filter((call) => call.route === 'bonsai' && call.url.endsWith('/v1/chat/completions'))).toHaveLength(2);
    expect(calls.filter((call) => call.route === 'aws-bedrock')).toHaveLength(1);
    expect(calls.filter((call) => call.route === 'aws-bedrock')[0].url).toBe(`${AWS_BASE}/chat/completions`);
    expect(calls.filter((call) => call.route === 'aws-bedrock')[0].body).toMatchObject({ model: K3 });
    expect(calls.filter((call) => call.route === 'azure-openai').every((call) => call.body?.model === 'sol-prod')).toBe(true);
    // The worker's own tool read the shared file it was handed.
    const toolResult = (calls.filter((call) => call.route === 'bonsai' && call.url.endsWith('/v1/chat/completions'))[1].body!
      .messages as { role: string; content: string }[]).find((message) => message.role === 'tool');
    expect(toolResult?.content).toContain('Six napkins short.');
    // The local model was read and used, never started.
    expect(host.inspect).toHaveBeenCalled();
    expect(vi.mocked(host.acquire).mock.calls.map((call) => call[1])).toEqual([{ start: false }, { start: false }]);

    // The Team view shows the lead and both roles, each with the model the runtime reported.
    const listed = await ok<{ leads: { runId: string; route: string; team: TeamLeadView }[] }>(`/projects/${projectId}/loop/team`);
    expect(listed.leads.map((item) => [item.runId, item.route])).toEqual([[started.runId, 'azure-openai']]);
    const team = listed.leads[0].team;
    expect(team.worker).toMatchObject({ route: 'bonsai', model: 'bonsai-gaming', accountRoute: BONSAI_ACCOUNT });
    expect(team.advisor).toMatchObject({ route: 'aws-bedrock', model: K3 });
    expect(team.workers).toHaveLength(1);
    expect(team.workers[0]).toMatchObject({ outcome: 'completed', route: 'bonsai', text: WORKER_ANSWER });
    expect(team.workers[0].models).toEqual([{ engine: 'bonsai', reported: BONSAI_MODEL, calls: 2 }]);
    expect(team.advice).toHaveLength(1);
    expect(team.advice[0]).toMatchObject({ outcome: 'completed', route: 'aws-bedrock', text: ADVICE });
    expect(team.advice[0].models).toEqual([{ engine: 'aws-bedrock', reported: K3, calls: 1 }]);

    // Spend is held only on the two cloud connections, and each hold settled. The local calls held nothing.
    const leadHolds = holds(azureConnection), advisorHolds = holds(awsConnection.id);
    expect(leadHolds.length).toBe(calls.filter((call) => call.route === 'azure-openai').length);
    expect(advisorHolds).toHaveLength(1);
    for (const hold of [...leadHolds, ...advisorHolds]) expect(hold.state).toBe('settled');
    expect(holds(LOCAL_MODEL_CONNECTION)).toEqual([]);
  });
});

describe('refusals before anything is sent or held', () => {
  test('the local model is not running: the runtime’s own sentence, and the lead is never admitted', async () => {
    await setUp();
    running = null;
    const refused = await request(`/projects/${projectId}/loop/start`, 'POST', startBody());
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ error: LOCAL_MODEL_NOT_RUNNING, code: 'local_model_not_ready' });
    expect(admissions).toEqual([]);
    await nothingHappened();
  });

  test('the local model runs Full when Gaming was asked: the profile sentence, and nothing is admitted', async () => {
    await setUp();
    running = 'Full';
    const refused = await request(`/projects/${projectId}/loop/start`, 'POST', startBody());
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ error: localModelOtherProfile('Full', 'Gaming'), code: 'local_model_not_ready' });
    expect(localModelOtherProfile('Full', 'Gaming')).toBe('The local model is running its Full profile, not Gaming. Start Gaming first.');
    expect(admissions).toEqual([]);
    await nothingHappened();
  });

  test('a K3 advisor with no route check receipt is refused before the lead is admitted', async () => {
    await setUp({ receipt: false });
    const refused = await request(`/projects/${projectId}/loop/start`, 'POST', startBody());
    expect(refused.status).toBe(409);
    expect(refused.data.error).toContain(AWS_KIMI_K3_REFUSAL);
    // The local worker was read and admitted first; the advisor refused; the Azure lead never was.
    expect(admissions).toEqual(['bonsai', 'aws-bedrock']);
    await nothingHappened();
  });

  test('the local route is not installed: refused before its status is even read', async () => {
    await setUp({ configured: false });
    const refused = await request(`/projects/${projectId}/loop/start`, 'POST', startBody());
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ error: LOCAL_MODEL_NOT_INSTALLED, code: 'local_model_not_ready' });
    expect(host.inspect).not.toHaveBeenCalled();
    expect(admissions).toEqual([]);
    await nothingHappened();
  });

  test('a local installation that reports itself missing is refused the same way', async () => {
    await setUp();
    installed = false;
    const refused = await request(`/projects/${projectId}/loop/start`, 'POST', startBody());
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ error: LOCAL_MODEL_NOT_INSTALLED, code: 'local_model_not_ready' });
    expect(admissions).toEqual([]);
    await nothingHappened();
  });

  test('a local role that names no local profile is refused before its status is read', async () => {
    await setUp();
    const refused = await request(`/projects/${projectId}/loop/start`, 'POST', startBody({
      team: { worker: { route: 'bonsai', model: 'not-a-profile', accountRoute: BONSAI_ACCOUNT }, advisor: null },
    }));
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ error: LOCAL_MODEL_UNKNOWN_PROFILE, code: 'local_model_not_ready' });
    expect(host.inspect).not.toHaveBeenCalled();
    expect(admissions).toEqual([]);
    await nothingHappened();
  });

  test.each(MODEL_API_PROVIDERS.map((route) => [route]))('%s still refuses as a lead and as a role when its Settings switch is off', async (route) => {
    await setUp();
    await store().saveSettings({ ...store().settings, services: { ...(store().settings.services ?? {}), [route]: false } });
    const off = 'Turn the selected route on in Settings before using it.';
    const asLead = await request(`/projects/${projectId}/loop/start`, 'POST', startBody({ route, model: null, team: null }));
    expect(asLead.status).toBe(409);
    expect(asLead.data.error).toBe(off);
    const asWorker = await request(`/projects/${projectId}/loop/start`, 'POST',
      startBody({ route: 'native-fixture', model: null, team: { worker: { route }, advisor: null } }));
    expect(asWorker.status).toBe(409);
    expect(asWorker.data.error).toBe(off);
    expect(admissions).toEqual([]);
    await nothingHappened();
  });
});
