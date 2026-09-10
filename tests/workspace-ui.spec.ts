import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project } from '../shared/types';

/**
 * Browser proof of the workspace boundary in the real Console.
 *
 * Personal is where the app opens and it is never offered the company
 * questions. Creating a business is an explicit act that says what it is —
 * a labelled local fixture, not a hosted organization — and the intake that
 * follows belongs to that business.
 */
test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const EVIDENCE = path.resolve('evidence/workspaces');
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(
      `Workspace fixture ${route} failed (${response.status}): ${await response.text()}`,
    );
  return response.json() as Promise<T>;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  await fs.mkdir(EVIDENCE, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'workspace-ui-'));
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

  const project = await api<Project>('/projects/sample', 'POST', {});
  await api('/settings', 'PUT', {
    surface: 'console',
    detail: 'technical',
    // A legacy "business" answer is present on purpose: the interface must
    // still open in Personal and still not offer the company questions.
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
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

const mark = (page: Page) => page.getByRole('button', { name: 'Change workspace' });

async function open(page: Page) {
  await page.goto(`${baseURL}/`);
  await expect(page.locator('.console')).toBeVisible();
  await expect(mark(page)).toBeVisible();
}

test('the Console opens in Personal and names it where a person will see it', async ({ page }) => {
  await open(page);
  await expect(mark(page)).toContainText('Personal');
  await page.screenshot({ path: path.join(EVIDENCE, 'personal-rail.png') });
});

test('Personal is offered no business questions, and the old preference is explained', async ({
  page,
}) => {
  await open(page);
  await mark(page).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByText('It never asks the business questions.')).toBeVisible();
  await expect(panel.getByRole('heading', { name: /^Set up/ })).toHaveCount(0);
  await expect(panel.getByText(/does not create a business workspace/)).toBeVisible();
  await expect(panel.getByText(/no production identity service/i)).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE, 'workspace-panel-personal.png') });
});

test('creating a business is explicit, and says what it actually is', async ({ page }) => {
  await open(page);
  await mark(page).click();
  const panel = page.getByRole('dialog');
  await panel.getByLabel('Business name').fill('Ridge Cabinetry');
  await panel.getByLabel('Kind of work (optional)').fill('cabinetry');
  await panel.getByRole('button', { name: 'Create business workspace' }).click();

  await expect(panel.getByRole('heading', { name: 'Set up Ridge Cabinetry' })).toBeVisible();
  await expect(panel.getByText('Business: Ridge Cabinetry')).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE, 'workspace-panel-business.png') });

  await panel.getByRole('button', { name: 'Close dialog' }).click();
  await expect(mark(page)).toContainText('Business: Ridge Cabinetry');
  await expect(page.getByText('Development identity — not verified')).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE, 'business-rail.png') });
});

test('the intake asks one question at a time, with a reason and a way back', async ({ page }) => {
  await open(page);
  await mark(page).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('button', { name: 'Start setup' }).click();

  await expect(panel.getByText(/Answers are recorded as facts/)).toBeVisible();
  await panel.getByRole('button', { name: 'Start', exact: true }).click();

  const first = 'What should we call your business, and what work do you do?';
  await expect(panel.getByRole('heading', { name: first })).toBeVisible();
  await expect(panel.getByText('It selects examples, not authority.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Back' })).toBeDisabled();
  await page.screenshot({ path: path.join(EVIDENCE, 'intake-first-question.png') });

  await panel.getByLabel(first).fill('Ridge Cabinetry');
  await panel.getByRole('button', { name: 'Continue' }).click();

  await expect(panel.getByRole('heading', { name: /What kind of work is that/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: "I don't know" })).toBeVisible();
  await panel.getByRole('button', { name: 'Back' }).click();
  await expect(panel.getByLabel(first)).toHaveValue('Ridge Cabinetry');
  await page.screenshot({ path: path.join(EVIDENCE, 'intake-back.png') });
});

test('a credential typed into an answer is refused where the person can read why', async ({
  page,
}) => {
  await open(page);
  await mark(page).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('button', { name: 'Resume setup' }).click();
  const first = 'What should we call your business, and what work do you do?';
  await expect(panel.getByRole('heading', { name: first })).toBeVisible();
  await panel.getByLabel(first).fill('our api key: sk-live-AbCdEfGhIjKlMnOpQrSt');
  await panel.getByRole('button', { name: 'Continue' }).click();
  await expect(panel.getByRole('alert')).toContainText(/credentials cannot be collected here/i);
  await page.screenshot({ path: path.join(EVIDENCE, 'intake-secret-refused.png') });
});
