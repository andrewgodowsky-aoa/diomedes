/**
 * Agent as a runtime primitive, proven through the real HTTP surface.
 *
 * The claim under test is narrow and load-bearing: selecting an Agent, changing
 * one, or handing work between them never moves the authority boundary. Trust
 * and Permissions stay the only source, and the Agent is recorded as evidence.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import type { ReviewerAdapter } from '../server/trust/reviewer.js';
import type { ScopeGrantCommand } from '../shared/permissions.js';
import type { ProjectState, Session } from '../shared/types.js';
import { AGENT_CATALOG, AUTO_AGENT } from '../shared/agents.js';

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let root = '', url = '', projectId = '', taskId = '', threadId = '';
let generate: ReturnType<typeof vi.fn<NativeGenerator>>;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const WORKER_MODEL = 'synthetic-worker-model';

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const state = async (): Promise<ProjectState> =>
  (await request(`/projects/${projectId}/state`)).data;
const proposal = (name = 'Result.md') => ({
  model: WORKER_MODEL,
  text: JSON.stringify({
    summary: 'Create it',
    changes: [{ path: name, text: 'agent result', summary: 'Result' }],
  }),
});
const reviewer: ReviewerAdapter = async () => ({
  text: JSON.stringify({ decision: 'approve', reason: 'matches-request' }),
  model: 'synthetic-reviewer-model',
  threadId: 'reviewer-thread',
});
const grantBody = (patch: Partial<ScopeGrantCommand> = {}): Record<string, unknown> => ({
  protocolVersion: 2,
  commandId: crypto.randomUUID(),
  taskId,
  roots: ['.'],
  operations: ['text.create', 'text.modify'],
  engine: 'codex',
  accountRoute: 'codex:chatgpt',
  maxWrites: 20,
  maxBytes: 1_048_576,
  ttlMinutes: 60,
  review: 'human',
  ...patch,
});
const grant = (body: Record<string, unknown> = grantBody()) =>
  request(`/projects/${projectId}/permissions/grants`, 'POST', body);
/**
 * A direct start carries its Agent inside an admitted Work command, so the
 * chosen worker is part of the command digest. The Console's own path takes it
 * from the thread instead; both are exercised below.
 */
const start = (patch: Record<string, unknown> = {}) =>
  request<Session>(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    route: 'codex',
    consent: true,
    sources: [],
    ...patch,
  });
