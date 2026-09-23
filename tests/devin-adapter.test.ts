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
  DevinAdapter,
  DEVIN_ACCOUNT_ROUTE,
  DEVIN_VERSION,
  devinCommand,
  resolveDevinEntry,
  type DevinAdapterDeps,
} from '../server/engines/devin.js';
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
  accountRoute: DEVIN_ACCOUNT_ROUTE,
  model: 'swe-2-high',
  prompt: 'Question',
  documents: [{ path: 'Note.md', text: 'untrusted input' }],
  instructions: 'Answer plainly.',
};
const initialized = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    mcpCapabilities: { http: false, sse: false },
    sessionCapabilities: { list: {}, delete: {}, additionalDirectories: {} },
  },
  authMethods: [{ id: 'devin-browser', name: 'Log in with browser' }],
  agentInfo: { name: 'affogato', title: 'Devin Agent', version: '0.0.0-dev' },
};
const sessionOptions = (model: string, current = model) => ({
  sessionId: 'session',
  modes: {
    currentModeId: 'accept-edits',
    availableModes: [
      { id: 'accept-edits', name: 'Code' },
      { id: 'smart', name: 'Smart' },
      { id: 'ask', name: 'Ask' },
      { id: 'plan', name: 'Plan' },
      { id: 'bypass', name: 'Bypass Permissions' },
    ],
  },
  configOptions: [
    {
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: current,
      options: [
        { value: 'swe-2-max', name: 'SWE-2 Max' },
        { value: model, name: 'Fixture' },
      ],
    },
  ],
});

async function fixture(mode = 'ok', deps: DevinAdapterDeps = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes devin '));
  roots.push(root);
  const sent: Json[] = [],
    order: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    // A live pid lets the adapter's post-kill liveness check see a process
    // that a failed kill genuinely left running.
    pid: process.pid,
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
  const capture = vi.fn<NonNullable<DevinAdapterDeps['capture']>>(async (options) => {
    if (options.signal?.aborted) throw Object.assign(new Error('Stopped'), { code: 'CANCELLED' });
    if (options.args.includes('--version'))
      return {
        stdout:
          mode === 'version'
            ? 'devin (unknown build)'
            : mode === 'newer'
              ? 'devin 3000.10.24 (abcd1234)'
              : 'devin 3000.10.23 (deb81600)',
        code: 0,
      };
    return { code: 0, stdout: '' };
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
        case 'authenticate':
          if (mode === 'auth-hang') break;
          if (mode === 'auth-fails' || mode === 'signed-out') {
            emit({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32603, message: 'Authentication failed' },
            });
            break;
          }
          reply(frame.id, {});
          break;
        case 'session/new':
          if (mode === 'no-ask-mode')
            reply(frame.id, {
              sessionId: 'session',
              modes: { currentModeId: 'accept-edits', availableModes: [{ id: 'accept-edits' }] },
              configOptions: [],
            });
          else if (mode === 'missing-model')
            reply(frame.id, sessionOptions('swe-2-max', 'swe-2-max'));
          else if (mode === 'model-drift')
            reply(frame.id, sessionOptions(request.model, 'swe-2-medium'));
          else reply(frame.id, sessionOptions(request.model));
          break;
        case 'session/set_mode':
          if (mode === 'silent-mode') {
            // The startup echo without an ask confirmation.
            update({
              sessionUpdate: 'current_mode_update',
              currentModeId: 'accept-edits',
            });
            reply(frame.id, {});
            break;
          }
          if (mode === 'stale-mode')
            update({
              sessionUpdate: 'current_mode_update',
              currentModeId: 'accept-edits',
            });
          update({
            sessionUpdate: 'current_mode_update',
            currentModeId: mode === 'wrong-mode' ? 'smart' : 'ask',
          });
          reply(frame.id, {});
          break;
        case 'session/prompt':
          if (mode === 'hang') break;
          if (mode === 'late-mode') {
            update({
              sessionUpdate: 'current_mode_update',
              currentModeId: 'accept-edits',
            });
            break;
          }
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
          if (['permission', 'no-reject-option', 'filesystem', 'unknown-request'].includes(mode)) {
            emit({
              jsonrpc: '2.0',
              id: 0,
              method:
                mode === 'filesystem'
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
          if (mode === 'extension') {
            emit({
              jsonrpc: '2.0',
              method: '_cognition.ai/session_renamed',
              params: { sessionId: 'session', title: 'Renamed' },
            });
          }
          if (mode === 'unknown-notification') {
            emit({
              jsonrpc: '2.0',
              method: 'some/future_event',
              params: {},
            });
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
          if (mode === 'proxy-ca') {
            emit({
              jsonrpc: '2.0',
              id: frame.id,
              error: {
                code: -32603,
                message: 'unable to verify the certificate authority for the configured proxy',
              },
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
                    content: { type: 'text', text: 'é' },
                  },
                },
              }) + '\n',
            );
            const index = data.indexOf(Buffer.from('é')) + 1;
            child.stdout.write(data.subarray(0, index));
            child.stdout.write(data.subarray(index));
          } else {
            if (mode === 'reported-model')
              update({
                sessionUpdate: 'config_option_update',
                configOptions: [
                  { id: 'model', category: 'model', currentValue: 'swe-2-low' },
                ],
              });
            update({
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: mode === 'reported-model' ? 'I am a different model' : 'READY',
              },
            });
          }
          reply(frame.id, {
            stopReason: mode === 'incomplete' ? 'max_tokens' : 'end_turn',
          });
          break;
        case 'session/cancel':
          break; // ACP cancellation is a notification, not a request.
      }
    });
  });
  const launch = vi.fn<NonNullable<DevinAdapterDeps['spawn']>>(
    () => child as unknown as ChildProcessWithoutNullStreams,
  );
  const adapter = new DevinAdapter('devin.exe', root, {
    spawn: launch,
    capture,
    startupTimeoutMs: 500,
    authTimeoutMs: 500,
    requestTimeoutMs: 500,
    ...deps,
  });
  return { root, adapter, sent, order, child, launch, capture };
}

