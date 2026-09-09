import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const executablePath = path.resolve(process.argv[2] ?? '');
const root = path.resolve(process.argv[3] ?? '');
if (path.basename(executablePath) !== 'Diomedes.exe' || !process.argv[3]) throw new Error('Supply exact packaged executable and a NEW isolated proof directory.');
await fs.mkdir(path.dirname(root), { recursive: true }); await fs.mkdir(root);
const env = { ...process.env, DIOMEDES_DESKTOP_PROFILE: path.join(root, 'profile'),
  DIOMEDES_DATA_DIR: path.join(root, 'data'), DIOMEDES_PROJECTS_DIR: path.join(root, 'projects'),
  DIOMEDES_TEST_MODE: '1', CODEX_HOME: path.join(root, 'synthetic-codex') };
delete env.ELECTRON_RUN_AS_NODE;
await fs.mkdir(env.CODEX_HOME);
const proof = { startedAt: new Date().toISOString(), executablePath, root, checks: [], errors: [], passed: false };
let desktop, page, origin, project, savedEvent;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function api(route, method = 'GET', body, status = 200) {
  const result = await fetch(`${origin}/api${route}`, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await result.json(); expect(result.status, JSON.stringify(value)).toBe(status); return value;
}
async function launch(extra = {}) {
  const at = performance.now();
  desktop = await electron.launch({ executablePath, env: { ...env, ...extra }, cwd: root });
  page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => proof.errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/'); origin = new URL(page.url()).origin;
  await api('/health');
  proof.launches ??= []; proof.launches.push({ pid: desktop.process().pid, readyMs: Math.round(performance.now() - at), origin });
}
async function openConnections() {
  await page.reload(); await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
}
try {
  await launch(); proof.version = (await api('/health')).version;
  expect(proof.version).toBe('0.1.1');
  project = await api('/projects/sample', 'POST', {});
  await api('/settings', 'PUT', { detail: 'technical', surface: 'console', openProjects: [project.id],
    onboarding: { work: 'business', detail: 'technical', familiarity: 'some', resumeAt: 'done', completedAt: new Date().toISOString() } });
  const base = `/projects/${project.id}/connections`;
  await openConnections();
  await page.getByRole('button', { name: 'Prepare connection proposal' }).click();
  await expect(page.getByText('Choose the reported numeric quantity threshold for a manager issue.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve synthetic connection' })).toHaveCount(0);
  proof.checks.push('Incomplete natural-language intent remains inactive and asks for threshold/service window');
  await page.getByLabel('Reported quantity threshold').fill('5');
  await page.getByLabel('Service starts').fill('00:00'); await page.getByLabel('Service ends').fill('23:59');
  await page.getByRole('button', { name: 'Prepare connection proposal' }).click();
  await page.getByRole('button', { name: 'Approve synthetic connection' }).click();
  await expect(page.getByTestId('connection-health')).toHaveText('stale');
  await page.getByRole('button', { name: 'Refresh availability' }).click();
  await expect(page.getByTestId('connection-health')).toHaveText('healthy');
  await expect(page.getByRole('cell', { name: 'Not tracked', exact: true })).toHaveCount(3);
  proof.checks.push('Reviewed three-location scope; typed fixture read preserves unknown and untracked quantities');
  await page.getByRole('button', { name: 'Run correction demo' }).click();
  await expect(page.getByText('completed / 3 scripted model calls / 1 tool calls')).toBeVisible();
  const afterModel = await api(base), run = afterModel.runs.at(-1);
  const modelSteps = run.steps.filter((step) => step.intent.kind === 'model');
  expect(modelSteps[0].intent.input.request.messages[0].text).toContain('stock-investigator-notes v1');
  expect(JSON.stringify(modelSteps[1].output)).toContain('12 units');
  expect(JSON.stringify(modelSteps[2].output)).toContain('not tracked');
  proof.correctionRun = run;
  proof.checks.push('Frozen effective model context, raw bad observation, new budgeted correction identity and rule provenance');
  await page.getByRole('button', { name: 'Propose improvement from corrections' }).click();
  await page.getByRole('button', { name: 'Adopt reviewed revision' }).click();
  await expect(page.getByText('stock-investigator-notes v2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review rollback to guidance v1' }).click();
  await page.getByRole('button', { name: 'Adopt reviewed revision' }).click();
  await expect(page.getByText('stock-investigator-notes v3', { exact: true })).toBeVisible();
  proof.checks.push('Correction history -> offline replay comparison -> explicit revision adoption -> versioned rollback');
  savedEvent = { id: randomUUID(), at: new Date().toISOString(), quantity: 3 };
  const ackAt = performance.now(); await api(`${base}/event`, 'POST', savedEvent, 202);
  proof.eventAckMs = Math.round(performance.now() - ackAt);
  await expect.poll(async () => (await api(base)).tasks.length).toBe(1);
  await api(`${base}/event`, 'POST', savedEvent, 202);
  await api(`${base}/event`, 'POST', { ...savedEvent, quantity: 4 }, 409);
  const events = await api(base); expect(events.tasks).toHaveLength(1); expect(events.inbox).toHaveLength(1);
  expect(events.tasks[0].description).toContain('Rule low-stock v1');
  expect(events.inbox[0].rules.find((rule) => rule.action === 'create-issue')?.serviceWindow).toBeTruthy();
  proof.checks.push('Signed durable ingress, deterministic threshold AND service window, duplicate/conflict handling, one manager Task');
  proof.writeProbe = await api(`${base}/proof/write-denial`, 'POST', {});
  expect(proof.writeProbe.registered).toBe(true); expect(proof.writeProbe.dispatches).toBe(0); expect(proof.writeProbe.denied).toBeTruthy();
  proof.checks.push('Registered prohibited write refused before handler, zero dispatches');
  await page.getByText('Review generated connection examples', { exact: true }).click();
  await page.getByRole('button', { name: 'Load generated candidates' }).click();
  for (const name of ['library', 'helpdesk']) {
    await page.getByRole('button', { name: `Approve ${name} fixture`, exact: true }).click();
    await page.getByRole('button', { name: `Run ${name} MCP check`, exact: true }).click();
    await expect(page.getByLabel('MCP result')).toContainText(name === 'library' ? 'conn_library_list_books' : 'conn_helpdesk_list_tickets');
  }
  proof.compiler = (await api(base)).runs.filter((item) => ['connection-library', 'connection-helpdesk'].includes(item.capabilityId));
  expect(proof.compiler).toHaveLength(2); expect(proof.compiler.every((item) => item.state === 'completed' && item.steps.length === 1)).toBe(true);
  proof.checks.push('Two unrelated generic OpenAPI adapters reviewed and called by official SDK MCP client through same Runtime');
  await page.locator('.connection-desktop').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(root, 'connections.png') });
  await page.setViewportSize({ width: 760, height: 960 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(root, 'connections-narrow.png') });
  await api(`${base}/control`, 'POST', { status: 'disconnected' });
  await api(`${base}/read`, 'POST', {}, 409);
  await api(`${base}/event`, 'POST', { ...savedEvent, id: randomUUID() }, 409);
  proof.checks.push('Revocation blocks reads and signed events using current host authority');
  await desktop.close(); desktop = undefined;
  await launch();
  expect((await api(base)).authorized).toBe(false);
  await api(`${base}/read`, 'POST', {}, 409);
  await api(`${base}/resume`, 'POST', {});
  expect((await api(base)).connections.find((item) => item.connection.id.startsWith('toast-')).health).toBe('stale');
  await api(`${base}/event`, 'POST', savedEvent, 202);
  expect((await api(base)).tasks).toHaveLength(1);
  proof.checks.push('Fresh process requires explicit authorization, starts stale, keeps durable receipts and never duplicates manager Task');
  await api('/settings', 'PUT', { surface: 'workbook', lastPage: { [project.id]: 'connections' } });
  await page.reload(); await expect(page.getByRole('heading', { name: 'Reported availability', exact: true })).toBeVisible();
  proof.checks.push('Connections available through normal Workbook navigation as well as Console');
  await desktop.close(); desktop = undefined;
  await launch({ DIOMEDES_TEST_HOLD_TRIAGE: '1' });
  await api(`${base}/resume`, 'POST', {});
  const queued = { id: randomUUID(), at: new Date().toISOString(), quantity: 3 };
  await api(`${base}/event`, 'POST', queued, 202);
  const pending = (await api(base)).inbox.find((item) => item.id === queued.id);
  expect(pending.state).toBe('pending');
  proof.pendingBeforeCrash = pending;
  const ownedPid = desktop.process().pid;
  const stopped = spawnSync('taskkill.exe', ['/PID', String(ownedPid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
  if (stopped.status !== 0) throw new Error(`Could not terminate owned crash-test PID ${ownedPid}: ${stopped.stderr}`);
  desktop = undefined;
  await launch(); expect((await api(base)).authorized).toBe(false);
  await api(`${base}/resume`, 'POST', {});
  await expect.poll(async () => (await api(base)).inbox.find((item) => item.id === queued.id)?.state).toBe('processed');
  expect((await api(base)).tasks).toHaveLength(1);
  await api(`${base}/event`, 'POST', queued, 202); expect((await api(base)).tasks).toHaveLength(1);
  proof.checks.push('Abrupt owned-process crash after signed durable HTTP 202 and before triage; explicit new-session recovery processes receipt once');
  const first = await desktop.evaluate(({ app }) => app.getAppMetrics());
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const idle = await desktop.evaluate(({ app }) => app.getAppMetrics());
  proof.idle = { samples: [first, idle], windowMs: 4000 };
  proof.applicationPath = await desktop.evaluate(({ app }) => app.getAppPath());
  expect(proof.applicationPath).toBe(path.join(path.dirname(executablePath), 'resources', 'app.asar'));
  expect(proof.errors).toEqual([]);
  proof.passed = true;
} catch (error) {
  proof.error = error.stack ?? String(error); process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
} finally {
  if (desktop) await desktop.close();
  proof.finishedAt = new Date().toISOString();
  proof.executableSha256 = createHash('sha256').update(await fs.readFile(executablePath)).digest('hex');
  proof.asarSha256 = createHash('sha256').update(await fs.readFile(path.join(path.dirname(executablePath), 'resources/app.asar'))).digest('hex');
  const results = await Promise.all(proof.launches.map(async ({ origin }) => {
    try { await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) }); return { origin, closed: false }; }
    catch { return { origin, closed: true }; }
  }));
  proof.cleanup = results;
  if (results.some((item) => !item.closed)) { proof.passed = false; process.exitCode = 1; }
  await fs.writeFile(path.join(root, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ passed: proof.passed, checks: proof.checks, error: proof.error, proof: path.join(root, 'proof.json') }));
}
