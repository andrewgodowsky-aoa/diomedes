import { test, expect } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project } from '../shared/types';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let base: string;
let first: Project;
let second: Project;

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}

test.beforeAll(async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/fd03-browser-'));
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    port,
    clientPort: port,
    reviewerAdapter: null,
    nativeGenerator: async () => {
      throw new Error('Readiness must not call a provider');
    },
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const source of ['client/console/ReadinessPage.tsx', 'client/console/readiness.css'])
    expect(built, `Run vite build before testing ${source}`).toBeGreaterThan(
      (await fs.stat(source)).mtimeMs,
    );
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
  first = await api<Project>('/projects', 'POST', { name: 'North shop' });
  second = await api<Project>('/projects', 'POST', { name: 'South shop' });
  await api('/settings', 'PUT', {
    surface: 'console',
    openProjects: [first.id, second.id],
    onboarding: {
      work: 'business',
      detail: 'guided',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
});

test.afterAll(async () => {
  if (app) await app.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('readiness shows independent unknown proof and refreshes saved status with stale responses fenced', async ({
  page,
}, testInfo) => {
  const requests: { method: string; url: URL }[] = [];
  let firstRead = true;
  let releaseStale!: () => void;
  const staleGate = new Promise<void>((resolve) => (releaseStale = resolve));
  await page.route('**/api/readiness**', async (route) => {
    requests.push({ method: route.request().method(), url: new URL(route.request().url()) });
    const response = await route.fetch();
    const payload = await response.json();
    if (firstRead) {
      firstRead = false;
      payload.readiness.build.version = 'stale response';
      await staleGate;
    } else {
      payload.readiness.build.version = 'current response';
    }
    try {
      await route.fulfill({ response, json: payload });
    } catch {
      // Project switching aborts the first GET; that is the behavior under test.
    }
  });

  await page.goto(base);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Readiness', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'Open projects' })
    .getByRole('button', { name: 'North shop' })
    .click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Readiness', exact: true })
    .click();
  await expect(page.getByText('Build current response', { exact: true })).toBeVisible();
  releaseStale();
  await expect(page.getByText('Build stale response', { exact: true })).toHaveCount(0);

  const sample = page
    .locator('.ready-capability')
    .filter({ has: page.getByRole('heading', { name: 'Sample', exact: true }) });
  await expect(sample.locator('.ready-axis').filter({ hasText: 'Verified' })).toContainText(
    'Unknown',
  );
  await expect(
    page.locator('.ready-workflow').filter({ hasText: 'Create a deterministic sample draft' }),
  ).toContainText('Blocked');
  await sample.getByText('Sources and freshness', { exact: true }).click();
  await expect(sample.getByText(/validated-evidence/)).toBeVisible();

  const beforeRefresh = requests.length;
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(beforeRefresh);
  const unscopedResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/readiness' && !url.searchParams.has('projectId');
  });
  await page.getByLabel("Include this project's saved connection status").uncheck();
  await unscopedResponse;
  await expect
    .poll(() => requests.some((request) => !request.url.searchParams.has('projectId')))
    .toBe(true);
  expect(requests.every((request) => request.method === 'GET')).toBe(true);
  expect(requests.some((request) => request.url.searchParams.get('projectId') === first.id)).toBe(
    true,
  );

  await page.unroute('**/api/readiness**');
  const realResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/readiness' && response.request().method() === 'GET';
  });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await realResponse;
  await expect(page.getByText('Build 0.1.4', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('readiness.png'), fullPage: true });
});
