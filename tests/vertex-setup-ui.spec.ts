import { test, expect, type Page, type Request, type Route } from '@playwright/test';
import type { IntegrationStatus } from '../shared/types';

/**
 * The Google Vertex AI card in Settings › Engines, against host views served from
 * `page.route`. The fixture never reads ADC or contacts Google: it proves what the
 * owner sees (credential state, billed project, price card, payer and the five cost
 * figures) and the exact body the card sends. Streaming, Stop and errors from the
 * route itself are proven server-side in tests/google-vertex-*.test.ts.
 *
 * Needs the card mounted in AI setup (client/AISetup.tsx), which the routing
 * integrator adds; without the mount the first assertion fails by name.
 */
test.describe.configure({ mode: 'serial' });

const BASE = '**/api/ai/model-api/google-vertex';
const PROJECT = 'nectovia-owner-test';
const GROSS = 'google-vertex:gemini-3.8-flash:global:standard:gross-2026.1';

const detected = {
  route: 'google-vertex',
  configured: false,
  enabled: false,
  detected: { adc: true, source: 'gcloud-default', namedBy: 'the gcloud default location', quotaProject: PROJECT },
  connection: null,
  spend: null,
  accounting: null,
  next: 'Connect Google Vertex AI: name the Google Cloud project that is billed.',
};

const connected = (overrides: { stale?: boolean; matches?: boolean } = {}) => ({
  ...detected,
  configured: true,
  enabled: true,
  connection: {
    id: 'google-vertex-1',
    projectId: PROJECT,
    location: 'global',
    endpoint: `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google`,
    model: 'gemini-3.8-flash',
    processing: 'google-global',
    payer: { kind: 'google-cloud-project', projectId: PROJECT },
    credential: {
      kind: 'google-adc',
      source: 'gcloud-default',
      namedBy: 'the gcloud default location',
      fingerprint: 'feedfacefeedface',
      principal: 'owner@example.test',
      quotaProject: PROJECT,
      savedAt: '2026-09-23T08:00:00.000Z',
      matches: overrides.matches ?? true,
    },
    rateCard: {
      version: GROSS,
      source: 'fixture',
      stale: overrides.stale ?? false,
      message: overrides.stale ? 'The recorded Gemini 3.8 Flash price needs re-checking.' : null,
    },
    revision: 1,
    accountRoute: `google-vertex:google-vertex-1:${PROJECT}@r1`,
    lastVerified: { at: '2026-09-23T08:05:00.000Z', state: 'settled', providerRequestId: 'req-fixture-1' },
  },
  spend: {
    rateCard: GROSS,
    capMicroUsd: 1_000_000,
    settledMicroUsd: 1_920,
    pendingMicroUsd: 0,
    uncertainMicroUsd: 500,
    writtenOffMicroUsd: 0,
    availableMicroUsd: 997_580,
    note: 'Estimated from Google’s published prices. Not your invoice.',
    recent: [
      {
        id: 'exp-uncertain',
        state: 'uncertain',
        runId: 'run-1',
        stepId: 'step-2',
        maxMicroUsd: 500,
        settledMicroUsd: null,
        usage: null,
        providerRequestId: null,
        createdAt: '2026-09-23T08:06:00.000Z',
        uncertainReason: 'Stopped after sending.',
      },
      {
        id: 'exp-settled',
        state: 'settled',
        runId: 'run-1',
        stepId: 'step-1',
        maxMicroUsd: 4_000,
        settledMicroUsd: 1_920,
        usage: { inputTokens: 1_000, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 50 },
        providerRequestId: 'req-fixture-1',
        createdAt: '2026-09-23T08:05:00.000Z',
        uncertainReason: null,
      },
    ],
  },
  accounting: {
    payer: { kind: 'owner-google-cloud-project', projectId: PROJECT },
    grossEstimateMicroUsd: 1_920,
    unresolvedEstimateMicroUsd: 500,
    expectedPromotion: {
      status: 'expected-unconfirmed',
      percent: 50,
      appliesThrough: '2026-12-31',
      stacksWithFreeTrial: 'unknown',
      expectedMicroUsd: 960,
      source: 'fixture',
    },
    confirmedCredits: { known: false, where: `Google Cloud console, Billing, the account linked to project ${PROJECT}, Reports` },
    customerDebitMicroUsd: 0,
    invoice: { known: false, where: `Google Cloud console, Billing, the account linked to project ${PROJECT}, Documents` },
  },
  next: null,
});

