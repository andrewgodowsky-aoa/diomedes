import { test, expect, type Locator, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Need, Project, ProjectState, Task } from '../shared/types';
import type { HarnessRun } from '../shared/harness';
import { TEAM_WORKER_CAPABILITY } from '../shared/team-delegation';
import { AGENT_NAME } from '../shared/agent-name';
import { LOOP_START_CHANGED_CHOICES } from '../client/console/loop-start-model';
import { AWS_KIMI_K3_REFUSAL } from '../shared/model-api';
import { EVALUATION_PERMISSION } from '../server/harness/evaluation';
import { harnessWrites } from '../server/harness/approval';
import { reopenLastProject } from './fixtures/landing';
import {
  collaborationModelRoutes, scriptedCollaborationHost, seedCollaboration,
  SCRIPTED_LEAD, SCRIPTED_MEMBER, SCRIPTED_REVIEW, UNQUALIFIED_K3,
  SCRIPTED_ACCOUNT_ROUTE, SCRIPTED_REPORT, SCRIPTED_MEMBER_ANSWER, SCRIPTED_HELPER_ANSWER, LONG_SOURCE,
  type CollaborationFixtureLog,
} from './fixtures/agent-collaboration-stub';

/** Built Console + real owned host. Every answer is scripted; this is no live provider proof. */
test.describe.configure({ mode: 'serial' });
const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let project: Project;
let helperProfileId = '';
let fixtureRoot = '';
let hostBootId = '';
let hostPort = 0;
const log: CollaborationFixtureLog = { calls: [], hangMember: false };

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${route} refused: ${JSON.stringify(payload)}`);
  return payload as T;
}
const state = () => api<ProjectState>(`/projects/${project.id}/state`);
const memberReplies = (snapshot: ProjectState) => snapshot.team!.messages.filter(item =>
  item.from === SCRIPTED_MEMBER && item.to === SCRIPTED_LEAD && item.content === SCRIPTED_MEMBER_ANSWER,
);
function expectScriptedModelSteps(run: HarnessRun) {
  const models = run.steps.filter(step => step.intent.kind === 'model' && step.state === 'succeeded');
  expect(models.length).toBeGreaterThan(0);
  for (const step of models) expect(step.origin).toMatchObject({
    mode: 'application', engine: null, model: { requested: null, reported: null, source: 'not-recorded' },
  });
}

async function openHost() {
  server = createServer();
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(hostPort, '127.0.0.1', resolve); });
  const port = (server.address() as AddressInfo).port;
  hostPort = port;
  hostBootId = randomUUID();
  baseURL = `http://127.0.0.1:${port}`;
  const options = {
    port, clientPort: port, dataDir: path.join(fixtureRoot, 'data'), projectRoot: path.join(fixtureRoot, 'projects'),
    reviewerAdapter: null, verificationReviewer: null, automationTickMs: null,
    loopModelRoutes: collaborationModelRoutes(log),
    agentCollaboration: (context: Parameters<typeof scriptedCollaborationHost>[0]) => scriptedCollaborationHost(context, log),
  };
  application = await createApp(options);
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  const source = Math.max(...await Promise.all(['client/console/LoopStart.tsx', 'client/console/loop-start-model.ts'].map(async file => (await fs.stat(file)).mtimeMs)));
  expect(built, 'Build the production client for this exact candidate before its scripted UI test.').toBeGreaterThan(source);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', application);
}
async function closeHost() {
  const closingApplication = application, closingServer = server;
  application = undefined;
  server = undefined;
  try { await closingApplication?.locals.close(); }
  finally {
    if (closingServer) {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => closingServer.close(error => error ? reject(error) : resolve()));
    }
  }
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'agent-collaboration-scripted-ui-'));
  await openHost();
  await api('/settings', 'PUT', {
    detail: 'technical',
    services: { 'google-vertex': true, 'google-vertexModel': 'scripted-inventory-lead', 'google-vertexAccountRoute': SCRIPTED_ACCOUNT_ROUTE },
    onboarding: { work: 'business', detail: 'technical', familiarity: 'comfortable', resumeAt: 'done', completedAt: new Date().toISOString() },
  });
  project = await api<Project>('/projects', 'POST', { name: 'Inventory collaboration (scripted fixture)' });
  await seedCollaboration(application!.locals.store, project.id);
  for (const [slotId, name, model] of [
    [SCRIPTED_LEAD, 'Inventory lead (scripted)', 'scripted-inventory-lead'],
    [SCRIPTED_MEMBER, 'Inventory member (scripted)', 'scripted-inventory-member'],
  ]) {
    const selected = await api<{ profileId: string }>('/agent-profiles', 'POST', {
      name, engine: 'google-vertex', model, effort: 'medium', agentId: 'diomedes.general', rules: [],
    });
    await api(`/projects/${project.id}/threads/${slotId}-thread`, 'PUT', {
      engine: 'google-vertex', requested: { profile: selected.profileId },
    });
    const current = (await state()).conversations.find(thread => thread.id === `${slotId}-thread`);
    expect(current?.requested).toEqual({ model: null, effort: null, profile: selected.profileId });
  }
  const helper = await api<{ profileId: string }>('/agent-profiles', 'POST', {
    // The real H14 path selects its built-in worker; the saved profile pins intelligence only.
    name: 'Inventory helper (scripted)', engine: 'google-vertex', model: 'scripted-inventory-helper', effort: 'medium', agentId: 'auto', rules: [],
  });
  helperProfileId = helper.profileId;
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0, routes: ['google-vertex', 'openrouter'], documents: ['inventory.txt'], shareConversationHistory: false, shareReviewPackets: true,
  });
  await api('/settings', 'PUT', { openProjects: [project.id] });
});

