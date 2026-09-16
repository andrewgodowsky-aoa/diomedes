import { test, expect } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import type { NativeGenerator } from '../server/native-work';
import type { ApprovalCommand, Conversation, Need, Project, ProjectState, Session, Task, TaskCandidate } from '../shared/types';

// This scenario exercises the native controller and browser plumbing with an
// injected generator. It never calls a model, uses credentials, or spends quota.

/**
 * Unlike ui.spec.ts, this file serves the built bundle rather than the dev
 * server, so it tests whatever was last built. A stale dist does not usually
 * fail: it passes, against code nobody wrote today, and looks exactly like a
 * real pass. Refuse to run instead, and say what to do about it.
 */
async function expectFreshBundle(dist: string): Promise<void> {
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  let newest = 0;
  let newestPath = '';
  for (const dir of ['client', 'shared']) {
    for (const entry of await fs.readdir(path.resolve(dir), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.resolve(dir, entry.name);
      const { mtimeMs } = await fs.stat(file);
      if (mtimeMs > newest) {
        newest = mtimeMs;
        newestPath = path.relative(process.cwd(), file);
      }
    }
  }
  expect(
    built,
    `dist is older than ${newestPath}, so this spec would test the previous build. Run "npm run build" first.`,
  ).toBeGreaterThan(newest);
}
const port = Number(process.env.DIOMEDES_NATIVE_UI_PORT ?? 47634);
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
  await expectFreshBundle(dist);
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
    surface: 'workbook',
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
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'workbook');
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'guided');
  await page.locator('.task-card').first().locator('.task-title').click();
  await page.getByRole('dialog').getByRole('combobox', { name: 'Work service' }).selectOption('codex');
  const commands: string[] = [];
  let admitted: Session | undefined;
  await page.route(`**/api/projects/${project.id}/work/start`, async route => {
    commands.push(route.request().postDataJSON().commandId);
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (commands.length === 1) {
      admitted = await response.json();
      // The host has admitted Work. Lose only its HTTP acknowledgment.
      await route.abort('connectionreset');
    } else {
      await route.fulfill({ response });
    }
  });
  expect(generationCount).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Do this for me', exact: true }).click();
  expect(await fs.readFile(path.join(project.folder, 'Reopening plan.md'), 'utf8')).toBe(original);
  const need = page.getByRole('region', { name: 'Needs your OK' });
  await expect(need).toBeVisible();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[0]).toBeTruthy();
  expect(commands[1]).toBe(commands[0]);
  const replay = await api<Session>(`/projects/${project.id}/work/commands/${commands[0]}`);
  expect(replay.receipt).toEqual(admitted?.receipt);
  expect((await api<ProjectState>(`/projects/${project.id}/state`)).sessions).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage)
    .filter(key => key.startsWith('diomedes.work-start.pending.')).length)).toBe(0);
  await page.reload();
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
  await page.screenshot({ path: 'evidence/screenshots/work-admission-workbook.png', animations: 'disabled', fullPage: true });
  await expect(preview.getByText(/Expires /)).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Go ahead for this whole task', exact: true })).toHaveCount(0);
  const approvalCommands: ApprovalCommand[] = [];
  let approvalReceipt: Need['approvalReceipt'];
  await page.route(`**/api/projects/${project.id}/needs/*/resolve`, async route => {
    approvalCommands.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (approvalCommands.length === 1) {
      approvalReceipt = (await response.json() as Need).approvalReceipt;
      await route.abort('connectionreset');
    } else await route.fulfill({ response });
  });
  await page.screenshot({ path: 'evidence/screenshots/approval-workbook-preview.png', animations: 'disabled', fullPage: true });
  await preview.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect(preview).not.toBeVisible();
  await expect.poll(() => approvalCommands.length).toBe(2);
  expect(approvalCommands[0]).toEqual(approvalCommands[1]);
  const decided = (await api<ProjectState>(`/projects/${project.id}/state`)).needs[0];
  expect(decided.approvalReceipt).toEqual(approvalReceipt);
  expect(decided.execution?.state).toBe('applied');
  await page.reload();
  await expect(page.getByLabel('Approval record')).toContainText('Approved changes applied');
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('diomedes.approval.pending.')).length)).toBe(0);
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

