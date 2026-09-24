import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

/**
 * `taskkill /T /F` is replaced by an emitter the test ends by hand, so the
 * order of taskkill's exit and the owned child's exit is the test's to choose.
 * Nothing real is spawned or killed.
 */
const taskkill = vi.hoisted(() => ({ last: undefined as EventEmitter | undefined }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const killer = new EventEmitter();
      taskkill.last = killer;
      return killer;
    }),
  };
});
import { IntegrationError, killOwnedProcess } from '../server/integrations.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }));
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers();
  taskkill.last = undefined;
});

/** An owned child that has not exited yet, as Node sees it. */
function ownedChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  const exit = (code = 1) => {
    child.exitCode = code;
    child.emit('exit', code, null);
  };
  return { child: child as unknown as ChildProcess, exit };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof IntegrationError ? error.code : String(error)),
  );

describe('stopping an owned process on Windows', () => {
  it('treats a tree kill that reports failure as stopped once the child exits', async () => {
    // Measured on Windows 11: `taskkill /T /F` exits 255 when a short-lived
    // grandchild is gone before taskkill reaches it ("could not be terminated"),
    // while the root does die, and taskkill's own exit usually arrives before
    // Node delivers the child's. The child's exit is what confirms the stop.
    const { child, exit } = ownedChild();
    const stopping = outcome(killOwnedProcess(child));
    await settle();
    taskkill.last!.emit('exit', 255);
    await settle();
    exit();
    expect(await stopping).toBe('resolved');
  });

  it('still reports a stop it cannot confirm', async () => {
    vi.useFakeTimers();
    const { child } = ownedChild();
    const stopping = outcome(killOwnedProcess(child));
    await vi.advanceTimersByTimeAsync(0);
    taskkill.last!.emit('exit', 255);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stopping).toBe('CLEANUP_FAILED');
  });

  it('keeps a successful tree kill whose exit is late a timeout, not a failure', async () => {
    vi.useFakeTimers();
    const { child } = ownedChild();
    const stopping = outcome(killOwnedProcess(child));
    await vi.advanceTimersByTimeAsync(0);
    taskkill.last!.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stopping).toBe('CLEANUP_TIMEOUT');
  });

  it('resolves a successful tree kill once the child exits', async () => {
    const { child, exit } = ownedChild();
    const stopping = outcome(killOwnedProcess(child));
    await settle();
    taskkill.last!.emit('exit', 0);
    await settle();
    exit();
    expect(await stopping).toBe('resolved');
  });
});
