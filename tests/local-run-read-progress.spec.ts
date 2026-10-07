import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { testOnlySecretBox } from '../server/connection-secrets';
import { EngineService } from '../server/engines/service';
import type { LocalModelHost } from '../server/bonsai/runtime';
import { LOCAL_MODEL_ACCOUNT, type LocalModelStatus } from '../shared/local-model';
import type { Conversation, Project, ProjectState, Session, Task } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';
import { FixedLocalModel, localAnswerStream, MEADOW_FOLDER, MEADOW_MODEL, meadowDescriptor } from './fixtures/local-model';

// DIO-256: a run card shows a local model's read while it moves, as the ask does. The real
// application, its event stream and the built Console, on the local route. Only the local worker
// is replaced: a host that says the Deep profile is running, and a real HTTP server on this
// computer that answers the local server's endpoints, pausing a long read at each hold until the
// test steps it. Nothing starts a model.
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let local: Server;
let url: string;
let holds: (() => void)[];
/** Which run the local server answers: a Work run's one call, or a loop's lead and children. */
let kind: 'work' | 'loop';
/** Every chat call so far, by the side that made it. */
let calls: ('work' | 'lead' | 'child')[];
let project: Project;
let task: Task;
let thread: Conversation;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const ORDER = 'Order 1182: 100 napkins.\n';
const ASSIGN = { tasks: [{ task: 'Count the napkins in order.md.', files: ['order.md'] }] };
const ADVISE = { question: 'Is the order complete?' };
const PROPOSAL = JSON.stringify({ summary: 'Counted the napkins.',
  changes: [{ path: 'Count.md', text: 'Order 1182 lists 100 napkins.\n', summary: 'The count' }] });
const TOTAL = 117_536;
/** A read's progress, sent under its answer's id: the app refuses a stream whose id changes. */
const progress = (processed: number, total = TOTAL) => ({
  model: MEADOW_MODEL,
  choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }],
  prompt_progress: { total, cache: 0, processed, time_ms: Math.round(processed / 9) },
});
/** A long document's read, held at each step. Every other call is a short prompt that shows nothing. */
const LONG_READ: (Record<string, unknown> | 'hold')[] = [progress(0), 'hold', progress(65_536), 'hold', progress(TOTAL), 'hold'];
const SHORT_READ = [progress(2_295, 2_295)];

