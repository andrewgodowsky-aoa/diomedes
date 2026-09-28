/**
 * Board workflow admission regressions (Board gaps, decisions 4 and 12).
 *
 * This lane owns this file only. It runs against the real `createApp`, so it
 * proves the parent's wiring (`mountTaskWorkflowRoutes` in `server/app.ts`)
 * rather than a minimal mount: a 404 here names a wiring regression, not a
 * route regression. Work start uses the `sample` route and the native loop
 * uses the `native-fixture` route: no model calls, no live provider.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import type { TeamService } from '../server/team/service';
import { taskEvidence } from '../client/workbench/task-evidence';
import { readyAt } from '../shared/ready-queue';
import { taskWorkflowBlocker } from '../shared/task-workflow';
import type { ProjectState, Task } from '../shared/types';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string, projectId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
const store = () => app.locals.store;
const state = (): ProjectState => store().state(projectId);

async function launch() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    stepMs: 20,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close() {
  if (!server) return;
  const closingApp = app, closingServer = server;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function request<T>(route: string, method = 'POST', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

const tasksUrl = (taskId: string) => `/projects/${projectId}/tasks/${taskId}`;
const workflowUrl = (taskId: string) => `${tasksUrl(taskId)}/workflow`;

const makeTask = async (name: string): Promise<Task> =>
  (await request<Task>(`/projects/${projectId}/tasks`, 'POST', { name })).data;

const branchChild = (parentId: string, over: Record<string, unknown> = {}) =>
  request<Task>(`${tasksUrl(parentId)}/children`, 'POST', {
    commandId: `child-${Math.random().toString(36).slice(2)}`,
    name: 'Branched scope check',
    output: 'The separate result this child owns.',
    ...over,
  });

const readTask = (id: string): Task =>
  structuredClone(state().tasks.find((item) => item.id === id)!);

beforeEach(async () => {
  await fs.mkdir('test-results', { recursive: true });
  root = await fs.mkdtemp(path.resolve('test-results', 'task-workflow-admission-'));
  await launch();
  projectId = (await request<{ id: string }>('/projects', 'POST', { name: 'Workflow admission' })).data.id;
});

afterEach(async () => close());

describe('task workflow admission on the real app', () => {
  test('workflow endpoints are mounted on the real app, not only on a minimal mount', async () => {
    const task = await makeTask('Mounted workflow task');
    const updated = await request<Task>(workflowUrl(task.id), 'PUT', {
      expectedRevision: 1,
      continuation: 'full-approval',
      maxTurns: 12,
    });
    // A 404 here is the parent's wiring regressing: the route never mounted.
    expect(updated.status, JSON.stringify(updated.data)).toBe(200);
    expect(updated.data.workflow).toMatchObject({
      revision: 2,
      continuation: 'full-approval',
      maxTurns: 12,
      phase: 'plan',
    });
  });

  test('an Inbox task is refused by Work, the native fixture loop and the Ready queue', async () => {
    const parent = await makeTask('Inbox gate parent');
    const child = (await branchChild(parent.id)).data;
    expect(child.workflow).toMatchObject({ inbox: true, parentTaskId: parent.id });

    // The gate itself: the Board shows Inbox, the queue has nothing to claim.
    expect(taskWorkflowBlocker(child)).toContain('Inbox');
    expect(readyAt(child, [], [], [])).toBeNull();
    expect(taskEvidence(child, [], [], []).column).toBe('Inbox');

    const work = await request(
      `/projects/${projectId}/work/start`,
      'POST',
      { protocolVersion: 1, commandId: 'work-inbox-refused', taskId: child.id, route: 'sample' },
    );
    expect(work.status).toBe(409);
    expect(JSON.stringify(work.data)).toContain('task_workflow_blocked');

    const loop = await request(
      `/projects/${projectId}/loop/start`,
      'POST',
      {
        protocolVersion: 1,
        commandId: 'loop-inbox-refused',
        taskId: child.id,
        goal: 'Compare the quotes and write the note.',
        route: 'native-fixture',
      },
    );
    expect(loop.status).toBe(409);
    expect(JSON.stringify(loop.data)).toContain('task_workflow_blocked');
    expect(state().sessions).toEqual([]);
  });

  test('accept moves an Inbox task to Ready through the same records the Board reads', async () => {
    const parent = await makeTask('Acceptance parent');
    const child = (await branchChild(parent.id)).data;
    const accepted = await request<Task>(`${tasksUrl(child.id)}/accept`, 'POST', {
      expectedRevision: 1,
    });
    expect(accepted.status, JSON.stringify(accepted.data)).toBe(200);
    expect(accepted.data.workflow).toMatchObject({ inbox: false, revision: 2 });
    expect(taskWorkflowBlocker(accepted.data)).toBeNull();
    expect(taskEvidence(accepted.data, [], [], []).column).toBe('Ready');
    expect(readyAt(accepted.data, [], [], [])).not.toBeNull();
  });

  test('a stale revision is rejected without mutating the task', async () => {
    const task = await makeTask('Revision guarded task');
    const first = await request<Task>(workflowUrl(task.id), 'PUT', {
      expectedRevision: 1,
      continuation: 'full-approval',
    });
    expect(first.status).toBe(200);
    const stale = await request(workflowUrl(task.id), 'PUT', {
      expectedRevision: 1,
      continuation: 'stop-on-phase-change',
      maxTurns: 4,
    });
    expect(stale.status).toBe(409);
    expect(readTask(task.id).workflow).toMatchObject({
      revision: 2,
      continuation: 'full-approval',
    });
  });

  test('a branched child requires its own separate output and inherits bounded controls', async () => {
    const parent = await makeTask('Branching parent');
    await request(workflowUrl(parent.id), 'PUT', {
      expectedRevision: 1,
      continuation: 'full-approval',
      maxTurns: 6,
    });

    const missing = await branchChild(parent.id, { output: '' });
    expect(missing.status).toBe(400);
    const absent = await request(`${tasksUrl(parent.id)}/children`, 'POST', {
      commandId: `child-${Math.random().toString(36).slice(2)}`,
      name: 'Output-free child',
    });
    expect(absent.status).toBe(400);
    expect(state().tasks.filter((item) => item.workflow?.parentTaskId === parent.id)).toHaveLength(0);

    const child = await branchChild(parent.id);
    expect(child.status, JSON.stringify(child.data)).toBe(200);
    expect(child.data.workflow).toMatchObject({
      continuation: 'full-approval',
      inbox: true,
      parentTaskId: parent.id,
      output: 'The separate result this child owns.',
    });
    expect(child.data.workflow!.maxTurns).toBeLessThanOrEqual(6);
  });

  test('a malicious child cannot widen controls over its parent', async () => {
    const parent = await makeTask('Bounded parent');
    expect(parent.workflow).toBeUndefined();

    const over = await branchChild(parent.id, { maxTurns: 16 });
    // The default parent budget is 8: 16 exceeds it.
    expect(over.status).toBe(400);

    const child = (await branchChild(parent.id)).data;
    const widenTurns = await request(workflowUrl(child.id), 'PUT', {
      expectedRevision: 1,
      maxTurns: 16,
    });
    expect(widenTurns.status).toBe(400);
    const widenApproval = await request(workflowUrl(child.id), 'PUT', {
      expectedRevision: 1,
      continuation: 'full-approval',
    });
    // A stop-on-phase-change parent requires approval at phase changes:
    // its child keeps that limit.
    expect(widenApproval.status).toBe(400);
    expect(readTask(child.id).workflow).toMatchObject({
      revision: 1,
      continuation: 'stop-on-phase-change',
    });
  });

  test('deleted children cannot regain wider limits after their parent is tightened', async () => {
    const parent = await makeTask('Restore limit parent');
    await request(workflowUrl(parent.id), 'PUT', {
      expectedRevision: 1, continuation: 'full-approval', maxTurns: 8,
    });
    const child = (await branchChild(parent.id)).data;
    await request(`${tasksUrl(child.id)}/accept`, 'POST', { expectedRevision: 1 });
    const created = await request<{ member: { slotId: string } }>(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Limit test member', role: 'member', engine: 'probe',
    });
    expect(created.status).toBe(200);
    const member = state().team!.members.find((item) => item.slotId === created.data.member.slotId)!;
    const service = app.locals.teamService as TeamService;
    await store().locked(() => service.taskUpdateAsMember(projectId, member, { task_id: child.id, status: 'deleted' }));
    expect(readTask(child.id).deletedAt).toBeTruthy();
    for (const change of [{ maxTurns: 4 }, { continuation: 'stop-on-phase-change' }]) {
      const refused = await request(workflowUrl(parent.id), 'PUT', {
        expectedRevision: readTask(parent.id).workflow!.revision, ...change,
      });
      expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    }
    await store().locked(() => service.taskUpdateAsMember(projectId, member, { task_id: child.id, status: 'pending' }));
    expect(readTask(child.id).deletedAt).toBeNull();
    expect(readTask(parent.id).workflow).toMatchObject({ maxTurns: 8, continuation: 'full-approval' });
    const narrowed = await request(workflowUrl(child.id), 'PUT', {
      expectedRevision: readTask(child.id).workflow!.revision, maxTurns: 4, continuation: 'stop-on-phase-change',
    });
    expect(narrowed.status).toBe(200);
    const tightened = await request(workflowUrl(parent.id), 'PUT', {
      expectedRevision: readTask(parent.id).workflow!.revision, maxTurns: 4, continuation: 'stop-on-phase-change',
    });
    expect(tightened.status).toBe(200);
  });

  test('a blocked task cannot bypass its gates through the task status route', async () => {
    const parent = await makeTask('Gate bypass parent');
    const child = (await branchChild(parent.id)).data;

    const inboxBypass = await request(`${tasksUrl(child.id)}`, 'PUT', { state: 'done' });
    expect(inboxBypass.status).toBe(409);
    expect(readTask(child.id).state).toBe('todo');

    const parked = await makeTask('Phase gated task');
    const handoff = await request(`${tasksUrl(parked.id)}/handoff`, 'POST', {
      expectedRevision: 1,
      phase: 'build',
      reason: 'The plan is ready to build.',
    });
    expect(handoff.status).toBe(200);
    expect(taskWorkflowBlocker(readTask(parked.id))).toContain('build');
    const phaseBypass = await request(`${tasksUrl(parked.id)}`, 'PUT', { state: 'done' });
    expect(phaseBypass.status).toBe(409);
    expect(readTask(parked.id).state).toBe('todo');
  });

  test('a valid active-pack skill selection is kept, and children start with none', async () => {
    const task = await makeTask('Skill guided task');
    const empty = await request<{ skills: { packId: string; skillId: string }[] }>(
      `${tasksUrl(task.id)}/skills`, 'GET',
    );
    expect(empty.status).toBe(200);
    expect(empty.data.skills).toEqual([]);

    const activated = await request(`/projects/${projectId}/packs/diomedes.small-business/activate`, 'POST', {});
    expect(activated.status, JSON.stringify(activated.data)).toBe(200);

    const catalogue = await request<{ skills: { packId: string; skillId: string; name: string }[] }>(
      `${tasksUrl(task.id)}/skills`, 'GET',
    );
    expect(catalogue.status).toBe(200);
    expect(catalogue.data.skills.some((item) => item.packId === 'diomedes.small-business' && item.skillId === 'business-pulse')).toBe(true);

    const selected = await request<Task>(workflowUrl(task.id), 'PUT', {
      expectedRevision: 1,
      skill: { packId: 'diomedes.small-business', skillId: 'business-pulse' },
    });
    expect(selected.status, JSON.stringify(selected.data)).toBe(200);
    expect(selected.data.workflow).toMatchObject({
      revision: 2,
      skill: { packId: 'diomedes.small-business', skillId: 'business-pulse' },
    });
    // The turn budget and continuation guarantees are unchanged by guidance.
    expect(selected.data.workflow).toMatchObject({ continuation: 'stop-on-phase-change', maxTurns: 8 });

    const child = (await branchChild(task.id)).data;
    expect(child.workflow).toMatchObject({ skill: null });
  });

  test('an inactive or unknown skill reference is refused without mutating the task', async () => {
    const task = await makeTask('Skill refusal task');

    const inactive = await request(workflowUrl(task.id), 'PUT', {
      expectedRevision: 1,
      skill: { packId: 'diomedes.small-business', skillId: 'business-pulse' },
    });
    expect(inactive.status).toBe(400);
    expect(readTask(task.id).workflow).toBeUndefined();

    await request(`/projects/${projectId}/packs/diomedes.small-business/activate`, 'POST', {});
    const unknown = await request(workflowUrl(task.id), 'PUT', {
      expectedRevision: 1,
      skill: { packId: 'diomedes.small-business', skillId: 'no-such-playbook' },
    });
    expect(unknown.status).toBe(400);
    const wrongPack = await request(workflowUrl(task.id), 'PUT', {
      expectedRevision: 1,
      skill: { packId: 'diomedes.software-engineering', skillId: 'business-pulse' },
    });
    expect(wrongPack.status).toBe(400);
    expect(readTask(task.id).workflow).toBeUndefined();
  });

  test('a skill selection clears back to none', async () => {
    const task = await makeTask('Skill clear task');
    await request(`/projects/${projectId}/packs/diomedes.small-business/activate`, 'POST', {});
    const selected = await request<Task>(workflowUrl(task.id), 'PUT', {
      expectedRevision: 1,
      skill: { packId: 'diomedes.small-business', skillId: 'business-pulse' },
    });
    expect(selected.status).toBe(200);
    const cleared = await request<Task>(workflowUrl(task.id), 'PUT', {
      expectedRevision: 2,
      skill: null,
    });
    expect(cleared.status, JSON.stringify(cleared.data)).toBe(200);
    expect(cleared.data.workflow).toMatchObject({ revision: 3, skill: null });
  });

  test('a skill change waits for the active run to finish', async () => {
    const task = await makeTask('Skill active-run task');
    await request(`/projects/${projectId}/packs/diomedes.small-business/activate`, 'POST', {});
    expect(readTask(task.id).workflow).toBeUndefined();
    const started = await request(
      `/projects/${projectId}/work/start`,
      'POST',
      { protocolVersion: 1, commandId: 'work-skill-refused', taskId: task.id, route: 'sample' },
    );
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    const refused = await request(workflowUrl(task.id), 'PUT', {
      expectedRevision: 1,
      skill: { packId: 'diomedes.small-business', skillId: 'business-pulse' },
    });
    expect(refused.status).toBe(409);
    expect(readTask(task.id).workflow).toBeUndefined();
  });
});

describe('startCodexWork bound-task admission (P1)', () => {
  const enableCodex = async () => {
    const updated = await request('/settings', 'PUT', { services: { codex: true } });
    expect(updated.status, JSON.stringify(updated.data)).toBe(200);
    const sharing = await request(`/projects/${projectId}/cloud-sharing`, 'PUT', {
      expectedVersion: 0,
      routes: ['codex'],
      documents: [],
      shareConversationHistory: true,
      shareReviewPackets: false,
    });
    expect(sharing.status, JSON.stringify(sharing.data)).toBe(200);
  };

  const askBuildAttachedTo = (taskId: string) =>
    request(`/projects/${projectId}/ask`, 'POST', {
      mode: 'build',
      route: 'codex',
      text: 'Build the scoped result.',
      sources: [],
      consent: true,
      attachedTo: { kind: 'task', ref: taskId },
    });

  const assignTo = async (taskId: string, slotId: string) => {
    await store().locked(async () => {
      const current: ProjectState = store().state(projectId);
      current.tasks.find((item) => item.id === taskId)!.assignedTo = slotId;
      await store().persist(current);
    });
  };

  test('a Build attached to an Inbox child is refused before any session or turn is made', async () => {
    await enableCodex();
    const parent = await makeTask('P1 Inbox parent');
    const child = (await branchChild(parent.id)).data;
    expect(taskWorkflowBlocker(child)).toContain('Inbox');
    const conversationsBefore = state().conversations.length;
    const tasksBefore = state().tasks.length;
    const refused = await askBuildAttachedTo(child.id);
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(JSON.stringify(refused.data)).toContain('task_workflow_blocked');
    expect(JSON.stringify(refused.data)).toContain(taskWorkflowBlocker(child)!);
    expect(state().sessions).toEqual([]);
    expect(state().conversations.length).toBe(conversationsBefore);
    expect(state().tasks.length).toBe(tasksBefore);
    expect(readTask(child.id).workflow).toMatchObject({ inbox: true });
  });

  test('a Build attached to an accepted workflow child is refused with the Board loop message', async () => {
    await enableCodex();
    const parent = await makeTask('P1 accepted parent');
    const child = (await branchChild(parent.id)).data;
    const accepted = await request<Task>(`${tasksUrl(child.id)}/accept`, 'POST', {
      expectedRevision: 1,
    });
    expect(accepted.status, JSON.stringify(accepted.data)).toBe(200);
    expect(taskWorkflowBlocker(accepted.data)).toBeNull();
    const refused = await askBuildAttachedTo(child.id);
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(JSON.stringify(refused.data)).toContain('task_workflow_blocked');
    expect(JSON.stringify(refused.data)).toContain('Start this task from the Board');
    expect(state().sessions).toEqual([]);
  });

  test('a Build attached to a pending-phase child carries the exact pending blocker', async () => {
    await enableCodex();
    const parent = await makeTask('P1 pending parent');
    const child = (await branchChild(parent.id)).data;
    await request(`${tasksUrl(child.id)}/accept`, 'POST', { expectedRevision: 1 });
    const handoff = await request(`${tasksUrl(child.id)}/handoff`, 'POST', {
      expectedRevision: 2,
      phase: 'build',
      reason: 'The plan is ready to build.',
    });
    expect(handoff.status, JSON.stringify(handoff.data)).toBe(200);
    const pending = readTask(child.id);
    expect(taskWorkflowBlocker(pending)).toContain('build');
    const refused = await askBuildAttachedTo(child.id);
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(JSON.stringify(refused.data)).toContain('task_workflow_blocked');
    expect(JSON.stringify(refused.data)).toContain(taskWorkflowBlocker(pending)!);
    expect(state().sessions).toEqual([]);
  });

  test('a Build bound through thread.taskId is refused without creating another task', async () => {
    await enableCodex();
    const parent = await makeTask('P1 thread-bound parent');
    const child = (await branchChild(parent.id)).data;
    const threadId = (
      await request<{ id: string }>(`/projects/${projectId}/threads`, 'POST', {
        name: 'Bound thread',
      })
    ).data.id;
    await store().locked(async () => {
      const current: ProjectState = store().state(projectId);
      current.conversations.find((item) => item.id === threadId)!.taskId = child.id;
      await store().persist(current);
    });
    const tasksBefore = state().tasks.length;
    const refused = await request(`/projects/${projectId}/ask`, 'POST', {
      mode: 'build',
      route: 'codex',
      text: 'Build via thread binding.',
      sources: [],
      consent: true,
      threadId,
      attachedTo: { kind: 'project', ref: projectId },
    });
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(JSON.stringify(refused.data)).toContain('task_workflow_blocked');
    expect(JSON.stringify(refused.data)).toContain(taskWorkflowBlocker(child)!);
    expect(state().sessions).toEqual([]);
    expect(state().tasks.length).toBe(tasksBefore);
  });

  test('a team wake with an assigned Inbox task is refused before the session starts and keeps mail unread', async () => {
    await enableCodex();
    const parent = await makeTask('P1 wake parent');
    const child = (await branchChild(parent.id)).data;
    const created = await request<{ member: { slotId: string; threadId: string } }>(
      `/projects/${projectId}/team/members`,
      'POST',
      { name: 'Wake member', role: 'member', engine: 'codex' },
    );
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const slotId = created.data.member.slotId;
    await assignTo(child.id, slotId);
    const sent = await request(`/projects/${projectId}/team/messages`, 'POST', {
      to: slotId,
      content: 'Please build the scoped result.',
    });
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    const woke = await request(`/projects/${projectId}/team/members/${slotId}/wake`, 'POST', {});
    expect(woke.status, JSON.stringify(woke.data)).toBe(409);
    expect(JSON.stringify(woke.data)).toContain('task_workflow_blocked');
    expect(JSON.stringify(woke.data)).toContain('Inbox');
    expect(state().sessions).toEqual([]);
    expect(state().team?.messages.filter((item) => item.to === slotId && !item.read)).toHaveLength(1);
  });
});

describe('task workflow admission on the real app (prior art, preserved)', () => {
  test('a user-forged source origin is never written by the task routes', async () => {
    const forged = {
      projectId,
      threadId: 'C-forged',
      turnId: 'T-forged',
      runId: 'R-forged',
    };
    // The versioned command schema is strict: a forged origin cannot even
    // parse, so it is refused before anything is mutated.
    const versioned = await request(`/projects/${projectId}/tasks`, 'POST', {
      commandId: 'forge-origin-one',
      protocolVersion: 1,
      name: 'Forged origin task',
      origin: forged,
    });
    expect(versioned.status).toBe(400);
    expect(state().tasks).toHaveLength(0);

    // The legacy path ignores unknown fields: the origin is dropped, not kept.
    const legacy = await request<Task>(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Legacy forged origin',
      origin: forged,
      source: forged,
    });
    expect(legacy.status, JSON.stringify(legacy.data)).toBe(200);
    expect(legacy.data.origin).toBeUndefined();

    const renamed = await request<Task>(`${tasksUrl(legacy.data.id)}`, 'PUT', {
      name: 'Renamed after forge attempt',
      origin: forged,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.data.origin).toBeUndefined();
    expect(readTask(legacy.data.id).origin).toBeUndefined();
  });
});
