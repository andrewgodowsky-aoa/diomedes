import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Need, Project, ProjectState, Session, Settings, Task } from '../shared/types';
import type { ChangeReviewManifest } from '../shared/change-manifest';
import { reopenLastProject } from './fixtures/landing';

/**
 * Automatic Change Review in the Console: a real sample run produces recorded
 * writes; the thread renders the deterministic manifest — plain sentences
 * first, flags, checks, the change list, then evidence one click deeper. The
 * same page also serves the two Business examples through the identical
 * manifest contract.
 */

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const TASK_NAME = 'Review the reopening menu';
let originalSettings: Settings | null = null;
let projectId = '';
let taskId = '';
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
      onboarding: {
        resumeAt: 'done',
        work: 'business',
        detail: 'guided',
        familiarity: 'comfortable',
      },
      surface: 'console',
      detail: 'guided',
    },
  });
  expect(setup.ok()).toBe(true);

  // An ordinary project, not the sample: a Harbor Street project would hide
  // the landing's 'Try the sample project' link for later specs in this run,
  // and projects cannot be deleted through the API.
  const created = await request.post('/api/projects', {
    headers: HEADERS,
    data: { name: 'Change review proof' },
  });
  expect(created.ok()).toBe(true);
  projectId = ((await created.json()) as Project).id;

  const task = await request.post(`/api/projects/${projectId}/tasks`, {
    headers: HEADERS,
    data: { name: TASK_NAME },
  });
  expect(task.ok()).toBe(true);
  taskId = ((await task.json()) as Task).id;

  const started = await request.post(`/api/projects/${projectId}/work/start`, {
    headers: HEADERS,
    data: { taskId },
  });
  expect(started.ok()).toBe(true);
  const session = (await started.json()) as Session;

  // Approve the start need the way a person would, then let the sample finish.
  const state = await request.get(`/api/projects/${projectId}/state`);
  const need = ((await state.json()) as ProjectState).needs.find(
    (n: Need) => n.state === 'open',
  )!;
  const resolved = await request.post(`/api/projects/${projectId}/needs/${need.id}/resolve`, {
    headers: HEADERS,
    data: { resolution: 'go-ahead', allowForTask: true },
  });
  expect(resolved.ok()).toBe(true);
  await expect
    .poll(async () => {
      const s = await request.get(`/api/projects/${projectId}/state`);
      const body = (await s.json()) as ProjectState;
      return body.sessions.find((item) => item.id === session.id)?.state ?? 'queued';
    }, { timeout: 45_000 })
    .toBe('done');

  // A thread attached to the task carries the review; a plain thread does not.
  const taskThread = await request.post(`/api/projects/${projectId}/threads`, {
    headers: HEADERS,
    data: { taskId },
  });
  expect(taskThread.ok()).toBe(true);
  const plainThread = await request.post(`/api/projects/${projectId}/threads`, {
    headers: HEADERS,
    data: { name: 'Front-of-house notes' },
  });
  expect(plainThread.ok()).toBe(true);

  // The manifest the UI will fetch is already deterministic evidence.
  const review = await request.get(
    `/api/projects/${projectId}/change-review/task/${taskId}`,
    { headers: HEADERS },
  );
  expect(review.ok()).toBe(true);
  const manifest = ((await review.json()) as { manifest: ChangeReviewManifest }).manifest;
  expect(manifest.changes.length).toBeGreaterThan(0);

  const opened = await request.put('/api/settings', {
    headers: HEADERS,
    data: { openProjects: [projectId] },
  });
  expect(opened.ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  expect(originalSettings, 'The settings snapshot must exist so onboarding can be restored').toBeTruthy();
  const restore = await request.put('/api/settings', {
    headers: HEADERS,
    data: JSON.parse(JSON.stringify(originalSettings)),
  });
  expect(restore.ok()).toBe(true);
});

async function openConsole(page: Page) {
  const opened = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { surface: 'console', openProjects: [projectId] },
  });
  expect(opened.ok()).toBe(true);
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
}

function railOf(page: Page) {
  return page.getByRole('navigation', { name: 'Threads and views' });
}

test('CR-UI-01: the task thread renders the verified review with evidence drill-down', async ({
  page,
}) => {
  await openConsole(page);
  await railOf(page).getByRole('button', { name: new RegExp(TASK_NAME) }).click();

  const review = page.locator('.crev');
  await expect(review).toBeVisible();
  await expect(review.getByRole('heading', { name: 'What changed' })).toBeVisible();
  await expect(review.getByText('Deterministic · no AI model wrote this')).toBeVisible();

  // Plain sentences first: the file count the records prove.
  await expect(review.locator('.crev-sentences li').first()).toContainText(/files? changed/);

  // Checks render with their distinct states; nothing is silently passed.
  const checks = review.locator('.crev-check');
  await expect(checks.first()).toBeVisible();
  await expect(review.locator('.crev-check-state.passed').first()).toBeVisible();

  // The change list names the files the run wrote; one click shows evidence.
  const rows = review.locator('.crev-row');
  expect(await rows.count()).toBeGreaterThan(0);
  await rows.first().locator('.crev-path').click();
  await expect(rows.first().locator('.crev-evidence')).toBeVisible();
  await expect(rows.first().locator('.crev-refs li').first()).toContainText(/history-entry|file-record/);

  // Technical detail stays one click deeper: digest, rules version, baseline.
  const disclosure = review.getByRole('button', { name: 'Technical details' });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const technical = review.locator('.crev-technical');
  await expect(technical).toBeVisible();
  await expect(technical).toContainText(/sha256:/);
  await expect(technical).toContainText(/Rules/);
});

