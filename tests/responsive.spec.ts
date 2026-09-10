import { test, expect, type Page } from '@playwright/test';
import type { Project, Settings, TeamState } from '../shared/types';

const headers = { 'X-Diomedes-Client': '1' };
let saved: Settings;
let project: Project;
const longName = 'Supplier-review-' + 'longprojectname'.repeat(6);

test.beforeAll(async ({ request }) => {
  saved = await (await request.get('/api/settings')).json();
  const projects = (await (await request.get('/api/projects')).json()).projects as Project[];
  const existing = projects.find((p) => p.name === longName);
  if (existing) project = existing;
  else {
    const created = await request.post('/api/projects', { headers, data: { name: longName } });
    expect(created.ok(), await created.text()).toBe(true);
    project = await created.json();
  }
  const thread = await request.post(`/api/projects/${project.id}/ask`, {
    headers,
    data: {
      text: 'Review the supplier documents and outline the next steps.',
      mode: 'ask',
      route: 'sample',
    },
  });
  expect(thread.ok()).toBe(true);
});
test.afterAll(async ({ request }) => {
  expect((await request.put('/api/settings', { headers, data: saved })).ok()).toBe(true);
});
async function open(page: Page, surface: 'workbook' | 'console', scale: number, theme = 'ember') {
  expect(
    (
      await page.request.put('/api/settings', {
        headers,
        data: {
          onboarding: { ...saved.onboarding, resumeAt: 'done' },
          surface,
          detail: 'technical',
          openProjects: [project.id],
          lastPage: { [project.id]: 'home' },
          appearance: {
            package: theme,
            motion: 'reduced',
            interfaceScale: scale,
            readingScale: 1.3,
            codeScale: 1.3,
          },
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto('/');
  await expect(page.locator(surface === 'console' ? '.console' : '.workspace')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function fits(page: Page) {
  const failures = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')].flatMap((el) => {
      const s = getComputedStyle(el);
      if (!el.getClientRects().length || s.visibility === 'hidden' || !el.clientWidth) return [];
      if (s.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 2)
        return [`${el.tagName}.${el.className}: ${el.scrollWidth} > ${el.clientWidth}`];
      return [];
    }),
  );
  expect(failures).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
    ),
  ).toBe(true);
}

for (const [width, height, scale] of [
  [1280, 720, 1],
  [960, 900, 1.25],
  [640, 800, 1.5],
  [390, 844, 1],
]) {
  test(`Workbook and Settings contain long content at ${width}px and ${scale} scale`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await open(page, 'workbook', scale);
    const rail = page.getByRole('navigation', { name: 'Project pages', exact: true });
    for (const name of ['Home', 'Ask', 'Plan', 'Work', 'Review', 'Tasks', 'Documents', 'History']) {
      await rail.getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
      await expect(page.locator('.page-header h1')).toBeVisible();
      await fits(page);
      const uiFonts = await page
        .locator('.prose:not(.document-reading)')
        .evaluateAll((els) =>
          els.map((el) => ({
            family: getComputedStyle(el).fontFamily,
            size: getComputedStyle(el).fontSize,
          })),
        );
      for (const font of uiFonts) {
        expect(font.family).toContain('Schibsted Grotesk');
        expect(font.size).toBe('14px');
      }
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    for (const name of [
      'Interface detail',
      'Helpers on this computer',
      'Permissions',
      'History',
      'Appearance',
      'About',
    ]) {
      await page
        .locator('.settings-layout .rail')
        .getByRole('button', { name, exact: true })
        .click();
      await fits(page);
    }
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await fits(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
  test(`Console navigation and populated Team fit ${width}px and ${scale} scale`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const team: TeamState = {
      members: ['lead', 'research', 'review'].map((id, index) => ({
        slotId: id,
        name: `${id}-${'longworkername'.repeat(4)}`,
        role: index === 0 ? 'lead' : 'member',
        engine: 'sample',
        model: 'model-' + 'longmodelname'.repeat(5),
        status: 'idle',
        threadId: null,
        createdAt: '2026-09-09T12:00:00Z',
        lastSeenAt: null,
      })),
      messages: [
        {
          id: 'proof-message',
          from: 'lead',
          to: 'review',
          type: 'message',
          read: false,
          content: 'Review evidence/' + 'longdirectory/'.repeat(12) + 'supplier-report.md',
          createdAt: '2026-09-09T12:00:00Z',
          threadId: null,
          runId: null,
          approvalId: null,
        },
      ],
      runs: [],
    };
    await page.route(`**/api/projects/${project.id}/team`, (route) =>
      route.fulfill({ json: team }),
    );
    await open(page, 'console', scale);
    const nav = page.getByRole('navigation', { name: 'Threads and views' });
    for (const name of ['Thread', 'Board', 'Team', 'Connections']) {
      await nav.getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
      await fits(page);
    }
    await page.locator('.picker > button').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await fits(page);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Find and act' })).toBeVisible();
    await fits(page);
    await page.keyboard.press('Escape');
  });
}

test('document scale stays separate from UI, and themes keep their selected accent', async ({
  page,
}) => {
  const sample = (await (
    await page.request.post('/api/projects/sample', { headers, data: {} })
  ).json()) as Project;
  await open(page, 'workbook', 1);
  for (const [theme, accent] of [
    ['ember', '#ff8a5b'],
    ['field', '#3fd6df'],
    ['paper', '#0e7c86'],
  ]) {
    await open(page, 'workbook', 1, theme);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--light').trim(),
      ),
    ).toBe(accent);
    await fits(page);
  }
  await page.request.put('/api/settings', {
    headers,
    data: { openProjects: [sample.id], lastPage: { [sample.id]: 'documents' } },
  });
  await page.reload();
  await page
    .getByRole('button', { name: /Reopening plan.md/ })
    .first()
    .click();
  await expect(page.locator('.document-reading')).toBeVisible();
  expect(
    await page.locator('.document-reading').evaluate((el) => getComputedStyle(el).fontFamily),
  ).toContain('Schibsted Grotesk');
  expect(
    await page.locator('.document-reading').evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe('20.8px');
});
