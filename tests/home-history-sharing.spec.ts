import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Store } from '../server/store';
import { testOnlySecretBox } from '../server/connection-secrets';
import type { Conversation, Project, ProjectState, Route } from '../shared/types';
import { SCRIPTED_MODEL, scriptedEngineService } from './fixtures/scripted-conversation';
import { AWS_CONNECT_BODY, awsTransport, seen } from './fixtures/scripted-home-luna';

// The 0.1.8 fix, end to end in a real browser: the All projects conversation on the Nectovia page
// can share its earlier messages. Home's typed messages need no grant, and its history stays gated
// (owner rule, 2026-09-23); the page now says when history is off and lets the person grant it
// per route through the existing Cloud sharing endpoint. The real Store, Runtime, both drivers
// and both admissions run; only the providers are scripted: Claude Code by the session fixture,
// AWS Bedrock at the HTTPS boundary. It serves the built bundle, so it refuses a stale one.
//
// Each test sets the conversation up itself, through the API, so it proves its own point in any
// order and after a worker restart.

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let pageErrors: string[] = [];
let sent = 0;

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(
      `Home history fixture request ${route} failed (${response.status}): ${await response.text()}`,
    );
  return (await response.json()) as T;
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

type Binding = { projectId: string; threadId: string };
interface Sharing {
  version: number;
  routes: string[];
  documents: string[];
  shareConversationHistory: boolean;
  shareReviewPackets: boolean;
}
const sharingPath = (bound: Binding) => `/projects/${bound.projectId}/cloud-sharing`;
const threadPath = (bound: Binding) => `/projects/${bound.projectId}/threads/${bound.threadId}`;
const sharing = (bound: Binding) => api<Sharing>(sharingPath(bound));

/**
 * Home on the given route, with at least one answered exchange and exactly `routes` sharing its
 * history, the way a person could have left it. Provisioning finds the same Home every time.
 */
