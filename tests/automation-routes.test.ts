/**
 * Automations Milestone A, slice A4: admission and routes, through the real
 * HTTP surface a person's Console uses.
 *
 * A second person is simulated the way `tests/business-output-routes.test.ts`
 * does it, by restarting the host over a different development-fixture
 * identity. Every company, project and file here is invented.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';
import type {
  AutomationDetail,
  AutomationList,
  RunOnceResult,
  StoredOccurrences,
} from '../shared/automations.js';
import type { Person, WorkspaceView } from '../shared/workspaces.js';

let server: Server | undefined;
let store: Store;
let root = '';
let url = '';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

async function launch() {
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
  });
  store = app.locals.store as Store;
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  (server as Server & { closeApp?: () => Promise<void> }).closeApp = app.locals.close;
}

async function stop() {
  if (!server) return;
  const current = server as Server & { closeApp?: () => Promise<void> };
  server = undefined;
  await current.closeApp?.();
  current.closeAllConnections();
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

const identityPath = () => path.join(root, 'data', 'workspaces', 'identity.json');
async function restartAs(name: string) {
  await stop();
  const current = JSON.parse(await fs.readFile(identityPath(), 'utf8')) as Person;
  await fs.writeFile(identityPath(), JSON.stringify({ ...current, id: `person_${name}`, name }));
  await launch();
}

const folder = () => path.join(root, 'folders', 'company-books');
let projectId = '';
let organizationId = '';
let selection: string[] = [];
const base = () => `/workspace/organizations/${organizationId}`;
const automationPath = () => `${base()}/automations/${encodeURIComponent(`brief:${organizationId}`)}`;

async function answerAll() {
  const canned: Record<string, unknown> = {
    name: 'Fernbrook Joinery',
    industry: 'cabinetry',
    job: 'recurring-report',
    result: 'A weekly note a person reads before anyone acts on it.',
    sources: ['files'],
    people: 'small-team',
    locations: 'one',
    'human-required': ['sending', 'money'],
    'data-leaving': 'non-sensitive',
    host: 'The office desktop, weekdays.',
    'spend-cap': 120,
    // A weekly answer is recorded and stays inactive: it must never read as scheduled.
    'first-run': 'weekly',
  };
  await request(`${base()}/setup/start`, 'POST', {});
  let view = (await request<{ step: string; digest: string; state: string }>(`${base()}/setup`)).data;
  for (let guard = 0; guard < 20 && view.step !== 'review'; guard += 1) {
    const response = await request<typeof view>(`${base()}/setup/answer`, 'POST', {
      questionId: view.step,
      value: canned[view.step] ?? null,
      unknown: canned[view.step] === undefined,
      expectedDigest: view.digest,
    });
    expect(response.status, `answering ${view.step}`).toBe(200);
    view = response.data;
  }
  expect(view.state).toBe('proposal-ready');
}

/** A business with an active setup, a bound project and the exports its setup names. */
async function seed() {
  await fs.mkdir(folder(), { recursive: true });
  projectId = (
    await request<{ id: string }>('/projects', 'POST', { name: 'Company books', folder: folder() })
  ).data.id;
  organizationId = (
    await request<WorkspaceView>('/workspace/organizations', 'POST', {
      name: 'Fernbrook Joinery',
      industry: null,
    })
  ).data.organizations.at(-1)!.organization.id;
  await answerAll();
  const compiled = await request<{
    staged: { revision: number };
    expectedActiveRevision: number | null;
  }>(`${base()}/configuration/compile`, 'POST', {});
  const activated = await request<{
    active: { proposal: { contextScopes: { selection: string[] }[] } };
  }>(`${base()}/configuration/activate`, 'POST', {
    revision: compiled.data.staged.revision,
    expectedActiveRevision: compiled.data.expectedActiveRevision,
    activationId: 'automations-proof-1',
  });
  expect(activated.status).toBe(200);
  selection = activated.data.active.proposal.contextScopes.flatMap((item) => item.selection);
  expect(selection.length).toBeGreaterThan(0);
  for (const name of selection) {
    await fs.mkdir(path.dirname(path.join(folder(), name)), { recursive: true });
    await fs.writeFile(path.join(folder(), name), '- Two cabinets fitted on Tuesday.\n', 'utf8');
  }
  expect((await request(`${base()}/output`, 'POST', { projectId })).status).toBe(200);
}

async function list() {
  const listed = await request<AutomationList>(`${base()}/automations`);
  expect(listed.status).toBe(200);
  return listed.data;
}

/** Follow the run through the records until it is no longer running. No clock decides the label. */
async function until(label: string) {
  for (let i = 0; i < 300; i++) {
    const shown = (await list()).automations[0]!;
    if (shown.status.label === label) return shown;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`never read as ${label}`);
}

const press = (commandId: string, extra: Record<string, unknown> = {}) =>
  request<RunOnceResult>(`${automationPath()}/run`, 'POST', { commandId, ...extra });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-automations-'));
  await launch();
  await seed();
});

