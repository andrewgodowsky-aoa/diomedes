import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Only an explicitly supplied, separately staged package is eligible for this test.
const executablePath = path.resolve(process.argv[2]);
const root = path.resolve(process.argv[3]);
const reproduce = process.argv.includes('--reproduce');
// Refuse reused data: an uncertain earlier run must never be silently replayed.
await fs.mkdir(path.dirname(root), { recursive: true });
await fs.mkdir(root);
const env = { ...process.env,
  DIOMEDES_DESKTOP_PROFILE: path.join(root, 'profile'),
  DIOMEDES_DATA_DIR: path.join(root, 'data'),
  DIOMEDES_PROJECTS_DIR: path.join(root, 'projects'),
  CODEX_HOME: path.join(root, 'synthetic-codex'),
};
delete env.ELECTRON_RUN_AS_NODE;
await fs.mkdir(env.CODEX_HOME, { recursive: true });
let desktop, page, url;
const proof = { checkedAt: new Date().toISOString(), executablePath, root, checks: [], errors: [] };
if (process.argv.includes('--source-unavailable')) {
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const name of ['server', 'client', 'fixtures', 'dist']) {
    const present = await fs.access(path.join(checkout, name)).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    expect(present, `${name} must be unavailable for relocation proof`).toBe(false);
  }
  proof.checks.push('Checkout server, client, fixtures and dist directories unavailable during packaged execution');
}
async function api(route, method = 'GET', data) {
  const response = await fetch(`${url}/api${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function open() {
  desktop = await electron.launch({ executablePath, env, cwd: root });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => proof.errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  url = new URL(page.url()).origin;
}
try {
  await open();
  const project = await api('/projects/sample', 'POST', {});
  const base = `/projects/${project.id}`;
  await api('/settings', 'PUT', {
    detail: 'technical', surface: 'workbook', openProjects: [project.id],
    onboarding: { work: 'business', detail: 'technical', familiarity: 'some',
      resumeAt: 'done', completedAt: new Date().toISOString() },
    lastPage: { [project.id]: 'work' },
  });
  const session = await api(`${base}/work/start`, 'POST', {
    capabilityId: 'format-report', taskId: null, instruction: 'Format the shipped synthetic fixture.',
  });
  await expect.poll(async () => {
    const state = await api(`${base}/state`);
    return state.sessions.find(s => s.id === session.id)?.state;
  }, { timeout: 30000 }).toMatch(/waiting|failed/);
  const runs = await api(`${base}/harness/runs`);
  const state = await api(`${base}/state`);
  proof.session = state.sessions.find(s => s.id === session.id);
  proof.runs = runs;
  proof.run = await api(`${base}/harness/runs/${runs.runs.find(r => r.sessionId === session.id).id}`);
  proof.startup = JSON.parse(await fs.readFile(path.join(root, 'data/desktop-startup.json'), 'utf8'));
  expect(proof.startup.packaged).toBe(true);
  expect(path.resolve(proof.startup.executable)).toBe(executablePath);
  await page.reload();
  await page.screenshot({ path: path.join(root, 'fixture.png'), fullPage: true });
  if (reproduce) {
    expect(proof.session.state).toBe('failed');
    expect(JSON.stringify(proof.run)).toContain('ENOENT');
    expect(JSON.stringify(proof.run)).toContain('report-lines.txt');
    proof.checks.push('Reproduced relocated packaged fixture resource failure');
  } else {
    expect(proof.session.state).toBe('waiting');
    proof.checks.push('Packaged fixture reached exact approval');
    const need = state.needs.find(n => n.sessionId === session.id && n.state === 'open');
    await page.locator('.rail-link').filter({ hasText: 'Work' }).click();
    await expect(page.getByText('no provider calls', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Show me first', exact: true }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').locator('pre')).toHaveText(need.harness.intent.input.text);
    // textContent comparison preserves whitespace, unlike normalized text matchers.
    expect(await page.getByRole('dialog').locator('pre').textContent()).toBe(need.harness.intent.input.text);
    await page.screenshot({ path: path.join(root, 'workbook-exact-proposal.png') });
    proof.checks.push('Exact harness proposal text is inspectable in Workbook');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.locator('.rail-link').filter({ hasText: 'Review' }).click();
    await expect(page.getByRole('region', { name: 'Needs your OK' })).toBeVisible();
    await page.getByRole('button', { name: 'Show me first', exact: true }).click();
    expect(await page.getByRole('dialog').locator('pre').textContent()).toBe(need.harness.intent.input.text);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    proof.checks.push('Review presents the pending harness Need');

    await api('/settings', 'PUT', { ...(await api('/settings')), surface: 'console' });
    await page.reload();
    const rail = page.getByRole('navigation', { name: 'Threads and views' });
    await rail.getByRole('button', { name: /^Board/ }).click();
    await page.locator('.crow .t').filter({ hasText: 'Format a fixture report' }).click();
    await page.getByRole('button', { name: 'Show me first', exact: true }).click();
    expect(await page.getByRole('dialog').locator('pre').textContent()).toBe(need.harness.intent.input.text);
    await page.screenshot({ path: path.join(root, 'console-exact-proposal.png') });
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    proof.checks.push('Console Board opens the owning thread and exact proposal');

    const cursor = proof.run.lastSeq;
    await desktop.close(); desktop = undefined;
    await open();
    const resumed = await api(`${base}/harness/runs/${proof.run.id}`);
    expect(resumed.steps.filter(s => s.intent.name === 'read_fixture')).toHaveLength(1);
    expect(resumed.steps.find(s => s.intent.name === 'read_fixture').attempt).toBe(1);
    await expect(page.getByRole('region', { name: 'Needs your OK' })).toBeVisible();
    await page.getByRole('button', { name: 'Show me first', exact: true }).click();
    expect(await page.getByRole('dialog').locator('pre').textContent()).toBe(need.harness.intent.input.text);
    const decisions = [];
    await page.route(`**/api${base}/needs/${need.id}/resolve`, async route => {
      decisions.push(route.request().postDataJSON());
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (decisions.length === 1) await route.abort('connectionreset');
      else await route.fulfill({ response });
    });
    await page.getByRole('dialog').getByRole('button', { name: 'Go ahead', exact: true }).click();
    await expect.poll(() => decisions.length).toBe(2);
    expect(decisions[0]).toEqual(decisions[1]);
    expect(decisions[0].actionDigest).toBe(need.approval.actionDigest);
    await page.unroute(`**/api${base}/needs/${need.id}/resolve`);
    await expect.poll(async () => (await api(`${base}/harness/runs/${proof.run.id}`)).state).toBe('completed');
    const reportPath = path.join(project.folder, 'Harness report.md');
    expect(await fs.readFile(reportPath, 'utf8')).toBe(need.harness.intent.input.text);
    const completed = await api(`${base}/state`);
    const writeHistory = completed.history.filter(h => h.approvalId === need.id && h.files.length);
    expect(writeHistory).toHaveLength(1);
    proof.decision = completed.needs.find(n => n.id === need.id).approvalReceipt;
    proof.execution = completed.needs.find(n => n.id === need.id).execution;
    proof.events = await api(`${base}/harness/runs/${proof.run.id}/events?after=${cursor}`);
    expect(proof.events.events.every(e => e.seq > cursor)).toBe(true);
    expect(proof.events.events.filter(e => e.type === 'run.completed')).toHaveLength(1);
    proof.checks.push('Restart preserves waiting Need; lost decision response replays one receipt and one exact write');

    async function startFixture() {
      const next = await api(`${base}/work/start`, 'POST', {
        capabilityId: 'format-report', taskId: session.taskId, instruction: 'Synthetic decline and stop verification.',
      });
      await expect.poll(async () => (await api(`${base}/state`)).sessions.find(s => s.id === next.id).state).toBe('waiting');
      await page.reload();
      await expect(page.getByRole('region', { name: 'Needs your OK' })).toBeVisible();
      return next;
    }
    const declined = await startFixture();
    await page.getByRole('button', { name: "Don't do this", exact: true }).click();
    await expect.poll(async () => (await api(`${base}/state`)).sessions.find(s => s.id === declined.id).state).toBe('stopped');
    expect(await fs.readFile(reportPath, 'utf8')).toBe(need.harness.intent.input.text);
    const stopped = await startFixture();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(async () => (await api(`${base}/state`)).sessions.find(s => s.id === stopped.id).state).toBe('stopped');
    expect(await fs.readFile(reportPath, 'utf8')).toBe(need.harness.intent.input.text);
    expect((await api(`${base}/state`)).history.filter(h => h.files.some(f => f.path === 'Harness report.md'))).toHaveLength(1);
    proof.checks.push('Visible decline and Stop prevent additional file writes');

    await api('/settings', 'PUT', { ...(await api('/settings')), surface: 'workbook', lastPage: { [project.id]: 'history' } });
    await page.reload();
    const historyRow = page.locator('.history-entry').filter({ hasText: 'Harness report.md' });
    await expect(historyRow).toHaveCount(1);
    await page.screenshot({ path: path.join(root, 'history.png') });
    await historyRow.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Restore 1 files', exact: true }).click();
    await expect.poll(async () => fs.access(reportPath).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })).toBe(false);
    const restored = await api(`${base}/state`);
    expect(restored.history.filter(h => h.restoreOf === writeHistory[0].id)).toHaveLength(1);
    proof.checks.push('History restore removes a newly created file and records its own restore entry');
    await desktop.close(); desktop = undefined;
    await open();
    expect((await api(`${base}/state`)).history.filter(h => h.restoreOf === writeHistory[0].id)).toHaveLength(1);
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    proof.renderer = await desktop.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation, sandbox: p.sandbox };
    });
    expect(proof.renderer).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true });
    // Prove the built client cannot roll back a concurrent engine setting merely by navigating.
    await api('/settings', 'PUT', { services: { codex: false } });
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Project pages', exact: true })).toBeVisible();
    let releaseRefresh;
    const refreshReleased = new Promise(resolve => { releaseRefresh = resolve; });
    await page.route('**/api/settings', async route => {
      if (route.request().method() === 'GET') await refreshReleased;
      await route.continue();
    });
    try {
      await api('/settings', 'PUT', { services: { codex: true } });
      const navigationSaved = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'PUT');
      await page.getByRole('navigation', { name: 'Project pages', exact: true })
        .getByRole('button', { name: /^Ask/ }).click();
      expect((await navigationSaved).ok()).toBe(true);
      expect((await api('/settings')).services.codex).toBe(true);
    } finally {
      releaseRefresh();
    }
    await page.unrouteAll({ behavior: 'wait' });
    await api('/settings', 'PUT', { services: { codex: false } });
    proof.checks.push('Built navigation preserves a concurrent engine setting during a delayed refresh; no provider call');
    const latencies = [];
    for (let i = 0; i < 10; i++) { const start = performance.now(); await api(`${base}/state`); latencies.push(performance.now() - start); }
    proof.stateLatencyMs = latencies;
    proof.runBytes = (await fs.stat(path.join(root, `data/projects/${project.id}/harness/runs/${proof.run.id}.json`))).size;
    proof.metrics = await desktop.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu, memory: p.memory })));
    expect(proof.errors).toEqual([]);
    proof.checks.push('Restored state survives restart; renderer isolation settings and built UI checked');
    proof.finalRun = await api(`${base}/harness/runs/${proof.run.id}`);
    proof.finalSessions = (await api(`${base}/state`)).sessions.map(s => ({ id: s.id, state: s.state }));
  }
  proof.asarSha256 = createHash('sha256').update(await fs.readFile(
    path.join(path.dirname(executablePath), 'resources/app.asar'))).digest('hex');
  console.log(JSON.stringify({ checks: proof.checks, state: proof.finalRun?.state ?? proof.session.state }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true });
  proof.failure = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  if (desktop) await desktop.close();
  if (url) {
    await expect.poll(async () => fetch(`${url}/api/settings`).then(() => true, () => false)).toBe(false);
    await expect.poll(async () => fs.access(path.join(root, 'data/service.lock')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })).toBe(false);
    proof.checks.push('Owned package server stopped and data lock released');
  }
  await fs.writeFile(path.join(root, 'proof.json'), JSON.stringify(proof, null, 2));
}
