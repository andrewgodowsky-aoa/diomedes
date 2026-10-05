/** Real Team mail, Store and RunService, with scripted model/admission/egress/sharing callbacks; no provider. */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { HarnessPrincipal, ModelResult } from '../shared/harness.js';
import type { TeamMember } from '../shared/types.js';
import { emptyTaskWorkflow, taskWorkflowBlocker } from '../shared/task-workflow.js';
import { readyAt } from '../shared/ready-queue.js';
import { Store } from '../server/store.js';
import * as teamModule from '../server/team/service.js';
import { teamToolRegistry } from '../server/team/tools.js';
import { ModelSessionRuns } from '../server/harness/model-session-run.js';
import { sourceSha } from '../server/harness/capabilities/conversation-sources.js';
import { RunService } from '../server/harness/run-service.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { digest, HarnessError } from '../server/harness/policy.js';
import type { ModelAdapter } from '../server/harness/native-agent.js';

const SOURCE = 'A 10/10\nB 8/6 at $3.75\nC 5/5\n';
const ANSWER = 'inventory.txt: B is the sole discrepant row (8 expected, 6 counted).';
const ADMISSION = { route: 'openrouter', model: 'openai/gpt-6.1-sol', accountRoute: 'openrouter:member@r1', connectionId: 'member', revision: 1 };
const TOOLS = ['team_members', 'team_task_create', 'team_task_update', 'team_task_list', 'team_send_message', 'team_read_messages'];
let dir: string, store: Store, projectId: string, taskId: string, runs: RunService, sessions: ModelSessionRuns;
let principal: HarnessPrincipal, team: teamModule.TeamService, lead: TeamMember, member: TeamMember;
let calls: number, wakeCalls: number, lockDepth: number;
let script: (request: Parameters<ModelAdapter['complete']>[0], signal: AbortSignal) => Promise<ModelResult>;
let currentGrant: any, source: string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function adapter(): ModelAdapter {
  return {
    id: 'fixture', version: 'owned-response-test-1', destination: 'external',
    contract: routeContractFor('native-fixture'),
    capabilities: () => ({
      engineId: 'fixture', engineVersion: '1', protocolVersion: 'fixture', modelCalls: 'enforced', toolCalls: 'enforced',
      filesystemWrites: 'unsupported', networkEgress: 'enforced', approvals: 'enforced', resumability: 'enforced',
      cancellability: 'observed', checkpointGranularity: 'step', notes: ['Scripted; no provider.'],
    }),
    complete: async (request, signal) => {
      expect(lockDepth, 'provider work must run after releasing Store.locked').toBe(0);
      calls++;
      return script(request, signal);
    },
  };
}
function binding(slot: TeamMember, accountRoute: string, effort: string | null) {
  return {
    slotId: slot.slotId, role: slot.role, agentId: slot.agentId ?? null, createdAt: slot.createdAt,
    threadId: slot.threadId!, route: slot.engine, model: slot.model!, accountRoute, effort,
    profile: { id: `pr-${slot.slotId}-profile`, revision: 1, digest: digest(slot.slotId) },
  };
}
function owned(overrides: Record<string, unknown> = {}) {
  // The missing host seam is an explicit RED assertion, never an unresolved module/configuration error.
  const Constructor = (teamModule as unknown as { OwnedTeamResponses?: new (deps: any) => any }).OwnedTeamResponses;
  expect(Constructor, 'root-owned Team response host is implemented').toBeTypeOf('function');
  return new Constructor!({
    store, team, runs, sessions,
    resolveGrant: async () => structuredClone(currentGrant),
    resolveGrantLocal: () => structuredClone(currentGrant),
    documents: async () => [{ path: 'inventory.txt', text: source }],
    admit: async () => ({ ...ADMISSION }),
    adapter: async (_grant: unknown, _admission: unknown, instructions: string) => {
      expect(instructions).toMatch(/final.*(?:answer|response|reply)/i);
      expect(instructions).not.toContain('final answer must still be the file proposal');
      return adapter();
    },
    ...overrides,
  });
}
async function tool(host: any, name: string, input: unknown, stepId: string) {
  const registry = host.registry(currentGrant, principal);
  return registry.dispatch(runs, { runId: 'agent-root', owner: 'root-host', principal, stepId, name, input });
}
async function queue(host: any) {
  const created = await tool(host, 'team_task_create', { subject: 'Find the discrepant inventory row', owner: member.slotId }, 'assignment');
  const sent = await tool(host, 'team_send_message', { to: member.slotId, message: 'Which row differs? Use inventory.txt.' }, 'question');
  expect(calls, 'a mailbox tool stages work; the parent wait starts it').toBe(0);
  return { created, sent };
}
const wait = (host: any, stepId = 'team-response') => host.waitForResponse({
  grant: currentGrant, parentRunId: 'agent-root', owner: 'root-host', principal, stepId,
});

