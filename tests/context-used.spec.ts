import { test, expect, type Page } from '@playwright/test';
import type { Conversation, Project, ProjectState, Settings, Turn } from '../shared/types';
import type { ContextAccount } from '../shared/context-accounting';
import { reopenLastProject } from './fixtures/landing';

/**
 * H18: an answer on a model-API route carries a "Context used" line that opens what went into its
 * context: each section with Diomedes' estimate, what the provider reported, the stable prefix
 * and, where the history passed its budget, which messages were left out and what was summarised.
 *
 * The host and the thread are real. The one thing injected is the recorded turns with their
 * context account, because only a provider turn writes one and this suite has no provider. The
 * account has exactly the shape `reconcileContext` records.
 */

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const MODEL = 'us.openai.gpt-5.6-luna-with-a-deliberately-long-deployment-name-for-truncation';
const PREFIX = 'f'.repeat(12) + 'a'.repeat(52);
let originalSettings: Settings | null = null;
let projectId = '';
let threadId = '';
let pageErrors: string[] = [];

const account: ContextAccount = {
  v: 1,
  route: 'aws-bedrock',
  model: MODEL,
  estimator: 'utf8-bytes/4',
  window: { tokens: null, source: 'not declared' },
  requestLimitBytes: 200_000,
  sections: [
    { id: 'instructions', bytes: 4_000, estimatedTokens: 1_000 },
    { id: 'answer-format', bytes: 1_600, estimatedTokens: 400 },
    { id: 'tools', bytes: 800, estimatedTokens: 200 },
    { id: 'project-files', bytes: 120, estimatedTokens: 30, detail: '1 attached, read through tools' },
    { id: 'history', bytes: 20_000, estimatedTokens: 5_000, detail: '12 of 14 earlier messages, 2 summarised' },
    { id: 'message', bytes: 200, estimatedTokens: 50 },
    { id: 'tool-results', bytes: 400, estimatedTokens: 100, detail: '1 tool call, sent back on later calls' },
  ],
  estimatedTokens: 6_680,
  provider: {
    calls: 2,
    reportedCalls: 2,
    inputTokens: 13_500,
    cacheReadTokens: 5_900,
    cacheWriteTokens: 0,
    outputTokens: 420,
    firstCallInputTokens: 6_500,
  },
  reconciliation: { estimated: 6_680, reported: 6_500, difference: -180 },
  stablePrefix: { sha: PREFIX, bytes: 5_600, sameAsPrevious: true },
  cache: {
    support: 'automatic-prefix',
    note: 'Any reuse is the provider’s own automatic prefix caching. Diomedes sends the stable prefix first and no cache directive, and records the cached input tokens the provider reports.',
  },
  history: {
    method: 'recency+lexical/1',
    budget: { turns: 12, chars: 24_000 },
    available: 14,
    included: [1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((index) => ({
      runId: 'model-run',
      stepId: `turn:${index}`,
      index,
      reason: index === 1 ? 'pinned' : index === 2 ? 'relevant' : index >= 9 ? 'recent' : 'fits',
    })),
    omitted: [3, 4].map((index) => ({ runId: 'model-run', stepId: `turn:${index}`, index, carried: false })),
    marker: '[Diomedes left out 2 earlier messages (3–4) to fit this conversation’s history budget.]',
    cutChars: 0,
  },
  compaction: {
    v: 1,
    id: 'c'.repeat(64),
    kind: 'summary',
    method: 'extract-first-sentence/1',
    author: 'diomedes-application',
    turns: [3, 4].map((index) => ({ runId: 'model-run', stepId: `turn:${index}`, index, promptSha: 'd'.repeat(64), answerSha: 'e'.repeat(64) })),
    text: 'Summary of the earlier messages left out, extracted by Diomedes from the first sentence of each side (no model wrote it; the full messages stay in this conversation’s History):\n- Message 3: the person asked “How many chairs for table 3?”; Diomedes answered “Eight chairs.”\n- Message 4: the person asked “How many chairs for table 4?”; Diomedes answered “Six chairs.”',
    bytes: 320,
  },
};

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});

test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test.beforeAll(async ({ request }) => {
  originalSettings = (await (await request.get('/api/settings')).json()) as Settings;
  expect(
    (
      await request.put('/api/settings', {
        headers: HEADERS,
        data: {
          onboarding: { resumeAt: 'done', work: 'business', detail: 'guided', familiarity: 'comfortable' },
          detail: 'guided',
        },
      })
    ).ok(),
  ).toBe(true);
  const created = await request.post('/api/projects', { headers: HEADERS, data: { name: 'Context used' } });
  expect(created.ok()).toBe(true);
  projectId = ((await created.json()) as Project).id;
  const thread = await request.post(`/api/projects/${projectId}/threads`, {
    headers: HEADERS,
    data: { name: 'Staff lunch thread' },
  });
  expect(thread.ok()).toBe(true);
  threadId = ((await thread.json()) as Conversation).id;
});

test.afterAll(async ({ request }) => {
  expect(originalSettings).toBeTruthy();
  const restore = await request.put('/api/settings', {
    headers: HEADERS,
    data: JSON.parse(JSON.stringify(originalSettings)),
  });
  expect(restore.ok()).toBe(true);
});

