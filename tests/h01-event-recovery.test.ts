import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import express, { type Response, type ErrorRequestHandler } from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store.js';
import { ApiError } from '../server/paths.js';
import { createHarnessHost, type HarnessHost } from '../server/harness/host.js';
import { mountHarnessRoutes } from '../server/harness/routes.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import { FORMAT_REPORT } from '../server/harness/capabilities/format-report.js';
import type { HarnessEvent } from '../shared/harness.js';
import type { Capability } from '../server/harness/trust-port.js';
import { codexContextHash } from '../server/integrations.js';

let root: string, projectId: string, url: string, store: Store, host: HarnessHost;
let server: Server | undefined;
let denied: boolean, generation: number, calls: number;
let authorityExpiry: string;
const accountRoute = 'openai:chatgpt:event-recovery-fixture';
let stall: boolean, stalled: Response | undefined;
const connections: AbortController[] = [];
const rights = new Set<Capability>(['work.submit', 'work.cancel', 'egress.send',
  'egress.reconcile', 'write.apply', 'approval.decide', 'project.read']);

async function open() {
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  host = createHarnessHost({ store, dataDir: store.dataDir,
    currentAuthority: async () => denied
      ? { denied: true, status: 403, code: 'revoked', reason: 'Fixture authority revoked' }
      : { principal: { kind: 'prototype', id: 'fixture-reader', tenantId: null,
          projectId: null, deviceId: null, sessionId: null, slotId: null },
        generation: { identity: 1, principal: generation }, capabilities: rights,
        assurance: 'prototype', synthetic: true,
        expiresAt: authorityExpiry, resolvedAt: new Date().toISOString() },
    codexAccountRoute: async () => accountRoute,
    codexGenerator: async input => {
      const { instructions, model, effort } = input;
      if (!instructions || !model || !effort || !input.beforeDispatch)
        throw new Error('Missing fixture dispatch binding');
      await input.beforeDispatch({ accountRoute,
        contextHash: codexContextHash({ ...input, instructions, model, effort }) });
      calls++;
      return { text: JSON.stringify({ summary: 'Fixture report', changes: [
        { path: 'Harness report.md', text: '# Fixture report\n', summary: 'Fixture' },
      ] }), model: 'fixture-model', version: '0.153.4', threadId: 'fixture-transcript' };
    },
  });
  await host.init();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    const write = res.write.bind(res);
    res.write = ((...args: Parameters<Response['write']>) => {
      const accepted = write(...args);
      if (stall) { stall = false; stalled = res; return false; }
      return accepted;
    }) as Response['write'];
    next();
  });
  mountHarnessRoutes(app, store, host);
  app.use(((error, _req, res, _next) => {
    res.status(error instanceof ApiError ? error.status : 500)
      .json({ error: error.message, ...error.details });
  }) as ErrorRequestHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close() {
  if (!server) return;
  // Taken off the shared bindings before the first await, so a teardown that
  // outlives its hook can neither close nor clear the next test's server.
  const closingHost = host, closingServer = server;
  server = undefined;
  try {
    await closingHost.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => closingServer.close(error => error ? reject(error) : resolve()));
  }
}

const endpoint = (runId = 'recovery', project = projectId) =>
  `${url}/api/projects/${project}/harness/runs/${runId}/events`;
const runFile = (runId = 'recovery') =>
  path.join(store.dataDir, 'projects', projectId, 'harness', 'runs', `${runId}.json`);

async function start() {
  const principal = localHarnessPrincipal(projectId);
  await host.runs.start({ id: 'recovery', projectId, tenantId: 'local', principal,
    capability: FORMAT_REPORT, budget: { units: 100, modelCalls: 100, toolCalls: 100, wallMs: null } });
  await host.runs.claim('recovery', 'fixture-owner', 60_000);
}

