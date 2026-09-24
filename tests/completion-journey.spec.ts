import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Change, ProjectState, Settings } from '../shared/types';

/**
 * The completion journey: a person installs Diomedes on an empty data folder, finishes the first
 * run, makes a project, runs a task on the sample route to a verified result, reviews the change it
 * made, and then the local service is stopped and started again. Everything they did must still
 * be there: the project, the task's verified result, the reviewed change and its History entry,
 * and the approved bytes in the project folder.
 *
 * The spec owns its service. It runs `server/index.ts --production` (the built `dist/` served by
 * the service itself) on a free port with a fresh data folder under `test-results/`, so a restart
 * is a real process exit and a real cold start on the same data folder. The sample route needs no
 * engine, credential or provider; `CODEX_HOME` points at an empty folder of this run's own.
 *
 * Driven through the Console, with one exception said where it happens: the Console has no Keep
 * control for a waiting change (`reviewChange` in `client/console/Shell.tsx` is not wired to any
 * control), so the Keep is the route the Workbook's Review page called, as `tests/ui.spec.ts` F15
 * does.
 */

test.describe.configure({ mode: 'serial' });

const ROOT = path.resolve('.');
const HEADERS = { 'X-Diomedes-Client': '1' };
const PROJECT_NAME = 'Corner bakery reopening';
const TASK_NAME = 'Write the reopening notes';
const NOTES = 'Sample work notes.md';

let runRoot = '';
let dataDir = '';
let projectsDir = '';
let port = 0;
let baseURL = '';
let service: { child: ChildProcess; log: WriteStream; logPath: string } | null = null;
let starts = 0;
let pageErrors: string[] = [];
/** The run folder is kept for inspection unless every test here passed. */
let failed = false;

/** A port the kernel just handed out, never one of the shared suite's. */
async function freePort(): Promise<number> {
  for (;;) {
    const found = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const value = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => resolve(value));
      });
    });
    if (found >= 1024 && found !== 5174 && found !== 47632) return found;
  }
}

async function portIsFree(value: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(value, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** Only this run's own settings reach the service; nothing is inherited from the shell's DIOMEDES_*. */
function serviceEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith('DIOMEDES_')) env[key] = value;
  return {
    ...env,
    DIOMEDES_PORT: String(port),
    // The service serves the client itself, so the page's origin is the service's own port.
    DIOMEDES_CLIENT_PORT: String(port),
    DIOMEDES_DATA_DIR: dataDir,
    DIOMEDES_PROJECTS_DIR: projectsDir,
    DIOMEDES_TEST_MODE: '1',
    DIOMEDES_ALLOW_UNPROTECTED_BROWSER: '1',
    CODEX_HOME: path.join(runRoot, 'codex'),
  };
}

