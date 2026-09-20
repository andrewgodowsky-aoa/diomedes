import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { EngineError } from '../server/engines/process.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { fixtureTextDispatch, textResponse } from './h01-fixture.js';
import type { DiscoveredInstallation } from '../server/discovery.js';
import type { AdapterInspection, TextRequest, TextResponse } from '../server/engines/contract.js';
import type { ExternalEngine, IntegrationStatus } from '../shared/types.js';

/**
 * Testing a connection is the only place Diomedes spends a person's allowance
 * on its own evidence, so every case here is about what that costs them: it
 * happens once, only when they ask, only for what they selected, and it either
 * leaves a receipt that describes exactly that selection or leaves nothing.
 */
const ENGINE: ExternalEngine = 'opencode';
const VERSION = TESTED_VERSIONS[ENGINE];
const ROUTE = 'opencode:go';
const ANSWER = 'ok-2f7a-reply';
const MODELS = [
  { slug: 'small', name: 'Small', description: '', efforts: [], defaultEffort: null },
  { slug: 'large', name: 'Large', description: '', efforts: [], defaultEffort: null },
];
const READY = { enabled: true, installSupported: true };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function temporary(prefix: string) {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(made);
  return made;
}
/** A real file this computer can resolve, stat and hash. */
function place(file: string, bytes: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}
const signedIn = (): AdapterInspection => ({
  authentication: 'signed-in',
  accountRoute: ROUTE,
  models: MODELS.map((row) => ({ ...row })),
  detail: 'Checked',
});

interface HostOptions {
  /** Reuse a data folder, to reopen the service the way a restart does. */
  serviceRoot?: string;
  /** Reuse the installations, so a reopened service still finds its binding. */
  toolsRoot?: string;
  /** Whether Settings has this engine route switched on. */
  enabled?: boolean;
  /** A second installation this computer offers, for a rebind mid-test. */
  second?: boolean;
}

/**
 * One EngineService over real files, with the same durable runtime seam the
 * host wires: a RunService over a FileRunStore, the text-route egress
 * authorizer over a settings record, and the TextRouteRuntime. Only the
 * provider transport is scripted.
 */
function host(options: HostOptions = {}) {
  const serviceRoot = options.serviceRoot ?? temporary('diomedes-verify-');
  const toolsRoot = options.toolsRoot ?? temporary('diomedes-tools-');
  const files = [place(path.join(toolsRoot, 'one', 'opencode.exe'), 'first')];
  if (options.second) files.push(place(path.join(toolsRoot, 'two', 'opencode.exe'), 'second'));
  let inspection = signedIn();
  const inspect = vi.fn(async () => structuredClone(inspection));
  const generate = vi.fn<(input: TextRequest) => Promise<TextResponse>>(async (input) =>
    textResponse(input, ANSWER, VERSION),
  );
  const rows: IntegrationStatus[] = files.map((file) => ({
    id: ENGINE,
    name: ENGINE,
    kind: 'online',
    found: true,
    available: false,
    enabled: false,
    status: 'Installed',
    detail: 'Found',
    capabilities: [],
    signIn: 'unknown',
    adapter: 'planned',
    installedVersion: VERSION,
    location: file,
    disclosure: [],
  }));
  const installations: DiscoveredInstallation[] = files.map((file) => ({
    engine: ENGINE,
    path: file,
    context: 'windows-native',
  }));
  const service = new EngineService(serviceRoot, {
    discover: async (scope) => rows.filter((row) => !scope?.engine || row.id === scope.engine),
    enumerate: async (scope) =>
      installations.filter((row) => !scope?.engine || row.engine === scope.engine),
    version: async () => VERSION,
    buildId: () => 'test-build',
    adapter: (id) => ({ id, contract: routeContractFor(id), inspect, generate }),
  });
  service.dispatch = fixtureTextDispatch(path.join(serviceRoot, 'runs'), {
    [ENGINE]: options.enabled ?? true,
    [`${ENGINE}AccountRoute`]: ROUTE,
  }).dispatch;
  return {
    service,
    serviceRoot,
    toolsRoot,
    files,
    inspect,
    generate,
    say: (next: AdapterInspection) => {
      inspection = next;
    },
  };
}
type Host = ReturnType<typeof host>;

const connection = (service: EngineService) =>
  service.status().find((row) => row.engine === ENGINE)!;