describe('Devin ACP text route', () => {
  it('authenticates its own ACP process, opens an ask session and reports the explicit model catalogue without prompting', async () => {
    const { adapter, sent, order, launch } = await fixture();
    await expect(adapter.inspect()).resolves.toMatchObject({
      authentication: 'signed-in',
      accountRoute: DEVIN_ACCOUNT_ROUTE,
      models: [{ slug: 'swe-2-max' }, { slug: 'swe-2-high' }],
    });
    expect(launch.mock.calls[0][1]).toEqual(['acp']);
    expect(order).toEqual(['initialize', 'authenticate', 'session/new', 'session/set_mode', 'kill']);
    expect(sent.find((frame) => frame.method === 'authenticate')!.params).toEqual({
      methodId: 'devin-browser',
    });
    expect(sent.some((frame) => frame.method === 'session/prompt')).toBe(false);
  });
  it('returns signed-out when the ACP browser sign-in fails', async () => {
    const { adapter, sent } = await fixture('signed-out');
    await expect(adapter.inspect()).resolves.toEqual({
      authentication: 'signed-out',
      accountRoute: null,
      models: [],
      detail: 'Sign in through the Devin browser flow, then recheck.',
    });
    expect(
      sent.some((frame) => ['session/new', 'session/prompt'].includes(String(frame.method))),
    ).toBe(false);
  });
  it('names a host deadline a timeout rather than the person stopping the request', async () => {
    const { adapter } = await fixture('hang');
    const failure = await adapter
      .generate({ ...request, signal: AbortSignal.timeout(300) })
      .then(
        () => undefined,
        (error: { code: string; message: string }) => error,
      );
    expect(failure?.code).toBe('TIMEOUT');
    expect(failure?.message).not.toMatch(/was stopped/i);
  });
  it('does not read a certificate authority failure as a missing sign-in', async () => {
    const { adapter } = await fixture('proxy-ca');
    const failure = await adapter.generate(request).then(
      () => undefined,
      (error: { code: string; message: string }) => error,
    );
    expect(failure?.code).toBe('PROVIDER_ERROR');
    expect(failure?.message).not.toMatch(/sign.?in|login/i);
  });
  it('sends bounded context through stdin, pins the requested model, disables client capabilities and writes workspace deny rules', async () => {
    vi.stubEnv('DEVIN_API_KEY', 'must-not-pass');
    vi.stubEnv('WINDSURF_API_KEY', 'must-not-pass');
    const { adapter: waiting, launch: waitingLaunch, sent: waitingSent } = await fixture('hang');
    const controller = new AbortController();
    const job = waiting.generate({ ...request, signal: controller.signal });
    const rejected = expect(job).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect
      .poll(() => waitingSent.some((frame) => frame.method === 'session/prompt'))
      .toBe(true);
    const [file, args, options] = waitingLaunch.mock.calls[0];
    expect(file).toBe('devin.exe');
    expect(args).toEqual(['acp', '--model', 'swe-2-high']);
    expect(options?.shell).toBe(false);
    expect(options?.env?.DEVIN_API_KEY).toBeUndefined();
    expect(options?.env?.WINDSURF_API_KEY).toBeUndefined();
    const config = JSON.parse(
      await fs.readFile(path.join(String(options!.cwd), '.devin', 'config.json'), 'utf8'),
    );
    expect(config).toEqual({
      permissions: {
        allow: [],
        deny: [
          'Read(**)',
          'Write(**)',
          'Fetch(http://*)',
          'Fetch(https://*)',
          'read',
          'edit',
          'grep',
          'glob',
          'exec',
          'mcp__*',
        ],
      },
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
    const { adapter, order } = await fixture();
    const deltas: string[] = [];
    await expect(
      adapter.generate({ ...request, onDelta: (value) => deltas.push(value) }),
    ).resolves.toEqual({
      text: 'READY',
      model: 'swe-2-high',
      version: DEVIN_VERSION,
      projectId: 'project',
      threadId: 'thread',
      requestId: 'request',
    });
    expect(deltas).toEqual(['READY']);
    expect(order.slice(0, 5)).toEqual([
      'initialize',
      'authenticate',
      'session/new',
      'session/set_mode',
      'session/prompt',
    ]);
  });
  it('attributes the runtime model even when answer text claims another identity', async () => {
    const { adapter } = await fixture('reported-model');
    await expect(adapter.generate(request)).resolves.toMatchObject({
      model: 'swe-2-low',
      text: 'I am a different model',
    });
  });
  it('uses the requested model only when no turn selection is reported', async () => {
    const { adapter } = await fixture();
    await expect(adapter.generate(request)).resolves.toMatchObject({
      model: 'swe-2-high',
      version: DEVIN_VERSION,
    });
  });
  it('stops before prompting when the launch pin resolves to a different model', async () => {
    const { adapter, sent } = await fixture('model-drift');
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'POLICY_MISMATCH',
      message: expect.stringContaining('different model'),
    });
    expect(sent.some((frame) => frame.method === 'session/prompt')).toBe(false);
  });
  it('stops before prompting when Devin drops the requested model', async () => {
    const { adapter, sent } = await fixture('missing-model');
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      message: expect.stringContaining('No substitute'),
    });
    expect(sent.some((frame) => frame.method === 'session/prompt')).toBe(false);
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
  it('tolerates the session startup mode echo while ask is being confirmed', async () => {
    const { adapter } = await fixture('stale-mode');
    await expect(adapter.generate(request)).resolves.toMatchObject({ text: 'READY' });
  });
  it('rejects a return to the startup mode once ask is confirmed', async () => {
    const { adapter } = await fixture('late-mode');
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'POLICY_MISMATCH',
      message: expect.stringContaining('accept-edits'),
    });
  });
  it('stops before prompting when ask is never confirmed', async () => {
    const { adapter, sent } = await fixture('silent-mode', {
      startupTimeoutMs: 30_000,
      authTimeoutMs: 30_000,
    });
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'POLICY_MISMATCH',
      message: expect.stringContaining('did not confirm'),
    });
    expect(sent.some((frame) => frame.method === 'session/prompt')).toBe(false);
  });
  it('ignores Devin extension notifications and still completes the turn', async () => {
    const { adapter } = await fixture('extension');
    await expect(adapter.generate(request)).resolves.toMatchObject({ text: 'READY' });
  });
  it('rejects an unknown out-of-band notification', async () => {
    const { adapter } = await fixture('unknown-notification');
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'UNEXPECTED_TOOL',
    });
  });
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
      message: 'Devin could not start. Recheck its installation.',
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
    ['no-ask-mode', 'POLICY_MISMATCH'],
    ['exit', 'PROTOCOL_ERROR'],
    ['version', 'VERSION_UNKNOWN'],
    ['quota', 'USAGE_LIMIT'],
    ['auth-fails', 'AUTH_REQUIRED'],
  ])('fails %s without accepting output', async (mode, code) => {
    const { adapter } = await fixture(mode);
    await expect(adapter.generate(request)).rejects.toMatchObject({ code });
  });
  it('accepts whatever version Devin reports', async () => {
    const { adapter } = await fixture('newer');
    await expect(adapter.generate(request)).resolves.toMatchObject({ text: 'READY' });
  });
  it.each(['startup-hang', 'hang', 'auth-hang'])(
    'bounds %s independently of cancellation',
    async (mode) => {
      const { adapter } = await fixture(mode, {
        startupTimeoutMs: 100,
        authTimeoutMs: 100,
        requestTimeoutMs: 20,
      });
      await expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'TIMEOUT',
      });
    },
  );
  it('decodes UTF-8 split across chunks', async () => {
    const { adapter } = await fixture('utf8');
    await expect(adapter.generate(request)).resolves.toMatchObject({
      text: 'é',
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
      adapter.generate({ ...request, accountRoute: 'devin:api' }),
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

describe('Devin failure stages', () => {
  it.each([
    ['version', 'VERSION_UNKNOWN', 'runtime-verification'],
    ['protocol-version', 'PROTOCOL_ERROR', 'local-handshake'],
    ['auth-fails', 'AUTH_REQUIRED', 'provider-auth'],
    ['no-ask-mode', 'POLICY_MISMATCH', 'local-handshake'],
    ['wrong-mode', 'POLICY_MISMATCH', 'local-handshake'],
    ['model-drift', 'POLICY_MISMATCH', 'model-list'],
    ['missing-model', 'MODEL_UNAVAILABLE', 'model-list'],
    ['quota', 'USAGE_LIMIT', 'dispatch'],
    ['malformed', 'PROTOCOL_ERROR', 'dispatch'],
    ['exit', 'PROTOCOL_ERROR', 'dispatch'],
    ['permission', 'UNEXPECTED_TOOL', 'dispatch'],
    ['unknown-notification', 'UNEXPECTED_TOOL', 'dispatch'],
    ['late-mode', 'POLICY_MISMATCH', 'dispatch'],
    ['tool', 'UNEXPECTED_TOOL', 'stream'],
    ['plan', 'UNEXPECTED_TOOL', 'stream'],
    ['wrong-session', 'PROTOCOL_ERROR', 'stream'],
    ['incomplete', 'PROTOCOL_ERROR', 'stream'],
  ])('reports %s as %s at the %s stage', async (mode, code, stage) => {
    const { adapter } = await fixture(mode);
    await expect(adapter.generate(request)).rejects.toMatchObject({ code, stage });
  });
  it.each([
    ['startup-hang', 'launch'],
    ['auth-hang', 'provider-auth'],
    ['hang', 'dispatch'],
  ])('bounds %s at the %s stage', async (mode, stage) => {
    const { adapter } = await fixture(mode, {
      startupTimeoutMs: 100,
      authTimeoutMs: 100,
      requestTimeoutMs: 20,
    });
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'TIMEOUT', stage });
  });
  it('stops before prompting when ask is never confirmed, at the handshake', async () => {
    const { adapter } = await fixture('silent-mode', {
      startupTimeoutMs: 30_000,
      authTimeoutMs: 30_000,
    });
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'POLICY_MISMATCH',
      stage: 'local-handshake',
    });
  });
  it('does not present a tool that cannot start as a sign-in problem', async () => {
    const { adapter } = await fixture('ok', {
      spawn: () => {
        throw new Error('native secret diagnostic');
      },
    });
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'LAUNCH_FAILED',
      stage: 'launch',
    });
  });
  it('names the stage of every refusal it makes before launching', async () => {
    const { adapter } = await fixture();
    await expect(
      adapter.generate({ ...request, accountRoute: 'devin:api' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED', stage: 'provider-auth' });
    await expect(adapter.generate({ ...request, model: 'auto' })).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      stage: 'model-list',
    });
    await expect(resolveDevinEntry(path.join(os.tmpdir(), 'other.cmd'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_SHIM',
      stage: 'discovery',
    });
  });
  it('separates a cleanup that could not be confirmed from the failure it followed', async () => {
    const { adapter } = await fixture('malformed');
    cleanup.fail = true;
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      stage: 'dispatch',
    });
    cleanup.fail = false;
    const { adapter: clean } = await fixture();
    cleanup.fail = true;
    await expect(clean.generate(request)).rejects.toMatchObject({
      code: 'CLEANUP_FAILED',
      stage: 'cleanup',
    });
  });
  it('cancels mid-turn at the stream it had reached', async () => {
    const { adapter } = await fixture('abort');
    const controller = new AbortController();
    await expect(
      adapter.generate({ ...request, signal: controller.signal, onDelta: () => controller.abort() }),
    ).rejects.toMatchObject({ code: 'CANCELLED', stage: 'stream', ambiguous: true });
  });
});

