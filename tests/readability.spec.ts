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

/**
 * The September 11 Console — the Files pane, the follow-up queue, the scoped
 * Stop, the project instructions line and the activity overview — arrived
 * after the semantic roles, written against the older scale where body and
 * caption were both 14 px. Two things can go wrong, so there are two checks:
 * a rule can size text in raw pixels, and a rule can pick the wrong role.
 */
test('the newer Console surfaces take the same semantic roles', async ({ page }) => {
  await open(page);
  // No rule anywhere sizes text in pixels. Read the rule text rather than the
  // parsed shorthand: a `font` shorthand whose longhand is overridden later
  // (`.console .instr` sets `font-variant-numeric` after it) no longer
  // serializes, but a literal pixel size still does.
  const sized = await page.evaluate(() => {
    const declarations: { selector: string; value: string }[] = [];
    const walk = (rules: CSSRuleList | undefined) => {
      if (!rules) return;
      for (const rule of rules) {
        const styleRule = rule as CSSStyleRule;
        if (styleRule.selectorText) {
          const block = styleRule.cssText.slice(styleRule.cssText.indexOf('{') + 1);
          for (const found of block.matchAll(/(?:^|[;{]\s*)font(?:-size)?\s*:\s*([^;}]*)/g))
            if (found[1].trim())
              declarations.push({ selector: styleRule.selectorText, value: found[1] });
        }
        walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {
        // A stylesheet this document may not read tells us nothing.
      }
    }
    return declarations;
  });
  expect(sized.length).toBeGreaterThan(40);
  expect(
    sized
      .filter((rule) => /\d(\.\d+)?px/.test(rule.value))
      .map((rule) => `${rule.selector} { font: ${rule.value.trim()} }`),
  ).toEqual([]);

  // The instructions line and its file preview need the Software Engineering
  // pack and a repository to open, so their roles are read off the real
  // cascade with the markup the component renders, placed where it renders it.
  const head = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'instructions';
    probe.innerHTML =
      '<button class="instructions-line"><span>AGENTS.md</span></button>' +
      '<div class="instructions-panel"><pre class="instructions-body">rule</pre></div>';
    document.querySelector('.console .head')!.append(probe);
    const size = (selector: string) =>
      parseFloat(getComputedStyle(document.querySelector<HTMLElement>(selector)!).fontSize);
    const measured = {
      instruments: size('.console .instr'),
      line: size('.console .instructions-line'),
      body: size('.console .instructions-body'),
    };
    probe.remove();
    return measured;
  });
  expect(head.instruments).toBe(12);
  expect(head.line).toBe(head.instruments);
  expect(head.body).toBe(14);

  // The Files pane is a third page column on the stage, never a margin on a
  // `.col` (decision 6), and its tree reads at the navigation role the rail's
  // own rows already use.
  const nav = page.getByRole('navigation', { name: 'Threads and views' });
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.locator('.console .files-row').first()).toBeVisible();
  await audit(page);
  const pane = await page.evaluate(() => {
    const size = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    };
    const stage = document.querySelector<HTMLElement>('.console .stage')!;
    const work = document.querySelector<HTMLElement>('.console .work')!.getBoundingClientRect();
    const col = document.querySelector<HTMLElement>('.console .work .col')!.getBoundingClientRect();
    return {
      columns: getComputedStyle(stage).gridTemplateColumns.trim().split(/\s+/).length,
      workWidth: work.width,
      colWidth: col.width,
      gaps: [col.left - work.left, work.right - col.right],
      row: size('.console .files-row'),
      spine: size('.console .spine .row .nm'),
      paneHeading: size('.console .files-head h2'),
      railHeading: size('.console .rail-head h2'),
      body: size('.console .body p'),
    };
  });
  expect(pane.columns).toBe(3);
  // The pane took a stage column, so the work column narrowed with it and is
  // still centred by its one owner rather than pushed by a margin.
  expect(pane.colWidth).toBe(Math.min(920, pane.workWidth - 64));
  expect(pane.gaps[0]).toBeGreaterThan(0);
  expect(pane.gaps[0]).toBeCloseTo(pane.gaps[1], 0);
  expect(pane.row).toBe(14);
  expect(pane.row).toBe(pane.spine);
  expect(pane.paneHeading).toBe(pane.railHeading);
  expect(pane.body).toBe(16);

  // A document read in the pane: prose at the reading role, the raw bytes at
  // the code role rather than at 16 px prose.
  await page.locator('.console .files-row', { hasText: 'Reopening plan.md' }).click();
  await expect(page.locator('.console .files-md')).toBeVisible();
  expect(
    await page
      .locator('.console .files-md')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBe(16);
  await audit(page);
  await page.locator('.console .files-seg').getByRole('button', { name: 'Raw' }).click();
  await expect(page.locator('.console .files-raw')).toBeVisible();
  expect(
    await page
      .locator('.console .files-raw')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBe(14);
  await audit(page);

  // A thread that owns a task carries the follow-up queue under its composer.
  const task = await (
    await page.request.post(`/api/projects/${project.id}/tasks`, {
      headers,
      data: { name: 'Confirm the produce order' },
    })
  ).json();
  expect(
    (
      await page.request.post(`/api/projects/${project.id}/ask`, {
        headers,
        data: {
          text: 'Confirm the produce order with the supplier before Friday.',
          mode: 'ask',
          route: 'sample',
          attachedTo: { kind: 'task', ref: task.id },
        },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await nav.getByRole('button', { name: /Confirm the produce order with the supplier/ }).click();
  await expect(page.locator('.console .follow-ups')).toBeVisible();
  await audit(page);
  const queue = await page.evaluate(() => {
    const size = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    };
    return {
      queue: size('.console .follow-ups'),
      queueInput: size('.console .follow-up-compose textarea'),
      composer: size('.console .composer textarea'),
      when: size('.console .follow-ups .seg button'),
    };
  });
  expect(queue.queue).toBe(14);
  expect(queue.queueInput).toBe(15);
  expect(queue.queueInput).toBe(queue.composer);
  expect(queue.when).toBe(13);
});
