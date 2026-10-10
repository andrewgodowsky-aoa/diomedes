import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { AccountAgentGate, AGENT_NOT_INCLUDED, type AdmittedAgentWork, type AgentWork } from '../server/accounts/agent-gate.js';
import { EngineError } from '../server/engines/process.js';
import { EngineService } from '../server/engines/service.js';
import type { JevAdvisor, PreflightAdvice } from '../server/harness/jev-advisor.js';
import type { Conversation } from '../shared/types.js';

/**
 * DIO-292: `POST .../agent-pick` answers which agent takes one message and the route it would
 * take, before anything is sent. It reads only.
 */
let server: Server, app: Awaited<ReturnType<typeof createApp>>, temp: string, url: string;
const jsonHeaders = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function call(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: jsonHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

/** What Jev would choose from the shortlist it is offered, or nothing. */
let advised: string | null = null;
const offered: string[][] = [];
const admitted: AdmittedAgentWork = {
  admissionId: 'fixture-advisor-admission',
  organizationId: null,
  personId: 'fixture-person',
  planId: 'individual',
  policyRevision: 1,
  routeKind: 'byo',
  surface: 'other',
  validUntil: '2099-01-01T00:00:00Z',
};
const admitAdvisor = vi.fn<(work: AgentWork) => Promise<AdmittedAgentWork>>();
let agentGate: AccountAgentGate;
const advisor: JevAdvisor = {
  preflight: async (input) => {
    offered.push(input.shortlist.map((item) => item.id));
    return {
      status: 'advised',
      hints: { shortlist: advised && input.shortlist.some((item) => item.id === advised) ? advised : null },
    } as unknown as PreflightAdvice;
  },
};

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'agent-pick-'));
  advised = null;
  offered.length = 0;
  admitAdvisor.mockReset();
  admitAdvisor.mockResolvedValue(admitted);
  agentGate = new AccountAgentGate(
    { personalIncludes: () => true, personalUnknown: () => false } as never,
    { projectOwner: () => null, active: () => ({ kind: 'personal' }) } as never,
    { scopeFor: () => null, admit: admitAdvisor } as never,
  );
  const engines = new EngineService(path.join(temp, 'engines'), { discover: async () => [] });
  engines.agentGate = agentGate;
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
    jevAdvisor: advisor,
    engineService: engines,
    accounts: null,
    managedJev: false,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  const closingApp = app, closingServer = server;
  await closingApp.locals.close();
  closingServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => closingServer.close((error) => (error ? reject(error) : resolve())));
  await fs.rm(temp, { recursive: true, force: true });
});

const pick = (projectId: string, threadId: string, text: string, attachments: string[] = [], extra = {}) =>
  call(`/projects/${projectId}/threads/${threadId}/agent-pick`, 'POST', { text, attachments, ...extra });
async function thread(engine: string, agent?: string) {
  const project = await call('/projects/sample', 'POST', {});
  expect(project.status).toBe(200);
  const created = await call(`/projects/${project.data.id}/threads`, 'POST', {});
  expect(created.status).toBe(201);
  expect((await call(`/projects/${project.data.id}/threads/${created.data.id}`, 'PUT', { engine })).status).toBe(200);
  if (agent)
    expect(
      (await call(`/projects/${project.data.id}/threads/${created.data.id}`, 'PUT', { requested: { model: null, effort: null, agent } }))
        .status,
    ).toBe(200);
  return { projectId: project.data.id as string, threadId: created.data.id as string };
}

test('a chosen agent is answered as it stands, with its kind and route', async () => {
  const t = await thread('codex', 'diomedes.reviewer');
  const answer = (await pick(t.projectId, t.threadId, 'hi')).data;
  expect(answer).toMatchObject({ agent: { id: 'diomedes.reviewer', name: 'Reviewer' }, mode: 'ask', by: 'chosen', route: 'codex', refusal: null });
});

test('Auto hands a failure with its file to Fixer', async () => {
  const t = await thread('codex');
  const answer = (await pick(t.projectId, t.threadId, 'The Friday sales total is off by a day.', ['sales_day.py'])).data;
  expect(answer).toMatchObject({ agent: { id: 'diomedes.debugger', name: 'Fixer' }, mode: 'fix', by: 'rule' });
});

