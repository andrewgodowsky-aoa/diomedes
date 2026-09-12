import { test, expect, type Page } from '@playwright/test';
import type { Project, Settings, TeamState } from '../shared/types';

const headers = { 'X-Diomedes-Client': '1' };
let project: Project;
let saved: Settings;

test.beforeAll(async ({ request }) => {
  saved = await (await request.get('/api/settings')).json();
  project = await (await request.post('/api/projects/sample', { headers, data: {} })).json();
  expect(
    (
      await request.post(`/api/projects/${project.id}/ask`, {
        headers,
        data: {
          text: 'Review the supplier plan and explain the next steps.',
          mode: 'ask',
          route: 'sample',
        },
      })
    ).ok(),
  ).toBe(true);
});
test.afterAll(async ({ request }) => {
  expect((await request.put('/api/settings', { headers, data: saved })).ok()).toBe(true);
});

async function open(page: Page, scale = 1) {
  expect(
    (
      await page.request.put('/api/settings', {
        headers,
        data: {
          onboarding: { ...saved.onboarding, resumeAt: 'done' },
          surface: 'console',
          openProjects: [project.id],
          lastPage: { [project.id]: 'home' },
          appearance: {
            package: 'graphite',
            motion: 'reduced',
            interfaceScale: scale,
            readingScale: 1,
            codeScale: 1,
          },
        },
      })
    ).ok(),
  ).toBe(true);
  const team: TeamState = {
    members: ['lead', 'review'].map((id) => ({
      slotId: id,
      name: `${id} worker`,
      role: id === 'lead' ? 'lead' : 'member',
      engine: 'sample',
      model: 'sample',
      status: 'idle',
      threadId: null,
      createdAt: '2026-09-11T12:00:00Z',
      lastSeenAt: null,
    })),
    messages: [
      {
        id: 'readability-message',
        from: 'lead',
        to: 'review',
        type: 'message',
        read: false,
        content: 'Review the supplier plan and compare delivery dates before preparing the brief.',
        createdAt: '2026-09-11T12:00:00Z',
        threadId: null,
        runId: null,
        approvalId: null,
      },
    ],
    runs: [],
  };
  await page.route(`**/api/projects/${project.id}/team`, (route) => route.fulfill({ json: team }));
  await page.goto('/');
  await expect(page.locator('.console .body p').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function audit(page: Page) {
  const result = await page.evaluate(() => {
    const failures: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const s = getComputedStyle(el);
      if (!el.getClientRects().length || s.visibility === 'hidden' || !el.clientWidth) continue;
      const text = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
      );
      if (text && parseFloat(s.fontSize) < 12)
        failures.push(`Small: ${el.className} ${s.fontSize}`);
      if (s.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 2)
        failures.push(
          `Overflow: ${el.tagName}.${el.className} ${el.scrollWidth}/${el.clientWidth}`,
        );
    }
    for (const strip of document.querySelectorAll<HTMLElement>('.composer .segmented')) {
      if (!strip.getClientRects().length) continue;
      for (const button of strip.querySelectorAll('button')) {
        if (
          button.getBoundingClientRect().right > strip.getBoundingClientRect().right + 1 ||
          button.scrollWidth > button.clientWidth + 1
        )
          failures.push(`Clipped mode: ${button.textContent}`);
      }
    }
    const sample = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return null;
      const s = getComputedStyle(el),
        r = el.getBoundingClientRect();
      return {
        font: parseFloat(s.fontSize),
        line: parseFloat(s.lineHeight),
        width: r.width,
        top: r.top,
        bottom: r.bottom,
      };
    };
    return {
      failures,
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      zoom: getComputedStyle(document.documentElement).zoom,
      appWidth: document.querySelector('.app')?.getBoundingClientRect().width,
      body: sample('.console .body p'),
      input: sample('.console .composer textarea'),
      col: sample('.console .transcript .col'),
      transcript: sample('.console .transcript'),
      instruments: sample('.console .instr'),
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(result.failures).toEqual([]);
  expect(result.documentWidth).toBeLessThanOrEqual(result.width + 2);
  return result;
}

const screens = [
  { name: 'windowed', width: 1440, height: 900, dpr: 1 },
  { name: '1080p', width: 1920, height: 1080, dpr: 1 },
  { name: '1440p', width: 2560, height: 1440, dpr: 1 },
  { name: '4K-100-percent-DPI', width: 3840, height: 2160, dpr: 1 },
  { name: '4K-150-percent-DPI', width: 2560, height: 1440, dpr: 1.5 },
  { name: '4K-200-percent-DPI', width: 1920, height: 1080, dpr: 2 },
  { name: 'ultrawide', width: 3440, height: 1440, dpr: 1 },
  { name: 'laptop', width: 1024, height: 768, dpr: 1.25 },
  { name: 'minimum-desktop', width: 800, height: 600, dpr: 1 },
];

for (const screen of screens) {
  test(`semantic type and surfaces: ${screen.name}`, async ({ browser, baseURL }, info) => {
    const context = await browser.newContext({
      baseURL,
      viewport: screen,
      deviceScaleFactor: screen.dpr,
    });
    const page = await context.newPage();
    try {
      await open(page);
      const measurements = [await audit(page)];
      const m = measurements[0];
      expect(m.dpr).toBe(screen.dpr);
      expect(m.body?.font).toBe(16);
      expect(m.input?.font).toBe(15);
      expect(m.body!.line / m.body!.font).toBeCloseTo(1.55, 2);
      expect(m.transcript!.top).toBeLessThanOrEqual(m.instruments!.bottom + 2);
      expect(m.body!.width).toBeLessThanOrEqual(m.col!.width + 1);
      if (screen.width >= 1920) expect(m.col!.width).toBe(920);
      await page.screenshot({ path: info.outputPath('thread.png') });
      const nav = page.getByRole('navigation', { name: 'Threads and views' });
      for (const name of ['Board', 'Team', 'Connections', 'Engines']) {
        await nav.getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
        measurements.push(await audit(page));
        if (name === 'Engines') break; // Settings replaces the Console.
      }
      await page
        .locator('.settings-layout .rail')
        .getByRole('button', { name: 'Appearance', exact: true })
        .click();
      await audit(page);
      await page.keyboard.press('Control+k');
      await expect(page.getByRole('dialog')).toBeVisible();
      await audit(page);
      await page.keyboard.press('Escape');
      await page.request.put('/api/settings', { headers, data: { surface: 'workbook' } });
      await page.reload();
      const rail = page.getByRole('navigation', { name: 'Project pages', exact: true });
      for (const name of [
        'Home',
        'Ask',
        'Plan',
        'Work',
        'Review',
        'Tasks',
        'Documents',
        'History',
      ]) {
        await rail.getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
        measurements.push(await audit(page));
      }
      await info.attach('viewport-and-typography', {
        body: JSON.stringify(measurements, null, 2),
        contentType: 'application/json',
      });
    } finally {
      await context.close();
    }
  });
}

test('maximizing preserves type and explicit scaling persists through reload and settings', async ({
  page,
}) => {
  await open(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const before = await audit(page);
  await page.setViewportSize({ width: 2560, height: 1440 });
  const after = await audit(page);
  expect(after.body?.font).toBe(before.body?.font);
  expect(after.input?.font).toBe(before.input?.font);
  await page.keyboard.press('Control+=');
  await page.keyboard.press('Control+=');
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/settings')).json()).appearance.interfaceScale,
    )
    .toBe(1.25);
  await page.reload();
  await expect(page.locator('html')).toHaveCSS('zoom', '1.25');
  await expect(page.locator('.console .body p').first()).toBeVisible();
  expect((await audit(page)).body?.font).toBe(16);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .locator('.settings-layout .rail')
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  await expect(page.getByLabel('Interface size')).toHaveValue('1.25');
  await page.getByLabel('Interface size').selectOption('0.9');
  await expect(page.locator('html')).toHaveCSS('zoom', '0.9');
  await page.keyboard.press('Control+0');
  await expect(page.locator('html')).toHaveCSS('zoom', '1');
  await expect(page.getByLabel('Interface size')).toHaveValue('1');
  await page.request.put('/api/settings', {
    headers,
    data: { appearance: { interfaceScale: 1.12 } },
  });
  await expect(page.getByLabel('Interface size')).toHaveValue('1.12');
  await expect(page.getByLabel('Interface size').locator('option:checked')).toHaveText(
    '112% (Custom)',
  );
});
