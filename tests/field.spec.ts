import { test, expect, type Page } from '@playwright/test';
import type { Project, ProjectState, Settings } from '../shared/types';

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const PROJECT_NAME = 'The Console under test';
const READY_TASK = 'File the field notes';
const THREAD_A = 'Alpha thread';
const THREAD_B = 'Beta thread';

let originalSettings: Settings | null = null;
let projectId = '';
let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
});

test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test.beforeAll(async ({ request }) => {
  // Playwright sorts spec files, so this file may run before ui.spec.ts, whose
  // first test needs onboarding still unfinished. Keep the whole settings
  // object and put it back in afterAll.
  const current = await request.get('/api/settings');
  expect(current.ok()).toBe(true);
  originalSettings = (await current.json()) as Settings;
  const setup = await request.put('/api/settings', {
    headers: HEADERS,
    data: {
      onboarding: { resumeAt: 'done', work: 'business', detail: 'technical', familiarity: 'comfortable' },
      surface: 'console',
      detail: 'technical',
    },
  });
  expect(setup.ok()).toBe(true);
  const created = await request.post('/api/projects', { headers: HEADERS, data: { name: PROJECT_NAME } });
  expect(created.ok()).toBe(true);
  projectId = ((await created.json()) as Project).id;
  const task = await request.post(`/api/projects/${projectId}/tasks`, {
    headers: HEADERS,
    data: { name: READY_TASK },
  });
  expect(task.ok()).toBe(true);
  for (const name of [THREAD_A, THREAD_B]) {
    const thread = await request.post(`/api/projects/${projectId}/threads`, {
      headers: HEADERS,
      data: { name },
    });
    expect(thread.ok()).toBe(true);
  }
  const opened = await request.put('/api/settings', {
    headers: HEADERS,
    data: { openProjects: [projectId] },
  });
  expect(opened.ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  expect(originalSettings, 'The settings snapshot must exist so onboarding can be restored').toBeTruthy();
  // JSON round-trip keeps this an untyped payload for the request body.
  const restore = await request.put('/api/settings', {
    headers: HEADERS,
    data: JSON.parse(JSON.stringify(originalSettings)),
  });
  expect(restore.ok()).toBe(true);
});

async function projectState(page: Page): Promise<ProjectState> {
  const response = await page.request.get(`/api/projects/${projectId}/state`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

/** Land on the Console with our project open. The Console reopens the last project. */
async function openConsole(page: Page) {
  const opened = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { surface: 'console', openProjects: [projectId] },
  });
  expect(opened.ok()).toBe(true);
  await page.goto('/');
  const root = page.locator('.console');
  const card = page.getByRole('button', { name: PROJECT_NAME }).first();
  // The app paints once its settings arrive and may reopen the last project then.
  await expect(root.or(card).first()).toBeVisible();
  if ((await root.count()) === 0) {
    await card.click();
    await expect(root).toBeVisible();
  }
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
}

function railOf(page: Page) {
  return page.getByRole('navigation', { name: 'Threads and views' });
}

test('C01: the rail lists threads, carries New, marks the selection, and offers the three views', async ({ page }) => {
  await openConsole(page);
  const rail = railOf(page);
  await expect(rail.getByRole('heading', { name: 'Threads', exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'New', exact: true })).toBeVisible();
  const alpha = rail.getByRole('button', { name: /Alpha thread/ });
  const beta = rail.getByRole('button', { name: /Beta thread/ });
  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Thread', exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: /^Board/ })).toBeVisible();
  await expect(rail.getByRole('button', { name: /^Team/ })).toBeVisible();
  await beta.click();
  // Word boundary: the base class `console-thread` itself contains "on".
  await expect(beta).toHaveClass(/\bon\b/);
  await alpha.click();
  await expect(alpha).toHaveClass(/\bon\b/);
  await expect(beta).not.toHaveClass(/\bon\b/);
});

test('C02: the view switch swaps Thread, Board, and Team', async ({ page }) => {
  await openConsole(page);
  const rail = railOf(page);
  const threadScreen = page.locator('#scrThread');
  await expect(threadScreen).toBeVisible();
  await rail.getByRole('button', { name: /^Board/ }).click();
  await expect(page.locator('.board[aria-label="Board"]')).toBeVisible();
  await expect(threadScreen).toHaveCount(0);
  await rail.getByRole('button', { name: /^Team/ }).click();
  await expect(page.locator('.team[aria-label="Team"]')).toBeVisible();
  await expect(threadScreen).toHaveCount(0);
  await rail.getByRole('button', { name: 'Thread', exact: true }).click();
  await expect(threadScreen).toBeVisible();
});

test('C03: the Board shows the Ready task, and Show-me-first confirms instead of starting', async ({ page }) => {
  await openConsole(page);
  await railOf(page).getByRole('button', { name: /^Board/ }).click();
  const board = page.locator('.board[aria-label="Board"]');
  await expect(board).toBeVisible();
  // The board starts compact, which hides the column captions; expand it first.
  await board.getByRole('button', { name: 'compact', exact: true }).click();
  await expect(board.getByText('Start hands it to its worker', { exact: true })).toBeVisible();
  await expect(board.getByText('waits on you', { exact: true })).toBeVisible();
  // The thread head carries its own "Show me first" radio; scope to the board policy.
  await board.getByRole('radio', { name: 'Show me first', exact: true }).click();
  await expect(board.getByRole('radio', { name: 'Go ahead for tasks', exact: true })).toBeVisible();
  const ready = page.locator('.column[aria-label="Ready"]');
  const row = ready.locator('.crow', { hasText: READY_TASK });
  await expect(row.getByRole('button', { name: READY_TASK })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Start', exact: true }).first()).toBeVisible();
  expect((await projectState(page)).sessions).toHaveLength(0);
  await row.getByRole('button', { name: 'Start', exact: true }).first().click();
  const confirm = row.locator('.confirm');
  await expect(confirm.getByText(/Hand to .*?\?/)).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Not now', exact: true })).toBeVisible();
  // The confirm must not have started a run.
  expect((await projectState(page)).sessions).toHaveLength(0);
  await row.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(confirm).toHaveCount(0);
});

test('C04: the palette finds and filters, Escape closes, and the Workbook keeps its own search', async ({ page }) => {
  await openConsole(page);
  await railOf(page).getByRole('button', { name: 'Thread', exact: true }).click();
  await expect(page.locator('#scrThread')).toBeVisible();
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Find and act' });
  await expect(palette).toBeVisible();
  const find = palette.getByLabel('Find a task, worker, model, project or action');
  await expect(find).toBeVisible();
  await find.fill('field notes');
  await expect(palette.getByText(READY_TASK)).toBeVisible();
  // Nothing pausable exists, so the verb narrows the Ready task away.
  await find.fill('pause');
  await expect(palette.getByText(READY_TASK)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  // The Workbook's own Ctrl+K project search still opens when surface is workbook.
  const toBook = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { surface: 'workbook' },
  });
  expect(toBook.ok()).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'workbook');
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Open a project', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const toConsole = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { surface: 'console' },
  });
  expect(toConsole.ok()).toBe(true);
  await page.reload();
  await expect(page.locator('.console')).toBeVisible();
});

