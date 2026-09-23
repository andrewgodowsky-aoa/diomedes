/**
 * H01 repair — the runtime seam proof the reviewer asked for.
 *
 * Every test drives the real application path: a real `createApp`, a real
 * `EngineService` admission (discovery → version → selection → contract), the
 * real `createHarnessHost` RunService over a real FileRunStore, and the real
 * Store 'engine-text' event the SSE route forwards verbatim. Only the provider
 * transport is scripted: the adapter is a function behind the real contract.
 * Nothing mocks ownership, persistence, fencing or dispatch.
 *
 * The failing assertions here are the bypass itself: today the provider is
 * called with no run record at all.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import type { TextEngineAdapter, TextRequest } from '../server/engines/contract.js';
import type { IntegrationStatus } from '../shared/types.js';
import type { HarnessRun } from '../shared/harness.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { isTerminalEventType, type TransientPreview } from '../shared/adapter-contract.js';
import { streamChecks } from '../server/harness/conformance.js';
import type { Store } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import { changeCloudSharing } from '../server/cloud-sharing.js';

const ENGINE = 'claude-code' as const;
const VERSION = TESTED_VERSIONS[ENGINE];
const ACCOUNT = 'claude-code:claude.ai';
const MODEL = {
  slug: 'sonnet',
  name: 'Sonnet',
  description: '',
  efforts: [],
  defaultEffort: null,
};
const SIGNED_IN = {
  authentication: 'signed-in' as const,
  accountRoute: ACCOUNT,
  models: [MODEL],
  detail: 'Checked',
};
const installed: IntegrationStatus = {
  id: ENGINE,
  name: 'Claude Code',
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
  location: 'fixture.exe',
  disclosure: [],
};

let root: string;
let projectId = '';
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let url = '';
let engines: EngineService;
let generate: ReturnType<typeof vi.fn<TextEngineAdapter['generate']>>;
let inspect: ReturnType<typeof vi.fn>;
/** What the SSE route would forward — recorded at the real store boundary. */
let frames: Record<string, unknown>[];
/** What the caller-facing preview channel carried — the stamped contract frames. */
let previews: TransientPreview[];

const store = (): Store => app!.locals.store;
const host = (): HarnessHost => app!.locals.harness;
const runFile = (runId: string) =>
  path.join(root, 'data', 'projects', projectId, 'harness', 'runs', `${runId}.json`);

async function open(
  generateImpl?: TextEngineAdapter['generate'],
  inspectImpl?: () => Promise<typeof SIGNED_IN>,
  appOptions: Partial<Parameters<typeof createApp>[0]> & { harnessTextLeaseMs?: number } = {},
) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'h01-seam-'));
  frames = [];
  previews = [];
  generate = vi.fn(
    generateImpl ??
      (async (input) => ({
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
        model: input.model,
        version: VERSION,
        text: 'Answer',
      })),
  );
  inspect = vi.fn(inspectImpl ?? (async () => SIGNED_IN));
  engines = new EngineService(path.join(root, 'data', 'engines'), {
    discover: async () => [installed],
    version: async () => VERSION,
    adapter: () => ({
      id: ENGINE,
      contract: routeContractFor(ENGINE),
      inspect,
      generate,
    }),
  });
  const options = {
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    ...appOptions,
  } as Parameters<typeof createApp>[0];
  app = await createApp(options);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store().on('engine-text', (frame: unknown) => frames.push(frame as Record<string, unknown>));
  const project = await store().locked(() => store().createProject('H01 seam'));
  projectId = project.id;
  // Default-deny cloud sharing: grant the claude-code route with no source
  // documents so synthetic dispatch fixtures (documents []) keep their prior behavior.
  await store().locked(async () => {
    changeCloudSharing(store().state(projectId), {
      expectedVersion: 0,
      routes: ['claude-code'],
      documents: [],
      shareConversationHistory: false,
      shareReviewPackets: false,
    });
    await store().persist(store().state(projectId));
  });
  store().settings.services = {
    'claude-code': true,
    'claude-codeModel': 'sonnet',
    'claude-codeAccountRoute': ACCOUNT,
  };
  await store().saveSettings(store().settings);
}

