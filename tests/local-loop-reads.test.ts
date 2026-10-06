/**
 * DIO-255: a child of a loop on the local model reads up to its profile's allowance, past the fixed
 * 24,000 characters, and a read that is cut tells the local reader so, with both sizes. A read for
 * any other route is exactly as before.
 *
 * The registry checks use a store stand-in. The loop checks run the real host with `createApp`: a
 * stub model route answers for the local model by what each call is for (the lead, a worker or the
 * advisor), and a fixture local host reports the Gaming profile running. Nothing here reaches a
 * provider or a real local model, and nothing here starts one.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { LOCAL_MODEL_CONTRACT } from '../server/engines/bonsai.js';
import { delegateRegistry, LOOP_FIXTURE_ROUTE, type LoopModelRoutes } from '../server/harness/capabilities/native-loop.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { Store } from '../server/store.js';
import type { Json, ModelRequest, ModelResponse, ModelResult } from '../shared/harness.js';
import {
  findLocalProfile,
  localContextBudget,
  localReadCutNote,
  LOCAL_MODEL_ACCOUNT,
  LOCAL_MODEL_ROUTE,
  parseLocalModelDescriptor,
} from '../shared/local-model.js';
import type { Project } from '../shared/types.js';
import { BONSAI_DESCRIPTOR, BONSAI_FOLDER, FixedLocalModel } from './fixtures/local-model.js';
import { LOCAL_GAMING, ORDER, localHost, teamFixture } from './fixtures/three-model-team.js';

vi.setConfig({ testTimeout: 90_000 });

const GAMING = findLocalProfile(parseLocalModelDescriptor(BONSAI_DESCRIPTOR, BONSAI_FOLDER), LOCAL_GAMING)!;
/** The Gaming profile's reading allowance: 36,864 characters, past the fixed 24,000. */
const ALLOWANCE = localContextBudget(GAMING).sourceChars;
/** Longer than the fixed cap and within the allowance. */
const MIDDLE = 'm'.repeat(30_000);
/** Longer than the allowance. */
const BIG = 'b'.repeat(50_000);

type Read = { path: string; found: true; sha: string; bytes: number; text: string; truncated: boolean; note?: string };

describe('a read through a child’s registry (DIO-255)', () => {
  const store = (text: string) => ({
    current: vi.fn(async () => text),
    state: () => ({ cloudSharing: { version: 1, routes: [LOCAL_MODEL_ROUTE], documents: ['ledger.txt'],
      shareConversationHistory: false, shareReviewPackets: false } }),
  }) as unknown as Store;
  const read = async (text: string, routes: string[], local: boolean) =>
    (await delegateRegistry(store(text), 'p', routes, null, local ? GAMING : undefined)
      .get('read_project_file').execute({ input: { path: 'ledger.txt' } } as never)) as Read;

  test('a local child reads past the fixed 24,000 characters, up to its profile’s allowance', async () => {
    expect(ALLOWANCE).toBe(36_864);
    const whole = await read(MIDDLE, [LOCAL_MODEL_ROUTE], true);
    expect(whole).toMatchObject({ text: MIDDLE, truncated: false });
    expect(whole).not.toHaveProperty('note');
    const cut = await read(BIG, [LOCAL_MODEL_ROUTE], true);
    expect(cut.text).toBe(BIG.slice(0, ALLOWANCE));
    expect(cut.truncated).toBe(true);
    expect(cut.note).toBe(localReadCutNote(ALLOWANCE, BIG.length));
    expect(cut.note).toBe('This read stopped at 36,864 of 50,000 characters. The rest of the file wasn’t read.');
  });

  test('a local child whose answer goes to another route keeps the fixed cap, and is told the read was cut', async () => {
    const cut = await read(MIDDLE, [LOCAL_MODEL_ROUTE, LOOP_FIXTURE_ROUTE], true);
    expect(cut.text).toBe(MIDDLE.slice(0, 24_000));
    expect(cut.note).toBe('This read stopped at 24,000 of 30,000 characters. The rest of the file wasn’t read.');
  });

  test('a child on any other route reads exactly as before: the fixed cap and no sentence', async () => {
    const before = await read(BIG, [LOOP_FIXTURE_ROUTE], false);
    expect(Object.keys(before)).toEqual(['path', 'found', 'sha', 'bytes', 'text', 'truncated']);
    expect(before).toMatchObject({ path: 'ledger.txt', found: true, bytes: 50_000, text: BIG.slice(0, 24_000), truncated: true });
  });

  test('a long local read passes the tool’s output limit that a read for any other route keeps', async () => {
    // Quotes are escaped in the recorded JSON, so this read's output is past the default 512 KB.
    const quoted = '"'.repeat(300_000);
    const full = findLocalProfile(parseLocalModelDescriptor(BONSAI_DESCRIPTOR, BONSAI_FOLDER), 'local:full')!;
    expect(localContextBudget(full).sourceChars).toBeGreaterThan(quoted.length);
    const long = await delegateRegistry(store(quoted), 'p', [LOCAL_MODEL_ROUTE], null, full)
      .get('read_project_file').execute({ input: { path: 'ledger.txt' } } as never) as Read;
    expect(long).toMatchObject({ text: quoted, truncated: false });
  });
});

