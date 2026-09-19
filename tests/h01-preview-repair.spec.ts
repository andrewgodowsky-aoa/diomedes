import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import { routeContractFor } from '../server/harness/route-contract';
import type { TextRequest } from '../server/engines/contract';
import type { Store } from '../server/store';
import type { Project, Conversation } from '../shared/types';

// The actual app/host/SSE and built Console; only provider discovery/I/O is scripted.
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let project: Project;
let thread: Conversation;
let held: TextRequest;
let release: () => void;
let calls: number;
let frames: Record<string, unknown>[];
let streams: ServerResponse[];
let stateReads: number;
const live = 'Ordered preview.';
const final = 'Durable final answer.';
const store = () => app.locals.store as Store;
async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${endpoint}`, { method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${endpoint}: ${response.status}`).toBe(true);
  return response.json() as Promise<T>;
}
test.beforeEach(async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results', 'h01-preview-repair-'));
  frames = []; streams = []; calls = 0; stateReads = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const engine = 'claude-code';
  const model = 'fixture-model';
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [{ id: engine, name: 'Local fixture', kind: 'online',
      found: true, available: false, enabled: false, status: 'Installed', detail: '',
      capabilities: [], signIn: 'unknown', adapter: 'planned',
      installedVersion: TESTED_VERSIONS[engine], location: 'fixture', disclosure: [] }],
    version: async () => TESTED_VERSIONS[engine],
    adapter: () => ({ id: engine, contract: routeContractFor(engine),
      inspect: async () => ({ authentication: 'signed-in', accountRoute: 'fixture:account',
        models: [{ slug: model, name: 'Fixture', description: '', efforts: [], defaultEffort: null }], detail: '' }),
      generate: async input => {
        calls++; held = input;
        input.onDelta?.(live);
        await waiting;
        return { text: final, model: input.model, version: TESTED_VERSIONS[engine],
          projectId: input.projectId, threadId: input.threadId, requestId: input.requestId };
      },
    }),
  });
  server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  app = await createApp({ port, clientPort: port, dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'), engineService: service, reviewerAdapter: null });
  store().on('engine-text', frame => frames.push(structuredClone(frame) as Record<string, unknown>));
  const dist = path.resolve('dist');
  expect((await fs.stat(path.join(dist, 'index.html'))).mtimeMs)
    .toBeGreaterThan((await fs.stat('client/console/Shell.tsx')).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', (req, res) => {
    if (req.url === '/api/events') streams.push(res);
    if (req.method === 'GET' && req.url?.startsWith(`/api/projects/${project?.id}`)) stateReads++;
    app(req, res);
  });
  await api('/ai/discover', 'POST', { consent: true });
  await api(`/ai/check/${engine}`, 'POST', {});
  await api('/ai/select', 'POST', { engine, model });
  project = await api('/projects', 'POST', { name: 'Preview repair' });
  thread = await api(`/projects/${project.id}/threads`, 'POST', { name: 'Preview ordering', mode: 'ask' });
  await api('/settings', 'PUT', { surface: 'console', detail: 'technical', openProjects: [project.id],
    onboarding: { work: 'business', detail: 'technical', familiarity: 'comfortable', resumeAt: 'done', completedAt: new Date().toISOString() } });
});
test.afterEach(async () => {
  release?.();
  await app?.locals.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});
async function begin(page: Page) {
  await page.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (target.protocol.startsWith('http') && target.hostname !== '127.0.0.1')
      throw new Error(`Unexpected nonlocal request: ${target.origin}`);
    await route.continue();
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Preview repair', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message this thread', exact: true }).fill('Read this synthetic example.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('dialog', { name: 'Send this message?' }).getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.transcript')).toContainText(live);
  expect(calls).toBe(1);
  return frames.find(frame => frame.kind === 'delta')!;
}
async function finish(page: Page) {
  release();
  await expect(page.locator('.transcript')).toContainText(final);
  expect(calls).toBe(1);
}

test('sequence gaps discard the incomplete preview and re-read state without another provider call', async ({ page }) => {
  const first = await begin(page);
  const readsBefore = stateReads;
  store().emit('engine-text', { ...first, seq: 3, text: 'GAP TEXT' });
  await expect(page.locator('.transcript')).not.toContainText(live);
  await expect(page.locator('.transcript')).not.toContainText('GAP TEXT');
  await expect.poll(() => stateReads).toBeGreaterThan(readsBefore);
  store().emit('engine-text', { ...first, seq: 2, text: 'LATE MISSING TEXT' });
  await expect(page.locator('.transcript')).not.toContainText('LATE MISSING TEXT');
  await finish(page);
});

test('older and duplicate frames cannot corrupt an otherwise contiguous preview', async ({ page }) => {
  const first = await begin(page);
  held.onDelta?.(' Next.');
  await expect(page.locator('.transcript')).toContainText(live + ' Next.');
  store().emit('engine-text', { ...first, seq: 1, text: 'OUT OF ORDER' });
  const second = frames.find(frame => frame.kind === 'delta' && frame.seq === 2)!;
  expect(second).toBeDefined();
  store().emit('engine-text', structuredClone(second));
  held.onDelta?.(' Still current.');
  // A later valid frame proves the injected frames traversed the same SSE
  // connection before checking that neither was appended.
  await expect(page.locator('.transcript')).toContainText(live + ' Next. Still current.');
  await expect(page.locator('.transcript')).not.toContainText('OUT OF ORDER');
  await expect(page.locator('.transcript')).not.toContainText(' Next. Next.');
  await finish(page);
});

test('an empty redacted frame still advances the sequence without discarding valid text', async ({ page }) => {
  await begin(page);
  held.onDelta?.('');
  held.onDelta?.(' After empty.');
  await expect(page.locator('.transcript')).toContainText(live + ' After empty.');
  expect(frames.filter(frame => frame.kind === 'delta').map(frame => frame.seq)).toEqual([1, 2, 3]);
  await finish(page);
});

for (const [name, fields] of [
  ['attempt', { attempt: 2 }],
  ['fence', { fence: 2 }],
  ['step', { stepId: 'different-step' }],
  ['missing sequence', { seq: undefined }],
] as const) {
  test(`an incompatible ${name} cannot join the current preview`, async ({ page }) => {
    const first = await begin(page);
    store().emit('engine-text', { ...first, seq: 2, ...fields, text: 'WRONG IDENTITY' });
    await expect(page.locator('.transcript')).not.toContainText('WRONG IDENTITY');
    await expect(page.locator('.transcript')).not.toContainText(live);
    await finish(page);
  });
}

test('a real SSE disconnect discards preview text and reconnect reloads records without replay', async ({ page }) => {
  await begin(page);
  const before = streams.length;
  streams.at(-1)!.end();
  await expect(page.locator('.transcript')).not.toContainText(live);
  await expect.poll(() => streams.length).toBeGreaterThan(before);
  held.onDelta?.(' AFTER RECONNECT');
  await expect(page.locator('.transcript')).not.toContainText('AFTER RECONNECT');
  await finish(page);
  await page.reload();
  await expect(page.locator('.transcript')).toContainText(final);
  expect(calls).toBe(1);
});
