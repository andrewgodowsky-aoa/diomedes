/**
 * Automations Milestones A and B: the acceptance paths, in the built Console.
 *
 * From the normal Console a person finds the configured job, sees that it is
 * manual, runs it through the existing admission, follows its real work and
 * evidence, sees a missing-input failure, and returns after a restart to the
 * same saved records. Setup identity, intake and activation are prepared over
 * the API, the way `configuration-ui.spec.ts` does; everything the person does
 * happens in the page. Every company, project and file here is invented.
 */
import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Project } from '../shared/types.js';
import type { WorkspaceView } from '../shared/workspaces.js';
import type { BusinessSetupView } from '../shared/business-setup.js';
import type { AutomationDetail, TriggerOccurrence } from '../shared/automations.js';
import { nextSlots, slotText, type AutomationSchedule } from '../shared/automation-schedule.js';
import type { AutomationScheduler } from '../server/automation-scheduler.js';
import type { AutomationService } from '../server/automations.js';
import { reopenLastProject } from './fixtures/landing';

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let root: string;
let project: Project;
let organizationId: string;
let selection: string[] = [];
/** The scheduler's clock: real time until a test fixes it (Milestone B). */
let fixedClock: number | null = null;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${route}: ${response.status}`).toBe(true);
  return response.json() as Promise<T>;
}

async function launch() {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  app = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
    // Milestone B: no timer; the schedule test moves the clock and asks for a pass.
    automationClock: () => fixedClock ?? Date.now(),
    automationTickMs: null,
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const source of [
    'client/console/AutomationsPage.tsx',
    'client/console/AutomationSchedule.tsx',
    'client/console/automations.css',
    'client/console/Shell.tsx',
    'client/App.tsx',
    'shared/automations.ts',
  ])
    expect(built, `Build the UI before this spec: ${source} is newer than dist.`).toBeGreaterThan(
      (await fs.stat(path.resolve(source))).mtimeMs,
    );
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
}

async function stop() {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test.beforeAll(async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  root = await fs.mkdtemp(path.resolve('test-results/automations-'));
  await launch();
  project = await api<Project>('/projects', 'POST', { name: 'Fernbrook books' });
  await api('/settings', 'PUT', {
    detail: 'standard',
    openProjects: [project.id],
    onboarding: {
      work: 'business',
      detail: 'standard',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
  const view = await api<WorkspaceView>('/workspace/organizations', 'POST', {
    name: 'Fernbrook Joinery',
    industry: 'cabinetry',
  });
  organizationId = view.organizations.at(-1)!.organization.id;
  await api('/workspace/switch', 'POST', { kind: 'business', organizationId });
  const base = `/workspace/organizations/${organizationId}`;
  const answers: Record<string, unknown> = {
    name: 'Fernbrook Joinery',
    industry: 'cabinetry',
    job: 'recurring-report',
    result: 'A weekly note a person reads before anyone acts on it.',
    sources: ['files'],
    people: 'small-team',
    locations: 'one',
    'human-required': ['sending', 'money'],
    'data-leaving': 'non-sensitive',
    host: 'The office desktop, weekdays.',
    'spend-cap': 120,
    'first-run': 'weekly',
  };
  await api(`${base}/setup/start`, 'POST', {});
  let setup = await api<BusinessSetupView>(`${base}/setup`);
  for (let guard = 0; setup.step !== 'review' && guard < 20; guard++)
    setup = await api<BusinessSetupView>(`${base}/setup/answer`, 'POST', {
      questionId: setup.step,
      value: answers[setup.step] ?? null,
      unknown: answers[setup.step] === undefined,
      expectedDigest: setup.digest,
    });
  expect(setup.state).toBe('proposal-ready');
  const compiled = await api<{ staged: { revision: number }; expectedActiveRevision: number | null }>(
    `${base}/configuration/compile`,
    'POST',
    {},
  );
  const activated = await api<{ active: { proposal: { contextScopes: { selection: string[] }[] } } }>(
    `${base}/configuration/activate`,
    'POST',
    {
      revision: compiled.staged.revision,
      expectedActiveRevision: compiled.expectedActiveRevision,
      activationId: 'automations-ui-1',
    },
  );
  selection = activated.active.proposal.contextScopes.flatMap((item) => item.selection);
  expect(selection.length).toBeGreaterThan(0);
  // The exports the setup names, put into the project the way Import files would.
  for (const name of selection) {
    const file = path.join(project.folder, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '- Two cabinets fitted on Tuesday.\n- One quote still open.\n');
  }
  await api(`${base}/output`, 'POST', { projectId: project.id });
});
test.afterAll(stop);

let pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

/** The `openDestination` helper from `fd03-readiness.spec.ts`. */
const openDestination = async (page: Page, label: string) => {
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${label}\\b`) }).click();
};
const screen = (page: Page) => page.getByRole('region', { name: 'Automations' });
const row = (page: Page) => screen(page).getByRole('article').first();
const detail = () =>
  api<AutomationDetail>(
    `/workspace/organizations/${organizationId}/automations/${encodeURIComponent(`brief:${organizationId}`)}`,
  );