// --- through the loop: the lead, a worker in its sandbox, and the advisor --------------------------------

let root: string | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let base: string;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const host = (): HarnessHost => app!.locals.harness;
const appStore = (): Store => app!.locals.store;
type Purpose = 'loop' | 'worker' | 'advisor' | 'delegate';
/** What each role's model was sent back from its first tool call, by role. */
let seen: Partial<Record<Purpose, Json>>;

const toolResults = (call: ModelRequest) => call.messages.filter((message) => message.role === 'tool');
const final = (text: string): ModelResponse => ({ type: 'final', text });
const tool = (name: string, input: Json): ModelResponse => ({ type: 'tool', name, input });

/** Each role's script: the lead reads, hands big.md to a worker and asks the advisor; each child reads one file. */
const scripts: Record<Purpose, (call: ModelRequest) => ModelResponse> = {
  loop: (call) => {
    if (!call.tools.length) return final('1. Read big.md.\n2. Hand it to a worker.\n3. Ask the advisor.');
    const done = toolResults(call);
    if (done.length === 1) seen.loop = done[0].output ?? null;
    const steps: [string, Json][] = [
      ['read_project_file', { path: 'big.md' }],
      ['assign_workers', { tasks: [{ task: 'Read big.md and say how long it is.', files: ['big.md'] }] }],
      ['consult_advisor', { question: 'Read middle.md. Is it complete?' }],
    ];
    return done.length < steps.length ? tool(...steps[done.length]) : final('Done with what the worker and the advisor said.');
  },
  worker: (call) => {
    const done = toolResults(call);
    if (!done.length) return tool('read_project_file', { path: 'big.md' });
    seen.worker = done[0].output ?? null;
    return final('It is long.');
  },
  advisor: (call) => {
    const done = toolResults(call);
    if (!done.length) return tool('read_project_file', { path: 'middle.md' });
    seen.advisor = done[0].output ?? null;
    return final('It is complete.');
  },
  delegate: () => final('Nothing to do.'),
};

/** The local model's route, answered by the scripts above. Admission keeps the model the role named. */
const localRoutes: LoopModelRoutes = {
  admit: async (_route, input) => ({ model: input.model ?? LOCAL_GAMING, accountRoute: input.accountRoute ?? LOCAL_MODEL_ACCOUNT }),
  adapter: async (route, request) => ({
    id: route,
    version: 'stub-1',
    contract: LOCAL_MODEL_CONTRACT,
    // The local route's own adapter sends nothing off this computer (createLocalAdapter).
    destination: 'local',
    capabilities: () => ({
      engineId: route, engineVersion: 'stub-1', protocolVersion: 'stub', modelCalls: 'enforced', toolCalls: 'enforced',
      filesystemWrites: 'unsupported', networkEgress: 'enforced', approvals: 'unsupported', resumability: 'observed',
      cancellability: 'observed', checkpointGranularity: 'step', notes: ['A test stub; no local server.'],
    }),
    async complete(call: ModelRequest): Promise<ModelResult> {
      const response = scripts[request.purpose as Purpose](call);
      return { response, transcript: { providerId: route, modelId: 'stub-local', lineageId: `stub-${request.runId}`,
        opaqueRef: `stub-${request.runId}-${call.messages.length}`, prefixHash: `stub-${call.messages.length}` } };
    },
  }),
};

