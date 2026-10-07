import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccountStateView } from '../shared/accounts';
import type { Project, Settings } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

// The reskin atlas (DIO-252): one screenshot of each screen, panel and dialog a person can reach,
// taken from the built app so each can be judged against the round 2 design. It asserts nothing
// about the look. A screen it cannot reach is shot as it stands, named with -missed, and listed in
// atlas-log.txt, so one changed label never costs the rest of the set.
//
// Runs only when RESKIN_ATLAS names the folder to write to:
//   RESKIN_ATLAS=<folder> npx playwright test --config playwright.atlas.config.ts

const OUT = process.env.RESKIN_ATLAS ?? '';
const HEADERS = { 'X-Diomedes-Client': '1' };
const missed: string[] = [];

test.skip(!OUT, 'Set RESKIN_ATLAS to the folder the atlas writes to.');
test.describe.configure({ mode: 'default' });

let saved: Settings;
let project: Project;

test.beforeAll(async ({ request }) => {
  if (!OUT) return;
  await fs.mkdir(OUT, { recursive: true });
  saved = (await (await request.get('/api/settings')).json()) as Settings;
  project = (await (await request.post('/api/projects/sample', { headers: HEADERS, data: {} })).json()) as Project;
  const asked = await request.post(`/api/projects/${project.id}/ask`, {
    headers: HEADERS,
    data: { text: 'Review the supplier plan and explain the next steps.', mode: 'ask', route: 'sample' },
  });
  expect(asked.ok(), await asked.text()).toBe(true);
  for (const [index, name] of ['Match the receiving note', 'Draft the linen order', 'File the invoices'].entries()) {
    const made = await request.post(`/api/projects/${project.id}/tasks`, { headers: HEADERS, data: { name } });
    expect(made.ok(), await made.text()).toBe(true);
    if (index === 0) {
      const id = ((await made.json()) as { id: string }).id;
      await request.put(`/api/projects/${project.id}/tasks/${id}`, { headers: HEADERS, data: { state: 'done' } });
    }
  }
  await settle(request, 'architect');
});

test.afterAll(async ({ request }) => {
  if (!OUT) return;
  await fs.writeFile(path.join(OUT, 'atlas-log.txt'), missed.length ? missed.join('\n') + '\n' : 'every screen reached\n');
  await request.put('/api/settings', { headers: HEADERS, data: JSON.parse(JSON.stringify(saved)) });
});

async function settle(request: import('@playwright/test').APIRequestContext, view: 'architect' | 'conversation') {
  const put = await request.put('/api/settings', {
    headers: HEADERS,
    data: {
      onboarding: { ...saved.onboarding, resumeAt: 'done', work: 'business', detail: 'technical', familiarity: 'comfortable' },
      detail: 'technical',
      view,
      openProjects: [project.id],
    },
  });
  expect(put.ok(), await put.text()).toBe(true);
}

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled', fullPage });
}

/** Reach a screen and shoot it. If the way there fails, shoot what is showing and note it. */
async function screen(page: Page, name: string, reach: () => Promise<void>, fullPage = false) {
  try {
    await reach();
    await shot(page, name, fullPage);
  } catch (error) {
    missed.push(`${name}: ${(error as Error).message.split('\n')[0]}`);
    await shot(page, `${name}-missed`, fullPage).catch(() => undefined);
  }
}

async function enter(page: Page) {
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'Threads and views' });

