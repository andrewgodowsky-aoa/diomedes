import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Packaged proof for task-scope autonomy. Runs the candidate EXE with an
// isolated profile, captures the default first-run app, then starts a second
// owned fixture host from the PACKAGED compiled server module (never source)
// with a clearly synthetic nativeGenerator, and exercises the same
// interactions against the packaged backend + packaged UI.
// No live discovery, inference, credentials, or billing routes.
const SYNTHETIC_MODEL = 'synthetic-packaged-fixture-model';
const root = path.resolve('test-results', `autonomy-desktop-${Date.now()}`);
const evidence = path.resolve('evidence/autonomy-workbench');
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
  const deadline = Date.now() + 20_000;
  let current = await fixtureApi(`/projects/${projectId}/state`);
  while (!predicate(current)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    current = await fixtureApi(`/projects/${projectId}/state`);
  }
  return current;
}

try {
  desktop = await electron.launch({ executablePath, env });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  defaultUrl = new URL(page.url()).origin;
  checks.push({ name: 'packaged default app serves', ok: true, detail: defaultUrl });
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.getByRole('button').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await shot('desktop-autonomy-first-run.png');

  // Start the fixture host inside Electron's main process from the COMPILED
  // bundled module. desktop/main.mjs serves ./server/app.mjs + ./dist from
  // the app path (see scripts/package-desktop.mjs staging); import that same
  // compiled factory rather than any source server module.
  const started = await desktop.evaluate(async ({ app }) => {
    const out = { ok: false, url: '', error: '' };
    try {
      const appPath = app.getAppPath();
      const nodePath = process.getBuiltinModule('node:path');
      const { createServer } = process.getBuiltinModule('node:http');
      // Playwright evaluates in a VM without a dynamic-import callback. Node's
      // createRequire loads the packaged synchronous ESM bundle in that context.
      const requireNative = process
        .getBuiltinModule('node:module')
        .createRequire(nodePath.join(appPath, 'package.json'));
      const compiled = requireNative(nodePath.join(appPath, 'server/app.mjs'));
      if (typeof compiled.createApp !== 'function' || typeof compiled.serveClient !== 'function') {
        throw new Error('Packaged server module does not export createApp/serveClient.');
      }
      const profile = process.env.DIOMEDES_DESKTOP_PROFILE;
      const dataDir = nodePath.join(profile, '..', 'autonomy-fixture-data');
      const projectRoot = nodePath.join(profile, '..', 'autonomy-fixture-projects');
      const { mkdir } = process.getBuiltinModule('node:fs/promises');
      await mkdir(dataDir, { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      globalThis.__autonomyProposalMode = 'single-new';
      const generator = async () => {
        const mode = globalThis.__autonomyProposalMode;
        if (mode === 'multi-new') {
          return {
            model: 'synthetic-packaged-fixture-model',
            text: JSON.stringify({
              summary: 'Add two packaged scoped notes.',
              changes: [
                {
                  path: 'Packaged/A.md',
                  text: '# Packaged A\n\nScoped packaged write.\n',
                  summary: 'Create packaged A.',
                },
                {
                  path: 'Packaged/B.md',
                  text: '# Packaged B\n\nScoped packaged write.\n',
                  summary: 'Create packaged B.',
                },
              ],
            }),
          };
        }
        if (mode === 'outside') {
          return {
            model: 'synthetic-packaged-fixture-model',
            text: JSON.stringify({
              summary: 'Propose a note outside the allowed folder.',
              changes: [
                {
                  path: 'Outside-packaged.md',
                  text: 'This needs exact approval.\n',
                  summary: 'Create an out-of-scope note.',
                },
              ],
            }),
          };
        }
        return {
          model: 'synthetic-packaged-fixture-model',
          text: JSON.stringify({
            summary: 'Create the packaged scope proof file.',
            changes: [
              {
                path: 'Packaged-proof.md',
                text: '# Packaged proof\n\nSynthetic packaged proposal.\n',
                summary: 'Create the packaged proof file.',
              },
            ],
          }),
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
      });
      compiled.serveClient(fixtureApp, nodePath.join(appPath, 'dist'));
      server.on('request', fixtureApp);
      globalThis.__autonomyFixture = { app: fixtureApp, server, port };
      out.ok = true;
      out.url = `http://127.0.0.1:${port}`;
    } catch (error) {
      out.error = error?.message ?? String(error);
    }
    return out;
  });
  if (!started.ok) {
    // Honest packaged UI-only check: report the limitation, keep first-run
    // captures, and never add a production bypass.
    limitation = `Compiled factory injection impractical in this build: ${started.error}. Packaged UI-only check only.`;
    checks.push({ name: 'packaged fixture backend', ok: false, detail: limitation });
  } else {
    fixtureUrl = started.url;
    checks.push({
      name: 'packaged fixture backend (compiled module)',
      ok: true,
      detail: fixtureUrl,
    });

    // Fixture setup against the packaged backend (real proof, not stubs).
    const project = await fixtureApi('/projects/sample', 'POST', {});
    await fs.mkdir(path.join(project.folder, 'Packaged'));
    const found = (
      await fixtureApi(`/projects/${project.id}/plans/find-tasks`, 'POST', {
        path: 'Reopening plan.md',
      })
    ).found;
    const added = await fixtureApi(`/projects/${project.id}/plans/add-tasks`, 'POST', {
      path: 'Reopening plan.md',
      items: [{ ...found[0], name: 'Packaged scope task' }],
    });
    const taskName = added.tasks[0].name;
    await fixtureApi(`/projects/${project.id}/threads`, 'POST', {
      taskId: added.tasks[0].id,
      name: `Thread for ${taskName}`,
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
    // Any route but the sample asks first; only the dialog's Send task starts the work.
    const confirmSend = async () => {
      const send = page.getByRole('dialog', { name: 'Send this task?', exact: true });
      await expect(send).toBeVisible();
      await send.getByRole('button', { name: 'Send task', exact: true }).click();
      await expect(send).toHaveCount(0);
    };
    await rail.getByRole('button', { name: /^Board/ }).click();
    const board = page.locator('.board[aria-label="Board"]');
    await expect(board).toBeVisible();
    const row = board.locator('.crow', { hasText: 'Packaged scope task' }).first();
    await row.getByRole('button', { name: 'Start', exact: true }).first().click();
    const confirm = row.locator('.confirm');
    await confirm.getByRole('button', { name: 'Start', exact: true }).click();
    await confirmSend();
    await rail
      .getByRole('button', { name: /Packaged scope task/ })
      .first()
      .click();
    const need = page.getByRole('region', { name: 'Needs your OK' });
    await expect(need).toBeVisible({ timeout: 20_000 });
    await expect(need.getByText(SYNTHETIC_MODEL).first()).toBeVisible();
    checks.push({
      name: 'packaged exact proposal shows synthetic actor',
      ok: true,
      detail: SYNTHETIC_MODEL,
    });
    await need.getByRole('button', { name: 'Show me first', exact: true }).click();
    const preview = page.getByRole('dialog');
    await expect(preview.getByText(/Packaged proof/).first()).toBeVisible();
    await shot('desktop-autonomy-preview.png');
    await preview.getByRole('button', { name: 'Go ahead', exact: true }).click();
    let state = await waitState(
      project.id,
      (value) => value.needs.at(-1)?.execution?.state === 'applied',
      'the exact write',
    );
    expect(state.needs.at(-1)?.approvalReceipt?.decision).toBe('go-ahead');
    expect(await fs.readFile(path.join(project.folder, 'Packaged-proof.md'), 'utf8')).toContain(
      'Synthetic packaged proposal.',
    );
    checks.push({
      name: 'packaged exact approval writes',
      ok: true,
      detail: 'Packaged-proof.md applied',
    });

    await page.locator('.task-permission').getByRole('button', { name: 'Review changes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Task permissions' });
    await expect(dialog).toBeVisible();
    await dialog.getByText('Edit scope and limits', { exact: true }).click();
    await dialog.locator('textarea').first().fill('Packaged');
    await shot('desktop-autonomy-permissions.png');
    await dialog.getByRole('button', { name: 'Confirm task scope' }).click();
    await expect(
      page.locator('.task-permission').getByRole('button', { name: 'Work in this project' }),
    ).toBeVisible({ timeout: 15_000 });
    checks.push({
      name: 'packaged scope confirmation',
      ok: true,
      detail: 'Work in this project badge',
    });
    await page.keyboard.press('Escape');

    await fixtureApi(`/projects/${project.id}/review/all`, 'POST', { action: 'keep' });
    await desktop.evaluate(() => {
      globalThis.__autonomyProposalMode = 'multi-new';
    });
    await rail.getByRole('button', { name: /^Board/ }).click();
    const doneRow = board.locator('.crow', { hasText: 'Packaged scope task' }).first();
    await doneRow.getByRole('button', { name: 'Reopen' }).click();
    const readyRow = board.locator('.crow', { hasText: 'Packaged scope task' }).first();
    await readyRow.getByRole('button', { name: 'Start', exact: true }).first().click();
    const confirm2 = readyRow.locator('.confirm');
    await confirm2.getByRole('button', { name: 'Start', exact: true }).click();
    await confirmSend();
    state = await waitState(
      project.id,
      (value) =>
        value.sessions.length === 2 &&
        value.needs.length === 2 &&
        value.needs.at(-1)?.execution?.state === 'applied',
      'the two scoped writes',
    );
    expect(state.needs.at(-1)?.authorization?.kind).toBe('scope-grant');
    expect(state.needs.at(-1)?.approvalReceipt).toBeUndefined();
    for (const name of ['A.md', 'B.md'])
      expect(await fs.readFile(path.join(project.folder, 'Packaged', name), 'utf8')).toContain(
        'Scoped packaged write.',
      );
    checks.push({
      name: 'packaged scope auto-applies same-task writes',
      ok: true,
      detail: 'Packaged/A.md and Packaged/B.md contents verified',
    });
    await shot('desktop-autonomy-scoped.png');

    await rail
      .getByRole('button', { name: /Packaged scope task/ })
      .first()
      .click();
    const inspector = page.locator('details.run-inspector');
    await expect(inspector).toBeVisible();
    await inspector.locator('summary').click();
    await expect(inspector.getByText('Allowed by a task scope grant')).toBeVisible();
    await inspector.getByRole('button', { name: 'Refresh' }).click();
    await expect(
      inspector.getByText(/No detailed Runtime record is linked to this session/),
    ).toBeVisible({ timeout: 15_000 });
    await shot('desktop-autonomy-inspector.png');
    checks.push({
      name: 'packaged inspector honest non-harness state',
      ok: true,
      detail: 'Runtime evidence empty',
    });

    await fixtureApi(`/projects/${project.id}/review/all`, 'POST', { action: 'keep' });
    await desktop.evaluate(() => {
      globalThis.__autonomyProposalMode = 'outside';
    });
    await rail.getByRole('button', { name: /^Board/ }).click();
    await board
      .locator('.crow', { hasText: taskName })
      .first()
      .getByRole('button', { name: 'Reopen' })
      .click();
    const boundaryRow = board.locator('.crow', { hasText: taskName }).first();
    await boundaryRow.getByRole('button', { name: 'Start', exact: true }).first().click();
    await boundaryRow
      .locator('.confirm')
      .getByRole('button', { name: 'Start', exact: true })
      .click();
    await confirmSend();
    await rail
      .getByRole('button', { name: /Packaged scope task/ })
      .first()
      .click();
    await expect(need).toBeVisible();
    await expect(need).toContainText('outside the folders you authorized');
    state = await waitState(
      project.id,
      (value) => value.sessions.length === 3 && value.sessions.at(-1)?.state === 'waiting',
      'the scope boundary',
    );
    expect(state.needs.at(-1)?.authorization).toBeUndefined();
    await expect(fs.access(path.join(project.folder, 'Outside-packaged.md'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    await shot('desktop-autonomy-boundary.png');
    checks.push({
      name: 'packaged scope boundary holds',
      ok: true,
      detail: 'Outside-packaged.md waits for exact approval and is absent on disk',
    });

    await page.locator('.task-permission').getByRole('button', { name: 'Revoke and stop' }).click();
    await expect(
      page.locator('.task-permission').getByRole('button', { name: 'Review changes' }),
    ).toBeVisible({ timeout: 15_000 });
    await shot('desktop-autonomy-revoked.png');
    checks.push({ name: 'packaged revoke blocks scope', ok: true, detail: 'Review changes badge' });
    expect(
      (await fixtureApi(`/projects/${project.id}/permissions/grants`)).grants.every(
        (record) => !record.active,
      ),
    ).toBe(true);
    await expect(fs.access(path.join(project.folder, 'Outside-packaged.md'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    state = await fixtureApi(`/projects/${project.id}/state`);
    const changed = state.history.filter((entry) => entry.kind === 'changed');
    expect(changed).toHaveLength(2);
    expect(changed.every((entry) => entry.origin?.model?.reported === SYNTHETIC_MODEL)).toBe(true);
    expect(
      changed.flatMap((entry) => entry.files).every((file) => /^[a-f0-9]{64}$/.test(file.after)),
    ).toBe(true);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.locator('.history-entry').first()).toBeVisible();
    await shot('desktop-autonomy-history.png');
    checks.push({
      name: 'packaged History retains attributed hashes',
      ok: true,
      detail: 'Two change sets, three file versions, original synthetic actor',
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
      'Every proposal in this run used an injected synthetic generator (synthetic-packaged-fixture-model) inside the packaged compiled module. No live provider inference or billing changes were performed.',
    defaultUrl,
    fixtureUrl: fixtureUrl || null,
    limitation,
    checks,
    screenshots,
    errors,
  };
  await fs.writeFile(
    path.join(evidence, 'autonomy-desktop-proof.json'),
    JSON.stringify(manifest, null, 2),
  );
  if (limitation) throw new Error(limitation);
  console.log(`PASS: packaged autonomy smoke. Evidence: ${evidence}`);
} finally {
  // Close the owned fixture host before the desktop closes. Never touches
  // the user's live installation or credentials.
  if (desktop && fixtureUrl) {
    try {
      await desktop.evaluate(async () => {
        const fixture = globalThis.__autonomyFixture;
        if (fixture) {
          await fixture.app.locals.close();
          fixture.server.closeAllConnections();
          await new Promise((resolve) => fixture.server.close(resolve));
          globalThis.__autonomyFixture = undefined;
        }
      });
    } catch {
      // Cleanup is best-effort; the desktop close below still runs.
    }
  }
  if (desktop) await desktop.close();
}
