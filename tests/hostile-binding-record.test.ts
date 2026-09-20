/**
 * Hostile verification of the explicit binding record (audit F01, acceptance
 * row 2). What happens when `bindings.json` is damaged, carries a hostile value,
 * or names something this computer no longer offers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { managedBinary } from '../server/engines/install.js';
import { EngineError } from '../server/engines/process.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { fixtureTextDispatch, textResponse } from './h01-fixture.js';
import type { DiscoveredInstallation } from '../server/discovery.js';
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
function place(file: string, bytes: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

interface HostOptions {
  system?: { file: string; version?: string }[];
  managed?: { bytes: string; verifies: boolean };
  service?: string;
}

/**
 * One EngineService over real files, with the production identification path
 * (realpath, stat, digest) intact. Only the reviewed digest check and the
 * adapter are supplied, and every executable the adapter is built for is
 * recorded so a switch is visible.
 */
function host(options: HostOptions = {}) {
  const engine: ExternalEngine = 'opencode';
  const serviceRoot = options.service ?? root();
  const versions = new Map<string, string>();
  const rows: IntegrationStatus[] = [];
  const installations: DiscoveredInstallation[] = [];
  for (const row of options.system ?? []) {
    const version = row.version ?? TESTED_VERSIONS[engine];
    versions.set(path.resolve(row.file), version);
    rows.push({
      id: engine,
      name: engine,
      kind: 'online',
      found: true,
      available: false,
      enabled: false,
      status: 'Installed',
      detail: 'Found',
      capabilities: [],
      signIn: 'unknown',
      adapter: 'planned',
      installedVersion: version,
      location: row.file,
      disclosure: [],
    });
    installations.push({ engine, path: row.file, context: 'windows-native' });
  }
  let managed: string | undefined;
  if (options.managed) {
    managed = place(managedBinary(serviceRoot, engine), options.managed.bytes);
    versions.set(path.resolve(managed), TESTED_VERSIONS[engine]);
  }
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
  const version = vi.fn(async (file: string) => {
    const known = versions.get(path.resolve(file));
    if (!known)
      throw new EngineError('VERSION_UNKNOWN', 'The installed version could not be verified.');
    return known;
  });
  const verifyManaged = vi.fn(async () => {
    if (options.managed && !options.managed.verifies)
      throw new EngineError('INSTALL_CHECKSUM', 'The managed executable changed. It was not launched.');
  });
  const enumerate = vi.fn(async (scope?: { engine?: ExternalEngine }) =>
    installations.filter((row) => !scope?.engine || row.engine === scope.engine),
  );
  const discover = vi.fn(async (scope?: { engine?: ExternalEngine }) =>
    rows.filter((row) => !scope?.engine || row.id === scope.engine),
  );
  const service = new EngineService(serviceRoot, {
    discover,
    enumerate,
    version,
    verifyManaged,
    buildId: () => 'test-build',
    adapter: (id, file) => {
      launched.push(path.resolve(file));
      return { id, contract: routeContractFor(id), inspect, generate };
    },
  });
  service.dispatch = fixtureTextDispatch(path.join(serviceRoot, 'runs'), {
    [`${engine}AccountRoute`]: accountRoute,
  }).dispatch;
  return { service, serviceRoot, engine, accountRoute, managed, version, launched, generate };
}

const connection = (service: EngineService) =>
  service.status().find((row) => row.engine === 'opencode')!;
const ask = (accountRoute: string, requestId = 'r') => ({
  projectId: 'p',
  threadId: 't',
  requestId,
  model: 'm',
  accountRoute,
  prompt: 'x',
  instructions: '',
  documents: [],
});
const bindingsFile = (serviceRoot: string) => path.join(serviceRoot, 'bindings.json');
const writeRecord = (serviceRoot: string, row: unknown) =>
  fs.writeFileSync(
    bindingsFile(serviceRoot),
    JSON.stringify({ version: 1, engines: { opencode: row } }),
  );

