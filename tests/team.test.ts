import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';

let server: Server, app: Awaited<ReturnType<typeof createApp>>, temp: string, url: string;
const jsonHeaders = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function request(
  route: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = jsonHeaders,
) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

async function mcpRaw(
  projectId: string,
  init: { slotId?: string; token?: string },
  body: unknown,
  method = 'POST',
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  if (init.slotId !== undefined) headers['X-Slot-Id'] = init.slotId;
  const response = await fetch(`${url}/mcp/team/${projectId}`, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  return response;
}

interface McpHelper {
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data: any; raw: any }>;
  close: () => Promise<void>;
}

async function mcpHelper(projectId: string, slotId: string, token: string): Promise<McpHelper> {
  const endpoint = new URL(`/mcp/team/${projectId}`, url);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Slot-Id': slotId } },
  });
  const client = new Client({ name: 'team-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const raw = (await client.callTool({ name, arguments: args })) as any;
      const text = raw?.content?.[0]?.text ?? '';
      let data: any = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { _raw: text };
      }
      return { ok: !raw?.isError, data, raw };
    },
    close: async () => {
      await client.close();
    },
  };
}

async function createProject(): Promise<string> {
  const result = await request('/projects', 'POST', { name: 'Team test project' });
  expect(result.status).toBe(200);
  return result.data.id as string;
}

async function createMember(
  projectId: string,
  input: { name: string; role: string; engine: string; model?: string; threadId?: string },
) {
  const result = await request(`/projects/${projectId}/team/members`, 'POST', input);
  expect(result.status).toBe(200);
  expect(result.data.member).toBeTruthy();
  expect(typeof result.data.token).toBe('string');
  return result.data as { member: any; token: string };
}

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'team-'));
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('team client routes', () => {
  test('GET /team starts empty, POST members creates threads, messages and stop work, no token leakage', async () => {
    const id = await createProject();
    const empty = await request(`/projects/${id}/team`);
    expect(empty.status).toBe(200);
    expect(empty.data.members).toEqual([]);
    expect(JSON.stringify(empty.data)).not.toContain('token');

    const lead = await createMember(id, { name: 'Luna', role: 'lead', engine: 'codex' });
    expect(lead.member.role).toBe('lead');
    expect(lead.member.threadId).toBeTruthy();
    const threads = await request(`/projects/${id}/threads`);
    const thread = threads.data.threads.find((t: any) => t.id === lead.member.threadId);
    expect(thread.name).toBe('Thread with Luna');

    const member = await createMember(id, { name: 'Helper', role: 'member', engine: 'probe' });
    const team = await request(`/projects/${id}/team`);
    expect(team.data.members).toHaveLength(2);
    expect(JSON.stringify(team.data)).not.toContain(lead.token);
    expect(JSON.stringify(team.data)).not.toContain(member.token);

    const state = await request(`/projects/${id}/state`);
    expect(JSON.stringify(state.data)).not.toContain(lead.token);
    expect(JSON.stringify(state.data.team)).not.toContain('token');

    const sent = await request(`/projects/${id}/team/messages`, 'POST', {
      to: member.member.slotId,
      content: 'Hello from owner',
    });
    expect(sent.status).toBe(200);
    expect(sent.data.from).toBe('owner');

    const stopped = await request(
      `/projects/${id}/team/members/${member.member.slotId}/stop`,
      'POST',
      {},
    );
    expect(stopped.status).toBe(200);
    expect(stopped.data.status).toBe('stopped');
  });
});