test('C05: the wake is skipped under automation', async ({ page }) => {
  await openConsole(page);
  await expect(page.locator('.console')).toBeVisible();
  expect(await page.evaluate(() => navigator.webdriver)).toBe(true);
  await expect(page.locator('.dm-wake')).toHaveCount(0);
});

test('C06: the Ember scheme applies its package and token, then Field is restored', async ({ page }) => {
  await openConsole(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Appearance package', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Ember', exact: true }).click();
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.package))
    .toBe('ember');
  await expect
    .poll(async () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--light').trim(),
      ),
    )
    .toBe('#ff8a5b');
  await page.getByRole('radio', { name: 'Field', exact: true }).click();
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.package))
    .toBe('field');
});

test('C07: the thread head states the exact-OK rule while an approval is open', async ({
  page,
}) => {
  await openConsole(page);
  const state = await projectState(page);
  const task = state.tasks.find((t) => t.name === READY_TASK);
  expect(task, 'The Ready task must exist so the approval can attach to it').toBeTruthy();
  // Neither Codex nor a real approval proposal is reachable in this
  // environment, so stand in an open approval need on the state payload: the
  // head reads the same `needs.some((n) => n.approval)` branch either way.
  const approvalNeed = {
    id: 'N7exactok',
    sessionId: 'S7exactok',
    taskId: task!.id,
    what: 'apply the patio proposal',
    why: 'The proposal is ready to review.',
    consequence: 'If you say go ahead, the proposal applies.',
    files: [],
    state: 'open',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedFrom: 'test',
    allowForTask: false,
    approval: {
      protocolVersion: 1,
      proposalDigest: 'a'.repeat(64),
      actionDigest: 'b'.repeat(64),
      baseDigest: 'c'.repeat(64),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      sources: [],
    },
  };
  await page.route('**/api/projects/*/state', async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { needs?: unknown[] };
    await route.fulfill({
      response,
      json: { ...json, needs: [...(json.needs ?? []), approvalNeed] },
    });
  });
  await page.reload();
  await expect(page.locator('.console')).toBeVisible();
  await expect(page.getByText('Each proposed file change needs its own exact OK.')).toBeVisible();
});