async function startService(): Promise<void> {
  expect(service, 'A service is already running').toBeNull();
  starts += 1;
  const logPath = path.join(runRoot, `service-${starts}.log`);
  const log = createWriteStream(logPath);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(ROOT, 'server', 'index.ts'), '--production'],
    {
      cwd: ROOT,
      env: serviceEnv(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  service = { child, log, logPath };
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const output = await fs.readFile(logPath, 'utf8').catch(() => '');
      service = null;
      throw new Error(
        `The service exited during start (${child.exitCode ?? child.signalCode}):\n${output}`,
      );
    }
    try {
      const response = await fetch(`${baseURL}/api/settings`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      const output = await fs.readFile(logPath, 'utf8').catch(() => '');
      throw new Error(`The service did not answer /api/settings within 45 s:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** SIGTERM, then wait for the process to leave on its own; a forced kill is a failure. */
async function stopService(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const running = service;
  expect(running, 'No service is running').not.toBeNull();
  const { child, log } = running!;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null)
      resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.kill('SIGTERM');
  const result = await Promise.race([
    exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
  ]);
  if (result === null) {
    child.kill('SIGKILL');
    await exited;
    service = null;
    log.end();
    throw new Error('The service did not exit within 15 s of SIGTERM.');
  }
  service = null;
  await new Promise<void>((resolve) => log.end(resolve));
  return result;
}

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(
      `Journey request ${method} ${route} failed (${response.status}): ${await response.text()}`,
    );
  return response.json() as Promise<T>;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  runRoot = await fs.mkdtemp(path.join(results, 'completion-journey-'));
  dataDir = path.join(runRoot, 'data');
  projectsDir = path.join(runRoot, 'projects');
  await fs.mkdir(path.join(runRoot, 'codex'), { recursive: true });
  // The service serves whatever was last built. A stale bundle would pass against old code.
  const built = (await fs.stat(path.resolve('dist', 'index.html'))).mtimeMs;
  for (const dir of ['client', 'shared'])
    for (const entry of await fs.readdir(path.resolve(dir), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      expect(built, `dist is older than ${file}; run "npx vite build" first.`).toBeGreaterThan(
        (await fs.stat(path.resolve(file))).mtimeMs,
      );
    }
  port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  // Whatever happened above, no child outlives the run.
  const running = service;
  if (!running) return;
  service = null;
  const { child, log } = running;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const done = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    if (!done) {
      child.kill('SIGKILL');
      await exited;
    }
  }
  log.end();
});

test.afterAll(async () => {
  if (!failed && runRoot) await fs.rm(runRoot, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});

test.afterEach(({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus || pageErrors.length > 0) failed = true;
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

const railOf = (page: Page) =>
  page.getByRole('navigation', { name: 'Threads and views', exact: true });
const boardOf = (page: Page) => page.locator('.board[aria-label="Board"]');
const columnOf = (page: Page, name: 'Ready' | 'Working' | 'Review' | 'Done') =>
  boardOf(page).locator(`.column[aria-label="${name}"]`);

async function showProjects(page: Page) {
  const heading = page.getByRole('heading', { name: 'Projects', exact: true });
  const toProjects = page.getByRole('button', { name: 'Projects', exact: true }).first();
  await expect(heading.or(toProjects).first()).toBeVisible();
  if ((await heading.count()) === 0) await toProjects.click();
  await expect(heading).toBeVisible();
}

async function openBoard(page: Page) {
  await railOf(page)
    .getByRole('button', { name: /^Board\b/ })
    .click();
  await expect(boardOf(page)).toBeVisible();
}

async function openTaskThread(page: Page) {
  await railOf(page)
    .getByRole('button', { name: new RegExp(TASK_NAME) })
    .click();
  await expect(page.locator('#scrThread')).toBeVisible();
}

async function projectState(): Promise<ProjectState> {
  const { projects } = await api<{ projects: { id: string; name: string }[] }>('/projects');
  const project = projects.find((item) => item.name === PROJECT_NAME);
  expect(project, `${PROJECT_NAME} must be listed`).toBeTruthy();
  return api<ProjectState>(`/projects/${project!.id}/state`);
}

/**
 * The run's record in the task thread, unfolded, and its verification panel. A record that was
 * live when the thread opened stays unfolded; one that was already finished shows folded, with
 * its result word beside "show run".
 */
async function openRunPanel(page: Page, session: string) {
  const record = page
    .locator('.record')
    .filter({ has: page.locator('[data-verification]') })
    .first();
  await expect(record).toBeVisible();
  const panel = page.locator(`[data-verification-panel="${session}"]`);
  const show = record.getByRole('button', { name: 'show run', exact: true });
  if (await show.isVisible()) await show.click();
  await expect(panel).toBeVisible();
  return panel;
}

/** What the change review shows for the notes file: its row, its added text and its History reference. */
async function expectReviewedNotes(page: Page, approved: string) {
  const review = page.locator('.crev');
  await expect(review).toBeVisible();
  await expect(review.getByRole('heading', { name: 'What changed' })).toBeVisible();
  await expect(review.getByText('Deterministic · no AI model wrote this')).toBeVisible();
  await expect(review.locator('.crev-sentences li').first()).toContainText(/1 file changed/);
  const row = review.locator('.crev-row', { hasText: NOTES });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.crev-kind')).toHaveText(/add/i);
  const toggle = row.locator('.crev-path');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(row.locator('.crev-evidence')).toBeVisible();
  const patch = row.locator('.crev-patch');
  await expect(patch).toContainText('# Sample work notes');
  // The exact approved first lines are what the review displays.
  await expect(patch).toContainText(approved.split('\n')[2]);
  await expect(row.locator('.crev-refs')).toContainText('history-entry');
}

test('Completion journey: fresh install to a reviewed, verified change that survives a service restart', async ({
  page,
}, testInfo) => {
  let approved = '';
  let changeId = '';
  let historyEntryId = '';
  let sessionId = '';
  let projectFolder = '';

  await test.step('A fresh install: the data folder is empty and the service starts on it', async () => {
    await expect(fs.readdir(dataDir)).rejects.toThrow();
    await startService();
    const settings = await api<Settings>('/settings');
    expect(settings.onboarding.completedAt).toBeFalsy();
    const { projects } = await api<{ projects: unknown[] }>('/projects');
    expect(projects).toHaveLength(0);
  });

  await test.step('The first run is finished the way a new person would finish it', async () => {
    await page.goto(baseURL);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('radio', { name: 'Business', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Business', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'How much detail do you want?', exact: true }),
    ).toBeVisible();
    await page.getByRole('radio', { name: /^Guided/ }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByRole('checkbox', { name: 'Ask before changing files in a project' }),
    ).toBeChecked();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Connect an AI service', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Skip AI setup' }).click();
    await expect(page.getByRole('heading', { name: 'Your workspace is ready' })).toBeVisible();
    await page.getByRole('button', { name: 'Open Nectovia' }).click();
    await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
    const settings = await api<Settings>('/settings');
    expect(settings.onboarding.completedAt).toBeTruthy();
    expect(settings.permissions.changingFiles).toBe(true);
  });

  await test.step('A project is made from the Projects page', async () => {
    await showProjects(page);
    const start = page.getByRole('region', { name: 'Start here' });
    await expect(start.getByRole('heading', { name: 'Start with a project' })).toBeVisible();
    await start.getByRole('button', { name: /^New project/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Name' }).fill(PROJECT_NAME);
    await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
    await expect(
      page.getByRole('navigation', { name: 'Open projects', exact: true }).locator('b'),
    ).toHaveText(PROJECT_NAME);
    projectFolder = (await projectState()).project.folder;
    expect(path.resolve(projectFolder).startsWith(path.resolve(projectsDir))).toBe(true);
  });

  await test.step('A task is made on the Board and started on the sample route', async () => {
    // A new person starts in the Conversation view; the Board is part of the full Console.
    await page.getByRole('button', { name: 'Interface detail menu' }).click();
    await page.getByRole('menuitemradio', { name: 'Architect', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-view', 'architect');
    await openBoard(page);
    await boardOf(page).getByRole('button', { name: 'New task', exact: true }).click();
    const form = boardOf(page).locator('form.newtask');
    await form.getByLabel('Task name').fill(TASK_NAME);
    await form.getByRole('button', { name: 'Create', exact: true }).click();
    const row = columnOf(page, 'Ready').locator('.crow', { hasText: TASK_NAME });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Start', exact: true }).click();
    const confirm = row.locator('.confirm');
    if (await confirm.isVisible())
      await confirm.getByRole('button', { name: 'Start', exact: true }).click();
    await expect.poll(async () => (await projectState()).sessions.length).toBe(1);
    const state = await projectState();
    expect(state.sessions[0].sample).toBe(true);
    sessionId = state.sessions[0].id;
  });

  await test.step('The run asks first; the person allows it for the whole task and it finishes', async () => {
    const row = columnOf(page, 'Review').locator('.crow', { hasText: TASK_NAME });
    await row.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.locator('#scrThread')).toBeVisible();
    const notice = page.getByRole('region', { name: 'Needs your OK', exact: true });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(`start working on ${TASK_NAME}`);
    await notice.getByRole('button', { name: 'Go ahead for this whole task', exact: true }).click();
    await expect
      .poll(async () => (await projectState()).sessions.find((s) => s.id === sessionId)?.state, {
        timeout: 45_000,
      })
      .toBe('done');
    await expect(notice).toHaveCount(0);
    const state = await projectState();
    const waiting = state.changes.filter((change) => change.state === 'waiting');
    expect(waiting.map((change) => change.path)).toEqual([NOTES]);
    changeId = waiting[0].id;
    historyEntryId = waiting[0].entryId;
    approved = await fs.readFile(path.join(projectFolder, NOTES), 'utf8');
    expect(approved).toContain('# Sample work notes');
    const entry = state.history.find((item) => item.id === historyEntryId);
    expect(entry?.kind).toBe('changed');
    expect(entry?.sessionId).toBe(sessionId);
    expect(entry?.files.map((file) => file.path)).toEqual([NOTES]);
  });

  await test.step('The change is reviewed in the task thread: what changed, the added text and its History reference', async () => {
    await expectReviewedNotes(page, approved);
    await page.screenshot({
      path: testInfo.outputPath('review-before-restart.png'),
      fullPage: true,
    });
  });

  await test.step('A check is declared and run from the thread, and the result reads Verified', async () => {
    const panel = await openRunPanel(page, sessionId);
    await expect(panel.locator('[data-verification]')).toHaveText('Not verified');
    await panel.getByRole('button', { name: 'Checks' }).click();
    await panel.getByLabel('Check kind').selectOption('file-exists');
    await panel.getByLabel('File').fill(NOTES);
    await panel.getByRole('button', { name: 'Add check' }).click();
    await expect(panel.locator('.verif-declared')).toContainText(`${NOTES} exists`);
    await panel.getByRole('button', { name: 'Run checks' }).click();
    await expect(panel.locator('[data-verification]')).toHaveText('Verified');
    await expect(panel.locator('.verif-sentence')).toHaveText(
      '1 declared check passed against 1 exact file version.',
    );
  });

  await test.step('The reviewed change is kept (through the review route: the Console has no Keep control)', async () => {
    const state = await projectState();
    const kept = await api<{ change: Change }>(
      `/projects/${state.project.id}/review/${encodeURIComponent(changeId)}`,
      'POST',
      { action: 'keep' },
    );
    expect(kept.change.state).toBe('kept');
    await page.reload();
    await openBoard(page);
    const row = columnOf(page, 'Done').locator('.crow', { hasText: TASK_NAME });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-verification]')).toHaveText('Verified');
    expect(await fs.readFile(path.join(projectFolder, NOTES), 'utf8')).toBe(approved);
  });

  await test.step('The service is stopped with SIGTERM, exits cleanly, and starts again on the same data folder', async () => {
    const exit = await stopService();
    expect(exit).toEqual({ code: 0, signal: null });
    expect(await portIsFree(port)).toBe(true);
    await expect(page.request.get(`${baseURL}/api/settings`)).rejects.toThrow();
    await startService();
  });

  await test.step('After the restart and a reload, the project, the verified task and the reviewed change are intact', async () => {
    await page.reload();
    await showProjects(page);
    await expect(
      page.getByRole('button', { name: new RegExp(PROJECT_NAME) }).first(),
    ).toBeVisible();
    await page
      .getByRole('button', { name: new RegExp(PROJECT_NAME) })
      .first()
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
    await expect(page.locator('html')).toHaveAttribute('data-view', 'architect');

    await openBoard(page);
    const row = columnOf(page, 'Done').locator('.crow', { hasText: TASK_NAME });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-verification]')).toHaveText('Verified');

    await openTaskThread(page);
    // Folded, the finished run's record still says its result.
    const record = page
      .locator('.record')
      .filter({ has: page.locator('[data-verification]') })
      .first();
    await expect(record.locator('[data-verification]')).toHaveText('Verified');
    const panel = await openRunPanel(page, sessionId);
    await expect(panel.locator('[data-verification]')).toHaveText('Verified');
    await expect(panel.locator('.verif-sentence')).toHaveText(
      '1 declared check passed against 1 exact file version.',
    );
    // The evidence is the record made before the restart: the check, and the exact bytes it saw.
    await panel.getByRole('button', { name: 'Evidence', exact: true }).click();
    const check = panel.locator('.verif-evidence .verif-check', { hasText: `${NOTES} exists` });
    await expect(check).toHaveCount(1);
    await expect(check.locator('.verif-bytes')).toContainText(
      new RegExp(`${NOTES} @ [a-f0-9]{12}`),
    );
    await expectReviewedNotes(page, approved);
    await page.screenshot({
      path: testInfo.outputPath('review-after-restart.png'),
      fullPage: true,
    });

    const state = await projectState();
    const task = state.tasks.find((item) => item.name === TASK_NAME);
    expect(task?.state).toBe('done');
    const change = state.changes.find((item) => item.id === changeId);
    expect(change?.state).toBe('kept');
    expect(change?.path).toBe(NOTES);
    const entry = state.history.find((item) => item.id === historyEntryId);
    expect(entry?.kind).toBe('changed');
    expect(entry?.sessionId).toBe(sessionId);
    expect(entry?.files.map((file) => file.path)).toEqual([NOTES]);
    expect(
      state.history.filter((item) => item.kind === 'decision' && item.sessionId === sessionId)
        .length,
    ).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(projectFolder, NOTES), 'utf8')).toBe(approved);
  });

  await test.step('The restarted service stops cleanly too', async () => {
    expect(await stopService()).toEqual({ code: 0, signal: null });
  });
});