test('Console task Start recovers both lost responses from state without duplicating Work', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const sample = await api<Project>('/projects/sample', 'POST', {});
  const { found } = await api<{ found: TaskCandidate[] }>(`/projects/${sample.id}/plans/find-tasks`, 'POST', { path: 'Reopening plan.md' });
  await api(`/projects/${sample.id}/plans/add-tasks`, 'POST', { path: 'Reopening plan.md', items: found.slice(0, 1) });
  const before = await fs.readFile(path.join(sample.folder, 'Reopening plan.md'));
  await api('/settings', 'PUT', { surface: 'console', openProjects: [sample.id] });
  const commands: string[] = [];
  let admitted: Session | undefined;
  await page.route(`**/api/projects/${sample.id}/work/start`, async route => {
    commands.push(route.request().postDataJSON().commandId);
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (commands.length === 1) {
      admitted = await response.json();
    }
    await route.abort('connectionreset');
  });
  await page.goto(baseURL);
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  await rail.getByRole('button', { name: /^Board/ }).click();
  const board = page.locator('.board[aria-label="Board"]');
  await expect(board).toBeVisible();
  const row = board.locator('.crow').first();
  await row.getByRole('button', { name: 'Start', exact: true }).click();
  const confirm = row.locator('.confirm');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[0]).toBeTruthy();
  expect(commands[1]).toBe(commands[0]);
  await expect(board.getByLabel('Start confirmation')).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage)
    .filter(key => key.startsWith('diomedes.work-start.pending.')).length)).toBe(0);
  await page.reload();
  const state = await api<ProjectState>(`/projects/${sample.id}/state`);
  expect(state.sessions).toHaveLength(1);
  expect(state.sessions[0].receipt).toEqual(admitted?.receipt);
  expect(state.history.filter(entry => entry.kind === 'work-admitted')).toHaveLength(1);
  expect(await fs.readFile(path.join(sample.folder, 'Reopening plan.md'))).toEqual(before);
  // No second native generation was hidden behind the sample task flow.
  expect(generationCount).toBe(1);
  await rail.getByRole('button', { name: /^Board/ }).click();
  await expect(board.getByLabel('Start confirmation')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('console-admission-recovered.png'), animations: 'disabled', fullPage: true });
  await page.screenshot({ path: 'evidence/screenshots/work-admission-console.png', animations: 'disabled', fullPage: true });
  await api(`/projects/${sample.id}/team/members`, 'POST', {
    name: 'Receipt test helper', role: 'member', engine: 'sample',
  });
  await page.evaluate(id => sessionStorage.setItem(`diomedes.work-start.pending.${id}|%invalid`, '{broken'), sample.id);
  await page.reload();
  await rail.getByRole('button', { name: /^Team/ }).click();
  const team = page.locator('.team[aria-label="Team"]');
  await expect(team.locator('.lane').filter({ hasText: 'Receipt test helper' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('A saved Work request could not be checked');
  await page.getByRole('alert').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await api(`/projects/${sample.id}/tasks`, 'POST', { name: 'Check the refreshed board', owner: 'you' });
  await rail.getByRole('button', { name: /^Board/ }).click();
  await expect(board.locator('.crow').filter({ hasText: 'Check the refreshed board' })).toBeVisible();
  await expect(page.getByRole('alert')).not.toBeVisible();
  expect(errors).toEqual([]);
});


test('Console exact approval recovers both lost responses from durable state even with task permission', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = await api<Project>('/projects/sample', 'POST', {});
  const { found } = await api<{ found: TaskCandidate[] }>(`/projects/${fixture.id}/plans/find-tasks`, 'POST', { path: 'Reopening plan.md' });
  await api(`/projects/${fixture.id}/plans/add-tasks`, 'POST', { path: 'Reopening plan.md', items: found.slice(0, 1) });
  const initial = await api<ProjectState>(`/projects/${fixture.id}/state`);
  const before = await fs.readFile(path.join(fixture.folder, 'Reopening plan.md'), 'utf8');
  const thread = await api<Conversation>(`/projects/${fixture.id}/threads`, 'POST', { name: 'Exact approval thread', taskId: initial.tasks[0].id, permission: 'task' });
  const generationsBefore = generationCount;
  await api(`/projects/${fixture.id}/work/start`, 'POST', { protocolVersion: 1, commandId: 'console-native-work', taskId: initial.tasks[0].id, threadId: thread.id, route: 'codex', sources: ['Reopening plan.md'], consent: true });
  await expect.poll(async () => (await api<ProjectState>(`/projects/${fixture.id}/state`)).needs.length).toBe(1);
  const ready = (await api<ProjectState>(`/projects/${fixture.id}/state`)).needs[0];
  const expected = ready.preview![0].after;
  await api('/settings', 'PUT', { surface: 'console', openProjects: [fixture.id] });
  await page.goto(baseURL);
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  await rail.getByRole('button', { name: /Exact approval thread/ }).click();
  const pane = page.locator('#scrThread');
  await expect(pane).toBeVisible();
  const notice = pane.getByRole('region', { name: 'Needs your OK' });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Go ahead for this whole task', exact: true })).toHaveCount(0);
  await expect(notice.getByText(/Expires /)).toBeVisible();
  expect(await fs.readFile(path.join(fixture.folder, 'Reopening plan.md'), 'utf8')).toBe(before);
  const commands: ApprovalCommand[] = [];
  let receipt: Need['approvalReceipt'];
  await page.route(`**/api/projects/${fixture.id}/needs/*/resolve`, async route => {
    commands.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    receipt ??= (await response.json() as Need).approvalReceipt;
    await route.abort('connectionreset');
  });
  await notice.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[0].proposalDigest).toBe(ready.approval!.proposalDigest);
  await page.reload();
  await rail.getByRole('button', { name: /Exact approval thread/ }).click();
  const record = pane.getByLabel('Approval record');
  await expect(record).toContainText('Approved changes applied');
  await record.getByText('Decision record', { exact: true }).click();
  await expect(record).toContainText(receipt!.commandId);
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('diomedes.approval.pending.')).length)).toBe(0);
  expect(await fs.readFile(path.join(fixture.folder, 'Reopening plan.md'), 'utf8')).toBe(expected);
  const completed = await api<ProjectState>(`/projects/${fixture.id}/state`);
  expect(completed.needs[0].approvalReceipt).toEqual(receipt);
  expect(completed.sessions).toHaveLength(1);
  expect(completed.history.filter(entry => entry.kind === 'decision')).toHaveLength(1);
  expect(completed.history.filter(entry => entry.kind === 'changed')).toHaveLength(1);
  expect(generationCount).toBe(generationsBefore + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'evidence/screenshots/approval-console-record.png', animations: 'disabled', fullPage: true });
  await page.screenshot({ path: testInfo.outputPath('console-approval-record.png'), animations: 'disabled', fullPage: true });
  await page.evaluate(id => sessionStorage.setItem(`diomedes.approval.pending.${id}|broken`, '{broken'), fixture.id);
  await page.reload();
  await rail.getByRole('button', { name: /Exact approval thread/ }).click();
  await expect(page.getByRole('alert')).toContainText('A saved approval request could not be checked');
  await expect(pane).toBeVisible();
  expect(errors).toEqual([]);
});

