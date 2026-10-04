import { test, expect } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { BonsaiError } from '../server/bonsai/runtime';
import type { BonsaiStatus } from '../shared/bonsai';
import type { ProjectState } from '../shared/types';

// Real application and built UI, with only the local worker lifecycle replaced.
// This spec never starts or calls a model and never touches the installed profile.
const port = 47645, baseURL = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>>, server: Server;
let status: BonsaiStatus = { installed: true, state: 'unloaded', owned: false, mode: null, detail: 'Choose a profile.' };
let refuseFull = true;
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
    bonsai: { configured: true, host: {
      inspect: async () => status,
      acquire: async profile => {
        wakes.push(profile.slug);
        if (profile.mode === 'Full' && refuseFull) throw new BonsaiError('insufficient-memory', 'Needs 12288 MiB of free VRAM.');
        status = { installed: true, state: 'ready', owned: true, mode: profile.mode, detail: `${profile.name} is ready.` };
        return { status, release: async () => {} };
      },
    } },
  });
  const dist = path.resolve('dist'), built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const name of ['client/console/LocalModelControls.tsx', 'client/console/DiomedesHome.tsx', 'shared/bonsai.ts'])
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
test('Home selects and reloads local profiles, preserves effort and agent, and reports load failure', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL);
  await expect(page.getByRole('button', { name: 'Choose a local model', exact: true })).toBeVisible();
  expect(await api('/home/conversation')).toBeNull();
  await page.getByRole('button', { name: 'Choose a local model', exact: true }).click();
  const model = page.getByRole('combobox', { name: 'Local model', exact: true });
  await expect(model).toBeVisible();
  expect(wakes).toEqual([]);
  await model.selectOption('bonsai-gaming');
  await expect(page.getByRole('status').filter({ hasText: 'Bonsai Gaming is ready.' })).toBeVisible();
  const effort = page.getByRole('combobox', { name: 'Local reasoning effort' });
  await effort.selectOption('xhigh');
  await expect(effort).toBeEnabled();
  await expect(page.getByRole('img', { name: '16,384 token context' })).toBeVisible();
  await expect(page.locator('.local-model-controls .agent-picker')).toContainText('Auto');
  const binding = await api<{ projectId: string; threadId: string }>('/home/conversation');
  const current = async () => (await api<ProjectState>(`/projects/${binding.projectId}/state`))
    .conversations.find(thread => thread.id === binding.threadId);
  expect(await current()).toMatchObject({ engine: 'bonsai', requested: { model: 'bonsai-gaming', effort: 'xhigh' } });
  await page.reload();
  await expect(model).toHaveValue('bonsai-gaming'); await expect(effort).toHaveValue('xhigh');
  await model.selectOption('bonsai-full');
  await expect(page.getByRole('alert').filter({ hasText: '12288' })).toBeVisible();
  expect(await current()).toMatchObject({ engine: 'bonsai', requested: { model: 'bonsai-full' } });
  await expect(page.getByRole('img', { name: '131,072 token context' })).toBeVisible();
  refuseFull = false;
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Bonsai Full is ready.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attach image', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use online', exact: true }).click();
  await expect(model).toHaveValue('');
  expect(await current()).toMatchObject({ engine: 'nectovia', requested: null });
  expect(errors).toEqual([]);
});
