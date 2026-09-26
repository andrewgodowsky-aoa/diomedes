import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error The desktop packaging entry is an executable JavaScript module.
import { packageDesktop } from '../scripts/package-desktop.mjs';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fd01-package-'));
  roots.push(root);
  for (const folder of [
    'client',
    'server',
    'shared',
    'desktop',
    'fixtures/harness',
    'licenses', 'resources',
    'dist',
    'scripts',
    'node_modules/electron',
    '.data/native-runtime',
    'electron-zips',
  ])
    await fs.mkdir(path.join(root, folder), { recursive: true });
  for (const file of [
    'desktop/main.mjs',
    'desktop/app-updates.mjs',
    'desktop/update-helper.mjs',
    'desktop/fresh-start.mjs',
    'desktop/diomedes.ico',
    'desktop/service.ts',
    'fixtures/harness/report-lines.txt',
    'LICENSE',
    'package-lock.json',
    'scripts/package-desktop.mjs', 'scripts/build-desktop-auth.mjs',
    'dist/index.html',
  ])
    await fs.writeFile(path.join(root, file), `fixture ${file}`);
  for (const file of ['desktop/native-auth.ts', 'desktop/native-auth-preload.ts'])
    await fs.writeFile(path.join(root, file), 'export const fixture = true;');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.4' }));
  await fs.writeFile(
    path.join(root, 'node_modules/electron/package.json'),
    JSON.stringify({ version: '44.2.0' }),
  );
  await fs.writeFile(
    path.join(root, 'electron-zips/electron-v44.2.0-darwin-arm64.zip'),
    'fixture archive; packager is substituted',
  );
  const build = vi.fn(async (options: { outfile: string }) =>
    fs.writeFile(options.outfile, 'fixture bundled service'),
  );
  const packager = vi.fn(
    async (options: {
      dir: string;
      out: string;
      name: string;
      platform: string;
      arch: string;
      extraResource: string[];
    }) => {
      const output = path.join(options.out, `${options.name}-${options.platform}-${options.arch}`);
      const resources = path.join(output, 'Diomedes.app/Contents/Resources');
      await fs.mkdir(resources, { recursive: true });
      await fs.copyFile(
        path.join(options.dir, 'BUILD_INFO.json'),
        path.join(resources, 'BUILD_INFO.json'),
      );
      await fs.writeFile(path.join(resources, 'app.asar'), 'fixture asar');
      expect(await fs.readdir(options.extraResource[0])).toEqual([]);
      return [output];
    },
  );
  const git = vi.fn((_command: string, args: string[]) =>
    args[0] === 'rev-parse' ? '80263205133c410d590549efd1c8f40cedf33b1c\n' : '',
  );
  return {
    root,
    deps: { build, packager, git },
    options: {
      root,
      platform: 'darwin',
      arch: 'arm64',
      hostPlatform: 'win32',
      electronZipDir: path.join(root, 'electron-zips'),
    },
  };
}

