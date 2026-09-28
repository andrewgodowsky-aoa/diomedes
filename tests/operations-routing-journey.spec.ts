import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { ControlPlaneClient } from '../server/accounts/client';
import { testOnlySecretBox } from '../server/connection-secrets';
import { FAUX_BACKEND_LABEL } from '../services/control-plane/src/faux/cloud';
import { FAUX_DEMO_PASSWORD } from '../services/control-plane/src/faux/seed';
import { fixtureBinding, startRoutingFixture } from '../docs/implementation/operations-routing-handoff/fixture-server';
import type { MessageResult } from '../shared/conversation';

test.describe.configure({ mode: 'serial' });
let fixture: Awaited<ReturnType<typeof startRoutingFixture>> | undefined;
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let appServer: Server | undefined, bridge: ChildProcess | undefined;
let root = '', appURL = '', opsURL = '', organization = '';
let home: { projectId: string; threadId: string };
const HEADERS = { 'content-type': 'application/json', 'x-diomedes-client': '1' };

async function api<T>(route: string, method = 'GET', value?: unknown): Promise<T> {
  const response = await fetch(`${appURL}/api${route}`, { method, headers: HEADERS, body: value === undefined ? undefined : JSON.stringify(value) });
  const body = await response.text();
  expect(response.ok, `${route}: ${response.status} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

test.beforeAll(async () => {
  const opsRoot = process.env.NECTOVIA_OPS_REPO;
  if (!opsRoot || !path.isAbsolute(opsRoot)) throw new Error('Set NECTOVIA_OPS_REPO to the reviewed Operations worktree.');
  await fs.access(path.join(opsRoot, 'dist', 'index.html'));
  await fs.access(path.resolve('dist/index.html'));
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  root = await fs.mkdtemp(path.join(results, 'operations-routing-journey-'));
  fixture = await startRoutingFixture(path.join(root, 'cloud.json'));
  organization = fixture.seed!.organizations!.juniper;

  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const opsPort = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  opsURL = `http://127.0.0.1:${opsPort}`;
  bridge = spawn(process.execPath, [path.join(opsRoot, 'scripts', 'bridge.mjs'), '--port', String(opsPort), '--service', fixture.url],
    { cwd: opsRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Operations bridge did not start.')), 15_000);
    bridge!.once('error', error => { clearTimeout(timer); reject(error); });
    bridge!.once('exit', code => { clearTimeout(timer); reject(new Error(`Operations bridge exited ${code}.`)); });
    bridge!.stdout!.on('data', chunk => {
      output += String(chunk);
      if (output.includes(`Diomedes Operations bridge: ${opsURL}`)) { clearTimeout(timer); resolve(); }
    });
  });

  appServer = createServer();
  await new Promise<void>(resolve => appServer!.listen(0, '127.0.0.1', resolve));
  const appPort = (appServer.address() as AddressInfo).port;
  appURL = `http://127.0.0.1:${appPort}`;
  application = await createApp({ port: appPort, clientPort: appPort, dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [],
      version: async () => { throw new Error('No external engine in this fixture.'); },
      adapter: () => { throw new Error('No external engine in this fixture.'); } }),
    reviewerAdapter: null, observation: null, secretBox: testOnlySecretBox(), ownerRoutes: false,
    modelApiTransport: async () => { throw new Error('A managed request must use the account gateway.'); },
    accounts: { backend: { client: new ControlPlaneClient(fixture.url),
      view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: fixture!.url, reason: null, signIn: 'password' }), close: async () => {} } },
  });
  const dist = path.resolve('dist');
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  appServer.on('request', application);
  await api('/account/sign-in', 'POST', { email: 'owner@juniper.test', password: FAUX_DEMO_PASSWORD, remember: false });
  await api('/workspace/switch', 'POST', { kind: 'business', organizationId: organization });
  home = await api('/home/conversation', 'POST', {});
  await api(`/workspace/organizations/${organization}/projects`, 'POST', { projectId: home.projectId });
  await api('/settings', 'PUT', { view: 'conversation', onboarding: { work: 'personal', detail: 'guided', familiarity: 'comfortable',
    resumeAt: 'done', completedAt: new Date().toISOString() }, openProjects: [home.projectId] });
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (appServer) { appServer.closeAllConnections(); await new Promise<void>(resolve => appServer!.close(() => resolve())); }
  if (bridge && bridge.exitCode === null) { const ended = once(bridge, 'exit'); bridge.kill(); await ended; }
  if (fixture) { await fixture.cloud.idle(); await fixture.close(); }
  // Keep this disposable run's records and screenshots for source acceptance.
});

