import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Owned clean/upgrade profiles; metadata only, never a model prompt or login.
const root = path.resolve('test-results', `ai-desktop-${Date.now()}`);
const evidence = path.resolve('evidence/ai-setup');
await fs.mkdir(root, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
const executablePath = path.resolve('release/Diomedes-win32-x64/Diomedes.exe');
const env = {
  ...process.env,
  DIOMEDES_DESKTOP_PROFILE: path.join(root, 'profile'),
  DIOMEDES_DATA_DIR: path.join(root, 'data'),
  DIOMEDES_PROJECTS_DIR: path.join(root, 'projects'),
};
delete env.ELECTRON_RUN_AS_NODE;
let desktop, page, url;
const errors = [],
  metadata = [];
async function launch() {
  desktop = await electron.launch({ executablePath, env });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  url = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 1100 });
}
async function api(route, method = 'GET', body) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
const screenshot = (name) =>
  page.screenshot({ path: path.join(evidence, name), animations: 'disabled' });
try {
  await launch();
  // Check the packaged external-link boundary without opening the user's browser.
  await desktop.evaluate(({ shell }) => {
    globalThis.__referenceOriginal = shell.openExternal;
    globalThis.__references = [];
    shell.openExternal = async (destination) => {
      globalThis.__references.push(destination);
    };
  });
  await page.evaluate(() => {
    window.open('https://platform.openai.com/api-keys');
    window.open('https://unapproved.invalid/');
  });
  await expect
    .poll(() => desktop.evaluate(() => globalThis.__references))
    .toEqual(['https://platform.openai.com/api-keys']);
  await desktop.evaluate(({ shell }) => {
    shell.openExternal = globalThis.__referenceOriginal;
  });
  const initial = await api('/ai/status');
  expect(initial.connections.every((c) => c.installation === 'not-checked')).toBe(true);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: 'Business', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: /^Technical/ }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Ask before changing files in a project' }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect an AI service' })).toBeVisible();
  await screenshot('desktop-clean-setup.png');
  await page.getByRole('button', { name: 'Check this computer' }).click();
  await expect(page.getByRole('button', { name: 'Check this computer' })).toBeEnabled({
    timeout: 30_000,
  });
  for (const [id, name] of [
    ['claude-code', 'Claude Code'],
    ['opencode', 'OpenCode'],
    ['oh-my-pi', 'oh-my-pi'],
  ]) {
    const row = page.getByRole('region', { name, exact: true });
    await row.getByRole('button', { name: 'Check sign-in and models' }).click();
    await expect(row.getByRole('button', { name: 'Check sign-in and models' })).toBeEnabled({
      timeout: 45_000,
    });
    const state = (await api('/ai/status')).connections.find((c) => c.engine === id);
    expect(state.installation).toBe('found');
    expect(state.compatibility).toBe('supported');
    metadata.push({
      engine: id,
      version: state.version,
      authentication: state.authentication,
      accountRoute: state.accountRoute,
      models: state.models.map((m) => m.slug),
      checkedAt: state.checkedAt,
      detail: state.detail,
    });
  }
  await page.getByRole('heading', { name: 'Connect an AI service' }).scrollIntoViewIfNeeded();
  await screenshot('desktop-checked-setup.png');
  await page.getByRole('button', { name: 'Skip AI setup' }).click();
  await expect(page.getByText(/AI setup was skipped/)).toBeVisible();
  await screenshot('desktop-skip-ready.png');
  await page.getByRole('button', { name: 'Open Diomedes' }).click();
  const settings = await api('/settings');
  expect(settings.detail).toBe('technical');
  expect(settings.permissions.changingFiles).toBe(true);
  const project = await api('/projects/sample', 'POST', {});
  const before = await api(`/projects/${project.id}/state`);
  await desktop.close();
  desktop = undefined;
  // Simulate an actual older persisted profile, not a new-profile defaults test.
  const older = {
    ...settings,
    surface: 'workbook',
    detail: 'guided',
    permissions: { ...settings.permissions, changingFiles: false },
    services: { codex: true, codexModel: 'gpt-5.5', defaultEngine: 'codex' },
    openProjects: [project.id],
  };
  delete older.onboarding.setupVersion;
  delete older.onboarding.discoveryConsentAt;
  delete older.onboarding.aiSkipped;
  await fs.writeFile(path.join(root, 'data', 'settings.json'), JSON.stringify(older));
  await launch();
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'workbook');
  const upgraded = await api('/settings');
  expect(upgraded.permissions).toEqual(older.permissions);
  expect(upgraded.detail).toBe('guided');
  expect(upgraded.services).toEqual(older.services);
  expect(upgraded.onboarding.completedAt).toBe(older.onboarding.completedAt);
  expect(upgraded.onboarding.setupVersion).toBe(2);
  expect(upgraded.onboarding.discoveryConsentAt).toBeNull();
  expect((await api(`/projects/${project.id}/state`)).history).toEqual(before.history);
  expect((await api('/ai/status')).connections.every((c) => c.installation === 'not-checked')).toBe(
    true,
  );
  await screenshot('desktop-upgrade.png');
  await api('/settings', 'PUT', { surface: 'console' });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Engines', exact: true })
    .click();
  await screenshot('desktop-settings.png');
  await page.setViewportSize({ width: 800, height: 600 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const reading = await page.locator('.settings-layout .reading').boundingBox();
  const margin = await page.locator('.settings-layout .margin').boundingBox();
  expect(reading).not.toBeNull();
  expect(margin).not.toBeNull();
  expect(margin.y).toBeGreaterThanOrEqual(reading.y + reading.height - 1);
  await screenshot('desktop-settings-800.png');
  expect(errors).toEqual([]);
  const build = JSON.parse(await fs.readFile('evidence/windows-release/build-info.json', 'utf8'));
  await fs.writeFile(
    path.join(evidence, 'desktop-proof.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        root,
        executablePath,
        exeSha256: createHash('sha256')
          .update(await fs.readFile(executablePath))
          .digest('hex'),
        sourceDigest: build.sourceDigest,
        baseCommit: build.baseCommit,
        sourceStatus: build.sourceStatus,
        cleanProfile: true,
        upgradePreferencesAndHistory: true,
        metadataOnly: true,
        modelPrompts: 0,
        metadata,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: clean setup, bounded metadata states, skip, upgrade preferences/history, Settings and 800px layout. Evidence: ${evidence}`,
  );
} finally {
  if (desktop) await desktop.close();
}
