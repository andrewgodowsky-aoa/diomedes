import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Conversation, Project, ProjectState, Session, Task } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

// H08 journey in the real built Console against an owned host: the six controls
// on a fixture route that declares all six (the test-mode control fixture over the
// scripted sample worker), and on the plain sample route, which offers only Stop
// and Queue. Setup goes through the API; every claim is read from the screen.

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';
const previousTestMode = process.env.DIOMEDES_TEST_MODE;

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
  fixtureRoot = await fs.mkdtemp(path.join(results, 'h08-controls-ui-'));
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  baseURL = `http://127.0.0.1:${port}`;
  // The control fixture route is mounted only in test mode, and only for a project that asks.
  process.env.DIOMEDES_TEST_MODE = '1';
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
        'client/console/StopMenu.tsx',
        'client/console/FollowUpQueue.tsx',
        'client/console/ThreadView.tsx',
        'shared/work-control.ts',
      ].map(async (file) => (await fs.stat(file)).mtimeMs),
    )),
  );
  expect(
    built,
    'dist is older than the control sources. Run "npx vite build" first.',
  ).toBeGreaterThan(source);
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
  if (previousTestMode === undefined) delete process.env.DIOMEDES_TEST_MODE;
  else process.env.DIOMEDES_TEST_MODE = previousTestMode;
});

