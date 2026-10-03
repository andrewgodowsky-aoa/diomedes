/**
 * S1 free manual teams on the Board (DIO-175 lane S1, DIO-176): N01 to N08, A01, A03 and A38
 * where they map onto code. The real app over HTTP with a scripted Native Work generator in
 * place of the engines, an Agent gate that fails the test if anything consults it, and a
 * model-API transport that counts every call. Nothing reaches a provider, the account service
 * or a managed route, and none of this proves a live engine accepts these requests.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import type { NativeGenerator } from '../server/native-work.js';
import { TeamService } from '../server/team/service.js';
import type { Store } from '../server/store.js';
import { requestTaskHandoff } from '../server/task-workflow.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { NATIVE_LOOP_ENGINE } from '../shared/native-loop.js';
import {
  MANUAL_CARD_ASSIGN_REFUSED,
  MANUAL_CARD_DELETE_REFUSED,
  MANUAL_CARD_HOLD,
  MANUAL_CARD_PHASE_REFUSED,
  boardStartRoute,
  emptyTaskWorkflow,
  manualCardStart,
  workflowOf,
} from '../shared/task-workflow.js';
import { routeDisplayName } from '../shared/engines.js';
import {
  MANUAL_HANDOFF_LIMITS,
  manualHandoffRequestSchema,
  manualHandoffSchema,
  type ManualHandoff,
} from '../shared/manual-handoff.js';
import type { WorkRowsSnapshot } from '../shared/work-rows.js';
import type { CloudSharingPolicy, ProjectState, Task, TeamMember } from '../shared/types.js';
import { SendConfirmation } from '../client/console/SendConfirmation.js';

type NativeResult = Awaited<ReturnType<NativeGenerator>>;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const proposal = (changes: { path: string; text: string | null; summary: string }[] = []) =>
  ({ text: JSON.stringify({ summary: 'Update the selected work', changes }), model: 'test-model' }) as NativeResult;

let root: string;
let server: Server;
let app: Awaited<ReturnType<typeof createApp>>;
let url: string;
let projectId: string;
let engines: EngineService;
/** What the scripted engines were asked to run on, in order. */
let asked: string[];
/** The model each request asked for. */
let models: (string | null)[];
let answer: (input: Parameters<NativeGenerator>[0]) => Promise<NativeResult>;
/** Every model-API transport call: the managed gateway and every keyed route go through it. */
let transportCalls: number;
let gate: { calls: number; expired: boolean };

async function request<T = any>(route: string, method = 'GET', body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const state = async () => (await request<ProjectState>(`/projects/${projectId}/state`)).data;
const card = async (taskId: string) => (await state()).tasks.find((task) => task.id === taskId)!;
async function until(predicate: (value: ProjectState) => boolean): Promise<ProjectState> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await state();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The project did not reach the expected state.');
}
async function member(name: string, engine: TeamMember['engine'], model?: string): Promise<TeamMember> {
  const created = await request<{ member: TeamMember }>(`/projects/${projectId}/team/members`, 'POST', {
    name,
    role: 'member',
    engine,
    ...(model ? { model } : {}),
  });
  expect(created.status).toBe(200);
  return created.data.member;
}
/** A card a member of the person-run Team puts on the Board (`team_task_create`). */
async function manualCard(creator: TeamMember, subject: string): Promise<Task> {
  const store = app.locals.store as Store;
  const team = new TeamService(store);
  const created = await store.locked(() => team.taskCreateAsMember(projectId, creator, { subject }));
  return card(created.id);
}
const accept = async (task: Task) =>
  request(`/projects/${projectId}/tasks/${task.id}/accept`, 'POST', { expectedRevision: workflowOf(task).revision });
const assign = (taskId: string, assignedTo: unknown) =>
  request(`/projects/${projectId}/tasks/${taskId}`, 'PUT', { assignedTo });
/** The Board's own Start: a versioned Work command (client/work-start.ts). */
let commandSeq = 0;
const start = (taskId: string, route: string, sources: string[] = ['Fall menu.md'], consent = true) =>
  request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: `manual-start-${++commandSeq}`,
    taskId,
    route,
    sources,
    consent,
  });
const ended = (taskId: string) => (value: ProjectState) =>
  value.sessions.some((session) => session.taskId === taskId && ['done', 'stopped', 'failed'].includes(session.state));
async function settle(taskId: string) {
  // An empty proposal changes nothing: the run ends without a decision for the person.
  return until(ended(taskId));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-manual-teams-'));
  asked = [];
  models = [];
  transportCalls = 0;
  gate = { calls: 0, expired: false };
  answer = async () => proposal();
  engines = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  // Stands in for the account service's Agent check, with the person's plan behind it. S1
  // never consults it, so any call fails the test, whether the plan is current or expired.
  (engines as unknown as { agentGate: unknown }).agentGate = {
    check: async () => {
      gate.calls += 1;
      throw new Error(gate.expired ? 'The plan expired.' : 'S1 must not consult the Agent gate.');
    },
  };
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    stepMs: 20,
    engineService: engines,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: (async () => {
      transportCalls += 1;
      throw new Error('S1 must not reach a model-API route or the managed gateway.');
    }) as typeof fetch,
    nativeGenerator: vi.fn((input: Parameters<NativeGenerator>[0]) => {
      asked.push(String(input.engine));
      models.push(input.model ?? null);
      return answer(input);
    }),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await request('/projects/sample', 'POST', {})).data.id;
  await request('/settings', 'PUT', { services: { codex: true, 'claude-code': true } });
  const sharing = await request(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['codex', 'claude-code'],
    documents: ['Fall menu.md', 'Opening notes.txt'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  expect(sharing.status).toBe(200);
});

