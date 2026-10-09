import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { agentChoiceOf } from '../shared/agent-choice.js';
import type { Conversation } from '../shared/types.js';

/** DIO-292: a thread's Agent box over the HTTP thread API. The Agent box decides the kind of run. */
let server: Server, app: Awaited<ReturnType<typeof createApp>>, temp: string, url: string;
const jsonHeaders = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: jsonHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function sampleProject(): Promise<string> {
  const result = await request('/projects/sample', 'POST', {});
  expect(result.status).toBe(200);
  return result.data.id as string;
}
async function sampleThread(body: Record<string, unknown> = {}) {
  const projectId = await sampleProject();
  const created = await request(`/projects/${projectId}/threads`, 'POST', body);
  expect(created.status).toBe(201);
  return { projectId, thread: created.data as Conversation };
}
const stored = (projectId: string, threadId: string): Conversation =>
  app.locals.store.state(projectId).conversations.find((c: Conversation) => c.id === threadId);
const choose = (projectId: string, threadId: string, agent: string) =>
  request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { requested: { model: null, effort: null, agent } });
const planOnSample = (projectId: string, threadId: string) =>
  request(`/projects/${projectId}/ask`, 'POST', {
    mode: 'plan',
    text: 'Plan the spring menu.',
    route: 'sample',
    consent: true,
    threadId,
  });

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'agent-choice-'));
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  const closingApp = app, closingServer = server;
  await closingApp.locals.close();
  closingServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => closingServer.close((error) => (error ? reject(error) : resolve())));
  await fs.rm(temp, { recursive: true, force: true });
});

test('a new thread starts on Auto, with the Ask kind a new thread was always stored with', async () => {
  const { thread } = await sampleThread();
  expect(thread.requested).toEqual({ model: null, effort: null, agent: 'auto' });
  // An Automatic kind marks a project's own Diomedes conversation, which no Console thread is.
  expect(thread.mode).toBe('ask');
  expect(agentChoiceOf(thread)).toBe('auto');
});

test('a thread an API caller creates for a kind starts on that kind, as before', async () => {
  const { thread } = await sampleThread({ mode: 'plan' });
  expect(thread.mode).toBe('plan');
  expect(thread.requested ?? null).toBeNull();
  expect(agentChoiceOf(thread)).toBe('diomedes.architect');
});

test('choosing an agent sets the kind of run it does', async () => {
  const { projectId, thread } = await sampleThread();
  expect((await choose(projectId, thread.id, 'diomedes.reviewer')).data.mode).toBe('ask');
  expect((await choose(projectId, thread.id, 'diomedes.writer')).data.mode).toBe('build');
  expect((await choose(projectId, thread.id, 'diomedes.architect')).data.mode).toBe('plan');
  expect((await choose(projectId, thread.id, 'diomedes.debugger')).data.mode).toBe('fix');
  // Auto decides the kind per message, so choosing it leaves the stored kind as it was.
  const auto = await choose(projectId, thread.id, 'auto');
  expect([auto.data.requested.agent, auto.data.mode]).toEqual(['auto', 'fix']);
  // The general worker left the menu: a thread that names it is on Auto.
  const general = await choose(projectId, thread.id, 'diomedes.general');
  expect(general.data.requested).toEqual({ model: null, effort: null, agent: 'auto' });
  expect(general.data.mode).toBe('fix');
});

test('an agent that is not here is refused, and nothing on the thread changes', async () => {
  const { projectId, thread } = await sampleThread();
  await choose(projectId, thread.id, 'diomedes.reviewer');
  const refused = await request(`/projects/${projectId}/threads/${thread.id}`, 'PUT', {
    name: 'Renamed',
    requested: { model: null, effort: null, agent: 'acme.nobody' },
  });
  expect(refused.status).toBe(400);
  expect(refused.data.code).toBe('agent_not_found');
  const after = stored(projectId, thread.id);
  expect(after.requested).toEqual({ model: null, effort: null, agent: 'diomedes.reviewer' });
  expect(after.mode).toBe('ask');
  expect(after.name).not.toBe('Renamed');
});

test('a mode an API caller names puts the thread on that kind, as a mode always did', async () => {
  const { projectId, thread } = await sampleThread();
  const moved = await request(`/projects/${projectId}/threads/${thread.id}`, 'PUT', { mode: 'ask' });
  expect(moved.status).toBe(200);
  expect(moved.data.mode).toBe('ask');
  expect(agentChoiceOf(moved.data)).toBe('diomedes.researcher');
});

test('a direct send on another route keeps the agent and drops only the model', async () => {
  const { projectId, thread } = await sampleThread();
  expect((await request(`/projects/${projectId}/threads/${thread.id}`, 'PUT', { engine: 'codex' })).status).toBe(200);
  expect((await choose(projectId, thread.id, 'diomedes.architect')).status).toBe(200);
  expect((await planOnSample(projectId, thread.id)).status).toBe(200);
  const after = stored(projectId, thread.id);
  expect(after.engine).toBe('sample');
  expect(after.requested).toEqual({ model: null, effort: null, agent: 'diomedes.architect' });
});

test('an Auto thread saved before agents stays on Auto, kind and all, when a send runs as another kind', async () => {
  const { projectId, thread } = await sampleThread({ mode: 'auto' });
  expect(thread.requested ?? null).toBeNull();
  expect((await planOnSample(projectId, thread.id)).status).toBe(200);
  const after = stored(projectId, thread.id);
  expect(after.mode).toBe('auto');
  expect(agentChoiceOf(after)).toBe('auto');
});
