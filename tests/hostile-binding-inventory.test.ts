/**
 * Hostile verification of the executable inventory (audit F01/F03, acceptance
 * rows 4, 5 and 9). These tests do not fix product code; they record what the
 * repair on feature/first-run-repair actually does with Windows paths that
 * carry shell-sensitive characters, with a user PATH read from the registry,
 * and with one candidate whose identity cannot be read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDiscovery, type DiscoveryDeps, type RunResult } from '../server/discovery.js';
import { EngineService, TESTED_VERSIONS, type FileIdentity } from '../server/engines/service.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { fixtureTextDispatch, textResponse } from './h01-fixture.js';
import type { ExternalEngine, IntegrationStatus } from '../shared/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root() {
  // The real name: a temp folder spelled as an 8.3 short path (`RUNNER~1`) is
  // not the spelling the service resolves a file to before it asks about it.
  const made = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-hostile-')));
  roots.push(made);
  return made;
}

const ok = (stdout: string): RunResult => ({ stdout, stderr: '', code: 0, timedOut: false });
const failed = (): RunResult => ({ stdout: '', stderr: '', code: 1, timedOut: false });

/**
 * One Windows computer, described entirely through the injected dependencies
 * `createDiscovery` accepts. Nothing is spawned and no registry is read.
 */
