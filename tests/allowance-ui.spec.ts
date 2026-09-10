import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project } from '../shared/types';
import type { WorkspaceView } from '../shared/workspaces';

/**
 * Browser proof of the two things a business owner now has in the Console:
 * somewhere for its work to go, and an honest answer about managed access.
 *
 * The output picker is the piece that made a working weekly brief reachable.
 * The managed-access section is the piece that must never grow a balance it
 * does not have — a drawn zero would read as a spent allowance, so the test
 * asserts the numbers are absent rather than zero.
 */
test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';
let organizationName = '';
let projectName = '';

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(
      `Allowance fixture ${route} failed (${response.status}): ${await response.text()}`,
    );
  return response.json() as Promise<T>;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'allowance-ui-'));
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

  // The sample project names itself; hold the name rather than assuming it.
  const project = await api<Project>('/projects/sample', 'POST', {});
  projectName = project.name;
  await api('/settings', 'PUT', {
    surface: 'console',
    detail: 'technical',
    onboarding: {
      work: 'personal',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
    openProjects: [project.id],
  });

  organizationName = 'Fernbrook Joinery';
  const created = await api<WorkspaceView>('/workspace/organizations', 'POST', {
    name: organizationName,
    industry: null,
  });
  const organizationId = created.organizations.at(-1)!.organization.id;
  await api('/workspace/switch', 'POST', { kind: 'business', organizationId });
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

async function openPanel(page: Page) {
  await page.goto(`${baseURL}/`);
  await expect(page.locator('.console')).toBeVisible();
  await page.getByRole('button', { name: 'Change workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
}

test('a business is told where its work will go, before it goes anywhere', async ({ page }) => {
  await openPanel(page);
  const section = page.locator('.ws-section', {
    has: page.getByRole('heading', { name: `Where ${organizationName} writes` }),
  });
  await expect(section).toBeVisible();

  // Nothing is chosen, so nothing claims to be.
  await expect(section.locator('.ws-bound')).toHaveCount(0);
  const picker = section.locator('.ws-select');
  await expect(picker).toBeEnabled();

  await picker.selectOption({ label: projectName });
  await expect(section.locator('.ws-bound')).toContainText(projectName);
});

test('the brief says what is missing rather than writing something empty', async ({ page }) => {
  await openPanel(page);
  const section = page.locator('.ws-section', {
    has: page.getByRole('heading', { name: `Where ${organizationName} writes` }),
  });
  // A project is bound from the previous test; the setup is still not running.
  await expect(section.locator('.ws-bound')).toContainText(projectName);
  await section.getByRole('button', { name: 'Prepare the weekly brief' }).click();

  // Choosing where decides where, never whether.
  await expect(page.locator('.ws-error')).toContainText('no setup running');
});

test('managed access shows no balance, because there is none to show', async ({ page }) => {
  await openPanel(page);
  const section = page.locator('.ws-section', {
    has: page.getByRole('heading', { name: 'Managed model access' }),
  });
  await expect(section).toBeVisible();

  // The contract's own sentence, so nobody reads the allowance as money.
  await expect(section).toContainText('not withdrawable money');
  await expect(section).toContainText('no entitlement service');

  // No figures at all. A drawn zero would read as a spent allowance.
  await expect(section.locator('.ws-allowance')).toHaveCount(0);
  await expect(section).not.toContainText('$0.00');

  // What would come out of it, and what would not, from the rate card itself.
  await expect(section).toContainText('Comes out of it');
  await expect(section).toContainText('Does not');
});

test('the panel holds together in a narrow window with a long name', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const long = 'Llanfairpwllgwyngyll Joinery and Cabinetmaking Partnership Limited';
  const created = await api<WorkspaceView>('/workspace/organizations', 'POST', {
    name: long,
    industry: null,
  });
  const organizationId = created.organizations.at(-1)!.organization.id;
  await api('/workspace/switch', 'POST', { kind: 'business', organizationId });

  await openPanel(page);
  await expect(page.getByRole('heading', { name: `Where ${long} writes` })).toBeVisible();

  // The rule the repository states plainly: no machine string pushes a fixed
  // surface wide. Nothing scrolls sideways, at any name length.
  const overflows = await page.evaluate(() => {
    const dialog = document.querySelector('.dialog-body');
    return {
      body: document.body.scrollWidth > document.body.clientWidth,
      dialog: !!dialog && dialog.scrollWidth > dialog.clientWidth,
    };
  });
  expect(overflows.body).toBe(false);
  expect(overflows.dialog).toBe(false);
});
