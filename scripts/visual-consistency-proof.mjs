import { chromium, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

// An owned test-mode service is required. Never point this at a personal profile.
let baseURL = process.env.DIOMEDES_VISUAL_URL ?? 'http://127.0.0.1:5186';
const phase = process.argv[2] ?? 'after';
const output = path.resolve('evidence/visual-consistency', phase);
await fs.mkdir(output, { recursive: true });
const executablePath = process.env.DIOMEDES_VISUAL_EXE;
let browser;
let desktop;
let context;
let page;
let display;
if (executablePath) {
  const profile = path.resolve('test-results', `visual-desktop-${Date.now()}`);
  const env = {
    ...process.env,
    DIOMEDES_DESKTOP_PROFILE: path.join(profile, 'profile'),
    DIOMEDES_DATA_DIR: path.join(profile, 'data'),
    DIOMEDES_PROJECTS_DIR: path.join(profile, 'projects'),
    DIOMEDES_TEST_MODE: '1',
    CODEX_HOME: path.join(profile, 'codex'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({
    executablePath,
    env,
    args: process.env.DIOMEDES_VISUAL_DPR
      ? [`--force-device-scale-factor=${process.env.DIOMEDES_VISUAL_DPR}`]
      : [],
  });
  page = await desktop.firstWindow();
  await page.waitForURL('http://127.0.0.1:*/');
  baseURL = new URL(page.url()).origin;
  context = desktop.context();
  display = await desktop.evaluate(({ screen, BrowserWindow }) => ({
    displays: screen
      .getAllDisplays()
      .map((d) => ({ bounds: d.bounds, scaleFactor: d.scaleFactor })),
    electronZoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    forcedScaleFactor: process.env.DIOMEDES_VISUAL_DPR ?? null,
  }));
} else {
  browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  });
  context = await browser.newContext({ baseURL });
  page = await context.newPage();
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
async function api(url, method = 'GET', data) {
  const response = await context.request.fetch(`${baseURL}/api${url}`, {
    method,
    data,
    headers: { 'X-Diomedes-Client': '1' },
  });
  if (!response.ok())
    throw new Error(`${method} ${url}: ${response.status()} ${await response.text()}`);
  return response.json();
}
const original = await api('/settings');
const projects = (await api('/projects')).projects;
const project =
  projects.find((p) => p.name.includes('Harbor Street')) ??
  (await api('/projects/sample', 'POST', {}));
const state = await api(`/projects/${project.id}/state`);
if (!state.conversations.some((c) => c.turns.length)) {
  await api(`/projects/${project.id}/ask`, 'POST', {
    text: 'Plan the supplier review and explain the next steps.',
    mode: 'ask',
    route: 'sample',
  });
}
const screens = ['settings', 'projects', 'home', 'ask', 'review', 'team', 'connections'];
const reports = [];
async function open(screen, scale = 1.1, theme = 'ember') {
  const consoleView = ['settings', 'team', 'connections'].includes(screen);
  await api('/settings', 'PUT', {
    onboarding: { ...original.onboarding, resumeAt: 'done' },
    surface: consoleView ? 'console' : 'workbook',
    detail: 'technical',
    openProjects: screen === 'projects' ? [] : [project.id],
    lastPage: { [project.id]: ['ask', 'review'].includes(screen) ? screen : 'home' },
    appearance: {
      package: theme,
      motion: 'reduced',
      interfaceScale: scale,
      readingScale: 1,
      codeScale: 1,
    },
  });
  await page.goto(baseURL);
  await page.locator('.app .page-frame, .console .stage').first().waitFor();
  if (screen === 'settings') {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Engines', exact: true }).click();
    await page.getByRole('heading', { name: 'Engines', level: 1 }).waitFor();
  }
  if (screen === 'team' || screen === 'connections') {
    await page
      .locator('.console .rail')
      .getByRole('button', { name: new RegExp(`^${screen === 'team' ? 'Team' : 'Connections'}`) })
      .click();
  }
  await page.evaluate(() => document.fonts.ready);
}
async function capture(screen, width, height, scale, theme = 'ember', label = screen) {
  if (desktop)
    await desktop.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window.isMaximized()) window.unmaximize();
        window.setContentSize(size.width, size.height);
      },
      { width, height },
    );
  else await page.setViewportSize({ width, height });
  await open(screen, scale, theme);
  const metrics = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const fonts = [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => `${f.family} ${f.weight}`);
    const type = [
      ...document.querySelectorAll('h1, h2, h3, .prose, .caption, textarea, .console .txt'),
    ]
      .filter((el) => el.getClientRects().length)
      .slice(0, 80)
      .map((el) => {
        const s = getComputedStyle(el);
        return {
          selector: `${el.tagName}.${el.className}`,
          font: s.fontFamily,
          size: s.fontSize,
          lineHeight: s.lineHeight,
        };
      });
    const overflow = [...document.querySelectorAll('body *')]
      .filter((el) => {
        if (!(el instanceof HTMLElement) || !el.getClientRects().length) return false;
        const s = getComputedStyle(el);
        return (
          el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && s.overflowX === 'visible'
        );
      })
      .map((el) => ({
        selector: `${el.tagName}.${el.className}`,
        client: el.clientWidth,
        scroll: el.scrollWidth,
      }));
    return {
      viewport: [innerWidth, innerHeight],
      dpr: devicePixelRatio,
      uiScale: root.getPropertyValue('--dm-ui-scale'),
      readingScale: root.getPropertyValue('--dm-read-scale'),
      codeScale: root.getPropertyValue('--dm-code-scale'),
      fonts,
      type,
      overflow,
      documentOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      sampleWorkVisible: /sample work/i.test(document.body.innerText),
    };
  });
  const name = `${label}-${width}x${height}-${scale}-${theme}`;
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  reports.push({ name, ...metrics });
}
try {
  for (const [width, height] of [
    [1280, 720],
    [1920, 1080],
    [2560, 1440],
  ]) {
    for (const screen of screens) await capture(screen, width, height, 1.1);
  }
  if (phase !== 'before' && !desktop) {
    for (const [width, height, scale] of [
      [960, 900, 1.25],
      [640, 800, 1.5],
      [390, 844, 1],
    ]) {
      for (const screen of screens) await capture(screen, width, height, scale);
    }
    for (const theme of ['field', 'paper']) await capture('settings', 1280, 720, 1, theme);
    // Read-only presentation fixture; no worker is started and no model is called.
    await page.route(`**/api/projects/${project.id}/team`, (route) =>
      route.fulfill({
        json: {
          members: ['Lead', 'Research', 'Review'].map((name, index) => ({
            slotId: name.toLowerCase(),
            name,
            role: index === 0 ? 'lead' : 'member',
            engine: 'codex',
            model: 'gpt-6-astra',
            status: 'idle',
            threadId: null,
            createdAt: '2026-09-09T12:00:00Z',
            lastSeenAt: null,
          })),
          messages: [
            {
              id: 'visual-proof',
              from: 'lead',
              to: 'review',
              type: 'message',
              read: false,
              content:
                'Review the supplier notes and confirm the delivery dates before we update the reopening plan.',
              createdAt: '2026-09-09T12:00:00Z',
              threadId: null,
              runId: null,
              approvalId: null,
            },
          ],
          runs: [],
        },
      }),
    );
    for (const [width, height, scale] of [
      [1280, 720, 1.1],
      [960, 900, 1.25],
      [390, 844, 1],
    ])
      await capture('team', width, height, scale, 'ember', 'team-populated');
  }
} finally {
  await api('/settings', 'PUT', original);
  await fs.writeFile(
    path.join(output, 'manifest.json'),
    JSON.stringify({ baseURL, phase, executablePath, display, errors, reports }, null, 2),
  );
  if (desktop) await desktop.close();
  else await browser.close();
}
console.log(
  JSON.stringify(
    {
      captures: reports.length,
      errors,
      overflow: reports
        .filter((r) => r.overflow.length || r.documentOverflow)
        .map((r) => ({ name: r.name, overflow: r.overflow })),
    },
    null,
    2,
  ),
);
if (
  errors.length ||
  reports.some(
    (r) =>
      r.overflow.length ||
      r.documentOverflow ||
      (phase !== 'before' &&
        (r.sampleWorkVisible || r.fonts.some((f) => f.includes('Plex Serif')))),
  )
)
  process.exitCode = 1;