async function close() {
  if (!server) return;
  // Taken off the shared bindings before the first await, so a teardown that
  // outlives its hook can neither close nor clear the next test's server.
  const closingApp = app, closingServer = server, closingRoot = root;
  server = undefined;
  try {
    await closingApp!.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await fs.rm(closingRoot, { recursive: true, force: true });
}
afterEach(close);

const request = (overrides: Partial<TextRequest> = {}): TextRequest => ({
  projectId,
  threadId: 'T-thread',
  requestId: 'req-1',
  model: 'sonnet',
  accountRoute: ACCOUNT,
  prompt: 'Say hi',
  instructions: '',
  documents: [],
  onPreview: (frame) => previews.push(frame),
  ...overrides,
});
const runId = () => `${projectId}-req-1`;

const ask = (body: Record<string, unknown>) =>
  fetch(`${url}/api/projects/${projectId}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: JSON.stringify(body),
  });

describe('H01 runtime seam — dispatch, identity and replay under the host RunService', () => {
  test('run, step, attempt, owner and fence persist before the provider receives the request', async () => {
    let atProvider: HarnessRun | undefined;
    await open(async (input) => {
      input.onDelta?.('partial-');
      // The provider holds the request now; the durable record must already exist.
      atProvider = await host().runs.get(`${input.projectId}-${input.requestId}`);
      return {
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
        model: input.model,
        version: VERSION,
        text: 'Answer',
      };
    });
    const res = await ask({ text: 'Say hi', route: ENGINE, mode: 'ask', consent: true });
    expect(res.status).toBe(200);
    expect(atProvider).toBeDefined();
    const run = atProvider!;
    expect(run.capabilityId).toBe('engine-text-turn');
    expect(run.state).toBe('running');
    expect(run.owner).toBeTruthy();
    expect(run.fence).toBeGreaterThanOrEqual(1);
    const admission = run.steps.find((s) => s.intent.stepId === 'text:admission');
    const dispatch = run.steps.find((s) => s.intent.stepId === 'text:dispatch');
    expect(admission?.state).toBe('succeeded');
    expect(dispatch?.state).toBe('running');
    expect(dispatch?.attempt).toBe(1);
    expect(dispatch?.leaseFence).toBe(run.fence);
    expect(dispatch?.intent.destination).toBe('external');
    // The durable events read exactly one lifecycle.
    const saved = await host().runs.get(run.id);
    expect(saved.state).toBe('completed');
    expect(saved.result).toMatchObject({ response: { text: 'Answer' } });
    expect(saved.events.map((e) => e.type)).toEqual([
      'run.created',
      'run.claimed',
      'step.started',
      'step.succeeded',
      'step.started',
      'step.succeeded',
      'run.completed',
    ]);
    expect(saved.events.filter((e) => isTerminalEventType(e.type))).toHaveLength(1);
    // The app-facing stream carries the authoritative identity, not just text.
    const started = frames.find((f) => f.kind === 'started');
    const deltas = frames.filter((f) => f.kind === 'delta');
    const ended = frames.find((f) => f.kind === 'ended');
    expect(started).toMatchObject({ runId: run.id });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      runId: run.id,
      stepId: 'text:dispatch',
      attempt: 1,
      fence: run.fence,
      text: 'partial-',
    });
    expect(ended).toMatchObject({ runId: run.id });
    // Per-token text is preview-only: it never reaches the durable record.
    const raw = await fs.readFile(runFile(run.id), 'utf8');
    expect(raw).not.toContain('partial-');
    expect(raw).toContain('Answer');
    // And the produced stream passes the shared conformance checks.
    expect(streamChecks(saved).filter((c) => c.outcome === 'failed')).toEqual([]);
  });

  test('replaying an admitted request returns the durable result without a second dispatch', async () => {
    await open();
    const first = await engines.generate(ENGINE, request());
    expect(first.runId).toBe(runId());
    const second = await engines.generate(ENGINE, request());
    expect(second).toMatchObject({ text: 'Answer', runId: runId() });
    expect(generate).toHaveBeenCalledTimes(1);
    // Reconnect reads the durable stream: nothing regenerates.
    const events = await host().runs.events(runId());
    expect(events.at(-1)?.type).toBe('run.completed');
    const run = await host().get(projectId, runId());
    expect(run.state).toBe('completed');
  });

  test('cancellation between capability listing and dispatch never reaches the provider', async () => {
    const controller = new AbortController();
    // The capability listing (inspect inside check) aborts the caller signal —
    // the admitted listing completes but dispatch must never run.
    await open(undefined, async () => {
      controller.abort();
      return SIGNED_IN;
    });
    await expect(
      engines.generate(ENGINE, request({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(generate).not.toHaveBeenCalled();
    const run = await host().runs.get(runId());
    expect(run.state).toBe('cancelled');
    // The dispatch step was never even recorded as started.
    expect(run.steps.map((s) => s.intent.stepId)).toEqual(['text:admission']);
    expect(run.events.at(-1)?.type).toBe('run.cancelled');
  });

  test('a preview emitted after the request settled is dropped before the app stream', async () => {
    let delta: ((text: string) => void) | undefined;
    await open(async (input) => {
      delta = input.onDelta;
      delta?.('live-');
      return {
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
        model: input.model,
        version: VERSION,
        text: 'done',
      };
    });
    await engines.generate(ENGINE, request());
    delta?.('stale-');
    expect(previews.map((f) => f.text)).toEqual(['live-']);
    // The surviving frame is stamped with the attempt's authoritative identity.
    expect(previews[0]).toMatchObject({
      runId: runId(),
      stepId: 'text:dispatch',
      attempt: 1,
    });
  });

  test('an over-budget preview poisons the dispatch; the record stays uncertain, not finished', async () => {
    await open(async (input) => {
      input.onDelta?.('€'.repeat(30_000));
      return {
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
        model: input.model,
        version: VERSION,
        text: 'done',
      };
    });
    // The contract failure is real, but the provider may still have answered —
    // the honest code is uncertain, and the durable record stays parked.
    await expect(engines.generate(ENGINE, request())).rejects.toMatchObject({
      code: 'DISPATCH_UNCERTAIN',
    });
    const run = await host().runs.get(runId());
    expect(run.state).toBe('reconcile_required');
    expect(run.steps.find((s) => s.intent.stepId === 'text:dispatch')?.state).toBe(
      'reconcile_required',
    );
    expect(run.result).toBeNull();
    expect(run.events.filter((e) => isTerminalEventType(e.type))).toHaveLength(0);
  });

  test('a live dispatch fences off takeover: no resend, and the stale attempt cannot commit', async () => {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inFlight = new Promise<void>((r) => (reached = r));
    await open(
      async (input) => {
        reached();
        await gate;
        return {
          projectId: input.projectId,
          threadId: input.threadId,
          requestId: input.requestId,
          model: input.model,
          version: VERSION,
          text: 'Late',
        };
      },
      undefined,
      { harnessTextLeaseMs: 1500 },
    );
    const pending = engines
      .generate(ENGINE, request())
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    await inFlight; // the provider holds the request; the dispatch step is running
    // The first owner's lease lapses mid-dispatch; a different owner takes the run.
    await new Promise((r) => setTimeout(r, 1700));
    await host().runs.claim(runId(), 'other-owner', 900);
    release();
    const first = await pending;
    // The late provider answer could not commit under the stale fence.
    expect(first).toHaveProperty('error');
    expect((first as { error: unknown }).error).toMatchObject({
      code: 'DISPATCH_UNCERTAIN',
    });
    // That owner's lease lapses too, so the service's runtime can reclaim it.
    await new Promise((r) => setTimeout(r, 1000));
    await expect(engines.generate(ENGINE, request())).rejects.toMatchObject({
      code: 'DISPATCH_UNCERTAIN',
    });
    const parked = await host().runs.get(runId());
    expect(parked.state).toBe('reconcile_required');
    expect(
      parked.steps.find((s) => s.intent.stepId === 'text:dispatch')?.state,
    ).toBe('reconcile_required');
    expect(parked.events.some((e) => e.type === 'step.reconcile_required')).toBe(true);
    // One provider call ever; the late answer was never committed as a result.
    expect(generate).toHaveBeenCalledTimes(1);
    const final = await host().runs.get(runId());
    expect(final.result).toBeNull();
    expect(final.events.filter((e) => isTerminalEventType(e.type))).toHaveLength(0);
    expect(streamChecks(final).filter((c) => c.outcome === 'failed')).toEqual([]);
  });
});
