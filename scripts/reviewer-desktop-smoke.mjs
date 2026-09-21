import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/*
 * Packaged proof for `Approve for me` and the Agent primitive.
 *
 * Runs the candidate EXE with an isolated profile, then starts a second owned
 * fixture host from the PACKAGED compiled server module (never source) with a
 * clearly synthetic worker and a clearly synthetic reviewer, and exercises the
 * whole authority path against the packaged backend and packaged UI.
 *
 * What this does and does not prove is stated in the manifest: the reviewer is
 * a fixture, so this proves the AUTHORITY path - which decisions can write,
 * which cannot, what is recorded, and what a person is told - and never a live
 * model's judgement. No live discovery, inference, credentials or billing.
 */
const WORKER_MODEL = 'synthetic-packaged-worker-model';
const REVIEWER_MODEL = 'synthetic-packaged-reviewer-model';
const root = path.resolve('test-results', `reviewer-desktop-${Date.now()}`);
const evidence = path.resolve('evidence/reviewer-packaged');
await fs.mkdir(root, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
const executablePath = path.resolve('release/Diomedes-win32-x64/Diomedes.exe');
const asarPath = path.join(path.dirname(executablePath), 'resources/app.asar');
const env = {
  ...process.env,
  DIOMEDES_DESKTOP_PROFILE: path.join(root, 'profile'),
  DIOMEDES_DATA_DIR: path.join(root, 'data'),
  DIOMEDES_PROJECTS_DIR: path.join(root, 'projects'),
};
delete env.ELECTRON_RUN_AS_NODE;

const errors = [];
const checks = [];
const screenshots = [];
let desktop;
let page;
let defaultUrl = '';
let fixtureUrl = '';
let limitation = null;
const sha256File = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const shot = async (name) => {
  const file = path.join(evidence, name);
  await page.screenshot({ path: file, animations: 'disabled' });
  screenshots.push(file);
};
async function fixtureApi(route, method = 'GET', body) {
  const response = await fetch(`${fixtureUrl}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`fixture ${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function waitState(projectId, predicate, description) {
  const deadline = Date.now() + 25_000;
  let current = await fixtureApi(`/projects/${projectId}/state`);
  while (!predicate(current)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    current = await fixtureApi(`/projects/${projectId}/state`);
  }
  return current;
}
// The main-process function receives the Electron module first and the
// argument second; the fixture switches are plain globals it reads per call.
const setMode = (value) =>
  desktop.evaluate((_electron, mode) => {
    globalThis.__reviewerMode = mode;
  }, value);
const setVerdict = (value) =>
  desktop.evaluate((_electron, verdict) => {
    globalThis.__reviewerVerdict = verdict;
  }, value);

try {
  desktop = await electron.launch({ executablePath, env });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(25_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  defaultUrl = new URL(page.url()).origin;
  checks.push({ name: 'packaged default app serves', ok: true, detail: defaultUrl });
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.getByRole('button').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const started = await desktop.evaluate(async ({ app }) => {
    const out = { ok: false, url: '', error: '' };
    try {
      const appPath = app.getAppPath();
      const nodePath = process.getBuiltinModule('node:path');
      const { createServer } = process.getBuiltinModule('node:http');
      const requireNative = process
        .getBuiltinModule('node:module')
        .createRequire(nodePath.join(appPath, 'package.json'));
      const compiled = requireNative(nodePath.join(appPath, 'server/app.mjs'));
      if (typeof compiled.createApp !== 'function' || typeof compiled.serveClient !== 'function')
        throw new Error('Packaged server module does not export createApp/serveClient.');
      const profile = process.env.DIOMEDES_DESKTOP_PROFILE;
      const dataDir = nodePath.join(profile, '..', 'reviewer-fixture-data');
      const projectRoot = nodePath.join(profile, '..', 'reviewer-fixture-projects');
      const { mkdir } = process.getBuiltinModule('node:fs/promises');
      await mkdir(dataDir, { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      globalThis.__reviewerMode = 'inside';
      globalThis.__reviewerVerdict = { decision: 'approve', reason: 'matches-request' };
      globalThis.__reviewerCalls = 0;
      const generator = async () => {
        const mode = globalThis.__reviewerMode;
        const file =
          mode === 'outside' ? 'Outside-reviewed.md' : `Reviewed/${mode === 'second' ? 'B' : 'A'}.md`;
        return {
          model: 'synthetic-packaged-worker-model',
          text: JSON.stringify({
            summary: 'Create a reviewed packaged note.',
            changes: [
              {
                path: file,
                text: `# Reviewed\n\nWritten under Approve for me (${mode}).\n`,
                summary: 'Create the reviewed note.',
              },
            ],
          }),
        };
      };
      const reviewerAdapter = async () => {
        globalThis.__reviewerCalls += 1;
        const verdict = globalThis.__reviewerVerdict;
        if (verdict === 'unavailable') throw new Error('The packaged fixture reviewer is offline.');
        return {
          text: JSON.stringify(verdict),
          model: 'synthetic-packaged-reviewer-model',
          threadId: 'packaged-review',
        };
      };
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = server.address().port;
      const fixtureApp = await compiled.createApp({
        dataDir,
        projectRoot,
        port,
        clientPort: port,
        nativeGenerator: generator,
        reviewerAdapter,
      });
      compiled.serveClient(fixtureApp, nodePath.join(appPath, 'dist'));
      server.on('request', fixtureApp);
      globalThis.__reviewerFixture = { app: fixtureApp, server, port };
      out.ok = true;
      out.url = `http://127.0.0.1:${port}`;
    } catch (error) {
      out.error = error?.message ?? String(error);
    }
    return out;
  });
  if (!started.ok) {
    limitation = `Compiled factory injection impractical in this build: ${started.error}. Packaged UI-only check only.`;
    checks.push({ name: 'packaged fixture backend', ok: false, detail: limitation });
  } else {
    fixtureUrl = started.url;
    checks.push({
      name: 'packaged fixture backend (compiled module)',
      ok: true,
      detail: fixtureUrl,
    });

    const project = await fixtureApi('/projects/sample', 'POST', {});
    await fs.mkdir(path.join(project.folder, 'Reviewed'), { recursive: true });
    const { found } = await fixtureApi(`/projects/${project.id}/plans/find-tasks`, 'POST', {
      path: 'Reopening plan.md',
    });
    const added = await fixtureApi(`/projects/${project.id}/plans/add-tasks`, 'POST', {
      path: 'Reopening plan.md',
      items: [{ ...found[0], name: 'Packaged reviewed task' }],
    });
    const taskId = added.tasks[0].id;
    await fixtureApi(`/projects/${project.id}/threads`, 'POST', {
      taskId,
      name: 'Thread for Packaged reviewed task',
      permission: 'show-first',
      engine: 'codex',
    });
    await fixtureApi('/settings', 'PUT', {
      surface: 'console',
      detail: 'technical',
      services: { codex: true, defaultEngine: 'codex' },
      onboarding: {
        work: 'business',
        detail: 'technical',
        familiarity: 'comfortable',
        resumeAt: 'done',
        completedAt: new Date().toISOString(),
      },
      openProjects: [project.id],
    });

    await page.goto(fixtureUrl);
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
    const rail = page.getByRole('navigation', { name: 'Threads and views' });
    const board = page.locator('.board[aria-label="Board"]');
    const startTask = async () => {
      // Wait for the host to consider the task startable before touching the
      // Board, and read the page fresh so the row is not a stale poll.
      await waitState(
        project.id,
        (value) =>
          ['todo', 'done', 'waiting'].includes(
            value.tasks.find((item) => item.id === taskId)?.state ?? '',
          ),
        'the task to become startable',
      );
      await page.reload();
      await rail.getByRole('button', { name: /^Board/ }).click();
      await expect(board).toBeVisible();
      const row = board.locator('.crow', { hasText: 'Packaged reviewed task' }).first();
      const reopen = row.getByRole('button', { name: 'Reopen' });
      if (await reopen.count()) await reopen.click();
      const ready = board.locator('.crow', { hasText: 'Packaged reviewed task' }).first();
      await ready.getByRole('button', { name: 'Start', exact: true }).first().click();
      await ready.locator('.confirm').getByRole('button', { name: 'Start', exact: true }).click();
      // Any route but the sample asks first; only the dialog's Send task starts the work.
      const send = page.getByRole('dialog', { name: 'Send this task?', exact: true });
      await expect(send).toBeVisible();
      const { sessions } = await fixtureApi(`/projects/${project.id}/state`);
      await send.getByRole('button', { name: 'Send task', exact: true }).click();
      await expect(send).toHaveCount(0);
      // Send task lists documents again before the host admits the run, and step
      // 5's declined proposal keeps its boundary, so wait until the new run leaves
      // 'working', the moment its own proposal is recorded.
      await waitState(
        project.id,
        (value) =>
          value.sessions.length === sessions.length + 1 &&
          value.sessions.at(-1)?.state !== 'working',
        'the new run to record its proposal',
      );
      await rail
        .getByRole('button', { name: /Packaged reviewed task/ })
        .first()
        .click();
    };

    /* ---- 1. The worker is a named Agent, chosen separately from the model ---- */
    const agentControl = page.getByRole('button', { name: 'Worker for this thread' });
    await expect(agentControl).toBeVisible();
    await agentControl.click();
    const agentMenu = page.getByRole('menu');
    await expect(
      agentMenu.getByText('Choosing a worker does not change what it may do.'),
    ).toBeVisible();
    await agentMenu.getByRole('menuitemradio', { name: /^Change Builder/ }).click();
    await expect(agentControl).toContainText('Change Builder');
    await shot('packaged-agent-picker.png');
    checks.push({
      name: 'packaged Agent selection is a separate axis and grants nothing',
      ok: true,
      detail: 'Change Builder selected; menu states permissions decide authority',
    });

    /* ---- 2. Full access is offered honestly, and is not selectable ---- */
    await page.locator('.task-permission').getByRole('button', { name: 'Review changes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Task permissions' });
    await expect(dialog).toBeVisible();
    const fullRadio = dialog.getByRole('radio', { name: /Full access/ });
    await expect(fullRadio).toBeDisabled();
    await expect(
      dialog.getByText(
        'None. There is no isolated environment on this installation to give unrestricted authority to.',
      ),
    ).toBeVisible();
    await shot('packaged-permission-choices.png');
    checks.push({
      name: 'packaged Full access is unavailable and says which environment is missing',
      ok: true,
      detail: 'radio disabled; no isolated environment named',
    });

    /* ---- 3. Approve for me is confirmed by the person, naming the reviewer ---- */
    await dialog.getByRole('radio', { name: /Approve for me/ }).check();
    await expect(dialog.getByRole('combobox', { name: /reviewer/i }).first()).toBeVisible();
    await dialog.getByText('Edit scope and limits', { exact: true }).click();
    await dialog.locator('textarea').first().fill('Reviewed');
    await shot('packaged-approve-for-me.png');
    await dialog.getByRole('button', { name: 'Confirm task scope' }).click();
    await expect(
      page.locator('.task-permission').getByRole('button', { name: 'Approve for me' }),
    ).toBeVisible({ timeout: 20_000 });
    const grants = await fixtureApi(`/projects/${project.id}/permissions/grants`);
    const pinned = grants.grants.at(-1).grant.reviewer;
    expect(pinned.agentId).toBe('diomedes.reviewer');
    expect(pinned.agentName).toBe('Code Reviewer');
    expect(pinned.agentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    checks.push({
      name: 'packaged reviewer identity pinned at consent',
      ok: true,
      detail: `${pinned.agentName} ${pinned.agentVersion} ${pinned.agentDigest.slice(0, 20)}...`,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    /* ---- 4. An approved change set writes, recorded as a model decision ---- */
    await startTask();
    let state = await waitState(
      project.id,
      (value) => value.needs.at(-1)?.execution?.state === 'applied',
      'the reviewed write',
    );
    let need = state.needs.at(-1);
    const record = need.reviews[0];
    expect(need.authorization.kind).toBe('scope-grant');
    expect(need.authorization.reviewId).toBe(record.id);
    expect(need.approvalReceipt).toBeUndefined();
    expect(record.decisionSource).toBe('model-reviewer');
    expect(record.agent.id).toBe('diomedes.reviewer');
    expect(record.reportedModel).toBe(REVIEWER_MODEL);
    expect(record.proposerReportedModel).toBe(WORKER_MODEL);
    for (const word of ['human', 'andrew', 'user approved', 'local-client'])
      expect(JSON.stringify(record).toLowerCase()).not.toContain(word);
    expect(await fs.readFile(path.join(project.folder, 'Reviewed', 'A.md'), 'utf8')).toContain(
      'Written under Approve for me',
    );
    const approval = page.getByLabel('Approval record').first();
    await approval.getByText('Reviewer record', { exact: true }).click();
    await expect(approval).toContainText('Approved by a separate model reviewer');
    await approval.getByText('Decision record', { exact: true }).click();
    await expect(approval).toContainText('Authorization came from the scope you confirmed');
    // The honest sentence appears exactly once in the open block.
    expect((await approval.innerText()).match(/did not review this output/gi)?.length ?? 0).toBe(1);
    await shot('packaged-reviewer-record.png');
    checks.push({
      name: 'packaged automatic review applies and is labelled a model decision',
      ok: true,
      detail: 'Reviewed/A.md applied under a reviewer decision; no approval receipt',
    });

    /* ---- 5. A refusal writes nothing and keeps the person's own options ---- */
    await fixtureApi(`/projects/${project.id}/review/all`, 'POST', { action: 'keep' });
    await setMode('second');
    await setVerdict({ decision: 'reject', reason: 'outside-request' });
    await startTask();
    state = await waitState(
      project.id,
      (value) => value.needs.at(-1)?.authorizationBoundary !== undefined,
      'the reviewer refusal',
    );
    need = state.needs.at(-1);
    expect(need.state).toBe('open');
    expect(need.execution).toBeUndefined();
    expect(need.authorization).toBeUndefined();
    expect(need.reviews.at(-1).decision).toBe('reject');
    await expect(fs.access(path.join(project.folder, 'Reviewed', 'B.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await shot('packaged-reviewer-refusal.png');
    checks.push({
      name: 'packaged reviewer refusal writes nothing and leaves the person in control',
      ok: true,
      detail: 'Need stays open with a durable reviewer record; Reviewed/B.md absent',
    });

    /* ---- 6. A reviewer that fails never approves ---- */
    // A refused proposal stays the person's to handle, and the task cannot be
    // restarted while it is open. Declining it is the person's decision, made
    // here through the same route the Console uses.
    // Declining still carries the exact proposal identity: Protocol 1 refuses a
    // decision that does not name the bytes it was made about.
    await fixtureApi(`/projects/${project.id}/needs/${need.id}/resolve`, 'POST', {
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      resolution: 'declined',
      proposalDigest: need.approval.proposalDigest,
      actionDigest: need.approval.actionDigest,
      baseDigest: need.approval.baseDigest,
    });
    await fixtureApi(`/projects/${project.id}/review/all`, 'POST', { action: 'keep' });
    await setVerdict('unavailable');
    const before = (await desktop.evaluate(() => globalThis.__reviewerCalls)) ?? 0;
    await startTask();
    state = await waitState(
      project.id,
      (value) => value.needs.at(-1)?.authorizationBoundary !== undefined,
      'the reviewer failure',
    );
    need = state.needs.at(-1);
    expect(need.execution).toBeUndefined();
    expect(need.authorization).toBeUndefined();
    expect(need.state).toBe('open');
    expect((await desktop.evaluate(() => globalThis.__reviewerCalls)) > before).toBe(true);
    await shot('packaged-reviewer-unavailable.png');
    checks.push({
      name: 'packaged reviewer failure falls back to the person',
      ok: true,
      detail: 'No authorization minted when the reviewer could not answer',
    });

    /* ---- 7. Revocation ends the reviewer route ---- */
    await page.locator('.task-permission').getByRole('button', { name: 'Revoke and stop' }).click();
    await expect(
      page.locator('.task-permission').getByRole('button', { name: 'Review changes' }),
    ).toBeVisible({ timeout: 20_000 });
    expect(
      (await fixtureApi(`/projects/${project.id}/permissions/grants`)).grants.every(
        (item) => !item.active,
      ),
    ).toBe(true);
    checks.push({
      name: 'packaged revocation ends automatic review',
      ok: true,
      detail: 'No active grant remains',
    });

    /* ---- 8. The capability answer comes from the packaged host ---- */
    const capabilities = await fixtureApi(
      `/projects/${project.id}/permissions/capabilities?route=codex`,
    );
    expect(capabilities.fullAccess.available).toBe(false);
    expect(capabilities.environments).toEqual([]);
    expect(capabilities.reviewer.available).toBe(true);
    expect(capabilities.reviewer.agentId).toBe('diomedes.reviewer');
    checks.push({
      name: 'packaged capability view refuses Full access and offers a reviewer',
      ok: true,
      detail: capabilities.fullAccess.summary,
    });
  }

  expect(errors).toEqual([]);
  const build = JSON.parse(await fs.readFile('evidence/windows-release/build-info.json', 'utf8'));
  const manifest = {
    at: new Date().toISOString(),
    root,
    executablePath,
    exeSha256: await sha256File(executablePath),
    asarPath,
    asarSha256: await sha256File(asarPath),
    baseCommit: build.baseCommit,
    sourceStatus: build.sourceStatus,
    sourceDigest: build.sourceDigest,
    version: build.version,
    syntheticVsLive:
      'Both the worker and the reviewer were injected synthetic fixtures inside the packaged compiled module. This proves the authority path - which decisions may write, which may not, what is recorded and what the person is told - and proves nothing about a live model\'s judgement. No live provider inference, credentials or billing were involved.',
    defaultUrl,
    fixtureUrl: fixtureUrl || null,
    limitation,
    checks,
    screenshots,
    errors,
  };
  await fs.writeFile(
    path.join(evidence, 'reviewer-desktop-proof.json'),
    JSON.stringify(manifest, null, 2),
  );
  if (limitation) throw new Error(limitation);
  console.log(`PASS: packaged reviewer and Agent smoke. Evidence: ${evidence}`);
} catch (error) {
  console.error(`FAIL: ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  if (desktop) await desktop.close().catch(() => {});
}