async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${endpoint}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${endpoint}: ${response.status} ${await response.clone().text()}`).toBe(true);
  return (await response.json()) as T;
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}
const json = (res: ServerResponse, value: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

/**
 * The local server. A Work run's one call reads the long document and proposes a file. In a loop,
 * the lead plans, hands a worker the order, asks its advisor, then answers; the worker's call reads
 * the long document, and the advisor answers at once.
 */
function localServer(): Promise<string> {
  local = http.createServer((req, res) => {
    void (async () => {
      const body = await bodyOf(req);
      if (req.url === '/apply-template') return json(res, { prompt: 'Fixture template' });
      if (req.url === '/tokenize') return json(res, { tokens: [1, 2, 3] });
      if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
      const tools = ((body.tools as { function: { name: string } }[] | undefined) ?? []).map((tool) => tool.function.name);
      const answered = ((body.messages as { role: string }[] | undefined) ?? []).filter((message) => message.role === 'tool').length;
      const side = kind === 'work' ? 'work' : !tools.length || tools.includes('assign_workers') ? 'lead' : 'child';
      calls.push(side);
      const n = calls.length;
      const final = (content: string) => ({ finish_reason: 'stop', message: { content } });
      const tool = (name: string, input: unknown) => ({ finish_reason: 'tool_calls',
        message: { content: null, tool_calls: [{ id: `call-${n}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } });
      const choice = side === 'work' ? final(PROPOSAL)
        : side === 'child' ? final('Order 1182 lists 100 napkins.')
          : !tools.length ? final('1. Ask my team.\n2. Answer.')
            : answered === 0 ? tool('assign_workers', ASSIGN)
              : answered === 1 ? tool('consult_advisor', ADVISE)
                : final('Done with what my team said.');
      // The Work call and the worker's call (the first child's) read the long document.
      const long = side === 'work' || (side === 'child' && calls.filter((call) => call === 'child').length === 1);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const item of long ? LONG_READ : SHORT_READ) {
        if (item === 'hold') await new Promise<void>((resolve) => holds.push(resolve));
        else res.write(`data: ${JSON.stringify({ id: `local-${n}`, ...item })}\n\n`);
      }
      const usage = { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 };
      res.end(await localAnswerStream({ id: `local-${n}`, model: MEADOW_MODEL, usage, choices: [choice] }).text());
    })().catch(() => res.destroy());
  });
  return new Promise((resolve) =>
    local.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(local.address() as AddressInfo).port}`)));
}

/** Lets the read past its next hold; the caller has already seen what came before it. */
async function step() {
  await expect.poll(() => holds.length).toBe(1);
  holds.shift()!();
}

/** How the task's runs ended: 'done' once every one finished well, else each one's state. */
async function runsEnded() {
  const states = (await api<ProjectState>(`/projects/${project.id}/state`)).sessions
    .filter((session) => session.taskId === task.id).map((session) => session.state);
  return states.length && states.every((state) => state === 'done') ? 'done' : states.join(', ');
}

test.beforeEach(async () => {
  calls = [];
  holds = [];
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'local-run-read-progress-'));
  const status: LocalModelStatus = { installed: true, state: 'ready', owned: true, mode: 'Deep', model: MEADOW_MODEL,
    contextTokens: 131_072, detail: 'meadow-9b Deep is ready.' };
  const host: LocalModelHost = { inspect: async () => status, acquire: async () => ({ status, release: async () => {} }) };
  const localUrl = await localServer();
  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  app = await createApp({ port, clientPort: port, dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null, automationTickMs: null, secretBox: testOnlySecretBox(),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    localModel: { source: new FixedLocalModel(meadowDescriptor(localUrl), MEADOW_FOLDER), host } });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const name of ['client/console/Shell.tsx', 'client/console/ThreadView.tsx', 'client/console/engine-prompt-progress.ts',
    'client/console/read-progress.css'])
    expect(built, 'Build the current UI before running this spec.').toBeGreaterThan((await fs.stat(name)).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
  project = await api<Project>('/projects', 'POST', { name: 'Linen orders' });
  await fs.writeFile(path.join(app.locals.store.state(project.id).project.folder, 'order.md'), ORDER);
  task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name: 'Check the order' });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', { attachedTo: { kind: 'task', ref: task.id } });
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', {
    engine: 'bonsai', requested: { model: 'local:deep', effort: 'medium', agent: 'auto' },
  });
  // The project's sharing setting names the routes work may go to, and the files it may send.
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', { expectedVersion: 0, routes: ['bonsai'], documents: ['order.md'],
    shareConversationHistory: false, shareReviewPackets: false });
  await api('/settings', 'PUT', { openProjects: [project.id], onboarding: { work: 'business', detail: 'guided',
    familiarity: 'new', resumeAt: 'done', completedAt: new Date().toISOString() } });
});

test.afterEach(async () => {
  for (const resolve of holds.splice(0)) resolve();
  await app?.locals.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  local?.closeAllConnections();
  if (local) await new Promise<void>((resolve) => local.close(() => resolve()));
});

/** Opens the task's thread, where its runs' cards are, once the Console is listening to events. */
async function openThread(page: Page, errors: string[]) {
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const target = new URL(route.request().url());
    if (target.protocol.startsWith('http') && target.hostname !== '127.0.0.1')
      throw new Error(`Unexpected nonlocal request: ${target.origin}`);
    await route.continue();
  });
  const listening = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/events');
  await page.goto(url);
  await reopenLastProject(page);
  // A thread made for a task is named after it.
  await page.getByRole('navigation', { name: 'Threads and views' }).getByRole('button', { name: /^Thread for Check the order/ }).click();
  await expect(page.locator('#scrThread')).toBeVisible();
  await listening;
}

/** Steps one long read through the live run card: one line with the share so far, then gone. */
async function readOnCard(page: Page) {
  const card = page.locator('#scrThread .record.open.live');
  const line = card.locator('.read-progress');
  const bar = card.getByRole('progressbar', { name: 'Reading the document.' });
  await expect(line).toHaveText('Reading the document. 0% so far.');
  await expect(bar).toHaveAttribute('aria-valuenow', '0');
  // The working sign shows from the first moment: the fill is still empty, so it travels the track.
  const sign = await bar.evaluate((track) => {
    const after = getComputedStyle(track, '::after');
    return { animation: after.animationName, display: after.display, opacity: Number(after.opacity) };
  });
  expect(sign).toMatchObject({ animation: 'seg-travel', display: 'block' });
  expect(sign.opacity).toBeGreaterThan(0);
  // The line takes the working line's place, and the thread shows it once.
  await expect(card.getByText(/is on it/)).toHaveCount(0);
  await expect(page.locator('#scrThread .read-progress')).toHaveCount(1);
  await step();
  await expect(line).toHaveText('Reading the document. 55% so far.');
  await expect(bar).toHaveAttribute('aria-valuenow', '55');
  // The read ends: the line goes.
  await step();
  await expect(page.locator('#scrThread .read-progress')).toHaveCount(0);
  return card;
}

test("a Work run's long local read shows on its run card until the read ends", async ({ page }) => {
  kind = 'work';
  const errors: string[] = [];
  await openThread(page, errors);
  await api<Session>(`/projects/${project.id}/work/start`, 'POST', { protocolVersion: 1, commandId: randomUUID(),
    taskId: task.id, threadId: thread.id, route: 'bonsai', consent: true, sources: [] });
  const card = await readOnCard(page);
  // Until the answer comes, the working line is back.
  await expect(card.getByText(/is on it/)).toHaveCount(1);
  await step();
  // The run ends with its proposal, and nothing of the read stays.
  await expect.poll(runsEnded).toBe('done');
  await expect(page.locator('#scrThread .record.live')).toHaveCount(0);
  await expect(page.locator('#scrThread')).not.toContainText('Reading the document.');
  expect(calls).toEqual(['work']);
  expect(errors).toEqual([]);
});

test("an Agent loop's worker read shows on the loop's run card, named by the worker's run", async ({ page }) => {
  kind = 'loop';
  const errors: string[] = [];
  await openThread(page, errors);
  await api(`/projects/${project.id}/loop/start`, 'POST', {
    protocolVersion: 1, commandId: randomUUID(), taskId: task.id, goal: 'Check the order.', route: 'bonsai',
    model: 'local:deep', accountRoute: LOCAL_MODEL_ACCOUNT, consent: true, sources: ['order.md'],
    team: { worker: {}, advisor: {} },
  });
  await readOnCard(page);
  await step();
  // The loop finishes well: every run on the task is done.
  await expect.poll(runsEnded).toBe('done');
  // The advisor's and the lead's later calls are short and show nothing; the loop ends.
  await expect(page.locator('#scrThread .record.live')).toHaveCount(0);
  await expect(page.locator('#scrThread')).not.toContainText('Reading the document.');
  expect(calls).toEqual(['lead', 'lead', 'child', 'lead', 'child', 'lead']);
  expect(errors).toEqual([]);
});
