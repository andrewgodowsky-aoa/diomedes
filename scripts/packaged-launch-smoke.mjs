import { _electron as electron, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SMOKE_ACCOUNT, signInFromWindow, startSmokeAccountService } from './smoke-account-service.mjs';

// Launch one packaged Diomedes executable, prove its local service answers, and quit.
//
//   node scripts/packaged-launch-smoke.mjs <executable> <new proof directory>
//
// Platform-neutral: the release workflow runs it on the macOS package, where the
// full Windows smoke (scripts/desktop-smoke.mjs) has nothing to drive yet. It
// starts the app on a fresh profile, data and projects folder and an empty
// CODEX_HOME, so it touches no existing install, and points it at a local test
// account service (scripts/smoke-account-service.mjs), never the deployed one. It then:
//   - waits for the window to load the app from 127.0.0.1;
//   - signs the service's seeded owner in from that window, because the app
//     answers nothing but sign-in until someone signs in;
//   - asks /api/health from inside that window, which is the only caller the
//     service answers (desktop/main.mjs adds the per-launch session header), and
//     requires ok and this package.json's version;
//   - asks the same URL from this process and requires 401, so the service is
//     not open to any other program on the machine;
//   - quits, and requires the data lock released and the port closed.
// It writes proof.json in the proof directory, with passed=false and the error
// when any step fails, and exits non-zero on failure.

const { version: appVersion } = JSON.parse(
  await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const executablePath = path.resolve(process.argv[2] ?? '');
const root = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3])
  throw new Error(
    'Usage: node scripts/packaged-launch-smoke.mjs <executable> <new proof directory>',
  );
await fs.mkdir(path.dirname(root), { recursive: true });
await fs.mkdir(root);

const env = {
  ...process.env,
  DIOMEDES_DESKTOP_PROFILE: path.join(root, 'profile'),
  DIOMEDES_DATA_DIR: path.join(root, 'data'),
  DIOMEDES_PROJECTS_DIR: path.join(root, 'projects'),
  CODEX_HOME: path.join(root, 'codex-home'),
};
delete env.ELECTRON_RUN_AS_NODE;
await fs.mkdir(env.CODEX_HOME);

const proof = {
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  executable: path.basename(executablePath),
  // The full path is what scripts/write-candidate-record.ts checks lies inside
  // the installer proof's install target when this smoke is its runtime proof.
  executablePath,
  executableSha256: createHash('sha256')
    .update(await fs.readFile(executablePath))
    .digest('hex'),
  appVersion,
  version: null,
  checks: [],
  pageErrors: [],
  errors: [],
  passed: false,
};
const exists = (file) =>
  fs.access(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

let accounts;
let desktop;
try {
  accounts = await startSmokeAccountService(root);
  env.NECTOVIA_ACCOUNT_SERVICE = accounts.url;
  const started = Date.now();
  desktop = await electron.launch({ executablePath, env, cwd: root, timeout: 90_000 });
  const page = await desktop.firstWindow({ timeout: 90_000 });
  page.on('pageerror', (error) => proof.pageErrors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/', { timeout: 90_000 });
  const origin = new URL(page.url()).origin;
  proof.windowLoadedMs = Date.now() - started;
  proof.checks.push('The packaged app opened a window served from 127.0.0.1');

  await signInFromWindow(page);
  proof.signIn = { accountService: 'local test account service (faux cloud)', person: SMOKE_ACCOUNT.email };
  proof.checks.push(`Signed in ${SMOKE_ACCOUNT.email} to a local test account service from inside the app window`);

  const health = await page.evaluate(async () => {
    const response = await fetch('/api/health');
    return { status: response.status, body: await response.json() };
  });
  expect(health.status).toBe(200);
  expect(health.body.ok).toBe(true);
  expect(health.body.version).toBe(appVersion);
  proof.health = {
    status: health.status,
    ok: health.body.ok,
    name: health.body.name,
    version: health.body.version,
    service: health.body.service,
  };
  proof.version = health.body.version;
  proof.checks.push(`/api/health answered ok with version ${appVersion} inside the app window`);

  const outside = await fetch(`${origin}/api/health`);
  expect(outside.status).toBe(401);
  proof.checks.push('The same request from another process was refused with 401');

  const startup = JSON.parse(
    await fs.readFile(path.join(env.DIOMEDES_DATA_DIR, 'desktop-startup.json'), 'utf8'),
  );
  expect(startup.packaged).toBe(true);
  expect(startup.version).toBe(appVersion);
  proof.startup = { version: startup.version, packaged: startup.packaged };
  proof.checks.push('desktop-startup.json records a packaged start of this version');

  await desktop.close();
  desktop = undefined;
  await expect
    .poll(() => exists(path.join(env.DIOMEDES_DATA_DIR, 'service.lock')), { timeout: 30_000 })
    .toBe(false);
  await expect
    .poll(
      () =>
        fetch(`${origin}/api/health`).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(false);
  proof.checks.push('Quitting released the data lock and closed the local port');
  expect(proof.pageErrors).toEqual([]);
  proof.passed = true;
} catch (error) {
  proof.error = error instanceof Error ? error.message : String(error);
  proof.errors.push(proof.error);
  process.exitCode = 1;
} finally {
  if (desktop) await desktop.close().catch(() => {});
  await accounts?.close();
  proof.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof, null, 2));
}
