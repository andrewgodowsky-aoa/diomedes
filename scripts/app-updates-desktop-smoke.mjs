import { _electron as electron, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

// Compiled-candidate evidence. Network bytes and the UI's install callback are
// synthetic; the separate helper checks use the real packaged Electron binary
// and helper. Neither check can launch an installer or alter an installation.
const root = path.resolve('test-results', `updates-desktop-${Date.now()}`);
const evidence = path.resolve('evidence/autonomy-workbench');
const executablePath = path.resolve('release/Diomedes-win32-x64/Diomedes.exe');
const asarPath = path.join(path.dirname(executablePath), 'resources/app.asar');
const helperPath = path.join(asarPath, 'update-helper.mjs');
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checks = [];
const screenshots = [];
const errors = [];
await fs.mkdir(root, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
let desktop;
let fixtureURL;

async function request(base, route, method = 'GET', body) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function screenshot(page, name) {
  const file = path.join(evidence, name);
  await page.screenshot({ path: file, animations: 'disabled' });
  screenshots.push(file);
}

async function readEventually(file) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (Date.now() >= deadline) throw new Error(`Missing helper evidence: ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function realHelperProof(mode) {
  const ownedDir = path.join(root, mode, 'updates');
  await fs.mkdir(ownedDir, { recursive: true });
  const bytes = Buffer.alloc(1_100_000, 7);
  const artifact = {
    path: path.join(ownedDir, 'Diomedes-Experimental-0.1.2-unsigned-setup.exe'),
    size: bytes.length,
    sha256: sha256(bytes),
    version: '0.1.2',
  };
  await fs.writeFile(artifact.path, bytes, { flag: 'wx' });
  const readyFile = path.join(root, mode, 'ready.json');
  const resultFile = path.join(root, mode, 'result.json');
  // This tiny owned parent exits only after its stdin closes. No user process
  // is signalled, and the controller itself is the live-parent timeout case.
  const parent =
    mode === 'tamper-after-exit'
      ? spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
          stdio: ['pipe', 'ignore', 'ignore'],
          windowsHide: true,
          shell: false,
        })
      : null;
  const parentExit = parent ? once(parent, 'exit') : null;
  const payload = {
    schema: 1,
    parentPid: parent?.pid ?? process.pid,
    artifact,
    ownedDir,
    readyFile,
    resultFile,
    waitMs: parent ? 8_000 : 500,
    pollMs: 50,
  };
  let output = '';
  const helper = spawn(executablePath, [helperPath, JSON.stringify(payload)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DIOMEDES_UPDATE_HELPER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  helper.stdout.on('data', (chunk) => {
    output += chunk;
  });
  helper.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const helperExit = once(helper, 'exit');
  try {
    const ready = await readEventually(readyFile);
    expect(ready.parentPid).toBe(payload.parentPid);
    expect(ready.helperPid).toBe(helper.pid);
    expect(ready.artifact.sha256).toBe(artifact.sha256);
    if (parent) {
      // Same length, changed digest: the real helper must detect this only
      // after its exact parent exits, and must never execute these fake bytes.
      await fs.writeFile(artifact.path, Buffer.alloc(bytes.length, 8));
      parent.stdin.end();
      await parentExit;
    }
    const result = await readEventually(resultFile);
    expect(result.status).toBe(parent ? 'mismatch' : 'parent-still-running');
    const [exitCode] = await helperExit;
    expect(exitCode).toBe(1);
    checks.push({ name: `real packaged helper: ${mode}`, ok: true, result });
  } catch (error) {
    throw new Error(`${error.message}\nHelper output: ${output}`);
  } finally {
    if (parent && parent.exitCode === null) parent.stdin.end();
    if (helper.exitCode === null) helper.kill();
  }
}

try {
  const env = {
    ...process.env,
    DIOMEDES_DESKTOP_PROFILE: path.join(root, 'profile'),
    DIOMEDES_DATA_DIR: path.join(root, 'data'),
    DIOMEDES_PROJECTS_DIR: path.join(root, 'projects'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath, env });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  await page.setViewportSize({ width: 1440, height: 960 });
  const defaultURL = new URL(page.url()).origin;
  const status = await request(defaultURL, '/updates/status');
  expect(status).toMatchObject({
    installedVersion: '0.1.1',
    platform: 'win32',
    packaged: true,
    installed: false,
    supported: false,
    check: { phase: 'idle', outcome: null },
  });
  checks.push({ name: 'compiled portable shell facts; no automatic release check', ok: true });
  const settings = {
    surface: 'console',
    detail: 'technical',
    onboarding: {
      work: 'software',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  };
  await request(defaultURL, '/settings', 'PUT', settings);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'App updates', exact: true }).click();
  await expect(page.locator('.app-updates')).toContainText('portable');
  await page.evaluate(() => document.fonts.ready);
  await screenshot(page, 'desktop-app-updates-portable.png');

  // No production hook: load the same compiled factory as main.mjs in the
  // test-controlled Electron VM, with an owned second HTTP fixture host.
  fixtureURL = await desktop.evaluate(async ({ app }) => {
    const nodePath = process.getBuiltinModule('node:path');
    const { createServer } = process.getBuiltinModule('node:http');
    const crypto = process.getBuiltinModule('node:crypto');
    const appPath = app.getAppPath();
    const requireNative = process
      .getBuiltinModule('node:module')
      .createRequire(nodePath.join(appPath, 'package.json'));
    const compiled = requireNative(nodePath.join(appPath, 'server/app.mjs'));
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const bytes = Buffer.alloc(1_100_000, 7);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const assetName = 'Diomedes-Experimental-0.1.2-unsigned-setup.exe';
    const base = 'https://github.com/andrewgodowsky-aoa/diomedes/releases';
    const assetURL = `${base}/download/v0.1.2/${assetName}`;
    const state = { checked: 0, accepted: 0, handedOff: [] };
    const fixture = await compiled.createApp({
      dataDir: nodePath.join(process.env.DIOMEDES_DESKTOP_PROFILE, '..', 'fixture-data'),
      projectRoot: nodePath.join(process.env.DIOMEDES_DESKTOP_PROFILE, '..', 'fixture-projects'),
      port,
      clientPort: port,
      updateOverrides: {
        platform: 'win32',
        packaged: true,
        installed: true,
        onInstallAccepted: () => {
          state.accepted += 1;
        },
        transport: {
          fetchRelease: async () => {
            state.checked += 1;
            return {
              tag_name: 'v0.1.2',
              html_url: `${base}/tag/v0.1.2`,
              prerelease: false,
              draft: false,
              assets: [
                {
                  name: assetName,
                  browser_download_url: assetURL,
                  size: bytes.length,
                  digest: `sha256:${digest}`,
                },
              ],
            };
          },
          downloadAsset: async () => ({ bytes, finalUrl: assetURL }),
          launchInstaller: async (artifact) => {
            state.handedOff.push(artifact);
          },
        },
      },
    });
    compiled.serveClient(fixture, nodePath.join(appPath, 'dist'));
    server.on('request', fixture);
    globalThis.__updateFixture = { app: fixture, server, state };
    return `http://127.0.0.1:${port}`;
  });
  await request(fixtureURL, '/settings', 'PUT', settings);
  await page.goto(fixtureURL);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'App updates', exact: true }).click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.app-updates')).toContainText('Version 0.1.2 is available');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.app-updates')).toContainText('published digest verified');
  await screenshot(page, 'desktop-app-updates-verified.png');
  await page.getByRole('button', { name: 'Close and install', exact: true }).click();
  await expect(page.locator('.app-updates')).toContainText('Update handoff accepted.');
  await expect(page.getByRole('button', { name: 'Close and install', exact: true })).toBeDisabled();
  const effects = await desktop.evaluate(() => globalThis.__updateFixture.state);
  expect(effects.checked).toBe(1);
  expect(effects.accepted).toBe(1);
  expect(effects.handedOff).toHaveLength(1);
  expect(sha256(await fs.readFile(effects.handedOff[0].path))).toBe(effects.handedOff[0].sha256);
  await screenshot(page, 'desktop-app-updates-handoff.png');
  checks.push({
    name: 'compiled UI check, digest verification and accepted-response handoff',
    ok: true,
    effects,
    synthetic: true,
  });
  expect(errors).toEqual([]);
} finally {
  if (desktop) {
    if (fixtureURL)
      await desktop.evaluate(async () => {
        const fixture = globalThis.__updateFixture;
        await fixture.app.locals.close();
        fixture.server.closeAllConnections();
        await new Promise((resolve) => fixture.server.close(resolve));
      });
    await desktop.close();
  }
}

await realHelperProof('parent-still-running');
await realHelperProof('tamper-after-exit');
const build = JSON.parse(await fs.readFile('evidence/windows-release/build-info.json', 'utf8'));
await fs.writeFile(
  path.join(evidence, 'app-updates-desktop-proof.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      root,
      executablePath,
      asarPath,
      helperPath,
      sourceDigest: build.sourceDigest,
      exeSha256: sha256(await fs.readFile(executablePath)),
      asarSha256: sha256(await fs.readFile(asarPath)),
      checks,
      screenshots,
      errors,
      limits:
        'UI release bytes and install effects are injected. Real packaged helper startup, parent wait and post-exit digest refusal are verified. No actual installer or published upgrade ran.',
    },
    null,
    2,
  ) + '\n',
);
console.log('PASS: compiled application updates and real packaged helper boundaries.');
