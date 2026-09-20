import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import express, { type ErrorRequestHandler, type Response } from 'express';
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
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import { codexContextHash } from '../server/integrations.js';
import type { Capability } from '../server/harness/trust-port.js';
import type { HarnessEvent } from '../shared/harness.js';

// Independent black-box review: real owned storage, host and HTTP sockets.
// Provider I/O, supported prototype authority and write/drain are fixtures.
let root: string, projectId: string, store: Store, host: HarnessHost, url: string;
let server: Server | undefined;
let revoked: boolean, generation: number, dispatches: number, authorityCalls: number;
let expiry: string, rights: Set<Capability>;
let stallNextEvent: boolean, stalled: Response | undefined;
const requests: AbortController[] = [];
const readLoops: Promise<void>[] = [];
const accountRoute = 'openai:chatgpt:independent-observer-fixture';
const runId = 'independent-observer';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const endpoint = (id = runId, project = projectId) =>
  `${url}/api/projects/${project}/harness/runs/${id}/events`;
const runFile = (id = runId) =>
  path.join(store.dataDir, 'projects', projectId, 'harness', 'runs', `${id}.json`);

async function open() {
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  host = createHarnessHost({ store, dataDir: store.dataDir,
    currentAuthority: async () => {
      authorityCalls++;
      return revoked
        ? { denied: true, status: 403, code: 'revoked', reason: 'Independent fixture revocation' }
        : { principal: { kind: 'prototype', id: 'independent-reader', tenantId: null,
            projectId: null, deviceId: null, sessionId: null, slotId: null },
          generation: { identity: 1, principal: generation }, capabilities: rights,
          assurance: 'prototype', synthetic: true, expiresAt: expiry,
          resolvedAt: new Date().toISOString() };
    },
    codexAccountRoute: async () => accountRoute,
    codexGenerator: async input => {
      const { instructions, model, effort } = input;
      if (!instructions || !model || !effort || !input.beforeDispatch)
        throw new Error('Missing fixture dispatch context');
      await input.beforeDispatch({ accountRoute,
        contextHash: codexContextHash({ ...input, instructions, model, effort }) });
      dispatches++;
      return { text: JSON.stringify({ summary: 'Independent fixture', changes: [
        { path: 'Harness report.md', text: '# Independent fixture\n', summary: 'Fixture' },
      ] }), model: 'independent-fixture', version: '0.153.4', threadId: 'fixture-transcript' };
    },
  });
  await host.init();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    const write = res.write.bind(res);
    res.write = ((...args: Parameters<Response['write']>) => {
      const accepted = write(...args);
      if (stallNextEvent && String(args[0]).startsWith('id: ')) {
        stallNextEvent = false; stalled = res; return false;
      }
      return accepted;
    }) as Response['write'];
    next();
  });
  mountHarnessRoutes(app, store, host);
  app.use(((error, _req, res, _next) => {
    res.status(error instanceof ApiError ? error.status : 500).json({ error: error.message });
  }) as ErrorRequestHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close() {
  if (!server) return;
  await host.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
}

async function start(id = runId, project = projectId) {
  await host.runs.start({ id, projectId: project, tenantId: 'local',
    principal: localHarnessPrincipal(project), capability: FORMAT_REPORT,
    budget: { units: 100, modelCalls: 100, toolCalls: 100, wallMs: null } });
  await host.runs.claim(id, 'independent-owner', 60_000);
}
const step = (id: string, selectedRun = runId, project = projectId) =>
  host.runs.step(selectedRun, 'independent-owner', { id, version: '1', kind: 'tool',
    effect: 'pure', input: {}, cost: 0 }, () => ({ id }), localHarnessPrincipal(project));

async function governedRun() {
  await fs.writeFile(path.join(store.state(projectId).project.folder, 'Input.txt'), 'Owned fixture.\n');
  store.settings.services = { codex: true };
  store.settings.permissions.sending = true;
  await store.saveSettings(store.settings);
  const task = await store.locked(async () => {
    const created = store.createTask(store.state(projectId), {
      name: 'Independent fixture', description: 'Fixture', owner: 'diomedes-with-ok',
    });
    await store.persist(store.state(projectId));
    return created;
  });
  await host.startCodexReport(projectId, { protocolVersion: 1, commandId: 'independent-start',
    taskId: task.id, route: 'codex', capabilityId: 'codex-report', instruction: 'Read owned fixture.',
    sources: ['Input.txt'], consent: true }, { model: 'independent-fixture', effort: 'low' });
  await vi.waitFor(() => expect(store.state(projectId).needs.some(n => n.state === 'open')).toBe(true),
    { timeout: 5000 });
  await host.bridge.flush();
  return store.state(projectId).needs.find(n => n.state === 'open')!.harness!.runId;
}

async function stream(target = `${endpoint()}/stream`, headers: Record<string, string> = {}) {
  const abort = new AbortController(); requests.push(abort);
  const response = await fetch(target, { headers, signal: abort.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events: HarnessEvent[] = [], ids: number[] = [];
  let ended = false;
  const done = (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = buffered.indexOf('\n\n')) >= 0) {
          const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
          if (frame.startsWith(':')) continue;
          const lines = frame.split('\n');
          expect(lines).toContain('event: harness-event');
          ids.push(Number(lines.find(line => line.startsWith('id: '))!.slice(4)));
          events.push(JSON.parse(lines.find(line => line.startsWith('data: '))!.slice(6)));
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !['AbortError', 'TypeError'].includes(error.name)) throw error;
    } finally { ended = true; reader.releaseLock(); }
  })();
  readLoops.push(done);
  return { events, ids, done, ended: () => ended,
    until: (seq: number) => vi.waitFor(() => expect(ids.at(-1)).toBe(seq)),
    drop: async () => { abort.abort(); await done; },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h01-independent-'));
  revoked = false; generation = 1; dispatches = 0; authorityCalls = 0;
  expiry = new Date(Date.now() + 90_000).toISOString();
  rights = new Set<Capability>(['work.submit', 'work.cancel', 'egress.send', 'egress.reconcile',
    'write.apply', 'approval.decide', 'project.read']);
  stallNextEvent = false; stalled = undefined;
  await open();
  projectId = (await store.locked(() => store.createProject('Independent observer review'))).id;
});

