/**
 * The Design Studio in the running app.
 *
 * A2 makes one claim here that no unit test can make: applying a theme changes
 * how the Console looks and nothing else. The app is not reloaded, React is not
 * remounted, the Console element is the same object afterwards, an unsent
 * message is still in the composer and the thread is still scrolled where it
 * was. Everything else A2 does is proven in tests/themes.test.ts.
 *
 * A3 extends this file with the editor itself.
 */
import { test, expect, type Page } from '@playwright/test';
import type { Project, Settings } from '../shared/types';

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const PROJECT_NAME = 'The Studio under test';
const THEME_ID = 'studio-proof';
const DRAFT = 'A half-typed message that must survive the theme';
/** Where the run leaves the pictures the A3 report points at. */
const SHOTS = 'docs/verification/2026-09-17-design-center';

let originalSettings: Settings | null = null;
let projectId = '';
let pageErrors: string[] = [];

/** A valid ThemePack whose colours are unmistakably not any built-in scheme. */
const themePack = (name = 'Studio proof') => {
  const color = (value: string) => ({ $type: 'color', $value: value });
  return {
    schemaVersion: 1,
    id: THEME_ID,
    name,
    revision: 1,
    // Not the scheme the settings say, so data-package proves the theme decided.
    baseTheme: 'graphite',
    surfaces: ['app-console'],
    provenance: { author: 'A2 spec', createdAt: '2026-09-17T00:00:00.000Z', tool: 'playwright' },
    tokens: {
      color: {
        chrome: color('#0b0410'),
        surface: color('#140a1e'),
        raised: color('#1d0f2a'),
        hair: color('#ffffff12'),
        hair2: color('#ffffff1f'),
        t1: color('#f6f0ff'),
        t2: color('#c3b4d8'),
        t3: color('#9a8bb0'),
        light: color('#7cf7ff'),
        attn: color('#ffce6a'),
        fail: color('#ff8080'),
      },
      lightScheme: { $type: 'boolean', $value: false },
    },
    typography: {
      interfaceScale: 1,
      readingScale: 1,
      codeScale: 1,
      lineHeight: 1.55,
      interfaceFont: 'schibsted-grotesk',
      readingFont: 'schibsted-grotesk',
      codeFont: 'ibm-plex-mono',
    },
    geometry: { controlRadius: 10, separatorStrength: 1, density: 'technical' },
    artwork: {},
    motion: { presetId: 'settle', duration: 160, intensity: 0.5, reducedMotionBehaviour: 'static' },
    assets: {},
  };
};

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});

test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test.beforeAll(async ({ request }) => {
  const current = await request.get('/api/settings');
  expect(current.ok()).toBe(true);
  originalSettings = (await current.json()) as Settings;
  const setup = await request.put('/api/settings', {
    headers: HEADERS,
    data: {
      onboarding: {
        resumeAt: 'done',
        work: 'business',
        detail: 'technical',
        familiarity: 'comfortable',
      },
      surface: 'console',
      detail: 'technical',
    },
  });
  expect(setup.ok()).toBe(true);
  const created = await request.post('/api/projects', {
    headers: HEADERS,
    data: { name: PROJECT_NAME },
  });
  expect(created.ok()).toBe(true);
  projectId = ((await created.json()) as Project).id;
  // Enough threads that the rail overflows at this viewport: scroll position is
  // React state nowhere, so only a real scroller can prove a theme did not
  // scroll the interface back to the top.
  for (let index = 0; index < 40; index += 1) {
    const thread = await request.post(`/api/projects/${projectId}/threads`, {
      headers: HEADERS,
      data: { name: `Studio thread ${index + 1}` },
    });
    expect(thread.ok()).toBe(true);
  }
  const opened = await request.put('/api/settings', {
    headers: HEADERS,
    data: { openProjects: [projectId] },
  });
  expect(opened.ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  // Every other spec in this config expects the built-in appearance. Leaving a
  // theme applied would change what field.spec.ts C06 reads off the document.
  const reset = await request.post('/api/themes/reset', { headers: HEADERS });
  expect(reset.ok()).toBe(true);
  expect(originalSettings, 'The settings snapshot must exist so onboarding can be restored').toBeTruthy();
  const restore = await request.put('/api/settings', {
    headers: HEADERS,
    data: JSON.parse(JSON.stringify(originalSettings)),
  });
  expect(restore.ok()).toBe(true);
});

async function openConsole(page: Page) {
  const opened = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { surface: 'console', openProjects: [projectId] },
  });
  expect(opened.ok()).toBe(true);
  await page.goto('/');
  const root = page.locator('.console');
  const card = page.getByRole('button', { name: PROJECT_NAME }).first();
  await expect(root.or(card).first()).toBeVisible();
  if ((await root.count()) === 0) {
    await card.click();
    await expect(root).toBeVisible();
  }
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
}

