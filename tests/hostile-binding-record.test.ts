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
  // The real name: a temp folder spelled as an 8.3 short path (`RUNNER~1`) is
  // not the spelling the service resolves a file to before it asks about it.
  const made = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-hostile-')));
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
    it(`is a repair state when ${name}, and nothing binds another executable in its place`, async () => {
      const h = await damaged(write);
      await h.service.discover(true);
      const before = connection(h.service);
      // A record this build cannot read is not "they never chose one". The
      // route says a choice exists and cannot be read, and offers the one way
      // out: choosing an installation again.
      expect(before.binding ?? null).toBeNull();
      expect(before.repair).toBe('record-unreadable');
      expect(h.service.nextAction('opencode', { enabled: true, installSupported: true })).toBe(
        'choose-installation',
      );

      await expect(h.service.check('opencode')).rejects.toMatchObject({
        code: 'BINDING_CHANGED',
        stage: 'runtime-verification',
      });
      await expect(h.service.generate('opencode', ask(h.accountRoute))).rejects.toMatchObject({
        code: 'BINDING_CHANGED',
      });
      await expect(
        h.service.testConnection('opencode', { consent: true, model: 'm' }),
      ).rejects.toMatchObject({ code: 'BINDING_CHANGED' });

      const after = connection(h.service);
      expect(after.binding ?? null).toBeNull();
      expect(h.launched).toEqual([]);
      expect(h.generate).not.toHaveBeenCalled();
      // The record a newer build may have written is still on disk, untouched.
      expect(fs.existsSync(bindingsFile(h.serviceRoot))).toBe(true);
    });

  it('is settled only by a person choosing again, which sets the unreadable record aside', async () => {
    const damage = '{ not json';
    const h = await damaged((file) => fs.writeFileSync(file, damage));
    await h.service.discover(true);
    const candidate = connection(h.service).candidates!.find((row) => row.source === 'system')!;
    await h.service.bind('opencode', candidate.id);

    const after = connection(h.service);
    expect(after.repair ?? null).toBeNull();
    expect(after.binding).toMatchObject({ id: candidate.id, origin: 'explicit' });
    // The unreadable bytes are kept beside the new record rather than deleted,
    // so a record a newer build wrote is never destroyed to make room.
    const kept = fs
      .readdirSync(h.serviceRoot)
      .filter((name) => name.startsWith('bindings.json.unreadable-'));
    expect(kept.length).toBe(1);
    expect(fs.readFileSync(path.join(h.serviceRoot, kept[0]), 'utf8')).toBe(damage);
    expect(JSON.parse(fs.readFileSync(bindingsFile(h.serviceRoot), 'utf8'))).toMatchObject({
      engines: { opencode: { binding: { id: candidate.id } } },
    });

    // And the route works from there: checked, tested, and the receipt names
    // the installation the person actually chose.
    await h.service.check('opencode');
    const receipt = await h.service.testConnection('opencode', { consent: true, model: 'm' });
    expect(receipt.candidateId).toBe(candidate.id);
  });

  it('refuses a connection test rather than binding the recommendation for them', async () => {
    const h = await damaged((file) => fs.writeFileSync(file, '{ not json'));
    await h.service.discover(true);
    // Pressing Test connection settles the selection first. Settling it must
    // not turn a recommendation into a choice the person never made.
    await expect(
      h.service.testConnection('opencode', { consent: true, model: 'm' }),
    ).rejects.toMatchObject({ code: 'BINDING_CHANGED', stage: 'runtime-verification' });
    const after = connection(h.service);
    expect(after.binding ?? null).toBeNull();
    expect(after.verification ?? null).toBeNull();
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('leaves the routes whose rows were in the same damaged document in repair too', async () => {
    // The document could not be parsed, so which routes it named is unknown.
    // Reading "no row for claude-code" out of bytes this build cannot read
    // would be the same guess by another name.
    const h = await damaged((file) => fs.writeFileSync(file, '{ not json'));
    await h.service.discover(true);
    for (const engine of ['opencode', 'claude-code', 'cursor'] as const)
      expect(h.service.status().find((row) => row.engine === engine)!.repair).toBe(
        'record-unreadable',
      );
  });

  it('stops refusing the route once the record can be read again, without a restart', async () => {
    // A scan or a backup holding the record open while Diomedes starts is a
    // fact about that moment and about nothing else. It used to wedge all five
    // routes until the application was restarted, because the record was never
    // read again; now the next look at this computer reads it.
    const serviceRoot = root();
    const theirs = place(path.join(root(), 'chosen', 'opencode.exe'), 'the copy they picked');
    const first = host({ system: [{ file: theirs }], service: serviceRoot });
    await first.service.discover(true);
    const chosen = connection(first.service).recommendedCandidateId!;
    await first.service.bind('opencode', chosen);
    first.service.close();

    const file = bindingsFile(serviceRoot);
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target: unknown, ...rest: unknown[]) => {
      if (String(target) === file)
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return (real as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readFileSync);
    const second = host({ system: [{ file: theirs }], service: serviceRoot });
    for (const engine of ['opencode', 'claude-code'] as const)
      expect(second.service.status().find((row) => row.engine === engine)!.repair).toBe(
        'record-unreadable',
      );
    vi.restoreAllMocks();

    await second.service.discover(true);
    const value = connection(second.service);
    expect(value.repair ?? null).toBeNull();
    expect(value.binding).toMatchObject({ id: chosen, origin: 'explicit' });
    // The other four routes stop claiming a record nobody can read too. What
    // they report instead is whatever this computer actually holds for them.
    expect(
      second.service.status().find((row) => row.engine === 'claude-code')!.repair ?? null,
    ).not.toBe('record-unreadable');
    // And the route runs on the choice that was there all along.
    await second.service.check('opencode');
    await expect(
      second.service.generate('opencode', ask(second.accountRoute)),
    ).resolves.toMatchObject({ text: 'Answer' });
    // The record was never moved aside: nothing about it was ever damaged.
    expect(fs.readdirSync(serviceRoot).filter((name) => name.startsWith('bindings.json.'))).toEqual(
      [],
    );
  });

  it('does not rewrite or move the record for a revision a check merely observed', async () => {
    // A binding is written by an explicit choice, by settling a selection that
    // had no record, or by the one-time adoption — never by a check. While any
    // part of the record cannot be read, writing one would file the bytes of
    // somebody's other choice away on nobody's say-so.
    const serviceRoot = root();
    const theirs = place(path.join(root(), 'chosen', 'opencode.exe'), 'the copy they picked');
    const first = host({ system: [{ file: theirs }], service: serviceRoot });
    await first.service.discover(true);
    const chosen = connection(first.service).recommendedCandidateId!;
    await first.service.bind('opencode', chosen);
    first.service.close();

    // Another route's row arrives in a shape this build does not read.
    const file = bindingsFile(serviceRoot);
    const document = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      engines: Record<string, unknown>;
    };
    document.engines['claude-code'] = 'written by something else';
    fs.writeFileSync(file, JSON.stringify(document));
    const written = fs.readFileSync(file, 'utf8');

    const second = host({ system: [{ file: theirs }], service: serviceRoot });
    await second.service.discover(true);
    const before = connection(second.service).revision!;
    // The check learns the account route for the first time, which is exactly
    // what moves the revision.
    await second.service.check('opencode');
    expect(connection(second.service).revision).toBe(before + 1);
    expect(
      second.service.status().find((row) => row.engine === 'claude-code')!.repair,
    ).toBe('record-unreadable');
    // Nothing was written and nothing was filed away.
    expect(fs.readFileSync(file, 'utf8')).toBe(written);
    expect(fs.readdirSync(serviceRoot).filter((name) => name.startsWith('bindings.json.'))).toEqual(
      [],
    );
    // A second check observes the same route and the same model, so it moves
    // nothing: what is held is compared exactly as a written row would be.
    await second.service.check('opencode');
    expect(connection(second.service).revision).toBe(before + 1);

    // The next explicit choice writes the record, and carries the revision the
    // check observed with it.
    await second.service.bind('opencode', chosen);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      engines: Record<string, { revision: number }>;
      unreadable?: string[];
    };
    expect(saved.engines.opencode.revision).toBe(before + 1);
    expect(saved.unreadable).toContain('claude-code');
    const kept = fs.readdirSync(serviceRoot).filter((name) => name.startsWith('bindings.json.'));
    expect(kept.length).toBe(1);
    expect(fs.readFileSync(path.join(serviceRoot, kept[0]), 'utf8')).toBe(written);
  });

  it('reads a route with no row of its own in an intact document as never chosen', async () => {
    const h = await damaged(() => {});
    await h.service.discover(true);
    const other = h.service.status().find((row) => row.engine === 'claude-code')!;
    expect(other.binding ?? null).toBeNull();
    expect(other.repair ?? null).not.toBe('record-unreadable');
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
