/**
 * Automations are part of a paid plan (Andrew, 2026-09-28: "automations are paid plans only,
 * whether its business+ OR individual tier plans"). Finding F01 of the independent review of
 * #171: a business with no plan could run the weekly brief and turn its schedule on, because
 * nothing on the server asked for a plan. Only the Console's Personal branch showed the notice.
 *
 * Every way an Automation starts, against the businesses the faux seed holds, with the real
 * control-plane handler in this process:
 *
 *   Run once                 refused and recorded in the server's words, before anything starts
 *   Turning a schedule on    refused with 403, and the schedule stays off
 *   A scheduled slot         recorded as refused once the plan has ended, with an attention item
 *
 * Harbor Hardware holds no grant, and neither does a business a free person creates. Juniper
 * Street Bakery holds Business and runs them, which is what shows the check does not over-block.
 * The weekly brief is deterministic, so no engine is involved either way; the project's tasks
 * show that nothing started. An individual plan will carry them once the person-level grant
 * exists (phase 2 of the free harness).
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { AccountBackend } from '../server/accounts/backend';
import { ControlPlaneClient } from '../server/accounts/client';
import type { AutomationScheduler } from '../server/automation-scheduler';
import type { AutomationService } from '../server/automations';
import { testOnlySecretBox } from '../server/connection-secrets';
import { EngineService } from '../server/engines/service';
import {
  createFauxCloud,
  FAUX_BACKEND_LABEL,
  type FauxCloud,
} from '../services/control-plane/src/faux/cloud';
import {
  DEMO_ACCOUNTS,
  FAUX_DEMO_PASSWORD,
  seedDemo,
} from '../services/control-plane/src/faux/seed';
import type { AccountStateView } from '../shared/accounts';
import { AUTOMATIONS_NOT_INCLUDED_REASON } from '../shared/access';
import { nextSlots, type AutomationSchedule } from '../shared/automation-schedule';
import type {
  AutomationDetail,
  AutomationList,
  RunOnceResult,
  ScheduleChangeResult,
  TriggerOccurrence,
} from '../shared/automations';
import type { Project } from '../shared/types';
import type { WorkspaceView } from '../shared/workspaces';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
/** The sentence a person reads wherever an Automation is refused for want of a plan. */
const PAID_PLAN = /^Automations are part of a paid plan\./;
const MONDAY_8: AutomationSchedule = {
  cadence: 'weekly',
  weekday: 1,
  time: '08:00',
  timezone: 'America/New_York',
};

let root: string;
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
/** The automation clock: real time until a test fixes it. */
let clock: number | null = null;

const request = (route: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}
const signIn = (email: string) =>
  api<AccountStateView>('/account/sign-in', 'POST', {
    email,
    password: FAUX_DEMO_PASSWORD,
    remember: false,
  });
/** A signed-in session at the account service, for staff. */
async function staffToken(email: string) {
  const pair = await cloud.store.run((draft) =>
    cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }),
  );
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}
const scheduler = () => app.locals.automationScheduler as AutomationScheduler;
const service = () => app.locals.automations as AutomationService;
const taskCount = async (project: Project) =>
  (await api<{ tasks: unknown[] }>(`/projects/${project.id}/state`)).tasks.length;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-automations-paid-'));
  clock = null;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  orgs = (await seedDemo(cloud)).organizations!;
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (req) => cloud.handle(req)),
    view: () => ({
      kind: 'faux',
      label: FAUX_BACKEND_LABEL,
      url: null,
      reason: null,
      signIn: 'password',
    }),
    close: async () => {},
  };
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    accounts: { backend },
    // No timer: a test moves the clock and asks for a pass.
    automationTickMs: null,
    automationClock: () => clock ?? Date.now(),
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await cloud.idle();
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * The active business's weekly brief, set up as a person does it: the setup answers, an activated
 * configuration, the files it reads and the project it writes to.
 */
