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