describe('FD01 same desktop packaging entry point', () => {
  it('stages the real source path for darwin/arm64 without Windows runtime carry-over', async () => {
    const { root, deps, options } = await fixture();
    await packageDesktop(options, deps);
    expect(deps.build).toHaveBeenCalledOnce();
    expect(deps.packager).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'darwin',
        arch: 'arm64',
        name: 'Diomedes',
        asar: true,
        electronZipDir: options.electronZipDir,
      }),
    );
    const call = deps.packager.mock.calls[0][0];
    expect(call).not.toHaveProperty('icon');
    expect(call).not.toHaveProperty('win32metadata');
    expect(call).not.toHaveProperty('osxSign');
    expect(call).not.toHaveProperty('asarIntegrityDigest');
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, 'evidence/macos-release/build-info.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({
      target: { platform: 'darwin', arch: 'arm64' },
      nativeRuntime: {
        bundled: false,
        sha256: {},
        expectedOnMachine: expect.arrayContaining(['codex']),
      },
      signing: 'unsigned-experimental',
    });
    expect(JSON.stringify(manifest.nativeRuntime)).not.toMatch(/\.exe/);
    const output = JSON.parse(
      await fs.readFile(path.join(root, 'release/Diomedes-darwin-arm64.manifest.json'), 'utf8'),
    );
    expect(output.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'Diomedes.app/Contents/Resources/app.asar',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );
    expect((await fs.readdir(root)).filter((entry) => entry.startsWith('.desktop-stage-'))).toEqual(
      [],
    );
  });

  it('declares the diomedes-auth sign-in scheme in the macOS app bundle', async () => {
    const { deps, options } = await fixture();
    await packageDesktop(options, deps);
    const call = deps.packager.mock.calls[0][0] as { protocols?: unknown };
    // CFBundleURLTypes: without it macOS never hands diomedes-auth://callback to the app.
    expect(call.protocols).toEqual([{ name: 'Nectovia sign-in', schemes: ['diomedes-auth'] }]);
    const repo = path.resolve(import.meta.dirname, '..');
    // The declared scheme is the one native sign-in's callback uses.
    const auth = await fs.readFile(path.join(repo, 'desktop/native-auth.ts'), 'utf8');
    expect(auth).toContain("export const NATIVE_AUTH_CALLBACK = 'diomedes-auth://callback';");
    // Windows keeps registering the scheme at run time; only the macOS bundle declares it.
    const script = await fs.readFile(path.join(repo, 'scripts/package-desktop.mjs'), 'utf8');
    expect(script).toContain("...(platform === 'darwin' ? { protocols: [{ name: 'Nectovia sign-in', schemes: ['diomedes-auth'] }] } : {}),");
    // macOS delivers the callback as `open-url`; main subscribes to it before the app is ready.
    const main = await fs.readFile(path.join(repo, 'desktop/main.mjs'), 'utf8');
    const capture = main.indexOf('captureNativeAuthCallbacks(app, process.argv)');
    expect(capture).toBeGreaterThan(0);
    expect(capture).toBeLessThan(main.indexOf('.whenReady()'));
  });

  it('fails when the packager builds nothing, instead of reporting an empty release', async () => {
    // On a Windows host that cannot create symlinks, Electron Packager logs that
    // it is skipping the macOS target and resolves with no outputs.
    const { root, deps, options } = await fixture();
    deps.packager.mockResolvedValueOnce([]);
    await expect(packageDesktop(options, deps)).rejects.toThrow(
      /produced no darwin\/arm64 output.*symbolic links/s,
    );
    await expect(fs.stat(path.join(root, 'evidence/macos-release/build-info.json'))).rejects.toThrow();
    expect((await fs.readdir(root)).filter((entry) => entry.startsWith('.desktop-stage-'))).toEqual(
      [],
    );
  });

  it('keeps the default Windows runtime hash gate before bundling or packaging', async () => {
    const { root, deps } = await fixture();
    await fs.writeFile(path.join(root, '.data/native-runtime/codex.exe'), 'unverified executable');
    await expect(
      packageDesktop({ root, hostPlatform: 'win32', hostArch: 'x64' }, deps),
    ).rejects.toThrow('Native runtime hash mismatch: codex.exe');
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.packager).not.toHaveBeenCalled();
  });

  it.each([
    ['darwin', 'x64'],
    ['win32', 'arm64'],
    ['linux', 'x64'],
    ['darwin;bad', 'arm64'],
  ])('rejects an unsupported target %s/%s before preparing outputs', async (platform, arch) => {
    const { deps, options } = await fixture();
    await expect(packageDesktop({ ...options, platform, arch }, deps)).rejects.toThrow(
      'Unsupported desktop target',
    );
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.packager).not.toHaveBeenCalled();
  });

  it('reports the exact missing offline archive instead of downloading a Mac runtime', async () => {
    const { deps, options } = await fixture();
    await expect(
      packageDesktop({ ...options, electronZipDir: path.join(options.root, 'missing') }, deps),
    ).rejects.toThrow('electron-v44.2.0-darwin-arm64.zip');
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.packager).not.toHaveBeenCalled();
  });

  it('retains the current integrity/signing policy as a scoped Mac-host build blocker', async () => {
    const { deps, options } = await fixture();
    await expect(packageDesktop({ ...options, hostPlatform: 'darwin' }, deps)).rejects.toThrow(
      'automatic ad-hoc Framework signing',
    );
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.packager).not.toHaveBeenCalled();
  });
});
