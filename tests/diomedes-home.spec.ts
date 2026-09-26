import { test, expect, type Page, type Route } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import type { Store } from '../server/store';
import { testOnlySecretBox } from '../server/connection-secrets';
import type { Project, ProjectState } from '../shared/types';
import { SCRIPTED_MODEL, scriptedEngineService } from './fixtures/scripted-conversation';
import { awsTransport } from './fixtures/scripted-home-luna';
import { gateway, nectoviaAccounts, refusal } from './fixtures/nectovia-home';
import { shareAfter } from './fixtures/cloud-sharing-grant';

// The Diomedes page end to end in a real browser: the real Store, Runtime, session driver and
// both admissions, with only the providers scripted. The conversation runs on Nectovia, the
// company-managed route a Diomedes conversation is provisioned on: the Business owner the app
// signs in at start (test mode) sends through the real account service and its real managed
// gateway, and the scripted provider answers behind the gateway at the provider boundary. The
// customer connects nothing. It never calls a model, uses credentials or spends quota. Like
// native-ui.spec.ts it serves the built bundle, so it refuses a stale one.
test.describe.configure({ mode: 'serial' });

const port = Number(process.env.DIOMEDES_HOME_UI_PORT ?? 47639);
const baseURL = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let project: Project;
let pageErrors: string[] = [];
/** Calls that went to a provider directly rather than through Nectovia's gateway. */
let direct = 0;

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(
      `Diomedes page fixture request ${route} failed (${response.status}): ${await response.text()}`,
    );
  const value = (await response.json()) as T;
  await shareAfter(api, route, method, value);
  return value;
}