const receiptFile = (h: Host) => path.join(h.serviceRoot, 'receipts.json');
/** The ordinary setup a person finishes before a test is offered at all. */
async function settle(h: Host, model = 'small') {
  await h.service.discover(true);
  await h.service.check(ENGINE);
  h.service.selection(ENGINE, model);
  expect(h.service.nextAction(ENGINE, READY)).toBe('test-connection');
}
const ask = (requestId: string) => ({
  projectId: 'p',
  threadId: 't',
  requestId,
  model: 'small',
  accountRoute: ROUTE,
  prompt: 'x',
  instructions: '',
  documents: [],
});

describe('one consented test of the connection a person selected', () => {
  it('sends nothing without consent and calls that no failure of the connection', async () => {
    const h = host();
    await settle(h);
    await expect(
      h.service.testConnection(ENGINE, { consent: false, model: 'small' }),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(h.generate).not.toHaveBeenCalled();
    // A person who declined was not failed by their service: nothing is filed
    // against the connection, and the next action is still the offer.
    expect(connection(h.service).diagnostic).toBeNull();
    expect(h.service.nextAction(ENGINE, READY)).toBe('test-connection');
  });

  it('answers through the admitted path and records a receipt for that revision', async () => {
    const h = host();
    await settle(h);
    const before = connection(h.service);
    const receipt = await h.service.testConnection(ENGINE, { consent: true, model: 'small' });
    expect(receipt).toMatchObject({
      engine: ENGINE,
      revision: before.revision,
      candidateId: before.binding!.id,
      version: VERSION,
      accountRoute: ROUTE,
      model: 'small',
      buildId: 'test-build',
    });
    // The receipt names the durable run the dispatch actually happened under.
    expect(receipt.runId).toContain('diomedes-host-tests-test-');
    expect(h.generate).toHaveBeenCalledTimes(1);
    // What was sent: one fixed synthetic instruction, under the reserved host
    // identity, with no document, no instruction text and nothing of theirs.
    const sent = h.generate.mock.calls[0][0];
    expect(sent).toMatchObject({
      projectId: 'diomedes-host-tests',
      threadId: `connection-test:${ENGINE}`,
      prompt: 'Reply with the single word: ok',
      instructions: '',
      documents: [],
      model: 'small',
      accountRoute: ROUTE,
    });
    expect(connection(h.service).verification).toMatchObject({ runId: receipt.runId });
    expect(h.service.nextAction(ENGINE, READY)).toBe('ready');
  });

  it('writes identifiers only: no prompt, no answer, no secret', async () => {
    const h = host();
    await settle(h);
    await h.service.testConnection(ENGINE, { consent: true, model: 'small' });
    const text = fs.readFileSync(receiptFile(h), 'utf8');
    expect(text).not.toContain(ANSWER);
    expect(text).not.toContain('Reply with');
    expect(text).not.toMatch(/token|secret|password|apiKey|prompt|text/i);
    expect(JSON.parse(text)).toMatchObject({
      version: 1,
      engines: { [ENGINE]: { model: 'small', accountRoute: ROUTE } },
    });
  });

  it('reloads the receipt after a restart while live readiness starts unknown again', async () => {
    const first = host();
    await settle(first);
    const receipt = await first.service.testConnection(ENGINE, { consent: true, model: 'small' });

    const restarted = host({ serviceRoot: first.serviceRoot, toolsRoot: first.toolsRoot });
    const reopened = connection(restarted.service);
    // History survived; nothing about the live route is claimed yet.
    expect(reopened.verification).toMatchObject({ runId: receipt.runId, revision: 1 });
    expect(reopened).toMatchObject({
      installation: 'not-checked',
      authentication: 'unknown',
      checkedAt: null,
      models: [],
    });
    expect(restarted.service.nextAction(ENGINE, READY)).toBe('check-connection');

    await restarted.service.discover(true);
    await restarted.service.check(ENGINE);
    expect(connection(restarted.service).verification).toMatchObject({ revision: 1 });
    expect(restarted.service.nextAction(ENGINE, READY)).toBe('ready');
    // A different model is a different selection, and the old result never
    // described it: the verification goes and the offer to test comes back.
    restarted.service.selection(ENGINE, 'large');
    expect(connection(restarted.service).verification).toBeNull();
    expect(restarted.service.nextAction(ENGINE, READY)).toBe('test-connection');
    // The receipt itself is kept; it simply no longer describes this selection.
    expect(fs.readFileSync(receiptFile(restarted), 'utf8')).toContain(receipt.runId);
  });

  it('cannot verify a model chosen while the answer was in flight', async () => {
    const h = host();
    await settle(h);
    h.generate.mockImplementationOnce(async (input) => {
      h.service.selection(ENGINE, 'large');
      return textResponse(input, ANSWER, VERSION);
    });
    const receipt = await h.service.testConnection(ENGINE, { consent: true, model: 'small' });
    expect(receipt).toMatchObject({ revision: 1, model: 'small' });
    expect(connection(h.service).revision).toBe(2);
    expect(connection(h.service).verification).toBeNull();
    expect(h.service.nextAction(ENGINE, READY)).toBe('test-connection');
  });

  it('cannot verify an installation bound while the answer was in flight', async () => {
    const h = host({ second: true });
    await settle(h);
    const bound = connection(h.service).binding!.id;
    const other = connection(h.service).candidates!.find((row) => row.id !== bound)!;
    h.generate.mockImplementationOnce(async (input) => {
      await h.service.bind(ENGINE, other.id);
      return textResponse(input, ANSWER, VERSION);
    });
    const receipt = await h.service.testConnection(ENGINE, { consent: true, model: 'small' });
    expect(receipt.candidateId).toBe(bound);
    expect(connection(h.service).binding!.id).toBe(other.id);
    expect(connection(h.service).verification).toBeNull();
  });

  it('files the failure before the caller sees the rejection', async () => {
    const h = host();
    await settle(h);
    h.say({ authentication: 'signed-out', accountRoute: null, models: [], detail: 'Signed out' });
    await h.service.check(ENGINE);
    // The screen re-reads status the moment the request rejects, so the record
    // is taken from the first continuation after the rejection.
    const snapshot = await h.service
      .testConnection(ENGINE, { consent: true, model: 'small' })
      .then(
        () => null,
        () => connection(h.service),
      );
    expect(snapshot!.diagnostic).toMatchObject({
      stage: 'provider-auth',
      code: 'AUTH_REQUIRED',
      engine: ENGINE,
      buildId: 'test-build',
    });
    expect(h.generate).not.toHaveBeenCalled();
    expect(snapshot!.verification).toBeNull();
  });

  it('keeps an uncertain dispatch uncertain: no receipt, no second call', async () => {
    const h = host();
    await settle(h);
    // The provider answered under a request id this run never asked about.
    // Nothing commits, and the dispatch's real effect stays unknown.
    h.generate.mockImplementation(async (input) => ({
      ...textResponse(input, ANSWER, VERSION),
      requestId: 'wrong',
    }));
    await expect(
      h.service.testConnection(ENGINE, { consent: true, model: 'small' }),
    ).rejects.toMatchObject({ code: 'DISPATCH_UNCERTAIN', ambiguous: true });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(receiptFile(h))).toBe(false);
    expect(connection(h.service)).toMatchObject({
      verification: null,
      diagnostic: { stage: 'dispatch', code: 'DISPATCH_UNCERTAIN' },
    });
  });

  it('names the stream when the route had started answering', async () => {
    const h = host();
    await settle(h);
    h.generate.mockImplementation(async (input) => {
      input.onDelta?.('partial');
      throw new EngineError('PROVIDER_ERROR', 'The service stopped answering.', true);
    });
    await expect(
      h.service.testConnection(ENGINE, { consent: true, model: 'small' }),
    ).rejects.toMatchObject({ ambiguous: true });
    expect(connection(h.service).diagnostic).toMatchObject({ stage: 'stream' });
    expect(fs.existsSync(receiptFile(h))).toBe(false);
  });

  it('drops a cancelled test without claiming a clean failure or a receipt', async () => {
    const h = host();
    await settle(h);
    const controller = new AbortController();
    let release: (() => void) | undefined;
    h.generate.mockImplementation(async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return textResponse(input, ANSWER, VERSION);
    });
    const pending = h.service.testConnection(ENGINE, {
      consent: true,
      model: 'small',
      signal: controller.signal,
    });
    await expect.poll(() => h.generate.mock.calls.length).toBe(1);
    controller.abort();
    release!();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', ambiguous: true });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(receiptFile(h))).toBe(false);
    expect(connection(h.service)).toMatchObject({
      verification: null,
      diagnostic: { stage: 'dispatch', code: 'CANCELLED' },
    });
  });

  it('refuses a second test of the same route rather than queueing one', async () => {
    const h = host();
    await settle(h);
    let release: (() => void) | undefined;
    h.generate.mockImplementation(async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return textResponse(input, ANSWER, VERSION);
    });
    const pending = h.service.testConnection(ENGINE, { consent: true, model: 'small' });
    await expect.poll(() => h.generate.mock.calls.length).toBe(1);
    await expect(
      h.service.testConnection(ENGINE, { consent: true, model: 'small' }),
    ).rejects.toMatchObject({ code: 'REQUEST_ACTIVE' });
    release!();
    await expect(pending).resolves.toMatchObject({ revision: 1 });
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
});