test.afterAll(closeHost);

async function task(name: string) {
  const created = await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name, description: 'Reconcile inventory.txt and propose Harness report.md. No inventory system may be updated.',
  });
  await api(`/projects/${project.id}/threads`, 'POST', { attachedTo: { kind: 'task', ref: created.id } });
  return created;
}
async function openThread(page: Page, value: Task) {
  await page.goto(baseURL);
  await reopenLastProject(page);
  const name = value.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('navigation', { name: 'Threads and views', exact: true }).getByRole('button', { name: new RegExp(name) }).first().click();
  await expect(page.locator('#scrThread')).toBeVisible();
}
async function openStart(page: Page, value: Task) {
  await openThread(page, value);
  await page.getByRole('complementary', { name: 'This project' }).getByRole('button', { name: 'Loop run' }).click();
  const form = page.getByRole('form', { name: `Start a ${AGENT_NAME} work loop` });
  await expect(form).toBeVisible();
  for (const label of ['Route', 'Team lead', 'Team member', 'Helper profile', 'Jev review', 'Goal'])
    await expect(form.getByLabel(label, { exact: true })).toHaveAccessibleName(label);
  await form.getByLabel('Route', { exact: true }).selectOption('google-vertex');
  return form;
}
async function keepReport(page: Page, value: Task) {
  await openThread(page, value);
  const card = page.getByRole('region', { name: 'Review changes' }).locator('.cdiff-card')
    .filter({ has: page.getByRole('button', { name: 'Harness report.md', exact: true }) });
  const disclosure = card.getByRole('button', { name: 'Harness report.md', exact: true });
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
  const reviewed = page.waitForResponse(response => /\/review\/[^/]+$/.test(response.url()) && response.request().method() === 'POST');
  await card.getByRole('button', { name: 'Keep', exact: true }).click();
  const response = await reviewed;
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json()).change.state).toBe('kept');
}
async function choose(form: Locator) {
  await form.getByLabel('Team lead', { exact: true }).selectOption(SCRIPTED_LEAD);
  await form.getByLabel('Team member', { exact: true }).selectOption(SCRIPTED_MEMBER);
  await form.getByLabel('Helper profile', { exact: true }).selectOption(helperProfileId);
  await form.getByLabel('Jev review', { exact: true }).selectOption(SCRIPTED_REVIEW);
  await form.getByLabel(/^Turns/).fill('12');
  await form.getByRole('checkbox', { name: /^Send the goal and the files it reads/ }).check();
  await expect(form.getByRole('checkbox', { name: 'inventory.txt', exact: true })).toBeChecked();
  await expect(form.getByRole('checkbox', { name: LONG_SOURCE, exact: true })).not.toBeChecked();
}
const startPattern = /\/api\/projects\/[^/]+\/loop\/start$/;

