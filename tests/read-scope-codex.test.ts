import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import type { RawToolActivity } from '../shared/adapter-contract.js';
import { createIntegrations, type NativeRpc } from '../server/integrations.js';
import type { ReadScope } from '../server/engines/read-scope.js';

type Params = Record<string, unknown>;
const root = path.join(os.tmpdir(), 'diomedes codex project');
const other = path.join(os.tmpdir(), 'diomedes codex other');

/** The app-server protocol as the pinned 0.153.4 schema shapes it, for one scripted turn. */
class ScriptedNative implements NativeRpc {
  calls: { method: string; params: Params }[] = [];
  listeners = new Set<(method: string, params: Params) => void>();
  closed = false;
  items: Params[] = [];
  mcp: unknown[] = [];
  inherited: Params = { inherited: { command: 'should-not-run' } };
  request = vi.fn(async (method: string, params: Params): Promise<unknown> => {
    this.calls.push({ method, params });
    switch (method) {
      case 'initialize':
        return { userAgent: 'diomedes/0.153.4 (Windows 10)' };
      case 'account/read':
        return { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'x@example.invalid' } };
      case 'config/read':
        return { config: { mcp_servers: this.inherited, model_providers: {} } };
      case 'thread/start':
        return {
          thread: { id: 'thread-1' },
          model: 'native-model',
          modelProvider: 'openai',
          sandbox: { type: 'readOnly', networkAccess: false },
          approvalPolicy: 'never',
        };
      case 'mcpServerStatus/list':
        return { data: this.mcp, nextCursor: null };
      case 'turn/start':
        setTimeout(() => {
          for (const item of this.items) {
            this.emit('item/started', { threadId: 'thread-1', item: { ...item, status: 'inProgress' } });
            this.emit('item/completed', { threadId: 'thread-1', item });
          }
          this.emit('item/completed', {
            threadId: 'thread-1',
            item: { type: 'agentMessage', text: 'Harbor Street opens at 11.' },
          });
          this.emit('turn/completed', { threadId: 'thread-1', turn: { status: 'completed' } });
        }, 1);
        return { turn: { id: 'turn-1' } };
      default:
        throw new Error(`Unexpected method ${method}`);
    }
  });
  notify() {}
  onNotification(listener: (method: string, params: Params) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(method: string, params: Params) {
    for (const listener of [...this.listeners]) listener(method, params);
  }
  async close() {
    this.closed = true;
    this.emit('diomedes/error', { message: 'closed' });
  }
  sent(method: string) {
    return this.calls.find((call) => call.method === method)?.params ?? {};
  }
}

function setup(clients: ScriptedNative[], options: { keepWarmMs?: number } = {}) {
  const queue = [...clients];
  const verifySandbox = vi.fn(async () => {});
  const createClient = vi.fn(async () => queue.shift() ?? new ScriptedNative());
  return {
    verifySandbox,
    createClient,
    ...createIntegrations({
      platform: 'win32',
      createClient,
      verifySandbox,
      turnTimeoutMs: 500,
      keepWarmMs: options.keepWarmMs ?? 0,
    }),
  };
}
const request = { prompt: 'When does Harbor Street open?', documents: [] };
const scope = (extra: Partial<ReadScope> = {}): ReadScope => ({ root, web: true, ...extra });
const readItem = (file: string, id = 'cmd-1') => ({
  type: 'commandExecution',
  id,
  command: `Get-Content ${file}`,
  cwd: root,
  status: 'completed',
  exitCode: 0,
  aggregatedOutput: 'Opens at 11.',
  commandActions: [{ type: 'read', command: `Get-Content ${file}`, name: file, path: file }],
});
const pos = {
  name: 'pos',
  command: 'pos-mcp.exe',
  args: [],
  envFrom: ['POS_TOKEN'],
  readTools: ['list_orders'],
};

