import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Change, DocumentContent, Project, ProjectState, Settings } from '../shared/types';

test.describe.configure({ mode: 'serial' });

let projectId = '';
let editedPlan = '';
let planPath = '';
let originalPlan = '';
let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
});

test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Project pages', exact: true }).getByRole('button', { name: new RegExp(`^${name}(?:\\b|$)`) }).click();
}

async function projectState(page: Page): Promise<ProjectState> {
  const response = await page.request.get(`/api/projects/${projectId}/state`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function readPlan(page: Page): Promise<DocumentContent> {
  const response = await page.request.get(`/api/projects/${projectId}/documents/read?path=${encodeURIComponent(planPath)}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function openProject(page: Page) {
  await page.goto('/');
  if (await page.getByRole('navigation', { name: 'Project pages', exact: true }).count() === 0) {
    await page.getByRole('button', { name: /Harbor Street/ }).first().click();
  }
  await expect(page.getByRole('navigation', { name: 'Project pages', exact: true })).toBeVisible();
}

test('F01-F02: first run resumes, chooses a surface, and opens the selected surface', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: 'Business', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Business', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'How do you want to work?', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'How do you want to work?', exact: true })).toBeVisible();
  for (const name of [/^I'm new to this\b/, /^I've used tools like this\b/, /^I work with these tools every day\b/])
    await expect(page.getByRole('radio', { name })).toBeVisible();
  await page.getByRole('radio', { name: /^I'm new to this\b/ }).click();
  await expect(page.getByRole('radio', { name: /^I'm new to this\b/ })).toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: /^New to this/ }).click();
  await expect(page.getByRole('radio', { name: /^New to this/ })).toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ready.' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Diomedes' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByText(/a project for a restaurant's menus, suppliers and schedules/)).toBeVisible();
  const settings: Settings = await (await page.request.get('/api/settings')).json();
  expect(settings.detail).toBe('guided');
  expect(settings.surface).toBe('book');
  expect(settings.permissions.changingFiles).toBe(true);
  expect(settings.explanations).toBe('persistent');
  expect(settings.onboarding.completedAt).toBeTruthy();

  const resume = await page.request.put('/api/settings', {
    headers: { 'X-Diomedes-Client': '1' },
    data: { onboarding: { resumeAt: 'q2', completedAt: null } },
  });
  expect(resume.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'How do you want to work?', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /^I work with these tools every day/ }).click();
  await expect(page.getByRole('radio', { name: /^I work with these tools every day/ })).toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('radio', { name: /^Very comfortable/ })).toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ready.', exact: true })).toBeVisible();
  await expect(page.getByText(/You'll use The Desk/)).toBeVisible();
  await page.getByRole('button', { name: 'Open Diomedes' }).click();
  await page.getByRole('button', { name: 'Open sample project', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'desk');
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'technical');
  await expect(page.getByRole('heading', { name: 'Harbor Street restaurants', exact: true })).toBeVisible();
  const comfortableSettings: Settings = await (await page.request.get('/api/settings')).json();
  expect(comfortableSettings.surface).toBe('desk');
  expect(comfortableSettings.detail).toBe('standard');

  await page.getByRole('button', { name: 'Interface detail menu' }).click();
  await page.getByRole('button', { name: 'The Book', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'book');
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'standard');
  await page.getByRole('button', { name: 'Interface detail menu' }).click();
  await page.getByRole('button', { name: 'Guided', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'guided');
});

test('F04, F06: sample project opens and a plan edit survives reload with History', async ({ page }, testInfo) => {
  // The first-run test leaves the settings on the Desk; this one and the rest read the Book.
  const toBook = await page.request.put('/api/settings', {
    headers: { 'X-Diomedes-Client': '1' },
    // The every-day answer also relaxed the permissions in question 3; the Book tests expect approvals.
    data: { surface: 'book', detail: 'guided', permissions: { changingFiles: true } },
  });
  expect(toBook.ok()).toBe(true);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'book');
  // The first-run test already opened the sample project; reuse it rather than creating a second one.
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const existing = page.getByRole('button', { name: /^Harbor Street restaurants/ }).first();
  if (await existing.count()) await existing.click();
  else await page.getByRole('button', { name: 'Open sample project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Harbor Street restaurants', exact: true })).toBeVisible();
  const { projects }: { projects: Project[] } = await (await page.request.get('/api/projects')).json();
  const project = projects.find(item => item.name.includes('Harbor Street'));
  expect(project).toBeTruthy();
  projectId = project!.id;
  const state = await projectState(page);
  expect(state.documents.length).toBe(3);
  await page.screenshot({ path: testInfo.outputPath('home-guided.png'), fullPage: true, animations: 'disabled' });
  await navigate(page, 'Plan');
  await page.getByRole('button', { name: 'Edit document', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Document content' });
  await expect(editor).toBeVisible();
  originalPlan = await editor.inputValue();
  editedPlan = `${originalPlan}\n\n4. Update menu prices for the patio opening.\n`;
  await editor.fill(editedPlan);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await projectState(page)).history.some(entry => entry.kind === 'edited' && entry.files.some(file => file.before && file.after && file.before !== file.after))).toBe(true);
  const edited = (await projectState(page)).history.find(entry => entry.kind === 'edited' && entry.files.length);
  planPath = edited!.files[0].path;
  await page.reload();
  await navigate(page, 'Plan');
  await page.getByRole('button', { name: 'Edit document', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document content' })).toHaveValue(editedPlan);
});

test('F10: plan steps become real tasks with provenance and a History entry', async ({ page }, testInfo) => {
  await openProject(page);
  await navigate(page, 'Plan');
  await page.getByRole('button', { name: 'Make tasks from this plan', exact: true }).click();
  const sheet = page.locator('.task-proposals');
  await expect(sheet.getByRole('heading', { name: /Diomedes found \d+ tasks in this plan/ })).toBeVisible();
  const add = sheet.getByRole('button', { name: /^Add \d+ tasks$/ });
  const label = await add.innerText();
  const count = Number(label.match(/\d+/)![0]);
  expect(count).toBeGreaterThan(0);
  await add.click();
  await expect(sheet).not.toBeVisible();
  await navigate(page, 'Tasks');
  const state = await projectState(page);
  expect(state.tasks).toHaveLength(count);
  expect(state.tasks.every(task => task.from?.plan === planPath && task.state === 'todo')).toBe(true);
  expect(state.history.some(entry => entry.kind === 'tasks-made')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('tasks-guided.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Interface detail menu' }).click();
  await page.getByRole('button', { name: 'Standard', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'standard');
  await page.screenshot({ path: testInfo.outputPath('tasks-standard.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Interface detail menu' }).click();
  await page.getByRole('button', { name: 'Guided', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'guided');
});

test('F11-F13: work asks twice, decline skips creation, and the remaining change is recorded', async ({ page }, testInfo) => {
  await openProject(page);
  await navigate(page, 'Tasks');
  await page.getByRole('button', { name: 'Do this for me', exact: true }).first().click();
  await navigate(page, 'Work');
  const notice = page.getByRole('region', { name: 'Needs your OK', exact: true });
  await expect(notice).toBeVisible();
  await expect.poll(async () => (await projectState(page)).needs.filter(need => need.state === 'open').length).toBe(1);
  await notice.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect(notice).toBeVisible();
  await expect.poll(async () => (await projectState(page)).needs.some(need => need.state === 'open' && /add/i.test(need.what))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('work-approval.png'), fullPage: true, animations: 'disabled' });
  await navigate(page, 'Home');
  await expect(notice).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Open projects' }).getByRole('button', { name: /Harbor Street/ }).locator('.mark.waiting')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Project pages' }).getByRole('button', { name: /^Tasks\b/ }).locator('.rail-count')).toHaveText('1');
  await page.screenshot({ path: testInfo.outputPath('home-guided-needs.png'), fullPage: true, animations: 'disabled' });
  await navigate(page, 'Tasks');
  const waitingCard = page.locator('.task-card.waiting');
  await expect(waitingCard).toBeVisible();
  await expect(waitingCard.getByRole('button', { name: 'Go ahead', exact: true })).toBeVisible();
  await expect(waitingCard.getByRole('button', { name: 'Go ahead for this whole task', exact: true })).toBeVisible();
  await expect(waitingCard.getByRole('button', { name: 'Show me first', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('tasks-waiting.png'), fullPage: true, animations: 'disabled' });
  await waitingCard.getByRole('button', { name: "Don't do this", exact: true }).click();
  await expect.poll(async () => (await projectState(page)).sessions[0]?.state).toBe('done');
  const state = await projectState(page);
  expect(state.needs.filter(need => need.state === 'open')).toHaveLength(0);
  expect(state.documents.some(document => document.path === 'Sample work notes.md')).toBe(false);
  expect(state.changes.filter(change => change.state === 'waiting')).toHaveLength(1);
  const workEntry = state.history.find(entry => entry.kind === 'changed' && entry.sessionId === state.sessions[0].id && entry.files.length);
  expect(workEntry?.files[0].before).toBeTruthy();
  expect(workEntry?.files[0].after).toBeTruthy();
  expect(state.history.filter(entry => entry.kind === 'decision')).toHaveLength(2);
  await expect(page.getByRole('navigation', { name: 'Open projects' }).getByRole('button', { name: /Harbor Street/ }).locator('.mark.waiting')).not.toBeVisible();
});

test('F15-F16: Review keeps the changed file and History exposes the recorded change', async ({ page }, testInfo) => {
  await openProject(page);
  await navigate(page, 'Review');
  await expect(page.getByRole('button', { name: 'Keep all', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('review-guided.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Keep all', exact: true }).click();
  await expect.poll(async () => (await projectState(page)).changes.filter(change => change.state === 'waiting').length).toBe(0);
  expect((await projectState(page)).tasks.some(task => task.state === 'done')).toBe(true);
  await navigate(page, 'History');
  await expect(page.getByRole('button', { name: 'View changes', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'View changes', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Restore this file', exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('history-changes.png'), fullPage: true, animations: 'disabled' });
});

test('F07-F08: restore and Undo recover both versions; newer edits expose conflict choices', async ({ page }, testInfo) => {
  await openProject(page);
  const state = await projectState(page);
  const workEntry = state.history.find(entry => entry.kind === 'changed');
  expect(workEntry).toBeTruthy();
  const current = await readPlan(page);
  const workChange = state.changes.find(change => change.entryId === workEntry!.id);
  expect(workChange?.before).toBeTruthy();
  await navigate(page, 'History');
  const row = page.locator('.history-entry').filter({ hasText: workEntry!.sentence });
  await row.getByRole('button', { name: 'Restore', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /^Restore 1 files\?/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Restore 1 files', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await readPlan(page)).text).toBe(workChange!.before);
  expect((await projectState(page)).history.some(entry => entry.kind === 'restore' && entry.restoreOf === workEntry!.id)).toBe(true);
  await page.locator('.feedback').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await readPlan(page)).text).toBe(current.text);

  await navigate(page, 'Documents');
  const back = page.getByRole('button', { name: 'Back to Documents', exact: true });
  if (await back.count()) await back.click();
  await page.getByRole('button', { name: new RegExp(`^${planPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click();
  await page.getByRole('button', { name: 'Edit document', exact: true }).click();
  const newer = `${current.text}\nA newer decision made by the person reviewing this plan.\n`;
  await page.getByRole('textbox', { name: 'Document content' }).fill(newer);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await readPlan(page)).text).toBe(newer);
  await navigate(page, 'History');
  await row.getByRole('button', { name: 'Restore', exact: true }).click();
  await dialog.getByRole('button', { name: 'Restore 1 files', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Restore all 1 files', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: "Restore only the files that haven't changed", exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Restore copies beside the current files', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('restore-conflict.png'), fullPage: true, animations: 'disabled' });
  await dialog.getByRole('button', { name: "Restore only the files that haven't changed", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await readPlan(page)).text).toBe(newer);
});

test('F14: Stop settles a started sample promptly and expires its approval', async ({ page }) => {
  await openProject(page);
  await navigate(page, 'Tasks');
  await page.getByRole('button', { name: 'Do this for me', exact: true }).first().click();
  await navigate(page, 'Work');
  await page.getByRole('region', { name: 'Needs your OK', exact: true }).getByRole('button', { name: 'Go ahead', exact: true }).click();
  const latest = (await projectState(page)).sessions.at(-1);
  expect(latest).toBeTruthy();
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect.poll(async () => (await projectState(page)).sessions.find(session => session.id === latest!.id)?.state, { timeout: 1000 }).toBe('stopped');
  const state = await projectState(page);
  expect(state.needs.filter(need => need.sessionId === latest!.id && need.state === 'open')).toHaveLength(0);
  expect(state.history.some(entry => entry.kind === 'stop' && entry.sessionId === latest!.id)).toBe(true);
});

test('F17, F20-F22: surface switches preserve data; visible pages meet copy and layout checks', async ({ page }, testInfo) => {
  await openProject(page);
  const before = await projectState(page);
  const banned = /\b(?:kanban|git|github|repo|repository|branch|commit|agent|agentic|worker|model|llm|context window|tokens|mcp|patch|diff|prompt|pipeline|orchestration|autonomous|copilot|AI-powered|intelligent|supercharge|unlock|next-generation|revolutionary|magic|harness)\b/gi;
  for (const detail of ['Guided', 'Standard']) {
    await page.getByRole('button', { name: 'Interface detail menu' }).click();
    await page.getByRole('button', { name: detail, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-detail', detail.toLowerCase());
    for (const name of ['Home', 'Ask', 'Plan', 'Work', 'Review', 'Tasks', 'Documents', 'History']) {
      await navigate(page, name);
      expect((await page.locator('body').innerText()).match(banned) ?? [], `Forbidden words on ${detail} ${name}`).toEqual([]);
    }
  }
  await navigate(page, 'Home');
  const intents = page.locator('.intents');
  await expect(intents).toBeVisible();
  for (const name of ['Ask a question', 'Get something done', 'Make a plan', 'Look over what changed'])
    await expect(intents.getByRole('button', { name: new RegExp(`^${name}\\b`) })).toBeVisible();
  await intents.getByRole('button', { name: /^Get something done\b/ }).click();
  // The Work page's heading is the task name once a session exists; the rail shows which page is active.
  await expect(page.getByRole('navigation', { name: 'Project pages' }).getByRole('button', { name: /^Work/ })).toHaveClass(/active/);
  const workComposer = page.getByRole('region', { name: 'Ask box', exact: true });
  await expect(workComposer).toBeVisible();
  await expect(workComposer.getByRole('button', { name: 'Work', exact: true })).toHaveClass(/active/);

  await navigate(page, 'Ask');
  const threads = page.getByRole('region', { name: 'Threads', exact: true });
  await expect(threads).toBeVisible();
  const beforeAsk = await projectState(page);
  const beforeProjectThreads = beforeAsk.conversations.filter(thread => thread.attachedTo.kind === 'project');
  const askText = 'How should I organize the restaurant menu work?';
  const askComposer = page.getByRole('region', { name: 'Ask box', exact: true });
  await askComposer.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(askComposer.getByRole('button', { name: 'Ask', exact: true })).toHaveClass(/active/);
  await askComposer.getByRole('textbox', { name: 'Ask, plan, or say what to do' }).fill(askText);
  await askComposer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => {
    const state = await projectState(page);
    return state.conversations.some(thread =>
      thread.attachedTo.kind === 'project' && thread.turns.some(turn => turn.role === 'you' && turn.text === askText),
    );
  }).toBe(true);
  const afterAsk = await projectState(page);
  const afterProjectThreads = afterAsk.conversations.filter(thread => thread.attachedTo.kind === 'project');
  expect(
    afterProjectThreads.length > beforeProjectThreads.length ||
      afterProjectThreads.some(thread => {
        const beforeThread = beforeProjectThreads.find(candidate => candidate.id === thread.id);
        return beforeThread !== undefined && thread.turns.length > beforeThread.turns.length;
      }),
  ).toBe(true);
  await expect(threads.locator('.desk-thread')).toHaveCount(afterProjectThreads.length);

  let reloads = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) reloads += 1; });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: /^The Desk\b/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'desk');
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'technical');
  await page.getByRole('navigation', { name: 'Open projects' }).getByRole('button', { name: /Harbor Street/ }).click();
  await expect(page.locator('.desk')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Threads', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desk.png'), fullPage: true, animations: 'disabled' });
  await page.screenshot({ path: testInfo.outputPath('work-technical.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: /^The Book\b/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'book');
  await expect(page.getByRole('radio', { name: /^Standard\b/ })).toBeChecked();
  await page.getByRole('radio', { name: /^Guided\b/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'guided');
  await page.getByRole('navigation', { name: 'Open projects' }).getByRole('button', { name: /Harbor Street/ }).click();
  const after = await projectState(page);
  expect(after.tasks).toEqual(before.tasks);
  expect(after.changes).toEqual(before.changes);
  expect(after.history).toEqual(before.history);
  expect(reloads).toBe(0);
  await navigate(page, 'Home');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const violations = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body *')].flatMap(element => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || box.width === 0 || box.height === 0) return [];
    const result: string[] = [];
    if ([...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) && parseFloat(style.fontSize) < 14) result.push(`Small text: ${element.tagName} ${style.fontSize} ${element.innerText.slice(0, 60)}`);
    if (element.tagName === 'BUTTON' && box.height < 35.5) result.push(`Short button: ${element.innerText} ${box.height}`);
    if (style.animationName !== 'none' && style.animationDuration.split(',').some(value => parseFloat(value) > 0)) result.push(`Animation active: ${element.className}`);
    if (style.transitionDuration.split(',').some(value => parseFloat(value) > 0)) result.push(`Transition active: ${element.className}`);
    return result;
  }));
  expect(violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['Home', 'Tasks', 'History']) {
    await navigate(page, name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} should fit a narrow screen`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${name.toLowerCase()}-mobile.png`), fullPage: true, animations: 'disabled' });
  }
});