test('a rule pick completes without entering a delayed advisor admission', async () => {
  const t = await thread('codex');
  const check = vi.spyOn(agentGate, 'check');
  let started!: () => void, release!: (value: AdmittedAgentWork) => void;
  const enteringAdmission = new Promise<void>((resolve) => { started = resolve; });
  const heldAdmission = new Promise<AdmittedAgentWork>((resolve) => { release = resolve; });
  admitAdvisor.mockImplementation(() => { started(); return heldAdmission; });
  const pending = pick(t.projectId, t.threadId, 'hi');
  // No timing threshold: the rule must answer before the account service is entered.
  const first = await Promise.race([
    pending.then(() => 'picked'),
    enteringAdmission.then(() => 'admitting'),
  ]);
  release(admitted);
  const answer = await pending;
  expect(first).toBe('picked');
  expect(answer.status).toBe(200);
  expect(answer.data).toMatchObject({ agent: { id: 'auto' }, by: 'rule' });
  expect(check).not.toHaveBeenCalled();
  expect(admitAdvisor).not.toHaveBeenCalled();
  expect(offered).toEqual([]);
});

test('a rule pick never asks a refusing advisor gate', async () => {
  const t = await thread('codex');
  const check = vi.spyOn(agentGate, 'check');
  admitAdvisor.mockRejectedValue(new EngineError(AGENT_NOT_INCLUDED, 'Fixture admission refused. Nothing was sent.', false));
  const answer = await pick(t.projectId, t.threadId, 'The Friday sales total is off by a day.', ['sales_day.py']);
  expect(answer.status).toBe(200);
  expect(answer.data).toMatchObject({ agent: { id: 'diomedes.debugger' }, by: 'rule' });
  expect(check).not.toHaveBeenCalled();
  expect(admitAdvisor).not.toHaveBeenCalled();
  expect(offered).toEqual([]);
});

test('Auto answers small talk itself where it has a conversation, and sends it to Researcher where it has none', async () => {
  const codex = await thread('codex');
  expect((await pick(codex.projectId, codex.threadId, 'hi')).data).toMatchObject({ agent: { id: 'auto', name: 'Auto' }, mode: 'auto' });
  const claude = await thread('claude-code');
  expect((await pick(claude.projectId, claude.threadId, 'hi')).data).toMatchObject({ agent: { id: 'diomedes.researcher' }, mode: 'ask' });
  // The Agent view has a conversation on every route, Claude Code's own session included.
  expect((await pick(claude.projectId, claude.threadId, 'hi', [], { conversationOnly: true })).data).toMatchObject({
    agent: { id: 'auto' },
    mode: 'auto',
  });
});

test('with an image, or from the Agent view, Auto never picks an agent that changes files', async () => {
  const t = await thread('codex');
  const image = (await pick(t.projectId, t.threadId, 'Add this photo to the gallery page.', ['gallery.html', 'photo.png'])).data;
  expect(['ask', 'plan', 'auto']).toContain(image.mode);
  const view = (await pick(t.projectId, t.threadId, 'The total is off by a day.', ['sales_day.py'], { conversationOnly: true })).data;
  expect(['ask', 'plan', 'auto']).toContain(view.mode);
});

test("Jev decides when the words don't, and only from the shortlist", async () => {
  const t = await thread('codex');
  advised = 'diomedes.analyst';
  expect((await pick(t.projectId, t.threadId, 'Review the plan and chart the sales.')).data).toMatchObject({ agent: { id: 'diomedes.analyst' }, by: 'jev' });
  expect(offered[0]).not.toContain('diomedes.general');
  advised = 'diomedes.general';
  expect((await pick(t.projectId, t.threadId, 'Review the plan and chart the sales.')).data).toMatchObject({ agent: { id: 'auto' }, by: 'default' });
});

test('an ambiguous pick waits for advisor admission before asking Jev', async () => {
  const t = await thread('codex');
  const check = vi.spyOn(agentGate, 'check');
  advised = 'diomedes.analyst';
  let started!: () => void, release!: (value: AdmittedAgentWork) => void;
  const enteringAdmission = new Promise<void>((resolve) => { started = resolve; });
  const heldAdmission = new Promise<AdmittedAgentWork>((resolve) => { release = resolve; });
  admitAdvisor.mockImplementation(() => { started(); return heldAdmission; });
  const pending = pick(t.projectId, t.threadId, 'Review the plan and chart the sales.');
  try {
    await enteringAdmission;
    expect(check).toHaveBeenCalledExactlyOnceWith({ phase: 'admit', surface: 'other', projectId: t.projectId, rootJobId: null, routeKind: 'byo' });
    expect(offered).toEqual([]);
  } finally {
    release(admitted);
  }
  const answer = await pending;
  expect(answer.status).toBe(200);
  expect(answer.data).toMatchObject({ agent: { id: 'diomedes.analyst' }, by: 'jev' });
  expect(admitAdvisor).toHaveBeenCalledOnce();
  expect(offered).toHaveLength(1);
});

