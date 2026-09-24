import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Project, Settings } from '../shared/types';
import { sealManifest, sha256 } from '../server/pack-catalogue';
import { reopenLastProject } from './fixtures/landing';

/**
 * The Capabilities section in the task-permissions dialog, end to end: the
 * installed list with versions and per-project state, requested permissions
 * shown as requests, a bundled install that asks about its dependency, a
 * refused uninstall of a pack in use, and a local folder installed, updated,
 * rolled back and uninstalled - each with its own confirmation, and each read
 * back from the records rather than assumed.
 */

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const THREAD = 'Pack settings journey';
let originalSettings: Settings | null = null;
let projectId = '';
let sources = '';
let pageErrors: string[] = [];

async function localPack(name: string, version: string) {
  const folder = path.join(sources, name);
  await fs.mkdir(path.join(folder, 'playbooks'), { recursive: true });
  const text = `# Month-end close ${version}\n`;
  await fs.writeFile(path.join(folder, 'playbooks', 'close.md'), text);
  const manifest = sealManifest({
    schemaVersion: 1,
    id: 'acme.bookkeeping',
    version,
    name: 'Bookkeeping',
    publisher: { id: 'acme', name: 'Acme' },
    description: 'Month-end close playbooks.',
    compatibility: { contract: '^1.0.0' },
    contributions: { tools: [], agents: [], rules: [], context: [], workflows: [], ui: [] },
    permissions: {
      requested: [{ capability: 'read-accounting', reason: 'To read the ledger export.' }],
      grantsAuthority: false,
    },
    dependencies: [],
    files: [{ path: 'playbooks/close.md', sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) }],
  });
  await fs.writeFile(path.join(folder, 'diomedes-pack.json'), JSON.stringify(manifest, null, 2));
  return folder;
}

test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test.beforeAll(async ({ request }) => {
  originalSettings = (await (await request.get('/api/settings')).json()) as Settings;
  expect(
    (
      await request.put('/api/settings', {
        headers: HEADERS,
        data: {
          onboarding: { resumeAt: 'done', work: 'business', detail: 'guided', familiarity: 'comfortable' },
          detail: 'guided',
        },
      })
    ).ok(),
  ).toBe(true);
  const created = await request.post('/api/projects', { headers: HEADERS, data: { name: 'Pack journey' } });
  expect(created.ok()).toBe(true);
  projectId = ((await created.json()) as Project).id;
  expect(
    (await request.post(`/api/projects/${projectId}/threads`, { headers: HEADERS, data: { name: THREAD } })).ok(),
  ).toBe(true);
  sources = path.resolve('test-results', `pack-sources-${Date.now()}`);
});

test.afterAll(async ({ request }) => {
  // Leave the shared service as later specs expect it: nothing extra on or installed.
  for (const id of ['diomedes.industry.carpentry', 'diomedes.weekly-brief'])
    await request.post(`/api/projects/${projectId}/packs/${id}/deactivate`, { headers: HEADERS, data: {} });
  for (const id of ['diomedes.industry.carpentry', 'diomedes.weekly-brief', 'acme.bookkeeping'])
    await request.post(`/api/packs/${id}/uninstall`, { headers: HEADERS, data: {} });
  await request.put('/api/settings', { headers: HEADERS, data: JSON.parse(JSON.stringify(originalSettings)) });
  await fs.rm(sources, { recursive: true, force: true });
});

async function openCapabilities(page: Page) {
  await page.request.put('/api/settings', { headers: HEADERS, data: { openProjects: [projectId] } });
  await page.goto('/');
  await reopenLastProject(page);
  await page
    .getByRole('navigation', { name: 'Threads and views' })
    .getByRole('button', { name: new RegExp(THREAD) })
    .click();
  await page.locator('.task-permission').getByRole('button').first().click();
  const dialog = page.getByRole('dialog', { name: 'Task permissions' });
  await expect(dialog).toBeVisible();
  const section = dialog.getByRole('region', { name: 'Capabilities' });
  await expect(section).toBeVisible();
  return section;
}

