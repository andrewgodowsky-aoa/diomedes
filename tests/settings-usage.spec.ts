import { test, expect, type Locator, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { ControlPlaneClient } from '../server/accounts/client';
import { testOnlySecretBox } from '../server/connection-secrets';
import { createFauxCloud, FAUX_BACKEND_LABEL, FAUX_CREDIT_RATE_PLAN, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed';
import { RATE_CARD_V1, creditAmount, micro, periodIdFor, type AttemptSettlement } from '../shared/managed-usage';
import type { WorkspaceView } from '../shared/workspaces';
import type { Project } from '../shared/types';
import type { SubscriptionWorkersView } from '../shared/subscription-workers';
import { SUBSCRIPTION_WORKERS_UNAVAILABLE } from '../server/subscription-workers';
import {
  USAGE_DANGER_PERCENT,
  USAGE_EXHAUSTED_PERCENT,
  USAGE_WARNING_PERCENT,
} from '../client/console/nectovia-usage-model';
import { reopenLastProject } from './fixtures/landing';

/**
 * Browser proof of the Usage screen in Settings (DIO-161): the owner of a business finds it, and a member finds only their own use; the
 * bar changes colour at the shared warning points; and buying about 1,000 credits over the faux account service, paying on its
 * checkout page, ends with the paid line and the refreshed balances.
 *
 * The account service is the real control-plane handler over the faux store, in this process, as the desktop's own tests
 * run it. Every person, business and figure is one of the faux seed's invented demo ones, and nothing is charged: the
 * faux Stripe makes the session and the faux checkout page pays it.
 *
 * The last three tests are Settings' "Your coding tools" (subscription-aware orchestration S3), which this app offers with
 * no coding tool behind it: saved through the real preference routes, asked again under an older consent, and absent
 * when the build doesn't offer it.
 */
test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
/** The grant the bar is measured against. Every figure below is a share of it. */
const GRANTED_CREDITS = 1000;
/** The business holds a plan in the faux seed, so it buys at the faux plan rate: whole steps, starting at about 1,000 credits. */
const [PLAN_STEP_CENTS, PLAN_STEP_CREDITS] = FAUX_CREDIT_RATE_PLAN.split(':').map(Number);
const BOUGHT_CREDITS = Math.floor(1000 / PLAN_STEP_CREDITS) * PLAN_STEP_CREDITS;

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
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000, billing: { creditRatePlan: FAUX_CREDIT_RATE_PLAN } });
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
    // S3's "Your coding tools" section, offered by this build with no coding tool behind it: the
    // section saves the preference through its real routes and nothing is ever handed off here.
    externalWorkers: {
      admit: async () => {
        throw new Error('No coding tool runs in this spec.');
      },
      send: async () => {
        throw new Error('No coding tool runs in this spec.');
      },
    },
    subscriptionWorkers: true,
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

async function openConsole(page: Page) {
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
}

async function openSettings(page: Page) {
  await openConsole(page);
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
    await expect(page.getByText(`${((GRANTED_CREDITS * percent) / 100).toLocaleString('en-US')} of ${GRANTED_CREDITS.toLocaleString('en-US')} credits used this month`)).toBeVisible();
    const warning = page.locator('.uc-note');
    if (note) await expect(warning).toHaveText(note);
    else await expect(warning).toHaveCount(0);
  });
}