afterEach(async () => {
  const closingApp = app, closingServer = server, closingRoot = root;
  try {
    await closingApp?.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => closingServer.close((error) => (error ? reject(error) : resolve())));
  }
  await fs.rm(closingRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('N01 and N02: the person assigns a card from the Board', () => {
  test('N01: assignedTo is saved, History says so, a repeat changes nothing, and null clears it', async () => {
    const astra = await member('Astra', 'codex');
    const task = (await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Price the fall menu' })).data;
    const before = (await state()).history.length;

    const assigned = await assign(task.id, astra.slotId);
    expect(assigned.status).toBe(200);
    expect(assigned.data.assignedTo).toBe(astra.slotId);
    let current = await state();
    expect(current.tasks.find((item) => item.id === task.id)!.assignedTo).toBe(astra.slotId);
    expect(current.history.slice(before).map((entry) => [entry.kind, entry.sentence, entry.actor])).toEqual([
      ['task-assigned', 'You assigned Price the fall menu to Astra', 'you'],
    ]);

    // The same assignment again changes nothing and writes nothing.
    expect((await assign(task.id, astra.slotId)).status).toBe(200);
    expect((await state()).history.length).toBe(before + 1);

    expect((await assign(task.id, null)).status).toBe(200);
    current = await state();
    expect(current.tasks.find((item) => item.id === task.id)!.assignedTo).toBeNull();
    expect(current.history.at(-1)).toMatchObject({ kind: 'task-assigned', sentence: 'You cleared the assignment of Price the fall menu' });
    expect((await assign(task.id, null)).status).toBe(200);
    expect((await state()).history.length).toBe(before + 2);
  });

  test('N02: an unknown slot is a 400, a stopped member a 409, and either way the task is unchanged', async () => {
    const astra = await member('Astra', 'codex');
    const bram = await member('Bram', 'claude-code', 'opus');
    const task = (await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Write the patio sign' })).data;
    expect((await assign(task.id, astra.slotId)).status).toBe(200);
    expect((await request(`/projects/${projectId}/team/members/${bram.slotId}/stop`, 'POST', {})).status).toBe(200);
    const before = await card(task.id);
    const entries = (await state()).history.length;

    for (const value of ['S-nobody', 'owner', 42, '']) {
      const refused = await request(`/projects/${projectId}/tasks/${task.id}`, 'PUT', { assignedTo: value, name: 'Renamed' });
      expect(refused.status).toBe(400);
      expect(refused.data.error).toBe('Choose a current Team member, or clear the assignment.');
    }
    const removed = await request(`/projects/${projectId}/tasks/${task.id}`, 'PUT', { assignedTo: bram.slotId, name: 'Renamed' });
    expect(removed.status).toBe(409);
    expect(removed.data.error).toBe("Bram was stopped and can't take work. Choose a current member.");

    const after = await card(task.id);
    expect(after).toEqual(before);
    expect((await state()).history.length).toBe(entries);
  });

  test('a running card and an Agent Team assignment refuse a change with a 409; the existing move guard stays', async () => {
    const astra = await member('Astra', 'codex');
    const bram = await member('Bram', 'claude-code', 'opus');
    const task = (await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Draft the newsletter' })).data;
    expect((await assign(task.id, astra.slotId)).status).toBe(200);
    let release!: (value: NativeResult) => void;
    answer = () => new Promise<NativeResult>((resolve) => (release = resolve));
    expect((await start(task.id, 'codex')).status).toBe(200);
    await until((value) => value.sessions.some((session) => session.taskId === task.id && session.state === 'working'));
    const running = await assign(task.id, bram.slotId);
    expect(running.status).toBe(409);
    expect(running.data.error).toBe("Stop this work before you change who it's assigned to.");
    expect((await assign(task.id, null)).status).toBe(409);
    // The same assignment is not a change, so it is not refused.
    expect((await assign(task.id, astra.slotId)).status).toBe(200);
    expect((await request(`/projects/${projectId}/tasks/${task.id}`, 'PUT', { state: 'done' })).status).toBe(409);
    release(proposal());
    await settle(task.id);

    const store = app.locals.store as Store;
    await store.locked(async () => {
      const current = store.state(projectId);
      current.tasks.find((item) => item.id === task.id)!.ownedAssignment = {
        rootTaskId: 'root-task',
        rootRunId: 'root-run',
        admissionRef: 'grant-1',
      };
      await store.persist(current);
    });
    const owned = await assign(task.id, bram.slotId);
    expect(owned.status).toBe(409);
    expect(owned.data.error).toBe('An Agent Team run owns this assignment. It changes only through that run.');
    expect((await card(task.id)).assignedTo).toBe(astra.slotId);
  });
});

describe('N03 and N04: a manual card runs on its member and moves only when the person moves it', () => {
  test('a card from a person-run Team member is a manual card; an old card reads exactly as before', async () => {
    const astra = await member('Astra', 'codex');
    const task = await manualCard(astra, 'Check the supplier quotes');
    expect(task.workflow).toEqual({ ...emptyTaskWorkflow(), inbox: true, style: 'external-proposal', manual: true });
    expect(task.assignedTo).toBe(astra.slotId);
    expect(workflowOf(task)).toMatchObject({ style: 'external-proposal', manual: true });
    const old = { workflow: { ...emptyTaskWorkflow(), inbox: true } };
    expect(workflowOf(old)).toEqual(old.workflow);
    expect(Object.keys(workflowOf(old))).not.toContain('manual');
    expect(Object.keys(workflowOf(old))).not.toContain('style');
  });

  test('N03: a card member A made, assigned to member B, runs through Native Work on B’s engine', async () => {
    const astra = await member('Astra', 'codex');
    const bram = await member('Bram', 'claude-code', 'opus');
    const task = await manualCard(astra, 'Rewrite the fall menu');
    // Proposed cards wait in the Inbox for the person.
    expect((await start(task.id, 'codex')).status).toBe(409);
    expect((await accept(task)).status).toBe(200);
    expect((await assign(task.id, bram.slotId)).status).toBe(200);

    // The consent the person gives names the engine: a start on A’s engine is refused by name.
    const wrong = await start(task.id, 'codex');
    expect(wrong.status).toBe(409);
    expect(wrong.data.error).toBe('Bram works on this card through Claude Code. Start it on Claude Code.');
    const unconfirmed = await start(task.id, 'claude-code', ['Fall menu.md'], false);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.data.consentRequired).toBe(true);
    expect(asked).toEqual([]);

    // The Board's versioned start is not refused as a team helper command: no team options.
    const started = await start(task.id, 'claude-code');
    expect(started.status).toBe(200);
    expect(started.data.route).toBe('claude-code');
    expect(started.data.engine.name).not.toBe(NATIVE_LOOP_ENGINE);
    expect(started.data.slotId).toBeUndefined();
    await settle(task.id);
    expect(asked).toEqual(['claude-code']);
    // B's own recorded model, as a member's wake would ask for it.
    expect(models).toEqual(['opus']);
    expect(gate.calls).toBe(0);
    expect(transportCalls).toBe(0);

    // What the Board's send dialog says for this card: B's engine and the documents.
    const current = await state();
    const route = boardStartRoute(current.tasks.find((item) => item.id === task.id)!, current.team!.members, 'codex');
    expect(route).toBe('claude-code');
    const markup = renderToStaticMarkup(
      createElement(SendConfirmation, {
        kind: 'task',
        instruction: 'Rewrite the fall menu',
        route,
        sources: ['Fall menu.md'],
        mode: 'build',
        onSend: () => undefined,
        onClose: () => undefined,
      } as never),
    );
    expect(markup).toContain('Send this instruction to Claude Code');
    expect(markup).toContain('Fall menu.md');
  });

  test('a manual card on a member who cannot run it is refused by name before anything is sent', async () => {
    const astra = await member('Astra', 'codex');
    const task = await manualCard(astra, 'Tidy the notes');
    expect((await accept(task)).status).toBe(200);
    expect((await assign(task.id, null)).status).toBe(200);
    const unassigned = await start(task.id, 'codex');
    expect(unassigned.status).toBe(409);
    expect(unassigned.data.error).toBe("Assign this card to a Team member before you start it. A manual card runs on its member's engine.");
    const members: TeamMember[] = [{ ...astra, engine: 'openrouter' }];
    expect(manualCardStart({ assignedTo: astra.slotId }, members, routeDisplayName)).toEqual({
      ok: false,
      reason: 'Astra works through OpenRouter. A manual card runs on ChatGPT or Claude Code, so assign it to a member on one of those.',
    });
    expect(asked).toEqual([]);
  });

  test('N04: no loop and no agent moves its phase; the person does, and a run leaves it where it was', async () => {
    const astra = await member('Astra', 'codex');
    const task = await manualCard(astra, 'Plan the tasting night');
    expect((await accept(task)).status).toBe(200);
    // The loop refuses it outright, so no loop phase gate can reach it.
    const loop = await request(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1,
      commandId: 'loop-manual-1',
      taskId: task.id,
      goal: 'Plan the tasting night',
      route: 'native-fixture',
    });
    expect(loop.status).toBe(409);
    expect(loop.data.code).toBe('manual_card_loop');
    // The trusted agent path refuses it as well.
    const store = app.locals.store as Store;
    await expect(
      store.locked(async () => {
        const current = store.state(projectId);
        requestTaskHandoff(store, current, current.tasks.find((item) => item.id === task.id)!, 'build', 'diomedes');
      }),
    ).rejects.toThrow(MANUAL_CARD_PHASE_REFUSED);

    // A run on the member's engine finishes and the phase stays.
    expect((await start(task.id, 'codex')).status).toBe(200);
    await settle(task.id);
    expect(workflowOf(await card(task.id)).phase).toBe('plan');

    // The person moves it: asked, then approved, both by the person.
    let current = await card(task.id);
    const asked = await request(`/projects/${projectId}/tasks/${task.id}/handoff`, 'POST', {
      expectedRevision: workflowOf(current).revision,
      phase: 'build',
      reason: 'The plan is ready.',
    });
    expect(asked.status).toBe(200);
    current = await card(task.id);
    const approved = await request(`/projects/${projectId}/tasks/${task.id}/approve-phase`, 'POST', {
      expectedRevision: workflowOf(current).revision,
    });
    expect(approved.status).toBe(200);
    current = await card(task.id);
    expect(current.workflow).toMatchObject({ phase: 'build', manual: true, style: 'external-proposal' });
    expect(current.workflow!.handoffs.map((item) => item.by)).toEqual(['you']);
  });

  test('the Ready queue holds a manual card for the person', async () => {
    const astra = await member('Astra', 'codex');
    const task = await manualCard(astra, 'Count the chairs');
    expect((await accept(task)).status).toBe(200);
    expect((await request(`/projects/${projectId}/ready-queue`, 'PUT', { autoStart: true })).status).toBe(200);
    const queue = (await request(`/projects/${projectId}/ready-queue`)).data as { items: { taskId: string; detail: string; why: string }[] };
    expect(queue.items.find((entry) => entry.taskId === task.id)).toMatchObject({ why: 'held', detail: MANUAL_CARD_HOLD });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await state()).sessions).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('N05 and N08: a manual hand-off reaches the next card', () => {
  async function pair() {
    const astra = await member('Astra', 'codex');
    const bram = await member('Bram', 'claude-code', 'opus');
    const first = await manualCard(astra, 'Draft the menu');
    const second = await manualCard(astra, 'Proofread the menu');
    expect((await accept(first)).status).toBe(200);
    expect((await accept(second)).status).toBe(200);
    expect((await assign(second.id, bram.slotId)).status).toBe(200);
    return { astra, bram, first, second };
  }

  test('N08: outcome, changed files, checks and open issues round-trip to the next card, with History', async () => {
    const { astra, bram, first, second } = await pair();
    const before = (await state()).history.length;
    const created = await request(`/projects/${projectId}/handoffs`, 'POST', {
      fromTaskId: first.id,
      toTaskId: second.id,
      fromSlot: astra.slotId,
      toSlot: bram.slotId,
      outcome: 'The menu draft is done. Prices are from the June quotes.',
      changedFiles: ['fall menu.md'],
      checks: ['Read it aloud once'],
      openIssues: ['The soup price is a guess'],
    });
    expect(created.status).toBe(200);
    expect(manualHandoffSchema.safeParse(created.data).success).toBe(true);
    expect(created.data).toMatchObject({
      fromTaskId: first.id,
      toTaskId: second.id,
      fromSlot: astra.slotId,
      toSlot: bram.slotId,
      // The project's own name for the file, whatever case the request used.
      changedFiles: ['Fall menu.md'],
      checks: ['Read it aloud once'],
      openIssues: ['The soup price is a guess'],
      createdBy: 'you',
    });
    const listed = await request(`/projects/${projectId}/handoffs?taskId=${second.id}`);
    expect(listed.data.handoffs).toEqual([created.data]);
    expect((await state()).manualHandoffs).toEqual([created.data]);
    expect((await state()).history.slice(before).map((entry) => entry.sentence)).toEqual([
      'You handed off Draft the menu to Bram on Proofread the menu',
    ]);
    // Durable: a fresh app over the same folder reads it back.
    const raw = JSON.parse(await fs.readFile(path.join(root, 'data', 'projects', projectId, 'state.json'), 'utf8'));
    expect(raw.manualHandoffs).toEqual([created.data]);

    // The next card starts from the changed files, on its member's engine.
    expect((await start(second.id, 'claude-code', created.data.changedFiles)).status).toBe(200);
    await settle(second.id);
    expect(asked).toEqual(['claude-code']);
  });

  test('N05: a start whose documents leave out a hand-off file is refused until they include it', async () => {
    const { astra, bram, first, second } = await pair();
    expect(
      (
        await request(`/projects/${projectId}/handoffs`, 'POST', {
          fromTaskId: first.id,
          toTaskId: second.id,
          fromSlot: astra.slotId,
          toSlot: bram.slotId,
          outcome: 'Drafted.',
          changedFiles: ['Fall menu.md'],
          checks: [],
          openIssues: [],
        })
      ).status,
    ).toBe(200);
    const refused = await start(second.id, 'claude-code', ['Opening notes.txt']);
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe('handoff_files_uncovered');
    expect(refused.data.error).toBe(
      'The hand-off into this card names Fall menu.md. Add it to the documents you send, then start again.',
    );
    expect((await start(second.id, 'claude-code', [])).status).toBe(409);
    expect(asked).toEqual([]);
    expect((await start(second.id, 'claude-code', ['Opening notes.txt', 'Fall menu.md'])).status).toBe(200);
    await settle(second.id);
    expect(asked).toEqual(['claude-code']);
  });

  test('a hand-off is refused when it does not fit the cards, the members or the project files', async () => {
    const { astra, bram, first, second } = await pair();
    const base = {
      fromTaskId: first.id,
      toTaskId: second.id,
      fromSlot: astra.slotId,
      toSlot: bram.slotId,
      outcome: 'Done.',
      changedFiles: [],
      checks: [],
      openIssues: [],
    };
    const send = (body: unknown) => request(`/projects/${projectId}/handoffs`, 'POST', body);
    expect((await send({ ...base, extra: true })).status).toBe(400);
    expect((await send({ ...base, outcome: '' })).status).toBe(400);
    expect((await send({ ...base, toTaskId: first.id })).data.error).toBe('Hand off to a different card.');
    expect((await send({ ...base, changedFiles: Array.from({ length: 9 }, (_, i) => `f${i}.md`) })).status).toBe(400);
    expect((await send({ ...base, changedFiles: ['Missing.md'] })).data.error).toBe(
      "Missing.md isn't one of this project's text documents.",
    );
    expect((await send({ ...base, changedFiles: ['../outside.md'] })).status).toBe(400);
    expect((await send({ ...base, toSlot: astra.slotId })).data.error).toBe('Assign Proofread the menu to Astra before you hand it off.');
    expect((await send({ ...base, toTaskId: 'T-missing' })).status).toBe(404);
    expect(manualHandoffRequestSchema.safeParse({ ...base, checks: ['x'.repeat(301)] }).success).toBe(false);
    expect((await state()).manualHandoffs ?? []).toEqual([]);
  });
});

describe('N06, N07, A01, A03 and A38: the free Team works in turn with no paid call', () => {
  test('N06 and A01: two members work in turn, one run at a time, with truthful rows and no managed call', async () => {
    const astra = await member('Astra', 'codex');
    const bram = await member('Bram', 'claude-code', 'opus');
    const first = await manualCard(astra, 'Draft the menu');
    const second = await manualCard(bram, 'Proofread the menu');
    expect((await accept(first)).status).toBe(200);
    expect((await accept(second)).status).toBe(200);
    // Both members are visible and both cards are the person's to start.
    expect((await request(`/projects/${projectId}/team`)).data.members.map((item: TeamMember) => item.name)).toEqual(['Astra', 'Bram']);

    let release!: (value: NativeResult) => void;
    answer = () => new Promise<NativeResult>((resolve) => (release = resolve));
    expect((await start(first.id, 'codex')).status).toBe(200);
    await until((value) => value.sessions.some((session) => session.taskId === first.id && session.state === 'working'));
    let rows = (await request<WorkRowsSnapshot>(`/projects/${projectId}/work/rows`)).data;
    expect(rows.rows).toEqual([
      expect.objectContaining({ kind: 'team-member', label: 'ChatGPT', title: 'Draft the menu', state: 'working', payer: 'your-subscription', verification: 'not-run' }),
    ]);
    // One run per project: the second member waits for the first.
    const busy = await start(second.id, 'claude-code');
    expect(busy.status).toBe(409);
    expect(busy.data.error).toBe('This project already has work in progress.');
    release(proposal());
    await settle(first.id);

    answer = async () => proposal();
    expect((await start(second.id, 'claude-code')).status).toBe(200);
    await settle(second.id);
    rows = (await request<WorkRowsSnapshot>(`/projects/${projectId}/work/rows`)).data;
    expect(rows.rows.map((row) => [row.kind, row.label, row.title, row.payer])).toEqual([
      ['team-member', 'Claude Code', 'Proofread the menu', 'your-subscription'],
      ['team-member', 'ChatGPT', 'Draft the menu', 'your-subscription'],
    ]);
    expect(rows.rows.map((row) => row.state)).toEqual(['answered', 'answered']);
    expect(asked).toEqual(['codex', 'claude-code']);
    expect(gate.calls).toBe(0);
    expect(transportCalls).toBe(0);
  });

  test('N07: the plan expires during manual work, the work continues and nothing paid is called', async () => {
    const astra = await member('Astra', 'codex');
    const first = await manualCard(astra, 'Draft the menu');
    const second = await manualCard(astra, 'Draft the sign');
    expect((await accept(first)).status).toBe(200);
    expect((await accept(second)).status).toBe(200);
    let release!: (value: NativeResult) => void;
    answer = () => new Promise<NativeResult>((resolve) => (release = resolve));
    expect((await start(first.id, 'codex')).status).toBe(200);
    await until((value) => value.sessions.some((session) => session.taskId === first.id && session.state === 'working'));
    gate.expired = true;
    release(proposal());
    await settle(first.id);
    answer = async () => proposal();
    expect((await start(second.id, 'codex')).status).toBe(200);
    await settle(second.id);
    expect(asked).toEqual(['codex', 'codex']);
    expect(gate.calls).toBe(0);
    expect(transportCalls).toBe(0);
  });

  test('A03 and A38: reading and streaming rows calls no model; attribution stays the engine’s', async () => {
    const astra = await member('Astra', 'codex');
    const task = await manualCard(astra, 'Draft the menu');
    expect((await accept(task)).status).toBe(200);
    expect((await start(task.id, 'codex')).status).toBe(200);
    await settle(task.id);
    const calls = asked.length;
    // The rows' own event stream carries a small work-rows event.
    const event = await new Promise<WorkRowsSnapshot>((resolve, reject) => {
      const req = http.get(`${url}/api/events?topics=work-rows`, { headers: { Accept: 'text/event-stream' } }, (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const match = /event: work-rows\ndata: (.*)\n\n/.exec(buffer);
          if (match) {
            req.destroy();
            resolve(JSON.parse(match[1]) as WorkRowsSnapshot);
          }
        });
      });
      req.on('error', (error) => (error.message.includes('aborted') ? undefined : reject(error)));
      // Any change to the project makes the existing listener run.
      setTimeout(() => void request(`/projects/${projectId}/tasks/${task.id}`, 'PUT', { description: 'Fresh words' }), 100);
    });
    expect(event.projectId).toBe(projectId);
    expect(Object.keys(event).sort()).toEqual(['at', 'projectId', 'rootRunId', 'rows', 'taskTitle']);
    for (let i = 0; i < 3; i++) expect((await request(`/projects/${projectId}/work/rows`)).status).toBe(200);
    expect(asked.length).toBe(calls);
    expect(gate.calls).toBe(0);
    expect(transportCalls).toBe(0);
    const rows = (await request<WorkRowsSnapshot>(`/projects/${projectId}/work/rows`)).data.rows;
    expect(rows.every((row) => row.payer !== 'nectovia-credits')).toBe(true);
    expect(rows[0]).toMatchObject({ label: 'ChatGPT', payer: 'your-subscription' });
  });
});

// Review fixes on the first S1 patch, 2026-10-03.

/** The project folder, where a test adds or removes documents the way a person would. */
const folder = async () => (await state()).project.folder;
const handOff = (body: Record<string, unknown>) => request(`/projects/${projectId}/handoffs`, 'POST', body);
const retire = (handoffId: string) => request(`/projects/${projectId}/handoffs/${handoffId}`, 'DELETE');
/** A Team member's own tool call, run under the Store lock as the team server runs it. */
function asMember<T>(action: (team: TeamService) => Promise<T>): Promise<T> {
  const store = app.locals.store as Store;
  return store.locked(() => action(new TeamService(store)));
}

describe('review fixes: a card with hand-offs into it can always start', () => {
  async function pair() {
    const astra = await member('Astra', 'codex');
    const bram = await member('Bram', 'claude-code', 'opus');
    const first = await manualCard(astra, 'Draft the menu');
    const second = await manualCard(astra, 'Proofread the menu');
    expect((await accept(first)).status).toBe(200);
    expect((await accept(second)).status).toBe(200);
    expect((await assign(second.id, bram.slotId)).status).toBe(200);
    const base = {
      fromTaskId: first.id,
      toTaskId: second.id,
      fromSlot: astra.slotId,
      toSlot: bram.slotId,
      outcome: 'Drafted.',
      checks: [] as string[],
      openIssues: [] as string[],
    };
    return { second, base };
  }

  test('a ninth file across the hand-offs into one card is refused, since a start sends at most eight', async () => {
    const { base } = await pair();
    const names = Array.from({ length: 9 }, (_, index) => `Note ${index + 1}.md`);
    for (const name of names) await fs.writeFile(path.join(await folder(), name), `# ${name}\n`, 'utf8');
    expect((await handOff({ ...base, changedFiles: names.slice(0, 8) })).status).toBe(200);
    const refused = await handOff({ ...base, changedFiles: [names[8]] });
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe('handoff_files_over_limit');
    expect(refused.data.error).toBe(
      'Proofread the menu would then have 9 files handed into it, and a start sends at most 8. Name fewer files, or retire an earlier hand-off.',
    );
    // A hand-off that adds no file of its own can't make the card harder to start.
    expect((await handOff({ ...base, changedFiles: [names[0].toLowerCase()] })).status).toBe(200);
    expect((await handOff({ ...base, changedFiles: [] })).status).toBe(200);
    expect((await state()).manualHandoffs).toHaveLength(3);
  });

  test('hand-off files over 128 KB together are refused, measured as a start reads them', async () => {
    const { base } = await pair();
    await fs.writeFile(path.join(await folder(), 'Supplier list.md'), 'a'.repeat(100_000), 'utf8');
    await fs.writeFile(path.join(await folder(), 'Price sheet.md'), 'b'.repeat(30_000), 'utf8');
    expect((await handOff({ ...base, changedFiles: ['Supplier list.md'] })).status).toBe(200);
    const refused = await handOff({ ...base, changedFiles: ['Price sheet.md'] });
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe('handoff_files_over_limit');
    expect(refused.data.error).toBe(
      'The files handed into Proofread the menu would then come to 130 KB, and a start sends at most 128 KB. Name fewer files, or retire an earlier hand-off.',
    );
    expect((await state()).manualHandoffs).toHaveLength(1);
  });

  test('a named file that left the project no longer blocks the start, and History says it was not sent', async () => {
    const { second, base } = await pair();
    expect((await handOff({ ...base, changedFiles: ['Fall menu.md', 'Opening notes.txt'] })).status).toBe(200);
    await fs.rm(path.join(await folder(), 'Opening notes.txt'));
    // The file still in the project is still required, and a refused start notes nothing.
    const before = (await state()).history.length;
    const refused = await start(second.id, 'claude-code', []);
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ code: 'handoff_files_uncovered', files: ['Fall menu.md'] });
    expect(refused.data.error).toBe(
      'The hand-off into this card names Fall menu.md. Add it to the documents you send, then start again.',
    );
    expect((await state()).history.length).toBe(before);
    expect((await start(second.id, 'claude-code', ['Fall menu.md'])).status).toBe(200);
    const current = await settle(second.id);
    expect(asked).toEqual(['claude-code']);
    expect(current.history.slice(before).filter((entry) => entry.kind === 'manual-handoff-files-gone')).toEqual([
      expect.objectContaining({
        sentence: "Opening notes.txt from the hand-off is no longer in this project, so it wasn't sent.",
        taskId: second.id,
        actor: 'diomedes',
      }),
    ]);
  });

  test('a retired hand-off no longer blocks a start; its record stays, and retiring it again changes nothing', async () => {
    const { second, base } = await pair();
    const created = (await handOff({ ...base, changedFiles: ['Fall menu.md'] })).data as ManualHandoff;
    expect((await start(second.id, 'claude-code', [])).status).toBe(409);
    const before = (await state()).history.length;
    const retired = await retire(created.id);
    expect(retired.status).toBe(200);
    expect(retired.data).toMatchObject({ id: created.id, changedFiles: ['Fall menu.md'], retiredAt: expect.any(String) });
    expect(manualHandoffSchema.safeParse(retired.data).success).toBe(true);
    const current = await state();
    expect(current.manualHandoffs).toEqual([retired.data]);
    expect(current.history.slice(before).map((entry) => [entry.kind, entry.sentence, entry.actor, entry.taskId])).toEqual([
      ['manual-handoff-retired', 'You retired the hand-off from Draft the menu to Proofread the menu', 'you', second.id],
    ]);
    const again = await retire(created.id);
    expect(again.status).toBe(200);
    expect(again.data).toEqual(retired.data);
    expect((await state()).history.length).toBe(before + 1);
    expect((await start(second.id, 'claude-code', [])).status).toBe(200);
    await settle(second.id);
    expect(asked).toEqual(['claude-code']);
  });

  test('retiring a hand-off that does not exist is refused', async () => {
    await pair();
    const refused = await retire('H-nobody');
    expect(refused.status).toBe(404);
    expect(refused.data).toMatchObject({ code: 'handoff_missing', error: 'This hand-off was not found.' });
  });

  test('the per-project cap counts live hand-offs only', async () => {
    const { base } = await pair();
    const store = app.locals.store as Store;
    await store.locked(async () => {
      const current = store.state(projectId);
      current.manualHandoffs = Array.from({ length: MANUAL_HANDOFF_LIMITS.perProject }, (_, index) => ({
        id: `H-old-${index}`,
        ...base,
        changedFiles: [],
        createdBy: 'you' as const,
        createdAt: new Date().toISOString(),
      }));
      await store.persist(current);
    });
    const full = await handOff({ ...base, changedFiles: [] });
    expect(full.status).toBe(409);
    expect(full.data).toMatchObject({
      code: 'handoff_limit',
      error: 'This project already keeps 500 live hand-offs, the most it can. Retire one, then hand off again.',
    });
    expect((await retire('H-old-0')).status).toBe(200);
    expect((await handOff({ ...base, changedFiles: [] })).status).toBe(200);
    const records = (await state()).manualHandoffs!;
    expect(records).toHaveLength(MANUAL_HANDOFF_LIMITS.perProject + 1);
    expect(records.filter((item) => !item.retiredAt)).toHaveLength(MANUAL_HANDOFF_LIMITS.perProject);
  });

  test('a hand-off names only documents the Board can send with a start', async () => {
    const { base } = await pair();
    await fs.writeFile(path.join(await folder(), 'Patio layout.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
    const refused = await handOff({ ...base, changedFiles: ['Patio layout.svg'] });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toBe("Patio layout.svg isn't one of this project's text documents.");
  });
});

describe("review fixes: a member's tools can't reassign or remove a manual card", () => {
  test('an owner change on a manual card is refused with a way to ask; the same owner is no change', async () => {
    const astra = await member('Astra', 'codex');
    const bram = await member('Bram', 'claude-code', 'opus');
    const task = await manualCard(astra, 'Check the supplier quotes');
    const entries = (await state()).history.length;
    for (const owner of [bram.slotId, 'owner'])
      await expect(
        asMember((team) => team.taskUpdateAsMember(projectId, astra, { task_id: task.id, owner, description: 'Moved' })),
      ).rejects.toMatchObject({ status: 409, message: MANUAL_CARD_ASSIGN_REFUSED });
    expect(await card(task.id)).toMatchObject({ assignedTo: astra.slotId, description: '' });
    expect((await state()).history.length).toBe(entries);
    const same = await asMember((team) => team.taskUpdateAsMember(projectId, astra, { task_id: task.id, owner: astra.slotId }));
    expect(same.owner).toBe(astra.slotId);
  });

  test('removing a manual card is refused, in the Inbox and once accepted', async () => {
    const astra = await member('Astra', 'codex');
    const task = await manualCard(astra, 'Tidy the notes');
    const remove = () => asMember((team) => team.taskUpdateAsMember(projectId, astra, { task_id: task.id, status: 'deleted' }));
    await expect(remove()).rejects.toMatchObject({ status: 409, message: MANUAL_CARD_DELETE_REFUSED });
    expect((await accept(task)).status).toBe(200);
    await expect(remove()).rejects.toMatchObject({ status: 409, message: MANUAL_CARD_DELETE_REFUSED });
    expect((await card(task.id)).deletedAt ?? null).toBeNull();
  });

  test('a stopped member is refused as the owner a tool names, when it creates or updates a card', async () => {
    const astra = await member('Astra', 'codex');
    const bram = await member('Bram', 'claude-code', 'opus');
    expect((await request(`/projects/${projectId}/team/members/${bram.slotId}/stop`, 'POST', {})).status).toBe(200);
    const stopped = "Bram was stopped and can't take work. Choose a current member.";
    const tasks = (await state()).tasks.length;
    await expect(
      asMember((team) => team.taskCreateAsMember(projectId, astra, { subject: 'Count the chairs', owner: bram.slotId })),
    ).rejects.toMatchObject({ status: 409, message: stopped });
    expect((await state()).tasks).toHaveLength(tasks);
    const plain = (await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Order napkins' })).data;
    await expect(
      asMember((team) => team.taskUpdateAsMember(projectId, astra, { task_id: plain.id, owner: bram.slotId })),
    ).rejects.toMatchObject({ status: 409, message: stopped });
    expect((await card(plain.id)).assignedTo ?? null).toBeNull();
  });

  test('a card that is not manual still changes owner and can be removed through the tools', async () => {
    const astra = await member('Astra', 'codex');
    const bram = await member('Bram', 'claude-code', 'opus');
    const plain = (await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Order napkins' })).data;
    expect((await asMember((team) => team.taskUpdateAsMember(projectId, astra, { task_id: plain.id, owner: bram.slotId }))).owner).toBe(
      bram.slotId,
    );
    expect((await card(plain.id)).assignedTo).toBe(bram.slotId);
    expect((await asMember((team) => team.taskUpdateAsMember(projectId, astra, { task_id: plain.id, owner: 'owner' }))).owner).toBe(
      'owner',
    );
    await asMember((team) => team.taskUpdateAsMember(projectId, astra, { task_id: plain.id, status: 'deleted' }));
    expect((await card(plain.id)).deletedAt).toBeTruthy();
    // A member's new card may still name another current member as its owner, for the person to accept.
    const made = await asMember((team) => team.taskCreateAsMember(projectId, astra, { subject: 'Call the supplier', owner: bram.slotId }));
    expect(made.owner).toBe(bram.slotId);
  });
});

describe('review fixes: a wake never runs a card without its hand-off files, and rows never carry its mail', () => {
  /** A person's Board card assigned to Bram, with a hand-off into it from Astra's card. */
  async function handedCard() {
    const astra = await member('Astra', 'codex');
    const bram = await member('Bram', 'codex');
    const draft = (await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Draft the order' })).data;
    const order = (await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Place the order' })).data;
    expect((await assign(draft.id, astra.slotId)).status).toBe(200);
    expect((await assign(order.id, bram.slotId)).status).toBe(200);
    const handed = await handOff({
      fromTaskId: draft.id,
      toTaskId: order.id,
      fromSlot: astra.slotId,
      toSlot: bram.slotId,
      outcome: 'Drafted.',
      changedFiles: ['Fall menu.md'],
      checks: [],
      openIssues: [],
    });
    expect(handed.status).toBe(200);
    return { bram, order };
  }
  /** A wake sends Team mail, which is conversation history, so the project has to share it. */
  async function shareConversation() {
    const policy = (await request<CloudSharingPolicy>(`/projects/${projectId}/cloud-sharing`)).data;
    const shared = await request(`/projects/${projectId}/cloud-sharing`, 'PUT', {
      expectedVersion: policy.version,
      routes: policy.routes,
      documents: policy.documents,
      shareConversationHistory: true,
      shareReviewPackets: false,
    });
    expect(shared.status).toBe(200);
  }

  test('a member whose assigned card has a live hand-off into it wakes on a card of its own, titled in rows by whose wake it is', async () => {
    const { bram, order } = await handedCard();
    await shareConversation();
    const mail = 'Please ring the squash grower about Thursday.';
    expect((await request(`/projects/${projectId}/team/messages`, 'POST', { to: bram.slotId, content: mail })).status).toBe(200);
    expect((await request(`/projects/${projectId}/team/members/${bram.slotId}/wake`, 'POST', {})).status).toBe(200);
    const current = await until((value) =>
      value.sessions.some((session) => session.slotId === bram.slotId && ['done', 'stopped', 'failed'].includes(session.state)),
    );
    const session = current.sessions.find((item) => item.slotId === bram.slotId)!;
    expect(session.taskId).not.toBe(order.id);
    expect(current.sessions.filter((item) => item.taskId === order.id)).toEqual([]);
    const made = current.tasks.find((task) => task.id === session.taskId)!;
    expect(made.createdFrom).toBe('team-mail');
    expect(made.description).toContain(mail);
    expect(asked).toEqual(['codex']);
    // The Board keeps the card's name; the rows never carry it or the mail.
    const rows = (await request<WorkRowsSnapshot>(`/projects/${projectId}/work/rows`)).data;
    expect(rows.rows).toEqual([expect.objectContaining({ rowId: `session:${session.id}`, kind: 'team-member', title: 'Bram is answering Team mail' })]);
    const wire = JSON.stringify(rows);
    expect(wire).not.toContain('squash');
    expect(wire).not.toContain(made.name);
  });

  test("the wake binds the member's next open card instead of the hand-off card", async () => {
    const { bram, order } = await handedCard();
    const sweep = (await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name: 'Sweep the patio' })).data;
    expect((await assign(sweep.id, bram.slotId)).status).toBe(200);
    await shareConversation();
    expect((await request(`/projects/${projectId}/team/messages`, 'POST', { to: bram.slotId, content: 'Sweep first.' })).status).toBe(200);
    expect((await request(`/projects/${projectId}/team/members/${bram.slotId}/wake`, 'POST', {})).status).toBe(200);
    const current = await until((value) =>
      value.sessions.some((session) => session.slotId === bram.slotId && ['done', 'stopped', 'failed'].includes(session.state)),
    );
    expect(current.sessions.map((session) => session.taskId)).toEqual([sweep.id]);
    expect(current.tasks.find((task) => task.id === sweep.id)!.createdFrom).toBeUndefined();
    expect(current.tasks.some((task) => task.createdFrom === 'team-mail')).toBe(false);
    expect(current.sessions.some((session) => session.taskId === order.id)).toBe(false);
  });

  test('a direct start that binds a hand-off card without its files is refused', async () => {
    const { order } = await handedCard();
    const ask = (sources: string[]) =>
      request(`/projects/${projectId}/ask`, 'POST', {
        mode: 'build',
        route: 'codex',
        text: 'Place the order with the supplier.',
        sources,
        consent: true,
        attachedTo: { kind: 'task', ref: order.id },
      });
    const refused = await ask([]);
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ code: 'handoff_files_uncovered', files: ['Fall menu.md'] });
    expect((await state()).sessions).toEqual([]);
    expect(asked).toEqual([]);
    expect((await ask(['Fall menu.md'])).status).toBe(200);
    await until((value) => value.sessions.some((session) => ['done', 'stopped', 'failed'].includes(session.state)));
    expect(asked).toEqual(['codex']);
  });
});

describe('review fixes: the rows stream carries rows only, and the main stream carries no rows', () => {
  /** The event names a stream carried from its opening until `ms` after `poke` finished. */
  function streamed(route: string, poke: () => Promise<unknown>, ms = 300): Promise<string[]> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let poked = false;
      const req = http.get(`${url}/api${route}`, { headers: { Accept: 'text/event-stream' } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          if (poked || !buffer.includes('event: ready')) return;
          poked = true;
          poke().then(
            () =>
              setTimeout(() => {
                req.destroy();
                resolve([...buffer.matchAll(/^event: (.+)$/gm)].map((match) => match[1]));
              }, ms),
            reject,
          );
        });
      });
      req.on('error', (error) => (poked ? undefined : reject(error)));
    });
  }
  async function runOnce() {
    const astra = await member('Astra', 'codex');
    const task = await manualCard(astra, 'Draft the menu');
    expect((await accept(task)).status).toBe(200);
    return async () => {
      expect((await start(task.id, 'codex')).status).toBe(200);
      await settle(task.id);
    };
  }

  test('topics=work-rows sends the ready frame and work-rows frames, never state', async () => {
    const seen = await streamed('/events?topics=work-rows', await runOnce());
    expect(seen[0]).toBe('ready');
    expect(seen).toContain('work-rows');
    expect([...new Set(seen)].sort()).toEqual(['ready', 'work-rows']);
  });

  test('the default stream sends state and never work-rows', async () => {
    const seen = await streamed('/events', await runOnce());
    expect(seen).toContain('state');
    expect(seen).toContain('tasks');
    expect(seen).not.toContain('work-rows');
  });

  test('an unknown topic is refused', async () => {
    const refused = await request('/events?topics=state');
    expect(refused.status).toBe(400);
  });
});