const rootVar = (page: Page, name: string) =>
  page.evaluate(
    (property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(),
    name,
  );

test('D01: a saved theme applies without remounting the app or losing a draft', async ({
  page,
  request,
}) => {
  const saved = await request.put(`/api/themes/${THEME_ID}`, {
    headers: HEADERS,
    data: themePack(),
  });
  expect(saved.ok(), await saved.text()).toBe(true);

  await openConsole(page);
  await expect(page.locator('html')).toHaveAttribute('data-package', 'field');

  // Type a message and leave it unsent; the composer holds it in React state,
  // so a remount is exactly what would lose it.
  const composer = page.getByRole('textbox', { name: 'Message this thread' });
  await composer.fill(DRAFT);
  await expect(composer).toHaveValue(DRAFT);

  // Scroll the thread rail away from the top. Nothing restores this on a
  // remount, so it is lost the moment the tree is rebuilt.
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  await rail.evaluate((element) => {
    element.scrollTop = 180;
  });
  const scrolled = await rail.evaluate((element) => element.scrollTop);
  expect(scrolled, 'The rail must actually be scrollable for this to prove anything').toBeGreaterThan(0);

  // Hold on to the live Console element and the document itself, so "no
  // remount" and "no reload" are assertions rather than inferences.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__studioConsole =
      document.querySelector('.console');
    (window as unknown as Record<string, unknown>).__studioMarked = true;
  });

  const activated = await page.request.post(`/api/themes/${THEME_ID}/activate`, {
    headers: HEADERS,
  });
  expect(activated.ok()).toBe(true);

  // The settings event brings the pointer to the client, which fetches the pack
  // and paints it. Poll rather than wait a fixed time.
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.themePack))
    .toBe(THEME_ID);
  // dataset.package is the pack's base scheme, never its own id: the desktop
  // titlebar is keyed by scheme id and must always resolve.
  await expect(page.locator('html')).toHaveAttribute('data-package', 'graphite');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'technical');
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  expect(await rootVar(page, '--surface')).toBe('#140a1e');
  expect(await rootVar(page, '--r')).toBe('10px');

  // Nothing remounted, nothing reloaded, nothing was lost.
  expect(
    await page.evaluate(() => {
      const marked = window as unknown as Record<string, unknown>;
      return marked.__studioMarked === true && marked.__studioConsole === document.querySelector('.console');
    }),
    'The Console element must be the same object after the theme applies',
  ).toBe(true);
  await expect(composer).toHaveValue(DRAFT);
  expect(await rail.evaluate((element) => element.scrollTop)).toBe(scrolled);
});

test('D02: a person’s own text size survives the theme, and reset restores the scheme', async ({
  page,
}) => {
  await openConsole(page);
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.themePack))
    .toBe(THEME_ID);

  // A size a theme cannot name: 1.12 is one of the Console's own reading sizes
  // and is not one of the four the resolver's personal layer carries, so without
  // the re-assert the theme's 1 would silently win. Reading size rather than
  // interface size because ui.spec.ts asserts that a first run has never had an
  // interface size written, and every spec here shares one service.
  const scaled = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { appearance: { readingScale: 1.12 } },
  });
  expect(scaled.ok()).toBe(true);
  await expect.poll(async () => rootVar(page, '--dm-read-scale')).toBe('1.12');
  await expect(page.locator('html')).toHaveAttribute('data-theme-pack', THEME_ID);

  const reset = await page.request.post('/api/themes/reset', { headers: HEADERS });
  expect(reset.ok()).toBe(true);
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.themePack ?? 'absent'))
    .toBe('absent');
  await expect(page.locator('html')).toHaveAttribute('data-package', 'field');
  expect(await rootVar(page, '--surface')).toBe('#16191d');
  // The size preference is still the person's after the theme is gone.
  expect(await rootVar(page, '--dm-read-scale')).toBe('1.12');
  const restored = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { appearance: { readingScale: 1 } },
  });
  expect(restored.ok()).toBe(true);
});

test('D03: a theme that cannot be read leaves the base scheme showing and says so', async ({
  page,
}) => {
  await openConsole(page);
  // A pointer at a theme that was never stored. The app must paint the built-in
  // package and explain itself, not blank the window.
  const pointed = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { appearance: { activeTheme: { id: 'no-such-theme', revision: 1 } } },
  });
  expect(pointed.ok()).toBe(true);
  await expect(page.locator('.console')).toBeVisible();
  await expect(page.locator('.appearance-notice')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-package', 'field');
  expect(await rootVar(page, '--surface')).toBe('#16191d');
  const cleared = await page.request.post('/api/themes/reset', { headers: HEADERS });
  expect(cleared.ok()).toBe(true);
});

/**
 * Open the Design Center the way a person does: the Console, then Settings,
 * then the section, then the button. Settings closes behind it, so the Console
 * is mounted underneath the workspace.
 */
async function openDesignCenter(page: Page) {
  // D02 and D03 put the theme away, so these tests apply it themselves rather
  // than depending on what the file happened to leave behind.
  const applied = await page.request.post(`/api/themes/${THEME_ID}/activate`, { headers: HEADERS });
  expect(applied.ok(), await applied.text()).toBe(true);
  await openConsole(page);
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.themePack))
    .toBe(THEME_ID);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Design Center', exact: true }).click();
  await page.getByRole('button', { name: 'Open Design Center' }).click();
  await expect(page.locator('.design-center')).toBeVisible();
  await expect(page.locator('.dc-stage')).toBeVisible();
}

