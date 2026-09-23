/**
 * The Google Vertex AI route through the real host: setup over HTTP, the real
 * Store, RunService, model-session driver, NativeAgent loop and registered read
 * tools, and the Work text route. Only Google's network (below the AI SDK) and
 * Google's token exchange are replaced, so nothing here reaches Google or
 * spends money, and no real credential exists.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { GOOGLE_VERTEX_SDK, VertexConnections } from '../server/engines/google-vertex';
import { testOnlySecretBox } from '../server/connection-secrets';
import { FileModelTranscripts } from '../server/harness/model-transcripts';
import { modelSessionRunId } from '../server/harness/model-session-run';
import type { Store } from '../server/store';
import type { TextRequest } from '../server/engines/contract';
import type { ToolActivity } from '../shared/adapter-contract';
import type { ModelApiReadiness, VertexConnectionView } from '../shared/model-api';
import type { Project } from '../shared/types';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const TOKEN = 'ya29.test-only-vertex-token-never-real';
const PROJECT = 'nectovia-founder-proof';
const STREAM_URL = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse`;
const MENU = { path: 'menu.md', text: '# Lunch\n\nTomato soup and a grilled cheese sandwich.\n' };
const USAGE = { promptTokenCount: 600, candidatesTokenCount: 30, thoughtsTokenCount: 10, totalTokenCount: 640 };

type Item = Record<string, unknown>;
interface Seen {
  url: string;
  headers: Headers;
  body: Item;
}
let seen: Seen[];
/** What the fake Gemini does next, decided from the request. */
let script: (body: Item) => Item[];
let mints = 0;

const frames = (parts: Item[], usage: Item = USAGE): Item[] => [
  { candidates: [{ content: { role: 'model', parts }, index: 0 }], modelVersion: 'gemini-3.8-flash-001', responseId: `vtx-${seen.length}` },
  {
    candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: usage,
    modelVersion: 'gemini-3.8-flash-001',
    responseId: `vtx-${seen.length}`,
  },
];
const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body)) as Item;
  seen.push({ url, headers: new Headers(init?.headers), body });
  if (!url.startsWith('https://aiplatform.googleapis.com/'))
    throw new Error(`A request reached a provider this test never expects: ${url}`);
  const events = script(body);
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-goog-request-id': `goog-${seen.length}` },
  });
}) as typeof globalThis.fetch;
/** The ordinary conversation: read the menu, then answer from it. */
const readThenAnswer = (body: Item): Item[] => {
  const contents = body.contents as Item[];
  const answered = JSON.stringify(contents).includes('functionResponse');
  if (!answered) return frames([{ functionCall: { name: 'read_source', args: { path: MENU.path } }, thoughtSignature: 'sig-1' }]);
  return JSON.stringify(contents).includes('Tomato soup')
    ? frames([{ text: 'Tomato soup and a grilled cheese (menu.md).' }])
    : frames([{ text: 'I could not read the menu.' }]);
};

let root: string;
let adcFile: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
const store = () => app.locals.store as Store;
const writeAdc = (quota: string, clientId = 'founder-client') =>
  fs.writeFile(
    adcFile,
    JSON.stringify({ type: 'authorized_user', client_id: clientId, client_secret: 'cs-never-read', refresh_token: 'rt-never-read', quota_project_id: quota }),
  );

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-vertex-host-'));
  adcFile = path.join(root, 'adc.json');
  await writeAdc(PROJECT);
  seen = [];
  mints = 0;
  script = readThenAnswer;
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
  // The route mounted its own record; the test points it at a temporary ADC file and replaces
  // only Google's token exchange.
  expect(service.modelApi!.vertex).toBeDefined();
  service.modelApi!.vertex = {
    connections: new VertexConnections(dataDir),
    transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-google-vertex'), 'google-vertex'),
    env: { GOOGLE_APPLICATION_CREDENTIALS: adcFile },
    mint: async () => {
      mints += 1;
      return { token: TOKEN, expiresAt: null };
    },
    now: () => new Date('2026-09-23T12:00:00.000Z'),
  };
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  project = await api<Project>('/projects', 'POST', { name: 'Lunch service' });
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

const connect = () =>
  api<VertexConnectionView>('/ai/model-api/google-vertex', 'PUT', {
    projectId: PROJECT,
    location: 'global',
    model: 'gemini-3.8-flash',
    consent: true,
  });
const approve = (capUsd = 1) => api<VertexConnectionView>('/ai/model-api/google-vertex/spend-limit', 'PUT', { capUsd, consent: true });
function turnInput(overrides: Partial<TextRequest> & Pick<TextRequest, 'accountRoute'>): TextRequest {
  return {
    projectId: project.id,
    threadId: 'thread-1',
    requestId: `cmd-${Math.random().toString(36).slice(2)}`,
    prompt: 'What is for lunch?',
    documents: [MENU],
    instructions: 'You are Nectovia. Answer only from the attached files.',
    model: 'gemini-3.8-flash',
    ...overrides,
  };
}

