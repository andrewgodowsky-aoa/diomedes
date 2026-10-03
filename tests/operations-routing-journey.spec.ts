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
import type { AccountScope, ResolvedRoutingSnapshot } from '../shared/routing-policy';
import { turnRunId } from '../server/harness/model-session-run';

test.describe.configure({ mode: 'serial' });
let fixture: Awaited<ReturnType<typeof startRoutingFixture>> | undefined;
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let appServer: Server | undefined, bridge: ChildProcess | undefined;
let root = '', appURL = '', opsURL = '', organization = '', customerDataDir = '';
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

  await startCustomer('business');
});

async function startCustomer(workspace: 'business' | 'personal') {
  if (!fixture) throw new Error('The routing fixture must start before a customer host.');
  await closeCustomer();
  customerDataDir = path.join(root, `${workspace}-data`);
  appServer = createServer();
  await new Promise<void>(resolve => appServer!.listen(0, '127.0.0.1', resolve));
  const appPort = (appServer.address() as AddressInfo).port;
  appURL = `http://127.0.0.1:${appPort}`;
  application = await createApp({ port: appPort, clientPort: appPort, dataDir: customerDataDir, projectRoot: path.join(root, `${workspace}-projects`),
    engineService: new EngineService(path.join(root, `${workspace}-engines`), { discover: async () => [],
      version: async () => { throw new Error('No external engine in this fixture.'); },
      adapter: () => { throw new Error('No external engine in this fixture.'); } }),
    reviewerAdapter: null, observation: null, secretBox: testOnlySecretBox(), ownerRoutes: false,
    modelApiTransport: async () => { throw new Error('A managed request must use the account gateway.'); },
    accounts: { backend: { client: new ControlPlaneClient(fixture.url, request => fetch(request)),
      view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: fixture!.url, reason: null, signIn: 'password' }), close: async () => {} } },
  });
  const dist = path.resolve('dist');
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  appServer.on('request', application);
  await api('/account/sign-in', 'POST', { email: 'owner@juniper.test', password: FAUX_DEMO_PASSWORD, remember: false });
  await api('/workspace/switch', 'POST', workspace === 'business' ? { kind: 'business', organizationId: organization } : { kind: 'personal' });
  home = await api('/home/conversation', 'POST', {});
  if (workspace === 'business') await api(`/workspace/organizations/${organization}/projects`, 'POST', { projectId: home.projectId });
  await api('/settings', 'PUT', { view: 'conversation', onboarding: { work: 'personal', detail: 'guided', familiarity: 'comfortable',
    resumeAt: 'done', completedAt: new Date().toISOString() }, openProjects: [home.projectId] });
}