function windows(options: {
  hits?: Record<string, string[]>;
  registryPath?: RunResult;
  files?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const run = vi.fn(async (file: string, args: string[]): Promise<RunResult> => {
    if (args[0] === 'query') return options.registryPath ?? failed();
    return ok('1.18.4');
  });
  const overrides: Partial<DiscoveryDeps> = {
    platform: 'win32',
    env: options.env ?? {},
    which: async (name) => options.hits?.[name] ?? [],
    run,
    exists: async (file) => (options.files ?? []).some((f) => f.toLowerCase() === file.toLowerCase()),
    fetch: (async () => {
      throw new Error('no network in this test');
    }) as unknown as typeof globalThis.fetch,
  };
  return { discovery: createDiscovery(overrides), run };
}

describe('a Windows path with shell-sensitive characters', () => {
  it('is reported by the roster and enumerated for binding, naming the same file', async () => {
    for (const file of [
      'C:\\Tools\\A&B\\opencode.exe',
      'C:\\Tools\\50%off\\opencode.exe',
      'C:\\Tools\\up^one\\opencode.exe',
      'C:\\Tools\\hey!\\opencode.exe',
    ]) {
      const { discovery } = windows({ hits: { opencode: [file] } });
      const roster = await discovery.discover();
      const entry = roster.engines.find((row) => row.id === 'opencode')!;
      // The roster path resolves it, runs it and reads its version.
      expect(entry).toMatchObject({ found: true, location: file, installedVersion: '1.18.4' });
      // The enumeration the binding repair depends on reports it as well, so
      // the installation can be identified, digested and chosen.
      expect(await discovery.installations({ engine: 'opencode' })).toEqual([
        { engine: 'opencode', path: file, context: 'windows-native' },
      ]);
    }
  });

  it('is still refused for a Windows shim, which a shell would have to interpret', async () => {
    const { discovery } = windows({ hits: { opencode: ['C:\\Tools\\A&B\\opencode.cmd'] } });
    expect(await discovery.installations({ engine: 'opencode' })).toEqual([]);
  });

  it('leaves a native .exe enumerated when its path carries only spaces and non-ASCII', async () => {
    const file = 'C:\\Program Fïles\\ünï côde\\opencode.exe';
    const { discovery } = windows({ hits: { opencode: [file] } });
    expect(await discovery.installations({ engine: 'opencode' })).toEqual([
      { engine: 'opencode', path: file, context: 'windows-native' },
    ]);
  });
});

/**
 * The same computer, wired into the service. `identify` answers for the files
 * this computer is said to hold, the way the production path answers for a real
 * one: a real path, a size and a digest of its bytes.
 */
function serviceOver(
  discovery: ReturnType<typeof createDiscovery>,
  serviceRoot: string,
  known: Record<string, string> = {},
  engine: ExternalEngine = 'opencode',
) {
  const accountRoute = `${engine}:account`;
  const launched: string[] = [];
  const inspect = vi.fn(async () => ({
    authentication: 'signed-in' as const,
    accountRoute,
    models: [{ slug: 'm', name: 'M', description: '', efforts: [], defaultEffort: null }],
    detail: 'Checked',
  }));
  const generate = vi.fn(async (input: Parameters<typeof textResponse>[0]) =>
    textResponse(input, 'Answer', TESTED_VERSIONS[engine]),
  );
  const service = new EngineService(serviceRoot, {
    discover: async (scope) => {
      const roster = (await discovery.discover()).engines as IntegrationStatus[];
      return roster.filter((row) => !scope?.engine || row.id === scope.engine);
    },
    enumerate: (scope) => discovery.installations(scope),
    version: async () => TESTED_VERSIONS[engine],
    identify: async (file) =>
      known[file] === undefined
        ? null
        : {
            path: file,
            size: known[file].length,
            mtimeMs: 1,
            sha256: createHash('sha256').update(known[file]).digest('hex'),
          },
    verifyManaged: async () => {
      throw new Error('no private copy in this test');
    },
    buildId: () => 'test-build',
    adapter: (id, file) => {
      launched.push(file);
      return { id, contract: routeContractFor(id), inspect, generate };
    },
  });
  service.dispatch = fixtureTextDispatch(path.join(serviceRoot, 'runs'), {
    [`${engine}AccountRoute`]: accountRoute,
  }).dispatch;
  return { service, launched, generate, accountRoute };
}

describe('an installation whose folder carries a legal odd character', () => {
  it('is digested, offered for binding, and runs as the installation that was chosen', async () => {
    const file = 'C:\\Tools\\A&B\\opencode.exe';
    const { discovery } = windows({ hits: { opencode: [file] } });
    const h = serviceOver(discovery, root(), { [file]: 'the copy on this computer' });
    await h.service.discover(true);
    const value = h.service.status().find((row) => row.engine === 'opencode')!;

    expect(value.installation).toBe('found');
    expect(value.compatibility).toBe('supported');
    expect(value.location).toBe(file);
    // It is one identified candidate, with its bytes recorded, and it is what
    // the route recommends until a person chooses.
    expect(value.candidates?.length).toBe(1);
    expect(value.candidates![0]).toMatchObject({
      path: file,
      present: true,
      integrity: 'verified',
      protocol: 'passed',
      compatibility: 'supported',
    });
    expect(value.candidates![0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.recommendedCandidateId).toBe(`system:opencode:${file}`);
    expect(value.binding ?? null).toBeNull();

    // The explicit binding route reaches it by the id the host itself produced.
    const bound = await h.service.bind('opencode', `system:opencode:${file}`);
    expect(bound.binding).toMatchObject({ id: `system:opencode:${file}`, origin: 'explicit' });

    await h.service.check('opencode');
    await expect(
      h.service.generate('opencode', {
        projectId: 'p',
        threadId: 't',
        requestId: 'r',
        model: 'm',
        accountRoute: h.accountRoute,
        prompt: 'x',
        instructions: '',
        documents: [],
      }),
    ).resolves.toMatchObject({ text: 'Answer' });
    expect(h.launched).toContain(file);

    // And the action that proves the route now has something to name.
    const receipt = await h.service.testConnection('opencode', { consent: true, model: 'm' });
    expect(receipt.candidateId).toBe(`system:opencode:${file}`);
  });

  it('marks the binding broken when PATH later resolves a different file of the same name', async () => {
    const first = 'C:\\Tools\\A&B\\opencode.exe';
    const second = 'C:\\Other\\A&B\\opencode.exe';
    const hits: Record<string, string[]> = { opencode: [first] };
    const { discovery } = windows({ hits });
    const h = serviceOver(discovery, root(), {
      [first]: 'the first copy',
      [second]: 'a different copy',
    });
    await h.service.discover(true);
    await h.service.bind('opencode', `system:opencode:${first}`);
    await h.service.check('opencode');
    expect(h.service.status().find((row) => row.engine === 'opencode')!.location).toBe(first);

    // The person's PATH now resolves a different executable of the same name.
    hits.opencode = [second];
    await h.service.discover(true);
    const value = h.service.status().find((row) => row.engine === 'opencode')!;
    // The chosen installation is gone, so the route says so instead of moving.
    expect(value.repair).toBe('selected-missing');
    expect(value.binding?.path).toBe(first);
    expect(h.service.nextAction('opencode', { enabled: true, installSupported: true })).toBe(
      'choose-installation',
    );
    await expect(h.service.check('opencode')).rejects.toMatchObject({ code: 'BINDING_CHANGED' });
    expect(h.launched).not.toContain(second);
  });
});

describe('a roster hit with nothing the host could identify', () => {
  it('is never presented as a found, compatible installation', async () => {
    // The roster ran something and read a version from it; the enumeration
    // reported no installation at all. A roster row is not evidence that an
    // installation exists, can be digested, or can be chosen.
    const serviceRoot = root();
    const service = new EngineService(serviceRoot, {
      discover: async () => [
        {
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
          installedVersion: TESTED_VERSIONS.opencode,
          location: 'C:\\Tools\\opencode.exe',
          disclosure: [],
        },
      ],
      enumerate: async () => [],
      version: async () => TESTED_VERSIONS.opencode,
      identify: async () => null,
      verifyManaged: async () => {
        throw new Error('no private copy in this test');
      },
      buildId: () => 'test-build',
      adapter: (id) => ({
        id,
        contract: routeContractFor(id),
        inspect: async () => ({
          authentication: 'signed-in' as const,
          accountRoute: 'opencode:account',
          models: [],
          detail: 'Checked',
        }),
        generate: async (input) => textResponse(input, 'Answer', TESTED_VERSIONS.opencode),
      }),
    });
    await service.discover(true);
    const value = service.status().find((row) => row.engine === 'opencode')!;
    expect(value.candidates).toEqual([]);
    expect(value.compatibility).not.toBe('supported');
    expect(value.detail).not.toMatch(/Found a compatible installation/);
    expect(value.repair).toBe('no-reviewed-candidate');
    expect(service.nextAction('opencode', { enabled: true, installSupported: true })).not.toBe(
      'check-connection',
    );
    await expect(service.check('opencode')).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
  });
});

describe("the current user's PATH, read from the registry", () => {
  const registryLine = (value: string) =>
    ok(`\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    ${value}\r\n\r\n`);

  it('is read once per scan, read-only, through a fixed argument array', async () => {
    const { discovery, run } = windows({
      hits: {},
      registryPath: registryLine('C:\\late'),
      files: ['C:\\late\\opencode.exe', 'C:\\late\\claude.exe'],
      env: { SystemRoot: 'C:\\Windows' },
    });
    const found = await discovery.installations();
    expect(found).toContainEqual({
      engine: 'opencode',
      path: 'C:\\late\\opencode.exe',
      context: 'windows-native',
    });
    const queries = run.mock.calls.filter((call) => call[1][0] === 'query');
    // One read for the whole scan, and nothing a path could smuggle a command into.
    expect(queries.length).toBe(1);
    expect(queries[0][0]).toBe('C:\\Windows\\System32\\reg.exe');
    expect(queries[0][1]).toEqual(['query', 'HKCU\\Environment', '/v', 'Path']);
  });

  it('expands REG_EXPAND_SZ references and drops what it cannot resolve', async () => {
    const { discovery } = windows({
      hits: {},
      registryPath: registryLine('%LOCALAPPDATA%\\bin;%NOPE%\\bin;C:\\plain'),
      files: [
        'C:\\Users\\a\\AppData\\Local\\bin\\opencode.exe',
        'C:\\plain\\opencode.exe',
        'C:\\%NOPE%\\bin\\opencode.exe',
      ],
      env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
    });
    const paths = (await discovery.installations({ engine: 'opencode' })).map((row) => row.path);
    expect(paths).toContain('C:\\Users\\a\\AppData\\Local\\bin\\opencode.exe');
    expect(paths).toContain('C:\\plain\\opencode.exe');
    expect(paths.some((row) => row.includes('%'))).toBe(false);
  });

  it('reports nothing rather than guessing when the key is missing or the read hangs', async () => {
    for (const registryPath of [failed(), { stdout: '', stderr: '', code: null, timedOut: true }]) {
      const { discovery } = windows({
        hits: {},
        registryPath,
        files: ['C:\\late\\opencode.exe'],
        env: { SystemRoot: 'C:\\Windows' },
      });
      expect(await discovery.installations({ engine: 'opencode' })).toEqual([]);
    }
  });

  it('reads a value name and type case-insensitively, as reg.exe may print them', async () => {
    const { discovery } = windows({
      hits: {},
      registryPath: ok('\r\nHKEY_CURRENT_USER\\Environment\r\n    PATH    REG_SZ    C:\\late\r\n'),
      files: ['C:\\late\\opencode.exe'],
      env: { SystemRoot: 'C:\\Windows' },
    });
    expect((await discovery.installations({ engine: 'opencode' })).map((row) => row.path)).toEqual([
      'C:\\late\\opencode.exe',
    ]);
  });
});

describe('one candidate that cannot be examined', () => {
  it('does not hide the usable installation beside it, and leaks no path in its reason', async () => {
    const serviceRoot = root();
    const good = path.join(serviceRoot, 'good', 'opencode.exe');
    const bad = path.join(serviceRoot, 'bad', 'opencode.exe');
    fs.mkdirSync(path.dirname(good), { recursive: true });
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(good, 'reviewed bytes');
    fs.writeFileSync(bad, 'unreadable bytes');
    const identity = (file: string): FileIdentity => {
      const stat = fs.statSync(file);
      return {
        path: fs.realpathSync.native(file),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      };
    };
    const service = new EngineService(serviceRoot, {
      discover: async () => [],
      enumerate: async () => [
        { engine: 'opencode', path: bad, context: 'windows-native' },
        { engine: 'opencode', path: good, context: 'windows-native' },
      ],
      version: async () => TESTED_VERSIONS.opencode,
      identify: async (file) => {
        if (file === bad) throw new Error(`EPERM reading ${bad}`);
        return identity(file);
      },
      verifyManaged: async () => {
        throw new Error('no private copy in this test');
      },
      buildId: () => 'test-build',
      adapter: (id) => ({
        id,
        contract: routeContractFor(id),
        inspect: async () => ({
          authentication: 'signed-in' as const,
          accountRoute: 'opencode:account',
          models: [],
          detail: 'Checked',
        }),
        generate: async (input) => textResponse(input, 'Answer', TESTED_VERSIONS.opencode),
      }),
    });
    await service.discover(true);
    const value = service.status().find((row) => row.engine === 'opencode')!;
    expect(value.candidates?.length).toBe(2);
    const broken = value.candidates!.find((row) => row.path === bad)!;
    expect(broken).toMatchObject({ integrity: 'unknown', present: false });
    // The reason a person reads carries no path and no thrown message.
    expect(broken.issue).toBe('This installation could not be examined. Check this computer again.');
    expect(JSON.stringify(value.candidates)).not.toMatch(/EPERM/);
    // The usable installation beside it is still offered.
    expect(value.recommendedCandidateId).toBe(`system:opencode:${fs.realpathSync.native(good)}`);
    expect(value.installation).toBe('found');
    expect(value.compatibility).toBe('supported');
  });
});