describe('setup over HTTP', () => {
  test('finding gcloud credentials grants nothing; connecting names the billed project and sends nothing', async () => {
    const found = await api<VertexConnectionView>('/ai/model-api/google-vertex');
    expect(found).toMatchObject({ configured: false, enabled: false, detected: { adc: true, source: 'gcloud-user', quotaProject: PROJECT } });
    expect(found.next).toMatch(/Connect Google Vertex AI/);
    await expect(
      service.modelSession('google-vertex', 'start', modelSessionRunId(project.id, 'x'), turnInput({ accountRoute: 'google-vertex:google-vertex-1:x@r1' })),
    ).rejects.toMatchObject({ code: 'ROUTE_REFUSED' });

    const view = await connect();
    const text = JSON.stringify(view);
    for (const secret of ['rt-never-read', 'cs-never-read', TOKEN]) expect(text).not.toContain(secret);
    expect(view.connection).toMatchObject({
      projectId: PROJECT,
      location: 'global',
      model: 'gemini-3.8-flash',
      endpoint: `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google`,
      payer: { kind: 'google-cloud-project', projectId: PROJECT },
      credential: { kind: 'google-adc', source: 'gcloud-user', matches: true },
      rateCard: { version: 'google-vertex:gemini-3.8-flash:global:standard:gross-2026.1', stale: false },
      accountRoute: `google-vertex:google-vertex-1:${PROJECT}@r1`,
      lastVerified: null,
    });
    expect(view.next).toBe('Approve a spend limit for Google Vertex AI before sending.');
    expect(store().settings.services).toMatchObject({ 'google-vertex': true, 'google-vertexModel': 'gemini-3.8-flash' });

    await approve();
    const ready = await api<ModelApiReadiness>('/ai/model-api/google-vertex/test', 'POST', {});
    expect(ready).toMatchObject({ route: 'google-vertex', ready: true, sent: false });
    expect(seen).toHaveLength(0);
    expect(mints).toBe(0);
  });

  test('no ADC file: connecting is refused and nothing is saved', async () => {
    await fs.rm(adcFile);
    const response = await fetch(`${base}/api/ai/model-api/google-vertex`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ projectId: PROJECT, location: 'global', model: 'gemini-3.8-flash', consent: true }),
    });
    expect(response.status).toBe(409);
    expect(await service.modelApi!.vertex!.connections.read()).toBeNull();
    for (const body of [
      { projectId: PROJECT, location: 'us-central1', model: 'gemini-3.8-flash', consent: true },
      { projectId: PROJECT, location: 'global', model: 'gemini-3.8-pro', consent: true },
      { projectId: 'Not A Project', location: 'global', model: 'gemini-3.8-flash', consent: true },
    ]) {
      const refused = await fetch(`${base}/api/ai/model-api/google-vertex`, { method: 'PUT', headers, body: JSON.stringify(body) });
      expect(refused.status).toBe(400);
    }
  });
});

