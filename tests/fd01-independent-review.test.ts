import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDiscovery, defaultDiscoveryDeps, type DiscoveryDeps, type RunResult } from '../server/discovery.js';
import * as discoveryModule from '../server/discovery.js';
import * as installModule from '../server/engines/install.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { createIntegrations } from '../server/integrations.js';
// @ts-expect-error The existing packaging command is an executable JavaScript module.
import { packageDesktop } from '../scripts/package-desktop.mjs';

const roots: string[] = [];
const success = (stdout = ''): RunResult => ({ stdout, stderr: '', code: 0, timedOut: false });
const offline = (async () => { throw new Error('independent offline fixture'); }) as typeof fetch;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fd01-independent-'));
  roots.push(root);
  return root;
}
function mac(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    platform: 'darwin', env: { HOME: '/Users/review', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    which: async () => [], exists: async () => false, run: async () => success(), fetch: offline,
    ...overrides,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('fd01-independent-'))
      throw new Error('Unexpected temporary fixture root');
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('FD01 independent observed discovery and hostile output', () => {
  it('does not turn a successful version probe into account, execution, or capability readiness', async () => {
    const result = await createDiscovery(mac({
      exists: async (file) => file.startsWith('/opt/homebrew/bin/'),
      run: async () => success('tool 99.2.3 SECRET_DO_NOT_RETAIN'),
    })).discover();
    for (const entry of [...result.engines, result.codex!].filter((entry) => entry.found)) {
      expect(entry).toMatchObject({ available: false, enabled: false, capabilities: [] });
      expect(entry.signIn).not.toBe('signed-in');
      expect(entry.disclosure.join(' ')).toContain('observed on darwin via explicit-location');
    }
    expect(JSON.stringify(result)).not.toContain('SECRET_DO_NOT_RETAIN');
  });

  it.each([
    ['Homebrew', '/opt/homebrew/bin/opencode'],
    ['Intel-prefix', '/usr/local/bin/opencode'],
    ['user-local', '/Users/review/.local/bin/opencode'],
    ['Bun', '/Users/review/.bun/bin/opencode'],
    ['OpenCode', '/Users/review/.opencode/bin/opencode'],
    ['npm-global', '/Users/review/.npm-global/bin/opencode'],
  ])('observes only the existing %s explicit candidate', async (_label, location) => {
    const run = vi.fn(async () => success('opencode 1.18.4'));
    const result = await createDiscovery(mac({ exists: async (file) => file === location, run })).discover();
    const entry = result.engines.find((row) => row.id === 'opencode')!;
    expect(entry).toMatchObject({ found: true, location, installedVersion: '1.18.4' });
    expect(entry.disclosure.join(' ')).toContain('via explicit-location');
    expect(run).toHaveBeenCalledWith(location, ['--version']);
  });

  it('uses a validated PATH hit before a different explicit installation', async () => {
    const selected = '/opt/review tools/claude';
    const result = await createDiscovery(mac({
      which: async (name) => name === 'claude' ? [selected] : [],
      exists: async (file) => file === selected || file === '/opt/homebrew/bin/claude',
      run: async () => success('claude 2.1.252'),
    })).discover();
    expect(result.engines[0].location).toBe(selected);
    expect(result.engines[0].disclosure.join(' ')).toContain('via path');
  });

  it.each([
    'claude: aliased to /tmp/claude', './claude', 'C:\\tools\\claude.exe',
    '/tmp/claude.exe', '/tmp/claude.CMD', '/tmp/claude.bat',
    '/tmp/claude\n/tmp/other', '/tmp/claude\r', '/tmp/claude\u0000extra',
    '/tmp/claude\u001b[31m', '/tmp/claude\\other',
  ])('refuses non-path/foreign/control resolver output even when exists would accept it: %j', async (output) => {
    const run = vi.fn(async (file: string) => file === '/bin/zsh' ? success(output) : success('2.1.252'));
    const result = await createDiscovery(mac({
      which: async () => [output], exists: async (file) => file === output, run,
    })).discover();
    expect(result.engines[0].found).toBe(false);
    expect(result.codex?.found).toBe(false);
    expect(run.mock.calls.every(([file]) => file === '/bin/zsh')).toBe(true);
  });

  it.each([
    { ...success('/custom/claude'), code: 1 },
    { ...success('/custom/claude'), code: null },
    { ...success('/custom/claude'), timedOut: true },
    success('startup banner\n/custom/claude'),
  ])('does not promote a failed, timed-out, or noisy login-shell probe', async (probe) => {
    const run = vi.fn(async () => probe);
    const result = await createDiscovery(mac({ run, exists: async (file) => file === '/custom/claude' })).discover();
    expect(result.engines[0]).toMatchObject({ found: false, available: false });
    expect(result.engines[0].disclosure.join(' ')).toContain('absent on darwin');
    expect(run.mock.calls.length).toBeGreaterThan(0);
  });

  it('passes shell-looking valid filenames as literal process data using the selected fixed shell', async () => {
    const literal = '/Users/review/tools;$(echo ignored)/claude';
    const run = vi.fn(async (file: string, args: string[]) => {
      if (file === '/bin/bash') return success(args.at(-1) === 'claude' ? literal : '');
      expect(file).toBe(literal);
      expect(args).toEqual(['--version']);
      return success('claude 2.1.252');
    });
    const result = await createDiscovery(mac({
      env: { SHELL: '/bin/bash' }, run, exists: async (file) => file === literal,
    })).discover();
    expect(result.engines[0].location).toBe(literal);
    expect(run).toHaveBeenCalledWith('/bin/bash', ['-lc', 'command -v -- "$1"', 'diomedes-discovery', 'claude']);
    expect(result.engines[0].disclosure.join(' ')).toContain('via login-shell');
  });

  it.each([{ code: 7, timedOut: false }, { code: null, timedOut: true }])('keeps existence but discards failed version output: %j', async (failure) => {
    const result = await createDiscovery(mac({
      exists: async (file) => file === '/opt/homebrew/bin/claude',
      run: async () => ({ stdout: '999.2.3 PRIVATE_MARKER', stderr: '', ...failure }),
    })).discover();
    expect(result.engines[0]).toMatchObject({ found: true, available: false });
    expect(result.engines[0].installedVersion).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MARKER');
  });

  it('records loopback method for a running Ollama when no binary was found', async () => {
    const fetchFixture = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes(':11434')) return new Response('', { status: 200 });
      throw new Error('offline Hermes fixture');
    });
    const result = await createDiscovery(mac({ fetch: fetchFixture as typeof fetch })).discover();
    const ollama = result.engines.find((row) => row.id === 'ollama')!;
    expect(ollama).toMatchObject({ found: true, available: false, status: 'Running' });
    expect(ollama.disclosure.join(' ')).toContain('observed on darwin via loopback');
    expect(fetchFixture.mock.calls.map(([url]) => String(url)).every((url) => url.startsWith('http://127.0.0.1:'))).toBe(true);
  });

  it('refuses native Mac RPC even when an exact protocol-version Codex is observed', async () => {
    const discovery = await createDiscovery(mac({
      exists: async (file) => file === '/opt/homebrew/bin/codex', run: async () => success('0.153.4'),
    })).discover();
    const createClient = vi.fn(async () => { throw new Error('forbidden RPC'); });
    const verifySandbox = vi.fn(async () => {});
    const statuses = await createIntegrations({ platform: 'darwin', discovery: async () => discovery, createClient, verifySandbox, fetch: offline }).getIntegrationStatuses({ refresh: true });
    expect(statuses.find((entry) => entry.id === 'codex')).toMatchObject({ found: true, available: false, enabled: false, status: 'Unsupported platform', capabilities: [] });
    expect(createClient).not.toHaveBeenCalled();
    expect(verifySandbox).not.toHaveBeenCalled();
  });

  it('records the observed method when Windows managed fallback finds a verified installation', async () => {
    const root = await temporaryRoot();
    const managed = installModule.managedBinary(root, 'claude-code');
    await fs.mkdir(path.dirname(managed), { recursive: true });
    await fs.writeFile(managed, 'fixture binary; checksum boundary independently substituted');
    const absent = await createDiscovery(mac({ platform: 'win32' })).discover();
    vi.spyOn(discoveryModule, 'createDiscovery').mockReturnValue({ installations: async () => [], discover: async () => absent });
    const verify = vi.spyOn(installModule, 'verifyManagedBinary').mockResolvedValue(undefined);
    const version = vi.fn(async () => TESTED_VERSIONS['claude-code']);
    const service = new EngineService(root, { platform: 'win32', version });
    await service.discover(true);
    expect(verify).toHaveBeenCalledWith(root, 'claude-code');
    // The runtime resolves Windows RUNNER~1 aliases before probing a file.
    const canonicalManaged = await fs.realpath(managed);
    expect(version).toHaveBeenCalledWith(canonicalManaged);
    const entry = service.integration('claude-code', false);
    expect(entry).toMatchObject({ found: true, location: canonicalManaged });
    expect(entry.disclosure.some((line) => /^Discovery: observed on win32 via /.test(line))).toBe(true);
  });
});

