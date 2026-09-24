import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Need, Project, ProjectState, Session, Settings, Task } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

/**
 * H17 in the Console: a finished run shows its four-state result in the thread
 * and on the Board. "Not verified" is shown plainly; declaring and running a
 * check gives Verified with its evidence (what, which bytes, when, by whom); a
 * failing check reads Failed verification; an edit to the verified bytes made
 * outside the app reads Verification uncertain on the next load.
 */

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const TASK_NAME = 'Verify the reopening menu';
let originalSettings: Settings | null = null;
let projectId = '';
let taskId = '';
let sessionId = '';
let outputPath = '';
let folder = '';
let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});

test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test.beforeAll(async ({ request }) => {
  const current = await request.get('/api/settings');
  expect(current.ok()).toBe(true);
  originalSettings = (await current.json()) as Settings;
  const setup = await request.put('/api/settings', {
    headers: HEADERS,
    data: {
      onboarding: { resumeAt: 'done', work: 'business', detail: 'guided', familiarity: 'comfortable' },
      detail: 'guided',
    },
  });
  expect(setup.ok()).toBe(true);

  const created = await request.post('/api/projects', { headers: HEADERS, data: { name: 'Verification proof' } });
  expect(created.ok()).toBe(true);
  projectId = ((await created.json()) as Project).id;
  const task = await request.post(`/api/projects/${projectId}/tasks`, { headers: HEADERS, data: { name: TASK_NAME } });
  expect(task.ok()).toBe(true);
  taskId = ((await task.json()) as Task).id;
  const started = await request.post(`/api/projects/${projectId}/work/start`, { headers: HEADERS, data: { taskId } });
  expect(started.ok()).toBe(true);
  sessionId = ((await started.json()) as Session).id;
  const state = await request.get(`/api/projects/${projectId}/state`);
  const need = ((await state.json()) as ProjectState).needs.find((n: Need) => n.state === 'open')!;
  const resolved = await request.post(`/api/projects/${projectId}/needs/${need.id}/resolve`, {
    headers: HEADERS,
    data: { resolution: 'go-ahead', allowForTask: true },
  });
  expect(resolved.ok()).toBe(true);
  let finished: ProjectState | null = null;
  await expect
    .poll(
      async () => {
        const s = await request.get(`/api/projects/${projectId}/state`);
        finished = (await s.json()) as ProjectState;
        return finished.sessions.find((item) => item.id === sessionId)?.state ?? 'queued';
      },
      { timeout: 45_000 },
    )
    .toBe('done');
  const done = finished as unknown as ProjectState;
  folder = done.project.folder;
  outputPath = done.history.find((entry) => entry.sessionId === sessionId && entry.files.length)!.files[0].path;

  const thread = await request.post(`/api/projects/${projectId}/threads`, { headers: HEADERS, data: { taskId } });
  expect(thread.ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  expect(originalSettings).toBeTruthy();
  const restore = await request.put('/api/settings', {
    headers: HEADERS,
    data: JSON.parse(JSON.stringify(originalSettings)),
  });
  expect(restore.ok()).toBe(true);
});

async function openConsole(page: Page) {
  const opened = await page.request.put('/api/settings', { headers: HEADERS, data: { openProjects: [projectId] } });
  expect(opened.ok()).toBe(true);
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
}

const railOf = (page: Page) => page.getByRole('navigation', { name: 'Threads and views', exact: true });

async function openThread(page: Page) {
  await railOf(page).getByRole('button', { name: new RegExp(TASK_NAME) }).click();
  const record = page.locator('.record').filter({ has: page.locator('[data-verification]') }).first();
  await expect(record).toBeVisible();
  return record;
}

async function openBoard(page: Page) {
  await railOf(page).getByRole('button', { name: /^Board\b/ }).click();
  const board = page.locator('.board[aria-label="Board"]');
  await expect(board).toBeVisible();
  return board.locator('.crow', { hasText: TASK_NAME }).first();
}

test('H17-UI-01: a finished run with nothing declared says Not verified, then verifies with evidence', async ({
  page,
}) => {
  await openConsole(page);
  const record = await openThread(page);
  // Folded, the record still says its result plainly.
  await expect(record.locator('[data-verification]')).toHaveText('Not verified');
  await record.getByRole('button', { name: 'show run' }).click();
  const panel = page.locator(`[data-verification-panel="${sessionId}"]`);
  await expect(panel).toContainText('No acceptance checks are declared for this task, so nothing was verified.');
  await expect(panel.getByRole('button', { name: 'Run checks' })).toHaveCount(0);

  // Declare one check from the panel.
  await panel.getByRole('button', { name: 'Checks' }).click();
  await panel.getByLabel('Check kind').selectOption('file-exists');
  await panel.getByLabel('File').fill(outputPath);
  await panel.getByRole('button', { name: 'Add check' }).click();
  await expect(panel.locator('.verif-declared')).toContainText(`${outputPath} exists`);
  await expect(panel.locator('.verif-sentence')).toHaveText('1 acceptance check declared; not run on this run yet.');
  await expect(panel.locator('[data-verification]')).toHaveText('Not verified');

  await panel.getByRole('button', { name: 'Run checks' }).click();
  await expect(panel.locator('[data-verification]')).toHaveText('Verified');
  await expect(panel.locator('.verif-sentence')).toHaveText('1 declared check passed against 1 exact file version.');

  // Evidence: what was checked, against which bytes, when and by whom.
  const evidence = panel.locator('.verif-evidence');
  if (!(await evidence.isVisible())) await panel.getByRole('button', { name: 'Evidence' }).click();
  await expect(evidence).toBeVisible();
  const rows = evidence.locator('.verif-check');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Outputs are the bytes the run wrote');
  await expect(rows.nth(1)).toContainText(`${outputPath} exists`);
  await expect(rows.nth(1).locator('.verif-bytes')).toContainText(new RegExp(`${outputPath} @ [a-f0-9]{12}`));
  await expect(rows.nth(1).locator('.verif-check-meta')).toContainText('application action');
  await expect(rows.nth(1).locator('.verif-check-meta')).toContainText('deterministic check');
  await expect(rows.nth(1).locator('time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/);
  await expect(evidence.locator('.verif-meta')).toContainText('at your request');

  // The Board shows the same result on the task's row.
  const row = await openBoard(page);
  await expect(row.locator('[data-verification]')).toHaveText('Verified');
});

test('H17-UI-02: a failing check reads Failed verification on the Board and in the thread', async ({ page }) => {
  const declared = await page.request.put(`/api/projects/${projectId}/tasks/${taskId}/acceptance`, {
    headers: HEADERS,
    data: {
      checks: [
        { id: 'exists', kind: 'file-exists', path: outputPath },
        { id: 'dessert', kind: 'text-contains', path: outputPath, text: 'A dessert nobody wrote' },
      ],
    },
  });
  expect(declared.ok()).toBe(true);
  const ran = await page.request.post(`/api/projects/${projectId}/sessions/${sessionId}/verification`, {
    headers: HEADERS,
    data: {},
  });
  expect(ran.ok()).toBe(true);
  await openConsole(page);
  const row = await openBoard(page);
  await expect(row.locator('[data-verification]')).toHaveText('Failed verification');
  await expect(row.locator('[data-verification]')).toHaveAttribute('title', /does not contain “A dessert nobody wrote”/);

  const record = await openThread(page);
  await record.getByRole('button', { name: 'show run' }).click();
  const panel = page.locator(`[data-verification-panel="${sessionId}"]`);
  await expect(panel.locator('[data-verification]')).toHaveText('Failed verification');
  await panel.getByRole('button', { name: 'Evidence' }).click();
  await expect(panel.locator('.verif-check.failed')).toContainText('does not contain');
});

test('H17-UI-03: an outside edit to the verified bytes reads Verification uncertain', async ({ page }) => {
  // Back to a passing declaration, verified.
  await page.request.put(`/api/projects/${projectId}/tasks/${taskId}/acceptance`, {
    headers: HEADERS,
    data: { checks: [{ id: 'exists', kind: 'file-exists', path: outputPath }] },
  });
  const ran = await page.request.post(`/api/projects/${projectId}/sessions/${sessionId}/verification`, {
    headers: HEADERS,
    data: {},
  });
  expect(((await ran.json()) as { state: string }).state).toBe('verified');

  await fs.writeFile(path.join(folder, outputPath), 'Edited by hand after verification.\n', 'utf8');
  await openConsole(page);
  const row = await openBoard(page);
  await expect(row.locator('[data-verification]')).toHaveText('Verification uncertain');

  const record = await openThread(page);
  await record.getByRole('button', { name: 'show run' }).click();
  const panel = page.locator(`[data-verification-panel="${sessionId}"]`);
  await expect(panel.locator('.verif-sentence')).toContainText(`${outputPath} changed after verification`);
  await expect(panel.locator('.verif-changed')).toContainText(new RegExp(`${outputPath}: verified [a-f0-9]{12}, now [a-f0-9]{12}`));
});