/** A project with one task, its thread, and a sample run waiting for the first OK. */
async function liveRun(taskName: string, allSix: boolean) {
  const project = await api<Project>('/projects/sample', 'POST', {});
  const task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name: taskName });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {
    attachedTo: { kind: 'task', ref: task.id },
  });
  if (allSix) await api(`/projects/${project.id}/controls/fixture`, 'PUT', { enabled: true });
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
  const session = await api<Session>(`/projects/${project.id}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId: task.id,
    route: 'sample',
    threadId: thread.id,
  });
  return { project, task, thread, session };
}

async function openThread(page: Page, taskName: string) {
  await page.goto(baseURL);
  await reopenLastProject(page);
  await page
    .getByRole('navigation', { name: 'Threads and views' })
    .getByRole('button', { name: new RegExp(taskName) })
    .first()
    .click();
  await expect(page.locator('#scrThread')).toBeVisible();
}

const receipt = (page: Page, control: string) =>
  page.locator(`#scrThread .control-receipt[data-control="${control}"]`);
const liveRecord = (page: Page) => page.locator('#scrThread .record.open.live');
const followUps = (page: Page) => page.getByRole('region', { name: 'Follow-ups' });

test('a route that declares all six offers each control once, and each leaves a receipt', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { project, task } = await liveRun('Plan the tasting menu', true);
  await openThread(page, 'Plan the tasting menu');
  await expect(liveRecord(page)).toBeVisible();

  // Steer: offered, because the route reaches the running turn.
  const when = followUps(page).getByRole('radiogroup', { name: 'When this follow-up runs' });
  await when.getByRole('radio', { name: 'now, into this turn' }).click();
  await followUps(page)
    .getByRole('textbox', { name: 'Steer the running turn' })
    .fill('Keep it to five courses.');
  await followUps(page).getByRole('button', { name: 'Steer', exact: true }).click();
  await expect(receipt(page, 'steer')).toHaveAttribute('data-outcome', 'applied');
  await expect(receipt(page, 'steer')).toContainText('The running turn received the message.');
  await expect(followUps(page).locator('.follow-up-steer-note')).toHaveCount(0);

  // Queue: held for after this turn, and it says so.
  await when.getByRole('radio', { name: 'after this turn' }).click();
  await followUps(page)
    .getByRole('textbox', { name: 'Queue a follow-up' })
    .fill('Then price each course.');
  await followUps(page).getByRole('button', { name: 'Queue a follow-up' }).click();
  await expect(receipt(page, 'queue')).toHaveAttribute('data-outcome', 'queued');
  await expect(followUps(page).locator('.follow-up:not(.settled) .follow-up-text')).toHaveText(
    'Then price each course.',
  );

  // Stop, from the run's own record; it also cancels what was queued.
  await liveRecord(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(receipt(page, 'stop')).toHaveAttribute('data-outcome', 'applied');
  await expect(receipt(page, 'stop')).toContainText('1 queued follow-up was cancelled.');

  // Resume, by keyboard: focus, Enter, and the confirmation takes Enter too.
  // The latest run's controls: an older run keeps only Fork, from its own point.
  const bar = page.locator('#scrThread').getByRole('toolbar', { name: 'Run controls' }).last();
  await expect(bar.getByRole('button')).toHaveText(['Resume', 'Retry', 'Fork']);
  await bar.getByRole('button', { name: 'Resume' }).focus();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('group', { name: 'Confirm resume' });
  await expect(confirm).toContainText('Continues this run on Sample from where it stopped.');
  await expect(confirm.getByRole('button', { name: 'Resume now' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(receipt(page, 'resume')).toHaveAttribute('data-outcome', 'applied');
  await expect(liveRecord(page)).toBeVisible();

  // Stop the resumed run, then Retry it: a new attempt, linked to the original.
  await liveRecord(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(receipt(page, 'stop')).toHaveCount(2);
  await bar.getByRole('button', { name: 'Retry' }).click();
  await page
    .getByRole('group', { name: 'Confirm retry' })
    .getByRole('button', { name: 'Retry now' })
    .click();
  await expect(receipt(page, 'retry')).toHaveAttribute('data-outcome', 'applied');
  await expect(receipt(page, 'retry')).toContainText('attempt 2');
  await liveRecord(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(receipt(page, 'stop')).toHaveCount(3);

  // The inspector names what this route offers.
  await page.locator('#scrThread .run-inspector summary').click();
  const offered = page.locator('#scrThread .run-inspector-controls');
  await expect(offered.locator('li > span')).toHaveText([
    'Steer · by the route',
    'Queue · by Nectovia',
    'Stop · by Nectovia',
    'Resume · by the route',
    'Retry · by Nectovia',
    'Fork · by Nectovia',
  ]);

  // Fork: a new task and thread that refer to this run; the origin is untouched.
  const before = await api<ProjectState>(`/projects/${project.id}/state`);
  await bar.getByRole('button', { name: 'Fork' }).click();
  await expect(receipt(page, 'fork')).toHaveAttribute('data-outcome', 'applied');
  const after = await api<ProjectState>(`/projects/${project.id}/state`);
  expect(after.sessions.filter((s) => s.taskId === task.id)).toEqual(
    before.sessions.filter((s) => s.taskId === task.id),
  );
  await receipt(page, 'fork').getByRole('button', { name: 'Open the fork' }).click();
  await expect(page.locator('#scrThread h1')).toHaveText(
    'Thread for Fork of Plan the tasting menu',
  );
  await expect(receipt(page, 'fork')).toContainText('Nothing runs until you start it.');
  await expect(
    receipt(page, 'fork').getByRole('button', { name: 'Open the original' }),
  ).toBeVisible();

  // Every receipt is on the record, in order, and none of them says a model did it.
  const receipts = after.controlReceipts ?? [];
  expect(receipts.map((r) => r.control)).toEqual([
    'steer',
    'queue',
    'stop',
    'resume',
    'stop',
    'retry',
    'stop',
    'fork',
  ]);
  expect(receipts.every((r) => r.requestedBy.actor === 'you')).toBe(true);
  expect(errors).toEqual([]);
});

test('a route that offers only Stop and Queue shows only those, and labels the queue as a queue', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { project } = await liveRun('Count the cellar', false);
  await openThread(page, 'Count the cellar');
  await expect(liveRecord(page)).toBeVisible();

  const when = followUps(page).getByRole('radiogroup', { name: 'When this follow-up runs' });
  await expect(when.getByRole('radio')).toHaveText(['after this turn', 'after the task is done']);
  await expect(followUps(page).locator('.follow-up-steer-note')).toHaveText(
    'Sample can’t steer a running turn, so a message waits for the turn to end.',
  );
  await followUps(page)
    .getByRole('textbox', { name: 'Queue a follow-up' })
    .fill('Note the reds first.');
  await followUps(page).getByRole('button', { name: 'Queue a follow-up' }).click();
  await expect(receipt(page, 'queue')).toHaveAttribute('data-outcome', 'queued');

  // Stop options offers only what this route can honour: no request-only stop.
  await liveRecord(page).getByRole('button', { name: 'Stop options' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Cancel queued follow-ups']);
  await expect(menu.getByRole('menuitem')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(liveRecord(page).getByRole('button', { name: 'Stop options' })).toBeFocused();

  await liveRecord(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(receipt(page, 'stop')).toHaveAttribute('data-outcome', 'applied');
  // Nothing else is offered once it has stopped: no Resume, Retry or Fork.
  await expect(
    page.locator('#scrThread').getByRole('toolbar', { name: 'Run controls' }),
  ).toHaveCount(0);
  const state = await api<ProjectState>(`/projects/${project.id}/state`);
  expect((state.controlReceipts ?? []).map((r) => r.control)).toEqual(['queue', 'stop']);
  expect(errors).toEqual([]);
});