async function step(id: string) {
  await host.runs.step('recovery', 'fixture-owner', { id, version: '1', kind: 'tool',
    effect: 'pure', input: {}, cost: 0 }, () => ({ id }), localHarnessPrincipal(projectId));
}

async function codexRun() {
  const project = store.state(projectId).project;
  await fs.writeFile(path.join(project.folder, 'Fixture.txt'), 'Owned fixture data.\n');
  store.settings.services = { codex: true };
  store.settings.permissions.sending = true;
  await store.saveSettings(store.settings);
  const task = await store.locked(async () => {
    const item = store.createTask(store.state(projectId), { name: 'Fixture',
      description: 'Fixture', owner: 'diomedes-with-ok' });
    await store.persist(store.state(projectId));
    return item;
  });
  await host.startCodexReport(projectId, { protocolVersion: 1, commandId: 'fixture-command',
    taskId: task.id, route: 'codex', capabilityId: 'codex-report',
    instruction: 'Summarize owned fixture data.', sources: ['Fixture.txt'], consent: true },
  { model: 'fixture-model', effort: 'low' });
  await vi.waitFor(() => expect(store.state(projectId).needs.some(n => n.state === 'open')).toBe(true),
    { timeout: 5000 });
  await host.bridge.flush();
  return store.state(projectId).needs.find(n => n.state === 'open')!.harness!.runId;
}

async function connect(target = `${endpoint()}/stream`, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  connections.push(controller);
  const response = await fetch(target, { headers, signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events: { id: number; data: HarnessEvent }[] = [];
  let ended = false;
  const done = (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue;
          expect(frame).toContain('event: harness-event');
          const id = frame.split('\n').find(line => line.startsWith('id: '));
          events.push({ id: Number(id?.slice(4)), data: JSON.parse(data.slice(6)) });
        }
      }
    } catch (error) {
      // A real dropped HTTP socket and an explicit client abort reject reads.
      if (!(error instanceof Error) || !['AbortError', 'TypeError'].includes(error.name)) throw error;
    } finally { ended = true; reader.releaseLock(); }
  })();
  const until = async (seq: number) => vi.waitFor(() => expect(events.at(-1)?.id).toBe(seq));
  return { events, until, done, ended: () => ended,
    drop: async () => { controller.abort(); await done; } };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-event-recovery-'));
  denied = false; generation = 1; calls = 0; stall = false; stalled = undefined;
  authorityExpiry = new Date(Date.now() + 60_000).toISOString();
  await open();
  projectId = (await store.locked(() => store.createProject('Event recovery fixture'))).id;
});

