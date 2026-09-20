import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BindingStore, RENAME_RETRY_BUDGET_MS } from '../server/engines/binding-store.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { managedBinary } from '../server/engines/install.js';
import { EngineError } from '../server/engines/process.js';
import type { DiscoveredInstallation } from '../server/discovery.js';
import type { ExternalEngine, IntegrationStatus } from '../shared/types.js';
import type { EngineBinding } from '../shared/engines.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { fixtureTextDispatch, textResponse } from './h01-fixture.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root() {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-binding-'));
  roots.push(made);
  return made;
}
const digestOf = (file: string) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Write a real file this computer can resolve, stat and hash. */
function place(file: string, bytes: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

interface HostOptions {
  engine?: ExternalEngine;
  /** Installations the person put on this computer themselves. */
  system?: { file: string; version?: string }[];
  /** The private copy Diomedes installed, and whether its bytes still verify. */
  managed?: { bytes: string; verifies: boolean; version?: string };
  /** A second engine, to prove one engine's failure never hides another. */
  other?: { engine: ExternalEngine; file: string };
  service?: string;
  /** Make the roster call fail while this answers true. */
  failDiscoverWhile?: () => boolean;
}

/**
 * One EngineService over real files on this computer: the production
 * identification path resolves, stats and hashes them. Only the reviewed
 * digest check and the adapter are supplied, because a test cannot hold the
 * pinned release bytes.
 */
function host(options: HostOptions = {}) {
  const engine = options.engine ?? 'opencode';
  const serviceRoot = options.service ?? root();
  const versions = new Map<string, string>();
  const rows: IntegrationStatus[] = [];
  const installations: DiscoveredInstallation[] = [];
  const entry = (id: ExternalEngine, file: string, version: string): IntegrationStatus => ({
    id,
    name: id,
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
    location: file,
    disclosure: [],
  });
  for (const row of options.system ?? []) {
    const version = row.version ?? TESTED_VERSIONS[engine];
    versions.set(path.resolve(row.file), version);
    rows.push(entry(engine, row.file, version));
    installations.push({ engine, path: row.file, context: 'windows-native' });
  }
  if (options.other) {
    versions.set(path.resolve(options.other.file), TESTED_VERSIONS[options.other.engine]);
    rows.push(entry(options.other.engine, options.other.file, TESTED_VERSIONS[options.other.engine]));
    installations.push({
      engine: options.other.engine,
      path: options.other.file,
      context: 'windows-native',
    });
  }
  let managed: string | undefined;
  if (options.managed) {
    managed = place(managedBinary(serviceRoot, engine), options.managed.bytes);
    versions.set(path.resolve(managed), options.managed.version ?? TESTED_VERSIONS[engine]);
  }
  const accountRoute = `${engine}:account`;
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
    if (!known) throw new EngineError('VERSION_UNKNOWN', 'The installed version could not be verified.');
    return known;
  });
  const verifyManaged = vi.fn(async () => {
    if (options.managed && !options.managed.verifies)
      throw new EngineError(
        'INSTALL_CHECKSUM',
        'The managed executable changed. It was not launched.',
      );
  });
  const enumerate = vi.fn(async (scope?: { engine?: ExternalEngine }) =>
    installations.filter((row) => !scope?.engine || row.engine === scope.engine),
  );
  const discover = vi.fn(async (scope?: { engine?: ExternalEngine }) => {
    if (options.failDiscoverWhile?.()) throw new EngineError('SCAN_FAILED', 'The roster failed.');
    return rows.filter((row) => !scope?.engine || row.id === scope.engine);
  });
  const service = new EngineService(serviceRoot, {
    discover,
    enumerate,
    version,
    verifyManaged,
    buildId: () => 'test-build',
    adapter: (id) => ({ id, contract: routeContractFor(id), inspect, generate }),
  });
  service.dispatch = fixtureTextDispatch(path.join(serviceRoot, 'runs'), {
    [`${engine}AccountRoute`]: accountRoute,
  }).dispatch;
  return {
    service,
    serviceRoot,
    engine,
    accountRoute,
    managed,
    version,
    verifyManaged,
    enumerate,
    discover,
    inspect,
    generate,
    /** This computer now offers one different executable for this route. */
    replaceSystem(file: string, replacedVersion = TESTED_VERSIONS[engine]) {
      versions.set(path.resolve(file), replacedVersion);
      rows.splice(0, rows.length, entry(engine, file, replacedVersion));
      installations.splice(0, installations.length, {
        engine,
        path: file,
        context: 'windows-native',
      });
    },
  };
}
const connection = (service: EngineService, engine: ExternalEngine) =>
  service.status().find((row) => row.engine === engine)!;