async function expectFreshBundle(dist: string): Promise<void> {
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  let newest = 0;
  let newestPath = '';
  for (const dir of ['client', 'client/console', 'shared']) {
    for (const entry of await fs.readdir(path.resolve(dir), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.resolve(dir, entry.name);
      const { mtimeMs } = await fs.stat(file);
      if (mtimeMs > newest) {
        newest = mtimeMs;
        newestPath = path.relative(process.cwd(), file);
      }
    }
  }
  expect(
    built,
    `dist is older than ${newestPath}, so this spec would test the previous build. Run "npm run build" first.`,
  ).toBeGreaterThan(newest);
}

const state = () => api<ProjectState>(`/projects/${project.id}/state`);
const home = () => api<{ projectId: string; threadId: string } | null>('/home/conversation');
/** What a person's project list holds. The home Project is never in it. */
const listed = async () => (await api<{ projects: Project[] }>('/projects')).projects;
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Nectovia' });
const answers = (page: Page) => page.locator('.turn.dio .body');

async function open(page: Page) {
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
}
async function say(page: Page, text: string) {
  // The box ignores Enter for as long as a delivery runs, as the Send button does. A person
  // waits for it; so does this. "The strip is gone" and "the answer is there" are both true
  // while a Send again is still in flight, so neither can stand in for it.
  await expect(page.locator('.dio-pending')).toHaveCount(0);
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'diomedes-home-'));
  const { accounts } = await nectoviaAccounts(awsTransport);
  application = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    port,
    clientPort: port,
    engineService: scriptedEngineService(path.join(root, 'engines'), root),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    // Nectovia reaches its gateway on the account service's own transport. Nothing on this
    // computer calls a provider directly, so this transport only counts.
    modelApiTransport: (async () => {
      direct += 1;
      throw new Error('No provider is called directly in this spec.');
    }) as typeof globalThis.fetch,
    accounts,
    // A customer's app: the owner's own provider routes stay out of AI setup.
    ownerRoutes: false,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  await expectFreshBundle(dist);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server = application.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/claude-code', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'claude-code', model: SCRIPTED_MODEL });
  await api('/settings', 'PUT', {
    onboarding: {
      work: 'business',
      detail: 'guided',
      familiarity: 'new',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  // The project's own work runs on the scripted sample worker, so starting Work needs no
  // provider. The conversation runs on Nectovia: the provisioner's default pins its thread.
  const store = application.locals.store as Store;
  const saved = store.state(project.id);
  saved.project.ai = { engine: 'sample', model: null };
  await store.persist(saved);
});

test.afterAll(async () => {
  await application?.locals.close?.();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test('the app opens to Diomedes, and looking at it creates nothing', async ({ page }) => {
  await open(page);
  await expect(composer(page)).toBeVisible();
  expect(await home()).toBeNull();
  expect((await listed()).map((item) => item.name)).toEqual(['Linen service']);

  // Automations opens the business's output project on its screen (D4). The signed-in owner
  // works in Juniper Street Bakery, which has not chosen the project it writes into, so it says
  // why and opens nothing, and creates nothing.
  const automations = page.getByRole('button', { name: /Automations/ }).first();
  await expect(automations).not.toHaveAttribute('aria-disabled', 'true');
  await automations.click();
  await expect(page.getByRole('status').filter({ hasText: 'nowhere to open Automations' })).toBeVisible();
  await expect(composer(page)).toBeVisible();
  expect(await home()).toBeNull();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  // Everything opens by pointing at it, and the rest of the app is still one step away.
  await page.getByRole('button', { name: 'Everything', exact: true }).hover();
  await expect(page.getByRole('menu', { name: 'Everything' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Projects', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Linen service/ }).first()).toBeVisible();
});

test('a greeting is answered and starts nothing', async ({ page }) => {
  await open(page);
  const calls = gateway.length;
  await say(page, 'Good morning');
  await expect(answers(page).last()).toHaveText('You said: Good morning');
  await expect(composer(page)).toHaveValue('');
  await expect(page.locator('.dio-card')).toHaveCount(0);
  // The answer came through Nectovia's gateway for the signed-in business, and nothing on this
  // computer called a provider itself.
  expect(gateway.length).toBeGreaterThan(calls);
  expect(gateway.at(-1)!.headers['x-nectovia-organization']).toMatch(/\S/);
  expect(direct).toBe(0);

  // The first message made the home conversation. It is nobody's project: the listing leaves
  // it out, and no task or work exists anywhere.
  const bound = await home();
  expect(bound).not.toBeNull();
  expect((await listed()).map((item) => item.id)).toEqual([project.id]);
  const before = await state();
  expect([before.tasks.length, before.sessions.length]).toEqual([0, 0]);

  await page.reload();
  await expect(answers(page).last()).toHaveText('You said: Good morning');
  expect(await home()).toEqual(bound);
});

test('across all projects there is nowhere to start work, so nothing starts', async ({ page }) => {
  await open(page);
  await say(page, 'ACT tidy the plan');
  const card = page.locator('.dio-card');
  await expect(card).toContainText('Nothing was started');
  await expect(card.getByRole('button')).toHaveCount(0);
  const after = await state();
  expect([after.tasks.length, after.sessions.length]).toEqual([0, 0]);
});

test('in a project, work is offered and starts only when Start is pressed', async ({ page }) => {
  await open(page);
  await page.getByRole('combobox', { name: 'In' }).selectOption({ label: 'Linen service' });
  await say(page, 'ACT tidy the plan');
  const card = page.locator('.dio-card');
  await expect(card).toContainText('Nectovia can start this in Linen service');

  // Offered, not started: the project is untouched until the person presses Start.
  const offered = await state();
  expect([offered.tasks.length, offered.sessions.length]).toEqual([0, 0]);
  const thread = offered.conversations.find((item) => item.name === 'Diomedes');
  expect([thread?.mode, thread?.engine]).toEqual(['auto', 'nectovia']);

  await card.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(card).toContainText('Started in Linen service');
  const started = await state();
  expect([started.tasks.length, started.sessions.length]).toEqual([1, 1]);

  await card.getByRole('button', { name: 'Open the work', exact: true }).click();
  // The project opens in the Console, where the work it started can be followed.
  await expect(page.getByRole('navigation', { name: 'Threads and views', exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Open projects', exact: true })
      .getByRole('button', { name: 'Linen service', exact: true }),
  ).toBeVisible();
});

test('Answer only holds the same request to an answer', async ({ page }) => {
  await open(page);
  await page.getByRole('combobox', { name: 'In' }).selectOption({ label: 'Linen service' });
  // The project's Diomedes conversation is found again, not made twice.
  await expect(answers(page).last()).toContainText('I can start that.');
  await page.getByRole('combobox', { name: 'Mode' }).selectOption({ label: 'Answer only' });
  await say(page, 'ACT tidy it again');
  // Under Answer only the model is never shown how to propose work, so there is only an answer.
  await expect(answers(page).last()).toHaveText('You said: ACT tidy it again');
  await expect(page.locator('.dio-card')).toHaveCount(0);
  const after = await state();
  expect(after.tasks.length).toBe(1);
  expect(after.conversations.filter((item) => item.name === 'Diomedes')).toHaveLength(1);
});

test('a reply that was lost is asked about again, and the message is never sent twice', async ({
  page,
}) => {
  await open(page);
  // The server receives and records the message. Only its reply is lost on the way back.
  await page.route('**/api/projects/*/threads/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await say(page, 'Lost reply');
  const strip = page.getByRole('group', { name: 'A message that was not confirmed' });
  await expect(strip).toContainText('Lost reply');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  // Closing and reopening the page does not lose it.
  await page.unroute('**/api/projects/*/threads/*/messages');
  await page.reload();
  await expect(strip).toContainText('Lost reply');
  await strip.getByRole('button', { name: 'Send again', exact: true }).click();
  await expect(answers(page).last()).toHaveText('You said: Lost reply');
  await expect(strip).toHaveCount(0);

  const bound = (await home())!;
  const turns = (await api<ProjectState>(`/projects/${bound.projectId}/state`)).conversations.find(
    (item) => item.id === bound.threadId,
  )!.turns;
  expect(turns.filter((turn) => turn.role === 'you' && turn.text === 'Lost reply')).toHaveLength(1);
  expect(turns.filter((turn) => turn.text === 'You said: Lost reply')).toHaveLength(1);
});

test('the page holds together on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await open(page);
  await expect(composer(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a message the server refuses stays in the box', async ({ page }) => {
  // Nectovia's gateway refuses this business's message before sending it anywhere: the month's
  // credits are used. The words are the service's own, and nothing was charged.
  refusal.next = {
    status: 402,
    code: 'insufficient_allowance',
    message: "This business has used this month's 1,000 credits.",
  };
  try {
    await open(page);
    const calls = gateway.length;
    await say(page, 'Are you there?');
    // The refusal is Nectovia's, never a fallback it did not take.
    await expect(page.getByRole('alert')).toHaveText("This business has used this month's 1,000 credits.");
    await expect(composer(page)).toHaveValue('Are you there?');
    await expect(page.locator('.dio-card')).toHaveCount(0);
    expect(gateway.length).toBe(calls + 1);
    expect(direct).toBe(0);
  } finally {
    refusal.next = null;
  }
});

// CD-05.R-2's reproducers, pasted unchanged from
// docs/implementation/2026-09-21-core-agent-client-review-r2.md.
async function reviewProject(page: Page, name: string) {
  const p = await api<Project>('/projects', 'POST', { name });
  const store = application!.locals.store as Store;
  const saved = store.state(p.id);
  saved.project.ai = { engine: 'sample', model: null };
  await store.persist(saved);
  await open(page);
  await page.getByRole('combobox', { name: 'In' }).selectOption(p.id);
  await say(page, `Warm ${name}`);
  await expect(answers(page).last()).toHaveText(`You said: Warm ${name}`);
  await page.getByRole('combobox', { name: 'Mode' }).selectOption('automatic');
  return p;
}

async function painted(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test('CD05-R-05: a failed transcript read does not return a confirmed send', async ({ page }) => {
  await open(page);
  await say(page, 'Warm R05');
  await expect(answers(page).last()).toHaveText('You said: Warm R05');
  const bound = (await home())!;
  await page.route(`**/api/projects/${bound.projectId}/state`, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Transcript read failed' } }),
    }), { times: 1 });
  await say(page, 'Only once R05');
  await expect(page.getByRole('alert')).toHaveText('Transcript read failed');
  const recorded = await api<ProjectState>(`/projects/${bound.projectId}/state`);
  const turns = recorded.conversations.find((t) => t.id === bound.threadId)!.turns;
  expect(turns.filter((t) => t.role === 'you' && t.text === 'Only once R05')).toHaveLength(1);
  // Candidate instead restores "Only once R05". Enter then sends a new command.
  await expect(composer(page)).toHaveValue('');
});

test('CD05-R-07: a selection result cannot paint a different scope', async ({ page }) => {
  const p = await reviewProject(page, 'R07 project');
  await say(page, 'ACT R07 work');
  await expect(page.locator('.dio-card')).toContainText('Nectovia can start this');
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const recorded = new Promise<void>((resolve) => { reached = resolve; });
  await page.route('**/messages/*/select', async (route) => {
    const response = await route.fetch();
    reached();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.locator('.dio-card').getByRole('button', { name: 'Start', exact: true }).click();
    await recorded;
    await page.getByRole('combobox', { name: 'In' }).selectOption({ label: 'All projects' });
    await say(page, 'Home after R07');
    await expect(answers(page).last()).toHaveText('You said: Home after R07');
    const arrived = page.waitForResponse((r) => r.url().endsWith('/select'));
    release();
    await arrived;
    await painted(page);
    await expect(page.getByRole('combobox', { name: 'In' })).not.toHaveValue(p.id);
    // Candidate shows "Started in R07 project" under the home greeting.
    await expect(page.locator('.dio-card')).toHaveCount(0);
  } finally {
    release();
  }
});

test('CD05-R-08: a proposal remains selectable after reload', async ({ page }) => {
  const p = await reviewProject(page, 'R08 project');
  await say(page, 'ACT R08 proposal');
  await expect(page.locator('.dio-card')).toContainText('Nectovia can start this');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
  const outcomeRead = page.waitForResponse((r) =>
    r.request().method() === 'GET' && /\/messages\/[^/]+$/.test(r.url()));
  await page.getByRole('combobox', { name: 'In' }).selectOption(p.id);
  const result = await (await outcomeRead).json();
  expect(result.outcome.status).toBe('proposed');
  expect(result.answerText).toBeNull();
  await expect(answers(page).last()).toContainText('I can start that.');
  // Candidate has no card, even though the read above returned the proposal.
  await expect(page.locator('.dio-card').getByRole('button', { name: 'Start', exact: true }))
    .toBeVisible();
});

test('CD05-R-09: refusal after a lost reply exposes the retained message', async ({ page }) => {
  await open(page);
  await say(page, 'Warm R09');
  await expect(answers(page).last()).toHaveText('You said: Warm R09');
  let attempts = 0;
  await page.route('**/api/projects/*/threads/*/messages', async (route) => {
    if (++attempts === 1) {
      await route.fetch();
      return route.abort('failed');
    }
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Retry refused R09' } }),
    });
  });
  await say(page, 'Uncertain R09');
  await expect(page.getByRole('alert')).toHaveText('Retry refused R09');
  const bound = (await home())!;
  const key = `diomedes.conversation.pending.${encodeURIComponent(bound.projectId)}|${encodeURIComponent(bound.threadId)}`;
  expect(await page.evaluate((k) => sessionStorage.getItem(k), key)).not.toBeNull();
  // Candidate has the saved command but no strip or Discard control.
  await expect(page.getByRole('group', { name: 'A message that was not confirmed' }))
    .toContainText('Uncertain R09');
});

test('CD05-R-10: concurrent first sends adopt one project thread', async ({ page, context }) => {
  const p = await api<Project>('/projects', 'POST', { name: 'R10 project' });
  const other = await context.newPage();
  try {
    await Promise.all([open(page), open(other)]);
    await Promise.all([page, other].map(async (window) => {
      const loaded = window.waitForResponse((r) => r.url().endsWith(`/projects/${p.id}/state`));
      await window.getByRole('combobox', { name: 'In' }).selectOption(p.id);
      await loaded;
      await painted(window);
    }));
    let readers = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    for (const window of [page, other]) {
      await window.route(`**/api/projects/${p.id}/state`, async (route) => {
        const snapshot = await route.fetch();
        if (++readers === 2) release();
        await bothRead;
        await route.fulfill({ response: snapshot });
      }, { times: 1 });
    }
    await Promise.all([say(page, 'First R10'), say(other, 'Second R10')]);
    await Promise.all([
      expect(answers(page).last()).toHaveText('You said: First R10'),
      expect(answers(other).last()).toHaveText('You said: Second R10'),
    ]);
    const saved = await api<ProjectState>(`/projects/${p.id}/state`);
    // Candidate creates two. No test here sends the same text twice.
    expect(saved.conversations.filter((t) => t.name === 'Diomedes')).toHaveLength(1);
  } finally {
    await other.close();
  }
});

// The closure cases CD-05.R-2 asked for beyond its reproducers. Each makes its own project or
// uses its own words, so it runs alone as well as in the file.

const strip = (page: Page) =>
  page.getByRole('group', { name: 'A message that was not confirmed' });
const messagePost = (request: { method(): string; url(): string }) =>
  request.method() === 'POST' && /\/messages$/.test(request.url());
/** How many times the person's words are on record, across the project's Diomedes threads. */
async function said(projectId: string, text: string) {
  const saved = await api<ProjectState>(`/projects/${projectId}/state`);
  return saved.conversations
    .filter((thread) => thread.name === 'Diomedes' || thread.name === 'Conversation')
    .flatMap((thread) => thread.turns)
    .filter((turn) => turn.role === 'you' && turn.text === text).length;
}
/** Holds one response after the server has answered it, until the test lets it through. */
function gate() {
  let release!: () => void;
  let reached!: () => void;
  let delivered!: () => void;
  return {
    held: new Promise<void>((resolve) => (release = resolve)),
    recorded: new Promise<void>((resolve) => (reached = resolve)),
    arrived: new Promise<void>((resolve) => (delivered = resolve)),
    release: () => release(),
    reached: () => reached(),
    delivered: () => delivered(),
  };
}

test('CD05-R-05 closure: reading again after a failed read sends nothing', async ({ page }) => {
  await open(page);
  await say(page, 'Warm R05b');
  await expect(answers(page).last()).toHaveText('You said: Warm R05b');
  const bound = (await home())!;
  let posts = 0;
  page.on('request', (request) => {
    if (messagePost(request)) posts += 1;
  });
  await page.route(
    `**/api/projects/${bound.projectId}/state`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Transcript read failed' } }),
      }),
    { times: 1 },
  );
  await say(page, 'Read again R05');
  await expect(page.getByRole('alert')).toHaveText('Transcript read failed');
  await expect(composer(page)).toHaveValue('');
  await page.getByRole('button', { name: 'Read again', exact: true }).click();
  await expect(answers(page).last()).toHaveText('You said: Read again R05');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Read again', exact: true })).toHaveCount(0);
  // One message, one command: the read was owed, never the send.
  expect(posts).toBe(1);
  expect(await said(bound.projectId, 'Read again R05')).toBe(1);
});

test('CD05-R-06 closure: another window offers the unconfirmed message and sends the same command', async ({
  page,
  context,
}) => {
  const commands: string[] = [];
  const watch = (window: Page) =>
    window.on('request', (request) => {
      if (messagePost(request)) commands.push(request.postDataJSON().commandId);
    });
  watch(page);
  await open(page);
  await say(page, 'Warm R06');
  await expect(answers(page).last()).toHaveText('You said: Warm R06');
  commands.length = 0;
  // The server records the message. Both of this window's attempts lose the reply.
  await page.route('**/api/projects/*/threads/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await say(page, 'Lost R06');
  await expect(strip(page)).toContainText('Lost R06');

  const other = await context.newPage();
  try {
    watch(other);
    await open(other);
    await expect(strip(other)).toContainText('Lost R06');
    await strip(other).getByRole('button', { name: 'Send again', exact: true }).click();
    // The answer was already in the transcript this window opened on, and the strip is hidden
    // for as long as a delivery runs. The delivery ending is what says the message is settled.
    await expect(other.locator('.dio-pending')).toHaveCount(0);
    await expect(answers(other).last()).toHaveText('You said: Lost R06');
    await expect(strip(other)).toHaveCount(0);
    // Two attempts in the first window and one in the second, all one command.
    expect(commands).toHaveLength(3);
    expect(new Set(commands).size).toBe(1);

    // What the first window still holds is settled now, and reading again says so.
    await page.unroute('**/api/projects/*/threads/*/messages');
    await page.reload();
    await expect(answers(page).last()).toHaveText('You said: Lost R06');
    await expect(strip(page)).toHaveCount(0);
    expect(await said((await home())!.projectId, 'Lost R06')).toBe(1);
  } finally {
    await other.close();
  }
});

test('CD05-R-07 closure: a selection result cannot paint a later message', async ({ page }) => {
  const p = await reviewProject(page, 'R07b project');
  await say(page, 'ACT R07b work');
  await expect(page.locator('.dio-card')).toContainText('Nectovia can start this');
  const select = gate();
  await page.route('**/messages/*/select', async (route) => {
    const response = await route.fetch();
    select.reached();
    await select.held;
    await route.fulfill({ response });
    select.delivered();
  });
  try {
    await page.locator('.dio-card').getByRole('button', { name: 'Start', exact: true }).click();
    await select.recorded;
    await say(page, 'Later R07b');
    await expect(answers(page).last()).toHaveText('You said: Later R07b');
    select.release();
    await select.arrived;
    await painted(page);
    await expect(page.locator('.dio-card')).toHaveCount(0);
    await expect(answers(page).last()).toHaveText('You said: Later R07b');
    // The work did start. The record has it; this screen just is not where it is told.
    expect((await api<ProjectState>(`/projects/${p.id}/state`)).tasks).toHaveLength(1);
  } finally {
    select.release();
  }
});

test('CD05-R-07 closure: a read from an earlier visit cannot paint this one', async ({ page }) => {
  const p = await reviewProject(page, 'R07c project');
  const scope = page.getByRole('combobox', { name: 'In' });
  await scope.selectOption({ label: 'All projects' });
  const read = gate();
  await page.route(
    `**/api/projects/${p.id}/state`,
    async (route) => {
      const response = await route.fetch();
      read.reached();
      await read.held;
      await route.fulfill({ response });
      read.delivered();
    },
    { times: 1 },
  );
  try {
    // The first visit's read is held. The person leaves and comes back, and the second visit
    // reads, sends and is answered before the first read ever lands.
    await scope.selectOption(p.id);
    await read.recorded;
    await scope.selectOption({ label: 'All projects' });
    await scope.selectOption(p.id);
    await expect(answers(page).last()).toHaveText('You said: Warm R07c project');
    await say(page, 'Second visit R07c');
    await expect(answers(page).last()).toHaveText('You said: Second visit R07c');
    read.release();
    await read.arrived;
    await painted(page);
    await expect(answers(page).last()).toHaveText('You said: Second visit R07c');
  } finally {
    read.release();
  }
});

test('CD05-R-07 closure: a send the person walked away from is offered back, and sent once', async ({
  page,
}) => {
  const p = await reviewProject(page, 'R07d project');
  const scope = page.getByRole('combobox', { name: 'In' });
  const sent = gate();
  await page.route(
    '**/api/projects/*/threads/*/messages',
    async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      sent.reached();
      await sent.held;
      await route.abort('failed').catch(() => undefined);
    },
    { times: 1 },
  );
  try {
    await say(page, 'Held R07d');
    await sent.recorded;
    // Leaving stops the send. Nothing about it may show across all projects.
    await scope.selectOption({ label: 'All projects' });
    sent.release();
    await painted(page);
    await expect(strip(page)).toHaveCount(0);
    await expect(composer(page)).toHaveValue('');
    // Coming back, it is offered as what it is: sent, never confirmed.
    await scope.selectOption(p.id);
    await expect(strip(page)).toContainText('Held R07d');
    await strip(page).getByRole('button', { name: 'Send again', exact: true }).click();
    await expect(answers(page).last()).toHaveText('You said: Held R07d');
    await expect(strip(page)).toHaveCount(0);
    expect(await said(p.id, 'Held R07d')).toBe(1);
  } finally {
    sent.release();
  }
});

test('CD05-R-08 closure: started work keeps its card after a reload', async ({ page }) => {
  const p = await reviewProject(page, 'R08b project');
  await say(page, 'ACT R08b work');
  const card = page.locator('.dio-card');
  await card.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(card).toContainText('Started in R08b project');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'In' }).selectOption(p.id);
  await expect(card).toContainText('Started in R08b project');
  await expect(card.getByRole('button', { name: 'Open the work', exact: true })).toBeVisible();
  expect((await api<ProjectState>(`/projects/${p.id}/state`)).tasks).toHaveLength(1);
});

test('CD05-R-08 closure: a newer message retires the card, and a reload does not bring it back', async ({
  page,
}) => {
  const p = await reviewProject(page, 'R08c project');
  await say(page, 'ACT R08c proposal');
  await expect(page.locator('.dio-card')).toContainText('Nectovia can start this');
  await say(page, 'Thanks R08c');
  await expect(answers(page).last()).toHaveText('You said: Thanks R08c');
  await expect(page.locator('.dio-card')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
  const outcomeRead = page.waitForResponse(
    (r) => r.request().method() === 'GET' && /\/messages\/[^/]+$/.test(r.url()),
  );
  await page.getByRole('combobox', { name: 'In' }).selectOption(p.id);
  await outcomeRead;
  await expect(answers(page).last()).toHaveText('You said: Thanks R08c');
  await painted(page);
  await expect(page.locator('.dio-card')).toHaveCount(0);
});

test("CD05-R-08 closure: an outcome is never shown under another command's answer, however alike", async ({
  page,
}) => {
  const p = await reviewProject(page, 'R08d project');
  await say(page, 'ACT R08d proposal');
  await expect(page.locator('.dio-card')).toContainText('Nectovia can start this');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
  const outcome = gate();
  await page.route(/\/messages\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    outcome.reached();
    await outcome.held;
    await route.fulfill({ response });
    outcome.delivered();
  });
  try {
    await page.getByRole('combobox', { name: 'In' }).selectOption(p.id);
    await outcome.recorded;
    // While that read is in flight, another window asks for the same thing in the same words,
    // and is answered in the same words.
    const thread = (await api<ProjectState>(`/projects/${p.id}/state`)).conversations.find(
      (item) => item.name === 'Diomedes',
    )!;
    const before = thread.turns.at(-1)!;
    await api(`/projects/${p.id}/threads/${thread.id}/messages`, 'POST', {
      commandId: 'outside-r08d',
      text: 'ACT R08d proposal',
      mode: 'auto',
      sources: [],
      consent: true,
    });
    const after = (await api<ProjectState>(`/projects/${p.id}/state`)).conversations
      .find((item) => item.id === thread.id)!
      .turns.at(-1)!;
    expect(after.text).toBe(before.text);
    expect(after.id).not.toBe(before.id);
    outcome.release();
    await outcome.arrived;
    await painted(page);
    // The transcript read after the outcome has both requests, and the first one's proposal is
    // not offered under the second one's answer.
    await expect(page.locator('.turn.you .body', { hasText: 'ACT R08d proposal' })).toHaveCount(2);
    await expect(page.locator('.dio-card')).toHaveCount(0);
  } finally {
    outcome.release();
  }
});

test('CD05-R-09 closure: sending again sends what was saved, whatever the Mode control says now', async ({
  page,
}) => {
  const bodies: { commandId: string; mode: string; text: string }[] = [];
  page.on('request', (request) => {
    if (messagePost(request)) bodies.push(request.postDataJSON());
  });
  await open(page);
  await say(page, 'Warm R09b');
  await expect(answers(page).last()).toHaveText('You said: Warm R09b');
  bodies.length = 0;
  let attempts = 0;
  await page.route('**/api/projects/*/threads/*/messages', async (route) => {
    if (++attempts === 1) {
      await route.fetch();
      return route.abort('failed');
    }
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Retry refused R09b' } }),
    });
  });
  await say(page, 'Uncertain R09b');
  await expect(page.getByRole('alert')).toHaveText('Retry refused R09b');
  await expect(strip(page)).toContainText('Uncertain R09b');
  // It may have been accepted, so it is not handed back as a draft.
  await expect(composer(page)).toHaveValue('');
  await page.unroute('**/api/projects/*/threads/*/messages');
  await page.getByRole('combobox', { name: 'Mode' }).selectOption({ label: 'Answer only' });
  await strip(page).getByRole('button', { name: 'Send again', exact: true }).click();
  // The strip is hidden for as long as a delivery runs; its ending is what settles the message.
  await expect(page.locator('.dio-pending')).toHaveCount(0);
  await expect(answers(page).last()).toHaveText('You said: Uncertain R09b');
  await expect(strip(page)).toHaveCount(0);
  expect(bodies).toHaveLength(3);
  expect(bodies.map((body) => [body.commandId, body.mode, body.text])).toEqual(
    Array(3).fill([bodies[0].commandId, bodies[0].mode, 'Uncertain R09b']),
  );
  expect(await said((await home())!.projectId, 'Uncertain R09b')).toBe(1);
});

test("CD05-R-10 closure: a first send's lost reply is recovered from the other window, on the one thread", async ({
  page,
  context,
}) => {
  const p = await api<Project>('/projects', 'POST', { name: 'R10b project' });
  const other = await context.newPage();
  try {
    // Both windows read the fresh project before either sends, so neither has seen a thread.
    await Promise.all([open(page), open(other)]);
    await Promise.all(
      [page, other].map(async (window) => {
        const loaded = window.waitForResponse((r) => r.url().endsWith(`/projects/${p.id}/state`));
        await window.getByRole('combobox', { name: 'In' }).selectOption(p.id);
        await loaded;
        await painted(window);
      }),
    );
    // The second window's first message is recorded, and both of its attempts lose the reply.
    await other.route('**/api/projects/*/threads/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      await route.abort('failed');
    });
    await say(other, 'Second R10b');
    await expect(strip(other)).toContainText('Second R10b');

    // The first window's first send lands on that same thread, where a message is still owed
    // an answer. It is refused as itself and kept, and the owed message is offered here too.
    await say(page, 'First R10b');
    await expect(page.getByRole('alert')).toContainText('never confirmed');
    await expect(composer(page)).toHaveValue('First R10b');
    await expect(strip(page)).toContainText('Second R10b');
    expect(await said(p.id, 'First R10b')).toBe(0);

    // Either window can settle it. This one does, then sends its own.
    await strip(page).getByRole('button', { name: 'Send again', exact: true }).click();
    // The box ignores Enter until the delivery has ended, as a person would wait for it.
    await expect(page.locator('.dio-pending')).toHaveCount(0);
    await expect(answers(page).last()).toHaveText('You said: Second R10b');
    await expect(strip(page)).toHaveCount(0);
    await composer(page).press('Enter');
    await expect(answers(page).last()).toHaveText('You said: First R10b');

    // The window that lost the reply reads the same conversation, with nothing left to settle.
    await other.unroute('**/api/projects/*/threads/*/messages');
    await other.reload();
    await expect(other.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
    await other.getByRole('combobox', { name: 'In' }).selectOption(p.id);
    await expect(answers(other).last()).toHaveText('You said: First R10b');
    await expect(strip(other)).toHaveCount(0);

    const saved = await api<ProjectState>(`/projects/${p.id}/state`);
    expect(saved.conversations.filter((thread) => thread.name === 'Diomedes')).toHaveLength(1);
    expect(await said(p.id, 'First R10b')).toBe(1);
    expect(await said(p.id, 'Second R10b')).toBe(1);
  } finally {
    await other.close();
  }
});

test('CD05-R-10 closure: a conversation another window re-routed is mended by the next send', async ({
  page,
}) => {
  const p = await reviewProject(page, 'R10c project');
  const thread = (await api<ProjectState>(`/projects/${p.id}/state`)).conversations.find(
    (item) => item.name === 'Diomedes',
  )!;
  // What a re-route from before choices were marked looks like: the pin alone, with no marker.
  // A change through the thread PUT would be the person's own and the provisioner would keep it.
  const store = application!.locals.store as Store;
  const saved = store.state(p.id);
  const pinned = saved.conversations.find((item) => item.id === thread.id)!;
  pinned.engine = 'sample';
  delete (pinned as { engineChoice?: string }).engineChoice;
  await store.persist(saved);
  await say(page, 'After the re-route R10c');
  await expect(answers(page).last()).toHaveText('You said: After the re-route R10c');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const mended = (await api<ProjectState>(`/projects/${p.id}/state`)).conversations.find(
    (item) => item.id === thread.id,
  )!;
  expect(mended.engine).toBe('nectovia');
});

test('CD05-R-07 closure: an answer that lands after the person left does not paint where they went', async ({
  page,
}) => {
  const p = await reviewProject(page, 'R07e project');
  const scope = page.getByRole('combobox', { name: 'In' });
  // The message goes through. The transcript read that follows it is held.
  const read = gate();
  await page.route(
    `**/api/projects/${p.id}/state`,
    async (route) => {
      const response = await route.fetch();
      read.reached();
      await read.held;
      await route.fulfill({ response });
      read.delivered();
    },
    { times: 1 },
  );
  try {
    await say(page, 'Late R07e');
    await read.recorded;
    const homeRead = page.waitForResponse((r) => r.url().endsWith('/api/home/conversation'));
    await scope.selectOption({ label: 'All projects' });
    await homeRead;
    await painted(page);
    read.release();
    await read.arrived;
    await painted(page);
    // The project's transcript and its answer belong to the visit that asked for them.
    await expect(page.locator('.turn .body', { hasText: 'Late R07e' })).toHaveCount(0);
    expect(await said(p.id, 'Late R07e')).toBe(1);
  } finally {
    read.release();
  }
});

// CD-05.R-3's reproducer, pasted unchanged from
// docs/implementation/2026-09-21-core-agent-client-review-r3.md.
for (const action of ['Discard', 'Send again'] as const) {
  test(`CD05-R-11: stale ${action} cannot consume a newer pending message`, async ({
    page,
    context,
  }) => {
    const p = await reviewProject(page, `R11 ${action}`);
    const oldText = `Old R11 ${action}`;
    const newText = `New R11 ${action}`;
    const pattern = '**/api/projects/*/threads/*/messages';
    await page.route(pattern, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      await route.abort('failed');
    });
    await say(page, oldText);
    await expect(strip(page)).toContainText(oldText);
    const other = await context.newPage();
    try {
      await open(other);
      await other.getByRole('combobox', { name: 'In' }).selectOption(p.id);
      await expect(strip(other)).toContainText(oldText);
      await strip(other).getByRole('button', { name: 'Send again', exact: true }).click();
      await expect(strip(other)).toHaveCount(0);
      await expect(answers(other).last()).toHaveText(`You said: ${oldText}`);

      await other.route(pattern, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await route.fetch();
        await route.abort('failed');
      });
      await say(other, newText);
      await expect(strip(other)).toContainText(newText);
      const state = await api<ProjectState>(`/projects/${p.id}/state`);
      const thread = state.conversations.find((item) => item.name === 'Diomedes')!;
      const key = `diomedes.conversation.claim.${encodeURIComponent(p.id)}|${encodeURIComponent(thread.id)}`;
      const claim = await other.evaluate((k) => localStorage.getItem(k), key);
      expect(claim).not.toBeNull();
      expect(JSON.parse(claim!).input.text).toBe(newText);
      expect(await said(p.id, newText)).toBe(1);

      // A still offers the old message, although B now owns the pending claim.
      await expect(strip(page)).toContainText(oldText);
      await page.unroute(pattern);
      const posts: string[] = [];
      page.on('request', (request) => {
        if (messagePost(request)) posts.push(request.postDataJSON().commandId);
      });
      const refreshed = page.waitForResponse((response) =>
        response.request().method() === 'GET' &&
        response.url().endsWith(`/projects/${p.id}/state`));
      await strip(page).getByRole('button', { name: action, exact: true }).click();
      await refreshed;
      await painted(page);

      // Candidate: Discard deletes B; Send again POSTs B and then clears it.
      expect(posts).toEqual([]);
      expect(await other.evaluate((k) => localStorage.getItem(k), key)).toBe(claim);
    } finally {
      await other.close();
    }
  });
}

