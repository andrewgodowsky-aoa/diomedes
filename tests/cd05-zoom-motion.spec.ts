import { test, expect, type Page } from '@playwright/test';
import type { Project, Settings } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

// CD-05's two open acceptance legs, executed (docs/implementation/
// 2026-09-24-cd05-zoom-motion-polish.md):
//
// C47, 200 percent zoom. Chromium's page zoom is a CSS viewport of half the
// window at twice the device pixel ratio, so a 1440 x 900 window at 200 percent
// is a 720 x 450 viewport at deviceScaleFactor 2; the desktop's minimum window
// (800 x 600, desktop/main.mjs) at 200 percent is 400 x 300. The Diomedes page,
// a project thread, its work inspector, Settings > Engines and the Board are
// held to: no sideways page scroll, no control outside the viewport or under
// another box once scrolled to, every primary action reachable by Tab with a
// visible focus ring, and a long project name truncated or wrapped where it is
// written (decision 5).
//
// C49, reduced motion. With `prefers-reduced-motion: reduce` emulated, and
// separately with the app's own Reduced setting, nothing in the Console
// animates or transitions: every element and pseudo-element's computed
// animation and transition is none or zero, and no Web Animation (the Nectovia
// seam, the composer's spring, the travelling point) is running.
//
// The accessibility sweep of the same screens rides along: focus returns to
// what opened a dialog or a menu, icon-only controls are named, and body text
// meets 4.5:1 (large text 3:1) in the dark Nectovia and the light Paper scheme.
const headers = { 'X-Diomedes-Client': '1' };
const LONG = 'Supplier-zoom-' + 'longprojectname'.repeat(5);
const TASK = 'Compare the last four deliveries against ' + 'purchase-order-'.repeat(4) + 'records';
let saved: Settings;
let project: Project;
let pageErrors: string[] = [];

test.beforeAll(async ({ request }) => {
  saved = await (await request.get('/api/settings')).json();
  // A retry runs this again against the same server; the project is kept.
  const projects = (await (await request.get('/api/projects')).json()).projects as Project[];
  const existing = projects.find((p) => p.name === LONG);
  if (existing) {
    project = existing;
    return;
  }
  const created = await request.post('/api/projects', { headers, data: { name: LONG } });
  expect(created.ok(), await created.text()).toBe(true);
  project = await created.json();
  const thread = await request.post(`/api/projects/${project.id}/ask`, {
    headers,
    data: { text: 'Review the supplier documents and outline the next steps.', mode: 'ask', route: 'sample' },
  });
  expect(thread.ok()).toBe(true);
  const task = await request.post(`/api/projects/${project.id}/tasks`, { headers, data: { name: TASK } });
  expect(task.ok()).toBe(true);
});
test.afterAll(async ({ request }) => {
  expect((await request.put('/api/settings', { headers, data: saved })).ok()).toBe(true);
});
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors, 'the interface must not throw').toEqual([]);
});

async function settle(page: Page, packageId = 'nectovia', motion: 'normal' | 'reduced' = 'normal') {
  const put = await page.request.put('/api/settings', {
    headers,
    data: {
      onboarding: { ...saved.onboarding, resumeAt: 'done' },
      openProjects: [project.id],
      appearance: { ...saved.appearance, package: packageId, motion },
    },
  });
  expect(put.ok()).toBe(true);
}

/** The Diomedes page: where a launch opens. */
async function openHome(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Nectovia' })).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
}
/** The project, on the thread of its task, so the ledger is that work's inspector. */
async function openInspector(page: Page) {
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('#scrThread')).toBeVisible();
  await rail(page).getByRole('button', { name: /^Board\b/ }).click();
  await page.locator('.console .crow .t', { hasText: TASK }).click();
  await expect(page.locator('#scrThread .ledger .focus')).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
}
async function openBoard(page: Page) {
  await rail(page).getByRole('button', { name: /^Board\b/ }).click();
  await expect(page.getByRole('region', { name: 'Board' })).toBeVisible();
}
async function openEngines(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Engines', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Engines', exact: true, level: 1 })).toBeVisible();
}
const rail = (page: Page) => page.getByRole('navigation', { name: 'Threads and views' });

