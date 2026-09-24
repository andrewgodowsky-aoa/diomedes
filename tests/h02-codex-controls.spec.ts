import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { createIntegrations, createRpcClient } from '../server/integrations';
import type { Conversation, Project, ProjectState, Session, Task } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

// H02 journey in the real built Console against an owned host whose ChatGPT (Codex)
// route runs over a fixture app-server process (tests/fixtures/codex-app-server.mjs).
// One build advertises steer, resume and fork; the other none of them. The Console
// must offer exactly what the Codex that served each run advertised, and every
// receipt must say who did it. Setup goes through the API; every claim is read
// from the screen. No live Codex is used or claimed.

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const FIXTURE = path.resolve('tests/fixtures/codex-app-server.mjs');
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let root = '';
let codexDir = '';

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
const codexBuild = (control: { capabilities?: string[]; hold?: boolean }) =>
  fs.writeFile(path.join(codexDir, 'control.json'), JSON.stringify(control));
async function turnsStarted() {
  const text = await fs.readFile(path.join(codexDir, 'calls.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.includes('"method":"turn/start"')).length;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  root = await fs.mkdtemp(path.join(results, 'h02-codex-ui-'));
  codexDir = path.join(root, 'codex');
  await fs.mkdir(codexDir, { recursive: true });
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
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    codexIntegration: createIntegrations({
      platform: 'win32',
      verifySandbox: async () => {},
      turnTimeoutMs: 30_000,
      createClient: async () =>
        createRpcClient(
          spawn(process.execPath, [FIXTURE], {
            env: { PATH: process.env.PATH, CODEX_FIXTURE_DIR: codexDir },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
          }),
        ),
    }),
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  const source = Math.max(
    ...(await Promise.all(
      [
        'client/console/StopMenu.tsx',
        'client/console/ThreadView.tsx',
        'client/workbench/RunInspector.tsx',
        'shared/work-control.ts',
      ].map(async (file) => (await fs.stat(file)).mtimeMs),
    )),
  );
  expect(built, 'dist is older than the control sources. Run "npx vite build" first.').toBeGreaterThan(
    source,
  );
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
});

/** A project with one task and its thread, the ChatGPT route on and allowed its menu. */
async function codexTask(taskName: string) {
  const project = await api<Project>('/projects/sample', 'POST', {});
  const task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name: taskName });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {
    attachedTo: { kind: 'task', ref: task.id },
  });
  await api('/settings', 'PUT', {
    services: { codex: true },
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
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['codex'],
    documents: ['Fall menu.md'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  return { project, task, thread };
}
/** Start a ChatGPT run whose turn Codex holds open, and wait for that turn to be running. */
async function heldRun(
  projectId: string,
  taskId: string,
  threadId: string,
  capabilities?: string[],
) {
  await codexBuild({ capabilities, hold: true });
  const turns = await turnsStarted();
  const session = await api<Session>(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    route: 'codex',
    consent: true,
    sources: ['Fall menu.md'],
    threadId,
  });
  await expect.poll(turnsStarted).toBe(turns + 1);
  return session;
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
const bar = (page: Page) =>
  page.locator('#scrThread').getByRole('toolbar', { name: 'Run controls' }).last();

test('a Codex build that advertises steer, resume and fork is offered all three, each by Codex', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { project, task, thread } = await codexTask('Refresh the fall menu');
  const first = await heldRun(project.id, task.id, thread.id);
  await openThread(page, 'Refresh the fall menu');
  await expect(liveRecord(page)).toBeVisible();

  // Steer: offered because this Codex takes input into a running turn.
  const when = followUps(page).getByRole('radiogroup', { name: 'When this follow-up runs' });
  await when.getByRole('radio', { name: 'now, into this turn' }).click();
  await followUps(page)
    .getByRole('textbox', { name: 'Steer the running turn' })
    .fill('Mention the cider pairing.');
  await followUps(page).getByRole('button', { name: 'Steer', exact: true }).click();
  await expect(receipt(page, 'steer')).toHaveAttribute('data-outcome', 'applied');
  await expect(receipt(page, 'steer')).toContainText('by ChatGPT · fixture-codex-model');
  await expect(receipt(page, 'steer')).toContainText('Codex took the message into the running turn');
  await expect(liveRecord(page)).toHaveCount(0);

  // A second run, stopped from its record, then resumed: Codex continues its thread.
  const second = await heldRun(project.id, task.id, thread.id);
  await expect(liveRecord(page)).toBeVisible();
  await liveRecord(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(receipt(page, 'stop')).toHaveAttribute('data-outcome', 'applied');
  await codexBuild({});
  await expect(bar(page).getByRole('button')).toHaveText(['Resume', 'Retry', 'Fork']);
  await bar(page).getByRole('button', { name: 'Resume' }).click();
  const confirm = page.getByRole('group', { name: 'Confirm resume' });
  await expect(confirm).toContainText('Continues this run on ChatGPT from where it stopped.');
  await confirm.getByRole('button', { name: 'Resume now' }).click();
  await expect(receipt(page, 'resume')).toHaveAttribute('data-outcome', 'applied');
  await expect(receipt(page, 'resume')).toContainText('by ChatGPT · fixture-codex-model');
  const stopped = (await api<ProjectState>(`/projects/${project.id}/state`)).sessions.find(
    (s) => s.id === second.id,
  )!;
  await expect(receipt(page, 'resume')).toContainText(
    `Codex continued thread ${stopped.nativeThread!.id}`,
  );

  // The inspector names how this route performs each control, and the Codex thread.
  await expect(liveRecord(page)).toHaveCount(0);
  await page.locator('#scrThread .run-inspector summary').last().click();
  const offered = page.locator('#scrThread .run-inspector-controls').last();
  await expect(offered.locator('li > span')).toHaveText([
    'Steer · not offered',
    'Queue · by Nectovia',
    'Stop · by Nectovia',
    'Resume · by the route',
    'Retry · by Nectovia',
    'Fork · by the route',
  ]);
  await expect(page.locator('#scrThread .run-inspector').last()).toContainText(
    `${stopped.nativeThread!.id} · resumed`,
  );

  // Fork: Codex branches the settled thread into a new task; the origin is untouched.
  const before = await api<ProjectState>(`/projects/${project.id}/state`);
  await bar(page).getByRole('button', { name: 'Fork' }).click();
  await expect(receipt(page, 'fork')).toHaveAttribute('data-outcome', 'applied');
  await expect(receipt(page, 'fork')).toContainText('by ChatGPT · fixture-codex-model');
  await expect(receipt(page, 'fork')).toContainText('Codex forked thread');
  const after = await api<ProjectState>(`/projects/${project.id}/state`);
  expect(after.sessions.filter((s) => s.taskId === task.id)).toEqual(
    before.sessions.filter((s) => s.taskId === task.id),
  );
  expect((after.controlReceipts ?? []).map((r) => [r.control, r.performedBy?.kind])).toEqual([
    ['steer', 'engine'],
    ['stop', 'diomedes'],
    ['resume', 'engine'],
    ['fork', 'engine'],
  ]);
  expect(first.id).not.toBe(second.id);
  expect(errors).toEqual([]);
});

test('a Codex build without them offers Queue and a labelled fresh-start Resume, and no Fork', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { project, task, thread } = await codexTask('Count the cellar');
  const run = await heldRun(project.id, task.id, thread.id, []);
  await openThread(page, 'Count the cellar');
  await expect(liveRecord(page)).toBeVisible();

  const when = followUps(page).getByRole('radiogroup', { name: 'When this follow-up runs' });
  await expect(when.getByRole('radio')).toHaveText(['after this turn', 'after the task is done']);
  await expect(followUps(page).locator('.follow-up-steer-note')).toHaveText(
    'ChatGPT can’t steer a running turn, so a message waits for the turn to end.',
  );

  await liveRecord(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(receipt(page, 'stop')).toHaveAttribute('data-outcome', 'applied');
  await codexBuild({ capabilities: [] });
  await expect(bar(page).getByRole('button')).toHaveText(['Resume', 'Retry']);
  await bar(page).getByRole('button', { name: 'Resume' }).click();
  const confirm = page.getByRole('group', { name: 'Confirm resume' });
  await expect(confirm).toContainText(
    'Sends the same request to ChatGPT in a new thread; ChatGPT cannot continue this one.',
  );
  await confirm.getByRole('button', { name: 'Resume now' }).click();
  await expect(receipt(page, 'resume')).toHaveAttribute('data-outcome', 'applied');
  await expect(receipt(page, 'resume')).toContainText('by Nectovia');
  const stopped = (await api<ProjectState>(`/projects/${project.id}/state`)).sessions.find(
    (s) => s.id === run.id,
  )!;
  await expect(receipt(page, 'resume')).toContainText(
    `Couldn't resume Codex thread ${stopped.nativeThread!.id}`,
  );
  await expect(receipt(page, 'resume')).toContainText('Started a new Codex thread');
  expect(errors).toEqual([]);
});
