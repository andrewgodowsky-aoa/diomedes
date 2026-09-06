import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  CODEX_WORKSPACE,
  createIntegrations,
  createRpcClient,
  IntegrationError,
  nativeEnvironment,
  nativeWorkDisclosure,
  type NativeTeamOptions,
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
  mcpSequence: unknown[][] = [];
  complete = true;
  turnStatus = 'completed';
  customProvider = false;
  apiEndpoint: string | null = null;
  inheritedTeam: Params | undefined;
  nextCursor: string | null = null;
  items: Params[] = [];
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
              ...(this.inheritedTeam ? { diomedes_team: this.inheritedTeam } : {}),
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
        return { data: this.mcpSequence.shift() ?? this.mcp, nextCursor: this.nextCursor };
      case 'turn/start':
        if (this.complete)
          setTimeout(() => {
            for (const item of this.items)
              this.emit('item/completed', { threadId: 'synthetic-thread', item });
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
const team: NativeTeamOptions = {
  url: 'http://127.0.0.1:4321/mcp/team/project-1',
  tokenEnv: 'DIOMEDES_TEAM_TEST_TOKEN',
  slotId: 'slot-1',
  role: 'member',
  roleInstructions: 'Report your assigned work to the lead through the team service.',
};
const disabledServer = {
  name: 'inherited',
  runtimeStatus: 'disabled',
  tools: {},
  resources: [],
  resourceTemplates: [],
};
const teamServer = {
  name: 'diomedes_team',
  runtimeStatus: 'connected',
  tools: { team_members: { name: 'team_members' } },
  resources: [],
  resourceTemplates: [],
  authStatus: 'bearerToken',
};
function setupTeam() {
  vi.stubEnv(team.tokenEnv, 'synthetic-member-secret');
  const integration = setup();
  integration.client.mcp = [disabledServer, teamServer];
  return integration;
}
afterEach(() => vi.unstubAllEnvs());

describe('opt-in Diomedes team boundary', () => {
  it.each(['lead', 'member'] as const)(
    'isolates the %s config and forwards only its token',
    async (role) => {
      const integration = setupTeam();
      vi.stubEnv('OPENAI_API_KEY', 'must-not-inherit');
      vi.stubEnv('HTTPS_PROXY', 'must-not-inherit');
      vi.stubEnv('DIOMEDES_TEAM_OTHER_TOKEN', 'other-member-secret');
      await expect(
        integration.askCodex({ ...request, team: { ...team, role } }),
      ).resolves.toMatchObject({
        text: 'A native answer.',
      });
      expect(integration.createClient).toHaveBeenCalledWith({
        ...nativeEnvironment(),
        [team.tokenEnv]: 'synthetic-member-secret',
      });
      const start = integration.client.calls.find((call) => call.method === 'thread/start')!.params;
      expect(start.config).toMatchObject({
        mcp_servers: {
          inherited: { enabled: false },
          'server.with.dot': { enabled: false },
          diomedes_team: {
            url: team.url,
            bearer_token_env_var: team.tokenEnv,
            enabled: true,
            http_headers: { 'X-Slot-Id': team.slotId },
            required: true,
          },
        },
        developer_instructions: team.roleInstructions,
        'features.shell_tool': false,
        'features.apps': false,
        'features.plugins': false,
        'features.multi_agent': false,
        web_search: 'disabled',
      });
      expect(start).toMatchObject({
        sandbox: 'read-only',
        approvalPolicy: 'never',
        environments: [],
        dynamicTools: [],
      });
      const turn = integration.client.calls.find((call) => call.method === 'turn/start')!.params;
      expect(turn).toMatchObject({
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        environments: [],
      });
      expect(JSON.stringify(turn.input)).not.toContain(team.roleInstructions);
      expect(JSON.stringify(integration.client.calls)).not.toContain('synthetic-member-secret');
      expect(integration.verifySandbox).toHaveBeenCalledOnce();
      expect(integration.client.closed).toBe(true);
    },
  );

  it.each([
    [],
    [disabledServer],
    [{ ...teamServer, runtimeStatus: 'disabled' }],
    [{ ...teamServer, enabled: false }],
  ])('reports an absent or disabled team without sending a turn (%j)', async (...inventory) => {
    const integration = setupTeam();
    integration.client.mcp = inventory;
    await expect(integration.askCodex({ ...request, team })).rejects.toMatchObject({
      code: 'TEAM_SERVER_MISSING',
    });
    expect(integration.client.calls.some((call) => call.method === 'turn/start')).toBe(false);
    expect(integration.client.closed).toBe(true);
  });

  it.each([
    [teamServer, { name: 'foreign', tools: { steal: {} } }],
    [teamServer, { ...disabledServer, tools: { leaked: {} } }],
    [teamServer, { ...disabledServer, resources: [{}] }],
    [teamServer, { ...disabledServer, resourceTemplates: [{}] }],
    [teamServer, teamServer],
    [{ ...teamServer, tools: {} }],
    [{ ...teamServer, tools: { another_tool: { name: 'another_tool' } } }],
    [{ ...teamServer, runtimeStatus: null }],
    [{ ...teamServer, runtimeStatus: undefined }],
    [{ ...teamServer, runtimeStatus: 'unknown-state' }],
    [{ ...teamServer, runtimeStatus: 'notStarted' }],
    [{ ...teamServer, runtimeStatus: 'authenticationRequired' }],
    [{ ...teamServer, runtimeStatus: 'failed' }],
    [{ ...teamServer, runtimeStatus: 'cancelled' }],
  ])('fails closed for unproven inventories (%j)', async (...inventory) => {
    const integration = setupTeam();
    integration.client.mcp = inventory;
    await expect(integration.askCodex({ ...request, team })).rejects.toMatchObject({
      code: 'MCP_NOT_ISOLATED',
    });
    expect(integration.client.calls.some((call) => call.method === 'turn/start')).toBe(false);
  });

  it('re-lists a starting team until it connects before sending the turn', async () => {
    const integration = setupTeam();
    integration.client.mcpSequence = [
      [disabledServer, { ...teamServer, runtimeStatus: 'starting', tools: {} }],
    ];
    const startedAt = Date.now();
    await expect(integration.askCodex({ ...request, team })).resolves.toMatchObject({
      text: 'A native answer.',
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
    expect(
      integration.client.calls.filter((call) => call.method === 'mcpServerStatus/list'),
    ).toHaveLength(2);
    const methods = integration.client.calls.map((call) => call.method);
    expect(methods.indexOf('turn/start')).toBeGreaterThan(
      methods.lastIndexOf('mcpServerStatus/list'),
    );
  });

  it('stops after five re-lists if the team stays starting', async () => {
    const integration = setupTeam();
    integration.client.mcp = [disabledServer, { ...teamServer, runtimeStatus: 'starting' }];
    await expect(integration.askCodex({ ...request, team })).rejects.toMatchObject({
      code: 'MCP_NOT_ISOLATED',
    });
    expect(
      integration.client.calls.filter((call) => call.method === 'mcpServerStatus/list'),
    ).toHaveLength(6);
    expect(integration.client.calls.some((call) => call.method === 'turn/start')).toBe(false);
    expect(integration.client.closed).toBe(true);
  });

  it('refuses incomplete status pages and inherited trusted-name collisions', async () => {
    const paged = setupTeam();
    paged.client.nextCursor = 'more';
    await expect(paged.askCodex({ ...request, team })).rejects.toMatchObject({
      code: 'MCP_NOT_ISOLATED',
    });
    const collision = setupTeam();
    collision.client.inheritedTeam = {
      command: 'foreign-command',
      http_headers: { Authorization: 'wrong-token' },
    };
    await expect(collision.askCodex({ ...request, team })).rejects.toMatchObject({
      code: 'MCP_NOT_ISOLATED',
    });
    expect(collision.client.calls.some((call) => call.method === 'thread/start')).toBe(false);
  });

  it('accepts and reports only Diomedes team calls without logging arguments or results', async () => {
    const integration = setupTeam();
    const onTeamToolCall = vi.fn();
    integration.client.items = [
      {
        id: 'call-1',
        type: 'mcpToolCall',
        server: 'diomedes_team',
        tool: 'team_members',
        status: 'completed',
        arguments: { private: 'secret' },
        result: { private: 'secret' },
      },
    ];
    await expect(integration.askCodex({ ...request, team, onTeamToolCall })).resolves.toMatchObject(
      { text: 'A native answer.' },
    );
    expect(onTeamToolCall).toHaveBeenCalledExactlyOnceWith('team_members');
  });

  it.each([
    { type: 'mcpToolCall', server: 'foreign', tool: 'team_members' },
    { type: 'mcpToolCall', server: 'diomedes_team_extra', tool: 'team_members' },
    { type: 'mcpToolCall', tool: 'diomedes_team__team_members' },
    { type: 'mcpToolCall', server: 'diomedes_team', tool: 'bad\nlog' },
    { type: 'commandExecution' },
    { type: 'fileChange' },
    { type: 'dynamicToolCall' },
    { type: 'webSearch' },
  ])('still refuses tools outside the team boundary (%j)', async (item) => {
    const integration = setupTeam();
    const onTeamToolCall = vi.fn();
    integration.client.items = [item];
    await expect(integration.askCodex({ ...request, team, onTeamToolCall })).rejects.toMatchObject({
      code: 'UNEXPECTED_TOOL',
    });
    expect(onTeamToolCall).not.toHaveBeenCalled();
    expect(integration.client.closed).toBe(true);
  });

  it('never allows the team server implicitly, and preserves the default disclosure', async () => {
    const integration = setup();
    integration.client.items = [
      { type: 'mcpToolCall', server: 'diomedes_team', tool: 'team_members' },
    ];
    await expect(integration.askCodex(request)).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
    expect(integration.createClient).toHaveBeenCalledWith();
    expect(nativeWorkDisclosure()).toBe(
      'Ask and Plan return text. Online Work proposes file changes that Diomedes applies only after your approval. Native filesystem, shell, browser, and MCP tools remain disabled.',
    );
    expect(nativeWorkDisclosure(team)).toContain('Diomedes team service and no other MCP service');
  });

  it.each([
    { url: 'https://external.example/mcp/team/project-1' },
    { url: 'http://127.0.0.1.example/mcp/team/project-1' },
    { url: 'http://user:password@127.0.0.1/mcp/team/project-1' },
    { url: `${team.url}?token=secret` },
    { url: 'not a URL' },
    { tokenEnv: 'OPENAI_API_KEY' },
    { tokenEnv: 'NODE_OPTIONS' },
    { tokenEnv: 'DIOMEDES_TEAM_MISSING_TOKEN' },
    { slotId: 'owner' },
    { slotId: 'bad\r\nHeader: value' },
    { roleInstructions: '' },
  ])('refuses unsafe or incomplete team options before launching (%j)', async (override) => {
    const integration = setupTeam();
    await expect(
      integration.askCodex({ ...request, team: { ...team, ...override } }),
    ).rejects.toMatchObject({ code: 'TEAM_CONFIG_INVALID' });
    expect(integration.createClient).not.toHaveBeenCalled();
  });
});

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