afterEach(async () => {
  for (const request of requests.splice(0)) request.abort();
  vi.restoreAllMocks();
  await close();
  await Promise.all(readLoops.splice(0));
  // Only remove the absolute owned temp fixture directory.
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('diomedes-h01-independent-'))
    throw new Error('Unexpected fixture cleanup path');
  await fs.rm(root, { recursive: true, force: true });
});

describe('independent H01 local observer acceptance', () => {
  test.each(['%0Aid%3A9', '%2B1', '0x10', '1e0', '-0', '1.0', '%20', '%EF%BC%91',
    '9007199254740992', '1&after=2'])(
    'rejects malicious or ambiguous cursor %s even with a valid Last-Event-ID', async cursor => {
      await start();
      expect((await fetch(`${endpoint()}/stream?after=${cursor}`,
        { headers: { 'Last-Event-ID': '0' } })).status).toBe(400);
      expect((await fetch(`${endpoint()}?after=${cursor}`)).status).toBe(400);
    });

  test.each(['', '+1', '0x10', '1e0', '1, 2', '9007199254740992'])(
    'rejects invalid Last-Event-ID %j without leaking listeners', async header => {
      await start();
      const count = store.listenerCount('settings');
      expect((await fetch(`${endpoint()}/stream?after=0`,
        { headers: { 'Last-Event-ID': header } })).status).toBe(400);
      expect(store.listenerCount('settings')).toBe(count);
    });

  test('Last-Event-ID zero overrides the URL tail; future header fails without reset', async () => {
    await start(); await step('before-connect');
    const saved = await host.get(projectId, runId);
    const reader = await stream(`${endpoint()}/stream?after=${saved.lastSeq}`, { 'Last-Event-ID': '0' });
    await reader.until(saved.lastSeq);
    expect(reader.events).toEqual(saved.events);
    expect(reader.ids).toEqual(saved.events.map(event => event.seq));
    expect((await fetch(`${endpoint()}/stream?after=0`,
      { headers: { 'Last-Event-ID': String(saved.lastSeq + 1) } })).status).toBe(409);
  });

  test('an unrelated bracketed query key cannot replace the scalar cursor', async () => {
    await start(); await step('query-key');
    const saved = await host.get(projectId, runId);
    // Express uses its simple parser: after[x] is a distinct unknown key.
    const reader = await stream(`${endpoint()}/stream?after=1&after[x]=999`);
    await reader.until(saved.lastSeq);
    expect(reader.events).toEqual(saved.events.slice(1));
    const response = await fetch(`${endpoint()}?after=1&after[x]=999`);
    expect(response.status).toBe(200);
    expect((await response.json()).events).toEqual(saved.events.slice(1));
  });

  test('a save after the first snapshot and before HTTP headers is not lost', async () => {
    await start();
    const captured = deferred(), resume = deferred();
    const get = host.get;
    vi.spyOn(host, 'get').mockImplementationOnce(async (...args) => {
      const snapshot = await get(...args); captured.resolve(); await resume.promise; return snapshot;
    });
    const opening = stream();
    await captured.promise;
    await step('between-read-and-headers');
    resume.resolve();
    const reader = await opening;
    const saved = await get(projectId, runId);
    await reader.until(saved.lastSeq);
    expect(reader.events).toEqual(saved.events);
  });

  test('duplicate and delayed notifications only replay the ordered persisted suffix', async () => {
    await start();
    const wakeups: (() => void)[] = [];
    const subscribe = host.subscribe;
    vi.spyOn(host, 'subscribe').mockImplementation((id, changed, closed) => {
      wakeups.push(changed); return subscribe(id, changed, closed);
    });
    const reader = await stream();
    await reader.until((await host.get(projectId, runId)).lastSeq);
    await step('first-save');
    await step('second-save');
    for (let i = 0; i < 20; i++) wakeups[0]();
    const saved = await host.get(projectId, runId);
    await reader.until(saved.lastSeq);
    await reader.drop();
    expect(reader.events).toEqual(saved.events);
    expect(new Set(reader.ids).size).toBe(reader.ids.length);
  });

  test.each(['duplicate', 'out-of-order'])(
    'a %s persisted sequence is refused, not streamed as a second terminal result', async mode => {
      await start(); await step('before-corruption');
      const reader = await stream();
      const saved = await host.get(projectId, runId);
      await reader.until(saved.lastSeq);
      if (mode === 'duplicate') saved.events[1].seq = saved.events[0].seq;
      else [saved.events[0], saved.events[1]] = [saved.events[1], saved.events[0]];
      const bytes = JSON.stringify(saved);
      await fs.writeFile(runFile(), bytes);
      store.emit('settings', store.settings);
      await vi.waitFor(() => expect(reader.ended()).toBe(true));
      expect(reader.events).toHaveLength(saved.lastSeq);
      expect((await fetch(`${endpoint()}/stream`)).status).toBe(409);
      expect(await fs.readFile(runFile(), 'utf8')).toBe(bytes);
    });

  test('save notification follows disk persistence and a failed write has no observation', async () => {
    await start();
    const observed: Promise<number>[] = [];
    const unsubscribe = host.subscribe(runId, () => {
      observed.push(fs.readFile(runFile(), 'utf8').then(bytes => JSON.parse(bytes).lastSeq as number));
    }, () => {});
    const before = (await host.get(projectId, runId)).lastSeq;
    await step('committed');
    expect(observed.length).toBeGreaterThan(0);
    expect((await Promise.all(observed)).every(seq => seq > before)).toBe(true);
    const count = observed.length;
    const bytes = await fs.readFile(runFile());
    vi.spyOn(FileRunStore.prototype, 'write').mockRejectedValueOnce(new Error('Independent disk failure'));
    await expect(step('failed-save')).rejects.toThrow('Independent disk failure');
    expect(observed).toHaveLength(count);
    expect(await fs.readFile(runFile())).toEqual(bytes);
    unsubscribe();
  });

  test('run and project scope stay separate for live events and cursor continuation', async () => {
    await start();
    const other = (await store.locked(() => store.createProject('Other scope'))).id;
    await start('other-run', other);
    const saved = await host.get(projectId, runId);
    const reader = await stream(); await reader.until(saved.lastSeq);
    await step('foreign-event', 'other-run', other);
    await step('same-run-event');
    const latest = await host.get(projectId, runId);
    await reader.until(latest.lastSeq);
    expect(reader.events).toEqual(latest.events);
    expect((await fetch(`${endpoint(runId, other)}/stream?after=0`)).status).toBe(404);
    expect((await fetch(`${endpoint('other-run')}/stream?after=0`)).status).toBe(404);
    expect((await fetch(`${endpoint('../escape')}/stream`)).status).toBe(404);
  });

  test('revocation between initial admission and first replay emits no saved event', async () => {
    const id = await governedRun();
    const get = host.get;
    vi.spyOn(host, 'get').mockImplementationOnce(async (...args) => {
      const snapshot = await get(...args); revoked = true; return snapshot;
    });
    const reader = await stream(`${endpoint(id)}/stream`);
    await vi.waitFor(() => expect(reader.ended()).toBe(true));
    expect(reader.events).toHaveLength(0);
    expect(dispatches).toBe(1);
  });

  test.each(['capability', 'expiry', 'generation'])(
    '%s withdrawal blocks both replay and pending backpressure drain', async reason => {
      const id = await governedRun();
      const bytes = await fs.readFile(runFile(id));
      stallNextEvent = true;
      const reader = await stream(`${endpoint(id)}/stream`);
      await vi.waitFor(() => expect(stalled).toBeDefined());
      await reader.until(1);
      if (reason === 'capability') rights.delete('project.read');
      else if (reason === 'expiry') expiry = new Date(0).toISOString();
      else generation++;
      stalled!.emit('drain');
      await vi.waitFor(() => expect(reader.ended()).toBe(true));
      expect(reader.ids).toEqual([1]);
      expect((await fetch(`${endpoint(id)}/stream`, { headers: { 'Last-Event-ID': '1' } })).status)
        .toBe(reason === 'generation' ? 409 : 403);
      expect(await fs.readFile(runFile(id))).toEqual(bytes);
      expect(dispatches).toBe(1);
    });

  test('idle read authority is rechecked without any event or settings notification', async () => {
    const id = await governedRun();
    const saved = await host.get(projectId, id);
    const reader = await stream(`${endpoint(id)}/stream`); await reader.until(saved.lastSeq);
    const count = authorityCalls;
    revoked = true;
    await vi.waitFor(() => expect(reader.ended()).toBe(true), { timeout: 17_000, interval: 100 });
    expect(authorityCalls).toBeGreaterThan(count);
    expect(reader.events).toEqual(saved.events);
    expect(dispatches).toBe(1);
  });

  test('a disconnected stalled reader never resumes and releases Store and response listeners', async () => {
    await start();
    const settings = store.listenerCount('settings'), changes = store.listenerCount('change');
    stallNextEvent = true;
    const reader = await stream(); await vi.waitFor(() => expect(stalled).toBeDefined());
    await reader.until(1); await reader.drop();
    await vi.waitFor(() => expect(store.listenerCount('settings')).toBe(settings));
    expect(store.listenerCount('change')).toBe(changes);
    expect(stalled!.listenerCount('drain')).toBe(0);
    const get = vi.spyOn(host, 'get');
    stalled!.emit('drain'); await step('after-disconnect');
    expect(get).not.toHaveBeenCalled();
    expect(reader.ids).toEqual([1]);
  });

  test('a slow reader drains an exact ordered suffix after many committed saves', async () => {
    await start();
    stallNextEvent = true;
    const reader = await stream(); await vi.waitFor(() => expect(stalled).toBeDefined());
    await reader.until(1);
    for (let i = 0; i < 8; i++) await step(`slow-${i}`);
    const saved = await host.get(projectId, runId);
    expect(reader.ids).toEqual([1]);
    stalled!.emit('drain'); await reader.until(saved.lastSeq);
    expect(reader.events).toEqual(saved.events);
    expect(reader.ids).toEqual(saved.events.map(event => event.seq));
  });

  test('host shutdown interrupts a pending first read and refuses a new stream without a leak', async () => {
    await start();
    const settings = store.listenerCount('settings');
    const captured = deferred(), resume = deferred();
    const get = host.get;
    vi.spyOn(host, 'get').mockImplementationOnce(async (...args) => {
      const snapshot = await get(...args); captured.resolve(); await resume.promise; return snapshot;
    });
    const request = fetch(`${endpoint()}/stream`).then(response => response.status, () => 'closed');
    await captured.promise; await host.close(); resume.resolve();
    expect(await request).toBe('closed');
    expect(store.listenerCount('settings')).toBe(settings);
    expect((await fetch(`${endpoint()}/stream`)).status).toBe(503);
    expect(store.listenerCount('settings')).toBe(settings);
  });

  test('two observers reconnect after restart with identical historical attribution and zero redispatch', async () => {
    const id = await governedRun();
    const before = await host.get(projectId, id);
    const one = await stream(`${endpoint(id)}/stream`);
    const two = await stream(`${endpoint(id)}/stream?after=1`);
    await one.until(before.lastSeq); await two.until(before.lastSeq);
    expect(one.events).toEqual(before.events); expect(two.events).toEqual(before.events.slice(1));
    await one.drop(); await two.drop(); await close(); await open();
    const after = await host.get(projectId, id), bytes = await fs.readFile(runFile(id));
    const resumed = await stream(`${endpoint(id)}/stream?after=0`, { 'Last-Event-ID': '1' });
    await resumed.until(after.lastSeq);
    expect(resumed.events).toEqual(after.events.slice(1));
    expect(after.events.slice(0, before.events.length)).toEqual(before.events);
    expect(after.steps.filter(item => item.intent.kind === 'model'))
      .toEqual(before.steps.filter(item => item.intent.kind === 'model'));
    expect(dispatches).toBe(1);
    expect(await fs.readFile(runFile(id))).toEqual(bytes);
  });

  test('restart test diagnosis: elapsed time cannot prove that an effect was persisted', async () => {
    const files = new FileRunStore(path.join(root, 'delayed-commit'));
    const service = new RunService(files, { clock: () => 1000 });
    const person = localHarnessPrincipal(projectId);
    await service.start({ id: 'delayed', projectId, tenantId: 'local', principal: person,
      capability: FORMAT_REPORT, budget: { units: 20, modelCalls: 10, toolCalls: 10, wallMs: null } });
    await service.claim('delayed', 'first-owner', 100);
    const enteringWrite = deferred(), abandon = deferred();
    const handler = vi.fn(() => 'effect');
    vi.spyOn(files, 'write').mockImplementationOnce(async () => {
      enteringWrite.resolve(); await abandon.promise;
      throw new Error('Abandoned before dispatch persistence');
    });
    const pending = service.step('delayed', 'first-owner', { id: 'egress', version: '1',
      kind: 'tool', effect: 'non-idempotent', input: {}, cost: 0 }, handler, person)
      .then(() => 'unexpected-success', (error: Error) => error.message);
    await enteringWrite.promise;
    await new Promise(resolve => setTimeout(resolve, 75));
    const restarted = new RunService(new FileRunStore(files.dir), { clock: () => 2000 });
    await restarted.recover('delayed', person);
    expect((await restarted.get('delayed')).state).toBe('queued');
    expect(handler).not.toHaveBeenCalled();
    abandon.resolve();
    expect(await pending).toBe('Abandoned before dispatch persistence');
  });

  test('restart after confirmed handler entry parks the persisted effect without terminal output', async () => {
    const files = new FileRunStore(path.join(root, 'confirmed-dispatch'));
    const service = new RunService(files, { clock: () => 1000 });
    const person = localHarnessPrincipal(projectId);
    await service.start({ id: 'confirmed', projectId, tenantId: 'local', principal: person,
      capability: FORMAT_REPORT, budget: { units: 20, modelCalls: 10, toolCalls: 10, wallMs: null } });
    await service.claim('confirmed', 'first-owner', 100);
    const entered = deferred(), finish = deferred();
    const handler = vi.fn(async () => { entered.resolve(); await finish.promise; return 'late'; });
    const pending = service.step('confirmed', 'first-owner', { id: 'egress', version: '1',
      kind: 'tool', effect: 'non-idempotent', input: {}, cost: 0 }, handler, person)
      .then(() => 'unexpected-success', (error: Error) => error.message);
    await entered.promise;
    expect((await files.read('confirmed'))!.steps[0].state).toBe('running');
    const restarted = new RunService(new FileRunStore(files.dir), { clock: () => 2000 });
    await restarted.recover('confirmed', person);
    const saved = await restarted.get('confirmed');
    expect(saved.state).toBe('reconcile_required');
    expect(saved.steps[0].state).toBe('reconcile_required');
    expect(saved.events.some(event => event.type === 'step.reconcile_required')).toBe(true);
    expect(saved.events.some(event => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))).toBe(false);
    finish.resolve(); expect(await pending).not.toBe('unexpected-success');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await restarted.get('confirmed')).toEqual(saved);
  });
});