test('CR-UI-02: a plain thread serves the two business examples through the same review', async ({
  page,
}) => {
  await openConsole(page);
  await railOf(page).getByRole('button', { name: /Front-of-house notes/ }).click();

  // No review exists for a plain thread — only the example affordance.
  await page.getByRole('button', { name: 'a restaurant report' }).click();
  const review = page.locator('.crev');
  await expect(review).toBeVisible();
  await expect(review).toContainText('Example review');
  // The link that opened the example is gone, so focus lands on its Close.
  await expect(review.getByRole('button', { name: 'Close' })).toBeFocused();
  await expect(review.locator('.crev-sentences')).toContainText(
    'Monday 7:00 AM → Monday 6:00 AM',
  );
  await expect(review.locator('.crev-sentences')).toContainText('General Manager');
  await expect(review.locator('.crev-attention')).toContainText('Recipients changed');
  // The same drill-down contract: structured fields carry before → after.
  const row = review.locator('.crev-row').first();
  await row.locator('.crev-path').click();
  await expect(row.locator('.crev-fields')).toContainText('Schedule');
  await expect(row.locator('.crev-refs')).toContainText('structured');

  // The second domain reuses the identical mechanism. Close returns the
  // affordance; sensitive values never render.
  await review.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'a restaurant report' })).toBeFocused();
  await page.getByRole('button', { name: 'a business automation' }).click();
  await expect(review.locator('.crev-sentences')).toContainText('On → Off');
  await expect(review.locator('.crev-sentences')).toContainText('Service key changed');
  await expect(review).not.toContainText('nk-live');
});

test('CR-UI-03: failed, not-run and binary render as what they are', async ({
  page,
  request,
}) => {
  // The software pack admits the three command checks — always 'Not run',
  // since automatic review never executes project code.
  const pack = await request.post(
    `/api/projects/${projectId}/packs/diomedes.software-engineering/activate`,
    { headers: HEADERS },
  );
  expect(pack.ok()).toBe(true);

  const task = await request.post(`/api/projects/${projectId}/tasks`, {
    headers: HEADERS,
    data: { name: 'Second pass' },
  });
  const taskId2 = ((await task.json()) as Task).id;
  const started = await request.post(`/api/projects/${projectId}/work/start`, {
    headers: HEADERS,
    data: { taskId: taskId2 },
  });
  expect(started.ok()).toBe(true);

  // The baseline is awaited inside work/start, so writes now land inside the
  // window: a conflict-marker file fails the scan, a binary file is observed.
  const projState = await request.get(`/api/projects/${projectId}/state`);
  const folder = ((await projState.json()) as ProjectState).project.folder;
  await fs.writeFile(
    path.join(folder, 'conflicted.md'),
    'line\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n',
  );
  await fs.writeFile(
    path.join(folder, 'blob.bin'),
    Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]),
  );

  const need = ((await (await request.get(`/api/projects/${projectId}/state`)).json()) as ProjectState).needs.find(
    (n: Need) => n.state === 'open',
  )!;
  const resolved = await request.post(
    `/api/projects/${projectId}/needs/${need.id}/resolve`,
    { headers: HEADERS, data: { resolution: 'go-ahead', allowForTask: true } },
  );
  expect(resolved.ok()).toBe(true);
  await expect
    .poll(async () => {
      const s = await request.get(`/api/projects/${projectId}/state`);
      const body = (await s.json()) as ProjectState;
      return body.sessions.find((item) => item.taskId === taskId2)?.state ?? 'queued';
    }, { timeout: 45_000 })
    .toBe('done');

  const thread = await request.post(`/api/projects/${projectId}/threads`, {
    headers: HEADERS,
    data: { taskId: taskId2 },
  });
  expect(thread.ok()).toBe(true);

  await openConsole(page);
  await railOf(page).getByRole('button', { name: /Second pass/ }).click();
  const review = page.locator('.crev');
  await expect(review).toBeVisible();

  // Failed and Not run are separate rendered states — not a CSS nicety.
  const failed = review.locator('.crev-check-state.failed');
  await expect(failed.first()).toBeVisible();
  await expect(failed.first()).toHaveText('Failed');
  const notRun = review.locator('.crev-check-state.not-run');
  await expect(notRun.first()).toBeVisible();
  await expect(notRun.first()).toHaveText('Not run');
  expect(await notRun.count()).toBe(3); // typecheck, unit-tests, production-build
  // The failed one is the conflict scan on the marker file.
  await expect(review.locator('.crev-check.failed')).toContainText('conflict');

  // The binary change shows metadata, never bytes.
  const binRow = review.locator('.crev-row', { hasText: 'blob.bin' });
  await expect(binRow.locator('.crev-observed', { hasText: 'binary' })).toBeVisible();
  await binRow.locator('.crev-path').click();
  await expect(binRow.locator('.crev-evidence')).toContainText('never raw bytes');
  await expect(binRow.locator('.crev-patch')).toHaveCount(0);
});