async function createRoute(page: Page, name: 'primary' | 'backup') {
  await page.getByRole('button', { name: 'Add route', exact: true }).click();
  await page.getByLabel('Approved company connection').selectOption('fixture-azure');
  await page.getByLabel('Route id', { exact: true }).fill(`journey-${name}`);
  await page.getByLabel('Model', { exact: true }).fill('fixture-non-luna');
  await page.getByLabel('Label', { exact: true }).fill(`Synthetic ${name}`);
  await page.getByLabel('Binding, capability, privacy and price evidence', { exact: false }).fill(JSON.stringify(fixtureBinding(name), null, 2));
  await page.getByLabel('Region', { exact: true }).fill('US');
  await page.getByLabel('Status', { exact: true }).selectOption('qualified');
  await page.getByLabel('Processing (what customers are told)', { exact: true }).fill('Transport fixture only');
  await page.getByLabel('Qualification evidence', { exact: true }).fill('Transport fixture only');
  await page.getByRole('button', { name: 'Save route', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save route', exact: true })).toHaveCount(0);
}

test('publishes in Operations, accepts customer privacy, and preserves a non-Luna run receipt', async ({ page, context }, info) => {
  await page.goto(opsURL);
  await page.getByLabel('Staff email', { exact: true }).fill('routing@diomedes.test');
  await page.getByLabel('Password', { exact: true }).fill(FAUX_DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Faux test service', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('button', { name: 'Routing', exact: true }).click();
  await createRoute(page, 'primary'); await createRoute(page, 'backup');
  for (const tier of ['Efficient', 'Focused', 'Thorough']) {
    const group = page.getByRole('group', { name: tier, exact: true });
    await group.getByLabel(`${tier} Primary`, { exact: true }).selectOption('journey-primary');
    await group.getByRole('button', { name: 'Add backup', exact: true }).click();
    await group.getByLabel(`${tier} Backup 1`, { exact: true }).selectOption('journey-backup');
    await group.getByLabel('Allow configured backups').check();
    await expect(group.getByLabel('Maximum attempts', { exact: true })).toHaveValue('2');
  }
  await page.getByLabel('Why (shown in the audit log)', { exact: true }).fill('Synthetic Operations routing journey');
  await page.getByRole('button', { name: 'Preview affected accounts', exact: true }).click();
  await expect(page.getByText(/account scopes affected/)).toBeVisible();
  await page.getByRole('button', { name: 'Publish revision 2', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Global defaults (revision 2)', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('operations-policy.png'), fullPage: true });

  const customer = await context.newPage();
  await customer.goto(appURL);
  await customer.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await customer.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Account', exact: true }).click();
  const privacy = customer.getByRole('region', { name: 'AI routing and privacy' });
  await expect(privacy).toBeVisible();
  await privacy.getByRole('radio', { name: /^Strict/ }).check();
  await privacy.getByRole('checkbox', { name: /I accept this profile/ }).check();
  await privacy.getByRole('button', { name: 'Save routing preference', exact: true }).click();
  await expect(privacy.getByRole('status')).toContainText('Routing preference saved.');
  await customer.screenshot({ path: info.outputPath('customer-consent.png'), fullPage: true });
  await customer.getByRole('button', { name: 'Close settings', exact: true }).click();
  const completed = customer.waitForResponse(response => response.request().method() === 'POST' &&
    response.url().endsWith(`/threads/${home.threadId}/messages`));
  await customer.getByRole('textbox', { name: 'Message Nectovia', exact: true }).fill('Confirm the configured model works.');
  await customer.getByRole('textbox', { name: 'Message Nectovia', exact: true }).press('Enter');
  const response = await completed, answer = await response.json() as MessageResult;
  expect(response.ok(), JSON.stringify(answer)).toBe(true);
  await expect(customer.getByText('Operations selected this model.', { exact: true })).toBeVisible();
  await fixture!.cloud.idle();
  const stored = JSON.parse(await fs.readFile(path.join(root, 'data', 'projects', home.projectId, 'harness', 'runs', `${answer.runId}.json`), 'utf8'));
  expect(stored.steps).toEqual(expect.arrayContaining([expect.objectContaining({ output: expect.objectContaining({ managed: expect.objectContaining({
    attempts: expect.arrayContaining([expect.objectContaining({ state: 'settled', routing: expect.objectContaining({ scopeKey: `organization:${organization}`,
      routeId: 'journey-primary', model: 'fixture-non-luna', policyRevision: 2, priceVersion: 'fixture-price' }) })]),
  }) }) })]));
  await customer.reload();
  await expect(customer.getByText('Operations selected this model.', { exact: true })).toBeVisible();
  await customer.screenshot({ path: info.outputPath('customer-response.png'), fullPage: true });
});
