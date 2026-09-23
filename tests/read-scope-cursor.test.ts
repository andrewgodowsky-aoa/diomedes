import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../server/integrations.js', () => ({
  killOwnedProcess: async (child: ChildProcessWithoutNullStreams) => {
    child.kill();
  },
}));
import type { RawToolActivity } from '../shared/adapter-contract.js';
import {
  CursorAdapter,
  CURSOR_ACCOUNT_ROUTE,
  cursorPermissions,
  type CursorAdapterDeps,
} from '../server/engines/cursor.js';
import type { TextRequest } from '../server/engines/contract.js';
import type { ReadScope } from '../server/engines/read-scope.js';

type Json = Record<string, unknown>;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const request: TextRequest = {
  projectId: 'project',
  threadId: 'thread',
  requestId: 'request',
  accountRoute: CURSOR_ACCOUNT_ROUTE,
  model: 'fixture[effort=low]',
  prompt: 'When does Harbor Street open?',
  documents: [],
  instructions: 'Answer plainly.',
};

/**
 * Cursor ACP as a scripted child: the handshake the adapter needs, then the
 * `script` frames for the prompt — session updates and, for a permission ask,
 * a server-to-client request — then the answer.
 */
async function fixture(script: (project: string) => Json[]) {
  const engine = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes cursor engine '));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes cursor project '));
  roots.push(engine, project);
  const sent: Json[] = [];
  const configs: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 100,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(() => {
      child.exitCode = 0;
      child.emit('close', 0);
      return true;
    }),
  });
  const emit = (value: Json) => child.stdout.write(JSON.stringify(value) + '\n');
  const update = (value: Json) =>
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session', update: value } });
  const reply = (id: unknown, result: Json) => emit({ jsonrpc: '2.0', id, result });
  child.stdin.on('data', (chunk) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      const frame = JSON.parse(line) as Json;
      sent.push(frame);
      if (!frame.method) continue;
      queueMicrotask(() => {
        switch (frame.method) {
          case 'initialize':
            return reply(frame.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
          case 'session/new':
            return reply(frame.id, {
              sessionId: 'session',
              modes: { currentModeId: 'agent', availableModes: [{ id: 'ask' }] },
              models: { availableModels: [{ modelId: request.model, name: 'Fixture' }] },
            });
          case 'session/set_mode':
            update({ sessionUpdate: 'current_mode_update', currentModeId: 'ask' });
            return reply(frame.id, {});
          case 'session/set_model':
            return reply(frame.id, {});
          case 'session/prompt':
            for (const step of script(project)) {
              if (step.request) emit({ jsonrpc: '2.0', id: 0, method: step.request, params: step.params });
              else update(step);
            }
            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Opens at 11.' } });
            setTimeout(() => reply(frame.id, { stopReason: 'end_turn' }), 20);
            return;
        }
      });
    }
  });
  const launches: { cwd?: string; env: NodeJS.ProcessEnv }[] = [];
  const launch = vi.fn<NonNullable<CursorAdapterDeps['spawn']>>((_file, _args, options) => {
    const env = (options?.env ?? {}) as NodeJS.ProcessEnv;
    launches.push({ cwd: options?.cwd?.toString(), env });
    if (env.CURSOR_CONFIG_DIR)
      configs.push(
        fsSync.readFileSync(path.join(env.CURSOR_CONFIG_DIR, 'cli-config.json'), 'utf8'),
      );
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const capture = vi.fn<NonNullable<CursorAdapterDeps['capture']>>(async (options) =>
    options.args.includes('--version')
      ? { stdout: '2026.08.11-e8db854', code: 0 }
      : { stdout: JSON.stringify({ status: 'authenticated', isAuthenticated: true }), code: 0 },
  );
  const adapter = new CursorAdapter('cursor.exe', engine, {
    spawn: launch,
    capture,
    startupTimeoutMs: 1000,
    requestTimeoutMs: 1000,
  });
  return { adapter, sent, launches, configs, project, engine };
}
const scopeFor = (root: string, extra: Partial<ReadScope> = {}): ReadScope => ({
  root,
  web: true,
  ...extra,
});
const permission = (toolCall: Json) => ({
  request: 'session/request_permission',
  params: {
    sessionId: 'session',
    toolCall,
    options: [
      { kind: 'allow_once', optionId: 'allow-once' },
      { kind: 'reject_once', optionId: 'reject-once' },
    ],
  },
});

describe('Cursor read scope permissions', () => {
  it('keeps every tool denied without a scope', () => {
    expect(cursorPermissions().permissions).toEqual({
      allow: [],
      deny: ['Shell(*)', 'Read(**)', 'Write(**)', 'WebFetch(*)', 'WebSearch(*)', 'Mcp(*:*)'],
    });
    expect(cursorPermissions().autoAcceptWebSearch).toBe(false);
  });
  it('allows web, never file reads, shell, writes or MCP', () => {
    const scoped = cursorPermissions({ root: 'C:\\p', web: true });
    expect(scoped.permissions.allow).toEqual(['WebFetch(*)', 'WebSearch(*)']);
    expect(scoped.permissions.deny).toEqual(['Shell(*)', 'Read(**)', 'Write(**)', 'Mcp(*:*)']);
    expect(cursorPermissions({ root: 'C:\\p', web: false }).permissions.deny).toContain(
      'WebSearch(*)',
    );
  });
});

describe('Cursor read turns', () => {
  it('works in a private workspace, streams web activity and allows a web ask', async () => {
    const { adapter, sent, launches, configs, project, engine } = await fixture(() => [
      permission({ toolCallId: 't1', kind: 'fetch', rawInput: { url: 'https://example.com/hours' } }),
      { sessionUpdate: 'plan', entries: [{ content: 'Check hours', status: 'pending' }] },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't2',
        kind: 'fetch',
        title: 'Search the web',
        status: 'in_progress',
        rawInput: { query: 'Harbor Street hours' },
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed' },
    ]);
    const activity: RawToolActivity[] = [];
    const result = await adapter.generate({
      ...request,
      readScope: scopeFor(project),
      onToolActivity: (raw) => activity.push(raw),
    });
    expect(result.text).toBe('Opens at 11.');
    // No turn needs the project folder: its documents travel inline.
    expect(launches[0].cwd?.startsWith(engine)).toBe(true);
    expect(launches[0].cwd).not.toBe(project);
    expect(sent.find((frame) => frame.method === 'session/new')?.params).toMatchObject({
      cwd: launches[0].cwd,
      mcpServers: [],
    });
    expect(JSON.parse(configs[0]).permissions.deny).toEqual(
      expect.arrayContaining(['Shell(*)', 'Read(**)']),
    );
    // The web ask was answered allow_once.
    expect(sent.find((frame) => frame.id === 0)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
    expect(activity.map((a) => [a.phase, a.summary])).toEqual([
      ['started', 'Searching the web for Harbor Street hours'],
      ['finished', 'Read finished'],
    ]);
    expect(await fs.readdir(project)).toEqual([]);
  });
  it.each(['read', 'search', 'edit', 'delete', 'move', 'execute', 'switch_mode', 'other'])(
    'stops a %s tool call',
    async (kind) => {
      const { adapter, project } = await fixture(() => [
        { sessionUpdate: 'tool_call', toolCallId: 't1', kind, title: kind, status: 'pending' },
      ]);
      await expect(
        adapter.generate({ ...request, readScope: scopeFor(project) }),
      ).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
    },
  );
  it('rejects and stops a permission ask for a command', async () => {
    const { adapter, sent, project } = await fixture(() => [
      permission({ toolCallId: 't1', kind: 'execute', rawInput: { command: 'rm -rf .' } }),
    ]);
    await expect(
      adapter.generate({ ...request, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
    expect(sent.find((frame) => frame.id === 0)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    });
  });
  it('stops a read outside the project folder', async () => {
    const { adapter, project } = await fixture(() => [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        kind: 'read',
        status: 'pending',
        locations: [{ path: path.join(os.homedir(), '.ssh', 'id_rsa') }],
      },
    ]);
    await expect(
      adapter.generate({ ...request, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
  });
  it('stops a fetch without web access', async () => {
    const { adapter, project } = await fixture(() => [
      { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'fetch', status: 'pending' },
    ]);
    await expect(
      adapter.generate({ ...request, readScope: scopeFor(project, { web: false }) }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
  });
  it('stops an update that turns a read into an edit', async () => {
    const { adapter, project } = await fixture((root) => [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        kind: 'read',
        status: 'pending',
        locations: [{ path: path.join(root, 'menu.md') }],
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: 'edit', status: 'in_progress' },
    ]);
    await expect(
      adapter.generate({ ...request, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
  });
  it('keeps any tool call fatal on the text-only route, in a private workspace', async () => {
    const { adapter, launches, project, engine } = await fixture((root) => [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        kind: 'read',
        status: 'pending',
        locations: [{ path: path.join(root, 'menu.md') }],
      },
    ]);
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
    expect(launches[0].cwd?.startsWith(engine)).toBe(true);
    expect(launches[0].cwd).not.toBe(project);
  });
});
