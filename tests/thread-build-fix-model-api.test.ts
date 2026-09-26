/**
 * Build and Fix from a thread on the three model-API routes (owner decision 2026-09-23:
 * threads allow Build and Fix on every connected route, reversing CD-01 Decision 5's
 * refusal of them for AWS Bedrock, Azure OpenAI and OpenRouter). Through the real host
 * over HTTP: the /ask route the Console's composer posts to, the real Store, Native Work,
 * EngineService, RunService text route, spend ledger, Need and recorded writer. Only the
 * network under the AI SDK is replaced, with captured-shape provider streams, so nothing
 * reaches a provider and nothing is spent.
 *
 * What this proves is the host's half: the route is admitted, the one guarded proposal
 * path runs, nothing is written before the exact approval, Fix keeps its rules, and the
 * record is attributed to the model the fake provider reported. It does not prove a live
 * provider returns a usable proposal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { testOnlySecretBox } from '../server/connection-secrets';
import type { Store } from '../server/store';
import type { AwsConnectionView, AzureConnectionView, ModelApiRoute, OpenRouterConnectionView } from '../shared/model-api';
import type { Conversation, Project, ProjectState, Session } from '../shared/types';
import { chatEvents, responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import { ROUTES as ALL_ROUTES } from '../shared/engines';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const AZURE_KEY = 'test-only-azure-key-0123456789abcdef-never-real';
const OPENROUTER_KEY = 'sk-or-test-only-0123456789abcdef-never-real';
const AWS_KEY = 'test-only-bedrock-key-0123456789abcdef-never-real';
const OR_MODEL = 'anthropic/claude-sonnet-4.5';
const AZURE_REPORTED = 'gpt-5.6-luna-2026-09-01';
const rates = { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cacheReadUsdPerMillion: null, cacheWriteUsdPerMillion: null, source: 'the provider price page, read by the test owner' };
const MENU = 'notes/menu.md';
const MENU_TEXT = '# Lunch\n\nTomato soup.\nTomato soup.\nGrilled cheese.\n';
const PLAN = 'Lunch plan.md';

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let project: Project;
let thread: Conversation;
let folder: string;

type Item = Record<string, unknown>;
let seen: { url: string; body: Item; raw: string }[];
let proposals: number;
/** What the fake model answers with: a proposal (default), prose, or a tool call. */
let reply: 'proposal' | 'prose' | 'tool' | 'large';

/** The proposal the fake model writes, from what the request carries. */
function proposalFor(raw: string): string {
  proposals += 1;
  if (raw.includes('Failing:'))
    return JSON.stringify({
      summary: `Remove the repeated soup (try ${proposals})`,
      changes: [{ path: MENU, text: `# Lunch\n\nTomato soup.\nGrilled cheese.\n<!-- try ${proposals} -->\n`, summary: 'The soup was listed twice.' }],
    });
  return JSON.stringify({
    summary: 'Draft the lunch plan',
    changes: [{ path: PLAN, text: `# Lunch plan (${proposals})\n\n1. Soup\n2. Sandwiches\n`, summary: 'A new plan.' }],
  });
}

