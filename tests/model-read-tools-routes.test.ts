/**
 * Ask and Plan read tools on the three model-API routes, through the real host:
 * setup over HTTP, the real Store, RunService, model-session driver, NativeAgent
 * loop and EngineService activity wrapping. The provider network under the AI
 * SDK is a captured fake that answers each request from what it carries, the
 * page transport and resolver are injected fakes, and the approved connector is
 * an in-memory MCP server. Nothing reaches a provider, a web page or a real
 * connector, and nothing is spent.
 *
 * What this proves is the host's half: which tools are offered, that the host
 * runs them inside the boundary, and what the person sees. It does not prove a
 * live provider accepts these tool descriptors or calls them well.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { AzureConnections } from '../server/engines/azure-openai';
import { OpenRouterConnections } from '../server/engines/openrouter';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import type { ReadScope } from '../server/engines/read-scope';
import { testOnlySecretBox } from '../server/connection-secrets';
import { FileModelTranscripts } from '../server/harness/model-transcripts';
import { modelApiDispatchAuthorizer, modelSessionRunId } from '../server/harness/model-session-run';
import type { HarnessRun } from '../shared/harness';
import type { PageRequest, PageResolve } from '../server/harness/capabilities/page-fetch';
import type { Store } from '../server/store';
import type { TextRequest } from '../server/engines/contract';
import type { ToolActivity } from '../shared/adapter-contract';
import type { AwsConnectionView, AzureConnectionView, OpenRouterConnectionView } from '../shared/model-api';
import type { Conversation, Project } from '../shared/types';
import { chatEvents, responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const AZURE_KEY = 'test-only-azure-key-0123456789abcdef-never-real';
const OPENROUTER_KEY = 'sk-or-test-only-0123456789abcdef-never-real';
const AWS_KEY = 'test-only-bedrock-key-0123456789abcdef-never-real';
const OR_MODEL = 'anthropic/claude-sonnet-4.5';
const rates = { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cacheReadUsdPerMillion: null, cacheWriteUsdPerMillion: null, source: 'the provider price page, read by the test owner' };
const READ_NOTE = 'Read-only tools for this message';

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;
let folder: string;

type Item = Record<string, unknown>;
interface Seen {
  url: string;
  body: Item;
}
let seen: Seen[];
/** The tool calls the fake model makes, in order, before it answers from the last result. */
let plan: { name: string; args: unknown }[];
/** What the fake model was shown after each tool call. */
let observed: string[];

const toolNames = (body: Item) =>
  ((body.tools ?? []) as Item[]).map((tool) => String(tool.name ?? (tool.function as Item | undefined)?.name)).sort();

