/**
 * A6: the manual acceptance pass, run by a machine so it can be run again.
 *
 * This file is deliberately **not** in `playwright.config.ts`'s `testMatch`. It
 * is not a regression suite: it records what a person would check by hand —
 * the acceptance walk, the accessibility conditions, the two refusals — and it
 * measures how the Design Center behaves on this machine. Machine timings and
 * CPU samples do not belong in a gate that has to pass on any host, and its
 * screenshots are evidence of one dated run rather than an assertion.
 *
 * Run it with its own config:
 *
 *     npx playwright test --config playwright.acceptance.config.ts
 *
 * Everything it writes lands in `docs/verification/2026-09-17-design-center/`,
 * numbered from 10 so A3's and A4's files (01-09) are left alone.
 *
 * What it does not do: it never starts work, never calls a provider and never
 * touches a real profile. The config launches its own service on a fresh data
 * directory, the way every other browser spec here does.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Project, Settings } from '../shared/types';

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const PROJECT_NAME = 'Acceptance walk';
const THEME_ID = 'acceptance-theme';
const DRAFT = 'A half-typed message the theme must not take away';
const SHOTS = 'docs/verification/2026-09-17-design-center';
/** Where the numbers go, so the report quotes a file rather than a memory. */
const MEASUREMENTS = path.join(SHOTS, 'measurements.json');

let projectId = '';
let originalSettings: Settings | null = null;
const recorded: Record<string, unknown> = {};

