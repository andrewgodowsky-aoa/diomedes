import { afterEach, beforeEach, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { createIntegrations, createRpcClient } from '../server/integrations.js';
import type { Store } from '../server/store.js';
import type { ProjectState, Session } from '../shared/types.js';
import type { ControlReceipt } from '../shared/work-control.js';

// The real picker, HTTP admission, durable store and Codex controls, with only the
// external engine replaced by the existing disk-backed JSON-RPC fixture.
const WRITER = 'diomedes.writer';
let app: Awaited<ReturnType<typeof createApp>>, server: Server;
let root: string, engineDir: string, url: string, projectId: string, threadId: string;

async function call(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
const state = async (): Promise<ProjectState> => (await call(`/projects/${projectId}/state`)).data;
const configure = (options: Record<string, unknown>) =>
  fs.writeFile(path.join(engineDir, 'control.json'), JSON.stringify(options));
async function until<T>(read: () => Promise<T | undefined | false>, description: string): Promise<T> {
  for (let n = 0; n < 500; n++) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Did not reach ${description}`);
}
const settled = (id: string) => until(async () => {
  const session = (await state()).sessions.find((item) => item.id === id);
  return session && !['queued', 'working', 'waiting'].includes(session.state) && session;
}, 'a settled run');
async function calls(): Promise<{ method: string; params: Record<string, unknown> }[]> {
  return (await fs.readFile(path.join(engineDir, 'calls.jsonl'), 'utf8'))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const turns = async () => (await calls()).filter((item) => item.method === 'turn/start');
async function control(session: Session, name: 'retry' | 'resume' | 'stop', commandId = crypto.randomUUID()) {
  const response = await call(`/projects/${projectId}/controls`, 'POST', {
    protocolVersion: 1, commandId, taskId: session.taskId, sessionId: session.id,
    control: name, ...(name === 'stop' ? { scope: 'task' } : {}),
  });
  expect(response.status, JSON.stringify(response.data)).toBe(200);
  return response.data.receipt as ControlReceipt;
}
async function boot() {
  app = await createApp({
    dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    codexIntegration: createIntegrations({
      platform: 'win32', verifySandbox: async () => {}, turnTimeoutMs: 20_000,
      createClient: async () => createRpcClient(spawn(process.execPath, [path.resolve('tests/fixtures/codex-app-server.mjs')], {
        env: { PATH: process.env.PATH, CODEX_FIXTURE_DIR: engineDir },
        stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
      })),
    }),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function shutdown() {
  const closingApp = app, closingServer = server;
  try { await closingApp.locals.close(); }
  finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => closingServer.close((error) => error ? reject(error) : resolve()));
  }
}
beforeEach(async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  root = await fs.mkdtemp(path.resolve('test-results/auto-agent-retry-'));
  engineDir = path.join(root, 'engine');
  await fs.mkdir(engineDir);
  await configure({});
  await boot();
  projectId = (await call('/projects/sample', 'POST', {})).data.id;
  threadId = (await call(`/projects/${projectId}/threads`, 'POST', {})).data.id;
  expect((await call('/settings', 'PUT', { services: { codex: true } })).status).toBe(200);
  expect((await call(`/projects/${projectId}/threads/${threadId}`, 'PUT', { engine: 'codex' })).status).toBe(200);
  expect((await call(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0, routes: ['codex'], documents: ['Fall menu.md'],
    shareConversationHistory: false, shareReviewPackets: false,
  })).status).toBe(200);
});
afterEach(shutdown);

async function start(selected = 'auto', hold = false) {
  const mode = selected === 'diomedes.debugger' ? 'fix' : 'build';
  if (selected !== 'auto') {
    expect((await call(`/projects/${projectId}/threads/${threadId}`, 'PUT', {
      requested: { model: null, effort: null, agent: selected },
    })).status).toBe(200);
  }
  const pick = await call(`/projects/${projectId}/threads/${threadId}/agent-pick`, 'POST', {
    text: 'Write an email announcing the reopening.', attachments: [],
  });
  expect(pick.status).toBe(200);
  expect(pick.data).toMatchObject({ agent: { id: selected === 'auto' ? WRITER : selected }, mode });
  await configure(hold ? { hold } : { errors: { 'turn/start': { message: 'Synthetic engine failure', code: -1 } } });
  const answer = await call(`/projects/${projectId}/ask`, 'POST', {
    text: 'Write an email announcing the reopening.', threadId, route: 'codex',
    agent: pick.data.agent.id, mode, sources: [], consent: true,
  });
  expect(answer.status, JSON.stringify(answer.data)).toBe(200);
  const session = answer.data.session as Session;
  expect(session.agent?.agentId).toBe(selected === 'auto' ? WRITER : selected);
  if (!hold) return settled(session.id);
  await until(async () => {
    const current = (await state()).sessions.find((item) => item.id === session.id);
    return current?.nativeThread && current;
  }, 'the recorded native thread');
  expect((await control(session, 'stop')).outcome).toBe('applied');
  return settled(session.id);
}

// /ask records no Work consent receipt. Keep that gate intact: establish consent
// through a real Work start for the same task, as DurableControls requires today.
async function consentFor(session: Session) {
  await configure({});
  const answer = await call(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1, commandId: crypto.randomUUID(), taskId: session.taskId,
    route: 'codex', sources: [], consent: true, agentId: WRITER,
  });
  expect(answer.status, JSON.stringify(answer.data)).toBe(200);
  await settled(answer.data.id);
}
function writer(session: Session, automatic = true) {
  expect(session.agent).toMatchObject({
    agentId: WRITER, agentName: 'Writer', agentSelection: automatic ? 'automatic' : 'manual',
    requestedAgentId: automatic ? 'auto' : WRITER,
  });
  expect(session.origin?.agent).toMatchObject({ id: WRITER, selection: automatic ? 'automatic' : 'manual' });
}

test('Auto saves Writer as the effective worker alongside the requested Auto choice', async () => {
  const session = await start();
  writer(session);
  expect(session.inputs).toMatchObject({ agentId: 'auto', pickedAgentId: WRITER, mode: 'build' });
});

test('Auto Writer survives two retries, store reload and idempotent replay with its role and attribution', async () => {
  const original = await start();
  await consentFor(original);
  const before = structuredClone((await state()).sessions.find((item) => item.id === original.id));
  await shutdown();
  await boot();
  await configure({ errors: { 'turn/start': { message: 'Synthetic engine failure', code: -1 } } });
  let previous = original;
  for (let n = 0; n < 2; n++) {
    const source = previous;
    const commandId = crypto.randomUUID();
    const receipt = await control(previous, 'retry', commandId);
    expect(receipt.outcome, receipt.detail).toBe('applied');
    previous = await settled(receipt.result.sessionId!);
    writer(previous);
    const count = (await turns()).length;
    expect(await control(source, 'retry', commandId)).toEqual(receipt);
    expect((await turns()).length).toBe(count);
  }
  const sent = await turns();
  expect(JSON.stringify(sent[0].params.input)).toContain('Writer:');
  expect(sent.at(-1)!.params.input).toEqual(sent[0].params.input);
  expect((await state()).sessions.find((s) => s.id === original.id)).toEqual(before);
});

test.each([true, false])('Resume keeps Auto Writer after restart (native resume available: %s)', async (native) => {
  const original = await start('auto', true);
  await consentFor(original);
  await shutdown();
  await boot();
  await configure({ capabilities: native ? ['resume', 'fork', 'steer'] : [] });
  const receipt = await control(original, 'resume');
  expect(receipt.outcome, receipt.detail).toBe('applied');
  const next = await settled(receipt.result.sessionId!);
  writer(next);
  expect(next.nativeThread?.origin).toBe(native ? 'resumed' : 'restarted-fresh');
  if (native) expect(next.nativeThread?.id).toBe(original.nativeThread?.id);
  expect(JSON.stringify((await turns()).at(-1)!.params.input)).toContain('Writer:');
});

test.each(['retry', 'resume'] as const)('explicit Writer stays manually selected through %s', async (name) => {
  const original = await start(WRITER, name === 'resume');
  await consentFor(original);
  const receipt = await control(original, name);
  expect(receipt.outcome, receipt.detail).toBe('applied');
  writer(await settled(receipt.result.sessionId!), false);
});

test('a legacy Auto session recovers Writer from recorded resolution without rewriting history', async () => {
  const original = await start();
  await consentFor(original);
  const store = app.locals.store as Store;
  await store.locked(async () => {
    const current = store.state(projectId);
    const saved = current.sessions.find((s) => s.id === original.id)!;
    saved.inputs = { instruction: saved.inputs!.instruction, sources: [], agentId: 'auto', mode: 'build' };
    await store.persist(current);
  });
  await shutdown();
  await boot();
  const receipt = await control(original, 'retry');
  expect(receipt.outcome, receipt.detail).toBe('applied');
  writer(await settled(receipt.result.sessionId!));
  expect((await state()).sessions.find((s) => s.id === original.id)!.inputs).not.toHaveProperty('pickedAgentId');
});

test('restoring a worker does not manufacture missing route consent', async () => {
  const original = await start();
  const count = (await turns()).length;
  const receipt = await control(original, 'retry');
  expect(receipt.refusal?.code).toBe('consent-required');
  expect((await turns()).length).toBe(count);
});

test.each(['retry', 'resume'] as const)('%s still refuses revoked sharing before sending', async (name) => {
  const original = await start('auto', name === 'resume');
  await consentFor(original);
  expect((await call(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 1, routes: [], documents: [], shareConversationHistory: false, shareReviewPackets: false,
  })).status).toBe(200);
  const count = (await turns()).length;
  const receipt = await control(original, name);
  expect(receipt.refusal?.code).toBe('admission-refused');
  expect((await turns()).length).toBe(count);
});

test.each(['diomedes.builder', 'diomedes.debugger'])('explicit %s keeps its identity and work mode on retry', async (agent) => {
  const original = await start(agent);
  await consentFor(original);
  const receipt = await control(original, 'retry');
  expect(receipt.outcome, receipt.detail).toBe('applied');
  const next = await settled(receipt.result.sessionId!);
  expect(next.agent).toMatchObject({ agentId: agent, requestedAgentId: agent, agentSelection: 'manual' });
  expect(next.inputs?.mode).toBe(agent === 'diomedes.debugger' ? 'fix' : 'build');
});

test('sessions predating agent snapshots keep the old default; sessions without inputs remain refused', async () => {
  const original = await start();
  await consentFor(original);
  const store = app.locals.store as Store;
  await store.locked(async () => {
    const current = store.state(projectId);
    const saved = current.sessions.find((s) => s.id === original.id)!;
    saved.inputs = { instruction: saved.inputs!.instruction, sources: [], agentId: null, mode: 'build' };
    delete saved.agent;
    await store.persist(current);
  });
  await shutdown();
  await boot();
  const receipt = await control(original, 'retry');
  expect(receipt.outcome, receipt.detail).toBe('applied');
  expect((await settled(receipt.result.sessionId!)).agent?.agentId).toBe('diomedes.builder');
  const count = (await turns()).length;
  await (app.locals.store as Store).locked(async () => {
    const current = (app.locals.store as Store).state(projectId);
    delete current.sessions.find((s) => s.id === original.id)!.inputs;
    await (app.locals.store as Store).persist(current);
  });
  expect((await control(original, 'retry')).refusal?.code).toBe('inputs-unrecorded');
  expect((await turns()).length).toBe(count);
});

test('a new routing profile cannot replace the recorded Auto Writer with Builder', async () => {
  const original = await start();
  await consentFor(original);
  const profile = await call('/agent-profiles', 'POST', {
    name: 'Builder profile', engine: 'codex', model: 'fixture-codex-model',
    effort: null, agentId: 'diomedes.builder', rules: [],
  });
  expect(profile.status).toBe(200);
  expect((await call(`/projects/${projectId}/threads/${threadId}`, 'PUT', {
    requested: { model: null, effort: null, profile: profile.data.profileId },
  })).status).toBe(200);
  const count = (await turns()).length;
  const receipt = await control(original, 'retry');
  expect(receipt.refusal?.code).toBe('admission-refused');
  expect(receipt.detail).toContain('original agent');
  expect((await turns()).length).toBe(count);
});

test.each(['retry', 'resume'] as const)('%s uses narrowed current permission while keeping Writer', async (name) => {
  expect((await call(`/projects/${projectId}/threads/${threadId}`, 'PUT', { permission: 'task' })).status).toBe(200);
  const original = await start('auto', name === 'resume');
  expect(original.permission).toBe('task');
  await consentFor(original);
  expect((await call(`/projects/${projectId}/threads/${threadId}`, 'PUT', { permission: 'show-first' })).status).toBe(200);
  const receipt = await control(original, name);
  expect(receipt.outcome, receipt.detail).toBe('applied');
  const next = await settled(receipt.result.sessionId!);
  writer(next);
  expect(next.permission).toBe('show-first');
  expect(next.agent?.policy).toMatchObject({ granted: 'review', effective: 'review', grantId: null, grantsAuthority: false });
});

test('Resume still refuses a permission increase', async () => {
  const original = await start('auto', true);
  await consentFor(original);
  expect((await call(`/projects/${projectId}/threads/${threadId}`, 'PUT', { permission: 'task' })).status).toBe(200);
  const count = (await turns()).length;
  expect((await control(original, 'resume')).refusal?.code).toBe('permission-widened');
  expect((await turns()).length).toBe(count);
});

test('retry resolves grants afresh and cannot restore a revoked grant from the agent snapshot', async () => {
  const original = await start();
  await consentFor(original);
  const issued = await call(`/projects/${projectId}/permissions/grants`, 'POST', {
    protocolVersion: 2, commandId: crypto.randomUUID(), taskId: original.taskId,
    roots: ['.'], operations: ['text.create', 'text.modify'], engine: 'codex',
    accountRoute: 'codex:chatgpt', maxWrites: 20, maxBytes: 1_048_576, ttlMinutes: 60, review: 'human',
  });
  expect(issued.status, JSON.stringify(issued.data)).toBe(200);
  await configure({ errors: { 'turn/start': { message: 'Synthetic engine failure', code: -1 } } });
  const first = await control(original, 'retry');
  expect(first.outcome, first.detail).toBe('applied');
  const granted = await settled(first.result.sessionId!);
  expect(granted.agent?.policy.grantId).toBe(issued.data.grant.id);
  expect((await call(`/projects/${projectId}/permissions/grants/${issued.data.grant.id}/revoke`, 'POST', {})).status).toBe(200);
  await configure({ changes: [{ path: 'Email.md', text: 'We are reopening.', summary: 'Email draft' }] });
  const receipt = await control(granted, 'retry');
  expect(receipt.outcome, receipt.detail).toBe('applied');
  const waiting = await until(async () => {
    const current = await state();
    return current.needs.some((need) => need.sessionId === receipt.result.sessionId && need.state === 'open') && current;
  }, 'a proposal waiting for fresh approval');
  const next = waiting.sessions.find((s) => s.id === receipt.result.sessionId)!;
  writer(next);
  expect(next.agent?.policy).toMatchObject({ granted: 'review', effective: 'review', grantId: null, grantsAuthority: false });
  expect(await (app.locals.store as Store).current(projectId, 'Email.md')).toBeNull();
  expect(waiting.needs.find((need) => need.sessionId === next.id)?.origin?.agent?.id).toBe(WRITER);
  expect(waiting.sessions.find((s) => s.id === granted.id)?.agent?.policy.grantId).toBe(issued.data.grant.id);
});

test('public Work requests cannot supply host restart context', async () => {
  const original = await start();
  const count = (await turns()).length;
  const response = await call(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1, commandId: crypto.randomUUID(), taskId: original.taskId,
    route: 'codex', sources: [], consent: true, agentId: 'auto',
    restart: { ...original.inputs, pickedAgentId: WRITER },
  });
  expect(response.status).toBe(400);
  expect(response.data.code).toBe('invalid_work_command');
  expect((await turns()).length).toBe(count);
});
