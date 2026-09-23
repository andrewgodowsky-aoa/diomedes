// Evidence driver only: real installed executables, public updater and native installer.
// No test-mode transport, request interception, provider credentials or product edits.
import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

if (!process.argv.includes('--screen-use-approved')) throw new Error('Immediate user permission is required before this visible desktop proof');
const run = path.resolve(process.argv[2]);
const executablePath = path.join(run, 'installation/app/Diomedes.exe');
const proof = { startedAt: new Date().toISOString(), root: run, executablePath, checks: [], launches: [], errors: [], passed: false };
const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']) {
  if (process.env[key]) env[key] = process.env[key];
}
Object.assign(env, {
  DIOMEDES_DESKTOP_PROFILE: path.join(run, 'profile'), DIOMEDES_DATA_DIR: path.join(run, 'data'),
  DIOMEDES_PROJECTS_DIR: path.join(run, 'projects'), CODEX_HOME: path.join(run, 'empty-codex'),
  USERPROFILE: path.join(run, 'empty-home'), HOME: path.join(run, 'empty-home'),
  APPDATA: path.join(run, 'empty-home/AppData/Roaming'), LOCALAPPDATA: path.join(run, 'empty-home/AppData/Local'),
});
for (const directory of [env.CODEX_HOME, env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA]) await fs.mkdir(directory, { recursive: true });
proof.isolation = { environmentKeys: Object.keys(env).sort(), testMode: false, providerCredentials: false, accountFilesCopied: false };
let desktop, page, origin;
const hash = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (name, value) => fs.writeFile(path.join(run, name), JSON.stringify(value, null, 2) + '\n');
async function api(route, method = 'GET', body) {
  const response = await fetch(origin + '/api' + route, { method, headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const value = await response.json();
  expect(response.ok, `${method} ${route}: ${JSON.stringify(value)}`).toBe(true);
  return value;
}
async function checkpoint(check) { proof.checks.push({ at: new Date().toISOString(), check, passed: true }); await write('runtime-proof.json', proof); console.log(check); }
async function launch(expected) {
  const started = Date.now();
  const identity = { executableSha256: await hash(executablePath), asarSha256: await hash(path.join(path.dirname(executablePath), 'resources/app.asar')) };
  desktop = await electron.launch({ executablePath, env, cwd: run, timeout: 45_000 });
  page = await desktop.firstWindow(); page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => proof.errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/'); origin = new URL(page.url()).origin;
  const health = await api('/health');
  const applicationPath = await desktop.evaluate(({ app }) => app.getAppPath());
  expect(health.version).toBe(expected);
  expect(applicationPath).toBe(path.join(path.dirname(executablePath), 'resources/app.asar'));
  const runtimePid = await desktop.evaluate(() => process.pid);
  proof.launches.push({ pid: runtimePid, launcherPid: desktop.process().pid, origin, version: health.version, readyMs: Date.now() - started, applicationPath, ...identity });
  return identity;
}
async function close() { await desktop.close(); desktop = undefined; }
async function openUpdates() {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'App updates', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'App updates', level: 2 })).toBeVisible();
}
async function projectFiles(folder) {
  const rows = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) rows.push({ path: path.relative(folder, file).replaceAll('\\', '/'), bytes: (await fs.stat(file)).size, sha256: await hash(file) });
      else throw new Error('Unexpected special project file');
    }
  }
  await walk(folder); return rows.sort((a, b) => a.path.localeCompare(b.path));
}
async function state(project) {
  const settings = await api('/settings');
  return { project: (await api('/projects')).projects.find((item) => item.id === project.id),
    settings: Object.fromEntries(['detail', 'surface', 'openProjects', 'lastPage', 'onboarding', 'appearance', 'permissions'].map((key) => [key, settings[key]])),
    state: await api(`/projects/${project.id}/state`), files: await projectFiles(project.folder) };
}
try {
  const manifestUrl = 'https://github.com/andrewgodowsky-aoa/diomedes/releases/download/v0.1.7/release-manifest.json';
  const response = await fetch(manifestUrl); expect(response.ok).toBe(true);
  const manifest = await response.json(); await write('published-manifest.json', manifest);
  expect(manifest.build.commit).toBe('6e2f033b4778d88ff544d11874f3c1aedb2051f7');
  await launch('0.1.6');
  const project = await api('/projects/sample', 'POST', {});
  expect(path.resolve(project.folder).startsWith(env.DIOMEDES_PROJECTS_DIR + path.sep)).toBe(true);
  const found = await api(`/projects/${project.id}/plans/find-tasks`, 'POST', { path: 'Reopening plan.md' });
  expect(found.found.length).toBeGreaterThan(0);
  await api(`/projects/${project.id}/plans/add-tasks`, 'POST', { path: 'Reopening plan.md', items: found.found.slice(0, 2) });
  await api('/settings', 'PUT', { surface: 'console', detail: 'technical', openProjects: [project.id], lastPage: { [project.id]: 'tasks' },
    onboarding: { work: 'business', detail: 'technical', familiarity: 'some', resumeAt: 'done', completedAt: new Date().toISOString() } });
  await fs.writeFile(path.join(project.folder, 'customer-upgrade-sentinel.txt'), 'Synthetic customer-owned file. Preserve exact bytes through the published 0.1.6 to 0.1.7 upgrade.\n');
  await page.reload();
  // 0.1.6 reopens the project; the 0.1.7 Diomedes landing screen did not exist yet.
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await close(); await launch('0.1.6');
  const before = await state(project); await write('state-before.json', before);
  expect(before.state.tasks.length).toBeGreaterThan(0); expect(before.state.history.length).toBeGreaterThan(0);
  await checkpoint('Published 0.1.6 installed, launched, populated and relaunched with persistent synthetic project/tasks/history/settings/files');
  await openUpdates(); proof.initialUpdaterStatus = await api('/updates/status');
  expect(proof.initialUpdaterStatus.supported).toBe(true);
  expect(proof.initialUpdaterStatus.installedVersion).toBe('0.1.6');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.app-updates')).toContainText('Version 0.1.7 is available', { timeout: 45_000 });
  proof.checkedUpdaterStatus = await api('/updates/status');
  await page.screenshot({ path: path.join(run, '01-update-available.png') });
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.locator('.app-updates')).toContainText('size, origin and published digest verified', { timeout: 180_000 });
  proof.downloadedUpdaterStatus = await api('/updates/status');
  const artifact = manifest.artifacts.find((item) => item.kind === 'per-user-installer');
  const staged = path.join(env.DIOMEDES_DATA_DIR, 'updates', artifact.filename);
  expect(await hash(staged)).toBe(artifact.sha256); expect((await fs.stat(staged)).size).toBe(artifact.bytes);
  expect(proof.downloadedUpdaterStatus.download.sha256).toBe(artifact.sha256);
  expect(proof.downloadedUpdaterStatus.workActive).toBe(false);
  await page.screenshot({ path: path.join(run, '02-download-verified.png') });
  await checkpoint('Installed 0.1.6 Settings updater discovered and downloaded real public 0.1.7; staged bytes match published SHA-256 and size');
  const parentPid = proof.launches.at(-1).pid;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/updates/install') && request.method() === 'POST') {
      proof.installRequest = { method: request.method(), body: request.postDataJSON() };
    }
  });
  page.on('response', (response) => {
    if (response.url().endsWith('/api/updates/install')) proof.installResponseStatus = response.status();
  });
  // The app deliberately closes its renderer/CDP during this click. Observe the
  // real PID and helper receipt rather than relying on a Playwright close event.
  const clickOutcome = page.getByRole('button', { name: 'Close and install', exact: true })
    .click({ noWaitAfter: true, timeout: 15_000 })
    .then(() => { proof.installClick = 'returned'; }, (error) => { proof.installClick = String(error); });
  await expect.poll(async () => {
    const dir = path.join(env.DIOMEDES_DATA_DIR, 'update-handoff');
    let names;
    try { names = await fs.readdir(dir); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    for (const name of names.filter((item) => item.endsWith('.result.json'))) {
      const result = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      if (result.status === 'launched') { proof.handoffResult = result; return true; }
    }
    return false;
  }, { timeout: 30_000 }).toBe(true);
  await clickOutcome;
  expect(proof.installRequest.body).toEqual({ assetName: artifact.filename, sha256: artifact.sha256 });
  expect(proof.handoffResult.parentPid).toBe(parentPid);
  expect(proof.handoffResult.artifact.sha256).toBe(artifact.sha256);
  await expect.poll(() => { try { process.kill(parentPid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, { timeout: 10_000 }).toBe(true);
  expect(await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1500) }).then(() => false, () => true)).toBe(true);
  proof.oldProcessExited = true; desktop = undefined;
  await checkpoint('Close and install accepted exact artifact; old app closed and its unmodified helper launched the native installer');
  await fs.writeFile(path.join(run, 'awaiting-native-installer.txt'), 'Complete the actual native wizard using Computer Use; verify its destination. Then write native-installer-completed.json with observed evidence.\n');
  console.log('AWAITING_NATIVE_INSTALLER ' + run);
  const deadline = Date.now() + 15 * 60_000;
  while (true) {
    try { proof.nativeInstaller = JSON.parse(await fs.readFile(path.join(run, 'native-installer-completed.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() > deadline) throw new Error('Native installer completion evidence was not supplied');
    await sleep(500);
  }
  expect(proof.nativeInstaller.installTarget).toBe(path.join(run, 'installation'));
  const current = await launch('0.1.7');
  expect(current.executableSha256).toBe(manifest.internalPackageHashes.executableSha256);
  expect(current.asarSha256).toBe(manifest.internalPackageHashes.asarSha256);
  const after = await state(project); await write('state-after.json', after);
  expect(after).toEqual(before);
  await expect(page.getByRole('main', { name: 'Diomedes', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Open projects', exact: true }).getByRole('button').last().click();
  await page.screenshot({ path: path.join(run, '03-upgraded-project.png') });
  await checkpoint('Same installation launches exact published 0.1.7 EXE/ASAR; project, all project-state records, selected preferences and every project file are identical');
  await openUpdates(); await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect.poll(async () => (await api('/updates/status')).check.outcome, { timeout: 45_000 }).toBe('current');
  proof.currentUpdaterStatus = await api('/updates/status');
  expect(proof.currentUpdaterStatus.installedVersion).toBe('0.1.7');
  await page.screenshot({ path: path.join(run, '04-upgraded-current.png') });
  await close(); await launch('0.1.7');
  const restarted = await state(project); await write('state-restarted.json', restarted);
  expect(restarted).toEqual(before);
  await expect(page.getByRole('main', { name: 'Diomedes', exact: true })).toBeVisible();
  expect(proof.errors).toEqual([]);
  await checkpoint('Upgraded app reports current on public channel and survives a second launch with all witnessed local state intact');
  proof.passed = true;
} catch (error) {
  proof.error = error.stack ?? String(error); process.exitCode = 1;
  if (page && !page.isClosed()) {
    await fs.writeFile(path.join(run, 'failure-ui.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: path.join(run, 'failure.png') });
  }
} finally {
  if (desktop) { try { await close(); } catch (error) { proof.cleanupError = String(error); proof.passed = false; process.exitCode = 1; } }
  proof.cleanup = await Promise.all(proof.launches.map(async ({ origin }) => ({ origin, closed: await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1500) }).then(() => false, () => true) })));
  if (proof.cleanup.some((item) => !item.closed)) { proof.passed = false; process.exitCode = 1; }
  proof.finishedAt = new Date().toISOString(); await write('runtime-proof.json', proof);
  console.log(JSON.stringify({ passed: proof.passed, checks: proof.checks.length, error: proof.error }));
}