test.beforeEach(async ({ page }) => {
  // Past first-run setup, so Settings is reachable; the card's own views are all served below.
  const response = await page.request.put('/api/settings', {
    headers: { 'X-Diomedes-Client': '1' },
    data: {
      // Engines, and the model-API cards on it, show on the Console at the technical detail level.
      detail: 'technical',
      onboarding: { work: 'personal', detail: 'technical', familiarity: 'comfortable', resumeAt: 'done', completedAt: new Date().toISOString() },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
});

async function openEngines(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^(Engines|Helpers on this computer)$/ }).click();
  await expect(page.getByRole('heading', { name: /^(Engines|Helpers on this computer)$/, level: 1 })).toBeVisible();
  const advanced = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Advanced: provider accounts and routing' }) });
  await expect(advanced).not.toHaveAttribute('open');
  await advanced.locator(':scope > summary').click();
  const card = page.getByRole('region', { name: 'Google Vertex AI' });
  await expect(card, 'the Vertex card is mounted in AI setup').toBeVisible();
  return card;
}

test('slow engine catalogues leave room for Settings and stop queued checks when Settings closes', async ({ page }) => {
  const engines = ['claude-code', 'codex', 'opencode', 'oh-my-pi', 'cursor', 'devin'];
  const previous = await page.request.get('/api/settings');
  expect(previous.ok()).toBe(true);
  const previousCodex = (await previous.json()).services?.codex ?? false;
  const response = await page.request.get('/api/integrations');
  expect(response.ok()).toBe(true);
  const roster = await response.json() as { integrations: IntegrationStatus[] };
  roster.integrations = roster.integrations.map<IntegrationStatus>((item) => engines.includes(item.id)
    ? { ...item, found: true, available: true, adapter: 'ready', status: 'Ready', signIn: 'signed-in' }
    : { ...item, found: false, available: false, adapter: 'none', status: 'Not installed' })
    .sort((left, right) => engines.indexOf(left.id) - engines.indexOf(right.id));
  await page.route(/\/api\/integrations(?:\?.*)?$/, (route) => route.fulfill({ json: roster }));
  await page.route(BASE, (route) => route.fulfill({ json: detected }));

  const pending = new Map<Request, { engine: string; release: () => void; reject: () => void }>();
  const cancelled = new Set<Request>();
  const handlers = new Set<Promise<void>>();
  const started = new Set<string>();
  const releaseAll: (() => void)[] = [];
  let closing = false;
  const observeStart = (request: Request) => {
    const match = new URL(request.url()).pathname.match(/^\/api\/engines\/([^/]+)\/models$/);
    if (match) started.add(match[1]);
  };
  const observeFailure = (request: Request) => {
    cancelled.add(request);
    pending.delete(request);
  };
  page.on('request', observeStart);
  page.on('requestfailed', observeFailure);
  const serveCatalogue = async (route: Route) => {
    const request = route.request();
    const engine = new URL(request.url()).pathname.split('/')[3];
    let release!: () => void;
    let fail = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    releaseAll.push(release);
    pending.set(request, { engine, release, reject: () => { fail = true; release(); } });
    if (closing) release();
    await held;
    pending.delete(request);
    try {
      if (fail) await route.abort('failed');
      else await route.fulfill({ json: {
        engine,
        models: [{ slug: 'fixture-model', name: 'Ready fixture model', description: '', defaultEffort: null, efforts: [] }],
        detail: 'Held fixture catalogue.',
      } });
    } catch (error) {
      if (!cancelled.has(request)) throw error;
    }
  };
  await page.route('**/api/engines/*/models', async (route) => {
    const handler = serveCatalogue(route);
    handlers.add(handler);
    try { await handler; } finally { handlers.delete(handler); }
  });
  try {
    const enabled = await page.request.put('/api/settings', {
      headers: { 'X-Diomedes-Client': '1' }, data: { services: { codex: true } },
    });
    expect(enabled.ok()).toBe(true);
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    // Assert scheduling before opening Engines, so RED names the request burst.
    await expect.poll(() => pending.size).toBe(2);
    expect([...pending.values()].map((item) => item.engine).sort()).toEqual(['claude-code', 'codex']);
    await page.getByRole('button', { name: /^(Engines|Helpers on this computer)$/ }).click();
    const advanced = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Advanced: provider accounts and routing' }) });
    await expect(advanced).not.toHaveAttribute('open');
    await advanced.locator(':scope > summary').click();
    // The owner view and card load while native discovery is still pending.
    await expect(page.getByRole('region', { name: 'Google Vertex AI' })).toBeVisible();
    // Either worker can advance; the second must not wait for the first.
    [...pending.values()].find((item) => item.engine === 'codex')!.release();
    await expect.poll(() => [...pending.values()].some((item) => item.engine === engines[2])).toBe(true);
    expect([...pending.values()].some((item) => item.engine === 'claude-code')).toBe(true);
    await expect(page.getByLabel('Default choice')).toContainText('Ready fixture model');
    expect(started.size).toBe(3);
    [...pending.values()].find((item) => item.engine === engines[2])!.reject();
    await expect.poll(() => [...pending.values()].some((item) => item.engine === engines[3])).toBe(true);
    expect(started.size).toBe(4);

    closing = true;
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect.poll(() => pending.size).toBe(0);
    for (const release of releaseAll) release();
    await Promise.all(handlers);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(started.size).toBe(4);
  } finally {
    closing = true;
    // Stop fetch producers while interception still owns every catalogue URL.
    await page.goto('about:blank');
    for (const release of releaseAll) release();
    await Promise.all(handlers);
    page.off('request', observeStart);
    page.off('requestfailed', observeFailure);
    await page.unrouteAll({ behavior: 'wait' });
    const restored = await page.request.put('/api/settings', {
      headers: { 'X-Diomedes-Client': '1' }, data: { services: { codex: previousCodex } },
    });
    expect(restored.ok()).toBe(true);
  }
});

test('managed usage stays preferred in Engines and Account, with commercial credentials under Advanced', async ({ page }) => {
  await page.route(BASE, (route) => route.fulfill({ json: detected }));
  await openEngines(page);
  const policy = page.getByRole('region', { name: 'Nectovia-managed AI', exact: true });
  await expect(policy).toContainText("Nectovia's current rate");
  await expect(policy).toContainText('monthly spending limit');
  await expect(policy).toContainText("needs your business's approval");
  const advanced = policy.locator('details');
  await expect(advanced).not.toHaveAttribute('open');
  await advanced.locator('summary').click();
  await expect(advanced).toContainText('arrange a supported business AI account');
  await expect(advanced).toContainText("can't fund shared Agent work");
  await expect(policy).not.toContainText(/markup|provider cost|\$0\./i);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  const accountPolicy = page.getByRole('region', { name: 'Nectovia-managed AI', exact: true }).first();
  await expect(accountPolicy).toBeVisible();
  await expect(accountPolicy).toContainText('draws from your included allowance first');
  await expect(accountPolicy.locator('details')).not.toHaveAttribute('open');
});

test('connect: sign-in found, exact body sent, payer and the five cost figures shown, no secret on screen', async ({ page }) => {
  let view: unknown = detected;
  const bodies: unknown[] = [];
  await page.route(BASE, async (route: Route) => {
    if (route.request().method() === 'PUT') {
      bodies.push(route.request().postDataJSON());
      view = connected();
    }
    await route.fulfill({ json: view });
  });
  const card = await openEngines(page);
  await expect(card.locator('[data-state="credential"]')).toContainText(`quota project ${PROJECT}`);
  await expect(card.locator('[data-state="project"]')).toContainText('Not connected');
  await expect(card.getByText('Use Google Vertex for new work')).toHaveCount(0);

  // Consent is required before anything is sent.
  await card.getByLabel('Google Cloud project id').fill(PROJECT);
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.getByRole('alert')).toContainText('no other');
  expect(bodies).toHaveLength(0);

  await card.getByLabel(/Bill this project, and no other/).check();
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.locator('[data-state="project"]')).toContainText(`${PROJECT} · gemini-3.8-flash · global`);
  expect(bodies).toEqual([{ projectId: PROJECT, location: 'global', model: 'gemini-3.8-flash', consent: true }]);

  await expect(card.locator('[data-state="price"]')).toContainText(GROSS);
  await expect(card.locator('[data-money="payer"]')).toContainText(`${PROJECT}, not Nectovia credits`);
  await expect(card.locator('[data-money="gross"]')).toContainText('$0.0019');
  await expect(card.locator('[data-money="promotion"]')).toContainText('Unconfirmed');
  await expect(card.locator('[data-money="credits"]')).toContainText('Not known here');
  await expect(card.locator('[data-money="debit"]')).toContainText('$0.00');
  await expect(card.locator('[data-money="invoice"]')).toContainText('Google’s, not Nectovia’s');
  await expect(card.getByTestId('vertex-last-verified')).toContainText('req-fixture-1');
  await expect(card.locator('li[data-state="uncertain"]')).toContainText('Cost unknown');
  await expect(card.locator('li[data-state="settled"]')).toContainText('800 of the input cached');
  await expect(card).not.toContainText('feedfacefeedface');
});