test('Console New task makes a task, Ready shows it, and Start admits one run', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const fresh = await api<Project>('/projects/sample', 'POST', {});
  await api('/settings', 'PUT', { surface: 'console', openProjects: [fresh.id] });
  await page.goto(baseURL);
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  await rail.getByRole('button', { name: /^Board/ }).click();
  const board = page.locator('.board[aria-label="Board"]');
  await expect(board).toBeVisible();
  const ready = board.locator('.column[aria-label="Ready"]');
  await expect(ready).toContainText('Nothing is ready. New task adds one.');
  await board.getByRole('button', { name: 'New task', exact: true }).click();
  const form = board.locator('form.newtask');
  await form.getByLabel('Task name').fill('Draft the operations brief');
  await form.getByLabel('What should happen (optional)').fill('Propose one short section.');
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  const row = ready.locator('.crow').filter({ hasText: 'Draft the operations brief' });
  await expect(row).toBeVisible();
  await expect(form).toHaveCount(0);
  const created = (await api<ProjectState>(`/projects/${fresh.id}/state`)).tasks[0];
  expect(created.creationReceipt?.commandId).toBeTruthy();
  await row.getByText('Creation receipt', { exact: true }).click();
  await expect(row.locator('.creation-receipt')).toContainText(created.creationReceipt!.commandId);
  await expect(row.locator('.creation-receipt')).toContainText(created.creationReceipt!.eventId);
  await row.getByRole('button', { name: 'Start', exact: true }).click();
  const confirm = row.locator('.confirm');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(async () => (await api<ProjectState>(`/projects/${fresh.id}/state`)).sessions.length).toBe(1);
  const state = await api<ProjectState>(`/projects/${fresh.id}/state`);
  expect(state.tasks).toHaveLength(1);
  expect(state.tasks[0].name).toBe('Draft the operations brief');
  expect(state.tasks[0].description).toBe('Propose one short section.');
  expect(state.sessions[0].taskId).toBe(state.tasks[0].id);
  expect(state.sessions[0].receipt?.commandId).toBeTruthy();
  expect(state.history.filter(entry => entry.kind === 'tasks-made')).toHaveLength(1);
  expect(state.history.filter(entry => entry.kind === 'work-admitted')).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('console-new-task.png'), animations: 'disabled', fullPage: true });
  expect(errors).toEqual([]);
});

