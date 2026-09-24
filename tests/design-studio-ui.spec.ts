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
import fsp from 'node:fs/promises';
import type { Project, Settings } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

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
    data: { openProjects: [projectId] },
  });
  expect(opened.ok()).toBe(true);
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
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
  // The built-in package a new install starts on (server/store.ts). Nothing
  // earlier in the suite changes the shared service's package: field.spec.ts,
  // which does, sorts after this file.
  await expect(page.locator('html')).toHaveAttribute('data-package', 'nectovia');

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
  await expect(page.locator('html')).toHaveAttribute('data-package', 'nectovia');
  expect(await rootVar(page, '--surface')).toBe('#0d0d12');
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
  await expect(page.locator('html')).toHaveAttribute('data-package', 'nectovia');
  expect(await rootVar(page, '--surface')).toBe('#0d0d12');
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
    appearance: { activeTheme: { id: string; revision: number; scope?: string } | null };
  };
  // `toMatchObject`, not `toEqual`: an applied pointer also records the theme
  // storage scope it was written in, which is not what this claim is about.
  expect(settingsBefore.appearance.activeTheme).toMatchObject({ id: THEME_ID, revision: 1 });

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

// ---------------------------------------------------------------------------
// A4: pictures, and what must stay visible over them
// ---------------------------------------------------------------------------

/** The fixture PNG, as the file input receives it: 16×16, 232 bytes. */
const FIXTURE_PNG = 'shared/theme-pack/fixtures/bust-plate.png';
const FIXTURE_BYTES = 232;

test('D07: a picture is imported, placed, adjusted, applied, exported and read back', async ({
  page,
  request,
}, testInfo) => {
  await openDesignCenter(page);

  // Import. The file never leaves this computer: the input posts its bytes to
  // the local service, which reads the header and stores the original.
  await page.locator('[data-dc-artwork-input="bust"]').setInputFiles(FIXTURE_PNG);
  await expect(page.locator('[data-dc-artwork="bust"]')).toBeVisible();
  // The size shown is the one read from the bytes, not from the file name.
  await expect(page.locator('[data-dc-artwork-size="bust"]')).toContainText('16×16');

  // The picture is in the pack, which is what makes it survivable: A3's
  // placement controls were session-only precisely because it could not be.
  const painted = await page
    .locator('[data-dc-artwork-slot="bust"] .dm-artwork-slot')
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(painted).toContain('/api/themes/');
  expect(painted).toContain('/assets/');

  // Adjust: the opacity slider moves the picture in the preview and nowhere
  // else. The document is still wearing the applied theme.
  await page.getByRole('slider', { name: 'Portrait plate opacity' }).fill('0.4');
  await expect
    .poll(() =>
      page
        .locator('[data-dc-artwork-slot="bust"] .dm-artwork-slot')
        .evaluate((element) => getComputedStyle(element).opacity),
    )
    .toBe('0.4');

  await page.screenshot({ path: `${SHOTS}/05-picture-placed.png`, fullPage: true });

  // Apply. The theme with its picture becomes the app's appearance.
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  // Wait for the sentence the screen says when the save has landed. The theme
  // was already applied by D01, so `data-theme-pack` alone would be true before
  // this save finished and the read below would race it.
  await expect(page.locator('.dc-state')).toContainText('is applied.');
  await expect(page.locator('html')).toHaveAttribute('data-theme-pack', THEME_ID);
  const saved = await request.get(`/api/themes/${THEME_ID}`, { headers: HEADERS });
  expect(saved.ok()).toBe(true);
  const stored = (await saved.json()) as {
    pack: {
      artwork: Record<string, { assetHash: string; opacity: number }>;
      assets: Record<string, { width: number; height: number; bytes: number }>;
    };
  };
  expect(stored.pack.artwork.bust.opacity).toBe(0.4);
  const hash = stored.pack.artwork.bust.assetHash;
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  // The record in the pack is the one read from the bytes, and it is the only
  // asset: nothing else was dragged along.
  expect(Object.keys(stored.pack.assets)).toEqual([hash]);
  expect(stored.pack.assets[hash]).toMatchObject({ width: 16, height: 16, bytes: FIXTURE_BYTES });

  // The bytes come back from the service under their own name.
  const served = await request.get(`/api/themes/${THEME_ID}/assets/${hash}`);
  expect(served.ok()).toBe(true);
  expect(served.headers()['content-type']).toBe('image/png');
  expect((await served.body()).length).toBe(FIXTURE_BYTES);

  // Export: the file must carry the picture, or Import cannot read it back.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  const file = testInfo.outputPath('exported.diomedes-theme');
  await download.saveAs(file);
  const container = JSON.parse(await fsp.readFile(file, 'utf8')) as {
    manifest: { assetCount: number; totalAssetBytes: number };
    assets: Record<string, string>;
  };
  expect(container.manifest.assetCount).toBe(1);
  expect(container.manifest.totalAssetBytes).toBe(FIXTURE_BYTES);
  expect(Object.keys(container.assets)).toEqual([hash]);

  // Re-import the file this app just wrote. A round trip is a round trip: the
  // bytes go back on disk under this account before the pack is adopted.
  await page.locator('[data-dc-import="theme"]').setInputFiles(file);
  await expect(page.getByText('with its picture')).toBeVisible();
  await expect(page.locator('[data-dc-artwork-size="bust"]')).toContainText('16×16');
  await page.screenshot({ path: `${SHOTS}/06-picture-round-trip.png`, fullPage: true });
});