test('finds the manual brief, runs it once, follows its records, sees missing data and keeps them after a restart', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto(url);
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();

  // 1. Found from Everything, in the Nectovia group beside AI engines (D4).
  await openDestination(page, 'Automations');
  await expect(screen(page).getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible();

  // 2. Manual, not scheduled, and a recorded weekly answer that stays inactive.
  await expect(row(page)).toContainText('Manual — not scheduled');
  await expect(row(page)).toContainText('recorded but stays inactive');
  await expect(screen(page).getByLabel('Summary')).toContainText('Configured');
  await expect(screen(page)).toContainText('local development');
  await expect(row(page)).toContainText('Not measured');
  await page.screenshot({ path: 'test-results/automations-manual.png' });

  // 3. A double press is one run.
  const runOnce = row(page).getByRole('button', { name: 'Run once' });
  await runOnce.dblclick();
  await expect(row(page)).toContainText('Draft saved for review', { timeout: 30_000 });
  expect((await detail()).total).toBe(1);
  const state = await api<{ tasks: { id: string }[] }>(`/projects/${project.id}/state`);
  expect(state.tasks).toHaveLength(1);

  // 4. Follow it to the draft and to its Task.
  await row(page).getByRole('button', { name: 'Open the draft' }).click();
  const files = page.getByRole('complementary', { name: 'Files', exact: true });
  await expect(files).toContainText('cabinets fitted');
  await row(page).getByRole('button', { name: 'Keep or undo the draft' }).click();
  await expect(page.locator('#scrThread')).toBeVisible();
  await expect(page.locator('#scrThread')).toContainText('Prepare the weekly brief');
  await openDestination(page, 'Automations');

  // 5. A missing source: Waiting for data, naming the file, nothing written.
  await fs.rm(path.join(project.folder, selection[0]!));
  // Keyboard only: from Refresh, Tab reaches Run once, and Enter presses it.
  await screen(page).getByRole('button', { name: 'Refresh' }).focus();
  await page.keyboard.press('Tab');
  await expect(row(page).getByRole('button', { name: 'Run once' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row(page)).toContainText('Waiting for data', { timeout: 30_000 });
  await expect(row(page)).toContainText(selection[0]!);
  // Focus is not lost by the run or the refresh that follows it.
  await expect(row(page).getByRole('button', { name: 'Run once' })).toBeFocused();
  await expect(row(page)).toContainText('Not written');
  // The outcome is said once in the status line, not left at "Started".
  await expect(screen(page).locator('.auto-announce')).toContainText(`Waiting for data: ${selection[0]}`);
  await page.screenshot({ path: 'test-results/automations-waiting-for-data.png' });

  // The disclosure works from the keyboard too.
  const toggle = row(page).getByRole('button', { name: /details/i });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // 6. A restart rebuilds the same records, with no ghost Running.
  const before = await detail();
  expect(before.total).toBe(2);
  await stop();
  await launch();
  await page.goto(url);
  await reopenLastProject(page);
  await openDestination(page, 'Automations');
  await expect(row(page)).toContainText('Waiting for data');
  await expect(row(page)).not.toContainText('Running');
  const after = await detail();
  expect(after.occurrences.map((item) => item.occurrence)).toEqual(
    before.occurrences.map((item) => item.occurrence),
  );
  await expect(screen(page).locator('.auto-occurrence')).toHaveCount(2);

  // 7. At 200% zoom (half the width) nothing runs off the side.
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(row(page).getByRole('button', { name: 'Run once' })).toBeVisible();
  const overflow = await screen(page).evaluate((element) => {
    const page = element.querySelector('.automations-page')!;
    return page.scrollWidth - page.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/automations-narrow.png', fullPage: true });
});

test('the palette opens Automations too', async ({ page }) => {
  await page.goto(url);
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Find and act' });
  await expect(palette).toBeVisible();
  await palette.getByRole('textbox').fill('Automations');
  // A row runs its first action, Open, when it is clicked.
  await palette.getByText('Automations', { exact: true }).click();
  await expect(screen(page).getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible();
});

test('an owner turns a schedule on, sees the next run, the due slot starts on its own, and a pause stops the next', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const scheduler = () => app.locals.automationScheduler as AutomationScheduler;
  const service = () => app.locals.automations as AutomationService;
  const MONDAY_8: AutomationSchedule = {
    cadence: 'weekly',
    weekday: 1,
    time: '08:00',
    timezone: 'America/New_York',
  };
  // Ten minutes before the next Monday 8:00 a.m. in New York, whenever this runs.
  const [first, second] = nextSlots(MONDAY_8, Date.now(), 2);
  fixedClock = first!.ms - 10 * 60_000;
  await scheduler().tick();
  // The first test removed a source; put it back so the scheduled run can read it.
  await fs.writeFile(path.join(project.folder, selection[0]!), '- Three cabinets fitted.\n');

  await page.goto(url);
  await reopenLastProject(page);
  await openDestination(page, 'Automations');
  // One clean manual run first, so the last run no longer reads Waiting for data.
  await row(page).getByRole('button', { name: 'Run once' }).click();
  await expect(row(page)).toContainText('Draft saved for review', { timeout: 30_000 });
  await expect(row(page).locator('.auto-state')).toHaveText('Manual — not scheduled');
  const tasksBefore = (await api<{ tasks: unknown[] }>(`/projects/${project.id}/state`)).tasks.length;
  const schedule = row(page).getByRole('region', { name: 'Schedule' });
  await expect(schedule).toContainText('Off. It runs only when someone presses Run once.');

  // Edit: saving a schedule does not turn it on (A01).
  await schedule.getByRole('button', { name: 'Set a schedule' }).click();
  const form = schedule.getByRole('form', { name: 'Edit schedule' });
  await form.getByLabel('Repeats').selectOption('weekly');
  await form.getByLabel('Day').selectOption({ label: 'Monday' });
  await form.getByLabel('Local time').fill('08:00');
  await form.getByLabel('Timezone').selectOption('America/New_York');
  await expect(form.locator('.auto-preview')).toContainText('Would run');
  await form.getByRole('button', { name: 'Save schedule' }).click();
  await expect(screen(page).locator('.auto-announce')).toContainText('It is not on until someone turns it on');
  await expect(row(page)).toContainText('Manual — not scheduled');
  await expect(schedule).toContainText('Every Monday at 8:00 a.m. America/New_York');

  // Turn on: Scheduled, with the next run the host computed.
  await schedule.getByRole('button', { name: 'Turn on schedule' }).click();
  await expect(row(page).locator('.auto-state')).toHaveText('Scheduled');
  const nextText = slotText(MONDAY_8, first!);
  await expect(row(page).locator('[data-next-run]')).toHaveText(nextText);
  await expect(schedule.getByRole('list', { name: 'Next runs' })).toContainText(nextText);
  await expect(screen(page).getByLabel('Summary').locator(':scope > div').nth(1).locator('strong')).toHaveText('1');
  await page.screenshot({ path: 'test-results/automations-scheduled.png' });

  // The due slot starts on its own: nobody presses Run once.
  fixedClock = first!.ms + 10_000;
  await scheduler().tick();
  const scheduled = async () =>
    (await detail()).occurrences
      .map((item) => item.occurrence)
      .filter((item): item is TriggerOccurrence => item.trigger.kind === 'schedule');
  const [admitted] = await scheduled();
  expect(admitted!.admission.state).toBe('admitted');
  await service().settled(admitted!);
  await screen(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(row(page)).toContainText('Draft saved for review', { timeout: 30_000 });
  await expect(row(page).locator('.auto-occurrence[data-trigger="schedule"]').first()).toContainText(
    `Scheduled · ${slotText(MONDAY_8, first!).replace(/ \(.*\)$/, '')}`,
  );
  expect((await api<{ tasks: unknown[] }>(`/projects/${project.id}/state`)).tasks.length).toBe(tasksBefore + 1);

  // Pause, with a reason: the next Monday is recorded as skipped and nothing runs.
  await schedule.getByRole('button', { name: 'Pause' }).click();
  await schedule.getByRole('textbox', { name: 'Reason' }).fill('Stocktake week');
  await schedule.getByRole('group', { name: 'Pause the schedule' }).getByRole('button', { name: 'Pause' }).click();
  await expect(row(page).locator('.auto-state')).toHaveText('Paused');
  await expect(schedule).toContainText('Stocktake week');
  fixedClock = second!.ms + 10_000;
  await scheduler().tick();
  await screen(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(row(page).locator('.auto-occurrence[data-trigger="schedule"]').first()).toContainText(
    'Skipped — paused',
  );
  expect((await api<{ tasks: unknown[] }>(`/projects/${project.id}/state`)).tasks.length).toBe(tasksBefore + 1);
  await page.screenshot({ path: 'test-results/automations-paused.png' });
  fixedClock = null;
});
