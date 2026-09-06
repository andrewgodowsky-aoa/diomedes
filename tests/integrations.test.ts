import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  CODEX_WORKSPACE,
  createIntegrations,
  createRpcClient,
  IntegrationError,
  nativeEnvironment,
  type NativeRpc,
} from '../server/integrations.js';

type Params = Record<string, unknown>;
class FakeNative implements NativeRpc {
  calls: { method: string; params: Params }[] = [];
  listeners = new Set<(method: string, params: Params) => void>();
  closed = false;
  account: string | null = 'chatgpt';
  sandbox = { type: 'readOnly', networkAccess: false };
  mcp: unknown[] = [];
  complete = true;
  turnStatus = 'completed';
  customProvider = false;
  apiEndpoint: string | null = null;
  request = vi.fn(async (method: string, params: Params): Promise<unknown> => {
    this.calls.push({ method, params });
    switch (method) {
      case 'initialize':
        return { userAgent: 'diomedes/0.153.4 (Windows 10)' };
      case 'account/read':
        return {
          requiresOpenaiAuth: true,
          account: this.account
            ? { type: this.account, email: 'never-retain@example.invalid' }
            : null,
        };
      case 'config/read':
        return {
          config: {
            mcp_servers: {
              inherited: { command: 'should-not-run' },
              'server.with.dot': { command: 'also-disabled' },
            },
            model_providers: this.customProvider
              ? { openai: { base_url: 'https://example.invalid' } }
              : {},
            openai_base_url: this.apiEndpoint,
          },
        };
      case 'thread/start':
        return {
          thread: { id: 'synthetic-thread' },
          model: 'native-model',
          modelProvider: 'openai',
          sandbox: this.sandbox,
          approvalPolicy: 'never',
        };
      case 'mcpServerStatus/list':
        return { data: this.mcp, nextCursor: null };
      case 'turn/start':
        if (this.complete)
          setTimeout(() => {
            this.emit('item/completed', {
              threadId: 'synthetic-thread',
              item: { type: 'agentMessage', text: 'A native answer.' },
            });
            this.emit('turn/completed', {
              threadId: 'synthetic-thread',
              turn: { status: this.turnStatus },
            });
          }, 1);
        return { turn: { id: 'synthetic-turn' } };
      default:
        throw new Error(`Unexpected test method: ${method}`);
    }
  });
  notify() {}
  onNotification(listener: (method: string, params: Params) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(method: string, params: Params) {
    for (const listener of this.listeners) listener(method, params);
  }
  async close() {
    this.closed = true;
    this.emit('diomedes/error', { message: 'Owned process closed' });
  }
}

function setup(client = new FakeNative()) {
  const verifySandbox = vi.fn(async () => {});
  const createClient = vi.fn(async () => client);
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ state: 'idle_unloaded', resident: null }), { status: 200 }),
  );
  return {
    client,
    verifySandbox,
    createClient,
    fetch,
    ...createIntegrations({ createClient, verifySandbox, fetch, turnTimeoutMs: 25 }),
  };
}
const request = {
  prompt: 'Summarize the selected document.',
  documents: [{ path: 'plan.md', text: 'A synthetic project plan.' }],
};

