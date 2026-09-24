import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalCommand, Need, Project, ProjectState, Settings, Task } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';
import { AGENT_NAME } from '../shared/agent-name';

/**
 * H13 in the Console: a Diomedes work loop's run inspector shows the outcome
 * (H17's projection of the task's declared checks, never the model's own
 * claim), who supervised and which models ran, the bounded plan, each action
 * with what came back, the handoff to a delegate, and the finish claim. A loop
 * stopped at its turn limit says which limit. The loop runs on the scripted
 * fixture route, so no provider is involved and no model is named.
 */

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const VERIFIED_TASK = 'Check the linen delivery';
const LIMITED_TASK = 'Read the order only';
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

async function task(request: APIRequestContext, name: string) {
  const created = await request.post(`/api/projects/${projectId}/tasks`, { headers: HEADERS, data: { name } });
  expect(created.ok()).toBe(true);
  const value = (await created.json()) as Task;
  const thread = await request.post(`/api/projects/${projectId}/threads`, { headers: HEADERS, data: { taskId: value.id } });
  expect(thread.ok()).toBe(true);
  return value.id;
}
async function startLoop(request: APIRequestContext, taskId: string, extra: Record<string, unknown>) {
  const started = await request.post(`/api/projects/${projectId}/loop/start`, {
    headers: HEADERS,
    data: {
      protocolVersion: 1,
      commandId: `ui-${taskId}`,
      taskId,
      goal: 'Compare the order with the delivery and write the report.',
      route: 'native-fixture',
      sources: ['order.md', 'delivery.md'],
      ...extra,
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  return ((await started.json()) as { runId: string }).runId;
}
async function outcome(request: APIRequestContext, runId: string) {
  const read = await request.get(`/api/projects/${projectId}/loop/runs/${runId}`);
  return ((await read.json()) as { outcome: { state: string } }).outcome.state;
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
  const created = await request.post('/api/projects', { headers: HEADERS, data: { name: 'Loop inspector proof' } });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as Project;
  projectId = project.id;
  await fs.writeFile(path.join(project.folder, 'order.md'), 'Order 1182: 100 napkins, 40 tablecloths.\n');
  await fs.writeFile(path.join(project.folder, 'delivery.md'), 'Delivered 94 napkins. Six napkins short.\n');

  // A verified loop: the person declared the check; the loop's finish runs it.
  const verified = await task(request, VERIFIED_TASK);
  const declared = await request.put(`/api/projects/${projectId}/tasks/${verified}/acceptance`, {
    headers: HEADERS,
    data: { checks: [{ id: 'order', kind: 'text-contains', path: 'Harness report.md', text: 'Order 1182' }] },
  });
  expect(declared.ok()).toBe(true);
  const runId = await startLoop(request, verified, { delegate: { route: 'native-fixture' } });
  let need: Need | undefined;
  await expect
    .poll(
      async () => {
        const state = (await (await request.get(`/api/projects/${projectId}/state`)).json()) as ProjectState;
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
  const resolved = await request.post(`/api/projects/${projectId}/needs/${need!.id}/resolve`, { headers: HEADERS, data: decision });
  expect(resolved.ok(), await resolved.text()).toBe(true);
  await expect.poll(() => outcome(request, runId), { timeout: 30_000 }).toBe('verified');

  // A loop allowed one turn stops at its limit.
  const limited = await task(request, LIMITED_TASK);
  const stopped = await startLoop(request, limited, { maxTurns: 1 });
  await expect.poll(() => outcome(request, stopped), { timeout: 30_000 }).toBe('stopped-limit');
});

test.afterAll(async ({ request }) => {
  expect(originalSettings).toBeTruthy();
  const restore = await request.put('/api/settings', { headers: HEADERS, data: JSON.parse(JSON.stringify(originalSettings)) });
  expect(restore.ok()).toBe(true);
});

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
  const loop = page.getByRole('region', { name: 'Diomedes loop' });
  await expect(loop).toBeVisible();
  return loop;
}

test('H13-UI-01: the inspector shows the plan, actions, observations, delegation and a Verified finish', async ({ page }) => {
  const loop = await openLoop(page, VERIFIED_TASK);
  // The outcome is the projection of the person's check, shown once with its sentence.
  await expect(loop.locator('[data-loop-outcome]')).toHaveText('Verified');
  await expect(loop.locator('.loop-sentence')).toHaveText('1 declared check passed against 1 exact file version.');
  // Attribution: Diomedes supervised; a fixed local script is no model.
  await expect(loop.locator('.loop-supervisor')).toHaveText(AGENT_NAME);
  await expect(loop.locator('.loop-models')).toHaveText('None: a fixed local script');
  await expect(loop.locator('.loop-plan li')).toHaveCount(4);
  await expect(loop.locator('.loop-plan li').first()).toHaveText('Read order.md.');

  const turns = loop.locator('.loop-turn');
  await expect(turns).toHaveCount(4);
  await expect(turns.nth(0)).toHaveAttribute('data-decision', 'tool');
  await expect(turns.nth(0).locator('.loop-turn-tool')).toHaveText('read_project_file');
  await expect(turns.nth(0).locator('.loop-obs-excerpt')).toContainText('Order 1182');
  await expect(turns.nth(0).locator('.loop-obs-meta')).toContainText(/\d+ B · [a-f0-9]{12}/);
  await expect(turns.nth(1)).toHaveAttribute('data-decision', 'delegate');
  await expect(turns.nth(2).locator('.loop-turn-tool')).toHaveText('propose_write');
  await expect(turns.nth(2).locator('.loop-turn-state')).toHaveText('approved, done');
  await expect(turns.nth(3)).toHaveAttribute('data-decision', 'finish');

  // The handoff: its envelope, the child run, its own small budget and the answer it brought back.
  const delegation = loop.locator('.loop-delegation');
  await expect(delegation).toHaveCount(1);
  await expect(delegation.locator('.loop-turn-state')).toHaveText('completed');
  await expect(delegation.locator('.loop-obs-excerpt')).toContainText('delivery.md: Delivered 94 napkins');
  await expect(delegation.locator('.loop-obs-meta')).toContainText(/handoff R[a-f0-9]{12}-h1/);
  await expect(delegation.locator('.loop-obs-meta')).toContainText('budget 4 model calls, 4 tool calls');

  // The finish is the model's claim; the outcome above is what decided it.
  await expect(loop.locator('.loop-claim')).toContainText('Proposed Harness report.md');

  // Nothing in the loop pushes the page sideways at a narrow window.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(loop).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('H13-UI-02: a loop stopped at its turn limit says which limit and is never called finished', async ({ page }) => {
  const loop = await openLoop(page, LIMITED_TASK);
  await expect(loop.locator('[data-loop-outcome]')).toHaveText('Stopped: turn limit reached');
  await expect(loop.locator('.loop-sentence')).toHaveText(
    'Stopped: turn limit reached (1 of 1 turns). The goal was not finished, so nothing was checked.',
  );
  await expect(loop.locator('.loop-turn')).toHaveCount(1);
  await expect(loop.locator('.loop-claim')).toHaveCount(0);
  await expect(loop.getByText('1 of 1 · model calls 2 of 2 · tool calls 1 of 1')).toBeVisible();
});
