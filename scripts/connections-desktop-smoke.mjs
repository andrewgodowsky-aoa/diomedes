import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AGENT_NAME, enterLastOpenProject, windowFetch } from './smoke-window.mjs';

// The version the packaged build reports comes from package.json; read the
// expectation from the same file so a bump cannot leave a green assertion
// describing a version that is no longer built.
const { version: appVersion } = JSON.parse(
  await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

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
// The packaged service answers only the app window's own requests (smoke-window.mjs).
async function api(route, method = 'GET', body, status = 200) {
  const result = await windowFetch(page, `/api${route}`, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = JSON.parse(result.text); expect(result.status, JSON.stringify(value)).toBe(status); return value;
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
try {
  await launch(); proof.version = (await api('/health')).version;
  expect(proof.version).toBe(appVersion);
  project = await api('/projects/sample', 'POST', {});
  await api('/settings', 'PUT', { detail: 'technical', openProjects: [project.id],
    onboarding: { work: 'business', detail: 'technical', familiarity: 'some', resumeAt: 'done', completedAt: new Date().toISOString() } });
  const base = `/projects/${project.id}/connections`;
  // The retired Connections screen's own calls, driven at the same API it used
  // (client/connections/Connections.tsx): an incomplete intent asks for its
  // threshold and service window, and the server itself refuses to adopt it.
  const requestText = 'Watch Toast menu availability across my three Raleigh restaurants and alert a manager.';
  const incomplete = await api(`${base}/propose`, 'POST', { text: requestText });
  expect(incomplete.plan.questions).toContain(
    'Choose the reported numeric quantity threshold for a manager issue.',
  );
  expect(incomplete.plan.questions).toContain('Choose service days, hours and time zone.');
  const refused = await api(`${base}/adopt`, 'POST', { id: incomplete.plan.id, digest: incomplete.digest }, 409);
  expect(refused.code).toBe('proposal_conflict');
  expect((await api(base)).connections).toHaveLength(0);
  proof.checks.push('Incomplete natural-language intent remains inactive and asks for threshold/service window');
  const proposal = await api(`${base}/propose`, 'POST', {
    text: requestText, threshold: 5,
    serviceWindow: { start: '00:00', end: '23:59', timeZone: 'America/New_York', days: [0, 1, 2, 3, 4, 5, 6] },
  });
  expect(proposal.plan.questions).toEqual([]);
  await api(`${base}/adopt`, 'POST', { id: proposal.plan.id, digest: proposal.digest });
  expect(
    (await api(base)).connections.find((item) => item.connection.id.startsWith('toast-')).health,
  ).toBe('stale');
  await api(`${base}/read`, 'POST', {});
  const readBack = await api(base);
  expect(
    readBack.connections.find((item) => item.connection.id.startsWith('toast-')).health,
  ).toBe('healthy');
  expect(new Set(readBack.observations.map((item) => item.resourceId)).size).toBe(3);
  expect(readBack.observations.filter((item) => item.facts.quantityState === 'not-tracked')).toHaveLength(3);
  proof.checks.push('Reviewed three-location scope; typed fixture read preserves unknown and untracked quantities');
  await api(`${base}/investigate`, 'POST', {});
  const afterModel = await api(base), run = afterModel.runs.at(-1);
  expect(run.state).toBe('completed');
  expect(run.used.modelCalls).toBe(3);
  expect(run.used.toolCalls).toBe(1);
  const modelSteps = run.steps.filter((step) => step.intent.kind === 'model');
  expect(modelSteps[0].intent.input.request.messages[0].text).toContain('stock-investigator-notes v1');
  expect(JSON.stringify(modelSteps[1].output)).toContain('12 units');
  expect(JSON.stringify(modelSteps[2].output)).toContain('not tracked');
  proof.correctionRun = run;
  proof.checks.push('Frozen effective model context, raw bad observation, new budgeted correction identity and rule provenance');
  const improvement = await api(`${base}/rules/revise`, 'POST', {});
  expect(improvement.proposal.review.kind).toBe('improvement');
  await api(`${base}/rules/adopt`, 'POST', { id: improvement.proposal.id, digest: improvement.digest });
  expect(
    (await api(base)).rules.active.find((rule) => rule.id === 'stock-investigator-notes').version,
  ).toBe(2);
  const rollback = await api(`${base}/rules/revise`, 'POST', { rollbackVersion: 1 });
  expect(rollback.proposal.review.kind).toBe('rollback');
  await api(`${base}/rules/adopt`, 'POST', { id: rollback.proposal.id, digest: rollback.digest });
  expect(
    (await api(base)).rules.active.find((rule) => rule.id === 'stock-investigator-notes').version,
  ).toBe(3);
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
  const candidates = await api(`${base}/compiler`);
  for (const name of ['library', 'helpdesk']) {
    const candidate = candidates.find((item) => item.name === name);
    expect(candidate.installed).toBe(false);
    await api(`${base}/compiler/activate`, 'POST', { name, previewDigest: candidate.previewDigest });
    const result = await api(`${base}/compiler/run`, 'POST', { name });
    expect(JSON.stringify(result)).toContain(name === 'library' ? 'conn_library_list_books' : 'conn_helpdesk_list_tickets');
  }
  proof.compiler = (await api(base)).runs.filter((item) => ['connection-library', 'connection-helpdesk'].includes(item.capabilityId));
  expect(proof.compiler).toHaveLength(2); expect(proof.compiler.every((item) => item.state === 'completed' && item.steps.length === 1)).toBe(true);
  proof.checks.push('Two unrelated generic OpenAPI adapters reviewed and called by official SDK MCP client through same Runtime');
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
  // Connections is retired from navigation: the Console lists it in Everything
  // under Not ready yet with its reason (client/console/Shell.tsx), and nothing
  // opens a screen. On a fresh process the window lands on the agent's home; the project
  // is entered through the Open projects bar the way tests/fixtures/landing.ts
  // does, and the row is read where a person actually finds it.
  // The Console is the only surface; the retired Workbook's keys are never stored.
  for (const key of ['surface', 'lastPage', 'tasksView'])
    expect(Object.keys(await api('/settings'))).not.toContain(key);
  await expect(page.getByRole('main', { name: AGENT_NAME, exact: true })).toBeVisible();
  await enterLastOpenProject(page);
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Everything' });
  await expect(menu.getByRole('heading', { name: 'Not ready yet' })).toBeVisible();
  const connectionsRow = menu.getByRole('menuitem', { name: 'Connections' });
  await expect(connectionsRow).toHaveAttribute('aria-disabled', 'true');
  await expect(connectionsRow).toContainText('Not ready');
  await expect(connectionsRow).toContainText('It runs on example data rather than your own software');
  await expect(page.getByRole('button', { name: 'Connections', exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(root, 'connections-unavailable.png') });
  await page.setViewportSize({ width: 760, height: 960 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(root, 'connections-unavailable-narrow.png') });
  proof.checks.push('Connections has no entry point: on a fresh process the Console lists it in Everything under Not ready yet with its reason');
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
  // `/T` exits nonzero when a descendant already went on its own between enumeration and
  // kill, which says nothing about the property under test. What has to hold is that the
  // owned process is gone, so assert that and keep the exit code as evidence.
  const ownedGone = () => {
    // CSV keeps the pid as its own quoted field, so this needs no word-boundary regex and
    // does not depend on the locale of tasklist's "no tasks" message.
    const listed = spawnSync('tasklist.exe', ['/FI', `PID eq ${ownedPid}`, '/NH', '/FO', 'CSV'],
      { windowsHide: true, encoding: 'utf8' }).stdout ?? '';
    return !listed.includes(`"${ownedPid}"`);
  };
  const killDeadline = Date.now() + 10_000;
  while (!ownedGone() && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  proof.crashKill = { pid: ownedPid, taskkillStatus: stopped.status, taskkillStderr: (stopped.stderr ?? '').trim() };
  if (!ownedGone())
    throw new Error(`Owned crash-test PID ${ownedPid} survived taskkill: ${stopped.stderr}`);
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
