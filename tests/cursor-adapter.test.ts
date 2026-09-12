import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const cleanup = vi.hoisted(() => ({ fail: false }));
vi.mock('../server/integrations.js', () => ({
  killOwnedProcess: async (child: ChildProcessWithoutNullStreams) => {
    if (cleanup.fail) throw new Error('native secret diagnostic');
    child.kill();
  },
}));
import {
  CursorAdapter,
  CURSOR_ACCOUNT_ROUTE,
  CURSOR_VERSION,
  cursorCommand,
  resolveCursorEntry,
  type CursorAdapterDeps,
} from '../server/engines/cursor.js';
import type { TextRequest } from '../server/engines/contract.js';
import { record } from '../server/engines/process.js';

type Json = Record<string, unknown>;
const roots: string[] = [];
afterEach(async () => {
  cleanup.fail = false;
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const request: TextRequest = {
  projectId: 'project',
  threadId: 'thread',
  requestId: 'request',
  accountRoute: CURSOR_ACCOUNT_ROUTE,
  model: 'fixture[effort=low,fast=false]',
  prompt: 'Question',
  documents: [{ path: 'Note.md', text: 'untrusted input' }],
  instructions: 'Answer plainly.',
};
const initialized = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { audio: false, embeddedContext: false, image: true },
    sessionCapabilities: { list: {} },
  },
  authMethods: [
    {
      id: 'cursor_login',
      name: 'Cursor Login',
      description:
        "Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in.",
    },
  ],
};