describe('FD01 independent real child-process probe boundary', () => {
  it('strips credential and interpreter injection variables while preserving basic lookup context', async () => {
    const blocked = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'FD01_PRIVATE_MARKER'];
    for (const key of blocked) vi.stubEnv(key, key === 'NODE_OPTIONS' ? '--require=fd01-must-not-load' : 'fixture-private-marker');
    const result = await defaultDiscoveryDeps().run(process.execPath, ['-e', `process.stdout.write(JSON.stringify({ blocked: ${JSON.stringify(blocked)}.filter(k => process.env[k] !== undefined), pathPresent: Object.keys(process.env).some(k => k.toLowerCase() === 'path') }))`]);
    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(JSON.parse(result.stdout)).toEqual({ blocked: [], pathPresent: true });
  });

  it('caps stdout and stderr from a real noisy child', async () => {
    const result = await defaultDiscoveryDeps().run(process.execPath, ['-e', 'process.stdout.write("o".repeat(32000));process.stderr.write("e".repeat(32000))']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('o'.repeat(4096));
    expect(result.stderr).toBe('e'.repeat(4096));
  });

  it('bounds a hung real child and reports a timeout rather than its plausible version', async () => {
    const started = Date.now();
    const result = await defaultDiscoveryDeps().run(process.execPath, ['-e', 'process.stdout.write("9.9.9");setInterval(()=>{},1000)']);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('9.9.9');
    expect(Date.now() - started).toBeLessThan(10000);
  }, 15000);

  it('treats an existing directory and a missing file as non-executables', async () => {
    const root = await temporaryRoot();
    const deps = defaultDiscoveryDeps();
    expect(await deps.exists(root)).toBe(false);
    expect(await deps.exists(path.join(root, 'missing'))).toBe(false);
    expect(await deps.exists(process.execPath)).toBe(true);
  });
});

