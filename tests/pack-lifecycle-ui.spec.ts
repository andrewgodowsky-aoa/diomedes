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
let otherProjectId = '';
let sources = '';
let pageErrors: string[] = [];

async function localPack(name: string, version: string, id = 'acme.bookkeeping') {
  const folder = path.join(sources, name);
  await fs.mkdir(path.join(folder, 'playbooks'), { recursive: true });
  const text = `# Month-end close ${version}\n`;
  await fs.writeFile(path.join(folder, 'playbooks', 'close.md'), text);
  const manifest = sealManifest({
    schemaVersion: 1,
    id,
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
    files: [
      {
        path: 'playbooks/close.md',
        sha256: sha256(Buffer.from(text)),
        bytes: Buffer.byteLength(text),
      },
    ],
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
          onboarding: {
            resumeAt: 'done',
            work: 'business',
            detail: 'guided',
            familiarity: 'comfortable',
          },
          detail: 'guided',
        },
      })
    ).ok(),
  ).toBe(true);
  const created = await request.post('/api/projects', {
    headers: HEADERS,
    data: { name: 'Pack journey' },
  });
  expect(created.ok()).toBe(true);
  projectId = ((await created.json()) as Project).id;
  const other = await request.post('/api/projects', {
    headers: HEADERS,
    data: { name: 'Other plugin project' },
  });
  expect(other.ok()).toBe(true);
  otherProjectId = ((await other.json()) as Project).id;
  expect(
    (
      await request.post(`/api/projects/${projectId}/threads`, {
        headers: HEADERS,
        data: { name: THREAD },
      })
    ).ok(),
  ).toBe(true);
  sources = path.resolve('test-results', `pack-sources-${Date.now()}`);
});

test.afterAll(async ({ request }) => {
  // Leave the shared service as later specs expect it: nothing extra on or installed.
  for (const id of ['acme.bookkeeping', 'diomedes.industry.carpentry', 'diomedes.weekly-brief'])
    await request.post(`/api/projects/${projectId}/packs/${id}/deactivate`, {
      headers: HEADERS,
      data: {},
    });
  for (const id of ['diomedes.industry.carpentry', 'diomedes.weekly-brief', 'acme.bookkeeping'])
    await request.post(`/api/packs/${id}/uninstall`, { headers: HEADERS, data: {} });
  await request.post(`/api/projects/${projectId}/packs/diomedes.software-engineering/deactivate`, {
    headers: HEADERS,
    data: {},
  });
  await request.put('/api/settings', {
    headers: HEADERS,
    data: JSON.parse(JSON.stringify(originalSettings)),
  });
  await fs.rm(sources, { recursive: true, force: true });
});

async function openPlugins(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Plugins', exact: true })
    .click();
  const section = page.getByRole('region', { name: 'Plugins', exact: true });
  await expect(section).toBeVisible();
  await section.getByRole('combobox', { name: 'Project', exact: true }).selectOption(projectId);
  await expect(section.locator('[data-pack="diomedes.software-engineering"]')).toBeVisible();
  return section;
}

