import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { ApprovalCommand, Need, Project, ProjectState } from '../shared/types';
import type { RememberedApprovalsView } from '../shared/permissions';
import { reopenLastProject } from './fixtures/landing';

/**
 * Remembered approvals in the Console (work order D5). Both routes are the
 * person's click: "Go ahead and remember in this project" beside the exact
 * Go ahead, and the learned offer asked once, inline where the approvals were
 * given. A step covered later says whose approval it ran under and since when,
 * and the permissions dialog is the one place that lists and revokes them.
 */
test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';
/** The scripted Codex runtime: the account it reports and the proposal it returns. */
const CODEX_ACCOUNT = `openai:chatgpt:${'c'.repeat(64)}`;
let codexProposal: { path: string; text: string }[] = [];

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(
      `Remembered fixture ${route} failed (${response.status}): ${await response.text()}`,
    );
  return response.json() as Promise<T>;
}

async function newProject(name: string) {
  const project = await api<Project>('/projects', 'POST', { name });
  await api(`/projects/${project.id}/threads`, 'POST', { name: 'Talk it through' });
  await api('/settings', 'PUT', { openProjects: [project.id] });
  return project;
}

/** Start the fixture procedure and wait until its step is waiting or already covered. */
async function startRun(project: Project) {
  const session = await api<{ id: string }>(`/projects/${project.id}/work/start`, 'POST', {
    capabilityId: 'format-report',
    taskId: null,
    instruction: 'Format the shipped synthetic fixture.',
  });
  await expect
    .poll(
      async () =>
        (await api<ProjectState>(`/projects/${project.id}/state`)).needs.some(
          (need) => need.sessionId === session.id,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  const state = await api<ProjectState>(`/projects/${project.id}/state`);
  return state.needs.find((need) => need.sessionId === session.id)!;
}
async function finished(project: Project, need: Need) {
  await expect
    .poll(
      async () =>
        (await api<ProjectState>(`/projects/${project.id}/state`)).sessions.find(
          (session) => session.id === need.sessionId,
        )?.state,
      { timeout: 30_000 },
    )
    .toMatch(/done|stopped/);
}
/** An exact approval given through the API, the way a second window would. */
async function approveByApi(project: Project) {
  const need = await startRun(project);
  const command: ApprovalCommand = {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    resolution: 'go-ahead',
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  };
  await api(`/projects/${project.id}/needs/${need.id}/resolve`, 'POST', command);
  await finished(project, need);
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'remembered-approvals-ui-'));
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
    nativeGenerator: async (input) => {
      if (input.engine === 'codex') input.onAccountRoute?.(CODEX_ACCOUNT);
      return {
        model: 'fixture-model',
        text: JSON.stringify({
          summary: codexProposal.length ? 'Revise the menu' : '',
          changes: codexProposal.map((change) => ({ ...change, summary: 'Revision' })),
        }),
      };
    },
    reviewerAdapter: null,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server.on('request', application);
  await api('/settings', 'PUT', {
    view: 'architect',
    detail: 'standard',
    onboarding: {
      work: 'business',
      detail: 'standard',
      familiarity: 'some',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

const rail = (page: Page) => page.getByRole('navigation', { name: 'Threads and views' });
const needBlock = (page: Page) => page.getByRole('region', { name: 'Needs your OK' });
const offerBlock = (page: Page) => page.getByRole('region', { name: 'Offer to stop asking' });
const ATTRIBUTION = /Ran under a remembered approval — you, since \d{1,2} [A-Z][a-z]+ \d{4}\./;

async function enter(page: Page) {
  await page.goto(`${baseURL}/`);
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await rail(page)
    .getByRole('button', { name: /Talk it through/ })
    .click();
}

test('Go ahead and remember covers the next identical step, says so, and revoking asks again', async ({
  page,
}) => {
  const project = await newProject('Remember on approval');
  const first = await startRun(project);
  await enter(page);
  await expect(needBlock(page)).toBeVisible();
  await needBlock(page)
    .getByRole('button', { name: 'Go ahead and remember in this project' })
    .click();
  await expect(needBlock(page)).toHaveCount(0);
  await finished(project, first);
  const view = await api<RememberedApprovalsView>(`/projects/${project.id}/permissions/remembered`);
  expect(view.grants).toHaveLength(1);
  expect(view.grants[0].grant).toMatchObject({ route: 'approve-and-remember', acceptedBy: 'you' });

  // The next identical step is covered: nobody is asked, and the record says whose click it rests on.
  const covered = await startRun(project);
  expect(covered.authorization?.kind).toBe('remembered-approval');
  await finished(project, covered);
  await expect(page.getByLabel('Approval record').filter({ hasText: ATTRIBUTION })).toBeVisible();
  await expect(needBlock(page)).toHaveCount(0);

  // One place lists and revokes it: the permissions dialog.
  await page.getByRole('button', { name: 'Review changes' }).click();
  const list = page.getByRole('region', { name: 'Remembered approvals' });
  await expect(list).toBeVisible();
  await expect(list.getByText('Write Harness report.md (Format a fixture report)')).toBeVisible();
  await expect(list.getByText(/You chose Go ahead and remember on/)).toBeVisible();
  await list.getByRole('button', { name: 'Revoke' }).click();
  await expect(list.getByText('revoked', { exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Revocation stops coverage at once: the next step asks, and says why.
  await startRun(project);
  await expect(needBlock(page)).toBeVisible();
  await expect(
    needBlock(page).getByText(
      'Approval needed: You revoked the remembered approval for this, so it needs your OK.',
    ),
  ).toBeVisible();
  await needBlock(page).getByRole('button', { name: "Don't do this" }).click();
  await expect(needBlock(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the learned offer is asked once at the threshold, and Keep asking is remembered', async ({
  page,
}) => {
  const project = await newProject('Keep asking');
  await approveByApi(project);
  await approveByApi(project);
  const third = await startRun(project);
  await enter(page);
  await expect(offerBlock(page)).toHaveCount(0);
  await needBlock(page).getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect(offerBlock(page)).toBeVisible();
  await expect(
    offerBlock(page).getByText(
      "You've approved “Write Harness report.md (Format a fixture report)” 3 times in this project. Stop asking?",
    ),
  ).toBeVisible();
  await expect(offerBlock(page)).toHaveCount(1);
  await offerBlock(page).getByRole('button', { name: 'Keep asking' }).click();
  await expect(offerBlock(page)).toHaveCount(0);
  // The offer is made when the answer is recorded, before the approved run has finished:
  // the next Work start waits for that run's session to settle, or the project is still busy.
  await finished(project, third);
  // The answer is kept: more approvals do not bring the offer back.
  await approveByApi(project);
  await approveByApi(project);
  await page.reload();
  await expect(page.locator('.console')).toBeVisible();
  await expect(offerBlock(page)).toHaveCount(0);
  const view = await api<RememberedApprovalsView>(`/projects/${project.id}/permissions/remembered`);
  expect(view.grants).toHaveLength(0);
  expect(view.offers).toHaveLength(0);
});

test('Stop asking remembers the item, and the next step runs under it', async ({ page }) => {
  const project = await newProject('Stop asking');
  await approveByApi(project);
  await approveByApi(project);
  await approveByApi(project);
  await enter(page);
  await expect(offerBlock(page)).toBeVisible();
  await offerBlock(page).getByRole('button', { name: 'Stop asking' }).click();
  await expect(offerBlock(page)).toHaveCount(0);
  const view = await api<RememberedApprovalsView>(`/projects/${project.id}/permissions/remembered`);
  expect(view.grants).toHaveLength(1);
  expect(view.grants[0].grant.route).toBe('learned-offer');
  const covered = await startRun(project);
  expect(covered.authorization?.kind).toBe('remembered-approval');
  await finished(project, covered);
  await expect(page.getByLabel('Approval record').filter({ hasText: ATTRIBUTION })).toBeVisible();
  await expect(needBlock(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Remembered approvals' })
      .getByText(/You accepted the offer to stop asking on/),
  ).toBeVisible();
});

/** A project with one task, the Codex connection on and one shared document to revise. */
async function codexProject(name: string) {
  const project = await newProject(name);
  const task = await api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', {
    name: 'Revise the menu',
    description: 'Keep the menu current',
  });
  await fs.writeFile(path.join(project.folder, 'Menu.md'), '# Menu\n', 'utf8');
  await api('/settings', 'PUT', { services: { codex: true } });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['codex'],
    documents: ['Menu.md'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  return { project, taskId: task.id };
}
/** Ask Codex for a proposal and wait until it is waiting, or already decided and written. */
async function codexProposalRun(project: Project, taskId: string, changes: typeof codexProposal) {
  codexProposal = changes;
  const session = await api<{ id: string }>(`/projects/${project.id}/work/start`, 'POST', {
    taskId,
    route: 'codex',
    consent: true,
    sources: ['Menu.md'],
  });
  await expect
    .poll(
      async () => {
        const state = await api<ProjectState>(`/projects/${project.id}/state`);
        const need = state.needs.find((item) => item.sessionId === session.id);
        const settled = state.sessions.find((item) => item.id === session.id)?.state;
        // Waiting on the person, or decided and settled: never mid-write.
        return need && (need.state === 'open' || /done|stopped|failed/.test(settled ?? ''))
          ? need.state
          : null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  const state = await api<ProjectState>(`/projects/${project.id}/state`);
  return state.needs.find((need) => need.sessionId === session.id)!;
}

test('a Codex proposal: remember, run under it, ask for another file, revoke, ask again', async ({
  page,
}) => {
  const { project, taskId } = await codexProject('Remember a Codex proposal');
  const first = await codexProposalRun(project, taskId, [
    { path: 'Menu.md', text: '# Menu\n\nSoup.\n' },
  ]);
  expect(first.state).toBe('open');
  await enter(page);
  await expect(needBlock(page)).toBeVisible();
  await needBlock(page)
    .getByRole('button', { name: 'Go ahead and remember in this project' })
    .click();
  await expect(needBlock(page)).toHaveCount(0);
  await finished(project, first);
  const view = await api<RememberedApprovalsView>(`/projects/${project.id}/permissions/remembered`);
  expect(view.grants).toHaveLength(1);
  expect(view.grants[0].grant).toMatchObject({
    route: 'approve-and-remember',
    what: 'Write Menu.md (Codex text proposal)',
    pattern: {
      kind: 'codex-proposal',
      connection: { engine: 'codex', accountRoute: CODEX_ACCOUNT },
    },
  });

  // The next identical proposal runs under it, and its record says whose click it rests on.
  const covered = await codexProposalRun(project, taskId, [
    { path: 'Menu.md', text: '# Menu\n\nSoup and bread.\n' },
  ]);
  expect(covered.authorization?.kind).toBe('remembered-approval');
  await finished(project, covered);
  await expect(page.getByLabel('Approval record').filter({ hasText: ATTRIBUTION })).toBeVisible();
  await expect(needBlock(page)).toHaveCount(0);

  // A proposal that writes another file asks, and says why.
  const elsewhere = await codexProposalRun(project, taskId, [
    { path: 'Specials.md', text: 'Soup of the day.\n' },
  ]);
  expect(elsewhere.state).toBe('open');
  await expect(
    needBlock(page).getByText(
      'Approval needed: Your remembered approval covers “Write Menu.md (Codex text proposal)”, but this writes files it does not cover, so it needs your OK.',
    ),
  ).toBeVisible();
  await needBlock(page).getByRole('button', { name: "Don't do this" }).click();
  await expect(needBlock(page)).toHaveCount(0);
  await finished(project, elsewhere);

  // The one list revokes it.
  await page.getByRole('button', { name: 'Review changes' }).click();
  const list = page.getByRole('region', { name: 'Remembered approvals' });
  await expect(list.getByText('Write Menu.md (Codex text proposal)')).toBeVisible();
  await list.getByRole('button', { name: 'Revoke' }).click();
  await expect(list.getByText('revoked', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Revocation stops coverage at once: the next identical proposal asks again.
  const asked = await codexProposalRun(project, taskId, [
    { path: 'Menu.md', text: '# Menu\n\nBread.\n' },
  ]);
  expect(asked.state).toBe('open');
  await expect(
    needBlock(page).getByText(
      'Approval needed: You revoked the remembered approval for this, so it needs your OK.',
    ),
  ).toBeVisible();
  await needBlock(page).getByRole('button', { name: "Don't do this" }).click();
  await expect(needBlock(page)).toHaveCount(0);
  await finished(project, asked);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