describe('Codex read scope', () => {
  it('reads the project folder under the read-only sandbox and streams activity', async () => {
    const native = new ScriptedNative();
    native.items = [
      readItem('menu.md'),
      {
        type: 'webSearch',
        id: 'web-1',
        query: 'Harbor Street opening hours',
        action: { type: 'search', query: 'Harbor Street opening hours' },
      },
    ];
    const integration = setup([native]);
    const activity: RawToolActivity[] = [];
    const result = await integration.askCodex({
      ...request,
      instructions: 'Answer briefly.',
      readScope: scope(),
      onToolActivity: (raw) => activity.push(raw),
    });
    expect(result.text).toBe('Harbor Street opens at 11.');
    // The write-denial proof still runs before any read turn.
    expect(integration.verifySandbox).toHaveBeenCalledOnce();
    const [, config] = integration.createClient.mock.calls[0] as unknown as [unknown, Params];
    expect(config).toMatchObject({ 'features.shell_tool': true, web_search: 'live' });
    const thread = native.sent('thread/start');
    expect(thread.cwd).toBe(root);
    expect(thread.sandbox).toBe('read-only');
    expect(thread.config).toMatchObject({
      sandbox_mode: 'read-only',
      'features.shell_tool': true,
      web_search: 'live',
      'features.apps': false,
      'features.computer_use': false,
      'features.browser_use': false,
      project_doc_max_bytes: 0,
      mcp_servers: { inherited: { enabled: false } },
    });
    expect(String(thread.baseInstructions)).toContain(root);
    const turn = native.sent('turn/start');
    expect(turn.cwd).toBe(root);
    expect(turn.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    expect(activity.map((a) => [a.phase, a.summary])).toEqual([
      ['started', 'Reading menu.md'],
      ['finished', 'Read finished'],
      ['started', 'Searching the web for Harbor Street opening hours'],
      ['finished', 'Read finished'],
    ]);
  });
  it('keeps web search off when the scope has no web access', async () => {
    const native = new ScriptedNative();
    native.items = [{ type: 'webSearch', id: 'web-1', query: 'x', action: { type: 'search' } }];
    const integration = setup([native]);
    await expect(
      integration.askCodex({ ...request, readScope: scope({ web: false }) }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
    expect(native.sent('thread/start').config).toMatchObject({ web_search: 'disabled' });
  });
  it.each([
    [
      'a command the runtime could not parse as a read',
      {
        ...readItem('menu.md'),
        command: 'Set-Content out.txt x',
        commandActions: [{ type: 'unknown', command: 'Set-Content out.txt x' }],
      },
    ],
    ['a command with no parsed actions', { ...readItem('menu.md'), commandActions: [] }],
    ['a read outside the project folder', readItem(path.join(other, 'secret.txt'))],
    ['a command run from outside the project folder', { ...readItem('menu.md'), cwd: other }],
    ['a file change', { type: 'fileChange', id: 'f1', changes: [], status: 'completed' }],
    ['an unapproved MCP call', { type: 'mcpToolCall', id: 'm1', server: 'pos', tool: 'refund', status: 'completed' }],
    ['a dynamic tool', { type: 'dynamicToolCall', id: 'd1', tool: 'x', status: 'completed' }],
  ])('stops %s', async (_label, item) => {
    const native = new ScriptedNative();
    native.items = [item as Params];
    const integration = setup([native]);
    await expect(integration.askCodex({ ...request, readScope: scope() })).rejects.toMatchObject({
      code: 'UNEXPECTED_TOOL',
    });
  });
  it('keeps a text-only turn byte-for-byte as it was', async () => {
    const native = new ScriptedNative();
    native.items = [readItem('menu.md')];
    const integration = setup([native]);
    await expect(integration.askCodex(request)).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
    expect(integration.createClient).toHaveBeenCalledWith();
    expect(native.sent('thread/start').config).toMatchObject({
      web_search: 'disabled',
      'features.shell_tool': false,
    });
  });
  it('refuses a read scope on team or guarded work', async () => {
    const integration = setup([]);
    await expect(
      integration.askCodex({
        ...request,
        readScope: scope(),
        instructions: 'x',
        model: 'm',
        effort: 'low',
        beforeDispatch: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNBOUND' });
    expect(integration.createClient).not.toHaveBeenCalled();
  });
  it('never lets a process kept for one project serve another', async () => {
    const first = new ScriptedNative();
    const second = new ScriptedNative();
    const third = new ScriptedNative();
    const integration = setup([first, second, third], { keepWarmMs: 60_000 });
    await integration.askCodex({ ...request, readScope: scope() });
    await integration.askCodex({ ...request, readScope: scope() });
    // Same project and scope: the kept process served it.
    expect(integration.createClient).toHaveBeenCalledTimes(1);
    await integration.askCodex({ ...request, readScope: scope({ root: other }) });
    expect(integration.createClient).toHaveBeenCalledTimes(2);
    expect(first.closed).toBe(true);
    expect(second.sent('thread/start').cwd).toBe(other);
    // Nor does a process kept for a read scope serve a text-only turn.
    await integration.askCodex(request);
    expect(integration.createClient).toHaveBeenCalledTimes(3);
    expect(second.closed).toBe(true);
    await integration.closeWarm();
  });
});

describe('Codex approved MCP read tools', () => {
  it('enables only approved servers, limited to their read tools', async () => {
    const previous = process.env.POS_TOKEN;
    process.env.POS_TOKEN = 'pos-secret';
    try {
      const native = new ScriptedNative();
      native.mcp = [
        { name: 'inherited', runtimeStatus: 'disabled', tools: {}, resources: [], resourceTemplates: [] },
        { name: 'pos', runtimeStatus: 'connected', tools: { list_orders: {} } },
      ];
      native.items = [
        { type: 'mcpToolCall', id: 'm1', server: 'pos', tool: 'list_orders', arguments: { day: 'today' }, status: 'completed' },
      ];
      const integration = setup([native]);
      const activity: RawToolActivity[] = [];
      await integration.askCodex({
        ...request,
        readScope: scope({ mcp: [pos] }),
        onToolActivity: (raw) => activity.push(raw),
      });
      const config = native.sent('thread/start').config as Params;
      expect((config.mcp_servers as Params).pos).toEqual({
        command: 'pos-mcp.exe',
        args: [],
        env_vars: ['POS_TOKEN'],
        enabled: true,
        required: true,
        enabled_tools: ['list_orders'],
        default_tools_approval_mode: 'approve',
      });
      expect(JSON.stringify(config)).not.toContain('pos-secret');
      const [env] = integration.createClient.mock.calls[0] as unknown as [NodeJS.ProcessEnv];
      expect(env.POS_TOKEN).toBe('pos-secret');
      expect(activity[0].summary).toBe('Reading from pos (list_orders)');
    } finally {
      if (previous === undefined) delete process.env.POS_TOKEN;
      else process.env.POS_TOKEN = previous;
    }
  });
  it('refuses an approved server that exposes a tool the owner did not name', async () => {
    const native = new ScriptedNative();
    native.mcp = [{ name: 'pos', runtimeStatus: 'connected', tools: { list_orders: {}, refund: {} } }];
    const integration = setup([native]);
    await expect(
      integration.askCodex({ ...request, readScope: scope({ mcp: [pos] }) }),
    ).rejects.toMatchObject({ code: 'MCP_NOT_ISOLATED' });
    expect(native.calls.some((call) => call.method === 'turn/start')).toBe(false);
  });
  it('refuses an inherited server under an approved name', async () => {
    const native = new ScriptedNative();
    native.inherited = { pos: { command: 'someone-elses-pos' } };
    const integration = setup([native]);
    await expect(
      integration.askCodex({ ...request, readScope: scope({ mcp: [pos] }) }),
    ).rejects.toMatchObject({ code: 'MCP_NOT_ISOLATED' });
    expect(native.calls.some((call) => call.method === 'thread/start')).toBe(false);
  });
  it('still refuses an enabled server nobody approved', async () => {
    const native = new ScriptedNative();
    native.mcp = [{ name: 'inherited', runtimeStatus: 'connected', tools: { send: {} } }];
    const integration = setup([native]);
    await expect(integration.askCodex({ ...request, readScope: scope() })).rejects.toMatchObject({
      code: 'MCP_NOT_ISOLATED',
    });
  });
});
