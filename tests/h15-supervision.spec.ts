import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Conversation, Need, Project, ProjectState, Session, Task } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

// H15 journey in the real built Console against an owned host: a fixture run (the scripted
// sample worker) whose task selected a document in Menu/ writes to the plan at the project root.
// Diomedes supervision pauses it through H08 Stop and asks, in the thread, whether to continue,
// redirect or stop; the run inspector's Supervision section shows the detection with its
// evidence and who did what. Setup goes through the API; every claim is read from the screen.

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';

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

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Never reached ${what}.`);
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'h15-supervision-ui-'));
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
    stepMs: 250,
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  const source = Math.max(
    ...(await Promise.all(
      [
        'client/console/Supervision.tsx',
        'client/workbench/RunInspector.tsx',
        'shared/supervision.ts',
      ].map(async (file) => (await fs.stat(file)).mtimeMs),
    )),
  );
  expect(
    built,
    'dist is older than the supervision sources. Run "npx vite build" first.',
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
});

/** A task scoped to Menu/, and a sample run on it that goes on to write the root plan. */
async function driftingRun(taskName: string) {
  await api('/settings', 'PUT', {
    detail: 'technical',
    permissions: {
      changingFiles: false,
      deleting: true,
      sending: false,
      workingOutside: true,
      spending: true,
    },
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
  const project = await api<Project>('/projects/sample', 'POST', {});
  await fs.mkdir(path.join(project.folder, 'Menu'), { recursive: true });
  await fs.writeFile(
    path.join(project.folder, 'Menu', 'Fall menu draft.md'),
    '# Draft\n\nSquash soup.\n',
  );
  const task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name: taskName,
    description: 'Tidy the fall menu draft',
    sourceDocument: 'Menu/Fall menu draft.md',
  });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {
    attachedTo: { kind: 'task', ref: task.id },
  });
  await api('/settings', 'PUT', { openProjects: [project.id] });
  const session = await api<Session>(`/projects/${project.id}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId: task.id,
    route: 'sample',
    threadId: thread.id,
  });
  const state = () => api<ProjectState>(`/projects/${project.id}/state`);
  // The one file the worker asks about is approved exactly; the plan it then writes is not.
  const notes = await until(
    async () =>
      (await state()).needs.find(
        (n) => n.sessionId === session.id && n.state === 'open' && !n.supervision,
      ),
    'the notes request',
  );
  await api(`/projects/${project.id}/needs/${notes.id}/resolve`, 'POST', {
    resolution: 'go-ahead',
  });
  const need = await until<Need>(
    async () => (await state()).needs.find((n) => n.supervision && n.sessionId === session.id),
    'the escalation',
  );
  return { project, task, session, need };
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

test('a run that leaves its selected folder is paused, escalated, and answered only by you', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await driftingRun('Tidy the menu draft');
  await openThread(page, 'Tidy the menu draft');

  // The escalation sits where a Need sits, in Diomedes' supervision name.
  const escalation = page.getByRole('region', { name: 'Nectovia paused this run' });
  await expect(escalation).toBeVisible();
  await expect(escalation.locator('.who')).toHaveText(
    'Nectoviasupervision · application action · needs you',
  );
  await expect(escalation.locator('.ask')).toHaveText(
    'Nectovia paused this run: it started writing outside the selected folder — continue, redirect, or stop?',
  );
  await expect(escalation).toContainText('Wrote Reopening plan.md, outside Menu/.');
  await expect(escalation).toContainText('No answer grants anything new.');
  // It offers no task-wide or remembered approval: only the three answers.
  await expect(escalation.getByRole('button')).toHaveText(['Continue', 'Redirect', 'Stop']);

  // The inspector's Supervision section: the detection, the pause, the evidence, the actor.
  await page.locator('#scrThread .run-inspector summary').click();
  const supervision = page.locator('#scrThread').getByRole('region', { name: 'Supervision' });
  const records = supervision.locator('.supervision-records > li');
  await expect(records).toHaveCount(2);
  await expect(records.nth(0)).toContainText('Noted · Scope drift · info');
  await expect(records.nth(0)).toContainText(
    'Proposed writing Sample work notes.md, outside Menu/.',
  );
  const paused = records.nth(1);
  await expect(paused).toHaveAttribute('data-action', 'escalate');
  await expect(paused).toContainText('Paused and asked you · Scope drift · critical');
  await expect(paused).toContainText('By Nectovia supervision · application action, no model');
  await expect(paused).toContainText('It started writing outside the selected folder.');
  await expect(paused).toContainText('Stop done: Stopped the task.');
  await expect(paused.getByRole('list', { name: 'Evidence' })).toContainText(
    'Wrote Reopening plan.md, outside Menu/.',
  );
  // The pause is also an H08 receipt in the thread, asked for by supervision.
  await expect(page.locator('#scrThread .control-receipt[data-control="stop"]')).toContainText(
    'asked by Nectovia supervision',
  );

  // Continue goes through Resume, which this route does not offer: said, and still open.
  await escalation.getByRole('button', { name: 'Continue' }).click();
  await expect(escalation.getByRole('status')).toContainText('Not done:');
  await expect(escalation).toBeVisible();

  // Stop: the escalation is answered by you, and the section says so.
  await escalation.getByRole('button', { name: 'Stop' }).click();
  await expect(escalation).toHaveCount(0);
  await expect(records.last()).toContainText('You answered · Scope drift');
  await expect(records.last()).toContainText('By you');
  await expect(records.last()).toContainText('Stop');

  // No horizontal overflow from any machine string in the section at a narrow width.
  await page.setViewportSize({ width: 900, height: 900 });
  const overflow = await supervision.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
