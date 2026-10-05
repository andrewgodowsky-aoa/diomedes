/**
 * DIO-215 through the real app: the owner's cache setting routes and their guard, the capability
 * records with a route check receipt behind them, a whole settings save that cannot move the
 * setting, and a real conversation turn on AWS Luna whose request and context record follow the
 * setting. The provider network is a scripted fixture injected as `modelApiTransport`; nothing
 * reaches AWS or Azure.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../server/app.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock.js';
import { cacheKey } from '../server/engines/route-cache.js';
import { EngineService } from '../server/engines/service.js';
import type { Store } from '../server/store.js';
import { KIMI_K3_MODEL_CARD } from '../shared/declared-capabilities.js';
import type { RouteCachePolicyView, RouteCapabilityView } from '../shared/model-api.js';
import { cacheAccount } from '../shared/route-capabilities.js';
import type { Conversation, Project } from '../shared/types.js';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import { routeCheckProvider } from './fixtures/route-check-provider.js';

type Item = Record<string, unknown>;
const K3 = 'us.moonshotai.kimi-k3';
const SOL = 'gpt-6.1-sol';
const AWS_KEY = 'test-only-bedrock-key-0123456789abcdef-never-real';
const AZURE_KEY = 'test-only-azure-key-0123456789abcdef-never-real';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const rates = { inputUsdPerMillion: 2, outputUsdPerMillion: 12, cacheReadUsdPerMillion: 0.2, cacheWriteUsdPerMillion: null, source: 'the provider price page, read by the test owner' };

let root: string | undefined;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let transport: typeof globalThis.fetch = (async () => {
  throw new Error('No provider call is expected here.');
}) as typeof globalThis.fetch;

async function open() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-route-cache-'));
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: ((input: RequestInfo | URL, init?: RequestInit) => transport(input, init)) as typeof globalThis.fetch,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = undefined;
});

const request = async (route: string, method = 'GET', body?: unknown, send: Record<string, string> = headers) => {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: send,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text) as any };
};
const ok = async <T>(route: string, method = 'GET', body?: unknown): Promise<T> => {
  const response = await request(route, method, body);
  expect(response.status >= 200 && response.status < 300, `${route}: ${response.status} ${response.text}`).toBe(true);
  return response.data as T;
};
const policyOf = (route: string) => ok<RouteCachePolicyView>(`/ai/model-api/${route}/cache-policy`);
const choose = (route: string, policy: string) => request(`/ai/model-api/${route}/cache-policy`, 'PUT', { policy });
const store = () => app.locals.store as Store;
const connectAws = (model: string) =>
  ok('/ai/model-api/aws-bedrock', 'PUT', { accountId: '123456789012', region: 'us-east-1', model, apiKey: AWS_KEY, expiresAt: null, consent: true });

describe('the cache setting routes', () => {
  test('read the provider’s default until the owner chooses, and write only through the client', async () => {
    await open();
    for (const route of ['aws-bedrock', 'azure-openai'])
      expect(await policyOf(route)).toEqual({ route, policy: 'provider-default', chosen: false, models: [] });

    // The same guard as every other setup write: no client header, no change.
    const unheaded = await request('/ai/model-api/aws-bedrock/cache-policy', 'PUT', { policy: 'off' }, { 'Content-Type': 'application/json' });
    expect(unheaded.status).toBe(403);
    expect(store().settings.services?.['aws-bedrockCachePolicy']).toBeUndefined();

    expect(await choose('aws-bedrock', 'sometimes')).toMatchObject({
      status: 400,
      data: { error: 'Choose the provider’s default, off or an explicit prefix.' },
    });
    expect((await request('/ai/model-api/aws-bedrock/cache-policy', 'PUT', { policy: 'off', key: 'mine' })).status).toBe(400);
    expect((await request('/ai/model-api/aws-bedrock/cache-policy', 'PUT', {})).status).toBe(400);
    expect(store().settings.services?.['aws-bedrockCachePolicy']).toBeUndefined();

    // It belongs to the route, so it can be chosen before a connection exists.
    const chosen = await choose('aws-bedrock', 'off');
    expect(chosen.status, chosen.text).toBe(200);
    expect(chosen.data).toEqual({ route: 'aws-bedrock', policy: 'off', chosen: true, models: [] });
    expect((await choose('azure-openai', 'explicit-prefix')).data).toMatchObject({ policy: 'explicit-prefix', chosen: true });
    const settings = await ok<{ services: Record<string, unknown> }>('/settings');
    expect(settings.services).toMatchObject({ 'aws-bedrockCachePolicy': 'off', 'azure-openaiCachePolicy': 'explicit-prefix' });
  });

  test('a whole settings save can neither fail on the setting nor change it', async () => {
    await open();
    await choose('aws-bedrock', 'off');
    const current = await ok<{ services: Record<string, unknown> }>('/settings');
    // Echoed back as stored, and echoed back changed: both saves succeed and the setting stays.
    await ok('/settings', 'PUT', current);
    await ok('/settings', 'PUT', { ...current, services: { ...current.services, 'aws-bedrockCachePolicy': 'explicit-prefix', 'azure-openaiCachePolicy': 'off' } });
    // Left out of a services save, it is kept.
    const narrowed = { ...current.services };
    delete narrowed['aws-bedrockCachePolicy'];
    await ok('/settings', 'PUT', { services: narrowed });
    expect((await policyOf('aws-bedrock')).policy).toBe('off');
    expect(store().settings.services?.['aws-bedrockCachePolicy']).toBe('off');
    expect(store().settings.services?.['azure-openaiCachePolicy']).toBeUndefined();
  });

  test('the records: Kimi K3’s declared facts, overlaid by a passing route check, and what a turn would note', async () => {
    await open();
    await connectAws(K3);
    await ok('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 5, consent: true });
    await choose('aws-bedrock', 'off');

    const before = await policyOf('aws-bedrock');
    expect(before.models).toHaveLength(1);
    expect(before.models[0]).toMatchObject({
      model: K3,
      deployment: null,
      capability: {
        route: 'aws-bedrock',
        protocol: 'openai-chat-completions',
        contextTokens: { value: 1_000_000, source: 'declared', evidence: KIMI_K3_MODEL_CARD },
        tools: { value: true, source: 'declared' },
        cache: { off: 'unknown', minimumTokens: { value: 1_024, source: 'declared' } },
        receiptId: null,
      },
      preview: { policy: 'off', offVerified: false, note: 'Caching is set to off. No route check on this connection has confirmed it yet.' },
    });

    const net = routeCheckProvider('chat', K3);
    transport = net.fetch;
    const run = await request('/ai/model-api/aws-bedrock/qualify', 'POST', { consent: true });
    expect(run.status, run.text).toBe(200);
    const receiptId = run.data.receipt.id as string;

    const after = await policyOf('aws-bedrock');
    expect(after.models[0].capability).toMatchObject({
      tools: { value: true, source: 'observed' },
      cache: { off: 'verified' },
      receiptId,
    });
    expect(after.models[0].preview).toEqual(cacheAccount('off', after.models[0].capability, null));
    expect(after.models[0].preview.offVerified).toBe(true);
    const capabilities = await ok<RouteCapabilityView>('/ai/model-api/aws-bedrock/capabilities');
    expect(capabilities).toEqual({ route: 'aws-bedrock', model: K3, deployment: null, capability: after.models[0].capability });
    // No response names a cache key or the scope it is made from.
    expect(JSON.stringify(after)).not.toMatch(/dio1-|tenant/);
  });

  test('Azure: one record per deployment, and one deployment’s record by model', async () => {
    await open();
    const put = await request('/ai/model-api/azure-openai', 'PUT', {
      resourceName: 'contoso-ai',
      deployments: [
        { model: SOL, deployment: 'sol-prod', reasoning: true, rates },
        { model: 'gpt-6-mini', deployment: 'mini-prod', reasoning: false, rates },
      ],
      apiKey: AZURE_KEY,
      expiresAt: null,
      consent: true,
    });
    expect(put.status, put.text).toBe(200);
    const view = await policyOf('azure-openai');
    expect(view.models.map((entry) => [entry.model, entry.deployment])).toEqual([
      [SOL, 'sol-prod'],
      ['gpt-6-mini', 'mini-prod'],
    ]);
    for (const entry of view.models) {
      expect(entry.capability).toMatchObject({ route: 'azure-openai', protocol: 'openai-responses', receiptId: null });
      // Nothing is declared for an Azure deployment.
      expect(entry.capability.contextTokens).toMatchObject({ value: null, source: 'not-known' });
      expect(entry.preview).toEqual(cacheAccount('provider-default', entry.capability, null));
    }
    expect(await ok<RouteCapabilityView>(`/ai/model-api/azure-openai/capabilities?model=${SOL}`)).toEqual({
      route: 'azure-openai',
      model: SOL,
      deployment: 'sol-prod',
      capability: view.models[0].capability,
    });
    expect(await request('/ai/model-api/azure-openai/capabilities')).toMatchObject({ status: 400, data: { error: 'Name the Azure model to read.' } });
    expect(await request('/ai/model-api/azure-openai/capabilities?model=gpt-unknown')).toMatchObject({
      status: 409,
      data: { code: 'azure_unknown_model' },
    });
  });
});

describe('a conversation turn on AWS Luna follows the setting', () => {
  test('explicit prefix, off, then the provider’s default: the request and the turn’s context record', async () => {
    const seen: Item[] = [];
    let calls = 0;
    transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Item);
      calls += 1;
      return sseResponse(
        responsesEvents({
          id: `resp_${calls}`,
          object: 'response',
          created_at: 1_790_000_000,
          status: 'completed',
          model: AWS_LUNA_MODEL,
          output: [
            { type: 'reasoning', id: `rs_${calls}`, summary: [], encrypted_content: `enc-${calls}` },
            { type: 'message', id: `msg_${calls}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Answer ${calls}.`, annotations: [] }] },
          ],
          usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 940 },
          incomplete_details: null,
          error: null,
        }),
        { 'x-amzn-requestid': `req-${calls}` },
      );
    }) as typeof globalThis.fetch;
    await open();
    const project = await ok<Project>('/projects', 'POST', { name: 'Linen service' });
    const thread = await ok<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
    await ok(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
    await ok(`/projects/${project.id}/cloud-sharing`, 'PUT', {
      expectedVersion: 0,
      routes: ['aws-bedrock'],
      documents: [],
      shareConversationHistory: true,
      shareReviewPackets: false,
    });
    await connectAws(AWS_LUNA_MODEL);
    await ok('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
    const send = (commandId: string, text: string) =>
      ok(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', { commandId, text, mode: 'auto', sources: [], consent: true });
    const lastContext = () =>
      store()
        .state(project.id)
        .conversations.find((item) => item.id === thread.id)!
        .turns.filter((turn) => turn.role === 'assistant')
        .at(-1)!.context!;
    const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

    await choose('aws-bedrock', 'explicit-prefix');
    await send('m-explicit', 'How many napkins were short on Friday?');
    const explicit = seen.at(-1)!;
    const context = lastContext();
    // The key is the one derived on this computer, with no tenant signed in.
    expect(explicit.prompt_cache_key).toBe(
      cacheKey({ tenantId: 'local', route: 'aws-bedrock', connectionId: 'aws-bedrock-1', connectionRevision: 1, model: AWS_LUNA_MODEL }),
    );
    expect(explicit.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' });
    const [first] = explicit.input as Item[];
    const [part] = first.content as Item[];
    expect(first.role).toBe('developer');
    expect(part).toMatchObject({ type: 'input_text', prompt_cache_breakpoint: { mode: 'explicit' } });
    // The marked part is exactly the turn's stable prefix, the one its context record names.
    expect(sha(part.text as string)).toBe(context.stablePrefix.sha);
    expect(JSON.stringify(explicit).split('prompt_cache_breakpoint').length - 1).toBe(1);
    expect(context.cache).toEqual({
      support: 'automatic-prefix',
      policy: 'explicit-prefix',
      offVerified: null,
      marked: 'stable-prefix',
      note: 'The stable start of the instructions is marked for caching for 30 minutes, under a key kept to this business and route.',
    });

    await choose('aws-bedrock', 'off');
    await send('m-off', 'And the tablecloths?');
    const off = seen.at(-1)!;
    expect(off.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(off).not.toHaveProperty('prompt_cache_key');
    expect(JSON.stringify(off)).not.toContain('prompt_cache_breakpoint');
    expect(lastContext().cache).toEqual({
      support: 'automatic-prefix',
      policy: 'off',
      offVerified: false,
      marked: null,
      note: 'Caching is set to off. No route check on this connection has confirmed it yet.',
    });

    await choose('aws-bedrock', 'provider-default');
    await send('m-default', 'Was the invoice right?');
    const plain = seen.at(-1)!;
    expect(JSON.stringify(plain)).not.toMatch(/prompt_cache_/);
    expect(typeof (plain.input as Item[])[0].content).toBe('string');
    expect(lastContext().cache).toEqual({
      support: 'automatic-prefix',
      policy: 'provider-default',
      offVerified: null,
      marked: null,
      note: 'Caching is left to the provider’s default. No cache directive is sent.',
    });
    expect(JSON.stringify(seen)).not.toContain(AWS_KEY);
  });
});