describe('team MCP endpoint', () => {
  test('loopback auth, method handling, and every tool with falsifiers', async () => {
    const id = await createProject();
    const lead = await createMember(id, { name: 'Luna', role: 'lead', engine: 'codex' });
    const helper = await createMember(id, { name: 'Pip', role: 'member', engine: 'probe' });

    expect((await mcpRaw(id, {}, {}, 'GET')).status).toBe(405);
    expect((await mcpRaw(id, {}, {}, 'DELETE')).status).toBe(405);
    expect(
      (
        await mcpRaw(
          id,
          {},
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
          },
        )
      ).status,
    ).toBe(401);

    const forged = await mcpRaw(
      id,
      { slotId: helper.member.slotId, token: 'forged-token' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    );
    expect(forged.status).toBe(401);

    const wrongSlot = await mcpRaw(
      id,
      { slotId: lead.member.slotId, token: helper.token },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    );
    expect(wrongSlot.status).toBe(401);

    const leadMcp = await mcpHelper(id, lead.member.slotId, lead.token);
    const helperMcp = await mcpHelper(id, helper.member.slotId, helper.token);
    try {
      const roster = await leadMcp.call('team_members');
      expect(roster.ok).toBe(true);
      expect(roster.data.members).toHaveLength(2);
      expect(JSON.stringify(roster.data)).not.toContain(lead.token);

      const assistants = await leadMcp.call('team_list_assistants');
      expect(assistants.ok).toBe(true);
      expect(assistants.data.assistants).toEqual([]);
      expect(assistants.data.note).toContain('not available in this version');

      const describe = await leadMcp.call('team_describe_assistant', { assistant_id: 'x' });
      expect(describe.ok).toBe(false);
      expect(describe.data.error).toContain('not available in this version');

      const spawnLead = await leadMcp.call('team_spawn_agent', {
        name: 'New',
        assistant_id: 'x',
      });
      expect(spawnLead.ok).toBe(false);
      expect(spawnLead.data.error).toContain('not available in this version');

      const spawnMember = await helperMcp.call('team_spawn_agent', {
        name: 'New',
        assistant_id: 'x',
      });
      expect(spawnMember.ok).toBe(false);
      expect(spawnMember.data.error).toContain('Only the lead');

      const clearLead = await leadMcp.call('team_clear_agent_context', {
        slot_id: helper.member.slotId,
      });
      expect(clearLead.ok).toBe(false);
      expect(clearLead.data.error).toContain('not available in this version');

      const clearMember = await helperMcp.call('team_clear_agent_context', {
        slot_id: helper.member.slotId,
      });
      expect(clearMember.ok).toBe(false);
      expect(clearMember.data.error).toContain('Only the lead');

      const renameMember = await helperMcp.call('team_rename_agent', {
        slot_id: helper.member.slotId,
        new_name: 'Nope',
      });
      expect(renameMember.ok).toBe(false);
      expect(renameMember.data.error).toContain('Only the lead');

      const renamed = await leadMcp.call('team_rename_agent', {
        slot_id: helper.member.slotId,
        new_name: 'Pippa',
      });
      expect(renamed.ok).toBe(true);
      expect(renamed.data.member.name).toBe('Pippa');

      const interruptMember = await helperMcp.call('team_interrupt_agent', {
        slot_id: lead.member.slotId,
        message: 'Stop',
      });
      expect(interruptMember.ok).toBe(false);
      expect(interruptMember.data.error).toContain('Only the lead');

      const interrupt = await leadMcp.call('team_interrupt_agent', {
        slot_id: helper.member.slotId,
        message: 'Pause please',
        reason: 'testing',
      });
      expect(interrupt.ok).toBe(true);
      expect(interrupt.data.message.summary).toContain('interrupt:true');

      const created = await leadMcp.call('team_task_create', {
        subject: 'Check the patio',
        description: 'Look at chairs',
        owner: helper.member.slotId,
        idempotency_key: 'key-1',
      });
      expect(created.ok).toBe(true);
      expect(created.data.task.subject).toBe('Check the patio');
      expect(created.data.task.status).toBe('pending');
      expect(created.data.task.owner).toBe(helper.member.slotId);

      const duplicate = await leadMcp.call('team_task_create', {
        subject: 'Check the patio',
        owner: helper.member.slotId,
        idempotency_key: 'key-1',
      });
      expect(duplicate.ok).toBe(true);
      expect(duplicate.data.task.id).toBe(created.data.task.id);
      const listedOnce = await leadMcp.call('team_task_list', {});
      expect(listedOnce.data.tasks.filter((t: any) => t.id === created.data.task.id)).toHaveLength(
        1,
      );

      const store: Store = app.locals.store;
      await store.locked(async () => {
        const state = store.state(id);
        state.needs.push({
          id: 'N1',
          sessionId: 'S1',
          taskId: created.data.task.id,
          what: 'Need approval',
          why: 'Because',
          consequence: 'Otherwise',
          files: [],
          state: 'open',
          createdAt: new Date().toISOString(),
          decidedAt: null,
          decidedFrom: '',
          allowForTask: false,
        });
        await store.persist(state);
      });
      const blocked = await helperMcp.call('team_task_update', {
        task_id: created.data.task.id,
        status: 'completed',
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.data.error).toContain('Need');
      await store.locked(async () => {
        const state = store.state(id);
        state.needs = state.needs.filter((n) => n.id !== 'N1');
        await store.persist(state);
      });

      const toProgress = await helperMcp.call('team_task_update', {
        task_id: created.data.task.id,
        status: 'in_progress',
      });
      expect(toProgress.ok).toBe(true);
      expect(toProgress.data.task.status).toBe('in_progress');

      const filtered = await leadMcp.call('team_task_list', {
        owner: helper.member.slotId,
        status: 'in_progress',
      });
      expect(filtered.data.tasks).toHaveLength(1);

      const waitingUpdate = await store.locked(async () => {
        const state = store.state(id);
        const task = state.tasks.find((t) => t.id === created.data.task.id)!;
        task.state = 'waiting';
        await store.persist(state);
        return task;
      });
      expect(waitingUpdate.state).toBe('waiting');
      const waitingList = await leadMcp.call('team_task_list', {});
      const waitingView = waitingList.data.tasks.find((t: any) => t.id === created.data.task.id);
      expect(waitingView.status).toBe('in_progress');
      expect(waitingView.waiting_for).toBe('owner');
      await store.locked(async () => {
        const state = store.state(id);
        const task = state.tasks.find((t) => t.id === created.data.task.id)!;
        task.state = 'working';
        await store.persist(state);
      });

      const send = await helperMcp.call('team_send_message', {
        to: lead.member.slotId,
        message: 'Working on it',
      });
      expect(send.ok).toBe(true);
      const leadInbox = await leadMcp.call('team_read_messages', {});
      expect(leadInbox.data.messages.some((m: any) => m.content === 'Working on it')).toBe(true);
      const emptyReread = await leadMcp.call('team_read_messages', {
        since_message_id: leadInbox.data.messages.at(-1)?.id,
      });
      expect(emptyReread.data.messages).toEqual([]);

      const done = await helperMcp.call('team_task_update', {
        task_id: created.data.task.id,
        status: 'completed',
      });
      expect(done.ok).toBe(true);
      expect(done.data.task.status).toBe('completed');

      const deleted = await leadMcp.call('team_task_update', {
        task_id: created.data.task.id,
        status: 'deleted',
      });
      expect(deleted.ok).toBe(true);
      expect(deleted.data.task.status).toBe('deleted');
      const hidden = await leadMcp.call('team_task_list', {});
      expect(hidden.data.tasks.some((t: any) => t.id === created.data.task.id)).toBe(false);
      const shown = await leadMcp.call('team_task_list', { include_deleted: true });
      expect(shown.data.tasks.some((t: any) => t.id === created.data.task.id)).toBe(true);
      const limited = await leadMcp.call('team_task_list', {
        include_deleted: true,
        limit: 1,
      });
      expect(limited.data.tasks).toHaveLength(1);

      const history = (await request(`/projects/${id}/state`)).data.history as any[];
      const sentences = history.map((h) => h.sentence).join('\n');
      expect(sentences).toContain(`Luna (Codex) put 'Check the patio' on the board`);
      expect(sentences).toContain(`Pippa (Probe) marked 'Check the patio' done`);
    } finally {
      await leadMcp.close();
      await helperMcp.close();
    }
  });

  test('shutdown is immediate for idle members and acknowledged otherwise', async () => {
    const id = await createProject();
    const lead = await createMember(id, { name: 'Luna', role: 'lead', engine: 'codex' });
    const idle = await createMember(id, { name: 'Idle', role: 'member', engine: 'probe' });
    const busy = await createMember(id, { name: 'Busy', role: 'member', engine: 'probe' });
    const store: Store = app.locals.store;
    await store.locked(async () => {
      const state = store.state(id);
      state.team!.members.find((m) => m.slotId === busy.member.slotId)!.status = 'working';
      await store.persist(state);
    });
    const leadMcp = await mcpHelper(id, lead.member.slotId, lead.token);
    const busyMcp = await mcpHelper(id, busy.member.slotId, busy.token);
    try {
      const idleShutdown = await leadMcp.call('team_shutdown_agent', {
        slot_id: idle.member.slotId,
      });
      expect(idleShutdown.ok).toBe(true);
      expect(idleShutdown.data.member.status).toBe('stopped');

      const busyShutdown = await leadMcp.call('team_shutdown_agent', {
        slot_id: busy.member.slotId,
        reason: 'done for tonight',
      });
      expect(busyShutdown.ok).toBe(true);
      expect(busyShutdown.data.message.type).toBe('shutdown_request');
      expect(busyShutdown.data.member.status).toBe('working');

      const ack = await busyMcp.call('team_send_message', {
        to: lead.member.slotId,
        message: 'shutdown_approved',
      });
      expect(ack.ok).toBe(true);
      const team = await request(`/projects/${id}/team`);
      expect(
        team.data.members.find((m: any) => m.slotId === busy.member.slotId).status,
      ).toBe('stopped');
    } finally {
      await leadMcp.close();
      await busyMcp.close();
    }
  });

  test('team persists across reload and tokens never leak', async () => {
    const id = await createProject();
    const lead = await createMember(id, { name: 'Luna', role: 'lead', engine: 'codex' });
    const helper = await createMember(id, { name: 'Pip', role: 'member', engine: 'probe' });
    const leadMcp = await mcpHelper(id, lead.member.slotId, lead.token);
    try {
      const created = await leadMcp.call('team_task_create', {
        subject: 'Persist me',
        owner: helper.member.slotId,
      });
      expect(created.ok).toBe(true);
      await leadMcp.call('team_send_message', {
        to: helper.member.slotId,
        message: 'Remember this',
      });
    } finally {
      await leadMcp.close();
    }
    const reloaded = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
    await reloaded.init();
    const team = reloaded.team(id);
    expect(team.members).toHaveLength(2);
    expect(team.messages.length).toBeGreaterThan(0);
    const secrets = await reloaded.readTeamSecrets(id);
    expect(secrets[lead.member.slotId]).toBe(lead.token);
    const meta = reloaded.teamMeta(id);
    expect(meta).toBeTruthy();

    const olderPath = path.join(temp, 'data', 'projects', id, 'state.json');
    const raw = JSON.parse(await fs.readFile(olderPath, 'utf8'));
    delete raw.team;
    delete raw.teamMeta;
    await fs.writeFile(olderPath, JSON.stringify(raw));
    const migrated = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
    await migrated.init();
    expect(migrated.team(id)).toEqual({ members: [], messages: [], runs: [] });

    const teamGet = await request(`/projects/${id}/team`);
    expect(JSON.stringify(teamGet.data)).not.toContain(lead.token);
    const stateGet = await request(`/projects/${id}/state`);
    expect(JSON.stringify(stateGet.data)).not.toContain(lead.token);
  });
});