test('D08: a texture never covers an approval control’s label', async ({ page }) => {
  await openDesignCenter(page);

  // A texture over the whole stage, fully opaque, blended as harshly as the
  // contract allows: the worst case a theme is able to ask for.
  await page.locator('[data-dc-artwork-input="texture"]').setInputFiles(FIXTURE_PNG);
  await expect(page.locator('[data-dc-artwork="texture"]')).toBeVisible();
  await page.getByRole('slider', { name: 'Background texture opacity' }).fill('1');
  await page.getByLabel('Background texture blend').selectOption('multiply');

  const layer = page.locator('.dc-stage > .dm-texture-layer');
  await expect(layer).toHaveCount(1);
  // Decorative, and unreachable: hidden from assistive technology and taking no
  // pointer event, so it can neither be read out nor swallow a click.
  await expect(layer).toHaveAttribute('aria-hidden', 'true');
  expect(await layer.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
  expect(await layer.evaluate((element) => getComputedStyle(element).zIndex)).toBe('-1');

  const approval = page.locator('[data-dc-piece="notice"]');
  await expect(approval.getByRole('button', { name: 'Go ahead', exact: true })).toBeVisible();

  /**
   * The claim, hit-tested rather than inferred from a z-index.
   *
   * `elementFromPoint` skips anything with `pointer-events: none`, so the layer
   * is made clickable for the length of the check — otherwise this would pass
   * even if the texture were painted on top of everything. What is asserted is
   * paint order: with the layer taking events, the topmost element over the
   * middle of every control in the named regions is still that control.
   *
   * Taken as arguments rather than hard-coded, because the same claim has to
   * hold in two different stacking contexts: the preview stage, and the running
   * app after the theme is applied.
   */
  const hitTest = async (layerSelector: string, regions: string[]) =>
    page.evaluate(
      ({ layerSelector, regions }) => {
        const layer = document.querySelector(layerSelector) as HTMLElement | null;
        if (!layer) return [`there is no texture layer at ${layerSelector} to test`];
        const previous = layer.style.pointerEvents;
        layer.style.pointerEvents = 'auto';
        const problems: string[] = [];
        let tested = 0;
        try {
          for (const region of regions) {
            for (const host of document.querySelectorAll(region)) {
              for (const button of host.querySelectorAll('button')) {
                // `elementFromPoint` works in viewport coordinates and answers
                // with nothing at all for a point that is scrolled off screen,
                // so each control is brought into view before it is asked about.
                button.scrollIntoView({ block: 'center' });
                const box = button.getBoundingClientRect();
                if (box.width === 0 || box.height === 0) continue;
                tested += 1;
                const top = document.elementFromPoint(
                  box.x + box.width / 2,
                  box.y + box.height / 2,
                );
                if (!top || !button.contains(top))
                  problems.push(
                    `“${button.textContent?.trim()}” in ${region} is covered by <${
                      top?.tagName.toLowerCase() ?? 'nothing'
                    } class="${(top as HTMLElement | null)?.className ?? ''}">`,
                  );
              }
            }
          }
        } finally {
          layer.style.pointerEvents = previous;
        }
        // A run that hit-tested nothing would pass for the wrong reason.
        if (tested === 0) problems.push(`nothing was on screen to test in ${regions.join(', ')}`);
        return problems;
      },
      { layerSelector, regions },
    );

  // Both places a theme is asked to approve something: the permission notice
  // and the review card that keeps or undoes a change.
  const STAGE_APPROVALS = ['[data-dc-piece="notice"]', '[data-dc-piece="review-card"]'];
  await expect(
    page.locator('[data-dc-piece="review-card"]').getByRole('button', { name: 'Keep' }),
  ).toBeVisible();
  expect(
    await hitTest('.dc-stage > .dm-texture-layer', STAGE_APPROVALS),
    'A texture must never sit over a permission control',
  ).toEqual([]);

  // And with one of them focused, so the focus ring is on screen while the
  // same question is asked again.
  await approval.getByRole('button', { name: 'Go ahead', exact: true }).focus();
  expect(
    await hitTest('.dc-stage > .dm-texture-layer', STAGE_APPROVALS),
    'A texture must never sit over a permission control, focused or not',
  ).toEqual([]);

  await page.screenshot({ path: `${SHOTS}/07-texture-under-labels.png`, fullPage: true });

  // The same claim in the running app, whose texture layer is `.app`'s own
  // (client/App.tsx) and not the stage's. The theme is applied and the Design
  // Center closed, so what is hit-tested is the Console a person actually uses.
  // Every control in it is tested, which includes any approval the app is
  // showing: the Console is never made to hold a real pending approval, because
  // nothing in this spec may approve an action.
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.dc-state')).toContainText('is applied.');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.design-center')).toHaveCount(0);
  await expect(page.locator('.app > .dm-texture-layer')).toHaveCount(1);
  expect(
    await hitTest('.app > .dm-texture-layer', ['.console']),
    'A texture must never sit over a control in the running app',
  ).toEqual([]);
});