describe('native integration boundary', () => {
  it('uses selected content, native account, no environment tools, and denies inherited MCP entries before a turn', async () => {
    const integration = setup();
    const answer = await integration.askCodex(request);
    expect(answer).toEqual({
      text: 'A native answer.',
      model: 'native-model',
      threadId: 'synthetic-thread',
    });
    const start = integration.client.calls.find((call) => call.method === 'thread/start')!.params;
    expect(start).toMatchObject({
      cwd: CODEX_WORKSPACE,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      modelProvider: 'openai',
      ephemeral: true,
      environments: [],
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      dynamicTools: [],
      allowProviderModelFallback: false,
    });
    expect(start.config).toMatchObject({
      mcp_servers: { inherited: { enabled: false }, 'server.with.dot': { enabled: false } },
    });
    const turn = integration.client.calls.find((call) => call.method === 'turn/start')!.params;
    expect(turn).toMatchObject({
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      environments: [],
      runtimeWorkspaceRoots: [],
    });
    expect(JSON.stringify(turn.input)).toContain('A synthetic project plan.');
    expect(integration.verifySandbox).toHaveBeenCalledOnce();
    expect(integration.client.closed).toBe(true);
  });

  it('never starts an engine when the real sandbox probe fails', async () => {
    const integration = setup();
    integration.verifySandbox.mockRejectedValue(
      new IntegrationError('SANDBOX_UNPROVEN', 'The sandbox was not proven.'),
    );
    await expect(integration.askCodex(request)).rejects.toMatchObject({ code: 'SANDBOX_UNPROVEN' });
    expect(integration.createClient).not.toHaveBeenCalled();
  });

  it.each(['apiKey', null, 'amazonBedrock'])(
    'rejects %s authentication without falling back',
    async (account) => {
      const integration = setup();
      integration.client.account = account;
      await expect(integration.askCodex(request)).rejects.toMatchObject({
        code: 'CHATGPT_REQUIRED',
      });
      expect(integration.client.calls.some((call) => call.method === 'thread/start')).toBe(false);
      expect(integration.client.closed).toBe(true);
    },
  );

  it('rejects provider replacement before the thread starts', async () => {
    const integration = setup();
    integration.client.customProvider = true;
    await expect(integration.askCodex(request)).rejects.toMatchObject({
      code: 'PROVIDER_OVERRIDE',
    });
    expect(integration.client.calls.some((call) => call.method === 'thread/start')).toBe(false);
  });

  it('leaves endpoint selection to native ChatGPT auth and blocks API endpoint overrides', async () => {
    const integration = setup();
    integration.client.apiEndpoint = 'https://api.openai.com/v1';
    await expect(integration.askCodex(request)).rejects.toMatchObject({
      code: 'PROVIDER_OVERRIDE',
    });
    expect(integration.client.calls.some((call) => call.method === 'thread/start')).toBe(false);
  });

  it('accepts configured MCP entries only when the native runtime confirms they are disabled and empty', async () => {
    const integration = setup();
    integration.client.mcp = [
      {
        name: 'inherited',
        runtimeStatus: 'disabled',
        tools: {},
        resources: [],
        resourceTemplates: [],
      },
    ];
    await expect(integration.askCodex(request)).resolves.toMatchObject({
      text: 'A native answer.',
    });
    const call = integration.client.calls.find((item) => item.method === 'mcpServerStatus/list');
    expect(call?.params).toEqual({ threadId: 'synthetic-thread' });
  });

  it('refuses policy drift and active MCP tools before sending context to a model', async () => {
    const policy = setup();
    policy.client.sandbox.networkAccess = true;
    await expect(policy.askCodex(request)).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
    expect(policy.client.calls.some((call) => call.method === 'turn/start')).toBe(false);
    const mcp = setup();
    mcp.client.mcp = [{ name: 'unexpected' }];
    await expect(mcp.askCodex(request)).rejects.toMatchObject({ code: 'MCP_NOT_ISOLATED' });
    expect(mcp.client.calls.some((call) => call.method === 'turn/start')).toBe(false);
  });

  it('reports failed turns without returning partial success', async () => {
    const integration = setup();
    integration.client.turnStatus = 'failed';
    await expect(integration.askCodex(request)).rejects.toMatchObject({ code: 'TURN_FAILED' });
    expect(integration.client.closed).toBe(true);
  });

  it('closes only the owned client when cancelled and when the turn times out', async () => {
    const integration = setup();
    integration.client.complete = false;
    const controller = new AbortController();
    const pending = integration.askCodex({ ...request, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(integration.client.closed).toBe(true);
    const timeout = setup();
    timeout.client.complete = false;
    await expect(timeout.askCodex(request)).rejects.toMatchObject({ code: 'TURN_TIMEOUT' });
    expect(timeout.client.closed).toBe(true);
  });

  it('rejects oversized and already-cancelled input before launching a process', async () => {
    const integration = setup();
    await expect(
      integration.askCodex({ prompt: 'x'.repeat(160_001), documents: [] }),
    ).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
    await expect(
      integration.askCodex({ ...request, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(integration.createClient).not.toHaveBeenCalled();
  });

  it('reports live capability limits, keeps account details private, and only observes LocalAI', async () => {
    const integration = setup();
    const statuses = await integration.getIntegrationStatuses();
    expect(statuses.find((status) => status.id === 'codex')).toMatchObject({
      available: true,
      enabled: false,
      status: 'Ready',
    });
    expect(statuses.find((status) => status.id === 'aioncore')).toMatchObject({
      available: false,
      status: 'Not configured',
    });
    expect(statuses.find((status) => status.id === 'localai')).toMatchObject({
      available: true,
      capabilities: ['observe-status'],
    });
    expect(JSON.stringify(statuses)).not.toContain('never-retain');
    expect(integration.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/localai/status',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    await integration.getIntegrationStatuses();
    expect(integration.createClient).toHaveBeenCalledOnce();
  });

  it('does not mistake a responding unrelated local service for LocalAI', async () => {
    const integration = setup();
    integration.fetch.mockResolvedValue(new Response('{}'));
    const statuses = await integration.getIntegrationStatuses();
    expect(statuses.find((status) => status.id === 'localai')).toMatchObject({
      available: false,
      status: 'Disconnected',
    });
  });

  it('does not inherit credentials, provider routing, or task-control variables', () => {
    const env = nativeEnvironment({
      PATH: 'native-path',
      USERPROFILE: 'native-home',
      CODEX_HOME: 'native-auth-home',
      OPENAI_API_KEY: 'secret',
      OPENAI_BASE_URL: 'https://example.invalid',
      CODEX_THREAD_ID: 'other-thread',
      HTTPS_PROXY: 'secret-proxy',
      APPDATA: 'app-data',
    });
    expect(env).toEqual({
      PATH: 'native-path',
      USERPROFILE: 'native-home',
      CODEX_HOME: 'native-auth-home',
      APPDATA: 'app-data',
    });
  });
});

describe('owned native JSON-line process transport', () => {
  it('correlates responses and terminates its owned subprocess', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);if(r.id)console.log(JSON.stringify({id:r.id,result:{ack:r.method}}))})`,
      ],
      {
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const client = createRpcClient(child);
    expect(await client.request('synthetic/test', {})).toEqual({ ack: 'synthetic/test' });
    await client.close();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('surfaces protocol timeouts instead of success-shaped output', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = createRpcClient(child, undefined, 20);
    try {
      await expect(client.request('never-acknowledged', {})).rejects.toMatchObject({
        code: 'NATIVE_TIMEOUT',
      });
    } finally {
      await client.close();
    }
  });
});
