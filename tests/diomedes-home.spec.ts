import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import type { Store } from '../server/store';
import type { Project, ProjectState } from '../shared/types';
import { SCRIPTED_MODEL, scriptedEngineService } from './fixtures/scripted-conversation';

// The Diomedes page end to end in a real browser: the real Store, Runtime, session driver and
// both admissions, with only the provider scripted. It never calls a model, uses credentials or
// spends quota. Like native-ui.spec.ts it serves the built bundle, so it refuses a stale one.
test.describe.configure({ mode: 'serial' });

const port = Number(process.env.DIOMEDES_HOME_UI_PORT ?? 47639);
const baseURL = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let project: Project;
let pageErrors: string[] = [];

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
  return response.json() as Promise<T>;
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
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Diomedes' });
const answers = (page: Page) => page.locator('.turn.dio .body');

async function open(page: Page) {
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Diomedes', exact: true })).toBeVisible();
}
async function say(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'diomedes-home-'));
  application = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    port,
    clientPort: port,
    engineService: scriptedEngineService(path.join(root, 'engines'), root),
    reviewerAdapter: null,
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
    surface: 'console',
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
  // provider. The conversation still runs on Claude Code: the page pins its thread to it.
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

  // Automations holds its place in the sidebar and does nothing yet.
  const held = page.getByRole('button', { name: /Automations/ }).first();
  await expect(held).toHaveAttribute('aria-disabled', 'true');
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
  await say(page, 'Good morning');
  await expect(answers(page).last()).toHaveText('You said: Good morning');
  await expect(composer(page)).toHaveValue('');
  await expect(page.locator('.dio-card')).toHaveCount(0);

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
  await expect(card).toContainText('Diomedes can start this in Linen service');

  // Offered, not started: the project is untouched until the person presses Start.
  const offered = await state();
  expect([offered.tasks.length, offered.sessions.length]).toEqual([0, 0]);
  const thread = offered.conversations.find((item) => item.name === 'Diomedes');
  expect([thread?.mode, thread?.engine]).toEqual(['auto', 'claude-code']);

  await card.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(card).toContainText('Started in Linen service');
  const started = await state();
  expect([started.tasks.length, started.sessions.length]).toEqual([1, 1]);

  await card.getByRole('button', { name: 'Open the work', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Project pages', exact: true })).toBeVisible();
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
  await api('/settings', 'PUT', { services: { 'claude-code': false } });
  try {
    await open(page);
    await say(page, 'Are you there?');
    await expect(page.getByRole('alert')).toHaveText(
      'Turn Claude Code on in Settings before sending.',
    );
    await expect(composer(page)).toHaveValue('Are you there?');
    await expect(page.locator('.dio-card')).toHaveCount(0);
  } finally {
    await api('/settings', 'PUT', { services: { 'claude-code': true } });
  }
});