test('PLUGINS-01: Settings uses the same lifecycle and project activation does not grant permission', async ({
  page,
}, testInfo) => {
  const otherBefore = await (
    await page.request.get(`/api/projects/${otherProjectId}/packs`)
  ).json();
  const section = await openPlugins(page);
  const engineering = section.locator('[data-pack="diomedes.software-engineering"]');
  await expect(engineering).toContainText('Inactive in this project');
  const before = await (
    await page.request.get(`/api/projects/${projectId}/permissions/grants`)
  ).json();
  await engineering.getByRole('button', { name: 'Activate', exact: true }).click();
  await expect(engineering).toContainText('Active in this project');
  const after = await (
    await page.request.get(`/api/projects/${projectId}/permissions/grants`)
  ).json();
  expect(after).toEqual(before);
  await engineering.getByText('Components and provenance', { exact: true }).click();
  await expect(engineering).toContainText('Diomedes (declared)');
  await expect(engineering).toContainText('sha256:');
  await expect(engineering).toContainText('No loads in the recent project records.');
  await expect(engineering).toContainText('Built-in runtime support');
  await page.screenshot({ path: testInfo.outputPath('plugins-settings.png'), fullPage: true });
  await section
    .getByRole('combobox', { name: 'Project', exact: true })
    .selectOption(otherProjectId);
  await expect(engineering).toContainText('Inactive in this project');
  const selected = await (await page.request.get(`/api/projects/${otherProjectId}/packs`)).json();
  expect(selected.activations).toEqual(otherBefore.activations);
  await page.request.post(
    `/api/projects/${projectId}/packs/diomedes.software-engineering/deactivate`,
    { headers: HEADERS, data: {} },
  );
});

test('PLUGINS-02: imported metadata stays declared-only and load receipts stay attributed', async ({
  page,
}) => {
  const folder = await localPack('plugins-import', '1.0.0');
  const file = path.join(folder, 'diomedes-pack.json');
  const { digest: _digest, ...body } = JSON.parse(await fs.readFile(file, 'utf8'));
  body.contributions.workflows.push({
    id: 'close',
    kind: 'skill',
    name: 'Close accounts',
    description: 'Review the month.',
    mode: 'plan',
    acts: false,
  });
  await fs.writeFile(file, JSON.stringify(sealManifest(body)));
  const section = await openPlugins(page);
  await section.getByRole('textbox', { name: 'Pack folder' }).fill(folder);
  await section.getByRole('button', { name: 'Check folder' }).click();
  const inspected = section.locator('.pack-inspected');
  await inspected.getByText('Components and provenance', { exact: true }).click();
  await expect(inspected).toContainText('Skill: Close accounts');
  await inspected.getByRole('button', { name: 'Install 1.0.0' }).click();
  const imported = section.locator('[data-pack="acme.bookkeeping"]').first();
  await expect(imported).toContainText('this build does not run them yet');
  await imported.getByRole('button', { name: 'Activate', exact: true }).click();
  // Read through the real contribution endpoint: this is a metadata load, not
  // a custom-skill execution or proof of a completed task.
  const read = await page.request.post(
    `/api/projects/${projectId}/packs/acme.bookkeeping/contributions/workflow/close/open`,
    { headers: HEADERS, data: {} },
  );
  expect(read.ok()).toBe(true);
  const loaded = await read.json();
  expect(loaded.packVersion).toBe('1.0.0');
  await section
    .getByRole('combobox', { name: 'Project', exact: true })
    .selectOption(otherProjectId);
  await section.getByRole('combobox', { name: 'Project', exact: true }).selectOption(projectId);
  await imported.getByText('Components and provenance', { exact: true }).click();
  await expect(imported).toContainText('Close accounts · 1.0.0 · opened');
  await expect(imported).toContainText(loaded.digest);
  await expect(imported).toContainText(`${loaded.kind}/${loaded.id}`);
  await expect(imported).toContainText('not permission to act or a successful result');
  await imported.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(imported).toContainText('Inactive in this project');
  await imported.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await imported
    .getByRole('group', { name: 'Confirm', exact: true })
    .getByRole('button', { name: 'Uninstall', exact: true })
    .click();
  await expect(section.locator('[data-pack="acme.bookkeeping"]')).toHaveCount(0);
});

