import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Conversation, Project, ProjectState, TaskCandidate } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

/**
 * H09 browser proof, on the real built UI and the real routes: Settings lists
 * exact-model profiles and edits them into new revisions, the composer's
 * picker offers them and shows an unavailable one with its reason instead of
 * hiding it, and a run's details name the revision it pinned and the model the
 * runtime reported when that differs from the one asked for.
 */
test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';
let savedCodexHome: string | undefined;
let projectId = '';
let taskId = '';
let shots = '';

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(`Profile fixture ${route} failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'agent-profiles-ui-'));
  shots = path.join(fixtureRoot, 'shots');
  await fs.mkdir(shots, { recursive: true });
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
    // The runtime reports a dated snapshot of the model it was asked for.
    nativeGenerator: async (input) => ({
      model: `${input.model ?? 'default'}-0924`,
      text: JSON.stringify({
        summary: 'Create it',
        changes: [{ path: 'Result.md', text: 'profile result', summary: 'Result' }],
      }),
    }),
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
    { path: 'Reopening plan.md', items: [{ ...found[0], name: 'Profile choice' }] },
  );
  taskId = created.tasks[0].id;
  await api(`/projects/${projectId}/threads`, 'POST', {
    taskId,
    name: 'Profile choice',
    permission: 'show-first',
    engine: 'codex',
  });
  await api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['codex'],
    documents: ['Result.md'],
    shareConversationHistory: false,
    shareReviewPackets: true,
  });
  // A profile on a route that is off, so both screens have one to show as unavailable.
  await api('/agent-profiles', 'POST', {
    name: 'Offline writer',
    engine: 'opencode',
    model: 'glm-9',
    agentId: 'diomedes.builder',
  });
  await api('/settings', 'PUT', {
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
const thread = async (): Promise<Conversation> => {
  const { threads } = await api<{ threads: Conversation[] }>(`/projects/${projectId}/threads`);
  return threads[0];
};
const profileSection = (page: Page, name: string) =>
  page.getByRole('region', { name: `Profile ${name}`, exact: true });

async function open(page: Page) {
  await page.goto(`${baseURL}/`);
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await expect(agentButton(page)).toBeVisible();
}

test('Settings lists profiles with their reason, and an edit saves a new revision', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Agent profiles', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Agent profiles', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(profileSection(page, 'Offline writer')).toContainText(
    'Unavailable: OpenCode is off in Settings > Engines.',
  );

  await page.getByRole('button', { name: 'New profile', exact: true }).click();
  const editor = page.getByRole('form', { name: 'New profile' });
  await editor.getByLabel('Name').fill('Fixture writer');
  await editor.getByLabel('Model id, exactly as the route lists it').fill('fixture-model-a');
  await editor.getByLabel('Reasoning level (optional)').fill('medium');
  await editor.getByLabel('Works as').selectOption({ label: 'Change Builder' });
  await editor.getByLabel(/Rules, one per line/).fill('Keep British spelling.');
  await editor.getByRole('button', { name: 'Save profile' }).click();
  const writer = profileSection(page, 'Fixture writer');
  await expect(writer).toContainText('Revision 1');
  await expect(writer).toContainText('ChatGPT · fixture-model-a · medium · Change Builder');
  await expect(writer).toContainText('Keep British spelling.');

  await writer.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('form', { name: 'Edit profile' });
  await edit.getByLabel('Model id, exactly as the route lists it').fill('fixture-model-b');
  await edit.getByLabel('Reasoning level (optional)').fill('low');
  await edit.getByRole('button', { name: 'Save as revision 2' }).click();
  await expect(writer).toContainText('Revision 2');
  await expect(writer).toContainText('fixture-model-b · low');
  await page.screenshot({ path: path.join(shots, 'profiles-settings.png') });
});

test('the composer offers profiles, and an unavailable one states its reason', async ({ page }) => {
  await open(page);
  await agentButton(page).click();
  const menu = page.getByRole('menu');
  const offline = menu.getByRole('menuitemradio', { name: /^Offline writer/ });
  await expect(offline).toBeVisible();
  await expect(offline).toBeDisabled();
  await expect(offline).toContainText('Unavailable: OpenCode is off in Settings > Engines.');
  await menu.getByRole('menuitemradio', { name: /^Fixture writer/ }).click();
  await expect(agentButton(page)).toContainText('Profile');
  await expect(agentButton(page)).toContainText('Fixture writer');
  await expect.poll(async () => (await thread()).requested?.profile ?? null).toMatch(/^pr-/);
  await page.screenshot({ path: path.join(shots, 'profiles-picker.png') });
});

test('run details name the pinned revision and the model the runtime reported', async ({ page }) => {
  const current = await thread();
  await api(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    threadId: current.id,
    route: 'codex',
    consent: true,
    sources: [],
  });
  await expect
    .poll(async () => {
      const state = await api<ProjectState>(`/projects/${projectId}/state`);
      return state.sessions.at(-1)?.engine.model ?? null;
    })
    .toBe('fixture-model-b-0924');
  // An edit after admission makes revision 3 and leaves the run on revision 2.
  const profileId = current.requested!.profile!;
  await api(`/agent-profiles/${profileId}`, 'PUT', {
    expectedRevision: 2,
    name: 'Fixture writer',
    engine: 'codex',
    model: 'fixture-model-a',
    effort: 'medium',
    agentId: 'diomedes.builder',
    rules: [],
  });
  await open(page);
  const details = page.locator('details.run-inspector');
  await details.locator('summary').click();
  await expect(details).toContainText('Fixture writer · revision 2');
  await expect(details).toContainText("This thread's profile. Fallback off.");
  await expect(details).toContainText(
    'Ran on fixture-model-b-0924, as the runtime reported. Requested fixture-model-b.',
  );
  await page.screenshot({ path: path.join(shots, 'profiles-run-details.png') });
});
