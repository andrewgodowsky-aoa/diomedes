/**
 * DIO-210: a run's settle step ran after the host closed and wrote into a data folder its
 * owner had already removed. Close now waits for a settle in progress, starts none of its own,
 * and leaves the rest to the next start's recovery, which settles finished runs again.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { createHarnessHost, type HarnessHost } from '../server/harness/host.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import { NATIVE_LOOP, loopFixtureAdapter } from '../server/harness/capabilities/native-loop.js';
import type { ModelAdapter } from '../server/harness/native-agent.js';
import type { HarnessRun } from '../shared/harness.js';

let root: string, store: Store, host: HarnessHost, projectId: string;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function openHost(settled?: (run: HarnessRun) => Promise<void>, run?: (runId: string, owner: string) => Promise<void>) {
  const opened = createHarnessHost({ store, dataDir: store.dataDir });
  // A procedure registers before recovery, exactly as the host's own procedures do.
  if (settled) opened.bridge.registerProcedure({
    capability: { id: 'settle-probe', version: '1', label: 'Settle probe', description: 'Offline procedure for close tests',
      tools: [], requestedPermissions: [], approvalPolicy: 'show-first', maxTurns: 1, supportedPlatforms: ['win32', 'darwin', 'linux'] },
    engine: 'settle-probe',
    origin: { protocolVersion: 1, mode: 'application', engine: null, model: { requested: null, reported: null, source: 'not-recorded' } },
    budget: { units: 1, modelCalls: 0, toolCalls: 0, wallMs: null },
    run: async (runId, owner) => {
      await run?.(runId, owner);
      await opened.runs.complete(runId, owner, { settled: 'probe' });
    },
    settled,
  });
  await opened.init();
  return opened;
}
const start = (runId: string) => store.locked(() => host.bridge.start(projectId, null, 'settle-probe', 'Finish once.',
  localHarnessPrincipal(projectId), undefined, { runId, input: {} }));

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-settle-close-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  projectId = (await store.locked(() => store.createProject('Synthetic settle'))).id;
});
afterEach(async () => {
  await host?.close();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('close waits for a settle that is already running', async () => {
  const entered = deferred(), release = deferred();
  let finished = false;
  host = await openHost(async () => { entered.resolve(); await release.promise; finished = true; });
  await start('settle-running');
  await entered.promise;
  let closed = false;
  const closing = host.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(closed, 'close returned while a settle was still running').toBe(false);
  release.resolve();
  await closing;
  expect(finished).toBe(true);
});

test('a run that finishes while the host closes is settled by the next start, not after close', async () => {
  const finishing = deferred();
  const settledBy: string[] = [];
  host = await openHost(async () => { settledBy.push('first'); }, () => finishing.promise);
  await start('settle-at-close');
  // Let the run finish only once the bridge is closing, as an exit mid-run would.
  const bridgeClose = host.bridge.close.bind(host.bridge);
  host.bridge.close = () => { const closing = bridgeClose(); finishing.resolve(); return closing; };
  await host.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(settledBy).toEqual([]);
  host = await openHost(async () => { settledBy.push('next start'); });
  await host.bridge.flush();
  await expect.poll(() => settledBy).toEqual(['next start']);
});

test('a loop settle parked behind the startup hold returns without working when the host closes', async () => {
  host = await openHost();
  host.loop.hold();
  const ended = { id: 'R-parked-loop', projectId, capabilityId: NATIVE_LOOP.id, state: 'failed' } as unknown as HarnessRun;
  const parked = host.loop.settled!(ended).then(() => 'returned', (error: unknown) => `failed: ${String(error)}`);
  await host.close();
  const outcome = await Promise.race([parked, new Promise((resolve) => setTimeout(() => resolve('still parked'), 1_000))]);
  expect(outcome).toBe('returned');
});

test('startup-held loop runs stay inert through close and recover on the next host', async () => {
  // Exercise the provider adapter factory with a local script: no network or credentials.
  const complete = vi.fn<ModelAdapter['complete']>(async (request) => {
    if (!request.tools.length)
      return { response: { type: 'final', text: '1. List the project files.\n2. Report what was found.' } };
    if (!request.messages.some((message) => message.role === 'tool'))
      return { response: { type: 'tool', name: 'list_project_files', input: {} } };
    return { response: { type: 'final', text: 'Listed the project files.' } };
  });
  const adapter = vi.fn(async () => ({ ...loopFixtureAdapter([]), complete }));
  function heldHost() {
    host = createHarnessHost({ store, dataDir: store.dataDir });
    host.loop.setModelRoutes({ admit: async () => ({ model: 'close-probe', accountRoute: 'close-probe' }), adapter });
    host.loop.hold();
    const entered = deferred(), returned = deferred();
    const drive = host.loop.run.bind(host.loop);
    vi.spyOn(host.loop, 'run').mockImplementation(async (...args) => {
      const pending = drive(...args);
      // The real run has reached its still-held gate before close is allowed to start.
      entered.resolve();
      try { await pending; } finally { returned.resolve(); }
    });
    return { entered: entered.promise, returned: returned.promise, dispatch: vi.spyOn(host.tools, 'dispatch') };
  }
  async function restartStore() {
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
  }
  async function closeParked(probe: ReturnType<typeof heldHost>) {
    await probe.entered;
    const before = await host.runs.get('R-held-loop');
    expect(before.state).toBe('running');
    expect(before.steps).toEqual([]);
    await host.close();
    await probe.returned;
    expect(adapter).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(probe.dispatch).not.toHaveBeenCalled();
    // No cancellation, failure, completion, budget charge or new durable step on close.
    expect(await host.runs.get(before.id)).toEqual(before);
  }

  const first = heldHost();
  await host.init();
  const session = await store.locked(() => host.bridge.start(projectId, null, NATIVE_LOOP.id, 'List the project files.',
    localHarnessPrincipal(projectId), undefined, { runId: 'R-held-loop', input: {
      v: 1, kind: 'diomedes-loop', goal: 'List the project files.', route: 'google-vertex',
      model: 'close-probe', accountRoute: 'close-probe', maxTurns: 2, instructions: '', sources: [], delegate: null,
    } }));
  await closeParked(first);

  // Startup recovery launches the same saved run while routes are still held.
  await restartStore();
  const recovered = heldHost();
  await host.init();
  await closeParked(recovered);

  // A fresh host can still open the gate and execute that same run exactly once.
  await restartStore();
  const reopened = heldHost();
  await host.init();
  await reopened.entered;
  expect(adapter).not.toHaveBeenCalled();
  host.loop.open();
  await reopened.returned;
  await host.bridge.flush();
  expect(adapter).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(3);
  expect(reopened.dispatch).toHaveBeenCalledTimes(1);
  const finished = await host.runs.get('R-held-loop');
  expect(finished).toMatchObject({ state: 'completed', sessionId: session.id });
  expect(finished.steps.some((step) => step.intent.name === 'list_project_files' && step.state === 'succeeded')).toBe(true);
  expect(store.state(projectId).sessions.filter((item) => item.id === session.id)).toHaveLength(1);
});