// ---------------------------------------------------------------------------
// C47 checks

/** No sideways page scroll, and nothing that paints past its own box. */
async function noSidewaysScroll(page: Page, where: string) {
  const found = await page.evaluate(() => {
    const d = document.documentElement;
    const spill = [...document.querySelectorAll<HTMLElement>('body *')].flatMap((el) => {
      const s = getComputedStyle(el);
      if (!el.getClientRects().length || s.visibility === 'hidden' || !el.clientWidth) return [];
      // Decoration (the spine's point and its seam) may overhang; it never scrolls anything.
      if (el.closest('[aria-hidden="true"]')) return [];
      if (s.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 2)
        return [`${el.tagName.toLowerCase()}.${el.className}: ${el.scrollWidth} > ${el.clientWidth}`];
      return [];
    });
    return { page: d.scrollWidth - d.clientWidth, body: document.body.scrollWidth - document.body.clientWidth, spill };
  });
  expect(found.page, `${where}: page scrolls sideways`).toBeLessThanOrEqual(1);
  expect(found.body, `${where}: body scrolls sideways`).toBeLessThanOrEqual(1);
  expect(found.spill, `${where}: boxes painting past their width`).toEqual([]);
}

/**
 * Every visible control, once scrolled to the way a keyboard or a person
 * would, sits inside the viewport and is the thing under its own centre, and
 * a control whose text does not fit says so with an ellipsis rather than
 * cutting it off.
 */
