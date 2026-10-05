import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WindowsBonsaiHost } from '../server/bonsai/windows-host.js';
import { BONSAI_PROFILES } from '../shared/bonsai.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bonsai-launcher-'));
  for (const name of ['installation.json', 'nectovia-connection.json', 'Start-Bonsai.ps1', 'Stop-Bonsai.ps1', 'pwsh.exe'])
    await fs.writeFile(path.join(root, name), 'fixture');
});
afterEach(async () => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'win32')('Windows Bonsai helper process lifetime', () => {
  function start() {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      exitCode: null as number | null, killed: false, kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const host = new WindowsBonsaiHost(root, 'helper.ps1', {
      NECTOVIA_BONSAI_HOME: root, NECTOVIA_BONSAI_POWERSHELL: path.join(root, 'pwsh.exe'),
    });
    const pending = host.acquire(BONSAI_PROFILES[0]);
    child.stdout.write(JSON.stringify({ state: 'ready', installed: true, mode: 'Gaming', owned: true, detail: 'Ready.' }) + '\n');
    return { child, pending };
  }
  it('releases on helper exit even when a descendant keeps the output pipes open', async () => {
    const { child, pending } = start(), lease = await pending;
    let released = false;
    const finish = lease.release().then(() => { released = true; });
    child.exitCode = 0; child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);
    await finish;
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('asks the helper to refuse a start unless the person pressed Start', async () => {
    const { child, pending } = start(), lease = await pending;
    expect(vi.mocked(spawn).mock.calls[0][1]).toContain('-NoStart');
    child.exitCode = 0; child.emit('exit', 0); await lease.release();
    vi.useRealTimers();
    const again = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      exitCode: null as number | null, killed: false, kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(again as unknown as ReturnType<typeof spawn>);
    const host = new WindowsBonsaiHost(root, 'helper.ps1', {
      NECTOVIA_BONSAI_HOME: root, NECTOVIA_BONSAI_POWERSHELL: path.join(root, 'pwsh.exe'),
    });
    const woken = host.acquire(BONSAI_PROFILES[1], { start: true });
    expect(vi.mocked(spawn).mock.calls[1][1]).not.toContain('-NoStart');
    expect(vi.mocked(spawn).mock.calls[1][1]).toEqual(expect.arrayContaining(['-Action', 'Acquire', '-Mode', 'Full']));
    again.stdout.write(JSON.stringify({ state: 'ready', installed: true, mode: 'Full', owned: true, detail: 'Ready.' }) + '\n');
    const held = await woken;
    again.exitCode = 0; again.emit('exit', 0); await held.release();
  });
  it('aborts inference when the lease holder exits before release, without waiting for pipe EOF', async () => {
    const { child, pending } = start(), lease = await pending;
    child.exitCode = 1; child.emit('exit', 1);
    expect(lease.signal?.aborted).toBe(true);
    await lease.release();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