afterEach(async () => {
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

async function call<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}

/** The first read result in a value, at any depth, for the given path. */
function readOf(value: unknown, file: string): Read | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readOf(item, file);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.path === file && 'truncated' in record) return record as unknown as Read;
    for (const item of Object.values(record)) {
      const found = readOf(item, file);
      if (found) return found;
    }
  }
  return null;
}

describe('reads in a loop on the local model (DIO-255)', () => {
  test('the advisor reads past 24,000 characters, and a worker’s read past the allowance says it was cut', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dio255-local-reads-'));
    seen = {};
    app = await createApp({
      dataDir: path.join(root, 'data'),
      projectRoot: path.join(root, 'projects'),
      reviewerAdapter: null,
      loopModelRoutes: localRoutes,
      localModel: { host: localHost(teamFixture()), source: new FixedLocalModel() },
      automationTickMs: null,
    });
    server = await new Promise<Server>((resolve) => {
      const listener = app!.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const projectId = (await call<Project>('/projects', 'POST', { name: 'Linen orders' })).id;
    const folder = appStore().state(projectId).project.folder;
    await fs.writeFile(path.join(folder, 'order.md'), ORDER);
    await fs.writeFile(path.join(folder, 'middle.md'), MIDDLE);
    await fs.writeFile(path.join(folder, 'big.md'), BIG);
    const policy = await call<{ version: number }>(`/projects/${projectId}/cloud-sharing`);
    await call(`/projects/${projectId}/cloud-sharing`, 'PUT', { expectedVersion: policy.version, routes: [LOCAL_MODEL_ROUTE],
      documents: ['order.md', 'middle.md', 'big.md'], shareConversationHistory: false, shareReviewPackets: false });
    const taskId = (await call<{ id: string }>(`/projects/${projectId}/tasks`, 'POST', { name: 'Check the files' })).id;
    const started = await call<{ runId: string }>(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1, commandId: 'dio255-reads', taskId, goal: 'Check how long the files are.',
      route: LOCAL_MODEL_ROUTE, model: LOCAL_GAMING, accountRoute: LOCAL_MODEL_ACCOUNT, consent: true,
      // The lead starts with the order; its team may read the two longer files as well.
      sources: ['order.md'], team: { scope: ['order.md', 'middle.md', 'big.md'], worker: {}, advisor: {} },
    });
    const run = await vi.waitFor(async () => {
      const current = await host().get(projectId, started.runId);
      if (!['completed', 'failed', 'cancelled', 'reconcile_required'].includes(current.state)) throw new Error(`The run is still ${current.state}.`);
      return current;
    }, { timeout: 60_000, interval: 50 });
    const steps = run.steps.map((step) => ({ id: step.intent.stepId, state: step.state, error: step.error }));
    expect(run.state, JSON.stringify({ failure: run.failure, steps, seen: Object.keys(seen) })).toBe('completed');

    // The advisor, through its own registry: the whole 30,000 characters, nothing cut.
    const advised = readOf(seen.advisor, 'middle.md');
    expect(advised).toMatchObject({ text: MIDDLE, truncated: false });
    expect(advised).not.toHaveProperty('note');
    // The worker, in its sandbox: the profile's allowance, and the sentence with both sizes.
    const worked = readOf(seen.worker, 'big.md');
    expect(worked).toMatchObject({ text: BIG.slice(0, ALLOWANCE), truncated: true,
      note: 'This read stopped at 36,864 of 50,000 characters. The rest of the file wasn’t read.' });
    // The lead's own read says the same.
    expect(readOf(seen.loop, 'big.md')).toMatchObject({ text: BIG.slice(0, ALLOWANCE), truncated: true,
      note: localReadCutNote(ALLOWANCE, BIG.length) });
  });
});
