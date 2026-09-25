import { test, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  Change,
  DocumentContent,
  Project,
  ProjectState,
  Settings,
  TaskCandidate,
} from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

/**
 * The acceptance scenarios, driven through the Console. They were written
 * against the Workbook's eight project pages; the Workbook is gone
 * (2026-09-23), so each scenario now reaches the same subject through the
 * Console's own controls: the rail named "Threads and views", the Board, a
 * task's thread and its "Needs your OK" block, History, and the Files pane's
 * editor. Where the Console has no control for a Workbook feature, the test
 * drives the route that feature called and says so where it does.
 */

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
/** The sample project's plan, the one document these scenarios edit and restore. */
const PLAN = 'Reopening plan.md';
/** Settings keys the Workbook read. The server refuses them in a write and stores none. */
const RETIRED_KEYS = ['surface', 'lastPage', 'tasksView'];

let projectId = '';
let editedPlan = '';
let planPath = '';
let originalPlan = '';
let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});

test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test.beforeAll(async ({ request }) => {
  // F01-F02 needs the first run unfinished. field.spec.ts sorts first, finishes onboarding and puts
  // it back in afterAll, but an error that lands while that hook runs interrupts it and the restore
  // never happens. Start the first run here rather than rely on another file's cleanup.
  const reset = await request.put('/api/settings', {
    headers: HEADERS,
    data: {
      onboarding: {
        resumeAt: 'welcome',
        completedAt: null,
        work: null,
        detail: null,
        familiarity: null,
        aiSkipped: false,
      },
    },
  });
  expect(reset.ok(), `Resetting the first run failed (${reset.status()}): ${await reset.text()}`).toBe(true);
});

function expectNoRetiredKeys(settings: Settings) {
  const keys = Object.keys(settings);
  for (const key of RETIRED_KEYS)
    expect(keys, `The retired "${key}" setting must not be stored`).not.toContain(key);
}

async function readSettings(page: Page): Promise<Settings> {
  const response = await page.request.get('/api/settings');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function projectState(page: Page): Promise<ProjectState> {
  const response = await page.request.get(`/api/projects/${projectId}/state`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function readPlan(page: Page): Promise<DocumentContent> {
  const response = await page.request.get(
    `/api/projects/${projectId}/documents/read?path=${encodeURIComponent(planPath)}`,
  );
  expect(response.ok()).toBeTruthy();
  return response.json();
}

/** A launch lands on Nectovia. The Projects page is one click away, from there or from a project. */
async function showProjects(page: Page) {
  const heading = page.getByRole('heading', { name: 'Projects', exact: true });
  const toProjects = page.getByRole('button', { name: 'Projects', exact: true }).first();
  await expect(heading.or(toProjects).first()).toBeVisible();
  if ((await heading.count()) === 0) await toProjects.click();
  await expect(heading).toBeVisible();
}

/** Every helper here reads `projectId`, so open that project from the Projects page. */
async function openProject(page: Page) {
  await page.goto('/');
  await showProjects(page);
  await page.getByRole('button', { name: /Harbor Street/ }).first().click();
  await expect(railOf(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
}

function openProjects(page: Page) {
  return page.getByRole('navigation', { name: 'Open projects', exact: true });
}

function railOf(page: Page) {
  return page.getByRole('navigation', { name: 'Threads and views', exact: true });
}

function boardOf(page: Page) {
  return page.locator('.board[aria-label="Board"]');
}

/** The Console's views, from the rail's foot. Board and Team carry a count after their name. */
async function goTo(page: Page, view: 'Thread' | 'Board' | 'Team') {
  await railOf(page)
    .getByRole('button', { name: view === 'Thread' ? /^Thread$/ : new RegExp(`^${view}\\b`) })
    .click();
  if (view === 'Thread') await expect(page.locator('#scrThread')).toBeVisible();
  else if (view === 'Board') await expect(boardOf(page)).toBeVisible();
  else await expect(page.locator('.team[aria-label="Team"]')).toBeVisible();
}

async function chooseDetail(page: Page, name: 'Guided' | 'Standard' | 'Technical') {
  await page.getByRole('button', { name: 'Interface detail menu' }).click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-detail', name.toLowerCase());
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Open a project document in the Console's editor, through the Files pane. The
 * editor is the Console's own screen and closes whenever the project's Console
 * is left (a reload, a project switch, Settings), so every scenario that comes
 * back to a file opens it again; unsaved writing is recovered on that open.
 */
async function openInEditor(page: Page, file: string): Promise<Locator> {
  const pane = page.getByRole('complementary', { name: 'Files', exact: true });
  if (!(await pane.isVisible()))
    await railOf(page).getByRole('button', { name: 'Files', exact: true }).click();
  await expect(pane).toBeVisible();
  const back = pane.getByRole('button', { name: 'Back', exact: true });
  if (await back.isVisible()) await back.click();
  await pane
    .locator('.files-row')
    .filter({ has: page.locator('.files-name', { hasText: new RegExp(`^${escaped(file)}$`) }) })
    .click();
  await pane.getByRole('button', { name: 'Write in this file', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'The text in this file', exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

/** A task's thread, reached the way the Board offers it: the Review verb on its row. */
async function reviewFromBoard(page: Page, taskName: string) {
  await goTo(page, 'Board');
  const row = boardOf(page).locator('.column[aria-label="Review"] .crow', { hasText: taskName });
  await row.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('#scrThread')).toBeVisible();
}

/** Start the first Ready task on the Board. The sample route starts without a send dialog. */
async function startFirstReady(page: Page): Promise<string> {
  await goTo(page, 'Board');
  const row = boardOf(page).locator('.column[aria-label="Ready"] .crow').first();
  const ready = (await projectState(page)).tasks.filter((task) => task.state === 'todo');
  expect(ready.length, 'A Ready task must be left to start').toBeGreaterThan(0);
  const label = (await row.innerText()).trim();
  // The longest name the row carries, so a name that begins another is not mistaken for it.
  const started = ready
    .filter((task) => label.includes(task.name))
    .sort((a, b) => b.name.length - a.name.length)[0];
  expect(started, 'The first Ready row must be one of the Ready tasks').toBeTruthy();
  await row.getByRole('button', { name: 'Start', exact: true }).first().click();
  // A show-first thread confirms the start in the row before anything runs.
  const confirm = row.locator('.confirm');
  if (await confirm.isVisible())
    await confirm.getByRole('button', { name: 'Start', exact: true }).click();
  return started.name;
}

test('F01-F02: first run preserves detail and approvals, supports AI skip, and resumes', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: 'Business', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Business', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'How much detail do you want?', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'How much detail do you want?', exact: true }),
  ).toBeVisible();
  await page.getByRole('radio', { name: /^Guided/ }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Ask before changing files in a project' }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Connect an AI service', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check this computer' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('first-run-ai.png'), fullPage: true });
  await page.getByRole('button', { name: 'Skip AI setup' }).click();
  await expect(page.getByRole('heading', { name: 'Your workspace is ready' })).toBeVisible();
  await expect(page.getByText(/AI setup was skipped/)).toBeVisible();
  await page.getByRole('button', { name: 'Open Nectovia' }).click();
  // The app opens to Nectovia. The Projects page is where it always was, one click away.
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
  await showProjects(page);
  // The shared data folder is not guaranteed empty by the time this file runs
  // (field.spec.ts sorts first and leaves a project behind), so the empty state
  // is asserted against an intercepted empty list rather than the live folder.
  let emptyListServed = false;
  await page.route('**/api/projects', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || new URL(request.url()).pathname !== '/api/projects') {
      await route.fallback();
      return;
    }
    emptyListServed = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ projects: [] }),
    });
  });
  await page.reload();
  await showProjects(page);
  await expect(
    page.getByText(/a project for a restaurant's menus, suppliers and schedules/),
  ).toBeVisible();
  expect(emptyListServed).toBe(true);
  await page.unroute('**/api/projects');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
  await showProjects(page);
  const settings = await readSettings(page);
  expect(settings.detail).toBe('guided');
  expectNoRetiredKeys(settings);
  expect(settings.permissions.changingFiles).toBe(true);
  expect(settings.explanations).toBe('persistent');
  expect(settings.onboarding.completedAt).toBeTruthy();

  const resume = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { onboarding: { resumeAt: 'q2', completedAt: null } },
  });
  expect(resume.ok()).toBe(true);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'How much detail do you want?', exact: true }),
  ).toBeVisible();
  await page.getByRole('radio', { name: /^Technical/ }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Ask before changing files in a project' }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Skip AI setup' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your workspace is ready', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open Nectovia' }).click();
  // First run now ends on Nectovia's own page too; the Projects page is one click away.
  await showProjects(page);
  // The Projects page offers no sample project any more (Andrew, 2026-09-23).
  // The server route stays as a test fixture, so the project is made there and
  // opened from the list the way any other project is.
  await expect(page.getByRole('button', { name: /sample project/i })).toHaveCount(0);
  const made = await page.request.post('/api/projects/sample', {
    headers: { 'X-Diomedes-Client': '1' },
    data: {},
  });
  expect(made.ok()).toBe(true);
  await page.reload();
  await showProjects(page);
  await page.getByRole('button', { name: /^Harbor Street restaurants/ }).first().click();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'technical');
  // A new person starts in the Conversation view (shared/onboarding.ts): the
  // project is open, and its panel, which carries the project heading, is not.
  await expect(page.locator('html')).toHaveAttribute('data-view', 'conversation');
  await expect(
    page.getByRole('navigation', { name: 'Open projects', exact: true }).locator('b'),
  ).toHaveText('Harbor Street restaurants');
  await expect(page.getByRole('complementary', { name: 'This project' })).toHaveCount(0);
  const comfortableSettings = await readSettings(page);
  expect(comfortableSettings.view).toBe('conversation');
  expectNoRetiredKeys(comfortableSettings);
  expect(comfortableSettings.detail).toBe('technical');
  expect(comfortableSettings.permissions.changingFiles).toBe(true);

  // The menu offers the Console's two views, the detail levels and the conversation text
  // size, and nothing that leaves the Console.
  await page.getByRole('button', { name: 'Interface detail menu' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitemradio')).toHaveText([
    'Conversation',
    'Architect',
    'Guided',
    'Standard',
    'Technical',
    '90%',
    '100% (Default)',
    '110%',
    '125%',
  ]);
  await expect(page.getByText('The Workbook', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // A client from before the Workbook's removal can still ask for it. The
  // server refuses the whole write as unknown, so the detail level it carried
  // is not applied either, and the Console stays as it was.
  const legacy = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { surface: 'workbook', detail: 'standard' },
  });
  expect(legacy.status()).toBe(400);
  expect(await legacy.text()).toContain('Unknown setting: surface');
  const afterLegacy = await readSettings(page);
  expectNoRetiredKeys(afterLegacy);
  expect(afterLegacy.detail).toBe('technical');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'technical');
  await expect(railOf(page)).toBeVisible();
  await chooseDetail(page, 'Guided');
  const guidedSettings = await readSettings(page);
  expectNoRetiredKeys(guidedSettings);
  expect(guidedSettings.appearance.interfaceScale).toBeUndefined();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--dm-ui-scale').trim(),
      ),
    )
    .toBe('1');
});