const themePack = (id = THEME_ID, name = 'Acceptance theme') => {
  const color = (value: string) => ({ $type: 'color', $value: value });
  return {
    schemaVersion: 1,
    id,
    name,
    revision: 1,
    baseTheme: 'graphite',
    surfaces: ['app-console'],
    provenance: { author: 'A6 acceptance', createdAt: '2026-09-17T00:00:00.000Z', tool: 'playwright' },
    tokens: {
      color: {
        chrome: color('#08121a'),
        surface: color('#0d1a24'),
        raised: color('#13232f'),
        hair: color('#ffffff12'),
        hair2: color('#ffffff1f'),
        t1: color('#eef7ff'),
        t2: color('#b4cada'),
        t3: color('#88a2b3'),
        light: color('#5fe0c8'),
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
    geometry: { controlRadius: 12, separatorStrength: 1, density: 'standard' },
    artwork: {},
    motion: { presetId: 'settle', duration: 160, intensity: 0.5, reducedMotionBehaviour: 'static' },
    assets: {},
  };
};

test.beforeAll(async ({ request }) => {
  const current = await request.get('/api/settings');
  expect(current.ok()).toBe(true);
  originalSettings = (await current.json()) as Settings;
  expect(
    (
      await request.put('/api/settings', {
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
      })
    ).ok(),
  ).toBe(true);
  const created = await request.post('/api/projects', {
    headers: HEADERS,
    data: { name: PROJECT_NAME },
  });
  expect(created.ok()).toBe(true);
  projectId = ((await created.json()) as Project).id;
  for (let index = 0; index < 12; index += 1)
    expect(
      (
        await request.post(`/api/projects/${projectId}/threads`, {
          headers: HEADERS,
          data: { name: `Acceptance thread ${index + 1}` },
        })
      ).ok(),
    ).toBe(true);
  expect(
    (await request.put('/api/settings', { headers: HEADERS, data: { openProjects: [projectId] } }))
      .ok(),
  ).toBe(true);
  // The walk starts from the theme this pass is about, saved and worn — the
  // Design Center opens on the applied theme, which is what step 1 checks.
  expect(
    (await request.put(`/api/themes/${THEME_ID}`, { headers: HEADERS, data: themePack() })).ok(),
  ).toBe(true);
  expect(
    (await request.post(`/api/themes/${THEME_ID}/activate`, { headers: HEADERS })).ok(),
  ).toBe(true);
});

test.afterAll(async ({ request }) => {
  await fsp.writeFile(MEASUREMENTS, `${JSON.stringify(recorded, null, 2)}\n`, 'utf8');
  expect((await request.post('/api/themes/reset', { headers: HEADERS })).ok()).toBe(true);
  if (originalSettings)
    expect(
      (
        await request.put('/api/settings', {
          headers: HEADERS,
          data: JSON.parse(JSON.stringify(originalSettings)),
        })
      ).ok(),
    ).toBe(true);
});

async function openConsole(page: Page) {
  expect(
    (
      await page.request.put('/api/settings', {
        headers: HEADERS,
        data: { surface: 'console', openProjects: [projectId] },
      })
    ).ok(),
  ).toBe(true);
  await page.goto('/');
  const root = page.locator('.console');
  const card = page.getByRole('button', { name: PROJECT_NAME }).first();
  await expect(root.or(card).first()).toBeVisible();
  if ((await root.count()) === 0) {
    await card.click();
    await expect(root).toBeVisible();
  }
}

/** Settings → Design Center → Open. Returns how long the stage took to paint. */
async function openDesignCenter(page: Page): Promise<number> {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Design Center', exact: true }).click();
  const started = Date.now();
  await page.getByRole('button', { name: 'Open Design Center' }).click();
  const stage = page.locator('.dc-stage');
  await expect(stage).toBeVisible();
  // Visible is not painted: wait until the stage is actually carrying the
  // theme's own values, which is the first thing a person sees.
  await expect
    .poll(() =>
      stage.evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--surface').trim(),
      ),
    )
    .not.toBe('');
  return Date.now() - started;
}

const stageVar = (page: Page, name: string) =>
  page
    .locator('.dc-stage')
    .evaluate(
      (element, property) => getComputedStyle(element).getPropertyValue(property).trim(),
      name,
    );

const rootVar = (page: Page, name: string) =>
  page.evaluate(
    (property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(),
    name,
  );

const shot = (page: Page, file: string) =>
  page.screenshot({ path: `${SHOTS}/${file}`, fullPage: true });

// ---------------------------------------------------------------------------
// Acceptance steps 1-7
// ---------------------------------------------------------------------------

test('A6-01 (step 1): the Design Center opens from Settings and shows the app as it is', async ({
  page,
}) => {
  await openConsole(page);
  const paint = await openDesignCenter(page);
  recorded.openToFirstPaintMs = paint;
  // One entry point, and it is inside the app rather than a separate program.
  await expect(page.locator('.design-center')).toBeVisible();
  await expect(page.locator('.dc-inspector')).toBeVisible();
  // The preview opens on the saved theme, not on a demo of something else.
  expect(await stageVar(page, '--r')).toBe('12px');
  await shot(page, '10-acceptance-open.png');
});

test('A6-02 (step 2): Design mode selects a real component and never runs it', async ({ page }) => {
  await openConsole(page);
  await openDesignCenter(page);
  const buttons = page.locator('[data-dc-piece="buttons"]');
  await expect(page.locator('[data-dc-log="empty"]')).toBeVisible();
  await buttons.getByRole('button', { name: 'Start work' }).click();
  await expect(buttons).toHaveClass(/selected/);
  // Nothing ran. No provider was called, no agent started, nothing was sent.
  expect(await page.locator('[data-dc-log="entries"] li').count()).toBe(0);
  await shot(page, '11-acceptance-select-without-running.png');
});

test('A6-03 (step 3): an edit changes the preview and leaves the app alone', async ({ page }) => {
  await openConsole(page);
  await openDesignCenter(page);
  const radius = page.getByRole('slider', { name: 'Control radius' });

  // Time per inspector change: the value a person is waiting on is the preview
  // catching up, so the clock stops when the stage reports the new number.
  const perChange: number[] = [];
  // The control's own range is 0-12; these are eight real moves inside it.
  for (const value of [2, 4, 6, 8, 10, 12, 1, 9]) {
    const started = Date.now();
    await radius.fill(String(value));
    await expect.poll(() => stageVar(page, '--r')).toBe(`${value}px`);
    perChange.push(Date.now() - started);
  }
  const sorted = [...perChange].sort((a, b) => a - b);
  recorded.inspectorChangeMs = {
    samples: perChange,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    maxMs: sorted[sorted.length - 1],
  };

  // The app underneath never moved.
  expect(await rootVar(page, '--r')).toBe('12px');
  await shot(page, '12-acceptance-edit-app-unchanged.png');

  await page.getByRole('button', { name: 'Reset theme' }).click();
  await expect.poll(() => stageVar(page, '--r')).toBe('12px');
});

test('A6-04 (step 4): Apply dresses the app without restarting it', async ({ page, request }) => {
  await openConsole(page);
  await openDesignCenter(page);
  // The Console is mounted underneath the Design Center. The half-typed message
  // and the element identity are both taken here, with the screen already open,
  // because opening Settings is itself a screen change and would prove nothing.
  const composer = page.getByRole('textbox', { name: 'Message this thread' });
  await composer.fill(DRAFT);
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__acceptanceConsole =
      document.querySelector('.console');
  });
  await page.getByRole('slider', { name: 'Control radius' }).fill('3');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();

  await expect.poll(() => rootVar(page, '--r')).toBe('3px');
  await expect(page.locator('html')).toHaveAttribute('data-theme-pack', THEME_ID);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>).__acceptanceConsole ===
        document.querySelector('.console'),
    ),
    'Applying must not remount the Console',
  ).toBe(true);
  await expect(composer).toHaveValue(DRAFT);
  await shot(page, '13-acceptance-applied.png');

  const stored = await request.get(`/api/themes/${THEME_ID}`, { headers: HEADERS });
  expect(((await stored.json()) as { revisions: number[] }).revisions).toContain(2);
});

