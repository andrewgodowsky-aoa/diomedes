import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Conversation, Project, ProjectState, Task } from '../shared/types';
import type { StreamRule } from '../shared/stream-rules';
import { reopenLastProject } from './fixtures/landing';
import { AGENT_NAME } from '../shared/agent-name';

// H16 from the Console alone, in the real built app against an owned host. A person writes a
// project rule in the thread head's rule editor, starts a Diomedes loop run from the task on the
// scripted route, sees the hold as a Need and the firing in Supervision; then writes an
// organization rule in Settings > Rules and is refused, in the server's words, when a project
// rule would loosen it. Both forms are checked at a 200% zoom width.

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

async function task(name: string, description: string) {
  const created = await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name, description });
  await api<Conversation>(`/projects/${project.id}/threads`, 'POST', { attachedTo: { kind: 'task', ref: created.id } });
  return created;
}

const state = () => api<ProjectState>(`/projects/${project.id}/state`);
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'h16-console-ui-'));
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
        'client/console/TriggerRules.tsx',
        'client/console/ProjectTriggerRules.tsx',
        'client/console/LoopStart.tsx',
        'client/console/trigger-rules.css',
        'client/Settings.tsx',
      ].map(async (file) => (await fs.stat(file)).mtimeMs),
    )),
  );
  expect(built, 'dist is older than the H16 Console sources. Run "npx vite build" first.').toBeGreaterThan(source);
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

async function openRules(page: Page) {
  await page.locator('#scrThread').getByRole('button', { name: /^Trigger rules ·/ }).click();
  const rules = page.locator('#scrThread .trigger-rules[data-authority="project"]');
  await expect(rules).toBeVisible();
  return rules;
}

test('a project rule written in the editor holds the loop run started from the task, as a Need and a Supervision row', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await task('Write the linen report', 'Compare order.md with delivery.md and write the report.');
  await openThread(page, 'Write the linen report');

  const rules = await openRules(page);
  // Which runs rules watch is said once, plainly.
  await expect(rules.locator('.trigger-rules-reach')).toHaveText(
    `Trigger rules watch ${AGENT_NAME} work loop runs only. Runs on Codex, Claude Code, OpenCode and other external engines use their own tools and are not watched.`,
  );
  await expect(page.locator('#scrThread .trigger-rules-reach')).toHaveCount(1);
  await rules.getByRole('button', { name: 'Add a rule' }).click();
  const form = rules.getByRole('form', { name: 'New rule' });
  await form.getByLabel('Rule id').fill('reports-read-first');
  await form.getByLabel('What it is for').fill('Every report is read by a person before it is written.');
  await form.getByLabel('A proposed tool call, before it runs').check();
  await form.getByLabel('Tool', { exact: true }).fill('propose_write');
  await form.getByLabel(/^Target/).fill('Harness report.md');
  await form.getByLabel('When it matches').selectOption('hold');
  // Opened on a task, a new project rule is limited to it unless the person widens it.
  await expect(form.getByLabel('Applies to')).toHaveValue(/.+/);
  await page.setViewportSize({ width: 640, height: 900 });
  expect(await noSideScroll(page)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await form.getByRole('button', { name: 'Save rule' }).click();
  await expect(form).toHaveCount(0);
  const row = rules.locator('.trigger-rule[data-rule="reports-read-first"]');
  await expect(row).toHaveAttribute('data-outcome', 'applied');
  await expect(row.locator('.trigger-rule-intervention')).toHaveText('Hold for you');
  await expect(row.locator('.trigger-rule-match')).toHaveText(
    'A proposed propose_write call on Harness report.md · Only Write the linen report',
  );
  await expect(row.locator('.trigger-rule-decision')).toHaveText('Governs · Governs trigger:reports-read-first.');
  await expect(page.locator('#scrThread').getByRole('button', { name: /^Trigger rules ·/ })).toContainText(
    '1 watches this task · 1 project · 0 organization',
  );
  const written = (await state()).history.filter((entry) => entry.kind === 'rules');
  expect(written.map((entry) => [entry.actor, entry.sentence])).toEqual([
    ['you', "You changed this project's trigger rules: added reports-read-first v1. A rule grants nothing."],
  ]);

  // Start a Diomedes loop run from the task's own work panel.
  await page.getByRole('complementary', { name: 'This project' }).getByRole('button', { name: 'Loop run' }).click();
  const start = page.getByRole('form', { name: `Start a ${AGENT_NAME} work loop` });
  await expect(start.getByLabel('Route')).toHaveValue('native-fixture');
  await expect(start.getByLabel('Goal')).toHaveValue('Compare order.md with delivery.md and write the report.');
  await expect(start.getByRole('checkbox', { name: 'order.md' })).toBeChecked();
  await expect(start.getByRole('checkbox', { name: 'delivery.md' })).toBeChecked();
  await expect(start.getByLabel(/^Turns/)).toHaveValue('8');
  // Model-API routes that are not set up are not offered; each says why, in the server's words.
  await start.getByText(/^Not offered/).click();
  await expect(start.locator('li[data-route="openrouter"]')).toContainText(
    'Turn the selected route on in Settings before using it.',
  );
  await start.getByRole('button', { name: 'Start loop run' }).click();
  await expect(start).toHaveCount(0);

  const need = page.locator('#scrThread').getByRole('region', { name: 'Needs your OK' });
  await expect(need).toBeVisible({ timeout: 30_000 });
  await expect(need.locator('.why')).toContainText(
    'A rule held this before it ran: Every report is read by a person before it is written.',
  );

  await page.locator('#scrThread .run-inspector summary').first().click();
  const supervision = page.locator('#scrThread').getByRole('region', { name: 'Supervision' });
  const firing = supervision.locator('.supervision-records > li[data-intervention="hold"]');
  await expect(firing).toHaveCount(1);
  await expect(firing).toContainText(
    'Project rule reports-read-first v1: Every report is read by a person before it is written.',
  );
  await expect(firing).toContainText('Matched the proposed propose_write call on Harness report.md, before it was admitted.');
  await expect(firing.locator('[data-trigger-outcome]')).toHaveText('Held before it ran. It waits for your answer.');
  expect(errors).toEqual([]);
});