describe('Devin Windows launcher resolution', () => {
  it('passes a native executable through and rejects wrappers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devin shim & spaces '));
    roots.push(root);
    expect(await resolveDevinEntry(path.join(root, 'devin.exe'))).toBe(
      path.join(root, 'devin.exe'),
    );
    expect(devinCommand(path.join(root, 'devin.exe'), ['acp'])).toEqual({
      file: path.join(root, 'devin.exe'),
      args: ['acp'],
    });
    expect(() => devinCommand(path.join(root, 'devin.cmd'), ['acp'])).toThrow('installed Devin');
    await expect(resolveDevinEntry(path.join(root, 'other.cmd'))).rejects.toThrow(
      'installed Devin',
    );
  });
  it('prefers the sibling executable over a devin shim', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devin shim '));
    roots.push(root);
    await fs.writeFile(path.join(root, 'devin.cmd'), 'fixture');
    await fs.writeFile(path.join(root, 'devin.exe'), 'fixture');
    expect(await resolveDevinEntry(path.join(root, 'devin.cmd'))).toBe(
      path.join(root, 'devin.exe'),
    );
    await fs.rm(path.join(root, 'devin.exe'));
    await expect(resolveDevinEntry(path.join(root, 'devin.cmd'))).rejects.toThrow(
      'installed Devin',
    );
  });
});