/** One captured network for all three providers, answering from what each request carries. */
const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body)) as Item;
  seen.push({ url, body });
  if (url.startsWith('https://openrouter.ai/')) {
    const results = ((body.messages ?? []) as Item[]).filter((message) => message.role === 'tool');
    if (results.length) observed.push(String(results.at(-1)!.content));
    const next = plan[results.length];
    if (next)
      return sseResponse(
        chatEvents({
          model: OR_MODEL,
          provider: 'Anthropic',
          text: '',
          toolCalls: [{ id: `call_or_${results.length + 1}`, name: next.name, arguments: JSON.stringify(next.args) }],
          usage: { prompt_tokens: 600, completion_tokens: 30, total_tokens: 630, is_byok: false },
        }),
      );
    return sseResponse(
      chatEvents({ model: OR_MODEL, provider: 'Anthropic', text: `answer: ${observed.at(-1) ?? 'none'}`.slice(0, 400), usage: { prompt_tokens: 700, completion_tokens: 40, total_tokens: 740, is_byok: false } }),
    );
  }
  const azure = url.includes('.openai.azure.com/');
  if (azure || url.startsWith('https://bedrock-runtime.')) {
    const results = ((body.input ?? []) as Item[]).filter((item) => item.type === 'function_call_output');
    if (results.length) observed.push(String(results.at(-1)!.output));
    const next = plan[results.length];
    const output: Item[] = next
      ? [{ type: 'function_call', id: `fc_${seen.length}`, call_id: `call_${results.length + 1}`, name: next.name, arguments: JSON.stringify(next.args), status: 'completed' }]
      : [{ type: 'message', id: `msg_${seen.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `answer: ${observed.at(-1) ?? 'none'}`.slice(0, 400), annotations: [] }] }];
    return sseResponse(
      responsesEvents({
        id: `resp_${seen.length}`,
        object: 'response',
        created_at: 1_790_000_000,
        status: 'completed',
        model: azure ? 'gpt-5.6-luna-2026-09-01' : AWS_LUNA_MODEL,
        output,
        usage: { input_tokens: 500, output_tokens: 60, total_tokens: 560 },
        incomplete_details: null,
        error: null,
      }),
      azure ? { 'apim-request-id': `apim-${seen.length}` } : { 'x-amzn-requestid': `req-${seen.length}` },
    );
  }
  throw new Error(`A request reached a provider this test never expects: ${url}`);
}) as typeof globalThis.fetch;

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
const store = () => app.locals.store as Store;

// --- the approved connector, in memory ------------------------------------------------

let connectorCalls: string[];
let connectorClosed: number;
let slowEntered: (() => void) | null;
function posTransport() {
  const pos = new McpServer({ name: 'pos', version: '1' });
  pos.registerTool('list_orders', { description: 'Recent orders', inputSchema: { limit: z.number().optional() } }, async () => {
    connectorCalls.push('list_orders');
    return { content: [{ type: 'text', text: 'Order 1182: 12 tomato soups' }] };
  });
  pos.registerTool('void_order', { description: 'Voids an order', inputSchema: { id: z.string() } }, async () => {
    connectorCalls.push('void_order');
    return { content: [{ type: 'text', text: 'voided' }] };
  });
  pos.registerTool('slow_orders', { description: 'Never answers' }, async () => {
    connectorCalls.push('slow_orders');
    slowEntered?.();
    return new Promise<never>(() => undefined);
  });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  serverSide.onclose = () => void (connectorClosed += 1);
  void pos.connect(serverSide);
  return client;
}

// --- the page network, faked ------------------------------------------------------------

let pageRequests: string[];
let resolved: string[];
const resolve: PageResolve = async (host) => {
  resolved.push(host);
  if (host === 'metadata.example.com') return [{ address: '169.254.169.254', family: 4 }];
  return [{ address: '93.184.215.14', family: 4 }];
};
const request: PageRequest = async ({ url }) => {
  pageRequests.push(url.toString());
  return {
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: (async function* () {
      yield Buffer.from('<html><title>Specials</title><body><p>Soup of the day: tomato</p></body></html>');
    })(),
    cancel: () => undefined,
  };
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-read-routes-'));
  seen = [];
  plan = [];
  observed = [];
  connectorCalls = [];
  connectorClosed = 0;
  slowEntered = null;
  pageRequests = [];
  resolved = [];
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
  service.modelApi!.azure = {
    connections: new AzureConnections(dataDir),
    transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-azure-openai'), 'azure-openai'),
  };
  service.modelApi!.openrouter = {
    connections: new OpenRouterConnections(dataDir),
    transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-openrouter'), 'openrouter'),
  };
  service.modelApi!.readTools = { resolve, request, mcpTransport: posTransport };
  server = await new Promise<Server>((done) => {
    const listener = app.listen(0, '127.0.0.1', () => done(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  project = await api<Project>('/projects', 'POST', { name: 'Lunch service' });
  folder = store().state(project.id).project.folder;
  await fs.mkdir(path.join(folder, 'notes'), { recursive: true });
  await fs.writeFile(path.join(folder, 'notes', 'menu.md'), '# Lunch\n\nTomato soup and a grilled cheese sandwich.\n');
  await fs.writeFile(path.join(root, 'outside.txt'), 'a secret outside the project\n');
});
afterEach(async () => {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server!.close((error) => (error ? reject(error) : done())));
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true });
});

const connectAws = async () => {
  const view = await api<AwsConnectionView>('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey: AWS_KEY,
    expiresAt: null,
    consent: true,
  });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  return view.connection!.accountRoute;
};
const connectAzure = async () => {
  const view = await api<AzureConnectionView>('/ai/model-api/azure-openai', 'PUT', {
    resourceName: 'contoso-ai',
    deployments: [{ model: 'gpt-5.6-luna', deployment: 'luna-prod', reasoning: true, rates }],
    apiKey: AZURE_KEY,
    expiresAt: null,
    consent: true,
  });
  await api('/ai/model-api/azure-openai/spend-limit', 'PUT', { capUsd: 1, consent: true });
  return view.connection!.accountRoute;
};
const connectOpenRouter = async () => {
  const view = await api<OpenRouterConnectionView>('/ai/model-api/openrouter', 'PUT', {
    models: [{ id: OR_MODEL, upstreams: ['anthropic'], rates }],
    apiKey: OPENROUTER_KEY,
    expiresAt: null,
    consent: true,
  });
  await api('/ai/model-api/openrouter/spend-limit', 'PUT', { capUsd: 1, consent: true });
  return view.connection!.accountRoute;
};

const pos = { name: 'pos', command: 'pos-server', args: [], envFrom: ['POS_TOKEN'], readTools: ['list_orders', 'slow_orders'] };
const scope = (extra: Partial<ReadScope> = {}): ReadScope => ({ root: folder, web: true, ...extra });

function turnInput(
  overrides: Partial<TextRequest> & Pick<TextRequest, 'model' | 'accountRoute'>,
  activity: ToolActivity[],
): TextRequest {
  return {
    projectId: project.id,
    threadId: 'thread-1',
    requestId: `cmd-${Math.random().toString(36).slice(2)}`,
    prompt: 'What is for lunch?',
    documents: [],
    instructions: 'You are Diomedes.',
    onActivity: (frame) => activity.push(frame),
    ...overrides,
  };
}
const turn = (route: 'aws-bedrock' | 'azure-openai' | 'openrouter', input: TextRequest) =>
  service.modelSession(route, 'start', modelSessionRunId(project.id, input.requestId), input);
const frames = (activity: ToolActivity[]) => activity.map((frame) => [frame.phase, frame.tool, frame.summary]);

describe('a read tool round trip on each model-API route', () => {
  test('AWS Bedrock: read_file runs on the host, inside the project, and each call reads as one sentence', async () => {
    const accountRoute = await connectAws();
    plan = [{ name: 'read_file', args: { path: 'notes/menu.md' } }];
    const activity: ToolActivity[] = [];
    const input = turnInput({ model: AWS_LUNA_MODEL, accountRoute, readScope: scope() }, activity);
    const result = await turn('aws-bedrock', input);

    expect(result.response?.text).toContain('Tomato soup and a grilled cheese');
    expect(seen).toHaveLength(2);
    expect(toolNames(seen[0].body)).toEqual(['fetch_page', 'list_files', 'list_sources', 'read_file', 'read_source', 'search_files']);
    expect(JSON.stringify(seen[0].body)).toContain(READ_NOTE);
    // The project's absolute location is never sent to the provider.
    expect(JSON.stringify(seen[0].body)).not.toContain(folder.replaceAll('\\', '\\\\'));
    expect(frames(activity)).toEqual([
      ['started', 'read_file', 'Reading notes/menu.md'],
      ['finished', 'read_file', 'Read notes/menu.md'],
    ]);
    expect(activity[0].callId).toBe(activity[1].callId);
    for (const frame of activity) expect(frame).toMatchObject({ projectId: project.id, requestId: input.requestId });

    // The read is a recorded local tool step in the turn's child run, with what the turn could read.
    const child = await app.locals.harness.modelSessions.turnRun(project.id, result.runId, input.requestId);
    const step = child.steps.find((entry: { intent: { stepId: string } }) => entry.intent.stepId === 'tool:0');
    expect(step.intent).toMatchObject({ kind: 'tool', name: 'read_file', effect: 'read', destination: 'local' });
    expect(child.input.read).toMatchObject({ files: true, web: true, connectors: [] });
    expect(JSON.stringify(child.input)).not.toContain(folder.replaceAll('\\', '\\\\'));
    expect(service.modelApi!.exposure.list('aws-bedrock-1').map((hold) => hold.state)).toEqual(['settled', 'settled']);
  });

  test('Azure OpenAI: list_files through the Responses API', async () => {
    const accountRoute = await connectAzure();
    plan = [{ name: 'list_files', args: { path: 'notes' } }];
    const activity: ToolActivity[] = [];
    const result = await turn('azure-openai', turnInput({ model: 'gpt-5.6-luna', accountRoute, readScope: scope({ web: false }) }, activity));
    expect(result.response?.text).toContain('notes/menu.md');
    expect(seen.every((entry) => entry.url === 'https://contoso-ai.openai.azure.com/openai/v1/responses')).toBe(true);
    expect(toolNames(seen[0].body)).toEqual(['list_files', 'list_sources', 'read_file', 'read_source', 'search_files']);
    expect(frames(activity)).toEqual([
      ['started', 'list_files', 'Listing files in notes'],
      ['finished', 'list_files', 'Listed 1 entry in notes'],
    ]);
  });

  test('OpenRouter: search_files through chat completions', async () => {
    const accountRoute = await connectOpenRouter();
    plan = [{ name: 'search_files', args: { query: 'grilled cheese' } }];
    const activity: ToolActivity[] = [];
    const result = await turn('openrouter', turnInput({ model: OR_MODEL, accountRoute, readScope: scope() }, activity));
    expect(result.response?.text).toContain('notes/menu.md');
    expect(toolNames(seen[0].body)).toContain('search_files');
    expect(seen[0].body.plugins).toBeUndefined();
    expect(frames(activity)).toEqual([
      ['started', 'search_files', 'Searching project files for grilled cheese'],
      ['finished', 'search_files', 'Found 1 match for grilled cheese'],
    ]);
  });
});

describe('the boundary holds, and a refusal does not end the turn', () => {
  test('a path outside the project is refused; the model reads the refusal and still answers', async () => {
    const accountRoute = await connectAws();
    plan = [{ name: 'read_file', args: { path: '../../outside.txt' } }];
    const activity: ToolActivity[] = [];
    const result = await turn('aws-bedrock', turnInput({ model: AWS_LUNA_MODEL, accountRoute, readScope: scope() }, activity));
    expect(result.response?.text).toContain('outside the project folder');
    expect(result.response?.text).not.toContain('a secret');
    expect(observed.join('')).not.toContain('a secret outside');
    expect(activity.map((frame) => frame.phase)).toEqual(['started', 'failed']);
    expect(activity[1].summary).toMatch(/^Not read: That path is outside the project folder/);
  });

  test('an unapproved connector tool is refused before any connector is started; an approved one answers', async () => {
    const accountRoute = await connectAws();
    plan = [
      { name: 'connector_read', args: { server: 'pos', tool: 'void_order', arguments: { id: '1182' } } },
      { name: 'connector_read', args: { server: 'pos', tool: 'list_orders' } },
    ];
    const activity: ToolActivity[] = [];
    const result = await turn('aws-bedrock', turnInput({ model: AWS_LUNA_MODEL, accountRoute, readScope: scope({ mcp: [pos] }) }, activity));
    expect(observed[0]).toContain('not an approved read tool');
    expect(result.response?.text).toContain('Order 1182: 12 tomato soups');
    expect(connectorCalls).toEqual(['list_orders']);
    expect(frames(activity)).toEqual([
      ['started', 'connector_read', 'Reading from pos (void_order)'],
      ['failed', 'connector_read', 'Not read: pos (void_order) is not an approved read tool. Only the tools the owner approved can be called.'],
      ['started', 'connector_read', 'Reading from pos (list_orders)'],
      ['finished', 'connector_read', 'Read from pos (list_orders)'],
    ]);
    // The connector's process ends with the turn.
    expect(connectorClosed).toBe(1);
    expect(JSON.stringify(seen[0].body)).toContain('pos: list_orders, slow_orders');
  });

  test('a page on a private address is refused before any request; a public page is read as text', async () => {
    const accountRoute = await connectOpenRouter();
    plan = [
      { name: 'fetch_page', args: { url: 'http://169.254.169.254/latest/meta-data/' } },
      { name: 'fetch_page', args: { url: 'https://metadata.example.com/' } },
      { name: 'fetch_page', args: { url: 'https://example.com/specials' } },
    ];
    const activity: ToolActivity[] = [];
    const result = await turn('openrouter', turnInput({ model: OR_MODEL, accountRoute, readScope: scope() }, activity));
    expect(pageRequests).toEqual(['https://example.com/specials']);
    expect(resolved).toEqual(['metadata.example.com', 'example.com']);
    expect(result.response?.text).toContain('Soup of the day: tomato');
    expect(activity.map((frame) => frame.phase)).toEqual(['started', 'failed', 'started', 'failed', 'started', 'finished']);
    expect(activity[5].summary).toBe('Opened https://example.com/specials');
  });

  test('Stop during a connector call ends the turn as interrupted and closes the connector', async () => {
    const accountRoute = await connectAws();
    plan = [{ name: 'connector_read', args: { server: 'pos', tool: 'slow_orders' } }];
    const controller = new AbortController();
    slowEntered = () => controller.abort(new Error('stopped by the person'));
    const activity: ToolActivity[] = [];
    const input = turnInput({ model: AWS_LUNA_MODEL, accountRoute, readScope: scope({ mcp: [pos] }), signal: controller.signal }, activity);
    const result = await turn('aws-bedrock', input);
    expect(result).toMatchObject({ response: null, interrupted: true });
    expect(connectorCalls).toEqual(['slow_orders']);
    expect(connectorClosed).toBe(1);
    // The model was asked once; nothing was sent after the stop.
    expect(seen).toHaveLength(1);
    // The fenced activity channel publishes nothing after a stop (service.ts `fencedSinks`), so the
    // person sees the call start and the turn end; the child run records how the read ended.
    expect(frames(activity)).toEqual([['started', 'connector_read', 'Reading from pos (slow_orders)']]);
    // The failed read is a failed local step, never a model call parked for reconciliation.
    const child = await app.locals.harness.modelSessions.turnRun(project.id, result.runId, input.requestId);
    expect(child.state).toBe('failed');
    expect(child.steps.find((entry: { intent: { stepId: string } }) => entry.intent.stepId === 'tool:0').state).toBe('retry_wait');
    expect(service.modelApi!.exposure.list('aws-bedrock-1').map((hold) => hold.state)).toEqual(['settled']);
  });
});

describe('no read tools outside Ask and Plan', () => {
  test('a turn without a scope (Automatic) is offered only the attached-source tools', async () => {
    const accountRoute = await connectAws();
    const activity: ToolActivity[] = [];
    await turn('aws-bedrock', turnInput({ model: AWS_LUNA_MODEL, accountRoute }, activity));
    expect(toolNames(seen[0].body)).toEqual(['list_sources', 'read_source']);
    expect(JSON.stringify(seen[0].body)).not.toContain(READ_NOTE);
  });

  test('a Work (Build/Fix) call offers no tools even if a scope were attached', async () => {
    const accountRoute = await connectAws();
    const activity: ToolActivity[] = [];
    await service.generateModelApi('aws-bedrock', turnInput({ model: AWS_LUNA_MODEL, accountRoute, readScope: scope({ mcp: [pos] }) }, activity));
    expect(seen).toHaveLength(1);
    expect(seen[0].body.tools).toBeUndefined();
    expect(connectorCalls).toEqual([]);
  });

  test('through the conversation route: Ask carries the project, web and approved-connector tools; Automatic does not', async () => {
    await connectAws();
    await fs.writeFile(
      path.join(store().dataDir, 'read-connectors.json'),
      JSON.stringify({ version: 1, servers: [{ ...pos, approved: true, transport: 'stdio' }] }),
    );
    const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
    await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
    const send = (commandId: string, mode: string) =>
      api(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', { commandId, text: 'What is for lunch?', mode, sources: [], consent: true });

    plan = [{ name: 'connector_read', args: { server: 'pos', tool: 'list_orders' } }];
    await send('ask-1', 'ask');
    expect(toolNames(seen[0].body)).toEqual(['connector_read', 'fetch_page', 'list_files', 'list_sources', 'read_file', 'read_source', 'search_files']);
    expect(connectorCalls).toEqual(['list_orders']);

    const before = seen.length;
    plan = [];
    await send('auto-1', 'auto');
    expect(toolNames(seen[before].body)).toEqual(['list_sources', 'read_source']);
  });
});

// --- egress for a read tool step ---------------------------------------------------

describe('the egress check for a read tool that leaves this computer', () => {
  const authorize = modelApiDispatchAuthorizer(() => ({ 'aws-bedrock': true, 'aws-bedrockAccountRoute': 'aws-bedrock:aws-bedrock-1@r1' }));
  const turnRun = (read: unknown, tools: string[]) =>
    ({
      capabilityId: 'model-api-turn',
      capabilityTools: tools,
      input: { route: 'aws-bedrock', accountRoute: 'aws-bedrock:aws-bedrock-1@r1', ...(read ? { read } : {}) },
    }) as unknown as HarnessRun;
  const step = (name: string) => ({ destination: 'external', kind: 'tool', name });

  test('a page or connector step passes only on a turn whose recorded scope allowed it', async () => {
    const allowed = turnRun({ web: true, connectors: [{ name: 'pos' }] }, ['read_source', 'fetch_page', 'connector_read']);
    await expect(authorize(allowed, step('fetch_page'), 'dispatch')).resolves.toBeUndefined();
    await expect(authorize(allowed, step('connector_read'), 'dispatch')).resolves.toBeUndefined();
    await expect(authorize(turnRun({ web: false, connectors: [] }, ['fetch_page', 'connector_read']), step('fetch_page'), 'dispatch')).rejects.toMatchObject({
      code: 'egress_denied',
    });
    await expect(authorize(turnRun({ web: true, connectors: [] }, ['fetch_page', 'connector_read']), step('connector_read'), 'dispatch')).rejects.toMatchObject({
      code: 'egress_denied',
    });
    await expect(authorize(turnRun(null, ['fetch_page']), step('fetch_page'), 'dispatch')).rejects.toMatchObject({ code: 'egress_denied' });
    await expect(authorize(turnRun({ web: true }, ['read_source']), step('fetch_page'), 'dispatch')).rejects.toMatchObject({ code: 'egress_denied' });
    // A local read and the model step itself are unchanged.
    await expect(authorize(turnRun(null, []), { destination: 'local', kind: 'tool', name: 'read_file' }, 'dispatch')).resolves.toBeUndefined();
    await expect(authorize(turnRun(null, []), { destination: 'external', kind: 'model', name: 'aws-bedrock' }, 'dispatch')).resolves.toBeUndefined();
  });
});
