/**
 * DIO-256: an Agent loop's calls on the local model send the model's reading counters, as a
 * conversation's calls do. The lead's, a worker's and an advisor's calls each reach `/api/events`
 * as `engine-prompt-progress`, named by the loop's session (the request) and root run, the child run
 * and seat that read, and that call's own step and attempt. A loop on a cloud route sends none, and
 * its calls are made with exactly the arguments they had before.
 *
 * The local server is a real HTTP server on this computer that answers every call with one progress
 * chunk and an answer; the cloud route is the H14 stub. Nothing here reaches a provider or a real
 * local model, and nothing here starts one.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { EngineService } from '../server/engines/service.js';
import type { LoopModelRoutes } from '../server/harness/capabilities/native-loop.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { ModelStreamSink } from '../server/harness/native-agent.js';
import type { Store } from '../server/store.js';
import type { HarnessRun, ModelRequest } from '../shared/harness.js';
import { LOCAL_MODEL_ACCOUNT } from '../shared/local-model.js';
import type { Project, Session } from '../shared/types.js';
import { FixedLocalModel, fakeLocalHost, localAnswerStream, meadowDescriptor, MEADOW_FOLDER, MEADOW_MODEL } from './fixtures/local-model.js';
import { TEAM_STUB_ACCOUNT_ROUTE, teamRoutes, toolResults } from './fixtures/team-loop-stub.js';

vi.setConfig({ testTimeout: 90_000 });

const ORDER = 'Order 1182: 100 napkins.\n';
const ASSIGN = { tasks: [{ task: 'Count the napkins in order.md.', files: ['order.md'] }] };
const ADVISE = { question: 'Is the order complete?' };

let local: Server | undefined;
let root: string | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let listener: Server | undefined;
let base: string;
const host = (): HarnessHost => app!.locals.harness;
const store = (): Store => app!.locals.store;

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}
const json = (res: ServerResponse, value: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

/** Every chat call so far: which side made it, in order. Call n reads 40,000 + n tokens. */
let calls: ('lead' | 'child')[];
const counters = (n: number) => ({ total: 40_000 + n, cache: 1_000, processed: 20_000 + n, time_ms: 250 });

/**
 * The local server. The lead plans, hands a worker the order, asks its advisor, then answers; a
 * child answers at once. Every call's stream starts with one progress chunk naming the call.
 */
