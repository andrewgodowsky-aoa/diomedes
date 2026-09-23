/**
 * The Azure OpenAI and OpenRouter routes through the real host: the setup
 * routes over HTTP, the real Store, RunService, text-route dispatch,
 * model-session driver, NativeAgent loop and registered read tools, and the
 * EngineService wrapping of the caller's preview and activity channels. Only
 * the network under the AI SDK is replaced by a captured transport, so nothing
 * here reaches a provider or spends money.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { AzureConnections } from '../server/engines/azure-openai';
import { OPENROUTER_SDK, OpenRouterConnections } from '../server/engines/openrouter';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { EngineError } from '../server/engines/process';
import { testOnlySecretBox } from '../server/connection-secrets';
import { FileModelTranscripts } from '../server/harness/model-transcripts';
import { modelSessionRunId } from '../server/harness/model-session-run';
import { TEXT_DISPATCH_STEP } from '../server/harness/text-route';
import type { Store } from '../server/store';
import type { TextRequest } from '../server/engines/contract';
import type { ToolActivity, TransientPreview } from '../shared/adapter-contract';
import type { AzureConnectionView, ModelApiReadiness, OpenRouterConnectionView } from '../shared/model-api';
import type { Project } from '../shared/types';
import { chatEvents, responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const AZURE_KEY = 'test-only-azure-key-0123456789abcdef-never-real';
const OPENROUTER_KEY = 'sk-or-test-only-0123456789abcdef-never-real';
const AWS_KEY = 'test-only-bedrock-key-0123456789abcdef-never-real';
const MENU = { path: 'menu.md', text: '# Lunch\n\nTomato soup and a grilled cheese sandwich.\n' };
const OR_MODEL = 'anthropic/claude-sonnet-4.5';
const rates = { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cacheReadUsdPerMillion: null, cacheWriteUsdPerMillion: null, source: 'the provider price page, read by the test owner' };

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;

type Item = Record<string, unknown>;
interface Seen {
  url: string;
  headers: Headers;
  body: Item;
}
let seen: Seen[];

/** One captured network for all three providers, answering from what each request carries. */
const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body)) as Item;
  seen.push({ url, headers: new Headers(init?.headers), body });
  if (url.startsWith('https://openrouter.ai/')) {
    const messages = (body.messages ?? []) as Item[];
    const toolResult = messages.find((message) => message.role === 'tool');
    if (body.tools && !toolResult)
      return sseResponse(
        chatEvents({
          model: OR_MODEL,
          provider: 'Anthropic',
          text: '',
          toolCalls: [{ id: 'call_or_1', name: 'read_source', arguments: JSON.stringify({ path: MENU.path }) }],
          usage: { prompt_tokens: 600, completion_tokens: 30, total_tokens: 630, is_byok: false },
        }),
      );
    const observed = String(toolResult?.content ?? '');
    return sseResponse(
      chatEvents({
        model: OR_MODEL,
        provider: 'Anthropic',
        text: observed.includes('Tomato soup') ? 'Tomato soup and a grilled cheese (menu.md).' : 'I could not read the menu.',
        usage: { prompt_tokens: 700, completion_tokens: 40, total_tokens: 740, is_byok: false },
      }),
    );
  }
  if (url.includes('.openai.azure.com/'))
    return sseResponse(
      responsesEvents({
        id: `resp_az_${seen.length}`,
        object: 'response',
        created_at: 1_790_000_000,
        status: 'completed',
        model: 'gpt-5.6-luna-2026-09-01',
        output: [
          {
            type: 'message',
            id: 'msg_az',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '{"summary":"Draft","changes":[]}', annotations: [] }],
          },
        ],
        usage: { input_tokens: 500, output_tokens: 60, total_tokens: 560 },
        incomplete_details: null,
        error: null,
      }),
      { 'apim-request-id': 'apim-1' },
    );
  throw new Error(`A request reached a provider this test never expects: ${url}`);
}) as typeof globalThis.fetch;

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
const store = () => app.locals.store as Store;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-providers-'));
  seen = [];
  service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  const dataDir = path.join(root, 'data');
  app = await createApp({
    dataDir,
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: network,
  });
  // What the integrator adds in server/app.ts: each new route's own record and private transcripts.
  service.modelApi!.azure = {
    connections: new AzureConnections(dataDir),
    transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-azure-openai'), 'azure-openai'),
  };
  service.modelApi!.openrouter = {
    connections: new OpenRouterConnections(dataDir),
    transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-openrouter'), 'openrouter'),
  };
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  project = await api<Project>('/projects', 'POST', { name: 'Lunch service' });
  // Cloud sharing is default-deny: this synthetic project shares its menu with the three
  // model-API routes, so each refusal below is the route's own and never a sharing one.
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0, routes: ['aws-bedrock', 'azure-openai', 'openrouter'], documents: [MENU.path],
    shareConversationHistory: false, shareReviewPackets: false,
  });
});
afterEach(async () => {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true });
});