async function configureBrief(organizationId: string) {
  const business = `/workspace/organizations/${organizationId}`;
  const folder = path.join(root, `books-${organizationId}`);
  await fs.mkdir(folder, { recursive: true });
  const project = await api<Project>('/projects', 'POST', { name: 'Company books', folder });
  const answers: Record<string, unknown> = {
    name: 'Automation plan fixture',
    industry: 'cabinetry',
    job: 'recurring-report',
    result: 'A weekly draft for review.',
    sources: ['files'],
    people: 'small-team',
    locations: 'one',
    'human-required': ['sending', 'money'],
    'data-leaving': 'non-sensitive',
    host: 'The office desktop',
    'spend-cap': 120,
    'first-run': 'weekly',
  };
  await api(`${business}/setup/start`, 'POST', {});
  let setup = await api<{ step: string; digest: string; state: string }>(`${business}/setup`);
  for (let i = 0; i < 20 && setup.step !== 'review'; i += 1)
    setup = await api(`${business}/setup/answer`, 'POST', {
      questionId: setup.step,
      value: answers[setup.step] ?? null,
      unknown: answers[setup.step] === undefined,
      expectedDigest: setup.digest,
    });
  expect(setup.state).toBe('proposal-ready');
  const compiled = await api<{
    staged: { revision: number };
    expectedActiveRevision: number | null;
  }>(`${business}/configuration/compile`, 'POST', {});
  const activated = await api<{
    active: { proposal: { contextScopes: { selection: string[] }[] } };
  }>(`${business}/configuration/activate`, 'POST', {
    revision: compiled.staged.revision,
    expectedActiveRevision: compiled.expectedActiveRevision,
    activationId: `paid-plan-${organizationId}`,
  });
  for (const name of activated.active.proposal.contextScopes.flatMap((scope) => scope.selection)) {
    const destination = path.join(folder, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, '- Two cabinets fitted.\n');
  }
  await api(`${business}/output`, 'POST', { projectId: project.id });
  return {
    project,
    list: `${business}/automations`,
    automation: `${business}/automations/${encodeURIComponent(`brief:${organizationId}`)}`,
  };
}

/** Saves the Monday schedule. Saving is setup: it never turns a schedule on. */
async function saveSchedule(automation: string) {
  const detail = await api<AutomationDetail>(automation);
  return api<ScheduleChangeResult>(`${automation}/schedule`, 'POST', {
    action: 'edit',
    expectedGeneration: detail.automation.schedule.generation,
    schedule: MONDAY_8,
  });
}
const turnOn = (automation: string, generation: number) =>
  request(`${automation}/schedule`, 'POST', { action: 'enable', expectedGeneration: generation });
const scheduled = (detail: AutomationDetail) =>
  detail.occurrences
    .map((item) => item.occurrence)
    .filter((item): item is TriggerOccurrence => item.trigger.kind === 'schedule');

/** Run once and turning the schedule on, for a business whose plan does not include Automations. */
async function expectRefused(organizationId: string) {
  const { project, automation } = await configureBrief(organizationId);
  const tasks = await taskCount(project);

  // The page says why before anyone presses anything.
  const detail = await api<AutomationDetail>(automation);
  expect(detail.automation.run.allowed).toBe(false);
  expect(detail.automation.run.reason).toMatch(PAID_PLAN);

  // A press is refused and recorded in the server's own words, and nothing starts.
  const pressed = await api<RunOnceResult>(`${automation}/run`, 'POST', {
    commandId: `unpaid-${organizationId}`,
  });
  expect(pressed.occurrence.admission).toMatchObject({
    state: 'refused',
    code: 'plan_not_included',
  });
  expect(
    pressed.occurrence.admission.state === 'refused' && pressed.occurrence.admission.reason,
  ).toMatch(PAID_PLAN);

  // Saving a schedule is setup and is kept; turning it on is what the plan decides.
  const saved = await saveSchedule(automation);
  expect(saved.automation.schedule.enableBlocked).toMatch(PAID_PLAN);
  const response = await turnOn(automation, saved.automation.schedule.generation);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: 'plan_not_included',
    error: expect.stringMatching(PAID_PLAN),
  });
  expect((await api<AutomationDetail>(automation)).automation.schedule.state).toBe('off');
  expect(await taskCount(project)).toBe(tasks);
}

test('a business without a plan is told why, and neither Run once nor its schedule starts anything', async () => {
  await signIn(DEMO_ACCOUNTS.harborOwner.email);
  const harbor = (await api<WorkspaceView>('/workspace')).organizations.find(
    (row) => row.organization.id === orgs.harbor,
  )!;
  expect(harbor.entitlement).toMatchObject({ state: 'none', agent: false });
  await expectRefused(orgs.harbor);
});

test('a free person who creates a business gets no Automations from it (review F01)', async () => {
  await signIn(DEMO_ACCOUNTS.free.email);
  const workspace = await api<WorkspaceView>('/workspace/organizations', 'POST', {
    name: 'Free review business',
  });
  const created = workspace.organizations.find(
    (row) => row.organization.name === 'Free review business',
  )!;
  expect(created.entitlement).toMatchObject({ state: 'none', agent: false });
  expect((await api<AccountStateView>('/account')).plan.agent).toBe('free');
  await expectRefused(created.organization.id);
});

