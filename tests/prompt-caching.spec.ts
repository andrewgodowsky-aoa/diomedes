import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { testOnlySecretBox } from '../server/connection-secrets';
import { EngineService } from '../server/engines/service';
import type { ContextAccount } from '../shared/context-accounting';
import { KIMI_K3_MODEL_CARD } from '../shared/declared-capabilities';
import type { Conversation, Project, ProjectState, Turn } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';
import { routeCheckProvider } from './fixtures/route-check-provider';

/**
 * DIO-215: the Prompt caching control in AI setup, against a real host with protected storage.
 * AWS is connected with Kimi K3 and Azure with two deployments the way an owner does both, and
 * the route checks run from the card's own button against a scripted provider at the HTTPS
 * boundary: nothing reaches AWS or Azure. The control shows the three settings, each capability
 * fact with its source, and the newest route check's verdict on caching off, and the owner's
 * choice is saved through its own route. The Console's context view shows a turn's cache note.
 * It serves the built bundle, so it refuses a stale one.
 */
test.describe.configure({ mode: 'serial' });

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const K3 = 'us.moonshotai.kimi-k3';
const rates = { inputUsdPerMillion: 2, outputUsdPerMillion: 12, cacheReadUsdPerMillion: 0.2, cacheWriteUsdPerMillion: null, source: 'the provider price page, read by the test owner' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let pageErrors: string[] = [];
const net = routeCheckProvider('chat', K3);

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`Prompt caching fixture request ${route} failed (${response.status}): ${await response.text()}`);
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
  expect(built, `dist is older than ${newestPath}, so this spec would test the previous build. Run "npm run build" first.`).toBeGreaterThan(newest);
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'prompt-caching-'));
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
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    // The provider cards sit under Advanced only for the host's owner.
    ownerRoutes: true,
    modelApiTransport: ((input: RequestInfo | URL, init?: RequestInit) => net.fetch(input, init)) as typeof globalThis.fetch,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  await expectFreshBundle(dist);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', application);
  // Past first-run setup, with the model-API cards shown, then each route connected as the owner does it.
  await api('/settings', 'PUT', {
    detail: 'technical',
    onboarding: { work: 'business', detail: 'technical', familiarity: 'comfortable', resumeAt: 'done', completedAt: new Date().toISOString() },
  });
  await api('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: K3,
    apiKey: 'test-only-bedrock-key-0123456789abcdef-never-real',
    expiresAt: null,
    consent: true,
  });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 5, consent: true });
  await api('/ai/model-api/azure-openai', 'PUT', {
    resourceName: 'contoso-ai',
    deployments: [
      { model: 'gpt-6.1-sol', deployment: 'sol-prod', reasoning: true, rates },
      { model: 'gpt-6-mini', deployment: 'mini-prod', reasoning: false, rates },
    ],
    apiKey: 'test-only-azure-key-0123456789abcdef-never-real',
    expiresAt: null,
    consent: true,
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

async function openCard(page: Page, name: string) {
  await page.goto(baseURL);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^(Engines|Helpers on this computer)$/ }).click();
  const advanced = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Advanced: provider accounts and routing' }) });
  await advanced.locator(':scope > summary').click();
  const card = page.getByRole('region', { name, exact: true });
  await expect(card).toBeVisible();
  return card;
}
const savedPolicy = async (route: string) =>
  (await api<{ services?: Record<string, unknown> }>('/settings')).services?.[`${route}CachePolicy`] ?? null;

test('PC-01: AWS shows the three settings, the model card’s facts with their source, and saves the owner’s choice', async ({ page }) => {
  const card = await openCard(page, 'AWS Bedrock (Kimi K3)');
  const block = card.locator('.ai-prompt-caching');
  await expect(block.getByRole('heading', { name: 'Prompt caching' })).toBeVisible();
  const group = block.getByRole('radiogroup', { name: 'Prompt caching' });
  await expect(group.getByRole('radio')).toHaveCount(3);
  await expect(group.getByRole('radio', { name: /Provider default/ })).toBeChecked();
  await expect(group.getByRole('radio', { name: /^Off/ })).not.toBeChecked();
  await expect(group.getByRole('radio', { name: /Explicit prefix/ })).not.toBeChecked();
  await expect(block).toContainText('Every call is sent with store set to false, so the provider keeps no response object. That is not the same as caching off.');

  const facts = block.getByRole('region', { name: `What ${K3} can do` });
  await expect(facts.locator('[data-fact="context"]')).toContainText('1,000,000 tokens');
  await expect(facts.locator('[data-fact="context"]')).toContainText(`Declared. ${KIMI_K3_MODEL_CARD}`);
  await expect(facts.locator('[data-fact="minimum"]')).toContainText('1,024 tokens');
  await expect(facts.locator('[data-fact="explicit"]')).toHaveAttribute('data-source', 'declared');
  // What the model card does not state is not known, and says so.
  for (const id of ['output', 'parallel', 'reasoning']) {
    await expect(facts.locator(`[data-fact="${id}"]`)).toHaveAttribute('data-source', 'not-known');
    await expect(facts.locator(`[data-fact="${id}"] .ai-state-value`)).toHaveText('Not known');
  }
  await expect(facts.locator('[data-fact="parallel"]')).toContainText('This build sends one tool call at a time.');
  await expect(facts.locator('[data-fact="structured"]')).toContainText('This build asks for text answers only.');
  await expect(facts.locator('[data-verdict="off"]')).toHaveText('No current route check has tried caching off on this connection.');

  await group.getByRole('radio', { name: /^Off/ }).click();
  await expect(group.getByRole('radio', { name: /^Off/ })).toBeChecked();
  await expect.poll(() => savedPolicy('aws-bedrock')).toBe('off');
  await expect(facts.locator('.ai-cache-preview')).toHaveText('Caching is set to off. No route check on this connection has confirmed it yet.');

  // The choice is read back from the host on a fresh load.
  const again = await openCard(page, 'AWS Bedrock (Kimi K3)');
  await expect(again.locator('.ai-prompt-caching').getByRole('radio', { name: /^Off/ })).toBeChecked();
});