for (const action of ['Discard', 'Send again'] as const) {
  test(`CD05-R-11 closure: after a stale ${action}, the newer message is recovered by its own command, across a reload`, async ({
    page,
    context,
  }) => {
    const p = await reviewProject(page, `R11c ${action}`);
    const oldText = `Old R11c ${action}`;
    const newText = `New R11c ${action}`;
    const pattern = '**/api/projects/*/threads/*/messages';
    const lose = (window: Page) =>
      window.route(pattern, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await route.fetch();
        await route.abort('failed');
      });
    await lose(page);
    await say(page, oldText);
    await expect(strip(page)).toContainText(oldText);
    const other = await context.newPage();
    try {
      await open(other);
      await other.getByRole('combobox', { name: 'In' }).selectOption(p.id);
      await strip(other).getByRole('button', { name: 'Send again', exact: true }).click();
      // The answer was already in the transcript this window opened on, and the strip is hidden
      // for as long as a delivery runs. The delivery ending is what says the message is settled,
      // and the box ignores Enter until it has.
      await expect(other.locator('.dio-pending')).toHaveCount(0);
      await expect(strip(other)).toHaveCount(0);
      await expect(answers(other).last()).toHaveText(`You said: ${oldText}`);
      await lose(other);
      await say(other, newText);
      await expect(strip(other)).toContainText(newText);
      const state = await api<ProjectState>(`/projects/${p.id}/state`);
      const thread = state.conversations.find((item) => item.name === 'Diomedes')!;
      const key = `diomedes.conversation.claim.${encodeURIComponent(p.id)}|${encodeURIComponent(thread.id)}`;
      const claim = JSON.parse((await other.evaluate((k) => localStorage.getItem(k), key))!);

      // The first window still shows the old message. Its control acts on that message, which is
      // settled, so it sends nothing and the page reads again: the newer message is what is owed.
      await page.unroute(pattern);
      const posts: string[] = [];
      const watch = (window: Page) =>
        window.on('request', (request) => {
          if (messagePost(request)) posts.push(request.postDataJSON().commandId);
        });
      watch(page);
      watch(other);
      await strip(page).getByRole('button', { name: action, exact: true }).click();
      await expect(strip(page)).toContainText(newText);
      await expect(strip(page)).not.toContainText(oldText);
      expect(posts).toEqual([]);

      // Its own window, after a reload, sends it again under the command it was claimed with.
      await other.unroute(pattern);
      await other.reload();
      await expect(other.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
      await other.getByRole('combobox', { name: 'In' }).selectOption(p.id);
      await expect(strip(other)).toContainText(newText);
      await strip(other).getByRole('button', { name: 'Send again', exact: true }).click();
      await expect(other.locator('.dio-pending')).toHaveCount(0);
      await expect(answers(other).last()).toHaveText(`You said: ${newText}`);
      await expect(strip(other)).toHaveCount(0);
      expect(posts).toEqual([claim.commandId]);
      expect(await said(p.id, newText)).toBe(1);
      expect(await said(p.id, oldText)).toBe(1);
      expect(await other.evaluate((k) => localStorage.getItem(k), key)).toBeNull();
    } finally {
      await other.close();
    }
  });
}

