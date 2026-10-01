import { test, expect, type Locator, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { ControlPlaneClient } from '../server/accounts/client';
import { testOnlySecretBox } from '../server/connection-secrets';
import { createFauxCloud, FAUX_BACKEND_LABEL, FAUX_CREDIT_PRICE_CENTS_PER_100, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import { RATE_CARD_V1, creditAmount, micro, periodIdFor, type AttemptSettlement } from '../shared/managed-usage';
import type { WorkspaceView } from '../shared/workspaces';
import type { Project } from '../shared/types';
import {
  USAGE_DANGER_PERCENT,
  USAGE_EXHAUSTED_PERCENT,
  USAGE_WARNING_PERCENT,
} from '../client/console/nectovia-usage-model';
import { reopenLastProject } from './fixtures/landing';

/**
 * Browser proof of the Usage screen in Settings (DIO-161): the owner of a business finds it, a member does not; the
 * bar changes colour at the shared warning points; and buying 1,000 credits over the faux account service, paying on its
 * checkout page, ends with the paid line and the refreshed balances.
 *
 * The account service is the real control-plane handler over the faux store, in this process, as the desktop's own tests
 * run it. Every person, business and figure is one of the faux seed's invented demo ones, and nothing is charged: the
 * faux Stripe makes the session and the faux checkout page pays it.
 */
test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
/** The grant the bar is measured against. Every figure below is a share of it. */
const GRANTED_CREDITS = 1000;
const BOUGHT_CREDITS = 1000;

let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let cloud: FauxCloud;
let baseURL = '';
let fixtureRoot = '';
let juniper = '';

async function api<T = unknown>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`Usage fixture ${route} failed (${response.status}): ${await response.text()}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function signInAs(account: { email: string }) {
  await api('/account/sign-in', 'POST', { email: account.email, password: FAUX_DEMO_PASSWORD, remember: false });
  await api('/workspace/switch', 'POST', { kind: 'business', organizationId: juniper });
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'settings-usage-'));
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000, billing: { creditPriceCentsPer100: FAUX_CREDIT_PRICE_CENTS_PER_100 } });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
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
  await signInAs(DEMO_ACCOUNTS.owner);
  const project = await api<Project>('/projects', 'POST', { name: 'Bakery records' });
  await api('/settings', 'PUT', {
    detail: 'technical',
    onboarding: { work: 'personal', detail: 'technical', familiarity: 'comfortable', resumeAt: 'done', completedAt: new Date().toISOString() },
    openProjects: [project.id],
  });
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  }
});

/**
 * This month's included credits as a grant of GRANTED_CREDITS, with `percent` of it settled and nothing held. The one write
 * the screen's own flows can't make on demand, so it is made in the faux store the account service reads, as the real
 * settlements would stand. Credits bought are left alone.
 */
async function setUsedPercent(percent: number) {
  const at = new Date().toISOString();
  const periodId = periodIdFor(at);
  const spent = micro(creditAmount((GRANTED_CREDITS * percent) / 100));
  await cloud.store.run(async (draft) => {
    const tenantId = draft.accounts.organizations.find((row) => row.record.id === juniper)!.record.tenantId;
    let period = draft.funding.periods.find((row) => row.organizationId === juniper && row.periodId === periodId);
    if (!period) {
      const start = new Date(`${periodId}-01T00:00:00.000Z`);
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      period = {
        tenantId, organizationId: juniper, periodId, planId: 'business', rateCardVersion: RATE_CARD_V1.version,
        grantedMicroUsd: micro(0), startsAt: start.toISOString(), endsAt: end.toISOString(), sourceGrantId: 'settings-usage-spec', allocatedAt: at,
      };
      draft.funding.periods.push(period);
    }
    period.grantedMicroUsd = creditAmount(GRANTED_CREDITS);
    draft.funding.settlements = draft.funding.settlements.filter((row) => !(row.organizationId === juniper && row.periodId === periodId));
    draft.funding.attempts = draft.funding.attempts.filter((row) => !(row.organizationId === juniper && row.periodId === periodId));
    if (percent > 0)
      draft.funding.settlements.push({
        reservationId: 'settings-usage-spec', organizationId: juniper, periodId, providerCostMicroUsd: spent, allowanceDebitMicroUsd: spent,
        rateCardVersion: RATE_CARD_V1.version, eligibility: 'included', settledAt: at, reconciledFrom: 'response', tenantId,
        receiptRef: 'receipt_settings_usage_spec', monthlyDebitMicroUsd: spent, topUpDebitMicroUsd: micro(0), usage: {},
      } as unknown as AttemptSettlement);
  });
}

const settingsNav = (page: Page) => page.getByRole('navigation', { name: 'Settings' });
const usageEntry = (page: Page) => settingsNav(page).getByRole('button', { name: 'Usage', exact: true });

async function openSettings(page: Page) {
  // Stand-in for the system browser: the screen asks to open the payment page, and the test reads where.
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = opened;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await page.goto(`${baseURL}/`);
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settingsNav(page)).toBeVisible();
}

async function openUsage(page: Page) {
  await openSettings(page);
  await usageEntry(page).click();
  await expect(page.getByRole('heading', { name: 'Agent usage', level: 2 })).toBeVisible();
}

const meter = (page: Page) => page.getByRole('meter', { name: 'Monthly credits used' });
const bought = (page: Page) => page.getByRole('region', { name: 'Credits you bought' });
const fact = (region: Locator, term: string) =>
  region.locator('.ws-facts > div').filter({ has: region.page().locator('dt', { hasText: new RegExp(`^${term}$`) }) }).locator('dd');
const number = (text: string | null) => Number((text ?? '').replace(/[^0-9.]/g, ''));
const credits = (value: number) => `${value.toLocaleString('en-US')} ${value === 1 ? 'credit' : 'credits'}`;

test('the owner of the business finds Usage in Settings', async ({ page }) => {
  await setUsedPercent(10);
  await openSettings(page);
  await expect(usageEntry(page)).toBeVisible();
  await usageEntry(page).click();
  await expect(page.getByRole('heading', { name: 'Agent usage', level: 2 })).toBeVisible();
  await expect(meter(page)).toBeVisible();
  await expect(page.getByText(`${GRANTED_CREDITS / 10} of ${GRANTED_CREDITS.toLocaleString('en-US')} credits used this month`)).toBeVisible();
  await expect(bought(page)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Buy credits' })).toBeVisible();
});

// The bar's colour comes from the warning points the usage panel's alert reads too, so the cases are those points and the
// figure just under the first one: 74, 75, 90 and 100 percent of the month's grant.
const TONES = [
  { percent: USAGE_WARNING_PERCENT - 1, tone: 'ok', fill: /^((?!signal|fault).)*$/, note: null },
  { percent: USAGE_WARNING_PERCENT, tone: 'warning', fill: /signal/, note: 'Your monthly credits are running low.' },
  { percent: USAGE_DANGER_PERCENT, tone: 'danger', fill: /fault/, note: 'Your monthly credits are almost gone.' },
  { percent: USAGE_EXHAUSTED_PERCENT, tone: 'danger', fill: /fault/, note: 'Your monthly credits are used up.' },
] as const;

for (const { percent, tone, fill, note } of TONES) {
  test(`the bar reads ${tone} at ${percent} percent used`, async ({ page }) => {
    expect([USAGE_WARNING_PERCENT - 1, USAGE_WARNING_PERCENT, USAGE_DANGER_PERCENT, USAGE_EXHAUSTED_PERCENT]).toEqual([74, 75, 90, 100]);
    await setUsedPercent(percent);
    await openUsage(page);
    await expect(meter(page)).toHaveAttribute('data-tone', tone);
    await expect(meter(page).locator('.uc-fill')).toHaveClass(fill);
    await expect(meter(page).locator('.uc-fill')).toHaveAttribute('style', new RegExp(`width:\\s*${percent}%`));
    await expect(page.getByText(`${(GRANTED_CREDITS * percent) / 100} of ${GRANTED_CREDITS.toLocaleString('en-US')} credits used this month`)).toBeVisible();
    const warning = page.locator('.uc-note');
    if (note) await expect(warning).toHaveText(note);
    else await expect(warning).toHaveCount(0);
  });
}

test('buying 1,000 credits, and paying on the faux checkout page, shows the paid line and the new balances', async ({ page }) => {
  await setUsedPercent(10);
  await openUsage(page);
  const balances = bought(page);
  await expect(balances).toBeVisible();
  const before = { bought: number(await fact(balances, 'Bought').textContent()), available: number(await fact(balances, 'Available').textContent()) };

  const cents = BOUGHT_CREDITS / 100 * FAUX_CREDIT_PRICE_CENTS_PER_100;
  const dollars = (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const buy = page.getByRole('region', { name: 'Buy credits' });
  await expect(buy.getByLabel('Credits to buy')).toHaveValue(String(BOUGHT_CREDITS));
  await expect(buy.getByText(`${credits(BOUGHT_CREDITS)} for ${dollars} at the current usage rate`)).toBeVisible();
  await buy.getByRole('button', { name: 'Buy', exact: true }).click();
  await expect(buy.getByRole('status')).toHaveText(`Waiting for your payment for ${credits(BOUGHT_CREDITS)}.`);

  // The screen asked the system browser for the payment page, and it is the faux service's own.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.length)).toBe(1);
  const [checkout] = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  expect(checkout).toMatch(/^http:\/\/faux\.local\/faux\/checkout\/cs_faux_[a-z0-9]{24}$/);
  await expect(buy.getByRole('link', { name: 'Open the payment page' })).toHaveAttribute('href', checkout);

  // The faux checkout page says what is being bought, and its one button pays: the form posts to its own /complete.
  const pageText = await (await cloud.handle(new Request(checkout))).text();
  expect(pageText).toContain(`${BOUGHT_CREDITS.toLocaleString('en-US')} Nectovia credits for ${dollars}`);
  expect(pageText).toContain(`action="/faux/checkout/${checkout.split('/').pop()}/complete"`);
  const paid = await cloud.handle(new Request(`${checkout}/complete`, { method: 'POST' }));
  expect(paid.status).toBe(303);

  // The screen follows the purchase (every three seconds at first) to paid, and reads the balances again.
  await expect(buy.getByRole('status')).toHaveText(`Paid ${dollars}. ${credits(BOUGHT_CREDITS)} were added.`, { timeout: 20_000 });
  await expect(fact(balances, 'Bought')).toHaveText(credits(before.bought + BOUGHT_CREDITS), { timeout: 20_000 });
  await expect(fact(balances, 'Available')).toHaveText(credits(before.available + BOUGHT_CREDITS));
  await expect(buy.getByRole('button', { name: 'Buy more', exact: true })).toBeVisible();
  // Bought credits are not the month's grant: the bar is where it was.
  await expect(meter(page)).toHaveAttribute('data-tone', 'ok');
});

test('a member of the business has no Usage in Settings, and the account service would refuse them anyway', async ({ page }) => {
  await api('/account/sign-out', 'POST', {});
  await signInAs(DEMO_ACCOUNTS.employee);
  const workspace = await api<WorkspaceView>('/workspace');
  const here = workspace.organizations.find((row) => row.organization.id === juniper)!;
  expect(here.membership.role).toBe('member');

  const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspace' && response.request().method() === 'GET');
  await openSettings(page);
  await loaded;
  await expect(settingsNav(page).getByRole('button', { name: 'Account', exact: true })).toBeVisible();
  await expect(usageEntry(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Agent usage', level: 2 })).toHaveCount(0);

  const quote = await fetch(`${baseURL}/api/workspace/organizations/${juniper}/allowance/credit-purchases/quote?credits=100`, { headers: HEADERS });
  expect(quote.ok).toBe(false);
});