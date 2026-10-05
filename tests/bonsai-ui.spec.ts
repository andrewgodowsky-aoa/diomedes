import { test, expect } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { LocalModelError } from '../server/bonsai/runtime';
import type { LocalModelStatus } from '../shared/local-model';
import type { Conversation, ProjectState } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';
import { FixedLocalModel, MEADOW_FOLDER, meadowDescriptor } from './fixtures/local-model';

// Real application and built UI, with only the local worker lifecycle replaced. The model is a
// described one that is not Bonsai, so every name on screen comes from its description.
// This spec never starts or calls a model and never touches an installed one.
const port = 47645, baseURL = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>>, server: Server;
let status: LocalModelStatus = { installed: true, state: 'unloaded', owned: false, mode: null, detail: 'Choose a profile.' };
let refuseFull = true;
// Every start the fake worker was asked for. Only the person's Start may ask for one.
const wakes: string[] = [];
async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json() as Promise<T>;
}
test.beforeAll(async () => {
  const results = path.resolve('test-results'); await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'bonsai-ui-'));
  application = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    port, clientPort: port, reviewerAdapter: null, automationTickMs: null,
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    localModel: { source: new FixedLocalModel(meadowDescriptor(), MEADOW_FOLDER), host: {
      inspect: async () => status,
      // The helper's rule: only an explicit Start may start the worker or switch its profile.
      acquire: async (profile, options, descriptor) => {
        if (!options?.start) {
          if (status.state !== 'ready' || status.mode !== profile.mode)
            throw new LocalModelError('unloaded', "The local model isn't running. Start it first.");
          return { status, release: async () => {} };
        }
        wakes.push(profile.slug);
        if (profile.mode === 'Deep' && refuseFull) throw new LocalModelError('insufficient-memory', 'Needs 12288 MiB of free VRAM.');
        status = { installed: true, state: 'ready', owned: true, mode: profile.mode, model: descriptor.model,
          contextTokens: profile.contextTokens, detail: `${profile.name} is ready.` };
        return { status, release: async () => {} };
      },
    } },
  });
  const dist = path.resolve('dist'), built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const name of ['client/console/LocalModelControls.tsx', 'client/console/DiomedesHome.tsx', 'client/console/AskRow.tsx',
    'client/console/ask-row.ts', 'client/LocalModelFolder.tsx', 'shared/local-model.ts'])
    expect(built, 'Build the current UI before running this spec.').toBeGreaterThan((await fs.stat(name)).mtimeMs);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server = application.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  await api('/settings', 'PUT', { onboarding: { work: 'business', detail: 'guided', familiarity: 'new',
    resumeAt: 'done', completedAt: new Date().toISOString() } });
});
test.afterAll(async () => {
  await application?.locals.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});