async function controlsReachable(page: Page, where: string) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const selector =
      'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=radio], [tabindex="0"]';
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (!el.getClientRects().length) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.pointerEvents === 'none') continue;
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const name = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`;
      if (r.left < -1 || r.right > innerWidth + 1) {
        out.push(`${name} outside the viewport: ${Math.round(r.left)}..${Math.round(r.right)} of ${innerWidth}`);
        continue;
      }
      const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !(el as HTMLInputElement).labels?.[0]?.contains(hit))
        out.push(`${name} covered by ${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 40)}`);
      const clipsText = s.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1;
      const hasOwnTextOverflow = [el, ...el.querySelectorAll<HTMLElement>('*')].some(
        (node) => getComputedStyle(node).textOverflow === 'ellipsis',
      );
      if (clipsText && !hasOwnTextOverflow && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
        out.push(`${name} clips its text without an ellipsis`);
    }
    document.querySelectorAll('.console .stage').forEach((stage) => (stage.scrollTop = 0));
    return out;
  });
  expect(problems, `${where}: controls clipped, covered or out of reach`).toEqual([]);
}

/** Decision 5: the long project name is truncated or wrapped wherever it is written. */
async function machineStringsBounded(page: Page, where: string, needle: string) {
  const problems = await page.evaluate((text) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (!el.getClientRects().length) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes(text.slice(0, 24)));
      if (!own) continue;
      const s = getComputedStyle(el);
      // A child of a box that clips with an ellipsis is that box's to bound.
      let clipper: Element | null = el.parentElement;
      while (clipper && getComputedStyle(clipper).textOverflow !== 'ellipsis') clipper = clipper.parentElement;
      const bound = (clipper ?? el).getBoundingClientRect();
      if (bound.right > innerWidth + 1) out.push(`${el.tagName.toLowerCase()}.${el.className} runs past the viewport`);
      if (clipper) continue;
      if (el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis' && s.overflowWrap !== 'anywhere' && s.wordBreak !== 'break-all')
        out.push(`${el.tagName.toLowerCase()}.${el.className} neither truncates nor wraps`);
    }
    return out;
  }, needle);
  expect(problems, `${where}: machine strings without a policy`).toEqual([]);
}

/**
 * Tab from the top of the page and collect where focus lands. Every stop is
 * inside the viewport and draws a visible ring (its own outline or shadow, or
 * the composer's box for its textarea); the names found are returned so the
 * caller can require its screen's primary actions.
 */
async function tabWalk(page: Page, where: string, stops = 80) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const names: string[] = [];
  const problems: string[] = [];
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const name = (el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const r = el.getBoundingClientRect();
      const inView = r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1;
      const ringOf = (node: Element) => {
        const s = getComputedStyle(node);
        return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
      };
      const box = el.closest('.composer');
      // The composer's textarea draws no outline of its own: the box it sits in
      // takes the lead colour on its edge while it has focus.
      const ring =
        ringOf(el) ||
        (box !== null && box.matches(':focus-within') && parseFloat(getComputedStyle(box).borderTopWidth) > 0);
      // A stop inside the thread's work inspector is recorded as such too.
      const inspector = el.closest('#scrThread .ledger') !== null;
      return { name, inView, ring, inspector, tag: el.tagName.toLowerCase() };
    });
    if (!stop) continue;
    names.push(stop.name);
    if (stop.inspector) names.push('[the work inspector]');
    if (!stop.inView) problems.push(`${stop.tag} "${stop.name.slice(0, 40)}" focused outside the viewport`);
    if (!stop.ring) problems.push(`${stop.tag} "${stop.name.slice(0, 40)}" focused with no visible ring`);
  }
  expect(problems, `${where}: keyboard focus`).toEqual([]);
  return names;
}
function requireReached(names: string[], where: string, wanted: (string | RegExp)[]) {
  for (const want of wanted)
    expect(
      names.some((n) => (typeof want === 'string' ? n === want : want.test(n))),
      `${where}: "${want}" is never reached by Tab (reached: ${[...new Set(names)].join(' | ')})`,
    ).toBe(true);
}

/** Let the view's entrance finish: a shear caught mid-flight is not the layout. */
async function rest(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity),
  );
}

async function holdsAt200(page: Page, where: string) {
  await rest(page);
  await noSidewaysScroll(page, where);
  await controlsReachable(page, where);
  await machineStringsBounded(page, where, LONG);
}

for (const [label, width, height] of [
  ['a 1440 x 900 window', 720, 450],
  ['the 800 x 600 minimum window', 400, 300],
] as const) {
  test.describe(`C47: ${label} at 200 percent zoom`, () => {
    test.use({ viewport: { width, height }, deviceScaleFactor: 2 });

    test('the Diomedes page, the thread and its work inspector', async ({ page }) => {
      await settle(page);
      await openHome(page);
      await holdsAt200(page, 'Diomedes page');
      requireReached(await tabWalk(page, 'Diomedes page'), 'Diomedes page', [
        'Message Nectovia',
        'Send',
        'Settings',
      ]);

      await openInspector(page);
      await holdsAt200(page, 'thread and inspector');
      // The inspector is on the page, not hidden by the narrow layout.
      await page.locator('#scrThread .ledger .focus').scrollIntoViewIfNeeded();
      await expect(page.locator('#scrThread .ledger .focus')).toBeInViewport();
      const names = await tabWalk(page, 'thread and inspector', 60);
      requireReached(names, 'thread and inspector', ['Message this thread', 'Send', '[the work inspector]']);
    });

    test('Settings > Engines and the Board', async ({ page }) => {
      await settle(page);
      await page.goto('/');
      await reopenLastProject(page);
      await openBoard(page);
      await holdsAt200(page, 'Board');
      requireReached(await tabWalk(page, 'Board', 40), 'Board', ['New task', /^Compare the last four/]);

      await openEngines(page);
      await holdsAt200(page, 'Settings > Engines');
      const names = await tabWalk(page, 'Settings > Engines', 40);
      requireReached(names, 'Settings > Engines', ['Engines', 'Appearance']);
    });

    test('the screens landed alongside: Automations, Settings > Permissions and Rules', async ({ page }) => {
      await settle(page);
      await page.goto('/');
      await reopenLastProject(page);
      await page.getByRole('button', { name: 'Everything', exact: true }).click();
      await page.getByRole('menuitem', { name: /^Automations\b/ }).click();
      await expect(
        page.getByRole('region', { name: 'Automations' }).getByRole('heading', { name: 'Automations', level: 1 }),
      ).toBeVisible();
      await holdsAt200(page, 'Automations');
      await tabWalk(page, 'Automations', 40);

      await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      for (const section of ['Permissions', 'Rules']) {
        await page
          .getByRole('navigation', { name: 'Settings', exact: true })
          .getByRole('button', { name: section, exact: true })
          .click();
        await expect(page.getByRole('heading', { name: section, exact: true, level: 1 })).toBeVisible();
        await holdsAt200(page, `Settings > ${section}`);
        await tabWalk(page, `Settings > ${section}`, 40);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// C49 checks

/** Every element and pseudo-element whose computed style would still move. */
async function moving(page: Page) {
  return page.evaluate(() => {
    const seconds = (list: string) => list.split(',').some((v) => parseFloat(v) > 0);
    const out: string[] = [];
    for (const el of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after'] as const) {
        const s = getComputedStyle(el, pseudo);
        if (pseudo && (s.content === 'none' || s.content === 'normal')) continue;
        const name = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}${pseudo ?? ''}`;
        if (s.animationName !== 'none' && seconds(s.animationDuration))
          out.push(`${name} animates ${s.animationName} ${s.animationDuration}`);
        if (s.transitionProperty !== 'none' && seconds(s.transitionDuration))
          out.push(`${name} transitions ${s.transitionProperty} ${s.transitionDuration}`);
      }
    }
    for (const animation of document.getAnimations())
      if (animation.playState === 'running')
        out.push(`running ${(animation as CSSAnimation).animationName ?? 'Web Animation'} on ${
          (animation.effect as KeyframeEffect | null)?.target?.className ?? '?'
        }`);
    return out;
  });
}

