import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project, ProjectState, TaskCandidate } from '../shared/types';

/**
 * Deterministic browser proof for `Approve for me` using the real built UI and
 * the real backend routes. Both the worker and the reviewer are synthetic
 * fixtures: this proves the authority path, not a model's judgement, and it
 * spends no provider call or quota. No route is stubbed - grants, reviews,
 * approvals and writes all reach the owned host below.
 */
async function expectFreshBundle(dist: string): Promise<void> {
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  let newest = 0;
  let newestPath = '';
  async function visit(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await visit(full);
        continue;
      }
      if (!entry.isFile() || !/\.(ts|tsx|js|css)$/.test(entry.name)) continue;
      const { mtimeMs } = await fs.stat(full);
      if (mtimeMs > newest) {
        newest = mtimeMs;
        newestPath = path.relative(process.cwd(), full);
      }
    }
  }
  for (const dir of ['client', 'shared']) await visit(path.resolve(dir));
  expect(
    built,
    `dist is older than ${newestPath}, so this spec would test the previous build. Run "npm run build" first.`,
  ).toBeGreaterThan(newest);
}

test.describe.configure({ mode: 'serial' });

const WORKER_MODEL = 'synthetic-worker-fixture-model';
const REVIEWER_MODEL = 'synthetic-reviewer-fixture-model';
const EVIDENCE = path.resolve('evidence/reviewer');
const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';
let savedCodexHome: string | undefined;
let reviewerCalls = 0;
let verdict: { decision: string; reason: string; note?: string } | 'unavailable' = {
  decision: 'approve',
  reason: 'matches-request',
  note: 'Creates the note the task asked for.',
};
let proposalName = 'Reviewed-note.md';

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(`Reviewer fixture ${route} failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  await fs.mkdir(EVIDENCE, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'reviewer-ui-'));
  // A fixed reviewer model list, so the picker does not read the real account.
  const codexHome = path.join(fixtureRoot, 'codex');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, 'models_cache.json'),
    JSON.stringify({
      models: [
        {
          slug: 'fixture-reviewer-a',
          display_name: 'Fixture reviewer A',
          visibility: 'list',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }],
        },
        {
          slug: 'fixture-reviewer-b',
          display_name: 'Fixture reviewer B',
          visibility: 'list',
          default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
        },
      ],
    }),
    'utf8',
  );
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  baseURL = `http://127.0.0.1:${port}`;
  application = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(fixtureRoot, 'data'),
    projectRoot: path.join(fixtureRoot, 'projects'),
    nativeGenerator: async () => ({
      model: WORKER_MODEL,
      text: JSON.stringify({
        summary: 'Add one reviewed fixture note.',
        changes: [
          {
            path: proposalName,
            text: `# Reviewed note\n\nWritten under Approve for me: ${proposalName}\n`,
            summary: 'Create the reviewed note.',
          },
        ],
      }),
    }),
    reviewerAdapter: async () => {
      reviewerCalls += 1;
      if (verdict === 'unavailable') throw new Error('The fixture reviewer is offline.');
      return { text: JSON.stringify(verdict), model: REVIEWER_MODEL, threadId: 'fixture-review' };
    },
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  await expectFreshBundle(dist);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server.on('request', application);
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
});

