import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Project, ProjectState, TaskCandidate } from '../shared/types';

// Deterministic browser proof for task-scope autonomy using the real built UI
// and a synthetic nativeGenerator. No model calls, credentials, or quota.
// Route stubs are never used to fake backend proof: work starts, scope
// grants, approvals, revocation, and review keeps all hit the owned fixture
// host created below. page.request/fetch is only setup/teardown against that
// same host, never a claim of UI behaviour.

// Fresh-dist guard must walk client/shared recursively. A top-level readdir
// misses nested console/workbench edits and would pass against a stale bundle.
async function expectFreshBundle(dist: string): Promise<void> {
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  let newest = 0;
  let newestPath = '';
  async function visit(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await visit(full);
        continue;
      }
      if (!entry.isFile() || !/\.(ts|tsx|js|css)$/.test(entry.name)) continue;
      const { mtimeMs } = await fs.stat(full);
      if (mtimeMs > newest) {
        newest = mtimeMs;
        newestPath = path.relative(process.cwd(), full);
      }
    }
  }
  for (const dir of ['client', 'shared']) await visit(path.resolve(dir));
  expect(
    built,
    `dist is older than ${newestPath}, so this spec would test the previous build. Run "npm run build" first.`,
  ).toBeGreaterThan(newest);
}

test.describe.configure({ mode: 'serial' });

const SYNTHETIC_MODEL = 'synthetic-autonomy-fixture-model';
const EVIDENCE = path.resolve('evidence/autonomy-workbench');
const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';
let callCount = 0;
let proposalMode: 'single-new' | 'multi-new' | 'out-of-scope' = 'single-new';
// When gated, the next generation waits until the test releases it. Used only
// for the truthful Stop check; every other proposal resolves immediately.
let gateNext = false;
let releaseGate: (() => void) | null = null;

function proposalText(): { text: string; model: string } {
  if (proposalMode === 'multi-new') {
    return {
      model: SYNTHETIC_MODEL,
      text: JSON.stringify({
        summary: 'Add two scoped fixture notes.',
        changes: [
          {
            path: 'Scope-note-A.md',
            text: '# Scope note A\n\nSecond-run scoped write.\n',
            summary: 'Create scope note A.',
          },
          {
            path: 'Scope-note-B.md',
            text: '# Scope note B\n\nSecond-run scoped write.\n',
            summary: 'Create scope note B.',
          },
        ],
      }),
    };
  }
  if (proposalMode === 'out-of-scope') {
    return {
      model: SYNTHETIC_MODEL,
      text: JSON.stringify({
        summary: 'Propose a file outside the confirmed reports scope.',
        changes: [
          {
            path: 'Elsewhere.md',
            text: '# Elsewhere\n\nOutside the confirmed scope.\n',
            summary: 'Create a file outside reports.',
          },
        ],
      }),
    };
  }
  return {
    model: SYNTHETIC_MODEL,
    text: JSON.stringify({
      summary: 'Create the scope fixture proof file.',
      changes: [
        {
          path: 'Autonomy-proof.md',
          text: '# Autonomy proof\n\nScope fixture first proposal.\n',
          summary: 'Create the scope fixture proof file.',
        },
      ],
    }),
  };
}

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(
      `Autonomy fixture ${route} failed (${response.status}): ${await response.text()}`,
    );
  return response.json() as Promise<T>;
}

async function settled(projectId: string): Promise<ProjectState> {
  let current = await api<ProjectState>(`/projects/${projectId}/state`);
  const deadline = Date.now() + 20_000;
  while (current.sessions.at(-1)?.state === 'working') {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the fixture run to settle.');
    await new Promise((resolve) => setTimeout(resolve, 150));
    current = await api<ProjectState>(`/projects/${projectId}/state`);
  }
  return current;
}

