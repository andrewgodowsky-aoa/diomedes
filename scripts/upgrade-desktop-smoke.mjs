import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { enterLastOpenProject, windowFetch } from './smoke-window.mjs';

// What this test is really about is the upgrade, not two particular numbers.
// Naming 0.1.0 and 0.1.1 as literals meant a version bump either broke it or,
// worse, left it asserting a pair that was no longer the pair being shipped.
// The current build must be the version this tree builds, and the prior build
// must be genuinely older, or nothing here is an upgrade.
const { version: appVersion } = JSON.parse(
  await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const parseVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  if (!match) throw new Error(`${JSON.stringify(value)} is not an X.Y.Z version.`);
  return match.slice(1, 4).map(Number);
};
const isOlder = (left, right) => {
  const [a, b] = [parseVersion(left), parseVersion(right)];
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index];
  return false;
};

const [priorArg, currentArg, rootArg] = process.argv.slice(2);
if (!priorArg || !currentArg || !rootArg) throw new Error('Supply prior executable, current executable and NEW proof root.');
const prior = path.resolve(priorArg), current = path.resolve(currentArg), root = path.resolve(rootArg);
await fs.mkdir(path.dirname(root), { recursive: true }); await fs.mkdir(root);
const env = { ...process.env, DIOMEDES_DESKTOP_PROFILE: path.join(root, 'profile'),
  DIOMEDES_DATA_DIR: path.join(root, 'data'), DIOMEDES_PROJECTS_DIR: path.join(root, 'projects'),
  CODEX_HOME: path.join(root, 'synthetic-codex') };
delete env.ELECTRON_RUN_AS_NODE;
await fs.mkdir(env.CODEX_HOME);
const proof = { startedAt: new Date().toISOString(), prior, current, root, checks: [], errors: [], origins: [], passed: false };
let desktop, page, origin;
// The packaged service answers only the app window's own requests (smoke-window.mjs).
async function api(route, method = 'GET', body) {
  const response = await windowFetch(page, '/api' + route, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(response.ok, response.text).toBe(true); return JSON.parse(response.text);
}
async function open(executablePath) {
  desktop = await electron.launch({ executablePath, env, cwd: root });
  page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => proof.errors.push(e.message));
  await page.waitForURL('http://127.0.0.1:*/'); origin = new URL(page.url()).origin;
  proof.origins.push(origin);
}
try {
  await open(prior);
  const priorVersion = (await api('/health')).version;
  expect(isOlder(priorVersion, appVersion),
    `The prior build reports ${priorVersion}, which is not older than ${appVersion}: this pair would not exercise an upgrade.`).toBe(true);
  proof.priorVersion = priorVersion; proof.currentVersion = appVersion;
  const project = await api('/projects/sample', 'POST', {}), base = `/projects/${project.id}`;
  await api('/settings', 'PUT', { detail: 'technical', surface: 'workbook', openProjects: [project.id],
    onboarding: { work: 'business', detail: 'technical', familiarity: 'some', resumeAt: 'done', completedAt: new Date().toISOString() },
    lastPage: { [project.id]: 'work' } });
  const session = await api(`${base}/work/start`, 'POST', { capabilityId: 'format-report', taskId: null, instruction: 'Preserve this exact pending proposal across the experimental version upgrade.' });
  await expect.poll(async () => (await api(`${base}/state`)).sessions.find(s => s.id === session.id)?.state).toBe('waiting');
  const before = await api(`${base}/state`), need = before.needs.find(n => n.sessionId === session.id && n.state === 'open');
  const settings = await api('/settings');
  const sentinel = path.join(project.folder, 'user-retained.txt');
  await fs.writeFile(sentinel, 'User project data survives the application upgrade.');
  proof.before = { projectId: project.id, need, settings, history: before.history };
  await desktop.close(); desktop = undefined;
  await open(current); expect((await api('/health')).version).toBe(appVersion);
  const after = await api(`${base}/state`), sameNeed = after.needs.find(n => n.id === need.id);
  expect(sameNeed.approval).toEqual(need.approval); expect(sameNeed.harness).toEqual(need.harness);
  expect(after.history).toEqual(before.history);
  // The one stored preference an upgrade does not keep: every stored surface opens
  // on the Console at launch, since the Workbook left a person's reach
  // (migrateSettings in server/store.ts).
  expect((await api('/settings')).surface).toBe('console');
  expect((await api('/settings')).openProjects).toEqual(settings.openProjects);
  expect(await fs.readFile(sentinel, 'utf8')).toBe('User project data survives the application upgrade.');
  proof.checks.push(`Actual ${priorVersion} profile upgraded to ${appVersion} with project, preferences, History and exact pending Need preserved`);
  await page.reload();
  // A launch opens on the agent's home and a reload keeps that place, so the
  // project is entered through the Open projects bar (smoke-window.mjs).
  await enterLastOpenProject(page);
  // The work was started without a thread; the Console's Board opens its owning
  // thread, where the Need is shown (as harness-desktop-smoke.mjs does).
  await page.getByRole('navigation', { name: 'Threads and views' })
    .getByRole('button', { name: /^Board/ }).click();
  await page.locator('.crow .t').filter({ hasText: 'Format a fixture report' }).click();
  await expect(page.getByRole('region', { name: 'Needs your OK' })).toBeVisible();
  await page.getByRole('button', { name: 'Show me first', exact: true }).click();
  expect(await page.getByRole('dialog').locator('pre').textContent()).toBe(need.harness.intent.input.text);
  await page.getByRole('dialog').getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect.poll(async () => (await api(`${base}/state`)).sessions.find(s => s.id === session.id)?.state).toBe('done');
  const completed = await api(`${base}/state`);
  expect(completed.history.filter(h => h.approvalId === need.id && h.files.length)).toHaveLength(1);
  expect(await fs.readFile(path.join(project.folder, 'Harness report.md'), 'utf8')).toBe(need.harness.intent.input.text);
  const runId = (await api(`${base}/harness/runs`)).runs.find(r => r.sessionId === session.id).id;
  const run = await api(`${base}/harness/runs/${runId}`);
  expect(run.steps.find(s => s.intent.name === 'read_fixture').attempt).toBe(1);
  proof.checks.push('Upgraded exact proposal approved once through UI; one recorded write and original read attempt retained');
  proof.currentAsarSha256 = createHash('sha256').update(await fs.readFile(path.join(path.dirname(current), 'resources/app.asar'))).digest('hex');
  proof.passed = true;
} catch (error) {
  proof.error = String(error); throw error;
} finally {
  if (desktop) await desktop.close();
  proof.finishedAt = new Date().toISOString();
  proof.cleanup = await Promise.all(proof.origins.map(async address => ({ origin: address,
    closed: await fetch(address + '/api/health').then(() => false, () => true) })));
  await fs.writeFile(path.join(root, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ passed: proof.passed, checks: proof.checks, error: proof.error }));
}