function localServer(): Promise<string> {
  local = http.createServer((req, res) => {
    void (async () => {
      const body = await bodyOf(req);
      if (req.url === '/apply-template') return json(res, { prompt: 'Fixture template' });
      if (req.url === '/tokenize') return json(res, { tokens: [1, 2, 3] });
      if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
      const tools = ((body.tools as { function: { name: string } }[] | undefined) ?? []).map((tool) => tool.function.name);
      const lead = !tools.length || tools.includes('assign_workers');
      calls.push(lead ? 'lead' : 'child');
      const n = calls.length;
      const answered = (body.messages as { role: string }[]).filter((message) => message.role === 'tool').length;
      const envelope = { id: `local-${n}`, model: MEADOW_MODEL, usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } };
      const final = (content: string) => ({ finish_reason: 'stop', message: { content } });
      const tool = (name: string, input: unknown) => ({ finish_reason: 'tool_calls',
        message: { content: null, tool_calls: [{ id: `call-${n}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } });
      const choice = !lead ? final('Order 1182 lists 100 napkins.')
        : !tools.length ? final('1. Ask my team.\n2. Answer.')
          : answered === 0 ? tool('assign_workers', ASSIGN)
            : answered === 1 ? tool('consult_advisor', ADVISE)
              : final('Done with what my team said.');
      const answer = localAnswerStream({ ...envelope, choices: [choice] }, counters(n));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(await answer.text());
    })().catch(() => res.destroy());
  });
  return new Promise((resolve) => local!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(local!.address() as AddressInfo).port}`)));
}

afterEach(async () => {
  vi.restoreAllMocks();
  local?.closeAllConnections();
  if (listener) {
    const closing = listener;
    listener = undefined;
    try {
      await app!.locals.close();
    } finally {
      closing.closeAllConnections();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  }
  if (local) {
    const closing = local;
    local = undefined;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  app = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = undefined;
});

async function call<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}

/** The app, listening, with a project that holds the order and a task. */
async function open(options: Partial<Parameters<typeof createApp>[0]>) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dio256-loop-reading-'));
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    automationTickMs: null,
    ...options,
  });
  listener = await new Promise<Server>((resolve) => {
    const opened = app!.listen(0, '127.0.0.1', () => resolve(opened));
  });
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const projectId = (await call<Project>('/projects', 'POST', { name: 'Linen orders' })).id;
  await fs.writeFile(path.join(store().state(projectId).project.folder, 'order.md'), ORDER);
  const taskId = (await call<{ id: string }>(`/projects/${projectId}/tasks`, 'POST', { name: 'Check the order' })).id;
  return { projectId, taskId };
}

/** Shares the order with one route, as the project's sharing setting does. */
async function share(projectId: string, route: string) {
  const policy = await call<{ version: number }>(`/projects/${projectId}/cloud-sharing`);
  await call(`/projects/${projectId}/cloud-sharing`, 'PUT', { expectedVersion: policy.version, routes: [route],
    documents: ['order.md'], shareConversationHistory: false, shareReviewPackets: false });
}

/** Reads /api/events the way the Console does, keeping every reading frame it forwards. */
async function openEvents() {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal,
    headers: { Accept: 'text/event-stream', 'X-Diomedes-Client': '1' } });
  expect(response.status).toBe(200);
  const frames: Record<string, unknown>[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const reading = (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let boundary = buffer.indexOf('\n\n'); boundary >= 0; boundary = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.match(/^event: (.+)$/m)?.[1].trim() === 'engine-prompt-progress') frames.push(JSON.parse(block.match(/^data: (.+)$/m)![1]));
      }
    }
  })();
  return { frames, close: async () => { controller.abort(); await reader.cancel().catch(() => undefined); await reading; } };
}

/** Waits until a run ends, and returns it. */
const ended = (projectId: string, runId: string): Promise<HarnessRun> => vi.waitFor(async () => {
  const run = await host().get(projectId, runId);
  if (!['completed', 'failed', 'cancelled', 'reconcile_required'].includes(run.state)) throw new Error(`The run is still ${run.state}.`);
  return run;
}, { timeout: 60_000, interval: 100 });

/** The children the lead opened, by role, as its ledger recorded them. */
const opened = async (projectId: string) =>
  Object.fromEntries((await host().loop.ledger.read(projectId)).events
    .filter((event) => event.kind === 'opened')
    .map((event) => [(event as { role: string }).role, (event as { childRunId: string }).childRunId])) as Record<string, string>;

