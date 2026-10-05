import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DESCRIPTOR_VARIABLE, WindowsLocalModelHost } from '../server/bonsai/windows-host.js';
import { parseLocalModelDescriptor, type LocalModelDescriptor } from '../shared/local-model.js';
import { meadowDescriptor, writeLocalModelFolder } from './fixtures/local-model.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
let root: string, folder: string, descriptor: LocalModelDescriptor;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-route-launcher-'));
  folder = writeLocalModelFolder(path.join(root, 'meadow'), meadowDescriptor());
  descriptor = parseLocalModelDescriptor(meadowDescriptor(), folder);
  await fs.writeFile(path.join(root, 'pwsh.exe'), 'fixture');
});
afterEach(async () => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

function helper() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null as number | null, killed: false, kill: vi.fn(),
  });
}
const windowsHost = () => new WindowsLocalModelHost(root, 'helper.ps1', { NECTOVIA_LOCAL_MODEL_POWERSHELL: path.join(root, 'pwsh.exe') });

describe.skipIf(process.platform !== 'win32')('the Windows local model helper process', () => {
  function start() {
    vi.useFakeTimers();
    const child = helper();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const pending = windowsHost().acquire(descriptor.profiles[0], undefined, descriptor);
    child.stdout.write(JSON.stringify({ state: 'ready', installed: true, mode: 'Quick', model: 'meadow-9b', contextTokens: 16384,
      owned: true, detail: 'meadow-9b Quick is ready.' }) + '\n');
    return { child, pending };
  }
  it('passes the checked description and the profile, never a command from the model', async () => {
    const { child, pending } = start(), lease = await pending;
    expect(lease.status).toMatchObject({ state: 'ready', mode: 'Quick', model: 'meadow-9b', contextTokens: 16384 });
    const [command, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(command).toBe(path.join(root, 'pwsh.exe'));
    expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'helper.ps1', '-Mode', 'Quick',
      '-OwnershipFile', path.join(root, 'local-model-ownership.json'),
      '-EarlierOwnershipFile', path.join(root, 'bonsai-ownership.json'), '-NoStart']);
    expect(JSON.parse(String(options?.env?.[DESCRIPTOR_VARIABLE]))).toEqual({
      folder, baseUrl: 'http://127.0.0.1:18100/v1', serverRoot: 'http://127.0.0.1:18100', healthUrl: 'http://127.0.0.1:18100/health',
      model: 'meadow-9b', startScript: path.join(folder, 'Start-Meadow.ps1'), stopScript: path.join(folder, 'scripts', 'Stop-Meadow.ps1'),
      modeParameter: 'Profile', profiles: [{ mode: 'Quick', contextTokens: 16384, images: false }, { mode: 'Deep', contextTokens: 131072, images: true }],
    });
    child.exitCode = 0; child.emit('exit', 0); await lease.release();
  });
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
    const again = helper();
    vi.mocked(spawn).mockReturnValue(again as unknown as ReturnType<typeof spawn>);
    const woken = windowsHost().acquire(descriptor.profiles[1], { start: true }, descriptor);
    expect(vi.mocked(spawn).mock.calls[1][1]).not.toContain('-NoStart');
    expect(vi.mocked(spawn).mock.calls[1][1]).toEqual(expect.arrayContaining(['-Mode', 'Deep']));
    again.stdout.write(JSON.stringify({ state: 'ready', installed: true, mode: 'Deep', owned: true, detail: 'Ready.' }) + '\n');
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
  it("answers the helper's refusal with its own state and words", async () => {
    const child = helper();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const pending = windowsHost().acquire(descriptor.profiles[0], undefined, descriptor);
    child.stdout.write(JSON.stringify({ state: 'unloaded', installed: true, mode: null, owned: false,
      detail: 'The local model is running its Deep profile, not Quick. Start Quick first.' }) + '\n');
    await expect(pending).rejects.toMatchObject({ state: 'unloaded', message: 'The local model is running its Deep profile, not Quick. Start Quick first.' });
  });
  it('runs nothing when a script the description names is gone', async () => {
    await fs.rm(path.join(folder, 'Start-Meadow.ps1'));
    await expect(windowsHost().acquire(descriptor.profiles[0], { start: true }, descriptor)).rejects.toMatchObject({ state: 'error',
      message: `lifecycle.startScript in nectovia-connection.json names ${path.join(folder, 'Start-Meadow.ps1')}, which does not exist.` });
    expect(spawn).not.toHaveBeenCalled();
  });
});
