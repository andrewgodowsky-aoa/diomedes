import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project, Settings } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';
import { ControlPlaneClient } from '../server/accounts/client';
import type { AccountBackend } from '../server/accounts/backend';
import type { AccountStateView } from '../shared/accounts';
import { createFauxCloud, FAUX_BACKEND_LABEL } from '../services/control-plane/src/faux/cloud';
import { seedDemo, DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD } from '../services/control-plane/src/faux/seed';
import { creditAmount, micro } from '../shared/managed-usage';
import { AccountRoutingSession } from '../server/accounts/routing-session';
import { OUT_OF_CREDITS_PERSONAL, PAY_AS_YOU_GO_PLAN_ONLY_REASON } from '../shared/access';
import { responsesAnswer } from './fixtures/model-api-streams';
import { PROFILE_FLOORS, ROUTING_CONSENT_VERSION, type ModelBinding, type ProviderConnection } from '../shared/routing-policy';

/**
 * The Console's two views (Andrew, 2026-09-23; renamed 2026-10-03). Nectovia is the
 * prompt box and the threads, stored as `conversation`; Work replaced Architect and
 * keeps its stored value, `architect`, so a saved choice opens Work. A view changes
 * what is shown, never what Nectovia can do, so each hidden thing is checked for a way
 * back: the top switch, Ctrl K and Settings all switch, and a Need waiting outside the
 * open thread is still reachable without the board beside the thread.
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

const views = (page: Page) => page.getByRole('navigation', { name: 'View', exact: true });

test('Nectovia shows the prompt box and the threads, and nothing else', async ({ page }) => {
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

test('the top switch moves to Work and back, and the choice is kept', async ({ page }) => {
  await enter(page);
  await expect(views(page).getByRole('button')).toHaveText(['Nectovia', 'Work']);
  await views(page).getByRole('button', { name: 'Work', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-view', 'architect');
  await expect(views(page).getByRole('button', { name: 'Work', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await rail(page).getByRole('button', { name: /Talk it through/ }).click();
  // The board beside the thread (round 2 board BD1), in the aside's place.
  await expect(ledger(page)).toBeVisible();
  await expect(ledger(page).getByRole('heading', { name: 'Board', level: 2 })).toBeVisible();
  for (const name of [/^Needs your input/, /^Working/, /^Up next/, /^Finished today/])
    await expect(ledger(page).getByRole('heading', { name, level: 3 })).toBeVisible();
  await expect(rail(page).locator('.foot').getByRole('button', { name: /^Routines\b/ })).toBeVisible();
  await expect(rail(page).locator('.foot').getByRole('button', { name: /^Board\b/ })).toBeVisible();
  expect((await api<Settings>('/settings')).view).toBe('architect');

  // A reload is where a surface used to be reset; a view is not.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-view', 'architect');

  await views(page).getByRole('button', { name: 'Nectovia', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-view', 'conversation');
  await expect(ledger(page)).toHaveCount(0);
  expect((await api<Settings>('/settings')).view).toBe('conversation');
});

test('Ctrl K offers the other view as a switch', async ({ page }) => {
  await enter(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Find and act' });
  await expect(palette).toBeVisible();
  await palette.getByRole('textbox').fill('work view');
  await palette.getByText('Work view', { exact: true }).click();
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
  await expect(page.getByRole('radio', { name: /^Nectovia Ask/ })).toBeChecked();
  // The radio is controlled: it shows the stored view, so it turns once the save lands.
  await page.getByRole('radio', { name: /^Work Your threads/ }).click();
  await expect(page.getByRole('radio', { name: /^Work Your threads/ })).toBeChecked();
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

test('buying unlocks Nectovia and final-credit settlement relocks the tab and ask row without a restart (DIO-245)', async ({ page }) => {
  let providerCalls = 0;
  const connection: ProviderConnection = { id: 'fixture-azure', revision: 1, label: 'Synthetic Azure', provider: 'azure-openai',
    secretRef: 'AZURE_OPENAI_API_KEY', payer: 'company', account: 'fixture', enabled: true,
    resource: 'fixture-resource', apiVersion: 'v1', deployments: ['primary'] };
  const cloud = await createFauxCloud({ file: null, passwordIterations: 1000, managed: {
    bindings: { MANAGED_CONNECTIONS: JSON.stringify([connection]), AZURE_OPENAI_API_KEY: 'synthetic-fixture-key' }, transport: async () => {
      providerCalls++;
      // Dispatch rechecks available funds after reserving this call. Leave one unit for that
      // check, then consume it as concurrent work while the scripted response is in flight.
      const pending = cloud.store.snapshot().funding.attempts.find((attempt) => attempt.route === 'primary')!;
      const ref = { tenantId: pending.tenantId, organizationId: pending.organizationId, attemptId: 'concurrent-unit' };
      await cloud.funding.openJob({ ...ref, rootJobId: 'concurrent-work', runRef: 'run_concurrent', parentRunRef: null, tier: 'efficient', capMicroUsd: null });
      await cloud.funding.reserve({ ...ref, rootJobId: 'concurrent-work', parentAttemptId: null, kind: 'generation', route: 'concurrent',
        requestDigest: 'concurrent-unit', rateSnapshot: { version: 'fixture-unit', inputMicroUsdPerMillion: 1_000_000,
          outputMicroUsdPerMillion: 1_000_000, cacheReadMicroUsdPerMillion: 1_000_000, cacheWriteMicroUsdPerMillion: 1_000_000 },
        maxMicroUsd: micro(1), usageClass: 'metered-work', boughtOnly: true });
      await cloud.funding.markDispatched(ref);
      await cloud.funding.settle({ ...ref, receiptRef: 'concurrent-response', reconciledFrom: 'response',
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } });
      return responsesAnswer({ id: 'resp_final_credit', object: 'response', model: 'fixture-final-credit', status: 'completed',
        output: [{ type: 'message', id: 'msg_final_credit', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'The final credit was used.', annotations: [] }] }],
        usage: { input_tokens: 90, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 98 }, incomplete_details: null, error: null }, 200, {});
  } } });
  await seedDemo(cloud);
  const client = new ControlPlaneClient('http://faux.local', (request) => cloud.handle(request));
  const staff = (await client.signIn({ email: DEMO_ACCOUNTS.staffRouting.email, password: FAUX_DEMO_PASSWORD, remember: false })).accessToken;
  const at = new Date().toISOString(), until = new Date(Date.now() + 3_600_000).toISOString();
  const binding: ModelBinding = { connectionId: connection.id, connectionRevision: 1, protocol: 'responses', deployment: 'primary',
    modelVersion: 'fixture-final-credit', upstreamEndpoint: null, capabilities: { contextTokens: 100_000, outputTokens: 4096, tools: true, images: false, reasoning: false },
    qualification: { id: 'fixture', evidence: 'Synthetic only', validUntil: until, tiers: ['efficient', 'focused', 'thorough'], qualityFloor: 1 },
    access: { state: 'ready', evidence: 'Synthetic only', validUntil: until, availableRequests: 10 },
    privacy: { connectionRevision: 1, modelVersion: 'fixture-final-credit', protocol: 'responses', evidence: 'Synthetic only', validUntil: until,
      ingressCountries: ['US'], decryptionCountries: ['US'], processingCountries: ['US'], retentionPolicy: 'fixture-zdr', zeroRetention: true, training: false,
      contentLogging: false, caching: 'off', transientCacheEvidence: null, features: ['text', 'tools'], allowedRetentionModes: [], effectiveRetentionMode: null, regionalEntitlement: false },
    health: { state: 'healthy', observedAt: at, validUntil: until, cooldownUntil: null, reason: 'Synthetic only' },
    price: { version: 'fixture-zero-provider-cost', observedAt: at, validUntil: until, evidence: 'Synthetic only', inputMicroUsdPerMillion: 0,
      outputMicroUsdPerMillion: 0, reasoningMicroUsdPerMillion: 0, cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0, requestFeeMicroUsd: 0, longContext: [] } };
  await cloud.commercial.saveRoute(staff, { id: 'primary', provider: 'azure-openai', model: 'fixture-final-credit', label: 'Fixture', region: 'US',
    processing: 'Synthetic only', status: 'qualified', evidence: 'Synthetic only', binding }, cloud.connectionSettings);
  const tier = { primary: 'primary', backups: [], fallbackEnabled: false, maxAttempts: 1, cost: { sameOrLower: true, qualityFloor: 1, maxAttemptMicroUsd: null } };
  const published = await cloud.handle(new Request(`${client.base}/ops/routing/scopes/publish`, { method: 'POST',
    headers: { authorization: `Bearer ${staff}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: { kind: 'global' }, baseRevision: 1, baseGlobalRevision: 1,
      routing: { efficient: tier, focused: tier, thorough: tier }, note: 'Synthetic browser regression only.' }) }));
  expect(published.ok, await published.clone().text()).toBe(true);
  // The bound is below a million tokens, so both the hold and reported usage round to one unit
  // plus this fee: all but one ledger unit of the purchase. Concurrent work consumes that unit.
  const charge = { inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1, cacheReadMicroUsdPerMillion: 1,
    cacheWriteMicroUsdPerMillion: 1, requestFeeMicroUsd: creditAmount(100) - 2 };
  // This isolated table prices only the zero-cost scripted route above. Publishing it through
  // Operations would also price the unrelated seeded evaluation provider, which this test never calls.
  await cloud.store.commercial.transaction((tx) => tx.savePriceTable({ v: 1, version: 2, ceilingMicroUsdPerCredit: 100_000,
    tiers: { efficient: charge, focused: charge, thorough: charge }, note: 'Synthetic final-credit response.', publishedAt: at, publishedBy: 'fixture' }));
  const backend: AccountBackend = { client, close: async () => {},
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: client.base, reason: null, signIn: 'password' }) };
  const fixture = await fs.mkdtemp(path.join(path.resolve('test-results'), 'payg-relock-'));
  const host = createServer();
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  const port = (host.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const app = await createApp({ port, clientPort: port, dataDir: path.join(fixture, 'data'), projectRoot: path.join(fixture, 'projects'),
    reviewerAdapter: null, accounts: { backend, env: {} } });
  app.use(express.static(path.resolve('dist')));
  app.get('/{*path}', (_request, response) => response.sendFile(path.resolve('dist/index.html')));
  host.on('request', app);
  const call = async <T,>(route: string, method = 'GET', data?: unknown): Promise<T> => {
    const response = await fetch(`${origin}/api${route}`, { method, headers: HEADERS, body: data === undefined ? undefined : JSON.stringify(data) });
    expect(response.ok, `${route}: ${await response.clone().text()}`).toBe(true);
    return response.json() as Promise<T>;
  };
  try {
    await call('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.free.email, password: FAUX_DEMO_PASSWORD, remember: false });
    const ownProject = await call<Project>('/projects/sample', 'POST', {});
    await call(`/projects/${ownProject.id}/threads`, 'POST', { name: 'Final credit' });
    await call('/settings', 'PUT', { view: 'conversation', detail: 'standard', openProjects: [ownProject.id],
      onboarding: { work: 'personal', detail: 'standard', familiarity: 'some', resumeAt: 'done', completedAt: new Date().toISOString() } });
    // The payment page is the real faux Checkout, kept in this process even when the UI opens a tab.
    await page.context().route('http://faux.local/**', async (route) => {
      const request = route.request();
      const response = await cloud.handle(new Request(request.url(), { method: request.method(), headers: request.headers(), body: request.postData() }));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.goto(origin);
    await reopenLastProject(page);
    const nectovia = views(page).getByRole('button', { name: 'Nectovia', exact: true });
    await expect(nectovia).toHaveClass(/locked/);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Usage', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Credits to buy' }).fill('100');
    const started = page.waitForResponse((response) => response.url().endsWith('/workspace/personal/allowance/credit-purchases') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Buy', exact: true }).click();
    const purchase = await (await started).json();
    await cloud.completeCheckout(new URL(purchase.checkoutUrl).pathname.split('/').pop()!);
    await expect(page.getByRole('status').filter({ hasText: /100 credits were added/ })).toBeVisible({ timeout: 15_000 });
    await reopenLastProject(page);
    await expect(nectovia).not.toHaveClass(/locked/);
    await nectovia.click();
    await expect(page.locator('html')).toHaveAttribute('data-view', 'conversation');
    const engines = page.getByRole('button', { name: /^Engine:/ }).first();
    await engines.click();
    await expect(page.getByRole('menu', { name: 'Engines', exact: true }).getByRole('menuitemradio', { name: /Nectovia/ })).toBeEnabled();
    await page.keyboard.press('Escape');
    await views(page).getByRole('button', { name: 'Work', exact: true }).click();
    await expect(rail(page).getByRole('button', { name: /^Routines\b/ })).toContainText('Paid plans');
    const account = app.locals.accounts;
    const bearer = await account.token();
    const personId = account.personId()!;
    const scope = { kind: 'individual' as const, id: (await client.individualAccount(bearer)).id };
    // An already accepted profile is fixture data; buying must not unlock its editing controls.
    await cloud.store.commercial.transaction((tx) => tx.saveRoutingPreference({ v: 1, revision: 1, scope, profile: 'balanced',
      restrictions: PROFILE_FLOORS.balanced, consentVersion: ROUTING_CONSENT_VERSION, exceptions: [], acceptedBy: personId, acceptedAt: at }));
    const routing = new AccountRoutingSession(account, { projectOwner: () => null, active: () => ({ kind: 'personal' }) });
    await expect(routing.admit({ phase: 'admit', surface: 'team', projectId: null, rootJobId: 'plan-only', routeKind: 'managed' }))
      .rejects.toMatchObject({ message: PAY_AS_YOU_GO_PLAN_ONLY_REASON });
    expect(routing.includes(scope, 'maintained-profiles')).toBe(false);
    await nectovia.click();
    await expect(page.locator('html')).toHaveAttribute('data-view', 'conversation');
    const startedAt = await page.evaluate(() => performance.timeOrigin);
    const binding = await call<{ projectId: string; threadId: string }>('/home/conversation', 'POST', {});
    await call(`/projects/${binding.projectId}/threads/${binding.threadId}/messages`, 'POST', {
      commandId: 'spend-final-credit', text: 'Use the last bought credits.', mode: 'auto', sources: [], consent: true });
    expect(providerCalls).toBe(1);
    expect((await client.personalPurchasedBalance(bearer)).availableMicroUsd).toBe(0);
    const attempts = cloud.store.snapshot().funding.attempts.filter((attempt) => attempt.tenantId === personId && attempt.route === 'primary');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe('settled');
    await expect(nectovia).toHaveClass(/locked/, { timeout: 5_000 });
    await expect(page.locator('html')).toHaveAttribute('data-view', 'architect');
    await engines.click();
    await expect(page.getByRole('menu', { name: 'Engines', exact: true }).getByRole('menuitemradio', { name: /Nectovia/ })).toBeDisabled();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(startedAt);
    expect((await call<AccountStateView>('/account')).plan).toMatchObject({ agent: 'free' });
    await expect(routing.admit({ phase: 'admit', surface: 'conversation', projectId: null, rootJobId: 'after-exhaustion', routeKind: 'managed' }))
      .rejects.toMatchObject({ message: OUT_OF_CREDITS_PERSONAL });
  } finally {
    await page.close();
    await app.locals.close();
    host.closeAllConnections();
    await new Promise<void>((resolve, reject) => host.close((error) => error ? reject(error) : resolve()));
    await cloud.idle();
  }
});
