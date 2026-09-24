import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project, Settings } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

/**
 * The Console's two views (Andrew, 2026-09-23). Conversation is the prompt box
 * and the threads; Architect is the full Console. A view changes what is shown,
 * never what Nectovia can do, so each hidden thing is checked for a way back:
 * the ··· menu, Ctrl K and Settings all switch, and a Need waiting outside the
 * open thread is still reachable without the Ledger that used to list it.
 */
test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';
let project: Project;

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(`View fixture ${route} failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'console-view-ui-'));
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  baseURL = `http://127.0.0.1:${port}`;
  application = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(fixtureRoot, 'data'),
    projectRoot: path.join(fixtureRoot, 'projects'),
    nativeGenerator: async () => ({ model: 'fixture-model', text: '{"summary":"","changes":[]}' }),
    reviewerAdapter: null,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server.on('request', application);

  project = await api<Project>('/projects/sample', 'POST', {});
  await api(`/projects/${project.id}/threads`, 'POST', { name: 'Talk it through' });
  await api('/settings', 'PUT', {
    view: 'conversation',
    detail: 'standard',
    onboarding: {
      work: 'business',
      detail: 'standard',
      familiarity: 'some',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
    openProjects: [project.id],
  });
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

const rail = (page: Page) => page.getByRole('navigation', { name: 'Threads and views' });
const ledger = (page: Page) => page.getByRole('complementary', { name: 'This project' });

async function enter(page: Page) {
  await page.goto(`${baseURL}/`);
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
}

test('Conversation shows the prompt box and the threads, and nothing else', async ({ page }) => {
  await enter(page);
  await expect(page.locator('html')).toHaveAttribute('data-view', 'conversation');
  await rail(page).getByRole('button', { name: /Talk it through/ }).click();
  await expect(page.getByRole('textbox', { name: /Ask or think out loud|message/i }).first()).toBeVisible();
  await expect(ledger(page)).toHaveCount(0);
  // Pinned destinations are hidden, not forgotten; Everything stays the way to them.
  await expect(rail(page).locator('.foot').getByRole('button', { name: /^Board\b/ })).toHaveCount(0);
  await expect(rail(page).getByRole('button', { name: 'Everything', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Worker for this thread' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the ··· menu switches to Architect and back, and the choice is kept', async ({ page }) => {
  await enter(page);
  await page.getByRole('button', { name: 'Interface detail menu' }).click();
  await page.getByRole('menuitemradio', { name: 'Architect' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-view', 'architect');
  await rail(page).getByRole('button', { name: /Talk it through/ }).click();
  await expect(ledger(page)).toBeVisible();
  await expect(rail(page).locator('.foot').getByRole('button', { name: /^Board\b/ })).toBeVisible();
  expect((await api<Settings>('/settings')).view).toBe('architect');

  // A reload is where a surface used to be reset; a view is not.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-view', 'architect');

  await page.getByRole('button', { name: 'Interface detail menu' }).click();
  await page.getByRole('menuitemradio', { name: 'Conversation' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-view', 'conversation');
  await expect(ledger(page)).toHaveCount(0);
  expect((await api<Settings>('/settings')).view).toBe('conversation');
});

test('Ctrl K offers the other view as a switch', async ({ page }) => {
  await enter(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Find and act' });
  await expect(palette).toBeVisible();
  await palette.getByRole('textbox').fill('architect');
  await palette.getByText('Architect view', { exact: true }).click();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-view', 'architect');
  await api('/settings', 'PUT', { view: 'conversation' });
});

test('Settings chooses the view under Appearance', async ({ page }) => {
  await enter(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  await expect(page.getByRole('radio', { name: /Conversation/ })).toBeChecked();
  // The radio is controlled: it shows the stored view, so it turns once the save lands.
  await page.getByRole('radio', { name: /Architect/ }).click();
  await expect(page.getByRole('radio', { name: /Architect/ })).toBeChecked();
  expect((await api<Settings>('/settings')).view).toBe('architect');
  await api('/settings', 'PUT', { view: 'conversation' });
});

test('a Need outside the open thread is reachable without the Ledger', async ({ page }) => {
  const session = await api<{ id: string }>(`/projects/${project.id}/work/start`, 'POST', {
    capabilityId: 'format-report',
    taskId: null,
    instruction: 'Format the shipped synthetic fixture.',
  });
  await expect
    .poll(
      async () =>
        (await api<{ sessions: { id: string; state: string }[] }>(`/projects/${project.id}/state`))
          .sessions.find((s) => s.id === session.id)?.state,
      { timeout: 30_000 },
    )
    .toBe('waiting');
  // A task's own thread owns only that task's Needs, so with it open the
  // fixture's Need waits elsewhere: in the project thread, Talk it through.
  const task = await api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', {
    name: 'Price the spring menu',
  });
  await api(`/projects/${project.id}/threads`, 'POST', { taskId: task.id, name: 'Spring menu' });
  await enter(page);
  await rail(page).getByRole('button', { name: /Spring menu/ }).click();
  await expect(page.getByRole('region', { name: 'Needs your OK' })).toHaveCount(0);
  const chip = page.getByRole('button', { name: 'Something needs your OK' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole('region', { name: 'Needs your OK' })).toBeVisible();
  await expect(rail(page).getByRole('button', { name: /Talk it through/ })).toHaveClass(/on/);
  await expect(chip).toHaveCount(0);
});