interface PackageCall { dir: string; out: string; platform: string; arch: string; extraResource: string[]; [key: string]: unknown }
async function packagingFixture() {
  const root = await temporaryRoot();
  for (const folder of ['client', 'server', 'shared', 'desktop', 'fixtures/harness', 'licenses', 'resources', 'dist', 'scripts', 'node_modules/electron', '.data/native-runtime', 'cache'])
    await fs.mkdir(path.join(root, folder), { recursive: true });
  for (const file of ['desktop/main.mjs', 'desktop/app-updates.mjs', 'desktop/update-helper.mjs', 'desktop/fresh-start.mjs', 'desktop/diomedes.ico', 'desktop/service.ts', 'fixtures/harness/report-lines.txt', 'LICENSE', 'package-lock.json', 'scripts/package-desktop.mjs', 'scripts/build-desktop-auth.mjs', 'dist/index.html'])
    await fs.writeFile(path.join(root, file), `independent fixture ${file}`);
  for (const file of ['desktop/native-auth.ts', 'desktop/native-auth-preload.ts'])
    await fs.writeFile(path.join(root, file), 'export const fixture = true;');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.4' }));
  await fs.writeFile(path.join(root, 'node_modules/electron/package.json'), JSON.stringify({ version: '44.2.0' }));
  await fs.writeFile(path.join(root, 'cache/electron-v44.2.0-darwin-arm64.zip'), 'fixture only: real packager never runs');
  await fs.writeFile(path.join(root, '.data/native-runtime/codex.exe'), 'Windows poison resource');
  const build = vi.fn(async (call: { outfile: string }) => { await fs.writeFile(call.outfile, 'fixture bundle'); });
  const packager = vi.fn(async (call: PackageCall) => {
    expect(await fs.readdir(call.extraResource[0])).toEqual([]);
    const output = path.join(call.out, 'Diomedes-darwin-arm64');
    const resources = path.join(output, 'Diomedes.app/Contents/Resources');
    await fs.mkdir(resources, { recursive: true });
    await fs.copyFile(path.join(call.dir, 'BUILD_INFO.json'), path.join(resources, 'BUILD_INFO.json'));
    await fs.writeFile(path.join(resources, 'app.asar'), 'independent placeholder, not a Mac artifact');
    return [output];
  });
  const git = vi.fn((_file: string, args: string[]) => args[0] === 'rev-parse' ? '80263205133c410d590549efd1c8f40cedf33b1c' : ' M server/discovery.ts');
  return { root, options: { root, platform: 'darwin', arch: 'arm64', hostPlatform: 'win32', electronZipDir: path.join(root, 'cache') }, deps: { build, packager, git } };
}

