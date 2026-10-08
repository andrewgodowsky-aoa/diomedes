import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Conversation, Turn } from '../shared/types.js';

/**
 * DIO-292: the thread's Agent box guards both send paths. A message for another agent than the
 * box holds is refused before anything is sent; on Auto, Auto's pick runs and the reply says so;
 * Fixer takes the message as the failure report and still stops after three tries.
 */
let server: Server, app: Awaited<ReturnType<typeof createApp>>, temp: string, url: string;
const jsonHeaders = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function call(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: jsonHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'agent-guards-'));
  app = await createApp({ dataDir: path.join(temp, 'data'), projectRoot: path.join(temp, 'projects'), stepMs: 20 });
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

type Thread = { projectId: string; threadId: string };
async function fixture(agent?: string): Promise<Thread> {
  const project = await call('/projects', 'POST', { name: 'Harbor Street' });
  expect(project.status).toBe(200);
  const folder = app.locals.store.state(project.data.id).project.folder;
  await fs.writeFile(path.join(folder, 'sales.md'), '# Sales\n\nFriday: 1200\n');
  const thread = await call(`/projects/${project.data.id}/threads`, 'POST', {});
  expect(thread.status).toBe(201);
  if (agent)
    expect(
      (await call(`/projects/${project.data.id}/threads/${thread.data.id}`, 'PUT', { requested: { model: null, effort: null, agent } }))
        .status,
    ).toBe(200);
  return { projectId: project.data.id, threadId: thread.data.id };
}
const direct = (t: Thread, extra: Record<string, unknown>) =>
  call(`/projects/${t.projectId}/ask`, 'POST', {
    text: 'The Friday total is off by a day.',
    route: 'sample',
    consent: true,
    threadId: t.threadId,
    attachedTo: { kind: 'project', ref: t.projectId },
    sources: ['sales.md'],
    ...extra,
  });
const reply = (t: Thread): Turn | undefined =>
  [...app.locals.store.state(t.projectId).conversations.find((c: Conversation) => c.id === t.threadId).turns]
    .reverse()
    .find((turn: Turn) => turn.role !== 'you');
/** The sample work a Fix starts runs on; it stops here so the next try can start. */
async function stopWork(t: Thread) {
  const session = app.locals.store.state(t.projectId).sessions.at(-1);
  if (session && ['queued', 'working', 'waiting'].includes(session.state))
    expect((await call(`/projects/${t.projectId}/work/${session.id}/stop`, 'POST', {})).status).toBe(200);
}

test("a message for another agent than the thread's choice is refused before anything is sent", async () => {
  const t = await fixture('diomedes.architect');
  const before = structuredClone(app.locals.store.state(t.projectId));
  const refused = await direct(t, { mode: 'build', agent: 'diomedes.builder' });
  expect(refused.status).toBe(409);
  expect(refused.data.code).toBe('agent_changed');
  expect(refused.data.error).toBe("This thread's agent changed. Nothing was sent. Send again.");
  expect(app.locals.store.state(t.projectId).conversations).toEqual(before.conversations);
  expect(app.locals.store.state(t.projectId).sessions).toHaveLength(0);
});

test('a request that names no agent runs as the one the thread chose, and one of another kind is refused', async () => {
  const t = await fixture('diomedes.reviewer');
  const sent = await direct(t, { mode: 'ask', text: 'Is the Friday total right?' });
  expect(sent.status).toBe(200);
  expect(reply(t)?.agent).toEqual({ id: 'diomedes.reviewer', name: 'Reviewer', picked: false });
  const before = structuredClone(app.locals.store.state(t.projectId).conversations);
  const other = await direct(t, { mode: 'plan', text: 'Plan the week.' });
  expect(other.status).toBe(409);
  expect(other.data.code).toBe('agent_changed');
  expect(app.locals.store.state(t.projectId).conversations).toEqual(before);
});

test("on Auto, Auto's pick runs and the reply says Auto picked it", async () => {
  const t = await fixture();
  const sent = await direct(t, { mode: 'fix', agent: 'diomedes.debugger' });
  expect(sent.status).toBe(200);
  expect(reply(t)?.agent).toEqual({ id: 'diomedes.debugger', name: 'Fixer', picked: true });
});

test('Fixer needs no separate failure fields: the message is the report', async () => {
  const t = await fixture('diomedes.debugger');
  const sent = await direct(t, { mode: 'fix', agent: 'diomedes.debugger' });
  expect(sent.status).toBe(200);
  expect(reply(t)?.agent).toEqual({ id: 'diomedes.debugger', name: 'Fixer', picked: false });
});

test('Fixer still stops after three tries, and says what to do next', async () => {
  const t = await fixture('diomedes.debugger');
  for (let n = 0; n < 3; n += 1) {
    expect((await direct(t, { mode: 'fix', agent: 'diomedes.debugger' })).status).toBe(200);
    await stopWork(t);
  }
  const fourth = await direct(t, { mode: 'fix', agent: 'diomedes.debugger' });
  expect(fourth.status).toBe(409);
  expect(fourth.data.error).toBe("Three tries haven't fixed this. Start a new thread, or ask Planner for a plan first.");
});

test('a failure report an API caller still sends is checked as before', async () => {
  const t = await fixture('diomedes.debugger');
  expect((await direct(t, { mode: 'fix', agent: 'diomedes.debugger', failing: {} })).status).toBe(400);
  expect((await direct(t, { mode: 'fix', agent: 'diomedes.debugger', failing: { document: 'other.md' } })).status).toBe(400);
  expect((await direct(t, { mode: 'fix', agent: 'diomedes.debugger', failing: { text: 'Friday shows Thursday.' } })).status).toBe(200);
});