test('D04: Design mode selects a real button and never fires its action; Interact does', async ({
  page,
}) => {
  await openDesignCenter(page);

  // The button under test is the app's own Button component, rendered by the
  // harness with a fixture callback. Nothing else on the page can move the log.
  const buttons = page.locator('[data-dc-piece="buttons"]');
  const primary = buttons.getByRole('button', { name: 'Start work' });
  await expect(page.locator('[data-dc-log="empty"]')).toBeVisible();

  await primary.click();
  // Selected, outlined, named in the inspector...
  await expect(buttons).toHaveClass(/selected/);
  await expect(page.locator('.dc-selection h3')).toHaveText('Buttons');
  // ...and its action did not run. The log is the claim, not the inference.
  await expect(page.locator('[data-dc-log="empty"]')).toBeVisible();
  expect(await page.locator('[data-dc-log="entries"] li').count()).toBe(0);

  // Interact mode against the same fixtures: the action runs, and still only
  // touches the log.
  await page.getByRole('button', { name: 'Interact', exact: true }).click();
  await primary.click();
  await expect(page.locator('[data-dc-log="entries"] li')).toHaveText(['Emphasised button']);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.screenshot({ path: `${SHOTS}/01-design-mode-selection.png`, fullPage: true });
});

test('D05: a radius change shows in the preview, undoes, and applies to the app', async ({
  page,
  request,
}) => {
  await openDesignCenter(page);

  const stage = page.locator('.dc-stage');
  const stageVar = (name: string) =>
    stage.evaluate(
      (element, property) => getComputedStyle(element).getPropertyValue(property).trim(),
      name,
    );

  // The preview is painted by the pack being edited, not by the document. It
  // starts on the applied theme, whose radius D01 saved as 10px.
  await expect.poll(() => stageVar('--r')).toBe('10px');
  // ...and the document is still wearing the applied theme, untouched.
  expect(await rootVar(page, '--r')).toBe('10px');

  await page.screenshot({ path: `${SHOTS}/02-preview-before-edit.png`, fullPage: true });

  const radius = page.getByRole('slider', { name: 'Control radius' });
  await radius.fill('2');
  await expect.poll(() => stageVar('--r')).toBe('2px');
  // Editing changed the preview and nothing else. The app has not moved.
  expect(await rootVar(page, '--r')).toBe('10px');

  // Undo is Studio-only: it walks the preview back and still writes no settings.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => stageVar('--r')).toBe('10px');
  expect(await rootVar(page, '--r')).toBe('10px');

  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => stageVar('--r')).toBe('2px');

  // A half-typed message in the Console underneath. Applying a theme changes
  // presentation; presentation changing is not a reason to lose it.
  const composer = page.getByRole('textbox', { name: 'Message this thread' });
  await composer.fill(DRAFT);
  await expect(composer).toHaveValue(DRAFT);
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__designConsole =
      document.querySelector('.console');
  });

  await page.screenshot({ path: `${SHOTS}/03-radius-edited-app-unchanged.png`, fullPage: true });

  // The claim stated literally: editing and undoing in the Studio wrote no
  // settings at all. The pointer still names revision 1, the saved theme.
  const before = await request.get('/api/settings', { headers: HEADERS });
  expect(before.ok()).toBe(true);
  const settingsBefore = (await before.json()) as {
    appearance: { activeTheme: { id: string; revision: number } | null };
  };
  expect(settingsBefore.appearance.activeTheme).toEqual({ id: THEME_ID, revision: 1 });

  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  // The document now carries the edited value — the C06 assertion shape.
  await expect.poll(async () => rootVar(page, '--r')).toBe('2px');
  await expect(page.locator('html')).toHaveAttribute('data-theme-pack', THEME_ID);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>).__designConsole ===
        document.querySelector('.console'),
    ),
    'Applying from the Design Center must not remount the Console',
  ).toBe(true);
  await expect(composer).toHaveValue(DRAFT);

  // The applied theme is the one that was just saved, and its history grew
  // rather than being rewritten.
  const read = await request.get(`/api/themes/${THEME_ID}`, { headers: HEADERS });
  expect(read.ok()).toBe(true);
  const stored = (await read.json()) as { pack: { geometry: { controlRadius: number } }; revisions: number[] };
  expect(stored.pack.geometry.controlRadius).toBe(2);
  expect(stored.revisions).toEqual([1, 2]);
});

test('D06: the Website target reports compatibility and how to start the studio', async ({
  page,
}) => {
  await openDesignCenter(page);
  await page.getByRole('button', { name: 'Website', exact: true }).click();

  // This pack declares only app-console, so the website panel says so plainly
  // rather than offering an export that would be refused there.
  await expect(page.getByText('This theme was not built for the website.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export for website' })).toBeVisible();

  // Nothing is listening on 4400 in the test host, so the start instructions
  // show. No network was reached: the probe is loopback with a one-second cap.
  await expect(page.getByText('Start Website Studio')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/04-website-target.png`, fullPage: true });
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.design-center')).toHaveCount(0);
});