test('A6-05 (step 5): a picture is placed and survives the round trip through a file', async ({
  page,
  request,
}, testInfo) => {
  await openConsole(page);
  await openDesignCenter(page);
  await page.locator('[data-dc-artwork-input="bust"]').setInputFiles(
    'shared/theme-pack/fixtures/bust-plate.png',
  );
  await expect(page.locator('[data-dc-artwork="bust"]')).toBeVisible();
  // The picture is in the pack: the app reports the asset it now holds.
  await expect
    .poll(async () => {
      const read = await request.get(`/api/themes/${THEME_ID}`, { headers: HEADERS });
      const body = (await read.json()) as {
        draft: { pack: { assets: Record<string, unknown> } } | null;
        pack: { assets: Record<string, unknown> } | null;
      };
      const pack = body.draft?.pack ?? body.pack;
      return Object.keys(pack?.assets ?? {}).length;
    }, { timeout: 20_000 })
    .toBeGreaterThan(0);
  await shot(page, '14-acceptance-picture-placed.png');

  // Out through the export, and back in through the import, unchanged.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await download;
  const saved = path.join(testInfo.outputDir, 'acceptance-round-trip.diomedes-theme');
  await file.saveAs(saved);
  const parsed = JSON.parse(await fsp.readFile(saved, 'utf8')) as {
    pack: { assets: Record<string, unknown> };
  };
  expect(Object.keys(parsed.pack.assets).length).toBeGreaterThan(0);
  recorded.exportedPackageBytes = (await fsp.stat(saved)).size;

  await page.locator('[data-dc-import="theme"]').setInputFiles(saved);
  await expect(page.locator('.dc-stage')).toBeVisible();
  await shot(page, '15-acceptance-picture-round-trip.png');
});

