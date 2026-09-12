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
const admissionProof = [];
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
  page.setDefaultTimeout(15_000);
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
  // New profiles default to the Console surface; this lifecycle smoke keeps
  // exercising the still-supported Workbook task path, so it opts in explicitly.
  await api('/settings', 'PUT', {
    surface: 'workbook',
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
  // The body sits at the shared 16px body role before user scaling; a task
  // title stays at the 13px caption role and is carried by weight, not size
  // (client/styles.css .task-title), which is what the readability patch kept.
  expect(beforeFonts.body).toBe(16);
  expect(beforeFonts['.task-title']).toBe(13);
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

  async function startWithLostResponse(surface, click) {
    const before = await api(`/projects/${project.id}/state`);
    const original = await fs.readFile(path.join(project.folder, 'Reopening plan.md'));
    const commands = [];
    let admitted;
    const endpoint = `**/api/projects/${project.id}/work/start`;
    await page.route(endpoint, async route => {
      commands.push(route.request().postDataJSON().commandId);
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (commands.length === 1) {
        admitted = await response.json();
        await route.abort('connectionreset');
      } else {
        await route.fulfill({ response });
      }
    });
    await click();
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[0]).toBeTruthy();
    expect(commands[1]).toBe(commands[0]);
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage)
      .filter(key => key.startsWith('diomedes.work-start.pending.')).length)).toBe(0);
    const state = await api(`/projects/${project.id}/state`);
    expect(state.sessions).toHaveLength(before.sessions.length + 1);
    const saved = state.sessions.find(session => session.receipt?.commandId === commands[0]);
    expect(saved.receipt).toEqual(admitted.receipt);
    expect(await fs.readFile(path.join(project.folder, 'Reopening plan.md'))).toEqual(original);
    admissionProof.push({ surface, requests: commands.length, receipt: saved.receipt });
    await page.unroute(endpoint);
    await api(`/projects/${project.id}/work/${saved.id}/stop`, 'POST', {});
  }
  await page.locator('.task-card').first().locator('.task-title').click();
  await startWithLostResponse('workbook', () => page.getByRole('dialog')
    .getByRole('button', { name: 'Do this for me', exact: true }).click());

  const deskSettings = await api('/settings');
  await api('/settings', 'PUT', { ...deskSettings, surface: 'console' });
  await page.reload();
  await expect(page.locator('html[data-surface="console"]')).toHaveCount(1);
  await expect(page.locator('.console')).toBeVisible();
  // The Console is client/console/ now: a rail with the three views, a board of
  // rows with one verb each, and lanes instead of panes.
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  await expect(rail).toBeVisible();
  await rail.getByRole('button', { name: /^Board/ }).click();
  const board = page.locator('.board[aria-label="Board"]');
  await expect(board).toBeVisible();
  await startWithLostResponse('console', async () => {
    // Under "Show me first" the row's Start opens an inline confirm, and the
    // confirm's own Start is the one that sends the Work command.
    const row = board.locator('.crow').first();
    await row.getByRole('button', { name: 'Start', exact: true }).first().click();
    await row.locator('.confirm').getByRole('button', { name: 'Start', exact: true }).click();
  });

  const thread = await api(`/projects/${project.id}/threads`, 'POST', {
    name: 'Desktop smoke thread',
  });
  await page.reload();
  await rail.getByRole('button', { name: new RegExp(thread.name) }).click();
  await expect(page.locator('#scrThread')).toBeVisible();
  await expect(page.locator('#scrThread .head h1')).toContainText(thread.name);

  const helperResult = await api(`/projects/${project.id}/team/members`, 'POST', {
    name: 'Helper',
    role: 'member',
    engine: 'sample',
  });
  await page.reload();
  await rail.getByRole('button', { name: /^Team/ }).click();
  const helperLane = page.locator('.team[aria-label="Team"] .lane').filter({ hasText: 'Helper' });
  await expect(helperLane).toBeVisible();
  const teamMessage = 'Desktop smoke team message';
  await api(`/projects/${project.id}/team/messages`, 'POST', {
    to: helperResult.member.slotId,
    content: teamMessage,
  });
  await page.reload();
  await rail.getByRole('button', { name: /^Team/ }).click();
  await expect(helperLane.locator('.msg')).toContainText(teamMessage);

  const bookSettings = await api('/settings');
  await api('/settings', 'PUT', {
    ...bookSettings,
    surface: 'workbook',
    lastPage: { ...bookSettings.lastPage, [project.id]: 'home' },
  });
  await page.reload();
  await expect(page.locator('html[data-surface="workbook"]')).toHaveCount(1);
  await expect(page.locator('.intents')).toBeVisible();

  // Keep the original restart check on the task page after proving the Workbook home surface.
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
  url = new URL(reopened.url()).origin;
  for (const proof of admissionProof) {
    const saved = await api(`/projects/${project.id}/work/commands/${proof.receipt.commandId}`);
    expect(saved.receipt).toEqual(proof.receipt);
    expect(saved.state).toBe('stopped');
  }
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
        workAdmission: { lostResponsesRecovered: true, receiptsRetainedOnRestart: true, runs: admissionProof },
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: packaged desktop, task board, font scaling, Workbook and Console lost-response recovery, team threads and messages, renderer isolation, shutdown, and receipt persistence after restart.',
  );
} catch (error) {
  const message = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error);
  console.error(`FAIL: ${message.endsWith('.') ? message : `${message}.`}`);
  process.exitCode = 1;
} finally {
  if (desktop) await desktop.close();
}
