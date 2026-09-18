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
  const thread = await request.post(`/api/projects/${projectId}/threads`, {
    headers: HEADERS,
    data: { name: 'Studio thread' },
  });
  expect(thread.ok()).toBe(true);
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
});

test('D02: a person’s own interface size survives the theme, and reset restores the scheme', async ({
  page,
}) => {
  await openConsole(page);
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.themePack))
    .toBe(THEME_ID);

  // A size a theme cannot name. The personal layer outranks the theme, so it
  // must still be the size on the document.
  const scaled = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { appearance: { interfaceScale: 1.5 } },
  });
  expect(scaled.ok()).toBe(true);
  await expect.poll(async () => rootVar(page, '--dm-ui-scale')).toBe('1.5');
  await expect(page.locator('html')).toHaveAttribute('data-theme-pack', THEME_ID);

  const reset = await page.request.post('/api/themes/reset', { headers: HEADERS });
  expect(reset.ok()).toBe(true);
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.themePack ?? 'absent'))
    .toBe('absent');
  await expect(page.locator('html')).toHaveAttribute('data-package', 'field');
  expect(await rootVar(page, '--surface')).toBe('#16191d');
  // The size preference is still the person's after the theme is gone.
  expect(await rootVar(page, '--dm-ui-scale')).toBe('1.5');
  const restored = await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { appearance: { interfaceScale: 1 } },
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