test('F04, F06: sample project opens and a plan edit survives reload with History', async ({
  page,
}, testInfo) => {
  // The remaining scenarios use explicit guided preferences, in the full Console
  // (Architect): F01 left the new person in the Conversation view.
  const guided = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { detail: 'guided', view: 'architect', permissions: { changingFiles: true } },
  });
  expect(guided.ok()).toBe(true);
  await page.goto('/');
  // The first-run test already opened the sample project; reuse it rather than creating a second one.
  await showProjects(page);
  const existing = page.getByRole('button', { name: /^Harbor Street restaurants/ }).first();
  if (!(await existing.count())) {
    const made = await page.request.post('/api/projects/sample', {
      headers: { 'X-Diomedes-Client': '1' },
      data: {},
    });
    expect(made.ok()).toBe(true);
    await page.reload();
    await showProjects(page);
  }
  await page.getByRole('button', { name: /^Harbor Street restaurants/ }).first().click();
  await expect(railOf(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'guided');
  await expect(
    openProjects(page).getByRole('button', { name: 'Harbor Street restaurants', exact: true }),
  ).toHaveClass(/(?:^|\s)on(?:\s|$)/);
  const { projects }: { projects: Project[] } = await (
    await page.request.get('/api/projects')
  ).json();
  const project = projects.find((item) => item.name.includes('Harbor Street'));
  expect(project).toBeTruthy();
  projectId = project!.id;
  const state = await projectState(page);
  expect(state.documents.length).toBe(3);
  expect(state.documents.some((document) => document.path === PLAN)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('home-guided.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const editor = await openInEditor(page, PLAN);
  originalPlan = await editor.inputValue();
  expect(originalPlan.length).toBeGreaterThan(0);
  editedPlan = `${originalPlan}\n\n4. Update menu prices for the patio opening.\n`;
  await editor.fill(editedPlan);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect
    .poll(async () =>
      (await projectState(page)).history.some(
        (entry) =>
          entry.kind === 'edited' &&
          entry.files.some((file) => file.before && file.after && file.before !== file.after),
      ),
    )
    .toBe(true);
  const edited = (await projectState(page)).history.find(
    (entry) => entry.kind === 'edited' && entry.files.length,
  );
  planPath = edited!.files[0].path;
  expect(planPath).toBe(PLAN);
  await page.reload();
  await expect(railOf(page)).toBeVisible();
  await expect(await openInEditor(page, PLAN)).toHaveValue(editedPlan);
});

test('F10: plan steps become real tasks with provenance and a History entry', async ({
  page,
}, testInfo) => {
  await openProject(page);
  // The Console has no "Make tasks from this plan" control. The routes the
  // Workbook's button called are still the way plan steps become tasks, so the
  // scenario drives them and reads the result where the Console shows it: the
  // Board's Ready column and its "Plans on this board" list.
  const find = await page.request.post(`/api/projects/${projectId}/plans/find-tasks`, {
    headers: HEADERS,
    data: { path: planPath },
  });
  expect(find.ok()).toBe(true);
  const { found }: { found: TaskCandidate[] } = await find.json();
  const count = found.length;
  expect(count).toBeGreaterThan(0);
  const add = await page.request.post(`/api/projects/${projectId}/plans/add-tasks`, {
    headers: HEADERS,
    data: { path: planPath, items: found },
  });
  expect(add.ok(), await add.text()).toBe(true);
  const state = await projectState(page);
  expect(state.tasks).toHaveLength(count);
  expect(state.tasks.every((task) => task.from?.plan === planPath && task.state === 'todo')).toBe(
    true,
  );
  expect(state.history.some((entry) => entry.kind === 'tasks-made')).toBe(true);
  await page.reload();
  await goTo(page, 'Board');
  const board = boardOf(page);
  await expect(board.locator('.column[aria-label="Ready"] .crow')).toHaveCount(count);
  for (const task of state.tasks)
    await expect(board.locator('.column[aria-label="Ready"] .crow', { hasText: task.name })).toHaveCount(1);
  await expect(board.getByRole('list', { name: 'Plans on this board' }).locator('.plan')).toHaveCount(1);
  await page.screenshot({
    path: testInfo.outputPath('tasks-guided.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await chooseDetail(page, 'Standard');
  await page.screenshot({
    path: testInfo.outputPath('tasks-standard.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await chooseDetail(page, 'Guided');
});

test('F11-F13: work asks twice, decline skips creation, and the remaining change is recorded', async ({
  page,
}, testInfo) => {
  await openProject(page);
  const taskName = await startFirstReady(page);
  await expect
    .poll(
      async () => (await projectState(page)).needs.filter((need) => need.state === 'open').length,
    )
    .toBe(1);
  // The waiting task moves to the Board's Review column, and its Review verb opens its thread.
  await reviewFromBoard(page, taskName);
  const notice = page.getByRole('region', { name: 'Needs your OK', exact: true });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect
    .poll(async () =>
      (await projectState(page)).needs.some(
        (need) => need.state === 'open' && /add/i.test(need.what),
      ),
    )
    .toBe(true);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/add a file called Sample work notes\.md/);
  await page.screenshot({
    path: testInfo.outputPath('work-approval.png'),
    fullPage: true,
    animations: 'disabled',
  });
  // Where the Workbook's Home counted it, the Board shows the one task waiting on the person.
  const waitingTask = (await projectState(page)).tasks.find((task) => task.state === 'waiting')!;
  expect(waitingTask.name).toBe(taskName);
  await goTo(page, 'Board');
  await expect(boardOf(page).locator('.column[aria-label="Review"] .crow')).toHaveCount(1);
  await expect(
    boardOf(page).locator('.column[aria-label="Review"] .crow', { hasText: waitingTask.name }),
  ).toHaveCount(1);
  // The project tab carries the waiting mark in the strip over the Projects page.
  await openProjects(page).getByRole('button', { name: 'Projects', exact: true }).click();
  const harborTab = openProjects(page).getByRole('button', { name: /Harbor Street/ });
  await expect(harborTab.locator('.mark.waiting')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('home-guided-needs.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await harborTab.click();
  await expect(railOf(page)).toBeVisible();
  await reviewFromBoard(page, waitingTask.name);
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Go ahead', exact: true })).toBeVisible();
  await expect(
    notice.getByRole('button', { name: 'Go ahead for this whole task', exact: true }),
  ).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Show me first', exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('tasks-waiting.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await notice.getByRole('button', { name: "Don't do this", exact: true }).click();
  await expect.poll(async () => (await projectState(page)).sessions[0]?.state).toBe('done');
  const state = await projectState(page);
  expect(state.needs.filter((need) => need.state === 'open')).toHaveLength(0);
  expect(state.documents.some((document) => document.path === 'Sample work notes.md')).toBe(false);
  expect(state.changes.filter((change) => change.state === 'waiting')).toHaveLength(1);
  const workEntry = state.history.find(
    (entry) =>
      entry.kind === 'changed' && entry.sessionId === state.sessions[0].id && entry.files.length,
  );
  expect(workEntry?.files[0].before).toBeTruthy();
  expect(workEntry?.files[0].after).toBeTruthy();
  expect(state.history.filter((entry) => entry.kind === 'decision')).toHaveLength(2);
  await expect(notice).toHaveCount(0);
  await openProjects(page).getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(
    openProjects(page).getByRole('button', { name: /Harbor Street/ }).locator('.mark.waiting'),
  ).toHaveCount(0);
});

test('F15-F16: Review keeps the changed file and History exposes the recorded change', async ({
  page,
}, testInfo) => {
  await openProject(page);
  // The Console has no Review page and no Keep or Undo control for a waiting
  // change; its thread shows the change (What changed) but cannot settle it.
  // Keep all is driven through the route the Workbook's Review page called.
  const waiting = (await projectState(page)).changes.filter((change) => change.state === 'waiting');
  expect(waiting).toHaveLength(1);
  const keep = await page.request.post(`/api/projects/${projectId}/review/all`, {
    headers: HEADERS,
    data: { action: 'keep' },
  });
  expect(keep.ok(), await keep.text()).toBe(true);
  await expect
    .poll(
      async () =>
        (await projectState(page)).changes.filter((change) => change.state === 'waiting').length,
    )
    .toBe(0);
  const state = await projectState(page);
  const done = state.tasks.find((task) => task.state === 'done');
  expect(done).toBeTruthy();
  await page.reload();
  await goTo(page, 'Board');
  await expect(
    boardOf(page).locator('.column[aria-label="Done"] .crow', { hasText: done!.name }),
  ).toHaveCount(1);
  await page.screenshot({
    path: testInfo.outputPath('review-guided.png'),
    fullPage: true,
    animations: 'disabled',
  });
  // The Console's History screen is gone (Andrew, 2026-09-23). The record it
  // showed is still written, so the changed file is read from state.
  await expect(railOf(page).getByRole('button', { name: /^History\b/ })).toHaveCount(0);
  const workEntry = state.history.find((entry) => entry.kind === 'changed' && entry.files.length)!;
  expect(workEntry.sentence).toBeTruthy();
  expect(workEntry.files[0].before).toBeTruthy();
  expect(workEntry.files[0].after).toBeTruthy();
  expect(workEntry.files[0].before).not.toBe(workEntry.files[0].after);
});

test('F07-F08: restore and undo recover both versions; newer edits are a conflict', async ({
  page,
}) => {
  // No Console screen restores files any more (the History screen was removed
  // 2026-09-23). The routes it called still hold the record, so they are driven
  // directly: restore, undo that restore, then a restore over a newer edit.
  await openProject(page);
  const state = await projectState(page);
  const workEntry = state.history.find((entry) => entry.kind === 'changed');
  expect(workEntry).toBeTruthy();
  const current = await readPlan(page);
  const workChange = state.changes.find((change) => change.entryId === workEntry!.id);
  expect(workChange?.before).toBeTruthy();
  const restore = (entryId: string, data: Record<string, unknown> = {}) =>
    page.request.post(`/api/projects/${projectId}/history/${entryId}/restore`, {
      headers: HEADERS,
      data,
    });

  const restored = await restore(workEntry!.id);
  expect(restored.ok(), await restored.text()).toBe(true);
  await expect.poll(async () => (await readPlan(page)).text).toBe(workChange!.before);
  const restoreEntry = (await projectState(page)).history.find(
    (entry) => entry.kind === 'restore' && entry.restoreOf === workEntry!.id,
  );
  expect(restoreEntry).toBeTruthy();
  const undone = await restore(restoreEntry!.id);
  expect(undone.ok(), await undone.text()).toBe(true);
  await expect.poll(async () => (await readPlan(page)).text).toBe(current.text);

  const editor = await openInEditor(page, planPath);
  await expect(editor).toHaveValue(current.text);
  const newer = `${current.text}\nA newer decision made by the person reviewing this plan.\n`;
  await editor.fill(newer);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await readPlan(page)).text).toBe(newer);
  const conflict = await restore(workEntry!.id);
  expect(conflict.status()).toBe(409);
  const onlyUnchanged = await restore(workEntry!.id, { mode: 'unchanged-only' });
  expect(onlyUnchanged.ok(), await onlyUnchanged.text()).toBe(true);
  expect((await readPlan(page)).text).toBe(newer);
});

test('F14: Stop settles a started sample promptly and expires its approval', async ({ page }) => {
  await openProject(page);
  const taskName = await startFirstReady(page);
  await expect
    .poll(async () => (await projectState(page)).needs.filter((need) => need.state === 'open').length)
    .toBe(1);
  await reviewFromBoard(page, taskName);
  await page
    .getByRole('region', { name: 'Needs your OK', exact: true })
    .getByRole('button', { name: 'Go ahead', exact: true })
    .click();
  const latest = (await projectState(page)).sessions.at(-1);
  expect(latest).toBeTruthy();
  await page.locator('#scrThread').getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect
    .poll(
      async () =>
        (await projectState(page)).sessions.find((session) => session.id === latest!.id)?.state,
      { timeout: 1000 },
    )
    .toBe('stopped');
  const state = await projectState(page);
  expect(
    state.needs.filter((need) => need.sessionId === latest!.id && need.state === 'open'),
  ).toHaveLength(0);
  expect(
    state.history.some((entry) => entry.kind === 'stop' && entry.sessionId === latest!.id),
  ).toBe(true);
});

test('F17, F20-F22: detail changes preserve data; the Console meets layout and motion checks', async ({
  page,
}, testInfo) => {
  await openProject(page);
  const before = await projectState(page);
  for (const detail of ['Guided', 'Standard'] as const) {
    await chooseDetail(page, detail);
    for (const view of ['Thread', 'Board', 'Team'] as const) await goTo(page, view);
  }

  // Asking from a thread of the project's own records the turn on that thread.
  await goTo(page, 'Thread');
  const beforeAsk = await projectState(page);
  const beforeProjectThreads = beforeAsk.conversations.filter(
    (thread) => thread.attachedTo.kind === 'project',
  );
  await railOf(page).getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.locator('#scrThread')).toBeVisible();
  const askText = 'How should I organize the restaurant menu work?';
  const modes = page.getByRole('radiogroup', { name: 'Mode' });
  await modes.getByRole('radio', { name: 'ask', exact: true }).click();
  await expect(modes.getByRole('radio', { name: 'ask', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('textbox', { name: 'Message this thread', exact: true }).fill(askText);
  await page.locator('.console .composer').getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(async () => {
      const state = await projectState(page);
      return state.conversations.some(
        (thread) =>
          thread.attachedTo.kind === 'project' &&
          thread.turns.some((turn) => turn.role === 'you' && turn.text === askText),
      );
    })
    .toBe(true);
  const afterAsk = await projectState(page);
  const afterProjectThreads = afterAsk.conversations.filter(
    (thread) => thread.attachedTo.kind === 'project',
  );
  expect(
    afterProjectThreads.length > beforeProjectThreads.length ||
      afterProjectThreads.some((thread) => {
        const beforeThread = beforeProjectThreads.find((candidate) => candidate.id === thread.id);
        return beforeThread !== undefined && thread.turns.length > beforeThread.turns.length;
      }),
  ).toBe(true);
  // The rail lists every thread in the project, task threads included.
  await expect(railOf(page).locator('.console-thread')).toHaveCount(afterAsk.conversations.length);
  await page.screenshot({
    path: testInfo.outputPath('console.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // Settings offers no surface to choose between.
  await expect(page.getByRole('radio', { name: /^The (Console|Workbook)\b/ })).toHaveCount(0);
  // Detail is the person's own setting, and opening Settings from the Console
  // leaves it alone.
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'standard');
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Interface detail', exact: true })
    .click();
  await expect(page.getByRole('radio', { name: /^Standard\b/ })).toBeChecked();
  await page.getByRole('radio', { name: /^Guided\b/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'guided');
  await openProjects(page).getByRole('button', { name: /Harbor Street/ }).click();
  await expect(railOf(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'guided');
  expectNoRetiredKeys(await readSettings(page));
  const after = await projectState(page);
  expect(after.tasks).toEqual(before.tasks);
  expect(after.changes).toEqual(before.changes);
  expect(after.history).toEqual(before.history);
  await page.screenshot({
    path: testInfo.outputPath('work-technical.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await goTo(page, 'Thread');
  const moving = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')].flatMap((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        box.width === 0 ||
        box.height === 0
      )
        return [];
      const result: string[] = [];
      if (
        style.animationName !== 'none' &&
        style.animationDuration.split(',').some((value) => parseFloat(value) > 0) &&
        style.animationPlayState !== 'paused'
      )
        result.push(`Animation active: ${element.tagName}.${element.className}`);
      if (style.transitionDuration.split(',').some((value) => parseFloat(value) > 0))
        result.push(`Transition active: ${element.tagName}.${element.className}`);
      return result;
    }),
  );
  expect(moving).toEqual([]);

  const scaleBefore = await readSettings(page);
  const header = page.locator('.console header.top');
  await expect(header).toBeVisible();
  async function setInterfaceScale(value: number) {
    const update = await page.request.put('/api/settings', {
      headers: HEADERS,
      data: {
        appearance: { ...scaleBefore.appearance, interfaceScale: value },
      },
    });
    expect(update.ok()).toBe(true);
    await expect
      .poll(async () =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--dm-ui-scale').trim(),
        ),
      )
      .toBe(String(value));
  }
  await setInterfaceScale(1);
  const headerAtOne = (await header.boundingBox())?.height ?? 0;
  expect(headerAtOne).toBeGreaterThan(0);
  await setInterfaceScale(1.3);
  const headerAtLarge = (await header.boundingBox())?.height ?? 0;
  expect(headerAtLarge / headerAtOne).toBeCloseTo(1.3, 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'The page must not overflow horizontally at scale 1.3',
  ).toBe(true);
  await setInterfaceScale(1);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const view of ['Thread', 'Board'] as const) {
    await goTo(page, view);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      `${view} should fit a narrow screen`,
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`${view.toLowerCase()}-mobile.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
});

test('Draft recovery: Settings, reload and same-named files in separate projects preserve writing and stale-save conflicts', async ({
  page,
}, testInfo) => {
  const file = 'Recovery plan.md';
  const originalA = '# Recovery plan\n\nOriginal writing for project A.\n';
  const originalB = '# Recovery plan\n\nDifferent original writing for project B.\n';
  async function seed(name: string, text: string): Promise<Project> {
    const created = await page.request.post('/api/projects', { headers: HEADERS, data: { name } });
    expect(created.ok()).toBe(true);
    const result: Project = await created.json();
    const relative = path.relative(path.resolve('test-results'), result.folder);
    expect(
      path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`),
      'Draft fixtures must stay inside the isolated test output',
    ).toBe(false);
    const document = await page.request.post(`/api/projects/${result.id}/documents/create`, {
      headers: HEADERS,
      data: { path: file, text, kind: 'plan' },
    });
    expect(document.ok()).toBe(true);
    const baseline = await page.request.post(`/api/projects/${result.id}/history/label`, {
      headers: HEADERS,
      data: { label: 'Initial draft test version' },
    });
    expect(baseline.ok()).toBe(true);
    return result;
  }
  const first = await seed('Draft recovery A', originalA);
  const second = await seed('Draft recovery B', originalB);
  const setup = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: {
      detail: 'guided',
      services: { codex: false },
      onboarding: {
        work: 'business',
        detail: 'guided',
        familiarity: 'new',
        resumeAt: 'done',
        completedAt: new Date().toISOString(),
      },
      openProjects: [second.id, first.id],
    },
  });
  expect(setup.ok()).toBe(true);
  await page.goto('/');
  const tabs = openProjects(page);
  const notSaved = page.locator('.docedit .de-state');
  // Land in project A by name: `shownProjects` follows `/api/projects`
  // creation order, not `openProjects`, so which tab is last is not fixed.
  await tabs.getByRole('button', { name: first.name, exact: true }).click();
  await expect(railOf(page)).toBeVisible();
  const draftA = `${originalA}\nUnsaved writing that belongs only to project A.\n`;
  const draftB = `${originalB}\nA separate unsaved draft that belongs only to project B.\n`;
  let editor = await openInEditor(page, file);
  await editor.fill(draftA);
  await expect(notSaved).toHaveText('Not saved yet');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // Settings leaves the detail level alone.
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'guided');
  await expect(page.getByRole('navigation', { name: 'Settings', exact: true })).toBeVisible();
  await tabs.getByRole('button', { name: first.name, exact: true }).click();
  await expect(railOf(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'guided');
  editor = await openInEditor(page, file);
  await expect(editor).toHaveValue(draftA);
  await expect(page.locator('.docedit [role="status"]')).toHaveText(
    'We brought back writing you had not saved.',
  );

  await tabs.getByRole('button', { name: second.name, exact: true }).click();
  await expect(railOf(page)).toBeVisible();
  editor = await openInEditor(page, file);
  await expect(editor).toHaveValue(originalB);
  await editor.fill(draftB);
  await expect(notSaved).toHaveText('Not saved yet');
  await tabs.getByRole('button', { name: first.name, exact: true }).click();
  await expect(railOf(page)).toBeVisible();
  editor = await openInEditor(page, file);
  await expect(editor).toHaveValue(draftA);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await expect(railOf(page)).toBeVisible();
  editor = await openInEditor(page, file);
  await expect(editor).toHaveValue(draftA);
  await page.screenshot({
    path: testInfo.outputPath('recovered-draft.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(first.folder, file), 'utf8')).toBe(draftA);
  const savedState: ProjectState = await (
    await page.request.get(`/api/projects/${first.id}/state`)
  ).json();
  const savedEntry = savedState.history.find(
    (entry) =>
      entry.kind === 'edited' &&
      entry.files.some((record) => record.before && record.after && record.before !== record.after),
  );
  expect(savedEntry).toBeTruthy();
  const { files }: { files: Change[] } = await (
    await page.request.get(`/api/projects/${first.id}/history/${savedEntry!.id}/changes`)
  ).json();
  expect(files[0].before).toBe(originalA);
  expect(files[0].after).toBe(draftA);

  await tabs.getByRole('button', { name: second.name, exact: true }).click();
  await expect(railOf(page)).toBeVisible();
  editor = await openInEditor(page, file);
  await expect(editor).toHaveValue(draftB);
  expect(await fs.readFile(path.join(second.folder, file), 'utf8')).toBe(originalB);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(second.folder, file), 'utf8')).toBe(draftB);
  await tabs.getByRole('button', { name: first.name, exact: true }).click();
  await expect(railOf(page)).toBeVisible();
  editor = await openInEditor(page, file);
  await expect(editor).toHaveValue(draftA);
  const staleDraft = `${draftA}\nA browser draft based on the earlier saved version.\n`;
  const external = `${draftA}\nA newer edit made outside the browser.\n`;
  await editor.fill(staleDraft);
  await expect(notSaved).toHaveText('Not saved yet');
  await fs.writeFile(path.join(first.folder, file), external, 'utf8');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await expect(railOf(page)).toBeVisible();
  editor = await openInEditor(page, file);
  await expect(editor).toHaveValue(staleDraft);
  // The Console's editor names the conflict as soon as the recovered writing
  // meets a newer file, and Save does not write over it.
  const conflict = page.getByRole('alert', {
    name: 'Someone else changed this file while you were writing',
    exact: true,
  });
  await expect(conflict).toBeVisible();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(conflict).toBeVisible();
  expect(await fs.readFile(path.join(first.folder, file), 'utf8')).toBe(external);
  await expect(editor).toHaveValue(staleDraft);
  await page.screenshot({
    path: testInfo.outputPath('recovered-draft-conflict.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await conflict.getByRole('button', { name: 'Keep writing', exact: true }).click();
  await expect(conflict).toHaveCount(0);
  await expect(editor).toHaveValue(staleDraft);
  expect(await fs.readFile(path.join(first.folder, file), 'utf8')).toBe(external);
});

test('Services roster: every reported engine listed with switch discipline at every detail level; Console has no Connections', async ({
  page,
}) => {
  const setup = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: {
      detail: 'guided',
      services: { codex: false },
      onboarding: {
        work: 'business',
        detail: 'guided',
        familiarity: 'new',
        resumeAt: 'done',
        completedAt: new Date().toISOString(),
      },
    },
  });
  expect(setup.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const rail = page.getByRole('navigation', { name: 'Settings', exact: true });
  await rail.getByRole('button', { name: 'Helpers on this computer', exact: true }).click();

  const service = (name: string | RegExp) =>
    page.locator('.service', { has: page.getByRole('heading', { name }) });
  // Every reported engine is listed. The Workbook hid the observe-only entries
  // at Guided; the Console lists the same roster at every detail level, so
  // Guided and Standard are both checked against the whole list below.
  await expect(service('Sample work')).toHaveCount(0);
  await expect(service(/ChatGPT/)).toBeVisible();
  await expect(service('LocalAI supervisor')).toBeVisible();
  await expect(service('AionCore')).toBeVisible();
  // The Codex entry has a switch; Sample work has none.
  await expect(service(/ChatGPT/).locator('input[type="checkbox"]')).toHaveCount(1);
  await expect(service('Sample work').locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(service(/ChatGPT/).getByRole('button', { name: 'What is sent' })).toHaveCount(1);
  // Check connections reaches the server with a refresh request.
  const [refreshRequest] = await Promise.all([
    page.waitForRequest(
      (request) =>
        request.url().includes('/api/integrations') && request.url().includes('refresh=1'),
    ),
    page.getByRole('button', { name: 'Check connections', exact: true }).click(),
  ]);
  expect(refreshRequest.url()).toContain('refresh=1');

  // Standard shows the same roster, the observe-only entries included.
  await chooseDetail(page, 'Standard');
  await expect(service(/ChatGPT/)).toBeVisible();
  await expect(service('LocalAI supervisor')).toBeVisible();
  await expect(service('AionCore')).toBeVisible();
  // Entries without a switch offer no "What is sent" button either.
  for (const name of ['LocalAI supervisor', 'AionCore']) {
    await expect(service(name).locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(service(name).getByRole('button', { name: 'What is sent' })).toHaveCount(0);
  }

  // Settings keep Engines and no longer list a Connections section.
  await expect(rail.getByRole('button', { name: 'Engines', exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Connections', exact: true })).toHaveCount(0);
  await rail.getByRole('button', { name: 'Engines', exact: true }).click();
  await expect(service('Sample work')).toHaveCount(0);
  await expect(service(/ChatGPT/)).toBeVisible();

  const back = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { detail: 'guided' },
  });
  expect(back.ok()).toBe(true);
});

test('Usage: chip, signal bar and Settings bars from the test-mode snapshot', async ({ page }) => {
  // The dev server runs with DIOMEDES_TEST_MODE=1, so ?fake=1 returns the
  // fixed snapshot: Codex at 62 and 91 percent.
  const faked = await page.request.get('/api/usage?fake=1');
  expect(faked.ok()).toBe(true);
  const body: { usage: { engine: string; windows: { usedPercent: number }[] }[] } =
    await faked.json();
  const codex = body.usage.find((item) => item.engine === 'codex')!;
  expect(codex.windows.map((w) => w.usedPercent).sort((a, b) => a - b)).toEqual([62, 91]);
  // Nothing shows while no engine is on.
  const off = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: {
      detail: 'standard',
      services: { codex: false },
      onboarding: {
        work: 'business',
        detail: 'standard',
        familiarity: 'new',
        resumeAt: 'done',
        completedAt: new Date().toISOString(),
      },
    },
  });
  expect(off.ok()).toBe(true);
  await page.goto('/');
  // The chip sits in the strip over Nectovia's own pages; a project's Console draws its own.
  await expect(openProjects(page)).toBeVisible();
  await expect(page.locator('.usage-chip')).toHaveCount(0);
  // Turning Codex on reveals the chip with the tightest window.
  const on = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { services: { codex: true } },
  });
  expect(on.ok()).toBe(true);
  await page.reload();
  const chip = page.locator('.usage-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/ChatGPT, week, 9% left/);
  // Bars fill with what is left; under 20 percent left takes the signal colour.
  await expect(chip.locator('.usage-fill.signal')).toBeVisible();
  // The chip opens Settings at the engines section with both bars.
  await chip.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Engines', exact: true })).toBeVisible();
  const codexService = page.locator('.service', {
    has: page.getByRole('heading', { name: /ChatGPT/ }),
  });
  await expect(codexService.locator('.usage-row')).toHaveCount(2);
  await expect(codexService).toContainText(/5 hours/);
  await expect(codexService).toContainText(/9% left/);
  await expect(codexService).toContainText(/38% left/);
  await expect(codexService).toContainText(/Resets /);
  await expect(codexService).toContainText(
    /Last thread: 12.4k of 200k context, 3.1k written, \$0.04/,
  );
  await expect(codexService.locator('.usage-fill.signal')).toBeVisible();
  const banned =
    /\b(?:kanban|git|github|repo|repository|branch|commit|agent|agentic|worker|model|llm|context window|tokens|mcp|patch|diff|prompt|pipeline|orchestration|autonomous|copilot)\b/gi;
  expect(
    (await codexService.innerText()).match(banned) ?? [],
    'Forbidden words in the usage block',
  ).toEqual([]);
  // Switching Codex back off hides the chip again.
  const backOff = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { services: { codex: false } },
  });
  expect(backOff.ok()).toBe(true);
  await page.reload();
  await expect(openProjects(page)).toBeVisible();
  await expect(page.locator('.usage-chip')).toHaveCount(0);
});

test('Landing: ask box carries a draft into the chosen project', async ({ page }) => {
  const setup = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: {
      detail: 'guided',
      onboarding: {
        work: 'business',
        detail: 'guided',
        familiarity: 'new',
        resumeAt: 'done',
        completedAt: new Date().toISOString(),
      },
    },
  });
  expect(setup.ok()).toBe(true);
  let { projects }: { projects: Project[] } = await (
    await page.request.get('/api/projects')
  ).json();
  if (!projects.some((item) => item.name.includes('Harbor Street'))) {
    const created = await page.request.post('/api/projects/sample', { headers: HEADERS, data: {} });
    expect(created.ok()).toBe(true);
    ({ projects } = await (await page.request.get('/api/projects')).json());
  }
  expect(projects.length).toBeGreaterThan(0);
  const sorted = [...projects].sort((a, b) =>
    (b.lastOpenedAt || b.createdAt).localeCompare(a.lastOpenedAt || a.createdAt),
  );
  const latest = sorted[0];
  await page.goto('/');
  await showProjects(page);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  const startHere = page.getByRole('region', { name: 'Start here' });
  await expect(startHere).toBeVisible();
  await expect(startHere.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
  const projectSelect = page.getByLabel('In project');
  await expect(projectSelect).toBeVisible();
  // Nothing is inferred from recency any more (review condition H3): the ask box sends nowhere
  // until the person says where.
  await expect(projectSelect).toHaveValue('');
  await projectSelect.selectOption(latest.id);
  await expect(projectSelect).toHaveValue(latest.id);
  const askText = 'Which suppliers are late?';
  await startHere.getByRole('textbox').fill(askText);
  await startHere.getByRole('button', { name: 'Send', exact: true }).click();
  // The draft arrives in the chosen project's Console composer, in Ask.
  await expect(railOf(page)).toBeVisible();
  await expect(
    openProjects(page).getByRole('button', { name: latest.name, exact: true }),
  ).toHaveClass(/(?:^|\s)on(?:\s|$)/);
  await expect(page.getByRole('textbox', { name: 'Message this thread', exact: true })).toHaveValue(
    askText,
  );
  await expect(
    page.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'ask', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  // Empty state (three cards with no projects): skipped. There is no existing
  // helper for a fresh data dir in this spec and projects cannot be deleted
  // via the API, so the no-projects cards cannot be reached in this run.
});

test('Unavailable helper: the application notice has no invented runtime caption', async ({ page }) => {
  await openProject(page);
  await goTo(page, 'Thread');
  await railOf(page).getByRole('button', { name: 'New', exact: true }).click();
  const modes = page.getByRole('radiogroup', { name: 'Mode' });
  await modes.getByRole('radio', { name: 'ask', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message this thread', exact: true })
    .fill('Which soups are local?');
  await page.locator('.console .composer').getByRole('button', { name: 'Send', exact: true }).click();
  const helperTurn = page.locator('#scrThread .turn.dio').last();
  await expect(helperTurn).toContainText('No service is connected for this request');
  await expect(helperTurn.locator('.who')).toContainText('Nectovia');
  await expect(helperTurn).not.toContainText('Sample work');
});

test('Engine choices: the list comes from the engine, and the levels follow the choice', async ({
  page,
}) => {
  // The catalogue comes from the engine's own cache (CODEX_HOME, written by the
  // Playwright config), so what is offered here is what the engine reports.
  const listed = await page.request.get('/api/engines/codex/models');
  expect(listed.ok()).toBe(true);
  const catalog: { models: { slug: string }[] } = await listed.json();
  expect(catalog.models.map((m) => m.slug)).toEqual(['gpt-6-astra', 'gpt-5.5']);
  // An engine with no list says so rather than offering an invented one.
  const none: { models: unknown[]; detail: string } = await (
    await page.request.get('/api/engines/claude-code/models')
  ).json();
  expect(none.models).toEqual([]);
  // Which sentence depends on the machine: "Check connections" above runs real
  // discovery, so a computer without Claude Code (a hosted Windows runner) has
  // it recorded as not installed, and one never checked says so. Both say why
  // there is no list; neither invents one.
  expect(none.detail).toMatch(/Check|check|not checked|Not checked|Install this tool/);

  const on = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { services: { codex: true } },
  });
  expect(on.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Engines', exact: true })
    .click();

  // Choosing brings that choice's own level with it, and its own ladder.
  const choice = page.getByLabel('Default choice');
  await expect(choice).toBeVisible();
  await choice.selectOption('gpt-6-astra');
  const level = page.getByLabel('Default reasoning level');
  await expect(level).toHaveValue('medium');
  await expect(level.locator('option')).toHaveCount(4);
  // The runtime's own id reads badly title-cased, so the level is named.
  await expect(level).toContainText('Extra high');
  await choice.selectOption('gpt-5.5');
  // Four rungs down to two, and the level resets to the new choice's default.
  await expect(level.locator('option')).toHaveCount(2);
  await expect(level).toHaveValue('low');
  const saved = await readSettings(page);
  expect(saved.services).toMatchObject({ codexModel: 'gpt-5.5', codexEffort: 'low' });

  // A thread overrides the default. What it asked for is kept apart from what
  // the runtime reported: this is a request, that is a claim about what ran.
  const state: ProjectState = await projectState(page);
  const thread = state.conversations[0];
  expect(thread).toBeTruthy();
  const chose = await page.request.put(`/api/projects/${projectId}/threads/${thread.id}`, {
    headers: HEADERS,
    data: { engine: 'codex', requested: { model: 'gpt-6-astra', effort: 'ultra' } },
  });
  expect(chose.ok()).toBe(true);
  const after: ProjectState = await projectState(page);
  const chosen = after.conversations.find((c) => c.id === thread.id);
  expect(chosen?.requested).toEqual({ model: 'gpt-6-astra', effort: 'ultra' });
  expect(chosen?.helper?.model).not.toBe('gpt-6-astra');

  // A level the chosen one does not offer is refused rather than sent on.
  const bad = await page.request.put(`/api/projects/${projectId}/threads/${thread.id}`, {
    headers: HEADERS,
    data: { requested: { model: 'gpt-5.5', effort: 'ultra' } },
  });
  expect(bad.status()).toBe(400);
  // Clearing it puts the thread back on the saved default.
  const cleared = await page.request.put(`/api/projects/${projectId}/threads/${thread.id}`, {
    headers: HEADERS,
    data: { requested: null },
  });
  expect(cleared.ok()).toBe(true);
  expect((await projectState(page)).conversations.find((c) => c.id === thread.id)?.requested).toBe(
    null,
  );

  const off = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { services: { codex: false } },
  });
  expect(off.ok()).toBe(true);
});

test('Modes: the Console composer shows four modes and Fix needs what is failing', async ({
  page,
}) => {
  // A project of its own, so no other test's sample work is in progress here.
  const created = await page.request.post('/api/projects', {
    headers: HEADERS,
    data: { name: 'Modes fix' },
  });
  expect(created.ok()).toBe(true);
  const project: Project = await created.json();
  const setup = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: {
      detail: 'standard',
      services: { codex: false },
      onboarding: {
        work: 'business',
        detail: 'standard',
        familiarity: 'new',
        resumeAt: 'done',
        completedAt: new Date().toISOString(),
      },
      openProjects: [project.id],
    },
  });
  expect(setup.ok()).toBe(true);
  await page.goto('/');
  await reopenLastProject(page);
  await expect(railOf(page)).toBeVisible();
  // A new project has no thread yet; the rail's New opens one.
  await railOf(page).getByRole('button', { name: 'New', exact: true }).click();
  const modes = page.getByRole('radiogroup', { name: 'Mode' });
  for (const name of ['ask', 'plan', 'build', 'fix'])
    await expect(modes.getByRole('radio', { name, exact: true })).toBeVisible();
  await modes.getByRole('radio', { name: 'fix', exact: true }).click();
  await expect(modes.getByRole('radio', { name: 'fix', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const composer = page.locator('.console .composer');
  await expect(composer.getByLabel('What is failing', { exact: true })).toBeVisible();
  // Send stays focusable while it is not ready, so it says so with aria-disabled.
  const send = composer.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('textbox', { name: 'Message this thread', exact: true }).fill('Fix the patio list');
  await expect(send).toHaveAttribute('aria-disabled', 'true');
  await composer.getByLabel('Paste what went wrong').fill('The list shows the wrong day.');
  await expect(send).toHaveAttribute('aria-disabled', 'false');
  await send.click();
  // The stored turns carry the try. The Console does not draw the Workbook's
  // "Fix, try 1 of 3" chip, so the try is read from the record.
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/projects/${project.id}/state`);
      const state: ProjectState = await response.json();
      const thread = state.conversations.find((c) =>
        c.turns.some((t) => t.role !== 'you' && t.mode === 'fix'),
      );
      const reply = thread?.turns.filter((t) => t.role !== 'you' && t.mode === 'fix').at(-1);
      return { mode: thread?.mode, attempt: reply?.attempt };
    })
    .toEqual({ mode: 'fix', attempt: { n: 1, of: 3 } });
  // The thread keeps its mode: reloading shows it still in Fix.
  await page.reload();
  await expect(railOf(page)).toBeVisible();
  await expect(
    page.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'fix', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#scrThread .turn.dio').last()).toContainText(
    'Started a clearly labelled sample fix.',
  );
});

test('Enter sends from the Console composer and Shift+Enter adds a line', async ({ page }) => {
  await openProject(page);
  await goTo(page, 'Thread');
  await railOf(page).getByRole('button', { name: 'New', exact: true }).click();
  await page
    .getByRole('radiogroup', { name: 'Mode' })
    .getByRole('radio', { name: 'ask', exact: true })
    .click();
  const box = page.getByRole('textbox', { name: 'Message this thread', exact: true });
  const heldText = `Shift+Enter held line ${Date.now()}`;
  await box.fill(heldText);
  await page.keyboard.down('Shift');
  await box.press('Enter');
  await page.keyboard.up('Shift');
  await expect(box).toHaveValue(`${heldText}\n`);
  expect(
    (await projectState(page)).conversations.some((thread) =>
      thread.turns.some((turn) => turn.role === 'you' && turn.text === heldText),
    ),
  ).toBe(false);
  const sentText = `Enter sends this turn ${Date.now()}`;
  await box.fill(sentText);
  await box.press('Enter');
  await expect
    .poll(async () =>
      (await projectState(page)).conversations.some((thread) =>
        thread.turns.some((turn) => turn.role === 'you' && turn.text === sentText),
      ),
    )
    .toBe(true);
});

test('Usage: a settings save preserves a concurrent engine setting while refresh is delayed', async ({
  page,
}) => {
  const created = await page.request.post('/api/projects', {
    headers: HEADERS,
    data: { name: 'Usage concurrent settings' },
  });
  expect(created.ok()).toBe(true);
  const project: Project = await created.json();
  const setup = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: {
      detail: 'standard',
      services: { codex: false },
      onboarding: {
        work: 'business',
        detail: 'standard',
        familiarity: 'new',
        resumeAt: 'done',
        completedAt: new Date().toISOString(),
      },
      openProjects: [project.id],
    },
  });
  expect(setup.ok()).toBe(true);
  await page.goto('/');
  await reopenLastProject(page);
  await expect(railOf(page)).toBeVisible();
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'GET') await refreshReleased;
    await route.continue();
  });
  try {
    // A second client changes the engine while this client's event refresh is in flight.
    const on = await page.request.put('/api/settings', {
      headers: HEADERS,
      data: { services: { codex: true } },
    });
    expect(on.ok()).toBe(true);
    // The Workbook saved its page on every navigation, with a write that named
    // only that field. The Console saves no navigation, so the client save here
    // is the detail menu, which writes the whole settings object this client
    // read before the engine changed. That write is guarded: it is refused
    // rather than allowed to switch the engine back off.
    const menuSave = () =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/settings' &&
          response.request().method() === 'PUT',
      );
    const refused = menuSave();
    await page.getByRole('button', { name: 'Interface detail menu' }).click();
    await page.getByRole('menuitemradio', { name: 'Guided', exact: true }).click();
    expect((await refused).status()).toBe(409);
    await expect(
      page.getByText('Settings changed while this screen was saving. The saved settings were reloaded.'),
    ).toBeVisible();
    let saved = await readSettings(page);
    expect(saved.services?.codex).toBe(true);
    expect(saved.detail).toBe('standard');
    // The refusal carried the saved settings back, so choosing again saves over
    // them, while the refresh is still held, and keeps the engine on.
    const accepted = menuSave();
    await page.getByRole('button', { name: 'Interface detail menu' }).click();
    await page.getByRole('menuitemradio', { name: 'Guided', exact: true }).click();
    expect((await accepted).ok()).toBe(true);
    saved = await readSettings(page);
    expect(saved.detail).toBe('guided');
    expect(saved.services?.codex).toBe(true);
    expectNoRetiredKeys(saved);
  } finally {
    releaseRefresh();
  }
  // The chip sits in the strip over the Projects page.
  await openProjects(page).getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.locator('.usage-chip')).toBeVisible();
  const off = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { services: { codex: false } },
  });
  expect(off.ok()).toBe(true);
});
