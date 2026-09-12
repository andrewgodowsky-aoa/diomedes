import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('test-results', `desktop-readability-${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const executablePath = path.resolve('release/Diomedes-win32-x64/Diomedes.exe');
const env = {
  ...process.env,
  DIOMEDES_DESKTOP_PROFILE: path.join(root, 'profile'),
  DIOMEDES_DATA_DIR: path.join(root, 'data'),
  DIOMEDES_PROJECTS_DIR: path.join(root, 'projects'),
  DIOMEDES_TEST_MODE: '1',
  CODEX_HOME: path.join(root, 'codex'),
};
delete env.ELECTRON_RUN_AS_NODE;
const records = [];
let desktop;
let url;
async function api(route, method = 'GET', data) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function record(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const renderer = await page.evaluate(() => {
    const font = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const s = getComputedStyle(el),
        r = el.getBoundingClientRect();
      return { font: s.fontSize, line: s.lineHeight, width: r.width, height: r.height };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      visualViewportScale: visualViewport?.scale,
      interfaceScale: getComputedStyle(document.documentElement).zoom,
      rootFont: getComputedStyle(document.documentElement).fontSize,
      body: font('.console .body p'),
      input: font('.console .composer textarea'),
      workColumn: font('.console .transcript .col'),
      nav: font('.console .views button'),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
    };
  });
  const native = await desktop.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const display = screen.getDisplayMatching(win.getBounds());
    return {
      maximized: win.isMaximized(),
      bounds: win.getBounds(),
      contentBounds: win.getContentBounds(),
      zoomFactor: win.webContents.getZoomFactor(),
      display: {
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
      },
    };
  });
  expect(native.zoomFactor).toBe(1);
  expect(renderer.horizontalOverflow).toBe(false);
  records.push({ name, renderer, native });
  await fs.writeFile(
    path.join(root, 'report.json'),
    JSON.stringify({ executablePath, records }, null, 2),
  );
  await page.screenshot({ path: path.join(root, `${name}.png`) });
}
try {
  desktop = await electron.launch({ executablePath, env });
  let page = await desktop.firstWindow();
  await page.waitForURL('http://127.0.0.1:*/');
  url = new URL(page.url()).origin;
  const project = await api('/projects/sample', 'POST', {});
  await api('/settings', 'PUT', {
    surface: 'console',
    detail: 'technical',
    onboarding: { work: 'personal', detail: 'technical', familiarity: 'some', resumeAt: 'done' },
    openProjects: [project.id],
    lastPage: { [project.id]: 'home' },
    appearance: { package: 'graphite', motion: 'reduced', interfaceScale: 1 },
  });
  // Synthetic local data only. No provider consent, model calls, credentials or tools.
  await api(`/projects/${project.id}/tasks`, 'POST', {
    name: 'Compare the supplier delivery dates',
  });
  await api(`/projects/${project.id}/ask`, 'POST', {
    text: 'Review the supplier delivery plan. Identify the next steps and the information needed before confirming the order.',
    mode: 'ask',
    route: 'sample',
  });
  await page.reload();
  await expect(page.locator('.console .body p').first()).toBeVisible();
  await record(page, 'windowed-thread');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await expect
    .poll(() =>
      desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
    )
    .toBe(true);
  await record(page, 'maximized-thread');
  expect(records[1].renderer.body.font).toBe(records[0].renderer.body.font);
  expect(records[1].renderer.input.font).toBe(records[0].renderer.input.font);
  await page.keyboard.press('Control+=');
  await expect(page.locator('html')).toHaveCSS('zoom', '1.1');
  await page.keyboard.press('Control+=');
  await expect(page.locator('html')).toHaveCSS('zoom', '1.25');
  await record(page, 'maximized-125-percent');
  await desktop.close();
  desktop = await electron.launch({ executablePath, env });
  page = await desktop.firstWindow();
  await page.waitForURL('http://127.0.0.1:*/');
  url = new URL(page.url()).origin;
  await expect(page.locator('html')).toHaveCSS('zoom', '1.25');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await record(page, 'restarted-125-percent');
  await page.keyboard.press('Control+-');
  await expect(page.locator('html')).toHaveCSS('zoom', '1.1');
  await page.keyboard.press('Control+0');
  await expect(page.locator('html')).toHaveCSS('zoom', '1');
  // Exercise the native menu too; it must operate the exact same setting.
  await desktop.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items.find((item) => item.label === 'View')
      .submenu.items[0].click(),
  );
  await expect(page.locator('html')).toHaveCSS('zoom', '1.1');
  await page.keyboard.press('Control+0');
  await expect(page.locator('html')).toHaveCSS('zoom', '1');
  for (const [name, role] of [
    ['Plan reviewer', 'lead'],
    ['Delivery reviewer', 'member'],
  ]) {
    const created = await api(`/projects/${project.id}/team/members`, 'POST', {
      name,
      role,
      engine: 'sample',
    });
    await api(`/projects/${project.id}/team/messages`, 'POST', {
      to: created.member.slotId,
      content: 'Local visual fixture: compare the delivery dates and list any missing information.',
    });
  }
  const nav = page.getByRole('navigation', { name: 'Threads and views' });
  for (const name of ['Board', 'Team', 'Connections', 'Thread']) {
    await nav
      .locator('.views')
      .getByRole('button', { name: new RegExp(`^${name}\\b`) })
      .click();
    await record(page, `maximized-${name.toLowerCase()}`);
  }
  await page.locator('.model-picker > button').click();
  await expect(page.getByRole('menu')).toBeVisible();
  await record(page, 'maximized-model-menu');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Find and act' })).toBeVisible();
  await record(page, 'maximized-palette');
  await page.keyboard.press('Escape');
  await nav.getByRole('button', { name: 'Engines', exact: true }).click();
  await record(page, 'maximized-engines');
  for (const name of ['Appearance', 'Permissions', 'History']) {
    await page.locator('.settings-layout .rail').getByRole('button', { name, exact: true }).click();
    await record(page, `maximized-settings-${name.toLowerCase()}`);
  }
  await api('/settings', 'PUT', { surface: 'workbook' });
  await page.reload();
  const rail = page.getByRole('navigation', { name: 'Project pages', exact: true });
  for (const name of ['Home', 'Ask', 'Plan', 'Work', 'Review', 'Tasks', 'Documents', 'History']) {
    await rail.getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
    await record(page, `maximized-workbook-${name.toLowerCase()}`);
  }
  await api('/settings', 'PUT', { surface: 'console' });
  await page.reload();
  await expect(page.locator('.console')).toBeVisible();
  await fs.writeFile(
    path.join(root, 'report.json'),
    JSON.stringify({ executablePath, records }, null, 2),
  );
  console.log(
    `PASS: native maximize, stable typography, persistent interface scale, shortcuts, menu and principal surfaces.\nEvidence: ${root}`,
  );
  if (process.argv.includes('--hold')) {
    console.log('Holding the isolated desktop for visual inspection; press Enter to close it.');
    await new Promise((resolve) => process.stdin.once('data', resolve));
  }
} finally {
  await desktop?.close();
}