test('Draft recovery: Settings, reload and same-named files in separate projects preserve writing and stale-save conflicts', async ({ page }, testInfo) => {
  const headers = { 'X-Diomedes-Client': '1' };
  const file = 'Recovery plan.md';
  const originalA = '# Recovery plan\n\nOriginal writing for project A.\n';
  const originalB = '# Recovery plan\n\nDifferent original writing for project B.\n';
  async function seed(name: string, text: string): Promise<Project> {
    const created = await page.request.post('/api/projects', { headers, data: { name } });
    expect(created.ok()).toBe(true);
    const result: Project = await created.json();
    const relative = path.relative(path.resolve('test-results'), result.folder);
    expect(path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`), 'Draft fixtures must stay inside the isolated test output').toBe(false);
    const document = await page.request.post(`/api/projects/${result.id}/documents/create`, { headers, data: { path: file, text, kind: 'plan' } });
    expect(document.ok()).toBe(true);
    const baseline = await page.request.post(`/api/projects/${result.id}/history/label`, { headers, data: { label: 'Initial draft test version' } });
    expect(baseline.ok()).toBe(true);
    return result;
  }
  const first = await seed('Draft recovery A', originalA);
  const second = await seed('Draft recovery B', originalB);
  const setup = await page.request.put('/api/settings', { headers, data: {
    detail: 'guided',
    services: { codex: false },
    onboarding: { work: 'business', detail: 'guided', familiarity: 'new', resumeAt: 'done', completedAt: new Date().toISOString() },
    openProjects: [second.id, first.id],
    lastPage: { [first.id]: 'plan', [second.id]: 'plan' },
  } });
  expect(setup.ok()).toBe(true);
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Document content' });
  const tabs = page.getByRole('navigation', { name: 'Open projects' });
  const draftA = `${originalA}\nUnsaved writing that belongs only to project A.\n`;
  const draftB = `${originalB}\nA separate unsaved draft that belongs only to project B.\n`;
  await page.getByRole('button', { name: 'Edit document', exact: true }).click();
  await editor.fill(draftA);
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: /^The Desk\b/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'desk');
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'technical');
  await tabs.getByRole('button', { name: first.name, exact: true }).click();
  await expect(page.locator('.desk')).toBeVisible();
  await page.getByRole('button', { name: 'Interface detail menu' }).click();
  await page.getByRole('button', { name: 'The Book', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'book');
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'guided');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(draftA);
  await expect(page.getByText('Recovered your unsaved writing.', { exact: true })).toBeVisible();

  await tabs.getByRole('button', { name: second.name, exact: true }).click();
  await navigate(page, 'Plan');
  await page.getByRole('button', { name: 'Edit document', exact: true }).click();
  await expect(editor).toHaveValue(originalB);
  await editor.fill(draftB);
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await tabs.getByRole('button', { name: first.name, exact: true }).click();
  await expect(editor).toHaveValue(draftA);
  page.once('dialog', dialog => void dialog.accept());
  await page.reload();
  await expect(editor).toHaveValue(draftA);
  await page.screenshot({ path: testInfo.outputPath('recovered-draft.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(first.folder, file), 'utf8')).toBe(draftA);
  const savedState: ProjectState = await (await page.request.get(`/api/projects/${first.id}/state`)).json();
  const savedEntry = savedState.history.find(entry => entry.kind === 'edited' && entry.files.some(record => record.before && record.after && record.before !== record.after));
  expect(savedEntry).toBeTruthy();
  const { files }: { files: Change[] } = await (await page.request.get(`/api/projects/${first.id}/history/${savedEntry!.id}/changes`)).json();
  expect(files[0].before).toBe(originalA);
  expect(files[0].after).toBe(draftA);

  await tabs.getByRole('button', { name: second.name, exact: true }).click();
  await expect(editor).toHaveValue(draftB);
  expect(await fs.readFile(path.join(second.folder, file), 'utf8')).toBe(originalB);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(second.folder, file), 'utf8')).toBe(draftB);
  await tabs.getByRole('button', { name: first.name, exact: true }).click();
  await navigate(page, 'Plan');
  await page.getByRole('button', { name: 'Edit document', exact: true }).click();
  const staleDraft = `${draftA}\nA browser draft based on the earlier saved version.\n`;
  const external = `${draftA}\nA newer edit made outside the browser.\n`;
  await editor.fill(staleDraft);
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await fs.writeFile(path.join(first.folder, file), external, 'utf8');
  page.once('dialog', dialog => void dialog.accept());
  await page.reload();
  await expect(editor).toHaveValue(staleDraft);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const conflict = page.getByRole('dialog', { name: 'Newer changes are in the way', exact: true });
  await expect(conflict).toBeVisible();
  expect(await fs.readFile(path.join(first.folder, file), 'utf8')).toBe(external);
  await expect(editor).toHaveValue(staleDraft);
  await page.screenshot({ path: testInfo.outputPath('recovered-draft-conflict.png'), fullPage: true, animations: 'disabled' });
  await conflict.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(editor).toHaveValue(staleDraft);
});
