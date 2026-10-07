import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import type { LocalModelHost } from '../server/bonsai/runtime';
import type { LocalModelStatus } from '../shared/local-model';
import type { Conversation, Project } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';
import { FixedLocalModel, MEADOW_FOLDER, MEADOW_MODEL, meadowDescriptor } from './fixtures/local-model';

// The real application, its event stream and the built Console, on the local route. Only the local
// worker is replaced: a host that says the Deep profile is running, and a transport that answers
// the local server's endpoints with a stream the test steps through. Nothing starts a model.
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let calls: number;
let script: (Record<string, unknown> | 'hold')[];
let waiting: (() => void)[];
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const answer = 'The refund is on row 1,812.';
const envelope = { id: 'local-read', model: MEADOW_MODEL };
const progress = (processed: number, total: number, cache = 0) => ({
  ...envelope,
  choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }],
  prompt_progress: { total, cache, processed, time_ms: Math.round(processed / 9) },
});
const text = (content: string) => ({ ...envelope, choices: [{ index: 0, delta: { content }, finish_reason: null }] });

async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${endpoint}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${endpoint}: ${response.status} ${await response.clone().text()}`).toBe(true);
  return (await response.json()) as T;
}

/** The local server's chat stream: the script's chunks in order, pausing at each hold until the test steps it. */
function scriptedStream(signal: AbortSignal | null | undefined) {
  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        for (const item of script) {
          if (signal?.aborted) return;
          if (item === 'hold') await new Promise<void>((resolve) => waiting.push(resolve));
          else send(controller, item);
        }
        if (signal?.aborted) return;
        send(controller, { ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        send(controller, { ...envelope, choices: [], usage: { prompt_tokens: 117_536, completion_tokens: 9, total_tokens: 117_545 } });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

/** Lets the stream past its next hold; the caller has already seen what came before it. */
async function step() {
  await expect.poll(() => waiting.length).toBe(1);
  waiting.shift()!();
}

test.beforeEach(async () => {
  calls = 0;
  waiting = [];
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'local-read-progress-'));
  const status: LocalModelStatus = { installed: true, state: 'ready', owned: true, mode: 'Deep', model: MEADOW_MODEL,
    contextTokens: 131_072, detail: 'meadow-9b Deep is ready.' };
  const host: LocalModelHost = { inspect: async () => status, acquire: async () => ({ status, release: async () => {} }) };
  const transport: typeof fetch = async (target, init) => {
    const address = String(target);
    if (address.endsWith('/apply-template')) return Response.json({ prompt: 'Fixture template' });
    if (address.endsWith('/tokenize')) return Response.json({ tokens: [1, 2, 3] });
    expect(address).toBe('http://127.0.0.1:18100/v1/chat/completions');
    calls++;
    return scriptedStream(init?.signal);
  };
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  app = await createApp({ port, clientPort: port, dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null, automationTickMs: null, modelApiTransport: transport,
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    localModel: { source: new FixedLocalModel(meadowDescriptor(), MEADOW_FOLDER), host } });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const name of ['client/console/Shell.tsx', 'client/console/ThreadView.tsx', 'client/console/engine-prompt-progress.ts',
    'client/console/read-progress.css'])
    expect(built, 'Build the current UI before running this spec.').toBeGreaterThan((await fs.stat(name)).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
  const project = await api<Project>('/projects', 'POST', { name: 'Ledger review' });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', { name: 'Long document', mode: 'ask' });
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', {
    engine: 'bonsai', requested: { model: 'local:deep', effort: 'medium', agent: 'auto' },
  });
  // The project's sharing setting names the routes a message may go to; the local route is one of them.
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', { expectedVersion: 0, routes: ['bonsai'], documents: [],
    shareConversationHistory: false, shareReviewPackets: false });
  await api('/settings', 'PUT', { openProjects: [project.id], onboarding: { work: 'business', detail: 'guided',
    familiarity: 'new', resumeAt: 'done', completedAt: new Date().toISOString() } });
});

test.afterEach(async () => {
  for (const resolve of waiting.splice(0)) resolve();
  await app?.locals.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function ask(page: Page, errors: string[]) {
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const target = new URL(route.request().url());
    if (target.protocol.startsWith('http') && target.hostname !== '127.0.0.1')
      throw new Error(`Unexpected nonlocal request: ${target.origin}`);
    await route.continue();
  });
  await page.goto(url);
  await reopenLastProject(page);
  await page.getByRole('navigation', { name: 'Threads and views' }).getByRole('button', { name: /^Long document/ }).click();
  // Records whether a reading line was ever drawn, so a test can say one never was.
  await page.evaluate(() => {
    const seen = window as unknown as { readingSeen: boolean };
    seen.readingSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('.read-progress')) seen.readingSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole('textbox', { name: 'Message this thread', exact: true }).fill('Which row holds the March refund?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const readingSeen = (page: Page) => page.evaluate(() => (window as unknown as { readingSeen: boolean }).readingSeen);

test('a long local read shows one moving line until the read ends, then the answer', async ({ page }) => {
  script = [progress(0, 117_536), 'hold', progress(65_536, 117_536), 'hold', progress(117_536, 117_536), 'hold',
    text(answer), 'hold'];
  const errors: string[] = [];
  await ask(page, errors);
  const transcript = page.locator('.transcript');
  const bar = transcript.getByRole('progressbar', { name: 'Reading the document.' });
  await expect(bar).toHaveAttribute('aria-valuenow', '0');
  await expect(transcript.locator('.read-progress')).toHaveText('Reading the document. 0% so far.');
  // The line takes the place of the waiting line; there is one of them.
  await expect(transcript.getByText(/is replying/)).toHaveCount(0);
  await expect(transcript.locator('.read-progress')).toHaveCount(1);
  await step();
  await expect(bar).toHaveAttribute('aria-valuenow', '55');
  await expect(transcript.locator('.read-progress')).toHaveText('Reading the document. 55% so far.');
  // The read ends: the line goes, and the waiting line is back until the answer comes.
  await step();
  await expect(transcript.locator('.read-progress')).toHaveCount(0);
  await expect(transcript.getByText(/is replying/)).toHaveCount(1);
  await step();
  await expect(transcript).toContainText(answer);
  await expect(transcript.locator('.read-progress')).toHaveCount(0);
  // The turn ends: the saved answer stays and nothing of the read does.
  await step();
  await expect(transcript.getByText('live', { exact: true })).toHaveCount(0);
  await expect(transcript).toContainText(answer);
  await expect(transcript).not.toContainText('Reading the document.');
  expect(calls).toBe(1);
  expect(errors).toEqual([]);
});

test('a short prompt and a read served from the cache never show the line', async ({ page }) => {
  // A short prompt (the size of a message listing its files), then a long one the cache already held.
  script = [progress(0, 2_295), progress(2_048, 2_295), progress(2_295, 2_295),
    progress(117_000, 117_536, 117_000), progress(117_536, 117_536, 117_000), text(answer), 'hold'];
  const errors: string[] = [];
  await ask(page, errors);
  const transcript = page.locator('.transcript');
  // The answer text came after every progress frame on the same ordered stream.
  await expect(transcript).toContainText(answer);
  expect(await readingSeen(page)).toBe(false);
  await step();
  await expect(transcript.getByText('live', { exact: true })).toHaveCount(0);
  expect(await readingSeen(page)).toBe(false);
  expect(calls).toBe(1);
  expect(errors).toEqual([]);
});