async function makeTaskProject(taskName: string) {
  const project = await api<Project>('/projects/sample', 'POST', {});
  const { found } = await api<{ found: TaskCandidate[] }>(
    `/projects/${project.id}/plans/find-tasks`,
    'POST',
    { path: 'Reopening plan.md' },
  );
  const created = await api<{ tasks: { id: string }[] }>(
    `/projects/${project.id}/plans/add-tasks`,
    'POST',
    { path: 'Reopening plan.md', items: [{ ...found[0], name: taskName }] },
  );
  const taskId = created.tasks[0].id;
  await api(`/projects/${project.id}/threads`, 'POST', {
    taskId,
    name: taskName,
    permission: 'show-first',
    engine: 'codex',
  });
  await api('/settings', 'PUT', {
    surface: 'console',
    detail: 'technical',
    services: { codex: true, defaultEngine: 'codex' },
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
    openProjects: [project.id],
  });
  return { project, taskId };
}
function rail(page: Page) {
  return page.getByRole('navigation', { name: 'Threads and views' });
}
async function startFromBoard(page: Page, taskName: string): Promise<void> {
  await rail(page).getByRole('button', { name: /^Board/ }).click();
  const board = page.locator('.board[aria-label="Board"]');
  await expect(board).toBeVisible();
  const row = board.locator('.crow', { hasText: taskName }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Start', exact: true }).first().click();
  const confirm = row.locator('.confirm');
  await expect(confirm.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: 'Start', exact: true }).click();
}
async function openThread(page: Page, taskName: string): Promise<void> {
  await rail(page)
    .getByRole('button', { name: new RegExp(taskName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .first()
    .click();
  await expect(page.locator('#scrThread')).toBeVisible();
}

test('the four choices are offered honestly, and Full access says why it is not', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const taskName = 'Reviewer choice task';
  await makeTaskProject(taskName);
  await page.goto(baseURL);
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
  await startFromBoard(page, taskName);
  await openThread(page, taskName);
  await expect(page.getByRole('region', { name: 'Needs your OK' })).toBeVisible({
    timeout: 20_000,
  });
  await page.locator('.task-permission').getByRole('button', { name: 'Review changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Task permissions' });
  await expect(dialog).toBeVisible();
  const group = dialog.getByRole('radiogroup', { name: 'Permission for this task' });
  for (const name of ['Review changes', 'Work in this project', 'Approve for me', 'Full access'])
    await expect(group.getByText(name, { exact: true })).toBeVisible();
  // Full access is refused with its reason on the page, not in a tooltip.
  await expect(group.getByRole('radio', { name: /Full access/ })).toBeDisabled();
  await expect(dialog.getByText(/Full access is unavailable for Codex/)).toBeVisible();
  await expect(
    dialog.getByText(/A disabled-tools flag, a prompt instruction or a git worktree is not containment\./),
  ).toBeVisible();
  // The environment question is answered on the row, not hidden behind a control
  // the person cannot select.
  await expect(dialog.getByText('Which environment would receive this?')).toBeVisible();
  await expect(
    dialog.getByText(/There is no isolated environment on this installation/),
  ).toBeVisible();
  await dialog.getByText('What it would take', { exact: true }).click();
  await expect(
    dialog.getByText('No isolated execution environment is available on this installation.'),
  ).toBeVisible();
  // Approve for me says what it does and does not add.
  await group.getByRole('radio', { name: /Approve for me/ }).check();
  await expect(
    dialog.getByText(/does not increase file, tool, command or network permission/),
  ).toBeVisible();
  await expect(dialog.getByText(/never widen what is allowed/)).toBeVisible();
  await expect(dialog.getByText(/never recorded as your approval/)).toBeVisible();
  await expect(dialog.getByText(/It may use the same account and the same model as the worker/)).toBeVisible();
  await expect(dialog.getByLabel('Reviewer model')).toBeVisible();
  await expect(dialog.getByRole('option', { name: 'fixture-reviewer-a' })).toBeAttached();
  await page.screenshot({
    path: testInfo.outputPath('reviewer-permission-panel.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(EVIDENCE, 'reviewer-permission-panel.png'),
    animations: 'disabled',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test('an eligible change set is applied after a reviewer approval, recorded as a model decision', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  verdict = { decision: 'approve', reason: 'matches-request', note: 'Creates the note the task asked for.' };
  proposalName = 'Reviewer-approved.md';
  reviewerCalls = 0;
  const taskName = 'Reviewer approve task';
  const { project } = await makeTaskProject(taskName);
  await page.goto(baseURL);
  await startFromBoard(page, taskName);
  await openThread(page, taskName);
  const need = page.getByRole('region', { name: 'Needs your OK' });
  await expect(need).toBeVisible({ timeout: 20_000 });

  // Confirm Approve for me through the real panel.
  await page.locator('.task-permission').getByRole('button', { name: 'Review changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Task permissions' });
  await dialog
    .getByRole('radiogroup', { name: 'Permission for this task' })
    .getByRole('radio', { name: /Approve for me/ })
    .check();
  await dialog.getByLabel('Reviewer model').selectOption('fixture-reviewer-b');
  await expect(dialog.getByText(/Each change set goes to the reviewer first/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm task scope' }).click();
  await expect(
    page.locator('.task-permission').getByRole('button', { name: 'Approve for me' }),
  ).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');

  // The waiting change set is reviewed and applied with no further click.
  await expect
    .poll(async () => fs.readFile(path.join(project.folder, proposalName), 'utf8').catch(() => ''), {
      timeout: 25_000,
    })
    .toContain('Written under Approve for me');
  expect(reviewerCalls).toBe(1);
  await page.reload();
  await openThread(page, taskName);
  const record = page.getByLabel('Approval record').first();
  await expect(record).toContainText('Scope-matched changes applied');
  await record.getByText('Reviewer record', { exact: true }).click();
  const reviewer = record.getByRole('group', { name: 'Reviewer record' });
  await expect(reviewer).toContainText('Approved by a separate model reviewer');
  await expect(reviewer).toContainText('You did not review this output');
  await expect(reviewer).toContainText('model-reviewer');
  await expect(reviewer).toContainText(REVIEWER_MODEL);
  await expect(reviewer).toContainText('fixture-reviewer-b');
  await expect(reviewer).toContainText(WORKER_MODEL);
  await page.screenshot({
    path: testInfo.outputPath('reviewer-record.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(EVIDENCE, 'reviewer-record.png'),
    animations: 'disabled',
    fullPage: true,
  });
  // The scope-matched decision record says where authority came from, and
  // leaves every reviewer fact to the reviewer's own record above it: one
  // statement each, never the same assurance twice in one block.
  await record.getByText('Decision record', { exact: true }).click();
  await expect(record).toContainText('Authorization came from the scope you confirmed');
  expect(
    (await record.innerText()).match(/did not review this output/gi)?.length ?? 0,
  ).toBe(1);
  const state = await api<ProjectState>(`/projects/${project.id}/state`);
  const applied = state.needs.at(-1)!;
  expect(applied.authorization?.reviewId).toBe(applied.reviews![0].id);
  expect(applied.approvalReceipt).toBeUndefined();
  expect(errors).toEqual([]);
});

test('a reviewer that asks for you leaves the change set as Needs you, and you can still decide', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  verdict = { decision: 'require-human', reason: 'needs-judgement', note: 'This rewrites more than the task described.' };
  proposalName = 'Reviewer-held.md';
  reviewerCalls = 0;
  const taskName = 'Reviewer hold task';
  const { project, taskId } = await makeTaskProject(taskName);
  // Confirm the reviewer scope up front, through the real route.
  await api(`/projects/${project.id}/permissions/grants`, 'POST', {
    protocolVersion: 2,
    commandId: crypto.randomUUID(),
    taskId,
    roots: ['.'],
    operations: ['text.create', 'text.modify'],
    engine: 'codex',
    accountRoute: 'codex:chatgpt',
    maxWrites: 10,
    maxBytes: 200_000,
    ttlMinutes: 60,
    review: 'model-reviewer',
    reviewer: { requestedModel: 'fixture-reviewer-a', maxReviews: 5 },
  });
  await page.goto(baseURL);
  await startFromBoard(page, taskName);
  await openThread(page, taskName);
  const need = page.getByRole('region', { name: 'Needs your OK' });
  await expect(need).toBeVisible({ timeout: 20_000 });
  await expect(need).toContainText('A separate reviewer asked you to decide this change set', {
    timeout: 25_000,
  });
  await expect(need).toContainText('This rewrites more than the task described.');
  await expect(need).toContainText('you can still decide it yourself');
  expect(reviewerCalls).toBe(1);
  await expect(async () => {
    await fs.stat(path.join(project.folder, proposalName));
  }).rejects.toThrow();
  await page.screenshot({
    path: testInfo.outputPath('reviewer-needs-you.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(EVIDENCE, 'reviewer-needs-you.png'),
    animations: 'disabled',
    fullPage: true,
  });
  // Narrow viewport: the reviewer's own words must not push the page sideways.
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(need).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  // The person's own decision still works, and stays their own receipt.
  await need.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect(page.getByText('Approved changes applied. Their versions are in History.')).toBeVisible(
    { timeout: 20_000 },
  );
  expect(await fs.readFile(path.join(project.folder, proposalName), 'utf8')).toContain(
    'Written under Approve for me',
  );
  const state = await api<ProjectState>(`/projects/${project.id}/state`);
  const decided = state.needs.at(-1)!;
  expect(decided.approvalReceipt?.actor).toBe('local-client');
  expect(decided.authorization).toBeUndefined();
  expect(decided.reviews).toHaveLength(1);
  expect(decided.reviews![0].decision).toBe('require-human');
  expect(errors).toEqual([]);
});

test('an unavailable reviewer falls back to you, and an off connection makes the option unofferable', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  verdict = 'unavailable';
  proposalName = 'Reviewer-offline.md';
  reviewerCalls = 0;
  const taskName = 'Reviewer offline task';
  const { project, taskId } = await makeTaskProject(taskName);
  await api(`/projects/${project.id}/permissions/grants`, 'POST', {
    protocolVersion: 2,
    commandId: crypto.randomUUID(),
    taskId,
    roots: ['.'],
    operations: ['text.create', 'text.modify'],
    engine: 'codex',
    accountRoute: 'codex:chatgpt',
    maxWrites: 10,
    maxBytes: 200_000,
    ttlMinutes: 60,
    review: 'model-reviewer',
    reviewer: { requestedModel: null, maxReviews: 5 },
  });
  await page.goto(baseURL);
  await startFromBoard(page, taskName);
  await openThread(page, taskName);
  const need = page.getByRole('region', { name: 'Needs your OK' });
  await expect(need).toBeVisible({ timeout: 20_000 });
  await expect(need).toContainText('A separate reviewer could not decide, so this waits for you', {
    timeout: 25_000,
  });
  expect(reviewerCalls).toBe(1);
  await expect(async () => {
    await fs.stat(path.join(project.folder, proposalName));
  }).rejects.toThrow();
  const state = await api<ProjectState>(`/projects/${project.id}/state`);
  expect(state.needs.at(-1)?.reviews![0].reasonCode).toBe('unavailable');
  expect(state.needs.at(-1)?.authorization).toBeUndefined();
  await page.screenshot({
    path: testInfo.outputPath('reviewer-unavailable.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(EVIDENCE, 'reviewer-unavailable.png'),
    animations: 'disabled',
    fullPage: true,
  });

  // With the Codex connection off, the option cannot be chosen at all.
  await api('/settings', 'PUT', { services: { codex: false, defaultEngine: 'codex' } });
  await page.reload();
  await openThread(page, taskName);
  await page.locator('.task-permission').getByRole('button', { name: 'Approve for me' }).click();
  const dialog = page.getByRole('dialog', { name: 'Task permissions' });
  const group = dialog.getByRole('radiogroup', { name: 'Permission for this task' });
  await expect(group.getByRole('radio', { name: /Approve for me/ })).toBeDisabled();
  await expect(dialog.getByText(/Turn on the Codex connection/)).toBeVisible();
  await api('/settings', 'PUT', { services: { codex: true, defaultEngine: 'codex' } });
  expect(errors).toEqual([]);
});
