import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project, ProjectState, Task } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

// Board workflow through the real built UI against an owned host, on the
// sample route only: no model calls. Setup goes through the API; every claim
// about the Board is read from the Board, and every claim about the work from
// the records. The Board's drag, Move menu and inspector share one move table
// (shared/board-moves.ts), so this spec proves the workflow rides those same
// commands: Inbox accepts into Ready, and nothing else moves a gated task.

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const PARENT = 'Draft the rota proposal';
const CHILD = 'Cost the weekend cover';
const LIVE = 'File the supplier note';
const RUN = 'Walk the sample shift';
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';
let project: Project;
let parentId = '';

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${route} failed: ${JSON.stringify(payload)}`);
  return payload as T;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'task-workflow-ui-'));
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
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  const source = Math.max(
    ...(await Promise.all(
      [
        'client/console/BoardView.tsx',
        'client/console/TaskInspector.tsx',
        'client/console/TaskWorkflowPanel.tsx',
        'shared/board-moves.ts',
        'shared/task-workflow.ts',
      ].map(async (file) => (await fs.stat(file)).mtimeMs),
    )),
  );
  expect(built, 'dist is older than the workflow sources. Run "npx vite build" first.').toBeGreaterThan(source);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', application);

  project = await api<Project>('/projects/sample', 'POST', {});
  const initial = await api<ProjectState>(`/projects/${project.id}/state`);
  for (const task of initial.tasks) await api(`/projects/${project.id}/tasks/${task.id}`, 'DELETE');
  const parent = await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name: PARENT,
    description: 'Plan next week rota, then cost it as a separate result.',
  });
  parentId = parent.id;
  await api(`/projects/${project.id}/packs/diomedes.small-business/activate`, 'POST', {});
  await api('/settings', 'PUT', {
    detail: 'technical',
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
    openProjects: [project.id],
  });
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  }
});

const board = (page: Page) => page.locator('.board[aria-label="Board"]');
const column = (page: Page, name: string) => board(page).locator(`.column[aria-label="${name}"]`);
const card = (page: Page, col: string, name: string) => column(page, col).locator('.crow', { hasText: name });
const records = () => api<ProjectState>(`/projects/${project.id}/state`);
const workflowOf = async (id: string) => (await records()).tasks.find((task) => task.id === id)!.workflow;

async function openBoard(page: Page) {
  await page.goto(baseURL);
  await reopenLastProject(page);
  await page.getByRole('navigation', { name: 'Threads and views' }).getByRole('button', { name: /^Board/ }).click();
  await expect(board(page)).toBeVisible();
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => !/^(nv|dm)-view/.test((animation as CSSAnimation).animationName ?? '')),
  );
}

async function openInspector(page: Page, col: string, name: string) {
  await card(page, col, name).getByRole('button', { name, exact: true }).click();
  const inspector = page.getByRole('dialog', { name });
  await expect(inspector).toBeVisible();
  return inspector;
}

/** Same DataTransfer dispatch as tests/task-board-ui.spec.ts: what the browser delivers to the Board. */
async function drag(page: Page, col: string, name: string, to: string): Promise<string> {
  const source = card(page, col, name);
  const target = column(page, to);
  await expect(source).toHaveAttribute('draggable', 'true');
  const node = await source.elementHandle();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent('dragstart', { dataTransfer: transfer });
    await target.dispatchEvent('dragenter', { dataTransfer: transfer });
    await target.dispatchEvent('dragover', { dataTransfer: transfer });
    await expect(target).toHaveClass(/\bdrop-over\b/);
    const said = (await target.locator('.why').textContent()) ?? '';
    await target.dispatchEvent('drop', { dataTransfer: transfer });
    await node!.dispatchEvent('dragend', { dataTransfer: transfer });
    return said;
  } finally {
    await node?.dispose();
    await transfer.dispose();
  }
}

test('task permission controls name the turn budget and persist the continuation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const inspector = await openInspector(page, 'Ready', PARENT);
  const panel = inspector.locator('.ti-workflow');
  await expect(panel).toBeVisible();
  // A task that never set a workflow reads as not configured yet.
  await expect(panel).toContainText('Choose how the Nectovia work loop continues');
  const permission = panel.getByRole('combobox', { name: 'Task permission' });
  await expect(permission).toHaveValue('');
  // The budget is action turns, not model turns.
  const turns = panel.getByRole('spinbutton', { name: 'Maximum action turns' });
  await expect(turns).toHaveValue('8');

  await permission.selectOption('full-approval');
  await expect(permission).toHaveValue('full-approval');
  // The choice persisted through the live state refresh, without a reload.
  await expect.poll(async () => (await workflowOf(parentId))?.continuation).toBe('full-approval');
  await expect.poll(async () => (await workflowOf(parentId))?.revision).toBeGreaterThan(1);
  const playbook = panel.getByRole('combobox', { name: 'Playbook (optional)' });
  await expect(playbook.getByRole('option', { name: /Cash flow snapshot/ })).toBeAttached();
  await playbook.selectOption('diomedes.small-business/cash-flow-snapshot');
  await expect.poll(async () => (await workflowOf(parentId))?.skill).toEqual({
    packId: 'diomedes.small-business', skillId: 'cash-flow-snapshot',
  });
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('a branched child waits in Inbox and Accept moves it to Ready without a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  // Branch through the API; the Inbox card arrives over the live board update.
  const child = await api<Task>(`/projects/${project.id}/tasks/${parentId}/children`, 'POST', {
    commandId: 'workflow-ui-child-one',
    name: CHILD,
    output: 'The weekend cost, separate from the rota.',
  });
  await expect(card(page, 'Inbox', CHILD)).toBeVisible();

  const inspector = await openInspector(page, 'Inbox', CHILD);
  await inspector.locator('.ti-workflow').getByRole('button', { name: 'Accept task', exact: true }).click();
  await expect(card(page, 'Ready', CHILD)).toBeVisible();
  expect((await workflowOf(child.id))?.inbox).toBe(false);

  // The task controls persist beside the workflow: it still starts like any Ready task.
  await page.keyboard.press('Escape');
  const again = await openInspector(page, 'Ready', CHILD);
  await expect(again.locator('.ti-workflow')).toBeVisible();
  await expect(again.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('the Inbox card shares the Board command rules: only Accept, and a drag elsewhere is refused', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sent: string[] = [];
  const prefix = `/api/projects/${project.id}`;
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET' && pathname.startsWith(`${prefix}/`))
      sent.push(`${request.method()} ${pathname.slice(prefix.length)}`);
  });
  const commands = () => sent.filter((line) => /^\w+ \/(tasks|work|needs)\//.test(line));
  await openBoard(page);

  // The keyboard's way: the Move menu offers Accept to Ready and refuses Working by hand.
  // The earlier child was accepted above, so this test branches one of its own.
  const fresh = 'Price the night cover';
  await api<Task>(`/projects/${project.id}/tasks/${parentId}/children`, 'POST', {
    commandId: 'workflow-ui-child-two',
    name: fresh,
    output: 'The night cost, separate from the rota.',
  });
  await expect(card(page, 'Inbox', fresh)).toBeVisible();
  await card(page, 'Inbox', fresh).hover();
  await card(page, 'Inbox', fresh).getByRole('button', { name: 'Move', exact: true }).click();
  const menu = card(page, 'Inbox', fresh).getByRole('group', { name: `Move ${fresh} to` });
  await expect(menu.getByRole('button', { name: /^Ready/ })).toContainText('Accept');
  await expect(menu.getByRole('button', { name: /^Working/ })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  // The drag's way: Inbox to Working is refused on the card, and nothing is sent.
  const before = commands();
  expect(await drag(page, 'Inbox', fresh, 'Working')).toBe('Accept this task into Ready first.');
  await expect(card(page, 'Inbox', fresh).getByRole('alert')).toHaveText('Accept this task into Ready first.');
  expect(commands()).toEqual(before);
  expect(errors).toEqual([]);
});

test('the source conversation link opens the original message', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const thread = await api<{ id: string }>(`/projects/${project.id}/threads`, 'POST', { name: 'Original board request' });
  // Seed the source record as a trusted conversation creation would; the
  // separate admission suite proves HTTP cannot forge this field.
  const store = application!.locals.store;
  await store.locked(async () => {
    const state = store.state(project.id);
    const task = state.tasks.find((item: Task) => item.id === parentId)!;
    task.origin = { projectId: project.id, threadId: thread.id, turnId: 'U-source-board' };
    state.conversations.find((item: { id: string }) => item.id === thread.id)!.turns.push({
      id: 'U-source-board', role: 'you', mode: 'ask', text: 'Compare weekend and night cover costs.',
      at: new Date().toISOString(), sources: [],
    });
    await store.persist(state);
  });
  await openBoard(page);
  const inspector = await openInspector(page, 'Ready', PARENT);
  await inspector.getByRole('button', { name: 'Open source conversation' }).click();
  await expect(page.locator('#turn-U-source-board')).toContainText('Compare weekend and night cover costs.');
  await expect(page.locator('#turn-U-source-board')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a chosen playbook stays selected when the composer changes to Build and is sent with the request', async ({ page }) => {
  await openBoard(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Find and act' });
  await palette.getByRole('textbox').fill('cash flow');
  await palette.getByRole('listitem').filter({ hasText: 'Cash flow snapshot' }).getByRole('button', { name: 'Use', exact: true }).click();
  const removeSkill = page.getByRole('button', { name: 'Remove the Cash flow snapshot playbook' });
  await expect(removeSkill).toBeVisible();
  await page.getByRole('radio', { name: 'build', exact: true }).click();
  await expect(removeSkill).toBeVisible();
  // Capture the real composer payload; native delivery is tested through the
  // API and adapter in small-business-skills.test.ts.
  let sent: { mode?: string; skill?: string } | undefined;
  await page.route(`**/api/projects/${project.id}/ask`, async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { error: 'Captured the request for this UI check.' } });
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => sent).toMatchObject({ mode: 'build', skill: 'cash-flow-snapshot' });
});

test('the board updates live and phase approval for a running task stays in Review', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const approvedCalls: string[] = [];
  page.on('request', (request) => {
    if (/\/approve-phase$/.test(new URL(request.url()).pathname)) approvedCalls.push(request.url());
  });
  await openBoard(page);

  // Created after the Board opened: it arrives without a reload.
  await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name: LIVE, description: 'Live board check.' });
  await expect(card(page, 'Ready', LIVE)).toBeVisible();

  // An active native run goes through Review's existing Need system:
  // no custom approve call while the run is active.
  await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name: RUN, description: 'Sample run check.' });
  const runId = (await records()).tasks.find((task) => task.name === RUN)!.id;
  await api(`/projects/${project.id}/tasks/${runId}/workflow`, 'PUT', {
    expectedRevision: 1, continuation: 'stop-on-phase-change', maxTurns: 8,
  });
  const started = await fetch(`${baseURL}/api/projects/${project.id}/work/start`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ protocolVersion: 1, commandId: 'workflow-ui-sample-run', taskId: runId, route: 'sample' }),
  });
  if (!started.ok) throw new Error(`work start failed: ${await started.text()}`);
  await expect(card(page, 'Review', RUN)).toBeVisible();
  const inspector = await openInspector(page, 'Review', RUN);
  await expect(inspector.locator('.ti-workflow')).toBeVisible();
  // The workflow controls wait for the run: nothing custom approves it mid-run.
  await expect(inspector.locator('.ti-workflow').getByRole('button', { name: 'Approve next phase' })).toHaveCount(0);
  await expect(inspector.locator('.ti-workflow').getByRole('button', { name: 'Review phase approval' })).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  expect(approvedCalls).toEqual([]);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