afterEach(async () => {
  await stop();
  await fs.rm(root, { recursive: true, force: true });
});

describe('the Automations list', () => {
  test('shows the brief as manual and not scheduled, with a recorded weekly answer inactive', async () => {
    const shown = await list();
    expect(shown.organization.name).toBe('Fernbrook Joinery');
    expect(shown.organization.identitySource).toBe('development-fixture');
    const [brief] = shown.automations;
    expect(brief!.status.text).toBe('Manual — not scheduled');
    expect(brief!.trigger).toEqual({ kind: 'manual', text: 'Manual — not scheduled' });
    // A01: the weekly answer is recorded, said to be inactive, and counts as nothing active.
    expect(brief!.scheduleRecorded).toMatch(/recorded but stays inactive/);
    expect(shown.summary).toEqual({ configured: 1, running: 0, needsAttention: 0, notReady: 0 });
    expect(brief!.usefulness).toBe('not-measured');
    expect(brief!.project).toEqual({ id: projectId, name: 'Company books' });
    expect(brief!.run).toEqual({ allowed: true, reason: null });
    expect(brief!.reads.paths).toEqual(selection);
  });

  test('a business with nothing set up lists nothing, rather than an invented row', async () => {
    const other = (
      await request<WorkspaceView>('/workspace/organizations', 'POST', { name: 'Halcyon Bakery', industry: null })
    ).data.organizations.at(-1)!.organization.id;
    const shown = await request<AutomationList>(`/workspace/organizations/${other}/automations`);
    expect(shown.status).toBe(200);
    expect(shown.data.automations).toEqual([]);
    expect(shown.data.summary.configured).toBe(0);
  });
});