test('an organization rule written in Settings cannot be loosened by a project rule, and every refusal is the server’s sentence', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await task('Summarise the linen order', 'Summarise order.md.');
  await page.goto(baseURL);
  await reopenLastProject(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Rules', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Rules', exact: true, level: 1 })).toBeVisible();
  const organization = page.locator('.trigger-rules[data-authority="organization"]');
  await expect(organization.locator('.trigger-rules-reach')).toContainText(`Trigger rules watch ${AGENT_NAME} work loop runs only.`);

  // A pattern outside the bounded grammar: the server refuses it, and the form says so verbatim.
  await organization.getByRole('button', { name: 'Add a rule' }).click();
  let form = organization.getByRole('form', { name: 'New rule' });
  await form.getByLabel('Rule id').fill('no-openers');
  await form.getByLabel('What it is for').fill('Nothing starts a reply with an apology.');
  await form.getByLabel('A pattern in streamed text').check();
  await form.getByLabel('Pattern', { exact: true }).fill('^sorry');
  await page.setViewportSize({ width: 640, height: 900 });
  expect(await noSideScroll(page)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await form.getByRole('button', { name: 'Save rule' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'A pattern cannot use ^ or $: a chunk boundary is not the start or end of the text.',
  );
  // A hold on streamed text is refused the same way.
  await form.getByLabel('A phrase in streamed text').check();
  await form.getByLabel('Phrase', { exact: true }).fill('sorry');
  await form.getByLabel('When it matches').selectOption('hold');
  await form.getByRole('button', { name: 'Save rule' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'Only a tool intent can be held for you; text that was streamed has already been said.',
  );
  await form.getByRole('button', { name: 'Cancel' }).click();

  await organization.getByRole('button', { name: 'Add a rule' }).click();
  form = organization.getByRole('form', { name: 'New rule' });
  await form.getByLabel('Rule id').fill('reports-held');
  await form.getByLabel('What it is for').fill('Every report waits for a person.');
  await form.getByLabel('A proposed tool call, before it runs').check();
  await form.getByLabel('Tool', { exact: true }).fill('propose_write');
  await form.getByLabel('When it matches').selectOption('hold');
  await form.getByRole('button', { name: 'Save rule' }).click();
  await expect(form).toHaveCount(0);
  await expect(organization.locator('.trigger-rule[data-rule="reports-held"] .trigger-rule-match')).toHaveText(
    'A proposed propose_write call · Every project',
  );

  await openThread(page, 'Summarise the linen order');
  const rules = await openRules(page);
  const inherited = rules.getByRole('region', { name: 'Organization rules' }).locator('.trigger-rule[data-rule="reports-held"]');
  await expect(inherited.locator('.trigger-rule-decision')).toHaveText('Governs · Governs trigger:reports-held.');
  await expect(inherited.getByRole('button')).toHaveCount(0);

  await rules.getByRole('button', { name: 'Add a rule' }).click();
  form = rules.getByRole('form', { name: 'New rule' });
  await form.getByLabel('Rule id').fill('reports-noted');
  await form.getByLabel('What it is for').fill('Only note report writes here.');
  await form.getByLabel('A proposed tool call, before it runs').check();
  await form.getByLabel('Tool', { exact: true }).fill('propose_write');
  await form.getByLabel('When it matches').selectOption('annotate');
  await form.getByText('Requirement key', { exact: true }).click();
  await form.getByLabel('Requirement key', { exact: true }).fill('trigger:reports-held');
  await form.getByRole('button', { name: 'Save rule' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'reports-noted: reports-held (organization) restricts trigger:reports-held with organization authority, and this cannot loosen it.',
  );
  const saved = await api<{ project: StreamRule[] }>(`/projects/${project.id}/stream-rules`);
  expect(saved.project.map((rule) => rule.id)).toEqual(['reports-read-first']);

  // At a 200% zoom width, the form, its refusal and the thread head stay inside the page.
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(form.getByRole('alert')).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(errors).toEqual([]);
});
