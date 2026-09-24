/**
 * Automations Milestone B: bounded recurring execution, through the real host.
 *
 * Every test runs the app with an injected clock and no timer, and drives the
 * scheduler's passes itself, so "the computer was off for three days" is a
 * restart with the clock moved, not a wait. Setup is the one the Milestone A
 * route tests use. Every company, project and file here is invented.
 *
 * Acceptance (specification section 12, Milestone B): the job starts at its
 * interpreted time without a person pressing Run, or visibly records why it
 * could not; restart, sleep, DST, duplicate dispatch, pause races, stale
 * source, expired grant and exhausted budget behave as specified.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { AutomationService } from '../server/automations.js';
import type { AutomationScheduler } from '../server/automation-scheduler.js';
import { WEEKLY_BRIEF_BUDGET } from '../server/harness/capabilities/weekly-brief.js';
import type { Store } from '../server/store.js';
import type {
  AttentionView,
  AutomationDetail,
  AutomationList,
  AutomationView,
  ScheduleChangeResult,
  ScheduleTrigger,
  TriggerOccurrence,
} from '../shared/automations.js';
import type { AutomationSchedule } from '../shared/automation-schedule.js';
import type { Person, WorkspaceView } from '../shared/workspaces.js';

let server: Server | undefined;
let store: Store;
let automations: AutomationService;
let scheduler: AutomationScheduler;
let root = '';
let url = '';
let clock = Date.parse('2026-09-28T11:50:00Z'); // Monday 7:50 a.m. in New York
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
    automationClock: () => clock,
    automationTickMs: null,
  });
  store = app.locals.store as Store;
  automations = app.locals.automations as AutomationService;
  scheduler = app.locals.automationScheduler as AutomationScheduler;
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
let firstPerson: Person;
async function restartAs(person: Person) {
  await stop();
  await fs.writeFile(identityPath(), JSON.stringify(person));
  await launch();
}
const otherPerson = (name: string): Person => ({ ...firstPerson, id: `person_${name}`, name });

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
    'first-run': 'weekly',
  };
  await request(`${base()}/setup/start`, 'POST', {});
  let view = (await request<{ step: string; digest: string; state: string }>(`${base()}/setup`)).data;
  for (let guard = 0; guard < 20 && view.step !== 'review'; guard += 1)
    view = (
      await request<typeof view>(`${base()}/setup/answer`, 'POST', {
        questionId: view.step,
        value: canned[view.step] ?? null,
        unknown: canned[view.step] === undefined,
        expectedDigest: view.digest,
      })
    ).data;
  expect(view.state).toBe('proposal-ready');
}

async function activate(activationId: string) {
  const compiled = await request<{ staged: { revision: number }; expectedActiveRevision: number | null }>(
    `${base()}/configuration/compile`,
    'POST',
    {},
  );
  expect(compiled.status).toBe(200);
  const activated = await request<{ active: { proposal: { contextScopes: { selection: string[] }[] } } }>(
    `${base()}/configuration/activate`,
    'POST',
    {
      revision: compiled.data.staged.revision,
      expectedActiveRevision: compiled.data.expectedActiveRevision,
      activationId,
    },
  );
  expect(activated.status).toBe(200);
  return activated.data.active.proposal.contextScopes.flatMap((item) => item.selection);
}

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
  selection = await activate('automations-b-1');
  for (const name of selection) {
    await fs.mkdir(path.dirname(path.join(folder(), name)), { recursive: true });
    await fs.writeFile(path.join(folder(), name), '- Two cabinets fitted on Tuesday.\n', 'utf8');
  }
  expect((await request(`${base()}/output`, 'POST', { projectId })).status).toBe(200);
}

const MONDAY_8_NY: AutomationSchedule = {
  cadence: 'weekly',
  weekday: 1,
  time: '08:00',
  timezone: 'America/New_York',
};
const DAILY_8_NY: AutomationSchedule = { ...MONDAY_8_NY, cadence: 'daily', weekday: null };

const detail = async () => (await request<AutomationDetail>(automationPath())).data;
const view = async (): Promise<AutomationView> =>
  (await request<AutomationList>(`${base()}/automations`)).data.automations[0]!;

async function change(action: string, extra: Record<string, unknown> = {}) {
  const generation = (await detail()).automation.schedule.generation;
  return request<ScheduleChangeResult>(`${automationPath()}/schedule`, 'POST', {
    action,
    expectedGeneration: generation,
    ...extra,
  });
}
async function turnOn(schedule: AutomationSchedule = MONDAY_8_NY, catchUpMinutes?: number) {
  const edited = await change('edit', { schedule, ...(catchUpMinutes === undefined ? {} : { catchUpMinutes }) });
  expect(edited.status, JSON.stringify(edited.data)).toBe(200);
  const enabled = await change('enable');
  expect(enabled.status, JSON.stringify(enabled.data)).toBe(200);
  return enabled.data;
}

const scheduled = async () =>
  (await detail()).occurrences
    .map((item) => item.occurrence)
    .filter((item) => item.trigger.kind === 'schedule')
    .reverse();
const slotOf = (occurrence: TriggerOccurrence) => (occurrence.trigger as ScheduleTrigger).slot;

async function settle(occurrence: TriggerOccurrence) {
  await automations.settled(occurrence);
}

async function tasks() {
  return (await request<{ tasks: unknown[] }>(`/projects/${projectId}/state`)).data.tasks.length;
}

async function historyOf(kind: string) {
  const state = (await request<{ history: { kind: string; sentence: string; actor: string }[] }>(
    `/projects/${projectId}/state`,
  )).data;
  return state.history.filter((entry) => entry.kind === kind);
}

beforeEach(async () => {
  clock = Date.parse('2026-09-28T11:50:00Z');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-automations-b-'));
  await launch();
  firstPerson = JSON.parse(await fs.readFile(identityPath(), 'utf8')) as Person;
  await seed();
});

afterEach(async () => {
  await stop();
  await fs.rm(root, { recursive: true, force: true });
});

describe('turning a schedule on is an explicit, recorded act (A01)', () => {
  test('a recorded weekly answer never runs, and nothing starts until an owner turns a schedule on', async () => {
    const before = await view();
    expect(before.status.text).toBe('Manual — not scheduled');
    expect(before.scheduleRecorded).toMatch(/recorded but stays inactive/);
    expect(before.schedule.state).toBe('off');
    clock = Date.parse('2026-09-28T12:00:30Z');
    await scheduler.tick();
    expect(await scheduled()).toEqual([]);
    // A saved schedule that is not turned on is still not a schedule.
    expect((await change('edit', { schedule: MONDAY_8_NY })).status).toBe(200);
    clock = Date.parse('2026-10-05T12:00:30Z');
    await scheduler.tick();
    expect(await scheduled()).toEqual([]);
    const saved = await view();
    expect(saved.status.text).toBe('Manual — not scheduled');
    expect(saved.schedule.text).toBe('Every Monday at 8:00 a.m. America/New_York');
    expect((await request<AutomationList>(`${base()}/automations`)).data.summary.scheduled).toBe(0);
  });

  test('turning on records who, when, the setup revision and this computer, and History says so', async () => {
    const result = await turnOn();
    expect(result.act).toMatchObject({ kind: 'enabled', by: firstPerson.id, revision: 1 });
    const shown = result.automation;
    expect(shown.schedule.state).toBe('enabled');
    expect(shown.status.text).toBe('Scheduled');
    expect(shown.trigger).toEqual({ kind: 'schedule', text: 'Every Monday at 8:00 a.m. America/New_York' });
    expect(shown.schedule.next.map((slot) => slot.at)).toEqual([
      '2026-09-28T12:00:00.000Z',
      '2026-10-05T12:00:00.000Z',
      '2026-10-12T12:00:00.000Z',
    ]);
    expect(shown.schedule.next[0]!.text).toBe('Mon 28 Sep 2026, 8:00 a.m.');
    expect(shown.schedule.host.here).toBe(true);
    expect(shown.schedule.host.lastSeenAt).toBe('2026-09-28T11:50:00.000Z');
    expect((await request<AutomationList>(`${base()}/automations`)).data.summary.scheduled).toBe(1);
    const entries = await historyOf('automation');
    expect(entries.map((entry) => entry.sentence)).toEqual([
      'You changed the weekly brief’s schedule to Every Monday at 8:00 a.m. America/New_York (revision 1).',
      'You turned on the weekly brief’s schedule: Every Monday at 8:00 a.m. America/New_York. It starts on its own on this computer.',
    ]);
    expect(entries.every((entry) => entry.actor === 'you')).toBe(true);
  });

  test('a change sent against an older read is refused (A24), and a bad schedule never saves', async () => {
    expect((await change('edit', { schedule: MONDAY_8_NY })).status).toBe(200);
    const stale = await request(`${automationPath()}/schedule`, 'POST', {
      action: 'enable',
      expectedGeneration: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.data.code).toBe('automation_definition_conflict');
    const offset = await change('edit', { schedule: { ...MONDAY_8_NY, timezone: '-05:00' } });
    expect(offset.status).toBe(400);
    const interval = await change('edit', { schedule: { ...MONDAY_8_NY, every: '24h' } });
    expect(interval.status).toBe(400);
    expect((await detail()).automation.schedule.current?.revision).toBe(1);
  });

  test('a member who is not an owner or admin cannot change the schedule', async () => {
    const invitation = await request<{ code: string }>(`${base()}/invitations`, 'POST', { role: 'member' });
    await restartAs(otherPerson('member'));
    expect((await request('/workspace/organizations/join', 'POST', { code: invitation.data.code })).status).toBe(200);
    const shown = await view();
    expect(shown.schedule.mayControl).toBe(false);
    const refused = await request(`${automationPath()}/schedule`, 'POST', {
      action: 'edit',
      expectedGeneration: 0,
      schedule: MONDAY_8_NY,
    });
    expect(refused.status).toBe(403);
  });
});

describe('a due slot starts on its own through the same admission (OPS-08)', () => {
  test('at its interpreted time, once, with an occurrence, a run, a Task and a draft', async () => {
    await turnOn();
    clock = Date.parse('2026-09-28T11:59:59Z');
    await scheduler.tick();
    expect(await scheduled()).toEqual([]);
    clock = Date.parse('2026-09-28T12:00:10Z');
    const pass = await scheduler.tick();
    expect(pass.admitted).toBe(1);
    const [occurrence] = await scheduled();
    expect(occurrence!.trigger).toMatchObject({
      kind: 'schedule',
      slot: '2026-09-28T12:00:00.000Z',
      local: '2026-09-28 08:00',
      timezone: 'America/New_York',
      definitionRevision: 1,
      enabledBy: firstPerson.id,
      late: false,
      commandId: 'schedule:1:20260928T120000Z',
    });
    expect(occurrence!.admission.state).toBe('admitted');
    await settle(occurrence!);
    const shown = (await detail()).occurrences[0]!;
    expect(shown.resultText).toBe('Draft saved for review');
    expect(shown.slotText).toBe('Mon 28 Sep 2026, 8:00 a.m.');
    expect(await tasks()).toBe(1);
    expect((await historyOf('weekly-brief')).length).toBe(1);
    expect((await historyOf('automation')).at(-1)!.sentence).toBe(
      'Diomedes started the weekly brief on schedule for Mon 28 Sep 2026, 8:00 a.m..',
    );
    // A later pass in the same minute, or the next, starts nothing more.
    clock = Date.parse('2026-09-28T12:01:10Z');
    expect((await scheduler.tick()).admitted).toBe(0);
    expect(await scheduled()).toHaveLength(1);
    expect((await view()).status.text).toBe('Scheduled');
  });

  test('a duplicate dispatch of one slot is one run and a receipt (A05)', async () => {
    await turnOn();
    clock = Date.parse('2026-09-28T12:00:05Z');
    const slot = {
      at: '2026-09-28T12:00:00.000Z',
      ms: Date.parse('2026-09-28T12:00:00Z'),
      local: '2026-09-28 08:00',
      shifted: null,
    };
    const [first, second] = await Promise.all([
      store.locked(() => automations.admitScheduled(organizationId, slot, false)),
      store.locked(() => automations.admitScheduled(organizationId, slot, false)),
    ]);
    expect(first!.occurrence.id).toBe(second!.occurrence.id);
    expect([first!.duplicate, second!.duplicate].sort()).toEqual([false, true]);
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect(await scheduled()).toHaveLength(1);
    await settle(first!.occurrence);
    expect(await tasks()).toBe(1);
  });

  test('a nonexistent local time runs when the clocks jump; a repeated one runs once (A04)', async () => {
    clock = Date.parse('2026-03-07T12:00:00Z');
    await turnOn({ ...DAILY_8_NY, time: '02:30' });
    clock = Date.parse('2026-03-08T07:00:20Z'); // 3:00:20 a.m. EDT: 2:30 never happened
    expect((await scheduler.tick()).admitted).toBe(1);
    const [gap] = await scheduled();
    expect(gap!.trigger).toMatchObject({ slot: '2026-03-08T07:00:00.000Z', local: '2026-03-08 02:30', shifted: 'gap' });
    await settle(gap!);
    expect((await detail()).occurrences[0]!.slotText).toBe('Sun 8 Mar 2026, 3:00 a.m. (moved by the clock change)');

    // Autumn: 1:30 happens twice on 1 November. It runs at the first one only.
    await stop();
    clock = Date.parse('2026-10-31T12:00:00Z');
    await launch();
    expect((await change('edit', { schedule: { ...DAILY_8_NY, time: '01:30' } })).status).toBe(200);
    clock = Date.parse('2026-11-01T05:30:10Z');
    await scheduler.tick();
    clock = Date.parse('2026-11-01T06:30:10Z'); // the second 1:30
    await scheduler.tick();
    const autumn = (await scheduled()).filter((item) => item.trigger.kind === 'schedule' && (item.trigger as ScheduleTrigger).local.startsWith('2026-11-01'));
    expect(autumn.map(slotOf)).toEqual(['2026-11-01T05:30:00.000Z']);
  });
});

describe('missed work and this computer (OPS-09)', () => {
  test('slots missed while the computer was off are recorded; only the latest catches up, within its window (A02)', async () => {
    await turnOn(DAILY_8_NY);
    clock = Date.parse('2026-09-28T12:00:10Z');
    await scheduler.tick();
    await settle((await scheduled())[0]!);
    await stop();
    // Off for three days; back at 9:10 a.m. on Thursday, inside the two-hour window.
    clock = Date.parse('2026-10-01T13:10:00Z');
    await launch();
    const after = await scheduled();
    expect(after.map((item) => [slotOf(item), item.admission.state])).toEqual([
      ['2026-09-28T12:00:00.000Z', 'admitted'],
      ['2026-09-29T12:00:00.000Z', 'refused'],
      ['2026-09-30T12:00:00.000Z', 'refused'],
      ['2026-10-01T12:00:00.000Z', 'admitted'],
    ]);
    expect((after[3]!.trigger as ScheduleTrigger).late).toBe(true);
    await settle(after[3]!);
    const shown = await detail();
    const missed = shown.occurrences.filter((item) => item.note === 'Missed — computer was off');
    expect(missed).toHaveLength(2);
    expect(missed[0]!.occurrence.admission).toMatchObject({ code: 'missed_host_off' });
    expect((missed[0]!.occurrence.admission as { reason: string }).reason).toMatch(
      /was not running on this computer at .*last seen Mon 28 Sep 2026, 8:00 a\.m\./,
    );
    // One attention item for the outage, not one per day (A31). A clean
    // catch-up does not make the days that never ran disappear.
    clock += 30_000;
    await scheduler.tick();
    const attention = (await view()).attention;
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ kind: 'missed', count: 2 });
    expect(await tasks()).toBe(2);
  });

  test('back after the window: nothing runs, a backlog is never run, and one item says so', async () => {
    await turnOn(DAILY_8_NY);
    await stop();
    clock = Date.parse('2026-10-01T15:30:00Z'); // 11:30 a.m.: past the two-hour window
    await launch();
    const after = await scheduled();
    expect(after.every((item) => item.admission.state === 'refused')).toBe(true);
    expect(after.map(slotOf)).toEqual([
      '2026-09-28T12:00:00.000Z',
      '2026-09-29T12:00:00.000Z',
      '2026-09-30T12:00:00.000Z',
      '2026-10-01T12:00:00.000Z',
    ]);
    expect(await tasks()).toBe(0);
    let shown = await view();
    expect(shown.attention).toHaveLength(1);
    expect(shown.attention[0]).toMatchObject({ kind: 'missed', count: 4, title: 'Missed while this computer was off' });
    expect(shown.lastResult?.text).toBe('Missed — computer was off');
    // A second outage while the first is unread joins it rather than repeating.
    await stop();
    clock = Date.parse('2026-10-03T16:00:00Z');
    await launch();
    shown = await view();
    expect(shown.attention).toHaveLength(1);
    expect(shown.attention[0]!.count).toBe(6);
    expect((await historyOf('automation')).filter((entry) => /missed run/.test(entry.sentence))).toHaveLength(1);
    // The project's Needs you carries the same one item, and seeing it clears it.
    const needs = await request<{ items: AttentionView[] }>(`/projects/${projectId}/automation-attention`);
    expect(needs.data.items.map((item) => item.id)).toEqual([shown.attention[0]!.id]);
    const seen = await request<AutomationView>(
      `${automationPath()}/attention/${shown.attention[0]!.id}/seen`,
      'POST',
      {},
    );
    expect(seen.status).toBe(200);
    expect(seen.data.attention).toEqual([]);
    expect((await request<{ items: AttentionView[] }>(`/projects/${projectId}/automation-attention`)).data.items).toEqual([]);
  });

  test('the last-known heartbeat is shown; a stale one reads as unknown, never as a live outage (A03)', async () => {
    await turnOn();
    let shown = await view();
    expect(shown.schedule.host).toMatchObject({ state: 'available', lastSeenAt: '2026-09-28T11:50:00.000Z' });
    clock = Date.parse('2026-09-28T11:58:00Z'); // eight minutes with no pass
    shown = await view();
    expect(shown.schedule.host.state).toBe('unknown');
    expect(shown.status.text).toBe('Waiting for computer');
    expect(shown.schedule.host.lastSeenAt).toBe('2026-09-28T11:50:00.000Z');
    expect((await request<AutomationList>(`${base()}/automations`)).data.summary.scheduled).toBe(0);
    await scheduler.tick();
    shown = await view();
    expect(shown.status.text).toBe('Scheduled');
    expect(shown.schedule.host.lastSeenAt).toBe('2026-09-28T11:58:00.000Z');
  });

  test('a schedule assigned to another computer never runs here (A08: no takeover)', async () => {
    await turnOn();
    await stop();
    await fs.rm(path.join(root, 'data', 'workspaces', 'automation-host.json'));
    clock = Date.parse('2026-09-28T12:00:10Z');
    await launch();
    const [occurrence] = await scheduled();
    expect(occurrence!.admission).toMatchObject({ state: 'refused', code: 'assigned_to_another_computer' });
    const shown = await view();
    expect(shown.schedule.host.here).toBe(false);
    expect(await tasks()).toBe(0);
  });
});

describe('pause, resume, turn off, and restart (A10, A12)', () => {
  test('a pause that lands before the slot suppresses it and says so; resume never revives it', async () => {
    await turnOn(DAILY_8_NY);
    const paused = await change('pause', { reason: 'Stocktake week' });
    expect(paused.status).toBe(200);
    expect(paused.data.act).toMatchObject({ kind: 'paused', reason: 'Stocktake week', inFlight: null });
    expect(paused.data.automation.status.text).toBe('Paused');
    clock = Date.parse('2026-09-28T12:00:10Z');
    await scheduler.tick();
    let [skipped] = await scheduled();
    expect(skipped!.admission).toMatchObject({ state: 'refused', code: 'schedule_paused' });
    expect((await detail()).occurrences[0]!.note).toBe('Skipped — paused');
    // A paused slot raises nothing: the person chose it.
    expect((await view()).attention).toEqual([]);
    clock = Date.parse('2026-09-28T13:00:00Z');
    expect((await change('resume')).status).toBe(200);
    await scheduler.tick();
    expect((await scheduled()).map((item) => item.admission.state)).toEqual(['refused']);
    clock = Date.parse('2026-09-29T12:00:05Z');
    await scheduler.tick();
    const after = await scheduled();
    expect(after.map((item) => [slotOf(item), item.admission.state])).toEqual([
      ['2026-09-28T12:00:00.000Z', 'refused'],
      ['2026-09-29T12:00:00.000Z', 'admitted'],
    ]);
    await settle(after[1]!);
  });

  test('a slot admitted before the pause keeps its run; the pause is recorded after it (A10)', async () => {
    await turnOn(DAILY_8_NY);
    clock = Date.parse('2026-09-28T12:00:10Z');
    // Both reach the store lock; the pass is first in line, so it wins the boundary.
    const [pass, paused] = await Promise.all([scheduler.tick(), change('pause', { reason: 'Racing' })]);
    expect(pass.admitted).toBe(1);
    expect(paused.status).toBe(200);
    const [occurrence] = await scheduled();
    expect(occurrence!.admission.state).toBe('admitted');
    const run = await automations.settled(occurrence!);
    expect(run?.state).toBe('completed');
    const acts = (await detail()).automation.schedule.acts;
    expect(acts[0]!.kind).toBe('paused');
    expect(acts[0]!.at >= occurrence!.observedAt).toBe(true);
  });

  test('pause and turn-off survive restarts and are never revived by one (A12)', async () => {
    await turnOn(DAILY_8_NY);
    await change('pause', { reason: 'Closed for the holiday' });
    await stop();
    clock = Date.parse('2026-09-30T12:00:10Z');
    await launch();
    let shown = await view();
    expect(shown.schedule.state).toBe('paused');
    expect((await scheduled()).every((item) => item.admission.state === 'refused')).toBe(true);
    expect(await tasks()).toBe(0);
    await change('turn-off');
    await stop();
    clock = Date.parse('2026-10-02T12:00:10Z');
    await launch();
    shown = await view();
    expect(shown.schedule.state).toBe('off');
    expect(shown.status.text).toBe('Manual — not scheduled');
    const count = (await scheduled()).length;
    await scheduler.tick();
    expect((await scheduled()).length).toBe(count);
    expect(await tasks()).toBe(0);
  });
});

describe('overlap, revalidation and budget at fire time', () => {
  test('a slot while the previous run is still active is skipped and recorded (A09)', async () => {
    await turnOn(DAILY_8_NY);
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
    clock = Date.parse('2026-09-28T12:00:10Z');
    await scheduler.tick();
    const [skipped] = await scheduled();
    expect(skipped!.admission).toMatchObject({ state: 'refused', code: 'project_busy' });
    const shown = await detail();
    expect(shown.occurrences[0]!.note).toBe('Skipped — previous run still active');
    expect(shown.automation.attention.map((item) => item.kind)).toEqual(['skipped']);
  });

  test('a missing source stops a scheduled run as Waiting for data, raised once however often it is read (A17, A31)', async () => {
    await turnOn(DAILY_8_NY);
    await fs.rm(path.join(folder(), selection[0]!));
    clock = Date.parse('2026-09-28T12:00:10Z');
    await scheduler.tick();
    const [occurrence] = await scheduled();
    await settle(occurrence!);
    for (let pass = 0; pass < 3; pass++) {
      clock += 30_000;
      await scheduler.tick();
    }
    const shown = await view();
    expect(shown.status.text).toBe('Waiting for data');
    expect(shown.attention).toHaveLength(1);
    expect(shown.attention[0]).toMatchObject({ kind: 'failed', title: 'A scheduled run is waiting for data' });
    expect((await historyOf('weekly-brief')).length).toBe(0);
    // The next day, with the file back, a clean run clears it.
    await fs.writeFile(path.join(folder(), selection[0]!), '- Back again.\n', 'utf8');
    clock = Date.parse('2026-09-29T12:00:10Z');
    await scheduler.tick();
    await settle((await scheduled()).at(-1)!);
    clock += 30_000;
    await scheduler.tick();
    expect((await view()).attention).toEqual([]);
  });

  test('a setup activated after the schedule was turned on blocks it until an owner turns it on again (A13)', async () => {
    await turnOn(DAILY_8_NY);
    const revision = (await detail()).automation.configuration!.revision;
    await activate('automations-b-2');
    const changed = (await detail()).automation.configuration!.revision;
    expect(changed).toBeGreaterThan(revision);
    clock = Date.parse('2026-09-28T12:00:10Z');
    await scheduler.tick();
    const [blocked] = await scheduled();
    expect(blocked!.admission).toMatchObject({ state: 'refused', code: 'configuration_changed' });
    let shown = await view();
    expect(shown.status.label).toBe('needs-investigation');
    expect(shown.status.reason).toMatch(/setup changed from version/);
    expect(shown.attention.map((item) => item.kind)).toEqual(['blocked']);
    // Turning it on again is an explicit act with the new setup; the block is addressed.
    await change('turn-off');
    await change('enable');
    shown = await view();
    expect(shown.status.text).toBe('Scheduled');
    expect(shown.attention).toEqual([]);
  });

  test('a removed member is never impersonated: their schedule blocks with the reason (A15)', async () => {
    const invitation = await request<{ code: string }>(`${base()}/invitations`, 'POST', { role: 'admin' });
    const admin = otherPerson('admin');
    await restartAs(admin);
    expect((await request('/workspace/organizations/join', 'POST', { code: invitation.data.code })).status).toBe(200);
    await turnOn(DAILY_8_NY);
    await restartAs(firstPerson);
    expect(
      (await request(`${base()}/members/${admin.id}/revoke`, 'POST', { reason: 'Left the business' })).status,
    ).toBe(200);
    clock = Date.parse('2026-09-28T12:00:10Z');
    await scheduler.tick();
    const [blocked] = await scheduled();
    expect(blocked!.admission).toMatchObject({ state: 'refused', code: 'schedule_authority_lost' });
    expect((blocked!.admission as { reason: string }).reason).toMatch(/no longer a member/);
    expect(await tasks()).toBe(0);
  });

  test('someone else signed in on this computer does not run another person’s schedule', async () => {
    const invitation = await request<{ code: string }>(`${base()}/invitations`, 'POST', { role: 'member' });
    await turnOn(DAILY_8_NY);
    await restartAs(otherPerson('member'));
    expect((await request('/workspace/organizations/join', 'POST', { code: invitation.data.code })).status).toBe(200);
    clock = Date.parse('2026-09-28T12:00:10Z');
    await scheduler.tick();
    const [blocked] = await scheduled();
    expect(blocked!.admission).toMatchObject({ state: 'refused', code: 'schedule_owner_not_signed_in' });
    expect(await tasks()).toBe(0);
  });

  test('without a hard spending bound nothing starts on a schedule; an exhausted budget stops before writing (A22)', async () => {
    await turnOn(DAILY_8_NY);
    const saved = { ...WEEKLY_BRIEF_BUDGET };
    const budget = WEEKLY_BRIEF_BUDGET as { -readonly [K in keyof typeof saved]: (typeof saved)[K] };
    try {
      budget.modelCalls = 1;
      clock = Date.parse('2026-09-28T12:00:10Z');
      await scheduler.tick();
      const [blocked] = await scheduled();
      expect(blocked!.admission).toMatchObject({ state: 'refused', code: 'schedule_budget_unbounded' });
      budget.modelCalls = 0;
      budget.units = 2;
      budget.toolCalls = 2;
      clock = Date.parse('2026-09-29T12:00:10Z');
      await scheduler.tick();
      const exhausted = (await scheduled()).at(-1)!;
      expect(exhausted.admission.state).toBe('admitted');
      const run = await automations.settled(exhausted);
      expect(run?.state).not.toBe('completed');
      expect(run?.used.units).toBeLessThanOrEqual(2);
      expect(run?.used.modelCalls).toBe(0);
    } finally {
      Object.assign(budget, saved);
    }
    expect((await historyOf('weekly-brief')).length).toBe(0);
  });
});

describe('editing a schedule around its slot (A13, A35)', () => {
  test('an edit after a slot ran never runs that slot again; the new time runs under the new revision', async () => {
    await turnOn(DAILY_8_NY);
    clock = Date.parse('2026-09-28T12:00:10Z');
    await scheduler.tick();
    const [first] = await scheduled();
    await settle(first!);
    // An innocuous edit a minute later (the catch-up window) is revision 2 and makes nothing new.
    clock = Date.parse('2026-09-28T12:01:00Z');
    expect((await change('edit', { schedule: DAILY_8_NY, catchUpMinutes: 60 })).status).toBe(200);
    await scheduler.tick();
    expect(await scheduled()).toHaveLength(1);
    // Moving it to 9:00 the same morning runs 9:00 under revision 3, once.
    expect((await change('edit', { schedule: { ...DAILY_8_NY, time: '09:00' } })).status).toBe(200);
    clock = Date.parse('2026-09-28T13:00:10Z');
    await scheduler.tick();
    const after = await scheduled();
    expect(after.map((item) => [slotOf(item), (item.trigger as ScheduleTrigger).definitionRevision])).toEqual([
      ['2026-09-28T12:00:00.000Z', 1],
      ['2026-09-28T13:00:00.000Z', 3],
    ]);
    // The first occurrence still says it ran under revision 1 (A13).
    expect((first!.trigger as ScheduleTrigger).definitionRevision).toBe(1);
    await settle(after[1]!);
  });

  test('an edit before the slot moves it; the old time never runs', async () => {
    await turnOn(DAILY_8_NY);
    clock = Date.parse('2026-09-28T11:55:00Z');
    expect((await change('edit', { schedule: { ...DAILY_8_NY, time: '08:30' } })).status).toBe(200);
    clock = Date.parse('2026-09-28T12:00:10Z');
    await scheduler.tick();
    expect(await scheduled()).toEqual([]);
    clock = Date.parse('2026-09-28T12:30:10Z');
    await scheduler.tick();
    expect((await scheduled()).map(slotOf)).toEqual(['2026-09-28T12:30:00.000Z']);
    await settle((await scheduled())[0]!);
  });
});
