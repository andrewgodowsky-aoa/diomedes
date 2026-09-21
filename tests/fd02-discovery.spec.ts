import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project } from '../shared/types';
import type { ProspectDiscoveryRecord } from '../shared/discovery';
import { reopenLastProject } from './fixtures/landing';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

/**
 * Open a Console destination. These tests were written against the fixed rail
 * foot, which Everything replaced, so a view is reached through that menu and
 * not through a button inside a navigation landmark. A row names its
 * destination and then explains it, so the accessible name is matched from the
 * front rather than exactly.
 */
const openDestination = async (page: Page, label: string) => {
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${label}\\b`) }).click();
};

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let base: string;
let project: Project;
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
  const root = await fs.mkdtemp(path.resolve('test-results/fd02-browser-'));
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
      throw new Error('Discovery must not call a provider');
    },
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const source of [
    'client/console/DiscoveryPage.tsx',
    'client/console/Discovery.tsx',
    'shared/discovery.ts',
  ])
    expect(built, `Run vite build before testing ${source}`).toBeGreaterThan(
      (await fs.stat(source)).mtimeMs,
    );
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
  project = await api<Project>('/projects', 'POST', { name: 'Discovery meetings' });
  await api('/settings', 'PUT', {
    surface: 'console',
    openProjects: [project.id],
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

test('a facilitator creates, corrects, classifies and exports a prospect without a customer account', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await openDestination(page, 'Discovery');
  await page.getByLabel('Business name', { exact: true }).fill('Harbor Workshop');
  await page.getByLabel('Goals, one per line').fill('Reduce repeated copying');
  await page
    .getByLabel('Current process, one step per line')
    .fill('Compare weekly exports\nWrite the review note');
  await page.getByLabel('Who does this work?').fill('Owner');
  await page
    .getByLabel('Idea to check with the owner')
    .fill('A review note could save preparation time');
  await page.getByLabel('Workflow to explore').fill('Weekly operations review');
  await page.getByRole('button', { name: 'Create discovery record' }).click();
  await expect(page.getByRole('heading', { name: 'Harbor Workshop', exact: true })).toBeVisible();
  await expect(page.getByText('Reported by consultant', { exact: true }).first()).toBeVisible();
  await page.getByRole('combobox', { name: 'Meeting outcome', exact: true }).selectOption('not-a-weak-point');
  await expect(page.getByRole('combobox', { name: 'Meeting outcome', exact: true })).toHaveValue('not-a-weak-point');
  await page.getByRole('combobox', { name: 'Stage', exact: true }).selectOption('proposed-workflow');
  await expect(page.getByRole('combobox', { name: 'Stage', exact: true })).toHaveValue('proposed-workflow');
  await page.getByText("Record an owner's correction", { exact: true }).click();
  const { record: before } = await api<{ record: ProspectDiscoveryRecord }>('/discovery');
  await page.getByRole('combobox', { name: 'Fact', exact: true }).selectOption(before.goalFactIds[0]!);
  await page
    .getByLabel('What the owner said', { exact: true })
    .fill('The owner already has a quick review');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(
    page.locator('.disc-facts').getByText('The owner already has a quick review', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Reported by owner', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Export through Files', exact: true }).click();
  await expect(page.locator('.disc-exports li')).toHaveCount(1);
  const { record } = await api<{ record: ProspectDiscoveryRecord }>('/discovery');
  const exported = await api<{ text: string }>(
    `/projects/${project.id}/documents/read?path=${encodeURIComponent(record.exports[0]!.path)}`,
  );
  expect(exported.text).toContain('The owner already has a quick review');
  expect(exported.text).toMatch(/not.a.weak.point/i);
  await page.reload();
  await openDestination(page, 'Discovery');
  await expect(page.getByRole('heading', { name: 'Harbor Workshop', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Meeting outcome', exact: true })).toHaveValue('not-a-weak-point');
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('discovery-record.png'), fullPage: true });
  await page.getByRole('button', { name: 'New prospect', exact: true }).click();
  await expect(page.getByLabel('Goals, one per line')).toHaveValue('');
  await expect(page.getByLabel('Current process, one step per line')).toHaveValue('');
  await page.getByLabel('Business name', { exact: true }).fill('Second workshop');
  await page.getByLabel('Goals, one per line').fill('Review orders');
  await page.getByLabel('Current process, one step per line').fill('Read the order list');
  await page.getByLabel('Who does this work?').fill('Manager');
  await page.getByLabel('Idea to check with the owner').fill('A daily order note may help');
  await page.getByLabel('Workflow to explore').fill('Daily review');
  await page.getByRole('button', { name: 'Create discovery record', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Second workshop', exact: true })).toBeVisible();
  await expect(page.getByText('Harbor Workshop', { exact: true })).toHaveCount(0);
  await expect(page.locator('.disc-exports li')).toHaveCount(0);
  expect(errors).toEqual([]);
});