// CD-05.R-4's reproducer, pasted unchanged from
// docs/implementation/2026-09-21-core-agent-client-review-r4.md.
test('CD05-R-12: a queued Discard cannot reload a scope the person left', async ({
  page,
  context,
}) => {
  const b = await reviewProject(page, 'R12 B');
  const a = await reviewProject(page, 'R12 A');
  const text = 'Uncertain R12 A';
  const pattern = '**/api/projects/*/threads/*/messages';
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await say(page, text);
  await expect(strip(page)).toContainText(text);
  await page.unroute(pattern);
  const state = await api<ProjectState>(`/projects/${a.id}/state`);
  const thread = state.conversations.find((item) => item.name === 'Diomedes')!;
  const suffix = `${encodeURIComponent(a.id)}|${encodeURIComponent(thread.id)}`;
  const lock = `diomedes.conversation.send.${suffix}`;
  const claim = `diomedes.conversation.claim.${suffix}`;
  const other = await context.newPage();
  try {
    await open(other);
    await other.evaluate(async (name) => {
      const holder = window as typeof window & { releaseR12?: () => void };
      await new Promise<void>((acquired, reject) => {
        void navigator.locks.request(name, async () => {
          await new Promise<void>((release) => {
            holder.releaseR12 = release;
            acquired();
          });
        }).catch(reject);
      });
    }, lock);
    await strip(page).getByRole('button', { name: 'Discard', exact: true }).click();
    await expect.poll(() => other.evaluate(async (name) => {
      const snapshot = await navigator.locks.query();
      return snapshot.pending?.some((entry) => entry.name === name) ?? false;
    }, lock)).toBe(true);

    await page.getByRole('combobox', { name: 'In' }).selectOption(b.id);
    await expect(answers(page).last()).toHaveText('You said: Warm R12 B');
    await painted(page);
    const obsoleteReads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' &&
          request.url().endsWith(`/projects/${a.id}/state`)) {
        obsoleteReads.push(request.url());
      }
    });

    await other.evaluate(() => {
      (window as typeof window & { releaseR12?: () => void }).releaseR12?.();
    });
    // A barrier behind Discard, followed by rendering turns for its continuation.
    await page.evaluate(async (name) => {
      await navigator.locks.request(name, async () => undefined);
    }, lock);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), claim))
      .toBeNull();
    await painted(page);

    // Candidate starts load(A) here even though the person is now in B.
    expect(obsoleteReads).toEqual([]);
    await expect(page.getByRole('combobox', { name: 'In' })).toHaveValue(b.id);
    await expect(answers(page).last()).toHaveText('You said: Warm R12 B');
  } finally {
    await other.evaluate(() => {
      (window as typeof window & { releaseR12?: () => void }).releaseR12?.();
    }).catch(() => undefined);
    await other.close();
  }
});

