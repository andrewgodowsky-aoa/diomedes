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
  const sizes = () =>
    page.evaluate(() =>
      Object.fromEntries(
        // Under the root zoom the body stays viewport-bound and fluid text wraps
        // differently, so measure short, fixed-width things that only scale.
        ['.rail-link', '.task-card .button', '.task-card .caption.owner'].map((selector) => [
          selector,
          document.querySelector(selector).getBoundingClientRect().height,
        ]),
      ),
    );
  const fonts = () =>
    page.evaluate(() =>
      Object.fromEntries(
        ['body', '.task-title'].map((selector) => [
          selector,
          parseFloat(getComputedStyle(document.querySelector(selector)).fontSize),
        ]),
      ),
    );
  const beforeFonts = await fonts();
  expect(beforeFonts.body).toBe(15);
  expect(beforeFonts['.task-title']).toBe(17);
  const before = await sizes();
  await page.screenshot({
    path: path.resolve('evidence/screenshots/desktop-tasks.png'),
    animations: 'disabled',
  });
  const settings = await api('/settings');
  await api('/settings', 'PUT', {
    ...settings,
    appearance: { ...settings.appearance, interfaceScale: 1.24 },
  });
  await page.reload();
  await expect(page.locator('.task-card')).toHaveCount(found.length);
  const after = await sizes();
  for (const key of Object.keys(before))
    expect(
      after[key] / before[key],
      `${key} measured ${before[key]} at scale 1 and ${after[key]} at scale 1.24`,
    ).toBeCloseTo(1.24, 2);
  await page.screenshot({
    path: path.resolve('evidence/screenshots/desktop-tasks-large.png'),
    animations: 'disabled',
  });

  const deskSettings = await api('/settings');
  await api('/settings', 'PUT', { ...deskSettings, surface: 'desk' });
  await page.reload();
  await expect(page.locator('html[data-surface="desk"]')).toHaveCount(1);
  await expect(page.locator('.desk')).toBeVisible();
  await expect(page.locator('.desk-team')).toBeVisible();

  const thread = await api(`/projects/${project.id}/threads`, 'POST', {
    name: 'Desktop smoke thread',
  });
  await page.reload();
  await expect(page.locator('.desk-pane').filter({ hasText: thread.name })).toBeVisible();

  const helperResult = await api(`/projects/${project.id}/team/members`, 'POST', {
    name: 'Helper',
    role: 'member',
    engine: 'sample',
  });
  await page.reload();
  await expect(page.locator('.desk-member').filter({ hasText: 'Helper' })).toBeVisible();
  const helperPane = page.locator('.desk-pane').filter({ hasText: 'Helper' });
  await expect(helperPane).toBeVisible();
  const teamMessage = 'Desktop smoke team message';
  await api(`/projects/${project.id}/team/messages`, 'POST', {
    to: helperResult.member.slotId,
    content: teamMessage,
  });
  await page.reload();
  await expect(helperPane.locator('.turn.team').filter({ hasText: teamMessage })).toBeVisible();

  const bookSettings = await api('/settings');
  await api('/settings', 'PUT', {
    ...bookSettings,
    surface: 'book',
    lastPage: { ...bookSettings.lastPage, [project.id]: 'home' },
  });
  await page.reload();
  await expect(page.locator('html[data-surface="book"]')).toHaveCount(1);
  await expect(page.locator('.intents')).toBeVisible();

  // Keep the original restart check on the task page after proving the Book home surface.
  const restartSettings = await api('/settings');
  await api('/settings', 'PUT', {
    ...restartSettings,
    lastPage: { ...restartSettings.lastPage, [project.id]: 'tasks' },
  });
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
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
    'PASS: packaged desktop, task board, font scaling, Book and Desk surfaces, team threads and messages, renderer isolation, shutdown, and restart persistence.',
  );
} catch (error) {
  const message = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error);
  console.error(`FAIL: ${message.endsWith('.') ? message : `${message}.`}`);
  process.exitCode = 1;
} finally {
  if (desktop) await desktop.close();
}