test('client-command preservation: separate Team slots, helper and Jev survive duplicate submit and an intercepted 409 retry', async ({ page }) => {
  const value = await task('Select inventory collaborators (scripted)');
  const form = await openStart(page, value);
  await choose(form);
  const requests: Record<string, any>[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(startPattern, async route => {
    requests.push(route.request().postDataJSON());
    await pending;
    await route.fulfill({ status: 409, json: { error: 'Scripted start refusal; retrying preserves the client command.' } });
  });
  // Two submit events in one turn exercise the lock before React disables the button.
  await form.evaluate((element: HTMLFormElement) => { element.requestSubmit(); element.requestSubmit(); });
  try {
    await expect.poll(() => requests.length).toBe(1);
    await expect(form.getByRole('button', { name: 'Starting…' })).toBeDisabled();
  } finally { release(); }
  await expect(form.getByRole('alert')).toHaveText('Scripted start refusal; retrying preserves the client command.');
  await form.getByRole('button', { name: 'Start loop run' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({ taskId: value.id, route: 'google-vertex', maxTurns: 12, sources: ['inventory.txt'], consent: true, composition: true,
    persistentTeam: { leadSlotId: SCRIPTED_LEAD, memberSlotId: SCRIPTED_MEMBER },
    team: { scope: ['inventory.txt'], worker: { profileId: helperProfileId }, advisor: null },
    review: { profileId: 'agent.inventory-reconciliation', connectionId: SCRIPTED_REVIEW } });
  expect(Object.keys(requests[0]).sort()).toEqual(['commandId', 'composition', 'consent', 'goal', 'maxTurns', 'persistentTeam', 'protocolVersion', 'review', 'route', 'sources', 'taskId', 'team']);
  expect((await state()).sessions.filter(item => item.taskId === value.id)).toHaveLength(0);
});

test('client retry: a failed transport retains exact choices and refuses changed goal or file scope', async ({ page }) => {
  const value = await task('Retain a start after transport failure (scripted)');
  const form = await openStart(page, value);
  await choose(form);
  const originalGoal = await form.getByLabel('Goal', { exact: true }).inputValue();
  const requests: Record<string, any>[] = [];
  await page.route(startPattern, async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await route.abort('failed');
    else await route.fulfill({ status: 409, json: { error: 'Scripted retry received the retained command.' } });
  });
  await form.getByRole('button', { name: 'Start loop run' }).click();
  await expect(form.getByRole('alert')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Start loop run' })).toBeEnabled();

  await form.getByLabel('Goal', { exact: true }).fill('A different reconciliation outcome.');
  await form.getByRole('button', { name: 'Start loop run' }).click();
  await expect(form.getByRole('alert')).toHaveText(LOOP_START_CHANGED_CHOICES);
  expect(requests).toHaveLength(1);
  await form.getByLabel('Goal', { exact: true }).fill(originalGoal);
  await form.getByRole('checkbox', { name: LONG_SOURCE, exact: true }).check();
  await form.getByRole('button', { name: 'Start loop run' }).click();
  await expect(form.getByRole('alert')).toHaveText(LOOP_START_CHANGED_CHOICES);
  expect(requests).toHaveLength(1);

  await form.getByRole('checkbox', { name: LONG_SOURCE, exact: true }).uncheck();
  await form.getByRole('button', { name: 'Start loop run' }).click();
  await expect(form.getByRole('alert')).toHaveText('Scripted retry received the retained command.');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  // An intercepted transport tests client bytes only; host replay has its own acceptance.
  expect((await state()).sessions.filter(item => item.taskId === value.id)).toHaveLength(0);
});

test('selection: only the fixed inventory review is offered and clearing choices sends an ordinary command', async ({ page }) => {
  const value = await task('Use the fixed review profile (scripted)');
  await page.route(/\/loop\/collaboration-options(?:\?|$)/, route => route.fulfill({ status: 200, json: {
    leads: [{ slotId: SCRIPTED_LEAD, name: 'Inventory lead (scripted)', route: 'google-vertex', model: null, admitted: true, reason: null }],
    members: [{ slotId: SCRIPTED_MEMBER, name: 'Inventory member (scripted)', route: 'google-vertex', model: null, admitted: true, reason: null }],
    helpers: [{ profileId: helperProfileId, name: 'Inventory helper (scripted)', route: 'google-vertex', model: null, admitted: true, reason: null }],
    reviews: [
      { profileId: 'agent.inventory-reconciliation', connectionId: SCRIPTED_REVIEW, name: 'Inventory Jev review (scripted)', model: 'typesafe/jev-1.13', admitted: true, reason: null },
      { profileId: 'forged-review-profile', connectionId: 'forged-review-connection', name: 'Arbitrary review', model: 'typesafe/jev-1.13', admitted: true, reason: null },
    ],
  } }));
  const form = await openStart(page, value);
  await expect(form.getByLabel('Jev review', { exact: true }).locator('option[value="forged-review-connection"]')).toHaveCount(0);
  await choose(form);
  for (const label of ['Team lead', 'Team member', 'Helper profile', 'Jev review'])
    await form.getByLabel(label, { exact: true }).selectOption('');
  const requests: Record<string, any>[] = [];
  await page.route(startPattern, route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: 'Scripted ordinary command received.' } });
  });
  await form.getByRole('button', { name: 'Start loop run' }).click();
  await expect(form.getByRole('alert')).toHaveText('Scripted ordinary command received.');
  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0]).sort()).toEqual(['commandId', 'consent', 'goal', 'maxTurns', 'protocolVersion', 'route', 'sources', 'taskId']);
});

test('selection: a Team lead chooses its current route and clears consent for that destination', async ({ page }) => {
  const value = await task('Choose the selected lead route (scripted)');
  await page.route(/\/loop\/routes$/, route => route.fulfill({ status: 200, json: { routes: [
    { route: 'google-vertex', label: 'Google Vertex AI', model: 'settings-default', sends: true, admitted: true, reason: null },
    { route: 'azure-openai', label: 'Azure OpenAI', model: 'another-settings-default', sends: true, admitted: false, reason: 'The scripted Settings default is unavailable.' },
  ] } }));
  await page.route(/\/loop\/collaboration-options(?:\?|$)/, route => route.fulfill({ status: 200, json: {
    leads: [{ slotId: SCRIPTED_LEAD, name: 'Inventory lead (scripted)', route: 'azure-openai', model: 'saved-lead-model', admitted: true, reason: null }],
    members: [{ slotId: SCRIPTED_MEMBER, name: 'Inventory member (scripted)', route: 'google-vertex', model: null, admitted: true, reason: null }],
    helpers: [], reviews: [],
  } }));
  const form = await openStart(page, value);
  const consent = form.getByRole('checkbox', { name: /^Send the goal and the files it reads/ });
  await consent.check();
  await form.getByLabel('Team lead', { exact: true }).selectOption(SCRIPTED_LEAD);
  const rootRoute = form.getByLabel('Route', { exact: true });
  await expect(rootRoute).toHaveValue('azure-openai');
  await expect(rootRoute).toBeDisabled();
  await expect(rootRoute.locator('option:checked')).toHaveText('Azure OpenAI · saved-lead-model');
  await expect(consent).not.toBeChecked();
  await form.getByLabel('Team member', { exact: true }).selectOption(SCRIPTED_MEMBER);
  await consent.check();
  const requests: Record<string, any>[] = [];
  await page.route(startPattern, route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: 'Scripted selected lead command received.' } });
  });
  await form.getByRole('button', { name: 'Start loop run' }).click();
  await expect(form.getByRole('alert')).toHaveText('Scripted selected lead command received.');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ route: 'azure-openai', composition: true,
    persistentTeam: { leadSlotId: SCRIPTED_LEAD, memberSlotId: SCRIPTED_MEMBER } });
  for (const key of ['model', 'accountRoute', 'effort', 'grant', 'rootJobId']) expect(requests[0]).not.toHaveProperty(key);
});

