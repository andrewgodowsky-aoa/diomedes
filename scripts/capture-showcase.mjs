import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('output/showcase');
await fs.mkdir(path.join(output, 'screenshots'), { recursive: true });
const fixture = await fs.mkdtemp(path.resolve('test-results/showcase-'));
const env = { ...process.env, DIOMEDES_DESKTOP_PROFILE: path.join(fixture, 'profile'),
  DIOMEDES_DATA_DIR: path.join(fixture, 'data'), DIOMEDES_PROJECTS_DIR: path.join(fixture, 'projects') };
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ executablePath: path.resolve('release/Diomedes-win32-x64/Diomedes.exe'), env });
const captures = [];
try {
  const page = await desktop.firstWindow();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1680, 1000));
  await page.waitForURL('http://127.0.0.1:*/');
  const origin = new URL(page.url()).origin;
  const api = async (route, method = 'GET', value) => {
    const response = await fetch(`${origin}/api${route}`, { method,
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1', 'Connection': 'close' },
      body: value === undefined ? undefined : JSON.stringify(value) });
    if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const project = await api('/projects/sample', 'POST', {});
  const base = `/projects/${project.id}`;
  await api('/settings', 'PUT', {
    detail: 'standard', appearance: { package: 'deep-field', motion: 'reduced', interfaceScale: 1.12 },
    onboarding: { work: 'business', detail: 'standard', familiarity: 'some', resumeAt: 'done', completedAt: new Date().toISOString() },
    openProjects: [project.id], lastPage: { [project.id]: 'home' },
  });
  await page.reload();
  const nav = async (name) => {
    await page.getByRole('navigation', { name: 'Project pages', exact: true })
      .getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
    if (await page.getByRole('button', { name: 'Dismiss', exact: true }).count())
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  };
  const capture = async (id, title, caption, detail) => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(output, 'screenshots', `${id}.png`), animations: 'disabled' });
    captures.push({ id, title, caption, detail });
    console.log(`Captured ${title}`);
  };
  await nav('Plan');
  await expect(page.getByRole('button', { name: 'Make tasks from this plan', exact: true })).toBeVisible();
  await capture('02-plan', 'A plan you can read and shape.',
    'A focused document view keeps the plan readable, with editing and task creation close at hand.',
    'Real serif weights restore emphasis; reading size can be adjusted independently of the interface.');
  const { found } = await api(`${base}/plans/find-tasks`, 'POST', { path: 'Reopening plan.md' });
  const { tasks } = await api(`${base}/plans/add-tasks`, 'POST', { path: 'Reopening plan.md', items: found });
  await api(`${base}/tasks/${tasks[1].id}`, 'PUT', { owner: 'you', state: 'working' });
  await api(`${base}/tasks/${tasks[2].id}`, 'PUT', { owner: 'you', state: 'done' });
  await api(`${base}/history/label`, 'POST', { label: 'Reopening plan agreed' });
  await api(`${base}/work/start`, 'POST', { taskId: tasks[0].id, route: 'sample' });
  await page.reload();
  await nav('Work');
  await expect(page.getByRole('region', { name: 'Needs your OK', exact: true })).toBeVisible();
  await capture('04-work', 'A clear moment to decide.',
    'The work view puts the requested action, its reason, and your approval controls in one place.',
    'This capture shows the built-in sample workflow. It does not represent a live AI-generated result.');
  await nav('Tasks');
  await expect(page.locator('.task-card')).toHaveCount(4);
  await capture('03-tasks', 'The state of work, at a glance.',
    'To do, Working, Waiting for you, and Done make progress visible without opening each task.',
    'Larger titles, brighter captions, and consistently scaled buttons make the board easier to scan.');
  await nav('Home');
  await capture('01-home', 'One place to pick up the project.',
    'Project Home brings attention requests, recent activity, and plans into a shared starting point.',
    'The same clearer type hierarchy carries across navigation, headings, and supporting information.');
  let state = await api(`${base}/state`);
  await api(`${base}/needs/${state.needs.find(n => n.state === 'open').id}/resolve`, 'POST', { resolution: 'go-ahead', allowForTask: true });
  await expect.poll(async () => (await api(`${base}/state`)).sessions[0].state, { timeout: 15000 }).toBe('done');
  await nav('Review');
  await expect(page.getByRole('button', { name: 'Keep all', exact: true })).toBeVisible();
  await capture('05-review', 'Look over the changes.',
    'Review groups the changed files with Keep and Undo controls, so the next decision is easy to find.',
    'The displayed changes were produced by the app\'s sample workflow and recorded in its local history.');
  await api(`${base}/review/all`, 'POST', { action: 'keep' });
  await api(`${base}/history/label`, 'POST', { label: 'Reopening checklist reviewed' });
  await nav('History');
  await expect(page.getByRole('button', { name: 'View changes', exact: true }).first()).toBeVisible();
  await capture('06-history', 'A record you can return to.',
    'Named versions, recorded changes, and restore controls make the project\'s history easy to revisit.',
    'More legible timestamps and controls support the same readable experience as the task board.');
  captures.sort((a,b) => a.id.localeCompare(b.id));
  await fs.writeFile(path.join(output, 'captions.json'), JSON.stringify(captures, null, 2));
} finally { await desktop.close(); }