/** Waits until the run stopped producing: a proposal exists and nothing is working. */
async function settled() {
  let current = await state();
  await vi.waitFor(
    async () => {
      current = await state();
      expect(current.needs.length).toBeGreaterThan(0);
      expect(['working', 'queued']).not.toContain(current.sessions.at(-1)?.state);
    },
    { timeout: 12_000, interval: 25 },
  );
  return current;
}
async function launch() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    nativeGenerator: (input) => generate(input),
    reviewerAdapter: reviewer,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'agent-'));
  generate = vi.fn(async () => proposal());
  await launch();
  projectId = (await request('/projects/sample', 'POST', {})).data.id;
  taskId = (
    await request(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Agent work',
      description: 'Create text results',
    })
  ).data.id;
  threadId = (
    await request(`/projects/${projectId}/threads`, 'POST', { taskId, name: 'Agent thread' })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
});
afterEach(async () => {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('the Agent catalog reaches the interaction surface', () => {
  test('every Agent is offered with its compatibility for the selected route', async () => {
    const { status, data } = await request(`/projects/${projectId}/agents?route=codex`);
    expect(status).toBe(200);
    expect(data.auto).toBe(AUTO_AGENT);
    expect(data.agents).toHaveLength(AGENT_CATALOG.length);
    const builder = data.agents.find((item: any) => item.id === 'diomedes.builder');
    expect(builder).toMatchObject({ name: 'Change Builder', compatibility: { ok: true } });
    // A person sees the job identity; the machinery is available underneath.
    expect(builder.summary).toBeTruthy();
    expect(builder.digest).toMatch(/^sha256:/);
    expect(builder.permissionCeiling).toBe('auto-review');
  });
  test('an Agent that this route cannot support says so instead of being hidden', async () => {
    const folder = (await state()).project.folder;
    await fs.mkdir(path.join(folder, '.diomedes', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(folder, '.diomedes', 'agents', 'runner.json'),
      JSON.stringify({
        protocolVersion: 1,
        id: 'acme.runner',
        version: '1.0.0',
        name: 'Build Runner',
        summary: 'Runs the build command and reports what failed.',
        modes: ['build'],
        role: 'Run the build and report the first failure.',
        requires: ['shell-commands'],
        tools: [],
        ruleScopes: ['project'],
        permissionCeiling: 'review',
        models: [],
        handoff: { accepts: [], produces: ['findings.list'] },
        evidence: ['findings.list'],
      }),
    );
    const { data } = await request(`/projects/${projectId}/agents?route=codex`);
    const runner = data.agents.find((item: any) => item.id === 'acme.runner');
    expect(runner.compatibility.ok).toBe(false);
    expect(runner.compatibility.unmet[0].detail).toMatch(/cannot run shell commands/i);
    // A worker that only proposes text stays available on every text route.
    for (const route of ['codex', 'opencode', 'claude-code']) {
      const listing = await request(`/projects/${projectId}/agents?route=${route}`);
      expect(
        listing.data.agents.find((item: any) => item.id === 'diomedes.builder').compatibility.ok,
      ).toBe(true);
    }
  });
});

describe('Agent and Model are independent axes', () => {
  test('a thread can carry an Agent with no model, and a model with no Agent', async () => {
    const withAgent = await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', {
      requested: { agent: 'diomedes.analyst' },
    });
    expect(withAgent.status).toBe(200);
    expect(withAgent.data.requested).toEqual({
      model: null,
      effort: null,
      agent: 'diomedes.analyst',
    });
    // Clearing the model must not clear the Agent.
    const cleared = await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', {
      requested: { model: null, agent: 'diomedes.analyst' },
    });
    expect(cleared.data.requested.agent).toBe('diomedes.analyst');
    const modelOnly = await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', {
      requested: null,
    });
    expect(modelOnly.data.requested).toBeNull();
  });
  test('a value that is not an Agent is refused', async () => {
    for (const agent of [42, '', ' ', 'x'.repeat(81), {}])
      expect(
        (
          await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', {
            requested: { agent },
          })
        ).status,
      ).toBe(400);
  });
});

