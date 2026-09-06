import { test, expect } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import type { NativeGenerator } from '../server/native-work';
import type { Project, ProjectState, TaskCandidate } from '../shared/types';

// This scenario exercises the native controller and browser plumbing with an
// injected generator. It never calls a model, uses credentials, or spends quota.
const port = 47634;
const baseURL = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let project: Project;
let generationCount = 0;
let generatedInput: Parameters<NativeGenerator>[0] | undefined;
let original = '';
let proposed = '';

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`Native UI fixture request ${route} failed (${response.status}): ${await response.text()}`);
  return response.json();
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'native-ui-'));
  application = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    port,
    clientPort: port,
    nativeGenerator: async input => {
      generationCount += 1;
      generatedInput = input;
      if (input.documents.length !== 1 || input.documents[0].path !== 'Reopening plan.md') throw new Error('The native UI test received an unexpected source selection.');
      proposed = `${input.documents[0].text}\nValidation-only approved revision.\n`;
      return {
        model: 'Injected browser-test generator',
        threadId: 'injected-browser-test',
        text: JSON.stringify({
          summary: 'Add the approved validation revision to the selected plan.',
          changes: [{ path: 'Reopening plan.md', text: proposed, summary: 'Append one revision to the selected plan.' }],
        }),
      };
    },
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server = application.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });
  project = await api<Project>('/projects/sample', 'POST', {});
  const { found } = await api<{ found: TaskCandidate[] }>(`/projects/${project.id}/plans/find-tasks`, 'POST', { path: 'Reopening plan.md' });
  await api(`/projects/${project.id}/plans/add-tasks`, 'POST', { path: 'Reopening plan.md', items: found.slice(0, 1) });
  original = await fs.readFile(path.join(project.folder, 'Reopening plan.md'), 'utf8');
  await api('/settings', 'PUT', {
    detail: 'guided',
    surface: 'book',
    services: { codex: true },
    onboarding: { work: 'business', detail: 'guided', familiarity: 'new', resumeAt: 'done', completedAt: new Date().toISOString() },
    lastPage: { [project.id]: 'tasks' },
  });
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
});

test('Native UI: consent, exact proposal preview, approval, Review and History with an injected generator', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL);
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'book');
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'guided');
  await page.locator('.task-card').first().locator('.task-title').click();
  await page.getByRole('dialog').getByRole('combobox', { name: 'Work service' }).selectOption('codex');
  await page.getByRole('dialog').getByRole('button', { name: 'Do this for me', exact: true }).click();
  const consent = page.getByRole('dialog', { name: 'Use an online service for this task?' });
  await expect(consent).toBeVisible();
  expect(generationCount).toBe(0);
  expect(await fs.readFile(path.join(project.folder, 'Reopening plan.md'), 'utf8')).toBe(original);
  await page.screenshot({ path: testInfo.outputPath('native-consent.png'), animations: 'disabled', fullPage: true });
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  const need = page.getByRole('region', { name: 'Needs your OK' });
  await expect(need).toBeVisible();
  expect(generationCount).toBe(1);
  expect(generatedInput?.documents).toEqual([{ path: 'Reopening plan.md', text: original }]);
  expect(await fs.readFile(path.join(project.folder, 'Reopening plan.md'), 'utf8')).toBe(original);
  await need.getByRole('button', { name: 'Show me first', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Proposed changes', exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(/Validation-only approved revision\./)).toBeVisible();
  expect(await fs.readFile(path.join(project.folder, 'Reopening plan.md'), 'utf8')).toBe(original);
  await page.screenshot({ path: testInfo.outputPath('native-proposal-preview.png'), animations: 'disabled', fullPage: true });
  await preview.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect(preview).not.toBeVisible();
  await expect.poll(async () => (await api<ProjectState>(`/projects/${project.id}/state`)).sessions[0]?.state).toBe('done');
  expect(await fs.readFile(path.join(project.folder, 'Reopening plan.md'), 'utf8')).toBe(proposed);
  const rail = page.getByRole('navigation', { name: 'Project pages' });
  await rail.getByRole('button', { name: /^Review\b/ }).click();
  await expect(page.locator('.change-card').getByText(/Validation-only approved revision\./)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('native-review.png'), animations: 'disabled', fullPage: true });
  await page.getByRole('button', { name: 'Keep all', exact: true }).click();
  await expect.poll(async () => (await api<ProjectState>(`/projects/${project.id}/state`)).tasks[0]?.state).toBe('done');
  await rail.getByRole('button', { name: /^History\b/ }).click();
  const state = await api<ProjectState>(`/projects/${project.id}/state`);
  const changed = state.history.find(entry => entry.kind === 'changed');
  expect(changed?.files[0].before).toBeTruthy();
  expect(changed?.files[0].after).toBeTruthy();
  expect(changed?.files[0].before).not.toBe(changed?.files[0].after);
  expect(state.needs[0].state).toBe('go-ahead');
  expect(state.history.some(entry => entry.kind === 'decision' && entry.sessionId === state.sessions[0].id)).toBe(true);
  await expect(page.locator('.history-entry').filter({ hasText: changed!.sentence })).toBeVisible();
  expect(generationCount).toBe(1);
  expect(errors).toEqual([]);
});
