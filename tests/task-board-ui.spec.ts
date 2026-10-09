import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project, ProjectState, Task, TeamMember } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

// The executable Board (research 2026-09-26): a card opens in full over the Board, a drag or the
// card's Move menu asks for one of the Board's own commands, and a move the Board cannot make is
// refused on the card with the reason while the records stay as they were. The real built UI
// against an owned host, on the sample route only: no model calls. Setup goes through the API;
// every claim about the Board is read from the Board, and every claim about the work from the
// records.

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const TASK = 'Compare supplier quotes';
const ENGINEERING_PACK = 'diomedes.software-engineering';
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';
let project: Project;

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
  fixtureRoot = await fs.mkdtemp(path.join(results, 'task-board-ui-'));
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
      ['client/console/BoardView.tsx', 'client/console/TaskInspector.tsx', 'shared/board-moves.ts'].map(
        async (file) => (await fs.stat(file)).mtimeMs,
      ),
    )),
  );
  expect(built, 'dist is older than the Board sources. Run "npx vite build" first.').toBeGreaterThan(source);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', application);

  project = await api<Project>('/projects/sample', 'POST', {});
  const initial = await api<ProjectState>(`/projects/${project.id}/state`);
  for (const task of initial.tasks) await api(`/projects/${project.id}/tasks/${task.id}`, 'DELETE');
  await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name: TASK,
    description: 'Read the three quotes, note what changed since last month, and recommend one.',
  });
  await api('/settings', 'PUT', {
    onboarding: {
      work: 'business',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
    openProjects: [project.id],
  });
  // The technical view, which offers the task's own profile choice, comes with the Software
  // Engineering pack (QUESTIONS.md R17).
  await api(`/projects/${project.id}/packs/${ENGINEERING_PACK}/activate`, 'POST');
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
const card = (page: Page, name: string) => column(page, name).locator('.crow', { hasText: TASK });
const records = () => api<ProjectState>(`/projects/${project.id}/state`);

const REVIEW_BY_HAND =
  'A run moves to Review when it has something for you to decide. Moving the card does not finish the run.';

async function openBoard(page: Page) {
  await page.goto(baseURL);
  await reopenLastProject(page);
  await page.getByRole('navigation', { name: 'Threads and views' }).getByRole('button', { name: /^Board/ }).click();
  await expect(board(page)).toBeVisible();
  // The view has arrived. Its entrance moves the Board sideways in steps and holds still between
  // them, which a pointer's own stability check reads as settled.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => !/^(nv|dm)-view/.test((animation as CSSAnimation).animationName ?? '')),
  );
}

/**
 * A drag from one column to another as the browser delivers it to the Board: dragstart on the
 * card, dragenter and dragover on the column, then the drop and the card's dragend, over one
 * DataTransfer (as files-attachments-ui.spec.ts drops files). Dispatched rather than pointed: a
 * pointer drag's timing over the sideways-scrolling Board is the browser's, and hovering a tall
 * column scrolls it to the centre mid-drag. The card must be draggable, as a pointer drag needs.
 * Returns what the column under the pointer said before the drop.
 */
async function drag(page: Page, from: string, to: string): Promise<string> {
  const source = card(page, from);
  const target = column(page, to);
  await expect(source).toHaveAttribute('draggable', 'true');
  const node = await source.elementHandle();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent('dragstart', { dataTransfer: transfer });
    await target.dispatchEvent('dragenter', { dataTransfer: transfer });
    await target.dispatchEvent('dragover', { dataTransfer: transfer });
    // The column took the drag, and says in words what a drop there would ask for.
    await expect(target).toHaveClass(/\bdrop-over\b/);
    const said = (await target.locator('.why').textContent()) ?? '';
    await target.dispatchEvent('drop', { dataTransfer: transfer });
    // The card that was picked up hears the drag end, wherever the drop sent it.
    await node!.dispatchEvent('dragend', { dataTransfer: transfer });
    return said;
  } finally {
    await node?.dispose();
    await transfer.dispose();
  }
}

test('a card opens in full: the work on one side, how it would run on the other, and its thread one click on', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  await card(page, 'Ready').getByRole('button', { name: TASK, exact: true }).click();
  const inspector = page.getByRole('dialog', { name: TASK });
  await expect(inspector).toBeVisible();
  const work = inspector.locator('.ti-work');
  await expect(work).toContainText('Read the three quotes, note what changed since last month, and recommend one.');
  await expect(work).toContainText('No completion checks are declared, so a finished run reads Not verified.');
  await expect(work).toContainText('It has not run yet.');
  const runs = inspector.locator('.ti-controls');
  await expect(runs).toContainText('Sample');
  // A project made over the API has no AI of its own, so the route is the default in Settings.
  await expect(runs).toContainText('The default in Settings');
  await expect(runs).toContainText('The sample route runs a scripted worker.');
  await expect(runs).toContainText('No runs yet.');
  await expect(runs.getByRole('combobox', { name: 'Profile for this task' })).toBeVisible();
  // Its actions are the Board's own moves.
  await expect(inspector.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Mark done', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(fixtureRoot, 'task-inspector.png') });
  // Reading it changed nothing.
  expect((await records()).sessions).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(inspector).toBeHidden();
  expect(errors).toEqual([]);
});