/**
 * A project with one message sent and never confirmed, and another window holding that
 * conversation's lock the way a send there would. Discard pressed now waits behind it.
 */
async function queuedDiscard(page: Page, other: Page, name: string) {
  const a = await reviewProject(page, name);
  const text = `Uncertain ${name}`;
  const pattern = '**/api/projects/*/threads/*/messages';
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await say(page, text);
  await expect(strip(page)).toContainText(text);
  await page.unroute(pattern);
  const state = await api<ProjectState>(`/projects/${a.id}/state`);
  const thread = state.conversations.find((item) => item.name === 'Diomedes')!;
  const suffix = `${encodeURIComponent(a.id)}|${encodeURIComponent(thread.id)}`;
  const lock = `diomedes.conversation.send.${suffix}`;
  const claim = `diomedes.conversation.claim.${suffix}`;
  await open(other);
  await other.evaluate(async (held) => {
    const holder = window as typeof window & { releaseR12c?: () => void };
    await new Promise<void>((acquired, reject) => {
      void navigator.locks
        .request(held, async () => {
          await new Promise<void>((release) => {
            holder.releaseR12c = release;
            acquired();
          });
        })
        .catch(reject);
    });
  }, lock);
  await strip(page).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect
    .poll(() =>
      other.evaluate(async (held) => {
        const snapshot = await navigator.locks.query();
        return snapshot.pending?.some((entry) => entry.name === held) ?? false;
      }, lock),
    )
    .toBe(true);
  return {
    a,
    text,
    claim,
    /** Lets the lock go, and returns once the Discard behind it has run and the page has settled. */
    release: async () => {
      await other.evaluate(() => {
        (window as typeof window & { releaseR12c?: () => void }).releaseR12c?.();
      });
      await page.evaluate(async (held) => {
        await navigator.locks.request(held, async () => undefined);
      }, lock);
      await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), claim)).toBeNull();
      await painted(page);
    },
  };
}

