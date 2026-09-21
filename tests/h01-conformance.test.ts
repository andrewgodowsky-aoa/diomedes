/**
 * H01.I — the adapter conformance surface.
 *
 * Two layers, both reusable by later work orders:
 *
 *   contractChecks / streamChecks — the descriptor and durable-stream
 *   invariants every route must answer, run here over the whole registry and
 *   a real run.
 *
 *   AcpClient probes — the transport acceptance cases (bounded frames,
 *   incremental UTF-8, stderr separation, correlated requests, declined
 *   server calls, owned-process cleanup) run once against the shared client
 *   per engine profile. A second ACP agent is a profile, not a copy of this
 *   machinery, so probing the shared client covers both real ACP routes.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  AcpClient,
  CURSOR_ACP_PROFILE,
  DEVIN_ACP_PROFILE,
  type AcpProfile,
} from '../server/engines/acp-client.js';
import {
  contractChecks,
  streamChecks,
  type ConformanceCheck,
} from '../server/harness/conformance.js';
import { ROUTE_CONTRACTS } from '../server/harness/route-contract.js';
import { ADAPTER_COMMANDS } from '../shared/adapter-contract.js';
import { EXTERNAL_ENGINES } from '../shared/engines.js';
import { EngineError } from '../server/engines/process.js';

type Json = Record<string, unknown>;

// --- descriptor conformance, over every real route --------------------------------

describe('route descriptors', () => {
  it('every route in the registry passes contract conformance', () => {
    for (const [routeId, contract] of Object.entries(ROUTE_CONTRACTS)) {
      const checks = contractChecks(contract);
      const failed = checks.filter((c) => c.outcome === 'failed');
      expect(failed, `${routeId}: ${failed.map((c) => c.id).join(', ')}`).toEqual([]);
    }
  });

  it('all five real adapter families carry descriptors', () => {
    for (const engine of EXTERNAL_ENGINES) {
      const contract = ROUTE_CONTRACTS[engine];
      expect(contract, engine).toBeDefined();
      expect(contract.engine.version.length).toBeGreaterThan(0);
      expect(contract.testedWith).not.toBeNull();
    }
  });

  it('every route starts and closes; only Harness and the integrated Claude session route fork', () => {
    for (const [routeId, contract] of Object.entries(ROUTE_CONTRACTS)) {
      expect(contract.commands.start.support, routeId).toBe('native');
      expect(['native', 'host'], `${routeId} close`).toContain(contract.commands.close.support);
      if (contract.mode === 'harness-agent' || routeId === 'claude-code-session')
        expect(contract.commands.fork.support, routeId).toBe('native');
      else expect(contract.commands.fork.support, routeId).toBe('unsupported');
    }
  });

  it('the explicit native profile retains every lifecycle and evidence boundary', () => {
    const contract = ROUTE_CONTRACTS['claude-code-session'];
    expect(contract).toMatchObject({
      mode: 'external-session',
      engine: { id: 'claude-code', version: '2.1.252', protocolVersion: 'stream-json' },
      streaming: { transientPreview: 'text-delta', durableEvents: 'run-record' },
      commands: { fork: { support: 'native' }, steer: { support: 'unsupported' }, reconcile: { support: 'unsupported' } },
    });
    expect(contractChecks(contract).find(check => check.id === 'native-session-run-backing')?.outcome).toBe('passed');
  });

  it.each(['route', 'engine', 'version', 'protocol', 'mode', 'steer', 'resume', 'stream', 'auth', 'model'] as const)(
    'does not extend native session backing across %s drift', drift => {
      const contract = structuredClone(ROUTE_CONTRACTS['claude-code-session']);
      if (drift === 'route') contract.routeId = 'unproven-native-session';
      if (drift === 'engine') contract.engine.id = 'other-engine';
      if (drift === 'version') contract.engine.version = contract.testedWith = '2.1.253';
      if (drift === 'protocol') contract.engine.protocolVersion = 'unknown';
      if (drift === 'mode') contract.mode = 'single-turn-text';
      if (drift === 'steer') contract.commands.steer.support = 'native';
      if (drift === 'resume') contract.commands.resume.support = 'host';
      if (drift === 'stream') contract.streaming.durableEvents = 'host-record';
      if (drift === 'auth') contract.authentication = 'host-credential';
      if (drift === 'model') contract.models.source = 'fixed';
      const failed = contractChecks(contract).filter(check => check.outcome === 'failed');
      expect(failed.map(check => check.id)).toContain(drift === 'route' ? 'streaming-matches-mode' : 'native-session-run-backing');
    },
  );
});

// --- the fake ACP child -----------------------------------------------------------

function fakeChild(options: { stdinNeverDrains?: boolean } = {}) {
  const stdin = options.stdinNeverDrains
    ? new Writable({ write(_chunk, _enc, _cb) {/* never drains */} })
    : new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(() => {
      mutable.exitCode = 0;
      child.emit('close', 0);
      return true;
    }),
  }) as unknown as ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> };
  const mutable = child as { exitCode: number | null };
  const emit = (value: unknown) =>
    stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
  return { child, emit, stdout, stderr, mutable };
}

function clientFor(
  profile: AcpProfile,
  child: ChildProcessWithoutNullStreams,
  onUpdate: (params: Json) => void = () => {},
  profileOverrides: Partial<AcpProfile> = {},
) {
  return new AcpClient({
    profile: { ...profile, ...profileOverrides },
    command: { file: 'fake-agent', args: ['acp'] },
    cwd: process.cwd(),
    env: {},
    launch: () => child,
    startupTimeoutMs: 5000,
    signal: undefined,
    onUpdate,
    kill: async (c) => {
      c.kill();
    },
  });
}

