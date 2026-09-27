import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import { routeContractFor } from '../server/harness/route-contract';
import type { AdapterRouteContract } from '../shared/adapter-contract';
import { AGENT_NAME } from '../shared/agent-name';
import { shareAfter } from './fixtures/cloud-sharing-grant';

// The actual app, host, SSE and built Console; only the engine is scripted. It thinks, waits,
// starts its answer, waits again, then finishes, so the live fold and the saved one are each
// seen on their own.
const thought = 'Weighing the menu.';
const answer = 'Soup and bread.';
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let answering: () => void;
let finishing: () => void;
async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${endpoint}`, { method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${endpoint}: ${response.status}`).toBe(true);
  const value = (await response.json()) as T;
  await shareAfter(api, endpoint, method, value);
  return value;
}
async function start(reasoning: AdapterRouteContract['streaming']['reasoning']) {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results', 'reasoning-ui-'));
  const toAnswer = new Promise<void>(resolve => { answering = resolve; });
  const toFinish = new Promise<void>(resolve => { finishing = resolve; });
  const engine = 'claude-code';
  const model = 'fixture-model';
  const declared = routeContractFor(engine);
  const contract = { ...declared, streaming: { ...declared.streaming, reasoning } };
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [{ id: engine, name: 'Local fixture', kind: 'online',
      found: true, available: false, enabled: false, status: 'Installed', detail: '',
      capabilities: [], signIn: 'unknown', adapter: 'planned',
      installedVersion: TESTED_VERSIONS[engine], location: 'fixture', disclosure: [] }],
    version: async () => TESTED_VERSIONS[engine],
    adapter: () => ({ id: engine, contract,
      inspect: async () => ({ authentication: 'signed-in', accountRoute: 'fixture:account',
        models: [{ slug: model, name: 'Fixture', description: '', efforts: [], defaultEffort: null }], detail: '' }),
      generate: async input => {
        input.onReasoningDelta?.(thought);
        await toAnswer;
        input.onDelta?.(answer);
        await toFinish;
        return { text: answer, model: input.model, version: TESTED_VERSIONS[engine],
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
  const dist = path.resolve('dist');
  expect((await fs.stat(path.join(dist, 'index.html'))).mtimeMs)
    .toBeGreaterThan((await fs.stat('client/console/Thinking.tsx')).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', (req, res) => app(req, res));
  await api('/ai/discover', 'POST', { consent: true });
  await api(`/ai/check/${engine}`, 'POST', {});
  await api('/ai/select', 'POST', { engine, model });
  const project = await api<{ id: string }>('/projects', 'POST', { name: 'Thinking shown' });
  await api(`/projects/${project.id}/threads`, 'POST', { name: 'Lunch menu', mode: 'ask' });
  await api('/settings', 'PUT', { detail: 'technical', openProjects: [project.id],
    onboarding: { work: 'business', detail: 'technical', familiarity: 'comfortable', resumeAt: 'done', completedAt: new Date().toISOString() } });
}
test.afterEach(async () => {
  answering?.();
  finishing?.();
  await app?.locals.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});
async function send(page: Page) {
  await page.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (target.protocol.startsWith('http') && target.hostname !== '127.0.0.1')
      throw new Error(`Unexpected nonlocal request: ${target.origin}`);
    await route.continue();
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Thinking shown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message this thread', exact: true }).fill('What is on the lunch menu?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('dialog', { name: 'Send this message?' }).getByRole('button', { name: 'Send message', exact: true }).click();
}

test('thinking streams above the reply, folds at the first answer text, and stays folded on the saved reply', async ({ page }) => {
  await start('reasoning-delta');
  await send(page);
  const transcript = page.locator('.transcript');
  const liveLabel = transcript.locator('.who .mono', { hasText: /^live$/ });
  // While the engine thinks: its thinking, open and muted, and no waiting line.
  await expect(transcript.getByText('Thinking', { exact: true })).toBeVisible();
  await expect(transcript.getByText(thought)).toBeVisible();
  await expect(transcript).not.toContainText(`${AGENT_NAME} is `);

  // The first answer text folds the live thinking to one closed line.
  answering();
  await expect(transcript).toContainText(answer);
  await expect(liveLabel).toHaveCount(1);
  const liveFold = transcript.getByRole('button', { name: /^Thought for/ });
  await expect(liveFold).toHaveAttribute('aria-expanded', 'false');
  await expect(transcript.getByText(thought)).toBeHidden();
  await expect(transcript.getByText('Thinking', { exact: true })).toHaveCount(0);

  // The saved reply replaces the live one and keeps the thinking, folded until it is opened.
  finishing();
  await expect(liveLabel).toHaveCount(0);
  await expect(transcript).toContainText(answer);
  const fold = transcript.getByRole('button', { name: /^Thought for/ });
  await expect(fold).toHaveCount(1);
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(transcript.getByText(thought)).toBeHidden();
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(transcript.getByText(thought)).toBeVisible();

  // After a reload it is the saved record that shows it.
  await page.reload();
  await expect(transcript).toContainText(answer);
  const saved = transcript.getByRole('button', { name: /^Thought for/ });
  await expect(saved).toHaveAttribute('aria-expanded', 'false');
  await expect(transcript.getByText(thought)).toBeHidden();
  await saved.click();
  await expect(transcript.getByText(thought)).toBeVisible();
});

test('a route that declares no thinking shows none, live or saved', async ({ page }) => {
  await start('none');
  await send(page);
  const transcript = page.locator('.transcript');
  answering();
  finishing();
  await expect(transcript.locator('.who .mono', { hasText: /^live$/ })).toHaveCount(0);
  await expect(transcript).toContainText(answer);
  await expect(transcript.getByText('Thinking', { exact: true })).toHaveCount(0);
  await expect(transcript.getByRole('button', { name: /^Thought for/ })).toHaveCount(0);
  await expect(transcript).not.toContainText(thought);
  await page.reload();
  await expect(transcript).toContainText(answer);
  await expect(transcript.getByRole('button', { name: /^Thought for/ })).toHaveCount(0);
});