/** One captured network for all three providers. */
const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const raw = String(init?.body);
  const body = JSON.parse(raw) as Item;
  seen.push({ url, body, raw });
  const text =
    reply === 'prose'
      ? 'I would rather talk this through first.'
      : reply === 'large'
        ? JSON.stringify({ summary: 'A long plan', changes: [{ path: PLAN, text: `# Long plan

${'Soup. '.repeat(18_000)}
`, summary: 'A long plan.' }] })
        : reply === 'proposal'
          ? proposalFor(raw)
          : '';
  // A provider may send a large answer as one delta; `large` does, to show Work still accepts it.
  const split = reply === 'large' ? 1_000_000 : undefined;
  if (url.startsWith('https://openrouter.ai/'))
    return sseResponse(
      chatEvents({
        model: OR_MODEL,
        provider: 'Anthropic',
        text,
        ...(split ? { split } : {}),
        ...(reply === 'tool' ? { toolCalls: [{ id: 'call_x', name: 'read_source', arguments: '{"path":"notes/menu.md"}' }] } : {}),
        usage: { prompt_tokens: 700, completion_tokens: 40, total_tokens: 740, is_byok: false },
      }),
    );
  const azure = url.includes('.openai.azure.com/');
  if (azure || url.startsWith('https://bedrock-runtime.')) {
    const output: Item[] =
      reply === 'tool'
        ? [{ type: 'function_call', id: `fc_${seen.length}`, call_id: 'call_x', name: 'read_source', arguments: '{"path":"notes/menu.md"}', status: 'completed' }]
        : [{ type: 'message', id: `msg_${seen.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }];
    return sseResponse(
      responsesEvents({
        id: `resp_${seen.length}`,
        object: 'response',
        created_at: 1_790_000_000,
        status: 'completed',
        model: azure ? AZURE_REPORTED : AWS_LUNA_MODEL,
        output,
        usage: { input_tokens: 500, output_tokens: 60, total_tokens: 560 },
        incomplete_details: null,
        error: null,
      }, split ? { split } : {}),
      azure ? { 'apim-request-id': `apim-${seen.length}` } : { 'x-amzn-requestid': `req-${seen.length}` },
    );
  }
  throw new Error(`A request reached a provider this test never expects: ${url}`);
}) as typeof globalThis.fetch;

async function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
const store = () => app.locals.store as Store;
const state = () => api<ProjectState>(`/projects/${project.id}/state`);
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}
const openNeed = () => until(state, (value) => value.needs.some((need) => need.state === 'open'), 'an open Need');
const idle = () =>
  until(state, (value) => !value.sessions.some((s) => ['queued', 'working', 'waiting'].includes(s.state)), 'the project to be idle');
async function resolveNeed(resolution: 'go-ahead' | 'declined') {
  const need = (await state()).needs.find((item) => item.state === 'open')!;
  return api(`/projects/${project.id}/needs/${need.id}/resolve`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    resolution,
    allowForTask: false,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  });
}

// The three routes this lane proved; Google Vertex AI and Nectovia arrived later with their own tests.
type TestedRoute = Exclude<ModelApiRoute, 'google-vertex' | 'nectovia'>;
const connect: Record<TestedRoute, () => Promise<string>> = {
  'aws-bedrock': async () => {
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
  },
  'azure-openai': async () => {
    const view = await api<AzureConnectionView>('/ai/model-api/azure-openai', 'PUT', {
      resourceName: 'contoso-ai',
      deployments: [{ model: 'gpt-5.6-luna', deployment: 'luna-prod', reasoning: true, rates }],
      apiKey: AZURE_KEY,
      expiresAt: null,
      consent: true,
    });
    await api('/ai/model-api/azure-openai/spend-limit', 'PUT', { capUsd: 1, consent: true });
    return view.connection!.accountRoute;
  },
  openrouter: async () => {
    const view = await api<OpenRouterConnectionView>('/ai/model-api/openrouter', 'PUT', {
      models: [{ id: OR_MODEL, upstreams: ['anthropic'], rates }],
      apiKey: OPENROUTER_KEY,
      expiresAt: null,
      consent: true,
    });
    await api('/ai/model-api/openrouter/spend-limit', 'PUT', { capUsd: 1, consent: true });
    return view.connection!.accountRoute;
  },
};
const REPORTED: Record<TestedRoute, string> = {
  'aws-bedrock': AWS_LUNA_MODEL,
  'azure-openai': AZURE_REPORTED,
  openrouter: OR_MODEL,
};
const HOSTS: Record<TestedRoute, string> = {
  'aws-bedrock': 'https://bedrock-runtime.us-east-1.amazonaws.com/',
  'azure-openai': 'https://contoso-ai.openai.azure.com/',
  openrouter: 'https://openrouter.ai/',
};

/** Connects the route and puts the thread on it through the same save the Console's picker uses. */
async function onRoute(route: TestedRoute) {
  const accountRoute = await connect[route]();
  const chosen = await api<Conversation>(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: route });
  expect(chosen.engine).toBe(route);
  return accountRoute;
}
const ask = (route: TestedRoute, body: Record<string, unknown>) =>
  request(`/projects/${project.id}/ask`, 'POST', {
    route,
    threadId: thread.id,
    attachedTo: thread.attachedTo,
    consent: true,
    ...body,
  });
const build = (route: TestedRoute) => ask(route, { mode: 'build', text: 'Draft a lunch plan', sources: [] });
const fix = (route: TestedRoute) =>
  ask(route, {
    mode: 'fix',
    text: 'The menu lists the soup twice',
    sources: [MENU],
    failing: { document: MENU, text: 'Tomato soup appears on two lines.' },
  });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-thread-build-fix-'));
  seen = [];
  proposals = 0;
  reply = 'proposal';
  const service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: network,
  });
  server = await new Promise<Server>((done) => {
    const listener = app.listen(0, '127.0.0.1', () => done(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  project = await api<Project>('/projects', 'POST', { name: 'Lunch service' });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  folder = store().state(project.id).project.folder;
  await fs.mkdir(path.join(folder, 'notes'), { recursive: true });
  await fs.writeFile(path.join(folder, MENU), MENU_TEXT);
  // Default-deny cloud sharing: this synthetic project grants every cloud route its files
  // and history, so the behaviour under test is reached.
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ALL_ROUTES.filter((route) => route !== 'sample'),
    documents: [MENU],
    shareConversationHistory: true,
    shareReviewPackets: true,
  });
});
afterEach(async () => {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server!.close((error) => (error ? reject(error) : done())));
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ROUTES: TestedRoute[] = ['aws-bedrock', 'azure-openai', 'openrouter'];

describe.each(ROUTES)('Build and Fix from a thread on %s', (route) => {
  test('Build: one guarded proposal, nothing written until the exact approval, attributed to the reported model', async () => {
    const accountRoute = await onRoute(route);
    const sent = await build(route);
    expect(sent.status, await sent.clone().text()).toBe(200);
    const { session, turn } = (await sent.json()) as { session: Session; turn: { route: string; helper: { engine: string } } };
    expect(session.route).toBe(route);
    expect(turn).toMatchObject({ route, helper: { engine: route } });
    const ready = await openNeed();
    // One provider call, on this route's own host, offered no tools, asked for the strict proposal.
    expect(seen).toHaveLength(1);
    expect(seen[0].url.startsWith(HOSTS[route])).toBe(true);
    expect(seen[0].body.tools ?? []).toEqual([]);
    expect(seen[0].raw).toContain('Return STRICT JSON only');
    const need = ready.needs.find((item) => item.state === 'open')!;
    expect(need.files).toEqual([PLAN]);
    await expect(fs.stat(path.join(folder, PLAN))).rejects.toMatchObject({ code: 'ENOENT' });

    await resolveNeed('go-ahead');
    const written = await until(
      () => fs.readFile(path.join(folder, PLAN), 'utf8').catch(() => null),
      (text) => text !== null,
      'the approved plan',
    );
    expect(written).toBe('# Lunch plan (1)\n\n1. Soup\n2. Sandwiches\n');
    const done = await until(state, (value) => value.sessions.find((item) => item.id === session.id)?.state === 'done', 'the Build to finish');
    const record = done.sessions.find((item) => item.id === session.id)!;
    expect(record.engine).toMatchObject({ model: REPORTED[route], verified: true });
    expect(record.origin).toMatchObject({
      mode: 'direct',
      engine: { id: route },
      model: { reported: REPORTED[route], source: 'runtime' },
      accountRoute,
      executorId: 'diomedes:recorded-writer',
    });
    expect(done.history.some((entry) => entry.files?.some((file) => file.path === PLAN && file.recorded))).toBe(true);
    // Still one paid call: approval sends nothing.
    expect(seen).toHaveLength(1);
  });

  test('Fix: the failing target and the Fix contract ride in the request; a declined proposal writes nothing', async () => {
    await onRoute(route);
    const sent = await fix(route);
    expect(sent.status, await sent.clone().text()).toBe(200);
    const { turn } = (await sent.json()) as { turn: { attempt?: { n: number; of: number } } };
    expect(turn.attempt).toEqual({ n: 1, of: 3 });
    await openNeed();
    const call = seen.at(-1)!;
    expect(call.raw).toContain('Failing:');
    expect(call.raw).toContain(`- Document: ${MENU}`);
    expect(call.raw).toContain('Tomato soup appears on two lines.');
    expect(call.raw).toContain('Change as little as possible to fix exactly that failure.');
    await resolveNeed('declined');
    await idle();
    expect(await fs.readFile(path.join(folder, MENU), 'utf8')).toBe(MENU_TEXT);
  });
});

describe('a large proposal', () => {
  test.each(ROUTES)('on %s, a valid proposal sent as one large delta still reaches exact approval', async (route) => {
    await onRoute(route);
    reply = 'large';
    const sent = await build(route);
    expect(sent.status, await sent.clone().text()).toBe(200);
    const ready = await openNeed();
    expect(ready.needs.find((need) => need.state === 'open')!.files).toEqual([PLAN]);
    await expect(fs.stat(path.join(folder, PLAN))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Fix on a model-API route keeps its limits', () => {
  test('three tries, then the fourth is refused before anything is sent; an approved try writes only the failing file', async () => {
    const route: TestedRoute = 'azure-openai';
    await onRoute(route);
    for (const n of [1, 2, 3]) {
      const sent = await fix(route);
      expect(sent.status, await sent.clone().text()).toBe(200);
      expect(((await sent.json()) as { turn: { attempt: unknown } }).turn.attempt).toEqual({ n, of: 3 });
      await openNeed();
      await resolveNeed(n === 3 ? 'go-ahead' : 'declined');
      await idle();
    }
    expect(await fs.readFile(path.join(folder, MENU), 'utf8')).toBe('# Lunch\n\nTomato soup.\nGrilled cheese.\n<!-- try 3 -->\n');
    const calls = seen.length;
    const fourth = await fix(route);
    expect(fourth.status).toBe(409);
    expect(await fourth.text()).toMatch(/Three tries have not fixed this/);
    expect(seen).toHaveLength(calls);
  });

  test('Fix without a failing target is refused before anything is sent', async () => {
    await onRoute('openrouter');
    const refused = await ask('openrouter', { mode: 'fix', text: 'Something is off', sources: [MENU] });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toMatch(/Say what is failing/);
    expect(seen).toHaveLength(0);
  });
});

describe('what stays refused, and how a reply that is not a proposal is refused', () => {
  test('Ask and Plan on a model-API route still answer through the conversation', async () => {
    await onRoute('openrouter');
    for (const mode of ['ask', 'plan']) {
      const refused = await ask('openrouter', { mode, text: 'What is for lunch?' });
      expect(refused.status).toBe(409);
      expect(await refused.text()).toMatch(/OpenRouter answers through the conversation/);
    }
    expect(seen).toHaveLength(0);
  });

  test('Build needs consent before the documents go to the provider', async () => {
    await onRoute('aws-bedrock');
    const refused = await request(`/projects/${project.id}/ask`, 'POST', {
      route: 'aws-bedrock',
      threadId: thread.id,
      mode: 'build',
      text: 'Draft a lunch plan',
      sources: [],
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ consentRequired: true });
    expect(seen).toHaveLength(0);
  });

  test('a reply that is not a file proposal stops the Work by the route’s name and writes nothing', async () => {
    await onRoute('azure-openai');
    reply = 'prose';
    const sent = await build('azure-openai');
    expect(sent.status).toBe(200);
    const { session } = (await sent.json()) as { session: Session };
    const failed = await until(state, (value) => value.sessions.find((item) => item.id === session.id)?.state === 'failed', 'the Work to stop');
    const record = failed.sessions.find((item) => item.id === session.id)!;
    expect(record.log.map((line) => line.sentence)).toContain(
      'Work stopped: Azure OpenAI did not return a valid file proposal. No files were changed. Start again to request a new proposal. No project files were changed.',
    );
    expect(failed.needs.some((need) => need.state === 'open')).toBe(false);
    await expect(fs.stat(path.join(folder, PLAN))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a tool call where none was offered stops the Work, opens no Need and writes nothing', async () => {
    await onRoute('aws-bedrock');
    reply = 'tool';
    const sent = await build('aws-bedrock');
    expect(sent.status).toBe(200);
    const { session } = (await sent.json()) as { session: Session };
    const failed = await until(state, (value) => value.sessions.find((item) => item.id === session.id)?.state === 'failed', 'the Work to stop');
    const sentences = failed.sessions.find((item) => item.id === session.id)!.log.map((line) => line.sentence);
    // The shared model-API core refuses the undeclared call before Work sees it; its words are its own.
    expect(sentences.some((sentence) => sentence.includes('did not offer'))).toBe(true);
    expect(failed.needs.some((need) => need.state === 'open')).toBe(false);
    await expect(fs.stat(path.join(folder, PLAN))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