test('Console retries a lost task creation response after reload and shows the durable receipt', async ({ page }, testInfo) => {
  const fresh = await api<Project>('/projects/sample', 'POST', {});
  await api('/settings', 'PUT', { surface: 'console', openProjects: [fresh.id] });
  const commands: string[] = [];
  const endpoint = `**/api/projects/${fresh.id}/tasks`;
  await page.route(endpoint, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    commands.push(route.request().postDataJSON().commandId);
    await route.fetch();
    await route.abort('failed');
  });
  await page.goto(baseURL);
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  await rail.getByRole('button', { name: /^Board/ }).click();
  const board = page.locator('.board[aria-label="Board"]');
  await board.getByRole('button', { name: 'New task', exact: true }).click();
  const form = board.locator('form.newtask');
  const name = 'Prepare the reopening brief';
  await form.getByLabel('Task name').fill(name);
  await form.getByLabel('What should happen (optional)').fill('Summarize the approved plan.');
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Retry create', exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(new Set(commands).size).toBe(1);
  const beforeReload = await api<ProjectState>(`/projects/${fresh.id}/state`);
  expect(beforeReload.tasks).toHaveLength(1);
  expect(beforeReload.sessions).toHaveLength(0);
  const receipt = beforeReload.tasks[0].creationReceipt!;
  await page.unroute(endpoint);
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'POST') commands.push(route.request().postDataJSON().commandId);
    await route.continue();
  });
  await page.reload();
  await rail.getByRole('button', { name: /^Board/ }).click();
  await expect(form.getByLabel('Task name')).toHaveValue(name);
  await expect(form.getByLabel('What should happen (optional)')).toHaveValue('Summarize the approved plan.');
  await form.getByRole('button', { name: 'Retry create', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(commands).toEqual([receipt.commandId, receipt.commandId, receipt.commandId]);
  const after = await api<ProjectState>(`/projects/${fresh.id}/state`);
  expect(after.tasks).toHaveLength(1);
  expect(after.tasks[0].creationReceipt).toEqual(receipt);
  expect(after.history.filter((entry) => entry.kind === 'tasks-made')).toHaveLength(1);
  expect(after.sessions).toHaveLength(0);
  expect(after.tasks[0].moves).toEqual([]);
  const row = board.locator('.column[aria-label="Ready"] .crow').filter({ hasText: name });
  await row.getByText('Creation receipt', { exact: true }).click();
  await expect(row.locator('.creation-receipt')).toContainText(receipt.commandId);
  await expect(row.locator('.creation-receipt')).toContainText(receipt.eventId);
  await expect(row.locator('.creation-receipt dd.mono').first()).toHaveCSS('text-transform', 'none');
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage)
    .filter((key) => key.startsWith('diomedes.task-create.pending.')).length)).toBe(0);
  await expect(row.locator('time')).toHaveAttribute('datetime', receipt.admittedAt);
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.evaluate(() => window.innerWidth));
  await page.screenshot({ path: testInfo.outputPath('console-task-creation-receipt.png'), fullPage: true, animations: 'disabled' });
  await page.unrouteAll({ behavior: 'wait' });
});

