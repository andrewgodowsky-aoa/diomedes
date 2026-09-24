/**
 * H04: the kept OpenCode session transport, against a fixture `opencode serve`
 * process (tests/fixtures/opencode-session-server.mjs) that keeps sessions in
 * its data folder the way the real tool does. No OpenCode binary or account is
 * reached; live behaviour against opencode 1.18.4 is not proven here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { OpenCodeAdapter, OPENCODE_ACCOUNT_ROUTE, OPENCODE_VERSION } from '../server/engines/opencode.js';
import {
  RESTARTED_FRESH_DETAIL,
  type OpenCodeSessionCheckpoint,
} from '../server/engines/opencode-session.js';
import type { TextRequest } from '../server/engines/contract.js';
import { contractChecks } from '../server/harness/conformance.js';
import { sessionControls } from '../shared/session-controls.js';
import { routeContractFor } from '../server/harness/route-contract.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/opencode-session-server.mjs', import.meta.url));
const roots: string[] = [];
const open: { close(): Promise<void> }[] = [];
beforeEach(() => {
  vi.stubEnv('XDG_CACHE_HOME', path.join(os.tmpdir(), 'diomedes-no-opencode-cache'));
});
afterEach(async () => {
  for (const session of open.splice(0)) await session.close().catch(() => undefined);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const request = (requestId: string, prompt = requestId): TextRequest => ({
  projectId: 'p1',
  threadId: 't1',
  requestId,
  model: 'opencode-go/go-model',
  accountRoute: OPENCODE_ACCOUNT_ROUTE,
  instructions: 'Answer plainly.',
  prompt,
  documents: [],
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes opencode session '));
  roots.push(root);
  // The person's own OpenCode data folder, where sessions outlive a server.
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  const state = { mode: 'ok', launches: 0 };
  const launch = (_command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    state.launches += 1;
    return spawn(
      process.execPath,
      [FIXTURE, args[args.indexOf('--port') + 1], state.mode],
      options,
    ) as ChildProcessWithoutNullStreams;
  };
  const adapter = new OpenCodeAdapter('opencode', root, {
    spawn: launch,
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
  });
  const saved: OpenCodeSessionCheckpoint[] = [];
  const onCheckpoint = async (checkpoint: OpenCodeSessionCheckpoint) => {
    saved.push(checkpoint);
  };
  const log = async () =>
    (await fs.readFile(path.join(root, 'requests.log'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean);
  const openSession = async (
    input: TextRequest,
    options: { restore?: OpenCodeSessionCheckpoint; fork?: boolean } = {},
  ) => {
    const session = await adapter.openSession(input, {
      observedVersion: OPENCODE_VERSION,
      onCheckpoint,
      ...options,
    });
    open.push(session);
    return session;
  };
  return { root, adapter, state, saved, log, openSession };
}

describe('kept OpenCode session transport', () => {
  it('keeps one server and one OpenCode session across turns, and saves the session id', async () => {
    const f = await fixture();
    const session = await f.openSession(request('first'));
    const deltas: string[] = [];
    const one = await session.turn({ ...request('first'), onDelta: (text) => deltas.push(text) });
    const two = await session.turn(request('second'));
    const id = session.checkpoint.nativeSessionId!;
    expect(one.text).toBe(`answer:first (turn 1 of ${id})`);
    expect(two.text).toBe(`answer:second (turn 2 of ${id})`);
    expect(deltas.join('')).toBe(one.text);
    expect(one.version).toBe(OPENCODE_VERSION);
    expect(f.state.launches).toBe(1);
    expect(session.checkpoint).toMatchObject({
      engine: 'opencode',
      state: 'idle',
      origin: 'started',
      requestedModel: 'opencode-go/go-model',
      reportedModel: 'opencode-go/go-model',
      turns: 2,
    });
    expect(session.nativeSession).toEqual({
      providerId: 'opencode',
      lineageId: session.checkpoint.lineageId,
      opaqueRef: id,
    });
    // Each turn is saved busy before it is sent, then idle with the runtime-reported model.
    expect(f.saved.map((checkpoint) => checkpoint.state)).toEqual(['busy', 'idle', 'busy', 'idle']);
    expect(f.saved.every((checkpoint) => checkpoint.nativeSessionId === id)).toBe(true);
    await session.close();
    // Closing ends the server but keeps the session for an explicit resume.
    expect((await f.log()).filter((line) => line.startsWith('DELETE'))).toEqual([]);
    expect((await f.log()).filter((line) => line === 'POST /session')).toHaveLength(1);
  });

  it('refuses a turn outside the scope it was opened with, and a second turn while one runs', async () => {
    const f = await fixture();
    f.state.mode = 'slow';
    const session = await f.openSession(request('first'));
    await expect(session.turn({ ...request('x'), model: 'opencode-go/other' })).rejects.toMatchObject({
      code: 'SESSION_MISMATCH',
    });
    const running = session.turn(request('first'));
    await vi.waitFor(async () => expect(await f.log()).toContain(`POST /session/${session.checkpoint.nativeSessionId}/prompt_async`));
    await expect(session.turn(request('second'))).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    await session.interrupt();
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('a stop aborts the turn in OpenCode, confirms idle, and leaves the session resumable', async () => {
    const f = await fixture();
    f.state.mode = 'slow';
    const session = await f.openSession(request('first'));
    const deltas: string[] = [];
    const running = session.turn({ ...request('first'), onDelta: (text) => deltas.push(text) });
    await vi.waitFor(() => expect(deltas).toEqual(['Partial ']));
    await session.interrupt();
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    const id = session.checkpoint.nativeSessionId!;
    expect(await f.log()).toEqual(expect.arrayContaining([`POST /session/${id}/abort`, 'GET /session/status']));
    expect(session.checkpoint.state).toBe('idle');
    expect(f.saved.at(-1)?.state).toBe('idle');
    // The same live session answers the next message.
    await session.close();
    f.state.mode = 'ok';
    const resumed = await f.openSession(request('after'), { restore: f.saved.at(-1) });
    expect((await resumed.turn(request('after'))).text).toBe(`answer:after (turn 2 of ${id})`);
  });

  it('a stop OpenCode does not confirm leaves the session uncertain, and it is never resumed', async () => {
    const f = await fixture();
    f.state.mode = 'stuck-abort';
    const session = await f.openSession(request('first'));
    const running = session.turn(request('first'));
    await vi.waitFor(async () => expect(await f.log()).toContain(`POST /session/${session.checkpoint.nativeSessionId}/prompt_async`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await session.interrupt();
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(session.checkpoint.state).toBe('uncertain');
    await expect(session.turn(request('second'))).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });
    await session.close();
    await expect(f.openSession(request('again'), { restore: f.saved.at(-1) })).rejects.toMatchObject({
      code: 'RECONCILE_REQUIRED',
    });
  }, 15_000);

  it('after a restart a new server resumes the saved session id from OpenCode’s own store', async () => {
    const f = await fixture();
    const first = await f.openSession(request('first'));
    await first.turn(request('first'));
    const checkpoint = first.checkpoint;
    await first.close();
    const resumed = await f.openSession(request('later'), { restore: checkpoint });
    expect(f.state.launches).toBe(2);
    expect(resumed.checkpoint).toMatchObject({
      nativeSessionId: checkpoint.nativeSessionId,
      lineageId: checkpoint.lineageId,
      origin: 'resumed',
      lostSessionId: null,
    });
    expect(resumed.continuity).toEqual({ origin: 'resumed', detail: null });
    const answer = await resumed.turn(request('later'));
    expect(answer.text).toBe(`answer:later (turn 2 of ${checkpoint.nativeSessionId})`);
    expect(await f.log()).toContain(`GET /session/${checkpoint.nativeSessionId}`);
  });

  it('a session OpenCode no longer has starts fresh, and says so', async () => {
    const f = await fixture();
    const first = await f.openSession(request('first'));
    await first.turn(request('first'));
    const checkpoint = first.checkpoint;
    await first.close();
    // The person's OpenCode lost its sessions (cleared, or another machine).
    await fs.rm(path.join(f.root, 'data', 'opencode-fixture'), { recursive: true, force: true });
    const fresh = await f.openSession(request('later'), { restore: checkpoint });
    expect(fresh.checkpoint).toMatchObject({
      origin: 'restarted-fresh',
      lostSessionId: checkpoint.nativeSessionId,
      lineageId: checkpoint.lineageId,
      turns: 0,
      reportedModel: null,
    });
    expect(fresh.checkpoint.nativeSessionId).not.toBe(checkpoint.nativeSessionId);
    expect(fresh.continuity).toEqual({ origin: 'restarted-fresh', detail: RESTARTED_FRESH_DETAIL });
    const answer = await fresh.turn(request('later'));
    expect(answer.text).toBe(`answer:later (turn 1 of ${fresh.checkpoint.nativeSessionId})`);
  });

  it('a lookup that fails for any reason other than “not found” is a failure, never a fresh start', async () => {
    const f = await fixture();
    const first = await f.openSession(request('first'));
    await first.turn(request('first'));
    const checkpoint = first.checkpoint;
    await first.close();
    const adapter = new OpenCodeAdapter('opencode', f.root, {
      spawn: (_command, args, options) =>
        spawn(process.execPath, [FIXTURE, args[args.indexOf('--port') + 1], 'ok'], options) as ChildProcessWithoutNullStreams,
      fetch: async (url, init) => {
        if (String(url).endsWith(`/session/${checkpoint.nativeSessionId}`))
          return new Response('the server failed', { status: 500 });
        return globalThis.fetch(url, init);
      },
    });
    await expect(
      adapter.openSession(request('later'), {
        observedVersion: OPENCODE_VERSION,
        restore: checkpoint,
        onCheckpoint: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect((await f.log()).filter((line) => line === 'POST /session')).toHaveLength(1);
  });

  it('refuses to resume across a version change, another scope, or with no saved session', async () => {
    const f = await fixture();
    const first = await f.openSession(request('first'));
    await first.turn(request('first'));
    const checkpoint = first.checkpoint;
    await first.close();
    await expect(
      f.openSession(request('x'), { restore: { ...checkpoint, cliVersion: '1.18.3' } }),
    ).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    await expect(
      f.openSession({ ...request('x'), instructions: 'Other instructions.' }, { restore: checkpoint }),
    ).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    await expect(
      f.openSession(request('x'), { restore: { ...checkpoint, nativeSessionId: null } }),
    ).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    await expect(f.openSession(request('x'), { fork: true })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
  });

  it('forks a saved idle session into a new OpenCode session that carries its messages', async () => {
    const f = await fixture();
    const first = await f.openSession(request('first'));
    await first.turn(request('first'));
    await first.turn(request('second'));
    const source = first.checkpoint;
    await first.close();
    const fork = await f.openSession(request('branch'), { restore: source, fork: true });
    expect(fork.checkpoint).toMatchObject({
      origin: 'forked',
      parentSessionId: source.nativeSessionId,
      lineageId: source.lineageId,
    });
    expect(fork.checkpoint.nativeSessionId).not.toBe(source.nativeSessionId);
    expect(await f.log()).toContain(`POST /session/${source.nativeSessionId}/fork`);
    const answer = await fork.turn(request('branch'));
    expect(answer.text).toBe(`answer:branch (turn 3 of ${fork.checkpoint.nativeSessionId})`);
    // The source is untouched by the branch.
    const back = await f.openSession(request('source'), { restore: source });
    expect((await back.turn(request('source'))).text).toBe(`answer:source (turn 3 of ${source.nativeSessionId})`);
  });

  it('refuses a fork, with a stated reason, where the build or the source cannot give one', async () => {
    const f = await fixture();
    const first = await f.openSession(request('first'));
    await first.turn(request('first'));
    const source = first.checkpoint;
    await first.close();
    f.state.mode = 'no-fork';
    await expect(f.openSession(request('branch'), { restore: source, fork: true })).rejects.toMatchObject({
      code: 'COMMAND_UNSUPPORTED',
      message: 'This OpenCode build did not accept a fork of that session, so no fork was started.',
    });
    f.state.mode = 'ok';
    await fs.rm(path.join(f.root, 'data', 'opencode-fixture'), { recursive: true, force: true });
    await expect(f.openSession(request('branch'), { restore: source, fork: true })).rejects.toMatchObject({
      code: 'SESSION_INVALID',
    });
  });

  it('refuses an answer from a model other than the one requested', async () => {
    const f = await fixture();
    f.state.mode = 'wrong-model';
    const session = await f.openSession(request('first'));
    await expect(session.turn(request('first'))).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });

  it('refuses a whole-project read scope before any server starts', async () => {
    const f = await fixture();
    await expect(
      f.openSession({
        ...request('first'),
        readScope: { root: f.root, web: false, access: 'project', mcp: [] } as never,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
    expect(f.state.launches).toBe(0);
  });
});

describe('the kept session route contract', () => {
  it('passes descriptor conformance and exposes only the controls it answers', () => {
    const adapter = new OpenCodeAdapter('opencode', os.tmpdir());
    expect(contractChecks(adapter.sessionContract).filter((check) => check.outcome === 'failed')).toEqual([]);
    expect(sessionControls(adapter.sessionContract)).toEqual({
      routeId: 'opencode-session',
      engine: { id: 'opencode', version: OPENCODE_VERSION },
      followUp: true,
      steer: 'queued',
      stop: true,
      resume: true,
      fork: true,
      close: true,
    });
    // The single-turn route offers none of the session controls it does not have.
    expect(sessionControls(adapter.contract)).toMatchObject({
      followUp: false,
      steer: null,
      resume: false,
      fork: false,
    });
    // H03: Claude's session steers through the same host queue, and never claims a live channel.
    expect(sessionControls(routeContractFor('claude-code-session')).steer).toBe('queued');
  });
});