async function close(page: Page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

async function settings(page: Page, section: string | RegExp) {
  const nav = page.getByRole('navigation', { name: 'Settings', exact: true });
  // The strip's Settings button is a toggle: pressed again, it closes Settings.
  if (!(await nav.isVisible())) await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await nav.getByRole('button', { name: section }).click();
}

async function everything(page: Page, item: RegExp) {
  await page.getByRole('button', { name: 'Everything', exact: true }).first().click();
  await page.getByRole('menuitem', { name: item }).first().click();
}

test('Work view: the thread and every destination beside it', async ({ page }) => {
  test.setTimeout(240_000);
  await enter(page);
  await screen(page, 'work-01-thread', async () => {
    await expect(page.locator('#scrThread')).toBeVisible();
  });
  for (const [label, name] of [
    [/^Board\b/, 'work-02-board'],
    [/^Team\b/, 'work-03-team'],
    [/^Routines\b/, 'work-04-routines'],
  ] as const) {
    await screen(page, name, async () => {
      await rail(page).getByRole('button', { name: label }).first().click();
    });
  }
  await screen(page, 'work-05-files', async () => {
    await page.evaluate(() => localStorage.setItem('console.files.open', 'true'));
    await page.reload();
    await expect(page.getByRole('complementary', { name: 'Files', exact: true })).toBeVisible();
  });
  await page.evaluate(() => localStorage.removeItem('console.files.open'));
  await enter(page);
  await screen(page, 'work-06-everything', async () => {
    await page.getByRole('button', { name: 'Everything', exact: true }).first().click();
    await expect(page.getByRole('menu', { name: 'Everything' })).toBeVisible();
  });
  await close(page);
  await screen(page, 'work-07-discovery', () => everything(page, /^Discovery\b/));
  await screen(page, 'work-08-readiness', () => everything(page, /^Readiness\b/));
  await enter(page);
  await screen(page, 'work-09-palette', async () => {
    await page.keyboard.press('Control+K');
    await expect(page.getByRole('dialog', { name: 'Find and act' })).toBeVisible();
  });
  await close(page);
  await screen(page, 'work-10-detail-menu', async () => {
    await page.getByRole('button', { name: 'Interface detail menu' }).first().click();
    await expect(page.getByRole('menu').first()).toBeVisible();
  });
  await close(page);
  await screen(page, 'work-11-account-menu', async () => {
    await page.getByRole('button', { name: /^Account: / }).first().click();
    await expect(page.getByRole('menu').first()).toBeVisible();
  });
  await close(page);
  await screen(page, 'work-12-workspaces', async () => {
    await page.getByRole('button', { name: 'Change workspace' }).first().click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
  });
  await close(page);
  await screen(page, 'work-13-cloud-sharing', async () => {
    await page.getByRole('button', { name: 'Cloud sharing', exact: true }).first().click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
  });
  await close(page);
  await screen(page, 'work-14-instructions', async () => {
    await page.getByRole('button', { name: /^Project instructions / }).first().click();
  });
  await enter(page);
  await screen(page, 'work-15-run-details', async () => {
    await page.getByText('Run details', { exact: true }).first().click();
  });
});

test('Work view at a narrow and a wide window', async ({ page }) => {
  for (const [width, height] of [
    [800, 900],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width, height });
    await enter(page);
    await screen(page, `work-20-thread-${width}`, async () => {
      await expect(page.locator('#scrThread')).toBeVisible();
    });
    await screen(page, `work-21-board-${width}`, async () => {
      await rail(page).getByRole('button', { name: /^Board\b/ }).first().click();
    });
    await screen(page, `settings-20-appearance-${width}`, () => settings(page, 'Appearance'));
  }
});

test('Settings: every section', async ({ page }) => {
  test.setTimeout(240_000);
  await enter(page);
  const sections: Array<[string | RegExp, string]> = [
    ['Account', 'settings-01-account'],
    ['Usage', 'settings-02-usage'],
    ['Interface detail', 'settings-03-interface-detail'],
    [/^(Engines|Helpers on this computer)$/, 'settings-04-engines'],
    ['Permissions', 'settings-05-permissions'],
    ['Appearance', 'settings-06-appearance'],
    ['About', 'settings-07-about'],
    ['Design Center', 'settings-08-design-center'],
    ['Agent profiles', 'settings-09-agent-profiles'],
    ['App updates', 'settings-10-app-updates'],
    ["What's new", 'settings-11-whats-new'],
    ['Rules', 'settings-12-rules'],
    ['Developer', 'settings-13-developer'],
  ];
  for (const [section, name] of sections) await screen(page, name, () => settings(page, section), true);
  await screen(
    page,
    'settings-14-engines-advanced',
    async () => {
      await settings(page, /^(Engines|Helpers on this computer)$/);
      await page.getByText('Advanced: provider accounts and routing').first().click();
    },
    true,
  );
});

test('Overlays: Design Center, a new project, and the Projects page', async ({ page }) => {
  await enter(page);
  await screen(page, 'overlay-01-design-center', async () => {
    await settings(page, 'Design Center');
    await page.getByRole('button', { name: 'Open Design Center' }).click();
    await expect(page.getByRole('heading', { name: 'Design Center' }).first()).toBeVisible();
  });
  await page.goto('/');
  await screen(page, 'projects-01-page', async () => {
    await page.getByRole('navigation', { name: 'Open projects', exact: true }).getByRole('button').first().click();
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  });
  await screen(page, 'projects-02-new-project', async () => {
    await page.getByRole('button', { name: 'New project' }).first().click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
  });
});

