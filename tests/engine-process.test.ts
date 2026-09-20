import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const cleanup = vi.hoisted(() => ({ fail: false }));
vi.mock('../server/integrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/integrations.js')>();
  return {
    ...actual,
    killOwnedProcess: async (...args: Parameters<typeof actual.killOwnedProcess>) => {
      if (cleanup.fail) throw new Error('raw native cleanup diagnostic');
      await actual.killOwnedProcess(...args);
    },
  };
});
import {
  abortFailure,
  launchCommand,
  openProcess,
  capture,
  engineEnvironment,
  PROCESS_TIMEOUT_DETAIL,
} from '../server/engines/process.js';
import { HarnessError } from '../server/harness/policy.js';

const roots: string[] = [];
afterEach(async () => {
  // Windows can keep a killed child's working directory busy for a moment after
  // the process itself is gone, so the removal retries rather than failing the test.
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function script(source: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes engine '));
  roots.push(root);
  const file = path.join(root, 'protocol.mjs');
  await fs.writeFile(file, source);
  return { root, file };
}
describe('what an abort is reported as', () => {
  it('tells a deadline, a person stopping and the host withdrawing the run apart', () => {
    // A budget the host imposed.
    expect(abortFailure(new DOMException('deadline', 'TimeoutError'), PROCESS_TIMEOUT_DETAIL))
      .toMatchObject({ code: 'TIMEOUT', ambiguous: true });
    // A person pressing stop: `abort()` with no reason, which is what the
    // service's own cancellation and a closed connection both pass.
    for (const reason of [undefined, new DOMException('aborted', 'AbortError')])
      expect(abortFailure(reason, PROCESS_TIMEOUT_DETAIL)).toMatchObject({
        code: 'CANCELLED',
        ambiguous: true,
        message: expect.stringContaining('The request was stopped.'),
      });
  });

  it('does not report a lease the host invalidated as the person’s own cancellation', () => {
    // `server/harness/run-service.ts` aborts the run's controller with its own
    // error when a dead process's lease is invalidated. Nobody pressed stop,
    // and saying they did sends them looking for something they did not do.
    const withdrawn = abortFailure(
      new HarnessError('stale_lease', 'stale lease'),
      PROCESS_TIMEOUT_DETAIL,
    );
    expect(withdrawn.code).toBe('DISPATCH_UNCERTAIN');
    expect(withdrawn.ambiguous).toBe(true);
    expect(withdrawn.message).not.toMatch(/was stopped/i);
    expect(withdrawn.message).toMatch(/permission to run changed/i);
  });

  it('carries that through an owned process the host withdrew', async () => {
    const { root, file } = await script('process.stdin.resume();');
    const controller = new AbortController();
    const child = openProcess({
      file: process.execPath,
      args: [file],
      cwd: root,
      env: engineEnvironment(),
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    controller.abort(new HarnessError('stale_lease', 'stale lease'));
    try {
      await expect(child.next()).rejects.toMatchObject({
        code: 'DISPATCH_UNCERTAIN',
        ambiguous: true,
      });
    } finally {
      await child.close().catch(() => {
        /* Cleanup is not what this test is about. */
      });
    }
  });
});

describe('owned engine processes', () => {
  it('quotes Windows shim paths and static arguments with spaces without accepting command syntax', () => {
    const spec = launchCommand(
      'C:\\Users\\Ren\u00e9 Doe\\omp.cmd',
      ['serve', '--config', 'C:\\My settings\\safe.json'],
      'win32',
    );
    expect(spec.args.at(-1)).toBe(
      '""C:\\Users\\Ren\u00e9 Doe\\omp.cmd" "serve" "--config" "C:\\My settings\\safe.json""',
    );
    expect(() => launchCommand('C:\\bad%PATH%\\tool.cmd', [], 'win32')).toThrow(/shim/i);
    expect(() => launchCommand('C:\\tool.cmd', ['hello & whoami'], 'win32')).toThrow(/shim/i);
  });
  it('does not inherit API keys, alternate providers, hooks, node injection or shell session state', () => {
    expect(
      engineEnvironment({
        PATH: 'bin',
        USERPROFILE: 'home',
        ANTHROPIC_API_KEY: 'secret',
        NODE_OPTIONS: '--require evil',
        OPENCODE_CONFIG: 'evil',
        PI_SMOL_MODEL: 'other',
        HTTP_PROXY: 'remote',
      }),
    ).toEqual({ PATH: 'bin', USERPROFILE: 'home' });
  });
  it.skipIf(process.platform !== 'win32')(
    'runs an actual Windows shim in a spaced Unicode path and kills its owned child tree',
    async () => {
      const { root, file } = await script(
        "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify({pid:child.pid})); process.stdin.resume();",
      );
      const directory = path.join(root, 'Ren\u00e9 space');
      await fs.mkdir(directory);
      const shim = path.join(directory, 'engine.cmd');
      await fs.writeFile(shim, `@echo off\r\n"${process.execPath}" "${file}"\r\n`);
      const controller = new AbortController();
      const child = openProcess({
        file: shim,
        args: [],
        cwd: directory,
        env: engineEnvironment(),
        signal: controller.signal,
        timeoutMs: 5000,
      });
      const frame = await child.next();
      expect(typeof frame.pid).toBe('number');
      controller.abort();
      await child.close();
      await expect
        .poll(
          () => {
            try {
              process.kill(Number(frame.pid), 0);
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 10_000 },
        )
        .toBe(false);
    },
  );
  it('reassembles UTF-8 split across chunks and returns structured JSON lines', async () => {
    const { root, file } = await script(
      'const b=Buffer.from(\'{"text":"caf\u00e9"}\\n\'); process.stdout.write(b.subarray(0,13)); setTimeout(()=>{process.stdout.write(b.subarray(13));},5); process.stdin.resume();',
    );
    const child = openProcess({
      file: process.execPath,
      args: [file],
      cwd: root,
      env: engineEnvironment(),
      timeoutMs: 2000,
    });
    try {
      expect(await child.next()).toEqual({ text: 'caf\u00e9' });
    } finally {
      await child.close();
    }
  });
  it('times out an unresponsive process and closes it', async () => {
    const { root, file } = await script('process.stdin.resume();');
    const child = openProcess({
      file: process.execPath,
      args: [file],
      cwd: root,
      env: engineEnvironment(),
      timeoutMs: 100,
    });
    try {
      await expect(child.next()).rejects.toMatchObject({ code: 'TIMEOUT' });
    } finally {
      await child.close();
    }
    expect(child.closed).toBe(true);
  });
  it('preserves cancellation when owned-process cleanup cannot be confirmed', async () => {
    const { root, file } = await script(
      'setTimeout(() => process.exit(0), 300); process.stdin.resume();',
    );
    const controller = new AbortController();
    const child = openProcess({
      file: process.execPath,
      args: [file],
      cwd: root,
      env: engineEnvironment(),
      signal: controller.signal,
      timeoutMs: 2000,
    });
    controller.abort();
    await expect(child.next()).rejects.toMatchObject({ code: 'CANCELLED', ambiguous: true });
    cleanup.fail = true;
    try {
      const error = await child.close().catch((error) => error);
      expect(error).toMatchObject({ code: 'CANCELLED', ambiguous: true });
      expect((error as Error).message).toMatch(
        /could not be confirmed stopped.*wait before trying/i,
      );
      expect((error as Error).message).not.toContain('raw native cleanup diagnostic');
    } finally {
      cleanup.fail = false;
      await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0);
    }
  });
  it('refuses to start under a host deadline that has already passed, as a timeout', async () => {
    const { root, file } = await script('process.stdin.resume();');
    // What `EngineService.test()` hands an adapter is a merged signal whose
    // reason names which half fired. A budget the host imposed is not a person
    // pressing stop, and must never be reported to them as their own.
    const expired = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    let thrown: { code?: string; message?: string } = {};
    try {
      openProcess({
        file: process.execPath,
        args: [file],
        cwd: root,
        env: engineEnvironment(),
        signal: expired,
      });
    } catch (error) {
      thrown = error as typeof thrown;
    }
    expect(thrown.code).toBe('TIMEOUT');
    expect(thrown.message).not.toMatch(/was stopped/i);
  });
  it('still reads the person pressing stop as a cancellation while a host budget rides along', async () => {
    const { root, file } = await script('process.stdin.resume();');
    const caller = new AbortController();
    const child = openProcess({
      file: process.execPath,
      args: [file],
      cwd: root,
      env: engineEnvironment(),
      signal: AbortSignal.any([AbortSignal.timeout(30_000), caller.signal]),
      timeoutMs: 30_000,
    });
    caller.abort();
    try {
      await expect(child.next()).rejects.toMatchObject({ code: 'CANCELLED', ambiguous: true });
    } finally {
      await child.close().catch(() => {
        /* Cleanup is not what this test is about. */
      });
    }
  });
  it('rejects malformed output and never returns a partial success', async () => {
    const { root, file } = await script("console.log('not json'); process.stdin.resume();");
    const child = openProcess({
      file: process.execPath,
      args: [file],
      cwd: root,
      env: engineEnvironment(),
      timeoutMs: 1000,
    });
    try {
      await expect(child.next()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    } finally {
      await child.close();
    }
  });
  it('bounds capture output, reports missing dependencies and respects cancellation', async () => {
    const { root, file } = await script(
      "process.stdout.write('x'.repeat(20000)); process.stdin.resume();",
    );
    await expect(
      capture({
        file: process.execPath,
        args: [file],
        cwd: root,
        env: engineEnvironment(),
        timeoutMs: 2000,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    await expect(
      capture({
        file: path.join(root, 'missing.exe'),
        args: [],
        cwd: root,
        env: engineEnvironment(),
        timeoutMs: 2000,
      }),
    ).rejects.toMatchObject({ code: 'LAUNCH_FAILED' });
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      openProcess({
        file: process.execPath,
        args: [file],
        cwd: root,
        env: engineEnvironment(),
        signal: controller.signal,
      }),
    ).toThrow(/stopped/i);
  });
});
