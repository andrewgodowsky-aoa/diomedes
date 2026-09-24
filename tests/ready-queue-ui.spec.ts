import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project, ProjectState, Task } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

// H07 Board journey, in the real built UI against an owned host of its own, so no other spec's
// running work can hold the queue's global slots. The sample route only: no model calls. Setup
// goes through the API; every claim about the Board is read from the Board.

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${route} failed: ${JSON.stringify(payload)}`);
  return payload as T;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'ready-queue-ui-'));
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
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  const source = Math.max(
    ...(await Promise.all(
      ['client/console/BoardView.tsx', 'client/ready-queue.ts', 'shared/ready-queue.ts'].map(
        async (file) => (await fs.stat(file)).mtimeMs,
      ),
    )),
  );
  expect(built, 'dist is older than the Ready queue sources. Run "npx vite build" first.').toBeGreaterThan(source);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', application);
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  }
});

const board = (page: Page) => page.locator('.board[aria-label="Board"]');
const queue = (page: Page) => board(page).getByLabel('Ready queue', { exact: true });
const readyRow = (page: Page, name: string) =>
  board(page).locator('.column[aria-label="Ready"] .crow', { hasText: name });

test('the Board turns automatic start on, pauses with a reason, and says why each item waits', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = await api<Project>('/projects/sample', 'POST', {});
  const initial = await api<ProjectState>(`/projects/${project.id}/state`);
  for (const task of initial.tasks) await api(`/projects/${project.id}/tasks/${task.id}`, 'DELETE');
  const first = await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name: 'Count the walk-in' });
  await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name: 'Order produce' });
  await api('/settings', 'PUT', {
    detail: 'technical',
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
    openProjects: [project.id],
  });

  await page.goto(baseURL);
  await reopenLastProject(page);
  await page.getByRole('navigation', { name: 'Threads and views' }).getByRole('button', { name: /^Board/ }).click();
  await expect(board(page)).toBeVisible();

  // Off by default: exactly today's Board.
  const auto = queue(page).getByRole('switch', { name: 'Start ready work automatically' });
  await expect(auto).not.toBeChecked();
  await expect(queue(page).locator('[data-queue-state]')).toHaveText('You start Ready work');
  await expect(board(page).locator('.column[aria-label="Ready"] > .why')).toHaveText('Start explicitly to run');
  await expect(readyRow(page, 'Count the walk-in')).not.toHaveAttribute('data-queue-why', /.*/);

  // Pause first, with a reason, then turn automatic start on: nothing starts.
  await queue(page).getByRole('button', { name: 'Pause queue' }).click();
  await queue(page).getByRole('textbox', { name: 'Reason' }).fill('Stocktake tonight');
  await queue(page).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(queue(page).locator('[data-queue-state]')).toHaveText('Queue paused · Stocktake tonight');
  await auto.click();
  await expect(auto).toBeChecked();
  await expect(readyRow(page, 'Count the walk-in')).toHaveAttribute('data-queue-why', 'paused');
  await expect(readyRow(page, 'Count the walk-in').locator('.why')).toHaveText('Queue paused · #1 in line');
  await expect(readyRow(page, 'Order produce').locator('.why')).toHaveText('Queue paused · #2 in line');
  // A compact row (the default) keeps the place visible, with the reason as its title.
  await expect(readyRow(page, 'Order produce').locator('.m .q')).toHaveText('#2');
  await expect(readyRow(page, 'Order produce').locator('.m .q')).toHaveAttribute('title', 'Queue paused · #2 in line');
  expect((await api<ProjectState>(`/projects/${project.id}/state`)).sessions).toEqual([]);
  await page.screenshot({ path: path.join(fixtureRoot, 'board-queue-paused.png') });

  // Resume: the oldest starts on its own and stops at its Need; the next says why it waits.
  await queue(page).getByRole('button', { name: 'Resume queue' }).click();
  await expect(board(page).locator('.column[aria-label="Review"] .crow', { hasText: 'Count the walk-in' })).toBeVisible();
  await expect(readyRow(page, 'Order produce')).toHaveAttribute('data-queue-why', 'awaiting-decision');
  await expect(readyRow(page, 'Order produce').locator('.why')).toHaveText('Next · waits on a decision in this project');
  await expect(board(page).locator('.column[aria-label="Ready"] > .why')).toHaveText('Starts automatically, oldest first');
  await expect(queue(page).locator('[data-queue-state]')).toHaveText(
    'Starts automatically · 1 of 2 running across projects',
  );
  const after = await api<ProjectState>(`/projects/${project.id}/state`);
  expect(after.sessions.map((session) => session.taskId)).toEqual([first.id]);
  expect(after.needs.filter((need) => need.state === 'open')).toHaveLength(1);
  expect(after.history.map((entry) => entry.sentence)).toContain(
    'Diomedes started Count the walk-in from the Ready queue.',
  );

  // Pause every queue: the label says so, and running work keeps running.
  await queue(page).getByRole('button', { name: 'Pause all' }).click();
  await queue(page).getByRole('button', { name: 'Pause all queues' }).click();
  await expect(queue(page).locator('[data-queue-state]')).toHaveText('All queues paused · Paused by you');
  await expect(readyRow(page, 'Order produce')).toHaveAttribute('data-queue-why', 'all-paused');
  expect((await api<ProjectState>(`/projects/${project.id}/state`)).sessions[0].state).toBe('waiting');
  await page.screenshot({ path: path.join(fixtureRoot, 'board-queue-running.png') });
  await queue(page).getByRole('button', { name: 'Resume all' }).click();
  await expect(queue(page).locator('[data-queue-state]')).toHaveText(
    'Starts automatically · 1 of 2 running across projects',
  );
  expect(errors).toEqual([]);
});