async function fixture(mode = 'ok', deps: CursorAdapterDeps = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes cursor '));
  roots.push(root);
  const sent: Json[] = [],
    order: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 100,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(() => {
      child.exitCode = 0;
      order.push('kill');
      child.emit('close', 0);
      return true;
    }),
  });
  const emit = (value: Json) => child.stdout.write(JSON.stringify(value) + '\n');
  const update = (value: Json, sessionId = 'session') =>
    emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: value },
    });
  const reply = (id: unknown, result: Json) => emit({ jsonrpc: '2.0', id, result });
  const capture = vi.fn<NonNullable<CursorAdapterDeps['capture']>>(async (options) => {
    if (options.signal?.aborted) throw Object.assign(new Error('Stopped'), { code: 'CANCELLED' });
    if (options.args.includes('--version'))
      return {
        stdout: mode === 'version' ? '2026.08.12-new' : '2026.08.11-e8db854',
        code: 0,
      };
    return {
      code: mode === 'signed-out' ? 1 : 0,
      stdout:
        mode === 'bad-status'
          ? '{bad'
          : JSON.stringify({
              status: 'authenticated',
              isAuthenticated: mode !== 'signed-out',
            }),
    };
  });
  child.stdin.on('data', (chunk) => {
    const frame = JSON.parse(String(chunk)) as Json;
    sent.push(frame);
    order.push(typeof frame.method === 'string' ? frame.method : `reply:${frame.id}`);
    if (!frame.method) return;
    queueMicrotask(() => {
      switch (frame.method) {
        case 'initialize':
          if (mode !== 'startup-hang')
            reply(frame.id, mode === 'protocol-version' ? { protocolVersion: 2 } : initialized);
          break;
        case 'session/new':
          if (mode === 'auth-expired') {
            emit({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32000, message: 'Authentication required' },
            });
            break;
          }
          reply(frame.id, {
            sessionId: 'session',
            modes: { currentModeId: 'agent', availableModes: [{ id: 'ask' }] },
            models: {
              currentModelId: 'default[]',
              availableModels: [
                { modelId: 'default[]', name: 'Auto' },
                { modelId: request.model, name: 'Fixture' },
              ],
            },
          });
          break;
        case 'session/set_mode':
          update({
            sessionUpdate: 'current_mode_update',
            currentModeId: mode === 'wrong-mode' ? 'agent' : 'ask',
          });
          reply(frame.id, {});
          break;
        case 'session/set_model':
          if (mode !== 'no-model-report')
            update({
              sessionUpdate: 'config_option_update',
              configOptions: [
                {
                  id: 'model',
                  category: 'model',
                  currentValue: mode === 'reported-model' ? 'runtime[effort=low]' : request.model,
                },
              ],
            });
          reply(frame.id, {});
          break;
        case 'session/prompt':
          if (mode === 'hang') break;
          if (mode === 'malformed') {
            child.stdout.write('{broken\n');
            break;
          }
          if (mode === 'oversized') {
            child.stdout.write('x'.repeat(512 * 1024 + 1));
            break;
          }
          if (mode === 'aggregate') {
            for (let i = 0; i < 9; i++) child.stdout.write('\n'.repeat(512 * 1024));
            break;
          }
          if (mode === 'stderr-limit') {
            child.stderr.write('x'.repeat(512 * 1024 + 1));
            break;
          }
          if (mode === 'tool' || mode === 'tool-update' || mode === 'plan') {
            update({
              sessionUpdate:
                mode === 'tool' ? 'tool_call' : mode === 'plan' ? 'plan' : 'tool_call_update',
              toolCallId: 'tool',
              status: 'pending',
            });
            break;
          }
          if (
            [
              'permission',
              'no-reject-option',
              'question',
              'create-plan',
              'filesystem',
              'unknown-request',
            ].includes(mode)
          ) {
            emit({
              jsonrpc: '2.0',
              id: 0,
              method:
                mode === 'question'
                  ? 'cursor/ask_question'
                  : mode === 'create-plan'
                    ? 'cursor/create_plan'
                    : mode === 'filesystem'
                      ? 'fs/read_text_file'
                      : mode === 'unknown-request'
                        ? 'future/client_request'
                        : 'session/request_permission',
              params: {
                sessionId: 'session',
                options: [
                  { kind: 'allow_once', optionId: 'allow-once' },
                  ...(mode === 'no-reject-option'
                    ? []
                    : [{ kind: 'reject_once', optionId: 'reject-once' }]),
                ],
              },
            });
            // A success-shaped response arriving alongside a request must never win.
            reply(frame.id, { stopReason: 'end_turn' });
            break;
          }
          if (mode === 'wrong-session') {
            update(
              {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Wrong' },
              },
              'other',
            );
            break;
          }
          if (mode === 'quota') {
            emit({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32603, message: 'Usage limit' },
            });
            break;
          }
          if (mode === 'exit') {
            child.exitCode = 1;
            child.emit('close', 1);
            break;
          }
          if (mode === 'abort') {
            update({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'first' },
            });
            update({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'late' },
            });
          } else if (mode === 'utf8') {
            const data = Buffer.from(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'session',
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: '\u00e9' },
                  },
                },
              }) + '\n',
            );
            const index = data.indexOf(Buffer.from('\u00e9')) + 1;
            child.stdout.write(data.subarray(0, index));
            child.stdout.write(data.subarray(index));
          } else
            update({
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: mode === 'reported-model' ? 'I am a different model' : 'READY',
              },
            });
          reply(frame.id, {
            stopReason: mode === 'incomplete' ? 'max_tokens' : 'end_turn',
          });
          break;
        case 'session/cancel':
          break; // ACP cancellation is a notification, not a request.
      }
    });
  });
  const launch = vi.fn<NonNullable<CursorAdapterDeps['spawn']>>(
    () => child as unknown as ChildProcessWithoutNullStreams,
  );
  const adapter = new CursorAdapter('cursor.exe', root, {
    spawn: launch,
    capture,
    startupTimeoutMs: 500,
    requestTimeoutMs: 500,
    ...deps,
  });
  return { root, adapter, sent, order, child, launch, capture };
}