describe('a damaged binding record', () => {
  /** Bind a person's own installation, then damage the file that remembers it. */
  async function damaged(write: (file: string) => void) {
    const serviceRoot = root();
    const theirs = place(path.join(root(), 'chosen', 'opencode.exe'), 'the copy they picked');
    const first = host({ system: [{ file: theirs }], service: serviceRoot });
    await first.service.discover(true);
    const chosen = connection(first.service).recommendedCandidateId!;
    await first.service.bind('opencode', chosen);
    expect(connection(first.service).binding?.id).toBe(chosen);
    first.service.close();
    write(bindingsFile(serviceRoot));
    // Restart, with Diomedes's own private copy now present beside theirs.
    const second = host({
      system: [{ file: theirs }],
      managed: { bytes: 'reviewed release bytes', verifies: true },
      service: serviceRoot,
    });
    return { ...second, theirs, chosen };
  }

  const damage: [string, (file: string) => void][] = [
    ['unparseable', (file) => fs.writeFileSync(file, '{ "engines": { "opencode": ')],
    ['truncated to nothing', (file) => fs.writeFileSync(file, '')],
    [
      'written in a shape this build does not read',
      (file) =>
        fs.writeFileSync(
          file,
          JSON.stringify({ version: 2, bindings: [{ engine: 'opencode', id: 'x' }] }),
        ),
    ],
    [
      'carrying a source this build does not know',
      (file) => {
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        stored.engines.opencode.binding.source = 'imported';
        fs.writeFileSync(file, JSON.stringify(stored));
      },
    ],
  ];

  for (const [name, write] of damage)
    it(`is read as "never chose one" when ${name}, and the next request binds a different executable`, async () => {
      const h = await damaged(write);
      await h.service.discover(true);
      const before = connection(h.service);
      // Nothing says a choice was lost: no binding, no repair, no warning.
      expect(before.binding ?? null).toBeNull();
      expect(before.repair ?? null).toBeNull();
      expect(h.service.nextAction('opencode', { enabled: true, installSupported: true })).toBe(
        'check-connection',
      );

      await h.service.check('opencode');
      await expect(h.service.generate('opencode', ask(h.accountRoute))).resolves.toMatchObject({
        text: 'Answer',
      });

      const after = connection(h.service);
      // The route silently adopted Diomedes's own copy in place of the
      // installation the person chose, and nothing was ever offered to repair.
      expect(after.binding).toMatchObject({ origin: 'adopted', source: 'managed' });
      expect(after.binding!.id).not.toBe(h.chosen);
      expect(after.binding!.path).toBe(fs.realpathSync.native(h.managed!));
      expect(h.launched).toContain(path.resolve(fs.realpathSync.native(h.managed!)));
      expect(h.launched).not.toContain(path.resolve(h.theirs));
    });

  it('is repaired by a connection test into a choice the person never made', async () => {
    const h = await damaged((file) => fs.writeFileSync(file, '{ not json'));
    await h.service.discover(true);
    await h.service.check('opencode');
    // Pressing Test connection settles the selection first, and settling it
    // binds the recommended installation as an explicit choice.
    await expect(
      h.service.testConnection('opencode', { consent: true, model: 'm' }),
    ).resolves.toMatchObject({ engine: 'opencode' });
    const after = connection(h.service);
    expect(after.binding).toMatchObject({ origin: 'explicit', source: 'managed' });
    expect(after.binding!.id).not.toBe(h.chosen);
    // And the receipt now reads as proof of a route the person did not pick.
    expect(after.verification).toMatchObject({ candidateId: after.binding!.id });
  });

  it('still reloads an intact record, so the damage above is the only difference', async () => {
    const h = await damaged(() => {});
    await h.service.discover(true);
    const value = connection(h.service);
    expect(value.binding).toMatchObject({ id: h.chosen, origin: 'explicit', source: 'system' });
    await h.service.check('opencode');
    await expect(h.service.generate('opencode', ask(h.accountRoute))).resolves.toMatchObject({
      text: 'Answer',
    });
    expect(h.launched).toContain(path.resolve(fs.realpathSync.native(h.theirs)));
    expect(h.launched).not.toContain(path.resolve(fs.realpathSync.native(h.managed!)));
  });
});