describe('FD01 independent packaging contract (substituted packager, not Mac proof)', () => {
  it('excludes copied Windows resources and produces a verifiable, honestly unbundled manifest', async () => {
    const { root, options, deps } = await packagingFixture();
    await packageDesktop(options, deps);
    const call = deps.packager.mock.calls[0][0];
    expect(call).toMatchObject({ platform: 'darwin', arch: 'arm64', asar: true });
    for (const key of ['icon', 'win32metadata', 'osxSign', 'osxNotarize', 'asarIntegrityDigest']) expect(call).not.toHaveProperty(key);
    const output = path.join(root, 'release/Diomedes-darwin-arm64');
    const manifest = JSON.parse(await fs.readFile(`${output}.manifest.json`, 'utf8'));
    expect(manifest.nativeRuntime).toMatchObject({ bundled: false, sha256: {} });
    expect(manifest.signing).toBe('unsigned-experimental');
    expect(manifest.files.some((entry: { path: string }) => /\.exe$/i.test(entry.path))).toBe(false);
    for (const entry of manifest.files) expect(sha(await fs.readFile(path.join(output, entry.path)))).toBe(entry.sha256);
  });

  it('refuses packaging if a source input changes during bundling', async () => {
    const { root, options, deps } = await packagingFixture();
    deps.build.mockImplementation(async (call) => {
      await fs.writeFile(call.outfile, 'fixture bundle');
      await fs.writeFile(path.join(root, 'server/changed.ts'), 'changed during bundle');
    });
    await expect(packageDesktop(options, deps)).rejects.toThrow('Build inputs changed while packaging');
    expect(deps.packager).not.toHaveBeenCalled();
    expect((await fs.readdir(root)).some((name) => name.startsWith('.desktop-stage-'))).toBe(false);
  });

  it('rejects a directory disguised as the required offline archive before staging', async () => {
    const { root, options, deps } = await packagingFixture();
    const otherCache = path.join(root, 'bad-cache');
    await fs.mkdir(path.join(otherCache, 'electron-v44.2.0-darwin-arm64.zip'), { recursive: true });
    await expect(packageDesktop({ ...options, electronZipDir: otherCache }, deps)).rejects.toThrow('Missing offline Electron archive');
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.packager).not.toHaveBeenCalled();
  });

  it('preserves the default Windows hash refusal before any real packaging or network work', async () => {
    const { root, deps } = await packagingFixture();
    await expect(packageDesktop({ root, hostPlatform: 'win32', hostArch: 'x64' }, deps)).rejects.toThrow('Native runtime hash mismatch: codex.exe');
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.packager).not.toHaveBeenCalled();
  });

  it('keeps an unresolved Mac-host signing policy scoped to packaging', async () => {
    const { options, deps } = await packagingFixture();
    await expect(packageDesktop({ ...options, hostPlatform: 'darwin' }, deps)).rejects.toThrow('automatic ad-hoc Framework signing');
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.packager).not.toHaveBeenCalled();
  });
});
