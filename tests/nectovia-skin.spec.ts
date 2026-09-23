import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Project, Settings } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

// The Nectovia scheme round trip (APP SKIN brief, verification). Choosing
// Nectovia in Settings paints its tokens, its mark and its plates; choosing
// Field paints exactly today's Field, with no plate and no bust; reduced
// motion stills the agent home completely; the segment bars say their counts.
// Screenshots of each screen under both schemes go to NECTOVIA_SHOTS
// (default test-results/nectovia-skin) for the lane's evidence.

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const SHOTS = process.env.NECTOVIA_SHOTS ?? path.join('test-results', 'nectovia-skin');
const WORK = 'Linen and laundry';
const FINISHED = 'Weekly ordering';
const THREADS = ['Receiving notes', 'Delivery records'];

let originalSettings: Settings | null = null;
let workId = '';
let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});

test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

async function makeProject(
  request: import('@playwright/test').APIRequestContext,
  name: string,
  tasks: string[],
  done: number,
): Promise<string> {
  const created = await request.post('/api/projects', { headers: HEADERS, data: { name } });
  expect(created.ok(), await created.text()).toBe(true);
  const id = ((await created.json()) as Project).id;
  for (const [index, task] of tasks.entries()) {
    const made = await request.post(`/api/projects/${id}/tasks`, { headers: HEADERS, data: { name: task } });
    expect(made.ok(), await made.text()).toBe(true);
    if (index < done) {
      const taskId = ((await made.json()) as { id: string }).id;
      const moved = await request.put(`/api/projects/${id}/tasks/${taskId}`, {
        headers: HEADERS,
        data: { state: 'done' },
      });
      expect(moved.ok(), await moved.text()).toBe(true);
    }
  }
  return id;
}

test.beforeAll(async ({ request }) => {
  // Playwright sorts spec files, so this file runs before ui.spec.ts, whose
  // first test needs onboarding unfinished: keep the whole settings object and
  // put it back in afterAll.
  const current = await request.get('/api/settings');
  expect(current.ok()).toBe(true);
  originalSettings = (await current.json()) as Settings;
  const setup = await request.put('/api/settings', {
    headers: HEADERS,
    data: {
      onboarding: { resumeAt: 'done', work: 'business', detail: 'technical', familiarity: 'comfortable' },
      surface: 'console',
      detail: 'technical',
    },
  });
  expect(setup.ok()).toBe(true);
  workId = await makeProject(
    request,
    WORK,
    ['Match the 4 Sep receiving note', 'Compare four delivery records', 'Draft the linen order', 'File the invoices'],
    2,
  );
  await makeProject(request, FINISHED, ['Collect supplier prices', 'Draft the order', 'Send the order'], 3);
  for (const name of THREADS) {
    const thread = await request.post(`/api/projects/${workId}/threads`, { headers: HEADERS, data: { name } });
    expect(thread.ok()).toBe(true);
  }
  const opened = await request.put('/api/settings', { headers: HEADERS, data: { openProjects: [workId] } });
  expect(opened.ok()).toBe(true);
  await fs.mkdir(SHOTS, { recursive: true });
});

test.afterAll(async ({ request }) => {
  expect(originalSettings, 'The settings snapshot must exist so onboarding can be restored').toBeTruthy();
  const restore = await request.put('/api/settings', {
    headers: HEADERS,
    data: JSON.parse(JSON.stringify(originalSettings)),
  });
  expect(restore.ok()).toBe(true);
});

const rootVar = (page: Page, name: string) =>
  page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name);

async function shot(page: Page, name: string) {
  // Transitions are stopped at their end, so a shot is the resting look.
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: 'disabled' });
}

/** Into the project, on its thread. */
async function openWork(page: Page) {
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await expect(page.locator('#scrThread')).toBeVisible();
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'Threads and views' });

