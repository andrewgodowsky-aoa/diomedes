import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { createApp } from '../server/app';
import { ApiError } from '../server/paths';
import type { UpdateInstallArtifact } from '../shared/app-updates';

// Browser contract fixture for Settings > App updates. The release channel,
// download bytes and installer handoff below are injected fixtures: no
// network reaches github.com and no installer ever launches. The service
// still exercises the real explicit check, verify, stage and guarded
// install path through the Console UI. Parent executes this spec;
// it is not run by the update slice itself.
test.describe.configure({ mode: 'serial' });

let baseURL = '';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const NEXT = '0.1.2';
const ASSET = `Diomedes-Experimental-${NEXT}-unsigned-setup.exe`;
const ASSET_URL = `https://github.com/andrewgodowsky-aoa/diomedes/releases/download/v${NEXT}/${ASSET}`;
const SIZE = 1_100_000;

const bytes = new Uint8Array(SIZE).fill(7);
const sha = createHash('sha256').update(bytes).digest('hex');
const payload = {
  tag_name: `v${NEXT}`,
  html_url: `https://github.com/andrewgodowsky-aoa/diomedes/releases/tag/v${NEXT}`,
  body: `Notes for ${NEXT}.\n\nSHA-256: ${sha}`,
  prerelease: false,
  draft: false,
  assets: [
    {
      name: ASSET,
      browser_download_url: ASSET_URL,
      size: SIZE,
      digest: `sha256:${sha}`,
      state: 'uploaded',
    },
  ],
};
const launched: UpdateInstallArtifact[] = [];
let checked = 0;
let accepted = 0;
let feed: 'missing' | 'offline' | 'available' = 'missing';

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(
      `App updates UI fixture request ${route} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json() as Promise<T>;
}

let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let fixtureRoot: string | undefined;

async function expectFreshBundle(dist: string): Promise<void> {
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  let newest = 0;
  let newestPath = '';
  for (const dir of ['client', 'shared']) {
    for (const entry of await fs.readdir(path.resolve(dir), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.resolve(dir, entry.name);
      const { mtimeMs } = await fs.stat(file);
      if (mtimeMs > newest) {
        newest = mtimeMs;
        newestPath = path.relative(process.cwd(), file);
      }
    }
  }
  expect(built, `dist is older than ${newestPath}; run "npm run build" first.`).toBeGreaterThan(
    newest,
  );
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'app-updates-ui-'));
  fixtureRoot = root;
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const port = address.port;
  baseURL = `http://127.0.0.1:${port}`;
  application = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    port,
    clientPort: port,
    updateOverrides: {
      platform: 'win32',
      packaged: true,
      installed: true,
      onInstallAccepted: () => {
        accepted += 1;
      },
      transport: {
        fetchRelease: async () => {
          checked += 1;
          if (feed === 'missing') throw new ApiError(404, 'NO_RELEASE', { code: 'no-release' });
          if (feed === 'offline') throw new ApiError(503, 'Fixture release channel is offline.');
          return structuredClone(payload);
        },
        downloadAsset: async () => ({ bytes, finalUrl: ASSET_URL }),
        launchInstaller: async (artifact) => {
          launched.push(artifact);
        },
      },
    },
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  await expectFreshBundle(dist);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server.on('request', application);
  await api('/settings', 'PUT', {
    surface: 'console',
    detail: 'technical',
    onboarding: {
      work: 'software',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  // Keep this small disposable profile for inspection of staged-file evidence.
});

test('Settings > App updates checks, downloads, verifies and hands off', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseURL);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'App updates', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'App updates', level: 2 })).toBeVisible();
  await expect(page.locator('.app-updates')).toContainText('Current version 0.1.1');
  expect(checked).toBe(0);

  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.app-updates')).toContainText('No public release');
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
  feed = 'offline';
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('offline');
  await expect(page.getByRole('button', { name: 'Close and install', exact: true })).toHaveCount(0);

  feed = 'available';
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.app-updates')).toContainText(`Version ${NEXT} is available`);
  await expect(
    page.locator('.app-updates').getByRole('link', { name: 'Release notes' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.app-updates')).toContainText(ASSET);
  await expect(page.locator('.app-updates')).toContainText('published digest verified');
  await fs.mkdir('evidence/autonomy-workbench', { recursive: true });
  await page.screenshot({
    path: 'evidence/autonomy-workbench/app-updates-verified.png',
    animations: 'disabled',
  });

  await page.getByRole('button', { name: 'Close and install', exact: true }).click();
  await expect(page.locator('.app-updates')).toContainText('Update handoff accepted.');
  expect(launched).toHaveLength(1);
  expect(launched[0].path.endsWith(ASSET)).toBe(true);
  expect(launched[0].sha256).toBe(sha);
  await expect.poll(() => accepted).toBe(1);
  await expect(page.getByRole('button', { name: 'Close and install', exact: true })).toBeDisabled();
  await page.screenshot({
    path: 'evidence/autonomy-workbench/app-updates-handoff.png',
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});