function instrumentLock() {
  const locked = store.locked.bind(store);
  store.locked = (action) => locked(async () => { lockDepth++; try { return await action(); } finally { lockDepth--; } });
}
async function reloadRuntime(claimRoot = true, closeSessions = true) {
  // A killed process closes nothing; its last saved files are all the next start reads.
  if (closeSessions) await sessions.closeAll();
  store = new Store(path.join(dir, 'data'), path.join(dir, 'projects'));
  await store.init();
  team = new teamModule.TeamService(store);
  team.setRunStarter(async () => { wakeCalls++; return { sessionId: 'unowned-session' }; });
  runs = new RunService(new FileRunStore(path.join(dir, 'runs')), { authorizeEgress: async () => {} });
  await runs.recover('agent-root', principal);
  if (claimRoot) await runs.claim('agent-root', 'root-host', 600_000);
  sessions = new ModelSessionRuns(runs, 'openrouter');
  sessions.setSharingPolicy(() => {}, () => false);
  instrumentLock();
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-agent-team-'));
  store = new Store(path.join(dir, 'data'), path.join(dir, 'projects'));
  await store.init();
  projectId = (await store.locked(() => store.createProject('Synthetic inventory'))).id;
  team = new teamModule.TeamService(store);
  const at = '2026-10-01T00:00:00.000Z';
  lead = { slotId: 'lead', name: 'Lead', role: 'lead', engine: 'aws-bedrock', model: 'kimi-k3', status: 'idle', threadId: 'lead-thread', createdAt: at, lastSeenAt: null };
  member = { slotId: 'member', name: 'Member', role: 'member', engine: 'openrouter', model: 'openai/gpt-6.1-sol', status: 'idle', threadId: 'member-thread', createdAt: at, lastSeenAt: null };
  team.teamState(projectId).members.push(lead, member, { ...member, slotId: 'other', threadId: 'other-thread', name: 'Other' });
  taskId = await store.locked(async () => {
    const state = store.state(projectId);
    for (const slot of [lead, member]) state.conversations.push({
      id: slot.threadId!, attachedTo: { kind: 'project', ref: projectId }, turns: [], name: `Thread with ${slot.name}`,
      createdAt: at, updatedAt: at, taskId: null, permission: 'task', mode: 'build',
      helper: { engine: slot.engine, model: slot.model }, requested: { profile: `pr-${slot.slotId}-profile`, model: null, effort: null },
    });
    const task = store.createTask(state, { name: 'Reconcile synthetic inventory' });
    await store.persist(state);
    return task.id;
  });
  principal = { id: 'native-lead', tenantId: 'local', projectId, capabilities: ['write-project-file'], identityGeneration: 1 };
  runs = new RunService(new FileRunStore(path.join(dir, 'runs')), { authorizeEgress: async () => {} });
  await runs.start({ id: 'agent-root', tenantId: 'local', projectId, taskId, principal,
    capability: { id: 'root-team-test', version: '1', label: 'Scripted root', description: 'Offline root', tools: TOOLS, requestedPermissions: [], approvalPolicy: 'show-first', maxTurns: 12, supportedPlatforms: ['win32', 'darwin', 'linux'] },
    input: { rootRunId: 'agent-root' }, budget: { units: 40, modelCalls: 12, toolCalls: 24, wallMs: null } });
  await runs.claim('agent-root', 'root-host', 600_000);
  sessions = new ModelSessionRuns(runs, 'openrouter');
  sessions.setSharingPolicy(() => {}, () => false);
  calls = 0; wakeCalls = 0; lockDepth = 0; source = SOURCE;
  script = async () => ({ response: { type: 'final', text: ANSWER }, transcript: {
    providerId: 'fixture', modelId: 'sol-reported', lineageId: 'response', opaqueRef: 'response-1', prefixHash: 'test',
  } });
  team.setRunStarter(async () => { wakeCalls++; return { sessionId: 'unowned-session' }; });
  currentGrant = { v: 1, id: 'team-grant', commandId: 'start-command', projectId, taskId, rootRunId: 'agent-root',
    lead: binding(lead, 'aws-bedrock:lead@r1', null), member: binding(member, 'openrouter:member@r1', 'medium'),
    sources: [{ path: 'inventory.txt', sha256: sourceSha(SOURCE) }], maxModelCalls: 6, maxResponses: 1 };
  instrumentLock();
});
afterEach(async () => { await sessions?.closeAll(); await fs.rm(dir, { recursive: true, force: true }); });

describe('bounded model-session Team response mode', () => {
  test('response uses six calls and a narrowed principal with root metadata; ordinary Work keeps 24', async () => {
    const registry = teamToolRegistry({ store, service: team, projectId, member });
    const request = {
      route: 'openrouter', input: { projectId, threadId: member.threadId!, requestId: 'bounded', prompt: 'Find the discrepant row.', documents: [], instructions: 'Reply to the lead.', model: member.model!, accountRoute: currentGrant.member.accountRoute },
      registry, admit: async () => ({ route: 'openrouter', connectionId: 'member', revision: 1, model: member.model!, accountRoute: currentGrant.member.accountRoute }),
      adapter: async () => adapter(),
      ownedResponse: { principal: { ...principal, capabilities: [] }, maxModelCalls: 6, validate: async () => {},
        metadata: { v: 1, grantId: 'team-grant', rootRunId: 'agent-root', taskId, teamRunId: 'owned-team', assignmentTaskId: 'assignment', parent: { runId: 'agent-root', stepId: 'team-response' } } },
    };
    const result = await sessions.workTurn(request);
    const run = await runs.get(result.runId);
    expect(run.budget.modelCalls).toBe(6);
    expect(run.principal.capabilities).toEqual([]);
    expect(run.taskId).toBe(taskId);
    expect(run.input).toMatchObject({ rootRunId: 'agent-root', parent: { runId: 'agent-root', stepId: 'team-response' } });
    expect(run.parentRunId, 'fork lineage is not delegation ownership').toBeNull();
    const again = await sessions.workTurn(request);
    expect(again).toEqual(result);
    expect(calls).toBe(1);
    // Existing standalone Work still registers the complete ordinary Team manifest.
    const { ownedResponse: _ownedResponse, ...ordinary } = request;
    const ordinaryResult = await sessions.workTurn({ ...ordinary, input: { ...request.input, requestId: 'ordinary' },
      registry: teamToolRegistry({ store, service: team, projectId, member }) });
    expect((await runs.get(ordinaryResult.runId)).budget.modelCalls).toBe(24);
    expect((await runs.get(ordinaryResult.runId)).principal.capabilities).toEqual(['write-project-file']);
  });
});