describe('Cursor ACP text route', () => {
  it('inspects native status and the explicit ACP model catalogue without prompting or authenticating', async () => {
    const { adapter, sent, capture } = await fixture();
    await expect(adapter.inspect()).resolves.toMatchObject({
      authentication: 'signed-in',
      accountRoute: CURSOR_ACCOUNT_ROUTE,
      models: [{ slug: request.model }],
    });
    expect(capture.mock.calls[0][0].args).toEqual(['status', '--format', 'json']);
    expect(
      sent.some((frame) => ['authenticate', 'session/prompt'].includes(String(frame.method))),
    ).toBe(false);
  });
  it('returns signed-out without launching ACP or opening login', async () => {
    const { adapter, launch } = await fixture('signed-out');
    await expect(adapter.inspect()).resolves.toEqual({
      authentication: 'signed-out',
      accountRoute: null,
      models: [],
      detail: 'Sign in through Cursor, then recheck.',
    });
    expect(launch).not.toHaveBeenCalled();
  });
  it('sends bounded context through stdin, disables client capabilities and installs native deny rules', async () => {
    vi.stubEnv('CURSOR_API_KEY', 'must-not-pass');
    vi.stubEnv('CURSOR_API_ENDPOINT', 'must-not-pass');
    const { adapter: waiting, launch: waitingLaunch, sent: waitingSent } = await fixture('hang');
    const controller = new AbortController();
    const job = waiting.generate({ ...request, signal: controller.signal });
    const rejected = expect(job).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect
      .poll(() => waitingSent.some((frame) => frame.method === 'session/prompt'))
      .toBe(true);
    const [file, args, options] = waitingLaunch.mock.calls[0];
    expect(file).toBe('cursor.exe');
    expect(args).toEqual(['--mode', 'ask', 'acp']);
    expect(options?.shell).toBe(false);
    expect(options?.env?.CURSOR_API_KEY).toBeUndefined();
    expect(options?.env?.CURSOR_API_ENDPOINT).toBeUndefined();
    const config = JSON.parse(
      await fs.readFile(path.join(options!.env!.CURSOR_CONFIG_DIR!, 'cli-config.json'), 'utf8'),
    );
    expect(config.permissions).toEqual({
      allow: [],
      deny: ['Shell(*)', 'Read(**)', 'Write(**)', 'WebFetch(*)', 'WebSearch(*)', 'Mcp(*:*)'],
    });
    expect(record(waitingSent[0].params).clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    expect(
      record(waitingSent.find((frame) => frame.method === 'session/new')!.params).mcpServers,
    ).toEqual([]);
    const prompt = waitingSent.find((frame) => frame.method === 'session/prompt')!;
    const blocks = record(prompt.params).prompt as {
      type: string;
      text: string;
    }[];
    expect(JSON.parse(blocks[0].text)).toEqual({
      instructions: request.instructions,
      input: { request: request.prompt, documents: request.documents },
    });
    controller.abort();
    await rejected;
  });
  it('returns text, runtime selection, version and logical request identity', async () => {
    const { adapter } = await fixture();
    const deltas: string[] = [];
    await expect(
      adapter.generate({ ...request, onDelta: (value) => deltas.push(value) }),
    ).resolves.toEqual({
      text: 'READY',
      model: request.model,
      version: CURSOR_VERSION,
      projectId: 'project',
      threadId: 'thread',
      requestId: 'request',
    });
    expect(deltas).toEqual(['READY']);
  });
  it('attributes the runtime model even when answer text claims another identity', async () => {
    const { adapter } = await fixture('reported-model');
    await expect(adapter.generate(request)).resolves.toMatchObject({
      model: 'runtime[effort=low]',
      text: 'I am a different model',
    });
  });
  it('uses the requested model only when no turn selection is reported', async () => {
    const { adapter } = await fixture('no-model-report');
    await expect(adapter.generate(request)).resolves.toMatchObject({
      model: request.model,
      version: CURSOR_VERSION,
    });
  });
  it.each(['tool', 'tool-update', 'plan'])(
    'rejects %s events and sends cancellation before process stop',
    async (mode) => {
      const { adapter, order } = await fixture(mode);
      await expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'UNEXPECTED_TOOL',
      });
      expect(order.slice(-2)).toEqual(['session/cancel', 'kill']);
    },
  );
  it.each([
    ['permission', { outcome: { outcome: 'selected', optionId: 'reject-once' } }],
    ['no-reject-option', { outcome: { outcome: 'cancelled' } }],
    ['question', { outcome: { outcome: 'skipped', reason: expect.any(String) } }],
    ['create-plan', { outcome: { outcome: 'rejected', reason: expect.any(String) } }],
  ])('answers %s, then fails even if a success result arrives', async (mode, result) => {
    const { adapter, sent, order } = await fixture(mode as string);
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'UNEXPECTED_TOOL',
      message: expect.stringContaining('denied'),
    });
    expect(sent.find((frame) => frame.id === 0)).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result,
    });
    expect(order.slice(-3)).toEqual(['reply:0', 'session/cancel', 'kill']);
  });
  it.each(['filesystem', 'unknown-request'])(
    'answers %s with a JSON-RPC refusal rather than hanging',
    async (mode) => {
      const { adapter, sent } = await fixture(mode);
      await expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'UNEXPECTED_TOOL',
      });
      expect(sent.find((frame) => frame.id === 0)).toMatchObject({
        error: { code: -32601 },
      });
    },
  );
  it('aborts mid-turn, sends session/cancel and drops late deltas and results', async () => {
    const { adapter, order } = await fixture('abort');
    const controller = new AbortController();
    const deltas: string[] = [];
    await expect(
      adapter.generate({
        ...request,
        signal: controller.signal,
        onDelta: (value) => {
          deltas.push(value);
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(deltas).toEqual(['first']);
    expect(order.slice(-2)).toEqual(['session/cancel', 'kill']);
  });
  it('rejects cancellation during process cleanup after a complete turn', async () => {
    const { adapter, child } = await fixture();
    const controller = new AbortController();
    child.kill.mockImplementation(() => {
      controller.abort();
      child.exitCode = 0;
      child.emit('close', 0);
      return true;
    });
    await expect(adapter.generate({ ...request, signal: controller.signal })).rejects.toMatchObject(
      { code: 'CANCELLED' },
    );
  });
  it('reports a synchronous launch failure without exposing native diagnostics', async () => {
    const { adapter } = await fixture('ok', {
      spawn: () => {
        throw new Error('native secret diagnostic');
      },
    });
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'LAUNCH_FAILED',
      message: 'Cursor could not start. Recheck its installation.',
    });
  });
  it.each([
    ['malformed', 'PROTOCOL_ERROR'],
    ['oversized', 'OUTPUT_LIMIT'],
    ['aggregate', 'OUTPUT_LIMIT'],
    ['stderr-limit', 'OUTPUT_LIMIT'],
    ['wrong-session', 'PROTOCOL_ERROR'],
    ['incomplete', 'PROTOCOL_ERROR'],
    ['protocol-version', 'PROTOCOL_ERROR'],
    ['wrong-mode', 'POLICY_MISMATCH'],
    ['exit', 'PROTOCOL_ERROR'],
    ['version', 'UNSUPPORTED_VERSION'],
    ['quota', 'USAGE_LIMIT'],
    ['auth-expired', 'AUTH_REQUIRED'],
    ['bad-status', 'AUTH_UNKNOWN'],
  ])('fails %s without accepting output', async (mode, code) => {
    const { adapter } = await fixture(mode);
    await expect(adapter.generate(request)).rejects.toMatchObject({ code });
  });
  it.each(['startup-hang', 'hang'])('bounds %s independently of cancellation', async (mode) => {
    const { adapter } = await fixture(mode, {
      startupTimeoutMs: 100,
      requestTimeoutMs: 20,
    });
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
  it('decodes UTF-8 split across chunks', async () => {
    const { adapter } = await fixture('utf8');
    await expect(adapter.generate(request)).resolves.toMatchObject({
      text: '\u00e9',
    });
  });
  it('does not spawn for an aborted request or a different account', async () => {
    const { adapter, launch } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.generate({ ...request, signal: controller.signal })).rejects.toMatchObject(
      { code: 'CANCELLED' },
    );
    await expect(
      adapter.generate({ ...request, accountRoute: 'cursor:api' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(launch).not.toHaveBeenCalled();
  });
  it('rejects concurrent generation and oversized context before dispatch', async () => {
    const { adapter, sent } = await fixture('hang');
    const controller = new AbortController();
    const job = adapter.generate({ ...request, signal: controller.signal });
    const rejection = expect(job).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'REQUEST_ACTIVE',
    });
    await expect.poll(() => sent.some((frame) => frame.method === 'session/prompt')).toBe(true);
    controller.abort();
    await rejection;
    await expect(adapter.generate({ ...request, prompt: 'x'.repeat(160_001) })).rejects.toThrow(
      '160 KB',
    );
  });
  it('preserves the primary error when process cleanup cannot be confirmed', async () => {
    const { adapter } = await fixture('malformed');
    cleanup.fail = true;
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: expect.stringContaining('could not be confirmed stopped'),
      ambiguous: true,
    });
  });
});

describe('Cursor Windows launcher resolution', () => {
  it('resolves the newest installed version to bundled node and index.js without a shell', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor shim & spaces '));
    roots.push(root);
    for (const version of ['2026.7.17-3e2a980', '2026.08.11-e8db854']) {
      const directory = path.join(root, 'versions', version);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'node.exe'), 'fixture');
      await fs.writeFile(path.join(directory, 'index.js'), 'fixture');
    }
    const entry = await resolveCursorEntry(path.join(root, 'agent.cmd'));
    expect(entry).toBe(
      path.join(await fs.realpath(root), 'versions', '2026.08.11-e8db854', 'index.js'),
    );
    expect(cursorCommand(entry, ['acp'])).toEqual({
      file: path.join(path.dirname(entry), process.platform === 'win32' ? 'node.exe' : 'node'),
      args: [entry, 'acp'],
    });
    expect(() => cursorCommand(path.join(root, 'agent.cmd'), ['acp'])).toThrow('Resolve');
  });
});