test('Console closes a confirmed creation even if refreshing the Board fails', async ({ page }) => {
  const fresh = await api<Project>('/projects/sample', 'POST', {});
  await api('/settings', 'PUT', { surface: 'console', openProjects: [fresh.id] });
  await page.goto(baseURL);
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  await rail.getByRole('button', { name: /^Board/ }).click();
  const board = page.locator('.board[aria-label="Board"]');
  await board.getByRole('button', { name: 'New task', exact: true }).click();
  const form = board.locator('form.newtask');
  await form.getByLabel('Task name').fill('Keep the confirmed creation');
  const stateEndpoint = `**/api/projects/${fresh.id}/state`;
  await page.route(stateEndpoint, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Synthetic refresh failure"}' }));
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Synthetic refresh failure');
  expect((await api<ProjectState>(`/projects/${fresh.id}/state`)).tasks).toHaveLength(1);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('diomedes.task-create.pending.')))).toHaveLength(0);
  await page.unroute(stateEndpoint);
  await page.reload();
  await rail.getByRole('button', { name: /^Board/ }).click();
  await expect(board.locator('.crow')).toHaveCount(1);
  await expect(form).toHaveCount(0);
});

test('Console Start again restarts a faulted task through the same admission', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const faulted = await api<Project>('/projects/sample', 'POST', {});
  const task = await api<{ id: string }>(`/projects/${faulted.id}/tasks`, 'POST', { name: 'Add NOTES.md for the plan', owner: 'you' });
  const generationsBefore = generationCount;
  await api(`/projects/${faulted.id}/work/start`, 'POST', {
    protocolVersion: 1, commandId: 'console-faulted-start', taskId: task.id, route: 'codex', sources: [], consent: true,
  });
  await expect.poll(async () => (await api<ProjectState>(`/projects/${faulted.id}/state`)).sessions[0]?.state).toBe('failed');
  expect(generationCount).toBe(generationsBefore + 1);
  await api('/settings', 'PUT', { surface: 'console', openProjects: [faulted.id] });
  await page.goto(baseURL);
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  await rail.getByRole('button', { name: /^Board/ }).click();
  const board = page.locator('.board[aria-label="Board"]');
  await expect(board).toBeVisible();
  const blocked = board.locator('.column[aria-label="Blocked"]');
  const row = blocked.locator('.crow').filter({ hasText: 'Add NOTES.md for the plan' });
  await expect(row).toContainText('Run failed');
  await expect(row.getByRole('button', { name: 'Route to', exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: 'Start again', exact: true }).click();
  const confirm = row.locator('.confirm');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Start again', exact: true }).click();
  await expect.poll(async () => (await api<ProjectState>(`/projects/${faulted.id}/state`)).sessions.length).toBe(2);
  const state = await api<ProjectState>(`/projects/${faulted.id}/state`);
  expect(state.sessions[1].receipt?.commandId).toBeTruthy();
  expect(state.sessions[1].receipt?.commandId).not.toBe(state.sessions[0].receipt?.commandId);
  expect(state.sessions[1].taskId).toBe(task.id);
  expect(state.history.filter(entry => entry.kind === 'work-admitted')).toHaveLength(2);
  expect(state.tasks).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage)
    .filter(key => key.startsWith('diomedes.work-start.pending.')).length)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('console-start-again.png'), animations: 'disabled', fullPage: true });
  expect(errors).toEqual([]);
});

