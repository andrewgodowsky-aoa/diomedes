import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import { routeContractFor } from '../server/harness/route-contract';
import type { TextRequest } from '../server/engines/contract';
import type { Store } from '../server/store';
import type { HarnessHost } from '../server/harness/host';
import type { Project, Conversation } from '../shared/types';
import { shareAfter } from './fixtures/cloud-sharing-grant';

// Actual built Console, HTTP/SSE, createApp, EngineService and host RunService.
// Only discovery and the provider's transport callback are scripted; no inference.
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let root: string;
let project: Project;
let thread: Conversation;
let held: TextRequest | undefined;
let release: (() => void) | undefined;
let calls: number;
let frames: Record<string, unknown>[];
const engine = 'claude-code';
const model = 'local-browser-model';
const liveText = 'Current owned preview.';
const finalText = 'Final committed fixture answer.';
const store = () => app.locals.store as Store;
const host = () => app.locals.harness as HarnessHost;
async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${endpoint}`, { method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${endpoint}: ${response.status}`).toBe(true);
  const value = (await response.json()) as T;
  await shareAfter(api, endpoint, method, value);
  return value;
}
test.beforeEach(async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  root = await fs.mkdtemp(path.resolve('test-results', 'independent-h01-final-'));
  frames = []; calls = 0; held = undefined; release = undefined;
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [{ id: engine, name: 'Local browser fixture', kind: 'online', found: true,
      available: false, enabled: false, status: 'Installed', detail: 'No inference', capabilities: [],
      signIn: 'unknown', adapter: 'planned', installedVersion: TESTED_VERSIONS[engine],
      location: path.join(root, 'provider.fixture'), disclosure: [] }],
    version: async () => TESTED_VERSIONS[engine],
    adapter: () => ({ id: engine, contract: routeContractFor(engine),
      inspect: async () => ({ authentication: 'signed-in', accountRoute: 'claude-code:fixture-account',
        models: [{ slug: model, name: 'Local browser model', description: 'Fixture', efforts: [], defaultEffort: null }], detail: 'Fixture' }),
      generate: async input => {
        calls++; held = input;
        input.onDelta?.(liveText);
        await new Promise<void>(resolve => { release = resolve; });
        return { text: finalText, model: input.model, version: TESTED_VERSIONS[engine],
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
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  expect(built, 'Build the exact candidate before Console probes').toBeGreaterThan((await fs.stat('client/console/Shell.tsx')).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
  await api('/ai/discover', 'POST', { consent: true });
  await api(`/ai/check/${engine}`, 'POST', {});
  await api('/ai/select', 'POST', { engine, model });
  project = await api('/projects', 'POST', { name: 'Independent H01 Console' });
  thread = await api(`/projects/${project.id}/threads`, 'POST', { name: 'H01 preview ownership', mode: 'ask' });
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
      throw new Error(`Unexpected nonlocal browser request: ${target.origin}`);
    await route.continue();
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Independent H01 Console', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message this thread', exact: true }).fill('Summarize this synthetic example.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('dialog', { name: 'Send this message?' }).getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.exchange .turn.dio').filter({ hasText: liveText })).toBeVisible();
  expect(calls).toBe(1);
}

test('actual app preview delivery retains sequence for duplicate and gap detection', async ({ page }, info) => {
  await begin(page);
  const delta = frames.find(frame => frame.kind === 'delta')!;
  await info.attach('actual-app-frames', { body: JSON.stringify(frames, null, 2), contentType: 'application/json' });
  expect.soft(delta).toMatchObject({ projectId: project.id, threadId: thread.id, requestId: held!.requestId,
    runId: expect.any(String), stepId: expect.any(String), attempt: expect.any(Number), fence: expect.any(Number), seq: 1 });
  // Replay one exact already-delivered app frame through the existing SSE path.
  // A consumer needs the preserved sequence to recognize this duplicate.
  store().emit('engine-text', structuredClone(delta));
  await expect.soft(page.locator('.exchange .turn.dio')).not.toContainText(liveText + liveText, { timeout: 1500 });
});

test('Console drops provider text from an old attempt after real host takeover', async ({ page }, info) => {
  await begin(page);
  const old = await host().runs.get(String(frames.find(frame => frame.kind === 'delta')!.runId));
  await host().runs.claim(old.id, old.owner!, 1);
  const expiry = (await host().runs.get(old.id)).leaseExpiresAt!;
  await expect.poll(() => Date.now()).toBeGreaterThan(expiry);
  await host().runs.claim(old.id, 'independent-console-new-owner');
  const current = await host().runs.get(old.id);
  expect(current.fence).toBeGreaterThan(old.fence);
  held!.onDelta?.(' STALE OLD OWNER');
  await info.attach('takeover-frames', { body: JSON.stringify({ oldFence: old.fence, newFence: current.fence, frames }, null, 2), contentType: 'application/json' });
  await expect(page.locator('.exchange .turn.dio')).not.toContainText('STALE OLD OWNER', { timeout: 1500 });
});

test('Console rejects a foreign run and reopens the committed answer without provider replay', async ({ page }, info) => {
  await begin(page);
  const delta = frames.find(frame => frame.kind === 'delta')!;
  // Named transport fault injection into the existing Store/SSE path.
  store().emit('engine-text', { ...delta, runId: 'foreign-run', text: 'FOREIGN RUN TEXT' });
  await expect(page.locator('.exchange .turn.dio')).not.toContainText('FOREIGN RUN TEXT');
  release!();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(page.locator('.exchange .turn.dio').filter({ hasText: finalText })).toBeVisible();
  await page.reload();
  await expect(page.locator('.exchange .turn.dio').filter({ hasText: finalText })).toBeVisible();
  expect(calls).toBe(1);
  const saved = await host().runs.get(String(delta.runId));
  expect(saved.state).toBe('completed');
  await page.screenshot({ path: info.outputPath('committed-console-answer.png') });
});
