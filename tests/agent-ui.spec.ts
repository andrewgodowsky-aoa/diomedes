import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Conversation, Project, TaskCandidate } from '../shared/types';

/**
 * Browser proof that Agent and Model are two independent choices in the main
 * interaction surface, using the real built UI and the real routes.
 *
 * The claim is deliberately narrow: picking a worker changes who does the work
 * and nothing else, and the surface says so where a person will read it rather
 * than in a tooltip.
 */
test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const EVIDENCE = path.resolve('evidence/agents');
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';
let savedCodexHome: string | undefined;
let projectId = '';

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(`Agent fixture ${route} failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  await fs.mkdir(EVIDENCE, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'agent-ui-'));
  // A fixed model list, so the model control never reads the real account.
  const codexHome = path.join(fixtureRoot, 'codex');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, 'models_cache.json'),
    JSON.stringify({
      models: [
        {
          slug: 'fixture-model-a',
          display_name: 'Fixture model A',
          visibility: 'list',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }],
        },
        {
          slug: 'fixture-model-b',
          display_name: 'Fixture model B',
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
    nativeGenerator: async () => ({ model: 'fixture-model-a', text: '{"summary":"","changes":[]}' }),
    reviewerAdapter: null,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server.on('request', application);

  const project = await api<Project>('/projects/sample', 'POST', {});
  projectId = project.id;
  const { found } = await api<{ found: TaskCandidate[] }>(
    `/projects/${projectId}/plans/find-tasks`,
    'POST',
    { path: 'Reopening plan.md' },
  );
  const created = await api<{ tasks: { id: string }[] }>(
    `/projects/${projectId}/plans/add-tasks`,
    'POST',
    { path: 'Reopening plan.md', items: [{ ...found[0], name: 'Agent choice' }] },
  );
  await api(`/projects/${projectId}/threads`, 'POST', {
    taskId: created.tasks[0].id,
    name: 'Agent choice',
    permission: 'show-first',
    engine: 'codex',
  });
  // A project Agent that no engine here can support, so the menu has one to refuse.
  const folder = (await api<{ project: { folder: string } }>(`/projects/${projectId}/state`)).project
    .folder;
  await fs.mkdir(path.join(folder, '.diomedes', 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(folder, '.diomedes', 'agents', 'runner.json'),
    JSON.stringify({
      protocolVersion: 1,
      id: 'acme.runner',
      version: '1.0.0',
      name: 'Build Runner',
      summary: 'Runs the build command and reports what failed.',
      modes: ['build'],
      role: 'Run the build and report the first failure.',
      requires: ['shell-commands'],
      tools: [],
      ruleScopes: ['project'],
      permissionCeiling: 'review',
      models: [],
      handoff: { accepts: [], produces: ['findings.list'] },
      evidence: ['findings.list'],
    }),
  );
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
    openProjects: [projectId],
  });
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

const agentButton = (page: Page) => page.getByRole('button', { name: 'Worker for this thread' });
// The model control names itself by its current selection, so locate the
// control rather than a label that changes as soon as the test uses it.
const modelButton = (page: Page) => page.locator('.model-picker > button');
const thread = async (): Promise<Conversation> => {
  const { threads } = await api<{ threads: Conversation[] }>(`/projects/${projectId}/threads`);
  return threads[0];
};

async function open(page: Page) {
  await page.goto(`${baseURL}/`);
  await expect(page.locator('.console')).toBeVisible();
  await expect(agentButton(page)).toBeVisible();
}

test('the worker and the model are two separate controls', async ({ page }) => {
  await open(page);
  await expect(agentButton(page)).toContainText('Agent');
  // Auto names the worker it would resolve to, before anything is started.
  await expect(agentButton(page)).toContainText('Auto');
  await expect(modelButton(page)).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE, 'agent-and-model-controls.png') });
});

test('the menu says plainly that choosing a worker grants nothing', async ({ page }) => {
  await open(page);
  await agentButton(page).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Choosing a worker does not change what it may do.')).toBeVisible();
  await expect(menu.getByText(/Permissions decide that/)).toBeVisible();
  // Job identities, not skills, rule ids or system prompts.
  await expect(menu.getByRole('menuitemradio', { name: /^Code Reviewer/ })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /^Documentation Researcher/ })).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE, 'agent-menu.png') });
});

test('a worker this engine cannot support states its reason instead of vanishing', async ({
  page,
}) => {
  await open(page);
  await agentButton(page).click();
  const blocked = page.getByRole('menuitemradio', { name: /^Build Runner/ });
  await expect(blocked).toBeVisible();
  await expect(blocked).toBeDisabled();
  await expect(blocked).toContainText(/cannot run shell commands/i);
});

test('choosing a worker leaves the model alone, and the model leaves the worker alone', async ({
  page,
}) => {
  await open(page);
  await agentButton(page).click();
  await page.getByRole('menuitemradio', { name: /^Code Reviewer/ }).click();
  await expect(agentButton(page)).toContainText('Code Reviewer');
  await expect.poll(async () => (await thread()).requested?.agent).toBe('diomedes.reviewer');
  // Picking a worker set no model.
  expect((await thread()).requested?.model ?? null).toBeNull();

  /*
   * The model menu lists a signed-in engine's live catalogue, and this fixture
   * deliberately has no signed-in account: faking one would prove nothing about
   * the axes. So the model is set through the same thread route the model
   * control itself calls, and the assertions below are on what the surface then
   * does with two choices present.
   */
  const current = await thread();
  await api(`/projects/${projectId}/threads/${current.id}`, 'PUT', {
    requested: { model: 'fixture-model-b', effort: 'low', agent: 'diomedes.reviewer' },
    engine: 'codex',
  });
  await page.reload();
  await expect(agentButton(page)).toContainText('Code Reviewer');
  await expect(modelButton(page)).toContainText('fixture-model-b');

  // Switching the worker back to Auto must not disturb the model.
  await agentButton(page).click();
  await page.getByRole('menuitemradio', { name: /^Auto/ }).click();
  await expect(agentButton(page)).toContainText('Auto');
  await expect.poll(async () => (await thread()).requested?.agent ?? null).toBeNull();
  expect((await thread()).requested?.model).toBe('fixture-model-b');
  await expect(modelButton(page)).toContainText('fixture-model-b');
  await page.screenshot({ path: path.join(EVIDENCE, 'agent-and-model-kept.png') });
});
