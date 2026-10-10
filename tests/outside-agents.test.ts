/**
 * OA2: outside agents in a box, with Nectovia's tools in-band. The box request
 * is checked as data (no box is started here); the tool host runs real H12
 * steps over a real sandbox copy; both in-band channels are driven frame by
 * frame as the CLIs send them. Everything is local: temporary folders,
 * synthetic runs, no network, no agent.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CapabilityManifest, HarnessPrincipal } from '../shared/harness.js';
import { Store } from '../server/store.js';
import { FileRunStore, RunService } from '../server/harness/index.js';
import { SandboxStore } from '../server/sandbox/sandbox.js';
import type { AgentGatePort } from '../server/accounts/agent-gate.js';
import { containerRequest, runLayout, windowsArgument, type ContainedAgentPlan } from '../server/outside-agents/container-request.js';
import { launchContained, loadMxc, nodeSupportsStreaming, type ContainmentPort } from '../server/outside-agents/mxc.js';
import { OutsideToolHost, admitOutsideAgent } from '../server/outside-agents/tool-host.js';
import { answerCodexServerRequest, codexDynamicTools } from '../server/outside-agents/codex-tools.js';
import { ClaudeToolBridge, claudeCodeTurnPlan, claudeToolFlags } from '../server/outside-agents/claude-tools.js';

const plan = (over: Partial<ContainedAgentPlan> = {}): ContainedAgentPlan => ({
  executable: 'C:\\Users\\pat\\.local\\bin\\claude.exe',
  args: ['--print'],
  runRoot: 'C:\\Users\\pat\\AppData\\Local\\Nectovia\\runs\\r1',
  profile: 'C:\\Users\\pat',
  systemRoot: 'C:\\Windows',
  egress: [{ cidr: '160.79.104.10/32', port: 443 }],
  timeoutMs: 60_000,
  ...over,
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'no refusal';
};

describe('the box request', () => {
  test('one read-write folder, address-only egress, no inbound, UI without clipboard or injection, nothing inherited', () => {
    const request = containerRequest(plan({ signIn: { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-ant-oat01-test' }, env: { DISABLE_AUTOUPDATER: '1' } }));
    const root = 'C:\\Users\\pat\\AppData\\Local\\Nectovia\\runs\\r1';
    expect(request.filesystem).toEqual({ readwritePaths: [root], readonlyPaths: ['C:\\Users\\pat\\.local\\bin'] });
    expect(request.network).toEqual({
      egress: { default: 'deny', allow: [{ to: [{ cidr: '160.79.104.10/32' }], ports: [{ protocol: 'tcp', port: 443 }] }] },
      ingress: { default: 'deny', hostLoopback: 'deny' },
    });
    expect(request.ui).toEqual({ disable: false, clipboard: 'none', allowInputInjection: false });
    expect(request.containment).toEqual({ type: 'processcontainer', config: { captureDenials: { mode: 'block', outputPath: `${root}\\denials.json` } } });
    expect(request.inheritDefaultEnvironment).toBe(false);
    expect(request.workingDirectory).toBe(`${root}\\work`);
    expect(request.command).toBe('C:\\Users\\pat\\.local\\bin\\claude.exe --print');
    // Windows needs SystemRoot and LOCALAPPDATA present; every folder points inside the run.
    expect(request.environment).toMatchObject({
      SystemRoot: 'C:\\Windows',
      USERPROFILE: `${root}\\home`,
      LOCALAPPDATA: `${root}\\home\\AppData\\Local`,
      TEMP: `${root}\\tmp`,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test',
    });
    for (const name of Object.keys(request.environment)) expect(name).not.toMatch(/^(ANTHROPIC|OPENAI)_/);
  });

  test('no egress rule means no allow list at all', () => {
    expect(containerRequest(plan({ egress: [] })).network.egress).toEqual({ default: 'deny' });
  });

  test.each([
    ['a .cmd shim, which cmd.exe would re-read', { executable: 'C:\\Users\\pat\\AppData\\Roaming\\npm\\claude.cmd' }],
    ['a relative agent', { executable: 'claude.exe' }],
    ['a UNC agent', { executable: '\\\\server\\share\\claude.exe' }],
    ['the profile itself as the run folder', { runRoot: 'C:\\Users\\pat' }],
    ['a run folder holding the profile', { runRoot: 'C:\\Users' }],
    ['a drive root', { runRoot: 'D:\\' }],
    ['a run folder inside the real Claude home', { runRoot: 'C:\\Users\\pat\\.claude\\runs\\r1' }],
    ['a run folder inside the real Codex home, other case', { runRoot: 'C:\\USERS\\PAT\\.CODEX\\r1' }],
    ['a climbing run folder', { runRoot: 'C:\\Users\\pat\\AppData\\..\\..\\pat\\.claude' }],
    ['read-only access to the real Claude settings', { readonly: ['C:\\Users\\pat\\.claude'] }],
    ['read-only access to the whole profile', { readonly: ['C:\\Users\\pat'] }],
    ['a read-write grant in the Windows folder', { runRoot: 'C:\\Windows\\Temp\\r1' }],
    ['a /24', { egress: [{ cidr: '160.79.104.0/24', port: 443 }] }],
    ['everything', { egress: [{ cidr: '0.0.0.0/0', port: 443 }] }],
    ['a bare address', { egress: [{ cidr: '160.79.104.10', port: 443 }] }],
    ['loopback', { egress: [{ cidr: '127.0.0.1/32', port: 443 }] }],
    ['link-local', { egress: [{ cidr: '169.254.169.254/32', port: 80 }] }],
    ['IPv6 loopback', { egress: [{ cidr: '::1/128', port: 443 }] }],
    ['port zero', { egress: [{ cidr: '160.79.104.10/32', port: 0 }] }],
    ['an API key', { env: { ANTHROPIC_API_KEY: 'x' } }],
    ['a base URL that moves the route', { env: { ANTHROPIC_BASE_URL: 'https://example.test' } }],
    ['anything token-shaped', { env: { MY_SERVICE_TOKEN: 'x' } }],
    ['a proxy', { env: { HTTPS_PROXY: 'http://10.0.0.1:8080' } }],
    ['code injection through Node', { env: { NODE_OPTIONS: '--require x' } }],
    ['overriding the box home', { env: { USERPROFILE: 'C:\\Users\\pat' } }],
    ['overriding the box home, other case', { env: { localappdata: 'C:\\Users\\pat\\AppData\\Local' } }],
    ['a sign-in the box does not know', { signIn: { name: 'ANTHROPIC_AUTH_TOKEN', value: 'x' } }],
    ['an empty sign-in', { signIn: { name: 'CLAUDE_CODE_OAUTH_TOKEN' as const, value: '' } }],
    ['no timeout', { timeoutMs: 0 }],
    ['an argument with a line break', { args: ['--print', 'a\nb'] }],
  ])('refuses %s', (_, over) => {
    expect(code(() => containerRequest(plan(over as Partial<ContainedAgentPlan>)))).toBe('containment_refused');
  });

  test('arguments are quoted the way CommandLineToArgvW reads them back', () => {
    expect(windowsArgument('plain')).toBe('plain');
    expect(windowsArgument('')).toBe('""');
    expect(windowsArgument('two words')).toBe('"two words"');
    expect(windowsArgument('say "hi"')).toBe('"say \\"hi\\""');
    expect(windowsArgument('C:\\my dir\\')).toBe('"C:\\my dir\\\\"');
    expect(windowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
    expect(windowsArgument('{"a":1}')).toBe('"{\\"a\\":1}"');
  });
});

describe('starting the box', () => {
  test('streaming needs Node 24.21 or later', () => {
    expect(nodeSupportsStreaming('22.23.2')).toBe(false);
    expect(nodeSupportsStreaming('24.20.0')).toBe(false);
    expect(nodeSupportsStreaming('24.21.0')).toBe(true);
    expect(nodeSupportsStreaming('24.21.3')).toBe(true);
    expect(nodeSupportsStreaming('25.0.0')).toBe(true);
  });

  test('an old Node, another platform or a missing component is refused, never run outside a box', async () => {
    await expect(loadMxc(os.tmpdir(), '24.20.0')).rejects.toMatchObject({ code: 'containment_unavailable' });
    await expect(loadMxc(path.join(os.tmpdir(), 'no-such-mxc-sdk'), '24.21.0')).rejects.toMatchObject({ code: 'containment_unavailable' });
  });

  test.skipIf(process.platform !== 'win32')('the run folders exist before the request is sent, and the port gets the checked request', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oa2-launch-')));
    try {
      const seen: unknown[] = [];
      const port: ContainmentPort = {
        spawn: async (request) => {
          seen.push(request);
          for (const folder of ['home', 'tmp', 'work']) expect((await fs.stat(path.join(base, 'r1', folder))).isDirectory()).toBe(true);
          return { stdin: null!, stdout: null!, stderr: null!, wait: async () => ({ exitCode: 0, timedOut: false }), kill: () => {}, denials: () => null };
        },
      };
      const runRoot = path.join(base, 'r1');
      const profile = path.join(base, 'profile');
      const { request } = await launchContained(port, plan({ executable: 'C:\\Agents\\claude.exe', runRoot, profile }));
      expect(seen).toEqual([request]);
      expect((await fs.stat(runLayout(runRoot).local)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

// The tool host over a real sandbox copy, as project work would use it.
let base: string, store: Store, sandboxes: SandboxStore, projectId: string, folder: string, service: RunService;
let host: OutsideToolHost;
let now = 1000;
const principal = (id: string): HarnessPrincipal => ({ id: 'outside-agent', tenantId: 'local', projectId: id, capabilities: ['write-project-file'], identityGeneration: 1 });
const capability: CapabilityManifest = {
  id: 'outside-agent',
  version: 'v1',
  label: 'Outside agent',
  description: 'A person’s own agent working in a copy through Nectovia’s tools.',
  tools: ['list_project_files', 'read_project_file', 'write_file', 'propose_file'],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 8,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oa2-tools-')));
  store = new Store(path.join(base, 'data'), path.join(base, 'projects'));
  await store.init();
  sandboxes = new SandboxStore(store, store.dataDir);
  const project = await store.locked(() => store.createProject('Linen orders'));
  projectId = project.id;
  folder = project.folder;
  await fs.writeFile(path.join(folder, 'order.md'), 'Order 1182: 100 napkins.\n');
  now = 1000;
  service = new RunService(new FileRunStore(path.join(base, 'runs')), { clock: () => now });
  const manifest = await sandboxes.create({
    projectId,
    runId: 'Rlead-oa1',
    parentRunId: 'Rlead',
    rootRunId: 'Rlead',
    depth: 1,
    role: 'worker',
    base: { kind: 'project' },
    scope: null,
  });
  const registry = sandboxes.registry(manifest, { readable: () => true, write: true });
  await service.start({
    id: 'Rlead-oa1',
    tenantId: 'local',
    projectId,
    capability,
    principal: principal(projectId),
    budget: { units: 100, modelCalls: 5, toolCalls: 100, wallMs: null },
    tools: registry,
  });
  await service.claim('Rlead-oa1', 'host', 60_000);
  host = new OutsideToolHost({
    registry,
    runs: service,
    runId: 'Rlead-oa1',
    owner: 'host',
    principal: principal(projectId),
    admission: { admissionId: 'adm_1', validUntil: new Date(5000).toISOString() },
    clock: () => now,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});

const copy = () => sandboxes.work(projectId, 'Rlead-oa1');
const steps = async () => (await service.get('Rlead-oa1')).steps.length;

describe('the tool host', () => {
  test('paid work is admitted once, through the Agent gate, as an external engine', async () => {
    const check = vi.fn(async () => ({ admissionId: 'adm_1', validUntil: 'x' }) as never);
    await admitOutsideAgent({ check } as AgentGatePort, { surface: 'work', projectId, rootJobId: 'Rlead' });
    expect(check).toHaveBeenCalledWith({ phase: 'admit', surface: 'work', projectId, rootJobId: 'Rlead', routeKind: 'external-engine' });
  });

  test('the agent is told names, descriptions and object schemas, nothing else', () => {
    const tools = host.tools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_project_files', 'propose_file', 'read_project_file', 'write_file']);
    for (const tool of tools) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'inputSchema', 'name']);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema).not.toHaveProperty('$schema');
    }
  });

  test('a read and a write run as recorded steps; the write lands in the copy, never the project', async () => {
    const read = await host.call('read_project_file', { path: 'order.md' }, 'c1');
    expect(read.ok).toBe(true);
    expect(JSON.parse(read.text)).toMatchObject({ path: 'order.md', found: true, text: 'Order 1182: 100 napkins.\n' });
    const write = await host.call('write_file', { path: 'order.md', text: 'Order 1182: 120 napkins.\n' }, 'c2');
    expect(write).toMatchObject({ ok: true });
    expect(await fs.readFile(path.join(copy(), 'order.md'), 'utf8')).toBe('Order 1182: 120 napkins.\n');
    expect(await fs.readFile(path.join(folder, 'order.md'), 'utf8')).toBe('Order 1182: 100 napkins.\n');
    expect(await steps()).toBe(2);
  });

  test('the same call id is the same step, answered from the record', async () => {
    const first = await host.call('write_file', { path: 'note.md', text: 'one\n' }, 'same');
    const again = await host.call('write_file', { path: 'note.md', text: 'one\n' }, 'same');
    expect(again).toEqual(first);
    expect(await steps()).toBe(1);
  });

  test('a climbing path is refused by the copy’s own funnel, and nothing outside it changes', async () => {
    const answer = await host.call('write_file', { path: '../../escape.md', text: 'x' }, 'c3');
    expect(answer.text).toMatch(/path_traversal|refused/);
    await expect(fs.stat(path.join(base, 'escape.md'))).rejects.toThrow();
    expect(await fs.readFile(path.join(folder, 'order.md'), 'utf8')).toBe('Order 1182: 100 napkins.\n');
  });

  test('an unknown tool, a malformed name or bad arguments run nothing', async () => {
    expect(await host.call('Bash', { command: 'whoami' }, 'c4')).toMatchObject({ ok: false, text: expect.stringContaining('tool_unknown') });
    expect(await host.call('mcp__x__y; rm', {}, 'c5')).toMatchObject({ ok: false, text: expect.stringContaining('tool_unknown') });
    const bad = await host.call('write_file', { path: 'a.md', text: 1 }, 'c6');
    expect(bad.ok).toBe(false);
    expect(await steps()).toBe(0);
  });

  test('past the admission, a call is refused before any step', async () => {
    now = 5000;
    expect(await host.call('write_file', { path: 'late.md', text: 'x' }, 'c7')).toMatchObject({ ok: false, text: expect.stringContaining('admission_expired') });
    await expect(fs.stat(path.join(copy(), 'late.md'))).rejects.toThrow();
    expect(await steps()).toBe(0);
  });
});

describe('Codex dynamic tools', () => {
  const call = (params: Record<string, unknown>, id: string | number = 7) => ({
    id,
    method: 'item/tool/call',
    params: { threadId: 'thr_1', turnId: 'turn_1', callId: 'call_1', tool: 'read_project_file', arguments: { path: 'order.md' }, ...params },
  });

  test('the tools go to thread/start as function specs', () => {
    const specs = codexDynamicTools(host);
    expect(specs).toHaveLength(4);
    for (const spec of specs) expect(Object.keys(spec).sort()).toEqual(['description', 'inputSchema', 'name', 'type']);
    expect(specs.every((spec) => spec.type === 'function')).toBe(true);
  });

  test('a call for our thread runs and answers with input text', async () => {
    const answer = await answerCodexServerRequest(host, call({}), 'thr_1');
    expect(answer?.blocked).toBe(false);
    expect(answer?.reply).toMatchObject({ id: 7, result: { success: true, contentItems: [{ type: 'inputText', text: expect.stringContaining('100 napkins') }] } });
  });

  test('a failed tool is a result with success false, not a protocol error', async () => {
    const answer = await answerCodexServerRequest(host, call({ tool: 'shell', callId: 'call_2' }), 'thr_1');
    expect(answer).toMatchObject({ blocked: false, reply: { id: 7, result: { success: false } } });
    const namespaced = await answerCodexServerRequest(host, call({ namespace: 'other', callId: 'call_3' }), 'thr_1');
    expect(namespaced).toMatchObject({ blocked: false, reply: { result: { success: false } } });
    expect(await steps()).toBe(0);
  });

  test('another thread, a malformed call or any other server request is refused and blocks the turn', async () => {
    expect(await answerCodexServerRequest(host, call({ threadId: 'thr_other' }), 'thr_1')).toMatchObject({ blocked: true, reply: { error: { code: -32602 } } });
    expect(await answerCodexServerRequest(host, call({ callId: 5 }), 'thr_1')).toMatchObject({ blocked: true, reply: { error: { code: -32602 } } });
    const approval = { id: 'a1', method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf /' } };
    expect(await answerCodexServerRequest(host, approval, 'thr_1')).toMatchObject({ blocked: true, reply: { id: 'a1', error: { code: -32601 } } });
    expect(await steps()).toBe(0);
  });

  test('a notification or a response is not a server request', async () => {
    expect(await answerCodexServerRequest(host, { method: 'turn/started', params: {} }, 'thr_1')).toBeNull();
    expect(await answerCodexServerRequest(host, { id: 3, result: {} }, 'thr_1')).toBeNull();
  });
});

describe('Claude Code in-band MCP', () => {
  const mcp = (requestId: string, message: Record<string, unknown>, server = 'nectovia') => ({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'mcp_message', server_name: server, message: { jsonrpc: '2.0', ...message } },
  });
  const inner = (reply: unknown) => (reply as { reply: { response: { response: { mcp_response: Record<string, unknown> } } } }).reply.response.response.mcp_response;

  test('the flags switch built-ins off, keep other servers out and allow exactly our tools', () => {
    const flags = claudeToolFlags(host);
    expect(flags.slice(0, 3)).toEqual(['--tools', '', '--strict-mcp-config']);
    expect(JSON.parse(flags[4]!)).toEqual({ mcpServers: { nectovia: { type: 'sdk', name: 'nectovia' } } });
    expect(flags[6]!.split(',').sort()).toEqual([
      'mcp__nectovia__list_project_files',
      'mcp__nectovia__propose_file',
      'mcp__nectovia__read_project_file',
      'mcp__nectovia__write_file',
    ]);
  });

  test('a contained turn signs in with the setup token and keeps its config inside the run', () => {
    const runRoot = 'C:\\Users\\pat\\AppData\\Local\\Nectovia\\runs\\r2';
    const request = containerRequest(
      claudeCodeTurnPlan({
        executable: 'C:\\Users\\pat\\.local\\bin\\claude.exe',
        runRoot,
        profile: 'C:\\Users\\pat',
        systemRoot: 'C:\\Windows',
        token: 'sk-ant-oat01-test',
        egress: [{ cidr: '160.79.104.10/32', port: 443 }],
        timeoutMs: 120_000,
        host,
      }),
    );
    expect(request.environment.CLAUDE_CONFIG_DIR).toBe(`${runRoot}\\home\\.claude`);
    expect(request.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test');
    expect(request.command).toContain('--input-format stream-json');
    expect(request.command).toContain('--tools ""');
    expect(request.command).toContain('"{\\"disableAllHooks\\":true}"');
  });

  test('initialize, initialized, tools/list and tools/call go through the SDK server and back as mcp_response', async () => {
    const bridge = new ClaudeToolBridge(host);
    const init = await bridge.answer(mcp('r1', { id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.281' } } }));
    expect(init?.blocked).toBe(false);
    expect(init?.reply).toMatchObject({ type: 'control_response', response: { subtype: 'success', request_id: 'r1' } });
    expect(inner(init)).toMatchObject({ jsonrpc: '2.0', id: 0, result: { serverInfo: { name: 'nectovia' }, capabilities: { tools: {} } } });
    expect(inner(await bridge.answer(mcp('r2', { method: 'notifications/initialized' })))).toEqual({ jsonrpc: '2.0', result: {} });
    const list = inner(await bridge.answer(mcp('r3', { id: 1, method: 'tools/list', params: {} })));
    expect((list.result as { tools: { name: string }[] }).tools.map((tool) => tool.name).sort()).toEqual(['list_project_files', 'propose_file', 'read_project_file', 'write_file']);
    const called = inner(await bridge.answer(mcp('r4', { id: 2, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'order.md', text: 'Order 1182: 90 napkins.\n' } } })));
    expect(called).toMatchObject({ id: 2, result: { isError: false, content: [{ type: 'text' }] } });
    expect(await fs.readFile(path.join(copy(), 'order.md'), 'utf8')).toBe('Order 1182: 90 napkins.\n');
    expect(await fs.readFile(path.join(folder, 'order.md'), 'utf8')).toBe('Order 1182: 100 napkins.\n');
    // The same JSON-RPC id in a later turn is a new call, not a replay of the first.
    const later = inner(await bridge.answer(mcp('r5', { id: 2, method: 'tools/call', params: { name: 'read_project_file', arguments: { path: 'order.md' } } })));
    expect(later).toMatchObject({ result: { isError: false, content: [{ text: expect.stringContaining('90 napkins') }] } });
    expect(await steps()).toBe(2);
  });

  test('an unknown tool comes back as an MCP tool error, and runs nothing', async () => {
    const bridge = new ClaudeToolBridge(host);
    await bridge.answer(mcp('r1', { id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } }));
    const called = inner(await bridge.answer(mcp('r2', { id: 1, method: 'tools/call', params: { name: 'Bash', arguments: { command: 'whoami' } } })));
    expect(called).toMatchObject({ result: { isError: true } });
    expect(await steps()).toBe(0);
  });

  test('the permission request allows exactly our tools; anything else is denied and blocks the turn', async () => {
    const bridge = new ClaudeToolBridge(host);
    const ask = (tool: string) => ({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: tool, input: { path: 'order.md' } } });
    expect(await bridge.answer(ask('mcp__nectovia__read_project_file'))).toMatchObject({ blocked: false, reply: { response: { response: { behavior: 'allow', updatedInput: { path: 'order.md' } } } } });
    for (const tool of ['Bash', 'Write', 'mcp__nectovia__shell', 'mcp__other__read_project_file'])
      expect(await bridge.answer(ask(tool))).toMatchObject({ blocked: true, reply: { response: { response: { behavior: 'deny', interrupt: true } } } });
  });

  test('another server, a malformed message or another control request is denied; other frames are the driver’s', async () => {
    const bridge = new ClaudeToolBridge(host);
    expect(await bridge.answer(mcp('r1', { id: 0, method: 'tools/list' }, 'filesystem'))).toMatchObject({ blocked: true });
    expect(await bridge.answer({ type: 'control_request', request_id: 'r2', request: { subtype: 'mcp_message', server_name: 'nectovia', message: { id: 1 } } })).toMatchObject({ blocked: true });
    expect(await bridge.answer({ type: 'control_request', request_id: 'r3', request: { subtype: 'hook_callback', callback_id: 'x' } })).toMatchObject({ blocked: true });
    expect(await bridge.answer({ type: 'assistant', message: {} })).toBeNull();
    expect(await bridge.answer({ type: 'control_request', request: { subtype: 'mcp_message' } })).toBeNull();
  });
});
