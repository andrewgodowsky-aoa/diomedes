/**
 * Hostile verification of the installation boundary and the private repair
 * (audit F01/F03, acceptance rows 3 and 8): a tool that only exists inside WSL
 * or inside a desktop application, and what a repair leaves behind when it
 * cannot finish.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installationContext } from '../server/discovery.js';
import { EngineService, TESTED_VERSIONS, type FileIdentity } from '../server/engines/service.js';
import { EngineInstaller, managedBinary } from '../server/engines/install.js';
import { EngineError } from '../server/engines/process.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { textResponse } from './h01-fixture.js';
import type { ExternalEngine, IntegrationStatus } from '../shared/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root() {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-hostile-'));
  roots.push(made);
  return made;
}

const rosterRow = (location: string, version?: string): IntegrationStatus => ({
  id: 'opencode',
  name: 'OpenCode',
  kind: 'online',
  found: true,
  available: false,
  enabled: false,
  status: 'Installed',
  detail: 'Found',
  capabilities: [],
  signIn: 'unknown',
  adapter: 'planned',
  ...(version ? { installedVersion: version } : {}),
  location,
  disclosure: [],
});

/** A service whose only installation is at `file`, and which cannot run it. */
function unrunnable(file: string, roster: IntegrationStatus[]) {
  const identity: FileIdentity = {
    path: file,
    size: 12,
    mtimeMs: 1,
    sha256: 'd'.repeat(64),
  };
  const inspect = vi.fn(async () => ({
    authentication: 'signed-in' as const,
    accountRoute: 'opencode:account',
    models: [{ slug: 'm', name: 'M', description: '', efforts: [], defaultEffort: null }],
    detail: 'Checked',
  }));
  const service = new EngineService(root(), {
    discover: async () => roster,
    enumerate: async () => [
      { engine: 'opencode' as ExternalEngine, path: file, context: installationContext(file, 'win32') },
    ],
    version: async () => {
      // Windows cannot execute a Linux binary or a desktop app's inner shim.
      throw new EngineError('LAUNCH_FAILED', 'This tool could not be started on this computer.');
    },
    identify: async () => identity,
    verifyManaged: async () => {
      throw new Error('no private copy in this test');
    },
    buildId: () => 'test-build',
    adapter: (id) => ({
      id,
      contract: routeContractFor(id),
      inspect,
      generate: async (input) => textResponse(input, 'Answer', TESTED_VERSIONS.opencode),
    }),
  });
  return { service, inspect };
}
const connection = (service: EngineService) =>
  service.status().find((row) => row.engine === 'opencode')!;

describe('a tool that only exists inside WSL or a desktop application', () => {
  it('is named as what it is, and is never called a usable Windows command line', () => {
    expect(installationContext('\\\\wsl$\\Ubuntu\\home\\a\\.local\\bin\\opencode', 'win32')).toBe(
      'wsl',
    );
    expect(
      installationContext('\\\\wsl.localhost\\Ubuntu\\home\\a\\.local\\bin\\opencode', 'win32'),
    ).toBe('wsl');
    expect(
      installationContext(
        'C:\\Users\\a\\AppData\\Local\\Programs\\Devin\\resources\\app\\bin\\opencode.exe',
        'win32',
      ),
    ).toBe('desktop-app');
    expect(installationContext('C:\\tools\\opencode.exe', 'win32')).toBe('windows-native');
  });

  for (const [name, file] of [
    ['a WSL path', '\\\\wsl$\\Ubuntu\\home\\a\\.local\\bin\\opencode'],
    [
      'a desktop application',
      'C:\\Users\\a\\AppData\\Local\\Programs\\Devin\\resources\\app\\bin\\opencode.exe',
    ],
  ] as const)
    it(`reports ${name} as an installation that cannot run, and claims no account for it`, async () => {
      const h = unrunnable(file, [rosterRow(file)]);
      await h.service.discover(true);
      const value = connection(h.service);
      expect(value.candidates?.length).toBe(1);
      expect(value.candidates![0]).toMatchObject({
        context: file.startsWith('\\\\wsl') ? 'wsl' : 'desktop-app',
        integrity: 'unknown',
        protocol: 'failed',
        compatibility: 'unknown',
      });
      expect(value.candidates![0].issue).toBeTruthy();
      // Nothing was signed in, no models were listed and no route was named.
      expect(value.authentication).toBe('unknown');
      expect(value.accountRoute).toBeNull();
      expect(value.models).toEqual([]);
      expect(value.recommendedCandidateId ?? null).toBeNull();
      expect(h.inspect).not.toHaveBeenCalled();
      // The offered action is a compatible copy of its own, never "sign in".
      expect(h.service.nextAction('opencode', { enabled: true, installSupported: true })).toBe(
        'repair',
      );
    });

  it('is not called compatible just because the roster read a version from it', async () => {
    const file = '\\\\wsl$\\Ubuntu\\home\\a\\.local\\bin\\opencode';
    const h = unrunnable(file, [rosterRow(file, TESTED_VERSIONS.opencode)]);
    await h.service.discover(true);
    const value = connection(h.service);
    // The candidate itself was examined and could not be started here. The
    // roster's own version reading does not overrule that: an installation is
    // found, and it is not one this route can use.
    expect(value.installation).toBe('found');
    expect(value.compatibility).not.toBe('supported');
    expect(value.repair).toBe('no-reviewed-candidate');
    expect(value.detail).not.toMatch(/Found a compatible installation/);
    // Checking it refuses before anything is launched, and says which stage.
    await expect(h.service.check('opencode')).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
      stage: 'runtime-verification',
    });
    expect(h.inspect).not.toHaveBeenCalled();
    expect(connection(h.service).authentication).toBe('unknown');
    await expect(
      h.service.bind('opencode', `system:opencode:${file}`),
    ).rejects.toMatchObject({ code: 'CANDIDATE_UNUSABLE' });
  });
});