const connectOpenRouter = () =>
  api<OpenRouterConnectionView>('/ai/model-api/openrouter', 'PUT', {
    models: [{ id: OR_MODEL, upstreams: ['anthropic'], rates }],
    apiKey: OPENROUTER_KEY,
    expiresAt: null,
    consent: true,
  });
const connectAzure = () =>
  api<AzureConnectionView>('/ai/model-api/azure-openai', 'PUT', {
    resourceName: 'contoso-ai',
    deployments: [{ model: 'gpt-5.6-luna', deployment: 'luna-prod', reasoning: true, rates }],
    apiKey: AZURE_KEY,
    expiresAt: null,
    consent: true,
  });
const connectAws = async () => {
  await api('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey: AWS_KEY,
    expiresAt: null,
    consent: true,
  });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
};
const approve = <T>(route: string, capUsd = 1) => api<T>(`/ai/model-api/${route}/spend-limit`, 'PUT', { capUsd, consent: true });

function turnInput(overrides: Partial<TextRequest> & Pick<TextRequest, 'model' | 'accountRoute'>): TextRequest {
  return {
    projectId: project.id,
    threadId: 'thread-1',
    requestId: `cmd-${Math.random().toString(36).slice(2)}`,
    prompt: 'What is for lunch?',
    documents: [MENU],
    instructions: 'You are Diomedes. Answer only from the attached files.',
    ...overrides,
  };
}

describe('setup over HTTP', () => {
  test('connect OpenRouter: the key goes only into protected storage, and the offline check sends nothing', async () => {
    const view = await connectOpenRouter();
    expect(JSON.stringify(view)).not.toContain(OPENROUTER_KEY);
    expect(view.connection).toMatchObject({
      endpoint: 'https://openrouter.ai/api/v1',
      models: [{ id: OR_MODEL, upstreams: ['anthropic'] }],
      dataCollection: 'deny',
      allowFallbacks: false,
      accountRoute: 'openrouter:openrouter-1@r1',
    });
    expect(view.connection!.models[0].rates).toMatchObject({ input: 3_000_000, output: 15_000_000 });
    expect(view.next).toBe('Approve a spend limit for OpenRouter before sending.');
    const settings = store().settings.services!;
    expect(settings.openrouter).toBe(true);
    expect(settings.openrouterAccountRoute).toBe('openrouter:openrouter-1@r1');
    expect(settings.openrouterModel).toBe(OR_MODEL);

    const blocked = await api<ModelApiReadiness>('/ai/model-api/openrouter/test', 'POST', {});
    expect(blocked).toMatchObject({ route: 'openrouter', ready: false, sent: false });
    expect(blocked.checks.find((check) => check.id === 'spend-limit')?.ok).toBe(false);
    await approve<OpenRouterConnectionView>('openrouter');
    const ready = await api<ModelApiReadiness>('/ai/model-api/openrouter/test', 'POST', {});
    expect(ready.ready).toBe(true);
    expect(seen).toHaveLength(0);

    const gone = await api<OpenRouterConnectionView>('/ai/model-api/openrouter', 'DELETE');
    expect(gone.configured).toBe(false);
    expect(store().settings.services!.openrouter).toBe(false);
    expect(store().settings.services!.openrouterAccountRoute).toBeUndefined();
  });

  test('a zero price, a router model or a variant is refused before the key is stored', async () => {
    for (const models of [
      [{ id: OR_MODEL, upstreams: ['anthropic'], rates: { ...rates, inputUsdPerMillion: 0 } }],
      [{ id: 'openrouter/auto', upstreams: ['anthropic'], rates }],
      [{ id: `${OR_MODEL}:free`, upstreams: ['anthropic'], rates }],
      [{ id: OR_MODEL, upstreams: [], rates }],
    ]) {
      const response = await fetch(`${base}/api/ai/model-api/openrouter`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ models, apiKey: OPENROUTER_KEY, expiresAt: null, consent: true }),
      });
      expect(response.status).toBe(400);
    }
    expect(await service.modelApi!.openrouter!.connections.read()).toBeNull();
    await expect(service.modelApi!.secrets.get('openrouter-1')).rejects.toMatchObject({ code: 'credential_missing' });
  });
});