describe('root-owned persistent Team response', () => {
  test('a profile selected through the public thread parser keeps null placeholders and responds under its resolved effort', async () => {
    const [{ createApp }, { EngineService }] = await Promise.all([import('../server/app.js'), import('../server/engines/service.js')]);
    let providerCalls = 0;
    const app = await createApp({
      dataDir: path.join(dir, 'data'), projectRoot: path.join(dir, 'projects'),
      engineService: new EngineService(path.join(dir, 'engines'), { discover: async () => [] }),
      reviewerAdapter: null, accounts: null, observation: null, managedJev: false,
      nativeGenerator: async () => { throw new Error('Profile parsing must not start Work.'); },
      modelApiTransport: (async () => { providerCalls++; throw new Error('Profile parsing must not call a provider.'); }) as typeof globalThis.fetch,
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
      const response = await fetch(`${url}/api/agent-profiles`, { method: 'POST', headers, body: JSON.stringify({
        name: 'Bounded responder', engine: member.engine, model: member.model, effort: 'medium', agentId: 'diomedes.builder', rules: [],
      }) });
      expect(response.status).toBe(200);
      const profile = await response.json();
      expect(profile.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      const bindingDigest = profile.digest.slice('sha256:'.length);
      expect(bindingDigest).toMatch(/^[a-f0-9]{64}$/);
      currentGrant.member.profile = { id: profile.profileId, revision: profile.revision, digest: bindingDigest };
      const picked = await fetch(`${url}/api/projects/${projectId}/threads/${member.threadId}`, {
        method: 'PUT', headers, body: JSON.stringify({ requested: { profile: profile.profileId } }),
      });
      expect(picked.status).toBe(200);
      expect((await picked.json()).requested).toEqual({ profile: profile.profileId, model: null, effort: null });
    } finally {
      try { await app.locals.close(); }
      finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    }
    await reloadRuntime();
    const requested = store.state(projectId).conversations.find((thread) => thread.id === member.threadId)!.requested;
    expect(requested).toEqual({ profile: currentGrant.member.profile.id, model: null, effort: null });
    expect(currentGrant.member.effort).toBe('medium');
    const host = owned();
    await queue(host);
    expect((await wait(host)).text).toBe(ANSWER);
    expect(calls).toBe(1);
    expect(providerCalls).toBe(0);
  });

  test.each(['profile', 'model', 'effort'])('a profile placeholder rejects conflicting explicit %s before dispatch', async (field) => {
    const host = owned();
    await queue(host);
    const requested = store.state(projectId).conversations.find((thread) => thread.id === member.threadId)!.requested!;
    if (field === 'profile') requested.profile = 'pr-other-profile';
    if (field === 'model') requested.model = 'different-model';
    if (field === 'effort') requested.effort = 'high';
    await expect(wait(host)).rejects.toThrow(/profile|model|effort/i);
    expect(calls).toBe(0);
    expect(team.teamState(projectId).messages).toHaveLength(1);
  });

  test('a profile-free binding still refuses changed direct effort', async () => {
    for (const selected of [currentGrant.lead, currentGrant.member]) {
      selected.profile = null;
      store.state(projectId).conversations.find((thread) => thread.id === selected.threadId)!.requested = { model: selected.model, effort: selected.effort };
    }
    const host = owned();
    await queue(host);
    store.state(projectId).conversations.find((thread) => thread.id === member.threadId)!.requested!.effort = 'high';
    await expect(wait(host)).rejects.toThrow(/effort/i);
    expect(calls).toBe(0);
  });

  test('an admitted assignment inherits its root phase and limits, reports actual progress and waits for Review', async () => {
    const rootTask = store.state(projectId).tasks.find((task) => task.id === taskId)!;
    rootTask.workflow = { ...emptyTaskWorkflow(), phase: 'build', maxTurns: 2 };
    await store.persist(store.state(projectId));
    const ordinary = await store.locked(() => team.taskCreateAsMember(projectId, lead, { subject: 'Independent proposal', owner: 'other' }));
    const proposed = store.state(projectId).tasks.find((task) => task.id === ordinary.id)!;
    expect(proposed.workflow).toMatchObject({ inbox: true, parentTaskId: null });
    await expect(store.locked(() => team.taskUpdateAsMember(projectId, lead, { task_id: proposed.id, status: 'in_progress' }))).rejects.toThrow(/Inbox/i);

    const host = owned();
    const { created } = await queue(host);
    const assignmentId = created.task.id;
    // A refused Store.locked mutation reloads its durable state and replaces Task
    // objects. Observe the current projection by its stable identity after each boundary.
    const assignment = () => store.state(projectId).tasks.find((task) => task.id === assignmentId)!;
    expect(assignment().ownedAssignment).toEqual({ rootTaskId: taskId, rootRunId: 'agent-root', admissionRef: currentGrant.id });
    expect(assignment().workflow).toMatchObject({ inbox: false, parentTaskId: taskId, phase: 'build',
      continuation: 'stop-on-phase-change', maxTurns: 2, output: expect.stringContaining('mailbox'), handoffs: [] });
    expect(taskWorkflowBlocker(assignment())).toMatch(/owned|root/i);
    expect(readyAt(assignment(), store.state(projectId).sessions)).toBeNull();
    for (const edit of [{ status: 'in_progress' }, { status: 'pending' }, { description: 'Widen the assignment' }]) {
      await expect(store.locked(() => team.taskUpdateAsMember(projectId, lead, { task_id: assignmentId, ...edit }))).rejects.toThrow(/root|Runtime/i);
    }
    script = async (request) => {
      expect(assignment().state).toBe('working');
      if (calls === 1) return { response: { type: 'tool', name: 'team_task_update', input: { task_id: assignmentId, status: 'in_progress' } } };
      expect(request.messages.find((message) => message.role === 'tool')?.output).toMatchObject({ task: { id: assignmentId, status: 'in_progress' } });
      return { response: { type: 'final', text: ANSWER } };
    };
    const result = await wait(host);
    const child = await runs.get(result.runId);
    expect(child.budget.modelCalls).toBe(2);
    expect(child.used.modelCalls).toBe(2);
    expect(assignment()).toMatchObject({ state: 'waiting', reason: 'changes-ready' });
    expect(assignment().workflow).toMatchObject({ phase: 'build', pendingPhase: null, handoffs: [] });
    expect(store.state(projectId).tasks.find((task) => task.id === taskId)?.state).not.toBe('done');
    expect(store.state(projectId).needs).toHaveLength(0);
    const persisted = JSON.parse(await fs.readFile(store.statePath(projectId), 'utf8'));
    expect(persisted.tasks.find((task: any) => task.id === assignmentId)).toMatchObject({ state: 'waiting', reason: 'changes-ready', ownedAssignment: assignment().ownedAssignment });
  });

  test('model-authored completion cannot mark an owned assignment Done or reopen its accepted response', async () => {
    const host = owned();
    const { created } = await queue(host);
    const assignmentId = created.task.id;
    const assignment = () => store.state(projectId).tasks.find((task) => task.id === assignmentId)!;
    script = async (request) => {
      if (calls === 1) return { response: { type: 'tool', name: 'team_task_update', input: { task_id: assignmentId, status: 'completed' } } };
      expect(request.messages.find((message) => message.role === 'tool')?.output).toMatchObject({ error: expect.stringMatching(/Runtime|Review/i) });
      expect(assignment().state).toBe('working');
      return { response: { type: 'final', text: ANSWER } };
    };
    await wait(host);
    expect(assignment().state).toBe('waiting');
    expect(await tool(host, 'team_task_update', { task_id: assignmentId, status: 'completed' }, 'finish-assignment')).toMatchObject({ error: expect.stringMatching(/Review/i) });
    expect(await tool(host, 'team_task_update', { task_id: assignmentId, status: 'pending' }, 'reopen-assignment')).toMatchObject({ error: expect.any(String) });
    expect(assignment()).toMatchObject({ state: 'waiting', reason: 'changes-ready' });
    expect(assignment().moves.some((move) => move.to === 'done')).toBe(false);
    const persisted = JSON.parse(await fs.readFile(store.statePath(projectId), 'utf8'));
    const saved = persisted.tasks.find((task: any) => task.id === assignmentId);
    expect(saved).toMatchObject({ state: 'waiting', reason: 'changes-ready' });
    expect(saved.moves.some((move: { to: string }) => move.to === 'done')).toBe(false);
  });

  test.each(['ownership', 'workflow'])('changed assignment %s refuses before a provider call', async (change) => {
    const host = owned();
    const { created } = await queue(host);
    const assignment = store.state(projectId).tasks.find((task) => task.id === created.task.id)!;
    if (change === 'ownership') assignment.ownedAssignment = { ...assignment.ownedAssignment!, rootRunId: 'other-root' };
    else assignment.workflow!.maxTurns = 16;
    await expect(wait(host)).rejects.toThrow(/assignment.*changed/i);
    expect(calls).toBe(0);
    expect(team.teamState(projectId).messages).toHaveLength(1);
  });

  test('recovering a completed root releases its Team slots while preserving the saved response and Review task', async () => {
    const host = owned();
    const { created } = await queue(host);
    const result = await wait(host);
    await expect(store.locked(() => team.wakeMember(projectId, lead.slotId))).rejects.toThrow(/root|owned/i);
    await runs.complete('agent-root', 'root-host', { answer: result.text });
    await reloadRuntime(false);
    const reopened = owned();
    await reopened.recoverRoot(projectId, 'agent-root');
    const saved = reopened.ownedChildren(projectId, 'agent-root')[0];
    expect(saved).toMatchObject({ rootClosed: true, status: 'completed', unknownOutcome: false, result });
    expect(store.state(projectId).tasks.find((task) => task.id === created.task.id)).toMatchObject({ state: 'waiting', reason: 'changes-ready' });
    expect(team.teamState(projectId).messages).toHaveLength(2);
    await store.locked(() => team.wakeMember(projectId, lead.slotId));
    expect(wakeCalls).toBe(1);
    expect(calls).toBe(1);
    expect((await runs.get(result.runId)).state).toBe('completed');
  });

  test('a real assignment and mailbox exchange records ownership before dispatch and returns model-produced mail', async () => {
    const host = owned();
    const { created, sent } = await queue(host);
    const persisted = JSON.parse(await fs.readFile(store.statePath(projectId), 'utf8'));
    expect(persisted.team.runs).toHaveLength(1);
    expect(persisted.team.runs[0]).toMatchObject({ rootRunId: 'agent-root', sessionId: null, assignmentTaskId: created.task.id, requestMessageId: sent.message.id });
    const result = await wait(host);
    expect(result.text).toBe(ANSWER);
    const child = await runs.get(result.runId);
    expect(child.id).not.toBe('agent-root');
    expect(child.capabilityId).toBe('model-api-team-work');
    expect(child.budget.modelCalls).toBe(6);
    expect(child.input).toMatchObject({ rootRunId: 'agent-root' });
    expect(wakeCalls).toBe(0);
    const replies = team.teamState(projectId).messages.filter((mail) => mail.from === member.slotId && mail.to === lead.slotId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ content: ANSWER, runId: persisted.team.runs[0].id });
    expect((await runs.get('agent-root')).steps.find((step) => step.intent.stepId === 'team-response')?.intent.kind).toBe('wait');
  });

  test('root task completion, unrelated assignments and roster mutation are refused', async () => {
    const host = owned();
    const registry = host.registry(currentGrant, principal);
    expect(registry.describe().map((item: any) => item.name).sort()).toEqual([...TOOLS].sort());
    await queue(host);
    expect(await tool(host, 'team_task_update', { task_id: taskId, status: 'completed' }, 'root-complete')).toMatchObject({ error: expect.any(String) });
    expect(await tool(host, 'team_task_create', { subject: 'Other work', owner: 'other' }, 'unrelated-task')).toMatchObject({ error: expect.any(String) });
    expect(await tool(host, 'team_send_message', { to: 'other', message: 'Do this too' }, 'unrelated-mail')).toMatchObject({ error: expect.any(String) });
    expect(store.state(projectId).tasks.find((task) => task.id === taskId)?.state).not.toBe('done');
    expect(team.teamState(projectId).runs).toHaveLength(1);
  });

  test('completed replay after reopening returns exactly the saved result and does not resend', async () => {
    const host = owned();
    const { sent } = await queue(host);
    const first = await wait(host);
    await reloadRuntime();
    const reopened = owned();
    expect(await tool(reopened, 'team_send_message', { to: member.slotId, message: 'Which row differs? Use inventory.txt.' }, 'question')).toEqual(sent);
    expect(await wait(reopened)).toEqual(first);
    expect(calls).toBe(1);
    expect(team.teamState(projectId).messages).toHaveLength(2);
  });

  test('an unknown external result is parked and a different wait or new send cannot resend it', async () => {
    const host = owned();
    await queue(host);
    script = async () => { throw new Error('Provider acknowledgement lost'); };
    await expect(wait(host)).rejects.toThrow(/acknowledgement lost/);
    const children = host.ownedChildren(projectId, 'agent-root');
    expect((await runs.get(children[0].harnessRunId)).state).toBe('reconcile_required');
    await expect(wait(owned(), 'different-wait')).rejects.toThrow(/reconcil|unknown|already/i);
    expect(await tool(owned(), 'team_send_message', { to: member.slotId, message: 'Please try again' }, 'new-question')).toMatchObject({ error: expect.any(String) });
    expect(calls).toBe(1);
    expect(team.teamState(projectId).messages).toHaveLength(1);
  });

  test.each(['member', 'model', 'source', 'account', 'profile', 'effort'])('live %s changes refuse before dispatch', async (change) => {
    const host = owned();
    await queue(host);
    if (change === 'member') team.teamState(projectId).members.splice(1, 1);
    if (change === 'model') team.requireActive(projectId, member.slotId).model = 'different-model';
    if (change === 'source') source = 'Changed source';
    if (change === 'account') currentGrant.member.accountRoute = 'openrouter:other@r2';
    if (change === 'profile') currentGrant.member.profile.revision = 2;
    if (change === 'effort') currentGrant.member.effort = 'high';
    await expect(wait(host)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(team.teamState(projectId).messages).toHaveLength(1);
  });

  test.each(['member', 'root'])('%s Stop fences a late provider result and preserves the unknown child', async (stop) => {
    const host = owned();
    await queue(host);
    const entered = deferred<void>();
    const late = deferred<ModelResult>();
    script = async () => { entered.resolve(); return late.promise; };
    const response = wait(host).then(() => null, (error: unknown) => error);
    await entered.promise;
    if (stop === 'member') await store.locked(() => team.stopMember(projectId, member.slotId));
    else await host.stopRoot(projectId, 'agent-root');
    late.resolve({ response: { type: 'final', text: 'Late answer' } });
    expect(await response).toBeInstanceOf(Error);
    const child = await runs.get(host.ownedChildren(projectId, 'agent-root')[0].harnessRunId);
    expect(child.state).toBe('cancelled');
    expect(child.steps.some((step) => step.state === 'reconcile_required')).toBe(true);
    expect(team.teamState(projectId).messages).toHaveLength(1);
    expect(team.requireActive(projectId, 'other').status).toBe('idle');
    if (stop === 'member') expect(team.teamState(projectId).members.find((slot) => slot.slotId === member.slotId)?.status).toBe('stopped');
  });

  test('a member profile revoked while the provider is responding blocks result acceptance', async () => {
    const host = owned();
    await queue(host);
    const entered = deferred<void>();
    const late = deferred<ModelResult>();
    script = async () => { entered.resolve(); return late.promise; };
    const response = wait(host).then(() => null, (error: unknown) => error);
    await entered.promise;
    currentGrant.member.profile.revision = 2;
    late.resolve({ response: { type: 'final', text: 'Reply under revoked profile' } });
    expect(await response).toBeInstanceOf(Error);
    expect(calls).toBe(1);
    expect(team.teamState(projectId).messages).toHaveLength(1);
    expect((await runs.get(host.ownedChildren(projectId, 'agent-root')[0].harnessRunId)).state).toBe('reconcile_required');
  });

  test('recovery of persisted dispatch never implicitly reruns the provider', async () => {
    const host = owned();
    await queue(host);
    script = async () => { throw new HarnessError('transport_unknown', 'Provider outcome is unknown'); };
    await expect(wait(host)).rejects.toThrow(/unknown/);
    await reloadRuntime();
    const reopened = owned();
    await reopened.recoverRoot(projectId, 'agent-root');
    await expect(wait(reopened, 'recovered-wait')).rejects.toThrow(/reconcil|unknown|already/i);
    expect(calls).toBe(1);
    expect(wakeCalls).toBe(0);
  });

  test('the response budget is carved before admission and cannot exceed the root remainder', async () => {
    const host = owned();
    await queue(host);
    await runs.step('agent-root', 'root-host', { id: 'spent-root-budget', version: '1', kind: 'transform', cost: 29 },
      async () => ({ spent: true }), principal);
    await expect(wait(host)).rejects.toThrow(/budget/i);
    expect(calls).toBe(0);
    const staged = host.ownedChildren(projectId, 'agent-root')[0];
    await expect(runs.get(staged.harnessRunId)).rejects.toThrow(/unknown/i);
    expect(staged.status).toBe('accepted');
  });

  test('a saved reply survives a lost local acknowledgement before the parent wait commits', async () => {
    const host = owned();
    await queue(host);
    const persist = store.persist.bind(store);
    let lost = false;
    store.persist = async (state) => {
      await persist(state);
      if (!lost && state.team?.runs.some((run) => run.status === 'completed')) {
        lost = true;
        throw new Error('Local response acknowledgement lost');
      }
    };
    await expect(wait(host)).rejects.toThrow(/acknowledgement lost/);
    await reloadRuntime();
    expect((await wait(owned())).text).toBe(ANSWER);
    expect(calls).toBe(1);
    expect(team.teamState(projectId).messages.filter((mail) => mail.from === member.slotId)).toHaveLength(1);
    const root = await runs.get('agent-root');
    expect(root.used.units).toBe(14); // Two mailbox/assignment tools and one carved response, never twice.
  });

  test('persisted staging fences a standalone wake before the response host is rewired', async () => {
    await queue(owned());
    await reloadRuntime();
    await expect(store.locked(() => team.wakeMember(projectId, member.slotId))).rejects.toThrow(/owned|root/i);
    expect(wakeCalls).toBe(0);
    expect(calls).toBe(0);
  });

  test('the member sees only its owned request and assignment and cannot create another request', async () => {
    const host = owned();
    const { created, sent } = await queue(host);
    script = async (request) => {
      expect(request.tools.map((entry) => entry.name).sort()).toEqual([
        'team_members', 'team_task_update', 'team_task_list', 'team_read_messages',
      ].sort());
      return { response: { type: 'final', text: ANSWER } };
    };
    expect((await tool(host, 'team_task_list', {}, 'scoped-board')).tasks.map((task: any) => task.id)).toEqual([created.task.id]);
    expect((await tool(host, 'team_members', {}, 'scoped-roster')).members.map((slot: any) => slot.slotId)).toEqual(['lead', 'member']);
    expect((await wait(host)).text).toBe(ANSWER);
    expect(team.teamState(projectId).messages.find((mail) => mail.id === sent.message.id)?.read).toBe(true);
  });

  test('stopping the selected lead cancels its child and does not stop an unrelated member', async () => {
    const host = owned();
    await queue(host);
    const entered = deferred<void>();
    const late = deferred<ModelResult>();
    script = async () => { entered.resolve(); return late.promise; };
    const response = wait(host).then(() => null, (error: unknown) => error);
    await entered.promise;
    await store.locked(() => team.stopMember(projectId, lead.slotId));
    late.resolve({ response: { type: 'final', text: 'Late answer' } });
    expect(await response).toBeInstanceOf(Error);
    expect((await runs.get(host.ownedChildren(projectId, 'agent-root')[0].harnessRunId)).state).toBe('cancelled');
    expect(team.teamState(projectId).messages).toHaveLength(1);
    expect(team.requireActive(projectId, 'other').status).toBe('idle');
  });

  test('Store-held Stop completes while the response waits to commit under its root fence', async () => {
    const host = owned();
    await queue(host);
    const entered = deferred<void>();
    const late = deferred<ModelResult>();
    script = async () => { entered.resolve(); return late.promise; };
    const response = wait(host).then(() => null, (error: unknown) => error);
    await entered.promise;
    const locked = store.locked.bind(store);
    const commitQueued = deferred<void>();
    const releaseOnFailure = deferred<void>();
    let stopHoldsStore = false;
    store.locked = (action) => {
      if (stopHoldsStore) commitQueued.resolve();
      return locked(action);
    };
    // These are the production Stop lock and cancellation APIs. Force the response
    // to queue its commit while Stop owns Store, before Stop takes the run queue.
    const stopped = locked(async () => {
      stopHoldsStore = true;
      late.resolve({ response: { type: 'final', text: 'A response racing Stop' } });
      await commitQueued.promise;
      await Promise.race([
        (async () => {
          await runs.cancel('agent-root', 'HTTP Stop', principal);
          await host.stopRootLocked(projectId, 'agent-root');
        })(),
        releaseOnFailure.promise,
      ]);
      stopHoldsStore = false;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const [, outcome] = await Promise.race([
        Promise.all([stopped, response]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Stop deadlocked with the owned response commit')), 2_000);
        }),
      ]);
      expect(outcome).toBeInstanceOf(Error);
      expect((await runs.get('agent-root')).state).toBe('cancelled');
      expect(team.teamState(projectId).messages).toHaveLength(1);
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseOnFailure.resolve();
      await Promise.allSettled([stopped, response]);
    }
  });
});

describe('terminal owned response history', () => {
  test.each(['cancelled', 'failed', 'completed'] as const)('%s timestamps and records survive repeated close and recovery', async terminal => {
    const host = owned();
    await queue(host);
    if (terminal === 'completed') {
      await wait(host);
      await runs.complete('agent-root', 'root-host', { answer: ANSWER });
    } else if (terminal === 'failed') {
      script = async () => { throw new Error('Synthetic provider outcome is unknown'); };
      await expect(wait(host)).rejects.toThrow('Synthetic provider outcome is unknown');
      await runs.fail('agent-root', 'root-host', new Error('Response failed'));
    } else {
      await runs.cancel('agent-root', 'Stop before dispatch', principal);
    }
    await host.stopRoot(projectId, 'agent-root');
    expect(host.ownedChildren(projectId, 'agent-root')[0].status).toBe(terminal);
    const teamBefore = structuredClone(team.teamState(projectId));
    const rootBefore = await runs.get('agent-root');
    const historyBefore = structuredClone(store.state(projectId).history);
    for (let repeat = 0; repeat < 2; repeat++) {
      await host.stopRoot(projectId, 'agent-root');
      await host.recoverRoot(projectId, 'agent-root');
      expect(team.teamState(projectId)).toEqual(teamBefore);
      expect(store.state(projectId).history).toEqual(historyBefore);
    }
    await reloadRuntime(false);
    await owned().recoverRoot(projectId, 'agent-root');
    expect(team.teamState(projectId)).toEqual(teamBefore);
    expect(await runs.get('agent-root')).toEqual(rootBefore);
    expect(store.state(projectId).history).toEqual(historyBefore);
    expect(calls).toBe(terminal === 'cancelled' ? 0 : 1);
    expect(wakeCalls).toBe(0);
  });
});

describe('Stop settles the owned member without the stopped response', () => {
  // The stopped response wrote the member status and summary after Stop returned, so a host
  // that exited in between kept the member `working` for good, and mail never wakes `working`.
  test.each(['in-flight', 'before-dispatch'] as const)('%s: an exit before the response settles keeps the stopped member and summary', async (moment) => {
    const entered = deferred<void>();
    const admitted = deferred<void>();
    const late = deferred<ModelResult>();
    const host = owned(moment === 'before-dispatch'
      ? { admit: async () => { entered.resolve(); await admitted.promise; return { ...ADMISSION }; } } : {});
    await queue(host);
    script = async () => { entered.resolve(); return late.promise; };
    const response = wait(host).then(() => null, (error: unknown) => error);
    await entered.promise;
    expect(team.requireActive(projectId, member.slotId).status).toBe('working');
    await runs.cancel('agent-root', 'HTTP Stop', principal);
    await host.stopRoot(projectId, 'agent-root');
    // Hold every later Store write of this host, as an exit right after Stop would.
    const exited = deferred<void>();
    const locked = store.locked.bind(store);
    store.locked = (action) => locked(async () => { await exited.promise; return action(); });
    admitted.resolve();
    late.resolve({ response: { type: 'final', text: 'A late answer after Stop' } });
    try {
      await reloadRuntime(false);
      const reopened = owned();
      expect(reopened.ownedChildren(projectId, 'agent-root')[0]).toMatchObject({
        status: 'cancelled', rootClosed: true, unknownOutcome: moment === 'in-flight', result: null, summary: expect.any(String) });
      expect(team.requireActive(projectId, member.slotId).status).toBe('idle');
      const settled = structuredClone(team.teamState(projectId));
      for (let repeat = 0; repeat < 2; repeat++) {
        await reopened.recoverRoot(projectId, 'agent-root');
        expect(team.teamState(projectId)).toEqual(settled);
      }
      // A known stop frees the member for ordinary mail; an unknown outcome stays fenced.
      await store.locked(() => team.sendAsMember(projectId, team.requireActive(projectId, 'other'), {
        to: member.slotId, message: 'A new question about inventory.txt.' }));
      expect(wakeCalls).toBe(moment === 'in-flight' ? 0 : 1);
      expect(calls).toBe(moment === 'in-flight' ? 1 : 0);
    } finally {
      exited.resolve();
      expect(await response).toBeInstanceOf(Error);
    }
  });

  test('an exit mid-response without Stop is settled by recovery, not left working', async () => {
    const host = owned();
    await queue(host);
    const entered = deferred<void>();
    const late = deferred<ModelResult>();
    script = async () => { entered.resolve(); return late.promise; };
    const response = wait(host).then(() => null, (error: unknown) => error);
    await entered.promise;
    const exited = deferred<void>();
    const locked = store.locked.bind(store);
    store.locked = (action) => locked(async () => { await exited.promise; return action(); });
    const killed = sessions;
    try {
      await reloadRuntime(true, false);
      const reopened = owned();
      await reopened.recoverRoot(projectId, 'agent-root');
      expect(reopened.ownedChildren(projectId, 'agent-root')[0]).toMatchObject({
        status: 'failed', rootClosed: false, unknownOutcome: true, result: null, summary: expect.any(String) });
      expect(team.requireActive(projectId, member.slotId).status).toBe('error');
      const settled = structuredClone(team.teamState(projectId));
      await reopened.recoverRoot(projectId, 'agent-root');
      expect(team.teamState(projectId)).toEqual(settled);
    } finally {
      exited.resolve();
      late.resolve({ response: { type: 'final', text: 'A late answer after the exit' } });
      await killed.closeAll();
      expect(await response).toBeInstanceOf(Error);
    }
  });

  test.each(['in-flight', 'before-dispatch'] as const)('%s: the stopped response settling later leaves what Stop wrote', async (moment) => {
    const entered = deferred<void>();
    const admitted = deferred<void>();
    const late = deferred<ModelResult>();
    const host = owned(moment === 'before-dispatch'
      ? { admit: async () => { entered.resolve(); await admitted.promise; return { ...ADMISSION }; } } : {});
    await queue(host);
    script = async () => { entered.resolve(); return late.promise; };
    const response = wait(host).then(() => null, (error: unknown) => error);
    await entered.promise;
    await runs.cancel('agent-root', 'HTTP Stop', principal);
    await host.stopRoot(projectId, 'agent-root');
    const stopped = structuredClone({ team: team.teamState(projectId), tasks: store.state(projectId).tasks, history: store.state(projectId).history });
    admitted.resolve();
    late.resolve({ response: { type: 'final', text: 'A late answer after Stop' } });
    expect(await response).toBeInstanceOf(Error);
    await host.stopRoot(projectId, 'agent-root');
    expect({ team: team.teamState(projectId), tasks: store.state(projectId).tasks, history: store.state(projectId).history }).toEqual(stopped);
  });
});

describe('fresh Team ownership does not revive a prior response', () => {
  test.each(['open-root', 'closed-but-running-root', 'stopping-response'] as const)('%s still excludes another assignment to its slots', async boundary => {
    const host = owned();
    await queue(host);
    const oldGrant = structuredClone(currentGrant);
    const entered = deferred<void>();
    const late = deferred<ModelResult>();
    let response: Promise<unknown> | undefined;
    if (boundary === 'stopping-response') {
      script = async () => { entered.resolve(); return late.promise; };
      response = wait(host).then(() => null, (error: unknown) => error);
      await entered.promise;
      await runs.cancel('agent-root', 'Stop the earlier root', principal);
      await host.stopRoot(projectId, 'agent-root');
    } else if (boundary === 'closed-but-running-root') {
      // Closing a Team exchange alone does not make its root terminal.
      await host.stopRoot(projectId, 'agent-root');
    }
    try {
      await runs.start({ id: 'fresh-root', tenantId: 'local', projectId, taskId, principal,
        capability: { id: 'root-team-test', version: '1', label: 'New synthetic root', description: 'Offline root', tools: TOOLS,
          requestedPermissions: [], approvalPolicy: 'show-first', maxTurns: 12, supportedPlatforms: ['win32', 'darwin', 'linux'] },
        input: { rootRunId: 'fresh-root' }, budget: { units: 40, modelCalls: 12, toolCalls: 24, wallMs: null } });
      await runs.claim('fresh-root', 'fresh-host', 600_000);
      currentGrant = { ...oldGrant, id: 'fresh-grant', commandId: 'fresh-command', rootRunId: 'fresh-root' };
      const denied = await host.registry(currentGrant, principal).dispatch(runs, {
        runId: 'fresh-root', owner: 'fresh-host', principal, stepId: 'fresh-assignment', name: 'team_task_create',
        input: { subject: 'A second assignment', owner: member.slotId },
      });
      expect(denied).toMatchObject({ error: expect.stringMatching(/active.*owned|owned.*active/i) });
      expect(host.ownedChildren(projectId, 'fresh-root')).toEqual([]);
      expect(calls).toBe(boundary === 'stopping-response' ? 1 : 0);
      expect(team.teamState(projectId).messages).toHaveLength(1);
    } finally {
      currentGrant = oldGrant;
      late.resolve({ response: { type: 'final', text: 'Late response must not be accepted.' } });
      if (response) expect(await response).toBeInstanceOf(Error);
    }
    expect(host.ownedChildren(projectId, 'agent-root')[0].result).toBeNull();
    expect(wakeCalls).toBe(0);
  });
});
