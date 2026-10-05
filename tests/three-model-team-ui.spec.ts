import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { testOnlySecretBox } from '../server/connection-secrets';
import { currentAuthority } from '../server/trust/index';
import { LOCAL_MODEL_NOT_RUNNING } from '../server/bonsai/runtime';
import { AGENT_NAME } from '../shared/agent-name';
import type { Project, ProjectState, Task, TeamMember } from '../shared/types';
import { reopenLastProject } from './fixtures/landing';
import {
  addTeam, connectTeamRoutes, DELIVERY, fixtureGate, fixtureTrust, K3, localHost, MEMBER_ANSWER, ORDER,
  SOURCES, teamFixture, teamTransport,
} from './fixtures/three-model-team';

/**
 * DIO-216 slice B in the built Console: the start dialog offers a Team member on the local model,
 * names it by its profile, shows the runtime's own reason while that profile isn't running, and
 * starts an Agent Team run with a Sol lead on Azure, the local member and a K3 helper profile on AWS.
 * The real host runs with scripted transports and a mocked local host; nothing reaches a provider
 * or a real local model, and nothing starts one. This is no live provider proof.
 */
test.describe.configure({ mode: 'serial' });
const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const startPattern = /\/api\/projects\/[^/]+\/loop\/start$/;
const fixture = teamFixture();
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let project: Project;
let lead: TeamMember, member: TeamMember, helperProfileId = '';

async function api<T = any>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${route} refused: ${JSON.stringify(payload)}`);
  return payload as T;
}
const state = () => api<ProjectState>(`/projects/${project.id}/state`);

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(results, 'three-model-team-ui-'));
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const file of ['client/console/LoopStart.tsx', 'client/console/loop-start-model.ts'])
    expect(built, 'Build the production client for this exact candidate before its UI test.').toBeGreaterThan((await fs.stat(file)).mtimeMs);
  const engines = new EngineService(path.join(fixtureRoot, 'engines'), { discover: async () => [] });
  engines.agentGate = fixtureGate;
  server = createServer();
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as AddressInfo).port;
  baseURL = `http://127.0.0.1:${port}`;
  application = await createApp({
    port, clientPort: port, dataDir: path.join(fixtureRoot, 'data'), projectRoot: path.join(fixtureRoot, 'projects'),
    engineService: engines, reviewerAdapter: null, verificationReviewer: null, automationTickMs: null,
    secretBox: testOnlySecretBox(), modelApiTransport: teamTransport(fixture),
    bonsai: { host: localHost(fixture), configured: true },
    harnessAuthority: (claim) => currentAuthority(claim, fixtureTrust),
  });
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', application);
  await api('/settings', 'PUT', {
    detail: 'technical',
    onboarding: { work: 'business', detail: 'technical', familiarity: 'comfortable', resumeAt: 'done', completedAt: new Date().toISOString() },
  });
  project = await api<Project>('/projects', 'POST', { name: 'Linen orders' });
  const folder = application.locals.store.state(project.id).project.folder as string;
  await fs.writeFile(path.join(folder, 'order.md'), ORDER);
  await fs.writeFile(path.join(folder, 'delivery.md'), DELIVERY);
  await connectTeamRoutes(api, path.join(fixtureRoot, 'data'), project.id);
  ({ lead, member, helperProfileId } = await addTeam(api, project.id));
  fixture.memberSlotId = member.slotId;
  await api('/settings', 'PUT', { openProjects: [project.id] });
});

test.afterAll(async () => {
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
});

async function task(name: string) {
  const created = await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name, description: 'Compare delivery.md with order.md and report what is short.',
  });
  await api(`/projects/${project.id}/threads`, 'POST', { attachedTo: { kind: 'task', ref: created.id } });
  return created;
}
async function openStart(page: Page, value: Task) {
  await page.goto(baseURL);
  await reopenLastProject(page);
  const name = value.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('navigation', { name: 'Threads and views', exact: true }).getByRole('button', { name: new RegExp(name) }).first().click();
  await expect(page.locator('#scrThread')).toBeVisible();
  await page.getByRole('complementary', { name: 'This project' }).getByRole('button', { name: 'Loop run' }).click();
  const form = page.getByRole('form', { name: `Start a ${AGENT_NAME} work loop` });
  await expect(form).toBeVisible();
  return form;
}

test('a local member whose profile is not running is listed with the runtime’s reason, and nothing starts it', async ({ page }) => {
  fixture.running = null;
  const form = await openStart(page, await task('Check the linen delivery while the local model is stopped'));
  const option = form.getByLabel('Team member', { exact: true }).locator(`option[value="${member.slotId}"]`);
  await expect(option).toHaveText('Counter · Bonsai Gaming');
  // Read the option's native state; generic enabled matchers can retarget its enclosing select.
  await expect(option).toHaveJSProperty('disabled', true);
  await expect(form.getByText(LOCAL_MODEL_NOT_RUNNING, { exact: true })).toBeVisible();
  // The lead and the helper are still offered; only the member waits for the person's own Start.
  await expect(form.getByLabel('Team lead', { exact: true }).locator(`option[value="${lead.slotId}"]`)).toHaveJSProperty('disabled', false);
  await expect(form.getByLabel('Helper profile', { exact: true }).locator(`option[value="${helperProfileId}"]`)).toHaveJSProperty('disabled', false);
  await expect(form.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
  expect(fixture.acquires).toEqual([]);
  expect(fixture.calls).toEqual([]);
});

test('with Gaming running, the dialog starts a run: Sol leads, the local model is the member, K3 helps', async ({ page }) => {
  fixture.running = 'Gaming';
  const value = await task('Check the linen delivery with the team');
  const form = await openStart(page, value);
  await form.getByLabel('Team lead', { exact: true }).selectOption(lead.slotId);
  const memberSelect = form.getByLabel('Team member', { exact: true });
  await expect(memberSelect.locator(`option[value="${member.slotId}"]`)).toHaveJSProperty('disabled', false);
  await memberSelect.selectOption(member.slotId);
  await form.getByLabel('Helper profile', { exact: true }).selectOption(helperProfileId);
  for (const source of SOURCES) await form.getByRole('checkbox', { name: source, exact: true }).check();
  await form.getByRole('checkbox', { name: /^Send the goal and the files it reads/ }).check();
  const started = page.waitForResponse((response) => startPattern.test(response.url()) && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Start loop run' }).click();
  const response = await started;
  expect(response.status(), await response.text()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({
    taskId: value.id, route: 'azure-openai', consent: true, composition: true,
    persistentTeam: { leadSlotId: lead.slotId, memberSlotId: member.slotId },
    team: { worker: { profileId: helperProfileId }, advisor: null },
  });
  await expect(form).toHaveCount(0);

  // The lead proposes its report for approval once the local member and the K3 helper answered.
  await expect.poll(async () => (await state()).needs.some((need) => need.state === 'open' && need.approval),
    { timeout: 30_000 }).toBe(true);
  expect([...new Set(fixture.calls.map((call) => call.route))].sort()).toEqual(['aws-bedrock', 'azure-openai', 'bonsai']);
  expect(fixture.calls.filter((call) => call.route === 'bonsai' && call.url.endsWith('/v1/chat/completions'))).toHaveLength(1);
  expect(fixture.calls.filter((call) => call.route === 'aws-bedrock').map((call) => call.body?.model)).toEqual([K3]);
  expect(JSON.stringify(fixture.leadOutputs)).toContain(MEMBER_ANSWER);
  // The local model was used as it was running, and never started.
  expect(fixture.acquires).toEqual([{ start: false }]);
});