test('D09: every button state stays readable over the composited background', async ({ page }) => {
  await openDesignCenter(page);
  await page.locator('[data-dc-artwork-input="texture"]').setInputFiles(FIXTURE_PNG);
  await expect(page.locator('[data-dc-artwork="texture"]')).toBeVisible();
  await page.getByRole('slider', { name: 'Background texture opacity' }).fill('1');

  const measured = await page.evaluate(async () => {
    // sRGB relative luminance and contrast, WCAG 2.1 §1.4.3.
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (rgb: number[]) =>
      0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    const ratio = (a: number[], b: number[]) => {
      const [high, low] = luminance(a) >= luminance(b) ? [a, b] : [b, a];
      return (luminance(high) + 0.05) / (luminance(low) + 0.05);
    };
    const parse = (text: string): number[] => {
      const found = String(text).match(/[\d.]+/g);
      if (!found) return [0, 0, 0, 0];
      return [
        Number(found[0]),
        Number(found[1]),
        Number(found[2]),
        found[3] === undefined ? 1 : Number(found[3]),
      ];
    };
    /** Paint `over` onto `under` at `over`'s own alpha. */
    const composite = (under: number[], over: number[]) => {
      const alpha = over[3] === undefined ? 1 : over[3];
      return [0, 1, 2].map((i) => under[i] * (1 - alpha) + over[i] * alpha);
    };

    const stage = document.querySelector('.dc-stage') as HTMLElement;
    const layer = document.querySelector('.dc-stage > .dm-texture-layer') as HTMLElement;

    // A texture is not one colour, so the composite is measured against the
    // mean of the pixels actually painted. That is the honest single number,
    // and the report says so rather than implying a flat background.
    const url = getComputedStyle(layer).backgroundImage.replace(/^url\(["']?|["']?\)$/g, '');
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let at = 0; at < pixels.length; at += 4) {
      r += pixels[at];
      g += pixels[at + 1];
      b += pixels[at + 2];
      a += pixels[at + 3] / 255;
    }
    const count = pixels.length / 4;
    const layerOpacity = Number(getComputedStyle(layer).opacity);
    const texture = [r / count, g / count, b / count, (a / count) * layerOpacity];

    const surface = parse(getComputedStyle(stage).backgroundColor);
    const overTexture = composite(surface, texture);

    const rows: { state: string; ratio: number; exempt: boolean }[] = [];
    for (const element of document.querySelectorAll('[data-dc-piece="buttons"] button')) {
      const button = element as HTMLButtonElement;
      const style = getComputedStyle(button);
      // Surface, then the texture over it, then the button's own background at
      // whatever alpha it carries: what the label is actually read against.
      const background = composite(overTexture, parse(style.backgroundColor));
      // The text's own alpha counts too — a quiet label at 65% is not the
      // colour it names.
      const text = composite(background, parse(style.color));
      rows.push({
        state: (button.textContent ?? '').trim(),
        ratio: Math.round(ratio(text, background) * 100) / 100,
        exempt: button.disabled || button.getAttribute('aria-busy') === 'true',
      });
    }
    const round = (rgb: number[]) => rgb.map((value) => Math.round(value * 100) / 100);
    return {
      rows,
      surface: round(surface),
      texture: round(texture),
      composited: round(overTexture),
      layerOpacity,
    };
  });

  // Printed so the report quotes what was measured rather than a claim about it.
  console.log('D09 contrast over the composited background:', JSON.stringify(measured, null, 2));

  expect(measured.rows.length).toBeGreaterThan(5);
  const failing = measured.rows.filter((row) => !row.exempt && row.ratio < 4.5);
  expect(
    failing,
    `These button labels fall below 4.5:1 over the composited background: ${JSON.stringify(failing)}`,
  ).toEqual([]);
  // Disabled and busy controls are measured and reported but not asserted:
  // WCAG 1.4.3 exempts an inactive control, and this app deliberately dims one.
  await page.screenshot({ path: `${SHOTS}/08-contrast-over-texture.png`, fullPage: true });
});

test('D10: a file the app cannot read is refused with a sentence, not a stack trace', async ({
  page,
}, testInfo) => {
  await openDesignCenter(page);

  // An SVG named .png, so the picker offers it. The bytes are what is read.
  const svg = testInfo.outputPath('not-a-picture.png');
  await fsp.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8');
  // Scoped to the Pictures panel: the stage carries its own fixture alerts, and
  // the sentence that matters is the one beside the control that was used.
  const refusal = page.locator('[aria-label="Artwork"] [role="alert"]');
  await page.locator('[data-dc-artwork-input="logo"]').setInputFiles(svg);
  await expect(refusal).toContainText('SVG is not accepted in this release');
  await expect(page.locator('[data-dc-artwork-empty="logo"]')).toBeVisible();

  // A truncated PNG: a real signature and nothing behind it.
  const truncated = testInfo.outputPath('truncated.png');
  await fsp.writeFile(truncated, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await page.locator('[data-dc-artwork-input="logo"]').setInputFiles(truncated);
  await expect(refusal).toContainText('not a PNG, JPEG or WebP picture');
  await expect(page.locator('[data-dc-artwork-empty="logo"]')).toBeVisible();

  await page.screenshot({ path: `${SHOTS}/09-refused-picture.png`, fullPage: true });
});

test('D11: saving a copy under a new name takes the pictures with it', async ({
  page,
  request,
}) => {
  await openDesignCenter(page);
  await page.locator('[data-dc-artwork-input="bust"]').setInputFiles(FIXTURE_PNG);
  await expect(page.locator('[data-dc-artwork="bust"]')).toBeVisible();

  const COPY_ID = 'studio-proof-copy';
  await page.getByRole('button', { name: 'Save as new theme' }).click();
  await page.getByRole('textbox', { name: 'New theme name' }).fill('Studio proof copy');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // A copy whose pictures had been left behind would be refused by the save
  // with advice about a missing picture that nobody could act on.
  await expect(page.locator('.dc-state')).toContainText('Saved as');
  await expect(page.locator('[data-dc-problem]')).toHaveCount(0);

  // The picture is painted from the new theme, not still borrowed from the old.
  const painted = await page
    .locator('[data-dc-artwork-slot="bust"] .dm-artwork-slot')
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(painted).toContain(`/api/themes/${COPY_ID}/assets/`);

  const saved = await request.get(`/api/themes/${COPY_ID}`, { headers: HEADERS });
  expect(saved.ok(), await saved.text()).toBe(true);
  const stored = (await saved.json()) as {
    pack: { artwork: Record<string, { assetHash: string }>; assets: Record<string, unknown> };
  };
  const hash = stored.pack.artwork.bust.assetHash;
  expect(Object.keys(stored.pack.assets)).toEqual([hash]);

  // And the bytes really are under the new theme, not a record pointing at air.
  const served = await request.get(`/api/themes/${COPY_ID}/assets/${hash}`);
  expect(served.ok()).toBe(true);
  expect((await served.body()).length).toBe(FIXTURE_BYTES);
});

/**
 * A5: what the free, paid and designer profiles actually see.
 *
 * The dev server is launched on the `paid` fixture, which is why every test
 * above can save. These ask for a different named state per test with the
 * `X-Diomedes-Entitlement-Fixture` header, which the service honours only
 * because it was launched with `DIOMEDES_TEST_MODE=1` and a fixture profile
 * already named. Nothing a browser sends can reach the fixture table in an
 * ordinary build — `tests/customization-entitlement.test.ts` proves that.
 *
 * `openDesignCenter` applies a theme on the way in, which is itself a premium
 * mutation, so these open the Design Center on the entitled profile and let the
 * page's own request carry the profile under test.
 */
async function openStudioAs(page: Page, profile: string) {
  const entitled = { ...HEADERS, 'X-Diomedes-Entitlement-Fixture': 'paid' };
  // D01 normally leaves this theme behind. Made here when it has not, so these
  // three can also be run on their own without depending on run order.
  const existing = await page.request.get(`/api/themes/${THEME_ID}`, { headers: entitled });
  if (!existing.ok() || ((await existing.json()) as { pack: unknown }).pack === null) {
    const made = await page.request.put(`/api/themes/${THEME_ID}`, {
      headers: entitled,
      data: themePack(),
    });
    expect(made.ok(), await made.text()).toBe(true);
  }
  const applied = await page.request.post(`/api/themes/${THEME_ID}/activate`, {
    headers: entitled,
  });
  expect(applied.ok(), await applied.text()).toBe(true);
  await page.setExtraHTTPHeaders({ ...HEADERS, 'X-Diomedes-Entitlement-Fixture': profile });
  await openConsole(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Design Center', exact: true }).click();
  await page.getByRole('button', { name: 'Open Design Center' }).click();
  await expect(page.locator('.design-center')).toBeVisible();
  await expect(page.locator('.dc-stage')).toBeVisible();
}

test('D12: a free profile keeps the built-in schemes and is shown no premium control', async ({
  page,
}) => {
  await openStudioAs(page, 'free');
  const center = page.locator('.design-center');
  // The premium half is gone, and the screen says why rather than offering a
  // control that is about to be refused.
  await expect(center.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
  await expect(center.getByRole('button', { name: 'Save as new theme' })).toHaveCount(0);
  await expect(center.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-dc-customization="locked"]')).toContainText(
    /requires an active plan/i,
  );
  // The free half is untouched: the preview, Export, and every built-in scheme
  // still offered in Settings.
  await expect(center.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  await center.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.locator('.radio-list input[name="appearance"]').first()).toBeVisible();

  // And the service refuses the same save whatever the screen shows.
  const refused = await page.request.put(`/api/themes/${THEME_ID}`, {
    headers: { ...HEADERS, 'X-Diomedes-Entitlement-Fixture': 'free' },
    data: themePack(),
  });
  expect(refused.status()).toBe(403);
});

test('D13: the entitled profile saves and applies, with no authoring badge', async ({ page }) => {
  await openStudioAs(page, 'paid');
  const center = page.locator('.design-center');
  await expect(page.locator('[data-dc-customization="locked"]')).toHaveCount(0);
  await expect(page.locator('[data-dc-authoring="on"]')).toHaveCount(0);
  await center.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(center.locator('.dc-state')).toContainText(/applied/i);
});

test('D14: design authoring shows a badge and grants the local scope', async ({ page }) => {
  await openStudioAs(page, 'designer');
  const badge = page.locator('[data-dc-authoring="on"]');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(/when the app was launched/i);
  await expect(badge).toContainText(/no agent any authority/i);
  // It is a grant, not a hidden bypass: the premium controls are there, and the
  // Developer section states it read-only with no switch beside it.
  await expect(
    page.locator('.design-center').getByRole('button', { name: 'Apply', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-dc-customization="locked"]')).toHaveCount(0);
  await page.locator('.design-center').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Developer', exact: true }).click();
  await expect(page.locator('[data-design-authoring="on"]')).toContainText('set at launch');
});

test('D15: an edit made before the plan answers is autosaved once it does', async ({
  page,
  request,
}) => {
  // The entitlement status arrives one round trip after the screen does, and
  // until it has, the session may not write a draft. The edits made in that
  // window must be waiting for the answer, not thrown away: the autosave delay
  // is 900ms and a person can easily move a slider inside it.
  let answer = () => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route('**/api/design-center/entitlement', async (route) => {
    await held;
    await route.continue();
  });

  // Start with no draft, so anything found afterwards was written by this test.
  const cleared = await request.delete(`/api/themes/${THEME_ID}/draft`, { headers: HEADERS });
  expect(cleared.ok(), await cleared.text()).toBe(true);

  await openDesignCenter(page);
  await page.getByRole('slider', { name: 'Control radius' }).fill('7');
  await expect(page.locator('.dc-state')).toContainText(/Editing/);

  // Well past the autosave delay. With no answer yet nothing may be sent, and
  // the service has nothing.
  await page.waitForTimeout(2_000);
  const early = await request.get(`/api/themes/${THEME_ID}`, { headers: HEADERS });
  expect(((await early.json()) as { draft: unknown }).draft ?? null).toBeNull();

  answer();
  await expect(page.locator('.dc-state')).toContainText(/Draft saved/, { timeout: 15_000 });
  const after = await request.get(`/api/themes/${THEME_ID}`, { headers: HEADERS });
  const stored = (await after.json()) as {
    draft: { pack: { geometry: { controlRadius: number } } } | null;
  };
  expect(stored.draft?.pack.geometry.controlRadius).toBe(7);

  await page.unroute('**/api/design-center/entitlement');
  // The draft is the test's litter: the next reader of this theme would open on
  // it rather than on the saved pack.
  expect((await request.delete(`/api/themes/${THEME_ID}/draft`, { headers: HEADERS })).ok()).toBe(
    true,
  );
  await page.locator('.design-center').getByRole('button', { name: 'Close', exact: true }).click();
});

/**
 * A theme applied in another workspace must read as the built-in package here.
 *
 * The applied-theme pointer is one field in one global settings file while
 * themes are stored per workspace, so a pointer written elsewhere survives a
 * switch and names a theme this scope cannot read. The service answers the
 * built-in package for it; every screen must say the same thing, or Settings
 * claims a theme is applied over a built-in paint, shows no scheme selected,
 * and offers to put away a theme that belongs somewhere else.
 *
 * The foreign scope is written directly rather than by creating a business and
 * switching into it: the stranded pointer *is* the state under test, and
 * `tests/themes.test.ts` proves the real switch produces exactly this shape
 * without a browser. The scope here is a well-formed key this install never
 * derives, which is what another workspace's key is from this one's point of
 * view.
 */
test('D16: a theme applied in another workspace reads as the built-in package', async ({
  page,
  request,
}) => {
  const applied = await request.post(`/api/themes/${THEME_ID}/activate`, { headers: HEADERS });
  expect(applied.ok(), await applied.text()).toBe(true);
  const home = (await (await request.get('/api/settings', { headers: HEADERS })).json()) as Settings;
  const pointer = home.appearance.activeTheme;
  expect(pointer, 'the theme must be applied before it can be stranded').toBeTruthy();

  const foreign = await request.put('/api/settings', {
    headers: HEADERS,
    data: {
      appearance: {
        activeTheme: { id: pointer!.id, revision: pointer!.revision, scope: 'personal-abcdef0123456789' },
      },
    },
  });
  expect(foreign.ok(), await foreign.text()).toBe(true);

  await openConsole(page);
  // Nothing of the theme is on the document: this workspace has no theme.
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.themePack ?? null))
    .toBe(null);

  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Design Center', exact: true }).click();
  const card = page.locator('.service').filter({ hasText: 'Appearance' }).first();
  await expect(card).toContainText('Built-in package');
  await expect(card).not.toContainText('Theme applied');
  await expect(card.getByRole('button', { name: 'Use the built-in package' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByText('A theme from the Design Center is applied.')).toHaveCount(0);
  // Appearance also holds the Console's View choice, so every check here is
  // scoped to the package radios (name="appearance").
  // Exactly one scheme is selected, and it is the package that is painting.
  await expect(page.locator('.radio-list input[name="appearance"]:checked')).toHaveCount(1);
  const painting = await page.evaluate(() => document.documentElement.dataset.package);
  await expect(page.locator('.radio-list .radio-row.selected:has(input[name="appearance"])')).toHaveCount(1);

  // Picking a scheme here must not reach into the workspace the theme belongs
  // to. The client does not send the reset, and the service would refuse to act
  // on it if it did.
  const other = page.locator('.radio-list .radio-row:not(.selected) input[name="appearance"]').first();
  await other.click();
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.package))
    .not.toBe(painting);
  const after = (await (await request.get('/api/settings', { headers: HEADERS })).json()) as Settings;
  expect(after.appearance.activeTheme).toMatchObject({
    id: THEME_ID,
    scope: 'personal-abcdef0123456789',
  });

  // And back where it was applied, it is applied again, with the screen saying so.
  const back = await request.put('/api/settings', {
    headers: HEADERS,
    data: { appearance: { activeTheme: { id: pointer!.id, revision: pointer!.revision } } },
  });
  expect(back.ok(), await back.text()).toBe(true);
  await openConsole(page);
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.themePack ?? null))
    .toBe(THEME_ID);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByText('A theme from the Design Center is applied.')).toBeVisible();
  await expect(page.locator('.radio-list input[name="appearance"]:checked')).toHaveCount(0);
});

/**
 * A pointer of this workspace's own that nothing can be read through must keep
 * the way back.
 *
 * Whether a pack was read and whether the pointer is this workspace's are two
 * different questions, and the difference is a person who cannot get out: the
 * theme paints nothing, the notice bar returns on every launch, and if the
 * control that clears the pointer were gated on the pack there would be no
 * remedy inside the app at all. The screen reads `applies` from
 * `GET /api/themes/active`, never the notice — `client/App.tsx` writes a notice
 * of its own when the fetch fails, and a server hiccup must not be able to
 * clear a good pointer.
 */
test('D17: a theme that cannot be read is still one this workspace can put away', async ({
  page,
  request,
}) => {
  // This scope's own pointer — no scope field, id never stored — so nothing can
  // be read through it and it is unmistakably this workspace's to clear.
  const pointed = await request.put('/api/settings', {
    headers: HEADERS,
    data: { appearance: { activeTheme: { id: 'gone-for-good', revision: 1 } } },
  });
  expect(pointed.ok(), await pointed.text()).toBe(true);
  const answer = await request.get('/api/themes/active', { headers: HEADERS });
  expect(await answer.json()).toMatchObject({ pack: null, source: 'none', applies: true });

  await openConsole(page);
  await expect(page.locator('.appearance-notice')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Design Center', exact: true }).click();
  const card = page.locator('.service').filter({ hasText: 'Appearance' }).first();
  await expect(card).toContainText('could not be read');
  const back = card.getByRole('button', { name: 'Use the built-in package' });
  await expect(back).toBeVisible();

  // The scheme radio sends the reset for this pointer too, so either way out
  // works. Proven on the control that exists for it.
  await back.click();
  await expect
    .poll(async () => {
      const settings = (await (
        await request.get('/api/settings', { headers: HEADERS })
      ).json()) as Settings;
      return settings.appearance.activeTheme ?? null;
    })
    .toBe(null);
  await expect(page.locator('.appearance-notice')).toHaveCount(0);
  await expect(card).toContainText('Built-in package');
});