test('PLUGINS-03: switching projects discards pending actions and late responses', async ({
  page,
}) => {
  const section = await openPlugins(page);
  const engineering = section.locator('[data-pack="diomedes.software-engineering"]');
  await engineering.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect(section.getByRole('group', { name: 'Confirm', exact: true })).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const response = await page.request.get(`/api/projects/${otherProjectId}/packs`);
  const stale = await response.json();
  stale.storeProblem = 'STALE_OTHER_PROJECT';
  await page.route(`**/api/projects/${otherProjectId}/packs`, async (route) => {
    await held;
    await route.fulfill({ json: stale });
  });
  await section
    .getByRole('combobox', { name: 'Project', exact: true })
    .selectOption(otherProjectId);
  await expect(section.getByRole('group', { name: 'Confirm', exact: true })).toHaveCount(0);
  await expect(section.getByText('Reading plugins...', { exact: true })).toBeVisible();
  await section.getByRole('combobox', { name: 'Project', exact: true }).selectOption(projectId);
  release();
  await expect(engineering).toBeVisible();
  await expect(section).not.toContainText('STALE_OTHER_PROJECT');
  await expect(section.getByRole('group', { name: 'Confirm', exact: true })).toHaveCount(0);
});

test('PLUGINS-04: an unavailable list offers retry without actionable stale inventory', async ({
  page,
}) => {
  let fail = true;
  await page.route(`**/api/projects/${projectId}/packs`, async (route) => {
    if (fail) await route.fulfill({ status: 503, json: { error: 'Plugin list unavailable.' } });
    else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Plugins', exact: true })
    .click();
  const section = page.getByRole('region', { name: 'Plugins', exact: true });
  await section.getByRole('combobox', { name: 'Project', exact: true }).selectOption(projectId);
  await expect(section.getByRole('alert')).toHaveText('Plugin list unavailable.');
  await expect(section.locator('[data-pack]')).toHaveCount(0);
  await expect(section.getByRole('textbox', { name: 'Pack folder' })).toHaveCount(0);
  fail = false;
  await section.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(section.locator('[data-pack="diomedes.software-engineering"]')).toBeVisible();
});

test('PLUGINS-05: checking another folder discards the previous install confirmation', async ({
  page,
}) => {
  const first = await localPack('pending-first', '1.0.0', 'acme.pending');
  const second = await localPack('pending-second', '1.1.0', 'acme.pending');
  const requested: string[] = [];
  await page.route('**/api/packs/install', async (route) => {
    requested.push(route.request().postDataJSON().source.path);
    await route.fulfill({
      status: 409,
      json: {
        error: 'Bookkeeping needs Weekly brief installed too.',
        code: 'needs-dependencies',
        dependencies: [{ id: 'diomedes.weekly-brief', name: 'Weekly brief', version: '1.0.0' }],
      },
    });
  });
  const section = await openPlugins(page);
  const input = section.getByRole('textbox', { name: 'Pack folder' });
  const inspected = section.locator('.pack-inspected');
  await input.fill(first);
  await section.getByRole('button', { name: 'Check folder', exact: true }).click();
  await inspected.getByRole('button', { name: 'Install 1.0.0', exact: true }).click();
  await expect(inspected.getByRole('group', { name: 'Confirm', exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
  await input.fill(second);
  await section.getByRole('button', { name: 'Check folder', exact: true }).click();
  await expect(inspected.getByRole('button', { name: 'Install 1.1.0', exact: true })).toBeVisible();
  await expect(section.getByRole('group', { name: 'Confirm', exact: true })).toHaveCount(0);
  expect(requested).toEqual([first]);
});

test('PLUGINS-06: a damaged store response discards confirmations before retry', async ({
  page,
}) => {
  const section = await openPlugins(page);
  const snapshot = await (await page.request.get(`/api/projects/${projectId}/packs`)).json();
  let broken = true;
  await page.route(`**/api/projects/${projectId}/packs`, async (route) => {
    await route.fulfill({
      json: { ...snapshot, storeProblem: broken ? 'STORE_UNREADABLE' : null },
    });
  });
  await page.route('**/api/packs/install', async (route) => {
    await route.fulfill({
      status: 409,
      json: {
        error: 'Carpentry needs Weekly brief installed too.',
        code: 'needs-dependencies',
        dependencies: [{ id: 'diomedes.weekly-brief', name: 'Weekly brief', version: '1.0.0' }],
      },
    });
  });
  await section
    .locator('[data-pack="diomedes.industry.carpentry"]')
    .getByRole('button', { name: 'Install', exact: true })
    .click();
  await expect(section.getByRole('alert')).toHaveText('STORE_UNREADABLE');
  await expect(section.locator('[data-pack]')).toHaveCount(0);
  broken = false;
  await section.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(section.locator('[data-pack="diomedes.software-engineering"]')).toBeVisible();
  await expect(section.getByRole('group', { name: 'Confirm', exact: true })).toHaveCount(0);
});

test('PLUGINS-07: a late activation response stays with the project that requested it', async ({
  page,
}) => {
  const section = await openPlugins(page);
  const engineering = section.locator('[data-pack="diomedes.software-engineering"]');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const endpoint = `/api/projects/${projectId}/packs/diomedes.software-engineering/activate`;
  await page.route(`**${endpoint}`, async (route) => {
    await held;
    await route.fulfill({ response: await route.fetch() });
  });
  try {
    await engineering.getByRole('button', { name: 'Activate', exact: true }).click();
    await expect(
      engineering.getByRole('button', { name: 'Saving...', exact: true }),
    ).toBeDisabled();
    await section
      .getByRole('combobox', { name: 'Project', exact: true })
      .selectOption(otherProjectId);
    await expect(engineering).toContainText('Inactive in this project');
    const response = page.waitForResponse((item) => item.url().endsWith(endpoint));
    release();
    expect((await response).ok()).toBe(true);
    const other = await (await page.request.get(`/api/projects/${otherProjectId}/packs`)).json();
    expect(other.activations).toEqual([]);
    await expect(engineering).toContainText('Inactive in this project');
    await expect(section.getByRole('alert')).toHaveCount(0);
  } finally {
    release();
    await page.request.post(
      `/api/projects/${projectId}/packs/diomedes.software-engineering/deactivate`,
      { headers: HEADERS, data: {} },
    );
  }
});

async function openCapabilities(page: Page) {
  await page.request.put('/api/settings', {
    headers: HEADERS,
    data: { openProjects: [projectId] },
  });
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
  await expect(section.locator('[data-pack="diomedes.weekly-brief"] .pack-state')).toHaveText(
    '1.0.0 · off',
  );
  await expect(carpentry).toContainText('this build does not run them yet');

  const grantsBefore = await (
    await page.request.get(`/api/projects/${projectId}/permissions/grants`)
  ).json();
  await carpentry.getByRole('button', { name: 'Activate' }).click();
  await expect(carpentry).toContainText('needs Weekly brief 1.0.0 on in this project too.');
  await carpentry.getByRole('button', { name: 'Turn on both' }).click();
  await expect(carpentry.locator('.pack-state')).toHaveText('1.0.0 · on');
  await expect(section.locator('[data-pack="diomedes.weekly-brief"] .pack-state')).toHaveText(
    '1.0.0 · on',
  );
  const grantsAfter = await (
    await page.request.get(`/api/projects/${projectId}/permissions/grants`)
  ).json();
  expect(grantsAfter).toEqual(grantsBefore);

  // A pack in use is not uninstalled out from under a project; the refusal says where.
  const brief = section.locator('[data-pack="diomedes.weekly-brief"]');
  await brief.getByRole('button', { name: 'Uninstall' }).click();
  await brief.getByRole('button', { name: 'Uninstall', exact: true }).last().click();
  await expect(section.getByRole('alert')).toContainText('is on in Pack journey');
  await expect(brief.locator('.pack-state')).toHaveText('1.0.0 · on');
  await page.screenshot({ path: testInfo.outputPath('pack-settings.png'), fullPage: true });
});

test('PACK-UI-02: a local folder installs, updates, rolls back and uninstalls, each confirmed', async ({
  page,
}) => {
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
