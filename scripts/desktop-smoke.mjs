import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('test-results', `desktop-${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const executablePath = path.resolve('release/Diomedes-win32-x64/Diomedes.exe');
const env = {
  ...process.env,
  DIOMEDES_DESKTOP_PROFILE: path.join(root, 'profile'),
  DIOMEDES_DATA_DIR: path.join(root, 'data'),
  DIOMEDES_PROJECTS_DIR: path.join(root, 'projects'),
};
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
let desktop;
let url;
async function api(route, method = 'GET', data) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
try {
  desktop = await electron.launch({ executablePath, env });
  const page = await desktop.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  url = new URL(page.url()).origin;
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  const project = await api('/projects/sample', 'POST', {});
  const { found } = await api(`/projects/${project.id}/plans/find-tasks`, 'POST', {
    path: 'Reopening plan.md',
  });
  await api(`/projects/${project.id}/plans/add-tasks`, 'POST', {
    path: 'Reopening plan.md',
    items: found,
  });
  await api('/settings', 'PUT', {
    detail: 'standard',
    onboarding: {
      work: 'business',
      detail: 'standard',
      familiarity: 'some',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
    openProjects: [project.id],
    lastPage: { [project.id]: 'tasks' },
  });
  await page.reload();
  await expect(page.locator('.task-card')).toHaveCount(found.length);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  const sizes = () =>
    page.evaluate(() =>
      Object.fromEntries(
        ['body', '.task-title', '.task-card .button', '.caption'].map((selector) => [
          selector,
          parseFloat(getComputedStyle(document.querySelector(selector)).fontSize),
        ]),
      ),
    );
  const before = await sizes();
  expect(before.body).toBe(16);
  expect(before['.task-title']).toBe(18);
  await page.screenshot({
    path: path.resolve('evidence/screenshots/desktop-tasks.png'),
    animations: 'disabled',
  });
  const settings = await api('/settings');
  await api('/settings', 'PUT', { appearance: { ...settings.appearance, interfaceScale: 1.24 } });
  await page.reload();
  await expect(page.locator('.task-card')).toHaveCount(found.length);
  const after = await sizes();
  for (const key of Object.keys(before)) expect(after[key] / before[key]).toBeCloseTo(1.24, 2);
  await page.screenshot({
    path: path.resolve('evidence/screenshots/desktop-tasks-large.png'),
    animations: 'disabled',
  });
  const startup = JSON.parse(
    await fs.readFile(path.join(root, 'data/desktop-startup.json'), 'utf8'),
  );
  expect(startup.packaged).toBe(true);
  expect(errors).toEqual([]);
  await desktop.close();
  desktop = undefined;
  await expect
    .poll(async () => {
      try {
        await fs.access(path.join(root, 'data/service.lock'));
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    })
    .toBe(false);
  await expect
    .poll(async () => {
      try {
        await fetch(`${url}/api/settings`);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  desktop = await electron.launch({ executablePath, env });
  const reopened = await desktop.firstWindow();
  await expect(reopened.locator('.task-card')).toHaveCount(found.length);
  await fs.writeFile(
    'evidence/desktop-proof.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        executablePath,
        startup,
        taskCount: found.length,
        fontSizes: { before, after },
        rendererNodeDisabled: true,
        serviceStopsOnClose: true,
        dataLockReleased: true,
        persistedOnRestart: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: packaged desktop, task board, font scaling, renderer isolation, shutdown, and restart persistence.',
  );
} finally {
  if (desktop) await desktop.close();
}
