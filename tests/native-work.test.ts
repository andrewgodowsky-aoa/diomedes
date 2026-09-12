import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProjectState, TeamMember } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { extractJsonObject, parseProposal, type NativeGenerator } from '../server/native-work.js';
import {
  createIntegrations,
  IntegrationError,
  nativeEnvironment,
  type NativeRpc,
  type NativeTeamOptions,
} from '../server/integrations.js';
import { roleInstructions } from '../server/team/prompts.js';

type NativeResult = Awaited<ReturnType<NativeGenerator>>;
function deferred() {
  let resolve!: (result: NativeResult) => void;
  const promise = new Promise<NativeResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const proposal = (
  changes: { path: string; text: string | null; summary: string }[],
  summary = 'Update the selected work',
) => ({ text: JSON.stringify({ summary, changes }), model: 'test-model' });
const update = {
  path: 'Fall menu.md',
  text: '# Fall menu\n\nA revised menu.\n',
  summary: 'Rewrite the menu description',
};
const created = {
  path: 'Announcement.md',
  text: '# Announcement\n\nThe patio is reopening.\n',
  summary: 'Draft a reopening announcement',
};
let server: Server,
  app: Awaited<ReturnType<typeof createApp>>,
  temp: string,
  url: string,
  projectId: string,
  taskId: string;
let invoke: NativeGenerator;
let generator: ReturnType<typeof vi.fn<NativeGenerator>>;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
const state = async (): Promise<ProjectState> =>
  (await request(`/projects/${projectId}/state`)).data;
// The explicit list awaits a fresh walk; /state serves the cache.
const documentsOf = async () => {
  const result = await request(`/projects/${projectId}/documents`);
  expect(result.status).toBe(200);
  return result.data.documents;
};
const start = (sources = ['Fall menu.md']) =>
  request(`/projects/${projectId}/work/start`, 'POST', {
    taskId,
    route: 'codex',
    consent: true,
    sources,
  });
const team: NativeTeamOptions = {
  url: 'http://127.0.0.1:4321/mcp/team/test-project',
  tokenEnv: 'DIOMEDES_TEAM_TEST_TOKEN',
  slotId: 'test-member',
  role: 'member',
  roleInstructions: 'Report progress to the lead through team_send_message.',
};
// Standalone adapter callers may still manage their own team options.
const startTeam = (options: NativeTeamOptions = team) =>
  app.locals.store.locked(() =>
    app.locals.nativeWork.start(projectId, taskId, {
      sources: ['Fall menu.md'],
      consent: true,
      team: options,
    }),
  );
async function until(predicate: (state: ProjectState) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await state();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Native proposal work did not reach its expected state.');
}
const waiting = () => until((result) => result.needs.some((need) => need.state === 'open'));
const decision = async (needId: string, resolution: 'go-ahead' | 'declined', allowForTask = false) => {
  const need = (await state()).needs.find((item) => item.id === needId)!;
  return request(`/projects/${projectId}/needs/${needId}/resolve`, 'POST', {
    protocolVersion: 1, commandId: crypto.randomUUID(), resolution, allowForTask,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest, baseDigest: need.approval!.baseDigest,
  });
};

// Protocol fake: exercises the real adapter without launching Codex.
class TeamAppServer implements NativeRpc {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  teamEnabled = false;
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    switch (method) {
      case 'initialize':
        return { userAgent: 'diomedes/0.153.4 (Windows 10)' };
      case 'account/read':
        return { requiresOpenaiAuth: true, account: { type: 'chatgpt' } };
      case 'config/read':
        return {
          config: {
            mcp_servers: {
              inherited: { command: 'never-run' },
              'server.with.dot': { url: 'https://example.invalid' },
            },
          },
        };
      case 'thread/start':
        this.teamEnabled = JSON.stringify(params.config).includes('diomedes_team');
        return {
          thread: { id: 'fake-member-thread' },
          model: 'fake-model',
          modelProvider: 'openai',
          sandbox: { type: 'readOnly', networkAccess: false },
          approvalPolicy: 'never',
        };
      case 'mcpServerStatus/list':
        return {
          data: [
            ...['inherited', 'server.with.dot'].map((name) => ({
              name,
              runtimeStatus: 'disabled',
              tools: {},
              resources: [],
              resourceTemplates: [],
            })),
            ...(this.teamEnabled
              ? [
                  {
                    name: 'diomedes_team',
                    runtimeStatus: 'connected',
                    tools: { team_members: { name: 'team_members' } },
                  },
                ]
              : []),
          ],
          nextCursor: null,
        };
      case 'turn/start':
        return { turn: { id: 'fake-member-turn' } };
      default:
        throw new Error(`Unexpected fake request: ${method}`);
    }
  }
  notify() {}
  onNotification(listener: (method: string, params: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(method: string, params: Record<string, unknown>) {
    for (const listener of this.listeners) listener(method, params);
  }
  finish(result = proposal([])) {
    this.emit('item/completed', {
      threadId: 'fake-member-thread',
      item: { type: 'agentMessage', text: result.text },
    });
    this.emit('turn/completed', { threadId: 'fake-member-thread', turn: { status: 'completed' } });
  }
  async close() {
    this.emit('diomedes/error', { message: 'Fake app-server closed.' });
  }
}

function fakeAdapter() {
  const client = new TeamAppServer();
  const createClient = vi.fn(async (_env?: NodeJS.ProcessEnv) => client);
  invoke = createIntegrations({
    createClient,
    verifySandbox: async () => {},
    turnTimeoutMs: 10000,
  }).askCodex;
  return { client, createClient };
}
async function member(engine: TeamMember['engine'] = 'codex', role: TeamMember['role'] = 'lead') {
  const result = await request(`/projects/${projectId}/team/members`, 'POST', {
    name: 'Astra',
    role,
    engine,
  });
  expect(result.status).toBe(200);
  const value: { member: TeamMember; token: string } = result.data;
  return {
    ...value,
    tokenEnv: `DIOMEDES_TEAM_${value.member.slotId.toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
  };
}
async function startMember(threadId: string | null, route: 'ask' | 'work/start' = 'work/start') {
  return request(`/projects/${projectId}/${route}`, 'POST', {
    taskId,
    threadId,
    route: 'codex',
    mode: 'work',
    text: 'Coordinate the reopening proposal.',
    consent: true,
    sources: [],
  });
}
async function assertPrivate(token: string) {
  const current = await state();
  expect(JSON.stringify(current)).not.toContain(token);
  expect(JSON.stringify((await request(`/projects/${projectId}/team`)).data)).not.toContain(token);
  expect(JSON.stringify(current.sessions.map((session) => session.log))).not.toContain(token);
  expect(JSON.stringify(current.history)).not.toContain(token);
}

describe('member thread to real adapter glue', () => {
  test.each(['ask', 'work/start'] as const)(
    '%s forwards team config and tracks completion',
    async (route) => {
      const identity = await member();
      const fake = fakeAdapter();
      const transitions: { member: string; run: string }[] = [];
      app.locals.store.on('change', (id: string) => {
        if (id !== projectId) return;
        const team = app.locals.store.state(id).team;
        if (team.runs[0])
          transitions.push({ member: team.members[0].status, run: team.runs[0].status });
      });
      const response = await startMember(identity.member.threadId, route);
      expect(response.status).toBe(200);
      const session = route === 'ask' ? response.data.session : response.data;
      expect(session.slotId).toBe(identity.member.slotId);
      await vi.waitFor(() =>
        expect(fake.client.calls.some((call) => call.method === 'turn/start')).toBe(true),
      );
      expect(fake.createClient).toHaveBeenCalledExactlyOnceWith(
        {
          ...nativeEnvironment(),
          [identity.tokenEnv]: identity.token,
        },
        { 'features.code_mode_host': true },
      );
      expect(process.env[identity.tokenEnv]).toBe(identity.token);
      const config = fake.client.calls.find((call) => call.method === 'thread/start')?.params
        .config;
      expect(config).toMatchObject({
        mcp_servers: {
          inherited: { enabled: false },
          'server.with.dot': { enabled: false },
          diomedes_team: {
            url: `${url}/mcp/team/${projectId}`,
            bearer_token_env_var: identity.tokenEnv,
            enabled: true,
            http_headers: { 'X-Slot-Id': identity.member.slotId },
            required: true,
          },
        },
        developer_instructions: roleInstructions('lead', identity.member, (await state()).project),
      });
      expect(JSON.stringify(config)).toContain('You are Astra, the leader');
      expect(JSON.stringify(config)).not.toContain(identity.token);
      const observedTeam = generator.mock.calls[0][0].team!;
      const roster = await fetch(observedTeam.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${fake.createClient.mock.calls[0][0]?.[observedTeam.tokenEnv]}`,
          'X-Slot-Id': observedTeam.slotId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'team_members', arguments: {} },
        }),
      });
      expect(roster.status).toBe(200);
      const rosterText = await roster.text();
      expect(rosterText).toContain('Astra');
      expect(rosterText).not.toContain(identity.token);
      // Record only public configuration for the integration handoff evidence.
      if (route === 'work/start')
        console.info('Fake app-server team configuration:', JSON.stringify(observedTeam));
      await assertPrivate(identity.token);
      fake.client.emit('item/completed', {
        threadId: 'fake-member-thread',
        item: {
          type: 'mcpToolCall',
          server: 'diomedes_team',
          tool: 'team_members',
          arguments: { secret: identity.token },
          result: identity.token,
        },
      });
      fake.client.finish();
      const completed = await until((current) => current.sessions[0].state === 'done');
      expect(completed.team?.members[0]).toMatchObject({
        status: 'idle',
        lastSeenAt: expect.any(String),
      });
      expect(completed.team?.runs).toEqual([
        expect.objectContaining({
          slotId: identity.member.slotId,
          sessionId: session.id,
          status: 'completed',
          startedAt: expect.any(String),
          endedAt: expect.any(String),
          summary: expect.any(String),
        }),
      ]);
      expect(transitions).toEqual(
        expect.arrayContaining([
          { member: 'working', run: 'accepted' },
          { member: 'working', run: 'running' },
          { member: 'idle', run: 'completed' },
        ]),
      );
      expect(process.env[identity.tokenEnv]).toBeUndefined();
      await assertPrivate(identity.token);
    },
  );

  test.each(['unowned', 'other-engine'] as const)(
    '%s thread keeps all MCP disabled',
    async (kind) => {
      const identity = await member('claude-code');
      const threadId =
        kind === 'other-engine'
          ? identity.member.threadId
          : (await request(`/projects/${projectId}/threads`, 'POST', { name: 'Ordinary thread' }))
              .data.id;
      const fake = fakeAdapter();
      const response = await startMember(threadId);
      expect(response.status).toBe(200);
      await vi.waitFor(() =>
        expect(fake.client.calls.some((call) => call.method === 'turn/start')).toBe(true),
      );
      expect(generator.mock.calls[0][0]).not.toHaveProperty('team');
      expect(fake.createClient).toHaveBeenCalledExactlyOnceWith();
      expect(
        fake.client.calls.find((call) => call.method === 'thread/start')?.params.config,
      ).toMatchObject({
        mcp_servers: { inherited: { enabled: false }, 'server.with.dot': { enabled: false } },
      });
      expect(fake.client.teamEnabled).toBe(false);
      expect(process.env[identity.tokenEnv]).toBeUndefined();
      fake.client.finish();
      const completed = await until((current) => current.sessions[0].state === 'done');
      expect(completed.sessions[0]).not.toHaveProperty('slotId');
      expect(completed.team?.runs).toEqual([]);
      expect(completed.team?.members[0].status).toBe('idle');
    },
  );

  test.each(['go-ahead', 'declined'] as const)(
    'waits for approval, then handles %s and releases token',
    async (resolution) => {
      const identity = await member('codex', 'member');
      const gate = deferred();
      invoke = () => gate.promise;
      await startMember(identity.member.threadId);
      expect(generator.mock.calls[0][0].team?.roleInstructions).toContain(
        'Never mark a task completed while an approval is still open.',
      );
      gate.resolve(proposal([created]));
      const ready = await waiting();
      expect(ready.team?.members[0]).toMatchObject({
        status: 'waiting',
        lastSeenAt: expect.any(String),
      });
      expect(ready.team?.runs[0]).toMatchObject({ status: 'running', endedAt: null });
      expect(process.env[identity.tokenEnv]).toBe(identity.token);
      expect((await decision(ready.needs[0].id, resolution)).status).toBe(200);
      const completed = await state();
      expect(completed.team?.members[0].status).toBe('idle');
      expect(completed.team?.runs[0].status).toBe(
        resolution === 'go-ahead' ? 'completed' : 'cancelled',
      );
      expect(process.env[identity.tokenEnv]).toBeUndefined();
      await assertPrivate(identity.token);
    },
  );

  test('failed generation redacts token echoes and records failure', async () => {
    const identity = await member();
    invoke = async () => {
      throw new Error(`Synthetic failure ${identity.token}`);
    };
    await startMember(identity.member.threadId);
    const failed = await until((current) => current.sessions[0].state === 'failed');
    expect(failed.team?.members[0].status).toBe('error');
    expect(failed.team?.runs[0]).toMatchObject({ status: 'failed', endedAt: expect.any(String) });
    expect(process.env[identity.tokenEnv]).toBeUndefined();
    await assertPrivate(identity.token);
  });

  test('redacts token echoes in proposal text and decoded JSON before persistence', async () => {
    const identity = await member();
    const escapedToken = [...identity.token]
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('');
    invoke = async () => ({
      text: `{"summary":"${escapedToken}","changes":[]}`,
      model: identity.token,
    });
    await startMember(identity.member.threadId);
    const completed = await until((current) => current.sessions[0].state === 'done');
    expect(completed.team?.runs[0].summary).toBe('[redacted]');
    expect(completed.sessions[0].engine.model).toBe('[redacted]');
    expect(process.env[identity.tokenEnv]).toBeUndefined();
    await assertPrivate(identity.token);
  });

  test('missing secrets reject before generation or creating a run', async () => {
    const identity = await member();
    await app.locals.store.writeTeamSecrets(projectId, {});
    const result = await startMember(identity.member.threadId);
    expect(result.status).toBe(409);
    expect(generator).not.toHaveBeenCalled();
    expect(process.env[identity.tokenEnv]).toBeUndefined();
    const current = await state();
    expect(current.sessions).toEqual([]);
    expect(current.team?.runs).toEqual([]);
  });

  test('an occupied environment is preserved and blocks a second lease', async () => {
    const identity = await member();
    process.env[identity.tokenEnv] = 'occupied-test-environment';
    try {
      expect((await startMember(identity.member.threadId)).status).toBe(409);
      expect(generator).not.toHaveBeenCalled();
      expect(process.env[identity.tokenEnv]).toBe('occupied-test-environment');
      expect((await state()).team?.runs).toEqual([]);
    } finally {
      delete process.env[identity.tokenEnv];
    }
  });

  test('service close cancels live member work and releases its environment', async () => {
    const identity = await member();
    const fake = fakeAdapter();
    await startMember(identity.member.threadId);
    await vi.waitFor(() =>
      expect(fake.client.calls.some((call) => call.method === 'turn/start')).toBe(true),
    );
    await app.locals.close();
    expect(process.env[identity.tokenEnv]).toBeUndefined();
    const current = await state();
    expect(current.team?.members[0].status).toBe('idle');
    expect(current.team?.runs[0].status).toBe('cancelled');
  });

  test('stop releases the token and ignores late results; a rejected second start preserves the live token', async () => {
    const identity = await member();
    const gate = deferred();
    invoke = () => gate.promise;
    const started = await startMember(identity.member.threadId);
    expect((await startMember(identity.member.threadId)).status).toBe(409);
    expect(process.env[identity.tokenEnv]).toBe(identity.token);
    expect(
      (await request(`/projects/${projectId}/work/${started.data.id}/stop`, 'POST', {})).status,
    ).toBe(200);
    expect(process.env[identity.tokenEnv]).toBeUndefined();
    gate.resolve(proposal([]));
    const stopped = await state();
    expect(stopped.team?.members[0].status).toBe('idle');
    expect(stopped.team?.runs).toHaveLength(1);
    expect(stopped.team?.runs[0].status).toBe('cancelled');
  });
});
beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'native-work-'));
  invoke = async () => proposal([update, created]);
  generator = vi.fn((input: Parameters<NativeGenerator>[0]) => invoke(input));
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
    nativeGenerator: generator,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await request('/projects/sample', 'POST', {})).data.id;
  taskId = (
    await request(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Prepare the reopening',
      description: 'Update the menu and write an announcement',
    })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
});
afterEach(async () => {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('guarded native file proposals', () => {
  test('returns before generation finishes and sends only explicit sources', async () => {
    const gate = deferred();
    invoke = () => gate.promise;
    const started = await start();
    expect(started.status).toBe(200);
    expect(started.data.sample).toBe(false);
    expect(started.data.state).toBe('working');
    expect(generator).toHaveBeenCalledOnce();
    expect(generator.mock.calls[0][0].documents.map((document) => document.path)).toEqual([
      'Fall menu.md',
    ]);
    expect(generator.mock.calls[0][0].prompt).toContain('STRICT JSON');
    gate.resolve(proposal([update, created]));
    const ready = await waiting();
    expect(ready.sessions[0].engine.model).toBe('test-model');
    expect(ready.needs[0].preview).toHaveLength(2);
    expect(ready.needs[0].preview?.[0].hunks.some((hunk) => hunk.added)).toBe(true);
    expect(await fs.readFile(path.join(ready.project.folder, 'Fall menu.md'), 'utf8')).toContain(
      'Mushroom risotto',
    );
    await documentsOf();
    expect((await state()).documents.some((document) => document.path === 'Announcement.md')).toBe(
      false,
    );
    expect(ready.project.status.needsYou).toBe(1);
    expect(
      Date.parse(ready.tasks[0].moves[0].undoUntil) - Date.parse(ready.tasks[0].moves[0].at),
    ).toBeGreaterThanOrEqual(3599000);
  });
  test('applies approved text through real history and review, with reversible deletion', async () => {
    invoke = async () =>
      proposal([
        update,
        created,
        { path: 'Opening notes.txt', text: null, summary: 'Remove the superseded opening notes' },
      ]);
    await start(['Fall menu.md', 'Opening notes.txt']);
    let current = await waiting();
    const need = current.needs.find((item) => item.state === 'open')!;
    expect((await decision(need.id, 'go-ahead', true)).status).toBe(400);
    expect((await decision(need.id, 'go-ahead')).status).toBe(200);
    current = await state();
    expect(current.sessions[0].state).toBe('done');
    expect(current.tasks[0].reason).toBe('changes-ready');
    expect(current.changes).toHaveLength(3);
    expect(current.changes.every((change) => change.changedSince === null)).toBe(true);
    expect(await fs.readFile(path.join(current.project.folder, 'Fall menu.md'), 'utf8')).toBe(
      update.text,
    );
    expect(await fs.readFile(path.join(current.project.folder, 'Announcement.md'), 'utf8')).toBe(
      created.text,
    );
    await expect(
      fs.stat(path.join(current.project.folder, 'Opening notes.txt')),
    ).rejects.toHaveProperty('code', 'ENOENT');
    const history = current.history.find((entry) => entry.kind === 'changed')!;
    expect(history.sample).toBe(false);
    expect(history.actor).toBe('diomedes-with-ok');
    expect(history.files).toHaveLength(3);
    expect(history.files.find((file) => file.path === 'Opening notes.txt')?.after).toBeNull();
    expect(
      (await request(`/projects/${projectId}/history/${history.id}/restore`, 'POST', {})).status,
    ).toBe(200);
    expect(
      await fs.readFile(path.join(current.project.folder, 'Opening notes.txt'), 'utf8'),
    ).toContain('Patio reopening');
    expect((await decision(need.id, 'go-ahead')).status).toBe(409);
  });
  test('declining a proposal writes no files and returns the task to To do', async () => {
    await start();
    const ready = await waiting();
    expect((await decision(ready.needs[0].id, 'declined')).status).toBe(200);
    const current = await state();
    expect(current.sessions[0].state).toBe('stopped');
    expect(current.tasks[0].state).toBe('todo');
    expect(current.changes).toEqual([]);
    expect(await fs.readFile(path.join(current.project.folder, 'Fall menu.md'), 'utf8')).toContain(
      'Mushroom risotto',
    );
    await documentsOf();
    expect((await state()).documents).toHaveLength(3);
  });
  test('rejects stale selected text before any proposed file is written', async () => {
    await start();
    const ready = await waiting();
    await fs.writeFile(path.join(ready.project.folder, 'Fall menu.md'), 'A newer outside edit');
    expect((await decision(ready.needs[0].id, 'go-ahead')).status).toBe(409);
    const current = await state();
    expect(current.sessions[0].state).toBe('failed');
    expect(current.needs[0].state).toBe('expired');
    expect(current.changes).toEqual([]);
    expect(await fs.readFile(path.join(current.project.folder, 'Fall menu.md'), 'utf8')).toBe(
      'A newer outside edit',
    );
    await documentsOf();
    expect((await state()).documents.some((document) => document.path === 'Announcement.md')).toBe(
      false,
    );
  });
  test('checks source freshness even when that source is not modified by the proposal', async () => {
    invoke = async () => proposal([created]);
    await start();
    const ready = await waiting();
    await fs.writeFile(path.join(ready.project.folder, 'Fall menu.md'), 'Changed context');
    expect((await decision(ready.needs[0].id, 'go-ahead')).status).toBe(409);
    await documentsOf();
    expect((await state()).documents.some((document) => document.path === 'Announcement.md')).toBe(
      false,
    );
  });
  test('preserves a new target created by someone else while approval was pending', async () => {
    invoke = async () => proposal([created]);
    await start([]);
    const ready = await waiting();
    await fs.writeFile(path.join(ready.project.folder, created.path), 'Do not replace this');
    expect((await decision(ready.needs[0].id, 'go-ahead')).status).toBe(409);
    expect(await fs.readFile(path.join(ready.project.folder, created.path), 'utf8')).toBe(
      'Do not replace this',
    );
  });
  test('stops immediately, aborts its generator, and ignores a late response', async () => {
    const gate = deferred();
    invoke = () => gate.promise;
    const started = await start();
    const stopped = await request(
      `/projects/${projectId}/work/${started.data.id}/stop`,
      'POST',
      {},
    );
    expect(stopped.data.state).toBe('stopped');
    expect(generator.mock.calls[0][0].signal?.aborted).toBe(true);
    gate.resolve(proposal([update, created]));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const current = await state();
    expect(current.sessions[0].state).toBe('stopped');
    expect(current.needs).toEqual([]);
    expect(current.changes).toEqual([]);
    await documentsOf();
    expect((await state()).documents).toHaveLength(3);
  });
  test('a stopped response cannot attach a proposal to a newer session', async () => {
    const first = deferred(),
      second = deferred();
    let call = 0;
    invoke = () => (++call === 1 ? first.promise : second.promise);
    const started = await start();
    await request(`/projects/${projectId}/work/${started.data.id}/stop`, 'POST', {});
    const restarted = await start();
    first.resolve(proposal([update]));
    second.resolve(proposal([created]));
    const current = await waiting();
    expect(current.needs).toHaveLength(1);
    expect(current.needs[0].sessionId).toBe(restarted.data.id);
    expect(current.needs[0].files).toEqual(['Announcement.md']);
  });
  test('closing the service aborts and awaits its owned generation cleanup', async () => {
    let cleaned = false;
    invoke = (input) =>
      new Promise((_resolve, reject) => {
        input.signal?.addEventListener(
          'abort',
          () => {
            setTimeout(() => {
              cleaned = true;
              reject(new Error('Owned generation stopped'));
            }, 15);
          },
          { once: true },
        );
      });
    await start();
    await app.locals.close();
    expect(cleaned).toBe(true);
    const current = await state();
    expect(current.sessions[0].state).toBe('stopped');
    expect(current.needs).toEqual([]);
    expect(current.changes).toEqual([]);
  });
  test('does not recreate a project folder removed while its proposal was waiting', async () => {
    invoke = async () => proposal([created]);
    await start([]);
    const ready = await waiting();
    const moved = `${ready.project.folder}-moved-for-test`;
    await fs.rename(ready.project.folder, moved);
    expect((await decision(ready.needs[0].id, 'go-ahead')).status).toBe(409);
    await expect(fs.stat(ready.project.folder)).rejects.toHaveProperty('code', 'ENOENT');
    expect(await fs.readdir(moved)).not.toContain(created.path);
  });
  test('refuses an unselected existing file without recording or replacing its content', async () => {
    const initial = await state();
    await fs.writeFile(
      path.join(initial.project.folder, 'Unselected.txt'),
      'Private project detail',
    );
    invoke = async () =>
      proposal([{ path: 'Unselected.txt', text: 'Overwrite', summary: 'Not authorized' }]);
    await start();
    const current = await until((result) => result.sessions[0].state === 'failed');
    expect(current.needs).toEqual([]);
    expect(
      current.history.some((entry) => entry.files.some((file) => file.path === 'Unselected.txt')),
    ).toBe(false);
    expect(await fs.readFile(path.join(current.project.folder, 'Unselected.txt'), 'utf8')).toBe(
      'Private project detail',
    );
  });
  test('rejects a junction target during generation and when one appears before approval', async () => {
    const initial = await state(),
      outside = path.join(temp, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(initial.project.folder, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    invoke = async () =>
      proposal([{ path: 'linked/Result.md', text: 'Escape', summary: 'Bad target' }]);
    await start([]);
    expect((await until((result) => result.sessions[0].state === 'failed')).needs).toEqual([]);
    invoke = async () =>
      proposal([{ path: 'later-link/Result.md', text: 'Escape', summary: 'A new result' }]);
    await start([]);
    const ready = await waiting();
    await fs.symlink(
      outside,
      path.join(initial.project.folder, 'later-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(
      (await decision(ready.needs.find((need) => need.state === 'open')!.id, 'go-ahead')).status,
    ).toBe(403);
    expect(await fs.readdir(outside)).toEqual([]);
  });
  test('enforces one project session across native and sample work', async () => {
    const started = await request(`/projects/${projectId}/work/start`, 'POST', { taskId });
    expect(started.data.sample).toBe(true);
    expect((await start()).status).toBe(409);
    expect(generator).not.toHaveBeenCalled();
    await request(`/projects/${projectId}/work/${started.data.id}/stop`, 'POST', {});
    await start();
    await waiting();
    expect((await request(`/projects/${projectId}/work/start`, 'POST', { taskId })).status).toBe(
      409,
    );
  });
  test('requires Codex enabled and explicit sending consent even when sending prompts are off', async () => {
    await request('/settings', 'PUT', { services: { codex: false } });
    expect((await start()).status).toBe(409);
    await request('/settings', 'PUT', {
      services: { codex: true },
      permissions: { sending: false },
    });
    const result = await request(`/projects/${projectId}/work/start`, 'POST', {
      taskId,
      route: 'codex',
      sources: [],
    });
    expect(result.status).toBe(409);
    expect(result.data.consentRequired).toBe(true);
    expect(generator).not.toHaveBeenCalled();
  });
  test('Ask Work uses the same asynchronous proposal controller and permits no-source new documents', async () => {
    invoke = async () => proposal([created]);
    const started = await request(`/projects/${projectId}/ask`, 'POST', {
      mode: 'work',
      route: 'codex',
      consent: true,
      text: 'Draft an announcement',
      sources: [],
    });
    expect(started.status).toBe(200);
    expect(started.data.session.sample).toBe(false);
    expect(started.data.turn.route).toBe('codex');
    const ready = await waiting();
    expect(generator).toHaveBeenCalledOnce();
    expect(generator.mock.calls[0][0].documents).toEqual([]);
    expect(ready.needs[0].preview?.[0].before).toBeNull();
    expect((await decision(ready.needs[0].id, 'go-ahead')).status).toBe(200);
    await documentsOf();
    expect((await state()).documents.some((document) => document.path === created.path)).toBe(true);
  });
  test('keeps notes local and requires a separate exact approval for every new proposal', async () => {
    invoke = async () => proposal([created]);
    const started = await start([]);
    const first = await waiting();
    expect(
      (
        await request(`/projects/${projectId}/work/${started.data.id}/note`, 'POST', {
          text: 'Use a friendly tone',
        })
      ).status,
    ).toBe(200);
    expect(generator).toHaveBeenCalledOnce();
    expect((await decision(first.needs[0].id, 'go-ahead', true)).status).toBe(400);
    await decision(first.needs[0].id, 'go-ahead');
    invoke = async () =>
      proposal([{ path: 'Second.md', text: 'Second draft', summary: 'A second document' }]);
    await start([]);
    const second = await waiting();
    expect(second.needs.filter((need) => need.state === 'open')).toHaveLength(1);
    expect(second.needs.at(-1)?.allowForTask).toBe(false);
    await documentsOf();
    expect((await state()).documents.some((document) => document.path === 'Second.md')).toBe(false);
  });
  test('finishes a no-op proposal honestly without creating an approval or fake change', async () => {
    const initial = await state(),
      original = await fs.readFile(path.join(initial.project.folder, 'Fall menu.md'), 'utf8');
    invoke = async () =>
      proposal([{ path: 'Fall menu.md', text: original, summary: 'No adjustment is needed' }]);
    await start();
    const finished = await until((result) => result.sessions[0].state === 'done');
    expect(finished.changes).toEqual([]);
    expect(finished.needs).toEqual([]);
    expect(finished.tasks[0].state).toBe('done');
  });
});

describe('team native work requests', () => {
  test('forwards a private copy of team options and records technical tool calls before approval', async () => {
    const gate = deferred();
    invoke = () => gate.promise;
    const options = { ...team };
    await startTeam(options);
    const input = generator.mock.calls[0][0];
    expect(input.team).toEqual(team);
    expect(input.team).not.toBe(options);
    options.roleInstructions = 'Mutated after start';
    expect(input.team?.roleInstructions).toBe(team.roleInstructions);
    expect(input.prompt).not.toContain(team.roleInstructions);
    expect(input.prompt).not.toContain('Do not call tools');
    expect(input.prompt).toContain('inspect and approve the exact proposal');
    input.onTeamToolCall?.('team_members');
    input.onTeamToolCall?.('team_send_message');
    gate.resolve(proposal([update]));
    const ready = await waiting();
    const session = ready.sessions[0];
    expect(session.log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sentence: 'Diomedes team tool: team_members.',
          level: 'technical',
        }),
        expect.objectContaining({
          sentence: 'Diomedes team tool: team_send_message.',
          level: 'technical',
        }),
        expect.objectContaining({
          sentence: expect.stringContaining('Diomedes team service and no other MCP service'),
          level: 'technical',
        }),
      ]),
    );
    expect(session.engine.events).toBe(session.log.length);
    expect(JSON.stringify(ready)).not.toContain(team.tokenEnv);
    expect(JSON.stringify(ready)).not.toContain(team.roleInstructions);
    expect(await fs.readFile(path.join(ready.project.folder, update.path), 'utf8')).not.toBe(
      update.text,
    );
    expect(ready.needs[0].state).toBe('open');
    expect((await decision(ready.needs[0].id, 'go-ahead')).status).toBe(200);
    const applied = await state();
    expect(await fs.readFile(path.join(applied.project.folder, update.path), 'utf8')).toBe(
      update.text,
    );
    expect(
      applied.history.some(
        (entry) => entry.actor === 'diomedes-with-ok' && entry.kind === 'changed',
      ),
    ).toBe(true);
  });

  test('does not add team fields or callbacks to ordinary requests', async () => {
    await start();
    await waiting();
    const input = generator.mock.calls[0][0];
    expect(input).not.toHaveProperty('team');
    expect(input).not.toHaveProperty('onTeamToolCall');
    expect(input.prompt).toContain('Do not call tools');
    expect(
      (await state()).sessions[0].log.some((entry) => entry.sentence.includes('team service')),
    ).toBe(false);
  });

  test('ignores late team logs and results after the session stops', async () => {
    const gate = deferred();
    invoke = () => gate.promise;
    const started = await startTeam();
    const input = generator.mock.calls[0][0];
    await request(`/projects/${projectId}/work/${started.id}/stop`, 'POST', {});
    input.onTeamToolCall?.('team_send_message');
    gate.resolve(proposal([update]));
    await app.locals.nativeWork.close();
    const stopped = await state();
    expect(stopped.sessions[0].state).toBe('stopped');
    expect(
      stopped.sessions[0].log.some((entry) => entry.sentence.includes('team_send_message')),
    ).toBe(false);
    expect(stopped.needs).toEqual([]);
    expect(stopped.changes).toEqual([]);
  });

  test.each(['TEAM_SERVER_MISSING', 'MCP_NOT_ISOLATED'])(
    'surfaces %s as failed work without a proposal',
    async (code) => {
      invoke = async () => {
        throw new IntegrationError(code, 'Team isolation failed.');
      };
      await startTeam();
      const failed = await until((result) => result.sessions[0].state === 'failed');
      expect(failed.sessions[0].log.at(-1)?.sentence).toContain('Team isolation failed.');
      expect(failed.needs).toEqual([]);
      expect(failed.changes).toEqual([]);
    },
  );
});

describe('untrusted generated proposal validation', () => {
  test.each([
    ['prose instead of JSON', { text: 'Here is your plan: use the menu.' }],
    ['path traversal', proposal([{ path: '../Escape.md', text: 'bad', summary: 'Escape' }])],
    ['credential file', proposal([{ path: '.env', text: 'bad', summary: 'Private' }])],
    ['unsupported extension', proposal([{ path: 'Program.exe', text: 'bad', summary: 'Binary' }])],
    ['binary contents', proposal([{ path: 'Binary.txt', text: 'bad\0data', summary: 'Binary' }])],
    [
      'duplicate paths',
      proposal([
        { path: 'New.md', text: 'a', summary: 'One' },
        { path: 'new.md', text: 'b', summary: 'Two' },
      ]),
    ],
    [
      'oversized contents',
      proposal([{ path: 'Large.txt', text: 'x'.repeat(128001), summary: 'Large' }]),
    ],
    [
      'too many files',
      proposal(
        Array.from({ length: 9 }, (_, index) => ({
          path: `New-${index}.md`,
          text: 'x',
          summary: 'Too many',
        })),
      ),
    ],
    [
      'remove unselected file',
      proposal([{ path: 'Missing.md', text: null, summary: 'Invalid removal' }]),
    ],
  ])('rejects %s without project writes', async (_name, result) => {
    invoke = async () => result;
    await start([]);
    const failed = await until((current) => current.sessions[0].state === 'failed');
    expect(failed.needs).toEqual([]);
    expect(failed.changes).toEqual([]);
    await documentsOf();
    expect((await state()).documents).toHaveLength(3);
    expect(failed.tasks[0].reason).toBe('went-wrong');
  });

  test('attributes a refused turn to the runtime-reported model', async () => {
    invoke = async () => ({
      text: 'Here is your plan: use the menu.',
      model: 'refused-run-model',
      version: '9.8.7',
    });
    await start([]);
    const failed = await until((current) => current.sessions[0].state === 'failed');
    expect(failed.sessions[0].engine.model).toBe('refused-run-model');
    expect(failed.sessions[0].engine.version).toBe('9.8.7');
    expect(failed.sessions[0].engine.verified).toBe(true);
    expect(failed.needs).toEqual([]);
    expect(failed.changes).toEqual([]);
  });

  test('a refused prose reply is kept on the session and its fault entry', async () => {
    const refusal =
      'The engine did not return a valid file proposal. No files were changed. Start again to request a new proposal.';
    invoke = async () => ({ text: 'Here is your plan: use the menu.', model: 'test-model' });
    await start([]);
    const failed = await until((current) => current.sessions[0].state === 'failed');
    const expected = {
      rawReply: 'Here is your plan: use the menu.',
      rawReplyLength: 32,
      parseError: refusal,
    };
    expect(failed.sessions[0]).toMatchObject(expected);
    const fault = failed.history.find((entry) => entry.kind === 'fault')!;
    expect(fault).toMatchObject(expected);
    expect(fault.sentence).toContain('The engine did not return a valid file proposal');
  });

  test('a long refused reply is capped at 4000 characters with a truncation note', async () => {
    invoke = async () => ({ text: 'x'.repeat(10_000), model: 'test-model' });
    await start([]);
    const failed = await until((current) => current.sessions[0].state === 'failed');
    expect(failed.sessions[0].rawReplyLength).toBe(10_000);
    expect(failed.sessions[0].rawReply).toBe(`${'x'.repeat(4000)}… [truncated, 10000 chars]`);
    expect(failed.history.find((entry) => entry.kind === 'fault')?.rawReply).toBe(
      failed.sessions[0].rawReply,
    );
  });

  test('a refused reply keeps no key, token or Windows user name', async () => {
    invoke = async () => ({
      text: 'Refused: key sk-abcdefghijkl, Bearer tok.en-123456, profile C:\\Users\\andre\\menu.',
      model: 'test-model',
    });
    await start([]);
    const failed = await until((current) => current.sessions[0].state === 'failed');
    const reply = failed.sessions[0].rawReply!;
    expect(reply).not.toContain('sk-abcdefghijkl');
    expect(reply).not.toContain('tok.en-123456');
    expect(reply).not.toContain('C:\\Users\\andre');
    expect(reply).toContain('[redacted]');
    expect(failed.history.find((entry) => entry.kind === 'fault')?.rawReply).toBe(reply);
  });
});

describe('file proposal extraction', () => {
  const proposalText = () =>
    JSON.stringify({
      summary: 'A wrapped proposal',
      changes: [{ path: 'Announcement.md', text: 'New text', summary: 'Create it' }],
    });
  const expected = {
    summary: 'A wrapped proposal',
    changes: [{ path: 'Announcement.md', text: 'New text', summary: 'Create it' }],
  };
  const refusal =
    'The engine did not return a valid file proposal. No files were changed. Start again to request a new proposal.';
  test('accepts plain JSON unchanged', () => {
    expect(parseProposal(proposalText())).toEqual(expected);
    expect(extractJsonObject(proposalText())).toBe(proposalText());
  });
  test('accepts one fenced json block, with or without a prefix', () => {
    expect(parseProposal(`Here it is:\n\`\`\`json\n${proposalText()}\n\`\`\`\n`)).toEqual(expected);
    expect(extractJsonObject(`\`\`\`json\n${proposalText()}\n\`\`\``)).toBe(proposalText());
  });
  test('accepts a short sentence before the object', () => {
    expect(parseProposal(`Here is the proposal:\n${proposalText()}`)).toEqual(expected);
  });
  test('refuses two fenced blocks', () => {
    expect(() =>
      parseProposal(
        `\`\`\`json\n${proposalText()}\n\`\`\`\nAnd again:\n\`\`\`json\n${proposalText()}\n\`\`\``,
      ),
    ).toThrow(refusal);
  });
  test('refuses prose with braces scattered through it', () => {
    const prose = 'The result {one} arrived, though {two is still open for review.';
    expect(extractJsonObject(prose)).toBe(prose);
    expect(() => parseProposal(prose)).toThrow(refusal);
  });
  test('refuses more than 400 characters of prose around the object', () => {
    const long = 'Please read this carefully. '.repeat(30) + proposalText();
    expect(extractJsonObject(long)).toBe(long);
    expect(() => parseProposal(long)).toThrow(refusal);
  });
  test('runs the size guard before any extraction', () => {
    const oversize = `\`\`\`json\n${JSON.stringify({
      summary: 'x'.repeat(1_024_001),
      changes: [],
    })}\n\`\`\``;
    expect(() => parseProposal(oversize)).toThrow(
      'The engine returned a proposal that is too large. No files were changed.',
    );
  });
});

describe('team wake through the adapter', () => {
  test('a message to a member whose thread allows the task starts its run', async () => {
    const identity = await member('codex', 'member');
    const fake = fakeAdapter();
    const allowed = await request(
      `/projects/${projectId}/threads/${identity.member.threadId}`,
      'PUT',
      { permission: 'task' },
    );
    expect(allowed.status).toBe(200);
    const sent = await request(`/projects/${projectId}/team/messages`, 'POST', {
      to: identity.member.slotId,
      content: 'Please draft the patio note.',
    });
    expect(sent.status).toBe(200);
    await vi.waitFor(() =>
      expect(fake.client.calls.some((call) => call.method === 'turn/start')).toBe(true),
    );
    const turn = fake.client.calls.find((call) => call.method === 'turn/start')!.params;
    expect(JSON.stringify(turn)).toContain('From Owner: Please draft the patio note.');
    const config = fake.client.calls.find((call) => call.method === 'thread/start')?.params
      .config;
    expect(config).toMatchObject({
      mcp_servers: { diomedes_team: { http_headers: { 'X-Slot-Id': identity.member.slotId } } },
    });
    let current = await state();
    expect(current.team?.members[0]).toMatchObject({ status: 'working', unread: 0 });
    expect(current.sessions[0]).toMatchObject({
      slotId: identity.member.slotId,
      permission: 'task',
    });
    const thread = current.conversations.find((item) => item.id === identity.member.threadId)!;
    expect(thread.turns.map((item) => item.role)).toEqual(['assistant']);
    expect(thread.turns[0].text).toContain('Picked up a message from the team');
    fake.client.finish();
    current = await until((value) => value.sessions[0].state === 'done');
    expect(current.team?.members[0].status).toBe('idle');
    expect(current.team?.runs).toHaveLength(1);
    expect(current.team?.runs[0]).toMatchObject({
      sessionId: current.sessions[0].id,
      status: 'completed',
    });
    expect(current.tasks.map((item) => item.name)).toContain('Please draft the patio note.');
    await assertPrivate(identity.token);
  });

  test('a message to a member whose thread shows first parks it until the owner wakes it', async () => {
    const identity = await member('codex', 'member');
    const fake = fakeAdapter();
    const sent = await request(`/projects/${projectId}/team/messages`, 'POST', {
      to: identity.member.slotId,
      content: 'Please draft the patio note.',
    });
    expect(sent.status).toBe(200);
    let current = await state();
    expect(current.team?.members[0]).toMatchObject({ status: 'waiting', unread: 1 });
    expect(fake.client.calls.some((call) => call.method === 'turn/start')).toBe(false);
    const woke = await request(
      `/projects/${projectId}/team/members/${identity.member.slotId}/wake`,
      'POST',
      {},
    );
    expect(woke.status).toBe(200);
    await vi.waitFor(() =>
      expect(fake.client.calls.some((call) => call.method === 'turn/start')).toBe(true),
    );
    current = await state();
    expect(current.team?.members[0]).toMatchObject({ status: 'working', unread: 0 });
    expect(current.sessions[0].permission).toBe('show-first');
    fake.client.finish();
    current = await until((value) => value.sessions[0].state === 'done');
    expect(current.team?.members[0].status).toBe('idle');
    await assertPrivate(identity.token);
  });
});
