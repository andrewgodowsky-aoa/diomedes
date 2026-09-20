import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { NativeLogin, type SignInOutcome } from '../server/engines/login.js';
import type { EngineConnection } from '../shared/engines.js';
import type { ExternalEngine } from '../shared/types.js';

/**
 * A finished native sign-in proves nothing on its own: the host asks for one
 * fresh inspection, and that inspection's answer is what a screen shows. These
 * cover when the callback fires, that it fires once, and that a failure inside
 * it never leaves a route marked as still signing in.
 */
const roots: string[] = [];
const realPlatform = process.platform;
const realSystemRoot = process.env.SystemRoot;
beforeEach(() => {
  // The native sign-in window is a Windows console; the branch under test is
  // the same one a customer runs, so the tests declare that platform.
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  if (realSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = realSystemRoot;
  vi.useRealTimers();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes login '));
  roots.push(root);
  return root;
}
/** A native console that never opens: it only reports what a real one reports. */
class FakeConsole extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
  unref() {
    return this;
  }
  exit(code = 0) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}
function launcher(options: { pid?: number; fails?: boolean } = {}) {
  const children: FakeConsole[] = [];
  const launch = vi.fn(() => {
    const child = new FakeConsole(options.pid);
    children.push(child);
    queueMicrotask(() => child.emit(options.fails ? 'error' : 'spawn'));
    return child as unknown as ChildProcess;
  });
  return { launch, children };
}
function recorder() {
  const calls: { engine: ExternalEngine; outcome: SignInOutcome }[] = [];
  const waiting: (() => void)[] = [];
  const onFinished = vi.fn((engine: ExternalEngine, outcome: SignInOutcome) => {
    calls.push({ engine, outcome });
    for (const resume of waiting.splice(0)) resume();
  });
  const settled = (count: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (calls.length >= count) resolve();
        else waiting.push(check);
      };
      check();
    });
  return { calls, onFinished, settled };
}
/** Drain the microtasks a contained callback would be scheduled on. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
const connection = (engine: ExternalEngine): EngineConnection => ({
  engine,
  installation: 'found',
  compatibility: 'supported',
  location: 'fixture.exe',
  authentication: 'unknown',
  accountRoute: null,
  models: [],
  checkedAt: null,
  detail: '',
  usage: { state: 'unknown', checkedAt: null },
});
describe('a finished native sign-in asks for a fresh check', () => {
  it('reports the window closing on its own, exactly once, and goes idle', async () => {
    const { launch, children } = launcher(),
      { calls, onFinished, settled } = recorder();
    const login = new NativeLogin(await setup(), launch, { onFinished });
    await login.start(connection('claude-code'), true);
    expect(login.state('claude-code')).toBe('running');
    expect(onFinished).not.toHaveBeenCalled();
    children[0].exit(0);
    await settled(1);
    await flush();
    expect(calls).toEqual([{ engine: 'claude-code', outcome: 'exited' }]);
    expect(login.state('claude-code')).toBe('idle');
  });
  it('does not read the exit code as an answer: a failed sign-in reports the same way', async () => {
    const { launch, children } = launcher(),
      { calls, onFinished, settled } = recorder();
    const login = new NativeLogin(await setup(), launch, { onFinished });
    await login.start(connection('claude-code'), true);
    children[0].exit(1);
    await settled(1);
    expect(calls).toEqual([{ engine: 'claude-code', outcome: 'exited' }]);
  });
  it('names a cancellation stopped even when the process exits during the close', async () => {
    const { launch, children } = launcher(),
      { calls, onFinished, settled } = recorder();
    const login = new NativeLogin(await setup(), launch, { onFinished });
    await login.start(connection('claude-code'), true);
    const closing = login.stop('claude-code');
    // The window really ends while Diomedes is closing it. Whichever event
    // lands first, the reason the person sees is the one they asked for.
    children[0].exit(0);
    expect((await closing).detail).toContain('checking this service again');
    await settled(1);
    await flush();
    expect(calls).toEqual([{ engine: 'claude-code', outcome: 'stopped' }]);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(login.state('claude-code')).toBe('idle');
  });
  it('reports the ten-minute abandonment as timed out, once', async () => {
    vi.useFakeTimers();
    const { launch } = launcher(),
      { calls, onFinished, settled } = recorder();
    const login = new NativeLogin(await setup(), launch, { onFinished });
    await login.start(connection('claude-code'), true);
    await vi.advanceTimersByTimeAsync(599_000);
    expect(onFinished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await settled(1);
    expect(calls).toEqual([{ engine: 'claude-code', outcome: 'timed-out' }]);
    expect(login.state('claude-code')).toBe('idle');
  });
  it('never reports a sign-in that failed to open', async () => {
    const { launch } = launcher({ fails: true }),
      { onFinished } = recorder();
    const login = new NativeLogin(await setup(), launch, { onFinished });
    await expect(login.start(connection('claude-code'), true)).rejects.toMatchObject({
      code: 'LOGIN_FAILED',
    });
    await flush();
    expect(onFinished).not.toHaveBeenCalled();
    expect(login.state('claude-code')).toBe('idle');
  });
  it('contains a callback that throws or rejects, and still forgets the window', async () => {
    const thrown = new NativeLogin(await setup(), launcher().launch, {
      onFinished: () => {
        throw new Error('fixture check failed');
      },
    });
    const rejected = new NativeLogin(await setup(), launcher().launch, {
      onFinished: () => Promise.reject(new Error('fixture check rejected')),
    });
    for (const login of [thrown, rejected]) {
      await login.start(connection('claude-code'), true);
      await login.stop('claude-code');
      await flush();
      expect(login.state('claude-code')).toBe('idle');
      // A second attempt is still possible: nothing stayed marked as running.
      await login.start(connection('claude-code'), true);
      expect(login.state('claude-code')).toBe('running');
      await login.close();
      await flush();
      expect(login.state('claude-code')).toBe('idle');
    }
  });
  it('keeps two routes signing in at once apart', async () => {
    const { launch, children } = launcher(),
      { calls, onFinished, settled } = recorder();
    const login = new NativeLogin(await setup(), launch, { onFinished });
    await login.start(connection('claude-code'), true);
    await login.start(connection('opencode'), true);
    expect(login.state('claude-code')).toBe('running');
    expect(login.state('opencode')).toBe('running');
    children[1].exit(0);
    await settled(1);
    expect(calls).toEqual([{ engine: 'opencode', outcome: 'exited' }]);
    expect(login.state('claude-code')).toBe('running');
    expect(login.state('opencode')).toBe('idle');
    await login.stop('claude-code');
    await settled(2);
    await flush();
    expect(calls).toEqual([
      { engine: 'opencode', outcome: 'exited' },
      { engine: 'claude-code', outcome: 'stopped' },
    ]);
  });
  it('reports every window it closes on shutdown', async () => {
    const { launch } = launcher(),
      { calls, onFinished, settled } = recorder();
    const login = new NativeLogin(await setup(), launch, { onFinished });
    await login.start(connection('claude-code'), true);
    await login.start(connection('opencode'), true);
    await login.close();
    await settled(2);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.engine).sort()).toEqual(['claude-code', 'opencode']);
    expect(calls.every((call) => call.outcome === 'stopped')).toBe(true);
    expect(login.state('claude-code')).toBe('idle');
  });
  it('lets a late report from an abandoned window stand without touching the next one', async () => {
    const root = await setup();
    // The owned-process close fails, so the first window is forgotten while its
    // process is still alive and a second sign-in can begin.
    process.env.SystemRoot = path.join(root, 'absent');
    const { launch, children } = launcher({ pid: 424242 }),
      { calls, onFinished, settled } = recorder();
    const login = new NativeLogin(root, launch, { onFinished });
    await login.start(connection('claude-code'), true);
    await expect(login.stop('claude-code')).rejects.toBeInstanceOf(Error);
    expect(login.state('claude-code')).toBe('idle');
    expect(onFinished).not.toHaveBeenCalled();
    await login.start(connection('claude-code'), true);
    expect(children).toHaveLength(2);
    children[0].exit(0);
    await settled(1);
    await flush();
    expect(calls).toEqual([{ engine: 'claude-code', outcome: 'stopped' }]);
    expect(login.state('claude-code')).toBe('running');
  });
  it('promises a re-check only when it was given one', async () => {
    const wired = new NativeLogin(await setup(), launcher().launch, { onFinished: () => {} });
    const alone = new NativeLogin(await setup(), launcher().launch);
    const started = await wired.start(connection('claude-code'), true);
    expect(started.detail).toBe(
      'Complete sign-in in this native tool. Diomedes checks this service again when this window closes.',
    );
    expect((await wired.start(connection('claude-code'), true)).detail).toContain(
      'Diomedes checks this service again when it closes',
    );
    expect((await wired.stop('claude-code')).detail).toBe(
      'The native sign-in window was closed. Diomedes is checking this service again.',
    );
    const unwired = await alone.start(connection('claude-code'), true);
    expect(unwired.detail).toBe(
      'Complete sign-in in this native tool, then use Check sign-in and models in Diomedes.',
    );
    expect((await alone.start(connection('claude-code'), true)).detail).toBe(
      'The native sign-in window is already open. Finish or cancel it, then recheck.',
    );
    expect((await alone.stop('claude-code')).detail).toBe(
      'The native sign-in window was closed. Recheck to see whether sign-in completed.',
    );
    for (const login of [wired, alone]) {
      expect((await login.stop('claude-code')).detail).toBe('No native sign-in window is running.');
      await login.close();
    }
  });
  it('leaves the native OMP profile untracked: opening a folder is not a finished sign-in', async () => {
    const root = await setup();
    process.env.SystemRoot = path.join(root, 'absent');
    const { onFinished } = recorder();
    const login = new NativeLogin(root, launcher().launch, { onFinished });
    // The folder is the person's own native credential authority; Diomedes
    // cannot know when they finished editing it, so it still asks them to
    // recheck and never reports a sign-in it did not watch.
    await expect(login.start(connection('oh-my-pi'), true)).rejects.toMatchObject({
      code: 'LOGIN_FAILED',
    });
    await flush();
    expect(onFinished).not.toHaveBeenCalled();
    expect(login.state('oh-my-pi')).toBe('idle');
  });
});
