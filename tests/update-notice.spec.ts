import { test, expect } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { createApp } from '../server/app';
import { defaults } from '../server/store';
import type { Settings } from '../shared/types';

// The first launch of a new build, in the browser. The data folder is the one
// an older build left: its build recorded, the appearance still at that
// build's default (Field) and never chosen, and the detail level chosen. The
// service under test is the real one at this checkout's own build, so the
// version change is the older build's record meeting this build, as it does
// after an installer run. Nothing here reaches the network.
test.describe.configure({ mode: 'serial' });

const { version: appVersion } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
const OLDER = { version: '0.1.10', buildId: '0.1.10+46891e4dacbc' };

let baseURL = '';
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;

async function seedOlderBuild(dataDir: string) {
  await fs.mkdir(dataDir, { recursive: true });
  const settings: Settings = {
    ...defaults(),
    detail: 'technical',
    appearance: { package: 'field', motion: 'normal' },
    onboarding: {
      ...defaults().onboarding,
      work: 'software',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: '2026-09-20T09:00:00.000Z',
    },
  };
  const write = (name: string, value: unknown) =>
    fs.writeFile(path.join(dataDir, name), JSON.stringify(value, null, 2));
  await write('settings.json', settings);
  await write('last-build.json', { version: 1, app: OLDER, recordedAt: '2026-09-20T09:00:00.000Z' });
  await write('settings-provenance.json', {
    version: 1,
    settingsSchemaVersion: 2,
    fields: {
      'appearance.package': { source: 'default', value: 'field', since: OLDER.buildId },
      'appearance.motion': { source: 'default', value: 'normal', since: OLDER.buildId },
      view: { source: 'default', value: 'architect', since: OLDER.buildId },
      detail: { source: 'chosen', at: '2026-09-20T09:00:00.000Z' },
      explanations: { source: 'default', value: 'persistent', since: OLDER.buildId },
    },
  });
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'update-notice-ui-'));
  await seedOlderBuild(path.join(root, 'data'));
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port.');
  baseURL = `http://127.0.0.1:${address.port}`;
  application = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    port: address.port,
    clientPort: address.port,
    automationTickMs: null,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server.on('request', application);
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('the first launch of a new build says so in one line, once', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseURL);

  const notice = page.locator('.update-notice');
  await expect(notice).toHaveText(
    new RegExp(`Updated to ${appVersion.replaceAll('.', '\\.')} — 1 setting moved to new defaults\\.`),
  );
  await expect(notice).toHaveCount(1);
  // The never-chosen scheme moved to this build's default, and it is what is painted.
  await expect(page.locator('html')).toHaveAttribute('data-package', 'nectovia');
  // The chosen detail level was kept.
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'technical');

  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
  // A restart of the same build neither re-runs the reconcile nor repeats the line.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-package', 'nectovia');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('.update-notice')).toHaveCount(0);
  expect(errors).toEqual([]);
});