describe('a native Nectovia conversation on Gemini 3.8 Flash', () => {
  test('a read_source round trip: canonical tool, recorded result, provider continuation, attribution and spend', async () => {
    const view = await connect();
    await approve();
    const activity: ToolActivity[] = [];
    const previews: string[] = [];
    const input = turnInput({
      accountRoute: view.connection!.accountRoute,
      onActivity: (frame) => activity.push(frame),
      onPreview: (frame) => previews.push(frame.text),
    });
    const runId = modelSessionRunId(project.id, input.requestId);
    const result = await service.modelSession('google-vertex', 'start', runId, input);

    expect(result.response?.text).toBe('Tomato soup and a grilled cheese (menu.md).');
    expect(result.response?.version).toBe(GOOGLE_VERTEX_SDK);
    expect(seen.map((request) => request.url)).toEqual([STREAM_URL, STREAM_URL]);
    for (const request of seen) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(request.headers.get('x-goog-user-project')).toBe(PROJECT);
      const declared = (request.body.tools as { functionDeclarations: { name: string }[] }[])[0].functionDeclarations.map((tool) => tool.name);
      expect(declared.sort()).toEqual(['list_sources', 'read_source']);
    }
    // The second call answers the first call's function by name and returns its thought signature.
    const second = JSON.stringify(seen[1].body.contents);
    expect(second).toContain('sig-1');
    expect(second).toContain('functionResponse');
    expect(second).not.toContain('skip_thought_signature_validator');

    expect(activity.map((frame) => [frame.phase, frame.tool, frame.summary])).toEqual([
      ['started', 'read_source', 'Reading menu.md'],
      ['finished', 'read_source', 'Read menu.md'],
    ]);
    expect(previews.join('')).toBe('Tomato soup and a grilled cheese (menu.md).');

    const status = await api<{ requestedModel: string; reportedModel: string }>(`/projects/${project.id}/model-sessions/${runId}`);
    expect(status).toMatchObject({ requestedModel: 'gemini-3.8-flash', reportedModel: 'gemini-3.8-flash-001' });
    const holds = service.modelApi!.exposure.list('google-vertex-1');
    expect(holds.map((hold) => [hold.state, hold.route, hold.modelId, hold.rateCardVersion, hold.reconciledFrom])).toEqual([
      ['settled', 'google-vertex', 'gemini-3.8-flash', 'google-vertex:gemini-3.8-flash:global:standard:gross-2026.1', 'response'],
      ['settled', 'google-vertex', 'gemini-3.8-flash', 'google-vertex:gemini-3.8-flash:global:standard:gross-2026.1', 'response'],
    ]);
    expect(holds.every((hold) => hold.providerRequestId?.startsWith('goog-'))).toBe(true);
    // One provider exchange is one recorded model attempt: two calls, two holds, one token each.
    expect(mints).toBe(1);

    const after = await api<VertexConnectionView>('/ai/model-api/google-vertex');
    expect(after.connection!.lastVerified).toMatchObject({ state: 'settled' });
    expect(after.spend!.settledMicroUsd).toBeGreaterThan(0);
  });

  test('Ask cannot gain write authority because Gemini asks for a tool: nothing is written', async () => {
    const view = await connect();
    await approve();
    script = () => frames([{ functionCall: { name: 'write_file', args: { path: 'menu.md', text: 'pwned' } } }]);
    const input = turnInput({ accountRoute: view.connection!.accountRoute });
    await expect(service.modelSession('google-vertex', 'start', modelSessionRunId(project.id, input.requestId), input)).rejects.toMatchObject({
      message: expect.stringMatching(/did not offer|not run/),
    });
    expect(seen).toHaveLength(1);
    const files = await fs.readdir(path.join(root, 'projects')).catch(() => []);
    expect(JSON.stringify(files)).not.toContain('pwned');
  });

  test('a Work turn offers no tools; a function call there is refused, never executed', async () => {
    const view = await connect();
    await approve();
    script = () => frames([{ functionCall: { name: 'read_source', args: { path: MENU.path } } }]);
    await expect(service.generateModelApi('google-vertex', turnInput({ accountRoute: view.connection!.accountRoute }))).rejects.toMatchObject({
      message: expect.stringMatching(/did not offer|not run|where none was offered/),
    });
    expect(seen[0].body.tools).toBeUndefined();
  });

  test('a Work proposal comes back as text for the existing writer and Trust path', async () => {
    const view = await connect();
    await approve();
    script = () => frames([{ text: '{"summary":"Add Friday specials","changes":[]}' }]);
    const result = await service.generateModelApi('google-vertex', turnInput({ accountRoute: view.connection!.accountRoute }));
    expect(result.text).toBe('{"summary":"Add Friday specials","changes":[]}');
    expect(result.model).toBe('gemini-3.8-flash-001');
    expect(result.version).toBe(GOOGLE_VERTEX_SDK);
  });
});

