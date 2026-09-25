import { test, expect, type Page } from '@playwright/test';
import type { Project, ProjectState, Settings } from '../shared/types';
import type { ContributionRecord } from '../shared/pack-contributions';
import { reopenLastProject } from './fixtures/landing';

/**
 * P04 in the Console: a pack's playbook panel appears only when the pack is on
 * in the project and a person opens it, and the body is loaded only then —
 * recorded in History with the pack version and digest it was read at.
 */

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const PACK = 'diomedes.small-business';
let originalSettings: Settings | null = null;
let projectId = '';
let pageErrors: string[] = [];

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
  const created = await request.post('/api/projects', { headers: HEADERS, data: { name: 'Playbook journey' } });
  expect(created.ok()).toBe(true);
  projectId = ((await created.json()) as Project).id;
});

test.afterAll(async ({ request }) => {
  await request.post(`/api/projects/${projectId}/packs/${PACK}/deactivate`, { headers: HEADERS, data: {} });
  await request.put('/api/settings', { headers: HEADERS, data: JSON.parse(JSON.stringify(originalSettings)) });
});

async function openProject(page: Page) {
  await page.request.put('/api/settings', { headers: HEADERS, data: { openProjects: [projectId] } });
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
}

async function palette(page: Page, query: string) {
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Find and act' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill(query);
  return dialog;
}

const records = async (page: Page) =>
  ((await (await page.request.get(`/api/projects/${projectId}/packs/contributions`)).json()) as {
    records: ContributionRecord[];
    indexes: unknown[];
  });

test('P04-UI-01: off, the playbook panel cannot be opened and nothing loads', async ({ page }) => {
  await openProject(page);
  const dialog = await palette(page, 'cash flow');
  const row = dialog.getByRole('listitem').filter({ hasText: 'Small Business skills' });
  await expect(row).toContainText('12 playbooks, off in this project');
  await expect(row.getByRole('button', { name: 'Turn on' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Read' })).toHaveCount(0);
  await expect(page.getByTestId('playbook-panel')).toHaveCount(0);
  const listing = await records(page);
  expect(listing.indexes).toEqual([]);
  expect(listing.records).toEqual([]);
});

test('P04-UI-02: on, the panel appears when opened, loads the body then, and History names what was read', async ({
  page,
}, testInfo) => {
  await openProject(page);
  // Turning the pack on from the palette registers the index and loads no body.
  let dialog = await palette(page, 'cash flow');
  await dialog.getByRole('listitem').filter({ hasText: 'Small Business skills' }).getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('Small Business skills are on for this project.')).toBeVisible();
  const indexed = await records(page);
  expect(indexed.records.map((r) => r.outcome)).toEqual(['indexed']);
  await expect(page.getByTestId('playbook-panel')).toHaveCount(0);

  dialog = await palette(page, 'Cash flow snapshot');
  const row = dialog.getByRole('listitem').filter({ hasText: 'Cash flow snapshot' });
  await expect(row.getByRole('button', { name: 'Use' })).toBeVisible();
  await row.getByRole('button', { name: 'Read' }).click();

  const panel = page.getByRole('dialog', { name: 'Cash flow snapshot' });
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('playbook-panel')).toContainText('Playbook: Cash flow snapshot (cash-flow-snapshot, version 0.1.0)');
  await expect(panel.locator('.playbook-meta')).toContainText('version 0.1.0');

  // Opened once, loaded once.
  const after = (await records(page)).records;
  expect(after.map((r) => r.outcome)).toEqual(['indexed', 'loaded']);
  const loaded = after.at(-1)!;
  expect(loaded).toMatchObject({
    outcome: 'loaded',
    packId: PACK,
    packVersion: '0.1.0',
    kind: 'workflow',
    contributionId: 'cash-flow-snapshot',
    reason: 'opened',
  });
  await expect(panel.locator('.playbook-digest')).toHaveText(loaded.digest!.slice(7, 19));
  const state = (await (await page.request.get(`/api/projects/${projectId}/state`)).json()) as ProjectState;
  expect(state.history.map((entry) => entry.sentence)).toContain(
    `Diomedes loaded the playbook Cash flow snapshot from Small Business 0.1.0 (${loaded.digest!.slice(7, 19)}) because you opened it.`,
  );
  // No horizontal overflow in the panel at this width (decision 5).
  const overflow = await panel.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('playbook-panel.png') });
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // Off again: the rows lose Read, and a direct open is refused.
  expect(
    (await page.request.post(`/api/projects/${projectId}/packs/${PACK}/deactivate`, { headers: HEADERS, data: {} })).ok(),
  ).toBe(true);
  await page.reload();
  await expect(page.locator('.console')).toBeVisible();
  dialog = await palette(page, 'cash flow');
  await expect(dialog.getByRole('button', { name: 'Read' })).toHaveCount(0);
  const refused = await page.request.post(
    `/api/projects/${projectId}/packs/${PACK}/contributions/workflow/cash-flow-snapshot/open`,
    { headers: HEADERS, data: {} },
  );
  expect(refused.status()).toBe(409);
  expect((await records(page)).records.at(-1)?.outcome).toBe('unloaded');
});