describe('read progress in an Agent loop (DIO-256)', () => {
  test('on the local model: the lead’s, the worker’s and the advisor’s reads reach /api/events, named by the loop', async () => {
    calls = [];
    const server = await localServer();
    const { projectId, taskId } = await open({
      localModel: { host: fakeLocalHost({ state: 'ready', mode: 'Quick', model: MEADOW_MODEL, contextTokens: 16_384 }).host,
        source: new FixedLocalModel(meadowDescriptor(server), MEADOW_FOLDER) },
    });
    await share(projectId, 'bonsai');
    const events = await openEvents();
    try {
      const started = await call<{ runId: string; session: Session }>(`/projects/${projectId}/loop/start`, 'POST', {
        protocolVersion: 1, commandId: 'dio256-local', taskId, goal: 'Check the order.', route: 'bonsai', model: 'local:quick',
        accountRoute: LOCAL_MODEL_ACCOUNT, consent: true, sources: ['order.md'], team: { worker: {}, advisor: {} },
      });
      const run = await ended(projectId, started.runId);
      expect(run.state, JSON.stringify(run.failure)).toBe('completed');
      // Plan, hand over, ask, answer: four lead calls, and one call from each child between them.
      expect(calls).toEqual(['lead', 'lead', 'child', 'lead', 'child', 'lead']);
      await vi.waitFor(() => expect(events.frames).toHaveLength(6), { timeout: 10_000, interval: 50 });
      const children = await opened(projectId);
      const loop = { projectId, threadId: `loop-${started.runId}`, requestId: started.session.id, runId: started.runId,
        kind: 'local-prompt-progress', text: 'Reading the document.', seq: 1, attempt: 1, fence: expect.any(Number) };
      // Each frame is the call's own counters, in the order the calls were made.
      expect(events.frames.map((frame) => frame.total)).toEqual([1, 2, 3, 4, 5, 6].map((n) => counters(n).total));
      expect(events.frames.map((frame) => ({ ...frame }))).toEqual([
        { ...loop, ...counters(1), childRunId: null, seat: 'lead', stepId: 'model:plan' },
        { ...loop, ...counters(2), childRunId: null, seat: 'lead', stepId: 'model:0' },
        { ...loop, ...counters(3), childRunId: children.worker, seat: 'worker', stepId: 'model:0' },
        { ...loop, ...counters(4), childRunId: null, seat: 'lead', stepId: 'model:1' },
        { ...loop, ...counters(5), childRunId: children.advisor, seat: 'advisor', stepId: 'model:0' },
        { ...loop, ...counters(6), childRunId: null, seat: 'lead', stepId: 'model:2' },
      ]);
      expect(children.worker).toEqual(expect.any(String));
      expect(children.advisor).toEqual(expect.any(String));
    } finally {
      await events.close();
    }
  });

  test('on a cloud route: no reading frames, and every call is made with the arguments it had before', async () => {
    // Each call's arguments after the request and the signal, as the stub route received them.
    const extra: unknown[][] = [];
    const stub = teamRoutes({
      loop: (request: ModelRequest) => {
        if (!request.tools.length) return { response: { type: 'final' as const, text: '1. Ask my team.\n2. Answer.' } };
        const done = toolResults(request).length;
        if (done === 0) return { response: { type: 'tool' as const, name: 'assign_workers', input: ASSIGN } } as never;
        if (done === 1) return { response: { type: 'tool' as const, name: 'consult_advisor', input: ADVISE } } as never;
        return { response: { type: 'final' as const, text: 'Done with what my team said.' } };
      },
      worker: () => ({ response: { type: 'final' as const, text: 'Order 1182 lists 100 napkins.' } }),
      advisor: () => ({ response: { type: 'final' as const, text: 'It is complete.' } }),
    });
    const routes: LoopModelRoutes = {
      ...stub,
      adapter: async (route, request, stop) => {
        const adapter = await stub.adapter(route, request, stop);
        return { ...adapter, complete: (call: ModelRequest, signal: AbortSignal, ...rest: [ModelStreamSink?]) => {
          extra.push(rest);
          return adapter.complete(call, signal, ...rest);
        } };
      },
    };
    const { projectId, taskId } = await open({ loopModelRoutes: routes });
    await store().saveSettings({ ...store().settings,
      services: { ...(store().settings.services ?? {}), 'google-vertex': true, 'google-vertexAccountRoute': TEAM_STUB_ACCOUNT_ROUTE } });
    await share(projectId, 'google-vertex');
    const emitted = vi.spyOn(store(), 'emit');
    const started = await call<{ runId: string }>(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1, commandId: 'dio256-cloud', taskId, goal: 'Check the order.', route: 'google-vertex',
      consent: true, sources: ['order.md'], team: { worker: {}, advisor: {} },
    });
    const run = await ended(projectId, started.runId);
    expect(run.state, JSON.stringify(run.failure)).toBe('completed');
    // The lead's four calls carry the H16 sink slot, empty as before; a child's two arguments, as before.
    expect(extra).toEqual([[undefined], [undefined], [], [undefined], [], [undefined]]);
    expect(emitted.mock.calls.filter(([name]) => name === 'engine-prompt-progress')).toEqual([]);
  });
});
