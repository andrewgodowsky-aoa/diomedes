import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { ApprovalCommand, Conversation, Need, Project, ProjectState, Task } from '../shared/types';
import type { StreamRule } from '../shared/stream-rules';
import { AGENT_NAME } from '../shared/agent-name';
import { reopenLastProject } from './fixtures/landing';

// H16 in the real built Console against an owned host, on the scripted loop route (which streams
// its text in five-character chunks). Rules are written through the API at organization and
// project authority, each limited to one task. Every claim is read from the screen: the held
// write's Need names the rule; the run inspector's Supervision section shows each firing with its
// rule, what it matched, what it asked for and what came of it; a stop rule's escalation is
// answered by you.

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
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

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Never reached ${what}.`);
}

const rule = (id: string, taskId: string, extra: Partial<StreamRule> & Pick<StreamRule, 'match' | 'intervention' | 'text'>) => ({
  id,
  version: 1,
  enabled: true,
  taskId,
  ...extra,
});

async function task(name: string) {
  const created = await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name });
  await api<Conversation>(`/projects/${project.id}/threads`, 'POST', { attachedTo: { kind: 'task', ref: created.id } });
  return created;
}

async function startLoop(taskId: string) {
  return api<{ runId: string; session: { id: string } }>(`/projects/${project.id}/loop/start`, 'POST', {
    protocolVersion: 1,
    commandId: `h16-${taskId}`,
    taskId,
    goal: 'Compare the order with the delivery and write the report.',
    route: 'native-fixture',
    sources: ['order.md', 'delivery.md'],
  });
}

const state = () => api<ProjectState>(`/projects/${project.id}/state`);

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'h16-stream-triggers-ui-'));
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
      ['client/console/Supervision.tsx', 'client/console/supervision.css', 'shared/stream-rules.ts'].map(
        async (file) => (await fs.stat(file)).mtimeMs,
      ),
    )),
  );
  expect(built, 'dist is older than the H16 sources. Run "npx vite build" first.').toBeGreaterThan(source);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', application);

  await api('/settings', 'PUT', {
    detail: 'technical',
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
  project = await api<Project>('/projects', 'POST', { name: 'Linen orders' });
  await fs.writeFile(path.join(project.folder, 'order.md'), 'Order 1182: 100 napkins, 40 tablecloths.\n');
  await fs.writeFile(path.join(project.folder, 'delivery.md'), 'Delivered 94 napkins. Six napkins short.\n');
  await api('/settings', 'PUT', { openProjects: [project.id] });
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  }
});

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

test('a held write names its rule, and the Supervision section shows each firing and what came of it', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const report = await task('Write the linen report');
  await api('/stream-rules', 'PUT', {
    protocolVersion: 1,
    rules: [
      rule('reports-held', report.id, {
        match: { kind: 'tool', tool: 'propose_write' },
        intervention: 'hold',
        text: 'Every report is read by a person before it is written.',
      }),
    ],
  });
  await api(`/projects/${project.id}/stream-rules`, 'PUT', {
    protocolVersion: 1,
    rules: [
      rule('helper-note', report.id, {
        match: { kind: 'text', phrase: 'helper to check' },
        intervention: 'annotate',
        text: 'Note when the plan hands work to a helper.',
      }),
      rule('mind-the-count', report.id, {
        match: { kind: 'text', phrase: 'read order.md' },
        intervention: 'steer',
        message: 'Count the napkins line by line.',
        text: 'Counts are checked line by line.',
      }),
    ],
  });
  const started = await startLoop(report.id);
  const held = await until<Need>(
    async () => (await state()).needs.find((need) => need.sessionId === started.session.id && need.state === 'open'),
    'the held write',
  );

  await openThread(page, 'Write the linen report');
  const need = page.locator(`#need-${held.id}`).getByRole('region', { name: 'Needs your OK' });
  await expect(need).toBeVisible();
  await expect(need.locator('.why')).toContainText(
    'A rule held this before it ran: Every report is read by a person before it is written.',
  );

  const decision: ApprovalCommand = {
    protocolVersion: 1,
    commandId: `decision-${held.id}`,
    resolution: 'go-ahead',
    proposalDigest: held.approval!.proposalDigest,
    actionDigest: held.approval!.actionDigest,
    baseDigest: held.approval!.baseDigest,
  };
  await api(`/projects/${project.id}/needs/${held.id}/resolve`, 'POST', decision);
  await until(
    async () => ((await state()).sessions.find((session) => session.id === started.session.id)?.endedAt ? true : undefined),
    'the run to finish',
  );
  await page.reload();
  await reopenLastProject(page).catch(() => undefined);
  await openThread(page, 'Write the linen report');

  await page.locator('#scrThread .run-inspector summary').first().click();
  const supervision = page.locator('#scrThread').getByRole('region', { name: 'Supervision' });
  const rows = supervision.locator('.supervision-records > li');
  // Three firings, in stream order; what supervision did about one is said on its firing's row, once.
  await expect(rows).toHaveCount(3);
  const steer = rows.nth(0);
  await expect(steer).toHaveAttribute('data-intervention', 'steer');
  // The loop route offers neither Steer nor Queue, so the correction was not sent, and the row says so.
  await expect(steer).toHaveAttribute('data-state', 'refused');
  await expect(steer.locator('[data-trigger-outcome]')).toContainText(/^Correction not sent: /);
  await expect(steer.locator('.supervision-message')).toHaveText(
    '[Diomedes supervision] A project rule (mind-the-count) matched the streamed text “Read order.md”: Counts are checked line by line. Count the napkins line by line.',
  );

  const annotate = rows.nth(1);
  await expect(annotate).toHaveAttribute('data-intervention', 'annotate');
  await expect(annotate.locator('.supervision-head')).toContainText('Annotate · Rule trigger');
  await expect(annotate).toContainText(`By ${AGENT_NAME} supervision · application action, no model`);
  await expect(annotate).toContainText('Project rule helper-note v1: Note when the plan hands work to a helper.');
  await expect(annotate).toContainText('Matched “helper to check” at 27–42 of model:plan, while it streamed.');
  await expect(annotate.locator('[data-trigger-outcome]')).toHaveText('Recorded. Nothing else was done.');
  await expect(annotate.locator('small')).toContainText(/rule · [a-f0-9]{64}/);

  const hold = rows.nth(2);
  await expect(hold).toHaveAttribute('data-intervention', 'hold');
  await expect(hold).toContainText('Organization rule reports-held v1: Every report is read by a person before it is written.');
  await expect(hold).toContainText('Matched the proposed propose_write call on Harness report.md, before it was admitted.');
  await expect(hold.locator('[data-trigger-outcome]')).toHaveText('Held before it ran, then you said go ahead.');

  await page.setViewportSize({ width: 900, height: 900 });
  await expect(supervision).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('a stop rule on streamed text pauses the run and asks you; your answer is recorded under the firing', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const summary = await task('Summarise the linen order');
  const current = await api<{ project: StreamRule[] }>(`/projects/${project.id}/stream-rules`);
  await api(`/projects/${project.id}/stream-rules`, 'PUT', {
    protocolVersion: 1,
    rules: [
      ...current.project,
      rule('no-summaries', summary.id, {
        match: { kind: 'text', phrase: 'summarise what' },
        intervention: 'stop',
        text: 'Summaries are written by a person.',
      }),
    ],
  });
  const started = await startLoop(summary.id);
  await until(
    async () => (await state()).needs.find((need) => need.sessionId === started.session.id && need.supervision && need.state === 'open'),
    'the escalation',
  );

  await openThread(page, 'Summarise the linen order');
  const escalation = page.getByRole('region', { name: `${AGENT_NAME} paused this run` });
  await expect(escalation).toBeVisible();
  await expect(escalation.locator('.ask')).toHaveText(
    `${AGENT_NAME} paused this run: a project rule (no-summaries) matched the streamed text “Summarise what”: Summaries are written by a person — continue, redirect, or stop?`,
  );
  await expect(escalation.getByRole('button')).toHaveText(['Continue', 'Redirect', 'Stop']);

  await page.locator('#scrThread .run-inspector summary').first().click();
  const supervision = page.locator('#scrThread').getByRole('region', { name: 'Supervision' });
  const rows = supervision.locator('.supervision-records > li');
  // The pause is said once, on the firing's row.
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toHaveAttribute('data-intervention', 'stop');
  await expect(rows.nth(0).locator('.supervision-head')).toContainText('Stop · Rule trigger');
  await expect(rows.nth(0).locator('[data-trigger-outcome]')).toContainText(/^Stopped: /);

  await escalation.getByRole('button', { name: 'Stop' }).click();
  await expect(escalation).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('You answered · Rule trigger');
  await expect(rows.nth(1)).toContainText('By you');
  expect(errors).toEqual([]);
});