/** Everything the Console animates, driven once: views, modes, menus, the palette, Settings. */
async function driveTheConsole(page: Page, check: (where: string) => Promise<void>) {
  await openHome(page);
  await check('Diomedes page');
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('#scrThread')).toBeVisible();
  await rail(page).getByRole('button', { name: /^Review the supplier documents/ }).click();
  await expect(page.getByRole('radio', { name: 'plan', exact: true })).toBeVisible();
  await check('thread');
  await page.getByRole('radio', { name: 'plan', exact: true }).click();
  await check('composer mode change');
  await page.getByRole('radio', { name: 'ask', exact: true }).click();
  for (const view of ['Board', 'Team', 'Thread']) {
    // A thread's row can start with "Thread for"; the view is the other one.
    await rail(page).getByRole('button', { name: new RegExp(`^${view}\\b(?! for)`) }).click();
    await check(`${view} view`);
  }
  await page.locator('.style-picker > button').click();
  await expect(page.getByRole('menu')).toBeVisible();
  await check('style menu');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Find and act' })).toBeVisible();
  await check('palette');
  await page.keyboard.press('Escape');
  await openEngines(page);
  await check('Settings > Engines');
}

test.describe('C49: reduced motion', () => {
  test('with normal motion the Console does move, so the stillness checks can fail', async ({ page }) => {
    await settle(page);
    await openHome(page);
    await page.goto('/');
    await reopenLastProject(page);
    await expect(page.locator('#scrThread')).toBeVisible();
    expect((await moving(page)).length).toBeGreaterThan(0);
  });

  test('prefers-reduced-motion: nothing animates or transitions, anywhere it is driven', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await settle(page);
    await driveTheConsole(page, async (where) => expect(await moving(page), where).toEqual([]));
  });

  test('the app’s own Reduced setting stills it the same way, with the OS asking for motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await settle(page, 'nectovia', 'reduced');
    await driveTheConsole(page, async (where) => {
      await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
      expect(await moving(page), where).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// accessibility sweep of the same screens

/** Controls a screen reader would announce with no name at all. */
async function unnamedControls(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, a[href], [role=button], [role=menuitem], [role=tab], input, select, textarea')]
      .filter((el) => el.getClientRects().length && !el.closest('[aria-hidden="true"]'))
      .filter((el) => {
        const text = (el.textContent ?? '').trim();
        const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title');
        const forms = (el as HTMLInputElement).labels?.length || el.getAttribute('placeholder');
        return !text && !labelled && !forms;
      })
      .map((el) => el.outerHTML.slice(0, 160)),
  );
}

/**
 * Text contrast against the painted ground under it. Colours are resolved by
 * painting them, so color-mix() and oklab() values compare like any other;
 * the ground is the nearest opaque background-color up the tree with the
 * translucent ones blended over it (background images, the Nectovia plates and
 * the art, are not a text ground and are not counted).
 */
async function lowContrast(page: Page) {
  // An entrance fades the screen in; measure the page at rest.
  await rest(page);
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (color: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 0 ? [0, 0, 0, 0] : [r / (a / 255), g / (a / 255), b / (a / 255), a / 255];
    };
    const over = (top: number[], under: number[]) => top.slice(0, 3).map((c, i) => c * top[3] + under[i] * (1 - top[3]));
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const groundOf = (el: Element) => {
      const layers: number[][] = [];
      for (let node: Element | null = el; node; node = node.parentElement) {
        const c = rgba(getComputedStyle(node).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      let ground = [0, 0, 0];
      for (const layer of layers.reverse()) ground = over(layer, ground);
      return ground;
    };
    const out: string[] = [];
    const seen = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>('.console *, .settings-layout *')) {
      const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
      if (!text || !el.getClientRects().length) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || el.closest('[aria-hidden="true"], :disabled, [aria-disabled="true"]')) continue;
      let opacity = 1;
      for (let node: Element | null = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      if (opacity < 0.05) continue;
      const ground = groundOf(el);
      const fg = rgba(s.color);
      const ink = over([...fg.slice(0, 3), fg[3] * opacity], ground);
      const [hi, lo] = [lum(ink), lum(ground)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(s.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      const floor = large ? 3 : 4.5;
      const key = `${s.color}|${ground.join(',')}|${el.className}`;
      if (ratio < floor && !seen.has(key)) {
        seen.add(key);
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} "${text.slice(0, 30)}" ${ratio.toFixed(2)}:1 < ${floor}`);
      }
    }
    return out;
  });
}

test.describe('accessibility sweep', () => {
  test('focus returns to what opened a dialog or a menu', async ({ page }) => {
    await settle(page);
    await page.goto('/');
    await reopenLastProject(page);
    await expect(page.locator('#scrThread')).toBeVisible();
    const openers = [
      { opener: page.getByRole('button', { name: 'Ctrl K', exact: true }), open: page.getByRole('dialog', { name: 'Find and act' }) },
      { opener: page.locator('.style-picker > button'), open: page.getByRole('menu') },
      { opener: page.getByRole('button', { name: 'Worker for this thread' }), open: page.getByRole('menu') },
      { opener: page.getByRole('button', { name: 'Interface detail menu' }), open: page.getByRole('menu') },
    ];
    for (const { opener, open } of openers) {
      await opener.focus();
      await page.keyboard.press('Enter');
      await expect(open).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(open).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
  });

  test('icon-only controls are named on every screen', async ({ page }) => {
    await settle(page);
    await openHome(page);
    expect(await unnamedControls(page), 'Diomedes page').toEqual([]);
    await openInspector(page);
    expect(await unnamedControls(page), 'thread and inspector').toEqual([]);
    await openBoard(page);
    expect(await unnamedControls(page), 'Board').toEqual([]);
    await openEngines(page);
    expect(await unnamedControls(page), 'Settings > Engines').toEqual([]);
  });

  for (const scheme of ['nectovia', 'paper']) {
    test(`text contrast holds in ${scheme === 'paper' ? 'the light Paper' : 'the dark Nectovia'} scheme`, async ({ page }) => {
      await settle(page, scheme);
      await openHome(page);
      expect(await lowContrast(page), `${scheme}: Diomedes page`).toEqual([]);
      await openInspector(page);
      expect(await lowContrast(page), `${scheme}: thread and inspector`).toEqual([]);
      await openBoard(page);
      expect(await lowContrast(page), `${scheme}: Board`).toEqual([]);
      await openEngines(page);
      expect(await lowContrast(page), `${scheme}: Settings > Engines`).toEqual([]);
    });
  }
});