test('A6-06 (step 6): the Website target states compatibility and how to start the studio', async ({
  page,
}) => {
  await openConsole(page);
  await openDesignCenter(page);
  await page.getByRole('button', { name: 'Website', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export for website' })).toBeVisible();
  // Nothing is listening on 4400 here, so the honest answer and the plain
  // instructions are what a person sees.
  await expect(page.getByText('Start Website Studio')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  await shot(page, '16-acceptance-website-target.png');
});

test('A6-07 (step 7): an older version is restored, and the reset always works', async ({
  page,
  request,
}) => {
  await openConsole(page);
  await openDesignCenter(page);
  await page.getByRole('button', { name: 'Versions' }).click();
  await shot(page, '17-acceptance-versions.png');
  await page.keyboard.press('Escape');

  // The reset is free: no plan, no account, no network. It is the way back.
  const reset = await request.post('/api/themes/reset', { headers: HEADERS });
  expect(reset.ok()).toBe(true);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-pack', THEME_ID);
  // And the theme itself is still there to go back to.
  const list = await request.get('/api/themes', { headers: HEADERS });
  expect(((await list.json()) as { themes: { id: string }[] }).themes.map((t) => t.id)).toContain(
    THEME_ID,
  );
  await shot(page, '18-acceptance-after-reset.png');
});

// ---------------------------------------------------------------------------
// The conditions a person may be under
// ---------------------------------------------------------------------------

test('A6-08: a narrow window keeps every control reachable', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openConsole(page);
  await openDesignCenter(page);
  // Nothing may be pushed off the side: the page itself must not scroll across.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, 'The Design Center must not scroll sideways').toBeLessThanOrEqual(
    overflow.clientWidth + 1,
  );
  await expect(page.locator('.dc-inspector')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Control radius' })).toBeVisible();
  await shot(page, '19-narrow-window.png');
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('A6-09: large text scales the Design Center with the rest of the app', async ({
  page,
  request,
}) => {
  // The narrow patch the Ctrl+/Ctrl- handler uses, not a whole-settings write.
  expect(
    (await request.put('/api/settings', { headers: HEADERS, data: { appearance: { interfaceScale: 1.5 } } })).ok(),
  ).toBe(true);
  await openConsole(page);
  await openDesignCenter(page);
  await expect.poll(() => rootVar(page, '--dm-ui-scale')).toBe('1.5');
  recorded.largeTextScale = await rootVar(page, '--dm-ui-scale');
  await expect(page.getByRole('slider', { name: 'Control radius' })).toBeVisible();
  await shot(page, '20-large-text.png');
  expect(
    (await request.put('/api/settings', { headers: HEADERS, data: { appearance: { interfaceScale: 1 } } })).ok(),
  ).toBe(true);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('A6-10: the computer’s reduced-motion setting wins over the theme', async ({ page }) => {
    await openConsole(page);
    await openDesignCenter(page);
    expect(
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    ).toBe(true);
    // The person's own setting wins over the theme, in the app itself: the
    // media block in `client/styles.css` zeroes the durations at `:root` and
    // kills every animation and transition with `!important`.
    const appQuick = await rootVar(page, '--dm-t-quick');
    expect(appQuick, 'The app must freeze under the computer’s own setting').toBe('0ms');

    // The stage is a different question and is answered differently on purpose.
    // It shows the theme as *someone else* would see it, so it does not inherit
    // the designer's own setting; the designer asks for that reading with a
    // control, which is what makes it a preview rather than an accident.
    await expect(page.locator('.dc-stage')).toHaveAttribute('data-motion', 'normal');
    await page.getByText('Preview with reduced motion').click();
    await expect(page.locator('.dc-stage')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.locator('.dc-stage')).toHaveAttribute('data-motion-preset', 'none');
    const stageQuick = await stageVar(page, '--dm-t-quick');
    recorded.reducedMotion = {
      appQuickTransition: appQuick,
      stageBeforeToggle: 'normal',
      stageAfterToggle: 'reduced',
      stageQuickTransition: stageQuick,
    };
    await shot(page, '21-reduced-motion.png');
  });
});

// ---------------------------------------------------------------------------
// The two refusals
// ---------------------------------------------------------------------------

test('A6-11: a malformed package is refused with a sentence, and nothing is stored', async ({
  page,
  request,
}, testInfo) => {
  await openConsole(page);
  await openDesignCenter(page);
  const before = await request.get('/api/themes', { headers: HEADERS });
  const beforeIds = ((await before.json()) as { themes: { id: string }[] }).themes.map((t) => t.id);

  // Well-formed JSON in the right container, with a pack inside that is missing
  // everything. This is the file a person is most likely to be handed: not
  // obvious rubbish, just wrong, and the refusal has to be readable anyway.
  await fsp.mkdir(testInfo.outputDir, { recursive: true });
  const bad = path.join(testInfo.outputDir, 'malformed.diomedes-theme');
  await fsp.writeFile(
    bad,
    JSON.stringify({
      manifest: { format: 'diomedes-theme', formatVersion: 1 },
      pack: { schemaVersion: 1, id: 'half-a-theme' },
      assets: {},
    }),
    'utf8',
  );
  await page.locator('[data-dc-import="theme"]').setInputFiles(bad);
  const said = page.getByRole('alert').first();
  await expect(said).toBeVisible();
  const words = (await said.textContent()) ?? '';
  expect(words, 'A refusal is a sentence, not a stack trace').not.toMatch(/\bat \w+.*:\d+:\d+/);
  expect(words.trim().length).toBeGreaterThan(10);
  recorded.malformedPackageSaid = words.trim();
  await shot(page, '22-malformed-package.png');

  const after = await request.get('/api/themes', { headers: HEADERS });
  expect(((await after.json()) as { themes: { id: string }[] }).themes.map((t) => t.id)).toEqual(
    beforeIds,
  );
});

test('A6-12: a theme saved in one scope is not there in another', async ({ page, request }) => {
  // A business the same person owns is still a different place to keep things.
  const created = await request.post('/api/workspace/organizations', {
    headers: HEADERS,
    data: { name: 'Ridge Cabinetry', industry: null },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const organizationId = (
    (await created.json()) as { organizations: { organization: { id: string } }[] }
  ).organizations[0]!.organization.id;

  expect(
    (
      await request.post('/api/workspace/switch', {
        headers: HEADERS,
        data: { kind: 'business', organizationId },
      })
    ).ok(),
  ).toBe(true);
  const businessOnly = 'ridge-only';
  expect(
    (
      await request.put(`/api/themes/${businessOnly}`, {
        headers: HEADERS,
        data: themePack(businessOnly, 'Ridge only'),
      })
    ).ok(),
  ).toBe(true);

  // Back to Personal: the business theme is not missing-and-forbidden, it is
  // simply not in this place at all.
  expect(
    (await request.post('/api/workspace/switch', { headers: HEADERS, data: { kind: 'personal' } }))
      .ok(),
  ).toBe(true);
  expect((await request.get(`/api/themes/${businessOnly}`, { headers: HEADERS })).status()).toBe(404);
  const personal = await request.get('/api/themes', { headers: HEADERS });
  expect(
    ((await personal.json()) as { themes: { id: string }[] }).themes.map((t) => t.id),
  ).not.toContain(businessOnly);

  await openConsole(page);
  await openDesignCenter(page);
  await shot(page, '23-cross-scope-personal-list.png');
});

// ---------------------------------------------------------------------------
// What it costs to leave open
// ---------------------------------------------------------------------------

/**
 * One reading of every process in the browser's tree, taken from the operating
 * system rather than from inside the app. `process.memoryUsage` behind a dev
 * endpoint would be a measurement instrument shipped to customers; this is a
 * `Get-CimInstance` from the harness, and the app under test cannot tell.
 */
interface Reading {
  at: number;
  cpu100ns: number;
  workingSetBytes: number;
  processes: number;
}

function readTree(rootPid: number): Reading | null {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress -Depth 2',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) return null;
  let rows: {
    ProcessId: number;
    ParentProcessId: number;
    WorkingSetSize: number | string | null;
    KernelModeTime: number | string | null;
    UserModeTime: number | string | null;
  }[];
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ParentProcessId) ?? [];
    list.push(row.ProcessId);
    children.set(row.ParentProcessId, list);
  }
  const tree = new Set<number>();
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.pop()!;
    if (tree.has(pid)) continue;
    tree.add(pid);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  const number_ = (value: number | string | null) => (value === null ? 0 : Number(value));
  let cpu = 0;
  let working = 0;
  let counted = 0;
  for (const row of rows)
    if (tree.has(row.ProcessId)) {
      cpu += number_(row.KernelModeTime) + number_(row.UserModeTime);
      working += number_(row.WorkingSetSize);
      counted += 1;
    }
  return { at: Date.now(), cpu100ns: cpu, workingSetBytes: working, processes: counted };
}

/**
 * The browser this run launched, found by what launched it.
 *
 * `browser.process()` is not on the type the test fixture hands back, and the
 * pid matters more than the convenience: Playwright starts the browser with a
 * throwaway `--user-data-dir` under the temp folder and no `--type=`, which no
 * browser window a person opened for themselves ever has. Anything but exactly
 * one match is refused rather than guessed, so a stray window cannot be
 * measured and reported as the app.
 */
function browserRootPid(): number | undefined {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*--user-data-dir=*playwright*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -ExpandProperty ProcessId",
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) return undefined;
  const pids = result.stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  return pids.length === 1 ? pids[0] : undefined;
}

async function idleFor(page: Page, rootPid: number, seconds: number) {
  const first = readTree(rootPid);
  await page.waitForTimeout(seconds * 1000);
  const second = readTree(rootPid);
  if (!first || !second) return null;
  const wallMs = second.at - first.at;
  const cpuMs = (second.cpu100ns - first.cpu100ns) / 10_000;
  return {
    seconds: Number((wallMs / 1000).toFixed(1)),
    processes: second.processes,
    cpuPercentOfOneCore: Number(((cpuMs / wallMs) * 100).toFixed(2)),
    cpuPercentOfMachine: Number(((cpuMs / wallMs / os.cpus().length) * 100).toFixed(2)),
    workingSetMB: Number((second.workingSetBytes / (1024 * 1024)).toFixed(1)),
  };
}

test('A6-13: what the Design Center costs while it sits open', async ({ page }, testInfo: TestInfo) => {
  test.setTimeout(180_000);
  const rootPid = browserRootPid();
  if (rootPid === undefined) {
    recorded.idleCost = 'Not measured: the browser process was not local to this harness.';
    test.skip(true, 'No local browser process to sample.');
    return;
  }
  await openConsole(page);
  // Settle first: a page that just loaded is not idle.
  await page.waitForTimeout(5_000);
  const closed = await idleFor(page, rootPid, 20);
  await openDesignCenter(page);
  await page.waitForTimeout(5_000);
  const open = await idleFor(page, rootPid, 20);
  recorded.idleCost = {
    method:
      'Win32_Process sampled from the test harness over the browser process tree; two 20s windows after a 5s settle.',
    cores: os.cpus().length,
    rootPid,
    designCenterClosed: closed,
    designCenterOpen: open,
  };
  testInfo.attach('idle-cost.json', {
    body: JSON.stringify(recorded.idleCost, null, 2),
    contentType: 'application/json',
  });
  expect(closed, 'The closed-window sample must exist').not.toBeNull();
  expect(open, 'The open-window sample must exist').not.toBeNull();
});
