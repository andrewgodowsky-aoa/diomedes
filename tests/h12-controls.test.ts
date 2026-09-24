/**
 * H12 → H08: a harness run's uncertain tool effect blocks Retry exactly as an
 * uncertain approved write does, through DurableControls' one uncertain-effect
 * check, and nothing is sent. Real HTTP through `createApp` for the failed run;
 * the uncertain effect comes from a real RunService record.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { Session } from '../shared/types.js';
import type { HarnessPrincipal } from '../shared/harness.js';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import { DurableControls } from '../server/durable-controls.js';
import type { WorkControl } from '../server/work-control.js';
import type { Store } from '../server/store.js';
import { FileRunStore, RunService, ToolRegistry } from '../server/harness/index.js';
import { uncertainEffectsOf } from '../server/harness/run-service.js';

let server: Server, app: Awaited<ReturnType<typeof createApp>>, temp: string, url: string, projectId: string, taskId: string;
const generator = vi.fn<NativeGenerator>(async () => {
  throw new Error('The engine went away.');
});
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

beforeEach(async () => {
  vi.stubEnv('DIOMEDES_TEST_MODE', '1');
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'h12-controls-'));
  app = await createApp({ dataDir: path.join(temp, 'data'), projectRoot: path.join(temp, 'projects'), stepMs: 20, nativeGenerator: generator });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await request('/projects/sample', 'POST', {})).data.id;
  taskId = (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Prepare the reopening', description: 'Update the menu' })).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
  await request(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['codex'],
    documents: ['Fall menu.md'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
});
afterEach(async () => {
  try {
    await app?.locals.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    vi.unstubAllEnvs();
  }
});

/** A real run record whose write effect was interrupted between intent and outcome. */
async function uncertainRun() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'h12-controls-runs-'));
  const principal: HarnessPrincipal = { id: 'local-client', tenantId: 'local', projectId, capabilities: ['write-project-file'], identityGeneration: 1 };
  const service = new RunService(new FileRunStore(dir), { clock: () => 1000 });
  const tools = new ToolRegistry();
  let reached!: () => void;
  const started = new Promise<void>((resolve) => (reached = resolve));
  tools.register({
    name: 'write_menu',
    version: '1',
    description: 'Write the menu.',
    effect: 'idempotent',
    effectClass: 'idempotent-write',
    permission: 'write-project-file',
    approval: false,
    destination: 'local',
    trustedInputRequired: false,
    cost: 0,
    limits: { timeoutMs: 1_000 },
    schema: z.strictObject({ path: z.string() }),
    outputSchema: z.strictObject({ ok: z.boolean() }),
    targets: (input) => [input.path],
    execute: () => {
      reached();
      return new Promise<{ ok: boolean }>(() => undefined);
    },
  });
  await service.start({
    id: 'r',
    tenantId: 'local',
    projectId,
    capability: { id: 'h12', version: 'v1', label: 'H12', description: 'H12', tools: ['write_menu'], requestedPermissions: [], approvalPolicy: 'show-first', maxTurns: 2, supportedPlatforms: ['win32', 'linux', 'darwin'] },
    principal,
    budget: { units: 5, modelCalls: 1, toolCalls: 5, wallMs: null },
  });
  await service.claim('r', 'host', 60_000);
  void tools.dispatch(service, { runId: 'r', owner: 'host', principal, stepId: 'menu', name: 'write_menu', input: { path: 'Fall menu.md' } }).catch(() => undefined);
  await started;
  await new RunService(new FileRunStore(dir), { clock: () => 1000 }).recover('r', principal);
  const run = await new RunService(new FileRunStore(dir), { clock: () => 1000 }).get('r');
  return { run, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('retry is refused while a harness tool effect of the run is uncertain, and nothing is sent', async () => {
  const original = (
    await request(`/projects/${projectId}/work/start`, 'POST', { protocolVersion: 1, commandId: crypto.randomUUID(), taskId, route: 'codex', consent: true, sources: ['Fall menu.md'] })
  ).data as Session;
  for (let i = 0; i < 300; i++) {
    const state = (await request(`/projects/${projectId}/state`)).data;
    if (state.sessions.find((s: Session) => s.id === original.id)?.state === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const { run, cleanup } = await uncertainRun();
  try {
    expect(uncertainEffectsOf(run)).toEqual(['The write_menu effect on Fall menu.md may have happened; its outcome was never recorded.']);
    const store = app.locals.store as Store;
    const asked: string[] = [];
    const controls = new DurableControls({
      store,
      workControl: app.locals.workControl as WorkControl,
      admit: async () => {
        throw new Error('Nothing may be admitted.');
      },
      harnessEffects: async (_projectId, session) => {
        asked.push(session.id);
        return uncertainEffectsOf(run);
      },
    });
    const calls = generator.mock.calls.length;
    const receipt = await store.locked(() =>
      controls.perform(projectId, { protocolVersion: 1, commandId: crypto.randomUUID(), taskId, control: 'retry', sessionId: original.id }),
    );
    expect(asked).toEqual([original.id]);
    expect(receipt.outcome).toBe('refused');
    expect(receipt.refusal?.code).toBe('uncertain-effects');
    expect(receipt.uncertainEffects).toEqual(['The write_menu effect on Fall menu.md may have happened; its outcome was never recorded.']);
    expect(generator.mock.calls.length).toBe(calls);
  } finally {
    await cleanup();
  }
});

test('the app wires harness effects into its controls: a run with none leaves Retry to its other checks', async () => {
  const original = (
    await request(`/projects/${projectId}/work/start`, 'POST', { protocolVersion: 1, commandId: crypto.randomUUID(), taskId, route: 'codex', consent: true, sources: ['Fall menu.md'] })
  ).data as Session;
  const controls = app.locals.durableControls as DurableControls;
  const session = (await request(`/projects/${projectId}/state`)).data.sessions.find((s: Session) => s.id === original.id) as Session;
  await expect(controls.uncertainEffects(projectId, session)).resolves.toEqual([]);
});