test('a business on a plan runs them: Run once is admitted and its schedule turns on', async () => {
  await signIn(DEMO_ACCOUNTS.owner.email);
  const { automation, list } = await configureBrief(orgs.juniper);
  expect((await api<AutomationDetail>(automation)).automation.run).toEqual({
    allowed: true,
    reason: null,
  });
  const pressed = await api<RunOnceResult>(`${automation}/run`, 'POST', {
    commandId: 'juniper-run-once',
  });
  expect(pressed.occurrence.admission.state).toBe('admitted');
  await service().settled(pressed.occurrence);
  const saved = await saveSchedule(automation);
  expect(saved.automation.schedule.enableBlocked).toBeNull();
  const response = await turnOn(automation, saved.automation.schedule.generation);
  expect(response.status).toBe(200);
  expect(((await response.json()) as ScheduleChangeResult).automation.schedule.state).toBe(
    'enabled',
  );
  expect((await api<AutomationList>(list)).summary.scheduled).toBe(1);
});

test("a one-person business holding an Individual person grant is still refused: Individual covers Personal work only", async () => {
  // Harbor Hardware has no Business plan and one active member. Its owner's Individual plan does
  // not reach a business workspace, a sole proprietorship included, so Automations stay paid-only
  // for it until the person-level grant lands (phase 2b, DIO-128).
  const holder = await cloud.accounts.signIn(await staffToken(DEMO_ACCOUNTS.harborOwner.email));
  await cloud.commercial.issuePersonGrant(
    await staffToken(DEMO_ACCOUNTS.staffBilling.email),
    holder.person.id,
    { planId: 'individual', source: 'subscription', reference: 'inv_individual', note: '' },
  );
  await signIn(DEMO_ACCOUNTS.harborOwner.email);
  const harbor = (await api<WorkspaceView>('/workspace')).organizations.find(
    (row) => row.organization.id === orgs.harbor,
  )!;
  expect(harbor.entitlement).toMatchObject({ state: 'none', agent: false });
  // Sets Harbor up, then checks Run once is refused and recorded and turning the schedule on is
  // blocked with a 403, the same as every other unpaid business.
  await expectRefused(orgs.harbor);
  const automation = `/workspace/organizations/${orgs.harbor}/automations/${encodeURIComponent(`brief:${orgs.harbor}`)}`;
  expect((await api<AutomationDetail>(automation)).automation.run).toEqual({
    allowed: false,
    reason: AUTOMATIONS_NOT_INCLUDED_REASON,
  });
});

test('a schedule turned on under a plan starts nothing once the plan ends, and says why', async () => {
  await signIn(DEMO_ACCOUNTS.owner.email);
  const { project, automation, list } = await configureBrief(orgs.juniper);
  const [slot] = nextSlots(MONDAY_8, Date.now(), 1);
  // Ten minutes before the slot, this computer is up and has been seen.
  clock = slot!.ms - 10 * 60_000;
  await scheduler().tick();
  const saved = await saveSchedule(automation);
  expect((await turnOn(automation, saved.automation.schedule.generation)).status).toBe(200);
  expect((await api<AutomationList>(list)).summary.scheduled).toBe(1);
  const tasks = await taskCount(project);

  // The plan ends at the account service. Reading it again as soon as a downgrade is confirmed
  // is review finding F02 (server/accounts/session.ts, its own lane), so this host is asked here.
  const billing = await staffToken(DEMO_ACCOUNTS.staffBilling.email);
  const grant = (await cloud.commercial.customer(billing, orgs.juniper)).grants.find(
    (item) => item.state === 'active',
  )!;
  await cloud.commercial.revokeGrant(billing, orgs.juniper, grant.id, {
    reason: 'Test: the plan ended.',
  });
  await api('/account/refresh', 'POST', {});

  // At once: the schedule no longer counts as starting on its own, and the row says why.
  const ended = await api<AutomationDetail>(automation);
  expect(ended.automation.status).toMatchObject({
    label: 'needs-investigation',
    reason: expect.stringMatching(PAID_PLAN),
  });
  expect((await api<AutomationList>(list)).summary.scheduled).toBe(0);

  // The slot comes due: it is recorded as refused, raises attention, and nothing starts.
  clock = slot!.ms + 10_000;
  await scheduler().tick();
  const detail = await api<AutomationDetail>(automation);
  const [refused] = scheduled(detail);
  expect(refused!.admission).toMatchObject({ state: 'refused', code: 'plan_not_included' });
  expect(detail.automation.attention).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'blocked', detail: expect.stringMatching(PAID_PLAN) }),
    ]),
  );
  expect(await taskCount(project)).toBe(tasks);
  clock = null;
});