test('a pointer drag lands on its column, even as the column opens its caption under it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  // The real pointer: pressed on the card's point, carried to the top of Review's empty line. The
  // dragover there opens the column's caption right under the pointer, so the release lands on
  // the caption, which only a dragenter has reached; the browser decides the drop on that.
  const from = (await card(page, 'Ready').boundingBox())!;
  const line = (await column(page, 'Review').locator('.empty').boundingBox())!;
  await page.mouse.move(from.x + 8, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x + line.width / 2, line.y + 3, { steps: 5 });
  await page.mouse.move(line.x + line.width / 2 + 1, line.y + 3);
  await expect(column(page, 'Review')).toHaveClass(/\bdrop-over\b/);
  await page.mouse.up();
  await expect(card(page, 'Ready').getByRole('alert')).toHaveText(REVIEW_BY_HAND);
  expect((await records()).sessions).toEqual([]);
  expect(errors).toEqual([]);
});

test('a drag asks for the Board’s own commands and refuses, on the card, what it cannot do', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Every command the page sends for this project, so a double click is seen to send one.
  const sent: string[] = [];
  const prefix = `/api/projects/${project.id}`;
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET' && pathname.startsWith(`${prefix}/`))
      sent.push(`${request.method()} ${pathname.slice(prefix.length)}`);
  });
  const commands = () => sent.filter((line) => /^\w+ \/(tasks|work|needs)\//.test(line));
  await openBoard(page);
  const taskId = (await records()).tasks[0].id;

  // Review is where a run's decisions wait: a card cannot be put there by hand. The column says
  // so under the pointer, the card says it again after the drop, and nothing is sent.
  expect(await drag(page, 'Ready', 'Review')).toBe(REVIEW_BY_HAND);
  await expect(card(page, 'Ready').getByRole('alert')).toHaveText(REVIEW_BY_HAND);
  expect((await records()).sessions).toEqual([]);
  expect(commands()).toEqual([]);

  // Done asks first, then goes through the task route. Dragged there twice it asks once, and a
  // double click on the confirmation sends one move.
  expect(await drag(page, 'Ready', 'Done')).toBe('Drop to mark done');
  await drag(page, 'Ready', 'Done');
  const confirm = card(page, 'Ready').locator('.confirm');
  await expect(confirm).toHaveCount(1);
  await expect(confirm).toContainText('Mark this task done? This records that you finished it; it does not run any check.');
  await confirm.getByRole('button', { name: 'Mark done' }).dblclick();
  await expect(card(page, 'Done')).toBeVisible();
  await expect(card(page, 'Done').locator('.why')).toHaveText('Marked done by you');
  expect((await records()).tasks[0].moves.filter((move) => move.to === 'done')).toHaveLength(1);
  expect(commands()).toEqual([`PUT /tasks/${taskId}`]);

  // The keyboard's way: the card's Move menu offers the same table.
  await card(page, 'Done').hover();
  await card(page, 'Done').getByRole('button', { name: 'Move', exact: true }).click();
  const menu = card(page, 'Done').getByRole('group', { name: `Move ${TASK} to` });
  await expect(menu.getByRole('button', { name: /^Ready/ })).toContainText('Reopen');
  await expect(menu.getByRole('button', { name: /^Review/ })).toHaveAttribute('aria-disabled', 'true');
  await menu.getByRole('button', { name: /^Ready/ }).click();
  await expect(card(page, 'Ready')).toBeVisible();

  // Into Working is the Board's Start, with the Board's own confirmation. Dragged there twice it
  // asks once, and a double click on Start sends one start.
  expect(await drag(page, 'Ready', 'Working')).toBe('Drop to start');
  await drag(page, 'Ready', 'Working');
  const hand = card(page, 'Ready').locator('.confirm');
  await expect(hand).toHaveCount(1);
  await expect(hand.getByText(/Hand to .*?\?/)).toBeVisible();
  await hand.getByRole('button', { name: 'Start', exact: true }).dblclick();
  // The sample worker stops at its first decision.
  await expect(card(page, 'Review')).toBeVisible();
  const running = await records();
  expect(running.sessions).toHaveLength(1);
  expect(running.needs.filter((need) => need.state === 'open')).toHaveLength(1);
  expect(commands().filter((line) => line === 'POST /work/start')).toHaveLength(1);

  // A run with a decision open cannot be marked done by moving it.
  const before = commands();
  expect(await drag(page, 'Review', 'Done')).toBe('Stop the run first, or let it finish.');
  await expect(card(page, 'Review').getByRole('alert')).toHaveText('Stop the run first, or let it finish.');
  expect((await records()).sessions).toHaveLength(1);
  expect(commands()).toEqual(before);
  await page.screenshot({ path: path.join(fixtureRoot, 'board-drag-refused.png') });
  expect(errors).toEqual([]);
});