/** Choose a scheme the way a person does: Settings, Appearance, the radio. */
async function chooseScheme(page: Page, name: 'Nectovia' | 'Field', id: string) {
  await openWork(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  const radio = page.getByRole('radio', { name, exact: true });
  // The radio shows the saved setting, so it turns on when the save returns;
  // `check()` wants the change at once. Click, then wait for it (as field.spec does).
  await radio.click();
  await expect(page.locator('html')).toHaveAttribute('data-package', id);
  await expect(radio).toBeChecked();
}

/**
 * The agent home. A launch opens there; inside a session the window keeps its
 * place, so from anywhere else go the way a person does: Projects, then the
 * Projects page's own way home.
 */
async function openHome(page: Page) {
  await page.goto('/');
  const heading = page.getByRole('heading', { name: 'Nectovia', exact: true });
  const projects = page.getByRole('navigation', { name: 'Open projects', exact: true }).getByRole('button').first();
  await expect(heading.or(projects).first()).toBeVisible();
  if (!(await heading.isVisible())) {
    await projects.click();
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Projects and destinations', exact: true })
      .getByRole('button', { name: 'Nectovia', exact: true })
      .click();
  }
  await expect(heading).toBeVisible();
}

/** Every screen the brief names, under the scheme in force. */
async function shootScreens(page: Page, scheme: string) {
  await openWork(page);
  await shot(page, `${scheme}-thread`);

  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Find and act' });
  await expect(palette).toBeVisible();
  await shot(page, `${scheme}-dialog-palette`);
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);

  await rail(page).getByRole('button', { name: /^Board/ }).click();
  await expect(page.locator('.board[aria-label="Board"]')).toBeVisible();
  await shot(page, `${scheme}-board`);

  await rail(page).getByRole('button', { name: /^History\b/ }).click();
  await expect(page.locator('.hist')).toBeVisible();
  await shot(page, `${scheme}-history`);

  await page.evaluate(() => localStorage.setItem('console.files.open', 'true'));
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Files', exact: true })).toBeVisible();
  await shot(page, `${scheme}-files`);
  await page.evaluate(() => localStorage.removeItem('console.files.open'));

  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  await shot(page, `${scheme}-settings`);

  await openHome(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await shot(page, `${scheme}-projects`);
}

/**
 * The agent home with a report that has every kind of row. A project waiting
 * on the person, or with a run working, needs a live engine, so this one shot
 * serves the project list with those counts; everything else is real.
 */
async function shootHomeWithEveryRow(page: Page, name: string) {
  const real = (await (await page.request.get('/api/projects')).json()) as { projects: Project[] };
  const projects = real.projects.map((project) =>
    project.id === workId
      ? { ...project, status: { needsYou: 1, working: 1, tasksDone: 2, tasksTotal: 4 } }
      : project,
  );
  await page.route('**/api/projects', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname !== '/api/projects') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects }) });
  });
  await openHome(page);
  await expect(page.locator('.nv-row.attn')).toBeVisible();
  await expect(page.locator('.nv-band')).toHaveCount(0);
  await shot(page, name);
  await page.unroute('**/api/projects');
}