afterEach(async () => {
  for (const controller of connections.splice(0)) controller.abort();
  vi.restoreAllMocks();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('durable per-run HTTP event recovery', () => {
  test.each(['-1', '1.5', 'NaN', 'Infinity', '1e2', '9007199254740992', '', '1&after=2'])(
    'refuses invalid reconnect cursor %s for JSON and SSE', async raw => {
      await start();
      for (const suffix of ['', '/stream']) {
        expect((await fetch(`${endpoint()}${suffix}?after=${raw}`)).status).toBe(400);
      }
    });

  test('validates Last-Event-ID, rejects a future cursor, and refuses a foreign project/run', async () => {
    await start();
    for (const value of ['-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '1, 2'])
      expect((await fetch(`${endpoint()}/stream`, { headers: { 'Last-Event-ID': value } })).status).toBe(400);
    for (const suffix of ['', '/stream'])
      expect((await fetch(`${endpoint()}${suffix}?after=9007199254740991`)).status).toBe(409);
    const other = await store.locked(() => store.createProject('Other project'));
    expect((await fetch(`${endpoint('recovery', other.id)}/stream`)).status).toBe(404);
    expect((await fetch(`${endpoint('missing')}/stream`)).status).toBe(404);
  });

  test('replays persisted events, survives a dropped reader, and resumes without duplicates after restart', async () => {
    await start();
    const first = await connect();
    const initial = await host.get(projectId, 'recovery');
    await first.until(initial.lastSeq);
    expect(first.events.map(e => e.data)).toEqual(initial.events);
    await first.drop();
    await step('while-disconnected');
    await host.runs.complete('recovery', 'fixture-owner', { result: 'persisted' });
    const saved = await host.get(projectId, 'recovery');
    const bytes = await fs.readFile(runFile());
    await close();
    await open();
    const resumed = await connect(`${endpoint()}/stream?after=0`, { 'Last-Event-ID': String(initial.lastSeq) });
    await resumed.until(saved.lastSeq);
    expect(resumed.events.map(e => e.data)).toEqual(saved.events.slice(initial.lastSeq));
    expect(resumed.events.every(e => e.id === e.data.seq)).toBe(true);
    expect(resumed.events.filter(e => e.data.type === 'run.completed')).toHaveLength(1);
    expect(await fs.readFile(runFile())).toEqual(bytes);
    expect(calls).toBe(0);
  });

  test('subscribes before the initial snapshot and joins racing persisted saves in order', async () => {
    await start();
    let release!: () => void;
    let observed!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const seen = new Promise<void>(resolve => { observed = resolve; });
    const get = host.get;
    vi.spyOn(host, 'get').mockImplementationOnce(async (...args) => {
      const stale = await get(...args); observed(); await paused; return stale;
    });
    const connecting = connect();
    await Promise.race([seen, connecting]);
    await step('during-initial-snapshot');
    release();
    const stream = await connecting;
    await step('after-subscription');
    const saved = await get(projectId, 'recovery');
    await stream.until(saved.lastSeq);
    expect(stream.events.map(e => e.data)).toEqual(saved.events);
  });

  test('coalesces save notifications under backpressure and resumes from the last sent cursor', async () => {
    await start();
    stall = true;
    const stream = await connect();
    await vi.waitFor(() => expect(stalled).toBeDefined());
    await step('while-slow');
    await step('still-slow');
    const saved = await host.get(projectId, 'recovery');
    expect(stream.events.length).toBeLessThan(saved.events.length);
    stalled!.emit('drain');
    await stream.until(saved.lastSeq);
    expect(stream.events.map(e => e.data)).toEqual(saved.events);
  });

  test('cleans up a disconnected subscriber and host shutdown closes connected readers', async () => {
    await start();
    const listeners = store.listenerCount('settings');
    const stream = await connect();
    await stream.until((await host.get(projectId, 'recovery')).lastSeq);
    expect(store.listenerCount('settings')).toBe(listeners + 1);
    await stream.drop();
    await vi.waitFor(() => expect(store.listenerCount('settings')).toBe(listeners));
    const get = vi.spyOn(host, 'get');
    await step('after-drop');
    expect(get).not.toHaveBeenCalled();
    const second = await connect();
    await host.close();
    await vi.waitFor(() => expect(second.ended()).toBe(true));
    expect(store.listenerCount('settings')).toBe(listeners);
  });

  test('an abort while initial authorization is pending removes the subscription', async () => {
    await start();
    const listeners = store.listenerCount('settings');
    let release!: () => void;
    let observed!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const seen = new Promise<void>(resolve => { observed = resolve; });
    const get = host.get;
    const reads = vi.spyOn(host, 'get').mockImplementationOnce(async (...args) => {
      const snapshot = await get(...args); observed(); await paused; return snapshot;
    });
    const controller = new AbortController();
    const request = fetch(`${endpoint()}/stream`, { signal: controller.signal })
      .catch(error => error as Error);
    await seen;
    controller.abort();
    await request;
    await vi.waitFor(() => expect(store.listenerCount('settings')).toBe(listeners));
    release();
    await step('after-initial-abort');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  test('two readers and a restart replay the same provider observation without dispatching again', async () => {
    const runId = await codexRun();
    const before = await host.get(projectId, runId);
    const one = await connect(`${endpoint(runId)}/stream`);
    const two = await connect(`${endpoint(runId)}/stream?after=1`);
    await one.until(before.lastSeq);
    await two.until(before.lastSeq);
    expect(one.events.map(e => e.data)).toEqual(before.events);
    expect(two.events.map(e => e.data)).toEqual(before.events.slice(1));
    await one.drop(); await two.drop();
    await close(); await open();
    const saved = await host.get(projectId, runId);
    const bytes = await fs.readFile(runFile(runId));
    const replay = await connect(`${endpoint(runId)}/stream`, { 'Last-Event-ID': '1' });
    await replay.until(saved.lastSeq);
    expect(replay.events.map(e => e.data)).toEqual(saved.events.slice(1));
    expect(saved.steps.find(s => s.intent.kind === 'model')?.output)
      .toEqual(before.steps.find(s => s.intent.kind === 'model')?.output);
    expect(calls).toBe(1);
    expect(await fs.readFile(runFile(runId))).toEqual(bytes);
  });

  test('a cursor at the current tail waits for new committed events without resetting', async () => {
    await start();
    const run = await host.get(projectId, 'recovery');
    const stream = await connect(`${endpoint()}/stream?after=${run.lastSeq}`);
    await step('after-tail');
    const saved = await host.get(projectId, 'recovery');
    await stream.until(saved.lastSeq);
    expect(stream.events.map(e => e.data)).toEqual(saved.events.slice(run.lastSeq));
  });

  test('closes on unreadable persisted events without manufacturing a terminal result', async () => {
    await start();
    const stream = await connect();
    const run = await host.get(projectId, 'recovery');
    await stream.until(run.lastSeq);
    run.events[1].seq = run.events[0].seq;
    const corrupt = JSON.stringify(run);
    await fs.writeFile(runFile(), corrupt);
    store.emit('settings', store.settings);
    await vi.waitFor(() => expect(stream.ended()).toBe(true));
    expect(stream.events).toHaveLength(run.lastSeq);
    expect(stream.events.some(e => e.data.type === 'run.completed')).toBe(false);
    expect((await fetch(`${endpoint()}/stream`)).status).toBe(409);
    expect(await fs.readFile(runFile(), 'utf8')).toBe(corrupt);
  });

  test('the idle heartbeat rechecks authority without a Store notification', async () => {
    const runId = await codexRun();
    const run = await host.get(projectId, runId);
    const stream = await connect(`${endpoint(runId)}/stream`);
    await stream.until(run.lastSeq);
    denied = true;
    await vi.waitFor(() => expect(stream.ended()).toBe(true), { timeout: 17_000, interval: 100 });
    expect(stream.events).toHaveLength(run.lastSeq);
    expect(calls).toBe(1);
  });

  test.each(['revoked', 'generation', 'slow-reader'])(
    'rechecks current supported authority and terminates a %s subscription', async mode => {
      const runId = await codexRun();
      const run = await host.get(projectId, runId);
      const bytes = await fs.readFile(runFile(runId));
      stall = mode === 'slow-reader';
      const stream = await connect(`${endpoint(runId)}/stream`);
      if (stall || mode === 'slow-reader') await vi.waitFor(() => expect(stalled).toBeDefined());
      else await stream.until(run.lastSeq);
      const before = stream.events.length;
      if (mode === 'generation') generation++; else denied = true;
      store.emit('settings', store.settings);
      await vi.waitFor(() => expect(stream.ended()).toBe(true));
      expect(stream.events).toHaveLength(before);
      expect((await fetch(`${endpoint(runId)}/stream`, {
        headers: { 'Last-Event-ID': String(run.lastSeq) },
      })).status).toBe(mode === 'generation' ? 409 : 403);
      expect(await fs.readFile(runFile(runId))).toEqual(bytes);
      expect(calls).toBe(1);
    });
});
