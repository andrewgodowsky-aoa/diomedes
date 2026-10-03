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
  MANUAL_CARD_HOLD,
  MANUAL_CARD_PHASE_REFUSED,
  boardStartRoute,
  emptyTaskWorkflow,
  manualCardStart,
  workflowOf,
} from '../shared/task-workflow.js';
import { routeDisplayName } from '../shared/engines.js';
import { manualHandoffRequestSchema, manualHandoffSchema } from '../shared/manual-handoff.js';
import type { WorkRowsSnapshot } from '../shared/work-rows.js';
import type { ProjectState, Task, TeamMember } from '../shared/types.js';
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
      reason: 'Astra works through OpenRouter. A manual card runs on ChatGPT or Claude Code for now, so assign it to a member on one of those.',
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
    // The event stream carries a small work-rows event from the existing listener.
    const event = await new Promise<WorkRowsSnapshot>((resolve, reject) => {
      const req = http.get(`${url}/api/events`, { headers: { Accept: 'text/event-stream' } }, (res) => {
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