async function homeWith(engine: 'aws-bedrock' | 'claude-code', routes: string[]): Promise<Binding> {
  const bound = await api<Binding>('/home/conversation', 'POST', {});
  await api<Conversation>(threadPath(bound), 'PUT', { engine: 'aws-bedrock' });
  const state = await api<ProjectState>(`/projects/${bound.projectId}/state`);
  const turns = state.conversations.find((item) => item.id === bound.threadId)?.turns ?? [];
  if (!turns.some((turn, index) => turn.role === 'you' && turns[index + 1]?.role === 'assistant'))
    await api(`${threadPath(bound)}/messages`, 'POST', {
      commandId: `m-setup-${++sent}`,
      text: 'Good morning',
      mode: 'auto',
      sources: [],
      consent: true,
    });
  const current = await sharing(bound);
  await api(sharingPath(bound), 'PUT', {
    expectedVersion: current.version,
    routes,
    documents: [],
    shareConversationHistory: routes.length > 0,
    shareReviewPackets: false,
  });
  if (engine !== 'aws-bedrock') await api<Conversation>(threadPath(bound), 'PUT', { engine });
  return bound;
}
/** Write the Home thread's route straight into its record: the one route no request can set. */
async function writeEngine(bound: Binding, engine: Route) {
  const store = application!.locals.store as Store;
  const state = store.state(bound.projectId);
  state.conversations.find((item) => item.id === bound.threadId)!.engine = engine;
  await store.persist(state);
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Nectovia' });
const answers = (page: Page) => page.locator('.turn.dio .body');
/** The plain line near the composer, and its sentence. */
const line = (page: Page) => page.locator('.dio-history');
const sentence = (page: Page) => line(page).locator('p');
/** Home's Cloud sharing, in the strip's right cluster where a project's sits in its Console. */
const stripControl = (page: Page) =>
  page.locator('header.top').getByRole('button', { name: 'Cloud sharing', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Cloud sharing' });
/** What the last AWS call carried, whole. */
const lastCall = () => JSON.stringify(seen.at(-1)!.body);

const AWS_LINE = "Earlier messages aren't shared with AWS Bedrock, so each answer stands alone.";
const CLAUDE_LINE =
  "Earlier messages aren't shared with Claude Code, so it can't answer a follow-up.";

async function open(page: Page) {
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
}
async function say(page: Page, text: string) {
  await expect(page.locator('.dio-pending')).toHaveCount(0);
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'home-history-'));
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  baseURL = `http://127.0.0.1:${port}`;
  application = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    port,
    clientPort: port,
    engineService: scriptedEngineService(path.join(root, 'engines'), root),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: awsTransport,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  await expectFreshBundle(dist);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server.on('request', application);
  // Claude Code is checked and selected, and AWS connected and spend-approved, the way a person
  // does both. Home is provisioned on AWS Bedrock, the conversation default.
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/claude-code', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'claude-code', model: SCRIPTED_MODEL });
  await api('/ai/model-api/aws-bedrock', 'PUT', AWS_CONNECT_BODY);
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  await api('/settings', 'PUT', {
    onboarding: {
      work: 'business',
      detail: 'guided',
      familiarity: 'new',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
});

test.afterAll(async () => {
  await application?.locals.close?.();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test('with history off the line shows after an exchange, and its button leads to the grant', async ({
  page,
}) => {
  const bound = await homeWith('aws-bedrock', []);
  await open(page);
  await expect(sentence(page)).toHaveText(AWS_LINE);
  await expect(stripControl(page)).toBeVisible();
  // The line is information, not a failure: the page's alert and notice stay empty.
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.dio-notice')).toHaveCount(0);

  const before = await sharing(bound);
  await line(page).getByRole('button', { name: 'Share earlier messages' }).click();
  await expect(dialog(page)).toBeVisible();
  const box = dialog(page).getByRole('checkbox', {
    name: 'Share earlier messages with AWS Bedrock',
  });
  // The box shows what is true now. Opening the control granted nothing.
  await expect(box).not.toBeChecked();
  expect(await sharing(bound)).toEqual(before);
  await box.check();
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(line(page)).toHaveCount(0);
  expect(await sharing(bound)).toEqual({
    version: before.version + 1,
    routes: ['aws-bedrock'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });

  // The next message carries the earlier exchange.
  await say(page, 'And tomorrow?');
  await expect(answers(page).last()).toHaveText('You said: And tomorrow?');
  expect(lastCall()).toContain('Earlier in this conversation');
  expect(lastCall()).toContain('Good morning');

  // Once shared, a fresh visit shows no line either.
  await page.reload();
  await expect(answers(page).last()).toHaveText('You said: And tomorrow?');
  await expect(line(page)).toHaveCount(0);
});

test("the strip's Cloud sharing takes the grant back, and the line returns", async ({ page }) => {
  const bound = await homeWith('aws-bedrock', ['aws-bedrock']);
  await open(page);
  await expect(answers(page).last()).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await stripControl(page).click();
  const box = dialog(page).getByRole('checkbox', {
    name: 'Share earlier messages with AWS Bedrock',
  });
  await expect(box).toBeChecked();
  // Home shares no documents and no review packets, so history is the only choice offered.
  await expect(dialog(page).getByRole('checkbox')).toHaveCount(1);
  await box.uncheck();
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(sentence(page)).toHaveText(AWS_LINE);
  expect(await sharing(bound)).toMatchObject({
    routes: [],
    documents: [],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });

  await say(page, 'Alone again?');
  await expect(answers(page).last()).toHaveText('You said: Alone again?');
  expect(lastCall()).not.toContain('Earlier in this conversation');
  expect(lastCall()).not.toContain('Good morning');
});

test('a project scope keeps its own sharing: no Home control and no line there', async ({
  page,
}) => {
  await homeWith('aws-bedrock', []);
  const project = await api<Project>('/projects', 'POST', { name: `Linen service ${++sent}` });
  await open(page);
  await expect(sentence(page)).toHaveText(AWS_LINE);
  await expect(stripControl(page)).toBeVisible();
  const scope = page.getByRole('combobox', { name: 'In' });
  await scope.selectOption({ label: project.name });
  await expect(scope).toHaveValue(project.id);
  await expect(line(page)).toHaveCount(0);
  await expect(stripControl(page)).toHaveCount(0);
  await scope.selectOption({ label: 'All projects' });
  await expect(sentence(page)).toHaveText(AWS_LINE);
  await expect(stripControl(page)).toBeVisible();
});

test('the line never shows on the sample route', async ({ page }) => {
  const bound = await homeWith('aws-bedrock', []);
  await writeEngine(bound, 'sample');
  try {
    await open(page);
    await expect(page.locator('.instr')).toContainText('Sample');
    await expect(answers(page).last()).toBeVisible();
    await expect(line(page)).toHaveCount(0);
  } finally {
    await writeEngine(bound, 'aws-bedrock');
  }
});

test('on Claude Code the line is there before sending, and a refused follow-up offers the same fix', async ({
  page,
}) => {
  const bound = await homeWith('claude-code', []);
  try {
    await open(page);
    await expect(page.locator('.instr')).toContainText('Claude Code');
    await expect(sentence(page)).toHaveText(CLAUDE_LINE);

    await say(page, 'Hello Claude');
    await expect(answers(page).last()).toHaveText('You said: Hello Claude');
    await expect(sentence(page)).toHaveText(CLAUDE_LINE);

    // Sent anyway: refused before anything is dispatched, the words given back, and the refusal
    // says the same sentence once, with the same button.
    await say(page, 'And then?');
    const notice = page.locator('.dio-notice');
    await expect(notice).toContainText(CLAUDE_LINE);
    await expect(composer(page)).toHaveValue('And then?');
    await expect(line(page)).toHaveCount(0);
    await notice.getByRole('button', { name: 'Share earlier messages' }).click();
    const box = dialog(page).getByRole('checkbox', {
      name: 'Share earlier messages with Claude Code',
    });
    await expect(box).not.toBeChecked();
    await box.check();
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    await expect(line(page)).toHaveCount(0);
    expect(await sharing(bound)).toMatchObject({
      routes: ['claude-code'],
      shareConversationHistory: true,
    });

    await composer(page).press('Enter');
    await expect(answers(page).last()).toHaveText('You said: And then?');
  } finally {
    await api<Conversation>(threadPath(bound), 'PUT', { engine: 'aws-bedrock' });
  }
});
