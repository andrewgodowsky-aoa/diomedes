// One synthetic native proposal through the packaged desktop and durable approval path.
// Verifies one real gpt-5.6-luna low generation through the packaged desktop,
// exact preview, lost approval-response recovery, Workbook + Console approval UI,
// restart receipt durability, and restore. Never touches evidence/desktop-proof.json.
import { _electron as electron, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('test-results', `approval-desktop-${Date.now()}`);
const profileDir = path.join(root, 'profile');
const dataDir = path.join(root, 'data');
const projectsDir = path.join(root, 'projects');
await fs.mkdir(profileDir, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(projectsDir, { recursive: true });
await fs.mkdir(path.resolve('evidence/screenshots'), { recursive: true });

const executablePath = path.resolve('release/Diomedes-win32-x64/Diomedes.exe');
const env = {
  ...process.env,
  DIOMEDES_DESKTOP_PROFILE: profileDir,
  DIOMEDES_DATA_DIR: dataDir,
  DIOMEDES_PROJECTS_DIR: projectsDir,
};
delete env.ELECTRON_RUN_AS_NODE;

// Same known synthetic text as scripts/native-work-smoke.ts.
const brief = '# Native work smoke\n\nThis is synthetic verification text.\n';
const expected = `${brief}Native work verified.\n`;
const instruction =
  'Append exactly the sentence Native work verified. as one new line at the end of Brief.md, followed by a newline. Preserve every existing character. Do not create, delete, or change any other file.';
const workCommandId = 'approval-desktop-work';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const errors = [];
const proof = {
  checkedAt: new Date().toISOString(),
  passed: false,
  executablePath,
  profileDir,
  dataDir,
  projectsDir,
  sourcePaths: { briefPath: 'Brief.md', projectFolder: null },
  requested: { model: 'gpt-5.6-luna', effort: 'low', generations: 1 },
  provenance: null,
  generationCount: 0,
  receipt: null,
  execution: null,
  hashes: { before: sha256(brief), after: sha256(expected) },
  restart: { relaunched: false, receiptUnchanged: false, replayWithoutRun: false },
  limitations: [
    'One real Codex generation only; no retries, no fallback, no sample work.',
    'Reuses the existing local runtime and sign-in; no credentials are copied.',
    'Only the first approval HTTP response is lost after route.fetch commits.',
    'Writes evidence/approval-desktop-proof.json; never evidence/desktop-proof.json.',
  ],
  pageErrors: errors,
};

let desktop;
let url;
async function api(route, method = 'GET', data) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}

try {
  desktop = await electron.launch({ executablePath, env });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  url = new URL(page.url()).origin;
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();

  // Reuse the existing local runtime/sign-in; fail if Codex is unavailable.
  const integrations = await api('/integrations');
  const codex = integrations.integrations.find((item) => item.id === 'codex');
  if (!codex?.available) throw new Error('Codex integration is unavailable; no fallback is allowed.');
  proof.runtimeAvailable = { found: codex.found, available: codex.available };

  const catalog = await api('/engines/codex/models');
  const requestedModel = catalog.models.find((model) => model.slug === 'gpt-5.6-luna');
  if (!requestedModel?.efforts.some((effort) => effort.id === 'low'))
    throw new Error('The runtime catalog does not offer the requested Luna/low choice; no generation was started.');

  // Exactly one explicit real generation: gpt-5.6-luna low, no retries.
  await api('/settings', 'PUT', {
    services: { codex: true, codexModel: 'gpt-5.6-luna', codexEffort: 'low' },
    detail: 'standard',
    onboarding: { work: 'business', detail: 'standard', familiarity: 'some', resumeAt: 'done', completedAt: new Date().toISOString() },
  });
  const projectFolder = path.join(projectsDir, 'approval-desktop');
  const project = await api('/projects', 'POST', { name: 'Approval desktop smoke', folder: projectFolder });
  proof.sourcePaths.projectFolder = project.folder;
  await api(`/projects/${project.id}/documents/create`, 'POST', { path: 'Brief.md', text: brief });
  const task = await api(`/projects/${project.id}/tasks`, 'POST', {
    name: 'Append one sentence to Brief.md',
    owner: 'diomedes-with-ok',
    description:
      'Append exactly the sentence Native work verified. as one new line at the end of Brief.md, followed by a newline. Preserve every existing character. Do not create, delete, or change any other file.',
  });
  const thread = await api(`/projects/${project.id}/threads`, 'POST', {
    taskId: task.id,
    name: 'Approval desktop thread',
  });

  // Start v1 Work command with the explicitly selected Brief.md.
  const started = await api(`/projects/${project.id}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: workCommandId,
    taskId: task.id,
    route: 'codex',
    instruction,
    sources: ['Brief.md'],
    consent: true,
    threadId: thread.id,
  });
  if (!started.receipt) throw new Error('Work start did not return a durable command receipt.');
  proof.workReceipt = started.receipt;
  proof.generationCount = 1;

  // Poll bounded for the native Need; assert exact preview and untouched original.
  let need;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const state = await api(`/projects/${project.id}/state`);
    const session = state.sessions.find((item) => item.id === started.id);
    if (!session) throw new Error('The native work session is missing.');
    if (session.state === 'failed' || session.state === 'stopped')
      throw new Error(`Native proposal ${session.state}: ${session.log.at(-1)?.sentence ?? 'No diagnostic.'}`);
    const open = state.needs.find((item) => item.sessionId === started.id && item.state === 'open');
    if (open && open.approval) {
      need = open;
      break;
    }
    if (session.state === 'done') throw new Error('The task finished without requiring approval.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!need?.approval) throw new Error('No exact native Need with approval identity appeared.');
  if (need.preview?.length !== 1) throw new Error('Only one file may be proposed in this bounded smoke.');
  if (need.preview[0].path !== 'Brief.md') throw new Error('The proposal must target Brief.md.');
  if (need.preview[0].after !== expected) throw new Error('The preview must match the exact authorized edit.');
  if ((await fs.readFile(path.join(project.folder, 'Brief.md'), 'utf8')) !== brief)
    throw new Error('The original must remain untouched before approval.');
  proof.needId = need.id;
  proof.sessionId = started.id;
  proof.approvalIdentity = need.approval;

  // Show the preview through the existing Needs your OK region in the Workbook.
  const settings = await api('/settings');
  await api('/settings', 'PUT', {
    ...settings,
    surface: 'workbook',
    openProjects: [project.id],
    lastPage: { ...settings.lastPage, [project.id]: 'work' },
  });
  await page.reload();
  const needsRegion = page.getByRole('region', { name: 'Needs your OK' });
  await expect(needsRegion).toBeVisible();
  await needsRegion.getByRole('button', { name: 'Show me first', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Proposed changes', exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(/This OK covers only this proposal. Expires /)).toBeVisible();
  await expect(preview.locator('.change-card')).toContainText('Native work verified.');
  await expect(preview.getByRole('button', { name: 'Go ahead for this whole task', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: path.resolve('evidence/screenshots/approval-desktop-workbook.png'),
    animations: 'disabled',
  });

  // Lose ONLY the first approval HTTP response AFTER route.fetch commits.
  const approvalEndpoint = `**/api/projects/${project.id}/needs/${need.id}/resolve`;
  const approvalCommands = [];
  let approvalReply;
  let approvalResponses = 0;
  await page.route(approvalEndpoint, async (route) => {
    approvalCommands.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (response.status() !== 200) throw new Error(`Approval decision HTTP ${response.status()}.`);
    if (approvalCommands.length === 1) {
      approvalReply = await response.json();
      await route.abort('connectionreset');
    } else {
      await route.fulfill({ response });
    }
    approvalResponses++;
  });
  await preview.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect.poll(() => approvalResponses).toBe(2);
  await expect
    .poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('diomedes.approval.pending.')).length))
    .toBe(0);
  await page.unroute(approvalEndpoint);
  if (approvalCommands.length !== 2) throw new Error(`Expected 2 identical approval commands, saw ${approvalCommands.length}.`);
  const [firstApproval, secondApproval] = approvalCommands;
  if (firstApproval.commandId !== secondApproval.commandId || !firstApproval.commandId)
    throw new Error('The approval retry must reuse the same command id.');
  for (const key of ['proposalDigest', 'actionDigest', 'baseDigest']) {
    if (firstApproval[key] !== need.approval[key] || secondApproval[key] !== need.approval[key])
      throw new Error(`Approval ${key} must match the displayed Need.approval.`);
  }
  if (firstApproval.protocolVersion !== 1 || firstApproval.resolution !== 'go-ahead')
    throw new Error('The approval command must be an exact v1 go-ahead.');
  proof.approvalCommandId = firstApproval.commandId;
  proof.approvalAttempts = approvalCommands;

  const afterApproval = await api(`/projects/${project.id}/state`);
  const decided = afterApproval.needs.find((item) => item.id === need.id);
  if (!decided?.approvalReceipt) throw new Error('The exact receipt is missing after approval.');
  if (decided.approvalReceipt.commandId !== firstApproval.commandId)
    throw new Error('The receipt must carry the retried approval command id.');
  if (decided.execution?.state !== 'applied') throw new Error('The approval execution must be applied.');
  if (decided.state !== 'go-ahead') throw new Error('The Need must be decided go-ahead.');
  proof.receipt = decided.approvalReceipt;
  proof.execution = decided.execution;
  if (approvalReply?.approvalReceipt) {
    if (JSON.stringify(approvalReply.approvalReceipt) !== JSON.stringify(decided.approvalReceipt))
      throw new Error('The first committed reply and the retried receipt must match exactly.');
  }
  const sessionsForTask = afterApproval.sessions.filter((item) => item.taskId === task.id);
  if (sessionsForTask.length !== 1) throw new Error(`Expected one native session, saw ${sessionsForTask.length}.`);
  const decisions = afterApproval.history.filter((item) => item.kind === 'decision' && item.approvalId === need.id);
  if (decisions.length !== 1) throw new Error(`Expected one decision History entry, saw ${decisions.length}.`);
  const changed = afterApproval.history.filter(
    (item) => item.kind === 'changed' && item.sessionId === started.id,
  );
  if (changed.length !== 1) throw new Error(`Expected one changed History entry, saw ${changed.length}.`);
  if ((await fs.readFile(path.join(project.folder, 'Brief.md'), 'utf8')) !== expected)
    throw new Error('The approved file bytes must match the shown proposal.');
  proof.changedEntryId = changed[0].id;
  proof.decisionEntryId = decisions[0].id;
  const completed = afterApproval.sessions.find((item) => item.id === started.id);
  proof.provenance = {
    engine: completed.engine,
    sessionSample: completed.sample,
    taskOwner: afterApproval.tasks.find((item) => item.id === task.id)?.owner,
  };
  if (completed.sample !== false) throw new Error('The native session must not be sample work.');
  if (completed.engine?.model !== 'gpt-5.6-luna' || completed.engine.verified !== true)
    throw new Error('The runtime must verify the requested gpt-5.6-luna model.');

  // Show the Approval record status, then inspect the durable record in the Console.
  await expect(page.getByLabel('Approval record').first()).toBeVisible();
  const consoleSettings = await api('/settings');
  await api('/settings', 'PUT', { ...consoleSettings, surface: 'console' });
  await page.reload();
  await expect(page.locator('html[data-surface="console"]')).toHaveCount(1);
  await expect(page.getByLabel('Approval record').first()).toBeVisible();
  const decisionSummary = page.getByText('Decision record', { exact: true }).first();
  await decisionSummary.click();
  await expect(page.getByText(firstApproval.commandId).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error('The Console must not overflow horizontally.');
  await page.screenshot({
    path: path.resolve('evidence/screenshots/approval-desktop-console.png'),
    animations: 'disabled',
  });

  // Renderer isolation and packaged startup checks before restart.
  if ((await page.evaluate(() => typeof window.require)) !== 'undefined')
    throw new Error('Renderer Node integration must stay disabled.');
  const startup = JSON.parse(await fs.readFile(path.join(dataDir, 'desktop-startup.json'), 'utf8'));
  if (startup.packaged !== true) throw new Error('The desktop startup must report packaged true.');
  proof.startup = startup;
  if (errors.length) throw new Error(`Page errors: ${errors.join('; ').slice(0, 400)}`);

  // Close, relaunch the same packaged app/profile, and verify receipt durability.
  await desktop.close();
  desktop = undefined;
  await expect
    .poll(async () => {
      try {
        await fs.access(path.join(dataDir, 'service.lock'));
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    })
    .toBe(false);
  desktop = await electron.launch({ executablePath, env });
  const reopened = await desktop.firstWindow();
  reopened.setDefaultTimeout(15_000);
  reopened.on('pageerror', (error) => errors.push(error.message));
  await reopened.waitForURL('http://127.0.0.1:*/');
  url = new URL(reopened.url()).origin;
  proof.restart.relaunched = true;
  const restarted = await api(`/projects/${project.id}/state`);
  const reread = restarted.needs.find((item) => item.id === need.id);
  if (JSON.stringify(reread?.approvalReceipt) !== JSON.stringify(decided.approvalReceipt))
    throw new Error('The approval receipt must be unchanged after restart.');
  proof.restart.receiptUnchanged = true;
  const sessionsBeforeReplay = restarted.sessions.length;
  const historyBeforeReplay = restarted.history.length;
  const replay = await api(`/projects/${project.id}/needs/${need.id}/resolve`, 'POST', {
    protocolVersion: 1,
    commandId: firstApproval.commandId,
    resolution: 'go-ahead',
    proposalDigest: need.approval.proposalDigest,
    actionDigest: need.approval.actionDigest,
    baseDigest: need.approval.baseDigest,
  });
  if (JSON.stringify(replay.approvalReceipt) !== JSON.stringify(decided.approvalReceipt))
    throw new Error('The original approval replay must return the same receipt.');
  const afterReplay = await api(`/projects/${project.id}/state`);
  if (afterReplay.sessions.length !== sessionsBeforeReplay || afterReplay.history.length !== historyBeforeReplay)
    throw new Error('The approval replay must not run another generation or write more history.');
  proof.restart.replayWithoutRun = true;

  // Restore the original bytes through the existing history restore pattern.
  const restored = await api(`/projects/${project.id}/history/${changed[0].id}/restore`, 'POST', {});
  if (!restored.entryId) throw new Error('The restore must return a durable history entry.');
  if ((await fs.readFile(path.join(project.folder, 'Brief.md'), 'utf8')) !== brief)
    throw new Error('Restore must reproduce the exact original bytes.');
  if (sha256(await fs.readFile(path.join(project.folder, 'Brief.md'), 'utf8')) !== proof.hashes.before)
    throw new Error('The restored SHA must match the original.');
  proof.restoreEntryId = restored.entryId;
  proof.restoredSha = proof.hashes.before;

  if (errors.length) throw new Error(`Page errors: ${errors.join('; ').slice(0, 400)}`);
  proof.passed = true;
  console.log('PASS: packaged desktop exact approval, lost approval-response recovery, Workbook and Console records, restart receipt durability, and restore.');
} catch (error) {
  proof.error = error instanceof Error ? error.message : String(error);
  const message = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error);
  console.error(`FAIL: ${message.endsWith('.') ? message : `${message}.`}`);
  process.exitCode = 1;
} finally {
  proof.completedAt = new Date().toISOString();
  proof.pageErrors = errors;
  await fs.writeFile('evidence/approval-desktop-proof.json', `${JSON.stringify(proof, null, 2)}\n`);
  if (desktop) await desktop.close();
}