test('CD05-R-12 closure: an old Discard settling does not stop a delivery somewhere else', async ({
  page,
  context,
}) => {
  const b = await reviewProject(page, 'R12c B');
  const other = await context.newPage();
  const sent = gate();
  // The route and its handler live outside the try so the finally can unroute however the try
  // exits. The handler stays registered through the assertions: with the one-shot form the
  // transcript read that follows the send was repeatedly observed stalling adjacent to the
  // route teardown at fulfillment (CD05-R-13). Only the first POST is gated; other requests
  // continue, and further POSTs are still counted so a resend or stray post is observed.
  const messages = '**/api/projects/*/threads/*/messages';
  let posts = 0;
  const gateFirstPost = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1;
    if (posts !== 1) return route.continue();
    const response = await route.fetch();
    sent.reached();
    await sent.held;
    await route.fulfill({ response });
  };
  try {
    const queued = await queuedDiscard(page, other, 'R12c A');
    const scope = page.getByRole('combobox', { name: 'In' });
    await scope.selectOption(b.id);
    await expect(answers(page).last()).toHaveText('You said: Warm R12c B');
    // A message in B whose reply is held open, so its delivery is running when Discard settles.
    await page.route(messages, gateFirstPost);
    await say(page, 'Running R12c B');
    await sent.recorded;
    await queued.release();
    // The message in A was given up all the same. B's delivery was not stopped for it.
    await expect(page.locator('.dio-pending')).toHaveCount(1);
    sent.release();
    await expect(answers(page).last()).toHaveText('You said: Running R12c B');
    await expect(scope).toHaveValue(b.id);
    await expect(strip(page)).toHaveCount(0);
    await expect(page.locator('.dio-notice')).toHaveCount(0);
    expect(posts).toBe(1);
    expect(await said(b.id, 'Running R12c B')).toBe(1);
  } finally {
    sent.release();
    await page.unroute(messages, gateFirstPost);
    await other
      .evaluate(() => (window as typeof window & { releaseR12c?: () => void }).releaseR12c?.())
      .catch(() => undefined);
    await other.close();
  }
});