test('selection: K3 stays disabled with the exact host reason and partial Team choices cannot start', async ({ page }) => {
  const value = await task('Inspect refused collaborators (scripted)');
  const form = await openStart(page, value);
  const lead = form.getByLabel('Team lead', { exact: true });
  // Read the option's native state; generic enabled matchers can retarget its enclosing select.
  await expect(lead.locator(`option[value="${UNQUALIFIED_K3}"]`)).toHaveJSProperty('disabled', true);
  const refused = form.getByText(AWS_KIMI_K3_REFUSAL, { exact: true });
  await expect(refused).toBeVisible();
  await lead.selectOption(SCRIPTED_LEAD);
  await expect(form.getByRole('button', { name: 'Start loop run' })).toBeDisabled();
  await form.getByLabel('Team member', { exact: true }).selectOption(SCRIPTED_MEMBER);
  await expect(form.getByRole('button', { name: 'Start loop run' })).toBeEnabled();
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(refused).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('selection: cancelling before or after choosing collaborators sends no work', async ({ page }) => {
  const value = await task('Cancel collaborator selection (scripted)');
  const starts: unknown[] = [];
  page.on('request', request => { if (startPattern.test(request.url())) starts.push(request.postDataJSON()); });
  let form = await openStart(page, value);
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toHaveCount(0);
  form = await openStart(page, value);
  await choose(form);
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(starts).toEqual([]);
  expect((await state()).sessions.filter(item => item.taskId === value.id)).toHaveLength(0);
});

test('selection: unavailable host qualification never creates ready choices or blocks an ordinary loop', async ({ page }) => {
  const value = await task('Read unavailable qualification (scripted)');
  await page.route(/\/loop\/collaboration-options(?:\?|$)/, route => route.fulfill({ status: 200, json: {
    leads: [], members: [], helpers: [], reviews: [], reason: 'Collaboration is unavailable: no billing-qualified host is configured.',
  } }));
  const form = await openStart(page, value);
  await expect(form.getByText('Collaboration is unavailable: no billing-qualified host is configured.', { exact: true })).toBeVisible();
  for (const label of ['Team lead', 'Team member', 'Helper profile', 'Jev review']) await expect(form.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(form.getByRole('button', { name: 'Start loop run' })).toBeEnabled();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('scripted journey: real Team mail, distinct H14 helper, review, exact Need and verified Board Done', async ({ page }) => {
  test.setTimeout(120_000);
  const value = await task('Reconcile inventory with the Agent (scripted)');
  await api(`/projects/${project.id}/tasks/${value.id}/acceptance`, 'PUT', { checks: [
    { id: 'discrepancy', kind: 'text-contains', path: 'Harness report.md', text: 'B is the sole discrepancy: 8 expected, 6 counted.' },
    { id: 'totals', kind: 'text-contains', path: 'Harness report.md', text: '23 expected, 21 counted' },
    { id: 'shortage', kind: 'text-contains', path: 'Harness report.md', text: 'shortage 2 units at $3.75, worth $7.50.' },
    { id: 'no-update', kind: 'text-contains', path: 'Harness report.md', text: 'No inventory system was updated.' },
  ] });
  const form = await openStart(page, value);
  await choose(form);
  const started = page.waitForResponse(response => startPattern.test(response.url()) && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Start loop run' }).click();
  const response = await started;
  expect(response.ok(), await response.text()).toBe(true);
  const { runId } = await response.json() as { runId: string };
  let need: Need | undefined;
  await expect.poll(async () => {
    need = (await state()).needs.find(item => item.taskId === value.id && item.state === 'open');
    return Boolean(need);
  }, { timeout: 30_000 }).toBe(true);
  const waiting = await state();
  expect(waiting.tasks.find(item => item.id === value.id)!.state).not.toBe('done');
  // Harness Needs intentionally keep preview empty and pin the exact write in their signed intent.
  expect(harnessWrites(project.id, need!)).toEqual([{ path: 'Harness report.md', expected: null, text: SCRIPTED_REPORT }]);
  expect(await application!.locals.store.current(project.id, 'Harness report.md')).toBeNull();
  const teamRun = (waiting.team!.runs as any[]).find(item => item.rootRunId === runId);
  expect(teamRun).toBeDefined();
  expect(waiting.team!.messages.some(item => item.from === SCRIPTED_MEMBER && item.to === SCRIPTED_LEAD && item.content === SCRIPTED_MEMBER_ANSWER)).toBe(true);
  const leads = await api<{ leads: any[] }>(`/projects/${project.id}/loop/team`);
  const helper = leads.leads.find(item => item.runId === runId).team.workers[0];
  expect(helper.text).toBe(SCRIPTED_HELPER_ANSWER);
  expect(teamRun.harnessRunId).toBeTruthy();
  expect(helper.childRunId).toBeTruthy();
  expect(new Set([runId, teamRun.id, teamRun.harnessRunId, helper.childRunId, helper.handoffId]).size).toBe(5);
  const recorded = await application!.locals.harness.runs.get(runId);
  expect(recorded.steps.filter((step: any) => step.intent.permission === EVALUATION_PERMISSION)).toHaveLength(1);
  expect(log.calls.filter(item => item.role === 'review' && item.runId === runId)).toHaveLength(1);
  expectScriptedModelSteps(recorded);
  expectScriptedModelSteps(await application!.locals.harness.runs.get(teamRun.harnessRunId));
  expectScriptedModelSteps(await application!.locals.harness.runs.get(helper.childRunId));

  // Inspect the actual Team/H14 projections before accepting the exact file proposal.
  await page.getByRole('navigation', { name: 'Threads and views', exact: true }).getByRole('button', { name: /^Team\b/ }).click();
  await expect(page.locator(`.team [data-lane="${SCRIPTED_LEAD}"] .msg`)).toContainText(SCRIPTED_MEMBER_ANSWER);
  await expect(page.locator(`[data-lead="${runId}"] .lw-answer`)).toContainText(SCRIPTED_HELPER_ANSWER);
  await openThread(page, value);
  const inspector = page.locator('#scrThread details.run-inspector');
  await inspector.locator('summary').click();
  const loop = page.getByRole('region', { name: `${AGENT_NAME} work loop` });
  await expect(loop.locator('.loop-models')).toHaveText('None reported yet');
  await expect(loop.locator('.loop-turn-tool')).toContainText(['team_task_create', 'team_send_message', 'assign_workers', 'review_report', 'propose_write']);
  await expect(loop.locator('[data-loop-outcome]')).not.toHaveText('Verified');
  const resolved = page.waitForRequest(request => /\/needs\/[^/]+\/resolve$/.test(request.url()) && request.method() === 'POST');
  await page.getByRole('region', { name: 'Needs your OK' }).getByRole('button', { name: 'Go ahead', exact: true }).click();
  expect((await resolved).postDataJSON()).toMatchObject({ resolution: 'go-ahead', proposalDigest: need!.approval!.proposalDigest,
    actionDigest: need!.approval!.actionDigest, baseDigest: need!.approval!.baseDigest });
  await expect.poll(async () => (await api<any>(`/projects/${project.id}/loop/runs/${runId}`)).outcome.state, { timeout: 30_000 }).toBe('verified');
  expect(await fs.readFile(path.join(project.folder, 'Harness report.md'), 'utf8')).toBe(SCRIPTED_REPORT);
  await expect(loop.locator('[data-loop-outcome]')).toHaveText('Verified');
  await keepReport(page, value);
  await page.getByRole('navigation', { name: 'Threads and views', exact: true }).getByRole('button', { name: /^Board\b/ }).click();
  await expect(page.locator(`.column[aria-label="Done"] [data-task-id="${value.id}"]`)).toContainText(value.name);
  expect((await state()).tasks.find(item => item.id === value.id)!.state).toBe('done');
});

test('scripted Stop and actual host restart preserve owned evidence before an explicit new Team start', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const value = await task('Stop owned inventory work (scripted)');
  const existingReport = '# Existing report before scripted Stop\nThis owned fixture must remain unchanged.\n';
  await fs.writeFile(path.join(project.folder, 'Harness report.md'), existingReport);
  const repliesAtStart = memberReplies(await state()).length;
  const helperCallsAtStart = log.calls.filter(item => item.role === 'helper').length;
  const reviewCallsAtStart = log.calls.filter(item => item.role === 'review').length;
  log.hangMember = true;
  try {
    const form = await openStart(page, value);
    const reportSource = form.getByRole('checkbox', { name: 'Harness report.md', exact: true });
    await reportSource.uncheck();
    await expect(reportSource).not.toBeChecked();
    await choose(form);
    const started = page.waitForResponse(response => startPattern.test(response.url()) && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Start loop run' }).click();
    const response = await started;
    expect(response.ok(), await response.text()).toBe(true);
    const { runId } = await response.json() as { runId: string };
    let owned: any;
    await expect.poll(async () => { owned = ((await state()).team!.runs as any[]).find(item => item.rootRunId === runId); return owned?.status; }).toBe('running');
    await page.locator('#scrThread .record.live .stop-menu').last().getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(async () => (await application!.locals.harness.runs.get(runId)).state).toBe('cancelled');
    await expect.poll(async () => ((await state()).team!.runs as any[]).find(item => item.rootRunId === runId)?.status).toBe('cancelled');
    await page.reload();
    await openThread(page, value);
    const inspector = page.locator('#scrThread details.run-inspector');
    await inspector.locator('summary').click();
    await expect(page.getByRole('region', { name: `${AGENT_NAME} work loop` }).locator('[data-loop-outcome]')).toContainText('Stopped');
    const stopped: HarnessRun = await application!.locals.harness.runs.get(runId);
    const ownedChildren: HarnessRun[] = await application!.locals.harness.loop.children(stopped);
    expect(ownedChildren.filter(child => child.capabilityId === TEAM_WORKER_CAPABILITY)).toEqual([]);
    const h14 = await application!.locals.harness.loop.teamView(stopped);
    expect(h14).not.toBeNull();
    expect(h14.workers).toEqual([]);
    // A helper uses its child run ID. Compare the call delta, rather than filtering by root ID.
    expect(log.calls.filter(item => item.role === 'helper')).toHaveLength(helperCallsAtStart);
    expect(log.calls.filter(item => item.role === 'review')).toHaveLength(reviewCallsAtStart);
    const after = await state();
    expect(after.tasks.find(item => item.id === value.id)!.state).not.toBe('done');
    expect(after.needs.filter(item => item.taskId === value.id && item.state === 'open')).toEqual([]);
    expect(memberReplies(after)).toHaveLength(repliesAtStart);
    expect(await fs.readFile(path.join(project.folder, 'Harness report.md'), 'utf8')).toBe(existingReport);
    await page.getByRole('navigation', { name: 'Threads and views', exact: true }).getByRole('button', { name: /^Team\b/ }).click();
    const ended = page.locator(`.team [data-lane="${SCRIPTED_MEMBER}"] [data-team-run="${owned.id}"]`);
    const terminalTeam = (after.team!.runs as any[]).find(item => item.id === owned.id);
    await expect(ended).toContainText(terminalTeam.unknownOutcome ? 'outcome unknown' : 'stopped');
    await expect(ended).not.toContainText('finished');
    await page.screenshot({ path: testInfo.outputPath('stopped-team-before-host-restart.png'), fullPage: true });

    const previousApplication = application;
    const previousBoot = hostBootId;
    const callsBeforeRestart = structuredClone(log.calls);
    const durableRoot = await application!.locals.harness.runs.get(runId);
    const durableChild = await application!.locals.harness.runs.get(owned.harnessRunId);
    const durableTeam = structuredClone(after.team);
    await closeHost();
    await expect(fetch(baseURL + '/api/settings')).rejects.toThrow();
    await openHost();
    expect(application).not.toBe(previousApplication);
    expect(hostBootId).not.toBe(previousBoot);
    expect(await application!.locals.harness.runs.get(runId)).toEqual(durableRoot);
    expect(await application!.locals.harness.runs.get(owned.harnessRunId)).toEqual(durableChild);
    const recoveredTeam = (await state()).team!;
    expect(log.calls).toEqual(callsBeforeRestart);
    await fs.writeFile(testInfo.outputPath('host-restart-checkpoint.json'), JSON.stringify({
      previousBoot, reopenedBoot: hostBootId, stoppedRoot: durableRoot, stoppedChild: durableChild,
      teamBeforeRestart: durableTeam, teamAfterRestart: recoveredTeam, callsBeforeRestart, callsAfterRestart: log.calls,
    }, null, 2));
    // Keep this history acceptance gap visible: recovery currently rewrites a terminal endedAt.
    // No lifecycle contract authorizes that rewrite; do not normalize it into an idempotence pass.
    expect.soft(recoveredTeam, 'Terminal Team history must survive host restart unchanged.').toEqual(durableTeam);
    await openThread(page, value);
    const restartedInspector = page.locator('#scrThread details.run-inspector');
    await restartedInspector.locator('summary').click();
    await expect(page.getByRole('region', { name: AGENT_NAME + ' work loop' }).locator('[data-loop-outcome]')).toContainText('Stopped');
    expect(log.calls).toEqual(callsBeforeRestart);
    expect(await fs.readFile(path.join(project.folder, 'Harness report.md'), 'utf8')).toBe(existingReport);
    await page.screenshot({ path: testInfo.outputPath('stopped-after-host-restart.png'), fullPage: true });

    // This owned root cannot be retried: the normal control must retain that spend boundary.
    const refusedRetry = page.waitForResponse(response => /\/controls$/.test(response.url()) && response.request().method() === 'POST');
    await page.locator('#scrThread').getByRole('toolbar', { name: 'Run controls' }).last().getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('group', { name: 'Confirm retry' }).getByRole('button', { name: 'Retry now', exact: true }).click();
    const refusal = await (await refusedRetry).json();
    expect(refusal.receipt).toMatchObject({ control: 'retry', outcome: 'refused' });
    expect(refusal.receipt.detail).toContain('bounded response and spend records');
    expect(log.calls).toEqual(callsBeforeRestart);

    // A real, fresh UI command is the only event allowed to create the next owned run.
    log.hangMember = false;
    await api('/projects/' + project.id + '/tasks/' + value.id + '/acceptance', 'PUT', { checks: [
      { id: 'retry-report', kind: 'text-contains', path: 'Harness report.md', text: 'B is the sole discrepancy: 8 expected, 6 counted.' },
    ] });
    const sessionsBeforeRetry = (await state()).sessions.filter(item => item.taskId === value.id);
    const retryForm = await openStart(page, value);
    await retryForm.getByRole('checkbox', { name: 'Harness report.md', exact: true }).uncheck();
    await choose(retryForm);
    const retryResponse = page.waitForResponse(response => startPattern.test(response.url()) && response.request().method() === 'POST');
    await retryForm.getByRole('button', { name: 'Start loop run' }).click();
    const retried = await retryResponse;
    expect(retried.ok(), await retried.text()).toBe(true);
    const retry = await retried.json() as { runId: string };
    expect(retry.runId).not.toBe(runId);
    let retryNeed: Need | undefined;
    await expect.poll(async () => {
      retryNeed = (await state()).needs.find(item => item.taskId === value.id && item.state === 'open');
      return Boolean(retryNeed);
    }, { timeout: 30_000 }).toBe(true);
    const retryState = await state();
    expect(retryState.sessions.filter(item => item.taskId === value.id)).toHaveLength(sessionsBeforeRetry.length + 1);
    const retryChildren = (retryState.team!.runs as any[]).filter(item => item.rootRunId === retry.runId);
    expect(retryChildren).toHaveLength(1);
    expect(retryChildren[0].harnessRunId).not.toBe(owned.harnessRunId);
    expect(memberReplies(retryState)).toHaveLength(repliesAtStart + 1);
    const retryBase = await application!.locals.store.current(project.id, 'Harness report.md');
    expect(await fs.readFile(path.join(project.folder, 'Harness report.md'), 'utf8')).toBe(existingReport);
    expect(retryBase).toBe(existingReport);
    expect(harnessWrites(project.id, retryNeed!)).toEqual([{ path: 'Harness report.md',
      expected: createHash('sha256').update(retryBase!).digest('hex'), text: SCRIPTED_REPORT }]);
    await page.getByRole('navigation', { name: 'Threads and views', exact: true }).getByRole('button', { name: /^Team\b/ }).click();
    await expect(page.locator('.team [data-lane="' + SCRIPTED_LEAD + '"] .msg')).toContainText(SCRIPTED_MEMBER_ANSWER);
    await openThread(page, value);
    const approved = page.waitForRequest(request => /\/needs\/[^/]+\/resolve$/.test(request.url()) && request.method() === 'POST');
    await page.getByRole('region', { name: 'Needs your OK' }).getByRole('button', { name: 'Go ahead', exact: true }).click();
    expect((await approved).postDataJSON()).toMatchObject({ resolution: 'go-ahead', proposalDigest: retryNeed!.approval!.proposalDigest,
      actionDigest: retryNeed!.approval!.actionDigest, baseDigest: retryNeed!.approval!.baseDigest });
    await expect.poll(async () => (await api<any>('/projects/' + project.id + '/loop/runs/' + retry.runId)).outcome.state, { timeout: 30_000 }).toBe('verified');
    expect(await fs.readFile(path.join(project.folder, 'Harness report.md'), 'utf8')).toBe(SCRIPTED_REPORT);
    await keepReport(page, value);
    await page.getByRole('navigation', { name: 'Threads and views', exact: true }).getByRole('button', { name: /^Board\b/ }).click();
    await expect(page.locator('.column[aria-label="Done"] [data-task-id="' + value.id + '"]')).toContainText(value.name);
    expect(await application!.locals.harness.runs.get(runId)).toEqual(durableRoot);
    expect(await application!.locals.harness.runs.get(owned.harnessRunId)).toEqual(durableChild);
    expect(log.calls.filter(item => item.runId === runId || item.runId === owned.harnessRunId))
      .toEqual(callsBeforeRestart.filter(item => item.runId === runId || item.runId === owned.harnessRunId));
    await page.screenshot({ path: testInfo.outputPath('normal-retry-board-done.png'), fullPage: true });
    await fs.writeFile(testInfo.outputPath('actual-host-restart-and-retry.json'), JSON.stringify({
      previousBoot, reopenedBoot: hostBootId, fixtureRoot, port: hostPort, stoppedRoot: runId,
      stoppedChild: owned.harnessRunId, newRoot: retry.runId, newChild: retryChildren[0].harnessRunId,
      callsBeforeRestart, callsAfterExplicitRetry: log.calls, stoppedRootEvidence: durableRoot,
      stoppedChildEvidence: durableChild, teamBeforeRestart: durableTeam, teamAfterRestart: recoveredTeam, stateAfterRetry: await state(),
    }, null, 2));
  } finally { log.hangMember = false; }
});

test('scripted Stop: an active real H14 helper stops without review or report dispatch after reload', async ({ page }) => {
  test.setTimeout(120_000);
  const value = await task('Stop an active H14 helper (scripted)');
  const beforeReport = '# Existing report before H14 Stop\nKeep these owned bytes.\n';
  await fs.writeFile(path.join(project.folder, 'Harness report.md'), beforeReport);
  const reviewCallsAtStart = log.calls.filter(item => item.role === 'review').length;
  log.hangHelper = true;
  try {
    const form = await openStart(page, value);
    await form.getByRole('checkbox', { name: 'Harness report.md', exact: true }).uncheck();
    await choose(form);
    const started = page.waitForResponse(response => startPattern.test(response.url()) && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Start loop run' }).click();
    const response = await started;
    expect(response.ok(), await response.text()).toBe(true);
    const { runId } = await response.json() as { runId: string };
    let helper: HarnessRun | undefined;
    await expect.poll(async () => {
      const root = await application!.locals.harness.runs.get(runId);
      helper = (await application!.locals.harness.loop.children(root)).find((child: HarnessRun) => child.capabilityId === TEAM_WORKER_CAPABILITY);
      return helper?.state === 'running' && log.calls.some(item => item.role === 'helper' && item.runId === helper!.id);
    }, { timeout: 30_000 }).toBe(true);
    const helperCallsAtStop = log.calls.filter(item => item.role === 'helper').length;
    await page.locator('#scrThread .record.live .stop-menu').last().getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(async () => (await application!.locals.harness.runs.get(runId)).state).toBe('cancelled');
    await expect.poll(async () => (await application!.locals.harness.runs.get(helper!.id)).state).toBe('cancelled');
    await page.reload();
    await openThread(page, value);
    const inspector = page.locator('#scrThread details.run-inspector');
    await inspector.locator('summary').click();
    await expect(page.getByRole('region', { name: `${AGENT_NAME} work loop` }).locator('[data-loop-outcome]')).toContainText('Stopped');
    const after = await state();
    expect(after.tasks.find(item => item.id === value.id)!.state).not.toBe('done');
    expect(after.needs.filter(item => item.taskId === value.id && item.state === 'open')).toEqual([]);
    expect(log.calls.filter(item => item.role === 'helper')).toHaveLength(helperCallsAtStop);
    expect(log.calls.filter(item => item.role === 'review')).toHaveLength(reviewCallsAtStart);
    expect(await fs.readFile(path.join(project.folder, 'Harness report.md'), 'utf8')).toBe(beforeReport);
  } finally { log.hangHelper = false; }
});

test('normal Retry control admits one linked ordinary loop and completes its exact approval and Board journey', async ({ page }, testInfo) => {
  const value = await task('Retry a stopped ordinary loop through its normal control');
  await api(`/projects/${project.id}/tasks/${value.id}/acceptance`, 'PUT', { checks: [
    { id: 'retry-content', kind: 'text-contains', path: 'Harness report.md', text: 'inventory.txt' },
  ] });
  const form = await openStart(page, value);
  await form.getByLabel('Route', { exact: true }).selectOption('native-fixture');
  await form.getByLabel('Goal', { exact: true }).fill('Read inventory.txt and propose Harness report.md.');
  const started = page.waitForResponse(response => startPattern.test(response.url()) && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Start loop run' }).click();
  const initialResponse = await started;
  expect(initialResponse.ok(), await initialResponse.text()).toBe(true);
  const initial = await initialResponse.json() as { runId: string; session: { id: string } };
  await expect.poll(async () => (await state()).needs.some(item => item.taskId === value.id && item.state === 'open')).toBe(true);
  await page.locator('#scrThread .record.live .stop-menu').last().getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await application!.locals.harness.runs.get(initial.runId)).state).toBe('cancelled');
  const before = await state();
  const callsBefore = structuredClone(log.calls);
  const retried = page.waitForResponse(response => /\/controls$/.test(response.url()) && response.request().method() === 'POST');
  await page.locator('#scrThread').getByRole('toolbar', { name: 'Run controls' }).last().getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('group', { name: 'Confirm retry' }).getByRole('button', { name: 'Retry now', exact: true }).click();
  const retryResponse = await retried;
  expect(retryResponse.ok(), await retryResponse.text()).toBe(true);
  const { receipt } = await retryResponse.json();
  expect(receipt).toMatchObject({ control: 'retry', outcome: 'applied', lineage: { originSessionId: initial.session.id, attempt: 2 } });
  expect(receipt.result.sessionId).not.toBe(initial.session.id);
  let need: Need | undefined;
  await expect.poll(async () => {
    need = (await state()).needs.find(item => item.sessionId === receipt.result.sessionId && item.state === 'open');
    return Boolean(need);
  }).toBe(true);
  expect((await state()).sessions).toHaveLength(before.sessions.length + 1);
  const run = await application!.locals.harness.runs.get(need!.harness!.runId);
  expect(run.input).toMatchObject({ retryOf: { runId: initial.runId, attempt: 2 } });
  expect(harnessWrites(project.id, need!)[0].text).toContain('inventory.txt');
  await openThread(page, value);
  const approved = page.waitForRequest(request => /\/needs\/[^/]+\/resolve$/.test(request.url()) && request.method() === 'POST');
  await page.getByRole('region', { name: 'Needs your OK' }).getByRole('button', { name: 'Go ahead', exact: true }).click();
  expect((await approved).postDataJSON()).toMatchObject({ proposalDigest: need!.approval!.proposalDigest,
    actionDigest: need!.approval!.actionDigest, baseDigest: need!.approval!.baseDigest });
  await expect.poll(async () => (await api<any>(`/projects/${project.id}/loop/runs/${run.id}`)).outcome.state).toBe('verified');
  await keepReport(page, value);
  await page.getByRole('navigation', { name: 'Threads and views', exact: true }).getByRole('button', { name: /^Board\b/ }).click();
  await expect(page.locator(`.column[aria-label="Done"] [data-task-id="${value.id}"]`)).toContainText(value.name);
  expect(log.calls).toEqual(callsBefore); // Built-in fixed script: no provider or scripted cloud dispatch.
  await page.screenshot({ path: testInfo.outputPath('normal-retry-control-board-done.png'), fullPage: true });
  await fs.writeFile(testInfo.outputPath('normal-retry-control.json'), JSON.stringify({ initial, receipt, newRoot: run.id, state: await state() }, null, 2));
});