const turn = (id: string, role: Turn['role'], text: string, at: string, extra: Partial<Turn> = {}): Turn => ({
  id,
  role,
  mode: 'ask',
  text,
  at,
  sources: [],
  route: 'aws-bedrock',
  ...extra,
});

/** The thread's recorded turns: two answered on AWS with their accounts, one by an external engine. */
async function withRecordedTurns(page: Page) {
  await page.route(`**/api/projects/${projectId}/state`, async (route) => {
    const response = await route.fetch();
    const state = (await response.json()) as ProjectState;
    const helper = { engine: 'aws-bedrock', model: MODEL, version: 'fixture', verified: true };
    const turns: Turn[] = [
      turn('u-3', 'you', 'How many chairs for table 3?', '2026-09-24T01:00:00.000Z'),
      turn('a-3', 'assistant', 'Eight chairs.', '2026-09-24T01:00:05.000Z', { helper }),
      turn('u-15', 'you', 'Has the Harbor Supply invoice been paid yet?', '2026-09-24T01:10:00.000Z'),
      turn('a-15', 'assistant', 'Not yet; it is due Friday.', '2026-09-24T01:10:05.000Z', { helper, context: account }),
      turn('u-16', 'you', 'Thanks. Summarise the week.', '2026-09-24T01:20:00.000Z', { route: 'codex' }),
      turn('a-16', 'assistant', 'Codex answered this one.', '2026-09-24T01:20:05.000Z', {
        route: 'codex',
        helper: { engine: 'codex', model: 'gpt-6-astra', verified: true },
      }),
    ];
    await route.fulfill({
      response,
      json: {
        ...state,
        conversations: state.conversations.map((item) => (item.id === threadId ? { ...item, turns } : item)),
      },
    });
  });
}

async function openThread(page: Page) {
  expect(
    (await page.request.put('/api/settings', { headers: HEADERS, data: { openProjects: [projectId] } })).ok(),
  ).toBe(true);
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Threads and views' })
    .getByRole('button', { name: /Staff lunch thread/ })
    .click();
}

test('H18-UI-01: the line says what the answer used, and opens each section with the provider’s numbers', async ({ page }) => {
  await withRecordedTurns(page);
  await openThread(page);
  // Only the answer that recorded an account carries the line: not the earlier one, not Codex's.
  const lines = page.locator('.context-line');
  await expect(lines).toHaveCount(1);
  const line = lines.first();
  await expect(line).toContainText('Context used ·');
  await expect(line).toContainText('~6.7k estimated · 14k reported · 5.9k cached · 2 summarised');
  await expect(line).toHaveAttribute('aria-expanded', 'false');
  await line.click();
  await expect(line).toHaveAttribute('aria-expanded', 'true');

  const panel = page.getByRole('region', { name: 'Context used' });
  await expect(panel).toBeVisible();
  const rows = panel.locator('.context-section');
  expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-section')))).toEqual([
    'instructions',
    'answer-format',
    'tools',
    'project-files',
    'history',
    'message',
    'tool-results',
  ]);
  const history = panel.locator('[data-section="history"]');
  await expect(history.locator('.context-name')).toHaveText('Conversation history');
  await expect(history.locator('.context-num')).toHaveText('~5,000');
  await expect(history.locator('.context-detail')).toHaveText('12 of 14 earlier messages, 2 summarised');
  const facts = panel.locator('.context-facts');
  await expect(facts).toContainText('13,500 input, 5,900 cached, 420 output over 2 calls');
  await expect(facts).toContainText('6,500 reported against 6,680 estimated (-180)');
  await expect(facts).toContainText(`Not declared for ${MODEL}`);
  await expect(facts).toContainText(`${PREFIX.slice(0, 12)} · 5,600 B · same as the previous message`);
  await expect(facts).toContainText('messages 3, 4, summarised.');
});

test('H18-UI-02: what was summarised opens the summary, and the summarised messages stay in the thread', async ({ page }) => {
  await withRecordedTurns(page);
  await openThread(page);
  await page.locator('.context-line').click();
  const panel = page.getByRole('region', { name: 'Context used' });
  const toggle = panel.getByRole('button', { name: /What was summarised/ });
  await expect(panel.locator('.context-summary')).toHaveCount(0);
  await toggle.click();
  await expect(panel.locator('.context-summary')).toContainText('no model wrote it');
  await expect(panel.locator('.context-summary')).toContainText('Message 3: the person asked “How many chairs for table 3?”');
  // Nothing was removed: the summarised exchange is still in the thread as it was.
  await expect(page.locator('.turn.you .body').filter({ hasText: 'How many chairs for table 3?' })).toBeVisible();
  await expect(page.locator('.turn.dio > .body').filter({ hasText: 'Eight chairs.' })).toBeVisible();
});

test('H18-UI-03: a long model name truncates inside the panel instead of widening the page', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await withRecordedTurns(page);
  await openThread(page);
  await page.locator('.context-line').click();
  await expect(page.getByRole('region', { name: 'Context used' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
