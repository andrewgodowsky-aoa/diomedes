/**
 * H05: the kept ACP conversation, once for every ACP route, against a real
 * fixture agent process speaking ACP over stdio (tests/fixtures/acp-agent.mjs).
 * Session load and its absence, a session the agent lost, Stop acknowledged and
 * Stop that needs the process ended, and permission asks and plans answered by
 * a person. Live Cursor and Devin are not reached.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CursorAdapter, CURSOR_ACCOUNT_ROUTE } from '../server/engines/cursor.js';
import { DevinAdapter, DEVIN_ACCOUNT_ROUTE } from '../server/engines/devin.js';
import {
  ACP_CANCEL_WAIT_MS,
  recoverAcpCheckpoint,
  type AcpSessionCheckpoint,
} from '../server/engines/acp-session.js';
import type { EngineAsk, EngineAskAnswer, TextRequest } from '../server/engines/contract.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

type Engine = 'cursor' | 'devin';
const VERSIONS = { cursor: '2026.08.11', devin: '3000.10.23' } as const;

async function fixture(engine: Engine = 'cursor') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `diomedes acp ${engine} `));
  roots.push(root);
  const env: Record<string, string> = { ACP_FIXTURE_LOG: path.join(root, 'methods.log') };
  const launch = (_file: string, _args: string[], options: Parameters<typeof spawn>[2]) =>
    spawn(process.execPath, [FIXTURE], {
      ...options,
      env: { ...options.env, ...env },
    }) as ChildProcessWithoutNullStreams;
  const capture = async (options: { args: string[] }) =>
    options.args.includes('--version')
      ? { code: 0, stdout: engine === 'cursor' ? '2026.08.11-e8db854' : 'devin 3000.10.23' }
      : { code: 0, stdout: JSON.stringify({ status: 'authenticated', isAuthenticated: true }) };
  const deps = {
    spawn: launch,
    capture: capture as never,
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
  };
  const adapter =
    engine === 'cursor'
      ? new CursorAdapter(path.join(root, 'agent'), root, deps)
      : new DevinAdapter(path.join(root, 'devin.exe'), root, deps);
  const saved: AcpSessionCheckpoint[] = [];
  const open = (restore?: AcpSessionCheckpoint) =>
    adapter.openSession(input(engine, 'open'), {
      observedVersion: VERSIONS[engine],
      restore,
      onCheckpoint: async (checkpoint) => {
        saved.push(checkpoint);
      },
    });
  const methods = async () =>
    (await fs.readFile(env.ACP_FIXTURE_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { root, env, adapter, open, saved, methods };
}

const input = (engine: Engine, requestId: string, prompt = requestId): TextRequest => ({
  projectId: 'p1',
  threadId: 't1',
  requestId,
  model: 'fixture-model',
  accountRoute: engine === 'cursor' ? CURSOR_ACCOUNT_ROUTE : DEVIN_ACCOUNT_ROUTE,
  instructions: 'Answer plainly.',
  prompt,
  documents: [],
});

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected the turn to fail');
    },
    (error: unknown) => error as { code?: string; message?: string; stopOutcome?: string },
  );

describe.each(['cursor', 'devin'] as const)('kept ACP conversation — %s', (engine) => {
  it('saves the ACP session id before the prompt and continues it with session/load', async () => {
    const f = await fixture(engine);
    const session = await f.open();
    const first = await session.turn(input(engine, 'r1', 'first'));
    expect(first.text).toBe('answer after 0 earlier turns');
    const id = session.checkpoint.nativeSessionId!;
    expect(id).toMatch(/^s-/);
    // busy with the session id before the prompt, idle after the answer.
    expect(f.saved.map((checkpoint) => [checkpoint.state, checkpoint.nativeSessionId])).toEqual([
      ['busy', id],
      ['idle', id],
    ]);
    expect(session.checkpoint).toMatchObject({ origin: 'started', loadSession: true, turns: 1 });
    const second = await session.turn(input(engine, 'r2', 'second'));
    expect(second.text).toBe('answer after 1 earlier turns');
    expect(session.checkpoint).toMatchObject({ nativeSessionId: id, origin: 'loaded', turns: 2 });
    expect(session.continuity).toEqual({ origin: 'loaded', detail: null });
    const methods = await f.methods();
    expect(methods.filter((method) => method === 'session/new')).toHaveLength(1);
    expect(methods.filter((method) => method === 'session/load')).toHaveLength(1);
    expect(session.nativeSession).toEqual({
      providerId: engine,
      lineageId: session.checkpoint.lineageId,
      opaqueRef: id,
    });
  });

  it('starts fresh and says so when the agent does not advertise loadSession', async () => {
    const f = await fixture(engine);
    f.env.ACP_FIXTURE_LOAD = '0';
    const session = await f.open();
    await session.turn(input(engine, 'r1', 'first'));
    const second = await session.turn(input(engine, 'r2', 'second'));
    expect(second.text).toBe('answer after 0 earlier turns');
    expect(session.checkpoint).toMatchObject({ origin: 'load-unsupported', loadSession: false });
    expect(session.continuity.detail).toMatch(
      /does not offer to continue a saved session, so this message started a fresh .* not carried/,
    );
    expect(await f.methods()).not.toContain('session/load');
  });

  it('continues after a restart from the saved checkpoint alone, and starts fresh if the agent lost it', async () => {
    const f = await fixture(engine);
    const first = await f.open();
    await first.turn(input(engine, 'r1', 'first'));
    // A new process of Diomedes: only the durable checkpoint is carried over.
    const restored = await f.open(first.checkpoint);
    const answer = await restored.turn(input(engine, 'r2', 'second'));
    expect(answer.text).toBe('answer after 1 earlier turns');
    expect(restored.checkpoint.origin).toBe('loaded');
    // The agent's own store is gone: its "not found" starts fresh, and the record says so.
    const lostId = restored.checkpoint.nativeSessionId;
    await fs.rm(path.join(f.root, `.diomedes-${engine}-sessions`), { recursive: true, force: true });
    const again = await f.open(restored.checkpoint);
    const fresh = await again.turn(input(engine, 'r3', 'third'));
    expect(fresh.text).toBe('answer after 0 earlier turns');
    expect(again.checkpoint).toMatchObject({ origin: 'restarted-fresh', lostSessionId: lostId });
    expect(again.checkpoint.nativeSessionId).not.toBe(lostId);
    expect(again.continuity.detail).toMatch(/no longer had the saved session/);
  });

  it('Stop sends session/cancel and records that the agent acknowledged it', async () => {
    const f = await fixture(engine);
    const session = await f.open();
    const running = session.turn(input(engine, 'r1', 'hang please'));
    await expect.poll(async () => (await f.methods()).includes('session/prompt')).toBe(true);
    await session.interrupt();
    const error = await failure(running);
    expect(error.code).toBe('CANCELLED');
    expect(error.stopOutcome).toBe('acknowledged');
    expect(session.checkpoint).toMatchObject({ state: 'idle', lastStop: 'acknowledged' });
    expect(await f.methods()).toContain('session/cancel');
    // The stopped turn is never resent; the conversation continues from the agent's record.
    const next = await session.turn(input(engine, 'r2', 'after stop'));
    expect(next.text).toBe('answer after 0 earlier turns');
    expect(session.checkpoint.lastStop).toBeNull();
  });

  it('Stop ends the process tree after the bounded wait when the agent ignores session/cancel', async () => {
    const f = await fixture(engine);
    f.env.ACP_FIXTURE_CANCEL = 'ignore';
    const session = await f.open();
    const running = session.turn(input(engine, 'r1', 'hang please'));
    await expect.poll(async () => (await f.methods()).includes('session/prompt')).toBe(true);
    const started = Date.now();
    await session.interrupt();
    const error = await failure(running);
    expect(Date.now() - started).toBeGreaterThanOrEqual(ACP_CANCEL_WAIT_MS - 50);
    expect(error.code).toBe('CANCELLED');
    expect(error.stopOutcome).toBe('killed');
    expect(session.checkpoint).toMatchObject({ state: 'idle', lastStop: 'killed' });
  }, 15_000);

  it('a restart mid-turn keeps a loadable session resumable, and refuses one that cannot load', () => {
    const busy = {
      version: 1,
      engine,
      nativeSessionId: 's-1',
      lineageId: '00000000-0000-4000-8000-000000000000',
      projectId: 'p1',
      threadId: 't1',
      cliVersion: VERSIONS[engine],
      accountRoute: 'route',
      requestedModel: 'fixture-model',
      reportedModel: null,
      instructionDigest: 'a'.repeat(64),
      scopeDigest: 'text-only',
      state: 'busy',
      origin: 'loaded',
      loadSession: true,
      lostSessionId: null,
      interruptedRequestId: null,
      lastStop: null,
      turns: 1,
    } satisfies AcpSessionCheckpoint;
    expect(recoverAcpCheckpoint(busy, 'r2')).toEqual({
      resume: { ...busy, state: 'idle', origin: 'recovered', interruptedRequestId: 'r2' },
    });
    expect(recoverAcpCheckpoint({ ...busy, loadSession: false }, 'r2')).toEqual({
      refuse: expect.stringMatching(/couldn't resume\. Start again\./),
    });
    expect(recoverAcpCheckpoint({ ...busy, nativeSessionId: null }, 'r2')).toEqual({
      refuse: expect.stringMatching(/couldn't resume/),
    });
  });
});

describe('kept ACP conversation — questions for a person (Cursor)', () => {
  const readScope = (root: string) => ({ root, web: false, access: 'selected' as const, files: [] });
  const asker = (answer: EngineAskAnswer) => {
    const asked: EngineAsk[] = [];
    return {
      asked,
      approvals: async (ask: EngineAsk) => {
        asked.push(ask);
        return answer;
      },
    };
  };

  it('a web fetch outside the read scope becomes a question; go-ahead allows exactly that call', async () => {
    const f = await fixture('cursor');
    const person = asker('go-ahead');
    const scoped = { ...input('cursor', 'open'), readScope: readScope(f.root) };
    const session = await f.adapter.openSession(scoped, {
      observedVersion: VERSIONS.cursor,
      onCheckpoint: async () => {},
    });
    const answer = await session.turn({
      ...input('cursor', 'r1', 'please fetch'),
      readScope: readScope(f.root),
      approvals: person.approvals,
    });
    expect(answer.text).toBe('fetch allowed and done');
    expect(person.asked).toEqual([
      { kind: 'permission', engine: 'cursor', title: 'Open https://example.com/status', toolKind: 'fetch' },
    ]);
  });

  it('a declined question tells the agent no and the same answer continues', async () => {
    const f = await fixture('cursor');
    const person = asker('declined');
    const scoped = { ...input('cursor', 'open'), readScope: readScope(f.root) };
    const session = await f.adapter.openSession(scoped, {
      observedVersion: VERSIONS.cursor,
      onCheckpoint: async () => {},
    });
    const answer = await session.turn({
      ...input('cursor', 'r1', 'please fetch'),
      readScope: readScope(f.root),
      approvals: person.approvals,
    });
    expect(answer.text).toBe('fetch reject');
  });

  it('a question nobody answers in time stops the turn and tells the agent it was cancelled', async () => {
    const f = await fixture('cursor');
    const person = asker('expired');
    const scoped = { ...input('cursor', 'open'), readScope: readScope(f.root) };
    const session = await f.adapter.openSession(scoped, {
      observedVersion: VERSIONS.cursor,
      onCheckpoint: async () => {},
    });
    const error = await failure(
      session.turn({
        ...input('cursor', 'r1', 'please fetch'),
        readScope: readScope(f.root),
        approvals: person.approvals,
      }),
    );
    expect(error.code).toBe('APPROVAL_EXPIRED');
    expect(error.message).toMatch(/nobody answered in time.*Nothing was approved/);
  });

  it('an edit is never put to a person: it stays declined and stops the turn', async () => {
    const f = await fixture('cursor');
    const person = asker('go-ahead');
    const scoped = { ...input('cursor', 'open'), readScope: readScope(f.root) };
    const session = await f.adapter.openSession(scoped, {
      observedVersion: VERSIONS.cursor,
      onCheckpoint: async () => {},
    });
    const error = await failure(
      session.turn({
        ...input('cursor', 'r1', 'please edit'),
        readScope: readScope(f.root),
        approvals: person.approvals,
      }),
    );
    expect(error.code).toBe('UNEXPECTED_TOOL');
    expect(person.asked).toEqual([]);
  });

  it('a plan presented for approval is a question; go-ahead lets the agent continue with it', async () => {
    const f = await fixture('cursor');
    const person = asker('go-ahead');
    const session = await f.open();
    const answer = await session.turn({ ...input('cursor', 'r1', 'make a plan'), approvals: person.approvals });
    expect(answer.text).toBe('plan accepted; outlined');
    expect(person.asked).toEqual([
      { kind: 'plan', engine: 'cursor', title: 'Outline the report in three sections' },
    ]);
    const declined = asker('declined');
    const next = await session.turn({ ...input('cursor', 'r2', 'another plan'), approvals: declined.approvals });
    expect(next.text).toBe('plan rejected');
  });

  it('without a person to ask, a plan is declined exactly as on the text route', async () => {
    const f = await fixture('cursor');
    const session = await f.open();
    const error = await failure(session.turn(input('cursor', 'r1', 'make a plan')));
    expect(error.code).toBe('UNEXPECTED_TOOL');
    expect(error.message).toMatch(/cursor\/create_plan/);
  });

  it('a Stop while a question is open cancels the question', async () => {
    const f = await fixture('cursor');
    let signalled: AbortSignal | undefined;
    const session = await f.open();
    const running = session.turn({
      ...input('cursor', 'r1', 'make a plan'),
      approvals: (_ask, signal) =>
        new Promise<EngineAskAnswer>((resolve) => {
          signalled = signal;
          signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
        }),
    });
    await expect.poll(() => signalled !== undefined).toBe(true);
    await session.interrupt();
    const error = await failure(running);
    expect(error.code).toBe('CANCELLED');
    expect(signalled!.aborted).toBe(true);
  });
});
