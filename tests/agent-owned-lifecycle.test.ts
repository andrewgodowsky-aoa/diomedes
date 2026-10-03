/**
 * Independent production lifecycle acceptance. createApp, EngineService, the real SDK,
 * RunService, H14 sandbox/handoff, account binding, and spend ledger remain intact.
 * Only provider HTTP is replaced below the SDK. No fixture credential reaches a network.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { loopRunId } from '../server/native-loop-routes.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { Store } from '../server/store.js';
import type { HarnessRun } from '../shared/harness.js';
import type { OpenRouterConnectionView } from '../shared/model-api.js';
import type { Session } from '../shared/types.js';
import { micro } from '../shared/managed-usage.js';
import { openRouterRateCard } from '../server/engines/openrouter.js';
import { chatEvents, sseResponse } from './fixtures/model-api-streams.js';

const MODEL = 'openai/gpt-6.1-sol';
const KEY = 'sk-or-independent-fixture-0123456789abcdef-never-real';
const INVENTORY = 'A: expected 10, counted 10.\nB: expected 8, counted 6.\n';
const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
// Keep this exact list aligned with the offline qualification environment manifest.
// Apply it only to our owned crash-boundary subprocess, never the parent or user profile.
const OFFLINE_ENV_REMOVALS = new Set([
  'NECTOVIA_ACCOUNT_SERVICE', 'NECTOVIA_FAUX_BEDROCK_API_KEY', 'NECTOVIA_FAUX_OPENROUTER_API_KEY',
  'CP_TEST_DATABASE_URL', 'CP_ROUTING_TEST_DATABASE_URL', 'CP_TEST_ALLOW_SCHEMA_RESET',
  'CP_APPROVED_ISOLATED_BRANCH', 'CP_TEST_EXPECTED_HOST', 'CP_TEST_BRANCH_ID', 'DATABASE_URL',
  'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE',
  'AZURE_API_KEY', 'AZURE_RESOURCE_NAME', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_API_KEY',
  'GOOGLE_VERTEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION',
  'WORKOS_API_KEY', 'CODEX_HOME', 'CP_EVIDENCE_DIRECTORY', 'PLAYWRIGHT_EXECUTABLE_PATH',
  'TEST_WORKER_INDEX', 'VITEST_WORKER_ID', 'NODE_OPTIONS', 'WRANGLER_SEND_METRICS',
]);
type Item = Record<string, unknown>;
type Purpose = 'root' | 'worker' | 'delegate';
type Seen = { url: string; body: Item; purpose: Purpose };
let dir: string, projectId: string, taskId: string, base: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined, service: EngineService;
let connection: OpenRouterConnectionView['connection'];
let seen: Seen[], mode: 'finish' | 'hold-child' | 'hold-root' | 'cap' | 'hold-cap-child', branch: 'worker' | 'delegate';
let held: { release: () => void; signal: AbortSignal | undefined } | undefined;
let childProcess: ChildProcess | undefined;
const store = () => app.locals.store as Store;
const host = () => app.locals.harness as HarnessHost;
const state = () => store().state(projectId);

const tools = (body: Item) => ((body.tools ?? []) as { function?: { name?: string } }[]).flatMap(tool => tool.function?.name ? [tool.function.name] : []);
const resultCount = (body: Item) => ((body.messages ?? []) as Item[]).filter(message => message.role === 'tool').length;
const purpose = (body: Item): Purpose => {
  const serialized = JSON.stringify(body.messages);
  return serialized.includes('You are a worker given one bounded task') ? 'worker'
    : serialized.includes('You are a helper given one bounded sub-task') ? 'delegate' : 'root';
};

function answer(text: string, tool?: { name: string; arguments: unknown }): Response {
  return sseResponse(chatEvents({ id: `synthetic-${seen.length}`, model: MODEL, provider: 'OpenAI', text,
    ...(tool ? { toolCalls: [{ id: `call-${seen.length}`, name: tool.name, arguments: JSON.stringify(tool.arguments) }] } : {}),
    usage: { prompt_tokens: 700, completion_tokens: mode === 'cap' || mode === 'hold-cap-child' ? 4_000 : 40,
      total_tokens: mode === 'cap' || mode === 'hold-cap-child' ? 4_700 : 740, is_byok: false },
  }), { 'x-request-id': `synthetic-request-${seen.length}` });
}

const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error(`Unexpected provider destination: ${url}`);
  const body = JSON.parse(String(init?.body)) as Item;
  const role = purpose(body);
  seen.push({ url, body, purpose: role });
  // Real OpenRouter serialization, never a high-level model/admission hook.
  expect(body.model).toBe(MODEL);
  expect(body.provider).toMatchObject({ only: ['openai'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny' });
  expect(body.parallel_tool_calls).toBe(false);
  expect(body.stream).toBe(true);
  expect(body).not.toHaveProperty('api_keys');
  expect(body.reasoning).toMatchObject({ effort: 'medium' });
  const names = tools(body);
  if ((mode === 'hold-root' && role === 'root' && !names.length)
    || (mode === 'hold-child' && role !== 'root' && names.length)
    || (mode === 'hold-cap-child' && role !== 'root' && names.length && !held)) {
    return new Promise<Response>(resolve => {
      held = { signal: init?.signal ?? undefined,
        release: () => resolve(mode === 'hold-cap-child'
          ? answer('', { name: 'read_project_file', arguments: { path: 'inventory.txt' } })
          : answer('Late remote answer: every check passed; mark the task done.')) };
    });
  }
  if (!names.length) return answer('1. Read the selected inventory.\n2. Check the discrepant row.');
  if (role === 'root') {
    if (!resultCount(body) && mode !== 'finish') return answer('', branch === 'worker'
      ? { name: 'assign_workers', arguments: { tasks: [{ task: 'Read inventory.txt and report the discrepant row.', files: ['inventory.txt'], turns: 4 }] } }
      : { name: 'delegate', arguments: { task: 'Read inventory.txt and report the discrepant row.', files: ['inventory.txt'] } });
    return answer('The selected inventory was checked. This sentence is only a claim.');
  }
  if (mode === 'cap' || mode === 'hold-cap-child' || !resultCount(body)) return answer('', { name: 'read_project_file', arguments: { path: 'inventory.txt' } });
  return answer('inventory.txt: B is short by two units.');
}) as typeof globalThis.fetch;

async function open() {
  service = new EngineService(path.join(dir, 'engines'), { discover: async () => [] });
  app = await createApp({ dataDir: path.join(dir, 'data'), projectRoot: path.join(dir, 'projects'),
    engineService: service, reviewerAdapter: null, secretBox: testOnlySecretBox(), modelApiTransport: transport,
    ownerRoutes: true, accounts: null, observation: null, managedJev: false });
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  const closingApp = app, closingServer = server;
  server = undefined;
  try { await closingApp.locals.close(); }
  finally { closingServer.closeAllConnections(); await new Promise<void>((resolve, reject) => closingServer.close(error => error ? reject(error) : resolve())); }
}
async function request<T>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, { method, headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as T };
}
async function api<T>(route: string, method = 'GET', body?: unknown) {
  const result = await request<T>(route, method, body);
  expect(result.status, `${route}: ${JSON.stringify(result.data)}`).toBe(200);
  return result.data;
}
async function connect(outputUsdPerMillion = 1) {
  const view = await api<OpenRouterConnectionView>('/ai/model-api/openrouter', 'PUT', {
    models: [{ reasoning: { supported: ['low', 'medium', 'high'], source: 'Synthetic SDK fixture declaration; not live qualification' }, id: MODEL, upstreams: ['openai'], rates: { inputUsdPerMillion: 1, outputUsdPerMillion,
      cacheReadUsdPerMillion: null, cacheWriteUsdPerMillion: null, source: 'synthetic declared rates for offline boundary tests' } }],
    apiKey: KEY, expiresAt: null, consent: true,
  });
  expect(view.connection).not.toBeNull();
  connection = view.connection;
  await api('/ai/model-api/openrouter/spend-limit', 'PUT', { capUsd: 100, consent: true });
}
function body(commandId: string, kind?: 'worker' | 'delegate') {
  const selected = { route: 'openrouter', model: MODEL, accountRoute: connection!.accountRoute };
  return { protocolVersion: 1, commandId, taskId, goal: 'Reconcile the selected inventory and report the discrepancy.',
    ...selected, effort: 'medium', sources: ['inventory.txt'], consent: true, maxTurns: 8,
    ...(kind === 'worker' ? { team: { worker: { ...selected, budget: { turns: 4 } }, advisor: null } }
      : kind === 'delegate' ? { delegate: selected } : {}),
  };
}
async function start(commandId: string, kind?: 'worker' | 'delegate') {
  const started = await api<{ runId: string; session: Session; replayed: boolean }>(`/projects/${projectId}/loop/start`, 'POST', body(commandId, kind));
  expect(started.session.engine.name).toBe('diomedes-loop');
  return started;
}
async function until(id: string, expected: HarnessRun['state']) {
  await vi.waitFor(async () => expect((await host().get(projectId, id)).state).toBe(expected), { timeout: 12_000 });
  await host().bridge.flush();
  return host().get(projectId, id);
}
async function actualChild(rootId: string) {
  let child: HarnessRun | undefined;
  await vi.waitFor(async () => {
    child = (await host().list(projectId)).find(run => run.id !== rootId &&
      ['diomedes-loop-worker', 'diomedes-loop-delegate'].includes(run.capabilityId));
    expect(child, 'the production host created a real H14 child').toBeDefined();
  }, { timeout: 12_000 });
  return child!;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-independent-lifecycle-'));
  seen = []; mode = 'finish'; branch = 'worker'; held = undefined;
  await open();
  projectId = (await api<{ id: string }>('/projects', 'POST', { name: 'Synthetic inventory' })).id;
  await fs.writeFile(path.join(state().project.folder, 'inventory.txt'), INVENTORY);
  await api(`/projects/${projectId}/cloud-sharing`, 'PUT', { expectedVersion: 0, routes: ['openrouter'], documents: ['inventory.txt'],
    shareConversationHistory: false, shareReviewPackets: false });
  taskId = await store().locked(async () => {
    const task = store().createTask(state(), { name: 'Reconcile synthetic inventory' });
    await store().persist(state()); return task.id;
  });
  await connect();
});
afterEach(async () => {
  held?.release();
  if (childProcess && childProcess.exitCode === null) childProcess.kill();
  childProcess = undefined;
  await close();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('production loop and H14 boundaries through a captured SDK transport', () => {
  test.each(['worker', 'delegate'] as const)('ordinary Stop fences the real %s, aborts its HTTP read and rejects a late answer', async kind => {
    mode = 'hold-child'; branch = kind;
    const started = await start(`stop-real-${kind}`, kind);
    const child = await actualChild(started.runId);
    await vi.waitFor(() => expect(held, 'child reached the SDK HTTP dispatch').toBeDefined(), { timeout: 12_000 });
    const before = seen.length;
    const stop = await request<Session>(`/projects/${projectId}/work/${started.session.id}/stop`, 'POST', {});
    expect(stop.status, JSON.stringify(stop.data)).toBe(200);
    await until(started.runId, 'cancelled');
    await until(child.id, 'cancelled');
    expect(held!.signal?.aborted).toBe(true);
    held!.release();
    await host().bridge.flush();
    const after = await host().get(projectId, child.id);
    expect(after.sessionId).toBeNull();
    expect(after.result).toBeNull();
    expect(after.steps.some(step => step.intent.kind === 'model' && step.state === 'reconcile_required')).toBe(true);
    expect(state().tasks.find(task => task.id === taskId)!.state).not.toBe('done');
    expect(state().needs).toHaveLength(0);
    expect(seen).toHaveLength(before);
    const holds = service.modelApi!.exposure.list(connection!.id).filter(row => row.attempt.runId === child.id);
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.some(row => row.state === 'pending' || row.state === 'uncertain')).toBe(true);
    expect(holds.every(row => row.state !== 'released')).toBe(true);
    expect(state().sessions.filter(session => session.taskId === taskId)).toHaveLength(1);
  });

  test('H14 calls share the root cap and refuse the next serialized send before it would exceed it', async () => {
    await connect(100); // Synthetic cost: 4,000 reported output tokens cost $0.40 per completed call.
    mode = 'cap'; branch = 'worker';
    const started = await start('root-cap-real-h14', 'worker');
    const child = await actualChild(started.runId);
    await vi.waitFor(async () => expect(['failed', 'cancelled', 'reconcile_required']).toContain((await host().get(projectId, child.id)).state), { timeout: 12_000 });
    const rows = service.modelApi!.exposure.list(connection!.id).filter(row => [started.runId, child.id].includes(row.attempt.runId));
    expect(rows.some(row => row.attempt.runId === child.id)).toBe(true);
    const jobs = new Set(rows.map(row => row.jobId));
    expect(jobs.size, 'a child may not mint an independently replenished job cap').toBe(1);
    const rootJob = [...jobs][0]!;
    expect(rootJob).not.toBeNull();
    expect(service.modelApi!.exposure.jobUsed(rootJob!)).toBeLessThanOrEqual(2_000_000);
    expect(seen.length, 'four real serialized provider calls leave less than another $0.40+ hold in Efficient’s $2 cap').toBeLessThanOrEqual(4);
    expect(state().tasks.find(task => task.id === taskId)!.state).not.toBe('done');
    const stoppedChild = await host().get(projectId, child.id);
    expect(stoppedChild.failure).toMatchObject({ code: 'openrouter_job_cap_reached', message: expect.stringContaining('cap') });
  });

  test('a changed account during a real dispatched call refuses its result with the exact account code', async () => {
    mode = 'hold-root';
    const started = await start('account-result-fence', 'worker');
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 12_000 });
    const before = seen.length;
    await connect(); // The real setup route writes a new connection revision and account binding.
    held!.release();
    const run = await until(started.runId, 'reconcile_required');
    expect(run.events.some(event => event.attributes.errorCode === 'ACCOUNT_CHANGED')).toBe(true);
    expect(run.steps.find(step => step.intent.stepId === 'model:plan')!.output).toBeNull();
    expect(run.result).toBeNull();
    expect(seen).toHaveLength(before);
    expect((await host().list(projectId)).filter(item => item.id !== run.id && item.taskId === taskId)).toHaveLength(0);
    expect(state().tasks.find(task => task.id === taskId)!.state).not.toBe('done');
  });

  test('a real H14 child cannot drain parent headroom after its existing ledger is downscoped', async () => {
    // This independently exercises the existing ledger guard against a real SDK child.
    // Automatic selector/factory binding needs separate normal-entry acceptance.
    await connect(100);
    mode = 'hold-cap-child'; branch = 'worker';
    const started = await start('worker-cannot-drain-parent-reserve', 'worker');
    const child = await actualChild(started.runId);
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 12_000 });
    const root = await host().get(projectId, started.runId);
    const input = root.input as unknown as { rootJobRequestId?: string; threadId?: string | null };
    const ledger = await service.rootJobLedger(projectId, input.rootJobRequestId ?? root.id, input.threadId ?? null);
    const jobId = ledger.jobScope!.id;
    expect(service.modelApi!.exposure.list(connection!.id).every(row => row.jobId === jobId)).toBe(true);
    await ledger.limitRunBudget(child.id, micro(500_000), jobId);
    await ledger.limitRunBudget(child.id, micro(500_000), jobId); // Idempotent, never replenishes a role.
    await expect(ledger.limitRunBudget(child.id, micro(600_000), jobId)).rejects.toMatchObject({ code: 'run_budget_changed' });
    await expect(ledger.limitRunBudget(child.id, micro(500_000), 'job-' + 'f'.repeat(40)))
      .rejects.toMatchObject({ code: 'invalid_job' });
    held!.release();
    await vi.waitFor(async () => expect((await host().get(projectId, child.id)).steps.some(step =>
      step.error?.code === 'openrouter_spend_refused' && step.error.message.includes('allocation'))).toBe(true), { timeout: 12_000 });
    expect(seen.filter(call => call.purpose === 'worker')).toHaveLength(1);
    const rows = service.modelApi!.exposure.list(connection!.id).filter(row => row.attempt.runId === child.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId, state: 'settled', settledMicroUsd: 400_700 });
    expect(ledger.jobUsed(jobId)).toBeLessThan(1_300_000);
    expect(ledger.jobScope!.capMicroUsd - ledger.jobUsed(jobId)).toBeGreaterThan(500_000);
    expect(state().tasks.find(task => task.id === taskId)!.state).not.toBe('done');
  });

  test('unknown real child exposure still counts after restart and the same role rebind cannot refund it', async () => {
    await connect(100);
    mode = 'hold-cap-child'; branch = 'worker';
    const started = await start('unknown-role-reserve', 'worker');
    const child = await actualChild(started.runId);
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 12_000 });
    const root = await host().get(projectId, started.runId);
    const input = root.input as unknown as { rootJobRequestId?: string; threadId?: string | null };
    let ledger = await service.rootJobLedger(projectId, input.rootJobRequestId ?? root.id, input.threadId ?? null);
    const jobId = ledger.jobScope!.id;
    await ledger.limitRunBudget(child.id, micro(500_000), jobId);
    await api(`/projects/${projectId}/work/${started.session.id}/stop`, 'POST', {});
    await until(child.id, 'cancelled');
    held!.release();
    await close();
    await open();
    ledger = await service.rootJobLedger(projectId, input.rootJobRequestId ?? root.id, input.threadId ?? null);
    await ledger.limitRunBudget(child.id, micro(500_000), jobId);
    const rows = service.modelApi!.exposure.list(connection!.id).filter(row => row.attempt.runId === child.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId, state: 'uncertain' });
    expect(rows[0]!.maxMicroUsd).toBeGreaterThan(300_000);
    const live = await service.modelApi!.openrouter!.connections.read();
    const card = openRouterRateCard(live!, MODEL);
    const before = seen.length;
    await expect(ledger.reserve({ connectionId: connection!.id, route: 'openrouter', modelId: MODEL, card,
      attempt: { runId: child.id, stepId: 'next-role-attempt-after-restart', attempt: 1,
        requestDigest: 'a'.repeat(64) }, maxMicroUsd: micro(200_000) }))
      .rejects.toMatchObject({ code: 'run_budget_reached', jobId, runId: child.id, capMicroUsd: 500_000 });
    expect(service.modelApi!.exposure.list(connection!.id).filter(row => row.attempt.runId === child.id)).toEqual(rows);
    const replay = await api<{ runId: string; replayed: boolean }>(`/projects/${projectId}/loop/start`, 'POST', body('unknown-role-reserve', 'worker'));
    expect(replay).toMatchObject({ runId: root.id, replayed: true });
    expect(seen).toHaveLength(before);
    expect(state().tasks.find(task => task.id === taskId)!.state).not.toBe('done');
  });

  test('revoked source sharing refuses before any adapter/SDK dispatch', async () => {
    await api(`/projects/${projectId}/cloud-sharing`, 'PUT', { expectedVersion: state().cloudSharing!.version,
      routes: ['openrouter'], documents: [], shareConversationHistory: false, shareReviewPackets: false });
    const refused = await request<{ code: string }>(`/projects/${projectId}/loop/start`, 'POST', body('source-refused', 'worker'));
    expect(refused).toMatchObject({ status: 403, data: { code: 'cloud_sharing_denied' } });
    expect(seen).toHaveLength(0);
    expect(await host().list(projectId)).toHaveLength(0);
    expect(service.modelApi!.exposure.list(connection!.id)).toHaveLength(0);
  });

  test('concurrent identical native commands reuse one root, Session and provider call sequence', async () => {
    const input = body('concurrent-root');
    const results = await Promise.all([0, 1].map(() => request<{ runId: string; replayed: boolean }>(`/projects/${projectId}/loop/start`, 'POST', input)));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(new Set(results.map(result => result.data.runId)).size).toBe(1);
    expect(results.filter(result => result.data.replayed)).toHaveLength(1);
    await until(results[0]!.data.runId, 'completed');
    expect(state().sessions.filter(session => session.taskId === taskId)).toHaveLength(1);
    expect(await host().list(projectId)).toHaveLength(1);
    expect(seen).toHaveLength(2); // One planning call and one final claim, both real SDK exchanges.
    const conflict = await request<{ code: string }>(`/projects/${projectId}/loop/start`, 'POST', { ...input, goal: 'A different goal.' });
    expect(conflict).toMatchObject({ status: 409, data: { code: 'loop_command_conflict' } });
    expect(seen).toHaveLength(2);
  });

  test('a real process exit after provider dispatch preserves intent/exposure and restart never resends it', async () => {
    const command = 'crash-after-real-dispatch';
    const startBody = body(command);
    await close();
    const appUrl = pathToFileURL(path.resolve('server/app.ts')).href;
    const engineUrl = pathToFileURL(path.resolve('server/engines/service.ts')).href;
    const secretUrl = pathToFileURL(path.resolve('server/connection-secrets.ts')).href;
    const program = `import {createApp} from ${JSON.stringify(appUrl)};
import {EngineService} from ${JSON.stringify(engineUrl)};
import {testOnlySecretBox} from ${JSON.stringify(secretUrl)};
const app=await createApp({dataDir:${JSON.stringify(path.join(dir, 'data'))},projectRoot:${JSON.stringify(path.join(dir, 'projects'))},engineService:new EngineService(${JSON.stringify(path.join(dir, 'engines'))},{discover:async()=>[]}),reviewerAdapter:null,secretBox:testOnlySecretBox(),ownerRoutes:true,accounts:null,observation:null,managedJev:false,modelApiTransport:async(input)=>{const url=typeof input==='string'||input instanceof URL?String(input):input.url;if(url!=='https://openrouter.ai/api/v1/chat/completions')throw new Error('unexpected destination');process.stdout.write('qualified-boundary:dispatch\\n',()=>process.exit(73));return new Promise(()=>{});}});
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const url='http://127.0.0.1:'+server.address().port;
await fetch(url+${JSON.stringify(`/api/projects/${projectId}/loop/start`)},{method:'POST',headers:${JSON.stringify(HEADERS)},body:${JSON.stringify(JSON.stringify(startBody))}});
setTimeout(()=>process.exit(74),12000);`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (/^(?:DIOMEDES_|MANAGED_|AWS_|NECTOVIA_)/i.test(key)
      || OFFLINE_ENV_REMOVALS.has(key.toUpperCase())) delete env[key];
    env.CODEX_HOME = path.join(dir, 'owned-codex-profile');
    env.WRANGLER_SEND_METRICS = 'false';
    let output = '';
    const code = await new Promise<number | null>((resolve, reject) => {
      childProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { cwd: process.cwd(), env, stdio: ['ignore','pipe','pipe'], windowsHide: true });
      childProcess.stdout?.on('data', chunk => { output += String(chunk); });
      childProcess.stderr?.on('data', chunk => { output += String(chunk); });
      childProcess.once('error', reject);
      childProcess.once('exit', resolve);
    });
    expect(code, output).toBe(73);
    expect(output.match(/qualified-boundary:dispatch/g)).toHaveLength(1);
    await open();
    const runId = loopRunId(projectId, command);
    const recovered = await until(runId, 'reconcile_required');
    const step = recovered.steps.find(item => item.intent.stepId === 'model:plan')!;
    expect(step).toMatchObject({ state: 'reconcile_required', attempt: 1, output: null });
    expect(recovered.result).toBeNull();
    expect(seen).toHaveLength(0);
    const rows = service.modelApi!.exposure.list(connection!.id).filter(row => row.attempt.runId === runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('uncertain');
    expect(rows[0]!.maxMicroUsd).toBeGreaterThan(0);
    const replay = await api<{ runId: string; replayed: boolean }>(`/projects/${projectId}/loop/start`, 'POST', startBody);
    expect(replay).toMatchObject({ runId, replayed: true });
    expect(seen).toHaveLength(0);
    expect(state().sessions.filter(session => session.taskId === taskId)).toHaveLength(1);
    expect(service.modelApi!.exposure.list(connection!.id).filter(row => row.attempt.runId === runId)).toEqual(rows);
    expect(state().tasks.find(task => task.id === taskId)!.state).not.toBe('done');
  });
});