test('CD05-R-12 closure: leaving and coming back is a new visit, and the old Discard does not reload it', async ({
  page,
  context,
}) => {
  const b = await reviewProject(page, 'R12d B');
  const other = await context.newPage();
  try {
    const queued = await queuedDiscard(page, other, 'R12d A');
    const scope = page.getByRole('combobox', { name: 'In' });
    await scope.selectOption(b.id);
    await expect(answers(page).last()).toHaveText('You said: Warm R12d B');
    await scope.selectOption(queued.a.id);
    // Still claimed, so this visit offers it too.
    await expect(strip(page)).toContainText(queued.text);
    await painted(page);
    const reads: string[] = [];
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().endsWith(`/projects/${queued.a.id}/state`))
        reads.push(request.url());
      if (messagePost(request)) posts.push(request.url());
    });
    await queued.release();
    // Same project, a different visit: the scope id alone would have let the old one through.
    expect(reads).toEqual([]);
    // What this visit still shows is given up already. Its own Discard finds that out by
    // reading again, and nothing is sent.
    await strip(page).getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(strip(page)).toHaveCount(0);
    expect(posts).toEqual([]);
    await expect(scope).toHaveValue(queued.a.id);
  } finally {
    await other
      .evaluate(() => (window as typeof window & { releaseR12c?: () => void }).releaseR12c?.())
      .catch(() => undefined);
    await other.close();
  }
});