test('a refused ambiguous pick uses its safe default without asking Jev', async () => {
  const t = await thread('codex');
  const check = vi.spyOn(agentGate, 'check');
  advised = 'diomedes.analyst';
  admitAdvisor.mockRejectedValue(new EngineError(AGENT_NOT_INCLUDED, 'Fixture admission refused. Nothing was sent.', false));
  const answer = await pick(t.projectId, t.threadId, 'Review the plan and chart the sales.');
  expect(answer.status).toBe(200);
  expect(answer.data).toMatchObject({ agent: { id: 'auto' }, by: 'default' });
  expect(check).toHaveBeenCalledExactlyOnceWith({ phase: 'admit', surface: 'other', projectId: t.projectId, rootJobId: null, routeKind: 'byo' });
  expect(admitAdvisor).toHaveBeenCalledOnce();
  expect(offered).toEqual([]);
});

test("on Auto, an agent that only reads rides Auto's own lane wherever Auto answers in the conversation", async () => {
  const codex = await thread('codex');
  expect((await pick(codex.projectId, codex.threadId, 'Where is the linen order?')).data).toMatchObject({
    agent: { id: 'diomedes.explorer', name: 'Explorer' },
    mode: 'auto',
    by: 'rule',
    route: 'codex',
  });
  expect((await pick(codex.projectId, codex.threadId, 'Make me a plan for the reopening.')).data).toMatchObject({
    agent: { id: 'diomedes.architect' },
    mode: 'auto',
  });
  // Where Auto has no conversation, the agent takes its own kind's path.
  const claude = await thread('claude-code');
  expect((await pick(claude.projectId, claude.threadId, 'Where is the linen order?')).data).toMatchObject({
    agent: { id: 'diomedes.explorer' },
    mode: 'ask',
  });
  // An agent the person chose keeps its own kind and its own lane.
  const chosen = await thread('codex', 'diomedes.explorer');
  expect((await pick(chosen.projectId, chosen.threadId, 'Where is the linen order?')).data).toMatchObject({ mode: 'ask', by: 'chosen' });
});

test('a message as long as the messages route takes is picked for', async () => {
  const t = await thread('codex');
  expect((await pick(t.projectId, t.threadId, 'x'.repeat(20000))).status).toBe(200);
  expect((await pick(t.projectId, t.threadId, 'x'.repeat(32001))).status).toBe(400);
});

test('a profile saved with the general worker, which left the menu, is on Auto', async () => {
  const t = await thread('codex');
  const profile = await call('/agent-profiles', 'POST', {
    name: 'General help',
    engine: 'codex',
    model: 'gpt-6-astra',
    effort: null,
    agentId: 'diomedes.general',
    rules: [],
  });
  expect(profile.status).toBe(200);
  expect(
    (await call(`/projects/${t.projectId}/threads/${t.threadId}`, 'PUT', {
      requested: { model: null, effort: null, profile: profile.data.profileId },
    })).status,
  ).toBe(200);
  const answer = await pick(t.projectId, t.threadId, 'hi');
  expect(answer.status).toBe(200);
  expect(answer.data).toMatchObject({ agent: { id: 'auto' }, mode: 'auto' });
});

test('picking changes nothing on the thread', async () => {
  const t = await thread('codex');
  const read = () =>
    structuredClone(app.locals.store.state(t.projectId).conversations.find((c: Conversation) => c.id === t.threadId));
  const before = read();
  await pick(t.projectId, t.threadId, 'The Friday sales total is off by a day.', ['sales_day.py']);
  expect(read()).toEqual(before);
});

test('a malformed pick is refused', async () => {
  const t = await thread('codex');
  expect((await call(`/projects/${t.projectId}/threads/${t.threadId}/agent-pick`, 'POST', {})).status).toBe(400);
  expect((await pick(t.projectId, t.threadId, 'hi', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])).status).toBe(400);
  expect((await call(`/projects/${t.projectId}/threads/nope/agent-pick`, 'POST', { text: 'hi' })).status).toBe(404);
});