test('buying about 1,000 credits in the plan step, and paying on the faux checkout page, shows the paid line and the new balances', async ({ page }) => {
  await setUsedPercent(10);
  await openUsage(page);
  const balances = bought(page);
  await expect(balances).toBeVisible();
  const before = { bought: number(await fact(balances, 'Bought').textContent()), available: number(await fact(balances, 'Available').textContent()) };

  const cents = BOUGHT_CREDITS / PLAN_STEP_CREDITS * PLAN_STEP_CENTS;
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

/** A member's own month. The limit and the settlement are the member's own; nothing here is the business's. */
const MEMBER_ATTEMPT = 'settings-usage-member';
const MEMBER_LIMIT_CREDITS = 300;
const MEMBER_USED_CREDITS = 120;

const base = () => `/workspace/organizations/${juniper}`;

async function switchTo(account: { email: string }) {
  await api('/account/sign-out', 'POST', {});
  await signInAs(account);
}

/** The signed-in member's id in the business, read as the member sees it. */
async function memberPersonId() {
  await switchTo(DEMO_ACCOUNTS.employee);
  const workspace = await api<WorkspaceView>('/workspace');
  const here = workspace.organizations.find((row) => row.organization.id === juniper)!;
  expect(here.membership.role).toBe('member');
  return here.membership.personId;
}

/** `credits` of this month settled against the member, in the faux store the account service reads. */
async function setMemberUsed(personId: string, credits: number) {
  const at = new Date().toISOString();
  const periodId = periodIdFor(at);
  const spent = micro(creditAmount(credits));
  await cloud.store.run(async (draft) => {
    const tenantId = draft.accounts.organizations.find((row) => row.record.id === juniper)!.record.tenantId;
    draft.funding.attemptPeople = draft.funding.attemptPeople.filter((row) => row.attemptId !== MEMBER_ATTEMPT);
    draft.funding.settlements = draft.funding.settlements.filter((row) => row.reservationId !== MEMBER_ATTEMPT);
    draft.funding.attemptPeople.push({ tenantId, attemptId: MEMBER_ATTEMPT, organizationId: juniper, personId });
    draft.funding.settlements.push({
      reservationId: MEMBER_ATTEMPT, organizationId: juniper, periodId, providerCostMicroUsd: spent, allowanceDebitMicroUsd: spent,
      rateCardVersion: RATE_CARD_V1.version, eligibility: 'included', settledAt: at, reconciledFrom: 'response', tenantId,
      receiptRef: 'receipt_settings_usage_member', monthlyDebitMicroUsd: spent, topUpDebitMicroUsd: micro(0), usage: {},
    } as unknown as AttemptSettlement);
  });
}

/** The owner sets the member's limit (or lifts it) and what the member used, then the member is the one signed in. */
async function memberMonth(limit: number | null) {
  const personId = await memberPersonId();
  await switchTo(DEMO_ACCOUNTS.owner);
  await setUsedPercent(10);
  await setMemberUsed(personId, MEMBER_USED_CREDITS);
  await api(`${base()}/credit-limits`, 'POST', {
    subject: { kind: 'person', personId },
    ...(limit === null ? { mode: 'unlimited' } : { mode: 'limit', limitMicroUsd: creditAmount(limit) }),
  });
  await api(`${base()}/credit-limits/settings`, 'POST', { membersSeeOwnUsage: true });
  await switchTo(DEMO_ACCOUNTS.employee);
}

const businessWords = (page: Page) => page.getByText(/Credits you bought|Buy credits|Buy more/);

test('a member finds Usage in Settings and sees only their own use against their own limit', async ({ page }) => {
  await memberMonth(MEMBER_LIMIT_CREDITS);
  await openSettings(page);
  await expect(usageEntry(page)).toBeVisible();
  await usageEntry(page).click();
  await expect(page.getByRole('heading', { name: 'Agent usage', level: 2 })).toBeVisible();
  await expect(meter(page)).toBeVisible();
  await expect(meter(page)).toHaveAttribute('data-tone', 'ok');
  await expect(page.getByText(`${MEMBER_USED_CREDITS} of ${MEMBER_LIMIT_CREDITS} credits used this month`)).toBeVisible();
  await expect(meter(page).locator('.uc-fill')).toHaveAttribute('style', new RegExp(`width:\\s*${(MEMBER_USED_CREDITS / MEMBER_LIMIT_CREDITS) * 100}%`));
  // Not the business's month (which is 100 of 1,000 here), not what it bought, and nothing to buy.
  await expect(page.getByText(/of 1,000 credits/)).toHaveCount(0);
  await expect(bought(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Buy credits' })).toHaveCount(0);
  await expect(businessWords(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Buy', exact: true })).toHaveCount(0);
});

test('a member with no limit sees what they used and no bar', async ({ page }) => {
  await memberMonth(null);
  await openSettings(page);
  await expect(usageEntry(page)).toBeVisible();
  await usageEntry(page).click();
  await expect(page.getByRole('heading', { name: 'Agent usage', level: 2 })).toBeVisible();
  await expect(page.getByText(`${MEMBER_USED_CREDITS} credits used this month`)).toBeVisible();
  await expect(meter(page)).toHaveCount(0);
  await expect(page.locator('.uc-fill')).toHaveCount(0);
  await expect(bought(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Buy credits' })).toHaveCount(0);
});

test('when the owner turns off members seeing their own usage, a member has no Usage in Settings, and the account service would refuse them anyway', async ({ page }) => {
  await memberMonth(MEMBER_LIMIT_CREDITS);
  await switchTo(DEMO_ACCOUNTS.owner);
  await api(`${base()}/credit-limits/settings`, 'POST', { membersSeeOwnUsage: false });
  try {
    await switchTo(DEMO_ACCOUNTS.employee);
    const workspace = await api<WorkspaceView>('/workspace');
    const here = workspace.organizations.find((row) => row.organization.id === juniper)!;
    expect(here.membership.role).toBe('member');
    expect(await api(`${base()}/credit-usage/mine`)).toMatchObject({ state: 'hidden' });

    // The Usage entry waits on the member's own read, and is absent when it says hidden, so the absence only means something
    // after that read is in. Wait for the read the Settings page itself makes: armed after the console is up (whose own reads
    // are done) and just before Settings opens.
    await openConsole(page);
    const read = page.waitForResponse((response) => new URL(response.url()).pathname === `/api${base()}/credit-usage/mine` && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await read;
    await expect(settingsNav(page)).toBeVisible();
    await expect(settingsNav(page).getByRole('button', { name: 'Account', exact: true })).toBeVisible();
    // The read is in, and the entry the owner got is still not there.
    await expect(usageEntry(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Agent usage', level: 2 })).toHaveCount(0);

    const quote = await fetch(`${baseURL}/api${base()}/allowance/credit-purchases/quote?credits=${PLAN_STEP_CREDITS}`, { headers: HEADERS });
    expect(quote.ok).toBe(false);
    const members = await fetch(`${baseURL}/api${base()}/credit-usage/members`, { headers: HEADERS });
    expect(members.status).toBe(403);
  } finally {
    await switchTo(DEMO_ACCOUNTS.owner);
    await api(`${base()}/credit-limits/settings`, 'POST', { membersSeeOwnUsage: true });
  }
});

// --- Your coding tools (subscription-aware orchestration S3) -------------------------------------

const TOOLS_PATH = '/settings/subscription-workers';
const toolsEntry = (page: Page) => settingsNav(page).getByRole('button', { name: 'Your coding tools', exact: true });
/** What the service holds now, through the section's own read. */
const savedTools = async () => (await api<SubscriptionWorkersView>(TOOLS_PATH)).preference;

async function openCodingTools(page: Page) {
  await openSettings(page);
  await toolsEntry(page).click();
  await expect(page.getByRole('heading', { name: 'Your coding tools', level: 1 })).toBeVisible();
  const section = page.locator('.settings-layout .reading');
  return {
    section,
    understand: section.getByRole('checkbox', { name: 'I understand', exact: true }),
    toggle: section.getByRole('checkbox', { name: 'Hand tasks to my coding tools', exact: true }),
    tools: section.getByRole('group', { name: 'Tools to use, first choice at the top', exact: true }),
    reserve: section.getByRole('radiogroup', { name: "Keep part of each tool's limit for your own work", exact: true }),
    fallback: section.getByRole('radiogroup', { name: 'When none of your tools can take a task', exact: true }),
  };
}

test('your coding tools: confirmed, turned on and saved in the person’s order, through the real preference routes', async ({ page }) => {
  await switchTo(DEMO_ACCOUNTS.owner);
  const { consent } = await api<SubscriptionWorkersView>(TOOLS_PATH);
  expect(await savedTools()).toBeNull();
  const { section, understand, toggle, tools, reserve, fallback } = await openCodingTools(page);
  await expect(
    section.getByText(
      'Nectovia can hand a task in your Personal work to a coding tool you already pay for. That task runs on your plan, not your Nectovia credits.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(section.getByText(consent.text, { exact: true })).toBeVisible();
  await expect(section.getByText(/has changed/)).toHaveCount(0);
  await expect(understand).not.toBeChecked();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  // Every tool by the server's name, in its order, none chosen.
  await expect(tools.locator('[data-tool]')).toHaveText([/^Claude Code/, /^Codex/, /^OpenCode/]);
  for (const name of ['Claude Code', 'Codex', 'OpenCode']) await expect(tools.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
  await expect(tools.getByRole('button', { name: 'Move Claude Code up', exact: true })).toBeDisabled();
  await expect(tools.getByRole('button', { name: 'Move OpenCode down', exact: true })).toBeDisabled();
  await expect(reserve.getByRole('radio', { name: 'No. Use a tool whenever it can take the task.', exact: true })).toBeChecked();
  await expect(
    section.getByText("A tool that doesn't report how much of its limit is left won't get tasks while you keep a share.", { exact: true }),
  ).toBeVisible();
  await expect(fallback.getByRole('radio', { name: 'Nectovia does it with your Nectovia credits', exact: true })).toBeChecked();
  await expect(fallback.getByRole('radio', { name: 'Hold the work until one of your tools can take it', exact: true })).not.toBeChecked();

  // Codex, put first, confirmed and turned on.
  await tools.getByRole('checkbox', { name: 'Codex', exact: true }).check();
  await expect.poll(savedTools).toMatchObject({ enabled: false, engines: ['codex'] });
  await tools.getByRole('button', { name: 'Move Codex up', exact: true }).click();
  await expect(tools.locator('[data-tool]')).toHaveText([/^Codex/, /^Claude Code/, /^OpenCode/]);
  await understand.check();
  await expect(toggle).toBeEnabled();
  await toggle.check();
  await expect.poll(savedTools).toMatchObject({
    enabled: true,
    engines: ['codex'],
    reserve: { kind: 'none' },
    whenUnavailable: 'single-agent',
    consentRevision: consent.revision,
  });
  await expect(understand).toBeChecked();
  await expect(understand).toBeDisabled();
  await tools.getByRole('checkbox', { name: 'Claude Code', exact: true }).check();
  await expect.poll(savedTools).toMatchObject({ engines: ['codex', 'claude-code'] });

  // Keep 30% of each tool's limit, and hold the work when no tool can take it.
  const share = reserve.getByRole('spinbutton', { name: "Share of each tool's limit to keep, in percent", exact: true });
  await share.fill('30');
  await share.press('Enter');
  await expect.poll(savedTools).toMatchObject({ reserve: { kind: 'provider-window', keepPercent: 30 } });
  await expect(reserve.getByRole('radio', { name: /^Yes, keep/ })).toBeChecked();
  await fallback.getByRole('radio', { name: 'Hold the work until one of your tools can take it', exact: true }).check();
  await expect.poll(savedTools).toMatchObject({ whenUnavailable: 'pause' });

  // A change the server refuses shows its own sentence, and the control goes back to what's saved.
  await tools.getByRole('checkbox', { name: 'Claude Code', exact: true }).uncheck();
  await expect.poll(savedTools).toMatchObject({ engines: ['codex'] });
  await tools.getByRole('checkbox', { name: 'Codex', exact: true }).click();
  await expect(section.getByRole('alert')).toHaveText('No coding tool is chosen for Nectovia to hand tasks to. Choose one in Settings.');
  await expect(tools.getByRole('checkbox', { name: 'Codex', exact: true })).toBeChecked();
  expect(await savedTools()).toMatchObject({ enabled: true, engines: ['codex'] });

  // Opened again, it shows what's saved.
  const again = await openCodingTools(page);
  await expect(again.toggle).toBeChecked();
  await expect(again.understand).toBeChecked();
  await expect(again.understand).toBeDisabled();
  await expect(again.tools.locator('[data-tool]')).toHaveText([/^Codex/, /^Claude Code/, /^OpenCode/]);
  await expect(again.tools.getByRole('checkbox', { name: 'Codex', exact: true })).toBeChecked();
  await expect(again.reserve.getByRole('spinbutton')).toHaveValue('30');
  await expect(again.fallback.getByRole('radio', { name: 'Hold the work until one of your tools can take it', exact: true })).toBeChecked();
  await expect(again.section.getByRole('alert')).toHaveCount(0);

  // Turned off, it asks again before it can be on again.
  await again.toggle.uncheck();
  await expect.poll(savedTools).toMatchObject({ enabled: false, engines: ['codex'] });
  await expect(again.understand).not.toBeChecked();
  await expect(again.toggle).toBeDisabled();
});

test('your coding tools: a choice saved on under an older consent says so and stays off until confirmed', async ({ page }) => {
  await switchTo(DEMO_ACCOUNTS.owner);
  const { consent } = await api<SubscriptionWorkersView>(TOOLS_PATH);
  const on = { enabled: true, engines: ['codex'], reserve: { kind: 'none' }, whenUnavailable: 'single-agent', consentRevision: consent.revision };
  await api(TOOLS_PATH, 'PUT', on);
  // The consent text changed since: the service holds it on under an older revision.
  const store = application!.locals.store;
  await store.saveSettings({ ...store.settings, subscriptionWorkers: { ...store.settings.subscriptionWorkers, consentRevision: '2026-01-01.1' } });
  const { section, understand, toggle } = await openCodingTools(page);
  await expect(
    section.getByText('What handing tasks to your coding tools sends has changed. Read it again and confirm.', { exact: true }),
  ).toBeVisible();
  await expect(understand).not.toBeChecked();
  await expect(understand).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await understand.check();
  await toggle.check();
  await expect.poll(savedTools).toMatchObject({ enabled: true, consentRevision: consent.revision });
  await expect(section.getByText(/has changed/)).toHaveCount(0);
  await api(TOOLS_PATH, 'PUT', { ...on, enabled: false });
});

test('your coding tools: no section at all when the build doesn’t offer it, and only a sign-in line when nobody is signed in', async ({ page }) => {
  await switchTo(DEMO_ACCOUNTS.owner);
  const real = await api<SubscriptionWorkersView>(TOOLS_PATH);
  expect(real.available).toBe(true);
  const serve = async (view: SubscriptionWorkersView) => {
    await page.unroute(`**/api${TOOLS_PATH}`);
    await page.route(`**/api${TOOLS_PATH}`, (route) => route.fulfill({ status: 200, json: view }));
  };
  // Not offered: once the Settings read says so, the rail has no entry and nothing says why.
  await serve({ ...real, available: false });
  await openConsole(page);
  const read = page.waitForResponse((response) => new URL(response.url()).pathname === `/api${TOOLS_PATH}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await read;
  await expect(settingsNav(page).getByRole('button', { name: 'Account', exact: true })).toBeVisible();
  await expect(toolsEntry(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your coding tools' })).toHaveCount(0);
  await expect(page.getByText(SUBSCRIPTION_WORKERS_UNAVAILABLE)).toHaveCount(0);
  // Offered with nobody signed in: only the line asking to sign in.
  await serve({ ...real, signedIn: false, preference: null });
  const { section } = await openCodingTools(page);
  await expect(section).toHaveText('Sign in to choose your coding tools.');
});