test('Home selects and reloads local profiles, preserves effort and agent, and starts only on Start', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL);
  await expect(page.getByRole('button', { name: 'Choose a local model', exact: true })).toBeVisible();
  expect(await api('/home/conversation')).toBeNull();
  await page.getByRole('button', { name: 'Choose a local model', exact: true }).click();
  const model = page.getByRole('combobox', { name: 'Local model', exact: true });
  const start = page.locator('.local-model-controls').getByRole('button', { name: 'Start', exact: true });
  await expect(model).toBeVisible();
  expect(wakes).toEqual([]);
  await model.selectOption('local:quick');
  const effort = page.getByRole('combobox', { name: 'Local reasoning effort' });
  await effort.selectOption('xhigh');
  await expect(effort).toBeEnabled();
  // Choosing a profile and a level saves them; nothing has started the model.
  expect(wakes).toEqual([]);
  await start.click();
  await expect(page.getByRole('status').filter({ hasText: 'meadow-9b Quick is ready.' })).toBeVisible();
  expect(wakes).toEqual(['local:quick']);
  await expect(start).toHaveCount(0);
  await expect(page.getByRole('img', { name: '16,384 token context' })).toBeVisible();
  await expect(page.locator('.local-model-controls .agent-picker')).toContainText('Auto');
  const binding = await api<{ projectId: string; threadId: string }>('/home/conversation');
  const current = async () => (await api<ProjectState>(`/projects/${binding.projectId}/state`))
    .conversations.find(thread => thread.id === binding.threadId);
  expect(await current()).toMatchObject({ engine: 'bonsai', requested: { model: 'local:quick', effort: 'xhigh' } });
  await page.reload();
  await expect(model).toHaveValue('local:quick'); await expect(effort).toHaveValue('xhigh');
  await model.selectOption('local:deep');
  await expect.poll(async () => (await current())?.requested?.model).toBe('local:deep');
  await expect(page.getByRole('img', { name: '131,072 token context' })).toBeVisible();
  // Another profile is loaded; choosing this one did not switch it.
  expect(wakes).toEqual(['local:quick']);
  await start.click();
  await expect(page.getByRole('alert').filter({ hasText: '12288' })).toBeVisible();
  expect(await current()).toMatchObject({ engine: 'bonsai', requested: { model: 'local:deep' } });
  refuseFull = false;
  await start.click();
  await expect(page.getByRole('status').filter({ hasText: 'meadow-9b Deep is ready.' })).toBeVisible();
  expect(wakes).toEqual(['local:quick', 'local:deep', 'local:deep']);
  await expect(page.getByRole('button', { name: 'Attach image', exact: true })).toBeVisible();
  // Every name on screen came from the description and the server; none is written into the app.
  await expect(page.locator('body')).not.toContainText(/bonsai/i);
  await page.getByRole('button', { name: 'Use online', exact: true }).click();
  await expect(model).toHaveValue('');
  expect(await current()).toMatchObject({ engine: 'nectovia', requested: null });
  expect(errors).toEqual([]);
});
test('Work: the ask row offers the local model, lists its profiles and levels, and starts it only on Start', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  // Set up on this computer and not running.
  status = { installed: true, state: 'unloaded', owned: false, mode: null, detail: 'Choose a profile.' };
  refuseFull = false;
  wakes.length = 0;
  const project = await api<{ id: string }>('/projects', 'POST', { name: 'Local model work' });
  const created = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', { name: 'Local model thread', mode: 'ask' });
  await api(`/projects/${project.id}/threads/${created.id}`, 'PUT', { engine: 'nectovia', requested: null });
  await api('/settings', 'PUT', { openProjects: [project.id] });
  const current = async () => (await api<ProjectState>(`/projects/${project.id}/state`))
    .conversations.find(thread => thread.id === created.id);
  await page.goto(baseURL);
  await reopenLastProject(page);
  await page.getByRole('navigation', { name: 'Threads and views' }).getByRole('button', { name: /^Local model thread/ }).click();
  const row = page.getByRole('group', { name: 'Engine, model and agent' });
  const engine = row.locator('.ask-engine .ask-pick'), tier = row.locator('.ask-tier .ask-pick');
  const modelBox = row.locator('.ask-model .ask-pick'), effortBox = row.locator('.ask-effort .ask-pick');
  const local = row.locator('.ask-local'), ring = page.locator('.ask-ring');
  await expect(engine).toHaveAttribute('aria-label', 'Engine: Nectovia');

  // Set up but not running: the tier menu grays the Local model and offers its Start beside it.
  await tier.click();
  const tiers = page.getByRole('menu', { name: 'How much care' });
  const choice = tiers.getByRole('menuitemradio', { name: /^Local model/ });
  await expect(choice).toBeDisabled();
  await expect(choice).toContainText('Not running');
  expect(wakes).toEqual([]);
  await tiers.getByRole('menuitem', { name: 'Start the local model' }).click();
  await expect(choice).toBeEnabled();
  expect(wakes).toEqual(['local:quick']);
  await choice.click();
  await expect.poll(current).toMatchObject({ engine: 'bonsai', requested: { model: 'local:quick', effort: 'medium' } });

  // On the local model the profile and its own levels and window come from the host's catalogue.
  await expect(engine).toHaveAttribute('aria-label', 'Engine: Nectovia');
  await expect(modelBox).toHaveAttribute('aria-label', 'Model: meadow-9b Quick');
  await expect(effortBox).toHaveAttribute('aria-label', 'Effort: Medium');
  await expect(ring).toHaveAttribute('title', /16k token window/);
  await expect(local).toHaveCount(0);
  await modelBox.click();
  const menu = page.getByRole('menu', { name: 'How much care' });
  for (const name of ['Efficient', 'Focused', 'Thorough'])
    await expect(menu.getByRole('menuitemradio', { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /^meadow-9b Quick/ })).toContainText('Running');
  await menu.getByRole('menuitemradio', { name: /^meadow-9b Deep/ }).click();
  await expect.poll(current).toMatchObject({ engine: 'bonsai', requested: { model: 'local:deep', effort: 'xhigh' } });
  await expect(modelBox).toHaveAttribute('aria-label', 'Model: meadow-9b Deep');
  await expect(effortBox).toHaveAttribute('aria-label', 'Effort: Extra high');
  await expect(ring).toHaveAttribute('title', /131k token window/);

  // Another profile is loaded: the choice is withdrawn and said so, with its Start beside it.
  await expect(local).toContainText('running another profile');
  expect(wakes).toEqual(['local:quick']);
  await local.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(local).toHaveCount(0);
  expect(wakes).toEqual(['local:quick', 'local:deep']);

  // A level is the profile's own, and changing it starts nothing.
  await effortBox.click();
  await page.getByRole('dialog', { name: 'Effort' }).getByRole('radio', { name: 'Medium', exact: true }).click();
  await expect.poll(async () => (await current())?.requested?.effort).toBe('medium');
  await expect(effortBox).toHaveAttribute('aria-label', 'Effort: Medium');

  // A tier takes the thread back to Nectovia.
  await modelBox.click();
  await page.getByRole('menu', { name: 'How much care' }).getByRole('menuitemradio', { name: /^Focused/ }).click();
  await expect.poll(current).toMatchObject({ engine: 'nectovia', workStyle: 'focused' });
  await expect(tier).toHaveAttribute('aria-label', 'How much care: Focused');
  expect(wakes).toEqual(['local:quick', 'local:deep']);
  await expect(page.locator('body')).not.toContainText(/bonsai/i);
  expect(errors).toEqual([]);
});