describe('a test that never reaches the provider', () => {
  it('explains a different account route instead of sending anyway', async () => {
    const h = host();
    await settle(h);
    h.say({ ...signedIn(), routeIssue: { required: ROUTE, connected: ['opencode:zen'] } });
    await h.service.check(ENGINE);
    await expect(
      h.service.testConnection(ENGINE, { consent: true, model: 'small' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_ROUTE' });
    expect(h.generate).not.toHaveBeenCalled();
    expect(connection(h.service).diagnostic).toMatchObject({
      stage: 'model-list',
      code: 'ACCOUNT_ROUTE',
    });
  });

  it('refuses a broken binding rather than running whatever PATH offers now', async () => {
    const h = host();
    await settle(h);
    // The chosen installation changed on disk since it was selected.
    fs.writeFileSync(h.files[0], 'first-but-different');
    await expect(
      h.service.testConnection(ENGINE, { consent: true, model: 'small' }),
    ).rejects.toMatchObject({ code: 'BINDING_CHANGED' });
    expect(h.generate).not.toHaveBeenCalled();
    expect(connection(h.service).diagnostic).toMatchObject({ stage: 'runtime-verification' });
  });

  it('refuses a route Settings has switched off', async () => {
    const h = host({ enabled: false });
    await settle(h);
    await expect(
      h.service.testConnection(ENGINE, { consent: true, model: 'small' }),
    ).rejects.toMatchObject({ code: 'ROUTE_REFUSED' });
    expect(h.generate).not.toHaveBeenCalled();
    expect(connection(h.service).diagnostic).toMatchObject({ stage: 'dispatch' });
    expect(fs.existsSync(receiptFile(h))).toBe(false);
  });

  it('rejects a model this connection does not list', async () => {
    const h = host();
    await settle(h);
    await expect(
      h.service.testConnection(ENGINE, { consent: true, model: 'withdrawn' }),
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe('a receipt is history, never authority', () => {
  it('does not let a later request through once the account is signed out', async () => {
    const h = host();
    await settle(h);
    await h.service.testConnection(ENGINE, { consent: true, model: 'small' });
    expect(connection(h.service).verification).not.toBeNull();

    h.say({ authentication: 'signed-out', accountRoute: null, models: [], detail: 'Signed out' });
    await expect(h.service.generate(ENGINE, ask('r1'))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    // The admission ran in full: the provider was never asked a second time.
    expect(h.generate).toHaveBeenCalledTimes(1);
    // Losing the account route moved the selection, so the old result no
    // longer describes it — while the receipt itself is still on disk.
    expect(connection(h.service).verification).toBeNull();
    expect(fs.readFileSync(receiptFile(h), 'utf8')).toContain('"revision": 1');
  });

  it('is not a verification when Diomedes could not record it', async () => {
    const h = host();
    await settle(h);
    await h.service.testConnection(ENGINE, { consent: true, model: 'small' });
    h.service.selection(ENGINE, 'large');
    const file = receiptFile(h);
    const before = fs.readFileSync(file, 'utf8');
    // On Windows a reader holding the destination denies the replacement.
    const handle = fs.openSync(file, 'r');
    try {
      await expect(
        h.service.testConnection(ENGINE, { consent: true, model: 'large' }),
      ).rejects.toMatchObject({ code: 'RECEIPT_UNSAVED' });
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      fs.closeSync(handle);
    }
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(connection(h.service)).toMatchObject({
      verification: null,
      diagnostic: { stage: 'cleanup', code: 'RECEIPT_UNSAVED' },
    });
    // And a restart finds no verification for the current selection either.
    const restarted = host({ serviceRoot: h.serviceRoot, toolsRoot: h.toolsRoot });
    expect(connection(restarted.service).verification).toBeNull();
  });
});