for (const selectAt of ['creation', 'start'] as const) {
  test(`Console document selection at ${selectAt} proposes the exact file and retains History attribution`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const fixture = await api<Project>('/projects/sample', 'POST', {});
    const before = await fs.readFile(path.join(fixture.folder, 'Reopening plan.md'), 'utf8');
    await fs.writeFile(path.join(fixture.folder, '.hidden.md'), 'Hidden fixture');
    await fs.writeFile(path.join(fixture.folder, 'photo.png'), Buffer.from([0, 1]));
    const longPath = `notes/${'long-document-name-'.repeat(8)}brief.md`;
    await fs.mkdir(path.join(fixture.folder, 'notes'), { recursive: true });
    await fs.writeFile(path.join(fixture.folder, longPath), 'Unselected fixture');
    await api('/settings', 'PUT', { surface: 'console', openProjects: [fixture.id], services: { codex: true, defaultEngine: 'codex' } });
    if (selectAt === 'start')
      await api(`/projects/${fixture.id}/tasks`, 'POST', { name: 'Append a short validation section', owner: 'you' });
    await page.goto(baseURL);
    const rail = page.getByRole('navigation', { name: 'Threads and views' });
    await rail.getByRole('button', { name: /^Board/ }).click();
    const board = page.locator('.board[aria-label="Board"]');
    if (selectAt === 'creation') {
      await board.getByRole('button', { name: 'New task', exact: true }).click();
      const form = board.locator('form.newtask');
      await form.getByLabel('Task name').fill('Append a short validation section');
      const picker = form.getByLabel('Project document', { exact: true });
      await expect(picker).toBeEnabled();
      expect(await picker.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
        .not.toEqual(expect.arrayContaining(['.hidden.md', 'photo.png']));
      await picker.selectOption(longPath);
      await page.setViewportSize({ width: 1024, height: 768 });
      expect(await picker.evaluate(element => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('task-document-long-path.png'), animations: 'disabled', fullPage: true });
      await picker.selectOption('Reopening plan.md');
      await form.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(form).toHaveCount(0);
      const saved = await api<ProjectState>(`/projects/${fixture.id}/state`);
      expect(saved.tasks[0].sourceDocument).toBe('Reopening plan.md');
      expect(saved.sessions).toHaveLength(0);
      // The choice is durable, not a component-local draft attached to the row.
      await page.reload();
      await rail.getByRole('button', { name: /^Board/ }).click();
    }
    const row = board.locator('.column[aria-label="Ready"] .crow').filter({ hasText: 'Append a short validation section' });
    await row.getByRole('button', { name: 'Start', exact: true }).click();
    await row.locator('.confirm').getByRole('button', { name: 'Start', exact: true }).click();
    const send = page.getByRole('dialog', { name: 'Send this task?', exact: true });
    await expect(send).toBeVisible();
    const picker = send.getByLabel('Project document', { exact: true });
    if (selectAt === 'start') await picker.selectOption('Reopening plan.md');
    await expect(picker).toHaveValue('Reopening plan.md');
    await expect(send.locator('.task-sources')).toContainText('Reopening plan.md');
    await page.screenshot({ path: testInfo.outputPath(`task-document-${selectAt}.png`), animations: 'disabled', fullPage: true });
    const generationsBefore = generationCount;
    const commands: { sources: string[]; commandId: string }[] = [];
    page.on('request', request => {
      if (request.url().endsWith(`/projects/${fixture.id}/work/start`)) commands.push(request.postDataJSON());
    });
    await send.getByRole('button', { name: 'Send task', exact: true }).click();
    await expect.poll(async () => (await api<ProjectState>(`/projects/${fixture.id}/state`)).needs.length).toBe(1);
    expect(commands).toHaveLength(1);
    expect(commands[0].sources).toEqual(['Reopening plan.md']);
    expect(generationCount).toBe(generationsBefore + 1);
    expect(generatedInput?.documents).toEqual([{ path: 'Reopening plan.md', text: before }]);
    expect(await fs.readFile(path.join(fixture.folder, 'Reopening plan.md'), 'utf8')).toBe(before);
    const reviewRow = board.locator('.column[aria-label="Review"] .crow').filter({ hasText: 'Append a short validation section' });
    await reviewRow.getByRole('button', { name: 'Review', exact: true }).click();
    const notice = page.getByRole('region', { name: 'Needs your OK' });
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Show me first', exact: true }).click();
    const preview = page.getByRole('dialog', { name: /proposes to apply the proposed changes to 1 file/ });
    await expect(preview).toContainText('Reopening plan.md');
    await expect(preview).toContainText('Validation-only approved revision.');
    expect(await fs.readFile(path.join(fixture.folder, 'Reopening plan.md'), 'utf8')).toBe(before);
    await preview.getByRole('button', { name: 'Go ahead', exact: true }).click();
    await expect.poll(async () => (await api<ProjectState>(`/projects/${fixture.id}/state`)).history.filter(entry => entry.kind === 'changed').length).toBe(1);
    const completed = await api<ProjectState>(`/projects/${fixture.id}/state`);
    const entry = completed.history.find(entry => entry.kind === 'changed')!;
    expect(entry).toMatchObject({ taskId: completed.tasks[0].id, sessionId: completed.sessions[0].id,
      origin: { mode: 'direct', engine: { id: 'codex' }, model: { reported: 'Injected browser-test generator' } } });
    expect(entry.files.map(file => file.path)).toEqual(['Reopening plan.md']);
    expect(completed.needs[0].approvalReceipt?.commandId).toBeTruthy();
    expect(await fs.readFile(path.join(fixture.folder, 'Reopening plan.md'), 'utf8')).toBe(proposed);
    expect(await fs.readFile(path.join(fixture.folder, longPath), 'utf8')).toBe('Unselected fixture');
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
    expect(errors).toEqual([]);
    await api('/settings', 'PUT', { services: { defaultEngine: 'sample' } });
  });
}