test('CD05-R-12 closure: a Discard that fails says so where it was pressed, and nowhere else', async ({
  page,
}) => {
  const b = await reviewProject(page, 'R12e B');
  const a = await reviewProject(page, 'R12e A');
  const pattern = '**/api/projects/*/threads/*/messages';
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await say(page, 'Uncertain R12e A');
  await expect(strip(page)).toContainText('Uncertain R12e A');
  await page.unroute(pattern);
  // The next lock request waits until the test fails it; every one after it is the browser's own.
  const failNext = () =>
    page.evaluate(() => {
      const holder = window as typeof window & { failR12e?: () => void };
      Object.defineProperty(navigator.locks, 'request', {
        configurable: true,
        value: () =>
          new Promise((_resolve, reject) => {
            delete (navigator.locks as unknown as { request?: unknown }).request;
            holder.failR12e = () => reject(new Error('The lock manager failed R12e'));
          }),
      });
    });
  const fail = () =>
    page.evaluate(() => (window as typeof window & { failR12e?: () => void }).failR12e?.());
  const notice = page.locator('.dio-notice', { hasText: 'The lock manager failed R12e' });

  // Pressed and failed in the same visit: the person is told.
  await failNext();
  await strip(page).getByRole('button', { name: 'Discard', exact: true }).click();
  await fail();
  await expect(notice).toHaveCount(1);

  // Pressed, then the person leaves, then it fails: nothing about it is said in B.
  await failNext();
  await strip(page).getByRole('button', { name: 'Discard', exact: true }).click();
  const scope = page.getByRole('combobox', { name: 'In' });
  await scope.selectOption(b.id);
  await expect(answers(page).last()).toHaveText('You said: Warm R12e B');
  await fail();
  await painted(page);
  await expect(page.locator('.dio-notice')).toHaveCount(0);
  await expect(scope).toHaveValue(b.id);
  // Nothing was given up: the message is still offered where it belongs.
  await scope.selectOption(a.id);
  await expect(strip(page)).toContainText('Uncertain R12e A');
});