async function keepAll(projectId: string): Promise<void> {
  await api(`/projects/${projectId}/review/all`, 'POST', { action: 'keep' });
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  await fs.mkdir(EVIDENCE, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'autonomy-ui-'));
  // Reserve an owned port before constructing the real origin allowlist.
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  baseURL = `http://127.0.0.1:${port}`;
  application = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(fixtureRoot, 'data'),
    projectRoot: path.join(fixtureRoot, 'projects'),
    nativeGenerator: async () => {
      callCount += 1;
      if (gateNext) {
        gateNext = false;
        await new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        releaseGate = null;
      }
      const proposal = proposalText();
      // Clearly synthetic: the model string is a fixture constant, never a live pick.
      return { model: proposal.model, text: proposal.text };
    },
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  await expectFreshBundle(dist);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server.on('request', application);
});

test.afterAll(async () => {
  // Close only owned handles. Test-data directories are left for the parent.
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function makeTaskProject(
  taskName: string,
): Promise<{ project: Project; taskId: string; threadId: string }> {
  const project = await api<Project>('/projects/sample', 'POST', {});
  const { found } = await api<{ found: TaskCandidate[] }>(
    `/projects/${project.id}/plans/find-tasks`,
    'POST',
    {
      path: 'Reopening plan.md',
    },
  );
  const created = await api<{ tasks: { id: string }[] }>(
    `/projects/${project.id}/plans/add-tasks`,
    'POST',
    {
      path: 'Reopening plan.md',
      items: [{ ...found[0], name: taskName }],
    },
  );
  const taskId = created.tasks[0].id;
  const thread = await api<{ id: string }>(`/projects/${project.id}/threads`, 'POST', {
    taskId,
    name: taskName,
    permission: 'show-first',
    engine: 'codex',
  });
  await api('/settings', 'PUT', {
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
  return { project, taskId, threadId: thread.id };
}

function rail(page: Page) {
  return page.getByRole('navigation', { name: 'Threads and views' });
}

async function startFromBoard(page: Page, taskName: string): Promise<void> {
  await rail(page)
    .getByRole('button', { name: /^Board/ })
    .click();
  const board = page.locator('.board[aria-label="Board"]');
  await expect(board).toBeVisible();
  const row = board.locator('.crow', { hasText: taskName }).first();
  await expect(row).toBeVisible();
  const start = row.getByRole('button', { name: 'Start', exact: true }).first();
  await start.click();
  const confirm = row.locator('.confirm');
  await expect(confirm.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: 'Start', exact: true }).click();
}

async function openThread(page: Page, taskName: string): Promise<void> {
  await rail(page)
    .getByRole('button', { name: new RegExp(taskName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .first()
    .click();
  await expect(page.locator('#scrThread')).toBeVisible();
}

test('scope confirmation covers the same task; recorded actor survives a picker mutation', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  proposalMode = 'single-new';
  const taskName = 'Autonomy scope task';
  const { project } = await makeTaskProject(taskName);
  const beforePlan = await fs.readFile(path.join(project.folder, 'Reopening plan.md'), 'utf8');

  await page.goto(baseURL);
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
  await startFromBoard(page, taskName);
  await openThread(page, taskName);
  const need = page.getByRole('region', { name: 'Needs your OK' });
  await expect(need).toBeVisible({ timeout: 20_000 });
  // Saved runtime actor, not the current picker text.
  await expect(need.getByText(SYNTHETIC_MODEL).first()).toBeVisible();
  await expect
    .poll(async () => fs.readFile(path.join(project.folder, 'Reopening plan.md'), 'utf8'))
    .toBe(beforePlan);
  await expect(async () => {
    await fs.stat(path.join(project.folder, 'Autonomy-proof.md'));
  }).rejects.toThrow();

  // Mutate the saved picker default after the proposal exists. The recorded
  // origin must keep the runtime-reported synthetic model.
  await api('/settings', 'PUT', {
    services: { codex: true, defaultEngine: 'codex', codexModel: 'different-request' },
  });
  await page.reload();
  await openThread(page, taskName);
  await expect(
    page.getByRole('region', { name: 'Needs your OK' }).getByText(SYNTHETIC_MODEL).first(),
  ).toBeVisible();
  await api('/settings', 'PUT', { services: { codex: true, defaultEngine: 'codex' } });

  // Exact first approval: preview, then Go ahead in the dialog.
  await page
    .getByRole('region', { name: 'Needs your OK' })
    .getByRole('button', { name: 'Show me first', exact: true })
    .click();
  const preview = page.getByRole('dialog');
  await expect(preview).toBeVisible();
  await expect(preview.getByText(/Scope fixture first proposal/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('scope-first-preview.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await preview.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect(
    page.getByText('Approved changes applied. Their versions are in History.'),
  ).toBeVisible();
  expect(await fs.readFile(path.join(project.folder, 'Autonomy-proof.md'), 'utf8')).toContain(
    'Scope fixture first proposal',
  );
  let state = await settled(project.id);
  const first = state.needs.at(-1)!;
  expect(first.approvalReceipt?.decision).toBe('go-ahead');
  expect(first.authorization).toBeUndefined();
  expect(first.origin?.model.reported).toBe(SYNTHETIC_MODEL);
  expect(first.origin?.mode).toBe('direct');

  // Confirm the task scope once via the real PermissionPanel.
  await page.locator('.task-permission').getByRole('button', { name: 'Review changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Task permissions' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Confirm for this task/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('permission-panel.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await fs.mkdir(EVIDENCE, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE, 'autonomy-permission-panel.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Confirm task scope' }).click();
  await expect(
    page.locator('.task-permission').getByRole('button', { name: 'Work in this project' }),
  ).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  const grants = await api<{ grants: { active: boolean; grant: { taskId: string } }[] }>(
    `/projects/${project.id}/permissions/grants`,
  );
  expect(grants.grants.some((record) => record.active)).toBe(true);

  // Same task again with a multi-file proposal: no additional dialog.
  await keepAll(project.id);
  proposalMode = 'multi-new';
  await rail(page)
    .getByRole('button', { name: /^Board/ })
    .click();
  const board = page.locator('.board[aria-label="Board"]');
  const doneRow = board.locator('.crow', { hasText: taskName }).first();
  await doneRow.getByRole('button', { name: 'Reopen' }).click();
  await startFromBoard(page, taskName);
  state = await settled(project.id);
  const scoped = state.needs.at(-1)!;
  expect(scoped.authorization?.kind).toBe('scope-grant');
  expect(scoped.approvalReceipt).toBeUndefined();
  expect(await fs.readFile(path.join(project.folder, 'Scope-note-A.md'), 'utf8')).toContain(
    'Second-run scoped write',
  );
  expect(await fs.readFile(path.join(project.folder, 'Scope-note-B.md'), 'utf8')).toContain(
    'Second-run scoped write',
  );
  await openThread(page, taskName);
  await expect(page.getByRole('region', { name: 'Needs your OK' })).toHaveCount(0);

  // Inspector expands with source/authorization and honest non-harness state.
  const inspector = page.locator('details.run-inspector');
  await expect(inspector).toBeVisible();
  await inspector.locator('summary').click();
  // Governance rows: the Agent, how it was chosen, and honest gaps for what a
  // session does not record yet. An unknown row is present and readable, not hidden.
  await expect(inspector.getByRole('term').filter({ hasText: /^Worker$/ })).toBeVisible();
  await expect(inspector.getByText(/^Change Builder 1\.0\.0$/)).toBeVisible();
  await expect(
    inspector.getByText(/The worker was picked by hand|Diomedes picked the worker/),
  ).toBeVisible();
  await expect(inspector.getByText(/Nothing records which rules governed it/)).toBeVisible();
  await expect(inspector.getByText(/Nothing records who paid/)).toBeVisible();
  await inspector
    .getByRole('term')
    .filter({ hasText: /^Worker$/ })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(EVIDENCE, 'autonomy-scope-governance.png'),
    animations: 'disabled',
  });
  await expect(
    inspector.getByRole('heading', { name: 'Recorded authorization', exact: true }),
  ).toBeVisible();
  await expect(inspector.getByText('Allowed by a task scope grant')).toBeVisible();
  await expect(inspector.getByText('Resolved by task scope')).toBeVisible();
  await expect(
    inspector.getByRole('heading', { name: 'Recorded sources', exact: true }),
  ).toBeVisible();
  await expect(
    inspector.getByRole('heading', { name: 'Runtime evidence', exact: true }),
  ).toBeVisible();
  await inspector.getByRole('button', { name: 'Refresh' }).click();
  await expect(
    inspector.getByText(/No detailed Runtime record is linked to this session/),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({
    path: testInfo.outputPath('scope-inspector.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(EVIDENCE, 'autonomy-scope-inspector.png'),
    animations: 'disabled',
    fullPage: true,
  });

  // Board truth + Ledger recent history.
  await rail(page)
    .getByRole('button', { name: /^Board/ })
    .click();
  await expect(page.locator('.board[aria-label="Board"]')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('scope-board.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(EVIDENCE, 'autonomy-scope-board.png'),
    animations: 'disabled',
    fullPage: true,
  });
  state = await api<ProjectState>(`/projects/${project.id}/state`);
  expect(state.history.some((entry) => entry.kind === 'changed')).toBe(true);
  expect(errors).toEqual([]);
});

test('out-of-scope proposals wait for exact review; revocation forces exact approval again', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const taskName = 'Autonomy boundary task';
  const { project } = await makeTaskProject(taskName);
  await fs.mkdir(path.join(project.folder, 'reports'), { recursive: true });
  const beforePlan = await fs.readFile(path.join(project.folder, 'Reopening plan.md'), 'utf8');
  proposalMode = 'out-of-scope';

  await page.goto(baseURL);
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
  await openThread(page, taskName);
  // Narrow the grant to reports only through the real panel.
  await page.locator('.task-permission').getByRole('button', { name: 'Review changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Task permissions' });
  await expect(dialog).toBeVisible();
  await dialog.getByText('Edit scope and limits', { exact: true }).click();
  await dialog.locator('textarea').first().fill('reports');
  await dialog.getByRole('button', { name: 'Confirm task scope' }).click();
  await expect(
    page.locator('.task-permission').getByRole('button', { name: 'Work in this project' }),
  ).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');

  await startFromBoard(page, taskName);
  await openThread(page, taskName);
  const need = page.getByRole('region', { name: 'Needs your OK' });
  await expect(need).toBeVisible({ timeout: 20_000 });
  await expect(
    need.getByRole('button', { name: 'Allow creates and updates for this task' }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('boundary-prompt.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(EVIDENCE, 'autonomy-boundary-prompt.png'),
    animations: 'disabled',
    fullPage: true,
  });
  const state = await settled(project.id);
  // Working settles to waiting: the boundary held, nothing was written.
  expect(state.needs.at(-1)?.state).toBe('open');
  await expect(need.getByText(/Approval needed:.*outside.*authorized/i)).toBeVisible();
  expect(state.needs.at(-1)?.authorization).toBeUndefined();
  await expect(async () => {
    await fs.stat(path.join(project.folder, 'Elsewhere.md'));
  }).rejects.toThrow();
  expect(await fs.readFile(path.join(project.folder, 'Reopening plan.md'), 'utf8')).toBe(
    beforePlan,
  );

  // An exact OK still crosses the boundary explicitly.
  await need.getByRole('button', { name: 'Show me first', exact: true }).click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByText(/Outside the confirmed scope/)).toBeVisible();
  await preview.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect(
    page.getByText('Approved changes applied. Their versions are in History.'),
  ).toBeVisible();
  expect(await fs.readFile(path.join(project.folder, 'Elsewhere.md'), 'utf8')).toContain(
    'Outside the confirmed scope',
  );
  const decided = (await api<ProjectState>(`/projects/${project.id}/state`)).needs.at(-1)!;
  expect(decided.approvalReceipt?.decision).toBe('go-ahead');
  expect(decided.authorization).toBeUndefined();

  // Revoke from the thread badge. Future scoped writes are blocked.
  await page.locator('.task-permission').getByRole('button', { name: 'Revoke and stop' }).click();
  await expect(
    page.locator('.task-permission').getByRole('button', { name: 'Review changes' }),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({
    path: testInfo.outputPath('revoked-state.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(EVIDENCE, 'autonomy-revoked-state.png'),
    animations: 'disabled',
    fullPage: true,
  });
  const grants = await api<{ grants: { active: boolean }[] }>(
    `/projects/${project.id}/permissions/grants`,
  );
  expect(grants.grants.every((record) => !record.active)).toBe(true);

  // Next attempt on the same task requires exact approval again.
  await keepAll(project.id);
  proposalMode = 'single-new';
  await rail(page)
    .getByRole('button', { name: /^Board/ })
    .click();
  const board = page.locator('.board[aria-label="Board"]');
  const doneRow = board.locator('.crow', { hasText: taskName }).first();
  await doneRow.getByRole('button', { name: 'Reopen' }).click();
  await startFromBoard(page, taskName);
  await openThread(page, taskName);
  await expect(page.getByRole('region', { name: 'Needs your OK' })).toBeVisible({
    timeout: 20_000,
  });
  const after = await settled(project.id);
  expect(after.needs.at(-1)?.state).toBe('open');
  expect(after.needs.at(-1)?.authorization).toBeUndefined();
  expect(errors).toEqual([]);
});

test('long names hold at 800px; Stop is truthful and inspector refresh stays honest', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const taskName = `Autonomy overflow check with a deliberately long task name near the limit ${'x'.repeat(40)}`;
  const { project } = await makeTaskProject(taskName.slice(0, 120));
  const shortName = taskName.slice(0, 120);

  await page.goto(baseURL);
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'console');
  await page.setViewportSize({ width: 800, height: 900 });
  await rail(page)
    .getByRole('button', { name: /^Board/ })
    .click();
  const board = page.locator('.board[aria-label="Board"]');
  await expect(board).toBeVisible();
  await expect(board.locator('.crow', { hasText: shortName.slice(0, 20) }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath('overflow-800.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.screenshot({
    path: path.join(EVIDENCE, 'autonomy-overflow-800.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Truthful Stop: gate one run, stop it from the Board, prove no write.
  proposalMode = 'single-new';
  gateNext = true;
  await startFromBoard(page, shortName);
  await expect
    .poll(
      async () => (await api<ProjectState>(`/projects/${project.id}/state`)).sessions.at(-1)?.state,
    )
    .toBe('working');
  await expect(
    board
      .locator('.column[aria-label="Working"]')
      .locator('.crow', { hasText: shortName.slice(0, 20) }),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({
    path: testInfo.outputPath('board-working.png'),
    animations: 'disabled',
    fullPage: true,
  });
  const workingRow = board.locator('.crow', { hasText: shortName.slice(0, 20) }).first();
  await workingRow.getByRole('button', { name: 'Stop' }).click();
  releaseGate?.();
  const stopped = await settled(project.id);
  expect(stopped.sessions.at(-1)?.state).toBe('stopped');
  await expect(async () => {
    await fs.stat(path.join(project.folder, 'Autonomy-proof.md'));
  }).rejects.toThrow();
  await expect(
    board
      .locator('.column[aria-label="Ready"]')
      .locator('.crow', { hasText: shortName.slice(0, 20) }),
  ).toBeVisible({ timeout: 15_000 });

  // Inspector refresh on a non-harness NativeWork session stays honest.
  await openThread(page, shortName);
  const inspector = page.locator('details.run-inspector');
  await expect(inspector).toBeVisible();
  await inspector.locator('summary').click();
  await expect(
    inspector.getByRole('heading', { name: 'Runtime evidence', exact: true }),
  ).toBeVisible();
  await inspector.getByRole('button', { name: 'Refresh' }).click();
  await expect(
    inspector.getByText(/No detailed Runtime record is linked to this session/),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({
    path: testInfo.outputPath('inspector-refresh.png'),
    animations: 'disabled',
    fullPage: true,
  });

  // Stale saved-approval evidence surfaces instead of silently clearing.
  await page.evaluate(
    (id) => sessionStorage.setItem(`diomedes.approval.pending.${id}|broken`, '{broken'),
    project.id,
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText(
    'A saved approval request could not be checked',
  );
  await page.screenshot({
    path: testInfo.outputPath('stale-evidence.png'),
    animations: 'disabled',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