test('errors: a host refusal is shown as sent; a changed sign-in and a stale price block by name', async ({ page }) => {
  let view: unknown = detected;
  await page.route(BASE, async (route: Route) => {
    if (route.request().method() === 'PUT')
      return route.fulfill({ status: 409, json: { error: 'No Google Application Default Credentials were found on this computer.' } });
    await route.fulfill({ json: view });
  });
  const card = await openEngines(page);
  await card.getByLabel('Google Cloud project id').fill(PROJECT);
  await card.getByLabel(/Bill this project, and no other/).check();
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.getByRole('alert')).toContainText('No Google Application Default Credentials');

  view = connected({ matches: false, stale: true });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click().catch(() => undefined);
  const again = await openEngines(page);
  await expect(again.locator('[data-state="credential"]')).toHaveClass(/is-blocked/);
  await expect(again.locator('[data-state="credential"]')).toContainText('connect again');
  await expect(again.locator('[data-state="price"]')).toHaveClass(/is-blocked/);
  await expect(again.locator('[data-state="price"]')).toContainText('needs re-checking');
});

test('no sign-in: the card asks for a key, and the key is sent once and never shown', async ({ page }) => {
  const KEY = 'AQ.synthetic-browser-key-0123456789abcdef';
  const bodies: Record<string, unknown>[] = [];
  let view: unknown = { ...detected, detected: { adc: false, source: null, namedBy: null, quotaProject: null } };
  await page.route(BASE, async (route: Route) => {
    if (route.request().method() === 'PUT') {
      bodies.push(route.request().postDataJSON());
      const base = connected();
      view = { ...base, connection: { ...base.connection, credential: { kind: 'google-api-key', savedAt: '2026-09-23T08:00:00.000Z', matches: true } } };
    }
    await route.fulfill({ json: view });
  });
  const card = await openEngines(page);
  await expect(card.locator('[data-state="credential"]')).toContainText('Enter an API key');
  await card.getByLabel('Google Cloud project id').fill(PROJECT);
  await card.getByLabel(/Bill this project, and no other/).check();
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.getByRole('alert')).toContainText('API key');
  expect(bodies).toHaveLength(0);

  const field = card.getByLabel(/API key from this project/);
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(KEY);
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.locator('[data-state="credential"]')).toContainText('API key saved in protected storage');
  expect(bodies).toEqual([{ projectId: PROJECT, location: 'global', model: 'gemini-3.8-flash', consent: true, apiKey: KEY }]);
  await expect(card).not.toContainText(KEY);
});
