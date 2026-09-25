import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Settings } from '../shared/types';
import type { ReleaseNotesFile } from '../shared/release-notes';

// Settings > What's new and the post-update notice, in the browser.
//
// A version change is simulated rather than installed: the update service's
// status route is answered in the page with the newest published release as
// the installed version, and the settings say setup finished the day before
// that release. That is exactly the pair of facts the app reads to decide it
// has just been updated (shared/release-notes.ts, releaseNoticeFor), so
// nothing else is faked and the rest of the app is the real dev server.
const headers = { 'X-Diomedes-Client': '1' };
const NOTES = JSON.parse(
  readFileSync(new URL('../resources/release-notes/releases.json', import.meta.url), 'utf8'),
) as ReleaseNotesFile;
const STABLE = NOTES.releases.filter((r) => r.channel === 'stable');
const DRAFTS = NOTES.releases.filter((r) => r.channel === 'draft');
const INSTALLED = STABLE[0];
const dayBefore = (date: string) =>
  new Date(Date.parse(`${date}T12:00:00.000Z`) - 24 * 60 * 60 * 1000).toISOString();

let saved: Settings;
let pageErrors: string[] = [];

test.beforeAll(async ({ request }) => {
  saved = await (await request.get('/api/settings')).json();
});
test.afterAll(async ({ request }) => {
  expect((await request.put('/api/settings', { headers, data: saved })).ok()).toBe(true);
});
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // The installed version, as the update service would report it after an update.
  await page.route('**/api/updates/status', async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, installedVersion: INSTALLED.version } });
  });
});
test.afterEach(() => {
  expect(pageErrors, 'the interface must not throw').toEqual([]);
});

/** Setup finished before the installed release existed; `seen` is what was dismissed. */
async function settle(page: Page, seen: string[], completedAt = dayBefore(INSTALLED.date)) {
  const put = await page.request.put('/api/settings', {
    headers,
    data: {
      onboarding: { ...saved.onboarding, resumeAt: 'done', completedAt },
      seen: { ...saved.seen, releaseNotes: seen },
    },
  });
  expect(put.ok(), await put.text()).toBe(true);
}

async function openWhatsNew(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: "What's new", exact: true }).click();
  await expect(page.getByRole('heading', { name: "What's new", level: 1 })).toBeVisible();
}

const notice = (page: Page) => page.locator('.release-notice');

test("Settings > What's new lists every stable release, newest first, with the installed one marked", async ({
  page,
}) => {
  // Already dismissed, so no notice sits over the page.
  await settle(page, [INSTALLED.version]);
  await page.goto('/');
  await openWhatsNew(page);

  const entries = page.locator('.whats-new .release-entry');
  await expect(entries).toHaveCount(STABLE.length);
  const versions = await entries.locator('.release-version').allTextContents();
  expect(versions).toEqual(STABLE.map((r) => `Version ${r.version}`));
  for (const draft of DRAFTS)
    await expect(page.getByText(`Version ${draft.version}`, { exact: true })).toHaveCount(0);

  // The installed release is marked, once, and starts open; the rest start closed.
  const installed = page.getByRole('region', { name: `Version ${INSTALLED.version}` });
  await expect(installed).toHaveClass(/installed/);
  await expect(installed.locator('summary')).toContainText('Installed');
  await expect(page.locator('.whats-new summary', { hasText: 'Installed' })).toHaveCount(1);
  await expect(installed.locator('details')).toHaveAttribute('open', '');
  await expect(installed.getByText(INSTALLED.headline)).toBeVisible();
  for (const section of INSTALLED.sections)
    await expect(installed.getByRole('heading', { name: section.title, level: 4 })).toBeVisible();

  // Each entry collapses and expands, from the pointer and from the keyboard.
  const older = page.getByRole('region', { name: `Version ${STABLE[1].version}` });
  await expect(older.locator('details')).not.toHaveAttribute('open', '');
  await expect(older.getByText(STABLE[1].headline)).toBeHidden();
  await older.locator('summary').click();
  await expect(older.getByText(STABLE[1].headline)).toBeVisible();
  await older.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(older.getByText(STABLE[1].headline)).toBeHidden();
  await installed.locator('summary').click();
  await expect(installed.getByText(INSTALLED.headline)).toBeHidden();
});

test("What's new holds at 200 percent zoom and under reduced motion", async ({ page }) => {
  await settle(page, [INSTALLED.version]);
  // 200 percent of a 1440 x 900 window: a 720 x 450 CSS viewport (see cd05-zoom-motion.spec.ts).
  await page.setViewportSize({ width: 720, height: 450 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await openWhatsNew(page);
  const installed = page.getByRole('region', { name: `Version ${INSTALLED.version}` });
  await expect(installed.getByText(INSTALLED.headline)).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no sideways page scroll').toBeLessThanOrEqual(0);
  const box = await installed.boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(720);

  const motion = await installed.locator('summary h3').evaluate((heading) => {
    const chevron = getComputedStyle(heading, '::before');
    return { transition: chevron.transitionDuration, animation: chevron.animationName };
  });
  expect(motion.transition.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
  expect(motion.animation).toBe('none');
});

test('after an update the new notes show once, and Dismiss settles that version', async ({
  page,
}) => {
  await settle(page, []);
  await page.goto('/');
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText(`Updated to ${INSTALLED.version}.`);
  await expect(notice(page)).toContainText(INSTALLED.headline);
  await expect(notice(page)).toHaveAttribute('role', 'status');

  await notice(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(notice(page)).toHaveCount(0);
  await expect
    .poll(async () => ((await (await page.request.get('/api/settings')).json()) as Settings).seen.releaseNotes)
    .toEqual([INSTALLED.version]);

  // The next launch of the same version shows nothing.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});

test("the notice's What's new opens the installed version's notes and settles it too", async ({
  page,
}) => {
  await settle(page, []);
  await page.goto('/');
  await notice(page).getByRole('button', { name: "What's new", exact: true }).click();
  await expect(page.getByRole('heading', { name: "What's new", level: 1 })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  const installed = page.getByRole('region', { name: `Version ${INSTALLED.version}` });
  await expect(installed.locator('details')).toHaveAttribute('open', '');
  await expect
    .poll(async () => ((await (await page.request.get('/api/settings')).json()) as Settings).seen.releaseNotes)
    .toEqual([INSTALLED.version]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});

test('a new install of the same version shows no notice', async ({ page }) => {
  // Setup finished on the release day or later: this copy was installed at this version.
  await settle(page, [], `${INSTALLED.date}T18:00:00.000Z`);
  const status = page.waitForResponse('**/api/updates/status');
  await page.goto('/');
  await status;
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});
