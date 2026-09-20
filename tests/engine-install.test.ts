import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { EngineInstaller, managedBinary } from '../server/engines/install.js';
import { loginCommand, NativeLogin, prepareOmpConfiguration } from '../server/engines/login.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes install '));
  roots.push(root);
  return root;
}
describe('selected official installation and native login', () => {
  it('shows complete pinned offers without accessing the network or changing the host', async () => {
    const root = await setup(),
      fetcher = vi.fn<typeof fetch>();
    const installer = new EngineInstaller(root, { fetch: fetcher, platform: 'win32', arch: 'x64' });
    for (const engine of ['claude-code', 'opencode', 'oh-my-pi'] as const) {
      const offer = installer.offer(engine);
      expect(offer).toMatchObject({
        engine,
        available: true,
        destination: managedBinary(root, engine),
      });
      expect(offer.source).toMatch(/^https:/);
      expect(offer.source).toContain(offer.version);
      expect(offer.publisher).toBeTruthy();
      expect(offer.dependencies.length).toBeGreaterThan(0);
      expect(offer.privileges).toContain('No elevation');
      expect(offer.account).toBeTruthy();
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
    await expect(installer.install('opencode', false)).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects mismatched downloads before extraction or activation, then permits a deliberate retry', async () => {
    const root = await setup(),
      extract = vi.fn(),
      fetcher = vi.fn<typeof fetch>(async () => new Response('wrong release'));
    const installer = new EngineInstaller(root, {
      fetch: fetcher,
      extract,
      platform: 'win32',
      arch: 'x64',
    });
    for (let i = 0; i < 2; i++)
      await expect(installer.install('opencode', true)).rejects.toMatchObject({
        code: 'INSTALL_CHECKSUM',
      });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(extract).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(root, 'installed'))).toEqual([]);
  });
  it('rejects a changed managed destination without downloading or overwriting it', async () => {
    const root = await setup(),
      fetcher = vi.fn<typeof fetch>(),
      file = managedBinary(root, 'oh-my-pi');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture existing binary');
    const installer = new EngineInstaller(root, { fetch: fetcher, platform: 'win32', arch: 'x64' });
    await expect(installer.install('oh-my-pi', true)).rejects.toMatchObject({
      code: 'INSTALL_CHECKSUM',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe('fixture existing binary');
  });
  it('repairs a changed managed copy by setting it aside, never by launching it', async () => {
    const root = await setup(),
      file = managedBinary(root, 'oh-my-pi');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture tampered managed binary');
    const fetcher = vi.fn<typeof fetch>(async () => new Response('not the pinned release'));
    const installer = new EngineInstaller(root, { fetch: fetcher, platform: 'win32', arch: 'x64' });
    // Repair takes the normal pinned path: the download must still match the
    // reviewed digest, so a wrong payload activates nothing.
    await expect(
      installer.install('oh-my-pi', true, undefined, { repair: true }),
    ).rejects.toMatchObject({ code: 'INSTALL_CHECKSUM' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The bad copy is set aside inside Diomedes's own tree, not deleted and
    // not left where anything could run it.
    const kept = await fs.readdir(path.dirname(file));
    expect(kept.some((name) => /\.quarantined-/.test(name))).toBe(true);
    expect(kept).not.toContain(path.basename(file));
    const quarantined = kept.find((name) => /\.quarantined-/.test(name))!;
    expect(await fs.readFile(path.join(path.dirname(file), quarantined), 'utf8')).toBe(
      'fixture tampered managed binary',
    );
  });

  it('keeps a private copy that could not be read, rather than setting it aside', async () => {
    // Antivirus holds the file open for a moment and the digest read fails.
    // Nothing about its content has been proven, so a repair that quarantined
    // it would set aside a healthy copy for being momentarily busy.
    const root = await setup(),
      file = managedBinary(root, 'oh-my-pi');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture healthy managed binary');
    const fetcher = vi.fn<typeof fetch>();
    const busy = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    const installer = new EngineInstaller(root, {
      fetch: fetcher,
      platform: 'win32',
      arch: 'x64',
      verify: vi.fn(async () => {
        throw busy;
      }),
    });
    await expect(
      installer.install('oh-my-pi', true, undefined, { repair: true }),
    ).rejects.toMatchObject({ code: 'INSTALL_UNREADABLE' });
    // Nothing was downloaded, nothing was set aside, and the copy is untouched.
    expect(fetcher).not.toHaveBeenCalled();
    expect(await fs.readdir(path.dirname(file))).toEqual([path.basename(file)]);
    expect(await fs.readFile(file, 'utf8')).toBe('fixture healthy managed binary');
  });

  it('never writes over a copy it set aside earlier, within the same millisecond', async () => {
    const root = await setup(),
      file = managedBinary(root, 'oh-my-pi');
    const fetcher = vi.fn<typeof fetch>(async () => new Response('not the pinned release'));
    const installer = new EngineInstaller(root, { fetch: fetcher, platform: 'win32', arch: 'x64' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
      for (const bytes of ['first tampered copy', 'second tampered copy']) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes);
        await expect(
          installer.install('oh-my-pi', true, undefined, { repair: true }),
        ).rejects.toMatchObject({ code: 'INSTALL_CHECKSUM' });
      }
    } finally {
      vi.useRealTimers();
    }
    const kept = (await fs.readdir(path.dirname(file))).filter((name) =>
      /\.quarantined-/.test(name),
    );
    expect(kept.length).toBe(2);
    const bytes = await Promise.all(
      kept.map((name) => fs.readFile(path.join(path.dirname(file), name), 'utf8')),
    );
    expect(bytes.sort()).toEqual(['first tampered copy', 'second tampered copy']);
    for (const name of kept) {
      expect(name.startsWith(`${path.basename(file)}.quarantined-`)).toBe(true);
      expect(name).not.toMatch(/[\\/:]/);
    }
  });

  it('refuses a changed managed copy without repair, and leaves it exactly where it was', async () => {
    const root = await setup(),
      fetcher = vi.fn<typeof fetch>(),
      file = managedBinary(root, 'oh-my-pi');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture existing binary');
    const installer = new EngineInstaller(root, { fetch: fetcher, platform: 'win32', arch: 'x64' });
    await expect(installer.install('oh-my-pi', true)).rejects.toMatchObject({
      code: 'INSTALL_CHECKSUM',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe('fixture existing binary');
    expect(await fs.readdir(path.dirname(file))).toEqual([path.basename(file)]);
  });

  it('leaves no partial destination when a repair is interrupted mid-download', async () => {
    const root = await setup(),
      controller = new AbortController(),
      file = managedBinary(root, 'claude-code');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture tampered claude');
    const fetcher: typeof fetch = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
        controller.abort();
      });
    const installer = new EngineInstaller(root, { fetch: fetcher, platform: 'win32', arch: 'x64' });
    await expect(
      installer.install('claude-code', true, controller.signal, { repair: true }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    // Either nothing at the destination or a verified file: never a half one.
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    const left = await fs.readdir(path.dirname(file));
    expect(left.every((name) => /\.quarantined-/.test(name))).toBe(true);
  });

  it('cancels a waiting download and leaves no activated or partial installation', async () => {
    const root = await setup(),
      controller = new AbortController();
    const fetcher: typeof fetch = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
        controller.abort();
      });
    const installer = new EngineInstaller(root, { fetch: fetcher, platform: 'win32', arch: 'x64' });
    await expect(installer.install('claude-code', true, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(await fs.readdir(path.join(root, 'installed'))).toEqual([]);
  });
  it('keeps provider login native and rejects an undisclosed action', async () => {
    expect(loginCommand('claude-code')).toContain('--claudeai');
    expect(loginCommand('claude-code')).not.toContain('--console');
    expect(loginCommand('opencode')).toEqual([
      'auth',
      'login',
      '--pure',
      '--provider',
      'opencode-go',
    ]);
    expect(() => loginCommand('oh-my-pi')).toThrow(/native OMP/);
    const login = new NativeLogin(await setup());
    await expect(
      login.start(
        {
          engine: 'claude-code',
          installation: 'missing',
          compatibility: 'unknown',
          authentication: 'unknown',
          accountRoute: null,
          models: [],
          checkedAt: null,
          detail: '',
          usage: { state: 'unknown', checkedAt: null },
        },
        false,
      ),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });
  it('creates an empty native API template once and never reads or overwrites later credentials', async () => {
    const root = await setup(),
      directory = await prepareOmpConfiguration(root);
    const file = path.join(directory, 'models.yml');
    expect(await fs.readFile(file, 'utf8')).toContain('providers: {}');
    await fs.writeFile(file, 'fixture user-owned native configuration');
    await prepareOmpConfiguration(root);
    expect(await fs.readFile(file, 'utf8')).toBe('fixture user-owned native configuration');
  });
  it.skipIf(process.platform !== 'win32')(
    'cancels only the owned native sign-in process and allows another deliberate attempt',
    async () => {
      let child: ChildProcess | undefined;
      const launch = vi.fn(() => {
        child = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        return child;
      });
      const login = new NativeLogin(await setup(), launch);
      const connection = {
        engine: 'claude-code',
        installation: 'found',
        compatibility: 'supported',
        location: 'fixture.exe',
        authentication: 'unknown',
        accountRoute: null,
        models: [],
        checkedAt: null,
        detail: '',
        usage: { state: 'unknown', checkedAt: null },
      } as const;
      try {
        await login.start({ ...connection, models: [] }, true);
        const pid = child!.pid!;
        await login.start({ ...connection, models: [] }, true);
        expect(launch).toHaveBeenCalledTimes(1);
        await login.stop('claude-code');
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })
          .toBe(false);
        await login.start({ ...connection, models: [] }, true);
        expect(launch).toHaveBeenCalledTimes(2);
      } finally {
        await login.close();
      }
    },
  );
});