test('PC-02: route checks run from the card confirm caching off and fill in what they observed', async ({ page }) => {
  const card = await openCard(page, 'AWS Bedrock (Kimi K3)');
  await card.getByRole('button', { name: 'Run route checks' }).click();
  const facts = card.locator('.ai-prompt-caching').getByRole('region', { name: `What ${K3} can do` });
  await expect(facts.locator('[data-verdict="off"]')).toHaveText(
    'Caching off is confirmed. The newest route check saw no cache reads or writes with it.',
  );
  await expect(facts.locator('[data-fact="tools"]')).toHaveAttribute('data-source', 'observed');
  await expect(facts.locator('[data-fact="tools"]')).toContainText(/Observed by a route check\. Route check rq_[a-z0-9]+, /);
  await expect(facts.locator('.ai-cache-preview')).toHaveText(
    'Caching is off. A route check on this connection saw no cache reads or writes with this setting.',
  );
  // The window stays the model card's: no route check measures it.
  await expect(facts.locator('[data-fact="context"]')).toHaveAttribute('data-source', 'declared');
  expect(net.seen.filter((call) => call.kind === 'cache-off').map((call) => call.body.prompt_cache_options)).toEqual([
    { mode: 'explicit' },
    { mode: 'explicit' },
  ]);
});

test('PC-03: Azure shows one block per deployment, with nothing declared, and saves its own setting', async ({ page }) => {
  const card = await openCard(page, 'Azure OpenAI');
  const block = card.locator('.ai-prompt-caching');
  await expect(block.getByRole('region', { name: 'What gpt-6.1-sol (sol-prod) can do' })).toBeVisible();
  const mini = block.getByRole('region', { name: 'What gpt-6-mini (mini-prod) can do' });
  await expect(mini.locator('[data-fact="context"]')).toHaveAttribute('data-source', 'not-known');
  await expect(mini.locator('[data-fact="context"]')).toContainText('Not known. No cited source or route check states the context window.');
  await block.getByRole('radio', { name: /Explicit prefix/ }).click();
  await expect.poll(() => savedPolicy('azure-openai')).toBe('explicit-prefix');
  await expect(mini.locator('.ai-cache-preview')).toHaveText(
    'The stable start of the instructions is marked for caching for 30 minutes, under a key kept to this business and route.',
  );
  // Each route keeps its own setting.
  expect(await savedPolicy('aws-bedrock')).toBe('off');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('PC-04: the Console’s context view shows the turn’s cache note', async ({ page }) => {
  const project = await api<Project>('/projects', 'POST', { name: 'Cache note' });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', { name: 'Cache note thread' });
  const note =
    'The stable start of the instructions is marked for caching for 30 minutes, under a key kept to this business and route. The marked start is about 640 tokens, under this model’s minimum of 1,024 tokens for a cache checkpoint, so it is too short to be cached.';
  const context: ContextAccount = {
    v: 1,
    route: 'aws-bedrock',
    model: K3,
    estimator: 'utf8-bytes/4',
    window: { tokens: 1_000_000, source: KIMI_K3_MODEL_CARD },
    requestLimitBytes: 200_000,
    sections: [
      { id: 'instructions', bytes: 2_200, estimatedTokens: 550 },
      { id: 'tools', bytes: 360, estimatedTokens: 90 },
      { id: 'message', bytes: 120, estimatedTokens: 30 },
    ],
    estimatedTokens: 670,
    provider: { calls: 1, reportedCalls: 1, inputTokens: 700, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40, firstCallInputTokens: 700 },
    reconciliation: { estimated: 670, reported: 700, difference: 30 },
    stablePrefix: { sha: 'b'.repeat(64), bytes: 2_200, sameAsPrevious: null },
    cache: { support: 'automatic-prefix', policy: 'explicit-prefix', offVerified: null, marked: 'stable-prefix', note },
    history: null,
    compaction: null,
  };
  const turn = (id: string, role: Turn['role'], text: string, extra: Partial<Turn> = {}): Turn => ({
    id,
    role,
    mode: 'ask',
    text,
    at: '2026-10-05T09:00:00.000Z',
    sources: [],
    route: 'aws-bedrock',
    ...extra,
  });
  await page.route(`**/api/projects/${project.id}/state`, async (route) => {
    const response = await route.fetch();
    const state = (await response.json()) as ProjectState;
    const turns = [
      turn('u-1', 'you', 'Which deliveries arrived short?'),
      turn('a-1', 'assistant', 'Two deliveries arrived short.', { helper: { engine: 'aws-bedrock', model: K3, version: 'fixture', verified: true }, context }),
    ];
    await route.fulfill({
      response,
      json: { ...state, conversations: state.conversations.map((item) => (item.id === thread.id ? { ...item, turns } : item)) },
    });
  });
  await api('/settings', 'PUT', { openProjects: [project.id] });
  await page.goto(baseURL);
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await page.getByRole('navigation', { name: 'Threads and views' }).getByRole('button', { name: /Cache note thread/ }).click();
  await page.locator('.context-line').click();
  const facts = page.getByRole('region', { name: 'Context used' }).locator('.context-facts');
  await expect(facts).toContainText(note);
  await expect(facts).toContainText(`1,000,000 tokens (${KIMI_K3_MODEL_CARD})`);
});
