/**
 * DIO-251: a loop on the local model checks its sources against the profile's reading allowance
 * when it starts, as Work checks its selection. Past it, the start is refused in Work's words
 * before any role is admitted or the model is called. Within it, the loop starts and runs as before.
 *
 * The local host is a fixture that reports the Gaming profile running, over a copied descriptor,
 * and a scripted transport stands for its server. Nothing here reaches a provider or a real local
 * model, and nothing here starts one.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { EngineService } from '../server/engines/service.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { Store } from '../server/store.js';
import type { HarnessRun } from '../shared/harness.js';
import {
  findLocalProfile,
  localContextBudget,
  localSourceRefusal,
  LOCAL_MODEL_ACCOUNT,
  parseLocalModelDescriptor,
} from '../shared/local-model.js';
import type { Project } from '../shared/types.js';
import { BONSAI_DESCRIPTOR, BONSAI_FOLDER, BONSAI_MODEL, FixedLocalModel, localAnswerStream } from './fixtures/local-model.js';
import { LOCAL_BASE, LOCAL_GAMING, ORDER, SOURCES, localHost, teamFixture, type TeamFixture } from './fixtures/three-model-team.js';

// A run here ends in about a second alone; on a loaded machine the full suite can take far longer.
vi.setConfig({ testTimeout: 90_000 });

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const GAMING = findLocalProfile(parseLocalModelDescriptor(BONSAI_DESCRIPTOR, BONSAI_FOLDER), LOCAL_GAMING)!;
/** The Gaming profile's reading allowance, in bytes of source text. */
const ALLOWANCE = localContextBudget(GAMING).sourceBytes;
/** The local server's model endpoints. The fixture host's status read is not a model call. */
const MODEL_PATHS = ['/apply-template', '/tokenize', '/v1/chat/completions'];

let root: string | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let base: string;
let fixture: TeamFixture;
let localCalls: string[];
let admissions: string[];
let commands = 0;
const store = (): Store => app!.locals.store;
const harness = (): HarnessHost => app!.locals.harness;

/** The scripted local lead: the same short answer to its plan and to its turn. */
const transport = (async (input: RequestInfo | URL) => {
  const target = String(input);
  if (!target.startsWith(LOCAL_BASE)) throw new Error(`This fixture never reaches ${target}.`);
  localCalls.push(target);
  if (target.endsWith('/apply-template')) return Response.json({ prompt: 'Fixture template' });
  if (target.endsWith('/tokenize')) return Response.json({ tokens: [1, 2, 3] });
  if (target !== `${LOCAL_BASE}v1/chat/completions`) throw new Error(`The local fixture never answers ${target}.`);
  return localAnswerStream({
    id: `local-${localCalls.length}`,
    model: BONSAI_MODEL,
    usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    choices: [{ finish_reason: 'stop', message: { content: 'Six napkins are short.' } }],
  });
}) as typeof globalThis.fetch;

/** The app on a computer nobody signed in on, with every model-API admission recorded by route. */
async function open() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dio251-loop-sources-'));
  fixture = teamFixture();
  localCalls = [];
  admissions = [];
  const engines = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: transport,
    localModel: { host: localHost(fixture), source: new FixedLocalModel() },
    automationTickMs: null,
  });
  const admit = engines.admitModelApi.bind(engines);
  vi.spyOn(engines, 'admitModelApi').mockImplementation((route, input, agent, observe) => {
    admissions.push(route);
    return admit(route, input, agent, observe);
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app!.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    const closing = server;
    server = undefined;
    try {
      await app!.locals.close();
    } finally {
      closing.closeAllConnections();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  }
  app = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = undefined;
});

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, ok: response.ok, text, data: (text ? JSON.parse(text) : null) as T };
}
async function ok<T = any>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request<T>(route, method, body);
  expect(response.ok, `${method} ${route}: ${response.status} ${response.text}`).toBe(true);
  return response.data;
}

/** A project with the order and a delivery note of `deliveryBytes` bytes, both shared with the local model, and a task. */
async function project(deliveryBytes: number) {
  const projectId = (await ok<Project>('/projects', 'POST', { name: 'Linen orders' })).id;
  const folder = store().state(projectId).project.folder;
  await fs.writeFile(path.join(folder, 'order.md'), ORDER);
  await fs.writeFile(path.join(folder, 'delivery.md'), 'n'.repeat(deliveryBytes));
  const policy = await ok<{ version: number }>(`/projects/${projectId}/cloud-sharing`);
  await ok(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: policy.version,
    routes: ['bonsai'],
    documents: SOURCES,
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  const taskId = (await ok<{ id: string }>(`/projects/${projectId}/tasks`, 'POST', { name: 'Check the linen delivery' })).id;
  return { projectId, taskId };
}

/** A loop on the local model's Gaming profile over the order and the delivery note, as the person starts it. */
const start = (projectId: string, taskId: string, extra: Record<string, unknown> = {}) =>
  request<any>(`/projects/${projectId}/loop/start`, 'POST', {
    protocolVersion: 1,
    commandId: `dio251-${++commands}`,
    taskId,
    goal: 'Compare the delivery with the order and say what is short.',
    route: 'bonsai',
    model: LOCAL_GAMING,
    accountRoute: LOCAL_MODEL_ACCOUNT,
    consent: true,
    sources: SOURCES,
    ...extra,
  });

/** Waits until the run ends and fails with its steps unless it completed. */
async function settled(projectId: string, runId: string): Promise<HarnessRun> {
  const ended = await vi.waitFor(async () => {
    const run = await harness().get(projectId, runId);
    if (!['completed', 'failed', 'cancelled', 'reconcile_required'].includes(run.state)) throw new Error(`The run is still ${run.state}.`);
    return run;
  }, { timeout: 60_000, interval: 50 });
  const steps = ended.steps.map((step) => ({ id: step.intent.stepId, state: step.state, error: step.error }));
  expect(ended.state, JSON.stringify({ failure: ended.failure, steps })).toBe('completed');
  await harness().bridge.flush();
  return ended;
}

const modelCalls = () => localCalls.filter((url) => MODEL_PATHS.some((suffix) => url.endsWith(suffix)));

describe('a local loop’s sources at its start (DIO-251)', () => {
  test('one byte past the profile’s allowance: refused in Work’s words, before any role is admitted or the model is called', async () => {
    await open();
    const { projectId, taskId } = await project(ALLOWANCE - Buffer.byteLength(ORDER) + 1);
    const refused = await start(projectId, taskId);
    expect(refused.status, refused.text).toBe(413);
    expect(refused.data.error).toBe(localSourceRefusal('Select no more than', ALLOWANCE));
    expect(refused.data.error).toBe('Select no more than 36 KB of source text for this local model profile.');
    expect(admissions).toEqual([]);
    expect(modelCalls()).toEqual([]);
    expect(fixture.acquires).toEqual([]);
    expect(await harness().list(projectId)).toEqual([]);
    expect(store().state(projectId).sessions).toEqual([]);
  });

  test('exactly the allowance: the loop starts and runs on the local model as before', async () => {
    await open();
    const { projectId, taskId } = await project(ALLOWANCE - Buffer.byteLength(ORDER));
    const started = await start(projectId, taskId, { escalation: false });
    expect(started.status, started.text).toBe(200);
    expect(started.data.replayed).toBe(false);
    await settled(projectId, started.data.runId);
    expect(admissions).toContain('bonsai');
    expect(modelCalls().filter((url) => url.endsWith('/v1/chat/completions')).length).toBeGreaterThan(0);
  });
});