test('Nectovia: its tokens, the mark, and a plate with its bevel', async ({ page }) => {
  await chooseScheme(page, 'Nectovia', 'nectovia');
  expect(await rootVar(page, '--chrome')).toBe('#08080c');
  expect(await rootVar(page, '--surface')).toBe('#0d0d12');
  expect(await rootVar(page, '--raised')).toBe('#14141a');
  expect(await rootVar(page, '--t1')).toBe('#e6e9ed');
  expect(await rootVar(page, '--light')).toBe('#44d2c9');
  expect(await rootVar(page, '--attn')).toBe('#e0a94a');

  await openWork(page);
  // The mark in the Console's strip: its plates, one lit point, the word.
  const mark = page.locator('.console .top .dm-nmark');
  await expect(mark).toBeVisible();
  await expect(mark.locator('svg polygon.dm-nmark-plate')).toHaveCount(3);
  await expect(mark.locator('[data-mark-point]')).toHaveCount(1);
  await expect(mark.locator('.dm-nmark-word')).toHaveText('Nectovia');
  // The composer is a plate: a cut layer behind it and a lit edge on the bevel.
  const composer = page.locator('#scrThread .composer');
  await expect(composer).toBeVisible();
  const plate = await composer.evaluate((element) => {
    const body = getComputedStyle(element, '::before');
    const edge = getComputedStyle(element, '::after');
    return { content: body.content, clip: body.clipPath, edge: edge.width, position: getComputedStyle(element).position };
  });
  expect(plate.content).toBe('""');
  expect(plate.clip).toMatch(/^polygon\(/);
  expect(plate.edge).toBe('16px');
  expect(plate.position).toBe('relative');
  // The strip's rule carries the registration mark.
  const seam = await page
    .locator('.console .top')
    .evaluate((element) => getComputedStyle(element, '::after').backgroundImage);
  expect(seam).toContain('linear-gradient');

  await shootScreens(page, 'nectovia');
  await openHome(page);
  await expect(page.locator('.nv-art')).toBeVisible();
  await expect(page.locator('.nv-band')).toHaveCount(0);
  await shot(page, 'nectovia-home');
  await shootHomeWithEveryRow(page, 'nectovia-home-every-row');

  await page.setViewportSize({ width: 1100, height: 800 });
  await openHome(page);
  await shot(page, 'nectovia-1100-home');
  await openWork(page);
  await shot(page, 'nectovia-1100-thread');
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('Nectovia: the segment bars say their counts', async ({ page }) => {
  await openHome(page);
  const finished = page.getByRole('progressbar', { name: `${FINISHED} tasks`, exact: true });
  await expect(finished).toHaveAttribute('aria-valuemin', '0');
  await expect(finished).toHaveAttribute('aria-valuemax', '3');
  await expect(finished).toHaveAttribute('aria-valuenow', '3');
  await expect(finished).toHaveAttribute('aria-valuetext', '3 of 3 tasks done');
  // A project with nothing waiting, running or finished is quiet: no row, no bar.
  await expect(page.getByRole('progressbar', { name: `${WORK} tasks`, exact: true })).toHaveCount(0);
  await expect(page.locator('.nv-quiet')).toContainText('quiet');
  // On the Projects list the row is one button, so its bar is drawn for the eye
  // and the caption says the count.
  await page.getByRole('button', { name: 'Projects', exact: true }).first().click();
  await expect(page.getByText('2 of 4 tasks done').first()).toBeVisible();
});

test('Nectovia: the signature plays once a session and settles to the resting bust', async ({ page }) => {
  await openHome(page);
  const art = page.locator('.nv-art');
  await expect(art).toHaveClass(/\bsigned\b/);
  expect(await page.evaluate(() => sessionStorage.getItem('console.nectovia.signature'))).toBe('1');
  // The bands go once A has resolved, and the page never waited on them.
  await expect(page.locator('.nv-band')).toHaveCount(0, { timeout: 5000 });
  await expect(art).not.toHaveClass(/\bsignature\b/);
  // Its visit skips the view shear, which the signature replaces.
  expect(await page.locator('.dio-screen').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
  await expect(page.locator('.nv-art')).toBeVisible();
  await expect(page.locator('.nv-art')).not.toHaveClass(/\bsigned\b/);
});

test('Nectovia under reduced motion: nothing on the home moves at all', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openHome(page);
  await expect(page.locator('.nv-art')).toBeVisible();
  await expect(page.locator('.nv-art')).not.toHaveClass(/\bsigned\b/);
  await expect(page.locator('.nv-band')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('console.nectovia.signature'))).toBeNull();
  const running = await page.evaluate(() =>
    document.getAnimations().map((animation) => (animation as CSSAnimation).animationName ?? 'script'),
  );
  expect(running).toEqual([]);
});

test('Field: today’s Field, with no plate and no bust', async ({ page }) => {
  await chooseScheme(page, 'Field', 'field');
  expect(await rootVar(page, '--chrome')).toBe('#121417');
  expect(await rootVar(page, '--surface')).toBe('#16191d');
  expect(await rootVar(page, '--t1')).toBe('#e6e9ed');
  expect(await rootVar(page, '--light')).toBe('#3fd6df');

  await openWork(page);
  const plate = await page
    .locator('#scrThread .composer')
    .evaluate((element) => getComputedStyle(element, '::before').content);
  expect(plate).toBe('none');
  // The name is global; the mark is too (contract A2), the plates are not.
  await expect(page.locator('.console .top .dm-nmark')).toBeVisible();

  await openHome(page);
  await expect(page.locator('.nv-art')).toHaveCount(0);
  await expect(page.locator('.nv-brief')).toHaveCount(0);
  await expect(page.locator('img[src*="nectovia-bust"]')).toHaveCount(0);
  await shot(page, 'field-home');
  await shootScreens(page, 'field');
});
