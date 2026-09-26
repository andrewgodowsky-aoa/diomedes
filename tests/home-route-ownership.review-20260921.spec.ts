import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { testOnlySecretBox } from '../server/connection-secrets';
import type { Store } from '../server/store';
import type { Conversation, ProjectState } from '../shared/types';
import { awsTransport, seen } from './fixtures/scripted-home-luna';
import { gateway, nectoviaAccounts } from './fixtures/nectovia-home';

// Independent route-display counterexamples. The app, Store and HTTP writes are
// real. The provider is fake; the first test delays only an already committed
// PUT response, and the second seeds an unmarked historical thread pin.
//
// The default a conversation migrates to is Nectovia, the company-managed route: the app signs
// the faux seed's Business owner in at start (test mode) and reaches the real account service
// and its real managed gateway, with the scripted provider answering behind the gateway. The
// customer connects nothing, and nothing calls a provider directly.
test.describe.configure({ mode: 'serial' });
const port = Number(process.env.DIOMEDES_ROUTE_REVIEW_PORT ?? 47641);
const baseURL = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let binding: { projectId: string; threadId: string };
let pageErrors: string[] = [];
/**
 * What the caption names a Nectovia conversation by: the route's display name and the label the
 * account service publishes for Efficient (client/console/DiomedesHome.tsx passes
 * `nectovia.tiers.efficient.label`; client/console/Diomedes.tsx `routeName` writes
 * "Nectovia (<label>)"). The faux seed publishes GPT-6 Luna.
 */
const NECTOVIA_CAPTION = 'Nectovia (GPT-6 Luna)';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.ok, `${response.status} ${route}: ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
const threadPath = () => `/projects/${binding.projectId}/threads/${binding.threadId}`;
async function savedThread(): Promise<Conversation> {
  const state = await api<ProjectState>(`/projects/${binding.projectId}/state`);
  return state.conversations.find((value) => value.id === binding.threadId)!;
}
async function open(page: Page) {
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
  // A tier, never a route, is the conversation's model control (owner decision 2026-09-23).
  await expect(page.getByRole('combobox', { name: 'Style' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Route' })).toHaveCount(0);
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

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'home-route-review-'));
  const { accounts } = await nectoviaAccounts(awsTransport);
  app = await createApp({
    dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    port, clientPort: port, reviewerAdapter: null,
    engineService: new EngineService(path.join(root, 'engines'), {
      discover: async () => [],
      version: async () => { throw new Error('No native engine in this fixture'); },
      adapter: () => { throw new Error('No native engine in this fixture'); },
    }),
    secretBox: testOnlySecretBox(),
    // Nectovia reaches its gateway on the account service's own transport; nothing here calls a
    // provider directly.
    modelApiTransport: (async () => {
      throw new Error('No provider is called directly in this spec.');
    }) as typeof globalThis.fetch,
    accounts,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  await expectFreshBundle(dist);
  app.use(express.static(dist));
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });
  await api('/settings', 'PUT', {
    onboarding: {
      work: 'business',
      detail: 'guided',
      familiarity: 'new',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
  binding = await api('/home/conversation', 'POST', {});
});

test.afterEach(async () => {
  await app?.locals.close?.();
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });
  server = undefined;
  expect(pageErrors).toEqual([]);
});

test('HLR-02: a migrated conversation names the route serving its pending message', async ({ page }) => {
  const store = app.locals.store as Store;
  const state = store.state(binding.projectId);
  const historical = state.conversations.find((value) => value.id === binding.threadId)!;
  historical.engine = 'claude-code';
  delete (historical as { engineChoice?: string }).engineChoice;
  await store.persist(state);
  await open(page);
  await expect(page.locator('.instr')).toContainText('Claude Code');
  const callsBefore = seen.length;
  const gatewayBefore = gateway.length;
  const composer = page.getByRole('textbox', { name: 'Message Nectovia' });
  try {
    await composer.fill('SLOW migration route review');
    await composer.press('Enter');
    // The migrated send went to Nectovia's gateway, which put it on the wire to the provider,
    // where SLOW holds it: the message is still pending while the display is read.
    await expect.poll(() => seen.length).toBeGreaterThan(callsBefore);
    expect(gateway.length).toBeGreaterThan(gatewayBefore);
    expect((await savedThread()).engine).toBe('nectovia');
    await expect(page.locator('.dio-pending')).toBeVisible();
    await expect(page.locator('.instr')).toContainText(NECTOVIA_CAPTION);
    await expect(page.locator('.instr')).not.toContainText('Claude Code');
  } finally {
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    if (await stop.isVisible()) await stop.click();
  }
});
