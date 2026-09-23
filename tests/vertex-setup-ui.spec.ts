import { test, expect, type Page, type Route } from '@playwright/test';

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

async function openEngines(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Engines', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Engines', exact: true, level: 1 })).toBeVisible();
  const card = page.getByRole('region', { name: 'Google Vertex AI' });
  await expect(card, 'the Vertex card is mounted in AI setup').toBeVisible();
  return card;
}

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

test('no sign-in: Connect stays disabled and the card names the command to run', async ({ page }) => {
  await page.route(BASE, (route: Route) =>
    route.fulfill({ json: { ...detected, detected: { adc: false, source: null, namedBy: null, quotaProject: null } } }),
  );
  const card = await openEngines(page);
  await expect(card.locator('[data-state="credential"]')).toContainText('gcloud auth application-default login');
  await expect(card.getByRole('button', { name: 'Connect' })).toBeDisabled();
});