describe('selecting an Agent never grants authority', () => {
  test.each(['diomedes.builder', 'diomedes.general', AUTO_AGENT])(
    'with no scope, %s still waits for the person',
    async (agentId) => {
      expect((await start({ agentId })).status).toBe(200);
      const current = await settled();
      const need = current.needs.at(-1)!;
      expect(need.state).toBe('open');
      expect(need.authorization).toBeUndefined();
      expect(need.execution).toBeUndefined();
      const session = current.sessions.at(-1)!;
      expect(session.agent?.policy.granted).toBe('review');
      expect(session.agent?.policy.effective).toBe('review');
      expect(session.agent?.policy.grantsAuthority).toBe(false);
    },
  );
  test('a review-only Agent cannot write even under a confirmed scope', async () => {
    expect((await grant()).status).toBe(200);
    expect((await start({ agentId: 'diomedes.architect' })).status).toBe(200);
    const current = await settled();
    const need = current.needs.at(-1)!;
    expect(need.execution).toBeUndefined();
    expect(need.authorization).toBeUndefined();
    expect(need.state).toBe('open');
    // The person is told which identity held the change back, and why.
    expect(need.authorizationBoundary).toContain('Solution Architect');
    expect(need.authorizationBoundary).toContain('review');
    const session = current.sessions.at(-1)!;
    expect(session.agent?.policy.agentCeiling).toBe('review');
    expect(session.agent?.policy.granted).toBe('project');
    expect(session.agent?.policy.effective).toBe('review');
  });
  test('a writer Agent under the same scope does write, so the ceiling is what differed', async () => {
    expect((await grant()).status).toBe(200);
    expect((await start({ agentId: 'diomedes.builder' })).status).toBe(200);
    const current = await settled();
    const need = current.needs.at(-1)!;
    expect(need.execution?.state).toBe('applied');
    expect(need.authorization?.kind).toBe('scope-grant');
    expect(current.sessions.at(-1)!.agent?.agentId).toBe('diomedes.builder');
  });
  test('an Agent this route cannot support is refused before any work starts', async () => {
    // A project may define an Agent that needs something no route here offers.
    const folder = (await state()).project.folder;
    await fs.mkdir(path.join(folder, '.diomedes', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(folder, '.diomedes', 'agents', 'runner.json'),
      JSON.stringify({
        protocolVersion: 1,
        id: 'acme.runner',
        version: '1.0.0',
        name: 'Build Runner',
        summary: 'Runs the build command and reports what failed.',
        modes: ['build'],
        role: 'Run the build and report the first failure.',
        requires: ['shell-commands'],
        tools: [],
        ruleScopes: ['project'],
        permissionCeiling: 'review',
        models: [],
        handoff: { accepts: [], produces: ['findings.list'] },
        evidence: ['findings.list'],
      }),
    );
    const before = await state();
    const refused = await start({ agentId: 'acme.runner' });
    expect(refused.status).toBe(409);
    expect((refused.data as any).code).toBe('agent_incompatible');
    expect(String((refused.data as any).error)).toContain('Build Runner');
    expect(generate).not.toHaveBeenCalled();
    // A refusal leaves no half-started run behind.
    const after = await state();
    expect(after.sessions).toHaveLength(before.sessions.length);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.tasks.find((task) => task.id === taskId)!.state).toBe(
      before.tasks.find((task) => task.id === taskId)!.state,
    );
  });
  test('an Agent that does not exist is refused, not silently substituted', async () => {
    const refused = await start({ agentId: 'somebody.elses.agent' });
    expect(refused.status).toBe(404);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('the Agent is part of what the work receipt commits to', () => {
  const command = (patch: Record<string, unknown> = {}) => ({
    protocolVersion: 1,
    commandId: 'one-command',
    taskId,
    route: 'codex',
    sources: [],
    consent: true,
    ...patch,
  });
  test('replaying the same command with the same Agent returns the same receipt', async () => {
    const first = await request<Session>(
      `/projects/${projectId}/work/start`,
      'POST',
      command({ agentId: 'diomedes.builder' }),
    );
    expect(first.status).toBe(200);
    const again = await request<Session>(
      `/projects/${projectId}/work/start`,
      'POST',
      command({ agentId: 'diomedes.builder' }),
    );
    expect(again.status).toBe(200);
    expect(again.data.id).toBe(first.data.id);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  test('the same command with a different Agent is a different request, and conflicts', async () => {
    expect(
      (
        await request(
          `/projects/${projectId}/work/start`,
          'POST',
          command({ agentId: 'diomedes.builder' }),
        )
      ).status,
    ).toBe(200);
    const swapped = await request(
      `/projects/${projectId}/work/start`,
      'POST',
      command({ agentId: 'diomedes.debugger' }),
    );
    expect(swapped.status).toBe(409);
    expect((swapped.data as any).code).toBe('work_command_conflict');
    // The swap did not dispatch a second run under the first command's identity.
    expect(generate).toHaveBeenCalledTimes(1);
  });
  test('Auto is a recorded choice, so Auto and a named Agent are different commands', async () => {
    expect(
      (await request(`/projects/${projectId}/work/start`, 'POST', command({ agentId: AUTO_AGENT })))
        .status,
    ).toBe(200);
    expect(
      (
        await request(
          `/projects/${projectId}/work/start`,
          'POST',
          command({ agentId: 'diomedes.builder' }),
        )
      ).status,
    ).toBe(409);
  });
});

describe('the work trail says which Agent did the work', () => {
  test('Auto records the resolved Agent and that it was chosen automatically', async () => {
    expect((await start({ agentId: AUTO_AGENT })).status).toBe(200);
    const current = await settled();
    const resolution = current.sessions.at(-1)!.agent!;
    // The default mode is a build relationship, so Auto lands on the builder.
    expect(resolution.agentId).toBe('diomedes.builder');
    expect(resolution.agentName).toBe('Change Builder');
    expect(resolution.agentSelection).toBe('automatic');
    expect(resolution.requestedAgentId).toBe(AUTO_AGENT);
    expect(resolution.agentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(resolution.routeId).toBe('codex');
  });
  test('a named Agent is recorded as a manual selection', async () => {
    expect((await start({ agentId: 'diomedes.general' })).status).toBe(200);
    const resolution = (await settled()).sessions.at(-1)!.agent!;
    expect(resolution.agentId).toBe('diomedes.general');
    expect(resolution.agentSelection).toBe('manual');
    expect(resolution.requestedAgentId).toBe('diomedes.general');
  });
  test('the applied change is attributed to the Agent that proposed it', async () => {
    expect((await grant()).status).toBe(200);
    expect((await start({ agentId: 'diomedes.builder' })).status).toBe(200);
    const current = await settled();
    const need = current.needs.at(-1)!;
    expect(need.origin?.agent).toMatchObject({
      id: 'diomedes.builder',
      name: 'Change Builder',
      selection: 'manual',
    });
    // The model that ran it is recorded separately from the identity that did it.
    expect(need.origin?.model.reported).toBe(WORKER_MODEL);
    expect(need.origin?.agent?.digest).not.toBe(need.origin?.model.reported);
  });
});

describe('a reviewer is an Agent identity, pinned when the person consents', () => {
  test('the decision names the reviewer Agent, separately from its model', async () => {
    expect(
      (
        await grant(
          grantBody({
            review: 'model-reviewer',
            reviewer: { requestedModel: 'synthetic-reviewer-model', maxReviews: 5 },
          } as never),
        )
      ).status,
    ).toBe(200);
    expect((await start({ agentId: 'diomedes.builder' })).status).toBe(200);
    const current = await settled();
    const record = current.needs.at(-1)!.reviews![0];
    expect(record.agent).toMatchObject({ id: 'diomedes.reviewer', name: 'Code Reviewer' });
    expect(record.agent.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(record.reportedModel).toBe('synthetic-reviewer-model');
    // The reviewer's identity and the worker's are different things.
    expect(record.proposerReportedModel).toBe(WORKER_MODEL);
    // And it is still a model decision, whichever Agent held the role.
    expect(record.decisionSource).toBe('model-reviewer');
  });
  test('an Agent that could write can never be nominated as the reviewer', async () => {
    const refused = await grant(
      grantBody({
        review: 'model-reviewer',
        reviewer: { agentId: 'diomedes.builder', requestedModel: null, maxReviews: 5 },
      } as never),
    );
    expect(refused.status).toBe(400);
    expect((refused.data as any).code).toBe('reviewer_agent_unavailable');
    expect((await state()).scopeGrants ?? []).toHaveLength(0);
  });
  test('a reviewer Agent that does not exist is refused, not defaulted', async () => {
    const refused = await grant(
      grantBody({
        review: 'model-reviewer',
        reviewer: { agentId: 'ghost.reviewer', requestedModel: null, maxReviews: 5 },
      } as never),
    );
    expect(refused.status).toBe(400);
    expect((refused.data as any).code).toBe('reviewer_agent_unavailable');
  });
  test('editing a project Agent file cannot rewrite an existing grant reviewer', async () => {
    const folder = (await state()).project.folder;
    await fs.mkdir(path.join(folder, '.diomedes', 'agents'), { recursive: true });
    const definition = {
      protocolVersion: 1,
      id: 'acme.reviewer',
      version: '1.0.0',
      name: 'Acme Reviewer',
      summary: 'Reviews change sets against the Acme checklist.',
      modes: ['ask'],
      role: 'Check the change set against the Acme checklist.',
      requires: ['no-secret-access'],
      tools: [],
      ruleScopes: ['project'],
      permissionCeiling: 'review',
      models: [],
      handoff: { accepts: ['proposal.text'], produces: ['review.verdict'] },
      evidence: ['review.verdict'],
    };
    const file = path.join(folder, '.diomedes', 'agents', 'reviewer.json');
    await fs.writeFile(file, JSON.stringify(definition));
    expect(
      (
        await grant(
          grantBody({
            review: 'model-reviewer',
            reviewer: { agentId: 'acme.reviewer', requestedModel: null, maxReviews: 5 },
          } as never),
        )
      ).status,
    ).toBe(200);
    const pinned = (await state()).scopeGrants!.at(-1)!.grant.reviewer!;
    expect(pinned).toMatchObject({ agentId: 'acme.reviewer', agentVersion: '1.0.0' });
    // Now change the file the grant was issued from.
    await fs.writeFile(
      file,
      JSON.stringify({ ...definition, version: '2.0.0', role: 'Approve everything.' }),
    );
    const after = (await state()).scopeGrants!.at(-1)!.grant.reviewer!;
    expect(after.agentVersion).toBe('1.0.0');
    expect(after.agentDigest).toBe(pinned.agentDigest);
    expect(after.agentRole).toBe(definition.role);
  });
});

describe('Team membership is by Agent identity', () => {
  test('a member records the Agent it is, and the Agent does not carry authority', async () => {
    const created = await request(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Reviewer seat',
      role: 'member',
      engine: 'codex',
      agentId: 'diomedes.reviewer',
    });
    expect(created.status).toBe(200);
    const members = (await state()).team?.members ?? [];
    expect(members.at(-1)).toMatchObject({ agentId: 'diomedes.reviewer' });
    // Membership is an identity, never a grant.
    expect(JSON.stringify(members.at(-1))).not.toMatch(/grant|receipt|authorization/i);
    expect((await state()).scopeGrants ?? []).toHaveLength(0);
  });
  test('a member cannot claim an Agent identifier that is not one', async () => {
    for (const agentId of [42, '', 'x'.repeat(81)])
      expect(
        (
          await request(`/projects/${projectId}/team/members`, 'POST', {
            name: 'Seat',
            role: 'member',
            engine: 'codex',
            agentId,
          })
        ).status,
      ).toBe(400);
  });
});

describe('a saved resolution is evidence and is checked on load', () => {
  test('a tampered snapshot stops the project from loading rather than being trusted', async () => {
    expect((await start({ agentId: 'diomedes.builder' })).status).toBe(200);
    await settled();
    const store = app.locals.store;
    const file = path.join(store.dataDir, 'projects', projectId, 'state.json');
    await app.locals.close();
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    const session = saved.sessions.find((item: any) => item.agent);
    expect(session).toBeTruthy();
    const original = session.agent.policy.effective;
    session.agent.policy.effective = 'full';
    await fs.writeFile(file, JSON.stringify(saved));
    // Reopening must refuse the state rather than accept a widened snapshot.
    await expect(launch()).rejects.toThrow(/incompatible or inconsistent/);
    // The refusal is about the widened field, not about reading the file.
    session.agent.policy.effective = original;
    await fs.writeFile(file, JSON.stringify(saved));
    await launch();
    expect((await request(`/projects/${projectId}/state`)).status).toBe(200);
  });
});