const ask = (engine: ExternalEngine, accountRoute: string, requestId = 'r') => ({
  projectId: 'p',
  threadId: 't',
  requestId,
  model: 'm',
  accountRoute,
  prompt: 'x',
  instructions: '',
  documents: [],
});
const binding = (overrides: Partial<EngineBinding> = {}): EngineBinding => ({
  id: 'managed:opencode:C:\\d\\opencode.exe',
  engine: 'opencode',
  source: 'managed',
  path: 'C:\\d\\opencode.exe',
  version: '1.18.4',
  sha256: 'a'.repeat(64),
  boundAt: '2026-09-20T00:00:00.000Z',
  origin: 'explicit',
  ...overrides,
});

describe('the binding a person chose, remembered across restarts', () => {
  it('writes one non-secret file and reloads the binding, revision and model', () => {
    const service = root();
    const store = new BindingStore(service);
    store.save('opencode', { binding: binding(), revision: 3, key: 'k1', model: 'gpt' });
    const file = path.join(service, 'bindings.json');
    const text = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      version: 1,
      engines: { opencode: { revision: 3, key: 'k1', model: 'gpt' } },
    });
    // Nothing secret may reach this file: it holds identifiers and digests only.
    expect(text).not.toMatch(/token|secret|password|apiKey/i);

    const reopened = new BindingStore(service);
    expect(reopened.get('opencode')).toMatchObject({
      revision: 3,
      key: 'k1',
      model: 'gpt',
      binding: { id: binding().id, origin: 'explicit', sha256: 'a'.repeat(64) },
    });
    expect(reopened.get('claude-code')).toBeUndefined();
  });

  it('replaces the file atomically and never leaves a partial one or a phantom binding', () => {
    const service = root();
    const store = new BindingStore(service);
    store.save('opencode', { binding: binding(), revision: 1, key: 'k1', model: null });
    const file = path.join(service, 'bindings.json');
    const before = fs.readFileSync(file, 'utf8');
    const next = {
      binding: binding({ version: '2.0.0' }),
      revision: 2,
      key: 'k2',
      model: 'x',
    };
    // On Windows a reader holding the destination denies the rename. The
    // previous record must stay complete, and Diomedes must not remember a
    // choice that no restart would find.
    const handle = fs.openSync(file, 'r');
    try {
      expect(() => store.save('opencode', next)).toThrow(/EPERM|EACCES|EBUSY/);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(store.get('opencode')?.revision).toBe(1);
    } finally {
      fs.closeSync(handle);
    }
    store.save('opencode', next);
    expect(fs.readdirSync(service)).toEqual(['bindings.json']);
    expect(new BindingStore(service).get('opencode')).toMatchObject({
      revision: 2,
      model: 'x',
      binding: { version: '2.0.0' },
    });
  });

  it('starts empty rather than throwing when the file is unreadable or damaged', () => {
    const service = root();
    fs.writeFileSync(path.join(service, 'bindings.json'), '{ not json');
    const store = new BindingStore(service);
    expect(store.get('opencode')).toBeUndefined();
    // A damaged file is replaced by the next real save, never read as authority.
    store.save('opencode', { binding: binding(), revision: 1, key: 'k1', model: null });
    expect(new BindingStore(service).get('opencode')?.revision).toBe(1);
  });

  it('refuses a stored row that does not name the engine it is filed under', () => {
    const service = root();
    fs.writeFileSync(
      path.join(service, 'bindings.json'),
      JSON.stringify({
        version: 1,
        engines: {
          opencode: { binding: { ...binding(), engine: 'claude-code' }, revision: 9, key: 'k', model: null },
        },
      }),
    );
    expect(new BindingStore(service).get('opencode')).toBeUndefined();
  });

  it('retries a denied replacement inside a bounded wait, and gives up inside it', () => {
    // The record is written synchronously, because `/api/ai/select` saves
    // settings in the same breath and a choice must survive the crash one line
    // later. A reader holding the destination denies the rename on Windows, so
    // the write retries — and the wait it spends doing so is the whole time the
    // process is blocked, so it is bounded and small.
    const service = root();
    const store = new BindingStore(service);
    store.save('opencode', { binding: binding(), revision: 1, key: 'k1', model: null });
    const handle = fs.openSync(path.join(service, 'bindings.json'), 'r');
    const started = Date.now();
    try {
      expect(() =>
        store.save('opencode', { binding: binding(), revision: 2, key: 'k2', model: null }),
      ).toThrow(/EPERM|EACCES|EBUSY/);
    } finally {
      fs.closeSync(handle);
    }
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(RENAME_RETRY_BUDGET_MS / 2);
    expect(waited).toBeLessThan(RENAME_RETRY_BUDGET_MS * 10);
    expect(RENAME_RETRY_BUDGET_MS).toBeLessThanOrEqual(250);
  });

  it('binds and reloads an installation whose canonical path is a Windows long path', async () => {
    // A candidate id is `<source>:<engine>:<canonical path>`, and Windows
    // resolves paths of up to 32,767 units. Neither the service nor this
    // record may assume a shorter one; the only length rule lives at the
    // route that accepts the id.
    const serviceRoot = root();
    const long = `C:\\${'deep\\'.repeat(2000)}opencode.exe`;
    expect(long.length).toBeGreaterThan(10_000);
    const h = host({ system: [{ file: long }], service: serviceRoot });
    const service = new EngineService(serviceRoot, {
      discover: async () => [],
      enumerate: async () => [{ engine: 'opencode', path: long, context: 'windows-native' }],
      version: async () => TESTED_VERSIONS.opencode,
      identify: async (file) => ({
        path: file,
        size: 10,
        mtimeMs: 1,
        sha256: 'e'.repeat(64),
      }),
      verifyManaged: async () => {
        throw new Error('no private copy in this test');
      },
      buildId: () => 'test-build',
      adapter: (id) => ({
        id,
        contract: routeContractFor(id),
        inspect: h.inspect,
        generate: h.generate,
      }),
    });
    await service.discover(true);
    const id = connection(service, 'opencode').recommendedCandidateId!;
    expect(id.length).toBeGreaterThan(10_000);
    const bound = await service.bind('opencode', id);
    expect(bound.binding?.id).toBe(id);
    expect(new BindingStore(serviceRoot).get('opencode')?.binding.id).toBe(id);
  });

  it('separates a route nobody chose from one whose row it cannot read', () => {
    const service = root();
    fs.writeFileSync(
      path.join(service, 'bindings.json'),
      JSON.stringify({
        version: 1,
        engines: {
          // A source a newer build knows and this one does not.
          opencode: {
            binding: { ...binding(), source: 'imported' },
            revision: 9,
            key: 'k',
            model: null,
          },
          cursor: { binding: binding({ engine: 'cursor' }), revision: 'later', key: 'k', model: null },
        },
      }),
    );
    const store = new BindingStore(service);
    expect(store.unreadable('opencode')).toBe(true);
    expect(store.unreadable('cursor')).toBe(true);
    // No row is silence, and silence is readable.
    expect(store.unreadable('claude-code')).toBe(false);
    expect(store.get('claude-code')).toBeUndefined();
  });

  it('keeps the record it could not read, and remembers which routes still wait', () => {
    const service = root();
    const file = path.join(service, 'bindings.json');
    const damaged = '{ "engines": { "opencode": ';
    fs.writeFileSync(file, damaged);
    const store = new BindingStore(service);
    for (const engine of ['opencode', 'claude-code'] as const)
      expect(store.unreadable(engine)).toBe(true);

    store.save('opencode', { binding: binding(), revision: 1, key: 'k1', model: null });
    const kept = fs.readdirSync(service).filter((name) => name !== 'bindings.json');
    expect(kept.length).toBe(1);
    expect(kept[0].startsWith('bindings.json.unreadable-')).toBe(true);
    expect(fs.readFileSync(path.join(service, kept[0]), 'utf8')).toBe(damaged);

    // The route that was chosen again is settled; the rest are still waiting,
    // and a restart reads that rather than inventing a fresh start for them.
    const reopened = new BindingStore(service);
    expect(reopened.unreadable('opencode')).toBe(false);
    expect(reopened.get('opencode')?.revision).toBe(1);
    expect(reopened.unreadable('claude-code')).toBe(true);
    expect(reopened.unreadable('cursor')).toBe(true);
  });

  it('sets nothing aside, and carries nothing forward, for an ordinary record', () => {
    const service = root();
    const store = new BindingStore(service);
    store.save('opencode', { binding: binding(), revision: 1, key: 'k1', model: null });
    expect(fs.readdirSync(service)).toEqual(['bindings.json']);
    expect(JSON.parse(fs.readFileSync(path.join(service, 'bindings.json'), 'utf8')).unreadable)
      .toBeUndefined();
    expect(new BindingStore(service).unreadable('claude-code')).toBe(false);
  });
});