describe('a hostile value in the binding record', () => {
  const hostile: [string, string][] = [
    ['a UNC path', '\\\\attacker\\share\\opencode.exe'],
    ['a traversal', 'C:\\chosen\\..\\..\\Windows\\System32\\cmd.exe'],
    ['a Windows shim', 'C:\\chosen\\opencode.cmd'],
    ['a path with a shell separator', 'C:\\chosen\\opencode.exe" & calc.exe'],
  ];

  for (const [name, file] of hostile)
    it(`refuses ${name} rather than resolving it, and never runs it`, async () => {
      const serviceRoot = root();
      const theirs = place(path.join(root(), 'chosen', 'opencode.exe'), 'the copy they picked');
      writeRecord(serviceRoot, {
        binding: {
          id: `system:opencode:${file}`,
          engine: 'opencode',
          source: 'system',
          path: file,
          version: TESTED_VERSIONS.opencode,
          sha256: 'a'.repeat(64),
          boundAt: '2026-09-20T00:00:00.000Z',
          origin: 'explicit',
        },
        revision: 4,
        key: 'k',
        model: 'm',
      });
      const h = host({ system: [{ file: theirs }], service: serviceRoot });
      await h.service.discover(true);
      const value = connection(h.service);
      expect(value.repair).toBe('selected-missing');
      // The record is kept, so the person is told what broke; it is not run.
      expect(value.binding?.path).toBe(file);
      await expect(h.service.check('opencode')).rejects.toMatchObject({
        code: 'BINDING_CHANGED',
        stage: 'runtime-verification',
      });
      await expect(h.service.generate('opencode', ask(h.accountRoute))).rejects.toMatchObject({
        code: 'BINDING_CHANGED',
      });
      for (const call of h.version.mock.calls) expect(call[0]).not.toBe(file);
      expect(h.launched.some((row) => row.includes('cmd.exe') || row.includes('attacker'))).toBe(
        false,
      );
      expect(h.generate).not.toHaveBeenCalled();
    });

  it('refuses a record whose id names this computer\u2019s file but whose identity does not match', async () => {
    const serviceRoot = root();
    const theirs = place(path.join(root(), 'chosen', 'opencode.exe'), 'the copy they picked');
    const real = fs.realpathSync.native(theirs);
    writeRecord(serviceRoot, {
      binding: {
        id: `system:opencode:${real}`,
        engine: 'opencode',
        source: 'system',
        path: 'C:\\somewhere\\else\\opencode.exe',
        version: TESTED_VERSIONS.opencode,
        sha256: 'b'.repeat(64),
        boundAt: '2026-09-20T00:00:00.000Z',
        origin: 'explicit',
      },
      revision: 4,
      key: 'k',
      model: 'm',
    });
    const h = host({ system: [{ file: theirs }], service: serviceRoot });
    await h.service.discover(true);
    expect(connection(h.service).repair).toBe('selected-changed');
    await expect(h.service.check('opencode')).rejects.toMatchObject({ code: 'BINDING_CHANGED' });
  });

  it('ignores a row filed under an engine it does not name, and binds nothing in its place', async () => {
    const serviceRoot = root();
    const theirs = place(path.join(root(), 'chosen', 'opencode.exe'), 'the copy they picked');
    writeRecord(serviceRoot, {
      binding: {
        id: 'system:claude-code:C:\\x\\claude.exe',
        engine: 'claude-code',
        source: 'system',
        path: 'C:\\x\\claude.exe',
        version: '2.1.252',
        sha256: 'c'.repeat(64),
        boundAt: '2026-09-20T00:00:00.000Z',
        origin: 'explicit',
      },
      revision: 4,
      key: 'k',
      model: 'm',
    });
    const h = host({ system: [{ file: theirs }], service: serviceRoot });
    await h.service.discover(true);
    expect(connection(h.service).binding ?? null).toBeNull();
    expect(h.service.status().find((row) => row.engine === 'claude-code')!.binding ?? null).toBeNull();
  });
});
