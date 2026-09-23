/**
 * The Azure OpenAI and OpenRouter setup routes over HTTP, driven by exactly the
 * bodies AI setup's cards build (`client/provider-setup-view.ts`). The real app,
 * store and protected-storage seam; the provider transport is a fake that fails
 * the test if anything ever reaches it, so connect, check, limit and disconnect
 * are proven to send nothing to a provider. No real key exists.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { testOnlySecretBox, type SecretBox } from '../server/connection-secrets';
import type { AzureConnectionView, ModelApiReadiness, OpenRouterConnectionView } from '../shared/model-api';
import type { Conversation, Project } from '../shared/types';
import { azureConnectBody, openRouterConnectBody } from '../client/provider-setup-view';
import { awsLimitBody } from '../client/aws-bedrock-view';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-provider-key-0123456789abcdef-never-real';
const prices = { input: '1.25', output: '10', cacheRead: '0.125', cacheWrite: '', source: 'Price page, read by the test owner' };

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let providerCalls: string[];

const transport = (async (input: RequestInfo | URL) => {
  providerCalls.push(String(input));
  throw new Error('A setup route reached the provider transport.');
}) as typeof globalThis.fetch;

async function open(secretBox: SecretBox | null = testOnlySecretBox()) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox,
    modelApiTransport: transport,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  server = undefined;
}
async function call(route: string, method = 'GET', body?: unknown, extra: Record<string, string> = headers) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: extra,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}
async function ok<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const { status, text } = await call(route, method, body);
  expect([200, 201], `${route}: ${status} ${text}`).toContain(status);
  expect(text).not.toContain(SECRET);
  return JSON.parse(text) as T;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-provider-setup-'));
  providerCalls = [];
  await open();
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
  expect(providerCalls).toEqual([]);
});

const azureBody = () => {
  const parsed = azureConnectBody({
    resourceName: 'contoso-ai',
    deployments: [
      { model: 'gpt-5.6-luna', deployment: 'luna-prod-eastus2', reasoning: true, rates: prices },
      { model: 'gpt-4.1-mini', deployment: 'mini-chat', reasoning: false, rates: { ...prices, cacheRead: '' } },
    ],
    apiKey: SECRET,
    expiresLocal: '',
    consent: true,
  });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.body;
};
const openRouterBody = () => {
  const parsed = openRouterConnectBody({
    models: [{ id: 'vendor/model-a', upstreams: 'upstream-one, upstream-two', rates: prices }],
    apiKey: SECRET,
    expiresLocal: '',
    consent: true,
  });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.body;
};

describe('Azure OpenAI setup, from the card to the host and back', () => {
  test('connect, check, approve a limit and disconnect: the key is never returned or stored in plain', async () => {
    const before = await ok<AzureConnectionView>('/ai/model-api/azure-openai');
    expect(before).toMatchObject({ configured: false, protectedStorage: true, connection: null });

    const connected = await ok<AzureConnectionView>('/ai/model-api/azure-openai', 'PUT', azureBody());
    expect(connected.enabled).toBe(true);
    expect(connected.connection?.deployments.map((entry) => entry.deployment)).toEqual(['luna-prod-eastus2', 'mini-chat']);
    expect(connected.connection?.deployments[0].rates.input).toBe(1_250_000);
    expect(connected.next).toMatch(/spend limit/);

    // The check runs only when asked and reports on what is saved; nothing is sent.
    const check = await ok<ModelApiReadiness>('/ai/model-api/azure-openai/test', 'POST', {});
    expect(check).toMatchObject({ route: 'azure-openai', sent: false, ready: false });
    expect(check.checks.find((entry) => entry.id === 'credential')?.ok).toBe(true);
    expect(check.checks.find((entry) => entry.id === 'spend-limit')?.ok).toBe(false);

    const limit = awsLimitBody('2.50', true);
    if (!limit.ok) throw new Error(limit.message);
    const limited = await ok<AzureConnectionView>('/ai/model-api/azure-openai/spend-limit', 'PUT', limit.body);
    expect(limited.spend?.capMicroUsd).toBe(2_500_000);
    expect(limited.next).toBeNull();
    expect((await ok<ModelApiReadiness>('/ai/model-api/azure-openai/test', 'POST', {})).ready).toBe(true);

    // Nothing the host wrote holds the key in plain text.
    const dataDir = path.join(root, 'data');
    for (const file of await fs.readdir(dataDir, { recursive: true })) {
      const full = path.join(dataDir, String(file));
      if (!(await fs.stat(full)).isFile()) continue;
      expect((await fs.readFile(full)).includes(Buffer.from(SECRET)), String(file)).toBe(false);
    }

    const gone = await ok<AzureConnectionView>('/ai/model-api/azure-openai', 'DELETE');
    expect(gone).toMatchObject({ configured: false, enabled: false, connection: null });
  });

  test('the host refuses a bad name in its own words, before any key is stored', async () => {
    const body = { ...azureBody(), resourceName: 'Not A Resource' };
    const refused = await call('/ai/model-api/azure-openai', 'PUT', body);
    expect(refused.status).toBe(400);
    expect(refused.text).toContain('resource name');
    expect(refused.text).not.toContain(SECRET);
    expect((await ok<AzureConnectionView>('/ai/model-api/azure-openai')).connection).toBeNull();
  });

  test('a write without the client header is refused', async () => {
    const refused = await call('/ai/model-api/azure-openai', 'PUT', azureBody(), { 'Content-Type': 'application/json' });
    expect(refused.status).toBe(403);
  });
});

describe('a thread on a connected Azure route', () => {
  test('takes the route with no pin and runs the saved default model; a pinned model is refused', async () => {
    await ok('/ai/model-api/azure-openai', 'PUT', azureBody());
    const project = await ok<Project>('/projects', 'POST', { name: 'Harbor cafe' });
    const thread = await ok<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
    // What the picker sends: the route, and no model, exactly as it does for AWS.
    const moved = await ok<Conversation>(`/projects/${project.id}/threads/${thread.id}`, 'PUT', {
      engine: 'azure-openai',
      requested: null,
    });
    expect(moved.engine).toBe('azure-openai');
    const next = await ok<{ route: string; resolution: { outcome: string; model: string | null } }>(
      `/projects/${project.id}/threads/${thread.id}/work-style`,
    );
    expect(next.route).toBe('azure-openai');
    expect(next.resolution).toMatchObject({ outcome: 'run', model: 'gpt-5.6-luna' });
    // Why the picker does not pin: the host checks a pin against engine catalogues, which list
    // nothing for a company-account route.
    const pinned = await call(`/projects/${project.id}/threads/${thread.id}`, 'PUT', {
      engine: 'azure-openai',
      requested: { model: 'gpt-4.1-mini', effort: null },
    });
    expect(pinned.status).toBe(400);
  });
});

describe('the owner’s tier map sends each tier to its mapped Azure or OpenRouter model', () => {
  type Next = { route: string; resolution: { outcome: string; model: string | null; effort: string | null; reason: string } };
  const styled = async (project: Project, thread: Conversation, workStyle: string) => {
    await ok<Conversation>(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { workStyle });
    return ok<Next>(`/projects/${project.id}/threads/${thread.id}/work-style`);
  };
  /** The owner's map, saved beside whatever the routes' own setup already wrote. */
  const mapTiers = async (entries: Record<string, string>) => {
    const settings = await ok<{ services?: Record<string, unknown> }>('/settings');
    await ok('/settings', 'PUT', { services: { ...settings.services, ...entries } });
  };

  test('Focused and Efficient each run the deployment the owner mapped, with a level, whatever route the thread was on', async () => {
    const parsed = azureConnectBody({
      resourceName: 'contoso-ai',
      deployments: [
        { model: 'gpt-6-luna', deployment: 'luna-prod', reasoning: true, rates: prices },
        { model: 'gpt-6-sol', deployment: 'sol-prod', reasoning: true, rates: prices },
      ],
      apiKey: SECRET,
      expiresLocal: '',
      consent: true,
    });
    if (!parsed.ok) throw new Error(parsed.message);
    await ok('/ai/model-api/azure-openai', 'PUT', parsed.body);
    await mapTiers({
      focusedRoute: 'azure-openai',
      focusedModel: 'gpt-6-sol',
      efficientRoute: 'azure-openai',
      efficientModel: 'gpt-6-luna',
    });
    const project = await ok<Project>('/projects', 'POST', { name: 'Harbor cafe' });
    const thread = await ok<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
    const focused = await styled(project, thread, 'focused');
    expect(focused.route).toBe('azure-openai');
    expect(focused.resolution).toMatchObject({ outcome: 'run', model: 'gpt-6-sol' });
    expect(focused.resolution.effort).not.toBeNull();
    const efficient = await styled(project, thread, 'efficient');
    expect(efficient.resolution).toMatchObject({ outcome: 'run', model: 'gpt-6-luna' });
  });

  test('an OpenRouter model is mapped with no level, since the route sends none', async () => {
    const parsed = openRouterConnectBody({
      models: [{ id: 'vendor/gpt-6-luna', upstreams: 'upstream-one', rates: prices }],
      apiKey: SECRET,
      expiresLocal: '',
      consent: true,
    });
    if (!parsed.ok) throw new Error(parsed.message);
    await ok('/ai/model-api/openrouter', 'PUT', parsed.body);
    await mapTiers({ efficientRoute: 'openrouter', efficientModel: 'vendor/gpt-6-luna' });
    const project = await ok<Project>('/projects', 'POST', { name: 'Harbor cafe' });
    const thread = await ok<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
    const efficient = await styled(project, thread, 'efficient');
    expect(efficient).toMatchObject({ route: 'openrouter', resolution: { outcome: 'run', model: 'vendor/gpt-6-luna', effort: null } });
  });

  test('the host refuses a tier mapped to anything but a company account, or a malformed model id', async () => {
    const settings = await ok<{ services?: Record<string, unknown> }>('/settings');
    for (const [key, value] of [
      ['focusedRoute', 'codex'],
      ['focusedRoute', 'google-vertex-typo'],
      ['thoroughModel', 'has spaces'],
      ['ownerPinRoute', 'sample'],
    ] as const) {
      const refused = await call('/settings', 'PUT', { services: { ...settings.services, [key]: value } });
      expect(refused.status, `${key}=${value}`).toBe(400);
    }
    expect((await ok<{ services?: Record<string, unknown> }>('/settings')).services).toEqual(settings.services);
  });

  test('a model the mapped route does not offer is a refusal that names it, not another model', async () => {
    const parsed = openRouterConnectBody({
      models: [{ id: 'vendor/gpt-6-luna', upstreams: 'upstream-one', rates: prices }],
      apiKey: SECRET,
      expiresLocal: '',
      consent: true,
    });
    if (!parsed.ok) throw new Error(parsed.message);
    await ok('/ai/model-api/openrouter', 'PUT', parsed.body);
    await mapTiers({ thoroughRoute: 'openrouter', thoroughModel: 'vendor/gpt-6-sol' });
    const project = await ok<Project>('/projects', 'POST', { name: 'Harbor cafe' });
    const thread = await ok<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
    const thorough = await styled(project, thread, 'thorough');
    expect(thorough.resolution.outcome).toBe('ask');
    expect(thorough.resolution.reason).toContain('vendor/gpt-6-sol');
    expect(thorough.resolution.reason).toContain('OpenRouter');
  });
});

describe('OpenRouter setup, from the card to the host and back', () => {
  test('connect keeps the allow-list, refuses data collection and fallbacks, and never returns the key', async () => {
    const connected = await ok<OpenRouterConnectionView>('/ai/model-api/openrouter', 'PUT', openRouterBody());
    expect(connected.connection).toMatchObject({
      models: [{ id: 'vendor/model-a', upstreams: ['upstream-one', 'upstream-two'] }],
      dataCollection: 'deny',
      allowFallbacks: false,
    });
    const check = await ok<ModelApiReadiness>('/ai/model-api/openrouter/test', 'POST', {});
    expect(check.sent).toBe(false);
    // Each route keeps its own connection: OpenRouter's key is not Azure's.
    expect((await ok<AzureConnectionView>('/ai/model-api/azure-openai')).connection).toBeNull();
    await ok('/ai/model-api/openrouter', 'DELETE');
  });

  test('a desktop-less process saves nothing', async () => {
    await close();
    await open(null);
    const refused = await call('/ai/model-api/openrouter', 'PUT', openRouterBody());
    expect(refused.status).toBe(409);
    expect(refused.text).not.toContain(SECRET);
  });
});