test('Console document selection blocks stale paths and listing failures without admitting work', async ({ page }) => {
  const fixture = await api<Project>('/projects/sample', 'POST', {});
  const task = await api<Task>(`/projects/${fixture.id}/tasks`, 'POST', {
    name: 'Update the introduction', sourceDocument: 'Reopening plan.md', owner: 'you',
  });
  await fs.rename(path.join(fixture.folder, 'Reopening plan.md'), path.join(fixture.folder, 'Moved plan.md'));
  await api('/settings', 'PUT', { surface: 'console', openProjects: [fixture.id], services: { codex: true, defaultEngine: 'codex' } });
  await page.goto(baseURL);
  await page.getByRole('navigation', { name: 'Threads and views' }).getByRole('button', { name: /^Board/ }).click();
  const row = page.locator('.board .crow').filter({ hasText: task.name });
  await row.getByRole('button', { name: 'Start', exact: true }).click();
  await row.locator('.confirm').getByRole('button', { name: 'Start', exact: true }).click();
  const send = page.getByRole('dialog', { name: 'Send this task?', exact: true });
  await expect(send.getByRole('alert')).toContainText('no longer listed');
  await expect(send.getByRole('button', { name: 'Send task', exact: true })).toBeDisabled();
  await send.getByLabel('Project document', { exact: true }).selectOption('Moved plan.md');
  await expect(send.getByRole('button', { name: 'Send task', exact: true })).toBeEnabled();
  // Recheck visibility when sending, even if the picker was valid when opened.
  await fs.rename(path.join(fixture.folder, 'Moved plan.md'), path.join(fixture.folder, '.hidden-plan.md'));
  await send.getByRole('button', { name: 'Send task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('no longer listed');
  await expect(send).toHaveCount(0);
  expect((await api<ProjectState>(`/projects/${fixture.id}/state`)).sessions).toHaveLength(0);
  await page.route(`**/api/projects/${fixture.id}/documents`, route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Fixture document listing unavailable' } }),
  }));
  const generationsBefore = generationCount;
  await row.locator('.confirm').getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Fixture document listing unavailable');
  await expect(send).toHaveCount(0);
  expect((await api<ProjectState>(`/projects/${fixture.id}/state`)).sessions).toHaveLength(0);
  expect(generationCount).toBe(generationsBefore);
  await api('/settings', 'PUT', { services: { defaultEngine: 'sample' } });
});