describe('what is refused before anything is sent', () => {
  test('a changed ADC identity after connecting: refused, nothing sent, no token minted', async () => {
    const view = await connect();
    await approve();
    await writeAdc('someone-elses-billing-project', 'other-client');
    const input = turnInput({ accountRoute: view.connection!.accountRoute });
    await expect(service.modelSession('google-vertex', 'start', modelSessionRunId(project.id, input.requestId), input)).rejects.toMatchObject({
      code: 'ROUTE_REFUSED',
      message: expect.stringMatching(/not the one Google Vertex AI was verified with/),
    });
    expect(seen).toHaveLength(0);
    expect(mints).toBe(0);
    const readiness = await api<ModelApiReadiness>('/ai/model-api/google-vertex/test', 'POST', {});
    expect(readiness.checks.find((check) => check.id === 'credential')?.ok).toBe(false);
  });

  test('a reconnect is a new generation: context admitted under the old one is refused', async () => {
    const first = await connect();
    await approve();
    await connect();
    const input = turnInput({ accountRoute: first.connection!.accountRoute });
    await expect(service.modelSession('google-vertex', 'start', modelSessionRunId(project.id, input.requestId), input)).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
    });
    expect(seen).toHaveLength(0);
  });

  test('another route’s account route never reaches Vertex, and Vertex never serves another model', async () => {
    const view = await connect();
    await approve();
    for (const input of [
      turnInput({ accountRoute: 'aws-bedrock:aws-bedrock-1@r1' }),
      turnInput({ accountRoute: view.connection!.accountRoute, model: 'us.openai.gpt-5.6-luna' }),
    ])
      await expect(service.modelSession('google-vertex', 'start', modelSessionRunId(project.id, input.requestId), input)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  test('no spend room: refused before any token is minted', async () => {
    const view = await connect();
    await approve(0);
    const input = turnInput({ accountRoute: view.connection!.accountRoute });
    await expect(service.generateModelApi('google-vertex', input)).rejects.toMatchObject({ code: 'SPEND_LIMIT' });
    expect(seen).toHaveLength(0);
    expect(mints).toBe(0);
  });
});

describe('an API key from the billed project', () => {
  const KEY = 'AQ.synthetic-vertex-key-for-tests-only-0123';
  const connectWithKey = (apiKey = KEY) =>
    api<VertexConnectionView>('/ai/model-api/google-vertex', 'PUT', {
      projectId: PROJECT,
      location: 'global',
      model: 'gemini-3.8-flash',
      consent: true,
      apiKey,
    });

  test('connects without any sign-in, keeps the key out of every view and file, and sends it as a header only', async () => {
    await fs.rm(adcFile);
    const view = await connectWithKey();
    expect(view.connection?.credential).toEqual({ kind: 'google-api-key', savedAt: expect.any(String), matches: true });
    expect(view.connection?.payer).toEqual({ kind: 'google-cloud-project', projectId: PROJECT });
    expect(JSON.stringify(view)).not.toContain(KEY);
    // No file this host writes holds the key in the clear: protected storage keeps it sealed.
    const files = (await fs.readdir(path.join(root, 'data'), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const entry of files) expect(await fs.readFile(path.join(entry.parentPath, entry.name), 'utf8'), entry.name).not.toContain(KEY);
    expect(seen).toHaveLength(0);

    const check = await api<ModelApiReadiness>('/ai/model-api/google-vertex/test', 'POST', {});
    expect(check.checks.find((entry) => entry.id === 'credential')).toMatchObject({ ok: true });
    expect(check.sent).toBe(false);

    await approve(10);
    const input = turnInput({ accountRoute: view.connection!.accountRoute });
    const result = await service.modelSession('google-vertex', 'start', modelSessionRunId(project.id, input.requestId), input);
    expect(result.response?.text).toBe('Tomato soup and a grilled cheese (menu.md).');
    expect(mints).toBe(0);
    for (const request of seen) {
      expect(request.url).toBe(STREAM_URL);
      expect(request.url).not.toContain(KEY);
      expect(request.headers.get('x-goog-api-key')).toBe(KEY);
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('x-goog-user-project')).toBeNull();
    }
  });

  test('an ambient GOOGLE_VERTEX_API_KEY is never the connection key', async () => {
    process.env.GOOGLE_VERTEX_API_KEY = 'ambient-key-must-never-be-sent-000000';
    try {
      const view = await connectWithKey();
      await approve(10);
      const input = turnInput({ accountRoute: view.connection!.accountRoute });
      await service.modelSession('google-vertex', 'start', modelSessionRunId(project.id, input.requestId), input);
      expect(seen.length).toBeGreaterThan(0);
      for (const request of seen) expect(request.headers.get('x-goog-api-key')).toBe(KEY);
    } finally {
      delete process.env.GOOGLE_VERTEX_API_KEY;
    }
  });

  test('a replaced stored key is refused before anything is sent; switching back to sign-in removes the key', async () => {
    const view = await connectWithKey();
    await approve(10);
    await service.modelApi!.secrets.put('google-vertex-1', 'AQ.a-different-key-put-behind-the-record-9');
    const input = turnInput({ accountRoute: view.connection!.accountRoute });
    await expect(service.modelSession('google-vertex', 'start', modelSessionRunId(project.id, input.requestId), input)).rejects.toThrow(/not the one that was connected/);
    expect(seen).toHaveLength(0);

    const adc = await connect();
    expect(adc.connection?.credential.kind).toBe('google-adc');
    expect(adc.connection!.revision).toBe(view.connection!.revision + 1);
    await expect(service.modelApi!.secrets.get('google-vertex-1')).rejects.toThrow();
  });

  test('a malformed key is refused and nothing is stored', async () => {
    const response = await fetch(`${base}/api/ai/model-api/google-vertex`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ projectId: PROJECT, location: 'global', model: 'gemini-3.8-flash', consent: true, apiKey: 'has spaces in it and is not a key' }),
    });
    expect(response.status).toBe(400);
    expect(await service.modelApi!.vertex!.connections.read()).toBeNull();
  });
});
