import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDiscovery, defaultDiscoveryDeps, type DiscoveryDeps } from '../server/discovery.js';
import { createIntegrations } from '../server/integrations.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import * as discoveryModule from '../server/discovery.js';
import { managedBinary } from '../server/engines/install.js';
import * as installModule from '../server/engines/install.js';

const ok = (stdout = '') => ({ stdout, stderr: '', code: 0, timedOut: false });
const offline = (async () => {
  throw new Error('offline fixture');
}) as typeof fetch;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function mac(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    platform: 'darwin',
    env: { HOME: '/Users/fixture', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    which: async () => [],
    exists: async () => false,
    run: async () => ok(),
    fetch: offline,
    ...overrides,
  };
}

describe('FD01 observed macOS discovery through existing consumers', () => {
  it('does not claim a managed observation when its pinned artifact fails verification', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fd01-managed-refusal-'));
    roots.push(root);
    const binary = managedBinary(root, 'claude-code');
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, 'unverified fixture');
    const absent = await createDiscovery(mac({ platform: 'win32' })).discover();
    vi.spyOn(discoveryModule, 'createDiscovery').mockReturnValue({ installations: async () => [], discover: async () => absent });
    vi.spyOn(installModule, 'verifyManagedBinary').mockRejectedValue(new Error('Checksum differs'));
    const version = vi.fn(async () => TESTED_VERSIONS['claude-code']);
    const service = new EngineService(root, { platform: 'win32', version });

    // Current discovery isolates a failed candidate and keeps the other routes
    // visible. A failed managed digest must still prevent its version probe.
    const statuses = await service.discover(true);
    expect(statuses.find((row) => row.engine === 'claude-code')?.candidates).toEqual([
      expect.objectContaining({ integrity: 'failed', protocol: 'unknown', compatibility: 'unknown' }),
    ]);
    expect(version).not.toHaveBeenCalled();
    const entry = service.integration('claude-code', false);
    expect(entry.found).toBe(false);
    expect(entry.disclosure.join(' ')).not.toContain('via managed-installation');
  });

  it('finds Homebrew binaries from a Finder-like PATH and records the method', async () => {
    const run = vi.fn(async () => ok(`claude ${TESTED_VERSIONS['claude-code']}`));
    const result = await createDiscovery(
      mac({
        exists: async (file) => file === '/opt/homebrew/bin/claude',
        run,
      }),
    ).discover();
    expect(result.engines.find((row) => row.id === 'claude-code')).toMatchObject({
      found: true,
      available: false,
      location: '/opt/homebrew/bin/claude',
      installedVersion: TESTED_VERSIONS['claude-code'],
    });
    expect(result.engines.find((row) => row.id === 'claude-code')?.disclosure.join(' ')).toContain(
      'observed on darwin via explicit-location',
    );
    expect(run).toHaveBeenCalledWith('/opt/homebrew/bin/claude', ['--version']);
  });

  it('uses fixed positional login-shell lookup for a version-manager installation', async () => {
    const binary = '/Users/fixture/Library/Application Support/node/bin/omp';
    const run = vi.fn(async (file: string, args: string[]) => {
      if (file === '/bin/zsh') return ok(args.at(-1) === 'omp' ? `${binary}\n` : '');
      expect(file).toBe(binary);
      expect(args).toEqual(['--version']);
      return ok('omp 18.0.6');
    });
    const result = await createDiscovery(
      mac({ exists: async (file) => file === binary, run }),
    ).discover();
    expect(result.engines.find((row) => row.id === 'oh-my-pi')).toMatchObject({
      found: true,
      location: binary,
      installedVersion: '18.0.6',
    });
    expect(run).toHaveBeenCalledWith('/bin/zsh', [
      '-lc',
      'command -v -- "$1"',
      'diomedes-discovery',
      'omp',
    ]);
    expect(result.engines.find((row) => row.id === 'oh-my-pi')?.disclosure.join(' ')).toContain(
      'observed on darwin via login-shell',
    );
  });

  it.each([
    'alias omp="curl https://invalid.test"',
    '/tmp/omp\n/tmp/unrelated',
    'C:\\tools\\omp.exe',
    '/tmp/omp.exe',
    '$(touch /tmp/no)',
    '/tmp/omp\u0000hidden',
  ])('does not execute untrusted resolver output %j', async (stdout) => {
    const run = vi.fn(async (_file: string) => ok(stdout));
    const result = await createDiscovery(mac({ run, which: async () => [stdout] })).discover();
    expect(result.engines.find((row) => row.id === 'oh-my-pi')?.found).toBe(false);
    expect(run.mock.calls.every(([file]) => file === '/bin/zsh')).toBe(true);
  });

  it('ignores Windows environment and arbitrary shell executables on a Mac', async () => {
    const checked: string[] = [];
    const run = vi.fn(async (_file: string) => ok());
    const result = await createDiscovery(
      mac({
        env: {
          HOME: '/Users/fixture',
          USERPROFILE: 'C:\\Users\\fixture',
          LOCALAPPDATA: 'C:\\Local',
          APPDATA: 'C:\\Roaming',
          SHELL: '/tmp/shell;bad',
        },
        exists: async (file) => {
          checked.push(file);
          return false;
        },
        run,
      }),
    ).discover();
    expect(checked.every((file) => file.startsWith('/') && !/\.exe$|\.cmd$|\\/.test(file))).toBe(
      true,
    );
    expect(run.mock.calls.every(([file]) => file === '/bin/zsh')).toBe(true);
    expect(result.engines.find((row) => row.id === 'claude-code')?.disclosure.join(' ')).toContain(
      'absent on darwin',
    );
  });

  it('does not accept a version printed by a failed executable', async () => {
    const result = await createDiscovery(
      mac({
        which: async (name) => (name === 'claude' ? ['/opt/homebrew/bin/claude'] : []),
        exists: async (file) => file === '/opt/homebrew/bin/claude',
        run: async () => ({ ...ok('error 2.1.252 SECRET_MARKER'), code: 1 }),
      }),
    ).discover();
    const entry = result.engines.find((row) => row.id === 'claude-code');
    expect(entry).toMatchObject({ found: true, available: false });
    expect(entry?.installedVersion).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
  });

  it('continues to explicit locations after an inaccessible PATH result', async () => {
    const result = await createDiscovery(
      mac({
        which: async (name) => (name === 'claude' ? ['/unreadable/claude'] : []),
        exists: async (file) => {
          if (file === '/unreadable/claude') throw new Error('EACCES');
          return file === '/opt/homebrew/bin/claude';
        },
        run: async () => ok('claude 2.1.252'),
      }),
    ).discover();
    expect(result.engines.find((row) => row.id === 'claude-code')?.location).toBe(
      '/opt/homebrew/bin/claude',
    );
  });

  it('reports timeout absence without retaining shell output and records loopback probes', async () => {
    const result = await createDiscovery(
      mac({
        run: async () => ({
          ...ok('/opt/homebrew/bin/claude SECRET_MARKER'),
          timedOut: true,
        }),
      }),
    ).discover();
    expect(result.engines.every((row) => !row.found && !row.available)).toBe(true);
    expect(
      result.engines.every((row) =>
        row.disclosure.some((line) => line.startsWith('Discovery: absent on darwin via ')),
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
  });

  it('reports an unsupported discovery platform without spawning a shell or binary', async () => {
    const run = vi.fn(async () => ok());
    const which = vi.fn(async () => []);
    const result = await createDiscovery(mac({ platform: 'aix', run, which })).discover();
    expect(result.engines.find((row) => row.id === 'claude-code')).toMatchObject({
      found: false,
      available: false,
      status: 'Unsupported platform',
    });
    expect(run).not.toHaveBeenCalled();
    expect(which).not.toHaveBeenCalled();
  });

  it('carries the resolved native file and discovery evidence into engine preflight', async () => {
    const result = await createDiscovery(
      mac({
        exists: async (file) => file === '/opt/homebrew/bin/claude',
        run: async () => ok(`claude ${TESTED_VERSIONS['claude-code']}`),
      }),
    ).discover();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fd01-engines-'));
    roots.push(root);
    const adapter = vi.fn(() => ({
      id: 'claude-code' as const,
      contract: routeContractFor('claude-code'),
      inspect: async () => ({
        authentication: 'unknown' as const,
        accountRoute: null,
        models: [],
        detail: 'Fixture; no sign-in attempted.',
      }),
      generate: vi.fn(),
    }));
    const service = new EngineService(root, {
      discover: async () => result.engines,
      version: async () => TESTED_VERSIONS['claude-code'],
      adapter,
    });
    await service.discover(true);
    await service.check('claude-code');
    expect(adapter).toHaveBeenCalledWith(
      'claude-code',
      '/opt/homebrew/bin/claude',
      expect.any(String),
    );
    expect(service.integration('claude-code', false).disclosure.join(' ')).toContain(
      'observed on darwin via explicit-location',
    );
  });

  it('reports installed Codex on macOS but refuses unproved native isolation before RPC', async () => {
    const discovery = await createDiscovery(
      mac({
        exists: async (file) => file === '/opt/homebrew/bin/codex',
        run: async () => ok('codex-cli 0.153.4'),
      }),
    ).discover();
    const createClient = vi.fn(async () => {
      throw new Error('RPC must not start');
    });
    const integrations = createIntegrations({
      platform: 'darwin',
      createClient,
      discovery: async () => discovery,
      fetch: offline,
    });
    const statuses = await integrations.getIntegrationStatuses({ refresh: true });
    expect(statuses.find((row) => row.id === 'codex')).toMatchObject({
      found: true,
      available: false,
      status: 'Unsupported platform',
      location: '/opt/homebrew/bin/codex',
      installedVersion: '0.153.4',
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('does not reuse a Windows managed installation during native Mac discovery', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fd01-managed-'));
    roots.push(root);
    const windowsFile = managedBinary(root, 'claude-code');
    await fs.mkdir(path.dirname(windowsFile), { recursive: true });
    await fs.writeFile(windowsFile, 'A Windows artifact copied from another machine');
    vi.spyOn(discoveryModule, 'createDiscovery').mockReturnValue({
      installations: async () => [],
      discover: async () => ({ engines: [] }),
    });
    const version = vi.fn(async () => TESTED_VERSIONS['claude-code']);
    const service = new EngineService(root, { platform: 'darwin', version });
    const statuses = await service.discover(true);
    expect(statuses.find((row) => row.engine === 'claude-code')?.installation).toBe('missing');
    expect(version).not.toHaveBeenCalled();
  });

  it('does not pass provider credentials or Node injection options to version probes', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fd01-fixture-secret');
    vi.stubEnv('FD01_PRIVATE_MARKER', 'fd01-fixture-secret');
    const result = await defaultDiscoveryDeps().run(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify([process.env.OPENAI_API_KEY,process.env.FD01_PRIVATE_MARKER]))',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('[null,null]');
  });
});
