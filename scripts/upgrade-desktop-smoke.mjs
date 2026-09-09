import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
async function api(route, method = 'GET', body) {
  const response = await fetch(origin + '/api' + route, { method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(response.ok, await response.clone().text()).toBe(true); return response.json();
}
async function open(executablePath) {
  desktop = await electron.launch({ executablePath, env, cwd: root });
  page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => proof.errors.push(e.message));
  await page.waitForURL('http://127.0.0.1:*/'); origin = new URL(page.url()).origin;
  proof.origins.push(origin);
}
try {
  await open(prior); expect((await api('/health')).version).toBe('0.1.0');
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
  await open(current); expect((await api('/health')).version).toBe('0.1.1');
  const after = await api(`${base}/state`), sameNeed = after.needs.find(n => n.id === need.id);
  expect(sameNeed.approval).toEqual(need.approval); expect(sameNeed.harness).toEqual(need.harness);
  expect(after.history).toEqual(before.history);
  expect((await api('/settings')).surface).toBe(settings.surface);
  expect((await api('/settings')).openProjects).toEqual(settings.openProjects);
  expect(await fs.readFile(sentinel, 'utf8')).toBe('User project data survives the application upgrade.');
  proof.checks.push('Actual 0.1.0 profile upgraded to ZIP-extracted 0.1.1 with project, preferences, History and exact pending Need preserved');
  await page.reload();
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