describe('an OpenRouter conversation turn streams stamped previews and tool activity', () => {
  test('text deltas and a read_source round trip arrive as stamped frames; started and finished share the call id', async () => {
    const view = await connectOpenRouter();
    await approve('openrouter');
    const previews: TransientPreview[] = [];
    const activity: ToolActivity[] = [];
    const input = turnInput({
      model: OR_MODEL,
      accountRoute: view.connection!.accountRoute,
      onPreview: (frame) => previews.push(frame),
      onActivity: (frame) => activity.push(frame),
    });
    const runId = modelSessionRunId(project.id, input.requestId);
    const result = await service.modelSession('openrouter', 'start', runId, input);

    expect(result.response?.text).toBe('Tomato soup and a grilled cheese (menu.md).');
    expect(result.response?.version).toBe(OPENROUTER_SDK);
    expect(seen.map((request) => request.url)).toEqual([
      'https://openrouter.ai/api/v1/chat/completions',
      'https://openrouter.ai/api/v1/chat/completions',
    ]);
    for (const request of seen) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${OPENROUTER_KEY}`);
      expect(request.body.provider).toEqual({ only: ['anthropic'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny' });
    }

    expect(activity.map((frame) => [frame.phase, frame.callId, frame.tool, frame.summary])).toEqual([
      ['started', 'call_or_1', 'read_source', 'Reading menu.md'],
      ['finished', 'call_or_1', 'read_source', 'Read menu.md'],
    ]);
    expect(previews.map((frame) => frame.text).join('')).toBe('Tomato soup and a grilled cheese (menu.md).');
    expect(previews.map((frame) => frame.seq)).toEqual(previews.map((_frame, index) => index + 1));
    for (const frame of [...previews, ...activity]) {
      expect(frame).toMatchObject({ projectId: project.id, threadId: 'thread-1', requestId: input.requestId, runId });
      expect(frame.stepId.startsWith('turn:')).toBe(true);
      expect(frame.attempt).toBeGreaterThanOrEqual(1);
      expect(frame.fence).toBeGreaterThanOrEqual(1);
    }
    const holds = service.modelApi!.exposure.list('openrouter-1');
    expect(holds.map((hold) => hold.state)).toEqual(['settled', 'settled']);
  });

  test('a caller may not hand the route a raw delta or activity sink', async () => {
    const view = await connectOpenRouter();
    const input = turnInput({ model: OR_MODEL, accountRoute: view.connection!.accountRoute, onDelta: () => undefined });
    await expect(service.modelSession('openrouter', 'start', modelSessionRunId(project.id, input.requestId), input)).rejects.toMatchObject({
      code: 'PREVIEW_CONTRACT',
    });
    const other = turnInput({ model: OR_MODEL, accountRoute: view.connection!.accountRoute, onToolActivity: () => undefined });
    await expect(service.generateModelApi('openrouter', other)).rejects.toMatchObject({ code: 'PREVIEW_CONTRACT' });
    expect(seen).toHaveLength(0);
  });
});

describe('an Azure Work turn', () => {
  test('streams stamped previews under the dispatch step and sends one request to the resource’s deployment', async () => {
    const view = await connectAzure();
    await approve('azure-openai');
    const previews: TransientPreview[] = [];
    const result = await service.generateModelApi(
      'azure-openai',
      turnInput({ model: 'gpt-5.6-luna', accountRoute: view.connection!.accountRoute, onPreview: (frame) => previews.push(frame) }),
    );
    expect(result.text).toBe('{"summary":"Draft","changes":[]}');
    expect(result.model).toBe('gpt-5.6-luna-2026-09-01');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://contoso-ai.openai.azure.com/openai/v1/responses');
    expect(seen[0].headers.get('api-key')).toBe(AZURE_KEY);
    expect(seen[0].body.model).toBe('luna-prod');
    expect(seen[0].body.tools).toBeUndefined();
    expect(previews.map((frame) => frame.text).join('')).toBe(result.text);
    for (const frame of previews) expect(frame).toMatchObject({ runId: result.runId, stepId: TEXT_DISPATCH_STEP });
  });
});

describe('no route falls back to another payer', () => {
  test('a disconnected OpenRouter is refused even with AWS and Azure ready, and nothing is sent anywhere', async () => {
    await connectAws();
    const azure = await connectAzure();
    await approve('azure-openai');
    const input = turnInput({ model: OR_MODEL, accountRoute: 'openrouter:openrouter-1@r1' });
    await expect(service.modelSession('openrouter', 'start', modelSessionRunId(project.id, input.requestId), input)).rejects.toBeInstanceOf(
      EngineError,
    );
    // An Azure turn naming a model the connection does not serve is refused, not sent to another route.
    await expect(
      service.generateModelApi('azure-openai', turnInput({ model: OR_MODEL, accountRoute: azure.connection!.accountRoute })),
    ).rejects.toMatchObject({ code: 'ROUTE_REFUSED' });
    expect(seen).toHaveLength(0);
  });

  test('an Azure connection with no spend room is refused, while AWS’s own limit is untouched', async () => {
    await connectAws();
    const azure = await connectAzure();
    await approve('azure-openai', 0);
    await expect(
      service.generateModelApi('azure-openai', turnInput({ model: 'gpt-5.6-luna', accountRoute: azure.connection!.accountRoute })),
    ).rejects.toMatchObject({ code: 'SPEND_LIMIT' });
    expect(seen).toHaveLength(0);
    expect(service.modelApi!.exposure.list('aws-bedrock-1')).toHaveLength(0);
  });

  test('a missing credential sends nothing, and the offline check says why', async () => {
    const azure = await connectAzure();
    await approve('azure-openai');
    await service.modelApi!.secrets.remove('azure-openai-1');
    const readiness = await api<ModelApiReadiness>('/ai/model-api/azure-openai/test', 'POST', {});
    expect(readiness.ready).toBe(false);
    expect(readiness.checks.find((check) => check.id === 'credential')).toMatchObject({ ok: false });
    await expect(
      service.generateModelApi('azure-openai', turnInput({ model: 'gpt-5.6-luna', accountRoute: azure.connection!.accountRoute })),
    ).rejects.toBeInstanceOf(EngineError);
    expect(seen).toHaveLength(0);
    expect(service.modelApi!.exposure.list('azure-openai-1')).toHaveLength(0);
  });

  test('a route whose services the app did not attach is unavailable, never served by another route', async () => {
    await connectAws();
    delete service.modelApi!.openrouter;
    const input = turnInput({ model: OR_MODEL, accountRoute: 'openrouter:openrouter-1@r1' });
    await expect(service.generateModelApi('openrouter', input)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(seen).toHaveLength(0);
  });
});
