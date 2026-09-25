import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalCommand, Need, Project, ProjectState, Settings, Task } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

/**
 * H14 in the Console: the Team view shows a lead loop, its workers and its
 * advice. On the scripted fixture route a worker whose file is missing fails,
 * its lead stops, and the person retries the lead with the ordinary H08 Retry
 * after adding the file: the worker that already answered is not run again,
 * the one that failed runs as attempt 2, and every worker reads Verified
 * through the lead's declared check. No provider is involved and no model is
 * named.
 */

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const TASK = 'Reconcile the linen order';
let originalSettings: Settings | null = null;
let projectId = '';
let folder = '';
let taskId = '';
let firstRun = '';
let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

interface LeadRead {
  runId: string;
  sessionId: string | null;
  outcome: { state: string };
}
async function leads(request: APIRequestContext) {
  const read = await request.get(`/api/projects/${projectId}/loop/team`);
  expect(read.ok()).toBe(true);
  return ((await read.json()) as { leads: LeadRead[] }).leads;
}

test.beforeAll(async ({ request }) => {
  const current = await request.get('/api/settings');
  expect(current.ok()).toBe(true);
  originalSettings = (await current.json()) as Settings;
  const setup = await request.put('/api/settings', {
    headers: HEADERS,
    data: {
      onboarding: { resumeAt: 'done', work: 'business', detail: 'guided', familiarity: 'comfortable' },
      detail: 'guided',
    },
  });
  expect(setup.ok()).toBe(true);
  const created = await request.post('/api/projects', { headers: HEADERS, data: { name: 'Lead and workers proof' } });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as Project;
  projectId = project.id;
  folder = project.folder;
  await fs.writeFile(path.join(folder, 'order.md'), 'Order 1182: 100 napkins, 40 tablecloths.\n');
  await fs.writeFile(path.join(folder, 'delivery.md'), 'Delivered 94 napkins. Six napkins short.\n');
  // invoice.md is missing on purpose: its worker cannot answer until the person adds it.
  const task = await request.post(`/api/projects/${projectId}/tasks`, { headers: HEADERS, data: { name: TASK } });
  expect(task.ok()).toBe(true);
  taskId = ((await task.json()) as Task).id;
  const thread = await request.post(`/api/projects/${projectId}/threads`, { headers: HEADERS, data: { taskId } });
  expect(thread.ok()).toBe(true);
  const declared = await request.put(`/api/projects/${projectId}/tasks/${taskId}/acceptance`, {
    headers: HEADERS,
    data: { checks: [{ id: 'invoice', kind: 'text-contains', path: 'Harness report.md', text: 'Invoice 77' }] },
  });
  expect(declared.ok()).toBe(true);
  const started = await request.post(`/api/projects/${projectId}/loop/start`, {
    headers: HEADERS,
    data: {
      protocolVersion: 1,
      commandId: 'h14-ui-lead',
      taskId,
      goal: 'Compare the order with the delivery and the invoice, and write the report.',
      route: 'native-fixture',
      sources: ['order.md', 'delivery.md', 'invoice.md'],
      team: { worker: {}, advisor: {} },
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  firstRun = ((await started.json()) as { runId: string }).runId;
  await expect.poll(async () => (await leads(request))[0]?.outcome.state, { timeout: 30_000 }).toBe('stopped-limit');
});

test.afterAll(async ({ request }) => {
  expect(originalSettings).toBeTruthy();
  const restore = await request.put('/api/settings', { headers: HEADERS, data: JSON.parse(JSON.stringify(originalSettings)) });
  expect(restore.ok()).toBe(true);
});

async function openTeam(page: Page) {
  const opened = await page.request.put('/api/settings', { headers: HEADERS, data: { openProjects: [projectId] } });
  expect(opened.ok()).toBe(true);
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await page.getByRole('navigation', { name: 'Threads and views', exact: true }).getByRole('button', { name: /^Team\b/ }).click();
  await expect(page.locator('.team[aria-label="Team"]')).toBeVisible();
  const region = page.getByRole('region', { name: 'Lead and workers' });
  await expect(region).toBeVisible();
  return region;
}

test('H14-UI-01: a worker that failed stops its lead, and the Team view says which and offers Retry', async ({ page }) => {
  const region = await openTeam(page);
  const lead = region.locator(`[data-lead="${firstRun}"]`);
  await expect(lead.locator('[data-lead-outcome]')).toHaveText('Stopped: a worker did not answer');
  await expect(lead.locator('.lw-lead-task')).toHaveText(TASK);
  await expect(lead.locator('.lw-facts')).toContainText('General Assistant · a fixed local script');
  await expect(lead.locator('.lw-facts')).toContainText('at most 3 at once, 4 per run, one level');
  await expect(lead.locator('.lw-facts')).toContainText('Solution Architect');

  const workers = lead.locator('.lw-workers .lw-handoff');
  await expect(workers).toHaveCount(2);
  await expect(workers.nth(0)).toHaveAttribute('data-outcome', 'completed');
  await expect(workers.nth(0).locator('.lw-files')).toHaveText('delivery.md');
  await expect(workers.nth(0).locator('.lw-answer')).toHaveText('delivery.md: Delivered 94 napkins. Six napkins short.');
  await expect(workers.nth(0).locator('.lw-budget')).toContainText('turns 2 of 4');
  await expect(workers.nth(0).locator('.lw-meta')).toContainText('None: a fixed local script');
  // The lead did not finish, so an answer is still only a claim.
  await expect(workers.nth(0).locator('[data-verification]')).toHaveText('Not verified');
  await expect(workers.nth(0).locator('[data-verification]')).toHaveAttribute('title', /A worker’s answer is a claim/);
  await expect(workers.nth(1)).toHaveAttribute('data-outcome', 'failed');
  await expect(workers.nth(1).locator('.lw-state')).toHaveText('failed');
  await expect(workers.nth(1).locator('.lw-sentence')).toHaveText(
    'Failed before it answered. Its lead stopped; retry the lead to run it again.',
  );
  await expect(lead.getByRole('button', { name: 'Retry' })).toBeVisible();

  // Nothing in the team pushes the page sideways at a narrow window.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(region).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('H14-UI-02: Retry reruns only the worker that failed; every worker then reads Verified through the lead', async ({ page }) => {
  await fs.writeFile(path.join(folder, 'invoice.md'), 'Invoice 77: 100 napkins billed.\n');
  const region = await openTeam(page);
  const first = region.locator(`[data-lead="${firstRun}"]`);
  await first.getByRole('button', { name: 'Retry' }).click();
  await expect(first.locator('.lw-receipt')).toContainText('Workers that already answered are not run again.');

  // The retried lead proposes its report; the person says go ahead.
  let need: Need | undefined;
  await expect
    .poll(
      async () => {
        const state = (await (await page.request.get(`/api/projects/${projectId}/state`)).json()) as ProjectState;
        need = state.needs.find((item) => item.state === 'open');
        return Boolean(need);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const decision: ApprovalCommand = {
    protocolVersion: 1,
    commandId: `decision-${need!.id}`,
    resolution: 'go-ahead',
    proposalDigest: need!.approval!.proposalDigest,
    actionDigest: need!.approval!.actionDigest,
    baseDigest: need!.approval!.baseDigest,
  };
  const resolved = await page.request.post(`/api/projects/${projectId}/needs/${need!.id}/resolve`, { headers: HEADERS, data: decision });
  expect(resolved.ok(), await resolved.text()).toBe(true);
  await expect.poll(async () => (await leads(page.request))[0]?.outcome.state, { timeout: 30_000 }).toBe('verified');
  const second = (await leads(page.request))[0].runId;

  const again = await openTeam(page);
  await expect(again.locator('.lw-lead')).toHaveCount(2);
  const lead = again.locator(`[data-lead="${second}"]`);
  await expect(lead.locator('[data-lead-outcome]')).toHaveText('Verified');
  await expect(lead.locator('.lw-facts')).toContainText('attempt 2');
  const workers = lead.locator('.lw-workers .lw-handoff');
  await expect(workers.nth(0)).toHaveAttribute('data-outcome', 'reused');
  await expect(workers.nth(0).locator('.lw-state')).toHaveText('answered earlier');
  await expect(workers.nth(0).locator('.lw-meta')).toContainText(`from ${firstRun}-t1-0`);
  await expect(workers.nth(1)).toHaveAttribute('data-outcome', 'completed');
  await expect(workers.nth(1).locator('.lw-attempt')).toHaveText('attempt 2');
  await expect(workers.nth(1).locator('.lw-answer')).toHaveText('invoice.md: Invoice 77: 100 napkins billed.');
  await expect(workers.nth(1).locator('.lw-meta')).toContainText(`retries ${firstRun}-t1-1`);
  for (const index of [0, 1]) await expect(workers.nth(index).locator('[data-verification]')).toHaveText('Verified');

  // Advice is evidence under its own attribution, never verified as work.
  const advice = lead.locator('.lw-advice .lw-handoff');
  await expect(advice).toHaveCount(1);
  await expect(advice.locator('.lw-answer')).toContainText('Check every figure in the report against order.md');
  await expect(advice.locator('[data-verification]')).toHaveCount(0);
  // Neither lead offers Retry now: one is verified, the other already has its retry.
  await expect(again.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});