async function closeCustomer() {
  if (application) { await application.locals.close(); application = undefined; }
  if (appServer) {
    const server = appServer; appServer = undefined;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test.afterAll(async () => {
  await closeCustomer();
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
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('qualified');
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
  // Strict is on request: a new account starts on Balanced and has no Strict choice.
  await expect(privacy.getByRole('radio', { name: /^Balanced/ })).toBeChecked();
  await expect(privacy.getByRole('radio', { name: /^Strict/ })).toHaveCount(0);
  await expect(privacy).toContainText("It's available on request: write to hello@diomedes.net.");
  await privacy.getByRole('checkbox', { name: /I accept this profile/ }).check();
  await privacy.getByRole('button', { name: 'Save routing preference', exact: true }).click();
  await expect(privacy.getByRole('status')).toContainText('Routing preference saved.');
  await privacy.screenshot({ path: info.outputPath('customer-consent.png') });
  await customer.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await customer.getByRole('textbox', { name: 'Message Nectovia', exact: true }).fill('Confirm the configured model works.');
  const completed = customer.waitForResponse(response => response.request().method() === 'POST' &&
    response.url().endsWith(`/threads/${home.threadId}/messages`));
  await customer.getByRole('textbox', { name: 'Message Nectovia', exact: true }).press('Enter');
  const response = await completed, answer = await response.json() as MessageResult;
  expect(response.ok(), JSON.stringify(answer)).toBe(true);
  await expect(customer.getByText('Operations selected this model.', { exact: true })).toBeVisible();
  await fixture!.cloud.idle();
  const stored = JSON.parse(await fs.readFile(path.join(customerDataDir, 'projects', home.projectId, 'harness', 'runs', `${turnRunId(answer.runId, answer.commandId)}.json`), 'utf8'));
  expect(stored.steps).toEqual(expect.arrayContaining([expect.objectContaining({ output: expect.objectContaining({ managed: expect.objectContaining({
    attempts: expect.arrayContaining([expect.objectContaining({ state: 'settled', routing: expect.objectContaining({ scopeKey: `organization:${organization}`,
      routeId: 'journey-primary', model: 'fixture-non-luna', policyRevision: 2, priceVersion: 'fixture-price' }) })]),
  }) }) })]));
  await customer.reload();
  await expect(customer.getByText('Operations selected this model.', { exact: true })).toBeVisible();
  await customer.getByText('AI run details', { exact: true }).click();
  const details = customer.getByRole('region', { name: 'Conversation managed AI attempts' });
  await expect(details.getByText('azure-openai / fixture-non-luna', { exact: true })).toBeVisible();
  await expect(details).toContainText('Policy 2; global 2; account 0; privacy 1.');
  await expect(details).toContainText('Route journey-primary revision 1; price fixture-price.');
  await expect(details).toContainText('settled');
  await customer.screenshot({ path: info.outputPath('customer-response.png'), fullPage: true });

  // Balanced and Lowest cost share one floor, so moving between them gives up nothing and names nothing.
  await customer.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await customer.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Account', exact: true }).click();
  await privacy.getByRole('radio', { name: /^Lowest cost/ }).check();
  await expect(privacy.getByRole('note')).toHaveCount(0);
  await expect(privacy.getByRole('button', { name: 'Save routing preference', exact: true })).toBeDisabled();
  await privacy.getByRole('checkbox', { name: /I accept this profile/ }).check();
  await privacy.getByRole('button', { name: 'Save routing preference', exact: true }).click();
  await expect(privacy.getByRole('status')).toContainText('Routing preference saved.');
  await expect(privacy).toContainText('Preference revision 2.');
  await expect(privacy.getByRole('note')).toHaveCount(0);
  await privacy.screenshot({ path: info.outputPath('customer-profile-change.png') });
});

test('funds Personal access separately and keeps its override and receipt outside the Business account', async ({ page, context }, info) => {
  await fixture!.cloud.idle();
  const before = fixture!.cloud.store.snapshot();
  const businessFunding = before.funding.attempts.filter(row => row.organizationId === organization);
  expect(businessFunding.length).toBeGreaterThan(0);

  await page.goto(opsURL);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Staff email', { exact: true }).fill('admin@diomedes.test');
  await page.getByLabel('Password', { exact: true }).fill(FAUX_DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('button', { name: 'People', exact: true }).click();
  const people = page.getByRole('region', { name: 'People', exact: true });
  await page.getByLabel('Search people', { exact: true }).fill('owner@juniper.test');
  await people.getByRole('button', { name: 'Search', exact: true }).click();
  await people.getByRole('button', { name: /Maya Ortiz/ }).click();
  await page.getByRole('combobox', { name: 'Plan', exact: true }).selectOption('individual');
  await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption('internal-test');
  await page.getByLabel('Reference (invoice, order)', { exact: true }).fill('Synthetic Personal plan');
  await page.getByRole('checkbox', { name: /^It covers the person's own work only/ }).check();
  await page.getByRole('button', { name: 'Give an Individual plan', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Individual plan issued.');

  const selectIndividual = async () => {
    await page.getByRole('navigation', { name: 'Screens' }).getByRole('button', { name: 'Customers', exact: true }).click();
    await page.getByRole('combobox', { name: 'Account scope', exact: true }).selectOption('individual');
    await page.getByRole('region', { name: 'Customers', exact: true }).getByRole('button', { name: /Maya Ortiz/ }).click();
    await expect(page.getByRole('heading', { name: 'Personal access and managed usage', exact: true })).toBeVisible();
  };
  await selectIndividual();
  await expect(page.getByText(/^Managed usage: unavailable/)).toBeVisible();
  await page.getByLabel('Invoice or agreement reference', { exact: true }).fill('Synthetic Personal usage');
  const until = new Date(Date.now() + 3_600_000);
  const localUntil = new Date(until.getTime() - until.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.getByLabel('Usage agreement ends', { exact: true }).fill(localUntil);
  await page.getByLabel('Credits agreed for this calendar month', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Record agreement and credits', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Agreement recorded.');
  await expect(page.getByText(/^Managed usage: included/)).toBeVisible();

  await startCustomer('personal');
  const customer = await context.newPage();
  await customer.goto(appURL);
  await customer.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await customer.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Account', exact: true }).click();
  const privacy = customer.getByRole('region', { name: 'AI routing and privacy' });
  await expect(privacy).toContainText('Your Individual account');
  await expect(privacy.getByRole('radio', { name: /^Balanced/ })).toBeChecked();
  await privacy.getByRole('checkbox', { name: /I accept this profile/ }).check();
  await privacy.getByRole('button', { name: 'Save routing preference', exact: true }).click();
  await expect(privacy.getByRole('status')).toContainText('Routing preference saved.');
  await privacy.screenshot({ path: info.outputPath('personal-consent.png') });
  await customer.getByRole('button', { name: 'Settings', exact: true }).first().click();

  await page.reload();
  await selectIndividual();
  await expect(page.getByText('Inherits global revision 2', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Inherit global defaults (reset override)', exact: true }).uncheck();
  for (const tier of ['Efficient', 'Focused', 'Thorough']) {
    const group = page.getByRole('group', { name: tier, exact: true });
    await group.getByLabel(`${tier} Primary`, { exact: true }).selectOption('journey-backup');
    await group.getByLabel(`${tier} Backup 1`, { exact: true }).selectOption('journey-primary');
  }
  await page.getByLabel('Why (shown in the audit log)', { exact: true }).fill('Synthetic Individual-only override');
  await page.getByRole('button', { name: 'Preview affected accounts', exact: true }).click();
  await expect(page.getByText(/1 account scopes affected/)).toBeVisible();
  await page.getByRole('button', { name: 'Publish revision 1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Individual routing (revision 1)', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('operations-individual-policy.png'), fullPage: true });
  const view = await api<{ scope: AccountScope; routing: { resolved: ResolvedRoutingSnapshot } }>('/account/routing');
  expect(view.scope.kind).toBe('individual');
  expect(view.scope.id).not.toBe(organization);
  expect(view.routing.resolved).toMatchObject({ inherited: false, scopeRevision: 1, globalRevision: 2, preferenceRevision: 1 });

  await customer.getByRole('textbox', { name: 'Message Nectovia', exact: true }).fill('Confirm my Personal route works.');
  const completed = customer.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/threads/${home.threadId}/messages`));
  await customer.getByRole('textbox', { name: 'Message Nectovia', exact: true }).press('Enter');
  const response = await completed, answer = await response.json() as MessageResult;
  expect(response.ok(), JSON.stringify(answer)).toBe(true);
  await expect(customer.getByText('Operations selected this model.', { exact: true })).toBeVisible();
  await fixture!.cloud.idle();
  const stored = JSON.parse(await fs.readFile(path.join(customerDataDir, 'projects', home.projectId, 'harness', 'runs', `${turnRunId(answer.runId, answer.commandId)}.json`), 'utf8'));
  expect(stored.steps).toEqual(expect.arrayContaining([expect.objectContaining({ output: expect.objectContaining({ managed: expect.objectContaining({
    attempts: expect.arrayContaining([expect.objectContaining({ state: 'settled', routing: expect.objectContaining({
      scopeKey: `individual:${view.scope.id}`, routeId: 'journey-backup', policyRevision: 1, scopeRevision: 1, globalRevision: 2, preferenceRevision: 1,
    }) })]),
  }) }) })]));
  const after = fixture!.cloud.store.snapshot();
  const individual = after.commercial.individuals.find(row => row.id === view.scope.id)!;
  expect(individual).toBeDefined();
  expect(after.commercial.personalAdmissions).toEqual(expect.arrayContaining([expect.objectContaining({
    billingAccountId: individual.id, personId: individual.personId, tenantId: individual.personId, decision: 'admitted',
  })]));
  expect(after.funding.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ organizationId: individual.id, tenantId: individual.personId })]));
  expect(after.accounts.organizations).toEqual(before.accounts.organizations);
  expect(after.funding.attempts.filter(row => row.organizationId === organization)).toEqual(businessFunding);

  await customer.reload();
  await customer.getByText('AI run details', { exact: true }).click();
  const details = customer.getByRole('region', { name: 'Conversation managed AI attempts' });
  await expect(details).toContainText('Policy 1; global 2; account 1; privacy 1.');
  await expect(details).toContainText('Route journey-backup revision 1; price fixture-price.');
  await expect(details).toContainText('settled');
  await customer.screenshot({ path: info.outputPath('personal-response.png'), fullPage: true });

  await page.getByRole('checkbox', { name: 'Inherit global defaults (reset override)', exact: true }).check();
  await page.getByLabel('Why (shown in the audit log)', { exact: true }).fill('Return Personal to the global defaults');
  await page.getByRole('button', { name: 'Preview affected accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Publish revision 2', exact: true }).click();
  await expect(page.getByText('Inherits global revision 2', { exact: true })).toBeVisible();
  const reset = await api<{ routing: { resolved: ResolvedRoutingSnapshot } }>('/account/routing');
  expect(reset.routing.resolved).toMatchObject({ inherited: true, scopeRevision: 2, globalRevision: 2, preferenceRevision: 1 });
  await customer.reload();
  await customer.getByText('AI run details', { exact: true }).click();
  await expect(customer.getByRole('region', { name: 'Conversation managed AI attempts' })).toContainText('Policy 1; global 2; account 1; privacy 1.');
});