test('without the Software Engineering pack the card says how it runs but offers no route choice', async ({ page }) => {
  // Customers do not choose routes (2026-09-23): the task's own profile choice is in the technical
  // view only, which the Software Engineering pack brings.
  await api(`/projects/${project.id}/packs/${ENGINEERING_PACK}/deactivate`, 'POST');
  try {
    await openBoard(page);
    await card(page, 'Review').getByRole('button', { name: TASK, exact: true }).click();
    const inspector = page.getByRole('dialog', { name: TASK });
    await expect(inspector.locator('.ti-controls')).toContainText('Sample');
    await expect(inspector.getByRole('combobox', { name: 'Profile for this task' })).toHaveCount(0);
  } finally {
    await api(`/projects/${project.id}/packs/${ENGINEERING_PACK}/activate`, 'POST');
  }
});

// S1 free manual teams (DIO-176): the person assigns a card to a Team member from the card, and
// hands one card on to the next. Both go through the task and hand-off routes; nothing runs.
test('a card is assigned to a Team member from the Board and shows that member', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const created = await api<{ member: TeamMember }>(`/projects/${project.id}/team/members`, 'POST', {
    name: 'Astra', role: 'lead', engine: 'sample',
  });
  await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name: 'Count the patio chairs' });
  await openBoard(page);
  const row = column(page, 'Ready').locator('.crow', { hasText: 'Count the patio chairs' });
  await row.hover();
  await row.getByRole('button', { name: 'Assign', exact: true }).click();
  await row.getByRole('list', { name: 'Assign Count the patio chairs to' }).getByRole('listitem').filter({ hasText: 'Astra' }).click();
  await expect(row.locator('.m .mono').filter({ hasText: 'Astra' })).toBeVisible();
  const saved = await records();
  expect(saved.tasks.find((task) => task.name === 'Count the patio chairs')?.assignedTo).toBe(created.member.slotId);
  expect(saved.history.at(-1)?.sentence).toBe('You assigned Count the patio chairs to Astra');
  expect(errors).toEqual([]);
});

test('a hand-off from one card shows on the next card', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { member: bram } = await api<{ member: TeamMember }>(`/projects/${project.id}/team/members`, 'POST', {
    name: 'Bram', role: 'member', engine: 'sample',
  });
  const next = await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name: 'Order the missing chairs' });
  await api(`/projects/${project.id}/tasks/${next.id}`, 'PUT', { assignedTo: bram.slotId });
  await openBoard(page);
  const from = column(page, 'Ready').locator('.crow', { hasText: 'Count the patio chairs' });
  await from.hover();
  await from.getByRole('button', { name: 'Hand off', exact: true }).click();
  const form = from.getByRole('form', { name: 'Hand off' });
  await form.getByRole('combobox', { name: /^To/ }).selectOption({ label: 'Order the missing chairs · Bram' });
  await form.getByLabel('What came of it').fill('Counted 24 chairs. Two need repair.');
  await form.getByRole('checkbox', { name: 'Fall menu.md' }).check();
  await form.getByLabel('Checks, one per line').fill('Counted twice');
  await form.getByLabel('Open issues, one per line').fill('Which supplier');
  await form.getByRole('button', { name: 'Hand off', exact: true }).click();
  await expect(form).toBeHidden();
  const target = column(page, 'Ready').locator('.crow', { hasText: 'Order the missing chairs' });
  const note = target.locator('.handoff-note');
  await expect(note.locator('summary')).toHaveText('Hand-off from Astra');
  await note.locator('summary').click();
  await expect(note).toContainText('Counted 24 chairs. Two need repair.');
  await expect(note).toContainText('Fall menu.md');
  await expect(note).toContainText('Counted twice');
  await expect(note).toContainText('Which supplier');
  const saved = await records();
  expect(saved.manualHandoffs).toHaveLength(1);
  expect(saved.manualHandoffs![0]).toMatchObject({ toTaskId: next.id, changedFiles: ['Fall menu.md'], createdBy: 'you' });
  // Retiring it keeps the record and takes the note off the card.
  await note.getByRole('button', { name: 'Retire hand-off', exact: true }).click();
  await expect(note).toHaveCount(0);
  const retired = await records();
  expect(retired.manualHandoffs).toHaveLength(1);
  expect(retired.manualHandoffs![0].retiredAt).toEqual(expect.any(String));
  expect(retired.history.map((entry) => entry.sentence)).toContain(
    'You retired the hand-off from Count the patio chairs to Order the missing chairs',
  );
  expect(errors).toEqual([]);
});
