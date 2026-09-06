import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';

const fail = (message: string): never => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};
const assert = (condition: unknown, message: string): void => {
  if (!condition) fail(message);
};

async function main(): Promise<void> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-team-probe-'));
  const app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  const api = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${url}/api${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  const mcpFetch = async (projectId: string, slotId: string | null, token: string | null) => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = `Bearer ${token}`;
    if (slotId) h['X-Slot-Id'] = slotId;
    return fetch(`${url}/mcp/team/${projectId}`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
  };
  const connectMcp = async (projectId: string, slotId: string, token: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`/mcp/team/${projectId}`, url), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Slot-Id': slotId } },
    });
    const client = new Client({ name: 'team-probe', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const raw = (await client.callTool({ name, arguments: args })) as any;
      let data: any = null;
      try {
        data = JSON.parse(raw?.content?.[0]?.text ?? 'null');
      } catch {
        data = null;
      }
      return { ok: !raw?.isError, data, raw };
    };
    return { client, call, close: () => client.close() };
  };

  try {
    const project = await api('/projects', 'POST', { name: 'Probe project' });
    assert(project.status === 200, 'create fixture project');
    const projectId = project.data.id as string;

    const leadRes = await api(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Luna',
      role: 'lead',
      engine: 'codex',
    });
    assert(leadRes.status === 200, 'create lead');
    const memberRes = await api(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Pip',
      role: 'member',
      engine: 'probe',
    });
    assert(memberRes.status === 200, 'create member');
    const lead = leadRes.data.member;
    const leadToken = leadRes.data.token as string;
    const helper = memberRes.data.member;
    const helperToken = memberRes.data.token as string;

    const forged = await mcpFetch(projectId, helper.slotId, 'forged-token');
    assert(forged.status === 401, 'forged token is 401');
    const wrongSlot = await mcpFetch(projectId, lead.slotId, helperToken);
    assert(wrongSlot.status === 401, 'wrong slot for valid token is 401');

    const leadMcp = await connectMcp(projectId, lead.slotId, leadToken);
    const helperMcp = await connectMcp(projectId, helper.slotId, helperToken);
    try {
      const created = await leadMcp.call('team_task_create', {
        subject: 'Check the patio',
        description: 'Look at the chairs',
        owner: helper.slotId,
        idempotency_key: 'probe-key-1',
      });
      assert(created.ok, `lead creates task: ${JSON.stringify(created.data)}`);
      const taskId = created.data.task.id as string;

      const duplicate = await leadMcp.call('team_task_create', {
        subject: 'Check the patio',
        owner: helper.slotId,
        idempotency_key: 'probe-key-1',
      });
      assert(duplicate.ok && duplicate.data.task.id === taskId, 'same idempotency key returns one task');

      const leadOnly = await helperMcp.call('team_shutdown_agent', { slot_id: lead.slotId });
      assert(!leadOnly.ok && /Only the lead/.test(leadOnly.data?.error ?? ''), 'member lead-only tool errors');

      const store: Store = app.locals.store;
      await store.locked(async () => {
        const state = store.state(projectId);
        state.needs.push({
          id: 'Nprobe',
          sessionId: 'Sprobe',
          taskId,
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
        task_id: taskId,
        status: 'completed',
      });
      assert(!blocked.ok && /Need/.test(blocked.data?.error ?? ''), 'completion with open Need errors');
      await store.locked(async () => {
        const state = store.state(projectId);
        state.needs = state.needs.filter((n) => n.id !== 'Nprobe');
        await store.persist(state);
      });

      const hello = await leadMcp.call('team_send_message', {
        to: helper.slotId,
        message: 'Start on the patio',
      });
      assert(hello.ok, 'lead sends message');

      const inbox = await helperMcp.call('team_read_messages', {});
      assert(
        inbox.ok && inbox.data.messages.some((m: any) => m.content === 'Start on the patio'),
        'member reads its messages',
      );

      const progress = await helperMcp.call('team_task_update', {
        task_id: taskId,
        status: 'in_progress',
      });
      assert(progress.ok && progress.data.task.status === 'in_progress', 'member moves to in_progress');

      const back = await helperMcp.call('team_send_message', {
        to: lead.slotId,
        message: 'Started on the patio',
      });
      assert(back.ok, 'member sends message back');

      const leadInbox = await leadMcp.call('team_read_messages', {});
      assert(
        leadInbox.ok && leadInbox.data.messages.some((m: any) => m.content === 'Started on the patio'),
        'lead reads it',
      );

      const done = await helperMcp.call('team_task_update', {
        task_id: taskId,
        status: 'completed',
      });
      assert(done.ok && done.data.task.status === 'completed', 'member completes');

      const state = (await api(`/projects/${projectId}/state`)).data;
      const boardTask = state.tasks.find((t: any) => t.id === taskId);
      assert(boardTask?.state === 'done', 'board shows done through /state');
      const sentences = (state.history as any[]).map((h) => h.sentence).join('\n');
      assert(
        sentences.includes(`Luna (Codex) put 'Check the patio' on the board`),
        'History has attributed put entry',
      );
      assert(
        sentences.includes(`Pip (Probe) marked 'Check the patio' done`),
        'History has attributed done entry',
      );
      assert(!JSON.stringify(state).includes(leadToken), 'token never in /state');
      const team = (await api(`/projects/${projectId}/team`)).data;
      assert(!JSON.stringify(team).includes(leadToken), 'token never in GET /team');
    } finally {
      await leadMcp.close();
      await helperMcp.close();
    }
    console.log('PASS');
  } finally {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