test('PACK-UI-01: installed packs, a dependency asked about, and activation that grants nothing', async ({
  page,
}, testInfo) => {
  const section = await openCapabilities(page);
  const engineering = section.locator('[data-pack="diomedes.software-engineering"]');
  await expect(engineering.locator('.pack-state')).toHaveText('0.1.0 · off');
  await expect(engineering).toContainText('Requests · Trust decides at use');
  await expect(engineering).toContainText('read-project-files');

  const carpentry = section.locator('[data-pack="diomedes.industry.carpentry"]');
  await carpentry.getByRole('button', { name: 'Install' }).click();
  await expect(carpentry).toContainText('needs Weekly brief 1.0.0 installed too.');
  await carpentry.getByRole('button', { name: 'Install both' }).click();
  await expect(carpentry.locator('.pack-state')).toHaveText('1.0.0 · off');
  await expect(section.locator('[data-pack="diomedes.weekly-brief"] .pack-state')).toHaveText('1.0.0 · off');
  await expect(carpentry).toContainText('this build does not run them yet');

  const grantsBefore = await (await page.request.get(`/api/projects/${projectId}/permissions/grants`)).json();
  await carpentry.getByRole('button', { name: 'Activate' }).click();
  await expect(carpentry).toContainText('needs Weekly brief 1.0.0 on in this project too.');
  await carpentry.getByRole('button', { name: 'Turn on both' }).click();
  await expect(carpentry.locator('.pack-state')).toHaveText('1.0.0 · on');
  await expect(section.locator('[data-pack="diomedes.weekly-brief"] .pack-state')).toHaveText('1.0.0 · on');
  const grantsAfter = await (await page.request.get(`/api/projects/${projectId}/permissions/grants`)).json();
  expect(grantsAfter).toEqual(grantsBefore);

  // A pack in use is not uninstalled out from under a project; the refusal says where.
  const brief = section.locator('[data-pack="diomedes.weekly-brief"]');
  await brief.getByRole('button', { name: 'Uninstall' }).click();
  await brief.getByRole('button', { name: 'Uninstall', exact: true }).last().click();
  await expect(section.getByRole('alert')).toContainText('is on in Pack journey');
  await expect(brief.locator('.pack-state')).toHaveText('1.0.0 · on');
  await page.screenshot({ path: testInfo.outputPath('pack-settings.png'), fullPage: true });
});

test('PACK-UI-02: a local folder installs, updates, rolls back and uninstalls, each confirmed', async ({ page }) => {
  const v1 = await localPack('v1', '1.0.0');
  const v2 = await localPack('v2', '1.1.0');
  const section = await openCapabilities(page);
  const input = section.getByRole('textbox', { name: 'Pack folder' });

  await input.fill(v1);
  await section.getByRole('button', { name: 'Check folder' }).click();
  const inspected = section.locator('.pack-inspected');
  await expect(inspected).toContainText('Acme · digest verified');
  await expect(inspected).toContainText('read-accounting');
  await inspected.getByRole('button', { name: 'Install 1.0.0' }).click();
  const bookkeeping = section.locator('.pack[data-pack="acme.bookkeeping"]').first();
  await expect(bookkeeping.locator('.pack-state')).toHaveText('1.0.0 · off');

  await input.fill(v2);
  await section.getByRole('button', { name: 'Check folder' }).click();
  await section.locator('.pack-inspected').getByRole('button', { name: 'Update to 1.1.0' }).click();
  await expect(bookkeeping.locator('.pack-state')).toHaveText('1.1.0 · off');

  await bookkeeping.getByRole('button', { name: 'Roll back to 1.0.0' }).click();
  await expect(bookkeeping).toContainText('It grants and restores no permission.');
  await bookkeeping.getByRole('button', { name: 'Roll back', exact: true }).click();
  await expect(bookkeeping.locator('.pack-state')).toHaveText('1.0.0 · off');

  await bookkeeping.getByRole('button', { name: 'Uninstall' }).click();
  await bookkeeping.getByRole('button', { name: 'Cancel' }).click();
  await expect(bookkeeping.locator('.pack-state')).toHaveText('1.0.0 · off');
  await bookkeeping.getByRole('button', { name: 'Uninstall' }).click();
  await bookkeeping.getByRole('button', { name: 'Uninstall', exact: true }).last().click();
  await expect(section.locator('.pack[data-pack="acme.bookkeeping"]')).toHaveCount(0);
  await expect(section.locator('.pack-record')).toContainText('You uninstalled Bookkeeping 1.0.0.');
});
