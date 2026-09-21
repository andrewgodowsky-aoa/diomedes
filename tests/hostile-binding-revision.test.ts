/**
 * Hostile verification of the revision a receipt is written against (audit F05,
 * acceptance row 7): what happens when the binding or the account route moves
 * while a consented connection test is still in flight, and whether merely
 * reading status can move it.
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

/** One route with two usable installations: the person's own, and the private copy. */
function host() {
  const engine: ExternalEngine = 'opencode';
  const serviceRoot = root();
  const theirs = place(path.join(root(), 'chosen', 'opencode.exe'), 'the copy they picked');
  const managed = place(managedBinary(serviceRoot, engine), 'reviewed release bytes');
  const installations: DiscoveredInstallation[] = [
    { engine, path: theirs, context: 'windows-native' },
  ];
  const rows: IntegrationStatus[] = [
    {
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
      installedVersion: TESTED_VERSIONS[engine],
      location: theirs,
      disclosure: [],
    },
  ];
  let accountRoute = `${engine}:account`;
  const inspect = vi.fn(async () => ({
    authentication: 'signed-in' as const,
    accountRoute,
    models: [{ slug: 'm', name: 'M', description: '', efforts: [], defaultEffort: null }],
    detail: 'Checked',
  }));
  const generate = vi.fn(async (input: Parameters<typeof textResponse>[0]) =>
    textResponse(input, 'ok', TESTED_VERSIONS[engine]),
  );
  const service = new EngineService(serviceRoot, {
    // This fixture compares a system installation with the Windows managed copy.
    platform: 'win32',
    discover: async () => rows,
    enumerate: async () => installations,
    version: async (file: string) => {
      if ([theirs, managed].some((known) => path.resolve(known) === path.resolve(file)))
        return TESTED_VERSIONS[engine];
      throw new EngineError('VERSION_UNKNOWN', 'The installed version could not be verified.');
    },
    verifyManaged: async () => {},
    buildId: () => 'test-build',
    adapter: (id) => ({ id, contract: routeContractFor(id), inspect, generate }),
  });
  const dispatchSettings: Record<string, unknown> = { [`${engine}AccountRoute`]: accountRoute };
  service.dispatch = fixtureTextDispatch(path.join(serviceRoot, 'runs'), dispatchSettings).dispatch;
  return {
    service,
    theirs,
    managed,
    generate,
    inspect,
    setAccountRoute(value: string) {
      accountRoute = value;
    },
    get accountRoute() {
      return accountRoute;
    },
  };
}
const connection = (service: EngineService) =>
  service.status().find((row) => row.engine === 'opencode')!;

/** Bind the person's own copy, check it, and settle on a model. */
async function ready(h: ReturnType<typeof host>) {
  await h.service.discover(true);
  const theirs = connection(h.service).candidates!.find((row) => row.source === 'system')!;
  await h.service.bind('opencode', theirs.id);
  await h.service.check('opencode');
  h.service.selection('opencode', 'm');
  return theirs;
}

/** A generate that parks until the test releases it. */
function parked(h: ReturnType<typeof host>) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.generate.mockImplementation(async (input: Parameters<typeof textResponse>[0]) => {
    started();
    await held;
    return textResponse(input, 'ok', TESTED_VERSIONS.opencode);
  });
  return { release, inFlight };
}

describe('a connection test whose selection moves while it is in flight', () => {
  it('cannot verify the installation bound after it was sent', async () => {
    const h = host();
    await ready(h);
    const before = connection(h.service).revision!;
    const { release, inFlight } = parked(h);
    const running = h.service.testConnection('opencode', { consent: true, model: 'm' });
    await inFlight;

    // The person picks Diomedes's private copy while the answer is on the wire.
    const mine = connection(h.service).candidates!.find((row) => row.source === 'managed')!;
    await h.service.bind('opencode', mine.id);
    const after = connection(h.service).revision!;
    expect(after).toBeGreaterThan(before);

    release();
    const receipt = await running;
    // The receipt names what was actually sent, and nothing else.
    expect(receipt.revision).toBe(before);
    expect(receipt.candidateId).not.toBe(mine.id);
    // It does not stand as verification of the binding now selected.
    expect(connection(h.service).verification).toBeNull();
    expect(h.service.nextAction('opencode', { enabled: true, installSupported: true })).not.toBe(
      'ready',
    );
  });

  it('cannot verify an account route observed after it was sent', async () => {
    const h = host();
    await ready(h);
    const before = connection(h.service).revision!;
    const { release, inFlight } = parked(h);
    const running = h.service.testConnection('opencode', { consent: true, model: 'm' });
    await inFlight;

    // The native tool is now signed in to a different account.
    h.setAccountRoute('opencode:another');
    await h.service.check('opencode');
    expect(connection(h.service).revision).toBeGreaterThan(before);

    release();
    const receipt = await running;
    expect(receipt.revision).toBe(before);
    expect(receipt.accountRoute).toBe('opencode:account');
    expect(connection(h.service).verification).toBeNull();
  });

  it('stands only while the very selection it names is still current', async () => {
    const h = host();
    await ready(h);
    const receipt = await h.service.testConnection('opencode', { consent: true, model: 'm' });
    expect(connection(h.service).verification).toMatchObject({ revision: receipt.revision });
    // Reading status, deriving the next action and re-checking the same facts
    // are observations; none of them moves the revision a receipt is tied to.
    for (let i = 0; i < 3; i++) {
      h.service.status();
      h.service.nextAction('opencode', { enabled: true, installSupported: true });
      h.service.integration('opencode', true);
      await h.service.discover(true);
      await h.service.check('opencode');
    }
    expect(connection(h.service).revision).toBe(receipt.revision);
    expect(connection(h.service).verification).toMatchObject({ runId: receipt.runId });
    expect(h.service.nextAction('opencode', { enabled: true, installSupported: true })).toBe(
      'ready',
    );
  });

  it('refuses a second test of the same route rather than queueing one', async () => {
    const h = host();
    await ready(h);
    const { release, inFlight } = parked(h);
    const running = h.service.testConnection('opencode', { consent: true, model: 'm' });
    await inFlight;
    await expect(
      h.service.testConnection('opencode', { consent: true, model: 'm' }),
    ).rejects.toMatchObject({ code: 'REQUEST_ACTIVE' });
    release();
    await running;
    // A refusal to start is not a failure of the connection.
    expect(connection(h.service).diagnostic).toBeNull();
  });
});