describe('every installation is a candidate, and one failure hides nothing', () => {
  it('recommends the reviewed private copy over a wrong-version installation on PATH', async () => {
    const outside = place(path.join(root(), 'tools', 'opencode.exe'), 'the person’s own copy');
    const h = host({
      system: [{ file: outside, version: '1.20.0' }],
      managed: { bytes: 'reviewed release bytes', verifies: true },
    });
    await h.service.discover(true);
    const value = connection(h.service, 'opencode');
    expect(value.installation).toBe('found');
    expect(value.compatibility).toBe('supported');
    expect(value.location).toBe(fs.realpathSync.native(h.managed!));
    expect(value.recommendedCandidateId).toBe(`managed:opencode:${value.location}`);
    // Both installations are reported; only the reviewed one is recommended.
    expect(value.candidates?.map((row) => row.source).sort()).toEqual(['managed', 'system']);
    const theirs = value.candidates!.find((row) => row.source === 'system')!;
    expect(theirs).toMatchObject({
      version: '1.20.0',
      compatibility: 'unsupported',
      provenance: 'unverified',
      context: 'windows-native',
    });
    expect(theirs.sha256).toBe(digestOf(outside));
    // Their own installation is read and never altered.
    expect(fs.readFileSync(outside, 'utf8')).toBe('the person’s own copy');
    expect(value.binding ?? null).toBeNull();
  });

  it('never launches a private copy that failed its digest, and still reports every other engine', async () => {
    const other = place(path.join(root(), 'claude', 'claude.exe'), 'their claude');
    const h = host({
      managed: { bytes: 'tampered bytes', verifies: false },
      other: { engine: 'claude-code', file: other },
    });
    await h.service.discover(true);
    const broken = connection(h.service, 'opencode');
    expect(broken.installation).toBe('corrupt');
    expect(broken.repair).toBe('no-reviewed-candidate');
    expect(broken.candidates?.[0]).toMatchObject({ source: 'managed', integrity: 'failed' });
    expect(broken.candidates?.[0].issue).toMatch(/not launched/i);
    expect(broken.diagnostic).toMatchObject({
      stage: 'runtime-verification',
      code: 'INSTALL_CHECKSUM',
      buildId: 'test-build',
    });
    // The corrupt file was never asked for its version.
    for (const call of h.version.mock.calls)
      expect(path.resolve(call[0])).not.toBe(path.resolve(h.managed!));
    // One bad candidate hid nothing: the other engine is fully reported.
    expect(connection(h.service, 'claude-code')).toMatchObject({
      installation: 'found',
      compatibility: 'supported',
    });
  });

  it('reports a failed private copy beside a wrong-version installation as a repairable pair', async () => {
    const theirs = place(path.join(root(), 'tools', 'opencode.exe'), 'their own copy');
    const h = host({
      system: [{ file: theirs, version: '1.20.0' }],
      managed: { bytes: 'tampered bytes', verifies: false },
    });
    await h.service.discover(true);
    const value = connection(h.service, 'opencode');
    // Two installations exist, so neither is "the only one": the contract's
    // `corrupt` does not apply and the route is found-but-unsupported. The
    // failed private copy is still the thing that needs repairing, and it is
    // named on the candidate rather than only in the installation state.
    expect(value.installation).toBe('found');
    expect(value.compatibility).toBe('unsupported');
    expect(value.repair).toBe('no-reviewed-candidate');
    expect(value.candidates?.find((row) => row.source === 'managed')).toMatchObject({
      integrity: 'failed',
    });
    expect(value.candidates?.find((row) => row.source === 'system')).toMatchObject({
      integrity: 'verified',
      compatibility: 'unsupported',
    });
  });

  it('keeps a candidate whose file cannot be read out of the usable set without hiding it', async () => {
    const h = host({ system: [{ file: path.join(root(), 'gone', 'opencode.exe') }] });
    await h.service.discover(true);
    const value = connection(h.service, 'opencode');
    expect(value.candidates?.[0]).toMatchObject({ integrity: 'unknown', present: false });
    expect(value.candidates?.[0].sha256).toBe('');
    expect(value.recommendedCandidateId ?? null).toBeNull();
  });

  it('resolves a path with spaces and non-ASCII characters through its real name', async () => {
    const odd = place(
      path.join(root(), 'Program Fïles', 'ünï côde', 'opencode.exe'),
      'reviewed bytes',
    );
    const h = host({ system: [{ file: odd }] });
    await h.service.discover(true);
    const value = connection(h.service, 'opencode');
    expect(value.installation).toBe('found');
    expect(value.compatibility).toBe('supported');
    expect(value.location).toBe(fs.realpathSync.native(odd));
    expect(value.candidates?.[0].sha256).toBe(digestOf(odd));
  });

  it('records one digest per file and does not re-hash an unchanged one', async () => {
    const file = place(path.join(root(), 'tools', 'opencode.exe'), 'first bytes!');
    const stamp = new Date(1_700_000_000_000);
    fs.utimesSync(file, stamp, stamp);
    const h = host({ system: [{ file }] });
    await h.service.discover(true);
    const first = connection(h.service, 'opencode').candidates![0].sha256;
    expect(first).toBe(digestOf(file));
    // Same path, same size, same modification time: nothing is read again.
    fs.writeFileSync(file, 'other bytes!');
    fs.utimesSync(file, stamp, stamp);
    await h.service.discover(true);
    // Same path, same size, same modification time: the recorded digest is reused.
    expect(connection(h.service, 'opencode').candidates![0].sha256).toBe(first);
  });

  it('shares one run between two simultaneous scans of the same scope', async () => {
    const file = place(path.join(root(), 'tools', 'opencode.exe'), 'reviewed bytes');
    const h = host({ system: [{ file }] });
    const [a, b] = await Promise.all([h.service.discover(true), h.service.discover(true)]);
    expect(h.enumerate).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('refreshes only the engine a request needs', async () => {
    const file = place(path.join(root(), 'tools', 'opencode.exe'), 'reviewed bytes');
    const h = host({ system: [{ file }] });
    await h.service.discover(true, { engine: 'opencode' });
    expect(h.enumerate).toHaveBeenCalledWith({ engine: 'opencode' });
    expect(connection(h.service, 'claude-code').installation).toBe('not-checked');
  });
});

describe('an explicit binding, and what breaks it', () => {
  async function bound() {
    const first = place(path.join(root(), 'chosen', 'opencode.exe'), 'the copy they picked');
    const h = host({ system: [{ file: first }] });
    await h.service.discover(true);
    const id = connection(h.service, 'opencode').recommendedCandidateId!;
    await h.service.bind('opencode', id);
    return { ...h, first, id };
  }

  it('binds only an installation this computer currently offers', async () => {
    const h = await bound();
    expect(connection(h.service, 'opencode').binding).toMatchObject({
      id: h.id,
      origin: 'explicit',
      source: 'system',
    });
    await expect(h.service.bind('opencode', 'system:opencode:C:\\anything.exe')).rejects.toMatchObject(
      { code: 'CANDIDATE_UNKNOWN' },
    );
  });

  it('keeps the chosen installation when a better-ranked candidate appears', async () => {
    const h = await bound();
    // A reviewed private copy now exists. It outranks their choice, and does
    // not replace it: discovery recommends, only a person binds.
    place(managedBinary(h.serviceRoot, 'opencode'), 'reviewed release bytes');
    await h.service.discover(true);
    const value = connection(h.service, 'opencode');
    expect(value.binding?.id).toBe(h.id);
    expect(value.location).toBe(fs.realpathSync.native(h.first));
    expect(value.repair ?? null).toBeNull();
    expect(value.candidates?.length).toBe(2);
  });

  it('breaks the connection when the bound copy is removed, changed or downgraded', async () => {
    for (const [reason, damage] of [
      ['selected-missing', (file: string) => fs.rmSync(file)],
      ['selected-changed', (file: string) => fs.writeFileSync(file, 'different bytes now')],
    ] as const) {
      const h = await bound();
      damage(h.first);
      await h.service.discover(true);
      const value = connection(h.service, 'opencode');
      expect(value.repair).toBe(reason);
      expect(value.binding?.id).toBe(h.id);
      await expect(h.service.check('opencode')).rejects.toMatchObject({
        code: 'BINDING_CHANGED',
        stage: 'runtime-verification',
      });
    }
  });

  it('breaks the connection when the bound copy keeps its bytes but changes version', async () => {
    const h = await bound();
    h.version.mockResolvedValue('1.0.0');
    await h.service.discover(true);
    const value = connection(h.service, 'opencode');
    expect(value.repair).toBe('selected-changed');
    await expect(h.service.check('opencode')).rejects.toMatchObject({ code: 'BINDING_CHANGED' });
  });

  it('refuses a request rather than running a different executable in its place', async () => {
    const h = await bound();
    await h.service.check('opencode');
    h.service.selection('opencode', 'm');
    // Their chosen copy disappears and another appears on PATH. Diomedes stops.
    const shadow = place(path.join(root(), 'shadow', 'opencode.exe'), 'a different executable');
    fs.rmSync(h.first);
    h.enumerate.mockResolvedValue([
      { engine: 'opencode', path: shadow, context: 'windows-native' },
    ]);
    h.version.mockResolvedValue(TESTED_VERSIONS.opencode);
    await expect(
      h.service.generate('opencode', ask('opencode', h.accountRoute)),
    ).rejects.toMatchObject({ code: 'BINDING_CHANGED' });
    expect(h.generate).not.toHaveBeenCalled();
    expect(connection(h.service, 'opencode').repair).toBe('selected-missing');
  });

  it('adopts the recommended installation once for a person who selected before bindings existed', async () => {
    const file = place(path.join(root(), 'tools', 'opencode.exe'), 'reviewed bytes');
    const h = host({ system: [{ file }] });
    await h.service.discover(true);
    await h.service.check('opencode');
    expect(connection(h.service, 'opencode').binding ?? null).toBeNull();
    await expect(
      h.service.generate('opencode', ask('opencode', h.accountRoute)),
    ).resolves.toMatchObject({ text: 'Answer' });
    expect(connection(h.service, 'opencode').binding).toMatchObject({ origin: 'adopted' });
  });
});

describe('what a person is asked to do next, and what the record says', () => {
  it('offers a choice, not another download, when a binding breaks beside a usable copy', async () => {
    const theirs = place(path.join(root(), 'chosen', 'opencode.exe'), 'the copy they picked');
    const h = host({
      system: [{ file: theirs }],
      managed: { bytes: 'reviewed release bytes', verifies: true },
    });
    await h.service.discover(true);
    const mine = connection(h.service, 'opencode').candidates!.find(
      (row) => row.source === 'system',
    )!;
    await h.service.bind('opencode', mine.id);
    fs.writeFileSync(theirs, 'changed underneath them');
    await h.service.discover(true);
    expect(connection(h.service, 'opencode').repair).toBe('selected-changed');
    expect(h.service.nextAction('opencode', { enabled: true, installSupported: true })).toBe(
      'choose-installation',
    );
  });

  it('records the stage a check failed at, with identifiers and nothing else', async () => {
    const file = place(path.join(root(), 'tools', 'opencode.exe'), 'reviewed bytes');
    const h = host({ system: [{ file }] });
    await h.service.discover(true);
    h.inspect.mockRejectedValue(
      new EngineError('AUTH_REQUIRED', 'Sign in to this service.', false, 'provider-auth'),
    );
    await expect(h.service.check('opencode')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const diagnostic = connection(h.service, 'opencode').diagnostic!;
    expect(diagnostic).toMatchObject({
      engine: 'opencode',
      stage: 'provider-auth',
      code: 'AUTH_REQUIRED',
      buildId: 'test-build',
      candidateSource: 'system',
      installedVersion: TESTED_VERSIONS.opencode,
    });
    expect(diagnostic.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    // Identifiers only: no prompt, no output, no environment, no secret.
    expect(JSON.stringify(diagnostic)).not.toMatch(/Sign in to this service|reviewed bytes/);
    // A clean check clears it rather than leaving a stale failure on screen.
    h.inspect.mockResolvedValue({
      authentication: 'signed-in',
      accountRoute: h.accountRoute,
      models: [{ slug: 'm', name: 'M', description: '', efforts: [], defaultEffort: null }],
      detail: 'Checked',
    });
    await h.service.check('opencode');
    expect(connection(h.service, 'opencode').diagnostic).toBeNull();
  });

  it('keeps a check failure through a rescan that finds the very same executable', async () => {
    // `Cleared by the next success at that stage` is what the record promises.
    // Checking this computer again is not a success at provider-auth, and it
    // used to erase the failure anyway, so the support bundle and the screen
    // both forgot why the route stopped working.
    const file = place(path.join(root(), 'tools', 'opencode.exe'), 'reviewed bytes');
    const h = host({ system: [{ file }] });
    await h.service.discover(true);
    h.inspect.mockRejectedValue(
      new EngineError('AUTH_REQUIRED', 'Sign in to this service.', false, 'provider-auth'),
    );
    await expect(h.service.check('opencode')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const before = connection(h.service, 'opencode').diagnostic!;

    await h.service.discover(true);
    expect(connection(h.service, 'opencode').diagnostic).toMatchObject({
      stage: 'provider-auth',
      code: 'AUTH_REQUIRED',
      correlationId: before.correlationId,
    });
  });

  it('drops a check failure when the executable itself changes', async () => {
    const first = place(path.join(root(), 'tools', 'opencode.exe'), 'reviewed bytes');
    const h = host({ system: [{ file: first }] });
    await h.service.discover(true);
    h.inspect.mockRejectedValue(
      new EngineError('AUTH_REQUIRED', 'Sign in to this service.', false, 'provider-auth'),
    );
    await expect(h.service.check('opencode')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(connection(h.service, 'opencode').diagnostic).toBeTruthy();

    // A different installation is a different subject; what the old one said
    // about its account is not a fact about this one.
    const second = place(path.join(root(), 'other', 'opencode.exe'), 'another reviewed copy');
    h.replaceSystem(second);
    await h.service.discover(true);
    expect(connection(h.service, 'opencode').diagnostic).toBeNull();
  });

  it('keeps a scan failure recorded while the scan that recorded it finishes', async () => {
    // The roster and the enumeration each failed for this route. `apply()` runs
    // immediately afterwards inside the same scan and used to overwrite what
    // they recorded, so the one pass that knew what went wrong forgot it.
    for (const failing of ['discover', 'enumerate'] as const) {
      const service = new EngineService(root(), {
        discover: async () => {
          if (failing === 'discover') throw new EngineError('SCAN_FAILED', 'The roster failed.');
          return [];
        },
        enumerate: async () => {
          if (failing === 'enumerate') throw new EngineError('SCAN_FAILED', 'The list failed.');
          return [];
        },
        version: async () => TESTED_VERSIONS.opencode,
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
      expect(connection(service, 'opencode').diagnostic).toMatchObject({
        stage: 'discovery',
        code: 'SCAN_FAILED',
      });
    }
  });

  it('names the installation a scan failure is about when one is already chosen', async () => {
    // The repair record says a diagnostic carries the candidate source. A scan
    // that failed still knows which installation this route is bound to, and
    // "which copy was it" is the first question a support bundle is read for.
    let failing = false;
    const file = place(path.join(root(), 'tools', 'opencode.exe'), 'reviewed bytes');
    const h = host({ system: [{ file }], failDiscoverWhile: () => failing });
    await h.service.discover(true);
    const chosen = connection(h.service, 'opencode').recommendedCandidateId!;
    await h.service.bind('opencode', chosen);
    failing = true;
    await h.service.discover(true);
    expect(connection(h.service, 'opencode').diagnostic).toMatchObject({
      stage: 'discovery',
      code: 'SCAN_FAILED',
      candidateSource: 'system',
    });
  });

  it('drops a scan failure on the next scan that reaches the end', async () => {
    let failing = true;
    const file = place(path.join(root(), 'tools', 'opencode.exe'), 'reviewed bytes');
    const h = host({ system: [{ file }], failDiscoverWhile: () => failing });
    await h.service.discover(true);
    expect(connection(h.service, 'opencode').diagnostic).toMatchObject({ stage: 'discovery' });
    failing = false;
    await h.service.discover(true);
    expect(connection(h.service, 'opencode').diagnostic).toBeNull();
  });
});

describe('the revision a receipt is written against', () => {
  it('does not move on a repeated scan or re-check that finds the same facts', async () => {
    const file = place(path.join(root(), 'tools', 'opencode.exe'), 'reviewed bytes');
    const h = host({ system: [{ file }] });
    await h.service.discover(true);
    await h.service.bind('opencode', connection(h.service, 'opencode').recommendedCandidateId!);
    await h.service.check('opencode');
    const first = connection(h.service, 'opencode').revision!;
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      await h.service.discover(true);
      await h.service.check('opencode');
    }
    expect(connection(h.service, 'opencode').revision).toBe(first);
    // Choosing a different model is a semantic change, and moves it once.
    h.service.selection('opencode', 'm');
    expect(connection(h.service, 'opencode').revision).toBe(first + 1);
    h.service.selection('opencode', 'm');
    expect(connection(h.service, 'opencode').revision).toBe(first + 1);
  });

  it('remembers the binding and revision across a restart, and re-observes readiness', async () => {
    const file = place(path.join(root(), 'tools', 'opencode.exe'), 'reviewed bytes');
    const first = host({ system: [{ file }] });
    await first.service.discover(true);
    await first.service.bind('opencode', connection(first.service, 'opencode').recommendedCandidateId!);
    await first.service.check('opencode');
    first.service.selection('opencode', 'm');
    const before = connection(first.service, 'opencode');
    first.service.close();

    const second = host({ system: [{ file }], service: first.serviceRoot });
    const restarted = connection(second.service, 'opencode');
    expect(restarted.binding?.id).toBe(before.binding?.id);
    expect(restarted.revision).toBe(before.revision);
    // Readiness is not remembered: sign-in and models are observed again.
    expect(restarted.installation).toBe('not-checked');
    expect(restarted.authentication).toBe('unknown');
    expect(restarted.models).toEqual([]);
    expect(restarted.checkedAt).toBeNull();
    await second.service.discover(true);
    await second.service.check('opencode');
    expect(connection(second.service, 'opencode').revision).toBe(before.revision);
  });
});

describe('one expiry rule for every surface', () => {
  it('agrees at exactly five minutes and on a timestamp from the future', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const file = place(path.join(root(), 'tools', 'opencode.exe'), 'reviewed bytes');
      const h = host({ system: [{ file }] });
      vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
      await h.service.discover(true);
      await h.service.check('opencode');
      expect(h.service.integration('opencode', true).available).toBe(true);
      expect(h.service.selection('opencode', 'm').model).toBe('m');

      vi.setSystemTime(new Date('2026-09-20T12:04:59.999Z'));
      expect(h.service.integration('opencode', true).available).toBe(true);
      expect(h.service.selection('opencode', 'm').model).toBe('m');

      // Exactly the TTL is stale on both surfaces, not fresh on one of them.
      vi.setSystemTime(new Date('2026-09-20T12:05:00.000Z'));
      expect(h.service.integration('opencode', true).available).toBe(false);
      expect(() => h.service.selection('opencode', 'm')).toThrow(/Recheck/);

      // A clock that moved backwards makes the observation unknown, never fresh.
      vi.setSystemTime(new Date('2026-09-20T11:00:00.000Z'));
      expect(h.service.integration('opencode', true).available).toBe(false);
      expect(() => h.service.selection('opencode', 'm')).toThrow(/Recheck/);
    } finally {
      vi.useRealTimers();
    }
  });
});