const PROFILES = { cursor: CURSOR_ACP_PROFILE, devin: DEVIN_ACP_PROFILE } as const;

// --- transport conformance, per engine profile -------------------------------------

for (const [engine, profile] of Object.entries(PROFILES)) {
  describe(`ACP transport conformance — ${engine} profile`, () => {
    it('correlates requests by id and resolves out-of-order replies', async () => {
      const { child, emit } = fakeChild();
      const rpc = clientFor(profile, child);
      const first = rpc.request('initialize', { protocolVersion: 1 });
      const second = rpc.request('session/new', {});
      emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's2' } });
      emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
      await expect(second).resolves.toEqual({ sessionId: 's2' });
      await expect(first).resolves.toEqual({ protocolVersion: 1 });
      await rpc.close();
    });

    it('rejects a response that matches no pending request', async () => {
      const { child, emit } = fakeChild();
      const rpc = clientFor(profile, child);
      emit({ jsonrpc: '2.0', id: 99, result: {} });
      await expect(rpc.request('initialize', {})).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
      });
      // A recorded failure is surfaced by close rather than swallowed.
      await expect(rpc.close()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
      expect(child.kill).toHaveBeenCalled();
    });

    it('fails on a line bigger than the JSON bound', async () => {
      const { child, stdout } = fakeChild();
      const rpc = clientFor(profile, child);
      const pending = rpc.request('initialize', {});
      stdout.write('x'.repeat(profile.maxJsonBytes + 1) + '\n');
      await expect(pending).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
      await expect(rpc.close()).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
      expect(child.kill).toHaveBeenCalled();
    });

    it('fails a truncated JSON frame when the process exits', async () => {
      const { child, stdout, mutable } = fakeChild();
      const rpc = clientFor(profile, child);
      const pending = rpc.request('initialize', {});
      stdout.write('{"jsonrpc":"2.0","id":1,"result":{"protocol');
      mutable.exitCode = 1;
      child.emit('close', 1);
      await expect(pending).rejects.toBeInstanceOf(EngineError);
      await expect(rpc.close()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    });

    it('decodes a multi-byte character split across chunks', async () => {
      const { child, stdout } = fakeChild();
      const updates: Json[] = [];
      const rpc = clientFor(profile, child, (params) => updates.push(params));
      // '€' is three bytes in UTF-8; split it across two writes.
      const line = `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'note', text: 'a€b' } },
      })}\n`;
      const bytes = Buffer.from(line, 'utf8');
      const cut = bytes.indexOf(0xe2); // first byte of €
      stdout.write(bytes.subarray(0, cut + 1));
      stdout.write(bytes.subarray(cut + 1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(updates[0]?.update).toMatchObject({ text: 'a€b' });
      await rpc.close();
    });

    it('fails on a stderr flood without retaining diagnostics', async () => {
      const { child, stderr } = fakeChild();
      const rpc = clientFor(profile, child);
      const pending = rpc.request('initialize', {});
      stderr.write('x'.repeat(profile.maxJsonBytes + 1));
      await expect(pending).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
      await expect(rpc.close()).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
      expect(child.kill).toHaveBeenCalled();
    });

    it('a slow client hits the reply bound rather than hanging', async () => {
      const { child, mutable } = fakeChild({ stdinNeverDrains: true });
      const rpc = clientFor(profile, child, () => {}, { replyTimeoutMs: 50 });
      await expect(rpc.request('initialize', {})).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
      });
      mutable.exitCode = 0;
      child.emit('close', 0);
      await rpc.close(new EngineError('STOPPED', 'stopped'));
    });

    it('process exit mid-request fails the request, not silently', async () => {
      const { child, mutable } = fakeChild();
      const rpc = clientFor(profile, child);
      const pending = rpc.request('session/prompt', {});
      mutable.exitCode = 1;
      child.emit('close', 1);
      await expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
      await expect(rpc.close()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    });

    it('declines a server-to-client request and fails the turn', async () => {
      const { child, emit } = fakeChild();
      const rpc = clientFor(profile, child);
      const pending = rpc.request('session/prompt', {});
      emit({
        jsonrpc: '2.0',
        id: 900,
        method: 'session/request_permission',
        params: { options: [{ kind: 'reject_once', optionId: 'no' }] },
      });
      await expect(pending).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
      await expect(rpc.close()).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
      expect(child.kill).toHaveBeenCalled();
    });

    it('close terminates the owned process', async () => {
      const { child } = fakeChild();
      const rpc = clientFor(profile, child);
      await rpc.close();
      expect(child.kill).toHaveBeenCalled();
    });
  });
}

// --- engine-profile differences the shared client must keep configurable -----------

describe('profile differences stay configuration', () => {
  it('Devin ignores its extension namespaces; Cursor refuses them', async () => {
    const devin = fakeChild();
    const devinRpc = clientFor(DEVIN_ACP_PROFILE, devin.child);
    const devinPending = devinRpc.request('session/prompt', {});
    devin.emit({
      jsonrpc: '2.0',
      method: '_cognition.ai/progress',
      params: { note: 'extension channel' },
    });
    devin.emit({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
    await expect(devinPending).resolves.toMatchObject({ stopReason: 'end_turn' });
    await devinRpc.close();

    const cursor = fakeChild();
    const cursorRpc = clientFor(CURSOR_ACP_PROFILE, cursor.child);
    const cursorPending = cursorRpc.request('session/prompt', {});
    cursor.emit({ jsonrpc: '2.0', method: 'cursor/extension', params: {} });
    await expect(cursorPending).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
    await expect(cursorRpc.close()).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
  });
});