describe('a private repair that could not finish', () => {
  async function repairAgainstAFailingSource() {
    const serviceRoot = root();
    const theirs = path.join(root(), 'their own', 'omp.exe');
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, 'the copy they installed themselves');
    const before = fs.statSync(theirs);
    const destination = managedBinary(serviceRoot, 'oh-my-pi');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'a private copy whose bytes no longer match');
    const installer = new EngineInstaller(serviceRoot, {
      fetch: vi.fn<typeof fetch>(async () => new Response('not the pinned release')),
      platform: 'win32',
      arch: 'x64',
    });
    await expect(
      installer.install('oh-my-pi', true, undefined, { repair: true }),
    ).rejects.toMatchObject({ code: 'INSTALL_CHECKSUM' });
    return { serviceRoot, theirs, before, destination };
  }

  it('sets the failed copy aside inside its own folder and never touches the person\u2019s own', async () => {
    const h = await repairAgainstAFailingSource();
    const folder = path.dirname(h.destination);
    const kept = fs.readdirSync(folder);
    expect(kept.length).toBe(1);
    const [quarantined] = kept;
    // Inside Diomedes's own installed/ tree, under the destination's own name.
    expect(quarantined.startsWith(`${path.basename(h.destination)}.quarantined-`)).toBe(true);
    expect(path.resolve(folder, quarantined).startsWith(path.resolve(h.serviceRoot, 'installed'))).toBe(
      true,
    );
    expect(quarantined).not.toMatch(/[\\/:]/);
    // Nothing was left half-written at the destination.
    expect(fs.existsSync(h.destination)).toBe(false);
    // Their own installation is untouched, to the byte and to the timestamp.
    expect(fs.readFileSync(h.theirs, 'utf8')).toBe('the copy they installed themselves');
    expect(fs.statSync(h.theirs).mtimeMs).toBe(h.before.mtimeMs);
    // No download staging survives the attempt.
    expect(fs.readdirSync(path.join(h.serviceRoot, 'installed')).sort()).toEqual(['oh-my-pi']);
  });

  it('leaves an explicit install state, and never offers the quarantined copy as a candidate', async () => {
    const h = await repairAgainstAFailingSource();
    const service = new EngineService(h.serviceRoot, {
      discover: async () => [],
      enumerate: async () => [],
      version: async () => TESTED_VERSIONS['oh-my-pi'],
      buildId: () => 'test-build',
      adapter: (id) => ({
        id,
        contract: routeContractFor(id),
        inspect: async () => ({
          authentication: 'signed-in' as const,
          accountRoute: 'omp:account',
          models: [],
          detail: 'Checked',
        }),
        generate: async (input) => textResponse(input, 'Answer', TESTED_VERSIONS['oh-my-pi']),
      }),
    });
    await service.discover(true);
    const value = service.status().find((row) => row.engine === 'oh-my-pi')!;
    expect(value.candidates).toEqual([]);
    expect(value.installation).toBe('missing');
    expect(value.repair).toBe('no-reviewed-candidate');
    expect(service.nextAction('oh-my-pi', { enabled: true, installSupported: true })).toBe(
      'install',
    );
    await expect(service.check('oh-my-pi')).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
    // The quarantined bytes are still on disk, and still not an installation.
    expect(fs.readdirSync(path.dirname(h.destination)).length).toBe(1);
    await fsp.access(path.dirname(h.destination));
  });
});
