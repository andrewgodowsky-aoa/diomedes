import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalCommand, Need, Project, ProjectState, Settings, Task } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';
import { AGENT_NAME } from '../shared/agent-name';

/**
 * H13 slice 2 in the Console: a delegate works in its own sandbox and hands
 * back a change set, shown once inside its row of the loop inspector. A change
 * the delegate proposed waits for the person: its readable diff opens in place,
 * and Keep writes it to the project, which held nothing of it before. A second
 * run's waiting change is discarded, and the project stays as it was. The loop
 * and its helper run on the scripted fixture route; no provider is involved.
 */

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const TASK = 'Check the delivery with a helper';
let originalSettings: Settings | null = null;
let projectId = '';
let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

let project: Project;
let runId = '';
let discardRunId = '';

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
  const created = await request.post('/api/projects', { headers: HEADERS, data: { name: 'Sandbox change sets' } });
  expect(created.ok()).toBe(true);
  project = (await created.json()) as Project;
  projectId = project.id;
  await fs.writeFile(path.join(project.folder, 'order.md'), 'Order 1182: 100 napkins, 40 tablecloths.\n');
  await fs.writeFile(path.join(project.folder, 'delivery.md'), 'Delivered 94 napkins. Six napkins short.\n');
  runId = await finishedLoop(request, TASK, 'Notes/delivery-check.md');
  discardRunId = await finishedLoop(request, 'Check the order with a helper', 'Notes/order-check.md');
});

test.afterAll(async ({ request }) => {
  expect(originalSettings).toBeTruthy();
  const restore = await request.put('/api/settings', { headers: HEADERS, data: JSON.parse(JSON.stringify(originalSettings)) });
  expect(restore.ok()).toBe(true);
});

async function task(request: APIRequestContext, name: string) {
  const created = await request.post(`/api/projects/${projectId}/tasks`, { headers: HEADERS, data: { name } });
  expect(created.ok()).toBe(true);
  const value = (await created.json()) as Task;
  const thread = await request.post(`/api/projects/${projectId}/threads`, { headers: HEADERS, data: { taskId: value.id } });
  expect(thread.ok()).toBe(true);
  return value.id;
}
/** A loop whose helper proposes a note in its sandbox; the loop's own report is approved so it finishes. */
async function finishedLoop(request: APIRequestContext, name: string, note: string) {
  const taskId = await task(request, name);
  const started = await request.post(`/api/projects/${projectId}/loop/start`, {
    headers: HEADERS,
    data: {
      protocolVersion: 1,
      commandId: `ui-sandbox-${taskId}`,
      taskId,
      goal: `Compare the order with the delivery, have a helper propose ${note}, and write the report.`,
      route: 'native-fixture',
      sources: ['order.md', 'delivery.md'],
      delegate: { route: 'native-fixture' },
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const { runId: id, session } = (await started.json()) as { runId: string; session: { id: string } };
  let need: Need | undefined;
  await expect
    .poll(
      async () => {
        const state = (await (await request.get(`/api/projects/${projectId}/state`)).json()) as ProjectState;
        need = state.needs.find((item) => item.state === 'open' && item.harness && item.sessionId === session.id);
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
  const resolved = await request.post(`/api/projects/${projectId}/needs/${need!.id}/resolve`, { headers: HEADERS, data: decision });
  expect(resolved.ok(), await resolved.text()).toBe(true);
  await expect
    .poll(async () => ((await (await request.get(`/api/projects/${projectId}/loop/runs/${id}`)).json()) as { view: { state: string } }).view.state, {
      timeout: 30_000,
    })
    .toBe('completed');
  return id;
}

async function openLoop(page: Page, name: string) {
  const opened = await page.request.put('/api/settings', { headers: HEADERS, data: { openProjects: [projectId] } });
  expect(opened.ok()).toBe(true);
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Threads and views', exact: true })
    .getByRole('button', { name: new RegExp(name) })
    .click();
  const inspector = page.locator('details.run-inspector');
  await inspector.locator('summary').click();
  const loop = page.getByRole('region', { name: `${AGENT_NAME} work loop` });
  await expect(loop).toBeVisible();
  return loop;
}


test('SANDBOX-UI-01: a delegate’s proposed change is reviewed with its diff and kept into the project', async ({ page }) => {
  const note = path.join(project.folder, 'Notes', 'delivery-check.md');
  // The helper wrote only its own copy: the project holds nothing of it yet.
  await expect(fs.access(note)).rejects.toThrow();
  const loop = await openLoop(page, TASK);
  const delegation = loop.locator('.loop-delegation');
  await expect(delegation).toHaveCount(1);
  const review = delegation.getByRole('region', { name: 'Changes it returned' });
  await expect(review).toBeVisible();
  const entry = review.locator('.cs-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry.locator('.cs-path')).toHaveText('Notes/delivery-check.md');
  await expect(entry.locator('.cs-op')).toHaveText('new');
  await expect(entry.locator('.cs-state')).toHaveText('waits for you');
  await expect(entry.locator('.cs-reason')).toHaveText('the sub-task asked for a person to decide it');

  // P06's readable diff, in place.
  await entry.getByRole('button', { name: 'Show changes' }).click();
  await expect(entry.locator('.dv-head')).toContainText('Notes/delivery-check.md');
  await expect(entry).toContainText('Notes/delivery-check.md');
  await expect(entry).toContainText('Delivered 94 napkins');

  await entry.getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(entry.locator('.cs-state')).toHaveText('kept by you');
  await expect(entry.getByRole('button', { name: 'Keep', exact: true })).toHaveCount(0);
  expect(await fs.readFile(note, 'utf8')).toContain('Delivered 94 napkins');

  // Nothing here pushes the page sideways at a narrow window.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(loop).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('SANDBOX-UI-02: a discarded change leaves the project as it was', async ({ page }) => {
  expect(discardRunId).toBeTruthy();
  const loop = await openLoop(page, 'Check the order with a helper');
  const entry = loop.locator('.loop-delegation .cs-entry');
  await expect(entry.locator('.cs-state')).toHaveText('waits for you');
  await entry.getByRole('button', { name: 'Discard' }).click();
  await expect(entry.locator('.cs-state')).toHaveText('discarded');
  await expect(fs.access(path.join(project.folder, 'Notes', 'order-check.md'))).rejects.toThrow();
  expect(runId).toBeTruthy();
});