describe('Run once', () => {
  test('admits one run through the harness, and a double press is one run and a duplicate receipt', async () => {
    const [first, second] = await Promise.all([press('press-1'), press('press-1')]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.data.occurrence.id).toBe(second.data.occurrence.id);
    expect([first.data.duplicate, second.data.duplicate].sort()).toEqual([false, true]);
    const admission = first.data.occurrence.admission;
    expect(admission.state).toBe('admitted');
    const shown = await until('manual');
    expect(shown.lastResult?.text).toBe('Draft saved for review');
    const state = (await request(`/projects/${projectId}/state`)).data;
    expect(state.tasks).toHaveLength(1);
    expect(state.history.filter((entry: { kind: string }) => entry.kind === 'weekly-brief')).toHaveLength(1);
    // The occurrence pins what admission saw (A13, A14).
    expect(first.data.occurrence.target).toEqual({ projectId, projectName: 'Company books' });
    expect(first.data.occurrence.configuration?.revision).toBe(1);
    // Links resolve to the real records.
    expect(shown.latest?.run?.taskExists).toBe(true);
    expect(shown.latest?.run?.written?.path).toBe(shown.writes?.path);
    expect(shown.latest?.run?.stages.map((stage) => stage.done)).toEqual([true, true, true, false]);
  });

  test('the same command with a different request is refused, not replayed', async () => {
    expect((await press('press-2')).status).toBe(200);
    await until('manual');
    const conflict = await press('press-2', {
      projectId,
      sources: [{ path: selection[0], sha: 'a'.repeat(64) }],
    });
    expect(conflict.status).toBe(409);
    expect((conflict.data as unknown as { code: string }).code).toBe('automation_command_conflict');
  });

  test('a busy output project gives a refused occurrence with its reason', async () => {
    await store.locked(async () => {
      const state = store.state(projectId);
      const task = store.createTask(state, { name: 'Other work', description: '', owner: 'you' });
      state.sessions.push({
        id: 'S-busy',
        taskId: task.id,
        sample: true,
        state: 'working',
        startedAt: new Date().toISOString(),
        endedAt: null,
        log: [],
        entryIds: [],
        needId: null,
        engine: { name: 'sample', model: null, worker: 1, branch: null, context: null, events: 0, version: null, verified: false },
      } as never);
      await store.persist(state);
    });
    const before = (await list()).automations[0]!;
    expect(before.run.allowed).toBe(false);
    expect(before.run.reason).toMatch(/already has work in progress/);
    const refused = await press('press-busy');
    expect(refused.status).toBe(200);
    expect(refused.data.occurrence.admission).toMatchObject({ state: 'refused', code: 'project_busy' });
    const detail = (await request<AutomationDetail>(automationPath())).data;
    expect(detail.occurrences[0]!.next).toMatch(/Wait for the work in progress/);
    expect(detail.occurrences[0]!.resultText).toBe('Not written');
  });

  test('a missing source reads Waiting for data, names the file and writes nothing', async () => {
    await fs.rm(path.join(folder(), selection[0]!));
    expect((await press('press-missing')).status).toBe(200);
    const shown = await until('waiting-for-data');
    expect(shown.status.text).toBe('Waiting for data');
    expect(shown.status.reason).toContain(selection[0]);
    expect(shown.lastResult?.text).toBe('Not written');
    expect(shown.freshness?.missing).toEqual([selection[0]]);
    const state = (await request(`/projects/${projectId}/state`)).data;
    expect(state.history.filter((entry: { kind: string }) => entry.kind === 'weekly-brief')).toEqual([]);
    expect((await list()).summary.needsAttention).toBe(1);
  });

  test('the legacy brief route converges on the same admission and keeps its words', async () => {
    await fs.rm(path.join(folder(), selection[0]!));
    const legacy = await request(`${base()}/brief`, 'POST', {});
    expect(legacy.status).toBe(409);
    expect(legacy.data.code).toBe('waiting_for_data');
    expect(legacy.data.error).toContain(selection[0]);
    const detail = (await request<AutomationDetail>(automationPath())).data;
    expect(detail.total).toBe(1);
    expect(detail.occurrences[0]!.occurrence.admission.state).toBe('admitted');
  });

  test('an unknown automation and a missing command id are refused', async () => {
    const unknown = await request(`${base()}/automations/${encodeURIComponent('brief:other')}/run`, 'POST', {
      commandId: 'x-1',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.data.code).toBe('automation_not_found');
    const missing = await request(`${automationPath()}/run`, 'POST', {});
    expect(missing.status).toBe(400);
  });
});

describe('who can see it', () => {
  test('a non-member gets no existence, title, count or result (A25)', async () => {
    expect((await press('press-owner')).status).toBe(200);
    await until('manual');
    await restartAs('outsider');
    for (const [route, method, body] of [
      [`${base()}/automations`, 'GET', undefined],
      [automationPath(), 'GET', undefined],
      [`${automationPath()}/run`, 'POST', { commandId: 'outsider-1' }],
      [`/workspace/organizations/org_does_not_exist/automations`, 'GET', undefined],
    ] as const) {
      const response = await request(route, method, body);
      expect(response.status, route).toBe(404);
      expect(response.data.code).toBe('organization_not_found');
      const text = JSON.stringify(response.data);
      expect(text).not.toContain('Fernbrook');
      expect(text).not.toContain('Company books');
      expect(text).not.toMatch(/occurrence|weekly/i);
    }
  });
});

describe('after a restart', () => {
  test('every occurrence and link is rebuilt from the same records, with no ghost Running', async () => {
    expect((await press('press-a')).status).toBe(200);
    await until('manual');
    expect((await press('press-b')).status).toBe(200);
    await until('manual');
    const before = (await request<AutomationDetail>(automationPath())).data;
    await stop();
    await launch();
    const after = (await request<AutomationDetail>(automationPath())).data;
    expect(after.total).toBe(2);
    expect(after.occurrences.map((item) => item.occurrence)).toEqual(
      before.occurrences.map((item) => item.occurrence),
    );
    expect(after.occurrences.map((item) => item.run?.id)).toEqual(before.occurrences.map((item) => item.run?.id));
    expect(after.occurrences.every((item) => item.run?.taskExists)).toBe(true);
    expect(after.automation.status.label).toBe('manual');
  });

  test('an admission a crash left behind is settled once: admitted with its run, or refused (A06, A12)', async () => {
    expect((await press('press-c')).status).toBe(200);
    await until('manual');
    await stop();
    const file = path.join(root, 'data', 'workspaces', 'automations', `${organizationId}.json`);
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as StoredOccurrences;
    const [admitted] = stored.occurrences;
    const runId = (admitted!.admission as { runId: string }).runId;
    const orphan = {
      ...admitted!,
      id: 'O-orphan',
      trigger: { ...admitted!.trigger, commandId: 'press-orphan' },
      admission: { state: 'admitting', runId: 'R-brief-never-created' },
    };
    await fs.writeFile(
      file,
      JSON.stringify({
        ...stored,
        occurrences: [{ ...admitted!, admission: { state: 'admitting', runId } }, orphan],
      }),
    );
    await launch();
    const detail = (await request<AutomationDetail>(automationPath())).data;
    const byId = new Map(detail.occurrences.map((item) => [item.occurrence.id, item]));
    expect(byId.get(admitted!.id)!.occurrence.admission).toMatchObject({ state: 'admitted', runId });
    expect(byId.get('O-orphan')!.occurrence.admission).toMatchObject({
      state: 'refused',
      code: 'interrupted_before_start',
    });
    // The newest occurrence was interrupted: that needs a person, not a quiet "manual".
    expect(detail.automation.status.label).toBe('needs-investigation');
    // Nothing was re-admitted silently: still one run, one Task.
    const state = (await request(`/projects/${projectId}/state`)).data;
    expect(state.tasks).toHaveLength(1);
    // A second restart changes nothing: a refused occurrence is never revived.
    await stop();
    await launch();
    const again = (await request<AutomationDetail>(automationPath())).data;
    expect(again.occurrences.map((item) => item.occurrence)).toEqual(
      detail.occurrences.map((item) => item.occurrence),
    );
  });
});
