import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BindingStore } from '../server/engines/binding-store.js';
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
  const discover = vi.fn(async (scope?: { engine?: ExternalEngine }) =>
    rows.filter((row) => !scope?.engine || row.id === scope.engine),
  );
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
