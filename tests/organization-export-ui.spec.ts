import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { ControlPlaneClient } from '../server/accounts/client';
import { testOnlySecretBox } from '../server/connection-secrets';
import { createFauxCloud, FAUX_BACKEND_LABEL } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import { EXIT_STEPS, OMITTED_CATEGORIES } from '../shared/organization-export';
import type { Project } from '../shared/types';

/**
 * Browser proof of OPS-05 in the Console: the Business owner of a business
 * the account service keeps sees what a copy of its records leaves out and
 * how leaving works, before exporting anything; exporting writes the copy
 * into the project the business writes into and says where.
 *
 * The account service is the real control-plane handler over the faux store,
 * in this process, as the desktop's own tests run it.
 */
test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const BUSINESS = 'Juniper Street Bakery';
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
  if (!response.ok) throw new Error(`Export fixture ${route} failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'organization-export-ui-'));
  const cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  const juniper = (await seedDemo(cloud)).organizations!.juniper;
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
    secretBox: testOnlySecretBox(),
    accounts: {
      backend: {
        client: new ControlPlaneClient('http://faux.local', (request) => cloud.handle(request)),
        view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
        close: async () => {},
      },
    },
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', application);

  // With an account service, nothing but signing in answers before someone has.
  await api('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: false });
  project = await api<Project>('/projects', 'POST', { name: 'Bakery records' });
  await api('/settings', 'PUT', {
    detail: 'technical',
    onboarding: { work: 'personal', detail: 'technical', familiarity: 'comfortable', resumeAt: 'done', completedAt: new Date().toISOString() },
    openProjects: [project.id],
  });
  await api('/workspace/switch', 'POST', { kind: 'business', organizationId: juniper });
  await api(`/workspace/organizations/${juniper}/output`, 'POST', { projectId: project.id });
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  }
});

async function openPanel(page: Page) {
  await page.goto(`${baseURL}/`);
  await expect(page.getByRole('navigation', { name: 'Open projects', exact: true }).getByRole('button').last()).toBeVisible();
  await page.getByRole('navigation', { name: 'Open projects', exact: true }).getByRole('button').last().click();
  await expect(page.locator('.console')).toBeVisible();
  await page.getByRole('button', { name: 'Change workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
  return page.locator('.ws-section', { has: page.getByRole('heading', { name: `${BUSINESS}'s records` }) });
}

test('the owner reads what a copy leaves out and how leaving works, before exporting anything', async ({ page }) => {
  const section = await openPanel(page);
  await expect(section).toBeVisible();
  await expect(section).toContainText('never holds a password, key or sign-in');
  await section.getByText('What the copy leaves out').click();
  for (const item of OMITTED_CATEGORIES) await expect(section).toContainText(item.title);
  await section.getByText('Leaving Nectovia').click();
  for (const step of EXIT_STEPS) await expect(section).toContainText(step.title);
  // The product is called what people see it called.
  await expect(section).not.toContainText('Diomedes');
});

test('exporting writes the copy into the project the business writes into, and says where', async ({ page }) => {
  const section = await openPanel(page);
  await section.getByRole('button', { name: 'Export into Bakery records' }).click();
  const done = section.getByRole('status');
  await expect(done).toContainText(/Written to Exports\/business-records-\S+ in Bakery records: \d+ files, a manifest and a README\./);
  const written = await fs.readdir(path.join(project.folder, 'Exports'));
  expect(written).toHaveLength(1);
  const files = await fs.readdir(path.join(project.folder, 'Exports', written[0]!));
  expect(files).toEqual(expect.arrayContaining(['README.md', 'manifest.json', 'business.json', 'setup-revisions.json', 'account-history.json']));
  await expect(section.locator('.ws-error')).toHaveCount(0);

  // Nothing pushes the panel wide, the folder name included.
  await page.setViewportSize({ width: 900, height: 700 });
  const overflows = await page.evaluate(() => {
    const dialog = document.querySelector('.dialog-body');
    return { body: document.body.scrollWidth > document.body.clientWidth, dialog: !!dialog && dialog.scrollWidth > dialog.clientWidth };
  });
  expect(overflows).toEqual({ body: false, dialog: false });
});