test('Nectovia view: the home and a thread', async ({ page, request }) => {
  await settle(request, 'conversation');
  try {
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
      [800, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await screen(page, `nv-01-home-${width}`, async () => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await screen(page, 'nv-02-thread', () => enter(page));
  } finally {
    await settle(request, 'architect');
  }
});

test('First run: each setup step', async ({ page, request }) => {
  // A new person's answers: nothing finished yet, settings at Guided, files asked about first.
  const step = async (resumeAt: string) => {
    const put = await request.put('/api/settings', {
      headers: HEADERS,
      data: { detail: 'guided', onboarding: { ...saved.onboarding, resumeAt, completedAt: null, detail: null } },
    });
    expect(put.ok(), await put.text()).toBe(true);
  };
  try {
    for (const resumeAt of ['welcome', 'q1', 'q2', 'q3', 'ai', 'ready']) {
      await step(resumeAt);
      await screen(
        page,
        `setup-${resumeAt}`,
        async () => {
          await page.goto('/');
          await expect(page.locator('.setup').first()).toBeVisible();
        },
        true,
      );
    }
    // The free version's summary (board D06): nothing of Nectovia's own, and Work to start in.
    await page.route('**/api/account', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const view = (await response.json()) as AccountStateView;
      await route.fulfill({ response, json: { ...view, workspaces: [], plan: { ...view.plan, agent: 'free', payAsYouGo: undefined } } });
    });
    await screen(page, 'setup-ready-free', async () => {
      await page.goto('/');
      await expect(page.getByText('None yet, so Nectovia shows sample work until you sign in to one.')).toBeVisible();
    });
    await page.unroute('**/api/account');
  } finally {
    await settle(request, 'architect');
  }
});

test('The waking screen', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  // The wake runs on the page's timers. Hold them still from the first paint, then step to where
  // board D07 is drawn: the letters resolved and the field saying ready.
  const start = new Date('2026-10-07T12:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1_000));
  await screen(page, 'overlay-02-wake', async () => {
    await page.goto('/');
    await expect(page.locator('.dm-wake').first()).toBeVisible({ timeout: 3_000 });
    await page.clock.runFor(2_700);
    await expect(page.locator('.dm-wake-status')).toHaveText('ready');
  });
});

test("The waking screen when the first load doesn't finish", async ({ page }) => {
  await page.route('**/api/projects', (route) => route.abort());
  await page.route('**/api/events', (route) => route.abort());
  await screen(page, 'overlay-03-wake-failed', async () => {
    await page.goto('/');
    await expect(page.locator('.dm-wake.failed')).toBeVisible();
  });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('Sign-in through the browser, each state (board D08)', async ({ page, request }) => {
  const real = (await (await request.get('/api/account')).json()) as AccountStateView;
  // What the host says today in each state (server/accounts/session.ts). The screen draws its own
  // line while a sign-in is under way, and the host's sentence otherwise.
  const states: [string, NonNullable<AccountStateView['browser']>][] = [
    ['gate-02-browser-ready', { status: 'ready', message: '' }],
    ['gate-03-browser-waiting', { status: 'waiting', message: 'Finish signing in in your browser.' }],
    ['gate-04-browser-accepting', { status: 'accepting', message: 'Signing you in.' }],
    ['gate-05-browser-failed', { status: 'failed', message: 'Sign-in could not finish. Try again.' }],
    [
      'gate-06-browser-no-safe-storage',
      { status: 'unavailable', message: "This computer can't keep a sign-in in protected storage, so you can't sign in here." },
    ],
  ];
  for (const [name, browser] of states) {
    const view: AccountStateView = {
      ...real,
      signedIn: false,
      person: null,
      workspaces: [],
      backend: { kind: 'cloud', label: 'Nectovia accounts', url: null, reason: null, signIn: 'browser', demo: null },
      browser,
    };
    await page.route('**/api/account', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: view }) : route.fallback(),
    );
    await screen(page, name, async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Sign in to Nectovia', exact: true })).toBeVisible();
    });
    await page.unroute('**/api/account');
  }
  // The local service doesn't answer before sign-in: the waking screen's card (board D07).
  await page.route('**/api/account', (route) => route.abort());
  await screen(page, 'gate-07-service-unreachable', async () => {
    await page.goto('/');
    await expect(page.locator('.dm-wake.failed')).toBeVisible();
  });
  await page.unroute('**/api/account');
});

// Last: signing out ends this server's session for the rest of the run.
test('Signed out: the account gate', async ({ page, request }) => {
  await request.post('/api/account/sign-out', { headers: HEADERS });
  await screen(page, 'gate-01-signed-out', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Nectovia/ }).first()).toBeVisible();
  });
});
