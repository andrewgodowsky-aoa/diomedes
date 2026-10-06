/** Azure reasoning through the real host and SDK, using only a synthetic transport and key. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import type { TextRequest } from '../server/engines/contract';
import { testOnlySecretBox } from '../server/connection-secrets';
import { modelSessionRunId } from '../server/harness/model-session-run';
import { ToolRegistry } from '../server/harness/tools';
import type { HarnessHost } from '../server/harness/host';
import type { AzureConnectionView } from '../shared/model-api';
import type { Conversation, Project } from '../shared/types';
import { TEAM_TOOL_NAMES } from '../shared/team-routes';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const MODEL = 'gpt-6.1-sol';
const SECRET = 'test-only-azure-key-0123456789abcdef-never-real';
const ENDPOINT = 'https://contoso-ai.services.ai.azure.com/openai/v1/responses';
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let service: EngineService;
let base: string;
let project: Project;
let seen: { model: string; reasoning?: { effort: string } }[];

const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  expect(String(input)).toBe(ENDPOINT);
  expect(new Headers(init?.headers).get('api-key')).toBe(SECRET);
  seen.push(JSON.parse(String(init?.body)) as (typeof seen)[number]);
  return sseResponse(responsesEvents({
    id: `resp_${seen.length}`, object: 'response', created_at: 1_790_000_000,
    status: 'completed', model: MODEL,
    output: [{ type: 'message', id: `msg_${seen.length}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'The synthetic check is complete.', annotations: [] }] }],
    usage: { input_tokens: 400, output_tokens: 60, total_tokens: 460 },
    incomplete_details: null, error: null,
  }), { 'apim-request-id': `synthetic-${seen.length}` });
}) as typeof globalThis.fetch;

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-azure-reasoning-'));
  seen = [];
  service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  app = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    engineService: service, reviewerAdapter: null, secretBox: testOnlySecretBox(), modelApiTransport: transport,
    ownerRoutes: true, accounts: null, observation: null, managedJev: false, automationTickMs: null });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  project = await api<Project>('/projects', 'POST', { name: 'Synthetic reasoning check' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', { expectedVersion: 0, routes: ['azure-openai'],
    documents: [], shareConversationHistory: true, shareReviewPackets: true });
});

afterEach(async () => {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

async function connect(xhigh: boolean) {
  const view = await api<AzureConnectionView>('/ai/model-api/azure-openai', 'PUT', {
    resourceName: 'contoso-ai', host: 'foundry',
    deployments: [{ model: MODEL, deployment: 'sol-prod', reasoning: true, xhigh,
      rates: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cacheReadUsdPerMillion: null,
        cacheWriteUsdPerMillion: null, source: 'Synthetic test prices, not live qualification' } }],
    apiKey: SECRET, expiresAt: null, consent: true,
  });
  await api('/ai/model-api/azure-openai/spend-limit', 'PUT', { capUsd: 10, consent: true });
  return view.connection!;
}

test.each(['conversation', 'work', 'team work'] as const)('%s preserves xhigh through EngineService', async (surface) => {
  const connection = await connect(true);
  const input: TextRequest = { projectId: project.id, threadId: 'synthetic-thread', requestId: 'synthetic-turn',
    model: MODEL, accountRoute: connection.accountRoute, effort: 'xhigh', documents: [],
    prompt: 'Complete the synthetic reasoning check.', instructions: 'Answer briefly.' };
  if (surface === 'conversation')
    await service.modelSession('azure-openai', 'start', modelSessionRunId(project.id, input.requestId), input);
  else if (surface === 'work') await service.generateModelApi('azure-openai', input);
  else {
    const registry = new ToolRegistry();
    for (const name of TEAM_TOOL_NAMES) registry.register({
      name, version: '1', description: 'Unused tool in the reasoning transport fixture.',
      effect: 'read', effectClass: 'read', permission: null, approval: false,
      destination: 'local', trustedInputRequired: false, cost: 1,
      schema: z.strictObject({}), outputSchema: z.null(),
      execute: async () => { throw new Error('The reasoning fixture must not invoke team tools.'); },
    });
    await service.generateModelApiTools('azure-openai', input, registry);
  }
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.map((body) => [body.model, body.reasoning?.effort])).toEqual(seen.map(() => ['sol-prod', 'xhigh']));
});

test.each([true, false])('Thorough Plan resolves and sends the offered effort (xhigh=%s)', async (xhigh) => {
  const connection = await connect(xhigh);
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { mode: 'plan', workStyle: 'thorough' });
  const next = await api<{ route: string; resolution: { model: string; effort: string; outcome: string } }>(
    `/projects/${project.id}/threads/${thread.id}/work-style`);
  const effort = xhigh ? 'xhigh' : 'high';
  expect(next).toMatchObject({ route: 'azure-openai', resolution: { outcome: 'run', model: MODEL, effort } });
  const input: TextRequest = { projectId: project.id, threadId: thread.id, requestId: 'plan-turn',
    model: next.resolution.model, accountRoute: connection.accountRoute,
    effort: next.resolution.effort, documents: [], prompt: 'Plan the synthetic check.', instructions: 'Answer briefly.' };
  await service.modelSession('azure-openai', 'start', modelSessionRunId(project.id, input.requestId), input);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.map((body) => body.reasoning?.effort)).toEqual(seen.map(() => effort));
});

test.each([true, false])('native work accepts Azure xhigh and respects the deployment cap (xhigh=%s)', async (xhigh) => {
  const connection = await connect(xhigh);
  const task = await api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', { name: 'Synthetic check' });
  const started = await api<{ runId: string }>(`/projects/${project.id}/loop/start`, 'POST', {
    protocolVersion: 1, commandId: 'native-xhigh', taskId: task.id, goal: 'Complete the synthetic check.',
    route: 'azure-openai', model: MODEL, accountRoute: connection.accountRoute, effort: 'xhigh',
    consent: true, sources: [], maxTurns: 2,
  });
  const harness = app.locals.harness as HarnessHost;
  await vi.waitFor(async () => expect((await harness.get(project.id, started.runId)).state).toBe('completed'), { timeout: 10_000 });
  expect((await harness.get(project.id, started.runId)).input).toMatchObject({ effort: 'xhigh' });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((body) => body.reasoning?.effort === (xhigh ? 'xhigh' : 'high'))).toBe(true);
});

test('native work keeps xhigh unavailable to non-Azure cloud routes', async () => {
  await expect(service.loopAdapter('aws-bedrock', { projectId: project.id, runId: 'aws-xhigh',
    model: 'us.moonshotai.kimi-k3', accountRoute: 'synthetic', instructions: 'Answer briefly.', effort: 'xhigh' },
  new AbortController().signal)).rejects.toMatchObject({ code: 'collaboration_refused' });
  expect(seen).toEqual([]);
});
