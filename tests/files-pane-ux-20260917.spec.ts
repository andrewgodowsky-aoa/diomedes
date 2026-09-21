import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project } from '../shared/types';

// Synthetic projects, real guarded reads and the built Console. Only deliberate
// read failures/delays are intercepted; no generation or external service is used.
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let projects: Project[];
const longName = `${'long-name-'.repeat(15)}.md`;
const longText = 'unbroken'.repeat(160);
const deepPath = `${Array.from({ length: 20 }, (_, i) => `level-${i}`).join('/')}/deep.txt`;
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${route}: ${response.status}`).toBe(true);
  return response.json() as Promise<T>;
}
const pane = (page: Page) => page.getByRole('complementary', { name: 'Files', exact: true });
const row = (page: Page, name: string) =>
  pane(page)
    .locator('.files-row')
    .filter({
      has: page.locator('.files-name', {
        hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      }),
    });
async function openPane(page: Page) {
  await api('/settings', 'PUT', { openProjects: projects.map((p) => p.id) });
  await page.addInitScript(() => {
    localStorage.setItem('console.files.open', 'true');
    localStorage.setItem('console.files.width', '240');
  });
  await page.route('**/*', async (route) => {
    const requested = new URL(route.request().url());
    if (requested.protocol.startsWith('http') && requested.hostname !== '127.0.0.1')
      throw new Error(`Unexpected external request: ${requested.href}`);
    await route.continue();
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Files fixture A', exact: true }).click();
  await expect(row(page, 'alpha')).toBeVisible();
}

test.beforeAll(async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/files-ux-'));
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  app = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const source of ['client/console/FilesPane.tsx', 'client/console/files.css'])
    expect(built, `Build first: ${source}`).toBeGreaterThan((await fs.stat(source)).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
  projects = [];
  for (const name of ['Files fixture A', 'Files fixture B']) {
    const project = await api<Project>('/projects', 'POST', { name });
    projects.push(project);
    for (const [relative, text] of Object.entries({
      'alpha/nested/inside.txt': 'Nested document',
      'alpha/first.txt': 'First document',
      'beta/second.txt': 'Second document',
      'retry.txt': `Current ${name}`,
      'zulu.txt': longText,
      [longName]: `# ${longText}\n- ${longText}\n\n${longText}\n\n\`\`\`\n${longText}\n\`\`\``,
      [deepPath]: 'Deep document',
    })) {
      const destination = path.join(project.folder, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, text);
    }
  }
  await api('/settings', 'PUT', {
    surface: 'console',
    detail: 'technical',
    openProjects: projects.map((p) => p.id),
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
});
test.afterAll(async () => {
  await app?.locals.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('keyboard follows visible hierarchy, opens preview and restores focus; mouse still toggles', async ({
  page,
}) => {
  await openPane(page);
  await pane(page).getByRole('button', { name: 'Import files', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(row(page, 'alpha')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'beta')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(pane(page).getByRole('button', { name: 'Import files', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(row(page, 'beta')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(row(page, 'alpha')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(row(page, 'alpha')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(row(page, 'nested')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(row(page, 'inside.txt')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(row(page, 'nested')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(row(page, 'nested')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'first.txt')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(pane(page)).toContainText('First document');
  await expect(pane(page).getByRole('button', { name: 'Back', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row(page, 'first.txt')).toBeFocused();
  await expect(row(page, 'first.txt')).toHaveAccessibleName('first.txt');
  await expect(row(page, 'first.txt')).toHaveAccessibleDescription('recorded');
  await page.keyboard.press('End');
  await expect(row(page, 'zulu.txt')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'zulu.txt')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(row(page, 'retry.txt')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(pane(page)).toContainText('Current Files fixture A');
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
  await row(page, 'alpha').click();
  await expect(row(page, 'first.txt')).toHaveCount(0);
  await row(page, 'alpha').click();
  await row(page, 'first.txt').click();
  await expect(pane(page)).toContainText('First document');
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(pane(page).getByRole('tree', { name: 'Project files' })).toBeVisible();
  await expect(pane(page).locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/files-ux-keyboard.png' });
});

test('failed preview offers one explicit retry through the guarded read', async ({ page }) => {
  await openPane(page);
  let reads = 0;
  await page.route('**/documents/read?path=retry.txt', async (route) => {
    reads++;
    if (reads === 1)
      await route.fulfill({ status: 503, json: { error: 'Synthetic preview unavailable' } });
    else await route.continue();
  });
  await row(page, 'retry.txt').click();
  await expect(pane(page)).toContainText('Synthetic preview unavailable');
  expect(reads).toBe(1);
  await pane(page).getByRole('button', { name: 'Retry preview' }).click();
  await expect(pane(page)).toContainText('Current Files fixture A');
  await expect(pane(page)).not.toContainText('Synthetic preview unavailable');
  expect(reads).toBe(2);
  await expect(pane(page).getByRole('button', { name: 'Back', exact: true })).toBeFocused();
});

for (const destination of ['file', 'project'] as const)
  for (const outcome of ['success', 'failure'] as const)
    test(`late retry ${outcome} cannot replace a newer ${destination} preview`, async ({
      page,
    }) => {
      await openPane(page);
      let reads = 0;
      let finish: (() => void) | undefined;
      const delayed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let delivered: (() => void) | undefined;
      const delivery = new Promise<void>((resolve) => {
        delivered = resolve;
      });
      await page.route(
        `**/projects/${projects[0].id}/documents/read?path=retry.txt`,
        async (route) => {
          reads++;
          if (reads === 1)
            await route.fulfill({ status: 503, json: { error: 'Try this read again' } });
          else {
            await delayed;
            await route.fulfill(
              outcome === 'success'
                ? { json: { path: 'retry.txt', text: 'STALE PROJECT A', sha: 'synthetic' } }
                : { status: 503, json: { error: 'STALE PROJECT A' } },
            );
            delivered!();
          }
        },
      );
      try {
        await row(page, 'retry.txt').click();
        await pane(page).getByRole('button', { name: 'Retry preview' }).click();
        await expect(pane(page).getByRole('status')).toHaveText('Reading...');
        await expect.poll(() => reads).toBe(2);
        if (destination === 'file') {
          await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
          await row(page, 'zulu.txt').click();
          await expect(pane(page).locator('.files-raw')).toHaveText(longText);
        } else {
          await page.getByRole('button', { name: 'Files fixture B', exact: true }).click();
          await row(page, 'retry.txt').click();
          await expect(pane(page)).toContainText('Current Files fixture B');
        }
        finish!();
        await delivery;
        await expect(pane(page)).not.toContainText('STALE PROJECT A');
        await expect(pane(page).locator('.files-raw')).toHaveText(
          destination === 'file' ? longText : 'Current Files fixture B',
        );
      } finally {
        finish!();
      }
    });

test('Ctrl+K opens a collapsed descendant and Back restores its revealed row', async ({ page }) => {
  await openPane(page);
  await expect(row(page, 'inside.txt')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Find and act' });
  await palette.getByRole('textbox').fill('inside.txt');
  await palette.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(pane(page)).toContainText('Nested document');
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(row(page, 'inside.txt')).toBeFocused();
  await expect(row(page, 'alpha')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'nested')).toHaveAttribute('aria-expanded', 'true');
  await expect(pane(page).getByRole('textbox')).toHaveCount(0);
});

test('deep rows and long rendered/raw content stay bounded at narrow and zoomed widths', async ({
  page,
}) => {
  await openPane(page);
  await page.setViewportSize({ width: 640, height: 800 });
  for (let i = 0; i < 20; i++) await row(page, `level-${i}`).click();
  const overflow = () =>
    pane(page)
      .locator('.files-body')
      .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);
  await expect(row(page, 'deep.txt').locator('.files-name')).toBeVisible();
  expect(
    await row(page, 'deep.txt')
      .locator('.files-name')
      .evaluate((el) => el.clientWidth),
  ).toBeGreaterThan(35);
  await row(page, longName).click();
  await expect(pane(page).locator('.files-md')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(1);
  await expect(pane(page).locator('.files-path')).toHaveText(longName);
  await page.screenshot({ path: 'test-results/files-ux-narrow-rendered.png' });
  await pane(page).getByRole('button', { name: 'Raw', exact: true }).click();
  expect(await overflow()).toBeLessThanOrEqual(1);
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  expect(await overflow()).toBeLessThanOrEqual(1);
  await pane(page).locator('.files-raw').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/files-ux-zoomed-raw.png' });
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
  await row(page, 'zulu.txt').click();
  await expect(pane(page).locator('.files-raw')).toHaveText(longText);
  expect(await overflow()).toBeLessThanOrEqual(1);
});
